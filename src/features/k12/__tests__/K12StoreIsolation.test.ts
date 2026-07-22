import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useK12Store } from '../store'

const h = vi.hoisted(() => ({
  listMistakes: vi.fn(),
  reviewQueue: vi.fn(),
  insightReport: vi.fn(),
  accumulation: vi.fn(),
  prepCard: vi.fn(),
}))

vi.mock('@/api/k12', () => ({
  k12ListMistakes: (agent: string) => h.listMistakes(agent),
  k12ReviewQueue: (agent: string) => h.reviewQueue(agent),
  k12InsightReport: (agent: string) => h.insightReport(agent),
  k12ListAccumulation: (agent: string) => h.accumulation(agent),
  k12MarkMastered: vi.fn(),
  k12PrepCard: (req: { agent: string }) => h.prepCard(req),
  k12Grade: vi.fn(),
    k12ColdStart: vi.fn(),
  k12TutorTurn: vi.fn(),
  k12BindIM: vi.fn(),
  k12ProvisionCron: vi.fn(),
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

describe('K12 records 多孩异步隔离', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    Object.values(h).forEach((spy) => spy.mockReset())
  })

  it('错题请求乱序返回时，只保留最后切换到的孩子', async () => {
    const oldAll = deferred<{ items: any[] }>()
    const oldDue = deferred<{ items: any[] }>()
    const newAll = deferred<{ items: any[] }>()
    const newDue = deferred<{ items: any[] }>()
    h.listMistakes.mockImplementation((agent: string) => agent === 'old-child' ? oldAll.promise : newAll.promise)
    h.reviewQueue.mockImplementation((agent: string) => agent === 'old-child' ? oldDue.promise : newDue.promise)
    const store = useK12Store()

    const oldLoad = store.loadMistakes('old-child')
    const newLoad = store.loadMistakes('new-child')
    newAll.resolve({ items: [{ record_id: 'new-r', question: '新题', knowledge_point: '小数乘法', error_cause: '', status: 'new', version: 1 }] })
    newDue.resolve({ items: [] })
    await newLoad
    oldAll.resolve({ items: [{ record_id: 'old-r', question: '旧题', knowledge_point: '整数乘法', error_cause: '', status: 'new', version: 1 }] })
    oldDue.resolve({ items: [] })
    await oldLoad

    expect(store.mistakeView?.items[0]?.fields.question).toBe('新题')
  })

  it('辅导要点乱序返回时，只保留最后切换到的孩子', async () => {
    const oldPrep = deferred<any>()
    const newPrep = deferred<any>()
    h.prepCard.mockImplementation((req: { agent: string }) => req.agent === 'old-child' ? oldPrep.promise : newPrep.promise)
    const store = useK12Store()

    const oldLoad = store.loadPrepCard('old-child', '五年级上', '数学', ['整数乘法'])
    const newLoad = store.loadPrepCard('new-child', '五年级上', '数学', ['小数乘法'])
    newPrep.resolve({ knowledge_points: ['小数乘法'], sections: [{ title: '新孩子', content: '新内容', source_label: '📖 依据课本' }] })
    await newLoad
    oldPrep.resolve({ knowledge_points: ['整数乘法'], sections: [{ title: '旧孩子', content: '旧内容', source_label: '📖 依据课本' }] })
    await oldLoad

    expect(store.prepCard?.sections[0]?.title).toBe('新孩子')
  })

  // study-time 已退役（架构设计 v0.5.0《明确不做》#6）：store 不再有 studyTime/loadStudyTime。
  it('报告、积累本乱序返回时，也只保留最后切换到的孩子', async () => {
    const oldReport = deferred<any>()
    const newReport = deferred<any>()
    const oldAccum = deferred<any>()
    const newAccum = deferred<any>()
    h.insightReport.mockImplementation((agent: string) => agent === 'old-child' ? oldReport.promise : newReport.promise)
    h.accumulation.mockImplementation((agent: string) => agent === 'old-child' ? oldAccum.promise : newAccum.promise)
    const store = useK12Store()

    const oldLoads = Promise.all([store.loadReport('old-child'), store.loadAccumulation('old-child')])
    const newLoads = Promise.all([store.loadReport('new-child'), store.loadAccumulation('new-child')])
    newReport.resolve({ suggestion: '新孩子报告' })
    newAccum.resolve({ items: [{ record_id: 'new-a', subject: '语文', entry_type: '好词好句', content: '新积累', status: 'new' }] })
    await newLoads
    oldReport.resolve({ suggestion: '旧孩子报告' })
    oldAccum.resolve({ items: [{ record_id: 'old-a', subject: '语文', entry_type: '好词好句', content: '旧积累', status: 'new' }] })
    await oldLoads

    expect(store.report?.suggestion).toBe('新孩子报告')
    expect(store.accumView?.items[0]?.fields.content).toBe('新积累')
  })

  it('反向契约：store 不再暴露 studyTime 状态与 loadStudyTime（《明确不做》#6）', () => {
    const store = useK12Store() as unknown as Record<string, unknown>
    expect(store.studyTime).toBeUndefined()
    expect(store.loadStudyTime).toBeUndefined()
  })

  it('旧孩子积累请求延迟失败时，不污染新孩子的 error 状态', async () => {
    const oldAccum = deferred<any>()
    h.accumulation.mockImplementation((agent: string) => (
      agent === 'old-child' ? oldAccum.promise : Promise.resolve({ items: [] })
    ))
    const store = useK12Store()

    const oldLoad = store.loadAccumulation('old-child')
    await store.loadAccumulation('new-child')
    oldAccum.reject(new Error('old child failed'))
    await oldLoad

    expect(store.error).toBeNull()
  })

  it('报告与积累的失败状态相互独立，不会由并行请求互相覆盖', async () => {
    h.insightReport.mockRejectedValue(new Error('报告加载失败'))
    h.accumulation.mockRejectedValue(new Error('积累加载失败'))
    const store = useK12Store()

    await Promise.all([
      store.loadReport('current-child'),
      store.loadAccumulation('current-child'),
    ])

    expect(store.reportError).toBe('报告加载失败')
    expect(store.accumulationError).toBe('积累加载失败')
    expect(store.mistakesError).toBeNull()
  })

  it('新孩子请求发出时立即清空旧孩子投影，不在等待期间短暂串屏', async () => {
    const oldMistake = { record_id: 'old-r', question: '旧题', knowledge_point: '旧知识点', error_cause: '', status: 'new', version: 1 }
    h.listMistakes.mockResolvedValueOnce({ items: [oldMistake] })
    h.reviewQueue.mockResolvedValueOnce({ items: [] })
    h.insightReport.mockResolvedValueOnce({ suggestion: '旧报告' })
    h.accumulation.mockResolvedValueOnce({ items: [{ record_id: 'old-a', subject: '语文', entry_type: '好词好句', content: '旧积累', status: 'new' }] })
    const store = useK12Store()
    await Promise.all([
      store.loadMistakes('old-child'), store.loadReport('old-child'),
      store.loadAccumulation('old-child'),
    ])

    const nextAll = deferred<any>()
    const nextDue = deferred<any>()
    const nextReport = deferred<any>()
    const nextAccum = deferred<any>()
    h.listMistakes.mockReturnValueOnce(nextAll.promise)
    h.reviewQueue.mockReturnValueOnce(nextDue.promise)
    h.insightReport.mockReturnValueOnce(nextReport.promise)
    h.accumulation.mockReturnValueOnce(nextAccum.promise)
    const pending = Promise.all([
      store.loadMistakes('new-child'), store.loadReport('new-child'),
      store.loadAccumulation('new-child'),
    ])

    expect(store.mistakeView).toBeNull()
    expect(store.report).toBeNull()
    expect(store.accumView).toBeNull()

    nextAll.resolve({ items: [] })
    nextDue.resolve({ items: [] })
    nextReport.resolve({ suggestion: '新报告' })
    nextAccum.resolve({ items: [] })
    await pending
  })
})
