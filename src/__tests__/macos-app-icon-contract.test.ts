import { describe, it, expect } from 'vitest'
import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * macOS App 图标契约守卫（打包面）。
 *
 * 背景：用户反馈「装机后 Finder/应用程序里 HexClaw.app 显示通用占位图标，Dock 里正常」。
 * 排查结论：bundle 的 icon.icns 完好、Info.plist 指向正确、Dock（macOS 直接取 bundle 的
 * Contents/Resources/icon.icns）能正常渲染 → 这是 icon-services 缓存残留，**非构建缺陷**。
 *
 * 但「真正的构建侧图标 bug」长这样：icon.icns 被删/被提交成 0 字节占位/配置不再指向它 →
 * Finder 和 Dock 都会变占位图。本守卫钉死该契约，让那类真回归在 CI 即 RED：
 *   ① tauri.conf.json 的 bundle.icon 必须包含 .icns；
 *   ② icons/icon.icns 必须存在、是合法 icns（'icns' 魔数）、且体量符合「多分辨率」预期（非占位）。
 */

// vitest config 把 root 设为仓库根，故 cwd 即仓库根。
function repoFile(rel: string): string {
  return resolve(process.cwd(), rel)
}

describe('macOS app icon packaging contract', () => {
  it('tauri.conf.json 的 bundle.icon 列表包含 .icns（macOS 取 .icns 作为 bundle 图标）', () => {
    const conf = JSON.parse(readFileSync(repoFile('src-tauri/tauri.conf.json'), 'utf-8'))
    const icons: string[] = conf?.bundle?.icon ?? []
    expect(Array.isArray(icons)).toBe(true)
    expect(icons.some((p) => p.endsWith('.icns'))).toBe(true)
  })

  it('icon.icns 存在、是合法 icns、且为多分辨率（体量 > 100KB，排除占位/0 字节）', () => {
    const icnsPath = repoFile('src-tauri/icons/icon.icns')
    const size = statSync(icnsPath).size
    // 一个含 16→1024 全套表示的 icns 体量在数百 KB 量级；占位/裁剪过的会远小于此。
    expect(size).toBeGreaterThan(100 * 1024)

    const buf = readFileSync(icnsPath)
    // icns 文件魔数：ASCII 'icns'
    expect(buf.subarray(0, 4).toString('ascii')).toBe('icns')
    // 头部第 4..8 字节是大端总长度，应与真实文件大小一致（防截断/损坏）。
    expect(buf.readUInt32BE(4)).toBe(size)
  })
})
