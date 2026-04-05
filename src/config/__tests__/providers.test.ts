/**
 * providers 配置测试
 *
 * 验证 Provider 预设数据完整性、Logo 映射和 getProviderTypes() 过滤逻辑
 */
import { describe, it, expect, vi } from 'vitest'

// Mock all SVG logo imports to avoid asset resolution errors
for (const name of [
  'openai', 'deepseek', 'anthropic', 'gemini', 'qwen', 'ark',
  'zhipu', 'kimi', 'ernie', 'hunyuan', 'spark', 'minimax',
  'ollama', 'custom',
]) {
  vi.mock(`@/assets/provider-logos/${name}.svg`, () => ({ default: `${name}.svg` }))
}

import { PROVIDER_PRESETS, PROVIDER_LOGOS, getProviderTypes } from '../providers'
import type { ProviderType } from '@/types'

const ALL_PROVIDER_KEYS: ProviderType[] = [
  'openai', 'deepseek', 'anthropic', 'gemini', 'qwen', 'ark',
  'zhipu', 'kimi', 'ernie', 'hunyuan', 'spark', 'minimax',
  'ollama', 'custom',
]

describe('PROVIDER_PRESETS', () => {
  it('has exactly 14 entries', () => {
    expect(Object.keys(PROVIDER_PRESETS)).toHaveLength(14)
  })

  it('each preset has required fields: type, name, defaultBaseUrl, placeholder', () => {
    for (const key of ALL_PROVIDER_KEYS) {
      const preset = PROVIDER_PRESETS[key]
      expect(preset).toHaveProperty('type')
      expect(preset).toHaveProperty('name')
      expect(preset).toHaveProperty('defaultBaseUrl')
      expect(preset).toHaveProperty('placeholder')
      expect(preset).toHaveProperty('defaultModels')
      expect(typeof preset.name).toBe('string')
      expect(typeof preset.defaultBaseUrl).toBe('string')
      expect(typeof preset.placeholder).toBe('string')
      expect(Array.isArray(preset.defaultModels)).toBe(true)
    }
  })

  it('each preset type matches its key', () => {
    for (const key of ALL_PROVIDER_KEYS) {
      expect(PROVIDER_PRESETS[key].type).toBe(key)
    }
  })

  it('major providers have non-empty defaultModels', () => {
    const majors: ProviderType[] = ['openai', 'anthropic', 'deepseek', 'gemini']
    for (const key of majors) {
      expect(PROVIDER_PRESETS[key].defaultModels.length).toBeGreaterThan(0)
    }
  })

  it('each model in presets has id, name, and capabilities array', () => {
    for (const key of ALL_PROVIDER_KEYS) {
      for (const model of PROVIDER_PRESETS[key].defaultModels) {
        expect(model).toHaveProperty('id')
        expect(model).toHaveProperty('name')
        expect(model).toHaveProperty('capabilities')
        expect(typeof model.id).toBe('string')
        expect(typeof model.name).toBe('string')
        expect(Array.isArray(model.capabilities)).toBe(true)
        expect(model.capabilities.length).toBeGreaterThan(0)
      }
    }
  })

  it('ollama has empty defaultModels array', () => {
    expect(PROVIDER_PRESETS.ollama.defaultModels).toEqual([])
  })

  it('custom has empty defaultModels array', () => {
    expect(PROVIDER_PRESETS.custom.defaultModels).toEqual([])
  })

  it('custom has empty defaultBaseUrl', () => {
    expect(PROVIDER_PRESETS.custom.defaultBaseUrl).toBe('')
  })

  it('OpenAI models include both text and vision capabilities', () => {
    const openaiModels = PROVIDER_PRESETS.openai.defaultModels
    const hasVision = openaiModels.some(m => m.capabilities.includes('vision'))
    const hasTextOnly = openaiModels.some(
      m => m.capabilities.includes('text') && !m.capabilities.includes('vision'),
    )
    expect(hasVision).toBe(true)
    expect(hasTextOnly).toBe(true)
  })

  it('all non-custom defaultBaseUrl values are valid URLs', () => {
    const nonCustomKeys = ALL_PROVIDER_KEYS.filter(k => k !== 'custom')
    for (const key of nonCustomKeys) {
      const url = PROVIDER_PRESETS[key].defaultBaseUrl
      expect(url).toMatch(/^https?:\/\//)
    }
  })
})

describe('PROVIDER_LOGOS', () => {
  it('has exactly 14 entries matching PRESETS keys', () => {
    const logoKeys = Object.keys(PROVIDER_LOGOS).sort()
    const presetKeys = Object.keys(PROVIDER_PRESETS).sort()
    expect(logoKeys).toEqual(presetKeys)
  })
})

describe('getProviderTypes()', () => {
  it('excludes ollama', () => {
    const types = getProviderTypes()
    const ollamaEntry = types.find(p => p.type === 'ollama')
    expect(ollamaEntry).toBeUndefined()
  })

  it('returns 13 entries (14 total minus ollama)', () => {
    expect(getProviderTypes()).toHaveLength(13)
  })

  it('includes all non-ollama types', () => {
    const types = getProviderTypes().map(p => p.type)
    const expected = ALL_PROVIDER_KEYS.filter(k => k !== 'ollama')
    expect(types).toEqual(expect.arrayContaining(expected))
    expect(expected).toEqual(expect.arrayContaining(types))
  })

  it('each returned item has required fields', () => {
    for (const preset of getProviderTypes()) {
      expect(preset).toHaveProperty('type')
      expect(preset).toHaveProperty('name')
      expect(preset).toHaveProperty('defaultBaseUrl')
      expect(preset).toHaveProperty('placeholder')
      expect(preset).toHaveProperty('defaultModels')
    }
  })
})
