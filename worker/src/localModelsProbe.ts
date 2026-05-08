// Probes well-known local LLM hosts on loopback. All probes run in parallel
// with a short per-host timeout — a single unreachable host should never delay
// the response by more than the timeout.
//
// Hosts we probe:
//   - Ollama         http://127.0.0.1:11434       /api/tags
//   - LM Studio      http://127.0.0.1:1234        /v1/models  (OpenAI shape)
//   - llama.cpp      http://127.0.0.1:8080        /v1/models  (OpenAI shape)
//
// llama.cpp's default port collides with a lot of dev servers; absent a server
// it'll either fail-to-connect (clean) or hit something unrelated (we get a
// non-JSON or non-models response and treat it as not-llama.cpp).

import type { LocalModel, LocalModelsProbeResponse, LocalModelSource } from '@qbee/shared'

const TIMEOUT_MS = 1500

type HostSpec = {
  source: LocalModelSource
  baseUrl: string
  endpoint: string
}

const HOSTS: HostSpec[] = [
  { source: 'ollama', baseUrl: 'http://127.0.0.1:11434', endpoint: '/api/tags' },
  { source: 'lm-studio', baseUrl: 'http://127.0.0.1:1234', endpoint: '/v1/models' },
  { source: 'llama-cpp', baseUrl: 'http://127.0.0.1:8080', endpoint: '/v1/models' },
]

export async function probeLocalModels(): Promise<LocalModelsProbeResponse> {
  const results = await Promise.all(HOSTS.map(probeHost))
  const models = results.flatMap((r) => r.models)
  const hosts = results.map((r) => ({ source: r.source, baseUrl: r.baseUrl, ok: r.ok, modelCount: r.models.length, ...(r.error !== undefined ? { error: r.error } : {}) }))
  return { models, hosts }
}

type HostResult = { source: LocalModelSource; baseUrl: string; ok: boolean; models: LocalModel[]; error?: string }

async function probeHost(spec: HostSpec): Promise<HostResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${spec.baseUrl}${spec.endpoint}`, { signal: controller.signal })
    if (!res.ok) {
      return { source: spec.source, baseUrl: spec.baseUrl, ok: false, models: [], error: `HTTP ${res.status}` }
    }
    const body = (await res.json()) as unknown
    const models = parseModels(spec, body)
    return { source: spec.source, baseUrl: spec.baseUrl, ok: true, models }
  } catch (err) {
    return { source: spec.source, baseUrl: spec.baseUrl, ok: false, models: [], error: shortErr(err) }
  } finally {
    clearTimeout(timer)
  }
}

function parseModels(spec: HostSpec, body: unknown): LocalModel[] {
  if (!body || typeof body !== 'object') return []
  if (spec.source === 'ollama') {
    // { models: [{ name, modified_at, size, digest, ... }] }
    const ms = (body as { models?: unknown }).models
    if (!Array.isArray(ms)) return []
    return ms.flatMap((m) => {
      if (!m || typeof m !== 'object') return []
      const name = (m as { name?: unknown }).name
      if (typeof name !== 'string') return []
      const sizeBytes = (m as { size?: unknown }).size
      const size = typeof sizeBytes === 'number' ? humanSize(sizeBytes) : undefined
      return [{ source: spec.source, baseUrl: spec.baseUrl, id: name, ...(size ? { size } : {}) } satisfies LocalModel]
    })
  }
  // OpenAI-shaped: { data: [{ id }] }
  const data = (body as { data?: unknown }).data
  if (!Array.isArray(data)) return []
  return data.flatMap((m) => {
    if (!m || typeof m !== 'object') return []
    const id = (m as { id?: unknown }).id
    if (typeof id !== 'string') return []
    return [{ source: spec.source, baseUrl: spec.baseUrl, id } satisfies LocalModel]
  })
}

function humanSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(0)} KB`
  return `${bytes} B`
}

function shortErr(err: unknown): string {
  if (err instanceof Error) {
    // 'fetch failed' is what undici returns for connection refused; surface
    // a more useful hint.
    if (err.name === 'AbortError') return 'timeout'
    return err.message
  }
  return String(err)
}
