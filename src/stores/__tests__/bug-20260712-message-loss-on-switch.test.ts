import { describe, expect, it, vi } from 'vitest'
import { ref, type Ref } from 'vue'
import type { ChatMessage } from '@/types'
import { createChatSessionLoadingController } from '../chat-session-loading'
import { mergeMessagesById } from '../chat-session-helpers'

// BUG-20260712 #F：切到别的会话再切回，刚发的消息消失。
// 根因：selectSession 用后端 loadMessages 结果**盲目覆盖**共享的 messages.value，而后端落库有
// 延迟（生成中/刚发出尚未保存）→ 切回时后端返回不含刚发消息 → 用户气泡被抹掉。
// 修：按会话缓存内存快照 + 切回时与后端按 id 合并（后端权威 + 保留后端尚无的乐观/在途消息）。

function msg(id: string, role: 'user' | 'assistant', content: string): ChatMessage {
  return { id, role, content, timestamp: '2026-07-12' } as ChatMessage
}

function makeController(
  messages: Ref<ChatMessage[]>,
  currentSessionId: Ref<string | null>,
  loadMessages: (sid: string) => Promise<ChatMessage[]>,
) {
  return createChatSessionLoadingController({
    sessions: ref([]),
    currentSessionId,
    messages,
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
      loadMessages: vi.fn(loadMessages),
      loadArtifacts: vi.fn().mockResolvedValue([]),
      setLastSessionId: vi.fn(),
    } as never,
    logger: { warn: vi.fn() } as never,
    syncStreamingMirrors: vi.fn(),
    isSessionStreaming: vi.fn(() => false),
    extractArtifacts: vi.fn(),
  })
}

describe('BUG-20260712 #F 切会话再切回不丢刚发的消息', () => {
  it('mergeMessagesById：后端权威 + 保留后端尚无的乐观消息', () => {
    const backend = [msg('u1', 'user', 'hi'), msg('a1', 'assistant', 'hello')]
    const cached = [...backend, msg('u2', 'user', '在途')]
    expect(mergeMessagesById(backend, cached).map((m) => m.id)).toEqual(['u1', 'a1', 'u2'])
    expect(mergeMessagesById(backend, [])).toBe(backend) // 空缓存原样返回
    // 后端补齐后按 id 去重，不重复
    expect(mergeMessagesById([msg('u1', 'user', 'hi')], [msg('u1', 'user', 'hi')]).map((m) => m.id)).toEqual(['u1'])
  })

  it('切 A(有乐观消息)→B→A，后端尚未落库时 A 的乐观消息仍在', async () => {
    const messages = ref<ChatMessage[]>([])
    const currentSessionId = ref<string | null>(null)
    const loadMessages = async (sid: string): Promise<ChatMessage[]> =>
      sid === 'B' ? [msg('b1', 'user', 'B消息')] : [] // A 后端尚未保存刚发的消息
    const ctrl = makeController(messages, currentSessionId, loadMessages)

    await ctrl.selectSession('A')
    // A 里乐观插入刚发的用户消息（模拟 send 控制器 push）
    messages.value.push(msg('u-opt', 'user', '杭州明天天气?'))
    await ctrl.selectSession('B')
    expect(messages.value.map((m) => m.id)).toEqual(['b1'])
    // 切回 A：后端仍返回 []（未落库），乐观消息应从缓存合并恢复
    await ctrl.selectSession('A')
    expect(messages.value.map((m) => m.id)).toContain('u-opt') // RED（修前）：被盲覆盖成 []
  })

  it('keeps each session’s own messages while earlier history is still loading', async () => {
    const a = msg('a1', 'user', 'A pending message')
    const b = msg('b1', 'user', 'B saved message')
    const bPending = msg('b2', 'user', 'B pending message')
    const messages = ref([a])
    const currentSessionId = ref<string | null>('A')
    let resolveFirstB!: (rows: ChatMessage[]) => void
    let readsOfB = 0
    const ctrl = makeController(messages, currentSessionId, async (sessionId) => {
      if (sessionId !== 'B') return []
      if (++readsOfB === 1) return new Promise<ChatMessage[]>((resolve) => { resolveFirstB = resolve })
      return [b]
    })

    const firstB = ctrl.selectSession('B')
    const firstProjection = messages.value.slice()
    await ctrl.selectSession('C')
    const currentB = ctrl.selectSession('B')
    messages.value.push(bPending)
    await currentB
    resolveFirstB([b])
    await firstB

    expect(firstProjection).toEqual([])
    expect(messages.value.map(({ id }) => id)).toEqual(['b1', 'b2'])
    await ctrl.selectSession('A')
    expect(messages.value.map(({ id }) => id)).toEqual(['a1'])
  })
})
