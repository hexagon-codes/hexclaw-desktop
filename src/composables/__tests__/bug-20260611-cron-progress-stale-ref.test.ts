import { describe, it, expect, vi } from 'vitest'

// BUG-20260611 (install-test finding #4): the cron create card never showed
// SSE compile progress. handleConversationAction flips the action to
// 'running' via an IMMUTABLE store update (the action object is replaced),
// but executeConversationAction kept mutating the STALE pre-update reference
// (`action.progress = …`) — so progress never reached the store and the card
// stayed on the static "准备编译脚本…" text for the whole 30-90s compile.
//
// Contract: progress events must land on the action object currently held by
// the store, mid-flight, while status === 'running'.

vi.mock('@/api/tasks', () => ({
  createCronJob: vi.fn(),
  deleteCronJob: vi.fn(),
  getCronJobs: vi.fn(),
  pauseCronJob: vi.fn(),
  resumeCronJob: vi.fn(),
  triggerCronJob: vi.fn(),
}))
vi.mock('@/api/knowledge', () => ({
  addDocument: vi.fn(),
  deleteDocument: vi.fn(),
  getDocuments: vi.fn(),
  reindexDocument: vi.fn(),
  searchKnowledge: vi.fn(),
}))

import { useConversationAutomation } from '../useConversationAutomation'
import { CHAT_AUTOMATION_METADATA_KEY } from '@/utils/chat-automation'
import * as tasks from '@/api/tasks'

function makeAction() {
  return {
    id: 'a1',
    kind: 'create_task' as const,
    title: '创建定时任务',
    description: '',
    status: 'pending' as const,
    payload: { name: '百度热搜采集', schedule: '0 18 * * *', prompt: '采集百度热搜TOP20 写入知识库' },
  }
}

// Mirrors the real pinia store semantics: updateMessage REPLACES the message
// (and therefore the action objects) immutably.
function makeImmutableStore() {
  const store = {
    messages: [
      {
        id: 'm1',
        role: 'assistant',
        content: '',
        metadata: { [CHAT_AUTOMATION_METADATA_KEY]: [makeAction()] },
      } as any,
    ],
    async updateMessage(id: string, updater: (m: any) => any) {
      const idx = store.messages.findIndex((m) => m.id === id)
      if (idx >= 0) store.messages[idx] = updater(store.messages[idx])
    },
  }
  return store
}

function storedAction(store: ReturnType<typeof makeImmutableStore>) {
  return (store.messages[0].metadata as any)[CHAT_AUTOMATION_METADATA_KEY].find(
    (a: any) => a.id === 'a1',
  )
}

describe('BUG-20260611 cron create card progress', () => {
  it('progress events reach the store-held action while running', async () => {
    const store = makeImmutableStore()
    const toast = { success: vi.fn(), error: vi.fn() }

    let emitProgress: ((p: { stage: string; message: string }) => void) | undefined
    let finishCreate!: (v: any) => void
    vi.mocked(tasks.createCronJob).mockImplementation((_input: any, options?: any) => {
      emitProgress = options?.onProgress
      return new Promise((resolve) => {
        finishCreate = resolve
      })
    })

    const { handleConversationAction } = useConversationAutomation(store as any, toast as any)
    const done = handleConversationAction('m1', 'a1')

    await vi.waitFor(() => {
      expect(storedAction(store).status).toBe('running')
      expect(emitProgress).toBeTypeOf('function')
    })

    emitProgress!({ stage: 'calling_llm', message: '调用 LLM 生成 Python 脚本…' })
    await vi.waitFor(() => {
      const current = storedAction(store)
      expect(current.progress?.stage).toBe('calling_llm')
    })

    emitProgress!({ stage: 'validating', message: '校验脚本安全性…' })
    await vi.waitFor(() => {
      expect(storedAction(store).progress?.stage).toBe('validating')
    })

    finishCreate({ job: { id: 'cron-x', name: '百度热搜采集', next_run_at: '' } })
    await done
    expect(storedAction(store).status).toBe('completed')
  })

  it('startedAt is stamped on running so the card can render elapsed time', async () => {
    const store = makeImmutableStore()
    const toast = { success: vi.fn(), error: vi.fn() }
    vi.mocked(tasks.createCronJob).mockResolvedValue({
      job: { id: 'cron-y', name: 'n', next_run_at: '' },
    } as any)

    const { handleConversationAction } = useConversationAutomation(store as any, toast as any)
    const before = Date.now()
    await handleConversationAction('m1', 'a1')

    const current = storedAction(store)
    expect(current.startedAt).toBeTypeOf('number')
    expect(current.startedAt).toBeGreaterThanOrEqual(before)
  })
})
