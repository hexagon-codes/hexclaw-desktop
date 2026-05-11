/**
 * ContextLoader — 同步、轻量、无 IO 的 Context 层加载工具
 *
 * 职责：
 * - Task → TaskLayer 投影（不引用原对象）
 * - System Layer 默认 policy 初始化
 * - 各 Layer 惰性创建（为 Phase 3+ 预留骨架）
 * - Execution Layer 卸载
 * - 近似大小估算
 *
 * 不做：
 * - 异步读取 / RAG / Skill 文件 / Memory 读取
 * - 销毁整个 Context
 * - 执行编排
 *
 * @see docs/agents-OS/Context-Contract.md
 */

import type { RuntimeContext, SystemLayer, TaskLayer, SkillLayer, ExecutionLayer, MemoryLayer } from '@/types'
import type { SkillPackage } from '@/types'
import type { Task } from '@/types'
import { DEFAULT_ALLOWED_CAPABILITIES } from '@/types/capability'
import { estimateSize } from '@/utils/sizeEstimator'

export class ContextLoader {
  /**
   * 将 Task 投影到 Task Layer（深拷贝，不引用原对象）
   */
  loadTaskLayer(context: RuntimeContext, task: Task): void {
    context.task = {
      taskId: task.id,
      taskType: task.type,
      status: task.status,
      goal: typeof task.input.payload === 'object' && task.input.payload !== null
        ? String((task.input.payload as Record<string, unknown>).text ?? '')
        : undefined,
      input: JSON.parse(JSON.stringify(task.input)),
      output: task.output ? JSON.parse(JSON.stringify(task.output)) : undefined,
      progress: task.progress,
      error: task.error ? { ...task.error } : undefined,
      metadata: task.metadata ? { ...task.metadata } : undefined,
      parentId: task.parentId,
      dependencies: task.dependencies ? [...task.dependencies] : undefined,
    }
    context.layerStates['task'] = 'loaded'
  }

  /**
   * 初始化 System Layer（默认 policy + 空约束列表）
   */
  loadSystemLayer(context: RuntimeContext): void {
    context.system = {
      policy: {
        allowedCapabilities: [...DEFAULT_ALLOWED_CAPABILITIES],
        deniedCapabilities: [],
        maxExecutionSteps: 100,
        maxToolCalls: 50,
        timeout: 300_000,
      },
      constraints: [],
      runtimeVersion: '0.4.0',
    }
    context.layerStates['system'] = 'loaded'
  }

  /**
   * 创建 Execution Layer，初始化状态机。
   * state = 'preparing', currentStage = 'preparing'。
   */
  prepareExecutionLayer(context: RuntimeContext): void {
    context.execution = {
      state: 'preparing',
      currentStage: 'preparing',
      stepCount: 0,
      intermediateState: {},
      startedAt: new Date().toISOString(),
    }
    context.layerStates['execution'] = 'loaded'
  }

  /**
   * 执行完成后将 execution 结果写入 memory。
   * Append-only concise memory，不 overwrite / merge / runtime snapshot。
   */
  writeExecutionMemory(context: RuntimeContext): void {
    if (!context.memory) {
      context.memory = {
        userConfirmations: [],
        historicalResults: [],
        generatedAssets: [],
        custom: {},
      }
      context.layerStates['memory'] = 'loaded'
    }

    if (context.execution) {
      context.memory.historicalResults.push({
        step: `execution.${context.execution.state}`,
        summary: `Execution ${context.execution.state} (${context.execution.stepCount} steps)`,
        timestamp: new Date().toISOString(),
      })
    }
  }

  /**
   * 创建空 Memory Layer（惰性，需要 Task 记忆时调用）
   */
  prepareMemoryLayer(context: RuntimeContext): void {
    context.memory = {
      userConfirmations: [],
      historicalResults: [],
      generatedAssets: [],
      custom: {},
    }
    context.layerStates['memory'] = 'loaded'
  }

  /**
   * 创建空 Skill Layer（为 Phase 3 Skill Runtime 预留）
   *
   * 仅设置 skillId，不读取任何 Skill 文件。
   */
  prepareSkillLayer(context: RuntimeContext, skillId?: string): void {
    context.skill = {
      skillId,
      capabilities: [],
      loadedSections: {
        markdown: 'unloaded',
        references: 'unloaded',
      },
    }
    context.layerStates['skill'] = 'loaded'
  }

  /**
   * 从 SkillPackage 注入 Skill Layer。
   *
   * loadedSections 明确反映加载状态：
   * - 'loaded'   — 请求加载且成功（内容可能为空）
   * - 'unloaded' — 未请求加载
   * - 'failed'   — 加载出错（Phase 3.1+ 支持）
   *
   * Skill 不修改 System Layer。
   */
  loadSkillLayer(context: RuntimeContext, skillPkg: SkillPackage): void {
    context.skill = {
      skillId: skillPkg.meta.skillId,
      skillName: skillPkg.meta.displayName,
      skillVersion: skillPkg.meta.version,
      markdown: skillPkg.markdown,
      references: skillPkg.references.length > 0 ? skillPkg.references : undefined,
      capabilities: skillPkg.meta.capabilities,
      loadedSections: {
        markdown: skillPkg.markdown !== undefined ? 'loaded' : 'unloaded',
        references: skillPkg.references.length > 0 ? 'loaded' : 'unloaded',
      },
    }
    context.layerStates['skill'] = 'loaded'
  }

  /**
   * 卸载不再需要的层。
   * Phase 2 策略：仅允许卸载 Execution Layer。
   * 不清除 System / Task / Memory。
   *
   * @returns 被卸载的层名列表
   */
  unloadStaleLayers(context: RuntimeContext): string[] {
    const unloaded: string[] = []

    // 仅卸载 Execution Layer（保留 System + Task + Memory）
    if (context.execution && context.layerStates['execution'] === 'loaded') {
      context.execution = undefined
      context.layerStates['execution'] = 'unloaded'
      unloaded.push('execution')
    }

    return unloaded
  }

  /**
   * 近似估算层大小（JSON 序列化长度）
   *
   * 不做复杂递归，直接 JSON.stringify 取 length。
   * undefined / null 返回 0。
   */
  estimateLayerSize(layer: unknown): number {
    return estimateSize(layer)
  }
}
