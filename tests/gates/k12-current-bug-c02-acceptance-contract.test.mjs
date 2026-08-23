import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(
  new URL('../live/k12-current-bug-real-matrix.spec.ts', import.meta.url),
  'utf8',
)

function sourceBetween(start, end) {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from + start.length)
  assert.notEqual(from, -1, `missing source marker: ${start}`)
  assert.notEqual(to, -1, `missing source marker: ${end}`)
  return source.slice(from, to)
}

test('C02 oracle freezes fourteen correct items and process issues only at items 15 and 16', () => {
  const oracle = sourceBetween('const homeworkGroundTruth = [', '] as const')
  const statuses = [...oracle.matchAll(/status:\s*'([^']+)'/gu)].map((match) => match[1])

  assert.deepEqual(statuses, [
    ...Array.from({ length: 14 }, () => 'correct'),
    'correct_with_process_issue',
    'correct_with_process_issue',
  ])
  assert.match(oracle, /homeworkSources\[14\][\s\S]*processDiagnosis:\s*\['300\/2\/2=50'\]/u)
  assert.match(oracle, /homeworkSources\[15\][\s\S]*processDiagnosis:\s*\['42=18\*2'\]/u)
})

test('C02 clear homework asserts zero manual confirmation instead of checking every row', () => {
  const c02 = sourceBetween(
    "if (real10xCycle === 'C02') {",
    "if (real10xCycle === 'C05' || real10xCycle === 'C06') {",
  )
  const helper = sourceBetween(
    'async function confirmRecognizedRowsIfRequired(',
    'async function waitForCreativeResult(',
  )

  assert.match(c02, /expectedManualConfirmationCount:\s*0/u)
  assert.match(helper, /expectedManualConfirmationCount\s*===\s*0/u)
  assert.match(helper, /toHaveCount\(expectedManualConfirmationCount\)/u)
})
