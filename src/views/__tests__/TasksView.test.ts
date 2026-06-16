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

/** Go zero time — what the backend reports for never-compiled (agent) specs. */
const ZERO_TIME = '0001-01-01T00:00:00Z'

const agentSpec = {
  runtime: 'agent' as const,
  script: '',
  deps: [],
  timeout_s: 300,
  compiled: { model: '', at: ZERO_TIME, tokens_in: 0, tokens_out: 0, hash: '' },
}

const pythonSpec = {
  runtime: 'python3' as const,
  script: 'print("hi")',
  deps: ['requests'],
  timeout_s: 60,
  compiled: { model: 'qwen3', at: '2026-06-10T01:00:00Z', tokens_in: 10, tokens_out: 20, hash: 'abc' },
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

  // Issue 1: agent-runtime jobs must not render the (empty) script panel.
  describe('agent runtime rendering', () => {
    it('shows the agent badge with timeout and hides the script toggle', async () => {
      taskApis.getCronJobs.mockResolvedValue({ jobs: [{ ...baseJob, spec: agentSpec }], total: 1 })

      const wrapper = mountTasksView()
      await flushPromises()

      const badge = wrapper.find('.task-card__agent-badge')
      expect(badge.exists()).toBe(true)
      expect(badge.text()).toContain('智能体 · 每次执行由 AI 推理完成')
      expect(badge.text()).toContain('300s')

      // No script toggle, no script panel, no compiled line for agent jobs
      expect(wrapper.findAll('button').some((btn) => btn.text().includes('查看脚本'))).toBe(false)
      expect(wrapper.find('.task-card__script').exists()).toBe(false)
      expect(wrapper.text()).not.toContain('编译于')
      wrapper.unmount()
    })

    it('keeps the script panel for python3 jobs and shows compiled meta', async () => {
      taskApis.getCronJobs.mockResolvedValue({ jobs: [{ ...baseJob, spec: pythonSpec }], total: 1 })

      const wrapper = mountTasksView()
      await flushPromises()

      expect(wrapper.find('.task-card__agent-badge').exists()).toBe(false)
      const scriptBtn = wrapper.findAll('button').find((btn) => btn.text().includes('查看脚本'))
      expect(scriptBtn).toBeDefined()
      await scriptBtn!.trigger('click')
      await flushPromises()

      expect(wrapper.find('.task-card__script').exists()).toBe(true)
      expect(wrapper.text()).toContain('编译于')
      expect(wrapper.text()).toContain('qwen3')
      wrapper.unmount()
    })

    it('hides the compiled line for python3 jobs with the zero compiled.at', async () => {
      const spec = { ...pythonSpec, compiled: { ...pythonSpec.compiled, at: ZERO_TIME } }
      taskApis.getCronJobs.mockResolvedValue({ jobs: [{ ...baseJob, spec }], total: 1 })

      const wrapper = mountTasksView()
      await flushPromises()

      await wrapper.findAll('button').find((btn) => btn.text().includes('查看脚本'))!.trigger('click')
      await flushPromises()

      expect(wrapper.find('.task-card__script').exists()).toBe(true)
      expect(wrapper.text()).not.toContain('编译于')
      wrapper.unmount()
    })
  })

  // Issue 3 + 4: manual trigger shows an optimistic running row with a live
  // elapsed label and polls history until a terminal row replaces it.
  describe('manual trigger run watch', () => {
    it('expands history, inserts a ticking running row, then resolves via polling', async () => {
      // Keep setTimeout/setImmediate real so flushPromises still works.
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
      try {
        taskApis.getCronJobHistory.mockResolvedValue([])
        const wrapper = mountTasksView()
        await flushPromises()

        await wrapper.findAll('button').find((btn) => btn.text().includes('立即执行'))!.trigger('click')
        await flushPromises()

        // (a) history auto-expanded, (b) optimistic running row on top
        expect(wrapper.find('.task-card__history').exists()).toBe(true)
        expect(wrapper.find('.task-card__history-status').text()).toBe('运行中')
        expect(taskApis.getCronJobHistory).not.toHaveBeenCalled()

        // (d) elapsed label ticks every second while running
        await vi.advanceTimersByTimeAsync(2000)
        await flushPromises()
        expect(wrapper.find('.task-card__history-duration').text()).toBe('2s')

        // (c) poll at 3s finds no fresh row -> optimistic row stays
        await vi.advanceTimersByTimeAsync(1000)
        await flushPromises()
        expect(taskApis.getCronJobHistory).toHaveBeenCalledTimes(1)
        expect(wrapper.find('.task-card__history-status').text()).toBe('运行中')

        // Terminal row arrives on the next poll: replaces the optimistic row,
        // duration renders as m:ss (Issue 4), polling stops.
        taskApis.getCronJobHistory.mockResolvedValue([
          {
            id: 'run-real',
            job_id: 'job-1',
            status: 'success',
            started_at: new Date().toISOString(),
            duration_ms: 126_000,
          },
        ])
        await vi.advanceTimersByTimeAsync(3000)
        await flushPromises()
        expect(wrapper.findAll('.task-card__history-status')).toHaveLength(1)
        expect(wrapper.find('.task-card__history-status').text()).toBe('成功')
        expect(wrapper.find('.task-card__history-duration').text()).toBe('2:06')

        const callsAfterTerminal = taskApis.getCronJobHistory.mock.calls.length
        await vi.advanceTimersByTimeAsync(10_000)
        await flushPromises()
        expect(taskApis.getCronJobHistory.mock.calls.length).toBe(callsAfterTerminal)
        wrapper.unmount()
      } finally {
        vi.useRealTimers()
      }
    })

    it('renders sub-minute durations as whole seconds', async () => {
      taskApis.getCronJobHistory.mockResolvedValueOnce([
        {
          id: 'run-short',
          job_id: 'job-1',
          status: 'success',
          started_at: '2026-04-03T09:00:00Z',
          duration_ms: 17_100,
        },
      ])

      const wrapper = mountTasksView()
      await flushPromises()
      await wrapper.findAll('button').find((btn) => btn.text().includes('历史'))!.trigger('click')
      await flushPromises()

      expect(wrapper.find('.task-card__history-duration').text()).toBe('17s')
      wrapper.unmount()
    })

    // H1: collapsing the history (收起历史 toggle) must stop the 3s poll — it
    // otherwise leaked for up to 8 minutes against a now-hidden job.
    it('stops polling when the history is collapsed via the toggle', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
      try {
        taskApis.getCronJobHistory.mockResolvedValue([])
        const wrapper = mountTasksView()
        await flushPromises()

        await wrapper.findAll('button').find((btn) => btn.text().includes('立即执行'))!.trigger('click')
        await flushPromises()
        expect(wrapper.find('.task-card__history').exists()).toBe(true)

        // Click 收起历史 to collapse the panel.
        await wrapper.findAll('button').find((btn) => btn.text().includes('收起历史'))!.trigger('click')
        await flushPromises()
        expect(wrapper.find('.task-card__history').exists()).toBe(false)

        const callsAfterCollapse = taskApis.getCronJobHistory.mock.calls.length
        await vi.advanceTimersByTimeAsync(10_000)
        await flushPromises()
        expect(taskApis.getCronJobHistory.mock.calls.length).toBe(callsAfterCollapse)
        wrapper.unmount()
      } finally {
        vi.useRealTimers()
      }
    })

    // H1: an outside click that collapses the panel must also stop the poll.
    it('stops polling when an outside click collapses the history', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
      try {
        taskApis.getCronJobHistory.mockResolvedValue([])
        const wrapper = mountTasksView()
        await flushPromises()

        await wrapper.findAll('button').find((btn) => btn.text().includes('立即执行'))!.trigger('click')
        await flushPromises()
        expect(wrapper.find('.task-card__history').exists()).toBe(true)

        // A click truly outside any card collapses the history.
        document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        await flushPromises()
        expect(wrapper.find('.task-card__history').exists()).toBe(false)

        const callsAfterCollapse = taskApis.getCronJobHistory.mock.calls.length
        await vi.advanceTimersByTimeAsync(10_000)
        await flushPromises()
        expect(taskApis.getCronJobHistory.mock.calls.length).toBe(callsAfterCollapse)
        wrapper.unmount()
      } finally {
        vi.useRealTimers()
      }
    })

    // M2: a scheduled run that fired seconds BEFORE the manual trigger must not
    // be mistaken for the trigger's row — otherwise the optimistic running row
    // vanishes the moment the (already-terminal) prior run is polled.
    it('does not mistake a recent prior scheduled run for the manual trigger', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
      try {
        taskApis.getCronJobHistory.mockResolvedValue([])
        const wrapper = mountTasksView()
        await flushPromises()

        // A scheduled success that started ~30s before the click. With the old
        // 60s slack this matched the trigger and stopped the watch immediately.
        const priorStartedAt = new Date(Date.now() - 30_000).toISOString()
        taskApis.getCronJobHistory.mockResolvedValue([
          {
            id: 'run-scheduled',
            job_id: 'job-1',
            status: 'success',
            started_at: priorStartedAt,
            duration_ms: 5_000,
          },
        ])

        await wrapper.findAll('button').find((btn) => btn.text().includes('立即执行'))!.trigger('click')
        await flushPromises()

        // First poll fires at 3s: the prior scheduled row must NOT be matched,
        // so the optimistic running row stays on top and polling continues.
        await vi.advanceTimersByTimeAsync(3000)
        await flushPromises()
        expect(taskApis.getCronJobHistory).toHaveBeenCalledTimes(1)
        const statuses = wrapper.findAll('.task-card__history-status')
        expect(statuses[0]!.text()).toBe('运行中')

        // The real manual run (started at/after the trigger) finally arrives and
        // replaces the optimistic row, stopping the watch.
        taskApis.getCronJobHistory.mockResolvedValue([
          {
            id: 'run-manual',
            job_id: 'job-1',
            status: 'success',
            started_at: new Date().toISOString(),
            duration_ms: 4_000,
          },
          {
            id: 'run-scheduled',
            job_id: 'job-1',
            status: 'success',
            started_at: priorStartedAt,
            duration_ms: 5_000,
          },
        ])
        await vi.advanceTimersByTimeAsync(3000)
        await flushPromises()
        expect(wrapper.find('.task-card__history-status').text()).toBe('成功')

        const callsAfterTerminal = taskApis.getCronJobHistory.mock.calls.length
        await vi.advanceTimersByTimeAsync(10_000)
        await flushPromises()
        expect(taskApis.getCronJobHistory.mock.calls.length).toBe(callsAfterTerminal)
        wrapper.unmount()
      } finally {
        vi.useRealTimers()
      }
    })

    it('stops polling when the job card is deleted and on unmount', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
      try {
        taskApis.getCronJobHistory.mockResolvedValue([])
        const wrapper = mountTasksView()
        await flushPromises()

        await wrapper.findAll('button').find((btn) => btn.text().includes('立即执行'))!.trigger('click')
        await flushPromises()

        await wrapper.findAll('button').find((btn) => btn.text().includes('删除'))!.trigger('click')
        await flushPromises()

        const callsAfterDelete = taskApis.getCronJobHistory.mock.calls.length
        await vi.advanceTimersByTimeAsync(10_000)
        await flushPromises()
        expect(taskApis.getCronJobHistory.mock.calls.length).toBe(callsAfterDelete)

        wrapper.unmount()
        await vi.advanceTimersByTimeAsync(10_000)
        await flushPromises()
        expect(taskApis.getCronJobHistory.mock.calls.length).toBe(callsAfterDelete)
      } finally {
        vi.useRealTimers()
      }
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
