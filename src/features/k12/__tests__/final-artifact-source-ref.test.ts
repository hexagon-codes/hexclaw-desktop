import { describe, expect, it } from 'vitest'
import { matchesFinalArtifactSourceRef } from '../final-artifact-action'

describe('frozen final artifact source identity', () => {
  const intent = {
    action: 'export_pdf' as const,
    artifact_id: 'final-1',
    artifact_digest: 'sha256:abc123',
    artifact_title: 'Homework',
  }
  const base = 'final_artifact:final-1:sha256:abc123'
  const image = 'a'.repeat(64)

  it.each([
    base,
    `${base}:${image}:k12-image-pdf-v1`,
    `${base}:${image}:grading-pdf-v8:k12-image-pdf-v1`,
    `${base}:${image}:blank-worksheet-pdf-v1:k12-image-pdf-v1`,
  ])('accepts a known frozen source format: %s', (source) => {
    expect(matchesFinalArtifactSourceRef(source, intent)).toBe(true)
  })

  it.each([
    'final_artifact:other:sha256:abc123',
    'final_artifact:final-1:sha256:other',
    `${base}:garbage`,
    `${base}:short:grading-pdf-v8:k12-image-pdf-v1`,
    `${base}:${image}:unknown-v1:k12-image-pdf-v1`,
    `${base}:${image}:grading-pdf-v8:k12-image-pdf-v1:extra`,
  ])('rejects mismatched or malformed sources: %s', (source) => {
    expect(matchesFinalArtifactSourceRef(source, intent)).toBe(false)
  })
})
