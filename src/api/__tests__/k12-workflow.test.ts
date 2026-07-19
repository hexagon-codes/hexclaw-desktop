import { beforeEach, describe, expect, it, vi } from 'vitest'

const client = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiDelete: vi.fn(),
}))

vi.mock('../client', () => client)

import {
  deleteWorkflow,
  getPanel,
  getWorkflowRun,
  getWorkflows,
  listPanels,
  resumeWorkflowRun,
  runWorkflow,
  saveWorkflow,
  sendCanvasEvent,
} from '../canvas'
import * as canvasApi from '../canvas'
import type { Workflow } from '@/types/canvas'

const owner = { agentId: 'tutor-a', learnerId: 'learner-a' }
const scope = { ...owner, version: 'v2' }
const k12Workflow = {
  id: 'wf-k12',
  name: '周复习',
  nodes: [],
  edges: [],
  data: {
    scenario: 'k12',
    agent_id: 'payload-attacker',
    learner_id: 'payload-attacker',
    version: 'stale',
  },
} as Omit<Workflow, 'created_at' | 'updated_at'>

describe('K12 Canvas/Workflow API contract', () => {
  beforeEach(() => {
    Object.values(client).forEach((mock) => mock.mockReset())
    localStorage.clear()
  })

  it('keeps the nine route clients as the exact runtime surface', () => {
    expect(Object.keys(canvasApi).filter((name) => typeof canvasApi[name as keyof typeof canvasApi] === 'function').sort()).toEqual([
      'deleteWorkflow',
      'getPanel',
      'getWorkflowRun',
      'getWorkflows',
      'listPanels',
      'resumeWorkflowRun',
      'runWorkflow',
      'saveWorkflow',
      'sendCanvasEvent',
    ])
  })

  it('binds panels and component events to the selected K12 owner', async () => {
    client.apiGet.mockResolvedValueOnce({ panels: [], total: 0 }).mockResolvedValueOnce({ id: 'panel / 1' })
    client.apiPost.mockResolvedValueOnce({ status: 'ok' })

    await listPanels(owner)
    await getPanel('panel / 1', owner)
    await sendCanvasEvent('panel / 1', 'button / run', 'submit', { value: 42 }, owner)

    const query = {
      user_id: 'desktop-user',
      scenario: 'k12',
      agent_id: 'tutor-a',
      learner_id: 'learner-a',
    }
    expect(client.apiGet).toHaveBeenNthCalledWith(1, '/api/v1/canvas/panels', query)
    expect(client.apiGet).toHaveBeenNthCalledWith(2, '/api/v1/canvas/panels/panel%20%2F%201', query)
    expect(client.apiPost).toHaveBeenCalledWith('/api/v1/canvas/events', {
      panel_id: 'panel / 1',
      component_id: 'button / run',
      action: 'submit',
      data: { value: 42 },
      ...query,
    })
  })

  it('freezes K12 owner/version in the definition and never falls back to global localStorage', async () => {
    client.apiPost.mockResolvedValueOnce({
      ...k12Workflow,
      data: { scenario: 'k12', agent_id: 'tutor-a', learner_id: 'learner-a', version: 'v2' },
      created_at: '2026-07-20T00:00:00Z',
      updated_at: '2026-07-20T00:00:00Z',
    })

    await saveWorkflow(k12Workflow, scope)
    expect(client.apiPost).toHaveBeenLastCalledWith('/api/v1/canvas/workflows', {
      ...k12Workflow,
      data: {
        scenario: 'k12',
        agent_id: 'tutor-a',
        learner_id: 'learner-a',
        version: 'v2',
      },
    })

    client.apiPost.mockRejectedValueOnce(new Error('503 workflow store unavailable'))
    await expect(saveWorkflow(k12Workflow, scope)).rejects.toThrow('503')
    expect(localStorage.getItem('hexclaw_workflows')).toBeNull()
  })

  it('lists only the requested K12 owner and fails closed instead of reading global fallback state', async () => {
    const own = {
      ...k12Workflow,
      created_at: '2026-07-20T00:00:00Z',
      updated_at: '2026-07-20T00:00:00Z',
      data: { scenario: 'k12', agent_id: 'tutor-a', learner_id: 'learner-a', version: 'v2' },
    }
    const other = {
      ...own,
      id: 'wf-other',
      data: { scenario: 'k12', agent_id: 'tutor-b', learner_id: 'learner-b', version: 'v2' },
    }
    const generic = { ...own, id: 'wf-generic', data: undefined }
    client.apiGet.mockResolvedValueOnce({ workflows: [own, other, generic] })

    const result = await getWorkflows(owner)
    expect(result.map((workflow) => workflow.id)).toEqual(['wf-k12'])
    expect(client.apiGet).toHaveBeenLastCalledWith('/api/v1/canvas/workflows', {
      user_id: 'desktop-user',
      scenario: 'k12',
      agent_id: 'tutor-a',
      learner_id: 'learner-a',
    })

    localStorage.setItem('hexclaw_workflows', JSON.stringify([other]))
    client.apiGet.mockRejectedValueOnce(new Error('offline'))
    await expect(getWorkflows(owner)).rejects.toThrow('offline')
  })

  it('does not report a K12 delete as successful when the backend rejects it', async () => {
    localStorage.setItem('hexclaw_workflows', JSON.stringify([{ id: 'wf-k12' }]))
    client.apiDelete.mockRejectedValueOnce(new Error('403 owner mismatch'))

    await expect(deleteWorkflow('wf / k12', owner)).rejects.toThrow('403')
    expect(client.apiDelete).toHaveBeenCalledWith(
      '/api/v1/canvas/workflows/wf%20%2F%20k12?user_id=desktop-user&scenario=k12&agent_id=tutor-a&learner_id=learner-a',
    )
    expect(JSON.parse(localStorage.getItem('hexclaw_workflows') ?? '[]')).toEqual([{ id: 'wf-k12' }])
  })

  it('runs K12 only with a complete immutable owner/object/version envelope', async () => {
    client.apiPost.mockResolvedValueOnce({
      id: 'run-1',
      workflow_id: 'wf / k12',
      status: 'running',
      started_at: '2026-07-20T00:00:00Z',
    })

    await runWorkflow('wf / k12', {
      ...scope,
      objectId: 'practice-set-1',
      input: '生成本周复习卷',
      platform: 'desktop',
      instanceId: 'desktop-main',
      chatId: 'session-1',
      metadata: { agent_id: 'payload-attacker', source: 'manual' },
    })

    expect(client.apiPost).toHaveBeenLastCalledWith('/api/v1/canvas/workflows/wf%20%2F%20k12/run', {
      input: '生成本周复习卷',
      user_id: 'desktop-user',
      platform: 'desktop',
      instance_id: 'desktop-main',
      chat_id: 'session-1',
      metadata: {
        source: 'manual',
        scenario: 'k12',
        agent_id: 'tutor-a',
        learner_id: 'learner-a',
        workflow_version: 'v2',
        object_id: 'practice-set-1',
      },
    })

    client.apiPost.mockClear()
    await expect(runWorkflow('wf-k12', {
      ...scope,
      version: '',
      objectId: 'practice-set-1',
      input: 'x',
      platform: 'desktop',
      instanceId: 'desktop-main',
      chatId: 'session-1',
    })).rejects.toThrow(/version|版本/)
    expect(client.apiPost).not.toHaveBeenCalled()
  })

  it('owner-scopes run reads and sends the same owner/version on checkpoint resume', async () => {
    client.apiGet.mockResolvedValueOnce({ id: 'run / 1', status: 'failed' })
    client.apiPost.mockResolvedValueOnce({ id: 'run-2', status: 'running' })

    await getWorkflowRun('run / 1', owner)
    await resumeWorkflowRun('run / 1', scope)

    expect(client.apiGet).toHaveBeenCalledWith('/api/v1/canvas/runs/run%20%2F%201', {
      user_id: 'desktop-user',
      scenario: 'k12',
      agent_id: 'tutor-a',
      learner_id: 'learner-a',
    })
    expect(client.apiPost).toHaveBeenCalledWith('/api/v1/canvas/runs/run%20%2F%201/resume', {
      user_id: 'desktop-user',
      scenario: 'k12',
      agent_id: 'tutor-a',
      learner_id: 'learner-a',
      workflow_version: 'v2',
    })
  })
})
