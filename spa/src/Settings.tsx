// Dashboard panel: per-function provider/model selection (chat + agent),
// API keys, embedding endpoint, and quick actions. The visible identity of
// the editor on first launch — see App.tsx's "qbee.welcomed.v1" flag for
// how this becomes the default tab.
//
// Cross-component sync: when the chat or agent provider/model changes here,
// we dispatch a 'qbee-config-change' window event so App.tsx (chat header)
// and Agent.tsx (agent picker) re-read their localStorage and update their
// own pickers without remount.
//
// Threat model on API keys: localStorage is plaintext on the user's machine —
// "browser-stored token". v1.0 migrates to editor-side SecretStorage.

import { useEffect, useState } from 'react'
import type { LocalModel, LocalModelsProbeResponse, ProviderConfig, UpdateCheckResponse, UpdateProgressEvent } from '@qbee/shared'
import { DEFAULT_PRESETS, presetIdxForLocalSource } from './presets.js'
import { getEditorSetting, setEditorSetting, onEditorSettingChanged } from './editorBridge.js'

const FIM_KEY_ENABLED = 'qbee.inlineCompletions.enabled'
const FIM_KEY_MODEL = 'qbee.inlineCompletions.model'
const FIM_KEY_BASE_URL = 'qbee.inlineCompletions.baseUrl'

const STORAGE_KEY = 'qbee.secrets.v1'
const EMBEDDING_KEY = 'qbee.embeddingProvider.v1'
const CHAT_PRESET_KEY = 'qbee.presetIdx.v1'
const CHAT_MODEL_KEY = 'qbee.model.v1'
const AGENT_PRESET_KEY = 'qbee.agent.presetIdx.v1'
const AGENT_MODEL_KEY = 'qbee.agent.model.v1'

// Window event other panels listen to so they pick up dashboard edits without
// a remount. The single event covers all scopes; subscribers re-read the keys
// they care about.
export const CONFIG_CHANGE_EVENT = 'qbee-config-change'

type SecretMap = Record<string, string>

export type SettingsProps = {
  auth: string
  embeddingProvider: ProviderConfig
  setEmbeddingProvider: (cfg: ProviderConfig) => void
  onClose: () => void
  onStartChat: () => void
  onStartAgent: () => void
  onStartIndex: () => void
}

export function loadSecrets(): SecretMap {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
  } catch {
    return {}
  }
}

export function saveSecrets(secrets: SecretMap): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(secrets))
}

export function loadEmbeddingProvider(): ProviderConfig | null {
  try {
    const raw = localStorage.getItem(EMBEDDING_KEY)
    return raw ? (JSON.parse(raw) as ProviderConfig) : null
  } catch {
    return null
  }
}

// Push every locally-stored secret to the worker. Call on app load and
// whenever a key is set/cleared. Worker is in-memory; restart drops state.
export async function pushSecretsToWorker(auth: string): Promise<void> {
  const secrets = loadSecrets()
  const authHeader = { Authorization: `Basic ${btoa(`qbee:${auth}`)}` }
  await Promise.all(
    Object.entries(secrets).map(([key, value]) =>
      fetch('/api/secrets/set', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({ key, value }),
      }).catch(() => null),
    ),
  )
}

const KNOWN_KEYS = [
  { ref: 'ANTHROPIC_API_KEY', label: 'Anthropic API key', hint: 'sk-ant-…' },
  { ref: 'GEMINI_API_KEY', label: 'Google Gemini API key', hint: 'AIza…' },
  { ref: 'OPENAI_API_KEY', label: 'OpenAI API key (or any OpenAI-compatible token)', hint: 'sk-…' },
]

export function Settings({ auth, embeddingProvider, setEmbeddingProvider, onClose, onStartChat, onStartAgent, onStartIndex }: SettingsProps) {
  const [secrets, setSecrets] = useState<SecretMap>(() => loadSecrets())
  const [revealedKey, setRevealedKey] = useState<string | null>(null)
  const [embedBaseUrl, setEmbedBaseUrl] = useState(embeddingProvider.baseUrl ?? '')
  const [embedModel, setEmbedModel] = useState(embeddingProvider.model)
  const [savedNote, setSavedNote] = useState<string | null>(null)

  // Per-function provider state. Read from localStorage; write through helpers
  // that also dispatch CONFIG_CHANGE_EVENT so the chat and agent panels stay
  // in sync without prop drilling.
  const [chatPresetIdx, setChatPresetIdxState] = useState<number>(() => readPresetIdx(CHAT_PRESET_KEY, 0))
  const [chatModel, setChatModelState] = useState<string>(() => readModel(CHAT_MODEL_KEY, DEFAULT_PRESETS[0]!.config.model))
  const [agentPresetIdx, setAgentPresetIdxState] = useState<number>(() => readPresetIdx(AGENT_PRESET_KEY, 1))
  const [agentModel, setAgentModelState] = useState<string>(() => readModel(AGENT_MODEL_KEY, DEFAULT_PRESETS[1]!.config.model))

  // Local-model auto-detect. Worker probes Ollama / LM Studio / llama.cpp on
  // loopback and returns whatever's running.
  const [localProbe, setLocalProbe] = useState<LocalModelsProbeResponse | null>(null)
  const [probing, setProbing] = useState(false)

  // In-app updater state. Linux AppImage only in v0.5.
  const [updateCheck, setUpdateCheck] = useState<UpdateCheckResponse | null>(null)
  const [updateChecking, setUpdateChecking] = useState(false)
  const [updateProgress, setUpdateProgress] = useState<UpdateProgressEvent | null>(null)
  const [updateApplying, setUpdateApplying] = useState(false)

  // FIM (inline completions) config — lives in IConfigurationService, not
  // localStorage, because the InlineCompletionProvider on the editor side
  // is the only consumer. Read on mount via the editor bridge; write back
  // on edit. Standalone Vite dev (no editor host) just leaves these blank
  // — the bridge times out cleanly.
  const [fimEnabled, setFimEnabled] = useState<boolean | null>(null)
  const [fimModel, setFimModel] = useState<string>('')
  const [fimBaseUrl, setFimBaseUrl] = useState<string>('')

  useEffect(() => {
    let cancelled = false
    void Promise.all([
      getEditorSetting<boolean>(FIM_KEY_ENABLED),
      getEditorSetting<string>(FIM_KEY_MODEL),
      getEditorSetting<string>(FIM_KEY_BASE_URL),
    ]).then(([enabled, model, baseUrl]) => {
      if (cancelled) return
      if (typeof enabled === 'boolean') setFimEnabled(enabled)
      if (typeof model === 'string') setFimModel(model)
      if (typeof baseUrl === 'string') setFimBaseUrl(baseUrl)
    })
    const off = onEditorSettingChanged((key, value) => {
      if (cancelled) return
      if (key === FIM_KEY_ENABLED && typeof value === 'boolean') setFimEnabled(value)
      else if (key === FIM_KEY_MODEL && typeof value === 'string') setFimModel(value)
      else if (key === FIM_KEY_BASE_URL && typeof value === 'string') setFimBaseUrl(value)
    })
    return () => { cancelled = true; off() }
  }, [])

  const updateFimSetting = async (key: string, value: unknown) => {
    const res = await setEditorSetting(key, value)
    setSavedNote(res.ok ? `saved ${key.replace('qbee.inlineCompletions.', 'FIM ')}` : `failed: ${res.error ?? 'unknown'}`)
  }

  const setChatPresetIdx = (idx: number) => {
    setChatPresetIdxState(idx)
    localStorage.setItem(CHAT_PRESET_KEY, String(idx))
    const newModel = DEFAULT_PRESETS[idx]!.config.model
    setChatModelState(newModel)
    localStorage.setItem(CHAT_MODEL_KEY, newModel)
    notifyConfigChange()
  }
  const setChatModel = (m: string) => {
    setChatModelState(m)
    localStorage.setItem(CHAT_MODEL_KEY, m)
    notifyConfigChange()
  }
  const setAgentPresetIdx = (idx: number) => {
    setAgentPresetIdxState(idx)
    localStorage.setItem(AGENT_PRESET_KEY, String(idx))
    const newModel = DEFAULT_PRESETS[idx]!.config.model
    setAgentModelState(newModel)
    localStorage.setItem(AGENT_MODEL_KEY, newModel)
    notifyConfigChange()
  }
  const setAgentModel = (m: string) => {
    setAgentModelState(m)
    localStorage.setItem(AGENT_MODEL_KEY, m)
    notifyConfigChange()
  }

  const authHeader = () => ({ Authorization: `Basic ${btoa(`qbee:${auth}`)}` })

  useEffect(() => {
    if (savedNote) {
      const t = setTimeout(() => setSavedNote(null), 2000)
      return () => clearTimeout(t)
    }
    return undefined
  }, [savedNote])

  const updateKey = async (ref: string, value: string) => {
    const next = { ...secrets, [ref]: value }
    if (!value) delete next[ref]
    setSecrets(next)
    saveSecrets(next)
    if (value) {
      await fetch('/api/secrets/set', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify({ key: ref, value }),
      })
    } else {
      await fetch(`/api/secrets/${encodeURIComponent(ref)}`, {
        method: 'DELETE',
        headers: authHeader(),
      })
    }
    setSavedNote(value ? `saved ${ref}` : `cleared ${ref}`)
  }

  const clearAll = async () => {
    if (!confirm('Clear all stored API keys?')) return
    for (const ref of Object.keys(secrets)) {
      await fetch(`/api/secrets/${encodeURIComponent(ref)}`, { method: 'DELETE', headers: authHeader() })
    }
    setSecrets({})
    saveSecrets({})
    setSavedNote('cleared all')
  }

  const checkForUpdate = async () => {
    setUpdateChecking(true)
    setUpdateCheck(null)
    setUpdateProgress(null)
    try {
      // currentVersion is best-effort: read from a meta tag the editor host
      // sets, or fall back to '0.0.0'. The editor wires this for v0.5.
      const meta = document.querySelector('meta[name="qbee-version"]') as HTMLMetaElement | null
      const current = meta?.content ?? '0.0.0'
      const res = await fetch(`/api/update/check?current=${encodeURIComponent(current)}`, { headers: authHeader() })
      if (!res.ok) {
        setUpdateCheck({ status: 'error', error: `HTTP ${res.status}` })
        return
      }
      setUpdateCheck((await res.json()) as UpdateCheckResponse)
    } catch (err) {
      setUpdateCheck({ status: 'error', error: (err as Error).message })
    } finally {
      setUpdateChecking(false)
    }
  }

  const applyUpdate = async () => {
    if (!updateCheck || updateCheck.status !== 'available') return
    setUpdateApplying(true)
    setUpdateProgress({ type: 'downloading', receivedBytes: 0, totalBytes: updateCheck.sizeBytes })
    try {
      const res = await fetch('/api/update/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify({ downloadUrl: updateCheck.downloadUrl, sha256Url: updateCheck.sha256Url }),
      })
      if (!res.ok || !res.body) {
        setUpdateProgress({ type: 'error', message: `apply failed: HTTP ${res.status}` })
        return
      }
      // Parse SSE
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let idx
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          for (const line of block.split('\n')) {
            if (line.startsWith('data: ')) {
              try { setUpdateProgress(JSON.parse(line.slice(6)) as UpdateProgressEvent) } catch { /* ignore */ }
            }
          }
        }
      }
    } catch (err) {
      setUpdateProgress({ type: 'error', message: (err as Error).message })
    } finally {
      setUpdateApplying(false)
    }
  }

  const probeLocalModels = async () => {
    setProbing(true)
    try {
      const res = await fetch('/api/local-models/probe', { headers: authHeader() })
      if (res.ok) {
        const body = (await res.json()) as LocalModelsProbeResponse
        setLocalProbe(body)
      } else {
        setLocalProbe({ models: [], hosts: [] })
      }
    } catch {
      setLocalProbe({ models: [], hosts: [] })
    } finally {
      setProbing(false)
    }
  }

  const useLocalModelForChat = (m: LocalModel) => {
    // Route to the preset that matches the source's port. Ollama lives at
    // 11434, LM Studio at 1234, llama.cpp at 8080 — picking preset 0 (Ollama)
    // for an LM Studio model would 404.
    setChatPresetIdx(presetIdxForLocalSource(m.source))
    setChatModel(m.id)
    setSavedNote(`chat → ${labelForSource(m.source)} / ${m.id}`)
  }
  const useLocalModelForAgent = (m: LocalModel) => {
    setAgentPresetIdx(presetIdxForLocalSource(m.source))
    setAgentModel(m.id)
    setSavedNote(`agent → ${labelForSource(m.source)} / ${m.id}`)
  }
  const useLocalModelForEmbedding = (m: LocalModel) => {
    setEmbedBaseUrl(`${m.baseUrl}/v1`)
    setEmbedModel(m.id)
    setSavedNote(`embedding → ${m.id}`)
  }
  const useLocalModelForFim = async (m: LocalModel) => {
    setFimModel(m.id)
    setFimBaseUrl(`${m.baseUrl}/v1`)
    await Promise.all([
      setEditorSetting(FIM_KEY_MODEL, m.id),
      setEditorSetting(FIM_KEY_BASE_URL, `${m.baseUrl}/v1`),
    ])
    setSavedNote(`FIM → ${m.id}`)
  }

  const saveEmbeddingProvider = () => {
    const cfg: ProviderConfig = { id: 'openai-compatible', model: embedModel, ...(embedBaseUrl ? { baseUrl: embedBaseUrl } : {}) }
    setEmbeddingProvider(cfg)
    localStorage.setItem(EMBEDDING_KEY, JSON.stringify(cfg))
    setSavedNote('saved embedding endpoint')
  }

  return (
    <div style={styles.root}>
      <div style={styles.header}>
        <span style={styles.title}>Dashboard</span>
        <span style={styles.flex} />
        {savedNote && <span style={styles.saved}>{savedNote}</span>}
        <button style={styles.closeBtn} onClick={onClose}>Close</button>
      </div>
      <div style={styles.body}>

        <section style={styles.quickActions}>
          <button style={styles.actionBtn} onClick={onStartChat}>💬 Start a chat</button>
          <button style={styles.actionBtn} onClick={onStartAgent}>🤖 Run an agent task</button>
          <button style={styles.actionBtn} onClick={onStartIndex}>🔍 Index workspace (@codebase)</button>
        </section>

        <section style={styles.section}>
          <div style={styles.sectionTitle}>Provider routing</div>
          <div style={styles.sectionHint}>Configure each function independently. Pick one provider for chat, another for the agent, etc. Edits sync immediately to the chat header and agent picker.</div>

          <div style={styles.providerRow}>
            <div style={styles.providerLabel}>Chat</div>
            <select style={styles.providerSelect} value={chatPresetIdx} onChange={(e) => setChatPresetIdx(Number(e.target.value))}>
              {DEFAULT_PRESETS.map((p, i) => (<option key={i} value={i}>{p.label}</option>))}
            </select>
            <input style={styles.providerModel} value={chatModel} onChange={(e) => setChatModel(e.target.value)} placeholder="model" />
          </div>

          <div style={styles.providerRow}>
            <div style={styles.providerLabel}>Agent</div>
            <select style={styles.providerSelect} value={agentPresetIdx} onChange={(e) => setAgentPresetIdx(Number(e.target.value))}>
              {DEFAULT_PRESETS.map((p, i) => (<option key={i} value={i}>{p.label}</option>))}
            </select>
            <input style={styles.providerModel} value={agentModel} onChange={(e) => setAgentModel(e.target.value)} placeholder="model" />
          </div>

          <div style={styles.providerRow}>
            <div style={styles.providerLabel}>Inline FIM</div>
            <input
              style={styles.providerSelect}
              placeholder="baseUrl (http://127.0.0.1:11434/v1)"
              value={fimBaseUrl}
              onChange={(e) => setFimBaseUrl(e.target.value)}
              onBlur={() => updateFimSetting(FIM_KEY_BASE_URL, fimBaseUrl)}
              title="OpenAI-compatible endpoint (Ollama / LM Studio / llama.cpp)"
            />
            <input
              style={styles.providerModel}
              placeholder="model"
              value={fimModel}
              onChange={(e) => setFimModel(e.target.value)}
              onBlur={() => updateFimSetting(FIM_KEY_MODEL, fimModel)}
              title="FIM-capable code model (Qwen, DeepSeek, Codestral, StarCoder)"
            />
          </div>
          {fimEnabled === false && (
            <div style={styles.providerNote}>
              FIM is currently <strong>disabled</strong>.
              <button
                style={{ ...styles.smallBtn, marginLeft: 8 }}
                onClick={() => { setFimEnabled(true); void updateFimSetting(FIM_KEY_ENABLED, true) }}
              >
                Enable
              </button>
            </div>
          )}

          <div style={styles.localModelsBlock}>
            <div style={styles.localModelsHeader}>
              <span style={styles.localModelsTitle}>Local models on your machine</span>
              <button style={styles.detectBtn} onClick={probeLocalModels} disabled={probing}>
                {probing ? 'Probing…' : localProbe ? 'Re-detect' : 'Detect local models'}
              </button>
            </div>
            {localProbe && (
              <>
                {localProbe.hosts.length > 0 && (
                  <div style={styles.localModelsHostStrip}>
                    {localProbe.hosts.map((h) => (
                      <span key={h.source} style={{ ...styles.localModelsHostChip, opacity: h.ok ? 1 : 0.5 }}>
                        {h.ok ? '●' : '○'} {labelForSource(h.source)} {h.ok ? `(${h.modelCount})` : `— ${h.error ?? 'not reachable'}`}
                      </span>
                    ))}
                  </div>
                )}
                {localProbe.models.length === 0 && (
                  <div style={styles.localModelsEmpty}>
                    No local model hosts reachable. Start Ollama, LM Studio, or a llama.cpp server, then click Re-detect.
                  </div>
                )}
                {localProbe.models.map((m, i) => (
                  <div key={i} style={styles.localModelRow}>
                    <span style={styles.localModelSourceTag}>{labelForSource(m.source)}</span>
                    <span style={styles.localModelId} title={m.baseUrl}>{m.id}</span>
                    {m.size && <span style={styles.localModelSize}>{m.size}</span>}
                    <span style={styles.flex} />
                    <button style={styles.smallBtn} onClick={() => useLocalModelForChat(m)} title="Use for chat">→ chat</button>
                    <button style={styles.smallBtn} onClick={() => useLocalModelForAgent(m)} title="Use for agent">→ agent</button>
                    <button style={styles.smallBtn} onClick={() => void useLocalModelForFim(m)} title="Use for inline (FIM) completions. Best with FIM-capable code models (Qwen, DeepSeek, etc.)">→ FIM</button>
                    <button style={styles.smallBtn} onClick={() => useLocalModelForEmbedding(m)} title="Use for embeddings (@codebase). Only meaningful for embedding models like nomic-embed-text.">→ embed</button>
                  </div>
                ))}
              </>
            )}
          </div>
        </section>

        <section style={styles.section}>
          <div style={styles.sectionTitle}>API keys</div>
          <div style={styles.sectionHint}>Stored in your browser's localStorage and pushed to the worker on every load. Cleared if you Clear All or wipe browser data.</div>
          {KNOWN_KEYS.map((k) => (
            <div key={k.ref} style={styles.row}>
              <label style={styles.label}>{k.label}</label>
              <input
                style={styles.input}
                type={revealedKey === k.ref ? 'text' : 'password'}
                value={secrets[k.ref] ?? ''}
                onChange={(e) => updateKey(k.ref, e.target.value)}
                placeholder={k.hint}
                autoComplete="off"
                spellCheck={false}
              />
              <button style={styles.toggleBtn} onClick={() => setRevealedKey(revealedKey === k.ref ? null : k.ref)}>
                {revealedKey === k.ref ? 'hide' : 'show'}
              </button>
            </div>
          ))}
          {Object.keys(secrets).length > 0 && (
            <button style={styles.dangerBtn} onClick={clearAll}>Clear all stored keys</button>
          )}
        </section>

        <section style={styles.section}>
          <div style={styles.sectionTitle}>Embedding endpoint (for @codebase)</div>
          <div style={styles.sectionHint}>OpenAI-compatible. Defaults match Ollama on localhost. LM Studio users: set the model to <code>text-embedding-nomic-embed-text-v1.5</code> and baseUrl to <code>http://127.0.0.1:1234/v1</code>.</div>
          <div style={styles.row}>
            <label style={styles.label}>Base URL</label>
            <input style={styles.input} value={embedBaseUrl} onChange={(e) => setEmbedBaseUrl(e.target.value)} placeholder="http://127.0.0.1:11434/v1" />
          </div>
          <div style={styles.row}>
            <label style={styles.label}>Model</label>
            <input style={styles.input} value={embedModel} onChange={(e) => setEmbedModel(e.target.value)} placeholder="nomic-embed-text" />
          </div>
          <button style={styles.primaryBtn} onClick={saveEmbeddingProvider}>Save embedding endpoint</button>
        </section>

        <section style={styles.section}>
          <div style={styles.sectionTitle}>Updates</div>
          <div style={styles.sectionHint}>
            Check for new QBee releases and (Linux only) download + install in place.
            Other platforms link to the release page.
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button style={styles.primaryBtn} onClick={checkForUpdate} disabled={updateChecking || updateApplying}>
              {updateChecking ? 'Checking…' : 'Check for updates'}
            </button>
            {updateCheck && updateCheck.status === 'up_to_date' && (
              <span style={styles.savedNote}>QBee {updateCheck.current} is up to date.</span>
            )}
            {updateCheck && updateCheck.status === 'available' && (
              <span style={styles.savedNote}>{updateCheck.latest} available — you have {updateCheck.current}.</span>
            )}
            {updateCheck && updateCheck.status === 'unsupported' && (
              <span style={styles.errorNote}>Auto-update not supported here: {updateCheck.reason}.</span>
            )}
            {updateCheck && updateCheck.status === 'error' && (
              <span style={styles.errorNote}>Check failed: {updateCheck.error}</span>
            )}
          </div>
          {updateCheck && updateCheck.status === 'available' && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <button style={styles.primaryBtn} onClick={applyUpdate} disabled={updateApplying}>
                {updateApplying ? 'Installing…' : `Download & install ${updateCheck.latest}`}
              </button>
              <a href={updateCheck.releaseNotesUrl} target="_blank" rel="noopener noreferrer" style={{ color: '#7aa6e0', fontSize: 11 }}>
                Release notes
              </a>
            </div>
          )}
          {updateProgress && (
            <div style={updateProgressBlock}>
              {updateProgress.type === 'downloading' && (
                <span>
                  Downloading… {formatBytes(updateProgress.receivedBytes)}{updateProgress.totalBytes ? ` / ${formatBytes(updateProgress.totalBytes)}` : ''}
                  {updateProgress.totalBytes ? ` (${Math.round(updateProgress.receivedBytes / updateProgress.totalBytes * 100)}%)` : ''}
                </span>
              )}
              {updateProgress.type === 'verifying' && <span>Verifying SHA-256…</span>}
              {updateProgress.type === 'replacing' && <span>Replacing the AppImage in place…</span>}
              {updateProgress.type === 'done' && (
                <span style={{ color: '#9eccaa' }}>
                  ✓ Update installed at {updateProgress.targetPath}. Restart QBee to use it.
                </span>
              )}
              {updateProgress.type === 'error' && (
                <span style={{ color: '#ff9090' }}>✗ {updateProgress.message}</span>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} KB`
  return `${n} B`
}

const updateProgressBlock: React.CSSProperties = {
  fontSize: 11,
  fontFamily: 'monospace',
  padding: '8px 10px',
  background: '#1d2433',
  border: '1px solid #2a3548',
  borderRadius: 4,
  color: '#bcd',
}

function labelForSource(source: string): string {
  switch (source) {
    case 'ollama': return 'Ollama'
    case 'lm-studio': return 'LM Studio'
    case 'llama-cpp': return 'llama.cpp'
    default: return source
  }
}

function readPresetIdx(key: string, fallback: number): number {
  const stored = Number(localStorage.getItem(key) ?? String(fallback))
  return Number.isFinite(stored) && stored >= 0 && stored < DEFAULT_PRESETS.length ? stored : fallback
}
function readModel(key: string, fallback: string): string {
  return localStorage.getItem(key) ?? fallback
}
function notifyConfigChange(): void {
  window.dispatchEvent(new Event(CONFIG_CHANGE_EVENT))
}

const styles: Record<string, React.CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', height: '100%' },
  header: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid #333' },
  title: { fontSize: 14, fontWeight: 600 },
  flex: { flex: 1 },
  saved: { fontSize: 11, color: '#9eccaa' },
  savedNote: { fontSize: 11, color: '#9eccaa' },
  errorNote: { fontSize: 11, color: '#ff9090' },
  closeBtn: { background: 'transparent', border: '1px solid #444', color: '#ddd', padding: '4px 10px', borderRadius: 4, fontSize: 11, cursor: 'pointer' },
  body: { flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 24 },
  quickActions: { display: 'flex', gap: 8, flexWrap: 'wrap' },
  actionBtn: { background: '#262d3a', border: '1px solid #3a4a6a', color: '#dde', padding: '8px 14px', borderRadius: 6, fontSize: 12, cursor: 'pointer', flex: '1 1 auto', textAlign: 'left' as const },
  section: { display: 'flex', flexDirection: 'column', gap: 8 },
  sectionTitle: { fontSize: 13, fontWeight: 600, color: '#ddd' },
  sectionHint: { fontSize: 11, color: '#888', lineHeight: 1.4 },
  providerRow: { display: 'grid', gridTemplateColumns: '70px 1fr 1fr', gap: 8, alignItems: 'center' },
  providerLabel: { fontSize: 11, color: '#aaa', fontWeight: 500 },
  providerSelect: { background: '#2a2a2a', border: '1px solid #444', color: '#ddd', padding: '4px 8px', borderRadius: 4, fontSize: 11 },
  providerModel: { background: '#2a2a2a', border: '1px solid #444', color: '#ddd', padding: '4px 8px', borderRadius: 4, fontSize: 11, fontFamily: 'monospace' },
  providerNote: { fontSize: 11, color: '#888', gridColumn: 'span 2' },
  localModelsBlock: { marginTop: 8, padding: 8, background: '#1d2433', border: '1px solid #2a3548', borderRadius: 4, display: 'flex', flexDirection: 'column', gap: 6 },
  localModelsHeader: { display: 'flex', alignItems: 'center', gap: 8 },
  localModelsTitle: { fontSize: 12, fontWeight: 600, color: '#bcd', flex: 1 },
  detectBtn: { background: '#3a6cd8', border: 'none', color: 'white', padding: '4px 10px', borderRadius: 3, fontSize: 11, cursor: 'pointer' },
  localModelsHostStrip: { display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 10, color: '#7a90b0' },
  localModelsHostChip: { padding: '2px 6px', background: '#2a3548', borderRadius: 3 },
  localModelsEmpty: { fontSize: 11, color: '#888', padding: '4px 0' },
  localModelRow: { display: 'flex', alignItems: 'center', gap: 6, padding: '4px 0', borderTop: '1px dashed #2a3548', fontSize: 11 },
  localModelSourceTag: { fontSize: 9, color: '#7a90b0', textTransform: 'uppercase', letterSpacing: 0.5, minWidth: 60 },
  localModelId: { fontFamily: 'monospace', color: '#dde', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  localModelSize: { fontSize: 10, color: '#888' },
  smallBtn: { background: 'transparent', border: '1px solid #444', color: '#aaa', padding: '2px 6px', borderRadius: 3, fontSize: 10, cursor: 'pointer' },
  row: { display: 'flex', flexDirection: 'column', gap: 4 },
  label: { fontSize: 11, color: '#aaa' },
  input: { background: '#2a2a2a', border: '1px solid #444', color: '#ddd', padding: '6px 8px', borderRadius: 4, fontSize: 12, fontFamily: 'monospace', width: '100%', boxSizing: 'border-box' },
  toggleBtn: { background: 'transparent', border: '1px solid #444', color: '#aaa', padding: '2px 8px', borderRadius: 3, fontSize: 10, cursor: 'pointer', alignSelf: 'flex-end', marginTop: -28, marginRight: 4 },
  primaryBtn: { background: '#3a6cd8', border: 'none', color: 'white', padding: '6px 12px', borderRadius: 4, fontSize: 12, cursor: 'pointer', alignSelf: 'flex-start' },
  dangerBtn: { background: 'transparent', border: '1px solid #6a3a3a', color: '#d97070', padding: '4px 10px', borderRadius: 4, fontSize: 11, cursor: 'pointer', alignSelf: 'flex-start' },
}
