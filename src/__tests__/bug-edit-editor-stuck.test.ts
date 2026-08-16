// RED：编辑提交成功后编辑框必须关闭（BUG-20260816-002）。
// 现状：confirmEdit 成功路径在 selectSession 竞态/切换失败时直接 return，
// cancelEdit 不执行 → editingMsgId 残留 → 编辑框仍显示，且 fork 分支已创建。
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/api/chat', () => ({
  forkSession: vi.fn().mockResolvedValue({ session: { id: 'edit-branch' } }),
  deleteSession: vi.fn().mockResolvedValue(undefined),
}))

import { useChatActions } from '@/composables/useChatActions'
import * as chatApiMocks from '@/api/chat'

function makeMockChatStore(overrides: {
  messages?: Array<{ id: string; role: string; content: string; timestamp: string }>
  model?: string
  selectSessionImpl?: (sessionId: string) => Promise<void> | void
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
  store.selectSession.mockImplementation(
    overrides.selectSessionImpl ??
      (async (sessionId: string) => {
        store.currentSessionId = sessionId
      }),
  )
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

describe('confirmEdit closes the editor after a successful submission', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(chatApiMocks.forkSession).mockResolvedValue({ session: { id: 'edit-branch' } as any })
    vi.mocked(chatApiMocks.deleteSession).mockResolvedValue({ message: 'ok' } as any)
  })

  it('正常提交后编辑框关闭（editingMsgId 置空）', async () => {
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

    expect(chatApiMocks.forkSession).toHaveBeenCalled()
    expect(handleSend).toHaveBeenCalled()
    expect(editingMsgId.value).toBe(null)
    expect(editingText.value).toBe('')
  })

  it('selectSession 竞态（切换被覆盖）时编辑已完成，编辑框仍必须关闭', async () => {
    const messages = [
      { id: 'u1', role: 'user', content: 'hello', timestamp: '2025-01-01T00:00:00Z' },
    ]
    // 模拟 K12/场景 watcher 竞态：selectSession 设置 branch 后立即被另一处改回 source。
    const store = makeMockChatStore({
      messages,
      selectSessionImpl: async (sessionId: string) => {
        store.currentSessionId = sessionId
        store.currentSessionId = 'source-session'
      },
    })
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

    // 编辑已提交成功（fork + send 均完成），编辑框不得残留。
    expect(handleSend).toHaveBeenCalled()
    expect(editingMsgId.value).toBe(null)
    expect(editingText.value).toBe('')
  })
})
