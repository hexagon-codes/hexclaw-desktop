import { beforeEach, describe, expect, it, vi } from 'vitest'
import { webcrypto } from 'node:crypto'

const native = vi.hoisted(() => ({
  createNativeFileOperation: vi.fn(),
  stageBlob: vi.fn(),
  uploadGrantedFile: vi.fn(),
}))

vi.mock('@/config/env', () => ({
  env: { apiBase: 'http://127.0.0.1:16060' },
}))
vi.mock('@/utils/platform', () => ({ isTauri: () => true }))
vi.mock('../client', () => ({
  api: {},
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
}))
vi.mock('../native-files', () => ({
  createNativeFileOperation: native.createNativeFileOperation,
  stageBlob: native.stageBlob,
  uploadGrantedFile: native.uploadGrantedFile,
}))

describe('K12 native asset capability boundary', () => {
  beforeEach(() => {
    vi.stubGlobal('crypto', webcrypto)
    native.createNativeFileOperation.mockReset()
    native.stageBlob.mockReset()
    native.uploadGrantedFile.mockReset()
    native.uploadGrantedFile.mockResolvedValue({
      status: 201,
      bytesTransferred: 4,
      body: { asset_id: 'asset://mingming/photo.png', size: 4 },
    })
  })

  it('K12 图片资产上传复用 Tauri 原生 grant，不重新读取或暂存 File', async () => {
    const { k12UploadAsset } = await import('../k12')
    const file = new File([Uint8Array.from([0x89, 0x50, 0x4e, 0x47])], 'photo.png', {
      type: 'image/png',
    })
    const grant = {
      grantId: 'k12-native-grant',
      operationId: 'native-drop:k12',
      purpose: 'attachment_upload' as const,
      name: 'photo.png',
      mime: 'image/png',
      size: 4,
      sourceSha256: 'a'.repeat(64),
    }
    Object.defineProperty(file, 'nativeFileGrant', { value: grant })

    await expect(k12UploadAsset('mingming', file)).resolves.toEqual({
      asset_id: 'asset://mingming/photo.png',
      size: 4,
    })

    expect(native.stageBlob).not.toHaveBeenCalled()
    expect(native.uploadGrantedFile).toHaveBeenCalledWith(
      expect.objectContaining({
        grant,
        url: 'http://127.0.0.1:16060/api/k12/assets?agent=mingming',
        fieldName: 'file',
        idempotencyKey: expect.stringMatching(/^k12-asset:/),
      }),
    )
  })
})
