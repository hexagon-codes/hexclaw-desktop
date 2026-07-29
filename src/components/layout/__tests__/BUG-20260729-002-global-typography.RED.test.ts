import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const prototype = readFileSync(
  resolve(__dirname, '../../../../../hexclaw-docs/prototype/app.html'),
  'utf8',
)
const globalCSS = readFileSync(resolve(__dirname, '../../../assets/styles/global.css'), 'utf8')

function globalBaseBlock(source: string): string {
  return source.match(/html,\s*body,\s*#app\s*\{([^}]*)\}/)?.[1] ?? ''
}

describe('BUG-20260729-002 — global typography matches the approved prototype baseline', () => {
  it('uses the prototype 14px root font size', () => {
    expect(prototype).toMatch(/body\s*\{[\s\S]*?font-size:\s*14px/)
    expect(globalBaseBlock(globalCSS)).toContain('font-size: 14px;')
  })

  it('uses the prototype 1.5 root line height', () => {
    expect(prototype).toMatch(/body\s*\{[\s\S]*?line-height:\s*1\.5/)
    expect(globalBaseBlock(globalCSS)).toContain('line-height: 1.5;')
  })
})
