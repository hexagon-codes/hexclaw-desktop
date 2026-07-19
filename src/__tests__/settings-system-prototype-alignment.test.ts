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
    expect(settings).toMatch(/\.hc-settings__form--system\s*\{[^}]*gap:\s*0;[^}]*margin-bottom:\s*0;/s)
    expect(settings).toMatch(/\.hc-settings__toggle-label\s*\{[^}]*display:\s*block;[^}]*line-height:\s*1\.5;/s)
  })

  it('主题卡镜像原型的 grid、hover、截断与无常驻选中描边规则', () => {
    expect(settings).toContain('class="hc-settings__theme-copy"')
    expect(settings).not.toContain("'hc-settings__theme-card--active': themeMode === opt.key")
    expect(settings).toMatch(/\.hc-settings__theme-grid\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\);[^}]*margin:\s*8px 0 14px;/s)
    expect(settings).toMatch(/\.hc-settings__theme-card:hover\s*\{[^}]*border-color:\s*var\(--hc-border-hl\);[^}]*transform:\s*translateY\(-1px\);/s)
    expect(settings).toMatch(/\.hc-settings__theme-label\s*\{[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s)
    expect(settings).toMatch(/\.hc-settings__theme-desc\s*\{[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s)
  })

  it('系统信息卡使用原型的 10px 圆角与紧凑文本行高', () => {
    expect(settings).not.toContain('class="hc-card hc-settings__info-card"')
    expect(settings).toMatch(/\.hc-settings__info-card\s*\{[^}]*border-radius:\s*var\(--hc-radius-md\);[^}]*padding:\s*10px 14px;/s)
    expect(settings).toMatch(/\.hc-settings__info-label\s*\{[^}]*display:\s*block;[^}]*line-height:\s*1\.5;/s)
  })
})
