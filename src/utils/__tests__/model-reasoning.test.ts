import { describe, expect, it } from 'vitest'
import { isQwenThinkingModel, withModelReasoningDefaults } from '@/utils/model-reasoning'

describe('model-reasoning', () => {
  it('detects qwen thinking models', () => {
    expect(isQwenThinkingModel('qwen3.5:9b')).toBe(true)
    expect(isQwenThinkingModel('qwen3:8b')).toBe(true)
    expect(isQwenThinkingModel('glm-5')).toBe(false)
  })

  it('requests thinking off for qwen thinking models by default', () => {
    expect(withModelReasoningDefaults('qwen3.5:9b')).toEqual({ thinking: 'off' })
  })

  it('does not override explicit thinking metadata', () => {
    expect(withModelReasoningDefaults('qwen3.5:9b', { thinking: 'on' })).toEqual({ thinking: 'on' })
  })

  it('preserves non-thinking metadata', () => {
    expect(withModelReasoningDefaults('qwen3.5:9b', { memory: 'off' })).toEqual({
      memory: 'off',
      thinking: 'off',
    })
  })

  it('omits metadata for non-qwen models when no metadata is present', () => {
    expect(withModelReasoningDefaults('glm-5')).toBeUndefined()
  })
})
