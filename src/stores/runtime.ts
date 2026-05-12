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
import { usePersistenceRuntime } from '@/composables/usePersistenceRuntime'
import { useAssetRuntime } from '@/composables/useAssetRuntime'
import { useRecoveryRuntime } from '@/composables/useRecoveryRuntime'
import type { AssetReference, AssetMetadata } from '@/types/asset'
import type { RecoveryAssessment, CorruptionReport, RecoverySummary } from '@/types/recovery'

export const useRuntimeStore = defineStore('runtime', () => {
  const timelineStore = new TimelineStore()

  const manager = new ContextManager((event) => {
    writeTimelineEvent(event)
  })
  const loader = new ContextLoader()
  const skillLoader = new SkillLoader()

  const persistence = usePersistenceRuntime()
  const asset = useAssetRuntime()
  const recovery = useRecoveryRuntime()

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

    // ── 设置 loading 状态 ──
    if (!ctx.skill) {
      ctx.skill = {
        loadedSections: { markdown: 'unloaded', references: 'unloaded' },
      }
    }
    ctx.skill.loadedSections.markdown = 'loading'
    ctx.layerStates['skill'] = 'loading'

    let skillPkg
    try {
      skillPkg = await skillLoader.loadSkill(skillId, {
        loadMarkdown: true,
        loadReferences: false,
      })
    } catch (e) {
      // ── Skill Package 加载失败 → error 状态 ──
      if (ctx.skill) {
        ctx.skill.loadedSections.markdown = 'error'
      }
      ctx.layerStates['skill'] = 'error'

      writeTimelineEvent({
        type: 'skill.loadFailed',
        taskId,
        payload: { summary: `Skill "${skillId}" 加载失败: ${(e as Error).message}` },
      })

      revision.value++
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

  /**
   * 卸载当前 Task 的 Skill Layer。
   *
   * 仅清理该 task 的 ctx.skill 和 layerStates['skill']。
   * 不销毁 Context，不修改其他 Layer。
   * 不做 watch / 自动触发。
   */
  function unloadSkillForTask(taskId: string): void {
    const ctx = manager.getContext(taskId)
    if (!ctx) return
    if (!ctx.skill && ctx.layerStates['skill'] !== 'loaded') return

    ctx.skill = undefined
    ctx.layerStates['skill'] = 'unloaded'
    manager.recalcSize(taskId)

    writeTimelineEvent({
      type: 'skill.unloaded',
      taskId,
      payload: { summary: 'Skill 已卸载' },
    })

    revision.value++
  }

  /**
   * 重新加载 Skill。
   *
   * 静默清理 ctx.skill → 调用 loadSkillForTask。
   * reload 是 single semantic operation：
   * - 不 emit skill.unloaded（仅显式 unloadSkillForTask 记录）
   * - 不单独 revision++
   * - 成功后只产生 skill.loaded + 1 次 revision++
   * - 失败时 ctx.skill 进入 error placeholder（loadedSections.markdown='error'），
   *   layerStates['skill']='error'，产生 skill.loadFailed timeline event，revision++
   * - 失败不会恢复旧 skill
   *
   * @throws 同 loadSkillForTask
   */
  async function reloadSkillForTask(taskId: string, skillId: string): Promise<void> {
    const ctx = manager.getContext(taskId)
    if (!ctx) return

    // 静默清理（不 emit timeline / 不 revision++）
    if (ctx.skill || ctx.layerStates['skill'] === 'loaded') {
      ctx.skill = undefined
      ctx.layerStates['skill'] = 'unloaded'
      manager.recalcSize(taskId)
    }

    // guard 已失效（ctx.skill === undefined），正常调用
    await loadSkillForTask(taskId, skillId)
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

  // ── Persistence ───────────────────────────────────────

  /**
   * 显式保存单个 Context 到磁盘。
   * 不自动调用，由 UI / task 生命周期触发。
   */
  async function saveContextPersist(taskId: string): Promise<void> {
    const ctx = manager.getContext(taskId)
    if (!ctx) return
    const ok = await persistence.saveContext(ctx)
    if (!ok) {
      getRuntimeLogger().error(`saveContext(${taskId}) 失败`)
    }
    // 不 increment revision — persistence 是副作用，非 runtime mutation
  }

  /**
   * 显式保存所有活跃 Context + Timeline + Manifest 到磁盘。
   * 不自动调用。
   *
   * @returns true 全部保存成功，false 有失败
   */
  async function saveAllPersist(): Promise<boolean> {
    const contexts = manager.getAllContexts()
    const events = timelineStore.getAll()
    return persistence.saveAll(contexts, events)
    // 不 increment revision
  }

  // ── Asset ────────────────────────────────────────────

  /**
   * 注册资产引用。
   *
   * 1. composable.buildRegistration() → { ref, updated }（纯计算）
   * 2. RuntimeStore 应用 mutation → ctx.resources.asset
   * 3. revision.value++
   *
   * @throws 当 Context 不存在或 path 校验失败时
   */
  function registerAsset(
    taskId: string,
    path: string,
    metadata: AssetMetadata,
  ): AssetReference {
    const ctx = manager.getContext(taskId)
    if (!ctx) throw new Error(`Context ${taskId} 不存在`)

    const { ref, updated } = asset.buildRegistration(
      ctx.resources?.asset,
      taskId,
      path,
      metadata,
    )

    if (!ctx.resources) ctx.resources = {}
    ctx.resources.asset = updated

    revision.value++
    return ref
  }

  /**
   * 废弃资产引用。
   *
   * 1. composable.buildInvalidation() → { updated, assetType } | null（纯计算）
   * 2. RuntimeStore 应用 mutation → ctx.resources.asset
   * 3. append asset.invalidated Timeline Event
   * 4. revision.value++
   */
  function invalidateAsset(taskId: string, assetId: string): void {
    const ctx = manager.getContext(taskId)
    if (!ctx) return
    const collection = ctx.resources?.asset
    if (!collection) return

    const result = asset.buildInvalidation(collection, assetId)
    if (!result) return

    ctx.resources.asset = result.updated

    writeTimelineEvent({
      type: 'asset.invalidated',
      taskId,
      payload: {
        summary: `Asset ${assetId} 已废弃`,
        metadata: { assetType: result.assetType },
      },
    })

    revision.value++
  }

  /**
   * 资产健康验证 — 显式调用。
   *
   * composable.checkHealth() → { updated, changed }（observation）
   * RuntimeStore 仅当 changed 时应用 mutation。
   * 不引入 scheduler / concurrency pool / retry queue。
   */
  async function reconcileAssets(taskId: string): Promise<void> {
    const ctx = manager.getContext(taskId)
    if (!ctx) return
    const collection = ctx.resources?.asset
    if (!collection || collection.refs.length === 0) return

    const { updated, changed } = await asset.checkHealth(collection)

    if (changed) {
      ctx.resources.asset = updated
      revision.value++
    }
    // reconcile 不 append timeline event（noisy observation）
  }

  /**
   * 获取 Context 的 Asset 摘要（动态 rebuild，非持久化）。
   */
  function getAssetSummary(taskId: string) {
    const ctx = manager.getContext(taskId)
    if (!ctx) return null
    return asset.buildSummary(ctx.resources?.asset)
  }

  // ── Recovery ──────────────────────────────────────────

  /**
   * 应用失败记录 — 写入 ctx.resources.recovery。
   *
   * 1. composable.buildFailureApplication() → { patch, assessmentChanged, ... }（纯计算）
   * 2. RuntimeStore 应用 mutation → ctx.resources.recovery
   * 3. 条件性 append recovery.assessed（仅 assessmentState 变化时）
   *
   * 不是 markRecovered / markRecoveryFailed — 属于 Execution Lifecycle。
   */
  function applyFailureRecord(taskId: string, error: { code: string; message: string }): void {
    const ctx = manager.getContext(taskId)
    if (!ctx) return

    const result = recovery.buildFailureApplication(
      ctx.resources?.recovery,
      error,
      ctx.execution?.state ?? 'unknown',
      ctx.task?.status ?? 'unknown',
      ctx,
    )

    if (!ctx.resources) ctx.resources = {}
    ctx.resources.recovery = result.patch

    if (result.assessmentChanged) {
      writeTimelineEvent({
        type: 'recovery.assessed',
        taskId,
        payload: {
          summary: `Recovery assessment: ${result.assessmentState}`,
          metadata: { failureCode: result.failureCode, assessmentState: result.assessmentState },
        },
      })
    }

    revision.value++
  }

  /**
   * 评估恢复可行性 — computed，不持久化。
   */
  function assessRecovery(taskId: string): RecoveryAssessment | null {
    const ctx = manager.getContext(taskId)
    if (!ctx) return null
    return recovery.assess(ctx)
  }

  /**
   * 检测 Context 状态损坏 — ctx self-consistency only。
   *
   * 仅当 corrupted=true 时 append recovery.corruption_detected + revision++。
   * 不记录 noisy health check event。
   */
  function detectCorruption(taskId: string): CorruptionReport | null {
    const ctx = manager.getContext(taskId)
    if (!ctx) return null

    const report = recovery.detect(ctx)

    if (report.corrupted) {
      writeTimelineEvent({
        type: 'recovery.corruption_detected',
        taskId,
        payload: {
          summary: `Context corruption detected: ${report.details.join('; ')}`,
          metadata: {
            contextDataExists: report.checks.contextDataExists,
            executionStateConsistent: report.checks.executionStateConsistent,
            statusConsistent: report.checks.statusConsistent,
          },
        },
      })
      revision.value++
    }

    return report
  }

  /**
   * 动态 rebuild Recovery Summary（不持久化）。
   */
  function getRecoverySummary(taskId: string): RecoverySummary | null {
    const ctx = manager.getContext(taskId)
    if (!ctx) return null
    return recovery.getSummary(ctx)
  }

  /**
   * 推断恢复解决状态 — 来自 Execution Lifecycle Outcome。
   * 不是 Recovery Domain 的持久化 type。
   */
  function getResolutionState(taskId: string): 'pending' | 'resolved' | 'failed' {
    const ctx = manager.getContext(taskId)
    if (!ctx) return 'pending'
    return recovery.getResolution(ctx)
  }

  /**
   * 从磁盘恢复 Runtime 状态。
   *
   * 显式调用，不做 auto restore。
   * composable.loadAll() → 返回原始快照数据。
   * Reconstruction（createContext/updateLayer/recalcSize/resource restore）全部在 RuntimeStore。
   * 通过 manager.updateLayer() 逐层恢复，不绕过 ContextManager layer invariant。
   * null → undefined normalization 在此执行（非 deserializeContext）。
   */
  async function restoreRuntime(): Promise<void> {
    const { contexts, events } = await persistence.loadAll()

    for (const snapshot of contexts) {
      // 跳过已存在的活跃 Context
      if (manager.hasContext(snapshot.taskId)) continue

      // 创建 Context（含默认 System Layer）
      manager.createContext(snapshot.taskId, snapshot.taskType)

      // 逐层恢复 — 通过 manager.updateLayer 保证 layer invariant
      if (snapshot.system) {
        manager.updateLayer(snapshot.taskId, 'system', normalizeLayer(snapshot.system))
      }
      if (snapshot.skill) {
        manager.updateLayer(snapshot.taskId, 'skill', normalizeLayer(snapshot.skill))
      }
      if (snapshot.task) {
        manager.updateLayer(snapshot.taskId, 'task', normalizeLayer(snapshot.task))
      }
      if (snapshot.execution) {
        manager.updateLayer(snapshot.taskId, 'execution', normalizeLayer(snapshot.execution))
      }
      if (snapshot.memory) {
        manager.updateLayer(snapshot.taskId, 'memory', normalizeLayer(snapshot.memory))
      }

      manager.recalcSize(snapshot.taskId)

      // Asset 恢复 — 仅恢复 AssetCollection，不做 checkHealth
      // Persistence Restore ≠ Resource Reconciliation
      if (snapshot.resources?.asset) {
        const ctx = manager.getContext(snapshot.taskId)
        if (ctx) {
          if (!ctx.resources) ctx.resources = {}
          ctx.resources.asset = snapshot.resources.asset
        }
      }

      // Recovery 恢复 — 仅恢复 RecoveryLayer，不做 auto assess/detect
      if (snapshot.recovery) {
        const ctx = manager.getContext(snapshot.taskId)
        if (ctx) {
          if (!ctx.resources) ctx.resources = {}
          ctx.resources.recovery = snapshot.recovery
        }
      }
    }

    // Timeline 恢复 — 使用 importEvents 保留原始 id/timestamp
    if (events.length > 0) {
      timelineStore.importEvents(events)
    }

    revision.value++
  }

  /**
   * null → undefined normalization。
   *
   * Serializer boundary 不做此转换（保持 pure），
   * Runtime 恢复时在此统一处理。
   */
  function normalizeLayer<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(obj)) {
      result[key] = value === null ? undefined : value
    }
    return result
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
    unloadSkillForTask,
    reloadSkillForTask,
    loadContextLayer,
    unloadContextLayer,
    executeTask,
    getActiveContext,
    getContextSummary,
    getTaskTimeline,
    getRecentEvents,
    getEventsByType,
    // Persistence
    saveContext: saveContextPersist,
    saveAll: saveAllPersist,
    restoreRuntime,
    // Asset
    registerAsset,
    invalidateAsset,
    reconcileAssets,
    getAssetSummary,
    // Recovery
    applyFailureRecord,
    assessRecovery,
    detectCorruption,
    getRecoverySummary,
    getResolutionState,
  }
})
