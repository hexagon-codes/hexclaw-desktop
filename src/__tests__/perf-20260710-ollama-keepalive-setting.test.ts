/**
 * BUG-20260710 P1 · Ollama keep_alive 设置化(桌面侧)。
 * 16GB 机 9B 模型驻留≈7GB,固定 30m 不可调——契约:
 *  1. ProviderConfig.keepAlive ⇄ backend provider.keep_alive 双向映射(丢失即设置保存后消失);
 *  2. OllamaCard 提供「模型驻留时长」选择,变更走既有保存链。
 */
import { describe, it, expect } from 'vitest'
import { backendToProviders, providersToBackend } from '@/stores/settings-helpers'
import type { ProviderConfig } from '@/types/settings'
import fs from 'node:fs'
import path from 'node:path'

const SRC = path.resolve(__dirname, '..')

describe('P1 · keep_alive 双向映射', () => {
  it('★出向:ProviderConfig.keepAlive → backend keep_alive', () => {
    const providers: ProviderConfig[] = [{
      id: 'ollama', backendKey: 'Ollama (本地)', name: 'Ollama (本地)', type: 'ollama',
      enabled: true, apiKey: '', baseUrl: 'http://127.0.0.1:11434',
      models: [{ id: 'qwen3.5:9b', name: 'qwen' }], selectedModelId: 'qwen3.5:9b',
      keepAlive: '5m',
    }]
    const backend = providersToBackend(providers, 'qwen3.5:9b', 'ollama')
    expect(backend.providers['Ollama (本地)']!.keep_alive).toBe('5m')
  })

  it('★入向:backend keep_alive → ProviderConfig.keepAlive(保存-重载不丢)', () => {
    const list = backendToProviders({
      default: 'Ollama (本地)',
      providers: {
        'Ollama (本地)': { api_key: '', base_url: 'http://127.0.0.1:11434', model: 'qwen3.5:9b', compatible: '', keep_alive: '15m' },
      },
    } as never, [])
    expect(list[0]!.keepAlive).toBe('15m')
  })

  it('★OllamaCard 提供驻留时长控件并接线 keepAlive', () => {
    const body = fs.readFileSync(path.join(SRC, 'components/settings/OllamaCard.vue'), 'utf8')
    expect(body).toContain('data-testid="ollama-keepalive"')
    expect(body).toContain('keepAlive')
  })
})
