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

    expect(taskApis.createCronJob).toHaveBeenCalledWith(
      {
        name: '晚报生成',
        schedule: '@daily',
        prompt: '生成今晚总结',
        type: 'cron',
      },
      expect.objectContaining({
        onProgress: expect.any(Function),
        signal: expect.any(AbortSignal),
      }),
    )
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

  // Review L5: whitespace-only stdout/stderr must not render an empty toggle.
  it('does not render stdout/stderr toggles for whitespace-only output', async () => {
    taskApis.getCronJobHistory.mockResolvedValueOnce([
      {
        id: 'run-ws',
        job_id: 'job-1',
        status: 'success',
        started_at: '2026-04-03T09:00:00Z',
        result: 'done',
        stdout: '   \n\t  ',
        stderr: '\n',
      },
    ])

    const wrapper = mountTasksView()
    await flushPromises()

    await wrapper.findAll('button').find((btn) => btn.text().includes('历史'))!.trigger('click')
    await flushPromises()

    // Expand the run detail (result is present so the row stays clickable).
    await wrapper.find('.task-card__history-item--clickable').trigger('click')
    await flushPromises()

    expect(wrapper.find('.task-card__history-toggle').exists()).toBe(false)
    expect(wrapper.find('.task-card__history-stdout').exists()).toBe(false)
    expect(wrapper.find('.task-card__history-stderr').exists()).toBe(false)
    expect(wrapper.find('.task-card__history-result').text()).toBe('done')
    wrapper.unmount()
  })

  it('renders stdout toggle with a code-point-safe preview for real output', async () => {
    taskApis.getCronJobHistory.mockResolvedValueOnce([
      {
        id: 'run-out',
        job_id: 'job-1',
        status: 'success',
        started_at: '2026-04-03T09:00:00Z',
        stdout: 'a'.repeat(39) + '😀 and more beyond the cutoff',
      },
    ])

    const wrapper = mountTasksView()
    await flushPromises()

    await wrapper.findAll('button').find((btn) => btn.text().includes('历史'))!.trigger('click')
    await flushPromises()
    await wrapper.find('.task-card__history-item--clickable').trigger('click')
    await flushPromises()

    const preview = wrapper.find('.task-card__history-preview')
    expect(preview.exists()).toBe(true)
    // Truncated at 40 code points — the emoji survives whole, no U+FFFD.
    expect(preview.text()).toBe('a'.repeat(39) + '😀…')
    wrapper.unmount()
  })

  // Review L3: outside-click collapse must not fire for toolbar / form modal
  // clicks, but a click truly outside any card still collapses the history.
  describe('outside-click collapse exemptions', () => {
    async function mountWithExpandedHistory() {
      const wrapper = mountTasksView()
      await flushPromises()
      await wrapper.findAll('button').find((btn) => btn.text().includes('历史'))!.trigger('click')
      await flushPromises()
      expect(wrapper.find('.task-card__history').exists()).toBe(true)
      return wrapper
    }

    it('keeps history open when clicking the page toolbar', async () => {
      const wrapper = await mountWithExpandedHistory()

      // AutomationView renders its action buttons inside .hc-toolbar.
      const toolbar = document.createElement('div')
      toolbar.className = 'hc-toolbar'
      const toolbarBtn = document.createElement('button')
      toolbar.appendChild(toolbarBtn)
      document.body.appendChild(toolbar)
      toolbarBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flushPromises()

      expect(wrapper.find('.task-card__history').exists()).toBe(true)
      toolbar.remove()
      wrapper.unmount()
    })

    it('keeps history open while interacting with the create form modal', async () => {
      const wrapper = await mountWithExpandedHistory()

      ;(wrapper.vm as unknown as { openCreateForm: () => void }).openCreateForm()
      await wrapper.vm.$nextTick()
      const nameInput = wrapper.find('.hc-modal input')
      expect(nameInput.exists()).toBe(true)
      await nameInput.trigger('click')
      await flushPromises()

      expect(wrapper.find('.task-card__history').exists()).toBe(true)
      wrapper.unmount()
    })

    it('still collapses when clicking truly outside any card', async () => {
      const wrapper = await mountWithExpandedHistory()

      document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flushPromises()

      expect(wrapper.find('.task-card__history').exists()).toBe(false)
      wrapper.unmount()
    })
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
