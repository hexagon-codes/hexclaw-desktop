/**
 * KnowledgeCenterView toolbar refresh (UX issue: background agent/cron jobs
 * write KB docs and memory entries, but both tabs only loaded on mount).
 * The toolbar refresh button must re-run the active tab's load function and
 * show a brief loading state.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter } from 'vue-router'
import { defineComponent } from 'vue'
import KnowledgeCenterView from '../KnowledgeCenterView.vue'
import zhCN from '@/i18n/locales/zh-CN'

const knowledgeViewApi = vi.hoisted(() => ({
  loadDocs: vi.fn(),
  openUpload: vi.fn(),
}))

const memoryViewApi = vi.hoisted(() => ({
  refreshMemoryList: vi.fn(),
  openAddDialog: vi.fn(),
  setToolbarSearch: vi.fn(),
  submitToolbarSearch: vi.fn(),
  requestClearAll: vi.fn(),
}))

vi.mock('@/views/KnowledgeView.vue', () => ({
  default: defineComponent({
    name: 'KnowledgeViewStub',
    setup(_, { expose }) {
      expose(knowledgeViewApi)
      return {}
    },
    template: '<div data-testid="knowledge-view-stub" />',
  }),
}))

vi.mock('@/views/MemoryView.vue', () => ({
  default: defineComponent({
    name: 'MemoryViewStub',
    setup(_, { expose }) {
      expose(memoryViewApi)
      return {}
    },
    template: '<div data-testid="memory-view-stub" />',
  }),
}))

vi.mock('@/api/settings', () => ({
  getRuntimeConfig: vi.fn().mockResolvedValue({ knowledge: { enabled: true } }),
}))

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
}))

vi.mock('@/composables', () => ({
  useToast: () => toast,
}))

vi.mock('lucide-vue-next', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const stub = { template: '<span />' }
  const mocked: Record<string, unknown> = {}
  for (const key of Object.keys(original)) mocked[key] = stub
  return mocked
})

function createTestI18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': zhCN, zh: zhCN },
  })
}

async function mountView(initialPath = '/knowledge') {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/knowledge', component: KnowledgeCenterView },
      { path: '/knowledge/memory', component: KnowledgeCenterView },
    ],
  })
  await router.push(initialPath)
  await router.isReady()

  return mount(KnowledgeCenterView, {
    global: {
      plugins: [createTestI18n(), router],
      stubs: {
        PageToolbar: { template: '<div class="hc-toolbar"><slot name="tabs" /><slot name="actions" /></div>' },
        PageHeader: { template: '<div>header</div>' },
        SegmentedControl: { props: ['segments'], template: '<div />' },
      },
    },
  })
}

describe('KnowledgeCenterView refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    knowledgeViewApi.loadDocs.mockResolvedValue(undefined)
    memoryViewApi.refreshMemoryList.mockResolvedValue(undefined)
  })

  it('refreshes the docs list when the docs tab is active', async () => {
    const wrapper = await mountView('/knowledge')
    await flushPromises()

    const refreshBtn = wrapper.find('[data-testid="knowledge-refresh"]')
    expect(refreshBtn.exists()).toBe(true)
    await refreshBtn.trigger('click')
    await flushPromises()

    expect(knowledgeViewApi.loadDocs).toHaveBeenCalledTimes(1)
    expect(memoryViewApi.refreshMemoryList).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('refreshes the memory list when the memory tab is active', async () => {
    const wrapper = await mountView('/knowledge/memory')
    await flushPromises()

    await wrapper.find('[data-testid="knowledge-refresh"]').trigger('click')
    await flushPromises()

    expect(memoryViewApi.refreshMemoryList).toHaveBeenCalledTimes(1)
    expect(knowledgeViewApi.loadDocs).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('disables the button and spins the icon while refreshing', async () => {
    let resolveLoad!: () => void
    knowledgeViewApi.loadDocs.mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveLoad = resolve }),
    )

    const wrapper = await mountView('/knowledge')
    await flushPromises()

    const refreshBtn = wrapper.find('[data-testid="knowledge-refresh"]')
    await refreshBtn.trigger('click')
    await wrapper.vm.$nextTick()

    expect(refreshBtn.attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-testid="knowledge-refresh"] .animate-spin').exists()).toBe(true)

    // A second click while loading must not start another request
    await refreshBtn.trigger('click')
    expect(knowledgeViewApi.loadDocs).toHaveBeenCalledTimes(1)

    resolveLoad()
    await flushPromises()
    expect(refreshBtn.attributes('disabled')).toBeUndefined()
    expect(wrapper.find('[data-testid="knowledge-refresh"] .animate-spin').exists()).toBe(false)
    wrapper.unmount()
  })

  // M3: a rejected refresh must surface a toast and still clear the spinner,
  // instead of swallowing the rejection silently.
  it('surfaces a toast and clears the spinner when refresh rejects', async () => {
    knowledgeViewApi.loadDocs.mockRejectedValueOnce(new Error('network down'))

    const wrapper = await mountView('/knowledge')
    await flushPromises()

    const refreshBtn = wrapper.find('[data-testid="knowledge-refresh"]')
    await refreshBtn.trigger('click')
    await flushPromises()

    expect(toast.error).toHaveBeenCalledWith('network down')
    // Spinner cleared / button re-enabled even though the load failed.
    expect(refreshBtn.attributes('disabled')).toBeUndefined()
    expect(wrapper.find('[data-testid="knowledge-refresh"] .animate-spin').exists()).toBe(false)
    wrapper.unmount()
  })
})
