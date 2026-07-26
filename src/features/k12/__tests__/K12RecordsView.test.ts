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
      status: 'new',
      version: 0,
      due_at: 1710000000,
    },
    {
      record_id: 'b',
      question: '解方程 2x+15=43',
      knowledge_point: '简易方程',
      error_cause: '移项符号错',
      status: 'new',
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
  ]
  return {
    mistakes,
    markMasteredSpy: vi.fn().mockResolvedValue({ ok: true }),
    recordMistakeSpy: vi.fn(),
    listMistakesSpy: vi.fn(),
    prepareWeeklySpy: vi.fn(),
  }
})
const markMasteredSpy = h.markMasteredSpy

vi.mock('@/api/k12', () => ({
  k12ListMistakes: (...args: unknown[]) => h.listMistakesSpy(...args),
  k12ReviewQueue: vi.fn().mockResolvedValue({ items: [h.mistakes[0]] }),
  k12MarkMastered: (req: unknown) => h.markMasteredSpy(req),
  k12GetMistakePracticeGeneration: vi
    .fn()
    .mockImplementation((_agent: string, recordID: string) =>
      Promise.resolve({ state: 'available', source_mistake_id: recordID }),
    ),
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
          ],
        },
        { plan_section: 'textbook_consolidation', status: 'disabled', items: [] },
        { plan_section: 'arithmetic_warmup', status: 'disabled', items: [] },
      ],
      created_at: '2026-07-20T00:00:00Z',
      updated_at: '2026-07-20T00:00:00Z',
    },
  }),
  k12GetWeeklyPracticeHistory: vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
  k12PrepareWeeklyPracticeOutput: (...args: unknown[]) => h.prepareWeeklySpy(...args),
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
      agentName: '小明的辅导老师',
      grade: '五年级上 · 人教版',
      ...props,
    },
    global: { plugins: [createPinia(), i18n()] },
  })
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
    h.prepareWeeklySpy.mockReset().mockResolvedValue({
      snapshot: {
        snapshot_id: 'snapshot-30',
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
    })
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

  it('生成本周该练只准备同源输出，不再强制切换到练习集', async () => {
    const w = render()
    await flushPromises()

    await w.get('[data-testid="prepare-weekly-output"]').trigger('click')
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
    expect(w.find('[data-testid="save-weekly-practice-set"]').exists()).toBe(true)
  })

  it('「家长确认已会」→ 调 mark-mastered 并带正确 record_id/version', async () => {
    const w = render()
    await flushPromises()
    // 本周该练禁止家长判断掌握；该档案动作只留在「全部错题」。
    await w
      .findAll('.seg button')
      .find((b) => b.text() === '全部错题')!
      .trigger('click')
    const masteredBtn = w.findAll('.rl-btn').find((b) => b.text() === '家长确认已会')!
    await masteredBtn.trigger('click')
    await flushPromises()
    expect(markMasteredSpy).toHaveBeenCalledWith({ agent: 'mingming', record_id: 'a', version: 0 })
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
    await w.find('.k12rec__export button').trigger('click')
    const backupBtn = w.findAll('.k12rec__menu button').find((b) => b.text().includes('备份'))
    expect(backupBtn, '⋯ 菜单应含备份/恢复').toBeTruthy()
    await backupBtn!.trigger('click')
    expect(w.emitted('open-backup')).toBeTruthy()
  })

  it('学习档案五个二级 Tab 的溢出菜单均提供三种导出与备份恢复', async () => {
    const w = render()
    await flushPromises()
    const tabs = ['本周该练', '全部错题', '练习集', '积累', '作品']
    const expected = ['导出 PDF', '导出 Word', '导出 Markdown', '备份 / 恢复']

    for (const tab of tabs) {
      await w
        .findAll('.seg button')
        .find((button) => button.text().includes(tab))!
        .trigger('click')
      const trigger = w.find('.k12rec__export > button')
      if (w.find('.k12rec__menu').exists()) await trigger.trigger('click')
      await trigger.trigger('click')
      const actions = w.findAll('.k12rec__menu button').map((button) => button.text())
      expect(actions).toEqual(expected)
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
