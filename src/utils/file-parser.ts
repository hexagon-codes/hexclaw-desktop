/**
 * Document file parser — extracts text content from PDF, Word, Excel, and plain text files.
 *
 * PDF 解析下沉到后端（见 parsePDF）；docx/xlsx/纯文本仍在前端解析（纯 JS 库，无 Web Worker）。
 */
import { extractDocument } from '@/api/documents'

const MAX_TEXT_LENGTH = 50000
const MAX_FILE_SIZE = 100 * 1024 * 1024 // 100 MB

export interface ParsedDocument {
  text: string
  fileName: string
  pageCount?: number
}

/** Supported document extensions */
const DOCUMENT_EXTENSIONS = ['.pdf', '.docx', '.doc', '.pptx', '.xlsx', '.xls', '.csv', '.txt', '.md', '.json']

/** Check if a file is a parseable document (not image/video) */
export function isDocumentFile(file: File): boolean {
  const dotIdx = file.name.lastIndexOf('.')
  if (dotIdx <= 0) return false
  const ext = file.name.slice(dotIdx).toLowerCase()
  return DOCUMENT_EXTENSIONS.includes(ext)
}

/** Parse a document file and extract its text content */
export async function parseDocument(file: File): Promise<ParsedDocument> {
  if (file.size > MAX_FILE_SIZE) {
    throw new Error(`File "${file.name}" is too large (${(file.size / 1024 / 1024).toFixed(0)} MB, max ${MAX_FILE_SIZE / 1024 / 1024} MB)`)
  }
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  const fileName = file.name

  try {
    switch (ext) {
      case 'pdf':
      case 'doc':
      case 'docx':
      case 'pptx':
        // Office 二进制 / PDF：下沉后端统一解析（见 parseViaBackend）。
        return await parseViaBackend(file, fileName)
      case 'xlsx':
      case 'xls':
        return await parseExcel(file, fileName)
      case 'csv':
      case 'txt':
      case 'md':
      case 'json':
        return await parsePlainText(file, fileName)
      default:
        // Try plain text as fallback
        return await parsePlainText(file, fileName)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`Failed to parse "${fileName}": ${message}`)
  }
}

function truncateText(text: string): string {
  if (text.length <= MAX_TEXT_LENGTH) return text
  return text.slice(0, MAX_TEXT_LENGTH) + '\n\n[... content truncated, showing first 50000 characters ...]'
}

// PDF / DOC / DOCX / PPTX 下沉后端统一解析：
//   - PDF：桌面 WKWebView 无法可靠跑 pdfjs（自定义协议建不了 Web Worker）→ 后端 poppler pdftotext；
//   - 老 .doc(OLE)：需原生工具（macOS textutil）；
//   - .docx/.pptx：复用 hexagon（OOXML，CJK 干净），顺带去掉前端 mammoth。
// 表格 .xlsx/.xls 仍前端 SheetJS（唯一能解老 .xls 且更强）。
async function parseViaBackend(file: File, fileName: string): Promise<ParsedDocument> {
  const res = await extractDocument(file)
  return { text: truncateText(res.text), fileName, pageCount: res.page_count }
}

async function parseExcel(file: File, fileName: string): Promise<ParsedDocument> {
  const XLSX = await import('xlsx')
  const arrayBuffer = await file.arrayBuffer()
  const workbook = XLSX.read(arrayBuffer, { type: 'array' })
  const textParts: string[] = []

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName]
    if (!sheet) continue
    const csv = XLSX.utils.sheet_to_csv(sheet)
    if (csv.trim()) {
      textParts.push(`[Sheet: ${sheetName}]\n${csv}`)
    }
  }

  const text = truncateText(textParts.join('\n\n'))
  return { text, fileName, pageCount: workbook.SheetNames.length }
}

async function parsePlainText(file: File, fileName: string): Promise<ParsedDocument> {
  const rawText = await file.text()
  const text = truncateText(rawText)
  return { text, fileName }
}
