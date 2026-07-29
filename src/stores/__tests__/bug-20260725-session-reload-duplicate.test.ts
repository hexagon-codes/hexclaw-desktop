import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { ChatMessage } from '@/types'
import { mergeMessagesById } from '../chat-session-helpers'
import { createChatSessionLoadingController } from '../chat-session-loading'
import { createChatStreamCompletionController } from '../chat-stream-completion'
import {
  bindSessionAgent,
  getSessionAgent,
} from '../session-agent-binding'
import * as messageService from '@/services/messageService'

const { listSessions } = vi.hoisted(() => ({
  listSessions: vi.fn(),
}))

vi.mock('@/api/chat', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/chat')>()),
  listSessions,
}))

function message(
  id: string,
  role: 'user' | 'assistant',
  content: string,
  backendMessageId?: string,
): ChatMessage {
  return {
    id,
    role,
    content,
    timestamp: '2026-07-25T08:07:00+08:00',
    metadata: backendMessageId ? { backend_message_id: backendMessageId } : undefined,
  } as ChatMessage
}

describe('BUG-20260725 切回会话不重复投影已持久化助手消息', () => {
  it('以 backend_message_id 识别同一条本地完成消息和后端历史，并以后端版本替换', () => {
    const persisted = [
      message('user-backend', 'user', 'hello'),
      message('assistant-backend', 'assistant', '你好呀！我是小蟹'),
    ]
    const cached = [
      message('user-backend', 'user', 'hello'),
      message('assistant-local-random', 'assistant', '你好呀！我是小蟹', 'assistant-backend'),
    ]

    const merged = mergeMessagesById(persisted, cached)

    expect(merged.map((item) => item.id)).toEqual(['user-backend', 'assistant-backend'])
    expect(merged[1]).toBe(persisted[1])
  })

  it('绝不按正文去重：正文相同但 canonical id 不同的两条消息都保留', () => {
    const persisted = [
      message('assistant-backend-1', 'assistant', '相同回复'),
      message('assistant-backend-2', 'assistant', '相同回复'),
    ]

    expect(mergeMessagesById(persisted, [])).toHaveLength(2)
  })

  it('非 WebSocket 完成消息保留 backend_message_id，供切回会话时做稳定身份合并', () => {
    const appendMessageToSession = vi.fn()
    const controller = createChatStreamCompletionController({
      activeStreams: ref({}),
      pendingSuggestedTitleExpectation: ref({}),
      pendingAutoTitleSync: new Map(),
      currentSessionId: ref('session-1'),
      msgSvc: {
        touchSession: vi.fn().mockResolvedValue(undefined),
      } as never,
      createId: () => 'assistant-local-random',
      loadSessions: vi.fn().mockResolvedValue(undefined),
      setLocalSessionTitle: vi.fn(),
      setPendingSuggestedTitleExpectation: vi.fn(),
      bumpLocalSession: vi.fn(),
      extractArtifacts: vi.fn(),
      appendMessageToSession,
      resetSessionStream: vi.fn(),
    })

    const completed = controller.finalizeAssistantMessage({
      content: 'HTTP assistant reply',
      sessionId: 'session-1',
      metadata: { backend_message_id: 'assistant-backend' },
    })

    expect(completed.id).toBe('assistant-local-random')
    expect(completed.metadata).toMatchObject({
      backend_message_id: 'assistant-backend',
      assistant_message_aliases: [],
      last_sequence: 0,
      reasoning_visibility: 'not_exposed',
      runtime_events: [],
    })
    expect(appendMessageToSession).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        metadata: expect.objectContaining({ backend_message_id: 'assistant-backend' }),
      }),
    )
  })
})

describe('BUG-20260723-027 冷启动失败不销毁场景会话稳定身份', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  function loadingController(loadSucceeded: boolean) {
    return createChatSessionLoadingController({
      sessions: ref([]),
      currentSessionId: ref(null),
      messages: ref([]),
      artifacts: ref([]),
      selectedArtifactId: ref(null),
      showArtifacts: ref(false),
      error: ref(null),
      chatMode: ref('chat'),
      agentRole: ref(''),
      thinkingEnabled: ref(false),
      hasCustomTitle: ref(false),
      pendingSessionIds: ref({}),
      pendingSuggestedTitleExpectation: ref({}),
      ensureSessionPromise: ref(null),
      sessionSelectionGen: ref(0),
      msgSvc: {
        loadAllSessions: vi.fn().mockResolvedValue([]),
        loadAllSessionsResult: vi.fn().mockResolvedValue({
          sessions: [],
          succeeded: loadSucceeded,
        }),
        getLastSessionId: vi.fn().mockResolvedValue(null),
      } as never,
      logger: { warn: vi.fn() } as never,
      syncStreamingMirrors: vi.fn(),
      isSessionStreaming: vi.fn(() => false),
      extractArtifacts: vi.fn(),
    })
  }

  it('会话服务把请求失败与权威空列表区分为不同结果', async () => {
    listSessions.mockRejectedValueOnce(new Error('sidecar not ready'))
    const loadAllSessionsResult = (messageService as unknown as {
      loadAllSessionsResult?: () => Promise<{ sessions: unknown[]; succeeded: boolean }>
    }).loadAllSessionsResult

    expect(typeof loadAllSessionsResult).toBe('function')
    await expect(loadAllSessionsResult?.()).resolves.toEqual({
      sessions: [],
      succeeded: false,
    })
  })

  it('sidecar 尚未就绪导致首次拉取失败时保留 session-agent binding', async () => {
    bindSessionAgent('k12-session', 'k12-tutor-KKE5v8zQ')

    await loadingController(false).loadSessions()

    expect(getSessionAgent('k12-session')).toBe('k12-tutor-KKE5v8zQ')
  })

  it('后端权威确认会话列表为空时才清理孤儿 binding', async () => {
    bindSessionAgent('deleted-session', 'k12-tutor-KKE5v8zQ')

    await loadingController(true).loadSessions()

    expect(getSessionAgent('deleted-session')).toBe('')
  })
})
