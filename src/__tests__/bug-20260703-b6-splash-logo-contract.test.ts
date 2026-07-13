import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * BUG-20260703 B6：装机版启动页空白、不显示 logo。
 *
 * 根因：splash 是 index.html 里 JS 加载前的静态层，其 logo 用运行时原始路径
 * `<img src="/logo.png">`（public/ 直出）——全 App 唯一不走打包 import 的图片引用。
 * dev 下 Vite 直供正常；装机版走 Tauri 内嵌 asset 协议 + 生产 CSP + splash 提前
 * dismiss 三者叠加，这次异步图片 fetch 极易失败/来不及绘制 → 空白 splash。
 *
 * 契约：splash logo 必须内联为 data-URI（CSP img-src 已白名单 data:），boot 前
 * 即在 DOM，零运行时 fetch 依赖——dev 与装机版行为一致（Tauri 官方 splash 做法）。
 */
describe('BUG-20260703 B6: splash logo 内联契约', () => {
  const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf-8')
  const layout = readFileSync(resolve(process.cwd(), 'src/components/layout/AppLayout.vue'), 'utf-8')
  const viteConfig = readFileSync(resolve(process.cwd(), 'vite.config.ts'), 'utf-8')

  it('splash 结构存在（#splash-screen + .splash-logo img）', () => {
    expect(html).toContain('id="splash-screen"')
    expect(html).toMatch(/class="splash-logo"[\s\S]*?<img\s/)
  })

  it('splash logo 必须内联 data-URI，不得依赖运行时路径 fetch', () => {
    const m = html.match(/id="splash-screen"[\s\S]*?<img\s+[^>]*src="([^"]+)"/)
    expect(m, 'splash 里找不到 <img src>').toBeTruthy()
    expect(
      m![1],
      'B6: splash logo 用运行时路径（装机版 asset 协议/CSP/时序三重不确定）——必须内联 data-URI',
    ).toMatch(/^data:image\//)
  })

  it('内联 data-URI 是合法 base64 PNG 且非空', () => {
    const m = html.match(/id="splash-screen"[\s\S]*?<img\s+[^>]*src="data:image\/png;base64,([^"]+)"/)
    expect(m, 'splash logo 应为 base64 PNG data-URI').toBeTruthy()
    const buf = Buffer.from(m?.[1] ?? '', 'base64')
    // PNG magic header
    expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    expect(buf.length).toBeGreaterThan(1000)
  })

  it('快速探活时仍保留最短展示时间，避免 logo 在首帧前被撤掉', () => {
    expect(html).toContain('data-shown-at')
    expect(layout).toContain('MIN_SPLASH_MS')
    expect(layout).toMatch(/performance\.now\(\)[\s\S]*?shownAt/)
  })

  it('Tauri 生产构建使用相对资源路径', () => {
    const relativeBase = /base:\s*['"]\.\/['"]/
    expect(viteConfig).toMatch(relativeBase)
  })
})
