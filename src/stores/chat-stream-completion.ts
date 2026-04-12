import type { Ref } from 'vue'
import type { ChatMessage } from '@/types'
import { getAssistantDisplayContent, normalizeAssistantReasoning } from '@/utils/assistant-reply'
import { extractThinkTags } from '@/utils/think-tags'
import type { SessionStreamState } from './chat-stream-helpers'

type MessageServiceModule = typeof import('@/services/messageService')

export function createChatStreamCompletionController(params: {
  activeStreams: Ref<Record<string, SessionStreamState>>
  pendingSuggestedTitleExpectation: Ref<Record<string, string>>
  pendingAutoTitleSync: Map<string, Promise<void>>
  currentSessionId: Ref<string | null>
  msgSvc: MessageServiceModule
  createId: () => string
  loadSessions: () => Promise<void>
  setLocalSessionTitle: (sessionId: string, title: string) => void
  setPendingSuggestedTitleExpectation: (sessionId: string, expectedTitle: string | null) => void
  bumpLocalSession: (sessionId: string) => void
  extractArtifacts: (content: string, messageId: string) => void
  appendMessageToSession: (sessionId: string, message: ChatMessage) => void
  resetSessionStream: (
    sessionId?: string | null,
    sending?: Ref<boolean>,
    draftSending?: Ref<boolean>,
  ) => void
}) {
  const {
    activeStreams,
    pendingSuggestedTitleExpectation,
    pendingAutoTitleSync,
    currentSessionId,
    msgSvc,
    createId,
    loadSessions,
    setLocalSessionTitle,
    setPendingSuggestedTitleExpectation,
    bumpLocalSession,
    extractArtifacts,
    appendMessageToSession,
    resetSessionStream,
  } = params

  function finalizeAssistantMessage(args: {
    content: string
    sessionId: string
    metadata?: Record<string, unknown>
    toolCalls?: ChatMessage['tool_calls']
    agentName?: string
    reasoning?: string
    sending?: Ref<boolean>
    draftSending?: Ref<boolean>
  }): ChatMessage {
    const parsed = extractThinkTags(args.content || '')
    const finalContent = parsed.content
    const rawReasoning = parsed.reasoning
      ? (args.reasoning ? args.reasoning + '\n' + parsed.reasoning : parsed.reasoning)
      : (args.reasoning || undefined)
    const finalReasoning = rawReasoning ? normalizeAssistantReasoning(rawReasoning) || undefined : undefined

    const streamState = activeStreams.value[args.sessionId]
    const thinkingDuration = streamState?.reasoningStartTime
      ? Math.round((Date.now() - streamState.reasoningStartTime) / 1000)
      : 0
    const metadata = { ...args.metadata } as Record<string, unknown>
    if (thinkingDuration > 0) metadata.thinking_duration = thinkingDuration

    const assistantMessage: ChatMessage = {
      id: createId(),
      role: 'assistant',
      content: getAssistantDisplayContent(finalContent, finalReasoning),
      timestamp: new Date().toISOString(),
      reasoning: finalReasoning,
      metadata,
      tool_calls: args.toolCalls,
      agent_name: args.agentName,
    }

    appendMessageToSession(args.sessionId, assistantMessage)
    bumpLocalSession(args.sessionId)

    // 简化标题流程：直接调 suggest-title（不传 expectedTitle），后端无条件生成并写入
    const shouldSuggestTitle = !!pendingSuggestedTitleExpectation.value[args.sessionId]
    setPendingSuggestedTitleExpectation(args.sessionId, null)

    void (async () => {
      try {
        if (shouldSuggestTitle) {
          // 等待临时标题 PATCH 完成
          const titleSync = pendingAutoTitleSync.get(args.sessionId)
          if (titleSync) await titleSync

          // 调用后端生成标题（不传 expectedTitle，让后端直接覆盖）
          const result = await msgSvc.suggestSessionTitle?.(args.sessionId, '')
          if (result?.updated && result.title) {
            setLocalSessionTitle(args.sessionId, result.title)
          }
        }
      } catch {
        // best-effort，失败保留临时标题
      } finally {
        void loadSessions()
      }
    })()

    msgSvc.touchSession(args.sessionId).catch(() => {})
    if (currentSessionId.value === args.sessionId) {
      extractArtifacts(finalContent, assistantMessage.id)
    }
    resetSessionStream(args.sessionId, args.sending, args.draftSending)
    return assistantMessage
  }

  return {
    finalizeAssistantMessage,
  }
}
