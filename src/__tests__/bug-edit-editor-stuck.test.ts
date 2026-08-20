// 编辑确认后本会话替换重发：
// 确认即删除目标消息与尾部、以冻结路由在本会话重发；提交成功编辑框必须关闭；
// 发送失败则原样恢复尾部并保留编辑内容供重试。
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/api/chat', () => ({
  forkSession: vi.fn().mockResolvedValue({ session: { id: 'edit-branch' } }),
  deleteSession: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/services/messageService', () => ({
  removeMessage: vi.fn().mockResolvedValue({ message: 'ok' }),
}))

import { useChatActions } from '@/composables/useChatActions'
import * as chatApiMocks from '@/api/chat'

function makeMockChatStore(overrides: {
  messages?: Array<{ id: string; role: string; content: string; timestamp: string }>
  model?: string
}) {
  const messages = overrides.messages ?? []
  const store: any = {
    messages,
    currentSessionId: 'source-session',
    agentRole: '',
    chatMode: 'agent',
    thinkingEnabled: false,
    streaming: false,
    chatParams: { model: overrides.model ?? 'gpt-4' },
    setMessageFeedback: vi.fn().mockResolvedValue(null),
    loadSessions: vi.fn().mockResolvedValue(undefined),
    selectSession: vi.fn<(sessionId: string) => Promise<void>>(),
  }
  store.selectSession.mockImplementation(async (sessionId: string) => {
    store.currentSessionId = sessionId
  })
  return store
}

function makeMockToast() {
  return {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    toast: vi.fn(),
  }
}

describe('confirmEdit 本会话替换重发', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('正常提交后编辑框关闭（editingMsgId 置空），不创建分支', async () => {
    const messages = [
      { id: 'u1', role: 'user', content: 'hello', timestamp: '2025-01-01T00:00:00Z' },
      { id: 'a1', role: 'assistant', content: 'hi', timestamp: '2025-01-01T00:00:01Z' },
    ]
    const store = makeMockChatStore({ messages })
    const toast = makeMockToast()
    const handleSend = vi.fn().mockResolvedValue(true)
    const { confirmEdit, editingMsgId, editingText } = useChatActions(
      store,
      toast as any,
      handleSend as any,
    )
    editingMsgId.value = 'u1'
    editingText.value = 'updated text'

    await confirmEdit('u1')

    expect(chatApiMocks.forkSession).not.toHaveBeenCalled()
    expect(chatApiMocks.deleteSession).not.toHaveBeenCalled()
    expect(handleSend).toHaveBeenCalled()
    expect(editingMsgId.value).toBe(null)
    expect(editingText.value).toBe('')
  })

  it('发送失败时恢复被删除的尾部并保留编辑内容供重试', async () => {
    const messages = [
      { id: 'u1', role: 'user', content: 'hello', timestamp: '2025-01-01T00:00:00Z' },
      { id: 'a1', role: 'assistant', content: 'hi', timestamp: '2025-01-01T00:00:01Z' },
    ]
    const store = makeMockChatStore({ messages })
    const toast = makeMockToast()
    const handleSend = vi.fn().mockResolvedValue(false)
    const { confirmEdit, editingMsgId, editingText } = useChatActions(
      store,
      toast as any,
      handleSend as any,
    )
    editingMsgId.value = 'u1'
    editingText.value = 'updated text'

    await confirmEdit('u1')

    expect(handleSend).toHaveBeenCalled()
    expect(store.messages.map((m: { id: string }) => m.id)).toEqual(['u1', 'a1'])
    expect(editingMsgId.value).toBe('u1')
    expect(editingText.value).toBe('updated text')
    expect(toast.error).toHaveBeenCalled()
  })

  it('后端删除失败时回滚全部消息并保留草稿，不重发', async () => {
    const messages = [
      { id: 'u1', role: 'user', content: 'hello', timestamp: '2025-01-01T00:00:00Z' },
    ]
    const store = makeMockChatStore({ messages })
    const toast = makeMockToast()
    const handleSend = vi.fn().mockResolvedValue(true)
    const { confirmEdit, editingMsgId, editingText } = useChatActions(
      store,
      toast as any,
      handleSend as any,
    )
    editingMsgId.value = 'u1'
    editingText.value = 'updated text'

    vi.mocked(chatApiMocks.forkSession)
    const messageService = await import('@/services/messageService')
    vi.mocked(messageService.removeMessage).mockRejectedValueOnce(new Error('boom'))

    await confirmEdit('u1')

    expect(handleSend).not.toHaveBeenCalled()
    expect(store.messages.map((m: { id: string }) => m.id)).toEqual(['u1'])
    expect(editingMsgId.value).toBe('u1')
    expect(editingText.value).toBe('updated text')
    expect(toast.error).toHaveBeenCalled()
  })
})