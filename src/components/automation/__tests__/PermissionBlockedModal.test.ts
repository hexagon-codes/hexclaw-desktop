import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import PermissionBlockedModal from '../PermissionBlockedModal.vue'
import zhCN from '@/i18n/locales/zh-CN'
import type { AutonomyTaskStatus } from '@/api/autonomy'

/**
 * 阻断处理弹窗（任务卡「去开启」）：
 *  - 待授权条目 = 预检需决定项 ∪ 决策日志被拦工具
 *  - 「仅授权本任务并启用」：grant → cron 暂停任务 resume / webhook enable
 */

const autonomyApis = vi.hoisted(() => ({
  listAutonomyDecisions: vi.fn(),
  createAutonomyGrant: vi.fn(),
}))
const taskApis = vi.hoisted(() => ({ resumeCronJob: vi.fn() }))
const webhookApis = vi.hoisted(() => ({ updateWebhookEnabled: vi.fn() }))
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))

vi.mock('@/api/autonomy', () => ({ ...autonomyApis }))
vi.mock('@/api/tasks', () => ({ resumeCronJob: taskApis.resumeCronJob }))
vi.mock('@/api/webhook', () => ({ updateWebhookEnabled: webhookApis.updateWebhookEnabled }))
vi.mock('@/composables/useToast', () => ({ useToast: () => toast }))
vi.mock('lucide-vue-next', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const stub = { template: '<span />' }
  const mocked: Record<string, unknown> = {}
  for (const key of Object.keys(original)) mocked[key] = stub
  return mocked
})

function mountModal(task: AutonomyTaskStatus) {
  return mount(PermissionBlockedModal, {
    attachTo: document.body,
    props: { open: true, task },
    global: {
      plugins: [
        createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages: { 'zh-CN': zhCN, zh: zhCN } }),
      ],
      stubs: { teleport: true, transition: false },
    },
  })
}

const CRON_TASK: AutonomyTaskStatus = {
  task_ref: 'cron:job-1', kind: 'cron', name: '写标签任务',
  enabled: false, status: 'paused', needs_decision: ['publish'], all_clear: false,
}

describe('PermissionBlockedModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    autonomyApis.listAutonomyDecisions.mockResolvedValue({
      decisions: [{
        id: 'd-1', at: '2026-07-02T19:08:41+08:00', source: 'cron', task_ref: 'cron:job-1',
        tool: 'github.issues.write_label', profile: 'function_first',
        decision: 'pending', via: 'matrix',
      }],
      total: 1,
    })
    autonomyApis.createAutonomyGrant.mockResolvedValue({ grant: { id: 'g-1' } })
    taskApis.resumeCronJob.mockResolvedValue({ message: 'ok' })
    webhookApis.updateWebhookEnabled.mockResolvedValue({ name: 'hook', enabled: true })
  })

  it('待授权条目合并预检需决定项与决策日志被拦工具', async () => {
    const wrapper = mountModal(CRON_TASK)
    await flushPromises()

    const entries = wrapper.findAll('[data-testid="blocked-entry"]').map((e) => e.text())
    expect(entries).toContain('发布内容') // 类别本地化
    expect(entries).toContain('github.issues.write_label') // 具体工具原样
    expect(wrapper.find('[data-testid="decision-row"]').text()).toContain('github.issues.write_label')
  })

  it('cron 暂停任务：授权后 resume 启用并 emit resolved', async () => {
    const wrapper = mountModal(CRON_TASK)
    await flushPromises()

    await wrapper.find('[data-testid="grant-and-enable"]').trigger('click')
    await flushPromises()

    expect(autonomyApis.createAutonomyGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        task_ref: 'cron:job-1',
        source: 'cron',
        entries: expect.arrayContaining(['publish', 'github.issues.write_label']),
      }),
    )
    expect(taskApis.resumeCronJob).toHaveBeenCalledWith('job-1')
    expect(wrapper.emitted('resolved')).toBeTruthy()
  })

  it('webhook 未启用任务：授权后 PATCH enable', async () => {
    autonomyApis.listAutonomyDecisions.mockResolvedValue({ decisions: [], total: 0 })
    const wrapper = mountModal({
      task_ref: 'webhook:wh-1', kind: 'webhook', name: 'issue-triage',
      enabled: false, status: 'disabled', needs_decision: ['publish'], all_clear: false,
    })
    await flushPromises()

    await wrapper.find('[data-testid="grant-and-enable"]').trigger('click')
    await flushPromises()

    expect(webhookApis.updateWebhookEnabled).toHaveBeenCalledWith('issue-triage', true)
    expect(taskApis.resumeCronJob).not.toHaveBeenCalled()
  })
})
