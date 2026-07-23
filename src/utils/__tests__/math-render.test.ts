import { describe, expect, it } from 'vitest'
import { isKatexParseError, renderKatexToHtml } from '../math-render'

describe('shared math-render adapter', () => {
  it('统一应用可访问输出、安全尺寸上限与 mhchem 扩展', () => {
    const fraction = renderKatexToHtml(String.raw`\frac{3}{4}`, false)
    expect(fraction).toContain('katex-mathml')
    expect(fraction).toContain('katex-html')

    const capped = renderKatexToHtml(String.raw`\rule{1em}{100000em}`, false)
    const probe = document.createElement('div')
    probe.innerHTML = capped
    const visualHtml = probe.querySelector('.katex-html')!.innerHTML
    expect(visualHtml).not.toContain('100000em')
    expect(visualHtml).toContain('20em')

    const chemistry = renderKatexToHtml(String.raw`\ce{H2O}`, false)
    expect(chemistry).toContain('<mi mathvariant="normal">H</mi>')
    expect(chemistry).toContain('<mi mathvariant="normal">O</mi>')
  })

  it('将 ParseError 作为可判定错误交还调用边界，不生成伪成功 HTML', () => {
    let thrown: unknown
    try {
      renderKatexToHtml(String.raw`\frac{1}`, false)
    } catch (error) {
      thrown = error
    }

    expect(isKatexParseError(thrown)).toBe(true)
  })
})
