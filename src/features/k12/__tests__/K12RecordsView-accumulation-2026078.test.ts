import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import K12RecordsView from '../views/K12RecordsView.vue'

// #4/#5（hex-test 闭环）：积累本手动记录入口 + 语/英分科过滤。
// 后端 POST /accumulation（k12AddAccumulation）真 + GET /accumulation?subject=（store BUG-3 已通），
// 但原 UI 无「添加积累」入口、loadAccumulation 不传 subject、无学科筛选切换器。
const h = vi.hoisted(() => ({
  listSpy: vi.fn(),
  addSpy: vi.fn(),
  sendSpy: vi.fn(),
  generateSpy: vi.fn(),
  deleteSpy: vi.fn(),
  querySpy: vi.fn(),
  retrySpy: vi.fn(),
  clipboardSpy: vi.fn(),
}))
vi.mock('@/api/k12', () => ({
  k12ListMistakes: vi.fn().mockResolvedValue({ items: [] }),
  k12ReviewQueue: vi.fn().mockResolvedValue({ items: [] }),
  k12MarkMastered: vi.fn(),
  k12TutoringTips: vi.fn(),
  k12Grade: vi.fn(),
  k12InsightReport: vi.fn().mockResolvedValue({
    trend: { mastered: 0, reviewing: 0, retried: 0, archived: 0, total: 0 },
    weak_top3: [],
    month_new_mistakes: 0,
    review_completion_rate: -1,
    consecutive_fail_kps: null,
    suggestion: '',
  }),
  k12StudyTime: vi
    .fn()
    .mockResolvedValue({ days: [], total_records: 0, total_minutes: 0, note: '' }),
  k12ListAccumulation: (agent: string, subject?: string) => h.listSpy(agent, subject),
  k12AddAccumulation: (...args: unknown[]) => h.addSpy(...args),
  k12SendAccumulation: (...args: unknown[]) => h.sendSpy(...args),
  k12GenerateAccumulationDictation: (...args: unknown[]) => h.generateSpy(...args),
  k12DeleteAccumulation: (...args: unknown[]) => h.deleteSpy(...args),
  k12GetDeliveryBatch: vi.fn(),
  k12QueryDeliveryBatch: (...args: unknown[]) => h.querySpy(...args),
  k12RetryDeliveryBatch: (...args: unknown[]) => h.retrySpy(...args),
  k12GetMistakePracticeGeneration: vi
    .fn()
    .mockImplementation((_agent: string, recordID: string) =>
      Promise.resolve({ state: 'available', source_mistake_id: recordID }),
    ),
  k12ExportMd: vi.fn(),
}))
vi.mock('@/api/desktop', () => ({
  setClipboard: (...args: unknown[]) => h.clipboardSpy(...args),
}))

function i18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: zhCN },
  })
}
function render() {
  return mount(K12RecordsView, {
    attachTo: document.body,
    props: { agentId: 'mingming', agentName: '小明的辅导老师', grade: '五年级上' },
    global: { plugins: [createPinia(), i18n()] },
  })
}

async function gotoAccum(w: ReturnType<typeof render>) {
  await w
    .findAll('.seg button')
    .find((b) => b.text() === k12Zh.subTabs.accumulation)!
    .trigger('click')
  await flushPromises()
}

describe('K12RecordsView 积累本（#4 手动记录 + #5 分科过滤）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    h.listSpy.mockReset().mockResolvedValue({ items: [] })
    h.addSpy.mockReset().mockResolvedValue({ record_id: 'x', created: true })
    h.sendSpy.mockReset()
    h.generateSpy.mockReset().mockResolvedValue({
      dictation_generation: {
        generation_id: 'generation-1',
        status: 'queued',
        attempt: 1,
        updated_at: 100,
      },
    })
    h.deleteSpy.mockReset().mockResolvedValue({
      accumulation_id: 'x1',
      deleted: true,
      version: 2,
    })
    h.querySpy.mockReset()
    h.retrySpy.mockReset()
    h.clipboardSpy.mockReset().mockResolvedValue(undefined)
  })
  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('积累默写 wire 与页面投影都识别持久 re_add 状态', () => {
    const apiSource = readFileSync(resolve(process.cwd(), 'src/api/k12.ts'), 'utf8')
    const recordsSource = readFileSync(
      resolve(process.cwd(), 'src/features/k12/views/K12RecordsView.vue'),
      'utf8',
    )

    expect(apiSource).toMatch(/AccumulationDictationStatus[\s\S]*\| 're_add'/)
    expect(recordsSource).toMatch(/ACCUMULATION_DICTATION_STATUSES[\s\S]*'re_add'/)
  })

  it('积累对象不显示二级筛选或列表来源槽', async () => {
    const w = render()
    await flushPromises()
    await gotoAccum(w)

    expect(w.find('.k12accum__filters').exists()).toBe(false)
    expect(w.find('[data-testid="accum-filter-chinese"]').exists()).toBe(false)
    expect(w.find('.k12accum__source').exists()).toBe(false)
  })

  it('积累列表始终读取全量，不提交 subject 过滤', async () => {
    const w = render()
    await flushPromises()
    await gotoAccum(w)

    expect(h.listSpy).toHaveBeenCalled()
    expect(h.listSpy.mock.calls.every((call) => call[1] === undefined)).toBe(true)
  })

  it('#4 手动记录：表单只显示内容，提交 DTO 也只含 content', async () => {
    const w = render()
    await flushPromises()
    await gotoAccum(w)

    await w.find('[data-testid="accum-add-open"]').trigger('click')
    await flushPromises()

    const form = w.find('[data-testid="accum-add-form"]')
    expect(form.exists()).toBe(true)
    expect(form.classes()).toContain('k12modal')
    expect(form.find('[data-testid="accum-add-subject"]').exists()).toBe(false)
    expect(form.find('[data-testid="accum-add-type"]').exists()).toBe(false)
    expect(form.text()).not.toContain('更正分类')
    await w.find('[data-testid="accum-add-content"]').setValue('a piece of cake')
    h.listSpy.mockClear()
    await w.find('[data-testid="accum-add-submit"]').trigger('click')
    await flushPromises()

    expect(h.addSpy).toHaveBeenCalledTimes(1)
    expect(h.addSpy).toHaveBeenCalledWith(
      'mingming',
      { content: 'a piece of cake' },
      expect.stringMatching(/^desktop-accum-create:mingming:/),
    )
    // 提交后重新拉取积累本
    expect(h.listSpy).toHaveBeenCalled()
  })

  it('BUG-20260723-006 renders one icon plus and no duplicate plus in the accumulation label', async () => {
    const w = render()
    await flushPromises()
    await gotoAccum(w)

    const button = w.get('[data-testid="accum-add-open"]')
    expect(button.text().trim()).toBe('添加积累')
    expect(button.findAll('svg')).toHaveLength(1)
    expect(button.text()).not.toMatch(/[+＋]/)
  })

  it('新增幂等键：失败原地重试复用；内容变化或成功后的新提交才旋转', async () => {
    h.addSpy
      .mockRejectedValueOnce(new Error('结果未知'))
      .mockRejectedValueOnce(new Error('结果未知'))
      .mockResolvedValue({ record_id: 'x', created: true })
    const w = render()
    await flushPromises()
    await gotoAccum(w)
    await w.get('[data-testid="accum-add-open"]').trigger('click')
    const content = w.get('[data-testid="accum-add-content"]')
    const submit = w.get('[data-testid="accum-add-submit"]')

    await content.setValue('a piece of cake')
    await submit.trigger('click')
    await flushPromises()
    const firstKey = h.addSpy.mock.calls[0]![2]

    await submit.trigger('click')
    await flushPromises()
    expect(h.addSpy.mock.calls[1]![2]).toBe(firstKey)

    await content.setValue('take it easy')
    await submit.trigger('click')
    await flushPromises()
    const changedContentKey = h.addSpy.mock.calls[2]![2]
    expect(changedContentKey).not.toBe(firstKey)

    await w.get('[data-testid="accum-add-open"]').trigger('click')
    await w.get('[data-testid="accum-add-content"]').setValue('take it easy')
    await w.get('[data-testid="accum-add-submit"]').trigger('click')
    await flushPromises()
    expect(h.addSpy.mock.calls[3]![2]).not.toBe(changedContentKey)
  })

  it('#4 手动记录：内容为空时提交按钮禁用', async () => {
    const w = render()
    await flushPromises()
    await gotoAccum(w)
    await w.find('[data-testid="accum-add-open"]').trigger('click')
    await flushPromises()
    const submit = w.find('[data-testid="accum-add-submit"]')
    expect(submit.attributes('disabled')).toBeDefined()
  })

  it('积累加载失败会在当前 Tab 显示错误和原地重试，不污染其他档案', async () => {
    h.listSpy.mockRejectedValueOnce(new Error('积累加载失败')).mockResolvedValueOnce({ items: [] })
    const w = render()
    await flushPromises()
    await gotoAccum(w)

    expect(w.get('[data-testid="accum-error"]').text()).toContain('积累加载失败')
    await w.get('[data-testid="accum-retry"]').trigger('click')
    await flushPromises()

    expect(h.listSpy).toHaveBeenCalledTimes(2)
    expect(w.find('[data-testid="accum-error"]').exists()).toBe(false)
  })

  // 引文行对齐（20260718 定案迭代 3 · 原型 #k12AccumulationList）：引文全宽首行（quote 卡形态），
  // meta 行带收藏日期 acc-date（created_at unix 秒 → MM-DD）；旧后端无 created_at 时日期不显示。
  it('引文行对齐：created_at → MM-DD 收藏日期 + quote 卡形态', async () => {
    const ts = Math.floor(new Date(2026, 6, 12, 10, 0, 0).getTime() / 1000) // 本地 07-12
    h.listSpy.mockReset().mockResolvedValue({
      items: [
        {
          record_id: 'q1',
          subject: '语文',
          entry_type: '好词好句',
          content: '时间像海绵里的水',
          source: '课外阅读',
          status: 'new',
          created_at: ts,
        },
        {
          record_id: 'q2',
          subject: '英语',
          entry_type: '表达积累',
          content: 'a piece of cake',
          status: 'new',
        }, // 旧后端：无 created_at
      ],
    })
    const w = render()
    await flushPromises()
    await gotoAccum(w)

    const rows = w.findAll('.k12accum__row--quote')
    expect(rows.length, '积累行走引文卡形态（row--quote）').toBe(2)
    // 引文正文全宽置首（b.k12accum__title），日期在 meta 行
    const first = rows[0]!
    expect(first.find('b.k12accum__title').text()).toContain('时间像海绵里的水')
    expect(first.find('[data-testid="accum-date"]').text()).toBe('07-12')
    // 无 created_at → 不渲染日期占位
    expect(rows[1]!.find('[data-testid="accum-date"]').exists()).toBe(false)
  })

  // BUG-20260712-#2：积累行「查看详情」走真 handler，派生元数据只读且不投影掌握/状态。
  it('积累行「查看详情」点击 → 显示服务端派生元数据，但没有 mastery/status 或更正分类', async () => {
    h.listSpy.mockReset().mockResolvedValue({
      items: [
        {
          record_id: 'x1',
          subject: '英语',
          entry_type: '好词好句',
          content: 'a piece of cake',
          source: 'Unit 4',
          version: 1,
        },
      ],
    })
    const w = render()
    await flushPromises()
    await gotoAccum(w)
    // 积累行只应有默写主动作 +「查看详情」（无「再练」）
    const rowBtns = w.findAll('.k12accum__row .k12accum__detail').map((b) => b.text())
    expect(rowBtns).not.toContain('再练')
    await w
      .findAll('.k12accum__row .k12accum__detail')
      .find((b) => b.text() === '查看详情')!
      .trigger('click')
    await flushPromises()
    const modal = w.find('[data-testid="mistake-detail"]')
    expect(modal.exists()).toBe(true)
    expect(modal.get('.k12modal__head b').text()).toBe('积累内容详情')
    expect(w.find('[data-testid="detail-content"]').text()).toContain('a piece of cake')
    expect(w.find('[data-testid="detail-accum-subject"]').text()).toContain('英语')
    expect(w.find('[data-testid="detail-accum-type"]').text()).toContain('好词好句')
    expect(w.find('[data-testid="detail-accum-source"]').text()).toContain('Unit 4')
    expect(w.find('[data-testid="detail-status"]').exists()).toBe(false)
    expect(modal.text()).not.toMatch(/已掌握|待复习|更正分类/)
  })

  it('列表从服务端 generation 摘要恢复 initial/pending/committed/re_add/failed 五种动作状态', async () => {
    h.listSpy.mockResolvedValue({
      items: [
        {
          record_id: 'initial',
          subject: '语文',
          entry_type: '好词好句',
          content: '一寸光阴一寸金',
          version: 1,
        },
        {
          record_id: 'pending',
          subject: '英语',
          entry_type: '表达积累',
          content: 'take it easy',
          version: 2,
          dictation_generation: { generation_id: 'g-p', status: 'generating' },
        },
        {
          record_id: 'joined',
          subject: '英语',
          entry_type: '词汇积累',
          content: 'practice',
          version: 3,
          dictation_generation: {
            generation_id: 'g-j',
            status: 'committed',
            practice_item_id: 'practice-1',
          },
        },
        {
          record_id: 'readd',
          subject: '语文',
          entry_type: '古诗积累',
          content: '空山新雨后',
          version: 4,
          dictation_generation: { generation_id: 'g-r', status: 're_add' },
        },
        {
          record_id: 'failed',
          subject: '语文',
          entry_type: '写作素材',
          content: '雨后的树叶',
          version: 5,
          dictation_generation: { generation_id: 'g-f', status: 'failed' },
        },
      ],
    })

    const w = render()
    await flushPromises()
    await gotoAccum(w)

    const initial = w.get('[data-testid="accum-list-dictation-initial"]')
    expect(initial.text()).toBe('生成默写题，加入练习集')
    expect(initial.attributes('disabled')).toBeUndefined()

    const pending = w.get('[data-testid="accum-list-dictation-pending"]')
    expect(pending.text()).toBe('生成默写题，加入练习集')
    expect(pending.attributes('disabled')).toBeDefined()
    expect(pending.attributes('aria-busy')).toBe('true')

    const joined = w.get('[data-testid="accum-list-dictation-joined"]')
    expect(joined.text()).toBe('已加入练习集')
    expect(joined.attributes('disabled')).toBeDefined()

    const readd = w.get('[data-testid="accum-list-dictation-readd"]')
    expect(readd.text()).toBe('生成默写题，加入练习集')
    expect(readd.attributes('disabled')).toBeUndefined()

    const failed = w.get('[data-testid="accum-list-dictation-failed"]')
    expect(failed.text()).toBe('生成默写题，加入练习集')
    expect(failed.attributes('disabled')).toBeUndefined()

    const rows = w.findAll('.k12accum__row')
    for (const row of rows) {
      expect(row.find('.k12accum__status').exists()).toBe(false)
      expect(row.findAll('button').map((button) => button.text())).toHaveLength(2)
      expect(row.findAll('button')[1]!.text()).toBe('查看详情')
    }

    await readd.trigger('click')
    await failed.trigger('click')
    await flushPromises()
    expect(h.generateSpy).toHaveBeenCalledWith('mingming', 'readd')
    expect(h.generateSpy).toHaveBeenCalledWith('mingming', 'failed')
  })

  it('积累详情动作 exact-set 为复制、发送、生成默写题、删除，且只有头部 X 关闭', async () => {
    vi.useFakeTimers()
    h.listSpy.mockResolvedValue({
      items: [
        {
          record_id: 'x1',
          subject: '英语',
          entry_type: '好词好句',
          content: 'a piece of cake',
          version: 1,
        },
      ],
    })
    const child = {
      delivery_id: 'delivery-1',
      batch_id: 'batch-1',
      batch_ordinal: 0,
      agent_name: 'mingming',
      object_kind: 'accumulation',
      object_id: 'x1',
      binding_id: 'binding-1',
      target: { platform: 'feishu', chat_id: 'chat-1' },
      status: 'outcome_unknown',
      dedupe_key: 'child-1',
      payload_digest: 'sha256:payload',
      payload_json: '{}',
      render_manifest_json: '{}',
      attempt: 1,
      created_at: 1,
      updated_at: 1,
    }
    h.sendSpy.mockResolvedValue({
      batch_id: 'batch-1',
      agent_name: 'mingming',
      object_kind: 'accumulation',
      object_id: 'x1',
      dedupe_key: 'batch-1',
      content_digest: 'sha256:content',
      status: 'outcome_unknown',
      receipts: [child],
      created_at: 1,
      updated_at: 1,
    })
    h.querySpy.mockResolvedValue({
      batch_id: 'batch-1',
      agent_name: 'mingming',
      object_kind: 'accumulation',
      object_id: 'x1',
      dedupe_key: 'batch-1',
      content_digest: 'sha256:content',
      status: 'delivered',
      receipts: [{ ...child, status: 'delivered' }],
      created_at: 1,
      updated_at: 2,
    })

    const w = render()
    await flushPromises()
    await gotoAccum(w)
    await w.get('.k12accum__detail').trigger('click')
    await flushPromises()

    const modal = w.get('[data-testid="mistake-detail"]')
    expect(modal.findAll('.k12modal__head button')).toHaveLength(1)
    expect(modal.findAll('.k12detail__actions button').map((button) => button.text())).toEqual([
      '复制内容',
      '发送到手机',
      '生成默写题，加入练习集',
      '删除',
    ])
    expect(modal.text()).not.toContain('更正分类')
    expect(w.text()).not.toMatch(/选择.*(钉钉|飞书|接收人|发送目标)/)

    await w.get('[data-testid="accum-send-phone"]').trigger('click')
    await flushPromises()
    expect(h.sendSpy).toHaveBeenCalledWith('mingming', 'x1')
    expect(w.get('[data-testid="accum-send-phone"]').text()).toBe('发送中…')

    await vi.runOnlyPendingTimersAsync()
    await flushPromises()
    expect(h.querySpy).toHaveBeenCalledWith('mingming', 'batch-1')
    expect(w.get('[data-testid="accum-send-phone"]').text()).toBe('发送成功')
  })

  it('积累删除复用 5 秒 ConfirmDialog，并只在后端成功后移除当前投影', async () => {
    vi.useFakeTimers()
    let resolveDelete!: (value: {
      accumulation_id: string
      deleted: boolean
      version: number
    }) => void
    h.deleteSpy.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveDelete = resolve
      }),
    )
    h.listSpy.mockResolvedValue({
      items: [
        {
          record_id: 'x1',
          subject: '英语',
          entry_type: '表达积累',
          content: 'a piece of cake',
          version: 7,
        },
      ],
    })
    const w = render()
    await flushPromises()
    await gotoAccum(w)
    await w.get('.k12accum__detail').trigger('click')
    const detailCard = w.get<HTMLElement>('[data-testid="mistake-detail"] .k12modal__card')
    detailCard.element.scrollTop = 93
    const deleteButton = w.get<HTMLButtonElement>('[data-testid="accum-delete"]')
    expect(deleteButton.classes()).toContain('hc-btn-danger-ghost')
    deleteButton.element.focus()
    await deleteButton.trigger('click')
    await flushPromises()

    const dialog = document.body.querySelector('[role="alertdialog"]')
    expect(w.find('[data-testid="mistake-detail"]').exists()).toBe(false)
    expect(document.body.querySelectorAll('[aria-modal="true"]')).toHaveLength(1)
    expect(dialog?.textContent).toContain('删除这条积累？')
    expect(dialog?.textContent).toContain(
      '将从积累列表移除；已生成的练习题和发送记录仍保留。此操作不可撤销。',
    )
    const confirm = dialog?.querySelector('.hc-dialog__btn--danger') as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    expect(h.deleteSpy).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(5_000)
    confirm.click()
    await flushPromises()

    expect(h.deleteSpy).toHaveBeenCalledWith(
      'mingming',
      'x1',
      7,
      expect.stringMatching(/^desktop-accum-delete:mingming:x1:/),
    )
    expect(w.find('[data-testid="mistake-detail"]').exists()).toBe(false)

    resolveDelete({ accumulation_id: 'x1', deleted: true, version: 8 })
    await flushPromises()
    expect(w.find('[data-testid="mistake-detail"]').exists()).toBe(false)
    expect(h.listSpy.mock.calls.length).toBeGreaterThan(1)
    w.unmount()
  })

  it('积累删除取消与失败都恢复同一详情、滚动位置和删除入口焦点', async () => {
    vi.useFakeTimers()
    h.listSpy.mockResolvedValue({
      items: [
        {
          record_id: 'x1',
          subject: '英语',
          entry_type: '表达积累',
          content: 'a piece of cake',
          version: 7,
        },
      ],
    })
    const w = render()
    await flushPromises()
    await gotoAccum(w)
    await w.get('.k12accum__detail').trigger('click')
    let detailCard = w.get<HTMLElement>('[data-testid="mistake-detail"] .k12modal__card')
    detailCard.element.scrollTop = 64
    await w.get('[data-testid="accum-delete"]').trigger('click')
    await flushPromises()
    const cancel = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === '取消',
    ) as HTMLButtonElement
    cancel.click()
    await flushPromises()

    detailCard = w.get<HTMLElement>('[data-testid="mistake-detail"] .k12modal__card')
    expect(detailCard.element.scrollTop).toBe(64)
    expect(document.activeElement).toBe(
      w.get<HTMLButtonElement>('[data-testid="accum-delete"]').element,
    )

    h.deleteSpy.mockRejectedValueOnce(new Error('删除失败'))
    detailCard.element.scrollTop = 121
    await w.get('[data-testid="accum-delete"]').trigger('click')
    await vi.advanceTimersByTimeAsync(5_000)
    ;(document.body.querySelector('.hc-dialog__btn--danger') as HTMLButtonElement).click()
    await flushPromises()

    expect(w.find('[data-testid="mistake-detail"]').exists()).toBe(true)
    expect(
      w.get<HTMLElement>('[data-testid="mistake-detail"] .k12modal__card').element.scrollTop,
    ).toBe(121)
    expect(document.activeElement).toBe(
      w.get<HTMLButtonElement>('[data-testid="accum-delete"]').element,
    )
    expect(w.findAll('.k12accum__row')).toHaveLength(1)
    w.unmount()
  })
})
