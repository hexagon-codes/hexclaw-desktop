#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
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
const REAL_PROVIDER = 'hexclaw-gpt'
const REAL_MODEL = 'gpt-5.6-sol'
const REAL_APP_BUNDLE = '/Applications/HexClaw.app'
const REAL_DEFAULT_PROFILE_PORT = 16060
const SHA256_PUBLIC = /^sha256:[a-f0-9]{64}$/u
const REAL_RECEIPT_STAGES = Object.freeze(['practice_generate', 'practice_validate'])
const REAL_PUBLIC_GENERATION_STATES = Object.freeze([
  'available',
  'pending',
  'joined',
  'failed',
  're_add',
  'hidden',
])
const REAL_SETTLED_GENERATION_STATES = Object.freeze([
  'joined',
  'failed',
  're_add',
  'hidden',
  'available',
])

export const PHASES = Object.freeze(['validate', 'run'])
export const EXECUTION_MODES = Object.freeze(['controlled', 'real_default_profile'])

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

function attachFailureEvidence(error, evidence) {
  const target = error instanceof HarnessError ? error : new HarnessError('UNEXPECTED_FAILURE')
  target.public_evidence = evidence
  return target
}

function failureOutput(error) {
  const output = { status: 'failed', code: safeCode(error) }
  if (error instanceof HarnessError && error.public_evidence) {
    output.evidence = error.public_evidence
  }
  return output
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

export function realGenerationTerminalBudgetMilliseconds(deadlineAt, now = Date.now()) {
  const value = deadlineAt - now
  if (!Number.isFinite(value) || value <= 0) fail('REAL_GENERATION_BUDGET_EXHAUSTED')
  return value
}

export function classifyRealGenerationObservation(value) {
  const projection = object(value, 'REAL_GENERATION_STATE_INVALID')
  const state = nonEmpty(projection.state, 'REAL_GENERATION_STATE_INVALID')
  if (!REAL_PUBLIC_GENERATION_STATES.includes(state)) fail('REAL_GENERATION_STATE_INVALID')
  return {
    state,
    settled: REAL_SETTLED_GENERATION_STATES.includes(state),
    succeeded: state === 'joined',
  }
}

export function resolveExecutionMode(env = process.env) {
  return env.HEXCLAW_PRACTICE_ONECLICK_REAL_DEFAULT_PROFILE === '1'
    ? 'real_default_profile'
    : 'controlled'
}

export function resolveRealDefaultProfileInputs(env = process.env, userHome = homedir()) {
  if (resolveExecutionMode(env) !== 'real_default_profile') {
    fail('REAL_DEFAULT_PROFILE_MODE_REQUIRED')
  }
  if (env.HEXCLAW_PRACTICE_ONECLICK_DEFAULT_PROFILE_AUTHORIZED !== '1') {
    fail('REAL_DEFAULT_PROFILE_AUTHORIZATION_REQUIRED')
  }
  const canonicalConfig = resolve(userHome, '.hexclaw', 'hexclaw.yaml')
  const requestedConfig = resolve(
    nonEmpty(env.HEXCLAW_PRACTICE_ONECLICK_ACTUAL_CONFIG, 'REAL_DEFAULT_PROFILE_INPUT_REQUIRED'),
  )
  if (requestedConfig !== canonicalConfig) fail('ACTUAL_DEFAULT_CONFIG_REQUIRED')
  const expectedDigest = nonEmpty(
    env.HEXCLAW_PRACTICE_ONECLICK_EXPECTED_SIDECAR_SHA256,
    'REAL_DEFAULT_PROFILE_INPUT_REQUIRED',
  ).toLowerCase()
  if (!SHA256.test(expectedDigest)) fail('EXPECTED_CANDIDATE_DIGEST_INVALID')
  return {
    app_bundle: REAL_APP_BUNDLE,
    sidecar: join(REAL_APP_BUNDLE, 'Contents', 'MacOS', 'hexclaw'),
    config: requestedConfig,
    expected_sidecar_sha256: expectedDigest,
    origin: `http://127.0.0.1:${REAL_DEFAULT_PROFILE_PORT}`,
  }
}

export function realDefaultProfileEnvironment(env, capability) {
  return {
    ...env,
    HEXCLAW_SIDECAR_CAPABILITY_TOKEN: nonEmpty(capability, 'SIDECAR_CAPABILITY_REQUIRED'),
    HEXCLAW_DISABLE_IM: 'all',
    DINGTALK_LIVE_SEND: '0',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  }
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
    practice_receipts: '/api/k12/mistakes/{record_id}/practice-generation/receipts',
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
  const realDefaultProfile = object(root.real_default_profile)
  const expectedRealDefaultProfile = {
    mode_env: 'HEXCLAW_PRACTICE_ONECLICK_REAL_DEFAULT_PROFILE',
    authorization_env: 'HEXCLAW_PRACTICE_ONECLICK_DEFAULT_PROFILE_AUTHORIZED',
    app_bundle: REAL_APP_BUNDLE,
    config: '${user_home}/.hexclaw/hexclaw.yaml',
    port: REAL_DEFAULT_PROFILE_PORT,
    provider: REAL_PROVIDER,
    model: REAL_MODEL,
    fallback_allowed: false,
    im_enabled: false,
    source_fixture: 'unique_public_api_mistake',
    generation_post_count: 1,
    terminal_budget: 'remaining_phase_budget',
    poll_continuation_states: ['pending'],
    poll_settled_states: [...REAL_SETTLED_GENERATION_STATES],
    receipt_stages: [...REAL_RECEIPT_STAGES],
    failure_evidence_before_cleanup: ['last_projection', 'receipts'],
    restart_methods: ['GET'],
    cleanup_methods: ['DELETE'],
  }
  exactObject(realDefaultProfile, expectedRealDefaultProfile)
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
    real_default_profile: expectedRealDefaultProfile,
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
  const generationID = nonEmpty(projection.generation_id, 'ACCUMULATION_GENERATION_ID_MISSING')
  const itemID =
    typeof projection.practice_item_id === 'string' ? projection.practice_item_id.trim() : ''
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

export function assertRealPracticeReceipts(value) {
  const receiptView = object(value, 'REAL_RECEIPT_INVALID')
  if (
    receiptView.schema_version !== 1 ||
    receiptView.source_kind !== 'mistake' ||
    receiptView.generation_status !== 'committed' ||
    !SHA256_PUBLIC.test(receiptView.generation_job_id_digest ?? '') ||
    !SHA256_PUBLIC.test(receiptView.receipt_exact_set_digest ?? '') ||
    !Array.isArray(receiptView.receipts) ||
    receiptView.receipts.length !== 2
  ) {
    fail('REAL_RECEIPT_INVALID')
  }
  const stages = []
  for (const raw of receiptView.receipts) {
    const receipt = object(raw, 'REAL_RECEIPT_INVALID')
    if (
      receipt.attempt !== 1 ||
      receipt.status !== 'succeeded' ||
      receipt.provider !== REAL_PROVIDER ||
      receipt.model !== REAL_MODEL ||
      receipt.route !== `${REAL_PROVIDER}/${REAL_MODEL}` ||
      !SHA256_PUBLIC.test(receipt.provider_instance_id_digest ?? '') ||
      !SHA256_PUBLIC.test(receipt.receipt_digest ?? '') ||
      typeof receipt.created_at !== 'number' ||
      typeof receipt.updated_at !== 'number'
    ) {
      fail('REAL_RECEIPT_ROUTE_INVALID')
    }
    for (const field of [
      'config_fingerprint',
      'capability_receipt_digest',
      'probe_policy_version',
      'request_digest',
      'result_digest',
    ]) {
      nonEmpty(receipt[field], 'REAL_RECEIPT_INVALID')
    }
    stages.push(nonEmpty(receipt.stage, 'REAL_RECEIPT_INVALID'))
  }
  stages.sort()
  if (canonicalJSON(stages) !== canonicalJSON(REAL_RECEIPT_STAGES)) {
    fail('REAL_RECEIPT_STAGE_SET_INVALID')
  }
  return {
    generation_job_id_digest: receiptView.generation_job_id_digest,
    generation_status: receiptView.generation_status,
    receipt_exact_set_digest: receiptView.receipt_exact_set_digest,
    stages,
    physical_provider_call_count: receiptView.receipts.length,
    fallback_provider_call_count: 0,
    canonical_sha256: sha256Text(canonicalJSON(receiptView)),
  }
}

function sha256NonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '' ? sha256Text(value.trim()) : undefined
}

function safePublicToken(value, allowed, fallback = 'unknown') {
  return typeof value === 'string' && allowed.test(value) ? value : fallback
}

function projectFailureProjection(result) {
  const response = object(result, 'REAL_FAILURE_EVIDENCE_INVALID')
  const httpStatus = Number.isInteger(response.http_status) ? response.http_status : 0
  if (httpStatus !== 200 || !response.value || typeof response.value !== 'object') {
    return {
      http_status: httpStatus,
      available: false,
      error_code: safePublicToken(response.error_code, /^[A-Z0-9_]+$/u, 'UNAVAILABLE'),
    }
  }
  const raw = object(response.value, 'REAL_FAILURE_EVIDENCE_INVALID')
  const state = REAL_PUBLIC_GENERATION_STATES.includes(raw.state) ? raw.state : 'unknown'
  const projected = {
    http_status: httpStatus,
    available: true,
    state,
    canonical_sha256: sha256Text(canonicalJSON(raw)),
  }
  const sourceDigest = sha256NonEmpty(raw.source_mistake_id)
  const generationDigest = sha256NonEmpty(raw.generation_job_id)
  const failureDigest = sha256NonEmpty(raw.failure_reason)
  if (sourceDigest) projected.source_id_sha256 = sourceDigest
  if (generationDigest) projected.generation_id_sha256 = generationDigest
  if (failureDigest) projected.failure_reason_sha256 = failureDigest
  return projected
}

function projectFailureReceipts(result) {
  const response = object(result, 'REAL_FAILURE_EVIDENCE_INVALID')
  const httpStatus = Number.isInteger(response.http_status) ? response.http_status : 0
  if (httpStatus !== 200 || !response.value || typeof response.value !== 'object') {
    return {
      http_status: httpStatus,
      available: false,
      error_code: safePublicToken(response.error_code, /^[A-Z0-9_]+$/u, 'UNAVAILABLE'),
    }
  }
  const raw = object(response.value, 'REAL_FAILURE_EVIDENCE_INVALID')
  const receipts = Array.isArray(raw.receipts) ? raw.receipts : []
  const exactSet = receipts
    .map((value) => {
      const receipt = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
      return {
        stage: safePublicToken(receipt.stage, /^(?:practice_generate|practice_validate)$/u),
        attempt: Number.isInteger(receipt.attempt) && receipt.attempt > 0 ? receipt.attempt : 0,
        status: safePublicToken(
          receipt.status,
          /^(?:prepared|sent|succeeded|failed|outcome_unknown|reconciled)$/u,
        ),
        provider: safePublicToken(receipt.provider, /^[A-Za-z0-9._-]{1,128}$/u, 'redacted'),
        model: safePublicToken(receipt.model, /^[A-Za-z0-9._:-]{1,128}$/u, 'redacted'),
        route: safePublicToken(
          receipt.route,
          /^[A-Za-z0-9._-]{1,128}\/[A-Za-z0-9._:-]{1,128}$/u,
          'redacted',
        ),
        failure_kind: safePublicToken(
          receipt.failure_kind ?? '',
          /^[A-Za-z0-9._:-]{0,128}$/u,
          'redacted',
        ),
        receipt_digest: SHA256_PUBLIC.test(receipt.receipt_digest ?? '')
          ? receipt.receipt_digest
          : 'unavailable',
      }
    })
    .sort((left, right) =>
      `${left.stage}\u0000${left.attempt}`.localeCompare(`${right.stage}\u0000${right.attempt}`),
    )
  const generationStatus = safePublicToken(
    raw.generation_status,
    /^(?:queued|generating|validating|committed|failed|cancelled)$/u,
  )
  const projected = {
    http_status: httpStatus,
    available: true,
    generation_status: generationStatus,
    receipt_count: receipts.length,
    exact_set: exactSet,
    canonical_sha256: sha256Text(canonicalJSON(raw)),
  }
  if (SHA256_PUBLIC.test(raw.generation_job_id_digest ?? '')) {
    projected.generation_job_id_digest = raw.generation_job_id_digest
  }
  if (SHA256_PUBLIC.test(raw.receipt_exact_set_digest ?? '')) {
    projected.receipt_exact_set_digest = raw.receipt_exact_set_digest
  }
  return projected
}

export function projectRealFailurePublicEvidence(projectionResult, receiptResult, ownership) {
  const owned = object(ownership, 'REAL_FAILURE_EVIDENCE_INVALID')
  return {
    schema_version: 1,
    owned_fixture: {
      agent_name_sha256: sha256Text(nonEmpty(owned.agent_name, 'REAL_FAILURE_EVIDENCE_INVALID')),
      source_session_sha256: sha256Text(
        nonEmpty(owned.source_session, 'REAL_FAILURE_EVIDENCE_INVALID'),
      ),
      mistake_id_sha256: sha256Text(nonEmpty(owned.mistake_id, 'REAL_FAILURE_EVIDENCE_INVALID')),
      marker_sha256: sha256Text(nonEmpty(owned.marker, 'REAL_FAILURE_EVIDENCE_INVALID')),
    },
    last_projection: projectFailureProjection(projectionResult),
    receipts: projectFailureReceipts(receiptResult),
  }
}

function unavailableRealFailurePublicEvidence(ownership, code) {
  return projectRealFailurePublicEvidence(
    { http_status: 0, error_code: code },
    { http_status: 0, error_code: code },
    ownership,
  )
}

export function projectRealJoinedPractice(value) {
  const raw = object(value, 'REAL_JOINED_PROJECTION_INVALID')
  const identity = assertPracticeProjection(raw, 'joined')
  const practiceSetID = nonEmpty(raw.practice_set_id, 'REAL_JOINED_PROJECTION_INVALID')
  const itemID = nonEmpty(raw.practice_item_id, 'REAL_JOINED_PROJECTION_INVALID')
  const item = object(raw.item, 'REAL_JOINED_PROJECTION_INVALID')
  if (
    nonEmpty(item.item_id, 'REAL_JOINED_PROJECTION_INVALID') !== itemID ||
    nonEmpty(item.generation_job_id, 'REAL_JOINED_PROJECTION_INVALID') !== identity.generation_id
  ) {
    fail('REAL_JOINED_PROJECTION_INVALID')
  }
  return {
    raw,
    identity: {
      source_id: identity.source_id,
      generation_id: identity.generation_id,
      practice_set_id: practiceSetID,
      item_id: itemID,
    },
    evidence: {
      state: 'joined',
      source_id_sha256: sha256Text(identity.source_id),
      generation_id_sha256: sha256Text(identity.generation_id),
      practice_set_id_sha256: sha256Text(practiceSetID),
      item_id_sha256: sha256Text(itemID),
      canonical_sha256: sha256Text(canonicalJSON(raw)),
      item_canonical_sha256: sha256Text(canonicalJSON(item)),
    },
  }
}

export function projectRealPracticeExactSet(payload, generationID) {
  const targetGeneration = nonEmpty(generationID, 'REAL_ITEM_EXACT_SET_INVALID')
  const root = object(payload, 'REAL_ITEM_EXACT_SET_INVALID')
  if (!Array.isArray(root.items)) fail('REAL_ITEM_EXACT_SET_INVALID')
  const matches = []
  for (const set of root.items) {
    const setValue = object(set, 'REAL_ITEM_EXACT_SET_INVALID')
    const setID = nonEmpty(setValue.record_id, 'REAL_ITEM_EXACT_SET_INVALID')
    if (!Array.isArray(setValue.items)) fail('REAL_ITEM_EXACT_SET_INVALID')
    for (const item of setValue.items) {
      if (item?.generation_job_id !== targetGeneration) continue
      matches.push({
        set_id: setID,
        item_id: nonEmpty(item.item_id, 'REAL_ITEM_EXACT_SET_INVALID'),
        item,
      })
    }
  }
  matches.sort((left, right) =>
    `${left.set_id}\u0000${left.item_id}`.localeCompare(`${right.set_id}\u0000${right.item_id}`),
  )
  if (matches.length !== 1) fail('REAL_ITEM_EXACT_SET_INVALID')
  const identities = matches.map(({ set_id, item_id }) => ({ set_id, item_id }))
  return {
    identities,
    raw_items: matches.map(({ item }) => item),
    evidence: {
      count: matches.length,
      item_ids_sha256: exactSetDigest(matches.map(({ item_id }) => item_id)),
      canonical_sha256: sha256Text(canonicalJSON(matches.map(({ item }) => item))),
    },
  }
}

function optionalString(value, code) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') fail(code)
  return value
}

function optionalInteger(value, code) {
  if (value === undefined || value === null) return 0
  if (!Number.isInteger(value) || value < 0) fail(code)
  return value
}

function optionalBoolean(value, code) {
  if (value === undefined || value === null) return false
  if (typeof value !== 'boolean') fail(code)
  return value
}

function optionalNullableBoolean(value, code) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'boolean') fail(code)
  return value
}

function projectRealPracticeItemCommonSemantics(value) {
  const code = 'REAL_ITEM_PROJECTION_DRIFT'
  const item = object(value, code)
  return {
    item_id: nonEmpty(item.item_id, code),
    source_problem_id: nonEmpty(item.source_problem_id, code),
    subject: nonEmpty(item.subject, code),
    added_via: nonEmpty(item.added_via, code),
    question_markdown: nonEmpty(item.question_markdown, code),
    expected_answer_markdown: nonEmpty(item.expected_answer_markdown, code),
    verification_status: nonEmpty(item.verification_status, code),
    verification_evidence: optionalString(item.verification_evidence, code),
    blocked_reason: optionalString(item.blocked_reason, code),
    paper_seq: optionalInteger(item.paper_seq, code),
    returned: optionalBoolean(item.returned, code),
    generation_job_id: nonEmpty(item.generation_job_id, code),
    variant_index: optionalInteger(item.variant_index, code),
    requested_difficulty: optionalString(item.requested_difficulty, code),
    actual_difficulty: optionalString(item.actual_difficulty, code),
    result_correct: optionalNullableBoolean(item.result_correct, code),
    result_evidence: optionalString(item.result_evidence, code),
  }
}

export function assertRealPracticeItemProjectionAgreement(terminal, exactSet) {
  const code = 'REAL_ITEM_PROJECTION_DRIFT'
  const joined = object(terminal, code)
  const identity = object(joined.identity, code)
  const setProjection = object(exactSet, code)
  if (
    !Array.isArray(setProjection.identities) ||
    setProjection.identities.length !== 1 ||
    !Array.isArray(setProjection.raw_items) ||
    setProjection.raw_items.length !== 1
  ) {
    fail(code)
  }
  const setIdentity = object(setProjection.identities[0], code)
  const joinedRaw = object(joined.raw, code)
  const joinedItem = projectRealPracticeItemCommonSemantics(joinedRaw.item)
  const dtoItem = projectRealPracticeItemCommonSemantics(setProjection.raw_items[0])
  if (
    nonEmpty(identity.source_id, code) !== joinedItem.source_problem_id ||
    nonEmpty(identity.generation_id, code) !== joinedItem.generation_job_id ||
    nonEmpty(identity.practice_set_id, code) !== nonEmpty(setIdentity.set_id, code) ||
    nonEmpty(identity.item_id, code) !== nonEmpty(setIdentity.item_id, code) ||
    identity.item_id !== joinedItem.item_id ||
    identity.generation_id !== dtoItem.generation_job_id ||
    identity.item_id !== dtoItem.item_id ||
    joinedItem.added_via !== 'single_variant' ||
    joinedItem.verification_status !== 'verified' ||
    joinedItem.blocked_reason !== '' ||
    joinedItem.variant_index !== 1 ||
    canonicalJSON(joinedItem) !== canonicalJSON(dtoItem)
  ) {
    fail(code)
  }
  return true
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
    [accumulation.terminal, accumulation.repeated, restartedAccumulation.recovered].map(
      (projection) => projection?.item_ids,
    ),
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

function assertEvidenceSHA(value, code = 'REAL_RUN_EVIDENCE_INVALID') {
  if (!SHA256.test(value ?? '')) fail(code)
}

export function assertRealRunEvidence(value) {
  const evidence = object(value, 'REAL_RUN_EVIDENCE_INVALID')
  if (
    evidence.schema_version !== 1 ||
    evidence.status !== 'passed' ||
    evidence.mode !== 'real_default_profile'
  ) {
    fail('REAL_RUN_EVIDENCE_INVALID')
  }
  const candidate = object(evidence.candidate, 'REAL_CANDIDATE_ATTESTATION_INVALID')
  if (!SHA256.test(candidate.sidecar_sha256 ?? '') || !SHA256.test(candidate.config_sha256 ?? '')) {
    fail('REAL_CANDIDATE_ATTESTATION_INVALID')
  }
  const boundary = object(evidence.boundary, 'REAL_RUN_EVIDENCE_INVALID')
  exactObject(boundary, {
    candidate: 'installed_app_sidecar',
    default_profile: true,
    home_modified: false,
    config_copied: false,
    public_api_only: true,
    direct_store_read: false,
    sqlite_seed_or_write: false,
    im_enabled: false,
    im_calls: 0,
  })
  exactObject(object(evidence.route, 'REAL_RUN_EVIDENCE_INVALID'), {
    provider: REAL_PROVIDER,
    model: REAL_MODEL,
    fallback_allowed: false,
  })
  const ownedFixture = object(evidence.owned_fixture, 'REAL_OWNED_FIXTURE_INVALID')
  for (const field of ['agent_name_sha256', 'mistake_id_sha256', 'marker_sha256']) {
    if (!SHA256.test(ownedFixture[field] ?? '')) fail('REAL_OWNED_FIXTURE_INVALID')
  }
  const first = object(evidence.first_process, 'REAL_RUN_EVIDENCE_INVALID')
  const restart = object(evidence.restart, 'REAL_RUN_EVIDENCE_INVALID')
  if (first.generation_post_count !== 1) fail('REAL_GENERATION_POST_COUNT_INVALID')
  if (restart.product_post_count !== 0 || restart.product_mutation_count !== 0) {
    fail('REAL_RESTART_NOT_GET_ONLY')
  }
  if (restart.physical_provider_call_count_delta !== 0) {
    fail('REAL_RESTART_MODEL_DELTA_INVALID')
  }
  const firstProjection = object(first.projection, 'REAL_RUN_EVIDENCE_INVALID')
  if (firstProjection.state !== 'joined') fail('REAL_JOINED_PROJECTION_INVALID')
  for (const field of [
    'source_id_sha256',
    'generation_id_sha256',
    'practice_set_id_sha256',
    'item_id_sha256',
    'canonical_sha256',
    'item_canonical_sha256',
  ]) {
    assertEvidenceSHA(firstProjection[field])
  }
  const firstExactSet = object(first.exact_set, 'REAL_RUN_EVIDENCE_INVALID')
  if (firstExactSet.count !== 1) fail('REAL_ITEM_EXACT_SET_INVALID')
  assertEvidenceSHA(firstExactSet.item_ids_sha256)
  assertEvidenceSHA(firstExactSet.canonical_sha256)
  const firstReceipts = object(first.receipts, 'REAL_RUN_EVIDENCE_INVALID')
  if (
    firstReceipts.physical_provider_call_count !== 2 ||
    firstReceipts.fallback_provider_call_count !== 0 ||
    canonicalJSON(firstReceipts.stages) !== canonicalJSON(REAL_RECEIPT_STAGES)
  ) {
    fail('REAL_RECEIPT_INVALID')
  }
  assertEvidenceSHA(firstReceipts.canonical_sha256)
  if (
    canonicalJSON(firstProjection) !== canonicalJSON(restart.projection) ||
    canonicalJSON(firstExactSet) !== canonicalJSON(restart.exact_set) ||
    canonicalJSON(firstReceipts) !== canonicalJSON(restart.receipts)
  ) {
    fail('REAL_RESTART_DEEP_EQUAL_FAILED')
  }
  const cleanup = object(evidence.cleanup, 'REAL_RUN_EVIDENCE_INVALID')
  if (
    cleanup.mistake_deleted !== true ||
    cleanup.agent_deleted !== true ||
    cleanup.verified !== true
  ) {
    fail('REAL_PUBLIC_CLEANUP_INCOMPLETE')
  }
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

async function pollProjection(
  fetchProjection,
  terminalStates,
  deadlineAt,
  code,
  maximumMilliseconds = TERMINAL_TIMEOUT_MS,
) {
  const deadline = Math.min(deadlineAt, Date.now() + maximumMilliseconds)
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
          generation_id: nonEmpty(item.generation_job_id, 'PRACTICE_SET_PROJECTION_INVALID'),
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
  const accumulationID = nonEmpty(accumulationCreated?.record_id, 'ACCUMULATION_CREATE_INVALID')
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
  const queuedEnvelope = await apiJSON(origin, capability, audit, 'POST', accumulationCommandPath, {
    body: accumulationCommand,
    expectedStatus: 202,
    code: 'ACCUMULATION_ADMISSION_FAILED',
  })
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
  const accumulationTerminal = assertAccumulationProjection(accumulationTerminalRaw, 'committed')
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
    {
      code: 'RESTART_MISTAKE_PROJECTION_FAILED',
      timeoutMs: remaining(deadlineAt, REQUEST_TIMEOUT_MS, 'RESTART_BUDGET_EXHAUSTED'),
    },
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
  const accumulationBasketItems = basketItemProjection(practiceSets, accumulation.generation_id)
  const failedBasketItems = basketItemProjection(practiceSets, mistake.generation_id)
  if (
    accumulationBasketItems.length !== 1 ||
    accumulationBasketItems[0].item_id !== accumulation.item_ids[0] ||
    failedBasketItems.length !== 0
  ) {
    fail('RESTART_BASKET_IDENTITY_DRIFT')
  }
  const firstProcessProviderRequests =
    first.accumulation.classification_provider_request_count + first.mistake.provider_request_count
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
  let cleanup = {
    first_sidecar_stopped: false,
    second_sidecar_stopped: false,
    profile_removed: false,
  }
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
            (call) => `${call.mode}\u0000${call.method}\u0000${call.path}\u0000${call.body_sha256}`,
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

async function requireRealDefaultConfig(pathname) {
  let info
  try {
    info = await lstat(pathname)
  } catch {
    fail('ACTUAL_CONFIG_UNAVAILABLE')
  }
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    fail('ACTUAL_CONFIG_INVALID')
  }
  return realpath(pathname)
}

async function attestRealDefaultProfile(paths) {
  let appInfo
  try {
    appInfo = await lstat(paths.app_bundle)
  } catch {
    fail('INSTALLED_APP_UNAVAILABLE')
  }
  if (!appInfo.isDirectory() || appInfo.isSymbolicLink()) fail('INSTALLED_APP_INVALID')
  const appReal = await realpath(paths.app_bundle)
  const sidecarReal = await requireExecutable(paths.sidecar, 'INSTALLED_SIDECAR_UNAVAILABLE')
  if (!sidecarReal.startsWith(`${appReal}/`)) fail('INSTALLED_SIDECAR_OUTSIDE_APP')
  const configReal = await requireRealDefaultConfig(paths.config)
  if (configReal !== paths.config) fail('ACTUAL_DEFAULT_CONFIG_REQUIRED')
  const sidecarDigest = await sha256File(sidecarReal)
  if (sidecarDigest !== paths.expected_sidecar_sha256) {
    fail('INSTALLED_SIDECAR_DIGEST_MISMATCH')
  }
  return {
    sidecar_sha256: sidecarDigest,
    config_sha256: await sha256File(configReal),
  }
}

async function validateRealPhase(env = process.env) {
  const contract = await loadContract()
  const paths = resolveRealDefaultProfileInputs(env)
  const attestation = await attestRealDefaultProfile(paths)
  return {
    schema_version: 1,
    status: 'ready',
    phase: 'validate',
    mode: 'real_default_profile',
    candidate: contract.transport.candidate,
    installed_sidecar: {
      filename: basename(paths.sidecar),
      sha256: attestation.sidecar_sha256,
    },
    actual_default_config_sha256: attestation.config_sha256,
    side_effects: {
      ...contract.validate_side_effects,
      im_calls: 0,
    },
  }
}

async function assertRealDefaultPortAvailable() {
  const server = createServer()
  try {
    await new Promise((resolveListen, rejectListen) => {
      server.once('error', rejectListen)
      server.listen(REAL_DEFAULT_PROFILE_PORT, '127.0.0.1', resolveListen)
    })
  } catch {
    fail('REAL_DEFAULT_PROFILE_PORT_NOT_AVAILABLE')
  }
  await new Promise((resolveClose, rejectClose) =>
    server.close((error) => (error ? rejectClose(error) : resolveClose())),
  )
}

function startRealDefaultProfileSidecar(paths, capability, env = process.env) {
  const logs = []
  const child = spawn(paths.sidecar, ['serve', '--desktop', '--config', paths.config], {
    cwd: dirname(paths.config),
    env: realDefaultProfileEnvironment(env, capability),
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

export function assertRealLLMProjection(value) {
  const root = value && typeof value === 'object' && !Array.isArray(value) ? value : null
  const providers =
    root?.providers && typeof root.providers === 'object' && !Array.isArray(root.providers)
      ? root.providers
      : null
  const provider = providers?.[REAL_PROVIDER]
  const models = Array.isArray(provider?.models) ? provider.models : []
  const specs = Array.isArray(provider?.model_specs)
    ? provider.model_specs.filter((spec) => spec?.id === REAL_MODEL)
    : []
  const spec = specs.length === 1 ? specs[0] : null
  const control = spec?.reasoning_control
  if (
    !Object.hasOwn(providers ?? {}, REAL_PROVIDER) ||
    !provider ||
    provider.enabled === false ||
    provider.credential_present !== true ||
    !models.includes(REAL_MODEL) ||
    provider.model_specs_mode !== 'explicit' ||
    specs.length !== 1 ||
    !Array.isArray(spec?.capabilities) ||
    !spec.capabilities.includes('text') ||
    spec.reasoning_support !== 'supported' ||
    control?.dialect !== 'reasoning_effort' ||
    control.on !== 'low' ||
    control.off !== 'none' ||
    !Array.isArray(control.allowed_efforts) ||
    control.allowed_efforts.length !== 1 ||
    control.allowed_efforts[0] !== 'low'
  ) {
    fail('REAL_LLM_ROUTE_INVALID')
  }
  return {
    provider: REAL_PROVIDER,
    model: REAL_MODEL,
    provider_default_affects_fixed_route: false,
    text_capability: true,
    reasoning: {
      support: 'supported',
      dialect: 'reasoning_effort',
      low_available: true,
    },
    credential_present: true,
    fallback_allowed: false,
  }
}

function assertIMInstancesDisabled(value) {
  const root = object(value, 'REAL_IM_PROJECTION_INVALID')
  if (!Array.isArray(root.instances)) fail('REAL_IM_PROJECTION_INVALID')
  const dingtalk = root.instances.filter(
    (instance) => String(instance?.provider ?? '').toLowerCase() === 'dingtalk',
  )
  if (dingtalk.some((instance) => instance?.status === 'running')) {
    fail('REAL_IM_PROCESS_RUNNING')
  }
  return { dingtalk_instance_count: dingtalk.length, running_instance_count: 0 }
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

export function projectOwnedAutomationIsolation(value, ownership) {
  const root = object(value, 'REAL_AUTOMATION_PROJECTION_INVALID')
  if (!Array.isArray(root.jobs)) fail('REAL_AUTOMATION_PROJECTION_INVALID')
  const owned = object(ownership, 'REAL_AUTOMATION_OWNERSHIP_INVALID')
  const identifiers = [
    nonEmpty(owned.agent_name, 'REAL_AUTOMATION_OWNERSHIP_INVALID'),
    nonEmpty(owned.source_session, 'REAL_AUTOMATION_OWNERSHIP_INVALID'),
    nonEmpty(owned.mistake_id, 'REAL_AUTOMATION_OWNERSHIP_INVALID'),
    nonEmpty(owned.marker, 'REAL_AUTOMATION_OWNERSHIP_INVALID'),
  ]
  if (new Set(identifiers).size !== identifiers.length) {
    fail('REAL_AUTOMATION_OWNERSHIP_INVALID')
  }
  const ownedMatches = root.jobs.filter((job) => valueContainsOwnedIdentifier(job, identifiers))
  if (ownedMatches.length !== 0) fail('REAL_OWNED_AUTOMATION_PRESENT')
  return {
    listed_count: root.jobs.length,
    active_unrelated_count: root.jobs.filter((job) => job?.status === 'active').length,
    owned_match_count: 0,
    scope: 'owned_fixture_only',
  }
}

async function assertNoOwnedAutomation(origin, capability, audit, ownership) {
  const projection = await apiJSON(origin, capability, audit, 'POST', '/api/v1/cronjob', {
    body: { action: 'list', include_paused: true },
    code: 'REAL_AUTOMATION_PREFLIGHT_FAILED',
  })
  return projectOwnedAutomationIsolation(projection, ownership)
}

function assertAgentAbsent(value, agentName) {
  const root = object(value, 'REAL_AGENT_PROJECTION_INVALID')
  if (!Array.isArray(root.agents)) fail('REAL_AGENT_PROJECTION_INVALID')
  if (root.agents.some((agent) => agent?.name === agentName)) {
    fail('REAL_OWNED_AGENT_ALREADY_EXISTS')
  }
}

function buildRealOwnedAgent(agentName) {
  return {
    name: agentName,
    display_name: 'K12 practice verification',
    description: 'Isolated one-click practice verification agent',
    provider: REAL_PROVIDER,
    model: REAL_MODEL,
    system_prompt: 'Use the supplied elementary-school exercise and return only grounded work.',
    skills: [],
    metadata: {
      scenario: 'k12-tutor',
      'k12.learner_id': agentName,
      'k12.child_name': 'Practice verification learner',
      'k12.grade_term': '五年级下',
    },
  }
}

function buildRealMistake(agentName, sourceSession, marker) {
  return {
    agent: agentName,
    subject: '数学',
    grade: '五年级下',
    source_session: sourceSession,
    problem: `小明计算 3/4 + 1/8 时写成 4/12。测试标记：${marker}`,
    student_answer: '4/12',
    error_cause: '异分母分数相加时没有先通分。',
    knowledge_points: ['异分母分数加法'],
  }
}

async function runRealFirstProcess(paths, capability, deadlineAt, ownership) {
  const audit = []
  const llm = assertRealLLMProjection(
    await apiJSON(paths.origin, capability, audit, 'GET', '/api/v1/config/llm', {
      code: 'REAL_LLM_PROJECTION_FAILED',
    }),
  )
  const im = assertIMInstancesDisabled(
    await apiJSON(paths.origin, capability, audit, 'GET', '/api/v1/platforms/instances', {
      code: 'REAL_IM_PROJECTION_FAILED',
    }),
  )
  const agentName = `hc-k12-practice-${sha256Text(randomUUID()).slice(0, 16)}`
  const sourceSession = `practice-real-${randomUUID()}`
  const marker = `PRACTICE-${randomUUID()}`
  ownership.agent_name = agentName
  ownership.source_session = sourceSession
  ownership.marker = marker
  const agentsBefore = await apiJSON(paths.origin, capability, audit, 'GET', '/api/v1/agents', {
    code: 'REAL_AGENT_PREFLIGHT_FAILED',
  })
  assertAgentAbsent(agentsBefore, agentName)
  await apiJSON(paths.origin, capability, audit, 'POST', '/api/v1/agents', {
    body: buildRealOwnedAgent(agentName),
    code: 'REAL_AGENT_CREATE_FAILED',
  })
  ownership.agent_created = true

  const created = await apiJSON(
    paths.origin,
    capability,
    audit,
    'POST',
    '/api/k12/record-mistake',
    {
      body: buildRealMistake(agentName, sourceSession, marker),
      code: 'REAL_MISTAKE_CREATE_FAILED',
    },
  )
  if (created?.record_created !== true) fail('REAL_MISTAKE_CREATE_INVALID')
  const mistakeID = nonEmpty(created.record_id, 'REAL_MISTAKE_CREATE_INVALID')
  ownership.mistake_id = mistakeID
  ownership.mistake_created = true
  const automation = await assertNoOwnedAutomation(paths.origin, capability, audit, ownership)
  const generationPath = `/api/k12/mistakes/${encodeURIComponent(mistakeID)}/practice-generation`
  const generationQuery = `${generationPath}?agent=${encodeURIComponent(agentName)}`
  const initial = assertPracticeProjection(
    await apiJSON(paths.origin, capability, audit, 'GET', generationQuery, {
      code: 'REAL_INITIAL_PROJECTION_FAILED',
    }),
    'available',
  )
  if (initial.source_id !== mistakeID) fail('REAL_SOURCE_IDENTITY_DRIFT')
  const command = {
    agent: agentName,
    idempotency_key: `practice-real-command-${randomUUID()}`,
    grade: '五年级下',
    textbook: '人教版',
    difficulty: 'same',
    provider: REAL_PROVIDER,
    model: REAL_MODEL,
    source_session: sourceSession,
  }
  const admitted = await apiJSON(paths.origin, capability, audit, 'POST', generationPath, {
    body: command,
    expectedStatus: 202,
    code: 'REAL_GENERATION_ADMISSION_FAILED',
  })
  assertPracticeProjection(admitted, 'pending')
  const terminalRaw = await pollProjection(
    async () => {
      const value = await apiJSON(paths.origin, capability, audit, 'GET', generationQuery, {
        code: 'REAL_GENERATION_PROJECTION_FAILED',
        timeoutMs: remaining(deadlineAt, REQUEST_TIMEOUT_MS, 'REAL_GENERATION_BUDGET_EXHAUSTED'),
      })
      classifyRealGenerationObservation(value)
      return value
    },
    REAL_SETTLED_GENERATION_STATES,
    deadlineAt,
    'REAL_GENERATION_TERMINAL_TIMEOUT',
    realGenerationTerminalBudgetMilliseconds(deadlineAt),
  )
  if (terminalRaw?.state !== 'joined') fail('REAL_GENERATION_NOT_JOINED')
  const terminal = projectRealJoinedPractice(terminalRaw)
  const receiptPath = `${generationPath}/receipts?agent=${encodeURIComponent(agentName)}`
  const receiptsRaw = await apiJSON(paths.origin, capability, audit, 'GET', receiptPath, {
    code: 'REAL_RECEIPT_PROJECTION_FAILED',
  })
  const receipts = assertRealPracticeReceipts(receiptsRaw)
  const practiceSetsRaw = await apiJSON(
    paths.origin,
    capability,
    audit,
    'GET',
    `/api/k12/practice-sets?agent=${encodeURIComponent(agentName)}`,
    { code: 'REAL_PRACTICE_SET_PROJECTION_FAILED' },
  )
  const exactSet = projectRealPracticeExactSet(practiceSetsRaw, terminal.identity.generation_id)
  assertRealPracticeItemProjectionAgreement(terminal, exactSet)
  const generationPostCount = audit.filter(
    (entry) => entry.method === 'POST' && entry.path === generationPath,
  ).length
  if (generationPostCount !== 1) fail('REAL_GENERATION_POST_COUNT_INVALID')
  if (candidateEndpointCalls(audit) !== 0) fail('CANDIDATE_SELECTION_SURFACED')
  return {
    audit,
    llm,
    im,
    automation,
    agentName,
    mistakeID,
    generationPath,
    generationQuery,
    receiptPath,
    terminal,
    receiptsRaw,
    receipts,
    exactSet,
    generation_post_count: generationPostCount,
  }
}

async function runRealRestart(paths, oldCapability, capability, first, deadlineAt) {
  const audit = []
  await apiJSON(paths.origin, oldCapability, audit, 'GET', '/api/v1/agents', {
    expectedStatus: 401,
    code: 'REAL_OLD_CAPABILITY_NOT_REJECTED',
  })
  assertRealLLMProjection(
    await apiJSON(paths.origin, capability, audit, 'GET', '/api/v1/config/llm', {
      code: 'REAL_RESTART_LLM_PROJECTION_FAILED',
    }),
  )
  assertIMInstancesDisabled(
    await apiJSON(paths.origin, capability, audit, 'GET', '/api/v1/platforms/instances', {
      code: 'REAL_RESTART_IM_PROJECTION_FAILED',
    }),
  )
  const terminalRaw = await apiJSON(paths.origin, capability, audit, 'GET', first.generationQuery, {
    code: 'REAL_RESTART_GENERATION_PROJECTION_FAILED',
    timeoutMs: remaining(deadlineAt, REQUEST_TIMEOUT_MS, 'REAL_RESTART_BUDGET_EXHAUSTED'),
  })
  const terminal = projectRealJoinedPractice(terminalRaw)
  const receiptsRaw = await apiJSON(paths.origin, capability, audit, 'GET', first.receiptPath, {
    code: 'REAL_RESTART_RECEIPT_PROJECTION_FAILED',
  })
  const receipts = assertRealPracticeReceipts(receiptsRaw)
  const practiceSetsRaw = await apiJSON(
    paths.origin,
    capability,
    audit,
    'GET',
    `/api/k12/practice-sets?agent=${encodeURIComponent(first.agentName)}`,
    { code: 'REAL_RESTART_PRACTICE_SET_PROJECTION_FAILED' },
  )
  const exactSet = projectRealPracticeExactSet(practiceSetsRaw, terminal.identity.generation_id)
  if (
    canonicalJSON(terminal.raw) !== canonicalJSON(first.terminal.raw) ||
    canonicalJSON(exactSet.raw_items) !== canonicalJSON(first.exactSet.raw_items) ||
    canonicalJSON(receiptsRaw) !== canonicalJSON(first.receiptsRaw)
  ) {
    fail('REAL_RESTART_DEEP_EQUAL_FAILED')
  }
  const postCount = audit.filter((entry) => entry.method === 'POST').length
  const mutationCount = audit.filter((entry) => entry.method !== 'GET').length
  if (postCount !== 0 || mutationCount !== 0) fail('REAL_RESTART_NOT_GET_ONLY')
  return {
    product_post_count: 0,
    product_mutation_count: 0,
    physical_provider_call_count_delta:
      receipts.physical_provider_call_count - first.receipts.physical_provider_call_count,
    projection: terminal.evidence,
    exact_set: exactSet.evidence,
    receipts,
  }
}

async function readRealFailurePublicResult(origin, capability, method, path, code) {
  const audit = []
  try {
    const value = await apiJSON(origin, capability, audit, method, path, { code })
    return { http_status: audit.at(-1)?.status ?? 200, value }
  } catch (error) {
    return {
      http_status: audit.at(-1)?.status ?? 0,
      error_code: safeCode(error),
    }
  }
}

async function captureRealFailurePublicEvidence(paths, capability, ownership) {
  const generationPath = `/api/k12/mistakes/${encodeURIComponent(ownership.mistake_id)}/practice-generation`
  const query = `?agent=${encodeURIComponent(ownership.agent_name)}`
  const projectionResult = await readRealFailurePublicResult(
    paths.origin,
    capability,
    'GET',
    `${generationPath}${query}`,
    'REAL_FAILURE_PROJECTION_UNAVAILABLE',
  )
  const receiptResult = await readRealFailurePublicResult(
    paths.origin,
    capability,
    'GET',
    `${generationPath}/receipts${query}`,
    'REAL_FAILURE_RECEIPTS_UNAVAILABLE',
  )
  return {
    ...projectRealFailurePublicEvidence(projectionResult, receiptResult, ownership),
    cleanup: {
      attempted: false,
      mistake_deleted: !ownership.mistake_created,
      agent_deleted: !ownership.agent_created,
      verified: !ownership.mistake_created && !ownership.agent_created,
    },
  }
}

async function cleanupRealOwnedObjects(paths, capability, ownership) {
  const audit = []
  if (
    typeof ownership.agent_name !== 'string' ||
    !ownership.agent_name.startsWith('hc-k12-practice-')
  ) {
    fail('REAL_CLEANUP_OWNERSHIP_INVALID')
  }
  let mistakeDeleted = !ownership.mistake_created
  let agentDeleted = !ownership.agent_created
  if (ownership.mistake_created) {
    await apiJSON(
      paths.origin,
      capability,
      audit,
      'DELETE',
      `/api/k12/mistakes/${encodeURIComponent(ownership.mistake_id)}?agent=${encodeURIComponent(ownership.agent_name)}`,
      { code: 'REAL_MISTAKE_CLEANUP_FAILED' },
    )
    const mistakes = await apiJSON(
      paths.origin,
      capability,
      audit,
      'GET',
      `/api/k12/mistakes?agent=${encodeURIComponent(ownership.agent_name)}`,
      { code: 'REAL_MISTAKE_CLEANUP_VERIFY_FAILED' },
    )
    const items = Array.isArray(mistakes?.items) ? mistakes.items : []
    if (items.some((item) => item?.record_id === ownership.mistake_id)) {
      fail('REAL_MISTAKE_CLEANUP_VERIFY_FAILED')
    }
    mistakeDeleted = true
    ownership.mistake_created = false
  }
  if (ownership.agent_created) {
    await apiJSON(
      paths.origin,
      capability,
      audit,
      'DELETE',
      `/api/v1/agents/${encodeURIComponent(ownership.agent_name)}`,
      { code: 'REAL_AGENT_CLEANUP_FAILED' },
    )
    const agents = await apiJSON(paths.origin, capability, audit, 'GET', '/api/v1/agents', {
      code: 'REAL_AGENT_CLEANUP_VERIFY_FAILED',
    })
    const rows = Array.isArray(agents?.agents) ? agents.agents : []
    if (rows.some((agent) => agent?.name === ownership.agent_name)) {
      fail('REAL_AGENT_CLEANUP_VERIFY_FAILED')
    }
    agentDeleted = true
    ownership.agent_created = false
  }
  return {
    mistake_deleted: mistakeDeleted,
    agent_deleted: agentDeleted,
    verified: mistakeDeleted && agentDeleted,
  }
}

async function runRealDefaultProfile(env = process.env) {
  if (env.HEXCLAW_PRACTICE_ONECLICK_RUN !== '1') fail('RUN_NOT_ENABLED')
  await loadContract()
  const deadlineAt = Date.now() + phaseBudgetMilliseconds(env)
  const paths = resolveRealDefaultProfileInputs(env)
  const attestation = await attestRealDefaultProfile(paths)
  await assertRealDefaultPortAvailable()
  const ownership = {
    agent_name: '',
    source_session: '',
    marker: '',
    agent_created: false,
    mistake_id: '',
    mistake_created: false,
  }
  let activeSidecar
  let activeCapability = ''
  let cleanup
  let failureEvidence
  try {
    const firstCapability = randomBytes(32).toString('hex')
    activeCapability = firstCapability
    activeSidecar = startRealDefaultProfileSidecar(paths, firstCapability, env)
    await waitForHealth(paths.origin, activeSidecar, deadlineAt)
    const first = await runRealFirstProcess(paths, firstCapability, deadlineAt, ownership)
    await stopSidecar(activeSidecar)
    activeSidecar = null
    activeCapability = ''
    await waitForPortRelease(REAL_DEFAULT_PROFILE_PORT)

    const secondCapability = randomBytes(32).toString('hex')
    if (secondCapability === firstCapability) fail('CAPABILITY_ROTATION_FAILED')
    activeCapability = secondCapability
    activeSidecar = startRealDefaultProfileSidecar(paths, secondCapability, env)
    await waitForHealth(paths.origin, activeSidecar, deadlineAt)
    const restart = await runRealRestart(
      paths,
      firstCapability,
      secondCapability,
      first,
      deadlineAt,
    )
    cleanup = await cleanupRealOwnedObjects(paths, secondCapability, ownership)
    const evidence = {
      schema_version: 1,
      status: 'passed',
      mode: 'real_default_profile',
      candidate: {
        sidecar_sha256: attestation.sidecar_sha256,
        config_sha256: attestation.config_sha256,
      },
      boundary: {
        candidate: 'installed_app_sidecar',
        default_profile: true,
        home_modified: false,
        config_copied: false,
        public_api_only: true,
        direct_store_read: false,
        sqlite_seed_or_write: false,
        im_enabled: false,
        im_calls: 0,
      },
      route: {
        provider: REAL_PROVIDER,
        model: REAL_MODEL,
        fallback_allowed: false,
      },
      owned_fixture: {
        agent_name_sha256: sha256Text(first.agentName),
        mistake_id_sha256: sha256Text(first.mistakeID),
        marker_sha256: sha256Text(ownership.marker),
      },
      first_process: {
        generation_post_count: first.generation_post_count,
        projection: first.terminal.evidence,
        exact_set: first.exactSet.evidence,
        receipts: first.receipts,
        im: first.im,
        automation: first.automation,
      },
      restart,
      cleanup,
    }
    assertRealRunEvidence(evidence)
    return evidence
  } catch (error) {
    if (activeSidecar && activeCapability !== '' && ownership.mistake_created) {
      try {
        failureEvidence = await captureRealFailurePublicEvidence(paths, activeCapability, ownership)
      } catch (captureError) {
        failureEvidence = unavailableRealFailurePublicEvidence(ownership, safeCode(captureError))
        failureEvidence.cleanup = {
          attempted: false,
          mistake_deleted: !ownership.mistake_created,
          agent_deleted: !ownership.agent_created,
          verified: !ownership.mistake_created && !ownership.agent_created,
        }
      }
      throw attachFailureEvidence(error, failureEvidence)
    }
    throw error
  } finally {
    if (
      activeSidecar &&
      activeCapability !== '' &&
      (ownership.mistake_created || ownership.agent_created)
    ) {
      try {
        cleanup = await cleanupRealOwnedObjects(paths, activeCapability, ownership)
        if (failureEvidence) {
          failureEvidence.cleanup = { attempted: true, ...cleanup }
        }
      } catch (cleanupError) {
        if (failureEvidence) {
          failureEvidence.cleanup = {
            attempted: true,
            mistake_deleted: !ownership.mistake_created,
            agent_deleted: !ownership.agent_created,
            verified: false,
            error_code: safeCode(cleanupError),
          }
        }
      }
    }
    if (activeSidecar) {
      const stopped = await stopSidecar(activeSidecar)
      if (failureEvidence) {
        failureEvidence.sidecar = stopped
      }
    }
  }
}

async function main() {
  const phase = resolvePhase(process.argv.slice(2))
  const realDefaultProfile = resolveExecutionMode(process.env) === 'real_default_profile'
  const result = realDefaultProfile
    ? phase === 'validate'
      ? await validateRealPhase(process.env)
      : await runRealDefaultProfile(process.env)
    : phase === 'validate'
      ? await validatePhase(process.env)
      : await runPhase(process.env)
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

const entry = process.argv[1]
if (entry && isAbsolute(entry) && import.meta.url === pathToFileURL(resolve(entry)).href) {
  main().catch((error) => {
    process.stdout.write(`${JSON.stringify(failureOutput(error))}\n`)
    process.exitCode = 1
  })
}
