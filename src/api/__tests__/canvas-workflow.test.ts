/**
 * Canvas/Workflow API — 全场景覆盖
 *
 * 覆盖 listPanels / getPanel / sendCanvasEvent
 *        saveWorkflow / getWorkflows / deleteWorkflow / runWorkflow / getWorkflowRun
 *        localStorage fallback 逻辑
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFetch = vi.hoisted(() => vi.fn())
vi.mock('ofetch', () => ({
  ofetch: {
    create: () => mockFetch,
  },
}))

import { listPanels, getPanel, sendCanvasEvent, saveWorkflow, getWorkflows, deleteWorkflow, runWorkflow, getWorkflowRun } from '../canvas'

describe('Canvas API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetch.mockReset()
    localStorage.clear()
  })

  // ─── Panel APIs ──────────────────────────────────

  describe('listPanels', () => {
    it('calls GET /api/v1/canvas/panels', async () => {
      mockFetch.mockResolvedValue({ panels: [], total: 0 })
      const result = await listPanels()
      expect(mockFetch).toHaveBeenCalledWith('/api/v1/canvas/panels', expect.objectContaining({ method: 'GET' }))
      expect(result.panels).toEqual([])
    })
  })

  describe('getPanel', () => {
    it('calls GET /api/v1/canvas/panels/:id with URL encoding', async () => {
      mockFetch.mockResolvedValue({ id: 'p1', title: 'Test' })
      await getPanel('p/1')
      expect(mockFetch).toHaveBeenCalledWith(
        `/api/v1/canvas/panels/${encodeURIComponent('p/1')}`,
        expect.objectContaining({ method: 'GET' }),
      )
    })
  })

  describe('sendCanvasEvent', () => {
    it('calls POST /api/v1/canvas/events with all params', async () => {
      mockFetch.mockResolvedValue({ status: 'ok' })
      await sendCanvasEvent('panel-1', 'btn-1', 'click', { value: 42 })
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/v1/canvas/events',
        expect.objectContaining({
          method: 'POST',
          body: { panel_id: 'panel-1', component_id: 'btn-1', action: 'click', data: { value: 42 } },
        }),
      )
    })

    it('allows undefined data', async () => {
      mockFetch.mockResolvedValue({ status: 'ok' })
      await sendCanvasEvent('p1', 'c1', 'submit')
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/v1/canvas/events',
        expect.objectContaining({
          body: { panel_id: 'p1', component_id: 'c1', action: 'submit', data: undefined },
        }),
      )
    })
  })

  // ─── Workflow CRUD with localStorage fallback ────

  describe('saveWorkflow', () => {
    it('saves via API when available', async () => {
      const wf = { id: 'wf1', name: 'Test', steps: [], created_at: '2024-01-01', updated_at: '2024-01-01' }
      mockFetch.mockResolvedValue(wf)
      const result = await saveWorkflow({ id: 'wf1', name: 'Test', steps: [] })
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/v1/canvas/workflows',
        expect.objectContaining({ method: 'POST' }),
      )
      expect(result.id).toBe('wf1')
    })

    it('falls back to localStorage when API fails', async () => {
      mockFetch.mockRejectedValue(new Error('503'))
      const result = await saveWorkflow({ id: 'wf-local', name: 'Fallback', steps: [] })
      expect(result.id).toBe('wf-local')
      expect(result.name).toBe('Fallback')
      expect(result.created_at).toBeTruthy()
      expect(result.updated_at).toBeTruthy()

      // Verify localStorage was written
      const stored = JSON.parse(localStorage.getItem('hexclaw_workflows') || '[]')
      expect(stored).toHaveLength(1)
      expect(stored[0].id).toBe('wf-local')
    })

    it('updates existing workflow in localStorage', async () => {
      // First save
      mockFetch.mockRejectedValue(new Error('offline'))
      await saveWorkflow({ id: 'wf1', name: 'V1', steps: [] })

      // Second save (update)
      const result = await saveWorkflow({ id: 'wf1', name: 'V2', steps: [{ id: 's1' }] })
      expect(result.name).toBe('V2')

      // Should still only have 1 workflow
      const stored = JSON.parse(localStorage.getItem('hexclaw_workflows') || '[]')
      expect(stored).toHaveLength(1)
      expect(stored[0].name).toBe('V2')
    })
  })

  describe('getWorkflows', () => {
    it('returns from API when available', async () => {
      mockFetch.mockResolvedValue({ workflows: [{ id: 'wf1' }] })
      const result = await getWorkflows()
      expect(result).toHaveLength(1)
    })

    it('falls back to localStorage when API fails', async () => {
      localStorage.setItem('hexclaw_workflows', JSON.stringify([{ id: 'local-wf' }]))
      mockFetch.mockRejectedValue(new Error('offline'))
      const result = await getWorkflows()
      expect(result).toHaveLength(1)
      expect(result[0]!.id).toBe('local-wf')
    })

    it('returns empty array when both fail', async () => {
      mockFetch.mockRejectedValue(new Error('offline'))
      const result = await getWorkflows()
      expect(result).toEqual([])
    })

    it('handles null workflows from API', async () => {
      mockFetch.mockResolvedValue({ workflows: null })
      const result = await getWorkflows()
      expect(result).toEqual([])
    })
  })

  describe('deleteWorkflow', () => {
    it('deletes via API when available', async () => {
      mockFetch.mockResolvedValue({ message: 'deleted' })
      await deleteWorkflow('wf1')
      expect(mockFetch).toHaveBeenCalledWith(
        `/api/v1/canvas/workflows/${encodeURIComponent('wf1')}`,
        expect.objectContaining({ method: 'DELETE' }),
      )
    })

    it('deletes from localStorage when API fails', async () => {
      localStorage.setItem('hexclaw_workflows', JSON.stringify([{ id: 'wf1' }, { id: 'wf2' }]))
      mockFetch.mockRejectedValue(new Error('offline'))
      await deleteWorkflow('wf1')

      const stored = JSON.parse(localStorage.getItem('hexclaw_workflows') || '[]')
      expect(stored).toHaveLength(1)
      expect(stored[0].id).toBe('wf2')
    })
  })

  describe('runWorkflow', () => {
    it('runs via API when available', async () => {
      const run = { id: 'run-1', workflow_id: 'wf1', status: 'completed', output: 'done', started_at: '2024-01-01', finished_at: '2024-01-01' }
      mockFetch.mockResolvedValue(run)
      const result = await runWorkflow('wf1')
      expect(result.status).toBe('completed')
    })

    it('throws when API fails (store handles fallback)', async () => {
      mockFetch.mockRejectedValue(new Error('offline'))
      await expect(runWorkflow('wf1')).rejects.toThrow('offline')
    })
  })

  describe('getWorkflowRun', () => {
    it('calls GET /api/v1/canvas/runs/:id', async () => {
      mockFetch.mockResolvedValue({ id: 'run-1', status: 'running' })
      const result = await getWorkflowRun('run-1')
      expect(result.status).toBe('running')
    })

    it('propagates error (no fallback)', async () => {
      mockFetch.mockRejectedValue(new Error('Not found'))
      await expect(getWorkflowRun('nonexistent')).rejects.toThrow()
    })
  })
})
