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

const expectedTestsBySpec = {
  'ftue-dynamic.spec.ts': [
    '§1.2 FTUE upload anchor reads the frozen real-fixture SHA',
    'dynamic K12 first-use owner and thread › non-default textbook persists through the visible template flow and refresh',
    'dynamic K12 first-use owner and thread › the first request creates a visible durable thread and survives refresh',
    'dynamic K12 first-use owner and thread › two equal display names keep distinct learner and TutorAgent identities when one is renamed',
  ],
  'grading-real-fixtures.spec.ts': [
    '§1.2 grading manifest has all three immutable image identities',
    'real grading/solving fixture oracle › clear sheet preserves the correct result plus process error and visible annotation evidence',
    'real grading/solving fixture oracle › messy sheet keeps the 12/3/1 oracle and never turns unanswered into a red cross',
    'real grading/solving fixture oracle › blank sheet stays solve-only and does not create a mistake projection',
  ],
  'creative-real-fixtures.spec.ts': [
    '§1.2 creative manifest freezes writing and art source bytes',
    'real creative source, OCR, owner and feedback › art upload stores the frozen image under the exact Tutor owner and round-trips its bytes',
    'real creative source, OCR, owner and feedback › writing photo requires OCR confirmation, source-grounded feedback and a separate non-empty second work',
    'real creative source, OCR, owner and feedback › art save automatically produces feedback that cites visible elements',
    'real creative source, OCR, owner and feedback › BUG-20260725-009 real initial feedback and regeneration preserve generation identity',
  ],
  'grounding-pdf.spec.ts': [
    '§1.2 tracked PDF manifest and verifier match both immutable sources',
    'real K12 grounding PDF lifecycle › 131-page text PDF enters through the visible chooser with owner, subject and page-grounded retrieval',
    'real K12 grounding PDF lifecycle › 122-page scanned PDF exposes OCR progress and a persisted cancel/resume boundary',
  ],
  'practice-integrity.spec.ts': [
    '§1.2 practice return source reads the frozen photo SHA',
    'real practice basket, paper projection and return evidence › verified and blocked items produce one immutable question/answer exact-set',
  ],
  'role-privacy.spec.ts': [
    '§1.2 privacy source reads the frozen art SHA without logging payload bytes',
    'K12 role and privacy release boundary › same real image remains owner-scoped in DOM, asset HTTP and CreativeWork detail',
    'K12 role and privacy release boundary › common privacy notice remains in Settings without a K12-only data-route promise',
    'K12 role and privacy release boundary › child role cannot reach answer/export/delete/model controls or mutate them',
    'K12 role and privacy release boundary › third-party embedding payload boundary is checked by an external capture fixture',
  ],
  'responsive-a11y.spec.ts': [
    '§1.2 responsive/a11y gate freezes the clear-sheet source identity',
    'K12 responsive and accessibility release gate › core archive and add-work dialog stay operable at four canonical viewports and 200% zoom',
    'K12 responsive and accessibility release gate › archive controls and add-work modal expose names, roles, states, focus and Escape return',
    'K12 responsive and accessibility release gate › reduced-motion keeps the core journey stable and disables infinite decorative motion',
    'K12 responsive and accessibility release gate › real photo recognition is completable by keyboard with named live status and non-color verdicts',
  ],
}

const expectedMembers = expectedSpecs.flatMap((file) =>
  expectedTestsBySpec[file].map((title) => `${file} › ${title}`),
)

const reportPath = 'test-results/k12-fixtures/report.json'

async function readJSON(path) {
  return JSON.parse(await readFile(repoFile(path), 'utf8'))
}

async function loadGateModule() {
  return import(repoFile('scripts/ci/k12-fixtures-gate.mjs'))
}

function passingTest() {
  return {
    projectName: 'chromium',
    expectedStatus: 'passed',
    results: [{ status: 'passed' }],
  }
}

function passingReport(specs = expectedSpecs) {
  return {
    errors: [],
    suites: specs.map((file) => {
      const titles = expectedTestsBySpec[file] ?? ['unexpected test']
      const direct = titles
        .filter((title) => !title.includes(' › '))
        .map((title) => ({
          title,
          file: `/workspace/tests/e2e/${file}`,
          tests: [passingTest()],
        }))
      const nested = new Map()
      for (const title of titles.filter((item) => item.includes(' › '))) {
        const [suiteTitle, ...leaf] = title.split(' › ')
        const list = nested.get(suiteTitle) ?? []
        list.push({
          title: leaf.join(' › '),
          file: `/workspace/tests/e2e/${file}`,
          tests: [passingTest()],
        })
        nested.set(suiteTitle, list)
      }
      return {
        title: `tests/e2e/${file}`,
        file: `/workspace/tests/e2e/${file}`,
        specs: direct,
        suites: [...nested].map(([title, nestedSpecs]) => ({
          title,
          file: `/workspace/tests/e2e/${file}`,
          specs: nestedSpecs,
        })),
      }
    }),
  }
}

test('dedicated config freezes seven Fixture specs and their canonical test members', async () => {
  const configPath = repoFile('playwright.k12.fixtures.config.ts')
  const contractPath = repoFile('tests/e2e/k12-fixtures-gate.contract.json')

  assert.equal(existsSync(configPath), true, 'dedicated Fixture Playwright config is required')
  assert.equal(existsSync(contractPath), true, 'machine-readable Fixture gate contract is required')

  const config = await readFile(configPath, 'utf8')
  const contract = await readJSON('tests/e2e/k12-fixtures-gate.contract.json')

  assert.equal(contract.schemaVersion, 2)
  assert.equal(contract.reportPath, reportPath)
  assert.deepEqual(
    contract.specs.map(({ file }) => file),
    expectedSpecs,
  )
  assert.equal(new Set(contract.specs.map(({ file }) => file)).size, 7)
  const canonicalTitles = contract.specs.flatMap(({ tests }) => tests)
  const canonicalMembers = contract.specs.flatMap(({ file, tests }) =>
    tests.map((title) => `${file} › ${title}`),
  )
  assert.deepEqual(canonicalMembers, expectedMembers)
  assert.equal(
    canonicalTitles.every((title) => title === title.trim() && title.length > 0),
    true,
  )
  assert.equal(new Set(canonicalTitles).size, canonicalTitles.length)
  assert.equal(new Set(canonicalMembers).size, canonicalMembers.length)
  assert.deepEqual(contract.currentSource.endpoints, ['HEX_E2E_BASE_URL', 'HEX_E2E_SIDECAR_URL'])
  assert.equal(contract.currentSource.managesWebServer, false)
  assert.equal(contract.currentSource.managesSidecar, false)
  assert.deepEqual(contract.parentOwnedChildEnvironment, [
    'HEX_K12_REAL_10X_CYCLE_ID',
    'HEX_K12_REAL_10X_KNOWLEDGE_LINEAGE_PATH',
    'HEX_K12_REAL_10X_PARENT_RUN_ID',
  ])

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
    const declared = new Set([
      ...zeroSkipGates,
      ...fixtureOverrides,
      ...contract.parentOwnedChildEnvironment.filter((name) => referenced.has(name)),
    ])

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

  assert.equal(audit.total, expectedMembers.length)
  assert.deepEqual(audit.files, expectedSpecs)
})

test('report audit rejects a report that omits contract-declared test members', async () => {
  const { auditK12FixturesReport } = await loadGateModule()
  const report = passingReport()
  report.suites[0].specs[0].title = 'uncontracted fixture test'

  assert.throws(() => auditK12FixturesReport(report), /canonical|test member|exact-set/i)
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

for (const [cycle, file, title] of [
  [
    'C03',
    'grading-real-fixtures.spec.ts',
    'messy sheet keeps the 12/3/1 oracle and never turns unanswered into a red cross',
  ],
  [
    'C04',
    'grading-real-fixtures.spec.ts',
    'blank sheet stays solve-only and does not create a mistake projection',
  ],
  [
    'C07',
    'grounding-pdf.spec.ts',
    'C07 accepts the frozen 131-page textbook once and persists its private lineage',
  ],
  [
    'C08',
    'grounding-pdf.spec.ts',
    'C08 indexes exactly the C07 textbook lineage and persists active revision',
  ],
  [
    'C09',
    'grounding-pdf.spec.ts',
    'C09 retrieves the C08 textbook lineage through the frozen oracle',
  ],
]) {
  test(`BUG-TEST-INFRA-K12-REAL-10X parent-owned ${cycle} mode accepts one exact grading fixture`, async () => {
    const {
      auditK12FixturesReport,
      normalizeGateArguments,
      real10xScenarioGrep,
      validateGateArguments,
    } = await loadGateModule()
    assert.equal(real10xScenarioGrep(cycle), `.*${title}$`)
    const parsed = normalizeGateArguments(['--strict', '--cycle', cycle])
    assert.deepEqual(parsed, { strict: true, cycle, playwrightArgs: [] })
    assert.doesNotThrow(() =>
      validateGateArguments(parsed, {
        HEX_K12_REAL_10X_CYCLE_ID: cycle,
        HEX_K12_REAL_10X_PARENT_OWNS_LIFECYCLE: '1',
        ...(cycle >= 'C07'
          ? {
              HEX_K12_REAL_10X_KNOWLEDGE_LINEAGE_PATH:
                '/tmp/private-lineage/knowledge-lineage.json',
              HEX_K12_REAL_10X_PARENT_RUN_ID: 'parent-run',
            }
          : {}),
      }),
    )
    assert.deepEqual(
      auditK12FixturesReport(
        {
          errors: [],
          suites: [
            {
              specs: [
                {
                  title,
                  file: `/workspace/tests/e2e/${file}`,
                  tests: [
                    {
                      projectName: 'chromium',
                      expectedStatus: 'passed',
                      results: [{ status: 'passed' }],
                    },
                  ],
                },
              ],
            },
          ],
        },
        { expectedProject: 'chromium', cycle },
      ),
      { total: 1, files: [file], cycle },
    )
  })
}

test('BUG-TEST-INFRA-K12-REAL-10X parent-owned C03 gate runs only its internal scenario filter', async () => {
  const { runGate } = await loadGateModule()
  const processLike = { exitCode: undefined, stdout: { write() {} }, stderr: { write() {} } }
  let spawnArguments

  await runGate(['--strict', '--cycle', 'C03'], {
    env: {
      HEX_K12_REAL_10X_CYCLE_ID: 'C03',
      HEX_K12_REAL_10X_PARENT_OWNS_LIFECYCLE: '1',
      DINGTALK_LIVE_SEND: '1',
    },
    processLike,
    removeReport: async () => undefined,
    spawnPlaywright: (_command, args, options) => {
      spawnArguments = { args, options }
      return { status: 0 }
    },
    readReport: async () =>
      JSON.stringify({
        errors: [],
        suites: [
          {
            specs: [
              {
                title:
                  'messy sheet keeps the 12/3/1 oracle and never turns unanswered into a red cross',
                file: '/workspace/tests/e2e/grading-real-fixtures.spec.ts',
                tests: [
                  {
                    projectName: 'chromium',
                    expectedStatus: 'passed',
                    results: [{ status: 'passed' }],
                  },
                ],
              },
            ],
          },
        ],
      }),
  })

  assert.deepEqual(spawnArguments.args.slice(-2), [
    '--grep',
    '.*messy sheet keeps the 12/3/1 oracle and never turns unanswered into a red cross$',
  ])
  assert.equal(spawnArguments.options.env.DINGTALK_LIVE_SEND, '0')
  assert.equal(processLike.exitCode, 0)
})

test('BUG-TEST-INFRA-K12-REAL-10X C07-C09 reject a caller-relative lineage path before Playwright', async () => {
  const { validateGateArguments } = await loadGateModule()
  assert.throws(
    () =>
      validateGateArguments(
        { strict: true, cycle: 'C07', playwrightArgs: [] },
        {
          HEX_K12_REAL_10X_CYCLE_ID: 'C07',
          HEX_K12_REAL_10X_PARENT_OWNS_LIFECYCLE: '1',
          HEX_K12_REAL_10X_KNOWLEDGE_LINEAGE_PATH: 'relative/knowledge-lineage.json',
          HEX_K12_REAL_10X_PARENT_RUN_ID: 'parent-run',
        },
      ),
    /path.*absolute/i,
  )
})
