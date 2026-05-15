import type { Ref } from 'vue'
import { DEFAULT_SESSION_TITLE } from '@/constants'
import type { ChatAttachment, ChatMessage } from '@/types'
import type { Task } from '@/types'
import { useTaskStore } from '@/stores/tasks'
import { registerChatTask, executeChatTask } from '@/services/runtimeBridge'
import { buildAssistantMessage } from '@/utils/buildAssistantMessage'
import { createChatSendAutoTitleController } from './chat-send-auto-title'
import { shouldBlockChatSend, shouldSeedChatAutoTitle } from './chat-send-guards'
import { tryExecuteSkill } from '@/services/skillBridge'

type MessageServiceModule = typeof import('@/services/messageService')

export function createChatSendController(params: {
  currentSessionId: Ref<string | null>
  messages: Ref<ChatMessage[]>
  pendingSessionIds: Ref<Record<string, boolean>>
  draftSending: Ref<boolean>
  hasCustomTitle: Ref<boolean>
  sessions: Ref<import('@/types').ChatSession[]>
  msgSvc: MessageServiceModule
  createId: () => string
  defaultSessionTitle?: string
  ensureSession: () => Promise<string>
  clearSessionCancelled: (sessionId: string) => void
  isSessionCancelled: (sessionId: string) => boolean
  isSessionStreaming: (sessionId: string) => boolean
  refreshSendingState: (sending: Ref<boolean>, draftSending: Ref<boolean>) => void
  setLocalSessionTitle: (sessionId: string, title: string) => void
  setPendingSuggestedTitleExpectation: (sessionId: string, expectedTitle: string | null) => void
  pendingAutoTitleSync: Map<string, Promise<void>>
  persistMessage: (message: ChatMessage, sessionId: string) => Promise<boolean>
  handleSendError: (
    errorValue: unknown,
    sessionId: string | null | undefined,
    sending: Ref<boolean>,
    draftSending: Ref<boolean>,
  ) => void
  sending: Ref<boolean>
}) {
  const {
    currentSessionId,
    messages,
    pendingSessionIds,
    draftSending,
    hasCustomTitle,
    sessions,
    msgSvc,
    createId,
    defaultSessionTitle = DEFAULT_SESSION_TITLE,
    ensureSession,
    clearSessionCancelled,
    isSessionCancelled,
    isSessionStreaming,
    refreshSendingState,
    setLocalSessionTitle,
    setPendingSuggestedTitleExpectation,
    pendingAutoTitleSync,
    persistMessage,
    handleSendError,
    sending,
  } = params

  const autoTitleController = createChatSendAutoTitleController({
    msgSvc,
    pendingAutoTitleSync,
    setLocalSessionTitle,
    setPendingSuggestedTitleExpectation,
    defaultSessionTitle,
  })

  async function sendMessage(
    text: string,
    attachments?: ChatAttachment[],
    options?: { backendText?: string },
  ): Promise<ChatMessage | null> {
    const initialSessionId = currentSessionId.value
    const shouldSeedAutoTitle = shouldSeedChatAutoTitle({
      hasCustomTitle: hasCustomTitle.value,
      initialSessionId,
      messages: messages.value,
      sessions: sessions.value,
      defaultSessionTitle,
    })
    if (shouldBlockChatSend({
      initialSessionId,
      pendingSessionIds: pendingSessionIds.value,
      draftSending: draftSending.value,
      isSessionStreaming,
    })) {
      return null
    }
    draftSending.value = !initialSessionId
    refreshSendingState(sending, draftSending)

    // ── Skill Invocation 检测 ──────────────────────
    const skillMsg = await tryExecuteSkill(text, {
      createId,
      messages,
      sending,
      draftSending,
      handleSendError,
    })
    if (skillMsg !== undefined) return skillMsg

    // ── Task 生命周期注册 ──────────────────────────────
    const $taskId = createId()
    const $taskStore = useTaskStore()
    const $chatTask: Task = {
      id: $taskId,
      type: 'chat',
      status: 'running',
      input: { type: 'chat', payload: { text, backendText: options?.backendText, attachments } },
    }
    $taskStore.enqueue($chatTask)
    registerChatTask($chatTask)

    try {
      const backendText = options?.backendText ?? text
      const requestId = $taskId
      const userMessage: ChatMessage = {
        id: requestId,
        role: 'user',
        content: text,
        timestamp: new Date().toISOString(),
        metadata: attachments?.length ? { attachments } : undefined,
      }
      messages.value.push(userMessage)
      const sessionId = await ensureSession()
      $chatTask.sessionId = sessionId
      $chatTask.metadata = { source: 'chat', createdAt: new Date().toISOString() }
      // ensureSession 完成后立即释放 draftSending，不再阻塞后续发送
      draftSending.value = false
      refreshSendingState(sending, draftSending)
      if (pendingSessionIds.value[sessionId] || isSessionStreaming(sessionId)) {
        $taskStore.cancelTask($taskId)
        return null
      }

      if (shouldSeedAutoTitle) {
        autoTitleController.seedAutoTitle(sessionId, text)
      }

      // 持久化与发送并行，失败不阻塞（persistMessage 内部已有日志）
      void persistMessage(userMessage, sessionId).catch(() => {})

      // ── Runtime 执行（唯一路径）──────────────────────
      const runtimeStartedAt = Date.now()
      const result = await executeChatTask($taskId)
      const assistantMsg = buildAssistantMessage(result.content, {
        id: createId(),
        metadata: {
          taskId: $taskId,
          runtimeStatus: 'completed',
          elapsed: Date.now() - runtimeStartedAt,
        },
      })
      messages.value.push(assistantMsg)
      void persistMessage(assistantMsg, sessionId).catch(() => {})

      // D1: Auto-title suggestion
      const shouldSuggestTitle = !!pendingSuggestedTitleExpectation.value[sessionId]
      setPendingSuggestedTitleExpectation(sessionId, null)
      void (async () => {
        if (shouldSuggestTitle) {
          const titleSync = pendingAutoTitleSync.get(sessionId)
          if (titleSync) await titleSync
          const result = await msgSvc.suggestSessionTitle?.(sessionId, '')
          if (result?.updated && result.title) {
            setLocalSessionTitle(sessionId, result.title)
          }
        }
      })()

      return assistantMsg
    } catch (e) {
      // executeChatTask 内部已处理 TaskStore fail + Runtime timeline
      handleSendError(e, currentSessionId.value, sending, draftSending)
      return null
    } finally {
      draftSending.value = false
      refreshSendingState(sending, draftSending)
    }
  }

  return {
    sendMessage,
  }
}
