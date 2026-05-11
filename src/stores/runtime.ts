/**
 * RuntimeStore — 响应式 Context 运行时管理
 *
 * 包装 ContextManager + ContextLoader，提供显式方法注册/更新/完成/销毁 Task Context。
 * 不包含 watch 自动绑定（避免隐式副作用和 Context 泄漏）。
 * 使用 revision ref 桥接 Vue 响应式 — ContextManager 是唯一所有者。
 *
 * @see docs/agents-OS/Context-Contract.md
 */

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { Task, TaskOutput, TaskError, RuntimeContext, ContextSummary } from '@/types'
import type { RuntimeEvent, RuntimeEventType } from '@/types/timeline'
import type { ContextAwareExecutor } from '@/services/taskExecutor'
import { ContextManager } from '@/services/contextManager'
import { ContextLoader } from '@/services/contextLoader'
import { SkillLoader } from '@/services/skillLoader'
import { getRuntimeServices } from '@/services/runtime/runtimeServices'
import { getRuntimeLogger } from '@/services/runtime/runtimeLogger'
import { TimelineStore } from '@/services/runtime/timelineStore'
import { taskTimeline, recentEvents } from '@/services/runtime/timelineProjection'
import { DEFAULT_BUDGET } from '@/types/runtimeBudget'
import { canTransition } from '@/types/execution'
import { createContextAwareExecutor } from '@/services/taskExecutor'

export const useRuntimeStore = defineStore('runtime', () => {
  const timelineStore = new TimelineStore()

  const manager = new ContextManager((event) => {
    writeTimelineEvent(event)
  })
  const loader = new ContextLoader()
  const skillLoader = new SkillLoader()

  // ── 响应式状态 ──────────────────────────────────────

  /** Revision 计数器 — 每次 mutation +1，驱动 computed 重新求值 */
  const revision = ref(0)

  // ── Computed ─────────────────────────────────────────

  /** 所有活跃 Context 列表 */
  const activeContexts = computed(() => {
    revision.value
    return manager.getAllContexts()
  })

  /** 活跃 Context 数量 */
  const activeContextCount = computed(() => {
    revision.value
    return manager.getActiveContextCount()
  })

  /** 所有活跃 Context 摘要（UI 消费） */
  const contextSummaries = computed<ContextSummary[]>(() => {
    revision.value
    return manager.getAllContexts().map(toSummary)
  })

  // ── 显式注册/更新方法 ────────────────────────────────

  /**
   * 为 Task 注册 Context。
   * 自动加载 System Layer + Task Layer。
   * Task 隔离：同 taskId 已存在时静默跳过。
   */
  function registerContextForTask(task: Task): void {
    if (manager.hasContext(task.id)) return
    const ctx = manager.createContext(task.id, task.type)
    loader.loadSystemLayer(ctx)
    loader.loadTaskLayer(ctx, task)
    manager.recalcSize(task.id)

    writeTimelineEvent({ type: 'task.created', taskId: task.id })

    const budget = manager.getBudgetStatus(task.id)
    if (budget?.overSize) {
      writeTimelineEvent({
        type: 'budget.warning',
        taskId: task.id,
        payload: { summary: 'Context 超出大小预算', metadata: { maxSize: DEFAULT_BUDGET.maxContextSize } },
      })
    }

    revision.value++
  }

  /** 同步 Task 数据到 Context 的 Task Layer */
  function updateContextFromTask(task: Task): void {
    const ctx = manager.getContext(task.id)
    if (!ctx) return
    loader.loadTaskLayer(ctx, task)
    manager.recalcSize(task.id)
    revision.value++
  }

  /**
   * 完成 Task：更新 Task Layer output/status，卸载 Execution Layer。
   * 不销毁 Context（保留 System + Task + Memory 供后续查询）。
   */
  function completeContextForTask(taskId: string, output: TaskOutput): void {
    const ctx = manager.getContext(taskId)
    if (!ctx) return
    if (ctx.task) {
      ctx.task.output = JSON.parse(JSON.stringify(output))
      ctx.task.status = 'completed'
    }
    if (ctx.execution) {
      ctx.execution.state = 'completed'
    }
    loader.unloadStaleLayers(ctx)
    manager.recalcSize(taskId)

    writeTimelineEvent({ type: 'task.completed', taskId })
    writeTimelineEvent({ type: 'execution.completed', taskId })

    revision.value++
  }

  /** 标记 Task 失败：更新 Task Layer error/status */
  function failContextForTask(taskId: string, error: TaskError): void {
    const ctx = manager.getContext(taskId)
    if (!ctx) return
    if (ctx.task) {
      ctx.task.error = { ...error }
      ctx.task.status = 'failed'
    }
    if (ctx.execution) {
      ctx.execution.state = 'failed'
    }
    manager.recalcSize(taskId)

    writeTimelineEvent({
      type: 'task.failed',
      taskId,
      payload: { summary: error.message },
    })
    writeTimelineEvent({
      type: 'execution.failed',
      taskId,
      payload: { summary: error.message },
    })

    revision.value++
  }

  /** 彻底销毁 Context（清理所有层数据） */
  function destroyContext(taskId: string): void {
    manager.destroyContext(taskId)

    writeTimelineEvent({ type: 'task.destroyed', taskId })

    revision.value++
  }

  // ── Skill 注入 ───────────────────────────────────────

  /**
   * 为 Task 加载指定 Skill（注入 Skill Layer）。
   *
   * Phase 3 约束：
   * - 只注入 SkillLayer，不创建/执行 Task
   * - 不修改 System Layer / Task Layer
   * - 默认加载 markdown，不加载 references
   * - 同 taskId 重复调用静默跳过
   */
  async function loadSkillForTask(taskId: string, skillId: string): Promise<void> {
    const ctx = manager.getContext(taskId)
    if (!ctx) return
    if (ctx.skill && ctx.layerStates['skill'] === 'loaded') return

    let skillPkg
    try {
      skillPkg = await skillLoader.loadSkill(skillId, {
        loadMarkdown: true,
        loadReferences: false,
      })
    } catch (e) {
      writeTimelineEvent({
        type: 'skill.loadFailed',
        taskId,
        payload: { summary: `Skill "${skillId}" 加载失败: ${(e as Error).message}` },
      })
      throw e
    }

    // ── Capability Validation ──
    const { capabilityRegistry, capabilityValidator } = getRuntimeServices()
    const validation = capabilityValidator.validate(
      skillPkg.meta.capabilities,
      {
        allowedCapabilities: ctx.system?.policy.allowedCapabilities ?? [],
        deniedCapabilities: ctx.system?.policy.deniedCapabilities ?? [],
      },
      capabilityRegistry,
    )
    if (!validation.valid) {
      getRuntimeLogger().warn(
        `Skill "${skillId}" capability 验证警告:`,
        ...validation.warnings,
      )
      writeTimelineEvent({
        type: 'capability.validated',
        taskId,
        payload: {
          summary: `Skill "${skillId}" capability 验证未通过`,
          metadata: { unknownCount: validation.unknownCaps.length, unauthorizedCount: validation.unauthorizedCaps.length, deniedCount: validation.deniedCaps.length },
        },
      })
    }

    loader.loadSkillLayer(ctx, skillPkg)
    manager.recalcSize(taskId)

    writeTimelineEvent({ type: 'skill.loaded', taskId })

    revision.value++
  }

  // ── 层生命周期 ──────────────────────────────────────

  /** 加载指定层 */
  function loadContextLayer(taskId: string, layerName: string): void {
    manager.loadLayer(taskId, layerName)

    const budget = manager.getBudgetStatus(taskId)
    if (budget?.overLayers) {
      writeTimelineEvent({
        type: 'budget.warning',
        taskId,
        payload: { summary: 'Context 超出层数预算', metadata: { maxLayers: 5 } },
      })
    }

    revision.value++
  }

  /** 卸载指定层（清数据 + 标记） */
  function unloadContextLayer(taskId: string, layerName: string): void {
    manager.unloadLayer(taskId, layerName)
    revision.value++
  }

  // ── 查询 ─────────────────────────────────────────────

  /** 获取活跃 Context（原始引用） */
  function getActiveContext(taskId: string): RuntimeContext | undefined {
    return manager.getContext(taskId)
  }

  /** 获取 Context 摘要 */
  function getContextSummary(taskId: string): ContextSummary | undefined {
    const ctx = manager.getContext(taskId)
    return ctx ? toSummary(ctx) : undefined
  }

  // ── 执行闭环 ────────────────────────────────────────

  /**
   * 执行 Task 完整闭环。
   *
   * Single-task linear execution：
   * - 不允许 nested executeTask
   * - 不允许 recursive execution
   * - 不允许 task spawning / subtask creation
   *
   * 生命周期：
   *   Context → prepareExecution → state=running → executor → complete/fail
   *
   * @throws 当 Context 不存在时静默返回
   */
  async function executeTask(taskId: string): Promise<void> {
    const ctx = manager.getContext(taskId)
    if (!ctx) return

    // 1. resolve executor by Task.type
    const executor = resolveExecutor(ctx.taskType)

    // 2. prepare
    loader.prepareExecutionLayer(ctx)
    writeTimelineEvent({ type: 'execution.prepared', taskId })

    // 3. preparing → running
    if (!canTransition(ctx.execution!.state, 'running')) {
      getRuntimeLogger().warn(`[Execution] 非法状态转换: ${ctx.execution!.state} → running`)
    }
    ctx.execution!.state = 'running'
    writeTimelineEvent({ type: 'execution.started', taskId })

    try {
      // 4. execute（stub — 不接入真实 API）
      const output = await executor.executeWithContext(
        { id: taskId, type: ctx.taskType } as Task,
        ctx,
      )

      // 5. running → completed
      if (!canTransition(ctx.execution!.state, 'completed')) {
        getRuntimeLogger().warn(`[Execution] 非法状态转换: ${ctx.execution!.state} → completed`)
      }
      ctx.execution!.state = 'completed'
      ctx.execution!.completedAt = new Date().toISOString()
      ctx.execution!.currentStage = 'finalizing'

      if (ctx.task) {
        ctx.task.output = JSON.parse(JSON.stringify(output))
        ctx.task.status = 'completed'
      }

      loader.writeExecutionMemory(ctx)
      manager.recalcSize(taskId)

      writeTimelineEvent({ type: 'execution.completed', taskId })
      writeTimelineEvent({ type: 'task.completed', taskId })
      writeTimelineEvent({ type: 'memory.updated', taskId })
    } catch (e) {
      // 6. running → failed
      const message = (e as Error).message
      if (!canTransition(ctx.execution!.state, 'failed')) {
        getRuntimeLogger().warn(`[Execution] 非法状态转换: ${ctx.execution!.state} → failed`)
      }
      ctx.execution!.state = 'failed'
      ctx.execution!.currentStage = 'finalizing'
      ctx.execution!.error = { code: 'EXECUTION_FAILED', message }

      if (ctx.task) {
        ctx.task.status = 'failed'
        ctx.task.error = { code: 'EXECUTION_FAILED', message }
      }

      loader.writeExecutionMemory(ctx)
      manager.recalcSize(taskId)

      writeTimelineEvent({
        type: 'execution.failed',
        taskId,
        payload: { summary: message },
      })
      writeTimelineEvent({
        type: 'task.failed',
        taskId,
        payload: { summary: message },
      })
    }

    revision.value++
  }

  /** 根据 TaskType resolve ContextAwareExecutor */
  function resolveExecutor(type: RuntimeContext['taskType']): ContextAwareExecutor {
    return createContextAwareExecutor(type)
  }

  // ── Timeline 查询 ────────────────────────────────────

  /** 获取指定 Task 的时间线事件 */
  function getTaskTimeline(taskId: string): RuntimeEvent[] {
    revision.value
    return taskTimeline(timelineStore.getAll(), taskId)
  }

  /** 获取最近 N 个 Runtime 事件 */
  function getRecentEvents(count: number): RuntimeEvent[] {
    revision.value
    return recentEvents(timelineStore.getAll(), count)
  }

  /** 按类型过滤事件 */
  function getEventsByType(type: RuntimeEventType): RuntimeEvent[] {
    revision.value
    return timelineStore.getByType(type)
  }

  // ── 内部辅助 ─────────────────────────────────────────

  function toSummary(ctx: RuntimeContext): ContextSummary {
    const loadedLayers = Object.entries(ctx.layerStates)
      .filter(([, v]) => v === 'loaded')
      .map(([k]) => k)

    return {
      taskId: ctx.taskId,
      taskType: ctx.taskType,
      status: ctx.task?.status ?? 'pending',
      loadedLayers,
      layerCount: loadedLayers.length,
      totalSize: ctx.totalEstimatedSize,
      createdAt: ctx.createdAt,
    }
  }

  // ── Timeline Helper ─────────────────────────────────────

  function writeTimelineEvent(event: Omit<RuntimeEvent, 'id' | 'timestamp'>): void {
    timelineStore.append(event)
  }

  // ── Export ────────────────────────────────────────────

  return {
    activeContexts,
    activeContextCount,
    contextSummaries,
    registerContextForTask,
    updateContextFromTask,
    completeContextForTask,
    failContextForTask,
    destroyContext,
    loadSkillForTask,
    loadContextLayer,
    unloadContextLayer,
    executeTask,
    getActiveContext,
    getContextSummary,
    getTaskTimeline,
    getRecentEvents,
    getEventsByType,
  }
})
