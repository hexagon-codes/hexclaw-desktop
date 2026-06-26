/**
 * BUG-20260625（hex-test 全量横扫衍生）：深度思考(thinking)开关跨会话泄漏。
 *
 * 与本会话刚修的「切换会话模型被串改」(userOverrodeModel) 是**同根** bug：
 * 实体级覆盖状态在「切到另一个已有会话」时不清零 → 泄漏到下一个会话。
 *
 * 链路：会话 A 开启研究/深度思考(chatMode='research' + thinkingEnabled=true)
 *   → selectSession(切到会话 B)：chat-session-loading.ts:52-53 重置了 chatMode='chat'、
 *     agentRole=''，但**没重置 thinkingEnabled** →
 *   → UI 的 isDeepThinking = (chatMode==='research' && thinkingEnabled) = false（按钮显示关）
 *   → 但发送路径 chat-send-delivery-controller.ts:76 直接读 thinkingEnabled.value=true
 *     → chat-request-metadata.ts:12 metadata.thinking='on'
 *   → 会话 B 普通对话却静默带 thinking=on，UI 与真实请求不一致。
 *
 * 正确不变量：切到已有会话(selectSession)离开研究模式时，thinkingEnabled 必须一并清零
 *   （与 chatMode/agentRole 同步重置）。注意：newSession 在研究模式下是**有意保留**研究态
 *   （ChatView.newSession 仅在 chatMode!=='research' 时清 agentRole），故本测试只钉 selectSession。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useChatStore } from '../chat'

const {
  loadAllSessions, loadMessages, loadArtifacts, getLastSessionId, setLastSessionId,
  sendViaBackend, ensureWebSocketConnected,
} = vi.hoisted(() => ({
  loadAllSessions: vi.fn().mockResolvedValue([
    { id: 's1', title: 'A', created_at: '2026-01-01', updated_at: '2026-01-01', message_count: 0 },
    { id: 's2', title: 'B', created_at: '2026-01-01', updated_at: '2026-01-01', message_count: 0 },
  ]),
  loadMessages: vi.fn().mockResolvedValue([]),
  loadArtifacts: vi.fn().mockResolvedValue([]),
  getLastSessionId: vi.fn().mockResolvedValue(null),
  setLastSessionId: vi.fn().mockResolvedValue(undefined),
  sendViaBackend: vi.fn().mockResolvedValue({ reply: 'ok', session_id: 's2' }),
  ensureWebSocketConnected: vi.fn().mockResolvedValue(false),
}))

vi.mock('@/services/messageService', () => ({
  loadAllSessions, loadMessages, loadArtifacts, getLastSessionId, setLastSessionId,
  createSession: vi.fn().mockResolvedValue(undefined),
  updateSessionTitle: vi.fn().mockResolvedValue(undefined),
  suggestSessionTitle: vi.fn().mockResolvedValue({ id: 's1', title: 't', updated: true }),
  touchSession: vi.fn().mockResolvedValue(undefined),
  deleteSession: vi.fn().mockResolvedValue(undefined),
  persistMessage: vi.fn().mockResolvedValue(undefined),
  removeMessage: vi.fn(),
  saveArtifact: vi.fn().mockResolvedValue(undefined),
  parseMessageMetadata: vi.fn(),
  normalizeLoadedMessage: vi.fn(),
  serializeMessageMetadata: vi.fn(),
}))

vi.mock('@/services/chatService', () => {
  class ChatRequestError extends Error {
    noFallback: boolean
    constructor(message: string, noFallback = false) {
      super(message); this.name = 'ChatRequestError'; this.noFallback = noFallback
    }
  }
  return {
    ensureWebSocketConnected,
    sendViaWebSocket: vi.fn().mockResolvedValue(undefined),
    openWebSocketStream: vi.fn(() => ({ cancel: vi.fn(), done: Promise.resolve({ content: 'x' }) })),
    resumeWebSocketStream: vi.fn(() => ({ cancel: vi.fn(), done: Promise.resolve({ content: 'x' }) })),
    sendViaBackend,
    clearWebSocketCallbacks: vi.fn(),
    ChatRequestError,
  }
})

vi.mock('@/api/chat', () => ({
  updateMessageFeedback: vi.fn().mockResolvedValue({ message: 'ok' }),
  listActiveStreams: vi.fn().mockResolvedValue({ streams: [], total: 0 }),
}))

vi.mock('@/api/websocket', () => ({
  hexclawWS: {
    sendRaw: vi.fn(), triggerError: vi.fn(),
    onApprovalRequest: vi.fn(() => () => {}), sendApprovalResponse: vi.fn(),
  },
}))

describe('BUG-20260625 深度思考(thinking)开关跨会话泄漏', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('★切换到已有会话(selectSession)离开研究模式时必须清 thinkingEnabled，否则下个会话静默带 thinking=on', async () => {
    const store = useChatStore()
    // 会话 A：开启研究/深度思考
    store.chatMode = 'research'
    store.thinkingEnabled = true

    // 切到已有会话 B
    await store.selectSession('s2')

    // selectSession 已把 chatMode 重置为 'chat'（离开研究模式）——thinkingEnabled 也应一并清零
    expect(store.chatMode, 'selectSession 应离开研究模式').toBe('chat')
    expect(
      store.thinkingEnabled,
      '切换会话后 thinkingEnabled 未清零 → UI 显示关但请求仍发 thinking=on（跨会话状态泄漏）',
    ).toBe(false)
  })
})
