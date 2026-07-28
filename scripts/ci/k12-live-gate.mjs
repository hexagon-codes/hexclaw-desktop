#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))

export const K12_LIVE_REPORT_PATH = 'test-results/k12-live/report.json'
export const K12_LIVE_SPEC_FILES = Object.freeze([
  'k12-learning-records.spec.ts',
  'k12-chat-markdown-latex.spec.ts',
  'k12-dingtalk-markdown-latex.spec.ts',
  'learning-records-all-controls.spec.ts',
  'photo-degradation-matrix.spec.ts',
  'knowledge-real-pdf-lifecycle.spec.ts',
  'skill-lifecycle-recall.spec.ts',
  'workflow-trigger-rotation.spec.ts',
])
export const K12_LIVE_PROJECTS = Object.freeze(['chromium', 'webkit'])

export function describeLiveSpecSet(specFiles = K12_LIVE_SPEC_FILES) {
  const count = specFiles.length
  return {
    count,
    fileLabel: `${count}-file`,
    progressLabel: `${count}/${count} files`,
  }
}

const absoluteReportPath = resolve(repoRoot, K12_LIVE_REPORT_PATH)

function collectSpecs(suites, target = []) {
  for (const suite of suites ?? []) {
    target.push(...(suite.specs ?? []))
    collectSpecs(suite.suites, target)
  }
  return target
}

export function auditK12LiveReport(report) {
  if (!report || typeof report !== 'object') {
    throw new Error('K12 LIVE strict gate: report is not an object')
  }
  if (Array.isArray(report.errors) && report.errors.length > 0) {
    throw new Error(
      `K12 LIVE strict gate: report contains ${report.errors.length} top-level error(s)`,
    )
  }

  const specs = collectSpecs(report.suites)
  const actualFiles = new Set(specs.map(({ file }) => basename(String(file ?? ''))).filter(Boolean))
  const expectedFiles = new Set(K12_LIVE_SPEC_FILES)
  const missing = K12_LIVE_SPEC_FILES.filter((file) => !actualFiles.has(file))
  const unexpected = [...actualFiles].filter((file) => !expectedFiles.has(file)).sort()
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `K12 LIVE strict gate: spec exact-set mismatch; missing=[${missing.join(', ')}], unexpected=[${unexpected.join(', ')}]`,
    )
  }

  let total = 0
  const skipped = []
  const incomplete = []
  const nonPassing = []
  const projectsByFile = new Map(K12_LIVE_SPEC_FILES.map((file) => [file, new Set()]))

  for (const spec of specs) {
    const file = basename(String(spec.file ?? ''))
    for (const test of spec.tests ?? []) {
      total += 1
      const project = String(test.projectName ?? '')
      projectsByFile.get(file)?.add(project)
      const label = `${file || 'unknown'} [${project || 'missing-project'}]: ${spec.title ?? test.title ?? 'unnamed test'}`
      const results = Array.isArray(test.results) ? test.results : []

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

  if (total === 0) throw new Error('K12 LIVE strict gate: zero tests collected')

  const expectedProjectKey = [...K12_LIVE_PROJECTS].sort().join(',')
  const projectDrift = []
  for (const file of K12_LIVE_SPEC_FILES) {
    const actual = [...(projectsByFile.get(file) ?? [])].filter(Boolean).sort()
    if (actual.join(',') !== expectedProjectKey) {
      projectDrift.push(`${file}: [${actual.join(', ')}]`)
    }
  }
  if (projectDrift.length > 0) {
    throw new Error(
      `K12 LIVE strict gate: project matrix mismatch\n - ${projectDrift.join('\n - ')}`,
    )
  }
  if (skipped.length > 0) {
    throw new Error(
      `K12 LIVE strict gate: ${skipped.length} skipped result(s); skipped is not PASS\n - ${skipped.join('\n - ')}`,
    )
  }
  if (incomplete.length > 0) {
    throw new Error(
      `K12 LIVE strict gate: ${incomplete.length} test(s) have no completed result\n - ${incomplete.join('\n - ')}`,
    )
  }
  if (nonPassing.length > 0) {
    throw new Error(
      `K12 LIVE strict gate: ${nonPassing.length} non-passing result(s)\n - ${nonPassing.join('\n - ')}`,
    )
  }

  return {
    total,
    files: [...K12_LIVE_SPEC_FILES],
    projects: [...K12_LIVE_PROJECTS],
  }
}

export function liveGateExitCode({ playwrightStatus, strict, auditPassed }) {
  if (!Number.isInteger(playwrightStatus) || playwrightStatus < 0) return 1
  if (playwrightStatus !== 0) return playwrightStatus
  if (strict && !auditPassed) return 1
  return 0
}

export function normalizeLiveGateArguments(argv) {
  const playwrightArgs = [...argv]
  const strict = playwrightArgs[0] === '--strict'
  if (strict) playwrightArgs.shift()
  if (playwrightArgs[0] === '--') playwrightArgs.shift()
  return { strict, playwrightArgs }
}

export function validateLiveGateArguments({ strict, playwrightArgs }) {
  if (strict && playwrightArgs.length > 0) {
    const { fileLabel } = describeLiveSpecSet()
    throw new Error(
      `K12 LIVE strict gate does not accept Playwright filters or overrides; run the frozen ${fileLabel} two-browser exact set`,
    )
  }
}

async function runGate(argv) {
  const { strict, playwrightArgs } = normalizeLiveGateArguments(argv)
  try {
    validateLiveGateArguments({ strict, playwrightArgs })
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 2
    return
  }

  await rm(absoluteReportPath, { force: true })
  const playwright = spawnSync(
    'pnpm',
    ['exec', 'playwright', 'test', '-c', 'playwright.k12.live.config.ts', ...playwrightArgs],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...(strict ? { HEX_K12_LIVE_REQUIRED: '1' } : {}),
      },
      stdio: 'inherit',
    },
  )

  const playwrightStatus = playwright.error ? 1 : playwright.status
  if (playwright.error) {
    process.stderr.write(`K12 LIVE gate: could not start Playwright: ${playwright.error.message}\n`)
  }

  let auditPassed = false
  if (strict && playwrightStatus === 0) {
    try {
      const report = JSON.parse(await readFile(absoluteReportPath, 'utf8'))
      const audit = auditK12LiveReport(report)
      auditPassed = true
      const { progressLabel } = describeLiveSpecSet()
      process.stdout.write(
        `K12 LIVE strict gate: ${audit.total} executed result(s), ${progressLabel}, Chromium+WebKit, zero skipped\n`,
      )
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    }
  }

  process.exitCode = liveGateExitCode({ playwrightStatus, strict, auditPassed })
}

if (resolve(process.argv[1] ?? '') === resolve(scriptPath)) {
  await runGate(process.argv.slice(2))
}
