# QBee

An open-source AI code editor: fork of VSCode with first-class AI plumbing. Bring your own model — local (Ollama, LM Studio, llama.cpp, vLLM), Anthropic Claude, or Google Gemini — and switch per conversation.

> **Status:** v0.4.4. Cross-platform releases for Linux (x64, arm64), Windows (x64), and macOS Apple Silicon. macOS Intel is on the roadmap. Full plan: [`docs/02-Phases/Roadmap-v1.0.md`](docs/02-Phases/Roadmap-v1.0.md).

## What's in v0.4.4

- **Sidebar chat** with provider preset picker, streaming markdown + code-block highlighting, `@codebase <query>` mention that retrieves top-K workspace chunks via hybrid RAG and prepends them as context.
- **Agent panel** with a ReAct loop: `read_file` / `list_dir` / `grep` / `write_file` (diff-only). Diffs render with Apply / Reject buttons; Apply writes via VSCode's `WorkspaceEdit` (no direct disk writes from the worker).
- **Inline FIM completions** as you type — debounced, LRU-cached, configurable per language. Works with any OpenAI-compatible endpoint that speaks FIM tokens (Qwen2.5-Coder, DeepSeek-Coder, Codestral, StarCoder2 templates auto-detected).
- **Hybrid RAG** over the workspace: `better-sqlite3` + `sqlite-vec` + FTS5 with reciprocal-rank fusion. Incremental reindex via `chokidar` — file saves are reflected in retrieval within ~2s.
- **Cross-platform packaging** — Linux AppImage, Windows portable zip, macOS .app bundle (.dmg + .zip). Each ships the editor + bundled SPA + bundled worker + native deps. No external services to install (BYOM at runtime).
- **Provider preset + model selection persisted** between sessions (localStorage).
- **In-app updater** — `QBee: Check for Updates` command + a background check that surfaces a release notification 10s after launch.
- **Open VSX extension marketplace**, telemetry off.

## Install

All downloads live on the [latest release page](https://github.com/AakeshF/qbee/releases/latest). Each artifact has a sibling `.sha256` for verification.

### Linux (x86_64 / aarch64)

```sh
curl -LO https://github.com/AakeshF/qbee/releases/download/v0.4.4/QBee-0.4.4-x86_64.AppImage
chmod +x QBee-0.4.4-x86_64.AppImage
./QBee-0.4.4-x86_64.AppImage
```

For arm64, swap `x86_64` for `aarch64`.

Verify the SHA-256:

```sh
curl -LO https://github.com/AakeshF/qbee/releases/download/v0.4.4/QBee-0.4.4-x86_64.AppImage.sha256
sha256sum -c QBee-0.4.4-x86_64.AppImage.sha256
```

**Runtime requirement:** `libfuse2` is needed for the AppImage runtime.
- Ubuntu 22.04+: `sudo apt install libfuse2t64`
- Arch / CachyOS: present by default

### Windows (x64)

Download [`QBee-0.4.4-x64-win.zip`](https://github.com/AakeshF/qbee/releases/download/v0.4.4/QBee-0.4.4-x64-win.zip), unzip anywhere, and run `QBee.exe` at the root of the extracted folder. The launcher is a small Go binary that boots the bundled worker before opening the editor — no console window flashes.

It's a portable zip, no installer. Pin `QBee.exe` to your Start menu / taskbar if you want a launcher.

### macOS (Apple Silicon)

Download [`QBee-0.4.4-arm64-mac.dmg`](https://github.com/AakeshF/qbee/releases/download/v0.4.4/QBee-0.4.4-arm64-mac.dmg), open it, drag `QBee.app` to `/Applications`. (A `-arm64-mac.zip` is also available for users who prefer that.)

The build is unsigned, so the first launch needs **right-click → Open** to bypass Gatekeeper. macOS will remember the exception after that.

> macOS Intel (x86_64) is not yet shipped — GitHub Actions' free Intel runner couldn't be scheduled in time. Intel Mac users on Apple Silicon machines via Rosetta should use the arm64 build; otherwise wait for a future release.

(GPG-signed Linux releases land via the `GPG_PRIVATE_KEY` workflow secret — see [roadmap](docs/02-Phases/Roadmap-v1.0.md). Code-signed Windows / macOS releases are post-v1.0.)

### First-run setup

Open the AI sidebar (default: right side) and you'll see three tabs: **chat**, **agent**, **settings**.

1. Click **settings**.
2. **For cloud providers** — paste your `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, or any OpenAI-compatible token. They persist in browser-local storage and are pushed to the worker on every load.
3. **For local models (no API key needed)** — install Ollama or LM Studio, pull a model, then in the **chat** tab pick the "Ollama (local)" preset (default `127.0.0.1:11434`). Edit the model field to whatever you've pulled (`qwen2.5-coder:7b`, `deepseek-coder-v2`, etc.). Your preset and model selection persist between launches.
4. Optional: in **settings**, customize the embedding endpoint for `@codebase` (defaults to Ollama's `nomic-embed-text`).

That's it — no terminal env vars, no config files. Switch back to **chat** and start a conversation.

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
git tag v0.4.5
git push origin v0.4.5
```

CI (`.github/workflows/release.yml`) builds Linux AppImages (x64 + arm64), a Windows portable zip, and a macOS .app bundle (.dmg + .zip), computes SHA-256, and uploads everything to a GitHub Release. macOS Intel is opt-in / best-effort — it can't block the release. GPG signing is wired but dormant until you set the `GPG_PRIVATE_KEY` repo secret.

Local dry-run (Linux):

```sh
ARCH=x64 VERSION=0.4.5 ./scripts/build-appimage.sh
# → .build/dist/QBee-0.4.5-x86_64.AppImage (+ .sha256)
```

Equivalent scripts: `scripts/build-windows.sh` and `scripts/build-macos.sh`. The first build is slow (~15-30 min for upstream's gulp pass); subsequent builds are incremental.

## Architecture

Three processes. Single document at [`docs/01-Architecture.md`](docs/01-Architecture.md). One-line summary:

```
editor (Electron renderer, sandboxed) ↔ webview iframe → SPA → /api/* → worker
```

The worker is the HTTP host: it serves the SPA at `/` and the API at `/api/*`. On Linux, `AppRun` is the entry point; on Windows and macOS it's a small Go launcher (`QBee.exe` / `qbee-launcher` inside `Contents/MacOS/`). In all three, the launcher spawns the bundled worker with `QBEE_SPA_DIST` pointing at the bundled SPA dist, picks a free port + random auth token, then `exec`s the editor with `QBEE_WORKER_URL` + `QBEE_WORKER_AUTH` set so the webview iframes the right URL.

Fork-only code lives entirely under `editor/src/vs/workbench/contrib/qbee/`. Two upstream files modified (`product.json` for branding + Open VSX, `workbench.desktop.main.ts` for one import line). All other AI features live in `contrib/qbee/` so upstream rebases stay cheap.

## Layout

| Path | What |
|---|---|
| `editor/` | Git submodule — fork of `microsoft/vscode`. Don't touch anything outside `src/vs/workbench/contrib/qbee/`. |
| `spa/` | React + Vite + TypeScript AI panel. Vendored into the editor's `spa-dist/` at build time. |
| `worker/` | Node + Fastify HTTP host. Provider adapters, agent ReAct loop, RAG store/chunker/indexer/retriever/watcher. |
| `shared/` | Zod schemas + types shared between spa and worker. |
| `scripts/` | `init-fork.sh`, `vendor-spa.sh`, `bundle-worker.sh`, `build-{appimage,windows,macos}.sh`, Go launcher source under `launcher/`, AppRun + `.desktop` template. |
| `docs/` | Obsidian vault — architecture, ADRs, phase notes, daily log, [v1.0 roadmap](docs/02-Phases/Roadmap-v1.0.md). |
| `.github/workflows/release.yml` | Tag-triggered AppImage release. |

## License

MIT, inherited from `microsoft/vscode`.

## Acknowledgments

Built on top of VSCode (Microsoft, MIT). Open VSX (Eclipse Foundation) for the extension gallery. `sqlite-vec` (Alex Garcia) for the vector store. Anthropic / Google for the models that drove most of this code into existence.
