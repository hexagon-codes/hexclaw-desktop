/**
 * 错题卷打印 + 导出（features/k12）· M2-3 打印模板 + M3-5 PDF/Word 导出。
 *
 * 纯前端：从错题记录生成 A4 可打印 HTML（题干 + 答题留白 + page-break 防切题 + 页脚）。
 * PDF = 浏览器打印对话框另存；Word = HTML 内容 .doc（Word 可直接打开，无需额外依赖，砍 CSV/JSON）。
 */
import type { RecordItem } from '@/contracts'
import { isTauri } from '@/utils/platform'
import { downloadInApp } from '@/utils/download'

export interface WorksheetMeta {
  childName: string
  /** 已本地化的标题（如"错题卷"），由调用方传入避免本模块碰 i18n */
  title: string
  /** 页脚日期串 */
  dateLabel: string
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

/** 通过隐藏 iframe 打印（PDF = 打印对话框另存为 PDF）。返回是否成功发起。 */
export async function printWorksheet(items: RecordItem[], meta: WorksheetMeta): Promise<boolean> {
  if (typeof document === 'undefined') return false
  const html = buildWorksheetHtml(items, meta)
  // BUG-E：Tauri macOS WKWebView 里 iframe `window.print()` 是 no-op（同 BUG-20260712-#6 `<a download>` 失效）。
  // 桌面端把 HTML 经原生 Save 对话框 + Rust 写盘存成文件，用户用系统预览/浏览器打开后打印。
  if (isTauri()) {
    const b64 = btoa(unescape(encodeURIComponent(html))) // UTF-8 安全 base64（中文题干）
    await downloadInApp(`data:text/html;base64,${b64}`, `${meta.title}.html`)
    return true
  }
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
  // 打印对话框关闭后清理（延迟以覆盖同步/异步打印实现）
  setTimeout(() => iframe.remove(), 1000)
  return true
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

/** 打印备课卡（隐藏 iframe 打印，同 printWorksheet）。返回是否成功发起。 */
export async function printPrepCard(card: PrepCard, meta: { title: string; gradeLabel: string }): Promise<boolean> {
  if (typeof document === 'undefined') return false
  // BUG-E：Tauri macOS WKWebView 里 iframe `window.print()` 是 no-op（同 printWorksheet）。
  // 桌面端把 HTML 经原生 Save 对话框 + Rust 写盘存成文件，用户用系统预览/浏览器打开后打印。
  if (isTauri()) {
    const html = buildPrepCardHtml(card, meta)
    const b64 = btoa(unescape(encodeURIComponent(html))) // UTF-8 安全 base64（中文内容）
    await downloadInApp(`data:text/html;base64,${b64}`, `${meta.title}.html`)
    return true
  }
  const iframe = document.createElement('iframe')
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0'
  document.body.appendChild(iframe)
  const doc = iframe.contentWindow?.document
  if (!doc) {
    iframe.remove()
    return false
  }
  doc.open()
  doc.write(buildPrepCardHtml(card, meta))
  doc.close()
  const win = iframe.contentWindow!
  win.focus()
  win.print()
  setTimeout(() => iframe.remove(), 1000)
  return true
}

/** 触发浏览器下载一个文件 */
export async function download(filename: string, content: string, mime: string): Promise<void> {
  // BUG-20260712-#6：Tauri WKWebView 里 `<a download>` / blob URL 不触发下载（点了没反应）。
  // 桌面端走原生 Save 对话框 + Rust 写盘（downloadInApp）；浏览器/dev 保留 blob 下载。
  if (isTauri()) {
    const b64 = btoa(unescape(encodeURIComponent(content))) // UTF-8 安全 base64（中文内容）
    await downloadInApp(`data:${mime};base64,${b64}`, filename)
    return
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

/** 导出 PDF：走打印对话框另存（WKWebView / 浏览器均支持打印为 PDF） */
export function exportPdf(items: RecordItem[], meta: WorksheetMeta): Promise<boolean> {
  return printWorksheet(items, meta)
}
