/**
 * Workspace Projector — Runtime Kernel → UX Projection DTO 翻译层。
 *
 * 纯函数。零 store import。零副作用。零 async。
 *
 * 仅允许：
 * - projection（数据转换）
 * - normalization（格式化、截断）
 * - terminology mapping（Runtime 术语 → UX 术语）
 *
 * 禁止：
 * - validation / policy
 * - async / IO
 * - mutation
 * - store access
 *
 * 这是 Runtime Kernel 与 Workspace UI 之间的 formal boundary。
 * UI 组件永远不直接消费 RuntimeContext / RuntimeEvent。
 */

import type { Task } from '@/types'
import type { ContextSummary, RuntimeContext } from '@/types/context'
import type { RuntimeEvent } from '@/types/timeline'
import type {
  WorkspaceTaskProjection,
  WorkspaceContextProjection,
  TimelineItemProjection,
  TimelineCategory,
} from '@/types/workspace'

// ─── Helpers ─────────────────────────────────────────

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen - 1) + '…'
}

function formatElapsed(iso?: string): string {
  if (!iso) return '-'
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 0) return '-'
  if (ms < 1000) return '刚刚'
  if (ms < 60000) return `${Math.floor(ms / 1000)}s`
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m`
  return `${Math.floor(ms / 3600000)}h`
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  } catch {
    return iso
  }
}

// ─── Task Projection ──────────────────────────────────

/**
 * 将 Task + ContextSummary 合并投影为 Task List 条目。
 *
 * progress 保持 observational / non-authoritative。
 * 如无真实 progress source（ctx.task.progress），
 * 根据 execution state 推断 activityState。
 */
export function projectTask(
  task: Task,
  summary?: ContextSummary,
): WorkspaceTaskProjection {
  return {
    taskId: task.id,
    taskType: task.type,
    status: task.status,
    goal: task.input?.payload?.goal
      ? truncate(String(task.input.payload.goal), 60)
      : undefined,
    elapsed: formatElapsed(task.metadata?.startedAt),
    progress: task.progress,
    activityState: task.progress === undefined ? inferActivityState(task.status) : undefined,
    hasError: task.status === 'failed',
    hasOutputs: task.output !== undefined,
    navigation: task.sessionId ? { chatSessionId: task.sessionId } : undefined,
  }
}

function inferActivityState(status: string): string | undefined {
  switch (status) {
    case 'running': return 'executing'
    case 'pending': return 'waiting'
    default: return undefined
  }
}

// ─── Context Projection ───────────────────────────────

/**
 * 将 RuntimeContext 投影为 Workspace 可观测视图。
 *
 * 裁剪清单：
 * - System Layer → 不投影
 * - Memory Layer → 不投影
 * - layerStates → 不投影（UX 不知道 semantic layer topology）
 * - skill.capabilities → 不投影
 * - execution valid transitions → 不投影
 * - loadedSections → boolean（非 ContextLayerStatus）
 * - AssetCollection → outputs（counts + flag）
 * - RecoveryLayer → health（hasIssues + severity）
 */
export function projectContext(ctx: RuntimeContext): WorkspaceContextProjection {
  return {
    taskId: ctx.taskId,
    taskType: ctx.taskType,

    task: projectTaskSection(ctx),
    skill: projectSkillSection(ctx),
    execution: projectExecutionSection(ctx),
    outputs: projectOutputsSection(ctx),
    health: projectHealthSection(ctx),
  }
}

function projectTaskSection(ctx: RuntimeContext): WorkspaceContextProjection['task'] {
  const t = ctx.task
  return {
    goal: t?.goal,
    status: t?.status ?? 'pending',
    progress: t?.progress,
    inputSummary: t?.input?.payload
      ? truncate(JSON.stringify(t.input.payload), 100)
      : undefined,
    outputSummary: t?.output?.result !== undefined
      ? truncate(JSON.stringify(t.output.result), 100)
      : undefined,
    errorCode: t?.error?.code,
    errorMessage: t?.error?.message,
  }
}

function projectSkillSection(ctx: RuntimeContext): WorkspaceContextProjection['skill'] {
  if (!ctx.skill) return undefined

  const loadedSections = ctx.skill.loadedSections
  const layerStatus = ctx.layerStates['skill']

  return {
    skillId: ctx.skill.skillId ?? '',
    version: ctx.skill.skillVersion ?? '0.0.0',
    loadedSections: {
      markdown: loadedSections.markdown === 'loaded',
      references: loadedSections.references === 'loaded',
    },
    status: layerStatus ?? 'unloaded',
  }
}

function projectExecutionSection(ctx: RuntimeContext): WorkspaceContextProjection['execution'] {
  if (!ctx.execution) return undefined

  return {
    state: ctx.execution.state,
    stage: ctx.execution.currentStage,
    stepCount: ctx.execution.stepCount,
    elapsed: formatElapsed(ctx.execution.startedAt),
  }
}

function projectOutputsSection(ctx: RuntimeContext): WorkspaceContextProjection['outputs'] {
  const refs = ctx.resources?.asset?.refs
  if (!refs || refs.length === 0) return undefined

  const invalidStatuses = new Set(['invalidated', 'orphaned'])

  return {
    generatedAssets: refs.length,
    hasInvalidAssets: refs.some(r => invalidStatuses.has(r.status)),
  }
}

function projectHealthSection(ctx: RuntimeContext): WorkspaceContextProjection['health'] {
  const hasFailure = !!ctx.resources?.recovery?.failure
  const hasAssessment = !!ctx.resources?.recovery?.lastAssessment

  if (!hasFailure && !hasAssessment) return undefined

  // severity 仅从 failure 推断：permanent → critical，transient/unknown → warning
  let severity: 'warning' | 'critical' | undefined
  if (hasFailure) {
    // 通过 code 前缀粗略推断（不 import classifyFailure 避免耦合）
    const code = ctx.resources?.recovery?.failure?.code ?? ''
    severity = code.startsWith('SKILL_') || code === 'AUTH_FAILED' || code === 'CAPABILITY_DENIED'
      ? 'critical'
      : 'warning'
  } else {
    severity = 'warning'
  }

  return {
    hasIssues: hasFailure,
    severity,
  }
}

// ─── Timeline Projection ──────────────────────────────

/**
 * RuntimeEventType → TimelineCategory 映射（20 → 5）。
 * 内部 RuntimeEventType 保持不变，此映射仅在 projector 中完成。
 */
const CATEGORY_MAP: Record<string, TimelineCategory> = {
  // task
  'task.created': 'task',
  'task.completed': 'task',
  'task.failed': 'task',
  'task.destroyed': 'task',
  'context.created': 'task',
  'execution.prepared': 'task',
  'execution.started': 'task',
  'execution.completed': 'task',
  'execution.failed': 'task',
  // skill
  'skill.loaded': 'skill',
  'skill.loadFailed': 'skill',
  'skill.unloaded': 'skill',
  'capability.validated': 'skill',
  // system
  'layer.loaded': 'system',
  'layer.unloaded': 'system',
  'memory.updated': 'system',
  // warning
  'budget.warning': 'warning',
  'recovery.assessed': 'warning',
  'recovery.corruption_detected': 'warning',
  // output
  'asset.invalidated': 'output',
}

/** RuntimeEventType → i18n label key */
const TYPE_LABELS: Record<string, string> = {
  'task.created': 'workspace.timeline.taskCreated',
  'task.completed': 'workspace.timeline.taskCompleted',
  'task.failed': 'workspace.timeline.taskFailed',
  'task.destroyed': 'workspace.timeline.taskDestroyed',
  'context.created': 'workspace.timeline.contextCreated',
  'execution.prepared': 'workspace.timeline.execPrepared',
  'execution.started': 'workspace.timeline.execStarted',
  'execution.completed': 'workspace.timeline.execCompleted',
  'execution.failed': 'workspace.timeline.execFailed',
  'skill.loaded': 'workspace.timeline.skillLoaded',
  'skill.loadFailed': 'workspace.timeline.skillLoadFailed',
  'skill.unloaded': 'workspace.timeline.skillUnloaded',
  'capability.validated': 'workspace.timeline.capabilityValidated',
  'layer.loaded': 'workspace.timeline.layerLoaded',
  'layer.unloaded': 'workspace.timeline.layerUnloaded',
  'memory.updated': 'workspace.timeline.memoryUpdated',
  'budget.warning': 'workspace.timeline.budgetWarning',
  'recovery.assessed': 'workspace.timeline.recoveryAssessed',
  'recovery.corruption_detected': 'workspace.timeline.corruptionDetected',
  'asset.invalidated': 'workspace.timeline.assetInvalidated',
}

/** 投影单条 RuntimeEvent → TimelineItemProjection */
function projectEvent(event: RuntimeEvent): TimelineItemProjection {
  return {
    time: formatTime(event.timestamp),
    typeCategory: CATEGORY_MAP[event.type] ?? 'system',
    typeLabel: TYPE_LABELS[event.type] ?? 'workspace.timeline.unknown',
    summary: event.payload?.summary ?? '',
  }
}

/**
 * 将 RuntimeEvent[] 投影为 TimelineItemProjection[]。
 * 20 种 RuntimeEventType → 5 种 TimelineCategory。
 * 不保留 raw event type / raw payload / raw metadata。
 */
export function projectTimeline(events: RuntimeEvent[]): TimelineItemProjection[] {
  return events.map(projectEvent)
}
