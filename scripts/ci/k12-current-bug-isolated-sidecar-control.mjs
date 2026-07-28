#!/usr/bin/env node

import { spawn, execFile as execFileCallback } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)

const CONFIG_FIELDS = [
  'binary_path',
  'binary_sha256',
  'expected_version',
  'host',
  'lock_file',
  'pid_file',
  'port',
  'profile_dir',
  'release_attestation_path',
  'release_attestation_sha256',
  'release_ui_url',
  'schema_version',
  'shutdown_timeout_ms',
  'sidecar_config_path',
  'sidecar_config_sha256',
  'sidecar_url',
  'startup_timeout_ms',
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

const PRIVATE_FILE_MODE = 0o600
const PRIVATE_DIRECTORY_MODE = 0o700
const FORBIDDEN_PORT = 18080
const RELEASE_UI_URL = 'http://localhost:16060'

function fail(message) {
  throw new Error(`K12 isolated Sidecar controller: ${message}`)
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

function samePath(left, right) {
  return resolve(left) === resolve(right)
}

function defaultInspectPath(pathname, { allowMissing = false } = {}) {
  try {
    const link = lstatSync(pathname)
    if (link.isSymbolicLink()) fail('symbolic links are forbidden')
    const canonicalPath = realpathSync(pathname)
    const stat = statSync(canonicalPath)
    return {
      kind: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other',
      canonicalPath,
      mode: stat.mode & 0o777,
      executable: (stat.mode & 0o111) !== 0,
      symlink: false,
    }
  } catch (error) {
    if (!allowMissing || error?.code !== 'ENOENT') throw error
    const parent = realpathSync(dirname(pathname))
    return {
      kind: 'missing',
      canonicalPath: join(parent, pathname.slice(dirname(pathname).length + 1)),
      symlink: false,
    }
  }
}

function defaultFileSHA256(pathname) {
  return createHash('sha256').update(readFileSync(pathname)).digest('hex')
}

function defaultVerifyControllerReleaseAttestation({
  receiptPath,
  expectedReceiptSHA256,
}) {
  const raw = readFileSync(receiptPath)
  const receiptSHA256 = createHash('sha256').update(raw).digest('hex')
  if (receiptSHA256 !== expectedReceiptSHA256) fail('release attestation SHA-256 mismatch')
  let receipt
  try {
    receipt = JSON.parse(String(raw))
  } catch {
    fail('release attestation is not valid JSON')
  }
  if (!receipt || Array.isArray(receipt) || typeof receipt !== 'object') {
    fail('release attestation must be an object')
  }
  const fields = Object.keys(receipt).sort()
  if (
    fields.length !== RELEASE_ATTESTATION_FIELDS.length
    || fields.some((field, index) => field !== RELEASE_ATTESTATION_FIELDS[index])
  ) {
    fail('release attestation fields do not match the exact schema')
  }
  if (receipt.schema_version !== 1) fail('unsupported release attestation schema')
  return {
    releaseVersion: receipt.release_version,
    sidecarSHA256: receipt.sidecar_sha256,
    installedAppSHA256: receipt.installed_app_sha256,
    attestationSHA256: receiptSHA256,
  }
}

function inspectPath(context, pathname, options) {
  const inspected = (context.inspectPath ?? defaultInspectPath)(pathname, options)
  if (!inspected || typeof inspected !== 'object') fail('path inspection failed')
  if (inspected.symlink === true) fail('symbolic links are forbidden')
  return inspected
}

function canonicalPath(inspected, fallback) {
  return resolve(inspected.canonicalPath ?? inspected.realPath ?? inspected.path ?? fallback)
}

function requireKind(inspected, expected, name) {
  if (inspected.kind !== undefined && inspected.kind !== expected) {
    fail(`${name} must be an existing ${expected}`)
  }
  if (expected === 'file' && (inspected.regularFile === false || inspected.directory === true)) {
    fail(`${name} must be an existing file`)
  }
  if (expected === 'directory' && (inspected.directory === false || inspected.regularFile === true)) {
    fail(`${name} must be an existing directory`)
  }
}

function requireMode(inspected, expected, name) {
  if (inspected.mode !== expected) fail(`${name} permissions must be ${expected.toString(8)}`)
}

function exactTopLevelKeys(raw) {
  const keys = []
  const expression = /"((?:\\.|[^"\\])*)"\s*:/g
  let match
  while ((match = expression.exec(raw)) !== null) {
    keys.push(JSON.parse(`"${match[1]}"`))
  }
  return keys
}

function parseExactConfig(raw) {
  const text = String(raw)
  let value
  try {
    value = JSON.parse(text)
  } catch {
    fail('config is not valid JSON')
  }
  if (!value || Array.isArray(value) || typeof value !== 'object') fail('config must be an object')
  const keys = Object.keys(value).sort()
  const sourceKeys = exactTopLevelKeys(text).sort()
  if (
    keys.length !== CONFIG_FIELDS.length
    || sourceKeys.length !== CONFIG_FIELDS.length
    || keys.some((key, index) => key !== CONFIG_FIELDS[index])
    || sourceKeys.some((key, index) => key !== CONFIG_FIELDS[index])
  ) {
    fail('config fields do not match the exact schema')
  }
  return value
}

function parseYAMLScalar(raw) {
  const value = raw.trim().replace(/\s+#.*$/, '').trim()
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }
  return value
}

function parseYAMLInteger(raw) {
  const value = parseYAMLScalar(raw)
  return /^-?\d+$/.test(value) ? Number(value) : Number.NaN
}

function assignUnique(target, key, value, name) {
  if (Object.hasOwn(target, key)) fail(`sidecar config contains duplicate ${name}`)
  target[key] = value
}

function parseYAMLGradingBudget(raw) {
  const scalarFields = new Set([
    'policy_version',
    'queued_seconds',
    'normalizing_seconds',
    'recognizing_seconds',
    'locating_seconds',
    'rendering_seconds',
    'projecting_seconds',
    'item_concurrency',
  ])
  let k12Indent
  let k12ChildIndent
  let gradingBudgetIndent
  let bucketsIndent
  let currentBucket
  let gradingBudget

  for (const line of raw.split(/\r?\n/)) {
    if (/^\s*(?:#.*)?$/.test(line)) continue
    const indent = line.match(/^\s*/)[0].length
    const content = line.trim()
    if (k12Indent === undefined) {
      if (indent === 0 && /^k12:\s*(?:#.*)?$/.test(content)) k12Indent = indent
      continue
    }
    if (indent <= k12Indent) break
    if (gradingBudgetIndent === undefined) {
      k12ChildIndent ??= indent
      if (
        indent === k12ChildIndent
        && /^grading_budget:\s*(?:#.*)?$/.test(content)
      ) {
        gradingBudgetIndent = indent
        gradingBudget = {}
      }
      continue
    }
    if (indent <= gradingBudgetIndent) break

    if (bucketsIndent !== undefined && indent > bucketsIndent) {
      let match = content.match(/^-\s*max_problems:\s*(.*?)\s*$/)
      if (match) {
        currentBucket = {}
        gradingBudget.assessing_buckets.push(currentBucket)
        assignUnique(
          currentBucket,
          'max_problems',
          parseYAMLInteger(match[1]),
          'k12.grading_budget.assessing_buckets.max_problems',
        )
        continue
      }
      match = content.match(/^seconds:\s*(.*?)\s*$/)
      if (match && currentBucket) {
        assignUnique(
          currentBucket,
          'seconds',
          parseYAMLInteger(match[1]),
          'k12.grading_budget.assessing_buckets.seconds',
        )
      }
      continue
    }
    if (bucketsIndent !== undefined) {
      bucketsIndent = undefined
      currentBucket = undefined
    }

    if (/^assessing_buckets:\s*(?:#.*)?$/.test(content)) {
      assignUnique(
        gradingBudget,
        'assessing_buckets',
        [],
        'k12.grading_budget.assessing_buckets',
      )
      bucketsIndent = indent
      continue
    }
    const scalar = content.match(/^([a-z_]+):\s*(.*?)\s*$/)
    if (scalar && scalarFields.has(scalar[1])) {
      assignUnique(
        gradingBudget,
        scalar[1],
        parseYAMLInteger(scalar[2]),
        `k12.grading_budget.${scalar[1]}`,
      )
    }
  }
  return gradingBudget
}

export function parseSidecarBinding(raw) {
  try {
    const parsed = JSON.parse(raw)
    return {
      host: parsed?.server?.host,
      port: parsed?.server?.port,
      gradingBudget: parsed?.k12?.grading_budget,
    }
  } catch {
    // HexClaw's canonical config is YAML.
  }
  let inServer = false
  let serverIndent = -1
  let host
  let port
  for (const line of raw.split(/\r?\n/)) {
    if (/^\s*(?:#.*)?$/.test(line)) continue
    const indent = line.match(/^\s*/)[0].length
    const content = line.trim()
    if (!inServer) {
      if (indent === 0 && /^server:\s*(?:#.*)?$/.test(content)) {
        inServer = true
        serverIndent = indent
      }
      continue
    }
    if (indent <= serverIndent) break
    const match = content.match(/^(host|port):\s*(.*?)\s*$/)
    if (!match) continue
    if (match[1] === 'host') {
      if (host !== undefined) fail('sidecar config contains duplicate server.host')
      host = parseYAMLScalar(match[2])
    } else {
      if (port !== undefined) fail('sidecar config contains duplicate server.port')
      port = parseYAMLInteger(match[2])
    }
  }
  return { host, port, gradingBudget: parseYAMLGradingBudget(raw) }
}

function defaultReadSidecarBinding(pathname) {
  return parseSidecarBinding(readFileSync(pathname, 'utf8'))
}

function requireFrozenGradingBudget(binding) {
  const gradingBudget = binding?.gradingBudget
  if (!gradingBudget || Array.isArray(gradingBudget) || typeof gradingBudget !== 'object') {
    fail('sidecar config requires a frozen K12 grading budget')
  }
  if (!Number.isInteger(gradingBudget.policy_version) || gradingBudget.policy_version <= 0) {
    fail('k12.grading_budget.policy_version must be a positive integer')
  }
  for (const field of [
    'queued_seconds',
    'normalizing_seconds',
    'recognizing_seconds',
    'locating_seconds',
    'rendering_seconds',
    'projecting_seconds',
  ]) {
    if (!Number.isInteger(gradingBudget[field]) || gradingBudget[field] <= 0) {
      fail(`k12.grading_budget.${field} must be a positive integer`)
    }
  }
  const requiredBucketSizes = [1, 8, 16, 32]
  if (
    !Array.isArray(gradingBudget.assessing_buckets)
    || gradingBudget.assessing_buckets.length !== requiredBucketSizes.length
    || gradingBudget.assessing_buckets.some((bucket, index) => (
      !bucket
      || Array.isArray(bucket)
      || typeof bucket !== 'object'
      || bucket.max_problems !== requiredBucketSizes[index]
      || !Number.isInteger(bucket.seconds)
      || bucket.seconds <= 0
    ))
  ) {
    fail('k12.grading_budget.assessing_buckets must contain ordered positive 1/8/16/32 buckets')
  }
  if (
    !Number.isInteger(gradingBudget.item_concurrency)
    || gradingBudget.item_concurrency < 1
    || gradingBudget.item_concurrency > 32
  ) {
    fail('k12.grading_budget.item_concurrency must be an integer from 1 through 32')
  }
}

export function parseControllerCLI(argv) {
  if (
    !Array.isArray(argv)
    || argv.length !== 3
    || !['start', 'stop'].includes(argv[0])
    || argv[1] !== '--config'
    || typeof argv[2] !== 'string'
    || !isAbsolute(argv[2])
    || !canonicalTmp(resolve(argv[2]))
  ) {
    fail('usage: start|stop --config <absolute-/tmp-json>')
  }
  return Object.freeze({ action: argv[0], configPath: argv[2] })
}

export function validateControllerConfig(raw, context = {}) {
  const value = parseExactConfig(raw)
  if (!isAbsolute(context.configPath ?? '') || !canonicalTmp(resolve(context.configPath))) {
    fail('controller config path must be absolute and below /tmp')
  }
  const configFile = inspectPath(context, context.configPath)
  requireKind(configFile, 'file', 'controller config')
  requireMode(configFile, PRIVATE_FILE_MODE, 'controller config')
  if (!canonicalTmp(canonicalPath(configFile, context.configPath))) {
    fail('controller config must resolve below /tmp')
  }

  if (value.schema_version !== 2) fail('unsupported schema version')
  if (value.host !== '127.0.0.1') fail('host must be 127.0.0.1')
  if (!Number.isInteger(value.port) || value.port < 1024 || value.port > 65535 || value.port === FORBIDDEN_PORT) {
    fail('port is invalid or forbidden')
  }
  if (value.sidecar_url !== `http://${value.host}:${value.port}`) {
    fail('sidecar_url must exactly match the configured Sidecar host/port')
  }
  if (value.release_ui_url !== RELEASE_UI_URL) {
    fail('release_ui_url must be the canonical exact-byte release origin')
  }
  if (value.sidecar_url === value.release_ui_url) fail('release UI and Sidecar origins must be distinct')
  for (const [name, timeout] of [
    ['startup_timeout_ms', value.startup_timeout_ms],
    ['shutdown_timeout_ms', value.shutdown_timeout_ms],
  ]) {
    if (!Number.isInteger(timeout) || timeout < 1_000 || timeout > 120_000) {
      fail(`${name} is outside the allowed range`)
    }
  }
  if (typeof value.expected_version !== 'string' || value.expected_version.trim() === '') {
    fail('expected_version is required')
  }
  for (const field of [
    'sidecar_config_sha256',
    'binary_sha256',
    'release_attestation_sha256',
  ]) {
    if (typeof value[field] !== 'string' || !/^[a-f0-9]{64}$/.test(value[field])) {
      fail(`${field} must be 64 lowercase hex characters`)
    }
  }
  for (const field of [
    'profile_dir',
    'sidecar_config_path',
    'binary_path',
    'release_attestation_path',
    'pid_file',
    'lock_file',
  ]) {
    if (typeof value[field] !== 'string' || !isAbsolute(value[field])) {
      fail(`${field} must be absolute`)
    }
  }

  const profile = inspectPath(context, value.profile_dir)
  const sidecarConfig = inspectPath(context, value.sidecar_config_path)
  const binary = inspectPath(context, value.binary_path)
  const releaseAttestation = inspectPath(context, value.release_attestation_path)
  const pidFile = inspectPath(context, value.pid_file, { allowMissing: true })
  const lockFile = inspectPath(context, value.lock_file, { allowMissing: true })
  requireKind(profile, 'directory', 'profile_dir')
  requireMode(profile, PRIVATE_DIRECTORY_MODE, 'profile_dir')
  requireKind(sidecarConfig, 'file', 'sidecar_config_path')
  requireMode(sidecarConfig, PRIVATE_FILE_MODE, 'sidecar_config_path')
  requireKind(binary, 'file', 'binary_path')
  if (binary.executable === false) fail('binary_path must be executable')
  requireKind(releaseAttestation, 'file', 'release_attestation_path')
  requireMode(releaseAttestation, PRIVATE_FILE_MODE, 'release_attestation_path')
  for (const [inspected, name] of [[pidFile, 'pid_file'], [lockFile, 'lock_file']]) {
    if (inspected.kind !== 'missing') {
      requireKind(inspected, 'file', name)
      requireMode(inspected, PRIVATE_FILE_MODE, name)
    }
  }

  const profileDir = canonicalPath(profile, value.profile_dir)
  const sidecarConfigPath = canonicalPath(sidecarConfig, value.sidecar_config_path)
  const binaryPath = canonicalPath(binary, value.binary_path)
  const releaseAttestationPath = canonicalPath(releaseAttestation, value.release_attestation_path)
  const pidFilePath = canonicalPath(pidFile, value.pid_file)
  const lockFilePath = canonicalPath(lockFile, value.lock_file)
  if (!canonicalTmp(profileDir)) fail('profile_dir must resolve below /tmp')
  const homeDirectory = resolve(context.homeDirectory ?? process.env.HOME ?? '')
  const userProfile = join(homeDirectory, '.hexclaw')
  if (samePath(profileDir, userProfile) || isInside(userProfile, profileDir)) {
    fail('user profile is forbidden')
  }
  for (const [pathname, name] of [
    [sidecarConfigPath, 'sidecar_config_path'],
    [pidFilePath, 'pid_file'],
    [lockFilePath, 'lock_file'],
  ]) {
    if (!isInside(profileDir, pathname)) fail(`${name} must resolve inside profile_dir`)
  }
  if (!samePath(pidFilePath, join(profileDir, '.hexclaw', '.k12-sidecar.pid'))) {
    fail('pid_file must be profile/.hexclaw/.k12-sidecar.pid')
  }
  if (!samePath(lockFilePath, join(profileDir, '.hexclaw', '.sidecar.lock'))) {
    fail('lock_file must be profile/.hexclaw/.sidecar.lock')
  }

  const fileSHA256 = context.fileSHA256 ?? defaultFileSHA256
  if (fileSHA256(binaryPath).toLowerCase() !== value.binary_sha256) fail('binary SHA-256 mismatch')
  if (fileSHA256(sidecarConfigPath).toLowerCase() !== value.sidecar_config_sha256) {
    fail('sidecar config SHA-256 mismatch')
  }
  if (fileSHA256(releaseAttestationPath).toLowerCase() !== value.release_attestation_sha256) {
    fail('release attestation SHA-256 mismatch')
  }
  const readBinding = context.readSidecarBinding ?? defaultReadSidecarBinding
  const binding = readBinding(sidecarConfigPath)
  if (binding?.host !== value.host || binding?.port !== value.port) {
    fail('sidecar config host/port drift')
  }
  requireFrozenGradingBudget(binding)
  const verifyReleaseAttestation = context.verifyReleaseAttestation
    ?? defaultVerifyControllerReleaseAttestation
  const attestation = verifyReleaseAttestation({
    receiptPath: releaseAttestationPath,
    expectedReceiptSHA256: value.release_attestation_sha256,
  })
  const attestationSHA256 = attestation?.attestationSHA256 ?? attestation?.receiptSHA256
  for (const [name, digest] of [
    ['release attestation SHA-256', attestationSHA256],
    ['installed app SHA-256', attestation?.installedAppSHA256],
    ['release Sidecar SHA-256', attestation?.sidecarSHA256],
  ]) {
    if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) {
      fail(`${name} is invalid`)
    }
  }
  if (attestationSHA256 !== value.release_attestation_sha256) {
    fail('release attestation verifier identity mismatch')
  }
  if (attestation.releaseVersion !== value.expected_version) {
    fail('release attestation version mismatch')
  }
  if (attestation.sidecarSHA256 !== value.binary_sha256) {
    fail('release attestation Sidecar identity mismatch')
  }

  return Object.freeze({
    profileDir,
    sidecarConfigPath,
    sidecarConfigSHA256: value.sidecar_config_sha256,
    binaryPath,
    binarySHA256: value.binary_sha256,
    expectedVersion: value.expected_version,
    host: value.host,
    port: value.port,
    sidecarURL: value.sidecar_url,
    releaseUIURL: value.release_ui_url,
    releaseAttestationPath,
    releaseAttestationSHA256: value.release_attestation_sha256,
    releaseInstalledAppSHA256: attestation.installedAppSHA256,
    pidFile: pidFilePath,
    lockFile: lockFilePath,
    startupTimeoutMs: value.startup_timeout_ms,
    shutdownTimeoutMs: value.shutdown_timeout_ms,
  })
}

function expectedArgv(config) {
  return [
    config.binaryPath,
    'serve',
    '--desktop',
    '--config',
    config.sidecarConfigPath,
  ]
}

function positivePID(value) {
  return Number.isInteger(value) && value > 0
}

function exactArray(left, right) {
  return Array.isArray(left)
    && left.length === right.length
    && left.every((value, index) => value === right[index])
}

function assertOwnedProcess(config, snapshot, expectedPID) {
  const processState = snapshot?.process
  if (
    !processState
    || !positivePID(processState.pid)
    || processState.pid !== expectedPID
    || !samePath(processState.executablePath, config.binaryPath)
    || !exactArray(processState.argv, expectedArgv(config))
    || processState.binarySHA256 !== config.binarySHA256
  ) {
    fail('process identity mismatch')
  }
  return expectedPID
}

export function assertRunningIdentity(config, snapshot) {
  const pid = snapshot?.pidFilePID
  if (
    !positivePID(pid)
    || snapshot.listenerPID !== pid
    || snapshot.lockPID !== pid
  ) {
    fail('PID/listener/lock identity mismatch')
  }
  assertOwnedProcess(config, snapshot, pid)
  if (
    snapshot.healthStatus !== 200
    || snapshot.versionStatus !== 200
    || snapshot.version !== config.expectedVersion
    || snapshot.sidecarRootStatus !== 404
  ) {
    fail('health/version identity mismatch')
  }
  if (
    snapshot.releaseUIStatus !== 200
    || snapshot.releaseUIProxyHealthStatus !== 200
    || snapshot.releaseAttestationStatus !== 200
    || snapshot.releaseAttestationSHA256 !== config.releaseAttestationSHA256
    || snapshot.releaseInstalledAppSHA256 !== config.releaseInstalledAppSHA256
    || snapshot.releaseSidecarSHA256 !== config.binarySHA256
    || snapshot.releaseVersion !== config.expectedVersion
  ) {
    fail('release UI/attestation identity mismatch')
  }
  return pid
}

function hasEndpointEvidence(snapshot) {
  return [
    snapshot?.healthStatus,
    snapshot?.versionStatus,
    snapshot?.sidecarRootStatus,
  ].some((value) => value !== null && value !== undefined)
}

function matchesOwnedProcess(config, snapshot, expectedPID) {
  try {
    assertOwnedProcess(config, snapshot, expectedPID)
    return true
  } catch {
    return false
  }
}

function stalePIDReceipt({
  pidFileExisted,
  pidAlive,
  ownedProcess,
  listenerPresent,
  lockPresent,
  pidFileRemoved,
}) {
  return Object.freeze({
    schema_version: 1,
    pid_file_existed: pidFileExisted,
    pid_alive: pidAlive,
    owned_process: ownedProcess,
    listener_present: listenerPresent,
    lock_present: lockPresent,
    signal_sent: false,
    pid_file_removed: pidFileRemoved,
  })
}

export async function normalizeStoppedState(config, snapshot, deps = {}) {
  const pid = snapshot?.pidFilePID
  const pidFileExisted = positivePID(pid)
  const pidAlive = snapshot?.process !== null && snapshot?.process !== undefined
  const ownedProcess = pidFileExisted && pidAlive
    ? matchesOwnedProcess(config, snapshot, pid)
    : false
  const listenerPresent = snapshot?.listenerPID !== null
    && snapshot?.listenerPID !== undefined
  const lockPresent = snapshot?.lockPID !== null
    && snapshot?.lockPID !== undefined
  const boundaryMismatch = (
    listenerPresent && snapshot.listenerPID !== pid
  ) || (
    lockPresent && snapshot.lockPID !== pid
  )

  if (ownedProcess && !boundaryMismatch) {
    return Object.freeze({
      state: 'owned',
      pid,
      receipt: stalePIDReceipt({
        pidFileExisted,
        pidAlive,
        ownedProcess,
        listenerPresent,
        lockPresent,
        pidFileRemoved: false,
      }),
    })
  }

  if (listenerPresent || lockPresent || hasEndpointEvidence(snapshot)) {
    return Object.freeze({
      state: 'blocked',
      receipt: stalePIDReceipt({
        pidFileExisted,
        pidAlive,
        ownedProcess,
        listenerPresent,
        lockPresent,
        pidFileRemoved: false,
      }),
    })
  }

  let pidFileRemoved = false
  if (pidFileExisted) {
    if (typeof deps.removePIDFile !== 'function') fail('safe PID-file remover is required')
    await deps.removePIDFile(config.pidFile, {
      expectedPID: pid,
      expectedMode: PRIVATE_FILE_MODE,
      rejectSymlink: true,
    })
    pidFileRemoved = true
  }
  return Object.freeze({
    state: 'stopped',
    receipt: stalePIDReceipt({
      pidFileExisted,
      pidAlive,
      ownedProcess,
      listenerPresent,
      lockPresent,
      pidFileRemoved,
    }),
  })
}

export function assertStoppedState(_config, snapshot) {
  if (
    snapshot?.pidFilePID !== null
    || snapshot?.process !== null
    || snapshot?.listenerPID !== null
    || snapshot?.lockPID !== null
    || (snapshot?.healthStatus !== null && snapshot?.healthStatus !== undefined)
    || (snapshot?.versionStatus !== null && snapshot?.versionStatus !== undefined)
  ) {
    fail('Sidecar is not fully stopped')
  }
  return true
}

function assertQuiescent(snapshot) {
  if (
    snapshot?.process !== null
    || snapshot?.listenerPID !== null
    || snapshot?.lockPID !== null
    || (snapshot?.healthStatus !== null && snapshot?.healthStatus !== undefined)
    || (snapshot?.versionStatus !== null && snapshot?.versionStatus !== undefined)
  ) {
    fail('Sidecar did not release process, port, lock and health endpoints')
  }
}

export async function startIsolatedSidecar(config, deps) {
  const initial = await deps.inspectState(config)
  const normalized = await normalizeStoppedState(config, initial, deps)
  if (normalized.state !== 'stopped') fail('Sidecar is not fully stopped')
  if (normalized.receipt.pid_file_removed) {
    assertStoppedState(config, await deps.inspectState(config))
  } else {
    assertStoppedState(config, initial)
  }
  let pid
  try {
    const child = await deps.spawnSidecar(
      config.binaryPath,
      ['serve', '--desktop', '--config', config.sidecarConfigPath],
      {
        shell: false,
        detached: true,
        env: {
          HOME: config.profileDir,
          DINGTALK_LIVE_SEND: '0',
        },
      },
    )
    pid = child?.pid
    if (!positivePID(pid)) fail('spawn did not return a valid PID')
    await deps.writePIDFile(config.pidFile, String(pid), {
      mode: PRIVATE_FILE_MODE,
      atomic: true,
    })
    const running = await deps.waitForRunning(config, pid)
    if (assertRunningIdentity(config, running) !== pid) fail('spawned PID drift')
    return pid
  } catch (rootError) {
    if (positivePID(pid)) {
      try {
        await deps.cleanupStartedProcess(pid, config)
      } catch {
        // The root start failure remains authoritative.
      }
    }
    throw rootError
  }
}

export async function stopIsolatedSidecar(config, deps) {
  const initial = await deps.inspectState(config)
  const normalized = await normalizeStoppedState(config, initial, deps)
  if (normalized.state === 'stopped') return
  if (normalized.state === 'blocked') fail('Sidecar is not fully stopped')

  const pid = normalized.pid
  assertOwnedProcess(config, initial, pid)
  await deps.signalProcess(pid, 'SIGTERM')
  let stopped
  try {
    stopped = await deps.waitForStopped(config, pid, config.shutdownTimeoutMs)
  } catch (error) {
    if (error?.code !== 'TIMEOUT') throw error
    const current = await deps.inspectState(config)
    assertOwnedProcess(config, current, pid)
    await deps.signalProcess(pid, 'SIGKILL')
    stopped = await deps.waitForStopped(config, pid, config.shutdownTimeoutMs)
  }
  assertQuiescent(stopped)
  await deps.removePIDFile(config.pidFile, {
    expectedPID: pid,
    expectedMode: PRIVATE_FILE_MODE,
    rejectSymlink: true,
  })
}

export function installControllerSignalCleanup(processLike, { cancelActive, cleanup }) {
  let cleanupPromise
  let firstSignal
  const handle = (signal) => {
    firstSignal ??= signal
    cleanupPromise ??= Promise.resolve()
      .then(() => cancelActive())
      .then(() => cleanup())
      .catch(() => undefined)
      .finally(() => {
        processLike.exitCode = firstSignal === 'SIGINT' ? 130 : 143
      })
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

function readPIDFile(pathname) {
  try {
    const inspected = defaultInspectPath(pathname)
    requireKind(inspected, 'file', 'PID file')
    requireMode(inspected, PRIVATE_FILE_MODE, 'PID file')
    const value = Number.parseInt(readFileSync(pathname, 'utf8').trim(), 10)
    if (!positivePID(value)) fail('PID file is invalid')
    return value
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function listenerPID(port) {
  try {
    const { stdout } = await execFile('lsof', [
      '-nP',
      `-iTCP:${port}`,
      '-sTCP:LISTEN',
      '-t',
    ])
    const values = [...new Set(
      stdout.split(/\s+/).filter(Boolean).map(Number).filter(positivePID),
    )]
    if (values.length === 0) return null
    return values.length === 1 ? values[0] : -1
  } catch (error) {
    if (error?.code === 1) return null
    return null
  }
}

function alive(pid) {
  if (!positivePID(pid)) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

async function processExecutable(pid) {
  try {
    const { stdout } = await execFile('lsof', [
      '-a',
      '-p',
      String(pid),
      '-d',
      'txt',
      '-Fn',
    ])
    const pathname = stdout.split(/\r?\n/).find((line) => line.startsWith('n'))?.slice(1)
    if (pathname) return realpathSync(pathname)
  } catch {
    // Fall through to ps comm.
  }
  const { stdout } = await execFile('ps', ['-p', String(pid), '-o', 'comm='])
  return realpathSync(stdout.trim())
}

async function inspectProcess(pid, config) {
  if (!alive(pid)) return null
  const { stdout } = await execFile('ps', ['-ww', '-p', String(pid), '-o', 'command='])
  const command = stdout.trim()
  const expected = expectedArgv(config)
  const executablePath = await processExecutable(pid)
  let binarySHA256 = ''
  try {
    binarySHA256 = defaultFileSHA256(executablePath)
  } catch {
    // Empty SHA makes the identity guard fail closed.
  }
  return {
    pid,
    executablePath,
    argv: command === expected.join(' ') ? expected : [command],
    binarySHA256,
  }
}

async function httpEvidence(config, listener) {
  const request = async (base, path) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 1_000)
    try {
      const response = await fetch(`${base}${path}`, {
        method: 'GET',
        signal: controller.signal,
      })
      let body
      try {
        body = await response.json()
      } catch {
        body = null
      }
      return { status: response.status, body }
    } catch {
      return { status: null, body: null }
    } finally {
      clearTimeout(timer)
    }
  }
  const sidecarBase = config.sidecarURL ?? `http://${config.host}:${config.port}`
  const releaseUIBase = config.releaseUIURL ?? RELEASE_UI_URL
  const health = positivePID(listener)
    ? await request(sidecarBase, '/health')
    : { status: null, body: null }
  const version = positivePID(listener)
    ? await request(sidecarBase, '/api/v1/version')
    : { status: null, body: null }
  const sidecarRoot = positivePID(listener)
    ? await request(sidecarBase, '/')
    : { status: null, body: null }
  const releaseUI = await request(releaseUIBase, '/')
  const releaseProxyHealth = await request(releaseUIBase, '/health')
  const releaseAttestation = await request(
    releaseUIBase,
    '/__hexclaw_release_attestation',
  )
  return {
    healthStatus: health.status === 200 && health.body?.status === 'healthy' ? 200 : health.status,
    versionStatus: version.status,
    version: version.body?.version ?? null,
    sidecarRootStatus: sidecarRoot.status,
    releaseUIStatus: releaseUI.status,
    releaseUIProxyHealthStatus: releaseProxyHealth.status === 200
      && releaseProxyHealth.body?.status === 'healthy'
      ? 200
      : releaseProxyHealth.status,
    releaseAttestationStatus: releaseAttestation.status,
    releaseAttestationSHA256: releaseAttestation.body?.receipt_sha256 ?? null,
    releaseInstalledAppSHA256: releaseAttestation.body?.installed_app_sha256 ?? null,
    releaseSidecarSHA256: releaseAttestation.body?.sidecar_sha256 ?? null,
    releaseVersion: releaseAttestation.body?.release_version ?? null,
  }
}

function atomicPIDWrite(pathname, value) {
  mkdirSync(dirname(pathname), { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
  const temporary = `${pathname}.tmp.${process.pid}.${Date.now()}`
  writeFileSync(temporary, `${value}\n`, { mode: PRIVATE_FILE_MODE, flag: 'wx' })
  chmodSync(temporary, PRIVATE_FILE_MODE)
  renameSync(temporary, pathname)
}

function removeFile(pathname) {
  try {
    unlinkSync(pathname)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

function removeControllerPIDFile(pathname, identity = {}) {
  let first
  try {
    first = lstatSync(pathname)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  if ((identity.rejectSymlink ?? true) && first.isSymbolicLink()) {
    fail('PID file became a symbolic link')
  }
  if (!first.isFile()) fail('PID file must remain a regular file')
  const expectedMode = identity.expectedMode ?? PRIVATE_FILE_MODE
  if ((first.mode & 0o777) !== expectedMode) fail('PID file permissions changed')
  const actualPID = Number.parseInt(readFileSync(pathname, 'utf8').trim(), 10)
  if (!positivePID(actualPID)) fail('PID file is invalid')
  if (positivePID(identity.expectedPID) && actualPID !== identity.expectedPID) {
    fail('PID file identity changed')
  }
  const second = lstatSync(pathname)
  if (
    second.isSymbolicLink()
    || !second.isFile()
    || second.dev !== first.dev
    || second.ino !== first.ino
    || (second.mode & 0o777) !== expectedMode
  ) {
    fail('PID file identity changed before unlink')
  }
  unlinkSync(pathname)
  try {
    lstatSync(pathname)
    fail('PID file remains after unlink')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
}

export function createSystemControllerRuntime(config) {
  let activePID
  let cleanupPromise
  let cancelled = false

  const inspectState = async () => {
    const pidFilePID = readPIDFile(config.pidFile)
    const lockPID = readPIDFile(config.lockFile)
    const listener = await listenerPID(config.port)
    const candidate = pidFilePID ?? listener ?? lockPID
    const processState = positivePID(candidate)
      ? await inspectProcess(candidate, config)
      : null
    return {
      pidFilePID,
      process: processState,
      listenerPID: listener,
      lockPID,
      ...await httpEvidence(config, listener),
    }
  }

  const removeOwnedStaleLock = async (pathname, expectedPID) => {
    const lockPID = readPIDFile(pathname)
    if (lockPID !== expectedPID || alive(expectedPID)) fail('stale lock ownership changed')
    removeFile(pathname)
  }

  const waitForRunning = async (_config, pid) => {
    const deadline = Date.now() + config.startupTimeoutMs
    let lastError
    while (Date.now() < deadline) {
      if (cancelled) fail('start cancelled')
      const snapshot = await inspectState()
      try {
        if (assertRunningIdentity(config, snapshot) === pid) return snapshot
      } catch (error) {
        lastError = error
      }
      await delay(100)
    }
    const timeout = new Error(lastError?.message ?? 'Sidecar start timed out')
    timeout.code = 'TIMEOUT'
    throw timeout
  }

  const waitForStopped = async (_config, pid, timeoutMilliseconds) => {
    const deadline = Date.now() + timeoutMilliseconds
    while (Date.now() < deadline) {
      const snapshot = await inspectState()
      if (snapshot.process === null && snapshot.listenerPID === null) {
        if (snapshot.lockPID === pid) await removeOwnedStaleLock(config.lockFile, pid)
        const final = await inspectState()
        if (
          final.process === null
          && final.listenerPID === null
          && final.lockPID === null
          && final.healthStatus === null
          && final.versionStatus === null
        ) {
          return final
        }
      }
      await delay(100)
    }
    const error = new Error('Sidecar stop timed out')
    error.code = 'TIMEOUT'
    throw error
  }

  const signalOwned = async (pid, signal) => {
    const snapshot = await inspectState()
    assertOwnedProcess(config, snapshot, pid)
    process.kill(pid, signal)
  }

  const cleanupStartedProcess = async (pid) => {
    const snapshot = await inspectState()
    if (snapshot.process !== null) {
      assertOwnedProcess(config, snapshot, pid)
      process.kill(pid, 'SIGTERM')
      try {
        await waitForStopped(config, pid, config.shutdownTimeoutMs)
      } catch (error) {
        if (error?.code !== 'TIMEOUT') throw error
        const current = await inspectState()
        assertOwnedProcess(config, current, pid)
        process.kill(pid, 'SIGKILL')
        await waitForStopped(config, pid, config.shutdownTimeoutMs)
      }
    } else {
      if (snapshot.listenerPID !== null) fail('listener remains without owned process')
      if (snapshot.lockPID === pid) await removeOwnedStaleLock(config.lockFile, pid)
    }
    removeControllerPIDFile(config.pidFile, {
      expectedPID: pid,
      expectedMode: PRIVATE_FILE_MODE,
      rejectSymlink: true,
    })
    if (activePID === pid) activePID = undefined
  }

  const runtime = {
    inspectState,
    spawnSidecar: async (command, args, options) => {
      const allowed = {}
      for (const name of ['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
        if (process.env[name] !== undefined) allowed[name] = process.env[name]
      }
      const child = spawn(command, args, {
        shell: false,
        detached: options.detached,
        stdio: 'ignore',
        env: { ...allowed, ...options.env },
      })
      await new Promise((resolvePromise, rejectPromise) => {
        child.once('spawn', resolvePromise)
        child.once('error', rejectPromise)
      })
      activePID = child.pid
      child.unref()
      return { pid: child.pid }
    },
    writePIDFile: async (pathname, value) => atomicPIDWrite(pathname, value),
    waitForRunning,
    cleanupStartedProcess,
    signalProcess: signalOwned,
    waitForStopped,
    removePIDFile: async (pathname, identity) => removeControllerPIDFile(pathname, identity),
    removeStaleLock: removeOwnedStaleLock,
  }
  runtime.cancelActive = async () => {
    cancelled = true
    if (positivePID(activePID)) await cleanupStartedProcess(activePID)
  }
  runtime.cleanup = () => {
    cleanupPromise ??= runtime.cancelActive()
    return cleanupPromise
  }
  return runtime
}

export async function runControllerCLI(argv, context = {}) {
  const parsed = parseControllerCLI(argv)
  const raw = readFileSync(parsed.configPath, 'utf8')
  const config = validateControllerConfig(raw, {
    configPath: parsed.configPath,
    homeDirectory: context.homeDirectory,
  })
  const runtime = context.runtime ?? createSystemControllerRuntime(config)
  const uninstall = installControllerSignalCleanup(context.processLike ?? process, {
    cancelActive: runtime.cancelActive,
    cleanup: runtime.cleanup,
  })
  try {
    if (parsed.action === 'start') {
      await startIsolatedSidecar(config, runtime)
    } else {
      await stopIsolatedSidecar(config, runtime)
    }
  } finally {
    uninstall()
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  runControllerCLI(process.argv.slice(2)).catch((error) => {
    if (![130, 143].includes(process.exitCode)) process.exitCode = 1
    process.stderr.write(`${error.message}\n`)
  })
}
