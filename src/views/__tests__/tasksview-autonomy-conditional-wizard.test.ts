import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import TasksView from '../TasksView.vue'
import zhCN from '@/i18n/locales/zh-CN'

/**
 * 条件式向导（创建流静默预检）：
 *  - 预检全绿 → 一步创建即启用，不出现审批弹窗（保 function-first 手感）
 *  - 命中需审批能力 → 审批弹窗展开，创建被挂起
 *  - 选「仅授权本任务」→ 暂停态创建 → 任务级授权 → resume 启用
 *  - 预检不可用（老后端）→ 按全绿放行，运行时闸兜底
 *  - 权限总览 !all_clear 的任务卡显示「待授权 · 去开启」徽章
 */

const taskApis = vi.hoisted(() => ({
  getCronJobs: vi.fn(),
  createCronJob: vi.fn(),
  deleteCronJob: vi.fn(),
  pauseCronJob: vi.fn(),
  resumeCronJob: vi.fn(),
  triggerCronJob: vi.fn(),
  getCronJobHistory: vi.fn(),
}))

const autonomyApis = vi.hoisted(() => ({
  preflightAutonomy: vi.fn(),
  createAutonomyGrant: vi.fn(),
  getAutonomySummary: vi.fn(),
  listAutonomyDecisions: vi.fn(),
}))

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}))

vi.mock('@/api/tasks', () => ({ ...taskApis }))
vi.mock('@/api/autonomy', () => ({ ...autonomyApis }))
vi.mock('@/api/webhook', () => ({
  updateWebhookEnabled: vi.fn(),
}))
vi.mock('@/composables', () => ({ useToast: () => toast }))
vi.mock('@/composables/useToast', () => ({ useToast: () => toast }))
vi.mock('@/api/im-channels', () => ({
  getConnections: vi.fn().mockResolvedValue([]),
  // BUG-20260718：TasksView 现用 getConnectionsResult（区分未配置 vs 故障）。
  getConnectionsResult: vi.fn().mockResolvedValue({ connections: [] }),
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

function mountTasksView() {
  return mount(TasksView, {
    attachTo: document.body,
    global: {
      plugins: [createTestI18n()],
      stubs: {
        EmptyState: { template: '<div>empty</div>' },
        LoadingState: { template: '<div>loading</div>' },
        teleport: true,
        transition: false,
      },
    },
  })
}

const CLEAR_PF = {
  source: 'cron', profile: 'function_first',
  capabilities: [], estimated: ['read', 'exec_sandboxed'], needs_decision: [], all_clear: true,
}

const PUBLISH_PF = {
  source: 'cron', profile: 'function_first',
  capabilities: [
    { category: 'read', tools: ['search'], state: 'auto' },
    { category: 'publish', tools: ['publish_*'], state: 'approval' },
  ],
  estimated: ['read', 'publish'], needs_decision: ['publish'], all_clear: false,
}

const EMPTY_SUMMARY = {
  profile: 'function_first',
  counts: { tasks: 0, ready: 0, pending: 0, grants: 0 },
  pending: [], tasks: [],
}

async function fillCreateForm(wrapper: ReturnType<typeof mountTasksView>) {
  ;(wrapper.vm as unknown as { openCreateForm: () => void }).openCreateForm()
  await wrapper.vm.$nextTick()
  const inputs = wrapper.findAll('input')
  await inputs[0]!.setValue('发布周报')
  await inputs[1]!.setValue('@daily')
  await wrapper.find('textarea').setValue('汇总本周内容并发布到公众号')
}

async function clickCreate(wrapper: ReturnType<typeof mountTasksView>) {
  const createBtn = wrapper.findAll('button').find((btn) => btn.text().includes('创建'))
  expect(createBtn).toBeDefined()
  await createBtn!.trigger('click')
  await flushPromises()
}

describe('TasksView 条件式向导', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    taskApis.getCronJobs.mockResolvedValue({ jobs: [], total: 0 })
    taskApis.createCronJob.mockResolvedValue({ job: { id: 'job-9', name: '发布周报' } })
    taskApis.resumeCronJob.mockResolvedValue({ message: 'ok' })
    autonomyApis.getAutonomySummary.mockResolvedValue(EMPTY_SUMMARY)
    autonomyApis.createAutonomyGrant.mockResolvedValue({ grant: { id: 'g-1' } })
    autonomyApis.listAutonomyDecisions.mockResolvedValue({ decisions: [], total: 0 })
  })

  it('预检全绿：一步创建即启用，不出现审批弹窗', async () => {
    autonomyApis.preflightAutonomy.mockResolvedValue(CLEAR_PF)
    const wrapper = mountTasksView()
    await flushPromises()
    await fillCreateForm(wrapper)
    await clickCreate(wrapper)

    expect(autonomyApis.preflightAutonomy).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'cron', prompt: '汇总本周内容并发布到公众号' }),
    )
    expect(wrapper.find('[data-testid="permission-approval-modal"]').exists()).toBe(false)
    expect(taskApis.createCronJob).toHaveBeenCalledTimes(1)
    // 全绿路径不带 paused
    expect(taskApis.createCronJob.mock.calls[0]![0]).not.toHaveProperty('paused')
    expect(autonomyApis.createAutonomyGrant).not.toHaveBeenCalled()
  })

  it('命中需审批能力：审批弹窗展开，创建被挂起', async () => {
    autonomyApis.preflightAutonomy.mockResolvedValue(PUBLISH_PF)
    const wrapper = mountTasksView()
    await flushPromises()
    await fillCreateForm(wrapper)
    await clickCreate(wrapper)

    expect(taskApis.createCronJob).not.toHaveBeenCalled()
    const modal = wrapper.find('[data-testid="permission-approval-modal"]')
    expect(modal.exists()).toBe(true)
    // 需决定的能力以本地化标签呈现
    expect(modal.text()).toContain('发布内容')
  })

  it('选「仅授权本任务」：暂停态创建 → 任务级授权 → resume 启用', async () => {
    autonomyApis.preflightAutonomy.mockResolvedValue(PUBLISH_PF)
    const wrapper = mountTasksView()
    await flushPromises()
    await fillCreateForm(wrapper)
    await clickCreate(wrapper)

    await wrapper.find('[data-testid="choose-grant"]').trigger('click')
    await flushPromises()

    expect(taskApis.createCronJob).toHaveBeenCalledTimes(1)
    expect(taskApis.createCronJob.mock.calls[0]![0]).toMatchObject({ paused: true })
    expect(autonomyApis.createAutonomyGrant).toHaveBeenCalledWith(
      expect.objectContaining({ task_ref: 'cron:job-9', source: 'cron', entries: ['publish'] }),
    )
    expect(taskApis.resumeCronJob).toHaveBeenCalledWith('job-9')
  })

  it('选「保存为暂停任务」：paused 创建且不授权', async () => {
    autonomyApis.preflightAutonomy.mockResolvedValue(PUBLISH_PF)
    const wrapper = mountTasksView()
    await flushPromises()
    await fillCreateForm(wrapper)
    await clickCreate(wrapper)

    await wrapper.find('[data-testid="choose-paused"]').trigger('click')
    await flushPromises()

    expect(taskApis.createCronJob.mock.calls[0]![0]).toMatchObject({ paused: true })
    expect(autonomyApis.createAutonomyGrant).not.toHaveBeenCalled()
    expect(taskApis.resumeCronJob).not.toHaveBeenCalled()
  })

  it('预检不可用（老后端）：按全绿放行，运行时闸兜底', async () => {
    autonomyApis.preflightAutonomy.mockRejectedValue(new Error('ECONNREFUSED'))
    const wrapper = mountTasksView()
    await flushPromises()
    await fillCreateForm(wrapper)
    await clickCreate(wrapper)

    expect(taskApis.createCronJob).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[data-testid="permission-approval-modal"]').exists()).toBe(false)
  })

  it('总览 !all_clear 的任务卡显示待授权徽章', async () => {
    autonomyApis.preflightAutonomy.mockResolvedValue(CLEAR_PF)
    taskApis.getCronJobs.mockResolvedValue({
      jobs: [{
        id: 'job-1', name: '写标签任务', type: 'cron', schedule: '@daily',
        user_id: 'desktop-user', status: 'active', last_run_at: '',
        next_run_at: '2026-07-03T09:00:00Z', run_count: 0, created_at: '2026-07-01T09:00:00Z',
        source_prompt: '写 GitHub 标签',
      }],
      total: 1,
    })
    autonomyApis.getAutonomySummary.mockResolvedValue({
      profile: 'function_first',
      counts: { tasks: 1, ready: 0, pending: 1, grants: 0 },
      pending: [],
      tasks: [{
        task_ref: 'cron:job-1', kind: 'cron', name: '写标签任务',
        enabled: true, status: 'active', needs_decision: ['publish'], all_clear: false,
      }],
    })

    const wrapper = mountTasksView()
    await flushPromises()

    const badge = wrapper.find('[data-testid="perm-badge"]')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toContain('待授权')

    // 点击徽章打开阻断处理弹窗
    await badge.trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="permission-blocked-modal"]').exists()).toBe(true)
  })
})
