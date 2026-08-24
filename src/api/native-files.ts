import { invoke } from '@tauri-apps/api/core'
import { env } from '@/config/env'

export type NativeFilePurpose =
  | 'attachment_upload'
  | 'knowledge_upload'
  | 'save_download'
  | 'save_copy'
  | 'render_artifact'

export interface NativeImagePreviewLease {
  leaseId: string
  url?: string
  mime: 'image/png'
  width: number
  height: number
  createdAtUnixMs: number
  expiresAtUnixMs: number
  ownerId?: string
  sessionId?: string
  attachmentId?: string
}

export interface NativeImagePreviewScope {
  ownerId: string
  sessionId: string
  attachmentId: string
}

export interface BoundNativeImagePreviewLease extends NativeImagePreviewLease {
  url: string
  ownerId: string
  sessionId: string
  attachmentId: string
}

export interface NativeFileGrant {
  grantId: string
  operationId: string
  purpose: NativeFilePurpose
  name: string
  mime: string
  size: number
  sourceSha256?: string
  previewLease?: NativeImagePreviewLease
}

export type BoundNativeFileGrant = NativeFileGrant & {
  previewLease: BoundNativeImagePreviewLease
}

export interface NativeTransferReceipt<T = unknown> {
  status: number
  bytesTransferred: number
  body?: T
}

const STAGING_CHUNK_BYTES = 256 * 1024

function operationId(prefix: string): string {
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
  return `${prefix}:${id}`
}

export function fileFromNativeGrant(grant: NativeFileGrant): File {
  const file = new File([], grant.name, { type: grant.mime })
  Object.defineProperties(file, {
    nativeFileGrant: { value: grant, enumerable: false },
    nativeGrantId: { value: grant.grantId, enumerable: false },
    nativeOperationId: { value: grant.operationId, enumerable: false },
    nativeGrantPurpose: { value: grant.purpose, enumerable: false },
    nativeSourceSha256: { value: grant.sourceSha256, enumerable: false },
    nativeSize: { value: grant.size, enumerable: false },
  })
  return file
}

export function nativeGrantFromFile(file: File): NativeFileGrant | undefined {
  return (file as File & { nativeFileGrant?: NativeFileGrant }).nativeFileGrant
}

export function pickOpenFileGrant(
  purpose: Extract<NativeFilePurpose, 'attachment_upload' | 'knowledge_upload'>,
  operation = operationId('native-open'),
): Promise<NativeFileGrant | null> {
  return invoke<NativeFileGrant | null>('pick_open_file_grant', {
    operationId: operation,
    purpose,
  })
}

export function pickSaveFileGrant(
  defaultName: string,
  purpose: Extract<NativeFilePurpose, 'save_download' | 'save_copy' | 'render_artifact'>,
  operation = operationId('native-save'),
): Promise<NativeFileGrant | null> {
  return invoke<NativeFileGrant | null>('pick_save_file_grant', {
    operationId: operation,
    purpose,
    defaultName,
  })
}

export function discardFileGrant(grant: NativeFileGrant): Promise<void> {
  return invoke<void>('discard_file_grant', {
    grantId: grant.grantId,
    operationId: grant.operationId,
    purpose: grant.purpose,
  })
}

function validPreviewIdentity(value: string): boolean {
  return (
    value.trim().length > 0 &&
    value.length <= 512 &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0)
      return code <= 31 || code === 127
    })
  )
}

function isBoundNativeImagePreviewLease(
  lease: NativeImagePreviewLease,
): lease is BoundNativeImagePreviewLease {
  return (
    typeof lease.url === 'string' &&
    lease.url.length > 0 &&
    typeof lease.ownerId === 'string' &&
    validPreviewIdentity(lease.ownerId) &&
    typeof lease.sessionId === 'string' &&
    validPreviewIdentity(lease.sessionId) &&
    typeof lease.attachmentId === 'string' &&
    validPreviewIdentity(lease.attachmentId)
  )
}

export async function bindNativeImagePreviewLease(
  grant: NativeFileGrant,
  scope: NativeImagePreviewScope,
): Promise<BoundNativeFileGrant> {
  if (!grant.previewLease) throw new Error('Native image preview lease is missing')
  if (
    !validPreviewIdentity(scope.ownerId) ||
    !validPreviewIdentity(scope.sessionId) ||
    !validPreviewIdentity(scope.attachmentId)
  ) {
    throw new Error('Native image preview scope is invalid')
  }
  const previewLease = await invoke<BoundNativeImagePreviewLease>(
    'bind_native_image_preview_lease',
    {
      leaseId: grant.previewLease.leaseId,
      operationId: grant.operationId,
      uploadGrantId: grant.grantId,
      ownerId: scope.ownerId,
      sessionId: scope.sessionId,
      attachmentId: scope.attachmentId,
    },
  )
  if (
    !isBoundNativeImagePreviewLease(previewLease) ||
    previewLease.leaseId !== grant.previewLease.leaseId ||
    previewLease.ownerId !== scope.ownerId ||
    previewLease.sessionId !== scope.sessionId ||
    previewLease.attachmentId !== scope.attachmentId ||
    !previewLease.url.endsWith(`/${grant.previewLease.leaseId}`) ||
    !/^(?:hexclaw-preview:\/\/localhost\/|http:\/\/hexclaw-preview\.localhost\/)[0-9a-f-]+$/.test(
      previewLease.url,
    )
  ) {
    throw new Error('Native image preview binding response is invalid')
  }
  return { ...grant, previewLease }
}

export function syncNativeImagePreviewScope(scope?: {
  ownerId: string
  sessionId: string
  attachmentIds: string[]
}): Promise<void> {
  if (!scope) {
    return invoke<void>('sync_native_image_preview_scope', {
      ownerId: null,
      sessionId: null,
      attachmentIds: [],
    })
  }
  if (
    !validPreviewIdentity(scope.ownerId) ||
    !validPreviewIdentity(scope.sessionId) ||
    scope.attachmentIds.some((attachmentId) => !validPreviewIdentity(attachmentId))
  ) {
    return Promise.reject(new Error('Native image preview window scope is invalid'))
  }
  return invoke<void>('sync_native_image_preview_scope', scope)
}

export function revokeNativeImagePreviewLease(grant: NativeFileGrant): Promise<void> {
  if (!grant.previewLease || !isBoundNativeImagePreviewLease(grant.previewLease)) {
    return Promise.resolve()
  }
  return invoke<void>('revoke_native_image_preview_lease', {
    leaseId: grant.previewLease.leaseId,
    operationId: grant.operationId,
    uploadGrantId: grant.grantId,
    ownerId: grant.previewLease.ownerId,
    sessionId: grant.previewLease.sessionId,
    attachmentId: grant.previewLease.attachmentId,
  })
}

export async function stageBlob(
  blob: Blob,
  name: string,
  options: {
    purpose: Extract<NativeFilePurpose, 'attachment_upload' | 'knowledge_upload' | 'save_copy'>
    operationId?: string
    signal?: AbortSignal
  },
): Promise<NativeFileGrant> {
  if (options.signal?.aborted) throw new DOMException('Staging aborted', 'AbortError')
  const operation = options.operationId ?? operationId('native-stage')
  const grant = await invoke<NativeFileGrant>('create_staging_file_grant', {
    operationId: operation,
    purpose: options.purpose,
    name,
    mime: blob.type || 'application/octet-stream',
    size: blob.size,
  })
  try {
    let offset = 0
    while (offset < blob.size) {
      if (options.signal?.aborted) throw new DOMException('Staging aborted', 'AbortError')
      const chunk = new Uint8Array(
        await blob.slice(offset, Math.min(offset + STAGING_CHUNK_BYTES, blob.size)).arrayBuffer(),
      )
      if (options.signal?.aborted) throw new DOMException('Staging aborted', 'AbortError')
      offset = await invoke<number>('append_file_grant_chunk', {
        grantId: grant.grantId,
        operationId: grant.operationId,
        purpose: grant.purpose,
        offset,
        chunk,
      })
      if (options.signal?.aborted) throw new DOMException('Staging aborted', 'AbortError')
    }
    return await invoke<NativeFileGrant>('seal_file_grant', {
      grantId: grant.grantId,
      operationId: grant.operationId,
      purpose: grant.purpose,
    })
  } catch (error) {
    try {
      await discardFileGrant(grant)
    } catch (cleanupError) {
      if (error && typeof error === 'object') {
        Object.defineProperty(error, 'cleanupError', { value: cleanupError })
      }
    }
    throw error
  }
}

function sidecarRelativePath(raw: string): string {
  const url = new URL(raw, env.apiBase)
  const base = new URL(env.apiBase)
  if (url.origin !== base.origin || url.username || url.password || url.hash) {
    throw new Error('Native transfer target must be the managed Sidecar origin')
  }
  return `${url.pathname}${url.search}`
}

export function validateManagedSidecarURL(raw: string): void {
  sidecarRelativePath(raw)
}

export async function uploadGrantedFile<T>(options: {
  grant: NativeFileGrant
  url: string
  idempotencyKey: string
  fieldName?: string
  signal?: AbortSignal
  onProgress?: (percent: number) => void
}): Promise<NativeTransferReceipt<T>> {
  const { Channel } = await import('@tauri-apps/api/core')
  const onProgress = new Channel<{ bytesTransferred: number; totalBytes: number }>((progress) => {
    if (progress.totalBytes > 0) {
      options.onProgress?.(
        Math.min(100, Math.round((progress.bytesTransferred / progress.totalBytes) * 100)),
      )
    }
  })
  let registered = false
  let cancellationPending = false
  const cancel = () => {
    if (!registered) {
      cancellationPending = true
      return
    }
    void invoke('cancel_file_transfer', { operationId: options.grant.operationId })
  }
  const onRegistered = new Channel<null>(() => {
    registered = true
    if (cancellationPending) cancel()
  })
  if (options.signal?.aborted) {
    throw new DOMException('Upload aborted', 'AbortError')
  }
  options.signal?.addEventListener('abort', cancel, { once: true })
  try {
    return await invoke<NativeTransferReceipt<T>>('upload_file_grant', {
      grantId: options.grant.grantId,
      operationId: options.grant.operationId,
      purpose: options.grant.purpose,
      relativePath: sidecarRelativePath(options.url),
      idempotencyKey: options.idempotencyKey,
      fieldName: options.fieldName,
      onProgress,
      onRegistered,
    })
  } catch (error) {
    if (options.signal?.aborted) throw new DOMException('Upload aborted', 'AbortError')
    throw error
  } finally {
    options.signal?.removeEventListener('abort', cancel)
  }
}

export function downloadIntoGrant(grant: NativeFileGrant, url: string) {
  return invoke<NativeTransferReceipt>('download_file_grant', {
    grantId: grant.grantId,
    operationId: grant.operationId,
    relativePath: sidecarRelativePath(url),
  })
}

export function copyGrantedFile(source: NativeFileGrant, destination: NativeFileGrant) {
  if (source.operationId !== destination.operationId) {
    throw new Error('Native copy grants must share one operation identity')
  }
  return invoke<number>('copy_file_grant', {
    sourceGrantId: source.grantId,
    destinationGrantId: destination.grantId,
    operationId: source.operationId,
  })
}

export function createNativeFileOperation(prefix: string): string {
  return operationId(prefix)
}
