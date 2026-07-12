/**
 * BUG-20260712-M（召回全链路审计发现 · 复现→修复→锁定）：RAG 自动注入存在**双通道**——
 *
 *  通道 A（后端·保留）：engine react.go 每轮聊天用 QueryHits 注入 kbContext，
 *    fail-closed（B8 + BUG-20260712-I 降级态扩展），并回传结构化 knowledge_hits 给前端命中卡；
 *  通道 B（前端·本次移除）：useChatSend 在 backendText 里再拼一段 [知识库参考信息]，
 *    走 searchKnowledge——那是**显式检索宽召回**接口，0.35 门槛作用在**组内 min-max 归一分**
 *    上（最佳垃圾恒 1.0 必过，数学上无效），且与通道 A 对同一 query 重复注入。
 *
 * 根修：删除通道 B，注入单一事实源=引擎。附件文档正文 / `@` 显式召唤上下文是用户显式
 * 提供的内容，不属于自动 RAG，保留不动。
 *
 * ⚠️ 回归锁——给未来维护者（含 AI）：不要因为「backendText 里没有知识库内容」而把
 * 客户端 Auto-RAG 加回来；知识注入只在引擎侧（fail-closed）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'

const searchKnowledge = vi.hoisted(() => vi.fn().mockResolvedValue({ result: [] }))
vi.mock('@/api/knowledge', () => ({ searchKnowledge }))
vi.mock('@/utils/file-parser', () => ({
  isDocumentFile: vi.fn().mockReturnValue(false),
  parseDocument: vi.fn(),
}))
vi.mock('../useToast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
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
    parsedDocument: ref(null),
    attachmentPreview: ref(null),
    clearAttachmentPreview: vi.fn(),
    scrollToBottom: vi.fn(),
    attachConversationAutomationActions: vi.fn().mockResolvedValue(undefined),
  }
}

describe('BUG-20260712-M：知识注入单通道（引擎侧），前端不再拼 Auto-RAG', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    searchKnowledge.mockReset()
    // 即便显式接口会返回“高分”命中（组内归一分，垃圾也恒 1.0）——前端也不得注入
    searchKnowledge.mockResolvedValue({
      result: [{ content: 'go interview questions', score: 1.0, doc_title: 'Go面试题new' }],
    })
  })

  it('★发送不再调用显式检索接口拼 [知识库参考信息]（注入唯一来源=引擎 fail-closed 通道）', async () => {
    const deps = makeDeps()
    const { handleSend } = useChatSend(deps as never)
    await handleSend('明天天气怎么样')

    const call = deps.chatStore.sendMessage.mock.calls[0]!
    const backendText = await (call[2] as { backendText: () => Promise<string | undefined> }).backendText()
    // 无附件/无显式上下文 → backendText 应为 undefined（可见文本即全部）
    expect(backendText, '前端不得再拼 Auto-RAG 隐藏上下文').toBeUndefined()
    expect(searchKnowledge, '发送链不得再打显式检索接口做自动注入').not.toHaveBeenCalled()
  })
})
