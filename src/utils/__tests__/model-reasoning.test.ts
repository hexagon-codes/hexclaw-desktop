import { describe, expect, it } from 'vitest'
import { isQwenThinkingModel, withModelReasoningDefaults } from '@/utils/model-reasoning'

const explicitThinkingMetadata: Record<string, string>[] = [
  { thinking: 'auto' },
  { thinking: 'on' },
  { thinking: 'off' },
  { thinking: 'on', thinking_effort: 'high' },
]

describe('model-reasoning', () => {
  it('detects qwen thinking models', () => {
    expect(isQwenThinkingModel('qwen3.5:9b')).toBe(true)
    expect(isQwenThinkingModel('qwen3:8b')).toBe(true)
    expect(isQwenThinkingModel('Qwen/Qwen3.6-35B-A3B')).toBe(true)
    expect(isQwenThinkingModel('glm-5')).toBe(false)
  })

  it('keeps omitted thinking metadata available for backend inheritance', () => {
    expect(withModelReasoningDefaults('qwen3.5:9b')).toBeUndefined()
    expect(withModelReasoningDefaults('Qwen/Qwen3.6-35B-A3B')).toBeUndefined()
  })

  it('does not override explicit thinking metadata', () => {
    expect(withModelReasoningDefaults('qwen3.5:9b', { thinking: 'on' })).toEqual({ thinking: 'on' })
  })

  it('preserves non-thinking metadata', () => {
    expect(withModelReasoningDefaults('qwen3.5:9b', { memory: 'off' })).toEqual({
      memory: 'off',
    })
  })

  it('omits metadata for non-qwen models when no metadata is present', () => {
    expect(withModelReasoningDefaults('glm-5')).toBeUndefined()
  })

  it.each(explicitThinkingMetadata)('retains explicit %j metadata without changing the caller object', (input) => {
    const source = Object.freeze(input)
    const result = withModelReasoningDefaults('qwen3.5:9b', source)
    expect(result).toEqual(input)
    expect(result).not.toBe(source)
    expect(source).toEqual(input)
  })

  it('keeps Quick Chat routing metadata without adding a thinking override', () => {
    const routing = Object.freeze({ pinned_agent: 'default', producer_kind: 'quick_chat', locale: 'zh-CN' })
    expect(withModelReasoningDefaults('qwen3.5:9b', routing)).toEqual(routing)
    expect(withModelReasoningDefaults('plain-model', routing)).toEqual(routing)
    expect(routing).not.toHaveProperty('thinking')
  })
})
