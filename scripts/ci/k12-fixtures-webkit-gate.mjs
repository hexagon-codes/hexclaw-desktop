#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  auditK12FixturesReport,
  gateExitCode,
  normalizeGateArguments,
  validateGateArguments,
} from './k12-fixtures-gate.mjs'

const scriptPath = fileURLToPath(import.meta.url)
const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const reportPath = 'test-results/k12-fixtures-webkit/report.json'
const absoluteReportPath = resolve(repoRoot, reportPath)

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
    [
      'exec',
      'playwright',
      'test',
      '-c',
      'playwright.k12.fixtures.webkit.config.ts',
      ...playwrightArgs,
    ],
    {
      cwd: repoRoot,
      env: process.env,
      stdio: 'inherit',
    },
  )

  const playwrightStatus = playwright.error ? 1 : playwright.status
  if (playwright.error) {
    process.stderr.write(
      `K12 Fixture WebKit gate: could not start Playwright: ${playwright.error.message}\n`,
    )
  }

  let auditPassed = false
  if (strict && playwrightStatus === 0) {
    try {
      const report = JSON.parse(await readFile(absoluteReportPath, 'utf8'))
      const audit = auditK12FixturesReport(report, { expectedProject: 'webkit' })
      auditPassed = true
      process.stdout.write(
        `K12 Fixture WebKit strict gate: ${audit.total} executed result(s), 7/7 files, zero skipped\n`,
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
