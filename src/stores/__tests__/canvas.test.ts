import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useCanvasStore } from '../canvas'
import type { CanvasNode, CanvasEdge, Workflow } from '@/types'

// Mock API
vi.mock('@/api/canvas', () => ({
  listPanels: vi.fn().mockResolvedValue({ panels: [] }),
  getPanel: vi.fn().mockResolvedValue({}),
  sendCanvasEvent: vi.fn().mockResolvedValue({}),
  saveWorkflow: vi.fn().mockResolvedValue({ id: 'wf-saved' }),
  getWorkflows: vi.fn().mockResolvedValue([]),
  deleteWorkflow: vi.fn().mockResolvedValue({}),
  runWorkflow: vi.fn().mockResolvedValue({ status: 'completed', output: 'done' }),
}))

// ─── Helpers ─────────────────────────────────────────

function makeNode(id: string, type: CanvasNode['type'] = 'agent'): CanvasNode {
  return { id, type, label: `Node ${id}`, x: 0, y: 0 }
}

function makeEdge(id: string, from: string, to: string): CanvasEdge {
  return { id, from, to }
}

const sampleWorkflow: Workflow = {
  id: 'wf-1',
  name: 'Test Workflow',
  description: 'A workflow for testing',
  nodes: [makeNode('a'), makeNode('b', 'tool'), makeNode('c', 'output')],
  edges: [makeEdge('e1', 'a', 'b'), makeEdge('e2', 'b', 'c')],
  created_at: '2026-01-01',
  updated_at: '2026-01-01',
}

// ─── Tests ───────────────────────────────────────────

describe('useCanvasStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('has empty initial state', () => {
    const store = useCanvasStore()
    expect(store.nodes).toEqual([])
    expect(store.edges).toEqual([])
    expect(store.loading).toBe(false)
    expect(store.error).toBeNull()
    expect(store.currentWorkflowId).toBeNull()
    expect(store.savedWorkflows).toEqual([])
    expect(store.runStatus).toBe('idle')
  })

  // ─── addNode / updateNode / removeNode ─────────────

  describe('addNode', () => {
    it('adds a node to the canvas', () => {
      const store = useCanvasStore()
      const node = makeNode('n1')
      store.addNode(node)
      expect(store.nodes).toHaveLength(1)
      expect(store.nodes[0]!.id).toBe('n1')
    })

    it('adds multiple nodes', () => {
      const store = useCanvasStore()
      store.addNode(makeNode('n1'))
      store.addNode(makeNode('n2'))
      store.addNode(makeNode('n3'))
      expect(store.nodes).toHaveLength(3)
    })
  })

  describe('updateNode', () => {
    it('updates an existing node', () => {
      const store = useCanvasStore()
      store.addNode(makeNode('n1'))
      store.updateNode('n1', { label: 'Updated', x: 100, y: 200 })
      expect(store.nodes[0]!.label).toBe('Updated')
      expect(store.nodes[0]!.x).toBe(100)
      expect(store.nodes[0]!.y).toBe(200)
    })

    it('does nothing when node id does not exist', () => {
      const store = useCanvasStore()
      store.addNode(makeNode('n1'))
      store.updateNode('nonexistent', { label: 'Nope' })
      expect(store.nodes).toHaveLength(1)
      expect(store.nodes[0]!.label).toBe('Node n1')
    })

    it('preserves other node fields during partial update', () => {
      const store = useCanvasStore()
      store.addNode(makeNode('n1'))
      store.updateNode('n1', { x: 42 })
      expect(store.nodes[0]!.id).toBe('n1')
      expect(store.nodes[0]!.type).toBe('agent')
      expect(store.nodes[0]!.label).toBe('Node n1')
      expect(store.nodes[0]!.x).toBe(42)
      expect(store.nodes[0]!.y).toBe(0)
    })
  })

  describe('removeNode', () => {
    it('removes a node by id', () => {
      const store = useCanvasStore()
      store.addNode(makeNode('n1'))
      store.addNode(makeNode('n2'))
      store.removeNode('n1')
      expect(store.nodes).toHaveLength(1)
      expect(store.nodes[0]!.id).toBe('n2')
    })

    it('also removes edges connected to the removed node', () => {
      const store = useCanvasStore()
      store.addNode(makeNode('a'))
      store.addNode(makeNode('b'))
      store.addNode(makeNode('c'))
      store.addEdge(makeEdge('e1', 'a', 'b'))
      store.addEdge(makeEdge('e2', 'b', 'c'))
      store.removeNode('b')
      expect(store.edges).toHaveLength(0)
    })

    it('keeps edges unrelated to the removed node', () => {
      const store = useCanvasStore()
      store.addNode(makeNode('a'))
      store.addNode(makeNode('b'))
      store.addNode(makeNode('c'))
      store.addEdge(makeEdge('e1', 'a', 'b'))
      store.addEdge(makeEdge('e2', 'a', 'c'))
      store.removeNode('b')
      expect(store.edges).toHaveLength(1)
      expect(store.edges[0]!.id).toBe('e2')
    })
  })

  // ─── addEdge / removeEdge ─────────────────────────

  describe('addEdge', () => {
    it('adds an edge', () => {
      const store = useCanvasStore()
      store.addEdge(makeEdge('e1', 'a', 'b'))
      expect(store.edges).toHaveLength(1)
      expect(store.edges[0]!.from).toBe('a')
      expect(store.edges[0]!.to).toBe('b')
    })

    it('prevents duplicate edges (same from and to)', () => {
      const store = useCanvasStore()
      store.addEdge(makeEdge('e1', 'a', 'b'))
      store.addEdge(makeEdge('e2', 'a', 'b'))
      expect(store.edges).toHaveLength(1)
    })

    it('allows edges with same from but different to', () => {
      const store = useCanvasStore()
      store.addEdge(makeEdge('e1', 'a', 'b'))
      store.addEdge(makeEdge('e2', 'a', 'c'))
      expect(store.edges).toHaveLength(2)
    })

    it('allows edges with same to but different from', () => {
      const store = useCanvasStore()
      store.addEdge(makeEdge('e1', 'a', 'c'))
      store.addEdge(makeEdge('e2', 'b', 'c'))
      expect(store.edges).toHaveLength(2)
    })
  })

  describe('removeEdge', () => {
    it('removes an edge by id', () => {
      const store = useCanvasStore()
      store.addEdge(makeEdge('e1', 'a', 'b'))
      store.addEdge(makeEdge('e2', 'b', 'c'))
      store.removeEdge('e1')
      expect(store.edges).toHaveLength(1)
      expect(store.edges[0]!.id).toBe('e2')
    })

    it('does nothing when edge id does not exist', () => {
      const store = useCanvasStore()
      store.addEdge(makeEdge('e1', 'a', 'b'))
      store.removeEdge('nonexistent')
      expect(store.edges).toHaveLength(1)
    })
  })

  // ─── clearCanvas ──────────────────────────────────

  describe('clearCanvas', () => {
    it('clears all nodes, edges, currentPanel, and currentWorkflowId', () => {
      const store = useCanvasStore()
      store.addNode(makeNode('n1'))
      store.addNode(makeNode('n2'))
      store.addEdge(makeEdge('e1', 'n1', 'n2'))
      store.currentWorkflowId = 'wf-1'

      store.clearCanvas()

      expect(store.nodes).toEqual([])
      expect(store.edges).toEqual([])
      expect(store.currentPanel).toBeNull()
      expect(store.currentWorkflowId).toBeNull()
    })
  })

  // ─── validateWorkflow ─────────────────────────────

  describe('validateWorkflow', () => {
    it('returns validationNoNodes when canvas is empty', () => {
      const store = useCanvasStore()
      const errors = store.validateWorkflow()
      expect(errors).toEqual(['validationNoNodes'])
    })

    it('returns no errors for a single node with no edges', () => {
      const store = useCanvasStore()
      store.addNode(makeNode('a'))
      const errors = store.validateWorkflow()
      expect(errors).toEqual([])
    })

    it('returns validationOrphanEdges when edge references non-existent node', () => {
      const store = useCanvasStore()
      store.addNode(makeNode('a'))
      store.addNode(makeNode('b'))
      // Manually push an edge referencing a non-existent node
      store.edges.push(makeEdge('e1', 'a', 'nonexistent'))
      const errors = store.validateWorkflow()
      expect(errors).toContain('validationOrphanEdges')
    })

    it('returns validationOrphanEdges when edge from references non-existent node', () => {
      const store = useCanvasStore()
      store.addNode(makeNode('a'))
      store.addNode(makeNode('b'))
      store.edges.push(makeEdge('e1', 'nonexistent', 'b'))
      const errors = store.validateWorkflow()
      expect(errors).toContain('validationOrphanEdges')
    })

    it('returns validationDisconnected when a node has no edges in multi-node graph', () => {
      const store = useCanvasStore()
      store.addNode(makeNode('a'))
      store.addNode(makeNode('b'))
      store.addNode(makeNode('c'))
      store.addEdge(makeEdge('e1', 'a', 'b'))
      // 'c' is disconnected
      const errors = store.validateWorkflow()
      expect(errors).toContain('validationDisconnected')
    })

    it('does not report disconnected for a single node', () => {
      const store = useCanvasStore()
      store.addNode(makeNode('a'))
      const errors = store.validateWorkflow()
      expect(errors).not.toContain('validationDisconnected')
    })

    it('returns validationCycle when graph has a cycle', () => {
      const store = useCanvasStore()
      store.addNode(makeNode('a'))
      store.addNode(makeNode('b'))
      store.addNode(makeNode('c'))
      store.addEdge(makeEdge('e1', 'a', 'b'))
      store.addEdge(makeEdge('e2', 'b', 'c'))
      store.addEdge(makeEdge('e3', 'c', 'a'))
      const errors = store.validateWorkflow()
      expect(errors).toContain('validationCycle')
    })

    it('does not report cycle for a valid DAG', () => {
      const store = useCanvasStore()
      store.addNode(makeNode('a'))
      store.addNode(makeNode('b'))
      store.addNode(makeNode('c'))
      store.addEdge(makeEdge('e1', 'a', 'b'))
      store.addEdge(makeEdge('e2', 'b', 'c'))
      const errors = store.validateWorkflow()
      expect(errors).toEqual([])
    })

    it('can return multiple errors at once', () => {
      const store = useCanvasStore()
      store.addNode(makeNode('a'))
      store.addNode(makeNode('b'))
      store.addNode(makeNode('c'))
      // Orphan edge + disconnected node 'c' + cycle
      store.edges.push(makeEdge('e1', 'a', 'b'))
      store.edges.push(makeEdge('e2', 'b', 'a'))
      store.edges.push(makeEdge('e3', 'a', 'ghost'))
      const errors = store.validateWorkflow()
      expect(errors).toContain('validationOrphanEdges')
      expect(errors).toContain('validationDisconnected')
      expect(errors).toContain('validationCycle')
    })
  })

  // ─── topologicalOrder ─────────────────────────────

  describe('topologicalOrder', () => {
    it('returns empty array when no nodes', () => {
      const store = useCanvasStore()
      expect(store.topologicalOrder()).toEqual([])
    })

    it('returns single node', () => {
      const store = useCanvasStore()
      store.addNode(makeNode('a'))
      expect(store.topologicalOrder()).toEqual(['a'])
    })

    it('returns correct order for a linear chain', () => {
      const store = useCanvasStore()
      store.addNode(makeNode('a'))
      store.addNode(makeNode('b'))
      store.addNode(makeNode('c'))
      store.addEdge(makeEdge('e1', 'a', 'b'))
      store.addEdge(makeEdge('e2', 'b', 'c'))
      const order = store.topologicalOrder()
      expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'))
      expect(order.indexOf('b')).toBeLessThan(order.indexOf('c'))
    })

    it('respects dependencies in a diamond graph', () => {
      const store = useCanvasStore()
      // a -> b, a -> c, b -> d, c -> d
      store.addNode(makeNode('a'))
      store.addNode(makeNode('b'))
      store.addNode(makeNode('c'))
      store.addNode(makeNode('d'))
      store.addEdge(makeEdge('e1', 'a', 'b'))
      store.addEdge(makeEdge('e2', 'a', 'c'))
      store.addEdge(makeEdge('e3', 'b', 'd'))
      store.addEdge(makeEdge('e4', 'c', 'd'))
      const order = store.topologicalOrder()
      expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'))
      expect(order.indexOf('a')).toBeLessThan(order.indexOf('c'))
      expect(order.indexOf('b')).toBeLessThan(order.indexOf('d'))
      expect(order.indexOf('c')).toBeLessThan(order.indexOf('d'))
      expect(order).toHaveLength(4)
    })

    it('includes all nodes even with no edges', () => {
      const store = useCanvasStore()
      store.addNode(makeNode('a'))
      store.addNode(makeNode('b'))
      store.addNode(makeNode('c'))
      const order = store.topologicalOrder()
      expect(order).toHaveLength(3)
      expect(order).toContain('a')
      expect(order).toContain('b')
      expect(order).toContain('c')
    })

    it('still returns all nodes even if graph has a cycle', () => {
      const store = useCanvasStore()
      store.addNode(makeNode('a'))
      store.addNode(makeNode('b'))
      store.addEdge(makeEdge('e1', 'a', 'b'))
      store.addEdge(makeEdge('e2', 'b', 'a'))
      const order = store.topologicalOrder()
      expect(order).toHaveLength(2)
      expect(order).toContain('a')
      expect(order).toContain('b')
    })
  })

  // ─── loadWorkflowToCanvas ─────────────────────────

  describe('loadWorkflowToCanvas', () => {
    it('clears canvas and loads workflow nodes and edges', () => {
      const store = useCanvasStore()
      // Pre-fill some data
      store.addNode(makeNode('old'))
      store.addEdge(makeEdge('old-e', 'old', 'old'))

      store.loadWorkflowToCanvas(sampleWorkflow)

      expect(store.nodes).toHaveLength(3)
      expect(store.edges).toHaveLength(2)
      expect(store.currentWorkflowId).toBe('wf-1')
    })

    it('sets currentWorkflowId from the workflow', () => {
      const store = useCanvasStore()
      store.loadWorkflowToCanvas(sampleWorkflow)
      expect(store.currentWorkflowId).toBe('wf-1')
    })

    it('loads nodes with correct properties', () => {
      const store = useCanvasStore()
      store.loadWorkflowToCanvas(sampleWorkflow)
      const nodeIds = store.nodes.map((n) => n.id)
      expect(nodeIds).toEqual(['a', 'b', 'c'])
      expect(store.nodes[1]!.type).toBe('tool')
    })

    it('loads edges with correct connections', () => {
      const store = useCanvasStore()
      store.loadWorkflowToCanvas(sampleWorkflow)
      expect(store.edges[0]!.from).toBe('a')
      expect(store.edges[0]!.to).toBe('b')
      expect(store.edges[1]!.from).toBe('b')
      expect(store.edges[1]!.to).toBe('c')
    })

    it('deduplicates edges in the loaded workflow', () => {
      const store = useCanvasStore()
      const wfWithDupes: Workflow = {
        ...sampleWorkflow,
        edges: [
          makeEdge('e1', 'a', 'b'),
          makeEdge('e2', 'a', 'b'), // duplicate from/to
          makeEdge('e3', 'b', 'c'),
        ],
      }
      store.loadWorkflowToCanvas(wfWithDupes)
      // addEdge prevents duplicates by from/to
      expect(store.edges).toHaveLength(2)
    })
  })
})
