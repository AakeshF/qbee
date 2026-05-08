import { useEffect, useRef, useState } from 'react'
import type { AgentEvent, ChatMessage, EditorContext, ProviderConfig } from '@qbee/shared'
import { Markdown } from './Markdown.js'
import { DEFAULT_PRESETS, resolveProvider } from './presets.js'
import { CONFIG_CHANGE_EVENT } from './Settings.js'

type DiffStatus = 'pending' | 'applying' | 'applied' | 'failed' | 'rejected'

type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'auto-approved'

type Item =
  | { kind: 'user'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool_use'; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; id: string; name: string; summary: string; isError?: boolean }
  | { kind: 'file_diff'; diffId: string; path: string; unifiedDiff: string; oldContent: string; newContent: string; status: DiffStatus; error?: string }
  | { kind: 'awaiting_approval'; approvalId: string; command: string; cwd?: string; status: ApprovalStatus }
  | { kind: 'error'; message: string }
  | { kind: 'done'; reason: string }

function allowListKey(workspaceRoot: string): string {
  return `qbee.terminal.allow.${workspaceRoot || '_default_'}`
}
function loadAllowList(workspaceRoot: string): string[] {
  try {
    const raw = localStorage.getItem(allowListKey(workspaceRoot))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}
function saveAllowList(workspaceRoot: string, list: string[]): void {
  localStorage.setItem(allowListKey(workspaceRoot), JSON.stringify(list))
}

type Props = { auth: string; workspaceRoot: string; editorContext?: EditorContext }

export function Agent({ auth, workspaceRoot, editorContext }: Props) {
  const [input, setInput] = useState('')
  const [items, setItems] = useState<Item[]>([])
  const [busy, setBusy] = useState(false)
  // Persistent conversation across runs. Each run appends the user turn + the
  // assistant's TEXT response (without tool blocks). Tool history is per-run only.
  const [conversation, setConversation] = useState<ChatMessage[]>([])
  // Independent provider/model selection — agent ≠ chat. Storage keys are
  // distinct from the chat keys (qbee.presetIdx.v1 / qbee.model.v1) so each
  // panel persists on its own.
  const [presetIdx, setPresetIdx] = useState<number>(() => {
    const stored = Number(localStorage.getItem('qbee.agent.presetIdx.v1') ?? '1')
    return Number.isFinite(stored) && stored >= 0 && stored < DEFAULT_PRESETS.length ? stored : 1
  })
  const [model, setModel] = useState<string>(() => {
    return localStorage.getItem('qbee.agent.model.v1') ?? DEFAULT_PRESETS[1]!.config.model
  })
  const provider: ProviderConfig = resolveProvider(presetIdx, model)
  const abortRef = useRef<AbortController | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    localStorage.setItem('qbee.agent.presetIdx.v1', String(presetIdx))
  }, [presetIdx])
  useEffect(() => {
    localStorage.setItem('qbee.agent.model.v1', model)
  }, [model])
  // Match App.tsx behavior: switching the preset retunes the model field unless
  // the user has explicitly typed one. Track the previous preset so initial
  // restore-from-storage doesn't stomp the saved model.
  const prevPresetRef = useRef(presetIdx)
  useEffect(() => {
    if (prevPresetRef.current !== presetIdx) {
      setModel(DEFAULT_PRESETS[presetIdx]!.config.model)
      prevPresetRef.current = presetIdx
    }
  }, [presetIdx])

  // Pick up edits made in the Dashboard (which writes localStorage directly).
  useEffect(() => {
    const onConfigChange = () => {
      const storedIdx = Number(localStorage.getItem('qbee.agent.presetIdx.v1') ?? '1')
      if (Number.isFinite(storedIdx) && storedIdx >= 0 && storedIdx < DEFAULT_PRESETS.length) {
        prevPresetRef.current = storedIdx
        setPresetIdx(storedIdx)
      }
      const storedModel = localStorage.getItem('qbee.agent.model.v1')
      if (storedModel !== null) setModel(storedModel)
    }
    window.addEventListener(CONFIG_CHANGE_EVENT, onConfigChange)
    return () => window.removeEventListener(CONFIG_CHANGE_EVENT, onConfigChange)
  }, [])

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

  // runId stamps every apply_edit with the agent run that produced the diff,
  // so the editor's CheckpointStore groups all edits from one run into a
  // single restorable snapshot. Generated fresh in run() and refreshed across
  // runs.
  const runIdRef = useRef<string>(`run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)

  const applyDiff = (diffId: string, path: string, oldContent: string, newContent: string) => {
    setItems((arr) => arr.map((it) => (it.kind === 'file_diff' && it.diffId === diffId ? { ...it, status: 'applying' as DiffStatus } : it)))
    window.parent.postMessage({ type: 'apply_edit', requestId: diffId, runId: runIdRef.current, path, oldContent, newContent }, '*')
  }

  const rejectDiff = (diffId: string) => {
    setItems((arr) => arr.map((it) => (it.kind === 'file_diff' && it.diffId === diffId ? { ...it, status: 'rejected' as DiffStatus } : it)))
  }

  const authHeader = () => ({ Authorization: `Basic ${btoa(`qbee:${auth}`)}` })

  // POST the approval/denial back to the worker. Idempotent on the server side.
  const submitApproval = async (approvalId: string, approved: boolean): Promise<void> => {
    try {
      await fetch('/api/agent/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify({ approvalId, approved }),
      })
    } catch {
      // Best-effort: if the post fails, the run will time out / abort on disconnect.
    }
  }

  const approveCommand = (approvalId: string, command: string, alwaysAllow: boolean) => {
    if (alwaysAllow) {
      const list = loadAllowList(workspaceRoot)
      if (!list.includes(command)) {
        list.push(command)
        saveAllowList(workspaceRoot, list)
      }
    }
    setItems((arr) => arr.map((it) => (it.kind === 'awaiting_approval' && it.approvalId === approvalId ? { ...it, status: 'approved' as ApprovalStatus } : it)))
    void submitApproval(approvalId, true)
  }
  const denyCommand = (approvalId: string) => {
    setItems((arr) => arr.map((it) => (it.kind === 'awaiting_approval' && it.approvalId === approvalId ? { ...it, status: 'denied' as ApprovalStatus } : it)))
    void submitApproval(approvalId, false)
  }

  const clearConversation = () => {
    setItems([])
    setConversation([])
  }

  const run = async () => {
    const text = input.trim()
    if (!text || busy) return
    setInput('')
    // Fresh runId for this run — the editor's CheckpointStore groups apply_edit
    // calls under this id so 'Undo Last Agent Run' rolls back exactly this run.
    runIdRef.current = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    setItems((arr) => [...arr, { kind: 'user', text }])
    setBusy(true)

    const ac = new AbortController()
    abortRef.current = ac

    const userTurn: ChatMessage = { role: 'user', content: text }
    const body: { provider: ProviderConfig; messages: ChatMessage[]; workspaceRoot: string; maxIterations: number; editorContext?: EditorContext } = {
      provider,
      messages: [...conversation, userTurn],
      workspaceRoot,
      maxIterations: 20,
    }
    if (editorContext && (editorContext.activeFile || editorContext.selection || (editorContext.openFiles && editorContext.openFiles.length > 0))) {
      body.editorContext = editorContext
    }

    try {
      const res = await fetch('/api/agent/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify(body),
        signal: ac.signal,
      })
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)

      // We collapse a run of text deltas into a single rolling text bubble.
      // The bubble lives in `items` from the moment the first delta arrives;
      // subsequent deltas mutate that same item in place. `bubbleOpen` tracks
      // whether items[last] is the current text bubble we should keep
      // appending to. Any non-text event closes the bubble.
      //
      // Earlier versions of this code maintained a parallel `pendingText`
      // accumulator AND wrote to items, then 'flushed' pendingText into
      // items on tool events. That double-tracked the bubble and
      // double-appended on flush — the user-visible duplicate output.
      let bubbleOpen = false
      let assistantText = ''

      for await (const evt of parseSSE<AgentEvent>(res.body)) {
        if (evt.type === 'text') {
          assistantText += evt.value
          if (bubbleOpen) {
            setItems((arr) => {
              const out = arr.slice()
              const last = out[out.length - 1]
              if (last && last.kind === 'text') {
                out[out.length - 1] = { ...last, text: last.text + evt.value }
              }
              return out
            })
          } else {
            setItems((arr) => [...arr, { kind: 'text' as const, text: evt.value }])
            bubbleOpen = true
          }
        } else if (evt.type === 'tool_use') {
          bubbleOpen = false
          setItems((arr) => [...arr, { kind: 'tool_use', id: evt.id, name: evt.name, input: evt.input }])
        } else if (evt.type === 'tool_result') {
          bubbleOpen = false
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
          bubbleOpen = false
          const diffId = cryptoId()
          setItems((arr) => [
            ...arr,
            { kind: 'file_diff', diffId, path: evt.path, unifiedDiff: evt.unifiedDiff, oldContent: evt.oldContent, newContent: evt.newContent, status: 'pending' },
          ])
        } else if (evt.type === 'iteration') {
          // No UI for iteration boundaries — just for debugging.
        } else if (evt.type === 'awaiting_approval') {
          bubbleOpen = false
          const allowList = loadAllowList(workspaceRoot)
          const autoApprove = allowList.includes(evt.command)
          setItems((arr) => [
            ...arr,
            {
              kind: 'awaiting_approval',
              approvalId: evt.approvalId,
              command: evt.command,
              ...(evt.cwd !== undefined ? { cwd: evt.cwd } : {}),
              status: autoApprove ? 'auto-approved' : 'pending',
            },
          ])
          if (autoApprove) {
            void submitApproval(evt.approvalId, true)
          }
        } else if (evt.type === 'error') {
          bubbleOpen = false
          setItems((arr) => [...arr, { kind: 'error', message: evt.message }])
        } else if (evt.type === 'done') {
          bubbleOpen = false
          setItems((arr) => [...arr, { kind: 'done', reason: evt.reason }])
        }
      }
      // Persist this turn into conversation state so the next run sees it.
      const newConversation: ChatMessage[] = [...conversation, userTurn]
      if (assistantText.trim()) {
        newConversation.push({ role: 'assistant', content: assistantText })
      }
      setConversation(newConversation)
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
      <div style={styles.subheader}>
        <select
          style={styles.presetSelect}
          value={presetIdx}
          onChange={(e) => setPresetIdx(Number(e.target.value))}
          disabled={busy}
          title="Provider preset for the agent (independent from chat)"
        >
          {DEFAULT_PRESETS.map((p, i) => (
            <option key={i} value={i}>{p.label}</option>
          ))}
        </select>
        <input
          style={styles.modelInput}
          value={model}
          onChange={(e) => setModel(e.target.value)}
          disabled={busy}
          title="Model for the agent"
        />
        <span style={styles.turnCount}>
          turns: {conversation.length / 2 | 0}
        </span>
        {conversation.length > 0 && (
          <button style={styles.clearBtn} onClick={clearConversation} disabled={busy}>
            Clear conversation
          </button>
        )}
      </div>
      <div ref={listRef} style={styles.list}>
        {items.length === 0 && (
          <div style={styles.hint}>
            Ask the agent to read, search, or propose edits to files. Click Apply on diffs to write via WorkspaceEdit. Conversation persists across runs — use Clear to start fresh.
          </div>
        )}
        {items.map((item, i) => (
          <Block key={i} item={item} onApply={applyDiff} onReject={rejectDiff} onApprove={approveCommand} onDeny={denyCommand} />
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
  onApprove: (approvalId: string, command: string, alwaysAllow: boolean) => void
  onDeny: (approvalId: string) => void
}

function Block({ item, onApply, onReject, onApprove, onDeny }: BlockProps) {
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
    case 'awaiting_approval':
      return <ApprovalView item={item} onApprove={onApprove} onDeny={onDeny} />
    case 'error':
      return <div style={styles.error}>error: {item.message}</div>
    case 'done':
      return <div style={styles.done}>— {item.reason} —</div>
  }
}

type ApprovalItem = Extract<Item, { kind: 'awaiting_approval' }>
function ApprovalView({
  item,
  onApprove,
  onDeny,
}: {
  item: ApprovalItem
  onApprove: (approvalId: string, command: string, alwaysAllow: boolean) => void
  onDeny: (approvalId: string) => void
}) {
  const statusBadge: Record<ApprovalStatus, { label: string; bg: string }> = {
    pending: { label: 'awaiting approval', bg: '#4a4a3a' },
    approved: { label: '✓ approved', bg: '#3a6a3a' },
    'auto-approved': { label: '✓ auto-approved', bg: '#3a6a3a' },
    denied: { label: '✗ denied', bg: '#6a3a3a' },
  }
  const badge = statusBadge[item.status]
  return (
    <div style={styles.approvalBlock}>
      <div style={styles.approvalHeader}>
        <span style={styles.approvalLabel}>run_terminal</span>
        {item.cwd && <span style={styles.approvalCwd}>cwd: {item.cwd}</span>}
        <span style={{ flex: 1 }} />
        <span style={{ ...styles.statusBadge, background: badge.bg }}>{badge.label}</span>
      </div>
      <pre style={styles.approvalCommand}>$ {item.command}</pre>
      {item.status === 'pending' && (
        <div style={styles.approvalActions}>
          <button style={styles.applyBtn} onClick={() => onApprove(item.approvalId, item.command, false)}>Approve once</button>
          <button style={styles.applyBtn} onClick={() => onApprove(item.approvalId, item.command, true)} title="Auto-approve future runs of this exact command in this workspace">Always allow</button>
          <button style={styles.rejectBtn} onClick={() => onDeny(item.approvalId)}>Deny</button>
        </div>
      )}
    </div>
  )
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
  subheader: { display: 'flex', alignItems: 'center', gap: 6, padding: '4px 12px', borderBottom: '1px solid #2a2a2a', fontSize: 11, color: '#888' },
  presetSelect: { background: '#2a2a2a', border: '1px solid #444', color: '#ddd', padding: '2px 6px', borderRadius: 3, fontSize: 11 },
  modelInput: { background: '#2a2a2a', border: '1px solid #444', color: '#ddd', padding: '2px 6px', borderRadius: 3, fontSize: 11, fontFamily: 'monospace', width: 140 },
  turnCount: { fontFamily: 'monospace', flex: 1, marginLeft: 6 },
  clearBtn: { background: 'transparent', border: '1px solid #444', color: '#aaa', padding: '2px 8px', borderRadius: 3, fontSize: 10, cursor: 'pointer' },
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
  approvalBlock: { border: '1px solid #6a5a3a', borderRadius: 4, overflow: 'hidden', margin: '4px 0', background: '#2a2418' },
  approvalHeader: { padding: '4px 8px', fontSize: 11, display: 'flex', alignItems: 'center', gap: 6, borderBottom: '1px solid #4a4030' },
  approvalLabel: { fontFamily: 'monospace', background: '#5a4a2a', color: 'white', padding: '1px 6px', borderRadius: 3, fontSize: 10 },
  approvalCwd: { fontSize: 10, opacity: 0.7, fontFamily: 'monospace' },
  approvalCommand: { margin: 0, padding: '8px 10px', fontFamily: 'monospace', fontSize: 12, color: '#ffd', whiteSpace: 'pre-wrap' as const, wordBreak: 'break-all' as const },
  approvalActions: { display: 'flex', gap: 6, padding: '4px 8px 8px', borderTop: '1px solid #4a4030' },
  error: { color: '#d97070', fontSize: 12, padding: '4px 8px' },
  done: { fontSize: 11, opacity: 0.5, textAlign: 'center', padding: 4 },
  form: { display: 'flex', gap: 6, padding: 8, borderTop: '1px solid #333' },
  textarea: { flex: 1, background: '#2a2a2a', border: '1px solid #444', color: '#ddd', padding: '6px 8px', borderRadius: 4, fontSize: 13, fontFamily: 'inherit', resize: 'none' },
  button: { background: '#3a6cd8', border: 'none', color: 'white', padding: '6px 12px', borderRadius: 4, cursor: 'pointer', fontSize: 13, alignSelf: 'flex-end' },
}
