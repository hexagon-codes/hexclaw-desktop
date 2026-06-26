import { flushPromises } from '@vue/test-utils'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'

const searchKnowledge = vi.hoisted(() => vi.fn().mockResolvedValue({ result: [] }))
const parseDocument = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ text: 'parsed', fileName: 'test.txt' }),
)

const toastError = vi.hoisted(() => vi.fn())
const toastWarning = vi.hoisted(() => vi.fn())

vi.mock('@/api/knowledge', () => ({ searchKnowledge }))
vi.mock('@/utils/file-parser', () => ({
  isDocumentFile: vi.fn().mockReturnValue(false),
  parseDocument,
}))
vi.mock('../useToast', () => ({
  useToast: () => ({ success: vi.fn(), error: toastError, warning: toastWarning, info: vi.fn() }),
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
    parseDocument.mockReset()
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

  it('文档正文进隐藏上下文(backendText)，可见消息只留用户文字 + 文件卡片', async () => {
    const deps = makeDeps()
    deps.parsedDocument.value = { text: 'doc content', fileName: 'report.pdf', pageCount: 3 }
    deps.attachmentPreview.value = {
      url: 'blob:x', name: 'report.pdf', type: 'file',
      file: new File(['x'], 'report.pdf', { type: 'application/pdf' }),
    }
    const { handleSend } = useChatSend(deps as any)
    await handleSend('summarize')
    const call = deps.chatStore.sendMessage.mock.calls[0]!
    expect(call[0]).toBe('summarize') // 可见消息 = 用户文字，不含文档正文
    expect(call[2]!.backendText).toContain('doc content') // 正文进隐藏上下文
    expect(call[2]!.backendText).toContain('[用户问题]')
    expect(call[2]!.documents).toEqual([expect.objectContaining({ name: 'report.pdf' })]) // 文件卡片
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

  // ─── 文档解析失败兜底（BUG: PDF 被当二进制发后端 → 误报「仅支持图片」）──────────

  it('文档解析失败时不降级成二进制附件，弹错并中止发送', async () => {
    parseDocument.mockRejectedValueOnce(new Error('Setting up fake worker failed'))
    const deps = makeDeps()
    const { handleSend } = useChatSend(deps as any)
    const pdf = new File(['%PDF'], 'report.pdf', { type: 'application/pdf' })

    await expect(handleSend('总结下这个文档', [pdf])).resolves.toBe(false)

    // 关键：绝不把 PDF 当二进制 type:'file' 发给后端（后端只收图片，必被拒并回误导文案）
    expect(deps.chatStore.sendMessage).not.toHaveBeenCalled()
    expect(toastError).toHaveBeenCalledTimes(1)
  })

  it('文档解析出空文本（扫描件/纯图片 PDF）时弹 warning 并中止', async () => {
    parseDocument.mockResolvedValueOnce({ text: '   ', fileName: 'scan.pdf' })
    const deps = makeDeps()
    const { handleSend } = useChatSend(deps as any)
    const pdf = new File(['%PDF'], 'scan.pdf', { type: 'application/pdf' })

    await expect(handleSend('看看这个', [pdf])).resolves.toBe(false)

    expect(deps.chatStore.sendMessage).not.toHaveBeenCalled()
    expect(toastWarning).toHaveBeenCalledTimes(1)
  })

  it('文档解析出文本→正文进隐藏上下文、文件卡片入元数据、不作为二进制附件', async () => {
    parseDocument.mockResolvedValueOnce({ text: 'PDF 正文', fileName: 'report.pdf', pageCount: 2 })
    const deps = makeDeps()
    const { handleSend } = useChatSend(deps as any)
    const pdf = new File(['%PDF'], 'report.pdf', { type: 'application/pdf' })

    await expect(handleSend('summarize', [pdf])).resolves.toBe(true)

    const call = deps.chatStore.sendMessage.mock.calls[0]!
    expect(call[0]).toBe('summarize') // 可见 = 用户文字
    expect(call[2]!.backendText).toContain('PDF 正文') // 正文进隐藏上下文
    expect(call[2]!.documents).toEqual([
      expect.objectContaining({ name: 'report.pdf', mime: 'application/pdf' }),
    ]) // 文件卡片
    expect(call[1]).toBeUndefined() // 没有二进制附件
    expect(toastError).not.toHaveBeenCalled()
  })

  it('旧拖拽路径：文档解析失败（parsedDocument 为 null）时不发二进制、中止并弹错', async () => {
    const deps = makeDeps()
    deps.attachmentPreview.value = {
      url: 'blob:x',
      name: 'broken.pdf',
      type: 'file',
      file: new File(['%PDF'], 'broken.pdf', { type: 'application/pdf' }),
    }
    deps.parsedDocument.value = null // handleFileUpload 解析失败后置 null
    const { handleSend } = useChatSend(deps as any)

    await expect(handleSend('总结')).resolves.toBe(false)

    // 旧路径同样绝不把文档当二进制 type:'file' 发给后端
    expect(deps.chatStore.sendMessage).not.toHaveBeenCalled()
    expect(toastError).toHaveBeenCalledTimes(1)
  })

  it('文档解析失败但仍有图片时，照常发送图片并仅对失败文档弹错', async () => {
    parseDocument.mockRejectedValueOnce(new Error('parse fail'))
    const deps = makeDeps()
    const { handleSend } = useChatSend(deps as any)
    const img = new File(['img'], 'pic.png', { type: 'image/png' })
    const pdf = new File(['%PDF'], 'a.pdf', { type: 'application/pdf' })

    await expect(handleSend('看图和文档', [img, pdf])).resolves.toBe(true)

    expect(deps.chatStore.sendMessage).toHaveBeenCalled()
    const call = deps.chatStore.sendMessage.mock.calls[0]!
    // 只有图片作为附件，PDF 绝不作为二进制
    expect(call[1]).toEqual([expect.objectContaining({ type: 'image', name: 'pic.png' })])
    expect(toastError).toHaveBeenCalledTimes(1)
  })
})
