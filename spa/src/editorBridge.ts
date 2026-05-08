// Round-trip helpers for reading and writing editor-side VSCode settings.
// The editor's SettingsBridge handles requests; the relay in qbee.contribution.ts
// forwards messages between this SPA and the editor host.
//
// Whitelisted on the editor side to qbee.* keys.

const REQUEST_TIMEOUT_MS = 3000

let nextRequestId = 1
const pendingRequests = new Map<string, (value: unknown) => void>()
const settingChangeListeners = new Set<(key: string, value: unknown) => void>()

let installed = false
function installListener(): void {
  if (installed) return
  installed = true
  window.addEventListener('message', (e: MessageEvent) => {
    const data = e.data
    if (!data || typeof data !== 'object') return
    if (data.type === 'setting_value' || data.type === 'set_setting_ack') {
      const requestId = (data as { requestId?: string }).requestId
      if (typeof requestId !== 'string') return
      const resolve = pendingRequests.get(requestId)
      if (resolve) {
        pendingRequests.delete(requestId)
        resolve(data)
      }
    } else if (data.type === 'setting_changed') {
      const key = (data as { key?: string }).key
      const value = (data as { value?: unknown }).value
      if (typeof key !== 'string') return
      for (const fn of settingChangeListeners) fn(key, value)
    }
  })
}

function newRequestId(): string {
  return `req-${nextRequestId++}-${Date.now()}`
}

export async function getEditorSetting<T = unknown>(key: string): Promise<T | undefined> {
  installListener()
  const requestId = newRequestId()
  return new Promise<T | undefined>((resolve) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId)
      resolve(undefined)
    }, REQUEST_TIMEOUT_MS)
    pendingRequests.set(requestId, (msg) => {
      clearTimeout(timer)
      resolve((msg as { value?: T }).value)
    })
    window.parent.postMessage({ type: 'get_setting', requestId, key }, '*')
  })
}

export async function setEditorSetting(key: string, value: unknown): Promise<{ ok: boolean; error?: string }> {
  installListener()
  const requestId = newRequestId()
  return new Promise<{ ok: boolean; error?: string }>((resolve) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId)
      resolve({ ok: false, error: 'timeout' })
    }, REQUEST_TIMEOUT_MS)
    pendingRequests.set(requestId, (msg) => {
      clearTimeout(timer)
      const m = msg as { ok?: boolean; error?: string }
      resolve({ ok: !!m.ok, ...(m.error ? { error: m.error } : {}) })
    })
    window.parent.postMessage({ type: 'set_setting', requestId, key, value }, '*')
  })
}

export function onEditorSettingChanged(fn: (key: string, value: unknown) => void): () => void {
  installListener()
  settingChangeListeners.add(fn)
  return () => settingChangeListeners.delete(fn)
}
