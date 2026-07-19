import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearSessionDeepThinking,
  getSessionDeepThinking,
  pruneSessionDeepThinking,
  setSessionDeepThinking,
} from '../session-thinking-preference'

describe('session deep-thinking preference', () => {
  beforeEach(() => localStorage.clear())

  it('persists an enabled preference per session until the user disables it', () => {
    setSessionDeepThinking('a', true)
    expect(getSessionDeepThinking('a')).toBe(true)
    expect(getSessionDeepThinking('b')).toBe(false)

    setSessionDeepThinking('a', false)
    expect(getSessionDeepThinking('a')).toBe(false)
  })

  it('clears deleted sessions and prunes orphaned preferences', () => {
    setSessionDeepThinking('a', true)
    setSessionDeepThinking('b', true)
    clearSessionDeepThinking('a')
    pruneSessionDeepThinking(['b'])

    expect(getSessionDeepThinking('a')).toBe(false)
    expect(getSessionDeepThinking('b')).toBe(true)
  })
})
