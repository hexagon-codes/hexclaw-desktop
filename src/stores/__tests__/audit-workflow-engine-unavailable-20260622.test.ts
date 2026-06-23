/**
 * 审计修复 — 工作流引擎「功能未启用」vs「执行失败」语义区分
 *
 * Bug（交接清单 P1）：stores/canvas.ts runWorkflow 的 else 分支把后端 404
 * （工作流引擎未提供/未启用）误标为「所有节点 failed + 引擎不可用」，
 * 与真正的执行失败/后端宕机无法区分，误导用户以为是自己的工作流挂了。
 *
 * 期望：
 *  - 404 / NOT_FOUND → runStatus = 'unavailable'，节点保持 idle（从未执行，
 *    不能标 failed），输出文案为「未启用」而非「失败 / 引擎不可用」。
 *  - 其它错误（500 / 网络）→ 仍为 failed + 引擎不可用（保持原行为）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useCanvasStore } from '@/stores/canvas'
import { runWorkflow as apiRunWorkflow } from '@/api/canvas'

vi.mock('@/api/canvas', () => ({
  listPanels: vi.fn().mockResolvedValue({ panels: [], total: 0 }),
  getPanel: vi.fn().mockResolvedValue({}),
  sendCanvasEvent: vi.fn().mockResolvedValue({}),
  saveWorkflow: vi.fn().mockImplementation((wf) =>
    Promise.resolve({ ...wf, created_at: '2026-01-01', updated_at: '2026-01-01' }),
  ),
  getWorkflows: vi.fn().mockResolvedValue({ workflows: [] }),
  deleteWorkflow: vi.fn().mockResolvedValue({ message: 'ok' }),
  getWorkflowRun: vi.fn(),
  runWorkflow: vi.fn(),
}))

describe('工作流引擎未启用语义（404 ≠ 执行失败）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('后端 404 → runStatus=unavailable，节点保持 idle（不可标 failed）', async () => {
    vi.mocked(apiRunWorkflow).mockRejectedValueOnce({
      code: 'NOT_FOUND',
      message: '请求的资源不存在',
      status: 404,
    })
    const store = useCanvasStore()
    store.addNode({ id: 'a', type: 'agent', label: 'A', x: 0, y: 0, config: { prompt: 'x' } })

    await store.runWorkflow()

    expect(store.runStatus).toBe('unavailable')
    expect(store.nodeRunStatus.a).toBe('idle') // 从未执行 → 不能是 failed
    expect(store.nodeRunStatus.a).not.toBe('failed')
    expect(store.runOutput).toContain('未启用')
    expect(store.runOutput).not.toContain('引擎不可用')
  })

  it('后端 500 → 仍为 failed + 引擎不可用（保持原行为）', async () => {
    vi.mocked(apiRunWorkflow).mockRejectedValueOnce({
      code: 'SERVER_ERROR',
      message: '服务器内部错误',
      status: 500,
    })
    const store = useCanvasStore()
    store.addNode({ id: 'a', type: 'agent', label: 'A', x: 0, y: 0, config: { prompt: 'x' } })

    await store.runWorkflow()

    expect(store.runStatus).toBe('failed')
    expect(store.nodeRunStatus.a).toBe('failed')
    expect(store.runOutput).toContain('引擎不可用')
  })

  it('网络错误（无 status）→ 仍为 failed（不误判为未启用）', async () => {
    vi.mocked(apiRunWorkflow).mockRejectedValueOnce({
      code: 'NETWORK_ERROR',
      message: 'HexClaw 服务未启动或网络不可达',
    })
    const store = useCanvasStore()
    store.addNode({ id: 'a', type: 'agent', label: 'A', x: 0, y: 0, config: { prompt: 'x' } })

    await store.runWorkflow()

    expect(store.runStatus).toBe('failed')
    expect(store.nodeRunStatus.a).toBe('failed')
  })
})
