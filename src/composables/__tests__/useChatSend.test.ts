import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'

const searchKnowledge = vi.hoisted(() => vi.fn().mockResolvedValue({ result: [] }))

vi.mock('@/api/knowledge', () => ({ searchKnowledge }))
vi.mock('@/utils/file-parser', () => ({
  isDocumentFile: vi.fn().mockReturnValue(false),
  parseDocument: vi.fn().mockResolvedValue({ text: 'parsed', fileName: 'test.txt' }),
}))

import { useChatSend } from '../useChatSend'

function makeDeps() {
  return {
    chatStore: {
      sendMessage: vi.fn().mockResolvedValue({ id: 'a1', role: 'assistant', content: 'reply', timestamp: '' }),
      chatMode: 'chat',
      agentRole: '',
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
  })

  it('sends message through chatStore.sendMessage', async () => {
    const deps = makeDeps()
    const { handleSend } = useChatSend(deps as any)
    await handleSend('hello')
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
})
