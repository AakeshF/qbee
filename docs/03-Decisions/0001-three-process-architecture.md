# ADR 0001 — Three-process architecture (editor / SPA / worker)

**Date:** 2026-05-06
**Status:** Accepted

## Context

The fork needs to host AI features (chat, FIM, agent, RAG) without making the upstream rebase loop painful and without coupling AI iteration speed to editor build speed (which is slow).

## Options considered

1. **All-in-one** — AI code lives directly in `src/vs/workbench/contrib/qbee/` as TypeScript that runs in the renderer
2. **Two-process** — fork + worker; AI UI as a webview using VSCode's webview API
3. **Three-process** — fork + worker + sidebar SPA loaded as a real iframe via Electron-main loopback HTTP proxy *(chosen)*

## Decision

Three-process. The SPA is loaded into the sidebar as an iframe pointed at `http://127.0.0.1:<port>/...` served by an HTTP proxy in Electron-main. The proxy reverse-proxies `/api/*` to a Node worker child process.

## Why

- **Cheap rebases** — fork-only code is one directory + `product.json`; everything else is outside `editor/`
- **Fast UI iteration** — `vite dev` on the SPA standalone, no editor rebuild
- **Worker isolation** — provider crashes don't take down the editor; restartable
- **Headless testing of AI logic** — worker is plain HTTP, `vitest` covers it without any VSCode runtime
- **Real iframe origin** — full browser semantics for sessions, file drops, CSP

Pattern documented in the [OpenCode VSCode IDE](https://github.com/cpkt9762/opencode-vscode-ide) fork; we're applying the same idea.

## Trade-offs

- More moving parts than a webview-based extension
- HTTP proxy + Basic auth ceremony at startup
- Two builds (SPA + editor) for production

## Consequences

Forces discipline: AI code never imports VSCode APIs directly. Editor never imports AI provider SDKs. Communication goes through the well-defined HTTP boundary in `shared/src/api.ts`.
