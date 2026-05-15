/**
 * BackendLLMClient — LLM 后端调用传输层
 *
 * 职责：
 * - transport only
 * - Tauri invoke('backend_chat') 发送请求
 * - 返回 raw response（string）
 *
 * 不做：
 * - JSON.parse（由 ProviderAdapter 负责 protocol parse）
 * - session/role/user_id 管理（由 Chat 层负责）
 * - streaming（Phase 1 不做）
 *
 * @see docs/1.md — transport/protocol boundary 分离
 */

export interface LLMBackendRequest {
  message: string
  systemPrompt?: string
  model?: string
  provider?: string
  temperature?: number
  maxTokens?: number
  stop?: string[]
  metadata?: Record<string, string>
  requestId?: string
}

export class BackendLLMClient {
  /**
   * 发送 LLM 请求，返回 raw response 字符串。
   *
   * transport only：
   * - 不 JSON.parse
   * - 不处理业务错误
   * - 只做 invoke + 基础网络错误
   */
  async send(req: LLMBackendRequest): Promise<string> {
    const { invoke } = await import('@tauri-apps/api/core')

    // 生成唯一 request_id 避免 Go backend 消息缓存
    const requestId = req.requestId ?? `llm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    const text = await invoke<string>('backend_chat', {
      params: {
        message: req.message,
        system_prompt: req.systemPrompt ?? null,
        model: req.model ?? null,
        provider: req.provider ?? null,
        temperature: req.temperature ?? null,
        max_tokens: req.maxTokens ?? null,
        stop: req.stop ?? null,
        request_id: requestId,
        metadata: req.metadata ?? null,
      },
    })

    return text
  }
}
