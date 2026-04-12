import { flushPromises } from '@vue/test-utils'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'

const searchKnowledge = vi.hoisted(() => vi.fn().mockResolvedValue({ result: [] }))
const parseDocument = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ text: 'parsed', fileName: 'test.txt' }),
)

vi.mock('@/api/knowledge', () => ({ searchKnowledge }))
vi.mock('@/utils/file-parser', () => ({
  isDocumentFile: vi.fn().mockReturnValue(false),
  parseDocument,
}))

import { useChatSend } from '../useChatSend'

function makeDeps() {
  const messages: Array<{ id: string; role: string; content: string; timestamp: string }> = []
  const sendMessage = vi.fn().mockImplementation(async (text: string) => {
    messages.push({ id: 'u1', role: 'user', content: text, timestamp: '' })
    return { id: 'a1', role: 'assistant', content: 'reply', timestamp: '' }
  })

  return {
    chatStore: {
      messages,
      sendMessage,
      chatMode: 'chat',
      agentRole: '',
      chatParams: { model: 'test-model' as string | undefined },
    },
    parsedDocument: ref(null as { text: string; fileName: string; pageCount?: number } | null),
    attachmentPreview: ref(null as { url: string; name: string; type: 'image' | 'video' | 'file'; file: File } | null),
    clearAttachmentPreview: vi.fn(),
    scrollToBottom: vi.fn(),
    attachConversationAutomationActions: vi.fn().mockResolvedValue(undefined),
  }
}

describe('useChatSend', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    searchKnowledge.mockResolvedValue({ result: [] })
    parseDocument.mockResolvedValue({ text: 'parsed', fileName: 'test.txt' })
  })

  it('sends message through chatStore.sendMessage', async () => {
    const deps = makeDeps()
    const { handleSend } = useChatSend(deps as any)
    await handleSend('hello')
    expect(deps.chatStore.sendMessage).toHaveBeenCalledWith('hello', undefined, undefined)
  })

  it('allows Agent mode sends when model is undefined', async () => {
    const deps = makeDeps()
    deps.chatStore.chatParams.model = undefined

    const { handleSend } = useChatSend(deps as any)

    await expect(handleSend('hello')).resolves.toBe(true)
    expect(deps.chatStore.sendMessage).toHaveBeenCalledWith('hello', undefined, undefined)
  })

  it('injects knowledge context when RAG hits score >= 0.35', async () => {
    searchKnowledge.mockResolvedValueOnce({
      result: [{ content: 'relevant info', score: 0.8, doc_title: 'Doc1' }],
    })
    const deps = makeDeps()
    const { handleSend } = useChatSend(deps as any)
    await handleSend('question')
    const call = deps.chatStore.sendMessage.mock.calls[0]!
    expect(call[2]).toBeDefined() // backendText option
    expect(call[2]!.backendText).toContain('[知识库参考信息')
    expect(call[2]!.backendText).toContain('relevant info')
  })

  it('does not inject knowledge when scores are low', async () => {
    searchKnowledge.mockResolvedValueOnce({
      result: [{ content: 'irrelevant', score: 0.1 }],
    })
    const deps = makeDeps()
    const { handleSend } = useChatSend(deps as any)
    await handleSend('question')
    const call = deps.chatStore.sendMessage.mock.calls[0]!
    expect(call[2]).toBeUndefined()
  })

  it('continues without knowledge when searchKnowledge throws', async () => {
    searchKnowledge.mockRejectedValueOnce(new Error('KB unavailable'))
    const deps = makeDeps()
    const { handleSend } = useChatSend(deps as any)
    await handleSend('question')
    expect(deps.chatStore.sendMessage).toHaveBeenCalled()
  })

  it('prepends parsed document to message', async () => {
    const deps = makeDeps()
    deps.parsedDocument.value = { text: 'doc content', fileName: 'report.pdf', pageCount: 3 }
    const { handleSend } = useChatSend(deps as any)
    await handleSend('summarize')
    const call = deps.chatStore.sendMessage.mock.calls[0]!
    expect(call[0]).toContain('[文件: report.pdf (3页)]')
    expect(call[0]).toContain('doc content')
    expect(call[0]).toContain('summarize')
  })

  it('calls scrollToBottom after send', async () => {
    const deps = makeDeps()
    const { handleSend } = useChatSend(deps as any)
    await handleSend('test')
    expect(deps.scrollToBottom).toHaveBeenCalled()
  })

  it('resolves true once the user message is accepted without waiting for the assistant reply', async () => {
    const deps = makeDeps()
    let resolveSend: ((value: { id: string; role: 'assistant'; content: string; timestamp: string }) => void) | null = null
    deps.chatStore.sendMessage = vi.fn().mockImplementation(() => {
      deps.chatStore.messages.push({
        id: 'user-1',
        role: 'user',
        content: 'hello',
        timestamp: '',
      })
      return new Promise((resolve) => {
        resolveSend = resolve
      })
    })

    const { handleSend } = useChatSend(deps as any)
    const resultPromise = handleSend('hello')

    let settled = false
    let result: boolean | undefined
    void resultPromise.then((value) => {
      settled = true
      result = value
    })

    await flushPromises()

    expect(settled).toBe(true)
    expect(result).toBe(true)

    expect(resolveSend).not.toBeNull()
    resolveSend!({ id: 'a1', role: 'assistant', content: 'reply', timestamp: '' })
    await resultPromise
  })

  it('returns false and preserves legacy attachment state when send is rejected', async () => {
    const deps = makeDeps()
    deps.chatStore.sendMessage = vi.fn().mockResolvedValue(null)
    deps.attachmentPreview.value = {
      url: 'blob:test',
      name: 'draft.txt',
      type: 'file',
      file: new File(['draft'], 'draft.txt', { type: 'text/plain' }),
    }
    deps.parsedDocument.value = { text: 'draft text', fileName: 'draft.txt' }

    const { handleSend } = useChatSend(deps as any)

    await expect(handleSend('hello')).resolves.toBe(false)
    expect(deps.clearAttachmentPreview).not.toHaveBeenCalled()
    expect(deps.attachmentPreview.value?.name).toBe('draft.txt')
    expect(deps.parsedDocument.value?.text).toBe('draft text')
  })

  it('clears stale researcher role when the user has exited research mode', async () => {
    const deps = makeDeps()
    deps.chatStore.chatMode = 'chat'
    deps.chatStore.agentRole = 'researcher'

    const { handleSend } = useChatSend(deps as any)
    await handleSend('normal chat')

    expect(deps.chatStore.agentRole).toBe('')
  })

  it('sends video attachments with type=video instead of downgrading them to generic files', async () => {
    parseDocument.mockRejectedValueOnce(new Error('unsupported video parsing'))

    const deps = makeDeps()
    const { handleSend } = useChatSend(deps as any)
    const video = new File(['video-bytes'], 'demo.mp4', { type: 'video/mp4' })

    await handleSend('watch this', [video])

    const call = deps.chatStore.sendMessage.mock.calls[0]!
    expect(call[1]).toEqual([
      expect.objectContaining({
        type: 'video',
        name: 'demo.mp4',
        mime: 'video/mp4',
      }),
    ])
  })
})
