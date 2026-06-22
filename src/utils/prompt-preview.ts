/**
 * Prompt 库正文预览：Markdown 渲染 + `$ARGUMENTS` / `{{var}}` 占位高亮 + 安全消毒。
 *
 * 纯函数，承载可被不变量测试钉死的逻辑（占位全部高亮 / 无脚本注入 / 确定性）。
 * 复用项目既有依赖 markdown-it + DOMPurify（与 MarkdownRenderer.vue 同源），不另造渲染器。
 *
 * ⚠️ 预览仅供阅读：模型看到的是 textarea 原始正文，不是这里渲染后的 HTML。
 */
import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'

/** 占位：`$ARGUMENTS`（命令填参）或 `{{name}}`（具名变量）。 */
const ARG_RE = /\$ARGUMENTS\b|\{\{\s*[\w.-]+\s*\}\}/g

// 私有区哨兵（U+E000 / U+E001）：用户正文不可能输入，且非 markdown 特殊字符，渲染期原样穿透。
const SENT_L = String.fromCharCode(0xe000)
const SENT_R = String.fromCharCode(0xe001)
const SENT_RE = new RegExp(`${SENT_L}(\\d+)${SENT_R}`, 'g')

const md = new MarkdownIt({ html: false, linkify: true, breaks: true })

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 抽取正文里出现的全部去重占位（保持首次出现顺序）。 */
export function extractPromptArgs(body: string): string[] {
  const seen = new Set<string>()
  for (const m of String(body ?? '').matchAll(ARG_RE)) seen.add(m[0])
  return [...seen]
}

/**
 * 渲染 Prompt 正文为安全 HTML：占位用 `<span class="hc-arg">` 高亮。
 *
 * 步骤：先把占位换成哨兵 token（避开 markdown 转义/解析），渲染后换回高亮 span，最后 DOMPurify 消毒。
 * 保证：① 输出经 DOMPurify，无 `<script>` / `on*` / `javascript:`；② 每个占位都被 span 包裹。
 */
export function renderPromptPreview(body: string): string {
  const src = String(body ?? '')
  const args: string[] = []
  const tagged = src.replace(ARG_RE, (m) => {
    const i = args.length
    args.push(m)
    return `${SENT_L}${i}${SENT_R}`
  })
  let html = md.render(tagged)
  html = html.replace(
    SENT_RE,
    (_, i: string) => `<span class="hc-arg">${escapeHtml(args[Number(i)]!)}</span>`,
  )
  return DOMPurify.sanitize(html, { ADD_ATTR: ['class'] })
}
