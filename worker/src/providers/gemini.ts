// Gemini provider — streams via @google/generative-ai.
//
// Gemini's chat history shape differs from Anthropic/OpenAI:
//   - role 'assistant' is called 'model' here
//   - system prompts are passed as `systemInstruction`, not in the message array
//   - tool roles flow through `functionCall` / `functionResponse` parts (deferred to Phase 4)

import { GoogleGenerativeAI, type Content } from '@google/generative-ai'
import type { ChatEvent, ChatMessage, ProviderConfig } from '@qbee/shared'
import type { ChatOptions, CompleteOptions, Provider, ProviderFactory } from './types.js'

class GeminiProvider implements Provider {
  readonly id = 'gemini'
  private client: GoogleGenerativeAI | null = null

  constructor(
    private readonly config: ProviderConfig,
    private readonly getApiKey: (ref: string) => Promise<string | undefined>,
  ) {}

  private async ensureClient(): Promise<GoogleGenerativeAI> {
    if (this.client) return this.client
    const key = this.config.apiKeyRef ? await this.getApiKey(this.config.apiKeyRef) : process.env.GEMINI_API_KEY
    if (!key) throw new Error('Gemini API key not configured. Set apiKeyRef on the provider config or GEMINI_API_KEY env var.')
    this.client = new GoogleGenerativeAI(key)
    return this.client
  }

  async *chat(opts: ChatOptions): AsyncIterable<ChatEvent> {
    const client = await this.ensureClient()
    const { systemInstruction, history } = translate(opts.messages)

    const model = client.getGenerativeModel({
      model: this.config.model,
      ...(systemInstruction ? { systemInstruction } : {}),
      ...(opts.maxTokens || opts.temperature !== undefined
        ? {
            generationConfig: {
              ...(opts.maxTokens ? { maxOutputTokens: opts.maxTokens } : {}),
              ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
            },
          }
        : {}),
    })

    if (history.length === 0) {
      yield { type: 'error', message: 'Gemini requires at least one user message.' }
      return
    }

    // Gemini's startChat takes prior history; the new message is sent separately.
    const last = history[history.length - 1]!
    const prior = history.slice(0, -1)

    let chatSession
    try {
      chatSession = model.startChat({ history: prior })
    } catch (err) {
      yield { type: 'error', message: (err as Error).message }
      return
    }

    try {
      const result = await chatSession.sendMessageStream(last.parts.map((p) => p.text ?? '').join(''))
      let inputTokens = 0
      let outputTokens = 0
      for await (const chunk of result.stream) {
        if (opts.signal?.aborted) break
        const text = chunk.text()
        if (text) yield { type: 'text', value: text }
      }
      const final = await result.response
      const usage = final.usageMetadata
      if (usage) {
        inputTokens = usage.promptTokenCount ?? 0
        outputTokens = usage.candidatesTokenCount ?? 0
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

  // eslint-disable-next-line require-yield
  async *complete(_opts: CompleteOptions): AsyncIterable<string> {
    throw new Error('Gemini provider does not support FIM completion. Use the openai-compatible provider.')
  }

  async embed(texts: string[]): Promise<{ vectors: number[][]; dim: number }> {
    const client = await this.ensureClient()
    const model = client.getGenerativeModel({ model: this.config.model })
    const res = await model.batchEmbedContents({
      requests: texts.map((t) => ({ content: { role: 'user', parts: [{ text: t }] } })),
    })
    const vectors = res.embeddings.map((e) => e.values)
    return { vectors, dim: vectors[0]?.length ?? 0 }
  }
}

function translate(messages: ChatMessage[]): { systemInstruction?: string; history: Content[] } {
  let systemInstruction: string | undefined
  const history: Content[] = []
  for (const m of messages) {
    if (m.role === 'system') {
      // If multiple system messages exist, concatenate (rare, but defensible).
      systemInstruction = systemInstruction ? `${systemInstruction}\n\n${m.content}` : m.content
      continue
    }
    history.push({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    })
  }
  return { ...(systemInstruction ? { systemInstruction } : {}), history }
}

export const geminiFactory: ProviderFactory = {
  create: (config, getApiKey) => new GeminiProvider(config, getApiKey),
}
