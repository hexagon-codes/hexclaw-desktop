import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  tauri: false,
  render: vi.fn(),
  createOperation: vi.fn(),
  pickSave: vi.fn(),
  stage: vi.fn(),
  copy: vi.fn(),
}))

vi.mock('@/utils/platform', () => ({ isTauri: () => h.tauri }))
vi.mock('@/api/k12', () => ({ renderDocument: (...args: unknown[]) => h.render(...args) }))
vi.mock('@/api/native-files', () => ({
  createNativeFileOperation: (...args: unknown[]) => h.createOperation(...args),
  pickSaveFileGrant: (...args: unknown[]) => h.pickSave(...args),
  stageBlob: (...args: unknown[]) => h.stage(...args),
  copyGrantedFile: (...args: unknown[]) => h.copy(...args),
}))

import type { RecordItem } from '@/contracts'
import {
  exportPdf,
  printPracticePaper,
  printPracticePaperWithReceipt,
  printTutoringTips,
  printWorksheet,
  savePracticePaperPdf,
} from '../export'

const card = {
  knowledge_points: ['长方体的体积'],
  sections: [{ title: '讲解思路', content: '底面积 × 高', source_label: 'AI 归纳' }],
}
const tutoringTipsMeta = { title: '辅导要点', gradeLabel: '五年级' }
const items = [
  {
    recordId: 'r1',
    fields: { question: '一个长方体的体积是多少', knowledge_point: '长方体的体积' },
  },
] as unknown as RecordItem[]
const worksheetMeta = { childName: '小明', title: '错题卷', dateLabel: '2026-07-12' }

const destinationGrant = {
  grantId: 'destination-grant',
  operationId: 'save-operation',
  purpose: 'save_copy',
  name: 'output.pdf',
  mime: 'application/pdf',
  size: 0,
}
const sourceGrant = {
  ...destinationGrant,
  grantId: 'source-grant',
  size: 8,
  sourceSha256: 'a'.repeat(64),
}

describe('DD-037 desktop print and save boundaries', () => {
  beforeEach(() => {
    h.tauri = true
    h.render
      .mockReset()
      .mockResolvedValue(
        new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])], { type: 'application/pdf' }),
      )
    h.createOperation.mockReset().mockReturnValue('save-operation')
    h.pickSave.mockReset().mockResolvedValue(destinationGrant)
    h.stage.mockReset().mockResolvedValue(sourceGrant)
    h.copy.mockReset().mockResolvedValue(8)
  })

  it('fails closed for every desktop helper that bypasses a persistent PrintJob', async () => {
    await expect(printWorksheet(items, worksheetMeta)).rejects.toThrow('服务端 PDF')
    await expect(printPracticePaper('# 练习卷\n\n1. 题目', '练习卷')).rejects.toThrow('服务端 PDF')
    await expect(printTutoringTips(card, tutoringTipsMeta)).rejects.toThrow('服务端 PDF')
    await expect(
      printPracticePaperWithReceipt(new Blob(['%PDF'], { type: 'application/pdf' })),
    ).rejects.toThrow('持久 PrintJob')

    expect(h.render).not.toHaveBeenCalled()
    expect(h.pickSave).not.toHaveBeenCalled()
  })

  it('contains no renderer base64 or direct native print command', async () => {
    const sourceCode = await import('../export?raw')
    const raw = typeof sourceCode === 'string' ? sourceCode : sourceCode.default

    expect(raw).not.toContain('native_print_pdf')
    expect(raw).not.toContain('pdfBase64')
    expect(raw).not.toContain('data:application/pdf;base64')
    expect(raw).not.toContain('downloadInApp')
  })

  it('exports a rendered worksheet through one opaque native grant operation', async () => {
    await expect(exportPdf(items, worksheetMeta)).resolves.toBe(true)

    expect(h.render).toHaveBeenCalledOnce()
    expect(h.createOperation).toHaveBeenCalledWith('save-blob')
    expect(h.pickSave).toHaveBeenCalledWith(
      '小明_错题卷_0712_0712.pdf',
      'save_copy',
      'save-operation',
    )
    expect(h.stage).toHaveBeenCalledWith(expect.any(Blob), '小明_错题卷_0712_0712.pdf', {
      purpose: 'save_copy',
      operationId: 'save-operation',
    })
    expect(h.copy).toHaveBeenCalledWith(sourceGrant, destinationGrant)
  })

  it('keeps save-as-PDF independent from the PrintJob coordinator', async () => {
    await expect(savePracticePaperPdf('# 观察练习\n\n1. 三档明暗', '观察练习卡')).resolves.toBe(
      true,
    )

    expect(h.render).toHaveBeenCalledWith({
      content: '# 观察练习\n\n1. 三档明暗',
      format: 'pdf',
      title: '观察练习卡',
    })
    expect(h.pickSave).toHaveBeenCalledWith('观察练习卡.pdf', 'save_copy', 'save-operation')
  })

  it('keeps browser development printing on window.print without native grants', async () => {
    h.tauri = false
    const originalCreateElement = document.createElement.bind(document)
    const frames = [0, 1].map(() => {
      const frame = originalCreateElement('iframe')
      Object.defineProperty(frame, 'contentWindow', {
        configurable: true,
        value: {
          document: { open: vi.fn(), write: vi.fn(), close: vi.fn() },
          focus: vi.fn(),
          print: vi.fn(),
        },
      })
      return frame
    })
    vi.spyOn(document, 'createElement').mockImplementation((tagName, options) =>
      tagName.toLowerCase() === 'iframe'
        ? frames.shift()!
        : originalCreateElement(tagName, options),
    )

    await expect(printTutoringTips(card, tutoringTipsMeta)).resolves.toBe(true)
    await expect(printWorksheet(items, worksheetMeta)).resolves.toBe(true)

    expect(h.render).not.toHaveBeenCalled()
    expect(h.pickSave).not.toHaveBeenCalled()
  })
})
