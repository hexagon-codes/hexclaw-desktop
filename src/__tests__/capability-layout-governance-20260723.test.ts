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
    const toolbar = source('components/common/PageToolbar.vue')
    const skillsMarketplace = skills.slice(skills.indexOf('<!-- ════════ ClawHub 市场 Tab'), skills.indexOf('<SkillCreateDialog'))
    const mcpMarketplace = mcp.slice(mcp.indexOf('<!-- Marketplace Tab -->'), mcp.indexOf('<!-- Add Server Dialog -->'))

    expect(integration).toContain(':search-value="integrationSearch"')
    expect(integration).toContain(':fixed-search="true"')
    expect(integration.match(/@search-context-change=/g)).toHaveLength(2)
    expect(integration).toContain('activeSearchContext')
    expect(toolbar).toContain('fixedSearch')
    expect(toolbar).toContain('hc-toolbar__search--fixed')

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

  it('uses one content-width marketplace grid with fixed 4→3→2→1 columns at approved track breakpoints', () => {
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
    expect(marketGrid).toMatch(/grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/)
    expect(marketGrid).toMatch(/gap:\s*12px/)
    expect(marketGrid).not.toMatch(/auto-(?:fill|fit)/)

    const breakpointColumns = [
      ...global.matchAll(
        /@container\s+capability-track\s*\(max-width:\s*(\d+)px\)\s*\{\s*\.hc-capability-market-grid\s*\{([^}]*)\}\s*\}/g,
      ),
    ]
      .map((match) => ({
        minWidth: Number(match[1]),
        columns: Number((match[2] ?? '').match(/repeat\((\d+),/)?.[1]),
      }))
      .filter((entry) => Number.isFinite(entry.columns))
      .sort((a, b) => b.minWidth - a.minWidth)

    expect(breakpointColumns).toEqual([
      { minWidth: 1040, columns: 3 },
      { minWidth: 760, columns: 2 },
      { minWidth: 500, columns: 1 },
    ])
    expect(global).not.toMatch(/@container\s*\(min-width:\s*(?:640|960|1280)px\)/)
    expect(skills).not.toContain('lg:grid-cols-3')
  })

  it('shares the approved installed-row visual primitive across Skills and MCP views', () => {
    const skills = source('views/SkillsView.vue')
    const mcp = source('views/McpView.vue')
    const global = source('assets/styles/global.css')
    const track = cssBlock(global, '.hc-capability-installed-track')
    const row = cssBlock(global, '.hc-capability-installed-row')

    expect(track).toMatch(/display:\s*flex/)
    expect(track).toMatch(/flex-direction:\s*column/)
    expect(track).toMatch(/gap:\s*8px/)
    expect(row).toMatch(/box-sizing:\s*border-box/)
    expect(row).toMatch(/display:\s*grid/)
    expect(row).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/)
    expect(row).toMatch(/gap:\s*12px\s+18px/)
    expect(row).toMatch(/align-items:\s*center/)
    expect(row).toMatch(/border:\s*0\.5px\s+solid\s+var\(--hc-border\)/)
    expect(row).toMatch(/background:\s*var\(--hc-bg-card\)/)
    expect(row).toMatch(/border-radius:\s*14px/)
    expect(row).toMatch(/padding:\s*12px\s+14px/)
    expect(row).toMatch(/min-width:\s*0/)
    expect(global).toMatch(/\.hc-capability-installed-main\s*\{[\s\S]*?display:\s*flex[\s\S]*?flex-direction:\s*column[\s\S]*?gap:\s*6px/)
    expect(global).toMatch(/\.hc-capability-installed-actions\s*\{[\s\S]*?display:\s*flex[\s\S]*?align-items:\s*center[\s\S]*?justify-content:\s*flex-end[\s\S]*?gap:\s*8px[\s\S]*?min-width:\s*max-content/)
    expect(skills).toContain('class="hc-capability-installed-main"')
    expect(skills).toContain('class="hc-capability-installed-actions"')
    expect(skills).toContain('class="hc-capability-installed-meta"')
    expect(skills).toContain('class="hc-capability-installed-header"')
    expect(skills).toContain('class="hc-capability-installed-pills"')
    expect(skills).toContain('class="hc-capability-installed-description"')
    expect(skills).toContain('class="hc-capability-installed-pill"')
    expect(skills).toContain('class="hc-capability-installed-icon"')
    expect(skills).toContain('class="hc-capability-installed-name"')
    expect(skills).toContain('class="hc-capability-installed-toggle"')
    expect(global).toMatch(
      /\.hc-capability-installed-icon\s*\{[\s\S]*?width:\s*38px[\s\S]*?height:\s*38px[\s\S]*?border-radius:\s*10px/,
    )
    expect(cssBlock(global, '.hc-capability-installed-server-description')).toMatch(
      /margin:\s*0/,
    )
    expect(global).toMatch(
      /\.hc-capability-installed-name\s*\{[\s\S]*?font-size:\s*14px[\s\S]*?font-weight:\s*600[\s\S]*?line-height:\s*21px/,
    )
    expect(global).toMatch(
      /\.hc-capability-installed-header\s*\{[\s\S]*?display:\s*flex[\s\S]*?align-items:\s*center[\s\S]*?gap:\s*12px/,
    )
    expect(global).toMatch(
      /\.hc-capability-installed-pill\s*\{[\s\S]*?padding:\s*2px\s+7px[\s\S]*?font-size:\s*11px[\s\S]*?line-height:\s*1\.5/,
    )
    expect(cssBlock(global, '.hc-capability-installed-meta')).toMatch(
      /color:\s*var\(--hc-text-secondary\)/,
    )
    expect(cssBlock(global, '.hc-capability-installed-pill')).toMatch(
      /background:\s*var\(--hc-bg-active\)/,
    )
    expect(global).toMatch(
      /\.hc-capability-installed-toggle\s*\{[\s\S]*?position:\s*relative[\s\S]*?width:\s*34px[\s\S]*?height:\s*20px[\s\S]*?flex:\s*0\s+0\s+34px[\s\S]*?margin:\s*3px\s+3px\s+3px\s+4px/,
    )
    expect(classAttributesContaining(mcp, 'hc-capability-installed-main')).toHaveLength(2)
    expect(classAttributesContaining(mcp, 'hc-capability-installed-actions')).toHaveLength(2)
    expect(global).toMatch(
      /\.hc-capability-installed-main--row\s*\{[\s\S]*?flex-direction:\s*row[\s\S]*?align-items:\s*center[\s\S]*?gap:\s*10px/,
    )
    expect(global).toMatch(
      /\.hc-capability-installed-expanded\s*\{[\s\S]*?grid-column:\s*1\s*\/\s*-1/,
    )
    expect(cssBlock(global, '.hc-capability-installed-row--tool')).toMatch(
      /column-gap:\s*10px/,
    )
    expect(global).toMatch(
      /\.hc-capability-content-pad\s*\{[\s\S]*?padding:\s*16px\s+26px\s+48px/,
    )
    expect(classAttributesContaining(skills, 'hc-capability-content-pad')).toHaveLength(1)
    expect(classAttributesContaining(mcp, 'hc-capability-content-pad')).toHaveLength(1)
    expect(classAttributesContaining(skills, 'hc-capability-installed-row')).toHaveLength(1)
    expect(classAttributesContaining(mcp, 'hc-capability-installed-row')).toHaveLength(2)
    expect(classAttributesContaining(mcp, 'hc-capability-installed-track--mcp')).toHaveLength(2)
  })
})
