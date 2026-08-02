import { describe, it, expect, vi, beforeEach } from 'vitest'

// 项-7：导出 PDF 走后端 pandoc 出真 .pdf（此前 Tauri 下 iframe 打印失效 → 兜底存成 .html）。
// 治本：Tauri 下 exportPdf 把错题卷 Markdown 发给 /api/v1/render(pandoc) 得 PDF 字节 → 存 .pdf；
// 非 Tauri 保留原逻辑（打印对话框另存）。

const h = vi.hoisted(() => ({
  tauri: true,
  renderSpy: vi.fn<(req: { content: string; format: string; title?: string }) => Promise<Blob>>(),
  createOperation: vi.fn<(...args: unknown[]) => string>(() => 'save-blob:test'),
  pickSave: vi.fn(),
  stageBlob: vi.fn(),
  copyGrant: vi.fn(),
}))
vi.mock('@/utils/platform', () => ({ isTauri: () => h.tauri }))
vi.mock('@/api/k12', () => ({ renderDocument: (req: unknown) => h.renderSpy(req as { content: string; format: string }) }))
vi.mock('@/api/native-files', () => ({
  createNativeFileOperation: (...args: unknown[]) => h.createOperation(...args),
  pickSaveFileGrant: (...args: unknown[]) => h.pickSave(...args),
  stageBlob: (...args: unknown[]) => h.stageBlob(...args),
  copyGrantedFile: (...args: unknown[]) => h.copyGrant(...args),
}))

import { exportPdf, buildWorksheetMarkdown } from '../export'
import type { RecordItem } from '@/contracts'

const items: RecordItem[] = [
  { recordId: 'a', agentId: 'm', collection: '错题本', schemaVersion: '1', status: 'new', fields: { question: '3.8×3 = ?', knowledge_point: '小数乘法' }, version: 0 },
]
const meta = { childName: '小明', title: '复习卷', dateLabel: '2026-07-12' }

describe('项-7 Tauri 导出 PDF 走 render 端点出真 .pdf', () => {
  beforeEach(() => {
    h.renderSpy.mockReset()
    h.createOperation.mockReset().mockReturnValue('save-blob:test')
    h.pickSave.mockReset().mockResolvedValue({
      grantId: 'destination', operationId: 'save-blob:test', purpose: 'save_copy',
      name: '复习卷.pdf', mime: 'application/pdf', size: 0,
    })
    h.stageBlob.mockReset().mockResolvedValue({
      grantId: 'source', operationId: 'save-blob:test', purpose: 'save_copy',
      name: '复习卷.pdf', mime: 'application/pdf', size: 4,
    })
    h.copyGrant.mockReset().mockResolvedValue(4)
  })

  it('Tauri → 调 renderDocument(format=pdf) 并把 pdf 字节存 .pdf（非 .html）', async () => {
    h.tauri = true
    const pdf = new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])], { type: 'application/pdf' })
    h.renderSpy.mockResolvedValue(pdf) // "%PDF"
    const ok = await exportPdf(items, meta)
    expect(ok).toBe(true)
    expect(h.renderSpy).toHaveBeenCalledOnce() // RED：修前不调 render 端点
    const req = h.renderSpy.mock.calls[0]![0]
    expect(req.format).toBe('pdf')
    expect(req.content).toContain('3.8×3') // Markdown 内容含题干
    expect(h.pickSave).toHaveBeenCalledWith(
      '小明_复习卷_0712_0712.pdf',
      'save_copy',
      'save-blob:test',
    )
    expect(h.stageBlob).toHaveBeenCalledWith(
      pdf,
      '小明_复习卷_0712_0712.pdf',
      { purpose: 'save_copy', operationId: 'save-blob:test' },
    )
    expect(h.copyGrant).toHaveBeenCalledOnce()
  })

  it('非 Tauri → 保留原逻辑（不调 render 端点）', async () => {
    h.tauri = false
    const ok = await exportPdf(items, meta)
    expect(h.renderSpy).not.toHaveBeenCalled()
    expect(h.stageBlob).not.toHaveBeenCalled()
    expect(typeof ok).toBe('boolean')
  })

  it('buildWorksheetMarkdown 出题号 + 题干 + 知识点（pandoc 读 markdown）', () => {
    const md = buildWorksheetMarkdown(items, meta)
    expect(md).toContain('# 复习卷')
    expect(md).toContain('1.')
    expect(md).toContain('3.8×3 = ?')
    expect(md).toContain('小数乘法')
    expect(md).toContain('**答：**')
    // 每条答题线用 Markdown thematic break，由 Pandoc/Typst 渲染为不可换行的矢量横线。
    // 禁止再用 42 个全角下划线：窄版心下会折行为“长线 + 残余短线”。
    expect(md).not.toContain('＿')
    expect(md.match(/^---$/gm)).toHaveLength(3)
  })
})
