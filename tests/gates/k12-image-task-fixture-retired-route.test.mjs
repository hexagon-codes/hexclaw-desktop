import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const repoFile = (path) => new URL(`../../${path}`, import.meta.url)

const activeFixtureSpecs = [
  'tests/e2e/responsive-a11y.spec.ts',
  'tests/e2e/photo-degradation-matrix.spec.ts',
]

test('BUG-20260728-002 active image fixtures use the ImageTask create contract', async () => {
  const retiredRoute = /\/api(?:\/v1)?\/k12\/grading-jobs/
  const retired = []
  const contractDrift = []

  for (const file of activeFixtureSpecs) {
    const source = await readFile(repoFile(file), 'utf8')
    if (retiredRoute.test(source)) retired.push(file)
    if (!source.includes('/api/k12/image-tasks')) contractDrift.push(`${file}: image-tasks`)
    if (!source.includes('source_asset_refs')) contractDrift.push(`${file}: source_asset_refs`)
    if (!source.includes('rec-panel__err')) contractDrift.push(`${file}: terminal failure race`)
  }

  assert.deepEqual(
    retired,
    [],
    'active real-fixture specs must not positively use retired grading-jobs',
  )
  assert.deepEqual(
    contractDrift,
    [],
    'active real-fixture specs must assert the current ImageTask DTO and terminal wait',
  )
})
