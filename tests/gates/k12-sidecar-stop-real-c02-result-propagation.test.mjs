import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  assertPlaywrightSucceeded,
  candidatePolicy,
  playwrightFailureLocations,
  playwrightRecognitionCountFacts,
  playwrightSourceFactFacts,
  playwrightTerminalFailureFacts,
  safeFailureKindClass,
  safeItemFailureClass,
  safeItemFailureCodeClass,
} from './k12-sidecar-stop-real-c02.test.mjs'

test('C02 source exact-set oracle emits only the fixed count diagnostic', async () => {
  const source = await readFile(
    new URL('../live/k12-current-bug-real-matrix.spec.ts', import.meta.url),
    'utf8',
  )
  const start = source.indexOf('function assertHomeworkSourceFacts(')
  const end = source.indexOf('\nfunction ', start + 1)
  assert.notEqual(start, -1, 'must find the shared source exact-set oracle')
  const oracle = source.slice(start, end === -1 ? undefined : end)
  assert.match(
    oracle,
    /C02 recognition exact-set count mismatch expected=\$\{homeworkGroundTruth\.length\} actual=\$\{questions\.length\}/,
  )
  assert.doesNotMatch(oracle, /\.toHaveLength\(/)
})

test('C02 source exact-set oracle emits only the fixed source-field diagnostic', async () => {
  const source = await readFile(
    new URL('../live/k12-current-bug-real-matrix.spec.ts', import.meta.url),
    'utf8',
  )
  const start = source.indexOf('function assertHomeworkSourceFacts(')
  const end = source.indexOf('\nfunction ', start + 1)
  assert.notEqual(start, -1, 'must find the shared source exact-set oracle')
  const oracle = source.slice(start, end === -1 ? undefined : end)
  const helperStart = source.indexOf('function assertHomeworkSourceFact(')
  const helperEnd = source.indexOf('\nfunction ', helperStart + 1)
  assert.notEqual(helperStart, -1, 'must find the source-fact assertion helper')
  const helper = source.slice(helperStart, helperEnd === -1 ? undefined : helperEnd)
  assert.match(oracle, /assertHomeworkSourceFact\(/)
  assert.match(
    helper,
    /C02 source exact-set mismatch index=\$\{index \+ 1\} field=\$\{field\}/,
  )
  assert.doesNotMatch(helper, /expected\.label/)
})

test('C02 outer runner permits only bounded count mismatch facts', () => {
  assert.deepEqual(
    playwrightRecognitionCountFacts(
      'Error: C02 recognition exact-set count mismatch expected=16 actual=0',
    ),
    { expected_count: 16, actual_count: 0 },
  )
  assert.deepEqual(
    playwrightRecognitionCountFacts(
      '  C02 recognition exact-set count mismatch expected=16 actual=15  ',
    ),
    { expected_count: 16, actual_count: 15 },
  )
  assert.equal(
    playwrightRecognitionCountFacts(
      'C02 recognition exact-set count mismatch expected=16 actual=16',
    ),
    undefined,
  )
  assert.equal(
    playwrightRecognitionCountFacts(
      'C02 recognition exact-set count mismatch expected=16 actual=-1',
    ),
    undefined,
  )
  assert.equal(
    playwrightRecognitionCountFacts(
      'C02 recognition exact-set count mismatch expected=16 actual=17',
    ),
    undefined,
  )
  assert.equal(
    playwrightRecognitionCountFacts(
      'untrusted model body: C02 recognition exact-set count mismatch expected=16 actual=0',
    ),
    undefined,
  )
})

test('C02 outer runner permits only bounded source-field mismatch facts', () => {
  assert.deepEqual(
    playwrightSourceFactFacts(
      'Error: C02 source exact-set mismatch index=1 field=source_number_path',
    ),
    { index: 1, field: 'source_number_path' },
  )
  assert.deepEqual(
    playwrightSourceFactFacts(
      '  C02 source exact-set mismatch index=16 field=system_display_label  ',
    ),
    { index: 16, field: 'system_display_label' },
  )
  for (const output of [
    'C02 source exact-set mismatch index=0 field=source_number_path',
    'C02 source exact-set mismatch index=17 field=source_number_path',
    'C02 source exact-set mismatch index=1 field=unknown_field',
    'untrusted model body: C02 source exact-set mismatch index=1 field=source_number_path',
  ]) {
    assert.equal(playwrightSourceFactFacts(output), undefined)
  }
})

test('C02 diagnostic candidate reserves measured headroom for 16/32 item operation mix', () => {
  assert.equal(candidatePolicy.item_concurrency, 1)
  assert.deepEqual(
    candidatePolicy.assessing_buckets.map((bucket) => [bucket.max_problems, bucket.seconds]),
    [
      [1, 600],
      [8, 600],
      [16, 900],
      [32, 900],
    ],
  )
})

test('C02 outer runner propagates a nonzero Playwright status without exposing child output', () => {
  assert.doesNotThrow(() => assertPlaywrightSucceeded(0))
  assert.throws(
    () => assertPlaywrightSucceeded(1),
    /single real C02 Playwright.*status=1.*output redacted/i,
  )
})

test('C02 outer runner reduces failed child output to bounded source locations', () => {
  const output = [
    'untrusted model body must never be printed',
    'at tests/live/k12-current-bug-real-matrix.spec.ts:531:13',
    'at tests/live/k12-current-bug-real-matrix.spec.ts:531:13',
    'at /workspace/tests/live/k12-current-bug-real-matrix.spec.ts:1527:7',
    'at tests/live/other.spec.ts:1:1',
  ].join('\n')
  assert.deepEqual(playwrightFailureLocations(output), [
    'tests/live/k12-current-bug-real-matrix.spec.ts:531:13',
    'tests/live/k12-current-bug-real-matrix.spec.ts:1527:7',
  ])
})

test('C02 outer runner exposes only whitelisted terminal enum facts', () => {
  assert.deepEqual(
    playwrightTerminalFailureFacts(
      'untrusted model body\nC02 grading reached terminal routed/failed_retryable before visible overlay (failed)',
    ),
    {
      dispatch_status: 'routed',
      projection_stage: 'failed_retryable',
      classifier_status: 'failed',
    },
  )
  assert.equal(
    playwrightTerminalFailureFacts(
      'C02 grading reached terminal unknown/value before visible overlay (failed)',
    ),
    undefined,
  )
})

test('C02 outer runner classifies durable failure kinds without exposing unknown values', () => {
  assert.equal(safeFailureKindClass(''), 'none')
  assert.equal(safeFailureKindClass('provider_response_http_502'), 'provider_response_http_502')
  assert.equal(safeFailureKindClass('interactive_deadline_exceeded'), 'interactive_deadline_exceeded')
  assert.equal(safeFailureKindClass('item_invocation_outcome_unknown'), 'item_invocation_outcome_unknown')
  assert.equal(safeFailureKindClass('untrusted upstream body: secret'), 'other')
})

test('C02 outer runner classifies per-item failure facts without exposing provider bodies', () => {
  assert.equal(safeItemFailureClass('provider_response'), 'provider_response')
  assert.equal(safeItemFailureClass('provider_transport'), 'provider_transport')
  assert.equal(safeItemFailureClass('local'), 'local')
  assert.equal(safeItemFailureClass('untrusted provider body: secret'), 'other')
  assert.equal(safeItemFailureCodeClass('http_502'), 'http_502')
  assert.equal(safeItemFailureCodeClass('outcome_unknown'), 'outcome_unknown')
  assert.equal(safeItemFailureCodeClass('untrusted provider body: secret'), 'other')
})
