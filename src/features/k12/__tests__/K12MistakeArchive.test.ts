import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import K12RecordsView from '../views/K12RecordsView.vue'
import { useK12Store } from '../store'

const h = vi.hoisted(() => ({
  allItems: [] as Array<Record<string, unknown>>,
  dueItems: [] as Array<Record<string, unknown>>,
  listMistakes: vi.fn(),
  reviewQueue: vi.fn(),
  archiveMistake: vi.fn(),
  restoreMistake: vi.fn(),
  markMastered: vi.fn(),
  report: vi.fn(),
}))

vi.mock('@/api/k12', () => ({
  k12ListMistakes: (...args: unknown[]) => h.listMistakes(...args),
  k12ReviewQueue: (...args: unknown[]) => h.reviewQueue(...args),
  k12ArchiveMistake: (...args: unknown[]) => h.archiveMistake(...args),
  k12RestoreMistake: (...args: unknown[]) => h.restoreMistake(...args),
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
  status: 'new',
  version: 3,
  subject: '数学',
  due_at: 1,
}

const archived = {
  ...active,
  status: 'archived',
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

const archived2 = {
  ...active2,
  status: 'archived',
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
    trend: { total: 1, mastered: 0, reviewing: 1, retried: 0, archived: 0 },
    weak_top3: [],
    month_new_mistakes: 1,
    review_completion_rate: 0,
    consecutive_fail_kps: [],
    suggestion: '',
  })
  h.archiveMistake.mockReset().mockImplementation(async () => {
    h.allItems = [archived]
    h.dueItems = []
    return archived
  })
  h.restoreMistake.mockReset().mockImplementation(async () => {
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

describe('BUG-20260725-017 · controlled archive and restore', () => {
  it('keeps the same-agent official projection while an overlapping reload is still pending', async () => {
    const store = useK12Store()
    await store.loadMistakes('child-a')

    let resolveArchive!: (value: typeof archived) => void
    h.archiveMistake.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveArchive = resolve
        }),
    )
    const archive = store.archiveMistake('child-a', 'm1', active.version)

    h.listMistakes.mockImplementation(() => new Promise(() => {}))
    h.reviewQueue.mockImplementation(() => new Promise(() => {}))
    void store.loadMistakes('child-a')

    resolveArchive(archived)
    await archive

    expect(store.mistakeView).not.toBeNull()
    expect(store.mistakeView?.items).toEqual([
      expect.objectContaining({ recordId: 'm1', status: 'archived', version: 4 }),
    ])
  })

  it('keeps a committed projection visible while a same-agent re-entry reload is still pending', async () => {
    let resolveArchive!: (value: typeof archived) => void
    h.archiveMistake.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveArchive = resolve
        }),
    )
    const wrapper = render()
    await openAllMistakes(wrapper)
    await wrapper.get('[data-testid="mistake-archive-m1"]').trigger('click')

    h.listMistakes.mockImplementation(() => new Promise(() => {}))
    h.reviewQueue.mockImplementation(() => new Promise(() => {}))
    await wrapper.setProps({ active: false })
    await wrapper.setProps({ active: true })

    resolveArchive(archived)
    await flushPromises()

    expect(wrapper.find('[data-testid="records-loading"]').exists()).toBe(false)
    expect(undoButton('m1')).not.toBeNull()
    await wrapper.get('[data-testid="mistake-status-archived"]').trigger('click')
    expect(wrapper.text()).toContain('4.5 × 2 = ?')
  })

  it('only removes the row after archive succeeds, then exposes an 8-second Undo', async () => {
    let resolveArchive!: (value: unknown) => void
    h.archiveMistake.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveArchive = resolve
        }),
    )
    const wrapper = render()
    await openAllMistakes(wrapper)

    await wrapper.get('[data-testid="mistake-archive-m1"]').trigger('click')
    expect(wrapper.text()).toContain('4.5 × 2 = ?')
    expect(undoButton('m1')).toBeNull()

    h.allItems = [archived]
    h.dueItems = []
    resolveArchive(archived)
    await flushPromises()

    expect(wrapper.text()).not.toContain('4.5 × 2 = ?')
    expect(undoButton('m1')?.textContent).toContain('撤销')
    expect(h.archiveMistake).toHaveBeenCalledWith(
      'child-a',
      'm1',
      3,
      expect.stringMatching(/^desktop-mistake-archive:child-a:m1:/),
    )

    await vi.advanceTimersByTimeAsync(7_999)
    expect(undoButton('m1')).not.toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    expect(undoButton('m1')).toBeNull()
  })

  it('commits the archived projection and Undo immediately when calibration never returns', async () => {
    const wrapper = render()
    await openAllMistakes(wrapper)
    h.listMistakes.mockImplementation(() => new Promise(() => {}))
    h.reviewQueue.mockImplementation(() => new Promise(() => {}))

    await wrapper.get('[data-testid="mistake-archive-m1"]').trigger('click')
    await flushPromises()

    expect(wrapper.text()).not.toContain('4.5 × 2 = ?')
    expect(wrapper.find('[data-testid="records-loading"]').exists()).toBe(false)
    expect(undoButton('m1')).not.toBeNull()
    await wrapper.get('[data-testid="mistake-status-archived"]').trigger('click')
    expect(wrapper.text()).toContain('4.5 × 2 = ?')
  })

  it('exposes the same controlled archive action in the weekly queue without a confirm dialog', async () => {
    const wrapper = render()
    await flushPromises()

    expect(wrapper.get('[data-testid="mistake-archive-m1"]').text()).toBe('不再复习')
    await wrapper.get('[data-testid="mistake-archive-m1"]').trigger('click')
    await flushPromises()

    expect(h.archiveMistake).toHaveBeenCalledOnce()
    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(false)
  })

  it('replays an outcome-unknown archive once with the exact same idempotency key', async () => {
    h.archiveMistake
      .mockRejectedValueOnce(new Error('connection lost after commit'))
      .mockImplementationOnce(async () => {
        h.allItems = [archived]
        h.dueItems = []
        return archived
      })
    const wrapper = render()
    await openAllMistakes(wrapper)

    await wrapper.get('[data-testid="mistake-archive-m1"]').trigger('click')
    await flushPromises()

    expect(h.archiveMistake).toHaveBeenCalledTimes(2)
    expect(h.archiveMistake.mock.calls[1]).toEqual(h.archiveMistake.mock.calls[0])
    expect(undoButton('m1')).not.toBeNull()
  })

  it('keeps the record visible and shows no fake success when archive fails', async () => {
    h.archiveMistake.mockRejectedValueOnce(
      Object.assign(new Error('archive failed'), { status: 422 }),
    )
    const wrapper = render()
    await openAllMistakes(wrapper)

    await wrapper.get('[data-testid="mistake-archive-m1"]').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('4.5 × 2 = ?')
    expect(wrapper.find('[data-testid="mistakes-error"]').exists()).toBe(false)
    expect(undoButton('m1')).toBeNull()
    expect(toastError).toHaveBeenCalledWith('archive failed')
    expect(h.markMastered).not.toHaveBeenCalled()
  })

  it('Undo calls restore with the archived response version and reloads both lists', async () => {
    const wrapper = render()
    await openAllMistakes(wrapper)
    await wrapper.get('[data-testid="mistake-archive-m1"]').trigger('click')
    await flushPromises()

    await clickUndo('m1')

    expect(h.restoreMistake).toHaveBeenCalledWith(
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
    await wrapper.get('[data-testid="mistake-archive-m1"]').trigger('click')
    await flushPromises()
    expect(undoButton('m1')).not.toBeNull()

    h.listMistakes.mockRejectedValue(new Error('calibration failed'))
    h.reviewQueue.mockRejectedValue(new Error('calibration failed'))
    await clickUndo('m1')

    expect(wrapper.text()).toContain('4.5 × 2 = ?')
    expect(undoButton('m1')).toBeNull()
  })

  it('keeps one global Undo action and resets its 8-second window on consecutive archives', async () => {
    h.allItems = [active, active2]
    h.dueItems = [active, active2]
    h.archiveMistake.mockImplementation(async (_agent, recordId) => {
      if (recordId === 'm1') {
        h.allItems = [archived, active2]
        h.dueItems = [active2]
        return archived
      }
      h.allItems = [archived, archived2]
      h.dueItems = []
      return archived2
    })
    const wrapper = render()
    await openAllMistakes(wrapper)

    await wrapper.get('[data-testid="mistake-archive-m1"]').trigger('click')
    await flushPromises()
    await vi.advanceTimersByTimeAsync(4_000)
    await wrapper.get('[data-testid="mistake-archive-m2"]').trigger('click')
    await flushPromises()

    expect(undoButton('m1')).toBeNull()
    expect(undoButtons()).toHaveLength(1)
    expect(undoButton('m2')).not.toBeNull()

    await vi.advanceTimersByTimeAsync(4_000)
    expect(undoButton('m2')).not.toBeNull()
    await vi.advanceTimersByTimeAsync(4_000)
    expect(undoButton('m2')).toBeNull()
  })

  it('keeps Undo on the later user action when concurrent archive responses arrive out of order', async () => {
    h.allItems = [active, active2]
    h.dueItems = [active, active2]
    let resolveFirst!: (value: typeof archived) => void
    let resolveSecond!: (value: typeof archived2) => void
    h.archiveMistake.mockImplementation(
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

    await wrapper.get('[data-testid="mistake-archive-m1"]').trigger('click')
    await wrapper.get('[data-testid="mistake-archive-m2"]').trigger('click')

    resolveSecond(archived2)
    await flushPromises()
    expect(undoButton('m2')).not.toBeNull()

    resolveFirst(archived)
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
    await wrapper.get('[data-testid="mistake-archive-m1"]').trigger('click')
    await flushPromises()

    const undo = document.body.querySelector<HTMLElement>('.k12archive-undos')
    expect(undo).not.toBeNull()
    expect(undo?.parentElement).toBe(document.body)

    wrapper.unmount()
    host.remove()
  })

  it('offers long-term restore only in the archived filter', async () => {
    h.allItems = [archived]
    h.dueItems = []
    const wrapper = render()
    await openAllMistakes(wrapper)

    expect(wrapper.text()).not.toContain('4.5 × 2 = ?')
    await wrapper.get('[data-testid="mistake-status-archived"]').trigger('click')

    expect(wrapper.text()).toContain('4.5 × 2 = ?')
    expect(wrapper.find('[data-testid="mistake-archive-m1"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="mistake-mark-mastered-m1"]').exists()).toBe(false)
    await wrapper.get('[data-testid="mistake-restore-m1"]').trigger('click')
    await flushPromises()

    expect(h.restoreMistake).toHaveBeenCalledWith(
      'child-a',
      'm1',
      4,
      expect.stringMatching(/^desktop-mistake-restore:child-a:m1:/),
    )
  })

  it('does not invent restore eligibility for a legacy archived record', async () => {
    h.allItems = [{ ...archived, restorable: false }]
    h.dueItems = []
    const wrapper = render()
    await openAllMistakes(wrapper)
    await wrapper.get('[data-testid="mistake-status-archived"]').trigger('click')

    expect(wrapper.text()).toContain('4.5 × 2 = ?')
    expect(wrapper.find('[data-testid="mistake-restore-m1"]').exists()).toBe(false)
    await wrapper
      .findAll('.rl-btn')
      .find((button) => button.text() === '详情')!
      .trigger('click')
    expect(wrapper.find('[data-testid="detail-restore-review"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="detail-mark-mastered"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="detail-archive-review"]').exists()).toBe(false)
  })

  it('aligns archived detail actions to restore while leaving delete on its existing ConfirmDialog', async () => {
    h.allItems = [archived]
    h.dueItems = []
    const wrapper = render()
    await openAllMistakes(wrapper)
    await wrapper.get('[data-testid="mistake-status-archived"]').trigger('click')
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
    h.archiveMistake.mockRejectedValueOnce(
      Object.assign(new Error('record version conflict'), { status: 409 }),
    )
    const wrapper = render()
    await openAllMistakes(wrapper)
    const beforeLoads = h.listMistakes.mock.calls.length

    await wrapper.get('[data-testid="mistake-archive-m1"]').trigger('click')
    await flushPromises()

    expect(h.listMistakes.mock.calls.length).toBeGreaterThan(beforeLoads)
    expect(wrapper.text()).toContain('4.5 × 2 = ?')
    expect(h.report).toHaveBeenLastCalledWith('child-a')
    expect(h.archiveMistake.mock.calls[0]).toEqual([
      'child-a',
      'm1',
      3,
      expect.stringMatching(/^desktop-mistake-archive:child-a:m1:/),
    ])
    expect(h.restoreMistake).not.toHaveBeenCalled()
    expect(h.markMastered).not.toHaveBeenCalled()
  })

  it('clears the old child Undo and scopes every command to the current child', async () => {
    const wrapper = render()
    await openAllMistakes(wrapper)
    await wrapper.get('[data-testid="mistake-archive-m1"]').trigger('click')
    await flushPromises()
    expect(undoButton('m1')).not.toBeNull()

    h.allItems = []
    h.dueItems = []
    await wrapper.setProps({ agentId: 'child-b' })
    await flushPromises()

    expect(undoButton('m1')).toBeNull()
    expect(h.archiveMistake.mock.calls[0]?.[0]).toBe('child-a')
    expect(h.restoreMistake).not.toHaveBeenCalled()
  })
})
