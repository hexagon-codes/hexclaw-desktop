#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createFixtureRuntime,
  validateFixtureEnvironment,
  validateGradingCalibrationApproval,
} from './k12-current-bug-fixture-orchestrator.mjs'
import {
  cleanupRunnerKnowledgeLineage,
  createRunnerKnowledgeLineage,
} from './k12-knowledge-lineage.mjs'
import { parseStrictJSON } from './k12-strict-json.mjs'

const scriptPath = fileURLToPath(import.meta.url)
const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
export function parseReal10xReleaseContract(raw) {
  return parseStrictJSON(raw, { label: 'K12 real 10x release contract' })
}

const contract = parseReal10xReleaseContract(
  readFileSync(
    new URL('../../tests/live/k12-real-10x-release.contract.json', import.meta.url),
    'utf8',
  ),
)
const expectedCycleIDs = Array.from(
  { length: 10 },
  (_, index) => `C${String(index + 1).padStart(2, '0')}`,
)
const c10PreparedEnvironmentNames = [
  'HEX_K12_C10_RESTART_HOOK',
  'HEX_K12_C10_RESTART_HOOK_SHA256',
  'HEX_K12_C10_HANDOFF_PUBLIC_KEY',
  'HEX_K12_C10_HANDOFF_PUBLIC_KEY_SHA256',
  'HEX_K12_C10_BEFORE_HANDOFF',
  'HEX_K12_C10_AFTER_HANDOFF',
  'HEX_K12_C10_AFTER_HANDOFF_PUBLIC_KEY',
  'HEX_K12_C10_DRIVER_CONFIG',
]
const c10HandoffEnvironmentNames = [
  'HEX_K12_C10_RESTART_AUTHORIZED',
  ...c10PreparedEnvironmentNames,
]

function gateFail(message) {
  throw new Error(`K12 real 10x release gate: ${message}`)
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    gateFail(`${label} must be an object`)
  }
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    gateFail(`${label} exact field set mismatch`)
  }
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

function portableRelative(root, pathname) {
  return relative(root, pathname).split(sep).join('/')
}

function collectRegularEvidenceFiles(root, current = root, files = []) {
  for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const pathname = resolve(current, entry.name)
    if (entry.isSymbolicLink()) gateFail('cycle evidence must not contain symlinks')
    if (entry.isDirectory()) {
      collectRegularEvidenceFiles(root, pathname, files)
      continue
    }
    if (!entry.isFile()) gateFail('cycle evidence must contain only regular files')
    files.push({ pathname, relativePath: portableRelative(root, pathname) })
  }
  return files
}

function copyEvidenceFile(source, target) {
  if (!existsSync(source) || lstatSync(source).isSymbolicLink() || !statSync(source).isFile()) {
    gateFail('passed current-bug cycle report must be a regular non-symlink file')
  }
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
  copyFileSync(source, target)
  chmodSync(target, 0o600)
  const bytes = readFileSync(target)
  return { sha256: digest(bytes), bytes: bytes.length }
}

export function archiveCurrentBugCycleEvidence({ cycle, cycleRunId, baseRunId, cwd }) {
  if (cycle?.hook?.module !== 'scripts/ci/k12-current-bug-live-gate.mjs') return undefined

  const sourceRoot = resolve(cwd, 'test-results/k12-current-bug-live')
  const sourceReport = resolve(sourceRoot, 'report.json')
  const sourceArtifacts = resolve(sourceRoot, 'artifacts')
  const relativeArchiveRoot = [
    'test-results',
    'k12-real-10x-release',
    'runs',
    digest(baseRunId),
    cycle.id,
    'current-bug-live',
  ].join('/')
  const archiveRoot = resolve(cwd, relativeArchiveRoot)
  const temporaryRoot = `${archiveRoot}.tmp-${process.pid}`
  if (existsSync(archiveRoot)) gateFail(`${cycle.id} cycle evidence archive already exists`)
  rmSync(temporaryRoot, { recursive: true, force: true })
  mkdirSync(temporaryRoot, { recursive: true, mode: 0o700 })

  try {
    const report = copyEvidenceFile(sourceReport, resolve(temporaryRoot, 'report.json'))
    const attachments = []
    if (existsSync(sourceArtifacts)) {
      if (lstatSync(sourceArtifacts).isSymbolicLink() || !statSync(sourceArtifacts).isDirectory()) {
        gateFail('current-bug cycle artifacts must be a regular directory')
      }
      for (const file of collectRegularEvidenceFiles(sourceArtifacts)) {
        attachments.push({
          path: `artifacts/${file.relativePath}`,
          ...copyEvidenceFile(
            file.pathname,
            resolve(temporaryRoot, 'artifacts', file.relativePath),
          ),
        })
      }
    }
    const manifest = {
      schema_version: 1,
      cycle_id: cycle.id,
      cycle_run_id_sha256: digest(cycleRunId),
      source: 'k12-current-bug-live',
      report: { path: 'report.json', ...report },
      attachments,
    }
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
    writeFileSync(resolve(temporaryRoot, 'manifest.json'), manifestBytes, {
      mode: 0o600,
      flag: 'wx',
    })
    renameSync(temporaryRoot, archiveRoot)
    return Object.freeze({
      manifest_path: `${relativeArchiveRoot}/manifest.json`,
      manifest_sha256: digest(manifestBytes),
    })
  } catch (error) {
    rmSync(temporaryRoot, { recursive: true, force: true })
    throw error
  }
}

export function validatePreparedC10Handoff(value, { cycleRunId, parentRunId }) {
  exactKeys(
    value,
    ['schema_version', 'cycle_id', 'run_id', 'parent_run_sha256', 'environment'],
    'C10 prepare manifest',
  )
  if (value.schema_version !== 1) gateFail('C10 prepare manifest schema version must equal 1')
  if (value.cycle_id !== 'C10') gateFail('C10 prepare manifest cycle must equal C10')
  if (value.run_id !== cycleRunId) gateFail('C10 prepare manifest run ID mismatch')
  if (value.parent_run_sha256 !== digest(parentRunId)) {
    gateFail('C10 prepare manifest parent run digest mismatch')
  }
  exactKeys(value.environment, c10PreparedEnvironmentNames, 'C10 prepare environment')
  for (const name of c10PreparedEnvironmentNames) {
    const input = value.environment[name]
    if (typeof input !== 'string' || !input.trim()) {
      gateFail(`C10 prepare environment ${name} must be non-empty`)
    }
    if (name.endsWith('_SHA256')) {
      if (!/^[a-f0-9]{64}$/.test(input)) {
        gateFail(`C10 prepare environment ${name} must be SHA-256 hex`)
      }
    } else if (!isAbsolute(input)) {
      gateFail(`C10 prepare environment ${name} must be an absolute path`)
    }
  }
  return Object.freeze({ HEX_K12_C10_RESTART_AUTHORIZED: '1', ...value.environment })
}

export function executeCallerC10HandoffPrepare({
  cycle,
  cycleRunId,
  parentRunId,
  knowledgeLineage,
  env = process.env,
  spawn = spawnSync,
  cwd = repoRoot,
}) {
  if (cycle?.id !== 'C10') gateFail('C10 prepare may run only for C10')
  if ((env.HEX_K12_C10_PREPARE_AUTHORIZED ?? '').trim() !== '1') {
    gateFail('C10 prepare requires HEX_K12_C10_PREPARE_AUTHORIZED=1')
  }
  const hook = (env.HEX_K12_C10_PREPARE_HOOK ?? '').trim()
  const expectedDigest = (env.HEX_K12_C10_PREPARE_HOOK_SHA256 ?? '').trim()
  if (!isAbsolute(hook) || !existsSync(hook) || !statSync(hook).isFile()) {
    gateFail('C10 prepare hook must be an existing absolute regular file')
  }
  if (lstatSync(hook).isSymbolicLink() || (statSync(hook).mode & 0o111) === 0) {
    gateFail('C10 prepare hook must be a non-symlink executable')
  }
  if (!/^[a-f0-9]{64}$/.test(expectedDigest) || digest(readFileSync(hook)) !== expectedDigest) {
    gateFail('C10 prepare hook SHA-256 mismatch')
  }
  if (!knowledgeLineage?.path || !isAbsolute(knowledgeLineage.path)) {
    gateFail('C10 prepare requires the runner-owned absolute C09 lineage path')
  }
  const result = spawn(hook, ['--prepare-c10-handoff'], {
    cwd,
    env: {
      ...env,
      DINGTALK_LIVE_SEND: '0',
      HEX_K12_REAL_10X_CYCLE_ID: 'C10',
      HEX_K12_REAL_10X_CYCLE_RUN_ID: cycleRunId,
      HEX_K12_REAL_10X_PARENT_RUN_ID: parentRunId,
      HEX_K12_REAL_10X_PARENT_OWNS_LIFECYCLE: '1',
      HEX_K12_REAL_10X_KNOWLEDGE_LINEAGE_PATH: knowledgeLineage.path,
    },
    encoding: 'utf8',
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result?.error || result?.status !== 0) gateFail('caller C10 prepare hook failed')
  const stdout = typeof result.stdout === 'string' ? result.stdout : ''
  if (!/^\/[^\n]+\n$/.test(stdout)) gateFail('caller C10 prepare hook must emit one manifest path')
  const manifestPath = stdout.trim()
  if (
    !existsSync(manifestPath) ||
    !statSync(manifestPath).isFile() ||
    lstatSync(manifestPath).isSymbolicLink() ||
    (statSync(manifestPath).mode & 0o077) !== 0
  ) {
    gateFail('caller C10 prepare manifest must be a private regular file')
  }
  return validatePreparedC10Handoff(
    parseStrictJSON(readFileSync(manifestPath, 'utf8'), { label: 'C10 prepare manifest' }),
    { cycleRunId, parentRunId },
  )
}

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

function hasRunnerOwnedCycleSelector(cycle) {
  const hook = cycle?.hook
  return (
    hook &&
    typeof hook === 'object' &&
    !Array.isArray(hook) &&
    hook.cycle_selector === cycle.id &&
    !(hook.args ?? []).includes('--cycle')
  )
}

export function preflightReleaseGate(
  contractValue,
  { env = process.env, hookExists = (module) => existsSync(resolve(repoRoot, module)) } = {},
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
  try {
    validateGradingCalibrationApproval(contractValue.gradingCalibrationApproval, {
      provider: contractValue.provider?.identity,
      model: contractValue.provider?.model,
    })
  } catch {
    blockers.push({
      kind: 'grading-calibration-approval',
      reason: 'approved calibration artifact and release config digests are required',
    })
  }

  for (const [name, expected] of Object.entries(contractValue.requiredEnvironment?.exact ?? {})) {
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
    if (!hasRunnerOwnedCycleSelector(cycle)) {
      blockers.push({
        kind: 'cycle-selector',
        cycle: cycle.id,
        scope: cycle.scope,
        reason:
          'each cycle requires its exact runner-owned cycle_selector; child args must not inject --cycle',
      })
    }
    for (const [name, expected] of Object.entries(cycle.requiredEnvironment?.exact ?? {})) {
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

function knowledgeLineageChildEnvironment(cycle, knowledgeLineage, baseRunId) {
  if (!['C07', 'C08', 'C09', 'C10'].includes(cycle.id)) return {}
  if (
    !knowledgeLineage ||
    typeof knowledgeLineage.path !== 'string' ||
    !knowledgeLineage.path.trim()
  ) {
    throw new Error(
      `K12 real 10x release gate: ${cycle.id} requires a runner-owned knowledge lineage`,
    )
  }
  return {
    HEX_K12_REAL_10X_KNOWLEDGE_LINEAGE_PATH: knowledgeLineage.path,
    HEX_K12_REAL_10X_PARENT_RUN_ID: baseRunId,
  }
}

export function executeReleasePlan(
  contractValue,
  {
    baseRunId,
    env = process.env,
    spawn = spawnSync,
    cwd = repoRoot,
    knowledgeLineage,
    prepareC10Handoff = executeCallerC10HandoffPrepare,
  },
) {
  const results = []
  const childEnvironment = { ...env }
  delete childEnvironment.HEX_K12_REAL_10X_KNOWLEDGE_LINEAGE_PATH
  delete childEnvironment.HEX_K12_REAL_10X_PARENT_RUN_ID
  for (const name of c10HandoffEnvironmentNames) delete childEnvironment[name]
  for (const cycle of contractValue.cycles) {
    if (!hasRunnerOwnedCycleSelector(cycle)) {
      throw new Error(
        `K12 real 10x release gate: ${cycle.id} has no valid runner-owned cycle selector`,
      )
    }
    const cycleRunId = `${baseRunId}-${cycle.id}`
    const preparedC10Environment =
      cycle.id === 'C10'
        ? prepareC10Handoff({
            cycle,
            cycleRunId,
            parentRunId: baseRunId,
            knowledgeLineage,
            env: childEnvironment,
            spawn,
            cwd,
          })
        : {}
    const child = spawn(
      process.execPath,
      [
        resolve(cwd, cycle.hook.module),
        ...(cycle.hook.args ?? []),
        '--cycle',
        cycle.hook.cycle_selector,
      ],
      {
        cwd,
        env: {
          ...childEnvironment,
          DINGTALK_LIVE_SEND: '0',
          HEX_K12_REAL_10X_CYCLE_ID: cycle.id,
          HEX_K12_REAL_10X_CYCLE_RUN_ID: cycleRunId,
          HEX_K12_REAL_10X_PARENT_OWNS_LIFECYCLE: '1',
          HEX_K12_LIVE_RUN_ID: cycleRunId,
          ...(typeof env.HEX_K12_LIVE_APP_URL === 'string' && env.HEX_K12_LIVE_APP_URL.trim()
            ? { HEX_E2E_BASE_URL: env.HEX_K12_LIVE_APP_URL }
            : {}),
          ...(typeof env.HEX_K12_LIVE_SIDECAR_URL === 'string' &&
          env.HEX_K12_LIVE_SIDECAR_URL.trim()
            ? { HEX_E2E_SIDECAR_URL: env.HEX_K12_LIVE_SIDECAR_URL }
            : {}),
          ...knowledgeLineageChildEnvironment(cycle, knowledgeLineage, baseRunId),
          ...preparedC10Environment,
        },
        stdio: 'inherit',
      },
    )
    const exitCode = Number.isInteger(child.status) ? child.status : 1
    const evidence =
      exitCode === 0
        ? archiveCurrentBugCycleEvidence({
            cycle,
            cycleRunId,
            baseRunId,
            cwd,
          })
        : undefined
    results.push({
      id: cycle.id,
      scope: cycle.scope,
      lane: cycle.hook.lane,
      runIdSha256: digest(cycleRunId),
      exitCode,
      status: exitCode === 0 ? 'passed' : 'failed',
      ...(evidence ? { evidence } : {}),
    })
    if (exitCode !== 0) return { status: 'failed', cycles: results }
  }
  return { status: 'passed', cycles: results }
}

function fixtureChildEnvironment(ids) {
  if (
    !ids ||
    typeof ids.retryableDispatchID !== 'string' ||
    !ids.retryableDispatchID.trim() ||
    typeof ids.outcomeUnknownDispatchID !== 'string' ||
    !ids.outcomeUnknownDispatchID.trim()
  ) {
    throw new Error(
      'K12 real 10x release gate: fixture manifest returned invalid opaque dispatch IDs',
    )
  }
  return Object.freeze({
    HEX_K12_LIVE_RETRYABLE_DISPATCH_ID: ids.retryableDispatchID,
    HEX_K12_LIVE_OUTCOME_UNKNOWN_DISPATCH_ID: ids.outcomeUnknownDispatchID,
  })
}

/**
 * Owns the single fixture/Sidecar lifecycle consumed by C01..C10. Child lanes
 * only receive opaque state IDs; they never receive lifecycle control.
 */
export async function executeComposedReleasePlan(
  contractValue,
  {
    baseRunId,
    env = process.env,
    runtime,
    spawn = spawnSync,
    cwd = repoRoot,
    createKnowledgeLineage = createRunnerKnowledgeLineage,
    cleanupKnowledgeLineage = cleanupRunnerKnowledgeLineage,
    prepareC10Handoff = executeCallerC10HandoffPrepare,
  },
) {
  for (const name of [
    'stopSidecar',
    'startFixture',
    'readManifest',
    'startSidecar',
    'cleanupFixture',
  ]) {
    if (typeof runtime?.[name] !== 'function') {
      throw new Error(`K12 real 10x release gate: runtime.${name} is required`)
    }
  }

  let outcome
  let rootError
  let knowledgeLineage
  try {
    await runtime.stopSidecar()
    await runtime.startFixture()
    const fixtureEnvironment = fixtureChildEnvironment(await runtime.readManifest())
    await runtime.startSidecar()
    knowledgeLineage = await createKnowledgeLineage({ parentRunId: baseRunId })
    outcome = executeReleasePlan(contractValue, {
      baseRunId,
      env: { ...env, ...fixtureEnvironment },
      spawn,
      cwd,
      knowledgeLineage,
      prepareC10Handoff,
    })
  } catch (error) {
    rootError = error
  }

  let cleanupError
  try {
    await runtime.stopSidecar()
  } catch (error) {
    cleanupError = error
  }
  try {
    await runtime.cleanupFixture()
  } catch (error) {
    cleanupError ??= error
  }
  if (knowledgeLineage) {
    try {
      await cleanupKnowledgeLineage(knowledgeLineage)
    } catch (error) {
      cleanupError ??= error
    }
  }
  if (rootError) throw rootError
  if (cleanupError) throw cleanupError
  return outcome
}

async function writeReport(value) {
  const path = resolve(repoRoot, contract.reportPath)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

export async function runGate(
  argv,
  {
    env = process.env,
    contractValue = contract,
    preflight = preflightReleaseGate,
    validateEnvironment = validateFixtureEnvironment,
    createRuntime = createFixtureRuntime,
    executeComposedPlan = executeComposedReleasePlan,
    writeGateReport = writeReport,
    processLike = process,
  } = {},
) {
  if (argv.some((argument) => argument !== '--strict')) {
    processLike.stderr.write('K12 real 10x release gate accepts only --strict and no filters\n')
    processLike.exitCode = 2
    return
  }

  const preflightResult = preflight(contractValue, { env })
  if (!preflightResult.ready) {
    const report = {
      schemaVersion: contractValue.schemaVersion,
      status: 'blocked',
      blockers: preflightResult.blockers,
      cycles: [],
    }
    await writeGateReport(report)
    processLike.stderr.write(
      `K12 real 10x release gate preflight blocked before lane execution:\n${preflightResult.blockers
        .map(
          ({ kind, cycle, scope, name, reason }) =>
            ` - ${
              cycle
                ? `${cycle}${scope ? ` ${scope}` : ''}${name ? ` · ${name}` : ''}`
                : (name ?? kind)
            }: ${reason}`,
        )
        .join('\n')}\n`,
    )
    processLike.exitCode = 2
    return
  }

  let fixtureConfig
  try {
    fixtureConfig = validateEnvironment(env, {
      gradingCalibrationApproval: contractValue.gradingCalibrationApproval,
    })
  } catch (error) {
    await writeGateReport({
      schemaVersion: contractValue.schemaVersion,
      status: 'blocked',
      blockers: [
        {
          kind: 'fixture-environment',
          reason: error instanceof Error ? error.message : 'fixture environment is invalid',
        },
      ],
      cycles: [],
    })
    processLike.stderr.write(
      'K12 real 10x release gate fixture environment blocked before lifecycle start\n',
    )
    processLike.exitCode = 2
    return
  }

  let result
  try {
    result = await executeComposedPlan(contractValue, {
      baseRunId: env.HEX_K12_REAL_10X_RUN_ID.trim(),
      env,
      runtime: createRuntime(fixtureConfig),
    })
  } catch {
    await writeGateReport({
      schemaVersion: contractValue.schemaVersion,
      status: 'failed',
      cycles: [],
    })
    processLike.stderr.write('K12 real 10x release gate lifecycle failed; cleanup was attempted\n')
    processLike.exitCode = 1
    return
  }
  await writeGateReport({ schemaVersion: contractValue.schemaVersion, ...result })
  processLike.exitCode = result.status === 'passed' ? 0 : 1
}

if (resolve(process.argv[1] ?? '') === resolve(scriptPath)) {
  await runGate(process.argv.slice(2))
}
