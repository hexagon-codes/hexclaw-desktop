/**
 * BUG-20260622-J — 禁用「持有当前默认模型的 provider」后，本地默认选择悬空在已禁用 provider。
 *
 * resolveDefaultModelProviderId / reconcileDefaultSelection 解析默认时不看 `enabled`，
 * 导致禁用默认 provider 后 config.llm.defaultProviderId 仍指向它：
 *   - SettingsView 默认模型下拉用 availableModels（仅启用 provider）→ 绑定值不在选项 → 渲染空白
 *   - ContextBar/InspectorContext 直读 defaultProviderId/defaultModel → 把已禁用 provider 显示为"生效"
 * 期望与后端 providersToBackend 一致：默认迁移到首个启用 provider，无启用项则清空。
 */
import { describe, it, expect } from 'vitest'
import {
  resolveDefaultModelProviderId,
  reconcileDefaultSelection,
} from '@/stores/settings-helpers'
import type { ProviderConfig } from '@/types'

function mkProvider(over: Partial<ProviderConfig> & { id: string }): ProviderConfig {
  return {
    name: over.id.toUpperCase(),
    type: 'openai',
    apiKey: '',
    baseUrl: '',
    enabled: true,
    models: [],
    selectedModelId: '',
    ...over,
  } as ProviderConfig
}

describe('J [P2] 禁用默认 provider 后默认不应悬空', () => {
  it('resolveDefaultModelProviderId: 模型只在已禁用 provider 上 → 不返回该禁用 provider', () => {
    const providers = [
      mkProvider({ id: 'pA', enabled: false, models: [{ id: 'gpt-x', name: 'gpt-x', capabilities: ['text'] }] }),
      mkProvider({ id: 'pB', enabled: true, models: [{ id: 'gpt-y', name: 'gpt-y', capabilities: ['text'] }], selectedModelId: 'gpt-y' }),
    ]
    expect(resolveDefaultModelProviderId(providers, 'gpt-x', 'pA')).not.toBe('pA')
  })

  it('reconcileDefaultSelection: 禁用默认 provider 后迁移到启用 provider', () => {
    const providers = [
      mkProvider({ id: 'pA', enabled: false, models: [{ id: 'gpt-x', name: 'gpt-x', capabilities: ['text'] }] }),
      mkProvider({ id: 'pB', enabled: true, models: [{ id: 'gpt-y', name: 'gpt-y', capabilities: ['text'] }], selectedModelId: 'gpt-y' }),
    ]
    const llm = {
      providers,
      defaultProviderId: 'pA',
      defaultModel: 'gpt-x',
      routing: { enabled: false, strategy: 'cost-aware' },
    } as unknown as Parameters<typeof reconcileDefaultSelection>[0]
    reconcileDefaultSelection(llm)
    expect(llm.defaultProviderId).not.toBe('pA')
    expect(llm.defaultProviderId).toBe('pB')
    expect(llm.defaultModel).toBe('gpt-y')
  })

  it('reconcileDefaultSelection: 无任何启用 provider 时清空默认', () => {
    const providers = [
      mkProvider({ id: 'pA', enabled: false, models: [{ id: 'gpt-x', name: 'gpt-x', capabilities: ['text'] }] }),
    ]
    const llm = {
      providers,
      defaultProviderId: 'pA',
      defaultModel: 'gpt-x',
      routing: { enabled: false, strategy: 'cost-aware' },
    } as unknown as Parameters<typeof reconcileDefaultSelection>[0]
    reconcileDefaultSelection(llm)
    expect(llm.defaultProviderId).toBe('')
    expect(llm.defaultModel).toBe('')
  })

  it('控制组：启用的 preferred provider 持有模型 → 正常返回', () => {
    const providers = [
      mkProvider({ id: 'pA', enabled: true, models: [{ id: 'gpt-x', name: 'gpt-x', capabilities: ['text'] }] }),
    ]
    expect(resolveDefaultModelProviderId(providers, 'gpt-x', 'pA')).toBe('pA')
  })
})
