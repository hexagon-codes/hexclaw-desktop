import type { Ref } from 'vue'
import type { Artifact, ChatMessage, ChatSession } from '@/types'

export type MessageServiceModule = typeof import('@/services/messageService')
export type LoggerModule = typeof import('@/utils/logger').logger

export interface ChatSessionControllerParams {
  sessions: Ref<ChatSession[]>
  currentSessionId: Ref<string | null>
  messages: Ref<ChatMessage[]>
  artifacts: Ref<Artifact[]>
  selectedArtifactId: Ref<string | null>
  showArtifacts: Ref<boolean>
  error: Ref<import('@/types').ApiError | null>
  chatMode: Ref<import('@/types').ChatMode>
  agentRole: Ref<string>
  hasCustomTitle: Ref<boolean>
  pendingSessionTitle: Ref<string | null>
  pendingSessionIds: Ref<Record<string, boolean>>
  pendingSuggestedTitleExpectation: Ref<Record<string, string>>
  sessionSelectionGen: Ref<number>
  ensureSessionPromise: Ref<Promise<string> | null>
  cancelledSessions: Set<string>
  msgSvc: MessageServiceModule
  logger: LoggerModule
  createId: () => string
  syncStreamingMirrors: () => void
  isSessionStreaming: (sessionId: string) => boolean
  stopSessionStream: (sessionId: string, preservePartial?: boolean) => boolean
  resetSessionStream: (sessionId?: string | null) => void
  clearSessionCancelled: (sessionId: string) => void
  markSessionCancelled: (sessionId: string) => void
  extractArtifacts: (content: string, messageId: string) => void
}
