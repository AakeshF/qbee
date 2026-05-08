import { useEffect, useRef, useState } from 'react'
import type { ChatEvent, ChatMessage, EditorContext, FsReadResponse, ProviderConfig, RagProbeResponse, RagSearchResponse, RagStatusResponse } from '@qbee/shared'
import { Agent } from './Agent.js'
import { Markdown } from './Markdown.js'
import { Settings, loadEmbeddingProvider, pushSecretsToWorker, CONFIG_CHANGE_EVENT } from './Settings.js'
import { DEFAULT_PRESETS } from './presets.js'

type Msg = ChatMessage & { id: string }

const PROGRESS_STALL_MS = 30_000

type IndexState =
  | { stage: 'idle' }
  | { stage: 'probing' }
  | { stage: 'indexing'; phase: string; current?: number; total?: number; chunksSoFar?: number; lastEventAt: number }
  | { stage: 'stalled'; phase: string; current?: number; total?: number; chunksSoFar?: number; idleSinceMs: number }
  | { stage: 'error'; message: string; hint?: string }
  | { stage: 'done'; files: number; chunks: number; tookMs: number }

// Embedding provider for RAG. Independent from the chat provider because Anthropic
// and Gemini don't expose embeddings through our adapter. Default targets Ollama on
// localhost — override the model string inline if you're on LM Studio (which uses
// e.g. text-embedding-nomic-embed-text-v1.5) or another OpenAI-compatible server.
const DEFAULT_EMBEDDING_PROVIDER: ProviderConfig = {
  id: 'openai-compatible',
  model: 'nomic-embed-text',
  baseUrl: 'http://127.0.0.1:11434/v1',
}

export function App() {
  const [auth, setAuth] = useState('dev')
  // First-launch users land on the Dashboard so they see the AI-first identity
  // (provider routing, API keys, quick actions) instead of an empty chat box.
  // Returning users land on chat — that's the daily-use surface.
  const [tab, setTab] = useState<'chat' | 'agent' | 'settings'>(() => {
    return localStorage.getItem('qbee.welcomed.v1') === '1' ? 'chat' : 'settings'
  })
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
  // Index lifecycle state. Replaces the old indexProgress: string.
  // - idle:     no index op in flight, ragStatus is the source of truth
  // - probing:  pre-flight embedding-endpoint check
  // - indexing: SSE stream is emitting progress events
  // - stalled:  no progress event in PROGRESS_STALL_MS while indexing
  // - error:    pre-flight or indexing terminated with a structured error
  // - done:     last op succeeded; ragStatus refreshed
  const [indexState, setIndexState] = useState<IndexState>({ stage: 'idle' })
  const [indexDetailOpen, setIndexDetailOpen] = useState(false)
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

  // The Dashboard panel writes chat preset/model directly to localStorage. Sync
  // those edits back into our state so the chat header picker reflects them
  // without a remount.
  useEffect(() => {
    const onConfigChange = () => {
      const storedIdx = Number(localStorage.getItem('qbee.presetIdx.v1') ?? '0')
      if (Number.isFinite(storedIdx) && storedIdx >= 0 && storedIdx < DEFAULT_PRESETS.length) {
        setPresetIdx(storedIdx)
      }
      const storedModel = localStorage.getItem('qbee.model.v1')
      if (storedModel !== null) setModel(storedModel)
    }
    window.addEventListener(CONFIG_CHANGE_EVENT, onConfigChange)
    return () => window.removeEventListener(CONFIG_CHANGE_EVENT, onConfigChange)
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
    // Pre-flight: is the embedding endpoint reachable? Catching this BEFORE
    // we burn through the file walk gives the user a clear error pointing at
    // their config rather than a cryptic mid-stream failure.
    setIndexState({ stage: 'probing' })
    try {
      const probeRes = await fetch('/api/rag/probe-embedding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify({ embeddingProvider }),
      })
      const probe = (await probeRes.json()) as RagProbeResponse
      if (!probe.ok) {
        setIndexState({
          stage: 'error',
          message: `Embedding endpoint not reachable`,
          hint: probe.error ?? `Check ${embeddingProvider.baseUrl ?? '(no baseUrl)'} — is your local model server running?`,
        })
        return
      }
    } catch (err) {
      setIndexState({
        stage: 'error',
        message: 'Could not reach the worker',
        hint: (err as Error).message,
      })
      return
    }

    setIndexState({ stage: 'indexing', phase: 'starting…', lastEventAt: Date.now() })
    try {
      const res = await fetch('/api/rag/index', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify({ workspaceRoot, embeddingProvider }),
      })
      if (!res.ok || !res.body) {
        setIndexState({ stage: 'error', message: `index request failed: HTTP ${res.status}` })
        return
      }
      let total = 0
      let chunks = 0
      let current = 0
      for await (const evt of parseSSE<{ type: string;[k: string]: unknown }>(res.body)) {
        const now = Date.now()
        if (evt.type === 'discovered') {
          total = evt.count as number
          setIndexState({ stage: 'indexing', phase: `discovered ${total} files`, total, current: 0, chunksSoFar: 0, lastEventAt: now })
        } else if (evt.type === 'file') {
          current = (evt.index as number) + 1
          setIndexState({ stage: 'indexing', phase: evt.path as string, total, current, chunksSoFar: chunks, lastEventAt: now })
        } else if (evt.type === 'embedded') {
          chunks += evt.chunkCount as number
          setIndexState((prev) => {
            if (prev.stage !== 'indexing' && prev.stage !== 'stalled') return prev
            const next: Extract<IndexState, { stage: 'indexing' }> = { stage: 'indexing', phase: prev.phase, chunksSoFar: chunks, lastEventAt: now }
            if (prev.total !== undefined) next.total = prev.total
            if (prev.current !== undefined) next.current = prev.current
            return next
          })
        } else if (evt.type === 'done') {
          setIndexState({ stage: 'done', files: evt.files as number, chunks: evt.chunks as number, tookMs: evt.tookMs as number })
        } else if (evt.type === 'error') {
          setIndexState({ stage: 'error', message: evt.message as string })
        }
      }
      // Refresh status after indexing.
      const statusRes = await fetch(`/api/rag/status?workspaceRoot=${encodeURIComponent(workspaceRoot)}`, { headers: authHeader() })
      if (statusRes.ok) setRagStatus(await statusRes.json())
    } catch (err) {
      setIndexState({ stage: 'error', message: (err as Error).message })
    }
  }

  // Stall detection: if no progress event arrives for PROGRESS_STALL_MS while
  // we're in 'indexing' state, flip to 'stalled'. The user sees a clear
  // 'stuck' badge instead of staring at a spinner that won't change.
  useEffect(() => {
    if (indexState.stage !== 'indexing') return undefined
    const timer = setInterval(() => {
      setIndexState((prev) => {
        if (prev.stage !== 'indexing') return prev
        const idle = Date.now() - prev.lastEventAt
        if (idle < PROGRESS_STALL_MS) return prev
        const next: Extract<IndexState, { stage: 'stalled' }> = { stage: 'stalled', phase: prev.phase, idleSinceMs: idle }
        if (prev.total !== undefined) next.total = prev.total
        if (prev.current !== undefined) next.current = prev.current
        if (prev.chunksSoFar !== undefined) next.chunksSoFar = prev.chunksSoFar
        return next
      })
    }, 5000)
    return () => clearInterval(timer)
  }, [indexState.stage])

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

  // First-launch users land on Dashboard. As soon as they navigate anywhere,
  // mark them as "welcomed" so subsequent launches default to chat.
  const switchTab = (next: 'chat' | 'agent' | 'settings') => {
    if (next !== 'settings') localStorage.setItem('qbee.welcomed.v1', '1')
    setTab(next)
  }

  return (
    <div style={styles.root}>
      <header style={styles.header}>
        <span style={styles.brand}>QBee</span>
        <button style={tabStyle(tab === 'chat')} onClick={() => switchTab('chat')}>chat</button>
        <button style={tabStyle(tab === 'agent')} onClick={() => switchTab('agent')}>agent</button>
        <button style={tabStyle(tab === 'settings')} onClick={() => switchTab('settings')}>dashboard</button>
        <select style={styles.select} value={presetIdx} onChange={(e) => setPresetIdx(Number(e.target.value))} disabled={busy}>
          {DEFAULT_PRESETS.map((p, i) => (
            <option key={i} value={i}>
              {p.label}
            </option>
          ))}
        </select>
        <input style={styles.modelInput} value={model} onChange={(e) => setModel(e.target.value)} disabled={busy} />
        <RagStatusBadge state={indexState} ragStatus={ragStatus} onClick={() => setIndexDetailOpen((v) => !v)} />
        <button style={styles.indexBtn} onClick={startIndex} disabled={busy || indexState.stage === 'probing' || indexState.stage === 'indexing'} title={`Embed via ${embeddingProvider.model} at ${embeddingProvider.baseUrl}`}>
          {(indexState.stage === 'probing' || indexState.stage === 'indexing' || indexState.stage === 'stalled') ? '⟳' : 'Index'}
        </button>
      </header>
      <RagStatusDetail state={indexState} open={indexDetailOpen} onRetry={startIndex} onDismiss={() => setIndexState({ stage: 'idle' })} />
      {indexState.stage === 'indexing' && <RagProgressLine state={indexState} />}
      {tab === 'settings' ? (
        <Settings
          auth={auth}
          embeddingProvider={embeddingProvider}
          setEmbeddingProvider={setEmbeddingProvider}
          onClose={() => switchTab('chat')}
          onStartChat={() => switchTab('chat')}
          onStartAgent={() => switchTab('agent')}
          onStartIndex={startIndex}
        />
      ) : tab === 'agent' ? (
        <Agent auth={auth} workspaceRoot={workspaceRoot} {...(editorContext ? { editorContext } : {})} />
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

function RagStatusBadge({ state, ragStatus, onClick }: { state: IndexState; ragStatus: RagStatusResponse | null; onClick: () => void }) {
  let label: string
  let bg: string
  let title: string
  switch (state.stage) {
    case 'idle':
    case 'done':
      label = `rag: ${ragStatus ? ragStatus.chunks : '—'}`
      bg = '#2a4a3a'
      title = ragStatus ? `${ragStatus.filesIndexed} files / ${ragStatus.chunks} chunks` : 'not indexed yet'
      break
    case 'probing':
      label = 'rag: probing…'
      bg = '#3a4a6a'
      title = 'Checking embedding endpoint'
      break
    case 'indexing': {
      const pct = state.total ? Math.round((state.current ?? 0) / state.total * 100) : null
      label = pct !== null ? `rag: indexing ${pct}%` : 'rag: indexing'
      bg = '#3a4a6a'
      title = state.phase
      break
    }
    case 'stalled':
      label = 'rag: stuck'
      bg = '#6a5a2a'
      title = `No progress for ${Math.round(state.idleSinceMs / 1000)}s — embedding endpoint slow or hung`
      break
    case 'error':
      label = 'rag: ✗ error'
      bg = '#6a3a3a'
      title = state.message
      break
  }
  return (
    <span style={{ ...ragBadgeBase, background: bg, cursor: 'pointer' }} title={title} onClick={onClick}>
      {label}
    </span>
  )
}

const ragBadgeBase: React.CSSProperties = { color: '#dde', padding: '2px 6px', borderRadius: 3, fontSize: 11, fontFamily: 'monospace' }

function RagStatusDetail({ state, open, onRetry, onDismiss }: { state: IndexState; open: boolean; onRetry: () => void; onDismiss: () => void }) {
  // Errors / stalled states show automatically (sticky); idle/done only when toggled open.
  const sticky = state.stage === 'error' || state.stage === 'stalled'
  if (!open && !sticky) return null
  let body: React.ReactNode = null
  if (state.stage === 'error') {
    body = (
      <>
        <div style={{ color: '#ffaaaa', fontWeight: 600 }}>{state.message}</div>
        {state.hint && <div style={{ color: '#ddc' }}>{state.hint}</div>}
        <div style={ragDetailActions}>
          <button style={ragDetailBtn} onClick={onRetry}>Retry</button>
          <button style={ragDetailBtnGhost} onClick={onDismiss}>Dismiss</button>
        </div>
      </>
    )
  } else if (state.stage === 'stalled') {
    body = (
      <>
        <div style={{ color: '#ffd', fontWeight: 600 }}>Indexing appears stuck</div>
        <div style={{ color: '#ddc' }}>
          No progress for {Math.round(state.idleSinceMs / 1000)}s. The embedding endpoint may have slowed down or hung.
          {state.total !== undefined && state.current !== undefined ? ` Last seen at file ${state.current}/${state.total}.` : ''}
        </div>
        <div style={ragDetailActions}>
          <button style={ragDetailBtnGhost} onClick={onDismiss}>Cancel & dismiss</button>
        </div>
      </>
    )
  } else if (state.stage === 'done') {
    body = (
      <div style={{ color: '#ddc' }}>
        Indexed {state.files} files, {state.chunks} chunks in {(state.tookMs / 1000).toFixed(1)}s.
      </div>
    )
  } else if (state.stage === 'idle') {
    body = (
      <div style={{ color: '#ddc' }}>
        Click <strong>Index</strong> to embed the workspace for <code>@codebase</code>. Re-index after big refactors; small edits are picked up automatically by the watcher.
      </div>
    )
  }
  return <div style={ragDetailRoot}>{body}</div>
}

const ragDetailRoot: React.CSSProperties = { padding: '8px 12px', fontSize: 11, fontFamily: 'monospace', background: '#1a1a1a', color: '#bbb', borderBottom: '1px solid #333', display: 'flex', flexDirection: 'column', gap: 4 }
const ragDetailActions: React.CSSProperties = { display: 'flex', gap: 6, marginTop: 4 }
const ragDetailBtn: React.CSSProperties = { background: '#3a6cd8', border: 'none', color: 'white', padding: '3px 10px', borderRadius: 3, fontSize: 11, cursor: 'pointer' }
const ragDetailBtnGhost: React.CSSProperties = { background: 'transparent', border: '1px solid #444', color: '#aaa', padding: '3px 10px', borderRadius: 3, fontSize: 11, cursor: 'pointer' }

function RagProgressLine({ state }: { state: Extract<IndexState, { stage: 'indexing' }> }) {
  const pct = state.total ? Math.round((state.current ?? 0) / state.total * 100) : null
  return (
    <div style={{ padding: '4px 12px', fontSize: 11, fontFamily: 'monospace', background: '#1a1a1a', color: '#9eccaa', borderBottom: '1px solid #333' }}>
      {pct !== null ? `${pct}% · ` : ''}
      {state.current !== undefined && state.total !== undefined ? `${state.current}/${state.total} · ` : ''}
      {state.chunksSoFar !== undefined ? `${state.chunksSoFar} chunks · ` : ''}
      {state.phase}
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
