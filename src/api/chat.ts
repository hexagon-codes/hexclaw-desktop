import { logger } from '@/utils/logger'
import { DESKTOP_USER_ID } from '@/constants'
import type { ChatMessage, ChatSession, ChatRequest } from '@/types'

export type { ChatMessage, ChatSession, ChatRequest }
export type { ToolCall } from '@/types'

/** 后端聊天响应 */
export interface BackendChatResponse {
  reply: string
  session_id: string
  tool_calls?: import('@/types').ToolCall[]
  metadata?: Record<string, unknown>
}

/**
 * 通过 hexclaw 后端发送聊天消息
 *
 * 走 Rust `backend_chat` 命令 → hexclaw 后端 POST /api/v1/chat
 * 后端处理完整 ReAct Agent 循环（含工具调用、RAG、搜索等）
 */
export async function sendChatViaBackend(
  message: string,
  options?: {
    sessionId?: string
    role?: string
    model?: string
    attachments?: { type: string; name: string; mime: string; data: string }[]
  },
): Promise<BackendChatResponse> {
  const { invoke } = await import('@tauri-apps/api/core')

  logger.debug(`→ backend_chat: ${message.slice(0, 50)}...`)

  const text = await invoke<string>('backend_chat', {
    params: {
      message,
      session_id: options?.sessionId || null,
      role: options?.role || null,
      user_id: DESKTOP_USER_ID,
      model: options?.model || null,
      attachments: options?.attachments || null,
    },
  })

  const result: BackendChatResponse = JSON.parse(text)
  logger.debug(`← backend_chat: reply=${result.reply.slice(0, 50)}... session=${result.session_id}`)
  return result
}

/** 兼容旧接口: 发送聊天消息 */
export function sendChat(req: ChatRequest) {
  return sendChatViaBackend(req.message, {
    sessionId: req.session_id,
    model: req.model,
  })
}

/**
 * 通过 Tauri Rust 端代理流式聊天请求（直连 LLM Provider，绕过 CORS）
 * 保留用于未来直连模式或后端不可用时的降级方案
 */
export async function sendStreamViaTauri(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: { role: string; content: string }[],
  params: { temperature?: number; max_tokens?: number },
  onChunk: (data: string) => void,
  onDone: () => void,
  onError: (msg: string) => void,
): Promise<{ requestId: string; unlisten: () => void }> {
  const { invoke } = await import('@tauri-apps/api/core')
  const { listen } = await import('@tauri-apps/api/event')
  const { nanoid } = await import('nanoid')

  const requestId = nanoid(12)

  logger.debug(`→ stream_chat request_id=${requestId} model=${model}`)

  const unlisten = await listen<{ request_id: string; event_type: string; data: string }>(
    'chat-stream',
    (event) => {
      if (event.payload.request_id !== requestId) return

      switch (event.payload.event_type) {
        case 'chunk':
          onChunk(event.payload.data)
          break
        case 'done':
          onDone()
          break
        case 'error':
          onError(event.payload.data)
          break
      }
    },
  )

  invoke('stream_chat', {
    params: {
      base_url: baseUrl,
      api_key: apiKey,
      model,
      messages,
      temperature: params.temperature ?? 0.7,
      max_tokens: params.max_tokens ?? 4096,
      request_id: requestId,
    },
  }).catch((err) => {
    onError(typeof err === 'string' ? err : (err instanceof Error ? err.message : '请求失败'))
  })

  return { requestId, unlisten }
}
