import { readFileSync } from 'node:fs'
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

describe('2026-07-26 approved chat task UI contract', () => {
  it('removes only the two private divider lines and preserves the composer border', () => {
    const guard = source('src/features/k12/views/RecognizeGuardPanel.vue')
    const chat = source('src/views/ChatView.vue')
    const composer = source('src/components/chat/ChatInput.vue')

    expect(cssRule(guard, '.rec-panel__footer')).not.toContain('border-top')
    expect(cssRule(chat, '.hc-chat__input-area')).not.toContain('border-top')
    expect(cssRule(composer, '.hc-composer__box')).toContain(
      'border: 0.5px solid var(--hc-border)',
    )
    expect(cssRule(composer, '.hc-composer__box')).toContain('border-radius: 16px')
  })

  it('propagates content updates to the existing non-forced bottom-scroll contract', () => {
    const guard = source('src/features/k12/views/RecognizeGuardPanel.vue')
    const enhancement = source('src/features/k12/views/K12ChatEnhancement.vue')
    const chat = source('src/views/ChatView.vue')

    expect(guard).toContain("(e: 'contentUpdated'): void")
    expect(guard).toContain("emit('contentUpdated')")
    expect(enhancement).toContain("(e: 'contentUpdated'): void")
    expect(enhancement).toContain('@content-updated="emit(\'contentUpdated\')"')
    expect(chat).toContain('@content-updated="handleScenarioContentUpdated"')
    expect(chat).toMatch(
      /function handleScenarioContentUpdated\(\)[\s\S]*?nextTick\(\(\) => scrollToBottom\(false\)\)/,
    )
  })

  it('uses projectionMarkdown as the sole creative-feedback presentation source', () => {
    const renderer = source(
      'src/features/k12/components/CreativeWorkFeedbackRenderer.vue',
    )

    expect(renderer).toContain(':content="projectionMarkdown"')
    expect(renderer).not.toContain(':deep(p)')
    expect(renderer).not.toContain('const evidence = computed')
  })
})
