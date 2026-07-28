import assert from 'node:assert/strict'
import test from 'node:test'

const repoFile = (path) => new URL(`../../${path}`, import.meta.url)

const config = {
  profileDir: '/private/tmp/k12-url-pid/profile',
  sidecarConfigPath: '/private/tmp/k12-url-pid/profile/.hexclaw/hexclaw.yaml',
  sidecarConfigSHA256: 'b'.repeat(64),
  binaryPath: '/Applications/HexClaw.app/Contents/MacOS/hexclaw',
  binarySHA256: 'a'.repeat(64),
  expectedVersion: '0.5.0-beta',
  host: '127.0.0.1',
  port: 16129,
  sidecarURL: 'http://127.0.0.1:16129',
  releaseUIURL: 'http://localhost:16060',
  releaseAttestationPath: '/private/tmp/k12-url-pid/release-attestation.json',
  releaseAttestationSHA256: 'd'.repeat(64),
  releaseInstalledAppSHA256: 'e'.repeat(64),
  pidFile: '/private/tmp/k12-url-pid/profile/.hexclaw/.k12-sidecar.pid',
  lockFile: '/private/tmp/k12-url-pid/profile/.hexclaw/.sidecar.lock',
  startupTimeoutMs: 30_000,
  shutdownTimeoutMs: 15_000,
}

const boundaryEmpty = {
  listenerPID: null,
  lockPID: null,
  healthStatus: null,
  versionStatus: null,
  version: null,
  sidecarRootStatus: null,
  releaseUIStatus: 200,
  releaseUIProxyHealthStatus: null,
  releaseAttestationStatus: 200,
  releaseAttestationSHA256: config.releaseAttestationSHA256,
  releaseInstalledAppSHA256: config.releaseInstalledAppSHA256,
  releaseSidecarSHA256: config.binarySHA256,
  releaseVersion: config.expectedVersion,
}

test('dead stale PID is removed without signal and yields no PID/path/command receipt', async () => {
  const { normalizeStoppedState } = await import(
    repoFile('scripts/ci/k12-current-bug-isolated-sidecar-control.mjs')
  )
  let signals = 0
  let removed = 0
  const result = await normalizeStoppedState(config, {
    ...boundaryEmpty,
    pidFilePID: 4242,
    process: null,
  }, {
    removePIDFile: async (_path, identity) => {
      assert.deepEqual(identity, {
        expectedPID: 4242,
        expectedMode: 0o600,
        rejectSymlink: true,
      })
      removed += 1
    },
    signalProcess: async () => {
      signals += 1
    },
  })
  assert.deepEqual(result.receipt, {
    schema_version: 1,
    pid_file_existed: true,
    pid_alive: false,
    owned_process: false,
    listener_present: false,
    lock_present: false,
    signal_sent: false,
    pid_file_removed: true,
  })
  assert.equal(result.state, 'stopped')
  assert.equal(signals, 0)
  assert.equal(removed, 1)
  const serialized = JSON.stringify(result.receipt)
  assert.equal(serialized.includes('4242'), false)
  assert.equal(serialized.includes(config.pidFile), false)
})

test('foreign PID reuse removes only controller PID file and never signals foreign process', async () => {
  const { normalizeStoppedState } = await import(
    repoFile('scripts/ci/k12-current-bug-isolated-sidecar-control.mjs')
  )
  let signals = 0
  let removed = 0
  const result = await normalizeStoppedState(config, {
    ...boundaryEmpty,
    pidFilePID: 4242,
    process: {
      pid: 4242,
      executablePath: '/usr/bin/sleep',
      argv: ['/usr/bin/sleep', '30'],
      binarySHA256: 'f'.repeat(64),
    },
  }, {
    removePIDFile: async () => {
      removed += 1
    },
    signalProcess: async () => {
      signals += 1
    },
  })
  assert.equal(result.state, 'stopped')
  assert.equal(result.receipt.pid_alive, true)
  assert.equal(result.receipt.owned_process, false)
  assert.equal(result.receipt.signal_sent, false)
  assert.equal(signals, 0)
  assert.equal(removed, 1)
})

test('listener or lock evidence blocks stale unlink while exact owned process remains guarded', async () => {
  const { normalizeStoppedState } = await import(
    repoFile('scripts/ci/k12-current-bug-isolated-sidecar-control.mjs')
  )
  for (const boundary of [
    { listenerPID: 9999 },
    { lockPID: 9999 },
    { healthStatus: 200 },
    { versionStatus: 200 },
  ]) {
    let removed = false
    const result = await normalizeStoppedState(config, {
      ...boundaryEmpty,
      ...boundary,
      pidFilePID: 4242,
      process: null,
    }, {
      removePIDFile: async () => {
        removed = true
      },
    })
    assert.equal(result.state, 'blocked')
    assert.equal(removed, false)
  }

  const owned = await normalizeStoppedState(config, {
    ...boundaryEmpty,
    pidFilePID: 4242,
    process: {
      pid: 4242,
      executablePath: config.binaryPath,
      argv: [
        config.binaryPath,
        'serve',
        '--desktop',
        '--config',
        config.sidecarConfigPath,
      ],
      binarySHA256: config.binarySHA256,
    },
  }, {
    removePIDFile: async () => assert.fail('owned PID must not be stale-unlinked'),
  })
  assert.equal(owned.state, 'owned')
  assert.equal(owned.pid, 4242)
})

test('fixture preflight requires env URLs and app SHA to match attested controller config', async () => {
  const { validateFixtureEnvironment } = await import(
    repoFile('scripts/ci/k12-current-bug-fixture-orchestrator.mjs')
  )
  const env = {
    HEXCLAW_LOCAL_SRC: '/work/hexclaw',
    HEX_K12_LIVE_FIXTURE_PROFILE: '/tmp/k12-url-pid/profile',
    HEX_K12_LIVE_FIXTURE_STORE: '/tmp/k12-url-pid/profile/.hexclaw/data.db',
    HEX_K12_LIVE_FIXTURE_MANIFEST: '/tmp/k12-url-pid/profile/fixture.json',
    HEX_K12_LIVE_SIDECAR_CONTROL: '/work/hexclaw-desktop/scripts/ci/k12-current-bug-isolated-sidecar-control.mjs',
    HEX_K12_LIVE_SIDECAR_CONTROL_SHA256: 'a'.repeat(64),
    HEX_K12_LIVE_SIDECAR_CONTROL_CONFIG: '/tmp/k12-url-pid/controller.json',
    HEX_K12_LIVE_APP_URL: config.releaseUIURL,
    HEX_K12_LIVE_SIDECAR_URL: config.sidecarURL,
    HEX_K12_LIVE_APP_SHA256: config.releaseInstalledAppSHA256,
  }
  const directories = new Set([env.HEXCLAW_LOCAL_SRC, env.HEX_K12_LIVE_FIXTURE_PROFILE])
  const adapters = {
    inspectPath: (path) => ({
      kind: path === env.HEX_K12_LIVE_FIXTURE_MANIFEST
        ? 'missing'
        : directories.has(path)
          ? 'directory'
          : 'file',
      canonicalPath: path.replace(/^\/tmp\//, '/private/tmp/'),
      mode: directories.has(path)
        ? path === env.HEXCLAW_LOCAL_SRC ? 0o755 : 0o700
        : path === env.HEX_K12_LIVE_SIDECAR_CONTROL ? 0o755 : 0o600,
      executable: path === env.HEX_K12_LIVE_SIDECAR_CONTROL,
      symlink: false,
    }),
    fileSHA256: () => env.HEX_K12_LIVE_SIDECAR_CONTROL_SHA256,
    readControllerRuntimeContract: () => ({
      sidecarURL: config.sidecarURL,
      releaseUIURL: config.releaseUIURL,
      installedAppSHA256: config.releaseInstalledAppSHA256,
    }),
  }
  validateFixtureEnvironment(env, adapters)
  for (const mutation of [
    { HEX_K12_LIVE_APP_URL: 'http://127.0.0.1:16129' },
    { HEX_K12_LIVE_SIDECAR_URL: 'http://127.0.0.1:16060' },
    { HEX_K12_LIVE_APP_SHA256: '0'.repeat(64) },
  ]) {
    assert.throws(() => validateFixtureEnvironment({ ...env, ...mutation }, adapters))
  }
})
