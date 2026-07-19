import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import zhCN from '@/i18n/locales/zh-CN'
import WebhookPanel from '../WebhookPanel.vue'
import { registerK12Scenario, __resetK12Registration } from '@/features/k12/register'
import { scenarioRegistry } from '@/shell/scenario/registry'

const apis = vi.hoisted(() => ({
  getWebhooks: vi.fn(),
}))

vi.mock('@/api/webhook', () => ({
  getWebhooks: apis.getWebhooks,
  getK12Webhooks: vi.fn().mockResolvedValue({ k12_bindings: [], total: 0 }),
  getK12WebhookReceipts: vi.fn().mockResolvedValue({ receipts: [], total: 0 }),
  createK12Webhook: vi.fn(),
  updateK12Webhook: vi.fn(),
  rotateK12WebhookSecret: vi.fn(),
  deleteK12Webhook: vi.fn(),
  createWebhook: vi.fn(),
  deleteWebhook: vi.fn(),
  updateWebhookEnabled: vi.fn(),
  webhookUrlFor: (name: string) => `http://localhost:16060/api/v1/webhooks/${name}`,
}))
vi.mock('@/api/agents', () => ({ getAgents: vi.fn().mockResolvedValue({ agents: [], total: 0 }) }))
vi.mock('@/api/tasks', () => ({ getCronJobs: vi.fn().mockResolvedValue({ jobs: [] }) }))
vi.mock('@/api/autonomy', () => ({
  preflightAutonomy: vi.fn(),
  createAutonomyGrant: vi.fn(),
  getAutonomySummary: vi.fn().mockResolvedValue({ tasks: [] }),
}))
vi.mock('@/api/desktop', () => ({ setClipboard: vi.fn() }))
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}))
vi.mock('lucide-vue-next', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return Object.fromEntries(Object.keys(original).map((key) => [key, { template: '<span />' }]))
})

describe('WebhookPanel K12 management entry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    scenarioRegistry.reset()
    __resetK12Registration()
    registerK12Scenario()
    apis.getWebhooks.mockResolvedValue({ webhooks: [], total: 0 })
  })

  it('opens the owner-scoped K12 manager from the Automation Webhooks page', async () => {
    const wrapper = mount(WebhookPanel, {
      global: {
        plugins: [
          createI18n({
            legacy: false,
            locale: 'zh-CN',
            messages: { 'zh-CN': zhCN },
          }),
        ],
        stubs: { teleport: true },
      },
    })
    await flushPromises()

    const entry = wrapper.get('[data-testid="scenario-webhook-manager-toggle-k12-tutor"]')
    expect(entry.text()).toContain('K12')
    expect(wrapper.find('[data-testid="k12-webhook-panel"]').exists()).toBe(false)

    await entry.trigger('click')
    await vi.dynamicImportSettled()
    await flushPromises()

    expect(wrapper.get('[data-testid="k12-webhook-panel"]').text()).toContain('K12 Webhook')
  })
})
