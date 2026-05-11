import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import type { Task, TaskOutput, TaskStatus, TaskError } from '@/types'

/**
 * Task 运行时 Pinia Store
 *
 * 管理 Task 的完整生命周期：入队 → 执行 → 完成/失败/取消。
 * activeTasks / completedTasks 为响应式状态，供 UI 组件消费。
 */
export const useTaskStore = defineStore('tasks', () => {
  // ─── 响应式状态 ──────────────────────────────────────
  const activeTasks = ref<Task[]>([])
  const completedTasks = ref<Task[]>([])

  // ─── 非响应式运行时 ──────────────────────────────────
  const taskHistory = new Map<string, Task>()
  const taskQueue: Task[] = []

  // ─── 计算属性 ─────────────────────────────────────────
  const pendingTasks = computed(() => taskQueue.filter((t) => t.status === 'pending'))
  const activeCount = computed(() => activeTasks.value.length)

  // ─── 生命周期方法 ─────────────────────────────────────

  /** 将 Task 加入队列，状态设为 pending */
  function enqueue(task: Task): void {
    const t = { ...task, status: 'pending' as TaskStatus }
    taskQueue.push(t)
    taskHistory.set(t.id, t)
  }

  /** 从队列取下一个 pending 任务并标记 running */
  function dequeue(): Task | undefined {
    const idx = taskQueue.findIndex((t) => t.status === 'pending')
    if (idx === -1) return undefined
    const task = taskQueue[idx]
    task.status = 'running'
    task.metadata = { ...task.metadata, startedAt: new Date().toISOString() }
    activeTasks.value.push(task)
    return task
  }

  /** 标记 Task 为运行中 */
  function startTask(id: string): void {
    const task = taskHistory.get(id)
    if (!task) return
    task.status = 'running'
    task.metadata = { ...task.metadata, startedAt: new Date().toISOString() }
    if (!activeTasks.value.find((t) => t.id === id)) {
      activeTasks.value.push(task)
    }
  }

  /** 完成 Task 并记录输出 */
  function completeTask(id: string, output: TaskOutput): void {
    const task = taskHistory.get(id)
    if (!task) return
    task.status = 'completed'
    task.output = output
    task.metadata = { ...task.metadata, completedAt: new Date().toISOString() }
    removeFromActive(id)
    completedTasks.value.push(task)
  }

  /** 标记 Task 为失败 */
  function failTask(id: string, error: TaskError): void {
    const task = taskHistory.get(id)
    if (!task) return
    task.status = 'failed'
    task.error = error
    task.metadata = { ...task.metadata, completedAt: new Date().toISOString() }
    removeFromActive(id)
    completedTasks.value.push(task)
  }

  /** 取消 Task */
  function cancelTask(id: string): void {
    const task = taskHistory.get(id)
    if (!task) return
    task.status = 'cancelled'
    task.metadata = { ...task.metadata, completedAt: new Date().toISOString() }
    removeFromActive(id)
    completedTasks.value.push(task)
  }

  /** 按 ID 查找 Task */
  function getTask(id: string): Task | undefined {
    return taskHistory.get(id)
  }

  // ─── 内部辅助 ─────────────────────────────────────────

  function removeFromActive(id: string): void {
    const idx = activeTasks.value.findIndex((t) => t.id === id)
    if (idx !== -1) activeTasks.value.splice(idx, 1)
  }

  return {
    activeTasks,
    completedTasks,
    pendingTasks,
    activeCount,
    enqueue,
    dequeue,
    startTask,
    completeTask,
    failTask,
    cancelTask,
    getTask,
  }
})
