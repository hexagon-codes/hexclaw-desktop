import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = path.resolve(__dirname, '..')

function source(relativePath: string): string {
  return fs.readFileSync(path.join(SRC, relativePath), 'utf8')
}

function cssBlock(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 's'))?.[1] ?? ''
}

function classAttributesContaining(markup: string, token: string): string[] {
  return [...markup.matchAll(/class="([^"]+)"/g)]
    .map((match) => match[1] ?? '')
    .filter((className) => className.split(/\s+/).includes(token))
}

describe('2026-07-23 cross-page layout governance', () => {
  it('layers Knowledge secondary tabs and the complete active panel through one 18px stack', () => {
    const knowledge = source('views/KnowledgeView.vue')
    const stack = cssBlock(knowledge, '.knowledge-page__tab-stack')

    expect(knowledge).toContain('class="knowledge-page__tab-stack"')
    expect(knowledge).toContain('class="knowledge-page__active-panel"')
    expect(knowledge).toMatch(
      /class="knowledge-page__tab-stack"[\s\S]*?<UnderlineTabs[\s\S]*?class="knowledge-page__active-panel"[\s\S]*?knowledge-page__source-filters/,
    )
    expect(stack).toMatch(/display:\s*flex/)
    expect(stack).toMatch(/flex-direction:\s*column/)
    expect(stack).toMatch(/gap:\s*18px/)
    expect(
      classAttributesContaining(knowledge, 'knowledge-page__source-filters').every((className) =>
        className.includes('flex-wrap'),
      ),
    ).toBe(true)
  })

  it('keeps every add-document native control and clearable wrapper on the full form track', () => {
    const knowledge = source('views/KnowledgeView.vue')
    const clearable = source('components/common/HcClearableField.vue')
    const dialogStart = knowledge.indexOf('<!-- 添加文档对话框 -->')
    const dialogEnd = knowledge.indexOf('<!-- 删除确认 -->', dialogStart)
    const addDocumentDialog = knowledge.slice(dialogStart, dialogEnd)
    const controlClasses = [
      ...addDocumentDialog.matchAll(/<(?:input|textarea)\b[^>]*class="([^"]+)"/g),
    ].map((match) => (match[1] ?? '').split(/\s+/))
    const clearableRoot = cssBlock(clearable, '.hc-clearable-field')

    expect(controlClasses).toHaveLength(3)
    for (const classes of controlClasses) {
      expect(classes).toContain('w-full')
      expect(classes).toContain('min-w-0')
    }
    expect(addDocumentDialog.match(/<HcClearableField>/g)).toHaveLength(3)
    expect(clearableRoot).toMatch(/width:\s*100%/)
    expect(clearableRoot).toMatch(/min-width:\s*0/)
  })

  it('uses one shared installed-content track for Skills and both MCP installed views', () => {
    const skills = source('views/SkillsView.vue')
    const mcp = source('views/McpView.vue')
    const global = source('assets/styles/global.css')
    const installedTrack = cssBlock(global, '.hc-capability-installed-track')
    const skillsTracks = classAttributesContaining(skills, 'hc-capability-installed-track')
    const mcpTracks = classAttributesContaining(mcp, 'hc-capability-installed-track')
    const maxWidth = installedTrack.match(/max-width:\s*([^;]+)/)?.[1]?.trim()

    expect(skillsTracks).toHaveLength(1)
    expect(mcpTracks).toHaveLength(2)
    for (const className of [...skillsTracks, ...mcpTracks]) {
      expect(className.split(/\s+/)).not.toContain('max-w-2xl')
    }
    expect(installedTrack).toMatch(/width:\s*100%/)
    expect(installedTrack).toMatch(/min-width:\s*0/)
    expect(maxWidth === undefined || maxWidth === 'none').toBe(true)
  })

  it('keeps the toolbar as the only context-aware search for every Skills and MCP subtab', () => {
    const integration = source('views/IntegrationView.vue')
    const skills = source('views/SkillsView.vue')
    const mcp = source('views/McpView.vue')
    const skillsMarketplace = skills.slice(skills.indexOf('<!-- ════════ ClawHub 市场 Tab'), skills.indexOf('<SkillCreateDialog'))
    const mcpMarketplace = mcp.slice(mcp.indexOf('<!-- Marketplace Tab -->'), mcp.indexOf('<!-- Add Server Dialog -->'))

    expect(integration).toContain(':search-value="integrationSearch"')
    expect(integration.match(/@search-context-change=/g)).toHaveLength(2)
    expect(integration).toContain('activeSearchContext')

    expect(skillsMarketplace).not.toContain('<SearchInput')
    expect(mcpMarketplace).not.toContain('<SearchInput')
    expect(classAttributesContaining(skills, 'hc-capability-market-search')).toHaveLength(0)
    expect(classAttributesContaining(mcp, 'hc-capability-market-search')).toHaveLength(0)

    expect(skills).toMatch(
      /const q = \(props\.embeddedSearch \?\? searchQuery\.value\)\.trim\(\)\.toLowerCase\(\)/,
    )
    expect(mcp).toMatch(
      /const q = \(props\.embeddedSearch \?\? toolSearchQuery\.value\)\.trim\(\)\.toLowerCase\(\)/,
    )
    expect(skills).toMatch(/emit\(\s*'search-context-change'/)
    expect(mcp).toMatch(/emit\(\s*'search-context-change'/)
  })

  it('uses one content-width marketplace grid with fixed 1→2→3→4 columns', () => {
    const skills = source('views/SkillsView.vue')
    const mcp = source('views/McpView.vue')
    const global = source('assets/styles/global.css')
    const marketSurface = cssBlock(global, '.hc-capability-market-surface')
    const marketGrid = cssBlock(global, '.hc-capability-market-grid')

    for (const view of [skills, mcp]) {
      expect(classAttributesContaining(view, 'hc-capability-market-surface')).toHaveLength(1)
      expect(classAttributesContaining(view, 'hc-capability-market-grid')).toHaveLength(1)
    }

    expect(marketSurface).toMatch(/container-type:\s*inline-size/)
    expect(marketSurface).toMatch(/width:\s*100%/)
    expect(marketSurface).toMatch(/min-width:\s*0/)
    expect(marketGrid).toMatch(/display:\s*grid/)
    expect(marketGrid).toMatch(/grid-template-columns:\s*repeat\(1,\s*minmax\(0,\s*1fr\)\)/)
    expect(marketGrid).toMatch(/gap:\s*12px/)
    expect(marketGrid).not.toMatch(/auto-(?:fill|fit)/)

    const breakpointColumns = [
      ...global.matchAll(
        /@container\s*\(min-width:\s*(\d+)px\)\s*\{\s*\.hc-capability-market-grid\s*\{([^}]*)\}\s*\}/g,
      ),
    ]
      .map((match) => ({
        minWidth: Number(match[1]),
        columns: Number((match[2] ?? '').match(/repeat\((\d+),/)?.[1]),
      }))
      .filter((entry) => Number.isFinite(entry.columns))
      .sort((a, b) => a.minWidth - b.minWidth)

    expect(breakpointColumns.map((entry) => entry.columns)).toEqual([2, 3, 4])
    expect(breakpointColumns[0]?.minWidth).toBeLessThan(breakpointColumns[1]?.minWidth ?? 0)
    expect(breakpointColumns[1]?.minWidth).toBeLessThan(1280)
    expect(breakpointColumns[2]).toEqual({ minWidth: 1280, columns: 4 })
    expect(skills).not.toContain('lg:grid-cols-3')
  })
})
