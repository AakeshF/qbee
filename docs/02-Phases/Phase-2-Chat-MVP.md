# Phase 2 — Chat MVP, all backends

**Goal:** real chat against three backends — local OpenAI-compatible, Anthropic, Google Gemini. Streaming, model picker, `@file` mentions.

**Demo at end:** ask "explain this codebase" with a `@file:./worker/src/server.ts` mention. Get a streaming answer. Switch from Claude to Gemini to local Ollama mid-conversation; each works.

## Tasks

### Worker
- [ ] `worker/src/providers/types.ts` — `Provider` interface
- [ ] `worker/src/providers/openai.ts` — OpenAI-compatible adapter (covers Ollama, LM Studio, llama.cpp server, vLLM, OpenAI itself, OpenRouter, etc.)
- [ ] `worker/src/providers/anthropic.ts` — `@anthropic-ai/sdk`, **with prompt caching enabled** on system prompts and tool definitions (cuts cost ~90% for repeat-context turns)
- [ ] `worker/src/providers/gemini.ts` — `@google/generative-ai`
- [ ] `worker/src/routes/chat.ts` — picks provider from request, streams via SSE
- [ ] `worker/src/fs.ts` — `read_file` for `@file` mentions (via editor RPC, not direct disk read)

### SPA
- [ ] Mention picker (`@` triggers a fuzzy file search, hitting worker `/api/fs/list`)
- [ ] Markdown renderer with code-block syntax highlighting (use `react-markdown` + `shiki`)
- [ ] Provider/model picker UI (per-conversation, with a "default" knob)
- [ ] Copy-to-clipboard on code blocks
- [ ] Cancel button (wires to AbortController)

### Fork contribution
- [ ] `browser/fsBridge.ts` — handles worker → editor RPC for file reads/lists (worker can't read disk directly)
- [ ] Editor command "QBee: Focus Chat" with default Cmd+L keybinding

## Verification

For each backend (Ollama qwen2.5-coder:7b, Anthropic claude-sonnet-4-6, Gemini gemini-2.0-flash):

1. Plain message: "what is the capital of France?" — streams cleanly
2. With file mention: `@file:README.md what's this project about?` — file content is in context
3. Cancel mid-stream — request aborts, SPA UI returns to idle
4. Switch provider mid-conversation, send another message — works

Anthropic specifically:
- First message in a conversation creates a cache breakpoint on the system prompt
- Second message hits the cache (visible in API response `cache_read_input_tokens` field)

## Critical files (new)

- `worker/src/providers/{types,openai,anthropic,gemini}.ts`
- `worker/src/routes/chat.ts`
- `worker/src/fs.ts`
- `editor/src/vs/workbench/contrib/qbee/browser/fsBridge.ts`
- `spa/src/components/MentionPicker.tsx`
- `spa/src/components/MessageList.tsx`
- `spa/src/components/ProviderPicker.tsx`

## Gotchas

- **Anthropic prompt caching** requires `cache_control: { type: "ephemeral" }` on the *last* content block you want cached. Cache TTL is 5 minutes by default. See [[04-Providers/Anthropic]].
- **Gemini** has different chat history shape (`role: "model"` not `"assistant"`). Provider adapter must translate.
- **OpenAI-compatible** — Ollama doesn't always honor `temperature` and other params correctly. Test against the actual server.
- **SSE in fetch** — use `ReadableStream` directly, don't pull in a heavy SSE library.

## Next: [[Phase-3-Inline-FIM]]
