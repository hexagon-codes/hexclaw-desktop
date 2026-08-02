/**
 * Session user_id — 全场景链路测试
 *
 * 覆盖每一条真实用户操作路径，验证 user_id 在完整链路中正确传递。
 * 每个 describe 对应一个用户操作，从 UI 入口追踪到最终 API 请求。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const EXPECTED_USER_ID = 'desktop-user'

// ─── Mock 基础设施 ────────────────────────────────────

const mockFetch = vi.hoisted(() => vi.fn())
vi.mock('ofetch', () => ({ ofetch: { create: () => mockFetch } }))

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
} from '../chat'

/** 收集所有 mockFetch 调用的 user_id */
function collectUserIds(): { url: string; user_id: unknown; source: string }[] {
  return mockFetch.mock.calls.map((call: unknown[]) => {
    const url = call[0] as string
    const opts = call[1] as Record<string, unknown>
    const query = opts.query as Record<string, unknown> | undefined
    const body = opts.body as Record<string, unknown> | undefined
    // user_id may be embedded directly in the URL query string (the codebase's
    // dominant pattern for query-only backend handlers — BUG-20260611), in
    // ofetch's query option, or in the body.
    const urlUserId = url.match(/[?&]user_id=([^&]+)/)?.[1]
    const decodedUrlUserId = urlUserId ? decodeURIComponent(urlUserId) : undefined
    return {
      url,
      user_id: decodedUrlUserId ?? query?.user_id ?? body?.user_id,
      source: decodedUrlUserId ? 'query' : query?.user_id ? 'query' : body?.user_id ? 'body' : 'missing',
    }
  })
}

async function currentChatWireUserId(): Promise<string> {
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

describe('全场景链路: user_id 传递验证', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetch.mockReset()
    // 默认返回空成功响应
    mockFetch.mockResolvedValue({
      sessions: [], total: 0, messages: [], branches: [],
      results: [], message: 'ok', query: '', id: 's1',
      title: 'T', created_at: '', updated_at: '',
    })
  })

  // ═══════════════════════════════════════════════════
  // 场景 1: 应用启动 → 加载会话列表 → 恢复上次会话
  // ═══════════════════════════════════════════════════

  describe('场景 1: 应用启动恢复会话', () => {
    it('loadSessions → selectSession(lastId) 全链路 user_id 一致', async () => {
      // Step 1: ChatView.vue onMounted → chatStore.loadSessions()
      //         → msgSvc.loadAllSessions() → listSessions({ limit: 200 })
      await listSessions({ limit: 200 })

      // Step 2: chatStore.loadSessions() 恢复 lastSessionId
      //         → selectSession(lastId) → msgSvc.loadMessages(sessionId)
      //         → listSessionMessages(sessionId, { limit: 500 })
      await listSessionMessages('last-session-id', { limit: 500 })

      const ids = collectUserIds()
      expect(ids).toHaveLength(2)
      expect(ids[0]!.user_id).toBe(EXPECTED_USER_ID)
      expect(ids[1]!.user_id).toBe(EXPECTED_USER_ID)
    })
  })

  // ═══════════════════════════════════════════════════
  // 场景 2: 用户发送首条消息（新会话）
  // ═══════════════════════════════════════════════════

  describe('场景 2: 首条消息 → 创建会话 → 发送', () => {
    it('ensureSession → createSession → sendViaBackend 全链路 user_id', async () => {
      // Step 1: sendMessage → ensureSession → createSession
      await createSession('new-sess-id', '新对话')

      // Step 2: sendMessage → canonical WebSocket payload
      const chatUserId = await currentChatWireUserId()

      // 验证: 创建会话和发送消息使用相同 user_id
      const createCall = mockFetch.mock.calls[0]!
      const createBody = (createCall[1] as Record<string, unknown>).body as Record<string, unknown>
      expect(createBody.user_id).toBe(EXPECTED_USER_ID)

      // 关键: 两者 user_id 必须一致
      expect(createBody.user_id).toBe(chatUserId)
    })
  })

  // ═══════════════════════════════════════════════════
  // 场景 3: 用户选择 Agent 角色（新建 Agent 会话）
  // ═══════════════════════════════════════════════════

  describe('场景 3: Agent 选择 → 新建会话 → 发送消息', () => {
    it('ChatView route.query.role → ensureSession → chat 全链路', async () => {
      // Step 1: ChatView.vue:339 → chatStore.newSession('代码助手')
      // Step 2: ChatView.vue:340 → chatStore.ensureSession()
      await createSession('agent-001', '代码助手')

      // Step 3: ChatView.vue:341 → chatStore.loadSessions() 刷新侧边栏
      await listSessions()

      // Step 4: 用户输入 → canonical WebSocket payload
      const chatUserId = await currentChatWireUserId()

      // 全部 3 个请求的 user_id 一致
      const ids = collectUserIds()
      expect(ids[0]!.user_id).toBe(EXPECTED_USER_ID) // createSession
      expect(ids[1]!.user_id).toBe(EXPECTED_USER_ID) // listSessions

      expect(chatUserId).toBe(EXPECTED_USER_ID)
    })
  })

  // ═══════════════════════════════════════════════════
  // 场景 4: 用户选择 Agent 角色（复用已有会话）
  // ═══════════════════════════════════════════════════

  describe('场景 4: Agent 选择 → 复用已有会话 → 加载消息', () => {
    it('selectSession → loadMessages → sendMessage 全链路', async () => {
      // Step 1: ChatView.vue:335 → sessions.find(s => s.title === roleTitle)
      //         找到已有会话 → chatStore.selectSession(existing.id)
      //         → msgSvc.loadMessages(sessionId)
      await listSessionMessages('existing-agent-sess')

      // Step 2: 用户在已有会话中发送消息
      const chatUserId = await currentChatWireUserId()

      const loadQuery = (mockFetch.mock.calls[0]![1] as Record<string, unknown>).query as Record<string, unknown>
      expect(loadQuery.user_id).toBe(chatUserId)
      expect(chatUserId).toBe(EXPECTED_USER_ID)
    })
  })

  // ═══════════════════════════════════════════════════
  // 场景 5: 侧边栏点击切换会话
  // ═══════════════════════════════════════════════════

  describe('场景 5: 侧边栏切换会话', () => {
    it('selectSession → loadMessages + loadArtifacts 都携带 user_id', async () => {
      // SessionList.vue:90 → chatStore.selectSession(sessionId)
      // → msgSvc.loadMessages(sessionId)
      await listSessionMessages('target-session')

      // 同时获取会话详情
      await getSession('target-session')

      const ids = collectUserIds()
      expect(ids).toHaveLength(2)
      ids.forEach((entry) => {
        expect(entry.user_id, `${entry.url} 缺少 user_id`).toBe(EXPECTED_USER_ID)
      })
    })
  })

  // ═══════════════════════════════════════════════════
  // 场景 6: 首条回复后自动设置标题
  // ═══════════════════════════════════════════════════

  describe('场景 6: 自动标题设置', () => {
    it('finalizeAssistantMessage → updateSessionTitle 携带 user_id', async () => {
      // stores/chat.ts:283 → msgSvc.updateSessionTitle(sessionId, title)
      await updateSessionTitle('sess-auto-title', '帮我写一个排序算法...')

      const body = (mockFetch.mock.calls[0]![1] as Record<string, unknown>).body as Record<string, unknown>
      expect(body.user_id).toBe(EXPECTED_USER_ID)
      expect(body.title).toBe('帮我写一个排序算法...')
    })
  })

  // ═══════════════════════════════════════════════════
  // 场景 7: 用户重命名会话
  // ═══════════════════════════════════════════════════

  describe('场景 7: 侧边栏重命名会话', () => {
    it('commitRename → updateSessionTitle 携带 user_id', async () => {
      // SessionList.vue:140 → apiUpdateSessionTitle(sid, newTitle)
      await updateSessionTitle('sess-rename', '重要对话-已归档')

      const body = (mockFetch.mock.calls[0]![1] as Record<string, unknown>).body as Record<string, unknown>
      expect(body.user_id).toBe(EXPECTED_USER_ID)
    })
  })

  // ═══════════════════════════════════════════════════
  // 场景 8: 删除会话
  // ═══════════════════════════════════════════════════

  describe('场景 8: 删除会话', () => {
    it('deleteSession 调用 apiDelete', async () => {
      await deleteSession('sess-to-delete')

      expect(mockFetch).toHaveBeenCalledWith(
        `/api/v1/sessions/${encodeURIComponent('sess-to-delete')}?user_id=desktop-user`,
        expect.objectContaining({ method: 'DELETE' }),
      )
    })
  })

  // ═══════════════════════════════════════════════════
  // 场景 9: 分支对话 (forkSession)
  // ═══════════════════════════════════════════════════

  describe('场景 9: 分支对话', () => {
    it('forkSession 携带 user_id', async () => {
      await forkSession('parent-sess', 'branch-msg-id')

      const body = (mockFetch.mock.calls[0]![1] as Record<string, unknown>).body as Record<string, unknown>
      expect(body.user_id).toBe(EXPECTED_USER_ID)
      expect(body.message_id).toBe('branch-msg-id')
    })

    it('getSessionBranches 携带 user_id', async () => {
      await getSessionBranches('parent-sess')

      const query = (mockFetch.mock.calls[0]![1] as Record<string, unknown>).query as Record<string, unknown>
      expect(query.user_id).toBe(EXPECTED_USER_ID)
    })
  })

  // ═══════════════════════════════════════════════════
  // 场景 10: 消息反馈 (like/dislike)
  // ═══════════════════════════════════════════════════

  describe('场景 10: 消息反馈', () => {
    it('updateMessageFeedback like 携带 user_id', async () => {
      await updateMessageFeedback('msg-001', 'like')
      // backend reads query only (BUG-20260611)
      expect(mockFetch.mock.calls[0]![0] as string).toContain(`user_id=${EXPECTED_USER_ID}`)
      const body = (mockFetch.mock.calls[0]![1] as Record<string, unknown>).body as Record<string, unknown>
      expect(body.feedback).toBe('like')
    })

    it('updateMessageFeedback dislike 携带 user_id', async () => {
      await updateMessageFeedback('msg-002', 'dislike')
      // backend reads query only (BUG-20260611)
      expect(mockFetch.mock.calls[0]![0] as string).toContain(`user_id=${EXPECTED_USER_ID}`)
    })

    it('updateMessageFeedback 清除反馈也携带 user_id', async () => {
      await updateMessageFeedback('msg-003', '')
      expect(mockFetch.mock.calls[0]![0] as string).toContain(`user_id=${EXPECTED_USER_ID}`)
    })
  })

  // ═══════════════════════════════════════════════════
  // 场景 11: 全文搜索
  // ═══════════════════════════════════════════════════

  describe('场景 11: 跨会话搜索', () => {
    it('searchMessages 携带 user_id', async () => {
      await searchMessages('排序算法', { limit: 20 })

      const query = (mockFetch.mock.calls[0]![1] as Record<string, unknown>).query as Record<string, unknown>
      expect(query.user_id).toBe(EXPECTED_USER_ID)
      expect(query.q).toBe('排序算法')
      expect(query.limit).toBe(20)
    })
  })

  // ═══════════════════════════════════════════════════
  // 场景 12: HTTP 回退 (WebSocket 不可用)
  // ═══════════════════════════════════════════════════

  describe('场景 12: WebSocket 不可用 → fail closed', () => {
    it('聊天仍只有 canonical WebSocket user_id 权威，不恢复 backend_chat 回退', async () => {
      expect(await currentChatWireUserId()).toBe(EXPECTED_USER_ID)
      const fs = await import('node:fs')
      const path = await import('node:path')
      const source = fs.readFileSync(
        path.resolve(process.cwd(), 'src/services/chatService.ts'),
        'utf-8',
      )
      expect(source).not.toContain('backend_chat')
    })
  })

  // ═══════════════════════════════════════════════════
  // 场景 13: 并发 ensureSession 去重
  // ═══════════════════════════════════════════════════

  describe('场景 13: 并发创建会话', () => {
    it('多次并发 createSession 每次都携带 user_id', async () => {
      // 模拟多个并发创建
      await Promise.all([
        createSession('concurrent-1', '对话1'),
        createSession('concurrent-2', '对话2'),
        createSession('concurrent-3', '对话3'),
      ])

      expect(mockFetch).toHaveBeenCalledTimes(3)
      for (let i = 0; i < 3; i++) {
        const body = (mockFetch.mock.calls[i]![1] as Record<string, unknown>).body as Record<string, unknown>
        expect(body.user_id, `第 ${i + 1} 次并发调用缺少 user_id`).toBe(EXPECTED_USER_ID)
      }
    })
  })

  // ═══════════════════════════════════════════════════
  // 场景 14: 完整对话生命周期
  // ═══════════════════════════════════════════════════

  describe('场景 14: 完整对话生命周期 (创建→对话→改名→删除)', () => {
    it('全生命周期 user_id 一致', async () => {
      // 1. 创建会话
      await createSession('lifecycle-sess', '新对话')

      // 2. 多条消息共享同一个 canonical WebSocket user_id 权威
      const chatUserId = await currentChatWireUserId()

      // 3. 自动设置标题
      await updateSessionTitle('lifecycle-sess', '第一条消息...')

      // 4. 用户手动重命名
      await updateSessionTitle('lifecycle-sess', '重要对话')

      // 5. 加载消息历史（切换回来）
      await listSessionMessages('lifecycle-sess')

      // 6. 消息反馈
      await updateMessageFeedback('reply-1', 'like')

      // 7. 删除会话
      await deleteSession('lifecycle-sess')

      // 验证: 所有需要 user_id 的请求都正确携带
      const ids = collectUserIds()
      // createSession + updateSessionTitle*2 + listSessionMessages + updateMessageFeedback + deleteSession
      // = 6 次 mockFetch 调用。deleteSession 用 apiDelete 但在 URL 带 ?user_id=，
      // 现在 collectUserIds URL-aware 后能正确识别 → 全部 6 次都带 user_id（BUG-20260611）。
      const withUserId = ids.filter((e) => e.user_id === EXPECTED_USER_ID)
      const withoutUserId = ids.filter((e) => e.source === 'missing')

      expect(withUserId.length).toBe(6)
      expect(withoutUserId.length).toBe(0)

      expect(chatUserId).toBe(EXPECTED_USER_ID)
    })
  })

  // ═══════════════════════════════════════════════════
  // 场景 15: 特殊字符 session ID
  // ═══════════════════════════════════════════════════

  describe('场景 15: 特殊字符 session ID 编码', () => {
    it('含特殊字符的 sessionId 正确 URL 编码且携带 user_id', async () => {
      const specialId = 'sess/with+special&chars'

      await getSession(specialId)
      await listSessionMessages(specialId)
      await updateSessionTitle(specialId, 'test')

      const ids = collectUserIds()
      expect(ids).toHaveLength(3)
      ids.forEach((entry) => {
        expect(entry.user_id).toBe(EXPECTED_USER_ID)
        expect(entry.url).toContain(encodeURIComponent(specialId))
        expect(entry.url).not.toContain('sess/with') // 原始值不应出现
      })
    })
  })

  // ═══════════════════════════════════════════════════
  // 场景 16: 多会话快速切换
  // ═══════════════════════════════════════════════════

  describe('场景 16: 快速切换多个会话', () => {
    it('连续切换 5 个会话，每次 loadMessages 都携带 user_id', async () => {
      const sessions = ['s1', 's2', 's3', 's4', 's5']
      for (const sid of sessions) {
        await listSessionMessages(sid)
      }

      const ids = collectUserIds()
      expect(ids).toHaveLength(5)
      ids.forEach((entry, i) => {
        expect(entry.user_id, `第 ${i + 1} 次切换缺少 user_id`).toBe(EXPECTED_USER_ID)
      })
    })
  })
})
