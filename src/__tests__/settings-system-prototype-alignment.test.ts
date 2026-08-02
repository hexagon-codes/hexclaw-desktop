/**
 * 系统设置视觉契约：prototype/app.html 是桌面 UI 唯一权威。
 * 这里锁定无法由 happy-dom 像素布局稳定覆盖的关键几何与状态规则。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const SRC = path.resolve(__dirname, '..')
const settings = fs.readFileSync(path.join(SRC, 'views/SettingsView.vue'), 'utf8')

describe('系统设置与权威原型对齐', () => {
  it('使用系统设置专用的紧凑布局，不继承通用表单间距', () => {
    expect(settings).toContain('class="hc-settings__form hc-settings__form--system"')
    expect(settings).toMatch(
      /\.hc-settings__form--system\s*\{[^}]*gap:\s*0;[^}]*margin-bottom:\s*0;/s,
    )
    expect(settings).toMatch(
      /\.hc-settings__toggle-label\s*\{[^}]*display:\s*block;[^}]*line-height:\s*1\.5;/s,
    )
  })

  it('主题选择使用批准的 44px 三段式单选控件与键盘漫游焦点', () => {
    expect(settings).toContain('class="hc-settings__theme-segmented"')
    expect(settings).toContain('role="radiogroup"')
    expect(settings).toContain('role="radio"')
    expect(settings).toContain(':aria-checked="themeMode === opt.key"')
    expect(settings).toContain(':tabindex="themeMode === opt.key ? 0 : -1"')
    expect(settings).toContain('@keydown="handleThemeKeydown($event, index)"')
    expect(settings).toMatch(
      /\.hc-settings__theme-segmented\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\);[^}]*height:\s*44px;[^}]*margin:\s*6px 0 16px;/s,
    )
    expect(settings).toMatch(
      /\.hc-settings__theme-segment\.is-selected\s*\{[^}]*background:\s*var\(--hc-bg-elevated\);[^}]*color:\s*var\(--hc-accent\);[^}]*box-shadow:\s*var\(--hc-shadow-sm\),\s*inset 0 0 0 0\.5px var\(--hc-border\);/s,
    )
    expect(settings).not.toContain('settings.appearance.lightDesc')
    expect(settings).not.toContain('settings.appearance.darkDesc')
    expect(settings).not.toContain('settings.appearance.systemDesc')
  })

  it('系统信息卡使用原型的 10px 圆角与紧凑文本行高', () => {
    expect(settings).not.toContain('class="hc-card hc-settings__info-card"')
    expect(settings).toMatch(
      /\.hc-settings__info-card\s*\{[^}]*border-radius:\s*var\(--hc-radius-md\);[^}]*padding:\s*10px 14px;/s,
    )
    expect(settings).toMatch(
      /\.hc-settings__info-label\s*\{[^}]*display:\s*block;[^}]*line-height:\s*1\.5;/s,
    )
  })
})
