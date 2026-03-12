import { ref } from 'vue'
import { defineStore } from 'pinia'
import { nanoid } from 'nanoid'
import {
  getSessions,
  getSessionMessages,
  sendChatStream,
  deleteSession as apiDeleteSession,
} from '@/api/chat'
import { trySafe } from '@/utils/errors'
import { logger } from '@/utils/logger'
import type { ChatMessage, ChatSession, ApiError } from '@/types'

const MAX_STREAM_SIZE = 1024 * 1024 // 1MB

export const useChatStore = defineStore('chat', () => {
  const sessions = ref<ChatSession[]>([])
  const currentSessionId = ref<string | null>(null)
  const messages = ref<ChatMessage[]>([])
  const streaming = ref(false)
  const streamingContent = ref('')
  const error = ref<ApiError | null>(null)

  let abortController: AbortController | null = null

  /** 加载会话列表 */
  async function loadSessions() {
    const [res, err] = await trySafe(() => getSessions(), '加载会话列表')
    if (res) {
      sessions.value = res.sessions || []
    }
    error.value = err
  }

  /** 选择会话 */
  async function selectSession(sessionId: string) {
    currentSessionId.value = sessionId
    const [res, err] = await trySafe(
      () => getSessionMessages(sessionId),
      '加载消息历史',
    )
    if (res) {
      messages.value = res.messages || []
    }
    error.value = err
  }

  /** 新建会话 */
  function newSession() {
    currentSessionId.value = null
    messages.value = []
    error.value = null
  }

  /** 发送消息 (SSE 流式) */
  async function sendMessage(text: string) {
    // 添加用户消息到列表
    const userMsg: ChatMessage = {
      id: nanoid(),
      role: 'user',
      content: text,
      timestamp: new Date().toISOString(),
    }
    messages.value.push(userMsg)

    streaming.value = true
    streamingContent.value = ''
    error.value = null

    abortController = new AbortController()

    const [stream, streamErr] = await trySafe(
      () =>
        sendChatStream(
          { message: text, session_id: currentSessionId.value || undefined },
          abortController!.signal,
        ),
      '发送消息',
    )

    if (streamErr || !stream) {
      error.value = streamErr
      messages.value.push({
        id: nanoid(),
        role: 'assistant',
        content: streamErr?.message ?? '发送失败',
        timestamp: new Date().toISOString(),
      })
      streaming.value = false
      abortController = null
      return
    }

    try {
      const reader = stream.getReader()

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        let parsed: any
        try {
          parsed = JSON.parse(value)
        } catch {
          streamingContent.value += value
          continue
        }
        if (parsed.content) {
          if (streamingContent.value.length + parsed.content.length > MAX_STREAM_SIZE) {
            throw new Error('流式内容超过最大限制')
          }
          streamingContent.value += parsed.content
        }
        if (parsed.session_id && !currentSessionId.value) {
          currentSessionId.value = parsed.session_id
        }
      }

      // 流结束，将内容转为正式消息
      messages.value.push({
        id: nanoid(),
        role: 'assistant',
        content: streamingContent.value,
        timestamp: new Date().toISOString(),
      })
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        logger.error('SSE 流读取异常', e)
      }
    } finally {
      streaming.value = false
      streamingContent.value = ''
      abortController = null
    }

    // 刷新会话列表
    loadSessions()
  }

  /** 停止流式输出 */
  function stopStreaming() {
    abortController?.abort()
    abortController = null
    streaming.value = false
    if (streamingContent.value) {
      messages.value.push({
        id: nanoid(),
        role: 'assistant',
        content: streamingContent.value,
        timestamp: new Date().toISOString(),
      })
      streamingContent.value = ''
    }
  }

  /** 删除会话 */
  async function deleteSession(sessionId: string) {
    const [, err] = await trySafe(() => apiDeleteSession(sessionId), '删除会话')
    if (!err) {
      sessions.value = sessions.value.filter((s) => s.id !== sessionId)
      if (currentSessionId.value === sessionId) {
        currentSessionId.value = null
        messages.value = []
      }
    }
    error.value = err
  }

  return {
    sessions,
    currentSessionId,
    messages,
    streaming,
    streamingContent,
    error,
    loadSessions,
    selectSession,
    newSession,
    sendMessage,
    stopStreaming,
    deleteSession,
  }
})
