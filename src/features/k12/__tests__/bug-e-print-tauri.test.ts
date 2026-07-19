import { describe, it, expect, vi, beforeEach } from 'vitest'

// DD-023A：所有 K12「打印」在 Tauri 中必须进入原生 PrintJob / 系统打印对话框。
// 另存 PDF 是独立导出动作；保存 HTML/PDF 后让用户再打开打印不算「打印」。

const h = vi.hoisted(() => ({
  tauri: false,
  printSpy: vi.fn<(command: string, args: { html: string }) => Promise<boolean>>(),
  saveSpy: vi.fn<(src: string, fn: string) => Promise<string | null>>(),
  renderSpy: vi.fn<(req: unknown) => Promise<Blob>>(),
}))
vi.mock('@/utils/platform', () => ({ isTauri: () => h.tauri }))
vi.mock('@/utils/download', () => ({ downloadInApp: (src: string, fn: string) => h.saveSpy(src, fn) }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: (command: string, args: { html: string }) => h.printSpy(command, args) }))
// 另存 PDF 仍走后端 render 端点；它与 PrintJob 严格分轨。
vi.mock('@/api/k12', () => ({ renderDocument: (req: unknown) => h.renderSpy(req) }))

import { printPrepCard, printWorksheet, printPracticePaper, savePracticePaperPdf, exportPdf } from '../export'
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

describe('DD-023A K12 打印走原生 PrintJob，另存 PDF 独立', () => {
  beforeEach(() => {
    h.printSpy.mockReset().mockResolvedValue(true)
    h.saveSpy.mockReset().mockResolvedValue('/tmp/saved')
    h.renderSpy.mockReset()
  })

  it('Tauri 原生打印对话框取消 → 所有打印入口返回 false，且不触发保存/渲染 fallback', async () => {
    h.tauri = true
    h.printSpy.mockResolvedValue(false)

    expect(await printWorksheet(items, wsMeta)).toBe(false)
    expect(await printPracticePaper('# 练习卷\n\n1. 题目', '练习卷')).toBe(false)
    expect(await printPrepCard(card, prepMeta)).toBe(false)
    expect(h.printSpy).toHaveBeenCalledTimes(3)
    expect(h.saveSpy).not.toHaveBeenCalled()
    expect(h.renderSpy).not.toHaveBeenCalled()
  })

  it('Tauri 练习卷 → 直接把同源 A4 HTML 交给 native_print_html', async () => {
    h.tauri = true
    const ok = await printPracticePaper('# 观察练习\n\n1. 画三档明暗', '观察练习卡')
    expect(ok).toBe(true)
    expect(h.printSpy).toHaveBeenCalledOnce()
    const [command, args] = h.printSpy.mock.calls[0]!
    expect(command).toBe('native_print_html')
    expect(args.html).toContain('观察练习卡')
    expect(args.html).toContain('画三档明暗')
    expect(h.renderSpy).not.toHaveBeenCalled()
    expect(h.saveSpy).not.toHaveBeenCalled()
  })

  it('Tauri 辅导要点 → 原生打印 HTML，不落 .html 文件', async () => {
    h.tauri = true
    const ok = await printPrepCard(card, prepMeta)
    expect(ok).toBe(true)
    expect(h.printSpy).toHaveBeenCalledWith('native_print_html', {
      html: expect.stringContaining('长方体的体积'),
    })
    expect(h.saveSpy).not.toHaveBeenCalled()
  })

  it('Tauri 错题卷 → 原生打印 HTML，不落 .html 文件', async () => {
    h.tauri = true
    const ok = await printWorksheet(items, wsMeta)
    expect(ok).toBe(true)
    expect(h.printSpy).toHaveBeenCalledWith('native_print_html', {
      html: expect.stringContaining('一个长方体的体积是多少'),
    })
    expect(h.saveSpy).not.toHaveBeenCalled()
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
    expect(h.printSpy).not.toHaveBeenCalled()
  })

  it('Tauri「另存 PDF」只走 render + Save，对 PrintJob 零调用', async () => {
    h.tauri = true
    h.renderSpy.mockResolvedValue(new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])], { type: 'application/pdf' }))

    expect(await savePracticePaperPdf('# 观察练习\n\n1. 三档明暗', '观察练习卡')).toBe(true)

    expect(h.renderSpy).toHaveBeenCalledWith({
      content: '# 观察练习\n\n1. 三档明暗', format: 'pdf', title: '观察练习卡',
    })
    expect(h.saveSpy.mock.calls[0]![0]).toMatch(/^data:application\/pdf;base64,/)
    expect(h.saveSpy.mock.calls[0]![1]).toBe('观察练习卡.pdf')
    expect(h.printSpy).not.toHaveBeenCalled()
  })

  it('浏览器/dev 环境（isTauri=false）→ 使用系统 window.print，不调用 Tauri PrintJob/保存', async () => {
    h.tauri = false
    // jsdom 的 iframe win.print 为 no-op；这里只验证平台分流不落原生保存
    await printPrepCard(card, prepMeta)
    await printWorksheet(items, wsMeta)
    expect(h.printSpy).not.toHaveBeenCalled()
    expect(h.saveSpy).not.toHaveBeenCalled()
  })
})
