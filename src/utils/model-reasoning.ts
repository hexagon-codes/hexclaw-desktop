export function isQwenThinkingModel(model?: string): boolean {
  return /(?:^|[/_-])qwen3(?:[.:-]|\b)/i.test(model?.trim() ?? '')
}

export function withModelReasoningDefaults(
  model?: string,
  metadata?: Record<string, string>,
): Record<string, string> | undefined {
  const nextMetadata = { ...metadata }
  if (isQwenThinkingModel(model) && nextMetadata.thinking === undefined) {
    nextMetadata.thinking = 'off'
  }
  return Object.keys(nextMetadata).length > 0 ? nextMetadata : undefined
}
