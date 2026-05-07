// FIM (fill-in-middle) templates by model family.
// Detected from a model-id substring; override by passing the template explicitly.

export type FimTemplate = {
  format: (prefix: string, suffix: string) => string
  stop: string[]
}

export const FIM_TEMPLATES: Record<string, FimTemplate> = {
  qwen: {
    format: (p, s) => `<|fim_prefix|>${p}<|fim_suffix|>${s}<|fim_middle|>`,
    stop: ['<|fim_prefix|>', '<|fim_suffix|>', '<|fim_middle|>', '<|endoftext|>', '<|im_end|>'],
  },
  deepseek: {
    format: (p, s) => `<｜fim▁begin｜>${p}<｜fim▁hole｜>${s}<｜fim▁end｜>`,
    stop: ['<｜fim▁begin｜>', '<｜fim▁hole｜>', '<｜fim▁end｜>', '<|EOT|>'],
  },
  codestral: {
    format: (p, s) => `[PREFIX]${p}[SUFFIX]${s}`,
    stop: ['[PREFIX]', '[SUFFIX]'],
  },
  starcoder: {
    format: (p, s) => `<fim_prefix>${p}<fim_suffix>${s}<fim_middle>`,
    stop: ['<fim_prefix>', '<fim_suffix>', '<fim_middle>', '<|endoftext|>'],
  },
}

export function pickFimTemplate(model: string): FimTemplate {
  const m = model.toLowerCase()
  if (m.includes('qwen')) return FIM_TEMPLATES.qwen!
  if (m.includes('deepseek')) return FIM_TEMPLATES.deepseek!
  if (m.includes('codestral')) return FIM_TEMPLATES.codestral!
  if (m.includes('starcoder')) return FIM_TEMPLATES.starcoder!
  // Default to Qwen format — works for most modern code models.
  return FIM_TEMPLATES.qwen!
}
