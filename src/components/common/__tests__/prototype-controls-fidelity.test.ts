/**
 * Shared-control fidelity contract.
 *
 * Prototype values plus documented Desktop platform refinements.
 * Platform fixes that prevent WKWebView deformation or preserve an approved
 * clear affordance are intentionally locked here for reverse-sync to the prototype.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const COMMON = path.resolve(__dirname, '..')

function source(file: string): string {
  return fs.readFileSync(path.join(COMMON, file), 'utf8')
}

function cssRule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 's'))?.[1] ?? ''
}

describe('prototype shared-control fidelity', () => {
  it('keeps the WKWebView-stable HcSelect geometry instead of forcing generic selbox width', () => {
    const raw = source('HcSelect.vue')
    const root = cssRule(raw, '.hc-select')
    const trigger = cssRule(raw, '.hc-select__trigger')

    expect(root).not.toContain('min-width:')
    expect(trigger).toMatch(/gap:\s*8px/)
    expect(trigger).toMatch(/min-height:\s*36px/)
    expect(trigger).toMatch(/padding-right:\s*32px/)
    expect(cssRule(raw, '.hc-select__arrow')).toMatch(/position:\s*absolute/)
    expect(cssRule(raw, '.hc-select__arrow')).toMatch(/right:\s*10px/)
    expect(raw).toContain('top: `${rect.bottom + 4}px`')
    expect(raw).toContain('bottom: `${window.innerHeight - rect.top + 4}px`')
  })

  it('keeps ProviderSelect on the dedicated prototype provider selector contract', () => {
    const raw = source('ProviderSelect.vue')
    const trigger = cssRule(raw, '.hc-provider-select__trigger')
    const menu = cssRule(raw, '.hc-provider-select__dropdown')
    const option = cssRule(raw, '.hc-provider-select__option')

    expect(trigger).toMatch(/min-height:\s*38px/)
    expect(trigger).toMatch(/padding:\s*8px 34px 8px 11px/)
    expect(trigger).toMatch(/border:\s*0\.5px solid var\(--hc-border\)/)
    expect(trigger).toMatch(/border-radius:\s*10px/)
    expect(cssRule(raw, '.hc-provider-select__trigger:hover')).toMatch(
      /border-color:\s*var\(--hc-border-hl\)/,
    )
    expect(cssRule(raw, '.hc-provider-select__trigger:hover')).toMatch(
      /background:\s*var\(--hc-bg-hover\)/,
    )
    expect(cssRule(raw, '.hc-provider-select__trigger:focus-visible')).toMatch(
      /box-shadow:\s*0 0 0 3px var\(--hc-accent-subtle\)/,
    )
    expect(cssRule(raw, '.hc-provider-select__arrow')).toMatch(/right:\s*11px/)
    expect(menu).toMatch(/border:\s*0\.5px solid var\(--hc-border\)/)
    expect(menu).toMatch(/backdrop-filter:\s*blur\(24px\) saturate\(160%\)/)
    expect(option).toMatch(/min-height:\s*34px/)
    expect(option).toMatch(/border-radius:\s*7px/)
    expect(raw).toContain('top: `${rect.bottom + 6}px`')
  })

  it('keeps segmented counts and underline tabs at their prototype weights and hairlines', () => {
    const segmented = source('SegmentedControl.vue')
    const tabs = source('UnderlineTabs.vue')
    const count = cssRule(segmented, '.hc-segmented__count')

    expect(cssRule(segmented, '.hc-segmented')).toMatch(/flex-shrink:\s*0/)
    expect(count).toMatch(/margin-left:\s*1px/)
    expect(count).toMatch(/font-weight:\s*400/)
    expect(count).toMatch(/opacity:\s*0\.62/)
    expect(cssRule(tabs, '.hc-utabs')).toMatch(/border-bottom:\s*0\.5px solid var\(--hc-border\)/)
    expect(cssRule(tabs, '.hc-utab')).toMatch(/font-weight:\s*400/)
    expect(cssRule(tabs, '.hc-utab--on')).toMatch(/font-weight:\s*500/)
  })

  it('keeps ContextMenu on the prototype menu chrome and subtle hover state', () => {
    const raw = source('ContextMenu.vue')
    const menu = cssRule(raw, '.hc-ctx')
    const item = cssRule(raw, '.hc-ctx__item')
    const hover = cssRule(raw, '.hc-ctx__item:hover')
    const disabled = cssRule(raw, '.hc-ctx__item--disabled')

    expect(menu).toMatch(/min-width:\s*170px/)
    expect(menu).toMatch(/padding:\s*6px/)
    expect(menu).toMatch(/border:\s*0\.5px solid var\(--hc-border\)/)
    expect(item).toMatch(/padding:\s*8px 10px/)
    expect(item).toMatch(/border-radius:\s*7px/)
    expect(hover).toMatch(/background:\s*var\(--hc-bg-hover\)/)
    expect(hover).not.toMatch(/color:\s*#fff/)
    expect(disabled).toMatch(/opacity:\s*0\.72/)
    expect(disabled).toMatch(/cursor:\s*not-allowed/)
    expect(disabled).toMatch(/color:\s*var\(--hc-text-muted\)/)
  })

  it('keeps SplitButton trigger, icons, alignment and menu at prototype values', () => {
    const raw = source('SplitButton.vue')
    const split = cssRule(raw, '.hc-split-btn')
    const main = cssRule(raw, '.hc-split-btn__main')
    const caret = cssRule(raw, '.hc-split-btn__caret')
    const menu = cssRule(raw, '.hc-split-menu')
    const item = cssRule(raw, '.hc-split-menu__item')

    expect(raw).toContain(':size="15"')
    expect(raw).toContain('<ChevronDown :size="13"')
    expect(raw).toContain('let left = r.left')
    expect(raw).toContain('let top = r.bottom + 6')
    expect(split).toMatch(/box-shadow:\s*0 6px 18px rgba\(95,\s*179,\s*234,\s*0\.28\)/)
    expect(cssRule(raw, '.hc-split-btn:hover')).not.toMatch(/transform\s*:/)
    expect(main).toMatch(/gap:\s*6px/)
    expect(main).toMatch(/padding:\s*8px 14px/)
    expect(main).toMatch(/background:\s*linear-gradient\(180deg,\s*#5fb3ea 0%,\s*#4a9de0 100%\)/)
    expect(caret).toMatch(/padding:\s*0 8px/)
    expect(menu).toMatch(/min-width:\s*170px/)
    expect(menu).toMatch(/padding:\s*6px/)
    expect(menu).toMatch(/border:\s*0\.5px solid var\(--hc-border\)/)
    expect(item).toMatch(/padding:\s*8px 10px/)
    expect(cssRule(raw, '.hc-split-menu__item:hover')).toMatch(/background:\s*var\(--hc-bg-hover\)/)
  })

  it('retains the accessible clear action while matching the prototype search icon size', () => {
    const raw = source('SearchInput.vue')

    expect(raw).toContain('<Search :size="15"')
    expect(raw).toContain('hc-search__clear')
    expect(raw).toContain('clearTestId')
  })
})
