#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const contract = JSON.parse(
  readFileSync(
    new URL('../../tests/live/k12-real-10x-release.contract.json', import.meta.url),
    'utf8',
  ),
)
const expectedCycleIDs = Array.from(
  { length: 10 },
  (_, index) => `C${String(index + 1).padStart(2, '0')}`,
)

function sameArgs(left = [], right = []) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function trustedHook(contractValue, hook) {
  return contractValue.trustedLanes.some(
    (trusted) =>
      trusted.lane === hook?.lane &&
      trusted.module === hook?.module &&
      sameArgs(trusted.args, hook?.args),
  )
}

export function preflightReleaseGate(
  contractValue,
  {
    env = process.env,
    hookExists = (module) => existsSync(resolve(repoRoot, module)),
  } = {},
) {
  const blockers = []
  const cycleIDs = contractValue.cycles?.map(({ id }) => id) ?? []

  if (
    contractValue.schemaVersion !== 1 ||
    JSON.stringify(cycleIDs) !== JSON.stringify(expectedCycleIDs) ||
    new Set(cycleIDs).size !== expectedCycleIDs.length
  ) {
    blockers.push({
      kind: 'contract',
      reason: 'versioned cycle exact-set must be serial C01-C10',
    })
  }
  const execution = contractValue.execution ?? {}
  if (
    execution.workers !== 1 ||
    execution.fullyParallel !== false ||
    execution.retries !== 0 ||
    execution.forbidOnly !== true ||
    execution.failOnSkipped !== true ||
    execution.dingTalkLiveSend !== '0'
  ) {
    blockers.push({
      kind: 'contract',
      reason: 'execution must be serial, zero-retry, skip-blocking and DingTalk-disabled',
    })
  }

  for (const [name, expected] of Object.entries(
    contractValue.requiredEnvironment?.exact ?? {},
  )) {
    if ((env[name] ?? '').trim() !== expected) {
      blockers.push({ kind: 'environment', name, reason: `must equal ${expected}` })
    }
  }
  for (const name of contractValue.requiredEnvironment?.values ?? []) {
    if (!(env[name] ?? '').trim()) {
      blockers.push({ kind: 'environment', name, reason: 'must be explicitly supplied' })
    }
  }

  for (const cycle of contractValue.cycles ?? []) {
    for (const [name, expected] of Object.entries(
      cycle.requiredEnvironment?.exact ?? {},
    )) {
      if ((env[name] ?? '').trim() !== expected) {
        blockers.push({
          kind: 'environment',
          cycle: cycle.id,
          scope: cycle.scope,
          name,
          reason: `must equal ${expected}`,
        })
      }
    }
    for (const name of cycle.requiredEnvironment?.values ?? []) {
      if (!(env[name] ?? '').trim()) {
        blockers.push({
          kind: 'environment',
          cycle: cycle.id,
          scope: cycle.scope,
          name,
          reason: 'must be explicitly supplied',
        })
      }
    }
    if (!cycle.hook || !hookExists(cycle.hook.module)) {
      blockers.push({
        kind: 'missing-hook',
        cycle: cycle.id,
        scope: cycle.scope,
        reason: cycle.requiredHook ?? 'trusted hook module is unavailable',
      })
      continue
    }
    if (!trustedHook(contractValue, cycle.hook)) {
      blockers.push({
        kind: 'untrusted-hook',
        cycle: cycle.id,
        scope: cycle.scope,
        reason: 'hook is not an exact contract-owned trusted lane',
      })
    }
  }

  return { ready: blockers.length === 0, blockers }
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function executeReleasePlan(
  contractValue,
  {
    baseRunId,
    env = process.env,
    spawn = spawnSync,
    cwd = repoRoot,
  },
) {
  const results = []
  for (const cycle of contractValue.cycles) {
    const cycleRunId = `${baseRunId}-${cycle.id}`
    const child = spawn(
      process.execPath,
      [resolve(cwd, cycle.hook.module), ...(cycle.hook.args ?? [])],
      {
        cwd,
        env: {
          ...env,
          DINGTALK_LIVE_SEND: '0',
          HEX_K12_REAL_10X_CYCLE_ID: cycle.id,
          HEX_K12_REAL_10X_CYCLE_RUN_ID: cycleRunId,
          HEX_K12_LIVE_RUN_ID: cycleRunId,
        },
        stdio: 'inherit',
      },
    )
    const exitCode = Number.isInteger(child.status) ? child.status : 1
    results.push({
      id: cycle.id,
      scope: cycle.scope,
      lane: cycle.hook.lane,
      runIdSha256: digest(cycleRunId),
      exitCode,
      status: exitCode === 0 ? 'passed' : 'failed',
    })
    if (exitCode !== 0) return { status: 'failed', cycles: results }
  }
  return { status: 'passed', cycles: results }
}

async function writeReport(value) {
  const path = resolve(repoRoot, contract.reportPath)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

async function runGate(argv) {
  if (argv.some((argument) => argument !== '--strict')) {
    process.stderr.write('K12 real 10x release gate accepts only --strict and no filters\n')
    process.exitCode = 2
    return
  }

  const preflight = preflightReleaseGate(contract)
  if (!preflight.ready) {
    const report = {
      schemaVersion: contract.schemaVersion,
      status: 'blocked',
      blockers: preflight.blockers,
      cycles: [],
    }
    await writeReport(report)
    process.stderr.write(
      `K12 real 10x release gate preflight blocked before lane execution:\n${preflight.blockers
        .map(
          ({ kind, cycle, scope, name, reason }) =>
            ` - ${cycle ? `${cycle} ${scope}: ` : name ? `${name}: ` : `${kind}: `}${reason}`,
        )
        .join('\n')}\n`,
    )
    process.exitCode = 2
    return
  }

  const result = executeReleasePlan(contract, {
    baseRunId: process.env.HEX_K12_REAL_10X_RUN_ID.trim(),
  })
  await writeReport({
    schemaVersion: contract.schemaVersion,
    ...result,
  })
  process.exitCode = result.status === 'passed' ? 0 : 1
}

if (resolve(process.argv[1] ?? '') === resolve(scriptPath)) {
  await runGate(process.argv.slice(2))
}
