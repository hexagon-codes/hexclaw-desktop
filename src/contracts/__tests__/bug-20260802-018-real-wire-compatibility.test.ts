import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  K12_IMAGE_TASK_SCHEMA_VERSION,
  validateImageTaskCreate,
  validateImageTaskDispatch,
  validateImageTaskResult,
  validateImageTaskSourceAction,
} from '../generated/k12-image-task.v1'

const fixtureDirectory = process.env.HEXCLAW_K12_WIRE_FIXTURE_DIR || ''

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(fixtureDirectory, name), 'utf8')) as Record<string, unknown>
}

describe.runIf(fixtureDirectory)('BUG-20260802-018 real Go HTTP wire compatibility', () => {
  const cases = [
    ['create.json', validateImageTaskCreate],
    ['dispatch.json', validateImageTaskDispatch],
    ['result.json', validateImageTaskResult],
    ['source-action.json', validateImageTaskSourceAction],
  ] as const

  it('accepts the current v1 raw create/get/result/source-action bodies', () => {
    expect(K12_IMAGE_TASK_SCHEMA_VERSION).toBe('v1')
    for (const [name, validate] of cases) {
      expect(validate(fixture(name)), name).toBe(true)
    }
  })

  it('rejects legacy envelopes instead of guessing their meaning', () => {
    expect(validateImageTaskCreate({ created: true, dispatch: { id: 'legacy-dispatch' } })).toBe(
      false,
    )
    expect(
      validateImageTaskDispatch({
        dispatch: {
          dispatch_id: 'legacy-dispatch',
          target: { kind: 'creative' },
          progress: 'completed',
        },
      }),
    ).toBe(false)
    expect(
      validateImageTaskResult({ kind: 'creative', payload: { work_id: 'legacy-work' } }),
    ).toBe(false)
    expect(
      validateImageTaskSourceAction({
        dispatch_id: 'legacy-dispatch',
        problem_id: 'legacy-problem',
        action: 'skip',
      }),
    ).toBe(false)
  })

  it('rejects an unknown schema-version marker on every current raw body', () => {
    for (const [name, validate] of cases) {
      expect(validate({ ...fixture(name), schema_version: 'v2' }), name).toBe(false)
    }
  })
})
