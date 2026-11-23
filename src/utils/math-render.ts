import katex from 'katex'
import 'katex/contrib/mhchem'
import { KATEX_RENDER_POLICY, VULGAR_FRACTIONS } from './math-content'

// 让 KaTeX 按语法模式解释分数字符，保留文本命令和逐字环境中的内容。
const vulgarFractionMacros = Object.fromEntries(
  Object.entries(VULGAR_FRACTIONS).map(([symbol, tex]) => {
    const code = symbol.codePointAt(0)!.toString(16).toUpperCase()
    return [symbol, String.raw`\TextOrMath{\char"${code}\relax}{${tex}}`]
  }),
)

/** The sole production adapter allowed to execute KaTeX. */
export function renderKatexToHtml(
  content: string,
  displayMode: boolean,
  options?: { vulgarFractions?: boolean },
): string {
  const katexHtml = katex.renderToString(content, {
    ...KATEX_RENDER_POLICY,
    displayMode,
    ...(options?.vulgarFractions ? { macros: { ...vulgarFractionMacros } } : {}),
  })
  const layoutClass = displayMode
    ? 'hc-math-viewport--display'
    : 'hc-math-viewport--inline'
  return `<span class="hc-math-viewport ${layoutClass}">${katexHtml}</span>`
}

export function isKatexParseError(error: unknown): error is katex.ParseError {
  return error instanceof katex.ParseError
}
