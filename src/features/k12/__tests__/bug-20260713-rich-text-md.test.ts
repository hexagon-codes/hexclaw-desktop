import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import K12RecordsView from '../views/K12RecordsView.vue'

// BUG-20260713（截图 012.png）：「再练一道」变式题弹窗与错题详情把模型生成的富文本当纯文本裸渲染，
// `**题目：**` 等 markdown 标记直接裸露、LaTeX 数学不渲染。修复：改用 <MarkdownRenderer>。
// 契约：变式题解答里的 markdown（**加粗**）必须渲染成 HTML（<strong>），而非原样输出 `**`。

const h = vi.hoisted(() => ({
  clipboardSpy: vi.fn().mockResolvedValue(undefined),
  mistakes: [
    { record_id: 'a', question: '解方程 2x+15=43', knowledge_point: '简易方程', error_cause: '移项符号错', status: 'new', version: 0, due_at: 1710000000 },
  ],
  // 变式题解答含 markdown 加粗 + 列表 —— 裸渲染会露 `**`，md 渲染成 <strong>/<li>。
  retrySpy: vi.fn().mockResolvedValue({
    solution: '**题目：** 计算 4.2×3=?\n\n**解答：**\n- 先算 4×3=12\n- 再算 0.2×3=0.6\n- 合计 **12.6**',
    verdict: 'agree', badge: '✅ 已程序验算',
  }),
}))

vi.mock('@/api/desktop', () => ({
  setClipboard: (text: string) => h.clipboardSpy(text),
}))

vi.mock('@/api/k12', () => ({
  k12ListMistakes: vi.fn().mockResolvedValue({ items: h.mistakes }),
  k12ReviewQueue: vi.fn().mockResolvedValue({ items: [h.mistakes[0]] }),
  k12MarkMastered: vi.fn(),
  k12ReviewRetry: (req: unknown) => h.retrySpy(req),
  k12TutoringTips: vi.fn(),
  k12Grade: vi.fn(),
  k12RecordMistake: vi.fn(),
  k12InsightReport: vi.fn().mockResolvedValue({
    trend: { mastered: 1, reviewing: 1, retried: 0, archived: 0, total: 2 },
    weak_top3: [], month_new_mistakes: 1, review_completion_rate: 0.5, consecutive_fail_kps: [], suggestion: '',
  }),
  k12StudyTime: vi.fn().mockResolvedValue({ days: [], total_records: 0, total_minutes: 0, note: '' }),
  k12ListAccumulation: vi.fn().mockResolvedValue({ items: [] }),
}))

function i18n() {
  return createI18n({
    legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: zhCN },
  })
}

describe('BUG-20260713 K12 富文本 md 渲染', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    h.clipboardSpy.mockClear()
  })

  it('「再练一道」变式题解答按 markdown 渲染（**加粗** → <strong>，不裸显 `**`）', async () => {
    const w = mount(K12RecordsView, {
      props: { agentId: 'mingming', agentName: '小明', grade: '五年级上 · 人教版' },
      global: { plugins: [createPinia(), i18n()] },
    })
    await flushPromises()
    await w.findAll('.rl-btn').find((b) => b.text() === '再练一道')!.trigger('click')
    await flushPromises()
    await w.find('[data-testid="retry-reveal"]').trigger('click')
    await flushPromises()

    const html = w.find('.k12retry__body').html()
    // markdown 已渲染成 HTML：加粗 → <strong>，列表 → <li>
    expect(html).toContain('<strong>')
    expect(html).toContain('<li>')
    // 且不再有裸露的 markdown 加粗标记
    expect(w.find('.k12retry__body').text()).not.toContain('**题目')
  })

  it('答案揭示后提供复制入口，并复制保留 Markdown 结构的题目与解答', async () => {
    const w = mount(K12RecordsView, {
      props: { agentId: 'mingming', agentName: '小明', grade: '五年级上 · 人教版' },
      global: { plugins: [createPinia(), i18n()] },
    })
    await flushPromises()
    await w.findAll('.rl-btn').find((b) => b.text() === '再练一道')!.trigger('click')
    await flushPromises()

    // 守答案：未揭示前不能借复制按钮绕过遮罩。
    expect(w.find('[data-testid="retry-copy"]').exists()).toBe(false)
    await w.find('[data-testid="retry-reveal"]').trigger('click')
    await w.find('[data-testid="retry-copy"]').trigger('click')
    await flushPromises()

    expect(h.clipboardSpy).toHaveBeenCalledWith(expect.stringContaining('**题目：**'))
    expect(h.clipboardSpy).toHaveBeenCalledWith(expect.stringContaining('- 先算'))
  })

  it('Markdown 阅读区使用独立留白，标题和正文不贴弹窗边缘', async () => {
    const source = await import('../views/K12RecordsView.vue?raw')
    expect(source.default).toMatch(/\.k12retry__body\s*\{[^}]*padding:\s*16px 20px/s)
  })
})
