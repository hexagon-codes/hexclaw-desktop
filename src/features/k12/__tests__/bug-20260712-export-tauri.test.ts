import { describe, it, expect, vi, beforeEach } from 'vitest'

// BUG-20260712-#6 导出 PDF/Word/Markdown 点了没反应：K12 导出用浏览器 `<a download>` + blob URL，
// Tauri WKWebView 里不触发下载（无下载管理器）→ 静默无反应。修：桌面走 Tauri 原生 Save 对话框
// + Rust 写盘（downloadInApp），浏览器/dev 保留 blob 回退。

const h = vi.hoisted(() => ({ tauri: false, saveSpy: vi.fn<(src: string, fn: string) => void>() }))
vi.mock('@/utils/platform', () => ({ isTauri: () => h.tauri }))
vi.mock('@/utils/download', () => ({ downloadInApp: (src: string, fn: string) => h.saveSpy(src, fn) }))

import { download } from '../export'

describe('BUG-20260712-#6 导出走 Tauri 原生保存（WKWebView <a download> 失效）', () => {
  beforeEach(() => { h.saveSpy.mockClear() })

  it('Tauri 环境 → 调 downloadInApp(data URL)，不再 <a download> 静默失败', async () => {
    h.tauri = true
    await download('错题本.md', '# 错题\n长方体的体积', 'text/markdown')
    expect(h.saveSpy).toHaveBeenCalledOnce() // RED（修前 download 不调 downloadInApp）
    const [src, fn] = h.saveSpy.mock.calls[0]!
    expect(src).toMatch(/^data:text\/markdown;base64,/)
    expect(fn).toBe('错题本.md')
    // 中文内容 UTF-8 安全还原
    const b64 = (src as string).split(',')[1]!
    expect(decodeURIComponent(escape(atob(b64)))).toContain('长方体的体积')
  })

  it('浏览器/dev 环境 → 不走 Tauri 保存（blob 回退）', async () => {
    h.tauri = false
    await download('x.md', 'hi', 'text/markdown')
    expect(h.saveSpy).not.toHaveBeenCalled()
  })
})
