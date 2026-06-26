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

    it('handleRetry surfaces backend delete failures via toast + logger.error', async () => {
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
      // The retry flow itself still proceeds (UI already updated optimistically).
      expect(mockSend).toHaveBeenCalledWith('hello')
      loggerSpy.mockRestore()
      vi.mocked(removeMessage).mockResolvedValue(undefined)
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
  })
})
