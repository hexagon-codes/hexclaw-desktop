export const CHAT_FILE_MAX_BYTES = 200 * 1024 * 1024
export const CHAT_FILE_MAX_MIB = CHAT_FILE_MAX_BYTES / (1024 * 1024)

export function effectiveChatFileSize(file: File): number {
  const nativeSize = (file as File & { nativeSize?: unknown }).nativeSize
  if (typeof nativeSize === 'number' && Number.isSafeInteger(nativeSize) && nativeSize >= 0) {
    return nativeSize
  }
  return file.size
}
