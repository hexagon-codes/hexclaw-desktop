import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const globalCss = readFileSync(resolve(__dirname, '../assets/styles/global.css'), 'utf8')

describe('BUG-20260722 · RTL 容器中的 KaTeX 公式布局', () => {
  it('must isolate KaTeX and its internal span layout from the generic RTL bidi fallback', () => {
    const genericBidi = globalCss.search(/\[dir\s*=\s*['"]rtl['"]\]\s*:is\(/)
    const katexIsolation = globalCss.search(/\[dir\s*=\s*['"]rtl['"]\]\s*\.katex\s*,/)

    expect(genericBidi).toBeGreaterThan(-1)
    expect(katexIsolation).toBeGreaterThan(genericBidi)
    expect(globalCss.slice(katexIsolation, katexIsolation + 500)).toMatch(/\.katex\s*\*/)
    expect(globalCss.slice(katexIsolation, katexIsolation + 500)).toMatch(/direction:\s*ltr/)
    expect(globalCss.slice(katexIsolation, katexIsolation + 500)).toMatch(/unicode-bidi:\s*isolate/)
  })
})
