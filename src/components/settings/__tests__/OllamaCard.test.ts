import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import OllamaCard from '../OllamaCard.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import ToastProvider from '@/components/common/ToastProvider.vue'
import { DESTRUCTIVE_CONFIRM_COOLDOWN_MS } from '@/config/destructive-actions'
import zhCN from '@/i18n/locales/zh-CN'

const getOllamaStatus = vi.hoisted(() => vi.fn())
const getOllamaRunning = vi.hoisted(() => vi.fn())
const getOllamaRunningResult = vi.hoisted(() => vi.fn())
const deleteOllamaModel = vi.hoisted(() => vi.fn())
const syncOllamaModels = vi.hoisted(() => vi.fn())
const settingsStore = {
  config: { llm: { providers: [{ id: 'openai-1', type: 'openai', enabled: true }] } },
  syncOllamaModels,
}

vi.mock('@/api/ollama', () => ({
  getOllamaStatus,
  getOllamaRunning,
  getOllamaRunningResult,
  pullOllamaModel: vi.fn(),
  unloadOllamaModel: vi.fn(),
  deleteOllamaModel,
  restartOllama: vi.fn(),
}))

vi.mock('@/stores/settings', () => ({
  useSettingsStore: () => settingsStore,
}))

vi.mock('vue-router', () => ({
  useRouter: vi.fn().mockReturnValue({ push: vi.fn() }),
}))

vi.mock('lucide-vue-next', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const stub = { template: '<span />' }
  const mocked: Record<string, unknown> = {}
  for (const key of Object.keys(original)) mocked[key] = stub
  return mocked
})

function createI18nInstance() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': zhCN },
  })
}

const deleteModels = ['qwen3.5:9b', 'nomic-embed-text'] as const
const mountedWrappers: Array<{ unmount: () => void }> = []
let originalHcToast: unknown

async function mountDeleteFixture() {
  vi.useFakeTimers()
  getOllamaStatus.mockResolvedValue({
    running: true,
    associated: true,
    models: deleteModels.map(name => ({ name, size: 1 })),
  })

  const toastWrapper = mount(ToastProvider)
  ;(window as unknown as Record<string, unknown>).__hcToast = { value: toastWrapper.vm }
  const wrapper = mount(OllamaCard, {
    global: { plugins: [createI18nInstance()] },
  })
  mountedWrappers.push(wrapper, toastWrapper)
  await flushPromises()
  return wrapper
}

function deleteButtonFor(
  wrapper: Awaited<ReturnType<typeof mountDeleteFixture>>,
  model: string,
) {
  const button = wrapper
    .findAll('button.ollama-card__model-btn--danger')
    .find(candidate => candidate.attributes('title')?.includes(model))
  expect(button, `应渲染 ${model} 的删除入口`).toBeDefined()
  return button!
}

async function requestDelete(
  wrapper: Awaited<ReturnType<typeof mountDeleteFixture>>,
  model: string,
) {
  await deleteButtonFor(wrapper, model).trigger('click')
  await flushPromises()
}

function confirmButton() {
  const button = document.body.querySelector<HTMLButtonElement>('.hc-dialog__btn--danger')
  expect(button, '共享 ConfirmDialog 应渲染最终确认按钮').not.toBeNull()
  return button!
}

describe('OllamaCard integration', () => {
  beforeEach(() => {
    originalHcToast = (window as unknown as Record<string, unknown>).__hcToast
    vi.clearAllMocks()
    getOllamaStatus.mockResolvedValue({ running: true, associated: true, models: [] })
    getOllamaRunning.mockResolvedValue([])
    getOllamaRunningResult.mockResolvedValue({ models: [], reachable: true })
    deleteOllamaModel.mockResolvedValue(undefined)
    settingsStore.config.llm.providers = [{ id: 'openai-1', type: 'openai', enabled: true }]
  })

  afterEach(() => {
    for (const wrapper of mountedWrappers.splice(0).reverse()) wrapper.unmount()
    if (originalHcToast === undefined) {
      delete (window as unknown as Record<string, unknown>).__hcToast
    } else {
      ;(window as unknown as Record<string, unknown>).__hcToast = originalHcToast
    }
    vi.useRealTimers()
  })

  it('emits associate and syncs models when Ollama is running without a provider', async () => {
    // Ensure there is no ollama provider so auto-associate fires
    settingsStore.config.llm.providers = []

    const wrapper = mount(OllamaCard, {
      global: { plugins: [createI18nInstance()] },
    })

    await flushPromises()

    expect(wrapper.emitted('associate')).toBeDefined()
    expect(syncOllamaModels).toHaveBeenCalledTimes(1)
    expect(getOllamaRunningResult).toHaveBeenCalled()
  })

  it('shows associated state when status reports running and a provider exists', async () => {
    const wrapper = mount(OllamaCard, {
      global: { plugins: [createI18nInstance()] },
    })

    await flushPromises()
    // No enabled Ollama provider in the mock store, so stateLabel shows '已禁用'
    expect(wrapper.text()).toContain('已禁用')
  })

  it('[bug] shows daemon-unreachable as unknown instead of claiming every model is idle', async () => {
    getOllamaStatus.mockResolvedValue({
      running: true,
      associated: true,
      models: [{ name: 'qwen3.5:9b', size: 1 }],
    })
    getOllamaRunningResult.mockResolvedValue({
      models: [],
      reachable: false,
      error: 'connection refused',
    })

    const wrapper = mount(OllamaCard, { global: { plugins: [createI18nInstance()] } })
    await flushPromises()

    expect(wrapper.find('[data-testid="ollama-running-unreachable"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="ollama-running-empty"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="ollama-model-running-unknown"]').exists()).toBe(true)
  })

  it('shows an explicit empty-running state only when /api/ps is reachable', async () => {
    getOllamaStatus.mockResolvedValue({
      running: true,
      associated: true,
      models: [{ name: 'qwen3.5:9b', size: 1 }],
    })
    getOllamaRunningResult.mockResolvedValue({ models: [], reachable: true })

    const wrapper = mount(OllamaCard, { global: { plugins: [createI18nInstance()] } })
    await flushPromises()

    expect(wrapper.find('[data-testid="ollama-running-empty"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="ollama-running-unreachable"]').exists()).toBe(false)
  })

  it.each(deleteModels)(
    'registers %s as the shared confirmation target and deletes only after 1500ms',
    async (model) => {
      const wrapper = await mountDeleteFixture()

      await requestDelete(wrapper, model)

      const dialog = wrapper.findComponent(ConfirmDialog)
      expect(dialog.props('open')).toBe(true)
      expect(dialog.props('confirmationKey')).toBe(`ollama:${model}:0`)
      expect(dialog.props('message')).toContain(model)
      expect(dialog.props('confirmDelayMs')).toBe(DESTRUCTIVE_CONFIRM_COOLDOWN_MS)
      expect(deleteOllamaModel).not.toHaveBeenCalled()

      const button = confirmButton()
      expect(button.disabled).toBe(true)
      button.click()
      expect(deleteOllamaModel).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(DESTRUCTIVE_CONFIRM_COOLDOWN_MS - 1)
      expect(button.disabled).toBe(true)
      button.click()
      expect(deleteOllamaModel).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1)
      expect(button.disabled).toBe(false)
      button.click()
      await flushPromises()

      expect(deleteOllamaModel).toHaveBeenCalledTimes(1)
      expect(deleteOllamaModel).toHaveBeenCalledWith(model)
      expect(wrapper.findComponent(ConfirmDialog).props('open')).toBe(false)
    },
  )

  it('cancels or closes the shared dialog without deleting', async () => {
    const wrapper = await mountDeleteFixture()

    await requestDelete(wrapper, deleteModels[0])
    const cancel = document.body.querySelector<HTMLButtonElement>('.hc-dialog .hc-btn-secondary')
    expect(cancel).not.toBeNull()
    cancel!.click()
    await flushPromises()
    await vi.advanceTimersByTimeAsync(DESTRUCTIVE_CONFIRM_COOLDOWN_MS)
    expect(deleteOllamaModel).not.toHaveBeenCalled()
    expect(wrapper.findComponent(ConfirmDialog).props('open')).toBe(false)

    await requestDelete(wrapper, deleteModels[1])
    const overlay = document.body.querySelector<HTMLElement>('.hc-dialog-overlay')
    expect(overlay).not.toBeNull()
    overlay!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    await vi.advanceTimersByTimeAsync(DESTRUCTIVE_CONFIRM_COOLDOWN_MS)
    expect(deleteOllamaModel).not.toHaveBeenCalled()
    expect(wrapper.findComponent(ConfirmDialog).props('open')).toBe(false)
  })

  it('switches the pending target without deleting or inheriting the old cooldown', async () => {
    const wrapper = await mountDeleteFixture()

    await requestDelete(wrapper, deleteModels[0])
    await vi.advanceTimersByTimeAsync(DESTRUCTIVE_CONFIRM_COOLDOWN_MS - 1)
    await requestDelete(wrapper, deleteModels[1])

    const dialog = wrapper.findComponent(ConfirmDialog)
    expect(dialog.props('confirmationKey')).toBe(`ollama:${deleteModels[1]}:0`)
    expect(dialog.props('message')).toContain(deleteModels[1])
    expect(deleteOllamaModel).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(confirmButton().disabled).toBe(true)
    confirmButton().click()
    expect(deleteOllamaModel).not.toHaveBeenCalled()
  })

  it.each([
    ['4xx', new Error('HTTP 404')],
    ['5xx', new Error('HTTP 503')],
  ])('shows a shared Toast for fake Ollama %s and recovers on retry', async (_kind, failure) => {
    deleteOllamaModel.mockRejectedValueOnce(failure).mockResolvedValueOnce(undefined)
    const wrapper = await mountDeleteFixture()
    const model = deleteModels[0]

    await requestDelete(wrapper, model)
    await vi.advanceTimersByTimeAsync(DESTRUCTIVE_CONFIRM_COOLDOWN_MS)
    confirmButton().click()
    await flushPromises()

    const toastMessage = document.body.querySelector<HTMLElement>('.hc-toast__msg')
    expect(toastMessage?.textContent).toContain('删除失败')
    expect(deleteOllamaModel).toHaveBeenCalledTimes(1)
    expect(wrapper.findComponent(ConfirmDialog).props('open')).toBe(true)
    expect(wrapper.findComponent(ConfirmDialog).props('confirmationKey')).toBe(`ollama:${model}:1`)

    await vi.advanceTimersByTimeAsync(DESTRUCTIVE_CONFIRM_COOLDOWN_MS)
    expect(confirmButton().disabled).toBe(false)
    confirmButton().click()
    await flushPromises()

    expect(deleteOllamaModel).toHaveBeenCalledTimes(2)
    expect(deleteOllamaModel).toHaveBeenNthCalledWith(1, model)
    expect(deleteOllamaModel).toHaveBeenNthCalledWith(2, model)
    expect(wrapper.findComponent(ConfirmDialog).props('open')).toBe(false)
  })
})
