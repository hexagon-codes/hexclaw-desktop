#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const contractPath = fileURLToPath(
  new URL('../../tests/e2e/k12-fixtures-gate.contract.json', import.meta.url),
)
const contract = JSON.parse(readFileSync(contractPath, 'utf8'))

export const K12_FIXTURE_REPORT_PATH = contract.reportPath
export const K12_FIXTURE_SPEC_FILES = Object.freeze(contract.specs.map(({ file }) => file))

const absoluteReportPath = resolve(repoRoot, K12_FIXTURE_REPORT_PATH)

function collectSpecs(suites, target = []) {
  for (const suite of suites ?? []) {
    target.push(...(suite.specs ?? []))
    collectSpecs(suite.suites, target)
  }
  return target
}

function sortedLikeContract(files) {
  const order = new Map(K12_FIXTURE_SPEC_FILES.map((file, index) => [file, index]))
  return [...files].sort((left, right) => {
    const leftOrder = order.get(left) ?? Number.MAX_SAFE_INTEGER
    const rightOrder = order.get(right) ?? Number.MAX_SAFE_INTEGER
    return leftOrder - rightOrder || left.localeCompare(right)
  })
}

export function auditK12FixturesReport(report, { expectedProject } = {}) {
  if (!report || typeof report !== 'object') {
    throw new Error('K12 Fixture strict gate: report is not an object')
  }
  if (Array.isArray(report.errors) && report.errors.length > 0) {
    throw new Error(
      `K12 Fixture strict gate: report contains ${report.errors.length} top-level error(s)`,
    )
  }

  const specs = collectSpecs(report.suites)
  const collectedTestCount = specs.reduce(
    (count, spec) => count + (Array.isArray(spec.tests) ? spec.tests.length : 0),
    0,
  )
  if (collectedTestCount === 0) {
    throw new Error('K12 Fixture strict gate: zero tests collected')
  }
  const actualFiles = new Set(specs.map(({ file }) => basename(String(file ?? ''))).filter(Boolean))
  const expectedFiles = new Set(K12_FIXTURE_SPEC_FILES)
  const missing = K12_FIXTURE_SPEC_FILES.filter((file) => !actualFiles.has(file))
  const unexpected = [...actualFiles].filter((file) => !expectedFiles.has(file)).sort()

  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `K12 Fixture strict gate: Fixture spec exact-set mismatch; missing=[${missing.join(', ')}], unexpected=[${unexpected.join(', ')}]`,
    )
  }

  let total = 0
  const skipped = []
  const incomplete = []
  const nonPassing = []
  const wrongProject = []

  for (const spec of specs) {
    for (const test of spec.tests ?? []) {
      total += 1
      const label = `${basename(String(spec.file ?? 'unknown'))}: ${spec.title ?? test.title ?? 'unnamed test'}`
      const results = Array.isArray(test.results) ? test.results : []

      if (expectedProject && test.projectName !== expectedProject) {
        wrongProject.push(`${label} (${String(test.projectName ?? '<missing>')})`)
      }

      if (test.expectedStatus === 'skipped' || results.some(({ status }) => status === 'skipped')) {
        skipped.push(label)
        continue
      }
      if (results.length === 0) {
        incomplete.push(label)
        continue
      }
      if (test.expectedStatus !== 'passed' || results.some(({ status }) => status !== 'passed')) {
        nonPassing.push(label)
      }
    }
  }

  if (total === 0) {
    throw new Error('K12 Fixture strict gate: zero tests collected')
  }
  if (wrongProject.length > 0) {
    throw new Error(
      `K12 Fixture strict gate: ${wrongProject.length} result(s) did not run in ${expectedProject}\n - ${wrongProject.join('\n - ')}`,
    )
  }
  if (skipped.length > 0) {
    throw new Error(
      `K12 Fixture strict gate: ${skipped.length} skipped result(s); skipped is not PASS\n - ${skipped.join('\n - ')}`,
    )
  }
  if (incomplete.length > 0) {
    throw new Error(
      `K12 Fixture strict gate: ${incomplete.length} test(s) have no completed result\n - ${incomplete.join('\n - ')}`,
    )
  }
  if (nonPassing.length > 0) {
    throw new Error(
      `K12 Fixture strict gate: ${nonPassing.length} non-passing result(s)\n - ${nonPassing.join('\n - ')}`,
    )
  }

  return {
    total,
    files: sortedLikeContract(actualFiles),
  }
}

export function gateExitCode({ playwrightStatus, strict, auditPassed }) {
  if (!Number.isInteger(playwrightStatus) || playwrightStatus < 0) return 1
  if (playwrightStatus !== 0) return playwrightStatus
  if (strict && !auditPassed) return 1
  return 0
}

export function normalizeGateArguments(argv) {
  const playwrightArgs = [...argv]
  const strict = playwrightArgs[0] === '--strict'
  if (strict) playwrightArgs.shift()
  if (playwrightArgs[0] === '--') playwrightArgs.shift()
  return { strict, playwrightArgs }
}

export function validateGateArguments({ strict, playwrightArgs }) {
  if (strict && playwrightArgs.length > 0) {
    throw new Error(
      'K12 Fixture strict gate does not accept Playwright filters or overrides; run the frozen seven-file exact set',
    )
  }
}

async function runGate(argv) {
  const { strict, playwrightArgs } = normalizeGateArguments(argv)
  try {
    validateGateArguments({ strict, playwrightArgs })
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 2
    return
  }

  await rm(absoluteReportPath, { force: true })

  const playwright = spawnSync(
    'pnpm',
    ['exec', 'playwright', 'test', '-c', 'playwright.k12.fixtures.config.ts', ...playwrightArgs],
    {
      cwd: repoRoot,
      env: process.env,
      stdio: 'inherit',
    },
  )

  const playwrightStatus = playwright.error ? 1 : playwright.status
  if (playwright.error) {
    process.stderr.write(
      `K12 Fixture gate: could not start Playwright: ${playwright.error.message}\n`,
    )
  }

  let auditPassed = false
  if (strict && playwrightStatus === 0) {
    try {
      const report = JSON.parse(await readFile(absoluteReportPath, 'utf8'))
      const audit = auditK12FixturesReport(report, { expectedProject: 'chromium' })
      auditPassed = true
      process.stdout.write(
        `K12 Fixture strict gate: ${audit.total} executed result(s), 7/7 files, zero skipped\n`,
      )
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    }
  }

  process.exitCode = gateExitCode({ playwrightStatus, strict, auditPassed })
}

if (resolve(process.argv[1] ?? '') === resolve(scriptPath)) {
  await runGate(process.argv.slice(2))
}
