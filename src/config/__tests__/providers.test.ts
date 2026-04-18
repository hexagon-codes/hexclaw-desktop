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

import {
  PROVIDER_PRESETS,
  PROVIDER_LOGOS,
  getProviderTypes,
  inferCapabilitiesFromId,
  resolveOllamaCapabilities,
  isChatModel,
  classifyModel,
} from '../providers'
import type { ModelCapability, ProviderType } from '@/types'

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
        expect(model.capabilities!.length).toBeGreaterThan(0)
      }
    }
  })

  it('ollama defaultModels 预填多模态 + 代码白名单', () => {
    const models = PROVIDER_PRESETS.ollama.defaultModels
    expect(models.length).toBeGreaterThanOrEqual(10)
    // 多模态代表
    expect(models.some(m => m.id === 'qwen2.5-vl')).toBe(true)
    expect(models.some(m => m.id === 'llava')).toBe(true)
    expect(models.some(m => m.id === 'llama3.2-vision')).toBe(true)
    // 代码代表
    expect(models.some(m => m.id === 'qwen3-coder' && m.capabilities?.includes('code'))).toBe(true)
    expect(models.some(m => m.id === 'deepseek-coder' && m.capabilities?.includes('code'))).toBe(true)
    // 每个白名单条目至少有一个非-text 能力
    for (const m of models) {
      const extras = (m.capabilities ?? []).filter(c => c !== 'text')
      expect(extras.length).toBeGreaterThan(0)
    }
  })

  it('custom has empty defaultModels array', () => {
    expect(PROVIDER_PRESETS.custom.defaultModels).toEqual([])
  })

  it('custom has empty defaultBaseUrl', () => {
    expect(PROVIDER_PRESETS.custom.defaultBaseUrl).toBe('')
  })

  it('OpenAI models include both text and vision capabilities', () => {
    const openaiModels = PROVIDER_PRESETS.openai.defaultModels
    const hasVision = openaiModels.some(m => m.capabilities?.includes('vision'))
    const hasTextOnly = openaiModels.some(
      m => m.capabilities?.includes('text') && !m.capabilities?.includes('vision'),
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

describe('inferCapabilitiesFromId() — vision', () => {
  it.each([
    // Ollama 本地多模态
    ['qwen2.5-vl:7b', true],
    ['qwen3-vl:8b', true],
    ['llava:13b', true],
    ['llama3.2-vision:11b', true],
    ['minicpm-v:8b', true],
    ['moondream', true],
    ['bakllava', true],
    ['gemma4:e4b', true],
    ['my-custom-vision-tune', true],
    // 云端命名
    ['qwen-vl-max', true],
    ['glm-4v', true],
    ['glm-4v-plus', true],
    ['glm-4.5v', true],
    ['gpt-4o', true],
    ['gpt-4o-mini', true],
    ['gpt-4-vision-preview', true],
    ['claude-3-opus', true],
    ['claude-sonnet-4-5', true],
    ['gemini-2.5-pro', true],
    ['internvl-chat', true],
    ['pixtral-12b', true],
    ['molmo-7b', true],
    ['cogvlm-chat', true],
    ['qvq-72b-preview', true],
    // 纯文本
    ['qwen3:8b', false],
    ['qwen-max', false],
    ['qwen-plus', false],
    ['deepseek-r1:7b', false],
    ['deepseek-chat', false],
    ['llama3:8b', false],
    ['glm-z1-flash', false],
    ['o3-mini', false],
  ])('%s → vision=%s', (id, shouldHaveVision) => {
    const caps = inferCapabilitiesFromId(id)
    expect(caps).toContain('text')
    expect(caps.includes('vision')).toBe(shouldHaveVision)
  })
})

describe('inferCapabilitiesFromId() — pure generation', () => {
  it.each([
    ['cogview-4', 'image_generation'],
    ['cogview-3-plus', 'image_generation'],
    ['dall-e-3', 'image_generation'],
    ['dalle-2', 'image_generation'],
    ['flux', 'image_generation'],
    ['stable-diffusion-xl', 'image_generation'],
    ['midjourney-v6', 'image_generation'],
    ['imagen-3', 'image_generation'],
    ['cogvideox-2', 'video_generation'],
    ['cogvideo-1', 'video_generation'],
    ['sora', 'video_generation'],
    ['kling-1.6', 'video_generation'],
    ['hailuo-01', 'video_generation'],
  ])('%s → 纯生成 [%s]（不带 text）', (id, expected) => {
    expect(inferCapabilitiesFromId(id)).toEqual([expected])
  })
})

describe('inferCapabilitiesFromId() — audio', () => {
  it.each([
    ['whisper-1', true],
    ['tts-1', true],
    ['glm-4-voice', true],
    ['qwen-audio-chat', true],
    ['gpt-4o-audio-preview', true],
    ['qwen3:8b', false],
  ])('%s → audio=%s', (id, hasAudio) => {
    expect(inferCapabilitiesFromId(id).includes('audio')).toBe(hasAudio)
  })
})

describe('inferCapabilitiesFromId() — code', () => {
  it.each([
    ['qwen3-coder:8b', true],
    ['qwen-coder', true],
    ['deepseek-coder', true],
    ['deepseek-coder-v2', true],
    ['codellama:13b', true],
    ['codegemma:7b', true],
    ['starcoder2:15b', true],
    ['granite-code:8b', true],
    ['devstral', true],
    ['wizardcoder', true],
    ['magicoder', true],
    // 普通模型不应误判
    ['qwen3:8b', false],
    ['gpt-4o', false],
    ['gemini-2.5-pro', false],
  ])('%s → code=%s', (id, hasCode) => {
    expect(inferCapabilitiesFromId(id).includes('code')).toBe(hasCode)
  })
})

describe('resolveOllamaCapabilities()', () => {
  it('命中 preset 白名单（base ID 去 tag）→ 沿用预设 capabilities', () => {
    expect(resolveOllamaCapabilities('qwen2.5-vl:7b')).toEqual(['text', 'vision'])
    expect(resolveOllamaCapabilities('llava:13b')).toEqual(['text', 'vision'])
    // 不带 tag 也应命中
    expect(resolveOllamaCapabilities('moondream')).toEqual(['text', 'vision'])
  })

  it('未命中白名单 → 回退 inferCapabilitiesFromId 正则兜底', () => {
    // "vision" 关键词兜底
    expect(resolveOllamaCapabilities('custom-vision-v2:latest')).toContain('vision')
    // 纯文本模型不标 vision
    expect(resolveOllamaCapabilities('qwen3:8b')).toEqual(['text'])
    expect(resolveOllamaCapabilities('deepseek-r1:14b')).toEqual(['text'])
  })
})

describe('isChatModel() / classifyModel() — 聊天页过滤', () => {
  it.each<[ModelCapability[], boolean]>([
    [['text'], true],
    [['text', 'vision'], true],
    [['text', 'vision', 'video', 'audio'], true],
    // 纯生成 / 纯语音工具不可对话
    [['image_generation'], false],
    [['video_generation'], false],
    [['audio'], false],
  ])('%j → isChatModel=%s', (caps, expected) => {
    expect(isChatModel(caps)).toBe(expected)
  })

  it.each<[ModelCapability[], string]>([
    [['text'], 'chat'],
    [['text', 'vision'], 'chat'],
    [['image_generation'], 'image_generator'],
    [['video_generation'], 'video_generator'],
    [['audio'], 'audio_tool'],
  ])('classifyModel(%j) === %s', (caps, kind) => {
    expect(classifyModel(caps)).toBe(kind)
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
