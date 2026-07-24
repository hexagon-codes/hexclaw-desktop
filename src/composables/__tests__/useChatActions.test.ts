import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/services/messageService', () => ({
  removeMessage: vi.fn().mockResolvedValue(undefined),
}))

import { useChatActions } from '../useChatActions'

function makeMockStore() {
  return {
    messages: [
      { id: 'u1', role: 'user', content: 'hello', timestamp: '' },
      { id: 'a1', role: 'assistant', content: 'hi there', timestamp: '', metadata: {} },
    ],
    chatParams: { model: 'gpt-4' },
    setMessageFeedback: vi.fn().mockResolvedValue(null),
  }
}

function makeMockToast() {
  return { success: vi.fn(), error: vi.fn() }
}

describe('useChatActions', () => {
  let mockSend: (text: string, files?: File[]) => Promise<boolean>

  beforeEach(() => {
    vi.clearAllMocks()
    mockSend = vi.fn().mockResolvedValue(true) as unknown as (text: string, files?: File[]) => Promise<boolean>
  })

  it('handleRetry finds user message and re-sends', async () => {
    const store = makeMockStore()
    const { handleRetry } = useChatActions(store as any, makeMockToast() as any, mockSend)
    await handleRetry(1) // retry from assistant msg at index 1
    expect(mockSend).toHaveBeenCalledWith('hello')
    expect(store.messages).toHaveLength(0) // both messages spliced
  })

  it('handleRetry does nothing when no previous user message', async () => {
    const store = makeMockStore()
    store.messages = [{ id: 'a1', role: 'assistant', content: 'orphan', timestamp: '' }]
    const { handleRetry } = useChatActions(store as any, makeMockToast() as any, mockSend)
    await handleRetry(0)
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('handleRetry does nothing when the target message is no longer an assistant reply', async () => {
    const store = makeMockStore()
    store.messages = [
      { id: 'u1', role: 'user', content: 'hello', timestamp: '' },
      { id: 'u2', role: 'user', content: 'later question', timestamp: '' },
    ]
    const { handleRetry } = useChatActions(store as any, makeMockToast() as any, mockSend)
    await handleRetry(1)
    expect(mockSend).not.toHaveBeenCalled()
    expect(store.messages).toHaveLength(2)
  })

  it('handleLike toggles like feedback', async () => {
    const store = makeMockStore()
    const { handleLike } = useChatActions(store as any, makeMockToast() as any, mockSend)
    await handleLike('a1')
    expect(store.setMessageFeedback).toHaveBeenCalledWith('a1', 'like')
  })

  it('handleLike removes like when already liked', async () => {
    const store = makeMockStore()
    store.messages[1]!.metadata = { user_feedback: 'like' }
    const { handleLike } = useChatActions(store as any, makeMockToast() as any, mockSend)
    await handleLike('a1')
    expect(store.setMessageFeedback).toHaveBeenCalledWith('a1', null)
  })

  it('handleDislike toggles dislike feedback', async () => {
    const store = makeMockStore()
    const { handleDislike } = useChatActions(store as any, makeMockToast() as any, mockSend)
    await handleDislike('a1')
    expect(store.setMessageFeedback).toHaveBeenCalledWith('a1', 'dislike')
  })

  it('handleEdit sets editing state', () => {
    const store = makeMockStore()
    const { handleEdit, editingMsgId, editingText } = useChatActions(store as any, makeMockToast() as any, mockSend)
    handleEdit(0) // edit user message at index 0
    expect(editingMsgId.value).toBe('u1')
    expect(editingText.value).toBe('hello')
  })

  it('handleEdit ignores non-user messages', () => {
    const store = makeMockStore()
    const { handleEdit, editingMsgId } = useChatActions(store as any, makeMockToast() as any, mockSend)
    handleEdit(1) // assistant message
    expect(editingMsgId.value).toBeNull()
  })

  it('cancelEdit clears editing state', () => {
    const store = makeMockStore()
    const { handleEdit, cancelEdit, editingMsgId, editingText } = useChatActions(store as any, makeMockToast() as any, mockSend)
    handleEdit(0)
    cancelEdit()
    expect(editingMsgId.value).toBeNull()
    expect(editingText.value).toBe('')
  })

  it('confirmEdit removes old messages and re-sends', async () => {
    const store = makeMockStore()
    const { handleEdit, confirmEdit, editingText } = useChatActions(store as any, makeMockToast() as any, mockSend)
    handleEdit(0)
    editingText.value = 'updated question'
    await confirmEdit('u1')
    expect(mockSend).toHaveBeenCalledWith('updated question')
    expect(store.messages).toHaveLength(0)
  })

  it('confirmEdit preserves canonical leading and trailing whitespace byte-for-byte', async () => {
    const store = makeMockStore()
    const { handleEdit, confirmEdit, editingText } = useChatActions(
      store as any,
      makeMockToast() as any,
      mockSend,
    )
    handleEdit(0)
    const canonical = '\n  题目 $2\\frac{3}{4}$' + '  \n'
    editingText.value = canonical

    await confirmEdit('u1')

    expect(mockSend).toHaveBeenCalledWith(canonical)
  })

  // ── BUG-20260625：会话上传图片→编辑→提交，图片丢失 ──
  // 根因：confirmEdit/handleRetry 重发只带 text，丢掉原用户消息 metadata.attachments（图片）。
  const IMG = { type: 'image', name: 'photo.png', mime: 'image/png', data: 'data:image/png;base64,AAAA' }

  function makeStoreWithImage() {
    return {
      messages: [
        { id: 'u1', role: 'user', content: '看这张图', timestamp: '', metadata: { attachments: [IMG] } },
        { id: 'a1', role: 'assistant', content: '收到', timestamp: '', metadata: {} },
      ],
      chatParams: { model: 'gpt-4' },
      setMessageFeedback: vi.fn().mockResolvedValue(null),
    }
  }

  it('BUG-20260625 confirmEdit 重发携带原消息的图片附件（不丢图）', async () => {
    const store = makeStoreWithImage()
    const send = vi.fn().mockResolvedValue(true)
    const { handleEdit, confirmEdit, editingText } = useChatActions(store as any, makeMockToast() as any, send as any)
    handleEdit(0)
    editingText.value = '看这张图（改）'
    await confirmEdit('u1')

    expect(send).toHaveBeenCalledTimes(1)
    const [text, , options] = send.mock.calls[0]!
    expect(text).toBe('看这张图（改）')
    expect(options?.attachments).toEqual([IMG]) // ★图片必须随编辑重发
  })

  it('BUG-20260625 handleRetry 重发携带原用户消息的图片附件（不丢图）', async () => {
    const store = makeStoreWithImage()
    const send = vi.fn().mockResolvedValue(true)
    const { handleRetry } = useChatActions(store as any, makeMockToast() as any, send as any)
    await handleRetry(1) // 从 assistant 触发，回溯到 u1（带图）
    expect(send).toHaveBeenCalledTimes(1)
    const [text, , options] = send.mock.calls[0]!
    expect(text).toBe('看这张图')
    expect(options?.attachments).toEqual([IMG])
  })

  it('confirmEdit with empty text calls cancelEdit instead', async () => {
    const store = makeMockStore()
    const { handleEdit, confirmEdit, editingText, editingMsgId } = useChatActions(store as any, makeMockToast() as any, mockSend)
    handleEdit(0)
    editingText.value = '   '
    await confirmEdit('u1')
    expect(mockSend).not.toHaveBeenCalled()
    expect(editingMsgId.value).toBeNull()
  })

  it('confirmEdit does nothing when the edited message has already disappeared', async () => {
    const store = makeMockStore()
    const { handleEdit, confirmEdit, editingText, editingMsgId } = useChatActions(
      store as any,
      makeMockToast() as any,
      mockSend,
    )

    handleEdit(0)
    editingText.value = 'updated question'
    store.messages = []

    await confirmEdit('u1')

    expect(mockSend).not.toHaveBeenCalled()
    expect(editingMsgId.value).toBeNull()
  })

  // Review backlog: removeMessage failures were swallowed with .catch(() => {})
  // — the message silently survived in the backend and reappeared on reload.
  describe('removeMessage error surfacing', () => {
    async function flushMicrotasks() {
      await Promise.resolve()
      await Promise.resolve()
    }

    // AP-094：删除失败必须**回滚 + 中止重发**（旧行为"删一半仍重发"→重载重复，是 bug）。
    it('handleRetry rolls back and aborts (no resend) when a backend delete fails', async () => {
      const { removeMessage } = await import('@/services/messageService')
      const { logger } = await import('@/utils/logger')
      vi.mocked(removeMessage).mockRejectedValue(new Error('delete failed'))
      const loggerSpy = vi.spyOn(logger, 'error').mockImplementation(() => {})

      const store = makeMockStore()
      const toast = makeMockToast()
      const { handleRetry } = useChatActions(store as any, toast as any, mockSend)
      await handleRetry(1)
      await flushMicrotasks()

      expect(toast.error).toHaveBeenCalled()
      expect(loggerSpy).toHaveBeenCalledWith(expect.stringContaining('removeMessage'))
      // ★关键修正：删除失败 → 不重发（杜绝"旧消息残留 + 新消息落库 = 重载重复"）
      expect(mockSend).not.toHaveBeenCalled()
      // ★回滚：被乐观移除的消息原样恢复，用户输入不丢
      expect(store.messages.map((m) => m.id)).toEqual(['u1', 'a1'])
      loggerSpy.mockRestore()
      vi.mocked(removeMessage).mockResolvedValue(undefined)
    })

    it('handleRetry toasts (not silently no-ops) when no model is selected', async () => {
      const store = makeMockStore()
      store.chatParams.model = '' // 未选模型
      const toast = makeMockToast()
      const { removeMessage } = await import('@/services/messageService')
      const { handleRetry } = useChatActions(store as any, toast as any, mockSend)
      await handleRetry(1)
      expect(toast.error).toHaveBeenCalled()
      expect(mockSend).not.toHaveBeenCalled()
      expect(vi.mocked(removeMessage)).not.toHaveBeenCalled() // 未删任何消息
      expect(store.messages).toHaveLength(2) // 原样保留
    })

    it('confirmEdit surfaces backend delete failures via toast', async () => {
      const { removeMessage } = await import('@/services/messageService')
      const { logger } = await import('@/utils/logger')
      vi.mocked(removeMessage).mockRejectedValue(new Error('delete failed'))
      vi.spyOn(logger, 'error').mockImplementation(() => {})

      const store = makeMockStore()
      const toast = makeMockToast()
      const { handleEdit, confirmEdit, editingText } = useChatActions(store as any, toast as any, mockSend)
      handleEdit(0)
      editingText.value = 'updated question'
      await confirmEdit('u1')
      await flushMicrotasks()

      expect(toast.error).toHaveBeenCalled()
      vi.mocked(removeMessage).mockResolvedValue(undefined)
    })

    it('does not toast when deletes succeed', async () => {
      const store = makeMockStore()
      const toast = makeMockToast()
      const { handleRetry } = useChatActions(store as any, toast as any, mockSend)
      await handleRetry(1)
      await flushMicrotasks()

      expect(toast.error).not.toHaveBeenCalled()
    })

    it('BUG-20260629 handleRetry 删除后端真实 message id，避免旧回复重载后复活', async () => {
      const { removeMessage } = await import('@/services/messageService')
      const store = makeMockStore()
      store.messages[1]!.metadata = { backend_message_id: 'backend-a1' }

      const { handleRetry } = useChatActions(store as any, makeMockToast() as any, mockSend)
      await handleRetry(1)

      expect(vi.mocked(removeMessage)).toHaveBeenCalledWith('u1')
      expect(vi.mocked(removeMessage)).toHaveBeenCalledWith('backend-a1')
      expect(vi.mocked(removeMessage)).not.toHaveBeenCalledWith('a1')
    })

    // BUG（2026-06-28 用户反馈）：编辑早期消息删整条尾巴时，旧实现逐条串行 await → 提交后卡几秒。
    // 改并行删除：所有 removeMessage 必须在任一 resolve 之前就全部发出（折叠为一批往返）。
    it('confirmEdit 删除整轮尾巴时并行发出全部删除请求（不再串行卡顿）', async () => {
      const { removeMessage } = await import('@/services/messageService')
      let resolveCount = 0
      const deferred: Array<() => void> = []
      vi.mocked(removeMessage).mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            deferred.push(() => {
              resolveCount++
              resolve()
            })
          }),
      )

      const store = makeMockStore()
      // 编辑第一条 → 其后整条尾巴（u1 + a1 + a2 + a3）都要删。
      store.messages.push(
        { id: 'a2', role: 'assistant', content: 'more', timestamp: '', metadata: {} } as any,
        { id: 'a3', role: 'assistant', content: 'even more', timestamp: '', metadata: {} } as any,
      )
      const toast = makeMockToast()
      const { handleEdit, confirmEdit, editingText } = useChatActions(store as any, toast as any, mockSend)
      handleEdit(0)
      editingText.value = 'updated question'
      const p = confirmEdit('u1')
      await flushMicrotasks()

      // 串行实现此刻只会发出 1 个删除（在等第 1 个 resolve）；并行实现 4 个全部已发出。
      expect(vi.mocked(removeMessage)).toHaveBeenCalledTimes(4)
      expect(resolveCount).toBe(0) // 都还没 resolve，证明是并发等待而非串行

      deferred.forEach((fn) => fn())
      await p
      await flushMicrotasks()
      expect(mockSend).toHaveBeenCalledWith('updated question')
      vi.mocked(removeMessage).mockResolvedValue(undefined)
    })
  })
})
