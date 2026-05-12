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
import { useTaskStore } from '@/stores/tasks'
import type { Task, TaskResult, TaskOutput, TaskError } from '@/types'

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

/**
 * executeChatTask — Chat 调用的 Runtime 执行入口。
 *
 * 封装完整执行生命周期：
 * - RuntimeStore.executeTask() (lifecycle, returns void)
 * - TaskStore.completeTask() (Runtime-owned completion)
 * - error → TaskStore.failTask() → rethrow
 *
 * @returns TaskResult — Chat 只消费这个值
 * @throws 执行失败时抛出，Chat 自行处理错误展示
 */
export async function executeChatTask(taskId: string): Promise<TaskResult> {
  const runtime = useRuntimeStore()
  const taskStore = useTaskStore()

  try {
    // Runtime execution (lifecycle operation, returns void)
    await runtime.executeTask(taskId)

    // Bridge responsibility: extract result
    const result = runtime.getExecutionResult(taskId)
    if (!result) throw new Error('执行完成但无输出结果')

    // Runtime-owned completion: bridge 代理 TaskStore
    taskStore.completeTask(taskId, {
      result,
      artifacts: [],
    })

    return result
  } catch (e) {
    const msg = (e as Error).message
    // Runtime 路径下，Runtime 已写入 execution.failed timeline
    // Bridge 代理 TaskStore fail
    taskStore.failTask(taskId, { code: 'EXECUTION_FAILED', message: msg })
    throw e
  }
}
