import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const repoFile = (path) => new URL(`../../${path}`, import.meta.url)
const specFile = 'k12-current-bug-real-matrix.spec.ts'

async function loadRunner() {
  return import(repoFile('scripts/ci/k12-current-bug-live-gate.mjs'))
}

function passingReport() {
  return {
    errors: [],
    suites: [
      {
        specs: ['fixture', 'matrix', 'states'].map((title) => ({
          title,
          file: `/workspace/tests/live/${specFile}`,
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

test('dedicated contract freezes exact provider, four fixtures, six submissions and no delivery', async () => {
  const contract = JSON.parse(
    await readFile(repoFile('tests/live/k12-current-bug-real-matrix.contract.json'), 'utf8'),
  )
  assert.equal(contract.schemaVersion, 1)
  assert.equal(contract.specFile, specFile)
  assert.deepEqual(contract.provider, {
    identity: 'hexclaw-gpt',
    displayName: 'HexClaw-GPT',
    model: 'gpt-5.6-sol',
  })
  assert.equal(contract.submissions.plannedTopLevel, 6)
  assert.ok(contract.submissions.maximumTopLevel <= 8)
  assert.equal(contract.currentSource.usesMocks, false)
  assert.equal(contract.currentSource.managesWebServer, false)
  assert.equal(contract.currentSource.managesSidecar, false)
  assert.equal(
    contract.fixtures.writing.path,
    '/Users/guoyanjun/work/hexclaw-docs/test/k12-test-作文.png',
  )
  assert.equal(
    contract.fixtures.homework.path,
    '/Users/guoyanjun/work/hexclaw-docs/test/k12-test-批改作业.png',
  )
  assert.deepEqual(contract.fixtures.problem, {
    env: 'HEX_K12_PROBLEM_IMAGE',
    path: '/Users/guoyanjun/work/hexclaw-docs/test/k12-test-解题.JPG',
    sha256: '76c3bbab79486619d680114b8c182c0e23d15ce305239dc762819a5f0407eed7',
    bytes: 204498,
    width: 936,
    height: 1280,
  })
  assert.deepEqual(contract.fixtures.art, {
    env: 'HEX_K12_ART_IMAGE',
    path: '/Users/guoyanjun/work/hexclaw-docs/test/k12-test-美术.png',
    sha256: '7eb16fdbe398236cdf2ce31ea6d2fac5e4787ea3004b96ab74a3eebd540f1d93',
    bytes: 2713090,
    width: 1254,
    height: 1254,
  })
  assert.ok(contract.forbiddenRequestPathPrefixes.length > 0)
})

test('dedicated config, runner and package scripts exist without a managed server', async () => {
  assert.equal(existsSync(repoFile('playwright.k12.current-bug-live.config.ts')), true)
  const config = await readFile(repoFile('playwright.k12.current-bug-live.config.ts'), 'utf8')
  const runner = await readFile(repoFile('scripts/ci/k12-current-bug-live-gate.mjs'), 'utf8')
  const pkg = JSON.parse(await readFile(repoFile('package.json'), 'utf8'))
  assert.doesNotMatch(config, /\bwebServer\s*:/)
  assert.match(config, /workers:\s*1/)
  assert.match(config, /retries:\s*0/)
  assert.match(config, /trace:\s*['"]off['"]/)
  assert.match(runner, /DINGTALK_LIVE_SEND:\s*['"]0['"]/)
  assert.match(runner, /runFixtureLifecycle/)
  assert.match(runner, /k12-current-bug-fixture-orchestrator/)
  assert.equal(
    pkg.scripts['test:e2e:k12-current-bug-live'],
    'node ./scripts/ci/k12-current-bug-live-gate.mjs',
  )
  assert.equal(
    pkg.scripts['test:e2e:k12-current-bug-live:strict'],
    'node ./scripts/ci/k12-current-bug-live-gate.mjs --strict',
  )
})

test('strict environment requires exact provider/model and explicit fixture orchestration inputs', async () => {
  const { strictEnvironmentBlockers } = await loadRunner()
  const contract = JSON.parse(
    await readFile(repoFile('tests/live/k12-current-bug-real-matrix.contract.json'), 'utf8'),
  )
  const env = {
    ...contract.requiredStrictEnvironment,
    ...Object.fromEntries(contract.requiredStrictValues.map((name) => [name, `value-${name}`])),
  }
  assert.deepEqual(strictEnvironmentBlockers(env), [])
  assert.match(
    strictEnvironmentBlockers({ ...env, HEX_K12_LIVE_EXPECTED_PROVIDER_DISPLAY: 'hexclaw-gpt' }).join(
      ',',
    ),
    /HexClaw-GPT/,
  )
  assert.equal(
    strictEnvironmentBlockers({
      ...env,
      HEX_K12_LIVE_RETRYABLE_DISPATCH_ID: '',
      HEX_K12_LIVE_OUTCOME_UNKNOWN_DISPATCH_ID: '',
    }).length,
    0,
  )
  assert.match(
    strictEnvironmentBlockers({ ...env, HEXCLAW_LOCAL_SRC: '' }).join(','),
    /HEXCLAW_LOCAL_SRC/,
  )
})

test('report audit rejects skips, incomplete runs, wrong browser and exact-set drift', async () => {
  const { auditCurrentBugLiveReport } = await loadRunner()
  assert.deepEqual(auditCurrentBugLiveReport(passingReport()), {
    total: 3,
    file: specFile,
    project: 'chromium',
  })
  for (const mutate of [
    (report) => {
      report.suites[0].specs[0].tests[0].expectedStatus = 'skipped'
      report.suites[0].specs[0].tests[0].results = [{ status: 'skipped' }]
    },
    (report) => {
      report.suites[0].specs[0].tests[0].results = []
    },
    (report) => {
      report.suites[0].specs[0].tests[0].projectName = 'webkit'
    },
    (report) => {
      report.suites[0].specs.pop()
    },
  ]) {
    const report = passingReport()
    mutate(report)
    assert.throws(() => auditCurrentBugLiveReport(report))
  }
})

test('strict runner rejects filters and cannot hide Playwright or audit failures', async () => {
  const {
    currentBugLiveExitCode,
    normalizeCurrentBugLiveArguments,
    validateCurrentBugLiveArguments,
  } = await loadRunner()
  assert.deepEqual(normalizeCurrentBugLiveArguments(['--strict', '--']), {
    strict: true,
    playwrightArgs: [],
  })
  assert.throws(
    () => validateCurrentBugLiveArguments({ strict: true, playwrightArgs: ['--grep', 'matrix'] }),
    /does not accept Playwright filters/,
  )
  assert.equal(currentBugLiveExitCode({ playwrightStatus: 2, strict: true, auditPassed: true }), 2)
  assert.equal(currentBugLiveExitCode({ playwrightStatus: 0, strict: true, auditPassed: false }), 1)
  assert.equal(currentBugLiveExitCode({ playwrightStatus: 0, strict: true, auditPassed: true }), 0)
})
