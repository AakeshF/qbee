import { z } from 'zod'

// ─────────────────────────── Echo (Phase 1 hello-world) ──────────

export const EchoRequest = z.object({
  text: z.string(),
})
export type EchoRequest = z.infer<typeof EchoRequest>

// SSE events for echo: stream the input back word-by-word, then done.
export const EchoEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('chunk'), value: z.string() }),
  z.object({ type: z.literal('done') }),
  z.object({ type: z.literal('error'), message: z.string() }),
])
export type EchoEvent = z.infer<typeof EchoEvent>

// Worker → editor handshake on stdout: first line, JSON.
export const WorkerReady = z.object({
  type: z.literal('ready'),
  port: z.number().int().positive(),
})
export type WorkerReady = z.infer<typeof WorkerReady>

// ─────────────────────────── Providers ───────────────────────────

export const ProviderId = z.enum(['openai-compatible', 'anthropic', 'gemini', 'local-llama'])
export type ProviderId = z.infer<typeof ProviderId>

export const ProviderConfig = z.object({
  id: ProviderId,
  baseUrl: z.string().url().optional(),
  model: z.string(),
  apiKeyRef: z.string().optional(), // SecretStorage key name, never the key itself
})
export type ProviderConfig = z.infer<typeof ProviderConfig>

// ─────────────────────────── Editor context ─────────────────────
//
// Snapshot of what the user is currently looking at. Pushed from the editor
// host to the SPA via postMessage; SPA includes it in /api/chat and
// /api/agent/run requests so the model knows what file is active without
// the user having to type @file: mentions.

export const EditorContext = z.object({
  // Workspace-relative path. Absent when no editor is focused (welcome page,
  // settings, etc.).
  activeFile: z.string().optional(),
  // Inclusive line range; both 0-based.
  selection: z
    .object({
      startLine: z.number().int().nonnegative(),
      endLine: z.number().int().nonnegative(),
      text: z.string(),
    })
    .optional(),
  // 0-based line of the primary cursor.
  cursorLine: z.number().int().nonnegative().optional(),
  // Workspace-relative paths of all open editors (deduped, max ~20).
  openFiles: z.array(z.string()).max(50).optional(),
})
export type EditorContext = z.infer<typeof EditorContext>

// ─────────────────────────── Chat ────────────────────────────────

export const ChatRole = z.enum(['system', 'user', 'assistant', 'tool'])
export type ChatRole = z.infer<typeof ChatRole>

export const ChatMessage = z.object({
  role: ChatRole,
  content: z.string(),
  toolCallId: z.string().optional(),
  toolCalls: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        input: z.unknown(),
      }),
    )
    .optional(),
})
export type ChatMessage = z.infer<typeof ChatMessage>

export const ChatRequest = z.object({
  provider: ProviderConfig,
  messages: z.array(ChatMessage),
  tools: z.array(z.unknown()).optional(),
  maxTokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  editorContext: EditorContext.optional(),
})
export type ChatRequest = z.infer<typeof ChatRequest>

// SSE event types streamed back to the SPA. tool_use is consolidated by the
// provider — input is accumulated from JSON deltas and parsed once the block closes.
export const ChatEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), value: z.string() }),
  z.object({ type: z.literal('tool_use'), id: z.string(), name: z.string(), input: z.unknown() }),
  z.object({ type: z.literal('usage'), inputTokens: z.number(), outputTokens: z.number() }),
  z.object({ type: z.literal('error'), message: z.string() }),
  z.object({ type: z.literal('done'), stopReason: z.enum(['end_turn', 'tool_use', 'max_tokens', 'stop_sequence', 'unknown']).optional() }),
])
export type ChatEvent = z.infer<typeof ChatEvent>

// ─────────────────────────── Agent ───────────────────────────────

export const AgentRunRequest = z.object({
  provider: ProviderConfig,
  messages: z.array(ChatMessage),
  workspaceRoot: z.string(),
  maxIterations: z.number().int().positive().max(50).default(20),
  editorContext: EditorContext.optional(),
})
export type AgentRunRequest = z.infer<typeof AgentRunRequest>

// SSE events streamed back during a /api/agent/run.
// `file_diff` is a proposed write — no disk change happens until the editor applies it.
export const AgentEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), value: z.string() }),
  z.object({ type: z.literal('tool_use'), id: z.string(), name: z.string(), input: z.unknown() }),
  z.object({ type: z.literal('tool_result'), id: z.string(), name: z.string(), summary: z.string(), isError: z.boolean().optional() }),
  z.object({ type: z.literal('file_diff'), path: z.string(), unifiedDiff: z.string(), oldContent: z.string(), newContent: z.string() }),
  z.object({ type: z.literal('iteration'), index: z.number().int().nonnegative() }),
  z.object({ type: z.literal('error'), message: z.string() }),
  z.object({ type: z.literal('done'), reason: z.enum(['end_turn', 'max_iterations', 'cancelled']) }),
])
export type AgentEvent = z.infer<typeof AgentEvent>

// ─────────────────────────── Completion (FIM) ────────────────────

export const CompleteRequest = z.object({
  provider: ProviderConfig,
  prefix: z.string(),
  suffix: z.string(),
  language: z.string(),
  filePath: z.string(),
  maxTokens: z.number().int().positive().default(128),
})
export type CompleteRequest = z.infer<typeof CompleteRequest>

export const CompleteResponse = z.object({
  text: z.string(),
})
export type CompleteResponse = z.infer<typeof CompleteResponse>

// ─────────────────────────── FS read (for @file mention) ─────────

export const FsReadRequest = z.object({
  workspaceRoot: z.string(),
  path: z.string(),
  maxBytes: z.number().int().positive().max(1024 * 1024).default(64 * 1024),
})
export type FsReadRequest = z.infer<typeof FsReadRequest>

export const FsReadResponse = z.object({
  path: z.string(),
  content: z.string(),
  truncated: z.boolean(),
  bytes: z.number().int().nonnegative(),
})
export type FsReadResponse = z.infer<typeof FsReadResponse>

// ─────────────────────────── Embeddings ──────────────────────────

export const EmbedRequest = z.object({
  provider: ProviderConfig,
  texts: z.array(z.string()).min(1).max(256),
})
export type EmbedRequest = z.infer<typeof EmbedRequest>

export const EmbedResponse = z.object({
  vectors: z.array(z.array(z.number())),
  dim: z.number().int().positive(),
})
export type EmbedResponse = z.infer<typeof EmbedResponse>

// ─────────────────────────── Local model probe ──────────────────
//
// Probes common local LLM hosts (Ollama, LM Studio, llama.cpp server) on
// loopback so the dashboard can offer "pick a model" instead of "type a
// model name". Results are best-effort; an unreachable host just contributes
// no entries.

export const LocalModelSource = z.enum(['ollama', 'lm-studio', 'llama-cpp'])
export type LocalModelSource = z.infer<typeof LocalModelSource>

export const LocalModel = z.object({
  source: LocalModelSource,
  baseUrl: z.string(),
  // The model id the user types into the chat 'model' field. For Ollama this
  // includes the tag suffix ("qwen2.5-coder:7b"); for OpenAI-shaped servers
  // it's the id field on /v1/models.
  id: z.string(),
  // Optional human-readable size label ("4.4 GB"); only Ollama exposes this.
  size: z.string().optional(),
})
export type LocalModel = z.infer<typeof LocalModel>

export const LocalModelsProbeResponse = z.object({
  models: z.array(LocalModel),
  // Per-host status so the dashboard can say "Ollama not reachable at
  // 127.0.0.1:11434" instead of silently dropping it.
  hosts: z.array(z.object({
    source: LocalModelSource,
    baseUrl: z.string(),
    ok: z.boolean(),
    error: z.string().optional(),
    modelCount: z.number().int().nonnegative(),
  })),
})
export type LocalModelsProbeResponse = z.infer<typeof LocalModelsProbeResponse>

// ─────────────────────────── RAG ─────────────────────────────────

export const RagIndexRequest = z.object({
  workspaceRoot: z.string(),
  embeddingProvider: ProviderConfig,
})
export type RagIndexRequest = z.infer<typeof RagIndexRequest>

export const RagIndexEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('walking') }),
  z.object({ type: z.literal('discovered'), count: z.number() }),
  z.object({ type: z.literal('file'), path: z.string(), index: z.number(), total: z.number() }),
  z.object({ type: z.literal('embedded'), chunkCount: z.number() }),
  z.object({ type: z.literal('done'), files: z.number(), chunks: z.number(), tookMs: z.number() }),
  z.object({ type: z.literal('error'), message: z.string() }),
])
export type RagIndexEvent = z.infer<typeof RagIndexEvent>

export const RagSearchRequest = z.object({
  workspaceRoot: z.string(),
  embeddingProvider: ProviderConfig,
  query: z.string(),
  topK: z.number().int().positive().default(20),
})
export type RagSearchRequest = z.infer<typeof RagSearchRequest>

export const RagChunk = z.object({
  filePath: z.string(),
  startLine: z.number().int().nonnegative(),
  endLine: z.number().int().nonnegative(),
  content: z.string(),
  score: z.number(),
})
export type RagChunk = z.infer<typeof RagChunk>

export const RagSearchResponse = z.object({
  chunks: z.array(RagChunk),
})
export type RagSearchResponse = z.infer<typeof RagSearchResponse>

export const RagStatusResponse = z.object({
  workspaceRoot: z.string(),
  filesIndexed: z.number(),
  chunks: z.number(),
  embeddingDim: z.number().nullable(),
  lastIndexed: z.number().nullable(),
})
export type RagStatusResponse = z.infer<typeof RagStatusResponse>
