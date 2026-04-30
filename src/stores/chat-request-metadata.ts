export function buildChatRequestMetadata(params: {
  thinkingEnabled: boolean
  memoryEnabled: boolean
  imageGeneration?: boolean
  videoGeneration?: boolean
  /** Agent 策略模式：显式传递，避免 react 被空值误判为 auto */
  agentMode?: string
  /** v0.4.0 9.5：用户当前桌面端语言；后端按此调整 system prompt 输出语言偏好 */
  userLocale?: string
}): Record<string, string> | undefined {
  const metadata: Record<string, string> = {}
  if (params.thinkingEnabled) metadata.thinking = 'on'
  if (!params.memoryEnabled) metadata.memory = 'off'
  if (params.imageGeneration) metadata.image_generation = 'true'
  if (params.videoGeneration) metadata.video_generation = 'true'
  // 仅在非默认 zh-CN 时透传 user_locale，减少冗余
  if (params.userLocale && params.userLocale !== 'zh-CN') {
    metadata.user_locale = params.userLocale
  }
  // B1: 与后端 7+1 模式（engine/agent_mode.go）保持一致
  // 设计：默认 'auto' 不透传 —— 后端 ResolveMode 对空/未知/auto 等价处理，
  // 不发字段可减少冗余、避免破坏既有 metadata 期望。仅当用户显式选择非 auto
  // 模式时才透传 agent_mode。
  const explicitModes = new Set([
    'react',
    'plan-execute',
    'reflection',
    'tot',
    'self-reflect',
    'mem-augmented',
    'debate',
  ])
  if (params.agentMode && explicitModes.has(params.agentMode)) {
    metadata.agent_mode = params.agentMode
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined
}
