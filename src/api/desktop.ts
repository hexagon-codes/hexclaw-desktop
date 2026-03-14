import { apiGet, apiPost, apiDelete } from './client'

/** 系统信息 */
export interface SystemInfo {
  os: string
  arch: string
  hostname: string
  version: string
}

/** 桌面通知 */
export interface DesktopNotification {
  id: string
  title: string
  body: string
  type: 'info' | 'warning' | 'error' | 'success'
  timestamp: string
}

/** 获取系统信息 */
export function getDesktopInfo() {
  return apiGet<SystemInfo>('/api/v1/desktop/info')
}

/** 获取通知列表 */
export function getNotifications() {
  return apiGet<{ notifications: DesktopNotification[]; total: number }>('/api/v1/desktop/notifications')
}

/** 发送通知 */
export function sendNotification(title: string, body: string, type?: 'info' | 'warning' | 'error' | 'success') {
  return apiPost<{ message: string }>('/api/v1/desktop/notifications', {
    title,
    body,
    type: type ?? 'info',
  })
}

/** 清空通知 */
export function clearNotifications() {
  return apiDelete<{ message: string }>('/api/v1/desktop/notifications')
}

/** 读取剪贴板 */
export function getClipboard() {
  return apiGet<{ content: string }>('/api/v1/desktop/clipboard')
}

/** 写入剪贴板 */
export function setClipboard(content: string) {
  return apiPost<{ message: string }>('/api/v1/desktop/clipboard', { content })
}
