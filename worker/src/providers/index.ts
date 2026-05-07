// Provider registry. New backend = new file in this directory + register here.

import type { ProviderConfig } from '@qbee/shared'
import type { Provider, ProviderFactory } from './types.js'
import { anthropicFactory } from './anthropic.js'
import { geminiFactory } from './gemini.js'
import { openaiFactory } from './openai.js'

const factories: Record<ProviderConfig['id'], ProviderFactory> = {
  'openai-compatible': openaiFactory,
  anthropic: anthropicFactory,
  gemini: geminiFactory,
  'local-llama': openaiFactory, // node-llama-cpp shim — Phase 6; openai-compat works for now
}

export function createProvider(config: ProviderConfig, getApiKey: (ref: string) => Promise<string | undefined>): Provider {
  const factory = factories[config.id]
  if (!factory) throw new Error(`Unknown provider id: ${config.id}`)
  return factory.create(config, getApiKey)
}
