import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = path.resolve(__dirname, '..')

function source(relativePath: string): string {
  return fs.readFileSync(path.join(SRC, relativePath), 'utf8')
}

describe('desktop page density and responsive style contracts', () => {
  it('keeps provider model capsules dense and capability labels on one line', () => {
    const settings = source('views/SettingsView.vue')

    expect(settings).toMatch(
      /\.hc-model-chips\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(min\(100%,\s*172px\),\s*1fr\)\)/s,
    )
    expect(settings).toMatch(/\.hc-model-chip__cap\s*\{[^}]*white-space:\s*nowrap/s)
    expect(settings).toMatch(/\.hc-model-chip__name\s*\{[^}]*flex:\s*1 1 auto/s)
    expect(settings).toMatch(
      /\.hc-model-chip__free-label\s*\{[^}]*flex:\s*none[^}]*white-space:\s*nowrap/s,
    )
    expect(settings).toMatch(
      /\.hc-model-chip__cap\s*\{[^}]*flex:\s*none[^}]*white-space:\s*nowrap/s,
    )
  })

  it('renders the MCP marketplace as the prototype adaptive card grid', () => {
    const mcp = source('views/McpView.vue')

    expect(mcp).toContain('class="hc-mcp-market-grid"')
    expect(mcp).toContain('class="hc-mcp-market-card"')
    expect(mcp).toMatch(
      /\.hc-mcp-market-grid\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(min\(220px,\s*100%\),\s*1fr\)\)/s,
    )
  })

  it('uses component-width breakpoints for semantic index and agent grids', () => {
    const semanticIndex = source('components/knowledge/SemanticIndexCard.vue')
    const agents = source('views/AgentsView.vue')

    expect(semanticIndex).toMatch(/\.kb-index-card\s*\{[^}]*container-type:\s*inline-size/s)
    expect(semanticIndex).toContain('@container (max-width: 520px)')
    expect(agents).toContain('class="hc-agents__content flex-1 overflow-y-auto"')
    expect(agents).toMatch(/\.hc-agents__content\s*\{[^}]*container-type:\s*inline-size/s)
    expect(agents).toContain('@container (max-width: 720px)')
  })

  it('aligns semantic index with the memory settings disclosure shell', () => {
    const semanticIndex = source('components/knowledge/SemanticIndexCard.vue')

    expect(semanticIndex).toMatch(/\.kb-index-card\s*\{[^}]*width:\s*100%[^}]*max-width:\s*none/s)
    expect(semanticIndex).toMatch(
      /\.kb-index-card__header\s*\{[^}]*gap:\s*6px[^}]*padding:\s*0[^}]*border:\s*0[^}]*background:\s*transparent[^}]*font-size:\s*12px/s,
    )
    expect(semanticIndex).toMatch(
      /\.kb-index-card__body\s*\{[^}]*gap:\s*14px[^}]*margin-top:\s*10px[^}]*padding:\s*14px[^}]*border:\s*0\.5px solid var\(--hc-border\)[^}]*border-radius:\s*var\(--hc-radius-lg/s,
    )
  })

  it('keeps creative-work previews fixed and puts full review content in the approved modal', () => {
    const works = source('features/k12/views/K12CreativeWorksPanel.vue')

    expect(works).toMatch(/\.k12cw__card\s*\{[^}]*align-items:\s*start/s)
    expect(works).toMatch(/\.k12cw__preview\s*\{[^}]*height:\s*112px/s)
    expect(works).not.toContain('.k12cw__card--expanded')
    expect(works).toContain('class="k12cw-detail-modal"')
  })
})
