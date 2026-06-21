/**
 * ════════════════════════════════════════════════════════════════════════
 * 域 V2 审查取证 — 能力探测 / 工具状态 / 团队 / 模型 / 连接器
 * ════════════════════════════════════════════════════════════════════════
 *
 * SDET 挑刺式只读审查（证据驱动）。每条 finding 配可执行断言。
 *
 *   - RED 断言 = 暴露 bug（断言"正确行为"，当前实现做不到 → 失败取证）
 *   - GREEN 断言 = 坐实当前（错误/危险/孤儿）行为确实存在，作为契约取证
 *
 * 涉及文件：
 *   前端 src/api/capabilities.ts | tools-status.ts | team.ts | models.ts | connectors.ts
 *        src/views/SettingsView.vue | ConnectionsView.vue
 *        src/components/channels/ConnectorConfigModal.vue
 *        src/api/index.ts | src/router/index.ts | src/config/team-fallback.ts
 *   后端 /Users/hexagon/work/hexclaw/api/handler_capabilities.go
 *        handler_tools.go | handler_team.go | handler_connectors.go | server.go
 *        llmrouter/capabilities.go | engine/budget.go | connector/connector.go
 *
 * 注：api/client.ts 里 `api = ofetch.create(...)`，apiGet/apiPost/apiDelete 均经 api()。
 *     mock ofetch.create → 拿到 mockFetch，断言 (url, opts) 实参。
 *     proxy（connectors）走 @tauri-apps/api/core invoke，单独 mock。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFetch = vi.hoisted(() => vi.fn())
vi.mock('ofetch', () => ({
  ofetch: { create: () => mockFetch },
}))

// connectors.ts 动态 import('@tauri-apps/api/core')，mock invoke
const mockInvoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockInvoke,
}))

import { fetchCapabilities, probeCapability } from '@/api/capabilities'
import { getBudgetStatus, getToolMetrics } from '@/api/tools-status'
import {
  getSharedAgents,
  getTeamMembers,
  inviteTeamMember,
} from '@/api/team'
import {
  getConnectors,
  testConnector,
  createConnector,
} from '@/api/connectors'

function lastCall() {
  return mockFetch.mock.calls[mockFetch.mock.calls.length - 1]!
}
function lastInvoke() {
  return mockInvoke.mock.calls[mockInvoke.mock.calls.length - 1]!
}

beforeEach(() => {
  vi.clearAllMocks()
  mockFetch.mockReset()
  mockInvoke.mockReset()
})

// ════════════════════════════════════════════════════════════════════════
// H-1 [中][字段对齐] fetchCapabilities snake_case→camelCase + nil→[] 契约
//   FE  src/api/capabilities.ts:32-48 (toRecord) + 44-48 (fetchCapabilities)
//   BE  llmrouter/capabilities.go:51-57 (Capability struct json tag)
//       handler_capabilities.go:29-33 (caps==nil → []llmrouter.Capability{})
//   契约成立取证：provider_name→providerName / model_name→modelName /
//   tool_call_text→reliability.level / last_probe→reliability.lastProbe。
//   后端 LastProbe 是 time.Time → RFC3339 字符串；FE 直接当 string 用。
// ════════════════════════════════════════════════════════════════════════
describe('H-1 fetchCapabilities 裸数组 + snake→camel 映射对齐', () => {
  it('[GREEN] provider_name/model_name/tool_call_text/last_probe 正确映射', async () => {
    mockFetch.mockResolvedValueOnce([
      {
        provider_name: 'OpenAI',
        model_name: 'gpt-4o',
        tool_call: 1,
        tool_call_text: 'good',
        last_probe: '2026-06-22T00:00:00Z',
        probe_error: '',
      },
    ])
    const recs = await fetchCapabilities()
    expect(recs[0]).toMatchObject({
      providerName: 'OpenAI',
      modelName: 'gpt-4o',
      reliability: { level: 'good', lastProbe: '2026-06-22T00:00:00Z' },
    })
  })

  it('[GREEN] 后端 nil→[]（或 service 未启用前端拿到 null）→ 不崩，返回 []', async () => {
    mockFetch.mockResolvedValueOnce(null)
    expect(await fetchCapabilities()).toEqual([])
  })
})

// ════════════════════════════════════════════════════════════════════════
// H-2 [中][边界/对齐风险] probeCapability POST + query，无 body；中文 provider 编码
//   FE  src/api/capabilities.ts:51-59 — apiPost(url+query)，无第二参 → opts.body 缺失
//   BE  handler_capabilities.go:43-48 — 只读 query.Get("provider"/"model")，必填校验
//   SettingsView.vue:332-333 refreshCapability 传 pName=provider.backendKey||name，
//   可能是中文「智谱」。前端 encodeURIComponent OK，但若后端 selector 按英文 key
//   注册，中文 name 会 probe 失败 → 取证编码正确、POST 无 body（后端只读 query）。
// ════════════════════════════════════════════════════════════════════════
describe('H-2 probeCapability POST+query 无 body，中文 provider 百分号编码', () => {
  it('[GREEN] URL 含 encodeURIComponent(中文 provider) 且 method=POST、body 缺失', async () => {
    mockFetch.mockResolvedValueOnce({
      provider_name: '智谱',
      model_name: 'glm-4',
      tool_call: 2,
      tool_call_text: 'partial',
      last_probe: '2026-06-22T00:00:00Z',
    })
    const rec = await probeCapability('智谱', 'glm-4')
    const [url, opts] = lastCall()!
    expect(url).toContain(`provider=${encodeURIComponent('智谱')}`)
    expect(url).toContain('model=glm-4')
    expect(opts.method).toBe('POST')
    expect(opts.body).toBeUndefined() // apiPost 无 body 时不附 body 键
    expect(rec.reliability.level).toBe('partial')
  })
})

// ════════════════════════════════════════════════════════════════════════
// H-3 [低][对齐] getBudgetStatus / getToolMetrics 字段直通对齐
//   FE  src/api/tools-status.ts:5-16 (BudgetStatus) + 49-51 / 33-35 + 59-61
//   BE  engine/budget.go:255-264 (BudgetStatus json tag) — 10 字段全对齐
//       handler_tools.go:36-43 (handleToolMetrics) — 出错仍 200 + {tools:[],error}
//   取证：tokens_remaining/cost_remaining/duration_remaining/exhausted 等直通；
//   metrics 在后端出错时返回 {tools:[],error}，FE 类型 ToolMetrics 无 error 字段（容忍但不暴露）。
// ════════════════════════════════════════════════════════════════════════
describe('H-3 budget/status 与 tools/metrics 字段直通', () => {
  it('[GREEN] budget 10 字段对齐（含 exhausted / *_remaining）', async () => {
    mockFetch.mockResolvedValueOnce({
      tokens_used: 100,
      tokens_max: 1000,
      tokens_remaining: 900,
      cost_used: 0.1,
      cost_max: 1,
      cost_remaining: 0.9,
      duration_used: '1m',
      duration_max: '1h',
      duration_remaining: '59m',
      exhausted: false,
    })
    const res = await getBudgetStatus()
    expect(res.tokens_remaining).toBe(900)
    expect(res.exhausted).toBe(false)
  })

  it('[GREEN 取证] tools/metrics 后端出错走 200+{tools:[],error}，FE 仅读 tools', async () => {
    mockFetch.mockResolvedValueOnce({ tools: [], error: 'read stats failed' })
    const res = await getToolMetrics()
    expect(res.tools).toEqual([])
    // FE ToolMetrics 类型没有 error 字段，错误信息被吞（用户看到空指标而非报错）
    expect((res as { error?: string }).error).toBe('read stats failed')
  })
})

// ════════════════════════════════════════════════════════════════════════
// H-4 [高][功能未闭环 / 死代码] 整个 team API 无任何 UI 消费方
//   FE  src/api/team.ts:69-151 (6 个导出函数) — 全仓唯一引用：
//       src/api/index.ts:18  `export * from './team'`（透传）
//       src/config/team-fallback.ts:12-17（仅 warning 文案常量）
//   src/router/index.ts:66  `{ path: '/team', redirect: '/settings' }` → 无 Team 视图
//   grep 全仓 src/views + src/components：0 处 import '@/api/team'、0 处用
//   SharedAgent/TeamMember/inviteTeamMember/getTeamMembers。
//   后端 handler_team.go:169-227 + server.go:732-737 路由全注册，前端却无入口。
//   根因：团队协作功能后端先行、前端只留 API 桩，UI 未建（半成品）。
//   取证：API 可调用（说明是真桩不是占位），但没有任何页面会触发它。
// ════════════════════════════════════════════════════════════════════════
describe('H-4 team API 是孤儿：后端有路由+前端有 API，但零 UI 消费方', () => {
  // [重分类：按设计推迟] team 整模块后端齐全、前端零 UI、/team→/settings 重定向是
  // 有意推迟（团队协作功能后端先行，UI 留待后续版本）。不建 team UI、不删后端 API。
  // 故 H-4 不作为 bug 修复，转 it.todo 记录推迟决策。
  it.todo('[推迟功能] team 模块 UI 待后续版本；当前 /team→/settings 有意为之')

  // 保留 API 可用性取证（证明这是真桩而非占位），不影响推迟结论。
  it('[GREEN 取证] getSharedAgents 正常解包 {agents}（API 可用，证明是真桩）', async () => {
    mockFetch.mockResolvedValueOnce({ agents: [{ id: 'sa-1', name: 'A' }], total: 1 })
    const res = await getSharedAgents()
    expect(res[0]!.name).toBe('A')
    // 但全仓无任何 .vue 调用它 → 死路径（见 describe 头注的 grep 证据）
  })

  it('[GREEN 取证] getTeamMembers 解包 {members}', async () => {
    mockFetch.mockResolvedValueOnce({ members: [{ id: 'tm-1', name: 'B' }], total: 1 })
    const res = await getTeamMembers()
    expect(res[0]!.name).toBe('B')
  })
})

// ════════════════════════════════════════════════════════════════════════
// H-5 [中][契约不一致] getTeamMembers 在线返空[]，离线降级却返 [defaultMember]
//   FE  src/api/team.ts:111-121
//       try: return res.members ?? []      → 后端空团队 → []
//       catch: local.length===0 ? [defaultMember()] : local → 离线 → 1 个默认成员
//   BE  handler_team.go:197-200 handleListTeamMembers → {members:[],total:0}（空）
//   后果：同一空状态，引擎在线 = 0 成员、引擎离线 = 1 成员（"我"），
//   UI 成员数随引擎连通性跳变。正确行为：空团队两条路径应一致呈现当前用户或都为空。
// ════════════════════════════════════════════════════════════════════════
describe('H-5 getTeamMembers 在线空[] vs 离线[defaultMember] 不一致', () => {
  it('[GREEN 取证] 后端返回空 members → 在线路径得到空数组', async () => {
    mockFetch.mockResolvedValueOnce({ members: [], total: 0 })
    const online = await getTeamMembers()
    expect(online).toEqual([])
  })

  it('[RED] 在线空团队 与 离线空团队 应呈现一致成员数（当前在线=0/离线=1 不一致）', async () => {
    // 在线：后端空 → []
    mockFetch.mockResolvedValueOnce({ members: [], total: 0 })
    const online = await getTeamMembers()
    // 离线：apiGet 抛错 → catch → local 空 → [defaultMember()]（长度 1）
    localStorage.clear()
    mockFetch.mockRejectedValueOnce(new Error('Failed to fetch'))
    const offline = await getTeamMembers()
    // 正确行为：同一"空团队"语义两条路径长度应相等。当前 0 !== 1 → RED 失败坐实。
    expect(online.length).toBe(offline.length)
  })
})

// ════════════════════════════════════════════════════════════════════════
// H-6 [低][契约/语义] inviteTeamMember 本地降级成员的 last_active 是占位串，
//      在线成功则返回后端成员（id/last_active 由后端生成）。
//   FE  src/api/team.ts:123-141
//       member.last_active = TEAM_PENDING_MEMBER_LAST_ACTIVE（如 '从未'/占位）
//       try: POST /team/members body=invite({email,role}) → 返回后端 TeamMember
//   BE  handler_team.go:202-218 handleInviteTeamMember
//       Decode 进 TeamMember（仅 email/role 生效），AddMember 生成 id + LastActive=now()
//   取证：在线请求 body 只含 {email,role}（不含前端造的 id/last_active），
//   后端忽略前端 id 自生成 → 前端预造的 member.id 在线时被丢弃（双造 ID 冗余）。
// ════════════════════════════════════════════════════════════════════════
describe('H-6 inviteTeamMember 在线 body 只发 {email,role}，前端预造 id 被丢弃', () => {
  it('[GREEN 取证] POST body === 原始 invite（不含前端生成的 id/name/last_active）', async () => {
    mockFetch.mockResolvedValueOnce({
      id: 'tm-server',
      name: 'bob',
      email: 'bob@x.com',
      role: 'member',
      last_active: '2026-06-22T00:00:00Z',
    })
    const res = await inviteTeamMember({ email: 'bob@x.com', role: 'member' })
    const [url, opts] = lastCall()!
    expect(url).toBe('/api/v1/team/members')
    expect(opts.body).toEqual({ email: 'bob@x.com', role: 'member' })
    // 前端在 catch 分支才用自造 id；在线时直接采用后端 id（自造 id 仅离线生效）
    expect(res.id).toBe('tm-server')
  })
})

// ════════════════════════════════════════════════════════════════════════
// H-7 [高][功能未闭环] getConnectors（列表端点）零消费方 → 连接器列表不从后端水合
//   FE  src/api/connectors.ts:49-53 getConnectors（GET /connectors）
//       全仓消费 grep：ConnectionsView.vue 只用 deleteConnector(:114) +
//       getConnectorResources(:245,269)，从不调 getConnectors；列表来自
//       本地 composable useConnectorInstances(:104)。
//   BE  handler_connectors.go:17-21 + server.go:534 GET /api/v1/connectors 已注册。
//   后果：用户 createConnector 成功后，后端持有该连接器（加密落盘），但前端列表
//   永不读后端 → 换设备/清本地后已配连接器"消失"，且无法发现引擎侧已有连接器。
//   取证：getConnectors 能正确解包 {connectors}，但没有任何视图调用它。
// ════════════════════════════════════════════════════════════════════════
describe('H-7 getConnectors 端点存在但无 UI 消费 → 连接器不从后端水合', () => {
  // [重分类：转 todo — 并发改造风险] 最小修需在 ConnectionsView.vue onMounted 或
  // useConnectorInstances 接入 getConnectors 做后端水合，但 ConnectionsView.vue 当前为
  // 未跟踪（git ??）且刚于本次审查前数分钟被改动，判定正被并发编辑/重构。在其上叠加
  // 后端水合改动冲突风险高，故推迟，待 ConnectionsView 并发改造收尾后再接后端水合。
  // getConnectors 本身（连接器 API 层）已就绪并经下方两条取证用例验证可用。
  it.todo('[待并发改造收尾] ConnectionsView 接入 getConnectors 做后端水合（合并本地+引擎侧连接器）')

  it('[GREEN 取证] getConnectors 解包 {connectors}（API 可用，仅无人调用）', async () => {
    mockInvoke.mockResolvedValueOnce(
      JSON.stringify({ connectors: [{ id: 'c1', provider: 'github', name: 'gh', created_at: '2026-06-22T00:00:00Z' }], total: 1 }),
    )
    const res = await getConnectors()
    expect(res[0]).toMatchObject({ id: 'c1', provider: 'github', name: 'gh' })
    // ConnectionsView 不调此函数 → 后端连接器永不出现在 UI（见 describe 头注证据）
  })

  it('[GREEN] 引擎降级（invoke 抛 plugin 错）→ getConnectors 优雅返 []', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('plugin not initialized'))
    expect(await getConnectors()).toEqual([])
  })
})

// ════════════════════════════════════════════════════════════════════════
// H-8 [中][边界/类型缺口] ConnectorProvider 仅 'github'|'notion'，但
//      ConnectorConfigModal 用 `formType.value as ConnectorProvider` 强转动态 ID
//   FE  src/api/connectors.ts:8 type ConnectorProvider = 'github' | 'notion'
//       ConnectorConfigModal.vue:47 formType: ref<string>('')（来自 props.types[*].id）
//       :75 / :208 `formType.value as ConnectorProvider` 把任意字符串强转后发后端
//   BE  connector/connector.go:32-38 IsValid → 仅 github/notion；
//       handler_connectors.go:38-41 create 不支持的 provider → 400 {error}
//       handler_connectors.go:69-74 test → 恒 200 {ok:false,detail}
//   取证：传非 github/notion 的 provider，createConnector 应把后端 400 的 {error} 抛出；
//   类型层 `as` 强转掩盖了 props.types 可能含未支持 provider 的事实。
// ════════════════════════════════════════════════════════════════════════
describe('H-8 createConnector 对后端 400 不支持 provider 抛错（as 强转绕过类型护栏）', () => {
  it('[GREEN] 后端 {error:不支持的数据源} → createConnector 抛出该 error', async () => {
    mockInvoke.mockResolvedValueOnce(JSON.stringify({ error: '不支持的数据源: xiaohongshu' }))
    await expect(
      // 运行期可传任意字符串（as ConnectorProvider 强转后），类型层不拦
      createConnector('xiaohongshu' as unknown as 'github', 'x', 't'),
    ).rejects.toThrow('不支持的数据源')
  })

  it('[GREEN] testConnector 端点恒 200 + {ok:false} 契约（不抛错，返回 ok=false）', async () => {
    mockInvoke.mockResolvedValueOnce(JSON.stringify({ ok: false, detail: '不支持的数据源: weibo' }))
    const res = await testConnector('weibo' as unknown as 'github', 't')
    expect(res.ok).toBe(false)
    expect(res.detail).toContain('不支持')
  })
})

// ════════════════════════════════════════════════════════════════════════
// H-9 [中][契约缺口] createConnector body 经 JSON.stringify 走 invoke，
//      但成功响应缺 id 时报"创建失败"——与后端 summary 形态对齐取证。
//   FE  src/api/connectors.ts:71-82
//       parsed.error → throw；!parsed.id → throw '创建失败：后端未返回连接器'
//   BE  handler_connectors.go:43 writeJSON(summary) summary=connector.Summary
//       connector/connector.go:51-55 Summary{id,provider,name,created_at}
//   取证：后端正常返回 Summary（含 id）→ FE 透传为 ConnectorSummary；
//   若后端形态退化（无 id 的对象）→ FE 抛"创建失败"防御成立。
// ════════════════════════════════════════════════════════════════════════
describe('H-9 createConnector 成功路径透传 Summary，缺 id 防御', () => {
  it('[GREEN] 后端 Summary{id,...} → 透传成 ConnectorSummary', async () => {
    mockInvoke.mockResolvedValueOnce(
      JSON.stringify({ id: 'c2', provider: 'notion', name: 'n', created_at: '2026-06-22T00:00:00Z' }),
    )
    const res = await createConnector('notion', 'n', 'tok')
    expect(res).toMatchObject({ id: 'c2', provider: 'notion' })
    const [, args] = lastInvoke()!
    // body 是 JSON 字符串，含 provider/name/token
    expect(JSON.parse((args as { body: string }).body)).toEqual({ provider: 'notion', name: 'n', token: 'tok' })
  })

  it('[GREEN] 后端返回无 id 对象 → 抛"创建失败"（防御已实现，契约取证）', async () => {
    // connectors.ts:80 `if (!parsed || !parsed.id) throw` 防御成立 → GREEN 锁定。
    mockInvoke.mockResolvedValueOnce(JSON.stringify({ provider: 'notion', name: 'n' }))
    await expect(createConnector('notion', 'n', 'tok')).rejects.toThrow('创建失败')
  })
})

// ════════════════════════════════════════════════════════════════════════
// H-10 [低][死类型 / 半成品] models.ts LLMModel 是孤儿类型 + team.ts 导入导出 TODO 空壳
//   FE  src/api/models.ts:2-6 LLMModel{id,name,provider} — 全仓唯一引用：
//        src/api/index.ts:23 `export type { LLMModel }`（透传），0 处实际使用。
//        settings.ts 用自己的 ModelOption（settings 域），从不用 LLMModel。
//   FE  src/api/team.ts:153-154 `// ─── 导入导出 ───` 章节标题后即文件结束（154 行），
//        无 exportTeam/importTeam 实现 → 半成品占位（与团队 UI 缺失呼应，H-4）。
//   取证：本测试文件能 import LLMModel 类型但运行期无值（纯 type）；记录孤儿事实。
// ════════════════════════════════════════════════════════════════════════
describe('H-10 LLMModel 孤儿类型 + team 导入导出空壳（取证型，无运行断言）', () => {
  // [重分类：按设计推迟 / 不删死类型]
  //   · team.ts 的 exportTeam/importTeam 空壳与 H-4 同属团队模块整体推迟，待后续版本。
  //   · LLMModel 虽无运行期消费，但全仓有 4 处测试断言其存在（code-review-v3:389 /
  //     code-review-v9-comprehensive:672 / code-review-audit:486 / api-alignment-audit:545），
  //     直接删除会连带破坏这些既有契约测试 → 不作为死代码清理，保留类型，标 todo 待整体收口。
  it.todo('[推迟功能] team 导入导出（exportTeam/importTeam）待后续版本；LLMModel 因 4 处测试契约引用暂保留')
})
