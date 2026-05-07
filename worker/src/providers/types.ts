// Provider interface — every backend implements this. See ../../docs/01-Architecture.md.
//
// New backend = new file in this directory + register in providers/index.ts.

import type { ChatEvent, ChatMessage, ProviderConfig } from '@qbee/shared'

export interface ChatOptions {
  messages: ChatMessage[]
  tools?: unknown[]
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal
}

export interface CompleteOptions {
  prefix: string
  suffix: string
  language: string
  maxTokens?: number
  signal?: AbortSignal
}

export interface Provider {
  readonly id: string
  chat(opts: ChatOptions): AsyncIterable<ChatEvent>
  complete(opts: CompleteOptions): AsyncIterable<string>
  embed(texts: string[]): Promise<{ vectors: number[][]; dim: number }>
}

export interface ProviderFactory {
  create(config: ProviderConfig, getApiKey: (ref: string) => Promise<string | undefined>): Provider
}
