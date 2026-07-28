import assert from 'node:assert/strict'
import test from 'node:test'

const repoFile = (path) => new URL(`../../${path}`, import.meta.url)

function environment() {
  return {
    HEXCLAW_LOCAL_SRC: '/work/hexclaw',
    HEX_K12_LIVE_FIXTURE_PROFILE: '/tmp/k12-path-policy/profile',
    HEX_K12_LIVE_FIXTURE_STORE: '/tmp/k12-path-policy/profile/.hexclaw/data.db',
    HEX_K12_LIVE_FIXTURE_MANIFEST: '/tmp/k12-path-policy/profile/manifest.json',
    HEX_K12_LIVE_SIDECAR_CONTROL: '/work/hexclaw-desktop/scripts/ci/k12-current-bug-isolated-sidecar-control.mjs',
    HEX_K12_LIVE_SIDECAR_CONTROL_SHA256: 'a'.repeat(64),
    HEX_K12_LIVE_SIDECAR_CONTROL_CONFIG: '/tmp/k12-path-policy/controller.json',
    HEX_K12_LIVE_APP_URL: 'http://localhost:16060',
    HEX_K12_LIVE_SIDECAR_URL: 'http://127.0.0.1:16129',
    HEX_K12_LIVE_APP_SHA256: 'e'.repeat(64),
    HEX_K12_REAL_10X_RUN_ID: 'opaque-run',
  }
}

function adapters(env, overrides = {}) {
  const directories = new Set([
    env.HEXCLAW_LOCAL_SRC,
    env.HEX_K12_LIVE_FIXTURE_PROFILE,
  ])
  const modes = {
    [env.HEXCLAW_LOCAL_SRC]: 0o755,
    [env.HEX_K12_LIVE_FIXTURE_PROFILE]: 0o700,
    [env.HEX_K12_LIVE_FIXTURE_STORE]: 0o600,
    [env.HEX_K12_LIVE_SIDECAR_CONTROL]: 0o755,
    [env.HEX_K12_LIVE_SIDECAR_CONTROL_CONFIG]: 0o600,
  }
  return {
    inspectPath: (path) => {
      const override = overrides[path] ?? {}
      return {
        kind: path === env.HEX_K12_LIVE_FIXTURE_MANIFEST
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
    fileSHA256: () => env.HEX_K12_LIVE_SIDECAR_CONTROL_SHA256,
    readControllerRuntimeContract: () => ({
      releaseUIURL: env.HEX_K12_LIVE_APP_URL,
      sidecarURL: env.HEX_K12_LIVE_SIDECAR_URL,
      installedAppSHA256: env.HEX_K12_LIVE_APP_SHA256,
    }),
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
    assert.throws(() =>
      validateFixtureEnvironment(env, adapters(env, { [path]: override })),
    )
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
    validateFixtureEnvironment(env, adapters(env, {
      [env.HEXCLAW_LOCAL_SRC]: { kind: 'missing' },
    })),
  )
  assert.throws(() =>
    validateFixtureEnvironment(env, adapters(env, {
      [env.HEXCLAW_LOCAL_SRC]: { symlink: true },
    })),
  )
  assert.throws(() =>
    validateFixtureEnvironment(env, adapters(env, {
      [env.HEX_K12_LIVE_SIDECAR_CONTROL]: { executable: false },
    })),
  )
})
