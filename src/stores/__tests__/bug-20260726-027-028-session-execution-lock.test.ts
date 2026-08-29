import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import sessionListSource from '@/components/chat/SessionList.vue?raw'
import chatViewSource from '@/views/ChatView.vue?raw'
import chatInputSource from '@/components/chat/ChatInput.vue?raw'
import { shouldBlockChatSend } from '../chat-send-guards'
import {
  createSessionExecutionRegistry,
  type SessionExecutionState,
} from '../session-execution-registry'

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
    expect(chatInputSource).toMatch(/hc-composer__send--stop[\s\S]*:disabled="disabled"/)
  })

  it.each(['recovering', 'outcome_unknown'])(
    '%s is query-only, releases the shared lock, and can register the same dispatch again when assessing resumes',
    (state) => {
      const executions = ref<SessionExecutionState>({})
      const registry = createSessionExecutionRegistry(executions)

      registry.setSessionExecution('session-1', {
        executionId: 'dispatch-1',
        state,
      })

      expect(registry.isSessionExecuting('session-1')).toBe(false)
      expect(executions.value['session-1']).toBeUndefined()

      registry.setSessionExecution('session-1', {
        executionId: 'dispatch-1',
        state: 'assessing',
      })

      expect(registry.isSessionExecuting('session-1')).toBe(true)
      expect(executions.value['session-1']?.['dispatch-1']?.state).toBe('assessing')
    },
  )

  it('does not treat a stale query-only snapshot already present in the registry as executing', () => {
    const executions = ref<SessionExecutionState>({
      'session-1': {
        'dispatch-1': {
          executionId: 'dispatch-1',
          state: 'recovering',
        },
      },
    })
    const registry = createSessionExecutionRegistry(executions)

    expect(registry.isSessionExecuting('session-1')).toBe(false)
  })

  it('keeps another active execution locked when one dispatch becomes query-only', () => {
    const executions = ref<SessionExecutionState>({})
    const registry = createSessionExecutionRegistry(executions)

    registry.setSessionExecution('session-1', {
      executionId: 'dispatch-query-only',
      state: 'assessing',
    })
    registry.setSessionExecution('session-1', {
      executionId: 'dispatch-active',
      state: 'recognizing',
    })
    registry.setSessionExecution('session-1', {
      executionId: 'dispatch-query-only',
      state: 'recovering',
    })

    expect(registry.isSessionExecuting('session-1')).toBe(true)
    expect(Object.keys(executions.value['session-1'] ?? {})).toEqual(['dispatch-active'])
  })
})
