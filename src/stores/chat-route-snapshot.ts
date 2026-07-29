export interface ChatRouteParams {
  readonly provider?: string
  readonly model?: string
  readonly temperature?: number
  readonly maxTokens?: number
}

export interface ChatRouteSnapshot {
  readonly agentRole: string
  readonly chatParams: ChatRouteParams
  readonly thinkingEnabled: boolean
  readonly agentDisplayName?: string
  readonly recipientDisplayName?: string
}

interface SessionRouteModel {
  providerKey?: string
  model: string
}

export function freezeChatRouteSnapshot(input: {
  agentRole: string
  chatParams: ChatRouteParams
  thinkingEnabled: boolean
  agentDisplayName?: string
  recipientDisplayName?: string
  sessionModel?: SessionRouteModel | null
}): ChatRouteSnapshot {
  const chatParams: {
    provider?: string
    model?: string
    temperature?: number
    maxTokens?: number
  } = { ...input.chatParams }

  if (input.sessionModel) {
    chatParams.provider =
      input.sessionModel.model === 'auto'
        ? undefined
        : input.sessionModel.providerKey || undefined
    chatParams.model = input.sessionModel.model
  }

  return Object.freeze({
    agentRole: input.agentRole,
    chatParams: Object.freeze(chatParams),
    thinkingEnabled: input.thinkingEnabled,
    ...(input.agentDisplayName ? { agentDisplayName: input.agentDisplayName } : {}),
    ...(input.recipientDisplayName ? { recipientDisplayName: input.recipientDisplayName } : {}),
  })
}

export function resolveChatRouteSnapshot(
  explicitSnapshot: ChatRouteSnapshot | undefined,
  currentRoute: {
    agentRole: string
    chatParams: ChatRouteParams
    thinkingEnabled: boolean
    agentDisplayName?: string
    recipientDisplayName?: string
  },
): ChatRouteSnapshot {
  return explicitSnapshot ?? freezeChatRouteSnapshot(currentRoute)
}
