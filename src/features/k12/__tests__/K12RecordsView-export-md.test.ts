import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import K12RecordsView from '../views/K12RecordsView.vue'

const h = vi.hoisted(() => ({
  exportMdSpy: vi.fn().mockResolvedValue({ format: 'markdown', content: '# 错题本\n- 3.8×3' }),
  downloadSpy: vi.fn(),
  exportArchiveDocumentSpy: vi.fn(),
}))
vi.mock('../export', () => ({
  printWorksheet: vi.fn(() => true), exportPdf: vi.fn(), exportWord: vi.fn(),
  exportArchiveDocument: (...a: unknown[]) => h.exportArchiveDocumentSpy(...a),
  worksheetFilename: vi.fn(() => 'f.md'),
  download: (...a: unknown[]) => h.downloadSpy(...a),
}))
vi.mock('@/api/k12', () => ({
  k12ExportMd: (a: string) => h.exportMdSpy(a),
  k12ListMistakes: vi.fn().mockResolvedValue({ items: [{ record_id: 'a', question: '3.8×3', knowledge_point: '小数乘法', error_cause: '进位', status: 'new', version: 0, due_at: 1 }] }),
  k12ReviewQueue: vi.fn().mockResolvedValue({ items: [] }),
  k12MarkMastered: vi.fn(),
  k12GetMistakePracticeGeneration: vi.fn().mockImplementation((_agent: string, recordID: string) =>
    Promise.resolve({ state: 'available', source_mistake_id: recordID })),
  k12InsightReport: vi.fn().mockResolvedValue({ trend: { mastered: 0, reviewing: 1, retried: 0, archived: 0, total: 1 }, weak_top3: [], month_new_mistakes: 1, review_completion_rate: -1, consecutive_fail_kps: null, suggestion: '' }),
  k12StudyTime: vi.fn().mockResolvedValue({ days: [], total_records: 1, total_minutes: 0, note: '' }),
  k12ListAccumulation: vi.fn().mockResolvedValue({ items: [] }),
}))

function i18n() {
  return createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: zhCN } })
}

// 未闭环补齐（审计 #6）：导出菜单缺「Markdown」——后端 GET /export 导出完整错题本 md，前端 api
// (k12ExportMd) 就绪但无按钮。补齐后：点 Markdown → 调 k12ExportMd → 下载 .md。
describe('学习档案三格式导出共用服务端 canonical Markdown', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    h.exportMdSpy.mockClear()
    h.downloadSpy.mockClear()
    h.exportArchiveDocumentSpy.mockClear().mockResolvedValue(true)
  })

  it('导出菜单有 Markdown，点击调 k12ExportMd 并下载', async () => {
    const w = mount(K12RecordsView, {
      props: { agentId: 'mingming', agentName: '小明的辅导老师', grade: '五年级上 · 人教版' },
      global: { plugins: [createPinia(), i18n()] },
    })
    await flushPromises()
    // IA 迁移（2026-07-18）：导出错题项在「全部错题」档案页
    await w.findAll('.seg button').find((b) => b.text() === '全部错题')!.trigger('click')
    await w.find('.k12rec__export button').trigger('click') // 展开导出菜单
    const mdBtn = w.findAll('.k12rec__menu button').find((b) => b.text().includes('Markdown'))
    expect(mdBtn, '导出菜单应有 Markdown 项').toBeTruthy()
    await mdBtn!.trigger('click')
    await flushPromises()
    expect(h.exportMdSpy).toHaveBeenCalledWith('mingming')
    expect(h.downloadSpy).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['PDF', 'pdf'],
    ['Word', 'docx'],
  ] as const)('导出 %s 先取完整学习档案 Markdown，再只做格式渲染', async (label, format) => {
    const w = mount(K12RecordsView, {
      props: { agentId: 'mingming', agentName: '小明的辅导老师', grade: '五年级上 · 人教版' },
      global: { plugins: [createPinia(), i18n()] },
    })
    await flushPromises()
    await w.find('.k12rec__export button').trigger('click')
    await w.findAll('.k12rec__menu button').find((b) => b.text().includes(label))!.trigger('click')
    await flushPromises()

    expect(h.exportMdSpy).toHaveBeenCalledWith('mingming')
    expect(h.exportArchiveDocumentSpy).toHaveBeenCalledWith(expect.objectContaining({
      content: '# 错题本\n- 3.8×3',
      format,
    }))
  })
})
