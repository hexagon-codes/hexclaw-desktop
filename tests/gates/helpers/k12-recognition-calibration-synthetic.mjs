import { createHash } from 'node:crypto'

import { syntheticSidecarConfigSHA256 } from './k12-grading-calibration-synthetic.mjs'

export function syntheticRecognitionPolicy(overrides = {}) {
  return {
    budget_buckets_millis: {
      up_to_1_problem_millis: 30_000,
      up_to_8_problems_millis: 60_000,
      up_to_16_problems_millis: 120_000,
      up_to_32_problems_millis: 240_000,
    },
    physical_call_cap_millis: 120_000,
    adapter_worker_hard_cap: 2,
    effective_concurrency: 1,
    ...overrides,
  }
}

export function syntheticRecognitionCalibrationArtifact(overrides = {}) {
  const policy = syntheticRecognitionPolicy()
  const bucketValues = [
    policy.budget_buckets_millis.up_to_1_problem_millis,
    policy.budget_buckets_millis.up_to_8_problems_millis,
    policy.budget_buckets_millis.up_to_16_problems_millis,
    policy.budget_buckets_millis.up_to_32_problems_millis,
  ]
  return {
    schema_version: 1,
    approval_status: 'approved',
    approval_ref: 'unit-test:synthetic-recognition-v2-calibration',
    stage: 'recognizing',
    recognition_plan_version: 2,
    provider: 'hexclaw-gpt',
    model: 'gpt-5.6-sol',
    sidecar_config_sha256: syntheticSidecarConfigSHA256,
    evidence_sha256: 'd'.repeat(64),
    whole_manifest_policy_sha256: '1'.repeat(64),
    layout_batch_policy_sha256: '2'.repeat(64),
    singleton_repair_policy_sha256: '3'.repeat(64),
    budget_buckets_millis: policy.budget_buckets_millis,
    physical_call_timeout_ms: policy.physical_call_cap_millis,
    adapter_worker_hard_cap: policy.adapter_worker_hard_cap,
    release_effective_concurrency: policy.effective_concurrency,
    measurements: [1, 8, 16, 32].map((maxProblems, index) => ({
      max_problems: maxProblems,
      source_fixture_sha256: String(index + 4).repeat(64),
      sample_count: 5,
      success_count: 5,
      p50_ms: Math.floor(bucketValues[index] / 4),
      p95_ms: Math.floor(bucketValues[index] / 2),
      complete: true,
      result_digest: ['8', '9', 'a', 'b'][index].repeat(64),
      physical_provider_calls: 5,
    })),
    ...overrides,
  }
}

export function syntheticRecognitionCalibrationBytes(overrides = {}) {
  return Buffer.from(JSON.stringify(syntheticRecognitionCalibrationArtifact(overrides)))
}

export const syntheticRecognitionArtifactSHA256 = createHash('sha256')
  .update(syntheticRecognitionCalibrationBytes())
  .digest('hex')

export function syntheticRecognitionCalibrationEnvironment(pathname) {
  return {
    HEX_K12_LIVE_RECOGNITION_CALIBRATION_ARTIFACT: pathname,
    HEX_K12_LIVE_RECOGNITION_CALIBRATION_SHA256: syntheticRecognitionArtifactSHA256,
  }
}

export function syntheticRecognitionCalibrationApproval(overrides = {}) {
  return {
    status: 'approved',
    approval_ref: 'unit-test:synthetic-recognition-v2-calibration',
    stage: 'recognizing',
    recognition_plan_version: 2,
    provider: 'hexclaw-gpt',
    model: 'gpt-5.6-sol',
    artifact_sha256: syntheticRecognitionArtifactSHA256,
    release_config_sha256: syntheticSidecarConfigSHA256,
    ...overrides,
  }
}
