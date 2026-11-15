import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import K12RecordsView from '../views/K12RecordsView.vue'
import { useK12Store } from '../store'

const h = vi.hoisted(() => ({ accumulation: vi.fn(), add: vi.fn(), mistakes: vi.fn(), record: vi.fn() }))
vi.mock('@/api/k12', async () => ({
  ...(await import('./weekly-practice-api-mock')).weeklyPracticeApiMockDefaults('child-a'),
  k12ListMistakes: (...args: unknown[]) => h.mistakes(...args),
  k12ReviewQueue: vi.fn().mockResolvedValue({ items: [] }),
  k12InsightReport: vi.fn().mockResolvedValue({
    trend: { total: 0 }, weak_top3: [], consecutive_fail_kps: [], suggestion: '',
    month_new_mistakes: 0, review_completion_rate: 0,
  }),
  k12ListAccumulation: (...args: unknown[]) => h.accumulation(...args),
  k12AddAccumulation: (...args: unknown[]) => h.add(...args),
  k12RecordMistake: (...args: unknown[]) => h.record(...args),
  k12ListPracticeSets: vi.fn().mockResolvedValue({ items: [] }),
  k12ListCreativeWorks: vi.fn().mockResolvedValue({ items: [] }),
  k12GetMistakePracticeGeneration: vi.fn().mockImplementation((_agent: string, record: string) =>
    Promise.resolve({ state: 'available', source_mistake_id: record }),
  ),
}))
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
function accumulation(agent: string, pending = false) {
  return { items: [{
    record_id: `${agent}-record`, content: `${agent}-content`, subject: '语文',
    entry_type: '好词好句', status: 'new', version: 1, created_at: 1,
    ...(pending ? { dictation_generation: { generation_id: 'generation-b', status: 'queued', attempt: 1 } } : {}),
  }] }
}
function render(agentId: string, pinia: ReturnType<typeof createPinia>) {
  return mount(K12RecordsView, {
    props: { agentId, agentName: agentId, grade: '六年级上', active: true },
    global: { plugins: [pinia, createI18n({
      legacy: false, locale: 'zh-CN', messages: { 'zh-CN': { ...zhCN, k12: k12Zh } },
    })] },
  })
}
beforeEach(() => {
  vi.useFakeTimers()
  h.accumulation.mockReset().mockImplementation((agent: string) => Promise.resolve(accumulation(agent)))
  h.add.mockReset()
  h.record.mockReset()
  h.mistakes.mockReset().mockImplementation((agent: string) => Promise.resolve({ items: [{
    record_id: `${agent}-mistake`, question: `${agent}-question`, status: 'new',
    knowledge_point: '整数计算', version: 1,
  }] }))
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('K12档案命令与读取归属', () => {
  it('旧孩子积累保存完成，不重新读取旧孩子或改写新孩子投影', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const write = deferred<unknown>()
    h.add.mockReturnValueOnce(write.promise)
    const a = render('child-a', pinia)
    await flushPromises()
    const vm = a.vm as unknown as { accumForm: { content: string }; submitAccum(): Promise<void> }
    vm.accumForm.content = 'A new accumulation'
    const command = vm.submitAccum()
    a.unmount()
    const b = render('child-b', pinia)
    try {
      await flushPromises()
      write.resolve({ record_id: 'child-a-new', created: true })
      await command
      await flushPromises()

      expect(h.add.mock.calls[0]?.[0]).toBe('child-a')
      expect(h.accumulation.mock.calls.map(([agent]) => agent)).toEqual(['child-a', 'child-b'])
      expect(useK12Store(pinia).accumView?.items.map((item) => item.agentId)).toEqual(['child-b'])
    } finally {
      b.unmount()
    }
  })

  it('卸载后的旧读取不能重新安排积累轮询，活动孩子原轮询继续', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const old = deferred<ReturnType<typeof accumulation>>()
    let firstA = true
    h.accumulation.mockImplementation((agent: string) => {
      if (agent === 'child-a' && firstA) {
        firstA = false
        return old.promise
      }
      return Promise.resolve(accumulation(agent, agent === 'child-b'))
    })
    const a = render('child-a', pinia)
    await flushPromises()
    a.unmount()
    const b = render('child-b', pinia)
    try {
      await flushPromises()
      old.resolve(accumulation('child-a'))
      await flushPromises()
      await vi.advanceTimersByTimeAsync(1_500)

      expect(h.accumulation.mock.calls.map(([agent]) => agent)).toEqual(['child-a', 'child-b', 'child-b'])
      expect(useK12Store(pinia).accumView?.items.map((item) => item.agentId)).toEqual(['child-b'])
    } finally {
      b.unmount()
    }
  })

  it('旧孩子手工新增错题完成，不重新选择旧孩子的共享错题投影', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const write = deferred<unknown>()
    h.record.mockReturnValueOnce(write.promise)
    const a = render('child-a', pinia)
    await flushPromises()
    const vm = a.vm as unknown as {
      mistakeForm: { subject: string; problem: string; studentAnswer: string; knowledgePoints: string }
      submitMistake(): Promise<void>
    }
    vm.mistakeForm = { subject: '数学', problem: '2 + 2 = ?', studentAnswer: '3', knowledgePoints: '整数计算' }
    const command = vm.submitMistake()
    a.unmount()
    const b = render('child-b', pinia)
    try {
      await flushPromises()
      write.resolve({ record_id: 'child-a-added', record_created: true })
      await command
      await flushPromises()

      expect(h.record.mock.calls[0]?.[0].agent).toBe('child-a')
      expect(h.mistakes.mock.calls.map(([agent]) => agent)).toEqual(['child-a', 'child-b'])
      expect(useK12Store(pinia).mistakeView?.items.map((item) => item.agentId)).toEqual(['child-b'])
    } finally {
      b.unmount()
    }
  })
})
