import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import HcSelect from '@/components/common/HcSelect.vue'
import { k12EnsureWeeklyPracticePlan } from '@/api/k12'
import K12WeeklyPracticePanel from '../components/K12WeeklyPracticePanel.vue'
import K12RecordsView from '../views/K12RecordsView.vue'
import K12InsightPanel from '../views/K12InsightPanel.vue'

const h = vi.hoisted(() => {
  const mistakes = [
    {
      record_id: 'a',
      question: '苹果和梨的价钱',
      knowledge_point: '小数乘法',
      error_cause: '计算失误·进位',
      status: 'scheduled',
      review_state: 'scheduled',
      version: 0,
      due_at: 1710000000,
    },
    {
      record_id: 'b',
      question: '解方程 2x+15=43',
      knowledge_point: '简易方程',
      error_cause: '移项符号错',
      status: 'scheduled',
      review_state: 'scheduled',
      version: 1,
      due_at: 1710000000,
    },
    {
      record_id: 'c',
      question: '梯形果园的面积',
      knowledge_point: '简易方程',
      error_cause: '公式记错',
      status: 'mastered',
      version: 2,
    },
    {
      record_id: 'm-poem',
      question: '「梅须逊雪三分白」漏「须」字',
      knowledge_point: '古诗默写',
      error_cause: '漏写“须”字',
      status: 'scheduled',
      review_state: 'scheduled',
      version: 3,
      due_at: 1710000000,
    },
  ]
  return {
    mistakes,
    markMasteredSpy: vi.fn().mockResolvedValue({ ok: true }),
    recordMistakeSpy: vi.fn(),
    listMistakesSpy: vi.fn(),
    prepareWeeklySpy: vi.fn(),
    getWeeklyHistorySpy: vi.fn(),
    getWeeklySnapshotSpy: vi.fn(),
    sendWeeklySpy: vi.fn(),
    getDeliveryBatchSpy: vi.fn(),
    queryDeliveryBatchSpy: vi.fn(),
    retryDeliveryBatchSpy: vi.fn(),
    getPracticeGenerationSpy: vi.fn(),
    retryPracticeGenerationSpy: vi.fn(),
  }
})
const markMasteredSpy = h.markMasteredSpy

vi.mock('@/api/k12', async () => ({
  ...(await import('./weekly-practice-api-mock')).weeklyPracticeApiMockDefaults('mingming'),
  k12ListMistakes: (...args: unknown[]) => h.listMistakesSpy(...args),
  k12ReviewQueue: vi.fn().mockResolvedValue({ items: [h.mistakes[0]] }),
  k12MarkMastered: (req: unknown) => h.markMasteredSpy(req),
  k12GetMistakePracticeGeneration: (...args: unknown[]) => h.getPracticeGenerationSpy(...args),
  k12RetryMistakePracticeGeneration: (...args: unknown[]) =>
    h.retryPracticeGenerationSpy(...args),
  k12TutoringTips: vi.fn(),
  k12Grade: vi.fn(),
  k12RecordMistake: (req: unknown) => h.recordMistakeSpy(req),
  k12InsightReport: vi.fn().mockResolvedValue({
    learner_id: 'mingming',
    grade_term: '五年级上',
    as_of: '2026-07-25T08:00:00+08:00',
    source_digest: 'sha256:records-view',
    source_record_ids: ['a', 'b', 'c'],
    unscoped_source_count: 0,
    review_week_start: '2026-07-24T19:00:00+08:00',
    review_week_end: '2026-07-31T19:00:00+08:00',
    trend: { mastered: 5, reviewing: 2, retried: 1, archived: 0, total: 8 },
    weak_top3: [
      { knowledge_point: '简易方程', subject: '数学', count: 2, share: 2 / 9 },
      { knowledge_point: '小数乘法', subject: '数学', count: 1, share: 1 / 9 },
    ],
    month_new_mistakes: 9,
    review_completion_rate: 0.78,
    consecutive_fail_kps: ['简易方程'],
    suggestion: '「简易方程」连续受挫，建议本周集中复习。',
    week_pending: 1,
    practice_pending: 0,
  }),
  k12StudyTime: vi.fn().mockResolvedValue({
    days: [{ date: '2026-07-07', record_count: 3, estimated_minutes: 45 }],
    total_records: 3,
    total_minutes: 45,
    note: '近似值',
  }),
  k12ListAccumulation: vi.fn().mockResolvedValue({ items: [] }),
  k12GetCurriculumProgress: vi.fn().mockResolvedValue({ progress: null }),
  k12GetWeeklyPracticeSettings: vi.fn().mockResolvedValue({
    agent: 'mingming',
    revision: 0,
    timezone: 'Asia/Shanghai',
    due_review_enabled: true,
    textbook_consolidation_enabled: false,
    arithmetic_warmup_enabled: false,
    arithmetic_minutes: 2,
    created_at: '2026-07-20T00:00:00Z',
    updated_at: '2026-07-20T00:00:00Z',
  }),
  k12EnsureWeeklyPracticePlan: vi.fn().mockResolvedValue({
    replayed: false,
    plan: {
      plan_id: 'weekly-30',
      agent: 'mingming',
      revision: 1,
      iso_week_year: 2026,
      iso_week_number: 30,
      timezone: 'Asia/Shanghai',
      week_start: '2026-07-20T00:00:00+08:00',
      week_end: '2026-07-26T23:59:59+08:00',
      local_start_date: '2026-07-20',
      local_end_date: '2026-07-26',
      status: 'draft',
      settings_revision: 0,
      tracks: [
        {
          plan_section: 'due_review',
          status: 'ready',
          items: [
            {
              item_id: 'due-a',
              position: 1,
              plan_section: 'due_review',
              source_kind: 'mistake',
              generation_method: 'original',
              source_ref: 'a',
              verification: {
                status: 'verified',
                evidence_refs: ['小数乘法'],
              },
              prompt_markdown: '苹果和梨的价钱',
            },
            {
              item_id: 'due-m-poem',
              position: 2,
              plan_section: 'due_review',
              source_kind: 'mistake',
              generation_method: 'original',
              source_ref: 'm-poem',
              verification: {
                status: 'verified',
                evidence_refs: ['古诗默写'],
              },
              prompt_markdown: '「梅须逊雪三分白」漏「须」字',
            },
          ],
        },
        { plan_section: 'textbook_consolidation', status: 'disabled', items: [] },
        { plan_section: 'arithmetic_warmup', status: 'disabled', items: [] },
      ],
      created_at: '2026-07-20T00:00:00Z',
      updated_at: '2026-07-20T00:00:00Z',
    },
  }),
  k12GetWeeklyPracticeHistory: (...args: unknown[]) => h.getWeeklyHistorySpy(...args),
  k12GetWeeklyPracticeSnapshot: (...args: unknown[]) => h.getWeeklySnapshotSpy(...args),
  k12PrepareWeeklyPracticeOutput: (...args: unknown[]) => h.prepareWeeklySpy(...args),
  k12SendWeeklyPracticeSnapshot: (...args: unknown[]) => h.sendWeeklySpy(...args),
  k12GetDeliveryBatch: (...args: unknown[]) => h.getDeliveryBatchSpy(...args),
  k12QueryDeliveryBatch: (...args: unknown[]) => h.queryDeliveryBatchSpy(...args),
  k12RetryDeliveryBatch: (...args: unknown[]) => h.retryDeliveryBatchSpy(...args),
  // 其他档案页仍使用练习集列表；InsightPanel 只消费同一份报告快照。
  k12ListPracticeSets: vi.fn().mockResolvedValue({ items: [] }),
}))

function i18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: zhCN },
  })
}

function render(props: Record<string, unknown> = {}) {
  return mount(K12RecordsView, {
    props: {
      agentId: 'mingming',
      agentName: '小明的辅导助手',
      grade: '五年级上 · 人教版',
      ...props,
    },
    global: { plugins: [createPinia(), i18n()] },
  })
}

function preparedWeeklyOutput() {
  return {
    snapshot: {
      snapshot_id: 'snapshot-30',
      artifact_id: 'artifact-30',
      plan_id: 'weekly-30',
      plan_revision: 1,
      agent: 'mingming',
      iso_week_year: 2026,
      iso_week_number: 30,
      timezone: 'Asia/Shanghai',
      week_start: '2026-07-20T00:00:00+08:00',
      week_end: '2026-07-26T23:59:59+08:00',
      local_start_date: '2026-07-20',
      local_end_date: '2026-07-26',
      settings_revision: 0,
      tracks: [],
      render_version: 'weekly-v1',
      snapshot_digest: 'sha256:snapshot',
      created_at: '2026-07-20T00:00:00Z',
    },
    artifact: {
      artifact_id: 'artifact-30',
      source_kind: 'weekly_practice_snapshot',
      source_ref: 'snapshot-30',
      title: '本周该练',
      source_digest: 'sha256:snapshot',
      format: 'pdf',
      render_contract_version: 'practice-print-v1',
      content_type: 'application/pdf',
      byte_digest: 'sha256:pdf',
      byte_size: 128,
    },
  }
}

function emptyWeeklyPlan() {
  return {
    replayed: false,
    plan: {
      plan_id: 'weekly-30',
      agent: 'mingming',
      revision: 1,
      iso_week_year: 2026,
      iso_week_number: 30,
      timezone: 'Asia/Shanghai',
      week_start: '2026-07-20T00:00:00+08:00',
      week_end: '2026-07-26T23:59:59+08:00',
      local_start_date: '2026-07-20',
      local_end_date: '2026-07-26',
      status: 'draft',
      settings_revision: 0,
      tracks: [
        { plan_section: 'due_review', status: 'ready', items: [] },
        { plan_section: 'textbook_consolidation', status: 'disabled', items: [] },
        { plan_section: 'arithmetic_warmup', status: 'disabled', items: [] },
      ],
      created_at: '2026-07-20T00:00:00Z',
      updated_at: '2026-07-20T00:00:00Z',
    },
  }
}

describe('K12RecordsView（M1-6 记录 + M3-6 复习 + M3-7 学情）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    markMasteredSpy.mockClear()
    h.listMistakesSpy.mockReset().mockResolvedValue({ items: h.mistakes })
    h.recordMistakeSpy.mockReset().mockResolvedValue({
      record_created: true,
      record_id: 'manual-cn-1',
      error_cause: '记错下一句',
    })
    vi.mocked(k12EnsureWeeklyPracticePlan).mockClear()
    h.getWeeklyHistorySpy.mockReset().mockResolvedValue({ items: [], next_cursor: null })
    h.getWeeklySnapshotSpy.mockReset()
    h.prepareWeeklySpy.mockReset().mockResolvedValue(preparedWeeklyOutput())
    h.sendWeeklySpy.mockReset().mockResolvedValue({
      batch_id: 'weekly-delivery-1',
      status: 'delivered',
    })
    h.getDeliveryBatchSpy.mockReset()
    h.queryDeliveryBatchSpy.mockReset()
    h.retryDeliveryBatchSpy.mockReset()
    h.getPracticeGenerationSpy
      .mockReset()
      .mockImplementation((_agent: string, recordID: string) =>
        Promise.resolve({ state: 'available', source_mistake_id: recordID }),
      )
    h.retryPracticeGenerationSpy.mockReset().mockImplementation((_agent: string, recordID: string) =>
      Promise.resolve({ state: 'pending', source_mistake_id: recordID }),
    )
  })

  it('[BUG-20260727-007] failed practice generation projects one retry command in weekly and all mistakes', async () => {
    h.getPracticeGenerationSpy.mockImplementation((_agent: string, recordID: string) =>
      Promise.resolve({
        state: recordID === 'm-poem' ? 'failed' : 'available',
        source_mistake_id: recordID,
      }),
    )
    h.retryPracticeGenerationSpy.mockResolvedValue({
      state: 'failed',
      source_mistake_id: 'm-poem',
    })

    const w = render()
    await flushPromises()

    const weeklyRetry = w.get('[data-testid="weekly-practice-m-poem"]')
    expect(weeklyRetry.text()).toBe('出题失败 · 重试')
    await weeklyRetry.trigger('click')
    await flushPromises()
    expect(h.retryPracticeGenerationSpy).toHaveBeenCalledTimes(1)
    expect(h.retryPracticeGenerationSpy).toHaveBeenNthCalledWith(1, 'mingming', 'm-poem')

    await w.get('[data-testid="subtab-mistakes"]').trigger('click')
    const recordsRetry = w.get('[data-testid="mistake-practice-m-poem"]')
    expect(recordsRetry.text()).toBe('出题失败 · 重试')

    await recordsRetry.trigger('click')
    await flushPromises()
    expect(h.retryPracticeGenerationSpy).toHaveBeenCalledTimes(2)
    expect(h.retryPracticeGenerationSpy).toHaveBeenNthCalledWith(2, 'mingming', 'm-poem')
  })

  it('reuses the plan command key across retry and rotates it only after success', async () => {
    const ensurePlan = vi.mocked(k12EnsureWeeklyPracticePlan)
    ensurePlan.mockRejectedValueOnce(new Error('temporary weekly-plan failure'))

    const w = render()
    await flushPromises()
    const panel = w.findComponent(K12WeeklyPracticePanel)

    panel.vm.$emit('retry')
    await flushPromises()

    expect(ensurePlan).toHaveBeenCalledTimes(2)
    expect(ensurePlan.mock.calls[1]?.[1]).toBe(ensurePlan.mock.calls[0]?.[1])

    panel.vm.$emit('retry')
    await flushPromises()

    expect(ensurePlan).toHaveBeenCalledTimes(3)
    expect(ensurePlan.mock.calls[2]?.[1]).not.toBe(ensurePlan.mock.calls[1]?.[1])
  })

  it('挂载即拉取错题本，按 schema 渲染错题 + 复习队列', async () => {
    const w = render()
    await flushPromises()
    expect(w.text()).toContain('苹果和梨的价钱')
    expect(w.text()).toContain('小数乘法')
    // 本周该练的到期复习轨来自唯一周计划（due 列表含 record a）
    expect(w.find('[data-track="due_review"]').exists()).toBe(true)
    expect(w.text()).toContain('本周该练')
  })

  it('从辅导切入学习档案时重新拉取，不能停留在进入会话时的旧缓存', async () => {
    const w = render({ active: false })
    await flushPromises()
    expect(h.listMistakesSpy).toHaveBeenCalledTimes(1)

    await w.setProps({ active: true })
    await flushPromises()

    expect(h.listMistakesSpy).toHaveBeenCalledTimes(2)
  })

  it('直接产物动作按需准备同源输出，不强制切换到练习集', async () => {
    const w = render()
    await flushPromises()

    await w.get('[data-testid="final-artifact-actions"]').findAll('button')[0]!.trigger('click')
    await flushPromises()

    expect(h.prepareWeeklySpy).toHaveBeenCalledTimes(1)
    expect(h.prepareWeeklySpy).toHaveBeenCalledWith(
      'mingming',
      'weekly-30',
      1,
      'desktop-weekly-prepare:mingming:weekly-30:1',
    )
    expect(w.get('[data-testid="subtab-week"]').classes()).toContain('on')
    expect(w.get('[data-testid="subtab-practicesets"]').classes()).not.toContain('on')
    expect(w.find('[data-testid="prepare-weekly-output"]').exists()).toBe(false)
    expect(
      w.get('[data-testid="final-artifact-actions"]').findAll('button').map((button) =>
        button.text(),
      ),
    ).toEqual(['打印', '发送到手机'])
    expect(w.find('[data-testid="weekly-more-trigger"]').exists()).toBe(false)
  })

  it('[K12-WEEKLY-044] keeps history on its frozen snapshot/artifact and never prepares a current task', async () => {
    const historyItem = Object.freeze({
      snapshot_id: 'snapshot-29',
      artifact_id: 'artifact-29',
      plan_id: 'weekly-29',
      iso_week_year: 2026,
      iso_week_number: 29,
      timezone: 'Asia/Shanghai',
      local_start_date: '2026-07-13',
      local_end_date: '2026-07-19',
      item_count: 8,
      correct_count: 7,
      wrong_count: 1,
      needs_review_count: 0,
      archived_at: '2026-07-20T00:00:00+08:00',
    })
    const frozenSnapshot = Object.freeze({
      snapshot_id: 'snapshot-29',
      artifact_id: 'artifact-29',
      plan_id: 'weekly-29',
      plan_revision: 4,
      agent: 'mingming',
      iso_week_year: 2026,
      iso_week_number: 29,
      timezone: 'Asia/Shanghai',
      week_start: '2026-07-13T00:00:00+08:00',
      week_end: '2026-07-19T23:59:59+08:00',
      local_start_date: '2026-07-13',
      local_end_date: '2026-07-19',
      settings_revision: 0,
      tracks: [],
      render_version: 'weekly-v1',
      snapshot_digest: 'sha256:frozen-history-29',
      created_at: '2026-07-20T00:00:00+08:00',
    })
    h.getWeeklyHistorySpy.mockResolvedValue({ items: [historyItem], next_cursor: null })
    h.getWeeklySnapshotSpy.mockResolvedValue(frozenSnapshot)

    const w = render()
    await flushPromises()
    expect(w.find('[data-testid="final-artifact-actions"]').exists()).toBe(true)
    expect(w.find('[data-testid="weekly-more-trigger"]').exists()).toBe(false)

    const panel = w.findComponent(K12WeeklyPracticePanel)
    await panel
      .findAll('[role="tab"]')
      .find((tab) => tab.text() === '历史')!
      .trigger('click')

    expect(w.find('[data-testid="final-artifact-actions"]').exists()).toBe(false)
    expect(w.find('[data-testid="weekly-more-trigger"]').exists()).toBe(false)
    expect(panel.findAll('.weekly-history__card button').map((button) => button.text())).toEqual([
      '查看周练',
    ])

    await panel.get('.weekly-history__card button').trigger('click')
    await flushPromises()

    expect(h.getWeeklySnapshotSpy).toHaveBeenCalledWith('mingming', 'snapshot-29')
    expect(panel.props('historySnapshot')).toBe(frozenSnapshot)
    expect((panel.props('historySnapshot') as typeof frozenSnapshot).snapshot_digest).toBe(
      'sha256:frozen-history-29',
    )

    panel.vm.$emit('history-artifact-action', {
      action: 'send_im',
      snapshot_id: 'snapshot-29',
      artifact_id: 'artifact-29',
    })
    await flushPromises()

    expect(h.sendWeeklySpy).toHaveBeenCalledWith(
      'mingming',
      'snapshot-29',
      'desktop-weekly-history-send:mingming:snapshot-29',
    )
    expect(h.prepareWeeklySpy).not.toHaveBeenCalled()
    expect(frozenSnapshot.snapshot_digest).toBe('sha256:frozen-history-29')

    await panel
      .findAll('[role="tab"]')
      .find((tab) => tab.text() === '本周')!
      .trigger('click')
    expect(w.find('[data-testid="final-artifact-actions"]').exists()).toBe(true)
    expect(w.find('[data-testid="weekly-more-trigger"]').exists()).toBe(false)
  })

  it('[K12-WEEKLY-046] zero items and an in-flight output reject duplicate boundary calls', async () => {
    vi.mocked(k12EnsureWeeklyPracticePlan).mockResolvedValueOnce(emptyWeeklyPlan() as any)
    const empty = render()
    await flushPromises()

    const emptyActions = empty.get('[data-testid="final-artifact-actions"]')
    expect(emptyActions.get('[role="status"]').text()).toBe('当前没有可输出的题目')
    for (const button of emptyActions.findAll('button')) {
      expect(button.attributes('disabled')).toBeDefined()
      await button.trigger('click')
    }
    expect(h.prepareWeeklySpy).not.toHaveBeenCalled()
    expect(h.sendWeeklySpy).not.toHaveBeenCalled()
    expect(h.getDeliveryBatchSpy).not.toHaveBeenCalled()
    expect(h.queryDeliveryBatchSpy).not.toHaveBeenCalled()
    expect(h.retryDeliveryBatchSpy).not.toHaveBeenCalled()
    empty.unmount()

    let releaseOutput!: (output: ReturnType<typeof preparedWeeklyOutput>) => void
    h.prepareWeeklySpy.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseOutput = resolve
        }),
    )
    const busy = render()
    await flushPromises()
    const busyActions = busy.get('[data-testid="final-artifact-actions"]')
    await busyActions.findAll('button')[1]!.trigger('click')

    expect(busyActions.get('[role="status"]').text()).toBe('正在处理本周计划…')
    expect(busyActions.findAll('button').every((button) => button.attributes('disabled') !== undefined))
      .toBe(true)
    for (const button of busyActions.findAll('button')) await button.trigger('click')
    expect(h.prepareWeeklySpy).toHaveBeenCalledTimes(1)
    expect(h.sendWeeklySpy).not.toHaveBeenCalled()

    releaseOutput(preparedWeeklyOutput())
    await flushPromises()
    expect(h.sendWeeklySpy).toHaveBeenCalledTimes(1)
  })

  it('[K12-WEEKLY-046] refresh replays stable prepare/send identities without a second delivery batch', async () => {
    const prepareKeys = new Set<string>()
    const sendKeys = new Set<string>()
    const createdBatchIDs = new Set<string>()
    h.prepareWeeklySpy.mockImplementation(
      async (_agent: string, _plan: string, _revision: number, key: string) => {
        prepareKeys.add(key)
        return preparedWeeklyOutput()
      },
    )
    h.sendWeeklySpy.mockImplementation(
      async (_agent: string, _snapshot: string, key: string) => {
        sendKeys.add(key)
        createdBatchIDs.add('weekly-delivery-1')
        return { batch_id: 'weekly-delivery-1', status: 'delivered' }
      },
    )

    const first = render()
    await flushPromises()
    await first
      .get('[data-testid="final-artifact-actions"]')
      .findAll('button')[1]!
      .trigger('click')
    await flushPromises()
    expect(first.get('[data-testid="final-artifact-actions"]').text()).toContain('发送成功')
    first.unmount()

    const refreshed = render()
    await flushPromises()
    await refreshed
      .get('[data-testid="final-artifact-actions"]')
      .findAll('button')[1]!
      .trigger('click')
    await flushPromises()

    expect(h.prepareWeeklySpy).toHaveBeenCalledTimes(2)
    expect(h.sendWeeklySpy).toHaveBeenCalledTimes(2)
    expect(prepareKeys).toEqual(
      new Set(['desktop-weekly-prepare:mingming:weekly-30:1']),
    )
    expect(sendKeys).toEqual(
      new Set(['desktop-weekly-send:mingming:snapshot-30']),
    )
    expect(createdBatchIDs).toEqual(new Set(['weekly-delivery-1']))
    expect(h.queryDeliveryBatchSpy).not.toHaveBeenCalled()
    expect(h.retryDeliveryBatchSpy).not.toHaveBeenCalled()
  })

  it('全部错题不提供家长主观改掌握，mastered 只由真实作答证据产生', async () => {
    const w = render()
    await flushPromises()
    await w.get('[data-testid="subtab-mistakes"]').trigger('click')

    expect(w.findAll('.rl-btn').some((button) => button.text() === '家长确认已会')).toBe(false)
    expect(w.find('[data-testid="detail-mark-mastered"]').exists()).toBe(false)
    expect(markMasteredSpy).not.toHaveBeenCalled()
  })

  it('手录错题走轻量 record-mistake 端点（非 grade 验算链），透传家长选的非默认学科', async () => {
    const w = render()
    await flushPromises()
    // IA 迁移（2026-07-18）：记一条错题=「全部错题」档案页主操作，先切 Tab
    await w
      .findAll('.seg button')
      .find((b) => b.text() === '全部错题')!
      .trigger('click')
    await w.find('[data-testid="mistake-add-open"]').trigger('click')

    const subjectField = w.find('[data-testid="mistake-subject"]')
    expect(subjectField.exists(), '手录错题必须提供学科选择').toBe(true)
    subjectField.findComponent(HcSelect).vm.$emit('update:modelValue', '语文')
    await w.find('[data-testid="mistake-problem"]').setValue('“床前明月光”的下一句')
    await w.find('[data-testid="mistake-submit"]').trigger('click')
    await flushPromises()

    // 治本：记一条错题=已知错题轻量直录，走 record-mistake（秒级）而非 grade 对抗验算链（1-2 分钟）。
    expect(h.recordMistakeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'mingming',
        subject: '语文',
        problem: '“床前明月光”的下一句',
      }),
    )
  })

  it('「⋯」溢出菜单：备份/恢复收进菜单（不占常驻顶栏），点击外发 open-backup', async () => {
    const w = render()
    await flushPromises()
    await w
      .findAll('.seg button')
      .find((button) => button.text().includes('全部错题'))!
      .trigger('click')
    await w.find('.k12rec__export button').trigger('click')
    const backupBtn = w.findAll('.k12rec__menu button').find((b) => b.text().includes('备份'))
    expect(backupBtn, '⋯ 菜单应含备份/恢复').toBeTruthy()
    await backupBtn!.trigger('click')
    expect(w.emitted('open-backup')).toBeTruthy()
  })

  it('本周该练只提供打印与发送，其他四个学习档案 Tab 提供通用导出与备份恢复', async () => {
    const w = render()
    await flushPromises()
    expect(
      w.get('[data-testid="final-artifact-actions"]').findAll('button').map((button) =>
        button.text(),
      ),
    ).toEqual(['打印', '发送到手机'])
    expect(w.find('[data-testid="weekly-more-trigger"]').exists()).toBe(false)
    expect(w.find('[data-testid="records-more-trigger"]').exists()).toBe(false)

    const tabs = ['全部错题', '练习集', '积累', '作品']
    const expectedByTab = {
      全部错题: ['导出 PDF', '导出 Word', '导出 Markdown', '备份 / 恢复'],
      练习集: ['导出 PDF', '导出 Word', '导出 Markdown', '备份 / 恢复'],
      积累: ['导出 PDF', '导出 Word', '导出 Markdown', '备份 / 恢复'],
      作品: ['导出 PDF', '导出 Word', '导出 Markdown', '备份 / 恢复'],
    }

    for (const tab of tabs) {
      await w
        .findAll('.seg button')
        .find((button) => button.text().includes(tab))!
        .trigger('click')
      const trigger = w.find('.k12rec__export > button')
      if (w.find('.k12rec__menu').exists()) await trigger.trigger('click')
      await trigger.trigger('click')
      const actions = w.findAll('.k12rec__menu button').map((button) => button.text())
      expect(actions).toEqual(expectedByTab[tab as keyof typeof expectedByTab])
    }
  })

  it('学情（顶栏一等 Tab · K12InsightPanel）：真实 insight-report 驱动（薄弱 TOP3 + 连续挫败 + 建议）', async () => {
    // IA 迁移（2026-07-18）：学情从 RecordsView 二级 Tab 抽到 K12InsightPanel（顶栏一等）
    const w = mount(K12InsightPanel, {
      props: { agentId: 'mingming' },
      global: { plugins: [createPinia(), i18n()] },
    })
    await flushPromises()
    expect(w.text()).toContain('需要优先处理')
    // 薄弱 bar 来自后端 weak_top3
    const bars = w.findAll('.k12ins__bar')
    expect(bars[0]!.text()).toContain('简易方程')
    expect(bars[0]!.text()).toContain('2')
    // 连续挫败 + 本月建议（后端派生）
    expect(w.text()).toContain('连续挫败')
    expect(w.text()).toContain('集中复习')
    // 20260709：学习时长模块已删除——学情不再展示按日时长（口径不可信/诱导考核）。
    expect(w.text()).not.toContain('2026-07-07')
  })

  it('积累 tab：无后端 → 正向空态卡（项-5）', async () => {
    const w = render()
    await flushPromises()
    await w
      .findAll('.seg button')
      .find((b) => b.text() === '积累')!
      .trigger('click')
    // 项-5：裸文字悬空换成等款空态卡（📖 + 暖文案 + CTA）
    expect(w.find('[data-testid="accum-empty-card"]').exists()).toBe(true)
    expect(w.text()).toContain('积累本还空着')
  })
})
