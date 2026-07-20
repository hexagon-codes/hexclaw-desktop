import { reactive } from 'vue'
import { pullOllamaModel, type OllamaPullProgress } from '@/api/ollama'

const SETTLED_TASK_TTL_MS = 10_000

export interface SharedOllamaPullState {
  progress: number | null
}

export interface SharedOllamaPullTask {
  model: string
  promise: Promise<void>
}

interface InternalPullTask extends SharedOllamaPullTask {
  cleanupTimer: ReturnType<typeof setTimeout> | null
}

const states = reactive(new Map<string, SharedOllamaPullState>())
const tasks = new Map<string, InternalPullTask>()

function progressPercent(progress: OllamaPullProgress): number | null {
  if (progress.status === 'success') return 100
  if (
    progress.completed == null ||
    progress.total == null ||
    progress.total <= 0 ||
    progress.completed < 0
  ) {
    return null
  }
  return Math.min(100, Math.max(0, Math.round((progress.completed / progress.total) * 100)))
}

function removeTask(task: InternalPullTask) {
  if (tasks.get(task.model) !== task) return
  if (task.cleanupTimer !== null) clearTimeout(task.cleanupTimer)
  tasks.delete(task.model)
  states.delete(task.model)
}

export function getSharedOllamaPullState(model: string): SharedOllamaPullState | undefined {
  return states.get(model)
}

export function getSharedOllamaPullTask(model: string): SharedOllamaPullTask | undefined {
  return tasks.get(model)
}

export function startSharedOllamaPull(model: string): {
  task: SharedOllamaPullTask
  started: boolean
} {
  const existing = tasks.get(model)
  if (existing) return { task: existing, started: false }

  states.set(model, { progress: null })
  const promise = Promise.resolve().then(() =>
    pullOllamaModel(model, (progress) => {
      const state = states.get(model)
      if (state) state.progress = progressPercent(progress)
    }),
  )
  const task: InternalPullTask = { model, promise, cleanupTimer: null }
  tasks.set(model, task)

  void promise.then(
    () => {
      if (tasks.get(model) !== task) return
      const state = states.get(model)
      if (state) state.progress = 100
      // Keep a completed task briefly so a remounted view can join canonical
      // verification instead of starting a duplicate pull.
      task.cleanupTimer = setTimeout(() => removeTask(task), SETTLED_TASK_TTL_MS)
    },
    () => removeTask(task),
  )

  return { task, started: true }
}

export function releaseSharedOllamaPull(task: SharedOllamaPullTask) {
  const current = tasks.get(task.model)
  if (current?.promise === task.promise) removeTask(current)
}
