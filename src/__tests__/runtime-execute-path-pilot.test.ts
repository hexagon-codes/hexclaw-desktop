/**
 * Runtime Execute Path Pilot — executeChatTask 验证测试
 *
 * 覆盖场景：
 * - 完整链路：执行 → TaskResult → TaskStore.completeTask
 * - 执行失败：TaskStore.failTask → rethrow
 * - 执行完成但无输出：TaskStore.failTask → rethrow
 * - 契约约束：不调用 enqueue（Task 注册由 Chat 负责）
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

// ════════════════════════════════════════════════════════════
// Mocks — vi.mock 会在编译时提升，先声明 mock 函数再使用
// ════════════════════════════════════════════════════════════

const mockExecuteTask = vi.fn<[string], Promise<void>>()
const mockGetExecutionResult = vi.fn<[string], { kind: 'text'; content: string } | undefined>()
const mockRuntimeCompleteTask = vi.fn()
const mockRuntimeFailTask = vi.fn()

vi.mock('@/stores/runtime', () => ({
  useRuntimeStore: () => ({
    executeTask: mockExecuteTask,
    getExecutionResult: mockGetExecutionResult,
    registerContextForTask: vi.fn(),
    completeContextForTask: mockRuntimeCompleteTask,
    failContextForTask: mockRuntimeFailTask,
  }),
}))

const mockTaskStoreComplete = vi.fn()
const mockTaskStoreFail = vi.fn()
const mockTaskStoreEnqueue = vi.fn()

vi.mock('@/stores/tasks', () => ({
  useTaskStore: () => ({
    completeTask: mockTaskStoreComplete,
    failTask: mockTaskStoreFail,
    enqueue: mockTaskStoreEnqueue,
    cancelTask: vi.fn(),
    getTask: vi.fn(),
  }),
}))

// ════════════════════════════════════════════════════════════
// Subject
// ════════════════════════════════════════════════════════════

import { executeChatTask, bridgeErrorToApiError } from '@/services/runtimeBridge'

describe('executeChatTask', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  describe('成功路径', () => {
    it('完整链路：executeTask → getExecutionResult → completeTask → 返回 TaskResult', async () => {
      mockExecuteTask.mockResolvedValue(undefined)
      mockGetExecutionResult.mockReturnValue({ kind: 'text', content: '你好，我是 AI 助手' })

      const result = await executeChatTask('task-1')

      // RuntimeStore 调用顺序
      expect(mockExecuteTask).toHaveBeenCalledWith('task-1')
      expect(mockGetExecutionResult).toHaveBeenCalledWith('task-1')

      // TaskStore.completeTask 被调用
      expect(mockTaskStoreComplete).toHaveBeenCalledWith('task-1', {
        result: { kind: 'text', content: '你好，我是 AI 助手' },
        artifacts: [],
      })

      // 返回值正确
      expect(result).toEqual({ kind: 'text', content: '你好，我是 AI 助手' })
    })

    it('TaskResult content 可以包含空字符串', async () => {
      mockExecuteTask.mockResolvedValue(undefined)
      mockGetExecutionResult.mockReturnValue({ kind: 'text', content: '' })

      const result = await executeChatTask('task-2')

      expect(mockTaskStoreComplete).toHaveBeenCalledWith('task-2', {
        result: { kind: 'text', content: '' },
        artifacts: [],
      })
      expect(result).toEqual({ kind: 'text', content: '' })
    })
  })

  describe('失败路径', () => {
    it('Runtime.executeTask 抛出异常 → failTask 被调用 → rethrow', async () => {
      const error = new Error('LLM 服务不可用')
      mockExecuteTask.mockRejectedValue(error)

      await expect(executeChatTask('task-3')).rejects.toThrow('LLM 服务不可用')

      expect(mockTaskStoreFail).toHaveBeenCalledWith('task-3', {
        code: 'EXECUTION_FAILED',
        message: 'LLM 服务不可用',
      })
      expect(mockTaskStoreComplete).not.toHaveBeenCalled()
    })

    it('执行完成但无输出结果 → failTask 被调用 → rethrow', async () => {
      mockExecuteTask.mockResolvedValue(undefined)
      mockGetExecutionResult.mockReturnValue(undefined)

      await expect(executeChatTask('task-4')).rejects.toThrow('执行完成但无输出结果')

      expect(mockTaskStoreFail).toHaveBeenCalledWith('task-4', {
        code: 'EXECUTION_FAILED',
        message: '执行完成但无输出结果',
      })
      expect(mockTaskStoreComplete).not.toHaveBeenCalled()
    })

    it('getExecutionResult 返回 undefined（未完成状态）→ failTask', async () => {
      mockExecuteTask.mockResolvedValue(undefined)
      mockGetExecutionResult.mockReturnValue(undefined)

      await expect(executeChatTask('task-5')).rejects.toThrow('执行完成但无输出结果')

      expect(mockTaskStoreFail).toHaveBeenCalledWith('task-5', {
        code: 'EXECUTION_FAILED',
        message: '执行完成但无输出结果',
      })
    })

    it('executeTask 失败时抛出 ApiError（code=SERVER_ERROR）', async () => {
      mockExecuteTask.mockRejectedValue(new Error('LLM 服务不可用'))

      await expect(executeChatTask('task-api-err')).rejects.toMatchObject({
        code: 'SERVER_ERROR',
        message: 'LLM 服务不可用',
      })
    })
  })

  describe('契约约束', () => {
    it('不调用 TaskStore.enqueue（Task 注册由 Chat 负责）', async () => {
      mockExecuteTask.mockResolvedValue(undefined)
      mockGetExecutionResult.mockReturnValue({ kind: 'text', content: 'ok' })

      await executeChatTask('task-6')

      expect(mockTaskStoreEnqueue).not.toHaveBeenCalled()
    })
  })
})

describe('bridgeErrorToApiError', () => {
  it('maps EXECUTION_FAILED to SERVER_ERROR', () => {
    const result = bridgeErrorToApiError({
      code: 'EXECUTION_FAILED',
      message: '执行器内部错误',
    })
    expect(result.code).toBe('SERVER_ERROR')
    expect(result.message).toBe('执行器内部错误')
  })

  it('maps NO_OUTPUT to SERVER_ERROR', () => {
    const result = bridgeErrorToApiError({
      code: 'NO_OUTPUT',
      message: '执行完成但无输出结果',
    })
    expect(result.code).toBe('SERVER_ERROR')
    expect(result.message).toBe('执行完成但无输出结果')
  })
})
