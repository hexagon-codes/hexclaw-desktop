import { ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import RecognizeGuardPanel from '../views/RecognizeGuardPanel.vue'
import chatEnhancementSource from '../views/K12ChatEnhancement.vue?raw'
import chatViewSource from '@/views/ChatView.vue?raw'
import {
  createSessionExecutionRegistry,
  type SessionExecutionSnapshot,
  type SessionExecutionState,
} from '@/stores/session-execution-registry'
import type { ImageTaskDispatchDTO } from '@/api/k12'

const h = vi.hoisted(() => ({
  dispatchImageTask: vi.fn(),
  restoreImageTaskDispatch: vi.fn(),
  completeImageTask: vi.fn(),
  confirmImageTask: vi.fn(),
  retryImageTask: vi.fn(),
  waitForImageTaskHomeworkAnchor: vi.fn(),
  coldStart: vi.fn(),
}))

vi.mock('../store', () => ({
  useK12Store: () => h,
}))

function i18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: { ...zhCN, k12: k12Zh } },
  })
}

function abortablePending(signal?: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const abort = () => reject(new DOMException('aborted', 'AbortError'))
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
  })
}

function dispatchSnapshot(stage: 'recognizing' | 'assessing' | 'recovering' | 'outcome_unknown') {
  return {
    dispatch_id: 'dispatch-1',
    task_intent: 'completed_homework',
    status: 'routed',
    retryable: false,
    intent_evidence: [],
    intent_confidence: 0.99,
    confirmation_candidates: [],
    target: { type: 'homework_submission', id: 'submission-1' },
    target_projection: {
      kind: 'homework',
      stage,
      confirmation_state: 'confirmed',
      anchor_state: 'pending',
      recognition: { questions: [], subject: '数学' },
    },
    provider_display_name: 'HexClaw-GPT',
    model_id: 'gpt-5.6-sol',
    progress: { operation: 'homework', state: stage },
    version: 1,
    created_at: 1,
    updated_at: 2,
  } as ImageTaskDispatchDTO
}

function mountLive() {
  return mount(RecognizeGuardPanel, {
    props: {
      agentId: 'mingming',
      sessionId: 'session-1',
      requestId: 'message-1',
      sourceMessageId: 'message-1',
      initialImage: 'data:image/png;base64,Zm9v',
    },
    global: { plugins: [i18n()] },
  })
}

function mountRestored() {
  return mount(RecognizeGuardPanel, {
    props: {
      agentId: 'mingming',
      sessionId: 'session-1',
      requestId: 'message-1',
      sourceMessageId: 'message-1',
      restoreDispatchId: 'dispatch-1',
    },
    global: { plugins: [i18n()] },
  })
}

function projectExecutionEvents(
  wrapper: ReturnType<typeof mountLive>,
  registry: ReturnType<typeof createSessionExecutionRegistry>,
) {
  for (const [payload] of wrapper.emitted('update:executionState') ?? []) {
    const snapshot = payload as SessionExecutionSnapshot & { sessionId: string }
    registry.setSessionExecution(snapshot.sessionId, snapshot)
  }
  for (const [payload] of wrapper.emitted('release:executionState') ?? []) {
    const release = payload as { sessionId: string; executionId: string }
    registry.clearSessionExecution(release.sessionId, release.executionId)
  }
}

describe('BUG-K12-TASKSHELL-UNMOUNT-EXECUTION-LOCK-20260824', () => {
  beforeEach(() => {
    localStorage.clear()
    Object.values(h).forEach((spy) => spy.mockReset())
  })

  it('尚无 durable dispatch 时卸载只释放 routing reservation', async () => {
    h.dispatchImageTask.mockImplementation((_input, signal) => abortablePending(signal))
    const executions = ref<SessionExecutionState>({})
    const registry = createSessionExecutionRegistry(executions)
    const wrapper = mountLive()
    await flushPromises()

    projectExecutionEvents(wrapper, registry)
    expect(registry.isSessionExecuting('session-1')).toBe(true)
    expect(h.dispatchImageTask).toHaveBeenCalledTimes(1)

    wrapper.unmount()
    await flushPromises()
    projectExecutionEvents(wrapper, registry)

    expect(wrapper.emitted('release:executionState')).toEqual([
      [{ sessionId: 'session-1', executionId: 'message-1' }],
    ])
    expect(registry.isSessionExecuting('session-1')).toBe(false)
    expect(h.confirmImageTask).not.toHaveBeenCalled()
    expect(h.retryImageTask).not.toHaveBeenCalled()
  })

  it('已有 durable dispatch 时卸载释放 UI 执行锁但不取消、不重发', async () => {
    h.dispatchImageTask.mockImplementation((_input, signal, onStatus) => {
      onStatus?.(dispatchSnapshot('recognizing'))
      return abortablePending(signal)
    })
    const executions = ref<SessionExecutionState>({})
    const registry = createSessionExecutionRegistry(executions)
    const wrapper = mountLive()
    await flushPromises()

    projectExecutionEvents(wrapper, registry)
    expect(registry.isSessionExecuting('session-1')).toBe(true)

    wrapper.unmount()
    await flushPromises()
    projectExecutionEvents(wrapper, registry)

    expect(registry.isSessionExecuting('session-1')).toBe(false)
    expect(h.dispatchImageTask).toHaveBeenCalledTimes(1)
    expect(h.confirmImageTask).not.toHaveBeenCalled()
    expect(h.retryImageTask).not.toHaveBeenCalled()
  })

  it('切换辅导对象时先归还旧 TaskShell 的执行投影', async () => {
    h.dispatchImageTask.mockImplementation((_input, signal, onStatus) => {
      onStatus?.(dispatchSnapshot('recognizing'))
      return abortablePending(signal)
    })
    const executions = ref<SessionExecutionState>({})
    const registry = createSessionExecutionRegistry(executions)
    const wrapper = mountLive()
    await flushPromises()
    projectExecutionEvents(wrapper, registry)
    expect(registry.isSessionExecuting('session-1')).toBe(true)

    await wrapper.setProps({ agentId: 'xiaowang' })
    await flushPromises()
    projectExecutionEvents(wrapper, registry)

    expect(registry.isSessionExecuting('session-1')).toBe(false)
    expect(wrapper.emitted('release:executionState')).toEqual([
      [{ sessionId: 'session-1', executionId: 'message-1' }],
    ])
    expect(h.confirmImageTask).not.toHaveBeenCalled()
    expect(h.retryImageTask).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('重挂只按服务端 active 快照恢复登记，query-only 快照始终不占锁', async () => {
    const executions = ref<SessionExecutionState>({})
    const registry = createSessionExecutionRegistry(executions)

    h.restoreImageTaskDispatch.mockImplementation((_agent, _input, signal, onStatus) => {
      onStatus?.(dispatchSnapshot('assessing'))
      return abortablePending(signal)
    })
    const active = mountRestored()
    await flushPromises()
    projectExecutionEvents(active, registry)
    expect(registry.isSessionExecuting('session-1')).toBe(true)
    active.unmount()
    await flushPromises()
    projectExecutionEvents(active, registry)
    expect(registry.isSessionExecuting('session-1')).toBe(false)

    for (const state of ['recovering', 'outcome_unknown'] as const) {
      h.restoreImageTaskDispatch.mockImplementation((_agent, _input, signal, onStatus) => {
        onStatus?.(dispatchSnapshot(state))
        return abortablePending(signal)
      })
      const queryOnly = mountRestored()
      await flushPromises()
      projectExecutionEvents(queryOnly, registry)
      expect(registry.isSessionExecuting('session-1')).toBe(false)
      queryOnly.unmount()
      await flushPromises()
    }

    expect(h.restoreImageTaskDispatch).toHaveBeenCalledTimes(3)
    expect(h.dispatchImageTask).not.toHaveBeenCalled()
    expect(h.confirmImageTask).not.toHaveBeenCalled()
    expect(h.retryImageTask).not.toHaveBeenCalled()
  })

  it('release 事件只沿现有场景边界透传并清理同一执行身份', () => {
    expect(chatEnhancementSource).toContain("e: 'release:sessionExecution'")
    expect(chatEnhancementSource).toContain(
      `@release:execution-state="emit('release:sessionExecution', $event)"`,
    )
    expect(chatViewSource).toContain(
      '@release:session-execution="handleScenarioSessionExecutionRelease"',
    )
    expect(chatViewSource).toMatch(
      /function handleScenarioSessionExecutionRelease[\s\S]*chatStore\.clearSessionExecution\(\s*payload\.sessionId,\s*payload\.executionId,?\s*\)/,
    )
  })
})
