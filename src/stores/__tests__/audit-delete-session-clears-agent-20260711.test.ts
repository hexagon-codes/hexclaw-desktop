/**
 * hex-test 审计 · UI#10：deleteSession 只 clearSessionModel 不 clearSessionAgent。
 * session-agent-binding.ts:13 文档注释承诺「删除会话时 clearSessionAgent」，实现未做 →
 * 删除会话瞬间 agent 绑定滞留，getSessionAgent(deletedId) 仍返回旧值（localStorage 残留）。
 * RED：删会话后 getSessionAgent 非空 → FAIL；GREEN：deleteSession 补 clearSessionAgent。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { bindSessionAgent, getSessionAgent } from '../session-agent-binding'
import { useChatStore } from '@/stores/chat'

vi.mock('@/services/messageService', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return { ...original, deleteSession: vi.fn().mockResolvedValue(undefined) }
})

describe('hex-test UI#10 · deleteSession 清 agent 绑定', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })

  it('删除会话后 session→agent 绑定必须被清除（防孤儿滞留）', async () => {
    const chat = useChatStore()
    bindSessionAgent('S1', 'k12-tutor-KKE5v8zQ')
    expect(getSessionAgent('S1')).toBe('k12-tutor-KKE5v8zQ')

    await chat.deleteSession('S1')

    expect(getSessionAgent('S1')).toBe('')
  })
})
