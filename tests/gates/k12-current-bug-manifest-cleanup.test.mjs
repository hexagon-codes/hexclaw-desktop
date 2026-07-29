import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  syntheticArtifactSHA256,
  syntheticGradingBudget,
  syntheticGradingCalibrationApproval,
  syntheticGradingCalibrationBytes,
  syntheticGradingCalibrationEnvironment,
  syntheticSidecarConfigSHA256,
} from './helpers/k12-grading-calibration-synthetic.mjs'

const repoFile = (path) => new URL(`../../${path}`, import.meta.url)

const requestedManifest = '/tmp/k12-cleanup/profile/fixture-manifest.json'
const canonicalManifest = '/private/tmp/k12-cleanup/profile/fixture-manifest.json'
const canonicalProfile = '/private/tmp/k12-cleanup/profile'
const digest = 'c'.repeat(64)

async function loadOrchestrator() {
  return import(repoFile('scripts/ci/k12-current-bug-fixture-orchestrator.mjs'))
}

function environment() {
  return {
    HEXCLAW_LOCAL_SRC: '/work/hexclaw',
    HEX_K12_LIVE_FIXTURE_PROFILE: '/tmp/k12-cleanup/profile',
    HEX_K12_LIVE_FIXTURE_STORE: '/tmp/k12-cleanup/profile/.hexclaw/data.db',
    HEX_K12_LIVE_FIXTURE_MANIFEST: requestedManifest,
    HEX_K12_LIVE_SIDECAR_CONTROL:
      '/work/hexclaw-desktop/scripts/ci/k12-current-bug-isolated-sidecar-control.mjs',
    HEX_K12_LIVE_SIDECAR_CONTROL_SHA256: 'a'.repeat(64),
    HEX_K12_LIVE_SIDECAR_CONTROL_CONFIG: '/tmp/k12-cleanup/controller.json',
    ...syntheticGradingCalibrationEnvironment('/tmp/k12-cleanup/grading-calibration.json'),
    HEX_K12_LIVE_APP_URL: 'http://localhost:16060',
    HEX_K12_LIVE_SIDECAR_URL: 'http://127.0.0.1:16129',
    HEX_K12_LIVE_APP_SHA256: 'e'.repeat(64),
    HEX_K12_REAL_10X_RUN_ID: 'opaque-run',
  }
}

function environmentAdapters(env = environment()) {
  const directories = new Set([env.HEXCLAW_LOCAL_SRC, env.HEX_K12_LIVE_FIXTURE_PROFILE])
  const modes = {
    [env.HEXCLAW_LOCAL_SRC]: 0o755,
    [env.HEX_K12_LIVE_FIXTURE_PROFILE]: 0o700,
    [env.HEX_K12_LIVE_FIXTURE_STORE]: 0o600,
    [env.HEX_K12_LIVE_SIDECAR_CONTROL]: 0o755,
    [env.HEX_K12_LIVE_SIDECAR_CONTROL_CONFIG]: 0o600,
    [env.HEX_K12_LIVE_GRADING_CALIBRATION_ARTIFACT]: 0o600,
  }
  return {
    inspectPath: (path) => ({
      kind:
        path === env.HEX_K12_LIVE_FIXTURE_MANIFEST
          ? 'missing'
          : directories.has(path)
            ? 'directory'
            : 'file',
      canonicalPath: path.replace(/^\/tmp\//, '/private/tmp/'),
      mode: modes[path],
      executable: path === env.HEX_K12_LIVE_SIDECAR_CONTROL,
      symlink: false,
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
      sidecarConfigSHA256: syntheticSidecarConfigSHA256,
    }),
    readGradingCalibrationBytes: () => syntheticGradingCalibrationBytes(),
    gradingCalibrationApproval: syntheticGradingCalibrationApproval(),
  }
}

test('cleanup contract freezes canonical receipt and child-nonzero deletion invariants', async () => {
  const contract = JSON.parse(
    await readFile(
      repoFile('tests/live/k12-current-bug-fixture-orchestrator.contract.json'),
      'utf8',
    ),
  )
  assert.deepEqual(contract.manifestCleanup, {
    order: [
      'fixture_cleanup_attempt',
      'manifest_receipt',
      'canonical_unlink',
      'alias_absence_verify',
    ],
    receiptExactFields: [
      'schema_version',
      'existed',
      'mode',
      'sha256',
      'canonical_alias_equal',
      'removed',
    ],
    deleteAfterFixtureCleanupNonzero: true,
    preserveRootError: true,
    printManifestValues: false,
  })
})

test('missing target keeps requested alias but derives one canonical manifest path', async () => {
  const { validateFixtureEnvironment } = await loadOrchestrator()
  const env = environment()
  const config = validateFixtureEnvironment(env, environmentAdapters(env))
  assert.equal(config.manifestRequestedPath, requestedManifest)
  assert.equal(config.manifestPath, canonicalManifest)
  assert.equal(config.profilePath, canonicalProfile)
})

test('safe cleanup hashes 0600 canonical target, unlinks once and verifies both aliases absent', async () => {
  const { removeCanonicalManifest } = await loadOrchestrator()
  let removed = false
  const events = []
  const receipt = await removeCanonicalManifest(
    {
      profilePath: canonicalProfile,
      manifestRequestedPath: requestedManifest,
      manifestPath: canonicalManifest,
    },
    {
      inspectPath: (path) => {
        events.push(['inspect', path])
        if (removed) return { exists: false }
        return {
          exists: true,
          symlink: false,
          regularFile: true,
          mode: 0o600,
          canonicalPath: canonicalManifest,
        }
      },
      fileSHA256: (path) => {
        events.push(['hash', path])
        return digest
      },
      unlinkFile: (path) => {
        events.push(['unlink', path])
        removed = true
      },
    },
  )

  assert.deepEqual(receipt, {
    schema_version: 1,
    existed: true,
    mode: '0600',
    sha256: digest,
    canonical_alias_equal: true,
    removed: true,
  })
  assert.deepEqual(
    events.filter(([event]) => event === 'unlink'),
    [['unlink', canonicalManifest]],
  )
  assert.equal(JSON.stringify(receipt).includes('opaque'), false)
  assert.equal(JSON.stringify(receipt).includes(requestedManifest), false)
})

test('browser and fixture-cleanup nonzero retain browser root while cleanup remains single-flight', async () => {
  const { createFixtureCleanup, runFixtureLifecycle } = await loadOrchestrator()
  const events = []
  const browserRoot = new Error('browser launch failed')
  const fixtureCleanupError = new Error('fixture subprocess failed')
  const receipt = {
    schema_version: 1,
    existed: true,
    mode: '0600',
    sha256: digest,
    canonical_alias_equal: true,
    removed: true,
  }
  const cleanup = createFixtureCleanup(
    {},
    {
      cleanupFixtureRecords: async () => {
        events.push('fixture_cleanup_attempt')
        throw fixtureCleanupError
      },
      removeManifest: async () => {
        events.push('canonical_unlink')
        return receipt
      },
      emitReceipt: (value) => {
        events.push(['receipt', value])
      },
    },
  )

  await assert.rejects(
    () =>
      runFixtureLifecycle(
        {},
        {
          stopSidecar: async () => events.push('sidecar_stop'),
          startFixture: async () => events.push('fixture_start'),
          readManifest: async () => ({
            retryableDispatchID: 'opaque-retryable',
            outcomeUnknownDispatchID: 'opaque-unknown',
          }),
          startSidecar: async () => events.push('sidecar_start'),
          runStrictGate: async () => {
            events.push('strict_child_nonzero')
            throw browserRoot
          },
          cleanupFixture: cleanup,
        },
      ),
    (error) => error === browserRoot,
  )
  await assert.rejects(
    () => Promise.all([cleanup(), cleanup()]),
    (error) => error === fixtureCleanupError,
  )

  assert.equal(events.filter((event) => event === 'fixture_cleanup_attempt').length, 1)
  assert.equal(events.filter((event) => event === 'canonical_unlink').length, 1)
  assert.equal(events.filter((event) => Array.isArray(event) && event[0] === 'receipt').length, 1)
})

test('unsafe manifest identity or permissions fail closed without unlink', async () => {
  const { removeCanonicalManifest } = await loadOrchestrator()
  for (const unsafe of [
    { symlink: true },
    { mode: 0o644 },
    { regularFile: false },
    { canonicalPath: '/private/tmp/outside/fixture-manifest.json' },
  ]) {
    let unlinked = false
    await assert.rejects(() =>
      removeCanonicalManifest(
        {
          profilePath: canonicalProfile,
          manifestRequestedPath: requestedManifest,
          manifestPath: canonicalManifest,
        },
        {
          inspectPath: () => ({
            exists: true,
            symlink: false,
            regularFile: true,
            mode: 0o600,
            canonicalPath: canonicalManifest,
            ...unsafe,
          }),
          fileSHA256: () => digest,
          unlinkFile: () => {
            unlinked = true
          },
        },
      ),
    )
    assert.equal(unlinked, false)
  }
})
