import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function source(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8')
}

function cssRule(fileSource: string, selector: string): string {
  const start = fileSource.indexOf(`${selector} {`)
  expect(start, `missing CSS rule ${selector}`).toBeGreaterThanOrEqual(0)
  const end = fileSource.indexOf('\n}', start)
  expect(end, `unterminated CSS rule ${selector}`).toBeGreaterThan(start)
  return fileSource.slice(start, end + 2)
}

describe('BUG-20260726-018 TaskShell shares the ordinary assistant message footer', () => {
  it('uses one canonical MessageFooter component on the ordinary and TaskShell surfaces', () => {
    const componentPath = resolve(process.cwd(), 'src/components/chat/MessageFooter.vue')
    expect(
      existsSync(componentPath),
      'the approved shared MessageFooter component does not exist',
    ).toBe(true)
    if (!existsSync(componentPath)) return

    const chat = source('src/views/ChatView.vue')
    const taskShell = source('src/features/k12/views/RecognizeGuardPanel.vue')
    expect(chat).toContain('<MessageFooter')
    expect(taskShell).toContain('<MessageFooter')
    expect(taskShell).not.toMatch(
      /<footer[\s\S]{0,180}data-testid="task-shell-footer"[\s\S]*?<\/footer>/,
    )
  })

  it('keeps the TaskShell page-private top-divider exact-set empty', () => {
    const taskShell = source('src/features/k12/views/RecognizeGuardPanel.vue')
    const footerRule = cssRule(taskShell, '.rec-panel__footer')
    expect(footerRule).not.toMatch(/border-top|box-shadow/)
    expect(taskShell).not.toMatch(
      /\.rec-panel__footer::(?:before|after)\s*\{[\s\S]*?(?:border|background|box-shadow)/,
    )
  })
})
