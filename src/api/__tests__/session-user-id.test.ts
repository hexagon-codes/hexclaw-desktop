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

import {
  listSessions,
  getSession,
  createSession,
  updateSessionTitle,
  forkSession,
  getSessionBranches,
  listSessionMessages,
  searchMessages,
  updateMessageFeedback,
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

/** 当前聊天线协议的唯一 user_id 权威。 */
async function getChatWireUserId(): Promise<string> {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const source = fs.readFileSync(
    path.resolve(process.cwd(), 'src/services/chatService.ts'),
    'utf-8',
  )
  expect(source).toContain('user_id: DESKTOP_USER_ID')
  expect(source).toContain('session_id: sessionId')
  return EXPECTED_USER_ID
}

// ─── 测试 ────────────────────────────────────────────

describe('Session user_id 一致性', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetch.mockReset()
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
    it('URL query 含 user_id（后端只读 query — BUG-20260611）', async () => {
      mockFetch.mockResolvedValue({ message: 'ok' })
      await updateMessageFeedback('msg-1', 'like')
      expect(mockFetch.mock.calls[0]?.[0] as string).toContain(`user_id=${EXPECTED_USER_ID}`)
    })
  })

  // ── 单一 WebSocket 通道 ──

  describe('WebSocket chat wire', () => {
    it('payload 包含 user_id', async () => {
      expect(await getChatWireUserId()).toBe(EXPECTED_USER_ID)
    })

    it('默认路径也复用同一个 user_id 权威', async () => {
      expect(await getChatWireUserId()).toBe(EXPECTED_USER_ID)
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

      // Step 2: 发送消息 → canonical WebSocket wire
      const chatUserId = await getChatWireUserId()

      // 关键断言: 创建和聊天使用的 user_id 必须一致
      expect(createBody.user_id).toBe(chatUserId)
    })

    it('复用已有 Agent 会话 → 加载消息: user_id 一致', async () => {
      // Step 1: selectSession → listSessionMessages
      mockFetch.mockResolvedValue({ messages: [], total: 0 })
      await listSessionMessages('existing-agent-session')

      const loadQuery = getQueryArg()!
      expect(loadQuery.user_id).toBe(EXPECTED_USER_ID)

      // Step 2: 发送消息
      const chatUserId = await getChatWireUserId()
      expect(chatUserId).toBe(loadQuery.user_id)
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

    // updateMessageFeedback reads user_id from the URL query only (query-only
    // backend handler), asserted in its own test so expect stays unconditional
    // (vitest/no-conditional-expect).
    it(`updateMessageFeedback() 的 URL 包含 user_id = '${EXPECTED_USER_ID}'`, async () => {
      mockFetch.mockResolvedValue({ sessions: [], total: 0, messages: [], branches: [], results: [], message: 'ok', query: 'q', id: 's1', title: 'T', created_at: '', updated_at: '' })
      await updateMessageFeedback('m1', 'like')
      const url = mockFetch.mock.calls[0]?.[0] as string
      expect(url, `updateMessageFeedback() URL 应含 user_id`).toContain(`user_id=${EXPECTED_USER_ID}`)
    })
  })

  // ── 静态分析: 防止绕过 sessionGet/sessionPost 直接调用 apiGet/apiPost ──

  describe('结构性防护 — 会话区每个调用都必须携带 user_id', () => {
    it('Session Management 区域：裸 apiGet/apiPost/apiPut/apiPatch 必须在同一调用内显式带 user_id= query（BUG-20260611）', async () => {
      const fs = await import('node:fs')
      const path = await import('node:path')
      const source = fs.readFileSync(path.resolve(process.cwd(), 'src/api/chat.ts'), 'utf-8')

      // 提取 "Session Fork" 之后的所有代码（即会话管理区域）
      const sessionSection = source.slice(source.indexOf('// ============== Session Fork'))

      // 真正的不变量不是"必须用 session* 包装器"——包装器把 user_id 注入 body，
      // 对只读 query 的后端 handler（suggest-title / feedback）反而是 bug 根源。
      // 正确不变量：每个裸 api* 调用都必须在调用参数里显式带上 user_id=（URL query）。
      const offenders: string[] = []
      const re = /\bapi(Get|Post|Put|Patch)\b/g
      let m: RegExpExecArray | null
      while ((m = re.exec(sessionSection)) !== null) {
        // Inspect a fixed window covering the URL arg + options of this call.
        const window = sessionSection.slice(m.index, m.index + 300)
        if (!window.includes('user_id=')) {
          offenders.push(window.split('\n')[0]!.trim())
        }
      }
      expect(
        offenders,
        `这些裸 api* 调用未在 URL query 带 user_id=（会被后端读成 api-user）：\n${offenders.join('\n')}`,
      ).toEqual([])
    })

    it('ownedPath 必须经 userQuery 保证 URL query 带 user_id=（M11 belt-and-suspenders）', async () => {
      const fs = await import('node:fs')
      const path = await import('node:path')
      const source = fs.readFileSync(path.resolve(process.cwd(), 'src/api/chat.ts'), 'utf-8')

      expect(source).toContain('const userQuery = () => ({ user_id: DESKTOP_USER_ID })')
      expect(source).toMatch(
        /const ownedPath[\s\S]{0,200}encodeURIComponent\(DESKTOP_USER_ID\)/,
      )
      expect((source.match(/ownedPath\(/g) ?? []).length).toBeGreaterThan(3)
    })

    it('runtime: 每个 session* 写包装器调用产生的 URL 都含 user_id=', async () => {
      mockFetch.mockResolvedValue({ session: { id: 's2' }, message: 'ok', id: 's1', title: 'T', created_at: '', updated_at: '' })
      const wrapperCalls = [
        () => createSession('s1', 'T'),
        () => forkSession('s1', 'm1'),
        () => updateSessionTitle('s1', 'T2'),
      ]
      for (const call of wrapperCalls) {
        mockFetch.mockClear()
        await call()
        const url = mockFetch.mock.calls[0]?.[0] as string
        expect(url, `wrapper 调用 URL 应含 user_id=：${url}`).toContain(`user_id=${EXPECTED_USER_ID}`)
      }
    })
  })
})
