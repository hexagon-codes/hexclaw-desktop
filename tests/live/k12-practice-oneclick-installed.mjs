#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const LIVE_ROOT = dirname(SCRIPT_PATH)
const CONTRACT_PATH = resolve(LIVE_ROOT, 'k12-practice-oneclick-installed.contract.json')
const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
const DEFAULT_PHASE_MS = 8 * 60_000
const HARD_PHASE_MAX_MS = 29 * 60_000 - 1
const REQUEST_TIMEOUT_MS = 30_000
const START_TIMEOUT_MS = 60_000
const TERMINAL_TIMEOUT_MS = 60_000
const SHA256 = /^[a-f0-9]{64}$/u
const CANDIDATE_FIELD = /(?:candidate|selection)/iu
const CONTROLLED_PROVIDER = 'practice-fixture'
const CONTROLLED_MODEL = 'fixture-practice-failure'

export const PHASES = Object.freeze(['validate', 'run'])

class HarnessError extends Error {
  constructor(code) {
    super(code)
    this.name = 'HarnessError'
    this.code = code
  }
}

function fail(code) {
  throw new HarnessError(code)
}

function object(value, code = 'CONTRACT_INVALID') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code)
  return value
}

function nonEmpty(value, code) {
  if (typeof value !== 'string' || value.trim() === '') fail(code)
  return value.trim()
}

function exactArray(value, expected, code = 'CONTRACT_INVALID') {
  if (!Array.isArray(value) || canonicalJSON(value) !== canonicalJSON(expected)) fail(code)
}

function exactObject(value, expected, code = 'CONTRACT_INVALID') {
  if (canonicalJSON(value) !== canonicalJSON(expected)) fail(code)
}

function canonicalJSON(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256Text(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex')
}

function exactSetDigest(values) {
  return sha256Text(canonicalJSON([...new Set(values)].sort()))
}

async function sha256File(pathname) {
  const hash = createHash('sha256')
  await new Promise((resolveStream, rejectStream) => {
    const stream = createReadStream(pathname)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.once('error', rejectStream)
    stream.once('end', resolveStream)
  })
  return hash.digest('hex')
}

function safeCode(error) {
  return error instanceof HarnessError && /^[A-Z0-9_]+$/u.test(error.code)
    ? error.code
    : 'UNEXPECTED_FAILURE'
}

export function resolvePhase(args) {
  if (!Array.isArray(args) || args.length === 0) return 'validate'
  if (args.length !== 1 || !PHASES.includes(args[0])) fail('INVALID_PHASE')
  return args[0]
}

export function phaseBudgetMilliseconds(env = process.env) {
  const requested = Number.parseInt(env.HEXCLAW_PRACTICE_ONECLICK_PHASE_TIMEOUT_MS ?? '', 10)
  if (!Number.isFinite(requested) || requested <= 0) return DEFAULT_PHASE_MS
  return Math.min(requested, HARD_PHASE_MAX_MS)
}

export function validateContract(contract) {
  const root = object(contract)
  if (root.schema_version !== 1) fail('CONTRACT_INVALID')
  exactArray(root.phases, PHASES)

  const transport = object(root.transport)
  const expectedTransport = {
    candidate: 'installed_app_sidecar',
    product_operations: 'hexclaw_public_http_api_only',
    direct_store_read: false,
    sqlite_seed_or_write: false,
    ui_automation: false,
    real_model: false,
    controlled_loopback_provider: true,
  }
  exactObject(transport, expectedTransport)

  const publicAPI = object(root.public_api)
  const expectedPaths = {
    agents: '/api/v1/agents',
    record_mistake: '/api/k12/record-mistake',
    mistake_projection: '/api/k12/mistakes/{record_id}/practice-generation',
    start_mistake_generation: '/api/k12/mistakes/{record_id}/practice-generation',
    create_accumulation: '/api/k12/accumulation',
    accumulation_projection: '/api/k12/accumulation/{record_id}',
    start_accumulation_generation: '/api/k12/accumulation/{record_id}/dictation-to-basket',
    practice_sets: '/api/k12/practice-sets',
  }
  exactObject(publicAPI, expectedPaths)

  const stateMachine = object(root.state_machine)
  const expectedStateMachine = {
    initial: 'available',
    admitted: 'pending',
    terminals: ['joined', 'failed'],
    exercised_terminal: 'failed',
  }
  exactObject(stateMachine, expectedStateMachine)
  const accumulationStateMachine = object(root.accumulation_state_machine)
  const expectedAccumulationStateMachine = {
    admitted: 'queued',
    terminals: ['committed', 'failed'],
    exercised_terminal: 'committed',
  }
  exactObject(accumulationStateMachine, expectedAccumulationStateMachine)

  const identity = object(root.identity)
  const expectedIdentity = {
    generation_field: 'generation_job_id',
    item_field: 'practice_item_id',
    one_generation_per_source_version: true,
    one_item_identity_per_generation: true,
    repeat_action_reuses_identity: true,
    restart_get_only: true,
  }
  exactObject(identity, expectedIdentity)

  const candidateSelection = object(root.candidate_selection)
  const expectedCandidateSelection = {
    endpoint_calls: 0,
    response_fields: 0,
    second_commit_action: false,
  }
  exactObject(candidateSelection, expectedCandidateSelection)

  const provider = object(root.controlled_provider)
  exactObject(provider, {
    protocol: 'openai_compatible_loopback',
    model: CONTROLLED_MODEL,
    classification_response_status: 200,
    generation_response_status: 503,
    maximum_operation_requests: 2,
    external_network: false,
  })
  const restart = object(root.restart)
  exactObject(restart, {
    product_methods: ['GET'],
    rotate_capability: true,
    old_capability_status: 401,
  })
  const validateSideEffects = object(root.validate_side_effects)
  exactObject(validateSideEffects, {
    sidecar_starts: 0,
    provider_requests: 0,
    product_mutations: 0,
  })

  return {
    schema_version: 1,
    phases: [...PHASES],
    transport: expectedTransport,
    public_api: expectedPaths,
    state_machine: expectedStateMachine,
    accumulation_state_machine: expectedAccumulationStateMachine,
    identity: expectedIdentity,
    candidate_selection: expectedCandidateSelection,
    controlled_provider: provider,
    restart,
    validate_side_effects: validateSideEffects,
  }
}

function assertNoCandidateFields(value) {
  const candidateKeys = Object.keys(object(value, 'PROJECTION_INVALID')).filter((key) =>
    CANDIDATE_FIELD.test(key),
  )
  if (candidateKeys.length !== 0) fail('CANDIDATE_SELECTION_SURFACED')
}

export function assertPracticeProjection(value, expectedState) {
  const projection = object(value, 'PROJECTION_INVALID')
  assertNoCandidateFields(projection)
  if (projection.state !== expectedState) fail('PRACTICE_STATE_INVALID')
  const sourceID = nonEmpty(projection.source_mistake_id, 'PRACTICE_SOURCE_INVALID')
  const generationID =
    typeof projection.generation_job_id === 'string' ? projection.generation_job_id.trim() : ''
  const itemID =
    typeof projection.practice_item_id === 'string' ? projection.practice_item_id.trim() : ''
  if (expectedState === 'available') {
    if (generationID !== '' || itemID !== '') fail('PRACTICE_AVAILABLE_IDENTITY_INVALID')
  } else if (generationID === '' || itemID === '') {
    fail('PRACTICE_IDENTITY_MISSING')
  }
  if (projection.item !== undefined) {
    const item = object(projection.item, 'PRACTICE_ITEM_INVALID')
    if (nonEmpty(item.item_id, 'PRACTICE_ITEM_INVALID') !== itemID) {
      fail('PRACTICE_ITEM_IDENTITY_DRIFT')
    }
    if (
      item.generation_job_id !== undefined &&
      nonEmpty(item.generation_job_id, 'PRACTICE_ITEM_INVALID') !== generationID
    ) {
      fail('PRACTICE_ITEM_IDENTITY_DRIFT')
    }
  }
  return {
    state: expectedState,
    source_id: sourceID,
    generation_id: generationID,
    item_ids: itemID === '' ? [] : [itemID],
  }
}

export function assertAccumulationProjection(value, expectedState) {
  const projection = object(value, 'ACCUMULATION_PROJECTION_INVALID')
  assertNoCandidateFields(projection)
  if (projection.status !== expectedState) fail('ACCUMULATION_STATE_INVALID')
  const generationID = nonEmpty(
    projection.generation_id,
    'ACCUMULATION_GENERATION_ID_MISSING',
  )
  const itemID =
    typeof projection.practice_item_id === 'string'
      ? projection.practice_item_id.trim()
      : ''
  if (expectedState === 'committed' && itemID === '') {
    fail('ACCUMULATION_ITEM_ID_MISSING')
  }
  if (expectedState !== 'committed' && itemID !== '') {
    fail('ACCUMULATION_PRECOMMIT_ITEM_LEAKED')
  }
  return {
    state: expectedState,
    generation_id: generationID,
    item_ids: itemID === '' ? [] : [itemID],
  }
}

function assertSameIdentity(values, code) {
  const first = canonicalJSON(values[0])
  if (values.some((value) => canonicalJSON(value) !== first)) fail(code)
}

export function assertRunEvidence(value) {
  const evidence = object(value, 'RUN_EVIDENCE_INVALID')
  if (evidence.schema_version !== 1 || evidence.status !== 'passed') fail('RUN_EVIDENCE_INVALID')
  const boundary = object(evidence.boundary, 'RUN_EVIDENCE_INVALID')
  if (
    boundary.candidate !== 'installed_app_sidecar' ||
    boundary.direct_store_read !== false ||
    boundary.sqlite_seed_or_write !== false ||
    boundary.real_model !== false
  ) {
    fail('RUN_BOUNDARY_INVALID')
  }
  const first = object(evidence.first_process, 'RUN_EVIDENCE_INVALID')
  const mistake = object(first.mistake, 'RUN_EVIDENCE_INVALID')
  const accumulation = object(first.accumulation, 'RUN_EVIDENCE_INVALID')
  const restart = object(evidence.restart, 'RUN_EVIDENCE_INVALID')
  const restartedMistake = object(restart.mistake, 'RUN_EVIDENCE_INVALID')
  const restartedAccumulation = object(restart.accumulation, 'RUN_EVIDENCE_INVALID')

  if (
    mistake.initial?.state !== 'available' ||
    mistake.initial?.generation_id !== '' ||
    canonicalJSON(mistake.initial?.item_ids) !== '[]' ||
    mistake.admitted?.state !== 'pending' ||
    mistake.terminal?.state !== 'failed' ||
    mistake.repeated?.state !== 'failed' ||
    mistake.provider_request_count !== 1
  ) {
    fail('MISTAKE_GENERATION_EVIDENCE_INVALID')
  }
  assertSameIdentity(
    [mistake.admitted, mistake.terminal, mistake.repeated, restartedMistake.recovered].map(
      (projection) => ({
        source_id: projection?.source_id,
        generation_id: projection?.generation_id,
        item_ids: projection?.item_ids,
      }),
    ),
    'RESTART_IDENTITY_DRIFT',
  )
  if (
    accumulation.admitted?.state !== 'queued' ||
    accumulation.terminal?.state !== 'committed' ||
    accumulation.repeated?.state !== 'committed' ||
    !Number.isInteger(accumulation.classification_provider_request_count) ||
    accumulation.classification_provider_request_count < 0 ||
    accumulation.classification_provider_request_count > 1 ||
    accumulation.basket_item_count !== 1 ||
    restartedAccumulation.basket_item_count !== 1
  ) {
    fail('ACCUMULATION_GENERATION_EVIDENCE_INVALID')
  }
  assertSameIdentity(
    [
      accumulation.admitted,
      accumulation.terminal,
      accumulation.repeated,
      restartedAccumulation.recovered,
    ].map((projection) => projection?.generation_id),
    'RESTART_IDENTITY_DRIFT',
  )
  assertSameIdentity(
    [
      accumulation.terminal,
      accumulation.repeated,
      restartedAccumulation.recovered,
    ].map((projection) => projection?.item_ids),
    'RESTART_IDENTITY_DRIFT',
  )
  if (
    !SHA256.test(mistake.practice_item_exact_set_sha256 ?? '') ||
    mistake.practice_item_exact_set_sha256 !== restartedMistake.practice_item_exact_set_sha256 ||
    !SHA256.test(accumulation.practice_item_exact_set_sha256 ?? '') ||
    accumulation.practice_item_exact_set_sha256 !==
      restartedAccumulation.practice_item_exact_set_sha256
  ) {
    fail('RESTART_IDENTITY_DRIFT')
  }
  if (first.candidate_endpoint_calls !== 0) fail('CANDIDATE_SELECTION_SURFACED')
  if (restart.product_post_count !== 0) fail('RESTART_NOT_GET_ONLY')
  return evidence
}

async function loadContract() {
  let parsed
  try {
    parsed = JSON.parse(await readFile(CONTRACT_PATH, 'utf8'))
  } catch {
    fail('CONTRACT_INVALID')
  }
  return validateContract(parsed)
}

function candidateSidecar(env = process.env) {
  const direct = env.HEXCLAW_PRACTICE_ONECLICK_SIDECAR?.trim()
  if (direct) return resolve(direct)
  const app = resolve(env.HEXCLAW_PRACTICE_ONECLICK_APP?.trim() || '/Applications/HexClaw.app')
  return join(app, 'Contents', 'MacOS', 'hexclaw')
}

async function requireExecutable(pathname, code) {
  let info
  try {
    info = await lstat(pathname)
  } catch {
    fail(code)
  }
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o111) === 0) fail(code)
  return realpath(pathname)
}

async function validatePhase(env = process.env) {
  const contract = await loadContract()
  const sidecar = await requireExecutable(candidateSidecar(env), 'INSTALLED_SIDECAR_UNAVAILABLE')
  const digest = await sha256File(sidecar)
  if (!SHA256.test(digest)) fail('INSTALLED_SIDECAR_DIGEST_INVALID')
  return {
    schema_version: 1,
    status: 'ready',
    phase: 'validate',
    candidate: contract.transport.candidate,
    installed_sidecar: {
      filename: basename(sidecar),
      sha256: digest,
    },
    side_effects: { ...contract.validate_side_effects },
  }
}

async function reserveLoopbackPort() {
  const server = createServer()
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  if (!address || typeof address !== 'object') fail('PORT_RESERVATION_FAILED')
  const port = address.port
  await new Promise((resolveClose, rejectClose) =>
    server.close((error) => (error ? rejectClose(error) : resolveClose())),
  )
  if (port === 16060 || port === 11434) fail('PORT_RESERVATION_FAILED')
  return port
}

async function startControlledProvider(port) {
  const calls = []
  let mode = 'classification'
  const server = createServer((request, response) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size <= 2 * 1024 * 1024) chunks.push(chunk)
    })
    request.on('end', () => {
      const body = Buffer.concat(chunks)
      calls.push({
        mode,
        method: request.method ?? '',
        path: request.url?.split('?')[0] ?? '',
        body_sha256: createHash('sha256').update(body).digest('hex'),
      })
      if (mode === 'classification') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            id: 'fixture-accumulation-metadata',
            object: 'chat.completion',
            created: 0,
            model: CONTROLLED_MODEL,
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: JSON.stringify({
                    subject: '英语',
                    entry_type: '词汇积累',
                    source: '',
                  }),
                },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        )
        return
      }
      response.writeHead(503, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({ error: { type: 'controlled_failure', message: 'fixture unavailable' } }),
      )
    })
  })
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(port, '127.0.0.1', resolveListen)
  })
  return {
    calls,
    setMode(nextMode) {
      if (nextMode !== 'classification' && nextMode !== 'generation-failure') {
        fail('CONTROLLED_PROVIDER_MODE_INVALID')
      }
      mode = nextMode
    },
    close: () =>
      new Promise((resolveClose, rejectClose) =>
        server.close((error) => (error ? rejectClose(error) : resolveClose())),
      ),
  }
}

function yamlQuote(value) {
  return JSON.stringify(String(value))
}

async function prepareProfile(root, sidecarPort, providerPort) {
  const configDirectory = join(root, '.hexclaw')
  const temporaryDirectory = join(root, 'tmp')
  await mkdir(configDirectory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
  await mkdir(temporaryDirectory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
  await chmod(configDirectory, PRIVATE_DIRECTORY_MODE)
  await chmod(temporaryDirectory, PRIVATE_DIRECTORY_MODE)
  const config = join(configDirectory, 'hexclaw.yaml')
  const yaml = `server:\n  host: "127.0.0.1"\n  port: ${sidecarPort}\n  mode: "production"\nllm:\n  default: ${yamlQuote(CONTROLLED_PROVIDER)}\n  providers:\n    ${CONTROLLED_PROVIDER}:\n      display_name: "Controlled practice fixture"\n      api_key: "test-only-not-a-secret"\n      base_url: ${yamlQuote(`http://127.0.0.1:${providerPort}/v1`)}\n      model: ${yamlQuote(CONTROLLED_MODEL)}\n      models:\n        - ${yamlQuote(CONTROLLED_MODEL)}\n      compatible: "openai"\n      locality: "cloud"\n  routing:\n    enabled: false\n  cache:\n    enabled: false\nplatforms:\n  web:\n    enabled: true\n`
  await writeFile(config, yaml, { mode: PRIVATE_FILE_MODE, flag: 'wx' })
  await chmod(config, PRIVATE_FILE_MODE)
  return { config, temporaryDirectory }
}

function sidecarEnvironment(root, temporaryDirectory, capability) {
  const environment = {
    HOME: root,
    TMPDIR: temporaryDirectory,
    PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
    HEXCLAW_SIDECAR_CAPABILITY_TOKEN: capability,
    DINGTALK_LIVE_SEND: '0',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  }
  for (const name of ['LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
    if (typeof process.env[name] === 'string' && process.env[name] !== '') {
      environment[name] = process.env[name]
    }
  }
  return environment
}

function startSidecar(sidecar, root, runtime, capability) {
  const logs = []
  const child = spawn(sidecar, ['serve', '--desktop', '--config', runtime.config], {
    cwd: root,
    env: sidecarEnvironment(root, runtime.temporaryDirectory, capability),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => {
      if (logs.reduce((total, item) => total + item.length, 0) < 256 * 1024) {
        logs.push(Buffer.from(chunk))
      }
    })
  }
  return { child, logs }
}

async function stopSidecar(runtime) {
  if (!runtime) return { log_sha256: sha256Text('') }
  const { child } = runtime
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  let stopped = await Promise.race([
    new Promise((resolveExit) => child.once('close', () => resolveExit(true))),
    new Promise((resolveWait) => setTimeout(() => resolveWait(false), 8_000)),
  ])
  if (!stopped && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
    stopped = await new Promise((resolveExit) => child.once('close', () => resolveExit(true)))
  }
  return {
    stopped: Boolean(stopped),
    log_sha256: createHash('sha256').update(Buffer.concat(runtime.logs)).digest('hex'),
  }
}

async function waitForHealth(origin, sidecar, deadlineAt) {
  const deadline = Math.min(deadlineAt, Date.now() + START_TIMEOUT_MS)
  while (Date.now() < deadline) {
    if (sidecar.child.exitCode !== null || sidecar.child.signalCode !== null) {
      fail('SIDECAR_EXITED_BEFORE_HEALTH')
    }
    try {
      const response = await fetch(`${origin}/health`, {
        signal: AbortSignal.timeout(1_000),
      })
      if (response.ok) return
    } catch {
      // 启动阶段只等待公开健康端点，不以固定 sleep 代替终态断言。
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  fail('SIDECAR_HEALTH_TIMEOUT')
}

async function waitForPortRelease(port) {
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(300),
      })
      if (!response.ok) return
    } catch {
      return
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  fail('SIDECAR_PORT_NOT_RELEASED')
}

function remaining(deadlineAt, maximum, code) {
  const value = deadlineAt - Date.now()
  if (!Number.isFinite(value) || value <= 0) fail(code)
  return Math.max(1, Math.min(maximum, value))
}

async function apiJSON(origin, capability, audit, method, path, options = {}) {
  const headers = {
    Authorization: `Bearer ${capability}`,
    Accept: 'application/json',
    ...(options.headers ?? {}),
  }
  let body
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(options.body)
  }
  const response = await fetch(`${origin}${path}`, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
  })
  audit.push({ method, path: path.split('?')[0], status: response.status })
  const raw = await response.text()
  let value = null
  if (raw.trim() !== '') {
    try {
      value = JSON.parse(raw)
    } catch {
      fail('API_RESPONSE_NOT_JSON')
    }
  }
  const expected = options.expectedStatus ?? 200
  if (response.status !== expected) fail(options.code ?? 'API_STATUS_INVALID')
  return value
}

async function pollProjection(fetchProjection, terminalStates, deadlineAt, code) {
  const deadline = Math.min(deadlineAt, Date.now() + TERMINAL_TIMEOUT_MS)
  while (Date.now() < deadline) {
    const value = await fetchProjection()
    const state = value?.state ?? value?.status
    if (terminalStates.includes(state)) return value
    await new Promise((resolveWait) => setTimeout(resolveWait, 120))
  }
  fail(code)
}

function candidateEndpointCalls(audit) {
  return audit.filter((entry) => CANDIDATE_FIELD.test(entry.path)).length
}

function basketItemProjection(payload, generationID) {
  const sets = Array.isArray(payload?.items) ? payload.items : null
  if (!sets) fail('PRACTICE_SET_PROJECTION_INVALID')
  const matching = []
  for (const set of sets) {
    if (!Array.isArray(set?.items)) fail('PRACTICE_SET_PROJECTION_INVALID')
    for (const item of set.items) {
      if (item?.generation_job_id === generationID) {
        matching.push({
          set_id: nonEmpty(set.record_id, 'PRACTICE_SET_PROJECTION_INVALID'),
          item_id: nonEmpty(item.item_id, 'PRACTICE_SET_PROJECTION_INVALID'),
          generation_id: nonEmpty(
            item.generation_job_id,
            'PRACTICE_SET_PROJECTION_INVALID',
          ),
        })
      }
    }
  }
  matching.sort((left, right) => left.item_id.localeCompare(right.item_id))
  return matching
}

async function runFirstProcess(origin, capability, provider, deadlineAt) {
  const audit = []
  const agent = `practice-live-${randomUUID()}`
  const sourceSession = `practice-session-${randomUUID()}`
  await apiJSON(origin, capability, audit, 'POST', '/api/v1/agents', {
    body: {
      name: agent,
      display_name: 'Practice live fixture',
      description: 'Isolated K12 practice fixture',
      provider: CONTROLLED_PROVIDER,
      model: CONTROLLED_MODEL,
      system_prompt: 'Use only the supplied synthetic K12 exercise.',
      skills: [],
      metadata: {
        scenario: 'k12-tutor',
        'k12.learner_id': agent,
        'k12.child_name': 'Fixture learner',
        'k12.grade_term': '五年级下',
      },
    },
    code: 'AGENT_REGISTER_FAILED',
  })

  const accumulationKey = `practice-accumulation-${randomUUID()}`
  const classificationBefore = provider.calls.length
  const accumulationCreated = await apiJSON(
    origin,
    capability,
    audit,
    'POST',
    `/api/k12/accumulation?agent=${encodeURIComponent(agent)}`,
    {
      headers: { 'Idempotency-Key': accumulationKey },
      body: { content: 'apple' },
      code: 'ACCUMULATION_CREATE_FAILED',
    },
  )
  const accumulationID = nonEmpty(
    accumulationCreated?.record_id,
    'ACCUMULATION_CREATE_INVALID',
  )
  const classificationProviderRequests = provider.calls.length - classificationBefore
  if (classificationProviderRequests < 0 || classificationProviderRequests > 1) {
    fail('CONTROLLED_CLASSIFICATION_REQUEST_COUNT_INVALID')
  }
  provider.setMode('generation-failure')
  const accumulationPath = `/api/k12/accumulation/${encodeURIComponent(accumulationID)}`
  const accumulationCommandPath = `${accumulationPath}/dictation-to-basket`
  const accumulationCommand = {
    agent,
    source_session: sourceSession,
    full_dictation: false,
  }
  const queuedEnvelope = await apiJSON(
    origin,
    capability,
    audit,
    'POST',
    accumulationCommandPath,
    {
      body: accumulationCommand,
      expectedStatus: 202,
      code: 'ACCUMULATION_ADMISSION_FAILED',
    },
  )
  const accumulationAdmitted = assertAccumulationProjection(
    queuedEnvelope?.dictation_generation,
    'queued',
  )
  const accumulationTerminalRaw = await pollProjection(
    async () => {
      const detail = await apiJSON(
        origin,
        capability,
        audit,
        'GET',
        `${accumulationPath}?agent=${encodeURIComponent(agent)}`,
        { code: 'ACCUMULATION_PROJECTION_FAILED' },
      )
      return detail?.dictation_generation
    },
    ['committed', 'failed'],
    deadlineAt,
    'ACCUMULATION_TERMINAL_TIMEOUT',
  )
  const accumulationTerminal = assertAccumulationProjection(
    accumulationTerminalRaw,
    'committed',
  )
  const accumulationReplayEnvelope = await apiJSON(
    origin,
    capability,
    audit,
    'POST',
    accumulationCommandPath,
    {
      body: accumulationCommand,
      expectedStatus: 202,
      code: 'ACCUMULATION_REPLAY_FAILED',
    },
  )
  const accumulationRepeated = assertAccumulationProjection(
    accumulationReplayEnvelope?.dictation_generation,
    'committed',
  )
  assertSameIdentity(
    [accumulationAdmitted, accumulationTerminal, accumulationRepeated].map(
      (value) => value.generation_id,
    ),
    'ACCUMULATION_IDENTITY_DRIFT',
  )
  assertSameIdentity(
    [accumulationTerminal, accumulationRepeated].map((value) => value.item_ids),
    'ACCUMULATION_IDENTITY_DRIFT',
  )

  const mistakeCreated = await apiJSON(
    origin,
    capability,
    audit,
    'POST',
    '/api/k12/record-mistake',
    {
      body: {
        agent,
        subject: '数学',
        grade: '五年级下',
        source_session: sourceSession,
        problem: '36÷0.6=?',
        student_answer: '6',
        error_cause: '小数除法位数移动错误',
        knowledge_points: ['小数除法'],
      },
      code: 'MISTAKE_CREATE_FAILED',
    },
  )
  if (mistakeCreated?.record_created !== true) fail('MISTAKE_CREATE_INVALID')
  const mistakeID = nonEmpty(mistakeCreated.record_id, 'MISTAKE_CREATE_INVALID')
  const mistakePath = `/api/k12/mistakes/${encodeURIComponent(mistakeID)}/practice-generation`
  const mistakeInitialRaw = await apiJSON(
    origin,
    capability,
    audit,
    'GET',
    `${mistakePath}?agent=${encodeURIComponent(agent)}`,
    { code: 'MISTAKE_INITIAL_PROJECTION_FAILED' },
  )
  const mistakeInitial = assertPracticeProjection(mistakeInitialRaw, 'available')
  const requestBase = {
    agent,
    grade: '五年级下',
    textbook: '人教版',
    difficulty: 'same',
    provider: CONTROLLED_PROVIDER,
    model: CONTROLLED_MODEL,
    source_session: sourceSession,
  }
  const providerBefore = provider.calls.length
  const admittedRaw = await apiJSON(origin, capability, audit, 'POST', mistakePath, {
    body: { ...requestBase, idempotency_key: `practice-command-${randomUUID()}` },
    expectedStatus: 202,
    code: 'MISTAKE_ADMISSION_FAILED',
  })
  const mistakeAdmitted = assertPracticeProjection(admittedRaw, 'pending')
  const terminalRaw = await pollProjection(
    () =>
      apiJSON(
        origin,
        capability,
        audit,
        'GET',
        `${mistakePath}?agent=${encodeURIComponent(agent)}`,
        { code: 'MISTAKE_PROJECTION_FAILED' },
      ),
    ['joined', 'failed'],
    deadlineAt,
    'MISTAKE_TERMINAL_TIMEOUT',
  )
  const mistakeTerminal = assertPracticeProjection(terminalRaw, 'failed')
  const operationProviderRequests = provider.calls.length - providerBefore
  if (operationProviderRequests !== 1) fail('CONTROLLED_PROVIDER_REQUEST_COUNT_INVALID')
  const repeatedRaw = await apiJSON(origin, capability, audit, 'POST', mistakePath, {
    body: { ...requestBase, idempotency_key: `practice-command-${randomUUID()}` },
    expectedStatus: 202,
    code: 'MISTAKE_REPLAY_FAILED',
  })
  const mistakeRepeated = assertPracticeProjection(repeatedRaw, 'failed')
  if (provider.calls.length - providerBefore !== 1) fail('MISTAKE_REPLAY_CALLED_PROVIDER')
  assertSameIdentity(
    [mistakeAdmitted, mistakeTerminal, mistakeRepeated].map((value) => ({
      source_id: value.source_id,
      generation_id: value.generation_id,
      item_ids: value.item_ids,
    })),
    'MISTAKE_IDENTITY_DRIFT',
  )

  const practiceSets = await apiJSON(
    origin,
    capability,
    audit,
    'GET',
    `/api/k12/practice-sets?agent=${encodeURIComponent(agent)}`,
    { code: 'PRACTICE_SET_PROJECTION_FAILED' },
  )
  const accumulationBasketItems = basketItemProjection(
    practiceSets,
    accumulationTerminal.generation_id,
  )
  if (
    accumulationBasketItems.length !== 1 ||
    accumulationBasketItems[0].item_id !== accumulationTerminal.item_ids[0]
  ) {
    fail('ACCUMULATION_BASKET_ITEM_NOT_UNIQUE')
  }
  const failedBasketItems = basketItemProjection(practiceSets, mistakeTerminal.generation_id)
  if (failedBasketItems.length !== 0) fail('FAILED_MISTAKE_LEAKED_TO_BASKET')
  const candidateCalls = candidateEndpointCalls(audit)
  if (candidateCalls !== 0) fail('CANDIDATE_SELECTION_SURFACED')

  return {
    agent,
    accumulationID,
    mistakeID,
    sourceSession,
    audit,
    mistake: {
      initial: mistakeInitial,
      admitted: mistakeAdmitted,
      terminal: mistakeTerminal,
      repeated: mistakeRepeated,
      provider_request_count: operationProviderRequests,
      practice_item_exact_set_sha256: exactSetDigest(mistakeTerminal.item_ids),
    },
    accumulation: {
      admitted: accumulationAdmitted,
      terminal: accumulationTerminal,
      repeated: accumulationRepeated,
      classification_provider_request_count: classificationProviderRequests,
      practice_item_exact_set_sha256: exactSetDigest(accumulationTerminal.item_ids),
      basket_item_count: accumulationBasketItems.length,
    },
    candidate_endpoint_calls: candidateCalls,
  }
}

async function runRestart(origin, oldCapability, capability, first, provider, deadlineAt) {
  const audit = []
  await apiJSON(origin, oldCapability, audit, 'GET', '/api/v1/agents', {
    expectedStatus: 401,
    code: 'OLD_CAPABILITY_NOT_REJECTED',
  })
  await apiJSON(origin, capability, audit, 'GET', '/api/v1/agents', {
    code: 'RESTART_AGENT_PROJECTION_FAILED',
  })
  const mistakeRaw = await apiJSON(
    origin,
    capability,
    audit,
    'GET',
    `/api/k12/mistakes/${encodeURIComponent(first.mistakeID)}/practice-generation?agent=${encodeURIComponent(first.agent)}`,
    { code: 'RESTART_MISTAKE_PROJECTION_FAILED', timeoutMs: remaining(deadlineAt, REQUEST_TIMEOUT_MS, 'RESTART_BUDGET_EXHAUSTED') },
  )
  const mistake = assertPracticeProjection(mistakeRaw, 'failed')
  const accumulationRaw = await apiJSON(
    origin,
    capability,
    audit,
    'GET',
    `/api/k12/accumulation/${encodeURIComponent(first.accumulationID)}?agent=${encodeURIComponent(first.agent)}`,
    { code: 'RESTART_ACCUMULATION_PROJECTION_FAILED' },
  )
  const accumulation = assertAccumulationProjection(
    accumulationRaw?.dictation_generation,
    'committed',
  )
  const practiceSets = await apiJSON(
    origin,
    capability,
    audit,
    'GET',
    `/api/k12/practice-sets?agent=${encodeURIComponent(first.agent)}`,
    { code: 'RESTART_PRACTICE_SET_PROJECTION_FAILED' },
  )
  const accumulationBasketItems = basketItemProjection(
    practiceSets,
    accumulation.generation_id,
  )
  const failedBasketItems = basketItemProjection(practiceSets, mistake.generation_id)
  if (
    accumulationBasketItems.length !== 1 ||
    accumulationBasketItems[0].item_id !== accumulation.item_ids[0] ||
    failedBasketItems.length !== 0
  ) {
    fail('RESTART_BASKET_IDENTITY_DRIFT')
  }
  const firstProcessProviderRequests =
    first.accumulation.classification_provider_request_count +
    first.mistake.provider_request_count
  if (provider.calls.length !== firstProcessProviderRequests) fail('RESTART_CALLED_PROVIDER')
  const postCount = audit.filter((entry) => entry.method === 'POST').length
  if (postCount !== 0) fail('RESTART_NOT_GET_ONLY')
  if (candidateEndpointCalls(audit) !== 0) fail('CANDIDATE_SELECTION_SURFACED')
  return {
    product_post_count: postCount,
    old_capability_rejected: true,
    mistake: {
      recovered: mistake,
      practice_item_exact_set_sha256: exactSetDigest(mistake.item_ids),
    },
    accumulation: {
      recovered: accumulation,
      practice_item_exact_set_sha256: exactSetDigest(accumulation.item_ids),
      basket_item_count: accumulationBasketItems.length,
    },
  }
}

async function runPhase(env = process.env) {
  if (env.HEXCLAW_PRACTICE_ONECLICK_RUN !== '1') fail('RUN_NOT_ENABLED')
  await loadContract()
  const deadlineAt = Date.now() + phaseBudgetMilliseconds(env)
  const sidecar = await requireExecutable(candidateSidecar(env), 'INSTALLED_SIDECAR_UNAVAILABLE')
  const sidecarDigest = await sha256File(sidecar)
  const root = await mkdtemp(join(tmpdir(), 'hexclaw-practice-oneclick-'))
  await chmod(root, PRIVATE_DIRECTORY_MODE)
  const sidecarPort = await reserveLoopbackPort()
  const providerPort = await reserveLoopbackPort()
  const origin = `http://127.0.0.1:${sidecarPort}`
  const provider = await startControlledProvider(providerPort)
  const runtime = await prepareProfile(root, sidecarPort, providerPort)
  let firstSidecar
  let secondSidecar
  let cleanup = { first_sidecar_stopped: false, second_sidecar_stopped: false, profile_removed: false }
  try {
    const firstCapability = randomBytes(32).toString('hex')
    firstSidecar = startSidecar(sidecar, root, runtime, firstCapability)
    await waitForHealth(origin, firstSidecar, deadlineAt)
    const first = await runFirstProcess(origin, firstCapability, provider, deadlineAt)
    cleanup.first_sidecar_stopped = (await stopSidecar(firstSidecar)).stopped
    firstSidecar = null
    await waitForPortRelease(sidecarPort)

    const secondCapability = randomBytes(32).toString('hex')
    if (secondCapability === firstCapability) fail('CAPABILITY_ROTATION_FAILED')
    secondSidecar = startSidecar(sidecar, root, runtime, secondCapability)
    await waitForHealth(origin, secondSidecar, deadlineAt)
    const restart = await runRestart(
      origin,
      firstCapability,
      secondCapability,
      first,
      provider,
      deadlineAt,
    )
    cleanup.second_sidecar_stopped = (await stopSidecar(secondSidecar)).stopped
    secondSidecar = null
    await waitForPortRelease(sidecarPort)

    const evidence = {
      schema_version: 1,
      status: 'passed',
      boundary: {
        candidate: 'installed_app_sidecar',
        installed_sidecar_sha256: sidecarDigest,
        direct_store_read: false,
        sqlite_seed_or_write: false,
        real_model: false,
      },
      first_process: {
        mistake: first.mistake,
        accumulation: first.accumulation,
        candidate_endpoint_calls: first.candidate_endpoint_calls,
      },
      restart,
      controlled_provider: {
        external_network: false,
        request_count: provider.calls.length,
        request_exact_set_sha256: exactSetDigest(
          provider.calls.map(
            (call) =>
              `${call.mode}\u0000${call.method}\u0000${call.path}\u0000${call.body_sha256}`,
          ),
        ),
      },
      cleanup,
    }
    assertRunEvidence(evidence)
    return evidence
  } finally {
    if (firstSidecar) await stopSidecar(firstSidecar)
    if (secondSidecar) await stopSidecar(secondSidecar)
    await provider.close()
    await rm(root, { recursive: true, force: true })
    cleanup.profile_removed = true
  }
}

async function main() {
  const phase = resolvePhase(process.argv.slice(2))
  const result = phase === 'validate' ? await validatePhase(process.env) : await runPhase(process.env)
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

const entry = process.argv[1]
if (entry && isAbsolute(entry) && import.meta.url === pathToFileURL(resolve(entry)).href) {
  main().catch((error) => {
    process.stdout.write(`${JSON.stringify({ status: 'failed', code: safeCode(error) })}\n`)
    process.exitCode = 1
  })
}
