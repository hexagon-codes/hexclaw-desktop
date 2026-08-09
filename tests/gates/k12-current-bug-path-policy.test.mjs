import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
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

function environment() {
  return {
    HEXCLAW_LOCAL_SRC: '/work/hexclaw',
    HEX_K12_LIVE_FIXTURE_PROFILE: '/tmp/k12-path-policy/profile',
    HEX_K12_LIVE_FIXTURE_STORE: '/tmp/k12-path-policy/profile/.hexclaw/data.db',
    HEX_K12_LIVE_FIXTURE_MANIFEST: '/tmp/k12-path-policy/profile/manifest.json',
    HEX_K12_LIVE_SIDECAR_CONTROL:
      '/work/hexclaw-desktop/scripts/ci/k12-current-bug-isolated-sidecar-control.mjs',
    HEX_K12_LIVE_SIDECAR_CONTROL_SHA256: 'a'.repeat(64),
    HEX_K12_LIVE_SIDECAR_CONTROL_CONFIG: '/tmp/k12-path-policy/controller.json',
    ...syntheticGradingCalibrationEnvironment('/tmp/k12-path-policy/grading-calibration.json'),
    HEX_K12_LIVE_APP_URL: 'http://localhost:16060',
    HEX_K12_LIVE_SIDECAR_URL: 'http://127.0.0.1:16129',
    HEX_K12_LIVE_APP_SHA256: 'e'.repeat(64),
    HEX_K12_REAL_10X_RUN_ID: 'opaque-run',
  }
}

function adapters(env, overrides = {}) {
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
    inspectPath: (path) => {
      const override = overrides[path] ?? {}
      return {
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
        ...override,
      }
    },
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

test('path policy accepts a 0755 source while private assets remain 0700/0600', async () => {
  const { validateFixtureEnvironment } = await import(
    repoFile('scripts/ci/k12-current-bug-fixture-orchestrator.mjs')
  )
  const env = environment()
  const result = validateFixtureEnvironment(env, adapters(env))
  assert.equal(result.localSource, env.HEXCLAW_LOCAL_SRC)

  for (const [path, override] of [
    [env.HEX_K12_LIVE_FIXTURE_PROFILE, { mode: 0o755 }],
    [env.HEX_K12_LIVE_FIXTURE_STORE, { mode: 0o644 }],
    [env.HEX_K12_LIVE_SIDECAR_CONTROL_CONFIG, { mode: 0o644 }],
  ]) {
    assert.throws(() => validateFixtureEnvironment(env, adapters(env, { [path]: override })))
  }
})

test('path policy rejects relative, missing and symlink source without weakening executable trust', async () => {
  const { validateFixtureEnvironment } = await import(
    repoFile('scripts/ci/k12-current-bug-fixture-orchestrator.mjs')
  )
  const env = environment()
  assert.throws(() =>
    validateFixtureEnvironment(
      { ...env, HEXCLAW_LOCAL_SRC: 'relative/hexclaw' },
      adapters({ ...env, HEXCLAW_LOCAL_SRC: 'relative/hexclaw' }),
    ),
  )
  assert.throws(() =>
    validateFixtureEnvironment(
      env,
      adapters(env, {
        [env.HEXCLAW_LOCAL_SRC]: { kind: 'missing' },
      }),
    ),
  )
  assert.throws(() =>
    validateFixtureEnvironment(
      env,
      adapters(env, {
        [env.HEXCLAW_LOCAL_SRC]: { symlink: true },
      }),
    ),
  )
  assert.throws(() =>
    validateFixtureEnvironment(
      env,
      adapters(env, {
        [env.HEX_K12_LIVE_SIDECAR_CONTROL]: { executable: false },
      }),
    ),
  )
})

test('K12-LIVE-PATH-REAL-001 validates the real 0755 checkout and isolated private filesystem paths', async () => {
  const { validateFixtureEnvironment } = await import(
    repoFile('scripts/ci/k12-current-bug-fixture-orchestrator.mjs')
  )
  const localSource = realpathSync(
    join(new URL('../../', import.meta.url).pathname, '..', 'hexclaw'),
  )
  const controller = new URL(
    '../../scripts/ci/k12-current-bug-isolated-sidecar-control.mjs',
    import.meta.url,
  ).pathname
  const profile = mkdtempSync('/tmp/hexclaw-k12-path-real-')
  const privateStoreDir = join(profile, '.hexclaw')
  const store = join(privateStoreDir, 'data.db')
  const manifestPath = join(profile, 'fixture-manifest.json')
  const controllerConfig = join(profile, 'controller.json')
  const calibrationPath = join(profile, 'grading-calibration.json')
  const missingSource = join(profile, 'missing-source')
  const symlinkSource = join(profile, 'source-link')
  const fileSHA256 = (pathname) => createHash('sha256').update(readFileSync(pathname)).digest('hex')

  chmodSync(profile, 0o700)
  mkdirSync(privateStoreDir, { mode: 0o700 })
  writeFileSync(store, '', { mode: 0o600 })
  writeFileSync(controllerConfig, '{}', { mode: 0o600 })
  writeFileSync(calibrationPath, syntheticGradingCalibrationBytes(), { mode: 0o600 })
  symlinkSync(localSource, symlinkSource)

  const env = {
    HEXCLAW_LOCAL_SRC: localSource,
    HEX_K12_LIVE_FIXTURE_PROFILE: profile,
    HEX_K12_LIVE_FIXTURE_STORE: store,
    HEX_K12_LIVE_FIXTURE_MANIFEST: manifestPath,
    HEX_K12_LIVE_SIDECAR_CONTROL: controller,
    HEX_K12_LIVE_SIDECAR_CONTROL_SHA256: fileSHA256(controller),
    HEX_K12_LIVE_SIDECAR_CONTROL_CONFIG: controllerConfig,
    ...syntheticGradingCalibrationEnvironment(calibrationPath),
    HEX_K12_LIVE_APP_URL: 'http://localhost:16060',
    HEX_K12_LIVE_SIDECAR_URL: 'http://127.0.0.1:16129',
    HEX_K12_LIVE_APP_SHA256: 'e'.repeat(64),
    HEX_K12_REAL_10X_RUN_ID: 'filesystem-real-path-policy',
  }
  const runtimeAdapters = {
    readControllerRuntimeContract: () => ({
      releaseUIURL: env.HEX_K12_LIVE_APP_URL,
      sidecarURL: env.HEX_K12_LIVE_SIDECAR_URL,
      installedAppSHA256: env.HEX_K12_LIVE_APP_SHA256,
      gradingBudget: syntheticGradingBudget(),
      sidecarConfigSHA256: syntheticSidecarConfigSHA256,
    }),
    gradingCalibrationApproval: syntheticGradingCalibrationApproval(),
  }

  try {
    const accepted = validateFixtureEnvironment(env, runtimeAdapters)
    assert.equal(accepted.localSource, localSource)
    assert.equal(accepted.profilePath, realpathSync(profile))

    assert.throws(
      () =>
        validateFixtureEnvironment({ ...env, HEXCLAW_LOCAL_SRC: missingSource }, runtimeAdapters),
      /ENOENT|existing directory/i,
    )
    assert.throws(
      () =>
        validateFixtureEnvironment({ ...env, HEXCLAW_LOCAL_SRC: symlinkSource }, runtimeAdapters),
      /symbolic links/i,
    )

    chmodSync(profile, 0o755)
    assert.throws(() => validateFixtureEnvironment(env, runtimeAdapters), /0700/i)
    chmodSync(profile, 0o700)

    chmodSync(store, 0o644)
    assert.throws(() => validateFixtureEnvironment(env, runtimeAdapters), /0600/i)
    chmodSync(store, 0o600)

    writeFileSync(manifestPath, '{}', { mode: 0o600 })
    assert.throws(
      () => validateFixtureEnvironment(env, runtimeAdapters),
      /manifest path must not already exist/i,
    )
  } finally {
    rmSync(profile, { recursive: true, force: true })
  }
})
