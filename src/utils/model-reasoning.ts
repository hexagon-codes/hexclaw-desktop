export function isQwenThinkingModel(model?: string): boolean {
  return /(?:^|[/_-])qwen3(?:[.:-]|\b)/i.test(model?.trim() ?? '')
}

export function withModelReasoningDefaults(
  _model?: string,
  metadata?: Record<string, string>,
): Record<string, string> | undefined {
  const nextMetadata = { ...metadata }
  return Object.keys(nextMetadata).length > 0 ? nextMetadata : undefined
}
