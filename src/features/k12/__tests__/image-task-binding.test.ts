import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearImageTaskBinding,
  getImageTaskBinding,
  hasImageTaskBinding,
  listImageTaskBindings,
  refreshRecoverableImageTaskBindings,
  setImageTaskBinding,
} from '../image-task-binding'

const k12Api = vi.hoisted(() => ({
  k12ListRecoverableImageTasks: vi.fn(),
}))

vi.mock('@/api/k12', () => k12Api)

describe('session → ImageTaskDispatch durable binding', () => {
  beforeEach(() => {
    k12Api.k12ListRecoverableImageTasks.mockReset()
    localStorage.clear()
    clearImageTaskBinding('session-1', 'tutor-a')
    clearImageTaskBinding('session-2', 'tutor-a')
    clearImageTaskBinding('session-1', 'tutor-b')
  })

  it('consumes the Sidecar recoverable handler flat wire exact-set', async () => {
    const handlerItem = {
      dispatch_id: 'dispatch-1',
      source_session_id: 'session-1',
      source_message_id: 'message-1',
      attempt_generation: 1,
      version: 1,
      stage: 'awaiting_confirmation',
      status: 'awaiting_confirmation',
      projection_ready: true,
      terminal: false,
    }
    expect(Object.keys(handlerItem).sort()).toEqual([
      'attempt_generation',
      'dispatch_id',
      'projection_ready',
      'source_message_id',
      'source_session_id',
      'stage',
      'status',
      'terminal',
      'version',
    ])
    k12Api.k12ListRecoverableImageTasks.mockResolvedValueOnce([handlerItem])

    await refreshRecoverableImageTaskBindings('tutor-a', 'session-1')

    expect(k12Api.k12ListRecoverableImageTasks).toHaveBeenCalledWith('tutor-a', 'session-1')
    expect(listImageTaskBindings('session-1', 'tutor-a')).toEqual([
      {
        agentId: 'tutor-a',
        sourceMessageId: 'message-1',
        dispatchId: 'dispatch-1',
      },
    ])
  })

  it('stores only session owner and dispatch identity', () => {
    const setBinding = setImageTaskBinding as unknown as (
      sessionId: string,
      agentId: string,
      sourceMessageId: string,
      dispatchId: string,
    ) => void
    setBinding('session-1', 'tutor-a', 'message-1', 'dispatch-1')

    expect(getImageTaskBinding('session-1', 'tutor-a', 'message-1')).toEqual({
      agentId: 'tutor-a',
      sourceMessageId: 'message-1',
      dispatchId: 'dispatch-1',
    })
    expect(hasImageTaskBinding('session-1', 'tutor-a')).toBe(true)
    expect(listImageTaskBindings('session-1', 'tutor-a')).toEqual([
      {
        agentId: 'tutor-a',
        sourceMessageId: 'message-1',
        dispatchId: 'dispatch-1',
      },
    ])
    expect(localStorage.length).toBe(0)
  })

  it('同一会话持久化多个 source_message_id + dispatch_id，任一任务不得覆盖另一任务', () => {
    const setBinding = setImageTaskBinding as unknown as (
      sessionId: string,
      agentId: string,
      sourceMessageId: string,
      dispatchId: string,
    ) => void
    setBinding('session-1', 'tutor-a', 'message-1', 'dispatch-1')
    setBinding('session-1', 'tutor-a', 'message-2', 'dispatch-2')

    expect(listImageTaskBindings('session-1', 'tutor-a')).toEqual([
      {
        agentId: 'tutor-a',
        sourceMessageId: 'message-1',
        dispatchId: 'dispatch-1',
      },
      {
        agentId: 'tutor-a',
        sourceMessageId: 'message-2',
        dispatchId: 'dispatch-2',
      },
    ])
  })

  it('BUG-20260724-010 BUG-20260726-002 编辑重发会话恢复不得清除同 Agent 其他会话绑定', async () => {
    const setBinding = setImageTaskBinding as unknown as (
      sessionId: string,
      agentId: string,
      sourceMessageId: string,
      dispatchId: string,
    ) => void
    setBinding('session-1', 'tutor-a', 'message-before-edit', 'dispatch-before-edit')
    setBinding('session-2', 'tutor-a', 'message-other-session', 'dispatch-other-session')
    k12Api.k12ListRecoverableImageTasks.mockResolvedValueOnce([
      {
        dispatch_id: 'dispatch-after-edit',
        source_session_id: 'session-1',
        source_message_id: 'message-after-edit',
        attempt_generation: 2,
        version: 1,
        stage: 'routing',
        status: 'routing',
        projection_ready: false,
        terminal: false,
      },
    ])

    await refreshRecoverableImageTaskBindings('tutor-a', 'session-1')

    expect(listImageTaskBindings('session-1', 'tutor-a')).toEqual([
      {
        agentId: 'tutor-a',
        sourceMessageId: 'message-after-edit',
        dispatchId: 'dispatch-after-edit',
      },
    ])
    expect(listImageTaskBindings('session-2', 'tutor-a')).toEqual([
      {
        agentId: 'tutor-a',
        sourceMessageId: 'message-other-session',
        dispatchId: 'dispatch-other-session',
      },
    ])
  })

  it('fails closed for a different owner', () => {
    const setBinding = setImageTaskBinding as unknown as (
      sessionId: string,
      agentId: string,
      sourceMessageId: string,
      dispatchId: string,
    ) => void
    setBinding('session-1', 'tutor-a', 'message-1', 'dispatch-1')
    expect(getImageTaskBinding('session-1', 'tutor-b', 'message-1')).toBeNull()
    expect(getImageTaskBinding('session-1', 'tutor-a', 'message-1')).toEqual({
      agentId: 'tutor-a',
      sourceMessageId: 'message-1',
      dispatchId: 'dispatch-1',
    })
  })

  it('clears only the matching generation', () => {
    const setBinding = setImageTaskBinding as unknown as (
      sessionId: string,
      agentId: string,
      sourceMessageId: string,
      dispatchId: string,
    ) => void
    const clearBinding = clearImageTaskBinding as unknown as (
      sessionId: string,
      agentId: string,
      sourceMessageId: string,
      dispatchId?: string,
    ) => void
    setBinding('session-1', 'tutor-a', 'message-new', 'dispatch-new')

    clearBinding('session-1', 'tutor-a', 'message-new', 'dispatch-old')
    expect(hasImageTaskBinding('session-1', 'tutor-a')).toBe(true)

    clearBinding('session-1', 'tutor-a', 'message-new', 'dispatch-new')
    expect(hasImageTaskBinding('session-1', 'tutor-a')).toBe(false)
  })
})
