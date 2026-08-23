import { describe, expect, it } from 'vitest'
import {
  assertCurrentImageTaskCreativeEntrySemantics,
  normalizeImageTaskDispatchEnvelope,
} from '../k12-image-task-semantics'

function promotedCreativeEnvelope() {
  return {
    dispatch: {
      dispatch_id: 'dispatch-independent-work',
      task_intent: 'artwork',
      status: 'routed',
      retryable: false,
      intent_evidence: ['parent_selected:artwork'],
      intent_confidence: 1,
      confirmation_candidates: [],
      target: {
        type: 'creative_work_intake',
        id: 'intake-independent-work',
      },
      target_projection: {
        kind: 'creative',
        intake_id: 'intake-independent-work',
        work_type: 'art',
        status: 'promoted',
        entry_kind: 'new_work',
        promotion_policy: 'explicit_commit',
        routing_provenance: 'parent_selected',
        commit_required: false,
        commit_state: 'committed',
        promoted_work_id: 'work-independent',
        promoted_generation_id: 'generation-independent',
        work: {
          work_id: 'work-independent',
          display_name: '美术作品',
        },
      },
      progress: { operation: 'promotion', state: 'feedback_pending' },
      version: 2,
      created_at: 1,
      updated_at: 2,
    },
  }
}

describe('BUG-20260724-012 independent CreativeWork wire contract', () => {
  it('accepts only promoted_generation_id for the current promoted response', () => {
    expect(() => normalizeImageTaskDispatchEnvelope(promotedCreativeEnvelope())).not.toThrow()

    const legacyVersion = promotedCreativeEnvelope()
    const projection = legacyVersion.dispatch.target_projection as Record<string, unknown>
    delete projection.promoted_generation_id
    projection.promoted_version_id = 'v1'

    expect(() => normalizeImageTaskDispatchEnvelope(legacyVersion)).toThrow(/promoted_version_id/)
  })

  it('requires the promoted generation identity instead of accepting a half-promoted result', () => {
    const response = promotedCreativeEnvelope()
    delete (response.dispatch.target_projection as Record<string, unknown>).promoted_generation_id

    expect(() => normalizeImageTaskDispatchEnvelope(response)).toThrow(/promoted_generation_id/)
  })

  it('accepts an omitted automatic entry and the exact current new_work union', () => {
    expect(() => assertCurrentImageTaskCreativeEntrySemantics(undefined)).not.toThrow()
    expect(() =>
      assertCurrentImageTaskCreativeEntrySemantics({
        kind: 'new_work',
        task_intent: 'writing',
      }),
    ).not.toThrow()
  })

  it.each([
    { kind: 'revision', task_intent: 'artwork' },
    { kind: 'revision', task_intent: 'artwork', work_id: 'work-legacy' },
    {
      kind: 'revision',
      task_intent: 'artwork',
      work_id: 'work-legacy',
      base_version_id: 'v1',
    },
    { kind: 'new_work', task_intent: 'artwork', work_id: 'work-legacy' },
    { kind: 'new_work', task_intent: 'artwork', base_version_id: 'v1' },
  ])('rejects retired current creative_entry %j before transport', (entry) => {
    expect(() => assertCurrentImageTaskCreativeEntrySemantics(entry)).toThrow(/creative_entry/)
  })
})
