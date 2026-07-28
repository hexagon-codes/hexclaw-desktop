#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createFixtureRuntime,
  installFixtureSignalCleanup,
  runFixtureLifecycle,
  validateFixtureEnvironment,
} from './k12-current-bug-fixture-orchestrator.mjs'

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

const playwrightCommand = [
  'exec',
  'playwright',
  'test',
  '-c',
  'playwright.k12.current-bug-live.config.ts',
]

let activeStrictPlaywright

function redactedWriter(stream, target, secrets) {
  let pending = ''
  const redact = (value) => secrets.reduce(
    (result, secret) => result.split(secret).join('[opaque fixture id]'),
    value,
  )
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    pending += chunk
    let newline
    while ((newline = pending.indexOf('\n')) >= 0) {
      target.write(redact(pending.slice(0, newline + 1)))
      pending = pending.slice(newline + 1)
    }
  })
  return () => {
    if (pending) target.write(redact(pending))
    pending = ''
  }
}

function runStrictPlaywright(playwrightArgs, fixtureEnvironment) {
  const secrets = Object.values(fixtureEnvironment)
  return new Promise((resolvePromise) => {
    const child = spawn(
      'pnpm',
      [...playwrightCommand, ...playwrightArgs],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          DINGTALK_LIVE_SEND: '0',
          HEX_K12_CURRENT_BUG_LIVE_REQUIRED: '1',
          ...fixtureEnvironment,
        },
        shell: false,
        stdio: ['inherit', 'pipe', 'pipe'],
      },
    )
    activeStrictPlaywright = child
    const flushStdout = redactedWriter(child.stdout, process.stdout, secrets)
    const flushStderr = redactedWriter(child.stderr, process.stderr, secrets)
    let startError
    child.once('error', (error) => {
      startError = error
    })
    child.once('close', (code) => {
      if (activeStrictPlaywright === child) activeStrictPlaywright = undefined
      flushStdout()
      flushStderr()
      resolvePromise({
        error: startError,
        status: startError ? 1 : (Number.isInteger(code) ? code : 1),
      })
    })
  })
}

async function cancelStrictPlaywright() {
  const child = activeStrictPlaywright
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  await new Promise((resolvePromise) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise()
    }
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }, 2_000)
    child.once('close', finish)
    if (!child.kill('SIGTERM')) finish()
  })
}

async function runStrictPlaywrightGate(playwrightArgs, fixtureEnvironment) {
  await rm(absoluteReportPath, { force: true })
  const playwright = await runStrictPlaywright(playwrightArgs, fixtureEnvironment)
  if (playwright.error) {
    process.stderr.write(`K12 current-bug LIVE gate could not start Playwright: ${playwright.error.message}\n`)
  }

  let auditPassed = false
  if (playwright.status === 0) {
    try {
      const report = JSON.parse(await readFile(absoluteReportPath, 'utf8'))
      const audit = auditCurrentBugLiveReport(report)
      auditPassed = true
      process.stdout.write(
        `K12 current-bug LIVE strict gate: ${audit.total}/3 executed, zero skipped, provider/model and six-submission matrix passed\n`,
      )
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    }
  }
  return { playwrightStatus: playwright.status, auditPassed }
}

async function runGate(argv) {
  const { strict, playwrightArgs } = normalizeCurrentBugLiveArguments(argv)
  let fixtureConfig
  try {
    validateCurrentBugLiveArguments({ strict, playwrightArgs })
    if (strict) {
      const blockers = strictEnvironmentBlockers(process.env)
      if (blockers.length > 0) {
        throw new Error(
          `K12 current-bug LIVE strict gate missing exact authorization: ${blockers.join(', ')}`,
        )
      }
      fixtureConfig = validateFixtureEnvironment(process.env)
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 2
    return
  }

  if (!strict) {
    await rm(absoluteReportPath, { force: true })
    const playwright = spawnSync(
      'pnpm',
      [...playwrightCommand, ...playwrightArgs],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          DINGTALK_LIVE_SEND: '0',
        },
        shell: false,
        stdio: 'inherit',
      },
    )
    const playwrightStatus = playwright.error ? 1 : playwright.status
    if (playwright.error) {
      process.stderr.write(`K12 current-bug LIVE gate could not start Playwright: ${playwright.error.message}\n`)
    }
    process.exitCode = currentBugLiveExitCode({
      playwrightStatus,
      strict: false,
      auditPassed: false,
    })
    return
  }

  const runtime = createFixtureRuntime(fixtureConfig)
  let lifecyclePromise
  const uninstallSignalCleanup = installFixtureSignalCleanup(process, {
    cancelActive: async () => {
      await cancelStrictPlaywright()
      await runtime.cancelActive()
    },
    cleanup: () => lifecyclePromise
      ? lifecyclePromise.then(() => undefined, () => undefined)
      : runtime.cleanup(),
  })
  lifecyclePromise = runFixtureLifecycle(fixtureConfig, {
    stopSidecar: runtime.stopSidecar,
    startFixture: runtime.startFixture,
    readManifest: runtime.readManifest,
    startSidecar: runtime.startSidecar,
    runStrictGate: (fixtureEnvironment) => runStrictPlaywrightGate(
      playwrightArgs,
      fixtureEnvironment,
    ),
    cleanupFixture: runtime.cleanupFixture,
  })

  let gateResult
  let lifecycleError
  try {
    gateResult = await lifecyclePromise
  } catch (error) {
    lifecycleError = error
  }
  await uninstallSignalCleanup.wait()
  uninstallSignalCleanup()

  if (process.exitCode === 130 || process.exitCode === 143) return
  if (lifecycleError) {
    process.stderr.write(
      `${lifecycleError instanceof Error ? lifecycleError.message : String(lifecycleError)}\n`,
    )
    process.exitCode = 1
    return
  }
  process.exitCode = currentBugLiveExitCode({ ...gateResult, strict: true })
}

if (resolve(process.argv[1] ?? '') === resolve(scriptPath)) {
  await runGate(process.argv.slice(2))
}
