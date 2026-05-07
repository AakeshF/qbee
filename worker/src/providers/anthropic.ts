// Anthropic provider — streams Claude messages via @anthropic-ai/sdk.
// Prompt caching is enabled on the system prompt and on the tool list (cache_control: ephemeral).
// Tool-use blocks are accumulated and emitted as one consolidated `tool_use` event with parsed input.

import Anthropic from '@anthropic-ai/sdk'
import type { ChatEvent, ChatMessage, ProviderConfig } from '@qbee/shared'
import type { ChatOptions, CompleteOptions, Provider, ProviderFactory } from './types.js'

type ToolDef = { name: string; description?: string; input_schema: Record<string, unknown> }

class AnthropicProvider implements Provider {
  readonly id = 'anthropic'
  private client: Anthropic | null = null

  constructor(
    private readonly config: ProviderConfig,
    private readonly getApiKey: (ref: string) => Promise<string | undefined>,
  ) {}

  private async ensureClient(): Promise<Anthropic> {
    if (this.client) return this.client
    const apiKey = this.config.apiKeyRef ? await this.getApiKey(this.config.apiKeyRef) : process.env.ANTHROPIC_API_KEY
    if (!apiKey) throw new Error('Anthropic API key not configured. Set apiKeyRef on the provider config or ANTHROPIC_API_KEY env var.')
    this.client = new Anthropic({ apiKey, baseURL: this.config.baseUrl })
    return this.client
  }

  async *chat(opts: ChatOptions): AsyncIterable<ChatEvent> {
    const client = await this.ensureClient()
    const { system, messages } = splitSystem(opts.messages)
    const tools = (opts.tools as ToolDef[] | undefined) ?? []

    try {
      // SDK 0.30.x exposes prompt caching under client.beta.promptCaching.
      // System and (when present) the last tool both carry cache_control: ephemeral so the
      // tool-use loop reads them from cache after the first turn.
      const cachedTools = tools.length > 0 ? withCacheBreakpoint(tools) : undefined
      const stream = client.beta.promptCaching.messages.stream({
        model: this.config.model,
        max_tokens: opts.maxTokens ?? 4096,
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        ...(system ? { system: [{ type: 'text' as const, text: system, cache_control: { type: 'ephemeral' as const } }] } : {}),
        ...(cachedTools ? { tools: cachedTools as any } : {}),
        messages: messages.map(toAnthropicMessage),
      })

      // Wire the abort signal — closing the stream cancels the underlying HTTP request.
      const onAbort = () => stream.controller.abort()
      opts.signal?.addEventListener('abort', onAbort, { once: true })

      // Track active tool-use blocks by content-block index so we can accumulate their JSON deltas.
      const pendingTools = new Map<number, { id: string; name: string; jsonBuffer: string }>()

      try {
        for await (const event of stream) {
          if (event.type === 'content_block_start') {
            if (event.content_block.type === 'tool_use') {
              pendingTools.set(event.index, { id: event.content_block.id, name: event.content_block.name, jsonBuffer: '' })
            }
          } else if (event.type === 'content_block_delta') {
            if (event.delta.type === 'text_delta') {
              yield { type: 'text', value: event.delta.text }
            } else if (event.delta.type === 'input_json_delta') {
              const pending = pendingTools.get(event.index)
              if (pending) pending.jsonBuffer += event.delta.partial_json
            }
          } else if (event.type === 'content_block_stop') {
            const pending = pendingTools.get(event.index)
            if (pending) {
              let parsed: unknown = {}
              try {
                parsed = pending.jsonBuffer ? JSON.parse(pending.jsonBuffer) : {}
              } catch (err) {
                yield { type: 'error', message: `failed to parse tool input for ${pending.name}: ${(err as Error).message}` }
                pendingTools.delete(event.index)
                continue
              }
              yield { type: 'tool_use', id: pending.id, name: pending.name, input: parsed }
              pendingTools.delete(event.index)
            }
          }
        }
        const final = await stream.finalMessage()
        yield {
          type: 'usage',
          inputTokens:
            final.usage.input_tokens +
            (final.usage.cache_read_input_tokens ?? 0) +
            (final.usage.cache_creation_input_tokens ?? 0),
          outputTokens: final.usage.output_tokens,
        }
        yield { type: 'done', stopReason: mapStopReason(final.stop_reason) }
      } finally {
        opts.signal?.removeEventListener('abort', onAbort)
      }
    } catch (err) {
      if (err instanceof Anthropic.APIError) {
        yield { type: 'error', message: `${err.status ?? 'API'} ${err.name}: ${err.message}` }
      } else if ((err as Error).name === 'AbortError') {
        yield { type: 'done' }
      } else {
        yield { type: 'error', message: (err as Error).message }
      }
    }
  }

  // eslint-disable-next-line require-yield
  async *complete(_opts: CompleteOptions): AsyncIterable<string> {
    throw new Error('Anthropic provider does not support FIM completion. Use the openai-compatible provider for FIM (e.g. Qwen2.5-Coder via Ollama).')
  }

  async embed(_texts: string[]): Promise<{ vectors: number[][]; dim: number }> {
    throw new Error('Anthropic provider does not support embeddings. Use Voyage AI or a local embedding model via the openai-compatible provider.')
  }
}

function splitSystem(messages: ChatMessage[]): { system?: string; messages: ChatMessage[] } {
  if (messages[0]?.role === 'system') {
    return { system: messages[0].content, messages: messages.slice(1) }
  }
  return { messages }
}

// Anthropic accepts the message turn shape with content as a string or a structured array.
// We translate ChatMessage with optional toolCalls/toolCallId into the structured form.
function toAnthropicMessage(m: ChatMessage): { role: 'user' | 'assistant'; content: any } {
  // Tool result: a "user" turn carrying a tool_result content block.
  if (m.role === 'tool' && m.toolCallId) {
    return {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }],
    }
  }
  // Assistant turn with prior tool_use blocks — re-emit them so the model can see its own calls.
  if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
    const blocks: any[] = []
    if (m.content) blocks.push({ type: 'text', text: m.content })
    for (const tc of m.toolCalls) {
      blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input })
    }
    return { role: 'assistant', content: blocks }
  }
  // Plain user/assistant text turn.
  return {
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content,
  }
}

// Put cache_control on the LAST tool so the whole tool list caches as one block.
function withCacheBreakpoint(tools: ToolDef[]): any[] {
  return tools.map((t, i) => (i === tools.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t))
}

function mapStopReason(reason: string | null): 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'unknown' {
  if (reason === 'end_turn' || reason === 'tool_use' || reason === 'max_tokens' || reason === 'stop_sequence') return reason
  return 'unknown'
}

export const anthropicFactory: ProviderFactory = {
  create: (config, getApiKey) => new AnthropicProvider(config, getApiKey),
}
