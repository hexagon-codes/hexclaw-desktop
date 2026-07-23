/**
 * 原型共享控件防漂移契约。
 *
 * UI 唯一权威：hexclaw-docs/prototype/app.html
 * - .btn / .btn-primary / .btn-ghost: app.html:152-169, 482-483
 * - .tbar .btn: app.html:178-182
 * - .minput: app.html:395-396
 * - .empty: app.html:201-207
 * - .tog: app.html:210-212
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = path.resolve(__dirname, '..')

function source(relativePath: string): string {
  return fs.readFileSync(path.join(SRC, relativePath), 'utf8')
}

function cssRule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 's'))?.[1] ?? ''
}

describe('prototype shared primitive fidelity', () => {
  const global = source('assets/styles/global.css')

  it('keeps the default button geometry and chrome at the prototype values', () => {
    const base = cssRule(global, '.hc-btn')

    expect(base).toMatch(/gap:\s*6px/)
    expect(base).toMatch(/padding:\s*8px 14px/)
    expect(base).toMatch(/border:\s*0\.5px solid var\(--hc-border\)/)
    expect(base).toMatch(/background:\s*var\(--hc-bg-input\)/)
    expect(base).toMatch(/color:\s*var\(--hc-text-primary\)/)
    expect(base).toMatch(/font-size:\s*13px/)
    expect(base).toMatch(/white-space:\s*nowrap/)
  })

  it('keeps prototype button states while preserving the stronger Desktop keyboard focus refinement', () => {
    const primaryHover = cssRule(global, '.hc-btn-primary:hover')
    const primaryActive = cssRule(global, '.hc-btn-primary:active')
    const ghost = cssRule(global, '.hc-btn-ghost')
    const focus = cssRule(global, ':focus-visible')
    const buttonFocusOverride = cssRule(global, '.hc-btn:focus-visible')
    const disabled = cssRule(global, '.hc-btn:disabled')

    expect(primaryHover).toMatch(/background:\s*linear-gradient\(180deg,\s*#67b8ec 0%,\s*#4f9fe1 100%\)/)
    expect(primaryHover).not.toMatch(/transform\s*:/)
    expect(primaryHover).toMatch(/box-shadow:\s*0 10px 26px rgba\(95,\s*179,\s*234,\s*0\.34\)/)
    expect(primaryHover).not.toContain('filter:')
    expect(primaryActive).toMatch(/transform:\s*translateY\(0\) scale\(0\.98\)/)
    expect(ghost).toMatch(/padding:\s*6px 8px/)
    expect(ghost).toMatch(/border-color:\s*transparent/)
    expect(focus).toMatch(/outline:\s*2px solid var\(--hc-accent\)/)
    expect(focus).toMatch(/outline-offset:\s*2px/)
    expect(buttonFocusOverride).not.toMatch(/outline:\s*none/)
    expect(disabled).toMatch(/opacity:\s*0\.45/)
    expect(disabled).not.toContain('pointer-events')
  })

  it('keeps shared input and card hairlines at one half pixel', () => {
    const input = cssRule(global, '.hc-input')
    const card = cssRule(global, '.hc-card')

    expect(input).toMatch(/border:\s*0\.5px solid var\(--hc-border\)/)
    expect(input).toMatch(/padding:\s*9px 12px/)
    expect(card).toMatch(/border:\s*0\.5px solid var\(--hc-border\)/)
  })

  it('keeps the toggle thumb shadow at the prototype contrast', () => {
    const thumb = cssRule(global, '.hc-toggle::before')
    expect(thumb).toMatch(/box-shadow:\s*0 1px 3px rgba\(0,\s*0,\s*0,\s*0\.12\)/)
  })
})

describe('prototype toolbar and empty-state fidelity', () => {
  const toolbar = source('components/common/PageToolbar.vue')
  const empty = source('components/common/EmptyState.vue')

  it('locks toolbar clipping and its three button geometries', () => {
    expect(toolbar).toMatch(/\.hc-toolbar\s*\{[^}]*overflow:\s*hidden/s)
    expect(toolbar).toMatch(/\.hc-toolbar\s+:deep\(\.hc-btn\)\s*\{[^}]*height:\s*32px;[^}]*padding:\s*0 12px;[^}]*border-radius:\s*8px/s)
    expect(toolbar).toMatch(/\.hc-toolbar\s+:deep\(\.hc-btn-ghost\)\s*\{[^}]*height:\s*30px;[^}]*padding:\s*0 8px/s)
  })

  it('renders the shared empty state with the prototype spacing and icon geometry', () => {
    expect(empty).toContain(':size="34"')
    expect(empty).toMatch(/\.hc-empty\s*\{[^}]*gap:\s*6px;[^}]*padding:\s*72px 20px/s)
    expect(empty).toMatch(/\.hc-empty__icon-wrap\s*\{[^}]*width:\s*84px;[^}]*height:\s*84px;[^}]*margin-bottom:\s*6px;[^}]*background:\s*var\(--hc-bg-card\);[^}]*border:\s*0\.5px solid var\(--hc-border\)/s)
    expect(empty).toMatch(/\.hc-empty__title\s*\{[^}]*font-weight:\s*600;[^}]*margin:\s*2px 0 0/s)
    expect(empty).toMatch(/\.hc-empty__desc\s*\{[^}]*max-width:\s*440px/s)
    expect(empty).toMatch(/\.hc-empty__action\s*\{[^}]*margin-top:\s*14px/s)
  })
})
