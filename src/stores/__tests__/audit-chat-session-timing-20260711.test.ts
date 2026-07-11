/**
 * hex-test 审计 · U2：newSession/deleteSession 不 bump sessionSelectionGen。
 * selectSession 靠 gen 代际守卫防竞态（gen 变了则放弃写 messages）；但 newSession/deleteSession
 * 清 messages 时不 bump gen → 慢网下在途 selectSession 的旧消息晚到会灌进空白新会话
 * （幽灵消息，currentSessionId 却为 null）/ 写回已删会话。
 * RED（未 bump）：gen 不变 → FAIL；GREEN（bump）：gen 递增，使在途 selectSession 失效。
 */
import { describe, it, expect, vi } from 'vitest'
import { ref } from 'vue'
import type { ChatMessage, Artifact } from '@/types'
import { createChatSessionLifecycleController } from '@/stores/chat-session-lifecycle'

function makeParams() {
  const sessionSelectionGen = ref(0)
  const currentSessionId = ref<string | null>('existing-session')
  const messages = ref<ChatMessage[]>([{ id: 'm1' } as ChatMessage])
  return {
    sessionSelectionGen,
    params: {
      currentSessionId,
      messages,
      artifacts: ref<Artifact[]>([]),
      selectedArtifactId: ref<string | null>(null),
      showArtifacts: ref(false),
      error: ref(null),
      pendingSessionTitle: ref<string | null>(null),
      hasCustomTitle: ref(false),
      pendingSessionIds: ref<Record<string, boolean>>({}),
      ensureSessionPromise: ref<Promise<string> | null>(null),
      cancelledSessions: new Set<string>(),
      sessionSelectionGen,
      msgSvc: { deleteSession: vi.fn().mockResolvedValue(undefined) } as never,
      logger: { warn: vi.fn(), error: vi.fn() } as never,
      createId: () => 'id',
      syncStreamingMirrors: () => {},
      isSessionStreaming: () => false,
      stopSessionStream: () => false,
      resetSessionStream: () => {},
      clearSessionCancelled: () => {},
      markSessionCancelled: () => {},
      upsertLocalSession: () => {},
    },
  }
}

describe('hex-test U2 · newSession/deleteSession bump sessionSelectionGen', () => {
  it('newSession 必须 bump gen（使在途 selectSession 失效，防幽灵消息灌入空白新会话）', () => {
    const { sessionSelectionGen, params } = makeParams()
    const before = sessionSelectionGen.value
    createChatSessionLifecycleController(params).newSession()
    expect(sessionSelectionGen.value).toBeGreaterThan(before)
  })

  it('deleteSession 必须 bump gen（使针对被删会话的在途 selectSession 失效，防写回已删会话）', async () => {
    const { sessionSelectionGen, params } = makeParams()
    const before = sessionSelectionGen.value
    await createChatSessionLifecycleController(params).deleteSession('existing-session')
    expect(sessionSelectionGen.value).toBeGreaterThan(before)
  })
})
