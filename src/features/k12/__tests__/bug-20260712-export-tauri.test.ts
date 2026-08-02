import { describe, it, expect, vi, beforeEach } from 'vitest'

// BUG-20260712-#6 导出 PDF/Word/Markdown 点了没反应：K12 导出用浏览器 `<a download>` + blob URL，
// Tauri WKWebView 里不触发下载（无下载管理器）→ 静默无反应。修：桌面走 Tauri 原生 Save 对话框
// + Rust 写盘（downloadInApp），浏览器/dev 保留 blob 回退。

const h = vi.hoisted(() => ({
  tauri: false,
  createOperation: vi.fn<(...args: unknown[]) => string>(() => 'save-blob:test'),
  pickSave: vi.fn(),
  stageBlob: vi.fn(),
  copyGrant: vi.fn(),
}))
vi.mock('@/utils/platform', () => ({ isTauri: () => h.tauri }))
vi.mock('@/api/native-files', () => ({
  createNativeFileOperation: (...args: unknown[]) => h.createOperation(...args),
  pickSaveFileGrant: (...args: unknown[]) => h.pickSave(...args),
  stageBlob: (...args: unknown[]) => h.stageBlob(...args),
  copyGrantedFile: (...args: unknown[]) => h.copyGrant(...args),
}))

import { download } from '../export'

describe('BUG-20260712-#6 导出走 Tauri 原生保存（WKWebView <a download> 失效）', () => {
  beforeEach(() => {
    h.createOperation.mockReset().mockReturnValue('save-blob:test')
    h.pickSave.mockReset().mockResolvedValue({
      grantId: 'destination', operationId: 'save-blob:test', purpose: 'save_copy',
      name: '错题本.md', mime: 'text/markdown', size: 0,
    })
    h.stageBlob.mockReset().mockResolvedValue({
      grantId: 'source', operationId: 'save-blob:test', purpose: 'save_copy',
      name: '错题本.md', mime: 'text/markdown', size: 24,
    })
    h.copyGrant.mockReset().mockResolvedValue(24)
  })

  it('Tauri 环境 → 通过 Blob + opaque grants 保存，不创建 data URL', async () => {
    h.tauri = true
    await download('错题本.md', '# 错题\n长方体的体积', 'text/markdown')
    expect(h.pickSave).toHaveBeenCalledWith('错题本.md', 'save_copy', 'save-blob:test')
    expect(h.stageBlob).toHaveBeenCalledWith(
      expect.any(Blob),
      '错题本.md',
      { purpose: 'save_copy', operationId: 'save-blob:test' },
    )
    const blob = h.stageBlob.mock.calls[0]![0] as Blob
    expect(blob.type).toBe('text/markdown')
    expect(new TextDecoder().decode(await blob.arrayBuffer())).toContain('长方体的体积')
    expect(h.copyGrant).toHaveBeenCalledOnce()
  })

  it('浏览器/dev 环境 → 不走 Tauri 保存（blob 回退）', async () => {
    h.tauri = false
    await download('x.md', 'hi', 'text/markdown')
    expect(h.pickSave).not.toHaveBeenCalled()
  })
})
