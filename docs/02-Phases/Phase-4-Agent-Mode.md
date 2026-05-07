# Phase 4 — Agent mode + diff approval

**Goal:** the model can read, search, and propose edits across files. User approves or rejects each diff. Checkpoints allow undo.

**Demo at end:** ask the agent "rename `foo` to `bar` everywhere and update the tests". See a multi-file diff. Approve all, run tests, then "undo to checkpoint" reverts cleanly.

## Tasks

### Worker — agent loop
- [ ] `worker/src/agent/loop.ts` — ReAct-style tool-use loop. Drives a `Provider.chat` with tools, loops on `tool_use` blocks, halts on `end_turn`.
- [ ] Tools (in `worker/src/agent/tools/`):
  - `read_file({path})` — via editor RPC
  - `list_dir({path, recursive?})` — via editor RPC
  - `grep({pattern, path?, glob?})` — ripgrep over the workspace via editor RPC
  - `write_file({path, content})` — produces a diff proposal (does NOT touch disk)
  - `apply_patch({patches: [{path, unified_diff}]})` — alternative: model emits unified diffs directly (often token-cheaper)
  - `run_terminal({command})` — gated, off by default, requires per-command approval
- [ ] Cancellation propagates: user aborts → in-flight provider stream cancels → tool calls abandoned

### Worker — checkpoints
- [ ] `worker/src/checkpoints.ts` — before each agent run, snapshot the workspace under `.qbee/checkpoints/<timestamp>/`
- [ ] Use hardlinks where possible (most files unchanged) to keep snapshots near-free
- [ ] `restore(checkpoint_id)` — copies back, then signals editor to reload affected files
- [ ] Auto-prune to last N checkpoints (default 20)

### SPA — diff approval UI
- [ ] Per-file diff view (use `diff2html` or roll a simple side-by-side)
- [ ] Approve / reject / approve-all / reject-all
- [ ] Stream diffs in as they arrive (don't wait for the agent to finish)
- [ ] "Continue with feedback" — user can comment on a partial result and the agent picks up

### Fork contribution
- [ ] `browser/agentDiffEditor.ts` — registers a custom diff editor variant for the agent UI
- [ ] `browser/editApplier.ts` — applies approved patches via `WorkspaceEdit`
- [ ] New view: "QBee: Agent" sidebar tab, separate from chat

## Verification

1. Single-file edit: "add a docstring to function X" → diff appears, approve → file updated
2. Multi-file edit: rename across N files → N diffs, approve all → all updated
3. Reject one: change one diff to "rejected" → approved files apply, rejected one doesn't
4. Cancel mid-run: hit cancel → no partial diffs apply, agent halts
5. Checkpoint undo: run an edit, then "restore checkpoint" → workspace back to pre-edit state, editor reloads affected files
6. Run terminal tool with approval prompt: `npm test` → user sees the command, approves, output streams to UI

## Critical files (new)

- `worker/src/agent/loop.ts`
- `worker/src/agent/tools/*.ts` (one per tool)
- `worker/src/checkpoints.ts`
- `editor/src/vs/workbench/contrib/qbee/browser/agentDiffEditor.ts`
- `editor/src/vs/workbench/contrib/qbee/browser/editApplier.ts`
- `spa/src/components/AgentRun.tsx`, `spa/src/components/DiffView.tsx`

## Gotchas

- **The model will sometimes call `write_file` with full file contents**, sometimes with patches. Support both; convert to unified diff for display.
- **Concurrent edits** — if the user types in the editor while the agent is running, file contents diverge. Decision: snapshot-on-tool-call; agent works against the snapshot; conflicts surface at apply time.
- **Tool-call streaming** — Anthropic streams tool calls as they're generated. Don't wait for the whole call to materialize before showing "Agent is thinking about editing X".
- **System prompt size** — the tool definitions are big. **Cache them via Anthropic's prompt cache** (see [[04-Providers/Anthropic]]).
- **Path safety** — tools must reject paths outside the workspace. Use `path.resolve` and check it starts with the workspace root.

## Next: [[Phase-5-RAG]]
