/** Webhook 未启用由能力状态判定，列表读取失败保留真实错误。 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { createPinia } from 'pinia'
import zhCN from '@/i18n/locales/zh-CN'

const { getWebhooks, createWebhook, deleteWebhook, getAutomationStatus } = vi.hoisted(() => ({
  getWebhooks: vi.fn(),
  createWebhook: vi.fn(),
  deleteWebhook: vi.fn(),
  getAutomationStatus: vi.fn(),
}))

vi.mock('@/api/automation', () => ({ getAutomationStatus }))

vi.mock('@/api/webhook', () => ({
  getWebhooks,
  createWebhook,
  deleteWebhook,
  updateWebhookEnabled: vi.fn().mockResolvedValue({ name: 'x', enabled: true }),
  webhookUrlFor: (name: string) => `http://localhost:16060/api/v1/webhooks/${name}`,
}))
// 自动化权限治理 API：组件挂载即静默预检/总览，测试里一律 mock 成全绿空态。
vi.mock('@/api/autonomy', () => ({
  preflightAutonomy: vi.fn().mockResolvedValue({
    source: 'webhook', profile: 'function_first',
    capabilities: [], estimated: [], needs_decision: [], all_clear: true,
  }),
  createAutonomyGrant: vi.fn().mockResolvedValue({ grant: { id: 'g-1' } }),
  getAutonomySummary: vi.fn().mockResolvedValue({
    profile: 'function_first',
    counts: { tasks: 0, ready: 0, pending: 0, grants: 0 },
    pending: [], tasks: [],
  }),
  listAutonomyDecisions: vi.fn().mockResolvedValue({ decisions: [], total: 0 }),
  listAutonomyGrants: vi.fn().mockResolvedValue({ grants: [], total: 0 }),
  revokeAutonomyGrant: vi.fn().mockResolvedValue({ message: 'ok' }),
  getAutonomyProfile: vi.fn().mockResolvedValue({
    profile: 'function_first', profiles: [],
    matrix: { profile: 'function_first', categories: [], rows: [] },
  }),
  updateAutonomyProfile: vi.fn(),
}))


vi.mock('lucide-vue-next', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const stub = { template: '<span />' }
  const mocked: Record<string, unknown> = {}
  for (const key of Object.keys(original)) mocked[key] = stub
  return mocked
})

async function mountPanel() {
  const WebhookPanel = (await import('../../automation/WebhookPanel.vue')).default
  return mount(WebhookPanel, {
    global: {
      plugins: [
        createPinia(),
        createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages: { 'zh-CN': zhCN } }),
      ],
    },
  })
}

describe('webhook 后端未启用时渲染引导，读取失败时保留错误', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getAutomationStatus.mockResolvedValue({
      cron: { enabled: true, state: 'ready' },
      webhook: { enabled: false, state: 'disabled' },
    })
  })

  it('disabled 时显示"未启用"引导文案，不显示原始请求错误', async () => {
    const wrapper = await mountPanel()
    await flushPromises()

    expect(wrapper.text()).toContain('Webhook reception is not enabled')
    expect(wrapper.text()).not.toContain('404 Not Found')
    expect(wrapper.find('.webhook-panel__error').exists()).toBe(false)
    expect(getWebhooks).not.toHaveBeenCalled()
  })

  it('disabled 时创建入口不可用', async () => {
    const wrapper = await mountPanel()
    await flushPromises()

    expect(wrapper.text()).not.toContain('添加 Webhook')
    expect((wrapper.vm as unknown as { canCreate: boolean }).canCreate).toBe(false)
  })

  it('非 404 错误（如 500）仍走错误展示', async () => {
    getAutomationStatus.mockResolvedValue({
      cron: { enabled: true, state: 'ready' },
      webhook: { enabled: true, state: 'ready' },
    })
    const err = new Error('服务器内部错误') as Error & { status: number }
    err.status = 500
    getWebhooks.mockRejectedValue(err)

    const wrapper = await mountPanel()
    await flushPromises()

    expect(wrapper.find('.webhook-panel__error').exists()).toBe(true)
    expect(wrapper.text()).toContain('服务器内部错误')
  })
})
