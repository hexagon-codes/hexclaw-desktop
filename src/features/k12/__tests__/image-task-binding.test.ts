import { beforeEach, describe, expect, it } from 'vitest'
import {
  K12_IMAGE_TASK_BINDINGS_KEY,
  clearImageTaskBinding,
  getImageTaskBinding,
  hasImageTaskBinding,
  setImageTaskBinding,
} from '../image-task-binding'

describe('session → ImageTaskDispatch durable binding', () => {
  beforeEach(() => {
    localStorage.clear()
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
    expect(JSON.parse(localStorage.getItem(K12_IMAGE_TASK_BINDINGS_KEY) ?? '{}')).toEqual({
      version: 2,
      bindings: [
        {
          source_session_id: 'session-1',
          agent_id: 'tutor-a',
          source_message_id: 'message-1',
          dispatch_id: 'dispatch-1',
        },
      ],
    })
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

    const persisted = JSON.parse(
      localStorage.getItem(K12_IMAGE_TASK_BINDINGS_KEY) ?? '{}',
    ) as { bindings?: Array<Record<string, string>> }
    expect(persisted.bindings).toEqual([
      {
        source_session_id: 'session-1',
        agent_id: 'tutor-a',
        source_message_id: 'message-1',
        dispatch_id: 'dispatch-1',
      },
      {
        source_session_id: 'session-1',
        agent_id: 'tutor-a',
        source_message_id: 'message-2',
        dispatch_id: 'dispatch-2',
      },
    ])
  })

  it('fails closed for a different owner and corrupt persisted data', () => {
    const setBinding = setImageTaskBinding as unknown as (
      sessionId: string,
      agentId: string,
      sourceMessageId: string,
      dispatchId: string,
    ) => void
    setBinding('session-1', 'tutor-a', 'message-1', 'dispatch-1')
    expect(getImageTaskBinding('session-1', 'tutor-b', 'message-1')).toBeNull()

    localStorage.setItem(
      K12_IMAGE_TASK_BINDINGS_KEY,
      JSON.stringify({
        version: 2,
        bindings: [
          {
            source_session_id: 'session-1',
            agent_id: 'tutor-a',
            source_message_id: '',
            dispatch_id: '',
            image_base64: 'must-not-survive',
          },
        ],
      }),
    )

    expect(getImageTaskBinding('session-1', 'tutor-a', 'message-1')).toBeNull()
    expect(localStorage.getItem(K12_IMAGE_TASK_BINDINGS_KEY)).toBeNull()
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
