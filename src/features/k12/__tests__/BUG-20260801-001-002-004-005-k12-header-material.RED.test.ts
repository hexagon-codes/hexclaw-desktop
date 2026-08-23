import { describe, expect, it } from 'vitest'
import presentationSource from '../appearance/K12GlobalPresentation.vue?raw'

describe('BUG-20260801-001/002/004/005 · K12 顶栏材质合同', () => {
  it('为 K12 会话与页面工具栏保留原型同源的玻璃材质选择器', () => {
    expect(presentationSource).toMatch(
      /body\[data-k12-skin-active='k12'\][\s\S]*?\.k12enh-tabs[\s\S]*?backdrop-filter:\s*saturate\(120%\) blur\(18px\);[\s\S]*?-webkit-backdrop-filter:\s*saturate\(120%\) blur\(18px\);/,
    )
    expect(presentationSource).toMatch(
      /body\[data-k12-skin-active='k12'\][\s\S]*?\.hc-settings \.hc-toolbar[\s\S]*?backdrop-filter:\s*saturate\(120%\) blur\(18px\);[\s\S]*?-webkit-backdrop-filter:\s*saturate\(120%\) blur\(18px\);/,
    )
  })

  it('冻结 Light/Dark 顶栏渐变和顶部内阴影', () => {
    expect(presentationSource).toContain(
      "[data-theme='light'] body[data-k12-skin-active='k12'] .k12enh-tabs",
    )
    expect(presentationSource).toContain(
      'background: linear-gradient(90deg, rgba(230, 247, 228, 0.98), rgba(239, 249, 240, 0.96));',
    )
    expect(presentationSource).toContain(
      "[data-theme='dark'] body[data-k12-skin-active='k12'] .k12enh-tabs",
    )
    expect(presentationSource).toContain(
      'background: linear-gradient(90deg, rgba(8, 40, 50, 0.97), rgba(9, 31, 54, 0.96));',
    )
    expect(presentationSource).toContain('box-shadow: inset 0 0.5px 0 rgba(255, 255, 255, 0.16);')
  })

  it('只在 K12 skin 下覆盖两个既有顶栏，不改变通用外观', () => {
    expect(presentationSource).toMatch(
      /:global\(body\[data-k12-skin-active='k12'\] \.k12enh-tabs\)/,
    )
    expect(presentationSource).toMatch(
      /:global\(body\[data-k12-skin-active='k12'\] \.hc-settings \.hc-toolbar\)/,
    )
    expect(presentationSource).not.toMatch(/:global\(\.k12enh-tabs\)/)
    expect(presentationSource).not.toMatch(
      /:global\(body\[data-k12-skin-active='k12'\] \.hc-toolbar\)/,
    )
  })
})
