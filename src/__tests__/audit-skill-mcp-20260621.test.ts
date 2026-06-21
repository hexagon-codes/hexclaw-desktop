/**
 * ════════════════════════════════════════════════════════════════════════
 * 域D 审查取证 — skill / mcp / 能力探测 / clawhub / tools-status
 * ════════════════════════════════════════════════════════════════════════
 *
 * SDET 挑刺式只读审查。每条 finding 配可执行断言。
 *
 *   - RED 断言 = 暴露 bug（断言"正确行为"，当前实现做不到 → 失败取证）
 *   - GREEN 断言 = 坐实当前（错误/危险）行为确实存在，作为契约取证
 *
 * 涉及文件：
 *   前端 src/api/skills.ts | mcp.ts | capabilities.ts | tools-status.ts
 *        src/types/mcp.ts | skill.ts | src/views/McpView.vue | SkillsView.vue
 *   后端 /Users/hexagon/work/hexclaw/api/handler_misc.go
 *        handler_extended.go | handler_skill_content.go | handler_capabilities.go
 *        handler_tools.go | llmrouter/capabilities.go | mcp/client.go
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFetch = vi.hoisted(() => vi.fn())
vi.mock('ofetch', () => ({
  ofetch: { create: () => mockFetch },
}))

import {
  installSkill,
  uninstallSkill,
  setSkillEnabled,
  getSkillContent,
  searchClawHub,
  installFromHub,
} from '@/api/skills'
import {
  getMcpServers,
  getMcpServerStatus,
  callMcpTool,
  searchMcpMarketplace,
  getMcpMarketplace,
} from '@/api/mcp'
import { fetchCapabilities, probeCapability } from '@/api/capabilities'
import {
  getToolMetrics,
  getToolPermissions,
  getToolCacheStats,
} from '@/api/tools-status'

function lastCall() {
  return mockFetch.mock.calls[mockFetch.mock.calls.length - 1]!
}

beforeEach(() => {
  vi.clearAllMocks()
  mockFetch.mockReset()
})

// ════════════════════════════════════════════════════════════════════════
// D-1 [中][契约不一致] setSkillEnabled 永远 success:true，吞掉 4xx 业务失败
//     位置: src/api/skills.ts:35-58
//     问题: catch 分支无条件返回 {success:true, source:'local-fallback'}。
//           当后端返回 404「技能未安装」或 400「非法技能名称」时（业务硬错误，
//           非网络不可达），前端依然显示"已应用（本地）"，并把无效状态写入
//           localStorage。SkillsView.toggleSkillEnabled 据此乐观更新 UI，
//           用户以为成功，实则后端拒绝。
//     根因: 用 try/catch 把"网络不可达"与"后端明确业务拒绝"混为一谈。
// ════════════════════════════════════════════════════════════════════════
describe('D-1 setSkillEnabled 把后端 404/400 业务拒绝伪装成本地成功', () => {
  it('[RED] 后端 404「技能未安装」应回报失败，不应 success:true', async () => {
    const err = Object.assign(new Error('技能未安装'), {
      response: { status: 404, _data: { error: '技能未安装' } },
      status: 404,
    })
    mockFetch.mockRejectedValueOnce(err)

    const res = await setSkillEnabled('not-installed', true)

    // 正确行为：后端明确拒绝（4xx）→ 不应宣称成功
    expect(res.success).toBe(false)
  })

  it('[GREEN] 网络不可达（无 HTTP 状态）→ 才降级本地 success:true / local-fallback', async () => {
    // 修复后：仅「网络不可达」（无 status）走本地降级；4xx 业务拒绝走 success:false（见上条 RED）。
    mockFetch.mockRejectedValueOnce(new Error('Failed to fetch'))
    const res = await setSkillEnabled('../evil', false)
    expect(res.success).toBe(true)
    expect(res.source).toBe('local-fallback')
    expect(res.enabled).toBe(false)
  })
})

// ════════════════════════════════════════════════════════════════════════
// D-2 [低][编码/对齐] installFromHub 拼 clawhub:// 前缀，但 installSkill(file)
//     位置: src/api/skills.ts:157-161 vs 22-27
//     问题: installFromHub 硬编码 source=`clawhub://${skillName}`，不做 encode。
//           若 hub 技能名含特殊字符（极少，但 hub 不禁止 display 名），URL/JSON
//           本身是 body 不是 URL 所以 JSON 安全；但与 installSkill(type) 显式
//           分流不一致——installFromHub 走"自动推断前缀"老路径，绕过 type 字段。
//     这里仅取证两条路径产生的 body 形态不同，便于后续统一。
// ════════════════════════════════════════════════════════════════════════
describe('D-2 安装技能两条路径 body 形态不一致（type 显式 vs 前缀推断）', () => {
  it('[GREEN 取证] installFromHub 走 clawhub:// 前缀、无 type 字段', async () => {
    mockFetch.mockResolvedValueOnce({})
    await installFromHub('my-skill')
    const [, opts] = lastCall()!
    expect(opts.body).toEqual({ source: 'clawhub://my-skill' })
    expect(opts.body.type).toBeUndefined()
  })

  it('[GREEN 取证] installSkill 走显式 type 字段', async () => {
    mockFetch.mockResolvedValueOnce({})
    await installSkill('/abs/path.md', 'file')
    const [, opts] = lastCall()!
    expect(opts.body).toEqual({ source: '/abs/path.md', type: 'file' })
  })
})

// ════════════════════════════════════════════════════════════════════════
// D-3 [中][契约缺口] MCP 市场「SSE-transport」条目无法安装
//     位置: src/views/McpView.vue:115-135 installFromMarketplace
//     问题: 判定逻辑 `if (entry.command?.trim())` → 有命令当 MCP server 走
//           addMcpServer；否则 fallback installFromHub(name)。
//           但后端 hub.SkillMeta 的 mcp 条目可能是 SSE transport（只有 endpoint，
//           command 为空）。这类 mcp 条目会 fallback 到 installFromHub →
//           后端 installSkillFromClawHub 检测 type==mcp → installMCPFromClawHubEntry
//           → validateMCPCommand(command="") 必然失败。
//     根因: 前端只支持 stdio(command) 安装路径，没有 endpoint 安装通道。
//     取证: searchMcpMarketplace 返回的条目类型里 command 是可选的，证明存在
//           command 缺失的合法 mcp 条目。
// ════════════════════════════════════════════════════════════════════════
describe('D-3 MCP 市场 command 可缺失（SSE 条目），前端安装路径不闭环', () => {
  it('[GREEN 取证] McpMarketplaceEntry.command 是可选字段', async () => {
    mockFetch.mockResolvedValueOnce({
      skills: [
        { name: 'sse-mcp', display_name: 'SSE MCP', description: '', version: '1',
          author: '', category: 'dev', tags: [], url: '', downloads: 0, rating: 0 },
      ],
      total: 1,
    })
    const res = await getMcpMarketplace()
    const entry = res.skills[0]!
    // command 缺失（SSE 条目）→ McpView 会 fallback installFromHub → 后端必失败
    expect(entry.command).toBeUndefined()
  })
})

// ════════════════════════════════════════════════════════════════════════
// D-4 [中][字段对齐] callMcpTool 与后端「错误用 HTTP 200 + {error}」契约
//     位置: 后端 handler_extended.go:161-166 — 工具执行失败仍 200 + {error}
//           前端 src/api/mcp.ts:30-32 — 检测 res.error 非空则 throw
//     这是双方刻意约定（业界 anti-pattern 但已对齐）。取证该契约成立，
//     并验证：当 result===undefined 且无 error 时前端补 result:null（防 NPE）。
// ════════════════════════════════════════════════════════════════════════
describe('D-4 callMcpTool 错误契约（200+error）+ undefined result 兜底', () => {
  it('[GREEN] 200 + {error} 被前端转成 throw', async () => {
    mockFetch.mockResolvedValueOnce({ error: '工具 "x" 执行失败: boom' })
    await expect(callMcpTool('x', {})).rejects.toThrow('执行失败')
  })

  it('[GREEN] result===undefined 且无 error → 兜底 result:null', async () => {
    mockFetch.mockResolvedValueOnce({ foo: 1 })
    const res = await callMcpTool('x', {})
    expect((res as { result: unknown }).result).toBeNull()
  })
})

// ════════════════════════════════════════════════════════════════════════
// D-5 [低][死代码/误导] types/mcp.ts McpServer 接口与任何后端响应都不对齐
//     位置: src/types/mcp.ts:9-17 (id/name/url/status/tools/connected_at/error)
//     问题: 后端 GET /mcp/servers 返回 {servers:string[]}；
//           GET /mcp/status 返回 {name,connected,tool_count}。
//           McpServer(id/url/connected_at) 没有任何后端字段对应，且全仓无消费方
//           （仅 export 透传）。是误导性死类型。
//     取证: getMcpServers 实际返回 string[]，与 McpServer[] 结构不兼容。
// ════════════════════════════════════════════════════════════════════════
describe('D-5 getMcpServers 返回 string[]，McpServer 接口是孤儿类型', () => {
  it('[GREEN 取证] servers 是字符串数组而非 McpServer 对象', async () => {
    mockFetch.mockResolvedValueOnce({ servers: ['fs', 'github'], total: 2 })
    const res = await getMcpServers()
    expect(res.servers.every((s) => typeof s === 'string')).toBe(true)
    // McpServer 接口要求 id/url/status/tools，后端一个都没给
    expect((res.servers as unknown[])[0]).not.toHaveProperty('id')
  })
})

// ════════════════════════════════════════════════════════════════════════
// D-6 [中][健壮性] getMcpServerStatus 双格式兼容，但 statuses 优先级可能掩盖
//     位置: src/api/mcp.ts:42-48 + McpView.vue:167-190 refreshServerStatuses
//     后端 handleMCPStatus(handler_extended.go:171) 实际只返回
//           {servers:[{name,connected,tool_count}], total}，从不返回 statuses map。
//     前端类型却把 statuses 列为可选首选分支。取证后端真实形态是 servers 数组，
//     statuses 分支是"假想契约"（永不命中），属冗余/误导。
// ════════════════════════════════════════════════════════════════════════
describe('D-6 MCP status 后端只发 servers 数组，statuses map 分支是死契约', () => {
  it('[GREEN 取证] 后端真实形态 = {servers:[{name,connected,tool_count}]}', async () => {
    mockFetch.mockResolvedValueOnce({
      servers: [{ name: 'fs', connected: true, tool_count: 3 }],
      total: 1,
    })
    const res = await getMcpServerStatus()
    expect(res.statuses).toBeUndefined()
    expect(Array.isArray(res.servers)).toBe(true)
    expect(res.servers![0]).toHaveProperty('tool_count')
  })
})

// ════════════════════════════════════════════════════════════════════════
// D-7 [中][字段对齐] fetchCapabilities 期望「裸数组」，与后端一致；但
//     toRecord 对 tool_call_text 缺失时降级 'unknown'，对 last_probe 不校验。
//     位置: src/api/capabilities.ts:32-48 + 后端 handler_capabilities.go:29-33
//     后端 nil→[] 已处理。取证：裸数组契约成立 + 字段映射正确（snake→camel）。
// ════════════════════════════════════════════════════════════════════════
describe('D-7 fetchCapabilities 裸数组契约 + snake_case→camelCase 映射', () => {
  it('[GREEN] 裸数组被正确映射；provider_name→providerName', async () => {
    mockFetch.mockResolvedValueOnce([
      { provider_name: 'OpenAI', model_name: 'gpt-4o', tool_call: 1,
        tool_call_text: 'good', last_probe: '2026-06-21T00:00:00Z' },
    ])
    const recs = await fetchCapabilities()
    expect(recs[0]).toMatchObject({
      providerName: 'OpenAI',
      modelName: 'gpt-4o',
      reliability: { level: 'good' },
    })
  })

  it('[GREEN] 后端返回 null（store 禁用）→ fetchCapabilities 不崩，返回 []', async () => {
    mockFetch.mockResolvedValueOnce(null)
    const recs = await fetchCapabilities()
    expect(recs).toEqual([])
  })
})

// ════════════════════════════════════════════════════════════════════════
// D-8 [中][对齐风险] probeCapability：provider 名编码进 query。
//     位置: src/api/capabilities.ts:51-59 + 后端 handler_capabilities.go:43-48
//     SettingsView.refreshCapability 传 pName = provider.backendKey||provider.name，
//     可能是中文「智谱」。前端 encodeURIComponent OK；但后端 selector.Get(pName)
//     若按英文 key 注册而前端传中文 name，会 400「provider 未加载」。
//     取证: probe 用 POST + query 且无 body；中文 provider 被正确百分号编码。
// ════════════════════════════════════════════════════════════════════════
describe('D-8 probeCapability POST+query 无 body，中文 provider 编码', () => {
  it('[GREEN] URL 含 encodeURIComponent 后的 provider/model，且 POST 无 body', async () => {
    mockFetch.mockResolvedValueOnce({
      provider_name: '智谱', model_name: 'glm-4', tool_call: 2,
      tool_call_text: 'partial', last_probe: '2026-06-21T00:00:00Z',
    })
    await probeCapability('智谱', 'glm-4')
    const [url, opts] = lastCall()!
    expect(url).toContain(`provider=${encodeURIComponent('智谱')}`)
    expect(url).toContain('model=glm-4')
    expect(opts.method).toBe('POST')
    // 无 body：后端只读 query，apiPost 不附 body
    expect(opts.body).toBeUndefined()
  })
})

// ════════════════════════════════════════════════════════════════════════
// D-9 [中][契约不一致] searchClawHub 错误处理 vs searchMcpMarketplace
//     位置: skills.ts:141-153 (检查 res.error 抛错) vs mcp.ts:83-90 (不检查 error)
//     后端 handleClawHubSearch 在目录拉取失败时返回 200 + {skills:[], error:'...'}。
//     skills.searchClawHub 会读 res.error 并 throw（UI 报错）；
//     但 mcp.searchMcpMarketplace/getMcpMarketplace 直接 return，忽略 error 字段
//     → MCP 市场目录拉取失败时静默显示空列表，用户无法区分"无结果"与"加载失败"。
//     根因: 两个调用方共享同一端点却对 error 字段处理不一致。
// ════════════════════════════════════════════════════════════════════════
describe('D-9 共享 clawhub/search 端点：skills 抛错，mcp 静默吞 error', () => {
  it('[GREEN] searchClawHub 遇 {error} 抛出', async () => {
    mockFetch.mockResolvedValueOnce({ skills: [], total: 0, error: '获取目录失败: timeout' })
    await expect(searchClawHub()).rejects.toThrow('获取目录失败')
  })

  it('[GREEN] getMcpMarketplace 在后端 {error} 非空时抛出（对齐 searchClawHub，不静默吞成空列表）', async () => {
    // 已修（mcp.ts throwIfHubError）：error 非空 → throw，让 UI 区分"无结果"与"加载失败"。
    mockFetch.mockResolvedValueOnce({ skills: [], total: 0, error: '获取目录失败: timeout' })
    await expect(getMcpMarketplace()).rejects.toThrow('获取目录失败')
  })
})

// ════════════════════════════════════════════════════════════════════════
// D-10 [低][编码] uninstallSkill / getSkillContent 对技能名 encodeURIComponent
//      位置: skills.ts:31, 167 + 后端 validSkillName(handler_skill_content.go:12)
//      取证: 含 '/'、空格、'#' 的技能名被正确编码进 path；'..' 由后端拒绝（前端不拦）。
// ════════════════════════════════════════════════════════════════════════
describe('D-10 技能名特殊字符 path 编码', () => {
  it('[GREEN] 空格/# 被 encodeURIComponent', async () => {
    mockFetch.mockResolvedValueOnce({})
    await uninstallSkill('my skill#1')
    const [url] = lastCall()!
    expect(url).toBe(`/api/v1/skills/${encodeURIComponent('my skill#1')}`)
  })

  it('[GREEN] getSkillContent 同样编码', async () => {
    mockFetch.mockResolvedValueOnce({ name: 'a', path: '/x', content: '' })
    await getSkillContent('a/b')
    const [url] = lastCall()!
    expect(url).toBe(`/api/v1/skills/${encodeURIComponent('a/b')}/content`)
  })

  it('[GREEN 取证] 前端不拦 ".."（依赖后端 validSkillName 拒绝）', async () => {
    mockFetch.mockResolvedValueOnce({})
    await uninstallSkill('../../etc/passwd')
    const [url] = lastCall()!
    // 前端照编码发出，纵深防御全靠后端
    expect(url).toContain(encodeURIComponent('../../etc/passwd'))
  })
})

// ════════════════════════════════════════════════════════════════════════
// D-11 [低][对齐] tools/metrics|permissions|cache/stats 字段映射
//      位置: tools-status.ts:54-66 + 后端 handler_tools.go
//      后端 handleToolMetrics 出错时返回 200+{tools:[],error}；
//      handleToolPermissions rules 可为对象数组。SettingsView 消费这三者。
//      取证: 字段直通（hit_rate / success_rate / avg_latency_ms / pattern / action）。
// ════════════════════════════════════════════════════════════════════════
describe('D-11 tools-status 三端点字段直通', () => {
  it('[GREEN] cache/stats 字段对齐', async () => {
    mockFetch.mockResolvedValueOnce({ entries: 2, hits: 8, misses: 2, hit_rate: 80 })
    const res = await getToolCacheStats()
    expect(res.hit_rate).toBe(80)
  })

  it('[GREEN] metrics 字段对齐', async () => {
    mockFetch.mockResolvedValueOnce({
      tools: [{ tool: 'read', call_count: 5, success_rate: 100, avg_latency_ms: 12, cached_count: 1 }],
    })
    const res = await getToolMetrics()
    expect(res.tools[0]!.avg_latency_ms).toBe(12)
  })

  it('[GREEN 取证] permissions.rules 可为 null（后端 toolPerms 无规则时）', async () => {
    mockFetch.mockResolvedValueOnce({ rules: null })
    const res = await getToolPermissions()
    expect(res.rules).toBeNull()
  })

  it('[GREEN] permissions.rules 对象数组 {pattern,action}', async () => {
    mockFetch.mockResolvedValueOnce({ rules: [{ pattern: 'rm *', action: 'deny' }] })
    const res = await getToolPermissions()
    expect(res.rules![0]).toEqual({ pattern: 'rm *', action: 'deny' })
  })
})

// ════════════════════════════════════════════════════════════════════════
// D-12 [中][防御] searchMcpMarketplace 对后端缺 skills 字段不健壮
//      位置: mcp.ts:83-85 — 直接 typed 返回 {skills, total}，不做 ?? []。
//      McpView.loadMarketplace 用 `res.skills || []` 兜底，但若直接调
//      searchMcpMarketplace（如未来组件）拿到 skills===undefined 会 NPE。
//      取证: 后端 skillHub==nil 时返回 {skills:[],total:0,source}，有 skills；
//      但若后端形态变更（如只发 source），前端类型撒谎（skills 非可选）。
// ════════════════════════════════════════════════════════════════════════
describe('D-12 searchMcpMarketplace 类型声明 skills 必填但运行期可能缺失', () => {
  it('[GREEN 取证] 后端缺 skills 字段时，类型欺骗（运行期 undefined）', async () => {
    mockFetch.mockResolvedValueOnce({ total: 0, source: 'clawhub' }) // 无 skills
    const res = await searchMcpMarketplace('x')
    // 类型说 skills: McpMarketplaceEntry[]，运行期却是 undefined → 调用方 .map 会崩
    expect((res as { skills?: unknown }).skills).toBeUndefined()
  })
})
