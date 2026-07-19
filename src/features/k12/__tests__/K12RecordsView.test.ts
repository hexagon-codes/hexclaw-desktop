import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import HcSelect from '@/components/common/HcSelect.vue'
import K12RecordsView from '../views/K12RecordsView.vue'
import K12InsightPanel from '../views/K12InsightPanel.vue'

const h = vi.hoisted(() => {
  const mistakes = [
    { record_id: 'a', question: '苹果和梨的价钱', knowledge_point: '小数乘法', error_cause: '计算失误·进位', status: 'new', version: 0, due_at: 1710000000 },
    { record_id: 'b', question: '解方程 2x+15=43', knowledge_point: '简易方程', error_cause: '移项符号错', status: 'new', version: 1, due_at: 1710000000 },
    { record_id: 'c', question: '梯形果园的面积', knowledge_point: '简易方程', error_cause: '公式记错', status: 'mastered', version: 2 },
  ]
  return {
    mistakes,
    markMasteredSpy: vi.fn().mockResolvedValue({ ok: true }),
    retrySpy: vi.fn().mockResolvedValue({ solution: '变式题：4.2×3=? 解：12.6', verdict: 'agree', badge: '✅ 已程序验算' }),
    recordMistakeSpy: vi.fn(),
  }
})
const markMasteredSpy = h.markMasteredSpy

vi.mock('@/api/k12', () => ({
  k12ListMistakes: vi.fn().mockResolvedValue({ items: h.mistakes }),
  k12ReviewQueue: vi.fn().mockResolvedValue({ items: [h.mistakes[0]] }),
  k12MarkMastered: (req: unknown) => h.markMasteredSpy(req),
  k12ReviewRetry: (req: unknown) => h.retrySpy(req),
  k12PrepCard: vi.fn(),
  k12Grade: vi.fn(),
  k12RecordMistake: (req: unknown) => h.recordMistakeSpy(req),
  k12InsightReport: vi.fn().mockResolvedValue({
    trend: { mastered: 5, reviewing: 2, retried: 1, archived: 0, total: 8 },
    weak_top3: [{ knowledge_point: '简易方程', count: 2 }, { knowledge_point: '小数乘法', count: 1 }],
    month_new_mistakes: 9,
    review_completion_rate: 0.78,
    consecutive_fail_kps: ['简易方程'],
    suggestion: '「简易方程」连续受挫，建议本周集中复习。',
  }),
  k12StudyTime: vi.fn().mockResolvedValue({
    days: [{ date: '2026-07-07', record_count: 3, estimated_minutes: 45 }],
    total_records: 3, total_minutes: 45, note: '近似值',
  }),
  k12ListAccumulation: vi.fn().mockResolvedValue({ items: [] }),
  // 20260718 学情第四瓷片改练习集待打印：InsightPanel 自拉 draft 篮
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

function render() {
  return mount(K12RecordsView, {
    props: { agentId: 'mingming', agentName: '小明的辅导老师', grade: '五年级上 · 人教版' },
    global: { plugins: [createPinia(), i18n()] },
  })
}

describe('K12RecordsView（M1-6 记录 + M3-6 复习 + M3-7 学情）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    markMasteredSpy.mockClear()
    h.recordMistakeSpy.mockReset().mockResolvedValue({ record_created: true, record_id: 'manual-cn-1', error_cause: '记错下一句' })
  })

  it('挂载即拉取错题本，按 schema 渲染错题 + 复习队列', async () => {
    const w = render()
    await flushPromises()
    expect(w.text()).toContain('苹果和梨的价钱')
    expect(w.text()).toContain('小数乘法')
    // 复习队列（due 列表含 record a）
    expect(w.find('.rl-review').exists()).toBe(true)
    expect(w.text()).toContain('本周复习')
  })

  it('「家长确认已会」→ 调 mark-mastered 并带正确 record_id/version', async () => {
    const w = render()
    await flushPromises()
    // 复习队列第一行的按钮（20260718 §4.11 信任链纠偏：家长确认 ≠ 系统已掌握，文案「家长确认已会」）
    const masteredBtn = w.findAll('.rl-btn').find((b) => b.text() === '家长确认已会')!
    await masteredBtn.trigger('click')
    await flushPromises()
    expect(markMasteredSpy).toHaveBeenCalledWith({ agent: 'mingming', record_id: 'a', version: 0 })
  })

  it('「再练一道」→ 守答案真遮罩：答案默认遮住，点「显示答案」才揭示（20260709 信任兑现）', async () => {
    const w = render()
    await flushPromises()
    await w.findAll('.rl-btn').find((b) => b.text() === '再练一道')!.trigger('click')
    await flushPromises()
    // 弹层出现且默认遮罩（bodywrap 带 masked 类 + 揭示按钮在）
    expect(w.find('.k12retry').exists()).toBe(true)
    expect(w.find('.k12retry__bodywrap--masked').exists()).toBe(true)
    const reveal = w.find('[data-testid="retry-reveal"]')
    expect(reveal.exists()).toBe(true)
    await reveal.trigger('click')
    // 揭示后遮罩解除、答案可见
    expect(w.find('.k12retry__bodywrap--masked').exists()).toBe(false)
    expect(w.text()).toContain('12.6')
  })

  it('手录错题走轻量 record-mistake 端点（非 grade 验算链），透传家长选的非默认学科', async () => {
    const w = render()
    await flushPromises()
    // IA 迁移（2026-07-18）：记一条错题=「全部错题」档案页主操作，先切 Tab
    await w.findAll('.seg button').find((b) => b.text() === '全部错题')!.trigger('click')
    await w.find('[data-testid="mistake-add-open"]').trigger('click')

    const subjectField = w.find('[data-testid="mistake-subject"]')
    expect(subjectField.exists(), '手录错题必须提供学科选择').toBe(true)
    subjectField.findComponent(HcSelect).vm.$emit('update:modelValue', '语文')
    await w.find('[data-testid="mistake-problem"]').setValue('“床前明月光”的下一句')
    await w.find('[data-testid="mistake-submit"]').trigger('click')
    await flushPromises()

    // 治本：记一条错题=已知错题轻量直录，走 record-mistake（秒级）而非 grade 对抗验算链（1-2 分钟）。
    expect(h.recordMistakeSpy).toHaveBeenCalledWith(expect.objectContaining({
      agent: 'mingming',
      subject: '语文',
      problem: '“床前明月光”的下一句',
    }))
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
    const tabs = ['本周复习', '全部错题', '练习集', '积累', '作品']
    const expected = ['导出 PDF', '导出 Word', '导出 Markdown', '备份 / 恢复']

    for (const tab of tabs) {
      await w.findAll('.seg button').find((button) => button.text().includes(tab))!.trigger('click')
      const trigger = w.find('.k12rec__export > button')
      if (w.find('.k12rec__menu').exists()) await trigger.trigger('click')
      await trigger.trigger('click')
      const actions = w.findAll('.k12rec__menu button').map((button) => button.text())
      expect(actions).toEqual(expect.arrayContaining(expected))
    }
  })

  it('学情（顶栏一等 Tab · K12InsightPanel）：真实 insight-report 驱动（薄弱 TOP3 + 连续挫败 + 建议）', async () => {
    // IA 迁移（2026-07-18）：学情从 RecordsView 二级 Tab 抽到 K12InsightPanel（顶栏一等）
    const w = mount(K12InsightPanel, { props: { agentId: 'mingming' }, global: { plugins: [createPinia(), i18n()] } })
    await flushPromises()
    expect(w.text()).toContain('薄弱知识点 TOP3')
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
    await w.findAll('.seg button').find((b) => b.text() === '积累')!.trigger('click')
    // 项-5：裸文字悬空换成等款空态卡（📖 + 暖文案 + CTA）
    expect(w.find('[data-testid="accum-empty-card"]').exists()).toBe(true)
    expect(w.text()).toContain('积累本还空着')
  })
})
