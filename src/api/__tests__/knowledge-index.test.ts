import { beforeEach, describe, expect, it, vi } from 'vitest'

const { apiGet, apiPost } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}))

vi.mock('../client', () => ({ apiGet, apiPost }))

import {
  applyKnowledgeEmbeddingPolicy,
  cancelKnowledgeJob,
  getKnowledgeEmbeddingPolicy,
  getKnowledgeJob,
  isKnowledgeEmbeddingPolicyUnsupported,
} from '../knowledge-index'

describe('knowledge semantic-index policy API', () => {
  beforeEach(() => vi.clearAllMocks())

  it('reads one owner-scoped projection that includes policy and profile catalog', async () => {
    apiGet.mockResolvedValueOnce({
      policy_version: 4,
      selection: { kind: 'auto' },
      indexing_activity: {
        state: 'idle',
        processing_documents: 0,
        chunks_done: null,
        chunks_total: null,
      },
      available_profiles: [],
      recommendation: null,
      catalog_version: 9,
    })

    await getKnowledgeEmbeddingPolicy('default')

    expect(apiGet).toHaveBeenCalledWith('/api/v1/knowledge/corpora/default/embedding-policy', {
      user_id: 'desktop-user',
    })
  })

  it('applies only the strict tagged union and expected policy version', async () => {
    apiPost.mockResolvedValueOnce({
      policy_version: 5,
      selection: { kind: 'profile', profile_id: 'sf-bge-m3' },
      active_revision_id: 'rev-a',
      desired_revision_id: 'rev-b',
      job_id: 'job-b',
    })

    await applyKnowledgeEmbeddingPolicy('default', 4, { kind: 'profile', profile_id: 'sf-bge-m3' })

    expect(apiPost).toHaveBeenCalledWith(
      '/api/v1/knowledge/corpora/default/embedding-policy:apply?user_id=desktop-user',
      {
        expected_policy_version: 4,
        selection: { kind: 'profile', profile_id: 'sf-bge-m3' },
      },
    )
    const body = apiPost.mock.calls[0]?.[1] as Record<string, unknown>
    expect(body).not.toHaveProperty('location')
    expect(body).not.toHaveProperty('provider')
    expect(body).not.toHaveProperty('model')
  })

  it('distinguishes an absent route from an initialized semantic resource miss', () => {
    expect(isKnowledgeEmbeddingPolicyUnsupported({ status: 404 })).toBe(true)
    expect(isKnowledgeEmbeddingPolicyUnsupported({ statusCode: 405 })).toBe(true)
    expect(
      isKnowledgeEmbeddingPolicyUnsupported({
        status: 404,
        data: { code: 'semantic_index_not_found' },
      }),
    ).toBe(false)
    expect(
      isKnowledgeEmbeddingPolicyUnsupported({
        response: { status: 404, _data: { code: 'semantic_index_not_found' } },
      }),
    ).toBe(false)
    expect(isKnowledgeEmbeddingPolicyUnsupported({ status: 401 })).toBe(false)
    expect(isKnowledgeEmbeddingPolicyUnsupported({ status: 409 })).toBe(false)
    expect(isKnowledgeEmbeddingPolicyUnsupported(new Error('业务消息里出现 404 个切片'))).toBe(
      false,
    )
  })

  it('reads a persistent knowledge job by encoded id', async () => {
    apiGet.mockResolvedValueOnce({
      job_id: 'job/a',
      state: 'running',
      stage: 'embedding',
      pages_done: null,
      pages_total: null,
      chunks_done: 135,
      chunks_total: 225,
    })

    await getKnowledgeJob('job/a')

    expect(apiGet).toHaveBeenCalledWith('/api/v1/knowledge/jobs/job%2Fa', {
      user_id: 'desktop-user',
    })
  })

  it('cancels a persistent knowledge job by encoded id', async () => {
    apiPost.mockResolvedValueOnce({ job_id: 'job/a', state: 'cancelled' })

    await cancelKnowledgeJob('job/a')

    expect(apiPost).toHaveBeenCalledWith(
      '/api/v1/knowledge/jobs/job%2Fa/cancel?user_id=desktop-user',
    )
  })
})
