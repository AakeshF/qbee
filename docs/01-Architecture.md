# 01 — Architecture

## Three-process split

```
┌─────────────────────────────┐    ┌───────────────────────────┐    ┌─────────────────────┐
│  editor/  (VSCode fork)     │    │  spa/  (React+Vite)       │    │  worker/  (Node)    │
│  Electron renderer +        │◄──►│  Loaded into a sidebar    │◄──►│  Provider adapters, │
│  workbench                  │ifr │  iframe via Electron-main │loop│  agent loop, RAG    │
│                             │ame │  loopback HTTP proxy      │back│  (sqlite-vec)       │
│  • InlineCompletionProvider │    │                           │HTTP│                     │
│  • WorkspaceEdit (diffs)    │    │  • Chat UI                │    │  • OpenAI-compatible│
│  • SecretStorage (API keys) │    │  • Settings / model picker│    │  • Anthropic        │
│  • IDiffEditor (agent UI)   │    │  • Diff approval UI       │    │  • Gemini           │
│  • Sidebar view container   │    │  • postMessage RPC        │    │  • Tree-sitter chunk│
└─────────────────────────────┘    └───────────────────────────┘    └─────────────────────┘
       │                                       ▲                            ▲
       │ child_process.spawn                   │  HTTP /api/* (proxied)     │
       └───────────────────────────────────────┴────────────────────────────┘
```

## Why three processes

| Concern | Solved by |
|---|---|
| Cheap upstream rebases | Fork-only code restricted to `editor/src/vs/workbench/contrib/qbee/` and `editor/product.json`. Everything else lives outside `editor/`. |
| Iterating on AI UI without rebuilding the editor | `spa/` runs standalone via `vite dev`, against a stub or real worker. |
| Worker crashes don't take down the editor | Worker is a child process. Editor restarts it on exit. |
| Testing AI logic without an editor | Worker is plain Node + HTTP. `vitest` covers it directly. |
| Browser-grade isolation for the AI UI | SPA loads from a real `http://127.0.0.1:<port>` origin via the loopback proxy — full CSP isolation, no webview quirks. |

## Loopback HTTP proxy

The Electron-main process runs an HTTP server on `127.0.0.1:<random-port>` with HTTP Basic auth. It does two things:
1. Serves the vendored SPA bundle (`spa-dist/`) at `/`
2. Reverse-proxies `/api/*` to the worker's port

The renderer loads the sidebar iframe from `http://127.0.0.1:<port>/<base64(workspace-id)>`. This gives the SPA a real origin — sessions, fetch, file drops, all behave like a normal web app.

Random port + Basic auth ensures other apps on the box can't reach the worker.

## Worker IPC

The worker exposes:
- `POST /api/chat` — streaming chat with optional tool use (SSE)
- `POST /api/complete` — FIM completion (SSE, fast path)
- `POST /api/embed` — batch embeddings
- `POST /api/agent/run` — agent loop (SSE; emits tool-call events for diff approval)
- `POST /api/rag/index` — kick a re-index
- `GET /api/rag/search?q=...` — query
- Plus a control channel from the editor: `POST /api/fs/read`, `POST /api/fs/list`, `POST /api/edits/apply` (worker → editor RPC over the same proxy in reverse)

All schemas live in `shared/src/api.ts` (Zod).

## Provider abstraction

```ts
interface Provider {
  chat(messages, tools?, signal): AsyncIterable<ChatChunk>
  complete(prefix, suffix, signal): AsyncIterable<string>  // FIM
  embed(texts): Promise<number[][]>
}
```

Adapters live in `worker/src/providers/{openai,anthropic,gemini}.ts`. Add a new provider = add one file + register it.

## RAG

- `better-sqlite3` + `sqlite-vec` extension, single `.qbee/index.sqlite` per workspace
- Tree-sitter chunking (function/class granularity per language; fixed-window fallback)
- Embeddings via `Provider.embed()` (default: local `nomic-embed-text` via Ollama)
- `chokidar` watches workspace, re-embeds changed chunks only
- Hybrid retrieval: vector + BM25, optional cross-encoder rerank

## What the editor never does

- Talk to model APIs directly. Always via the worker.
- Touch the SPA bundle except to serve it. The SPA is opaque to the editor.

## What the worker never does

- Write to disk in the workspace. All edits go back to the editor as `WorkspaceEdit` proposals so the user sees a diff.
- Display UI. It's headless.

## Cancellation

`AbortSignal` plumbed end-to-end: SPA cancels → HTTP request aborts → worker's provider call aborts → SSE stream closes. No orphan completions.
