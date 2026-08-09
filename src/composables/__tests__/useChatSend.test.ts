import { flushPromises } from '@vue/test-utils'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'

const searchKnowledge = vi.hoisted(() => vi.fn().mockResolvedValue({ result: [] }))
const parseDocument = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ text: 'parsed', fileName: 'test.txt' }),
)

const toastError = vi.hoisted(() => vi.fn())
const toastWarning = vi.hoisted(() => vi.fn())
const uploadChatAttachment = vi.hoisted(() => vi.fn())
const ensureChatAttachmentReceipt = vi.hoisted(() => vi.fn())

vi.mock('@/api/knowledge', () => ({ searchKnowledge }))
vi.mock('@/utils/file-parser', () => ({
  isDocumentFile: vi.fn().mockReturnValue(false),
  parseDocument,
}))
vi.mock('../useToast', () => ({
  useToast: () => ({ success: vi.fn(), error: toastError, warning: toastWarning, info: vi.fn() }),
}))
vi.mock('@/api/attachments', () => ({
  uploadChatAttachment,
  ensureChatAttachmentReceipt,
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
    // mockReset 清掉上个用例残留的 mockImplementationOnce 队列（惰性 thunk 下未被消费的 Once 会泄漏到下个用例）
    searchKnowledge.mockReset()
    searchKnowledge.mockResolvedValue({ result: [] })
    parseDocument.mockReset()
    parseDocument.mockResolvedValue({ text: 'parsed', fileName: 'test.txt' })
    uploadChatAttachment.mockReset()
    uploadChatAttachment.mockResolvedValue({ attachment_id: 'attachment-test' })
    ensureChatAttachmentReceipt.mockReset()
    ensureChatAttachmentReceipt.mockImplementation(async (attachment: { type: string; attachmentId?: string }) => {
      if (attachment.type !== 'image') throw new Error('Only image chat attachments are supported')
      return { ...attachment, attachmentId: attachment.attachmentId ?? 'attachment-test' }
    })
  })

  it('sends message through chatStore.sendMessage', async () => {
    const deps = makeDeps()
    const { handleSend } = useChatSend(deps as any)
    await handleSend('hello')
    // backendText 改为惰性 thunk（BUG-20260628），故 sendOptions 始终带 backendText 函数
    expect(deps.chatStore.sendMessage).toHaveBeenCalledWith(
      'hello',
      undefined,
      expect.objectContaining({ backendText: expect.any(Function) }),
    )
  })

  it('normalizes formula syntax at the shared send boundary for edit/retry/direct sends', async () => {
    const deps = makeDeps()
    const { handleSend } = useChatSend(deps as any)
    await handleSend(String.raw`题目：\\(\\frac{3}{4}\\)`)
    expect(deps.chatStore.sendMessage).toHaveBeenCalledWith(
      String.raw`题目：$\frac{3}{4}$`,
      undefined,
      expect.objectContaining({ backendText: expect.any(Function) }),
    )
  })

  it('allows Agent mode sends when model is undefined', async () => {
    const deps = makeDeps()
    deps.chatStore.chatParams.model = undefined

    const { handleSend } = useChatSend(deps as any)

    await expect(handleSend('hello')).resolves.toBe(true)
    expect(deps.chatStore.sendMessage).toHaveBeenCalledWith(
      'hello',
      undefined,
      expect.objectContaining({ backendText: expect.any(Function) }),
    )
  })

  it('前端不再拼 Auto-RAG（BUG-20260712-M：知识注入单通道=引擎侧 fail-closed）', async () => {
    searchKnowledge.mockResolvedValueOnce({
      result: [{ content: 'relevant info', score: 0.8, doc_title: 'Doc1' }],
    })
    const deps = makeDeps()
    const { handleSend } = useChatSend(deps as any)
    await handleSend('question')
    const call = deps.chatStore.sendMessage.mock.calls[0]!
    expect(call[2]).toBeDefined()
    // 客户端 Auto-RAG 通道已删（显式检索归一分上设门槛无效 + 与引擎注入重复）
    expect(await call[2]!.backendText()).toBeUndefined()
    expect(searchKnowledge).not.toHaveBeenCalled()
  })

  it('continues without knowledge when searchKnowledge throws', async () => {
    searchKnowledge.mockRejectedValueOnce(new Error('KB unavailable'))
    const deps = makeDeps()
    const { handleSend } = useChatSend(deps as any)
    await handleSend('question')
    expect(deps.chatStore.sendMessage).toHaveBeenCalled()
    // thunk 解析时 searchKnowledge throw 被 catch，不阻塞、backendText 退为 undefined
    const call = deps.chatStore.sendMessage.mock.calls[0]!
    await expect(call[2]!.backendText()).resolves.toBeUndefined()
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
    const backendText = await call[2]!.backendText()
    expect(backendText).toContain('doc content') // 正文进隐藏上下文
    expect(backendText).toContain('[用户问题]')
    expect(call[2]!.documents).toEqual([expect.objectContaining({ name: 'report.pdf' })]) // 文件卡片
  })

  it('calls scrollToBottom after send', async () => {
    const deps = makeDeps()
    const { handleSend } = useChatSend(deps as any)
    await handleSend('test')
    expect(deps.scrollToBottom).toHaveBeenCalled()
  })

  // BUG-20260627：用户发送新消息后必须**无条件**滚到最新（即便此前上翻看历史），故 force=true。
  // 之前非 force 会被 userScrolledUp 闸挡住 → 发送后停在上次翻到的位置，看不到自己刚发的消息。
  it('forces scroll to bottom on user send (scrollToBottom(true)), even if user had scrolled up', async () => {
    const deps = makeDeps()
    const { handleSend } = useChatSend(deps as any)
    await handleSend('test')
    expect(deps.scrollToBottom).toHaveBeenCalledWith(true)
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

  // BUG-20260628：发送消息「卡一下才提交到上面」。根因＝Auto-RAG 的 searchKnowledge 在乐观
  // push（chatStore.sendMessage 内同步 push 用户气泡）之前被 await，用户气泡被知识检索往返阻塞，
  // 直到 RAG 返回才上屏。修复后：用户气泡先立即上屏，RAG 在 push 之后再做（其结果仍进 backendText）。
  it('BUG-20260628: 用户消息立即上屏，不被 Auto-RAG(searchKnowledge) 往返阻塞', async () => {
    const deps = makeDeps()
    // searchKnowledge 挂起（模拟知识检索慢/卡，尤其默认本地嵌入不可用时），先不 resolve
    let releaseSearch: () => void = () => {}
    searchKnowledge.mockImplementationOnce(
      () =>
        new Promise<{ result: never[] }>((resolve) => {
          releaseSearch = () => resolve({ result: [] })
        }),
    )

    const { handleSend } = useChatSend(deps as any)
    const p = handleSend('hello') // 不 await
    await flushPromises() // 跑完同步段 + 已就绪微任务（searchKnowledge 仍挂起）

    // 修复前：handleSend 卡在 `await searchKnowledge`，从未走到 sendMessage → 气泡没上屏（RED）
    expect(deps.chatStore.sendMessage).toHaveBeenCalled()
    expect(
      deps.chatStore.messages.some((m) => m.role === 'user' && m.content === 'hello'),
    ).toBe(true)

    releaseSearch()
    await p
  })

  // BUG-20260628B：发送后「卡几秒才出现回复气泡」。根因＝Auto-RAG 的 searchKnowledge 走默认（本机为
  // 不可用的本地）嵌入器，慢/卡几秒，而 backendText(thunk) 被 sendMessage await 后才投递 → 回复被拖住。
  // 修复：Auto-RAG best-effort 限时，超预算即放弃 KB 增强，让模型请求尽快发出、回复气泡尽快出现。
  it('BUG-20260628B: Auto-RAG 慢/卡时不拖慢回复——超时预算后 backendText thunk 必须 settle（不被 searchKnowledge 永久卡住）', async () => {
    vi.useFakeTimers()
    try {
      searchKnowledge.mockImplementationOnce(() => new Promise(() => {})) // 永不返回（模拟嵌入器不可用）
      const deps = makeDeps()
      const { handleSend } = useChatSend(deps as any)
      await handleSend('hello')
      const resolveBackendText = deps.chatStore.sendMessage.mock.calls[0]![2]!.backendText as () => Promise<
        string | undefined
      >
      let settled = false
      const thunk = resolveBackendText().then((v) => {
        settled = true
        return v
      })
      // 推进假时钟越过 RAG 预算
      await vi.advanceTimersByTimeAsync(2000)
      // 修复前：thunk 永久 await searchKnowledge → 不 settle（RED）。修复后：超时放弃 RAG → settle、无隐藏上下文。
      expect(settled).toBe(true)
      await expect(thunk).resolves.toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
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

  it('深度思考发送保留已绑定场景 Agent；普通无绑定 research 才使用 researcher', async () => {
    const sceneDeps = makeDeps()
    sceneDeps.chatStore.chatMode = 'research'
    sceneDeps.chatStore.agentRole = 'k12-tutor-mingming'

    const sceneSend = useChatSend(sceneDeps as any)
    await sceneSend.handleSend('帮我深入分析这道题')

    expect(sceneDeps.chatStore.agentRole).toBe('k12-tutor-mingming')
    expect(sceneDeps.chatStore.sendMessage).toHaveBeenCalledOnce()

    const ordinaryDeps = makeDeps()
    ordinaryDeps.chatStore.chatMode = 'research'
    ordinaryDeps.chatStore.agentRole = ''

    const ordinarySend = useChatSend(ordinaryDeps as any)
    await ordinarySend.handleSend('研究一个普通问题')

    expect(ordinaryDeps.chatStore.agentRole).toBe('researcher')
  })

  it('fails closed for video attachments because the native chat receipt boundary is image-only', async () => {
    const deps = makeDeps()
    const { handleSend } = useChatSend(deps as any)
    const video = new File(['video-bytes'], 'demo.mp4', { type: 'video/mp4' })

    await expect(handleSend('watch this', [video])).rejects.toThrow(
      'Only image chat attachments are supported',
    )
    expect(deps.chatStore.sendMessage).not.toHaveBeenCalled()
  })

  it.each(['legacy attachment preview', 'multi-file composer'] as const)(
    'sends a newly selected image from %s by receipt without FileReader/base64',
    async (source) => {
      const readAsDataURL = vi.fn(() => {
        throw new Error('new chat images must not be encoded as a data URL')
      })
      const createObjectURL = vi.fn(() => 'blob:chat-image-preview')
      vi.stubGlobal('FileReader', class { readAsDataURL = readAsDataURL })
      vi.stubGlobal('URL', { createObjectURL })

      try {
        const deps = makeDeps()
        const image = new File(['image-bytes'], 'photo.png', { type: 'image/png' })
        if (source === 'legacy attachment preview') {
          deps.attachmentPreview.value = {
            url: 'blob:composer-preview', name: image.name, type: 'image', file: image,
          }
        }

        const { handleSend } = useChatSend(deps as any)
        await expect(
          source === 'legacy attachment preview'
            ? handleSend('describe this image')
            : handleSend('describe this image', [image]),
        ).resolves.toBe(true)

        expect(uploadChatAttachment).toHaveBeenCalledWith(image)
        expect(readAsDataURL).not.toHaveBeenCalled()
        expect(createObjectURL).toHaveBeenCalledWith(image)
        expect(deps.chatStore.sendMessage).toHaveBeenCalledWith(
          'describe this image',
          [expect.objectContaining({
            type: 'image',
            name: 'photo.png',
            mime: 'image/png',
            data: 'blob:chat-image-preview',
            attachmentId: 'attachment-test',
          })],
          expect.objectContaining({ backendText: expect.any(Function) }),
        )
      } finally {
        vi.unstubAllGlobals()
      }
    },
  )

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
    expect(await call[2]!.backendText()).toContain('PDF 正文') // 正文进隐藏上下文
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
