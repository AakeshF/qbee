import { useEffect, useRef, useState } from 'react'
import type { ChatEvent, ChatMessage, ProviderConfig } from '@qbee/shared'
import { Agent } from './Agent.js'

type Msg = ChatMessage & { id: string }

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
  const [tab, setTab] = useState<'chat' | 'agent'>('chat')
  const [presetIdx, setPresetIdx] = useState(0)
  const [model, setModel] = useState(DEFAULT_PRESETS[0]!.config.model)
  const [workspaceRoot] = useState('/home/aakeshf/projects/qbee') // TODO: pass from editor via URL fragment
  const [input, setInput] = useState('')
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [busy, setBusy] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const listRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.slice(1))
    setAuth(params.get('auth') ?? 'dev')
  }, [])

  useEffect(() => {
    setModel(DEFAULT_PRESETS[presetIdx]!.config.model)
  }, [presetIdx])

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })
  }, [msgs])

  const authHeader = () => ({ Authorization: `Basic ${btoa(`qbee:${auth}`)}` })

  const send = async () => {
    const text = input.trim()
    if (!text || busy) return
    setInput('')

    const userMsg: Msg = { id: cryptoId(), role: 'user', content: text }
    const assistantMsg: Msg = { id: cryptoId(), role: 'assistant', content: '' }
    const nextMsgs = [...msgs, userMsg, assistantMsg]
    setMsgs(nextMsgs)
    setBusy(true)

    const ac = new AbortController()
    abortRef.current = ac

    const provider: ProviderConfig = { ...DEFAULT_PRESETS[presetIdx]!.config, model }
    const body = {
      provider,
      messages: nextMsgs.slice(0, -1).map(({ role, content }) => ({ role, content })),
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
        <select style={styles.select} value={presetIdx} onChange={(e) => setPresetIdx(Number(e.target.value))} disabled={busy}>
          {DEFAULT_PRESETS.map((p, i) => (
            <option key={i} value={i}>
              {p.label}
            </option>
          ))}
        </select>
        <input style={styles.modelInput} value={model} onChange={(e) => setModel(e.target.value)} disabled={busy} />
      </header>
      {tab === 'agent' ? (
        <Agent auth={auth} provider={currentProvider} workspaceRoot={workspaceRoot} />
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
            <div style={styles.content}>{m.content || (m.role === 'assistant' && busy ? '…' : '')}</div>
          </div>
        ))}
      </main>
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
}
