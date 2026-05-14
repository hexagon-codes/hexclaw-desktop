/**
 * AgentAdapter — ContextAwareExecutor 真实实现
 *
 * 职责：
 * - buildPromptInput(context) → { system?, user: string }
 * - 调用 ChatCompletionProvider
 * - 映射 ProviderResult → TaskOutput
 *
 * 禁止：
 * - 写入 ctx.execution / timeline / store
 * - streaming / partial state
 * - toolCalls / agent loop / multi-step
 *
 * @see docs/1.md — 边界约束
 */

import type { Task, TaskStatus, RuntimeContext, TaskOutput } from '@/types'
import type { ContextAwareExecutor } from './taskExecutor'
import type { ChatCompletionProvider } from './providerAdapter'

// ─── Prompt Input ───────────────────────────────────────

/**
 * buildPromptInput — 从 RuntimeContext 提取 prompt 输入。
 *
 * Phase 1 保持极简：
 * { system?: string, user: string }
 *
 * 不是 Runtime canonical prompt format。
 * 避免 Chat payload structure 成为 Runtime 标准。
 */
export interface PromptInput {
  system?: string
  user: string
}

export function buildPromptInput(context: RuntimeContext): PromptInput {
  const taskLayer = context.task
  const systemLayer = context.system
  const skillLayer = context.skill

  // system prompt: Skill Layer markdown + System Layer 约束
  const parts: string[] = []
  if (skillLayer?.markdown) {
    // 替换 SKILL.md 中可能触发 model 内置 tool 调用的关键词（如 "summarize"）
    const sanitized = skillLayer.markdown
      .replace(/summarize/gi, '摘要')
    parts.push(`[MODE: DIRECT]
Output directly. No planning. No tool calls.`)
    parts.push(sanitized)
  }
  if (systemLayer?.constraints?.length) {
    parts.push(systemLayer.constraints.join('\n'))
  }
  const system = parts.length > 0 ? parts.join('\n\n') : undefined

  // user message 来自 Task Layer input
  const payload = taskLayer?.input?.payload
  let user = typeof payload?.text === 'string'
    ? payload.text
    : typeof payload?.message === 'string'
      ? payload.message
      : typeof payload?.goal === 'string'
        ? payload.goal
        : JSON.stringify(payload ?? {})

  // skill 执行：user message 末尾追加 mode 指令（兼容 recency bias 模型）
  if (skillLayer?.markdown) {
    user = `${user}\n\n[MODE: DIRECT]\nOutput directly. No tool calls. No search. Output immediately.`
  }

  return { system, user }
}

// ─── Agent Adapter — Chat 类型 ─────────────────────────

/**
 * RuntimeLLMExecutor — 替换现有 stub 的真实执行器。
 *
 * 执行流：
 *   buildPromptInput(context) → provider.execute(payload) → TaskOutput
 *
 * 不写入 RuntimeContext/Execution/Timeline。
 * 不处理 streaming。
 * 不处理 toolCalls。
 */
export class RuntimeLLMExecutor implements ContextAwareExecutor {
  constructor(private provider: ChatCompletionProvider) {}

  async execute(task: Task): Promise<TaskOutput> {
    // Fallback: 无 Context 时使用 Task input
    const user = typeof task.input.payload?.text === 'string'
      ? task.input.payload.text
      : JSON.stringify(task.input.payload ?? {})

    const result = await this.provider.execute({
      messages: [{ role: 'user', content: user }],
      model: '',
      provider: '',
    })

    return {
      result: { kind: 'text', content: result.content },
      usage: result.usage,
    }
  }

  /**
   * executeWithContext — 携带 RuntimeContext 执行。
   *
   * ✅ 只允许：
   *   read RuntimeContext → buildPromptInput
   *   provider.execute(payload)
   *   → TaskOutput
   *
   * ❌ 禁止：
   *   ctx.execution.output = ...（由 RuntimeStore 负责）
   *   timeline event
   *   streaming callback
   *   store mutation
   */
  async executeWithContext(task: Task, context: RuntimeContext): Promise<TaskOutput> {
    const prompt = buildPromptInput(context)

    const messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = []
    if (prompt.system) {
      messages.push({ role: 'system', content: prompt.system })
    }
    messages.push({ role: 'user', content: prompt.user })

    // 从 task 读取 model/provider 参数（由 Chat/user 指定，非 Runtime 固定）
    const model = task.input?.payload?.model as string ?? ''
    const provider = task.input?.payload?.provider as string ?? ''

    // skill 执行：使用真实 systemPrompt 独立字段，不嵌入 message 字符串。
    // providerAdapter.ts 在 systemPrompt truthy 时会自动过滤 system role，
    // 避免 Go backend 前置拼接导致重复。
    const isSkill = !!context.skill?.markdown
    const result = await this.provider.execute({
      messages,
      model,
      provider,
      systemPrompt: isSkill ? prompt.system : undefined,
    })

    return {
      result: { kind: 'text', content: result.content },
      usage: result.usage,
    }
  }

  async cancel(_taskId: string): Promise<void> {
    // Phase 1 不接入取消链路
  }

  getStatus(): TaskStatus {
    return 'pending'
  }
}
