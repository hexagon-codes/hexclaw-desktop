import { describe, expect, it, vi } from 'vitest'
import sessionListSource from '@/components/chat/SessionList.vue?raw'
import chatViewSource from '@/views/ChatView.vue?raw'
import chatInputSource from '@/components/chat/ChatInput.vue?raw'
import { shouldBlockChatSend } from '../chat-send-guards'

describe('BUG-20260726-027/028 · one shared session execution lock', () => {
  it('blocks a target session before optimistic message creation when its durable task is non-terminal', () => {
    const isSessionExecuting = vi.fn((sessionId: string) => sessionId === 'session-running')

    expect(
      shouldBlockChatSend({
        initialSessionId: 'session-running',
        pendingSessionIds: {},
        draftSending: false,
        isSessionStreaming: () => false,
        isSessionExecuting,
      } as Parameters<typeof shouldBlockChatSend>[0]),
    ).toBe(true)
    expect(
      shouldBlockChatSend({
        initialSessionId: 'session-other',
        pendingSessionIds: {},
        draftSending: false,
        isSessionStreaming: () => false,
        isSessionExecuting,
      } as Parameters<typeof shouldBlockChatSend>[0]),
    ).toBe(false)
  })

  it('reuses the existing SessionList execution marker for durable tasks', () => {
    expect(sessionListSource).toContain('chatStore.isSessionExecuting(sessionId)')
  })

  it('binds the current-session durable lock to the existing red stop/disabled composer state', () => {
    expect(chatViewSource).toContain('chatStore.isCurrentSessionExecuting')
    expect(chatInputSource).toMatch(
      /hc-composer__send--stop[\s\S]*:disabled="disabled"/,
    )
  })
})
