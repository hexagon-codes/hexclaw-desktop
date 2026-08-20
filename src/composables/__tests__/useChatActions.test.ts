import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/services/messageService', () => ({
  removeMessage: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/api/chat', () => ({
  forkSession: vi.fn().mockResolvedValue({ session: { id: 'edit-branch' } }),
  deleteSession: vi.fn().mockResolvedValue({ message: 'ok' }),
}))

import { deleteSession, forkSession } from '@/api/chat'
import { bindSessionAgent, getSessionAgent } from '@/stores/session-agent-binding'
import { getSessionModel, setSessionModel } from '@/stores/session-model-binding'
import { setSessionDeepThinking } from '@/stores/session-thinking-preference'
import { useChatActions } from '../useChatActions'

function makeMockStore() {
  const store = {
    currentSessionId: 'source-session',
    agentRole: '',
    chatMode: 'chat',
    thinkingEnabled: false,
    messages: [
      { id: 'u1', role: 'user', content: 'hello', timestamp: '' },
      { id: 'a1', role: 'assistant', content: 'hi there', timestamp: '', metadata: {} },
    ],
    chatParams: { model: 'gpt-4' },
    setMessageFeedback: vi.fn().mockResolvedValue(null),
    loadSessions: vi.fn().mockResolvedValue(undefined),
    selectSession: vi.fn(),
    deleteSession: vi.fn().mockResolvedValue(undefined),
  }
  store.selectSession.mockImplementation(async (sessionId: string) => {
    store.currentSessionId = sessionId
  })
  return store
}

function makeMockToast() {
  return { success: vi.fn(), error: vi.fn() }
}

describe('useChatActions', () => {
  let mockSend: (text: string, files?: File[]) => Promise<boolean>

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(forkSession).mockResolvedValue({ session: { id: 'edit-branch' } } as never)
    vi.mocked(deleteSession).mockResolvedValue({ message: 'ok' } as never)
    localStorage.clear()
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

  it('confirmEdit 确认后在本会话删除目标及尾部并定向重发（不建分支、不切换会话）', async () => {
    const { removeMessage } = await import('@/services/messageService')
    const store = makeMockStore()
    const toast = makeMockToast()
    const { handleEdit, confirmEdit, editingMsgId, editingText } = useChatActions(store as any, toast as any, mockSend)
    handleEdit(0)
    editingText.value = 'updated question'
    await confirmEdit('u1')
    expect(forkSession).not.toHaveBeenCalled()
    expect(store.loadSessions).not.toHaveBeenCalled()
    expect(store.selectSession).not.toHaveBeenCalled()
    expect(store.currentSessionId).toBe('source-session')
    expect(vi.mocked(removeMessage)).toHaveBeenCalledWith('u1')
    expect(vi.mocked(removeMessage)).toHaveBeenCalledWith('a1')
    expect(mockSend).toHaveBeenCalledWith('updated question', undefined, {
      targetSessionId: 'source-session',
    })
    expect(store.messages).toHaveLength(0)
    expect(editingMsgId.value).toBeNull()
  })

  it.each([
    { target: 'u1', index: 0, ids: ['u1', 'a1'] },
    { target: 'u2', index: 2, ids: ['u1', 'a1', 'u2', 'a2', 'u3', 'a3'] },
    { target: 'u3', index: 4, ids: ['u1', 'a1', 'u2', 'a2', 'u3'] },
  ])('编辑 $target 时删除目标消息及其后全部并在本会话重发', async ({ target, index, ids }) => {
    const { removeMessage } = await import('@/services/messageService')
    const store = makeMockStore()
    store.messages = ids.map((id) => ({
      id,
      role: id.startsWith('u') ? 'user' : 'assistant',
      content: id,
      timestamp: '',
      metadata: {},
    }))
    const { handleEdit, confirmEdit, editingText } = useChatActions(store as any, makeMockToast() as any, mockSend)

    handleEdit(index)
    editingText.value = `${target}-edited`
    await confirmEdit(target)

    expect(forkSession).not.toHaveBeenCalled()
    const deleted = ids.slice(index)
    expect(vi.mocked(removeMessage).mock.calls.map((call) => call[0])).toEqual(deleted)
    expect(mockSend).toHaveBeenCalledWith(`${target}-edited`, undefined, {
      targetSessionId: 'source-session',
    })
    expect(store.messages).toHaveLength(index)
  })

  it('确认编辑不再创建分支，也不写入或清理任何分支绑定', async () => {
    const store = makeMockStore()
    store.agentRole = 'k12-tutor-mingming'
    bindSessionAgent('source-session', 'k12-tutor-mingming')
    setSessionModel('source-session', {
      model: 'gpt-5.6-sol',
      providerId: 'p-sol',
      providerKey: 'hexclaw-gpt',
      capabilities: ['text', 'vision'],
    })
    setSessionDeepThinking('source-session', true)
    const { handleEdit, confirmEdit } = useChatActions(store as any, makeMockToast() as any, mockSend)

    handleEdit(0)
    await confirmEdit('u1')

    expect(forkSession).not.toHaveBeenCalled()
    expect(getSessionAgent('edit-branch')).toBe('')
    expect(getSessionModel('edit-branch')).toBeNull()
  })

  it('keeps source route, attachments, history, and draft when an edited service submission fails', async () => {
    const store = makeStoreWithImage()
    const toast = makeMockToast()
    const snapshot = Object.freeze({
      agentRole: 'translator',
      chatParams: Object.freeze({
        provider: 'hexclaw-gpt',
        model: 'gpt-5.6-sol',
        temperature: 0.4,
        maxTokens: 2048,
      }),
      thinkingEnabled: true,
    })
    const submitEdited = vi.fn().mockResolvedValue(false)
    const captureRoute = vi.fn().mockReturnValue(snapshot)
    const before = store.messages.map((message) => ({ ...message }))
    const { handleEdit, confirmEdit, editingMsgId, editingText } = useChatActions(
      store as any,
      toast as any,
      mockSend,
      submitEdited,
      captureRoute,
    )

    handleEdit(0)
    editingText.value = '图片说明已修改'
    await confirmEdit('u1')

    expect(captureRoute).toHaveBeenCalledWith('source-session')
    expect(submitEdited).toHaveBeenCalledWith({
      sourceMessage: expect.objectContaining({ id: 'u1' }),
      targetSessionId: 'source-session',
      content: '图片说明已修改',
      carry: { attachments: [IMG] },
      routeSnapshot: snapshot,
    })
    expect(store.messages).toEqual(before)
    expect(editingMsgId.value).toBe('u1')
    expect(editingText.value).toBe('图片说明已修改')
    expect(toast.error).toHaveBeenCalled()
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

    expect(mockSend).toHaveBeenCalledWith(canonical, undefined, {
      targetSessionId: 'source-session',
    })
  })

  it('submits an edit exactly once when confirm is triggered twice before the range delete resolves', async () => {
    const { removeMessage } = await import('@/services/messageService')
    const store = makeMockStore()
    let resolveDelete!: (value: unknown) => void
    vi.mocked(removeMessage).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveDelete = resolve
      }) as never,
    )
    const { handleEdit, confirmEdit, editingText } = useChatActions(
      store as any,
      makeMockToast() as any,
      mockSend,
    )
    handleEdit(0)
    editingText.value = 'updated question'

    const first = confirmEdit('u1')
    const second = confirmEdit('u1')

    expect(vi.mocked(removeMessage).mock.calls.length).toBe(2)
    resolveDelete(undefined)
    await Promise.all([first, second])

    expect(mockSend).toHaveBeenCalledTimes(1)
    expect(store.selectSession).not.toHaveBeenCalled()
  })

  it('does not submit into the source session when the user switches sessions while the range delete is pending', async () => {
    const { removeMessage } = await import('@/services/messageService')
    const store = makeMockStore()
    let resolveDelete!: (value: unknown) => void
    vi.mocked(removeMessage).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveDelete = resolve
      }) as never,
    )
    const { handleEdit, confirmEdit, editingMsgId, editingText } = useChatActions(
      store as any,
      makeMockToast() as any,
      mockSend,
    )
    handleEdit(0)
    editingText.value = 'updated question'

    const pending = confirmEdit('u1')
    store.currentSessionId = 'other-session'
    store.messages = []
    resolveDelete(undefined)
    await pending

    expect(store.selectSession).not.toHaveBeenCalled()
    expect(mockSend).not.toHaveBeenCalled()
    expect(store.currentSessionId).toBe('other-session')
    expect(editingMsgId.value).toBe('u1')
    expect(editingText.value).toBe('updated question')
  })

  it('确认即删除：提交期间目标及尾部已从当前会话移除，成功后留在原会话', async () => {
    const store = makeMockStore()
    let resolveSubmission!: (accepted: boolean) => void
    const submitEdited = vi.fn().mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveSubmission = resolve
      }),
    )
    const { handleEdit, confirmEdit, editingText } = useChatActions(
      store as any,
      makeMockToast() as any,
      mockSend,
      submitEdited,
    )
    handleEdit(0)
    editingText.value = 'updated question'

    const pending = confirmEdit('u1')
    await vi.waitFor(() => {
      expect(submitEdited).toHaveBeenCalledTimes(1)
    })
    expect(store.messages.map((message) => message.id)).toEqual([])
    expect(store.currentSessionId).toBe('source-session')
    resolveSubmission(true)
    await pending

    expect(store.currentSessionId).toBe('source-session')
    expect(store.selectSession).not.toHaveBeenCalled()
    expect(editingText.value).toBe('')
  })

  it('提交成功期间切换会话不偷焦点，编辑框正常关闭', async () => {
    const store = makeMockStore()
    let resolveSubmission!: (accepted: boolean) => void
    const submitEdited = vi.fn().mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveSubmission = resolve
      }),
    )
    const { handleEdit, confirmEdit, editingMsgId, editingText } = useChatActions(
      store as any,
      makeMockToast() as any,
      mockSend,
      submitEdited,
    )
    handleEdit(0)
    editingText.value = 'accepted in background'

    const pending = confirmEdit('u1')
    await vi.waitFor(() => expect(submitEdited).toHaveBeenCalledTimes(1))
    store.currentSessionId = 'other-session'
    resolveSubmission(true)
    await pending

    expect(store.currentSessionId).toBe('other-session')
    expect(store.selectSession).not.toHaveBeenCalled()
    expect(deleteSession).not.toHaveBeenCalled()
    expect(editingMsgId.value).toBeNull()
    expect(editingText.value).toBe('')
  })

  it('提交失败且用户已切走时不恢复尾部到错误会话、不偷焦点', async () => {
    const store = makeMockStore()
    let resolveSubmission!: (accepted: boolean) => void
    const submitEdited = vi.fn().mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveSubmission = resolve
      }),
    )
    const { handleEdit, confirmEdit, editingMsgId, editingText } = useChatActions(
      store as any,
      makeMockToast() as any,
      mockSend,
      submitEdited,
    )
    handleEdit(0)

    const pending = confirmEdit('u1')
    await vi.waitFor(() => expect(submitEdited).toHaveBeenCalledTimes(1))
    store.currentSessionId = 'other-session'
    store.messages = []
    resolveSubmission(false)
    await pending

    expect(store.currentSessionId).toBe('other-session')
    expect(store.selectSession).not.toHaveBeenCalled()
    expect(deleteSession).not.toHaveBeenCalled()
    expect(editingMsgId.value).toBe('u1')
    expect(editingText.value).toBe('hello')
  })

  // ── BUG-20260625：会话上传图片→编辑→提交，图片丢失 ──
  // 根因：confirmEdit/handleRetry 重发只带 text，丢掉原用户消息 metadata.attachments（图片）。
  const IMG = { type: 'image', name: 'photo.png', mime: 'image/png', data: 'data:image/png;base64,AAAA' }

  function makeStoreWithImage() {
    const store = {
      currentSessionId: 'source-session',
      agentRole: '',
      chatMode: 'chat',
      thinkingEnabled: false,
      messages: [
        { id: 'u1', role: 'user', content: '看这张图', timestamp: '', metadata: { attachments: [IMG] } },
        { id: 'a1', role: 'assistant', content: '收到', timestamp: '', metadata: {} },
      ],
      chatParams: { model: 'gpt-4' },
      setMessageFeedback: vi.fn().mockResolvedValue(null),
      loadSessions: vi.fn().mockResolvedValue(undefined),
      selectSession: vi.fn(),
      deleteSession: vi.fn().mockResolvedValue(undefined),
    }
    store.selectSession.mockImplementation(async (sessionId: string) => {
      store.currentSessionId = sessionId
    })
    return store
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

  it('BUG-20260724 image-only message can be submitted from edit with in-place replacement', async () => {
    const { removeMessage } = await import('@/services/messageService')
    const store = makeStoreWithImage()
    store.messages[0]!.content = ''
    const submitEdited = vi.fn().mockResolvedValue(true)
    const { handleEdit, confirmEdit, editingMsgId } = useChatActions(
      store as any,
      makeMockToast() as any,
      mockSend,
      submitEdited,
    )

    handleEdit(0)
    await confirmEdit('u1')

    expect(submitEdited).toHaveBeenCalledTimes(1)
    expect(submitEdited).toHaveBeenCalledWith({
      sourceMessage: expect.objectContaining({ id: 'u1' }),
      targetSessionId: 'source-session',
      content: '',
      carry: { attachments: [IMG] },
    })
    expect(mockSend).not.toHaveBeenCalled()
    expect(vi.mocked(removeMessage)).toHaveBeenCalledWith('u1')
    expect(store.messages).toHaveLength(0)
    expect(editingMsgId.value).toBeNull()
  })

  it('confirmEdit keeps the draft and restores the tail when the edited submission is rejected', async () => {
    const store = makeMockStore()
    const before = store.messages.map((message) => ({ ...message }))
    const submitEdited = vi.fn().mockResolvedValue(false)
    const { handleEdit, confirmEdit, editingMsgId, editingText } = useChatActions(
      store as any,
      makeMockToast() as any,
      mockSend,
      submitEdited,
    )

    handleEdit(0)
    editingText.value = 'updated question'
    await confirmEdit('u1')

    expect(store.messages).toEqual(before)
    expect(editingMsgId.value).toBe('u1')
    expect(editingText.value).toBe('updated question')
  })

  it('后端删除失败时回滚全部消息并保留草稿，不重发', async () => {
    const { removeMessage } = await import('@/services/messageService')
    const { logger } = await import('@/utils/logger')
    const store = makeMockStore()
    const before = store.messages.map((message) => ({ ...message }))
    const toast = makeMockToast()
    vi.mocked(removeMessage).mockRejectedValue(new Error('delete unavailable'))
    const loggerSpy = vi.spyOn(logger, 'error').mockImplementation(() => {})
    const { handleEdit, confirmEdit, editingMsgId, editingText } = useChatActions(
      store as any,
      toast as any,
      mockSend,
    )

    handleEdit(0)
    editingText.value = 'updated question'
    await confirmEdit('u1')

    expect(mockSend).not.toHaveBeenCalled()
    expect(store.selectSession).not.toHaveBeenCalled()
    expect(store.messages).toEqual(before)
    expect(editingMsgId.value).toBe('u1')
    expect(editingText.value).toBe('updated question')
    expect(toast.error).toHaveBeenCalled()
    loggerSpy.mockRestore()
    vi.mocked(removeMessage).mockResolvedValue(undefined)
  })

  it('定向重发被拒时留在原会话并恢复尾部', async () => {
    const store = makeMockStore()
    const before = store.messages.map((message) => ({ ...message }))
    const toast = makeMockToast()
    const rejectedSend = vi.fn().mockResolvedValue(false)
    const { handleEdit, confirmEdit, editingMsgId, editingText } = useChatActions(
      store as any,
      toast as any,
      rejectedSend,
    )

    handleEdit(0)
    editingText.value = 'updated question'
    await confirmEdit('u1')

    expect(rejectedSend).toHaveBeenCalledWith('updated question', undefined, {
      targetSessionId: 'source-session',
    })
    expect(store.currentSessionId).toBe('source-session')
    expect(store.messages).toEqual(before)
    expect(editingMsgId.value).toBe('u1')
    expect(editingText.value).toBe('updated question')
    expect(toast.error).toHaveBeenCalled()
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

    it('confirmEdit 确认后删除目标消息及会话尾部并重发', async () => {
      const { removeMessage } = await import('@/services/messageService')
      const store = makeMockStore()
      const toast = makeMockToast()
      const { handleEdit, confirmEdit, editingText } = useChatActions(store as any, toast as any, mockSend)
      handleEdit(0)
      editingText.value = 'updated question'
      await confirmEdit('u1')
      await flushMicrotasks()

      expect(vi.mocked(removeMessage)).toHaveBeenCalledWith('u1')
      expect(vi.mocked(removeMessage)).toHaveBeenCalledWith('a1')
      expect(store.messages).toHaveLength(0)
      expect(toast.error).not.toHaveBeenCalled()
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

    it('confirmEdit 删除目标之后的所有轮次并在本会话重发', async () => {
      const { removeMessage } = await import('@/services/messageService')
      const store = makeMockStore()
      store.messages.push(
        { id: 'a2', role: 'assistant', content: 'more', timestamp: '', metadata: {} } as any,
        { id: 'a3', role: 'assistant', content: 'even more', timestamp: '', metadata: {} } as any,
      )
      const toast = makeMockToast()
      const { handleEdit, confirmEdit, editingText } = useChatActions(store as any, toast as any, mockSend)
      handleEdit(0)
      editingText.value = 'updated question'
      await confirmEdit('u1')
      await flushMicrotasks()

      expect(vi.mocked(removeMessage).mock.calls.map((call) => call[0])).toEqual(['u1', 'a1', 'a2', 'a3'])
      expect(mockSend).toHaveBeenCalledWith('updated question', undefined, {
        targetSessionId: 'source-session',
      })
    })
  })
})
