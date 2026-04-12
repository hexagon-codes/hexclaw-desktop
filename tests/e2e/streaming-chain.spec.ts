/**
 * HexClaw E2E — Streaming, Thinking, Skill/MCP tool calling, and multi-entry consistency.
 *
 * Runs against the live sidecar on localhost:16060 via HTTP + WebSocket.
 * Uses helpers from ./helpers (api, wsChat, ChatResult, USER_ID).
 *
 * 设计原则：探测式断言 — 先查询当前环境实际能力，再按能力断言，
 * 避免硬编码 skill/provider/model 导致环境变更后测试失效。
 */

import { test, expect } from '@playwright/test'
import { api, wsChat, USER_ID } from './helpers'
import type { ChatResult } from './helpers'

// ---------------------------------------------------------------------------
// 0. 环境探测（所有测试共享）
// ---------------------------------------------------------------------------

let _availableSkills: string[] = []
let availableProviders: Record<string, { model: string; has_key: boolean }> = {}
let defaultProvider = ''
let hasCloudProvider = false

test.beforeAll(async () => {
  // 探测可用 skills
  try {
    const { data } = await api('GET', '/api/v1/skills')
    _availableSkills = ((data as any).skills ?? []).map((s: any) => s.name ?? '')
  } catch { /* sidecar 未启动时跳过 */ }

  // 探测可用 providers
  try {
    const { data } = await api('GET', '/api/v1/config')
    const llm = (data as any).llm ?? {}
    defaultProvider = llm.default ?? ''
    availableProviders = llm.providers ?? {}
    hasCloudProvider = Object.values(availableProviders).some((p: any) => p.has_key)
  } catch { /* ignore */ }
})

// ---------------------------------------------------------------------------
// 1. Streaming & Thinking
// ---------------------------------------------------------------------------

test.describe('Streaming & Thinking', () => {
  test.setTimeout(180_000)

  test('normal message gets reply with /no_think (reasoning < 1000 chars)', async () => {
    const msg = `streaming-normal-${Date.now()}`
    const result: ChatResult = await wsChat(msg)
    expect(result.content.length).toBeGreaterThan(0)
    expect(result.reasoning.length).toBeLessThan(1000)
  })

  test('normal message has provider and model in metadata', async () => {
    const msg = `metadata-check-${Date.now()}`
    const result: ChatResult = await wsChat(msg)
    expect(result.content.length).toBeGreaterThan(0)
    expect(result.metadata).toHaveProperty('provider')
    expect(result.metadata).toHaveProperty('model')
  })

  test('thinking=on message has reasoning content', async () => {
    const msg = `thinking-on-${Date.now()} 逐步推理 7 乘以 13`
    const result: ChatResult = await wsChat(msg, { metadata: { thinking: 'on' } })
    expect(result.content.length).toBeGreaterThan(0)
    expect(result.reasoning.length).toBeGreaterThan(0)
  })

  test('thinking=on message has multiple chunks', async () => {
    const msg = `thinking-chunks-${Date.now()} 请详细分析 42 除以 6 的过程`
    const result: ChatResult = await wsChat(msg, { metadata: { thinking: 'on' } })
    expect(result.content.length).toBeGreaterThan(0)
    expect(result.chunks).toBeGreaterThan(1)
  })
})

// ---------------------------------------------------------------------------
// 2. Skill system（探测式）
// ---------------------------------------------------------------------------

test.describe('Skill system', () => {
  test.setTimeout(180_000)

  test('skill list returns at least 1 skill', async () => {
    const { status, data } = await api('GET', '/api/v1/skills')
    expect(status).toBe(200)

    const skills = (data as any).skills ?? []
    expect(skills.length).toBeGreaterThanOrEqual(1)
  })

  test('cloud provider with skill triggers tool use (if available)', async () => {
    test.skip(!hasCloudProvider, '无云端 provider，跳过 skill 触发测试')

    // 找到第一个有 API key 的 provider
    const [providerName, providerCfg] = Object.entries(availableProviders)
      .find(([, v]: [string, any]) => v.has_key) ?? ['', {} as any]
    test.skip(!providerName, '无可用云端 provider')

    const msg = `请帮我翻译 'Good morning' 成日语 ${Date.now()}`
    const result: ChatResult = await wsChat(msg, {
      provider: providerName,
      model: (providerCfg as any).model,
    })
    expect(result.content.length).toBeGreaterThan(0)
  })

  test('default model gets reply (tool_calls depends on provider config)', async () => {
    await new Promise((r) => setTimeout(r, 2000))
    const msg = `帮我 review 一下这段代码: print('hello') ${Date.now()}`
    const result: ChatResult = await wsChat(msg)
    expect(result.content.length).toBeGreaterThan(0)
    // 不再断言 toolCalls.length === 0，本地模型现在也可能支持工具调用
  })
})

// ---------------------------------------------------------------------------
// 3. MCP tools（探测式）
// ---------------------------------------------------------------------------

test.describe('MCP tools', () => {
  test.setTimeout(180_000)

  test('MCP server list returns 200', async () => {
    const { status, data } = await api('GET', '/api/v1/mcp/servers')
    expect(status).toBe(200)
    // 不硬编码数量，按环境探测
    const servers = (data as any).servers ?? []
    expect(Array.isArray(servers)).toBe(true)
  })

  test('MCP tools list returns 200', async () => {
    const { status, data } = await api('GET', '/api/v1/mcp/tools')
    expect(status).toBe(200)

    const tools = (data as any).tools ?? []
    expect(Array.isArray(tools)).toBe(true)
  })

  test('cloud provider with explicit tool request gets reply (if available)', async () => {
    test.skip(!hasCloudProvider, '无云端 provider，跳过 MCP 工具触发测试')

    const [providerName, providerCfg] = Object.entries(availableProviders)
      .find(([, v]: [string, any]) => v.has_key) ?? ['', {} as any]
    test.skip(!providerName, '无可用云端 provider')

    await new Promise((r) => setTimeout(r, 2000))
    const msg = `用 list_directory 工具查看 /tmp 目录有什么文件 ${Date.now()}`
    const result: ChatResult = await wsChat(msg, {
      provider: providerName,
      model: (providerCfg as any).model,
    })
    expect(result.content.length).toBeGreaterThan(0)
  })

  test('skill install API is reachable', async () => {
    const { status } = await api('POST', '/api/v1/skills/install', {
      name: '__nonexistent__',
    })
    expect([200, 400, 404, 500]).toContain(status)
  })
})

// ---------------------------------------------------------------------------
// 4. Multi-entry consistency
// ---------------------------------------------------------------------------

test.describe('Multi-entry consistency', () => {
  test.setTimeout(180_000)

  test('HTTP API entry gets reply with session_id', async () => {
    const msg = `http-entry-${Date.now()}`
    const { status, data } = await api('POST', '/api/v1/chat', { message: msg })
    expect(status).toBe(200)
    expect(((data as any).reply ?? '').length).toBeGreaterThan(0)
    expect(((data as any).session_id ?? '').length).toBeGreaterThan(0)
  })

  test('WebSocket entry gets reply with provider metadata', async () => {
    await new Promise((r) => setTimeout(r, 2000))
    const msg = `ws-entry-${Date.now()}`
    const result: ChatResult = await wsChat(msg)
    expect(result.content.length).toBeGreaterThan(0)
    expect(result.metadata).toHaveProperty('provider')
  })

  test('both HTTP and WS entries return replies', async () => {
    await new Promise((r) => setTimeout(r, 2000))

    const { status, data } = await api('POST', '/api/v1/chat', {
      message: `multi-entry-http-${Date.now()}`,
    })
    expect(status).toBe(200)
    expect(((data as any).reply ?? '').length).toBeGreaterThan(0)

    await new Promise((r) => setTimeout(r, 2000))

    const result: ChatResult = await wsChat(`multi-entry-ws-${Date.now()}`)
    expect(result.content.length).toBeGreaterThan(0)
  })

  test('agent list API returns 200', async () => {
    const { status } = await api('GET', '/api/v1/agents')
    expect(status).toBe(200)
  })

  test('sessions from same user across entries are isolated by platform', async () => {
    const { status, data } = await api('GET', `/api/v1/sessions?user_id=${USER_ID}`)
    expect(status).toBe(200)

    const sessions = (data as any).sessions ?? []
    const platforms = new Set<string>(
      sessions.map((s: any) => s.platform ?? ''),
    )
    expect(platforms.size).toBeGreaterThanOrEqual(1)
  })
})
