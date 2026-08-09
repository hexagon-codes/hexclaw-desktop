import assert from 'node:assert/strict'
import test from 'node:test'

import { auditRecognitionOnlyV2Evidence } from '../../scripts/ci/k12-recognition-only-v2-evidence.mjs'

const digest = (character) => character.repeat(64)

function approvedRecognitionPolicy() {
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
  }
}

function auditOptions(overrides = {}) {
  return {
    provider: 'hexclaw-gpt',
    model: 'gpt-5.6-sol',
    questionCount: 16,
    recognitionPolicy: approvedRecognitionPolicy(),
    ...overrides,
  }
}

function completeEvidence() {
  const headerDigest = digest('0')
  const planDigest = digest('a')
  const deadline = 1_800_000_000_000
  const batches = Array.from({ length: 4 }, (_, index) => ({
    ordinal: index + 1,
    physical_unit: `layout_batch_${String(index + 1).padStart(4, '0')}`,
    candidate_count: 4,
    candidate_exact_set_sha256: digest(String(index + 1)),
  }))
  const repairs = [
    {
      physical_unit: 'layout_repair_0001',
      candidate_ordinal: 1,
      candidate_ref_sha256: digest('c'),
      candidate_exact_set_sha256: digest('c'),
      repair_round: 1,
      authorization_sha256: digest('4'),
      settlement_sha256: digest('5'),
    },
  ]
  const receipts = [
    { physical_unit: 'whole_page', candidate_exact_set_sha256: '' },
    ...batches.map((batch, index) => ({
      physical_unit: batch.physical_unit,
      candidate_exact_set_sha256: digest(String(index + 1)),
    })),
    ...repairs.map((repair) => ({
      physical_unit: repair.physical_unit,
      candidate_exact_set_sha256: repair.candidate_ref_sha256,
    })),
  ].map((receipt, index) => ({
    ordinal: index + 1,
    invocation_sha256: digest(String((index + 1) % 10)),
    parent_invocation_sha256: digest('8'),
    operation: 'recognizing',
    provider: 'hexclaw-gpt',
    model: 'gpt-5.6-sol',
    status: 'succeeded',
    attempt: 1,
    result_sha256: digest('f'),
    recognition_plan_version: 2,
    plan_sha256: receipt.physical_unit === 'whole_page' ? headerDigest : planDigest,
    stage_deadline_at_unix_millis: deadline,
    ...receipt,
  }))
  return {
    schema_version: 1,
    evidence_class: 'recognition_v2_finalization',
    complete: true,
    eligible_for_pass: true,
    external_boundary_attested: false,
    manifest_sha256: digest('1'),
    claim_sha256: digest('2'),
    run_sha256: digest('3'),
    ownership_sha256: digest('4'),
    fixture_agent_sha256: digest('5'),
    target_agent_sha256: digest('6'),
    dispatch_sha256: digest('7'),
    source_session_sha256: digest('8'),
    source_digest_sha256: digest('9'),
    submission_sha256: digest('a'),
    job_sha256: digest('b'),
    parent_invocation_sha256: digest('8'),
    plan_id_sha256: digest('c'),
    recognition_plan_version: 2,
    status: 'succeeded',
    parent_status: 'succeeded',
    parent_attempt: 1,
    provider: 'hexclaw-gpt',
    model: 'gpt-5.6-sol',
    header_sha256: headerDigest,
    authorized_plan_sha256: planDigest,
    candidate_exact_set_sha256: digest('b'),
    candidate_results_exact_set_sha256: digest('d'),
    physical_results_exact_set_sha256: digest('e'),
    finalization_sha256: digest('9'),
    stage_started_at_unix_millis: deadline - 120_000,
    stage_deadline_at_unix_millis: deadline,
    budget_buckets_millis: {
      up_to_1_problem_millis: 30_000,
      up_to_8_problems_millis: 60_000,
      up_to_16_problems_millis: 120_000,
      up_to_32_problems_millis: 240_000,
    },
    selected_bucket_max_problems: 16,
    physical_call_cap_millis: 120_000,
    adapter_worker_hard_cap: 2,
    effective_concurrency: 1,
    candidate_result_count: 16,
    question_count: 16,
    non_question_count: 0,
    physical_result_count: receipts.length,
    authorized_batches: batches,
    authorized_repairs: repairs,
    physical_receipts: receipts,
  }
}

test('K12-LIVE-RECOGNITION-PLAN-V2 accepts one finalized authorized physical exact-set', () => {
  assert.deepEqual(auditRecognitionOnlyV2Evidence(completeEvidence(), auditOptions()), {
    recognition_plan_version: 2,
    header_sha256: digest('0'),
    authorized_plan_sha256: digest('a'),
    candidate_exact_set_sha256: digest('b'),
    stage_deadline_at_unix_millis: 1_800_000_000_000,
    candidate_result_count: 16,
    question_count: 16,
    non_question_count: 0,
    physical_result_count: 6,
    manifest_count: 1,
    batch_count: 4,
    repair_count: 1,
  })
})

test('K12-LIVE-RECOGNITION-PLAN-V2 fails closed without complete eligible stopped-ledger evidence', () => {
  assert.throws(
    () =>
      auditRecognitionOnlyV2Evidence(
        {
          physical_receipts: completeEvidence().physical_receipts.map((receipt) => ({
            invocation_sha256: receipt.invocation_sha256,
            parent_invocation_sha256: receipt.parent_invocation_sha256,
            physical_unit: receipt.physical_unit,
            operation: receipt.operation,
            provider: receipt.provider,
            model: receipt.model,
            status: receipt.status,
            attempt: receipt.attempt,
            result_sha256: receipt.result_sha256,
          })),
        },
        auditOptions(),
      ),
    /BLOCKED.*complete.*eligible|fields are invalid|plan.*deadline.*exact-set/i,
  )
})

test('K12-LIVE-RECOGNITION-PLAN-V2 rejects legacy units and a second repair wave', () => {
  const legacy = completeEvidence()
  legacy.physical_receipts.push({
    ...legacy.physical_receipts[0],
    invocation_sha256: digest('7'),
    physical_unit: 'segment_1',
  })
  legacy.physical_result_count += 1
  assert.throws(
    () => auditRecognitionOnlyV2Evidence(legacy, auditOptions()),
    /legacy|physical exact-set/i,
  )

  const secondWave = completeEvidence()
  secondWave.authorized_repairs[0].repair_round = 2
  assert.throws(() => auditRecognitionOnlyV2Evidence(secondWave, auditOptions()), /repair.*round/i)
})

test('K12-LIVE-RECOGNITION-PLAN-V2 counts non-question candidates and sparse repair ordinals', () => {
  const evidence = completeEvidence()
  evidence.candidate_result_count = 17
  evidence.non_question_count = 1
  evidence.selected_bucket_max_problems = 32
  evidence.stage_started_at_unix_millis = evidence.stage_deadline_at_unix_millis - 240_000
  evidence.authorized_batches.push({
    ordinal: 5,
    physical_unit: 'layout_batch_0005',
    candidate_count: 1,
    candidate_exact_set_sha256: digest('6'),
  })
  const fifthBatch = {
    ...evidence.physical_receipts[1],
    invocation_sha256: digest('6'),
    physical_unit: 'layout_batch_0005',
    candidate_exact_set_sha256: digest('6'),
  }
  evidence.physical_receipts.splice(5, 0, fifthBatch)
  evidence.authorized_repairs[0].candidate_ordinal = 9
  evidence.authorized_repairs[0].physical_unit = 'layout_repair_0009'
  evidence.physical_receipts.at(-1).physical_unit = 'layout_repair_0009'
  evidence.physical_receipts.forEach((receipt, index) => {
    receipt.ordinal = index + 1
  })
  evidence.physical_result_count = evidence.physical_receipts.length

  assert.deepEqual(auditRecognitionOnlyV2Evidence(evidence, auditOptions()), {
    recognition_plan_version: 2,
    header_sha256: digest('0'),
    authorized_plan_sha256: digest('a'),
    candidate_exact_set_sha256: digest('b'),
    stage_deadline_at_unix_millis: 1_800_000_000_000,
    candidate_result_count: 17,
    question_count: 16,
    non_question_count: 1,
    physical_result_count: 7,
    manifest_count: 1,
    batch_count: 5,
    repair_count: 1,
  })
})

test('K12-LIVE-RECOGNITION-PLAN-V2 rejects incomplete lineage and conflated plan identities', () => {
  const missingLineage = completeEvidence()
  delete missingLineage.dispatch_sha256
  assert.throws(
    () => auditRecognitionOnlyV2Evidence(missingLineage, auditOptions()),
    /fields are invalid/i,
  )

  const conflatedPlan = completeEvidence()
  conflatedPlan.authorized_plan_sha256 = conflatedPlan.header_sha256
  assert.throws(
    () => auditRecognitionOnlyV2Evidence(conflatedPlan, auditOptions()),
    /header.*authorized.*separated/i,
  )
})

test('K12-LIVE-RECOGNITION-PLAN-V2 rejects reordered or authorization-drifted physical evidence', () => {
  const reordered = completeEvidence()
  ;[reordered.physical_receipts[1], reordered.physical_receipts[2]] = [
    reordered.physical_receipts[2],
    reordered.physical_receipts[1],
  ]
  assert.throws(
    () => auditRecognitionOnlyV2Evidence(reordered, auditOptions()),
    /unauthorized|duplicate/i,
  )

  const driftedBatch = completeEvidence()
  driftedBatch.physical_receipts[1].candidate_exact_set_sha256 = digest('9')
  assert.throws(
    () => auditRecognitionOnlyV2Evidence(driftedBatch, auditOptions()),
    /does not match its authorization/i,
  )
})

test('K12-LIVE-RECOGNITION-PLAN-V2 requires the independently approved release policy', () => {
  assert.throws(
    () =>
      auditRecognitionOnlyV2Evidence(completeEvidence(), {
        provider: 'hexclaw-gpt',
        model: 'gpt-5.6-sol',
        questionCount: 16,
      }),
    /approved recognition policy/i,
  )

  const drifted = approvedRecognitionPolicy()
  drifted.budget_buckets_millis.up_to_16_problems_millis += 1
  assert.throws(
    () =>
      auditRecognitionOnlyV2Evidence(
        completeEvidence(),
        auditOptions({ recognitionPolicy: drifted }),
      ),
    /approved recognition policy/i,
  )
})
