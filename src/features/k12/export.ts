/**
 * 错题卷打印 + 导出（features/k12）· M2-3 打印模板 + M3-5 PDF/Word 导出。
 *
 * 纯前端：从错题记录生成 A4 可打印 HTML（题干 + 答题留白 + page-break 防切题 + 页脚）。
 * PDF = 浏览器打印对话框另存；Word = HTML 内容 .doc（Word 可直接打开，无需额外依赖，砍 CSV/JSON）。
 */
import type { RecordItem } from '@/contracts'
import { invoke } from '@tauri-apps/api/core'
import { isTauri } from '@/utils/platform'
import { downloadInApp } from '@/utils/download'
import { renderDocument } from '@/api/k12'

export interface WorksheetMeta {
  childName: string
  /** 已本地化的标题（如"错题卷"），由调用方传入避免本模块碰 i18n */
  title: string
  /** 页脚日期串 */
  dateLabel: string
}

function worksheetExportFilename(meta: WorksheetMeta, ext: string): string {
  const digits = meta.dateLabel.replace(/\D/g, '')
  const date = digits.slice(-4).padStart(4, '0')
  return worksheetFilename(meta.childName, meta.title, date, date, ext)
}

/** HTML 转义，防题干里的尖括号破坏结构 */
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ))
}

/** 从错题记录生成 A4 打印 HTML（题干 + 答题留白 + page-break） */
export function buildWorksheetHtml(items: RecordItem[], meta: WorksheetMeta): string {
  const rows = items
    .map((it, i) => {
      const q = esc(String(it.fields.question ?? ''))
      const kp = esc(String(it.fields.knowledge_point ?? ''))
      return `<li class="q">
        <div class="q-stem"><span class="q-no">${i + 1}.</span> ${q}${kp ? ` <span class="q-kp">【${kp}】</span>` : ''}</div>
        <div class="q-blank"></div>
      </li>`
    })
    .join('\n')

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>${esc(meta.title)} · ${esc(meta.childName)}</title>
<style>
  @page { size: A4; margin: 18mm 16mm 20mm; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif; color: #111; font-size: 13px; line-height: 1.5; }
  h1 { font-size: 18px; margin: 0 0 2px; }
  .sub { color: #666; font-size: 12px; margin-bottom: 14px; }
  ol { list-style: none; padding: 0; margin: 0; }
  .q { padding: 10px 0; border-bottom: 1px dashed #ccc; break-inside: avoid; page-break-inside: avoid; }
  .q-no { font-weight: 700; margin-right: 4px; }
  .q-kp { color: #888; font-size: 11px; }
  .q-blank { height: 68px; margin-top: 6px; border: 1px dashed #ddd; border-radius: 4px; }
  .foot { position: fixed; bottom: 6mm; left: 0; right: 0; text-align: center; color: #999; font-size: 10px; }
</style></head><body>
  <h1>${esc(meta.title)}</h1>
  <div class="sub">${esc(meta.childName)} · ${esc(meta.dateLabel)}</div>
  <ol>${rows || '<li class="q"><div class="q-stem">（暂无错题）</div></li>'}</ol>
  <div class="foot">${esc(meta.childName)} · ${esc(meta.dateLabel)}</div>
</body></html>`
}

/**
 * Browser/prototype-only HTML print helper. Desktop formal printing is rejected here and must
 * use the canonical PDF + PDFKit path below.
 */
async function printHtml(html: string): Promise<boolean> {
  if (isTauri()) throw new Error('桌面正式打印必须使用服务端 PDF 与原生 PDFKit')
  if (typeof document === 'undefined') return false
  const iframe = document.createElement('iframe')
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0'
  document.body.appendChild(iframe)
  const doc = iframe.contentWindow?.document
  if (!doc) {
    iframe.remove()
    return false
  }
  doc.open()
  doc.write(html)
  doc.close()
  const win = iframe.contentWindow!
  win.focus()
  win.print()
  setTimeout(() => iframe.remove(), 1000)
  return true
}

export interface NativePrintReceipt {
  status: 'printed' | 'cancelled' | 'failed' | 'outcome_unknown'
  native_job_id: string
  native_receipt_id?: string
  printer_snapshot: Record<string, unknown>
  failure_kind?: string
  failure_detail?: string
}

const MAX_NATIVE_PRINT_PDF_BYTES = 32 * 1024 * 1024

function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

async function printablePdfBase64(pdf: Blob): Promise<string> {
  if (pdf.size === 0) throw new Error('打印 PDF 不能为空')
  if (pdf.size > MAX_NATIVE_PRINT_PDF_BYTES) {
    throw new Error(`打印 PDF 过大 ${pdf.size} > ${MAX_NATIVE_PRINT_PDF_BYTES} 字节`)
  }
  const bytes = new Uint8Array(await pdf.arrayBuffer())
  if (
    bytes.length < 5 ||
    bytes[0] !== 0x25 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x44 ||
    bytes[3] !== 0x46 ||
    bytes[4] !== 0x2d
  ) {
    throw new Error('打印内容不是有效的 PDF 文档')
  }
  return bytesToBase64(bytes)
}

async function printPdfWithReceipt(pdf: Blob): Promise<NativePrintReceipt> {
  const localJobId = () =>
    `desktop-print-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`
  const localOutcome = (
    status: 'failed' | 'outcome_unknown',
    failureKind: string,
    failureDetail: string,
  ): NativePrintReceipt => ({
    status,
    native_job_id: localJobId(),
    printer_snapshot: { adapter: 'desktop-native-bridge', platform: 'desktop' },
    failure_kind: failureKind,
    failure_detail: failureDetail,
  })

  if (!isTauri()) {
    return localOutcome('failed', 'native_print_unavailable', '正式打印需要桌面原生系统打印对话框')
  }
  let pdfBase64: string
  try {
    pdfBase64 = await printablePdfBase64(pdf)
  } catch (error) {
    return localOutcome(
      'failed',
      'pdf_preflight_failed',
      error instanceof Error ? error.message : String(error),
    )
  }

  let result: unknown
  try {
    result = await invoke<unknown>('native_print_pdf', { pdfBase64 })
  } catch (error) {
    return localOutcome(
      'outcome_unknown',
      'native_result_unavailable',
      error instanceof Error ? error.message : String(error),
    )
  }
  if (!isNativePrintReceipt(result)) {
    return localOutcome(
      'outcome_unknown',
      'native_result_unverifiable',
      '原生打印适配器未返回可验证的 PrintJob 回执',
    )
  }
  return result
}

function isNativePrintReceipt(value: unknown): value is NativePrintReceipt {
  if (!value || typeof value !== 'object') return false
  const receipt = value as Partial<NativePrintReceipt>
  if (!['printed', 'cancelled', 'failed', 'outcome_unknown'].includes(receipt.status ?? '')) return false
  if (!receipt.native_job_id?.trim()) return false
  if (
    !receipt.printer_snapshot ||
    typeof receipt.printer_snapshot !== 'object' ||
    Array.isArray(receipt.printer_snapshot) ||
    Object.keys(receipt.printer_snapshot).length === 0
  )
    return false
  if (receipt.status === 'printed') return Boolean(receipt.native_receipt_id?.trim())
  if (receipt.status === 'failed' || receipt.status === 'outcome_unknown') {
    return Boolean(receipt.failure_kind?.trim())
  }
  return true
}

/** 浏览器/prototype 打印错题卷；Desktop 正式入口必须先走持久 PDF 预览控制器。 */
export async function printWorksheet(items: RecordItem[], meta: WorksheetMeta): Promise<boolean> {
  const html = buildWorksheetHtml(items, meta)
  return printHtml(html)
}

// ── 练习卷（题目卷/答案卷）打印（§4.13 呈现物真实渲染，2026-07-18）────────
/**
 * 把后端渲染的练习卷 Markdown（§4.13 受控文法：# 标题 / N. 题目 / **粗体** / --- 作答线 / 普通行）
 * 转成浏览器开发态 A4 HTML。只处理卷面文法，不是通用 Markdown 解析器；Desktop 正式打印
 * 不调用此函数，而是消费服务端 canonical PDF。
 */
export function buildPracticePaperHtml(markdown: string, title: string): string {
  const body = markdown
    .split('\n')
    .map((line) => {
      const t = line.trim()
      if (!t) return ''
      if (t.startsWith('# ')) return `<h1>${esc(t.slice(2))}</h1>`
      if (t === '---') return '<div class="ansline"></div>'
      const inline = esc(t).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      if (/^\d+\.\s/.test(t)) return `<p class="q">${inline}</p>`
      if (/^第 \d+\/\d+ 页/.test(t)) return `<p class="foot">${inline}</p>`
      return `<p>${inline}</p>`
    })
    .join('\n')
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>${esc(title)}</title>
<style>
  @page { size: A4; margin: 18mm 16mm 20mm; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif; color: #111; font-size: 13px; line-height: 1.7; }
  h1 { font-size: 18px; margin: 0 0 6px; }
  .q { font-weight: 600; margin: 14px 0 4px; break-inside: avoid; page-break-inside: avoid; }
  .ansline { height: 26px; border-bottom: 1px solid #bbb; margin: 0 0 4px; }
  .foot { color: #999; font-size: 10px; text-align: center; margin: 18px 0; page-break-after: always; }
  .foot:last-child { page-break-after: auto; }
</style></head><body>${body}</body></html>`
}

/**
 * 浏览器/prototype 打印练习卷。Desktop 正式入口必须先由唯一服务端渲染器生成可见
 * PDF 预览，再通过 printPracticePaperWithReceipt 将同一 Blob 交给 PDFKit。
 */
export async function printPracticePaper(markdown: string, title: string): Promise<boolean> {
  const html = buildPracticePaperHtml(markdown, title)
  return printHtml(html)
}

/**
 * Durable PrintJob bridge. The Blob must be the exact PDF already rendered for preview/save.
 * This entry point never accepts Markdown/HTML and fails closed unless the native adapter returns
 * a typed operation receipt suitable for the backend PrintJob event ledger.
 */
export async function printPracticePaperWithReceipt(
  pdf: Blob,
): Promise<NativePrintReceipt> {
  return printPdfWithReceipt(pdf)
}

// ── 备课卡打印 ──────────────────────────────────────────────
export interface PrepSection { title: string; content: string; source_label: string }
export interface PrepCard { knowledge_points: string[]; sections: PrepSection[] }

export function buildPrepCardHtml(card: PrepCard, meta: { title: string; gradeLabel: string }): string {
  const kps = card.knowledge_points.map((k) => esc(k)).join(' · ')
  const secs = card.sections
    .map(
      (s) => `<section class="sec">
        <div class="sec-head"><span class="sec-title">${esc(s.title)}</span>${s.source_label ? `<span class="sec-src">${esc(s.source_label)}</span>` : ''}</div>
        <div class="sec-body">${esc(s.content).replace(/\n/g, '<br>')}</div>
      </section>`,
    )
    .join('\n')
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>${esc(meta.title)} · ${esc(meta.gradeLabel)}</title>
<style>
  @page { size: A4; margin: 18mm 16mm 20mm; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif; color: #111; font-size: 13px; line-height: 1.6; }
  h1 { font-size: 18px; margin: 0 0 2px; }
  .sub { color: #666; font-size: 12px; margin-bottom: 14px; }
  .sec { padding: 10px 0; border-bottom: 1px dashed #ccc; break-inside: avoid; page-break-inside: avoid; }
  .sec-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 4px; }
  .sec-title { font-weight: 700; }
  .sec-src { color: #888; font-size: 11px; }
</style></head><body>
  <h1>${esc(meta.title)}</h1>
  <div class="sub">${esc(meta.gradeLabel)}${kps ? ` · ${kps}` : ''}</div>
  ${secs || '<section class="sec"><div class="sec-body">（暂无内容）</div></section>'}
</body></html>`
}

/** 备课卡纯文本（供「发到手机」复制到剪贴板：家长粘贴进手机 IM/备忘）。 */
export function prepCardToText(card: PrepCard, meta: { title: string; gradeLabel: string }): string {
  const head = `【${meta.title}】${meta.gradeLabel}${card.knowledge_points.length ? ` · ${card.knowledge_points.join(' · ')}` : ''}`
  const body = card.sections
    .map((s) => `\n${s.title}${s.source_label ? `（${s.source_label}）` : ''}\n${s.content}`)
    .join('\n')
  return `${head}\n${body}`.trim()
}

/** Canonical printable source frozen by the backend generic PrintJob. */
export function prepCardToMarkdown(
  card: PrepCard,
  meta: { title: string; gradeLabel: string },
): string {
  const lines = [`# ${meta.title}`, '', meta.gradeLabel]
  if (card.knowledge_points.length) lines.push('', `知识点：${card.knowledge_points.join(' · ')}`)
  for (const section of card.sections) {
    lines.push('', `**${section.title}**`)
    if (section.source_label) lines.push('', section.source_label)
    lines.push('', section.content)
  }
  return lines.join('\n').trim()
}

/** 浏览器/prototype 打印备课卡；Desktop 正式入口必须先走持久 PDF 预览控制器。 */
export async function printPrepCard(card: PrepCard, meta: { title: string; gradeLabel: string }): Promise<boolean> {
  return printHtml(buildPrepCardHtml(card, meta))
}

/** 触发浏览器下载一个文件 */
export async function download(filename: string, content: string, mime: string): Promise<boolean> {
  // BUG-20260712-#6：Tauri WKWebView 里 `<a download>` / blob URL 不触发下载（点了没反应）。
  // 桌面端走原生 Save 对话框 + Rust 写盘（downloadInApp）；浏览器/dev 保留 blob 下载。
  if (isTauri()) {
    const b64 = btoa(unescape(encodeURIComponent(content))) // UTF-8 安全 base64（中文内容）
    return (await downloadInApp(`data:${mime};base64,${b64}`, filename)) !== null
  }
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
  return true
}

/** 文件名：{称呼}_错题本_{起}_{止}.{ext} */
export function worksheetFilename(childName: string, kind: string, from: string, to: string, ext: string): string {
  return `${childName}_${kind}_${from}_${to}.${ext}`
}

/** 导出 Word（.doc）：HTML 内容，Word 可直接打开（无需 docx 依赖） */
export async function exportWord(items: RecordItem[], meta: WorksheetMeta, filename: string): Promise<void> {
  const html = buildWorksheetHtml(items, meta)
  // Word 识别带 MS Office 命名空间的 HTML；application/msword + .doc 后缀即可
  await download(filename, html, 'application/msword')
}

/** 从错题记录生成错题卷 Markdown（供后端 pandoc 渲染真 PDF；pandoc 读 markdown，不认 raw HTML）。 */
export function buildWorksheetMarkdown(items: RecordItem[], meta: WorksheetMeta): string {
  const lines: string[] = [`# ${meta.title}`, '', `${meta.childName} · ${meta.dateLabel}`, '']
  if (items.length === 0) {
    lines.push('（暂无错题）')
  } else {
    items.forEach((it, i) => {
      const q = String(it.fields.question ?? '')
      const kp = String(it.fields.knowledge_point ?? '').replace(/[·・]\s*$/, '').trim()
      lines.push(`${i + 1}. ${q}${kp ? `  【${kp}】` : ''}`)
      // Markdown thematic break 会被 Pandoc/Typst 渲染成不可换行的矢量横线。
      // 禁用重复全角下划线：版心稍窄时文本会折成“长线 + 残余短线”。
      const answerLine = '---'
      lines.push('', '**答：**', '', answerLine, '', answerLine, '', answerLine, '')
    })
  }
  return lines.join('\n')
}

/** Blob → base64（分块避免 String.fromCharCode 参数过多；供 downloadInApp 的 data: URL 用）。 */
async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  return bytesToBase64(bytes)
}

function safePdfFilename(title: string): string {
  const base = title.replace(/[\\/:*?"<>|]/g, '_').trim() || 'HexClaw'
  return `${base}.pdf`
}

export interface ArchiveDocumentExport {
  content: string
  format: 'pdf' | 'docx'
  title: string
  filename: string
}

/** 将同一份服务端 canonical Markdown 渲染并保存为 PDF / DOCX。 */
export async function exportArchiveDocument(options: ArchiveDocumentExport): Promise<boolean> {
  const { content, format, title, filename } = options
  const blob = await renderDocument({ content, format, title })
  const mime = format === 'pdf'
    ? 'application/pdf'
    : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  if (isTauri()) {
    const b64 = await blobToBase64(blob)
    return (await downloadInApp(`data:${mime};base64,${b64}`, filename)) !== null
  }
  if (typeof document === 'undefined') return false
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
  return true
}

async function saveRenderedPdf(content: string, title: string, filename = safePdfFilename(title)): Promise<boolean> {
  return exportArchiveDocument({ content, format: 'pdf', title, filename })
}

/** 练习卷/观察练习卡另存 PDF；独立于 PrintJob，不得写打印成功。 */
export function savePracticePaperPdf(markdown: string, title: string): Promise<boolean> {
  return saveRenderedPdf(markdown, title)
}

/** 正式打印预览与保存 PDF 共用同一服务端 PDF 渲染结果，避免出现两套分页规则。 */
export function renderPracticePaperPdf(markdown: string, title: string): Promise<Blob> {
  return renderDocument({ content: markdown, format: 'pdf', title })
}

/**
 * 导出 PDF。
 * 项-7 治本：Tauri（桌面 WKWebView）下 iframe 打印失效——把错题卷 Markdown 发给后端
 * `/api/v1/render`（pandoc + typst）生成**真 .pdf** 字节 → 原生 Save 对话框写盘（不再兜底 .html）。
 * 非 Tauri（浏览器/dev）保留原逻辑：打印对话框另存为 PDF。
 */
export async function exportPdf(items: RecordItem[], meta: WorksheetMeta): Promise<boolean> {
  if (isTauri()) {
    const md = buildWorksheetMarkdown(items, meta)
    return saveRenderedPdf(md, meta.title, worksheetExportFilename(meta, 'pdf'))
  }
  return printWorksheet(items, meta)
}
