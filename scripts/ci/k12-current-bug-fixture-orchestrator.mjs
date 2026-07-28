#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path'

const REQUIRED_ENVIRONMENT = [
  'HEXCLAW_LOCAL_SRC',
  'HEX_K12_LIVE_FIXTURE_PROFILE',
  'HEX_K12_LIVE_FIXTURE_STORE',
  'HEX_K12_LIVE_FIXTURE_MANIFEST',
  'HEX_K12_LIVE_SIDECAR_CONTROL',
  'HEX_K12_LIVE_SIDECAR_CONTROL_SHA256',
  'HEX_K12_LIVE_SIDECAR_CONTROL_CONFIG',
  'HEX_K12_LIVE_APP_URL',
  'HEX_K12_LIVE_SIDECAR_URL',
  'HEX_K12_LIVE_APP_SHA256',
]

const RELEASE_ATTESTATION_FIELDS = [
  'dist_file_count',
  'dist_manifest_file',
  'dist_manifest_sha256',
  'dist_total_bytes',
  'installed_app_file',
  'installed_app_sha256',
  'package_file',
  'package_sha256',
  'release_version',
  'schema_version',
  'sidecar_file',
  'sidecar_sha256',
]

const MANIFEST_FIELDS = [
  'agent_name',
  'lease_expires_at',
  'outcome_unknown_dispatch_id',
  'ownership',
  'retryable_dispatch_id',
  'schema_version',
]

const FIXTURE_ENVIRONMENT = [
  'HEX_K12_LIVE_RETRYABLE_DISPATCH_ID',
  'HEX_K12_LIVE_OUTCOME_UNKNOWN_DISPATCH_ID',
]

function fail(message) {
  throw new Error(`K12 fixture orchestration: ${message}`)
}

function canonicalTmp(pathname) {
  return pathname === '/tmp'
    || pathname.startsWith(`/tmp${sep}`)
    || pathname === '/private/tmp'
    || pathname.startsWith(`/private/tmp${sep}`)
}

function isInside(parent, child) {
  const suffix = relative(parent, child)
  return suffix !== '' && suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)
}

function defaultInspectPath(pathname, { allowMissing = false } = {}) {
  try {
    const link = lstatSync(pathname)
    if (link.isSymbolicLink()) fail('symbolic links are not allowed')
    const realPath = realpathSync(pathname)
    const stat = statSync(realPath)
    return {
      exists: true,
      realPath,
      mode: stat.mode & 0o777,
      regularFile: stat.isFile(),
      directory: stat.isDirectory(),
      executable: (stat.mode & 0o111) !== 0,
    }
  } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') {
      const parent = realpathSync(dirname(pathname))
      return {
        exists: false,
        realPath: join(parent, basename(pathname)),
      }
    }
    throw error
  }
}

function defaultFileSHA256(pathname) {
  return createHash('sha256').update(readFileSync(pathname)).digest('hex')
}

function inspect(adapters, pathname, options) {
  const result = (adapters.inspectPath ?? defaultInspectPath)(pathname, options)
  if (!result || typeof result !== 'object') fail('path inspection failed')
  if (result.symlink === true) fail('symbolic links are not allowed')
  return result
}

function realPathOf(result, fallback) {
  return resolve(result.realPath ?? result.canonicalPath ?? result.path ?? fallback)
}

function requireAbsolute(value, name) {
  if (!isAbsolute(value)) fail(`${name} must be absolute`)
}

function requireDirectory(result, name) {
  if (
    result.exists === false
    || result.kind === 'missing'
    || result.kind === 'file'
    || result.directory === false
    || result.regularFile === true
  ) {
    fail(`${name} must be an existing directory`)
  }
}

function requirePrivateDirectory(result, name) {
  requireDirectory(result, name)
  if (result.mode !== 0o700) fail(`${name} permissions must be 0700`)
}

function requireRegularFile(result, name) {
  if (
    result.exists === false
    || result.kind === 'missing'
    || result.kind === 'directory'
    || result.regularFile === false
    || result.directory === true
  ) {
    fail(`${name} must be an existing regular file`)
  }
}

function requirePrivateFile(result, name) {
  requireRegularFile(result, name)
  if (result.mode !== 0o600) fail(`${name} permissions must be 0600`)
}

function opaque(seed, namespace) {
  return createHash('sha256').update(`${namespace}\0${seed}`).digest('hex')
}

function exactLoopbackOrigin(value, name, {
  hostname,
  port,
} = {}) {
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    fail(`${name} must be an absolute HTTP origin`)
  }
  if (
    parsed.protocol !== 'http:'
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.pathname !== '/'
    || parsed.search !== ''
    || parsed.hash !== ''
    || (hostname !== undefined && parsed.hostname !== hostname)
    || (port !== undefined && parsed.port !== String(port))
  ) {
    fail(`${name} must be the exact approved loopback origin`)
  }
  return parsed.origin
}

function defaultReadControllerRuntimeContract(controllerConfigPath, adapters = {}) {
  let controller
  try {
    controller = JSON.parse(readFileSync(controllerConfigPath, 'utf8'))
  } catch {
    fail('sidecar controller config is not valid JSON')
  }
  if (!controller || Array.isArray(controller) || typeof controller !== 'object') {
    fail('sidecar controller config must be an object')
  }
  if (controller.schema_version !== 2) fail('sidecar controller config schema is stale')
  for (const field of [
    'sidecar_url',
    'release_ui_url',
    'release_attestation_path',
    'release_attestation_sha256',
    'expected_version',
    'binary_sha256',
  ]) {
    if (typeof controller[field] !== 'string' || controller[field].trim() === '') {
      fail(`sidecar controller config ${field} is invalid`)
    }
  }
  requireAbsolute(controller.release_attestation_path, 'release_attestation_path')
  const attestationFile = inspect(adapters, controller.release_attestation_path)
  requirePrivateFile(attestationFile, 'release_attestation_path')
  const attestationPath = realPathOf(attestationFile, controller.release_attestation_path)
  const attestationSHA256 = (adapters.fileSHA256 ?? defaultFileSHA256)(attestationPath).toLowerCase()
  if (
    !/^[a-f0-9]{64}$/.test(controller.release_attestation_sha256)
    || attestationSHA256 !== controller.release_attestation_sha256
  ) {
    fail('release attestation SHA-256 mismatch')
  }

  let receipt
  try {
    receipt = JSON.parse(readFileSync(attestationPath, 'utf8'))
  } catch {
    fail('release attestation is not valid JSON')
  }
  const fields = receipt && !Array.isArray(receipt) && typeof receipt === 'object'
    ? Object.keys(receipt).sort()
    : []
  if (
    fields.length !== RELEASE_ATTESTATION_FIELDS.length
    || fields.some((field, index) => field !== RELEASE_ATTESTATION_FIELDS[index])
    || receipt.schema_version !== 1
  ) {
    fail('release attestation fields do not match the exact schema')
  }
  if (
    receipt.release_version !== controller.expected_version
    || receipt.sidecar_sha256 !== controller.binary_sha256
    || typeof receipt.installed_app_sha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(receipt.installed_app_sha256)
  ) {
    fail('release attestation identity does not match controller config')
  }
  return {
    sidecarURL: controller.sidecar_url,
    releaseUIURL: controller.release_ui_url,
    installedAppSHA256: receipt.installed_app_sha256,
  }
}

export function validateFixtureEnvironment(env, adapters = {}) {
  for (const name of REQUIRED_ENVIRONMENT) {
    if (typeof env[name] !== 'string' || env[name].trim() === '') fail(`${name} is required`)
  }

  const sourceInput = env.HEXCLAW_LOCAL_SRC.trim()
  const profileInput = env.HEX_K12_LIVE_FIXTURE_PROFILE.trim()
  const storeInput = env.HEX_K12_LIVE_FIXTURE_STORE.trim()
  const manifestInput = env.HEX_K12_LIVE_FIXTURE_MANIFEST.trim()
  const controllerInput = env.HEX_K12_LIVE_SIDECAR_CONTROL.trim()
  const controllerConfigInput = env.HEX_K12_LIVE_SIDECAR_CONTROL_CONFIG.trim()
  const releaseUIURL = exactLoopbackOrigin(
    env.HEX_K12_LIVE_APP_URL.trim(),
    'HEX_K12_LIVE_APP_URL',
    { hostname: 'localhost', port: 16060 },
  )
  const sidecarURL = exactLoopbackOrigin(
    env.HEX_K12_LIVE_SIDECAR_URL.trim(),
    'HEX_K12_LIVE_SIDECAR_URL',
    { hostname: '127.0.0.1' },
  )
  if (sidecarURL === releaseUIURL || new URL(sidecarURL).port === '16060') {
    fail('release UI and Sidecar origins must be distinct')
  }
  const installedAppSHA256 = env.HEX_K12_LIVE_APP_SHA256.trim().toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(installedAppSHA256)) {
    fail('HEX_K12_LIVE_APP_SHA256 must be 64 lowercase hex characters')
  }

  for (const [value, name] of [
    [sourceInput, 'HEXCLAW_LOCAL_SRC'],
    [profileInput, 'HEX_K12_LIVE_FIXTURE_PROFILE'],
    [storeInput, 'HEX_K12_LIVE_FIXTURE_STORE'],
    [manifestInput, 'HEX_K12_LIVE_FIXTURE_MANIFEST'],
    [controllerInput, 'HEX_K12_LIVE_SIDECAR_CONTROL'],
    [controllerConfigInput, 'HEX_K12_LIVE_SIDECAR_CONTROL_CONFIG'],
  ]) {
    requireAbsolute(value, name)
  }

  const source = inspect(adapters, sourceInput)
  const profile = inspect(adapters, profileInput)
  const store = inspect(adapters, storeInput)
  const manifest = inspect(adapters, manifestInput, { allowMissing: true })
  const controller = inspect(adapters, controllerInput)
  const controllerConfig = inspect(adapters, controllerConfigInput)

  requireDirectory(source, 'HEXCLAW_LOCAL_SRC')
  requirePrivateDirectory(profile, 'HEX_K12_LIVE_FIXTURE_PROFILE')
  requirePrivateFile(store, 'HEX_K12_LIVE_FIXTURE_STORE')
  requireRegularFile(controller, 'HEX_K12_LIVE_SIDECAR_CONTROL')
  requirePrivateFile(controllerConfig, 'HEX_K12_LIVE_SIDECAR_CONTROL_CONFIG')
  if (controller.executable === false) fail('sidecar controller must be executable')
  if (manifest.exists !== false && manifest.kind !== 'missing') {
    fail('fixture manifest path must not already exist')
  }

  const localSource = realPathOf(source, sourceInput)
  const profilePath = realPathOf(profile, profileInput)
  const storePath = realPathOf(store, storeInput)
  const manifestPath = realPathOf(manifest, manifestInput)
  const controllerPath = realPathOf(controller, controllerInput)
  const controllerConfigPath = realPathOf(controllerConfig, controllerConfigInput)

  if (!canonicalTmp(profilePath)) fail('fixture profile must resolve below /tmp')
  if (!canonicalTmp(controllerConfigPath)) fail('sidecar controller config must resolve below /tmp')
  if (!isInside(profilePath, storePath)) fail('fixture store must resolve inside fixture profile')
  if (!isInside(profilePath, manifestPath)) fail('fixture manifest must resolve inside fixture profile')

  const expectedSHA = env.HEX_K12_LIVE_SIDECAR_CONTROL_SHA256.trim().toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(expectedSHA)) fail('sidecar controller SHA-256 must be 64 lowercase hex characters')
  const actualSHA = (adapters.fileSHA256 ?? defaultFileSHA256)(controllerPath).toLowerCase()
  if (actualSHA !== expectedSHA) fail('sidecar controller SHA-256 mismatch')
  const readControllerRuntimeContract = adapters.readControllerRuntimeContract
    ?? defaultReadControllerRuntimeContract
  const controllerRuntime = readControllerRuntimeContract(controllerConfigPath, adapters)
  if (
    controllerRuntime?.releaseUIURL !== releaseUIURL
    || controllerRuntime?.sidecarURL !== sidecarURL
    || controllerRuntime?.installedAppSHA256 !== installedAppSHA256
  ) {
    fail('fixture environment does not match attested controller runtime')
  }

  const runSeed = String(env.HEX_K12_REAL_10X_RUN_ID ?? 'isolated-current-bug')
  return Object.freeze({
    localSource,
    profile: profileInput,
    profilePath,
    storePath,
    manifestRequestedPath: manifestInput,
    manifestPath,
    controllerPath,
    controllerSHA256: actualSHA,
    controllerConfigPath,
    releaseUIURL,
    sidecarURL,
    installedAppSHA256,
    runID: opaque(runSeed, 'fixture-run'),
    learnerID: opaque(runSeed, 'fixture-learner'),
    provider: 'hexclaw-gpt',
    model: 'gpt-5.6-sol',
  })
}

export function readOpaqueManifest(raw, metadata = {}) {
  if (metadata.regularFile === false) fail('fixture manifest must be a regular file')
  if (metadata.mode !== 0o600) fail('fixture manifest permissions must be 0600')
  if (metadata.manifestPath && metadata.profilePath) {
    const manifestPath = resolve(metadata.manifestPath)
    const profilePath = resolve(metadata.profilePath)
    if (!canonicalTmp(profilePath) || !isInside(profilePath, manifestPath)) {
      fail('fixture manifest must remain inside the /tmp fixture profile')
    }
  }

  let manifest
  try {
    manifest = typeof raw === 'string' || Buffer.isBuffer(raw)
      ? JSON.parse(String(raw))
      : raw
  } catch {
    fail('fixture manifest is not valid JSON')
  }
  if (!manifest || Array.isArray(manifest) || typeof manifest !== 'object') {
    fail('fixture manifest must be an object')
  }
  const fields = Object.keys(manifest).sort()
  if (fields.length !== MANIFEST_FIELDS.length || fields.some((field, index) => field !== MANIFEST_FIELDS[index])) {
    fail('fixture manifest fields do not match the contract')
  }
  if (manifest.schema_version !== 1) fail('unsupported fixture manifest schema')
  for (const field of ['ownership', 'agent_name', 'retryable_dispatch_id', 'outcome_unknown_dispatch_id']) {
    if (typeof manifest[field] !== 'string' || manifest[field].trim() === '') {
      fail('fixture manifest contains an invalid opaque value')
    }
  }
  if (manifest.retryable_dispatch_id === manifest.outcome_unknown_dispatch_id) {
    fail('fixture dispatch IDs must be distinct')
  }
  const lease = typeof manifest.lease_expires_at === 'number'
    ? manifest.lease_expires_at * 1000
    : Date.parse(manifest.lease_expires_at)
  const nowMilliseconds = metadata.nowMilliseconds
    ?? (metadata.nowSeconds === undefined ? Date.now() : metadata.nowSeconds * 1000)
  if (!Number.isFinite(lease) || lease <= nowMilliseconds) fail('fixture lease is expired or invalid')

  return Object.freeze({
    retryableDispatchID: manifest.retryable_dispatch_id,
    outcomeUnknownDispatchID: manifest.outcome_unknown_dispatch_id,
  })
}

function manifestExists(metadata) {
  return metadata.exists !== false && metadata.kind !== 'missing'
}

function manifestReceiptAbsent() {
  return Object.freeze({
    schema_version: 1,
    existed: false,
    mode: null,
    sha256: null,
    canonical_alias_equal: true,
    removed: false,
  })
}

export async function removeCanonicalManifest(config, adapters = {}) {
  const requestedPath = config.manifestRequestedPath ?? config.manifestPath
  const canonicalTarget = resolve(config.manifestPath)
  const profilePath = resolve(config.profilePath)
  const requested = inspect(adapters, requestedPath, { allowMissing: true })
  const target = sameResolvedPath(requestedPath, canonicalTarget)
    ? requested
    : inspect(adapters, canonicalTarget, { allowMissing: true })
  const requestedExists = manifestExists(requested)
  const targetExists = manifestExists(target)

  if (!requestedExists && !targetExists) return manifestReceiptAbsent()
  if (!requestedExists || !targetExists) fail('fixture manifest alias identity mismatch')

  const requestedCanonical = realPathOf(requested, requestedPath)
  const targetCanonical = realPathOf(target, canonicalTarget)
  if (
    requestedCanonical !== targetCanonical
    || targetCanonical !== canonicalTarget
    || !isInside(profilePath, targetCanonical)
  ) {
    fail('fixture manifest canonical identity mismatch')
  }
  if (
    requested.regularFile === false
    || requested.directory === true
    || target.regularFile === false
    || target.directory === true
  ) {
    fail('fixture manifest must be a regular file')
  }
  if (requested.mode !== 0o600 || target.mode !== 0o600) {
    fail('fixture manifest permissions must be 0600')
  }

  const fileSHA256 = adapters.fileSHA256 ?? defaultFileSHA256
  const sha256 = String(await fileSHA256(targetCanonical)).toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(sha256)) fail('fixture manifest SHA-256 is invalid')
  const unlinkFile = adapters.unlinkFile ?? ((pathname) => unlinkSync(pathname))
  await unlinkFile(targetCanonical)

  const requestedAfter = inspect(adapters, requestedPath, { allowMissing: true })
  const targetAfter = sameResolvedPath(requestedPath, canonicalTarget)
    ? requestedAfter
    : inspect(adapters, canonicalTarget, { allowMissing: true })
  if (manifestExists(requestedAfter) || manifestExists(targetAfter)) {
    fail('fixture manifest remains after canonical unlink')
  }

  return Object.freeze({
    schema_version: 1,
    existed: true,
    mode: '0600',
    sha256,
    canonical_alias_equal: true,
    removed: true,
  })
}

function sameResolvedPath(left, right) {
  return resolve(left) === resolve(right)
}

export function createFixtureCleanup(config, deps) {
  let cleanupPromise
  return () => {
    cleanupPromise ??= (async () => {
      let recordsError
      let manifestError
      let receipt
      try {
        await deps.cleanupFixtureRecords(config)
      } catch (error) {
        recordsError = error
      }
      try {
        receipt = await deps.removeManifest(config)
        deps.emitReceipt?.(receipt)
      } catch (error) {
        manifestError = error
      }
      if (recordsError) throw recordsError
      if (manifestError) throw manifestError
      return receipt
    })()
    return cleanupPromise
  }
}

export async function runFixtureLifecycle(config, deps) {
  let result
  let rootError
  let cleanupError

  try {
    await deps.stopSidecar(config)
    await deps.startFixture(config)
    const ids = await deps.readManifest(config)
    await deps.startSidecar(config)
    result = await deps.runStrictGate(Object.freeze({
      [FIXTURE_ENVIRONMENT[0]]: ids.retryableDispatchID,
      [FIXTURE_ENVIRONMENT[1]]: ids.outcomeUnknownDispatchID,
    }))
  } catch (error) {
    rootError = error
  }

  try {
    await deps.stopSidecar(config)
  } catch (error) {
    cleanupError = error
  }
  try {
    await deps.cleanupFixture(config)
  } catch (error) {
    cleanupError ??= error
  }

  if (rootError) throw rootError
  if (cleanupError) throw cleanupError
  return result
}

export function installFixtureSignalCleanup(processLike, { cancelActive, cleanup }) {
  let cleanupPromise
  let firstSignal
  const handle = (signal) => {
    firstSignal ??= signal
    if (!cleanupPromise) {
      cleanupPromise = Promise.resolve()
        .then(() => cancelActive())
        .then(() => cleanup())
        .catch(() => undefined)
        .finally(() => {
          processLike.exitCode = firstSignal === 'SIGINT' ? 130 : 143
        })
    }
    return cleanupPromise
  }
  const sigint = () => void handle('SIGINT')
  const sigterm = () => void handle('SIGTERM')
  processLike.on('SIGINT', sigint)
  processLike.on('SIGTERM', sigterm)
  const uninstall = () => {
    processLike.off('SIGINT', sigint)
    processLike.off('SIGTERM', sigterm)
  }
  uninstall.wait = () => cleanupPromise ?? Promise.resolve()
  return uninstall
}

function subprocessEnvironment(extra = {}) {
  const allowed = [
    'HOME',
    'PATH',
    'TMPDIR',
    'GOCACHE',
    'GOMODCACHE',
    'GOPATH',
    'GOPROXY',
    'GOSUMDB',
    'CGO_ENABLED',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
  ]
  const env = {}
  for (const name of allowed) {
    if (process.env[name] !== undefined) env[name] = process.env[name]
  }
  return { ...env, ...extra, DINGTALK_LIVE_SEND: '0' }
}

export function createFixtureRuntime(config, options = {}) {
  const spawnProcess = options.spawnProcess ?? spawn
  let activeChild
  let cleanupPromise

  const run = (command, args, spawnOptions = {}) => new Promise((resolvePromise, rejectPromise) => {
    let child
    try {
      child = spawnProcess(command, args, {
        shell: false,
        stdio: 'ignore',
        ...spawnOptions,
        env: subprocessEnvironment(spawnOptions.env),
      })
    } catch (error) {
      rejectPromise(error)
      return
    }
    activeChild = child
    child.once('error', (error) => {
      if (activeChild === child) activeChild = undefined
      rejectPromise(error)
    })
    child.once('exit', (code, signal) => {
      if (activeChild === child) activeChild = undefined
      if (code === 0) {
        resolvePromise()
      } else {
        rejectPromise(new Error(`K12 fixture subprocess failed (${signal ?? code ?? 'unknown'})`))
      }
    })
  })

  const controller = (action) => run(
    config.controllerPath,
    [action, '--config', config.controllerConfigPath],
  )

  const builder = (action) => {
    const common = [
      'run',
      '-tags',
      'testtools',
      './cmd/k12-live-fixture-testtools',
      action,
      '--profile',
      config.profilePath,
      '--store',
      config.storePath,
      '--manifest',
      config.manifestPath,
    ]
    if (action === 'start') {
      common.push(
        '--run-id',
        config.runID,
        '--learner',
        config.learnerID,
        '--provider',
        config.provider,
        '--model',
        config.model,
        '--lease',
        '30m',
      )
    }
    return run('go', common, { cwd: config.localSource })
  }

  const cleanupFixture = createFixtureCleanup(config, {
    cleanupFixtureRecords: () => builder('cleanup'),
    removeManifest: () => removeCanonicalManifest(config),
    emitReceipt: (receipt) => {
      process.stderr.write(
        `K12 fixture manifest cleanup receipt: ${JSON.stringify(receipt)}\n`,
      )
    },
  })

  const readManifest = async () => {
    const link = lstatSync(config.manifestPath)
    if (link.isSymbolicLink()) fail('fixture manifest must not be a symbolic link')
    const path = realpathSync(config.manifestPath)
    const stat = statSync(path)
    return readOpaqueManifest(readFileSync(path), {
      regularFile: stat.isFile(),
      mode: stat.mode & 0o777,
      manifestPath: path,
      profilePath: config.profilePath,
    })
  }

  const cancelActive = async () => {
    const child = activeChild
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    await new Promise((resolvePromise) => {
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }, 2_000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolvePromise()
      })
      child.kill('SIGTERM')
    })
  }

  const runtime = {
    stopSidecar: () => controller('stop'),
    startSidecar: () => controller('start'),
    startFixture: () => builder('start'),
    cleanupFixture,
    readManifest,
    cancelActive,
  }
  runtime.cleanup = () => {
    cleanupPromise ??= (async () => {
      await cancelActive()
      let rootError
      try {
        await runtime.stopSidecar()
      } catch (error) {
        rootError = error
      }
      try {
        await runtime.cleanupFixture()
      } catch (error) {
        rootError ??= error
      }
      if (rootError) throw rootError
    })()
    return cleanupPromise
  }
  return runtime
}
