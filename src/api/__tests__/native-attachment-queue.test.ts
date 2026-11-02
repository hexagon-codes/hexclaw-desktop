import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { webcrypto } from 'node:crypto'
import { invoke } from '@tauri-apps/api/core'
import type { NativeFileGrant } from '../native-files'

const native = vi.hoisted(() => ({
  grants: new Map<string, { grant: NativeFileGrant; expiresAt: number }>(),
  drafts: new Map<string, NativeFileGrant>(),
  uploads: [] as Array<{ grant: NativeFileGrant; idempotencyKey: string }>,
  preserved: [] as string[],
  sequence: 0,
  unknownName: '',
  unknown: new Error('Upload result is unknown'),
}))

vi.mock('@/utils/platform', () => ({ isTauri: () => true }))
vi.mock('@/config/env', () => ({ env: { apiBase: 'http://localhost:16060' } }))
vi.mock('@tauri-apps/api/core', () => ({
  Channel: class<T> {
    constructor(readonly onmessage: (event: T) => void) {}
  },
  invoke: vi.fn(async (command: string, args: Record<string, string>) => {
    if (command === 'restore_draft_attachment') {
      const saved = native.drafts.get(args.attachmentId!)
      if (!saved) throw new Error('Draft attachment is missing')
      const grant = { ...saved, grantId: `restored-${++native.sequence}`, operationId: `upload-${native.sequence}` }
      native.grants.set(grant.grantId, { grant, expiresAt: Date.now() + 60_000 })
      return grant
    }
    const registered = native.grants.get(args.grantId!)
    if (!registered || registered.expiresAt <= Date.now()) throw new Error('File grant expired')
    if (registered.grant.operationId !== args.operationId) throw new Error('File operation mismatch')
    if (command === 'preserve_draft_attachment') {
      const id = `draft-${++native.sequence}`
      native.preserved.push(registered.grant.grantId)
      native.drafts.set(id, registered.grant)
      return id
    }
    if (command === 'upload_file_grant') {
      const { grant } = registered
      native.grants.delete(grant.grantId)
      native.uploads.push({ grant, idempotencyKey: args.idempotencyKey! })
      // 首个上传已取得授权后耗时超过TTL，队列中的授权仍按原期限过期。
      if (grant.name === 'first.pdf') vi.setSystemTime(Date.now() + 61_000)
      if (grant.name === native.unknownName) throw native.unknown
      return {
        status: 201,
        bytesTransferred: grant.size,
        body: grant.mime.startsWith('image/')
          ? {
              attachment_id: 'uploaded-image', digest: `sha256:${grant.sourceSha256}`,
              size: grant.size, media_type: grant.mime, display_name: grant.name,
              expires_at: new Date(Date.now() + 60_000).toISOString(),
            }
          : { text: `Extracted ${grant.name}`, file_name: grant.name },
      }
    }
    throw new Error(`Unexpected native command: ${command}`)
  }),
}))

import { fileFromNativeGrant, nativeGrantFromFile } from '../native-files'
import { preserveComposerFile, restoreComposerFile } from '@/services/composer-drafts'
import { extractDocument } from '../documents'
import { uploadChatAttachment } from '../attachments'

function selectedFile(name: string, mime: string) {
  const grant: NativeFileGrant = {
    grantId: `selected-${name}`, operationId: `select-${name}`, purpose: 'attachment_upload',
    name, mime, size: 17, sourceSha256: 'a'.repeat(64),
  }
  native.grants.set(grant.grantId, { grant, expiresAt: Date.now() + 60_000 })
  return fileFromNativeGrant(grant)
}

const queuedFormats = [
  ['second.pdf', 'application/pdf'],
  ['second.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['second.png', 'image/png'],
] as const

describe('queued native attachments renew grants at the upload boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime('2030-01-01T00:00:00Z')
    vi.stubGlobal('crypto', webcrypto)
    native.grants.clear()
    native.drafts.clear()
    native.uploads.length = 0
    native.preserved.length = 0
    native.sequence = 0
    native.unknownName = ''
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  for (const [name, mime] of queuedFormats) {
    for (const unknown of [false, true]) {
      it(`${name} uses a new grant after 61 seconds and ${unknown ? 'does not retry an unknown upload' : 'uploads once'}`, async () => {
        const files = await Promise.all([
          selectedFile('first.pdf', 'application/pdf'), selectedFile(name, mime),
        ].map(async (file) => restoreComposerFile(await preserveComposerFile(file))))
        const queuedGrant = nativeGrantFromFile(files[1]!)!
        await extractDocument(files[0]!)
        expect(Date.now()).toBe(Date.parse('2030-01-01T00:01:01Z'))
        expect(native.grants.get(queuedGrant.grantId)!.expiresAt).toBeLessThan(Date.now())
        if (unknown) native.unknownName = name
        const pending = mime.startsWith('image/')
          ? uploadChatAttachment(files[1]!) : extractDocument(files[1]!)
        const result = await pending.then((value) => ({ value }), (error: unknown) => ({ error }))
        const expectedBody = expect.objectContaining(mime.startsWith('image/')
          ? { attachment_id: 'uploaded-image', size: 17 } : { text: `Extracted ${name}`, file_name: name })
        expect(result).toEqual(unknown ? { error: native.unknown } : { value: expectedBody })
        expect(native.uploads.map(({ grant }) => grant.name)).toEqual(['first.pdf', name])
        expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'upload_file_grant')).toHaveLength(2)
        const uploaded = native.uploads[1]!
        expect(uploaded.grant.grantId).not.toBe(queuedGrant.grantId)
        expect(uploaded.grant).toMatchObject({ name, mime, size: 17, sourceSha256: 'a'.repeat(64), purpose: 'attachment_upload' })
        expect(uploaded.idempotencyKey).toMatch(mime.startsWith('image/')
          ? /^chat-attachment:[a-f0-9]{64}$/ : /^document-extract:a{64}$/)
        expect(native.preserved).toEqual(['selected-first.pdf', `selected-${name}`])
      })
    }
  }
})
