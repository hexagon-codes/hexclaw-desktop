/**
 * file-parser.ts 单元测试
 *
 * 验证文件解析器的边界情况和安全性
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isDocumentFile, parseDocument } from '../file-parser'

const {
  mockGetDocument,
  mockGlobalWorkerOptions,
} = vi.hoisted(() => ({
  mockGetDocument: vi.fn(),
  mockGlobalWorkerOptions: {} as { workerPort?: unknown; workerSrc?: string },
}))

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  getDocument: mockGetDocument,
  GlobalWorkerOptions: mockGlobalWorkerOptions,
}))

vi.mock('pdfjs-dist/legacy/build/pdf.worker.mjs?url', () => ({
  default: '/assets/pdf.worker.mock.js',
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
    mockGetDocument.mockReset()
    delete mockGlobalWorkerOptions.workerPort
    delete mockGlobalWorkerOptions.workerSrc
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

  it('解析 PDF 时应配置 workerSrc 并禁用直接 workerPort 注入', async () => {
    mockGetDocument.mockReturnValue({
      promise: Promise.resolve({
        numPages: 1,
        destroy: vi.fn().mockResolvedValue(undefined),
        getPage: vi.fn().mockResolvedValue({
          getTextContent: vi.fn().mockResolvedValue({
            items: [{ str: 'PDF content' }],
          }),
        }),
      }),
    })

    const file = new File(['%PDF'], 'sample.pdf', { type: 'application/pdf' })
    const result = await parseDocument(file)

    expect(result.text).toBe('PDF content')
    expect(mockGlobalWorkerOptions.workerPort).toBeNull()
    expect(mockGlobalWorkerOptions.workerSrc).toBe('/assets/pdf.worker.mock.js')
    expect(mockGetDocument).toHaveBeenCalledWith({
      data: expect.any(Uint8Array),
      useWorkerFetch: false,
      isOffscreenCanvasSupported: false,
      isImageDecoderSupported: false,
      stopAtErrors: true,
    })
  })
})
