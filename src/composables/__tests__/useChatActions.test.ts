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
  let mockSend: (text: string, files?: File[]) => Promise<void>

  beforeEach(() => {
    vi.clearAllMocks()
    mockSend = vi.fn().mockResolvedValue(undefined) as unknown as (text: string, files?: File[]) => Promise<void>
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
})
