# Phase 1 — Sidebar SPA + worker plumbing

**Goal:** end-to-end "hello world" round-trip: SPA → loopback proxy → worker → echo back. Plus API-key storage.

**Demo at end:** sidebar shows a chat-like input. Type "ping". Worker logs receipt. SPA renders "pong" streamed back. Settings page lets you save an Anthropic API key; restart the editor; key is still there (via `SecretStorage`).

## Tasks

### Worker (`worker/`)
- [ ] Express or Fastify HTTP server, listens on port from `QBEE_WORKER_PORT` env var
- [ ] `/api/echo` endpoint that streams back the input via SSE (proves streaming infra)
- [ ] `/api/secrets/{get,set,delete}` RPC to the editor (needs editor-side handler)
- [ ] Graceful shutdown on SIGTERM
- [ ] Structured logging to stdout (the editor's `workerManager` forwards stdout to an output channel)

### SPA (`spa/`)
- [ ] Vite + React + TS scaffold
- [ ] Tailwind + shadcn/ui setup
- [ ] Zustand store
- [ ] Chat input + message list components
- [ ] HTTP client that hits `/api/*` with HTTP Basic auth header (from URL query param injected by the editor)
- [ ] SSE consumer with `AbortController` plumbing
- [ ] Settings panel with API-key input fields

### Fork contribution (`editor/src/vs/workbench/contrib/qbee/`)
- [ ] `qbee.contribution.ts` — register sidebar view container with iframe placeholder
- [ ] `browser/spaProxyService.ts` — Electron-main HTTP server, serves `spa-dist/`, proxies `/api/*` to worker
- [ ] `browser/workerManager.ts` — spawn worker as child process, port discovery via stdout handshake, restart on exit
- [ ] `common/secrets.ts` — wraps `IExtensionsManagementService` style — actually use `IStorageService` + `vscode.SecretStorage`-equivalent
- [ ] Sidebar iframe loads from `http://127.0.0.1:<port>/?auth=<basic-auth>`

### Build glue (`scripts/`, root)
- [ ] `scripts/vendor-spa.sh` — `pnpm --filter spa build && cp -r spa/dist/* editor/src/vs/workbench/contrib/qbee/spa-dist/`
- [ ] Root `package.json` with pnpm workspace pointing at `spa`, `worker`, `shared`
- [ ] `shared/src/api.ts` — Zod schemas for the request/response shapes used in this phase

## Verification

1. `./tmux-dev.sh` opens the dev session
2. Editor launches with QBee sidebar visible
3. SPA loads in the iframe (no console errors)
4. Type "ping" → worker logs "received: ping" → SPA shows "pong: ping" streaming
5. Save an Anthropic API key in settings, restart editor, key persists (visible in `SecretStorage` storage)
6. Kill the worker manually; `workerManager` respawns it within 2 seconds; SPA reconnects

## Critical files (new)

- `editor/src/vs/workbench/contrib/qbee/qbee.contribution.ts`
- `editor/src/vs/workbench/contrib/qbee/browser/spaProxyService.ts`
- `editor/src/vs/workbench/contrib/qbee/browser/workerManager.ts`
- `editor/src/vs/workbench/contrib/qbee/common/secrets.ts`
- `worker/src/server.ts`
- `worker/src/routes/echo.ts`
- `spa/src/App.tsx`, `spa/src/components/Chat.tsx`
- `shared/src/api.ts`
- `scripts/vendor-spa.sh`

## Gotchas

- The iframe origin matters: load from `http://127.0.0.1:<port>` not `file://` or `vscode-resource://`. CSP/cookies/sessions all behave differently.
- Worker port is assigned dynamically. The handshake protocol: worker prints `{"type":"ready","port":1234}` to stdout on startup; editor parses this; subsequent log lines are plain text.
- HTTP Basic auth credentials come from the editor at iframe-load time as a URL fragment. The SPA reads `window.location.hash` once, then includes the header on every fetch.

## Next: [[Phase-2-Chat-MVP]]
