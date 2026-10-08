import { describe, expect, it } from 'vitest'
import { collectAvailableChatModels, projectReasoningPolicyForModel, reasoningModelState } from '@/config/model-contract'
import type { ModelOption, ModelReasoningControl, ProviderConfig, ReasoningPolicy } from '@/types'
import { resolveReasoningPolicy, toReasoningRequest } from '@/utils/reasoning-policy'
import { buildChatRequestMetadata } from '../chat-request-metadata'
import { freezeChatRouteSnapshot } from '../chat-route-snapshot'
import { normalizeReasoningReceipt } from '@/types/chat'

const nativeModel: ModelOption = {
  id: 'exact-model',
  name: 'Exact model',
  capabilities: ['text'],
  reasoningSupport: 'unknown',
  nativeReasoningSupport: 'unknown',
  nativeReasoningSourceFingerprint: 'source-a',
  effectiveNativeReasoningSupport: 'supported',
  effectiveNativeReasoningSourceFingerprint: 'source-a',
}

function provider(id: string, model: ModelOption): ProviderConfig {
  return { id, backendKey: id, name: id, enabled: true, type: 'custom', apiKey: '', baseUrl: '', models: [model] }
}

describe('shared reasoning entry data', () => {
  it('projects native evidence and source identity without manufacturing a control contract', () => {
    const [result] = collectAvailableChatModels([provider('provider-a', nativeModel)], [])
    expect(result).toMatchObject({
      nativeReasoningSupport: 'unknown',
      nativeReasoningSourceFingerprint: 'source-a',
      effectiveNativeReasoningSupport: 'supported',
      effectiveNativeReasoningSourceFingerprint: 'source-a',
      reasoningSupport: 'unknown',
    })
    expect(result?.reasoningControl).toBeUndefined()
  })

  it('keeps the same model ID in two instances independent', () => {
    const models = collectAvailableChatModels([
      provider('provider-a', nativeModel),
      provider('provider-b', {
        ...nativeModel,
        nativeReasoningSourceFingerprint: 'source-b',
        effectiveNativeReasoningSupport: 'unknown',
        effectiveNativeReasoningSourceFingerprint: 'source-b',
      }),
    ], [])
    expect(reasoningModelState(models[0])).toBe('native')
    expect(reasoningModelState(models[1])).toBe('unknown')
  })

  it('gives a valid control contract precedence while keeping native evidence independent', () => {
    expect(reasoningModelState({
      ...nativeModel,
      reasoningSupport: 'supported',
      reasoningControl: { dialect: 'think', on: true, off: false },
    })).toBe('controllable')
    expect(reasoningModelState(nativeModel)).toBe('native')
    expect(reasoningModelState({ reasoningSupport: 'unsupported' })).toBe('unsupported')
    expect(reasoningModelState(undefined)).toBe('unknown')
  })

  it('does not let static positive evidence override an effective unknown', () => {
    expect(reasoningModelState({
      nativeReasoningSupport: 'supported',
      effectiveNativeReasoningSupport: 'unknown',
    })).toBe('unknown')
  })

  it('does not promote malformed effort controls to a usable contract', () => {
    expect(reasoningModelState({
      reasoningSupport: 'supported',
      reasoningControl: { dialect: 'reasoning_effort', on: 'high', off: 'none', allowed_efforts: [] },
    })).toBe('unknown')
  })

  it('preserves explicit auto ahead of Agent and global off', () => {
    expect(resolveReasoningPolicy({
      sessionPolicy: { mode: 'auto' },
      agentPolicy: { mode: 'off' },
      globalPolicy: { mode: 'off' },
      nativePolicy: { mode: 'off' },
    })).toEqual({ source: 'session', policy: { mode: 'auto' } })
  })

  it('preserves a saved effort policy when only the current model capability changes', () => {
    const saved: ReasoningPolicy = Object.freeze({ mode: 'effort', effort: 'high' })
    for (const model of [nativeModel, { ...nativeModel, effectiveNativeReasoningSupport: 'unknown' as const }]) {
      const resolved = resolveReasoningPolicy({ globalPolicy: saved })
      toReasoningRequest(resolved.policy, model.reasoningSupport ?? 'unknown', model.reasoningControl)
      expect(resolved.policy).toEqual({ mode: 'effort', effort: 'high' })
      expect(saved).toEqual({ mode: 'effort', effort: 'high' })
    }
  })

  it('freezes auto and sends the request intent without an effort or a synthetic off', () => {
    const snapshot = freezeChatRouteSnapshot({
      agentRole: 'agent-a',
      chatParams: { provider: 'provider-a', model: 'exact-model' },
      thinkingEnabled: false,
      reasoningPolicy: resolveReasoningPolicy({ sessionPolicy: { mode: 'auto' }, agentPolicy: { mode: 'off' } }).policy,
    })
    expect(snapshot.reasoningPolicy).toEqual({ mode: 'auto' })
    expect(buildChatRequestMetadata({
      thinkingEnabled: snapshot.thinkingEnabled,
      reasoningPolicy: snapshot.reasoningPolicy,
      memoryEnabled: true,
    })).toEqual({ thinking: 'auto' })
  })

  it('keeps explicit off and exact supported effort request metadata distinct', () => {
    expect(buildChatRequestMetadata({
      thinkingEnabled: false,
      reasoningPolicy: { mode: 'off' },
      memoryEnabled: true,
    })).toEqual({ thinking: 'off' })
    expect(buildChatRequestMetadata({
      thinkingEnabled: true,
      reasoningPolicy: { mode: 'effort', effort: 'high' },
      reasoningControl: { dialect: 'reasoning_effort', on: 'high', off: 'none', allowed_efforts: ['low', 'high'] },
      memoryEnabled: true,
    })).toEqual({ thinking: 'on', thinking_effort: 'high' })
  })

  it.each([
    [{ mode: 'on' }, { thinking: 'on' }],
    [{ mode: 'effort', effort: 'high' }, { thinking: 'on', thinking_effort: 'high' }],
  ] as const)('retains the explicit %j intent when controls are unknown', (policy, expected) => {
    expect(buildChatRequestMetadata({
      thinkingEnabled: false,
      reasoningPolicy: policy,
      memoryEnabled: true,
    })).toEqual(expected)
  })

  it('keeps explicit off ahead of a stale enabled presentation', () => {
    expect(buildChatRequestMetadata({
      thinkingEnabled: true,
      reasoningPolicy: { mode: 'off' },
      memoryEnabled: true,
    })).toEqual({ thinking: 'off' })
  })

  it.each([
    { dialect: 'reasoning_effort', on: 'low', off: 'none', allowed_efforts: ['low'] },
    { dialect: 'think', on: true, off: false },
  ] satisfies ModelReasoningControl[])('projects an inherited high preference for %j without changing the saved policy', (control) => {
    const saved: ReasoningPolicy = Object.freeze({ mode: 'effort', effort: 'high' })
    const currentModel = { reasoningSupport: 'supported' as const, reasoningControl: control }
    const executable = projectReasoningPolicyForModel(saved, currentModel)
    expect(executable).toEqual({ mode: 'auto' })
    expect(buildChatRequestMetadata({
      thinkingEnabled: toReasoningRequest(executable, 'supported', control).thinkingEnabled,
      reasoningPolicy: executable,
      reasoningControl: control,
      memoryEnabled: true,
    })).toEqual({ thinking: 'auto' })
    expect(saved).toEqual({ mode: 'effort', effort: 'high' })
    expect(projectReasoningPolicyForModel(saved, {
      reasoningSupport: 'supported',
      reasoningControl: { dialect: 'reasoning_effort', on: 'high', off: 'none', allowed_efforts: ['low', 'high'] },
    })).toEqual({ mode: 'effort', effort: 'high' })
    expect(projectReasoningPolicyForModel(saved, nativeModel)).toEqual({ mode: 'effort', effort: 'high' })
  })

  it.each(['on', 'off'] as const)('accepts a trusted inherited %s receipt without an explicit off expectation', (request) => {
    const receipt = {
      version: 1 as const,
      reasoning_request: request,
      reasoning_support: 'supported' as const,
      reasoning_execution: 'applied' as const,
    }
    expect(normalizeReasoningReceipt(receipt)).toEqual(receipt)
    expect(normalizeReasoningReceipt(undefined)).toEqual({
      version: 1, reasoning_request: 'off', reasoning_support: 'unknown', reasoning_execution: 'unknown',
    })
    expect(normalizeReasoningReceipt({ ...receipt, reasoning_execution: 'invalid' })).toEqual({
      version: 1, reasoning_request: 'off', reasoning_support: 'unknown', reasoning_execution: 'unknown',
    })
  })
})
