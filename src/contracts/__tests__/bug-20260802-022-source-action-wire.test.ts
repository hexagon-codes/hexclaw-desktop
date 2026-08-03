import { describe, expect, it } from 'vitest'
import {
  assertK12ImageTaskProblemSourceActionResponse,
  K12_IMAGE_TASK_SCHEMA,
} from '../generated/k12-image-task.v1'
import {
  assertImageTaskProblemSourceActionSemantics,
  normalizeImageTaskProblemSourceActionSnapshot,
} from '../k12-image-task-semantics'

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

function expected(response: MutableRecord) {
  return {
    dispatchId: String(response.dispatch_id),
    problemId: String(response.problem_id),
    action: String(response.action),
    structureVersion: Number(response.structure_version),
    expectedInputRevision: Number(response.input_revision),
  }
}

function currentProblem(): MutableRecord {
  return {
    problem_id: 'problem-source-action',
    source_number_path: ['一', '1'],
    display_label: '一. 1',
    source_section_path: ['数学'],
    source_section_label: '数学',
    system_section_ordinal: 1,
    system_display_label: '第 1 题',
    source_state: 'awaiting_resolution',
    anchor_state: 'located',
    operation_state: 'prepared',
    disposition_state: 'open',
    result_projection: null,
    published_revision: 0,
    input_revision: 1,
    command_available: true,
    page_asset_id: 'asset://mingming/old.png',
    source_width: 120,
    source_height: 160,
    source_region: { x: 5, y: 7, width: 80, height: 90 },
  }
}

describe('BUG-20260802-022 · generated source-action raw-wire contract', () => {
  it('PROG-026B accepts the canonical producer fixture through generated and identity boundaries', () => {
    const response = canonicalExample()

    expect(() => assertK12ImageTaskProblemSourceActionResponse(response)).not.toThrow()
    expect(() =>
      assertImageTaskProblemSourceActionSemantics(response, expected(response)),
    ).not.toThrow()
  })

  it('PROG-026B normalizes one complete current source exact-set and preserves explicit null crop', () => {
    const response = canonicalExample()
    const wireProblem = firstProblem(response)

    const snapshot = normalizeImageTaskProblemSourceActionSnapshot(response, [currentProblem()])
    const normalized = (snapshot.problem_progress as MutableRecord[])[0]

    expect(normalized).toMatchObject({
      page_asset_id: wireProblem.page_asset_id,
      source_width: wireProblem.source_width,
      source_height: wireProblem.source_height,
      source_region: null,
    })
  })

  it('PROG-026B keeps historical frozen responses with the old all-absent source shape compatible', () => {
    const response = canonicalExample()
    const problem = firstProblem(response)
    for (const field of ['page_asset_id', 'source_width', 'source_height', 'source_region']) {
      delete problem[field]
    }

    expect(() => assertK12ImageTaskProblemSourceActionResponse(response)).not.toThrow()
    expect(() =>
      assertImageTaskProblemSourceActionSemantics(response, expected(response)),
    ).not.toThrow()
    const snapshot = normalizeImageTaskProblemSourceActionSnapshot(response, [currentProblem()])
    const normalized = (snapshot.problem_progress as MutableRecord[])[0]!
    expect(normalized).not.toHaveProperty('page_asset_id')
    expect(normalized).not.toHaveProperty('source_width')
    expect(normalized).not.toHaveProperty('source_height')
    expect(normalized).not.toHaveProperty('source_region')
  })

  it.each(['page_asset_id', 'source_width', 'source_height', 'source_region'])(
    'PROG-026B fails closed when a new source exact-set is missing %s',
    (missingField) => {
      const response = canonicalExample()
      delete firstProblem(response)[missingField]

      expect(() => assertK12ImageTaskProblemSourceActionResponse(response)).not.toThrow()
      expect(() =>
        assertImageTaskProblemSourceActionSemantics(response, expected(response)),
      ).toThrow(/source exact-set/)
    },
  )

  it('PROG-026B fails closed when a source-pixel crop exceeds the immutable PageAsset bounds', () => {
    const response = canonicalExample()
    Object.assign(firstProblem(response), {
      source_width: 100,
      source_height: 80,
      source_region: { x: 90, y: 5, width: 11, height: 20 },
    })

    expect(() => assertK12ImageTaskProblemSourceActionResponse(response)).not.toThrow()
    expect(() => assertImageTaskProblemSourceActionSemantics(response, expected(response))).toThrow(
      /inside PageAsset/,
    )
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
