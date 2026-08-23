#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { basename, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const contractPath = fileURLToPath(
  new URL('../../tests/e2e/k12-fixtures-gate.contract.json', import.meta.url),
)
const contract = JSON.parse(readFileSync(contractPath, 'utf8'))

export const K12_FIXTURE_REPORT_PATH = contract.reportPath
export const K12_FIXTURE_SPEC_FILES = Object.freeze(contract.specs.map(({ file }) => file))
export const K12_FIXTURE_TEST_MEMBERS = Object.freeze(
  contract.specs.flatMap(({ file, tests }) => tests.map((title) => `${file} › ${title}`)),
)

const absoluteReportPath = resolve(repoRoot, K12_FIXTURE_REPORT_PATH)
const real10xCycleScenarios = Object.freeze({
  C03: Object.freeze({
    file: 'grading-real-fixtures.spec.ts',
    title: 'messy sheet keeps the 12/3/1 oracle and never turns unanswered into a red cross',
  }),
  C04: Object.freeze({
    file: 'grading-real-fixtures.spec.ts',
    title: 'blank sheet stays solve-only and does not create a mistake projection',
  }),
  C07: Object.freeze({
    file: 'grounding-pdf.spec.ts',
    title: 'C07 accepts the frozen 131-page textbook once and persists its private lineage',
    requiresKnowledgeLineage: true,
  }),
  C08: Object.freeze({
    file: 'grounding-pdf.spec.ts',
    title: 'C08 indexes exactly the C07 textbook lineage and persists active revision',
    requiresKnowledgeLineage: true,
  }),
  C09: Object.freeze({
    file: 'grounding-pdf.spec.ts',
    title: 'C09 retrieves the C08 textbook lineage through the frozen oracle',
    requiresKnowledgeLineage: true,
  }),
})

function real10xScenario(cycle) {
  return real10xCycleScenarios[cycle]
}

export function real10xScenarioGrep(cycle) {
  const scenario = real10xScenario(cycle)
  if (!scenario) return undefined
  return `.*${scenario.title.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}$`
}

function isFileSuite(suite) {
  const title = String(suite?.title ?? '').trim()
  const file = String(suite?.file ?? '').trim()
  return Boolean(
    title &&
    (title === file || title.endsWith('.spec.ts') || (file && basename(title) === basename(file))),
  )
}

function collectSpecs(suites, target = [], suitePath = []) {
  for (const suite of suites ?? []) {
    const title = String(suite?.title ?? '').trim()
    const nextSuitePath = title && !isFileSuite(suite) ? [...suitePath, title] : suitePath
    for (const spec of suite.specs ?? []) {
      target.push({ ...spec, __suitePath: nextSuitePath })
    }
    collectSpecs(suite.suites, target, nextSuitePath)
  }
  return target
}

function reportTestMember(spec) {
  const file = basename(String(spec.file ?? ''))
  const titlePath = [
    ...(Array.isArray(spec.__suitePath) ? spec.__suitePath : []),
    String(spec.title ?? '').trim(),
  ].filter(Boolean)
  return `${file} › ${titlePath.join(' › ')}`
}

function sortedLikeContract(files) {
  const order = new Map(K12_FIXTURE_SPEC_FILES.map((file, index) => [file, index]))
  return [...files].sort((left, right) => {
    const leftOrder = order.get(left) ?? Number.MAX_SAFE_INTEGER
    const rightOrder = order.get(right) ?? Number.MAX_SAFE_INTEGER
    return leftOrder - rightOrder || left.localeCompare(right)
  })
}

export function auditK12FixturesReport(report, { expectedProject, cycle } = {}) {
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
  const scenario = cycle === undefined ? undefined : real10xScenario(cycle)
  if (cycle !== undefined && !scenario) {
    throw new Error(`K12 Fixture strict gate: unsupported real-10x cycle ${cycle}`)
  }
  const actualFiles = new Set(specs.map(({ file }) => basename(String(file ?? ''))).filter(Boolean))
  const expectedFiles = new Set(scenario ? [scenario.file] : K12_FIXTURE_SPEC_FILES)
  const missing = [...expectedFiles].filter((file) => !actualFiles.has(file))
  const unexpected = [...actualFiles].filter((file) => !expectedFiles.has(file)).sort()

  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `K12 Fixture strict gate: Fixture spec exact-set mismatch; missing=[${missing.join(', ')}], unexpected=[${unexpected.join(', ')}]`,
    )
  }

  if (!scenario) {
    const expectedMembers = new Set(K12_FIXTURE_TEST_MEMBERS)
    const actualMembers = specs.map(reportTestMember)
    const actualMemberSet = new Set(actualMembers)
    const missingMembers = K12_FIXTURE_TEST_MEMBERS.filter((member) => !actualMemberSet.has(member))
    const unexpectedMembers = actualMembers.filter((member) => !expectedMembers.has(member))
    const duplicateMembers = actualMembers.filter(
      (member, index) => actualMembers.indexOf(member) !== index,
    )
    if (missingMembers.length > 0 || unexpectedMembers.length > 0 || duplicateMembers.length > 0) {
      throw new Error(
        `K12 Fixture strict gate: canonical test member exact-set mismatch; missing=[${missingMembers.join(', ')}], unexpected=[${unexpectedMembers.join(', ')}], duplicate=[${[...new Set(duplicateMembers)].join(', ')}]`,
      )
    }
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
      if (scenario && spec.title !== scenario.title) {
        nonPassing.push(`${label} (unexpected real-10x scenario)`)
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

  if (scenario && total !== 1) {
    throw new Error(`K12 Fixture strict gate: ${cycle} expected 1 completed result, got ${total}`)
  }

  return { total, files: sortedLikeContract(actualFiles), ...(scenario ? { cycle } : {}) }
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
  let cycle
  if (strict && playwrightArgs[0] === '--cycle') {
    cycle = playwrightArgs[1]
    playwrightArgs.splice(0, 2)
  }
  return { strict, ...(cycle === undefined ? {} : { cycle }), playwrightArgs }
}

export function validateGateArguments({ strict, cycle, playwrightArgs }, env = process.env) {
  if (strict && playwrightArgs.length > 0) {
    throw new Error(
      'K12 Fixture strict gate does not accept Playwright filters or overrides; run the frozen seven-file exact set',
    )
  }
  if (cycle === undefined) return
  if (!strict || typeof cycle !== 'string' || !real10xScenario(cycle)) {
    throw new Error('K12 Fixture strict gate accepts only a supported parent-injected cycle')
  }
  if (
    env.HEX_K12_REAL_10X_CYCLE_ID !== cycle ||
    env.HEX_K12_REAL_10X_PARENT_OWNS_LIFECYCLE !== '1'
  ) {
    throw new Error('K12 Fixture strict gate cycle must match the parent-injected cycle')
  }
  const scenario = real10xScenario(cycle)
  if (scenario.requiresKnowledgeLineage) {
    const lineagePath = env.HEX_K12_REAL_10X_KNOWLEDGE_LINEAGE_PATH ?? ''
    const parentRunID = env.HEX_K12_REAL_10X_PARENT_RUN_ID ?? ''
    if (!lineagePath.trim() || !isAbsolute(lineagePath)) {
      throw new Error(
        'K12 Fixture strict gate knowledge lineage path must be parent-injected and absolute',
      )
    }
    if (!parentRunID.trim()) {
      throw new Error('K12 Fixture strict gate knowledge parent run ID must be parent-injected')
    }
  }
}

export async function runGate(
  argv,
  {
    env = process.env,
    processLike = process,
    spawnPlaywright = spawnSync,
    removeReport = rm,
    readReport = readFile,
  } = {},
) {
  const { strict, cycle, playwrightArgs } = normalizeGateArguments(argv)
  try {
    validateGateArguments({ strict, cycle, playwrightArgs }, env)
  } catch (error) {
    processLike.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    processLike.exitCode = 2
    return
  }

  await removeReport(absoluteReportPath, { force: true })
  const scenario = cycle === undefined ? undefined : real10xScenario(cycle)
  const cycleArgs = scenario ? ['--grep', real10xScenarioGrep(cycle)] : []

  const playwright = spawnPlaywright(
    'pnpm',
    [
      'exec',
      'playwright',
      'test',
      '-c',
      'playwright.k12.fixtures.config.ts',
      ...cycleArgs,
      ...playwrightArgs,
    ],
    {
      cwd: repoRoot,
      env: { ...env, DINGTALK_LIVE_SEND: '0' },
      stdio: 'inherit',
    },
  )

  const playwrightStatus = playwright.error ? 1 : playwright.status
  if (playwright.error) {
    processLike.stderr.write(
      `K12 Fixture gate: could not start Playwright: ${playwright.error.message}\n`,
    )
  }

  let auditPassed = false
  if (strict && playwrightStatus === 0) {
    try {
      const report = JSON.parse(await readReport(absoluteReportPath, 'utf8'))
      const audit = auditK12FixturesReport(report, { expectedProject: 'chromium', cycle })
      auditPassed = true
      processLike.stdout.write(
        cycle
          ? `K12 Fixture strict gate: ${cycle} ${audit.total}/1 executed result, zero skipped\n`
          : `K12 Fixture strict gate: ${audit.total} executed result(s), 7/7 files, zero skipped\n`,
      )
    } catch (error) {
      processLike.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    }
  }

  processLike.exitCode = gateExitCode({ playwrightStatus, strict, auditPassed })
}

if (resolve(process.argv[1] ?? '') === resolve(scriptPath)) {
  await runGate(process.argv.slice(2))
}
