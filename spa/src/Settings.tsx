// Settings panel: API keys + RAG embedding endpoint. Keys persist via
// localStorage (plaintext on the user's machine — same threat model as a
// browser-stored token). On every load, the SPA pushes them to the worker
// via /api/secrets/set so /api/chat etc. can find them.
//
// v0.4 will replace localStorage with editor-side SecretStorage via the
// existing postMessage bridge.

import { useEffect, useState } from 'react'
import type { ProviderConfig } from '@qbee/shared'

const STORAGE_KEY = 'qbee.secrets.v1'
const EMBEDDING_KEY = 'qbee.embeddingProvider.v1'

type SecretMap = Record<string, string>

export type SettingsProps = {
  auth: string
  embeddingProvider: ProviderConfig
  setEmbeddingProvider: (cfg: ProviderConfig) => void
  onClose: () => void
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

export function Settings({ auth, embeddingProvider, setEmbeddingProvider, onClose }: SettingsProps) {
  const [secrets, setSecrets] = useState<SecretMap>(() => loadSecrets())
  const [revealedKey, setRevealedKey] = useState<string | null>(null)
  const [embedBaseUrl, setEmbedBaseUrl] = useState(embeddingProvider.baseUrl ?? '')
  const [embedModel, setEmbedModel] = useState(embeddingProvider.model)
  const [savedNote, setSavedNote] = useState<string | null>(null)

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

  const saveEmbeddingProvider = () => {
    const cfg: ProviderConfig = { id: 'openai-compatible', model: embedModel, ...(embedBaseUrl ? { baseUrl: embedBaseUrl } : {}) }
    setEmbeddingProvider(cfg)
    localStorage.setItem(EMBEDDING_KEY, JSON.stringify(cfg))
    setSavedNote('saved embedding endpoint')
  }

  return (
    <div style={styles.root}>
      <div style={styles.header}>
        <span style={styles.title}>Settings</span>
        <span style={styles.flex} />
        {savedNote && <span style={styles.saved}>{savedNote}</span>}
        <button style={styles.closeBtn} onClick={onClose}>Close</button>
      </div>
      <div style={styles.body}>
        <section style={styles.section}>
          <div style={styles.sectionTitle}>API keys</div>
          <div style={styles.sectionHint}>Stored in your browser's localStorage and pushed to the worker. Cleared if you Clear All or wipe browser data. v0.4 moves these to the editor's SecretStorage.</div>
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
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', height: '100%' },
  header: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid #333' },
  title: { fontSize: 14, fontWeight: 600 },
  flex: { flex: 1 },
  saved: { fontSize: 11, color: '#9eccaa' },
  closeBtn: { background: 'transparent', border: '1px solid #444', color: '#ddd', padding: '4px 10px', borderRadius: 4, fontSize: 11, cursor: 'pointer' },
  body: { flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 24 },
  section: { display: 'flex', flexDirection: 'column', gap: 8 },
  sectionTitle: { fontSize: 13, fontWeight: 600, color: '#ddd' },
  sectionHint: { fontSize: 11, color: '#888', lineHeight: 1.4 },
  row: { display: 'flex', flexDirection: 'column', gap: 4 },
  label: { fontSize: 11, color: '#aaa' },
  input: { background: '#2a2a2a', border: '1px solid #444', color: '#ddd', padding: '6px 8px', borderRadius: 4, fontSize: 12, fontFamily: 'monospace', width: '100%', boxSizing: 'border-box' },
  toggleBtn: { background: 'transparent', border: '1px solid #444', color: '#aaa', padding: '2px 8px', borderRadius: 3, fontSize: 10, cursor: 'pointer', alignSelf: 'flex-end', marginTop: -28, marginRight: 4 },
  primaryBtn: { background: '#3a6cd8', border: 'none', color: 'white', padding: '6px 12px', borderRadius: 4, fontSize: 12, cursor: 'pointer', alignSelf: 'flex-start' },
  dangerBtn: { background: 'transparent', border: '1px solid #6a3a3a', color: '#d97070', padding: '4px 10px', borderRadius: 4, fontSize: 11, cursor: 'pointer', alignSelf: 'flex-start' },
}
