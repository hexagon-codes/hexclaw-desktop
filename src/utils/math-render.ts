import katex from 'katex'
import 'katex/contrib/mhchem'
import { KATEX_RENDER_POLICY } from './math-content'

/** The sole production adapter allowed to execute KaTeX. */
export function renderKatexToHtml(content: string, displayMode: boolean): string {
  return katex.renderToString(content, {
    ...KATEX_RENDER_POLICY,
    displayMode,
  })
}

export function isKatexParseError(error: unknown): error is katex.ParseError {
  return error instanceof katex.ParseError
}
