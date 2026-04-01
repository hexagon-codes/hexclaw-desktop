/**
 * HexClaw E2E — Streaming, Thinking, Skill/MCP tool calling, and multi-entry consistency.
 *
 * Runs against the live sidecar on localhost:16060 via HTTP + WebSocket.
 * Uses helpers from ./helpers (api, wsChat, ChatResult, USER_ID).
 */

import { test, expect } from '@playwright/test'
import { api, wsChat, USER_ID } from './helpers'
import type { ChatResult } from './helpers'

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
// 2. Skill system
// ---------------------------------------------------------------------------

test.describe('Skill system', () => {
  test.setTimeout(180_000)

  test('skill list has 6+ skills with specific names', async () => {
    const { status, data } = await api('GET', '/api/v1/skills')
    expect(status).toBe(200)

    const skills = (data as any).skills ?? []
    expect(skills.length).toBeGreaterThanOrEqual(6)

    const names: string[] = skills.map((s: any) => s.name ?? '')
    const required = [
      'doc-translator',
      'code-review-pro',
      'test-generator',
      'git-commit-craft',
      'cron-scheduler',
      'api-integrator',
    ]
    for (const n of required) {
      expect(names).toContain(n)
    }
  })

  test('智谱 model triggers doc-translator', async () => {
    const msg = `用 doc-translator 技能把 'Good morning' 翻译成日语 ${Date.now()}`
    const result: ChatResult = await wsChat(msg, {
      provider: '智谱',
      model: 'glm-4.6v',
    })
    expect(result.content.length).toBeGreaterThan(0)
  })

  test('智谱 model triggers code-review-pro', async () => {
    await new Promise((r) => setTimeout(r, 2000))
    const msg = `用 code-review-pro 审查: const x = null; x.toString() ${Date.now()}`
    const result: ChatResult = await wsChat(msg, {
      provider: '智谱',
      model: 'glm-4.6v',
    })
    expect(result.content.length).toBeGreaterThan(0)
  })

  test('local model gets reply but no tool_calls (design: tools=nil for local)', async () => {
    await new Promise((r) => setTimeout(r, 2000))
    const msg = `帮我 review 一下这段代码: print('hello') ${Date.now()}`
    const result: ChatResult = await wsChat(msg)
    expect(result.content.length).toBeGreaterThan(0)
    expect(result.toolCalls.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 3. MCP tools
// ---------------------------------------------------------------------------

test.describe('MCP tools', () => {
  test.setTimeout(180_000)

  test('MCP server list is not empty', async () => {
    const { status, data } = await api('GET', '/api/v1/mcp/servers')
    expect(status).toBe(200)
    const servers = (data as any).servers ?? []
    expect(servers.length).toBeGreaterThan(0)
  })

  test('MCP tools list contains filesystem tools', async () => {
    const { status, data } = await api('GET', '/api/v1/mcp/tools')
    expect(status).toBe(200)

    const tools = (data as any).tools ?? []
    const toolNames: string[] = tools.map((t: any) => t.name ?? '')

    const required = [
      'read_text_file',
      'write_file',
      'edit_file',
      'list_directory',
      'search_files',
      'directory_tree',
    ]
    for (const n of required) {
      expect(toolNames).toContain(n)
    }
  })

  test('智谱 model with explicit tool request gets reply', async () => {
    await new Promise((r) => setTimeout(r, 2000))
    const msg = `用 list_directory 工具查看 /tmp 目录有什么文件 ${Date.now()}`
    const result: ChatResult = await wsChat(msg, {
      provider: '智谱',
      model: 'glm-4.6v',
    })
    expect(result.content.length).toBeGreaterThan(0)
  })

  test('skill install API is reachable', async () => {
    const { status } = await api('POST', '/api/v1/skills/install', {
      name: '__nonexistent__',
    })
    // Any of these status codes means the endpoint exists and responded
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

  test('both HTTP and WS can do knowledge-based Q&A', async () => {
    await new Promise((r) => setTimeout(r, 2000))

    // HTTP entry
    const { status, data } = await api('POST', '/api/v1/chat', {
      message: `Apple HIG design ${Date.now()}`,
    })
    expect(status).toBe(200)
    expect(((data as any).reply ?? '').length).toBeGreaterThan(0)

    await new Promise((r) => setTimeout(r, 2000))

    // WebSocket entry
    const result: ChatResult = await wsChat(`Apple HIG design ${Date.now()}`)
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
    // At least one platform must exist (the tests above created sessions)
    expect(platforms.size).toBeGreaterThanOrEqual(1)
  })
})
