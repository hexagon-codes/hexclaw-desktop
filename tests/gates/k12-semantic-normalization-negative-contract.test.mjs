import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

async function loadNormalizeSemantic() {
  const source = await readFile(
    new URL('../live/k12-current-bug-real-matrix.spec.ts', import.meta.url),
    'utf8',
  )
  const signature = 'function normalizeSemantic(value: unknown): string {'
  const start = source.indexOf(signature)
  const end = source.indexOf('\n}\n\nfunction expectSemanticAlternative', start)
  assert.notEqual(start, -1, 'must find the shared C02 semantic normalizer')
  assert.notEqual(end, -1, 'must isolate the shared C02 semantic normalizer')
  const executable = source
    .slice(start, end + 2)
    .replace(
      'function normalizeSemantic(value: unknown): string {',
      'function normalizeSemantic(value) {',
    )
  return Function(`'use strict'; ${executable}; return normalizeSemantic`)()
}

function assertDoesNotMatch(normalizeSemantic, actual, expected) {
  assert.equal(
    normalizeSemantic(actual).includes(normalizeSemantic(expected)),
    false,
    `${JSON.stringify(actual)} must not match ${JSON.stringify(expected)}`,
  )
}

test('K12-LIVE-C02-SEMANTIC-ORACLE-001 rejects non-equivalent fraction variants', async () => {
  const normalizeSemantic = await loadNormalizeSemantic()

  assertDoesNotMatch(normalizeSemantic, String.raw`\dfrac{3}{7}是24`, '3/8是24')
  assertDoesNotMatch(normalizeSemantic, String.raw`6\dfrac{2}{8}`, '6又2/7')
  assertDoesNotMatch(normalizeSemantic, String.raw`\dfrac{3}8是24`, '3/8是24')
  assertDoesNotMatch(normalizeSemantic, String.raw`\unknownfrac{3}{8}是24`, '3/8是24')
})

test('K12-LIVE-C02-SEMANTIC-ORACLE-001 rejects changed numeric and operator facts', async () => {
  const normalizeSemantic = await loadNormalizeSemantic()

  assertDoesNotMatch(normalizeSemantic, '一个数的3/8是25，求这个数', '一个数的3/8是24，求这个数')
  assertDoesNotMatch(normalizeSemantic, '40=20×3', '40=20×2')
})

test('K12-LIVE-C02-SEMANTIC-ORACLE-001 rejects changed Chinese fact tokens', async () => {
  const normalizeSemantic = await loadNormalizeSemantic()

  assertDoesNotMatch(normalizeSemantic, '一个数的3/8是24，求这个量', '一个数的3/8是24，求这个数')
})
