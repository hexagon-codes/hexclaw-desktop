import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..', '..')

function source(relativePath: string): string {
  const path = join(repoRoot, relativePath)
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

function themeTokenBlock(theme: 'light' | 'dark'): string {
  const presentation = source('src/features/k12/appearance/K12GlobalPresentation.vue')
  return (
    presentation.match(
      new RegExp(
        `:global\\(\\[data-theme='${theme}'] body\\[data-k12-skin-active='k12']\\)\\s*\\{([\\s\\S]*?)\\n\\}`,
      ),
    )?.[1] ?? ''
  )
}

function cardAlpha(theme: 'light' | 'dark'): number {
  const match = themeTokenBlock(theme).match(
    /--hc-bg-card:\s*rgba\(\s*[^,]+,\s*[^,]+,\s*[^,]+,\s*([0-9.]+)\s*\)/,
  )
  return Number(match?.[1] ?? Number.NaN)
}

describe('K12 v9 visual contract · BUG-20260801-005/007/009', () => {
  it('keeps Light and Dark shared card alpha at or above .94', () => {
    expect(cardAlpha('light')).toBeGreaterThanOrEqual(0.94)
    expect(cardAlpha('dark')).toBeGreaterThanOrEqual(0.94)
  })

  it('keeps the existing card surfaces on the shared K12 card token', () => {
    expect(source('src/features/k12/views/K12InsightPanel.vue')).toContain(
      'background: var(--hc-bg-card)',
    )
    expect(source('src/features/k12/views/K12RecordsView.vue')).toContain(
      'background: var(--hc-bg-card)',
    )
  })

  it('turns off blur only for the K12 session column', () => {
    const presentation = source('src/features/k12/appearance/K12GlobalPresentation.vue')
    expect(presentation).toMatch(
      /:global\(body\[data-k12-skin-active='k12'\]\s+\.hc-chat__sidebar\)\s*\{[\s\S]*?-webkit-backdrop-filter:\s*none;[\s\S]*?backdrop-filter:\s*none;/,
    )
  })
})
