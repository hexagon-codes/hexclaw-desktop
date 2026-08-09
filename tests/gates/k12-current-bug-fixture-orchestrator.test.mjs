import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import {
  syntheticArtifactSHA256,
  syntheticGradingBudget,
  syntheticGradingCalibrationApproval,
  syntheticGradingCalibrationArtifact,
  syntheticGradingCalibrationBytes,
  syntheticGradingCalibrationEnvironment,
  syntheticSidecarConfigSHA256,
} from './helpers/k12-grading-calibration-synthetic.mjs'
import {
  syntheticRecognitionArtifactSHA256,
  syntheticRecognitionCalibrationApproval,
  syntheticRecognitionCalibrationArtifact,
  syntheticRecognitionCalibrationBytes,
  syntheticRecognitionCalibrationEnvironment,
  syntheticRecognitionPolicy,
} from './helpers/k12-recognition-calibration-synthetic.mjs'

const repoFile = (path) => new URL(`../../${path}`, import.meta.url)

async function loadOrchestrator() {
  return import(repoFile('scripts/ci/k12-current-bug-fixture-orchestrator.mjs'))
}

function sha256(raw) {
  return createHash('sha256').update(raw).digest('hex')
}

function environment() {
  return {
    HEXCLAW_LOCAL_SRC: '/work/hexclaw',
    HEX_K12_LIVE_FIXTURE_PROFILE: '/tmp/hexclaw-current-bug/profile',
    HEX_K12_LIVE_FIXTURE_STORE: '/tmp/hexclaw-current-bug/profile/.hexclaw/data.db',
    HEX_K12_LIVE_FIXTURE_MANIFEST: '/tmp/hexclaw-current-bug/profile/fixture.json',
    HEX_K12_LIVE_SIDECAR_CONTROL: '/opt/hexclaw-test/sidecar-control',
    HEX_K12_LIVE_SIDECAR_CONTROL_SHA256: 'a'.repeat(64),
    HEX_K12_LIVE_SIDECAR_CONTROL_CONFIG: '/tmp/hexclaw-current-bug/control.json',
    ...syntheticGradingCalibrationEnvironment('/tmp/hexclaw-current-bug/grading-calibration.json'),
    HEX_K12_LIVE_APP_URL: 'http://localhost:16060',
    HEX_K12_LIVE_SIDECAR_URL: 'http://127.0.0.1:16129',
    HEX_K12_LIVE_APP_SHA256: 'e'.repeat(64),
    HEX_K12_LIVE_RUN_ID: 'current-bug-cycle-C01',
    HEX_K12_LIVE_PROVIDER: 'hexclaw-gpt',
    HEX_K12_LIVE_MODEL: 'gpt-5.6-sol',
  }
}

function recognitionEnvironment() {
  const env = {
    ...environment(),
    ...syntheticRecognitionCalibrationEnvironment(
      '/tmp/hexclaw-current-bug/recognition-calibration.json',
    ),
  }
  delete env.HEX_K12_LIVE_GRADING_CALIBRATION_ARTIFACT
  delete env.HEX_K12_LIVE_GRADING_CALIBRATION_SHA256
  return env
}

function pathAdapters(env = environment()) {
  const directories = new Set([env.HEXCLAW_LOCAL_SRC, env.HEX_K12_LIVE_FIXTURE_PROFILE])
  return {
    inspectPath: (path) => ({
      kind: directories.has(path)
        ? 'directory'
        : path === env.HEX_K12_LIVE_FIXTURE_MANIFEST
          ? 'missing'
          : 'file',
      canonicalPath: path.replace(/^\/tmp\//, '/private/tmp/'),
      executable: path === env.HEX_K12_LIVE_SIDECAR_CONTROL,
      mode: path === env.HEX_K12_LIVE_FIXTURE_PROFILE ? 0o700 : 0o600,
    }),
    fileSHA256: (path) =>
      path.endsWith('/grading-calibration.json')
        ? syntheticArtifactSHA256
        : env.HEX_K12_LIVE_SIDECAR_CONTROL_SHA256,
    readControllerRuntimeContract: () => ({
      releaseUIURL: env.HEX_K12_LIVE_APP_URL,
      sidecarURL: env.HEX_K12_LIVE_SIDECAR_URL,
      installedAppSHA256: env.HEX_K12_LIVE_APP_SHA256,
      gradingBudget: syntheticGradingBudget(),
      recognitionPolicy: syntheticRecognitionPolicy(),
      sidecarConfigSHA256: syntheticSidecarConfigSHA256,
    }),
    readGradingCalibrationBytes: () => syntheticGradingCalibrationBytes(),
    gradingCalibrationApproval: syntheticGradingCalibrationApproval(),
    readRecognitionCalibrationBytes: () => syntheticRecognitionCalibrationBytes(),
    recognitionCalibrationApproval: syntheticRecognitionCalibrationApproval(),
  }
}

function rawCalibrationAdapters(env, raw) {
  const adapters = pathAdapters(env)
  const digest = sha256(raw)
  return {
    ...adapters,
    fileSHA256: (path) =>
      path.endsWith('/grading-calibration.json') ? digest : env.HEX_K12_LIVE_SIDECAR_CONTROL_SHA256,
    readGradingCalibrationBytes: () => Buffer.from(raw),
    readGradingCalibrationArtifact: () => JSON.parse(raw),
    gradingCalibrationApproval: syntheticGradingCalibrationApproval({
      artifact_sha256: digest,
    }),
  }
}

function environmentForRawCalibration(raw) {
  return {
    ...environment(),
    HEX_K12_LIVE_GRADING_CALIBRATION_SHA256: sha256(raw),
  }
}

function manifest(overrides = {}) {
  return {
    schema_version: 1,
    ownership: 'opaque-ownership',
    agent_name: 'opaque-agent',
    retryable_dispatch_id: 'opaque-retryable',
    outcome_unknown_dispatch_id: 'opaque-unknown',
    lease_expires_at: 2_000_000_000,
    ...overrides,
  }
}

test('fixture orchestration contract freezes explicit inputs, exact sequence and two-ID handoff', async () => {
  const contract = JSON.parse(
    await readFile(
      repoFile('tests/live/k12-current-bug-fixture-orchestrator.contract.json'),
      'utf8',
    ),
  )

  assert.equal(contract.schemaVersion, 1)
  assert.deepEqual(contract.sequence, [
    'sidecar_stop',
    'fixture_start',
    'manifest_validate',
    'sidecar_start',
    'strict_gate',
    'sidecar_stop',
    'fixture_cleanup',
  ])
  assert.deepEqual(contract.recognitionOnlySequence, [
    'sidecar_stop',
    'fixture_start',
    'manifest_validate',
    'sidecar_start',
    'strict_gate',
    'sidecar_stop',
    'recognition_v2_evidence',
    'fixture_cleanup',
  ])
  assert.deepEqual(contract.builderCommand, [
    'go',
    'run',
    '-tags',
    'testtools',
    './cmd/k12-live-fixture-testtools',
  ])
  assert.deepEqual(contract.manifestExactFields, [
    'schema_version',
    'ownership',
    'agent_name',
    'retryable_dispatch_id',
    'outcome_unknown_dispatch_id',
    'lease_expires_at',
  ])
  assert.deepEqual(contract.recognitionOnlyInjectedEnvironment, [
    'HEX_K12_LIVE_RECOGNITION_V2_CLAIM',
  ])
  assert.deepEqual(contract.recognitionOnlyRequiredEnvironment, [
    'HEX_K12_LIVE_RECOGNITION_CALIBRATION_ARTIFACT',
    'HEX_K12_LIVE_RECOGNITION_CALIBRATION_SHA256',
  ])
  assert.deepEqual(contract.injectedEnvironment, [
    'HEX_K12_LIVE_RETRYABLE_DISPATCH_ID',
    'HEX_K12_LIVE_OUTCOME_UNKNOWN_DISPATCH_ID',
  ])
  assert.deepEqual(contract.gradingRequiredEnvironment, [
    'HEX_K12_LIVE_GRADING_CALIBRATION_ARTIFACT',
    'HEX_K12_LIVE_GRADING_CALIBRATION_SHA256',
  ])
  assert.equal(
    contract.requiredEnvironment.includes('HEX_K12_LIVE_GRADING_CALIBRATION_ARTIFACT'),
    false,
  )
  assert.equal(contract.subprocess.shell, false)
  assert.equal(contract.subprocess.dingTalkLiveSend, '0')
})

test('environment validation rejects implicit source, unsafe paths, stale manifest and controller drift', async () => {
  const { validateFixtureEnvironment } = await loadOrchestrator()
  const env = environment()
  const value = validateFixtureEnvironment(env, pathAdapters(env))
  assert.equal(value.localSource, env.HEXCLAW_LOCAL_SRC)
  assert.equal(value.profile, env.HEX_K12_LIVE_FIXTURE_PROFILE)

  for (const mutation of [
    { HEXCLAW_LOCAL_SRC: '' },
    { HEXCLAW_LOCAL_SRC: 'relative/hexclaw' },
    { HEX_K12_LIVE_FIXTURE_PROFILE: '/Users/real/.hexclaw' },
    { HEX_K12_LIVE_FIXTURE_STORE: '/Users/real/.hexclaw/data.db' },
    { HEX_K12_LIVE_FIXTURE_MANIFEST: '/Users/real/fixture.json' },
    { HEX_K12_LIVE_SIDECAR_CONTROL_CONFIG: '/Users/real/control.json' },
    { HEX_K12_LIVE_SIDECAR_CONTROL_SHA256: 'bad' },
  ]) {
    const changed = { ...env, ...mutation }
    assert.throws(() => validateFixtureEnvironment(changed, pathAdapters(changed)))
  }
  assert.throws(() =>
    validateFixtureEnvironment(env, {
      ...pathAdapters(env),
      inspectPath: (path) => ({
        ...pathAdapters(env).inspectPath(path),
        kind:
          path === env.HEX_K12_LIVE_FIXTURE_MANIFEST
            ? 'file'
            : pathAdapters(env).inspectPath(path).kind,
      }),
    }),
  )
  assert.throws(() =>
    validateFixtureEnvironment(env, {
      ...pathAdapters(env),
      fileSHA256: () => '0'.repeat(64),
    }),
  )
})

test('environment validation blocks the REAL child when approved grading calibration identity is absent', async () => {
  const { validateFixtureEnvironment } = await loadOrchestrator()
  const env = environment()
  for (const mutation of [
    { HEX_K12_LIVE_GRADING_CALIBRATION_ARTIFACT: '' },
    { HEX_K12_LIVE_GRADING_CALIBRATION_SHA256: '' },
  ]) {
    const changed = { ...env, ...mutation }
    assert.throws(
      () => validateFixtureEnvironment(changed, pathAdapters(changed)),
      /GRADING_CALIBRATION|grading calibration/i,
    )
  }
})

test('environment validation requires a trusted approval root bound to artifact and release config digests', async () => {
  const { validateFixtureEnvironment } = await loadOrchestrator()
  const env = environment()
  for (const gradingCalibrationApproval of [
    undefined,
    syntheticGradingCalibrationApproval({
      artifact_sha256: '0'.repeat(64),
    }),
    syntheticGradingCalibrationApproval({
      release_config_sha256: '0'.repeat(64),
    }),
  ]) {
    assert.throws(
      () =>
        validateFixtureEnvironment(env, {
          ...pathAdapters(env),
          gradingCalibrationApproval,
        }),
      /grading calibration/i,
    )
  }
})

test('environment validation rejects mock, incomplete and release-drifted grading calibration artifacts', async () => {
  const { validateFixtureEnvironment } = await loadOrchestrator()
  const env = environment()
  const mutations = [
    { approval_status: 'draft' },
    { provider: 'other-provider' },
    { model: 'other-model' },
    {
      grading_budget: {
        ...syntheticGradingBudget(),
        item_concurrency: 3,
      },
    },
    {
      measurements: syntheticGradingCalibrationArtifact().measurements.slice(0, 3),
    },
    {
      measurements: syntheticGradingCalibrationArtifact().measurements.map((measurement, index) =>
        index === 0 ? { ...measurement, p95_ms: 17_001 } : measurement,
      ),
    },
    { unknown_field: true },
  ]
  for (const mutation of mutations) {
    assert.throws(
      () =>
        validateFixtureEnvironment(env, {
          ...pathAdapters(env),
          readGradingCalibrationBytes: () => syntheticGradingCalibrationBytes(mutation),
        }),
      /grading calibration/i,
    )
  }
})

test('recognition-only preflight requires an independent approved recognizing v2 artifact', async () => {
  const { validateFixtureEnvironment } = await loadOrchestrator()
  const env = recognitionEnvironment()
  const adapters = {
    ...pathAdapters(env),
    requireRecognitionV2: true,
  }
  const validated = validateFixtureEnvironment(env, adapters)
  assert.deepEqual(validated.recognitionPolicy, syntheticRecognitionPolicy())
  assert.equal(validated.recognitionCalibrationSHA256, syntheticRecognitionArtifactSHA256)

  for (const recognitionCalibrationApproval of [
    undefined,
    syntheticGradingCalibrationApproval(),
    syntheticRecognitionCalibrationApproval({ stage: 'assessing' }),
    syntheticRecognitionCalibrationApproval({ recognition_plan_version: 1 }),
    syntheticRecognitionCalibrationApproval({ artifact_sha256: '0'.repeat(64) }),
    syntheticRecognitionCalibrationApproval({ release_config_sha256: '0'.repeat(64) }),
  ]) {
    assert.throws(
      () =>
        validateFixtureEnvironment(env, {
          ...adapters,
          recognitionCalibrationApproval,
        }),
      /recognition calibration|recognition v2/i,
    )
  }
})

test('recognition-only preflight rejects artifact and release v2 policy drift before fixture work', async () => {
  const { validateFixtureEnvironment } = await loadOrchestrator()
  const env = recognitionEnvironment()
  const base = {
    ...pathAdapters(env),
    requireRecognitionV2: true,
  }
  const artifactMutations = [
    { stage: 'assessing' },
    { recognition_plan_version: 1 },
    { provider: 'other-provider' },
    { model: 'other-model' },
    { physical_call_timeout_ms: 119_999 },
    { adapter_worker_hard_cap: 3 },
    { release_effective_concurrency: 2 },
    {
      budget_buckets_millis: {
        ...syntheticRecognitionPolicy().budget_buckets_millis,
        up_to_16_problems_millis: 119_999,
      },
    },
    {
      measurements: syntheticRecognitionCalibrationArtifact().measurements.slice(0, 3),
    },
    {
      measurements: syntheticRecognitionCalibrationArtifact().measurements.map(
        (measurement, index, measurements) =>
          index === 1
            ? { ...measurement, source_fixture_sha256: measurements[0].source_fixture_sha256 }
            : measurement,
      ),
    },
    {
      measurements: syntheticRecognitionCalibrationArtifact().measurements.map(
        (measurement, index) =>
          index === 0 ? { ...measurement, sample_count: 4, success_count: 4 } : measurement,
      ),
    },
    {
      measurements: syntheticRecognitionCalibrationArtifact().measurements.map(
        (measurement, index) => (index === 2 ? { ...measurement, complete: false } : measurement),
      ),
    },
    { unknown_field: true },
  ]
  for (const mutation of artifactMutations) {
    const bytes = Buffer.from(JSON.stringify(syntheticRecognitionCalibrationArtifact(mutation)))
    const digest = sha256(bytes)
    assert.throws(
      () =>
        validateFixtureEnvironment(
          {
            ...env,
            HEX_K12_LIVE_RECOGNITION_CALIBRATION_SHA256: digest,
          },
          {
            ...base,
            readRecognitionCalibrationBytes: () => bytes,
            recognitionCalibrationApproval: syntheticRecognitionCalibrationApproval({
              artifact_sha256: digest,
            }),
          },
        ),
      /recognition calibration|recognition v2/i,
    )
  }

  for (const recognitionPolicy of [
    undefined,
    syntheticRecognitionPolicy({ physical_call_cap_millis: 119_999 }),
    syntheticRecognitionPolicy({ adapter_worker_hard_cap: 3 }),
    syntheticRecognitionPolicy({ effective_concurrency: 2 }),
    syntheticRecognitionPolicy({
      budget_buckets_millis: {
        ...syntheticRecognitionPolicy().budget_buckets_millis,
        up_to_32_problems_millis: 239_999,
      },
    }),
  ]) {
    assert.throws(
      () =>
        validateFixtureEnvironment(env, {
          ...base,
          readControllerRuntimeContract: () => ({
            ...base.readControllerRuntimeContract(),
            recognitionPolicy,
          }),
        }),
      /recognition|v2/i,
    )
  }
})

test('environment validation rejects ordinary and Unicode-equivalent duplicate calibration keys', async () => {
  const { validateFixtureEnvironment } = await loadOrchestrator()
  const canonical = JSON.stringify(syntheticGradingCalibrationArtifact())
  const duplicateArtifacts = [
    canonical.replace(
      '"provider":"hexclaw-gpt"',
      '"provider":"unreviewed-provider","provider":"hexclaw-gpt"',
    ),
    canonical.replace(
      '"provider":"hexclaw-gpt"',
      '"pro\\u0076ider":"unreviewed-provider","provider":"hexclaw-gpt"',
    ),
  ]

  for (const raw of duplicateArtifacts) {
    const env = environmentForRawCalibration(raw)
    assert.throws(
      () => validateFixtureEnvironment(env, rawCalibrationAdapters(env, raw)),
      /grading calibration.*duplicate/i,
    )
  }
})

test('environment validation rejects duplicate keys nested in grading budget and measurements', async () => {
  const { validateFixtureEnvironment } = await loadOrchestrator()
  const canonical = JSON.stringify(syntheticGradingCalibrationArtifact())
  const duplicateArtifacts = [
    canonical.replace(
      '"recognizing_seconds":13',
      '"recognizing_seconds":999,"recognizing_seconds":13',
    ),
    canonical.replace('"complete":true', '"complete":false,"complete":true'),
  ]

  for (const raw of duplicateArtifacts) {
    const env = environmentForRawCalibration(raw)
    assert.throws(
      () => validateFixtureEnvironment(env, rawCalibrationAdapters(env, raw)),
      /grading calibration.*duplicate/i,
    )
  }
})

test('environment validation hashes and parses one calibration byte snapshot', async () => {
  const { validateFixtureEnvironment } = await loadOrchestrator()
  const attestedRaw = JSON.stringify(syntheticGradingCalibrationArtifact())
  const replacedArtifact = syntheticGradingCalibrationArtifact({
    evidence_sha256: '9'.repeat(64),
  })
  const env = environmentForRawCalibration(attestedRaw)
  const adapters = rawCalibrationAdapters(env, attestedRaw)
  let byteReads = 0
  let legacyParsedReads = 0

  validateFixtureEnvironment(env, {
    ...adapters,
    readGradingCalibrationBytes: () => {
      byteReads += 1
      return Buffer.from(attestedRaw)
    },
    readGradingCalibrationArtifact: () => {
      legacyParsedReads += 1
      return replacedArtifact
    },
  })

  assert.equal(byteReads, 1)
  assert.equal(legacyParsedReads, 0)
})

test('default calibration reader rechecks 0600 on the opened file descriptor', async (t) => {
  const { validateFixtureEnvironment } = await loadOrchestrator()
  const raw = JSON.stringify(syntheticGradingCalibrationArtifact())
  const directory = mkdtempSync(join(tmpdir(), 'hexclaw-calibration-mode-'))
  const calibrationPath = join(directory, 'grading-calibration.json')
  writeFileSync(calibrationPath, raw, { mode: 0o600 })
  t.after(() => rmSync(directory, { recursive: true, force: true }))

  const env = {
    ...environmentForRawCalibration(raw),
    HEX_K12_LIVE_GRADING_CALIBRATION_ARTIFACT: calibrationPath,
  }
  const adapters = rawCalibrationAdapters(env, raw)
  delete adapters.readGradingCalibrationBytes
  delete adapters.readGradingCalibrationArtifact
  adapters.inspectPath = (path) =>
    path === calibrationPath
      ? { kind: 'file', canonicalPath: calibrationPath, mode: 0o600 }
      : pathAdapters(env).inspectPath(path)
  adapters.readControllerRuntimeContract = () => {
    chmodSync(calibrationPath, 0o644)
    return pathAdapters(env).readControllerRuntimeContract()
  }

  assert.throws(() => validateFixtureEnvironment(env, adapters), /grading calibration.*0600/i)
})

test('default calibration reader refuses a final-component symlink replacement', async (t) => {
  const { validateFixtureEnvironment } = await loadOrchestrator()
  const raw = JSON.stringify(syntheticGradingCalibrationArtifact())
  const directory = mkdtempSync(join(tmpdir(), 'hexclaw-calibration-link-'))
  const calibrationPath = join(directory, 'grading-calibration.json')
  const replacementPath = join(directory, 'replacement.json')
  writeFileSync(calibrationPath, raw, { mode: 0o600 })
  writeFileSync(replacementPath, raw, { mode: 0o600 })
  t.after(() => rmSync(directory, { recursive: true, force: true }))

  const env = {
    ...environmentForRawCalibration(raw),
    HEX_K12_LIVE_GRADING_CALIBRATION_ARTIFACT: calibrationPath,
  }
  const adapters = rawCalibrationAdapters(env, raw)
  delete adapters.readGradingCalibrationBytes
  delete adapters.readGradingCalibrationArtifact
  adapters.inspectPath = (path) =>
    path === calibrationPath
      ? { kind: 'file', canonicalPath: calibrationPath, mode: 0o600 }
      : pathAdapters(env).inspectPath(path)
  adapters.readControllerRuntimeContract = () => {
    unlinkSync(calibrationPath)
    symlinkSync(replacementPath, calibrationPath)
    return pathAdapters(env).readControllerRuntimeContract()
  }

  assert.throws(
    () => validateFixtureEnvironment(env, adapters),
    /grading calibration.*(symbolic|secure)/i,
  )
})

test('0600 exact manifest exposes only the two dispatch IDs', async () => {
  const { readOpaqueManifest } = await loadOrchestrator()
  const raw = JSON.stringify(manifest())
  const handoff = readOpaqueManifest(raw, {
    mode: 0o600,
    regularFile: true,
    manifestPath: '/tmp/hexclaw-current-bug/profile/fixture.json',
    profilePath: '/tmp/hexclaw-current-bug/profile',
    nowSeconds: 1_900_000_000,
  })

  assert.deepEqual(handoff, {
    retryableDispatchID: 'opaque-retryable',
    outcomeUnknownDispatchID: 'opaque-unknown',
  })
  assert.deepEqual(Object.keys(handoff), ['retryableDispatchID', 'outcomeUnknownDispatchID'])
  for (const mutation of [
    { extra: 'forbidden' },
    { retryable_dispatch_id: '' },
    { outcome_unknown_dispatch_id: 'opaque-retryable' },
    { lease_expires_at: 1_800_000_000 },
  ]) {
    assert.throws(() =>
      readOpaqueManifest(JSON.stringify(manifest(mutation)), {
        mode: 0o600,
        regularFile: true,
        manifestPath: '/tmp/hexclaw-current-bug/profile/fixture.json',
        profilePath: '/tmp/hexclaw-current-bug/profile',
        nowSeconds: 1_900_000_000,
      }),
    )
  }
  assert.throws(() =>
    readOpaqueManifest(raw, {
      mode: 0o644,
      regularFile: true,
      manifestPath: '/tmp/hexclaw-current-bug/profile/fixture.json',
      profilePath: '/tmp/hexclaw-current-bug/profile',
      nowSeconds: 1_900_000_000,
    }),
  )
})

test('lifecycle runs stop-build-start-gate-stop-evidence-cleanup and injects exactly two IDs', async () => {
  const { runFixtureLifecycle } = await loadOrchestrator()
  const events = []
  let gateEnvironment
  const result = await runFixtureLifecycle(
    { runID: 'cycle-1' },
    {
      stopSidecar: async () => events.push('sidecar_stop'),
      startFixture: async () => events.push('fixture_start'),
      readManifest: async () => {
        events.push('manifest_validate')
        return {
          retryableDispatchID: 'opaque-retryable',
          outcomeUnknownDispatchID: 'opaque-unknown',
        }
      },
      startSidecar: async () => events.push('sidecar_start'),
      runStrictGate: async (overlay) => {
        events.push('strict_gate')
        gateEnvironment = overlay
        return { status: 0 }
      },
      collectStoppedEvidence: async () => events.push('recognition_v2_evidence'),
      cleanupFixture: async () => events.push('fixture_cleanup'),
    },
  )

  assert.deepEqual(events, [
    'sidecar_stop',
    'fixture_start',
    'manifest_validate',
    'sidecar_start',
    'strict_gate',
    'sidecar_stop',
    'recognition_v2_evidence',
    'fixture_cleanup',
  ])
  assert.deepEqual(gateEnvironment, {
    HEX_K12_LIVE_RETRYABLE_DISPATCH_ID: 'opaque-retryable',
    HEX_K12_LIVE_OUTCOME_UNKNOWN_DISPATCH_ID: 'opaque-unknown',
  })
  assert.deepEqual(result, { status: 0 })
})

test('recognition-only collector invokes one testtools command and parses only its JSON receipt', async () => {
  const { createFixtureRuntime } = await loadOrchestrator()
  let invocation
  const spawnProcess = (command, args, options) => {
    invocation = { command, args, options }
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.exitCode = null
    child.signalCode = null
    child.kill = () => true
    queueMicrotask(() => {
      child.stdout.end('{"schema_version":1}\n')
      child.stderr.end()
      child.exitCode = 0
      child.emit('close', 0)
    })
    return child
  }
  const runtime = createFixtureRuntime(
    {
      profilePath: '/tmp/hexclaw-current-bug/profile',
      storePath: '/tmp/hexclaw-current-bug/profile/.hexclaw/data.db',
      manifestPath: '/tmp/hexclaw-current-bug/profile/fixture.json',
      localSource: '/work/hexclaw',
      controllerPath: '/controller',
      controllerConfigPath: '/controller.json',
      runID: 'run',
      learnerID: 'learner',
      provider: 'hexclaw-gpt',
      model: 'gpt-5.6-sol',
    },
    { spawnProcess },
  )

  assert.deepEqual(await runtime.collectRecognitionV2Evidence(), { schema_version: 1 })
  assert.equal(invocation.command, 'go')
  assert.deepEqual(invocation.args, [
    'run',
    '-tags',
    'testtools',
    './cmd/k12-live-fixture-testtools',
    'recognition-v2-finalization-evidence',
    '--profile',
    '/tmp/hexclaw-current-bug/profile',
    '--store',
    '/tmp/hexclaw-current-bug/profile/.hexclaw/data.db',
    '--manifest',
    '/tmp/hexclaw-current-bug/profile/fixture.json',
    '--claim',
    '/tmp/hexclaw-current-bug/profile/recognition-v2-target-claim.json',
  ])
  assert.equal(invocation.options.shell, false)
  assert.deepEqual(invocation.options.stdio, ['ignore', 'pipe', 'pipe'])
  assert.equal(invocation.options.cwd, '/work/hexclaw')
  assert.equal(invocation.options.env.DINGTALK_LIVE_SEND, '0')
})

test('recognition-only cleanup consumes the published target claim before unlinking it', async () => {
  const { createFixtureRuntime } = await loadOrchestrator()
  const profilePath = mkdtempSync(join(tmpdir(), 'hexclaw-k12-claim-cleanup-'))
  chmodSync(profilePath, 0o700)
  const claimPath = join(profilePath, 'recognition-v2-target-claim.json')
  writeFileSync(claimPath, '{"schema_version":1}\n', { mode: 0o600 })
  const invocations = []
  const spawnProcess = (command, args, options) => {
    invocations.push({ command, args, options })
    const child = new EventEmitter()
    child.exitCode = null
    child.signalCode = null
    child.kill = () => true
    queueMicrotask(() => {
      child.exitCode = 0
      child.emit('exit', 0, null)
    })
    return child
  }
  const config = {
    profilePath,
    storePath: join(profilePath, '.hexclaw', 'data.db'),
    manifestPath: join(profilePath, 'fixture.json'),
    localSource: '/work/hexclaw',
    controllerPath: '/controller',
    controllerConfigPath: '/controller.json',
    runID: 'run',
    learnerID: 'learner',
    provider: 'hexclaw-gpt',
    model: 'gpt-5.6-sol',
  }

  try {
    const runtime = createFixtureRuntime(config, { spawnProcess })

    await runtime.cleanupFixture()

    assert.equal(invocations.length, 1)
    assert.deepEqual(invocations[0].args.slice(-2), ['--claim', claimPath])
    assert.equal(existsSync(claimPath), false)

    invocations.length = 0
    const noClaimRuntime = createFixtureRuntime(config, { spawnProcess })
    await noClaimRuntime.cleanupFixture()
    assert.equal(invocations.length, 1)
    assert.equal(invocations[0].args.includes('--claim'), false)
  } finally {
    rmSync(profilePath, { recursive: true, force: true })
  }
})

test('failed claim-aware cleanup preserves the claim for an explicit retry', async () => {
  const { createFixtureRuntime } = await loadOrchestrator()
  const profilePath = mkdtempSync(join(tmpdir(), 'hexclaw-k12-claim-retry-'))
  chmodSync(profilePath, 0o700)
  const claimPath = join(profilePath, 'recognition-v2-target-claim.json')
  writeFileSync(claimPath, '{"schema_version":1}\n', { mode: 0o600 })
  const spawnProcess = () => {
    const child = new EventEmitter()
    child.exitCode = null
    child.signalCode = null
    child.kill = () => true
    queueMicrotask(() => {
      child.exitCode = 1
      child.emit('exit', 1, null)
    })
    return child
  }

  try {
    const runtime = createFixtureRuntime(
      {
        profilePath,
        storePath: join(profilePath, '.hexclaw', 'data.db'),
        manifestPath: join(profilePath, 'fixture.json'),
        localSource: '/work/hexclaw',
        controllerPath: '/controller',
        controllerConfigPath: '/controller.json',
        runID: 'run',
        learnerID: 'learner',
        provider: 'hexclaw-gpt',
        model: 'gpt-5.6-sol',
      },
      { spawnProcess },
    )

    await assert.rejects(runtime.cleanupFixture(), /fixture subprocess failed/i)
    assert.equal(existsSync(claimPath), true)
  } finally {
    rmSync(profilePath, { recursive: true, force: true })
  }
})

test('gate/start failure preserves the root error while stop and cleanup remain mandatory', async () => {
  const { runFixtureLifecycle } = await loadOrchestrator()
  for (const failAt of ['sidecar_start', 'strict_gate']) {
    const events = []
    const root = new Error(`root-${failAt}`)
    await assert.rejects(
      runFixtureLifecycle(
        { runID: 'cycle-failure' },
        {
          stopSidecar: async () => events.push('sidecar_stop'),
          startFixture: async () => events.push('fixture_start'),
          readManifest: async () => ({
            retryableDispatchID: 'opaque-retryable',
            outcomeUnknownDispatchID: 'opaque-unknown',
          }),
          startSidecar: async () => {
            events.push('sidecar_start')
            if (failAt === 'sidecar_start') throw root
          },
          runStrictGate: async () => {
            events.push('strict_gate')
            throw root
          },
          cleanupFixture: async () => events.push('fixture_cleanup'),
        },
      ),
      (error) => error === root,
    )
    assert.deepEqual(events.slice(-2), ['sidecar_stop', 'fixture_cleanup'])
  }
})

test('stopped-evidence failure remains terminal and cleanup still runs', async () => {
  const { runFixtureLifecycle } = await loadOrchestrator()
  const events = []
  const root = new Error('stopped-evidence-invalid')
  await assert.rejects(
    runFixtureLifecycle(
      { runID: 'cycle-evidence-failure' },
      {
        stopSidecar: async () => events.push('sidecar_stop'),
        startFixture: async () => events.push('fixture_start'),
        readManifest: async () => ({
          retryableDispatchID: 'opaque-retryable',
          outcomeUnknownDispatchID: 'opaque-unknown',
        }),
        startSidecar: async () => events.push('sidecar_start'),
        runStrictGate: async () => {
          events.push('strict_gate')
          return { playwrightStatus: 0, auditPassed: true }
        },
        collectStoppedEvidence: async () => {
          events.push('recognition_v2_evidence')
          throw root
        },
        cleanupFixture: async () => events.push('fixture_cleanup'),
      },
    ),
    (error) => error === root,
  )
  assert.deepEqual(events, [
    'sidecar_stop',
    'fixture_start',
    'sidecar_start',
    'strict_gate',
    'sidecar_stop',
    'recognition_v2_evidence',
    'fixture_cleanup',
  ])
})

test('signal handler cancels the active child then performs single-flight stop and cleanup', async () => {
  const { installFixtureSignalCleanup } = await loadOrchestrator()
  const processLike = new EventEmitter()
  processLike.exitCode = 0
  const events = []
  const uninstall = installFixtureSignalCleanup(processLike, {
    cancelActive: async () => events.push('cancel_active'),
    cleanup: async () => {
      events.push('sidecar_stop')
      events.push('fixture_cleanup')
    },
  })
  processLike.emit('SIGINT')
  processLike.emit('SIGTERM')
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(events, ['cancel_active', 'sidecar_stop', 'fixture_cleanup'])
  assert.equal(processLike.exitCode, 130)
  uninstall()
})

test('current-bug state case resolves fixture owner without manifest agent injection', async () => {
  const source = await readFile(repoFile('tests/live/k12-current-bug-real-matrix.spec.ts'), 'utf8')
  assert.match(source, /resolveFixtureAgent/)
  assert.match(source, /fixture ownership resolution failed/)
  assert.doesNotMatch(source, /HEX_K12_LIVE_FIXTURE_AGENT/)
})
