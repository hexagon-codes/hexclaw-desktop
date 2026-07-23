/**
 * Prompt 预览只负责 `$ARGUMENTS` / `{{var}}` 占位投影。
 *
 * Markdown 解析、KaTeX 与安全消毒必须由 MarkdownRenderer 统一完成；这里先把占位
 * 替换为不会参与 Markdown 语法的哨兵，渲染后再恢复为 `.hc-arg`。
 */

/** 占位：`$ARGUMENTS`（命令填参）或 `{{name}}`（具名变量）。 */
const ARG_RE = /\$ARGUMENTS\b|\{\{\s*[\w.-]+\s*\}\}/g
const SENTINEL_START = '\u{e000}'
const SENTINEL_END = '\u{e001}'

export interface PromptPreviewProjection {
  markdown: string
  args: string[]
  sentinelPrefix: string
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 抽取正文里出现的全部去重占位（保持首次出现顺序）。 */
export function extractPromptArgs(body: string): string[] {
  const seen = new Set<string>()
  for (const match of String(body ?? '').matchAll(ARG_RE)) seen.add(match[0])
  return [...seen]
}

/**
 * 把 Prompt 正文投影为可交给共享 MarkdownRenderer 的 Markdown。
 *
 * sentinelPrefix 会避开原文中已经存在的私有区字符组合，避免用户文本被误恢复。
 */
export function projectPromptPreview(body: string): PromptPreviewProjection {
  const source = String(body ?? '')
  let nonce = 0
  let sentinelPrefix = `${SENTINEL_START}hc-prompt-arg:${nonce}:`
  while (source.includes(sentinelPrefix)) {
    nonce++
    sentinelPrefix = `${SENTINEL_START}hc-prompt-arg:${nonce}:`
  }

  const args: string[] = []
  const markdown = source.replace(ARG_RE, (match) => {
    const index = args.length
    args.push(match)
    return `${sentinelPrefix}${index}${SENTINEL_END}`
  })

  return { markdown, args, sentinelPrefix }
}

/**
 * 将共享 MarkdownRenderer 产出的 HTML 中的哨兵恢复为占位高亮。
 *
 * 返回值仍须经过 MarkdownRenderer 的 DOMPurify；此函数不承担安全边界。
 */
export function decoratePromptPreviewHtml(
  html: string,
  projection: PromptPreviewProjection,
): string {
  if (projection.args.length === 0) return html
  const sentinelPattern = new RegExp(
    `${escapeRegExp(projection.sentinelPrefix)}(\\d+)${SENTINEL_END}`,
    'g',
  )
  return html.replace(sentinelPattern, (sentinel, rawIndex: string) => {
    const argumentValue = projection.args[Number(rawIndex)]
    if (argumentValue === undefined) return sentinel
    return `<span class="hc-arg">${escapeHtml(argumentValue)}</span>`
  })
}
