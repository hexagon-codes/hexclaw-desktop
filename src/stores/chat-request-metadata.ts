export function buildChatRequestMetadata(params: {
  thinkingEnabled: boolean
  memoryEnabled: boolean
  imageGeneration?: boolean
  videoGeneration?: boolean
}): Record<string, string> | undefined {
  const metadata: Record<string, string> = {}
  if (params.thinkingEnabled) metadata.thinking = 'on'
  if (!params.memoryEnabled) metadata.memory = 'off'
  if (params.imageGeneration) metadata.image_generation = 'true'
  if (params.videoGeneration) metadata.video_generation = 'true'
  return Object.keys(metadata).length > 0 ? metadata : undefined
}
