import { describe, it, expect, vi } from 'vitest'
import { ref } from 'vue'
import { createChatSendDeliveryController } from '@/stores/chat-send-delivery-controller'

// BUG-20260626：发送文档（PDF）后切会话再回来，文档卡片没了、只剩纯文本。
// 根因前半：文档卡片 ref 只进前端本地 metadata.documents、从不发后端 → 后端无从持久化。
// 修复：deliverMessage 接收 documents，并经 metadata.documents（JSON）透传给后端（后端落库见
// session/bug_20260626_documents_persist_test.go）。
describe('BUG-20260626 文档卡片经 metadata.documents 透传给后端', () => {
  it('deliverMessage(documents) → openWebSocketStream 收到 metadata.documents(JSON)', async () => {
    const openWebSocketStream = vi.fn().mockReturnValue({
      cancel: vi.fn(),
      done: Promise.resolve({ content: 'ok', metadata: { backend_message_id: 'm1' } }),
    })
    const controller = createChatSendDeliveryController({
      chatParams: ref({ provider: 'ollama', model: 'qwen3.5:9b' }),
      agentRole: ref(''),
      thinkingEnabled: ref(false),
      activeStreams: ref({}),
      chatSvc: {
        ensureWebSocketConnected: vi.fn().mockResolvedValue(true),
        openWebSocketStream,
      } as any,
      getSettingsStore: ((() => ({ config: { memory: { enabled: true } } })) as any),
      clearSessionCancelled: vi.fn(),
      isSessionCancelled: vi.fn().mockReturnValue(false),
      setSessionPending: vi.fn(),
      upsertStreamState: vi.fn(),
      updateStreamChunk: vi.fn(),
      resetSessionStream: vi.fn(),
      finalizeAssistantMessage: vi.fn().mockReturnValue({ id: 'a1' }) as any,
      handleSendError: vi.fn(),
      storePendingApproval: vi.fn(),
      streamHandles: new Map(),
    })

    const documents = [{ name: '年报.pdf', mime: 'application/pdf', size: 12345 }]
    await controller.deliverMessage({
      backendText: '看这个文档',
      sessionId: 's1',
      requestId: 'req-1',
      sending: ref(false),
      draftSending: ref(false),
      documents,
    })

    expect(openWebSocketStream).toHaveBeenCalled()
    const metaArg = openWebSocketStream.mock.calls[0]![6] as Record<string, string> | undefined
    const docsJson = metaArg?.documents
    expect(docsJson).toBeDefined()
    expect(JSON.parse(docsJson!)).toEqual(documents)
  })
})
