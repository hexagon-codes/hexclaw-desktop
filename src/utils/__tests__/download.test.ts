import { describe, it, expect, vi, beforeEach } from 'vitest'

const { pickSaveFileGrantMock, downloadIntoGrantMock, shellOpenMock } = vi.hoisted(() => ({
  pickSaveFileGrantMock: vi.fn(),
  downloadIntoGrantMock: vi.fn(),
  shellOpenMock: vi.fn(),
}))

vi.mock('@/api/native-files', () => ({
  pickSaveFileGrant: (...args: unknown[]) => pickSaveFileGrantMock(...args),
  downloadIntoGrant: (...args: unknown[]) => downloadIntoGrantMock(...args),
}))
vi.mock('@tauri-apps/plugin-shell', () => ({ open: (...a: unknown[]) => shellOpenMock(...a) }))

import { downloadInApp, openOrDownloadDocument } from '../download'

describe('downloadInApp — 应用内下载（原生 Save 对话框 + Rust 写盘）', () => {
  const grant = {
    grantId: 'save-grant-1',
    operationId: 'native-save:test',
    purpose: 'save_download',
    name: '会话.pdf',
    mime: 'application/pdf',
    size: 0,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    pickSaveFileGrantMock.mockResolvedValue(grant)
    downloadIntoGrantMock.mockResolvedValue({ status: 200, bytesTransferred: 123 })
  })

  it('http(s) 源 → opaque grant 流式下载，绝不暴露路径或走浏览器/shell', async () => {
    const ret = await downloadInApp('http://localhost:16060/api/v1/documents/preview/tok', '会话.pdf')
    expect(pickSaveFileGrantMock).toHaveBeenCalledWith('会话.pdf', 'save_download')
    expect(downloadIntoGrantMock).toHaveBeenCalledWith(
      grant,
      'http://localhost:16060/api/v1/documents/preview/tok',
    )
    expect(shellOpenMock).not.toHaveBeenCalled()
    expect(ret).toBe('会话.pdf')
  })

  it('拒绝 data URL，二进制不得经 renderer base64 传输', async () => {
    await expect(downloadInApp('data:application/pdf;base64,QUJD', 'x.pdf')).rejects.toThrow(
      'unsupported src',
    )
    expect(downloadIntoGrantMock).not.toHaveBeenCalled()
  })

  it('用户取消 Save 对话框 → 不写盘，返回 null', async () => {
    pickSaveFileGrantMock.mockResolvedValueOnce(null)
    const ret = await downloadInApp('http://localhost/x', 'x.pdf')
    expect(downloadIntoGrantMock).not.toHaveBeenCalled()
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
