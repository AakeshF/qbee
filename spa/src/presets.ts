// Shared provider preset list. Both the chat panel (App.tsx) and the agent panel
// (Agent.tsx) pick from this list independently — chat and agent can run on
// different providers/models in the same session.

import type { LocalModelSource, ProviderConfig } from '@qbee/shared'

export type ProviderPreset = {
  label: string
  config: ProviderConfig
}

// Preset indices used in code (don't reorder casually; persisted to localStorage).
//   0 — Ollama (local)
//   1 — Anthropic Claude
//   2 — Google Gemini
//   3 — LM Studio (local)
//   4 — llama.cpp (local)
export const DEFAULT_PRESETS: ProviderPreset[] = [
  { label: 'Ollama (local)',     config: { id: 'openai-compatible', model: 'qwen2.5-coder:7b',         baseUrl: 'http://127.0.0.1:11434/v1' } },
  { label: 'Anthropic Claude',   config: { id: 'anthropic',         model: 'claude-sonnet-4-5',        apiKeyRef: 'ANTHROPIC_API_KEY' } },
  { label: 'Google Gemini',      config: { id: 'gemini',            model: 'gemini-2.0-flash',         apiKeyRef: 'GEMINI_API_KEY' } },
  { label: 'LM Studio (local)',  config: { id: 'openai-compatible', model: 'lmstudio-community/Qwen2.5-Coder-7B-Instruct-GGUF', baseUrl: 'http://127.0.0.1:1234/v1' } },
  { label: 'llama.cpp (local)',  config: { id: 'openai-compatible', model: 'qwen2.5-coder',            baseUrl: 'http://127.0.0.1:8080/v1' } },
]

// Map an auto-detected local-model source to its preset index. Used by the
// Dashboard's "→ chat / → agent / → FIM / → embed" quick-apply buttons so a
// model discovered at LM Studio's port doesn't get routed to Ollama's preset.
export function presetIdxForLocalSource(source: LocalModelSource): number {
  switch (source) {
    case 'ollama':    return 0
    case 'lm-studio': return 3
    case 'llama-cpp': return 4
  }
}

// Resolve a provider config for a given saved (presetIdx, model) pair. Falls back
// to the first preset if the stored index is out of range.
export function resolveProvider(presetIdx: number, model: string): ProviderConfig {
  const preset = DEFAULT_PRESETS[presetIdx] ?? DEFAULT_PRESETS[0]!
  return { ...preset.config, model }
}
