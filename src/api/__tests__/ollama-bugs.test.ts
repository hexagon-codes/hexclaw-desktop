/**
 * Ollama Bug 复现 & 验证
 *
 * Bug 4: Ollama Provider 识别逻辑不一致（settings store vs OllamaCard）
 *
 * Bug 3 (流式解析) 在 ollama-pull-stream.test.ts 中独立测试（不依赖 module mock）
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

const mockGetLLMConfig = vi.fn()
const mockGetOllamaStatus = vi.fn()

vi.mock('@/api/config', () => ({
  getLLMConfig: () => mockGetLLMConfig(),
  updateLLMConfig: vi.fn().mockResolvedValue({}),
}))

vi.mock('@/api/ollama', () => ({
  getOllamaStatus: () => mockGetOllamaStatus(),
}))

vi.mock('@/api/settings', () => ({
  updateConfig: vi.fn().mockResolvedValue({}),
}))

vi.mock('@tauri-apps/plugin-store', () => {
  class MockLazyStore {
    async get() { return null }
    async set() {}
    async save() {}
    async delete() {}
  }
  return { LazyStore: MockLazyStore }
})

describe('Bug 4: Ollama Provider 识别逻辑不一致', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockGetLLMConfig.mockClear()
    mockGetOllamaStatus.mockClear()
  })

  it('type=custom + baseUrl=11434 的 Provider 不应被 isOllamaProvider 误判', async () => {
    const { useSettingsStore } = await import('@/stores/settings')
    const store = useSettingsStore()

    store.config = {
      llm: {
        providers: [
          {
            id: 'custom-local',
            name: 'My Local LLM',
            type: 'custom',
            enabled: true,
            apiKey: '',
            baseUrl: 'http://localhost:11434/v1',
            models: [{ id: 'test-model', name: 'Test', capabilities: ['text'] }],
          },
        ],
        defaultModel: 'test-model',
        defaultProviderId: 'custom-local',
        routing: { enabled: false, strategy: 'cost-aware' },
      },
      security: { gateway_enabled: true, injection_detection: true, pii_filter: false, content_filter: true, max_tokens_per_request: 8192, rate_limit_rpm: 60 },
      general: { language: 'zh-CN', log_level: 'info', data_dir: '', auto_start: false, defaultAgentRole: '' },
      notification: { system_enabled: true, sound_enabled: false, agent_complete: true },
      mcp: { default_protocol: 'stdio' },
    }
    store.runtimeProviders = store.config.llm.providers

    const availableModels = store.availableModels

    // 修复后：type=custom 的 provider 不被 isOllamaProvider 匹配，
    // 使用 provider.models 而非空的 ollamaModelsCache
    expect(availableModels).toHaveLength(1)
    expect(availableModels[0]!.modelId).toBe('test-model')
  })

  it('type=ollama 的 Provider 仍然使用 ollamaModelsCache', async () => {
    const { useSettingsStore } = await import('@/stores/settings')
    const store = useSettingsStore()

    store.config = {
      llm: {
        providers: [
          {
            id: 'ollama-local',
            name: 'Ollama (本地)',
            type: 'ollama',
            enabled: true,
            apiKey: '',
            baseUrl: 'http://localhost:11434/v1',
            models: [],
          },
        ],
        defaultModel: '',
        defaultProviderId: '',
        routing: { enabled: false, strategy: 'cost-aware' },
      },
      security: { gateway_enabled: true, injection_detection: true, pii_filter: false, content_filter: true, max_tokens_per_request: 8192, rate_limit_rpm: 60 },
      general: { language: 'zh-CN', log_level: 'info', data_dir: '', auto_start: false, defaultAgentRole: '' },
      notification: { system_enabled: true, sound_enabled: false, agent_complete: true },
      mcp: { default_protocol: 'stdio' },
    }
    store.runtimeProviders = store.config.llm.providers

    // Ollama provider — 初始没有 cache，availableModels 为空
    expect(store.availableModels).toHaveLength(0)

    // sync 后有模型
    mockGetOllamaStatus.mockResolvedValue({
      running: true, associated: true, model_count: 1,
      models: [{ name: 'qwen3:8b', size: 5_000_000_000 }],
    })
    await store.syncOllamaModels()

    expect(store.availableModels).toHaveLength(1)
    expect(store.availableModels[0]!.modelId).toBe('qwen3:8b')
  })
})
