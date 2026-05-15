/**
 * AgentAdapter — ContextAwareExecutor 真实实现
 *
 * 职责：
 * - 调用 ChatCompletionProvider
 * - 映射 ProviderResult → TaskOutput
 * - Skill 输出验证 + 单次重试
 *
 * Prompt 构建逻辑已提取至 runtime/llmContract.ts。
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
import { buildPromptInput, detectOutputFormat, validateSkillOutput } from './runtime/llmContract'

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

    const model = task.input?.payload?.model as string ?? ''
    const provider = task.input?.payload?.provider as string ?? ''
    const isSkill = !!context.skill?.markdown

    const result = await this.provider.execute({
      messages,
      model,
      provider,
      systemPrompt: isSkill ? prompt.system : undefined,
      stop: isSkill ? ['\n\n'] : undefined,
    })

    // 输出验证 + 单次重试（仅 skill 执行）
    if (isSkill && context.skill?.markdown) {
      const format = detectOutputFormat(context.skill.markdown)
      const validation = validateSkillOutput(result.content, format)

      if (!validation.valid) {
        console.warn('[LLMExecutor] 输出格式验证失败，执行单次重试')
        const retryMessages = [
          ...messages,
          { role: 'user' as const, content: '[CORRECTION] Output ONLY in the exact format specified. No extra text.' },
        ]
        const retryResult = await this.provider.execute({
          messages: retryMessages,
          model,
          provider,
          systemPrompt: prompt.system,
          stop: ['\n\n'],
        })
        const retryValidation = validateSkillOutput(retryResult.content, format)
        if (retryValidation.valid) {
          return {
            result: { kind: 'text', content: retryValidation.cleaned ?? retryResult.content },
            usage: retryResult.usage,
          }
        }
        console.warn('[LLMExecutor] 重试后格式仍不合规，返回原始输出')
      } else if (validation.cleaned) {
        return {
          result: { kind: 'text', content: validation.cleaned },
          usage: result.usage,
        }
      }
    }

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
