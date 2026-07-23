import { describe, it, expect, vi, beforeEach } from 'vitest'

// DD-023A：所有 K12「打印」在 Tauri 中必须进入原生 PrintJob / 系统打印对话框。
// 另存 PDF 是独立导出动作；保存 HTML/PDF 后让用户再打开打印不算「打印」。

const h = vi.hoisted(() => ({
  tauri: false,
  printSpy: vi.fn<(command: string, args: Record<string, unknown>) => Promise<unknown>>(),
  saveSpy: vi.fn<(src: string, fn: string) => Promise<string | null>>(),
  renderSpy: vi.fn<(req: unknown) => Promise<Blob>>(),
}))
vi.mock('@/utils/platform', () => ({ isTauri: () => h.tauri }))
vi.mock('@/utils/download', () => ({ downloadInApp: (src: string, fn: string) => h.saveSpy(src, fn) }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: (command: string, args: Record<string, unknown>) => h.printSpy(command, args) }))
// 另存 PDF 仍走后端 render 端点；它与 PrintJob 严格分轨。
vi.mock('@/api/k12', () => ({ renderDocument: (req: unknown) => h.renderSpy(req) }))

import {
  exportPdf,
  printPracticePaper,
  printPracticePaperWithReceipt,
  printTutoringTips,
  printWorksheet,
  savePracticePaperPdf,
} from '../export'
import type { RecordItem } from '@/contracts'

const card = {
  knowledge_points: ['长方体的体积'],
  sections: [{ title: '讲解思路', content: '底面积 × 高', source_label: 'AI 归纳' }],
}
const tutoringTipsMeta = { title: '辅导要点', gradeLabel: '五年级' }

const items = [
  { recordId: 'r1', fields: { question: '一个长方体的体积是多少', knowledge_point: '长方体的体积' } },
] as unknown as RecordItem[]
const wsMeta = { childName: '小明', title: '错题卷', dateLabel: '2026-07-12' }
const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37])
const pdf = () => new Blob([pdfBytes], { type: 'application/pdf' })

describe('DD-023A K12 打印走原生 PrintJob，另存 PDF 独立', () => {
  beforeEach(() => {
    h.printSpy.mockReset().mockResolvedValue({
      status: 'printed',
      native_job_id: 'native-default',
      native_receipt_id: 'native-receipt-default',
      printer_snapshot: { adapter: 'appkit', platform: 'macos' },
    })
    h.saveSpy.mockReset().mockResolvedValue('/tmp/saved')
    h.renderSpy.mockReset().mockImplementation(async () => pdf())
  })

  it('Tauri 旧的直接打印 helpers fail closed，禁止绕过可见 PDF 预览', async () => {
    h.tauri = true
    await expect(printWorksheet(items, wsMeta)).rejects.toThrow('必须使用服务端 PDF')
    await expect(printPracticePaper('# 练习卷\n\n1. 题目', '练习卷')).rejects.toThrow('必须使用服务端 PDF')
    await expect(printTutoringTips(card, tutoringTipsMeta)).rejects.toThrow('必须使用服务端 PDF')
    expect(h.printSpy).not.toHaveBeenCalled()
    expect(h.saveSpy).not.toHaveBeenCalled()
    expect(h.renderSpy).not.toHaveBeenCalled()
  })

  it('Tauri 练习卷把原生 operation receipt 原样交给持久 PrintJob 链', async () => {
    h.tauri = true
    h.printSpy.mockResolvedValue({
      status: 'printed',
      native_job_id: 'native-job-1',
      native_receipt_id: 'native-receipt-1',
      printer_snapshot: { adapter: 'appkit', platform: 'macos' },
    })

    await expect(
      printPracticePaperWithReceipt(pdf()),
    ).resolves.toEqual({
      status: 'printed',
      native_job_id: 'native-job-1',
      native_receipt_id: 'native-receipt-1',
      printer_snapshot: { adapter: 'appkit', platform: 'macos' },
    })
  })

  it('Tauri typed receipt 缺打印机快照事实时只归类 outcome_unknown', async () => {
    h.tauri = true
    h.printSpy.mockResolvedValue({
      status: 'printed',
      native_job_id: 'native-job-1',
      native_receipt_id: 'native-receipt-1',
      printer_snapshot: {},
    })

    await expect(printPracticePaperWithReceipt(pdf())).resolves.toMatchObject({
      status: 'outcome_unknown',
      failure_kind: 'native_result_unverifiable',
    })
  })

  it('已预览 PDF 只编码一次精确字节并交给 native_print_pdf', async () => {
    h.tauri = true
    h.printSpy.mockResolvedValue({
      status: 'printed',
      native_job_id: 'native-job-exact',
      native_receipt_id: 'native-receipt-exact',
      printer_snapshot: { adapter: 'appkit', platform: 'macos' },
    })
    const receipt = await printPracticePaperWithReceipt(pdf())
    expect(receipt.status).toBe('printed')
    expect(h.printSpy).toHaveBeenCalledOnce()
    const [command, args] = h.printSpy.mock.calls[0]!
    expect(command).toBe('native_print_pdf')
    expect(args).toEqual({ pdfBase64: 'JVBERi0xLjc=' })
    expect(args).not.toHaveProperty('html')
    expect(h.saveSpy).not.toHaveBeenCalled()
  })

  it('持久 PrintJob bridge 接收已预览的 PDF Blob，不重新渲染或改写版式', async () => {
    h.tauri = true
    const previewedPdf = pdf()
    h.printSpy.mockResolvedValue({
      status: 'printed',
      native_job_id: 'native-job-2',
      native_receipt_id: 'native-receipt-2',
      printer_snapshot: { adapter: 'pdfkit-appkit', platform: 'macos' },
    })

    await printPracticePaperWithReceipt(previewedPdf)

    expect(h.printSpy).toHaveBeenCalledWith('native_print_pdf', {
      pdfBase64: 'JVBERi0xLjc=',
    })
    expect(h.renderSpy).not.toHaveBeenCalled()
  })

  it('原生边界在 IPC 前把空、超限和伪 PDF 归类为可安全重试的 failed', async () => {
    h.tauri = true
    const oversized = {
      size: 32 * 1024 * 1024 + 1,
      arrayBuffer: vi.fn(),
    } as unknown as Blob

    await expect(printPracticePaperWithReceipt(new Blob([]))).resolves.toMatchObject({
      status: 'failed', failure_kind: 'pdf_preflight_failed', failure_detail: expect.stringContaining('不能为空'),
    })
    await expect(printPracticePaperWithReceipt(oversized)).resolves.toMatchObject({
      status: 'failed', failure_kind: 'pdf_preflight_failed', failure_detail: expect.stringContaining('过大'),
    })
    await expect(
      printPracticePaperWithReceipt(new Blob(['<html>not pdf</html>'], { type: 'application/pdf' })),
    ).resolves.toMatchObject({
      status: 'failed', failure_kind: 'pdf_preflight_failed', failure_detail: expect.stringContaining('不是有效的 PDF'),
    })

    expect(oversized.arrayBuffer).not.toHaveBeenCalled()
    expect(h.printSpy).not.toHaveBeenCalled()
  })

  it('原生已确认的确定性故障保持 failed；IPC 无结果只归类 outcome_unknown', async () => {
    h.tauri = true
    h.printSpy.mockResolvedValueOnce({
      status: 'failed',
      native_job_id: 'native-failed',
      printer_snapshot: { adapter: 'appkit', platform: 'macos' },
      failure_kind: 'pdf_page_limit_exceeded',
      failure_detail: '打印 PDF 页数超过限制',
    })
    await expect(printPracticePaperWithReceipt(pdf())).resolves.toMatchObject({
      status: 'failed', native_job_id: 'native-failed', failure_kind: 'pdf_page_limit_exceeded',
    })

    h.printSpy.mockRejectedValueOnce(new Error('native response channel closed'))
    await expect(printPracticePaperWithReceipt(pdf())).resolves.toMatchObject({
      status: 'outcome_unknown', failure_kind: 'native_result_unavailable',
      failure_detail: expect.stringContaining('native response channel closed'),
    })
  })

  it('Tauri 辅导要点 helper 不得成为绕过预览的 PDFKit 旁路', async () => {
    h.tauri = true
    await expect(printTutoringTips(card, tutoringTipsMeta)).rejects.toThrow('必须使用服务端 PDF')
    expect(h.renderSpy).not.toHaveBeenCalled()
    expect(h.printSpy).not.toHaveBeenCalled()
    expect(h.saveSpy).not.toHaveBeenCalled()
  })

  it('Tauri 错题卷 helper 不得成为绕过预览的 PDFKit 旁路', async () => {
    h.tauri = true
    await expect(printWorksheet(items, wsMeta)).rejects.toThrow('必须使用服务端 PDF')
    expect(h.renderSpy).not.toHaveBeenCalled()
    expect(h.printSpy).not.toHaveBeenCalled()
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
    await printTutoringTips(card, tutoringTipsMeta)
    await printWorksheet(items, wsMeta)
    expect(h.printSpy).not.toHaveBeenCalled()
    expect(h.saveSpy).not.toHaveBeenCalled()
  })
})
