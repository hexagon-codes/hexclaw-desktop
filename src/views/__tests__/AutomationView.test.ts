import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter } from 'vue-router'
import { defineComponent } from 'vue'
import AutomationView from '../AutomationView.vue'
import zhCN from '@/i18n/locales/zh-CN'

const canvasStore = vi.hoisted(() => ({
  loadWorkflows: vi.fn(),
  loadWorkflowToCanvas: vi.fn(),
}))

const tasksViewApi = vi.hoisted(() => ({
  openCreateForm: vi.fn(),
  loadJobs: vi.fn(),
}))

const webhookPanelApi = vi.hoisted(() => ({
  loadWebhooks: vi.fn(),
}))

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}))

vi.mock('@/stores/canvas', () => ({
  useCanvasStore: () => canvasStore,
}))

vi.mock('@/composables/useToast', () => ({
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

async function mountAutomationView(initialPath = '/automation') {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/automation', component: AutomationView },
      { path: '/automation/canvas', component: AutomationView },
      { path: '/automation/webhooks', component: AutomationView },
    ],
  })
  await router.push(initialPath)
  await router.isReady()

  const wrapper = mount(AutomationView, {
    global: {
      plugins: [createTestI18n(), router],
      stubs: {
        PageToolbar: { template: '<div><slot name="tabs" /><slot name="actions" /></div>' },
        PageHeader: { template: '<div>header</div>' },
        SegmentedControl: {
          props: ['segments'],
          template: '<div class="segmented-stub"><span v-for="segment in segments" :key="segment.key" class="segmented-item">{{ segment.label }}</span></div>',
        },
        TasksView: defineComponent({
          setup(_, { expose }) {
            expose(tasksViewApi)
            return {}
          },
          template: '<div data-testid="tasks-view">tasks-view</div>',
        }),
        CanvasView: { template: '<div data-testid="canvas-view">canvas-view</div>' },
        WebhookPanel: defineComponent({
          setup(_, { expose }) {
            expose(webhookPanelApi)
            return {}
          },
          template: '<div data-testid="webhook-panel">webhook-panel</div>',
        }),
      },
    },
  })

  return { wrapper, router }
}

describe('AutomationView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('keeps the webhooks tab active when the route changes to /automation/webhooks', async () => {
    const { wrapper, router } = await mountAutomationView('/automation')
    await router.push('/automation/webhooks')
    await flushPromises()

    expect(router.currentRoute.value.path).toBe('/automation/webhooks')
    expect(wrapper.find('[data-testid="webhook-panel"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="tasks-view"]').exists()).toBe(false)
  })

  it('renders the automation tab segments from navigation config', async () => {
    const { wrapper } = await mountAutomationView('/automation')
    await flushPromises()

    const labels = wrapper.findAll('.segmented-item').map((node) => node.text())
    expect(labels).toContain('定时任务')
    expect(labels).toContain('工作流画布')
    expect(labels).toHaveLength(2)
  })

  it('refreshes webhooks instead of canvas workflows when the webhooks tab is active', async () => {
    const { wrapper } = await mountAutomationView('/automation/webhooks')
    await flushPromises()

    const refreshBtn = wrapper.findAll('button').find((btn) => btn.attributes('title') === '刷新')
    expect(refreshBtn).toBeDefined()
    await refreshBtn!.trigger('click')
    await flushPromises()

    expect(webhookPanelApi.loadWebhooks).toHaveBeenCalledTimes(1)
    expect(canvasStore.loadWorkflows).not.toHaveBeenCalled()
    expect(tasksViewApi.loadJobs).not.toHaveBeenCalled()
  })
})
