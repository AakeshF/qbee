# Roadmap to v1.0

> **Where we are: v0.2.1.** Branded VSCode fork with chat, agent (with diff approval), inline FIM completions, hybrid RAG (with `@codebase`), incremental reindex, in-app updater, and a tag-driven AppImage release pipeline. Linux x64 + arm64 AppImages publish on every release tag.

This document plans the path from v0.2.1 → v1.0. Each milestone is a coherent feature bundle with a demo and ship criteria, in the spirit of the original phase docs (Phase-0 through Phase-7).

The framing question for v1.0: **"Could I hand this AppImage to a stranger on Reddit and have them get value out of it without me on call?"** Each milestone closes a specific gap between today and that bar.

---

## v0.3 — Feature parity with Cursor's basics

**Theme:** the things any AI editor user expects on first install.

| Item | Notes |
|---|---|
| **Tree-sitter chunking** for RAG | Replaces the fixed-window chunker. Function/class granularity per language; fallback to fixed-window for unsupported langs. The single biggest RAG quality win on the board. |
| **`@file:path` mention** in chat | Sibling of `@codebase` — direct file injection (read via worker FS) without going through retrieval. |
| **Multi-turn agent conversations** | Today the agent panel sends one user turn per run. Add a continuation path so the user can refine the agent's output without restarting. |
| **Checkpoint snapshots / undo** | Before each agent run, snapshot the workspace under `.qbee/checkpoints/<timestamp>/` (hardlinks where possible). "Undo to checkpoint" command in the editor. |
| **Workspace root from editor** | The SPA hardcodes the dev path today. Pass via the URL fragment that the editor sets when mounting the webview. |
| **Settings UI for API keys** | Replace "set ANTHROPIC_API_KEY in worker env" with a prompt-on-first-use that writes to `SecretStorage`. The worker reads via an editor RPC channel. |

**Demo:** new install → first launch → SPA prompts for an Anthropic key → user pastes → asks "rename `foo` to `bar` everywhere and update tests" → multi-file diff appears → user approves → tests run, regression detected → user says "agent: also update the README" → agent picks up where it left off.

**Ship criteria:**
- Tree-sitter packs install per-platform without manual rebuilds (Electron 39.x ABI matched)
- `@file:` autocompletes file paths
- Agent state survives between turns within a session
- `qbee: undo last agent run` reverses every approved write
- Settings page persists keys via SecretStorage; no env-var dependency for first-run

---

## v0.4 — Polish and trust

**Theme:** stops feeling like a dev preview.

| Item | Notes |
|---|---|
| **`run_terminal` agent tool** with per-command approval | Today the agent can read/grep/write but not execute. Add the tool with a confirmation modal in the SPA: command displayed, user approves once, output streams back. |
| **Real artwork** | Replace the placeholder blue Q at `scripts/appimage/qbee.png`. AppImage icon, .desktop entry icon, in-app brand mark. (User generates via Gemini.) |
| **Markdown UX in chat** | Code-block copy button, line numbers in fenced blocks, inline math rendering, mermaid diagrams (optional). |
| **Provider config persistence** | Today switching presets resets the conversation. Persist per-conversation provider + model + API key ref via VSCode settings. |
| **GPG signing live** | Generate a key, store the private half as `GPG_PRIVATE_KEY` repo secret. The CI signing step is already wired and dormant. Once active, every release ships `.asc` signatures alongside the AppImages. Document `gpg --verify` in the install steps. |
| **First-run experience** | Welcome panel inside the QBee sidebar: "Pick your provider", "Set API key", "Try `@codebase how is this code organized?`". Drives the user through the three things they need to know. |
| **Better error surfaces** | Today errors render as `_error: <message>_` inline. Replace with toasts + retry buttons + a "show details" expandable for stack traces. |

**Demo:** clean Linux box, never used QBee. Download AppImage from a GPG-verified release. Launch. Welcome panel walks the user through first chat. Agent asks for terminal-tool approval the first time it wants to run `npm test`; user approves; output streams.

**Ship criteria:**
- AppImage download → `gpg --verify` succeeds → launches → first-run flow works without prior knowledge
- Terminal-tool approval is per-command; "always allow this command" remembered per workspace
- A chat with three code blocks, you can copy each independently

---

## v0.5 — Reliability

**Theme:** doesn't break in surprising ways.

| Item | Notes |
|---|---|
| **Worker auto-restart on crash** | Today AppRun spawns the worker once and lets it die with the editor. Add a supervisor (in `contrib/qbee/electron-main/` via utility-process IPC, or a shell-side wrapper in AppRun) that restarts the worker up to N times in M seconds. |
| **Index health / status surface** | "Indexing 45% complete (2,300/5,100 files)" in the QBee status bar. Surface stuck-indexing, embedding-endpoint-down, dim-mismatch errors in the UI instead of silently failing. |
| **AppImage in-place updater** | Today's "Check for Updates" links to the release page. Promote to: download → atomic replace → restart. AppImage spec supports this via the standard updater binary; need to wire it. |
| **Test suite** | The codebase has zero tests outside the editor's existing harness. Add `vitest` coverage for: provider adapters (mocked), agent tool implementations, RAG store + retriever. CI gate. |
| **Telemetry hook (opt-in, local-only)** | Completion accept rate, request latency, error frequency. **Local logging only by default**, no upload. Optional opt-in to send anonymized aggregates somewhere we control. |

**Demo:** kill `pkill -9 -f qbee-worker` while a chat is mid-stream. Editor reconnects within 2s. Notification: "worker restarted". User retries; works.

**Ship criteria:**
- Worker crash recovery: 3 forced kills in 10s, all auto-recover
- 70%+ test coverage on provider adapters and RAG retriever
- A "Send Diagnostic" command that bundles logs + last 5 errors into a clipboard-pastable report

---

## v0.6 — Distribution breadth

**Theme:** more places to install from.

| Item | Notes |
|---|---|
| **AUR `PKGBUILD`** | First package for the AppImage release. CachyOS / Arch users do `yay -S qbee-bin` or similar. Builds against the AppImage release — small `PKGBUILD` checked into the repo, published manually until v1.0 when we automate. |
| **macOS build target** | `.dmg` via `electron-builder` or hand-rolled. Universal binary preferred (single artifact, x64 + arm64). Adds a darwin job to the release matrix. |
| **Flatpak** | Sandbox makes local-LLM access tricky (worker child process, network to localhost). Decide between (a) full sandbox with a Flatpak portal for net access, (b) `--filesystem=home` permission, (c) defer past v1.0. |
| **Auto-update channel selection** | "stable" / "beta" / "main" channels in the updater settings. CI publishes pre-releases tagged `v0.x.y-beta.N`. |
| **Windows build** | Lowest priority — most local-LLM stacks (Ollama, llama.cpp) work on Windows but the integration story is messier. Defer if time-constrained. |

**Demo:** Three installs running side-by-side: AppImage on Linux, `.dmg` on a Mac, AUR package on Arch. Same workspace, same conversation, same model. They behave identically.

**Ship criteria:**
- macOS build green in CI; signed if Apple Dev account is provisioned, ad-hoc otherwise
- AUR package installs and launches QBee 1:1 with the AppImage
- Updater respects channel setting

---

## v0.7 — Performance

**Theme:** feels fast enough that the model is the bottleneck, not us.

| Item | Notes |
|---|---|
| **Cross-encoder reranking** | After hybrid retrieval, re-rank top-20 with a small cross-encoder (e.g. `bge-reranker-base`). Big quality win on `@codebase` queries with multiple matches. |
| **Cache agent tool results** | `read_file` and `list_dir` results don't need to round-trip on every tool call within a turn. Memoize against the file's mtime. |
| **SPA bundle optimization** | Today's chat bundle is ~156KB (50KB gzipped). Adding markdown + highlight bumped it; optimize tree-shaking, lazy-load `rehype-highlight`. Target <100KB gzipped. |
| **FIM cache hit rate visibility** | Surface inline-completion cache hit rate in a status bar item; lets users tell when their model is too slow vs when caching is masking it. |
| **Embedding batch size auto-tune** | Today fixed at 32. Detect endpoint type (Ollama / LM Studio / vLLM); tune the batch size to maximize throughput for each. |

**Demo:** index a 10k-file repo. p50 query latency under 500ms. Inline completions feel Cursor-class on local Qwen2.5-Coder-1.5B (sub-150ms ghost text on a typical laptop CPU).

**Ship criteria:**
- p50 RAG search < 500ms on a 10k-file workspace
- p50 FIM completion < 200ms on Qwen2.5-Coder-1.5B GGUF locally
- Reranker quality A/B: rerank-on vs rerank-off, ≥10% improvement on a 50-query benchmark

---

## v0.8 — Optional embedded local LLM

**Theme:** zero-config local inference.

The killer convenience win: `node-llama-cpp` bundled into the worker. User downloads the AppImage, picks a default model on first run, gets inline completions + chat without installing Ollama or LM Studio.

| Item | Notes |
|---|---|
| **`LocalLlamaProvider`** | New entry in `worker/src/providers/`. Same interface as the others. Loads a GGUF model via `node-llama-cpp`. |
| **Model picker UI** | Dropdown in settings: "download Qwen2.5-Coder-1.5B (1.0 GB)" / "Qwen2.5-Coder-7B (4.4 GB)" / "browse a local file". Caches under `~/.qbee/models/`. |
| **GPU detection** | Probe for CUDA / Metal / Vulkan; auto-enable acceleration when available, fall back to CPU. |
| **Bundle size impact** | `node-llama-cpp` adds ~30 MB to the worker bundle. Acceptable; the alternative (running a separate Ollama install) is worse for a "just works" story. |

**Demo:** new user, no LLM stack. Download AppImage. Launch. Pick "Qwen2.5-Coder-1.5B" from the model picker. Wait 60s for model download. Type into a Python file → ghost text streams.

**Ship criteria:**
- Cold start to first FIM completion under 90s on a typical laptop (download + model load)
- Inference parity with the Ollama path: same completions for the same prompts within tolerance

---

## v0.9 — User-facing docs and onboarding polish

**Theme:** someone with no context can self-serve.

| Item | Notes |
|---|---|
| **User guide** | Replace today's dev-facing docs with a `docs/Users/` tree: install / first chat / agent walkthrough / RAG walkthrough / troubleshooting. |
| **Video walkthrough** | 2-3 min screen recording for the README. AI editors are easier to demo than describe. |
| **Provider-specific guides** | One page per provider: Anthropic (key, prompt caching benefits), Gemini (key, model picks), Ollama (install, recommended models), LM Studio (setup), llama.cpp server (manual). |
| **Issue templates** | Three GitHub issue templates: bug, feature request, "my model is slow". Last one routes users to a self-diagnostic checklist. |
| **Discord / Matrix / GitHub Discussions** | Pick one, link from README. Honestly the lowest-leverage item — mostly useful when users actually exist. |

**Ship criteria:**
- A non-developer can read the README, install QBee, and do their first chat in under 10 minutes
- All provider walkthrough videos load and play

---

## v1.0 — Production

**Theme:** stable, supported, recommended.

By the time we cut v1.0, the feature set is locked. Subsequent releases are bug fixes and small additions, not new fundamental capabilities. v1.0 is a *commitment* to the API surface, the storage format, and the keybinding/command palette layout.

**Stability commitments:**
- `qbee.*` configuration keys: stable. Changes go through a deprecation window.
- `.qbee/index.sqlite` schema: stable. Migration path for any future change.
- `/api/*` HTTP shapes: stable for any third-party tool that wants to drive the worker.
- Editor commands: stable IDs (`qbee.checkForUpdates`, etc.) so user keybindings don't break.

**Quality bar:**
- Every milestone above shipped and stable
- p95 reliability: no random crashes for a week of daily use
- Real artwork, not placeholder
- Signed AppImages on every release
- All three providers (Anthropic, Gemini, OpenAI-compat) tested green in CI on each release tag

**What v1.0 is NOT:**
- Not a stopping point — Phase 7+ from the original plan (MCP host, Flatpak, advanced multi-agent flows) lands post-1.0.
- Not "done" — it's "trustworthy enough to recommend".

---

## Honest current-state assessment

**What works today (v0.2.1):**
- Three providers stream chat cleanly: Anthropic (with prompt caching), Gemini, OpenAI-compatible (covers Ollama / LM Studio / llama.cpp / vLLM / OpenAI / OpenRouter).
- Inline FIM completions with debounce + LRU cache + per-language allow-list.
- Agent ReAct loop with read/list/grep/write tools; diffs render in the SPA; Apply button writes via `IBulkEditService` through a postMessage bridge.
- Hybrid RAG (vector + BM25 + RRF). `@codebase` mention prepends top-K chunks. Incremental reindex on file change.
- Self-contained AppImage: editor + bundled SPA + bundled worker + native deps. No external services required at install time (just the user's own LLM endpoint or API keys).
- Tag-driven CI release: x64 + arm64 AppImages with SHA-256 checksums. GPG signing wired but dormant pending key.

**Gaps that bite users:**
- Tree-sitter chunking would massively improve `@codebase` quality on real codebases (today's 40-line fixed-window misses function boundaries)
- Settings UI for API keys (today: env-var only, awkward for new users)
- Workspace root hardcoded in the SPA (today: dev path; needs editor URL-fragment plumbing)
- No `@file` mention (have to copy-paste file content into chat)
- No worker auto-restart (kill the worker → SPA loses connection → manual restart)
- Placeholder icon (still a blue Q from ImageMagick)

**Architectural debt:**
- The `tmux-dev.sh` workflow is dev-mode. In the AppImage everything's bundled — but the dev path still uses Vite, which means dev iterations differ from production behavior. Acceptable for now; not v1.0-blocking.
- Anthropic SDK is pinned at 0.30.x for `client.beta.promptCaching.messages.*`. Newer SDK versions move this to top-level. Migration is straightforward but should happen before v1.0.
- The agent has access to read the whole filesystem under the workspace root. There's no per-file deny-list. v1.0 should add an opt-in deny pattern (e.g. `.env`, secrets dirs).

---

## Sequencing notes

The milestones above are written in the order I'd ship them. Reasonable variations:

- **Skip v0.6 (distribution breadth) entirely** if Linux is the only platform that matters. AppImages already cover most of the audience for "fork of VSCode".
- **Promote v0.8 (embedded llama.cpp) earlier** if user feedback says the Ollama install gate is the #1 friction.
- **Defer v0.7 (performance)** if the model is genuinely the bottleneck — most users would rather wait 200ms for a better completion than have a 100ms one that's wrong.

The hard order constraints:
- Tree-sitter chunking belongs in v0.3 because it changes the index format, and we want migrations done before v1.0 stability commitments.
- Settings UI for API keys belongs before any wide distribution — env vars are not a real shippable UX.
- Tests (v0.5) before macOS build (v0.6) — adding platforms before having a regression net is a recipe for asymmetric breakage.
