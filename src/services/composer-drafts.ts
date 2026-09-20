import { backendScopeKey } from './backend-context'
import { invoke } from '@tauri-apps/api/core'
import { fileFromNativeGrant, nativeGrantFromFile, type NativeFileGrant } from '@/api/native-files'

export interface DraftAttachment { file?: File; nativeId?: string; name: string; mime: string }
export interface ComposerDraft { text: string; skills: unknown[]; contexts: unknown[]; files: DraftAttachment[] }
let database: Promise<IDBDatabase> | undefined
function db(): Promise<IDBDatabase> {
  return database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('hexclaw-composer-drafts', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('drafts')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => { database = undefined; reject(request.error) }
  })
}
export async function readComposerDraft(key: string): Promise<ComposerDraft | undefined> {
  const store = (await db()).transaction('drafts').objectStore('drafts')
  return new Promise((resolve, reject) => {
    const request = store.get(key)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}
export async function writeComposerDraft(key: string, draft: ComposerDraft): Promise<void> {
  const transaction = (await db()).transaction('drafts', 'readwrite')
  const store = transaction.objectStore('drafts')
  if (!draft.text && !draft.files.length && !draft.skills.length && !draft.contexts.length) store.delete(key)
  else store.put(draft, key)
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}
const preserved = new WeakMap<File, Promise<DraftAttachment>>()
export function preserveComposerFile(file: File): Promise<DraftAttachment> {
  const original = (file as File & { draftOriginalFile?: File }).draftOriginalFile
  if (original) return preserveComposerFile(original)
  const previous = preserved.get(file)
  if (previous) return previous
  const grant = nativeGrantFromFile(file)
  const promise = grant
    ? invoke<string>('preserve_draft_attachment', { grantId: grant.grantId, operationId: grant.operationId, scope: backendScopeKey() })
      .then((nativeId) => ({ nativeId, name: file.name, mime: file.type }))
    : Promise.resolve({ file, name: file.name, mime: file.type })
  const retryable = promise.catch((error) => {
    preserved.delete(file)
    throw error
  })
  preserved.set(file, retryable)
  return retryable
}
export async function restoreComposerFile(item: DraftAttachment): Promise<File> {
  if (!item.nativeId) {
    if (!item.file) throw new Error('Draft attachment is missing')
    return item.file
  }
  const grant = await invoke<NativeFileGrant>('restore_draft_attachment', { attachmentId: item.nativeId, scope: backendScopeKey() })
  const file = fileFromNativeGrant(grant)
  preserved.set(file, Promise.resolve(item))
  return file
}
