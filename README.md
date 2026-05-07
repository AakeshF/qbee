# QBee

A Linux-first, open-source AI code editor: fork of VSCode with first-class AI plumbing. Bring your own model — local (Ollama, LM Studio, llama.cpp, vLLM), Anthropic Claude, or Google Gemini — and switch per conversation.

> **Status:** v0.2.1. AppImage releases for Linux x64 + arm64. Roadmap to v1.0 in [`docs/02-Phases/Roadmap-v1.0.md`](docs/02-Phases/Roadmap-v1.0.md).

## What's in v0.2.1

- **Sidebar chat** with provider preset picker, streaming markdown + code-block highlighting, `@codebase <query>` mention that retrieves top-K workspace chunks via hybrid RAG and prepends them as context.
- **Agent panel** with a ReAct loop: `read_file` / `list_dir` / `grep` / `write_file` (diff-only). Diffs render with Apply / Reject buttons; Apply writes via VSCode's `WorkspaceEdit` (no direct disk writes from the worker).
- **Inline FIM completions** as you type — debounced, LRU-cached, configurable per language. Works with any OpenAI-compatible endpoint that speaks FIM tokens (Qwen2.5-Coder, DeepSeek-Coder, Codestral, StarCoder2 templates auto-detected).
- **Hybrid RAG** over the workspace: `better-sqlite3` + `sqlite-vec` + FTS5 with reciprocal-rank fusion. Incremental reindex via `chokidar` — file saves are reflected in retrieval within ~2s.
- **Self-contained AppImage** — editor + bundled SPA + bundled worker + native deps. No external services to install (BYOM at runtime).
- **In-app updater** — `QBee: Check for Updates` command + a background check that surfaces a release notification 10s after launch.
- **Open VSX extension marketplace**, telemetry off.

## Install

### Linux x64 / arm64

Download the latest AppImage from [Releases](https://github.com/AakeshF/qbee/releases/latest):

```sh
curl -LO https://github.com/AakeshF/qbee/releases/download/v0.2.1/QBee-0.2.1-x86_64.AppImage
chmod +x QBee-0.2.1-x86_64.AppImage
./QBee-0.2.1-x86_64.AppImage
```

Verify the SHA-256:

```sh
curl -L https://github.com/AakeshF/qbee/releases/download/v0.2.1/QBee-0.2.1-x86_64.AppImage.sha256
sha256sum -c QBee-0.2.1-x86_64.AppImage.sha256
```

(GPG-signed releases come with v0.4 — see [roadmap](docs/02-Phases/Roadmap-v1.0.md).)

**Runtime requirement:** `libfuse2` is needed for the AppImage runtime.
- Ubuntu 22.04+: `sudo apt install libfuse2t64`
- Arch / CachyOS: present by default

### First-run setup

QBee reads provider API keys from the worker's environment for now (settings UI lands in v0.3). Two options:

**Local model (no API key needed):** install Ollama or LM Studio, run a model. The chat tab's "Ollama (local)" preset points at `127.0.0.1:11434` by default; the model field is editable.

**Anthropic / Gemini:** export keys before launching:

```sh
ANTHROPIC_API_KEY=sk-ant-... GEMINI_API_KEY=... ./QBee-0.2.1-x86_64.AppImage
```

Then pick a preset in the chat tab's header.

### `@codebase` setup

Click the **Index** button in the chat header. Streams progress; ~1 file/second on a typical CPU. The default embedding endpoint is Ollama's `nomic-embed-text` at `127.0.0.1:11434`. Edit the embedding model + URL in `App.tsx` if you're on LM Studio (`text-embedding-nomic-embed-text-v1.5`) — exposed-as-a-setting comes with v0.3.

After indexing, `@codebase how is auth handled?` in chat fetches the top hits and feeds them to the model.

## Develop

```sh
git clone https://github.com/AakeshF/qbee
cd qbee
git submodule update --init --recursive   # pulls editor/ (fork of microsoft/vscode, ~150 MB)
pnpm install                              # spa/worker/shared deps
cd editor && npm install --legacy-peer-deps   # editor deps (upstream uses npm)
cd ..
./tmux-dev.sh                             # opens the dev session
```

Inside the tmux session:

- `qbee:build.0` — editor TSC watch (npm run watch)
- `qbee:build.1` — SPA Vite dev (port 5173)
- `qbee:build.2` — worker tsx watch (port 8421)
- `qbee:run.0` — `./editor/scripts/code.sh` to launch the dev editor

Node 22.x is required by upstream VSCode (`editor/.nvmrc`). `tmux-dev.sh` auto-prepends `~/.local/opt/node-22/bin` to PATH if you've installed Node 22 there.

## Releasing

The release pipeline is tag-driven:

```sh
git tag v0.2.2
git push origin v0.2.2
```

CI (`.github/workflows/release.yml`) builds AppImages for x64 + arm64, computes SHA-256, and uploads everything to a GitHub Release. GPG signing is wired but dormant until you set the `GPG_PRIVATE_KEY` repo secret.

Local dry-run:

```sh
ARCH=x64 VERSION=0.2.2 ./scripts/build-appimage.sh
# → .build/dist/QBee-0.2.2-x86_64.AppImage (+ .sha256)
```

The first build is slow (~15-30 min for upstream's gulp pass); subsequent builds are incremental.

## Architecture

Three processes. Single document at [`docs/01-Architecture.md`](docs/01-Architecture.md). One-line summary:

```
editor (Electron renderer, sandboxed) ↔ webview iframe → SPA → /api/* → worker
```

The worker is the HTTP host: it serves the SPA at `/` and the API at `/api/*`. In the AppImage, `AppRun` spawns the bundled worker with `QBEE_SPA_DIST` pointing at the bundled SPA dist, picks a free port + random auth token, then `exec`s the editor with `QBEE_WORKER_URL` + `QBEE_WORKER_AUTH` set so the webview iframes the right URL.

Fork-only code lives entirely under `editor/src/vs/workbench/contrib/qbee/`. Two upstream files modified (`product.json` for branding + Open VSX, `workbench.desktop.main.ts` for one import line). All other AI features live in `contrib/qbee/` so upstream rebases stay cheap.

## Layout

| Path | What |
|---|---|
| `editor/` | Git submodule — fork of `microsoft/vscode`. Don't touch anything outside `src/vs/workbench/contrib/qbee/`. |
| `spa/` | React + Vite + TypeScript AI panel. Vendored into the editor's `spa-dist/` at build time. |
| `worker/` | Node + Fastify HTTP host. Provider adapters, agent ReAct loop, RAG store/chunker/indexer/retriever/watcher. |
| `shared/` | Zod schemas + types shared between spa and worker. |
| `scripts/` | `init-fork.sh`, `vendor-spa.sh`, `bundle-worker.sh`, `build-appimage.sh`, AppRun + .desktop template. |
| `docs/` | Obsidian vault — architecture, ADRs, phase notes, daily log, [v1.0 roadmap](docs/02-Phases/Roadmap-v1.0.md). |
| `.github/workflows/release.yml` | Tag-triggered AppImage release. |

## License

MIT, inherited from `microsoft/vscode`.

## Acknowledgments

Built on top of VSCode (Microsoft, MIT). Open VSX (Eclipse Foundation) for the extension gallery. `sqlite-vec` (Alex Garcia) for the vector store. Anthropic / Google for the models that drove most of this code into existence.
