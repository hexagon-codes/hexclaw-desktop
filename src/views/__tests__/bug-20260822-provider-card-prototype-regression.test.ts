import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const settingsViewSource = readFileSync(resolve(__dirname, '..', 'SettingsView.vue'), 'utf8')
const providerPrototypeSource = readFileSync(
  resolve(process.cwd(), '..', 'hexclaw-docs', 'prototype', 'app.html'),
  'utf8',
)

describe('provider card prototype regression', () => {
  it('keeps backend identifiers out of the header and preserves the approved card geometry', () => {
    expect(settingsViewSource).not.toContain('hc-provider__card-type')
    expect(settingsViewSource).toContain(
      'grid-template-columns: repeat(auto-fit, minmax(min(172px, 100%), 1fr));',
    )
    expect(settingsViewSource).toMatch(
      /\.hc-provider__edit\s*\{(?=[\s\S]*?gap: 8px;)(?=[\s\S]*?margin-top: 10px;)[\s\S]*?\}/,
    )
    expect(settingsViewSource).toContain('<HcClearableField :trailing="10">')
    expect(settingsViewSource).toContain('<HcClearableField :trailing="40">')
    expect(settingsViewSource).not.toContain('hc-settings__eye-btn--shown')
    expect(settingsViewSource).toContain('.hc-provider__connection-status--ok')
    expect(settingsViewSource).toContain('padding: 0 7px;')
    expect(settingsViewSource).toMatch(
      /\.hc-provider__card-info\s*\{(?=[\s\S]*?flex: 1 1 auto;)[\s\S]*?\}/,
    )
    expect(settingsViewSource).toContain('.hc-provider__card-info::after')
    expect(settingsViewSource).toContain('margin-right: 0;')
    expect(settingsViewSource).toMatch(
      /\.hc-provider__toggle\s*\{(?=[\s\S]*?margin: 3px 3px 3px 4px;)[\s\S]*?\}/,
    )
    expect(settingsViewSource).toMatch(
      /@supports \(font: -apple-system-body\)\s*\{\s*\.hc-provider__toggle\s*\{\s*margin: 3px 2px;\s*\}\s*\}/,
    )
    expect(settingsViewSource).toMatch(
      /\.hc-provider__chevron\s*\{(?=[\s\S]*?width: 15px;)(?=[\s\S]*?height: 15px;)[\s\S]*?\}/,
    )
    expect(settingsViewSource).toMatch(
      /\.hc-provider__card:hover\s*\{\s*border-color: var\(--hc-border-hl\);\s*\}/,
    )
    expect(providerPrototypeSource).toContain(
      '.prov-ic{width:34px;height:34px;border-radius:9px;background:var(--hc-bg-input);display:grid;place-items:center',
    )
    expect(providerPrototypeSource).toContain(
      '.prov-ic--brand img{display:block;width:24px;height:24px;border-radius:6px;object-fit:contain}',
    )
    expect(providerPrototypeSource).toContain(
      '<div class="prov-ic prov-ic--brand"><img src="provider-logos/custom.svg" alt="OpenRouter"></div>',
    )
    expect(settingsViewSource).toMatch(
      /\.hc-provider__logo\s*\{(?=[\s\S]*?width: 34px;)(?=[\s\S]*?height: 34px;)(?=[\s\S]*?place-items: center;)[\s\S]*?\}/,
    )
    expect(settingsViewSource).toMatch(
      /\.hc-provider__logo img\s*\{(?=[\s\S]*?width: 24px;)(?=[\s\S]*?height: 24px;)[\s\S]*?\}/,
    )
  })
})
