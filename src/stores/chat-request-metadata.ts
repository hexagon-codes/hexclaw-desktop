export function buildChatRequestMetadata(params: {
  thinkingEnabled: boolean
  memoryEnabled: boolean
}): Record<string, string> | undefined {
  const metadata: Record<string, string> = {}
  if (params.thinkingEnabled) metadata.thinking = 'on'
  if (!params.memoryEnabled) metadata.memory = 'off'
  return Object.keys(metadata).length > 0 ? metadata : undefined
}
