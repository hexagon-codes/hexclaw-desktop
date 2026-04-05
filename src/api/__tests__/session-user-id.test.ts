/**
 * Session user_id 一致性测试
 *
 * 验证所有会话相关 API 调用都正确传递 user_id，
 * 防止 "会话不属于当前用户" 错误复现。
 *
 * 背景:
 *   createSession() 曾遗漏 user_id 参数，导致后端创建会话时
 *   无法关联到 desktop-user，后续 chat/WS 操作携带 user_id 时
 *   后端校验所有权失败，报 "会话 xxx 不属于当前用户"。
 *   Agent 选择流程触发率更高，因为 ensureSession() 在 ChatView
 *   挂载时就会被调用（而非首条消息发送时）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const EXPECTED_USER_ID = 'desktop-user'

// ─── Mock ofetch ────────────────────────────────────
const mockFetch = vi.hoisted(() => vi.fn())
vi.mock('ofetch', () => ({
  ofetch: {
    create: () => mockFetch,
  },
}))

// ─── Mock Tauri invoke (for sendChatViaBackend) ─────
const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import {
  listSessions,
  getSession,
  createSession,
  updateSessionTitle,
  deleteSession,
  forkSession,
  getSessionBranches,
  listSessionMessages,
  searchMessages,
  updateMessageFeedback,
  sendChatViaBackend,
} from '../chat'

// ─── 辅助函数 ────────────────────────────────────────

/** 提取 mockFetch 调用中的 query 参数 */
function getQueryArg(): Record<string, unknown> | undefined {
  return mockFetch.mock.calls[0]?.[1]?.query
}

/** 提取 mockFetch 调用中的 body 参数 */
function getBodyArg(): Record<string, unknown> | undefined {
  return mockFetch.mock.calls[0]?.[1]?.body
}

/** 提取 invoke 调用中的 params */
function getInvokeParams(): Record<string, unknown> | undefined {
  return invoke.mock.calls[0]?.[1]?.params
}

// ─── 测试 ────────────────────────────────────────────

describe('Session user_id 一致性', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetch.mockReset()
    invoke.mockReset()
  })

  // ── 修复前: createSession 缺失 user_id (回归保护) ──

  describe('createSession — 核心修复点', () => {
    it('POST body 必须包含 user_id', async () => {
      mockFetch.mockResolvedValue({ id: 's1', title: 'Test', created_at: '2024-01-01' })
      await createSession('s1', 'Test')

      const body = getBodyArg()
      expect(body).toBeDefined()
      expect(body!.user_id).toBe(EXPECTED_USER_ID)
    })

    it('user_id 值必须是 desktop-user 而非空字符串', async () => {
      mockFetch.mockResolvedValue({ id: 's2', title: '', created_at: '2024-01-01' })
      await createSession('s2', '')

      const body = getBodyArg()
      expect(body!.user_id).toBe(EXPECTED_USER_ID)
      expect(body!.user_id).not.toBe('')
      expect(body!.user_id).not.toBeNull()
      expect(body!.user_id).not.toBeUndefined()
    })

    it('Agent 场景: 自定义标题的会话也包含 user_id', async () => {
      mockFetch.mockResolvedValue({ id: 'agent-1', title: '代码助手', created_at: '2024-01-01' })
      await createSession('agent-1', '代码助手')

      const body = getBodyArg()
      expect(body).toEqual({
        id: 'agent-1',
        title: '代码助手',
        user_id: EXPECTED_USER_ID,
      })
    })
  })

  // ── 会话查询类 API: 必须携带 user_id ──

  describe('listSessions', () => {
    it('query 包含 user_id', async () => {
      mockFetch.mockResolvedValue({ sessions: [], total: 0 })
      await listSessions()
      expect(getQueryArg()!.user_id).toBe(EXPECTED_USER_ID)
    })
  })

  describe('getSession', () => {
    it('query 包含 user_id', async () => {
      mockFetch.mockResolvedValue({ id: 's1', title: 'Test' })
      await getSession('s1')
      expect(getQueryArg()!.user_id).toBe(EXPECTED_USER_ID)
    })
  })

  describe('listSessionMessages', () => {
    it('query 包含 user_id', async () => {
      mockFetch.mockResolvedValue({ messages: [], total: 0 })
      await listSessionMessages('s1')
      expect(getQueryArg()!.user_id).toBe(EXPECTED_USER_ID)
    })

    it('分页参数不影响 user_id', async () => {
      mockFetch.mockResolvedValue({ messages: [], total: 0 })
      await listSessionMessages('s1', { limit: 50, offset: 10 })
      const q = getQueryArg()!
      expect(q.user_id).toBe(EXPECTED_USER_ID)
      expect(q.limit).toBe(50)
      expect(q.offset).toBe(10)
    })
  })

  describe('getSessionBranches', () => {
    it('query 包含 user_id', async () => {
      mockFetch.mockResolvedValue({ branches: [] })
      await getSessionBranches('s1')
      expect(getQueryArg()!.user_id).toBe(EXPECTED_USER_ID)
    })
  })

  describe('searchMessages', () => {
    it('query 包含 user_id', async () => {
      mockFetch.mockResolvedValue({ results: [], total: 0, query: 'test' })
      await searchMessages('test')
      expect(getQueryArg()!.user_id).toBe(EXPECTED_USER_ID)
    })
  })

  // ── 会话变更类 API: body 必须携带 user_id ──

  describe('updateSessionTitle', () => {
    it('body 包含 user_id', async () => {
      mockFetch.mockResolvedValue({ id: 's1', title: 'Updated', updated_at: '2024-01-01' })
      await updateSessionTitle('s1', 'Updated')
      expect(getBodyArg()!.user_id).toBe(EXPECTED_USER_ID)
    })
  })

  describe('forkSession', () => {
    it('body 包含 user_id', async () => {
      mockFetch.mockResolvedValue({ session: { id: 's2' }, message: 'forked' })
      await forkSession('s1', 'msg-1')
      expect(getBodyArg()!.user_id).toBe(EXPECTED_USER_ID)
    })
  })

  describe('updateMessageFeedback', () => {
    it('body 包含 user_id', async () => {
      mockFetch.mockResolvedValue({ message: 'ok' })
      await updateMessageFeedback('msg-1', 'like')
      expect(getBodyArg()!.user_id).toBe(EXPECTED_USER_ID)
    })
  })

  // ── Tauri invoke 通道 ──

  describe('sendChatViaBackend', () => {
    it('params 包含 user_id', async () => {
      invoke.mockResolvedValue('{"reply":"ok","session_id":"s1"}')
      await sendChatViaBackend('hello', { sessionId: 's1' })
      expect(getInvokeParams()!.user_id).toBe(EXPECTED_USER_ID)
    })

    it('即使不传 options 也包含 user_id', async () => {
      invoke.mockResolvedValue('{"reply":"ok","session_id":"s1"}')
      await sendChatViaBackend('hello')
      expect(getInvokeParams()!.user_id).toBe(EXPECTED_USER_ID)
    })
  })

  // ── 端到端场景: Agent 选择流程 ──

  describe('Agent 选择流程 — 完整链路', () => {
    it('新建 Agent 会话 → 发送消息: user_id 全链路一致', async () => {
      // Step 1: 前端 ensureSession → createSession
      mockFetch.mockResolvedValue({ id: 'agent-session', title: '翻译助手', created_at: '2024-01-01' })
      await createSession('agent-session', '翻译助手')

      const createBody = getBodyArg()!
      expect(createBody.user_id).toBe(EXPECTED_USER_ID)

      // Step 2: 发送消息 → backend_chat
      invoke.mockResolvedValue('{"reply":"你好","session_id":"agent-session"}')
      await sendChatViaBackend('translate this', { sessionId: 'agent-session', role: 'translator' })

      const chatParams = getInvokeParams()!
      expect(chatParams.user_id).toBe(EXPECTED_USER_ID)
      expect(chatParams.session_id).toBe('agent-session')

      // 关键断言: 创建和聊天使用的 user_id 必须一致
      expect(createBody.user_id).toBe(chatParams.user_id)
    })

    it('复用已有 Agent 会话 → 加载消息: user_id 一致', async () => {
      // Step 1: selectSession → listSessionMessages
      mockFetch.mockResolvedValue({ messages: [], total: 0 })
      await listSessionMessages('existing-agent-session')

      const loadQuery = getQueryArg()!
      expect(loadQuery.user_id).toBe(EXPECTED_USER_ID)

      // Step 2: 发送消息
      mockFetch.mockReset()
      invoke.mockResolvedValue('{"reply":"ok","session_id":"existing-agent-session"}')
      await sendChatViaBackend('hello', { sessionId: 'existing-agent-session', role: 'coder' })

      const chatParams = getInvokeParams()!
      expect(chatParams.user_id).toBe(loadQuery.user_id)
    })
  })

  // ── 防御性测试: 确保没有遗漏 ──

  describe('全量覆盖 — 所有会话/消息 API 均携带 user_id', () => {
    const sessionApis = [
      { name: 'listSessions', call: () => listSessions(), check: 'query' },
      { name: 'getSession', call: () => getSession('s1'), check: 'query' },
      { name: 'createSession', call: () => createSession('s1', 'T'), check: 'body' },
      { name: 'updateSessionTitle', call: () => updateSessionTitle('s1', 'T'), check: 'body' },
      { name: 'listSessionMessages', call: () => listSessionMessages('s1'), check: 'query' },
      { name: 'getSessionBranches', call: () => getSessionBranches('s1'), check: 'query' },
      { name: 'forkSession', call: () => forkSession('s1'), check: 'body' },
      { name: 'searchMessages', call: () => searchMessages('q'), check: 'query' },
      { name: 'updateMessageFeedback', call: () => updateMessageFeedback('m1', 'like'), check: 'body' },
    ] as const

    for (const { name, call, check } of sessionApis) {
      it(`${name}() 的 ${check} 包含 user_id = '${EXPECTED_USER_ID}'`, async () => {
        mockFetch.mockResolvedValue({ sessions: [], total: 0, messages: [], branches: [], results: [], message: 'ok', query: 'q', id: 's1', title: 'T', created_at: '', updated_at: '' })
        await call()

        const arg = check === 'query' ? getQueryArg() : getBodyArg()
        expect(arg, `${name}() 的 ${check} 参数不应为 undefined`).toBeDefined()
        expect(arg!.user_id, `${name}() 缺少 user_id`).toBe(EXPECTED_USER_ID)
      })
    }
  })

  // ── 静态分析: 防止绕过 sessionGet/sessionPost 直接调用 apiGet/apiPost ──

  describe('结构性防护 — chat.ts 会话区不应直接调用裸 apiGet/apiPost', () => {
    it('Session Management 区域使用 sessionGet/sessionPost 而非 apiGet/apiPost', async () => {
      const fs = await import('node:fs')
      const path = await import('node:path')
      const source = fs.readFileSync(path.resolve(process.cwd(), 'src/api/chat.ts'), 'utf-8')

      // 提取 "Session Fork" 之后的所有代码（即会话管理区域）
      const sessionSection = source.slice(source.indexOf('// ============== Session Fork'))

      // 在会话区域中，不应直接使用 apiGet/apiPost/apiPatch/apiPut（apiDelete 除外，因为不需要 body/query）
      const bareApiCalls = sessionSection.match(/\bapiGet\b|\bapiPost\b|\bapiPatch\b|\bapiPut\b/g) || []
      expect(
        bareApiCalls,
        `会话 API 区域发现直接调用 ${bareApiCalls.join(', ')}，应改用 sessionGet/sessionPost/sessionPatch/sessionPut 以自动注入 user_id`,
      ).toEqual([])
    })
  })
})
