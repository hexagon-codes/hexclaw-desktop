import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, enableAutoUnmount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import WelcomeView from '../WelcomeView.vue'
import zhCN from '@/i18n/locales/zh-CN'

const fixture = vi.hoisted(() => ({
  context: { connectionId: 'local', backendId: 'local-backend', configRevision: 1, activationGeneration: 1, kind: 'local' as const, apiBase: 'http://127.0.0.1:16060', wsBase: 'ws://127.0.0.1:16060', hasToken: false },
  config: { llm: { defaultModel: 'fixture-model' } },
  inspect: vi.fn(), loadConfig: vi.fn(), activate: vi.fn(),
  addProvider: vi.fn(), saveConfig: vi.fn(), testLLMConnection: vi.fn(),
  replace: vi.fn(), flush: vi.fn(), readReturn: vi.fn(), saveReturn: vi.fn(),
}))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn((command: string) => {
    if (command === 'get_backend_connections') return Promise.resolve([])
    if (command === 'inspect_backend_readiness') return fixture.inspect()
    if (command === 'activate_backend_connection') return fixture.activate()
    throw new Error(`Unexpected native command: ${command}`)
  }),
}))
vi.mock('@/utils/platform', () => ({ isTauri: () => true }))
vi.mock('@/utils/splash', () => ({ dismissSplash: vi.fn() }))
vi.mock('@/services/backend-context', () => ({
  backendContext: { value: fixture.context },
  flushBackendDrafts: fixture.flush,
  readModelSettingsReturn: fixture.readReturn,
  saveModelSettingsReturn: fixture.saveReturn,
}))
vi.mock('@/api/config', () => ({ testLLMConnection: fixture.testLLMConnection, getLLMConfig: vi.fn() }))
vi.mock('@/api/system', () => ({ getVersion: vi.fn() }))
vi.mock('@/stores/settings', () => ({
  useSettingsStore: () => ({ config: fixture.config, loadConfig: fixture.loadConfig, addProvider: fixture.addProvider, saveConfig: fixture.saveConfig }),
}))
vi.mock('vue-router', () => ({ useRouter: () => ({ replace: fixture.replace }) }))

function mountWelcome() {
  return mount(WelcomeView, { global: { plugins: [createI18n({ legacy: false, locale: 'zh-CN', messages: { 'zh-CN': zhCN } })] } })
}
enableAutoUnmount(afterEach)

describe('WelcomeView onboarding', () => {
  beforeEach(() => {
    Object.values(fixture).forEach(value => { if (vi.isMockFunction(value)) value.mockReset() })
    sessionStorage.clear()
    fixture.config.llm.defaultModel = 'fixture-model'
    fixture.inspect.mockResolvedValue({ context: fixture.context, version: 'v0.5.0-beta', defaultModel: 'fixture-model' })
    fixture.loadConfig.mockResolvedValue(undefined)
    fixture.flush.mockResolvedValue(undefined)
    fixture.readReturn.mockReturnValue(null)
  })

  it('checks the service and default model in separate receipts without calling the model', async () => {
    const wrapper = mountWelcome()
    await flushPromises()
    await wrapper.get('.wiz-f .btn-primary').trigger('click')
    await flushPromises()
    const receipts = wrapper.findAll('.wiz-check')
    expect(receipts).toHaveLength(2)
    expect(receipts[0]!.text()).toContain('后端服务已连接')
    expect(receipts[1]!.text()).toContain('默认模型已选好')
    expect(receipts[1]!.text()).toContain('fixture-model')
    expect(fixture.inspect).toHaveBeenCalledTimes(1)
    expect(fixture.activate).not.toHaveBeenCalled()
    expect(fixture.testLLMConnection).not.toHaveBeenCalled()
  })

  it('finishes the checked wizard and returns to chat without editing providers', async () => {
    const wrapper = mountWelcome()
    await flushPromises()
    await wrapper.get('.wiz-f .btn-primary').trigger('click')
    await flushPromises()
    await wrapper.get('.wiz-f .btn-primary').trigger('click')
    await flushPromises()
    expect(fixture.flush).toHaveBeenCalledTimes(1)
    expect(fixture.loadConfig).toHaveBeenCalledWith({ force: true })
    expect(fixture.replace).toHaveBeenCalledWith('/chat')
    expect(fixture.addProvider).not.toHaveBeenCalled()
    expect(fixture.saveConfig).not.toHaveBeenCalled()
  })

  it('allows a fresh service check after the previous one settles', async () => {
    fixture.inspect.mockRejectedValueOnce(new Error('first failed'))
    const wrapper = mountWelcome()
    await flushPromises()
    await wrapper.get('.wiz-f .btn-primary').trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="status"]').text()).toContain('first failed')
    await wrapper.get('.wiz-f .btn-primary').trigger('click')
    await flushPromises()
    expect(fixture.inspect).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[role="status"]').exists()).toBe(false)
    expect(wrapper.findAll('.wiz-check')).toHaveLength(2)
  })

  it('cancels onboarding without changing the active connection or provider config', async () => {
    const wrapper = mountWelcome()
    await flushPromises()
    await wrapper.get('.wiz-f .btn:not(.btn-primary)').trigger('click')
    await flushPromises()
    expect(fixture.replace).toHaveBeenCalledWith('/chat')
    expect(fixture.loadConfig).not.toHaveBeenCalled()
    expect(fixture.activate).not.toHaveBeenCalled()
    expect(fixture.saveConfig).not.toHaveBeenCalled()
  })

  it('does not expose a second check action while the first check is running', async () => {
    let resolveCheck!: (value: unknown) => void
    fixture.inspect.mockImplementationOnce(() => new Promise(resolve => { resolveCheck = resolve }))
    const wrapper = mountWelcome()
    await flushPromises()
    await wrapper.get('.wiz-f .btn-primary').trigger('click')
    await flushPromises()
    expect(wrapper.get<HTMLButtonElement>('.wiz-f .btn-primary').element.disabled).toBe(true)
    await wrapper.get('.wiz-f .btn-primary').trigger('click')
    expect(fixture.inspect).toHaveBeenCalledTimes(1)
    resolveCheck({ context: fixture.context, version: 'v0.5.0-beta', defaultModel: 'fixture-model' })
    await flushPromises()
  })

  it('does not start a second finish flow while configuration is still loading', async () => {
    let resolveLoad!: () => void
    fixture.loadConfig.mockImplementationOnce(() => new Promise<void>(resolve => { resolveLoad = resolve }))
    const wrapper = mountWelcome()
    await flushPromises()
    await wrapper.get('.wiz-f .btn-primary').trigger('click')
    await flushPromises()
    await wrapper.get('.wiz-f .btn-primary').trigger('click')
    await flushPromises()
    expect(wrapper.get<HTMLButtonElement>('.wiz-f .btn-primary').element.disabled).toBe(true)
    await wrapper.get('.wiz-f .btn-primary').trigger('click')
    expect(fixture.loadConfig).toHaveBeenCalledTimes(1)
    resolveLoad()
    await flushPromises()
    expect(fixture.replace).toHaveBeenCalledTimes(1)
  })

  it('keeps a fatal finish failure in the wizard without navigating', async () => {
    fixture.loadConfig.mockRejectedValueOnce(new Error('config unavailable'))
    const wrapper = mountWelcome()
    await flushPromises()
    await wrapper.get('.wiz-f .btn-primary').trigger('click')
    await flushPromises()
    await wrapper.get('.wiz-f .btn-primary').trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="status"]').text()).toContain('config unavailable')
    expect(wrapper.get<HTMLButtonElement>('.wiz-f .btn-primary').element.disabled).toBe(false)
    expect(fixture.replace).not.toHaveBeenCalled()
  })
})
