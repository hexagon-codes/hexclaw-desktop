/**
 * canvas store 工作流测试 — 补充 API 交互和运行逻辑
 *
 * 暴露 canvas.ts 中的性能问题和逻辑边界
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useCanvasStore } from '../canvas'

// Mock API
vi.mock('@/api/canvas', () => ({
  listPanels: vi.fn().mockResolvedValue({ panels: [], total: 0 }),
  getPanel: vi.fn().mockResolvedValue({}),
  sendCanvasEvent: vi.fn().mockResolvedValue({}),
  saveWorkflow: vi.fn().mockImplementation((wf) =>
    Promise.resolve({ ...wf, created_at: '2026-01-01', updated_at: '2026-01-01' }),
  ),
  getWorkflows: vi.fn().mockResolvedValue({ workflows: [] }),
  deleteWorkflow: vi.fn().mockResolvedValue({ message: 'ok' }),
  runWorkflow: vi.fn().mockResolvedValue({
    id: 'run-1',
    workflow_id: 'wf-1',
    status: 'completed',
    output: 'done',
    started_at: '2026-01-01',
    finished_at: '2026-01-01',
  }),
}))

describe('Canvas Store — 工作流性能和边界', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('topologicalOrder 使用 Set 替代 includes，性能应合理', () => {
    const store = useCanvasStore()

    // 构造大量节点
    const nodeCount = 500
    for (let i = 0; i < nodeCount; i++) {
      store.addNode({
        id: `n${i}`,
        type: 'agent',
        label: `Node ${i}`,
        x: 0,
        y: 0,
        config: {},
      })
    }
    // 线性连接
    for (let i = 0; i < nodeCount - 1; i++) {
      store.addEdge({ id: `e${i}`, from: `n${i}`, to: `n${i + 1}` })
    }

    const start = performance.now()
    const order = store.topologicalOrder()
    const elapsed = performance.now() - start

    expect(order).toHaveLength(nodeCount)

    // 对于正常的拓扑排序 O(V+E)，500 节点应该在 1ms 内完成
    // 但由于末尾的 order.includes() 是 O(n)，总复杂度变成 O(n²)
    // 虽然 500 节点可能还不明显，但问题存在
    // 正确做法是用 Set 替代 includes
    // 修复后: 用 Set 替代 Array.includes，O(V+E) 复杂度
    expect(elapsed).toBeLessThan(100)
  })

  it('validateWorkflow 空画布应只返回一个错误', () => {
    const store = useCanvasStore()
    const errors = store.validateWorkflow()
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBe('validationNoNodes')
  })

  it('validateWorkflow 有环应检测到', () => {
    const store = useCanvasStore()
    store.addNode({ id: 'a', type: 'agent', label: 'A', x: 0, y: 0, config: {} })
    store.addNode({ id: 'b', type: 'agent', label: 'B', x: 0, y: 0, config: {} })
    store.addEdge({ id: 'e1', from: 'a', to: 'b' })
    store.addEdge({ id: 'e2', from: 'b', to: 'a' })

    const errors = store.validateWorkflow()
    expect(errors).toContain('validationCycle')
  })

  it('removeNode 应同时移除关联的边', () => {
    const store = useCanvasStore()
    store.addNode({ id: 'a', type: 'agent', label: 'A', x: 0, y: 0, config: {} })
    store.addNode({ id: 'b', type: 'agent', label: 'B', x: 0, y: 0, config: {} })
    store.addNode({ id: 'c', type: 'agent', label: 'C', x: 0, y: 0, config: {} })
    store.addEdge({ id: 'e1', from: 'a', to: 'b' })
    store.addEdge({ id: 'e2', from: 'b', to: 'c' })

    store.removeNode('b')

    expect(store.nodes).toHaveLength(2)
    expect(store.edges).toHaveLength(0) // 两条边都应该被移除
  })

  it('addEdge 不应添加重复的边', () => {
    const store = useCanvasStore()
    store.addNode({ id: 'a', type: 'agent', label: 'A', x: 0, y: 0, config: {} })
    store.addNode({ id: 'b', type: 'agent', label: 'B', x: 0, y: 0, config: {} })

    store.addEdge({ id: 'e1', from: 'a', to: 'b' })
    store.addEdge({ id: 'e2', from: 'a', to: 'b' }) // 重复

    expect(store.edges).toHaveLength(1)
  })

  it('clearCanvas 应重置所有状态', () => {
    const store = useCanvasStore()
    store.addNode({ id: 'a', type: 'agent', label: 'A', x: 0, y: 0, config: {} })
    store.addEdge({ id: 'e1', from: 'a', to: 'a' })

    store.clearCanvas()

    expect(store.nodes).toHaveLength(0)
    expect(store.edges).toHaveLength(0)
    expect(store.currentPanel).toBeNull()
    expect(store.currentWorkflowId).toBeNull()
  })
})
