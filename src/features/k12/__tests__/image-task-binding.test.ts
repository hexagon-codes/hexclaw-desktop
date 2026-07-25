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
    setImageTaskBinding('session-1', 'tutor-a', 'dispatch-1')

    expect(getImageTaskBinding('session-1', 'tutor-a')).toEqual({
      agentId: 'tutor-a',
      dispatchId: 'dispatch-1',
    })
    expect(hasImageTaskBinding('session-1', 'tutor-a')).toBe(true)
    expect(JSON.parse(localStorage.getItem(K12_IMAGE_TASK_BINDINGS_KEY) ?? '{}')).toEqual({
      version: 1,
      bindings: {
        'session-1': {
          agent_id: 'tutor-a',
          dispatch_id: 'dispatch-1',
        },
      },
    })
  })

  it('fails closed for a different owner and corrupt persisted data', () => {
    setImageTaskBinding('session-1', 'tutor-a', 'dispatch-1')
    expect(getImageTaskBinding('session-1', 'tutor-b')).toBeNull()

    localStorage.setItem(
      K12_IMAGE_TASK_BINDINGS_KEY,
      JSON.stringify({
        version: 1,
        bindings: {
          'session-1': {
            agent_id: 'tutor-a',
            dispatch_id: '',
            image_base64: 'must-not-survive',
          },
        },
      }),
    )

    expect(getImageTaskBinding('session-1', 'tutor-a')).toBeNull()
    expect(localStorage.getItem(K12_IMAGE_TASK_BINDINGS_KEY)).toBeNull()
  })

  it('clears only the matching generation', () => {
    setImageTaskBinding('session-1', 'tutor-a', 'dispatch-new')

    clearImageTaskBinding('session-1', 'tutor-a', 'dispatch-old')
    expect(hasImageTaskBinding('session-1', 'tutor-a')).toBe(true)

    clearImageTaskBinding('session-1', 'tutor-a', 'dispatch-new')
    expect(hasImageTaskBinding('session-1', 'tutor-a')).toBe(false)
  })
})
