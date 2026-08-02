import type { ChatAttachment } from '@/types'
import { isTauri } from '@/utils/platform'
import { apiPost, sidecarFetch } from './client'
import {
  createNativeFileOperation,
  stageBlob,
  uploadGrantedFile,
  type NativeFileGrant,
} from './native-files'

const ATTACHMENT_PATH = '/api/v1/attachments'
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

export interface AttachmentReceipt {
  attachment_id: string
  digest: string
  size: number
  media_type: string
  display_name: string
  expires_at: string
}

function assertReceipt(
  receipt: AttachmentReceipt,
  expectedSize: number,
  expectedDigest: string,
): AttachmentReceipt {
  if (
    !receipt.attachment_id?.trim()
    || !/^sha256:[0-9a-f]{64}$/.test(receipt.digest)
    || receipt.digest !== `sha256:${expectedDigest}`
    || receipt.size !== expectedSize
    || !receipt.media_type?.startsWith('image/')
    || !receipt.display_name?.trim()
    || !Number.isFinite(Date.parse(receipt.expires_at))
    || Date.parse(receipt.expires_at) <= Date.now()
  ) {
    throw new Error('Attachment upload returned an invalid receipt')
  }
  return receipt
}

function nativeGrant(file: File): NativeFileGrant | undefined {
  return (file as File & { nativeFileGrant?: NativeFileGrant }).nativeFileGrant
}

async function sha256(blob: Blob): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function attachmentIdempotencyKey(
  sourceDigest: string,
  displayName: string,
  mediaType: string,
): Promise<string> {
  const semanticIdentity = new TextEncoder().encode(
    `${sourceDigest}\0${displayName}\0${mediaType.toLowerCase()}`,
  )
  const digest = await globalThis.crypto.subtle.digest('SHA-256', semanticIdentity)
  const hex = Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('')
  return `chat-attachment:${hex}`
}

export async function uploadChatAttachment(file: File): Promise<AttachmentReceipt> {
  const grantFromNative = nativeGrant(file)
  const size = grantFromNative?.size ?? file.size
  const mediaType = grantFromNative?.mime ?? file.type
  if (!mediaType.startsWith('image/') || size <= 0 || size > MAX_ATTACHMENT_BYTES) {
    throw new Error('Chat attachment must be an image no larger than 20 MiB')
  }

  if (isTauri()) {
    const grant = grantFromNative?.purpose === 'attachment_upload'
      ? grantFromNative
      : await stageBlob(file, file.name, {
          purpose: 'attachment_upload',
          operationId: createNativeFileOperation('chat-attachment'),
        })
    if (!/^[0-9a-f]{64}$/.test(grant.sourceSha256 ?? '')) {
      throw new Error('Native attachment grant is missing its attested source digest')
    }
    const sourceDigest = grant.sourceSha256!
    const transfer = await uploadGrantedFile<AttachmentReceipt>({
      grant,
      url: ATTACHMENT_PATH,
      idempotencyKey: await attachmentIdempotencyKey(
        sourceDigest,
        grant.name,
        grant.mime,
      ),
      fieldName: 'file',
    })
    if (!transfer.body) throw new Error('Attachment upload returned no receipt')
    return assertReceipt(transfer.body, size, sourceDigest)
  }

  const form = new FormData()
  form.append('file', file, file.name)
  const sourceDigest = await sha256(file)
  return assertReceipt(
    await apiPost<AttachmentReceipt>(ATTACHMENT_PATH, form, {
      headers: {
        'Idempotency-Key': await attachmentIdempotencyKey(
          sourceDigest,
          file.name,
          file.type,
        ),
      },
    }),
    size,
    sourceDigest,
  )
}

function base64Blob(data: string, mime: string): Blob {
  const encoded = data.includes(',') ? data.slice(data.indexOf(',') + 1) : data
  const binary = atob(encoded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return new Blob([bytes], { type: mime })
}

export async function ensureChatAttachmentReceipt(
  attachment: ChatAttachment,
): Promise<ChatAttachment> {
  if (attachment.attachmentId?.trim()) return attachment
  if (attachment.type !== 'image') {
    throw new Error('Only image chat attachments are supported')
  }
  let blob: Blob
  if (/^https?:/i.test(attachment.data)) {
    const response = await sidecarFetch(attachment.data)
    if (!response.ok) throw new Error(`Attachment source fetch failed: HTTP ${response.status}`)
    blob = await response.blob()
  } else {
    blob = base64Blob(attachment.data, attachment.mime)
  }
  const receipt = await uploadChatAttachment(
    new File([blob], attachment.name, { type: attachment.mime || blob.type }),
  )
  return { ...attachment, attachmentId: receipt.attachment_id }
}
