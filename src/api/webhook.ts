import { apiGet, apiPost, apiDelete } from './client'
import { DESKTOP_USER_ID } from '@/constants'

/** Webhook 定义 */
export interface Webhook {
  id: string
  name: string
  type: 'generic' | 'github' | 'gitlab'
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
export function registerWebhook(name: string, prompt: string, type?: string, secret?: string) {
  return apiPost<{ id: string; name: string; url: string }>('/api/v1/webhooks', {
    name,
    prompt,
    type: type ?? 'generic',
    secret: secret ?? '',
    user_id: DESKTOP_USER_ID,
  })
}

/** 删除 Webhook */
export function deleteWebhook(name: string) {
  return apiDelete<{ message: string }>(`/api/v1/webhooks/${name}`)
}
