import { describe, it, expect, vi, beforeEach } from 'vitest'

const {
  listSessions,
  listSessionMessages,
  createSessionApi,
  updateSessionTitleApi,
  deleteSessionApi,
  deleteMessageApi,
} = vi.hoisted(() => ({
  listSessions: vi.fn().mockResolvedValue({ sessions: [], total: 0 }),
  listSessionMessages: vi.fn().mockResolvedValue({ messages: [], total: 0 }),
  createSessionApi: vi.fn().mockResolvedValue({ id: 's1', title: '新对话', created_at: '2026-01-01' }),
  updateSessionTitleApi: vi.fn().mockResolvedValue({ id: 's1', title: 'Updated', updated_at: '2026-01-02' }),
  deleteSessionApi: vi.fn().mockResolvedValue({ message: 'ok' }),
  deleteMessageApi: vi.fn().mockResolvedValue({ message: 'deleted' }),
}))

vi.mock('@/api/chat', () => ({
  listSessions,
  listSessionMessages,
  createSession: createSessionApi,
  updateSessionTitle: updateSessionTitleApi,
  deleteSession: deleteSessionApi,
  deleteMessage: deleteMessageApi,
}))

import {
  parseMessageMetadata, normalizeLoadedMessage, serializeMessageMetadata,
  loadAllSessions, deleteSession, persistMessage, loadMessages,
  createSession, updateSessionTitle, touchSession,
  getLastSessionId, setLastSessionId,
  loadArtifacts, saveArtifact, removeMessage,
} from '../messageService'

describe('messageService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
  })

  // ─── parseMessageMetadata ───
  it('returns undefined for null', () => {
    expect(parseMessageMetadata(null)).toBeUndefined()
  })

  it('returns undefined for empty string', () => {
    expect(parseMessageMetadata('')).toBeUndefined()
  })

  it('parses valid JSON', () => {
    expect(parseMessageMetadata('{"key":"val"}')).toEqual({ key: 'val' })
  })

  it('returns undefined for invalid JSON', () => {
    expect(parseMessageMetadata('not json')).toBeUndefined()
  })

  // ─── normalizeLoadedMessage ───
  it('extracts tool_calls and agent_name from metadata', () => {
    const msg = normalizeLoadedMessage({
      id: 'm1', role: 'assistant', content: 'hi', timestamp: '2026-01-01',
      metadata: JSON.stringify({ tool_calls: [{ id: 't1', name: 'search', arguments: '{}' }], agent_name: 'Coder' }),
    })
    expect(msg.tool_calls).toHaveLength(1)
    expect(msg.agent_name).toBe('Coder')
  })

  it('handles null metadata gracefully', () => {
    const msg = normalizeLoadedMessage({
      id: 'm1', role: 'user', content: 'hello', timestamp: '2026-01-01', metadata: null,
    })
    expect(msg.metadata).toBeUndefined()
    expect(msg.tool_calls).toBeUndefined()
    expect(msg.agent_name).toBeUndefined()
  })

  // ─── serializeMessageMetadata ───
  it('includes tool_calls when present', () => {
    const result = serializeMessageMetadata({
      id: 'm1', role: 'assistant', content: 'done', timestamp: '',
      tool_calls: [{ id: 't1', name: 'calc', arguments: '{}' }],
    })
    expect(result?.tool_calls).toHaveLength(1)
  })

  it('returns undefined when no metadata', () => {
    expect(serializeMessageMetadata({ id: 'm1', role: 'user', content: 'hi', timestamp: '' })).toBeUndefined()
  })

  // ─── loadAllSessions ───
  it('returns mapped sessions from API', async () => {
    listSessions.mockResolvedValueOnce({
      sessions: [
        { id: 's1', title: 'Test', created_at: '2026-01-01', updated_at: '2026-01-02', message_count: 5 },
      ],
      total: 1,
    })
    const sessions = await loadAllSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.title).toBe('Test')
    expect(sessions[0]!.message_count).toBe(5)
  })

  it('returns empty array when API fails', async () => {
    listSessions.mockRejectedValueOnce(new Error('API error'))
    const sessions = await loadAllSessions()
    expect(sessions).toEqual([])
  })

  // ─── createSession ───
  it('calls createSession API', async () => {
    await createSession('s1', 'Test')
    expect(createSessionApi).toHaveBeenCalledWith('s1', 'Test')
  })

  // ─── updateSessionTitle ───
  it('calls updateSessionTitle API', async () => {
    await updateSessionTitle('s1', 'New Title')
    expect(updateSessionTitleApi).toHaveBeenCalledWith('s1', 'New Title')
  })

  // ─── touchSession ───
  it('touchSession is a no-op', async () => {
    await touchSession('s1')
    // Should not throw, backend handles timestamps
    expect(true).toBe(true)
  })

  // ─── deleteSession ───
  it('calls deleteSession API', async () => {
    await deleteSession('s1')
    expect(deleteSessionApi).toHaveBeenCalledWith('s1')
  })

  // ─── loadMessages ───
  it('returns messages from API', async () => {
    listSessionMessages.mockResolvedValueOnce({
      messages: [
        { id: 'm1', role: 'user', content: 'hello', timestamp: '2026-01-01' },
      ],
      total: 1,
    })
    const msgs = await loadMessages('s1')
    expect(msgs).toHaveLength(1)
    expect(msgs[0]!.role).toBe('user')
  })

  it('returns empty array when loadMessages API fails', async () => {
    listSessionMessages.mockRejectedValueOnce(new Error('API error'))
    const msgs = await loadMessages('s1')
    expect(msgs).toEqual([])
  })

  // ─── Bug 复现: 第二次打开会话 reasoning 丢失 ───
  // 后端 API 将 reasoning 存在 metadata 对象内，而非消息顶层字段。
  // 修复前 loadMessages 直接 spread，顶层 reasoning 为 undefined。

  describe('before/after fix contrast: reasoning lost on reload', () => {
    // 模拟后端返回的消息——reasoning 只存在 metadata 中，顶层没有
    const backendMessage = {
      id: 'm-reload', role: 'assistant' as const, content: '回复内容',
      timestamp: '2026-01-01',
      metadata: { reasoning: '这是思考过程', thinking_duration: 5 },
    }

    // ── 旧代码（修复前）：直接 spread，不提取 metadata 内字段 ──
    function loadMessages_OLD(messages: typeof backendMessage[]) {
      return messages.map(m => ({
        ...m,
        timestamp: m.timestamp || new Date().toISOString(),
      }))
    }

    it('[修复前] reasoning 丢失 — 旧逻辑直接 spread 不提取 metadata 内字段', () => {
      const msgs = loadMessages_OLD([backendMessage])
      // 旧代码：顶层没有 reasoning 字段，spread 后仍然没有
      expect(msgs[0]).not.toHaveProperty('reasoning')
      // metadata 中的 reasoning 存在但 UI 读取的是顶层字段，所以不显示
      expect((msgs[0] as any).metadata.reasoning).toBe('这是思考过程')
    })

    it('[修复后] reasoning 正确提取 — loadMessages 从 metadata 中还原', async () => {
      listSessionMessages.mockResolvedValueOnce({ messages: [backendMessage], total: 1 })
      const msgs = await loadMessages('s1')
      // 修复后：顶层 reasoning 被正确赋值
      expect(msgs[0]!.reasoning).toBe('这是思考过程')
    })
  })

  it('extracts reasoning from metadata object (bug fix: reasoning lost on reload)', async () => {
    // 模拟后端返回：reasoning 存在 metadata.reasoning 中，顶层无 reasoning
    listSessionMessages.mockResolvedValueOnce({
      messages: [{
        id: 'm1', role: 'assistant', content: '回复内容',
        timestamp: '2026-01-01',
        metadata: { reasoning: '这是思考过程', thinking_duration: 5 },
      }],
      total: 1,
    })
    const msgs = await loadMessages('s1')
    expect(msgs[0]!.reasoning).toBe('这是思考过程')
    expect(msgs[0]!.metadata?.thinking_duration).toBe(5)
  })

  it('extracts reasoning from metadata JSON string', async () => {
    // 某些情况下后端可能返回 metadata 为 JSON 字符串
    listSessionMessages.mockResolvedValueOnce({
      messages: [{
        id: 'm2', role: 'assistant', content: '回复',
        timestamp: '2026-01-01',
        metadata: JSON.stringify({ reasoning: '字符串形式的思考', agent_name: 'Coder' }),
      }],
      total: 1,
    })
    const msgs = await loadMessages('s1')
    expect(msgs[0]!.reasoning).toBe('字符串形式的思考')
    expect(msgs[0]!.agent_name).toBe('Coder')
  })

  it('extracts tool_calls and agent_name from metadata on reload', async () => {
    listSessionMessages.mockResolvedValueOnce({
      messages: [{
        id: 'm3', role: 'assistant', content: '工具调用结果',
        timestamp: '2026-01-01',
        metadata: {
          tool_calls: [{ id: 't1', name: 'web_search', arguments: '{"q":"test"}' }],
          agent_name: 'Researcher',
        },
      }],
      total: 1,
    })
    const msgs = await loadMessages('s1')
    expect(msgs[0]!.tool_calls).toHaveLength(1)
    expect(msgs[0]!.tool_calls![0]!.name).toBe('web_search')
    expect(msgs[0]!.agent_name).toBe('Researcher')
  })

  it('preserves top-level reasoning when already present', async () => {
    // 如果后端将来直接在顶层返回 reasoning，应优先使用
    listSessionMessages.mockResolvedValueOnce({
      messages: [{
        id: 'm4', role: 'assistant', content: '回复',
        reasoning: '顶层思考',
        timestamp: '2026-01-01',
        metadata: { reasoning: 'metadata 中的思考' },
      }],
      total: 1,
    })
    const msgs = await loadMessages('s1')
    expect(msgs[0]!.reasoning).toBe('顶层思考')
  })

  it('reasoning is undefined when neither top-level nor metadata has it', async () => {
    listSessionMessages.mockResolvedValueOnce({
      messages: [{
        id: 'm5', role: 'user', content: '普通消息',
        timestamp: '2026-01-01',
      }],
      total: 1,
    })
    const msgs = await loadMessages('s1')
    expect(msgs[0]!.reasoning).toBeUndefined()
  })

  it('removeMessage removes the message from subsequent loads', async () => {
    const backendMessages = [
      { id: 'm1', role: 'user', content: 'hello', timestamp: '2026-01-01' },
      { id: 'm2', role: 'assistant', content: 'hi', timestamp: '2026-01-01' },
    ]
    listSessionMessages.mockImplementation(() =>
      Promise.resolve({ messages: [...backendMessages], total: backendMessages.length }),
    )

    const before = await loadMessages('s1')
    expect(before.map((msg) => msg.id)).toContain('m1')

    // 删除后端消息后模拟后端不再返回该消息
    deleteMessageApi.mockResolvedValueOnce({ message: 'deleted' })
    await removeMessage('m1')
    expect(deleteMessageApi).toHaveBeenCalledWith('m1')

    // 模拟后端删除后返回的列表
    listSessionMessages.mockImplementation(() =>
      Promise.resolve({
        messages: backendMessages.filter(m => m.id !== 'm1'),
        total: 1,
      }),
    )
    const after = await loadMessages('s1')
    expect(after.map((msg) => msg.id)).not.toContain('m1')
  })

  // ─── persistMessage ───
  it('persistMessage returns true (backend handles persistence)', async () => {
    const result = await persistMessage(
      { id: 'm1', role: 'assistant', content: 'done', timestamp: '2026-01-01', agent_name: 'Bot' },
      's1',
    )
    expect(result).toBe(true)
  })

  // ─── loadArtifacts ───
  it('loadArtifacts returns empty array (in-memory only)', async () => {
    const artifacts = await loadArtifacts('s1')
    expect(artifacts).toEqual([])
  })

  // ─── saveArtifact ───
  it('saveArtifact is a no-op', async () => {
    await saveArtifact('s1', { id: 'a1', type: 'code', title: 'Snippet', language: 'ts', content: 'test', messageId: 'm1', createdAt: '' })
    // Should not throw
    expect(true).toBe(true)
  })

  // ─── lastSessionId (localStorage) ───
  it('getLastSessionId returns null when not set', () => {
    expect(getLastSessionId()).toBeNull()
  })

  it('setLastSessionId and getLastSessionId round-trip', () => {
    setLastSessionId('s1')
    expect(getLastSessionId()).toBe('s1')
  })
})
