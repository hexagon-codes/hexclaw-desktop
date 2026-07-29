import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const repoFile = (path) => new URL(`../../${path}`, import.meta.url)

test('strict LIVE gate derives every displayed count from the exact spec set', async () => {
  const gate = await import(repoFile('scripts/ci/k12-live-gate.mjs'))
  const source = await readFile(repoFile('scripts/ci/k12-live-gate.mjs'), 'utf8')

  assert.equal(gate.K12_LIVE_SPEC_FILES.length, 8)
  assert.deepEqual(gate.describeLiveSpecSet(gate.K12_LIVE_SPEC_FILES), {
    count: 8,
    fileLabel: '8-file',
    progressLabel: '8/8 files',
  })
  assert.deepEqual(gate.describeLiveSpecSet([...gate.K12_LIVE_SPEC_FILES, 'ninth.spec.ts']), {
    count: 9,
    fileLabel: '9-file',
    progressLabel: '9/9 files',
  })
  assert.deepEqual(gate.describeLiveSpecSet(gate.K12_LIVE_SPEC_FILES.slice(0, -1)), {
    count: 7,
    fileLabel: '7-file',
    progressLabel: '7/7 files',
  })
  assert.doesNotMatch(source, /nine-file|9\/9 files/)
})
