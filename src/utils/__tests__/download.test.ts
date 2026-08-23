import { describe, it, expect, vi, beforeEach } from 'vitest'

const {
  pickSaveFileGrantMock,
  downloadIntoGrantMock,
  createNativeFileOperationMock,
  stageBlobMock,
  copyGrantedFileMock,
  discardFileGrantMock,
  validateManagedSidecarURLMock,
  shellOpenMock,
} = vi.hoisted(() => ({
  pickSaveFileGrantMock: vi.fn(),
  downloadIntoGrantMock: vi.fn(),
  createNativeFileOperationMock: vi.fn(),
  stageBlobMock: vi.fn(),
  copyGrantedFileMock: vi.fn(),
  discardFileGrantMock: vi.fn(),
  validateManagedSidecarURLMock: vi.fn(),
  shellOpenMock: vi.fn(),
}))

vi.mock('@/api/native-files', () => ({
  pickSaveFileGrant: (...args: unknown[]) => pickSaveFileGrantMock(...args),
  downloadIntoGrant: (...args: unknown[]) => downloadIntoGrantMock(...args),
  createNativeFileOperation: (...args: unknown[]) => createNativeFileOperationMock(...args),
  stageBlob: (...args: unknown[]) => stageBlobMock(...args),
  copyGrantedFile: (...args: unknown[]) => copyGrantedFileMock(...args),
  discardFileGrant: (...args: unknown[]) => discardFileGrantMock(...args),
  validateManagedSidecarURL: (...args: unknown[]) => validateManagedSidecarURLMock(...args),
}))
vi.mock('@tauri-apps/plugin-shell', () => ({ open: (...a: unknown[]) => shellOpenMock(...a) }))

import { downloadInApp, openOrDownloadDocument, saveBlobInApp } from '../download'

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
    validateManagedSidecarURLMock.mockImplementation((src: string) => {
      const base = new URL('http://localhost:16060')
      const candidate = new URL(src, base)
      if (
        candidate.origin !== base.origin
        || candidate.username
        || candidate.password
        || candidate.hash
        || !/^https?:$/.test(candidate.protocol)
      ) {
        throw new Error('Native transfer target must be the managed Sidecar origin')
      }
    })
  })

  it('http(s) 源 → opaque grant 流式下载，绝不暴露路径或走浏览器/shell', async () => {
    const ret = await downloadInApp('http://localhost:16060/api/v1/documents/preview/tok', '会话.pdf')
    expect(validateManagedSidecarURLMock).toHaveBeenCalledWith(
      'http://localhost:16060/api/v1/documents/preview/tok',
    )
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
      'managed Sidecar origin',
    )
    expect(pickSaveFileGrantMock).not.toHaveBeenCalled()
    expect(downloadIntoGrantMock).not.toHaveBeenCalled()
  })

  it('拒绝 foreign URL，且必须在弹出 Save 对话框前失败', async () => {
    await expect(downloadInApp('https://example.com/private.pdf', 'x.pdf')).rejects.toThrow(
      'managed Sidecar origin',
    )
    expect(pickSaveFileGrantMock).not.toHaveBeenCalled()
    expect(downloadIntoGrantMock).not.toHaveBeenCalled()
  })

  it('用户取消 Save 对话框 → 不写盘，返回 null', async () => {
    pickSaveFileGrantMock.mockResolvedValueOnce(null)
    const ret = await downloadInApp('http://localhost:16060/x', 'x.pdf')
    expect(downloadIntoGrantMock).not.toHaveBeenCalled()
    expect(ret).toBeNull()
  })
})

describe('saveBlobInApp — Blob 经同一 opaque operation 流式暂存并保存', () => {
  const operationId = 'save-blob:test'
  const destination = {
    grantId: 'destination-grant',
    operationId,
    purpose: 'save_copy',
    name: 'result.png',
    mime: 'image/png',
    size: 0,
  }
  const source = {
    grantId: 'source-grant',
    operationId,
    purpose: 'save_copy',
    name: 'result.png',
    mime: 'image/png',
    size: 3,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    createNativeFileOperationMock.mockReturnValue(operationId)
    pickSaveFileGrantMock.mockResolvedValue(destination)
    stageBlobMock.mockResolvedValue(source)
    copyGrantedFileMock.mockResolvedValue(3)
    discardFileGrantMock.mockResolvedValue(undefined)
  })

  it('pick、stage、copy 共用一个 operationId，成功只返回目标叶子名', async () => {
    const blob = new Blob(['png'], { type: 'image/png' })
    const abort = new AbortController()

    await expect(saveBlobInApp(blob, 'result.png', abort.signal)).resolves.toBe('result.png')

    expect(createNativeFileOperationMock).toHaveBeenCalledWith('save-blob')
    expect(pickSaveFileGrantMock).toHaveBeenCalledWith('result.png', 'save_copy', operationId)
    expect(stageBlobMock).toHaveBeenCalledWith(blob, 'result.png', {
      purpose: 'save_copy',
      operationId,
      signal: abort.signal,
    })
    expect(copyGrantedFileMock).toHaveBeenCalledWith(source, destination)
    expect(discardFileGrantMock).not.toHaveBeenCalled()
  })

  it('用户取消 Save 对话框时不暂存、不复制且返回 null', async () => {
    pickSaveFileGrantMock.mockResolvedValueOnce(null)

    await expect(saveBlobInApp(new Blob(['x']), 'result.png')).resolves.toBeNull()

    expect(stageBlobMock).not.toHaveBeenCalled()
    expect(copyGrantedFileMock).not.toHaveBeenCalled()
    expect(discardFileGrantMock).not.toHaveBeenCalled()
  })

  it('调用前已取消时不创建 operation，也不弹出 Save 对话框', async () => {
    const abort = new AbortController()
    abort.abort()

    await expect(saveBlobInApp(new Blob(['x']), 'result.png', abort.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })

    expect(createNativeFileOperationMock).not.toHaveBeenCalled()
    expect(pickSaveFileGrantMock).not.toHaveBeenCalled()
    expect(stageBlobMock).not.toHaveBeenCalled()
  })

  it('暂存失败时回收已签发的目标 grant，并保留原始错误', async () => {
    const failure = new Error('staging failed')
    stageBlobMock.mockRejectedValueOnce(failure)

    await expect(saveBlobInApp(new Blob(['x']), 'result.png')).rejects.toBe(failure)

    expect(copyGrantedFileMock).not.toHaveBeenCalled()
    expect(discardFileGrantMock).toHaveBeenCalledWith(destination)
  })

  it('复制失败时 best-effort 回收源和目标 grant，清理失败不覆盖原始错误', async () => {
    const failure = new Error('copy failed')
    copyGrantedFileMock.mockRejectedValueOnce(failure)
    discardFileGrantMock
      .mockImplementationOnce(() => {
        throw new Error('cleanup failed synchronously')
      })
      .mockRejectedValueOnce(new Error('already consumed'))

    await expect(saveBlobInApp(new Blob(['x']), 'result.png')).rejects.toBe(failure)

    expect(discardFileGrantMock).toHaveBeenCalledWith(source)
    expect(discardFileGrantMock).toHaveBeenCalledWith(destination)
  })

  it('暂存完成后收到取消时不复制，并 best-effort 回收两个 grant', async () => {
    const abort = new AbortController()
    stageBlobMock.mockImplementationOnce(async () => {
      abort.abort()
      return source
    })

    await expect(saveBlobInApp(new Blob(['x']), 'result.png', abort.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })

    expect(copyGrantedFileMock).not.toHaveBeenCalled()
    expect(discardFileGrantMock).toHaveBeenCalledWith(source)
    expect(discardFileGrantMock).toHaveBeenCalledWith(destination)
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
