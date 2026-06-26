import { describe, it, expect, vi, beforeEach } from 'vitest'

const { saveMock, invokeMock, shellOpenMock } = vi.hoisted(() => ({
  saveMock: vi.fn(),
  invokeMock: vi.fn(),
  shellOpenMock: vi.fn(),
}))

vi.mock('@tauri-apps/plugin-dialog', () => ({ save: (...a: unknown[]) => saveMock(...a) }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }))
vi.mock('@tauri-apps/plugin-shell', () => ({ open: (...a: unknown[]) => shellOpenMock(...a) }))

import { downloadInApp, openOrDownloadDocument } from '../download'

describe('downloadInApp — 应用内下载（原生 Save 对话框 + Rust 写盘）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    invokeMock.mockResolvedValue(123)
  })

  it('http(s) 源 → save_file_from_url，绝不走浏览器/shell', async () => {
    saveMock.mockResolvedValueOnce('/Users/me/会话.pdf')
    const ret = await downloadInApp('http://localhost:16060/api/v1/documents/preview/tok', '会话.pdf')
    expect(saveMock).toHaveBeenCalledWith({ defaultPath: '会话.pdf' })
    expect(invokeMock).toHaveBeenCalledWith('save_file_from_url', {
      url: 'http://localhost:16060/api/v1/documents/preview/tok',
      path: '/Users/me/会话.pdf',
    })
    expect(shellOpenMock).not.toHaveBeenCalled()
    expect(ret).toBe('/Users/me/会话.pdf')
  })

  it('data: 源 → save_bytes_to_path（base64）', async () => {
    saveMock.mockResolvedValueOnce('/Users/me/x.pdf')
    await downloadInApp('data:application/pdf;base64,QUJD', 'x.pdf')
    expect(invokeMock).toHaveBeenCalledWith('save_bytes_to_path', { base64Data: 'QUJD', path: '/Users/me/x.pdf' })
  })

  it('用户取消 Save 对话框 → 不写盘，返回 null', async () => {
    saveMock.mockResolvedValueOnce(null)
    const ret = await downloadInApp('http://localhost/x', 'x.pdf')
    expect(invokeMock).not.toHaveBeenCalled()
    expect(ret).toBeNull()
  })
})

describe('openOrDownloadDocument — BUG-20260626: PDF 下载走了系统浏览器（应应用内下载）', () => {
  const baseDeps = () => ({
    file: new File(['x'], 'doc.pdf', { type: 'application/pdf' }),
    filename: 'doc.pdf',
    uploadPreview: vi.fn().mockResolvedValue({ token: 'tk' }),
    previewUrl: (token: string, dl: boolean) => `http://localhost:16060/api/v1/documents/preview/${token}${dl ? '?dl=1' : ''}`,
    toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() },
    expiredMsg: '预览已过期',
    failedMsg: '预览失败',
    savedMsg: (p: string) => '已保存到 ' + p,
  })

  beforeEach(() => vi.clearAllMocks())

  it('[核心 RED] 下载 → 必须走应用内 saveInApp，绝不 shell.open 到浏览器', async () => {
    const saveInApp = vi.fn().mockResolvedValue('/Users/me/doc.pdf')
    const shell = vi.fn().mockResolvedValue(undefined)
    const deps = baseDeps()

    await openOrDownloadDocument({ ...deps, download: true, saveInApp, shell })

    // 下载链路应交给原生 Save（应用内），不能丢给系统浏览器
    expect(saveInApp).toHaveBeenCalledWith('http://localhost:16060/api/v1/documents/preview/tk', 'doc.pdf')
    expect(shell).not.toHaveBeenCalled()
    expect(deps.toast.success).toHaveBeenCalledWith('已保存到 /Users/me/doc.pdf')
  })

  it('预览 → 走系统默认应用（shell.open），不弹下载对话框', async () => {
    const saveInApp = vi.fn()
    const shell = vi.fn().mockResolvedValue(undefined)
    const deps = baseDeps()

    await openOrDownloadDocument({ ...deps, download: false, saveInApp, shell })

    expect(shell).toHaveBeenCalledWith('http://localhost:16060/api/v1/documents/preview/tk')
    expect(saveInApp).not.toHaveBeenCalled()
  })

  it('预览句柄失效（file=null）→ 提示过期，不上传不下载', async () => {
    const deps = baseDeps()
    await openOrDownloadDocument({ ...deps, file: null, download: true, saveInApp: vi.fn(), shell: vi.fn() })
    expect(deps.toast.info).toHaveBeenCalledWith('预览已过期')
    expect(deps.uploadPreview).not.toHaveBeenCalled()
  })
})
