/**
 * ContextManager — Context 创建/销毁/层生命周期管理
 *
 * 纯服务类，不依赖 Pinia。
 * 内部使用 Map 管理活跃 Context，每个 Task 拥有独立实例（Task 隔离）。
 *
 * @see docs/agents-OS/Context-Contract.md
 */

import type {
  RuntimeContext,
  ContextLayerStatus,
  SystemLayer,
  TaskLayer,
  SkillLayer,
  ExecutionLayer,
  MemoryLayer,
} from '@/types'
import type { RuntimeEvent } from '@/types/timeline'
import { estimateSize } from '@/utils/sizeEstimator'
import { DEFAULT_BUDGET } from '@/types/runtimeBudget'
import { DEFAULT_ALLOWED_CAPABILITIES } from '@/types/capability'
import { getRuntimeLogger } from '@/services/runtime/runtimeLogger'

// ─── Event Callback ─────────────────────────────────────

export type ContextManagerEventCallback = (
  event: Omit<RuntimeEvent, 'id' | 'timestamp'>,
) => void

// ─── Default System Layer ──────────────────────────────

const DEFAULT_SYSTEM_LAYER: SystemLayer = {
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

// ─── ContextManager ────────────────────────────────────

export class ContextManager {
  private contexts: Map<string, RuntimeContext> = new Map()
  private onEvent?: ContextManagerEventCallback

  constructor(onEvent?: ContextManagerEventCallback) {
    this.onEvent = onEvent
  }

  // ── Context 生命周期 ────────────────────────────────

  /**
   * 创建新 Context，初始化 System Layer。
   * Task 隔离规则：同 taskId 已存在时不覆盖，返回已有 Context。
   */
  createContext(taskId: string, taskType: RuntimeContext['taskType']): RuntimeContext {
    const existing = this.contexts.get(taskId)
    if (existing) return existing

    const now = new Date().toISOString()
    const context: RuntimeContext = {
      taskId,
      taskType,
      system: { ...DEFAULT_SYSTEM_LAYER, constraints: [...DEFAULT_SYSTEM_LAYER.constraints] },
      layerStates: {
        system: 'loaded',
        skill: 'unloaded',
        task: 'unloaded',
        execution: 'unloaded',
        memory: 'unloaded',
      },
      createdAt: now,
      updatedAt: now,
      totalEstimatedSize: estimateSize({ system: undefined }),
    }

    this.contexts.set(taskId, context)

    this.onEvent?.({
      type: 'context.created',
      taskId,
      payload: { summary: `Context 已创建 (${taskType})` },
    })

    return context
  }

  /** 销毁 Context 并从 Map 移除 */
  destroyContext(taskId: string): void {
    this.contexts.delete(taskId)
  }

  /** 按 taskId 获取 Context */
  getContext(taskId: string): RuntimeContext | undefined {
    return this.contexts.get(taskId)
  }

  /** 获取所有活跃 Context 列表 */
  getAllContexts(): RuntimeContext[] {
    return Array.from(this.contexts.values())
  }

  /** 检查指定 taskId 是否存在活跃 Context */
  hasContext(taskId: string): boolean {
    return this.contexts.has(taskId)
  }

  // ── 层生命周期 ──────────────────────────────────────

  /** 加载指定层（标记为 loaded） */
  loadLayer(taskId: string, layerName: string): void {
    const ctx = this.contexts.get(taskId)
    if (!ctx) return
    ctx.layerStates[layerName] = 'loaded'
    this.recalcSize(taskId)

    const activeLayerCount = Object.values(ctx.layerStates).filter(s => s === 'loaded').length
    if (activeLayerCount > DEFAULT_BUDGET.maxLayers) {
      getRuntimeLogger().warn(
        `Context ${taskId} 超出层数预算: ${activeLayerCount} > ${DEFAULT_BUDGET.maxLayers}`,
      )
    }

    this.onEvent?.({
      type: 'layer.loaded',
      taskId,
      layer: layerName,
      payload: { summary: `Layer ${layerName} 已加载` },
    })
  }

  /** 卸载指定层（清数据 + 标记为 unloaded） */
  unloadLayer(taskId: string, layerName: string): void {
    const ctx = this.contexts.get(taskId)
    if (!ctx) return

    // 清除对应层数据
    switch (layerName) {
      case 'system':
        ctx.system = undefined
        break
      case 'skill':
        ctx.skill = undefined
        break
      case 'task':
        ctx.task = undefined
        break
      case 'execution':
        ctx.execution = undefined
        break
      case 'memory':
        ctx.memory = undefined
        break
    }

    ctx.layerStates[layerName] = 'unloaded'
    this.recalcSize(taskId)

    this.onEvent?.({
      type: 'layer.unloaded',
      taskId,
      layer: layerName,
      payload: { summary: `Layer ${layerName} 已卸载` },
    })
  }

  /** 更新指定层数据（合并写入） */
  updateLayer(taskId: string, layerName: string, data: Record<string, unknown>): void {
    const ctx = this.contexts.get(taskId)
    if (!ctx) return

    switch (layerName) {
      case 'system':
        ctx.system = ctx.system ? { ...ctx.system, ...data } as SystemLayer : data as unknown as SystemLayer
        break
      case 'skill':
        ctx.skill = ctx.skill ? { ...ctx.skill, ...data } as SkillLayer : data as unknown as SkillLayer
        break
      case 'task':
        ctx.task = ctx.task ? { ...ctx.task, ...data } as TaskLayer : data as unknown as TaskLayer
        break
      case 'execution':
        ctx.execution = ctx.execution ? { ...ctx.execution, ...data } as ExecutionLayer : data as unknown as ExecutionLayer
        break
      case 'memory':
        ctx.memory = ctx.memory ? { ...ctx.memory, ...data } as MemoryLayer : data as unknown as MemoryLayer
        break
    }

    this.recalcSize(taskId)
  }

  /** 获取指定层数据 */
  getLayer(taskId: string, layerName: string): unknown {
    const ctx = this.contexts.get(taskId)
    if (!ctx) return undefined

    switch (layerName) {
      case 'system': return ctx.system
      case 'skill': return ctx.skill
      case 'task': return ctx.task
      case 'execution': return ctx.execution
      case 'memory': return ctx.memory
      default: return undefined
    }
  }

  /** 检查指定层是否已加载 */
  isLayerLoaded(taskId: string, layerName: string): boolean {
    const ctx = this.contexts.get(taskId)
    if (!ctx) return false
    return ctx.layerStates[layerName] === 'loaded'
  }

  // ── 查询 ─────────────────────────────────────────────

  /** 获取活跃 Context 数量 */
  getActiveContextCount(): number {
    return this.contexts.size
  }

  /** 获取所有活跃 taskId 列表 */
  getAllContextIds(): string[] {
    return Array.from(this.contexts.keys())
  }

  /**
   * 获取 Context 的 Budget 状态。
   * RuntimeStore 据此决定是否 append budget.warning event。
   */
  getBudgetStatus(taskId: string): { overSize: boolean; overLayers: boolean } | undefined {
    const ctx = this.contexts.get(taskId)
    if (!ctx) return undefined
    const activeLayerCount = Object.values(ctx.layerStates).filter(s => s === 'loaded').length
    return {
      overSize: ctx.totalEstimatedSize > DEFAULT_BUDGET.maxContextSize,
      overLayers: activeLayerCount > DEFAULT_BUDGET.maxLayers,
    }
  }

  // ── 内部辅助 ─────────────────────────────────────────

  /** 重新计算指定 Context 的 totalEstimatedSize 并刷新 updatedAt */
  recalcSize(taskId: string): void {
    const ctx = this.contexts.get(taskId)
    if (!ctx) return

    const layerSize = (layer: unknown) => (layer ? estimateSize(layer) : 0)
    ctx.totalEstimatedSize =
      layerSize(ctx.system) +
      layerSize(ctx.skill) +
      layerSize(ctx.task) +
      layerSize(ctx.execution) +
      layerSize(ctx.memory) +
      estimateSize(ctx.layerStates) +
      estimateSize(ctx.createdAt) +
      estimateSize(ctx.updatedAt)
    ctx.updatedAt = new Date().toISOString()

    // ── Budget 报警 ──
    if (ctx.totalEstimatedSize > DEFAULT_BUDGET.maxContextSize) {
      getRuntimeLogger().warn(
        `Context ${taskId} 超出大小预算: ${ctx.totalEstimatedSize} > ${DEFAULT_BUDGET.maxContextSize}`
      )
    }
  }
}
