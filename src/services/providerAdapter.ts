/**
 * ProviderAdapter — LLM Provider 调用层
 *
 * 职责：
 * - protocol parse（JSON.parse raw response）
 * - 标准 ChatCompletionProvider 接口
 *
 * 不做：
 * - transport（由 BackendLLMClient 负责）
 * - streaming（Phase 1 不做）
 * - toolCalls / tool runtime
 * - provider taxonomy（仅保留 ChatCompletionProvider）
 *
 * @see docs/1.md — transport/protocol boundary 分离
 */

import { BackendLLMClient } from './backendLLMClient'

// ─── Types ──────────────────────────────────────────────

/** Provider Payload — 只含 LLM chat completion 所需字段 */
export interface ChatCompletionPayload {
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>
  model: string
  provider: string
  temperature?: number
  maxTokens?: number
  systemPrompt?: string
}

/** Provider Result — 不含 toolCalls，不含 stream state */
export interface ChatCompletionResult {
  content: string
  usage?: {
    inputTokens?: number
    outputTokens?: number
  }
  finishReason?: string
}

/** Provider Adapter 统一接口 */
export interface ChatCompletionProvider {
  execute(payload: ChatCompletionPayload): Promise<ChatCompletionResult>
}

// ─── Backend Provider ───────────────────────────────────

/** 后端 Chat Backend 响应格式 */
interface BackendChatResponse {
  reply: string
  usage?: {
    input_tokens?: number
    output_tokens?: number
    total_tokens?: number
  }
  finish_reason?: string
}

/**
 * BackendChatProvider — 通过 BackendLLMClient 调用后端 LLM。
 *
 * 职责：
 * - 调用 BackendLLMClient.send()
 * - JSON.parse raw response → BackendChatResponse
 * - 映射为 ChatCompletionResult
 *
 * protocol parse 在此层完成，transport 层只返回 raw string。
 */
export class BackendChatProvider implements ChatCompletionProvider {
  constructor(private client: BackendLLMClient) {}

  async execute(payload: ChatCompletionPayload): Promise<ChatCompletionResult> {
    // 1. 构造 transport 请求
    // systemPrompt 已作为单独字段发送，message 中排除 system role 避免重复
    const msgParts = payload.systemPrompt
      ? payload.messages.filter(m => m.role !== 'system').map(m => `${m.role}: ${m.content}`)
      : payload.messages.map(m => `${m.role}: ${m.content}`)
    const message = msgParts.join('\n')

    // 2. transport — 只返回 raw string
    const raw = await this.client.send({
      message,
      systemPrompt: payload.systemPrompt,
      model: payload.model,
      provider: payload.provider,
      temperature: payload.temperature,
      maxTokens: payload.maxTokens,
    })

    // 3. protocol parse（在此层，不在 transport 层）
    let parsed: BackendChatResponse
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error(`Provider protocol parse error: 非 JSON 响应: ${raw.slice(0, 200)}`)
    }

    // 4. 映射为 ChatCompletionResult
    return {
      content: parsed.reply,
      usage: parsed.usage
        ? {
            inputTokens: parsed.usage.input_tokens,
            outputTokens: parsed.usage.output_tokens,
          }
        : undefined,
      finishReason: parsed.finish_reason ?? 'stop',
    }
  }
}

// ─── Factory ────────────────────────────────────────────

/**
 * 创建 ChatCompletionProvider 实例。
 *
 * Phase 1 仅支持 BackendChatProvider（通过 Tauri invoke 调用后端）。
 * 后续可扩展直接 Provider 调用而不影响接口。
 */
export function createChatProvider(): ChatCompletionProvider {
  return new BackendChatProvider(new BackendLLMClient())
}
