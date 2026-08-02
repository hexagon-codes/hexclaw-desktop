import { beforeEach, describe, expect, it, vi } from 'vitest'
import { webcrypto } from 'node:crypto'

const native = vi.hoisted(() => ({
  uploadGrantedFile: vi.fn(),
  stageBlob: vi.fn(),
}))

vi.mock('@/utils/platform', () => ({ isTauri: () => true }))
vi.mock('../native-files', () => ({
  createNativeFileOperation: vi.fn(() => 'chat-attachment:test'),
  stageBlob: native.stageBlob,
  uploadGrantedFile: native.uploadGrantedFile,
}))

describe('native attachment capability boundary', () => {
  beforeEach(() => {
    vi.stubGlobal('crypto', webcrypto)
    native.uploadGrantedFile.mockReset()
    native.stageBlob.mockReset()
    native.uploadGrantedFile.mockResolvedValue({
      status: 201,
      bytesTransferred: 3,
      body: {
        attachment_id: 'att_test',
        digest: `sha256:${'0'.repeat(64)}`,
        size: 3,
        media_type: 'image/png',
        display_name: 'photo.png',
        expires_at: '2030-01-01T00:00:00Z',
      },
    })
  })

  it('rejects an opaque native grant when Rust did not attest its source digest', async () => {
    const { uploadChatAttachment } = await import('../attachments')
    const file = new File([], 'photo.png', { type: 'image/png' })
    Object.defineProperty(file, 'nativeFileGrant', {
      value: {
        grantId: 'opaque-grant',
        operationId: 'native-drop:test',
        purpose: 'attachment_upload',
        name: 'photo.png',
        mime: 'image/png',
        size: 3,
      },
    })

    await expect(uploadChatAttachment(file)).rejects.toThrow(
      'Native attachment grant is missing its attested source digest',
    )
    expect(native.uploadGrantedFile).not.toHaveBeenCalled()
  })

  it('binds idempotency to digest, display name, and media type', async () => {
    const { uploadChatAttachment } = await import('../attachments')
    native.uploadGrantedFile.mockImplementation(async ({ grant }) => ({
      status: 201,
      bytesTransferred: grant.size,
      body: {
        attachment_id: `att_${grant.name}`,
        digest: `sha256:${grant.sourceSha256}`,
        size: grant.size,
        media_type: grant.mime,
        display_name: grant.name,
        expires_at: '2030-01-01T00:00:00Z',
      },
    }))
    const grantedFile = (name: string) => {
      const file = new File([], name, { type: 'image/png' })
      Object.defineProperty(file, 'nativeFileGrant', {
        value: {
          grantId: `grant-${name}`,
          operationId: `operation-${name}`,
          purpose: 'attachment_upload',
          name,
          mime: 'image/png',
          size: 3,
          sourceSha256: 'a'.repeat(64),
        },
      })
      return file
    }

    await uploadChatAttachment(grantedFile('first.png'))
    await uploadChatAttachment(grantedFile('second.png'))

    const keys = native.uploadGrantedFile.mock.calls.map(([options]) => options.idempotencyKey)
    expect(keys[0]).toMatch(/^chat-attachment:[0-9a-f]{64}$/)
    expect(keys[1]).toMatch(/^chat-attachment:[0-9a-f]{64}$/)
    expect(keys[0]).not.toBe(keys[1])
  })
})
