import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useK12Store } from '../store'

const h = vi.hoisted(() => ({
  listMistakes: vi.fn(),
  reviewQueue: vi.fn(),
  insightReport: vi.fn(),
  studyTime: vi.fn(),
  accumulation: vi.fn(),
}))

vi.mock('@/api/k12', () => ({
  k12ListMistakes: (agent: string) => h.listMistakes(agent),
  k12ReviewQueue: (agent: string) => h.reviewQueue(agent),
  k12InsightReport: (agent: string) => h.insightReport(agent),
  k12StudyTime: (agent: string) => h.studyTime(agent),
  k12ListAccumulation: (agent: string) => h.accumulation(agent),
  k12MarkMastered: vi.fn(),
  k12PrepCard: vi.fn(),
  k12Grade: vi.fn(),
  k12Recognize: vi.fn(),
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

  it('报告、学习时长、积累本乱序返回时，也只保留最后切换到的孩子', async () => {
    const oldReport = deferred<any>()
    const newReport = deferred<any>()
    const oldTime = deferred<any>()
    const newTime = deferred<any>()
    const oldAccum = deferred<any>()
    const newAccum = deferred<any>()
    h.insightReport.mockImplementation((agent: string) => agent === 'old-child' ? oldReport.promise : newReport.promise)
    h.studyTime.mockImplementation((agent: string) => agent === 'old-child' ? oldTime.promise : newTime.promise)
    h.accumulation.mockImplementation((agent: string) => agent === 'old-child' ? oldAccum.promise : newAccum.promise)
    const store = useK12Store()

    const oldLoads = Promise.all([store.loadReport('old-child'), store.loadStudyTime('old-child'), store.loadAccumulation('old-child')])
    const newLoads = Promise.all([store.loadReport('new-child'), store.loadStudyTime('new-child'), store.loadAccumulation('new-child')])
    newReport.resolve({ suggestion: '新孩子报告' })
    newTime.resolve({ total_minutes: 20, total_records: 2, days: [], note: '新孩子时长' })
    newAccum.resolve({ items: [{ record_id: 'new-a', subject: '语文', entry_type: '好词好句', content: '新积累', status: 'new' }] })
    await newLoads
    oldReport.resolve({ suggestion: '旧孩子报告' })
    oldTime.resolve({ total_minutes: 99, total_records: 9, days: [], note: '旧孩子时长' })
    oldAccum.resolve({ items: [{ record_id: 'old-a', subject: '语文', entry_type: '好词好句', content: '旧积累', status: 'new' }] })
    await oldLoads

    expect(store.report?.suggestion).toBe('新孩子报告')
    expect(store.studyTime?.note).toBe('新孩子时长')
    expect(store.accumView?.items[0]?.fields.content).toBe('新积累')
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

  it('新孩子请求发出时立即清空旧孩子投影，不在等待期间短暂串屏', async () => {
    const oldMistake = { record_id: 'old-r', question: '旧题', knowledge_point: '旧知识点', error_cause: '', status: 'new', version: 1 }
    h.listMistakes.mockResolvedValueOnce({ items: [oldMistake] })
    h.reviewQueue.mockResolvedValueOnce({ items: [] })
    h.insightReport.mockResolvedValueOnce({ suggestion: '旧报告' })
    h.studyTime.mockResolvedValueOnce({ total_minutes: 99, total_records: 9, days: [], note: '旧时长' })
    h.accumulation.mockResolvedValueOnce({ items: [{ record_id: 'old-a', subject: '语文', entry_type: '好词好句', content: '旧积累', status: 'new' }] })
    const store = useK12Store()
    await Promise.all([
      store.loadMistakes('old-child'), store.loadReport('old-child'),
      store.loadStudyTime('old-child'), store.loadAccumulation('old-child'),
    ])

    const nextAll = deferred<any>()
    const nextDue = deferred<any>()
    const nextReport = deferred<any>()
    const nextTime = deferred<any>()
    const nextAccum = deferred<any>()
    h.listMistakes.mockReturnValueOnce(nextAll.promise)
    h.reviewQueue.mockReturnValueOnce(nextDue.promise)
    h.insightReport.mockReturnValueOnce(nextReport.promise)
    h.studyTime.mockReturnValueOnce(nextTime.promise)
    h.accumulation.mockReturnValueOnce(nextAccum.promise)
    const pending = Promise.all([
      store.loadMistakes('new-child'), store.loadReport('new-child'),
      store.loadStudyTime('new-child'), store.loadAccumulation('new-child'),
    ])

    expect(store.mistakeView).toBeNull()
    expect(store.report).toBeNull()
    expect(store.studyTime).toBeNull()
    expect(store.accumView).toBeNull()

    nextAll.resolve({ items: [] })
    nextDue.resolve({ items: [] })
    nextReport.resolve({ suggestion: '新报告' })
    nextTime.resolve({ total_minutes: 0, total_records: 0, days: [], note: '新时长' })
    nextAccum.resolve({ items: [] })
    await pending
  })
})
