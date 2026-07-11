import { describe, it, expect, vi, beforeEach } from 'vitest'

// U9：知识/记忆命中标签恒 false 的契约缝——后端把命中作为 done chunk / reply 的**顶层**
// 结构化数组回传（knowledge_hits / memory_hits，因后端 Metadata 是 map[string]string、无法
// 承载对象数组），但 chatService 只把 msg.metadata 透传给 onDone，顶层命中被丢弃，导致
// ChatView 的 msg.metadata.knowledge_hits 永远 undefined → 标签恒 false。
// 修复：service 层 foldRetrievalHits 把顶层命中折叠进 metadata。本测试钉死该折叠契约。

const { wsOnChunk, wsOnReply } = vi.hoisted(() => ({
  wsOnChunk: vi.fn().mockReturnValue(() => {}),
  wsOnReply: vi.fn().mockReturnValue(() => {}),
}))

vi.mock('@/api/websocket', () => ({
  hexclawWS: {
    isConnected: vi.fn().mockReturnValue(true),
    connect: vi.fn().mockResolvedValue(undefined),
    clearCallbacks: vi.fn(),
    clearStreamCallbacks: vi.fn(),
    onChunk: wsOnChunk,
    onReply: wsOnReply,
    onError: vi.fn().mockReturnValue(() => {}),
    onApprovalRequest: vi.fn().mockReturnValue(() => {}),
    sendMessage: vi.fn(),
  },
}))
vi.mock('@/api/chat', () => ({ sendChatViaBackend: vi.fn() }))

import { sendViaWebSocket } from '../chatService'

describe('U9 命中契约折叠', () => {
  beforeEach(() => {
    wsOnChunk.mockReset().mockReturnValue(() => {})
    wsOnReply.mockReset().mockReturnValue(() => {})
  })

  it('reply 顶层 knowledge_hits 折叠进 metadata（驱动知识库命中标签）', async () => {
    wsOnReply.mockImplementation((cb: (msg: unknown) => void) => {
      cb({
        type: 'reply',
        content: 'done',
        metadata: { model: 'glm-5' },
        knowledge_hits: [{ doc_title: 'Spec', content: '相关片段' }],
      })
      return () => {}
    })

    const onDone = vi.fn()
    await sendViaWebSocket('hi', 's1', { model: 'glm-5' }, '', undefined, { onDone })

    expect(onDone).toHaveBeenCalledTimes(1)
    const metadata = onDone.mock.calls[0]![1] as Record<string, unknown>
    // ChatView 的 v-if="msg.metadata?.knowledge_hits" + getKnowledgeHits(normalizeHitList) 消费路径
    expect(Array.isArray(metadata.knowledge_hits)).toBe(true)
    expect((metadata.knowledge_hits as unknown[]).length).toBe(1)
    expect((metadata.knowledge_hits as Array<{ doc_title: string }>)[0]!.doc_title).toBe('Spec')
    // 既有 metadata 字段保留
    expect(metadata.model).toBe('glm-5')
  })

  it('done chunk 顶层 memory_hits 折叠进 metadata（驱动记忆命中标签）', async () => {
    wsOnChunk.mockImplementation((cb: (msg: unknown) => void) => {
      cb({
        type: 'chunk',
        content: '答复',
        done: true,
        metadata: {},
        memory_hits: [{ content: '用户喜欢深色主题' }],
      })
      return () => {}
    })

    const onDone = vi.fn()
    await sendViaWebSocket('hi', 's1', { model: 'glm-5' }, '', undefined, { onDone })

    expect(onDone).toHaveBeenCalledTimes(1)
    const metadata = onDone.mock.calls[0]![1] as Record<string, unknown>
    expect(Array.isArray(metadata.memory_hits)).toBe(true)
    expect((metadata.memory_hits as Array<{ content: string }>)[0]!.content).toBe('用户喜欢深色主题')
  })

  it('无命中时不注入空数组（标签保持隐藏，避免空数组恒真显示）', async () => {
    wsOnReply.mockImplementation((cb: (msg: unknown) => void) => {
      cb({ type: 'reply', content: 'done', metadata: { model: 'glm-5' }, knowledge_hits: [] })
      return () => {}
    })

    const onDone = vi.fn()
    await sendViaWebSocket('hi', 's1', { model: 'glm-5' }, '', undefined, { onDone })

    const metadata = onDone.mock.calls[0]![1] as Record<string, unknown>
    expect(metadata.knowledge_hits).toBeUndefined()
  })
})
