/**
 * Bug-20260713：积累 tab 对齐原型 rc1（app.html:1618）——补齐缺失的 cxsec 标题 + 说明。
 *
 * 原型积累区结构：①「积累本」h2 标题 + 说明 note；② 列表；③ 分界规则脚注。
 * 代码此前直接从「分科过滤 + 记录入口」bar 起头，缺 ① 标题块（学情 tab 有 reporthead，积累没有 → 不一致）。
 * 本测试锁标题 + 说明渲染，且分界规则脚注仍在（原型 footer）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import K12RecordsView from '../views/K12RecordsView.vue'

vi.mock('@/api/k12', () => ({
  k12ListMistakes: vi.fn().mockResolvedValue({ items: [] }),
  k12ReviewQueue: vi.fn().mockResolvedValue({ items: [] }),
  k12MarkMastered: vi.fn(),
  k12PrepCard: vi.fn(),
  k12Grade: vi.fn(),
  k12InsightReport: vi.fn().mockResolvedValue({
    trend: { mastered: 0, reviewing: 0, retried: 0, archived: 0, total: 0 },
    weak_top3: [], month_new_mistakes: 0, review_completion_rate: -1, consecutive_fail_kps: null, suggestion: '',
  }),
  k12StudyTime: vi.fn().mockResolvedValue({ days: [], total_records: 0, total_minutes: 0, note: '' }),
  k12ListAccumulation: vi.fn().mockResolvedValue({ items: [] }),
  k12AddAccumulation: vi.fn(),
  k12ReviewRetry: vi.fn(),
  k12ExportMd: vi.fn(),
}))

function render() {
  const i18n = createI18n({
    legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: zhCN },
  })
  return mount(K12RecordsView, {
    props: { agentId: 'mingming', agentName: '小明的辅导老师', grade: '五年级上' },
    global: { plugins: [createPinia(), i18n] },
  })
}

describe('Bug-20260713：积累 tab 头部对齐原型 rc1', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('积累 tab 有「积累本」标题 + 说明 note（原型 cxsec），且分界规则脚注仍在', async () => {
    const w = render()
    await flushPromises()
    await w.findAll('.seg button').find((b) => b.text() === '积累')!.trigger('click')
    await flushPromises()

    const head = w.find('section .k12rec__reporthead')
    expect(head.exists(), '积累 tab 应有标题块 reporthead').toBe(true)
    expect(head.text()).toContain('积累本')
    expect(head.text()).toContain('收藏驱动')
    // 原型 footer 分界规则不动
    expect(w.text()).toContain('做错了要改')
  })
})
