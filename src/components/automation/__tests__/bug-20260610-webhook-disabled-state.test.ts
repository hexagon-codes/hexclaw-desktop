/**
 * BUG-20260610 回归测试：后端 webhook.enabled=false 时 /api/v1/webhooks
 * 路由不注册返回 404，WebhookPanel 把 404 当普通错误红字裸显请求 URL，
 * 用户无从知道是功能未启用。
 *
 * 期望：404 渲染"功能未启用"引导（含启用方式），而非错误样式；
 * 其他错误（如 500）仍走错误样式。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'

const { getWebhooks, createWebhook, deleteWebhook } = vi.hoisted(() => ({
  getWebhooks: vi.fn(),
  createWebhook: vi.fn(),
  deleteWebhook: vi.fn(),
}))

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

function notFoundError() {
  const err = new Error('[GET] "http://localhost:16060/api/v1/webhooks?user_id=desktop-user": 404 Not Found') as Error & {
    code: string
    status: number
  }
  err.code = 'NOT_FOUND'
  err.status = 404
  return err
}

async function mountPanel() {
  const WebhookPanel = (await import('../../automation/WebhookPanel.vue')).default
  return mount(WebhookPanel, {
    global: {
      plugins: [
        createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages: { 'zh-CN': zhCN } }),
      ],
    },
  })
}

describe('BUG-20260610: webhook 后端未启用（404）应渲染引导而非报错', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('404 时显示"未启用"引导文案，不显示原始 404 错误', async () => {
    getWebhooks.mockRejectedValue(notFoundError())

    const wrapper = await mountPanel()
    await flushPromises()

    expect(wrapper.text()).toContain('未启用')
    expect(wrapper.text()).toContain('webhook.enabled')
    expect(wrapper.text()).not.toContain('404 Not Found')
    expect(wrapper.find('.webhook-panel__error').exists()).toBe(false)
  })

  it('404 时隐藏 Add Webhook 按钮（功能不可用时不提供入口）', async () => {
    getWebhooks.mockRejectedValue(notFoundError())

    const wrapper = await mountPanel()
    await flushPromises()

    expect(wrapper.text()).not.toContain('添加 Webhook')
  })

  it('非 404 错误（如 500）仍走错误展示', async () => {
    const err = new Error('服务器内部错误') as Error & { status: number }
    err.status = 500
    getWebhooks.mockRejectedValue(err)

    const wrapper = await mountPanel()
    await flushPromises()

    expect(wrapper.find('.webhook-panel__error').exists()).toBe(true)
    expect(wrapper.text()).toContain('服务器内部错误')
  })
})
