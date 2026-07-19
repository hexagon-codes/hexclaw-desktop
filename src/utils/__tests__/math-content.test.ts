import { describe, expect, it } from 'vitest'
import {
  insertAtSelection,
  normalizeMathMarkdown,
  plainMathSegments,
  readMathClipboard,
} from '../math-content'

function clipboard(plain: string, html = '') {
  return {
    getData: (type: string) => type === 'text/html' ? html : type === 'text/plain' ? plain : '',
  }
}

describe('math content boundary', () => {
  it('canonicalizes supported delimiters, legacy wrappers and Unicode fractions', () => {
    expect(normalizeMathMarkdown(String.raw`\(\frac{3}{4}\)`)).toBe(String.raw`$\frac{3}{4}$`)
    expect(normalizeMathMarkdown(String.raw`(\frac{1}{4})`)).toBe(String.raw`$\frac{1}{4}$`)
    expect(normalizeMathMarkdown('单位是 ¼')).toBe(String.raw`单位是 $\frac{1}{4}$`)
  })

  it('keeps code, currency, URLs and incomplete formulas literal', () => {
    const source = [
      String.raw`代码 \`\(\frac{1}{2}\)\``,
      '```tex',
      String.raw`\[\frac{3}{4}\]`,
      '```',
      '价格 $100，链接 https://example.com/$200，未闭合 $x',
    ].join('\n')
    expect(normalizeMathMarkdown(source)).toBe(source)
    expect(plainMathSegments(source).every((segment) => segment.type === 'text')).toBe(true)
  })

  it('extracts explicit TeX annotations and removes duplicate visual/script content', () => {
    const html = '<p>题目：<span class="katex"><math><semantics><mfrac><mn>3</mn><mn>4</mn></mfrac>'
      + '<annotation encoding="application/x-tex">\\frac{3}{4}</annotation></semantics></math>'
      + '<span aria-hidden="true">duplicate</span></span>。</p><script>alert(1)</script>'
    const result = readMathClipboard(clipboard('fallback', html))
    expect(result).toEqual({ text: String.raw`题目：$\frac{3}{4}$。`, handled: true, source: 'html' })
  })

  it('converts supported MathML without an annotation', () => {
    const result = readMathClipboard(clipboard('3/4', '<p><math><mfrac><mn>3</mn><mn>4</mn></mfrac></math></p>'))
    expect(result.text).toBe(String.raw`$\frac{3}{4}$`)
    expect(result.source).toBe('html')
  })

  it('ignores untrusted rich HTML when it has no explicit math semantics', () => {
    const result = readMathClipboard(clipboard('原始安全文本', '<img src=x onerror=alert(1)><b>伪公式</b>'))
    expect(result).toEqual({ text: '原始安全文本', handled: false, source: 'plain' })
  })

  it('inserts canonical content at the selected range', () => {
    expect(insertAtSelection('前XX后', '$x$', 1, 3)).toEqual({ value: '前$x$后', caret: 4 })
  })
})
