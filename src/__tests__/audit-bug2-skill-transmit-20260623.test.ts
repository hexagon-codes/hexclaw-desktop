import { describe, it, expect, vi } from 'vitest'
import { ref } from 'vue'
import { createChatSendDeliveryController } from '@/stores/chat-send-delivery-controller'

// AUDIT bug#2 2026-06-23：挂载/召唤的技能（skillNames）必须经 metadata.skills 发给后端。
// 修复前 deliverMessage 不接收 skillNames、也不写入 requestMetadata → 后端永远收不到 → 技能不生效。
describe('AUDIT bug#2 挂载技能经 metadata.skills 透传给后端', () => {
  it('deliverMessage(skillNames) → sendViaBackend 收到 metadata.skills', async () => {
    const sendViaBackend = vi.fn().mockResolvedValue({
      reply: 'ok',
      session_id: 's1',
      metadata: { backend_message_id: 'm1' },
      tool_calls: [],
    })
    const controller = createChatSendDeliveryController({
      chatParams: ref({ provider: 'ollama', model: 'qwen3.5:9b' }),
      agentRole: ref(''),
      thinkingEnabled: ref(false),
      activeStreams: ref({}),
      chatSvc: {
        ensureWebSocketConnected: vi.fn().mockResolvedValue(false), // 走 backend 分支便于断言
        sendViaBackend,
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

    await controller.deliverMessage({
      backendText: '你在哪里',
      sessionId: 's1',
      requestId: 'req-1',
      sending: ref(false),
      draftSending: ref(false),
      skillNames: ['前女友'],
    })

    expect(sendViaBackend).toHaveBeenCalled()
    const metaArg = sendViaBackend.mock.calls[0]![5] as Record<string, string> | undefined
    expect(metaArg?.skills).toBe('前女友')
  })
})
