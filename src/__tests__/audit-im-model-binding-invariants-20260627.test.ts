/* eslint-disable */
/**
 * IM 频道模型绑定 — 结构不变量守卫（hex-test 必跑，2026-06-27）
 *
 * 运行于 desktop `vitest` 伞 gate = 自动每轮必跑。锁两条核心设计决策，防回退 + 防扩散：
 *
 *  ① 单一真相源：hexclaw routing Rule **不得**加 model/provider 字段。频道默认模型只能经
 *     匿名 Agent `@im/<platform>` 承载，避免「频道绑的模型」vs「Agent 偏好模型」双真相源冲突。
 *
 *  ② 举一反三（本轮真 bug 的回归锁）：所有「列 agents 给用户看/选」的前端站点都必须经【单一
 *     可见性边界】`userVisibleAgents()` 剔除匿名 `@im/*` Agent，否则匿名 Agent 泄漏进 Agent 管理页 /
 *     路由规则下拉 / 聊天 Agent 选择器。过去各站点各自手写 `.filter(!isChannelDefaultAgent)`，散落
 *     易漏一处（AP-108 根因）；现收敛为单一 `userVisibleAgents` 边界。本守卫**穷举**所有 getAgents
 *     调用点 —— 新增站点未经 `userVisibleAgents` 即自动 FAIL（粒度匹配）。
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

const SRC = path.resolve(__dirname, '..')
const HEXCLAW = '/Users/hexagon/work/hexclaw'

function read(p: string): string {
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : ''
}

function walk(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '__tests__') continue
      out.push(...walk(path.join(dir, e.name)))
    } else if (/\.(vue|ts)$/.test(e.name)) {
      out.push(path.join(dir, e.name))
    }
  }
  return out
}

describe('[invariant] IM 频道默认模型 — 单一真相源', () => {
  it('① hexclaw routing Rule 不得含 model/provider 字段（频道默认模型只能经匿名 Agent 承载）', () => {
    const src = read(path.join(HEXCLAW, 'router/agent_router.go'))
    if (!src) return // 后端不可读（CI 无 hexclaw 仓）时跳过，本地必跑
    const m = src.match(/type Rule struct \{[\s\S]*?\n\}/)
    expect(m, 'Rule struct 应存在').toBeTruthy()
    const ruleBlock = m![0]
    expect(/\bmodel\b/i.test(ruleBlock), `Rule 不应有 model 字段:\n${ruleBlock}`).toBe(false)
    expect(/\bprovider\b/i.test(ruleBlock), `Rule 不应有 provider 字段:\n${ruleBlock}`).toBe(false)
  })
})

describe('[invariant] 匿名 @im/* Agent 必须经单一可见性边界 userVisibleAgents（集中过滤·举一反三回归锁）', () => {
  it('每个调用 getAgents 的前端站点都必须经 userVisibleAgents（散落内联过滤已收敛为单一边界）', () => {
    // 穷举所有调用 getAgents 的源文件（排除 api 定义本身 + 边界 util 本体 + 测试目录）。
    const WHITELIST_NO_FILTER: string[] = [
      // 此处登记「确实调用 getAgents 但无需过滤」的站点（如纯计数/纯解析用途），附理由。
      // 孤儿 IMChannelsView.vue 已连同其绑定 UI 一并清退（迁至活组件 ChannelAgentBinding.vue，经
      //   userVisibleAgents）——AP-138 收口，当前无豁免项；新增站点未经 userVisibleAgents 即 FAIL。
    ]
    const sites = walk(SRC).filter((f) => {
      const rel = f.slice(SRC.length)
      if (rel.endsWith('/api/agents.ts')) return false
      if (rel.endsWith('/utils/imChannelBinding.ts')) return false // 边界本体（userVisibleAgents 的家）
      return /\bgetAgents\s*\(/.test(read(f))
    })

    expect(sites.length, '应能扫到若干 getAgents 站点').toBeGreaterThan(0)

    const missing = sites
      .filter((f) => !WHITELIST_NO_FILTER.some((w) => f.endsWith(w)))
      .filter((f) => !/\buserVisibleAgents\s*\(/.test(read(f)))
      .map((f) => f.slice(SRC.length))

    expect(
      missing,
      `以下站点列 agents 却未经单一边界 userVisibleAgents（会泄漏匿名 @im/* 进用户列表）：\n${missing.join('\n')}\n` +
        `→ 把列表过滤改为 userVisibleAgents(agents)（来自 @/utils/imChannelBinding），禁止再手写散落的 ` +
        `.filter((a) => !isChannelDefaultAgent(a.name))；或登记进 WHITELIST_NO_FILTER 并注明理由`,
    ).toEqual([])
  })
})
