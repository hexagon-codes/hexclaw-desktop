/**
 * BUG-20260703（实机#2 / AP-140、AP-147 同类「重载丢字段」）：
 * 思考时长在流式完成时由后端算好落进消息 meta 扩展列（session.go metaMap["thinking_duration"]），
 * 但前端 loadMessages 从 metaExt 只读回 reasoning——thinking_duration 被丢弃，
 * 切会话/重启后气泡从「已思考 N 秒」退化成无时长的「思考过程」。
 * 契约：重载后 metadata.thinking_duration 必须与落库值一致。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { listSessionMessages } = vi.hoisted(() => ({
  listSessionMessages: vi.fn(),
}))

vi.mock('@/api/chat', () => ({
  listSessions: vi.fn(),
  listSessionMessages,
  createSession: vi.fn(),
  updateSessionTitle: vi.fn(),
  suggestSessionTitle: vi.fn(),
  deleteSession: vi.fn(),
  deleteMessage: vi.fn(),
  appendSessionMessage: vi.fn(),
}))

import { loadMessages } from '../messageService'

describe('BUG-20260703 思考时长切会话重载丢失', () => {
  beforeEach(() => {
    listSessionMessages.mockReset()
  })

  it('UT-THINK-001: meta 扩展列里的 thinking_duration 重载后必须回填到 metadata', async () => {
    listSessionMessages.mockResolvedValueOnce({
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          content: '最终回答',
          created_at: '2026-07-03T10:00:00Z',
          meta: JSON.stringify({ reasoning: '让我想想……', thinking_duration: 12 }),
        },
      ],
      total: 1,
    })

    const msgs = await loadMessages('s1')
    expect(msgs).toHaveLength(1)
    expect(msgs[0]?.reasoning).toBe('让我想想……')
    expect(msgs[0]?.metadata?.thinking_duration).toBe(12)
  })

  it('UT-THINK-002: metadata 字段里已有 thinking_duration 时保持原值（回归守护）', async () => {
    listSessionMessages.mockResolvedValueOnce({
      messages: [
        {
          id: 'm2',
          role: 'assistant',
          content: '回答',
          created_at: '2026-07-03T10:01:00Z',
          metadata: JSON.stringify({ thinking_duration: 7 }),
        },
      ],
      total: 1,
    })

    const msgs = await loadMessages('s1')
    expect(msgs[0]?.metadata?.thinking_duration).toBe(7)
  })

  it('UT-THINK-003: meta 与 metadata 同时存在时 metadata 优先（避免旧值覆盖新语义）', async () => {
    listSessionMessages.mockResolvedValueOnce({
      messages: [
        {
          id: 'm3',
          role: 'assistant',
          content: '回答',
          created_at: '2026-07-03T10:02:00Z',
          metadata: JSON.stringify({ thinking_duration: 5 }),
          meta: JSON.stringify({ thinking_duration: 9 }),
        },
      ],
      total: 1,
    })

    const msgs = await loadMessages('s1')
    expect(msgs[0]?.metadata?.thinking_duration).toBe(5)
  })

  it('UT-THINK-004: 无思考时长的消息不应凭空出现该字段', async () => {
    listSessionMessages.mockResolvedValueOnce({
      messages: [
        {
          id: 'm4',
          role: 'assistant',
          content: '普通回答',
          created_at: '2026-07-03T10:03:00Z',
          meta: JSON.stringify({ reasoning: '' }),
        },
      ],
      total: 1,
    })

    const msgs = await loadMessages('s1')
    expect(msgs[0]?.metadata?.thinking_duration).toBeUndefined()
  })
})
