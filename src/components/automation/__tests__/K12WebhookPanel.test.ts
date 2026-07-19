import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import K12WebhookPanel from '@/features/k12/views/K12WebhookPanel.vue'

const hooks = vi.hoisted(() => ({
  getAgents: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  rotate: vi.fn(),
  remove: vi.fn(),
  history: vi.fn(),
  retryReceipt: vi.fn(),
  clipboard: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}))

vi.mock('@/api/agents', () => ({ getAgents: hooks.getAgents }))
vi.mock('@/api/webhook', () => ({
  getK12Webhooks: hooks.list,
  createK12Webhook: hooks.create,
  updateK12Webhook: hooks.update,
  rotateK12WebhookSecret: hooks.rotate,
  deleteK12Webhook: hooks.remove,
  getK12WebhookReceipts: hooks.history,
  retryK12WebhookReceipt: hooks.retryReceipt,
  webhookUrlFor: (name: string) =>
    `http://127.0.0.1:8787/api/v1/webhooks/${encodeURIComponent(name)}`,
}))
vi.mock('@/api/desktop', () => ({ setClipboard: hooks.clipboard }))
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ success: hooks.success, error: hooks.error }),
}))
vi.mock('lucide-vue-next', () => ({
  Copy: { template: '<span />' },
  RefreshCw: { template: '<span />' },
  Trash2: { template: '<span />' },
  X: { template: '<span />' },
}))

const agentA = {
  name: 'k12-tutor-a',
  display_name: '小明的辅导助手',
  provider: '',
  model: '',
  metadata: { scenario: 'k12-tutor', 'k12.child_name': '小明', 'k12.learner_id': 'learner-a' },
}
const agentB = {
  name: 'k12-tutor-b',
  display_name: '小红的辅导助手',
  provider: '',
  model: '',
  metadata: { scenario: 'k12-tutor', 'k12.child_name': '小红', 'k12.learner_id': 'learner-b' },
}
const binding = {
  binding_id: 'binding-a',
  name: 'homework-hook',
  agent_id: agentA.name,
  learner_id: 'learner-a',
  scope: 'direct',
  allowed_events: ['k12.submission.requested.v1'],
  has_secret: true,
  secret_version: 1,
  status: 'disabled',
  created_by: 'desktop-user',
  created_at: '2026-07-19T12:00:00Z',
  updated_at: '2026-07-19T12:00:00Z',
}

describe('K12WebhookPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    hooks.getAgents.mockResolvedValue({ agents: [agentA, agentB], total: 2, default: agentA.name })
    hooks.list.mockImplementation(async (agent: string) => ({
      k12_bindings: agent === agentA.name ? [binding] : [],
      total: agent === agentA.name ? 1 : 0,
    }))
    hooks.create.mockResolvedValue({
      binding,
      secret: 'whs_one_time',
      enabled: false,
      name: binding.name,
    })
    hooks.update.mockResolvedValue({ binding: { ...binding, status: 'enabled' }, enabled: true })
    hooks.rotate.mockResolvedValue({
      binding: { ...binding, secret_version: 2 },
      secret: 'whs_rotated',
    })
    hooks.remove.mockResolvedValue({ message: 'ok' })
    hooks.history.mockResolvedValue({
      receipts: [
        {
          receipt_id: 'rcpt-1',
          binding_id: binding.binding_id,
          event_id: 'event-1',
          event_type: 'k12.submission.requested.v1',
          payload_digest: 'digest',
          status: 'succeeded',
          job_or_execution_ref: 'grading_job:job-1',
          created_at: '2026-07-19T12:01:00Z',
          updated_at: '2026-07-19T12:01:01Z',
        },
      ],
      total: 1,
    })
    hooks.retryReceipt.mockResolvedValue({
      receipt: {
        receipt_id: 'rcpt-failed',
        status: 'accepted',
        retryable: false,
        attempt_count: 1,
      },
    })
  })

  it('scopes every operation to the selected child and shows secrets only in one-time result state', async () => {
    const wrapper = mount(K12WebhookPanel, {
      attachTo: document.body,
      global: { stubs: { teleport: true } },
    })
    await flushPromises()

    expect(hooks.list).toHaveBeenCalledWith(agentA.name)
    expect(wrapper.text()).toContain('homework-hook')
    expect(wrapper.text()).toContain('仅直连')

    await wrapper.get('[data-testid="k12-webhook-create-open"]').trigger('click')
    await wrapper.get('[data-testid="k12-webhook-name"]').setValue('new-hook')
    await wrapper.get('[data-testid="k12-webhook-event-return"]').setValue(true)
    await wrapper.get('[data-testid="k12-webhook-create-submit"]').trigger('click')
    await flushPromises()

    expect(hooks.create).toHaveBeenCalledWith({
      name: 'new-hook',
      agentId: agentA.name,
      learnerId: 'learner-a',
      allowedEvents: ['k12.submission.requested.v1', 'k12.practice_return.requested.v1'],
      allowedWorkflows: [],
    })
    expect(wrapper.text()).toContain('whs_one_time')
    expect(wrapper.text()).toContain('仅本次显示')
    await wrapper.get('[data-testid="k12-webhook-secret-close"]').trigger('click')
    expect(wrapper.text()).not.toContain('whs_one_time')

    await wrapper.get('[data-testid="k12-webhook-toggle-homework-hook"]').trigger('click')
    await flushPromises()
    expect(hooks.update).toHaveBeenCalledWith('homework-hook', agentA.name, { enabled: true })

    await wrapper.get('[data-testid="k12-webhook-rotate-homework-hook"]').trigger('click')
    await flushPromises()
    expect(hooks.rotate).toHaveBeenCalledWith('homework-hook', agentA.name)
    expect(wrapper.text()).toContain('whs_rotated')

    await wrapper.get('[data-testid="k12-webhook-history-homework-hook"]').trigger('click')
    await flushPromises()
    expect(hooks.history).toHaveBeenCalledWith('homework-hook', agentA.name)
    expect(wrapper.text()).toContain('succeeded')
    expect(wrapper.text()).toContain('grading_job:job-1')

    await wrapper.get('[data-testid="k12-webhook-agent"]').setValue(agentB.name)
    await flushPromises()
    expect(hooks.list).toHaveBeenLastCalledWith(agentB.name)
    expect(wrapper.text()).not.toContain('homework-hook')
  })

  it('edits event/workflow allowlists and deletes only within the selected Tutor scope', async () => {
    const wrapper = mount(K12WebhookPanel, { global: { stubs: { teleport: true } } })
    await flushPromises()
    await wrapper.get('[data-testid="k12-webhook-edit-homework-hook"]').trigger('click')
    await wrapper.get('[data-testid="k12-webhook-event-workflow"]').setValue(true)
    await wrapper.get('[data-testid="k12-webhook-workflows"]').setValue('weekly@v1, review@v2')
    await wrapper.get('[data-testid="k12-webhook-edit-submit"]').trigger('click')
    await flushPromises()
    expect(hooks.update).toHaveBeenCalledWith('homework-hook', agentA.name, {
      allowed_events: ['k12.submission.requested.v1', 'k12.workflow_run.requested.v1'],
      allowed_workflows: ['weekly@v1', 'review@v2'],
    })

    await wrapper.get('[data-testid="k12-webhook-delete-homework-hook"]').trigger('click')
    await flushPromises()
    expect(hooks.remove).toHaveBeenCalledWith('homework-hook', agentA.name)
  })

  it('discards slow binding and receipt responses after the selected child changes', async () => {
    let resolveAgentAList!: (value: { k12_bindings: Array<typeof binding>; total: number }) => void
    hooks.list.mockImplementation((agent: string) => {
      if (agent === agentA.name) {
        return new Promise((resolve) => {
          resolveAgentAList = resolve
        })
      }
      return Promise.resolve({ k12_bindings: [], total: 0 })
    })

    const wrapper = mount(K12WebhookPanel, { global: { stubs: { teleport: true } } })
    await flushPromises()
    await wrapper.get('[data-testid="k12-webhook-agent"]').setValue(agentB.name)
    await flushPromises()
    resolveAgentAList({ k12_bindings: [binding], total: 1 })
    await flushPromises()

    expect(wrapper.text()).not.toContain('homework-hook')

    hooks.list.mockImplementation(async (agent: string) => ({
      k12_bindings: agent === agentA.name ? [binding] : [],
      total: agent === agentA.name ? 1 : 0,
    }))
    await wrapper.get('[data-testid="k12-webhook-agent"]').setValue(agentA.name)
    await flushPromises()

    let resolveHistory!: (value: { receipts: Array<Record<string, string>>; total: number }) => void
    hooks.history.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveHistory = resolve
      }),
    )
    await wrapper.get('[data-testid="k12-webhook-history-homework-hook"]').trigger('click')
    await wrapper.get('[data-testid="k12-webhook-agent"]').setValue(agentB.name)
    await flushPromises()
    resolveHistory({
      receipts: [
        {
          receipt_id: 'old-child-receipt',
          binding_id: binding.binding_id,
          payload_digest: 'digest',
          status: 'succeeded',
          job_or_execution_ref: 'grading_job:old-child-job',
          created_at: '2026-07-19T12:01:00Z',
          updated_at: '2026-07-19T12:01:01Z',
        },
      ],
      total: 1,
    })
    await flushPromises()

    expect(wrapper.text()).not.toContain('old-child-receipt')
    expect(wrapper.text()).not.toContain('old-child-job')
  })

  it('keeps a visible retry action when loading the child scope fails', async () => {
    hooks.getAgents.mockRejectedValueOnce(new Error('engine offline'))
    const wrapper = mount(K12WebhookPanel, { global: { stubs: { teleport: true } } })
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain('engine offline')
    hooks.getAgents.mockResolvedValueOnce({ agents: [agentA], total: 1, default: agentA.name })
    await wrapper.get('[data-testid="k12-webhook-retry"]').trigger('click')
    await flushPromises()

    expect(hooks.getAgents).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('homework-hook')
  })

  it('offers redispatch only for failed Receipts with persisted retry evidence', async () => {
    hooks.history.mockResolvedValue({
      receipts: [
        {
          receipt_id: 'rcpt-failed',
          binding_id: binding.binding_id,
          payload_digest: 'digest-failed',
          status: 'failed',
          failure_kind: 'handler_failed',
          retryable: true,
          attempt_count: 1,
          created_at: '2026-07-19T12:01:00Z',
          updated_at: '2026-07-19T12:01:01Z',
        },
        {
          receipt_id: 'rcpt-unknown',
          binding_id: binding.binding_id,
          payload_digest: 'digest-unknown',
          status: 'outcome_unknown',
          failure_kind: 'outcome_unknown',
          retryable: false,
          attempt_count: 1,
          created_at: '2026-07-19T12:02:00Z',
          updated_at: '2026-07-19T12:02:01Z',
        },
      ],
      total: 2,
    })
    const wrapper = mount(K12WebhookPanel, { global: { stubs: { teleport: true } } })
    await flushPromises()
    await wrapper.get('[data-testid="k12-webhook-history-homework-hook"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="k12-webhook-retry-receipt-rcpt-failed"]').exists()).toBe(
      true,
    )
    expect(wrapper.find('[data-testid="k12-webhook-retry-receipt-rcpt-unknown"]').exists()).toBe(
      false,
    )
    await wrapper.get('[data-testid="k12-webhook-retry-receipt-rcpt-failed"]').trigger('click')
    await flushPromises()

    expect(hooks.retryReceipt).toHaveBeenCalledWith('homework-hook', agentA.name, 'rcpt-failed')
    expect(hooks.success).toHaveBeenCalledWith('Receipt 已重新派发')
    expect(hooks.history).toHaveBeenCalledTimes(2)
  })
})
