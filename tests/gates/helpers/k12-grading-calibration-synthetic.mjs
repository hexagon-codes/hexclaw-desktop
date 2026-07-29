import { createHash } from 'node:crypto'

export const syntheticSidecarConfigSHA256 = 'b'.repeat(64)

export function syntheticGradingCalibrationEnvironment(pathname) {
  return {
    HEX_K12_LIVE_GRADING_CALIBRATION_ARTIFACT: pathname,
    HEX_K12_LIVE_GRADING_CALIBRATION_SHA256: syntheticArtifactSHA256,
  }
}

export function syntheticGradingBudget() {
  return {
    policy_version: 999,
    queued_seconds: 11,
    normalizing_seconds: 12,
    recognizing_seconds: 13,
    locating_seconds: 14,
    rendering_seconds: 15,
    projecting_seconds: 16,
    assessing_buckets: [
      { max_problems: 1, seconds: 17 },
      { max_problems: 8, seconds: 18 },
      { max_problems: 16, seconds: 19 },
      { max_problems: 32, seconds: 20 },
    ],
    item_concurrency: 7,
  }
}

export function syntheticGradingCalibrationArtifact(overrides = {}) {
  return {
    schema_version: 1,
    approval_status: 'approved',
    approval_ref: 'unit-test:synthetic-calibration',
    provider: 'hexclaw-gpt',
    model: 'gpt-5.6-sol',
    sidecar_config_sha256: syntheticSidecarConfigSHA256,
    grading_budget: syntheticGradingBudget(),
    measurements: [1, 8, 16, 32].map((maxProblems, index) => ({
      max_problems: maxProblems,
      sample_count: 2,
      success_count: 2,
      p50_ms: 1_000 + index,
      p95_ms: 2_000 + index,
      logical_operations: index + 1,
      physical_provider_calls: index + 1,
      complete: true,
      result_digest: String(index + 1).repeat(64),
    })),
    evidence_sha256: 'd'.repeat(64),
    ...overrides,
  }
}

export function syntheticGradingCalibrationBytes(overrides = {}) {
  return Buffer.from(JSON.stringify(syntheticGradingCalibrationArtifact(overrides)))
}

export const syntheticArtifactSHA256 = createHash('sha256')
  .update(syntheticGradingCalibrationBytes())
  .digest('hex')

export function syntheticGradingCalibrationApproval(overrides = {}) {
  return {
    status: 'approved',
    approval_ref: 'unit-test:synthetic-calibration',
    provider: 'hexclaw-gpt',
    model: 'gpt-5.6-sol',
    artifact_sha256: syntheticArtifactSHA256,
    release_config_sha256: syntheticSidecarConfigSHA256,
    ...overrides,
  }
}
