#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, lstat, mkdir, open, readFile, realpath, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium, request as playwrightRequest } from '@playwright/test'
import { createServer as createViteServer } from 'vite'

import {
  assertStageDigestChain,
  buildTrustedGeometryItems,
  validateContract as validateTrustedOracleContract,
} from './k12-dingtalk-photo-grading-headless.mjs'
import { parseSidecarBinding } from '../../scripts/ci/k12-current-bug-isolated-sidecar-control.mjs'
import { validateGradingCalibrationApproval } from '../../scripts/ci/k12-current-bug-fixture-orchestrator.mjs'
import { parseStrictJSON } from '../../scripts/ci/k12-strict-json.mjs'

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const LIVE_ROOT = dirname(SCRIPT_PATH)
const DESKTOP_ROOT = resolve(LIVE_ROOT, '../..')
const DEFAULT_DOCS_ROOT = resolve(DESKTOP_ROOT, '../hexclaw-docs')
const CONTRACT_PATH = resolve(LIVE_ROOT, 'k12-photo-grading-outbound-public-api.contract.json')
const DEFAULT_ORACLE_PATH = resolve(LIVE_ROOT, 'k12-dingtalk-photo-grading-headless.contract.json')
const DEFAULT_SIDECAR = '/Applications/HexClaw.app/Contents/MacOS/hexclaw'
const EXPECTED_PROVIDER = 'hexclaw-gpt'
const EXPECTED_MODEL = 'gpt-5.6-sol'
const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
const HARD_PHASE_MAX_MS = 29 * 60_000
const DEFAULT_PHASE_MS = 24 * 60_000
const REQUEST_TIMEOUT_MS = 90_000
const START_TIMEOUT_MS = 90_000
const PENDING_EXIT_CODE = 3
const CLEANUP_RESERVE_MS = 3 * 60_000
const SHA256 = /^[a-f0-9]{64}$/u
const PREFIXED_SHA256 = /^sha256:[a-f0-9]{64}$/u
const HAN = /[\u3400-\u9fff\uf900-\ufaff]/u
const GRADING_BUCKETS = Object.freeze([1, 8, 16, 32])
const GRADING_BUDGET_FIELDS = Object.freeze([
  'assessing_buckets',
  'item_concurrency',
  'locating_seconds',
  'normalizing_seconds',
  'policy_version',
  'projecting_seconds',
  'queued_seconds',
  'recognizing_seconds',
  'rendering_seconds',
])
const GRADING_ARTIFACT_FIELDS = Object.freeze([
  'approval_ref',
  'approval_status',
  'evidence_sha256',
  'grading_budget',
  'measurements',
  'model',
  'provider',
  'schema_version',
  'sidecar_config_sha256',
])
const GRADING_MEASUREMENT_FIELDS = Object.freeze([
  'complete',
  'logical_operations',
  'max_problems',
  'p50_ms',
  'p95_ms',
  'physical_provider_calls',
  'result_digest',
  'sample_count',
  'success_count',
])
const ZERO_BUSINESS_SIDE_EFFECTS = Object.freeze({
  agent_creates: 0,
  image_task_submissions: 0,
  model_calls: 0,
  im_sends: 0,
})

export const PHASES = Object.freeze([
  'validate',
  'prepare',
  'clear',
  'messy',
  'restart-replay',
  'status',
])

class HarnessError extends Error {
  constructor(code) {
    super(code)
    this.name = 'HarnessError'
    this.code = code
  }
}

class PhasePending extends HarnessError {
  constructor(code, projection = {}) {
    super(code)
    this.name = 'PhasePending'
    this.projection = projection
  }
}

class TerminalEvidenceRecorded extends HarnessError {
  constructor(code, projection) {
    super(code)
    this.name = 'TerminalEvidenceRecorded'
    this.projection = projection
  }
}

class GradingReleasePreflightRejected extends HarnessError {
  constructor(code) {
    super(code)
    this.name = 'GradingReleasePreflightRejected'
    this.projection = { ...ZERO_BUSINESS_SIDE_EFFECTS }
  }
}

function object(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HarnessError(code)
  return value
}

function array(value, code) {
  if (!Array.isArray(value)) throw new HarnessError(code)
  return value
}

function nonEmpty(value, code) {
  if (typeof value !== 'string' || value.trim() === '') throw new HarnessError(code)
  return value.trim()
}

function safeCode(error) {
  return typeof error?.code === 'string' ? error.code : 'UNEXPECTED_FAILURE'
}

function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex')
}

function sha256Text(value) {
  return sha256Bytes(Buffer.from(String(value), 'utf8'))
}

function rejectGradingReleasePreflight(code) {
  throw new GradingReleasePreflightRejected(code)
}

function exactObjectFields(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const actual = Object.keys(value).sort()
  const expected = [...fields].sort()
  return (
    actual.length === expected.length && actual.every((field, index) => field === expected[index])
  )
}

export function imageTaskSourceDigest(images) {
  const hash = createHash('sha256')
  for (const image of array(images, 'SOURCE_IMAGES_INVALID')) {
    if (!Buffer.isBuffer(image) || image.length === 0)
      throw new HarnessError('SOURCE_IMAGE_INVALID')
    const length = Buffer.alloc(8)
    length.writeBigUInt64BE(BigInt(image.length))
    hash.update(length)
    hash.update(image)
  }
  return `sha256:${hash.digest('hex')}`
}

export function assertPublicSourceIdentity(inputValue) {
  const input = object(inputValue, 'PUBLIC_SOURCE_IDENTITY_INVALID')
  const rawBytes = input.raw_bytes
  if (!Buffer.isBuffer(rawBytes) || rawBytes.length === 0) {
    throw new HarnessError('PUBLIC_SOURCE_IDENTITY_INVALID')
  }
  const expectedRawDigest = normalizedDigest(input.fixture_sha256, 'PUBLIC_SOURCE_IDENTITY_INVALID')
  const rawDigest = sha256Bytes(rawBytes)
  if (
    rawDigest !== expectedRawDigest ||
    !Number.isInteger(input.fixture_size_bytes) ||
    rawBytes.length !== input.fixture_size_bytes ||
    !Number.isInteger(input.canonical_attachment_size_bytes) ||
    input.canonical_attachment_size_bytes < 1
  ) {
    throw new HarnessError('PUBLIC_SOURCE_IDENTITY_DRIFT')
  }
  return {
    raw_digest: rawDigest,
    raw_size_bytes: rawBytes.length,
    canonical_aggregate_digest: normalizedDigest(
      input.canonical_aggregate_digest,
      'PUBLIC_SOURCE_IDENTITY_INVALID',
    ),
    canonical_attachment_digest: normalizedDigest(
      input.canonical_attachment_digest,
      'PUBLIC_SOURCE_IDENTITY_INVALID',
    ),
    canonical_attachment_size_bytes: input.canonical_attachment_size_bytes,
  }
}

export async function sha256File(pathname) {
  const hash = createHash('sha256')
  await new Promise((resolveStream, rejectStream) => {
    const stream = createReadStream(pathname)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.once('error', rejectStream)
    stream.once('end', resolveStream)
  })
  return hash.digest('hex')
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

function normalizedDigest(value, code) {
  const text = nonEmpty(value, code).toLowerCase()
  if (SHA256.test(text)) return text
  if (PREFIXED_SHA256.test(text)) return text.slice('sha256:'.length)
  throw new HarnessError(code)
}

function gradingBudgetProjection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  return Object.fromEntries(GRADING_BUDGET_FIELDS.map((field) => [field, value[field]]))
}

function assertFrozenGradingBudget(configBytes) {
  if (!Buffer.isBuffer(configBytes) || configBytes.length === 0) {
    rejectGradingReleasePreflight('GRADING_RELEASE_CONFIG_INVALID')
  }
  let binding
  try {
    binding = parseSidecarBinding(configBytes.toString('utf8'))
  } catch {
    rejectGradingReleasePreflight('GRADING_RELEASE_CONFIG_INVALID')
  }
  const budget = gradingBudgetProjection(binding?.gradingBudget)
  if (!budget || typeof budget !== 'object' || Array.isArray(budget)) {
    rejectGradingReleasePreflight('GRADING_BUDGET_MISSING')
  }
  if (!exactObjectFields(budget, GRADING_BUDGET_FIELDS)) {
    rejectGradingReleasePreflight('GRADING_BUDGET_INVALID')
  }
  for (const field of [
    'policy_version',
    'queued_seconds',
    'normalizing_seconds',
    'recognizing_seconds',
    'locating_seconds',
    'rendering_seconds',
    'projecting_seconds',
  ]) {
    if (!Number.isSafeInteger(budget[field]) || budget[field] <= 0) {
      rejectGradingReleasePreflight('GRADING_BUDGET_INVALID')
    }
  }
  if (
    !Number.isSafeInteger(budget.item_concurrency) ||
    budget.item_concurrency < 1 ||
    budget.item_concurrency > 32 ||
    !Array.isArray(budget.assessing_buckets) ||
    budget.assessing_buckets.length !== GRADING_BUCKETS.length
  ) {
    rejectGradingReleasePreflight('GRADING_BUDGET_INVALID')
  }
  for (const [index, maxProblems] of GRADING_BUCKETS.entries()) {
    const bucket = budget.assessing_buckets[index]
    if (
      !exactObjectFields(bucket, ['max_problems', 'seconds']) ||
      bucket.max_problems !== maxProblems ||
      !Number.isSafeInteger(bucket.seconds) ||
      bucket.seconds <= 0
    ) {
      rejectGradingReleasePreflight('GRADING_BUDGET_INVALID')
    }
  }
  return budget
}

function assertCalibrationArtifact(artifact, budget, configSHA256, approval) {
  if (
    !exactObjectFields(artifact, GRADING_ARTIFACT_FIELDS) ||
    artifact.schema_version !== 1 ||
    artifact.approval_status !== 'approved' ||
    typeof artifact.approval_ref !== 'string' ||
    artifact.approval_ref.trim() === '' ||
    artifact.approval_ref !== approval.approval_ref ||
    artifact.provider !== EXPECTED_PROVIDER ||
    artifact.model !== EXPECTED_MODEL ||
    artifact.sidecar_config_sha256 !== configSHA256 ||
    !SHA256.test(String(artifact.evidence_sha256 ?? ''))
  ) {
    rejectGradingReleasePreflight('GRADING_CALIBRATION_ARTIFACT_INVALID')
  }
  const artifactBudget = gradingBudgetProjection(artifact.grading_budget)
  if (
    !exactObjectFields(artifactBudget, GRADING_BUDGET_FIELDS) ||
    canonicalJSON(artifactBudget) !== canonicalJSON(budget)
  ) {
    rejectGradingReleasePreflight('GRADING_CALIBRATION_ARTIFACT_INVALID')
  }
  if (
    !Array.isArray(artifact.measurements) ||
    artifact.measurements.length !== GRADING_BUCKETS.length
  ) {
    rejectGradingReleasePreflight('GRADING_CALIBRATION_ARTIFACT_INVALID')
  }
  for (const [index, maxProblems] of GRADING_BUCKETS.entries()) {
    const measurement = artifact.measurements[index]
    const bucket = budget.assessing_buckets[index]
    if (
      !exactObjectFields(measurement, GRADING_MEASUREMENT_FIELDS) ||
      measurement.max_problems !== maxProblems ||
      !Number.isSafeInteger(measurement.sample_count) ||
      measurement.sample_count < 5 ||
      measurement.success_count !== measurement.sample_count ||
      !Number.isSafeInteger(measurement.p50_ms) ||
      measurement.p50_ms <= 0 ||
      !Number.isSafeInteger(measurement.p95_ms) ||
      measurement.p95_ms < measurement.p50_ms ||
      measurement.p95_ms > bucket.seconds * 1_000 ||
      !Number.isSafeInteger(measurement.logical_operations) ||
      measurement.logical_operations <= 0 ||
      !Number.isSafeInteger(measurement.physical_provider_calls) ||
      measurement.physical_provider_calls <= 0 ||
      measurement.complete !== true ||
      !SHA256.test(String(measurement.result_digest ?? ''))
    ) {
      rejectGradingReleasePreflight('GRADING_CALIBRATION_ARTIFACT_INVALID')
    }
  }
}

export function assertGradingReleasePreflightSnapshot(inputValue) {
  const input = object(inputValue, 'GRADING_RELEASE_PREFLIGHT_INVALID')
  const budget = assertFrozenGradingBudget(input.config_bytes)
  const configSHA256 = sha256Bytes(input.config_bytes)
  let approval
  try {
    approval = validateGradingCalibrationApproval(input.approval, {
      provider: EXPECTED_PROVIDER,
      model: EXPECTED_MODEL,
      releaseConfigSHA256: configSHA256,
    })
  } catch {
    rejectGradingReleasePreflight(
      input.approval?.status === 'approved'
        ? 'GRADING_RELEASE_CONFIG_IDENTITY_MISMATCH'
        : 'GRADING_CALIBRATION_NOT_APPROVED',
    )
  }
  if (!Buffer.isBuffer(input.artifact_bytes) || input.artifact_bytes.length === 0) {
    rejectGradingReleasePreflight('GRADING_CALIBRATION_ARTIFACT_INVALID')
  }
  const expectedArtifactSHA256 = String(input.expected_artifact_sha256 ?? '').trim()
  const artifactSHA256 = sha256Bytes(input.artifact_bytes)
  if (
    !SHA256.test(expectedArtifactSHA256) ||
    artifactSHA256 !== expectedArtifactSHA256 ||
    approval.artifact_sha256 !== artifactSHA256
  ) {
    rejectGradingReleasePreflight('GRADING_CALIBRATION_IDENTITY_MISMATCH')
  }
  let artifact
  try {
    artifact = parseStrictJSON(input.artifact_bytes, { label: 'grading calibration artifact' })
  } catch {
    rejectGradingReleasePreflight('GRADING_CALIBRATION_ARTIFACT_INVALID')
  }
  assertCalibrationArtifact(artifact, budget, configSHA256, approval)
  return Object.freeze({
    route: Object.freeze({ provider: EXPECTED_PROVIDER, model: EXPECTED_MODEL }),
    policy_version: budget.policy_version,
    config_sha256: configSHA256,
    artifact_sha256: artifactSHA256,
    budget_sha256: sha256Text(canonicalJSON(budget)),
    approval_ref_sha256: sha256Text(approval.approval_ref),
  })
}

function decodeCanonicalBase64(value, code) {
  const text = nonEmpty(value, code)
  if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(text)) {
    throw new HarnessError(code)
  }
  const bytes = Buffer.from(text, 'base64')
  if (bytes.length === 0 || bytes.toString('base64') !== text) throw new HarnessError(code)
  return bytes
}

function physicalTarget(value) {
  const candidate = object(value, 'TARGET_INVALID')
  const target = {
    platform: nonEmpty(candidate.platform, 'TARGET_INVALID').toLowerCase(),
    instance_id: nonEmpty(candidate.instance_id, 'TARGET_INVALID'),
    chat_id: nonEmpty(candidate.chat_id, 'TARGET_INVALID'),
  }
  if (target.platform !== 'dingtalk') throw new HarnessError('TARGET_INVALID')
  return target
}

function physicalTargetKey(value) {
  const target = physicalTarget(value)
  return `${target.platform}\0${target.instance_id}\0${target.chat_id}`
}

function ruleTarget(ruleValue) {
  const rule = object(ruleValue, 'AGENT_RULE_INVALID')
  const chatID = String(rule.chat_id || rule.user_id || '').trim()
  if (String(rule.platform ?? '').toLowerCase() !== 'dingtalk' || !chatID) return null
  return physicalTarget({
    platform: 'dingtalk',
    instance_id: rule.instance_id,
    chat_id: chatID,
  })
}

function cloneAgent(sourceValue, isolatedName) {
  const source = object(sourceValue, 'SOURCE_AGENT_INVALID')
  const clone = {
    name: nonEmpty(isolatedName, 'ISOLATED_AGENT_INVALID'),
    display_name: source.display_name,
    description: source.description,
    model: source.model,
    provider: source.provider,
    system_prompt: source.system_prompt,
    skills: Array.isArray(source.skills) ? source.skills : [],
    max_tokens: Number.isInteger(source.max_tokens) ? source.max_tokens : 0,
    reasoning_policy: source.reasoning_policy ?? { mode: 'inherit' },
    metadata: source.metadata ?? {},
  }
  if (Object.hasOwn(source, 'temperature')) clone.temperature = source.temperature
  return clone
}

export function planIsolatedAgent(projectionValue, sourceName, isolatedName) {
  const projection = object(projectionValue, 'AGENT_PROJECTION_INVALID')
  const sourceAgents = array(projection.agents, 'AGENT_PROJECTION_INVALID').filter(
    (agent) => agent?.name === sourceName,
  )
  if (
    sourceAgents.length !== 1 ||
    sourceAgents[0].provider !== EXPECTED_PROVIDER ||
    sourceAgents[0].model !== EXPECTED_MODEL ||
    sourceAgents[0].metadata?.scenario !== 'k12-tutor'
  ) {
    throw new HarnessError('SOURCE_AGENT_ROUTE_INVALID')
  }
  const byTarget = new Map()
  for (const rule of array(projection.rules, 'AGENT_RULE_PROJECTION_INVALID')) {
    if (rule?.agent_name !== sourceName) continue
    const target = ruleTarget(rule)
    if (!target) continue
    const key = physicalTargetKey(target)
    if (!byTarget.has(key)) byTarget.set(key, { target, rule })
  }
  if (byTarget.size === 0) throw new HarnessError('SOURCE_AGENT_TARGETS_EMPTY')
  const selected = [...byTarget.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => value)
  return {
    agent: cloneAgent(sourceAgents[0], isolatedName),
    grade_term: String(sourceAgents[0].metadata?.grade_term ?? ''),
    targets: selected.map((value) => value.target),
    rules: selected.map(({ target, rule }) => ({
      platform: target.platform,
      instance_id: target.instance_id,
      user_id: String(rule.user_id ?? ''),
      chat_id: String(rule.chat_id ?? ''),
      agent_name: isolatedName,
      priority: Number.isInteger(rule.priority) ? rule.priority : 0,
    })),
  }
}

export function nextImageTaskCommand(dispatchValue, agentName, gradeTerm) {
  const dispatch = object(dispatchValue, 'IMAGE_TASK_DISPATCH_INVALID')
  const dispatchID = nonEmpty(dispatch.dispatch_id, 'IMAGE_TASK_DISPATCH_INVALID')
  const agent = nonEmpty(agentName, 'IMAGE_TASK_AGENT_INVALID')
  if (dispatch.status === 'failed') throw new HarnessError('IMAGE_TASK_FAILED')
  if (dispatch.status === 'cancelled') throw new HarnessError('IMAGE_TASK_CANCELLED')
  if (dispatch.status === 'awaiting_confirmation') {
    return {
      kind: 'confirm_intent',
      path: `/api/k12/image-tasks/${encodeURIComponent(dispatchID)}/confirm`,
      data: {
        agent,
        version: dispatch.version,
        intent: 'completed_homework',
      },
    }
  }
  const target = dispatch.target_projection
  if (
    target?.kind === 'homework' &&
    target.stage === 'awaiting_confirmation' &&
    target.confirmation_state === 'pending'
  ) {
    const questions = array(target.recognition?.questions, 'RECOGNITION_QUESTIONS_INVALID')
    if (questions.length === 0) throw new HarnessError('RECOGNITION_QUESTIONS_EMPTY')
    return {
      kind: 'confirm_recognition',
      path: `/api/k12/image-tasks/${encodeURIComponent(dispatchID)}/confirm`,
      data: {
        agent,
        version: dispatch.version,
        homework: {
          subject: '数学',
          grade: String(gradeTerm ?? ''),
          question_corrections: questions.map((question, index) => ({
            index,
            problem_id: nonEmpty(question?.problem_id, 'RECOGNITION_PROBLEM_ID_INVALID'),
            confirmed: true,
          })),
        },
      },
    }
  }
  if (target?.kind === 'homework' && target.stage === 'completed') {
    return { kind: 'completed' }
  }
  return { kind: 'wait' }
}

export function resolveLiveRuntime(env = process.env, homeDirectory = homedir()) {
  const runRoot = resolve(nonEmpty(env.HEXCLAW_PHOTO_OUTBOUND_RUN_DIR, 'RUN_DIRECTORY_REQUIRED'))
  const defaultConfig = resolve(homeDirectory, '.hexclaw/hexclaw.yaml')
  const config = resolve(nonEmpty(env.HEXCLAW_PHOTO_OUTBOUND_CONFIG, 'CONFIG_REQUIRED'))
  if (config !== defaultConfig) throw new HarnessError('REAL_DEFAULT_CONFIG_REQUIRED')
  const sidecar = resolve(env.HEXCLAW_PHOTO_OUTBOUND_SIDECAR_BIN || DEFAULT_SIDECAR)
  let baseURL
  try {
    baseURL = new URL(env.HEXCLAW_PHOTO_OUTBOUND_BASE_URL || 'http://127.0.0.1:16060')
  } catch {
    throw new HarnessError('BASE_URL_INVALID')
  }
  if (
    baseURL.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost'].includes(baseURL.hostname) ||
    !['', '/'].includes(baseURL.pathname)
  ) {
    throw new HarnessError('BASE_URL_INVALID')
  }
  return {
    run_root: runRoot,
    asset_root: join(runRoot, 'assets'),
    config,
    default_config: defaultConfig,
    sidecar,
    base_url: baseURL.origin,
    source_agent: nonEmpty(env.HEXCLAW_PHOTO_OUTBOUND_SOURCE_AGENT, 'SOURCE_AGENT_REQUIRED'),
  }
}

function fixtureProjection(value, oracleFixture, key) {
  const fixture = object(value, 'FIXTURE_CONTRACT_INVALID')
  const trusted = object(oracleFixture, 'FIXTURE_ORACLE_INVALID')
  for (const field of ['docs_relative_path', 'mime', 'sha256', 'size_bytes', 'width', 'height']) {
    if (fixture[field] !== trusted[field]) throw new HarnessError('FIXTURE_CONTRACT_DRIFT')
  }
  if (
    sha256Text(canonicalJSON(trusted.expected_items)) !== fixture.expected_items_sha256 ||
    sha256Text(canonicalJSON(trusted.expected_counts)) !== fixture.expected_counts_sha256 ||
    trusted.expected_items.length !== 16
  ) {
    throw new HarnessError('FIXTURE_ORACLE_DRIFT')
  }
  return {
    key,
    docs_relative_path: fixture.docs_relative_path,
    mime: fixture.mime,
    sha256: fixture.sha256,
    size_bytes: fixture.size_bytes,
    width: fixture.width,
    height: fixture.height,
    item_count: trusted.expected_items.length,
    expected_items: trusted.expected_items,
    expected_counts: trusted.expected_counts,
  }
}

export function validatePublicOutboundContract(contractValue, oracleBytes) {
  const contract = object(contractValue, 'CONTRACT_INVALID')
  const transport = object(contract.transport, 'TRANSPORT_CONTRACT_INVALID')
  if (
    contract.schema_version !== 1 ||
    contract.scenario !== 'k12_real_photo_grading_outbound_public_api' ||
    contract.route?.provider !== EXPECTED_PROVIDER ||
    contract.route?.model !== EXPECTED_MODEL ||
    contract.route?.fallback_allowed !== false ||
    transport.product_operations !== 'hexclaw_public_http_api_only' ||
    transport.http_driver !== 'playwright_api_request_context' ||
    transport.bound_instance_only !== true ||
    transport.synthetic_inbound_stream !== false ||
    transport.dws_cli !== false ||
    transport.direct_dingtalk_http !== false ||
    transport.direct_store_read !== false ||
    transport.sqlite_read_or_write !== false
  ) {
    throw new HarnessError('TRANSPORT_CONTRACT_INVALID')
  }
  const llmPreflight = object(contract.llm_preflight, 'LLM_PREFLIGHT_CONTRACT_INVALID')
  const reasoningControl = object(llmPreflight.reasoning_control, 'LLM_PREFLIGHT_CONTRACT_INVALID')
  if (
    llmPreflight.global_default_may_differ !== true ||
    llmPreflight.provider_default_model_may_differ !== true ||
    llmPreflight.provider_not_disabled_required !== true ||
    llmPreflight.credential_present_required !== true ||
    llmPreflight.model_specs_mode !== 'explicit' ||
    !Array.isArray(llmPreflight.required_capabilities) ||
    llmPreflight.required_capabilities.length !== 2 ||
    llmPreflight.required_capabilities[0] !== 'text' ||
    llmPreflight.required_capabilities[1] !== 'vision' ||
    llmPreflight.reasoning_support !== 'supported' ||
    reasoningControl.dialect !== 'reasoning_effort' ||
    reasoningControl.on !== 'low' ||
    reasoningControl.off !== 'none' ||
    !Array.isArray(reasoningControl.allowed_efforts) ||
    reasoningControl.allowed_efforts.length !== 1 ||
    reasoningControl.allowed_efforts[0] !== 'low'
  ) {
    throw new HarnessError('LLM_PREFLIGHT_CONTRACT_INVALID')
  }
  const gradingPreflight = object(
    contract.grading_budget_preflight,
    'GRADING_BUDGET_PREFLIGHT_CONTRACT_INVALID',
  )
  const zeroEffects = object(
    gradingPreflight.business_side_effects_before_pass,
    'GRADING_BUDGET_PREFLIGHT_CONTRACT_INVALID',
  )
  const approval = object(gradingPreflight.approval, 'GRADING_BUDGET_PREFLIGHT_CONTRACT_INVALID')
  const blockedApproval =
    approval.status === 'blocked' &&
    approval.approval_ref === null &&
    approval.provider === EXPECTED_PROVIDER &&
    approval.model === EXPECTED_MODEL &&
    approval.artifact_sha256 === null &&
    approval.release_config_sha256 === null
  const approvedApproval =
    approval.status === 'approved' &&
    typeof approval.approval_ref === 'string' &&
    approval.approval_ref.trim() !== '' &&
    approval.provider === EXPECTED_PROVIDER &&
    approval.model === EXPECTED_MODEL &&
    SHA256.test(String(approval.artifact_sha256 ?? '')) &&
    SHA256.test(String(approval.release_config_sha256 ?? ''))
  if (
    gradingPreflight.config_source !== 'locked_real_default_profile' ||
    gradingPreflight.require_complete_frozen_budget !== true ||
    gradingPreflight.artifact_path_environment !== 'HEX_K12_LIVE_GRADING_CALIBRATION_ARTIFACT' ||
    gradingPreflight.artifact_sha256_environment !== 'HEX_K12_LIVE_GRADING_CALIBRATION_SHA256' ||
    !Array.isArray(gradingPreflight.required_assessing_buckets) ||
    canonicalJSON(gradingPreflight.required_assessing_buckets) !== canonicalJSON(GRADING_BUCKETS) ||
    !exactObjectFields(zeroEffects, Object.keys(ZERO_BUSINESS_SIDE_EFFECTS)) ||
    Object.values(zeroEffects).some((value) => value !== 0) ||
    (!blockedApproval && !approvedApproval)
  ) {
    throw new HarnessError('GRADING_BUDGET_PREFLIGHT_CONTRACT_INVALID')
  }
  const instancePreflight = object(
    contract.instance_preflight,
    'INSTANCE_PREFLIGHT_CONTRACT_INVALID',
  )
  if (
    !Array.isArray(instancePreflight.identifier_match) ||
    instancePreflight.identifier_match.length !== 2 ||
    instancePreflight.identifier_match[0] !== 'id' ||
    instancePreflight.identifier_match[1] !== 'name' ||
    instancePreflight.unique_match_required !== true ||
    instancePreflight.provider !== 'dingtalk' ||
    instancePreflight.enabled !== true ||
    instancePreflight.status !== 'running' ||
    instancePreflight.masked_config_required !== true
  ) {
    throw new HarnessError('INSTANCE_PREFLIGHT_CONTRACT_INVALID')
  }
  const terminalFailure = object(contract.terminal_failure, 'TERMINAL_FAILURE_CONTRACT_INVALID')
  if (
    terminalFailure.archive_public_task_projection !== true ||
    terminalFailure.archive_operation_receipts !== true ||
    terminalFailure.raw_invocation_ids_allowed !== false ||
    terminalFailure.missing_public_failure_code !== 'record_unavailable_without_guessing' ||
    terminalFailure.automatic_retry_allowed !== false ||
    terminalFailure.resource_cleanup !== 'retain_frozen_run_for_diagnosis'
  ) {
    throw new HarnessError('TERMINAL_FAILURE_CONTRACT_INVALID')
  }
  const publicAPI = object(contract.public_api, 'PUBLIC_API_CONTRACT_INVALID')
  const routes = Object.values(publicAPI).map((value) =>
    nonEmpty(value, 'PUBLIC_API_CONTRACT_INVALID'),
  )
  const forbidden = array(contract.forbidden_api_fragments, 'FORBIDDEN_API_CONTRACT_INVALID')
  if (
    forbidden.length !== 2 ||
    routes.some((route) => forbidden.some((fragment) => route.includes(fragment))) ||
    publicAPI.asset_get !== '/api/k12/assets/{file}?agent={agent_name}' ||
    publicAPI.image_task_create !== '/api/k12/image-tasks' ||
    publicAPI.final_delivery_send !== '/api/k12/tutoring-tips/send' ||
    publicAPI.delivery_batch_query !== '/api/k12/delivery-batches/{batch_id}/query'
  ) {
    throw new HarnessError('PUBLIC_API_CONTRACT_INVALID')
  }
  if (!Buffer.isBuffer(oracleBytes) || oracleBytes.length === 0) {
    throw new HarnessError('ORACLE_CONTRACT_UNAVAILABLE')
  }
  const oracleSource = object(contract.oracle_source, 'ORACLE_CONTRACT_INVALID')
  if (
    oracleSource.path !== 'tests/live/k12-dingtalk-photo-grading-headless.contract.json' ||
    sha256Bytes(oracleBytes) !== oracleSource.sha256
  ) {
    throw new HarnessError('ORACLE_CONTRACT_DRIFT')
  }
  let oracleRaw
  let oracle
  try {
    oracleRaw = JSON.parse(oracleBytes.toString('utf8'))
    oracle = validateTrustedOracleContract(oracleRaw)
  } catch {
    throw new HarnessError('ORACLE_CONTRACT_INVALID')
  }
  if (
    contract.delivery?.object_kind !== 'grading_final_artifact' ||
    contract.delivery?.target_mode !== 'all_effective_agent_bindings' ||
    contract.delivery?.parts_per_target !== 2 ||
    contract.delivery?.retry_endpoint_allowed !== false ||
    contract.restart_replay?.new_model_call_count !== 0 ||
    contract.restart_replay?.new_provider_send_count !== 0
  ) {
    throw new HarnessError('CLOSURE_CONTRACT_INVALID')
  }
  return {
    route: { ...contract.route },
    llm_preflight: structuredClone(llmPreflight),
    grading_budget_preflight: {
      ...structuredClone(gradingPreflight),
      approval: structuredClone(approval),
    },
    instance_preflight: structuredClone(instancePreflight),
    terminal_failure: structuredClone(terminalFailure),
    transport: { ...transport },
    public_api: { ...publicAPI },
    forbidden_fragments: [...forbidden],
    fixtures: {
      clear: fixtureProjection(
        contract.fixtures?.clear,
        { ...oracleRaw.fixtures.clear, ...oracle.fixtures.clear },
        'clear',
      ),
      messy: fixtureProjection(
        contract.fixtures?.messy,
        { ...oracleRaw.fixtures.messy, ...oracle.fixtures.messy },
        'messy',
      ),
    },
  }
}

function modelOperationInvariant(receiptsValue) {
  const receipts = array(receiptsValue, 'MODEL_OPERATION_RECEIPTS_INVALID')
  if (receipts.length === 0) throw new HarnessError('MODEL_OPERATION_RECEIPTS_INVALID')
  const projected = receipts.map((receiptValue) => {
    const receipt = object(receiptValue, 'MODEL_OPERATION_RECEIPTS_INVALID')
    const projectedReceipt = {
      invocation_id: nonEmpty(receipt.invocation_id, 'MODEL_OPERATION_RECEIPTS_INVALID'),
      parent_invocation_id: String(receipt.parent_invocation_id ?? ''),
      physical_unit: String(receipt.physical_unit ?? ''),
      operation: nonEmpty(receipt.operation, 'MODEL_OPERATION_RECEIPTS_INVALID'),
      canonical_input_digest: normalizedDigest(
        receipt.canonical_input_digest,
        'MODEL_OPERATION_RECEIPTS_INVALID',
      ),
      provider: String(receipt.provider ?? ''),
      model: String(receipt.model ?? ''),
      status: nonEmpty(receipt.status, 'MODEL_OPERATION_RECEIPTS_INVALID'),
      attempt: receipt.attempt,
      result_digest: receipt.result_digest
        ? normalizedDigest(receipt.result_digest, 'MODEL_OPERATION_RECEIPTS_INVALID')
        : '',
      request_policy_digest: receipt.request_policy_digest
        ? normalizedDigest(receipt.request_policy_digest, 'MODEL_OPERATION_RECEIPTS_INVALID')
        : '',
    }
    if (!Number.isInteger(projectedReceipt.attempt) || projectedReceipt.attempt < 1) {
      throw new HarnessError('MODEL_OPERATION_RECEIPTS_INVALID')
    }
    if (
      projectedReceipt.status === 'succeeded' &&
      (projectedReceipt.provider || projectedReceipt.model) &&
      (projectedReceipt.provider !== EXPECTED_PROVIDER ||
        projectedReceipt.model !== EXPECTED_MODEL ||
        !projectedReceipt.result_digest)
    ) {
      throw new HarnessError('REAL_MODEL_ROUTE_INVALID')
    }
    return projectedReceipt
  })
  if (
    !projected.some(
      (receipt) =>
        receipt.status === 'succeeded' &&
        receipt.provider === EXPECTED_PROVIDER &&
        receipt.model === EXPECTED_MODEL,
    )
  ) {
    throw new HarnessError('REAL_MODEL_ROUTE_INVALID')
  }
  return projected.sort((left, right) => canonicalJSON(left).localeCompare(canonicalJSON(right)))
}

function publicFailureCode(dispatch, result) {
  for (const value of [
    dispatch.failure_code,
    dispatch.failure_kind,
    dispatch.target_projection?.failure_code,
    dispatch.target_projection?.failure_kind,
    result.failure_code,
    result.failure_kind,
  ]) {
    const code = String(value ?? '').trim()
    if (code && /^[a-z0-9][a-z0-9_.:-]{0,127}$/u.test(code)) return code
  }
  return null
}

export function projectTerminalImageTaskFailure(dispatchValue, resultValue) {
  const dispatch = object(dispatchValue, 'TERMINAL_IMAGE_TASK_INVALID')
  const result = object(resultValue, 'TERMINAL_IMAGE_TASK_INVALID')
  if (
    dispatch.status !== 'failed' ||
    result.status !== 'failed' ||
    dispatch.task_intent !== result.task_intent ||
    (result.dispatch_id && result.dispatch_id !== dispatch.dispatch_id) ||
    typeof dispatch.retryable !== 'boolean'
  ) {
    throw new HarnessError('TERMINAL_IMAGE_TASK_INVALID')
  }
  const receipts = array(result.operation_receipts, 'TERMINAL_RECEIPTS_INVALID').map(
    (receiptValue) => {
      const receipt = object(receiptValue, 'TERMINAL_RECEIPTS_INVALID')
      const provider = String(receipt.provider ?? '')
      const model = String(receipt.model ?? '')
      if ((provider || model) && (provider !== EXPECTED_PROVIDER || model !== EXPECTED_MODEL)) {
        throw new HarnessError('TERMINAL_MODEL_ROUTE_DRIFT')
      }
      if (!Number.isInteger(receipt.attempt) || receipt.attempt < 1) {
        throw new HarnessError('TERMINAL_RECEIPTS_INVALID')
      }
      return {
        invocation_id_sha256: sha256Text(
          nonEmpty(receipt.invocation_id, 'TERMINAL_RECEIPTS_INVALID'),
        ),
        parent_invocation_id_sha256: receipt.parent_invocation_id
          ? sha256Text(receipt.parent_invocation_id)
          : '',
        physical_unit: String(receipt.physical_unit ?? ''),
        operation: nonEmpty(receipt.operation, 'TERMINAL_RECEIPTS_INVALID'),
        canonical_input_digest: normalizedDigest(
          receipt.canonical_input_digest,
          'TERMINAL_RECEIPTS_INVALID',
        ),
        provider,
        model,
        status: nonEmpty(receipt.status, 'TERMINAL_RECEIPTS_INVALID'),
        attempt: receipt.attempt,
        result_digest: receipt.result_digest
          ? normalizedDigest(receipt.result_digest, 'TERMINAL_RECEIPTS_INVALID')
          : '',
        request_policy_digest: receipt.request_policy_digest
          ? normalizedDigest(receipt.request_policy_digest, 'TERMINAL_RECEIPTS_INVALID')
          : '',
      }
    },
  )
  if (receipts.length === 0) throw new HarnessError('TERMINAL_RECEIPTS_INVALID')
  const providerReceipts = receipts.filter((receipt) => receipt.provider || receipt.model)
  const classification = receipts.filter((receipt) => receipt.operation === 'classification')
  if (classification.length !== 1) throw new HarnessError('TERMINAL_CLASSIFICATION_INVALID')
  const failedOperations = [
    ...new Set(
      receipts.filter((receipt) => receipt.status === 'failed').map((receipt) => receipt.operation),
    ),
  ].sort()
  const code = publicFailureCode(dispatch, result)
  return {
    task_status: 'failed',
    task_intent: dispatch.task_intent,
    model_id: String(dispatch.model_id ?? ''),
    version: dispatch.version,
    progress: {
      operation: String(dispatch.progress?.operation ?? ''),
      state: String(dispatch.progress?.state ?? ''),
    },
    failure_stage:
      failedOperations.length === 1
        ? failedOperations[0]
        : String(dispatch.progress?.operation ?? 'unknown'),
    failed_operations: failedOperations,
    failure_code_publicly_available: code !== null,
    failure_code: code,
    classification: classification[0],
    operation_receipts: receipts,
    model_physical_call_count: providerReceipts.length,
    physical_child_receipt_count: providerReceipts.filter(
      (receipt) => receipt.parent_invocation_id_sha256 || receipt.physical_unit,
    ).length,
    fallback_call_count: 0,
    retry_safety: {
      public_retryable: dispatch.retryable,
      automatic_retry_performed: false,
      next_action: dispatch.retryable ? 'explicit_public_retry_after_diagnosis' : 'do_not_retry',
    },
  }
}

export function assertFinalArtifactProjection(inputValue) {
  const input = object(inputValue, 'FINAL_ARTIFACT_INPUT_INVALID')
  const result = object(input.result, 'IMAGE_TASK_RESULT_INVALID')
  const artifact = object(input.artifact, 'FINAL_ARTIFACT_INVALID')
  const projection = object(result.result, 'PHOTO_RESULT_INVALID')
  const payload = object(projection.payload, 'PHOTO_RESULT_INVALID')
  if (
    result.status !== 'routed' ||
    result.task_intent !== 'completed_homework' ||
    projection.kind !== 'completed_homework' ||
    payload.task_intent !== 'completed_homework' ||
    payload.result_surface !== 'annotated_homework' ||
    artifact.coverage_status !== 'complete' ||
    !SHA256.test(nonEmpty(artifact.artifact_digest, 'FINAL_ARTIFACT_INVALID').toLowerCase()) ||
    !nonEmpty(artifact.artifact_id, 'FINAL_ARTIFACT_INVALID') ||
    payload.markdown !== artifact.canonical_markdown ||
    !HAN.test(nonEmpty(artifact.canonical_markdown, 'FINAL_MARKDOWN_INVALID'))
  ) {
    throw new HarnessError('FINAL_ARTIFACT_INVALID')
  }
  for (const forbidden of [
    'annotated_asset_owner_scope',
    'annotated_asset_id',
    'annotated_mime',
    'annotated_digest',
    'original_source_digest',
  ]) {
    if (Object.hasOwn(artifact, forbidden)) throw new HarnessError('FINAL_ARTIFACT_PRIVATE_FIELD')
  }
  const attachments = array(result.source_attachments, 'SOURCE_ATTACHMENTS_INVALID')
  if (attachments.length !== 1) throw new HarnessError('SOURCE_ATTACHMENTS_INVALID')
  const source = object(attachments[0], 'SOURCE_ATTACHMENTS_INVALID')
  if (!Number.isInteger(source.size_bytes) || source.size_bytes < 1) {
    throw new HarnessError('SOURCE_ATTACHMENTS_INVALID')
  }
  const annotated = object(payload.annotated_image, 'ANNOTATED_IMAGE_REQUIRED')
  const annotatedBytes = decodeCanonicalBase64(annotated.data_base64, 'ANNOTATED_IMAGE_INVALID')
  const annotatedDigest = normalizedDigest(annotated.digest, 'ANNOTATED_IMAGE_INVALID')
  if (
    !nonEmpty(annotated.mime, 'ANNOTATED_IMAGE_INVALID').startsWith('image/') ||
    sha256Bytes(annotatedBytes) !== annotatedDigest
  ) {
    throw new HarnessError('ANNOTATED_IMAGE_INVALID')
  }
  return {
    artifact_id: artifact.artifact_id,
    artifact_digest: artifact.artifact_digest.toLowerCase(),
    canonical_markdown: artifact.canonical_markdown,
    annotated_mime: annotated.mime,
    annotated_digest: annotatedDigest,
    annotated_bytes: annotatedBytes,
    source_digest: normalizedDigest(result.source_digest, 'SOURCE_DIGEST_INVALID'),
    source_attachment_digest: normalizedDigest(source.digest, 'SOURCE_DIGEST_INVALID'),
    source_attachment_size: source.size_bytes,
    operation_receipts: modelOperationInvariant(result.operation_receipts),
    payload,
  }
}

function deliveryPayload(receipt, code) {
  try {
    return object(JSON.parse(nonEmpty(receipt.payload_json, code)), code)
  } catch (error) {
    if (error instanceof HarnessError) throw error
    throw new HarnessError(code)
  }
}

function attachmentBytes(payload) {
  const attachment = object(payload.attachment, 'DELIVERY_ARTIFACT_INVALID')
  return {
    bytes: decodeCanonicalBase64(attachment.Data ?? attachment.data, 'DELIVERY_ARTIFACT_INVALID'),
    name: attachment.Name ?? attachment.name,
    mime: attachment.MIME ?? attachment.mime,
  }
}

export function assertFinalDeliveryExactSet(batchValue, expectedValue) {
  const batch = object(batchValue, 'DELIVERY_BATCH_INVALID')
  const expected = object(expectedValue, 'DELIVERY_EXPECTATION_INVALID')
  const expectedTargets = array(expected.expected_targets, 'DELIVERY_TARGETS_INVALID').map(
    physicalTarget,
  )
  const expectedTargetKeys = expectedTargets.map(physicalTargetKey).sort()
  if (
    expectedTargets.length === 0 ||
    new Set(expectedTargetKeys).size !== expectedTargets.length ||
    batch.status !== 'delivered' ||
    batch.agent_name !== expected.agent_name ||
    batch.object_kind !== 'grading_final_artifact' ||
    batch.object_id !== `${expected.final_artifact_id}:${expected.final_artifact_digest}` ||
    !nonEmpty(batch.batch_id, 'DELIVERY_BATCH_INVALID') ||
    !PREFIXED_SHA256.test(nonEmpty(batch.content_digest, 'DELIVERY_BATCH_INVALID'))
  ) {
    throw new HarnessError('DELIVERY_BATCH_INVALID')
  }
  const markdown = nonEmpty(expected.canonical_markdown, 'DELIVERY_MARKDOWN_INVALID')
  const annotatedBytes = expected.annotated_bytes
  const annotatedDigest = normalizedDigest(expected.annotated_digest, 'DELIVERY_ARTIFACT_INVALID')
  if (
    !Buffer.isBuffer(annotatedBytes) ||
    sha256Bytes(annotatedBytes) !== annotatedDigest ||
    !nonEmpty(expected.annotated_mime, 'DELIVERY_ARTIFACT_INVALID').startsWith('image/')
  ) {
    throw new HarnessError('DELIVERY_ARTIFACT_INVALID')
  }
  const receipts = array(batch.receipts, 'DELIVERY_RECEIPTS_INVALID')
  if (receipts.length !== expectedTargets.length * 2) {
    throw new HarnessError('DELIVERY_EXACT_SET_INVALID')
  }
  const byTarget = new Map()
  const batchOrdinals = new Set()
  const externalIDs = new Set()
  for (const receiptValue of receipts) {
    const receipt = object(receiptValue, 'DELIVERY_RECEIPT_INVALID')
    const key = physicalTargetKey(receipt.target)
    if (!expectedTargetKeys.includes(key)) throw new HarnessError('DELIVERY_TARGET_DRIFT')
    if (!byTarget.has(key)) byTarget.set(key, [])
    byTarget.get(key).push(receipt)
    if (
      receipt.batch_id !== batch.batch_id ||
      !Number.isInteger(receipt.batch_ordinal) ||
      receipt.batch_ordinal < 1 ||
      batchOrdinals.has(receipt.batch_ordinal) ||
      receipt.status !== 'delivered' ||
      !nonEmpty(receipt.delivery_id, 'DELIVERY_RECEIPT_INVALID') ||
      !nonEmpty(receipt.binding_id, 'DELIVERY_RECEIPT_INVALID') ||
      !nonEmpty(receipt.external_message_id, 'DELIVERY_RECEIPT_INVALID') ||
      !Number.isInteger(receipt.attempt) ||
      receipt.attempt < 1 ||
      !PREFIXED_SHA256.test(nonEmpty(receipt.part_digest, 'DELIVERY_RECEIPT_INVALID')) ||
      !PREFIXED_SHA256.test(nonEmpty(receipt.payload_digest, 'DELIVERY_RECEIPT_INVALID'))
    ) {
      throw new HarnessError('DELIVERY_RECEIPT_INVALID')
    }
    if (externalIDs.has(receipt.external_message_id)) {
      throw new HarnessError('DELIVERY_EXTERNAL_ID_DUPLICATE')
    }
    batchOrdinals.add(receipt.batch_ordinal)
    externalIDs.add(receipt.external_message_id)
  }
  assert.deepEqual(
    [...batchOrdinals].sort((left, right) => left - right),
    Array.from({ length: receipts.length }, (_, index) => index + 1),
  )
  for (const key of expectedTargetKeys) {
    const parts = byTarget.get(key) ?? []
    if (parts.length !== 2) throw new HarnessError('DELIVERY_EXACT_SET_INVALID')
    parts.sort((left, right) => left.part_ordinal - right.part_ordinal)
    const [markdownReceipt, imageReceipt] = parts
    const markdownPayload = deliveryPayload(markdownReceipt, 'DELIVERY_MARKDOWN_INVALID')
    if (
      markdownReceipt.part_kind !== 'markdown' ||
      String(markdownReceipt.part_mime ?? '') !== '' ||
      markdownReceipt.part_ordinal !== 1 ||
      normalizedDigest(markdownReceipt.part_digest, 'DELIVERY_MARKDOWN_INVALID') !==
        sha256Text(markdown) ||
      markdownPayload.kind !== 'markdown' ||
      markdownPayload.ordinal !== 1 ||
      markdownPayload.text !== markdown ||
      markdownPayload.message_content?.locale !== 'zh-CN' ||
      markdownPayload.message_content?.markdown !== markdown
    ) {
      throw new HarnessError('DELIVERY_MARKDOWN_INVALID')
    }
    const imagePayload = deliveryPayload(imageReceipt, 'DELIVERY_ARTIFACT_INVALID')
    const attachment = attachmentBytes(imagePayload)
    if (
      imageReceipt.part_kind !== 'artifact' ||
      imageReceipt.part_ordinal !== 2 ||
      imageReceipt.part_mime !== expected.annotated_mime ||
      normalizedDigest(imageReceipt.part_digest, 'DELIVERY_ARTIFACT_INVALID') !== annotatedDigest ||
      imagePayload.kind !== 'artifact' ||
      imagePayload.ordinal !== 2 ||
      imagePayload.mime !== expected.annotated_mime ||
      attachment.mime !== expected.annotated_mime ||
      !nonEmpty(attachment.name, 'DELIVERY_ARTIFACT_INVALID') ||
      !attachment.bytes.equals(annotatedBytes) ||
      imagePayload.message_content?.locale !== 'zh-CN' ||
      imagePayload.message_content?.markdown !== markdown ||
      /asset:\/\/|file:\/\/|\/Users\/|[A-Za-z]:\\/u.test(imageReceipt.payload_json)
    ) {
      throw new HarnessError('DELIVERY_ARTIFACT_INVALID')
    }
  }
  if (byTarget.size !== expectedTargets.length) throw new HarnessError('DELIVERY_TARGET_DRIFT')
  return {
    batch_id_sha256: sha256Text(batch.batch_id),
    target_count: expectedTargets.length,
    receipt_count: receipts.length,
    target_hashes: expectedTargetKeys.map(sha256Text),
    external_message_id_hashes: [...externalIDs].map(sha256Text).sort(),
  }
}

function deliveryReplayInvariant(batchValue) {
  const batch = object(batchValue, 'RESTART_REPLAY_INVALID')
  return {
    batch_id: batch.batch_id,
    object_kind: batch.object_kind,
    object_id: batch.object_id,
    dedupe_key: batch.dedupe_key,
    content_digest: batch.content_digest,
    receipts: array(batch.receipts, 'RESTART_REPLAY_INVALID')
      .map((receipt) => ({
        delivery_id: receipt.delivery_id,
        batch_ordinal: receipt.batch_ordinal,
        part_kind: receipt.part_kind,
        part_mime: receipt.part_mime ?? '',
        part_ordinal: receipt.part_ordinal,
        part_digest: receipt.part_digest,
        binding_id: receipt.binding_id,
        target: receipt.target,
        dedupe_key: receipt.dedupe_key,
        payload_digest: receipt.payload_digest,
        external_message_id: receipt.external_message_id,
        attempt: receipt.attempt,
      }))
      .sort((left, right) => left.batch_ordinal - right.batch_ordinal),
  }
}

function replayInvariant(value) {
  const root = object(value, 'RESTART_REPLAY_INVALID')
  return {
    dispatch_id: root.dispatch_id,
    final_artifact_id: root.final_artifact_id,
    final_artifact_digest: root.final_artifact_digest,
    annotated_digest: root.annotated_digest,
    operation_receipts: modelOperationInvariant(root.operation_receipts),
    batch: deliveryReplayInvariant(root.batch),
  }
}

export function assertRestartReplayInvariant(beforeValue, afterValue) {
  const before = replayInvariant(beforeValue)
  const after = replayInvariant(afterValue)
  if (canonicalJSON(before) !== canonicalJSON(after)) {
    throw new HarnessError('RESTART_REPLAY_EXACT_SET_DRIFT')
  }
  return after
}

export function resolvePhase(args) {
  if (!Array.isArray(args) || args.length === 0) return 'validate'
  if (args.length !== 1 || !PHASES.includes(args[0])) throw new HarnessError('INVALID_PHASE')
  return args[0]
}

export function phaseBudgetMilliseconds(env = process.env) {
  const requested = Number.parseInt(env.HEXCLAW_PHOTO_OUTBOUND_PHASE_TIMEOUT_MS ?? '', 10)
  if (!Number.isFinite(requested) || requested <= 0) return DEFAULT_PHASE_MS
  return Math.min(requested, HARD_PHASE_MAX_MS)
}

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds))
}

async function writePrivateJSON(pathname, value) {
  const temporary = `${pathname}.tmp-${randomBytes(8).toString('hex')}`
  const handle = await open(temporary, 'wx', PRIVATE_FILE_MODE)
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, pathname)
  await chmod(pathname, PRIVATE_FILE_MODE)
}

async function loadState(runtime) {
  try {
    return object(
      JSON.parse(await readFile(join(runtime.run_root, 'state.json'), 'utf8')),
      'RUN_STATE_INVALID',
    )
  } catch (error) {
    if (error instanceof HarnessError) throw error
    throw new HarnessError('RUN_STATE_UNAVAILABLE')
  }
}

async function saveState(runtime, state) {
  state.updated_at = new Date().toISOString()
  await writePrivateJSON(join(runtime.run_root, 'state.json'), state)
}

async function loadEvidence(runtime) {
  try {
    return object(
      JSON.parse(await readFile(join(runtime.run_root, 'evidence.json'), 'utf8')),
      'EVIDENCE_INVALID',
    )
  } catch (error) {
    if (error instanceof HarnessError) throw error
    return { schema_version: 1, phases: {} }
  }
}

async function recordEvidence(runtime, phase, projection) {
  const evidence = await loadEvidence(runtime)
  evidence.updated_at = new Date().toISOString()
  evidence.phases[phase] = projection
  assertEvidenceSafe(evidence)
  await writePrivateJSON(join(runtime.run_root, 'evidence.json'), evidence)
}

async function requireRegularFile(pathname, code, options = {}) {
  let info
  try {
    info = await lstat(pathname)
  } catch {
    throw new HarnessError(code)
  }
  if (!info.isFile()) throw new HarnessError(code)
  if (options.executable && (info.mode & 0o111) === 0) throw new HarnessError(code)
  if (options.private && (info.mode & 0o077) !== 0) throw new HarnessError(code)
  return info
}

export async function assertRuntimeGradingReleasePreflight(runtime, env, contractProjectionValue) {
  const contractProjection = contractProjectionValue ?? (await loadContract()).projection
  const preflight = object(
    contractProjection.grading_budget_preflight,
    'GRADING_BUDGET_PREFLIGHT_CONTRACT_INVALID',
  )
  let configBytes
  try {
    await requireRegularFile(runtime.config, 'GRADING_RELEASE_CONFIG_INVALID', { private: true })
    if ((await realpath(runtime.config)) !== runtime.config) {
      rejectGradingReleasePreflight('GRADING_RELEASE_CONFIG_INVALID')
    }
    configBytes = await readFile(runtime.config)
  } catch (error) {
    if (error instanceof GradingReleasePreflightRejected) throw error
    rejectGradingReleasePreflight('GRADING_RELEASE_CONFIG_INVALID')
  }

  // 先验证当前默认配置中的冻结预算，确保缺失策略不会被工件或审批错误掩盖。
  assertFrozenGradingBudget(configBytes)
  let approval
  try {
    approval = validateGradingCalibrationApproval(preflight.approval, {
      provider: EXPECTED_PROVIDER,
      model: EXPECTED_MODEL,
      releaseConfigSHA256: sha256Bytes(configBytes),
    })
  } catch {
    rejectGradingReleasePreflight(
      preflight.approval?.status === 'approved'
        ? 'GRADING_RELEASE_CONFIG_IDENTITY_MISMATCH'
        : 'GRADING_CALIBRATION_NOT_APPROVED',
    )
  }

  const artifactPathValue = env[preflight.artifact_path_environment]
  if (typeof artifactPathValue !== 'string' || !isAbsolute(artifactPathValue.trim())) {
    rejectGradingReleasePreflight('GRADING_CALIBRATION_ARTIFACT_INVALID')
  }
  const artifactPath = resolve(artifactPathValue.trim())
  let artifactBytes
  try {
    await requireRegularFile(artifactPath, 'GRADING_CALIBRATION_ARTIFACT_INVALID', {
      private: true,
    })
    if ((await realpath(artifactPath)) !== artifactPath) {
      rejectGradingReleasePreflight('GRADING_CALIBRATION_ARTIFACT_INVALID')
    }
    artifactBytes = await readFile(artifactPath)
  } catch (error) {
    if (error instanceof GradingReleasePreflightRejected) throw error
    rejectGradingReleasePreflight('GRADING_CALIBRATION_ARTIFACT_INVALID')
  }
  const expectedArtifactSHA256 = String(env[preflight.artifact_sha256_environment] ?? '').trim()
  return assertGradingReleasePreflightSnapshot({
    config_bytes: configBytes,
    artifact_bytes: artifactBytes,
    expected_artifact_sha256: expectedArtifactSHA256,
    approval,
  })
}

export function assertPreparedGradingReleasePreflight(stateValue, contractProjectionValue) {
  const proof = stateValue?.grading_release_preflight
  const approval = contractProjectionValue?.grading_budget_preflight?.approval
  if (
    !proof ||
    typeof proof !== 'object' ||
    proof.route?.provider !== EXPECTED_PROVIDER ||
    proof.route?.model !== EXPECTED_MODEL ||
    !Number.isSafeInteger(proof.policy_version) ||
    proof.policy_version <= 0 ||
    !SHA256.test(String(proof.config_sha256 ?? '')) ||
    !SHA256.test(String(proof.artifact_sha256 ?? '')) ||
    !SHA256.test(String(proof.budget_sha256 ?? '')) ||
    !SHA256.test(String(proof.approval_ref_sha256 ?? '')) ||
    approval?.status !== 'approved' ||
    proof.config_sha256 !== approval.release_config_sha256 ||
    proof.artifact_sha256 !== approval.artifact_sha256 ||
    proof.approval_ref_sha256 !== sha256Text(approval.approval_ref)
  ) {
    rejectGradingReleasePreflight('GRADING_RELEASE_PREFLIGHT_PROOF_INVALID')
  }
  return proof
}

async function initializeRuntime(runtime) {
  await mkdir(runtime.run_root, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
  await chmod(runtime.run_root, PRIVATE_DIRECTORY_MODE)
  if ((await realpath(runtime.run_root)) !== runtime.run_root) {
    throw new HarnessError('RUN_DIRECTORY_SYMLINKED')
  }
  await mkdir(runtime.asset_root, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
  await chmod(runtime.asset_root, PRIVATE_DIRECTORY_MODE)
  await requireRegularFile(runtime.config, 'CONFIG_UNAVAILABLE', { private: true })
  await requireRegularFile(runtime.default_config, 'REAL_DEFAULT_CONFIG_UNAVAILABLE', {
    private: true,
  })
  if ((await realpath(runtime.config)) !== (await realpath(runtime.default_config))) {
    throw new HarnessError('REAL_DEFAULT_CONFIG_REQUIRED')
  }
  await requireRegularFile(runtime.sidecar, 'SIDECAR_UNAVAILABLE', { executable: true })
}

function startSidecar(runtime, env, capability) {
  const hash = createHash('sha256')
  let logBytes = 0
  const child = spawn(runtime.sidecar, ['serve', '--desktop', '--config', runtime.config], {
    cwd: runtime.run_root,
    env: {
      ...env,
      HEXCLAW_ASSET_ROOT: runtime.asset_root,
      HEXCLAW_SIDECAR_CAPABILITY_TOKEN: capability,
      DINGTALK_LIVE_SEND: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => {
      logBytes += chunk.length
      hash.update(chunk)
    })
  }
  return { child, hash, logBytes: () => logBytes }
}

async function stopSidecar(processState) {
  const child = processState.child
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  const closed = new Promise((resolveClose) => child.once('close', resolveClose))
  const graceful = await Promise.race([closed.then(() => true), sleep(10_000).then(() => false)])
  if (!graceful && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
    await closed
  }
  return {
    sha256: processState.hash.digest('hex'),
    bytes: processState.logBytes(),
    forced: !graceful,
  }
}

async function apiContext(runtime, capability) {
  return await playwrightRequest.newContext({
    baseURL: runtime.base_url,
    extraHTTPHeaders: {
      Accept: 'application/json',
      Authorization: `Bearer ${capability}`,
    },
  })
}

async function apiFetch(api, method, pathname, options = {}) {
  let response
  try {
    response = await api.fetch(pathname, {
      method,
      data: options.data,
      multipart: options.multipart,
      timeout: options.timeout ?? REQUEST_TIMEOUT_MS,
      failOnStatusCode: false,
    })
  } catch {
    throw new HarnessError(options.code ?? 'PUBLIC_API_REQUEST_FAILED')
  }
  const bytes = await response.body()
  if (!(options.allowed ?? [200]).includes(response.status())) {
    const error = new HarnessError(options.code ?? 'PUBLIC_API_STATUS_INVALID')
    error.diagnostic_sha256 = sha256Bytes(bytes)
    throw error
  }
  if (options.bytes) return { status: response.status(), bytes, headers: response.headers() }
  try {
    return { status: response.status(), value: JSON.parse(bytes.toString('utf8')) }
  } catch {
    throw new HarnessError(options.code ?? 'PUBLIC_API_JSON_INVALID')
  }
}

async function waitForSidecar(api, processState, deadline) {
  const until = Math.min(deadline, Date.now() + START_TIMEOUT_MS)
  while (Date.now() < until) {
    if (processState.child.exitCode !== null || processState.child.signalCode !== null) {
      throw new HarnessError('SIDECAR_EXITED_BEFORE_READY')
    }
    try {
      await apiFetch(api, 'GET', '/api/v1/version', {
        timeout: 2_000,
        code: 'SIDECAR_NOT_READY',
      })
      return
    } catch (error) {
      if (safeCode(error) !== 'SIDECAR_NOT_READY') throw error
    }
    await sleep(250)
  }
  throw new HarnessError('SIDECAR_START_TIMEOUT')
}

async function withSidecar(runtime, env, deadline, operation) {
  const capability = randomBytes(32).toString('hex')
  const processState = startSidecar(runtime, env, capability)
  const api = await apiContext(runtime, capability)
  try {
    await waitForSidecar(api, processState, deadline)
    return await operation(api, processState.child.pid)
  } finally {
    await api.dispose()
    runtime.last_process_log = await stopSidecar(processState)
  }
}

function maskedInstanceConfig(configValue) {
  if (configValue === null || configValue === undefined) return true
  let config = configValue
  if (typeof config === 'string') {
    try {
      config = JSON.parse(config)
    } catch {
      return false
    }
  }
  const secretKey = (key) =>
    ['password', 'secret', 'token', 'apikey', 'privatekey', 'credential'].some((part) =>
      String(key).toLowerCase().replaceAll('_', '').replaceAll('-', '').includes(part),
    )
  const visit = (node, key = '') => {
    if (Array.isArray(node)) return node.every((value) => visit(value, key))
    if (!node || typeof node !== 'object') {
      if (!secretKey(key)) return true
      const value = String(node ?? '').trim()
      return (
        value === '' || value === '****' || /^\*{4}.{4}$/su.test(value) || value === '[REDACTED]'
      )
    }
    return Object.entries(node).every(([childKey, value]) => visit(value, childKey))
  }
  return visit(config)
}

async function waitForBoundInstances(api, targets, deadline) {
  const until = Math.min(deadline, Date.now() + START_TIMEOUT_MS)
  while (Date.now() < until) {
    const projection = (
      await apiFetch(api, 'GET', '/api/v1/platforms/instances', {
        code: 'INSTANCE_PROJECTION_FAILED',
      })
    ).value
    try {
      return assertBoundInstancesProjection(projection, targets)
    } catch (error) {
      if (safeCode(error) !== 'BOUND_INSTANCE_PROJECTION_INVALID') throw error
    }
    await sleep(500)
  }
  throw new HarnessError('BOUND_INSTANCE_PROJECTION_INVALID')
}

export function assertBoundInstancesProjection(projectionValue, targetsValue) {
  const projection = object(projectionValue, 'INSTANCE_PROJECTION_INVALID')
  const instances = array(projection.instances, 'INSTANCE_PROJECTION_INVALID')
  const expected = new Map()
  for (const targetValue of array(targetsValue, 'BOUND_INSTANCE_PROJECTION_INVALID')) {
    const target = physicalTarget(targetValue)
    expected.set(`${target.platform}\0${target.instance_id}`, target)
  }
  if (expected.size === 0) throw new HarnessError('BOUND_INSTANCE_PROJECTION_INVALID')

  const resolved = []
  const resolvedIdentities = new Set()
  for (const target of expected.values()) {
    const candidates = instances.filter(
      (instance) =>
        instance?.provider === target.platform &&
        (String(instance.id ?? '') === target.instance_id ||
          String(instance.name ?? '') === target.instance_id),
    )
    if (candidates.length !== 1) throw new HarnessError('BOUND_INSTANCE_PROJECTION_INVALID')
    const instance = candidates[0]
    if (
      instance.enabled !== true ||
      instance.status !== 'running' ||
      !maskedInstanceConfig(instance.config)
    ) {
      throw new HarnessError('BOUND_INSTANCE_PROJECTION_INVALID')
    }
    const identity = `${target.platform}\0${String(instance.id || instance.name || '')}`
    if (identity.endsWith('\0') || resolvedIdentities.has(identity)) {
      throw new HarnessError('BOUND_INSTANCE_PROJECTION_INVALID')
    }
    resolvedIdentities.add(identity)
    resolved.push(instance)
  }
  return resolved
}

export function assertLLMProjection(value) {
  const projection = object(value, 'LLM_PROJECTION_INVALID')
  const providers = object(projection.providers, 'LLM_PROJECTION_INVALID')
  const provider = object(projection.providers?.[EXPECTED_PROVIDER], 'LLM_PROJECTION_INVALID')
  const models = array(provider.models, 'LLM_PROJECTION_INVALID')
  const specs = array(provider.model_specs, 'LLM_PROJECTION_INVALID').filter(
    (spec) => spec?.id === EXPECTED_MODEL,
  )
  if (specs.length !== 1) throw new HarnessError('LLM_PROJECTION_INVALID')
  const spec = object(specs[0], 'LLM_PROJECTION_INVALID')
  const capabilities = array(spec.capabilities, 'LLM_PROJECTION_INVALID')
  const control = object(spec.reasoning_control, 'LLM_PROJECTION_INVALID')
  if (
    !Object.hasOwn(providers, EXPECTED_PROVIDER) ||
    provider.enabled === false ||
    provider.credential_present !== true ||
    !models.includes(EXPECTED_MODEL) ||
    provider.model_specs_mode !== 'explicit' ||
    !capabilities.includes('text') ||
    !capabilities.includes('vision') ||
    spec.reasoning_support !== 'supported' ||
    control.dialect !== 'reasoning_effort' ||
    control.on !== 'low' ||
    control.off !== 'none' ||
    !Array.isArray(control.allowed_efforts) ||
    control.allowed_efforts.length !== 1 ||
    control.allowed_efforts[0] !== 'low'
  ) {
    throw new HarnessError('LLM_ROUTE_INVALID')
  }
  return {
    provider: EXPECTED_PROVIDER,
    model: EXPECTED_MODEL,
    global_default: String(projection.default ?? '').trim(),
    global_default_affects_fixed_route: false,
    provider_default_model: String(provider.model ?? '').trim(),
    provider_default_model_affects_fixed_route: false,
    capability: { text: true, vision: true },
    reasoning: {
      support: 'supported',
      dialect: 'reasoning_effort',
      low_available: true,
    },
  }
}

function sameTargetSet(left, right) {
  return (
    canonicalJSON(left.map(physicalTargetKey).sort()) ===
    canonicalJSON(right.map(physicalTargetKey).sort())
  )
}

async function preparePhase(env, deadline) {
  const runtime = resolveLiveRuntime(env)
  const contract = await loadContract()
  const gradingReleasePreflight = await assertRuntimeGradingReleasePreflight(
    runtime,
    env,
    contract.projection,
  )
  await initializeRuntime(runtime)
  try {
    const existing = await loadState(runtime)
    assertPreparedGradingReleasePreflight(existing, contract.projection)
    if (
      existing.runtime?.config_sha256 !== (await sha256File(runtime.config)) ||
      existing.runtime?.sidecar_sha256 !== (await sha256File(runtime.sidecar))
    ) {
      throw new HarnessError('PREPARED_RUNTIME_DRIFT')
    }
    return {
      status: 'already_prepared',
      phase: 'prepare',
      run_id_sha256: sha256Text(existing.run_id),
      isolated_agent_sha256: sha256Text(existing.agent_name),
      target_hashes: existing.expected_targets.map(physicalTargetKey).map(sha256Text).sort(),
    }
  } catch (error) {
    if (safeCode(error) !== 'RUN_STATE_UNAVAILABLE') throw error
  }
  const runID = `photo-outbound-${randomUUID()}`
  const isolatedName = `hc-k12-photo-${sha256Text(`${runID}\0${randomUUID()}`).slice(0, 16)}`
  let created = false
  const state = {
    schema_version: 1,
    run_id: runID,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    source_agent_name: runtime.source_agent,
    agent_name: isolatedName,
    expected_targets: [],
    created_rule_ids: [],
    grade_term: '',
    route: { provider: EXPECTED_PROVIDER, model: EXPECTED_MODEL, fallback_allowed: false },
    runtime: {
      config_sha256: await sha256File(runtime.config),
      sidecar_sha256: await sha256File(runtime.sidecar),
      base_url_sha256: sha256Text(runtime.base_url),
      asset_root_sha256: sha256Text(runtime.asset_root),
    },
    grading_release_preflight: gradingReleasePreflight,
    cases: {},
  }
  try {
    await withSidecar(runtime, env, deadline, async (api) => {
      const [llm, agents] = await Promise.all([
        apiFetch(api, 'GET', '/api/v1/config/llm', { code: 'LLM_PROJECTION_FAILED' }),
        apiFetch(api, 'GET', '/api/v1/agents', { code: 'AGENT_PROJECTION_FAILED' }),
      ])
      assertLLMProjection(llm.value)
      const plan = planIsolatedAgent(agents.value, runtime.source_agent, isolatedName)
      await waitForBoundInstances(api, plan.targets, deadline)
      await apiFetch(api, 'POST', '/api/v1/agents', {
        data: plan.agent,
        code: 'ISOLATED_AGENT_CREATE_FAILED',
      })
      created = true
      for (const rule of plan.rules) {
        const added = await apiFetch(api, 'POST', '/api/v1/agents/rules', {
          data: rule,
          code: 'ISOLATED_RULE_CREATE_FAILED',
        })
        state.created_rule_ids.push(added.value.id)
      }
      const verified = (
        await apiFetch(api, 'GET', '/api/v1/agents', { code: 'ISOLATED_AGENT_VERIFY_FAILED' })
      ).value
      const verifiedPlan = planIsolatedAgent(verified, isolatedName, isolatedName)
      if (!sameTargetSet(verifiedPlan.targets, plan.targets)) {
        throw new HarnessError('ISOLATED_TARGET_SET_DRIFT')
      }
      state.expected_targets = plan.targets
      state.grade_term = plan.grade_term
    })
  } catch (error) {
    if (created) {
      try {
        await withSidecar(runtime, env, deadline, async (api) => {
          await apiFetch(api, 'DELETE', `/api/v1/agents/${encodeURIComponent(isolatedName)}`, {
            code: 'ISOLATED_AGENT_ROLLBACK_FAILED',
          })
        })
      } catch {
        // 回滚失败保留唯一隔离 Agent，不会创建第二个身份。
      }
    }
    throw error
  }
  state.last_process_log = runtime.last_process_log
  // Agent 与路由由公开 API 持久化后，以停机后的显式配置作为后续阶段指纹。
  state.runtime.config_sha256 = await sha256File(runtime.config)
  await saveState(runtime, state)
  const projection = {
    status: 'prepared',
    phase: 'prepare',
    run_id_sha256: sha256Text(runID),
    isolated_agent_sha256: sha256Text(isolatedName),
    route: state.route,
    target_count: state.expected_targets.length,
    target_hashes: state.expected_targets.map(physicalTargetKey).map(sha256Text).sort(),
    config_sha256: state.runtime.config_sha256,
    sidecar_sha256: state.runtime.sidecar_sha256,
    sidecar_stopped: true,
  }
  await recordEvidence(runtime, 'prepare', projection)
  return projection
}

function fixturePath(fixture) {
  const pathname = resolve(DEFAULT_DOCS_ROOT, fixture.docs_relative_path)
  if (!pathname.startsWith(`${DEFAULT_DOCS_ROOT}/`)) throw new HarnessError('FIXTURE_PATH_INVALID')
  return pathname
}

function publicAssetPath(assetIDValue, agentNameValue) {
  const assetID = nonEmpty(assetIDValue, 'ASSET_ID_INVALID')
  const agentName = nonEmpty(agentNameValue, 'ASSET_ID_INVALID')
  const prefix = `asset://${agentName}/`
  if (!assetID.startsWith(prefix)) throw new HarnessError('ASSET_ID_INVALID')
  const file = assetID.slice(prefix.length)
  if (!file || file.includes('/')) throw new HarnessError('ASSET_ID_INVALID')
  return `/api/k12/assets/${encodeURIComponent(file)}?agent=${encodeURIComponent(agentName)}`
}

async function validateFixture(pathname, fixture) {
  const info = await requireRegularFile(pathname, 'FIXTURE_UNAVAILABLE')
  if (info.size !== fixture.size_bytes || (await sha256File(pathname)) !== fixture.sha256) {
    throw new HarnessError('FIXTURE_IDENTITY_DRIFT')
  }
}

function recursiveArtifact(value, artifactID = '') {
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = recursiveArtifact(child, artifactID)
      if (found) return found
    }
    return null
  }
  if (!value || typeof value !== 'object') return null
  if (
    typeof value.artifact_id === 'string' &&
    value.artifact_id &&
    (!artifactID || value.artifact_id === artifactID)
  ) {
    return value
  }
  for (const child of Object.values(value)) {
    const found = recursiveArtifact(child, artifactID)
    if (found) return found
  }
  return null
}

async function imagePixelDeltas(sourceBytes, sourceMIME, annotatedBytes, annotatedMIME) {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    return await page.evaluate(
      async (input) => {
        const decode = async (base64, mime) => {
          const image = new Image()
          image.src = `data:${mime};base64,${base64}`
          await image.decode()
          const canvas = document.createElement('canvas')
          canvas.width = image.naturalWidth
          canvas.height = image.naturalHeight
          const context = canvas.getContext('2d', { willReadFrequently: true })
          if (!context) throw new Error('CANVAS_UNAVAILABLE')
          context.drawImage(image, 0, 0)
          return {
            width: canvas.width,
            height: canvas.height,
            pixels: context.getImageData(0, 0, canvas.width, canvas.height).data,
          }
        }
        const source = await decode(input.source_base64, input.source_mime)
        const annotated = await decode(input.annotated_base64, input.annotated_mime)
        if (source.width !== annotated.width || source.height !== annotated.height) {
          return {
            source_width: source.width,
            source_height: source.height,
            annotated_width: annotated.width,
            annotated_height: annotated.height,
            pixel_deltas: [],
          }
        }
        const deltas = []
        for (let offset = 0; offset < source.pixels.length; offset += 4) {
          if (
            source.pixels[offset] !== annotated.pixels[offset] ||
            source.pixels[offset + 1] !== annotated.pixels[offset + 1] ||
            source.pixels[offset + 2] !== annotated.pixels[offset + 2] ||
            source.pixels[offset + 3] !== annotated.pixels[offset + 3]
          ) {
            const pixel = offset / 4
            deltas.push({
              x: pixel % source.width,
              y: Math.floor(pixel / source.width),
              source: Array.from(source.pixels.slice(offset, offset + 4)),
              annotated: Array.from(annotated.pixels.slice(offset, offset + 4)),
            })
          }
        }
        return {
          source_width: source.width,
          source_height: source.height,
          annotated_width: annotated.width,
          annotated_height: annotated.height,
          pixel_deltas: deltas,
        }
      },
      {
        source_base64: sourceBytes.toString('base64'),
        source_mime: sourceMIME,
        annotated_base64: annotatedBytes.toString('base64'),
        annotated_mime: annotatedMIME,
      },
    )
  } finally {
    await browser.close()
  }
}

async function analyzeGeometry(input) {
  const vite = await createViteServer({
    root: DESKTOP_ROOT,
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true },
  })
  try {
    const module = await vite.ssrLoadModule('/tests/live/k12-photo-annotation-coverage.ts')
    if (typeof module.analyzePhotoAnnotationGeometry !== 'function') {
      throw new HarnessError('ANNOTATION_ORACLE_EXPORT_INVALID')
    }
    return await module.analyzePhotoAnnotationGeometry(input)
  } finally {
    await vite.close()
  }
}

async function assertAnnotationGeometry(pathname, fixture, payload, final) {
  const sourceBytes = await readFile(pathname)
  const facts = await imagePixelDeltas(
    sourceBytes,
    fixture.mime,
    final.annotated_bytes,
    final.annotated_mime,
  )
  if (
    facts.source_width !== fixture.width ||
    facts.source_height !== fixture.height ||
    facts.annotated_width !== fixture.width ||
    facts.annotated_height !== fixture.height
  ) {
    throw new HarnessError('ANNOTATION_GEOMETRY_DIMENSION_DRIFT')
  }
  const trustedItems = buildTrustedGeometryItems(payload, fixture)
  const report = await analyzeGeometry({
    width: fixture.width,
    height: fixture.height,
    sourceDigest: final.source_attachment_digest,
    annotatedDigest: final.annotated_digest,
    changedPixels: facts.pixel_deltas,
    items: trustedItems,
    expectedCounts: fixture.expected_counts,
  })
  if (report?.status !== 'PASS') throw new HarnessError('ANNOTATION_GEOMETRY_FAILED')
  return {
    status: report.status,
    width: report.width,
    height: report.height,
    changed_pixels: report.changed_pixels,
    palette_pixels: report.palette_pixels,
    expected_counts: report.expected_counts,
    observed_counts: report.observed_counts,
    mapping_hashes: array(report.mappings, 'ANNOTATION_GEOMETRY_INVALID')
      .map((mapping) => nonEmpty(mapping.cluster_sha256, 'ANNOTATION_GEOMETRY_INVALID'))
      .sort(),
    item_statuses: trustedItems.map((item) => `${item.question}:${item.status}`),
  }
}

function caseURL(state, suffix = '') {
  return `/api/k12/image-tasks/${encodeURIComponent(state.dispatch_id)}${suffix}?agent=${encodeURIComponent(
    state.agent_name,
  )}`
}

async function fetchCaseTask(api, state, caseState) {
  return (
    await apiFetch(api, 'GET', caseURL({ ...caseState, agent_name: state.agent_name }), {
      code: 'IMAGE_TASK_QUERY_FAILED',
    })
  ).value.dispatch
}

async function fetchCaseResult(api, state, caseState) {
  return (
    await apiFetch(api, 'GET', caseURL({ ...caseState, agent_name: state.agent_name }, '/result'), {
      code: 'IMAGE_TASK_RESULT_QUERY_FAILED',
    })
  ).value
}

async function settleDelivery(api, runtime, state, caseState, initialBatch, deadline) {
  let batch = object(initialBatch, 'DELIVERY_BATCH_INVALID')
  caseState.batch_id = nonEmpty(batch.batch_id, 'DELIVERY_BATCH_INVALID')
  await saveState(runtime, state)
  while (Date.now() < deadline - CLEANUP_RESERVE_MS) {
    if (batch.status === 'delivered') return batch
    if (['failed', 'partial_failed'].includes(batch.status)) {
      throw new HarnessError('DELIVERY_TERMINAL_FAILURE')
    }
    const batchID = encodeURIComponent(caseState.batch_id)
    if (batch.status === 'outcome_unknown') {
      if (caseState.outcome_unknown_query_invoked === true) {
        throw new PhasePending('DELIVERY_OUTCOME_UNKNOWN_PENDING', {
          batch_status: batch.status,
          provider_query_invoked: true,
        })
      }
      caseState.outcome_unknown_query_invoked = true
      await saveState(runtime, state)
      batch = (
        await apiFetch(api, 'POST', `/api/k12/delivery-batches/${batchID}/query`, {
          data: { agent: state.agent_name },
          code: 'DELIVERY_PROVIDER_QUERY_FAILED',
        })
      ).value
      continue
    }
    if (batch.status === 'sending') {
      batch = (
        await apiFetch(api, 'POST', `/api/k12/delivery-batches/${batchID}/query`, {
          data: { agent: state.agent_name },
          code: 'DELIVERY_PROVIDER_QUERY_FAILED',
        })
      ).value
      caseState.provider_query_count = (caseState.provider_query_count ?? 0) + 1
      await saveState(runtime, state)
      if (batch.status === 'delivered') return batch
    } else if (batch.status !== 'pending') {
      throw new HarnessError('DELIVERY_STATUS_INVALID')
    }
    await sleep(2_000)
    batch = (
      await apiFetch(
        api,
        'GET',
        `/api/k12/delivery-batches/${batchID}?agent=${encodeURIComponent(state.agent_name)}`,
        { code: 'DELIVERY_BATCH_QUERY_FAILED' },
      )
    ).value
  }
  throw new PhasePending('DELIVERY_PENDING', { batch_status: batch.status ?? 'unknown' })
}

async function observeCompletedCase(
  api,
  runtime,
  state,
  caseState,
  fixture,
  pathname,
  dispatch,
  deadline,
) {
  if (
    dispatch.status !== 'routed' ||
    dispatch.model_id !== EXPECTED_MODEL ||
    dispatch.task_intent !== 'completed_homework'
  ) {
    throw new HarnessError('REAL_IMAGE_TASK_ROUTE_INVALID')
  }
  const result = await fetchCaseResult(api, state, caseState)
  const artifact = recursiveArtifact(dispatch)
  if (!artifact) throw new HarnessError('FINAL_ARTIFACT_NOT_PUBLIC')
  const final = assertFinalArtifactProjection({ result, artifact })
  const admitted = await apiFetch(
    api,
    'GET',
    publicAssetPath(caseState.asset_id, state.agent_name),
    {
      bytes: true,
      code: 'ASSET_ROUND_TRIP_FAILED',
    },
  )
  if (!String(admitted.headers['content-type'] ?? '').startsWith(fixture.mime)) {
    throw new HarnessError('ASSET_ROUND_TRIP_FAILED')
  }
  const sourceIdentity = assertPublicSourceIdentity({
    raw_bytes: admitted.bytes,
    fixture_sha256: fixture.sha256,
    fixture_size_bytes: fixture.size_bytes,
    canonical_aggregate_digest: final.source_digest,
    canonical_attachment_digest: final.source_attachment_digest,
    canonical_attachment_size_bytes: final.source_attachment_size,
  })
  const geometry = await assertAnnotationGeometry(pathname, fixture, final.payload, final)
  let batch = (
    await apiFetch(api, 'POST', '/api/k12/tutoring-tips/send', {
      data: {
        agent: state.agent_name,
        final_artifact_id: final.artifact_id,
        final_artifact_digest: final.artifact_digest,
      },
      code: 'FINAL_DELIVERY_SEND_FAILED',
    })
  ).value
  batch = await settleDelivery(api, runtime, state, caseState, batch, deadline)
  const delivery = assertFinalDeliveryExactSet(batch, {
    agent_name: state.agent_name,
    final_artifact_id: final.artifact_id,
    final_artifact_digest: final.artifact_digest,
    canonical_markdown: final.canonical_markdown,
    annotated_mime: final.annotated_mime,
    annotated_digest: final.annotated_digest,
    annotated_bytes: final.annotated_bytes,
    expected_targets: state.expected_targets,
  })
  const digestChain = assertStageDigestChain({
    expected_raw_digest: fixture.sha256,
    admission_raw_digest: sourceIdentity.raw_digest,
    canonical_aggregate_digest: sourceIdentity.canonical_aggregate_digest,
    canonical_attachment_digest: sourceIdentity.canonical_attachment_digest,
    final_artifact_digest: final.artifact_digest,
    final_annotated_digest: final.annotated_digest,
    delivered_annotated_digest: final.annotated_digest,
    operation_receipts: result.operation_receipts,
  })
  caseState.final = {
    artifact_id: final.artifact_id,
    artifact_digest: final.artifact_digest,
    annotated_digest: final.annotated_digest,
    annotated_mime: final.annotated_mime,
  }
  caseState.baseline = replayInvariant({
    dispatch_id: caseState.dispatch_id,
    final_artifact_id: final.artifact_id,
    final_artifact_digest: final.artifact_digest,
    annotated_digest: final.annotated_digest,
    operation_receipts: result.operation_receipts,
    batch,
  })
  caseState.completed = true
  caseState.geometry = geometry
  await saveState(runtime, state)
  return {
    status: 'completed',
    fixture_sha256: fixture.sha256,
    dispatch_id_sha256: sha256Text(caseState.dispatch_id),
    final_artifact_id_sha256: sha256Text(final.artifact_id),
    final_artifact_digest: final.artifact_digest,
    annotated_digest: final.annotated_digest,
    raw_source_digest: sourceIdentity.raw_digest,
    canonical_source_digest: sourceIdentity.canonical_aggregate_digest,
    canonical_source_attachment_digest: sourceIdentity.canonical_attachment_digest,
    canonical_source_attachment_size_bytes: sourceIdentity.canonical_attachment_size_bytes,
    operation_receipt_count: final.operation_receipts.length,
    digest_chain: digestChain,
    geometry,
    delivery,
  }
}

async function observeTerminalCase(api, runtime, state, caseState, key, dispatch) {
  const result = await fetchCaseResult(api, state, caseState)
  const terminal = projectTerminalImageTaskFailure(dispatch, result)
  const projection = {
    status: 'failed',
    phase: key,
    dispatch_id_sha256: sha256Text(caseState.dispatch_id),
    terminal,
    cleanup: {
      isolated_agent_retained: true,
      frozen_dispatch_retained: true,
      source_asset_retained: true,
      automatic_cleanup_performed: false,
      delivery_started: false,
      im_send_count: 0,
      reason: 'retain_frozen_run_for_diagnosis',
    },
  }
  caseState.terminal = terminal
  caseState.cleanup = projection.cleanup
  await saveState(runtime, state)
  await recordEvidence(runtime, `${key}-terminal`, projection)
  throw new TerminalEvidenceRecorded('IMAGE_TASK_TERMINAL_EVIDENCE_RECORDED', projection)
}

async function verifyPreparedRuntime(api, state, deadline) {
  const [llm, agents] = await Promise.all([
    apiFetch(api, 'GET', '/api/v1/config/llm', { code: 'LLM_PROJECTION_FAILED' }),
    apiFetch(api, 'GET', '/api/v1/agents', { code: 'AGENT_PROJECTION_FAILED' }),
  ])
  assertLLMProjection(llm.value)
  const plan = planIsolatedAgent(agents.value, state.agent_name, state.agent_name)
  if (!sameTargetSet(plan.targets, state.expected_targets)) {
    throw new HarnessError('ISOLATED_TARGET_SET_DRIFT')
  }
  await waitForBoundInstances(api, state.expected_targets, deadline)
}

async function casePhase(key, env, deadline) {
  const contract = await loadContract()
  const fixture = contract.projection.fixtures[key]
  if (!fixture) throw new HarnessError('CASE_INVALID')
  const runtime = resolveLiveRuntime(env)
  await initializeRuntime(runtime)
  const state = await loadState(runtime)
  assertPreparedGradingReleasePreflight(state, contract.projection)
  if (
    state.schema_version !== 1 ||
    state.route?.provider !== EXPECTED_PROVIDER ||
    state.route?.model !== EXPECTED_MODEL ||
    state.runtime?.config_sha256 !== (await sha256File(runtime.config)) ||
    state.runtime?.sidecar_sha256 !== (await sha256File(runtime.sidecar))
  ) {
    throw new HarnessError('PREPARED_RUNTIME_DRIFT')
  }
  state.cases[key] = state.cases[key] ?? {
    key,
    source_session: `${state.run_id}:${key}`,
    source_ref: `photo-outbound:${state.run_id}:${key}`,
    attempt_generation: 1,
  }
  const caseState = state.cases[key]
  if (caseState.completed) {
    return {
      status: 'already_completed',
      phase: key,
      dispatch_id_sha256: sha256Text(caseState.dispatch_id),
      final_artifact_digest: caseState.final.artifact_digest,
      annotated_digest: caseState.final.annotated_digest,
    }
  }
  const pathname = fixturePath(fixture)
  await validateFixture(pathname, fixture)
  let proof
  try {
    await withSidecar(runtime, env, deadline, async (api) => {
      await verifyPreparedRuntime(api, state, deadline)
      if (!caseState.asset_id) {
        const bytes = await readFile(pathname)
        const uploaded = (
          await apiFetch(
            api,
            'POST',
            `/api/k12/assets?agent=${encodeURIComponent(state.agent_name)}`,
            {
              multipart: {
                file: { name: basename(pathname), mimeType: fixture.mime, buffer: bytes },
              },
              code: 'ASSET_UPLOAD_FAILED',
            },
          )
        ).value
        caseState.asset_id = nonEmpty(uploaded?.asset_id, 'ASSET_UPLOAD_INVALID')
        if (uploaded.size !== fixture.size_bytes) throw new HarnessError('ASSET_UPLOAD_INVALID')
        await saveState(runtime, state)
      }
      if (!caseState.dispatch_id) {
        const created = (
          await apiFetch(api, 'POST', '/api/k12/image-tasks', {
            data: {
              agent: state.agent_name,
              source_session: caseState.source_session,
              source_kind: 'api',
              source_ref: caseState.source_ref,
              source_asset_refs: [caseState.asset_id],
              message_intent:
                '这是孩子用手机拍的已完成数学作业，请逐题核对，在原图上准确批注，并用中文 Markdown 给家长讲解。',
              attempt_generation: caseState.attempt_generation,
              route_request: {
                provider: EXPECTED_PROVIDER,
                model: EXPECTED_MODEL,
                selection_source: 'explicit',
              },
            },
            code: 'IMAGE_TASK_CREATE_FAILED',
          })
        ).value
        caseState.dispatch_id = nonEmpty(
          created?.dispatch?.dispatch_id,
          'IMAGE_TASK_CREATE_INVALID',
        )
        await saveState(runtime, state)
      }
      while (Date.now() < deadline - CLEANUP_RESERVE_MS) {
        const dispatch = await fetchCaseTask(api, state, caseState)
        caseState.last_progress = {
          status: dispatch.status,
          operation: dispatch.progress?.operation,
          state: dispatch.progress?.state,
          version: dispatch.version,
        }
        await saveState(runtime, state)
        if (dispatch.status === 'failed') {
          await observeTerminalCase(api, runtime, state, caseState, key, dispatch)
        }
        const command = nextImageTaskCommand(dispatch, state.agent_name, state.grade_term)
        if (command.kind === 'completed') {
          proof = await observeCompletedCase(
            api,
            runtime,
            state,
            caseState,
            fixture,
            pathname,
            dispatch,
            deadline,
          )
          return
        }
        if (command.kind === 'confirm_intent' || command.kind === 'confirm_recognition') {
          await apiFetch(api, 'POST', command.path, {
            data: command.data,
            code: 'IMAGE_TASK_CONFIRM_FAILED',
          })
          caseState.confirmations = caseState.confirmations ?? []
          if (!caseState.confirmations.includes(command.kind)) {
            caseState.confirmations.push(command.kind)
          }
          await saveState(runtime, state)
          continue
        }
        await sleep(2_000)
      }
      throw new PhasePending('IMAGE_TASK_PENDING', caseState.last_progress)
    })
  } finally {
    state.last_process_log = runtime.last_process_log
    await saveState(runtime, state)
  }
  const projection = { ...proof, phase: key, sidecar_stopped: true }
  await recordEvidence(runtime, key, projection)
  return projection
}

async function restartReplayCase(api, runtime, state, key, deadline) {
  const caseState = object(state.cases?.[key], 'CASE_COMPLETION_REQUIRED')
  if (!caseState.completed || !caseState.baseline || !caseState.batch_id) {
    throw new HarnessError('CASE_COMPLETION_REQUIRED')
  }
  const dispatch = await fetchCaseTask(api, state, caseState)
  const result = await fetchCaseResult(api, state, caseState)
  const artifact = recursiveArtifact(dispatch, caseState.final?.artifact_id)
  if (!artifact) throw new HarnessError('FINAL_ARTIFACT_NOT_PUBLIC')
  const final = assertFinalArtifactProjection({ result, artifact })
  const batchID = encodeURIComponent(caseState.batch_id)
  const beforeReplayBatch = (
    await apiFetch(
      api,
      'GET',
      `/api/k12/delivery-batches/${batchID}?agent=${encodeURIComponent(state.agent_name)}`,
      { code: 'DELIVERY_BATCH_QUERY_FAILED' },
    )
  ).value
  assertFinalDeliveryExactSet(beforeReplayBatch, {
    agent_name: state.agent_name,
    final_artifact_id: final.artifact_id,
    final_artifact_digest: final.artifact_digest,
    canonical_markdown: final.canonical_markdown,
    annotated_mime: final.annotated_mime,
    annotated_digest: final.annotated_digest,
    annotated_bytes: final.annotated_bytes,
    expected_targets: state.expected_targets,
  })
  const restartSnapshot = {
    dispatch_id: caseState.dispatch_id,
    final_artifact_id: final.artifact_id,
    final_artifact_digest: final.artifact_digest,
    annotated_digest: final.annotated_digest,
    operation_receipts: result.operation_receipts,
    batch: beforeReplayBatch,
  }
  assertRestartReplayInvariant(caseState.baseline, restartSnapshot)

  let replayed = (
    await apiFetch(api, 'POST', '/api/k12/tutoring-tips/send', {
      data: {
        agent: state.agent_name,
        final_artifact_id: final.artifact_id,
        final_artifact_digest: final.artifact_digest,
      },
      code: 'FINAL_DELIVERY_REPLAY_FAILED',
    })
  ).value
  replayed = await settleDelivery(api, runtime, state, caseState, replayed, deadline)
  assertFinalDeliveryExactSet(replayed, {
    agent_name: state.agent_name,
    final_artifact_id: final.artifact_id,
    final_artifact_digest: final.artifact_digest,
    canonical_markdown: final.canonical_markdown,
    annotated_mime: final.annotated_mime,
    annotated_digest: final.annotated_digest,
    annotated_bytes: final.annotated_bytes,
    expected_targets: state.expected_targets,
  })
  const afterTask = await fetchCaseTask(api, state, caseState)
  const afterResult = await fetchCaseResult(api, state, caseState)
  const afterArtifact = recursiveArtifact(afterTask, final.artifact_id)
  if (!afterArtifact) throw new HarnessError('FINAL_ARTIFACT_NOT_PUBLIC')
  const afterFinal = assertFinalArtifactProjection({ result: afterResult, artifact: afterArtifact })
  const afterBatch = (
    await apiFetch(
      api,
      'GET',
      `/api/k12/delivery-batches/${batchID}?agent=${encodeURIComponent(state.agent_name)}`,
      { code: 'DELIVERY_BATCH_QUERY_FAILED' },
    )
  ).value
  const afterSnapshot = {
    dispatch_id: caseState.dispatch_id,
    final_artifact_id: afterFinal.artifact_id,
    final_artifact_digest: afterFinal.artifact_digest,
    annotated_digest: afterFinal.annotated_digest,
    operation_receipts: afterResult.operation_receipts,
    batch: afterBatch,
  }
  assertRestartReplayInvariant(caseState.baseline, afterSnapshot)
  caseState.replay_verified = true
  await saveState(runtime, state)
  return {
    fixture: key,
    dispatch_id_sha256: sha256Text(caseState.dispatch_id),
    final_artifact_id_sha256: sha256Text(final.artifact_id),
    final_artifact_digest: final.artifact_digest,
    annotated_digest: final.annotated_digest,
    batch_id_sha256: sha256Text(caseState.batch_id),
    operation_receipt_count: afterFinal.operation_receipts.length,
    delivery_receipt_count: afterBatch.receipts.length,
    model_call_delta: 0,
    provider_send_delta: 0,
  }
}

async function restartReplayPhase(env, deadline) {
  const contract = await loadContract()
  const runtime = resolveLiveRuntime(env)
  await initializeRuntime(runtime)
  const state = await loadState(runtime)
  assertPreparedGradingReleasePreflight(state, contract.projection)
  if (!state.cases?.clear?.completed || !state.cases?.messy?.completed) {
    throw new HarnessError('ALL_CASES_COMPLETION_REQUIRED')
  }
  if (
    state.runtime?.config_sha256 !== (await sha256File(runtime.config)) ||
    state.runtime?.sidecar_sha256 !== (await sha256File(runtime.sidecar))
  ) {
    throw new HarnessError('PREPARED_RUNTIME_DRIFT')
  }
  if (state.cases.clear.replay_verified && state.cases.messy.replay_verified) {
    return {
      status: 'already_verified',
      phase: 'restart-replay',
      cases: 2,
      model_call_delta: 0,
      provider_send_delta: 0,
    }
  }
  const proofs = []
  try {
    await withSidecar(runtime, env, deadline, async (api) => {
      await verifyPreparedRuntime(api, state, deadline)
      for (const key of ['clear', 'messy']) {
        proofs.push(await restartReplayCase(api, runtime, state, key, deadline))
      }
    })
  } finally {
    state.last_process_log = runtime.last_process_log
    await saveState(runtime, state)
  }
  const projection = {
    status: 'verified',
    phase: 'restart-replay',
    cases: proofs,
    model_call_delta: 0,
    provider_send_delta: 0,
    sidecar_stopped: true,
  }
  await recordEvidence(runtime, 'restart-replay', projection)
  return projection
}

async function statusPhase(env) {
  const runtime = resolveLiveRuntime(env)
  const state = await loadState(runtime)
  const cases = Object.fromEntries(
    ['clear', 'messy'].map((key) => {
      const value = state.cases?.[key]
      return [
        key,
        {
          created: Boolean(value?.dispatch_id),
          completed: value?.completed === true,
          replay_verified: value?.replay_verified === true,
          terminal_failed: Boolean(value?.terminal),
          ...(value?.terminal?.failure_stage
            ? { failure_stage: value.terminal.failure_stage }
            : {}),
          ...(typeof value?.terminal?.retry_safety?.public_retryable === 'boolean'
            ? { public_retryable: value.terminal.retry_safety.public_retryable }
            : {}),
          ...(value?.final?.artifact_digest
            ? { final_artifact_digest: value.final.artifact_digest }
            : {}),
          ...(value?.final?.annotated_digest
            ? { annotated_digest: value.final.annotated_digest }
            : {}),
        },
      ]
    }),
  )
  return {
    status: 'observed',
    phase: 'status',
    run_id_sha256: sha256Text(state.run_id),
    isolated_agent_sha256: sha256Text(state.agent_name),
    target_count: state.expected_targets.length,
    cases,
  }
}

async function loadContract() {
  const [contract, oracleBytes] = await Promise.all([
    readFile(CONTRACT_PATH, 'utf8').then(JSON.parse),
    readFile(DEFAULT_ORACLE_PATH),
  ])
  return {
    raw: contract,
    projection: validatePublicOutboundContract(contract, oracleBytes),
  }
}

function assertEvidenceSafe(value, key = '') {
  const forbidden = new Set([
    'agent_name',
    'api_key',
    'capability',
    'chat_id',
    'config_path',
    'instance_id',
    'payload_json',
    'token',
  ])
  if (forbidden.has(key)) throw new HarnessError('UNSAFE_EVIDENCE_FIELD')
  if (typeof value === 'string') {
    if (/\/Users\/|\bBearer\s+|\bapi[_-]?key\b/iu.test(value)) {
      throw new HarnessError('UNSAFE_EVIDENCE_VALUE')
    }
    return value
  }
  if (Array.isArray(value)) {
    for (const item of value) assertEvidenceSafe(item, key)
    return value
  }
  if (value && typeof value === 'object') {
    for (const [childKey, child] of Object.entries(value)) assertEvidenceSafe(child, childKey)
  }
  return value
}

async function validatePhase() {
  const contract = await loadContract()
  return {
    status: 'PASS',
    phase: 'validate',
    route: contract.projection.route,
    fixture_hashes: Object.fromEntries(
      Object.entries(contract.projection.fixtures).map(([key, fixture]) => [key, fixture.sha256]),
    ),
    public_api_count: Object.keys(contract.projection.public_api).length,
    synthetic_inbound_stream: false,
    sqlite_read_or_write: false,
    grading_calibration_approval_status:
      contract.projection.grading_budget_preflight.approval.status,
    model_calls: 0,
    im_sends: 0,
  }
}

async function runPhase(phase, env, deadline) {
  switch (phase) {
    case 'validate':
      return await validatePhase()
    case 'prepare':
      return await preparePhase(env, deadline)
    case 'clear':
      return await casePhase('clear', env, deadline)
    case 'messy':
      return await casePhase('messy', env, deadline)
    case 'restart-replay':
      return await restartReplayPhase(env, deadline)
    case 'status':
      return await statusPhase(env)
    default:
      throw new HarnessError('INVALID_PHASE')
  }
}

async function main() {
  const phase = resolvePhase(process.argv.slice(2))
  const deadline = Date.now() + phaseBudgetMilliseconds(process.env)
  try {
    const result = await runPhase(phase, process.env, deadline)
    process.stdout.write(`${JSON.stringify(assertEvidenceSafe(result), null, 2)}\n`)
  } catch (error) {
    const pending = error instanceof PhasePending
    const terminal = error instanceof TerminalEvidenceRecorded
    const preflight = error instanceof GradingReleasePreflightRejected
    const output = {
      status: pending ? 'pending' : 'failed',
      phase,
      code: safeCode(error),
      ...(pending || terminal || preflight ? { projection: error.projection } : {}),
    }
    process.stderr.write(`${JSON.stringify(assertEvidenceSafe(output), null, 2)}\n`)
    process.exitCode = pending ? PENDING_EXIT_CODE : 1
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath === resolve(SCRIPT_PATH)) await main()
