import { useEffect, useRef, useState } from 'react'
import type { ChatEvent, ChatMessage, EditorContext, FsReadResponse, ProviderConfig, RagSearchResponse, RagStatusResponse } from '@qbee/shared'
import { Agent } from './Agent.js'
import { Markdown } from './Markdown.js'
import { Settings, loadEmbeddingProvider, pushSecretsToWorker } from './Settings.js'

type Msg = ChatMessage & { id: string }

// Embedding provider for RAG. Independent from the chat provider because Anthropic
// and Gemini don't expose embeddings through our adapter. Default targets Ollama on
// localhost — override the model string inline if you're on LM Studio (which uses
// e.g. text-embedding-nomic-embed-text-v1.5) or another OpenAI-compatible server.
const DEFAULT_EMBEDDING_PROVIDER: ProviderConfig = {
  id: 'openai-compatible',
  model: 'nomic-embed-text',
  baseUrl: 'http://127.0.0.1:11434/v1',
}

type ProviderPreset = {
  label: string
  config: ProviderConfig
}

// Defaults are picked to "just work" with common local + cloud setups.
// The user can edit model strings inline; the apiKeyRef is the env var name the worker reads.
const DEFAULT_PRESETS: ProviderPreset[] = [
  { label: 'Ollama (local)', config: { id: 'openai-compatible', model: 'qwen2.5-coder:7b', baseUrl: 'http://127.0.0.1:11434/v1' } },
  { label: 'Anthropic Claude', config: { id: 'anthropic', model: 'claude-sonnet-4-5', apiKeyRef: 'ANTHROPIC_API_KEY' } },
  { label: 'Google Gemini', config: { id: 'gemini', model: 'gemini-2.0-flash', apiKeyRef: 'GEMINI_API_KEY' } },
]

export function App() {
  const [auth, setAuth] = useState('dev')
  const [tab, setTab] = useState<'chat' | 'agent' | 'settings'>('chat')
  // Restore preset + model from localStorage so launches don't reset to Ollama default.
  const [presetIdx, setPresetIdx] = useState<number>(() => {
    const stored = Number(localStorage.getItem('qbee.presetIdx.v1') ?? '0')
    return Number.isFinite(stored) && stored >= 0 && stored < DEFAULT_PRESETS.length ? stored : 0
  })
  const [model, setModel] = useState<string>(() => {
    return localStorage.getItem('qbee.model.v1') ?? DEFAULT_PRESETS[0]!.config.model
  })
  const [workspaceRoot, setWorkspaceRoot] = useState('')
  const [embeddingProvider, setEmbeddingProvider] = useState<ProviderConfig>(() => loadEmbeddingProvider() ?? DEFAULT_EMBEDDING_PROVIDER)
  const [ragStatus, setRagStatus] = useState<RagStatusResponse | null>(null)
  const [indexProgress, setIndexProgress] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [busy, setBusy] = useState(false)
  // Editor context (active file, selection, open tabs) pushed by the editor host
  // via webview postMessage. Forwarded to /api/chat and /api/agent/run so the
  // model knows what the user is looking at without explicit @file: mentions.
  const [editorContext, setEditorContext] = useState<EditorContext | undefined>(undefined)
  const abortRef = useRef<AbortController | null>(null)
  const listRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.slice(1))
    const a = params.get('auth') ?? 'dev'
    setAuth(a)
    setWorkspaceRoot(params.get('workspaceRoot') ?? '')
    // On load, push any stored API keys to the worker so /api/chat can find them.
    // Worker is in-memory; if it restarted we need to re-push. Idempotent.
    pushSecretsToWorker(a)
  }, [])

  // Listen for editor state pushed from the editor host (active file, selection,
  // open tabs). When running standalone (Vite dev outside the editor), no host is
  // posting messages and editorContext stays undefined — chat/agent still work,
  // they just don't have IDE awareness.
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const data = e.data
      if (!data || typeof data !== 'object' || data.type !== 'editor_state_update') return
      setEditorContext(data.payload as EditorContext)
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [])

  // Switching the preset resets the model to that preset's default unless the
  // user has explicitly typed a model. We persist whatever model the user
  // ends up with so subsequent launches restore it.
  useEffect(() => {
    localStorage.setItem('qbee.presetIdx.v1', String(presetIdx))
  }, [presetIdx])

  useEffect(() => {
    localStorage.setItem('qbee.model.v1', model)
  }, [model])

  // First time we see a new preset (after restoring from storage), keep the
  // restored model for that preset. If the preset is changed later by the
  // user, default the model to that preset's recommended one.
  const prevPresetRef = useRef(presetIdx)
  useEffect(() => {
    if (prevPresetRef.current !== presetIdx) {
      setModel(DEFAULT_PRESETS[presetIdx]!.config.model)
      prevPresetRef.current = presetIdx
    }
  }, [presetIdx])

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })
  }, [msgs])

  const authHeader = () => ({ Authorization: `Basic ${btoa(`qbee:${auth}`)}` })

  // Refresh RAG status whenever the workspace or auth becomes available.
  useEffect(() => {
    const refresh = async () => {
      try {
        const res = await fetch(`/api/rag/status?workspaceRoot=${encodeURIComponent(workspaceRoot)}`, { headers: authHeader() })
        if (res.ok) setRagStatus(await res.json())
      } catch {
        /* worker may not be up yet */
      }
    }
    refresh()
  }, [auth, workspaceRoot])

  const startIndex = async () => {
    setIndexProgress('starting…')
    try {
      const res = await fetch('/api/rag/index', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify({ workspaceRoot, embeddingProvider }),
      })
      if (!res.ok || !res.body) {
        setIndexProgress(`error: HTTP ${res.status}`)
        return
      }
      let total = 0
      let chunks = 0
      for await (const evt of parseSSE<{ type: string;[k: string]: unknown }>(res.body)) {
        if (evt.type === 'discovered') {
          total = evt.count as number
          setIndexProgress(`discovered ${total} files`)
        } else if (evt.type === 'file') {
          setIndexProgress(`${(evt.index as number) + 1}/${total}: ${evt.path}`)
        } else if (evt.type === 'embedded') {
          chunks += evt.chunkCount as number
          setIndexProgress(`embedded ${chunks} chunks`)
        } else if (evt.type === 'done') {
          setIndexProgress(`✓ ${evt.files} files / ${evt.chunks} chunks (${evt.tookMs}ms)`)
        } else if (evt.type === 'error') {
          setIndexProgress(`error: ${evt.message}`)
        }
      }
      // Refresh status after indexing.
      const statusRes = await fetch(`/api/rag/status?workspaceRoot=${encodeURIComponent(workspaceRoot)}`, { headers: authHeader() })
      if (statusRes.ok) setRagStatus(await statusRes.json())
    } catch (err) {
      setIndexProgress(`error: ${(err as Error).message}`)
    }
  }

  // Detect a leading "@codebase <query>" mention. Strip it, return the cleaned
  // user text plus the search query (defaults to the whole message).
  const parseCodebaseMention = (text: string): { cleaned: string; query: string | null } => {
    const m = text.match(/^@codebase\b\s*(.*)/is)
    if (!m) return { cleaned: text, query: null }
    const rest = (m[1] ?? '').trim()
    return { cleaned: rest || text, query: rest || text }
  }

  // Detect "@file:path/to/foo.ts" mentions anywhere in the input. Returns the
  // list of paths plus the original text unchanged (we leave the @file: tokens
  // in so the assistant sees what the user pointed at).
  const parseFileMentions = (text: string): string[] => {
    const matches = Array.from(text.matchAll(/@file:([^\s,;]+)/g))
    return matches.map((m) => m[1]!).filter(Boolean)
  }

  const fetchRagContext = async (query: string): Promise<string | null> => {
    try {
      const res = await fetch('/api/rag/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify({ workspaceRoot, embeddingProvider, query, topK: 8 }),
      })
      if (!res.ok) return null
      const json = (await res.json()) as RagSearchResponse
      if (!json.chunks?.length) return null
      const blocks = json.chunks.map((c) => `--- ${c.filePath}:${c.startLine}-${c.endLine}\n${c.content}`).join('\n\n')
      return `Relevant code from the workspace (retrieved via @codebase):\n\n${blocks}`
    } catch {
      return null
    }
  }

  const fetchFiles = async (paths: string[]): Promise<string | null> => {
    if (paths.length === 0 || !workspaceRoot) return null
    const blocks: string[] = []
    for (const p of paths) {
      try {
        const res = await fetch('/api/fs/read', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeader() },
          body: JSON.stringify({ workspaceRoot, path: p }),
        })
        if (!res.ok) {
          blocks.push(`--- ${p}\n[error: HTTP ${res.status}]`)
          continue
        }
        const json = (await res.json()) as FsReadResponse
        const note = json.truncated ? ' (truncated)' : ''
        blocks.push(`--- ${json.path}${note}\n${json.content}`)
      } catch (err) {
        blocks.push(`--- ${p}\n[error: ${(err as Error).message}]`)
      }
    }
    return `Files mentioned via @file:\n\n${blocks.join('\n\n')}`
  }

  const send = async () => {
    const text = input.trim()
    if (!text || busy) return
    setInput('')

    // Parse mentions BEFORE sending. @codebase fetches RAG hits; @file:<path>
    // fetches one or more file contents. Both are prepended as system messages.
    const { cleaned, query } = parseCodebaseMention(text)
    const filePaths = parseFileMentions(text)
    const systemMessages: ChatMessage[] = []
    if (query) {
      const ctx = await fetchRagContext(query)
      if (ctx) systemMessages.push({ role: 'system', content: ctx })
    }
    if (filePaths.length > 0) {
      const filesCtx = await fetchFiles(filePaths)
      if (filesCtx) systemMessages.push({ role: 'system', content: filesCtx })
    }

    const userMsg: Msg = { id: cryptoId(), role: 'user', content: cleaned }
    const assistantMsg: Msg = { id: cryptoId(), role: 'assistant', content: '' }
    const nextMsgs = [...msgs, userMsg, assistantMsg]
    setMsgs(nextMsgs)
    setBusy(true)

    const ac = new AbortController()
    abortRef.current = ac

    const provider: ProviderConfig = { ...DEFAULT_PRESETS[presetIdx]!.config, model }
    const baseMessages = nextMsgs.slice(0, -1).map(({ role, content }) => ({ role, content }))
    const body: { provider: ProviderConfig; messages: ChatMessage[]; editorContext?: EditorContext } = {
      provider,
      messages: systemMessages.length > 0 ? [...systemMessages, ...baseMessages] : baseMessages,
    }
    if (editorContext && (editorContext.activeFile || editorContext.selection || (editorContext.openFiles && editorContext.openFiles.length > 0))) {
      body.editorContext = editorContext
    }

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify(body),
        signal: ac.signal,
      })
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)

      for await (const evt of parseSSE<ChatEvent>(res.body)) {
        if (evt.type === 'text') {
          setMsgs((m) => updateLast(m, (last) => ({ ...last, content: last.content + evt.value })))
        } else if (evt.type === 'error') {
          setMsgs((m) => updateLast(m, (last) => ({ ...last, content: (last.content || '') + `\n\n_error: ${evt.message}_` })))
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setMsgs((m) => updateLast(m, (last) => ({ ...last, content: (last.content || '') + `\n\n_error: ${(err as Error).message}_` })))
      }
    } finally {
      setBusy(false)
      abortRef.current = null
    }
  }

  const cancel = () => abortRef.current?.abort()

  const currentProvider: ProviderConfig = { ...DEFAULT_PRESETS[presetIdx]!.config, model }

  return (
    <div style={styles.root}>
      <header style={styles.header}>
        <span style={styles.brand}>QBee</span>
        <button style={tabStyle(tab === 'chat')} onClick={() => setTab('chat')}>chat</button>
        <button style={tabStyle(tab === 'agent')} onClick={() => setTab('agent')}>agent</button>
        <button style={tabStyle(tab === 'settings')} onClick={() => setTab('settings')}>settings</button>
        <select style={styles.select} value={presetIdx} onChange={(e) => setPresetIdx(Number(e.target.value))} disabled={busy}>
          {DEFAULT_PRESETS.map((p, i) => (
            <option key={i} value={i}>
              {p.label}
            </option>
          ))}
        </select>
        <input style={styles.modelInput} value={model} onChange={(e) => setModel(e.target.value)} disabled={busy} />
        <span style={styles.ragBadge} title={ragStatus ? `${ragStatus.filesIndexed} files / ${ragStatus.chunks} chunks` : 'not indexed yet'}>
          rag: {ragStatus ? `${ragStatus.chunks}` : '—'}
        </span>
        <button style={styles.indexBtn} onClick={startIndex} disabled={busy} title={`Embed via ${embeddingProvider.model} at ${embeddingProvider.baseUrl}`}>
          {indexProgress ? '⟳' : 'Index'}
        </button>
      </header>
      {indexProgress && <div style={styles.indexLine}>{indexProgress}</div>}
      {tab === 'settings' ? (
        <Settings auth={auth} embeddingProvider={embeddingProvider} setEmbeddingProvider={setEmbeddingProvider} onClose={() => setTab('chat')} />
      ) : tab === 'agent' ? (
        <Agent auth={auth} provider={currentProvider} workspaceRoot={workspaceRoot} {...(editorContext ? { editorContext } : {})} />
      ) : (
      <>
      <main ref={listRef as React.RefObject<HTMLElement>} style={styles.list}>
        {msgs.length === 0 && (
          <div style={styles.hint}>
            Pick a provider, type a message. API keys are read from the worker's env (
            <code>ANTHROPIC_API_KEY</code>, <code>GEMINI_API_KEY</code>) — set them before launching the editor.
          </div>
        )}
        {msgs.map((m) => (
          <div key={m.id} style={{ ...styles.msg, ...(m.role === 'user' ? styles.user : styles.assistant) }}>
            <div style={styles.role}>{m.role}</div>
            <div style={styles.content}>
              {m.content ? (
                m.role === 'assistant' ? <Markdown text={m.content} /> : m.content
              ) : (
                m.role === 'assistant' && busy ? '…' : ''
              )}
            </div>
          </div>
        ))}
      </main>
      <ContextChip ctx={editorContext} />
      <form
        style={styles.form}
        onSubmit={(e) => {
          e.preventDefault()
          send()
        }}
      >
        <textarea
          style={styles.textarea}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Message…  (Enter to send, Shift+Enter for newline)"
          disabled={busy}
          rows={2}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
          autoFocus
        />
        {busy ? (
          <button type="button" style={styles.button} onClick={cancel}>
            Stop
          </button>
        ) : (
          <button type="submit" style={styles.button} disabled={!input.trim()}>
            Send
          </button>
        )}
      </form>
      </>
      )}
    </div>
  )
}

function ContextChip({ ctx }: { ctx: EditorContext | undefined }) {
  if (!ctx || (!ctx.activeFile && !ctx.selection)) return null
  const file = ctx.activeFile ?? '(no file)'
  const sel = ctx.selection
  const label = sel
    ? `${file} · L${sel.startLine + 1}–${sel.endLine + 1} selected`
    : ctx.cursorLine !== undefined
      ? `${file} · L${ctx.cursorLine + 1}`
      : file
  return (
    <div style={contextChipStyles.root} title={sel ? sel.text.slice(0, 400) : file}>
      <span style={contextChipStyles.icon}>📄</span>
      <span style={contextChipStyles.label}>{label}</span>
      <span style={contextChipStyles.hint}>auto-context</span>
    </div>
  )
}

const contextChipStyles: Record<string, React.CSSProperties> = {
  root: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '4px 10px',
    margin: '0 8px 4px',
    background: '#262d3a',
    border: '1px solid #3a4a6a',
    borderRadius: 4,
    fontSize: 11,
    color: '#bcd',
    fontFamily: 'monospace',
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    textOverflow: 'ellipsis',
  },
  icon: { flexShrink: 0 },
  label: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' },
  hint: { fontSize: 9, color: '#7a90b0', textTransform: 'uppercase', letterSpacing: 0.5, flexShrink: 0 },
}

function tabStyle(active: boolean): React.CSSProperties {
  return {
    background: active ? '#3a4a6a' : 'transparent',
    color: '#ddd',
    border: '1px solid #444',
    borderRadius: 4,
    padding: '3px 8px',
    fontSize: 11,
    cursor: 'pointer',
  }
}

function updateLast(msgs: Msg[], fn: (m: Msg) => Msg): Msg[] {
  const out = msgs.slice()
  const last = out[out.length - 1]
  if (last) out[out.length - 1] = fn(last)
  return out
}

function cryptoId(): string {
  return crypto.randomUUID?.() ?? String(Math.random())
}

// Generic SSE parser — yields each typed `data: ...` payload as parsed JSON.
async function* parseSSE<T>(body: ReadableStream<Uint8Array>): AsyncIterable<T> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let idx
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      const line = frame.split('\n').find((l) => l.startsWith('data: '))
      if (!line) continue
      try {
        yield JSON.parse(line.slice(6)) as T
      } catch {
        continue
      }
    }
  }
}

const styles: Record<string, React.CSSProperties> = {
  root: { fontFamily: 'system-ui, sans-serif', height: '100vh', display: 'flex', flexDirection: 'column', background: '#1e1e1e', color: '#ddd' },
  header: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderBottom: '1px solid #333', fontSize: 12 },
  brand: { fontWeight: 600, opacity: 0.9 },
  select: { background: '#2a2a2a', color: '#ddd', border: '1px solid #444', borderRadius: 4, padding: '4px 6px', fontSize: 12 },
  modelInput: { flex: 1, background: '#2a2a2a', color: '#ddd', border: '1px solid #444', borderRadius: 4, padding: '4px 6px', fontSize: 12, fontFamily: 'monospace' },
  list: { flex: 1, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 },
  hint: { opacity: 0.5, fontSize: 13, lineHeight: 1.5 },
  msg: { padding: '8px 10px', borderRadius: 6, fontSize: 13, lineHeight: 1.5 },
  user: { background: '#2a3a5a', alignSelf: 'flex-end', maxWidth: '85%' },
  assistant: { background: '#2a2a2a', alignSelf: 'flex-start', maxWidth: '85%' },
  role: { fontSize: 10, opacity: 0.5, marginBottom: 2, textTransform: 'uppercase' },
  content: { whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  form: { display: 'flex', gap: 6, padding: 8, borderTop: '1px solid #333' },
  textarea: { flex: 1, background: '#2a2a2a', border: '1px solid #444', color: '#ddd', padding: '6px 8px', borderRadius: 4, fontSize: 13, fontFamily: 'inherit', resize: 'none' },
  button: { background: '#3a6cd8', border: 'none', color: 'white', padding: '6px 12px', borderRadius: 4, cursor: 'pointer', fontSize: 13, alignSelf: 'flex-end' },
  ragBadge: { background: '#2a4a3a', color: '#9eccaa', padding: '2px 6px', borderRadius: 3, fontSize: 11, fontFamily: 'monospace' },
  indexBtn: { background: '#2a2a2a', border: '1px solid #444', color: '#ddd', padding: '3px 8px', borderRadius: 4, fontSize: 11, cursor: 'pointer' },
  indexLine: { padding: '4px 12px', fontSize: 11, fontFamily: 'monospace', background: '#1a1a1a', color: '#9eccaa', borderBottom: '1px solid #333' },
}
