#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync, statSync, unlinkSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { readAttestedFileSnapshot } from './k12-attested-file.mjs'
import {
  frozenRecognitionV2Policy,
  parseSidecarBinding,
} from './k12-current-bug-isolated-sidecar-control.mjs'
import { parseStrictJSON } from './k12-strict-json.mjs'

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

const GRADING_REQUIRED_ENVIRONMENT = [
  'HEX_K12_LIVE_GRADING_CALIBRATION_ARTIFACT',
  'HEX_K12_LIVE_GRADING_CALIBRATION_SHA256',
]

const RECOGNITION_V2_REQUIRED_ENVIRONMENT = [
  'HEX_K12_LIVE_RECOGNITION_CALIBRATION_ARTIFACT',
  'HEX_K12_LIVE_RECOGNITION_CALIBRATION_SHA256',
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

const GRADING_CALIBRATION_FIELDS = [
  'approval_ref',
  'approval_status',
  'evidence_sha256',
  'grading_budget',
  'measurements',
  'model',
  'provider',
  'schema_version',
  'sidecar_config_sha256',
]

const GRADING_CALIBRATION_APPROVAL_FIELDS = [
  'approval_ref',
  'artifact_sha256',
  'model',
  'provider',
  'release_config_sha256',
  'status',
]

const RECOGNITION_CALIBRATION_FIELDS = [
  'adapter_worker_hard_cap',
  'approval_ref',
  'approval_status',
  'budget_buckets_millis',
  'evidence_sha256',
  'layout_batch_policy_sha256',
  'measurements',
  'model',
  'physical_call_timeout_ms',
  'provider',
  'recognition_plan_version',
  'release_effective_concurrency',
  'schema_version',
  'sidecar_config_sha256',
  'singleton_repair_policy_sha256',
  'stage',
  'whole_manifest_policy_sha256',
]

const RECOGNITION_CALIBRATION_MEASUREMENT_FIELDS = [
  'complete',
  'max_problems',
  'p50_ms',
  'p95_ms',
  'physical_provider_calls',
  'result_digest',
  'sample_count',
  'source_fixture_sha256',
  'success_count',
]

const RECOGNITION_CALIBRATION_APPROVAL_FIELDS = [
  'approval_ref',
  'artifact_sha256',
  'model',
  'provider',
  'recognition_plan_version',
  'release_config_sha256',
  'stage',
  'status',
]

const RECOGNITION_POLICY_FIELDS = [
  'adapter_worker_hard_cap',
  'budget_buckets_millis',
  'effective_concurrency',
  'physical_call_cap_millis',
]

const RECOGNITION_BUCKET_FIELDS = [
  'up_to_1_problem_millis',
  'up_to_8_problems_millis',
  'up_to_16_problems_millis',
  'up_to_32_problems_millis',
]

const GRADING_BUDGET_FIELDS = [
  'assessing_buckets',
  'item_concurrency',
  'locating_seconds',
  'normalizing_seconds',
  'policy_version',
  'projecting_seconds',
  'queued_seconds',
  'recognizing_seconds',
  'rendering_seconds',
]

const GRADING_BUDGET_BUCKET_FIELDS = ['max_problems', 'seconds']

const GRADING_CALIBRATION_MEASUREMENT_FIELDS = [
  'complete',
  'logical_operations',
  'max_problems',
  'p50_ms',
  'p95_ms',
  'physical_provider_calls',
  'result_digest',
  'sample_count',
  'success_count',
]

const GRADING_CALIBRATION_BUCKETS = [1, 8, 16, 32]

const FIXTURE_ENVIRONMENT = [
  'HEX_K12_LIVE_RETRYABLE_DISPATCH_ID',
  'HEX_K12_LIVE_OUTCOME_UNKNOWN_DISPATCH_ID',
]

function fail(message) {
  throw new Error(`K12 fixture orchestration: ${message}`)
}

function canonicalTmp(pathname) {
  return (
    pathname === '/tmp' ||
    pathname.startsWith(`/tmp${sep}`) ||
    pathname === '/private/tmp' ||
    pathname.startsWith(`/private/tmp${sep}`)
  )
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

function exactObjectFields(value, fields) {
  if (!value || Array.isArray(value) || typeof value !== 'object') return false
  const actual = Object.keys(value).sort()
  const expected = [...fields].sort()
  return (
    actual.length === expected.length && actual.every((field, index) => field === expected[index])
  )
}

function canonicalJSON(value) {
  if (Array.isArray(value)) return value.map(canonicalJSON)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalJSON(value[key])]),
  )
}

function exactJSONEqual(left, right) {
  return JSON.stringify(canonicalJSON(left)) === JSON.stringify(canonicalJSON(right))
}

function readGradingCalibrationSnapshot(pathname, adapters) {
  let snapshot
  try {
    snapshot = readAttestedFileSnapshot(pathname, {
      label: 'grading calibration artifact',
      readBytes: adapters.readGradingCalibrationBytes,
    })
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
  let artifact
  try {
    artifact = parseStrictJSON(snapshot.bytes, { label: 'grading calibration artifact' })
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
  return Object.freeze({
    artifact,
    sha256: snapshot.sha256,
  })
}

function readRecognitionCalibrationSnapshot(pathname, adapters) {
  let snapshot
  try {
    snapshot = readAttestedFileSnapshot(pathname, {
      label: 'recognition calibration artifact',
      readBytes: adapters.readRecognitionCalibrationBytes,
    })
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
  let artifact
  try {
    artifact = parseStrictJSON(snapshot.bytes, { label: 'recognition calibration artifact' })
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
  return Object.freeze({ artifact, sha256: snapshot.sha256 })
}

function validateGradingBudget(budget) {
  if (!exactObjectFields(budget, GRADING_BUDGET_FIELDS)) {
    fail('grading calibration budget fields do not match the exact schema')
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
      fail(`grading calibration budget ${field} must be a positive integer`)
    }
  }
  if (
    !Number.isSafeInteger(budget.item_concurrency) ||
    budget.item_concurrency < 1 ||
    budget.item_concurrency > 32
  ) {
    fail('grading calibration budget item_concurrency must be from 1 through 32')
  }
  if (
    !Array.isArray(budget.assessing_buckets) ||
    budget.assessing_buckets.length !== GRADING_CALIBRATION_BUCKETS.length
  ) {
    fail('grading calibration budget requires exact ordered 1/8/16/32 buckets')
  }
  for (const [index, maxProblems] of GRADING_CALIBRATION_BUCKETS.entries()) {
    const bucket = budget.assessing_buckets[index]
    if (
      !exactObjectFields(bucket, GRADING_BUDGET_BUCKET_FIELDS) ||
      bucket.max_problems !== maxProblems ||
      !Number.isSafeInteger(bucket.seconds) ||
      bucket.seconds <= 0
    ) {
      fail('grading calibration budget requires exact ordered 1/8/16/32 buckets')
    }
  }
}

export function validateGradingCalibrationApproval(
  approval,
  { provider, model, artifactSHA256, releaseConfigSHA256 } = {},
) {
  if (!exactObjectFields(approval, GRADING_CALIBRATION_APPROVAL_FIELDS)) {
    fail('grading calibration approval fields do not match the exact schema')
  }
  if (
    approval.status !== 'approved' ||
    typeof approval.approval_ref !== 'string' ||
    approval.approval_ref.trim() === '' ||
    approval.provider !== provider ||
    approval.model !== model ||
    typeof approval.artifact_sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(approval.artifact_sha256) ||
    typeof approval.release_config_sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(approval.release_config_sha256)
  ) {
    fail('grading calibration approval is blocked or invalid')
  }
  if (artifactSHA256 !== undefined && approval.artifact_sha256 !== artifactSHA256) {
    fail('grading calibration approval artifact SHA-256 mismatch')
  }
  if (releaseConfigSHA256 !== undefined && approval.release_config_sha256 !== releaseConfigSHA256) {
    fail('grading calibration approval release config SHA-256 mismatch')
  }
  return approval
}

export function validateRecognitionCalibrationApproval(
  approval,
  { provider, model, artifactSHA256, releaseConfigSHA256 } = {},
) {
  if (!exactObjectFields(approval, RECOGNITION_CALIBRATION_APPROVAL_FIELDS)) {
    fail('recognition calibration approval fields do not match the exact schema')
  }
  if (
    approval.status !== 'approved' ||
    typeof approval.approval_ref !== 'string' ||
    approval.approval_ref.trim() === '' ||
    approval.stage !== 'recognizing' ||
    approval.recognition_plan_version !== 2 ||
    approval.provider !== provider ||
    approval.model !== model ||
    typeof approval.artifact_sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(approval.artifact_sha256) ||
    typeof approval.release_config_sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(approval.release_config_sha256)
  ) {
    fail('recognition calibration approval is blocked or invalid')
  }
  if (artifactSHA256 !== undefined && approval.artifact_sha256 !== artifactSHA256) {
    fail('recognition calibration approval artifact SHA-256 mismatch')
  }
  if (releaseConfigSHA256 !== undefined && approval.release_config_sha256 !== releaseConfigSHA256) {
    fail('recognition calibration approval release config SHA-256 mismatch')
  }
  return approval
}

function validateRecognitionPolicy(policy) {
  if (!exactObjectFields(policy, RECOGNITION_POLICY_FIELDS)) {
    fail('recognition v2 release policy fields do not match the exact schema')
  }
  const buckets = policy.budget_buckets_millis
  if (!exactObjectFields(buckets, RECOGNITION_BUCKET_FIELDS)) {
    fail('recognition v2 release policy requires exact 1/8/16/32 buckets')
  }
  const values = RECOGNITION_BUCKET_FIELDS.map((field) => buckets[field])
  if (
    values.some((value) => !Number.isSafeInteger(value) || value <= 0) ||
    values.some((value, index) => index > 0 && value < values[index - 1])
  ) {
    fail('recognition v2 release policy buckets must be positive and monotonic')
  }
  if (
    policy.physical_call_cap_millis !== 120_000 ||
    policy.adapter_worker_hard_cap !== 2 ||
    policy.effective_concurrency !== 1
  ) {
    fail('recognition v2 release policy cap or concurrency drift')
  }
  return Object.freeze({
    budget_buckets_millis: Object.freeze({ ...buckets }),
    physical_call_cap_millis: policy.physical_call_cap_millis,
    adapter_worker_hard_cap: policy.adapter_worker_hard_cap,
    effective_concurrency: policy.effective_concurrency,
  })
}

function validateRecognitionCalibrationArtifact(
  artifact,
  { provider, model, recognitionPolicy, sidecarConfigSHA256, approval },
) {
  if (!exactObjectFields(artifact, RECOGNITION_CALIBRATION_FIELDS)) {
    fail('recognition calibration fields do not match the exact schema')
  }
  if (
    artifact.schema_version !== 1 ||
    artifact.approval_status !== 'approved' ||
    typeof artifact.approval_ref !== 'string' ||
    artifact.approval_ref.trim() === '' ||
    artifact.approval_ref !== approval.approval_ref ||
    artifact.stage !== 'recognizing' ||
    artifact.recognition_plan_version !== 2
  ) {
    fail('recognition calibration is not an approved recognizing v2 artifact')
  }
  if (artifact.provider !== provider || artifact.model !== model) {
    fail('recognition calibration provider/model drift')
  }
  for (const field of [
    'evidence_sha256',
    'whole_manifest_policy_sha256',
    'layout_batch_policy_sha256',
    'singleton_repair_policy_sha256',
  ]) {
    if (typeof artifact[field] !== 'string' || !/^[a-f0-9]{64}$/.test(artifact[field])) {
      fail(`recognition calibration ${field} is invalid`)
    }
  }
  if (artifact.sidecar_config_sha256 !== sidecarConfigSHA256) {
    fail('recognition calibration release config SHA-256 mismatch')
  }
  const artifactPolicy = validateRecognitionPolicy({
    budget_buckets_millis: artifact.budget_buckets_millis,
    physical_call_cap_millis: artifact.physical_call_timeout_ms,
    adapter_worker_hard_cap: artifact.adapter_worker_hard_cap,
    effective_concurrency: artifact.release_effective_concurrency,
  })
  if (!exactJSONEqual(artifactPolicy, recognitionPolicy)) {
    fail('recognition calibration policy does not match the attested Sidecar config')
  }
  if (!Array.isArray(artifact.measurements) || artifact.measurements.length !== 4) {
    fail('recognition calibration measurements require exact ordered 1/8/16/32 buckets')
  }
  const bucketMaxima = [1, 8, 16, 32]
  const bucketMillis = RECOGNITION_BUCKET_FIELDS.map(
    (field) => artifactPolicy.budget_buckets_millis[field],
  )
  const sourceFixtures = new Set()
  for (const [index, maxProblems] of bucketMaxima.entries()) {
    const measurement = artifact.measurements[index]
    if (
      !exactObjectFields(measurement, RECOGNITION_CALIBRATION_MEASUREMENT_FIELDS) ||
      measurement.max_problems !== maxProblems ||
      !Number.isSafeInteger(measurement.sample_count) ||
      measurement.sample_count < 5 ||
      measurement.success_count !== measurement.sample_count ||
      !Number.isSafeInteger(measurement.p50_ms) ||
      measurement.p50_ms <= 0 ||
      !Number.isSafeInteger(measurement.p95_ms) ||
      measurement.p95_ms < measurement.p50_ms ||
      measurement.p95_ms > bucketMillis[index] ||
      measurement.complete !== true ||
      !Number.isSafeInteger(measurement.physical_provider_calls) ||
      measurement.physical_provider_calls <= 0 ||
      typeof measurement.source_fixture_sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(measurement.source_fixture_sha256) ||
      typeof measurement.result_digest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(measurement.result_digest)
    ) {
      fail(`recognition calibration measurement for ${maxProblems} problems is invalid`)
    }
    if (sourceFixtures.has(measurement.source_fixture_sha256)) {
      fail('recognition calibration requires four independent source fixtures')
    }
    sourceFixtures.add(measurement.source_fixture_sha256)
  }
}

function validateGradingCalibrationArtifact(
  artifact,
  { provider, model, gradingBudget, sidecarConfigSHA256, approval },
) {
  if (!exactObjectFields(artifact, GRADING_CALIBRATION_FIELDS)) {
    fail('grading calibration fields do not match the exact schema')
  }
  if (artifact.schema_version !== 1) {
    fail('grading calibration schema is stale')
  }
  if (
    artifact.approval_status !== 'approved' ||
    typeof artifact.approval_ref !== 'string' ||
    artifact.approval_ref.trim() === '' ||
    artifact.approval_ref !== approval.approval_ref
  ) {
    fail('grading calibration is not explicitly approved')
  }
  if (artifact.provider !== provider || artifact.model !== model) {
    fail('grading calibration provider/model drift')
  }
  if (
    typeof artifact.evidence_sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(artifact.evidence_sha256)
  ) {
    fail('grading calibration evidence SHA-256 is invalid')
  }
  if (
    typeof artifact.sidecar_config_sha256 !== 'string' ||
    artifact.sidecar_config_sha256 !== sidecarConfigSHA256
  ) {
    fail('grading calibration release config SHA-256 mismatch')
  }

  validateGradingBudget(artifact.grading_budget)
  validateGradingBudget(gradingBudget)
  if (!exactJSONEqual(artifact.grading_budget, gradingBudget)) {
    fail('grading calibration budget does not match the attested Sidecar config')
  }

  if (
    !Array.isArray(artifact.measurements) ||
    artifact.measurements.length !== GRADING_CALIBRATION_BUCKETS.length
  ) {
    fail('grading calibration measurements require exact ordered 1/8/16/32 buckets')
  }
  for (const [index, maxProblems] of GRADING_CALIBRATION_BUCKETS.entries()) {
    const measurement = artifact.measurements[index]
    const budget = artifact.grading_budget.assessing_buckets[index]
    if (
      !exactObjectFields(measurement, GRADING_CALIBRATION_MEASUREMENT_FIELDS) ||
      measurement.max_problems !== maxProblems ||
      !Number.isSafeInteger(measurement.sample_count) ||
      measurement.sample_count < 5 ||
      measurement.success_count !== measurement.sample_count ||
      !Number.isSafeInteger(measurement.p50_ms) ||
      measurement.p50_ms <= 0 ||
      !Number.isSafeInteger(measurement.p95_ms) ||
      measurement.p95_ms < measurement.p50_ms ||
      measurement.p95_ms > budget.seconds * 1_000 ||
      !Number.isSafeInteger(measurement.logical_operations) ||
      measurement.logical_operations <= 0 ||
      !Number.isSafeInteger(measurement.physical_provider_calls) ||
      measurement.physical_provider_calls <= 0 ||
      measurement.complete !== true ||
      typeof measurement.result_digest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(measurement.result_digest)
    ) {
      fail(`grading calibration measurement for ${maxProblems} problems is invalid`)
    }
  }
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
    result.exists === false ||
    result.kind === 'missing' ||
    result.kind === 'file' ||
    result.directory === false ||
    result.regularFile === true
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
    result.exists === false ||
    result.kind === 'missing' ||
    result.kind === 'directory' ||
    result.regularFile === false ||
    result.directory === true
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

function exactLoopbackOrigin(value, name, { hostname, port } = {}) {
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    fail(`${name} must be an absolute HTTP origin`)
  }
  if (
    parsed.protocol !== 'http:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    (hostname !== undefined && parsed.hostname !== hostname) ||
    (port !== undefined && parsed.port !== String(port))
  ) {
    fail(`${name} must be the exact approved loopback origin`)
  }
  return parsed.origin
}

function gradingCalibrationBudgetProjection(gradingBudget) {
  if (!gradingBudget || Array.isArray(gradingBudget) || typeof gradingBudget !== 'object') {
    return gradingBudget
  }
  return {
    policy_version: gradingBudget.policy_version,
    queued_seconds: gradingBudget.queued_seconds,
    normalizing_seconds: gradingBudget.normalizing_seconds,
    recognizing_seconds: gradingBudget.recognizing_seconds,
    locating_seconds: gradingBudget.locating_seconds,
    rendering_seconds: gradingBudget.rendering_seconds,
    projecting_seconds: gradingBudget.projecting_seconds,
    assessing_buckets: gradingBudget.assessing_buckets,
    item_concurrency: gradingBudget.item_concurrency,
  }
}

function defaultReadControllerRuntimeContract(controllerConfigPath, adapters = {}) {
  let controllerSnapshot
  try {
    controllerSnapshot = readAttestedFileSnapshot(controllerConfigPath, {
      label: 'sidecar controller config',
      readBytes: adapters.readControllerConfigBytes,
    })
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
  let controller
  try {
    controller = parseStrictJSON(controllerSnapshot.bytes, {
      label: 'sidecar controller config',
    })
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
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
    'sidecar_config_path',
    'sidecar_config_sha256',
  ]) {
    if (typeof controller[field] !== 'string' || controller[field].trim() === '') {
      fail(`sidecar controller config ${field} is invalid`)
    }
  }
  requireAbsolute(controller.release_attestation_path, 'release_attestation_path')
  const attestationFile = inspect(adapters, controller.release_attestation_path)
  requirePrivateFile(attestationFile, 'release_attestation_path')
  const attestationPath = realPathOf(attestationFile, controller.release_attestation_path)
  if (!/^[a-f0-9]{64}$/.test(controller.release_attestation_sha256)) {
    fail('release attestation SHA-256 is invalid')
  }
  let attestationSnapshot
  try {
    attestationSnapshot = readAttestedFileSnapshot(attestationPath, {
      label: 'release attestation',
      readBytes: adapters.readReleaseAttestationBytes,
    })
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
  let receipt
  try {
    receipt = parseStrictJSON(attestationSnapshot.bytes, {
      label: 'release attestation',
    })
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
  if (attestationSnapshot.sha256 !== controller.release_attestation_sha256) {
    fail('release attestation SHA-256 mismatch')
  }
  const fields =
    receipt && !Array.isArray(receipt) && typeof receipt === 'object'
      ? Object.keys(receipt).sort()
      : []
  if (
    fields.length !== RELEASE_ATTESTATION_FIELDS.length ||
    fields.some((field, index) => field !== RELEASE_ATTESTATION_FIELDS[index]) ||
    receipt.schema_version !== 1
  ) {
    fail('release attestation fields do not match the exact schema')
  }
  if (
    receipt.release_version !== controller.expected_version ||
    receipt.sidecar_sha256 !== controller.binary_sha256 ||
    typeof receipt.installed_app_sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(receipt.installed_app_sha256)
  ) {
    fail('release attestation identity does not match controller config')
  }

  requireAbsolute(controller.sidecar_config_path, 'sidecar_config_path')
  const sidecarConfigFile = inspect(adapters, controller.sidecar_config_path)
  requirePrivateFile(sidecarConfigFile, 'sidecar_config_path')
  const sidecarConfigPath = realPathOf(sidecarConfigFile, controller.sidecar_config_path)
  if (!/^[a-f0-9]{64}$/.test(controller.sidecar_config_sha256)) {
    fail('sidecar config SHA-256 is invalid')
  }
  let sidecarConfigSnapshot
  try {
    sidecarConfigSnapshot = readAttestedFileSnapshot(sidecarConfigPath, {
      label: 'sidecar config',
      readBytes: adapters.readSidecarConfigBytes,
    })
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
  const sidecarBinding = parseSidecarBinding(String(sidecarConfigSnapshot.bytes))
  if (sidecarConfigSnapshot.sha256 !== controller.sidecar_config_sha256) {
    fail('sidecar config SHA-256 mismatch')
  }
  return {
    sidecarURL: controller.sidecar_url,
    releaseUIURL: controller.release_ui_url,
    installedAppSHA256: receipt.installed_app_sha256,
    gradingBudget: gradingCalibrationBudgetProjection(sidecarBinding.gradingBudget),
    recognitionPolicy:
      sidecarBinding.gradingBudget?.recognition_plan_version === 2
        ? frozenRecognitionV2Policy(sidecarBinding)
        : undefined,
    sidecarConfigSHA256: sidecarConfigSnapshot.sha256,
  }
}

export function validateFixtureEnvironment(env, adapters = {}) {
  const requireRecognitionV2 = adapters.requireRecognitionV2 === true
  const calibrationEnvironment = requireRecognitionV2
    ? RECOGNITION_V2_REQUIRED_ENVIRONMENT
    : GRADING_REQUIRED_ENVIRONMENT
  for (const name of [...REQUIRED_ENVIRONMENT, ...calibrationEnvironment]) {
    if (typeof env[name] !== 'string' || env[name].trim() === '') fail(`${name} is required`)
  }

  const sourceInput = env.HEXCLAW_LOCAL_SRC.trim()
  const profileInput = env.HEX_K12_LIVE_FIXTURE_PROFILE.trim()
  const storeInput = env.HEX_K12_LIVE_FIXTURE_STORE.trim()
  const manifestInput = env.HEX_K12_LIVE_FIXTURE_MANIFEST.trim()
  const controllerInput = env.HEX_K12_LIVE_SIDECAR_CONTROL.trim()
  const controllerConfigInput = env.HEX_K12_LIVE_SIDECAR_CONTROL_CONFIG.trim()
  const gradingCalibrationInput = requireRecognitionV2
    ? undefined
    : env.HEX_K12_LIVE_GRADING_CALIBRATION_ARTIFACT.trim()
  const recognitionCalibrationInput = requireRecognitionV2
    ? env.HEX_K12_LIVE_RECOGNITION_CALIBRATION_ARTIFACT.trim()
    : undefined
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
    ...(!requireRecognitionV2
      ? [[gradingCalibrationInput, 'HEX_K12_LIVE_GRADING_CALIBRATION_ARTIFACT']]
      : []),
    ...(requireRecognitionV2
      ? [[recognitionCalibrationInput, 'HEX_K12_LIVE_RECOGNITION_CALIBRATION_ARTIFACT']]
      : []),
  ]) {
    requireAbsolute(value, name)
  }

  const source = inspect(adapters, sourceInput)
  const profile = inspect(adapters, profileInput)
  const store = inspect(adapters, storeInput)
  const manifest = inspect(adapters, manifestInput, { allowMissing: true })
  const controller = inspect(adapters, controllerInput)
  const controllerConfig = inspect(adapters, controllerConfigInput)
  const gradingCalibration = requireRecognitionV2
    ? undefined
    : inspect(adapters, gradingCalibrationInput)
  const recognitionCalibration = requireRecognitionV2
    ? inspect(adapters, recognitionCalibrationInput)
    : undefined

  requireDirectory(source, 'HEXCLAW_LOCAL_SRC')
  requirePrivateDirectory(profile, 'HEX_K12_LIVE_FIXTURE_PROFILE')
  requirePrivateFile(store, 'HEX_K12_LIVE_FIXTURE_STORE')
  requireRegularFile(controller, 'HEX_K12_LIVE_SIDECAR_CONTROL')
  requirePrivateFile(controllerConfig, 'HEX_K12_LIVE_SIDECAR_CONTROL_CONFIG')
  if (!requireRecognitionV2) {
    requirePrivateFile(gradingCalibration, 'HEX_K12_LIVE_GRADING_CALIBRATION_ARTIFACT')
  }
  if (requireRecognitionV2) {
    requirePrivateFile(recognitionCalibration, 'HEX_K12_LIVE_RECOGNITION_CALIBRATION_ARTIFACT')
  }
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
  const gradingCalibrationPath = requireRecognitionV2
    ? undefined
    : realPathOf(gradingCalibration, gradingCalibrationInput)
  const recognitionCalibrationPath = requireRecognitionV2
    ? realPathOf(recognitionCalibration, recognitionCalibrationInput)
    : undefined

  if (!canonicalTmp(profilePath)) fail('fixture profile must resolve below /tmp')
  if (!canonicalTmp(controllerConfigPath)) fail('sidecar controller config must resolve below /tmp')
  if (!isInside(profilePath, storePath)) fail('fixture store must resolve inside fixture profile')
  if (!isInside(profilePath, manifestPath))
    fail('fixture manifest must resolve inside fixture profile')

  const expectedSHA = env.HEX_K12_LIVE_SIDECAR_CONTROL_SHA256.trim().toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(expectedSHA))
    fail('sidecar controller SHA-256 must be 64 lowercase hex characters')
  const actualSHA = (adapters.fileSHA256 ?? defaultFileSHA256)(controllerPath).toLowerCase()
  if (actualSHA !== expectedSHA) fail('sidecar controller SHA-256 mismatch')
  const readControllerRuntimeContract =
    adapters.readControllerRuntimeContract ?? defaultReadControllerRuntimeContract
  const controllerRuntime = readControllerRuntimeContract(controllerConfigPath, adapters)
  if (
    controllerRuntime?.releaseUIURL !== releaseUIURL ||
    controllerRuntime?.sidecarURL !== sidecarURL ||
    controllerRuntime?.installedAppSHA256 !== installedAppSHA256
  ) {
    fail('fixture environment does not match attested controller runtime')
  }
  let actualCalibrationSHA
  if (!requireRecognitionV2) {
    const expectedCalibrationSHA = env.HEX_K12_LIVE_GRADING_CALIBRATION_SHA256.trim().toLowerCase()
    if (!/^[a-f0-9]{64}$/.test(expectedCalibrationSHA)) {
      fail('grading calibration SHA-256 must be 64 lowercase hex characters')
    }
    const gradingCalibrationSnapshot = readGradingCalibrationSnapshot(
      gradingCalibrationPath,
      adapters,
    )
    actualCalibrationSHA = gradingCalibrationSnapshot.sha256
    if (actualCalibrationSHA !== expectedCalibrationSHA) {
      fail('grading calibration SHA-256 mismatch')
    }
    const gradingCalibrationApproval = validateGradingCalibrationApproval(
      adapters.gradingCalibrationApproval,
      {
        provider: 'hexclaw-gpt',
        model: 'gpt-5.6-sol',
        artifactSHA256: actualCalibrationSHA,
        releaseConfigSHA256: controllerRuntime?.sidecarConfigSHA256,
      },
    )
    validateGradingCalibrationArtifact(gradingCalibrationSnapshot.artifact, {
      provider: 'hexclaw-gpt',
      model: 'gpt-5.6-sol',
      gradingBudget: controllerRuntime?.gradingBudget,
      sidecarConfigSHA256: controllerRuntime?.sidecarConfigSHA256,
      approval: gradingCalibrationApproval,
    })
  }

  let recognitionPolicy
  let recognitionCalibrationSHA256
  if (requireRecognitionV2) {
    recognitionPolicy = validateRecognitionPolicy(controllerRuntime?.recognitionPolicy)
    const expectedRecognitionCalibrationSHA =
      env.HEX_K12_LIVE_RECOGNITION_CALIBRATION_SHA256.trim().toLowerCase()
    if (!/^[a-f0-9]{64}$/.test(expectedRecognitionCalibrationSHA)) {
      fail('recognition calibration SHA-256 must be 64 lowercase hex characters')
    }
    const recognitionCalibrationSnapshot = readRecognitionCalibrationSnapshot(
      recognitionCalibrationPath,
      adapters,
    )
    recognitionCalibrationSHA256 = recognitionCalibrationSnapshot.sha256
    if (recognitionCalibrationSHA256 !== expectedRecognitionCalibrationSHA) {
      fail('recognition calibration SHA-256 mismatch')
    }
    const recognitionCalibrationApproval = validateRecognitionCalibrationApproval(
      adapters.recognitionCalibrationApproval,
      {
        provider: 'hexclaw-gpt',
        model: 'gpt-5.6-sol',
        artifactSHA256: recognitionCalibrationSHA256,
        releaseConfigSHA256: controllerRuntime?.sidecarConfigSHA256,
      },
    )
    validateRecognitionCalibrationArtifact(recognitionCalibrationSnapshot.artifact, {
      provider: 'hexclaw-gpt',
      model: 'gpt-5.6-sol',
      recognitionPolicy,
      sidecarConfigSHA256: controllerRuntime?.sidecarConfigSHA256,
      approval: recognitionCalibrationApproval,
    })
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
    ...(requireRecognitionV2
      ? {
          recognitionCalibrationPath,
          recognitionCalibrationSHA256,
          recognitionPolicy,
        }
      : {
          gradingCalibrationPath,
          gradingCalibrationSHA256: actualCalibrationSHA,
        }),
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
    manifest = typeof raw === 'string' || Buffer.isBuffer(raw) ? JSON.parse(String(raw)) : raw
  } catch {
    fail('fixture manifest is not valid JSON')
  }
  if (!manifest || Array.isArray(manifest) || typeof manifest !== 'object') {
    fail('fixture manifest must be an object')
  }
  const fields = Object.keys(manifest).sort()
  if (
    fields.length !== MANIFEST_FIELDS.length ||
    fields.some((field, index) => field !== MANIFEST_FIELDS[index])
  ) {
    fail('fixture manifest fields do not match the contract')
  }
  if (manifest.schema_version !== 1) fail('unsupported fixture manifest schema')
  for (const field of [
    'ownership',
    'agent_name',
    'retryable_dispatch_id',
    'outcome_unknown_dispatch_id',
  ]) {
    if (typeof manifest[field] !== 'string' || manifest[field].trim() === '') {
      fail('fixture manifest contains an invalid opaque value')
    }
  }
  if (manifest.retryable_dispatch_id === manifest.outcome_unknown_dispatch_id) {
    fail('fixture dispatch IDs must be distinct')
  }
  const lease =
    typeof manifest.lease_expires_at === 'number'
      ? manifest.lease_expires_at * 1000
      : Date.parse(manifest.lease_expires_at)
  const nowMilliseconds =
    metadata.nowMilliseconds ??
    (metadata.nowSeconds === undefined ? Date.now() : metadata.nowSeconds * 1000)
  if (!Number.isFinite(lease) || lease <= nowMilliseconds)
    fail('fixture lease is expired or invalid')

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
    requestedCanonical !== targetCanonical ||
    targetCanonical !== canonicalTarget ||
    !isInside(profilePath, targetCanonical)
  ) {
    fail('fixture manifest canonical identity mismatch')
  }
  if (
    requested.regularFile === false ||
    requested.directory === true ||
    target.regularFile === false ||
    target.directory === true
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
    result = await deps.runStrictGate(
      Object.freeze({
        [FIXTURE_ENVIRONMENT[0]]: ids.retryableDispatchID,
        [FIXTURE_ENVIRONMENT[1]]: ids.outcomeUnknownDispatchID,
      }),
    )
  } catch (error) {
    rootError = error
  }

  try {
    await deps.stopSidecar(config)
  } catch (error) {
    cleanupError = error
  }
  if (!rootError && !cleanupError && deps.collectStoppedEvidence) {
    try {
      await deps.collectStoppedEvidence(config)
    } catch (error) {
      rootError = error
    }
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
  const recognitionV2ClaimPath = join(config.profilePath, 'recognition-v2-target-claim.json')
  let activeChild
  let cleanupPromise

  const run = (command, args, spawnOptions = {}) =>
    new Promise((resolvePromise, rejectPromise) => {
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

  const runJSON = (command, args, spawnOptions = {}) =>
    new Promise((resolvePromise, rejectPromise) => {
      let child
      try {
        child = spawnProcess(command, args, {
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
          ...spawnOptions,
          env: subprocessEnvironment(spawnOptions.env),
        })
      } catch {
        rejectPromise(new Error('K12 stopped-ledger evidence process could not start'))
        return
      }
      activeChild = child
      const stdout = []
      let size = 0
      let overflow = false
      child.stdout?.on('data', (chunk) => {
        size += chunk.length
        if (size > 1024 * 1024) {
          overflow = true
          child.kill('SIGTERM')
          return
        }
        stdout.push(chunk)
      })
      child.stderr?.resume()
      let startError
      child.once('error', () => {
        startError = true
      })
      child.once('close', (code) => {
        if (activeChild === child) activeChild = undefined
        if (startError || overflow || code !== 0) {
          rejectPromise(new Error('K12 stopped-ledger evidence collection failed'))
          return
        }
        try {
          resolvePromise(
            parseStrictJSON(Buffer.concat(stdout), {
              label: 'K12 recognition v2 stopped-ledger evidence',
            }),
          )
        } catch {
          rejectPromise(new Error('K12 stopped-ledger evidence collection failed'))
        }
      })
    })

  const controller = (action) =>
    run(config.controllerPath, [action, '--config', config.controllerConfigPath])

  const builderArguments = (action) => {
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
    if (
      action === 'recognition-v2-finalization-evidence' ||
      (action === 'cleanup' && lstatSync(recognitionV2ClaimPath, { throwIfNoEntry: false }))
    ) {
      common.push('--claim', recognitionV2ClaimPath)
    }
    return common
  }

  const builder = (action) => run('go', builderArguments(action), { cwd: config.localSource })

  const cleanupFixtureBase = createFixtureCleanup(config, {
    cleanupFixtureRecords: () => builder('cleanup'),
    removeManifest: () => removeCanonicalManifest(config),
    emitReceipt: (receipt) => {
      process.stderr.write(`K12 fixture manifest cleanup receipt: ${JSON.stringify(receipt)}\n`)
    },
  })
  const cleanupFixture = async () => {
    const receipt = await cleanupFixtureBase()
    const metadata = lstatSync(recognitionV2ClaimPath, { throwIfNoEntry: false })
    if (metadata) {
      if (metadata.isDirectory()) fail('recognition v2 claim is not a file')
      unlinkSync(recognitionV2ClaimPath)
    }
    return receipt
  }

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
    recognitionV2ClaimPath,
    collectRecognitionV2Evidence: () =>
      runJSON('go', builderArguments('recognition-v2-finalization-evidence'), {
        cwd: config.localSource,
      }),
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
