import { beforeEach, describe, expect, it, vi } from 'vitest'
import { webcrypto } from 'node:crypto'
import type { NativeFileGrant } from '../native-files'

const native = vi.hoisted(() => ({
  uploadGrantedFile: vi.fn(),
  stageBlob: vi.fn(),
  readImage: vi.fn(),
  grants: new Map<string, NativeFileGrant>(),
}))

vi.mock('@/utils/platform', () => ({ isTauri: () => true }))
vi.mock('../native-sidecar-stream', () => ({ sidecarStreamFetch: native.readImage }))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string, args: Record<string, string>) => {
    if (command === 'preserve_draft_attachment') return args.grantId
    if (command === 'restore_draft_attachment') {
      const grant = native.grants.get(args.attachmentId!)
      if (!grant) throw new Error('Draft attachment is missing')
      return { ...grant, grantId: `restored:${grant.grantId}`, operationId: `restored:${grant.operationId}` }
    }
    throw new Error(`Unexpected native command: ${command}`)
  }),
}))
vi.mock('../native-files', async (importOriginal) => ({
  ...await importOriginal<typeof import('../native-files')>(),
  createNativeFileOperation: vi.fn(() => 'chat-attachment:test'),
  nativeGrantFromFile: (file: File & { nativeFileGrant?: unknown }) => file.nativeFileGrant,
  stageBlob: native.stageBlob,
  uploadGrantedFile: native.uploadGrantedFile,
}))

describe('native attachment capability boundary', () => {
  beforeEach(() => {
    vi.stubGlobal('crypto', webcrypto)
    native.uploadGrantedFile.mockReset()
    native.stageBlob.mockReset()
    native.readImage.mockReset()
    native.grants.clear()
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

  it('refreshes the upload receipt from the persistent original when a saved image is explicitly resent', async () => {
    const { ensureChatAttachmentReceipt } = await import('../attachments')
    const response = new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } })
    // 响应与 File 使用同一 DOM Blob 类型，保持浏览器的字节转换语义。
    vi.spyOn(response, 'blob').mockResolvedValue(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }))
    native.readImage.mockResolvedValue(response)
    native.stageBlob.mockResolvedValue({ grantId: 'new-grant', operationId: 'new-upload', purpose: 'attachment_upload', name: 'photo.png', mime: 'image/png', size: 3, sourceSha256: '0'.repeat(64) })
    const previousSource = '/api/v1/sessions/source/messages/saved/attachments/0/content'
    const result = await ensureChatAttachmentReceipt({ type: 'image', name: 'photo.png', mime: 'image/png', data: previousSource, url: previousSource, attachmentId: 'expired-upload' })
    expect(result.attachmentId).toBe('att_test')
    expect(native.readImage).toHaveBeenCalledOnce()
    expect(native.stageBlob.mock.calls[0]?.[0]).toMatchObject({ name: 'photo.png', size: 3 })
    expect(native.uploadGrantedFile).toHaveBeenCalledOnce()
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
      const grant: NativeFileGrant = {
        grantId: `grant-${name}`,
        operationId: `operation-${name}`,
        purpose: 'attachment_upload',
        name,
        mime: 'image/png',
        size: 3,
        sourceSha256: 'a'.repeat(64),
      }
      native.grants.set(grant.grantId, grant)
      Object.defineProperty(file, 'nativeFileGrant', {
        value: grant,
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
