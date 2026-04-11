import { ref, type Ref } from 'vue'
import type {
  ApiError,
  Artifact,
  ChatMessage,
  ChatMode,
  ChatSession,
  ExecMode,
} from '@/types'
import type { WebSocketStreamHandle } from '@/services/chatService'
import type { PendingToolApproval, SessionStreamState } from './chat-stream-helpers'

export type ChatParamsState = {
  provider?: string
  model?: string
  temperature?: number
  maxTokens?: number
}

export interface ChatStoreState {
  sessions: Ref<ChatSession[]>
  currentSessionId: Ref<string | null>
  messages: Ref<ChatMessage[]>
  streaming: Ref<boolean>
  streamingSessionId: Ref<string | null>
  streamingContent: Ref<string>
  streamingReasoning: Ref<string>
  streamingReasoningStartTime: Ref<number>
  error: Ref<ApiError | null>
  activeStreams: Ref<Record<string, SessionStreamState>>
  pendingSessionIds: Ref<Record<string, boolean>>
  draftSending: Ref<boolean>
  chatMode: Ref<ChatMode>
  execMode: Ref<ExecMode>
  agentRole: Ref<string>
  artifacts: Ref<Artifact[]>
  selectedArtifactId: Ref<string | null>
  showArtifacts: Ref<boolean>
  chatParams: Ref<ChatParamsState>
  thinkingEnabled: Ref<boolean>
  sending: Ref<boolean>
  pendingApprovals: Ref<Record<string, PendingToolApproval>>
  pendingSessionTitle: Ref<string | null>
  hasCustomTitle: Ref<boolean>
  pendingSuggestedTitleExpectation: Ref<Record<string, string>>
  streamingThinkingElapsed: Ref<number>
}

export interface ChatStoreRuntime {
  streamHandles: Map<string, WebSocketStreamHandle>
  pendingAutoTitleSync: Map<string, Promise<void>>
  cancelledSessions: Set<string>
  sessionSelectionGen: Ref<number>
  approvalCleanup: Ref<(() => void) | null>
  ensureSessionPromise: Ref<Promise<string> | null>
  thinkingTimer: Ref<ReturnType<typeof setInterval> | null>
}

export function createChatStoreState(): ChatStoreState {
  return {
    sessions: ref<ChatSession[]>([]),
    currentSessionId: ref<string | null>(null),
    messages: ref<ChatMessage[]>([]),
    streaming: ref(false),
    streamingSessionId: ref<string | null>(null),
    streamingContent: ref(''),
    streamingReasoning: ref(''),
    streamingReasoningStartTime: ref(0),
    error: ref<ApiError | null>(null),
    activeStreams: ref<Record<string, SessionStreamState>>({}),
    pendingSessionIds: ref<Record<string, boolean>>({}),
    draftSending: ref(false),
    chatMode: ref<ChatMode>('chat'),
    execMode: ref<ExecMode>('craft'),
    agentRole: ref(''),
    artifacts: ref<Artifact[]>([]),
    selectedArtifactId: ref<string | null>(null),
    showArtifacts: ref(false),
    chatParams: ref<ChatParamsState>({}),
    thinkingEnabled: ref(false),
    sending: ref(false),
    pendingApprovals: ref<Record<string, PendingToolApproval>>({}),
    pendingSessionTitle: ref<string | null>(null),
    hasCustomTitle: ref(false),
    pendingSuggestedTitleExpectation: ref<Record<string, string>>({}),
    streamingThinkingElapsed: ref(0),
  }
}

export function createChatStoreRuntime(): ChatStoreRuntime {
  return {
    streamHandles: new Map<string, WebSocketStreamHandle>(),
    pendingAutoTitleSync: new Map<string, Promise<void>>(),
    cancelledSessions: new Set<string>(),
    sessionSelectionGen: ref(0),
    approvalCleanup: ref<(() => void) | null>(null),
    ensureSessionPromise: ref<Promise<string> | null>(null),
    thinkingTimer: ref<ReturnType<typeof setInterval> | null>(null),
  }
}
