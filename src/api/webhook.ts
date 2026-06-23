import { apiGet, apiPost, apiDelete } from './client'
import { DESKTOP_USER_ID } from '@/constants'
import { env } from '@/config/env'

/**
 * Webhook 类型 —— 与后端 webhook/webhook.go 一致（入站事件 webhook）：
 * generic(通用 JSON) / github / gitlab。后端按类型选事件解析分支。
 */
export type WebhookType = 'generic' | 'github' | 'gitlab'

/** Webhook 定义 —— 对齐后端 webhook.Webhook 序列化字段（无 url/events；url 由后端按 name 生成）。 */
export interface Webhook {
  id: string
  name: string
  type: WebhookType
  has_secret: boolean
  prompt: string
  job_id?: string
  user_id: string
  enabled: boolean
  last_event_at?: string
  event_count: number
  created_at: string
}

/** 拼出 Webhook 的真实接收 URL（后端按 name 注册 /api/v1/webhooks/{name}）。 */
export function webhookUrlFor(name: string): string {
  return `${env.apiBase}/api/v1/webhooks/${encodeURIComponent(name)}`
}

/** 获取 Webhook 列表 */
export function getWebhooks() {
  return apiGet<{ webhooks: Webhook[]; total: number }>('/api/v1/webhooks', {
    user_id: DESKTOP_USER_ID,
  })
}

/** 注册 Webhook —— 对齐后端 RegisterWebhookRequest{name,type,secret,prompt,user_id}。
 *  prompt 为事件到达时执行的 Agent 指令（后端必填非空）；URL 由后端按 name 生成并在响应返回。 */
export function createWebhook(data: {
  name: string
  type: WebhookType
  prompt: string
  secret?: string
  /** §13.3(1) 绑定 cron job：非空 → 事件触发该 job 而非跑 prompt（对齐后端 RegisterWebhookRequest.job_id）。 */
  jobId?: string
}) {
  return apiPost<{ id: string; name: string; url: string }>('/api/v1/webhooks', {
    name: data.name,
    type: data.type,
    prompt: data.prompt,
    secret: data.secret ?? '',
    job_id: data.jobId ?? '',
    user_id: DESKTOP_USER_ID,
  })
}

/** 删除 Webhook — 按 name 寻址（后端路由 DELETE /api/v1/webhooks/{name}，Unregister 按 name）。
 *  注意：必须传 webhook.name，不能传 webhook.id —— 传 id 后端找不到，静默 no-op（bug 2026-06-22）。 */
export function deleteWebhook(name: string) {
  return apiDelete<{ message: string }>(`/api/v1/webhooks/${encodeURIComponent(name)}`)
}
