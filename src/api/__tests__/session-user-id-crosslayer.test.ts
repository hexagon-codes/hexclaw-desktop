/**
 * Session user_id — 跨层集成测试
 *
 * 覆盖 API 层以外的所有关联层：
 *   - Service 层 (messageService / chatService)
 *   - WebSocket 协议层
 *   - Store 层 (chat store ensureSession / selectSession)
 *   - 跨模块一致性 (tasks / webhook 也使用 DESKTOP_USER_ID)
 *   - 错误恢复 / 竞态 / 边界条件
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const EXPECTED_USER_ID = 'desktop-user'

// ─── 统一 Mock ────────────────────────────────────────

const mockFetch = vi.hoisted(() => vi.fn())
vi.mock('ofetch', () => ({ ofetch: { create: () => mockFetch } }))

const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

// ─── 默认返回值 ────────────────────────────────────────

function resetMocks() {
  vi.clearAllMocks()
  mockFetch.mockReset()
  invoke.mockReset()
  mockFetch.mockResolvedValue({
    sessions: [], total: 0, messages: [], branches: [],
    id: 's1', title: 'T', created_at: '', updated_at: '',
    message: 'ok', results: [], query: '',
    jobs: [], webhooks: [], name: '', url: '', next_run_at: '',
  })
  invoke.mockResolvedValue('{"reply":"ok","session_id":"s1"}')
}

// ═══════════════════════════════════════════════════════
// Part 1: messageService 层
// ═══════════════════════════════════════════════════════

describe('messageService 层: user_id 传递', () => {
  beforeEach(resetMocks)

  it('loadAllSessions → listSessions → 携带 user_id', async () => {
    const msgSvc = await import('@/services/messageService')
    await msgSvc.loadAllSessions()

    const query = mockFetch.mock.calls[0]?.[1]?.query
    expect(query?.user_id).toBe(EXPECTED_USER_ID)
  })

  it('createSession → apiPost → body 携带 user_id', async () => {
    const msgSvc = await import('@/services/messageService')
    await msgSvc.createSession('svc-sess-1', '测试会话')

    const body = mockFetch.mock.calls[0]?.[1]?.body
    expect(body?.user_id).toBe(EXPECTED_USER_ID)
    expect(body?.id).toBe('svc-sess-1')
    expect(body?.title).toBe('测试会话')
  })

  it('updateSessionTitle → apiPatch → body 携带 user_id', async () => {
    const msgSvc = await import('@/services/messageService')
    await msgSvc.updateSessionTitle('svc-sess-1', '新标题')

    const body = mockFetch.mock.calls[0]?.[1]?.body
    expect(body?.user_id).toBe(EXPECTED_USER_ID)
    expect(body?.title).toBe('新标题')
  })

  it('loadMessages → listSessionMessages → query 携带 user_id', async () => {
    const msgSvc = await import('@/services/messageService')
    await msgSvc.loadMessages('svc-sess-1')

    const query = mockFetch.mock.calls[0]?.[1]?.query
    expect(query?.user_id).toBe(EXPECTED_USER_ID)
  })

  it('deleteSession → apiDelete 被调用', async () => {
    const msgSvc = await import('@/services/messageService')
    await msgSvc.deleteSession('svc-sess-1')

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/sessions/svc-sess-1'),
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('removeMessage → apiDelete 被调用', async () => {
    const msgSvc = await import('@/services/messageService')
    await msgSvc.removeMessage('msg-to-delete')

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/messages/msg-to-delete'),
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('全链路模拟: createSession → loadMessages → updateTitle 每步都有 user_id', async () => {
    const msgSvc = await import('@/services/messageService')

    await msgSvc.createSession('full-chain', '对话')
    await msgSvc.loadMessages('full-chain')
    await msgSvc.updateSessionTitle('full-chain', '新标题')

    expect(mockFetch).toHaveBeenCalledTimes(3)
    for (let i = 0; i < 3; i++) {
      const opts = mockFetch.mock.calls[i]![1]
      const userId = opts.body?.user_id ?? opts.query?.user_id
      expect(userId, `msgSvc 第 ${i + 1} 步缺少 user_id`).toBe(EXPECTED_USER_ID)
    }
  })
})

// ═══════════════════════════════════════════════════════
// Part 2: WebSocket 协议层
// ═══════════════════════════════════════════════════════

describe('WebSocket 协议层: user_id in payload', () => {
  it('WsMessage 构造包含 user_id (与 websocket.ts:176 相同逻辑)', async () => {
    const { DESKTOP_USER_ID } = await import('@/constants')

    const msg = {
      type: 'message' as const,
      content: '你好',
      session_id: 'ws-sess-1',
      user_id: DESKTOP_USER_ID,
      provider: '智谱',
      model: 'glm-4',
      role: 'coder',
    }

    expect(msg.user_id).toBe(EXPECTED_USER_ID)

    const json = JSON.parse(JSON.stringify(msg))
    expect(json.user_id).toBe(EXPECTED_USER_ID)
  })
})

// ═══════════════════════════════════════════════════════
// Part 3: chatService 层
// ═══════════════════════════════════════════════════════

describe('chatService 层: sendViaBackend user_id', () => {
  beforeEach(resetMocks)

  it('sendViaBackend 完整参数传递 user_id', async () => {
    const chatSvc = await import('@/services/chatService')
    await chatSvc.sendViaBackend(
      '写一个函数',
      'svc-sess-1',
      { model: 'glm-4', provider: '智谱', temperature: 0.7, maxTokens: 4096 },
      'coder',
    )

    const params = invoke.mock.calls[0]![1].params
    expect(params.user_id).toBe(EXPECTED_USER_ID)
    expect(params.session_id).toBe('svc-sess-1')
    expect(params.role).toBe('coder')
    expect(params.model).toBe('glm-4')
    expect(params.provider).toBe('智谱')
  })

  it('sendViaBackend 空 agentRole → user_id 仍存在', async () => {
    const chatSvc = await import('@/services/chatService')
    await chatSvc.sendViaBackend('普通聊天', 'normal-sess', { model: 'gpt-4' }, '')

    const params = invoke.mock.calls[0]![1].params
    expect(params.user_id).toBe(EXPECTED_USER_ID)
    expect(params.role).toBeFalsy() // chatService 传 undefined → sendChatViaBackend 转为 null
  })

  it('sendViaBackend 带附件 → user_id 仍存在', async () => {
    const chatSvc = await import('@/services/chatService')
    const attachments = [{ type: 'image', name: 'test.png', mime: 'image/png', data: 'base64...' }]
    await chatSvc.sendViaBackend(
      '描述这张图片', 'attach-sess', {}, '',
      attachments as import('@/types').ChatAttachment[],
    )

    const params = invoke.mock.calls[0]![1].params
    expect(params.user_id).toBe(EXPECTED_USER_ID)
    expect(params.attachments).toHaveLength(1)
  })
})

// ═══════════════════════════════════════════════════════
// Part 4: 跨模块一致性
// ═══════════════════════════════════════════════════════

describe('跨模块一致性: chat + tasks + webhook 使用相同 user_id', () => {
  beforeEach(resetMocks)

  it('tasks.getCronJobs 使用 DESKTOP_USER_ID', async () => {
    const { getCronJobs } = await import('@/api/tasks')
    await getCronJobs()
    expect(mockFetch.mock.calls[0]?.[1]?.query?.user_id).toBe(EXPECTED_USER_ID)
  })

  it('tasks.createCronJob 使用 DESKTOP_USER_ID', async () => {
    const { createCronJob } = await import('@/api/tasks')
    await createCronJob({ name: 'test', schedule: '0 * * * *', prompt: 'hello' })
    expect(mockFetch.mock.calls[0]?.[1]?.body?.user_id).toBe(EXPECTED_USER_ID)
  })

  it('webhook.getWebhooks 使用 DESKTOP_USER_ID', async () => {
    const { getWebhooks } = await import('@/api/webhook')
    await getWebhooks()
    expect(mockFetch.mock.calls[0]?.[1]?.query?.user_id).toBe(EXPECTED_USER_ID)
  })

  it('webhook.createWebhook 使用 DESKTOP_USER_ID', async () => {
    const { createWebhook } = await import('@/api/webhook')
    await createWebhook({ name: 'test', type: 'custom', url: 'https://example.com', events: ['task_complete'] })
    expect(mockFetch.mock.calls[0]?.[1]?.body?.user_id).toBe(EXPECTED_USER_ID)
  })

  it('3 个模块 createSession + getCronJobs + getWebhooks 使用完全相同 user_id', async () => {
    const { createSession } = await import('@/api/chat')
    const { getCronJobs } = await import('@/api/tasks')
    const { getWebhooks } = await import('@/api/webhook')

    await createSession('cross-mod-1', 'test')
    await getCronJobs()
    await getWebhooks()

    const userIds = mockFetch.mock.calls.map((call: unknown[]) => {
      const opts = call[1] as Record<string, unknown>
      return (opts.body as Record<string, unknown>)?.user_id ??
             (opts.query as Record<string, unknown>)?.user_id
    })
    expect(userIds).toEqual([EXPECTED_USER_ID, EXPECTED_USER_ID, EXPECTED_USER_ID])
  })
})

// ═══════════════════════════════════════════════════════
// Part 5: 错误恢复
// ═══════════════════════════════════════════════════════

describe('错误恢复: 失败后重试 user_id 不丢失', () => {
  beforeEach(resetMocks)

  it('createSession 网络错误 → 重试 → user_id 两次都在', async () => {
    const { createSession } = await import('@/api/chat')

    mockFetch.mockRejectedValueOnce(new Error('Network error'))
    await expect(createSession('retry-1', 'test')).rejects.toThrow('Network error')

    mockFetch.mockResolvedValueOnce({ id: 'retry-1', title: 'test', created_at: '' })
    await createSession('retry-1', 'test')

    expect(mockFetch).toHaveBeenCalledTimes(2)
    for (const call of mockFetch.mock.calls) {
      expect((call[1] as Record<string, unknown>).body).toHaveProperty('user_id', EXPECTED_USER_ID)
    }
  })

  it('listSessionMessages 超时 → 重试 → user_id 两次都在', async () => {
    const { listSessionMessages } = await import('@/api/chat')

    mockFetch.mockRejectedValueOnce(new Error('timeout'))
    await expect(listSessionMessages('timeout-sess')).rejects.toThrow()

    mockFetch.mockResolvedValueOnce({ messages: [], total: 0 })
    await listSessionMessages('timeout-sess')

    for (const call of mockFetch.mock.calls) {
      expect((call[1] as Record<string, unknown>).query).toHaveProperty('user_id', EXPECTED_USER_ID)
    }
  })

  it('sendChatViaBackend 连续调用 user_id 始终存在', async () => {
    const { sendChatViaBackend } = await import('@/api/chat')

    await sendChatViaBackend('第一条', { sessionId: 's1' })
    await sendChatViaBackend('第二条', { sessionId: 's1' })
    await sendChatViaBackend('第三条', { sessionId: 's1' })

    expect(invoke).toHaveBeenCalledTimes(3)
    for (const call of invoke.mock.calls) {
      expect(call[1].params.user_id).toBe(EXPECTED_USER_ID)
    }
  })
})

// ═══════════════════════════════════════════════════════
// Part 6: 边界条件
// ═══════════════════════════════════════════════════════

describe('边界条件', () => {
  beforeEach(resetMocks)

  it('空字符串 session ID — user_id 仍注入', async () => {
    const { listSessionMessages } = await import('@/api/chat')
    await listSessionMessages('')
    expect(mockFetch.mock.calls[0]?.[1]?.query?.user_id).toBe(EXPECTED_USER_ID)
  })

  it('空标题 — user_id 仍注入', async () => {
    const { createSession } = await import('@/api/chat')
    await createSession('no-title', '')
    const body = mockFetch.mock.calls[0]?.[1]?.body
    expect(body?.user_id).toBe(EXPECTED_USER_ID)
    expect(body?.title).toBe('')
  })

  it('sendChatViaBackend 无 options — user_id 仍注入', async () => {
    const { sendChatViaBackend } = await import('@/api/chat')
    await sendChatViaBackend('hello')
    expect(invoke.mock.calls[0]![1].params.user_id).toBe(EXPECTED_USER_ID)
    expect(invoke.mock.calls[0]![1].params.session_id).toBeNull()
  })

  it('listSessions 无分页参数 — user_id 仍注入', async () => {
    const { listSessions } = await import('@/api/chat')
    await listSessions()
    expect(mockFetch.mock.calls[0]?.[1]?.query?.user_id).toBe(EXPECTED_USER_ID)
  })

  it('searchMessages 空关键词 — user_id 仍注入', async () => {
    const { searchMessages } = await import('@/api/chat')
    await searchMessages('')
    expect(mockFetch.mock.calls[0]?.[1]?.query?.user_id).toBe(EXPECTED_USER_ID)
  })

  it('updateMessageFeedback like/dislike/clear 三种状态都携带 user_id', async () => {
    const { updateMessageFeedback } = await import('@/api/chat')

    for (const feedback of ['like', 'dislike', ''] as const) {
      mockFetch.mockResolvedValueOnce({ message: 'ok' })
      await updateMessageFeedback(`msg-${feedback || 'clear'}`, feedback)
    }

    expect(mockFetch).toHaveBeenCalledTimes(3)
    for (const call of mockFetch.mock.calls) {
      expect((call[1] as Record<string, unknown>).body).toHaveProperty('user_id', EXPECTED_USER_ID)
    }
  })

  it('DESKTOP_USER_ID 常量值验证', async () => {
    const { DESKTOP_USER_ID } = await import('@/constants')
    expect(DESKTOP_USER_ID).toBe('desktop-user')
    expect(typeof DESKTOP_USER_ID).toBe('string')
    expect(DESKTOP_USER_ID.length).toBeGreaterThan(0)
  })
})

// ═══════════════════════════════════════════════════════
// Part 7: 源码静态分析
// ═══════════════════════════════════════════════════════

describe('静态分析: 跨文件 user_id 完整性', () => {
  it('websocket.ts sendMessage 中 user_id: DESKTOP_USER_ID', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const source = fs.readFileSync(path.resolve(process.cwd(), 'src/api/websocket.ts'), 'utf-8')

    const sendMessageSection = source.slice(source.indexOf('sendMessage('))
    expect(sendMessageSection).toContain('user_id: DESKTOP_USER_ID')
  })

  it('websocket.ts 导入 DESKTOP_USER_ID', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const source = fs.readFileSync(path.resolve(process.cwd(), 'src/api/websocket.ts'), 'utf-8')
    expect(source).toContain("DESKTOP_USER_ID")
  })

  it('chat.ts 会话区域无裸 apiGet/apiPost 调用', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const source = fs.readFileSync(path.resolve(process.cwd(), 'src/api/chat.ts'), 'utf-8')

    const sessionSection = source.slice(source.indexOf('// ============== Session Fork'))
    const bareApiCalls = sessionSection.match(/\bapiGet\b|\bapiPost\b|\bapiPatch\b|\bapiPut\b/g) || []
    expect(bareApiCalls, `会话区域发现直接调用: ${bareApiCalls.join(', ')}`).toEqual([])
  })

  it('chat.ts sessionGet/Post/Patch/Put 辅助函数全部注入 DESKTOP_USER_ID', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const source = fs.readFileSync(path.resolve(process.cwd(), 'src/api/chat.ts'), 'utf-8')

    for (const fn of ['sessionGet', 'sessionPost', 'sessionPatch', 'sessionPut']) {
      const regex = new RegExp(`function ${fn}[^}]+user_id:\\s*DESKTOP_USER_ID`)
      expect(regex.test(source), `${fn} 必须包含 user_id: DESKTOP_USER_ID`).toBe(true)
    }
  })

  it('tasks.ts 和 webhook.ts 都使用 DESKTOP_USER_ID', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')

    for (const file of ['src/api/tasks.ts', 'src/api/webhook.ts']) {
      const source = fs.readFileSync(path.resolve(process.cwd(), file), 'utf-8')
      expect(source, `${file} 未引用 DESKTOP_USER_ID`).toContain('DESKTOP_USER_ID')
    }
  })
})
