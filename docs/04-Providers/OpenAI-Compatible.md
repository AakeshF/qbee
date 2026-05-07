# OpenAI-compatible provider

One adapter covers: **Ollama**, **LM Studio**, **llama.cpp server**, **vLLM**, **OpenAI itself**, **OpenRouter**, **Together**, **Groq**, etc. Configurable base URL + API key.

## Auth

- API key via `SecretStorage` (key name `qbee.providers.openai.apiKey` — leave empty for local)
- Base URL: default `http://localhost:11434/v1` (Ollama). User-configurable.

## Endpoints used

| Endpoint | When |
|---|---|
| `POST /v1/chat/completions` | Chat |
| `POST /v1/completions` | Inline FIM (raw completion, with FIM tokens in the prompt) |
| `POST /v1/embeddings` | RAG embeddings |
| `GET /v1/models` | Populate model picker |

## Streaming

Standard SSE. `data: {...}\n\ndata: [DONE]\n\n`. Each chunk is `{ choices: [{ delta: { content: "..." } }] }`.

## Local backend quirks

### Ollama
- Model picker should hit `GET /api/tags` (Ollama-native) or `GET /v1/models` (compat)
- Some params (`top_k`) aren't honored on the OpenAI-compat endpoint; use `/api/generate` if you need them
- Default port 11434
- `OLLAMA_KEEP_ALIVE` env on the server controls model unload; long-lived sessions benefit from `OLLAMA_KEEP_ALIVE=24h`

### LM Studio
- Default port 1234 (`/v1/...`)
- `lms server start` to launch from CLI
- Model picker: `GET /v1/models` works
- Honors most OpenAI params

### llama.cpp server
- `./llama-server -m model.gguf --port 8080 --jinja --reasoning-format deepseek`
- Embeddings: separate `/embedding` endpoint OR pass `--embedding` to enable on `/v1/embeddings`
- FIM: needs the right chat template / FIM tokens for the model

## FIM token templates

Stored in `worker/src/providers/fim-templates.ts`. Wire by model name pattern.

| Model family | Template |
|---|---|
| Qwen2.5-Coder | `<\|fim_prefix\|>{p}<\|fim_suffix\|>{s}<\|fim_middle\|>` |
| DeepSeek-Coder | `<｜fim▁begin｜>{p}<｜fim▁hole｜>{s}<｜fim▁end｜>` |
| Codestral | `[PREFIX]{p}[SUFFIX]{s}` |
| StarCoder2 | `<fim_prefix>{p}<fim_suffix>{s}<fim_middle>` |
| (unknown) | fall back to chat completion with a system prompt |

## Embeddings

Use a smaller, faster model than chat:
- `nomic-embed-text` (Ollama) — 768-dim, MIT license, 137M params
- `bge-small-en-v1.5` — 384-dim, smaller still
- `bge-large-en-v1.5` — 1024-dim, better recall, heavier

Store the embedding model name + dim in the RAG meta table; refuse to mix.

## Things that bite

- **Servers vary in tool-use support.** Ollama added it relatively recently; older versions return weird errors. Detect by trying once and falling back.
- **`stream: true` is required for SSE** — easy to forget
- **Token counting** — these endpoints don't always return `usage`. For local, count tokens client-side via `gpt-tokenizer` or `tiktoken-js`.
- **Connection refused** — almost always means the local server isn't running. Surface a friendly "is Ollama running?" message instead of a stack trace.
