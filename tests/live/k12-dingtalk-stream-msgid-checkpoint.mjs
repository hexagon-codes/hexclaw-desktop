#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { chmod, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

const LIVE_ROOT = dirname(fileURLToPath(import.meta.url))
const CONTRACT_PATH = resolve(LIVE_ROOT, 'k12-dingtalk-stream-msgid-checkpoint.contract.json')
const PUBLIC_QUERY_PATH = '/api/k12/dingtalk-inbound'
const REQUIRED_ROLES = Object.freeze(['original', 'redelivery', 'independent_same_bytes'])
const PHASES = Object.freeze(['validate', 'verify-current', 'verify-restart', 'status'])
const DEFAULT_TIMEOUT_MS = 120_000
const HARD_TIMEOUT_MS = 29 * 60_000
const PENDING_EXIT_CODE = 3
const BASELINE_SUFFIX = '.restart-baseline.json'
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u
const EXACT_PROJECTION_FIELDS = Object.freeze([
  'receipt.identity',
  'receipt.agent_name',
  'receipt.receipt_id',
  'receipt.binding_id',
  'receipt.command_digest',
  'asset.asset_id',
  'asset.receipt_id',
  'asset.mime',
  'asset.size',
  'asset.digest',
  'dispatch.receipt_id',
  'dispatch.dispatch_id',
  'dispatch.processing_status',
  'dispatch.routing_decision',
  'dispatch.confirmation_status',
  'dispatch.reply_status',
  'dispatch.version',
  'dispatch.image_task_id',
  'dispatch.final_artifact_id',
  'dispatch.delivery_batch_id',
])

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

function object(value, code) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(code)
  return value
}

function nonEmptyString(value, code) {
  if (typeof value !== 'string' || value.trim() === '' || value !== value.trim()) fail(code)
  return value
}

function positiveSafeInteger(value, code) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(code)
  return value
}

function digest(value, code) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) fail(code)
  return value
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function canonicalJSON(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function equal(left, right, code) {
  if (!isDeepStrictEqual(left, right)) fail(code)
}

function validateIdentity(value) {
  const identity = object(value, 'IDENTITY_REQUIRED')
  if (nonEmptyString(identity.platform, 'PLATFORM_REQUIRED') !== 'dingtalk') {
    fail('DINGTALK_PLATFORM_REQUIRED')
  }
  nonEmptyString(identity.instance_id, 'INSTANCE_ID_REQUIRED')
  nonEmptyString(identity.chat_id, 'CHAT_ID_REQUIRED')
  nonEmptyString(identity.provider_message_id, 'PROVIDER_MESSAGE_ID_REQUIRED')
  return {
    platform: identity.platform,
    instance_id: identity.instance_id,
    chat_id: identity.chat_id,
    provider_message_id: identity.provider_message_id,
  }
}

function validateAdmission(value, imageDigest) {
  const admission = object(value, 'ADMISSION_REQUIRED')
  const result = {
    receipt_id: nonEmptyString(admission.receipt_id, 'RECEIPT_ID_REQUIRED'),
    asset_id: nonEmptyString(admission.asset_id, 'ASSET_ID_REQUIRED'),
    dispatch_id: nonEmptyString(admission.dispatch_id, 'DISPATCH_ID_REQUIRED'),
    command_digest: digest(admission.command_digest, 'COMMAND_DIGEST_REQUIRED'),
    asset_digest: digest(admission.asset_digest, 'ASSET_DIGEST_REQUIRED'),
  }
  if (result.asset_digest !== imageDigest) fail('ADMISSION_ASSET_DIGEST_DRIFT')
  return result
}

function validateOrdering(value) {
  const ordering = object(value, 'ACK_ORDERING_REQUIRED')
  const result = {
    callback_entered_seq: positiveSafeInteger(
      ordering.callback_entered_seq,
      'CALLBACK_ENTERED_SEQUENCE_REQUIRED',
    ),
    v88_admission_committed_seq: positiveSafeInteger(
      ordering.v88_admission_committed_seq,
      'V88_COMMIT_SEQUENCE_REQUIRED',
    ),
    sdk_ack_returned_seq: positiveSafeInteger(
      ordering.sdk_ack_returned_seq,
      'SDK_ACK_SEQUENCE_REQUIRED',
    ),
    ack_success: ordering.ack_success,
  }
  if (result.ack_success !== true) fail('STREAM_ACK_NOT_SUCCESSFUL')
  if (
    result.callback_entered_seq >= result.v88_admission_committed_seq ||
    result.v88_admission_committed_seq >= result.sdk_ack_returned_seq
  ) {
    fail('ACK_PRECEDED_V88_COMMIT')
  }
  return result
}

function validateObservation(value) {
  const observation = object(value, 'STREAM_OBSERVATION_REQUIRED')
  if (!REQUIRED_ROLES.includes(observation.role)) fail('STREAM_OBSERVATION_ROLE_INVALID')
  const imageDigest = digest(observation.image_digest, 'IMAGE_DIGEST_REQUIRED')
  if (observation.provider_message_id_origin !== 'BotCallbackDataModel.MsgId') {
    fail('RANDOM_FALLBACK_ID_FORBIDDEN')
  }
  return {
    role: observation.role,
    stream_observation_id: nonEmptyString(
      observation.stream_observation_id,
      'STREAM_OBSERVATION_ID_REQUIRED',
    ),
    provider_message_id_origin: observation.provider_message_id_origin,
    identity: validateIdentity(observation.identity),
    image_digest: imageDigest,
    admission: validateAdmission(observation.admission, imageDigest),
    ordering: validateOrdering(observation.ordering),
  }
}

export function validateContract(value) {
  const contract = object(value, 'CONTRACT_REQUIRED')
  if (contract.schema_version !== 1) fail('CONTRACT_SCHEMA_INVALID')
  if (contract.scenario !== 'k12_dingtalk_stream_native_msgid_durability') {
    fail('CONTRACT_SCENARIO_INVALID')
  }
  equal(contract.phases, PHASES, 'CONTRACT_PHASES_INVALID')
  const source = object(contract.source, 'CONTRACT_SOURCE_INVALID')
  if (
    source.required_transport !== 'dingtalk_stream_sdk_go' ||
    source.callback_model !== 'BotCallbackDataModel' ||
    source.callback_entrypoint !== 'DingtalkAdapter.onChatBotMessage' ||
    source.bound_application_instance !== true ||
    source.provider_message_id_origin !== 'BotCallbackDataModel.MsgId'
  ) {
    fail('CONTRACT_STREAM_SOURCE_INVALID')
  }
  const observations = object(contract.observations, 'CONTRACT_OBSERVATIONS_INVALID')
  equal(observations.required_roles, REQUIRED_ROLES, 'CONTRACT_ROLES_INVALID')
  equal(
    observations.ack_order,
    ['callback_entered', 'v88_admission_committed', 'sdk_ack_returned'],
    'CONTRACT_ACK_ORDER_INVALID',
  )
  if (observations.ack_success_required !== true) fail('CONTRACT_ACK_SUCCESS_INVALID')
  const checkpointInput = object(contract.checkpoint_input, 'CONTRACT_CHECKPOINT_INPUT_INVALID')
  const checkpointTopLevel = ['schema_version', 'source', 'agent_name', 'observations']
  const checkpointSource = [
    'transport',
    'callback_model',
    'callback_entrypoint',
    'bound_application_instance',
    'signed_http_webhook_used',
    'direct_dingtalk_api_used',
    'dws_cli_used',
  ]
  const checkpointObservation = [
    'role',
    'stream_observation_id',
    'provider_message_id_origin',
    'identity',
    'image_digest',
    'admission',
    'ordering',
  ]
  const checkpointIdentity = ['platform', 'instance_id', 'chat_id', 'provider_message_id']
  const checkpointAdmission = [
    'receipt_id',
    'asset_id',
    'dispatch_id',
    'command_digest',
    'asset_digest',
  ]
  const checkpointOrdering = [
    'callback_entered_seq',
    'v88_admission_committed_seq',
    'sdk_ack_returned_seq',
    'ack_success',
  ]
  if (checkpointInput.file_mode !== '0600') fail('CONTRACT_CHECKPOINT_INPUT_INVALID')
  equal(
    checkpointInput.required_top_level_fields,
    checkpointTopLevel,
    'CONTRACT_CHECKPOINT_INPUT_INVALID',
  )
  equal(
    checkpointInput.required_source_fields,
    checkpointSource,
    'CONTRACT_CHECKPOINT_INPUT_INVALID',
  )
  equal(
    checkpointInput.required_observation_fields,
    checkpointObservation,
    'CONTRACT_CHECKPOINT_INPUT_INVALID',
  )
  equal(
    checkpointInput.required_identity_fields,
    checkpointIdentity,
    'CONTRACT_CHECKPOINT_INPUT_INVALID',
  )
  equal(
    checkpointInput.required_admission_fields,
    checkpointAdmission,
    'CONTRACT_CHECKPOINT_INPUT_INVALID',
  )
  equal(
    checkpointInput.required_ordering_fields,
    checkpointOrdering,
    'CONTRACT_CHECKPOINT_INPUT_INVALID',
  )
  const publicQuery = object(contract.public_query, 'CONTRACT_PUBLIC_QUERY_INVALID')
  if (
    publicQuery.method !== 'GET' ||
    publicQuery.path !== PUBLIC_QUERY_PATH ||
    publicQuery.agent_query_required !== true ||
    publicQuery.process_capability_required !== true ||
    publicQuery.loopback_only !== true
  ) {
    fail('CONTRACT_PUBLIC_QUERY_INVALID')
  }
  equal(
    publicQuery.identity_fields,
    ['platform', 'instance_id', 'chat_id', 'provider_message_id'],
    'CONTRACT_IDENTITY_FIELDS_INVALID',
  )
  const stable = object(contract.stable_projection, 'CONTRACT_STABLE_PROJECTION_INVALID')
  if (stable.processing_status !== 'final_artifact_ready' || stable.reply_status !== 'delivered') {
    fail('CONTRACT_STABLE_PROJECTION_INVALID')
  }
  equal(contract.restart_exact_set, EXACT_PROJECTION_FIELDS, 'CONTRACT_RESTART_SET_INVALID')
  const forbiddenActions = [
    'signed_http_webhook',
    'callback_injection',
    'direct_dingtalk_api',
    'dws_cli',
    'outbound_send',
    'direct_store_read_or_write',
  ]
  equal(contract.forbidden_actions, forbiddenActions, 'CONTRACT_FORBIDDEN_ACTIONS_INVALID')
  const evidence = object(contract.evidence, 'CONTRACT_EVIDENCE_INVALID')
  if (
    evidence.checkpoint_mode !== '0600' ||
    evidence.baseline_mode !== '0600' ||
    evidence.raw_identity_in_public_evidence !== false ||
    evidence.raw_callback_in_evidence !== false ||
    evidence.credentials_in_evidence !== false ||
    evidence.hash_algorithm !== 'sha256'
  ) {
    fail('CONTRACT_EVIDENCE_INVALID')
  }
  const policy = object(contract.phase_policy, 'CONTRACT_PHASE_POLICY_INVALID')
  if (
    policy.default_timeout_ms !== DEFAULT_TIMEOUT_MS ||
    policy.hard_timeout_ms !== HARD_TIMEOUT_MS ||
    policy.pending_exit_code !== PENDING_EXIT_CODE ||
    policy.baseline_suffix !== BASELINE_SUFFIX
  ) {
    fail('CONTRACT_PHASE_POLICY_INVALID')
  }
  return {
    phases: [...PHASES],
    requiredTransport: source.required_transport,
    callbackModel: source.callback_model,
    callbackEntrypoint: source.callback_entrypoint,
    requiredRoles: [...REQUIRED_ROLES],
    publicQuery: { method: publicQuery.method, path: publicQuery.path },
    checkpointInput: {
      fileMode: checkpointInput.file_mode,
      topLevel: checkpointTopLevel,
      source: checkpointSource,
      observation: checkpointObservation,
      identity: checkpointIdentity,
      admission: checkpointAdmission,
      ordering: checkpointOrdering,
    },
    forbiddenActions,
    restartExactSet: [...EXACT_PROJECTION_FIELDS],
  }
}

export function validateCheckpoint(value) {
  const checkpoint = object(value, 'CHECKPOINT_REQUIRED')
  if (checkpoint.schema_version !== 1) fail('CHECKPOINT_SCHEMA_INVALID')
  const source = object(checkpoint.source, 'STREAM_SOURCE_REQUIRED')
  if (
    source.transport !== 'dingtalk_stream_sdk_go' ||
    source.callback_model !== 'BotCallbackDataModel' ||
    source.callback_entrypoint !== 'DingtalkAdapter.onChatBotMessage' ||
    source.bound_application_instance !== true ||
    source.signed_http_webhook_used !== false ||
    source.direct_dingtalk_api_used !== false ||
    source.dws_cli_used !== false
  ) {
    fail('STREAM_SOURCE_REQUIRED')
  }
  const agentName = nonEmptyString(checkpoint.agent_name, 'AGENT_NAME_REQUIRED')
  if (!Array.isArray(checkpoint.observations) || checkpoint.observations.length !== 3) {
    fail('THREE_STREAM_OBSERVATIONS_REQUIRED')
  }
  const observations = checkpoint.observations.map(validateObservation)
  const roles = observations.map((item) => item.role)
  if (new Set(roles).size !== REQUIRED_ROLES.length) fail('STREAM_OBSERVATION_ROLE_DUPLICATED')
  for (const role of REQUIRED_ROLES) {
    if (!roles.includes(role)) fail('STREAM_OBSERVATION_ROLE_MISSING')
  }
  const observationIDs = observations.map((item) => item.stream_observation_id)
  if (new Set(observationIDs).size !== observationIDs.length)
    fail('STREAM_OBSERVATION_ID_DUPLICATED')

  const byRole = new Map(observations.map((item) => [item.role, item]))
  const original = byRole.get('original')
  const redelivery = byRole.get('redelivery')
  const independent = byRole.get('independent_same_bytes')
  equal(original.identity, redelivery.identity, 'REDELIVERY_IDENTITY_DRIFT')
  if (original.image_digest !== redelivery.image_digest) fail('REDELIVERY_PAYLOAD_DRIFT')
  equal(original.admission, redelivery.admission, 'REDELIVERY_ADMISSION_DRIFT')
  if (
    original.identity.platform !== independent.identity.platform ||
    original.identity.instance_id !== independent.identity.instance_id ||
    original.identity.chat_id !== independent.identity.chat_id ||
    original.identity.provider_message_id === independent.identity.provider_message_id
  ) {
    fail('INDEPENDENT_MSGID_REQUIRED')
  }
  if (original.image_digest !== independent.image_digest) fail('SAME_IMAGE_BYTES_REQUIRED')
  if (
    original.admission.receipt_id === independent.admission.receipt_id ||
    original.admission.asset_id === independent.admission.asset_id ||
    original.admission.dispatch_id === independent.admission.dispatch_id
  ) {
    fail('INDEPENDENT_ADMISSION_REQUIRED')
  }
  return {
    schema_version: 1,
    source: { ...source },
    agentName,
    observations,
    original,
    redelivery,
    independent,
    uniqueProviderMessageIDs: [
      original.identity.provider_message_id,
      independent.identity.provider_message_id,
    ],
  }
}

function loopbackBaseURL(value) {
  const raw = nonEmptyString(value, 'BASE_URL_REQUIRED')
  let url
  try {
    url = new URL(raw)
  } catch {
    fail('LOOPBACK_BASE_URL_REQUIRED')
  }
  const hosts = new Set(['127.0.0.1', 'localhost', '[::1]'])
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !hosts.has(url.hostname) ||
    url.username !== '' ||
    url.password !== '' ||
    (url.pathname !== '' && url.pathname !== '/') ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    fail('LOOPBACK_BASE_URL_REQUIRED')
  }
  return url
}

export async function queryInboundProjection({
  fetchImpl = globalThis.fetch,
  baseURL,
  capability,
  agentName,
  identity,
  timeoutMS = DEFAULT_TIMEOUT_MS,
}) {
  if (typeof fetchImpl !== 'function') fail('FETCH_IMPLEMENTATION_REQUIRED')
  const base = loopbackBaseURL(baseURL)
  const token = nonEmptyString(capability, 'PROCESS_CAPABILITY_REQUIRED')
  const agent = nonEmptyString(agentName, 'AGENT_NAME_REQUIRED')
  const exactIdentity = validateIdentity(identity)
  const url = new URL(PUBLIC_QUERY_PATH, base)
  url.searchParams.set('agent', agent)
  for (const [key, value] of Object.entries(exactIdentity)) url.searchParams.set(key, value)
  let response
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(Math.min(Math.max(1, timeoutMS), HARD_TIMEOUT_MS)),
    })
  } catch {
    fail('PUBLIC_QUERY_TRANSPORT_FAILED')
  }
  if (response?.ok !== true) fail(`PUBLIC_QUERY_HTTP_${response?.status ?? 'UNKNOWN'}`)
  try {
    return await response.json()
  } catch {
    fail('PUBLIC_QUERY_JSON_INVALID')
  }
}

function requiredProjectionString(value, code) {
  return nonEmptyString(value, code)
}

function projectionExactSet(value) {
  const projection = object(value, 'PUBLIC_PROJECTION_REQUIRED')
  const receipt = object(projection.receipt, 'PUBLIC_RECEIPT_REQUIRED')
  const asset = object(projection.asset, 'PUBLIC_ASSET_REQUIRED')
  const dispatch = object(projection.dispatch, 'PUBLIC_DISPATCH_REQUIRED')
  return {
    receipt: {
      identity: validateIdentity(receipt.identity),
      agent_name: requiredProjectionString(receipt.agent_name, 'PUBLIC_AGENT_REQUIRED'),
      receipt_id: requiredProjectionString(receipt.receipt_id, 'PUBLIC_RECEIPT_ID_REQUIRED'),
      binding_id: requiredProjectionString(receipt.binding_id, 'PUBLIC_BINDING_ID_REQUIRED'),
      command_digest: digest(receipt.command_digest, 'PUBLIC_COMMAND_DIGEST_REQUIRED'),
    },
    asset: {
      asset_id: requiredProjectionString(asset.asset_id, 'PUBLIC_ASSET_ID_REQUIRED'),
      receipt_id: requiredProjectionString(asset.receipt_id, 'PUBLIC_ASSET_RECEIPT_REQUIRED'),
      mime: requiredProjectionString(asset.mime, 'PUBLIC_ASSET_MIME_REQUIRED'),
      size: positiveSafeInteger(asset.size, 'PUBLIC_ASSET_SIZE_REQUIRED'),
      digest: digest(asset.digest, 'PUBLIC_ASSET_DIGEST_REQUIRED'),
    },
    dispatch: {
      receipt_id: requiredProjectionString(dispatch.receipt_id, 'PUBLIC_DISPATCH_RECEIPT_REQUIRED'),
      dispatch_id: requiredProjectionString(dispatch.dispatch_id, 'PUBLIC_DISPATCH_ID_REQUIRED'),
      processing_status: requiredProjectionString(
        dispatch.processing_status,
        'PUBLIC_PROCESSING_STATUS_REQUIRED',
      ),
      routing_decision: requiredProjectionString(
        dispatch.routing_decision,
        'PUBLIC_ROUTING_DECISION_REQUIRED',
      ),
      confirmation_status: requiredProjectionString(
        dispatch.confirmation_status,
        'PUBLIC_CONFIRMATION_STATUS_REQUIRED',
      ),
      reply_status: requiredProjectionString(dispatch.reply_status, 'PUBLIC_REPLY_STATUS_REQUIRED'),
      version: positiveSafeInteger(dispatch.version, 'PUBLIC_DISPATCH_VERSION_REQUIRED'),
      image_task_id: requiredProjectionString(
        dispatch.image_task_id,
        'PUBLIC_IMAGE_TASK_ID_REQUIRED',
      ),
      final_artifact_id: requiredProjectionString(
        dispatch.final_artifact_id,
        'PUBLIC_FINAL_ARTIFACT_ID_REQUIRED',
      ),
      delivery_batch_id: requiredProjectionString(
        dispatch.delivery_batch_id,
        'PUBLIC_DELIVERY_BATCH_ID_REQUIRED',
      ),
    },
  }
}

function assertProjectionMatchesObservation(projection, observation, agentName) {
  equal(projection.receipt.identity, observation.identity, 'PUBLIC_IDENTITY_DRIFT')
  if (projection.receipt.agent_name !== agentName) fail('PUBLIC_AGENT_DRIFT')
  if (
    projection.receipt.receipt_id !== observation.admission.receipt_id ||
    projection.receipt.command_digest !== observation.admission.command_digest ||
    projection.asset.asset_id !== observation.admission.asset_id ||
    projection.asset.digest !== observation.admission.asset_digest ||
    projection.dispatch.dispatch_id !== observation.admission.dispatch_id
  ) {
    fail('PUBLIC_ADMISSION_DRIFT')
  }
  if (
    projection.asset.receipt_id !== projection.receipt.receipt_id ||
    projection.dispatch.receipt_id !== projection.receipt.receipt_id
  ) {
    fail('PUBLIC_RECEIPT_LINK_DRIFT')
  }
  if (
    projection.dispatch.processing_status !== 'final_artifact_ready' ||
    projection.dispatch.reply_status !== 'delivered'
  ) {
    fail('PUBLIC_PROJECTION_NOT_STABLE')
  }
}

export function assertCurrentProjections(checkpointValue, projectionsByProviderMessageID) {
  const checkpoint = validateCheckpoint(checkpointValue)
  if (!(projectionsByProviderMessageID instanceof Map)) fail('PUBLIC_PROJECTION_MAP_REQUIRED')
  const projections = []
  for (const observation of [checkpoint.original, checkpoint.independent]) {
    const raw = projectionsByProviderMessageID.get(observation.identity.provider_message_id)
    if (raw === undefined) fail('PUBLIC_PROJECTION_MISSING')
    const projection = projectionExactSet(raw)
    assertProjectionMatchesObservation(projection, observation, checkpoint.agentName)
    projections.push(projection)
  }
  if (projectionsByProviderMessageID.size !== projections.length) fail('PUBLIC_PROJECTION_EXTRA')
  if (
    projections[0].receipt.receipt_id === projections[1].receipt.receipt_id ||
    projections[0].asset.asset_id === projections[1].asset.asset_id ||
    projections[0].dispatch.dispatch_id === projections[1].dispatch.dispatch_id
  ) {
    fail('PUBLIC_INDEPENDENT_IDENTITY_COLLAPSED')
  }
  if (projections[0].asset.digest !== projections[1].asset.digest) {
    fail('PUBLIC_SAME_BYTES_DIGEST_DRIFT')
  }
  return { schema_version: 1, projections }
}

export function assertRestartExact(beforeValues, afterValues) {
  if (!Array.isArray(beforeValues) || !Array.isArray(afterValues)) {
    fail('RESTART_PROJECTIONS_REQUIRED')
  }
  const before = beforeValues.map(projectionExactSet)
  const after = afterValues.map(projectionExactSet)
  equal(before, after, 'RESTART_EXACT_SET_DRIFT')
  return before
}

function hashIdentity(identity) {
  return sha256(canonicalJSON(identity))
}

function hashAdmission(admission) {
  return {
    receipt_id_sha256: sha256(admission.receipt_id),
    asset_id_sha256: sha256(admission.asset_id),
    dispatch_id_sha256: sha256(admission.dispatch_id),
    command_digest: admission.command_digest,
    asset_digest: admission.asset_digest,
  }
}

export function sanitizeEvidence(checkpointValue, projectionValues) {
  const checkpoint = validateCheckpoint(checkpointValue)
  const projectionMap = new Map(
    projectionValues.map((value) => {
      const projection = projectionExactSet(value)
      return [projection.receipt.identity.provider_message_id, projection]
    }),
  )
  const current = assertCurrentProjections(checkpointValue, projectionMap)
  return {
    schema_version: 1,
    scenario: 'k12_dingtalk_stream_native_msgid_durability',
    source: {
      transport: checkpoint.source.transport,
      callback_model: checkpoint.source.callback_model,
      callback_entrypoint: checkpoint.source.callback_entrypoint,
      bound_application_instance: true,
    },
    agent_name_sha256: sha256(checkpoint.agentName),
    observations: checkpoint.observations.map((observation) => ({
      role: observation.role,
      stream_observation_id_sha256: sha256(observation.stream_observation_id),
      identity_sha256: hashIdentity(observation.identity),
      image_digest: observation.image_digest,
      admission: hashAdmission(observation.admission),
      ordering: observation.ordering,
    })),
    projections: current.projections.map((projection) => ({
      identity_sha256: hashIdentity(projection.receipt.identity),
      exact_projection_sha256: sha256(canonicalJSON(projection)),
      asset_digest: projection.asset.digest,
      processing_status: projection.dispatch.processing_status,
      reply_status: projection.dispatch.reply_status,
    })),
  }
}

export function checkpointRequirements() {
  return {
    status: 'checkpoint_required',
    checkpoint_contract: 'tests/live/k12-dingtalk-stream-msgid-checkpoint.contract.json',
    required_env: [
      'HEXCLAW_DINGTALK_STREAM_CHECKPOINT',
      'HEXCLAW_DINGTALK_STREAM_BASE_URL',
      'HEXCLAW_SIDECAR_CAPABILITY_TOKEN',
    ],
    required_real_observations: [...REQUIRED_ROLES],
    prohibited_substitutes: [
      'signed HTTP webhook',
      'private callback injection',
      'dws or DingTalk CLI',
      'direct DingTalk API',
      'synthetic provider MsgId',
    ],
    next_actions: [
      'capture one normal bound-app DingTalk Stream image callback',
      'capture a provider redelivery with the same native MsgId and bytes',
      'capture a second normal Stream message with a different native MsgId and the same bytes',
      'record V88 commit before successful SDK ACK for every callback',
      'run verify-current, restart the caller-owned app, then run verify-restart',
    ],
  }
}

export function resolvePhase(args = []) {
  if (!Array.isArray(args) || args.length > 1) fail('INVALID_PHASE')
  const phase = args.length === 0 ? 'status' : args[0]
  if (!PHASES.includes(phase)) fail('INVALID_PHASE')
  return phase
}

export function phaseBudgetMilliseconds(env = process.env) {
  const configured = Number.parseInt(env.HEXCLAW_DINGTALK_STREAM_PHASE_TIMEOUT_MS ?? '', 10)
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_TIMEOUT_MS
  return Math.min(configured, HARD_TIMEOUT_MS)
}

async function readJSON(path, code) {
  let raw
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    fail(code)
  }
  try {
    return JSON.parse(raw)
  } catch {
    fail(code)
  }
}

async function readPrivateCheckpoint(path) {
  const checkpointPath = nonEmptyString(path, 'CHECKPOINT_PATH_REQUIRED')
  let metadata
  try {
    metadata = await stat(checkpointPath)
  } catch {
    fail('CHECKPOINT_FILE_REQUIRED')
  }
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) fail('CHECKPOINT_FILE_MUST_BE_PRIVATE')
  const value = await readJSON(checkpointPath, 'CHECKPOINT_JSON_INVALID')
  validateCheckpoint(value)
  return value
}

async function writePrivateJSON(path, value) {
  const temporary = `${path}.tmp-${process.pid}`
  const payload = `${JSON.stringify(value, null, 2)}\n`
  await writeFile(temporary, payload, { encoding: 'utf8', mode: 0o600 })
  await chmod(temporary, 0o600)
  await rename(temporary, path)
  await chmod(path, 0o600)
}

async function queryAll(checkpoint, env) {
  const validated = validateCheckpoint(checkpoint)
  const projections = new Map()
  for (const observation of [validated.original, validated.independent]) {
    const value = await queryInboundProjection({
      baseURL: env.HEXCLAW_DINGTALK_STREAM_BASE_URL,
      capability: env.HEXCLAW_SIDECAR_CAPABILITY_TOKEN,
      agentName: validated.agentName,
      identity: observation.identity,
      timeoutMS: phaseBudgetMilliseconds(env),
    })
    projections.set(observation.identity.provider_message_id, value)
  }
  return assertCurrentProjections(checkpoint, projections).projections
}

async function loadContract() {
  const contract = await readJSON(CONTRACT_PATH, 'CONTRACT_JSON_INVALID')
  return { contract, projection: validateContract(contract) }
}

async function runPhase(phase, env) {
  const { projection: contract } = await loadContract()
  if (phase === 'validate') {
    return { status: 'contract_valid', contract }
  }
  const checkpointPath = env.HEXCLAW_DINGTALK_STREAM_CHECKPOINT
  if (!checkpointPath) {
    return { ...checkpointRequirements(), exit_code: PENDING_EXIT_CODE }
  }
  const checkpoint = await readPrivateCheckpoint(checkpointPath)
  if (phase === 'status') {
    return {
      status: 'checkpoint_ready',
      source_transport: checkpoint.source.transport,
      observation_roles: checkpoint.observations.map((item) => item.role),
      next_phase: 'verify-current',
    }
  }
  const baselinePath = `${checkpointPath}${BASELINE_SUFFIX}`
  const checkpointDigest = sha256(canonicalJSON(checkpoint))
  const current = await queryAll(checkpoint, env)
  if (phase === 'verify-current') {
    await writePrivateJSON(baselinePath, {
      schema_version: 1,
      kind: 'private_restart_baseline',
      checkpoint_sha256: checkpointDigest,
      projections: current,
    })
    return {
      status: 'current_verified',
      baseline_file_sha256: sha256(baselinePath),
      evidence: sanitizeEvidence(checkpoint, current),
      next_action: 'restart the caller-owned HexClaw app, then run verify-restart',
    }
  }
  const baseline = await readJSON(baselinePath, 'RESTART_BASELINE_REQUIRED')
  if (
    baseline.schema_version !== 1 ||
    baseline.kind !== 'private_restart_baseline' ||
    baseline.checkpoint_sha256 !== checkpointDigest ||
    !Array.isArray(baseline.projections)
  ) {
    fail('RESTART_BASELINE_INVALID')
  }
  assertRestartExact(baseline.projections, current)
  return {
    status: 'restart_exact_verified',
    evidence: sanitizeEvidence(checkpoint, current),
  }
}

async function main() {
  const phase = resolvePhase(process.argv.slice(2))
  const result = await runPhase(phase, process.env)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (result.exit_code === PENDING_EXIT_CODE) process.exitCode = PENDING_EXIT_CODE
}

const executedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (executedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const code = error instanceof HarnessError ? error.code : 'UNEXPECTED_HARNESS_FAILURE'
    process.stderr.write(`${JSON.stringify({ status: 'failed', code })}\n`)
    process.exitCode = 1
  })
}
