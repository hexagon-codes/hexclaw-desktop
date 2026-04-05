import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import TasksView from '../TasksView.vue'
import zhCN from '@/i18n/locales/zh-CN'

const taskApis = vi.hoisted(() => ({
  getCronJobs: vi.fn(),
  createCronJob: vi.fn(),
  deleteCronJob: vi.fn(),
  pauseCronJob: vi.fn(),
  resumeCronJob: vi.fn(),
  triggerCronJob: vi.fn(),
  getCronJobHistory: vi.fn(),
}))

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}))

vi.mock('@/api/tasks', () => ({
  getCronJobs: taskApis.getCronJobs,
  createCronJob: taskApis.createCronJob,
  deleteCronJob: taskApis.deleteCronJob,
  pauseCronJob: taskApis.pauseCronJob,
  resumeCronJob: taskApis.resumeCronJob,
  triggerCronJob: taskApis.triggerCronJob,
  getCronJobHistory: taskApis.getCronJobHistory,
}))

vi.mock('@/composables', () => ({
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

const baseJob = {
  id: 'job-1',
  name: '日报生成',
  type: 'cron' as const,
  schedule: '0 9 * * *',
  prompt: '生成今天的日报',
  user_id: 'desktop-user',
  status: 'active' as const,
  last_run_at: '',
  next_run_at: '2026-04-04T09:00:00Z',
  run_count: 2,
  created_at: '2026-04-03T09:00:00Z',
}

describe('TasksView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('confirm', vi.fn(() => true))
    taskApis.getCronJobs.mockResolvedValue({ jobs: [{ ...baseJob }], total: 1 })
    taskApis.createCronJob.mockResolvedValue({ id: 'job-2', name: '晚报生成', next_run_at: '2026-04-03T18:00:00Z' })
    taskApis.deleteCronJob.mockResolvedValue({ message: 'ok' })
    taskApis.pauseCronJob.mockResolvedValue({ message: 'paused' })
    taskApis.resumeCronJob.mockResolvedValue({ message: 'resumed' })
    taskApis.triggerCronJob.mockResolvedValue({ message: 'triggered', run_id: 'run-1' })
    taskApis.getCronJobHistory.mockResolvedValue([])
  })

  it('creates a task through the modal and reloads the list', async () => {
    const wrapper = mountTasksView()
    await flushPromises()

    ;(wrapper.vm as unknown as { openCreateForm: () => void }).openCreateForm()
    await wrapper.vm.$nextTick()

    const inputs = wrapper.findAll('input')
    expect(inputs.length).toBeGreaterThanOrEqual(2)
    await inputs[0]!.setValue('晚报生成')
    await inputs[1]!.setValue('@daily')
    await wrapper.find('textarea').setValue('生成今晚总结')

    const createBtn = wrapper.findAll('button').find((btn) => btn.text().includes('创建'))
    expect(createBtn).toBeDefined()
    await createBtn!.trigger('click')
    await flushPromises()

    expect(taskApis.createCronJob).toHaveBeenCalledWith({
      name: '晚报生成',
      schedule: '@daily',
      prompt: '生成今晚总结',
      type: 'cron',
    })
    expect(taskApis.getCronJobs).toHaveBeenCalledTimes(2)
    expect(toast.success).toHaveBeenCalled()
  })

  it('pauses and resumes an active job from the card actions', async () => {
    const wrapper = mountTasksView()
    await flushPromises()

    const pauseBtn = wrapper.findAll('button').find((btn) => btn.text().includes('暂停'))
    expect(pauseBtn).toBeDefined()
    await pauseBtn!.trigger('click')
    await flushPromises()

    expect(taskApis.pauseCronJob).toHaveBeenCalledWith('job-1')
    expect(wrapper.text()).toContain('已暂停')

    const resumeBtn = wrapper.findAll('button').find((btn) => btn.text().includes('恢复'))
    expect(resumeBtn).toBeDefined()
    await resumeBtn!.trigger('click')
    await flushPromises()

    expect(taskApis.resumeCronJob).toHaveBeenCalledWith('job-1')
    expect(wrapper.text()).toContain('运行中')
  })

  it('shows running history entries as running instead of failed', async () => {
    taskApis.getCronJobHistory.mockResolvedValueOnce([
      {
        id: 'run-1',
        job_id: 'job-1',
        status: 'running',
        started_at: '2026-04-03T09:00:00Z',
      },
    ])

    const wrapper = mountTasksView()
    await flushPromises()

    const historyBtn = wrapper.findAll('button').find((btn) => btn.text().includes('历史'))
    expect(historyBtn).toBeDefined()
    await historyBtn!.trigger('click')
    await flushPromises()

    const historyStatus = wrapper.find('.task-card__history-status')
    expect(historyStatus.exists()).toBe(true)
    expect(historyStatus.text()).toBe('运行中')
  })

  it('does not start a second pause request while the first one is still running', async () => {
    let resolvePause!: () => void
    taskApis.pauseCronJob.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolvePause = resolve
        }),
    )

    const wrapper = mountTasksView()
    await flushPromises()

    const pauseBtn = wrapper.findAll('button').find((btn) => btn.text().includes('暂停'))
    expect(pauseBtn).toBeDefined()

    await pauseBtn!.trigger('click')
    await flushPromises()

    // After first click starts, the button becomes disabled — second click is a no-op
    expect(taskApis.pauseCronJob).toHaveBeenCalledTimes(1)
    expect(pauseBtn!.attributes('disabled')).toBeDefined()

    resolvePause()
    await flushPromises()
  })

  it('does not start a second delete request while the first one is still running', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true))

    let resolveDelete!: () => void
    taskApis.deleteCronJob.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveDelete = resolve
        }),
    )

    const wrapper = mountTasksView()
    await flushPromises()

    const deleteBtn = wrapper.findAll('button').find((btn) => btn.text().includes('删除'))
    expect(deleteBtn).toBeDefined()

    await deleteBtn!.trigger('click')
    await flushPromises()

    // After first click, button is disabled — second click is a no-op
    expect(taskApis.deleteCronJob).toHaveBeenCalledTimes(1)
    expect(deleteBtn!.attributes('disabled')).toBeDefined()

    resolveDelete()
    await flushPromises()
    vi.unstubAllGlobals()
  })
})
