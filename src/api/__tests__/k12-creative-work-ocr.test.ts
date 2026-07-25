import { beforeEach, describe, expect, it, vi } from 'vitest'

const client = vi.hoisted(() => ({
  api: vi.fn(),
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
}))

vi.mock('../client', () => client)

import * as k12Api from '../k12'

function manualCreativeDispatch() {
  return {
    dispatch_id: 'dispatch-creative-1',
    task_intent: 'writing',
    status: 'routed',
    intent_evidence: ['parent_selected'],
    intent_confidence: 1,
    confirmation_candidates: [],
    target: { type: 'creative_work_intake', id: 'intake-1' },
    target_projection: {
      kind: 'creative',
      intake_id: 'intake-1',
      work_type: 'writing',
      status: 'ready',
      entry_kind: 'new_work',
      promotion_policy: 'explicit_commit',
      routing_provenance: 'parent_selected',
      commit_required: true,
      commit_state: 'pending',
      canonical_version: 1,
      canonical_content: '家长确认稿',
    },
    progress: { operation: 'promotion', state: 'ready' },
    version: 3,
    created_at: 1,
    updated_at: 2,
  }
}

describe('K12 manual creative image API contract', () => {
  beforeEach(() => {
    for (const mock of Object.values(client)) mock.mockReset().mockResolvedValue({})
  })

  it('removes the retired public OCR bypasses', () => {
    const exports = k12Api as Record<string, unknown>
    for (const name of [
      'k12CreateCreativeWorkOCR',
      'k12GetCreativeWorkOCR',
      'k12RetryCreativeWorkOCR',
      'k12ConfirmCreativeWorkOCR',
    ]) {
      expect(exports[name], `${name} must stay retired`).toBeUndefined()
    }
  })

  it('uses only ImageTaskDispatch for a manual writing photo and keeps freeze separate from commit', async () => {
    const dispatch = manualCreativeDispatch()
    client.apiPost
      .mockResolvedValueOnce({ created: true, dispatch })
      .mockResolvedValueOnce({ dispatch })
      .mockResolvedValueOnce({
        dispatch: {
          ...dispatch,
          target_projection: {
            ...dispatch.target_projection,
            status: 'promoted',
            commit_state: 'committed',
            promoted_work_id: 'work-1',
            promoted_version_id: 'version-1',
            work: { work_id: 'work-1', display_name: '我的好爸爸' },
          },
          progress: { operation: 'promotion', state: 'promoted' },
          version: 4,
        },
      })

    await k12Api.k12CreateImageTask({
      agent: 'kid-a',
      source_session: 'creative-works:kid-a',
      source_kind: 'desktop',
      source_ref: 'manual-new-work-1',
      source_asset_refs: ['asset://kid-a/photo.png'],
      attempt_generation: 1,
      route_request: { selection_source: 'auto' },
      creative_entry: { kind: 'new_work', task_intent: 'writing' },
    })
    await k12Api.k12ConfirmImageTask('dispatch-creative-1', {
      agent: 'kid-a',
      version: 3,
      creative: {
        action: 'freeze_ocr',
        canonical_version: 1,
        canonical_content: '家长确认稿',
      },
    })
    await k12Api.k12ConfirmImageTask('dispatch-creative-1', {
      agent: 'kid-a',
      version: 3,
      creative: {
        action: 'commit',
        work_title: '我的好爸爸',
        task_requirement: '写一篇记叙文',
        content_markdown: '家长确认稿',
      },
    })

    expect(client.apiPost).toHaveBeenNthCalledWith(
      1,
      '/api/k12/image-tasks',
      expect.objectContaining({
        creative_entry: { kind: 'new_work', task_intent: 'writing' },
      }),
      { timeout: 60_000, signal: undefined },
    )
    expect(client.apiPost).toHaveBeenNthCalledWith(
      2,
      '/api/k12/image-tasks/dispatch-creative-1/confirm',
      {
        agent: 'kid-a',
        version: 3,
        creative: {
          action: 'freeze_ocr',
          canonical_version: 1,
          canonical_content: '家长确认稿',
        },
      },
      { timeout: 60_000, signal: undefined },
    )
    expect(client.apiPost).toHaveBeenNthCalledWith(
      3,
      '/api/k12/image-tasks/dispatch-creative-1/confirm',
      {
        agent: 'kid-a',
        version: 3,
        creative: {
          action: 'commit',
          work_title: '我的好爸爸',
          task_requirement: '写一篇记叙文',
          content_markdown: '家长确认稿',
        },
      },
      { timeout: 60_000, signal: undefined },
    )
  })

  it('freezes the revision identity in creative_entry instead of writing a version directly', async () => {
    client.apiPost.mockResolvedValue({ created: true, dispatch: manualCreativeDispatch() })

    await k12Api.k12CreateImageTask({
      agent: 'kid-a',
      source_session: 'creative-works:kid-a',
      source_kind: 'desktop',
      source_ref: 'manual-revision-1',
      source_asset_refs: ['asset://kid-a/revision.png'],
      attempt_generation: 1,
      route_request: { selection_source: 'auto' },
      creative_entry: {
        kind: 'revision',
        task_intent: 'writing',
        work_id: 'work-1',
        base_version_id: 'version-1',
      },
    })

    expect(client.apiPost).toHaveBeenCalledWith(
      '/api/k12/image-tasks',
      expect.objectContaining({
        creative_entry: {
          kind: 'revision',
          task_intent: 'writing',
          work_id: 'work-1',
          base_version_id: 'version-1',
        },
      }),
      { timeout: 60_000, signal: undefined },
    )
  })
})
