/**
 * BUG-20260709（装机反馈两连）：
 *
 * A.「记一条错题」点开是**手风琴内联表单**，原型 c8a194e `openAddMistake()`/`openCustomPaper()`
 *    均为 **modal 弹窗**（L2 关键交互，原型权威）。同构位置穷举：记一条错题 + 自定义组卷两处
 *    都是原型 modal、桌面内联；积累本「记一条」原型无该入口（桌面自加 PRD §3.13），白名单豁免。
 *
 * B.「验算并记入」按钮 hover 白底白字看不见：K12RecordsView scoped 里
 *    `.btn:hover { background: var(--hc-bg-hover) }`（0,2,0）压过 `.btn-primary`（0,1,0）的
 *    渐变背景，color:#fff 不变 → 浅色主题 hover = 近白底白字。原型有配对
 *    `.btn-primary:hover`（app.html:158 更亮渐变），桌面漏移植。CSS 伪类 jsdom 不可计算，
 *    用源码级守卫锁：凡同文件定义 `.btn:hover` 改背景 + `.btn-primary` 的，必须配对
 *    `.btn-primary:hover` 声明背景（粒度=逐文件穷举 k12 views）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import K12RecordsView from '../views/K12RecordsView.vue'

vi.mock('@/api/k12', () => ({
  k12ListMistakes: vi.fn().mockResolvedValue({
    items: [
      {
        record_id: 'a',
        question: '苹果和梨的价钱',
        knowledge_point: '小数乘法',
        error_cause: '进位',
        status: 'new',
        version: 0,
        due_at: 1,
      },
    ],
  }),
  // 队列非空 → review 行动卡渲染（「自定义组卷」按钮在其中）
  k12ReviewQueue: vi.fn().mockResolvedValue({
    items: [
      {
        record_id: 'a',
        question: '苹果和梨的价钱',
        knowledge_point: '小数乘法',
        error_cause: '进位',
        status: 'new',
        version: 0,
        due_at: 1,
      },
    ],
  }),
  k12MarkMastered: vi.fn(),
  k12ReviewRetry: vi.fn(),
  k12PrepCard: vi.fn(),
  k12Grade: vi.fn().mockResolvedValue({
    badge: 'verified-strong',
    evidence_type: 'program',
    record_created: true,
  }),
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
  k12ListAccumulation: vi.fn().mockResolvedValue({ items: [] }),
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

describe('BUG-20260709-A 记一条错题/自定义组卷应为 modal 弹窗（原型权威），非内联手风琴', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('★点「记一条错题」→ 表单出现在 fixed 遮罩弹层内（.k12modal），不内联挤在 tab 下方', async () => {
    const w = render()
    await flushPromises()
    // IA 迁移（2026-07-18）：记一条错题=「全部错题」档案页主操作，先切 Tab
    await w
      .findAll('.seg button')
      .find((b) => b.text() === '全部错题')!
      .trigger('click')
    await w.find('[data-testid="mistake-add-open"]').trigger('click')
    const modal = w.find('.k12modal')
    expect(modal.exists(), '应出现 modal 遮罩层（原型 openAddMistake=modal）').toBe(true)
    expect(modal.find('[data-testid="mistake-add-form"]').exists(), '表单应在弹层卡片内').toBe(true)
    // 弹层内可正常提交路径存在
    expect(modal.find('[data-testid="mistake-problem"]').exists()).toBe(true)
    expect(modal.find('[data-testid="mistake-submit"]').exists()).toBe(true)
  })

  it('★点「自定义组卷」→ 同为 modal 弹层（原型 openCustomPaper=modal，同构位置）', async () => {
    const w = render()
    await flushPromises()
    await w.find('[data-testid="review-split-more"]').trigger('click')
    await w.find('[data-testid="custom-paper-open"]').trigger('click')
    const modal = w.find('.k12modal')
    expect(modal.exists(), '自定义组卷同为原型 modal').toBe(true)
    expect(modal.find('[data-testid="custom-paper-form"]').exists()).toBe(true)
    expect(modal.find('[data-testid="custom-paper-gen"]').exists()).toBe(true)
  })

  it('弹层点遮罩/取消可关闭（modal 基本闭环）', async () => {
    const w = render()
    await flushPromises()
    // IA 迁移（2026-07-18）：记一条错题=「全部错题」档案页主操作，先切 Tab
    await w
      .findAll('.seg button')
      .find((b) => b.text() === '全部错题')!
      .trigger('click')
    await w.find('[data-testid="mistake-add-open"]').trigger('click')
    expect(w.find('.k12modal').exists()).toBe(true)
    // 在遮罩自身上触发 click（target=self），命中 @click.self 关闭
    await w.find('.k12modal').trigger('click')
    expect(w.find('.k12modal').exists(), '点遮罩关闭').toBe(false)
  })
})

describe('BUG-20260709-B 主按钮 hover 不得白底白字（.btn:hover 裸覆盖 .btn-primary）', () => {
  const viewsDir = join(__dirname, '../views')

  it('★穷举 k12 views：凡 .btn:hover 改背景 + 定义 .btn-primary 的文件，必须配对 .btn-primary:hover 声明背景', () => {
    const offenders: string[] = []
    for (const f of readdirSync(viewsDir).filter((f) => f.endsWith('.vue'))) {
      const src = readFileSync(join(viewsDir, f), 'utf8')
      const hasBtnHoverBg = /\.btn:hover\s*\{[^}]*background/.test(src)
      const hasPrimary = /\.btn-primary\s*\{[^}]*color:\s*#fff/.test(src)
      const hasPrimaryHoverBg = /\.btn-primary:hover\s*\{[^}]*background/.test(src)
      if (hasBtnHoverBg && hasPrimary && !hasPrimaryHoverBg) offenders.push(f)
    }
    expect(
      offenders,
      `这些文件的 .btn:hover 背景会压过 .btn-primary 渐变 → 浅色主题 hover 白底白字：${offenders.join(', ')}（需配对 .btn-primary:hover，对齐原型 app.html:158）`,
    ).toEqual([])
  })
})
