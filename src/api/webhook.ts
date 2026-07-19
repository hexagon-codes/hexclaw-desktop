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

export type K12WebhookEventType =
  | 'k12.submission.requested.v1'
  | 'k12.practice_return.requested.v1'
  | 'k12.workflow_run.requested.v1'

export type K12WebhookReceiptStatus =
  | 'accepted'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'outcome_unknown'
  | 'rejected'

export interface K12WebhookBinding {
  binding_id: string
  name: string
  agent_id: string
  learner_id: string
  scope: 'direct'
  allowed_events: K12WebhookEventType[]
  allowed_workflows?: string[]
  has_secret: boolean
  secret_version: number
  status: 'disabled' | 'enabled'
  created_by: string
  rotated_at?: string
  created_at: string
  updated_at: string
}

export interface K12WebhookReceipt {
  receipt_id: string
  binding_id: string
  event_id?: string
  event_type?: K12WebhookEventType
  payload_digest: string
  status: K12WebhookReceiptStatus
  job_or_execution_ref?: string
  failure_kind?: string
  retryable: boolean
  attempt_count: number
  created_at: string
  updated_at: string
}

export interface K12WebhookMutation {
  enabled?: boolean
  allowed_events?: K12WebhookEventType[]
  allowed_workflows?: string[]
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

/** K12 management is always scoped by the authenticated desktop guardian and
 * the selected TutorAgent. The receiver body never supplies either identity. */
export function getK12Webhooks(agentId: string) {
  return apiGet<{ k12_bindings: K12WebhookBinding[]; total: number }>('/api/v1/webhooks', {
    user_id: DESKTOP_USER_ID,
    agent_id: agentId,
  })
}

export function getK12WebhookReceipts(name: string, agentId: string) {
  return apiGet<{ receipts: K12WebhookReceipt[]; total: number }>('/api/v1/webhooks', {
    user_id: DESKTOP_USER_ID,
    agent_id: agentId,
    binding_name: name,
  })
}

export function getK12WebhookReceipt(receiptId: string, agentId: string) {
  return apiGet<{ receipt: K12WebhookReceipt }>('/api/v1/webhooks', {
    user_id: DESKTOP_USER_ID,
    agent_id: agentId,
    receipt_id: receiptId,
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

export function createK12Webhook(data: {
  name: string
  agentId: string
  learnerId: string
  allowedEvents: K12WebhookEventType[]
  allowedWorkflows?: string[]
}) {
  return apiPost<{
    binding: K12WebhookBinding
    id: string
    binding_id: string
    name: string
    type: 'k12'
    url: string
    enabled: boolean
    secret: string
  }>('/api/v1/webhooks', {
    name: data.name,
    type: 'k12',
    agent_id: data.agentId,
    learner_id: data.learnerId,
    allowed_events: data.allowedEvents,
    allowed_workflows: data.allowedWorkflows ?? [],
    user_id: DESKTOP_USER_ID,
    enabled: false,
  })
}

/** 启用/停用 Webhook（PATCH /api/v1/webhooks/{name}）。
 *  停用即回到「验签记录、423 不派发」态；授权完成后启用开始派发 Agent。 */
export function updateWebhookEnabled(name: string, enabled: boolean) {
  return apiPatch<{ name: string; enabled: boolean }>(
    `/api/v1/webhooks/${encodeURIComponent(name)}`,
    { enabled },
  )
}

function k12ManagementPath(name: string, agentId: string): string {
  return `/api/v1/webhooks/${encodeURIComponent(name)}?user_id=${encodeURIComponent(DESKTOP_USER_ID)}&agent_id=${encodeURIComponent(agentId)}`
}

export function updateK12Webhook(name: string, agentId: string, data: K12WebhookMutation) {
  return apiPatch<{ binding: K12WebhookBinding; name: string; enabled: boolean }>(
    k12ManagementPath(name, agentId),
    data,
  )
}

export function rotateK12WebhookSecret(name: string, agentId: string) {
  return apiPatch<{ binding: K12WebhookBinding; name: string; enabled: boolean; secret: string }>(
    k12ManagementPath(name, agentId),
    { rotate_secret: true },
  )
}

/** Redispatches the same durable Receipt/event envelope. The backend accepts
 * this only for failed Receipts carrying persisted local retry evidence. */
export function retryK12WebhookReceipt(name: string, agentId: string, receiptId: string) {
  return apiPatch<{ receipt: K12WebhookReceipt }>(k12ManagementPath(name, agentId), {
    retry_receipt_id: receiptId,
  })
}

/** 删除 Webhook — 按 name 寻址（后端路由 DELETE /api/v1/webhooks/{name}，Unregister 按 name）。
 *  注意：必须传 webhook.name，不能传 webhook.id —— 传 id 后端找不到，静默 no-op（bug 2026-06-22）。 */
export function deleteWebhook(name: string) {
  return apiDelete<{ message: string }>(`/api/v1/webhooks/${encodeURIComponent(name)}`)
}

export function deleteK12Webhook(name: string, agentId: string) {
  return apiDelete<{ message: string }>(k12ManagementPath(name, agentId))
}
