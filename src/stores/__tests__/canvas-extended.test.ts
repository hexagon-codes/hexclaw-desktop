/**
 * Canvas Store — Extended Tests
 *
 * Covers async actions and edge cases NOT tested in canvas.test.ts:
 * self-loop prevention, loadPanels, loadPanel, dispatchEvent,
 * saveWorkflow, loadWorkflows, deleteWorkflow, runWorkflow.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import type { CanvasNode, CanvasEdge } from '@/types'

// ─── Mocks ──────────────────────────────────────────────

const listPanelsMock = vi.fn()
const getPanelMock = vi.fn()
const sendCanvasEventMock = vi.fn()
const saveWorkflowMock = vi.fn()
const getWorkflowsMock = vi.fn()
const deleteWorkflowMock = vi.fn()
const runWorkflowMock = vi.fn()

vi.mock('@/api/canvas', () => ({
  listPanels: (...args: unknown[]) => listPanelsMock(...args),
  getPanel: (...args: unknown[]) => getPanelMock(...args),
  sendCanvasEvent: (...args: unknown[]) => sendCanvasEventMock(...args),
  saveWorkflow: (...args: unknown[]) => saveWorkflowMock(...args),
  getWorkflows: (...args: unknown[]) => getWorkflowsMock(...args),
  deleteWorkflow: (...args: unknown[]) => deleteWorkflowMock(...args),
  runWorkflow: (...args: unknown[]) => runWorkflowMock(...args),
}))

vi.mock('@/utils/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

import { useCanvasStore } from '../canvas'

// ─── Helpers ─────────────────────────────────────────────

function makeNode(id: string, type: CanvasNode['type'] = 'agent'): CanvasNode {
  return { id, type, label: `Node ${id}`, x: 0, y: 0 }
}

function makeEdge(id: string, from: string, to: string): CanvasEdge {
  return { id, from, to }
}

// ─── Tests ───────────────────────────────────────────────

describe('useCanvasStore — extended', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    // Sensible defaults — override per-test as needed
    listPanelsMock.mockResolvedValue({ panels: [] })
    getPanelMock.mockResolvedValue({})
    sendCanvasEventMock.mockResolvedValue({})
    saveWorkflowMock.mockResolvedValue({ id: 'wf-saved' })
    getWorkflowsMock.mockResolvedValue([])
    deleteWorkflowMock.mockResolvedValue({})
    runWorkflowMock.mockResolvedValue({ status: 'completed', output: 'done' })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // ─── addEdge self-loop ──────────────────────────────────

  describe('addEdge — self-loop prevention', () => {
    it('rejects edge where from === to', () => {
      const store = useCanvasStore()
      store.addEdge(makeEdge('e-self', 'a', 'a'))
      expect(store.edges).toHaveLength(0)
    })
  })

  // ─── loadPanels ─────────────────────────────────────────

  describe('loadPanels', () => {
    it('populates panels on success', async () => {
      const panelData = [
        { id: 'p1', title: 'Panel 1', component_count: 3, version: 1 },
        { id: 'p2', title: 'Panel 2', component_count: 1, version: 2 },
      ]
      listPanelsMock.mockResolvedValue({ panels: panelData })

      const store = useCanvasStore()
      await store.loadPanels()

      expect(store.panels).toEqual(panelData)
      expect(store.error).toBeNull()
      expect(store.loading).toBe(false)
    })

    it('sets error and keeps panels empty on failure', async () => {
      listPanelsMock.mockRejectedValue(new Error('network down'))

      const store = useCanvasStore()
      await store.loadPanels()

      expect(store.panels).toEqual([])
      expect(store.error).not.toBeNull()
      expect(store.loading).toBe(false)
    })
  })

  // ─── loadPanel ──────────────────────────────────────────

  describe('loadPanel', () => {
    it('sets currentPanel on success', async () => {
      const panelDetail = { id: 'p1', title: 'Detail', components: [] }
      getPanelMock.mockResolvedValue(panelDetail)

      const store = useCanvasStore()
      await store.loadPanel('p1')

      expect(store.currentPanel).toEqual(panelDetail)
      expect(store.error).toBeNull()
      expect(store.loading).toBe(false)
    })

    it('sets error on failure', async () => {
      getPanelMock.mockRejectedValue(new Error('not found'))

      const store = useCanvasStore()
      await store.loadPanel('missing')

      expect(store.error).not.toBeNull()
      expect(store.loading).toBe(false)
    })
  })

  // ─── dispatchEvent ──────────────────────────────────────

  describe('dispatchEvent', () => {
    it('calls API and clears error on success', async () => {
      sendCanvasEventMock.mockResolvedValue({ ok: true })

      const store = useCanvasStore()
      await store.dispatchEvent('panel1', 'btn1', 'click', { value: 42 })

      expect(sendCanvasEventMock).toHaveBeenCalledWith('panel1', 'btn1', 'click', { value: 42 })
      expect(store.error).toBeNull()
    })

    it('sets error on failure', async () => {
      sendCanvasEventMock.mockRejectedValue(new Error('event failed'))

      const store = useCanvasStore()
      await store.dispatchEvent('panel1', 'btn1', 'click')

      expect(store.error).not.toBeNull()
    })
  })

  // ─── saveWorkflow ───────────────────────────────────────

  describe('saveWorkflow', () => {
    it('auto-generates ID when currentWorkflowId is null', async () => {
      saveWorkflowMock.mockResolvedValue({ id: 'wf-new-123' })
      getWorkflowsMock.mockResolvedValue([])

      const store = useCanvasStore()
      expect(store.currentWorkflowId).toBeNull()

      await store.saveWorkflow('My Flow')

      // The mock was called with an auto-generated id (wf-...)
      expect(saveWorkflowMock).toHaveBeenCalledTimes(1)
      const callArg = saveWorkflowMock.mock.calls[0]![0]
      expect(callArg.id).toMatch(/^wf-/)
      expect(callArg.name).toBe('My Flow')
    })

    it('sets currentWorkflowId from response', async () => {
      saveWorkflowMock.mockResolvedValue({ id: 'wf-resp-42' })
      getWorkflowsMock.mockResolvedValue([])

      const store = useCanvasStore()
      await store.saveWorkflow('Flow')

      expect(store.currentWorkflowId).toBe('wf-resp-42')
    })

    it('calls loadWorkflows after successful save', async () => {
      saveWorkflowMock.mockResolvedValue({ id: 'wf-1' })
      getWorkflowsMock.mockResolvedValue([{ id: 'wf-1', name: 'Flow' }])

      const store = useCanvasStore()
      await store.saveWorkflow('Flow')

      expect(getWorkflowsMock).toHaveBeenCalledTimes(1)
    })

    it('sets error on failure', async () => {
      saveWorkflowMock.mockRejectedValue(new Error('save failed'))

      const store = useCanvasStore()
      await store.saveWorkflow('Broken')

      expect(store.error).not.toBeNull()
      expect(store.loading).toBe(false)
    })
  })

  // ─── loadWorkflows ──────────────────────────────────────

  describe('loadWorkflows', () => {
    it('populates savedWorkflows on success', async () => {
      const workflows = [
        { id: 'wf-1', name: 'A', nodes: [], edges: [], created_at: '', updated_at: '' },
        { id: 'wf-2', name: 'B', nodes: [], edges: [], created_at: '', updated_at: '' },
      ]
      getWorkflowsMock.mockResolvedValue(workflows)

      const store = useCanvasStore()
      await store.loadWorkflows()

      expect(store.savedWorkflows).toEqual(workflows)
      expect(store.error).toBeNull()
    })

    it('sets error on failure', async () => {
      getWorkflowsMock.mockRejectedValue(new Error('load failed'))

      const store = useCanvasStore()
      await store.loadWorkflows()

      expect(store.error).not.toBeNull()
    })
  })

  // ─── deleteWorkflow ─────────────────────────────────────

  describe('deleteWorkflow', () => {
    it('removes workflow from savedWorkflows', async () => {
      deleteWorkflowMock.mockResolvedValue({})

      const store = useCanvasStore()
      store.savedWorkflows = [
        { id: 'wf-1', name: 'A', nodes: [], edges: [], created_at: '', updated_at: '' },
        { id: 'wf-2', name: 'B', nodes: [], edges: [], created_at: '', updated_at: '' },
      ]

      await store.deleteWorkflow('wf-1')

      expect(store.savedWorkflows).toHaveLength(1)
      expect(store.savedWorkflows[0]!.id).toBe('wf-2')
    })

    it('clears currentWorkflowId when deleting the current workflow', async () => {
      deleteWorkflowMock.mockResolvedValue({})

      const store = useCanvasStore()
      store.savedWorkflows = [
        { id: 'wf-1', name: 'A', nodes: [], edges: [], created_at: '', updated_at: '' },
      ]
      store.currentWorkflowId = 'wf-1'

      await store.deleteWorkflow('wf-1')

      expect(store.currentWorkflowId).toBeNull()
    })

    it('keeps currentWorkflowId when deleting a different workflow', async () => {
      deleteWorkflowMock.mockResolvedValue({})

      const store = useCanvasStore()
      store.savedWorkflows = [
        { id: 'wf-1', name: 'A', nodes: [], edges: [], created_at: '', updated_at: '' },
        { id: 'wf-2', name: 'B', nodes: [], edges: [], created_at: '', updated_at: '' },
      ]
      store.currentWorkflowId = 'wf-1'

      await store.deleteWorkflow('wf-2')

      expect(store.currentWorkflowId).toBe('wf-1')
    })

    it('sets error and keeps list unchanged on failure', async () => {
      deleteWorkflowMock.mockRejectedValue(new Error('delete failed'))

      const store = useCanvasStore()
      store.savedWorkflows = [
        { id: 'wf-1', name: 'A', nodes: [], edges: [], created_at: '', updated_at: '' },
      ]

      await store.deleteWorkflow('wf-1')

      // On error, savedWorkflows is NOT filtered
      expect(store.savedWorkflows).toHaveLength(1)
      expect(store.error).not.toBeNull()
    })
  })

  // ─── runWorkflow ────────────────────────────────────────

  describe('runWorkflow', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    it('blocks when already running', async () => {
      const store = useCanvasStore()
      store.addNode(makeNode('a'))
      store.runStatus = 'running'

      await store.runWorkflow()

      // Should not have called the API
      expect(saveWorkflowMock).not.toHaveBeenCalled()
      expect(runWorkflowMock).not.toHaveBeenCalled()
    })

    it('blocks when no nodes exist', async () => {
      const store = useCanvasStore()
      // nodes is empty by default

      await store.runWorkflow()

      expect(saveWorkflowMock).not.toHaveBeenCalled()
      expect(runWorkflowMock).not.toHaveBeenCalled()
    })

    it('marks nodes completed in sequence on success', async () => {
      saveWorkflowMock.mockResolvedValue({ id: 'wf-run-1' })
      runWorkflowMock.mockResolvedValue({ status: 'completed', output: 'all done' })

      const store = useCanvasStore()
      store.addNode(makeNode('a'))
      store.addNode(makeNode('b'))
      store.addEdge(makeEdge('e1', 'a', 'b'))

      const runPromise = store.runWorkflow()

      // Advance through all the 250ms setTimeout delays
      // Two nodes => two 250ms delays
      await vi.advanceTimersByTimeAsync(250)
      await vi.advanceTimersByTimeAsync(250)
      await runPromise

      expect(store.nodeRunStatus['a']).toBe('completed')
      expect(store.nodeRunStatus['b']).toBe('completed')
      expect(store.runStatus).toBe('completed')
      expect(store.runOutput).toBe('all done')
      expect(store.runResult).not.toBeNull()
      expect(store.runResult!.output).toBe('all done')
    })

    it('marks nodes failed when backend call fails', async () => {
      saveWorkflowMock.mockResolvedValue({ id: 'wf-run-2' })
      runWorkflowMock.mockRejectedValue(new Error('backend unreachable'))

      const store = useCanvasStore()
      store.addNode(makeNode('a'))
      store.addNode(makeNode('b'))
      store.addEdge(makeEdge('e1', 'a', 'b'))

      await store.runWorkflow()

      // All nodes should be marked 'failed', not 'completed'
      expect(store.nodeRunStatus['a']).toBe('failed')
      expect(store.nodeRunStatus['b']).toBe('failed')
      expect(store.runStatus).toBe('failed')
      expect(store.runResult).not.toBeNull()
      expect(store.runResult!.error).toBeDefined()
    })

    it('populates runResult with timing info on success', async () => {
      saveWorkflowMock.mockResolvedValue({ id: 'wf-run-3' })
      runWorkflowMock.mockResolvedValue({
        status: 'completed',
        output: 'result text',
        started_at: '2026-01-01T00:00:00Z',
        finished_at: '2026-01-01T00:01:00Z',
      })

      const store = useCanvasStore()
      store.addNode(makeNode('a'))

      const runPromise = store.runWorkflow()
      await vi.advanceTimersByTimeAsync(250)
      await runPromise

      expect(store.runResult!.startedAt).toBe('2026-01-01T00:00:00Z')
      expect(store.runResult!.finishedAt).toBe('2026-01-01T00:01:00Z')
    })

    it('resets state before execution', async () => {
      saveWorkflowMock.mockResolvedValue({ id: 'wf-run-4' })
      runWorkflowMock.mockResolvedValue({ status: 'completed', output: 'ok' })

      const store = useCanvasStore()
      // Pre-fill some stale state
      store.runOutput = 'old output'
      store.runResult = { output: 'stale' }
      store.error = { code: 'UNKNOWN', message: 'old error' }

      store.addNode(makeNode('a'))
      const runPromise = store.runWorkflow()
      await vi.advanceTimersByTimeAsync(250)
      await runPromise

      // runOutput should be from the new run, not old
      expect(store.runOutput).toBe('ok')
    })

    it('auto-saves workflow before running if no currentWorkflowId', async () => {
      saveWorkflowMock.mockResolvedValue({ id: 'wf-autosave' })
      runWorkflowMock.mockResolvedValue({ status: 'completed', output: 'done' })

      const store = useCanvasStore()
      store.addNode(makeNode('a'))
      expect(store.currentWorkflowId).toBeNull()

      const runPromise = store.runWorkflow()
      await vi.advanceTimersByTimeAsync(250)
      await runPromise

      expect(saveWorkflowMock).toHaveBeenCalledTimes(1)
      expect(store.currentWorkflowId).toBe('wf-autosave')
    })
  })
})
