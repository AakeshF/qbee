# Gemini provider

SDK: `@google/generative-ai`. Used for chat + agent.

## Auth

API key via `SecretStorage` (key name `qbee.providers.gemini.apiKey`). Free tier available with rate limits.

## Models

| Use case | Model ID |
|---|---|
| Default | `gemini-2.5-pro` |
| Fast / cheap | `gemini-2.5-flash` |
| Long context | `gemini-2.5-pro` (2M context window) |

## Streaming

```ts
const stream = await model.generateContentStream({...})
for await (const chunk of stream.stream) {
  yield { type: 'text', value: chunk.text() }
}
```

## Conversion gotchas

Gemini's chat history shape differs from OpenAI/Anthropic:

| OpenAI/Anthropic | Gemini |
|---|---|
| `role: "user"` | `role: "user"` |
| `role: "assistant"` | `role: "model"` ← note |
| `role: "system"` | `systemInstruction` (top-level, not in messages) |
| `role: "tool"` | `functionResponse` part inside a user message |

Provider adapter must translate both directions.

## Tool use

Function calling is supported. Schema format is OpenAPI-ish (slightly different from Anthropic's JSON Schema). Provider adapter normalizes.

## Things that bite

- **No prompt caching** at the SDK level (as of writing) — Gemini has implicit caching but you can't control it
- **Safety filters** trigger on lots of code (especially security-related). Set `safetySettings` to `BLOCK_NONE` for all categories.
- **Token counting** — use `model.countTokens` before requests with large context to avoid surprises
- **Streaming + tool use** — function calls don't stream incrementally like Anthropic; you get the whole call at once
