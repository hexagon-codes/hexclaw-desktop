import { normalizeModelReasoningControl } from '@/config/model-contract'
import type {
  ModelReasoningControl,
  ModelReasoningSupport,
  ReasoningPolicy,
} from '@/types/settings'
import {
  cloneReasoningPolicy,
  normalizeReasoningPolicy,
} from '@/utils/reasoning-policy'

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
  readonly reasoningSupport: ModelReasoningSupport
  readonly reasoningPolicy: ReasoningPolicy
  readonly reasoningControl?: ModelReasoningControl
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
  reasoningSupport?: ModelReasoningSupport
  reasoningPolicy?: ReasoningPolicy
  reasoningControl?: ModelReasoningControl
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

  const reasoningPolicy = Object.freeze(cloneReasoningPolicy(normalizeReasoningPolicy(
    input.reasoningPolicy ?? (input.thinkingEnabled ? { mode: 'on' } : { mode: 'off' }),
  ))) as ReasoningPolicy
  const normalizedReasoningControl = normalizeModelReasoningControl(input.reasoningControl)
  const reasoningControl = normalizedReasoningControl
    ? Object.freeze({
        ...normalizedReasoningControl,
        ...(normalizedReasoningControl.allowed_efforts
          ? { allowed_efforts: Object.freeze([...normalizedReasoningControl.allowed_efforts]) }
          : {}),
      }) as ModelReasoningControl
    : undefined

  return Object.freeze({
    agentRole: input.agentRole,
    chatParams: Object.freeze(chatParams),
    thinkingEnabled: input.thinkingEnabled,
    reasoningSupport: input.reasoningSupport ?? 'unknown',
    reasoningPolicy,
    ...(reasoningControl ? { reasoningControl } : {}),
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
    reasoningSupport?: ModelReasoningSupport
    reasoningPolicy?: ReasoningPolicy
    reasoningControl?: ModelReasoningControl
    agentDisplayName?: string
    recipientDisplayName?: string
  },
): ChatRouteSnapshot {
  return explicitSnapshot ?? freezeChatRouteSnapshot(currentRoute)
}
