import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const repoFile = (path) => new URL(`../../${path}`, import.meta.url)

async function loadOrchestrator() {
  return import(repoFile('scripts/ci/k12-current-bug-fixture-orchestrator.mjs'))
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
    HEX_K12_LIVE_APP_URL: 'http://localhost:16060',
    HEX_K12_LIVE_SIDECAR_URL: 'http://127.0.0.1:16129',
    HEX_K12_LIVE_APP_SHA256: 'e'.repeat(64),
    HEX_K12_LIVE_RUN_ID: 'current-bug-cycle-C01',
    HEX_K12_LIVE_PROVIDER: 'hexclaw-gpt',
    HEX_K12_LIVE_MODEL: 'gpt-5.6-sol',
  }
}

function pathAdapters(env = environment()) {
  const directories = new Set([
    env.HEXCLAW_LOCAL_SRC,
    env.HEX_K12_LIVE_FIXTURE_PROFILE,
  ])
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
    fileSHA256: () => env.HEX_K12_LIVE_SIDECAR_CONTROL_SHA256,
    readControllerRuntimeContract: () => ({
      releaseUIURL: env.HEX_K12_LIVE_APP_URL,
      sidecarURL: env.HEX_K12_LIVE_SIDECAR_URL,
      installedAppSHA256: env.HEX_K12_LIVE_APP_SHA256,
    }),
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
  assert.deepEqual(contract.injectedEnvironment, [
    'HEX_K12_LIVE_RETRYABLE_DISPATCH_ID',
    'HEX_K12_LIVE_OUTCOME_UNKNOWN_DISPATCH_ID',
  ])
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
        kind: path === env.HEX_K12_LIVE_FIXTURE_MANIFEST ? 'file' : pathAdapters(env).inspectPath(path).kind,
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
  assert.deepEqual(Object.keys(handoff), [
    'retryableDispatchID',
    'outcomeUnknownDispatchID',
  ])
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

test('lifecycle runs stop-build-start-gate-stop-cleanup and injects exactly two IDs', async () => {
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
    'fixture_cleanup',
  ])
  assert.deepEqual(gateEnvironment, {
    HEX_K12_LIVE_RETRYABLE_DISPATCH_ID: 'opaque-retryable',
    HEX_K12_LIVE_OUTCOME_UNKNOWN_DISPATCH_ID: 'opaque-unknown',
  })
  assert.deepEqual(result, { status: 0 })
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
  const source = await readFile(
    repoFile('tests/live/k12-current-bug-real-matrix.spec.ts'),
    'utf8',
  )
  assert.match(source, /resolveFixtureAgent/)
  assert.match(source, /fixture ownership resolution failed/)
  assert.doesNotMatch(source, /HEX_K12_LIVE_FIXTURE_AGENT/)
})
