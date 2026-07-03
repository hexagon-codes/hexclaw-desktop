import { apiGet, apiPost, apiPatch, apiDelete } from './client'
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

/** 注册 Webhook —— 对齐后端 RegisterWebhookRequest{name,type,secret,prompt,user_id,enabled}。
 *  产品语义「创建即得端点、默认未启用」：不传 enabled 即 false —— 先把 URL/Secret
 *  配到对端、跑通测试事件（?test=1 验签回显）、完成授权，再 PATCH 启用。
 *  Secret 留空时后端自动生成，并只在本次创建响应回显一次（secret 字段）。 */
export function createWebhook(data: {
  name: string
  type: WebhookType
  prompt: string
  secret?: string
  /** §13.3(1) 绑定 cron job：非空 → 事件触发该 job 而非跑 prompt（对齐后端 RegisterWebhookRequest.job_id）。 */
  jobId?: string
  /** 显式启用（默认 false：创建后先验签/授权再启用）。 */
  enabled?: boolean
}) {
  return apiPost<{ id: string; name: string; url: string; enabled: boolean; secret?: string }>(
    '/api/v1/webhooks',
    {
      name: data.name,
      type: data.type,
      prompt: data.prompt,
      secret: data.secret ?? '',
      job_id: data.jobId ?? '',
      user_id: DESKTOP_USER_ID,
      enabled: data.enabled ?? false,
    },
  )
}

/** 启用/停用 Webhook（PATCH /api/v1/webhooks/{name}）。
 *  停用即回到「验签记录、423 不派发」态；授权完成后启用开始派发 Agent。 */
export function updateWebhookEnabled(name: string, enabled: boolean) {
  return apiPatch<{ name: string; enabled: boolean }>(
    `/api/v1/webhooks/${encodeURIComponent(name)}`,
    { enabled },
  )
}

/** 删除 Webhook — 按 name 寻址（后端路由 DELETE /api/v1/webhooks/{name}，Unregister 按 name）。
 *  注意：必须传 webhook.name，不能传 webhook.id —— 传 id 后端找不到，静默 no-op（bug 2026-06-22）。 */
export function deleteWebhook(name: string) {
  return apiDelete<{ message: string }>(`/api/v1/webhooks/${encodeURIComponent(name)}`)
}
