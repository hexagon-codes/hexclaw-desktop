#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFile as execFileCallback, spawn } from 'node:child_process'
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, realpath, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)

const EXPECTED_PROVIDER = 'hexclaw-gpt'
const EXPECTED_MODEL = 'gpt-5.6-sol'
const SCRIPT_PATH = fileURLToPath(import.meta.url)
const DESKTOP_ROOT = resolve(dirname(SCRIPT_PATH), '../..')
const DEFAULT_SOURCE_ROOT = resolve(DESKTOP_ROOT, '../hexclaw')
const DEFAULT_GO_BINARY = '/usr/local/go/bin/go'
const SQLITE_BINARY = '/usr/bin/sqlite3'
const DEFAULT_EVIDENCE_DIRECTORY = resolve(
  DESKTOP_ROOT,
  '../hexclaw-docs/test/evidence/k12-source-sol-headless',
)
const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
const LIVE_BUDGET_MS = 25 * 60_000
const SIDECAR_START_TIMEOUT_MS = 90_000
const WARMUP_TIMEOUT_MS = 10 * 60_000 + 30_000
const CHAT_TIMEOUT_MS = 5 * 60_000

class HarnessError extends Error {
  constructor(code) {
    super(code.replaceAll('_', ' ').toLowerCase())
    this.name = 'HarnessError'
    this.code = code
  }
}

function liveGateAllowsRun(env) {
  return env?.HEXCLAW_SOURCE_SOL_LIVE === '1'
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
    control.on !== 'low' ||
    control.off !== 'none' ||
    !Array.isArray(control.allowed_efforts) ||
    control.allowed_efforts.length !== 1 ||
    control.allowed_efforts[0] !== 'low'
  ) {
    throw new HarnessError('REASONING_LOW_NOT_DECLARED')
  }
  return {
    support: spec.reasoning_support,
    dialect: control.dialect,
    low_available: true,
  }
}

function projectReasoningReceipt(receipt) {
  const requests = new Set(['on', 'off'])
  const supports = new Set(['supported', 'unsupported', 'unknown'])
  const executions = new Set(['applied', 'ignored', 'rejected', 'unknown'])
  if (
    receipt?.version !== 1 ||
    !requests.has(receipt.reasoning_request) ||
    !supports.has(receipt.reasoning_support) ||
    !executions.has(receipt.reasoning_execution)
  ) {
    throw new HarnessError('REASONING_RECEIPT_INVALID')
  }
  return {
    version: receipt.version,
    request: receipt.reasoning_request,
    support: receipt.reasoning_support,
    execution: receipt.reasoning_execution,
    effort_application_observable: false,
  }
}

const FORBIDDEN_EVIDENCE_FIELDS = new Set([
  'api_key',
  'body',
  'capability',
  'capability_token',
  'content',
  'credential_ref',
  'owner_config',
  'path',
  'profile_path',
  'prompt',
  'raw',
  'reply',
  'request_body',
  'response_body',
  'source_config',
  'store_path',
  'token',
])

function assertEvidenceSafe(value, field = '') {
  if (FORBIDDEN_EVIDENCE_FIELDS.has(field)) throw new HarnessError('UNSAFE_EVIDENCE_FIELD')
  if (typeof value === 'string') {
    if (
      value.startsWith('/') ||
      value.startsWith('file:') ||
      /\/Users\//.test(value) ||
      /\bBearer\s+/i.test(value) ||
      /\bapi[_-]?key\s*[:=]/i.test(value)
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

function resolveMode(args) {
  if (!Array.isArray(args) || args.length === 0) return 'validate'
  if (args.length !== 1 || !['validate', 'run'].includes(args[0])) {
    throw new HarnessError('INVALID_ARGUMENTS')
  }
  return args[0]
}

function sha256Text(value) {
  return createHash('sha256').update(String(value)).digest('hex')
}

function normalizeTextForDiagnostic(value) {
  return String(value).replace(/\r\n?/gu, '\n').trim()
}

function responseHistoryDiagnostics(responseValue, historyValue) {
  const response = String(responseValue)
  const history = String(historyValue)
  return {
    response_bytes: Buffer.byteLength(response),
    history_bytes: Buffer.byteLength(history),
    response_sha256: sha256Text(response),
    history_sha256: sha256Text(history),
    response_normalized_sha256: sha256Text(normalizeTextForDiagnostic(response)),
    history_normalized_sha256: sha256Text(normalizeTextForDiagnostic(history)),
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
    !Array.isArray(provider.models) ||
    provider.models.length !== 1 ||
    provider.models[0] !== EXPECTED_MODEL
  ) {
    throw new HarnessError('PROVIDER_ROUTE_NOT_EXACT')
  }
  return {
    provider: EXPECTED_PROVIDER,
    model: EXPECTED_MODEL,
    reasoning: projectReasoningContract(provider),
  }
}

function decodeMetadataField(raw) {
  if (raw === undefined || raw === null || raw === '') return {}
  if (typeof raw === 'object' && !Array.isArray(raw)) return { ...raw }
  if (typeof raw !== 'string') throw new HarnessError('MESSAGE_METADATA_INVALID')
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object')
    }
    return parsed
  } catch {
    throw new HarnessError('MESSAGE_METADATA_INVALID')
  }
}

function mergedMessageMetadata(message) {
  return {
    ...decodeMetadataField(message?.metadata),
    ...decodeMetadataField(message?.meta),
  }
}

function projectHistoryEvidence(messages, response, requestID) {
  if (!Array.isArray(messages)) throw new HarnessError('HISTORY_INVALID')
  const users = messages.filter((message) => message?.role === 'user')
  const assistants = messages.filter((message) => message?.role === 'assistant')
  if (users.length !== 1 || assistants.length !== 1) {
    throw new HarnessError('HISTORY_CARDINALITY_INVALID')
  }
  const assistant = assistants[0]
  const user = users[0]
  const metadata = mergedMessageMetadata(assistant)
  const responseMetadata = decodeMetadataField(response?.metadata)
  const responseIDs = [
    response?.assistant_message_id,
    response?.backend_message_id,
    response?.message_id,
  ]
  if (
    typeof response?.reply !== 'string' ||
    response.reply.trim() === '' ||
    typeof response?.session_id !== 'string' ||
    response.session_id === '' ||
    responseIDs.some((value) => typeof value !== 'string' || value === '') ||
    new Set(responseIDs).size !== 1 ||
    user?.id !== requestID ||
    user?.request_id !== requestID ||
    user?.session_id !== response.session_id ||
    assistant?.id !== responseIDs[0] ||
    assistant?.request_id !== requestID ||
    assistant?.session_id !== response.session_id ||
    responseMetadata.provider !== EXPECTED_PROVIDER ||
    responseMetadata.model !== EXPECTED_MODEL ||
    responseMetadata.persist_error !== undefined ||
    metadata.provider !== EXPECTED_PROVIDER ||
    metadata.model !== EXPECTED_MODEL ||
    metadata.persist_error !== undefined ||
    metadata.assistant_message_id !== responseIDs[0] ||
    metadata.backend_message_id !== responseIDs[0] ||
    metadata.message_id !== responseIDs[0]
  ) {
    throw new HarnessError('TERMINAL_ASSISTANT_INVARIANT_FAILED')
  }
  const reasoning = projectReasoningReceipt(metadata.reasoning_receipt)
  if (
    reasoning.request !== 'on' ||
    reasoning.support !== 'supported' ||
    reasoning.execution !== 'applied'
  ) {
    throw new HarnessError('REASONING_RECEIPT_NOT_APPLIED')
  }
  const diagnostics = responseHistoryDiagnostics(response.reply, assistant.content ?? '')
  if (diagnostics.response_sha256 !== diagnostics.history_sha256) {
    const error = new HarnessError('RESPONSE_HISTORY_MISMATCH')
    error.responseHistoryDiagnostics = diagnostics
    throw error
  }
  return {
    user_count: users.length,
    assistant_count: assistants.length,
    assistant_id_sha256: sha256Text(assistant.id),
    request_id_sha256: sha256Text(requestID),
    session_id_sha256: sha256Text(response.session_id),
    response_bytes: Buffer.byteLength(response.reply),
    response_sha256: diagnostics.response_sha256,
    response_content_match: true,
    provider: EXPECTED_PROVIDER,
    model: EXPECTED_MODEL,
    reasoning,
  }
}

function isOwnedTemporaryRoot(candidate, canonicalTmp) {
  if (typeof candidate !== 'string' || typeof canonicalTmp !== 'string') return false
  const normalizedCandidate = resolve(candidate)
  const normalizedTmp = resolve(canonicalTmp)
  return (
    dirname(normalizedCandidate) === normalizedTmp &&
    basename(normalizedCandidate).startsWith('hexclaw-source-sol-')
  )
}

function newEvidenceSkeleton(now = new Date()) {
  return {
    schema_version: 1,
    status: 'running',
    observed_at: now.toISOString(),
    route: {
      provider: EXPECTED_PROVIDER,
      model: EXPECTED_MODEL,
      fallback_allowed: false,
    },
    isolation: {
      headless: true,
      foreground_application_started: false,
      dingtalk_enabled: false,
      isolated_home: true,
      random_process_auth: true,
    },
    execution: {
      explicit_user_post_count: 0,
      physical_provider_call_count_observable: false,
      physical_provider_call_count_claimed: false,
    },
    startup_warmup: {
      status: 'not_observed',
      may_call_provider: true,
      counted_as_explicit_user_post: false,
    },
    reasoning: {
      requested: 'on',
      requested_effort: 'low',
      request_source: 'headless_harness',
      effort_application_observable: false,
      effort_applied_claimed: false,
    },
  }
}

async function runAuthorized(env, operation) {
  if (!liveGateAllowsRun(env)) throw new HarnessError('LIVE_GATE_REQUIRED')
  return await operation()
}

async function dispatchMode(mode, env, operations) {
  if (mode === 'validate') return await operations.validate()
  if (mode === 'run') return await runAuthorized(env, operations.run)
  throw new HarnessError('INVALID_MODE')
}

function buildChatRequest(agentName, requestID, left, right) {
  if (
    typeof agentName !== 'string' ||
    agentName.trim() === '' ||
    typeof requestID !== 'string' ||
    requestID.trim() === '' ||
    !Number.isInteger(left) ||
    !Number.isInteger(right)
  ) {
    throw new HarnessError('CHAT_REQUEST_INPUT_INVALID')
  }
  return {
    message: `孩子正在复习五年级数学。请用孩子能听懂的方式，先估算，再列竖式讲解 ${left} × ${right}，最后用另一种方法验算。`,
    role: agentName,
    request_id: requestID,
    metadata: {
      pinned_agent: agentName,
      producer_kind: 'chat',
      thinking: 'on',
      thinking_effort: 'low',
      memory: 'off',
      user_locale: 'zh-CN',
      locale: 'zh-CN',
    },
  }
}

class LogEvidenceCollector {
  constructor() {
    this.hash = createHash('sha256')
    this.totalBytes = 0
    this.decoders = {
      stdout: new StringDecoder('utf8'),
      stderr: new StringDecoder('utf8'),
    }
    this.pending = { stdout: '', stderr: '' }
    this.warmupStatus = 'not_observed'
    this.flags = {
      assistant_persist_failure: false,
      context_deadline: false,
      persist_error: false,
      sqlite_busy: false,
    }
    this.warmupWaiters = new Set()
  }

  ingest(stream, chunk) {
    if (!Object.hasOwn(this.decoders, stream) || !Buffer.isBuffer(chunk)) {
      throw new HarnessError('LOG_INPUT_INVALID')
    }
    this.hash.update(stream)
    this.hash.update(Buffer.from([0]))
    this.hash.update(chunk)
    this.totalBytes += chunk.length
    this.#consumeText(stream, this.decoders[stream].write(chunk))
  }

  #consumeText(stream, text) {
    const combined = this.pending[stream] + text
    const lines = combined.split(/\r?\n/u)
    this.pending[stream] = lines.pop()?.slice(-8192) ?? ''
    for (const line of lines) this.#observeLine(line)
  }

  #observeLine(line) {
    const lower = line.toLowerCase()
    if (lower.includes('database is locked') || lower.includes('sqlite_busy')) {
      this.flags.sqlite_busy = true
    }
    if (lower.includes('persist_error')) this.flags.persist_error = true
    if (
      lower.includes('failed to persist assistant runtime snapshot') ||
      line.includes('保存助手回复失败')
    ) {
      this.flags.assistant_persist_failure = true
    }
    if (lower.includes('context deadline')) this.flags.context_deadline = true

    let terminal
    if (line.includes('[warmup] 本地默认模型预热完成')) terminal = 'completed'
    else if (line.includes('[warmup] 默认路由非本地模型，跳过预热')) terminal = 'skipped_non_local'
    else if (line.includes('[warmup] 本地模型预热失败')) terminal = 'failed'
    if (terminal && this.warmupStatus === 'not_observed') {
      this.warmupStatus = terminal
      for (const resolveWaiter of this.warmupWaiters) resolveWaiter(terminal)
      this.warmupWaiters.clear()
    }
  }

  async waitForWarmup(timeoutMs) {
    if (this.warmupStatus !== 'not_observed') return this.warmupStatus
    return await new Promise((resolveWait) => {
      const onTerminal = (status) => {
        clearTimeout(timer)
        resolveWait(status)
      }
      const timer = setTimeout(() => {
        this.warmupWaiters.delete(onTerminal)
        resolveWait('unobserved_timeout')
      }, timeoutMs)
      this.warmupWaiters.add(onTerminal)
    })
  }

  finish() {
    for (const stream of ['stdout', 'stderr']) {
      this.#consumeText(stream, this.decoders[stream].end())
      if (this.pending[stream]) this.#observeLine(this.pending[stream])
      this.pending[stream] = ''
    }
    return this.snapshot()
  }

  snapshot() {
    return {
      sha256: this.hash.copy().digest('hex'),
      bytes: this.totalBytes,
      warmup_status: this.warmupStatus,
      flags: { ...this.flags },
      raw_archived: false,
    }
  }
}

function projectSQLiteRows(rows, assistantMessageID, requestID, sessionID) {
  if (!Array.isArray(rows) || rows.length !== 2) {
    throw new HarnessError('SQLITE_MESSAGE_CARDINALITY_INVALID')
  }
  const userRows = rows.filter((row) => row?.role === 'user')
  const assistantRows = rows.filter((row) => row?.role === 'assistant')
  if (userRows.length !== 1 || assistantRows.length !== 1) {
    throw new HarnessError('SQLITE_MESSAGE_ROLES_INVALID')
  }
  const assistant = assistantRows[0]
  const user = userRows[0]
  const reasoning = projectReasoningReceipt({
    version: Number(assistant.receipt_version),
    reasoning_request: assistant.receipt_request,
    reasoning_support: assistant.receipt_support,
    reasoning_execution: assistant.receipt_execution,
  })
  const ids = [
    assistant.id,
    assistant.assistant_message_id,
    assistant.backend_message_id,
    assistant.message_id,
  ]
  if (
    ids.some((id) => id !== assistantMessageID) ||
    user.id !== requestID ||
    user.request_id !== requestID ||
    user.session_id !== sessionID ||
    assistant.session_id !== sessionID ||
    assistant.request_id !== requestID ||
    assistant.provider !== EXPECTED_PROVIDER ||
    assistant.model !== EXPECTED_MODEL ||
    (assistant.persist_error !== null && assistant.persist_error !== undefined) ||
    reasoning.request !== 'on' ||
    reasoning.support !== 'supported' ||
    reasoning.execution !== 'applied'
  ) {
    throw new HarnessError('SQLITE_ASSISTANT_INVARIANT_FAILED')
  }
  return {
    row_count: rows.length,
    user_count: userRows.length,
    assistant_count: assistantRows.length,
    assistant_id_sha256: sha256Text(assistantMessageID),
    request_id_sha256: sha256Text(requestID),
    session_id_sha256: sha256Text(sessionID),
    assistant_id_match: true,
    request_id_match: true,
    provider: EXPECTED_PROVIDER,
    model: EXPECTED_MODEL,
    assistant_bytes: Number(assistant.content_bytes),
    reasoning,
  }
}

function safeFailureCode(error, fallback = 'HARNESS_FAILED') {
  if (error instanceof HarnessError && /^[A-Z0-9_]+$/.test(error.code)) return error.code
  return fallback
}

function outputDigest(error) {
  const hash = createHash('sha256')
  let observed = false
  for (const value of [error?.stdout, error?.stderr]) {
    if (value === undefined || value === null) continue
    observed = true
    hash.update(Buffer.isBuffer(value) ? value : Buffer.from(String(value)))
  }
  return observed ? hash.digest('hex') : undefined
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
    wrapped.diagnosticSHA256 = outputDigest(error)
    throw wrapped
  }
}

function buildToolEnvironment(env = process.env) {
  const result = {}
  for (const name of [
    'HOME',
    'PATH',
    'TMPDIR',
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
  try {
    const info = await stat(pathname)
    if (!info.isDirectory()) throw new Error('not directory')
  } catch {
    throw new HarnessError(code)
  }
}

function livePaths(env = process.env) {
  const sourceRoot = resolve(env.HEXCLAW_SOURCE_ROOT || DEFAULT_SOURCE_ROOT)
  const goBinary = resolve(env.HEXCLAW_GO_BIN || DEFAULT_GO_BINARY)
  const ownerConfig = resolve(
    env.HEXCLAW_OWNER_CONFIG || join(homedir(), '.hexclaw', 'hexclaw.yaml'),
  )
  const evidenceDirectory = resolve(env.HEXCLAW_EVIDENCE_DIR || DEFAULT_EVIDENCE_DIRECTORY)
  return { sourceRoot, goBinary, ownerConfig, evidenceDirectory }
}

function injectedSidecarBinary(env = process.env) {
  const value = typeof env?.HEXCLAW_SIDECAR_BINARY === 'string'
    ? env.HEXCLAW_SIDECAR_BINARY.trim()
    : ''
  return value === '' ? '' : resolve(value)
}

async function staticValidation(env = process.env) {
  await runSelfTests()
  const { sourceRoot, goBinary } = livePaths(env)
  await requireDirectory(sourceRoot, 'SOURCE_ROOT_UNAVAILABLE')
  await requireRegularFile(join(sourceRoot, 'go.mod'), 'SOURCE_MODULE_UNAVAILABLE')
  await requireRegularFile(
    join(sourceRoot, 'cmd', 'hexclaw', 'main.go'),
    'SIDECAR_SOURCE_UNAVAILABLE',
  )
  await requireRegularFile(
    join(sourceRoot, 'cmd', 'k12-live-fixture-testtools', 'main_testtools.go'),
    'FIXTURE_SOURCE_UNAVAILABLE',
  )
  await requireRegularFile(goBinary, 'GO_BINARY_UNAVAILABLE', { executable: true })
  await requireRegularFile(SQLITE_BINARY, 'SQLITE_BINARY_UNAVAILABLE', { executable: true })
  const sidecarInput = injectedSidecarBinary(env)
  if (sidecarInput !== '') {
    await requireRegularFile(sidecarInput, 'SIDECAR_BINARY_INPUT_INVALID', { executable: true })
  }
  const receipt = {
    status: 'validated',
    mode: 'static',
    helper_tests: 'passed',
    live_gate_required: true,
    sidecar_started: false,
    model_called: false,
    dingtalk_called: false,
  }
  assertEvidenceSafe(receipt)
  return receipt
}

async function createPrivateFile(pathname, bytes) {
  const handle = await open(pathname, 'wx', PRIVATE_FILE_MODE)
  try {
    if (bytes !== undefined) await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await chmod(pathname, PRIVATE_FILE_MODE)
}

async function createPrivateRunRoot() {
  const canonicalTmp = await realpath('/tmp')
  const created = await mkdtemp('/tmp/hexclaw-source-sol-')
  await chmod(created, PRIVATE_DIRECTORY_MODE)
  const canonicalRoot = await realpath(created)
  if (!isOwnedTemporaryRoot(canonicalRoot, canonicalTmp)) {
    throw new HarnessError('TEMP_ROOT_OWNERSHIP_INVALID')
  }
  return { root: canonicalRoot, canonicalTmp }
}

async function removePrivateRunRoot(root, canonicalTmp) {
  let canonicalRoot
  try {
    canonicalRoot = await realpath(root)
  } catch {
    return
  }
  if (!isOwnedTemporaryRoot(canonicalRoot, canonicalTmp)) {
    throw new HarnessError('TEMP_ROOT_CLEANUP_REFUSED')
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

function parseJSONReceipt(raw, code) {
  try {
    const value = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not object')
    return value
  } catch {
    throw new HarnessError(code)
  }
}

function parseJSONRows(raw, code) {
  if (String(raw).trim() === '') return []
  try {
    const value = JSON.parse(raw)
    if (!Array.isArray(value)) throw new Error('not array')
    return value
  } catch {
    throw new HarnessError(code)
  }
}

function remainingBudget(deadlineAt, maximum, code) {
  const remaining = deadlineAt - Date.now()
  if (!Number.isFinite(remaining) || remaining <= 0) throw new HarnessError(code)
  return Math.max(1, Math.min(maximum, remaining))
}

async function sha256File(pathname) {
  const bytes = await readFile(pathname)
  return createHash('sha256').update(bytes).digest('hex')
}

async function materializeSidecarBinary({
  env = process.env,
  sourceRoot,
  goBinary,
  sidecarBinary,
  toolEnvironment,
  deadlineAt,
  runCommandFn = runCommand,
}) {
  const sidecarInput = injectedSidecarBinary(env)
  if (sidecarInput === '') {
    await runCommandFn(
      goBinary,
      ['build', '-trimpath', '-o', sidecarBinary, './cmd/hexclaw'],
      {
        cwd: sourceRoot,
        env: toolEnvironment,
        timeoutMs: remainingBudget(deadlineAt, 8 * 60_000, 'SIDECAR_BUILD_BUDGET_EXHAUSTED'),
      },
      'SIDECAR_BUILD_FAILED',
    )
    await requireRegularFile(sidecarBinary, 'SIDECAR_BINARY_INVALID', { executable: true })
    return {
      sidecar_source: 'go_build',
      sidecar_input_sha256: null,
      sidecar_sha256: await sha256File(sidecarBinary),
      sidecar_input_matches_runtime: null,
    }
  }

  await requireRegularFile(sidecarInput, 'SIDECAR_BINARY_INPUT_INVALID', { executable: true })
  const inputSHA256 = await sha256File(sidecarInput)
  try {
    await copyFile(sidecarInput, sidecarBinary, fsConstants.COPYFILE_EXCL)
    await chmod(sidecarBinary, 0o700)
  } catch {
    throw new HarnessError('SIDECAR_BINARY_COPY_FAILED')
  }
  await requireRegularFile(sidecarBinary, 'SIDECAR_BINARY_INVALID', { executable: true })
  const runtimeSHA256 = await sha256File(sidecarBinary)
  if (runtimeSHA256 !== inputSHA256) {
    throw new HarnessError('SIDECAR_BINARY_DIGEST_MISMATCH')
  }
  return {
    sidecar_source: 'injected_binary',
    sidecar_input_sha256: inputSHA256,
    sidecar_sha256: runtimeSHA256,
    sidecar_input_matches_runtime: true,
  }
}

function valueType(value) {
  if (value === undefined) return 'missing'
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function hasExactFields(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.keys(value).sort().join('\u0000') === [...expected].sort().join('\u0000')
}

function safeInteger(value) {
  return Number.isSafeInteger(value) ? value : null
}

function fixtureReceiptActual(receipt, output, extra = {}) {
  const boundary = receipt?.boundary_calls
  return {
    stdout_line_count: output.stdoutLineCount,
    parsed_object_count: output.parsedObjectCount,
    structured_log_count: output.structuredLogCount,
    output_sha256: output.outputSHA256,
    ...extra,
    terminal_receipt: {
      present: Boolean(receipt && typeof receipt === 'object' && !Array.isArray(receipt)),
      top_level_exact: hasExactFields(receipt, ['status', 'created', 'boundary_calls']),
      status_type: valueType(receipt?.status),
      status_class: receipt?.status === 'started' ? 'started' : 'other',
      created_type: valueType(receipt?.created),
      created_value: safeInteger(receipt?.created),
      boundary_calls_type: valueType(boundary),
      boundary_fields_exact: hasExactFields(boundary, [
        'model_calls',
        'dingtalk_sends',
        'im_sends',
      ]),
      model_calls_type: valueType(boundary?.model_calls),
      model_calls_value: safeInteger(boundary?.model_calls),
      dingtalk_sends_type: valueType(boundary?.dingtalk_sends),
      dingtalk_sends_value: safeInteger(boundary?.dingtalk_sends),
      im_sends_type: valueType(boundary?.im_sends),
      im_sends_value: safeInteger(boundary?.im_sends),
    },
  }
}

function fixtureReceiptFailure(code, receipt, output, extra = {}) {
  const error = new HarnessError(code)
  error.fixtureReceiptActual = fixtureReceiptActual(receipt, output, extra)
  return error
}

function assertFixtureReceipt(receipt, output) {
  if (!hasExactFields(receipt, ['status', 'created', 'boundary_calls'])) {
    throw fixtureReceiptFailure('FIXTURE_RECEIPT_SHAPE_INVALID', receipt, output)
  }
  if (receipt.status !== 'started') {
    throw fixtureReceiptFailure('FIXTURE_RECEIPT_STATUS_INVALID', receipt, output)
  }
  if (!Number.isSafeInteger(receipt.created) || receipt.created !== 2) {
    throw fixtureReceiptFailure('FIXTURE_RECEIPT_CREATED_INVALID', receipt, output)
  }
  const boundary = receipt.boundary_calls
  if (
    !hasExactFields(boundary, ['model_calls', 'dingtalk_sends', 'im_sends']) ||
    !Number.isSafeInteger(boundary.model_calls) ||
    !Number.isSafeInteger(boundary.dingtalk_sends) ||
    !Number.isSafeInteger(boundary.im_sends)
  ) {
    throw fixtureReceiptFailure('FIXTURE_RECEIPT_BOUNDARY_SHAPE_INVALID', receipt, output)
  }
  if (boundary.model_calls !== 0 || boundary.dingtalk_sends !== 0 || boundary.im_sends !== 0) {
    throw fixtureReceiptFailure('FIXTURE_EXTERNAL_CALLS_OBSERVED', receipt, output)
  }
  return {
    status: receipt.status,
    created: receipt.created,
    boundary_calls: {
      model: 0,
      dingtalk: 0,
      im: 0,
    },
  }
}

function isStructuredFixtureLog(value) {
  return Boolean(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof value.level === 'string' &&
      typeof value.msg === 'string' &&
      ['string', 'number'].includes(typeof value.time),
  )
}

function parseFixtureStartReceipt(rawOutput) {
  const text = String(rawOutput ?? '')
  const lines = text.split(/\r?\n/u).filter((line) => line.trim() !== '')
  const output = {
    stdoutLineCount: lines.length,
    parsedObjectCount: 0,
    structuredLogCount: 0,
    outputSHA256: sha256Text(text),
  }
  if (lines.length === 0) {
    throw fixtureReceiptFailure('FIXTURE_RECEIPT_OUTPUT_EMPTY', undefined, output)
  }

  const objects = []
  for (const [index, line] of lines.entries()) {
    try {
      const value = JSON.parse(line)
      objects.push(value)
      output.parsedObjectCount += 1
    } catch {
      throw fixtureReceiptFailure('FIXTURE_RECEIPT_LINE_INVALID_JSON', undefined, output, {
        invalid_line_number: index + 1,
      })
    }
  }

  const receipt = objects.at(-1)
  for (const [index, value] of objects.slice(0, -1).entries()) {
    if (!isStructuredFixtureLog(value)) {
      throw fixtureReceiptFailure('FIXTURE_RECEIPT_LOG_INVALID', receipt, output, {
        invalid_log_line_number: index + 1,
      })
    }
    output.structuredLogCount += 1
  }

  const projected = assertFixtureReceipt(receipt, output)
  return {
    receipt: projected,
    output: {
      stdout_line_count: output.stdoutLineCount,
      parsed_object_count: output.parsedObjectCount,
      structured_log_count: output.structuredLogCount,
      output_sha256: output.outputSHA256,
    },
  }
}

function assertFixtureManifest(manifest) {
  if (
    manifest?.schema_version !== 1 ||
    typeof manifest?.agent_name !== 'string' ||
    manifest.agent_name.trim() === '' ||
    typeof manifest?.ownership !== 'string' ||
    manifest.ownership.trim() === '' ||
    typeof manifest?.retryable_dispatch_id !== 'string' ||
    manifest.retryable_dispatch_id.trim() === '' ||
    typeof manifest?.outcome_unknown_dispatch_id !== 'string' ||
    manifest.outcome_unknown_dispatch_id.trim() === '' ||
    !Number.isInteger(manifest?.lease_expires_at) ||
    manifest.lease_expires_at <= Math.floor(Date.now() / 1000)
  ) {
    throw new HarnessError('FIXTURE_MANIFEST_INVALID')
  }
  return manifest.agent_name
}

function assertAgentRoute(payload, agentName) {
  const agents = Array.isArray(payload?.agents) ? payload.agents : []
  const matching = agents.filter((agent) => agent?.name === agentName)
  if (
    matching.length !== 1 ||
    matching[0]?.provider !== EXPECTED_PROVIDER ||
    matching[0]?.model !== EXPECTED_MODEL
  ) {
    throw new HarnessError('PINNED_AGENT_ROUTE_NOT_EXACT')
  }
  return {
    agent_name_sha256: sha256Text(agentName),
    provider: EXPECTED_PROVIDER,
    model: EXPECTED_MODEL,
    exact_match_count: matching.length,
  }
}

function assertChatResponse(response, requestID) {
  const metadata = decodeMetadataField(response?.metadata)
  const ids = [response?.assistant_message_id, response?.backend_message_id, response?.message_id]
  const usage = response?.usage
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
    usage?.provider !== EXPECTED_PROVIDER ||
    usage?.model !== EXPECTED_MODEL ||
    !Number.isInteger(usage?.total_tokens) ||
    usage.total_tokens <= 0
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
  }
}

async function prepareIsolatedRuntime(paths, ownedRoot, port, deadlineAt, env = process.env) {
  await requireRegularFile(paths.ownerConfig, 'OWNER_CONFIG_UNAVAILABLE', { privateFile: true })
  const profileRoot = ownedRoot.root
  const privateConfigDirectory = join(profileRoot, '.hexclaw')
  const binaryDirectory = join(profileRoot, 'bin')
  const temporaryDirectory = join(profileRoot, 'tmp')
  await mkdir(privateConfigDirectory, { mode: PRIVATE_DIRECTORY_MODE })
  await mkdir(binaryDirectory, { mode: PRIVATE_DIRECTORY_MODE })
  await mkdir(temporaryDirectory, { mode: PRIVATE_DIRECTORY_MODE })

  const store = join(profileRoot, 'data.db')
  const policy = join(profileRoot, 'candidate-policy.json')
  const manifest = join(profileRoot, 'fixture-manifest.json')
  const config = join(privateConfigDirectory, 'hexclaw.yaml')
  const lock = join(privateConfigDirectory, '.sidecar.lock')
  const sidecarBinary = join(binaryDirectory, 'hexclaw')
  const fixtureBinary = join(binaryDirectory, 'k12-live-fixture-testtools')
  await createPrivateFile(store, '')
  await createPrivateFile(policy, `${JSON.stringify(candidatePolicy())}\n`)

  const toolEnvironment = {
    ...buildToolEnvironment(env),
    HOME: profileRoot,
    TMPDIR: temporaryDirectory,
  }
  const sidecarEvidence = await materializeSidecarBinary({
    env,
    sourceRoot: paths.sourceRoot,
    goBinary: paths.goBinary,
    sidecarBinary,
    toolEnvironment,
    deadlineAt,
  })
  await runCommand(
    paths.goBinary,
    [
      'build',
      '-trimpath',
      '-tags',
      'testtools',
      '-o',
      fixtureBinary,
      './cmd/k12-live-fixture-testtools',
    ],
    {
      cwd: paths.sourceRoot,
      env: toolEnvironment,
      timeoutMs: remainingBudget(deadlineAt, 8 * 60_000, 'FIXTURE_BUILD_BUDGET_EXHAUSTED'),
    },
    'FIXTURE_BUILD_FAILED',
  )
  await requireRegularFile(fixtureBinary, 'FIXTURE_BINARY_INVALID', { executable: true })

  const prepared = await runCommand(
    fixtureBinary,
    [
      'prepare-profile',
      '--source-config',
      paths.ownerConfig,
      '--profile',
      profileRoot,
      '--store',
      store,
      '--candidate-policy',
      policy,
      '--port',
      String(port),
    ],
    {
      cwd: paths.sourceRoot,
      env: toolEnvironment,
      timeoutMs: remainingBudget(deadlineAt, 90_000, 'PROFILE_PREPARE_BUDGET_EXHAUSTED'),
    },
    'PROFILE_PREPARE_FAILED',
  )
  const prepareReceipt = parseJSONReceipt(prepared.stdout, 'PROFILE_PREPARE_RECEIPT_INVALID')
  if (
    prepareReceipt.status !== 'prepared' ||
    !/^[a-f0-9]{64}$/.test(prepareReceipt.config_sha256 ?? '')
  ) {
    throw new HarnessError('PROFILE_PREPARE_RECEIPT_INVALID')
  }
  await requireRegularFile(config, 'ISOLATED_CONFIG_INVALID', { privateFile: true })

  const started = await runCommand(
    fixtureBinary,
    [
      'start',
      '--profile',
      profileRoot,
      '--store',
      store,
      '--manifest',
      manifest,
      '--run-id',
      `run-${randomUUID()}`,
      '--learner',
      `learner-${randomUUID()}`,
      '--provider',
      EXPECTED_PROVIDER,
      '--model',
      EXPECTED_MODEL,
      '--lease',
      '30m',
    ],
    {
      cwd: paths.sourceRoot,
      env: toolEnvironment,
      timeoutMs: remainingBudget(deadlineAt, 90_000, 'FIXTURE_START_BUDGET_EXHAUSTED'),
    },
    'FIXTURE_START_FAILED',
  )
  const fixtureStart = parseFixtureStartReceipt(started.stdout)
  const fixtureReceipt = fixtureStart.receipt
  await requireRegularFile(manifest, 'FIXTURE_MANIFEST_INVALID', { privateFile: true })
  const fixtureManifest = parseJSONReceipt(
    await readFile(manifest, 'utf8'),
    'FIXTURE_MANIFEST_INVALID',
  )
  const agentName = assertFixtureManifest(fixtureManifest)
  return {
    profileRoot,
    temporaryDirectory,
    store,
    manifest,
    config,
    lock,
    sidecarBinary,
    fixtureBinary,
    toolEnvironment,
    agentName,
    evidence: {
      ...sidecarEvidence,
      fixture_sha256: await sha256File(fixtureBinary),
      config_sha256: prepareReceipt.config_sha256,
      fixture: {
        ...fixtureReceipt,
        output: fixtureStart.output,
        agent_name_sha256: sha256Text(agentName),
      },
    },
  }
}

function sidecarEnvironment(runtime, capability, env = process.env) {
  return {
    ...buildToolEnvironment(env),
    HOME: runtime.profileRoot,
    TMPDIR: runtime.temporaryDirectory,
    HEXCLAW_SIDECAR_CAPABILITY_TOKEN: capability,
    DINGTALK_LIVE_SEND: '0',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  }
}

function startSidecar(runtime, capability, env = process.env) {
  const collector = new LogEvidenceCollector()
  let resolveExit
  const exitPromise = new Promise((resolveValue) => {
    resolveExit = resolveValue
  })
  let terminal = null
  const settle = (value) => {
    if (terminal) return
    terminal = value
    resolveExit(value)
  }
  const child = spawn(runtime.sidecarBinary, ['serve', '--desktop', '--config', runtime.config], {
    cwd: runtime.profileRoot,
    env: sidecarEnvironment(runtime, capability, env),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stdout.on('data', (chunk) => collector.ingest('stdout', chunk))
  child.stderr.on('data', (chunk) => collector.ingest('stderr', chunk))
  child.once('error', () => settle({ code: null, signal: null, spawn_error: true }))
  child.once('close', (code, signal) => settle({ code, signal, spawn_error: false }))
  const state = {
    child,
    collector,
    exitPromise,
    logEvidence: null,
  }
  Object.defineProperty(state, 'terminal', { get: () => terminal })
  return state
}

async function stopSidecar(sidecar) {
  if (!sidecar) return null
  if (sidecar.logEvidence) return sidecar.logEvidence
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
  sidecar.logEvidence = {
    ...sidecar.collector.finish(),
    exited: true,
    forced: exit?.signal === 'SIGKILL',
  }
  return sidecar.logEvidence
}

async function waitForPortReleased(port, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const server = createServer()
    server.unref()
    const available = await new Promise((resolveCheck) => {
      server.once('error', () => resolveCheck(false))
      server.listen(port, '127.0.0.1', () => {
        server.close(() => resolveCheck(true))
      })
    })
    if (available) return true
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  throw new HarnessError('LOOPBACK_PORT_NOT_RELEASED')
}

async function assertLockAbsent(pathname) {
  try {
    await lstat(pathname)
  } catch (error) {
    if (error?.code === 'ENOENT') return true
    throw new HarnessError('SIDECAR_LOCK_INSPECTION_FAILED')
  }
  throw new HarnessError('SIDECAR_LOCK_NOT_RELEASED')
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
      return true
    } catch (error) {
      if (safeFailureCode(error) !== 'SIDECAR_NOT_READY') throw error
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150))
  }
  throw new HarnessError('SIDECAR_START_TIMEOUT')
}

async function pollHistory(
  baseURL,
  capability,
  sessionID,
  response,
  requestID,
  timeoutMs = 30_000,
) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await requestJSON(
      baseURL,
      `/api/v1/sessions/${encodeURIComponent(sessionID)}/messages?limit=50&offset=0`,
      {
        capability,
        expectedStatus: 200,
        failureCode: 'HISTORY_REQUEST_FAILED',
      },
    )
    try {
      return projectHistoryEvidence(result.value?.messages, response, requestID)
    } catch (error) {
      if (
        !(error instanceof HarnessError) ||
        !['HISTORY_CARDINALITY_INVALID', 'TERMINAL_ASSISTANT_INVARIANT_FAILED'].includes(error.code)
      ) {
        throw error
      }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150))
  }
  throw new HarnessError('HISTORY_TERMINAL_TIMEOUT')
}

async function readSQLiteEvidence(runtime, sessionID, assistantMessageID, requestID, deadlineAt) {
  const commandOptions = {
    cwd: runtime.profileRoot,
    env: runtime.toolEnvironment,
    timeoutMs: remainingBudget(deadlineAt, 30_000, 'SQLITE_READ_BUDGET_EXHAUSTED'),
  }
  const integrity = await runCommand(
    SQLITE_BINARY,
    ['-readonly', '-json', runtime.store, 'PRAGMA query_only=ON; PRAGMA integrity_check;'],
    commandOptions,
    'SQLITE_INTEGRITY_READ_FAILED',
  )
  const integrityRows = parseJSONRows(integrity.stdout, 'SQLITE_INTEGRITY_RECEIPT_INVALID')
  if (integrityRows.length !== 1 || integrityRows[0]?.integrity_check !== 'ok') {
    throw new HarnessError('SQLITE_INTEGRITY_FAILED')
  }
  const foreign = await runCommand(
    SQLITE_BINARY,
    ['-readonly', '-json', runtime.store, 'PRAGMA query_only=ON; PRAGMA foreign_key_check;'],
    commandOptions,
    'SQLITE_FOREIGN_KEY_READ_FAILED',
  )
  if (parseJSONRows(foreign.stdout, 'SQLITE_FOREIGN_KEY_RECEIPT_INVALID').length !== 0) {
    throw new HarnessError('SQLITE_FOREIGN_KEY_FAILED')
  }
  const selected = await runCommand(
    SQLITE_BINARY,
    [
      '-readonly',
      '-json',
      runtime.store,
      `PRAGMA query_only=ON;
SELECT id,session_id,role,request_id,length(CAST(content AS BLOB)) AS content_bytes,
json_extract(metadata,'$.provider') AS provider,
json_extract(metadata,'$.model') AS model,
json_extract(metadata,'$.persist_error') AS persist_error,
json_extract(metadata,'$.reasoning_receipt.version') AS receipt_version,
json_extract(metadata,'$.reasoning_receipt.reasoning_request') AS receipt_request,
json_extract(metadata,'$.reasoning_receipt.reasoning_support') AS receipt_support,
json_extract(metadata,'$.reasoning_receipt.reasoning_execution') AS receipt_execution,
json_extract(metadata,'$.assistant_message_id') AS assistant_message_id,
json_extract(metadata,'$.backend_message_id') AS backend_message_id,
json_extract(metadata,'$.message_id') AS message_id
FROM messages ORDER BY created_at ASC,id ASC;`,
    ],
    commandOptions,
    'SQLITE_MESSAGE_READ_FAILED',
  )
  const allRows = parseJSONRows(selected.stdout, 'SQLITE_MESSAGE_RECEIPT_INVALID')
  const rows = allRows.filter((row) => row?.session_id === sessionID)
  if (allRows.length !== rows.length) throw new HarnessError('SQLITE_UNEXPECTED_SESSION_MESSAGES')
  return {
    integrity_check: 'ok',
    foreign_key_violations: 0,
    query_only: true,
    ...projectSQLiteRows(rows, assistantMessageID, requestID, sessionID),
  }
}

async function cleanupFixture(runtime, deadlineAt) {
  const cleaned = await runCommand(
    runtime.fixtureBinary,
    [
      'cleanup',
      '--profile',
      runtime.profileRoot,
      '--store',
      runtime.store,
      '--manifest',
      runtime.manifest,
    ],
    {
      cwd: runtime.profileRoot,
      env: runtime.toolEnvironment,
      timeoutMs: remainingBudget(deadlineAt, 90_000, 'FIXTURE_CLEANUP_BUDGET_EXHAUSTED'),
    },
    'FIXTURE_CLEANUP_FAILED',
  )
  const receipt = parseJSONReceipt(cleaned.stdout, 'FIXTURE_CLEANUP_RECEIPT_INVALID')
  if (
    receipt?.status !== 'cleaned' ||
    receipt?.remaining !== 0 ||
    !Number.isInteger(receipt?.cleaned) ||
    receipt.cleaned < 0
  ) {
    throw new HarnessError('FIXTURE_CLEANUP_RECEIPT_INVALID')
  }
  return {
    status: receipt.status,
    cleaned: receipt.cleaned,
    remaining: receipt.remaining,
    already_cleaned: receipt.already_cleaned === true,
  }
}

async function writeEvidence(evidenceDirectory, evidence) {
  assertEvidenceSafe(evidence)
  await mkdir(evidenceDirectory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
  const filename = `k12-source-sol-headless-${Date.now()}-${randomBytes(4).toString('hex')}.json`
  await createPrivateFile(
    join(evidenceDirectory, filename),
    `${JSON.stringify(evidence, null, 2)}\n`,
  )
  return filename
}

function failureEvidence(error) {
  const result = { code: safeFailureCode(error) }
  if (/^[a-f0-9]{64}$/.test(error?.diagnosticSHA256 ?? '')) {
    result.diagnostic_sha256 = error.diagnosticSHA256
  }
  const historyDiagnostics = error?.responseHistoryDiagnostics
  if (
    result.code === 'RESPONSE_HISTORY_MISMATCH' &&
    historyDiagnostics &&
    typeof historyDiagnostics === 'object' &&
    !Array.isArray(historyDiagnostics) &&
    Number.isSafeInteger(historyDiagnostics.response_bytes) &&
    historyDiagnostics.response_bytes >= 0 &&
    Number.isSafeInteger(historyDiagnostics.history_bytes) &&
    historyDiagnostics.history_bytes >= 0 &&
    /^[a-f0-9]{64}$/.test(historyDiagnostics.response_sha256 ?? '') &&
    /^[a-f0-9]{64}$/.test(historyDiagnostics.history_sha256 ?? '') &&
    /^[a-f0-9]{64}$/.test(historyDiagnostics.response_normalized_sha256 ?? '') &&
    /^[a-f0-9]{64}$/.test(historyDiagnostics.history_normalized_sha256 ?? '')
  ) {
    result.response_history_diagnostics = {
      response_bytes: historyDiagnostics.response_bytes,
      history_bytes: historyDiagnostics.history_bytes,
      response_sha256: historyDiagnostics.response_sha256,
      history_sha256: historyDiagnostics.history_sha256,
      response_normalized_sha256: historyDiagnostics.response_normalized_sha256,
      history_normalized_sha256: historyDiagnostics.history_normalized_sha256,
    }
  }
  if (error?.fixtureReceiptActual) {
    result.fixture_receipt_actual = error.fixtureReceiptActual
  }
  return result
}

async function runLive(env = process.env) {
  const deadlineAt = Date.now() + LIVE_BUDGET_MS
  const paths = livePaths(env)
  const evidence = newEvidenceSkeleton()
  let ownedRoot
  let runtime
  let activeSidecar
  let fixtureCleaned = false
  let failure

  try {
    ownedRoot = await createPrivateRunRoot()
    const port = await reserveLoopbackPort()
    const baseURL = `http://127.0.0.1:${port}`
    runtime = await prepareIsolatedRuntime(paths, ownedRoot, port, deadlineAt, env)
    evidence.provenance = runtime.evidence

    const firstCapability = randomBytes(32).toString('hex')
    activeSidecar = startSidecar(runtime, firstCapability, env)
    await waitForSidecar(baseURL, activeSidecar, deadlineAt)

    await requestJSON(baseURL, '/api/v1/agents', {
      expectedStatus: 401,
      parse: false,
      failureCode: 'ANONYMOUS_AUTH_BOUNDARY_FAILED',
    })
    const config = await requestJSON(baseURL, '/api/v1/config/llm', {
      capability: firstCapability,
      expectedStatus: 200,
      failureCode: 'CONFIG_PROJECTION_FAILED',
    })
    evidence.catalog = assertExactProviderConfig(config.value)
    const agents = await requestJSON(baseURL, '/api/v1/agents', {
      capability: firstCapability,
      expectedStatus: 200,
      failureCode: 'AGENT_PROJECTION_FAILED',
    })
    evidence.pinned_agent = assertAgentRoute(agents.value, runtime.agentName)

    const warmupStatus = await activeSidecar.collector.waitForWarmup(
      remainingBudget(deadlineAt, WARMUP_TIMEOUT_MS, 'WARMUP_BUDGET_EXHAUSTED'),
    )
    if (warmupStatus === 'unobserved_timeout') throw new HarnessError('WARMUP_TERMINAL_UNOBSERVED')
    evidence.startup_warmup.status = warmupStatus
    evidence.startup_warmup.may_call_provider = warmupStatus !== 'skipped_non_local'

    const requestID = `req-${randomUUID()}`
    const request = buildChatRequest(
      runtime.agentName,
      requestID,
      randomInt(21, 90),
      randomInt(12, 70),
    )
    evidence.execution.explicit_user_post_count = 1
    const chat = await requestJSON(baseURL, '/api/v1/chat', {
      method: 'POST',
      capability: firstCapability,
      payload: request,
      expectedStatus: 200,
      timeoutMs: remainingBudget(deadlineAt, CHAT_TIMEOUT_MS, 'CHAT_BUDGET_EXHAUSTED'),
      failureCode: 'CHAT_REQUEST_FAILED',
    })
    const response = chat.value
    evidence.chat = assertChatResponse(response, requestID)
    evidence.history = await pollHistory(
      baseURL,
      firstCapability,
      response.session_id,
      response,
      requestID,
    )
    evidence.reasoning.public_receipt = evidence.history.reasoning

    evidence.first_process_log = await stopSidecar(activeSidecar)
    activeSidecar = null
    await waitForPortReleased(port)
    await assertLockAbsent(runtime.lock)
    evidence.sqlite_before_restart = await readSQLiteEvidence(
      runtime,
      response.session_id,
      response.assistant_message_id,
      requestID,
      deadlineAt,
    )

    const secondCapability = randomBytes(32).toString('hex')
    if (secondCapability === firstCapability) throw new HarnessError('CAPABILITY_ROTATION_FAILED')
    activeSidecar = startSidecar(runtime, secondCapability, env)
    await waitForSidecar(baseURL, activeSidecar, deadlineAt)
    await requestJSON(baseURL, '/api/v1/agents', {
      capability: firstCapability,
      expectedStatus: 401,
      parse: false,
      failureCode: 'OLD_CAPABILITY_NOT_REJECTED',
    })
    const restartedConfig = await requestJSON(baseURL, '/api/v1/config/llm', {
      capability: secondCapability,
      expectedStatus: 200,
      failureCode: 'RESTART_CONFIG_PROJECTION_FAILED',
    })
    assert.deepEqual(assertExactProviderConfig(restartedConfig.value), evidence.catalog)
    const restartedAgents = await requestJSON(baseURL, '/api/v1/agents', {
      capability: secondCapability,
      expectedStatus: 200,
      failureCode: 'RESTART_AGENT_PROJECTION_FAILED',
    })
    assert.deepEqual(
      assertAgentRoute(restartedAgents.value, runtime.agentName),
      evidence.pinned_agent,
    )
    const restartWarmupStatus = await activeSidecar.collector.waitForWarmup(
      remainingBudget(deadlineAt, WARMUP_TIMEOUT_MS, 'RESTART_WARMUP_BUDGET_EXHAUSTED'),
    )
    if (restartWarmupStatus === 'unobserved_timeout') {
      throw new HarnessError('RESTART_WARMUP_TERMINAL_UNOBSERVED')
    }
    const restartHistory = await pollHistory(
      baseURL,
      secondCapability,
      response.session_id,
      response,
      requestID,
    )
    assert.deepEqual(restartHistory, evidence.history)
    evidence.restart = {
      capability_rotated: true,
      old_capability_rejected: true,
      explicit_user_post_count: 0,
      history_recovered: true,
      startup_warmup: {
        status: restartWarmupStatus,
        may_call_provider: restartWarmupStatus !== 'skipped_non_local',
        counted_as_explicit_user_post: false,
      },
      history: restartHistory,
    }

    evidence.second_process_log = await stopSidecar(activeSidecar)
    activeSidecar = null
    await waitForPortReleased(port)
    await assertLockAbsent(runtime.lock)
    evidence.sqlite_after_restart = await readSQLiteEvidence(
      runtime,
      response.session_id,
      response.assistant_message_id,
      requestID,
      deadlineAt,
    )
    assert.deepEqual(evidence.sqlite_after_restart, evidence.sqlite_before_restart)
    evidence.cleanup = {
      fixture: await cleanupFixture(runtime, deadlineAt),
      port_released: true,
      lock_released: true,
      temporary_profile_removed: false,
    }
    fixtureCleaned = true
    evidence.status = 'passed'
  } catch (error) {
    failure = error
    evidence.status = 'failed'
    evidence.failure = failureEvidence(error)
  } finally {
    if (activeSidecar) {
      try {
        evidence.cleanup_log = await stopSidecar(activeSidecar)
      } catch (error) {
        evidence.cleanup_stop_failure = failureEvidence(error)
        failure ??= error
        evidence.status = 'failed'
      }
    }
    if (runtime && !fixtureCleaned) {
      try {
        await assertLockAbsent(runtime.lock)
        evidence.fixture_cleanup_after_failure = await cleanupFixture(runtime, deadlineAt)
        fixtureCleaned = true
      } catch (error) {
        evidence.fixture_cleanup_failure = failureEvidence(error)
        failure ??= error
        evidence.status = 'failed'
      }
    }
    if (ownedRoot) {
      try {
        await removePrivateRunRoot(ownedRoot.root, ownedRoot.canonicalTmp)
        evidence.cleanup ??= {}
        evidence.cleanup.temporary_profile_removed = true
      } catch (error) {
        evidence.temporary_cleanup_failure = failureEvidence(error)
        evidence.temporary_root_id = basename(ownedRoot.root)
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
    evidence_file: evidenceFile,
    provider: EXPECTED_PROVIDER,
    model: EXPECTED_MODEL,
    explicit_user_post_count: 1,
    restart_explicit_user_post_count: 0,
    physical_provider_call_count_observable: false,
    reasoning_effort_application_observable: false,
  }
  assertEvidenceSafe(receipt)
  return receipt
}

async function runSelfTests() {
  assert.equal(liveGateAllowsRun({}), false)
  assert.equal(liveGateAllowsRun({ HEXCLAW_SOURCE_SOL_LIVE: '0' }), false)
  assert.equal(liveGateAllowsRun({ HEXCLAW_SOURCE_SOL_LIVE: '1' }), true)

  assert.deepEqual(
    projectReasoningContract({
      model_specs: [
        {
          id: 'gpt-5.6-sol',
          reasoning_support: 'supported',
          reasoning_control: {
            dialect: 'reasoning_effort',
            on: 'low',
            off: 'none',
            allowed_efforts: ['low'],
          },
        },
      ],
    }),
    {
      support: 'supported',
      dialect: 'reasoning_effort',
      low_available: true,
    },
  )
  for (const invalidControl of [
    { dialect: 'think', on: true, off: false, allowed_efforts: ['low'] },
    { dialect: 'reasoning_effort', on: 'high', off: 'none', allowed_efforts: ['low'] },
    { dialect: 'reasoning_effort', on: 'low', off: false, allowed_efforts: ['low'] },
    {
      dialect: 'reasoning_effort',
      on: 'low',
      off: 'none',
      allowed_efforts: ['low', 'medium'],
    },
    { dialect: 'reasoning_effort', on: 'low', off: 'none', allowed_efforts: ['low', 'low'] },
  ]) {
    assert.throws(
      () =>
        projectReasoningContract({
          model_specs: [
            {
              id: 'gpt-5.6-sol',
              reasoning_support: 'supported',
              reasoning_control: invalidControl,
            },
          ],
        }),
      /reasoning low not declared/i,
    )
  }
  for (const invalidSupport of ['unknown', 'unsupported']) {
    assert.throws(
      () =>
        projectReasoningContract({
          model_specs: [
            {
              id: 'gpt-5.6-sol',
              reasoning_support: invalidSupport,
              reasoning_control: {
                dialect: 'reasoning_effort',
                on: 'low',
                off: 'none',
                allowed_efforts: ['low'],
              },
            },
          ],
        }),
      /reasoning low not declared/i,
    )
  }

  assert.deepEqual(
    projectReasoningReceipt({
      version: 1,
      reasoning_request: 'on',
      reasoning_support: 'supported',
      reasoning_execution: 'applied',
    }),
    {
      version: 1,
      request: 'on',
      support: 'supported',
      execution: 'applied',
      effort_application_observable: false,
    },
  )

  assert.throws(() => assertEvidenceSafe({ token: 'secret', result: 'ok' }), /unsafe evidence/i)
  assert.throws(
    () => assertEvidenceSafe({ result: '/Users/private/work/reply.txt' }),
    /unsafe evidence/i,
  )
  assert.doesNotThrow(() =>
    assertEvidenceSafe({
      route: { provider: 'hexclaw-gpt', model: 'gpt-5.6-sol' },
      content_sha256: 'a'.repeat(64),
      explicit_user_post_count: 1,
    }),
  )

  if (typeof parseFixtureStartReceipt !== 'function') {
    throw new HarnessError('FIXTURE_RECEIPT_STREAM_PARSER_UNAVAILABLE')
  }
  const fixtureLog = JSON.stringify({
    level: 'INFO',
    msg: 'migration applied',
    time: 'safe-time',
  })
  const fixtureTerminal = JSON.stringify({
    status: 'started',
    created: 2,
    boundary_calls: { model_calls: 0, dingtalk_sends: 0, im_sends: 0 },
  })
  const fixtureStream = `${fixtureLog}\n${fixtureTerminal}\n`
  const parsedFixture = parseFixtureStartReceipt(fixtureStream)
  assert.deepEqual(parsedFixture.receipt, {
    status: 'started',
    created: 2,
    boundary_calls: { model: 0, dingtalk: 0, im: 0 },
  })
  assert.deepEqual(parsedFixture.output, {
    stdout_line_count: 2,
    parsed_object_count: 2,
    structured_log_count: 1,
    output_sha256: sha256Text(fixtureStream),
  })
  assert.doesNotThrow(() => assertEvidenceSafe(parsedFixture))

  let createdMismatch
  try {
    parseFixtureStartReceipt(
      `${fixtureLog}\n${JSON.stringify({
        status: 'started',
        created: 3,
        boundary_calls: { model_calls: 0, dingtalk_sends: 0, im_sends: 0 },
      })}\n`,
    )
  } catch (error) {
    createdMismatch = error
  }
  assert.equal(createdMismatch?.code, 'FIXTURE_RECEIPT_CREATED_INVALID')
  assert.equal(createdMismatch?.fixtureReceiptActual?.terminal_receipt?.created_value, 3)
  assert.doesNotThrow(() => assertEvidenceSafe(failureEvidence(createdMismatch)))

  let externalCall
  try {
    parseFixtureStartReceipt(
      `${fixtureLog}\n${JSON.stringify({
        status: 'started',
        created: 2,
        boundary_calls: { model_calls: 1, dingtalk_sends: 0, im_sends: 0 },
      })}\n`,
    )
  } catch (error) {
    externalCall = error
  }
  assert.equal(externalCall?.code, 'FIXTURE_EXTERNAL_CALLS_OBSERVED')
  assert.equal(externalCall?.fixtureReceiptActual?.terminal_receipt?.model_calls_value, 1)
  assert.doesNotThrow(() => assertEvidenceSafe(failureEvidence(externalCall)))

  let malformedLine
  try {
    parseFixtureStartReceipt(`${fixtureLog}\nnot-json\n${fixtureTerminal}\n`)
  } catch (error) {
    malformedLine = error
  }
  assert.equal(malformedLine?.code, 'FIXTURE_RECEIPT_LINE_INVALID_JSON')
  assert.equal(malformedLine?.fixtureReceiptActual?.invalid_line_number, 2)
  assert.doesNotThrow(() => assertEvidenceSafe(failureEvidence(malformedLine)))

  assert.equal(resolveMode([]), 'validate')
  assert.equal(resolveMode(['validate']), 'validate')
  assert.equal(resolveMode(['run']), 'run')
  assert.throws(() => resolveMode(['run', 'extra']), /invalid arguments/i)

  const exactProvider = assertExactProviderConfig({
    default: EXPECTED_PROVIDER,
    reasoning_provider: EXPECTED_PROVIDER,
    reasoning_model: EXPECTED_MODEL,
    providers: {
      [EXPECTED_PROVIDER]: {
        credential_present: true,
        model: EXPECTED_MODEL,
        models: [EXPECTED_MODEL],
        model_specs_mode: 'explicit',
        model_specs: [
          {
            id: EXPECTED_MODEL,
            capabilities: ['text'],
            reasoning_support: 'supported',
            reasoning_control: {
              dialect: 'reasoning_effort',
              on: 'low',
              off: 'none',
              allowed_efforts: ['low'],
            },
          },
        ],
      },
    },
  })
  assert.deepEqual(exactProvider.reasoning, {
    support: 'supported',
    dialect: 'reasoning_effort',
    low_available: true,
  })

  const response = {
    reply: 'answer',
    session_id: 'sess-safe',
    assistant_message_id: 'msg-safe',
    backend_message_id: 'msg-safe',
    message_id: 'msg-safe',
    metadata: {
      provider: EXPECTED_PROVIDER,
      model: EXPECTED_MODEL,
      request_id: 'req-safe',
      assistant_message_id: 'msg-safe',
      backend_message_id: 'msg-safe',
      message_id: 'msg-safe',
    },
    usage: {
      input_tokens: 12,
      output_tokens: 6,
      total_tokens: 18,
      provider: EXPECTED_PROVIDER,
      model: EXPECTED_MODEL,
    },
  }
  const responseEvidence = assertChatResponse(response, 'req-safe')
  assert.equal(responseEvidence.provider, EXPECTED_PROVIDER)
  assert.equal(responseEvidence.usage_total_tokens_positive, true)

  const agentEvidence = assertAgentRoute(
    {
      agents: [{ name: 'k12-tutor-safe', provider: EXPECTED_PROVIDER, model: EXPECTED_MODEL }],
    },
    'k12-tutor-safe',
  )
  assert.equal(agentEvidence.exact_match_count, 1)

  const history = projectHistoryEvidence(
    [
      {
        id: 'req-safe',
        role: 'user',
        content: 'question',
        request_id: 'req-safe',
        session_id: 'sess-safe',
      },
      {
        id: 'msg-safe',
        role: 'assistant',
        content: 'answer',
        request_id: 'req-safe',
        session_id: 'sess-safe',
        metadata: JSON.stringify({
          provider: EXPECTED_PROVIDER,
          model: EXPECTED_MODEL,
          assistant_message_id: 'msg-safe',
          backend_message_id: 'msg-safe',
          message_id: 'msg-safe',
          reasoning_receipt: {
            version: 1,
            reasoning_request: 'on',
            reasoning_support: 'supported',
            reasoning_execution: 'applied',
          },
        }),
      },
    ],
    response,
    'req-safe',
  )
  assert.equal(history.user_count, 1)
  assert.equal(history.assistant_count, 1)
  assert.equal(history.response_content_match, true)
  assert.equal(history.reasoning.effort_application_observable, false)
  assert.equal(history.assistant_id_sha256, sha256Text('msg-safe'))

  let historyMismatch
  try {
    projectHistoryEvidence(
      [
        {
          id: 'req-safe',
          role: 'user',
          content: 'question',
          request_id: 'req-safe',
          session_id: 'sess-safe',
        },
        {
          id: 'msg-safe',
          role: 'assistant',
          content: 'answer\n',
          request_id: 'req-safe',
          session_id: 'sess-safe',
          metadata: JSON.stringify({
            provider: EXPECTED_PROVIDER,
            model: EXPECTED_MODEL,
            assistant_message_id: 'msg-safe',
            backend_message_id: 'msg-safe',
            message_id: 'msg-safe',
            reasoning_receipt: {
              version: 1,
              reasoning_request: 'on',
              reasoning_support: 'supported',
              reasoning_execution: 'applied',
            },
          }),
        },
      ],
      { ...response, reply: 'answer\r\n' },
      'req-safe',
    )
  } catch (error) {
    historyMismatch = error
  }
  assert.equal(historyMismatch?.code, 'RESPONSE_HISTORY_MISMATCH')
  historyMismatch.responseHistoryDiagnostics.reply = 'must-not-leak'
  historyMismatch.responseHistoryDiagnostics.path = '/must/not/leak'
  assert.deepEqual(failureEvidence(historyMismatch), {
    code: 'RESPONSE_HISTORY_MISMATCH',
    response_history_diagnostics: {
      response_bytes: Buffer.byteLength('answer\r\n'),
      history_bytes: Buffer.byteLength('answer\n'),
      response_sha256: sha256Text('answer\r\n'),
      history_sha256: sha256Text('answer\n'),
      response_normalized_sha256: sha256Text('answer'),
      history_normalized_sha256: sha256Text('answer'),
    },
  })
  assert.doesNotThrow(() => assertEvidenceSafe(failureEvidence(historyMismatch)))

  assert.equal(isOwnedTemporaryRoot('/private/tmp/hexclaw-source-sol-safe', '/private/tmp'), true)
  assert.equal(isOwnedTemporaryRoot('/private/tmp/not-owned', '/private/tmp'), false)
  assert.equal(
    isOwnedTemporaryRoot('/Users/private/tmp/hexclaw-source-sol-safe', '/private/tmp'),
    false,
  )

  const runEvidence = newEvidenceSkeleton()
  assert.equal(runEvidence.execution.explicit_user_post_count, 0)
  assert.equal(runEvidence.execution.physical_provider_call_count_observable, false)
  assert.equal(runEvidence.reasoning.effort_application_observable, false)
  assert.doesNotThrow(() => assertEvidenceSafe(runEvidence))

  let authorizedCalls = 0
  await assert.rejects(
    () =>
      runAuthorized({}, async () => {
        authorizedCalls += 1
      }),
    /live gate required/i,
  )
  assert.equal(authorizedCalls, 0)
  assert.equal(
    await runAuthorized({ HEXCLAW_SOURCE_SOL_LIVE: '1' }, async () => {
      authorizedCalls += 1
      return 'ran'
    }),
    'ran',
  )
  assert.equal(authorizedCalls, 1)

  const chatRequest = buildChatRequest('k12-tutor-safe', 'req-safe', 27, 34)
  assert.equal(Object.hasOwn(chatRequest, 'provider'), false)
  assert.equal(Object.hasOwn(chatRequest, 'model'), false)
  assert.equal(chatRequest.metadata.pinned_agent, 'k12-tutor-safe')
  assert.equal(chatRequest.metadata.thinking, 'on')
  assert.equal(chatRequest.metadata.thinking_effort, 'low')

  const collector = new LogEvidenceCollector()
  collector.ingest('stdout', Buffer.from('[warmup] 本地默认模型预热完成\n'))
  collector.ingest('stderr', Buffer.from('database is locked (5) (SQLITE_BUSY)\n'))
  const logEvidence = collector.snapshot()
  assert.equal(logEvidence.warmup_status, 'completed')
  assert.equal(logEvidence.flags.sqlite_busy, true)
  assert.equal(Object.hasOwn(logEvidence, 'raw'), false)
  assert.match(logEvidence.sha256, /^[a-f0-9]{64}$/)

  const sqliteEvidence = projectSQLiteRows(
    [
      {
        id: 'req-safe',
        role: 'user',
        request_id: 'req-safe',
        session_id: 'sess-safe',
        content_bytes: 8,
        provider: null,
        model: null,
        persist_error: null,
        receipt_version: null,
        receipt_request: null,
        receipt_support: null,
        receipt_execution: null,
        assistant_message_id: null,
        backend_message_id: null,
        message_id: null,
      },
      {
        id: 'msg-safe',
        role: 'assistant',
        request_id: 'req-safe',
        session_id: 'sess-safe',
        content_bytes: 6,
        provider: EXPECTED_PROVIDER,
        model: EXPECTED_MODEL,
        persist_error: null,
        receipt_version: 1,
        receipt_request: 'on',
        receipt_support: 'supported',
        receipt_execution: 'applied',
        assistant_message_id: 'msg-safe',
        backend_message_id: 'msg-safe',
        message_id: 'msg-safe',
      },
    ],
    'msg-safe',
    'req-safe',
    'sess-safe',
  )
  assert.equal(sqliteEvidence.row_count, 2)
  assert.equal(sqliteEvidence.assistant_id_match, true)
  assert.equal(sqliteEvidence.provider, EXPECTED_PROVIDER)
  assert.doesNotThrow(() => assertEvidenceSafe(sqliteEvidence))

  assert.deepEqual(parseJSONRows('', 'ROWS_INVALID'), [])
  assert.deepEqual(parseJSONRows('[{"safe":true}]', 'ROWS_INVALID'), [{ safe: true }])
  assert.deepEqual(failureEvidence(new HarnessError('SAFE_FAILURE')), { code: 'SAFE_FAILURE' })

  if (typeof materializeSidecarBinary !== 'function') {
    throw new HarnessError('SIDECAR_BINARY_INJECTION_UNAVAILABLE')
  }
  const injectedRoot = await createPrivateRunRoot()
  try {
    const input = join(injectedRoot.root, 'installed-sidecar')
    const binaryDirectory = join(injectedRoot.root, 'bin')
    const output = join(binaryDirectory, 'hexclaw')
    await mkdir(binaryDirectory, { mode: PRIVATE_DIRECTORY_MODE })
    await createPrivateFile(input, 'installed-sidecar-bytes')
    let sidecarBuildCalls = 0
    await assert.rejects(
      () =>
        materializeSidecarBinary({
          env: { HEXCLAW_SIDECAR_BINARY: input },
          sourceRoot: '/source',
          goBinary: '/go',
          sidecarBinary: output,
          toolEnvironment: {},
          deadlineAt: Date.now() + 10_000,
          runCommandFn: async () => {
            sidecarBuildCalls += 1
          },
        }),
      /sidecar binary input invalid/i,
    )
    assert.equal(sidecarBuildCalls, 0)

    await chmod(input, 0o700)
    const inputSHA256 = await sha256File(input)
    const injected = await materializeSidecarBinary({
      env: { HEXCLAW_SIDECAR_BINARY: input },
      sourceRoot: '/source',
      goBinary: '/go',
      sidecarBinary: output,
      toolEnvironment: {},
      deadlineAt: Date.now() + 10_000,
      runCommandFn: async () => {
        sidecarBuildCalls += 1
      },
    })
    assert.equal(sidecarBuildCalls, 0)
    assert.deepEqual(injected, {
      sidecar_source: 'injected_binary',
      sidecar_input_sha256: inputSHA256,
      sidecar_sha256: inputSHA256,
      sidecar_input_matches_runtime: true,
    })
    assert.equal(await readFile(output, 'utf8'), 'installed-sidecar-bytes')
    assert.equal((await stat(output)).mode & 0o777, 0o700)
    assert.doesNotThrow(() => assertEvidenceSafe(injected))
  } finally {
    await removePrivateRunRoot(injectedRoot.root, injectedRoot.canonicalTmp)
  }

  const builtRoot = await createPrivateRunRoot()
  try {
    const binaryDirectory = join(builtRoot.root, 'bin')
    const output = join(binaryDirectory, 'hexclaw')
    await mkdir(binaryDirectory, { mode: PRIVATE_DIRECTORY_MODE })
    const buildCalls = []
    const built = await materializeSidecarBinary({
      env: {},
      sourceRoot: '/source',
      goBinary: '/go',
      sidecarBinary: output,
      toolEnvironment: {},
      deadlineAt: Date.now() + 10_000,
      runCommandFn: async (command, args) => {
        buildCalls.push({ command, args })
        await createPrivateFile(output, 'go-built-sidecar')
        await chmod(output, 0o700)
      },
    })
    assert.deepEqual(buildCalls, [
      {
        command: '/go',
        args: ['build', '-trimpath', '-o', output, './cmd/hexclaw'],
      },
    ])
    assert.equal(built.sidecar_source, 'go_build')
    assert.equal(built.sidecar_input_sha256, null)
    assert.equal(built.sidecar_input_matches_runtime, null)
    assert.equal(built.sidecar_sha256, await sha256File(output))
  } finally {
    await removePrivateRunRoot(builtRoot.root, builtRoot.canonicalTmp)
  }

  let dispatchedLiveRuns = 0
  const validation = await dispatchMode(
    'validate',
    {},
    {
      validate: async () => ({ status: 'validated' }),
      run: async () => {
        dispatchedLiveRuns += 1
      },
    },
  )
  assert.deepEqual(validation, { status: 'validated' })
  assert.equal(dispatchedLiveRuns, 0)
  await assert.rejects(
    () =>
      dispatchMode(
        'run',
        {},
        {
          validate: async () => ({ status: 'validated' }),
          run: async () => {
            dispatchedLiveRuns += 1
          },
        },
      ),
    /live gate required/i,
  )
  assert.equal(dispatchedLiveRuns, 0)
}

async function main() {
  const mode = resolveMode(process.argv.slice(2))
  const receipt = await dispatchMode(mode, process.env, {
    validate: async () => await staticValidation(process.env),
    run: async () => {
      await staticValidation(process.env)
      return await runLive(process.env)
    },
  })
  assertEvidenceSafe(receipt)
  process.stdout.write(`${JSON.stringify(receipt)}\n`)
}

try {
  await main()
} catch (error) {
  const receipt = {
    status: 'failed',
    error_code: safeFailureCode(error),
  }
  if (typeof error?.evidenceFile === 'string') receipt.evidence_file = basename(error.evidenceFile)
  assertEvidenceSafe(receipt)
  process.stderr.write(`${JSON.stringify(receipt)}\n`)
  process.exitCode = 1
}
