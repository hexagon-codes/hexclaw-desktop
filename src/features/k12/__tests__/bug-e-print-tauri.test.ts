import { describe, it, expect, vi, beforeEach } from 'vitest'

// BUG-E：K12「辅导要点」卡 + 错题卷点🖨「打印」在 Tauri 桌面端无反应。
// 根因：printPrepCard / printWorksheet 用隐藏 iframe + win.print()，Tauri macOS WKWebView 里
// iframe window.print() 是 no-op（同 BUG-20260712-#6 <a download> 失效）。
// 修：桌面端把 buildXxxHtml 生成的 HTML 经 downloadInApp(data:text/html;base64,…) 存成文件，
// 用户用系统预览/浏览器打开后打印；浏览器/dev 保留 iframe win.print()。

const h = vi.hoisted(() => ({
  tauri: false,
  saveSpy: vi.fn<(src: string, fn: string) => void>(),
  renderSpy: vi.fn<(req: unknown) => Promise<Blob>>(),
}))
vi.mock('@/utils/platform', () => ({ isTauri: () => h.tauri }))
vi.mock('@/utils/download', () => ({ downloadInApp: (src: string, fn: string) => h.saveSpy(src, fn) }))
// 项-7：exportPdf 改走后端 render 端点出真 PDF（printWorksheet/printPrepCard 打印流仍存 .html 不变）。
vi.mock('@/api/k12', () => ({ renderDocument: (req: unknown) => h.renderSpy(req) }))

import { printPrepCard, printWorksheet, exportPdf } from '../export'
import type { RecordItem } from '@/contracts'

const card = {
  knowledge_points: ['长方体的体积'],
  sections: [{ title: '讲解思路', content: '底面积 × 高', source_label: 'AI 归纳' }],
}
const prepMeta = { title: '辅导要点', gradeLabel: '五年级' }

const items = [
  { recordId: 'r1', fields: { question: '一个长方体的体积是多少', knowledge_point: '长方体的体积' } },
] as unknown as RecordItem[]
const wsMeta = { childName: '小明', title: '错题卷', dateLabel: '2026-07-12' }

function decode(src: string): string {
  const b64 = src.split(',')[1]!
  return decodeURIComponent(escape(atob(b64)))
}

describe('BUG-E K12 打印在 Tauri 桌面端走原生保存（iframe win.print() 失效）', () => {
  beforeEach(() => { h.saveSpy.mockClear() })

  it('Tauri 环境 → printPrepCard 调 downloadInApp(data:text/html)，含标题与知识点，文件名正确', async () => {
    h.tauri = true
    const ok = await printPrepCard(card, prepMeta)
    expect(ok).toBe(true)
    expect(h.saveSpy).toHaveBeenCalledOnce() // RED（修前无平台分支 → 不调 downloadInApp）
    const [src, fn] = h.saveSpy.mock.calls[0]!
    expect(src).toMatch(/^data:text\/html;base64,/)
    expect(fn).toBe('辅导要点.html')
    const html = decode(src as string)
    expect(html).toContain('辅导要点')
    expect(html).toContain('长方体的体积')
  })

  it('Tauri 环境 → printWorksheet 调 downloadInApp(data:text/html)，含标题与题干，文件名正确', async () => {
    h.tauri = true
    const ok = await printWorksheet(items, wsMeta)
    expect(ok).toBe(true)
    expect(h.saveSpy).toHaveBeenCalledOnce() // RED（修前无平台分支 → 不调 downloadInApp）
    const [src, fn] = h.saveSpy.mock.calls[0]!
    expect(src).toMatch(/^data:text\/html;base64,/)
    expect(fn).toBe('小明_错题卷_0712_0712.html')
    const html = decode(src as string)
    expect(html).toContain('错题卷')
    expect(html).toContain('一个长方体的体积是多少')
  })

  it('Tauri 环境 → exportPdf 走后端 render 端点存真 .pdf（不再兜底 .html · 项-7）', async () => {
    h.tauri = true
    h.renderSpy.mockResolvedValue(new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])], { type: 'application/pdf' }))
    const ok = await exportPdf(items, wsMeta)
    expect(ok).toBe(true)
    expect(h.renderSpy).toHaveBeenCalledOnce()
    expect(h.saveSpy).toHaveBeenCalledOnce()
    expect(h.saveSpy.mock.calls[0]![0]).toMatch(/^data:application\/pdf;base64,/) // 真 pdf 字节，非 html
    expect(h.saveSpy.mock.calls[0]![1]).toBe('小明_错题卷_0712_0712.pdf')
  })

  it('浏览器/dev 环境（isTauri=false）→ 不调 downloadInApp（保留 iframe win.print()）', async () => {
    h.tauri = false
    // jsdom 的 iframe win.print 为 no-op；这里只验证平台分流不落原生保存
    await printPrepCard(card, prepMeta)
    await printWorksheet(items, wsMeta)
    expect(h.saveSpy).not.toHaveBeenCalled()
  })
})
