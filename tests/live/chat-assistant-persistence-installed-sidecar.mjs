#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFile as execFileCallback, spawn } from 'node:child_process'
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
} from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)
const EXPECTED_PROVIDER = 'hexclaw-gpt'
const EXPECTED_MODEL = 'gpt-5.6-sol'
const MAX_CHAT_SUBMISSIONS = 1
const LIVE_BUDGET_MS = 28 * 60_000
const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
const SIDECAR_START_TIMEOUT_MS = 90_000
const CHAT_TIMEOUT_MS = 8 * 60_000
const DEFAULT_PROFILE_PORT = 16060
const DEFAULT_APP_BUNDLE = '/Applications/HexClaw.app'
const SCRIPT_PATH = fileURLToPath(import.meta.url)
const DESKTOP_ROOT = resolve(dirname(SCRIPT_PATH), '../..')
const DEFAULT_SOURCE_ROOT = resolve(DESKTOP_ROOT, '../hexclaw')
const DEFAULT_EVIDENCE_DIRECTORY = resolve(
  DESKTOP_ROOT,
  '../hexclaw-docs/test/evidence/chat-assistant-persistence-installed-sidecar',
)
const DEFAULT_GO_BINARY = '/usr/local/go/bin/go'

let chatSubmissionCount = 0

class HarnessError extends Error {
  constructor(code) {
    super(code.replaceAll('_', ' ').toLowerCase())
    this.name = 'HarnessError'
    this.code = code
  }
}

function sha256Text(value) {
  return createHash('sha256').update(String(value)).digest('hex')
}

async function sha256File(pathname) {
  return createHash('sha256').update(await readFile(pathname)).digest('hex')
}

function safeFailureCode(error, fallback = 'HARNESS_FAILED') {
  if (error instanceof HarnessError && /^[A-Z0-9_]+$/u.test(error.code)) return error.code
  return fallback
}

function resolveMode(args) {
  if (!Array.isArray(args) || args.length === 0) return 'validate'
  if (args.length !== 1 || !['validate', 'run', 'run-default-profile'].includes(args[0])) {
    throw new HarnessError('INVALID_ARGUMENTS')
  }
  return args[0]
}

function remainingBudget(deadlineAt, maximum, code) {
  const remaining = deadlineAt - Date.now()
  if (!Number.isFinite(remaining) || remaining <= 0) throw new HarnessError(code)
  return Math.max(1, Math.min(maximum, remaining))
}

const FORBIDDEN_EVIDENCE_FIELDS = new Set([
  'api_key',
  'body',
  'capability',
  'capability_token',
  'content',
  'credential_ref',
  'message',
  'owner_config',
  'path',
  'profile',
  'prompt',
  'raw',
  'reply',
  'request_body',
  'response_body',
  'source_config',
  'token',
])

function assertEvidenceSafe(value, field = '') {
  if (FORBIDDEN_EVIDENCE_FIELDS.has(field)) throw new HarnessError('UNSAFE_EVIDENCE_FIELD')
  if (typeof value === 'string') {
    if (
      value.startsWith('/') ||
      value.startsWith('file:') ||
      /\/Users\//u.test(value) ||
      /\bBearer\s+/iu.test(value) ||
      /\b(?:api[_-]?key|authorization)\s*[:=]/iu.test(value)
    ) {
      throw new HarnessError('UNSAFE_EVIDENCE_VALUE')
    }
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) assertEvidenceSafe(item, field)
    return
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) assertEvidenceSafe(item, key)
  }
}

async function requireRegularFile(
  pathname,
  code,
  { privateFile = false, executable = false } = {},
) {
  let info
  try {
    info = await lstat(pathname)
  } catch {
    throw new HarnessError(code)
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new HarnessError(code)
  if (privateFile && (info.mode & 0o777) !== PRIVATE_FILE_MODE) throw new HarnessError(code)
  if (executable && (info.mode & 0o111) === 0) throw new HarnessError(code)
  return info
}

async function requireDirectory(pathname, code) {
  let info
  try {
    info = await lstat(pathname)
  } catch {
    throw new HarnessError(code)
  }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new HarnessError(code)
  return info
}

async function createPrivateFile(pathname, bytes = '') {
  const handle = await open(pathname, 'wx', PRIVATE_FILE_MODE)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await chmod(pathname, PRIVATE_FILE_MODE)
}

async function runCommand(command, args, options, failureCode) {
  try {
    return await execFile(command, args, {
      cwd: options.cwd,
      env: options.env,
      encoding: 'utf8',
      maxBuffer: 8 << 20,
      timeout: options.timeoutMs,
      windowsHide: true,
    })
  } catch (error) {
    const wrapped = new HarnessError(failureCode)
    const digest = createHash('sha256')
    let hasOutput = false
    for (const item of [error?.stdout, error?.stderr]) {
      if (item === undefined || item === null) continue
      digest.update(Buffer.isBuffer(item) ? item : Buffer.from(String(item)))
      hasOutput = true
    }
    if (hasOutput) wrapped.diagnosticSHA256 = digest.digest('hex')
    throw wrapped
  }
}

function inheritedEnvironment(env = process.env) {
  const result = {}
  for (const name of [
    'PATH',
    'LANG',
    'LC_ALL',
    'GOCACHE',
    'GOMODCACHE',
    'GOPATH',
    'GOPROXY',
    'GOSUMDB',
    'GOENV',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
  ]) {
    if (typeof env[name] === 'string' && env[name] !== '') result[name] = env[name]
  }
  return result
}

function candidatePolicy() {
  return {
    policy_version: 1,
    queued_seconds: 600,
    normalizing_seconds: 600,
    recognizing_seconds: 600,
    locating_seconds: 600,
    rendering_seconds: 600,
    projecting_seconds: 600,
    recognition_plan_version: 1,
    assessing_buckets: [1, 8, 16, 32].map((maxProblems) => ({
      max_problems: maxProblems,
      seconds: 600,
    })),
    item_concurrency: 1,
  }
}

async function createPrivateRunRoot() {
  const canonicalTmp = await realpath('/tmp')
  const created = await mkdtemp('/tmp/hexclaw-chat-atomic-')
  await chmod(created, PRIVATE_DIRECTORY_MODE)
  const canonicalRoot = await realpath(created)
  if (
    dirname(canonicalRoot) !== canonicalTmp ||
    !basename(canonicalRoot).startsWith('hexclaw-chat-atomic-')
  ) {
    throw new HarnessError('TEMP_ROOT_OWNERSHIP_INVALID')
  }
  return { root: canonicalRoot, canonicalTmp }
}

async function removePrivateRunRoot(ownedRoot) {
  let canonicalRoot
  try {
    canonicalRoot = await realpath(ownedRoot.root)
  } catch {
    return
  }
  if (
    dirname(canonicalRoot) !== ownedRoot.canonicalTmp ||
    !basename(canonicalRoot).startsWith('hexclaw-chat-atomic-')
  ) {
    throw new HarnessError('TEMP_ROOT_REMOVAL_REFUSED')
  }
  await rm(canonicalRoot, { recursive: true, force: false, maxRetries: 0 })
}

async function reserveLoopbackPort() {
  const server = createServer()
  server.unref()
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()))
  })
  if (!Number.isInteger(port) || port < 1024 || [16060, 18080].includes(port)) {
    throw new HarnessError('LOOPBACK_PORT_INVALID')
  }
  return port
}

async function waitForPortReleased(port, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const server = createServer()
    server.unref()
    const available = await new Promise((resolveCheck) => {
      server.once('error', () => resolveCheck(false))
      server.listen(port, '127.0.0.1', () => server.close(() => resolveCheck(true)))
    })
    if (available) return
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  throw new HarnessError('LOOPBACK_PORT_NOT_RELEASED')
}

function resolveLiveInputs(env = process.env) {
  if (env.HEX_CHAT_ATOMIC_INSTALLED_AUTHORIZED !== '1') {
    throw new HarnessError('LIVE_AUTHORIZATION_REQUIRED')
  }
  for (const name of [
    'HEX_CHAT_ATOMIC_APP_BUNDLE',
    'HEX_CHAT_ATOMIC_SOURCE_CONFIG',
    'HEX_CHAT_ATOMIC_EXPECTED_SIDECAR_SHA256',
  ]) {
    if (typeof env[name] !== 'string' || env[name].trim() === '') {
      throw new HarnessError('LIVE_INPUT_REQUIRED')
    }
  }
  const appBundle = resolve(env.HEX_CHAT_ATOMIC_APP_BUNDLE)
  const sourceConfig = resolve(env.HEX_CHAT_ATOMIC_SOURCE_CONFIG)
  const expectedSHA256 = env.HEX_CHAT_ATOMIC_EXPECTED_SIDECAR_SHA256.trim().toLowerCase()
  if (!/^[a-f0-9]{64}$/u.test(expectedSHA256)) {
    throw new HarnessError('EXPECTED_CANDIDATE_DIGEST_INVALID')
  }
  return {
    appBundle,
    candidateBinary: join(appBundle, 'Contents', 'MacOS', 'hexclaw'),
    sourceConfig,
    expectedSHA256,
    sourceRoot: resolve(env.HEX_CHAT_ATOMIC_SOURCE_ROOT || DEFAULT_SOURCE_ROOT),
    goBinary: resolve(env.HEX_CHAT_ATOMIC_GO_BINARY || DEFAULT_GO_BINARY),
    evidenceDirectory: resolve(
      env.HEX_CHAT_ATOMIC_EVIDENCE_DIR || DEFAULT_EVIDENCE_DIRECTORY,
    ),
  }
}

async function attestLiveInputs(paths) {
  if (!basename(paths.appBundle).endsWith('.app')) throw new HarnessError('APP_BUNDLE_INVALID')
  await requireDirectory(paths.appBundle, 'APP_BUNDLE_INVALID')
  const bundleReal = await realpath(paths.appBundle)
  const candidateReal = await realpath(paths.candidateBinary)
  if (!candidateReal.startsWith(`${bundleReal}${sep}`)) {
    throw new HarnessError('CANDIDATE_OUTSIDE_APP_BUNDLE')
  }
  const candidateInfo = await requireRegularFile(paths.candidateBinary, 'CANDIDATE_INVALID', {
    executable: true,
  })
  await requireRegularFile(paths.sourceConfig, 'SOURCE_CONFIG_INVALID', { privateFile: true })
  await requireDirectory(paths.sourceRoot, 'SOURCE_ROOT_INVALID')
  await requireRegularFile(join(paths.sourceRoot, 'go.mod'), 'SOURCE_MODULE_INVALID')
  await requireRegularFile(
    join(paths.sourceRoot, 'cmd', 'k12-live-fixture-testtools', 'main_testtools.go'),
    'PROFILE_HELPER_SOURCE_INVALID',
  )
  await requireRegularFile(paths.goBinary, 'GO_BINARY_INVALID', { executable: true })
  const actualSHA256 = await sha256File(paths.candidateBinary)
  if (actualSHA256 !== paths.expectedSHA256) throw new HarnessError('CANDIDATE_DIGEST_MISMATCH')
  return {
    binary_sha256: actualSHA256,
    binary_bytes: candidateInfo.size,
    expected_digest_match: true,
  }
}

function resolveDefaultProfileInputs(env = process.env) {
  if (env.HEX_CHAT_ATOMIC_DEFAULT_PROFILE_AUTHORIZED !== '1') {
    throw new HarnessError('DEFAULT_PROFILE_AUTHORIZATION_REQUIRED')
  }
  for (const name of [
    'HEX_CHAT_ATOMIC_APP_BUNDLE',
    'HEX_CHAT_ATOMIC_ACTUAL_CONFIG',
    'HEX_CHAT_ATOMIC_EXPECTED_SIDECAR_SHA256',
  ]) {
    if (typeof env[name] !== 'string' || env[name].trim() === '') {
      throw new HarnessError('DEFAULT_PROFILE_INPUT_REQUIRED')
    }
  }
  const appBundle = resolve(env.HEX_CHAT_ATOMIC_APP_BUNDLE)
  if (appBundle !== DEFAULT_APP_BUNDLE) {
    throw new HarnessError('ACTUAL_INSTALLED_APP_REQUIRED')
  }
  const actualConfig = resolve(env.HEX_CHAT_ATOMIC_ACTUAL_CONFIG)
  const canonicalDefaultConfig = resolve(homedir(), '.hexclaw', 'hexclaw.yaml')
  if (actualConfig !== canonicalDefaultConfig) {
    throw new HarnessError('ACTUAL_DEFAULT_CONFIG_REQUIRED')
  }
  const expectedSHA256 = env.HEX_CHAT_ATOMIC_EXPECTED_SIDECAR_SHA256.trim().toLowerCase()
  if (!/^[a-f0-9]{64}$/u.test(expectedSHA256)) {
    throw new HarnessError('EXPECTED_CANDIDATE_DIGEST_INVALID')
  }
  return {
    appBundle,
    candidateBinary: join(appBundle, 'Contents', 'MacOS', 'hexclaw'),
    actualConfig,
    expectedSHA256,
    baseURL: `http://127.0.0.1:${DEFAULT_PROFILE_PORT}`,
    evidenceDirectory: resolve(
      env.HEX_CHAT_ATOMIC_EVIDENCE_DIR || DEFAULT_EVIDENCE_DIRECTORY,
    ),
  }
}

async function attestDefaultProfileInputs(paths) {
  if (!basename(paths.appBundle).endsWith('.app')) throw new HarnessError('APP_BUNDLE_INVALID')
  await requireDirectory(paths.appBundle, 'APP_BUNDLE_INVALID')
  const bundleReal = await realpath(paths.appBundle)
  const candidateReal = await realpath(paths.candidateBinary)
  if (!candidateReal.startsWith(`${bundleReal}${sep}`)) {
    throw new HarnessError('CANDIDATE_OUTSIDE_APP_BUNDLE')
  }
  const candidateInfo = await requireRegularFile(paths.candidateBinary, 'CANDIDATE_INVALID', {
    executable: true,
  })
  await requireRegularFile(paths.actualConfig, 'ACTUAL_CONFIG_INVALID', { privateFile: true })
  const actualSHA256 = await sha256File(paths.candidateBinary)
  if (actualSHA256 !== paths.expectedSHA256) throw new HarnessError('CANDIDATE_DIGEST_MISMATCH')
  return {
    binary_sha256: actualSHA256,
    binary_bytes: candidateInfo.size,
    expected_digest_match: true,
  }
}

function defaultProfileEnvironment(env, capability) {
  return {
    ...env,
    HEXCLAW_SIDECAR_CAPABILITY_TOKEN: capability,
    HEXCLAW_TEST_OBSERVE_CHAT_PHYSICAL_CALLS: '1',
    HEXCLAW_DISABLE_IM: 'all',
    DINGTALK_LIVE_SEND: '0',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  }
}

function startDefaultProfileSidecar(paths, capability, env = process.env) {
  let resolveExit
  const exitPromise = new Promise((resolveValue) => {
    resolveExit = resolveValue
  })
  let terminal = null
  const child = spawn(
    paths.candidateBinary,
    ['serve', '--desktop', '--config', paths.actualConfig],
    {
      cwd: dirname(paths.actualConfig),
      env: defaultProfileEnvironment(env, capability),
      stdio: 'ignore',
      windowsHide: true,
    },
  )
  const settle = (value) => {
    if (terminal) return
    terminal = value
    resolveExit(value)
  }
  child.once('error', () => settle({ code: null, signal: null, spawn_error: true }))
  child.once('close', (code, signal) => settle({ code, signal, spawn_error: false }))
  return {
    child,
    exitPromise,
    get terminal() {
      return terminal
    },
  }
}

async function assertDefaultProfilePortAvailable() {
  const server = createServer()
  server.unref()
  try {
    await new Promise((resolveListen, rejectListen) => {
      server.once('error', rejectListen)
      server.listen(DEFAULT_PROFILE_PORT, '127.0.0.1', resolveListen)
    })
  } catch {
    throw new HarnessError('DEFAULT_PROFILE_PORT_NOT_AVAILABLE')
  }
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()))
  })
}

async function prepareRuntime(paths, ownedRoot, port, deadlineAt, env = process.env) {
  const configDirectory = join(ownedRoot.root, '.hexclaw')
  const binaryDirectory = join(ownedRoot.root, 'bin')
  const temporaryDirectory = join(ownedRoot.root, 'tmp')
  await mkdir(configDirectory, { mode: PRIVATE_DIRECTORY_MODE })
  await mkdir(binaryDirectory, { mode: PRIVATE_DIRECTORY_MODE })
  await mkdir(temporaryDirectory, { mode: PRIVATE_DIRECTORY_MODE })
  const stateFile = join(ownedRoot.root, 'state.bin')
  const policyFile = join(ownedRoot.root, 'candidate-policy.json')
  const helperBinary = join(binaryDirectory, 'k12-live-fixture-testtools')
  const configFile = join(configDirectory, 'hexclaw.yaml')
  await createPrivateFile(stateFile)
  await createPrivateFile(policyFile, `${JSON.stringify(candidatePolicy())}\n`)

  await runCommand(
    paths.goBinary,
    [
      'build',
      '-trimpath',
      '-tags',
      'testtools',
      '-o',
      helperBinary,
      './cmd/k12-live-fixture-testtools',
    ],
    {
      cwd: paths.sourceRoot,
      env: { ...env },
      timeoutMs: remainingBudget(deadlineAt, 8 * 60_000, 'PROFILE_HELPER_BUILD_BUDGET_EXHAUSTED'),
    },
    'PROFILE_HELPER_BUILD_FAILED',
  )
  await requireRegularFile(helperBinary, 'PROFILE_HELPER_BINARY_INVALID', { executable: true })

  const prepared = await runCommand(
    helperBinary,
    [
      'prepare-profile',
      '--source-config',
      paths.sourceConfig,
      '--profile',
      ownedRoot.root,
      '--store',
      stateFile,
      '--candidate-policy',
      policyFile,
      '--port',
      String(port),
    ],
    {
      cwd: paths.sourceRoot,
      env: {
        ...inheritedEnvironment(env),
        TMPDIR: temporaryDirectory,
      },
      timeoutMs: remainingBudget(deadlineAt, 90_000, 'PROFILE_PREPARE_BUDGET_EXHAUSTED'),
    },
    'PROFILE_PREPARE_FAILED',
  )
  let receipt
  try {
    receipt = JSON.parse(prepared.stdout)
  } catch {
    throw new HarnessError('PROFILE_PREPARE_RECEIPT_INVALID')
  }
  if (receipt?.status !== 'prepared' || !/^[a-f0-9]{64}$/u.test(receipt.config_sha256 ?? '')) {
    throw new HarnessError('PROFILE_PREPARE_RECEIPT_INVALID')
  }
  await requireRegularFile(configFile, 'PREPARED_CONFIG_INVALID', { privateFile: true })
  return {
    root: ownedRoot.root,
    temporaryDirectory,
    configFile,
    config_sha256: receipt.config_sha256,
  }
}

function sidecarEnvironment(runtime, capability, env = process.env) {
  return {
    ...inheritedEnvironment(env),
    TMPDIR: runtime.temporaryDirectory,
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
    HEXCLAW_SIDECAR_CAPABILITY_TOKEN: capability,
    HEXCLAW_TEST_OBSERVE_CHAT_PHYSICAL_CALLS: '1',
    DINGTALK_LIVE_SEND: '0',
  }
}

function startSidecar(candidateBinary, runtime, capability, env = process.env) {
  let resolveExit
  const exitPromise = new Promise((resolveValue) => {
    resolveExit = resolveValue
  })
  let terminal = null
  const child = spawn(candidateBinary, ['serve', '--desktop', '--config', runtime.configFile], {
    cwd: runtime.root,
    env: sidecarEnvironment(runtime, capability, env),
    stdio: 'ignore',
    windowsHide: true,
  })
  const settle = (value) => {
    if (terminal) return
    terminal = value
    resolveExit(value)
  }
  child.once('error', () => settle({ code: null, signal: null, spawn_error: true }))
  child.once('close', (code, signal) => settle({ code, signal, spawn_error: false }))
  return {
    child,
    exitPromise,
    get terminal() {
      return terminal
    },
  }
}

async function stopSidecar(sidecar) {
  if (!sidecar) return
  if (sidecar.child.exitCode === null && sidecar.child.signalCode === null) {
    sidecar.child.kill('SIGTERM')
  }
  let exit = await Promise.race([
    sidecar.exitPromise,
    new Promise((resolveWait) => setTimeout(() => resolveWait(null), 10_000)),
  ])
  if (!exit) {
    sidecar.child.kill('SIGKILL')
    exit = await sidecar.exitPromise
  }
  if (exit?.spawn_error) throw new HarnessError('SIDECAR_SPAWN_FAILED')
}

async function requestJSON(baseURL, apiPath, options = {}) {
  if (
    !/^http:\/\/127\.0\.0\.1:\d+$/u.test(baseURL) ||
    typeof apiPath !== 'string' ||
    !apiPath.startsWith('/') ||
    apiPath.includes('..')
  ) {
    throw new HarnessError('LOOPBACK_REQUEST_INVALID')
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000)
  let response
  let raw = ''
  try {
    const headers = { Accept: 'application/json' }
    if (options.capability) headers.Authorization = `Bearer ${options.capability}`
    if (options.payload !== undefined) headers['Content-Type'] = 'application/json'
    response = await fetch(`${baseURL}${apiPath}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.payload === undefined ? undefined : JSON.stringify(options.payload),
      redirect: 'error',
      signal: controller.signal,
    })
    raw = await response.text()
  } catch {
    throw new HarnessError(options.failureCode ?? 'LOOPBACK_REQUEST_FAILED')
  } finally {
    clearTimeout(timer)
  }
  if (response.status !== options.expectedStatus) {
    const error = new HarnessError(options.failureCode ?? 'LOOPBACK_STATUS_INVALID')
    error.diagnosticSHA256 = sha256Text(raw)
    throw error
  }
  if (options.parse === false) return { status: response.status }
  try {
    return { status: response.status, value: JSON.parse(raw) }
  } catch {
    const error = new HarnessError(options.failureCode ?? 'LOOPBACK_JSON_INVALID')
    error.diagnosticSHA256 = sha256Text(raw)
    throw error
  }
}

async function waitForSidecar(baseURL, sidecar, deadlineAt) {
  const deadline = Math.min(deadlineAt, Date.now() + SIDECAR_START_TIMEOUT_MS)
  while (Date.now() < deadline) {
    if (sidecar.terminal || sidecar.child.exitCode !== null || sidecar.child.signalCode !== null) {
      throw new HarnessError('SIDECAR_EXITED_BEFORE_READY')
    }
    try {
      await requestJSON(baseURL, '/api/v1/version', {
        expectedStatus: 200,
        timeoutMs: 2_000,
        failureCode: 'SIDECAR_NOT_READY',
      })
      return
    } catch (error) {
      if (safeFailureCode(error) !== 'SIDECAR_NOT_READY') throw error
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150))
  }
  throw new HarnessError('SIDECAR_START_TIMEOUT')
}

function projectReasoningContract(provider) {
  const specs = Array.isArray(provider?.model_specs) ? provider.model_specs : []
  const matches = specs.filter((spec) => spec?.id === EXPECTED_MODEL)
  if (matches.length !== 1) throw new HarnessError('REASONING_MODEL_SPEC_NOT_EXACT')
  const spec = matches[0]
  const control = spec?.reasoning_control
  if (
    spec?.reasoning_support !== 'supported' ||
    control?.dialect !== 'reasoning_effort' ||
    control?.on !== 'low' ||
    control?.off !== 'none' ||
    !Array.isArray(control?.allowed_efforts) ||
    control.allowed_efforts.length !== 1 ||
    control.allowed_efforts[0] !== 'low'
  ) {
    throw new HarnessError('REASONING_LOW_NOT_DECLARED')
  }
  return {
    support: 'supported',
    dialect: 'reasoning_effort',
    low_available: true,
  }
}

function assertExactProviderConfig(config) {
  const providers = config?.providers
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) {
    throw new HarnessError('PROVIDER_CONFIG_INVALID')
  }
  const names = Object.keys(providers)
  if (names.length !== 1 || names[0] !== EXPECTED_PROVIDER) {
    throw new HarnessError('PROVIDER_SET_NOT_EXACT')
  }
  const provider = providers[EXPECTED_PROVIDER]
  if (
    config.default !== EXPECTED_PROVIDER ||
    config.reasoning_provider !== EXPECTED_PROVIDER ||
    config.reasoning_model !== EXPECTED_MODEL ||
    provider?.model !== EXPECTED_MODEL ||
    provider?.credential_present !== true ||
    provider?.enabled === false ||
    provider?.model_specs_mode !== 'explicit' ||
    !Array.isArray(provider?.models) ||
    provider.models.length !== 1 ||
    provider.models[0] !== EXPECTED_MODEL
  ) {
    throw new HarnessError('PROVIDER_ROUTE_NOT_EXACT')
  }
  return {
    provider: EXPECTED_PROVIDER,
    model: EXPECTED_MODEL,
    fallback_provider_count: 0,
    reasoning: projectReasoningContract(provider),
  }
}

export function assertDefaultProfileRoute(config) {
  const providers = config?.providers
  const provider = providers?.[EXPECTED_PROVIDER]
  const modelSpecs = Array.isArray(provider?.model_specs) ? provider.model_specs : []
  const expectedSpecs = modelSpecs.filter((spec) => spec?.id === EXPECTED_MODEL)
  if (
    !providers ||
    typeof providers !== 'object' ||
    Array.isArray(providers) ||
    provider?.credential_present !== true ||
    provider?.enabled === false ||
    !Array.isArray(provider?.models) ||
    !provider.models.includes(EXPECTED_MODEL) ||
    expectedSpecs.length !== 1 ||
    !Array.isArray(expectedSpecs[0]?.capabilities) ||
    !expectedSpecs[0].capabilities.includes('text')
  ) {
    throw new HarnessError('DEFAULT_PROFILE_ROUTE_NOT_EXACT')
  }
  return {
    provider: EXPECTED_PROVIDER,
    model: EXPECTED_MODEL,
    explicitly_pinned: true,
    default_route_matches: config.default === EXPECTED_PROVIDER,
    provider_default_model_matches: provider.model === EXPECTED_MODEL,
    text_capability: true,
    reasoning: projectReasoningContract(provider),
  }
}

function decodeMetadataField(raw) {
  if (raw === undefined || raw === null || raw === '') return {}
  if (typeof raw === 'object' && !Array.isArray(raw)) return { ...raw }
  if (typeof raw !== 'string') throw new HarnessError('MESSAGE_METADATA_INVALID')
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid')
    return parsed
  } catch {
    throw new HarnessError('MESSAGE_METADATA_INVALID')
  }
}

function decodeReasoningReceipt(raw) {
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw)
    } catch {
      throw new HarnessError('REASONING_RECEIPT_INVALID')
    }
  }
  if (
    raw?.version !== 1 ||
    raw?.reasoning_request !== 'on' ||
    raw?.reasoning_support !== 'supported' ||
    raw?.reasoning_execution !== 'applied'
  ) {
    throw new HarnessError('REASONING_RECEIPT_NOT_APPLIED')
  }
  return {
    version: 1,
    request: 'on',
    support: 'supported',
    execution: 'applied',
  }
}

function markerEvidence(text, marker) {
  const occurrences = typeof text === 'string' ? text.split(marker).length - 1 : 0
  if (occurrences !== 1) throw new HarnessError('MARKER_NOT_PRESERVED_EXACTLY_ONCE')
  return {
    sha256: sha256Text(marker),
    bytes: Buffer.byteLength(marker),
    occurrences,
  }
}

function buildChatRequest(requestID, marker) {
  const left = randomInt(21, 90)
  const right = randomInt(12, 70)
  return {
    message: `孩子正在复习五年级数学。请先估算，再列竖式讲解 ${left} × ${right}，最后用另一种方法验算。请在回答最后单独一行原样输出且只输出一次校验标记：${marker}`,
    provider: EXPECTED_PROVIDER,
    model: EXPECTED_MODEL,
    platform: 'desktop',
    request_id: requestID,
    max_tokens: 700,
    metadata: {
      producer_kind: 'chat',
      thinking: 'on',
      thinking_effort: 'low',
      tools_enabled: 'off',
      memory: 'off',
      user_locale: 'zh-CN',
      locale: 'zh-CN',
    },
  }
}

function assertChatSubmissionCount(expected) {
  assert.equal(chatSubmissionCount, expected)
}

async function submitChat(baseURL, capability, payload, deadlineAt) {
  if (chatSubmissionCount >= MAX_CHAT_SUBMISSIONS) {
    throw new HarnessError('CHAT_SUBMISSION_LIMIT_EXCEEDED')
  }
  chatSubmissionCount += 1
  return await requestJSON(baseURL, '/api/v1/chat', {
    method: 'POST',
    capability,
    payload,
    expectedStatus: 200,
    timeoutMs: remainingBudget(deadlineAt, CHAT_TIMEOUT_MS, 'CHAT_BUDGET_EXHAUSTED'),
    failureCode: 'CHAT_REQUEST_FAILED',
  })
}

function projectChatResponse(response, requestID, marker) {
  const metadata = decodeMetadataField(response?.metadata)
  const ids = [response?.assistant_message_id, response?.backend_message_id, response?.message_id]
  const toolCalls = Array.isArray(response?.tool_calls) ? response.tool_calls : []
  if (
    typeof response?.reply !== 'string' ||
    response.reply.trim() === '' ||
    typeof response?.session_id !== 'string' ||
    response.session_id.trim() === '' ||
    ids.some((value) => typeof value !== 'string' || value.trim() === '') ||
    new Set(ids).size !== 1 ||
    metadata.provider !== EXPECTED_PROVIDER ||
    metadata.model !== EXPECTED_MODEL ||
    metadata.request_id !== requestID ||
    metadata.persist_error !== undefined ||
    metadata.assistant_message_id !== ids[0] ||
    metadata.backend_message_id !== ids[0] ||
    metadata.message_id !== ids[0] ||
    response?.usage?.provider !== EXPECTED_PROVIDER ||
    response?.usage?.model !== EXPECTED_MODEL ||
    !Number.isInteger(response?.usage?.total_tokens) ||
    response.usage.total_tokens <= 0 ||
    toolCalls.length !== 0
  ) {
    throw new HarnessError('CHAT_RESPONSE_INVARIANT_FAILED')
  }
  return {
    response_sha256: sha256Text(response.reply),
    response_bytes: Buffer.byteLength(response.reply),
    session_id_sha256: sha256Text(response.session_id),
    assistant_id_sha256: sha256Text(ids[0]),
    request_id_sha256: sha256Text(requestID),
    provider: EXPECTED_PROVIDER,
    model: EXPECTED_MODEL,
    usage_provider_model_exact: true,
    usage_total_tokens_positive: true,
    tool_call_count: 0,
    marker: markerEvidence(
      response.reply,
      marker,
    ),
  }
}

function projectHistory(messages, response, userInput, requestID, marker) {
  if (!Array.isArray(messages)) throw new HarnessError('HISTORY_INVALID')
  const users = messages.filter((item) => item?.role === 'user')
  const assistants = messages.filter((item) => item?.role === 'assistant')
  if (users.length !== 1 || assistants.length !== 1 || messages.length !== 2) {
    throw new HarnessError('HISTORY_CARDINALITY_INVALID')
  }
  const user = users[0]
  const assistant = assistants[0]
  const metadata = {
    ...decodeMetadataField(assistant?.metadata),
    ...decodeMetadataField(assistant?.meta),
  }
  const assistantID = response.assistant_message_id
  if (
    user?.id !== requestID ||
    user?.request_id !== requestID ||
    user?.session_id !== response.session_id ||
    user?.content !== userInput ||
    assistant?.id !== assistantID ||
    assistant?.request_id !== requestID ||
    assistant?.session_id !== response.session_id ||
    assistant?.content !== response.reply ||
    metadata.provider !== EXPECTED_PROVIDER ||
    metadata.model !== EXPECTED_MODEL ||
    metadata.persist_error !== undefined ||
    metadata.assistant_message_id !== assistantID ||
    metadata.backend_message_id !== assistantID ||
    metadata.message_id !== assistantID
  ) {
    throw new HarnessError('HISTORY_ASSISTANT_INVARIANT_FAILED')
  }
  return {
    message_count: 2,
    user_count: 1,
    assistant_count: 1,
    user_input_sha256: sha256Text(userInput),
    user_input_bytes: Buffer.byteLength(userInput),
    response_sha256: sha256Text(assistant.content),
    response_bytes: Buffer.byteLength(assistant.content),
    assistant_id_sha256: sha256Text(assistantID),
    request_id_sha256: sha256Text(requestID),
    session_id_sha256: sha256Text(response.session_id),
    response_content_match: true,
    provider: EXPECTED_PROVIDER,
    model: EXPECTED_MODEL,
    persist_error_absent: true,
    reasoning: decodeReasoningReceipt(metadata.reasoning_receipt),
    marker: markerEvidence(assistant.content, marker),
  }
}

function assertOwnedTestSession(history, response, userInput, requestID, marker) {
  if (history?.total !== 2 || !Array.isArray(history?.messages)) {
    throw new HarnessError('SESSION_CLEANUP_OWNERSHIP_INVALID')
  }
  try {
    return projectHistory(history.messages, response, userInput, requestID, marker)
  } catch {
    throw new HarnessError('SESSION_CLEANUP_OWNERSHIP_INVALID')
  }
}

async function readHistory(baseURL, capability, sessionID) {
  const result = await requestJSON(
    baseURL,
    `/api/v1/sessions/${encodeURIComponent(sessionID)}/messages?limit=50&offset=0`,
    {
      capability,
      expectedStatus: 200,
      failureCode: 'HISTORY_REQUEST_FAILED',
    },
  )
  if (!Array.isArray(result.value?.messages) || result.value?.total !== 2) {
    throw new HarnessError('HISTORY_RESPONSE_INVALID')
  }
  return result.value
}

async function pollHistory(baseURL, capability, response, userInput, requestID, marker) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const history = await readHistory(baseURL, capability, response.session_id)
    try {
      return {
        raw: history,
        projection: projectHistory(history.messages, response, userInput, requestID, marker),
      }
    } catch (error) {
      if (
        !(error instanceof HarnessError) ||
        !['HISTORY_CARDINALITY_INVALID', 'HISTORY_ASSISTANT_INVARIANT_FAILED'].includes(error.code)
      ) {
        throw error
      }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150))
  }
  throw new HarnessError('HISTORY_TERMINAL_TIMEOUT')
}

async function cleanupOwnedTestSession(
  baseURL,
  capability,
  response,
  userInput,
  requestID,
  marker,
) {
  let ownership
  try {
    const before = await readHistory(baseURL, capability, response.session_id)
    ownership = assertOwnedTestSession(before, response, userInput, requestID, marker)
  } catch (error) {
    return {
      cleanup_status: 'retained',
      reason_code: safeFailureCode(error, 'SESSION_CLEANUP_OWNERSHIP_INVALID'),
      session_id_sha256: sha256Text(response.session_id),
      request_id_sha256: sha256Text(requestID),
    }
  }

  try {
    await requestJSON(
      baseURL,
      `/api/v1/sessions/${encodeURIComponent(response.session_id)}`,
      {
        method: 'DELETE',
        capability,
        expectedStatus: 200,
        parse: false,
        failureCode: 'SESSION_DELETE_FAILED',
      },
    )
  } catch (error) {
    return {
      cleanup_status: 'retained',
      reason_code: safeFailureCode(error, 'SESSION_DELETE_FAILED'),
      session_id_sha256: ownership.session_id_sha256,
      request_id_sha256: ownership.request_id_sha256,
    }
  }

  await requestJSON(
    baseURL,
    `/api/v1/sessions/${encodeURIComponent(response.session_id)}/messages?limit=50&offset=0`,
    {
      capability,
      expectedStatus: 404,
      parse: false,
      failureCode: 'SESSION_DELETE_NOT_OBSERVED',
    },
  )
  return {
    cleanup_status: 'deleted',
    ownership_verified: true,
    deletion_verified: true,
    session_id_sha256: ownership.session_id_sha256,
    request_id_sha256: ownership.request_id_sha256,
  }
}

async function queryLogs(baseURL, capability, keyword) {
  const result = await requestJSON(
    baseURL,
    `/api/v1/logs?keyword=${encodeURIComponent(keyword)}&limit=100&offset=0`,
    {
      capability,
      expectedStatus: 200,
      failureCode: 'LOG_QUERY_FAILED',
    },
  )
  if (!Array.isArray(result.value?.logs)) throw new HarnessError('LOG_QUERY_RESPONSE_INVALID')
  return result.value.logs
}

export function projectRemoteChatWarmupState(skipReceiptCount, localStartCount) {
  if (
    !Number.isInteger(skipReceiptCount) ||
    skipReceiptCount < 0 ||
    !Number.isInteger(localStartCount) ||
    localStartCount < 0
  ) {
    throw new HarnessError('WARMUP_LOG_COUNT_INVALID')
  }
  if (localStartCount > 0) throw new HarnessError('LOCAL_CHAT_WARMUP_STARTED')
  if (skipReceiptCount > 0) {
    return {
      status: 'skipped_non_local',
      skip_receipt_count: skipReceiptCount,
      local_warmup_start_count: 0,
      provider_call_observed: false,
      skip_receipt_pending: false,
    }
  }
  return {
    status: 'not_started_or_deferred',
    skip_receipt_count: 0,
    local_warmup_start_count: 0,
    provider_call_observed: false,
    skip_receipt_pending: true,
  }
}

async function observeRemoteChatWarmup(baseURL, capability) {
  const skippedMessage = '[warmup] 默认路由非本地模型，跳过预热'
  const startedMessage = '[warmup] 本地默认模型预热开始'
  const started = await queryLogs(baseURL, capability, startedMessage)
  const startedCount = started.filter((entry) =>
    String(entry?.message ?? '').startsWith(startedMessage),
  ).length
  if (startedCount > 0) return projectRemoteChatWarmupState(0, startedCount)
  const skipped = await queryLogs(baseURL, capability, skippedMessage)
  const skippedCount = skipped.filter((entry) => entry?.message === skippedMessage).length
  return projectRemoteChatWarmupState(skippedCount, 0)
}

export function projectDingTalkIMDisabled(logReceiptCount, projection) {
  if (!Number.isInteger(logReceiptCount) || logReceiptCount < 0) {
    throw new HarnessError('IM_DISABLE_LOG_COUNT_INVALID')
  }
  if (
    !projection ||
    !Array.isArray(projection.instances) ||
    !Number.isInteger(projection.total) ||
    projection.total !== projection.instances.length
  ) {
    throw new HarnessError('IM_INSTANCE_PROJECTION_INVALID')
  }

  let dingTalkInstanceCount = 0
  let dingTalkRunningCount = 0
  for (const instance of projection.instances) {
    if (!instance || typeof instance !== 'object') {
      throw new HarnessError('IM_INSTANCE_PROJECTION_INVALID')
    }
    const provider = String(instance.provider ?? '').trim().toLowerCase()
    if (provider === '') throw new HarnessError('IM_INSTANCE_PROJECTION_INVALID')
    if (provider !== 'dingtalk') continue
    const status = String(instance.status ?? '').trim().toLowerCase()
    if (!['stopped', 'running', 'error'].includes(status)) {
      throw new HarnessError('IM_INSTANCE_PROJECTION_INVALID')
    }
    dingTalkInstanceCount += 1
    if (status === 'running') dingTalkRunningCount += 1
  }
  if (dingTalkRunningCount > 0) throw new HarnessError('DINGTALK_INSTANCE_RUNNING')

  return {
    disabled_all: true,
    proof_source:
      logReceiptCount > 0
        ? 'public_log_and_instance_projection'
        : 'public_instance_projection',
    public_log_receipt_count: logReceiptCount,
    projected_instance_count: projection.instances.length,
    dingtalk_instance_count: dingTalkInstanceCount,
    dingtalk_running_count: 0,
  }
}

async function observeIMStartupDisabled(baseURL, capability) {
  const message = '[instances] IM provider startup disabled by HEXCLAW_DISABLE_IM'
  const logs = await queryLogs(baseURL, capability, message)
  const logReceiptCount = logs.filter((entry) => entry?.message === message).length
  const projection = await requestJSON(baseURL, '/api/v1/platforms/instances', {
    capability,
    expectedStatus: 200,
    failureCode: 'IM_INSTANCE_PROJECTION_FAILED',
  })
  return projectDingTalkIMDisabled(logReceiptCount, projection.value)
}

function valueContainsOwnedIdentifier(value, identifiers) {
  if (typeof value === 'string') {
    return identifiers.some((identifier) => value.includes(identifier))
  }
  if (Array.isArray(value)) {
    return value.some((item) => valueContainsOwnedIdentifier(item, identifiers))
  }
  if (value && typeof value === 'object') {
    return Object.values(value).some((item) => valueContainsOwnedIdentifier(item, identifiers))
  }
  return false
}

export function projectOwnedAutomationIsolation(projection, ownership) {
  if (!projection || !Array.isArray(projection.jobs)) {
    throw new HarnessError('AUTOMATION_PROJECTION_INVALID')
  }
  if (!ownership || typeof ownership !== 'object') {
    throw new HarnessError('AUTOMATION_OWNERSHIP_INVALID')
  }
  const identifiers = [ownership.session_id, ownership.request_id, ownership.marker].map((value) =>
    typeof value === 'string' ? value.trim() : '',
  )
  if (identifiers.some((value) => value === '') || new Set(identifiers).size !== identifiers.length) {
    throw new HarnessError('AUTOMATION_OWNERSHIP_INVALID')
  }
  const ownedMatches = projection.jobs.filter((job) =>
    valueContainsOwnedIdentifier(job, identifiers),
  )
  if (ownedMatches.length > 0) throw new HarnessError('OWNED_AUTOMATION_PRESENT')

  return {
    listed_job_count: projection.jobs.length,
    active_unrelated_count: projection.jobs.filter((job) => job?.status === 'active').length,
    paused_unrelated_count: projection.jobs.filter((job) => job?.status === 'paused').length,
    owned_match_count: 0,
    scope: 'owned_session_request_marker_only',
  }
}

async function assertNoOwnedAutomation(baseURL, capability, ownership) {
  const result = await requestJSON(baseURL, '/api/v1/cronjob', {
    method: 'POST',
    capability,
    payload: { action: 'list', include_paused: true },
    expectedStatus: 200,
    failureCode: 'AUTOMATION_PREFLIGHT_FAILED',
  })
  return projectOwnedAutomationIsolation(result.value, ownership)
}

function physicalReceipts(logs, requestID) {
  const requestIDDigest = sha256Text(requestID)
  const message = '显式用户请求物理模型调用计数'
  return logs
    .filter(
      (entry) =>
        entry?.message === message &&
        entry?.fields?.request_id_sha256 === requestIDDigest &&
        Number.isInteger(entry?.fields?.physical_provider_calls),
    )
    .map((entry) => entry.fields.physical_provider_calls)
}

async function pollPhysicalProviderReceipt(baseURL, capability, requestID) {
  const message = '显式用户请求物理模型调用计数'
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const counts = physicalReceipts(await queryLogs(baseURL, capability, message), requestID)
    if (counts.length > 1) throw new HarnessError('PHYSICAL_PROVIDER_RECEIPT_DUPLICATED')
    if (counts.length === 1) {
      if (counts[0] !== 1) throw new HarnessError('PHYSICAL_PROVIDER_CALL_COUNT_INVALID')
      return { receipt_count: 1, physical_provider_calls: 1 }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  throw new HarnessError('PHYSICAL_PROVIDER_RECEIPT_UNOBSERVED')
}

async function assertNoPhysicalReceipt(baseURL, capability, requestID) {
  const message = '显式用户请求物理模型调用计数'
  const counts = physicalReceipts(await queryLogs(baseURL, capability, message), requestID)
  if (counts.length !== 0) throw new HarnessError('RESTART_PHYSICAL_PROVIDER_RECEIPT_PRESENT')
  return { receipt_count: 0, physical_provider_calls: 0 }
}

function projectNoFallbackProof(route, response, physicalCall) {
  if (
    route?.provider !== EXPECTED_PROVIDER ||
    route?.model !== EXPECTED_MODEL ||
    route?.explicitly_pinned !== true ||
    response?.provider !== EXPECTED_PROVIDER ||
    response?.model !== EXPECTED_MODEL ||
    physicalCall?.receipt_count !== 1 ||
    physicalCall?.physical_provider_calls !== 1
  ) {
    throw new HarnessError('EXPLICIT_ROUTE_EXECUTION_PROOF_INVALID')
  }
  // 生产引擎对显式 provider/model 禁止跨 provider fallback；最终路由仍精确且
  // 公开 observer 只记录一次物理发送，因此本次请求不存在 fallback 发送。
  return {
    basis: 'explicit_route_response_and_physical_call_receipt',
    explicit_route_pinned: true,
    final_route_exact: true,
    physical_provider_calls: 1,
    fallback_provider_calls: 0,
  }
}

function newEvidence(candidate) {
  return {
    schema_version: 1,
    status: 'running',
    observed_at: new Date().toISOString(),
    acceptance_id: 'CHAT-ASSISTANT-PERSISTENCE-ATOMIC-001',
    candidate,
    route: {
      provider: EXPECTED_PROVIDER,
      model: EXPECTED_MODEL,
      tools_enabled: false,
      reasoning_requested: true,
      reasoning_effort: 'low',
      fallback_allowed: false,
    },
    isolation: {
      installed_sidecar: true,
      headless: true,
      isolated_home: true,
      public_api_only: true,
      direct_store_observation: false,
      im_enabled: false,
      im_called: false,
    },
    execution: {
      chat_submission_limit: MAX_CHAT_SUBMISSIONS,
      chat_submissions: 0,
      physical_provider_call_count_observable: false,
    },
  }
}

async function writeEvidence(evidenceDirectory, evidence) {
  assertEvidenceSafe(evidence)
  await mkdir(evidenceDirectory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
  const filename = `chat-assistant-persistence-${Date.now()}-${randomBytes(4).toString('hex')}.json`
  await createPrivateFile(join(evidenceDirectory, filename), `${JSON.stringify(evidence, null, 2)}\n`)
  return filename
}

function failureEvidence(error) {
  const failure = { code: safeFailureCode(error) }
  if (/^[a-f0-9]{64}$/u.test(error?.diagnosticSHA256 ?? '')) {
    failure.diagnostic_sha256 = error.diagnosticSHA256
  }
  return failure
}

function newDefaultProfileEvidence(candidate) {
  const evidence = newEvidence(candidate)
  evidence.isolation = {
    installed_sidecar: true,
    headless: true,
    default_profile: true,
    home_modified: false,
    config_copied: false,
    public_api_only: true,
    direct_store_observation: false,
    im_enabled: false,
    im_called: false,
  }
  evidence.execution.physical_provider_call_scope = 'explicit_user_request'
  return evidence
}

async function runDefaultProfile(env = process.env) {
  chatSubmissionCount = 0
  const deadlineAt = Date.now() + LIVE_BUDGET_MS
  const paths = resolveDefaultProfileInputs(env)
  const candidate = await attestDefaultProfileInputs(paths)
  const evidence = newDefaultProfileEvidence(candidate)
  let activeSidecar
  let activeCapability
  let testSession
  let submittedRequest
  let cleanupRecorded = false
  let failure

  try {
    await assertDefaultProfilePortAvailable()
    const capabilityBefore = randomBytes(32).toString('hex')
    activeCapability = capabilityBefore
    activeSidecar = startDefaultProfileSidecar(paths, capabilityBefore, env)
    await waitForSidecar(paths.baseURL, activeSidecar, deadlineAt)
    await requestJSON(paths.baseURL, '/api/v1/config/llm', {
      expectedStatus: 401,
      parse: false,
      failureCode: 'ANONYMOUS_AUTH_BOUNDARY_FAILED',
    })
    const firstConfig = await requestJSON(paths.baseURL, '/api/v1/config/llm', {
      capability: capabilityBefore,
      expectedStatus: 200,
      failureCode: 'CONFIG_PROJECTION_FAILED',
    })
    evidence.route_projection = assertDefaultProfileRoute(firstConfig.value)
    evidence.first_startup = {
      warmup: await observeRemoteChatWarmup(paths.baseURL, capabilityBefore),
      im: await observeIMStartupDisabled(paths.baseURL, capabilityBefore),
    }

    const requestID = `req-${randomUUID()}`
    const marker = `HEXCLAW-ATOMIC-${randomUUID()}`
    const chatPayload = buildChatRequest(requestID, marker)
    evidence.user_input = {
      sha256: sha256Text(chatPayload.message),
      bytes: Buffer.byteLength(chatPayload.message),
      marker_sha256: sha256Text(marker),
    }
    submittedRequest = {
      userInput: chatPayload.message,
      requestID,
      marker,
    }
    const chat = await submitChat(paths.baseURL, capabilityBefore, chatPayload, deadlineAt)
    assertChatSubmissionCount(1)
    evidence.execution.chat_submissions = 1
    if (typeof chat.value?.session_id === 'string' && chat.value.session_id.trim() !== '') {
      testSession = {
        response: chat.value,
        ...submittedRequest,
      }
    }
    evidence.response = projectChatResponse(chat.value, requestID, marker)
    evidence.test_session = {
      session_id_sha256: sha256Text(chat.value.session_id),
      request_id_sha256: sha256Text(requestID),
    }
    evidence.physical_call = await pollPhysicalProviderReceipt(
      paths.baseURL,
      capabilityBefore,
      requestID,
    )
    evidence.route_execution = projectNoFallbackProof(
      evidence.route_projection,
      evidence.response,
      evidence.physical_call,
    )
    evidence.execution.physical_provider_call_count_observable = true
    evidence.execution.explicit_user_physical_provider_calls = 1

    const historyBefore = await pollHistory(
      paths.baseURL,
      capabilityBefore,
      chat.value,
      chatPayload.message,
      requestID,
      marker,
    )
    evidence.history_before_restart = historyBefore.projection
    evidence.first_startup.automation = await assertNoOwnedAutomation(
      paths.baseURL,
      capabilityBefore,
      {
        session_id: chat.value.session_id,
        request_id: requestID,
        marker,
      },
    )
    evidence.first_startup.warmup_after_request = await observeRemoteChatWarmup(
      paths.baseURL,
      capabilityBefore,
    )

    await stopSidecar(activeSidecar)
    activeSidecar = null
    activeCapability = null
    await waitForPortReleased(DEFAULT_PROFILE_PORT)

    const capabilityAfter = randomBytes(32).toString('hex')
    if (capabilityAfter === capabilityBefore) throw new HarnessError('CAPABILITY_ROTATION_FAILED')
    activeCapability = capabilityAfter
    activeSidecar = startDefaultProfileSidecar(paths, capabilityAfter, env)
    await waitForSidecar(paths.baseURL, activeSidecar, deadlineAt)
    await requestJSON(paths.baseURL, '/api/v1/config/llm', {
      capability: capabilityBefore,
      expectedStatus: 401,
      parse: false,
      failureCode: 'OLD_CAPABILITY_NOT_REJECTED',
    })
    const secondConfig = await requestJSON(paths.baseURL, '/api/v1/config/llm', {
      capability: capabilityAfter,
      expectedStatus: 200,
      failureCode: 'RESTART_CONFIG_PROJECTION_FAILED',
    })
    assert.deepEqual(assertDefaultProfileRoute(secondConfig.value), evidence.route_projection)
    evidence.second_startup = {
      warmup: await observeRemoteChatWarmup(paths.baseURL, capabilityAfter),
      im: await observeIMStartupDisabled(paths.baseURL, capabilityAfter),
    }

    const submissionsAtRestart = chatSubmissionCount
    const historyAfterRaw = await readHistory(paths.baseURL, capabilityAfter, chat.value.session_id)
    assert.deepEqual(historyAfterRaw, historyBefore.raw)
    const historyAfterProjection = assertOwnedTestSession(
      historyAfterRaw,
      chat.value,
      chatPayload.message,
      requestID,
      marker,
    )
    assert.deepEqual(historyAfterProjection, historyBefore.projection)
    evidence.history_after_restart = historyAfterProjection
    evidence.restart_physical_call = await assertNoPhysicalReceipt(
      paths.baseURL,
      capabilityAfter,
      requestID,
    )
    evidence.second_startup.automation = await assertNoOwnedAutomation(
      paths.baseURL,
      capabilityAfter,
      {
        session_id: chat.value.session_id,
        request_id: requestID,
        marker,
      },
    )
    const chatSubmissionsAfterRestart = chatSubmissionCount - submissionsAtRestart
    if (chatSubmissionsAfterRestart !== 0) {
      throw new HarnessError('RESTART_CHAT_SUBMISSION_OBSERVED')
    }
    evidence.restart = {
      capability_rotated: true,
      old_capability_rejected: true,
      history_exact_deep_equal: true,
      history_projection_equal: true,
      chat_submissions_after_restart: 0,
    }
    evidence.second_startup.warmup_after_history = await observeRemoteChatWarmup(
      paths.baseURL,
      capabilityAfter,
    )
    assertChatSubmissionCount(1)
    evidence.execution.explicit_user_physical_provider_calls_after_restart = 0

    evidence.session_cleanup = await cleanupOwnedTestSession(
      paths.baseURL,
      capabilityAfter,
      chat.value,
      chatPayload.message,
      requestID,
      marker,
    )
    cleanupRecorded = true
    evidence.status = 'passed'
  } catch (error) {
    failure = error
    evidence.status = 'failed'
    evidence.failure = failureEvidence(error)
    evidence.execution.chat_submissions = chatSubmissionCount
  } finally {
    if (testSession && activeSidecar && activeCapability && !cleanupRecorded) {
      try {
        evidence.session_cleanup = await cleanupOwnedTestSession(
          paths.baseURL,
          activeCapability,
          testSession.response,
          testSession.userInput,
          testSession.requestID,
          testSession.marker,
        )
        cleanupRecorded = true
      } catch (error) {
        evidence.session_cleanup = {
          cleanup_status: 'retained',
          reason_code: safeFailureCode(error, 'SESSION_CLEANUP_FAILED'),
          session_id_sha256: sha256Text(testSession.response.session_id),
          request_id_sha256: sha256Text(testSession.requestID),
        }
      }
    }
    if (testSession && !cleanupRecorded && !evidence.session_cleanup) {
      evidence.session_cleanup = {
        cleanup_status: 'retained',
        reason_code: 'SIDECAR_UNAVAILABLE_FOR_SAFE_DELETE',
        session_id_sha256: sha256Text(testSession.response.session_id),
        request_id_sha256: sha256Text(testSession.requestID),
      }
    }
    if (submittedRequest && !testSession && !evidence.session_cleanup) {
      evidence.session_cleanup = {
        cleanup_status: 'retained',
        reason_code: 'CHAT_OUTCOME_UNKNOWN_NO_SAFE_PUBLIC_SESSION_LOOKUP',
        request_id_sha256: sha256Text(submittedRequest.requestID),
      }
    }
    if (activeSidecar) {
      try {
        await stopSidecar(activeSidecar)
        await waitForPortReleased(DEFAULT_PROFILE_PORT)
      } catch (error) {
        evidence.stop_failure = failureEvidence(error)
        failure ??= error
        evidence.status = 'failed'
      }
    }
    evidence.completed_at = new Date().toISOString()
    evidence.elapsed_ms = Date.now() - Date.parse(evidence.observed_at)
  }

  const evidenceFile = await writeEvidence(paths.evidenceDirectory, evidence)
  if (failure) {
    failure.evidenceFile = evidenceFile
    throw failure
  }
  const receipt = {
    status: 'passed',
    mode: 'default-profile-live',
    acceptance_id: evidence.acceptance_id,
    candidate_sha256: candidate.binary_sha256,
    evidence_file: evidenceFile,
    provider: EXPECTED_PROVIDER,
    model: EXPECTED_MODEL,
    chat_submissions: 1,
    explicit_user_physical_provider_calls: 1,
    restart_chat_submissions: 0,
    session_cleanup_status: evidence.session_cleanup.cleanup_status,
    im_called: false,
  }
  assertEvidenceSafe(receipt)
  return receipt
}

async function runLive(env = process.env) {
  // 当前安装候选只公开 --config；desktop lock、日志和 TeamStore 仍由
  // os.UserHomeDir 派生。没有显式 profile root 时不得启动隔离真实门。
  throw new HarnessError('SIDECAR_PROFILE_ROOT_UNSUPPORTED')

  chatSubmissionCount = 0
  const deadlineAt = Date.now() + LIVE_BUDGET_MS
  const paths = resolveLiveInputs(env)
  const candidate = await attestLiveInputs(paths)
  const evidence = newEvidence(candidate)
  let ownedRoot
  let activeSidecar
  let failure

  try {
    ownedRoot = await createPrivateRunRoot()
    const port = await reserveLoopbackPort()
    const baseURL = `http://127.0.0.1:${port}`
    const runtime = await prepareRuntime(paths, ownedRoot, port, deadlineAt, env)
    evidence.prepared_config_sha256 = runtime.config_sha256

    const capabilityBefore = randomBytes(32).toString('hex')
    activeSidecar = startSidecar(paths.candidateBinary, runtime, capabilityBefore, env)
    await waitForSidecar(baseURL, activeSidecar, deadlineAt)
    const firstConfig = await requestJSON(baseURL, '/api/v1/config/llm', {
      capability: capabilityBefore,
      expectedStatus: 200,
      failureCode: 'CONFIG_PROJECTION_FAILED',
    })
    evidence.route_projection = assertExactProviderConfig(firstConfig.value)
    evidence.first_startup = await observeRemoteChatWarmup(baseURL, capabilityBefore)

    const requestID = `req-${randomUUID()}`
    const marker = `HEXCLAW-ATOMIC-${randomUUID()}`
    const chatPayload = buildChatRequest(requestID, marker)
    evidence.user_input = {
      sha256: sha256Text(chatPayload.message),
      bytes: Buffer.byteLength(chatPayload.message),
      marker_sha256: sha256Text(marker),
    }
    const chat = await submitChat(baseURL, capabilityBefore, chatPayload, deadlineAt)
    evidence.execution.chat_submissions = chatSubmissionCount
    assertChatSubmissionCount(1)
    evidence.response = projectChatResponse(chat.value, requestID, marker)
    evidence.physical_call = await pollPhysicalProviderReceipt(
      baseURL,
      capabilityBefore,
      requestID,
    )
    evidence.execution.physical_provider_call_count_observable = true
    evidence.execution.physical_provider_calls = 1

    const historyBefore = await pollHistory(
      baseURL,
      capabilityBefore,
      chat.value,
      chatPayload.message,
      requestID,
      marker,
    )
    evidence.history_before_restart = historyBefore.projection

    await stopSidecar(activeSidecar)
    activeSidecar = null
    await waitForPortReleased(port)

    const capabilityAfter = randomBytes(32).toString('hex')
    if (capabilityAfter === capabilityBefore) throw new HarnessError('CAPABILITY_ROTATION_FAILED')
    activeSidecar = startSidecar(paths.candidateBinary, runtime, capabilityAfter, env)
    await waitForSidecar(baseURL, activeSidecar, deadlineAt)
    await requestJSON(baseURL, '/api/v1/config/llm', {
      capability: capabilityBefore,
      expectedStatus: 401,
      parse: false,
      failureCode: 'OLD_CAPABILITY_NOT_REJECTED',
    })
    const secondConfig = await requestJSON(baseURL, '/api/v1/config/llm', {
      capability: capabilityAfter,
      expectedStatus: 200,
      failureCode: 'RESTART_CONFIG_PROJECTION_FAILED',
    })
    assert.deepEqual(assertExactProviderConfig(secondConfig.value), evidence.route_projection)
    evidence.second_startup = await observeRemoteChatWarmup(baseURL, capabilityAfter)

    const submissionsAtRestart = chatSubmissionCount
    const historyAfterRaw = await readHistory(baseURL, capabilityAfter, chat.value.session_id)
    assert.deepEqual(historyAfterRaw, historyBefore.raw)
    const historyAfterProjection = projectHistory(
      historyAfterRaw.messages,
      chat.value,
      chatPayload.message,
      requestID,
      marker,
    )
    assert.deepEqual(historyAfterProjection, historyBefore.projection)
    evidence.history_after_restart = historyAfterProjection
    evidence.restart_physical_call = await assertNoPhysicalReceipt(
      baseURL,
      capabilityAfter,
      requestID,
    )
    const chatSubmissionsAfterRestart = chatSubmissionCount - submissionsAtRestart
    evidence.restart = {
      capability_rotated: true,
      old_capability_rejected: true,
      history_exact_deep_equal: true,
      history_projection_equal: true,
      chat_submissions_after_restart: 0,
    }
    if (chatSubmissionsAfterRestart !== 0) {
      throw new HarnessError('RESTART_CHAT_SUBMISSION_OBSERVED')
    }
    assertChatSubmissionCount(1)
    evidence.execution.physical_provider_calls_after_restart = 0
    evidence.execution.total_explicit_user_physical_provider_calls = 1
    evidence.status = 'passed'
  } catch (error) {
    failure = error
    evidence.status = 'failed'
    evidence.failure = failureEvidence(error)
    evidence.execution.chat_submissions = chatSubmissionCount
  } finally {
    if (activeSidecar) {
      try {
        await stopSidecar(activeSidecar)
      } catch (error) {
        evidence.stop_failure = failureEvidence(error)
        failure ??= error
        evidence.status = 'failed'
      }
    }
    if (ownedRoot) {
      try {
        await removePrivateRunRoot(ownedRoot)
        evidence.temporary_profile_removed = true
      } catch (error) {
        evidence.removal_failure = failureEvidence(error)
        failure ??= error
        evidence.status = 'failed'
      }
    }
    evidence.completed_at = new Date().toISOString()
    evidence.elapsed_ms = Date.now() - Date.parse(evidence.observed_at)
  }

  const evidenceFile = await writeEvidence(paths.evidenceDirectory, evidence)
  if (failure) {
    failure.evidenceFile = evidenceFile
    throw failure
  }
  const receipt = {
    status: 'passed',
    mode: 'live',
    acceptance_id: evidence.acceptance_id,
    candidate_sha256: candidate.binary_sha256,
    evidence_file: evidenceFile,
    provider: EXPECTED_PROVIDER,
    model: EXPECTED_MODEL,
    chat_submissions: 1,
    physical_provider_calls: 1,
    restart_chat_submissions: 0,
    im_called: false,
  }
  assertEvidenceSafe(receipt)
  return receipt
}

async function staticValidation() {
  assert.equal(MAX_CHAT_SUBMISSIONS, 1)
  assert.equal(LIVE_BUDGET_MS < 29 * 60_000, true)
  assert.equal(resolveMode([]), 'validate')
  assert.equal(resolveMode(['run']), 'run')
  assert.equal(resolveMode(['run-default-profile']), 'run-default-profile')
  const receipt = {
    status: 'validated',
    mode: 'validate',
    sidecar_started: false,
    model_called: false,
    im_called: false,
    live_supported: false,
    blocker: 'SIDECAR_PROFILE_ROOT_UNSUPPORTED',
    default_profile_live_supported: true,
    default_profile_live_gate_required: true,
  }
  assertEvidenceSafe(receipt)
  return receipt
}

async function main() {
  const mode = resolveMode(process.argv.slice(2))
  let receipt
  if (mode === 'validate') receipt = await staticValidation()
  else if (mode === 'run-default-profile') receipt = await runDefaultProfile(process.env)
  else receipt = await runLive(process.env)
  process.stdout.write(`${JSON.stringify(receipt)}\n`)
}

if (resolve(process.argv[1] ?? '') === SCRIPT_PATH) {
  try {
    await main()
  } catch (error) {
    const receipt = {
      status: 'failed',
      code: safeFailureCode(error),
    }
    if (typeof error?.evidenceFile === 'string') receipt.evidence_file = error.evidenceFile
    assertEvidenceSafe(receipt)
    process.stderr.write(`${JSON.stringify(receipt)}\n`)
    process.exitCode = 1
  }
}
