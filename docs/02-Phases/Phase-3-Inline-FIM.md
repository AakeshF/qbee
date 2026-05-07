# Phase 3 — Inline FIM completions

**Goal:** ghost-text autocomplete as you type. Tab accepts. Latency feels Cursor-class on local 1.5B model.

**Demo at end:** open a Python file, start typing `def fibonacci(`. Within ~150ms a completion appears. Tab accepts.

## Tasks

### Fork contribution
- [ ] `browser/inlineCompletionProvider.ts` — implements `InlineCompletionItemProvider`
  - Triggers on text change, debounced 150ms
  - Sends `{prefix, suffix, language, file_path}` to worker `/api/complete`
  - Cancels in-flight request on new keystroke
  - LRU cache keyed on `(last 256 chars of prefix, first 64 chars of suffix, language)`
- [ ] Settings: enable/disable, debounce ms, model override, max-tokens

### Worker
- [ ] `worker/src/routes/complete.ts` — fast-path FIM endpoint
- [ ] FIM token templates per model:
  - Qwen2.5-Coder: `<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>`
  - DeepSeek-Coder: `<｜fim▁begin｜>{prefix}<｜fim▁hole｜>{suffix}<｜fim▁end｜>`
  - Codestral: `[PREFIX]{prefix}[SUFFIX]{suffix}`
  - StarCoder2: `<fim_prefix>{prefix}<fim_suffix>{suffix}<fim_middle>`
- [ ] Provider's `complete()` uses `/v1/completions` (not `/v1/chat/completions`) — FIM needs the raw completion endpoint
- [ ] Stop tokens to avoid runaway generation

### SPA
- [ ] Telemetry surface: completion accept rate, average latency (local only, no upload)

## Verification

1. Type slowly in a `.py` file, see ghost text appear consistently
2. p50 latency under 200ms with Qwen2.5-Coder-1.5B local
3. Tab accepts, Esc dismisses, keep typing replaces
4. Cache hit when retyping the same prefix
5. No completions on `.md` (configurable allow-list)
6. Disabling completions in settings actually disables them

## Critical files (new)

- `editor/src/vs/workbench/contrib/qbee/browser/inlineCompletionProvider.ts`
- `worker/src/routes/complete.ts`
- `worker/src/providers/fim-templates.ts`

## Gotchas

- **`/v1/completions` vs `/v1/chat/completions`** — FIM needs the former. Ollama supports both; LM Studio supports both; some servers only expose chat.
- **Debounce vs cancel** — both. Debounce reduces request count; cancel prevents wasted work when the user keeps typing.
- **Multi-line completions** — model often wants to write the whole function. Cap at N lines and let the user trigger more if they want.
- **Bracket balance** — model often closes brackets that the editor will close anyway. Optional post-processing pass that strips matched closing brackets.
- **First-keystroke storm** — when the user opens a file and starts typing, dozens of in-flight requests stack up. Drop all but the latest aggressively.

## Next: [[Phase-4-Agent-Mode]]
