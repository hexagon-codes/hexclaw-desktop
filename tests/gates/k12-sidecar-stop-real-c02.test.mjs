import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  access,
  chmod,
  cp,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { startReleaseStaticGateway } from '../../scripts/ci/k12-release-static-gateway.mjs'

const repoRoot = new URL('../../', import.meta.url).pathname.replace(/\/$/, '')
const hexclawSource = join(repoRoot, '..', 'hexclaw')
const sourceConfig = join(homedir(), '.hexclaw', 'hexclaw.yaml')
const installedAppBinary = '/Applications/HexClaw.app/Contents/MacOS/hexclaw-desktop'
const installedSidecarBinary = '/Applications/HexClaw.app/Contents/MacOS/hexclaw'
const packageDir = join(repoRoot, 'src-tauri/target/release/bundle/dmg')
const packagePath = join(packageDir, 'HexClaw_0.5.0-beta_x64.dmg')
const receiptName = 'HexClaw_0.5.0-beta_x64.release-ui-attestation.json'
const manifestName = 'HexClaw_0.5.0-beta_x64.release-ui-dist-manifest.json'
const sourceReceiptPath = join(packageDir, receiptName)
const sourceManifestPath = join(packageDir, manifestName)
const controllerPath = join(repoRoot, 'scripts/ci/k12-current-bug-isolated-sidecar-control.mjs')
const playwrightOutputPath = join(repoRoot, 'test-results/k12-current-bug-live')
const c01EvidencePath = join(repoRoot, 'test-results/bug-20260724-014/installed-real-c01')
const sidecarPort = 16129
const releaseUIURL = 'http://localhost:16060'
const sidecarURL = `http://127.0.0.1:${sidecarPort}`
const singleRealCycle = process.env.HEX_K12_SINGLE_REAL_CYCLE === 'C01' ? 'C01' : 'C02'
const singleRealScenarioTitle =
  singleRealCycle === 'C01'
    ? 'C01 solve image preserves one durable receipt and attachment identity'
    : 'C02 clear homework preserves one durable grading result'

export const candidatePolicy = {
  policy_version: 1,
  queued_seconds: 600,
  normalizing_seconds: 600,
  recognizing_seconds: 600,
  locating_seconds: 600,
  rendering_seconds: 600,
  projecting_seconds: 600,
  recognition_plan_version: 1,
  assessing_buckets: [
    { max_problems: 1, seconds: 600 },
    { max_problems: 8, seconds: 600 },
    { max_problems: 16, seconds: 900 },
    { max_problems: 32, seconds: 900 },
  ],
  item_concurrency: 1,
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function fileSHA256(pathname) {
  return sha256(await readFile(pathname))
}

async function exists(pathname) {
  return access(pathname).then(
    () => true,
    () => false,
  )
}

function runProcess(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const append = (current, chunk) => `${current}${chunk}`.slice(-2 * 1024 * 1024)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout = append(stdout, chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr = append(stderr, chunk)
    })
    child.once('error', rejectPromise)
    child.once('close', (code, signal) => {
      const status = Number.isInteger(code) ? code : 1
      if (!options.accept?.includes(status) && status !== 0) {
        rejectPromise(
          new Error(`${options.label ?? command} failed (${signal ?? status}); output redacted`),
        )
        return
      }
      resolvePromise({ status, stdout, stderr })
    })
  })
}

export function assertPlaywrightSucceeded(status, cycle = 'C02') {
  assert.equal(
    status,
    0,
    `single real ${cycle} Playwright must pass (status=${status}; output redacted)`,
  )
}

export function playwrightFailureLocations(output) {
  const locations = new Set()
  const matcher =
    /(?:^|[\s(])(?:[^\s()]*\/)?(tests\/live\/k12-current-bug-real-matrix\.spec\.ts:\d+:\d+)/gm
  for (const match of String(output ?? '').matchAll(matcher)) {
    locations.add(match[1])
    if (locations.size === 4) break
  }
  return [...locations]
}

const safeRecognitionExpectedCounts = new Set([1, 8, 16, 32])
const safeRecognitionSourceFactMaxIndex = 16
const safeRecognitionSourceFields = new Set([
  'source_number_path',
  'display_label',
  'source_section_path',
  'source_section_label',
  'system_section_ordinal',
  'system_display_label',
])

export function playwrightRecognitionCountFacts(output) {
  const matcher =
    /^\s*(?:Error:\s*)?C02 recognition exact-set count mismatch expected=(\d+) actual=(\d+)\s*$/gm
  for (const match of String(output ?? '').matchAll(matcher)) {
    const expectedCount = Number(match[1])
    const actualCount = Number(match[2])
    if (
      safeRecognitionExpectedCounts.has(expectedCount) &&
      Number.isInteger(actualCount) &&
      actualCount >= 0 &&
      actualCount < expectedCount
    ) {
      return { expected_count: expectedCount, actual_count: actualCount }
    }
  }
  return undefined
}

export function playwrightSourceFactFacts(output) {
  const matcher =
    /^\s*(?:Error:\s*)?C02 source exact-set mismatch index=(\d+) field=([a-z_]+)\s*$/gm
  for (const match of String(output ?? '').matchAll(matcher)) {
    const index = Number(match[1])
    const field = match[2]
    if (
      Number.isInteger(index) &&
      index >= 1 &&
      index <= safeRecognitionSourceFactMaxIndex &&
      safeRecognitionSourceFields.has(field)
    ) {
      return { index, field }
    }
  }
  return undefined
}

const safeDispatchStatuses = new Set([
  'queued',
  'routed',
  'awaiting_confirmation',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'outcome_unknown',
])
const safeProjectionStages = new Set([
  'queued',
  'normalizing',
  'recognizing',
  'locating',
  'rendering',
  'projecting',
  'assessing',
  'recovering',
  'failed_retryable',
  'failed_terminal',
  'outcome_unknown',
  'cancelled',
  'completed',
])
const safeClassifierStatuses = new Set(['failed', 'outcome_unknown'])
const safeFailureKinds = new Set([
  'assess_failed',
  'assess_item_failed',
  'assess_item_invalid',
  'assessment_exact_set_incomplete',
  'interactive_deadline_exceeded',
  'interactive_deadline_outcome_unknown',
  'item_invocation_outcome_unknown',
  'model_timeout',
  'physical_invocation_prepare_failed',
  'provider_outcome_unknown',
  'provider_request_not_sent',
  'provider_timeout',
  'provider_transport',
  'recognize_empty',
  'recognize_failed',
  'recognize_structure_invalid',
  'reconciled_not_executed',
  'reconciled_succeeded',
])

const safeItemFailureClasses = new Set(['local', 'provider_response', 'provider_transport'])
const safeItemFailureCodes = new Set([
  'outcome_unknown',
  'result_encode_failed',
  'result_not_durable',
])

export function safeFailureKindClass(value) {
  const failureKind = String(value ?? '').trim()
  if (!failureKind) return 'none'
  if (safeFailureKinds.has(failureKind)) return failureKind
  if (/^provider_response_http_[1-5]\d\d$/.test(failureKind)) return failureKind
  return 'other'
}

export function safeItemFailureClass(value) {
  const failureClass = String(value ?? '').trim()
  if (!failureClass) return 'none'
  return safeItemFailureClasses.has(failureClass) ? failureClass : 'other'
}

export function safeItemFailureCodeClass(value) {
  const failureCode = String(value ?? '').trim()
  if (!failureCode) return 'none'
  if (safeItemFailureCodes.has(failureCode)) return failureCode
  if (/^http_[1-5]\d\d$/.test(failureCode)) return failureCode
  return 'other'
}

export function playwrightTerminalFailureFacts(output) {
  const matcher =
    /C02 grading reached terminal ([a-z_]+)\/([a-z_]+) before visible overlay \(([a-z_]+)\)/g
  for (const match of String(output ?? '').matchAll(matcher)) {
    const [, dispatchStatus, projectionStage, classifierStatus] = match
    if (
      safeDispatchStatuses.has(dispatchStatus) &&
      safeProjectionStages.has(projectionStage) &&
      safeClassifierStatuses.has(classifierStatus)
    ) {
      return {
        dispatch_status: dispatchStatus,
        projection_stage: projectionStage,
        classifier_status: classifierStatus,
      }
    }
  }
  return undefined
}

async function privateWrite(pathname, bytes) {
  await writeFile(pathname, bytes, { mode: 0o600, flag: 'wx' })
  await chmod(pathname, 0o600)
}

async function privateCopy(source, target) {
  await copyFile(source, target)
  await chmod(target, 0o600)
}

function lastJSON(stdout, label) {
  const line = stdout.trim().split(/\r?\n/).at(-1)
  try {
    return JSON.parse(line)
  } catch {
    throw new Error(`${label} did not return a JSON receipt (body redacted)`)
  }
}

async function assertStopped(controllerConfig) {
  assert.equal(await exists(controllerConfig.pid_file), false, 'owned PID receipt must be absent')
  assert.equal(await exists(controllerConfig.lock_file), false, 'owned Sidecar lock must be absent')
  const listener = await runProcess(
    'lsof',
    ['-nP', `-iTCP:${controllerConfig.port}`, '-sTCP:LISTEN', '-t'],
    { accept: [1], label: 'listener inspection' },
  )
  assert.equal(listener.status, 1, 'isolated Sidecar listener must be absent')
  const health = await fetch(`${controllerConfig.sidecar_url}/health`, {
    signal: AbortSignal.timeout(2_000),
  }).catch(() => undefined)
  assert.equal(health, undefined, 'isolated Sidecar health must be unreachable after stop')
}

async function modelInvocationFacts(storePath) {
  const query = `
    SELECT stage, status, provider, model, failure_kind, COUNT(*) AS count
      FROM k12_model_invocations
     WHERE provider = 'hexclaw-gpt' AND model = 'gpt-5.6-sol'
     GROUP BY stage, status, provider, model, failure_kind
     ORDER BY stage, status, failure_kind;
  `
  const result = await runProcess('sqlite3', ['-json', storePath, query], {
    label: 'model invocation evidence query',
  })
  const rows = JSON.parse(result.stdout || '[]')
  assert.ok(Array.isArray(rows))
  assert.ok(
    rows.some(
      (row) =>
        row.provider === 'hexclaw-gpt' &&
        row.model === 'gpt-5.6-sol' &&
        ['sent', 'succeeded', 'failed', 'outcome_unknown', 'reconciled'].includes(row.status) &&
        Number(row.count) > 0,
    ),
    'the single-cycle run must cross the real configured model-send boundary',
  )
  const facts = new Map()
  for (const row of rows) {
    const fact = {
      stage: String(row.stage),
      status: String(row.status),
      provider: String(row.provider),
      model: String(row.model),
      failure_kind_class: safeFailureKindClass(row.failure_kind),
    }
    const key = JSON.stringify(fact)
    const current = facts.get(key) ?? { ...fact, count: 0 }
    current.count += Number(row.count)
    facts.set(key, current)
  }
  return [...facts.values()].sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right)),
  )
}

async function gradingFailureFacts(storePath) {
  const jobResult = await runProcess(
    'sqlite3',
    [
      '-json',
      storePath,
      `SELECT status, failure_kind, retryable, failed_stage, COUNT(*) AS count
         FROM k12_grading_jobs
        WHERE status IN ('failed_retryable','failed_terminal','outcome_unknown')
        GROUP BY status, failure_kind, retryable, failed_stage
        ORDER BY status, failed_stage, failure_kind;`,
    ],
    { label: 'grading failure evidence query' },
  )
  const itemResult = await runProcess(
    'sqlite3',
    [
      '-json',
      storePath,
      `SELECT operation, status, provider, model, failure_class, failure_code, COUNT(*) AS count
         FROM k12_grading_item_invocations
        GROUP BY operation, status, provider, model, failure_class, failure_code
        ORDER BY operation, status, failure_class, failure_code;`,
    ],
    { label: 'grading item failure evidence query' },
  )
  const jobs = JSON.parse(jobResult.stdout || '[]').map((row) => ({
    status: safeProjectionStages.has(String(row.status)) ? String(row.status) : 'other',
    failure_kind_class: safeFailureKindClass(row.failure_kind),
    retryable: Number(row.retryable) === 1,
    failed_stage: safeProjectionStages.has(String(row.failed_stage))
      ? String(row.failed_stage)
      : 'other',
    count: Number(row.count),
  }))
  const safeOperations = new Set([
    'solve',
    'solve_generate',
    'solve_verify',
    'grade',
    'parent_guide',
  ])
  const safeInvocationStatuses = new Set([
    'prepared',
    'sent',
    'succeeded',
    'failed',
    'outcome_unknown',
    'reconciled',
  ])
  const items = JSON.parse(itemResult.stdout || '[]').map((row) => ({
    operation: safeOperations.has(String(row.operation)) ? String(row.operation) : 'other',
    status: safeInvocationStatuses.has(String(row.status)) ? String(row.status) : 'other',
    provider: row.provider === 'hexclaw-gpt' ? 'hexclaw-gpt' : 'other',
    model: row.model === 'gpt-5.6-sol' ? 'gpt-5.6-sol' : 'other',
    failure_class: safeItemFailureClass(row.failure_class),
    failure_code_class: safeItemFailureCodeClass(row.failure_code),
    count: Number(row.count),
  }))
  return { jobs, items }
}

async function persistUnchangedLLMConfig() {
  const current = await fetch(`${sidecarURL}/api/v1/config/llm`, {
    signal: AbortSignal.timeout(30_000),
  })
  assert.equal(current.status, 200, 'isolated Sidecar LLM config must be readable')
  const maskedConfig = await current.json()
  assert.equal(maskedConfig.default, 'hexclaw-gpt')
  assert.equal(maskedConfig.providers?.['hexclaw-gpt']?.model, 'gpt-5.6-sol')
  assert.match(maskedConfig.providers['hexclaw-gpt'].api_key, /^\*{4}/)

  const persisted = await fetch(`${sidecarURL}/api/v1/config/llm`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(maskedConfig),
    signal: AbortSignal.timeout(120_000),
  })
  assert.equal(persisted.status, 200, 'Sidecar must persist its unchanged masked LLM config')
  const receipt = await persisted.json()
  assert.equal(receipt.status, 'ok')
  assert.equal(Number.isSafeInteger(receipt.config_revision), true)
}

test(
  `installed real ${singleRealCycle} permits guarded stop after runtime YAML persistence and lock release`,
  {
    skip: process.env.HEX_K12_SIDECAR_STOP_REAL_C02 !== '1',
    timeout: 30 * 60_000,
  },
  async (t) => {
    const root = await mkdtemp('/tmp/hexclaw-k12-stop-c02-')
    await chmod(root, 0o700)
    const canonicalRoot = await realpath(root)
    assert.match(canonicalRoot, /^\/private\/tmp\/hexclaw-k12-stop-c02-/)

    const profile = root
    const profileData = join(profile, '.hexclaw')
    const storePath = join(profileData, 'data.db')
    const manifestPath = join(profile, 'fixture-manifest.json')
    const policyPath = join(root, 'candidate-policy.json')
    const receiptPath = join(root, receiptName)
    const distManifestPath = join(root, manifestName)
    const controllerConfigPath = join(root, 'sidecar-controller.json')
    let gateway
    let controllerConfig
    let fixtureStarted = false

    const runController = (action, accept = []) =>
      runProcess(controllerPath, [action, '--config', controllerConfigPath], {
        accept,
        label: `Sidecar controller ${action}`,
      })
    const builderArgs = (action) => {
      const args = [
        'run',
        '-tags',
        'testtools',
        './cmd/k12-live-fixture-testtools',
        action,
        '--profile',
        profile,
        '--store',
        storePath,
        '--manifest',
        manifestPath,
      ]
      if (action === 'start') {
        args.push(
          '--run-id',
          `sidecar-stop-c02-${randomUUID()}`,
          '--learner',
          `sidecar-stop-learner-${randomUUID()}`,
          '--provider',
          'hexclaw-gpt',
          '--model',
          'gpt-5.6-sol',
          '--lease',
          '30m',
        )
      }
      return args
    }

    t.after(async () => {
      if (controllerConfig) await runController('stop', [1]).catch(() => undefined)
      if (gateway) await gateway.close().catch(() => undefined)
      if (fixtureStarted && (await exists(manifestPath))) {
        await runProcess('go', builderArgs('cleanup'), {
          cwd: hexclawSource,
          env: { ...process.env, DINGTALK_LIVE_SEND: '0' },
          label: 'fixture cleanup',
        }).catch(() => undefined)
        await unlink(manifestPath).catch(() => undefined)
      }
      if (
        canonicalRoot.startsWith('/private/tmp/hexclaw-k12-stop-c02-') ||
        canonicalRoot.startsWith('/tmp/hexclaw-k12-stop-c02-')
      ) {
        await rm(canonicalRoot, { recursive: true, force: true })
      }
      if (singleRealCycle === 'C01' && (await exists(playwrightOutputPath))) {
        await rm(c01EvidencePath, { recursive: true, force: true })
        await cp(playwrightOutputPath, c01EvidencePath, { recursive: true })
      }
      await rm(playwrightOutputPath, { recursive: true, force: true })
    })

    await mkdir(profileData, { mode: 0o700 })
    await privateWrite(storePath, '')
    await privateWrite(policyPath, `${JSON.stringify(candidatePolicy)}\n`)
    await privateCopy(sourceReceiptPath, receiptPath)
    await privateCopy(sourceManifestPath, distManifestPath)
    assert.equal((await stat(sourceConfig)).mode & 0o777, 0o600)

    const prepared = await runProcess(
      'go',
      [
        'run',
        '-tags',
        'testtools',
        './cmd/k12-live-fixture-testtools',
        'prepare-profile',
        '--source-config',
        sourceConfig,
        '--profile',
        profile,
        '--store',
        storePath,
        '--port',
        String(sidecarPort),
        '--candidate-policy',
        policyPath,
      ],
      {
        cwd: hexclawSource,
        env: { ...process.env, DINGTALK_LIVE_SEND: '0' },
        label: 'isolated profile preparation',
      },
    )
    const preparedReceipt = lastJSON(prepared.stdout, 'isolated profile preparation')
    assert.equal(preparedReceipt.status, 'prepared')
    assert.match(preparedReceipt.config_sha256, /^[a-f0-9]{64}$/)

    const sidecarConfigPath = join(profileData, 'hexclaw.yaml')
    const pidFile = join(profileData, '.k12-sidecar.pid')
    const lockFile = join(profileData, '.sidecar.lock')
    const appSHA256 = await fileSHA256(installedAppBinary)
    const sidecarSHA256 = await fileSHA256(installedSidecarBinary)
    const receiptSHA256 = await fileSHA256(receiptPath)
    const releaseReceipt = JSON.parse(await readFile(receiptPath, 'utf8'))
    assert.equal(releaseReceipt.release_version, '0.5.0-beta')
    assert.equal(appSHA256, releaseReceipt.installed_app_sha256)
    assert.equal(sidecarSHA256, releaseReceipt.sidecar_sha256)
    assert.equal(await fileSHA256(packagePath), releaseReceipt.package_sha256)
    assert.equal(await fileSHA256(distManifestPath), releaseReceipt.dist_manifest_sha256)

    gateway = await startReleaseStaticGateway({
      schema_version: 1,
      host: '127.0.0.1',
      port: 16060,
      release_version: '0.5.0-beta',
      dist_root: join(repoRoot, 'dist'),
      installed_app_binary: installedAppBinary,
      sidecar_binary: installedSidecarBinary,
      package_path: packagePath,
      dist_manifest_path: distManifestPath,
      release_attestation_path: receiptPath,
      release_attestation_sha256: receiptSHA256,
      sidecar_url: sidecarURL,
    })

    controllerConfig = {
      schema_version: 2,
      profile_dir: profile,
      sidecar_config_path: sidecarConfigPath,
      sidecar_config_sha256: preparedReceipt.config_sha256,
      binary_path: installedSidecarBinary,
      binary_sha256: sidecarSHA256,
      expected_version: '0.5.0-beta',
      host: '127.0.0.1',
      port: sidecarPort,
      sidecar_url: sidecarURL,
      release_ui_url: releaseUIURL,
      release_attestation_path: receiptPath,
      release_attestation_sha256: receiptSHA256,
      pid_file: pidFile,
      lock_file: lockFile,
      startup_timeout_ms: 120_000,
      shutdown_timeout_ms: 120_000,
    }
    await privateWrite(controllerConfigPath, `${JSON.stringify(controllerConfig)}\n`)

    const fixture = await runProcess('go', builderArgs('start'), {
      cwd: hexclawSource,
      env: { ...process.env, DINGTALK_LIVE_SEND: '0' },
      label: 'fixture start',
    })
    fixtureStarted = true
    const fixtureReceipt = lastJSON(fixture.stdout, 'fixture start')
    assert.deepEqual(fixtureReceipt.boundary_calls, {
      dingtalk_sends: 0,
      im_sends: 0,
      model_calls: 0,
    })
    const opaqueManifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    for (const field of ['agent_name', 'retryable_dispatch_id', 'outcome_unknown_dispatch_id']) {
      assert.ok(typeof opaqueManifest[field] === 'string' && opaqueManifest[field])
    }

    await runController('start')
    console.log(`# installed real ${singleRealCycle} started; model/UI output remains redacted`)
    const playwright = await runProcess(
      'pnpm',
      [
        'exec',
        'playwright',
        'test',
        '-c',
        'playwright.k12.current-bug-live.config.ts',
        '--grep',
        singleRealScenarioTitle,
      ],
      {
        cwd: repoRoot,
        accept: [1],
        label: `single real ${singleRealCycle}`,
        env: {
          ...process.env,
          DINGTALK_LIVE_SEND: '0',
          HEX_K12_CURRENT_BUG_LIVE_REQUIRED: '1',
          HEX_K12_LIVE_RUN: '1',
          HEX_K12_LIVE_PROFILE_ISOLATED: '1',
          HEX_K12_LIVE_MODEL_AUTHORIZED: '1',
          HEX_K12_LIVE_STATE_TASKS_AUTHORIZED: '1',
          HEX_K12_LIVE_PROVIDER: 'hexclaw-gpt',
          HEX_K12_LIVE_EXPECTED_PROVIDER_DISPLAY: 'HexClaw-GPT',
          HEX_K12_LIVE_MODEL: 'gpt-5.6-sol',
          HEX_K12_LIVE_AGENT: opaqueManifest.agent_name,
          HEX_K12_LIVE_APP_URL: releaseUIURL,
          HEX_K12_LIVE_SIDECAR_URL: sidecarURL,
          HEX_K12_LIVE_APP_BINARY: installedAppBinary,
          HEX_K12_LIVE_APP_SHA256: appSHA256,
          HEX_K12_LIVE_EXPECTED_VERSION: '0.5.0-beta',
          HEX_K12_LIVE_RETRYABLE_DISPATCH_ID: opaqueManifest.retryable_dispatch_id,
          HEX_K12_LIVE_OUTCOME_UNKNOWN_DISPATCH_ID: opaqueManifest.outcome_unknown_dispatch_id,
          HEX_K12_REAL_10X_CYCLE_ID: singleRealCycle,
          HEX_K12_REAL_10X_PARENT_OWNS_LIFECYCLE: '1',
        },
      },
    )
    if (playwright.status !== 0) {
      const childOutput = `${playwright.stdout}\n${playwright.stderr}`
      const terminalFailure = playwrightTerminalFailureFacts(childOutput)
      const recognitionCount = playwrightRecognitionCountFacts(childOutput)
      const sourceFact = playwrightSourceFactFacts(childOutput)
      const failureModelFacts = await modelInvocationFacts(storePath).catch(() => [])
      const gradingFailures = await gradingFailureFacts(storePath).catch(() => ({
        jobs: [],
        items: [],
      }))
      const failureDiagnostic = {
        c02_playwright_status: playwright.status,
        c02_playwright_failure_locations: playwrightFailureLocations(childOutput),
      }
      if (terminalFailure) failureDiagnostic.c02_terminal_failure = terminalFailure
      if (recognitionCount) failureDiagnostic.c02_recognition_count = recognitionCount
      if (sourceFact) failureDiagnostic.c02_recognition_source_fact = sourceFact
      if (failureModelFacts.length > 0) failureDiagnostic.model_invocations = failureModelFacts
      if (gradingFailures.jobs.length > 0) failureDiagnostic.grading_jobs = gradingFailures.jobs
      if (gradingFailures.items.length > 0) failureDiagnostic.grading_items = gradingFailures.items
      console.log(`# ${JSON.stringify(failureDiagnostic)}`)
    }
    assertPlaywrightSucceeded(playwright.status, singleRealCycle)

    await persistUnchangedLLMConfig()
    const runtimeConfigSHA256 = await fileSHA256(sidecarConfigPath)
    const stop = await runController('stop')
    assert.equal(stop.status, 0)
    await assertStopped(controllerConfig)
    assert.notEqual(
      runtimeConfigSHA256,
      preparedReceipt.config_sha256,
      'the real Sidecar must have persisted runtime YAML bytes for the mutable-config stop proof',
    )
    assert.equal(
      await fileSHA256(sidecarConfigPath),
      runtimeConfigSHA256,
      'the controller must not rewrite or restore runtime YAML during stop',
    )

    const modelFacts = await modelInvocationFacts(storePath)
    console.log(
      `# ${JSON.stringify({
        cycle: singleRealCycle,
        playwright_status: playwright.status,
        provider: 'hexclaw-gpt',
        model: 'gpt-5.6-sol',
        model_invocations: modelFacts,
        runtime_yaml_mutated: true,
        controller_stop_status: stop.status,
        pid_receipt_absent: true,
        lock_absent: true,
        listener_absent: true,
        health_absent: true,
        dingtalk_sends: 0,
      })}`,
    )
  },
)
