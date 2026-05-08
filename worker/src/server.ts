// QBee worker — HTTP entry point. Self-contained: serves the SPA at / and the API at /api/*.
// Standalone dev default is 8421 to match Vite's proxy in spa/vite.config.ts.
// Production AppImage path: AppRun spawns this with QBEE_WORKER_PORT/AUTH set and
// QBEE_SPA_DIST pointing at the bundled SPA build, then launches the editor pointed
// at http://127.0.0.1:${port}.

import path from 'node:path'
import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { promises as fs } from 'node:fs'
import { AgentRunRequest, ApproveToolRequest, ChatRequest, CompleteRequest, EchoRequest, FsReadRequest, RagIndexRequest, RagSearchRequest, type AgentEvent, type ChatEvent, type EchoEvent, type FsReadResponse, type RagIndexEvent, type RagSearchResponse, type RagStatusResponse } from '@qbee/shared'
import { createProvider } from './providers/index.js'
import { runAgent } from './agent/loop.js'
import { indexWorkspace } from './rag/indexer.js'
import { retrieve } from './rag/retriever.js'
import { RagStore } from './rag/store.js'
import { RagWatcher } from './rag/watcher.js'
import { formatEditorContext } from './editorContext.js'
import { probeLocalModels } from './localModelsProbe.js'

const REQUESTED_PORT = Number(process.env.QBEE_WORKER_PORT ?? 8421)
const AUTH = process.env.QBEE_WORKER_AUTH ?? 'dev'
const SPA_DIST = process.env.QBEE_SPA_DIST ? path.resolve(process.env.QBEE_SPA_DIST) : null

const app = Fastify({ logger: { level: process.env.QBEE_LOG_LEVEL ?? 'info' } })

app.addHook('onRequest', async (req, reply) => {
  // Auth gate ONLY fires for /api/* (except /api/health, reachable for liveness probes).
  if (!req.url.startsWith('/api/') || req.url === '/api/health') return
  const header = req.headers.authorization
  if (!header || !header.startsWith('Basic ')) {
    reply.code(401).send({ error: 'unauthorized' })
    return
  }
  const [, pass] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':')
  if (pass !== AUTH) {
    reply.code(401).send({ error: 'unauthorized' })
  }
})

app.get('/api/health', async () => ({ ok: true }))

// FS read for @file mentions. Same workspace-root sandbox as the agent tools:
// any path that resolves outside workspaceRoot is rejected.
app.post('/api/fs/read', async (req, reply) => {
  const parsed = FsReadRequest.safeParse(req.body)
  if (!parsed.success) {
    reply.code(400).send({ error: parsed.error.message })
    return
  }
  const { workspaceRoot, path: relPath, maxBytes } = parsed.data
  const path = await import('node:path')
  const root = path.resolve(workspaceRoot)
  const target = path.resolve(root, relPath)
  if (target !== root && !target.startsWith(root + path.sep)) {
    reply.code(400).send({ error: `path '${relPath}' resolves outside the workspace` })
    return
  }
  try {
    const stat = await fs.stat(target)
    const bytes = stat.size
    const fh = await fs.open(target, 'r')
    try {
      const buf = Buffer.alloc(Math.min(bytes, maxBytes))
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
      const content = buf.subarray(0, bytesRead).toString('utf8')
      const response: FsReadResponse = { path: relPath, content, truncated: bytes > maxBytes, bytes }
      reply.send(response)
    } finally {
      await fh.close()
    }
  } catch (err) {
    reply.code(404).send({ error: (err as Error).message })
  }
})

app.post('/api/echo', async (req, reply) => {
  const parsed = EchoRequest.safeParse(req.body)
  if (!parsed.success) {
    reply.code(400).send({ error: parsed.error.message })
    return
  }
  const { text } = parsed.data
  app.log.info({ text }, 'echo: received')

  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  const send = (e: EchoEvent) => reply.raw.write(`data: ${JSON.stringify(e)}\n\n`)

  // Stream the echo word-by-word so the SPA visibly sees a stream.
  const words = text.split(/(\s+)/)
  for (const w of words) {
    send({ type: 'chunk', value: w })
    await new Promise((r) => setTimeout(r, 30))
  }
  send({ type: 'done' })
  reply.raw.end()
})

// In-memory secret store. SPA pushes API keys via /api/secrets/set; worker
// reads them on every provider call. Persistence is the SPA's responsibility
// (localStorage today; SecretStorage RPC in v0.4). On worker restart, secrets
// must be re-pushed — the SPA does this on first /api/health success.
const secrets = new Map<string, string>()
const getApiKey = async (ref: string): Promise<string | undefined> => secrets.get(ref) ?? process.env[ref]
// Alias kept for the existing call sites that already passed this name.
const getApiKeyFromEnv = getApiKey

app.post('/api/secrets/set', async (req, reply) => {
  const body = req.body as { key?: unknown; value?: unknown }
  if (typeof body?.key !== 'string' || typeof body?.value !== 'string') {
    reply.code(400).send({ error: 'expected { key: string, value: string }' })
    return
  }
  secrets.set(body.key, body.value)
  reply.send({ ok: true, keys: Array.from(secrets.keys()) })
})

app.delete('/api/secrets/:key', async (req, reply) => {
  const { key } = req.params as { key: string }
  secrets.delete(key)
  reply.send({ ok: true, keys: Array.from(secrets.keys()) })
})

app.get('/api/secrets', async () => ({ keys: Array.from(secrets.keys()) }))

// Probe loopback for running local-model hosts (Ollama / LM Studio /
// llama.cpp). Used by the dashboard's "Detect local models" button.
app.get('/api/local-models/probe', async () => {
  return await probeLocalModels()
})

app.post('/api/chat', async (req, reply) => {
  const parsed = ChatRequest.safeParse(req.body)
  if (!parsed.success) {
    reply.code(400).send({ error: parsed.error.message })
    return
  }
  const { provider: providerConfig, messages, maxTokens, temperature, editorContext } = parsed.data
  app.log.info({ provider: providerConfig.id, model: providerConfig.model, messages: messages.length, hasEditorContext: editorContext !== undefined }, 'chat: starting')

  // If the editor pushed context (active file / selection / open tabs), prepend
  // it as a system message so the model knows what the user is currently looking
  // at without them having to type @file: mentions.
  const editorContextBlock = formatEditorContext(editorContext)
  const augmentedMessages = editorContextBlock
    ? [{ role: 'system' as const, content: editorContextBlock }, ...messages]
    : messages

  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  const send = (e: ChatEvent) => reply.raw.write(`data: ${JSON.stringify(e)}\n\n`)

  const ac = new AbortController()
  // Cancel the upstream provider if the SPA disconnects mid-stream.
  // Listen on reply.raw — req.raw 'close' fires the moment curl finishes uploading
  // the request body, which would abort before we ever start streaming.
  reply.raw.on('close', () => {
    if (!reply.raw.writableEnded) ac.abort()
  })

  try {
    const provider = createProvider(providerConfig, getApiKeyFromEnv)
    for await (const evt of provider.chat({
      messages: augmentedMessages,
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
      signal: ac.signal,
    })) {
      app.log.debug({ evt }, 'chat: event')
      send(evt)
      if (evt.type === 'done' || evt.type === 'error') break
    }
  } catch (err) {
    send({ type: 'error', message: (err as Error).message })
  } finally {
    if (!reply.raw.writableEnded) reply.raw.end()
  }
})

// Non-streaming FIM completion. The InlineCompletionItemProvider in the editor
// wants a single Promise<string>, not a stream — collecting server-side is simpler
// than reassembling on the renderer.
app.post('/api/complete', async (req, reply) => {
  const parsed = CompleteRequest.safeParse(req.body)
  if (!parsed.success) {
    reply.code(400).send({ error: parsed.error.message })
    return
  }
  const { provider: providerConfig, prefix, suffix, language, filePath, maxTokens } = parsed.data

  // Cap completion at a few lines — let the user trigger more if they want the full function.
  const MAX_LINES = 6

  const ac = new AbortController()
  reply.raw.on('close', () => {
    if (!reply.raw.writableEnded) ac.abort()
  })

  try {
    const provider = createProvider(providerConfig, getApiKeyFromEnv)
    let text = ''
    for await (const chunk of provider.complete({
      prefix,
      suffix,
      language,
      maxTokens,
      signal: ac.signal,
    })) {
      text += chunk
      // Stop early once we have enough lines. The provider's `stop` tokens take care of FIM markers.
      if (text.split('\n').length > MAX_LINES) break
    }

    // Trim to MAX_LINES so we never return a runaway completion.
    text = text.split('\n').slice(0, MAX_LINES).join('\n')

    app.log.info({ provider: providerConfig.id, model: providerConfig.model, language, filePath, len: text.length }, 'complete: done')
    reply.send({ text })
  } catch (err) {
    app.log.warn({ err: (err as Error).message }, 'complete: failed')
    reply.code(500).send({ error: (err as Error).message })
  }
})

// Pending tool-approval requests, keyed by approvalId. The agent loop's
// requestApproval callback awaits the resolver; POST /api/agent/approve
// invokes it. Lives in process memory — a worker restart cancels in-flight runs
// anyway, so persistence isn't useful.
const pendingApprovals = new Map<string, (approved: boolean) => void>()

function approvalId(): string {
  return `appr-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

app.post('/api/agent/run', async (req, reply) => {
  const parsed = AgentRunRequest.safeParse(req.body)
  if (!parsed.success) {
    reply.code(400).send({ error: parsed.error.message })
    return
  }
  const { provider: providerConfig, messages, workspaceRoot, maxIterations, editorContext } = parsed.data
  app.log.info({ provider: providerConfig.id, model: providerConfig.model, workspaceRoot, messages: messages.length, hasEditorContext: editorContext !== undefined }, 'agent: starting')

  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  const send = (e: AgentEvent) => reply.raw.write(`data: ${JSON.stringify(e)}\n\n`)

  const ac = new AbortController()
  // Track approvalIds raised by THIS run so we can cancel them on disconnect.
  const ownedApprovalIds = new Set<string>()
  reply.raw.on('close', () => {
    if (!reply.raw.writableEnded) ac.abort()
    // Resolve any orphan approvals as denied so the agent loop unblocks.
    for (const id of ownedApprovalIds) {
      const fn = pendingApprovals.get(id)
      if (fn) { pendingApprovals.delete(id); fn(false) }
    }
  })

  // Approval bridge: yield awaiting_approval, wait for /api/agent/approve to
  // resolve. The agent's tool handler holds the await; SSE push is from this
  // closure since the generator can't synchronously emit while awaiting.
  const requestApproval = (req2: { tool: string; command: string; cwd?: string }): Promise<{ approved: boolean }> => {
    const id = approvalId()
    ownedApprovalIds.add(id)
    return new Promise<{ approved: boolean }>((resolve) => {
      pendingApprovals.set(id, (approved) => {
        ownedApprovalIds.delete(id)
        resolve({ approved })
      })
      send({ type: 'awaiting_approval', approvalId: id, tool: req2.tool, command: req2.command, ...(req2.cwd !== undefined ? { cwd: req2.cwd } : {}) })
    })
  }

  try {
    for await (const evt of runAgent({
      providerConfig,
      initialMessages: messages,
      workspaceRoot,
      maxIterations,
      signal: ac.signal,
      getApiKey: getApiKeyFromEnv,
      requestApproval,
      ...(editorContext !== undefined ? { editorContext } : {}),
    })) {
      send(evt)
      if (evt.type === 'done' || evt.type === 'error') break
    }
  } catch (err) {
    send({ type: 'error', message: (err as Error).message })
  } finally {
    if (!reply.raw.writableEnded) reply.raw.end()
  }
})

// Approve or deny a pending run_terminal command. The SPA POSTs here in
// response to an awaiting_approval event. Idempotent: resolving twice is a
// no-op because the resolver is removed on first call.
app.post('/api/agent/approve', async (req, reply) => {
  const parsed = ApproveToolRequest.safeParse(req.body)
  if (!parsed.success) {
    reply.code(400).send({ error: parsed.error.message })
    return
  }
  const { approvalId: id, approved } = parsed.data
  const resolver = pendingApprovals.get(id)
  if (!resolver) {
    reply.code(404).send({ error: 'approval not found or already resolved' })
    return
  }
  pendingApprovals.delete(id)
  resolver(approved)
  reply.send({ ok: true })
})

// Per-workspace RAG store cache. Each workspace has one .qbee/index.sqlite, and we
// keep the connection open across requests instead of reopening on every search.
const ragStores = new Map<string, RagStore>()
// Per-workspace incremental watchers. One per (workspaceRoot, dim) to mirror the store cache.
const ragWatchers = new Map<string, RagWatcher>()

async function getRagStore(workspaceRoot: string, dim: number): Promise<RagStore> {
  const key = `${workspaceRoot}:${dim}`
  let store = ragStores.get(key)
  if (!store) {
    store = new RagStore(workspaceRoot, dim)
    ragStores.set(key, store)
  }
  return store
}

// Probe the embedding provider once to learn its output dim before opening the store.
async function probeEmbeddingDim(providerConfig: import('@qbee/shared').ProviderConfig): Promise<number> {
  const provider = createProvider(providerConfig, getApiKeyFromEnv)
  const result = await provider.embed(['probe'])
  return result.dim
}

app.post('/api/rag/index', async (req, reply) => {
  const parsed = RagIndexRequest.safeParse(req.body)
  if (!parsed.success) {
    reply.code(400).send({ error: parsed.error.message })
    return
  }
  const { workspaceRoot, embeddingProvider: embedProviderConfig } = parsed.data
  app.log.info({ workspaceRoot, model: embedProviderConfig.model }, 'rag: index starting')

  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  const send = (e: RagIndexEvent) => reply.raw.write(`data: ${JSON.stringify(e)}\n\n`)

  const ac = new AbortController()
  reply.raw.on('close', () => {
    if (!reply.raw.writableEnded) ac.abort()
  })

  try {
    const dim = await probeEmbeddingDim(embedProviderConfig)
    const store = await getRagStore(workspaceRoot, dim)
    // If the embedding model changed (different dim), wipe and rebuild.
    if (Number(store.getMeta('dim')) !== dim) store.resetForDim(dim)
    store.setMeta('embeddingProviderId', embedProviderConfig.id)
    store.setMeta('embeddingModel', embedProviderConfig.model)

    const provider = createProvider(embedProviderConfig, getApiKeyFromEnv)
    let indexedOk = false
    for await (const evt of indexWorkspace({
      workspaceRoot,
      store,
      embeddingProvider: provider,
      embeddingDim: dim,
      signal: ac.signal,
    })) {
      send(evt)
      if (evt.type === 'done') indexedOk = true
      if (evt.type === 'done' || evt.type === 'error') break
    }
    // Auto-start the incremental watcher once the initial pass succeeds.
    if (indexedOk) {
      const key = `${workspaceRoot}:${dim}`
      if (!ragWatchers.has(key)) {
        const watcher = new RagWatcher({
          workspaceRoot,
          store,
          embeddingProvider: provider,
          embeddingDim: dim,
          log: (msg, data) => app.log.info(data ?? {}, msg),
        })
        await watcher.start()
        ragWatchers.set(key, watcher)
      }
    }
  } catch (err) {
    send({ type: 'error', message: (err as Error).message })
  } finally {
    if (!reply.raw.writableEnded) reply.raw.end()
  }
})

app.post('/api/rag/search', async (req, reply) => {
  const parsed = RagSearchRequest.safeParse(req.body)
  if (!parsed.success) {
    reply.code(400).send({ error: parsed.error.message })
    return
  }
  const { workspaceRoot, embeddingProvider: embedProviderConfig, query, topK } = parsed.data
  try {
    const dim = await probeEmbeddingDim(embedProviderConfig)
    const store = await getRagStore(workspaceRoot, dim)
    const provider = createProvider(embedProviderConfig, getApiKeyFromEnv)
    const hits = await retrieve({ store, embeddingProvider: provider, query, topK })
    const response: RagSearchResponse = {
      chunks: hits.map((h) => ({ filePath: h.filePath, startLine: h.startLine, endLine: h.endLine, content: h.content, score: h.score })),
    }
    reply.send(response)
  } catch (err) {
    reply.code(500).send({ error: (err as Error).message })
  }
})

app.get('/api/rag/status', async (req, reply) => {
  const workspaceRoot = (req.query as { workspaceRoot?: string }).workspaceRoot
  if (!workspaceRoot) {
    reply.code(400).send({ error: 'workspaceRoot query param required' })
    return
  }
  // Find any open store for this workspace (regardless of dim).
  let store: RagStore | undefined
  for (const [key, s] of ragStores) {
    if (key.startsWith(`${workspaceRoot}:`)) {
      store = s
      break
    }
  }
  const response: RagStatusResponse = {
    workspaceRoot,
    filesIndexed: store?.filesIndexed() ?? 0,
    chunks: store?.totalChunks() ?? 0,
    embeddingDim: store ? Number(store.getMeta('dim') ?? 0) : null,
    lastIndexed: store ? Number(store.getMeta('lastIndexed') ?? 0) || null : null,
  }
  reply.send(response)
})

const start = async () => {
  try {
    if (SPA_DIST) {
      // SPA serves at /, no auth (the iframe loads without auth; auth is read from
      // the URL fragment and used on /api/* calls). Plugin order matters: register
      // before the listen call.
      await app.register(fastifyStatic, { root: SPA_DIST, prefix: '/', decorateReply: false })
      app.log.info({ spaDist: SPA_DIST }, 'serving SPA from disk')
    }
    const address = await app.listen({ host: '127.0.0.1', port: REQUESTED_PORT })
    const port = Number(new URL(address).port)
    // Handshake: workerManager parses this single JSON line from stdout to discover the port.
    process.stdout.write(`${JSON.stringify({ type: 'ready', port })}\n`)
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}

const shutdown = async () => {
  app.log.info('shutting down')
  await app.close()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

start()
