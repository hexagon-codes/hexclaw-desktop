/**
 * file-parser.ts 单元测试
 *
 * 验证文件解析器的边界情况和安全性
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as XLSX from 'xlsx'
import { isDocumentFile, parseDocument } from '../file-parser'

// PDF 解析下沉后端：parsePDF 调 @/api/documents.extractDocument（前端不再用 pdfjs）。
const { mockExtractDocument } = vi.hoisted(() => ({
  mockExtractDocument: vi.fn(),
}))

vi.mock('@/api/documents', () => ({
  extractDocument: mockExtractDocument,
}))

describe('isDocumentFile', () => {
  it('识别 PDF 文件', () => {
    const file = new File([''], 'test.pdf', { type: 'application/pdf' })
    expect(isDocumentFile(file)).toBe(true)
  })

  it('识别 Word 文件', () => {
    expect(isDocumentFile(new File([''], 'doc.docx'))).toBe(true)
    expect(isDocumentFile(new File([''], 'doc.doc'))).toBe(true)
  })

  it('识别 Excel 文件', () => {
    expect(isDocumentFile(new File([''], 'data.xlsx'))).toBe(true)
    expect(isDocumentFile(new File([''], 'data.xls'))).toBe(true)
    expect(isDocumentFile(new File([''], 'data.csv'))).toBe(true)
  })

  it('识别文本文件', () => {
    expect(isDocumentFile(new File([''], 'readme.txt'))).toBe(true)
    expect(isDocumentFile(new File([''], 'readme.md'))).toBe(true)
    expect(isDocumentFile(new File([''], 'config.json'))).toBe(true)
  })

  it('拒绝图片文件', () => {
    expect(isDocumentFile(new File([''], 'photo.png'))).toBe(false)
    expect(isDocumentFile(new File([''], 'photo.jpg'))).toBe(false)
  })

  it('拒绝视频文件', () => {
    expect(isDocumentFile(new File([''], 'video.mp4'))).toBe(false)
  })

  // ─── 边界情况 ──────────────────────────────────────
  it('BUG: 无扩展名的文件应返回 false 但可能崩溃', () => {
    const file = new File(['content'], 'noextension')
    // file.name.split('.').pop() 对 'noextension' 返回 'noextension'
    // '.' + 'noextension' = '.noextension' 不在列表中，所以返回 false
    expect(isDocumentFile(file)).toBe(false)
  })

  it('大小写不敏感应正常处理', () => {
    expect(isDocumentFile(new File([''], 'TEST.PDF'))).toBe(true)
    expect(isDocumentFile(new File([''], 'Doc.DOCX'))).toBe(true)
  })

  it('BUG: 多个点的文件名应该取最后的扩展名', () => {
    const file = new File([''], 'my.file.name.pdf')
    expect(isDocumentFile(file)).toBe(true)
  })
})

describe('parseDocument', () => {
  beforeEach(() => {
    mockExtractDocument.mockReset()
  })

  it('解析纯文本文件', async () => {
    const content = 'Hello, World!\nLine 2'
    const file = new File([content], 'test.txt', { type: 'text/plain' })
    const result = await parseDocument(file)
    expect(result.text).toBe(content)
    expect(result.fileName).toBe('test.txt')
  })

  it('解析 JSON 文件', async () => {
    const json = JSON.stringify({ key: 'value' }, null, 2)
    const file = new File([json], 'config.json', { type: 'application/json' })
    const result = await parseDocument(file)
    expect(result.text).toBe(json)
  })

  it('解析 Markdown 文件', async () => {
    const md = '# Title\n\nParagraph'
    const file = new File([md], 'readme.md', { type: 'text/markdown' })
    const result = await parseDocument(file)
    expect(result.text).toBe(md)
  })

  it('超长内容应被截断到 50000 字符', async () => {
    const longContent = 'a'.repeat(60000)
    const file = new File([longContent], 'huge.txt')
    const result = await parseDocument(file)
    expect(result.text.length).toBeLessThan(longContent.length)
    expect(result.text).toContain('[... content truncated')
  })

  it('空文件应返回空文本', async () => {
    const file = new File([''], 'empty.txt')
    const result = await parseDocument(file)
    expect(result.text).toBe('')
  })

  it('未知扩展名应尝试以文本方式解析', async () => {
    const file = new File(['some content'], 'file.xyz')
    const result = await parseDocument(file)
    expect(result.text).toBe('some content')
  })

  it('解析 PDF 下沉后端：调 extractDocument 上传文件，返回后端抽取的文本与页数', async () => {
    mockExtractDocument.mockResolvedValue({
      text: 'PDF content',
      file_name: 'sample.pdf',
      page_count: 3,
    })

    const file = new File(['%PDF'], 'sample.pdf', { type: 'application/pdf' })
    const result = await parseDocument(file)

    // PDF 不在前端解析（WKWebView 无法建 Web Worker）→ 走后端 /documents/extract
    expect(mockExtractDocument).toHaveBeenCalledTimes(1)
    expect(mockExtractDocument).toHaveBeenCalledWith(file)
    expect(result.text).toBe('PDF content')
    expect(result.fileName).toBe('sample.pdf')
    expect(result.pageCount).toBe(3)
  })

  it('后端 PDF 解析失败时向上抛错（由调用方弹错、绝不当二进制发）', async () => {
    mockExtractDocument.mockRejectedValue(new Error('解析文档失败: bad pdf'))
    const file = new File(['%PDF'], 'broken.pdf', { type: 'application/pdf' })
    await expect(parseDocument(file)).rejects.toThrow(/broken\.pdf/)
  })

  it.each(['report.doc', 'report.docx', 'deck.pptx'])(
    'Office 二进制 %s 也走后端统一解析（不在前端解析）',
    async (name) => {
      mockExtractDocument.mockResolvedValue({ text: 'office text', file_name: name })
      const result = await parseDocument(new File(['x'], name))
      expect(mockExtractDocument).toHaveBeenCalledTimes(1)
      expect(result.text).toBe('office text')
    },
  )

  it('表格 .xlsx 仍在前端解析（不走后端）', async () => {
    // 仅用扩展名驱动路由；xlsx 走 SheetJS（此处不构造真 xlsx，断言不调后端即可）
    mockExtractDocument.mockResolvedValue({ text: 'should-not-be-used', file_name: 'a.xlsx' })
    await parseDocument(new File(['not-a-real-xlsx'], 'a.xlsx')).catch(() => {})
    expect(mockExtractDocument).not.toHaveBeenCalled()
  })

  it('识别 PPTX 为文档', () => {
    expect(isDocumentFile(new File([''], 'slides.pptx'))).toBe(true)
  })
})

// 真实 Excel / CSV 解析（SheetJS 前端解析，CJK 安全；构造真表格验证抽取）
describe('parseDocument Excel/CSV (real content)', () => {
  function buildWorkbookFile(bookType: 'xlsx' | 'xls', name: string): File {
    const wb = XLSX.utils.book_new()
    const cities = XLSX.utils.aoa_to_sheet([
      ['城市', '人口万', '特色'],
      ['杭州', 1200, '西湖与电子商务'],
      ['成都', 2100, '大熊猫与火锅'],
    ])
    XLSX.utils.book_append_sheet(wb, cities, '城市表')
    const en = XLSX.utils.aoa_to_sheet([
      ['Product', 'Price'],
      ['Widget', 9.99],
    ])
    XLSX.utils.book_append_sheet(wb, en, 'Products')
    const buf = XLSX.write(wb, { bookType, type: 'array' }) as ArrayBuffer
    return new File([buf], name)
  }

  it('解析真实 .xlsx：多 sheet + CJK 单元格不乱码（SheetJS sheet_to_csv）', async () => {
    const res = await parseDocument(buildWorkbookFile('xlsx', 'cities.xlsx'))
    expect(res.text).toContain('[Sheet: 城市表]')
    expect(res.text).toContain('成都')
    expect(res.text).toContain('大熊猫与火锅')
    expect(res.text).toContain('1200')
    // 第二个 sheet 也应抽取
    expect(res.text).toContain('[Sheet: Products]')
    expect(res.text).toContain('Widget')
    expect(res.pageCount).toBe(2) // sheet 数
  })

  it('解析老版 .xls（BIFF）：同样走 SheetJS，CJK 安全', async () => {
    const res = await parseDocument(buildWorkbookFile('xls', 'cities.xls'))
    expect(res.text).toContain('成都')
    expect(res.text).toContain('大熊猫与火锅')
  })

  it('解析真实 CSV：中文表格按原文逐行保留（parsePlainText）', async () => {
    const csv = '城市,人口万,特色\n哈尔滨,1000,冰雪旅游与中央大街\n'
    const res = await parseDocument(new File([csv], 'cities.csv', { type: 'text/csv' }))
    expect(res.text).toBe(csv)
    expect(res.text).toContain('哈尔滨')
    expect(res.text).toContain('冰雪旅游与中央大街')
  })
})
