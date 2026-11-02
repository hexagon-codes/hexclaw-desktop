import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as XLSX from 'xlsx'

const native = vi.hoisted(() => ({ bytes: new ArrayBuffer(0), name: '', mime: '' }))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string) => {
    if (command === 'preserve_draft_attachment') return 'saved-document'
    if (command === 'restore_draft_attachment') return {
      grantId: 'restored-grant', operationId: 'restored-operation', purpose: 'attachment_upload',
      name: native.name, mime: native.mime, size: native.bytes.byteLength,
      sourceSha256: 'a'.repeat(64),
    }
    if (command === 'read_document_file_grant') return native.bytes
    throw new Error(`Unexpected native command: ${command}`)
  }),
}))
import { fileFromNativeGrant } from '../native-files'
import { parseDocument } from '@/utils/file-parser'
import { effectiveChatFileSize } from '@/contracts/chat-file-boundary'

function grantedFile(name: string, mime: string, bytes: ArrayBuffer) {
  Object.assign(native, { name, mime, bytes })
  return fileFromNativeGrant({
    grantId: 'selected-grant', operationId: 'selected-operation', purpose: 'attachment_upload',
    name, mime, size: bytes.byteLength, sourceSha256: 'a'.repeat(64),
  })
}

describe('native document bytes reach the existing parser', () => {
  beforeEach(() => vi.clearAllMocks())
  for (const format of ['xlsx', 'xls'] as const) {
    it(`parses real ${format} bytes rather than the empty File placeholder`, async () => {
      const book = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
        ['类别', '适用车型', '原厂色号', '样色名称'], ['2K', 'XTS(18款)', 'GAZ', '幻白'],
      ]), '油漆')
      const bytes = XLSX.write(book, { type: 'array', bookType: format }) as ArrayBuffer
      const file = grantedFile(`paint.${format}`, 'application/vnd.ms-excel', bytes)
      expect(file.size).toBe(0)
      expect(effectiveChatFileSize(file)).toBe(bytes.byteLength)
      const parsed = await parseDocument(file)
      expect(parsed.text).toBe('[Sheet: 油漆]\n类别,适用车型,原厂色号,样色名称\n2K,XTS(18款),GAZ,幻白')
    })
  }
  it('parses UTF-8 text from the same native source', async () => {
    const expected = '文档真实正文\n第二行'
    const file = grantedFile('native.txt', 'text/plain', new TextEncoder().encode(expected).buffer)
    expect((await parseDocument(file)).text).toBe(expected)
  })
})
