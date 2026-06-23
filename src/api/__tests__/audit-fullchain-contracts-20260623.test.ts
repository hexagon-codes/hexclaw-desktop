/**
 * AUDIT 2026-06-23 全链路 API 契约取证（hex-test /hex-test 覆盖更多场景）
 *
 * 场景：定时任务(cron) · webhook · 账号(IM connection) · 数据源(connector) · 工作流(workflow)。
 * 方法：mock `../client` 的 apiGet/apiPost/apiDelete，纯测 API 层【契约构造】——
 *       请求 method/path/body 字段、关键不变量（chat_id 必发）、契约错位（返回类型撒谎、枚举缺口）。
 * 取证：每条结论挂可复现断言；Explore 疑似一律此处取证后才定性（hex-test 信条 1）。
 *
 * 双端证据锚点（核验自 working tree）：
 *  - webhook job_id 未闭环：后端 webhook.go:53/146/270 + main.go:845-849 有「webhook 绑 cron job」能力，
 *    但 RegisterWebhookRequest(handler_webhook.go:39-45) 与前端 createWebhook(webhook.ts:46-52) 均不收 job_id。
 *  - cron chat_id：tasks.ts:285 运行时下发，但 draft 类型(tasks.ts:45-50) 缺声明（类型债）。
 *  - workflow save：canvas.ts:61 声明 Promise<Workflow>，后端 handler_extended.go:552 实际只回 {id,message}。
 *  - provider 枚举：后端 BuildAdapter(instances/manager.go:738-810) 支持 10 平台，前端 CHANNEL_TYPES 暴露 7。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DESKTOP_USER_ID } from '@/constants'

const apiGet = vi.hoisted(() => vi.fn())
const apiPost = vi.hoisted(() => vi.fn())
const apiDelete = vi.hoisted(() => vi.fn())
vi.mock('../client', () => ({ apiGet, apiPost, apiDelete }))

import { createWebhook, deleteWebhook, webhookUrlFor } from '../webhook'
import { createCronJobJSON, cronjobAction, parseCronText } from '../tasks'
import { saveWorkflow } from '../canvas'
import { CHANNEL_TYPES } from '@/config/im-channels'

function lastPostBody(): Record<string, unknown> {
  const calls = apiPost.mock.calls
  return calls[calls.length - 1]![1] as Record<string, unknown>
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
})

// ──────────────────────────────────────────────────────────────
// 场景 1 — 定时任务 cron 全链路契约
// ──────────────────────────────────────────────────────────────
describe('AUDIT cron 定时任务契约', () => {
  it('★IM 投递携 chat_id 下发（历史 P0「cron 投递缺 chat_id」防回退）', async () => {
    apiPost.mockResolvedValue({ job: { id: 'j1', spec: {} } })
    await createCronJobJSON({
      name: '每日简报',
      schedule: '0 9 * * *',
      prompt: '汇总今日',
      deliver: ['feishu'],
      chat_id: 'oc_room_123',
    })
    const body = lastPostBody()
    expect(body.action).toBe('create')
    const draft = body.draft as Record<string, unknown>
    expect(draft.chat_id).toBe('oc_room_123') // 必发，否则后端 Deliverer 对 IM 目标硬失败
    expect(draft.deliver).toEqual(['feishu'])
  })

  it('无 chat_id 时 draft 不含该键（精简，不发空串污染）', async () => {
    apiPost.mockResolvedValue({ job: { id: 'j2', spec: {} } })
    await createCronJobJSON({ name: 'x', schedule: '@daily', prompt: 'p' })
    const draft = lastPostBody().draft as Record<string, unknown>
    expect('chat_id' in draft).toBe(false)
    expect('deliver' in draft).toBe(false)
  })

  it('cronjobAction 直达 POST /api/v1/cronjob 并透传 action', async () => {
    apiPost.mockResolvedValue({})
    await cronjobAction({ action: 'pause', job_id: 'j3' })
    expect(apiPost).toHaveBeenCalledWith('/api/v1/cronjob', expect.objectContaining({ action: 'pause', job_id: 'j3' }))
  })

  it('parseCronText POST /api/v1/cron/parse 带 text + locale hints', async () => {
    apiPost.mockResolvedValue({ draft: {} })
    await parseCronText('每天早上九点', 'zh-CN')
    const [path, body] = apiPost.mock.calls[apiPost.mock.calls.length - 1]!
    expect(path).toBe('/api/v1/cron/parse')
    expect((body as Record<string, unknown>).text).toBe('每天早上九点')
  })
})

// ──────────────────────────────────────────────────────────────
// 场景 2 — webhook 全链路契约
// ──────────────────────────────────────────────────────────────
describe('AUDIT webhook 契约', () => {
  it('createWebhook 请求体 = {name,type,prompt,secret,job_id,user_id}（与后端 RegisterWebhookRequest 对齐）', async () => {
    apiPost.mockResolvedValue({ id: 'w1', name: 'gh', url: '/api/v1/webhooks/gh' })
    await createWebhook({ name: 'gh', type: 'github', prompt: '处理 PR' })
    const [path, body] = apiPost.mock.calls[0]!
    expect(path).toBe('/api/v1/webhooks')
    expect(body).toEqual({ name: 'gh', type: 'github', prompt: '处理 PR', secret: '', job_id: '', user_id: DESKTOP_USER_ID })
  })

  it('★AP-031 已闭环：createWebhook 传 jobId → 请求体携 job_id（webhook 绑定 cron job §13.3 现 UI/HTTP 可达）', async () => {
    apiPost.mockResolvedValue({ id: 'w2', name: 'cronhook', url: '/api/v1/webhooks/cronhook' })
    await createWebhook({ name: 'cronhook', type: 'generic', prompt: 'p', jobId: 'job-42' })
    const body = lastPostBody()
    expect(body.job_id).toBe('job-42') // 后端 RegisterWebhookRequest.JobID → wh.JobID → 事件触发该 job
  })

  it('deleteWebhook 按 name 寻址（传 id 后端找不到→静默 no-op，历史 bug 防回归）', async () => {
    apiDelete.mockResolvedValue({ message: 'ok' })
    await deleteWebhook('my hook')
    expect(apiDelete).toHaveBeenCalledWith('/api/v1/webhooks/my%20hook')
  })

  it('webhookUrlFor 拼出 /api/v1/webhooks/{name} 且 encodeURIComponent（此前零单测）', () => {
    expect(webhookUrlFor('a b/c')).toMatch(/\/api\/v1\/webhooks\/a%20b%2Fc$/)
  })
})

// ──────────────────────────────────────────────────────────────
// 场景 3 — 工作流 workflow 契约
// ──────────────────────────────────────────────────────────────
describe('AUDIT workflow 契约', () => {
  const wf = { id: 'wf1', name: 'flow', description: '', nodes: [], edges: [] }

  it('★AP-032 已闭环：saveWorkflow 返回后端给的完整 Workflow（契约 Promise<Workflow> 真实，调用方可信任返回）', async () => {
    // 后端 handleSaveWorkflow 已改为回完整 &wf（含 name/nodes/created_at）
    apiPost.mockResolvedValue({ ...wf, created_at: '2026-06-23T00:00:00Z', updated_at: '2026-06-23T00:00:00Z' })
    const res = await saveWorkflow(wf)
    expect(res.id).toBe('wf1')
    expect(res.name).toBe('flow') // 不再 undefined
    expect(res.nodes).toEqual([])
    expect(res.created_at).toBeTruthy()
  })

  it('saveWorkflow 后端失败时降级 localStorage 并返回完整 Workflow（兜底分支覆盖）', async () => {
    apiPost.mockRejectedValue(new Error('backend down'))
    const res = await saveWorkflow(wf)
    expect(res.nodes).toEqual([])
    expect(res.created_at).toBeTruthy()
    expect(res.updated_at).toBeTruthy()
    expect(JSON.parse(localStorage.getItem('hexclaw_workflows') || '[]')[0].id).toBe('wf1')
  })
})

// ──────────────────────────────────────────────────────────────
// 场景 4 — 账号/数据源：IM provider 枚举两端对齐
// ──────────────────────────────────────────────────────────────
describe('AUDIT 账号 IM provider 枚举对齐', () => {
  // 后端 instances/manager.go:738-810 BuildAdapter 支持的 IM 平台（真实读取）
  const BACKEND_IM = ['feishu', 'dingtalk', 'wecom', 'wechat', 'slack', 'telegram', 'discord', 'line', 'whatsapp', 'matrix']

  it('前端每个 IM 类型都被后端 BuildAdapter 支持（email 除外，走独立邮箱连接路径）—— 无前端孤儿导致运行时建不出适配器', () => {
    const frontend = CHANNEL_TYPES.map((c) => c.type).filter((t) => t !== 'email')
    const orphans = frontend.filter((t) => !BACKEND_IM.includes(t))
    expect(orphans).toEqual([]) // 前端提供但后端不认 = 🔴 运行时失败方向
  })

  it('★记录枚举缺口：后端支持但前端未暴露的平台（slack/line/whatsapp/matrix）—— 漂移检测器', () => {
    const frontend = CHANNEL_TYPES.map((c) => c.type)
    const missing = BACKEND_IM.filter((t) => !(frontend as string[]).includes(t)).sort()
    // 固定当前缺口；前端补齐任一平台后此断言失败 → 提醒同步 hex-test 覆盖项 + 评估是否产品化
    expect(missing).toEqual(['line', 'matrix', 'slack', 'whatsapp'])
  })
})
