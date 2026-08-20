import { describe, expect, it } from 'vitest'
import {
  allowedReasoningEfforts,
  nativeReasoningPolicyFromControl,
  normalizeDefaultReasoningPolicy,
  resolveReasoningPolicy,
  toReasoningRequest,
} from '../reasoning-policy'
import type { DefaultReasoningPolicy } from '@/types'

describe('reasoning policy', () => {
  const nativePolicy = { mode: 'effort', effort: 'medium' } as const

  it('prioritizes the explicit session policy over Agent, global and native defaults', () => {
    expect(resolveReasoningPolicy({
      sessionPolicy: { mode: 'effort', effort: 'low' },
      agentPolicy: { mode: 'effort', effort: 'high' },
      globalPolicy: { mode: 'off' },
      nativePolicy,
    })).toEqual({
      source: 'session',
      policy: { mode: 'effort', effort: 'low' },
    })
  })

  it('keeps explicit off distinct from inherit', () => {
    expect(resolveReasoningPolicy({
      sessionPolicy: { mode: 'inherit' },
      agentPolicy: { mode: 'off' },
      globalPolicy: { mode: 'effort', effort: 'high' },
      nativePolicy,
    })).toEqual({
      source: 'agent',
      policy: { mode: 'off' },
    })
  })

  it('uses the model native policy when a higher scope explicitly chooses auto', () => {
    expect(resolveReasoningPolicy({
      sessionPolicy: { mode: 'inherit' },
      agentPolicy: { mode: 'inherit' },
      globalPolicy: { mode: 'auto' },
      nativePolicy: { mode: 'effort', effort: 'high' },
    })).toEqual({
      source: 'global',
      policy: { mode: 'effort', effort: 'high' },
    })
  })

  it('derives the native policy only from the exact model capability', () => {
    expect(nativeReasoningPolicyFromControl(
      'supported',
      {
        dialect: 'reasoning_effort',
        on: 'high',
        off: 'none',
        allowed_efforts: ['low', 'high'],
      },
    )).toEqual({ mode: 'effort', effort: 'high' })
    expect(nativeReasoningPolicyFromControl(
      'supported',
      { dialect: 'think', on: true, off: false },
    )).toEqual({ mode: 'on' })
    expect(nativeReasoningPolicyFromControl('unknown', undefined)).toEqual({ mode: 'off' })
  })

  it('normalizes an invalid global inherit value to auto', () => {
    expect(normalizeDefaultReasoningPolicy({ mode: 'inherit' })).toEqual({ mode: 'auto' })
  })

  it('does not admit inherit in the global policy type', () => {
    // @ts-expect-error 全局策略没有上层可继承。
    const invalidGlobalPolicy: DefaultReasoningPolicy = { mode: 'inherit' }
    expect(invalidGlobalPolicy).toEqual({ mode: 'inherit' })
  })

  it('exposes only the exact effort values declared by an effort dialect', () => {
    expect(allowedReasoningEfforts({
      dialect: 'reasoning_effort',
      on: 'high',
      off: 'none',
      allowed_efforts: ['low', 'high', 'xhigh'],
    })).toEqual(['low', 'high', 'xhigh'])
    expect(allowedReasoningEfforts({
      dialect: 'think',
      on: true,
      off: false,
    })).toEqual([])
  })

  it('does not emit an effort for a boolean thinking dialect', () => {
    expect(toReasoningRequest(
      { mode: 'effort', effort: 'high' },
      'supported',
      { dialect: 'think', on: true, off: false },
    )).toEqual({ thinkingEnabled: true })
  })
})
