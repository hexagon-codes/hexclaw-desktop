import { apiGet, apiPost, apiDelete } from './client'
import { DESKTOP_USER_ID } from '@/constants'

/** Webhook 类型 */
export type WebhookType = 'wecom' | 'feishu' | 'dingtalk' | 'custom'

/** 触发事件类型 */
export type WebhookEvent = 'task_complete' | 'agent_complete' | 'error'

/** Webhook 定义 */
export interface Webhook {
  id: string
  name: string
  type: WebhookType
  url: string
  events: WebhookEvent[]
  secret: string
  prompt: string
  user_id: string
}

/** 获取 Webhook 列表 */
export function getWebhooks() {
  return apiGet<{ webhooks: Webhook[]; total: number }>('/api/v1/webhooks', {
    user_id: DESKTOP_USER_ID,
  })
}

/** 注册 Webhook */
export function createWebhook(data: { name: string; type: WebhookType; url: string; events: WebhookEvent[] }) {
  return apiPost<{ id: string; name: string; url: string }>('/api/v1/webhooks', {
    name: data.name,
    type: data.type,
    url: data.url,
    events: data.events,
    prompt: '',
    secret: '',
    user_id: DESKTOP_USER_ID,
  })
}

/** 删除 Webhook */
export function deleteWebhook(id: string) {
  return apiDelete<{ message: string }>(`/api/v1/webhooks/${encodeURIComponent(id)}`)
}
