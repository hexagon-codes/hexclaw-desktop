import { describe, it, expect } from 'vitest'
import { buildWorksheetHtml, worksheetFilename } from '../export'
import type { RecordItem } from '@/contracts'

const item = (over: Partial<RecordItem['fields']> = {}): RecordItem => ({
  recordId: 'r', agentId: 'a', collection: '错题本', schemaVersion: '1', status: 'new', version: 0,
  fields: { question: '3.8×3=?', knowledge_point: '小数乘法', error_cause: '进位', ...over },
})

const meta = { childName: '小明', title: '错题卷', dateLabel: '2026-07-07' }

describe('错题卷打印/导出（M2-3 / M3-5）', () => {
  it('A4 打印模板：题号 + 题干 + 答题留白 + page-break 防切题 + 页脚', () => {
    const html = buildWorksheetHtml([item(), item({ question: '2x+15=43' })], meta)
    expect(html).toContain('size: A4')
    expect(html).toContain('page-break-inside: avoid')
    expect(html).toContain('1.')
    expect(html).toContain('2.')
    expect(html).toContain('q-blank') // 答题留白
    expect(html).toContain('小明 · 2026-07-07') // 页脚
    expect(html).toContain('【小数乘法】')
  })

  it('题干 HTML 转义，防结构破坏', () => {
    const html = buildWorksheetHtml([item({ question: '比较 3<5 与 <b>x</b>' })], meta)
    expect(html).toContain('3&lt;5')
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;')
    expect(html).not.toContain('<b>x</b>')
  })

  it('空错题 → 占位不报错', () => {
    expect(buildWorksheetHtml([], meta)).toContain('暂无错题')
  })

  it('文件名格式 {称呼}_错题本_{起}_{止}.{ext}', () => {
    expect(worksheetFilename('小明', '错题本', '0601', '0630', 'pdf')).toBe('小明_错题本_0601_0630.pdf')
    expect(worksheetFilename('小明', '错题本', '0601', '0630', 'doc')).toBe('小明_错题本_0601_0630.doc')
  })
})
