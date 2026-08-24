import { beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  calls: [] as Array<{ command: string; args: Record<string, unknown> }>,
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn((command: string, args: Record<string, unknown>) => {
    native.calls.push({ command, args })
    return Promise.resolve(undefined)
  }),
}))

import {
  bindNativeImagePreviewLease,
  fileFromNativeGrant,
  nativeGrantFromFile,
  revokeNativeImagePreviewLease,
  syncNativeImagePreviewScope,
  type NativeFileGrant,
} from '../native-files'

const unboundGrant = {
  grantId: '0e0b70ce-a2a6-4dd4-97e6-fc99f3e5790f',
  operationId: 'native-drop:preview',
  purpose: 'attachment_upload',
  name: 'artwork.png',
  mime: 'image/png',
  size: 3,
  sourceSha256: 'a'.repeat(64),
  previewLease: {
    leaseId: '4f74b7c3-719d-4d72-a77c-d63e9010f7a0',
    mime: 'image/png',
    width: 1,
    height: 1,
    createdAtUnixMs: 1_777_000_000_000,
    expiresAtUnixMs: 1_777_000_060_000,
  },
} satisfies NativeFileGrant

const scope = {
  ownerId: 'desktop-user',
  sessionId: 'session-a',
  attachmentId: '8ef5a11a-e322-43c9-a3e6-81616794406f',
}

const boundPreviewLease = {
  ...unboundGrant.previewLease,
  ...scope,
  url: `hexclaw-preview://localhost/${unboundGrant.previewLease.leaseId}`,
}

const boundGrant = {
  ...unboundGrant,
  previewLease: boundPreviewLease,
} satisfies NativeFileGrant

describe('native file grant preview lease', () => {
  beforeEach(() => {
    native.calls.length = 0
  })

  it('does not expose a readable URL until the lease is bound to real business identities', async () => {
    expect(unboundGrant.previewLease).not.toHaveProperty('url')

    native.calls.length = 0
    const invoke = vi.mocked((await import('@tauri-apps/api/core')).invoke)
    invoke.mockImplementationOnce((command, args) => {
      native.calls.push({ command, args: args as Record<string, unknown> })
      return Promise.resolve(boundPreviewLease)
    })

    const grant = await bindNativeImagePreviewLease(unboundGrant, scope)
    const file = fileFromNativeGrant(grant)

    expect(file.size).toBe(0)
    expect((file as File & { nativeSize?: number }).nativeSize).toBe(grant.size)
    expect(nativeGrantFromFile(file)).toBe(grant)
    expect(grant.previewLease.leaseId).not.toBe(grant.grantId)
    expect(grant.previewLease.url).toMatch(
      /^(hexclaw-preview:\/\/localhost\/|http:\/\/hexclaw-preview\.localhost\/)/,
    )
    expect(grant.previewLease.url).not.toContain(grant.name)
    expect(grant.previewLease.url).not.toMatch(/^(?:blob:|data:|file:)/)
    expect(grant.previewLease).toMatchObject(scope)
    expect(native.calls).toEqual([
      {
        command: 'bind_native_image_preview_lease',
        args: {
          leaseId: unboundGrant.previewLease.leaseId,
          operationId: unboundGrant.operationId,
          uploadGrantId: unboundGrant.grantId,
          ...scope,
        },
      },
    ])
  })

  it('synchronizes the window active exact-set without putting identity in the preview URL', async () => {
    await syncNativeImagePreviewScope({
      ownerId: scope.ownerId,
      sessionId: scope.sessionId,
      attachmentIds: [scope.attachmentId],
    })

    expect(native.calls).toEqual([
      {
        command: 'sync_native_image_preview_scope',
        args: {
          ownerId: scope.ownerId,
          sessionId: scope.sessionId,
          attachmentIds: [scope.attachmentId],
        },
      },
    ])
    expect(boundPreviewLease.url).not.toContain(scope.ownerId)
    expect(boundPreviewLease.url).not.toContain(scope.sessionId)
    expect(boundPreviewLease.url).not.toContain(scope.attachmentId)
  })

  it('revokes only the preview lease without consuming or discarding the upload grant', async () => {
    await revokeNativeImagePreviewLease(boundGrant)

    expect(native.calls).toEqual([
      {
        command: 'revoke_native_image_preview_lease',
        args: {
          leaseId: boundGrant.previewLease.leaseId,
          operationId: boundGrant.operationId,
          uploadGrantId: boundGrant.grantId,
          ownerId: scope.ownerId,
          sessionId: scope.sessionId,
          attachmentId: scope.attachmentId,
        },
      },
    ])
    expect(native.calls.some(({ command }) => command === 'discard_file_grant')).toBe(false)
    expect(native.calls.some(({ command }) => command === 'upload_file_grant')).toBe(false)
  })

  it('does not invoke scoped cleanup when a grant has no bound preview lease', async () => {
    const withoutPreview = { ...unboundGrant, previewLease: undefined }

    await revokeNativeImagePreviewLease(withoutPreview)
    await revokeNativeImagePreviewLease(unboundGrant)

    expect(native.calls).toEqual([])
  })
})
