import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function source(path: string) {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

describe('2026-07-23 shared button hover stability', () => {
  it('keeps primary button hover geometry stable', () => {
    const css = source('src/assets/styles/global.css')
    const hoverRule = css.match(/\.hc-btn-primary:hover\s*\{([\s\S]*?)\}/)?.[1] ?? ''

    expect(hoverRule).not.toMatch(/transform\s*:/)
  })

  it('keeps split button hover geometry stable', () => {
    const component = source('src/components/common/SplitButton.vue')
    const hoverRule = component.match(/\.hc-split-btn:hover\s*\{([\s\S]*?)\}/)?.[1] ?? ''

    expect(hoverRule).not.toMatch(/transform\s*:/)
  })
})
