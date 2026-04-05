/**
 * 证明测试: createSession 缺失 user_id 导致 "会话不属于当前用户"
 *
 * 本文件通过模拟完整调用链，证明:
 *   1. 修复前: createSession 发出的请求 body 没有 user_id → 后端创建的会话归属空用户
 *      → 后续 chat 请求携带 user_id="desktop-user" → 后端校验失败
 *   2. 修复后: createSession body 携带 user_id="desktop-user" → 全链路一致 → 无报错
 *
 * 调用链路 (Agent 选择场景):
 *   ChatView.vue:340  →  chatStore.ensureSession()
 *   chat.ts:157       →  msgSvc.createSession(id, title)
 *   chat.ts:126       →  apiPost('/api/v1/sessions', { id, title, user_id })   ← 修复点
 *   (后端)             →  INSERT sessions SET user_id = ?
 *   ---
 *   chat.ts:319       →  ensureSession() 返回 sessionId
 *   chat.ts:332       →  chatSvc.sendViaBackend(text, sessionId, ...)
 *   chat.ts:46        →  invoke('backend_chat', { params: { session_id, user_id: 'desktop-user' } })
 *   commands.rs:322   →  POST /api/v1/chat { session_id, user_id: "desktop-user" }
 *   (后端)             →  SELECT user_id FROM sessions WHERE id = ?
 *                         IF session.user_id != request.user_id → 403 "不属于当前用户"
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Mock 基础设施 ────────────────────────────────────

/** 记录所有发往后端的请求，模拟后端行为 */
interface BackendRequest {
  method: string
  url: string
  body?: Record<string, unknown>
  query?: Record<string, unknown>
}

const requests: BackendRequest[] = []

/** 模拟后端数据库: sessions 表 */
const sessionsDB: Map<string, { id: string; user_id: string | null; title: string }> = new Map()

/** 模拟后端行为: 创建会话时存储 user_id，查询时校验 */
function simulateBackend(req: BackendRequest): unknown {
  // POST /api/v1/sessions → 创建会话
  if (req.method === 'POST' && req.url === '/api/v1/sessions') {
    const { id, title, user_id } = req.body as { id: string; title: string; user_id?: string }
    sessionsDB.set(id, { id, title, user_id: user_id ?? null })
    return { id, title, created_at: new Date().toISOString() }
  }

  // POST /api/v1/chat → 发送消息 (校验 session 归属)
  if (req.method === 'POST' && req.url === '/api/v1/chat') {
    const { session_id, user_id } = req.body as { session_id: string; user_id: string }
    const session = sessionsDB.get(session_id)
    if (!session) {
      throw new Error(`会话管理失败: 会话 ${session_id} 不存在`)
    }
    if (session.user_id !== null && session.user_id !== user_id) {
      throw new Error(`会话管理失败: 会话 ${session_id} 不属于当前用户`)
    }
    if (session.user_id === null && user_id) {
      // 后端严格模式: 会话没有 user_id 时拒绝带 user_id 的请求
      throw new Error(`会话管理失败: 会话 ${session_id} 不属于当前用户`)
    }
    return { reply: 'ok', session_id }
  }

  // GET /api/v1/sessions/:id/messages → 加载消息 (校验 session 归属)
  if (req.method === 'GET' && req.url.match(/\/api\/v1\/sessions\/[^/]+\/messages/)) {
    const sessionId = req.url.split('/')[4]!
    const session = sessionsDB.get(sessionId)
    if (!session) throw new Error(`会话 ${sessionId} 不存在`)
    const queryUserId = req.query?.user_id as string | undefined
    if (session.user_id !== null && queryUserId && session.user_id !== queryUserId) {
      throw new Error(`会话管理失败: 会话 ${sessionId} 不属于当前用户`)
    }
    return { messages: [], total: 0 }
  }

  return {}
}

// Mock ofetch — 拦截所有 HTTP 请求
const mockFetch = vi.hoisted(() => vi.fn())
vi.mock('ofetch', () => ({
  ofetch: {
    create: () => mockFetch,
  },
}))

// Mock Tauri invoke
const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import {
  createSession,
  listSessionMessages,
  sendChatViaBackend,
} from '../chat'

// ─── 测试 ────────────────────────────────────────────

describe('证明: createSession user_id 修复', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requests.length = 0
    sessionsDB.clear()

    // mockFetch 记录请求并走模拟后端
    mockFetch.mockImplementation((url: string, opts: Record<string, unknown>) => {
      const req: BackendRequest = {
        method: (opts.method as string) || 'GET',
        url,
        body: opts.body as Record<string, unknown> | undefined,
        query: opts.query as Record<string, unknown> | undefined,
      }
      requests.push(req)
      return Promise.resolve(simulateBackend(req))
    })

    // invoke → 转换为模拟后端请求
    invoke.mockImplementation((_cmd: string, args: { params: Record<string, unknown> }) => {
      const p = args.params
      const req: BackendRequest = {
        method: 'POST',
        url: '/api/v1/chat',
        body: {
          message: p.message,
          session_id: p.session_id,
          user_id: p.user_id || 'desktop-user',
        },
      }
      requests.push(req)
      const result = simulateBackend(req)
      return Promise.resolve(JSON.stringify(result))
    })
  })

  // ═══════════════════════════════════════════════════
  // 修复前: 复现 bug
  // ═══════════════════════════════════════════════════

  describe('修复前行为 (模拟旧代码)', () => {
    /** 模拟旧版 createSession —— 不传 user_id */
    async function createSessionOld(id: string, title: string) {
      return mockFetch('/api/v1/sessions', {
        method: 'POST',
        body: { id, title },  // ← 没有 user_id
      })
    }

    it('旧代码: createSession 不携带 user_id', async () => {
      await createSessionOld('NwukSmk6yuiX', '翻译助手')

      // 验证请求中没有 user_id
      const createReq = requests.find((r) => r.url === '/api/v1/sessions')!
      expect(createReq.body!.user_id).toBeUndefined()

      // 验证数据库中会话的 user_id 为 null
      const session = sessionsDB.get('NwukSmk6yuiX')!
      expect(session.user_id).toBeNull()
    })

    it('旧代码: 创建会话后发送消息 → 触发 "不属于当前用户"', async () => {
      // Step 1: 旧版 createSession（无 user_id）
      await createSessionOld('NwukSmk6yuiX', '翻译助手')

      // Step 2: 发送消息（携带 user_id="desktop-user"）
      await expect(
        sendChatViaBackend('你好', { sessionId: 'NwukSmk6yuiX' }),
      ).rejects.toThrow('不属于当前用户')
    })

    it('旧代码: Agent 场景完整链路 → 后端拒绝', async () => {
      // 模拟 ChatView.vue:338-341 Agent 新建会话流程
      // chatStore.newSession('代码助手')
      // await chatStore.ensureSession() → createSession(id, title)
      await createSessionOld('AgentSess001', '代码助手')

      // 数据库状态: 会话存在但无归属
      expect(sessionsDB.get('AgentSess001')!.user_id).toBeNull()

      // 用户输入消息 → sendMessage → backend_chat
      // commands.rs:322 会注入 user_id: "desktop-user"
      await expect(
        sendChatViaBackend('帮我写个函数', { sessionId: 'AgentSess001', role: 'coder' }),
      ).rejects.toThrow('不属于当前用户')
    })
  })

  // ═══════════════════════════════════════════════════
  // 修复后: 验证正确性
  // ═══════════════════════════════════════════════════

  describe('修复后行为 (当前代码)', () => {
    it('新代码: createSession 携带 user_id', async () => {
      await createSession('NwukSmk6yuiX', '翻译助手')

      // 验证请求中包含 user_id
      const createReq = requests.find((r) => r.url === '/api/v1/sessions')!
      expect(createReq.body!.user_id).toBe('desktop-user')

      // 验证数据库中会话归属正确
      const session = sessionsDB.get('NwukSmk6yuiX')!
      expect(session.user_id).toBe('desktop-user')
    })

    it('新代码: 创建会话后发送消息 → 正常返回', async () => {
      // Step 1: 修复后的 createSession（含 user_id）
      await createSession('NwukSmk6yuiX', '翻译助手')

      // Step 2: 发送消息（携带相同的 user_id）
      const result = await sendChatViaBackend('你好', { sessionId: 'NwukSmk6yuiX' })
      expect(result.reply).toBe('ok')
      expect(result.session_id).toBe('NwukSmk6yuiX')
    })

    it('新代码: Agent 场景完整链路 → 正常运行', async () => {
      // 模拟 ChatView.vue Agent 新建会话流程
      await createSession('AgentSess001', '代码助手')

      // 数据库状态: 会话归属正确
      expect(sessionsDB.get('AgentSess001')!.user_id).toBe('desktop-user')

      // 用户发送消息 → 不再报错
      const result = await sendChatViaBackend('帮我写个函数', {
        sessionId: 'AgentSess001',
        role: 'coder',
      })
      expect(result.reply).toBe('ok')
    })

    it('新代码: 加载消息也携带 user_id，全链路一致', async () => {
      // 创建会话
      await createSession('sess-abc', '测试会话')

      // 加载消息历史
      await listSessionMessages('sess-abc')

      // 验证两个请求都携带了相同的 user_id
      const createReq = requests.find((r) => r.url === '/api/v1/sessions')!
      const loadReq = requests.find((r) => r.url.includes('/messages'))!

      expect(createReq.body!.user_id).toBe('desktop-user')
      expect(loadReq.query!.user_id).toBe('desktop-user')
    })
  })

  // ═══════════════════════════════════════════════════
  // 对比: 新旧行为差异
  // ═══════════════════════════════════════════════════

  describe('新旧对比: 同一操作序列的不同结果', () => {
    it('相同的 Agent 操作序列: 旧代码抛异常, 新代码正常', async () => {
      // ── 旧代码路径 ──
      sessionsDB.clear()
      // 旧版创建 (无 user_id)
      await mockFetch('/api/v1/sessions', {
        method: 'POST',
        body: { id: 'old-sess', title: 'Agent' },
      })
      // 旧版发消息 → 失败
      let oldError: Error | null = null
      try {
        await sendChatViaBackend('hello', { sessionId: 'old-sess' })
      } catch (e) {
        oldError = e as Error
      }
      expect(oldError).not.toBeNull()
      expect(oldError!.message).toContain('不属于当前用户')

      // ── 新代码路径 ──
      sessionsDB.clear()
      requests.length = 0
      // 新版创建 (含 user_id)
      await createSession('new-sess', 'Agent')
      // 新版发消息 → 成功
      const result = await sendChatViaBackend('hello', { sessionId: 'new-sess' })
      expect(result.reply).toBe('ok')
    })
  })
})
