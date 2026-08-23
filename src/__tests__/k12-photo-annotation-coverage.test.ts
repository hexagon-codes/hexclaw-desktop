import { describe, expect, it } from 'vitest'

import { summarizePhotoAnnotationCoverage } from '../../tests/live/k12-photo-annotation-coverage'

const validBBox = { x: 0.1, y: 0.2, w: 0.2, h: 0.06 }

const correctGrade = {
  solution: 'checked',
  verdict: 'agree',
  evidence_type: 'numeric_exec',
  badge: 'verified-strong',
  out_of_scope: false,
  record_created: false,
}
const wrongGrade = {
  solution: 'checked',
  verdict: 'disagree',
  evidence_type: 'heterogeneous_model',
  badge: 'disagree',
  out_of_scope: false,
  record_created: false,
}
const outOfScopeGrade = {
  solution: 'checked',
  verdict: 'out_of_scope',
  evidence_type: 'none',
  badge: 'out-of-scope',
  out_of_scope: true,
  record_created: false,
}
const processIssueGrade = {
  solution: 'checked',
  verdict: 'agree',
  evidence_type: 'numeric_exec',
  badge: 'verified-strong',
  out_of_scope: false,
  record_created: false,
  wrong_step: 'intermediate arithmetic step is inconsistent',
  error_cause: 'the carried value was divided twice',
}

describe('K12 LIVE photo annotation coverage oracle', () => {
  it('counts immutable-artifact marks separately from visible degraded rows', () => {
    const coverage = summarizePhotoAnnotationCoverage({
      items: [
        { status: 'correct', grade: correctGrade, question: { bbox: validBBox } },
        { status: 'wrong', grade: wrongGrade, question: { bbox: validBBox } },
        {
          status: 'out_of_scope',
          grade: outOfScopeGrade,
          question: { bbox: validBBox },
        },
        { status: 'correct', grade: correctGrade, question: { bbox: null } },
      ],
      annotated_image: { mime: 'image/png', data_base64: 'QUJD' },
    })

    expect(coverage).toEqual({
      evaluated: 4,
      immutableArtifact: true,
      artifactCoverage: 2,
      degradedCoverage: 2,
    })
  })

  it('requires programmatic DOM marks when no immutable artifact is present', () => {
    const coverage = summarizePhotoAnnotationCoverage({
      items: [
        { status: 'correct', grade: correctGrade, question: { bbox: validBBox } },
        { status: 'wrong', grade: wrongGrade, question: { bbox: null } },
      ],
    })

    expect(coverage).toEqual({
      evaluated: 2,
      immutableArtifact: false,
      artifactCoverage: 1,
      degradedCoverage: 1,
    })
  })

  it('counts correct_with_process_issue as a completed-photo overlay mark', () => {
    const coverage = summarizePhotoAnnotationCoverage({
      items: [
        {
          status: 'correct_with_process_issue',
          grade: processIssueGrade,
          question: { bbox: validBBox },
        },
      ],
      annotated_image: { mime: 'image/png', data_base64: 'QUJD' },
    })

    expect(coverage).toEqual({
      evaluated: 1,
      immutableArtifact: true,
      artifactCoverage: 1,
      degradedCoverage: 0,
    })
  })

  it('fails closed when a final item cannot map to the production overlay semantics', () => {
    expect(() =>
      summarizePhotoAnnotationCoverage({
        items: [{ status: 'failed', question: { bbox: validBBox } }],
        annotated_image: { mime: 'image/png', data_base64: 'QUJD' },
      }),
    ).toThrow('does not map to a completed-photo overlay mark')
  })

  it('rejects an incomplete grade DTO before forwarding it to the shared mapper', () => {
    expect(() =>
      summarizePhotoAnnotationCoverage({
        items: [
          {
            status: 'correct',
            grade: { out_of_scope: false, badge: 'verified-strong' },
            question: { bbox: validBBox },
          },
        ],
      }),
    ).toThrow('items[0].grade must be a complete GradeResp')
  })
})
