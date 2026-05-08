// Shared provider preset list. Both the chat panel (App.tsx) and the agent panel
// (Agent.tsx) pick from this list independently — chat and agent can run on
// different providers/models in the same session.

import type { ProviderConfig } from '@qbee/shared'

export type ProviderPreset = {
  label: string
  config: ProviderConfig
}

export const DEFAULT_PRESETS: ProviderPreset[] = [
  { label: 'Ollama (local)', config: { id: 'openai-compatible', model: 'qwen2.5-coder:7b', baseUrl: 'http://127.0.0.1:11434/v1' } },
  { label: 'Anthropic Claude', config: { id: 'anthropic', model: 'claude-sonnet-4-5', apiKeyRef: 'ANTHROPIC_API_KEY' } },
  { label: 'Google Gemini', config: { id: 'gemini', model: 'gemini-2.0-flash', apiKeyRef: 'GEMINI_API_KEY' } },
]

// Resolve a provider config for a given saved (presetIdx, model) pair. Falls back
// to the first preset if the stored index is out of range.
export function resolveProvider(presetIdx: number, model: string): ProviderConfig {
  const preset = DEFAULT_PRESETS[presetIdx] ?? DEFAULT_PRESETS[0]!
  return { ...preset.config, model }
}
