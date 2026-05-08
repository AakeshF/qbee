# Roadmap to v1.0

> **Where we are: v0.4.4.** Cross-platform releases shipping for Linux (x64 + arm64 AppImages), Windows (x64 portable zip with Go launcher), and macOS (Apple Silicon .dmg + .zip). In-app Settings tab for API keys (no env vars). Provider preset + model selection persisted to localStorage. Inline FIM, agent ReAct loop with diff-only writes, hybrid `@codebase` RAG, in-app updater, tag-driven CI release pipeline.

This document plans the path from v0.4.4 → v1.0 and beyond.

---

## The framing question

> **"Could I hand this download link to a stranger on Reddit and have them get value out of it without me on call?"**

Each milestone closes a specific gap between today and that bar.

But there's a sharper version of the question, asked of the project as a whole:

---

## "Is this just VSCode?" — the differentiation thesis

**Today, mostly yes.** ~99% of the lines in `editor/` are upstream VSCode. The QBee-specific code is a chat panel, an agent ReAct loop, an inline FIM hook, and a hybrid retriever. All of those could plausibly exist as a VSCode extension (Continue.dev, Cline, Aider-ish setups already do most of it). The arguments for the fork right now are mostly cosmetic: branded chrome, telemetry off, Open VSX marketplace, "feels native instead of installed".

That's a real but narrow value prop. **A fork that doesn't earn its differentiation eventually loses to "stock VSCode + one of these extensions"** — and we should be honest about that.

The plan from v0.5 onward earns the fork by shipping things you genuinely can't do (or can't do well) as a sidebar extension:

| Differentiator | Lands in | Why a fork |
|---|---|---|
| **AI-first launch identity** — boot screen is a per-function provider dashboard (chat/agent/FIM/embedding), not the stock VSCode welcome | **v0.5** | Extensions can override start pages but never own the "this is what this product is" launch surface; that's chrome territory |
| **IDE-aware chat + agent** — active editor, selection, cursor, and open tabs auto-injected into every prompt; selection is context without `@file:` typing | **v0.5** | Extensions can read editor state but the round-trip through the extension boundary is awkward and asymmetric; baking it into the editor's chat/agent flow makes it feel native |
| **Embedded local LLM** — bundle llama.cpp + a small FIM model in the AppImage so first launch works zero-config | **v0.6** | Extensions can't ship a native runtime that survives uninstall/upgrade cleanly; the AppImage / .app / .exe is the boundary that lets us ship one binary that works |
| **Native AI chrome** — Cmd+K inline edit with diff-as-ghost-text, multi-line completion, predictive next-cursor jumps | **v0.7** | Inline-edit and predictive-jump UX touches the editor's command/cursor layer below what extension API exposes; this is the single feature people associate with Cursor |
| **Agent worktrees + domain tools** — every agent task in a git worktree, parallel runs, review-before-merge; agent has real tools (test runner, debugger, terminal-aware) | **v0.8** | Worktree management + debugger/test integration needs hooks deeper than the extension surface; this is what makes the agent useful for real work, not just file edits |

Everything else in this roadmap is in service of these landing well: reliability so users trust the agent; signed builds so the AppImage isn't quarantined; distribution breadth so people can install the thing.

**Things that go beyond what one fork should do** become **side projects under the QBee umbrella** (see the bottom of this doc). The fine-tuning loop, the benchmark harness, the MCP host — those each deserve their own repo and lifecycle, not a checkbox in the editor's roadmap.

---

## Feature surface today

What a user actually gets in v0.4.4. Each piece below is the foundation the milestones extend.

### Chat tab

Provider preset picker (Ollama / Anthropic / Gemini / OpenAI-compatible / custom OpenAI-compatible), editable model field, streaming responses with markdown + code-block highlighting. Two mention types:

- **`@codebase <query>`** — runs a hybrid retrieval (sqlite-vec + FTS5 with reciprocal-rank fusion) against the indexed workspace and prepends the top-K chunks as context.
- **`@file:path/to/file.ts`** — direct file injection without going through retrieval.

Provider preset and model selection persist to localStorage between sessions. Stop button aborts mid-stream.

### Agent tab

A ReAct-loop coding agent. The user writes a task, the model gets a small toolbox and works iteratively.

**Tools** (`worker/src/agent/tools.ts`):

| Tool | Purpose |
|---|---|
| `read_file` | Reads a workspace-relative file and returns its contents |
| `list_dir` | Lists entries in a workspace-relative directory |
| `grep` | Regex search across the workspace via ripgrep, up to 200 matches, optional glob filter |
| `write_file` | **Does NOT actually write.** Computes a diff and emits a `file_diff` event for the user to review |

**Loop** (`worker/src/agent/loop.ts`):

1. Worker sends the user's message + tool definitions to the provider.
2. Provider streams back text + zero-or-more `tool_use` blocks.
3. For each `tool_use`, worker executes the tool locally (FS read / ripgrep / diff computation) and appends a `tool_result`.
4. Loop back to (1) with the augmented conversation.
5. Stops when the provider stops calling tools or `maxIterations` is hit.

The transport is SSE from `POST /api/agent/run` — every text chunk, tool call, tool result, and file diff streams back as a typed event the SPA renders incrementally.

**The load-bearing safety invariant:** **the worker never writes to the workspace.** When the model calls `write_file`, the worker computes the diff and emits `{ path, before, after }`. The SPA renders red/green diff with **Apply** and **Reject** buttons. Apply sends a `postMessage` to the editor host, which calls VSCode's `IBulkEditService` — the only path that actually mutates files. The worker physically lacks a write path back into the workspace; the architecture enforces what the system prompt also says.

This invariant is non-negotiable through v1.0. Every milestone that touches the agent (v0.5 `run_terminal`, v0.8 worktrees + domain tools) keeps it: terminal commands need user approval per-command; agent worktrees move writes into a sandbox before they reach the live tree.

### Settings tab

API key inputs for Anthropic / Gemini / OpenAI (or any OpenAI-compatible token), persisted to localStorage and pushed to the worker via `/api/secrets/set`. Embedding endpoint configuration (base URL + model) for `@codebase`. No environment variables required for any provider.

> Threat model note: localStorage is "browser-stored token" — fine for personal-machine use, suboptimal for shared machines. v1.0 migrates to editor-side `SecretStorage`. Marked TODO in `Settings.tsx:7`.

### Inline FIM completions

Ghost-text completions as you type. 150ms debounce, LRU cache keyed on (language, prefix-tail, suffix-head), per-language allow-list. FIM-template-aware — auto-detects Qwen2.5-Coder, DeepSeek-Coder, Codestral, StarCoder2 templates. Configurable via `qbee.inlineCompletions.*` settings: provider, model, baseUrl, maxTokens.

Today this requires a running provider (local Ollama / LM Studio / llama.cpp, or a cloud key). v0.6's bundled local model removes that gate.

### Hybrid RAG / `@codebase`

`better-sqlite3` + `sqlite-vec` + FTS5 with reciprocal-rank fusion. **Index** button in chat header kicks off the initial pass. Once it lands, a `chokidar` watcher catches file changes and re-indexes within ~2s. Chunker today is fixed-window 40 lines; v0.5's tree-sitter chunking replaces it with function/class granularity.

The store lives at `<workspace>/.qbee/index.sqlite`. Schema is unstable through v0.5 (tree-sitter migration); locks at v1.0.

### Cross-platform packaging

Linux AppImage, Windows portable zip with Go launcher, macOS .app bundle (.dmg + .zip on Apple Silicon). The Go launcher (`scripts/launcher/`) is a single ~2 MB binary that resolves the editor + worker layout per-platform, picks a free port + random auth token, sets `QBEE_WORKER_URL` + `QBEE_WORKER_AUTH`, and `exec`s the editor with the right env. macOS Intel is currently best-effort in CI (free Intel runner is queue-starved); see v0.9 for the resolution path.

### In-app updater

`QBee: Check for Updates` command + a background check 10s after launch. Compares `product.json` version against the latest GitHub release; opens the release page if newer. v0.5 promotes this to in-place download/replace/restart.

---

## What's already shipped (v0.3–v0.4)

Marked done so the milestones below stay focused on what's actually pending.

| Item | Shipped in | Notes |
|---|---|---|
| Workspace root from editor URL fragment | v0.3 | SPA receives `workspaceRoot` via fragment from the editor when mounting the webview |
| Settings UI for API keys (`Settings.tsx`) | v0.3 | Three known providers + custom OpenAI-compatible. Persists to localStorage; pushes to worker `/api/secrets/set` on load. (Editor SecretStorage migration deferred — see debt list.) |
| Provider preset + model persistence | v0.4 | `qbee.presetIdx.v1` + `qbee.model.v1` in localStorage; survives between sessions |
| Embedding endpoint config in Settings | v0.3 | OpenAI-compatible base URL + model fields |
| `@file:path` mention in chat | v0.3 | Direct file injection, no retrieval round-trip |
| Multi-turn agent conversations | v0.3 | Continuation path inside a single agent panel session |
| Cross-platform builds (was v0.6) | v0.4 | Linux x64+arm64 AppImage, Windows x64 portable zip with Go launcher, macOS Apple Silicon .app bundle (.dmg + .zip). macOS Intel deferred — GitHub free Intel runner is queue-starved and best-effort in CI. |
| Go launcher (`scripts/launcher/`) | v0.4 | Cross-platform single binary; resolves the editor + worker layout per-platform; no console flash on Windows (`-H=windowsgui`); Info.plist `CFBundleExecutable` swap on macOS |

**Still pending from old v0.3 / v0.4:**

- **Tree-sitter chunking** for RAG (function/class granularity per language) — biggest single RAG quality win on the board, hasn't landed yet
- **Checkpoint snapshots / undo** before each agent run (`.qbee/checkpoints/<timestamp>/` hardlinks, `qbee: undo last agent run`)
- **`run_terminal` agent tool** with per-command approval modal
- **Real artwork** — the Q-on-blue placeholder is still in `scripts/appimage/qbee.png` (and now in the macOS / Windows packaging too)
- **Markdown UX in chat** — code-block copy buttons, line numbers in fenced blocks, optional mermaid
- **GPG signing live** — CI step is wired and dormant; needs `GPG_PRIVATE_KEY` repo secret
- **First-run welcome panel** inside the QBee sidebar
- **Better error surfaces** — toasts + retry + "show details" instead of inline `_error: ..._`

These all fold into **v0.5** below as the cleanup pass before the differentiation arc starts.

---

## v0.5 — AI-first identity, IDE-aware agent, reliability

**Theme:** the editor *feels* AI-native from the first launch, the agent knows what you're working on, and the foundations are solid enough to build the rest of the differentiation arc on top.

Two headline items drive this milestone — both came directly from the v0.4.4 user feedback pass and are non-negotiable for v0.5 to be considered done.

### Headline 1: AI-first launch dashboard

Today's launch experience is "stock VSCode chrome — go discover the QBee sidebar — find the Settings sub-tab — paste keys." That's not what someone downloading an "AI code editor" expects. The visible identity of the editor should be AI-first from frame one.

| Item | Notes |
|---|---|
| **AI dashboard as the launch surface** | Replace VSCode's "Get Started" welcome with a QBee dashboard. Per-function provider/model configuration in one place: chat, agent, inline FIM, embedding. Add a local model, paste an API key, switch the default per function — all visible from launch. |
| **Per-function provider routing** | Today the chat preset drives chat *and* the agent. Split: each function has its own provider+model selection (chat / agent / FIM / embedding). User can run Anthropic for agent, local Qwen for FIM, Gemini for chat — without re-picking each turn. Persisted. |
| **Local model picker** | "Add a local model" flow: detect Ollama / LM Studio running on localhost, list pulled models, one-click add. Or paste a custom OpenAI-compatible URL + model. Saves a named entry in the dashboard. (v0.6 adds the bundled-model option to this same picker.) |
| **Quick actions row** | "Start a chat", "Run an agent task", "Index this workspace", "Check for updates" — top of dashboard, single-click. |
| **"Always show this on launch" toggle** | Default on for new installs, off for power users. Reachable later via a top-level command. |

### Headline 2: IDE-aware chat + agent

Today the agent works workspace-blind: it knows the workspace root and that's it. To give it your selection, you copy-paste it. To tell it what file you're looking at, you type `@file:` mentions. The editor *knows* all of this and isn't sharing.

| Item | Notes |
|---|---|
| **Editor → worker context bridge** | On every chat send and every agent run, the editor pushes: active editor URI, current selection (range + text), cursor position, and the list of open tabs. Worker forwards into the system prompt as a structured "current state" block. |
| **Selection auto-context** | If a selection is active when the user sends a chat message, that selection is part of the prompt — no `@file:` needed. Visible in the chat UI as a chip showing the file + line range so the user knows what's being sent. |
| **"Reference open tabs"** in chat | A chip near the input that shows currently open tabs; one click toggles whether they're sent as context. Default off, but discoverable. |
| **Active-file awareness in agent** | Agent's system prompt includes "the user is currently looking at `path/to/file.ts:142`" so a prompt like "what's wrong here?" works without explicit file mentions. |
| **Workspace symbol context (stretch)** | Pre-load a symbol summary (function/class names per open file) into the system prompt. Cheap context, big impact on "find me the X function" type queries. Can defer to v0.6 if scope-heavy. |

### Reliability + carry-over from old v0.5

| Item | Notes |
|---|---|
| **Tree-sitter chunking** | Replaces the fixed-window chunker. Function/class granularity per language; fallback to fixed-window for unsupported langs. Index format change → migration path needed before v1.0 stability commitments. |
| **Checkpoint snapshots / undo** | Snapshot workspace under `.qbee/checkpoints/<timestamp>/` (hardlinks where possible) before each agent run. `qbee: undo last agent run` reverses every approved write. |
| **`run_terminal` agent tool with per-command approval** | Confirmation modal in SPA: command displayed, user approves, output streams. "Always allow this command in this workspace" remembered. |
| **Worker auto-restart on crash** | Supervisor in `contrib/qbee/electron-main/` (utility-process IPC) restarts worker up to N times in M seconds. |
| **Index health surface** | "Indexing 45% complete (2,300/5,100 files)" in QBee status bar. Surface stuck-indexing, embedding-endpoint-down, dim-mismatch errors in the UI instead of silently failing. |
| **AppImage in-place updater** | Promote "Check for Updates" from "links to release page" to "download → atomic replace → restart". |
| **GPG signing live** | Set `GPG_PRIVATE_KEY` repo secret. Every release ships `.asc` signatures alongside binaries. |
| **Better error surfaces** | Toasts + retry buttons + "show details" expandable for stack traces. |
| **Markdown UX polish** | Code-block copy button, line numbers in fenced blocks, inline math, optional mermaid. |
| **Real artwork** | Replace Q-on-blue placeholder across all platforms. |
| **Test suite + CI gate** | `vitest` coverage for provider adapters (mocked), agent tool implementations, RAG store + retriever. |

**Demo:** clean install, never used QBee. Launch. AI dashboard appears: "configure your providers". User pastes Anthropic key into the chat slot, picks Ollama for FIM, picks the Anthropic key again for embeddings. Clicks "Start a chat" from the quick actions. Editor opens with a `.py` file already selected; user highlights a function and types "what does this do?" — the chat prefills the selection automatically (no `@file:` typed). Reply streams. Then "agent: rename this to `parse_options`". Agent knows which file because the active editor was sent in the run context.

**Ship criteria:**
- AI dashboard is the default first-launch screen for new installs (configurable via toggle to revert to stock VSCode welcome)
- Per-function provider routing: separate persisted config for chat, agent, FIM, embedding
- Selection-as-context works for both chat and agent without any user opt-in
- Active editor URI visible to the agent via system-prompt injection on every run
- Worker crash recovery: 3 forced kills in 10s, all auto-recover
- 70%+ test coverage on provider adapters and RAG retriever
- AppImage download → `gpg --verify` succeeds → launches → dashboard works without prior knowledge
- A "Send Diagnostic" command bundles logs + last 5 errors into a clipboard-pastable report

---

## v0.6 — Embedded local LLM (the "click and go" win)

**Theme:** zero-config local inference. **The biggest "is this just VSCode?" answer we can ship in one milestone.**

This was originally v0.8 in the old plan; promoted because it's the single largest UX win and the most defensible fork-justifying differentiator. After v0.6 lands, "download QBee → click → tab completion already works, no Ollama install" is true.

| Item | Notes |
|---|---|
| **`LocalLlamaProvider`** | New entry in `worker/src/providers/`. Same `Provider` interface as the others. Loads a GGUF model via `node-llama-cpp`. |
| **Bundled FIM model** | Ship a small FIM model with the binary — leading candidate `Qwen2.5-Coder-1.5B-Instruct` GGUF (~1 GB Q4). Adds bulk to the download but eliminates the biggest first-run gate. Document the size cost openly. |
| **Optional larger model picker** | Settings dropdown: "Qwen2.5-Coder-1.5B (bundled)" / "Qwen2.5-Coder-7B (4.4 GB, click to download)" / "browse a local file". Caches under `~/.qbee/models/`. |
| **GPU detection** | Probe for CUDA / Metal / Vulkan; auto-enable acceleration when available, fall back to CPU. |
| **Embedded embedding model** | Bundle `nomic-embed-text` GGUF too so `@codebase` works without Ollama. ~250 MB additional. |
| **Bundle size accounting** | `node-llama-cpp` (~30 MB) + bundled FIM (~1 GB) + bundled embedding (~250 MB) ≈ +1.3 GB to the AppImage / zip. The honest tradeoff: 1.3 GB of disk for a binary that genuinely works on first launch vs. a 300 MB binary that requires the user to install + configure Ollama. We pay the bytes. |
| **First-run model load progress** | Visible streaming progress in the welcome panel. First inference call shouldn't be silent — typing into a file with no feedback for 8 seconds while the model warms is worse than a clear "loading model…" UI. |
| **Smaller "lite" variant** | Stretch: ship a `qbee-lite` artifact without the bundled model for users who already have Ollama / LM Studio and want a smaller download. CI matrix dimension. |

**Demo:** new user, no LLM stack installed. Download AppImage. Launch. Open a Python file. Type. Ghost-text appears within 3 seconds of first keystroke (cold-load). No setup screen, no env vars, no `ollama pull`.

**Ship criteria:**
- Cold start to first FIM completion under 10s on a typical laptop (model already on disk from install)
- Inference parity with Ollama path: same completions for the same prompts within tolerance
- p50 FIM completion under 200ms on Qwen2.5-Coder-1.5B GGUF on a typical laptop CPU
- Bundle size increase documented prominently in the release notes

**Why this before v0.7 inline AI chrome:** the chrome features need a fast model to feel right. Cmd+K inline edit feels broken if the user has to set up a provider first. Local-by-default unblocks the chrome work.

---

## v0.7 — Native AI chrome (Cursor-class inline UX)

**Theme:** the editor *feels* AI-native, not "VSCode with a chat sidebar."

This is the milestone where someone who's used Cursor would say "OK, this is doing the thing Cursor does." Not parity — better in some places (BYOM, local, open source), worse in others (no team features, no proprietary models). But the shape is there.

| Item | Notes |
|---|---|
| **Cmd+K inline edit** | Select code, hit Cmd+K, type natural-language instruction, see the edit as ghost text inline (not in the sidebar). Tab to accept; Esc to reject. The single feature most people identify as "Cursor". |
| **Multi-line ghost-text completion** | Beyond single-line FIM. The model proposes a multi-line edit, ghost-text spans the affected range, Tab accepts the whole block, individual-line accept/reject via keybinding. |
| **Predictive next-cursor jumps** ("Cursor Tab") | After an edit, the model predicts the most likely next location to edit and offers a single-Tab jump. Kept on its own per-keystroke budget separate from completions. |
| **Inline diff for refactor flows** | When the agent or Cmd+K produces a multi-file edit, render diff as inline ghost text in each affected file simultaneously. User reviews each file inline; one keystroke accepts all or accepts current. |
| **Selection-aware chat** | Right-click / shortcut → "Ask QBee about this selection" — chat opens, prompt prefilled with the selection as context. Easier to reach for than typing `@file:` mentions. |
| **Diff hunks in chat replies** | When chat returns code in a fenced block, render an "Apply this diff" button that surfaces the WorkspaceEdit preview, same machinery as the agent's diff flow. |

**Demo:** open a 200-line file. Highlight a function, Cmd+K → "convert to async". Ghost-text diff appears in place. Tab. Cursor jumps to a related function in the same file (predicted next edit). Ghost-text diff appears there too. Tab. Done.

**Ship criteria:**
- Cmd+K from selection to first ghost-text edit under 1.5s on the bundled local model
- Tab-to-accept and Esc-to-reject keybindings stable, not stomped by stock VSCode bindings (this is mostly a binding-conflict audit)
- Predictive jump accept rate >25% on a benchmark of 50 typical edit sequences
- All inline UX works equally with cloud providers (Anthropic / Gemini) and the bundled local model — the chrome is provider-agnostic

**This is the milestone that earns the fork.** If we ship v0.6 and v0.7, the answer to "is this just VSCode?" is no — Cmd+K and predictive jumps are not extension-territory in any practical sense. Stock VSCode + Continue can't deliver this UX.

---

## v0.8 — Agent worktrees + domain tools

**Theme:** the agent does real work, in isolation, with real tools.

The agent in v0.4 has `read_file / list_dir / grep / write_file`. That's a fine demo, not a real coding workflow. v0.8 turns the agent from a demo into something you'd actually trust with a 30-minute task.

| Item | Notes |
|---|---|
| **Git worktree per agent task** | When the user kicks off an agent run, spawn a worktree at `.qbee/worktrees/<task-id>/`. Agent's writes land there. User reviews via diff UI before the worktree merges into the main checkout. Inspired by Aider's branch flow + Devin/Codex's PR flow. |
| **Parallel agent runs** | Multiple worktrees → multiple agent tasks in flight. "Try three approaches to this refactor in parallel, I'll pick the best one." Each task has its own provider/model selection. |
| **Review-before-merge UI** | Worktree completion surfaces a side-by-side diff view; user accepts whole task, accepts individual files, or rejects. Rejected worktrees stay around for inspection until cleaned up. |
| **`run_test` tool** | Agent can run the project's test suite (detected via `package.json scripts.test`, `pytest.ini`, `cargo.toml`, etc.) and stream output. "Make this test pass" is a viable agent prompt. |
| **`debug_step` tool** | Agent can drive the editor's debugger: set breakpoint, run-to-line, inspect locals, step over. Lets it find runtime bugs, not just static ones. Editor-side hooks needed. |
| **`run_terminal_aware` upgrade** | The v0.5 `run_terminal` tool gets better context: pipes stdout AND stderr back, captures exit code, surfaces them to the model in the next turn. "Build broke" → agent reads the error and fixes it. |
| **`pkg_install` tool** | Agent can suggest package additions when it finds an undefined symbol. User approves the install. Removes a tedious manual loop. |
| **Plan tree before execution** | Long-running agent tasks generate an explicit plan (tree of subtasks) before doing any work. User can edit the plan before the agent starts. Inspired by Claude Code's TodoWrite-style planning. |

**Demo:** "agent: add JWT auth to the Express server, including tests." Plan tree appears: install jsonwebtoken, scaffold middleware, add tests, update README. User approves plan. Three worktrees spawn (different middleware approaches). Each runs in parallel. Tests run in each worktree. The one with passing tests gets surfaced first; others remain available. User reviews diffs side-by-side, picks one, merges.

**Ship criteria:**
- Agent task isolation: a failed agent run never modifies the user's working tree
- Plan tree edit-before-run flow works end-to-end
- Test runner integration green for at least Node, Python, and Rust projects
- Parallel agent runs share index but isolate writes; no data races on the SQLite store
- "Cancel and discard" cleans up worktree completely (no orphan branches)

---

## v0.9 — Distribution breadth + signed releases

**Theme:** more places to install from, with trust signals.

| Item | Notes |
|---|---|
| **macOS Intel build** | Currently best-effort in CI (free runner queue-starved). Either commit to a paid runner, switch to a self-hosted macOS Intel runner, or formally drop x86_64 macOS support and document it. |
| **AUR `PKGBUILD`** | Wrap the AppImage release. CachyOS / Arch users do `yay -S qbee-bin`. Builds against the latest release tag. |
| **Code-signed Windows builds** | EV cert is expensive (~$300-400/yr). Decide: commit to it, accept SmartScreen warnings, or hope for OV cert availability. SmartScreen warning is genuinely a friction point. |
| **Notarized macOS builds** | Apple Developer Program ($99/yr). Required for Gatekeeper to not warn on first launch. |
| **Auto-update channel selection** | "stable" / "beta" / "main" channels in the updater settings. CI publishes pre-releases tagged `v0.x.y-beta.N`. |
| **Flatpak (decision point)** | Local-LLM access through the sandbox is tricky. Three options: (a) full sandbox + Flatpak portal for net access, (b) `--filesystem=home` + `--share=network` permissions, (c) defer past v1.0. Currently leaning (c). |
| **`.deb` and `.rpm`** | Direct package manager installs for Ubuntu/Fedora/etc. Lower priority than AUR if AppImage covers most Linux users. |

**Demo:** five installs side-by-side: AppImage on CachyOS, AUR package on Arch, .dmg on Apple Silicon, signed .exe installer on Windows, .deb on Ubuntu. Same workspace, same provider, same conversation. They behave identically.

**Ship criteria:**
- macOS Intel: either green in every CI run or formally dropped from supported platforms
- AUR package installs and launches QBee 1:1 with the AppImage
- Signed Windows installer doesn't trip SmartScreen
- Notarized macOS .app launches without right-click → Open prompt
- Updater respects channel setting

---

## v1.0 — Production

**Theme:** stable, supported, recommended.

By v1.0 the feature set is locked. Subsequent releases are bug fixes and small additions, not new fundamental capabilities. v1.0 is a *commitment* to the API surface, the storage format, and the keybinding/command palette layout.

**Stability commitments:**
- `qbee.*` configuration keys: stable. Changes go through a deprecation window.
- `.qbee/index.sqlite` schema: stable. Migration path for any future change.
- `/api/*` HTTP shapes: stable for any third-party tool that wants to drive the worker.
- Editor commands: stable IDs (`qbee.checkForUpdates`, etc.) so user keybindings don't break.
- Worktree storage layout under `.qbee/worktrees/`: stable.
- Bundled-model API contract: any future model bundle change keeps the same `LocalLlamaProvider` shape.

**User-facing docs and onboarding (was old v0.9):**
- User guide tree: install / first chat / Cmd+K walkthrough / agent walkthrough / RAG walkthrough / troubleshooting
- 2-3 minute video walkthrough in README
- Provider-specific guides (one per Anthropic / Gemini / OpenAI-compat / local)
- Issue templates (bug / feature request / "my model is slow")
- A community channel (Discord or Matrix or GH Discussions, pick one)

**Quality bar:**
- Every milestone above shipped and stable
- p95 reliability: no random crashes for a week of daily use
- Real artwork everywhere (no Q-on-blue placeholders anywhere)
- Signed binaries on every release for every platform
- All providers (Anthropic, Gemini, OpenAI-compat, bundled local) tested green in CI on each release tag
- A non-developer can read the README, install QBee, and do their first chat in under 10 minutes

**What v1.0 is NOT:**
- Not a stopping point — v1.x and the side projects below continue indefinitely
- Not "done" — it's "trustworthy enough to recommend"

---

## Side projects under the QBee umbrella

Things that are interesting, valuable, but **don't belong inside the editor's roadmap.** Each gets its own repo, its own lifecycle, and its own ship criteria. They orbit QBee — feed into it, build on it — but they're not gates on v1.0.

### QBee Forge — captured-feedback fine-tuning loop

**Goal:** every accepted/rejected completion is logged. A background pipeline trains a LoRA on top of the bundled FIM model nightly using the user's own code patterns. After a week of use, completions become noticeably more "in-house style."

**Why it's a side project, not core:** training pipelines are heavy and platform-specific (CUDA / Metal / ROCm); the storage of training data raises privacy questions that need their own UI; the LoRA-merge step is tooling-heavy. The hooks land in QBee (a "log this completion outcome" event); the pipeline lives in `qbee-forge`.

**Privacy invariant:** all training local-by-default; opt-in for any cloud-assisted training step. A clear export/import mechanism so users can take their LoRA with them.

**Repo:** `qbee-forge` (separate). Could ship its own GUI, or be CLI-only.

### QBee Bench — quality benchmarks for AI editors

**Goal:** an open benchmark for AI-editor quality. FIM accept rate on a curated set of in-the-wild repos, agent task completion rate on a small curated set of GitHub issues, RAG retrieval quality on `@codebase`-style queries.

**Why it's a side project:** benchmarks are infrastructure. They need a leaderboard, reproducible task definitions, and a contribution policy. They serve QBee (we use the bench to test PRs) but they should be useful to other AI editors too — Continue, Aider, Cursor benchmarking themselves on the same harness raises the whole field.

**Repo:** `qbee-bench` (separate, open-license, contribution-friendly).

### QBee MCP host

**Goal:** support the [Model Context Protocol](https://modelcontextprotocol.io) so users can plug arbitrary external tools into the agent (filesystem, browsers, shell, custom domain tools) without each one being baked into the worker.

**Why it's a side project for now:** it's a strict superset of v0.8's domain-tools work. v0.8 ships a small set of high-quality first-party tools. MCP host adds the open extension point. Decoupling lets MCP iterate on its own pace instead of blocking the in-editor agent UX.

**Lands in:** `worker/` eventually, as an additional provider for tools. Stays a side project until the v0.8 first-party tools settle.

### QBee Tutor (speculative)

**Goal:** an in-editor learning mode for new programmers. Different UX target from the daily-driver editor: simpler chrome, scaffolded examples, "explain this code" inline annotations, deliberate slowness ("walk me through this line by line"). Could live as an editor mode toggle, a separate distribution, or a wrapper repo.

**Why it's a side project:** the design space is very different from "editor for working programmers". Bundling them dilutes both. If we want to do this, it should be its own thing.

**Status:** speculative. List it here so the idea has a home and we don't accidentally start building it in `editor/src/.../qbee/`.

---

## Architectural debt / gaps

**Closed since v0.2.1:**
- Settings UI for API keys ✅ (v0.3 — `Settings.tsx` + `pushSecretsToWorker`)
- Workspace root from editor URL fragment ✅ (v0.3)
- Provider preset/model persistence ✅ (v0.4)
- Cross-platform builds ✅ (v0.4)

**Open:**
- **`Settings.tsx` uses localStorage for API keys.** Threat model is "same as a browser-stored token" — fine for local dev, suboptimal for shared machines. v1.0 should migrate to editor-side `SecretStorage` via the existing postMessage bridge. Marked TODO in `Settings.tsx:7` already.
- **macOS Intel** is currently best-effort with `continue-on-error: true` on the macos-13 matrix entry. Either commit to it (paid runner, self-hosted, etc.) or formally drop in v0.9.
- **Anthropic SDK is pinned at 0.30.x** for `client.beta.promptCaching.messages.*`. Newer SDK versions move this to top-level. Migration is straightforward but should happen before v1.0.
- **Agent has unrestricted filesystem access** under workspace root. v0.8's worktree work mitigates this for write side; read side still has no per-file deny-list. v1.0 should add an opt-in deny pattern (e.g. `.env`, secrets dirs).
- **Dev path uses Vite, prod path uses bundled SPA.** Behavior can diverge. Acceptable through v1.0; not worth fixing pre-1.0.
- **Bundle size is going to grow significantly in v0.6** (embedded model). Plan for a `qbee-lite` artifact dimension if community feedback says the bundle is too large.

---

## Sequencing notes

The milestones above are written in the order I'd ship them. Hard order constraints:

- **v0.5 before v0.6.** Reliability work (worker auto-restart, test suite, error surfaces) needs to land before we add a heavy native runtime that creates new failure modes.
- **v0.6 before v0.7.** Inline AI chrome feels broken without a fast local model — Cmd+K with a 4-second cloud round-trip is not the experience.
- **v0.7 before v0.8.** Agent worktrees + domain tools assume the chrome can render multi-file diffs inline; the chrome work makes the agent's output usable.
- **Tree-sitter chunking belongs in v0.5** because it changes the index format, and stability commitments at v1.0 lock the format.
- **Tests (v0.5) before adding more platforms (v0.9)** — adding distribution surfaces before having a regression net is a recipe for asymmetric breakage.

Reasonable variations:
- **Skip v0.9 distribution breadth entirely** if AppImage/zip/.app already cover the audience. Push v0.9 work into v1.0 polish.
- **Promote QBee Forge to v0.7 or v0.8** if community traction makes "your editor learns your style" the headline pitch. Currently sized as a side project because it's pipeline-heavy; could be reshaped if focused.
- **Ship a `qbee-lite` (no bundled model) variant in v0.6** if community feedback says the +1.3 GB is a dealbreaker.

The "is this just VSCode?" answer becomes a clear *no* at the end of v0.7. Everything before that is foundation; everything after is depth.
