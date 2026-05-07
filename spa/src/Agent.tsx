import { useEffect, useRef, useState } from 'react'
import type { AgentEvent, ProviderConfig } from '@qbee/shared'
import { Markdown } from './Markdown.js'

type DiffStatus = 'pending' | 'applying' | 'applied' | 'failed' | 'rejected'

type Item =
  | { kind: 'user'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool_use'; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; id: string; name: string; summary: string; isError?: boolean }
  | { kind: 'file_diff'; diffId: string; path: string; unifiedDiff: string; oldContent: string; newContent: string; status: DiffStatus; error?: string }
  | { kind: 'error'; message: string }
  | { kind: 'done'; reason: string }

type Props = { auth: string; provider: ProviderConfig; workspaceRoot: string }

export function Agent({ auth, provider, workspaceRoot }: Props) {
  const [input, setInput] = useState('')
  const [items, setItems] = useState<Item[]>([])
  const [busy, setBusy] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })
  }, [items])

  // Listen for edit_applied acks from the editor (forwarded by the webview relay).
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const data = e.data
      if (!data || typeof data !== 'object' || data.type !== 'edit_applied') return
      setItems((arr) =>
        arr.map((item) => {
          if (item.kind === 'file_diff' && item.diffId === data.requestId) {
            return data.success
              ? { ...item, status: 'applied' as DiffStatus }
              : { ...item, status: 'failed' as DiffStatus, error: data.error || 'unknown error' }
          }
          return item
        }),
      )
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [])

  const applyDiff = (diffId: string, path: string, oldContent: string, newContent: string) => {
    setItems((arr) => arr.map((it) => (it.kind === 'file_diff' && it.diffId === diffId ? { ...it, status: 'applying' as DiffStatus } : it)))
    window.parent.postMessage({ type: 'apply_edit', requestId: diffId, path, oldContent, newContent }, '*')
  }

  const rejectDiff = (diffId: string) => {
    setItems((arr) => arr.map((it) => (it.kind === 'file_diff' && it.diffId === diffId ? { ...it, status: 'rejected' as DiffStatus } : it)))
  }

  const authHeader = () => ({ Authorization: `Basic ${btoa(`qbee:${auth}`)}` })

  const run = async () => {
    const text = input.trim()
    if (!text || busy) return
    setInput('')
    setItems((arr) => [...arr, { kind: 'user', text }])
    setBusy(true)

    const ac = new AbortController()
    abortRef.current = ac

    const body = {
      provider,
      messages: [{ role: 'user', content: text }],
      workspaceRoot,
      maxIterations: 20,
    }

    try {
      const res = await fetch('/api/agent/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify(body),
        signal: ac.signal,
      })
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)

      // Buffer text deltas into a rolling "text" item to avoid spamming a new line per token.
      let pendingText: Item | null = null
      const flushText = () => {
        if (pendingText) {
          const captured = pendingText
          setItems((arr) => [...arr, captured])
          pendingText = null
        }
      }

      for await (const evt of parseSSE<AgentEvent>(res.body)) {
        if (evt.type === 'text') {
          if (pendingText && pendingText.kind === 'text') {
            pendingText = { kind: 'text', text: pendingText.text + evt.value }
            // Live-update the in-progress text bubble.
            setItems((arr) => {
              const out = arr.slice()
              const last = out[out.length - 1]
              if (last && last.kind === 'text') {
                out[out.length - 1] = { ...last, text: last.text + evt.value }
                return out
              }
              return [...arr, { kind: 'text' as const, text: evt.value }]
            })
            // Track for the flush logic — we already mirrored into state above.
            pendingText = { kind: 'text', text: pendingText.text }
          } else {
            flushText()
            pendingText = { kind: 'text', text: evt.value }
            setItems((arr) => [...arr, { kind: 'text', text: evt.value }])
          }
        } else if (evt.type === 'tool_use') {
          flushText()
          setItems((arr) => [...arr, { kind: 'tool_use', id: evt.id, name: evt.name, input: evt.input }])
        } else if (evt.type === 'tool_result') {
          setItems((arr) => [
            ...arr,
            {
              kind: 'tool_result',
              id: evt.id,
              name: evt.name,
              summary: evt.summary,
              ...(evt.isError ? { isError: true } : {}),
            },
          ])
        } else if (evt.type === 'file_diff') {
          const diffId = cryptoId()
          setItems((arr) => [
            ...arr,
            { kind: 'file_diff', diffId, path: evt.path, unifiedDiff: evt.unifiedDiff, oldContent: evt.oldContent, newContent: evt.newContent, status: 'pending' },
          ])
        } else if (evt.type === 'iteration') {
          // No UI for iteration boundaries — just for debugging.
        } else if (evt.type === 'error') {
          flushText()
          setItems((arr) => [...arr, { kind: 'error', message: evt.message }])
        } else if (evt.type === 'done') {
          flushText()
          setItems((arr) => [...arr, { kind: 'done', reason: evt.reason }])
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setItems((arr) => [...arr, { kind: 'error', message: (err as Error).message }])
      }
    } finally {
      setBusy(false)
      abortRef.current = null
    }
  }

  const cancel = () => abortRef.current?.abort()

  return (
    <div style={styles.root}>
      <div ref={listRef} style={styles.list}>
        {items.length === 0 && (
          <div style={styles.hint}>
            Ask the agent to read, search, or propose edits to files. Diffs render here for review.
            <br />
            <small>Apply happens manually for now — copy the diff and apply it via your editor's diff tools. WorkspaceEdit RPC ships in Phase 4.5.</small>
          </div>
        )}
        {items.map((item, i) => (
          <Block key={i} item={item} onApply={applyDiff} onReject={rejectDiff} />
        ))}
      </div>
      <form
        style={styles.form}
        onSubmit={(e) => {
          e.preventDefault()
          run()
        }}
      >
        <textarea
          style={styles.textarea}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Tell the agent what to do…"
          disabled={busy}
          rows={2}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              run()
            }
          }}
        />
        {busy ? (
          <button type="button" style={styles.button} onClick={cancel}>
            Stop
          </button>
        ) : (
          <button type="submit" style={styles.button} disabled={!input.trim()}>
            Run
          </button>
        )}
      </form>
    </div>
  )
}

type BlockProps = {
  item: Item
  onApply: (diffId: string, path: string, oldContent: string, newContent: string) => void
  onReject: (diffId: string) => void
}

function Block({ item, onApply, onReject }: BlockProps) {
  switch (item.kind) {
    case 'user':
      return (
        <div style={{ ...styles.msg, ...styles.user }}>
          <div style={styles.role}>you</div>
          <div style={styles.content}>{item.text}</div>
        </div>
      )
    case 'text':
      return (
        <div style={{ ...styles.msg, ...styles.assistant }}>
          <div style={styles.role}>agent</div>
          <div style={styles.content}>
            <Markdown text={item.text} />
          </div>
        </div>
      )
    case 'tool_use':
      return (
        <div style={styles.toolUse}>
          <span style={styles.toolBadge}>{item.name}</span>
          <code style={styles.toolInput}>{JSON.stringify(item.input)}</code>
        </div>
      )
    case 'tool_result':
      return (
        <div style={{ ...styles.toolResult, ...(item.isError ? styles.toolResultError : {}) }}>
          <span style={styles.toolResultLabel}>↳ {item.name}:</span> {item.summary}
        </div>
      )
    case 'file_diff':
      return <DiffView item={item} onApply={onApply} onReject={onReject} />
    case 'error':
      return <div style={styles.error}>error: {item.message}</div>
    case 'done':
      return <div style={styles.done}>— {item.reason} —</div>
  }
}

type DiffItem = Extract<Item, { kind: 'file_diff' }>
function DiffView({
  item,
  onApply,
  onReject,
}: {
  item: DiffItem
  onApply: (diffId: string, path: string, oldContent: string, newContent: string) => void
  onReject: (diffId: string) => void
}) {
  const lines = item.unifiedDiff.split('\n')
  const statusBadge: Record<DiffStatus, { label: string; bg: string }> = {
    pending: { label: 'pending', bg: '#3a4a6a' },
    applying: { label: 'applying…', bg: '#4a4a3a' },
    applied: { label: '✓ applied', bg: '#3a6a3a' },
    failed: { label: '✗ failed', bg: '#6a3a3a' },
    rejected: { label: 'rejected', bg: '#444' },
  }
  const badge = statusBadge[item.status]
  return (
    <div style={styles.diffBlock}>
      <div style={styles.diffHeader}>
        <span style={{ flex: 1 }}>{item.path}</span>
        <span style={{ ...styles.statusBadge, background: badge.bg }}>{badge.label}</span>
        {item.status === 'pending' && (
          <span style={styles.diffActions}>
            <button style={styles.applyBtn} onClick={() => onApply(item.diffId, item.path, item.oldContent, item.newContent)}>
              Apply
            </button>
            <button style={styles.rejectBtn} onClick={() => onReject(item.diffId)}>
              Reject
            </button>
          </span>
        )}
      </div>
      {item.status === 'failed' && item.error && <div style={styles.diffError}>{item.error}</div>}
      <pre style={styles.diffPre}>
        {lines.map((line, i) => {
          const color = line.startsWith('+') && !line.startsWith('+++') ? '#3a6d3a' : line.startsWith('-') && !line.startsWith('---') ? '#6d3a3a' : line.startsWith('@@') ? '#444' : 'transparent'
          return (
            <div key={i} style={{ background: color, padding: '0 4px', minHeight: '1em' }}>
              {line || ' '}
            </div>
          )
        })}
      </pre>
    </div>
  )
}

function cryptoId(): string {
  return crypto.randomUUID?.() ?? String(Math.random())
}

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
  root: { display: 'flex', flexDirection: 'column', height: '100%' },
  list: { flex: 1, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 6 },
  hint: { opacity: 0.5, fontSize: 13, lineHeight: 1.5 },
  msg: { padding: '8px 10px', borderRadius: 6, fontSize: 13, lineHeight: 1.5 },
  user: { background: '#2a3a5a', alignSelf: 'flex-end', maxWidth: '85%' },
  assistant: { background: '#2a2a2a', alignSelf: 'flex-start', maxWidth: '85%' },
  role: { fontSize: 10, opacity: 0.5, marginBottom: 2, textTransform: 'uppercase' },
  content: { whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  toolUse: { fontSize: 11, padding: '4px 8px', display: 'flex', gap: 6, alignItems: 'center', opacity: 0.85 },
  toolBadge: { background: '#3a4a6a', color: 'white', padding: '2px 6px', borderRadius: 3, fontFamily: 'monospace' },
  toolInput: { fontFamily: 'monospace', fontSize: 11, opacity: 0.8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  toolResult: { fontSize: 11, padding: '2px 8px 2px 22px', opacity: 0.7 },
  toolResultError: { color: '#d97070', opacity: 1 },
  toolResultLabel: { fontFamily: 'monospace', opacity: 0.7 },
  diffBlock: { border: '1px solid #444', borderRadius: 4, overflow: 'hidden', margin: '4px 0' },
  diffHeader: { background: '#2a2a2a', padding: '4px 8px', fontSize: 12, fontFamily: 'monospace', borderBottom: '1px solid #444', display: 'flex', alignItems: 'center', gap: 6 },
  statusBadge: { color: 'white', padding: '1px 6px', borderRadius: 3, fontSize: 10, fontFamily: 'sans-serif' },
  diffActions: { display: 'flex', gap: 4 },
  applyBtn: { background: '#3a6cd8', color: 'white', border: 'none', padding: '2px 8px', borderRadius: 3, fontSize: 11, cursor: 'pointer' },
  rejectBtn: { background: '#444', color: '#ddd', border: 'none', padding: '2px 8px', borderRadius: 3, fontSize: 11, cursor: 'pointer' },
  diffError: { color: '#d97070', fontSize: 11, padding: '4px 8px', background: '#3a1a1a' },
  diffPre: { margin: 0, padding: '4px 0', fontSize: 11, fontFamily: 'monospace', overflowX: 'auto', lineHeight: 1.4 },
  error: { color: '#d97070', fontSize: 12, padding: '4px 8px' },
  done: { fontSize: 11, opacity: 0.5, textAlign: 'center', padding: 4 },
  form: { display: 'flex', gap: 6, padding: 8, borderTop: '1px solid #333' },
  textarea: { flex: 1, background: '#2a2a2a', border: '1px solid #444', color: '#ddd', padding: '6px 8px', borderRadius: 4, fontSize: 13, fontFamily: 'inherit', resize: 'none' },
  button: { background: '#3a6cd8', border: 'none', color: 'white', padding: '6px 12px', borderRadius: 4, cursor: 'pointer', fontSize: 13, alignSelf: 'flex-end' },
}
