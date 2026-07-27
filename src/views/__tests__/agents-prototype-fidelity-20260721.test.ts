import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const source = fs.readFileSync(path.resolve(__dirname, '../AgentsView.vue'), 'utf8')

describe('AgentsView authoritative prototype fidelity', () => {
  it('uses the prototype content inset and exact card/chip surface metrics', () => {
    expect(source).toContain('class="hc-agents__content flex-1 overflow-y-auto"')
    expect(source).toMatch(
      /\.hc-agents__content\s*\{[^}]*padding:\s*16px 26px 48px;[^}]*container-type:\s*inline-size/s,
    )
    expect(source).toMatch(
      /\.hc-cxcard\s*\{[^}]*backdrop-filter:\s*saturate\(160%\) blur\(16px\);[^}]*transition:\s*transform 0\.28s var\(--hc-ease-out\),\s*box-shadow 0\.28s var\(--hc-ease-out\),\s*border-color 0\.2s var\(--hc-ease-out\),\s*background 0\.2s var\(--hc-ease-out\);/s,
    )
    expect(source).toMatch(
      /\.hc-cxcard--hero\s*\{[^}]*border:\s*1px solid rgba\(95,\s*179,\s*234,\s*0\.45\)/s,
    )
    expect(source).toMatch(/\.hc-tag\s*\{[^}]*padding:\s*1px 7px/s)
    expect(source).toMatch(/\.hc-pill\s*\{[^}]*white-space:\s*nowrap/s)
    expect(source).toMatch(
      /\.hc-pill--green\s*\{[^}]*background:\s*rgba\(50,\s*213,\s*131,\s*0\.14\)/s,
    )
    expect(source).toMatch(
      /@container \(max-width: 720px\)\s*\{[^}]*\.hc-agents__content\s*\{\s*padding:\s*14px 16px 40px;/s,
    )
  })

  it('keeps card actions text-only and renders delete as the prototype ghost action', () => {
    expect(source).toMatch(
      /<button class="hc-btn" @click="openSoulEditor">\s*\{\{ t\('agents\.editSoul'\) \}\}\s*<\/button>/s,
    )
    expect(source).toMatch(
      /:data-testid="`agent-enter-chat-\$\{agent\.name\}`"\s*@click="enterAgentChat\(agent\.name\)"\s*>\s*\{\{ t\('agents\.enterChat'\) \}\}/s,
    )
    expect(source).toMatch(
      /<button v-if="!isScenarioAgent\(agent\)" class="hc-btn" @click="openEditAgent\(agent\)">\s*\{\{ t\('common\.edit'\) \}\}/s,
    )
    expect(source).toMatch(/class="hc-btn hc-btn-ghost hc-btn--danger"/)
    expect(source).not.toMatch(/<(?:MessageSquare|Trash2)\b/)
  })

  it('keeps dedicated-card titles and descriptions in their elastic slot without squeezing badges', () => {
    expect(source).toMatch(
      /<div class="hc-cxnm">\s*\{\{ defaultAssistantName \}\}\s*<span class="hc-tag">/s,
    )
    expect(source).toMatch(
      /<div class="hc-cxnm hc-cxnm--card">\s*<span class="hc-cxnm__label">\{\{ agentDisplayName\(agent\) \}\}<\/span>/s,
    )
    expect(source).toContain('class="hc-cxmeta hc-cxmeta--card"')
    expect(source).toContain('class="hc-tag hc-cxnm__badge"')
    expect(source).toContain('class="hc-pill hc-pill--green hc-cxnm__badge"')
  })
})
