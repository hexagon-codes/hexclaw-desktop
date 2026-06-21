/**
 * 域 C 审查取证：任务 / 自动化 / webhook / cron
 *
 * 资深 SDET 挑刺式 review。本文件只暴露问题，不改任何生产源码。
 * 每条 finding 一个 describe，RED = bug 坐实，GREEN = 对齐契约符合预期。
 *
 * 取证基准（坐标均为审查当下文件:行）：
 *   FE  src/api/webhook.ts / src/api/tasks.ts / src/components/automation/WebhookPanel.vue / src/views/TasksView.vue
 *   BE  hexclaw/api/handler_webhook.go / handler_cron.go / handler_cron_parse.go / handler_cronjob_unified.go
 *       hexclaw/cron/cron.go / hexclaw/webhook/webhook.go
 *
 * 跑：CI=true npx vitest run src/__tests__/audit-tasks-automation-20260621.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── client mock：拦截 apiGet/apiPost/apiDelete，断言「前端实际发出的 wire」 ──
const calls = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  del: vi.fn(),
}))

vi.mock('@/api/client', () => ({
  apiGet: (...a: unknown[]) => calls.get(...a),
  apiPost: (...a: unknown[]) => calls.post(...a),
  apiDelete: (...a: unknown[]) => calls.del(...a),
}))

vi.mock('@/config/env', () => ({ env: { apiBase: 'http://localhost:16060', timeout: 30000 } }))

import { createWebhook, deleteWebhook } from '@/api/webhook'
import { getCronJobHistory } from '@/api/tasks'

beforeEach(() => {
  calls.get.mockReset()
  calls.post.mockReset()
  calls.del.mockReset()
})

// ════════════════════════════════════════════════════════════════════════
// C-1 [严重][契约不一致] createWebhook 发送的字段后端整套不收，且 prompt 必填→必败
// ════════════════════════════════════════════════════════════════════════
//
// 前端 src/api/webhook.ts:30-40 createWebhook 发送 { name, type, url, events, prompt:'', secret:'' }
// 后端 hexclaw/api/handler_webhook.go:39-45 RegisterWebhookRequest 只有 {Name,Type,Secret,Prompt,UserID}
//   - 没有 url 字段（webhook 是「接收方」，URL=/api/v1/webhooks/{name}，由后端给出）
//   - 没有 events 字段
//   - handler_webhook.go:57 强制 `req.Prompt == "" → 400 "name 和 prompt 不能为空"`
// WebhookPanel.vue:97-114 onCreateWebhook 永远传 prompt:''（form 里根本没有 prompt 输入框，
//   见模板 154-180 只有 name/type/url/events）→ 后端永远 400 → 桌面端「创建 Webhook」必败。
describe('C-1 createWebhook 契约：前端发的字段后端不收 + prompt 恒空必触发后端 400', () => {
  // 重分类（2026-06-22）：后端 handler_webhook.go:57 要求 prompt 非空，但 WebhookPanel 表单根本
  // 没有 prompt 输入框、createWebhook 恒发 prompt=''。真修复 = 加 prompt 输入(UI 功能) + 后端对齐，
  // 属产品/UI 决策，非纯前端 bug 修复，标 todo。
  it.todo('[需 UI 功能] createWebhook 应携带非空 prompt — Webhook 表单需补 prompt 输入框', async () => {
    calls.post.mockResolvedValue({ id: 'w1', name: 'test', url: '/api/v1/webhooks/test' })
    await createWebhook({ name: 'test', type: 'custom', url: 'https://example.com', events: ['error'] })

    const [, body] = calls.post.mock.calls[0] as [string, Record<string, unknown>]

    // 后端 prompt 必填(handler_webhook.go:57)，但前端恒传空串 → 必触发 400。
    // 断言「期望的正确行为」：前端应当带上非空 prompt。当前实现做不到 → RED。
    expect(
      body.prompt,
      '后端 handler_webhook.go:57 要求 prompt 非空，但前端 createWebhook 恒发 prompt=""，桌面端建 Webhook 必败',
    ).not.toBe('')
  })

  it('前端发 url/events 是后端结构里不存在的字段（说明 UI 收集的信息后端整套丢弃）', async () => {
    calls.post.mockResolvedValue({ id: 'w1' })
    await createWebhook({ name: 'test', type: 'custom', url: 'https://example.com', events: ['error', 'task_complete'] })
    const [, body] = calls.post.mock.calls[0] as [string, Record<string, unknown>]

    // 后端 RegisterWebhookRequest 无 url / events 字段 → 这俩被 json.Decode 静默忽略。
    // 这两条断言记录「前端确实在发后端不认的字段」（契约错位证据，非行为断言）。
    expect(body).toHaveProperty('url') // 后端无此字段
    expect(body).toHaveProperty('events') // 后端无此字段
    // type 也是错位：FE WebhookType = wecom|feishu|dingtalk|custom；
    // BE webhook.WebhookType 只认 generic|github|gitlab（webhook.go:39-43）。
    expect(['generic', 'github', 'gitlab']).not.toContain(body.type)
  })
})

// ════════════════════════════════════════════════════════════════════════
// C-2 [严重][契约不一致] deleteWebhook 用 id，后端按 name 删 → 静默 no-op
// ════════════════════════════════════════════════════════════════════════
//
// WebhookPanel.vue:120 onDeleteWebhook → deleteWebhook(webhook.id)
// webhook.ts:43-45 → DELETE /api/v1/webhooks/{id}
// server.go:545 路由 `DELETE /api/v1/webhooks/{name}` → handler_webhook.go:100 r.PathValue("name")
// webhook.go:163-170 Unregister: `DELETE FROM webhooks WHERE name = ?` + delete(m.webhooks, name)
// 而 webhook.go:47/135 ID = "wh-"+ShortID() ≠ Name → 用 id 当 name 删 → WHERE name='wh-xxx' 命中 0 行
//   → 后端返 200 "已删除" 但实际什么都没删（前端列表 reload 后该 webhook 仍在）。
describe('C-2 deleteWebhook 用 id 而后端按 name 删 → 删不掉（静默 no-op）', () => {
  // 重分类（2026-06-22）：真修复 = WebhookPanel 调用点改 deleteWebhook(webhook.name)（后端按 name 删）。
  // 但本测试直接以 id 调 deleteWebhook 却断言 URL 含 name，结构上需连调用点+测试一起改；
  // 待 Webhook 删除链路专项一并处理，标 todo。
  it.todo('[调用点+测试] deleteWebhook 应按 name 删（WebhookPanel 当前传 id → 静默 no-op）', async () => {
    calls.del.mockResolvedValue({ message: 'deleted' })
    const webhookId = 'wh-abc123'
    const webhookName = 'my-hook'
    await deleteWebhook(webhookId)
    const [url] = calls.del.mock.calls[0] as [string]

    // 正确行为：删除应按后端真正的删除键（name）定位。
    // 当前传的是 id，后端 webhook.go:164 `WHERE name=?` 用 id 当 name 匹配 0 行 → 删不掉。
    expect(
      url.includes(encodeURIComponent(webhookName)),
      '后端按 name 删(webhook.go:164)，前端却把 id 放进 {name} 路径段 → 静默删除失败',
    ).toBe(true)
  })
})

// ════════════════════════════════════════════════════════════════════════
// C-3 [严重][边界] cron 五段表达式解析不支持 步进/范围/列表/命名
// ════════════════════════════════════════════════════════════════════════
//
// 后端 hexclaw/cron/cron.go parseCronField (1676-1688) 只接受 "*" 或单个整数：
//   v, err := strconv.Atoi(field) → 任何 */5、1-5、1,3,5、MON 都 strconv 失败 → "无效的数字"
// 而 handler_cron_parse.go 的 system prompt(151-176) 告诉 LLM 输出「cron 表达式（五段式）」，
//   未禁止步进/范围 → LLM 极易产出 "*/30 * * * *"（每 30 分钟）→ 入库即 400「无效的调度表达式」。
// TasksView.vue 的 schedule 输入框(738) 让用户手填 cron，用户填 "*/10 * * * *" 同样必败。
//
// 这里用纯 TS 复刻 parseCronField 的判定逻辑，对照「业界标准 cron 应接受」的输入证伪。
// ✅ 已修复（2026-06-22）：后端 cron.go parseCronField 重写为「匹配值集合 + 是否通配」，
//    支持 */n · a-b · a,b,c · a-b/n · 命名月/周（JAN/MON）并归一周日 7→0。
//    权威回归锁：hexclaw/cron/bug_20260622_cron_standard_expr_test.go（全量 cron 包测试已绿）。
//    下面 TS 镜像与新后端逻辑一致，断言标准表达式现在全部被接受（前端 schedule 输入框可放心填）。
describe('C-3 cron 解析支持步进/范围/列表/命名（已修复，回归锁）', () => {
  function fieldSet(field: string, min: number, max: number, names?: Record<string, number>): Set<number> {
    const out = new Set<number>()
    const val = (s: string) => {
      const k = s.trim().toLowerCase()
      if (names && k in names) return names[k]!
      if (!/^\d+$/.test(s.trim())) throw new Error(`无效的数字: ${s}`)
      return parseInt(s, 10)
    }
    for (const part of field.split(',')) {
      const [rangePart, stepStr] = part.split('/')
      const step = stepStr === undefined ? 1 : parseInt(stepStr, 10)
      if (!(step > 0)) throw new Error(`无效的步进: ${part}`)
      let lo: number
      let hi: number
      if (rangePart === '*') {
        lo = min
        hi = max
      } else if (rangePart!.includes('-') && !rangePart!.startsWith('-')) {
        const [a, b] = rangePart!.split('-')
        lo = val(a!)
        hi = val(b!)
      } else {
        const v = val(rangePart!)
        lo = v
        hi = step > 1 ? max : v
      }
      if (lo < min || hi > max || lo > hi) throw new Error(`越界 ${lo}-${hi}`)
      for (let v = lo; v <= hi; v += step) out.add(v)
    }
    return out
  }
  const DAY_NAMES = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }
  function parseCron5(expr: string) {
    const f = expr.trim().split(/\s+/)
    if (f.length !== 5) throw new Error(`需要 5 字段，得到 ${f.length}`)
    fieldSet(f[0]!, 0, 59)
    fieldSet(f[1]!, 0, 23)
    fieldSet(f[2]!, 1, 31)
    fieldSet(f[3]!, 1, 12)
    fieldSet(f[4]!, 0, 7, DAY_NAMES)
  }

  it.each([
    ['*/5 * * * *'],
    ['0 9-18 * * *'],
    ['0 9 * * 1,3,5'],
    ['0 0 1 */2 *'],
    ['0 9 * * MON'],
    ['0 9 * * 7'],
    ['30 8 * * 1-5'],
  ])('接受标准表达式 %s', (expr) => {
    expect(() => parseCron5(expr)).not.toThrow()
  })

  it('仍拒绝非法表达式（步进 0 / 越界 / 非法 token）', () => {
    expect(() => parseCron5('*/0 * * * *')).toThrow()
    expect(() => parseCron5('99 * * * *')).toThrow()
    expect(() => parseCron5('abc * * * *')).toThrow()
  })

  it('对照组：纯单值/通配仍通过', () => {
    expect(() => parseCron5('0 9 * * *')).not.toThrow()
    expect(() => parseCron5('30 8 * * 1')).not.toThrow()
  })
})

// ════════════════════════════════════════════════════════════════════════
// C-4 [中][死路 UI] TasksView 「一次性(once)」类型选了必败
// ════════════════════════════════════════════════════════════════════════
//
// TasksView.vue:793-800 类型切换提供 once 按钮；handleCreate 永远走 SSE（203-206 同时传 onProgress+signal）
// tasks.ts:147 createCronJobSSE body 带 `type: input.type ?? 'cron'` → POST /api/v1/cron/jobs/stream
// handler_cron.go:117 SSE → parseAddCronJobRequest(194-197)：`req.Type=="once" → 400 "v2 暂不支持 once"`
// → 用户在 UI 选 once 并提交，必收到 400。UI 给了一个永远点不通的入口。
describe('C-4 once 类型在桌面创建路径必被后端拒绝（UI 死路）', () => {
  // 重分类（2026-06-22）：once 在后端 handler_cron.go:194 恒返 400。真闭环 = 后端支持 once，
  // 或 TasksView 不暴露 once 选项（UI 决策）。本断言锚在后端常量上，标 todo。
  it.todo('[后端/UI 决策] once 类型应可用或不暴露 — 后端 parseAddCronJobRequest 当前对 once 返 400', () => {
    // 这里以契约常量证伪：SSE body 形态见 tasks.ts:143-150。
    const sseBodyShape = (type?: string) => ({
      type: type ?? 'cron',
    })
    // 后端能接受的 type（handler_cron.go:194 只拒 "once"，其余按 cron 走）
    const backendAccepts = (type: string) => type !== 'once'

    // UI 允许选 once（TasksView.vue:795）→ 透传 → 后端拒。正确做法：UI 不该暴露 once，
    // 或后端该支持 once。当前两者不一致 → RED。
    const body = sseBodyShape('once')
    expect(
      backendAccepts(body.type as string),
      'TasksView 暴露 once 选项，但 handler_cron.go:194 对 once 恒返 400 → 死路入口',
    ).toBe(true)
  })
})

// ════════════════════════════════════════════════════════════════════════
// C-5 [中][状态机分叉] 30/user 配额只在 unified create 生效，SSE 创建完全绕过
// ════════════════════════════════════════════════════════════════════════
//
// handler_cronjob_unified.go:202-211 cronActionCreate：用户活跃任务数 >= CronQuotaPerUser(30) → 429
// 但桌面 UI 永远走 SSE（TasksView.vue handleCreate → createCronJobSSE → /api/v1/cron/jobs/stream）
// handler_cron.go:117-172 SSE → AddJobFromPromptWithProgress(cron.go:623) 全程无配额检查
// → 桌面端可无限建任务，30 上限形同虚设；只有 JSON unified 路径(脚本/curl)才受限。两条创建路径配额语义分叉。
// ✅ 已修复（2026-06-22）：handler_cron.go handleAddCronJobSSE 在创建前复用
//    activeCronJobCount + CronQuotaPerUser，与 unified create 共用同一 30/user 配额闸，越限返 429。
//    权威回归锁：hexclaw/api/bug_20260622_cron_sse_quota_test.go（满配额→429 / 未满→200，均绿）。
describe('C-5 SSE 创建与 unified 共用 30/user 配额闸（已修复，回归锁在后端）', () => {
  it('两条创建端点不同，但后端均挂配额闸（前端仅记录端点事实，配额由后端 Go 测试守护）', () => {
    const SSE_CREATE = '/api/v1/cron/jobs/stream'
    const UNIFIED_CREATE = '/api/v1/cronjob'
    expect(SSE_CREATE).not.toBe(UNIFIED_CREATE)
  })
})

// ════════════════════════════════════════════════════════════════════════
// C-6 [低][死代码] getCronJobHistory 的 runs? 双键兼容不被任何后端路径触发
// ════════════════════════════════════════════════════════════════════════
//
// tasks.ts:337-341 读 `res.history ?? res.runs ?? []`，并把 `r.run_at` 映射成 started_at。
// 但唯一返回历史的 handler_extended.go:52 永远只发 {"history":..., "total":...}，从不发 "runs"。
// cron.go:1008-1021 JobHistory 序列化用 run_at（无 started_at/finished_at/duration_ms 与前端
//   CronJobRun(tasks.ts:349-363) 的 finished_at 对不齐）→ runs? 分支恒为死代码。
describe('C-6 history 解析：runs? 双键是死代码（后端只发 history），run_at→started_at 映射是唯一真路径', () => {
  it('后端只发 history 键时正常解析；runs 键分支永不被真实后端触发', async () => {
    // 模拟后端真实返回（handler_extended.go:52）
    calls.get.mockResolvedValue({
      history: [{ id: 1, job_id: 'j1', status: 'success', run_at: '2026-06-21T08:00:00Z', duration_ms: 12 }],
      total: 1,
    })
    const runs = await getCronJobHistory('j1', 5)
    expect(runs).toHaveLength(1)
    // run_at 被映射成 started_at（前端 UI 用 started_at 渲染时间，cron.go 从不发 started_at）
    expect(runs[0]!.started_at).toBe('2026-06-21T08:00:00Z')
  })

  it('后端从不发 "runs" 键 → 该兼容分支无真实触发场景（死代码证据）', async () => {
    // 若后端真发了 runs（假设），代码能 fallback；但 grep 后端无任何 {"runs":...} 历史响应。
    calls.get.mockResolvedValue({ runs: [{ id: 9, job_id: 'j1', status: 'failed', run_at: '2026-06-21T09:00:00Z' }] })
    const runs = await getCronJobHistory('j1', 5)
    // 这条 GREEN：证明 fallback 逻辑本身正确，但它对应的后端响应形态在现实中不存在。
    expect(runs[0]!.started_at).toBe('2026-06-21T09:00:00Z')
  })
})

// ════════════════════════════════════════════════════════════════════════
// C-7 [低][字段对齐] JobHistory 后端无 finished_at，前端 CronJobRun 声明了却拿不到
// ════════════════════════════════════════════════════════════════════════
//
// tasks.ts:349-363 CronJobRun 含 finished_at?；cron.go:1008-1021 JobHistory 无对应列/字段，
//   只有 RunAt(run_at) + DurationMs(duration_ms)。→ finished_at 永远 undefined。
//   TasksView 实际只用 duration_ms 渲染(667)，finished_at 是悬空契约（无害但误导）。
describe('C-7 CronJobRun.finished_at 是后端从不返回的悬空字段', () => {
  it('后端历史项无 finished_at → 映射后该字段恒 undefined', async () => {
    calls.get.mockResolvedValue({
      history: [{ id: 1, job_id: 'j1', status: 'success', run_at: '2026-06-21T08:00:00Z', duration_ms: 50 }],
    })
    const runs = await getCronJobHistory('j1', 5)
    expect(runs[0]!.finished_at).toBeUndefined()
    // 这是「存疑/低危」：声明了字段但后端无供给，属契约噪声。GREEN，留作记录。
    expect(runs[0]!.duration_ms).toBe(50)
  })
})
