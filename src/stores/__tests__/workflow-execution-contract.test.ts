import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useCanvasStore } from '../canvas'
import * as api from '@/api/canvas'

vi.mock('@/api/canvas', () => ({
  listPanels: vi.fn(), getPanel: vi.fn(), sendCanvasEvent: vi.fn(),
  saveWorkflow: vi.fn(), getWorkflows: vi.fn(), deleteWorkflow: vi.fn(),
  runWorkflow: vi.fn(), getWorkflowRun: vi.fn(), resumeWorkflowRun: vi.fn(),
  getWorkflowRuns: vi.fn(), cancelWorkflowRun: vi.fn(), deleteWorkflowRun: vi.fn(),
}))

const definition = { id: 'wf-1', name: 'Task', nodes: [{ id: 'a', type: 'agent' as const, label: 'Task', x: 0, y: 0, config: { prompt: 'Analyze' } }], edges: [], created_at: '', updated_at: '' }
const running = { id: 'run-1', workflow_id: 'wf-1', status: 'running' as const, started_at: '2026-10-18T00:00:00Z' }

describe('工作流非显示执行合同', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    setActivePinia(createPinia())
    vi.mocked(api.saveWorkflow).mockResolvedValue(definition)
    vi.mocked(api.getWorkflows).mockResolvedValue([definition])
  })
  afterEach(() => vi.useRealTimers())

  it('删除仅在服务端成功后更新历史、总量和当前运行，工作流定义保持', async () => {
    const store = useCanvasStore()
    store.loadWorkflowToCanvas(definition)
    const ended = { ...running, status: 'completed' as const, output: 'kept' }
    vi.mocked(api.getWorkflowRun).mockResolvedValue(ended)
    await store.inspectRun(ended.id)
    store.runHistory.push({ ...ended, id: 'run-2' })
    store.runHistoryCount = 2
    let commit!: () => void
    vi.mocked(api.deleteWorkflowRun).mockImplementation(() => new Promise<void>((resolve) => { commit = resolve }))
    const deleting = store.deleteRun(ended.id)
    expect(store.runHistory).toHaveLength(2)
    expect(store.runHistoryCount).toBe(2)
    expect(store.lastRunId).toBe(ended.id)
    commit()
    expect(await deleting).toBe(true)
    expect(store.runHistory.map((run) => run.id)).toEqual(['run-2'])
    expect(store.runHistoryCount).toBe(1)
    expect(store.lastRunId).toBeNull()
    expect(store.nodes[0]?.config?.prompt).toBe('Analyze')
  })

  it('删除失败保留历史、总量及当前实际结果', async () => {
    const store = useCanvasStore()
    const ended = { ...running, status: 'failed' as const, error: 'known failure' }
    vi.mocked(api.getWorkflowRun).mockResolvedValue(ended)
    await store.inspectRun(ended.id)
    store.runHistoryCount = 1
    vi.mocked(api.deleteWorkflowRun).mockRejectedValue(new Error('disk unavailable'))
    expect(await store.deleteRun(ended.id)).toBe(false)
    expect(store.runHistory[0]?.id).toBe(ended.id)
    expect(store.runHistoryCount).toBe(1)
    expect(store.lastRunId).toBe(ended.id)
    expect(store.runResult?.error).toBe('known failure')
  })

  it('删除后晚到的历史和详情查询不能恢复原记录或数量', async () => {
    const store = useCanvasStore()
    const ended = { ...running, status: 'completed' as const }
    store.runHistory = [ended]
    store.runHistoryCount = 1
    let historyReply!: (value: { runs: typeof ended[] }) => void
    let detailReply!: (value: typeof ended) => void
    vi.mocked(api.getWorkflowRuns).mockImplementation(() => new Promise((resolve) => { historyReply = resolve }))
    vi.mocked(api.getWorkflowRun).mockImplementation(() => new Promise((resolve) => { detailReply = resolve }))
    const history = store.loadRunHistory(null)
    const detail = store.inspectRun(ended.id)
    vi.mocked(api.deleteWorkflowRun).mockResolvedValue(undefined)
    expect(await store.deleteRun(ended.id)).toBe(true)
    historyReply({ runs: [ended] })
    detailReply(ended)
    await Promise.all([history, detail])
    expect(store.runHistory).toEqual([])
    expect(store.runHistoryCount).toBe(0)
    expect(store.lastRunId).toBeNull()
  })

  it('保存冻结资源与时限，编辑中继续修改不改变在途定义', async () => {
    const store = useCanvasStore()
    store.loadWorkflowToCanvas(definition)
    store.workflowData = { run_settings: { timeout: { mode: 'custom', minutes: 10 } } }
    store.nodes[0]!.config = { prompt: 'Analyze', resources: { prompts: { mode: 'override', value: ['prompt-a'] } } }
    const saving = store.saveWorkflow('Task')
    const payload = vi.mocked(api.saveWorkflow).mock.calls[0]![0]
    ;(store.workflowData.run_settings as { timeout: { minutes: number } }).timeout.minutes = 20
    ;(store.nodes[0]!.config.resources as { prompts: { value: string[] } }).prompts.value.push('prompt-b')
    expect(payload.data).toEqual({ run_settings: { timeout: { mode: 'custom', minutes: 10 } } })
    expect(payload.nodes[0]!.config?.resources).toEqual({ prompts: { mode: 'override', value: ['prompt-a'] } })
    await saving
  })

  it('保存失败不启动执行，也不丢失正在编辑的数据', async () => {
    const store = useCanvasStore()
    store.loadWorkflowToCanvas(definition)
    vi.mocked(api.saveWorkflow).mockRejectedValue(new Error('disk unavailable'))
    await store.runWorkflow('source')
    expect(api.runWorkflow).not.toHaveBeenCalled()
    expect(store.nodes[0]?.config?.prompt).toBe('Analyze')
    expect(store.error).toBeTruthy()
  })

  it('列表刷新失败时仍复用刚保存的定义，不重复写入或覆盖用户名称', async () => {
    const store = useCanvasStore()
    store.loadWorkflowToCanvas(definition)
    const named = { ...definition, name: 'Daily report' }
    vi.mocked(api.saveWorkflow).mockResolvedValue(named)
    vi.mocked(api.getWorkflows).mockRejectedValue(new Error('list unavailable'))
    vi.mocked(api.runWorkflow).mockResolvedValue({ ...running, status: 'completed', output: 'confirmed' })
    const saved = await store.saveWorkflow('Daily report')
    expect(saved).toBeTruthy()
    await store.runWorkflow('source', saved!)
    expect(api.saveWorkflow).toHaveBeenCalledTimes(1)
    expect(api.saveWorkflow).toHaveBeenCalledWith(expect.objectContaining({ name: 'Daily report' }))
    expect(api.runWorkflow).toHaveBeenCalledWith('wf-1', expect.objectContaining({ input: 'source' }))
    expect(store.runStatus).toBe('completed')
    expect(store.runOutput).toBe('confirmed')
  })

  it('观察经过两分钟后仍查询同一运行，取得实际终态', async () => {
    vi.useFakeTimers()
    const store = useCanvasStore()
    store.loadWorkflowToCanvas(definition)
    vi.mocked(api.runWorkflow).mockResolvedValue(running)
    vi.mocked(api.getWorkflowRun).mockResolvedValue({ ...running, status: 'completed', output: 'confirmed', node_results: [{ node_id: 'a', type: 'agent', status: 'completed', output: 'confirmed' }] })
    const task = store.runWorkflow('source')
    await vi.advanceTimersByTimeAsync(0)
    vi.setSystemTime(Date.now() + 121_000)
    await vi.advanceTimersByTimeAsync(1000)
    await task
    expect(api.getWorkflowRun).toHaveBeenCalledWith('run-1')
    expect(store.runStatus).toBe('completed')
    expect(store.runOutput).toBe('confirmed')
    expect(api.runWorkflow).toHaveBeenCalledWith('wf-1', expect.objectContaining({ input: 'source' }))
  })

  it('读取真实历史保留 skipped 状态，取消不新建执行', async () => {
    const store = useCanvasStore()
    store.loadWorkflowToCanvas(definition)
    const failed = { ...running, status: 'failed' as const, node_results: [{ node_id: 'a', type: 'agent', status: 'skipped' }] }
    vi.mocked(api.getWorkflowRuns).mockResolvedValue({ runs: [failed] })
    vi.mocked(api.getWorkflowRun).mockResolvedValue(failed)
    await store.loadRunHistory()
    await store.inspectRun('run-1')
    expect(store.nodeRunStatus.a).toBe('skipped')
    vi.mocked(api.cancelWorkflowRun).mockResolvedValue(running)
    await store.cancelRun()
    expect(api.cancelWorkflowRun).toHaveBeenCalledWith('run-1')
    expect(api.runWorkflow).not.toHaveBeenCalled()
  })
})
