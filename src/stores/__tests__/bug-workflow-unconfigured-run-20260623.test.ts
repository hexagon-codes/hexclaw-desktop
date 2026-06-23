/**
 * BUG-20260623 — 空/未配置工作流点"试运行"仍提交后端执行并输出结果
 *
 * 复现：新建工作流默认 3 步（触发/输入 → 模型 → 输出），模型步骤 prompt 为空（UI 显示
 * "（未配置指令）"）。点击试运行，`runWorkflow` 只校验 `nodes.length===0`，未校验步骤是否配置，
 * 于是把空指令的模型步骤提交后端执行 → qwen:9b 拿到裸 {{input}} 回了段通用问候。
 *
 * 期望：未配置的步骤（模型无指令 / 工具未选）应在试运行前被拦截，不提交后端执行。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

const saveWorkflowMock = vi.fn()
const runWorkflowMock = vi.fn()
const getWorkflowRunMock = vi.fn()

vi.mock('@/api/canvas', () => ({
  listPanels: vi.fn().mockResolvedValue({ panels: [] }),
  getPanel: vi.fn().mockResolvedValue({}),
  sendCanvasEvent: vi.fn().mockResolvedValue({}),
  saveWorkflow: (...a: unknown[]) => saveWorkflowMock(...a),
  getWorkflows: vi.fn().mockResolvedValue([]),
  deleteWorkflow: vi.fn().mockResolvedValue({}),
  runWorkflow: (...a: unknown[]) => runWorkflowMock(...a),
  getWorkflowRun: (...a: unknown[]) => getWorkflowRunMock(...a),
}))
vi.mock('@/utils/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

import { useCanvasStore } from '../canvas'

describe('BUG-20260623 未配置工作流不应试运行', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    saveWorkflowMock.mockResolvedValue({ id: 'wf-bug' })
    runWorkflowMock.mockResolvedValue({ status: 'completed', output: 'x' })
  })
  afterEach(() => vi.useRealTimers())

  it('模型步骤无指令(prompt 空) → runWorkflow 不提交后端执行', async () => {
    const store = useCanvasStore()
    // 默认新工作流：触发(input) → 模型(agent, prompt 空) → 输出(output)
    store.addNode({ id: 'in', type: 'input', label: '触发', x: 0, y: 0, config: { value: '{{input}}' } })
    store.addNode({ id: 'model', type: 'agent', label: '模型', x: 0, y: 0, config: { prompt: '' } })
    store.addNode({ id: 'out', type: 'output', label: '输出', x: 0, y: 0, config: {} })

    await store.runWorkflow()

    // 当前代码会调用 apiRunWorkflow → 本断言 FAIL（这就是 bug）
    expect(runWorkflowMock).not.toHaveBeenCalled()
    expect(saveWorkflowMock).not.toHaveBeenCalled()
    expect(store.runStatus).not.toBe('running')
    expect(store.runStatus).not.toBe('completed')
  })

  it('工具步骤未选工具(tool 空) → runWorkflow 不提交后端执行', async () => {
    const store = useCanvasStore()
    store.addNode({ id: 'in', type: 'input', label: '触发', x: 0, y: 0, config: { value: '{{input}}' } })
    store.addNode({ id: 'tool', type: 'tool', label: '工具', x: 0, y: 0, config: { tool: '' } })

    await store.runWorkflow()

    expect(runWorkflowMock).not.toHaveBeenCalled()
  })

  it('模型步骤填了指令后允许试运行（正例，确保不过度拦截）', async () => {
    const store = useCanvasStore()
    store.addNode({ id: 'in', type: 'input', label: '触发', x: 0, y: 0, config: { value: '{{input}}' } })
    store.addNode({ id: 'model', type: 'agent', label: '模型', x: 0, y: 0, config: { prompt: '总结输入' } })
    store.addNode({ id: 'out', type: 'output', label: '输出', x: 0, y: 0, config: {} })

    await store.runWorkflow()

    expect(runWorkflowMock).toHaveBeenCalled()
  })
})
