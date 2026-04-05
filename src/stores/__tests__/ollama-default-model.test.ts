/**
 * 回归测试：Ollama 默认模型选择不被 reconcileDefaultSelection 清空
 *
 * 根因：reconcileDefaultSelection 通过 provider.models.some() 校验 defaultModel，
 * 但 Ollama 的 provider.models 永远为空（模型来自 ollamaModelsCache），导致
 * 每次 saveConfig/loadConfig 都把 defaultModel 清空为 ''。
 */
import { describe, it, expect } from 'vitest'
import {
  reconcileDefaultSelection,
  resolveDefaultModelProviderId,
  providersToBackend,
} from '@/stores/settings-helpers'
import type { ProviderConfig, AppConfig } from '@/types'

function makeOllamaProvider(overrides?: Partial<ProviderConfig>): ProviderConfig {
  return {
    id: 'ollama-1',
    name: 'Ollama (本地)',
    type: 'ollama',
    enabled: true,
    apiKey: '',
    baseUrl: 'http://localhost:11434/v1',
    models: [], // Ollama 的 models 永远为空
    selectedModelId: '',
    ...overrides,
  }
}

function makeOpenAIProvider(): ProviderConfig {
  return {
    id: 'openai-1',
    name: 'OpenAI',
    type: 'openai',
    enabled: true,
    apiKey: 'sk-test',
    baseUrl: 'https://api.openai.com/v1',
    models: [
      { id: 'gpt-4o', name: 'GPT-4o', capabilities: ['text', 'vision'] },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini', capabilities: ['text'] },
    ],
    selectedModelId: 'gpt-4o',
  }
}

function makeLLMConfig(
  providers: ProviderConfig[],
  defaultModel: string,
  defaultProviderId: string,
): AppConfig['llm'] {
  return {
    providers,
    defaultModel,
    defaultProviderId,
    routing: { enabled: false, strategy: 'cost-aware' },
  }
}

describe('Ollama 默认模型持久化 — 回归测试', () => {
  describe('reconcileDefaultSelection', () => {
    it('Ollama 默认模型不被清空（修复前会被重置为空字符串）', () => {
      const ollama = makeOllamaProvider()
      const config = makeLLMConfig([ollama], 'qwen3:0.6b', 'ollama-1')

      reconcileDefaultSelection(config)

      expect(config.defaultModel).toBe('qwen3:0.6b')
      expect(config.defaultProviderId).toBe('ollama-1')
    })

    it('Ollama selectedModelId 保持为用户选择的模型', () => {
      const ollama = makeOllamaProvider()
      const config = makeLLMConfig([ollama], 'qwen3:8b', 'ollama-1')

      reconcileDefaultSelection(config)

      expect(ollama.selectedModelId).toBe('qwen3:8b')
    })

    it('多次 reconcile 不会逐步退化', () => {
      const ollama = makeOllamaProvider()
      const config = makeLLMConfig([ollama], 'deepseek-r1:7b', 'ollama-1')

      // 模拟多次 save/load 循环
      reconcileDefaultSelection(config)
      reconcileDefaultSelection(config)
      reconcileDefaultSelection(config)

      expect(config.defaultModel).toBe('deepseek-r1:7b')
      expect(config.defaultProviderId).toBe('ollama-1')
    })

    it('非 Ollama provider 仍然正常校验模型（不影响原有逻辑）', () => {
      const openai = makeOpenAIProvider()
      const config = makeLLMConfig([openai], 'gpt-4o', 'openai-1')

      reconcileDefaultSelection(config)

      expect(config.defaultModel).toBe('gpt-4o')
      expect(config.defaultProviderId).toBe('openai-1')
    })

    it('非 Ollama provider 选了不存在的模型会被清空', () => {
      const openai = makeOpenAIProvider()
      const config = makeLLMConfig([openai], 'nonexistent-model', 'openai-1')

      reconcileDefaultSelection(config)

      // 不存在的模型 + provider 里也没有 → defaultModel 被清空
      expect(config.defaultModel).toBe('')
    })

    it('Ollama 和 OpenAI 共存时互不影响', () => {
      const ollama = makeOllamaProvider()
      const openai = makeOpenAIProvider()
      const config = makeLLMConfig([ollama, openai], 'qwen3:0.6b', 'ollama-1')

      reconcileDefaultSelection(config)

      expect(config.defaultModel).toBe('qwen3:0.6b')
      expect(config.defaultProviderId).toBe('ollama-1')
      // OpenAI 的 selectedModelId 不受影响
      expect(openai.selectedModelId).toBe('gpt-4o')
    })
  })

  describe('resolveDefaultModelProviderId', () => {
    it('Ollama 作为 preferred provider 时直接返回其 id（不校验 models 数组）', () => {
      const ollama = makeOllamaProvider()
      const result = resolveDefaultModelProviderId([ollama], 'qwen3:0.6b', 'ollama-1')
      expect(result).toBe('ollama-1')
    })

    it('name 包含 ollama 的 provider 也被识别', () => {
      const ollama = makeOllamaProvider({ id: 'custom-id', type: 'custom' as any, name: 'My Ollama Server' })
      const result = resolveDefaultModelProviderId([ollama], 'llama3.2', 'custom-id')
      expect(result).toBe('custom-id')
    })

    it('非 Ollama provider 仍然需要 models 匹配', () => {
      const openai = makeOpenAIProvider()
      const result = resolveDefaultModelProviderId([openai], 'gpt-4o', 'openai-1')
      expect(result).toBe('openai-1')
    })

    it('非 Ollama provider 模型不匹配时返回空字符串', () => {
      const openai = makeOpenAIProvider()
      const result = resolveDefaultModelProviderId([openai], 'nonexistent', 'openai-1')
      expect(result).toBe('')
    })
  })

  describe('providersToBackend', () => {
    it('Ollama 默认 provider 的 model 字段正确传给后端', () => {
      const ollama = makeOllamaProvider()
      const result = providersToBackend([ollama], 'qwen3:0.6b', 'ollama-1')

      const ollamaBackend = result.providers['Ollama (本地)']
      expect(ollamaBackend).toBeDefined()
      expect(ollamaBackend!.model).toBe('qwen3:0.6b')
    })

    it('Ollama 非默认 provider 时 model 不被强制设置', () => {
      const ollama = makeOllamaProvider()
      const openai = makeOpenAIProvider()
      const result = providersToBackend([ollama, openai], 'gpt-4o', 'openai-1')

      const ollamaBackend = result.providers['Ollama (本地)']
      // Ollama 不是默认 provider，走正常的 resolveProviderSelectedModelId（返回空）
      expect(ollamaBackend!.model).toBe('')
    })

    it('后端 default 字段指向 Ollama provider name', () => {
      const ollama = makeOllamaProvider()
      const result = providersToBackend([ollama], 'qwen3:0.6b', 'ollama-1')
      expect(result.default).toBe('Ollama (本地)')
    })
  })
})
