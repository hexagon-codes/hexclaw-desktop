/**
 * runtimeBridge — Chat ↔ Runtime anti-coupling shim.
 *
 * Chat 层不直接 import RuntimeStore。
 * 此 shim 是 Chat 与 Runtime Kernel 之间的唯一接触点。
 *
 * 不是：
 * - store
 * - orchestrator
 * - subsystem
 *
 * 只是：
 * - function wrapper（薄封装）
 */

import { useRuntimeStore } from '@/stores/runtime'
import type { Task, TaskOutput, TaskError } from '@/types'

/**
 * 为 chat task 注册 RuntimeContext。
 *
 * chat task 默认 Timeline 仅产生：
 * - task.completed
 * - task.failed
 * （registerContext 属于 infrastructure event，不是 human activity）
 */
export function registerChatTask(task: Task): void {
  const runtime = useRuntimeStore()
  runtime.registerContextForTask(task)
}

/** chat task 完成 — 写入 output + 产生 task.completed timeline 事件 */
export function completeChatTask(taskId: string, output: TaskOutput): void {
  const runtime = useRuntimeStore()
  runtime.completeContextForTask(taskId, output)
}

/** chat task 失败 — 写入 error + 产生 task.failed timeline 事件 */
export function failChatTask(taskId: string, error: TaskError): void {
  const runtime = useRuntimeStore()
  runtime.failContextForTask(taskId, error)
}
