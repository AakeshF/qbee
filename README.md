# QBee

An open-source AI code editor: fork of VSCode with first-class AI plumbing. Bring your own model — local (Ollama, LM Studio, llama.cpp, vLLM), Anthropic Claude, or Google Gemini — and configure each function (chat, agent, inline completions, embeddings) independently.

> **Status:** v0.5.1. Cross-platform releases for Linux (x64, arm64), Windows (x64), and macOS Apple Silicon. macOS Intel deferred (free CI runner queue-starved).

## What's in v0.5

- **AI-first launch.** First time you open QBee, the editor opens straight to a Dashboard tab with provider routing for chat / agent / inline FIM / embedding — all configurable in one place. No `Ctrl+,` to find AI settings.
- **Local-model auto-detect.** "Detect local models" probes Ollama / LM Studio / llama.cpp on loopback, lists everything running, one-click apply to any function.
- **IDE-aware chat + agent.** Active editor, selection, cursor, and open tabs are auto-injected into every prompt. Highlight a function, type "what does this do?" — the agent already knows which file. No `@file:` typing required.
- **Sidebar chat** with streaming markdown + per-block copy buttons + line numbers, `@codebase <query>` for hybrid retrieval, `@file:path/to/x.ts` for direct injection.
- **Agent panel** with a ReAct loop. Tools: `read_file` / `list_dir` / `grep` / `write_file` (diff-only) and `run_terminal` (per-command approval modal, "always allow this command" remembered per workspace). All file changes go through diffs — the worker never writes to disk.
- **Undo Last Agent Run.** Every agent run snapshots pre-edit state under `.qbee/checkpoints/<runId>/`. `Ctrl+Shift+P` → "QBee: Undo Last Agent Run" restores files modified by the run and deletes files created by the run.
- **Inline FIM completions** as you type — debounced, LRU-cached, FIM-template-aware (Qwen2.5-Coder, DeepSeek-Coder, Codestral, StarCoder2). Editable from the Dashboard via a postMessage bridge to VSCode settings.
- **Hybrid RAG with tree-sitter chunking.** `better-sqlite3` + `sqlite-vec` + FTS5 with reciprocal-rank fusion. Splits at function/class/method boundaries for TS/JS/Py/Rust/Go/Java/C/C++. Color-coded `rag:` badge with stall detection + pre-flight probe + sticky error panel with Retry.
- **Worker auto-restart on crash** — supervisor respawns the bundled worker up to 5 times in 30s with exponential backoff. Port + auth token reused; the editor stays connected across restarts.
- **AppImage in-place updater (Linux).** Dashboard's Updates section downloads + verifies SHA-256 + atomically replaces the running AppImage. No more manual download + chmod.
- **Cross-platform packaging** — Linux AppImage, Windows portable zip with Go launcher, macOS .app bundle (.dmg + .zip). Each ships the editor + bundled SPA + bundled worker + native deps. No external services to install.
- **Open VSX extension marketplace.** Telemetry off. **GitHub Copilot is not bundled** — QBee's own AI surface is the differentiator.

## Install

All downloads live on the [latest release page](https://github.com/AakeshF/qbee/releases/latest). Each artifact has a sibling `.sha256` for verification.

### Linux (x86_64 / aarch64)

```sh
curl -LO https://github.com/AakeshF/qbee/releases/download/v0.5.1/QBee-0.5.1-x86_64.AppImage
chmod +x QBee-0.5.1-x86_64.AppImage
./QBee-0.5.1-x86_64.AppImage
```

For arm64, swap `x86_64` for `aarch64`.

Verify the SHA-256:

```sh
curl -LO https://github.com/AakeshF/qbee/releases/download/v0.5.1/QBee-0.5.1-x86_64.AppImage.sha256
sha256sum -c QBee-0.5.1-x86_64.AppImage.sha256
```

**Runtime requirement:** `libfuse2` is needed for the AppImage runtime.
- Ubuntu 22.04+: `sudo apt install libfuse2t64`
- Arch / CachyOS: present by default

### Windows (x64)

Download [`QBee-0.5.1-x64-win.zip`](https://github.com/AakeshF/qbee/releases/download/v0.5.1/QBee-0.5.1-x64-win.zip), unzip anywhere, and run `QBee.exe` at the root of the extracted folder. The launcher is a small Go binary that boots the bundled worker before opening the editor — no console window flashes.

It's a portable zip, no installer. Pin `QBee.exe` to your Start menu / taskbar if you want a launcher.

### macOS (Apple Silicon)

Download [`QBee-0.5.1-arm64-mac.dmg`](https://github.com/AakeshF/qbee/releases/download/v0.5.1/QBee-0.5.1-arm64-mac.dmg), open it, drag `QBee.app` to `/Applications`. (A `-arm64-mac.zip` is also available for users who prefer that.)

The build is unsigned, so the first launch needs **right-click → Open** to bypass Gatekeeper. macOS will remember the exception after that.

> macOS Intel (x86_64) is not yet shipped — GitHub Actions' free Intel runner is queue-starved. Apple Silicon Mac users via Rosetta should use the arm64 build.

### First-run setup

The first time QBee launches, the AI sidebar opens automatically with the **Dashboard** tab selected. You'll see four configuration rows:

1. **Chat** — pick a preset (Ollama / Anthropic / Gemini / OpenAI-compatible), set the model field. Default is Ollama at `127.0.0.1:11434`.
2. **Agent** — independent provider/model selection. Use a stronger model for agent runs than chat if you want.
3. **Inline FIM** — `baseUrl` + `model` for inline code completions. FIM-capable code models work best (Qwen2.5-Coder, DeepSeek-Coder, etc.).
4. **Embedding endpoint** (for `@codebase`) — OpenAI-compatible. Defaults to Ollama's `nomic-embed-text`.

For cloud providers, paste your `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, or any OpenAI-compatible token in the **API keys** section. They're stored in browser-local storage and pushed to the worker on every load.

For local models, click **Detect local models** in the Provider routing section. Anything running on `127.0.0.1:11434` (Ollama), `127.0.0.1:1234` (LM Studio), or `127.0.0.1:8080` (llama.cpp server) gets listed with one-click "→ chat / → agent / → FIM / → embed" buttons.

That's it — no terminal env vars, no config files. Click "Start a chat" from the quick actions row.

### `@codebase` setup

Click the **Index** button in the chat header. The pre-flight probes the embedding endpoint first; if it's down you get a clear error before any work happens. During indexing the badge shows live progress (`rag: indexing 45%`) with a stall detector if no progress arrives for 30s.

After indexing, `@codebase how is auth handled?` in chat fetches the top hits and feeds them to the model. The chunker splits at function/class boundaries when the language is supported (TS/JS/Py/Rust/Go/Java/C/C++); other languages fall back to fixed-window chunks.

The watcher catches file edits and re-indexes the affected files within ~2s — no manual re-index needed for small changes.

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

- `qbee:build.0` — editor TSC watch (`npm run watch`)
- `qbee:build.1` — SPA Vite dev (port 5173)
- `qbee:build.2` — worker tsx watch (port 8421)
- `qbee:run.0` — `./editor/scripts/code.sh` to launch the dev editor

Node 22.x is required by upstream VSCode (`editor/.nvmrc`). `tmux-dev.sh` auto-prepends `~/.local/opt/node-22/bin` to PATH if you've installed Node 22 there.

Tests + typecheck:

```sh
pnpm -w typecheck   # all packages
pnpm -w test        # 48 unit tests across shared/ + worker/
```

CI (`.github/workflows/ci.yml`) gates every push + PR on the same two commands.

## Releasing

Tag-driven:

```sh
git tag v0.5.2
git push origin v0.5.2
```

`.github/workflows/release.yml` builds Linux AppImages (x64 + arm64), a Windows portable zip with embedded `qbee.ico`, and a macOS .app bundle (.dmg + .zip) with embedded `qbee.icns`. Computes SHA-256, uploads everything to a GitHub Release. macOS Intel is best-effort — won't block the release. GPG signing wired but dormant.

Local dry-run (Linux):

```sh
ARCH=x64 VERSION=0.5.2 ./scripts/build-appimage.sh
# → .build/dist/QBee-0.5.2-x86_64.AppImage (+ .sha256)
```

Equivalent: `scripts/build-windows.sh` (cross-builds for Windows from any host) and `scripts/build-macos.sh` (macOS only). First build is slow (~15-30 min for upstream's gulp pass); subsequent builds are incremental.

## Architecture

Three processes. Single document at [`docs/01-Architecture.md`](docs/01-Architecture.md). One-line summary:

```
editor (Electron renderer, sandboxed) ↔ webview iframe → SPA → /api/* → worker
```

The worker is the HTTP host: it serves the SPA at `/` and the API at `/api/*`. On Linux, `AppRun` is the entry point; on Windows and macOS it's a small Go launcher (`QBee.exe` / `qbee-launcher` inside `Contents/MacOS/`). In all three, the launcher spawns the bundled worker with `QBEE_SPA_DIST` pointing at the bundled SPA dist, picks a free port + random auth token, then `exec`s the editor with `QBEE_WORKER_URL` + `QBEE_WORKER_AUTH` set so the webview iframes the right URL. The launcher supervises the worker and respawns it (with the same port + token) if it dies while the editor is running.

Fork-only code lives entirely under `editor/src/vs/workbench/contrib/qbee/`. Upstream files touched: `product.json` (branding + Open VSX + neutered `defaultChatAgent`), `build/lib/copilot.ts` (stubs the ripgrep-shim step now that the bundled Copilot extension is gone), `build/lib/extensions.ts` indirectly via `extensions/copilot/` deletion, `eslint.config.js` (drops the deleted copilot eslint plugin), and `workbench.desktop.main.ts` (one-line import). All AI features live in `contrib/qbee/` so upstream rebases stay cheap.

## Layout

| Path | What |
|---|---|
| `editor/` | Git submodule — fork of `microsoft/vscode`. Don't touch anything outside `src/vs/workbench/contrib/qbee/`. |
| `spa/` | React + Vite + TypeScript AI panel (Dashboard / Chat / Agent). Vendored into the editor's `spa-dist/` at build time. |
| `worker/` | Node + Fastify HTTP host. Provider adapters, agent ReAct loop, RAG store/chunker/indexer/retriever/watcher, AppImage updater, local-model probe. |
| `shared/` | Zod schemas + types shared between spa and worker. |
| `scripts/` | `init-fork.sh`, `vendor-spa.sh`, `bundle-worker.sh`, `build-{appimage,windows,macos}.sh`, Go launcher source under `launcher/`, AppRun + `.desktop` template, branding (`branding/qbee-1024.png`, `qbee.ico`, `qbee.icns`, `build-icns.mjs`). |
| `.github/workflows/ci.yml` | Push/PR gate: typecheck + tests. |
| `.github/workflows/release.yml` | Tag-triggered cross-platform release. |

## License

MIT, inherited from `microsoft/vscode`.

## Acknowledgments

Built on top of VSCode (Microsoft, MIT). Open VSX (Eclipse Foundation) for the extension gallery. `sqlite-vec` (Alex Garcia) for the vector store. `tree-sitter-wasms` (Gregor) for the prebuilt language parsers.
