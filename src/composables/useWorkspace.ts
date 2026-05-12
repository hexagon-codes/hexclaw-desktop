/**
 * useWorkspace — Task-first Workspace 数据源。
 *
 * 唯一职责：
 * - 读取 RuntimeStore + TaskStore 原始数据
 * - 通过 workspaceProjector 翻译为 Projection DTO
 * - 管理 selectedTaskId 状态
 *
 * 不做：
 * - 不调用 store mutation 方法
 * - 不直接暴露 RuntimeContext / RuntimeEvent
 * - 不引入新 Pinia store
 */

import { ref, computed, onMounted } from 'vue'
import { useRoute, onBeforeRouteUpdate } from 'vue-router'
import { useRuntimeStore } from '@/stores/runtime'
import { useTaskStore } from '@/stores/tasks'
import { projectTask, projectContext, projectTimeline, projectTimelineNarrative, projectTaskResult } from '@/services/workspaceProjector'
import type { WorkspaceTaskProjection, WorkspaceContextProjection, TimelineItemProjection, TimelineNarrativeGroup, TaskResultProjection } from '@/types/workspace'

export function useWorkspace() {
  const runtimeStore = useRuntimeStore()
  const taskStore = useTaskStore()
  const route = useRoute()

  const selectedTaskId = ref<string | null>(null)

  // ── Route sync（route query 仅作 navigation hint，非 runtime selection authority） ──
  function syncSelectedTaskFromRoute() {
    const taskId = route.query.taskId
    if (typeof taskId === 'string' && taskId) {
      selectTask(taskId)
    }
  }

  onMounted(() => {
    syncSelectedTaskFromRoute()
  })

  onBeforeRouteUpdate(() => {
    syncSelectedTaskFromRoute()
  })

  // ── Task Projections（主视图） ────────────────────

  /** 所有 Task 的投影列表（active + completed，合并排序） */
  const taskProjections = computed<WorkspaceTaskProjection[]>(() => {
    const allTasks = [...taskStore.activeTasks, ...taskStore.completedTasks]
    return allTasks.map(task => {
      const summary = runtimeStore.getContextSummary(task.id)
      return projectTask(task, summary ?? undefined)
    })
  })

  /** Active Tasks 投影 */
  const activeProjections = computed(() =>
    taskProjections.value.filter(
      t => t.status === 'running' || t.status === 'pending',
    ),
  )

  /** Completed Tasks 投影（最近 50 条，状态为 completed/failed/cancelled） */
  const completedProjections = computed(() =>
    taskProjections.value
      .filter(t => t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled')
      .slice(0, 50),
  )

  // ── Selected Context Projection（次级视图） ────────

  /** 选中 Task 的 Context 投影 */
  const selectedContextProjection = computed<WorkspaceContextProjection | null>(() => {
    if (!selectedTaskId.value) return null
    const ctx = runtimeStore.getActiveContext(selectedTaskId.value)
    if (!ctx) return null
    const projection = projectContext(ctx)
    // 从 TaskStore 注入 navigation metadata（projector 不接触 sessionId）
    const task = taskStore.getTask(selectedTaskId.value)
    if (task?.sessionId) {
      projection.task.navigation = { chatSessionId: task.sessionId }
    }
    return projection
  })

  // ── Selected Timeline Projection（次级视图） ───────

  /** 选中 Task 的 Timeline 投影（原始事件列表，保留向后兼容） */
  const selectedTimelineProjection = computed<TimelineItemProjection[]>(() => {
    if (!selectedTaskId.value) return []
    const events = runtimeStore.getTaskTimeline(selectedTaskId.value)
    return projectTimeline(events)
  })

  /** 选中 Task 的 Narrative Timeline 投影 */
  const selectedNarrativeProjection = computed<TimelineNarrativeGroup[]>(() => {
    if (!selectedTaskId.value) return []
    const events = runtimeStore.getTaskTimeline(selectedTaskId.value)
    return projectTimelineNarrative(events)
  })

  /** 选中 Task 的 Result 投影 */
  const selectedResultProjection = computed<TaskResultProjection | null>(() => {
    if (!selectedTaskId.value) return null
    const task = taskStore.getTask(selectedTaskId.value)
    if (!task) return null
    const ctx = runtimeStore.getActiveContext(selectedTaskId.value)
    return projectTaskResult(task, ctx ?? undefined)
  })

  // ── Actions ───────────────────────────────────────

  function selectTask(taskId: string | null) {
    selectedTaskId.value = taskId
  }

  return {
    // state
    selectedTaskId,
    // projections
    taskProjections,
    activeProjections,
    completedProjections,
    selectedContextProjection,
    selectedTimelineProjection,
    selectedNarrativeProjection,
    selectedResultProjection,
    // actions
    selectTask,
    // pass-through (read-only)
    activeCount: taskStore.activeCount,
  }
}
