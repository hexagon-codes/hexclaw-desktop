import { describe, expect, it } from 'vitest'
import {
  assertK12ImageTaskProblemSourceActionResponse,
  K12_IMAGE_TASK_SCHEMA,
} from '../generated/k12-image-task.v1'
import { assertImageTaskProblemSourceActionSemantics } from '../k12-image-task-semantics'

type MutableRecord = Record<string, unknown>

function canonicalExample(): MutableRecord {
  const schema = K12_IMAGE_TASK_SCHEMA as unknown as MutableRecord
  const definitions = schema.$defs as MutableRecord
  const response = definitions.problemSourceActionResponse as MutableRecord
  const examples = response.examples as unknown[]
  expect(examples, 'canonical schema must own the one source-action success fixture').toHaveLength(
    1,
  )
  return structuredClone(examples[0]) as MutableRecord
}

function progressive(response: MutableRecord): MutableRecord {
  return response.progressive_snapshot as MutableRecord
}

function firstProblem(response: MutableRecord): MutableRecord {
  return (progressive(response).problem_progress as MutableRecord[])[0]!
}

describe('BUG-20260802-022 · generated source-action raw-wire contract', () => {
  it('PROG-026B accepts the canonical producer fixture through generated and identity boundaries', () => {
    const response = canonicalExample()

    expect(() => assertK12ImageTaskProblemSourceActionResponse(response)).not.toThrow()
    expect(() =>
      assertImageTaskProblemSourceActionSemantics(response, {
        dispatchId: String(response.dispatch_id),
        problemId: String(response.problem_id),
        action: String(response.action),
        structureVersion: Number(response.structure_version),
        expectedInputRevision: Number(response.input_revision),
      }),
    ).not.toThrow()
  })

  it.each([
    [
      'top-level extra property',
      (response: MutableRecord) => Object.assign(response, { snapshot: {} }),
    ],
    [
      'nested PascalCase drift',
      (response: MutableRecord) => Object.assign(firstProblem(response), { ProblemID: 'wrong' }),
    ],
    [
      'non-positive input revision',
      (response: MutableRecord) => Object.assign(firstProblem(response), { input_revision: 0 }),
    ],
    [
      'non-current durable head',
      (response: MutableRecord) =>
        Object.assign(firstProblem(response), { current_disposition: 'superseded' }),
    ],
  ])('fails closed on %s', (_name, mutate) => {
    const response = canonicalExample()
    mutate(response)
    expect(() => assertK12ImageTaskProblemSourceActionResponse(response)).toThrow()
  })

  it('fails the semantic boundary when coverage counters contradict problem states', () => {
    const response = canonicalExample()
    const coverage = progressive(response).coverage as MutableRecord
    coverage.published = 1
    coverage.skipped = 0

    expect(() => assertK12ImageTaskProblemSourceActionResponse(response)).not.toThrow()
    expect(() =>
      assertImageTaskProblemSourceActionSemantics(response, {
        dispatchId: String(response.dispatch_id),
        problemId: String(response.problem_id),
        action: String(response.action),
        structureVersion: Number(response.structure_version),
        expectedInputRevision: Number(response.input_revision),
      }),
    ).toThrow(/counters derived from problem statuses/)
  })
})
