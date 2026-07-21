import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const readLayout = (name: string) =>
  readFileSync(resolve(__dirname, `../${name}.vue`), 'utf8')

function cssBlock(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))
  expect(match, `missing CSS block ${selector}`).not.toBeNull()
  return match?.[1] ?? ''
}

function expectDeclarations(block: string, declarations: string[]) {
  for (const declaration of declarations) {
    expect(block).toContain(declaration)
  }
}

describe('prototype shell fidelity — app surface', () => {
  const source = readLayout('AppLayout')

  it('keeps the prototype gradient, texture, glow, and z-order layers', () => {
    expect(source).toContain('<div class="hc-app__glow" aria-hidden="true" />')
    expectDeclarations(cssBlock(source, '.hc-app'), ['background: var(--hc-bg-gradient);'])
    expectDeclarations(cssBlock(source, '.hc-app__body'), ['position: relative;'])
    expectDeclarations(cssBlock(source, '.hc-app__body::after'), [
      'pointer-events: none;',
      'mix-blend-mode: soft-light;',
      'background-size: 60px 52px;',
    ])
    expectDeclarations(cssBlock(source, '.hc-app__content'), [
      'z-index: 1;',
      'background: var(--hc-bg-gradient);',
    ])
    expectDeclarations(cssBlock(source, '.hc-app__glow'), [
      'height: 220px;',
      'pointer-events: none;',
      'z-index: 0;',
    ])
    expectDeclarations(cssBlock(source, '.hc-app__view'), [
      'position: relative;',
      'z-index: 1;',
    ])
  })
})

describe('prototype shell fidelity — titlebar', () => {
  const source = readLayout('TitleBar')

  it('matches the titlebar material and 12px control rhythm', () => {
    expect.hasAssertions()
    expectDeclarations(cssBlock(source, '.hc-titlebar'), [
      'gap: 12px;',
      'background: var(--hc-bg-panel);',
    ])
    expectDeclarations(cssBlock(source, '.hc-titlebar__left'), ['gap: 12px;'])
    expectDeclarations(cssBlock(source, '.hc-titlebar__right'), ['gap: 12px;'])
  })

  it('matches the 28px notification control and badge geometry', () => {
    expect.hasAssertions()
    expectDeclarations(cssBlock(source, '.hc-titlebar__notif'), [
      'width: 28px;',
      'height: 28px;',
      'padding: 0;',
      'border-radius: 7px;',
    ])
    expectDeclarations(cssBlock(source, '.hc-titlebar__badge'), [
      'top: 1px;',
      'right: 0;',
      'font-weight: 700;',
      'box-shadow: 0 0 0 1.5px var(--hc-bg-elevated);',
    ])
  })

  it('uses the native macOS overlay controls without drawing a duplicate business-DOM set', () => {
    const tauriConfig = JSON.parse(
      readFileSync(resolve(__dirname, '../../../../src-tauri/tauri.conf.json'), 'utf8'),
    ) as {
      app: { windows: Array<Record<string, unknown>> }
    }
    const mainWindow = tauriConfig.app.windows.find((window) => window.label === 'main')

    expect(mainWindow).toMatchObject({
      decorations: true,
      titleBarStyle: 'Overlay',
      hiddenTitle: true,
    })
    expectDeclarations(cssBlock(source, '.hc-titlebar--mac'), ['padding-left: 78px;'])
    expect(source).not.toMatch(/tb-system-controls|hc-capture-system-controls|#ff5f57|#febc2e|#28c840/)
  })
})

describe('prototype shell fidelity — sidebar', () => {
  const source = readLayout('Sidebar')

  it('matches the prototype frame, brand, nav, and collapsed geometry', () => {
    expect(source).toContain('v-if="gi === 1 && getGroupItems(group).length"')
    expect(source).toContain(':size="18" class="hc-sidebar__icon"')
    expectDeclarations(cssBlock(source, '.hc-sidebar'), [
      'border-right: 0.5px solid var(--hc-border);',
      'transition: width 0.18s cubic-bezier(0.25, 0.1, 0.25, 1);',
      'gap: 0;',
    ])
    expectDeclarations(cssBlock(source, '.hc-sidebar__brand'), [
      'gap: 9px;',
      'padding: 6px 8px 12px;',
      'height: 46px;',
    ])
    expectDeclarations(cssBlock(source, '.hc-sidebar__nav'), ['gap: 1px;'])
    expectDeclarations(cssBlock(source, '.hc-sidebar__divider'), [
      'height: 1px;',
      'margin: 7px 8px;',
      'background: var(--hc-divider);',
    ])
    expectDeclarations(cssBlock(source, '.hc-sidebar__group-label'), [
      'padding: 12px 12px 5px;',
      'margin: 0;',
      'font-size: 11px;',
      'letter-spacing: 0.04em;',
      'color: var(--hc-text-muted);',
    ])
    expectDeclarations(cssBlock(source, '.hc-sidebar--collapsed .hc-sidebar__item'), [
      'padding: 8px 0;',
    ])
    expect(cssBlock(source, '.hc-sidebar__item--active')).not.toContain('font-weight: 600;')
  })

  it('matches the engine footer geometry while leaving its entry-point scope undecided', () => {
    expect(source).toContain('class="hc-sidebar__engine-row"')
    expectDeclarations(cssBlock(source, '.hc-sidebar__footer'), [
      'margin-top: auto;',
      'padding: 0;',
    ])
    expectDeclarations(cssBlock(source, '.hc-sidebar__engine-row'), [
      'gap: 8px;',
      'padding: 9px 10px 4px;',
      'border-radius: 8px;',
    ])
    expectDeclarations(cssBlock(source, '.hc-sidebar__engine-label'), [
      'font-size: 12px;',
      'color: var(--hc-text-secondary);',
    ])
    expectDeclarations(cssBlock(source, '.hc-sidebar__restart-btn'), [
      'width: 24px;',
      'height: 24px;',
      'border-radius: 7px;',
    ])
    expectDeclarations(cssBlock(source, '.hc-sidebar__restart-btn:hover'), [
      'color: var(--hc-text-secondary);',
      'background: var(--hc-bg-hover);',
    ])
  })
})

describe('prototype shell fidelity — engine banner', () => {
  const source = readLayout('EngineBanner')

  it('matches the prototype warning material and primary button state', () => {
    expect.hasAssertions()
    expectDeclarations(cssBlock(source, '.hc-engine-banner'), [
      'background: rgba(240, 180, 41, 0.12);',
      'border-bottom: 0.5px solid rgba(240, 180, 41, 0.32);',
    ])
    expectDeclarations(cssBlock(source, '.hc-engine-banner__btn'), [
      'border: 0.5px solid rgba(240, 180, 41, 0.42);',
    ])
    expectDeclarations(cssBlock(source, '.hc-engine-banner__btn:hover:not(:disabled)'), [
      'background: rgba(240, 180, 41, 0.16);',
    ])
    expectDeclarations(cssBlock(source, '.hc-engine-banner__btn--primary'), [
      'color: #12324c;',
    ])
    expectDeclarations(cssBlock(source, '.hc-engine-banner__btn--primary:hover:not(:disabled)'), [
      'filter: brightness(1.06);',
    ])
  })
})
