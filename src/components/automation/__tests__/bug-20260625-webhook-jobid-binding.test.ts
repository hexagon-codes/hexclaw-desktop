/**
 * BUG-20260625 F-3：webhook「绑定 cron job」前端无入口 → jobId 恒空、特性不可达。
 *
 * 后端链路全通（webhook.go Webhook.JobID + main.go：event.JobID!="" → scheduler.TriggerJob），
 * createWebhook API 也声明了 jobId（→ job_id），但 WebhookPanel 表单只有 {name,type,prompt,secret}，
 * 从不录入/透传 jobId → §13.3(1)「事件触发指定 cron job 而非跑 prompt」对桌面用户不可达。
 *
 * 修复：表单加「绑定任务(可选)」下拉（取 getCronJobs），jobId 随 createWebhook 透传。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import WebhookPanel from '../WebhookPanel.vue'

function createTestI18n() {
  return createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages: { 'zh-CN': zhCN, zh: zhCN } })
}
function mountPanel() {
  return mount(WebhookPanel, {
    attachTo: document.body,
    global: { plugins: [createTestI18n()], stubs: { teleport: true } },
  })
}

const getWebhooks = vi.hoisted(() => vi.fn())
const createWebhook = vi.hoisted(() => vi.fn())
const deleteWebhook = vi.hoisted(() => vi.fn())
const getCronJobs = vi.hoisted(() => vi.fn())
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))

vi.mock('@/api/webhook', () => ({
  getWebhooks, createWebhook, deleteWebhook,
  webhookUrlFor: (name: string) => `http://localhost:16060/api/v1/webhooks/${name}`,
}))
vi.mock('@/api/tasks', () => ({ getCronJobs }))
vi.mock('@/composables/useToast', () => ({ useToast: () => toast }))
vi.mock('lucide-vue-next', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const stub = { template: '<span />' }
  const mocked: Record<string, unknown> = {}
  for (const key of Object.keys(original)) mocked[key] = stub
  return mocked
})

describe('BUG-20260625 F-3 webhook 绑定 cron job 入口', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getWebhooks.mockResolvedValue({ webhooks: [] })
    getCronJobs.mockResolvedValue({ jobs: [{ id: 'job-1', name: '每日晨报', schedule: '', prompt: '', user_id: '', enabled: true }], total: 1 })
    createWebhook.mockResolvedValue({})
  })

  it('★表单有「绑定任务」下拉，jobId 随 createWebhook 透传（修复前恒空不可达）', async () => {
    const wrapper = mountPanel()
    await flushPromises()
    ;(wrapper.vm as unknown as { openCreateForm: () => void }).openCreateForm()
    await flushPromises()

    // 绑定任务下拉应存在（修复前缺失 → RED）
    expect(
      wrapper.find('[data-testid="webhook-job-select"]').exists(),
      'webhook 表单缺「绑定 cron job」入口 → jobId 恒空、特性不可达',
    ).toBe(true)

    // 绑定 job-1（经暴露的 form 驱动），填 name，提交（绑定 job 时 prompt 可空、且已隐藏）
    await wrapper.find('input[placeholder="my-webhook"]').setValue('hook-bind')
    ;(wrapper.vm as unknown as { form: { jobId: string } }).form.jobId = 'job-1'
    await flushPromises()
    const createBtn = wrapper.findAll('.webhook-modal__actions button')[1]!
    await createBtn.trigger('click')
    await flushPromises()

    expect(createWebhook).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'job-1' }))
  })
})
