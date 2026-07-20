import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const repoFile = (path) => new URL(`../../${path}`, import.meta.url)

const expectedSpecs = [
  'ftue-dynamic.spec.ts',
  'grading-real-fixtures.spec.ts',
  'creative-real-fixtures.spec.ts',
  'grounding-pdf.spec.ts',
  'practice-integrity.spec.ts',
  'role-privacy.spec.ts',
  'responsive-a11y.spec.ts',
]

const reportPath = 'test-results/k12-fixtures/report.json'

async function readJSON(path) {
  return JSON.parse(await readFile(repoFile(path), 'utf8'))
}

async function loadGateModule() {
  return import(repoFile('scripts/ci/k12-fixtures-gate.mjs'))
}

function passingReport(specs = expectedSpecs) {
  return {
    errors: [],
    suites: [
      {
        title: 'K12 real Fixture current-source gate',
        specs: specs.map((file) => ({
          title: file,
          file: `/workspace/tests/e2e/${file}`,
          tests: [
            {
              projectName: 'chromium',
              expectedStatus: 'passed',
              results: [{ status: 'passed' }],
            },
          ],
        })),
      },
    ],
  }
}

test('dedicated config and environment contract freeze exactly seven Fixture specs', async () => {
  const configPath = repoFile('playwright.k12.fixtures.config.ts')
  const contractPath = repoFile('tests/e2e/k12-fixtures-gate.contract.json')

  assert.equal(existsSync(configPath), true, 'dedicated Fixture Playwright config is required')
  assert.equal(existsSync(contractPath), true, 'machine-readable Fixture gate contract is required')

  const config = await readFile(configPath, 'utf8')
  const contract = await readJSON('tests/e2e/k12-fixtures-gate.contract.json')

  assert.equal(contract.schemaVersion, 1)
  assert.equal(contract.reportPath, reportPath)
  assert.deepEqual(
    contract.specs.map(({ file }) => file),
    expectedSpecs,
  )
  assert.equal(new Set(contract.specs.map(({ file }) => file)).size, 7)
  assert.deepEqual(contract.currentSource.endpoints, ['HEX_E2E_BASE_URL', 'HEX_E2E_SIDECAR_URL'])
  assert.equal(contract.currentSource.managesWebServer, false)
  assert.equal(contract.currentSource.managesSidecar, false)

  const gatesBySpec = Object.fromEntries(
    contract.specs.map(({ file, zeroSkipGates }) => [file, zeroSkipGates]),
  )
  assert.deepEqual(gatesBySpec, {
    'ftue-dynamic.spec.ts': ['HEX_K12_ACCEPTANCE_LIVE', 'HEX_K12_REAL_MODEL'],
    'grading-real-fixtures.spec.ts': ['HEX_K12_ACCEPTANCE_LIVE', 'HEX_K12_REAL_MODEL'],
    'creative-real-fixtures.spec.ts': [
      'HEX_K12_ACCEPTANCE_LIVE',
      'HEX_K12_REAL_MODEL',
      'HEX_K12_CREATIVE_AI',
    ],
    'grounding-pdf.spec.ts': ['HEX_K12_KNOWLEDGE_LIVE', 'HEX_K12_SCAN_OCR_LIVE'],
    'practice-integrity.spec.ts': ['HEX_K12_ACCEPTANCE_LIVE', 'HEX_K12_PRACTICE_LIVE'],
    'role-privacy.spec.ts': [
      'HEX_K12_ACCEPTANCE_LIVE',
      'HEX_K12_ROLE_MODE',
      'HEX_K12_THIRD_PARTY_SPY_URL',
      'HEX_K12_CLOUD_EMBEDDING_LABEL',
    ],
    'responsive-a11y.spec.ts': ['HEX_K12_ACCEPTANCE_LIVE', 'HEX_K12_REAL_MODEL'],
  })

  assert.match(config, /testDir:\s*['"]\.\/tests\/e2e['"]/)
  assert.match(config, /testMatch:\s*k12FixtureTestMatch/)
  assert.match(config, /outputFile:\s*contract\.reportPath/)
  assert.match(config, /baseURL:\s*process\.env\.HEX_E2E_BASE_URL/)
  assert.match(config, /workers:\s*1/)
  assert.match(config, /retries:\s*0/)
  assert.match(config, /fullyParallel:\s*false/)
  assert.doesNotMatch(config, /\bwebServer\s*:/)
})

test('package exposes separate diagnostic and strict Fixture gate commands', async () => {
  const pkg = await readJSON('package.json')

  assert.equal(pkg.scripts['test:e2e:k12-fixtures'], 'node ./scripts/ci/k12-fixtures-gate.mjs')
  assert.equal(
    pkg.scripts['test:e2e:k12-fixtures:strict'],
    'node ./scripts/ci/k12-fixtures-gate.mjs --strict',
  )
})

test('environment contract stays aligned with the switches referenced by every spec', async () => {
  const contract = await readJSON('tests/e2e/k12-fixtures-gate.contract.json')
  const helpers = await readFile(repoFile('tests/e2e/helpers.ts'), 'utf8')

  assert.match(helpers, /process\.env\.HEX_E2E_SIDECAR_URL/)

  for (const { file, zeroSkipGates, fixtureOverrides } of contract.specs) {
    const source = await readFile(repoFile(`tests/e2e/${file}`), 'utf8')
    const referenced = new Set(
      [...source.matchAll(/process\.env\.(HEX_(?:K12|FIXTURE)_[A-Z0-9_]+)/g)].map(
        (match) => match[1],
      ),
    )
    const declared = new Set([...zeroSkipGates, ...fixtureOverrides])

    assert.deepEqual(
      [...referenced].sort(),
      [...declared].sort(),
      `${file} environment switches drifted from the gate contract`,
    )
  }
})

test('report audit accepts only a passed exact seven-file result set', async () => {
  const { auditK12FixturesReport } = await loadGateModule()
  const audit = auditK12FixturesReport(passingReport())

  assert.equal(audit.total, 7)
  assert.deepEqual(audit.files, expectedSpecs)
})

test('report audit rejects zero tests and exact-set drift', async () => {
  const { auditK12FixturesReport } = await loadGateModule()

  assert.throws(() => auditK12FixturesReport({ errors: [], suites: [] }), /zero tests collected/i)
  assert.throws(
    () => auditK12FixturesReport(passingReport(expectedSpecs.slice(0, -1))),
    /fixture spec exact-set mismatch/i,
  )
  assert.throws(
    () => auditK12FixturesReport(passingReport([...expectedSpecs, 'unexpected.spec.ts'])),
    /fixture spec exact-set mismatch/i,
  )
})

test('report audit rejects declared and runtime skips', async () => {
  const { auditK12FixturesReport } = await loadGateModule()
  const declaredSkip = passingReport()
  declaredSkip.suites[0].specs[0].tests[0].expectedStatus = 'skipped'
  declaredSkip.suites[0].specs[0].tests[0].results = [{ status: 'skipped' }]

  assert.throws(() => auditK12FixturesReport(declaredSkip), /skipped is not pass/i)

  const runtimeSkip = passingReport()
  runtimeSkip.suites[0].specs[0].tests[0].results = [{ status: 'skipped' }]
  assert.throws(() => auditK12FixturesReport(runtimeSkip), /skipped is not pass/i)
})

test('report audit rejects results from a different browser project', async () => {
  const { auditK12FixturesReport } = await loadGateModule()
  const chromiumReport = passingReport()

  assert.throws(
    () => auditK12FixturesReport(chromiumReport, { expectedProject: 'webkit' }),
    /did not run in webkit/i,
  )
  assert.doesNotThrow(() => auditK12FixturesReport(chromiumReport, { expectedProject: 'chromium' }))
})

test('report audit and exit policy cannot hide failures or incomplete results', async () => {
  const { auditK12FixturesReport, gateExitCode } = await loadGateModule()
  const failed = passingReport()
  failed.suites[0].specs[0].tests[0].results = [{ status: 'failed' }]

  assert.throws(() => auditK12FixturesReport(failed), /non-passing result/i)

  const incomplete = passingReport()
  incomplete.suites[0].specs[0].tests[0].results = []
  assert.throws(() => auditK12FixturesReport(incomplete), /no completed result/i)

  assert.equal(gateExitCode({ playwrightStatus: 2, strict: true, auditPassed: true }), 2)
  assert.equal(gateExitCode({ playwrightStatus: 0, strict: true, auditPassed: false }), 1)
  assert.equal(gateExitCode({ playwrightStatus: 0, strict: true, auditPassed: true }), 0)
  assert.equal(gateExitCode({ playwrightStatus: 0, strict: false, auditPassed: false }), 0)
})

test('runner removes only the pnpm argument separator before forwarding Playwright flags', async () => {
  const { normalizeGateArguments, validateGateArguments } = await loadGateModule()

  assert.deepEqual(normalizeGateArguments(['--', '--list']), {
    strict: false,
    playwrightArgs: ['--list'],
  })
  assert.deepEqual(normalizeGateArguments(['--strict', '--', '--grep', 'fixture']), {
    strict: true,
    playwrightArgs: ['--grep', 'fixture'],
  })
  assert.doesNotThrow(() => validateGateArguments({ strict: false, playwrightArgs: ['--list'] }))
  assert.throws(
    () => validateGateArguments({ strict: true, playwrightArgs: ['--grep', 'fixture'] }),
    /strict gate does not accept playwright filters/i,
  )
})
