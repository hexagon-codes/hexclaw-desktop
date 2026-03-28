import { apiPost } from './client'

/** 写入剪贴板 */
export function setClipboard(content: string) {
  return apiPost<{ message: string }>('/api/v1/desktop/clipboard', { content })
}
