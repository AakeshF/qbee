// OpenAI-compatible provider — covers Ollama, LM Studio, llama.cpp server, vLLM,
// OpenAI itself, OpenRouter, anything serving /v1/chat/completions and /v1/completions.
//
// We intentionally do NOT pull the openai SDK — too many backends quietly diverge
// from the official client (different auth, different streaming framing, missing
// tool-use). Native fetch + manual SSE parsing avoids that mess.

import type { ChatEvent, ChatMessage, ProviderConfig } from '@qbee/shared'
import type { ChatOptions, CompleteOptions, Provider, ProviderFactory } from './types.js'
import { pickFimTemplate } from './fim-templates.js'

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434/v1' // Ollama default

class OpenAICompatibleProvider implements Provider {
  readonly id = 'openai-compatible'

  constructor(
    private readonly config: ProviderConfig,
    private readonly getApiKey: (ref: string) => Promise<string | undefined>,
  ) {}

  private baseUrl(): string {
    return (this.config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '')
  }

  private async authHeaders(): Promise<Record<string, string>> {
    const key = this.config.apiKeyRef ? await this.getApiKey(this.config.apiKeyRef) : undefined
    return key ? { Authorization: `Bearer ${key}` } : {}
  }

  async *chat(opts: ChatOptions): AsyncIterable<ChatEvent> {
    const body = {
      model: this.config.model,
      messages: opts.messages.map((m: ChatMessage) => ({ role: m.role, content: m.content })),
      stream: true,
      ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    }

    let res: Response
    try {
      res = await fetch(`${this.baseUrl()}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await this.authHeaders()) },
        body: JSON.stringify(body),
        ...(opts.signal ? { signal: opts.signal } : {}),
      })
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        yield { type: 'done' }
        return
      }
      yield { type: 'error', message: `network error: ${(err as Error).message}` }
      return
    }

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '')
      yield { type: 'error', message: `${res.status} ${res.statusText}: ${text.slice(0, 200)}` }
      return
    }

    let inputTokens = 0
    let outputTokens = 0
    try {
      for await (const data of parseSSE(res.body)) {
        if (data === '[DONE]') break
        let chunk: any
        try {
          chunk = JSON.parse(data)
        } catch {
          continue
        }
        const delta = chunk.choices?.[0]?.delta
        if (delta?.content) {
          yield { type: 'text', value: delta.content }
        }
        // Some servers (vLLM, OpenRouter) emit usage on the final chunk.
        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens ?? 0
          outputTokens = chunk.usage.completion_tokens ?? 0
        }
      }
      yield { type: 'usage', inputTokens, outputTokens }
      yield { type: 'done' }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        yield { type: 'done' }
        return
      }
      yield { type: 'error', message: (err as Error).message }
    }
  }

  async *complete(opts: CompleteOptions): AsyncIterable<string> {
    // FIM via /v1/completions (the legacy endpoint, the only one that takes raw FIM-tokenized prompts).
    // Template is auto-detected from the model name (Qwen, DeepSeek, Codestral, StarCoder).
    const tpl = pickFimTemplate(this.config.model)
    const body = {
      model: this.config.model,
      prompt: tpl.format(opts.prefix, opts.suffix),
      stream: true,
      max_tokens: opts.maxTokens ?? 128,
      stop: tpl.stop,
    }

    const res = await fetch(`${this.baseUrl()}/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await this.authHeaders()) },
      body: JSON.stringify(body),
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
    if (!res.ok || !res.body) {
      throw new Error(`${res.status} ${res.statusText}: ${(await res.text()).slice(0, 200)}`)
    }

    for await (const data of parseSSE(res.body)) {
      if (data === '[DONE]') break
      try {
        const chunk = JSON.parse(data)
        const text: string | undefined = chunk.choices?.[0]?.text
        if (text) yield text
      } catch {
        continue
      }
    }
  }

  // Non-streaming FIM — collects the full completion. Useful for single-shot ghost-text rendering.
  async completeOnce(opts: CompleteOptions): Promise<string> {
    let out = ''
    for await (const chunk of this.complete(opts)) {
      out += chunk
    }
    return out
  }

  async embed(texts: string[]): Promise<{ vectors: number[][]; dim: number }> {
    const res = await fetch(`${this.baseUrl()}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await this.authHeaders()) },
      body: JSON.stringify({ model: this.config.model, input: texts }),
    })
    if (!res.ok) {
      throw new Error(`${res.status} ${res.statusText}: ${(await res.text()).slice(0, 200)}`)
    }
    const json = (await res.json()) as { data: Array<{ embedding: number[] }> }
    const vectors = json.data.map((d) => d.embedding)
    return { vectors, dim: vectors[0]?.length ?? 0 }
  }
}

// Generic SSE parser — yields each `data: ...` payload (without the prefix).
async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let idx
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (line.startsWith('data: ')) yield line.slice(6)
    }
  }
}

export const openaiFactory: ProviderFactory = {
  create: (config, getApiKey) => new OpenAICompatibleProvider(config, getApiKey),
}
