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

  it('Provider 卡头按钮与模型名称同行，连接状态只显示测试成功/失败', () => {
    // 按钮（测试/删除/启用/折叠）与模型名称必须位于同一行容器内
    expect(settings).toMatch(
      /\.hc-provider__card-head\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;[^}]*justify-content:\s*space-between;/s,
    )
    expect(settings).toMatch(
      /\.hc-provider__card-info\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;/s,
    )
    // 连接状态只允许 未测试 / 测试中… / 测试成功 / 测试失败 四态文案
    expect(settings).toMatch(
      /t\('settings\.llm\.testSuccess',\s*'成功'\)/,
    )
    // 卡头不得再显示 云端/本地服务 或 上次测试时间
    expect(settings).not.toMatch(
      /providerConnectionResult\(provider\)!\.locality === 'local'[\s\S]{0,200}?\.locality === 'cloud'/,
    )
    expect(settings).not.toContain("t('settings.llm.lastTested', '上次测试')")
    expect(settings).not.toContain('formatProviderProbeTime')
  })

  it('Provider 卡头恒一行且 LLM 区保持原型 600px 列宽', () => {
    // 权威原型 app.html：settings 面板 ~600px 窄列，prov-top 为 flex 恒一行
    // （仅视口 ≤780px 才 wrap）；1226×1548 实测原型卡片恰 600px。
    // 实现必须与之一致：LLM 区 600px 限宽 + 卡头 flex 一行 + 无容器换行断点。
    expect(settings).toMatch(
      /activeSection === 'llm'[\s\S]{0,200}?class="hc-settings__section" style="max-width:\s*600px"/,
    )
    expect(settings).toMatch(
      /\.hc-provider__card-head\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;[^}]*justify-content:\s*space-between;/s,
    )
    expect(settings).toMatch(
      /\.hc-provider__card-info\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;/s,
    )
    // 无容器换行断点：不得把状态/操作组整组换到下一行
    expect(settings).not.toMatch(
      /@container \(max-width:\s*959px\)\s*\{[^}]*\.hc-provider__card-head\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/s,
    )
    // 连接状态只允许 未测试 / 测试中… / 测试成功 / 测试失败 四态文案
    expect(settings).toMatch(
      /t\('settings\.llm\.testSuccess',\s*'成功'\)/,
    )
    // 卡头不得再显示 云端/本地服务 或 上次测试时间
    expect(settings).not.toMatch(
      /providerConnectionResult\(provider\)!\.locality === 'local'[\s\S]{0,200}?\.locality === 'cloud'/,
    )
    expect(settings).not.toContain("t('settings.llm.lastTested', '上次测试')")
    expect(settings).not.toContain('formatProviderProbeTime')
  })
})
