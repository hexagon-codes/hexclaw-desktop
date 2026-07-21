import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import zhCN from '@/i18n/locales/zh-CN'
import WebhookPanel from '../WebhookPanel.vue'
import { registerK12Scenario, __resetK12Registration } from '@/features/k12/register'
import { scenarioRegistry } from '@/shell/scenario/registry'

const apis = vi.hoisted(() => ({
  getWebhooks: vi.fn(),
  getK12Webhooks: vi.fn(),
  getAgents: vi.fn(),
}))

vi.mock('@/api/webhook', () => ({
  getWebhooks: apis.getWebhooks,
  getK12Webhooks: apis.getK12Webhooks,
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
vi.mock('@/api/agents', () => ({ getAgents: apis.getAgents }))
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
    apis.getAgents.mockResolvedValue({
      agents: [
        {
          name: 'k12-tutor-a',
          display_name: '小明的辅导助手',
          metadata: {
            scenario: 'k12-tutor',
            'k12.child_name': '小明',
            'k12.learner_id': 'learner-a',
            'k12.grade_term': '五年级上',
          },
        },
      ],
      total: 1,
    })
    apis.getK12Webhooks.mockResolvedValue({
      k12_bindings: [
        {
          binding_id: 'binding-a',
          name: 'homework-hook',
          agent_id: 'k12-tutor-a',
          learner_id: 'learner-a',
          scope: 'direct',
          allowed_events: ['k12.submission.requested.v1'],
          has_secret: true,
          secret_version: 1,
          status: 'enabled',
        },
      ],
      total: 1,
    })
  })

  it('renders the owner-scoped K12 card directly in the Webhook list without an extra disclosure', async () => {
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

    await vi.dynamicImportSettled()
    await flushPromises()

    expect(wrapper.find('[data-testid="scenario-webhook-manager-toggle-k12-tutor"]').exists()).toBe(
      false,
    )
    const panel = wrapper.get('[data-testid="k12-webhook-panel"]')
    expect(panel.text()).toContain('K12 批改与回传事件')
    expect(panel.find('[data-testid="k12-webhook-row-homework-hook"]').exists()).toBe(true)
    expect(wrapper.find('.webhook-panel__empty').exists()).toBe(false)
  })
})
