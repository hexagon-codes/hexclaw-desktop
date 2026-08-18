import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import K12RecordsView from '../views/K12RecordsView.vue'
import K12MistakeReviewMenu from '../components/K12MistakeReviewMenu.vue'
import { useK12Store } from '../store'

const h = vi.hoisted(() => ({
  allItems: [] as Array<Record<string, unknown>>,
  dueItems: [] as Array<Record<string, unknown>>,
  listMistakes: vi.fn(),
  reviewQueue: vi.fn(),
  suppressMistake: vi.fn(),
  restoreMistakeReview: vi.fn(),
  markMastered: vi.fn(),
  report: vi.fn(),
}))

vi.mock('@/api/k12', async () => ({
  ...(await import('./weekly-practice-api-mock')).weeklyPracticeApiMockDefaults('child-a'),
  k12ListMistakes: (...args: unknown[]) => h.listMistakes(...args),
  k12ReviewQueue: (...args: unknown[]) => h.reviewQueue(...args),
  k12SuppressMistake: (...args: unknown[]) => h.suppressMistake(...args),
  k12RestoreMistakeReview: (...args: unknown[]) => h.restoreMistakeReview(...args),
  k12InsightReport: (...args: unknown[]) => h.report(...args),
  k12ListAccumulation: vi.fn().mockResolvedValue({ items: [] }),
  k12ListPracticeSets: vi.fn().mockResolvedValue({ items: [] }),
  k12ListCreativeWorks: vi.fn().mockResolvedValue({ items: [] }),
  k12MarkMastered: (...args: unknown[]) => h.markMastered(...args),
  k12DeleteMistake: vi.fn().mockResolvedValue({ ok: true }),
  k12GetMistakePracticeGeneration: vi.fn().mockImplementation((_agent: string, recordID: string) =>
    Promise.resolve({ state: 'available', source_mistake_id: recordID })),
  k12RecordMistake: vi.fn(),
  k12AddAccumulation: vi.fn(),
  k12AddToBasket: vi.fn(),
  k12FillPracticeBasket: vi.fn(),
  k12GenerateCustomPaper: vi.fn(),
  k12RemoveFromBasket: vi.fn(),
  k12FinalizePracticeSet: vi.fn(),
  k12AdvancePracticeSet: vi.fn(),
  k12SubmitPracticeSet: vi.fn(),
  k12GradePracticeSet: vi.fn(),
  k12CancelPracticeSet: vi.fn(),
  k12GetPracticePaper: vi.fn(),
  k12GetPracticePrintJobPaper: vi.fn(),
  k12PreparePracticePrintJob: vi.fn(),
  k12RecordPracticePrintEvent: vi.fn(),
  k12RetryPracticePrintJob: vi.fn(),
  k12UploadAsset: vi.fn(),
  k12AssetURL: vi.fn().mockReturnValue('/asset'),
}))

const toastError = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({
    success: vi.fn(),
    error: toastError,
    info: vi.fn(),
    warning: vi.fn(),
  }),
}))

vi.mock('../export', () => ({
  exportArchiveDocument: vi.fn(),
  worksheetFilename: vi.fn().mockReturnValue('worksheet'),
  download: vi.fn(),
  printPracticePaper: vi.fn(),
  printPracticePaperWithReceipt: vi.fn(),
  savePracticePaperPdf: vi.fn(),
}))

const active = {
  record_id: 'm1',
  question: '4.5 × 2 = ?',
  knowledge_point: '小数乘法',
  error_cause: '小数点',
  status: 'scheduled',
  review_state: 'scheduled',
  version: 3,
  subject: '数学',
  due_at: 1,
}

const suppressed = {
  ...active,
  status: 'suppressed',
  review_state: 'suppressed',
  version: 4,
  due_at: null,
  archived_reason: 'manual',
  restorable: true,
}

const active2 = {
  ...active,
  record_id: 'm2',
  question: '15 - 5.7 = ?',
  version: 7,
}

const suppressed2 = {
  ...active2,
  status: 'suppressed',
  review_state: 'suppressed',
  version: 8,
  due_at: null,
  archived_reason: 'manual',
  restorable: true,
}

function i18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: zhCN },
  })
}

function render(agentId = 'child-a', attachTo?: Element) {
  return mount(K12RecordsView, {
    attachTo,
    props: {
      agentId,
      agentName: '小明的辅导助手',
      grade: '五年级上 · 人教版',
    },
    global: { plugins: [createPinia(), i18n()] },
  })
}

async function openAllMistakes(wrapper: ReturnType<typeof render>) {
  await flushPromises()
  await wrapper.get('[data-testid="subtab-mistakes"]').trigger('click')
}

function reviewMenuFor(wrapper: ReturnType<typeof render>, question: string) {
  const rowIndex = wrapper.findAll('.rl-row').findIndex((row) => row.text().includes(question))
  const menu = rowIndex < 0 ? undefined : wrapper.findAllComponents(K12MistakeReviewMenu)[rowIndex]
  if (!menu) throw new Error(`missing review menu for ${question}`)
  return menu
}

async function requestSuppress(wrapper: ReturnType<typeof render>, question: string) {
  reviewMenuFor(wrapper, question).vm.$emit('suppress')
  await flushPromises()
}

function undoButton(recordId: string) {
  return document.body.querySelector<HTMLButtonElement>(
    `[data-testid="mistake-archive-undo-${recordId}"]`,
  )
}

function undoButtons() {
  return document.body.querySelectorAll<HTMLButtonElement>(
    '[data-testid^="mistake-archive-undo-"]',
  )
}

async function clickUndo(recordId: string) {
  const button = undoButton(recordId)
  if (!button) throw new Error(`missing archive Undo for ${recordId}`)
  button.click()
  await flushPromises()
}

beforeEach(() => {
  vi.useFakeTimers()
  setActivePinia(createPinia())
  toastError.mockReset()
  h.allItems = [active]
  h.dueItems = [active]
  h.listMistakes.mockReset().mockImplementation(() => Promise.resolve({ items: h.allItems }))
  h.reviewQueue.mockReset().mockImplementation(() => Promise.resolve({ items: h.dueItems }))
  h.report.mockReset().mockResolvedValue({
    trend: { total: 1, mastered: 0, reviewing: 1, retried: 0, suppressed: 0 },
    weak_top3: [],
    month_new_mistakes: 1,
    review_completion_rate: 0,
    consecutive_fail_kps: [],
    suggestion: '',
  })
  h.suppressMistake.mockReset().mockImplementation(async () => {
    h.allItems = [suppressed]
    h.dueItems = []
    return suppressed
  })
  h.restoreMistakeReview.mockReset().mockImplementation(async () => {
    h.allItems = [{ ...active, version: 5 }]
    h.dueItems = [{ ...active, version: 5 }]
    return { ...active, version: 5 }
  })
  h.markMastered.mockReset().mockResolvedValue({ ok: true })
})

afterEach(() => {
  vi.useRealTimers()
  document.body.replaceChildren()
})

describe('BUG-20260725-017 · controlled suppression and restore', () => {
  it('keeps the same-agent official projection while an overlapping reload is still pending', async () => {
    const store = useK12Store()
    await store.loadMistakes('child-a')

    let resolveArchive!: (value: typeof suppressed) => void
    h.suppressMistake.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveArchive = resolve
        }),
    )
    const archive = store.suppressMistake('child-a', 'm1', active.version)

    h.listMistakes.mockImplementation(() => new Promise(() => {}))
    h.reviewQueue.mockImplementation(() => new Promise(() => {}))
    void store.loadMistakes('child-a')

    resolveArchive(suppressed)
    await archive

    expect(store.mistakeView).not.toBeNull()
    expect(store.mistakeView?.items).toEqual([
      expect.objectContaining({ recordId: 'm1', status: 'suppressed', version: 4 }),
    ])
  })

  it('keeps a committed projection visible while a same-agent re-entry reload is still pending', async () => {
    let resolveArchive!: (value: typeof suppressed) => void
    h.suppressMistake.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveArchive = resolve
        }),
    )
    const wrapper = render()
    await openAllMistakes(wrapper)
    await requestSuppress(wrapper, '4.5 × 2 = ?')

    h.listMistakes.mockImplementation(() => new Promise(() => {}))
    h.reviewQueue.mockImplementation(() => new Promise(() => {}))
    await wrapper.setProps({ active: false })
    await wrapper.setProps({ active: true })

    resolveArchive(suppressed)
    await flushPromises()

    expect(wrapper.find('[data-testid="records-loading"]').exists()).toBe(false)
    expect(undoButton('m1')).not.toBeNull()
    await wrapper.get('[data-testid="mistake-status-suppressed"]').trigger('click')
    expect(wrapper.text()).toContain('4.5 × 2 = ?')
  })

  it('only removes the row after suppress succeeds, then exposes one server-backed Undo', async () => {
    let resolveArchive!: (value: unknown) => void
    h.suppressMistake.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveArchive = resolve
        }),
    )
    const wrapper = render()
    await openAllMistakes(wrapper)

    await requestSuppress(wrapper, '4.5 × 2 = ?')
    expect(wrapper.text()).toContain('4.5 × 2 = ?')
    expect(undoButton('m1')).toBeNull()

    h.allItems = [suppressed]
    h.dueItems = []
    resolveArchive(suppressed)
    await flushPromises()

    expect(wrapper.text()).not.toContain('4.5 × 2 = ?')
    expect(undoButton('m1')?.textContent).toContain('撤销')
    expect(h.suppressMistake).toHaveBeenCalledWith(
      'child-a',
      'm1',
      3,
      expect.stringMatching(/^desktop-mistake-suppress:child-a:m1:/),
    )

  })

  it('commits the suppressed projection and Undo immediately when calibration never returns', async () => {
    const wrapper = render()
    await openAllMistakes(wrapper)
    h.listMistakes.mockImplementation(() => new Promise(() => {}))
    h.reviewQueue.mockImplementation(() => new Promise(() => {}))

    await requestSuppress(wrapper, '4.5 × 2 = ?')
    await flushPromises()

    expect(wrapper.text()).not.toContain('4.5 × 2 = ?')
    expect(wrapper.find('[data-testid="records-loading"]').exists()).toBe(false)
    expect(undoButton('m1')).not.toBeNull()
    await wrapper.get('[data-testid="mistake-status-suppressed"]').trigger('click')
    expect(wrapper.text()).toContain('4.5 × 2 = ?')
  })

  it('keeps long-term suppression out of 本周该练 and uses the always-visible button in 全部错题', async () => {
    const wrapper = render()
    await flushPromises()

    expect(wrapper.findComponent(K12MistakeReviewMenu).exists()).toBe(false)
    expect(wrapper.text()).not.toContain('不再复习')
    await openAllMistakes(wrapper)

    const menu = reviewMenuFor(wrapper, '4.5 × 2 = ?')
    expect(menu.props('display')).toBe('visible')
    expect(menu.find('.mistake-more__trigger').exists()).toBe(false)
    await menu.get('[data-testid="mistake-suppress-review"]').trigger('click')
    expect(document.body.querySelector('[role="alertdialog"]')).not.toBeNull()
    expect(h.suppressMistake).not.toHaveBeenCalled()

    const confirm = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="confirm-suppress-review"]',
    )
    if (!confirm) throw new Error('missing suppress confirmation')
    confirm.click()
    await flushPromises()

    expect(h.suppressMistake).toHaveBeenCalledOnce()
  })

  it('replays an outcome-unknown suppression once with the exact same idempotency key', async () => {
    h.suppressMistake
      .mockRejectedValueOnce(new Error('connection lost after commit'))
      .mockImplementationOnce(async () => {
        h.allItems = [suppressed]
        h.dueItems = []
        return suppressed
      })
    const wrapper = render()
    await openAllMistakes(wrapper)

    await requestSuppress(wrapper, '4.5 × 2 = ?')
    await flushPromises()

    expect(h.suppressMistake).toHaveBeenCalledTimes(2)
    expect(h.suppressMistake.mock.calls[1]).toEqual(h.suppressMistake.mock.calls[0])
    expect(undoButton('m1')).not.toBeNull()
  })

  it('keeps the record visible and shows no fake success when suppress fails', async () => {
    h.suppressMistake.mockRejectedValueOnce(
      Object.assign(new Error('archive failed'), { status: 422 }),
    )
    const wrapper = render()
    await openAllMistakes(wrapper)

    await requestSuppress(wrapper, '4.5 × 2 = ?')
    await flushPromises()

    expect(wrapper.text()).toContain('4.5 × 2 = ?')
    expect(wrapper.find('[data-testid="mistakes-error"]').exists()).toBe(false)
    expect(undoButton('m1')).toBeNull()
    expect(toastError).toHaveBeenCalledWith('archive failed')
    expect(h.markMastered).not.toHaveBeenCalled()
  })

  it('Undo calls restore with the suppressed response version and reloads both lists', async () => {
    const wrapper = render()
    await openAllMistakes(wrapper)
    await requestSuppress(wrapper, '4.5 × 2 = ?')
    await flushPromises()

    await clickUndo('m1')

    expect(h.restoreMistakeReview).toHaveBeenCalledWith(
      'child-a',
      'm1',
      4,
      expect.stringMatching(/^desktop-mistake-restore:child-a:m1:/),
    )
    expect(wrapper.text()).toContain('4.5 × 2 = ?')
    expect(h.listMistakes).toHaveBeenCalledTimes(3)
    expect(h.reviewQueue).toHaveBeenCalledTimes(3)
  })

  it('restores the projection and consumes Undo even when calibration throws', async () => {
    const wrapper = render()
    await openAllMistakes(wrapper)
    await requestSuppress(wrapper, '4.5 × 2 = ?')
    await flushPromises()
    expect(undoButton('m1')).not.toBeNull()

    h.listMistakes.mockRejectedValue(new Error('calibration failed'))
    h.reviewQueue.mockRejectedValue(new Error('calibration failed'))
    await clickUndo('m1')

    expect(wrapper.text()).toContain('4.5 × 2 = ?')
    expect(undoButton('m1')).toBeNull()
  })

  it('keeps one global Undo action on consecutive suppressions', async () => {
    h.allItems = [active, active2]
    h.dueItems = [active, active2]
    h.suppressMistake.mockImplementation(async (_agent, recordId) => {
      if (recordId === 'm1') {
        h.allItems = [suppressed, active2]
        h.dueItems = [active2]
        return suppressed
      }
      h.allItems = [suppressed, suppressed2]
      h.dueItems = []
      return suppressed2
    })
    const wrapper = render()
    await openAllMistakes(wrapper)

    await requestSuppress(wrapper, '4.5 × 2 = ?')
    await flushPromises()
    await requestSuppress(wrapper, '15 - 5.7 = ?')
    await flushPromises()

    expect(undoButton('m1')).toBeNull()
    expect(undoButtons()).toHaveLength(1)
    expect(undoButton('m2')).not.toBeNull()

  })

  it('keeps Undo on the later user action when concurrent suppress responses arrive out of order', async () => {
    h.allItems = [active, active2]
    h.dueItems = [active, active2]
    let resolveFirst!: (value: typeof suppressed) => void
    let resolveSecond!: (value: typeof suppressed2) => void
    h.suppressMistake.mockImplementation(
      (_agent, recordId) =>
        new Promise((resolve) => {
          if (recordId === 'm1') resolveFirst = resolve
          else resolveSecond = resolve
        }),
    )
    const wrapper = render()
    await openAllMistakes(wrapper)
    h.listMistakes.mockImplementation(() => new Promise(() => {}))
    h.reviewQueue.mockImplementation(() => new Promise(() => {}))

    await requestSuppress(wrapper, '4.5 × 2 = ?')
    await requestSuppress(wrapper, '15 - 5.7 = ?')

    resolveSecond(suppressed2)
    await flushPromises()
    expect(undoButton('m2')).not.toBeNull()

    resolveFirst(suppressed)
    await flushPromises()
    expect(undoButton('m1')).toBeNull()
    expect(undoButtons()).toHaveLength(1)
    expect(undoButton('m2')).not.toBeNull()
  })

  it('renders the singleton Undo at document body level so K12 tab visibility cannot hide it', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const wrapper = render('child-a', host)
    await openAllMistakes(wrapper)
    await requestSuppress(wrapper, '4.5 × 2 = ?')
    await flushPromises()

    const undo = document.body.querySelector<HTMLElement>('.k12archive-undos')
    expect(undo).not.toBeNull()
    expect(undo?.parentElement).toBe(document.body)

    wrapper.unmount()
    host.remove()
  })

  it('offers long-term restore only in the suppressed filter', async () => {
    h.allItems = [suppressed]
    h.dueItems = []
    const wrapper = render()
    await openAllMistakes(wrapper)

    expect(wrapper.text()).not.toContain('4.5 × 2 = ?')
    await wrapper.get('[data-testid="mistake-status-suppressed"]').trigger('click')

    expect(wrapper.text()).toContain('4.5 × 2 = ?')
    expect(wrapper.find('[data-testid="mistake-archive-m1"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="mistake-mark-mastered-m1"]').exists()).toBe(false)
    await wrapper.get('[data-testid="mistake-restore-review"]').trigger('click')
    await flushPromises()

    expect(h.restoreMistakeReview).toHaveBeenCalledWith(
      'child-a',
      'm1',
      4,
      expect.stringMatching(/^desktop-mistake-restore:child-a:m1:/),
    )
  })

  it('does not invent restore eligibility for a legacy suppressed record', async () => {
    h.allItems = [{ ...suppressed, restorable: false }]
    h.dueItems = []
    const wrapper = render()
    await openAllMistakes(wrapper)
    await wrapper.get('[data-testid="mistake-status-suppressed"]').trigger('click')

    expect(wrapper.text()).toContain('4.5 × 2 = ?')
    expect(wrapper.find('[data-testid="mistake-restore-review"]').exists()).toBe(false)
    await wrapper
      .findAll('.rl-btn')
      .find((button) => button.text() === '详情')!
      .trigger('click')
    expect(wrapper.find('[data-testid="detail-restore-review"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="detail-mark-mastered"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="detail-archive-review"]').exists()).toBe(false)
  })

  it('aligns suppressed detail actions to restore while leaving delete on its existing ConfirmDialog', async () => {
    h.allItems = [suppressed]
    h.dueItems = []
    const wrapper = render()
    await openAllMistakes(wrapper)
    await wrapper.get('[data-testid="mistake-status-suppressed"]').trigger('click')
    await wrapper
      .findAll('.rl-btn')
      .find((button) => button.text() === '详情')!
      .trigger('click')

    expect(wrapper.find('[data-testid="detail-restore-review"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="detail-archive-review"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="detail-mark-mastered"]').exists()).toBe(false)
    await wrapper.get('[data-testid="detail-delete"]').trigger('click')
    expect(document.body.querySelector('[role="alertdialog"]')).not.toBeNull()
  })

  it('refreshes server truth after a 409 and never fabricates mastery evidence', async () => {
    h.suppressMistake.mockRejectedValueOnce(
      Object.assign(new Error('record version conflict'), { status: 409 }),
    )
    const wrapper = render()
    await openAllMistakes(wrapper)
    const beforeLoads = h.listMistakes.mock.calls.length

    await requestSuppress(wrapper, '4.5 × 2 = ?')
    await flushPromises()

    expect(h.listMistakes.mock.calls.length).toBeGreaterThan(beforeLoads)
    expect(wrapper.text()).toContain('4.5 × 2 = ?')
    expect(h.report).toHaveBeenLastCalledWith('child-a')
    expect(h.suppressMistake.mock.calls[0]).toEqual([
      'child-a',
      'm1',
      3,
      expect.stringMatching(/^desktop-mistake-suppress:child-a:m1:/),
    ])
    expect(h.restoreMistakeReview).not.toHaveBeenCalled()
    expect(h.markMastered).not.toHaveBeenCalled()
  })

  it('clears the old child Undo and scopes every command to the current child', async () => {
    const wrapper = render()
    await openAllMistakes(wrapper)
    await requestSuppress(wrapper, '4.5 × 2 = ?')
    await flushPromises()
    expect(undoButton('m1')).not.toBeNull()

    h.allItems = []
    h.dueItems = []
    await wrapper.setProps({ agentId: 'child-b' })
    await flushPromises()

    expect(undoButton('m1')).toBeNull()
    expect(h.suppressMistake.mock.calls[0]?.[0]).toBe('child-a')
    expect(h.restoreMistakeReview).not.toHaveBeenCalled()
  })
})
