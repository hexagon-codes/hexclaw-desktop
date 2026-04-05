/**
 * Document file parser — extracts text content from PDF, Word, Excel, and plain text files.
 */

const MAX_TEXT_LENGTH = 50000
const MAX_FILE_SIZE = 100 * 1024 * 1024 // 100 MB
type PdfJsModule = typeof import('pdfjs-dist')

let pdfJsLoaderPromise: Promise<PdfJsModule> | null = null

export interface ParsedDocument {
  text: string
  fileName: string
  pageCount?: number
}

/** Supported document extensions */
const DOCUMENT_EXTENSIONS = ['.pdf', '.docx', '.doc', '.xlsx', '.xls', '.csv', '.txt', '.md', '.json']

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
        return await parsePDF(file, fileName)
      case 'docx':
      case 'doc':
        return await parseWord(file, fileName)
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

async function loadPdfJs() {
  if (!pdfJsLoaderPromise) {
    pdfJsLoaderPromise = Promise.all([
      import('pdfjs-dist/legacy/build/pdf.mjs'),
      import('pdfjs-dist/legacy/build/pdf.worker.mjs?url'),
    ]).then(([pdfjsLib, workerUrl]) => {
      // Let PDF.js manage the worker lifecycle so it can fall back to a fake
      // worker in environments where spawning a real Worker fails.
      pdfjsLib.GlobalWorkerOptions.workerPort = null
      if (pdfjsLib.GlobalWorkerOptions.workerSrc !== workerUrl.default) {
        pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl.default
      }
      return pdfjsLib as PdfJsModule
    })
  }

  return pdfJsLoaderPromise
}

async function parsePDF(file: File, fileName: string): Promise<ParsedDocument> {
  const pdfjsLib = await loadPdfJs()

  const data = new Uint8Array(await file.arrayBuffer())
  const loadingTask = pdfjsLib.getDocument({
    data,
    useWorkerFetch: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    stopAtErrors: true,
  })
  const pdf = await loadingTask.promise
  const pageCount = pdf.numPages
  const textParts: string[] = []

  try {
    for (let i = 1; i <= pageCount; i++) {
      const page = await pdf.getPage(i)
      const content = await page.getTextContent()
      const pageText = content.items
        .map((item) => ('str' in item ? item.str : ''))
        .join(' ')
      if (pageText.trim()) {
        textParts.push(pageText)
      }
    }
  } finally {
    await pdf.destroy()
  }

  const text = truncateText(textParts.join('\n\n'))
  return { text, fileName, pageCount }
}

async function parseWord(file: File, fileName: string): Promise<ParsedDocument> {
  const mammoth = await import('mammoth')
  const arrayBuffer = await file.arrayBuffer()
  const result = await mammoth.extractRawText({ arrayBuffer })
  const text = truncateText(result.value)
  return { text, fileName }
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
