/**
 * /hex-test 审计取证 — 2026-06-28 · 工具卡/有序内容块全链路工作线
 *
 * F1（P1，真 bug，命中「四路径透传」的重载路径）：
 *   后端把有序内容块写进 meta.blocks（session.SaveAssistantReply 与 meta.tool_calls 同处落库），
 *   storage.MessageRecord 无顶层 blocks 字段 → 列表接口只在 metadata JSON 内回带 blocks。
 *   前端「活」的重载路径 chat-session-loading.ts → messageService.loadMessages 从 meta 提取了
 *   tool_calls / agent_name / reasoning / feedback，**唯独漏了 blocks**；唯一会读 meta.blocks 的
 *   normalizeLoadedMessage 在生产无任何调用方（仅测试引用）。
 *   后果：切会话 / 重启 / 重开会话后，多步 ReAct 的「文本→工具→文本→工具」交错序丢失，
 *   ChatView 退回扁平渲染——blocks 特性的核心价值在重载路径失效。
 *
 * 对照实验：同一条 metadata 内并存 tool_calls 与 blocks。
 *   tool_calls 能被还原（证明 metadata 还原机制本身是通的）；
 *   blocks 还原不出（恒 undefined）——把 bug 钉死在「loadMessages 漏读 meta.blocks」这一处。
 *
 * 修复前：RED（blocks 断言失败）。修复后：GREEN。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { listSessionMessages } = vi.hoisted(() => ({
  listSessionMessages: vi.fn().mockResolvedValue({ messages: [], total: 0 }),
}))

vi.mock('@/api/chat', () => ({
  listSessions: vi.fn().mockResolvedValue({ sessions: [], total: 0 }),
  listSessionMessages,
  createSession: vi.fn(),
  updateSessionTitle: vi.fn(),
  suggestSessionTitle: vi.fn(),
  deleteSession: vi.fn(),
  deleteMessage: vi.fn(),
  appendSessionMessage: vi.fn(),
}))

import { loadMessages } from '../services/messageService'

describe('audit-20260628 F1: loadMessages 丢失有序内容块（重载路径未闭环）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // 后端列表接口回带的 assistant 消息：blocks 与 tool_calls 同存于 metadata。
  // blocks 表达「文本 → 工具调用 → 工具结果 → 文本」真实交错序。
  const backendMessage = {
    id: 'm-blocks',
    role: 'assistant' as const,
    content: '先看下天气，再回答。今天北京晴，25°C。',
    timestamp: '2026-06-28T00:00:00Z',
    metadata: {
      tool_calls: [
        { id: 'tc1', name: 'get_weather', arguments: '{"city":"北京"}', result: '晴 25°C', status: 'success' },
      ],
      blocks: [
        { type: 'text', text: '先看下天气，再回答。' },
        { type: 'tool_use', id: 'tc1', name: 'get_weather', input: '{"city":"北京"}' },
        { type: 'tool_result', toolUseId: 'tc1', toolName: 'get_weather', output: '晴 25°C', isError: false },
        { type: 'text', text: '今天北京晴，25°C。' },
      ],
    },
  }

  it('对照：tool_calls 能从 metadata 还原（还原机制本身是通的）', async () => {
    listSessionMessages.mockResolvedValueOnce({ messages: [backendMessage], total: 1 })
    const msgs = await loadMessages('s1')
    expect(msgs[0]!.tool_calls).toHaveLength(1)
    expect(msgs[0]!.tool_calls![0]!.id).toBe('tc1')
  })

  it('RED→GREEN：blocks 必须从 metadata 还原（重载后仍按交错序渲染）', async () => {
    listSessionMessages.mockResolvedValueOnce({ messages: [backendMessage], total: 1 })
    const msgs = await loadMessages('s1')
    // 修复前 loadMessages 从不读 meta.blocks → blocks 恒 undefined（断言失败 = RED）
    expect(msgs[0]!.blocks).toBeDefined()
    expect(msgs[0]!.blocks).toHaveLength(4)
    // 交错序必须原样保留：text → tool_use → tool_result → text
    expect(msgs[0]!.blocks!.map((b: { type: string }) => b.type)).toEqual([
      'text', 'tool_use', 'tool_result', 'text',
    ])
    // tool_use 块按 id 关联回 tool_calls 取富数据，id 必须保真
    const toolUse = msgs[0]!.blocks!.find((b: { type: string }) => b.type === 'tool_use') as { id: string }
    expect(toolUse.id).toBe('tc1')
  })
})
