import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const repoFile = (path) => new URL(`../../${path}`, import.meta.url)

const fields = [
  'schema_version',
  'profile_dir',
  'sidecar_config_path',
  'sidecar_config_sha256',
  'binary_path',
  'binary_sha256',
  'expected_version',
  'host',
  'port',
  'sidecar_url',
  'release_ui_url',
  'release_attestation_path',
  'release_attestation_sha256',
  'pid_file',
  'lock_file',
  'startup_timeout_ms',
  'shutdown_timeout_ms',
]

const paths = {
  controllerConfig: '/tmp/k12-controller/run/control.json',
  profile: '/tmp/k12-controller/run/profile',
  sidecarConfig: '/tmp/k12-controller/run/profile/sidecar.yaml',
  binary: '/Applications/HexClaw.app/Contents/MacOS/hexclaw',
  pid: '/tmp/k12-controller/run/profile/.hexclaw/.k12-sidecar.pid',
  lock: '/tmp/k12-controller/run/profile/.hexclaw/.sidecar.lock',
  attestation: '/tmp/k12-controller/run/release-attestation.json',
}

const binarySHA = 'a'.repeat(64)

function sha256(raw) {
  return createHash('sha256').update(raw).digest('hex')
}

function completeGradingBudget(overrides = {}) {
  return {
    policy_version: 99,
    queued_seconds: 11,
    normalizing_seconds: 12,
    recognizing_seconds: 13,
    locating_seconds: 14,
    rendering_seconds: 15,
    projecting_seconds: 16,
    assessing_buckets: [
      { max_problems: 1, seconds: 21 },
      { max_problems: 8, seconds: 22 },
      { max_problems: 16, seconds: 23 },
      { max_problems: 32, seconds: 24 },
    ],
    item_concurrency: 7,
    ...overrides,
  }
}

function sidecarConfigBytes(overrides = {}) {
  const budget = Object.hasOwn(overrides, 'gradingBudget')
    ? overrides.gradingBudget
    : completeGradingBudget()
  const budgetBlock =
    budget === undefined
      ? ''
      : `k12:
  grading_budget:
${[
  'policy_version',
  'queued_seconds',
  'normalizing_seconds',
  'recognizing_seconds',
  'locating_seconds',
  'rendering_seconds',
  'projecting_seconds',
]
  .filter((field) => budget[field] !== undefined)
  .map((field) => `    ${field}: ${budget[field]}`)
  .join('\n')}
${
  budget.assessing_buckets === undefined
    ? ''
    : `    assessing_buckets:
${budget.assessing_buckets
  .map(
    ({ max_problems: maxProblems, seconds }) =>
      `      - max_problems: ${maxProblems}${
        seconds === undefined ? '' : `\n        seconds: ${seconds}`
      }`,
  )
  .join('\n')}`
}
${budget.item_concurrency === undefined ? '' : `    item_concurrency: ${budget.item_concurrency}`}
`
  return Buffer.from(`server:
  host: ${overrides.host ?? '127.0.0.1'}
  port: ${overrides.port ?? 18081}
${budgetBlock}
`)
}

function releaseAttestationBytes(overrides = {}) {
  return Buffer.from(
    JSON.stringify({
      schema_version: 1,
      release_version: '0.5.0-beta',
      package_file: '/tmp/HexClaw.dmg',
      package_sha256: '1'.repeat(64),
      sidecar_file: paths.binary,
      sidecar_sha256: binarySHA,
      installed_app_file: '/Applications/HexClaw.app',
      installed_app_sha256: 'e'.repeat(64),
      dist_manifest_file: '/tmp/dist-manifest.json',
      dist_manifest_sha256: '2'.repeat(64),
      dist_file_count: 10,
      dist_total_bytes: 100,
      ...overrides,
    }),
  )
}

const configSHA = sha256(sidecarConfigBytes())
const attestationSHA = sha256(releaseAttestationBytes())

function controllerConfig(overrides = {}) {
  return {
    schema_version: 2,
    profile_dir: paths.profile,
    sidecar_config_path: paths.sidecarConfig,
    sidecar_config_sha256: configSHA,
    binary_path: paths.binary,
    binary_sha256: binarySHA,
    expected_version: '0.5.0-beta',
    host: '127.0.0.1',
    port: 18081,
    sidecar_url: 'http://127.0.0.1:18081',
    release_ui_url: 'http://localhost:16060',
    release_attestation_path: paths.attestation,
    release_attestation_sha256: attestationSHA,
    pid_file: paths.pid,
    lock_file: paths.lock,
    startup_timeout_ms: 30_000,
    shutdown_timeout_ms: 15_000,
    ...overrides,
  }
}

function validationContext(config = controllerConfig(), overrides = {}) {
  const directories = new Set([config.profile_dir])
  const missing = new Set([config.pid_file, config.lock_file])
  return {
    configPath: paths.controllerConfig,
    homeDirectory: '/Users/real',
    inspectPath: (path) => ({
      kind: missing.has(path) ? 'missing' : directories.has(path) ? 'directory' : 'file',
      canonicalPath: path.replace(/^\/tmp\//, '/private/tmp/'),
      mode: directories.has(path) ? 0o700 : path === config.binary_path ? 0o755 : 0o600,
      executable: path === config.binary_path,
      symlink: false,
    }),
    fileSHA256: () => config.binary_sha256,
    readSidecarConfigBytes: () =>
      sidecarConfigBytes({
        host: config.host,
        port: config.port,
      }),
    readReleaseAttestationBytes: () =>
      releaseAttestationBytes({
        release_version: config.expected_version,
        sidecar_sha256: config.binary_sha256,
      }),
    ...overrides,
  }
}

function stoppedSnapshot() {
  return {
    pidFilePID: null,
    process: null,
    listenerPID: null,
    lockPID: null,
    healthStatus: null,
    versionStatus: null,
    version: null,
    sidecarRootStatus: null,
    releaseUIStatus: 200,
    releaseUIProxyHealthStatus: null,
    releaseAttestationStatus: 200,
    releaseAttestationSHA256: attestationSHA,
    releaseInstalledAppSHA256: 'e'.repeat(64),
    releaseSidecarSHA256: binarySHA,
    releaseVersion: '0.5.0-beta',
  }
}

function runningSnapshot(config = controllerConfig(), pid = 4242) {
  const binaryPath = config.binaryPath ?? config.binary_path
  const sidecarConfigPath = config.sidecarConfigPath ?? config.sidecar_config_path
  const binarySHA256 = config.binarySHA256 ?? config.binary_sha256
  const expectedVersion = config.expectedVersion ?? config.expected_version
  return {
    pidFilePID: pid,
    process: {
      pid,
      executablePath: binaryPath,
      argv: [binaryPath, 'serve', '--desktop', '--config', sidecarConfigPath],
      binarySHA256,
    },
    listenerPID: pid,
    lockPID: pid,
    healthStatus: 200,
    versionStatus: 200,
    version: expectedVersion,
    sidecarRootStatus: 404,
    releaseUIStatus: 200,
    releaseUIProxyHealthStatus: 200,
    releaseAttestationStatus: 200,
    releaseAttestationSHA256: config.releaseAttestationSHA256 ?? config.release_attestation_sha256,
    releaseInstalledAppSHA256: config.releaseInstalledAppSHA256 ?? 'e'.repeat(64),
    releaseSidecarSHA256: binarySHA256,
    releaseVersion: expectedVersion,
  }
}

async function loadController() {
  return import(repoFile('scripts/ci/k12-current-bug-isolated-sidecar-control.mjs'))
}

test('controller contract freezes one module, exact CLI and exact 13-field config', async () => {
  const contract = JSON.parse(
    await readFile(
      repoFile('tests/live/k12-current-bug-isolated-sidecar-control.contract.json'),
      'utf8',
    ),
  )
  assert.equal(contract.schemaVersion, 2)
  assert.equal(contract.module, 'scripts/ci/k12-current-bug-isolated-sidecar-control.mjs')
  assert.deepEqual(contract.cli.actions, ['start', 'stop'])
  assert.deepEqual(contract.cli.args, ['<action>', '--config', '<absolute-/tmp-json>'])
  assert.equal(contract.cli.shell, false)
  assert.deepEqual(contract.config.exactFields, fields)
  assert.deepEqual(contract.config.forbiddenPorts, [18080])
  assert.equal(contract.config.forbidUserProfile, true)
  assert.deepEqual(contract.config.explicitOrigins, ['sidecar_url', 'release_ui_url'])
  assert.equal(contract.config.releaseUIRequiresAttestation, true)
  assert.deepEqual(contract.permissions, {
    privateDirectory: '0700',
    privateFile: '0600',
    trustedExecutableAllows: '0755',
  })
})

test('CLI and config reject drift, production port/profile and mismatched sidecar binding', async () => {
  const { parseControllerCLI, validateControllerConfig } = await loadController()

  assert.deepEqual(parseControllerCLI(['start', '--config', paths.controllerConfig]), {
    action: 'start',
    configPath: paths.controllerConfig,
  })
  assert.deepEqual(parseControllerCLI(['stop', '--config', paths.controllerConfig]), {
    action: 'stop',
    configPath: paths.controllerConfig,
  })
  for (const argv of [
    [],
    ['restart', '--config', paths.controllerConfig],
    ['start', paths.controllerConfig],
    ['start', '--config', 'relative.json'],
    ['start', '--config', '/Users/real/control.json'],
    ['start', '--config', paths.controllerConfig, '--extra'],
  ]) {
    assert.throws(() => parseControllerCLI(argv))
  }

  const raw = controllerConfig()
  const config = validateControllerConfig(JSON.stringify(raw), validationContext(raw))
  assert.equal(config.profileDir, '/private/tmp/k12-controller/run/profile')
  assert.equal(config.port, 18081)

  for (const mutation of [
    { extra: true },
    { schema_version: 1 },
    { host: '0.0.0.0' },
    { port: 18080 },
    { profile_dir: '/Users/real/.hexclaw' },
    { lock_file: '/tmp/k12-controller/run/profile/.wrong-lock' },
    { pid_file: '/tmp/k12-controller/run/profile/.wrong-pid' },
    { startup_timeout_ms: 999 },
    { sidecar_url: 'http://127.0.0.1:19000' },
    { release_ui_url: 'http://127.0.0.1:18081' },
    { release_ui_url: 'http://127.0.0.1:18080' },
    { release_ui_url: 'https://example.com' },
    { release_attestation_sha256: 'bad' },
  ]) {
    const changed = controllerConfig(mutation)
    assert.throws(() =>
      validateControllerConfig(JSON.stringify(changed), validationContext(changed)),
    )
  }
  assert.throws(() =>
    validateControllerConfig(
      JSON.stringify(raw),
      validationContext(raw, {
        readSidecarConfigBytes: () => sidecarConfigBytes({ port: 19000 }),
      }),
    ),
  )
  assert.throws(() =>
    validateControllerConfig(
      JSON.stringify(raw),
      validationContext(raw, {
        readReleaseAttestationBytes: () =>
          releaseAttestationBytes({ package_sha256: '0'.repeat(64) }),
      }),
    ),
  )
  assert.throws(() =>
    validateControllerConfig(
      JSON.stringify(raw),
      validationContext(raw, {
        fileSHA256: () => '0'.repeat(64),
      }),
    ),
  )
})

test('controller validator consumes one Sidecar and attestation byte snapshot without legacy readers', async () => {
  const { validateControllerConfig } = await loadController()
  const raw = controllerConfig()
  let sidecarReads = 0
  let attestationReads = 0
  let legacySidecarReads = 0
  let legacyAttestationReads = 0
  const config = validateControllerConfig(
    JSON.stringify(raw),
    validationContext(raw, {
      readSidecarConfigBytes: () => {
        sidecarReads += 1
        return sidecarConfigBytes()
      },
      readReleaseAttestationBytes: () => {
        attestationReads += 1
        return releaseAttestationBytes()
      },
      readSidecarBinding: () => {
        legacySidecarReads += 1
        return {
          host: raw.host,
          port: raw.port,
          gradingBudget: completeGradingBudget(),
        }
      },
      verifyReleaseAttestation: () => {
        legacyAttestationReads += 1
        return {
          releaseVersion: raw.expected_version,
          sidecarSHA256: raw.binary_sha256,
          installedAppSHA256: 'f'.repeat(64),
          attestationSHA256: raw.release_attestation_sha256,
        }
      },
    }),
  )

  assert.equal(sidecarReads, 1)
  assert.equal(attestationReads, 1)
  assert.equal(legacySidecarReads, 0)
  assert.equal(legacyAttestationReads, 0)
  assert.equal(config.releaseInstalledAppSHA256, 'e'.repeat(64))
})

test('controller validator rejects duplicate keys from raw Sidecar and attestation snapshots', async () => {
  const { validateControllerConfig } = await loadController()
  const raw = controllerConfig()
  const duplicateSidecar = Buffer.from(
    String(sidecarConfigBytes()).replace(
      '    recognizing_seconds: 13',
      '    recognizing_seconds: 99\n    recognizing_seconds: 13',
    ),
  )
  const duplicateAttestation = Buffer.from(
    String(releaseAttestationBytes()).replace(
      `"package_sha256":"${'1'.repeat(64)}"`,
      `"package_sha256":"${'9'.repeat(64)}","package_sha256":"${'1'.repeat(64)}"`,
    ),
  )

  for (const mutation of [
    { readSidecarConfigBytes: () => duplicateSidecar },
    { readReleaseAttestationBytes: () => duplicateAttestation },
  ]) {
    assert.throws(
      () => validateControllerConfig(JSON.stringify(raw), validationContext(raw, mutation)),
      /duplicate/i,
    )
  }
})

test('frozen sidecar binding requires one structurally complete K12 grading budget', async () => {
  const { parseSidecarBinding, validateControllerConfig } = await loadController()
  const raw = controllerConfig()
  const validateBinding = (gradingBudget) => {
    const bytes = sidecarConfigBytes({
      host: raw.host,
      port: raw.port,
      gradingBudget,
    })
    const bound = {
      ...raw,
      sidecar_config_sha256: sha256(bytes),
    }
    return validateControllerConfig(
      JSON.stringify(bound),
      validationContext(bound, {
        readSidecarConfigBytes: () => bytes,
      }),
    )
  }

  assert.throws(() => validateBinding(undefined), /frozen K12 grading budget/)
  assert.throws(
    () => validateBinding(completeGradingBudget({ policy_version: 0 })),
    /policy_version/,
  )

  for (const field of [
    'queued_seconds',
    'normalizing_seconds',
    'recognizing_seconds',
    'locating_seconds',
    'rendering_seconds',
    'projecting_seconds',
  ]) {
    const incomplete = completeGradingBudget()
    delete incomplete[field]
    assert.throws(() => validateBinding(incomplete), new RegExp(field))
  }

  assert.throws(
    () =>
      validateBinding(
        completeGradingBudget({
          assessing_buckets: completeGradingBudget().assessing_buckets.slice(0, 3),
        }),
      ),
    /assessing_buckets/,
  )
  const missingBucketSeconds = completeGradingBudget().assessing_buckets.map((bucket) => ({
    ...bucket,
  }))
  delete missingBucketSeconds[2].seconds
  assert.throws(
    () =>
      validateBinding(
        completeGradingBudget({
          assessing_buckets: missingBucketSeconds,
        }),
      ),
    /assessing_buckets/,
  )
  const missingConcurrency = completeGradingBudget()
  delete missingConcurrency.item_concurrency
  assert.throws(() => validateBinding(missingConcurrency), /item_concurrency/)

  assert.equal(validateBinding(completeGradingBudget()).port, raw.port)
  assert.deepEqual(
    parseSidecarBinding(`
server:
  host: 127.0.0.1
  port: 18081
k12:
  grading_budget:
    policy_version: 99
    queued_seconds: 11
    normalizing_seconds: 12
    recognizing_seconds: 13
    locating_seconds: 14
    rendering_seconds: 15
    projecting_seconds: 16
    assessing_buckets:
      - max_problems: 1
        seconds: 21
      - max_problems: 8
        seconds: 22
      - max_problems: 16
        seconds: 23
      - max_problems: 32
        seconds: 24
    item_concurrency: 7
`),
    {
      host: '127.0.0.1',
      port: 18081,
      gradingBudget: completeGradingBudget(),
    },
  )

  const nestedLookalikeRaw = `
server:
  host: 127.0.0.1
  port: 18081
k12:
  unrelated:
    grading_budget:
      policy_version: 99
      queued_seconds: 11
      normalizing_seconds: 12
      recognizing_seconds: 13
      locating_seconds: 14
      rendering_seconds: 15
      projecting_seconds: 16
      assessing_buckets:
        - max_problems: 1
          seconds: 21
        - max_problems: 8
          seconds: 22
        - max_problems: 16
          seconds: 23
        - max_problems: 32
          seconds: 24
      item_concurrency: 7
`
  const nestedLookalike = parseSidecarBinding(nestedLookalikeRaw)
  assert.equal(nestedLookalike.gradingBudget, undefined)
  const nestedBound = {
    ...raw,
    sidecar_config_sha256: sha256(nestedLookalikeRaw),
  }
  assert.throws(
    () =>
      validateControllerConfig(
        JSON.stringify(nestedBound),
        validationContext(nestedBound, {
          readSidecarConfigBytes: () => Buffer.from(nestedLookalikeRaw),
        }),
      ),
    /frozen K12 grading budget/,
  )
})

test('running identity requires exact PID, argv, SHA, listener, lock, health and version', async () => {
  const { assertRunningIdentity } = await loadController()
  const config = validateReadyConfig(controllerConfig())
  assert.equal(assertRunningIdentity(config, runningSnapshot()), 4242)

  for (const snapshot of [
    { ...runningSnapshot(config), pidFilePID: 4343 },
    { ...runningSnapshot(config), listenerPID: 9999 },
    { ...runningSnapshot(config), lockPID: 9999 },
    { ...runningSnapshot(config), healthStatus: 503 },
    { ...runningSnapshot(config), version: 'drift' },
    { ...runningSnapshot(config), releaseUIStatus: 404 },
    { ...runningSnapshot(config), releaseUIProxyHealthStatus: 503 },
    { ...runningSnapshot(config), releaseAttestationSHA256: '0'.repeat(64) },
    {
      ...runningSnapshot(config),
      process: {
        ...runningSnapshot(config).process,
        argv: [config.binaryPath, 'serve', '--config', config.sidecarConfigPath],
      },
    },
  ]) {
    assert.throws(() => assertRunningIdentity(config, snapshot))
  }
})

test('start and stop preserve exact command order and refuse to signal foreign identity', async () => {
  const { startIsolatedSidecar, stopIsolatedSidecar } = await loadController()
  const config = validateReadyConfig(controllerConfig())
  const startEvents = []
  const pid = await startIsolatedSidecar(config, {
    inspectState: async () => {
      startEvents.push('inspect_stopped')
      return stoppedSnapshot()
    },
    spawnSidecar: async (command, args, options) => {
      startEvents.push({ command, args, options })
      return { pid: 4242 }
    },
    writePIDFile: async (path, value, options) => {
      startEvents.push({ write: path, value, options })
    },
    waitForRunning: async () => {
      startEvents.push('wait_running')
      return runningSnapshot(config)
    },
    cleanupStartedProcess: async () => {
      startEvents.push('unexpected_cleanup')
    },
  })
  assert.equal(pid, 4242)
  assert.deepEqual(startEvents[1], {
    command: config.binaryPath,
    args: ['serve', '--desktop', '--config', config.sidecarConfigPath],
    options: {
      shell: false,
      detached: true,
      env: {
        HOME: config.profileDir,
        DINGTALK_LIVE_SEND: '0',
      },
    },
  })
  assert.deepEqual(startEvents[2], {
    write: config.pidFile,
    value: '4242',
    options: { mode: 0o600, atomic: true },
  })

  const stopEvents = []
  await stopIsolatedSidecar(config, {
    inspectState: async () => runningSnapshot(config),
    signalProcess: async (pidValue, signal) => {
      stopEvents.push([pidValue, signal])
    },
    waitForStopped: async () => stoppedSnapshot(),
    removePIDFile: async (path) => {
      stopEvents.push(['remove', path])
    },
  })
  assert.deepEqual(stopEvents, [
    [4242, 'SIGTERM'],
    ['remove', config.pidFile],
  ])

  let signalled = false
  await assert.rejects(() =>
    stopIsolatedSidecar(config, {
      inspectState: async () => ({
        ...runningSnapshot(config),
        listenerPID: 9999,
      }),
      signalProcess: async () => {
        signalled = true
      },
      waitForStopped: async () => stoppedSnapshot(),
      removePIDFile: async () => undefined,
    }),
  )
  assert.equal(signalled, false)
})

test('stop permits an owned Sidecar after its isolated YAML changes without weakening start attestation', async () => {
  const { runControllerCLI } = await loadController()
  const raw = controllerConfig()
  const runtimeMutatedYAML = Buffer.concat([
    sidecarConfigBytes({ host: raw.host, port: raw.port }),
    Buffer.from('# persisted by the owned isolated Sidecar\n'),
  ])
  let sidecarConfigReads = 0
  const signals = []
  const events = []
  const processLike = new EventEmitter()
  processLike.exitCode = 0

  await runControllerCLI(['stop', '--config', paths.controllerConfig], {
    ...validationContext(raw, {
      readSidecarConfigBytes: () => {
        sidecarConfigReads += 1
        return runtimeMutatedYAML
      },
    }),
    readControllerConfigBytes: () => Buffer.from(JSON.stringify(raw)),
    processLike,
    runtime: {
      inspectState: async (activeConfig) => runningSnapshot(activeConfig),
      signalProcess: async (pid, signal) => signals.push([pid, signal]),
      waitForStopped: async () => stoppedSnapshot(),
      removePIDFile: async (pathname) => events.push(['remove', pathname]),
      cancelActive: async () => events.push(['cancel']),
      cleanup: async () => events.push(['cleanup']),
    },
  })

  assert.deepEqual(signals, [[4242, 'SIGTERM']])
  assert.deepEqual(events, [['remove', '/private/tmp/k12-controller/run/profile/.hexclaw/.k12-sidecar.pid']])
  assert.equal(sidecarConfigReads, 0)
})

test('stale lock release accepts only a disappeared target lock after Sidecar exit', async () => {
  const { classifyOwnedStaleLock } = await loadController()

  assert.equal(classifyOwnedStaleLock(null, 4242, false), 'released')
  assert.equal(classifyOwnedStaleLock(4242, 4242, false), 'remove')
  assert.throws(() => classifyOwnedStaleLock(9999, 4242, false))
  assert.throws(() => classifyOwnedStaleLock(4242, 4242, true))
})

test('startup failure and signals use guarded single-flight cleanup without replacing root error', async () => {
  const { installControllerSignalCleanup, startIsolatedSidecar } = await loadController()
  const config = validateReadyConfig(controllerConfig())
  const root = new Error('health mismatch')
  const events = []
  await assert.rejects(
    () =>
      startIsolatedSidecar(config, {
        inspectState: async () => stoppedSnapshot(),
        spawnSidecar: async () => ({ pid: 4242 }),
        writePIDFile: async () => undefined,
        waitForRunning: async () => {
          throw root
        },
        cleanupStartedProcess: async (pid) => {
          events.push(['cleanup', pid])
          throw new Error('cleanup detail')
        },
      }),
    (error) => error === root,
  )
  assert.deepEqual(events, [['cleanup', 4242]])

  const processLike = new EventEmitter()
  processLike.exitCode = 0
  let cancelCount = 0
  let cleanupCount = 0
  const uninstall = installControllerSignalCleanup(processLike, {
    cancelActive: async () => {
      cancelCount += 1
    },
    cleanup: async () => {
      cleanupCount += 1
    },
  })
  processLike.emit('SIGINT')
  processLike.emit('SIGTERM')
  await uninstall.wait()
  assert.equal(cancelCount, 1)
  assert.equal(cleanupCount, 1)
  assert.equal(processLike.exitCode, 130)
  uninstall()
})

function validateReadyConfig(raw) {
  return {
    profileDir: raw.profile_dir,
    sidecarConfigPath: raw.sidecar_config_path,
    sidecarConfigSHA256: raw.sidecar_config_sha256,
    binaryPath: raw.binary_path,
    binarySHA256: raw.binary_sha256,
    expectedVersion: raw.expected_version,
    host: raw.host,
    port: raw.port,
    sidecarURL: raw.sidecar_url,
    releaseUIURL: raw.release_ui_url,
    releaseAttestationPath: raw.release_attestation_path,
    releaseAttestationSHA256: raw.release_attestation_sha256,
    releaseInstalledAppSHA256: 'e'.repeat(64),
    pidFile: raw.pid_file,
    lockFile: raw.lock_file,
    startupTimeoutMs: raw.startup_timeout_ms,
    shutdownTimeoutMs: raw.shutdown_timeout_ms,
  }
}
