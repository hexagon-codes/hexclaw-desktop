import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const repoFile = (path) => new URL(`../../${path}`, import.meta.url)

const expectedSpecs = [
  'k12-learning-records.spec.ts',
  'k12-chat-markdown-latex.spec.ts',
  'k12-dingtalk-markdown-latex.spec.ts',
  'learning-records-all-controls.spec.ts',
  'photo-degradation-matrix.spec.ts',
  'knowledge-real-pdf-lifecycle.spec.ts',
  'skill-lifecycle-recall.spec.ts',
  'workflow-trigger-rotation.spec.ts',
  'print-export-real.spec.ts',
]
const expectedProjects = ['chromium', 'webkit']

async function loadGateModule() {
  return import(repoFile('scripts/ci/k12-live-gate.mjs'))
}

function passingReport(specs = expectedSpecs, projects = expectedProjects) {
  return {
    errors: [],
    suites: [
      {
        specs: specs.map((file) => ({
          title: file,
          file: `/workspace/tests/${file}`,
          tests: projects.map((projectName) => ({
            projectName,
            expectedStatus: 'passed',
            results: [{ status: 'passed' }],
          })),
        })),
      },
    ],
  }
}

test('package routes diagnostic and strict LIVE lanes through the guarded runner', async () => {
  const pkg = JSON.parse(await readFile(repoFile('package.json'), 'utf8'))
  assert.equal(pkg.scripts['test:e2e:k12-live'], 'node ./scripts/ci/k12-live-gate.mjs')
  assert.equal(pkg.scripts['test:e2e:k12-live:strict'], 'node ./scripts/ci/k12-live-gate.mjs --strict')
})

test('LIVE runner strips only the pnpm separator and keeps diagnostic Playwright flags', async () => {
  const { normalizeLiveGateArguments, validateLiveGateArguments } = await loadGateModule()

  assert.deepEqual(normalizeLiveGateArguments(['--', '--list']), {
    strict: false,
    playwrightArgs: ['--list'],
  })
  assert.deepEqual(normalizeLiveGateArguments(['--strict', '--']), {
    strict: true,
    playwrightArgs: [],
  })
  assert.doesNotThrow(() =>
    validateLiveGateArguments({ strict: false, playwrightArgs: ['--list'] }),
  )
  assert.throws(
    () => validateLiveGateArguments({ strict: true, playwrightArgs: ['--grep', 'one test'] }),
    /strict gate does not accept playwright filters/i,
  )
})

test('LIVE strict audit accepts only the frozen nine-file two-browser matrix', async () => {
  const { auditK12LiveReport } = await loadGateModule()
  const audit = auditK12LiveReport(passingReport())

  assert.equal(audit.total, expectedSpecs.length * expectedProjects.length)
  assert.deepEqual(audit.files, expectedSpecs)
  assert.deepEqual(audit.projects, expectedProjects)

  assert.throws(
    () => auditK12LiveReport(passingReport(expectedSpecs.slice(0, -1))),
    /spec exact-set mismatch/i,
  )
  assert.throws(
    () => auditK12LiveReport(passingReport([...expectedSpecs, 'unexpected.spec.ts'])),
    /spec exact-set mismatch/i,
  )
  assert.throws(
    () => auditK12LiveReport(passingReport(expectedSpecs, ['chromium'])),
    /project matrix mismatch/i,
  )
})

test('LIVE strict audit rejects skips, incomplete results, failures and top-level errors', async () => {
  const { auditK12LiveReport, liveGateExitCode } = await loadGateModule()

  const skipped = passingReport()
  skipped.suites[0].specs[0].tests[0].results = [{ status: 'skipped' }]
  assert.throws(() => auditK12LiveReport(skipped), /skipped is not pass/i)

  const incomplete = passingReport()
  incomplete.suites[0].specs[0].tests[0].results = []
  assert.throws(() => auditK12LiveReport(incomplete), /no completed result/i)

  const failed = passingReport()
  failed.suites[0].specs[0].tests[0].results = [{ status: 'failed' }]
  assert.throws(() => auditK12LiveReport(failed), /non-passing result/i)

  assert.throws(
    () => auditK12LiveReport({ ...passingReport(), errors: [{ message: 'boom' }] }),
    /top-level error/i,
  )
  assert.equal(liveGateExitCode({ playwrightStatus: 2, strict: true, auditPassed: true }), 2)
  assert.equal(liveGateExitCode({ playwrightStatus: 0, strict: true, auditPassed: false }), 1)
  assert.equal(liveGateExitCode({ playwrightStatus: 0, strict: true, auditPassed: true }), 0)
  assert.equal(liveGateExitCode({ playwrightStatus: 0, strict: false, auditPassed: false }), 0)
})
