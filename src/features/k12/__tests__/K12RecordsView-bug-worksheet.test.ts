import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import K12RecordsView from '../views/K12RecordsView.vue'

const h = vi.hoisted(() => ({
  printSpy: vi.fn(() => true),
  mistakes: [
    { record_id: 'a', question: '苹果和梨的价钱', knowledge_point: '小数乘法', error_cause: '进位', status: 'new', version: 0, due_at: 1 },
  ],
}))
vi.mock('../export', () => ({
  printWorksheet: (...a: unknown[]) => h.printSpy(...a),
  exportPdf: vi.fn(), exportWord: vi.fn(), worksheetFilename: vi.fn(() => 'f.doc'),
}))
vi.mock('@/api/k12', () => ({
  k12ListMistakes: vi.fn().mockResolvedValue({ items: h.mistakes }),
  k12ReviewQueue: vi.fn().mockResolvedValue({ items: [h.mistakes[0]] }),
  k12MarkMastered: vi.fn().mockResolvedValue({ ok: true }),
  k12ReviewRetry: vi.fn(),
  k12InsightReport: vi.fn().mockResolvedValue({ trend: { mastered: 0, reviewing: 1, retried: 0, archived: 0, total: 1 }, weak_top3: [], month_new_mistakes: 1, review_completion_rate: -1, consecutive_fail_kps: null, suggestion: '' }),
  k12StudyTime: vi.fn().mockResolvedValue({ days: [], total_records: 1, total_minutes: 0, note: '' }),
  k12ListAccumulation: vi.fn().mockResolvedValue({ items: [] }),
}))

function i18n() {
  return createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: zhCN } })
}

// bug（用户报）：错题卷「生成」按钮不闭环——review-actions 槽里的按钮只 toast，不真出卷。
describe('bug: 错题卷生成按钮须真打印（闭环）', () => {
  beforeEach(() => { setActivePinia(createPinia()); h.printSpy.mockClear() })

  it('点「一键出复习卷」调用 printWorksheet（真出卷）而非仅 toast', async () => {
    const w = mount(K12RecordsView, {
      props: { agentId: 'mingming', agentName: '小明的辅导老师', grade: '五年级上 · 人教版' },
      global: { plugins: [createPinia(), i18n()] },
    })
    await flushPromises()
    const genBtn = w.findAll('button').find((b) => b.text().includes('一键出复习卷'))
    expect(genBtn, '应有「一键出复习卷」按钮').toBeTruthy()
    await genBtn!.trigger('click')
    expect(h.printSpy).toHaveBeenCalledTimes(1)
  })
})
