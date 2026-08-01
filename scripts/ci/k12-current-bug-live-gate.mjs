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
  validateGradingCalibrationApproval,
  validateFixtureEnvironment,
} from './k12-current-bug-fixture-orchestrator.mjs'
import { parseStrictJSON } from './k12-strict-json.mjs'

const scriptPath = fileURLToPath(import.meta.url)
const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
export function parseCurrentBugLiveContract(raw) {
  return parseStrictJSON(raw, { label: 'K12 current-bug LIVE contract' })
}

const contract = parseCurrentBugLiveContract(
  readFileSync(
    new URL('../../tests/live/k12-current-bug-real-matrix.contract.json', import.meta.url),
    'utf8',
  ),
)
const absoluteReportPath = resolve(repoRoot, contract.reportPath)
const real10xCycleScenarios = Object.freeze({
  C01: Object.freeze({
    title: 'C01 solve image preserves one durable receipt and attachment identity',
  }),
  C02: Object.freeze({
    title: 'C02 clear homework preserves one durable grading result',
  }),
  C05: Object.freeze({
    title: 'C05 writing review preserves one canonical work',
  }),
  C06: Object.freeze({
    title: 'C06 art review preserves one canonical work',
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

function collectSpecs(suites, target = []) {
  for (const suite of suites ?? []) {
    target.push(...(suite.specs ?? []))
    collectSpecs(suite.suites, target)
  }
  return target
}

export function auditCurrentBugLiveReport(report, { cycle } = {}) {
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
  const scenario = cycle === undefined ? undefined : real10xScenario(cycle)
  if (cycle !== undefined && !scenario) {
    throw new Error(`K12 current-bug LIVE strict gate: unsupported real-10x cycle ${cycle}`)
  }
  const expectedTotal = scenario ? 1 : 3
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
        results.some(({ status }) => status !== 'passed') ||
        (scenario && spec.title !== scenario.title)
      ) {
        invalid.push(
          `${spec.title ?? test.title ?? 'unnamed'} [${test.projectName ?? 'no-project'}]`,
        )
      }
    }
  }
  if (total !== expectedTotal) {
    throw new Error(
      `K12 current-bug LIVE strict gate: expected ${expectedTotal} executed test(s), got ${total}`,
    )
  }
  if (invalid.length > 0) {
    throw new Error(
      `K12 current-bug LIVE strict gate: skipped/incomplete/non-passing results\n - ${invalid.join('\n - ')}`,
    )
  }
  return { total, file: contract.specFile, project: contract.project, ...(scenario ? { cycle } : {}) }
}

export function normalizeCurrentBugLiveArguments(argv) {
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

export function validateCurrentBugLiveArguments(
  { strict, cycle, playwrightArgs },
  env = process.env,
) {
  if (strict && playwrightArgs.length > 0) {
    throw new Error('K12 current-bug LIVE strict gate does not accept Playwright filters')
  }
  if (cycle === undefined) return
  if (!strict || typeof cycle !== 'string' || !real10xScenario(cycle)) {
    throw new Error('K12 current-bug LIVE strict gate accepts only a supported parent-injected cycle')
  }
  if (
    env.HEX_K12_REAL_10X_CYCLE_ID !== cycle ||
    env.HEX_K12_REAL_10X_PARENT_OWNS_LIFECYCLE !== '1'
  ) {
    throw new Error('K12 current-bug LIVE strict gate cycle must match the parent-injected cycle')
  }
}

export function strictEnvironmentBlockers(env, contractValue = contract) {
  const blockers = []
  for (const [name, expected] of Object.entries(contractValue.requiredStrictEnvironment)) {
    if ((env[name] ?? '').trim() !== expected) blockers.push(`${name}=${expected}`)
  }
  for (const name of contractValue.requiredStrictValues) {
    if (!(env[name] ?? '').trim()) blockers.push(name)
  }
  try {
    validateGradingCalibrationApproval(contractValue.gradingCalibrationApproval, {
      provider: contractValue.provider?.identity,
      model: contractValue.provider?.model,
    })
  } catch {
    blockers.push('grading calibration approval')
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
  const redact = (value) =>
    secrets.reduce((result, secret) => result.split(secret).join('[opaque fixture id]'), value)
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

function runStrictPlaywright(playwrightArgs, fixtureEnvironment, { cycle } = {}) {
  const secrets = Object.values(fixtureEnvironment)
  const scenario = cycle === undefined ? undefined : real10xScenario(cycle)
  const cycleArgs = scenario ? ['--grep', real10xScenarioGrep(cycle)] : []
  return new Promise((resolvePromise) => {
    const child = spawn('pnpm', [...playwrightCommand, ...cycleArgs, ...playwrightArgs], {
      cwd: repoRoot,
      env: {
        ...process.env,
        DINGTALK_LIVE_SEND: '0',
        HEX_K12_CURRENT_BUG_LIVE_REQUIRED: '1',
        ...fixtureEnvironment,
      },
      shell: false,
      stdio: ['inherit', 'pipe', 'pipe'],
    })
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
        status: startError ? 1 : Number.isInteger(code) ? code : 1,
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

async function runStrictPlaywrightGate(playwrightArgs, fixtureEnvironment, { cycle } = {}) {
  await rm(absoluteReportPath, { force: true })
  const playwright = await runStrictPlaywright(playwrightArgs, fixtureEnvironment, { cycle })
  if (playwright.error) {
    process.stderr.write(
      `K12 current-bug LIVE gate could not start Playwright: ${playwright.error.message}\n`,
    )
  }

  let auditPassed = false
  if (playwright.status === 0) {
    try {
      const report = JSON.parse(await readFile(absoluteReportPath, 'utf8'))
      const audit = auditCurrentBugLiveReport(report, { cycle })
      auditPassed = true
      process.stdout.write(
        cycle
          ? `K12 current-bug LIVE strict gate: ${cycle} ${audit.total}/1 executed, zero skipped\n`
          : `K12 current-bug LIVE strict gate: ${audit.total}/3 executed, zero skipped, provider/model and six-submission matrix passed\n`,
      )
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    }
  }
  return { playwrightStatus: playwright.status, auditPassed }
}

export async function runGate(
  argv,
  {
    env = process.env,
    processLike = process,
    contractValue = contract,
    validateEnvironment = validateFixtureEnvironment,
    createRuntime = createFixtureRuntime,
    installSignalCleanup = installFixtureSignalCleanup,
    runLifecycle = runFixtureLifecycle,
    runPlaywrightGate = runStrictPlaywrightGate,
    removeReport = rm,
    spawnPlaywright = spawnSync,
  } = {},
) {
  const { strict, cycle, playwrightArgs } = normalizeCurrentBugLiveArguments(argv)
  let fixtureConfig
  try {
    validateCurrentBugLiveArguments({ strict, cycle, playwrightArgs }, env)
    if (strict) {
      const blockers = strictEnvironmentBlockers(env, contractValue)
      if (blockers.length > 0) {
        throw new Error(
          `K12 current-bug LIVE strict gate missing exact authorization: ${blockers.join(', ')}`,
        )
      }
      if (!cycle) {
        fixtureConfig = validateEnvironment(env, {
          gradingCalibrationApproval: contractValue.gradingCalibrationApproval,
        })
      }
    }
  } catch (error) {
    processLike.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    processLike.exitCode = 2
    return
  }

  if (!strict) {
    await removeReport(absoluteReportPath, { force: true })
    const playwright = spawnPlaywright('pnpm', [...playwrightCommand, ...playwrightArgs], {
      cwd: repoRoot,
      env: {
        ...env,
        DINGTALK_LIVE_SEND: '0',
      },
      shell: false,
      stdio: 'inherit',
    })
    const playwrightStatus = playwright.error ? 1 : playwright.status
    if (playwright.error) {
      processLike.stderr.write(
        `K12 current-bug LIVE gate could not start Playwright: ${playwright.error.message}\n`,
      )
    }
    processLike.exitCode = currentBugLiveExitCode({
      playwrightStatus,
      strict: false,
      auditPassed: false,
    })
    return
  }

  if (cycle) {
    const fixtureEnvironment = {
      HEX_K12_LIVE_RETRYABLE_DISPATCH_ID: env.HEX_K12_LIVE_RETRYABLE_DISPATCH_ID,
      HEX_K12_LIVE_OUTCOME_UNKNOWN_DISPATCH_ID: env.HEX_K12_LIVE_OUTCOME_UNKNOWN_DISPATCH_ID,
    }
    if (Object.values(fixtureEnvironment).some((value) => typeof value !== 'string' || !value.trim())) {
      processLike.stderr.write('K12 current-bug LIVE strict gate parent fixture IDs are required\n')
      processLike.exitCode = 2
      return
    }
    const gateResult = await runPlaywrightGate(playwrightArgs, fixtureEnvironment, { cycle })
    processLike.exitCode = currentBugLiveExitCode({ ...gateResult, strict: true })
    return
  }

  const runtime = createRuntime(fixtureConfig)
  let lifecyclePromise
  const uninstallSignalCleanup = installSignalCleanup(processLike, {
    cancelActive: async () => {
      await cancelStrictPlaywright()
      await runtime.cancelActive()
    },
    cleanup: () =>
      lifecyclePromise
        ? lifecyclePromise.then(
            () => undefined,
            () => undefined,
          )
        : runtime.cleanup(),
  })
  lifecyclePromise = runLifecycle(fixtureConfig, {
    stopSidecar: runtime.stopSidecar,
    startFixture: runtime.startFixture,
    readManifest: runtime.readManifest,
    startSidecar: runtime.startSidecar,
    runStrictGate: (fixtureEnvironment) => runPlaywrightGate(playwrightArgs, fixtureEnvironment),
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

  if (processLike.exitCode === 130 || processLike.exitCode === 143) return
  if (lifecycleError) {
    processLike.stderr.write(
      `${lifecycleError instanceof Error ? lifecycleError.message : String(lifecycleError)}\n`,
    )
    processLike.exitCode = 1
    return
  }
  processLike.exitCode = currentBugLiveExitCode({
    ...gateResult,
    strict: true,
  })
}

if (resolve(process.argv[1] ?? '') === resolve(scriptPath)) {
  await runGate(process.argv.slice(2))
}
