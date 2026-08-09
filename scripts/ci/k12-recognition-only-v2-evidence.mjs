const sha256Pattern = /^[a-f0-9]{64}$/
const batchUnitPattern = /^layout_batch_(\d{4})$/
const repairUnitPattern = /^layout_repair_(\d{4})$/
const legacyUnits = new Set([
  'segment_1',
  'segment_2',
  'segment_3',
  'segment_4',
  'segment_5',
  'printed_inventory',
])
const topLevelFields = [
  'adapter_worker_hard_cap',
  'authorized_batches',
  'authorized_plan_sha256',
  'authorized_repairs',
  'budget_buckets_millis',
  'candidate_exact_set_sha256',
  'candidate_result_count',
  'candidate_results_exact_set_sha256',
  'claim_sha256',
  'complete',
  'dispatch_sha256',
  'effective_concurrency',
  'eligible_for_pass',
  'evidence_class',
  'external_boundary_attested',
  'finalization_sha256',
  'fixture_agent_sha256',
  'header_sha256',
  'job_sha256',
  'manifest_sha256',
  'model',
  'non_question_count',
  'ownership_sha256',
  'parent_attempt',
  'parent_invocation_sha256',
  'parent_status',
  'physical_call_cap_millis',
  'physical_receipts',
  'physical_result_count',
  'physical_results_exact_set_sha256',
  'plan_id_sha256',
  'provider',
  'question_count',
  'recognition_plan_version',
  'run_sha256',
  'schema_version',
  'selected_bucket_max_problems',
  'source_digest_sha256',
  'source_session_sha256',
  'stage_deadline_at_unix_millis',
  'stage_started_at_unix_millis',
  'status',
  'submission_sha256',
  'target_agent_sha256',
]
const batchFields = ['candidate_count', 'candidate_exact_set_sha256', 'ordinal', 'physical_unit']
const repairFields = [
  'authorization_sha256',
  'candidate_exact_set_sha256',
  'candidate_ordinal',
  'candidate_ref_sha256',
  'physical_unit',
  'repair_round',
  'settlement_sha256',
]
const physicalFields = [
  'attempt',
  'candidate_exact_set_sha256',
  'invocation_sha256',
  'model',
  'operation',
  'ordinal',
  'parent_invocation_sha256',
  'physical_unit',
  'plan_sha256',
  'provider',
  'recognition_plan_version',
  'result_sha256',
  'stage_deadline_at_unix_millis',
  'status',
]

function fail(message) {
  throw new Error(`K12 recognition-only v2 evidence: ${message}`)
}

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} is absent`)
  return value
}

function array(value, label) {
  if (!Array.isArray(value)) fail(`${label} is absent`)
  return value
}

function exactFields(value, fields, label) {
  const observed = Object.keys(value).sort()
  const expected = [...fields].sort()
  if (
    observed.length !== expected.length ||
    observed.some((field, index) => field !== expected[index])
  ) {
    fail(`${label} fields are invalid`)
  }
}

function digest(value, label) {
  if (typeof value !== 'string' || !sha256Pattern.test(value)) fail(`${label} is invalid`)
  return value
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(`${label} is invalid`)
  return value
}

function indexedUnit(unit, pattern, ordinal, label) {
  const matched = typeof unit === 'string' ? unit.match(pattern) : null
  if (!matched || Number(matched[1]) !== ordinal) fail(`${label} has an invalid ordinal`)
  return unit
}

/**
 * Audits the redacted, testtools-only stopped-ledger evidence required by the
 * recognition-only V2 LIVE lane. This receipt is collected after the Sidecar
 * stops and before fixture cleanup; the public ImageTask result stays unchanged.
 */
export function auditRecognitionOnlyV2Evidence(
  evidenceValue,
  { provider, model, questionCount, recognitionPolicy },
) {
  if (!evidenceValue || typeof evidenceValue !== 'object' || Array.isArray(evidenceValue)) {
    fail('BLOCKED: recognition-only v2 requires complete eligible stopped-ledger evidence')
  }
  if (typeof provider !== 'string' || !provider || typeof model !== 'string' || !model) {
    fail('expected provider/model is invalid')
  }
  positiveInteger(questionCount, 'expected question count')
  const approvedPolicy = record(recognitionPolicy, 'approved recognition policy')
  exactFields(
    approvedPolicy,
    [
      'adapter_worker_hard_cap',
      'budget_buckets_millis',
      'effective_concurrency',
      'physical_call_cap_millis',
    ],
    'approved recognition policy',
  )
  const approvedBuckets = record(
    approvedPolicy.budget_buckets_millis,
    'approved recognition policy buckets',
  )
  const budgetBucketFields = [
    'up_to_1_problem_millis',
    'up_to_8_problems_millis',
    'up_to_16_problems_millis',
    'up_to_32_problems_millis',
  ]
  exactFields(approvedBuckets, budgetBucketFields, 'approved recognition policy buckets')
  const approvedBucketValues = budgetBucketFields.map((field) =>
    positiveInteger(approvedBuckets[field], `approved recognition policy ${field}`),
  )
  if (
    approvedPolicy.physical_call_cap_millis !== 120_000 ||
    approvedPolicy.adapter_worker_hard_cap !== 2 ||
    approvedPolicy.effective_concurrency !== 1
  ) {
    fail('approved recognition policy release limits are invalid')
  }

  const evidence = record(evidenceValue, 'finalization evidence')
  exactFields(evidence, topLevelFields, 'finalization evidence')
  if (
    evidence.schema_version !== 1 ||
    evidence.evidence_class !== 'recognition_v2_finalization' ||
    evidence.complete !== true ||
    evidence.eligible_for_pass !== true ||
    evidence.external_boundary_attested !== false
  ) {
    fail('BLOCKED: stopped-ledger evidence is not complete and eligible')
  }
  if (evidence.recognition_plan_version !== 2 || evidence.status !== 'succeeded') {
    fail('finalization is not succeeded recognition plan v2')
  }
  if (evidence.parent_status !== 'succeeded' || evidence.parent_attempt !== 1) {
    fail('recognizing parent is not one succeeded attempt')
  }
  if (evidence.provider !== provider || evidence.model !== model) {
    fail('finalization route does not match the expected provider/model')
  }
  const headerDigest = digest(evidence.header_sha256, 'header digest')
  const authorizedPlanDigest = digest(evidence.authorized_plan_sha256, 'authorized plan digest')
  const exactSetDigest = digest(evidence.candidate_exact_set_sha256, 'candidate exact-set digest')
  if (headerDigest === authorizedPlanDigest) {
    fail('manifest header and authorized plan digests are not separated')
  }
  for (const field of [
    'manifest_sha256',
    'claim_sha256',
    'run_sha256',
    'ownership_sha256',
    'fixture_agent_sha256',
    'target_agent_sha256',
    'dispatch_sha256',
    'source_session_sha256',
    'source_digest_sha256',
    'submission_sha256',
    'job_sha256',
    'parent_invocation_sha256',
    'plan_id_sha256',
  ]) {
    digest(evidence[field], field.replaceAll('_', ' '))
  }
  digest(evidence.candidate_results_exact_set_sha256, 'candidate results exact-set digest')
  digest(evidence.physical_results_exact_set_sha256, 'physical results exact-set digest')
  digest(evidence.finalization_sha256, 'finalization digest')
  const stageStarted = positiveInteger(
    evidence.stage_started_at_unix_millis,
    'recognizing stage start',
  )
  const deadline = positiveInteger(
    evidence.stage_deadline_at_unix_millis,
    'shared recognizing deadline',
  )
  if (deadline <= stageStarted) fail('shared recognizing deadline does not follow stage start')
  const buckets = record(evidence.budget_buckets_millis, 'recognizing budget buckets')
  exactFields(buckets, budgetBucketFields, 'budget buckets')
  const bucketValues = [
    buckets.up_to_1_problem_millis,
    buckets.up_to_8_problems_millis,
    buckets.up_to_16_problems_millis,
    buckets.up_to_32_problems_millis,
  ]
  bucketValues.forEach((value, index) => positiveInteger(value, `recognizing bucket ${index + 1}`))
  if (bucketValues.some((value, index) => index > 0 && value < bucketValues[index - 1])) {
    fail('recognizing budget buckets are not monotonic')
  }
  if (
    ![1, 8, 16, 32].includes(evidence.selected_bucket_max_problems) ||
    evidence.selected_bucket_max_problems !==
      [1, 8, 16, 32].find((value) => value >= evidence.candidate_result_count)
  ) {
    fail('selected recognizing bucket does not match the finalized exact-set')
  }
  const selectedBucketIndex = [1, 8, 16, 32].indexOf(evidence.selected_bucket_max_problems)
  if (deadline !== stageStarted + bucketValues[selectedBucketIndex]) {
    fail('shared recognizing deadline does not match the selected bucket')
  }
  if (
    bucketValues.some((value, index) => value !== approvedBucketValues[index]) ||
    evidence.physical_call_cap_millis !== approvedPolicy.physical_call_cap_millis ||
    evidence.adapter_worker_hard_cap !== approvedPolicy.adapter_worker_hard_cap ||
    evidence.effective_concurrency !== approvedPolicy.effective_concurrency
  ) {
    fail('stopped evidence does not match the approved recognition policy')
  }
  if (
    evidence.question_count !== questionCount ||
    !Number.isSafeInteger(evidence.non_question_count) ||
    evidence.non_question_count < 0 ||
    evidence.candidate_result_count !== evidence.question_count + evidence.non_question_count
  ) {
    fail('finalized candidate result count does not match the recognized exact-set')
  }

  const authorizedBatches = array(evidence.authorized_batches, 'authorized batches')
  const expectedBatchCount = Math.ceil(evidence.candidate_result_count / 4)
  if (authorizedBatches.length !== expectedBatchCount) {
    fail('authorized batch exact-set does not use bounded groups of four')
  }
  let authorizedCandidateCount = 0
  const batchUnits = authorizedBatches.map((value, index) => {
    const batch = record(value, `authorized batch ${index + 1}`)
    exactFields(batch, batchFields, `authorized batch ${index + 1}`)
    if (batch.ordinal !== index + 1) fail('authorized batch ordinal is invalid')
    const unit = indexedUnit(
      batch.physical_unit,
      batchUnitPattern,
      index + 1,
      'authorized batch unit',
    )
    const count = positiveInteger(batch.candidate_count, 'authorized batch candidate count')
    if (count > 4) fail('authorized batch exceeds four candidates')
    digest(batch.candidate_exact_set_sha256, 'authorized batch candidate exact-set digest')
    authorizedCandidateCount += count
    return unit
  })
  if (authorizedCandidateCount !== evidence.candidate_result_count) {
    fail('authorized batch candidate count does not match the finalized exact-set')
  }

  const authorizedRepairs = array(evidence.authorized_repairs, 'authorized repairs')
  if (authorizedRepairs.length > evidence.candidate_result_count)
    fail('authorized repair wave exceeds candidate count')
  const repairedCandidates = new Set()
  let previousRepairOrdinal = 0
  const repairUnits = authorizedRepairs.map((value, index) => {
    const repair = record(value, `authorized repair ${index + 1}`)
    exactFields(repair, repairFields, `authorized repair ${index + 1}`)
    if (repair.repair_round !== 1) fail('repair round must be the single authorized wave')
    const candidateOrdinal = positiveInteger(repair.candidate_ordinal, 'repair candidate ordinal')
    if (candidateOrdinal > evidence.candidate_result_count) {
      fail('repair candidate ordinal exceeds the candidate exact-set')
    }
    if (candidateOrdinal <= previousRepairOrdinal) {
      fail('repair candidates are not in strict plan order')
    }
    previousRepairOrdinal = candidateOrdinal
    const candidate = digest(repair.candidate_ref_sha256, 'repair candidate reference digest')
    digest(repair.authorization_sha256, 'repair authorization digest')
    digest(repair.settlement_sha256, 'repair settlement digest')
    digest(repair.candidate_exact_set_sha256, 'repair candidate exact-set digest')
    if (repairedCandidates.has(candidate)) fail('repair candidate is duplicated')
    repairedCandidates.add(candidate)
    return indexedUnit(
      repair.physical_unit,
      repairUnitPattern,
      candidateOrdinal,
      'authorized repair unit',
    )
  })

  const receipts = array(evidence.physical_receipts, 'physical receipts')
  const expectedUnits = ['whole_page', ...batchUnits, ...repairUnits]
  if (
    evidence.physical_result_count !== expectedUnits.length ||
    receipts.length !== expectedUnits.length ||
    receipts.length > 1 + expectedBatchCount + evidence.candidate_result_count
  ) {
    fail('physical exact-set count is invalid')
  }
  const observedUnits = new Set()
  const parentInvocationDigest = evidence.parent_invocation_sha256
  const batchByUnit = new Map(authorizedBatches.map((batch) => [batch.physical_unit, batch]))
  const repairByUnit = new Map(authorizedRepairs.map((repair) => [repair.physical_unit, repair]))
  for (const [index, value] of receipts.entries()) {
    const receipt = record(value, 'physical receipt')
    exactFields(receipt, physicalFields, `physical receipt ${index + 1}`)
    const unit = receipt.physical_unit
    if (legacyUnits.has(unit)) fail(`legacy physical unit ${unit} is forbidden in v2`)
    if (unit !== expectedUnits[index] || observedUnits.has(unit) || receipt.ordinal !== index + 1) {
      fail('physical exact-set contains an unauthorized or duplicate unit')
    }
    observedUnits.add(unit)
    if (
      receipt.operation !== 'recognizing' ||
      receipt.provider !== provider ||
      receipt.model !== model ||
      receipt.status !== 'succeeded' ||
      receipt.attempt !== 1 ||
      receipt.recognition_plan_version !== 2 ||
      receipt.stage_deadline_at_unix_millis !== deadline
    ) {
      fail('physical receipt route, attempt, plan, status, or shared deadline is invalid')
    }
    digest(receipt.result_sha256, 'physical result digest')
    const physicalPlanDigest = digest(receipt.plan_sha256, 'physical plan digest')
    digest(receipt.invocation_sha256, 'physical invocation reference digest')
    const parentDigest = digest(
      receipt.parent_invocation_sha256,
      'physical parent invocation reference digest',
    )
    if (parentDigest !== parentInvocationDigest) {
      fail('physical receipts do not share one recognizing parent')
    }
    if (unit === 'whole_page') {
      if (physicalPlanDigest !== headerDigest) {
        fail('whole-page manifest is not bound to the header digest')
      }
      if (receipt.candidate_exact_set_sha256 !== '') {
        fail('whole-page manifest must precede the candidate exact-set')
      }
    } else {
      if (physicalPlanDigest !== authorizedPlanDigest) {
        fail('batch or repair is not bound to the authorized plan digest')
      }
      const physicalCandidateDigest = digest(
        receipt.candidate_exact_set_sha256,
        'physical candidate exact-set digest',
      )
      const authorizedCandidateDigest =
        batchByUnit.get(unit)?.candidate_exact_set_sha256 ??
        repairByUnit.get(unit)?.candidate_exact_set_sha256
      if (physicalCandidateDigest !== authorizedCandidateDigest) {
        fail('physical candidate exact-set does not match its authorization')
      }
    }
  }
  if (expectedUnits.some((unit) => !observedUnits.has(unit))) {
    fail('physical exact-set is incomplete')
  }

  return {
    recognition_plan_version: 2,
    header_sha256: headerDigest,
    authorized_plan_sha256: authorizedPlanDigest,
    candidate_exact_set_sha256: exactSetDigest,
    stage_deadline_at_unix_millis: deadline,
    candidate_result_count: evidence.candidate_result_count,
    question_count: questionCount,
    non_question_count: evidence.non_question_count,
    physical_result_count: receipts.length,
    manifest_count: 1,
    batch_count: batchUnits.length,
    repair_count: repairUnits.length,
  }
}
