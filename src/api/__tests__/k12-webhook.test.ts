import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockFetch = vi.hoisted(() => vi.fn())
vi.mock('ofetch', () => ({ ofetch: { create: () => mockFetch } }))

import {
  createK12Webhook,
  deleteK12Webhook,
  getK12WebhookReceipt,
  getK12WebhookReceipts,
  getK12Webhooks,
  retryK12WebhookReceipt,
  rotateK12WebhookSecret,
  updateK12Webhook,
} from '../webhook'

describe('K12 Webhook management API', () => {
  beforeEach(() => mockFetch.mockReset())

  it('scopes list and receipt queries to the selected TutorAgent', async () => {
    mockFetch.mockResolvedValueOnce({ k12_bindings: [], total: 0 })
    await getK12Webhooks('k12-tutor-a')
    expect(mockFetch).toHaveBeenLastCalledWith(
      '/api/v1/webhooks',
      expect.objectContaining({
        method: 'GET',
        query: { user_id: 'desktop-user', agent_id: 'k12-tutor-a' },
      }),
    )

    mockFetch.mockResolvedValueOnce({ receipts: [], total: 0 })
    await getK12WebhookReceipts('homework-hook', 'k12-tutor-a')
    expect(mockFetch).toHaveBeenLastCalledWith(
      '/api/v1/webhooks',
      expect.objectContaining({
        method: 'GET',
        query: { user_id: 'desktop-user', agent_id: 'k12-tutor-a', binding_name: 'homework-hook' },
      }),
    )

    mockFetch.mockResolvedValueOnce({ receipt: { receipt_id: 'rcpt-1' } })
    await getK12WebhookReceipt('rcpt-1', 'k12-tutor-a')
    expect(mockFetch).toHaveBeenLastCalledWith(
      '/api/v1/webhooks',
      expect.objectContaining({
        method: 'GET',
        query: { user_id: 'desktop-user', agent_id: 'k12-tutor-a', receipt_id: 'rcpt-1' },
      }),
    )
  })

  it('creates default-disabled owner-bound K12 binding and never accepts a client secret', async () => {
    mockFetch.mockResolvedValue({ binding: {}, secret: 'one-time', enabled: false })
    await createK12Webhook({
      name: 'homework-hook',
      agentId: 'k12-tutor-a',
      learnerId: 'learner-a',
      allowedEvents: ['k12.submission.requested.v1'],
      allowedWorkflows: [],
    })
    expect(mockFetch).toHaveBeenLastCalledWith(
      '/api/v1/webhooks',
      expect.objectContaining({
        method: 'POST',
        body: {
          name: 'homework-hook',
          type: 'k12',
          agent_id: 'k12-tutor-a',
          learner_id: 'learner-a',
          allowed_events: ['k12.submission.requested.v1'],
          allowed_workflows: [],
          user_id: 'desktop-user',
          enabled: false,
        },
      }),
    )
  })

  it('owner-scopes edit, enable, rotate and delete mutations in the URL', async () => {
    mockFetch.mockResolvedValue({})
    const scoped = '?user_id=desktop-user&agent_id=k12-tutor-a'
    await updateK12Webhook('a b/c', 'k12-tutor-a', {
      enabled: true,
      allowed_events: ['k12.practice_return.requested.v1'],
      allowed_workflows: [],
    })
    expect(mockFetch).toHaveBeenLastCalledWith(
      `/api/v1/webhooks/a%20b%2Fc${scoped}`,
      expect.objectContaining({
        method: 'PATCH',
        body: {
          enabled: true,
          allowed_events: ['k12.practice_return.requested.v1'],
          allowed_workflows: [],
        },
      }),
    )

    await rotateK12WebhookSecret('a b/c', 'k12-tutor-a')
    expect(mockFetch).toHaveBeenLastCalledWith(
      `/api/v1/webhooks/a%20b%2Fc${scoped}`,
      expect.objectContaining({
        method: 'PATCH',
        body: { rotate_secret: true },
      }),
    )

    await retryK12WebhookReceipt('a b/c', 'k12-tutor-a', 'receipt failed/1')
    expect(mockFetch).toHaveBeenLastCalledWith(
      `/api/v1/webhooks/a%20b%2Fc${scoped}`,
      expect.objectContaining({
        method: 'PATCH',
        body: { retry_receipt_id: 'receipt failed/1' },
      }),
    )

    await deleteK12Webhook('a b/c', 'k12-tutor-a')
    expect(mockFetch).toHaveBeenLastCalledWith(
      `/api/v1/webhooks/a%20b%2Fc${scoped}`,
      expect.objectContaining({
        method: 'DELETE',
      }),
    )
  })
})
