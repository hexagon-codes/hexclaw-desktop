type WireRecord = Record<string, unknown>

const IMAGE_TASK_INTENTS = new Set([
  'completed_homework',
  'blank_worksheet',
  'writing',
  'artwork',
  'unknown',
])
const IMAGE_TASK_STATUSES = new Set([
  'routing',
  'awaiting_confirmation',
  'routed',
  'failed',
  'cancelled',
])
const HOMEWORK_STAGES = new Set([
  'queued',
  'normalizing',
  'recognizing',
  'locating',
  'awaiting_confirmation',
  'assessing',
  'rendering',
  'projecting',
  'completed',
  'cancelled',
  'recovering',
  'failed_retryable',
  'failed_terminal',
])
const CREATIVE_STATUSES = new Set([
  'preparing',
  'awaiting_confirmation',
  'ready',
  'promoted',
  'failed',
  'cancelled',
])
const CREATIVE_FEEDBACK_STATES = new Set([
  'feedback_pending',
  'feedback_ready',
  'feedback_failed',
  'recovering',
])
const PROBLEM_KINDS = new Set(['standalone', 'compound_parent', 'subproblem'])
const ANSWER_STATES = new Set(['blank', 'present', 'unclear'])
const CONFIRMATION_REASONS = new Set([
  'fraction',
  'decimal_point',
  'negative_sign',
  'unit',
  'erasure',
  'evidence_conflict',
  'low_confidence',
  'unclear_handwriting',
  'subject_undetermined',
  'canonical_parse_failed',
])
const PHOTO_STATUSES = new Set([
  'correct',
  'correct_with_process_issue',
  'wrong',
  'unanswered',
  'answer_unclear',
  'blank_solved',
  'out_of_scope',
  'untrusted',
  'failed',
])
const PHOTO_RESULT_KINDS = new Set([
  'assessment',
  'parent_teaching_guide',
  'unanswered',
  'needs_review',
  'out_of_scope',
  'failed',
])
const GRADE_VERDICTS = new Set(['agree', 'disagree', 'unverifiable', 'out_of_scope', 'verbatim'])
const GRADE_BADGES = new Set([
  'verified-strong',
  'verified-weak',
  'disagree',
  'out-of-scope',
  'unverifiable',
  'verbatim-recall',
])
const GRADE_ASSESSMENT_STATUSES = new Set([
  'correct',
  'correct_with_process_issue',
  'wrong',
  'unanswered',
  'answer_unclear',
  'blank_solved',
  'out_of_scope',
  'untrusted',
])
const EVIDENCE_TYPES = new Set([
  'numeric_exec',
  'symbolic_exec',
  'heterogeneous_model',
  'heuristic',
  'verbatim',
  'none',
])
const GROUNDING_EVIDENCE_RECEIPT_FIELDS = [
  'textbook_binding_id',
  'textbook_manifest_id',
  'document_id',
  'document_generation',
  'vector_revision_id',
  'query_digest',
  'chunk_id',
  'logical_page',
  'pdf_page',
  'source_digest',
  'citation_digest',
] as const
const PROBLEM_GROUNDING_RECEIPT_FIELDS = [
  'problem_id',
  'operation',
  'identity_digest',
  ...GROUNDING_EVIDENCE_RECEIPT_FIELDS,
] as const
const GROUNDING_OPERATIONS = new Set(['solve', 'grade'])

function fail(path: string, expected: string): never {
  throw new Error(`${path}: expected ${expected}`)
}

function record(value: unknown, path: string): WireRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'object')
  return value as WireRecord
}

function exact(value: WireRecord, keys: readonly string[], path: string): void {
  const allowed = new Set(keys)
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${path}.${key}`, 'public field')
  }
}

function required(value: WireRecord, keys: readonly string[], path: string): void {
  for (const key of keys) {
    if (!(key in value) || value[key] === undefined) fail(`${path}.${key}`, 'required property')
  }
}

function stringValue(value: unknown, path: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) fail(path, 'string')
  return value
}

function numberValue(value: unknown, path: string, integer = false): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    (integer && !Number.isInteger(value))
  ) {
    fail(path, integer ? 'integer' : 'finite number')
  }
  return value
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path, 'boolean')
  return value
}

function enumValue(value: unknown, values: Set<string>, path: string): string {
  const candidate = stringValue(value, path)
  if (!values.has(candidate)) fail(path, 'approved enum value')
  return candidate
}

function arrayValue(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, 'array')
  return value
}

function stringArray(
  value: unknown,
  path: string,
  options: { nonEmptyItems?: boolean; minItems?: number } = {},
): string[] {
  const result = arrayValue(value, path).map((item, index) =>
    stringValue(item, `${path}[${index}]`, !options.nonEmptyItems),
  )
  if (options.minItems !== undefined && result.length < options.minItems) {
    fail(path, `at least ${options.minItems} items`)
  }
  return result
}

function optionalString(value: unknown, path: string): void {
  if (value !== undefined) stringValue(value, path, true)
}

type ValidatedGroundingEvidenceReceipt = {
  raw: WireRecord
  evidenceKey: string
}

type ValidatedProblemGroundingReceipt = ValidatedGroundingEvidenceReceipt & {
  problemID: string
  operation: string
  identityDigest: string
}

function digestValue(value: unknown, path: string, prefixed = false): string {
  const digest = stringValue(value, path)
  const pattern = prefixed ? /^sha256:[0-9a-f]{64}$/ : /^[0-9a-f]{64}$/
  if (!pattern.test(digest)) fail(path, prefixed ? 'sha256 digest' : 'lowercase SHA-256 digest')
  return digest
}

function validateGroundingEvidenceReceiptFields(
  receipt: WireRecord,
  path: string,
): ValidatedGroundingEvidenceReceipt {
  for (const key of [
    'textbook_binding_id',
    'textbook_manifest_id',
    'document_id',
    'vector_revision_id',
    'chunk_id',
  ] as const) {
    const identity = stringValue(receipt[key], `${path}.${key}`)
    if (identity.trim() !== identity) fail(`${path}.${key}`, 'trimmed durable identity')
  }
  for (const key of ['document_generation', 'logical_page', 'pdf_page'] as const) {
    const value = numberValue(receipt[key], `${path}.${key}`, true)
    if (value < 1) fail(`${path}.${key}`, 'positive integer')
  }
  digestValue(receipt.query_digest, `${path}.query_digest`, true)
  digestValue(receipt.source_digest, `${path}.source_digest`)
  digestValue(receipt.citation_digest, `${path}.citation_digest`)
  return {
    raw: receipt,
    evidenceKey: JSON.stringify(
      GROUNDING_EVIDENCE_RECEIPT_FIELDS.map((field) => receipt[field]),
    ),
  }
}

function validateGroundingEvidenceReceipts(value: unknown, path: string): WireRecord[] {
  const seen = new Set<string>()
  return arrayValue(value, path).map((item, index) => {
    const itemPath = `${path}[${index}]`
    const receipt = record(item, itemPath)
    exact(receipt, GROUNDING_EVIDENCE_RECEIPT_FIELDS, itemPath)
    required(receipt, GROUNDING_EVIDENCE_RECEIPT_FIELDS, itemPath)
    const validated = validateGroundingEvidenceReceiptFields(receipt, itemPath)
    if (seen.has(validated.evidenceKey)) fail(itemPath, 'unique evidence receipt')
    seen.add(validated.evidenceKey)
    return validated.raw
  })
}

function validateProblemGroundingReceipts(
  value: unknown,
  path: string,
): ValidatedProblemGroundingReceipt[] {
  const seen = new Set<string>()
  return arrayValue(value, path).map((item, index) => {
    const itemPath = `${path}[${index}]`
    const receipt = record(item, itemPath)
    exact(receipt, PROBLEM_GROUNDING_RECEIPT_FIELDS, itemPath)
    required(receipt, PROBLEM_GROUNDING_RECEIPT_FIELDS, itemPath)
    const problemID = stringValue(receipt.problem_id, `${itemPath}.problem_id`)
    if (problemID.trim() !== problemID) fail(`${itemPath}.problem_id`, 'trimmed public problem id')
    const operation = enumValue(receipt.operation, GROUNDING_OPERATIONS, `${itemPath}.operation`)
    const identityDigest = digestValue(receipt.identity_digest, `${itemPath}.identity_digest`, true)
    const evidence = validateGroundingEvidenceReceiptFields(receipt, itemPath)
    const key = JSON.stringify([problemID, operation, identityDigest, evidence.evidenceKey])
    if (seen.has(key)) fail(itemPath, 'unique problem grounding receipt')
    seen.add(key)
    return { ...evidence, problemID, operation, identityDigest }
  })
}

function expectedGroundingOperations(status: string): readonly string[] {
  if (['correct', 'correct_with_process_issue', 'wrong', 'untrusted'].includes(status)) {
    return ['solve', 'grade']
  }
  if (['blank_solved', 'out_of_scope'].includes(status)) return ['solve']
  return []
}

function validateProblemGroundingExactSet(
  receipts: ValidatedProblemGroundingReceipt[],
  statusByProblem: Map<string, string>,
  path: string,
  hasGrounding: boolean,
): void {
  const grouped = new Map<string, ValidatedProblemGroundingReceipt[]>()
  for (const receipt of receipts) {
    if (!statusByProblem.has(receipt.problemID)) {
      fail(path, 'receipts bound to current public problems')
    }
    const current = grouped.get(receipt.problemID) ?? []
    current.push(receipt)
    grouped.set(receipt.problemID, current)
  }
  if (!hasGrounding) return
  for (const [problemID, status] of statusByProblem) {
    const problemReceipts = grouped.get(problemID) ?? []
    const expected = [...expectedGroundingOperations(status)].sort()
    const operations = [...new Set(problemReceipts.map((receipt) => receipt.operation))].sort()
    if (JSON.stringify(operations) !== JSON.stringify(expected)) {
      fail(path, `operation exact-set for problem ${problemID}`)
    }
    if (
      expected.length > 0 &&
      new Set(problemReceipts.map((receipt) => receipt.identityDigest)).size !== 1
    ) {
      fail(path, `one grounding identity for problem ${problemID}`)
    }
    if (expected.length === 2) {
      const solve = problemReceipts
        .filter((receipt) => receipt.operation === 'solve')
        .map((receipt) => receipt.evidenceKey)
        .sort()
      const grade = problemReceipts
        .filter((receipt) => receipt.operation === 'grade')
        .map((receipt) => receipt.evidenceKey)
        .sort()
      if (JSON.stringify(solve) !== JSON.stringify(grade)) {
        fail(path, `shared receipt exact-set for problem ${problemID}`)
      }
    }
  }
}

function validateQuestion(value: unknown, path: string): WireRecord {
  const question = record(value, path)
  exact(
    question,
    [
      'problem_id',
      'problem_kind',
      'parent_problem_id',
      'subproblem_no',
      'source_number_path',
      'display_label',
      'source_section_path',
      'source_section_label',
      'system_section_ordinal',
      'system_display_label',
      'page_asset_id',
      'source_width',
      'source_height',
      'source_region',
      'attempt_id',
      'question',
      'raw_transcription',
      'canonical_markdown',
      'canonical_valid',
      'canonical_version',
      'knowledge_points',
      'answer_state',
      'student_answer',
      'answer_raw_transcription',
      'answer_canonical_markdown',
      'answer_canonical_valid',
      'subject',
      'bbox',
      'recognition_confidence',
      'confirmation_required',
      'confirmation_reasons',
      'confirmed_version',
      'input_digest',
    ],
    path,
  )
  required(question, ['question', 'knowledge_points', 'answer_state'], path)
  stringValue(question.question, `${path}.question`, true)
  stringArray(question.knowledge_points, `${path}.knowledge_points`)
  enumValue(question.answer_state, ANSWER_STATES, `${path}.answer_state`)
  if (question.problem_kind !== undefined) {
    enumValue(question.problem_kind, PROBLEM_KINDS, `${path}.problem_kind`)
  }
  for (const key of [
    'problem_id',
    'parent_problem_id',
    'subproblem_no',
    'display_label',
    'source_section_label',
    'system_display_label',
    'page_asset_id',
    'attempt_id',
    'raw_transcription',
    'canonical_markdown',
    'student_answer',
    'answer_raw_transcription',
    'answer_canonical_markdown',
    'subject',
    'input_digest',
  ]) {
    optionalString(question[key], `${path}.${key}`)
  }
  for (const key of ['source_number_path', 'source_section_path']) {
    if (question[key] !== undefined) stringArray(question[key], `${path}.${key}`)
  }
  for (const key of ['canonical_version', 'system_section_ordinal', 'confirmed_version']) {
    if (question[key] !== undefined) numberValue(question[key], `${path}.${key}`, true)
  }
  for (const key of ['canonical_valid', 'answer_canonical_valid', 'confirmation_required']) {
    if (question[key] !== undefined) booleanValue(question[key], `${path}.${key}`)
  }
  if (question.recognition_confidence !== undefined) {
    const confidence = numberValue(
      question.recognition_confidence,
      `${path}.recognition_confidence`,
    )
    if (confidence < 0 || confidence > 1) fail(`${path}.recognition_confidence`, '0..1')
  }
  if (question.confirmation_reasons !== undefined) {
    arrayValue(question.confirmation_reasons, `${path}.confirmation_reasons`).forEach(
      (reason, index) =>
        enumValue(reason, CONFIRMATION_REASONS, `${path}.confirmation_reasons[${index}]`),
    )
  }
  if (question.bbox !== undefined && question.bbox !== null) {
    const bbox = record(question.bbox, `${path}.bbox`)
    exact(bbox, ['x', 'y', 'w', 'h'], `${path}.bbox`)
    required(bbox, ['x', 'y', 'w', 'h'], `${path}.bbox`)
    for (const key of ['x', 'y', 'w', 'h']) {
      const coordinate = numberValue(bbox[key], `${path}.bbox.${key}`)
      if (coordinate < 0 || coordinate > 1) fail(`${path}.bbox.${key}`, '0..1')
    }
  }
  const hasSourceWidth = question.source_width !== undefined
  const hasSourceHeight = question.source_height !== undefined
  if (hasSourceWidth !== hasSourceHeight) {
    fail(path, 'source_width and source_height together')
  }
  let sourceWidth = 0
  let sourceHeight = 0
  if (hasSourceWidth && hasSourceHeight) {
    if (!question.page_asset_id) fail(`${path}.page_asset_id`, 'source PageAsset identity')
    sourceWidth = numberValue(question.source_width, `${path}.source_width`, true)
    sourceHeight = numberValue(question.source_height, `${path}.source_height`, true)
    if (sourceWidth < 1) fail(`${path}.source_width`, 'positive integer')
    if (sourceHeight < 1) fail(`${path}.source_height`, 'positive integer')
  }
  if (question.source_region !== undefined && question.source_region !== null) {
    if (!hasSourceWidth || !hasSourceHeight) {
      fail(`${path}.source_region`, 'PageAsset dimensions')
    }
    const region = record(question.source_region, `${path}.source_region`)
    exact(region, ['x', 'y', 'width', 'height'], `${path}.source_region`)
    required(region, ['x', 'y', 'width', 'height'], `${path}.source_region`)
    const x = numberValue(region.x, `${path}.source_region.x`, true)
    const y = numberValue(region.y, `${path}.source_region.y`, true)
    const width = numberValue(region.width, `${path}.source_region.width`, true)
    const height = numberValue(region.height, `${path}.source_region.height`, true)
    if (
      x < 0 ||
      y < 0 ||
      width < 1 ||
      height < 1 ||
      x + width > sourceWidth ||
      y + height > sourceHeight
    ) {
      fail(`${path}.source_region`, 'positive source-pixel rectangle inside PageAsset')
    }
  }
  return question
}

function normalizeFinalArtifact(value: unknown, progressive: WireRecord, path: string): WireRecord {
  const artifact = record(value, path)
  exact(
    artifact,
    [
      'artifact_id',
      'agent_name',
      'job_id',
      'structure_version',
      'coverage_status',
      'total_count',
      'published_count',
      'skipped_count',
      'ordered_current_digests_json',
      'canonical_markdown',
      'artifact_digest',
      'summary_invocation_id',
      'title',
      'created_at',
      'updated_at',
    ],
    path,
  )
  required(
    artifact,
    [
      'artifact_id',
      'artifact_digest',
      'canonical_markdown',
      'coverage_status',
      'total_count',
      'published_count',
      'skipped_count',
      'created_at',
      'updated_at',
    ],
    path,
  )
  for (const key of ['artifact_id', 'artifact_digest', 'canonical_markdown', 'coverage_status']) {
    stringValue(artifact[key], `${path}.${key}`)
  }
  optionalString(artifact.title, `${path}.title`)
  for (const key of [
    'total_count',
    'published_count',
    'skipped_count',
    'created_at',
    'updated_at',
  ]) {
    numberValue(artifact[key], `${path}.${key}`, true)
  }
  const snapshot = record(progressive.coverage, '$.dispatch.target_projection.progressive.coverage')
  if (
    artifact.structure_version !== undefined &&
    artifact.structure_version !== progressive.structure_version
  ) {
    fail(`${path}.structure_version`, 'current progressive structure version')
  }
  if (
    artifact.total_count !== snapshot.total ||
    artifact.published_count !== snapshot.published ||
    artifact.skipped_count !== snapshot.skipped
  ) {
    fail(path, 'counts consistent with progressive coverage')
  }
  if (
    (artifact.coverage_status === 'complete' && snapshot.skipped !== 0) ||
    (artifact.coverage_status === 'with_skips' && snapshot.skipped === 0)
  ) {
    fail(`${path}.coverage_status`, 'coverage consistent with progressive snapshot')
  }
  return {
    artifact_id: artifact.artifact_id,
    artifact_digest: artifact.artifact_digest,
    ...(artifact.title !== undefined ? { title: artifact.title } : {}),
    canonical_markdown: artifact.canonical_markdown,
    coverage_status: artifact.coverage_status,
    total_count: artifact.total_count,
    published_count: artifact.published_count,
    skipped_count: artifact.skipped_count,
    created_at: artifact.created_at,
    updated_at: artifact.updated_at,
  }
}

const PROBLEM_SOURCE_STATUSES = new Set([
  'awaiting_source',
  'processing',
  'skipped',
  'correct',
  'correct_with_process_issue',
  'wrong',
  'unanswered',
  'answer_unclear',
  'blank_solved',
  'out_of_scope',
  'untrusted',
])
const PROBLEM_SOURCE_TERMINAL_STATUSES = new Set([
  'correct',
  'correct_with_process_issue',
  'wrong',
  'unanswered',
  'answer_unclear',
  'blank_solved',
  'out_of_scope',
  'untrusted',
])
const PROBLEM_SOURCE_FACT_FIELDS = [
  'page_asset_id',
  'source_width',
  'source_height',
  'source_region',
] as const

function normalizeProblemSourceFacts(problem: WireRecord, path: string): WireRecord {
  const present = PROBLEM_SOURCE_FACT_FIELDS.filter((field) => field in problem)
  if (present.length === 0) return {}
  if (present.length !== PROBLEM_SOURCE_FACT_FIELDS.length) {
    fail(path, 'historical all-absent or complete source exact-set')
  }

  const pageAssetID = stringValue(problem.page_asset_id, `${path}.page_asset_id`)
  const sourceWidth = numberValue(problem.source_width, `${path}.source_width`, true)
  const sourceHeight = numberValue(problem.source_height, `${path}.source_height`, true)
  if (sourceWidth < 1) fail(`${path}.source_width`, 'positive integer')
  if (sourceHeight < 1) fail(`${path}.source_height`, 'positive integer')

  if (problem.source_region === null) {
    return {
      page_asset_id: pageAssetID,
      source_width: sourceWidth,
      source_height: sourceHeight,
      source_region: null,
    }
  }

  const region = record(problem.source_region, `${path}.source_region`)
  exact(region, ['x', 'y', 'width', 'height'], `${path}.source_region`)
  required(region, ['x', 'y', 'width', 'height'], `${path}.source_region`)
  const x = numberValue(region.x, `${path}.source_region.x`, true)
  const y = numberValue(region.y, `${path}.source_region.y`, true)
  const width = numberValue(region.width, `${path}.source_region.width`, true)
  const height = numberValue(region.height, `${path}.source_region.height`, true)
  if (
    x < 0 ||
    y < 0 ||
    width < 1 ||
    height < 1 ||
    x + width > sourceWidth ||
    y + height > sourceHeight
  ) {
    fail(`${path}.source_region`, 'positive source-pixel rectangle inside PageAsset')
  }
  return {
    page_asset_id: pageAssetID,
    source_width: sourceWidth,
    source_height: sourceHeight,
    source_region: { x, y, width, height },
  }
}

function normalizeProblemSourceProgress(
  value: unknown,
  path: string,
  displaySource: WireRecord,
  fallbackAnchorState: string,
): WireRecord {
  const problem = record(value, path)
  exact(
    problem,
    [
      'problem_id',
      'status',
      'input_revision',
      'published_revision',
      'current_disposition',
      ...PROBLEM_SOURCE_FACT_FIELDS,
    ],
    path,
  )
  required(
    problem,
    ['problem_id', 'status', 'input_revision', 'published_revision', 'current_disposition'],
    path,
  )
  const problemID = stringValue(problem.problem_id, `${path}.problem_id`)
  const status = enumValue(problem.status, PROBLEM_SOURCE_STATUSES, `${path}.status`)
  if (problem.current_disposition !== 'current') {
    fail(`${path}.current_disposition`, 'current durable head')
  }
  const inputRevision = numberValue(problem.input_revision, `${path}.input_revision`, true)
  const publishedRevision = numberValue(
    problem.published_revision,
    `${path}.published_revision`,
    true,
  )
  if (inputRevision < 1) fail(`${path}.input_revision`, 'positive integer')
  if (publishedRevision < 0) fail(`${path}.published_revision`, 'non-negative integer')
  const sourceFacts = normalizeProblemSourceFacts(problem, path)

  const terminal = PROBLEM_SOURCE_TERMINAL_STATUSES.has(status)
  const skipped = status === 'skipped'
  const awaitingResolution = status === 'awaiting_source'
  const previousResultProjection = displaySource.result_projection
  const resultProjection =
    previousResultProjection &&
    typeof previousResultProjection === 'object' &&
    !Array.isArray(previousResultProjection)
      ? (previousResultProjection as WireRecord)
      : {}
  return {
    problem_id: problemID,
    ...(typeof displaySource.parent_problem_id === 'string'
      ? { parent_problem_id: displaySource.parent_problem_id }
      : {}),
    ...(typeof displaySource.dependency_group_id === 'string'
      ? { dependency_group_id: displaySource.dependency_group_id }
      : {}),
    source_number_path: displaySource.source_number_path ?? [],
    display_label: displaySource.display_label ?? '',
    source_section_path: displaySource.source_section_path ?? [],
    source_section_label: displaySource.source_section_label ?? '',
    system_section_ordinal: displaySource.system_section_ordinal ?? 0,
    system_display_label: displaySource.system_display_label ?? '',
    source_state: awaitingResolution ? 'awaiting_resolution' : 'ready',
    anchor_state: displaySource.anchor_state ?? fallbackAnchorState,
    operation_state: terminal ? 'published' : status,
    disposition_state: terminal ? 'result' : skipped ? 'skipped_by_parent' : 'pending',
    result_projection: terminal ? { ...resultProjection, assessment_status: status } : null,
    published_revision: publishedRevision,
    input_revision: inputRevision,
    command_available: awaitingResolution || skipped,
    ...sourceFacts,
  }
}

function normalizeProblemSourceCoverage(
  value: unknown,
  path: string,
  problemCount: number,
): { raw: WireRecord; view: WireRecord } {
  const coverage = record(value, path)
  exact(
    coverage,
    ['total', 'published', 'skipped', 'awaiting', 'failed', 'status', 'projection_revision'],
    path,
  )
  required(
    coverage,
    ['total', 'published', 'skipped', 'awaiting', 'failed', 'status', 'projection_revision'],
    path,
  )
  for (const key of [
    'total',
    'published',
    'skipped',
    'awaiting',
    'failed',
    'projection_revision',
  ]) {
    const count = numberValue(coverage[key], `${path}.${key}`, true)
    if (count < 0) fail(`${path}.${key}`, 'non-negative integer')
  }
  if (!['empty', 'incomplete', 'in_progress', 'complete'].includes(String(coverage.status))) {
    fail(`${path}.status`, 'approved coverage status')
  }
  if (
    coverage.total !== problemCount ||
    Number(coverage.published) +
      Number(coverage.skipped) +
      Number(coverage.awaiting) +
      Number(coverage.failed) !==
      Number(coverage.total)
  ) {
    fail(path, 'exact problem coverage counters')
  }
  if (
    coverage.status === 'complete' &&
    (coverage.total === 0 || coverage.awaiting !== 0 || coverage.failed !== 0)
  ) {
    fail(path, 'complete coverage counters')
  }
  if (coverage.status === 'empty' && coverage.total !== 0) {
    fail(path, 'empty coverage counters')
  }
  return {
    raw: coverage,
    view: {
      state:
        coverage.status === 'complete'
          ? Number(coverage.skipped) > 0
            ? 'with_skips'
            : 'full'
          : 'incomplete',
      total: coverage.total,
      processed: coverage.published,
      skipped: coverage.skipped,
    },
  }
}

function normalizeHomeworkProjection(value: unknown, path: string): WireRecord {
  const projection = record(value, path)
  exact(
    projection,
    [
      'kind',
      'stage',
      'confirmation_state',
      'anchor_state',
      'recognition',
      'progressive',
      'final_artifact',
      'grounding_evidence_receipts',
      'problem_grounding_receipts',
    ],
    path,
  )
  required(
    projection,
    [
      'kind',
      'stage',
      'confirmation_state',
      'anchor_state',
      'progressive',
      'grounding_evidence_receipts',
      'problem_grounding_receipts',
    ],
    path,
  )
  if (projection.kind !== 'homework') fail(`${path}.kind`, 'homework')
  enumValue(projection.stage, HOMEWORK_STAGES, `${path}.stage`)
  if (!['pending', 'confirmed'].includes(String(projection.confirmation_state))) {
    fail(`${path}.confirmation_state`, 'pending|confirmed')
  }
  if (!['pending', 'located', 'degraded'].includes(String(projection.anchor_state))) {
    fail(`${path}.anchor_state`, 'pending|located|degraded')
  }

  const progressive = record(projection.progressive, `${path}.progressive`)
  exact(
    progressive,
    ['structure_version', 'snapshot_revision', 'problem_progress', 'coverage'],
    `${path}.progressive`,
  )
  required(
    progressive,
    ['structure_version', 'snapshot_revision', 'problem_progress', 'coverage'],
    `${path}.progressive`,
  )
  numberValue(progressive.structure_version, `${path}.progressive.structure_version`, true)
  numberValue(progressive.snapshot_revision, `${path}.progressive.snapshot_revision`, true)

  const recognition =
    projection.recognition === undefined
      ? undefined
      : record(projection.recognition, `${path}.recognition`)
  const questions = recognition
    ? (() => {
        exact(recognition, ['subject', 'questions'], `${path}.recognition`)
        required(recognition, ['questions'], `${path}.recognition`)
        optionalString(recognition.subject, `${path}.recognition.subject`)
        return arrayValue(recognition.questions, `${path}.recognition.questions`).map(
          (question, index) =>
            validateQuestion(question, `${path}.recognition.questions[${index}]`),
        )
      })()
    : []
  const questionByID = new Map(
    questions
      .filter((question) => typeof question.problem_id === 'string')
      .map((question) => [question.problem_id as string, question]),
  )

  const seenProblemIDs = new Set<string>()
  const problems = arrayValue(
    progressive.problem_progress,
    `${path}.progressive.problem_progress`,
  ).map((value, index) => {
    const problemPath = `${path}.progressive.problem_progress[${index}]`
    const rawProblem = record(value, problemPath)
    const problemID = stringValue(rawProblem.problem_id, `${problemPath}.problem_id`)
    if (seenProblemIDs.has(problemID)) fail(`${problemPath}.problem_id`, 'unique problem id')
    seenProblemIDs.add(problemID)
    const question = questionByID.get(problemID) ?? {}
    return normalizeProblemSourceProgress(
      value,
      problemPath,
      question,
      String(projection.anchor_state),
    )
  })

  const groundingEvidenceReceipts = validateGroundingEvidenceReceipts(
    projection.grounding_evidence_receipts,
    `${path}.grounding_evidence_receipts`,
  )
  const problemGroundingReceipts = validateProblemGroundingReceipts(
    projection.problem_grounding_receipts,
    `${path}.problem_grounding_receipts`,
  )
  validateProblemGroundingExactSet(
    problemGroundingReceipts,
    new Map(
      arrayValue(progressive.problem_progress, `${path}.progressive.problem_progress`).map(
        (value, index) => {
          const problem = record(value, `${path}.progressive.problem_progress[${index}]`)
          return [String(problem.problem_id), String(problem.status)]
        },
      ),
    ),
    `${path}.problem_grounding_receipts`,
    groundingEvidenceReceipts.length > 0 || problemGroundingReceipts.length > 0,
  )

  const coverage = normalizeProblemSourceCoverage(
    progressive.coverage,
    `${path}.progressive.coverage`,
    problems.length,
  )

  const normalized: WireRecord = {
    kind: 'homework',
    stage: projection.stage,
    confirmation_state: projection.confirmation_state,
    anchor_state: projection.anchor_state,
    ...(recognition
      ? {
          recognition: {
            ...(recognition.subject !== undefined ? { subject: recognition.subject } : {}),
            questions,
          },
        }
      : {}),
    structure_version: progressive.structure_version,
    problems,
    coverage: coverage.view,
    projection_revision: coverage.raw.projection_revision,
    grounding_evidence_receipts: groundingEvidenceReceipts,
    problem_grounding_receipts: problemGroundingReceipts.map((receipt) => receipt.raw),
  }
  if (projection.final_artifact !== undefined && projection.final_artifact !== null) {
    normalized.final_artifact = normalizeFinalArtifact(
      projection.final_artifact,
      progressive,
      `${path}.final_artifact`,
    )
  }
  return normalized
}

function validateCreativeProjection(value: unknown, path: string): WireRecord {
  const projection = record(value, path)
  exact(
    projection,
    [
      'kind',
      'intake_id',
      'work_type',
      'status',
      'entry_kind',
      'promotion_policy',
      'routing_provenance',
      'commit_required',
      'commit_state',
      'promoted_work_id',
      'promoted_generation_id',
      'canonical_version',
      'canonical_content',
      'conflicts',
      'work',
    ],
    path,
  )
  required(projection, ['kind', 'intake_id', 'work_type', 'status'], path)
  if (projection.kind !== 'creative') fail(`${path}.kind`, 'creative')
  stringValue(projection.intake_id, `${path}.intake_id`)
  if (!['writing', 'art'].includes(String(projection.work_type))) {
    fail(`${path}.work_type`, 'writing|art')
  }
  enumValue(projection.status, CREATIVE_STATUSES, `${path}.status`)
  if (
    projection.entry_kind !== undefined &&
    !['auto', 'new_work'].includes(String(projection.entry_kind))
  ) {
    fail(`${path}.entry_kind`, 'auto|new_work')
  }
  if (
    projection.promotion_policy !== undefined &&
    !['automatic', 'explicit_commit'].includes(String(projection.promotion_policy))
  ) {
    fail(`${path}.promotion_policy`, 'automatic|explicit_commit')
  }
  if (
    projection.routing_provenance !== undefined &&
    !['model_classified', 'parent_selected'].includes(String(projection.routing_provenance))
  ) {
    fail(`${path}.routing_provenance`, 'model_classified|parent_selected')
  }
  if (projection.commit_required !== undefined) {
    booleanValue(projection.commit_required, `${path}.commit_required`)
  }
  if (
    projection.commit_state !== undefined &&
    !['pending', 'committed'].includes(String(projection.commit_state))
  ) {
    fail(`${path}.commit_state`, 'pending|committed')
  }
  for (const key of ['promoted_work_id', 'promoted_generation_id', 'canonical_content']) {
    optionalString(projection[key], `${path}.${key}`)
  }
  if (projection.status === 'promoted') {
    required(projection, ['promoted_work_id', 'promoted_generation_id'], path)
    stringValue(projection.promoted_work_id, `${path}.promoted_work_id`)
    stringValue(projection.promoted_generation_id, `${path}.promoted_generation_id`)
  } else if (
    projection.promoted_work_id !== undefined ||
    projection.promoted_generation_id !== undefined
  ) {
    fail(path, 'promotion identities only after promotion')
  }
  if (projection.canonical_version !== undefined) {
    numberValue(projection.canonical_version, `${path}.canonical_version`, true)
  }
  if (projection.conflicts !== undefined) {
    arrayValue(projection.conflicts, `${path}.conflicts`).forEach((value, index) => {
      const conflictPath = `${path}.conflicts[${index}]`
      const conflict = record(value, conflictPath)
      exact(conflict, ['segment_id', 'raw_text', 'canonical_text', 'reason'], conflictPath)
      required(conflict, ['segment_id'], conflictPath)
      stringValue(conflict.segment_id, `${conflictPath}.segment_id`)
      for (const key of ['raw_text', 'canonical_text', 'reason']) {
        optionalString(conflict[key], `${conflictPath}.${key}`)
      }
    })
  }
  if (projection.work !== undefined) {
    const work = record(projection.work, `${path}.work`)
    exact(work, ['work_id', 'display_name'], `${path}.work`)
    required(work, ['work_id', 'display_name'], `${path}.work`)
    stringValue(work.work_id, `${path}.work.work_id`)
    stringValue(work.display_name, `${path}.work.display_name`, true)
  }
  return projection
}

function validateProgress(value: unknown, path: string): void {
  const progress = record(value, path)
  exact(progress, ['operation', 'state'], path)
  required(progress, ['operation', 'state'], path)
  const operation = stringValue(progress.operation, `${path}.operation`)
  const state = stringValue(progress.state, `${path}.state`)
  if (operation === 'classification') {
    enumValue(state, IMAGE_TASK_STATUSES, `${path}.state`)
  } else if (operation === 'homework') {
    enumValue(state, HOMEWORK_STAGES, `${path}.state`)
  } else if (operation === 'writing_ocr') {
    enumValue(state, CREATIVE_STATUSES, `${path}.state`)
  } else if (operation === 'promotion') {
    if (!CREATIVE_STATUSES.has(state) && !CREATIVE_FEEDBACK_STATES.has(state)) {
      fail(`${path}.state`, 'creative promotion state')
    }
  } else {
    fail(`${path}.operation`, 'approved operation')
  }
}

function normalizeDispatch(value: unknown, path: string): WireRecord {
  const dispatch = record(value, path)
  exact(
    dispatch,
    [
      'dispatch_id',
      'task_intent',
      'status',
      'provider_display_name',
      'model_id',
      'retryable',
      'intent_evidence',
      'intent_confidence',
      'confirmation_candidates',
      'target',
      'target_projection',
      'progress',
      'version',
      'created_at',
      'updated_at',
      'automatic_budget_seconds',
      'automatic_started_at',
      'automatic_deadline_at',
      'automatic_remaining_seconds',
      'operation_deadline_at',
    ],
    path,
  )
  required(
    dispatch,
    [
      'dispatch_id',
      'task_intent',
      'status',
      'intent_evidence',
      'intent_confidence',
      'confirmation_candidates',
      'progress',
      'version',
      'created_at',
      'updated_at',
    ],
    path,
  )
  stringValue(dispatch.dispatch_id, `${path}.dispatch_id`)
  const intent = enumValue(dispatch.task_intent, IMAGE_TASK_INTENTS, `${path}.task_intent`)
  enumValue(dispatch.status, IMAGE_TASK_STATUSES, `${path}.status`)
  stringArray(dispatch.intent_evidence, `${path}.intent_evidence`)
  const confidence = numberValue(dispatch.intent_confidence, `${path}.intent_confidence`)
  if (confidence < 0 || confidence > 1) fail(`${path}.intent_confidence`, '0..1')
  arrayValue(dispatch.confirmation_candidates, `${path}.confirmation_candidates`).forEach(
    (candidate, index) =>
      enumValue(candidate, IMAGE_TASK_INTENTS, `${path}.confirmation_candidates[${index}]`),
  )
  validateProgress(dispatch.progress, `${path}.progress`)
  for (const key of ['version', 'created_at', 'updated_at']) {
    numberValue(dispatch[key], `${path}.${key}`, true)
  }
  for (const key of [
    'automatic_budget_seconds',
    'automatic_started_at',
    'automatic_deadline_at',
    'automatic_remaining_seconds',
    'operation_deadline_at',
  ]) {
    if (dispatch[key] !== undefined) numberValue(dispatch[key], `${path}.${key}`, true)
  }
  if (dispatch.retryable !== undefined) booleanValue(dispatch.retryable, `${path}.retryable`)
  for (const key of ['provider_display_name', 'model_id']) {
    if (dispatch[key] !== undefined && dispatch[key] !== null) {
      stringValue(dispatch[key], `${path}.${key}`, true)
    }
  }
  if (dispatch.target !== undefined) {
    const target = record(dispatch.target, `${path}.target`)
    exact(target, ['type', 'id'], `${path}.target`)
    required(target, ['type', 'id'], `${path}.target`)
    if (!['homework_submission', 'creative_work_intake'].includes(String(target.type))) {
      fail(`${path}.target.type`, 'public target discriminator')
    }
    stringValue(target.id, `${path}.target.id`)
  }
  if (dispatch.target_projection !== undefined) {
    const projection = record(dispatch.target_projection, `${path}.target_projection`)
    if (projection.kind === 'homework') {
      if (!['completed_homework', 'blank_worksheet'].includes(intent)) {
        fail(`${path}.target_projection.kind`, 'projection matching task intent')
      }
      dispatch.target_projection = normalizeHomeworkProjection(
        projection,
        `${path}.target_projection`,
      )
    } else if (projection.kind === 'creative') {
      if (!['writing', 'artwork'].includes(intent)) {
        fail(`${path}.target_projection.kind`, 'projection matching task intent')
      }
      dispatch.target_projection = validateCreativeProjection(
        projection,
        `${path}.target_projection`,
      )
    } else {
      fail(`${path}.target_projection.kind`, 'homework|creative')
    }
  }
  return dispatch
}

function validateGrade(value: unknown, path: string): WireRecord {
  const grade = record(value, path)
  exact(
    grade,
    [
      'solution',
      'verdict',
      'evidence_type',
      'badge',
      'assessment_status',
      'final_answer_correct',
      'wrong_step',
      'error_cause',
      'out_of_scope',
      'out_of_scope_kp',
      'record_created',
      'record_id',
      'curriculum_unmapped',
      'solve_only',
    ],
    path,
  )
  required(
    grade,
    ['solution', 'verdict', 'evidence_type', 'badge', 'out_of_scope', 'record_created'],
    path,
  )
  stringValue(grade.solution, `${path}.solution`, true)
  enumValue(grade.verdict, GRADE_VERDICTS, `${path}.verdict`)
  enumValue(grade.evidence_type, EVIDENCE_TYPES, `${path}.evidence_type`)
  enumValue(grade.badge, GRADE_BADGES, `${path}.badge`)
  if (grade.assessment_status !== undefined) {
    enumValue(grade.assessment_status, GRADE_ASSESSMENT_STATUSES, `${path}.assessment_status`)
  }
  if (grade.final_answer_correct !== undefined) {
    booleanValue(grade.final_answer_correct, `${path}.final_answer_correct`)
  }
  booleanValue(grade.out_of_scope, `${path}.out_of_scope`)
  booleanValue(grade.record_created, `${path}.record_created`)
  if (grade.solve_only !== undefined) booleanValue(grade.solve_only, `${path}.solve_only`)
  for (const key of ['wrong_step', 'error_cause', 'out_of_scope_kp', 'record_id']) {
    optionalString(grade[key], `${path}.${key}`)
  }
  if (grade.curriculum_unmapped !== undefined) {
    stringArray(grade.curriculum_unmapped, `${path}.curriculum_unmapped`)
  }
  return grade
}

function validateParentGuide(value: unknown, path: string): WireRecord {
  const guide = record(value, path)
  const keys = [
    'answer',
    'full_solution_steps',
    'grade_level_method',
    'likely_mistakes',
    'parent_teaching_sequence',
    'follow_up_questions',
    'checking_method',
  ] as const
  exact(guide, keys, path)
  required(guide, keys, path)
  for (const key of ['answer', 'grade_level_method', 'checking_method']) {
    stringValue(guide[key], `${path}.${key}`)
  }
  for (const key of [
    'full_solution_steps',
    'likely_mistakes',
    'parent_teaching_sequence',
    'follow_up_questions',
  ]) {
    stringArray(guide[key], `${path}.${key}`, {
      nonEmptyItems: true,
      minItems: 1,
    })
  }
  return guide
}

function validatePhotoPayload(
  value: unknown,
  kind: 'completed_homework' | 'blank_worksheet',
  path: string,
): Map<string, string> {
  const payload = record(value, path)
  exact(
    payload,
    [
      'mode',
      'task_intent',
      'result_surface',
      'items',
      'markdown',
      'image_warning',
      'annotated_image',
    ],
    path,
  )
  required(
    payload,
    ['mode', 'task_intent', 'result_surface', 'items', 'markdown', 'image_warning'],
    path,
  )
  const expectedMode = kind === 'completed_homework' ? 'grade' : 'solve'
  const expectedSurface =
    kind === 'completed_homework' ? 'annotated_homework' : 'parent_teaching_guide'
  if (
    payload.mode !== expectedMode ||
    payload.task_intent !== kind ||
    payload.result_surface !== expectedSurface
  ) {
    fail(path, 'result discriminators matching task intent')
  }
  stringValue(payload.markdown, `${path}.markdown`, true)
  stringValue(payload.image_warning, `${path}.image_warning`, true)
  const statusByProblem = new Map<string, string>()
  arrayValue(payload.items, `${path}.items`).forEach((value, index) => {
    const itemPath = `${path}.items[${index}]`
    const item = record(value, itemPath)
    exact(item, ['question', 'status', 'warning', 'grade', 'result_kind', 'parent_guide'], itemPath)
    required(item, ['question', 'status', 'result_kind'], itemPath)
    const question = validateQuestion(item.question, `${itemPath}.question`)
    const status = enumValue(item.status, PHOTO_STATUSES, `${itemPath}.status`)
    if (typeof question.problem_id === 'string') {
      if (statusByProblem.has(question.problem_id)) {
        fail(`${itemPath}.question.problem_id`, 'unique public problem id')
      }
      statusByProblem.set(question.problem_id, status)
    }
    const resultKind = enumValue(item.result_kind, PHOTO_RESULT_KINDS, `${itemPath}.result_kind`)
    optionalString(item.warning, `${itemPath}.warning`)
    const grade =
      item.grade === undefined ? undefined : validateGrade(item.grade, `${itemPath}.grade`)
    if (item.parent_guide !== undefined) {
      validateParentGuide(item.parent_guide, `${itemPath}.parent_guide`)
    }
    if (status === 'wrong' && (item.grade === undefined || item.parent_guide === undefined)) {
      fail(itemPath, 'wrong assessment with grade and complete parent guide')
    }
    if (status === 'correct_with_process_issue') {
      if (grade === undefined || item.parent_guide === undefined || resultKind !== 'assessment') {
        fail(itemPath, 'process-issue assessment with grade and complete parent guide')
      }
      if (grade.assessment_status !== status) {
        fail(`${itemPath}.grade.assessment_status`, 'equal to item.status')
      }
      if (grade.final_answer_correct !== true) {
        fail(`${itemPath}.grade.final_answer_correct`, 'true independent final-answer fact')
      }
      stringValue(grade.wrong_step, `${itemPath}.grade.wrong_step`)
      stringValue(grade.error_cause, `${itemPath}.grade.error_cause`)
      if (grade.record_created !== false || grade.record_id !== undefined) {
        fail(`${itemPath}.grade`, 'process issue without mistake/review side effect')
      }
    }
    if (status === 'correct' && item.parent_guide !== undefined) {
      fail(`${itemPath}.parent_guide`, 'omitted for correct assessment')
    }
    if (
      kind === 'blank_worksheet' &&
      (status !== 'blank_solved' ||
        resultKind !== 'parent_teaching_guide' ||
        item.parent_guide === undefined)
    ) {
      fail(itemPath, 'complete blank-worksheet teaching guide')
    }
  })
  if (payload.annotated_image !== undefined) {
    const image = record(payload.annotated_image, `${path}.annotated_image`)
    exact(image, ['mime', 'data_base64', 'digest'], `${path}.annotated_image`)
    required(image, ['mime', 'data_base64'], `${path}.annotated_image`)
    stringValue(image.mime, `${path}.annotated_image.mime`)
    stringValue(image.data_base64, `${path}.annotated_image.data_base64`)
    optionalString(image.digest, `${path}.annotated_image.digest`)
  } else if (kind === 'completed_homework') {
    fail(`${path}.annotated_image`, 'completed-homework artifact')
  }
  return statusByProblem
}

function validateStructuredFeedback(value: unknown, path: string): WireRecord {
  const feedback = record(value, path)
  exact(
    feedback,
    [
      'feedback_id',
      'version_id',
      'feedback_type',
      'evidence_refs',
      'observations',
      'source_snapshot',
      'limitations',
      'suggestions',
      'projection_markdown',
    ],
    path,
  )
  required(
    feedback,
    [
      'feedback_id',
      'version_id',
      'feedback_type',
      'evidence_refs',
      'observations',
      'source_snapshot',
      'limitations',
      'suggestions',
      'projection_markdown',
    ],
    path,
  )
  for (const key of ['feedback_id', 'version_id', 'limitations', 'projection_markdown']) {
    stringValue(feedback[key], `${path}.${key}`)
  }
  if (!['writing', 'art'].includes(String(feedback.feedback_type))) {
    fail(`${path}.feedback_type`, 'writing|art')
  }
  stringArray(feedback.evidence_refs, `${path}.evidence_refs`)
  stringArray(feedback.suggestions, `${path}.suggestions`)
  arrayValue(feedback.observations, `${path}.observations`).forEach((value, index) => {
    const observationPath = `${path}.observations[${index}]`
    const observation = record(value, observationPath)
    exact(observation, ['dimension', 'evidence'], observationPath)
    required(observation, ['dimension', 'evidence'], observationPath)
    stringValue(observation.dimension, `${observationPath}.dimension`)
    stringValue(observation.evidence, `${observationPath}.evidence`)
  })
  const source = record(feedback.source_snapshot, `${path}.source_snapshot`)
  exact(source, ['source', 'method_ref', 'capability'], `${path}.source_snapshot`)
  required(source, ['source', 'method_ref', 'capability'], `${path}.source_snapshot`)
  if (!['ai', 'parent'].includes(String(source.source))) {
    fail(`${path}.source_snapshot.source`, 'ai|parent')
  }
  stringValue(source.method_ref, `${path}.source_snapshot.method_ref`)
  stringValue(source.capability, `${path}.source_snapshot.capability`)
  return feedback
}

function validateCreativePayload(value: unknown, path: string): void {
  const payload = record(value, path)
  exact(payload, ['intake', 'work', 'feedback'], path)
  required(payload, ['intake'], path)
  const intake = record(payload.intake, `${path}.intake`)
  exact(intake, ['intake_id', 'status'], `${path}.intake`)
  required(intake, ['intake_id', 'status'], `${path}.intake`)
  stringValue(intake.intake_id, `${path}.intake.intake_id`)
  enumValue(intake.status, CREATIVE_STATUSES, `${path}.intake.status`)
  if (payload.work !== undefined) {
    const work = record(payload.work, `${path}.work`)
    exact(work, ['work_id', 'display_name'], `${path}.work`)
    required(work, ['work_id', 'display_name'], `${path}.work`)
    stringValue(work.work_id, `${path}.work.work_id`)
    stringValue(work.display_name, `${path}.work.display_name`, true)
  }
  if (payload.feedback !== undefined) {
    const feedback = record(payload.feedback, `${path}.feedback`)
    exact(
      feedback,
      ['generation_id', 'structured_feedback', 'projection_markdown'],
      `${path}.feedback`,
    )
    required(
      feedback,
      ['generation_id', 'structured_feedback', 'projection_markdown'],
      `${path}.feedback`,
    )
    stringValue(feedback.generation_id, `${path}.feedback.generation_id`)
    const structured = validateStructuredFeedback(
      feedback.structured_feedback,
      `${path}.feedback.structured_feedback`,
    )
    const projection = stringValue(
      feedback.projection_markdown,
      `${path}.feedback.projection_markdown`,
    )
    if (projection !== structured.projection_markdown) {
      fail(`${path}.feedback.projection_markdown`, 'canonical feedback projection')
    }
  }
}

function validateAuditEnvelope(response: WireRecord): void {
  const keys = ['source_digest', 'source_attachments', 'operation_receipts'] as const
  const present = keys.filter((key) => Object.prototype.hasOwnProperty.call(response, key))
  if (present.length !== 0 && present.length !== keys.length) {
    fail('$', 'complete audit envelope or no audit envelope')
  }
  if (present.length === 0) return
  stringValue(response.source_digest, '$.source_digest')
  const attachments = arrayValue(response.source_attachments, '$.source_attachments')
  if (attachments.length === 0) fail('$.source_attachments', 'at least one receipt')
  attachments.forEach((value, index) => {
    const path = `$.source_attachments[${index}]`
    const attachment = record(value, path)
    exact(attachment, ['digest', 'size_bytes'], path)
    required(attachment, ['digest', 'size_bytes'], path)
    stringValue(attachment.digest, `${path}.digest`)
    const size = numberValue(attachment.size_bytes, `${path}.size_bytes`, true)
    if (size < 0) fail(`${path}.size_bytes`, 'non-negative integer')
  })
  arrayValue(response.operation_receipts, '$.operation_receipts').forEach((value, index) => {
    const path = `$.operation_receipts[${index}]`
    const receipt = record(value, path)
    exact(
      receipt,
      [
        'invocation_id',
        'parent_invocation_id',
        'physical_unit',
        'operation',
        'provider',
        'model',
        'status',
        'attempt',
        'result_digest',
        'request_policy_digest',
        'request_policy',
      ],
      path,
    )
    required(
      receipt,
      ['invocation_id', 'operation', 'provider', 'model', 'status', 'attempt', 'result_digest'],
      path,
    )
    for (const key of [
      'invocation_id',
      'operation',
      'provider',
      'model',
      'status',
      'result_digest',
    ]) {
      stringValue(receipt[key], `${path}.${key}`, key === 'result_digest')
    }
    optionalString(receipt.parent_invocation_id, `${path}.parent_invocation_id`)
    optionalString(receipt.physical_unit, `${path}.physical_unit`)
    numberValue(receipt.attempt, `${path}.attempt`, true)
    const hasPolicyDigest = receipt.request_policy_digest !== undefined
    const hasPolicy = receipt.request_policy !== undefined
    if (hasPolicyDigest !== hasPolicy) fail(path, 'atomic request policy receipt')
    if (hasPolicy) {
      stringValue(receipt.request_policy_digest, `${path}.request_policy_digest`)
      const policy = record(receipt.request_policy, `${path}.request_policy`)
      exact(
        policy,
        ['policy_version', 'stage', 'thinking', 'reasoning_effort'],
        `${path}.request_policy`,
      )
      required(
        policy,
        ['policy_version', 'stage', 'thinking', 'reasoning_effort'],
        `${path}.request_policy`,
      )
      for (const key of ['policy_version', 'stage', 'thinking', 'reasoning_effort']) {
        stringValue(policy[key], `${path}.request_policy.${key}`)
      }
    }
  })
}

export function assertCurrentImageTaskCreativeEntrySemantics(value: unknown): void {
  if (value === undefined) return
  const entry = record(value, '$.creative_entry')
  exact(entry, ['kind', 'task_intent'], '$.creative_entry')
  required(entry, ['kind', 'task_intent'], '$.creative_entry')
  if (entry.kind !== 'new_work') fail('$.creative_entry.kind', 'new_work')
  if (!['writing', 'artwork'].includes(String(entry.task_intent))) {
    fail('$.creative_entry.task_intent', 'writing|artwork')
  }
}

export function normalizeImageTaskDispatchEnvelope<T>(value: T): T {
  const envelope = record(value, '$')
  required(envelope, ['dispatch'], '$')
  envelope.dispatch = normalizeDispatch(envelope.dispatch, '$.dispatch')
  return value
}

export function assertImageTaskResultSemantics(value: unknown): void {
  const response = record(value, '$')
  exact(
    response,
    [
      'dispatch_id',
      'task_intent',
      'status',
      'result',
      'source_digest',
      'source_attachments',
      'operation_receipts',
      'grounding_evidence_receipts',
      'problem_grounding_receipts',
    ],
    '$',
  )
  required(response, ['dispatch_id', 'task_intent', 'status', 'result'], '$')
  stringValue(response.dispatch_id, '$.dispatch_id')
  const intent = enumValue(response.task_intent, IMAGE_TASK_INTENTS, '$.task_intent')
  enumValue(response.status, IMAGE_TASK_STATUSES, '$.status')
  validateAuditEnvelope(response)
  const hasAuditEnvelope = Object.prototype.hasOwnProperty.call(response, 'source_digest')
  const groundingFields = [
    'grounding_evidence_receipts',
    'problem_grounding_receipts',
  ] as const
  const presentGroundingFields = groundingFields.filter((field) =>
    Object.prototype.hasOwnProperty.call(response, field),
  )
  const isHomework = intent === 'completed_homework' || intent === 'blank_worksheet'
  if (isHomework && hasAuditEnvelope && presentGroundingFields.length !== groundingFields.length) {
    fail('$', 'complete homework grounding receipt envelope')
  }
  if ((!isHomework || !hasAuditEnvelope) && presentGroundingFields.length !== 0) {
    fail('$', 'grounding receipts only on current homework results')
  }
  const groundingEvidenceReceipts =
    presentGroundingFields.length === groundingFields.length
      ? validateGroundingEvidenceReceipts(
          response.grounding_evidence_receipts,
          '$.grounding_evidence_receipts',
        )
      : []
  const problemGroundingReceipts =
    presentGroundingFields.length === groundingFields.length
      ? validateProblemGroundingReceipts(
          response.problem_grounding_receipts,
          '$.problem_grounding_receipts',
        )
      : []
  if (response.result === null) return
  const result = record(response.result, '$.result')
  exact(result, ['kind', 'payload'], '$.result')
  required(result, ['kind', 'payload'], '$.result')
  const kind = stringValue(result.kind, '$.result.kind')
  if (
    kind !== intent ||
    !['completed_homework', 'blank_worksheet', 'writing', 'artwork'].includes(kind)
  ) {
    fail('$.result.kind', 'result discriminator matching task intent')
  }
  if (kind === 'completed_homework' || kind === 'blank_worksheet') {
    const statusByProblem = validatePhotoPayload(result.payload, kind, '$.result.payload')
    validateProblemGroundingExactSet(
      problemGroundingReceipts,
      statusByProblem,
      '$.problem_grounding_receipts',
      groundingEvidenceReceipts.length > 0 || problemGroundingReceipts.length > 0,
    )
  } else {
    validateCreativePayload(result.payload, '$.result.payload')
  }
}

export interface ImageTaskProblemSourceActionExpectation {
  dispatchId: string
  problemId: string
  action: string
  structureVersion: number
  expectedInputRevision: number
}

/**
 * Binds a source-action response to the exact path and command that produced it.
 * Schema validation proves the payload shape; this check prevents a valid payload
 * from another dispatch, problem, or action from being accepted as this response.
 */
export function assertImageTaskProblemSourceActionSemantics(
  value: unknown,
  expected: ImageTaskProblemSourceActionExpectation,
): void {
  const response = record(value, '$')
  const bindings = [
    ['dispatch_id', expected.dispatchId],
    ['problem_id', expected.problemId],
    ['action', expected.action],
  ] as const
  for (const [field, expectedValue] of bindings) {
    const actual = stringValue(response[field], `$.${field}`)
    if (actual !== expectedValue) fail(`$.${field}`, `exact request binding ${expectedValue}`)
  }
  const responseStructureVersion = numberValue(
    response.structure_version,
    '$.structure_version',
    true,
  )
  if (responseStructureVersion !== expected.structureVersion) {
    fail('$.structure_version', `exact request binding ${expected.structureVersion}`)
  }
  const responseInputRevision = numberValue(response.input_revision, '$.input_revision', true)
  const wantInputRevision =
    expected.action === 'skip' ? expected.expectedInputRevision : expected.expectedInputRevision + 1
  if (responseInputRevision !== wantInputRevision) {
    fail('$.input_revision', `action revision ${wantInputRevision}`)
  }
  const snapshot = record(response.progressive_snapshot, '$.progressive_snapshot')
  if (snapshot.structure_version !== responseStructureVersion) {
    fail('$.progressive_snapshot.structure_version', 'response structure version')
  }
  const snapshotRevision = numberValue(
    snapshot.snapshot_revision,
    '$.progressive_snapshot.snapshot_revision',
    true,
  )
  if (snapshotRevision < responseInputRevision) {
    fail('$.progressive_snapshot.snapshot_revision', 'revision at or after input revision')
  }
  const rawProblems = arrayValue(
    snapshot.problem_progress,
    '$.progressive_snapshot.problem_progress',
  )
  const seen = new Set<string>()
  let published = 0
  let skipped = 0
  let awaiting = 0
  rawProblems.forEach((value, index) => {
    const problemPath = `$.progressive_snapshot.problem_progress[${index}]`
    const problem = record(value, problemPath)
    normalizeProblemSourceFacts(problem, problemPath)
    const problemID = stringValue(problem.problem_id, `${problemPath}.problem_id`)
    if (seen.has(problemID)) {
      fail(`$.progressive_snapshot.problem_progress[${index}].problem_id`, 'unique problem id')
    }
    seen.add(problemID)
    const status = stringValue(
      problem.status,
      `$.progressive_snapshot.problem_progress[${index}].status`,
    )
    if (status === 'skipped') skipped += 1
    else if (status === 'awaiting_source' || status === 'processing') awaiting += 1
    else if (PROBLEM_SOURCE_TERMINAL_STATUSES.has(status)) published += 1
  })
  if (!seen.has(expected.problemId)) {
    fail('$.progressive_snapshot.problem_progress', 'command problem in current exact-set')
  }
  const coverage = normalizeProblemSourceCoverage(
    snapshot.coverage,
    '$.progressive_snapshot.coverage',
    rawProblems.length,
  ).raw
  if (coverage.projection_revision !== snapshotRevision) {
    fail('$.progressive_snapshot.coverage.projection_revision', 'snapshot revision')
  }
  if (
    coverage.published !== published ||
    coverage.skipped !== skipped ||
    coverage.awaiting !== awaiting ||
    coverage.failed !== 0
  ) {
    fail('$.progressive_snapshot.coverage', 'counters derived from problem statuses')
  }
}

/**
 * Converts the compact storage wire into renderer view state without losing
 * stable labels/anchors. GET projection and source-action success both reuse
 * normalizeProblemSourceProgress/normalizeProblemSourceCoverage above.
 */
export function normalizeImageTaskProblemSourceActionSnapshot(
  value: unknown,
  currentProblems: readonly unknown[],
): WireRecord {
  const response = record(value, '$')
  const snapshot = record(response.progressive_snapshot, '$.progressive_snapshot')
  const structureVersion = numberValue(
    snapshot.structure_version,
    '$.progressive_snapshot.structure_version',
    true,
  )
  const snapshotRevision = numberValue(
    snapshot.snapshot_revision,
    '$.progressive_snapshot.snapshot_revision',
    true,
  )
  const currentByID = new Map<string, WireRecord>()
  currentProblems.forEach((value, index) => {
    const problem = record(value, `$currentProblems[${index}]`)
    const problemID = stringValue(problem.problem_id, `$currentProblems[${index}].problem_id`)
    if (currentByID.has(problemID)) {
      fail(`$currentProblems[${index}].problem_id`, 'unique current problem id')
    }
    currentByID.set(problemID, problem)
  })

  const seen = new Set<string>()
  const problems = arrayValue(
    snapshot.problem_progress,
    '$.progressive_snapshot.problem_progress',
  ).map((value, index) => {
    const path = `$.progressive_snapshot.problem_progress[${index}]`
    const raw = record(value, path)
    const problemID = stringValue(raw.problem_id, `${path}.problem_id`)
    if (seen.has(problemID)) fail(`${path}.problem_id`, 'unique problem id')
    seen.add(problemID)
    const current = currentByID.get(problemID)
    if (!current) fail(`${path}.problem_id`, 'existing stable display problem')
    return normalizeProblemSourceProgress(
      value,
      path,
      current,
      String(current.anchor_state ?? 'pending'),
    )
  })
  if (seen.size !== currentByID.size) {
    fail('$.progressive_snapshot.problem_progress', 'same problem exact-set as current view')
  }
  const coverage = normalizeProblemSourceCoverage(
    snapshot.coverage,
    '$.progressive_snapshot.coverage',
    problems.length,
  )
  if (coverage.raw.projection_revision !== snapshotRevision) {
    fail('$.progressive_snapshot.coverage.projection_revision', 'snapshot revision')
  }
  return {
    structure_version: structureVersion,
    snapshot_revision: snapshotRevision,
    problem_progress: problems,
    coverage: coverage.view,
  }
}
