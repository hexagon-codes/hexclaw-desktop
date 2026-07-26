#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const contract = JSON.parse(
  readFileSync(
    new URL('../../tests/live/k12-current-bug-real-matrix.contract.json', import.meta.url),
    'utf8',
  ),
)
const absoluteReportPath = resolve(repoRoot, contract.reportPath)

function collectSpecs(suites, target = []) {
  for (const suite of suites ?? []) {
    target.push(...(suite.specs ?? []))
    collectSpecs(suite.suites, target)
  }
  return target
}

export function auditCurrentBugLiveReport(report) {
  if (!report || typeof report !== 'object') {
    throw new Error('K12 current-bug LIVE strict gate: report is not an object')
  }
  if (Array.isArray(report.errors) && report.errors.length > 0) {
    throw new Error('K12 current-bug LIVE strict gate: report has top-level errors')
  }
  const specs = collectSpecs(report.suites)
  const files = new Set(specs.map(({ file }) => basename(String(file ?? ''))).filter(Boolean))
  if (files.size !== 1 || !files.has(contract.specFile)) {
    throw new Error('K12 current-bug LIVE strict gate: spec exact-set mismatch')
  }
  let total = 0
  const invalid = []
  for (const spec of specs) {
    for (const test of spec.tests ?? []) {
      total += 1
      const results = Array.isArray(test.results) ? test.results : []
      if (
        test.projectName !== contract.project ||
        test.expectedStatus !== 'passed' ||
        results.length === 0 ||
        results.some(({ status }) => status !== 'passed')
      ) {
        invalid.push(`${spec.title ?? test.title ?? 'unnamed'} [${test.projectName ?? 'no-project'}]`)
      }
    }
  }
  if (total !== 3) {
    throw new Error(`K12 current-bug LIVE strict gate: expected 3 executed tests, got ${total}`)
  }
  if (invalid.length > 0) {
    throw new Error(
      `K12 current-bug LIVE strict gate: skipped/incomplete/non-passing results\n - ${invalid.join('\n - ')}`,
    )
  }
  return { total, file: contract.specFile, project: contract.project }
}

export function normalizeCurrentBugLiveArguments(argv) {
  const playwrightArgs = [...argv]
  const strict = playwrightArgs[0] === '--strict'
  if (strict) playwrightArgs.shift()
  if (playwrightArgs[0] === '--') playwrightArgs.shift()
  return { strict, playwrightArgs }
}

export function validateCurrentBugLiveArguments({ strict, playwrightArgs }) {
  if (strict && playwrightArgs.length > 0) {
    throw new Error('K12 current-bug LIVE strict gate does not accept Playwright filters')
  }
}

export function strictEnvironmentBlockers(env) {
  const blockers = []
  for (const [name, expected] of Object.entries(contract.requiredStrictEnvironment)) {
    if ((env[name] ?? '').trim() !== expected) blockers.push(`${name}=${expected}`)
  }
  for (const name of contract.requiredStrictValues) {
    if (!(env[name] ?? '').trim()) blockers.push(name)
  }
  return blockers
}

export function currentBugLiveExitCode({ playwrightStatus, strict, auditPassed }) {
  if (!Number.isInteger(playwrightStatus) || playwrightStatus < 0) return 1
  if (playwrightStatus !== 0) return playwrightStatus
  if (strict && !auditPassed) return 1
  return 0
}

async function runGate(argv) {
  const { strict, playwrightArgs } = normalizeCurrentBugLiveArguments(argv)
  try {
    validateCurrentBugLiveArguments({ strict, playwrightArgs })
    if (strict) {
      const blockers = strictEnvironmentBlockers(process.env)
      if (blockers.length > 0) {
        throw new Error(
          `K12 current-bug LIVE strict gate missing exact authorization: ${blockers.join(', ')}`,
        )
      }
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 2
    return
  }

  await rm(absoluteReportPath, { force: true })
  const playwright = spawnSync(
    'pnpm',
    [
      'exec',
      'playwright',
      'test',
      '-c',
      'playwright.k12.current-bug-live.config.ts',
      ...playwrightArgs,
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        DINGTALK_LIVE_SEND: '0',
        ...(strict ? { HEX_K12_CURRENT_BUG_LIVE_REQUIRED: '1' } : {}),
      },
      stdio: 'inherit',
    },
  )
  const playwrightStatus = playwright.error ? 1 : playwright.status
  if (playwright.error) {
    process.stderr.write(`K12 current-bug LIVE gate could not start Playwright: ${playwright.error.message}\n`)
  }

  let auditPassed = false
  if (strict && playwrightStatus === 0) {
    try {
      const report = JSON.parse(await readFile(absoluteReportPath, 'utf8'))
      const audit = auditCurrentBugLiveReport(report)
      auditPassed = true
      process.stdout.write(
        `K12 current-bug LIVE strict gate: ${audit.total}/3 executed, zero skipped, provider/model and four-submission matrix passed\n`,
      )
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    }
  }
  process.exitCode = currentBugLiveExitCode({ playwrightStatus, strict, auditPassed })
}

if (resolve(process.argv[1] ?? '') === resolve(scriptPath)) {
  await runGate(process.argv.slice(2))
}
