# Anthropic provider

SDK: `@anthropic-ai/sdk`. Used for chat + agent mode (best-in-class tool use).

## Auth

API key via `SecretStorage` (key name `qbee.providers.anthropic.apiKey`). Never log it. Never include it in any worker stdout.

## Models

| Use case | Model ID |
|---|---|
| Default chat / agent | `claude-sonnet-4-6` |
| Heavy agent runs | `claude-opus-4-7` |
| Cheap fallback | `claude-haiku-4-5-20251001` |

Model IDs are user-overridable in settings. Validate by attempting a 1-token request before saving.

## Streaming

```ts
const stream = await client.messages.stream({...})
for await (const event of stream) {
  if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
    yield { type: 'text', value: event.delta.text }
  }
  if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
    yield { type: 'tool_use_start', id: event.content_block.id, name: event.content_block.name }
  }
  if (event.type === 'content_block_delta' && event.delta.type === 'input_json_delta') {
    yield { type: 'tool_use_delta', value: event.delta.partial_json }
  }
}
```

## Prompt caching — *enable from day one*

Anthropic's prompt cache cuts repeat-context cost by ~90% and latency significantly. The architecture should bake this in, not bolt it on later.

Where to put `cache_control: { type: "ephemeral" }`:
1. **System prompt** — long fixed instructions
2. **Tool definitions** — they're big and fixed across a turn
3. **Earlier conversation turns** — once a turn is "old", mark its end with a cache breakpoint

```ts
{
  system: [
    { type: "text", text: longSystemPrompt, cache_control: { type: "ephemeral" } }
  ],
  tools: tools.map((t, i) =>
    i === tools.length - 1
      ? { ...t, cache_control: { type: "ephemeral" } }
      : t
  ),
  messages: [...]
}
```

Cache TTL is 5 minutes by default (1 hour on certain tiers). Two breakpoints per request max (Anthropic's API limit at time of writing — verify).

## Tool use

Tools are defined as JSON Schema:
```ts
{
  name: "read_file",
  description: "Read a file from the workspace",
  input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
}
```

Loop: send messages, get response, if `stop_reason === "tool_use"`, run the tool, append `{role: "user", content: [{type: "tool_result", tool_use_id, content}]}` and recurse.

## Rate limits

5 RPM on free tier, much higher on paid. Implement backoff on 429: wait `retry-after` seconds + jitter.

## Things that bite

- **`max_tokens` is required** — pick something generous (8192 default), but cap to model max
- **Tool input streaming is per-character JSON** — accumulate and parse-on-complete; don't try to incremental-parse
- **Stop reason `max_tokens`** means you should ask the model to continue; don't error
- **Errors don't always have nice JSON bodies** — handle `error.status`, `error.message` defensively
