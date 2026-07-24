import katex from 'katex'
import 'katex/contrib/mhchem'
import { KATEX_RENDER_POLICY } from './math-content'

/** The sole production adapter allowed to execute KaTeX. */
export function renderKatexToHtml(content: string, displayMode: boolean): string {
  const katexHtml = katex.renderToString(content, {
    ...KATEX_RENDER_POLICY,
    displayMode,
  })
  const layoutClass = displayMode
    ? 'hc-math-viewport--display'
    : 'hc-math-viewport--inline'
  return `<span class="hc-math-viewport ${layoutClass}">${katexHtml}</span>`
}

export function isKatexParseError(error: unknown): error is katex.ParseError {
  return error instanceof katex.ParseError
}
