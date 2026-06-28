/**
 * BUG-20260628 系统信息卡 RTL 排版回归
 *
 * 症状（维语 RTL 截图）：设置→系统信息→「API endpoint」一行，翻译后的「桌面模式」
 * （ئۇستەلنۇستى ھالىتى）被渲染成断字、字距异常拉宽，IP 127.0.0.1:16060 换行错位。
 *
 * 根因：该值容器套了等宽字体类 hc-settings__info-value--mono，但内容里混着**翻译文本**
 * （runtimeModeShort）。等宽字体（Menlo/Monaco…）没有维吾尔/阿拉伯连写字形 → 维语断字、
 * 字距拉宽；同时 LTR 技术 token（IP）在 RTL 行内无 bidi 隔离 → 被重排换行。
 *
 * 修法：等宽只套纯技术 token（IP/版本/文件名），且用 <bdi> / dir="ltr" + unicode-bidi:isolate
 * 做 LTR 隔离；翻译标签走正常 UI 字体与 locale 方向（绝不进等宽容器）。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SRC = readFileSync(resolve(__dirname, '../SettingsView.vue'), 'utf8')

// 抽出「系统信息」卡区块：version 标签 ~ 关于河蟹标签之前
function systemInfoBlock(): string {
  const start = SRC.indexOf("t('settings.system.version')")
  const end = SRC.indexOf("t('settings.system.aboutLabel'")
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return SRC.slice(start, end)
}

describe('BUG-20260628 系统信息卡 RTL：等宽不套翻译文本 + 技术 token bidi 隔离', () => {
  it('翻译的 runtimeModeShort 不得落在等宽(--mono)容器里（等宽无维语连写字形→断字宽距）', () => {
    const block = systemInfoBlock()
    const idx = block.indexOf('runtimeModeShort')
    expect(idx).toBeGreaterThan(-1)
    // 该 interpolation 之前最近的 info-value 容器声明不应含 --mono
    const before = block.slice(0, idx)
    const lastValue = before.lastIndexOf('hc-settings__info-value')
    const divDecl = before.slice(lastValue, idx)
    expect(divDecl, 'API endpoint 值容器仍带 --mono，会把翻译的「桌面模式」渲染成断字').not.toContain(
      'hc-settings__info-value--mono',
    )
  })

  it('runtimeApiEndpoint 必须被 <bdi> 隔离（RTL 下 IP 不重排/换行）', () => {
    const block = systemInfoBlock()
    expect(/<bdi[^>]*>\s*\{\{\s*runtimeApiEndpoint\s*\}\}\s*<\/bdi>/.test(block)).toBe(true)
  })

  it('版本号 appVersion 的等宽容器须 dir="ltr"（纯 LTR 不被 RTL 基线重排）', () => {
    const block = systemInfoBlock()
    expect(/info-value--mono"[^>]*dir="ltr"[^>]*>\{\{\s*appVersion\s*\}\}/.test(block)).toBe(true)
  })

  it('内联技术 token 类 .hc-settings__info-mono 须 direction:ltr + unicode-bidi:isolate', () => {
    const m = SRC.match(/\.hc-settings__info-mono\s*\{[^}]*\}/)
    expect(m, '缺少 .hc-settings__info-mono 样式').not.toBeNull()
    expect(m![0]).toContain('direction: ltr')
    expect(m![0]).toContain('unicode-bidi: isolate')
  })

  it('全局兜底类 --mono 也须 LTR 隔离（version/IP 纯技术值统一不被 RTL 重排）', () => {
    const m = SRC.match(/\.hc-settings__info-value--mono\s*\{[^}]*\}/)
    expect(m, '缺少 .hc-settings__info-value--mono 样式').not.toBeNull()
    expect(m![0]).toContain('direction: ltr')
    expect(m![0]).toContain('unicode-bidi: isolate')
  })
})
