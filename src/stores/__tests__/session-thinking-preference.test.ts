import { beforeEach, describe, expect, it } from 'vitest'
import * as sessionThinkingPreference from '../session-thinking-preference'
import {
  clearSessionDeepThinking,
  getSessionDeepThinking,
  pruneSessionDeepThinking,
  setSessionDeepThinking,
} from '../session-thinking-preference'

type SessionThinkingPolicyApi = typeof sessionThinkingPreference & {
  getSessionThinkingPolicy: (sessionId: string) => unknown
  setSessionThinkingPolicy: (sessionId: string, policy: unknown) => void
}

const sessionPolicyApi = sessionThinkingPreference as SessionThinkingPolicyApi

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

  it('reads the legacy true value as an explicit on policy', () => {
    expect(sessionPolicyApi.getSessionThinkingPolicy).toBeTypeOf('function')
    localStorage.setItem(
      sessionThinkingPreference.SESSION_THINKING_STORAGE_KEY,
      JSON.stringify({ legacy: true }),
    )

    expect(sessionPolicyApi.getSessionThinkingPolicy('legacy')).toEqual({ mode: 'on' })
  })

  it('keeps explicit off distinct from an absent inherit preference', () => {
    expect(sessionPolicyApi.setSessionThinkingPolicy).toBeTypeOf('function')
    sessionPolicyApi.setSessionThinkingPolicy('inherited', { mode: 'inherit' })
    sessionPolicyApi.setSessionThinkingPolicy('off', { mode: 'off' })

    expect(sessionPolicyApi.getSessionThinkingPolicy('inherited')).toEqual({ mode: 'inherit' })
    expect(sessionPolicyApi.getSessionThinkingPolicy('off')).toEqual({ mode: 'off' })
    expect(JSON.parse(localStorage.getItem(sessionThinkingPreference.SESSION_THINKING_STORAGE_KEY) ?? '{}')).toEqual({
      off: { mode: 'off' },
    })
  })

  it('persists an explicit effort without leaking it to another session', () => {
    expect(sessionPolicyApi.setSessionThinkingPolicy).toBeTypeOf('function')
    sessionPolicyApi.setSessionThinkingPolicy('effort-session', { mode: 'effort', effort: 'xhigh' })

    expect(sessionPolicyApi.getSessionThinkingPolicy('effort-session')).toEqual({
      mode: 'effort',
      effort: 'xhigh',
    })
    expect(sessionPolicyApi.getSessionThinkingPolicy('other-session')).toEqual({ mode: 'inherit' })
  })
})
