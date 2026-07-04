import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import WebhookPanel from '../WebhookPanel.vue'
import zhCN from '@/i18n/locales/zh-CN'

/**
 * Webhook「创建即得端点、默认未启用」：
 *  - 创建成功后弹窗进入结果态：端点 URL + 一次性 Secret + 未启用状态
 *  - 命中需授权能力时「授权并启用」= 任务级授权 + PATCH enabled
 *  - 「完成（保持未启用）」直接收尾
 *  - 列表行提供启停切换
 */

const webhookApis = vi.hoisted(() => ({
  getWebhooks: vi.fn(),
  createWebhook: vi.fn(),
  deleteWebhook: vi.fn(),
  updateWebhookEnabled: vi.fn(),
}))

const autonomyApis = vi.hoisted(() => ({
  preflightAutonomy: vi.fn(),
  createAutonomyGrant: vi.fn(),
  getAutonomySummary: vi.fn(),
  listAutonomyDecisions: vi.fn(),
}))

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))

vi.mock('@/api/webhook', () => ({
  ...webhookApis,
  webhookUrlFor: (name: string) => `http://localhost:16060/api/v1/webhooks/${name}`,
}))
vi.mock('@/api/autonomy', () => ({ ...autonomyApis }))
vi.mock('@/api/tasks', () => ({
  getCronJobs: vi.fn().mockResolvedValue({ jobs: [], total: 0 }),
  resumeCronJob: vi.fn(),
}))
vi.mock('@/composables/useToast', () => ({ useToast: () => toast }))
vi.mock('@/api/desktop', () => ({ setClipboard: vi.fn().mockResolvedValue(undefined) }))
vi.mock('lucide-vue-next', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const stub = { template: '<span />' }
  const mocked: Record<string, unknown> = {}
  for (const key of Object.keys(original)) mocked[key] = stub
  return mocked
})

function mountPanel() {
  return mount(WebhookPanel, {
    attachTo: document.body,
    global: {
      plugins: [
        createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages: { 'zh-CN': zhCN, zh: zhCN } }),
      ],
      stubs: { teleport: true, transition: false, HcSelect: { template: '<select />' } },
    },
  })
}

async function createViaForm(wrapper: ReturnType<typeof mountPanel>) {
  ;(wrapper.vm as unknown as { openCreateForm: () => void }).openCreateForm()
  await wrapper.vm.$nextTick()
  const form = (wrapper.vm as unknown as { form: { name: string; prompt: string } }).form
  form.name = 'issue-triage'
  form.prompt = '读取 Issue 并写标签'
  const createBtn = wrapper.findAll('button').find((b) => b.text().includes('创建'))
  await createBtn!.trigger('click')
  await flushPromises()
}

describe('WebhookPanel 待启用端点', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    webhookApis.getWebhooks.mockResolvedValue({ webhooks: [], total: 0 })
    webhookApis.createWebhook.mockResolvedValue({
      id: 'wh-1', name: 'issue-triage',
      url: '/api/v1/webhooks/issue-triage', enabled: false, secret: 'whs_generated',
    })
    webhookApis.updateWebhookEnabled.mockResolvedValue({ name: 'issue-triage', enabled: true })
    autonomyApis.getAutonomySummary.mockResolvedValue({
      profile: 'function_first', counts: { tasks: 0, ready: 0, pending: 0, grants: 0 }, pending: [], tasks: [],
    })
    autonomyApis.createAutonomyGrant.mockResolvedValue({ grant: { id: 'g-1' } })
  })

  it('创建成功进入结果态：端点 + 一次性 Secret + 默认未启用', async () => {
    autonomyApis.preflightAutonomy.mockResolvedValue({
      source: 'webhook', profile: 'function_first',
      capabilities: [], estimated: ['read'], needs_decision: [], all_clear: true,
    })
    const wrapper = mountPanel()
    await flushPromises()
    await createViaForm(wrapper)

    expect(webhookApis.createWebhook).toHaveBeenCalled()
    const result = wrapper.find('[data-testid="webhook-created-result"]')
    expect(result.exists()).toBe(true)
    expect(result.text()).toContain('issue-triage')
    expect(result.text()).toContain('whs_generated')
    expect(result.text()).toContain('未启用')
    // 全绿：显示可直接启用
    expect(result.text()).toContain('可直接启用')
  })

  it('命中需授权能力：「授权并启用」写任务级授权再 PATCH', async () => {
    autonomyApis.preflightAutonomy.mockResolvedValue({
      source: 'webhook', profile: 'function_first',
      capabilities: [],
      extra_tools: [{ tool: 'github.issues.write_label', state: 'approval' }],
      estimated: ['read'], needs_decision: ['github.issues.write_label'], all_clear: false,
    })
    const wrapper = mountPanel()
    await flushPromises()
    await createViaForm(wrapper)

    expect(autonomyApis.preflightAutonomy).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'webhook', task_ref: 'webhook:wh-1' }),
    )
    await wrapper.find('[data-testid="grant-and-enable"]').trigger('click')
    await flushPromises()

    expect(autonomyApis.createAutonomyGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        task_ref: 'webhook:wh-1', source: 'webhook',
        entries: ['github.issues.write_label'],
      }),
    )
    expect(webhookApis.updateWebhookEnabled).toHaveBeenCalledWith('issue-triage', true)
  })

  it('「完成（保持未启用）」不授权不启用', async () => {
    autonomyApis.preflightAutonomy.mockResolvedValue({
      source: 'webhook', profile: 'function_first',
      capabilities: [], estimated: [], needs_decision: ['publish'], all_clear: false,
    })
    const wrapper = mountPanel()
    await flushPromises()
    await createViaForm(wrapper)

    await wrapper.find('[data-testid="keep-disabled"]').trigger('click')
    await flushPromises()

    expect(autonomyApis.createAutonomyGrant).not.toHaveBeenCalled()
    expect(webhookApis.updateWebhookEnabled).not.toHaveBeenCalled()
    // 弹窗关闭（结果态清空）
    expect(wrapper.find('[data-testid="webhook-created-result"]').exists()).toBe(false)
  })

  it('列表行启停切换调用 PATCH', async () => {
    webhookApis.getWebhooks.mockResolvedValue({
      webhooks: [{
        id: 'wh-2', name: 'notify', type: 'generic', has_secret: true,
        prompt: '通知我', user_id: 'desktop-user', enabled: false, event_count: 0,
        created_at: '2026-07-01T00:00:00Z',
      }],
      total: 1,
    })
    const wrapper = mountPanel()
    await flushPromises()

    const toggle = wrapper.find('[data-testid="toggle-enabled"]')
    expect(toggle.exists()).toBe(true)
    expect(toggle.text()).toContain('启用')
    await toggle.trigger('click')
    await flushPromises()
    expect(webhookApis.updateWebhookEnabled).toHaveBeenCalledWith('notify', true)
  })
})
