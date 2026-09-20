import { backendStorageKey } from './backend-context'
import { activeOllamaTarget } from '@/api/ollama'
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
  key: string
  cleanupTimer: ReturnType<typeof setTimeout> | null
}

function modelKey(model: string) { return backendStorageKey(`ollama:${activeOllamaTarget.value?.target_id ?? 'unknown'}:${activeOllamaTarget.value?.target_revision ?? 0}:${model}`) }

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
  if (tasks.get(task.key) !== task) return
  if (task.cleanupTimer !== null) clearTimeout(task.cleanupTimer)
  tasks.delete(task.key)
  states.delete(task.key)
}

export function getSharedOllamaPullState(model: string): SharedOllamaPullState | undefined {
  return states.get(modelKey(model))
}

export function getSharedOllamaPullTask(model: string): SharedOllamaPullTask | undefined {
  return tasks.get(modelKey(model))
}

export function startSharedOllamaPull(model: string): {
  task: SharedOllamaPullTask
  started: boolean
} {
  const key = modelKey(model)
  const existing = tasks.get(key)
  if (existing) return { task: existing, started: false }

  states.set(key, { progress: null })
  const promise = Promise.resolve().then(() =>
    pullOllamaModel(model, (progress) => {
      const state = states.get(key)
      if (state) state.progress = progressPercent(progress)
    }),
  )
  const task: InternalPullTask = { model, promise, key, cleanupTimer: null }
  tasks.set(key, task)

  void promise.then(
    () => {
      if (tasks.get(key) !== task) return
      const state = states.get(key)
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
  const current = [...tasks.values()].find((item) => item.promise === task.promise)
  if (current?.promise === task.promise) removeTask(current)
}
