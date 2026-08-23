import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import K12RecordsView from '../views/K12RecordsView.vue'

const h = vi.hoisted(() => {
  const canonicalArchive = [
    '# 小明学习档案',
    '## 本周复习',
    'WEEKLY-REVIEW-MARKER',
    '## 全部错题',
    'MISTAKE-MARKER',
    '## 练习集',
    'PRACTICE-SET-MARKER',
    '## 积累',
    'ACCUMULATION-MARKER',
    '## 作品',
    'CREATIVE-WORK-MARKER',
  ].join('\n')
  return {
    canonicalArchive,
    exportArchiveSpy: vi.fn().mockImplementation((_agent: string, format: string) => {
      if (format === 'md') {
        return Promise.resolve({
          format: 'markdown',
          content: canonicalArchive,
          artifactId: 'artifact-1',
          sourceDigest: 'sha256:archive',
          objectCounts: {
            weekly_review: 1,
            mistakes: 1,
            practice_sets: 1,
            accumulation: 1,
            creative_works: 1,
          },
        })
      }
      return Promise.resolve({
        blob: new Blob([format === 'pdf' ? '%PDF-stub' : 'PK\\x03\\x04']),
        filename: `小明_学习档案_五年级上.${format}`,
        contentType:
          format === 'pdf'
            ? 'application/pdf'
            : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        artifactId: 'artifact-1',
        sourceDigest: 'sha256:archive',
        objectCounts: {
          weekly_review: 1,
          mistakes: 1,
          practice_sets: 1,
          accumulation: 1,
          creative_works: 1,
        },
      })
    }),
    downloadSpy: vi.fn(),
    exportArchiveDocumentSpy: vi.fn(),
  }
})
vi.mock('../export', () => ({
  printWorksheet: vi.fn(() => true),
  exportPdf: vi.fn(),
  exportWord: vi.fn(),
  exportArchiveDocument: (...a: unknown[]) => h.exportArchiveDocumentSpy(...a),
  worksheetFilename: vi.fn(() => 'f.md'),
  download: (...a: unknown[]) => h.downloadSpy(...a),
}))
vi.mock('@/api/k12', () => ({
  k12ExportArchive: (a: string, format: string) => h.exportArchiveSpy(a, format),
  k12ListMistakes: vi.fn().mockResolvedValue({
    items: [
      {
        record_id: 'a',
        question: '3.8×3',
        knowledge_point: '小数乘法',
        error_cause: '进位',
        status: 'new',
        version: 0,
        due_at: 1,
      },
    ],
  }),
  k12ReviewQueue: vi.fn().mockResolvedValue({ items: [] }),
  k12MarkMastered: vi.fn(),
  k12GetMistakePracticeGeneration: vi
    .fn()
    .mockImplementation((_agent: string, recordID: string) =>
      Promise.resolve({ state: 'available', source_mistake_id: recordID }),
    ),
  k12InsightReport: vi.fn().mockResolvedValue({
    trend: { mastered: 0, reviewing: 1, retried: 0, archived: 0, total: 1 },
    weak_top3: [],
    month_new_mistakes: 1,
    review_completion_rate: -1,
    consecutive_fail_kps: null,
    suggestion: '',
  }),
  k12StudyTime: vi
    .fn()
    .mockResolvedValue({ days: [], total_records: 1, total_minutes: 0, note: '' }),
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

// 三种格式直接消费唯一服务端 LearningArchive Artifact，前端不按当前 Tab 重新拼装。
describe('学习档案三格式导出共用服务端 canonical Artifact', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    h.exportArchiveSpy.mockClear()
    h.downloadSpy.mockClear()
    h.exportArchiveDocumentSpy.mockClear().mockResolvedValue(true)
  })

  it('导出菜单有 Markdown，点击调唯一 Artifact 导出端点并下载', async () => {
    const w = mount(K12RecordsView, {
      props: { agentId: 'mingming', agentName: '小明的辅导老师', grade: '五年级上 · 人教版' },
      global: { plugins: [createPinia(), i18n()] },
    })
    await flushPromises()
    // IA 迁移（2026-07-18）：导出错题项在「全部错题」档案页
    await w
      .findAll('.seg button')
      .find((b) => b.text() === '全部错题')!
      .trigger('click')
    await w.find('.k12rec__export button').trigger('click') // 展开导出菜单
    const mdBtn = w.findAll('.k12rec__menu button').find((b) => b.text().includes('Markdown'))
    expect(mdBtn, '导出菜单应有 Markdown 项').toBeTruthy()
    await mdBtn!.trigger('click')
    await flushPromises()
    expect(h.exportArchiveSpy).toHaveBeenCalledWith('mingming', 'md')
    expect(h.downloadSpy).toHaveBeenCalledWith(
      'f.md',
      h.canonicalArchive,
      'text/markdown;charset=utf-8',
    )
  })

  it.each([
    ['PDF', 'pdf'],
    ['Word', 'docx'],
  ] as const)('导出 %s 直接下载服务端 Artifact 二进制并沿用其文件名', async (label, format) => {
    const w = mount(K12RecordsView, {
      props: { agentId: 'mingming', agentName: '小明的辅导老师', grade: '五年级上 · 人教版' },
      global: { plugins: [createPinia(), i18n()] },
    })
    await flushPromises()
    await w
      .findAll('.seg button')
      .find((b) => b.text() === '全部错题')!
      .trigger('click')
    await w.find('.k12rec__export button').trigger('click')
    await w
      .findAll('.k12rec__menu button')
      .find((b) => b.text().includes(label))!
      .trigger('click')
    await flushPromises()

    expect(h.exportArchiveSpy).toHaveBeenCalledWith('mingming', format)
    expect(h.exportArchiveDocumentSpy).not.toHaveBeenCalled()
    expect(h.downloadSpy).toHaveBeenCalledWith(
      `小明_学习档案_五年级上.${format}`,
      expect.any(Blob),
      expect.stringContaining(
        format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats',
      ),
    )
  })
})
