/**
 * BUG-20260622 — 发送带挂载 Skill 的消息后，会话气泡只显示文本、不显示 skill。
 *
 * 根因：Skill 改 chip-only 后，挂载的技能没被带进用户消息（skillNames 未透传到
 * chatStore.sendMessage → 未写入 message.metadata.skills → 气泡无从渲染）。
 * 本测试钉死「useChatSend.handleSend 必须把 skillNames 透传给 sendMessage」。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'

const searchKnowledge = vi.hoisted(() => vi.fn().mockResolvedValue({ result: [] }))
vi.mock('@/api/knowledge', () => ({ searchKnowledge }))
vi.mock('@/utils/file-parser', () => ({
  isDocumentFile: vi.fn().mockReturnValue(false),
  parseDocument: vi.fn().mockResolvedValue({ text: 'parsed', fileName: 't.txt' }),
}))

import { useChatSend } from '../useChatSend'

function makeDeps() {
  const messages: Array<{ id: string; role: string; content: string }> = []
  const sendMessage = vi.fn().mockImplementation(async (text: string) => {
    messages.push({ id: 'u1', role: 'user', content: text })
    return { id: 'a1', role: 'assistant', content: 'reply' }
  })
  return {
    chatStore: { messages, sendMessage, chatMode: 'chat', agentRole: '', chatParams: { model: 'm' as string | undefined } },
    parsedDocument: ref(null),
    attachmentPreview: ref(null),
    clearAttachmentPreview: vi.fn(),
    scrollToBottom: vi.fn(),
    attachConversationAutomationActions: vi.fn().mockResolvedValue(undefined),
  }
}

describe('BUG-20260622 skill 显示在会话气泡', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    searchKnowledge.mockResolvedValue({ result: [] })
  })

  it('handleSend 把 skillNames 透传给 chatStore.sendMessage（供写入 metadata.skills）', async () => {
    const deps = makeDeps()
    const { handleSend } = useChatSend(deps as any)
    await handleSend('你去哪里了?', undefined, { skillNames: ['前女友'] })
    const call = deps.chatStore.sendMessage.mock.calls[0]!
    const opts = call[2] as { skillNames?: string[] } | undefined
    expect(opts?.skillNames).toEqual(['前女友'])
  })

  it('无挂载技能时不破坏既有调用（skillNames 不出现或为空）', async () => {
    const deps = makeDeps()
    const { handleSend } = useChatSend(deps as any)
    await handleSend('hello')
    const opts = deps.chatStore.sendMessage.mock.calls[0]![2] as { skillNames?: string[] } | undefined
    expect(opts?.skillNames ?? []).toEqual([])
  })
})
