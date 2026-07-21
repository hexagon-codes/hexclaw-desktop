import { describe, expect, it } from 'vitest'
import source from '../views/K12ChatEnhancement.vue?raw'

describe('K12 会话头 · app.html 保真锁', () => {
  it('使用原型 chat-top/k12hd 与 seg 的精确几何，不再保留私有偏差', () => {
    expect(source).toMatch(
      /\.k12enh-tabs\s*\{[\s\S]*?gap:\s*10px;[\s\S]*?min-height:\s*48px;[\s\S]*?padding:\s*11px 16px;/,
    )
    expect(source).toMatch(
      /\.k12enh-seg\s*\{[\s\S]*?border-radius:\s*11px;[\s\S]*?padding:\s*3px;[\s\S]*?gap:\s*2px;/,
    )
    expect(source).toMatch(
      /\.k12enh-seg button\.on\s*\{[\s\S]*?box-shadow:\s*var\(--hc-shadow-sm\),\s*inset 0 0 0 (?:0)?\.5px var\(--hc-border\);/,
    )
  })
})
