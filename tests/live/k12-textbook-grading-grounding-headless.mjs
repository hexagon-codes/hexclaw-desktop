#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFile as execFileCallback, spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { request as playwrightRequest } from '@playwright/test'

const execFile = promisify(execFileCallback)
const SCRIPT_PATH = fileURLToPath(import.meta.url)
const LIVE_ROOT = dirname(SCRIPT_PATH)
const DESKTOP_ROOT = resolve(LIVE_ROOT, '../..')
const DEFAULT_SOURCE_ROOT = resolve(DESKTOP_ROOT, '../hexclaw')
const DEFAULT_DOCS_ROOT = resolve(DESKTOP_ROOT, '../hexclaw-docs')
const CONTRACT_PATH = resolve(LIVE_ROOT, 'k12-textbook-grading-grounding.contract.json')
const PROFILE_FIXTURE_PATH = resolve(LIVE_ROOT, 'k12-textbook-grounding-profile-fixture.go')
const SCAN_OCR_ORACLE_RELATIVE_PATH = 'tests/fixtures/local/k12-textbook-scan-ocr-oracle.v1.json'
const SCAN_OCR_ORACLE_SHA256 = '5d4af483e7acd7266338e2b9335976e96a328ae630168a00ade286929acd2adb'
const EXPECTED_PROVIDER = 'hexclaw-gpt'
const EXPECTED_MODEL = 'gpt-5.6-sol'
const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
const SHA256 = /^[a-f0-9]{64}$/u
const PREFIXED_SHA256 = /^sha256:[a-f0-9]{64}$/u
const HARD_PHASE_MAX_MS = 29 * 60_000
const DEFAULT_PHASE_MS = 24 * 60_000
const REQUEST_TIMEOUT_MS = 90_000
const START_TIMEOUT_MS = 90_000
const PHASE_CLEANUP_RESERVE_MS = 20_000
const PENDING_EXIT_CODE = 3
const PREPARE_MARKER_PREFIX = '.hexclaw-textbook-harness-v1-'
const PREPARE_RUNTIME_DIRECTORIES = Object.freeze(['bin', 'tmp', '.hexclaw'])
const PREPARE_RUNTIME_FILES = new Set(['data.db', 'data.db-shm', 'data.db-wal'])
let activePhaseDeadline = 0
let activePhaseSignal

export const STATEFUL_PHASES = Object.freeze([
  'prepare',
  'upload-text',
  'advance-text',
  'retrieve-text',
  'upload-scan',
  'advance-scan',
  'retrieve-scan',
  'bind',
  'grade',
  'restart',
  'status',
])

export const PHASES = Object.freeze(['validate', ...STATEFUL_PHASES])
const COMMANDS = Object.freeze([...PHASES, 'help'])

const EXPECTED_PUBLIC_API = Object.freeze({
  version: '/api/v1/version',
  llm_config: '/api/v1/config/llm',
  agents: '/api/v1/agents',
  embedding_status: '/api/v1/knowledge/embedding-status',
  embedding_policy: '/api/v1/knowledge/corpora/default/embedding-policy',
  documents: '/api/v1/knowledge/documents',
  document: '/api/v1/knowledge/documents/{document_id}',
  job: '/api/v1/knowledge/jobs/{job_id}',
  search: '/api/v1/knowledge/search',
  binding_options: '/api/k12/textbook-binding-options',
  profile_bundle: '/api/k12/profile-bundle',
  curriculum_progress: '/api/k12/curriculum-progress',
  curriculum_catalog: '/api/k12/curriculum-catalog',
  assets: '/api/k12/assets',
  image_tasks: '/api/k12/image-tasks',
  image_task: '/api/k12/image-tasks/{dispatch_id}',
  image_task_confirm: '/api/k12/image-tasks/{dispatch_id}/confirm',
  image_task_result: '/api/k12/image-tasks/{dispatch_id}/result',
})

const EXPECTED_RECEIPT_FIELDS = Object.freeze({
  ocr: Object.freeze([
    'page_number',
    'pages_total',
    'operation',
    'status',
    'provider',
    'model',
    'source_digest',
    'content_digest',
    'fake',
  ]),
  query: Object.freeze([
    'operation',
    'status',
    'provider_id',
    'model',
    'profile_id',
    'profile_config_hash',
    'dimension',
    'revision_id',
    'query_digest',
  ]),
  grounding: Object.freeze([
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
  ]),
  active_revision: Object.freeze([
    'revision_id',
    'state',
    'profile_config_hash',
    'profile',
    'chunks_done',
    'chunks_total',
  ]),
  problem_grounding: Object.freeze([
    'problem_id',
    'operation',
    'identity_digest',
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
  ]),
})

const EXPECTED_RESTART_EXACT_SET = Object.freeze([
  'documents',
  'ingest_jobs',
  'vector_jobs',
  'active_revision',
  'ocr_receipts',
  'textbook_bindings',
  'curriculum_progress',
  'final_artifact',
  'operation_receipts',
  'grounding_evidence_receipts',
  'problem_grounding_receipts',
])

const EXPECTED_TEXT_RETRIEVAL_ORACLES = Object.freeze([
  Object.freeze({
    physical_page: 54,
    query: '分数与除法有什么关系？你能用字母表示出分数与除法的关系吗？',
    query_sha256: 'b083c377bd89d1eb11fa99c27a539a602d28ab99aa957e6da4e571a35bb34283',
    top_k: 3,
    expected_physical_pages: Object.freeze([54]),
    expected_page_match: 'contains',
  }),
  Object.freeze({
    physical_page: 57,
    query: '老师买了 5 m 的红绸带，平均分给表演节目的 6 名女生。每人分得几米？',
    query_sha256: 'eece23497d25e57b02d52521788ea2ac26e3d0edc9aebb016cee91675d254853',
    top_k: 3,
    expected_physical_pages: Object.freeze([57]),
    expected_page_match: 'contains',
  }),
])

const EXPECTED_SCAN_RETRIEVAL_ORACLES = Object.freeze([
  Object.freeze({
    physical_page: 5,
    query: '照样子写出下图中字母的位置。',
    query_sha256: '6d98bce4803d96192497ce7449914c83dea1301ca7f78fef66cd8d56118c5258',
    top_k: 3,
    expected_physical_pages: Object.freeze([5]),
    expected_page_match: 'exact-set',
  }),
  Object.freeze({
    physical_page: 61,
    query: '一个圆形喷水池的半径是5 m',
    query_sha256: '182291d26ffacbec35c3d81abb4b3dbe50e382a7cb9d6b36be2795d206db5382',
    top_k: 3,
    expected_physical_pages: Object.freeze([61]),
    expected_page_match: 'exact-set',
  }),
  Object.freeze({
    physical_page: 120,
    query: '任意给出3个不同的自然数',
    query_sha256: 'ca18148a2ab80fbe12a2c0a15a2257ae9a1cd42c79367a17f3849b6806bdb719',
    top_k: 3,
    expected_physical_pages: Object.freeze([120]),
    expected_page_match: 'exact-set',
  }),
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

export function resolvePhase(args) {
  if (!Array.isArray(args) || args.length === 0) return 'validate'
  if (args.length !== 1 || !COMMANDS.includes(args[0])) throw new HarnessError('INVALID_PHASE')
  return args[0]
}

export function usageText() {
  return [
    'Usage: node k12-textbook-grading-grounding-headless.mjs <command>',
    '',
    'Preflight command: validate',
    'Stateful phases (run in this exact order):',
    ...STATEFUL_PHASES.map((phase, index) => `${index + 1}. ${phase}`),
    '',
    'A pending phase exits with exit code 3; re-run the same phase manually.',
    'prepare only recovers a private marked interruption before state.json exists.',
    'This does not claim that uncommitted external work can be resumed.',
    'The harness never continues to another phase automatically.',
  ].join('\n')
}

export function phaseBudgetMilliseconds(env = process.env) {
  const requested = Number.parseInt(env.HEXCLAW_TEXTBOOK_PHASE_TIMEOUT_MS ?? '', 10)
  if (!Number.isFinite(requested) || requested <= 0) return DEFAULT_PHASE_MS
  return Math.min(requested, HARD_PHASE_MAX_MS)
}

export function boundedRequestTimeout(
  requested,
  deadline,
  now = Date.now(),
  reserve = PHASE_CLEANUP_RESERVE_MS,
) {
  const available = deadline - now - reserve
  if (!Number.isFinite(available) || available <= 0) {
    throw new PhasePending('PHASE_BUDGET_PENDING')
  }
  return Math.max(1, Math.min(requested, available))
}

export async function withPhaseWallClock(milliseconds, operation) {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0 || typeof operation !== 'function') {
    throw new HarnessError('PHASE_WALL_CLOCK_INVALID')
  }
  const budget = Math.min(milliseconds, HARD_PHASE_MAX_MS)
  const deadline = Date.now() + budget
  const controller = new AbortController()
  let timer
  const expired = new Promise((_, rejectExpired) => {
    timer = setTimeout(() => {
      controller.abort()
      rejectExpired(new PhasePending('PHASE_WALL_CLOCK_PENDING'))
    }, budget)
  })
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation({ deadline, signal: controller.signal })),
      expired,
    ])
  } finally {
    clearTimeout(timer)
  }
}

function phaseSignal(signal) {
  return signal ?? activePhaseSignal
}

function assertPhaseActive(signal) {
  if (signal?.aborted) throw new PhasePending('PHASE_WALL_CLOCK_PENDING')
}

async function waitForAbortable(operation, signal) {
  if (!signal) return await operation
  assertPhaseActive(signal)
  return await new Promise((resolveWait, rejectWait) => {
    const abort = () => rejectWait(new PhasePending('PHASE_WALL_CLOCK_PENDING'))
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve(operation).then(resolveWait, rejectWait).finally(() => {
      signal.removeEventListener('abort', abort)
    })
  })
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

function positiveInteger(value, code) {
  if (!Number.isInteger(value) || value < 1) throw new HarnessError(code)
  return value
}

function sha256Text(value) {
  return createHash('sha256').update(String(value)).digest('hex')
}

export function imageTaskSourceDigest(images) {
  const hash = createHash('sha256')
  for (const image of images) {
    const length = Buffer.alloc(8)
    length.writeBigUInt64BE(BigInt(image.length))
    hash.update(length)
    hash.update(image)
  }
  return `sha256:${hash.digest('hex')}`
}

async function sha256File(pathname, signal) {
  if (signal?.aborted) throw new PhasePending('PHASE_WALL_CLOCK_PENDING')
  const hash = createHash('sha256')
  let stream
  const abort = () => stream.destroy(new PhasePending('PHASE_WALL_CLOCK_PENDING'))
  try {
    await new Promise((resolveStream, rejectStream) => {
      stream = createReadStream(pathname)
      signal?.addEventListener('abort', abort, { once: true })
      stream.on('data', (chunk) => hash.update(chunk))
      stream.once('error', rejectStream)
      stream.once('end', resolveStream)
    })
  } finally {
    signal?.removeEventListener('abort', abort)
  }
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

function exactSet(values) {
  return [...new Set(values.map((value) => canonicalJSON(value)))].sort()
}

function assertExactSet(left, right, code) {
  assert.deepEqual(exactSet(left), exactSet(right), code)
}

function normalizeScanOracleQuery(value) {
  return value
    .normalize('NFKC')
    .replace(/\s+/gu, '')
    .replace(/[。！？；，、：,.!?;:]/gu, '')
}

function projectBasicOracle(oracle, pages) {
  const value = object(oracle, 'FIXTURE_ORACLE_INVALID')
  const physicalPage = positiveInteger(value.physical_page, 'FIXTURE_ORACLE_PAGE_INVALID')
  if (physicalPage > pages) throw new HarnessError('FIXTURE_ORACLE_PAGE_INVALID')
  return {
    physical_page: physicalPage,
    query: nonEmpty(value.query, 'FIXTURE_ORACLE_QUERY_INVALID'),
  }
}

function projectScanRetrievalOracle(
  oracle,
  pages = Number.MAX_SAFE_INTEGER,
  expectedPageMatch = 'exact-set',
) {
  const value = object(oracle, 'TEXTBOOK_ORACLE_CONTRACT_INVALID')
  const expectedKeys = [
    'expected_page_match',
    'expected_physical_pages',
    'physical_page',
    'query',
    'query_sha256',
    'top_k',
  ]
  if (canonicalJSON(Object.keys(value).sort()) !== canonicalJSON(expectedKeys)) {
    throw new HarnessError('TEXTBOOK_ORACLE_CONTRACT_INVALID')
  }
  const projected = projectBasicOracle(value, pages)
  const expectedPages = array(
    value.expected_physical_pages,
    'TEXTBOOK_ORACLE_CONTRACT_INVALID',
  ).map((page) => positiveInteger(page, 'TEXTBOOK_ORACLE_CONTRACT_INVALID'))
  const canonicalPages = [...new Set(expectedPages)].sort((left, right) => left - right)
  if (
    value.top_k !== 3 ||
    value.expected_page_match !== expectedPageMatch ||
    canonicalPages.some((page) => page > pages) ||
    canonicalJSON(expectedPages) !== canonicalJSON(canonicalPages) ||
    canonicalJSON(canonicalPages) !== canonicalJSON([projected.physical_page]) ||
    !SHA256.test(value.query_sha256 ?? '') ||
    value.query_sha256 !== sha256Text(normalizeScanOracleQuery(projected.query))
  ) {
    throw new HarnessError('TEXTBOOK_ORACLE_CONTRACT_INVALID')
  }
  return {
    ...projected,
    query_sha256: value.query_sha256,
    top_k: value.top_k,
    expected_physical_pages: canonicalPages,
    expected_page_match: value.expected_page_match,
  }
}

function fixtureProjection(fixture, expectedPageMatch = 'exact-set') {
  const value = object(fixture, 'FIXTURE_CONTRACT_INVALID')
  if (!SHA256.test(value.sha256) || !Number.isInteger(value.size_bytes) || value.size_bytes < 1) {
    throw new HarnessError('FIXTURE_CONTRACT_INVALID')
  }
  const pages = positiveInteger(value.pages, 'FIXTURE_PAGE_COUNT_INVALID')
  const oracles = array(value.oracles, 'FIXTURE_ORACLE_INVALID').map((oracle) =>
    Object.prototype.hasOwnProperty.call(oracle ?? {}, 'top_k')
      ? projectScanRetrievalOracle(oracle, pages, expectedPageMatch)
      : projectBasicOracle(oracle, pages),
  )
  return {
    pages,
    oracles,
    oracle_pages: oracles.map((oracle) => oracle.physical_page).sort((a, b) => a - b),
    require_real_ocr_receipt: value.require_real_ocr_receipt === true,
  }
}

export function validateContract(contract) {
  const root = object(contract, 'CONTRACT_INVALID')
  const phaseTimeout = object(root.phase_timeout, 'PHASE_TIMEOUT_CONTRACT_INVALID')
  if (
    phaseTimeout.default_ms !== DEFAULT_PHASE_MS ||
    phaseTimeout.hard_max_ms !== HARD_PHASE_MAX_MS ||
    phaseTimeout.automatic_extension !== false ||
    phaseTimeout.pending_exit_code !== PENDING_EXIT_CODE
  ) {
    throw new HarnessError('PHASE_TIMEOUT_CONTRACT_INVALID')
  }
  if (
    canonicalJSON(object(root.public_api, 'PUBLIC_API_CONTRACT_INVALID')) !==
    canonicalJSON(EXPECTED_PUBLIC_API)
  ) {
    throw new HarnessError('PUBLIC_API_CONTRACT_INVALID')
  }
  const requiredReceipts = object(root.required_receipts, 'RECEIPT_FIELDS_CONTRACT_INVALID')
  if (
    canonicalJSON(Object.keys(requiredReceipts).sort()) !==
      canonicalJSON(Object.keys(EXPECTED_RECEIPT_FIELDS).sort()) ||
    Object.entries(EXPECTED_RECEIPT_FIELDS).some(
      ([kind, fields]) => canonicalJSON(requiredReceipts[kind]) !== canonicalJSON(fields),
    )
  ) {
    throw new HarnessError('RECEIPT_FIELDS_CONTRACT_INVALID')
  }
  if (
    canonicalJSON(array(root.restart_exact_set, 'RESTART_EXACT_SET_CONTRACT_INVALID')) !==
    canonicalJSON(EXPECTED_RESTART_EXACT_SET)
  ) {
    throw new HarnessError('RESTART_EXACT_SET_CONTRACT_INVALID')
  }
  const route = object(root.route, 'ROUTE_CONTRACT_INVALID')
  if (
    route.provider !== EXPECTED_PROVIDER ||
    route.model !== EXPECTED_MODEL ||
    route.fallback_allowed !== false
  ) {
    throw new HarnessError('ROUTE_CONTRACT_INVALID')
  }
  const embedding = object(root.embedding, 'EMBEDDING_CONTRACT_INVALID')
  if (
    embedding.model !== 'qwen3-embedding:8b' ||
    embedding.purpose !== 'ollama_embeddings' ||
    embedding.dimension !== 4096 ||
    embedding.preserve_owner_profile !== true
  ) {
    throw new HarnessError('EMBEDDING_CONTRACT_INVALID')
  }
  const transport = object(root.transport, 'TRANSPORT_CONTRACT_INVALID')
  if (
    transport.product_operations !== 'public_http_api_only' ||
    transport.http_driver !== 'playwright_api_request_context' ||
    transport.sqlite_seed_or_write !== false ||
    transport.direct_store_read !== false
  ) {
    throw new HarnessError('TRANSPORT_CONTRACT_INVALID')
  }
  const effects = object(root.validate_side_effects, 'VALIDATE_EFFECT_CONTRACT_INVALID')
  if (Object.values(effects).some((value) => value !== 0)) {
    throw new HarnessError('VALIDATE_EFFECT_CONTRACT_INVALID')
  }
  const identity = object(root.knowledge_identity, 'KNOWLEDGE_IDENTITY_CONTRACT_INVALID')
  if (
    canonicalJSON(exactSet(identity.success_multipart_fields)) !==
      canonicalJSON(exactSet(['corpus_id', 'file'])) ||
    canonicalJSON(exactSet(identity.forged_fields)) !==
      canonicalJSON(exactSet(['agent_id', 'learner_id', 'subject', 'grade'])) ||
    identity.forged_fields_must_not_prebind !== true ||
    identity.binding_authority !== 'profile_bundle_cas_only'
  ) {
    throw new HarnessError('KNOWLEDGE_IDENTITY_CONTRACT_INVALID')
  }
  const artifactReceipt = object(root.artifact_receipt_binding, 'ARTIFACT_RECEIPT_CONTRACT_INVALID')
  if (
    artifactReceipt.projection !== 'image_task_target_plus_result' ||
    artifactReceipt.final_artifact_embeds_grounding !== false ||
    artifactReceipt.summary_operation !== 'projecting' ||
    artifactReceipt.same_dispatch !== true ||
    canonicalJSON(exactSet(artifactReceipt.required_fields)) !==
      canonicalJSON(exactSet(['artifact_id', 'artifact_digest', 'summary_invocation_id']))
  ) {
    throw new HarnessError('ARTIFACT_RECEIPT_CONTRACT_INVALID')
  }
  const fixtures = object(root.fixtures, 'FIXTURE_CONTRACT_INVALID')
  const text = fixtureProjection(fixtures.text, 'contains')
  const scan = fixtureProjection(fixtures.scan)
  const scanOracleSource = object(
    fixtures.scan?.oracle_source,
    'TEXTBOOK_ORACLE_CONTRACT_INVALID',
  )
  if (
    text.pages !== 131 ||
    canonicalJSON(text.oracle_pages) !== canonicalJSON([54, 57]) ||
    canonicalJSON(text.oracles) !== canonicalJSON(EXPECTED_TEXT_RETRIEVAL_ORACLES) ||
    scan.pages !== 122 ||
    canonicalJSON(scan.oracle_pages) !== canonicalJSON([5, 61, 120]) ||
    canonicalJSON(scan.oracles) !== canonicalJSON(EXPECTED_SCAN_RETRIEVAL_ORACLES) ||
    scan.require_real_ocr_receipt !== true ||
    canonicalJSON(scanOracleSource) !==
      canonicalJSON({
        relative_path: SCAN_OCR_ORACLE_RELATIVE_PATH,
        sha256: SCAN_OCR_ORACLE_SHA256,
        schema_version: 1,
        fixture_id: 'scanned_textbook_pdf',
      })
  ) {
    throw new HarnessError('TEXTBOOK_ORACLE_CONTRACT_INVALID')
  }
  scan.oracle_source = { ...scanOracleSource }
  return {
    route: {
      provider: route.provider,
      model: route.model,
      fallback_allowed: route.fallback_allowed,
    },
    embedding: { ...embedding },
    knowledge_identity: {
      success_multipart_fields: [...identity.success_multipart_fields],
      forged_fields: [...identity.forged_fields],
      forged_fields_must_not_prebind: identity.forged_fields_must_not_prebind,
      binding_authority: identity.binding_authority,
    },
    artifact_receipt_binding: {
      projection: artifactReceipt.projection,
      final_artifact_embeds_grounding: artifactReceipt.final_artifact_embeds_grounding,
      required_fields: [...artifactReceipt.required_fields],
      summary_operation: artifactReceipt.summary_operation,
      same_dispatch: artifactReceipt.same_dispatch,
    },
    textbook: { text, scan },
    phase_timeout: { ...phaseTimeout },
    public_api: { ...root.public_api },
    required_receipts: Object.fromEntries(
      Object.entries(requiredReceipts).map(([kind, fields]) => [kind, [...fields]]),
    ),
    restart_exact_set: [...root.restart_exact_set],
    validate_side_effects: { ...effects },
    transport: {
      product_operations: transport.product_operations,
      sqlite_seed_or_write: transport.sqlite_seed_or_write,
    },
  }
}

export function assertScanOCROracleSource(contract, oracle, sourceDigest) {
  const scan = object(contract?.fixtures?.scan, 'TEXTBOOK_ORACLE_SOURCE_INVALID')
  const source = object(scan.oracle_source, 'TEXTBOOK_ORACLE_SOURCE_INVALID')
  const fixtureOracle = object(oracle, 'TEXTBOOK_ORACLE_SOURCE_INVALID')
  const fixtureIdentity = object(fixtureOracle.fixture, 'TEXTBOOK_ORACLE_SOURCE_INVALID')
  if (
    sourceDigest !== source.sha256 ||
    fixtureOracle.schemaVersion !== source.schema_version ||
    fixtureOracle.fixtureId !== source.fixture_id ||
    fixtureIdentity.sha256 !== scan.sha256 ||
    fixtureIdentity.bytes !== scan.size_bytes ||
    fixtureIdentity.physicalPages !== scan.pages ||
    fixtureIdentity.sourceKind !== 'image-only-scanned-pdf' ||
    fixtureIdentity.redistributable !== false
  ) {
    throw new HarnessError('TEXTBOOK_ORACLE_SOURCE_INVALID')
  }
  const projected = array(fixtureOracle.oracles, 'TEXTBOOK_ORACLE_SOURCE_INVALID').map(
    (item) =>
      projectScanRetrievalOracle(
        {
          physical_page: item?.physicalPage,
          query: item?.query,
          query_sha256: item?.querySha256,
          top_k: item?.retrievalOracle?.topK,
          expected_physical_pages: item?.retrievalOracle?.expectedPhysicalPages,
          expected_page_match: item?.retrievalOracle?.expectedPageMatch,
        },
        scan.pages,
      ),
  )
  if (canonicalJSON(projected) !== canonicalJSON(scan.oracles)) {
    throw new HarnessError('TEXTBOOK_ORACLE_SOURCE_INVALID')
  }
  return {
    sha256: sourceDigest,
    pages: scan.pages,
    oracle_pages: projected.map((item) => item.physical_page),
    top_k: [...new Set(projected.map((item) => item.top_k))],
  }
}

export function assertRealOCRReceipts(receipts, fixture) {
  const source = array(receipts, 'OCR_RECEIPT_REQUIRED')
  const expected = object(fixture, 'OCR_PAGE_CONTRACT_INVALID')
  const pagesTotal = positiveInteger(expected.pages, 'OCR_PAGE_CONTRACT_INVALID')
  if (!SHA256.test(expected.sha256 ?? '') || source.length !== pagesTotal) {
    throw new HarnessError('OCR_PAGE_EXACT_SET_INVALID')
  }
  const pages = new Set()
  for (const receipt of source) {
    if (
      canonicalJSON(Object.keys(object(receipt, 'OCR_RECEIPT_INVALID')).sort()) !==
        canonicalJSON([...EXPECTED_RECEIPT_FIELDS.ocr].sort()) ||
      receipt?.operation !== 'knowledge_pdf_page_ocr' ||
      receipt?.status !== 'succeeded' ||
      receipt?.provider !== EXPECTED_PROVIDER ||
      receipt?.model !== EXPECTED_MODEL ||
      receipt?.fake !== false ||
      !Number.isInteger(receipt?.page_number) ||
      !Number.isInteger(receipt?.pages_total) ||
      receipt.pages_total !== pagesTotal ||
      receipt.page_number < 1 ||
      receipt.page_number > pagesTotal ||
      receipt.source_digest !== expected.sha256 ||
      !SHA256.test(receipt?.content_digest ?? '')
    ) {
      throw new HarnessError('OCR_RECEIPT_INVALID')
    }
    if (pages.has(receipt.page_number)) throw new HarnessError('OCR_PAGE_EXACT_SET_INVALID')
    pages.add(receipt.page_number)
  }
  for (let page = 1; page <= pagesTotal; page += 1) {
    if (!pages.has(page)) throw new HarnessError('OCR_PAGE_NOT_PROVEN')
  }
  return source.map((receipt) => ({
    page_number: receipt.page_number,
    pages_total: receipt.pages_total,
    operation: receipt.operation,
    status: receipt.status,
    provider: receipt.provider,
    model: receipt.model,
    source_digest: receipt.source_digest,
    content_digest: receipt.content_digest,
    fake: false,
  }))
}

export function assertActiveEmbeddingRevision(policy, document, vectorJob, expected) {
  const active = object(policy?.active_revision, 'ACTIVE_EMBEDDING_REVISION_REQUIRED')
  const profile = object(active.profile, 'ACTIVE_EMBEDDING_REVISION_INVALID')
  const route = object(expected, 'ACTIVE_EMBEDDING_REVISION_INVALID')
  const chunksDone = active.chunks_done
  const chunksTotal = active.chunks_total
  const documentChunksDone = document?.vector_chunks_done
  const documentChunksTotal = document?.vector_chunks_total
  if (
    !nonEmpty(active.revision_id, 'ACTIVE_EMBEDDING_REVISION_INVALID') ||
    active.state !== 'ready' ||
    !SHA256.test(active.profile_config_hash ?? '') ||
    profile.profile_id !== route.profile_id ||
    profile.provider_id !== route.provider_id ||
    profile.provider_name !== route.provider_name ||
    profile.model_name !== route.model ||
    profile.capability !== 'embedding' ||
    profile.dimension !== route.dimension ||
    !['installed', 'connected'].includes(profile.availability) ||
    !['local', 'cloud'].includes(profile.location) ||
    !Number.isInteger(profile.display_order) ||
    profile.display_order < 0 ||
    !Number.isInteger(chunksDone) ||
    chunksDone <= 0 ||
    chunksDone !== chunksTotal ||
    document?.vector_index_state !== 'ready' ||
    document?.vector_job_state !== 'succeeded' ||
    !nonEmpty(document?.vector_job_id, 'ACTIVE_EMBEDDING_REVISION_INVALID') ||
    !Number.isInteger(documentChunksDone) ||
    documentChunksDone <= 0 ||
    documentChunksDone !== documentChunksTotal ||
    vectorJob?.job_id !== document.vector_job_id ||
    vectorJob?.document_id !== document.document_id ||
    vectorJob?.target_revision_id !== active.revision_id ||
    vectorJob?.kind !== 'embed_document' ||
    vectorJob?.state !== 'succeeded' ||
    vectorJob?.stage !== 'embedding' ||
    vectorJob?.chunks_done !== documentChunksDone ||
    vectorJob?.chunks_total !== documentChunksTotal
  ) {
    throw new HarnessError('ACTIVE_EMBEDDING_REVISION_INVALID')
  }
  return {
    revision_id: active.revision_id,
    state: active.state,
    profile_config_hash: active.profile_config_hash,
    profile: {
      profile_id: profile.profile_id,
      provider_id: profile.provider_id,
      provider_name: profile.provider_name,
      model_name: profile.model_name,
      location: profile.location,
      capability: profile.capability,
      dimension: profile.dimension,
      availability: profile.availability,
      display_order: profile.display_order,
    },
    chunks_done: chunksDone,
    chunks_total: chunksTotal,
  }
}

function groundingKeyFromReceipt(receipt) {
  if (
    typeof receipt?.textbook_binding_id !== 'string' ||
    receipt.textbook_binding_id === '' ||
    typeof receipt?.textbook_manifest_id !== 'string' ||
    receipt.textbook_manifest_id === '' ||
    typeof receipt?.document_id !== 'string' ||
    receipt.document_id === '' ||
    !Number.isInteger(receipt?.document_generation) ||
    receipt.document_generation < 1 ||
    typeof receipt?.vector_revision_id !== 'string' ||
    receipt.vector_revision_id === '' ||
    !PREFIXED_SHA256.test(receipt?.query_digest ?? '') ||
    typeof receipt?.chunk_id !== 'string' ||
    receipt.chunk_id === '' ||
    !Number.isInteger(receipt?.logical_page) ||
    receipt.logical_page < 1 ||
    !Number.isInteger(receipt?.pdf_page) ||
    receipt.pdf_page < 1 ||
    !SHA256.test(receipt?.source_digest ?? '') ||
    !SHA256.test(receipt?.citation_digest ?? '')
  ) {
    throw new HarnessError('GROUNDING_RECEIPT_INVALID')
  }
  return {
    binding_id: receipt.textbook_binding_id,
    manifest_id: receipt.textbook_manifest_id,
    document_id: receipt.document_id,
    document_generation: receipt.document_generation,
    revision_id: receipt.vector_revision_id,
    query_digest: receipt.query_digest,
    chunk_id: receipt.chunk_id,
    logical_page: receipt.logical_page,
    pdf_page: receipt.pdf_page,
    source_digest: receipt.source_digest,
    citation_digest: receipt.citation_digest,
  }
}

function groundingKeyFromSearch(search) {
  const envelope = object(search, 'GROUNDING_SEARCH_INVALID')
  const query = object(envelope.query_receipt, 'GROUNDING_QUERY_RECEIPT_INVALID')
  const hit = object(envelope.hit, 'GROUNDING_SEARCH_HIT_INVALID')
  if (
    query.operation !== 'query_embedding' ||
    query.status !== 'succeeded' ||
    query.revision_id !== hit.revision_id ||
    !PREFIXED_SHA256.test(query.query_digest ?? '') ||
    nonEmpty(query.provider_id, 'GROUNDING_QUERY_RECEIPT_INVALID') === '' ||
    nonEmpty(query.model, 'GROUNDING_QUERY_RECEIPT_INVALID') === '' ||
    nonEmpty(query.profile_id, 'GROUNDING_QUERY_RECEIPT_INVALID') === '' ||
    !SHA256.test(query.profile_config_hash ?? '') ||
    !Number.isInteger(query.dimension) ||
    query.dimension < 1 ||
    !Number.isInteger(hit.page_start) ||
    !Number.isInteger(hit.page_end) ||
    hit.page_start < 1 ||
    hit.page_end < hit.page_start
  ) {
    throw new HarnessError('GROUNDING_QUERY_RECEIPT_INVALID')
  }
  return {
    binding_id: nonEmpty(envelope.binding_id, 'GROUNDING_SEARCH_INVALID'),
    manifest_id: nonEmpty(envelope.manifest_id, 'GROUNDING_SEARCH_INVALID'),
    document_id: nonEmpty(hit.doc_id, 'GROUNDING_SEARCH_HIT_INVALID'),
    document_generation: positiveInteger(hit.document_generation, 'GROUNDING_SEARCH_HIT_INVALID'),
    revision_id: nonEmpty(hit.revision_id, 'GROUNDING_SEARCH_HIT_INVALID'),
    query_digest: query.query_digest,
    chunk_id: nonEmpty(hit.chunk_id, 'GROUNDING_SEARCH_HIT_INVALID'),
    logical_page: positiveInteger(envelope.logical_page, 'GROUNDING_SEARCH_HIT_INVALID'),
    pdf_page: positiveInteger(envelope.pdf_page, 'GROUNDING_SEARCH_HIT_INVALID'),
    source_digest: nonEmpty(hit.source_digest, 'GROUNDING_SEARCH_HIT_INVALID'),
    citation_digest: nonEmpty(hit.citation_digest, 'GROUNDING_SEARCH_HIT_INVALID'),
  }
}

export function assertGroundingExactSet(receipts, publicSearches) {
  let actual
  let independentlyObserved
  try {
    actual = array(receipts, 'GROUNDING_RECEIPTS_REQUIRED').map(groundingKeyFromReceipt)
    independentlyObserved = array(publicSearches, 'GROUNDING_PUBLIC_SEARCH_REQUIRED').map(
      groundingKeyFromSearch,
    )
  } catch {
    throw new HarnessError('GROUNDING_EXACT_SET_DRIFT')
  }
  if (actual.length === 0 || independentlyObserved.length === 0) {
    throw new HarnessError('GROUNDING_EXACT_SET_EMPTY')
  }
  try {
    assertExactSet(actual, independentlyObserved, 'GROUNDING_EXACT_SET_DRIFT')
  } catch {
    throw new HarnessError('GROUNDING_EXACT_SET_DRIFT')
  }
  return actual.sort((left, right) => canonicalJSON(left).localeCompare(canonicalJSON(right)))
}

function projectProblemGroundingReceipt(receipt) {
  if (
    canonicalJSON(Object.keys(object(receipt, 'PROBLEM_GROUNDING_RECEIPT_INVALID')).sort()) !==
      canonicalJSON([...EXPECTED_RECEIPT_FIELDS.problem_grounding].sort()) ||
    !nonEmpty(receipt.problem_id, 'PROBLEM_GROUNDING_RECEIPT_INVALID') ||
    !['solve', 'grade'].includes(receipt.operation) ||
    !PREFIXED_SHA256.test(receipt.identity_digest ?? '')
  ) {
    throw new HarnessError('PROBLEM_GROUNDING_RECEIPT_INVALID')
  }
  const lineage = groundingKeyFromReceipt(receipt)
  return {
    problem_id: receipt.problem_id,
    operation: receipt.operation,
    identity_digest: receipt.identity_digest,
    textbook_binding_id: lineage.binding_id,
    textbook_manifest_id: lineage.manifest_id,
    document_id: lineage.document_id,
    document_generation: lineage.document_generation,
    vector_revision_id: lineage.revision_id,
    query_digest: lineage.query_digest,
    chunk_id: lineage.chunk_id,
    logical_page: lineage.logical_page,
    pdf_page: lineage.pdf_page,
    source_digest: lineage.source_digest,
    citation_digest: lineage.citation_digest,
  }
}

function problemGroundingLineage(receipt) {
  return {
    textbook_binding_id: receipt.textbook_binding_id,
    textbook_manifest_id: receipt.textbook_manifest_id,
    document_id: receipt.document_id,
    document_generation: receipt.document_generation,
    vector_revision_id: receipt.vector_revision_id,
    query_digest: receipt.query_digest,
    chunk_id: receipt.chunk_id,
    logical_page: receipt.logical_page,
    pdf_page: receipt.pdf_page,
    source_digest: receipt.source_digest,
    citation_digest: receipt.citation_digest,
  }
}

const PROBLEM_GROUNDING_OPERATIONS_BY_STATUS = new Map([
  ['correct', ['solve', 'grade']],
  ['correct_with_process_issue', ['solve', 'grade']],
  ['wrong', ['solve', 'grade']],
  ['untrusted', ['solve', 'grade']],
  ['blank_solved', ['solve']],
  ['out_of_scope', ['solve']],
  ['unanswered', []],
  ['answer_unclear', []],
  ['unclear', []],
])

function publicProblemStatus(value) {
  const projection = object(value, 'PROBLEM_GROUNDING_STATUS_REQUIRED')
  const status = nonEmpty(projection.status, 'PROBLEM_GROUNDING_STATUS_REQUIRED')
  if (!PROBLEM_GROUNDING_OPERATIONS_BY_STATUS.has(status)) {
    throw new HarnessError('PROBLEM_GROUNDING_STATUS_INVALID')
  }
  return {
    problem_id: nonEmpty(projection.problem_id, 'PROBLEM_GROUNDING_STATUS_REQUIRED'),
    status,
  }
}

export function assertProblemGroundingExactSet(
  expectedProblemIDs,
  problemProgress,
  targetReceipts,
  resultReceipts,
) {
  try {
    const expected = array(expectedProblemIDs, 'PROBLEM_GROUNDING_PROBLEMS_REQUIRED').map(
      (problemID) => nonEmpty(problemID, 'PROBLEM_GROUNDING_PROBLEMS_REQUIRED'),
    )
    if (expected.length === 0 || new Set(expected).size !== expected.length) {
      throw new HarnessError('PROBLEM_GROUNDING_PROBLEMS_INVALID')
    }
    const statuses = array(problemProgress, 'PROBLEM_GROUNDING_STATUS_REQUIRED').map(
      publicProblemStatus,
    )
    if (
      statuses.length !== expected.length ||
      new Set(statuses.map((problem) => problem.problem_id)).size !== statuses.length
    ) {
      throw new HarnessError('PROBLEM_GROUNDING_STATUS_EXACT_SET_INVALID')
    }
    assertExactSet(
      statuses.map((problem) => problem.problem_id),
      expected,
      'PROBLEM_GROUNDING_STATUS_EXACT_SET_INVALID',
    )
    const target = array(targetReceipts, 'PROBLEM_GROUNDING_RECEIPTS_REQUIRED').map(
      projectProblemGroundingReceipt,
    )
    const result = array(resultReceipts, 'PROBLEM_GROUNDING_RESULT_RECEIPTS_REQUIRED').map(
      projectProblemGroundingReceipt,
    )
    if (
      target.length !== exactSet(target).length ||
      result.length !== exactSet(result).length
    ) {
      throw new HarnessError('PROBLEM_GROUNDING_EXACT_SET_INVALID')
    }
    assertExactSet(target, result, 'PROBLEM_GROUNDING_RESULT_EXACT_SET_INVALID')
    const statusByProblem = new Map(
      statuses.map((problem) => [problem.problem_id, problem.status]),
    )
    if (target.some((receipt) => !statusByProblem.has(receipt.problem_id))) {
      throw new HarnessError('PROBLEM_GROUNDING_UNKNOWN_PROBLEM')
    }
    for (const problem of statuses) {
      const rows = target.filter((receipt) => receipt.problem_id === problem.problem_id)
      const expectedOperations = PROBLEM_GROUNDING_OPERATIONS_BY_STATUS.get(problem.status)
      const actualOperations = [...new Set(rows.map((receipt) => receipt.operation))].sort()
      assert.deepEqual(
        actualOperations,
        [...expectedOperations].sort(),
        'PROBLEM_GROUNDING_OPERATION_INVALID',
      )
      if (expectedOperations.length === 0) continue
      const identities = new Set(rows.map((receipt) => receipt.identity_digest))
      const solve = rows
        .filter((receipt) => receipt.operation === 'solve')
        .map(problemGroundingLineage)
      const grade = rows
        .filter((receipt) => receipt.operation === 'grade')
        .map(problemGroundingLineage)
      if (
        identities.size !== 1 ||
        solve.length === 0 ||
        solve.length !== exactSet(solve).length ||
        grade.length !== exactSet(grade).length
      ) {
        throw new HarnessError('PROBLEM_GROUNDING_OPERATION_INVALID')
      }
      if (expectedOperations.includes('grade')) {
        if (grade.length === 0) throw new HarnessError('PROBLEM_GROUNDING_OPERATION_INVALID')
        assertExactSet(solve, grade, 'PROBLEM_GROUNDING_LINEAGE_DRIFT')
      }
    }
    return target.sort((left, right) => canonicalJSON(left).localeCompare(canonicalJSON(right)))
  } catch (error) {
    if (error instanceof HarnessError && error.code.startsWith('PROBLEM_GROUNDING_')) throw error
    throw new HarnessError('PROBLEM_GROUNDING_EXACT_SET_DRIFT')
  }
}

export async function resolveGroundingForClosure(mode, persisted, independentlyObserve) {
  const projection = array(persisted, 'GROUNDING_RECEIPTS_REQUIRED')
  if (mode === 'restart') return projection
  if (mode === 'grade' && typeof independentlyObserve === 'function') {
    return await independentlyObserve()
  }
  throw new HarnessError('GROUNDING_OBSERVATION_MODE_INVALID')
}

export function assertRestartInvariant(before, after) {
  try {
    assert.deepEqual(after, before)
  } catch {
    throw new HarnessError('RESTART_EXACT_SET_DRIFT')
  }
  return before
}

const FORBIDDEN_EVIDENCE_FIELDS = new Set([
  'api_key',
  'body',
  'capability',
  'content',
  'credential',
  'path',
  'prompt',
  'query',
  'raw',
  'response',
  'token',
])

function assertEvidenceSafe(value, field = '') {
  if (FORBIDDEN_EVIDENCE_FIELDS.has(field)) throw new HarnessError('UNSAFE_EVIDENCE_FIELD')
  if (typeof value === 'string') {
    if (value.startsWith('/') || /\/Users\//u.test(value) || /\bBearer\s+/iu.test(value)) {
      throw new HarnessError('UNSAFE_EVIDENCE_VALUE')
    }
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) assertEvidenceSafe(item, field)
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) assertEvidenceSafe(item, key)
  }
}

function safeCode(error) {
  return error instanceof HarnessError && /^[A-Z0-9_]+$/u.test(error.code)
    ? error.code
    : 'HARNESS_FAILED'
}

function remaining(deadline, maximum, code) {
  const value = deadline - Date.now() - PHASE_CLEANUP_RESERVE_MS
  if (value <= 0) throw new PhasePending(code)
  return Math.min(value, maximum)
}

function sleep(milliseconds) {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds))
}

function runtimePaths(env = process.env) {
  const sourceRoot = resolve(env.HEXCLAW_SOURCE_ROOT || DEFAULT_SOURCE_ROOT)
  const docsRoot = resolve(env.HEXCLAW_DOCS_ROOT || DEFAULT_DOCS_ROOT)
  const ownerConfig = resolve(
    env.HEXCLAW_OWNER_CONFIG || join(homedir(), '.hexclaw', 'hexclaw.yaml'),
  )
  const goBinary = resolve(env.HEXCLAW_GO_BIN || '/usr/local/go/bin/go')
  const pdfInfo = resolve(env.HEXCLAW_PDFINFO_BIN || '/opt/homebrew/bin/pdfinfo')
  const runRootValue = env.HEXCLAW_TEXTBOOK_RUN_DIR
  const runRoot = runRootValue ? resolve(runRootValue) : ''
  return { sourceRoot, docsRoot, ownerConfig, goBinary, pdfInfo, runRoot }
}

async function requireRegularFile(pathname, code, options = {}) {
  let info
  try {
    info = await lstat(pathname)
    if (info.isSymbolicLink() && options.executable) {
      info = await lstat(await realpath(pathname))
    }
  } catch {
    throw new HarnessError(code)
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new HarnessError(code)
  if (options.privateFile && (info.mode & 0o777) !== PRIVATE_FILE_MODE) {
    throw new HarnessError(code)
  }
  if (options.executable && (info.mode & 0o111) === 0) throw new HarnessError(code)
  return info
}

async function requireDirectory(pathname, code) {
  try {
    const info = await stat(pathname)
    if (!info.isDirectory()) throw new Error('not directory')
  } catch {
    throw new HarnessError(code)
  }
}

async function loadContract() {
  let value
  try {
    value = JSON.parse(await readFile(CONTRACT_PATH, 'utf8'))
  } catch {
    throw new HarnessError('CONTRACT_UNAVAILABLE')
  }
  validateContract(value)
  const source = value.fixtures.scan.oracle_source
  const oraclePath = resolve(DESKTOP_ROOT, source.relative_path)
  const inside = relative(DESKTOP_ROOT, oraclePath)
  if (inside.startsWith('..') || inside === '') {
    throw new HarnessError('TEXTBOOK_ORACLE_SOURCE_INVALID')
  }
  let rawOracle
  let oracle
  try {
    rawOracle = await readFile(oraclePath, 'utf8')
    oracle = JSON.parse(rawOracle)
  } catch {
    throw new HarnessError('TEXTBOOK_ORACLE_SOURCE_INVALID')
  }
  assertScanOCROracleSource(value, oracle, sha256Text(rawOracle))
  return value
}

function fixturePath(paths, fixture) {
  const candidate = resolve(paths.docsRoot, fixture.relative_path)
  const inside = relative(paths.docsRoot, candidate)
  if (inside.startsWith('..') || inside === '') throw new HarnessError('FIXTURE_PATH_INVALID')
  return candidate
}

async function validateFixture(
  paths,
  fixture,
  pdf = true,
  deadline = 0,
  signal = activePhaseSignal,
) {
  const pathname = fixturePath(paths, fixture)
  const info = await requireRegularFile(pathname, 'FIXTURE_UNAVAILABLE')
  if (info.size !== fixture.size_bytes || (await sha256File(pathname, signal)) !== fixture.sha256) {
    throw new HarnessError('FIXTURE_IDENTITY_DRIFT')
  }
  if (pdf) {
    let output
    try {
      const timeout = deadline ? boundedRequestTimeout(15_000, deadline) : 15_000
      output = await execFile(paths.pdfInfo, [pathname], {
        encoding: 'utf8',
        timeout,
        signal,
        maxBuffer: 1 << 20,
      })
    } catch {
      if (signal?.aborted) throw new PhasePending('PHASE_WALL_CLOCK_PENDING')
      throw new HarnessError('PDFINFO_FAILED')
    }
    const matched = /^Pages:\s+(\d+)$/mu.exec(output.stdout)
    if (!matched || Number.parseInt(matched[1], 10) !== fixture.pages) {
      throw new HarnessError('PDF_PAGE_COUNT_DRIFT')
    }
  }
  return { sha256: fixture.sha256, size_bytes: fixture.size_bytes, pages: fixture.pages }
}

async function validateStatic(env = process.env, deadline = 0, signal) {
  const contract = await loadContract()
  const paths = runtimePaths(env)
  await requireDirectory(paths.sourceRoot, 'SOURCE_ROOT_UNAVAILABLE')
  await requireRegularFile(join(paths.sourceRoot, 'go.mod'), 'SOURCE_MODULE_UNAVAILABLE')
  await requireRegularFile(
    join(paths.sourceRoot, 'cmd', 'hexclaw', 'main.go'),
    'SIDECAR_SOURCE_UNAVAILABLE',
  )
  await requireRegularFile(paths.goBinary, 'GO_BINARY_UNAVAILABLE', { executable: true })
  await requireRegularFile(paths.pdfInfo, 'PDFINFO_UNAVAILABLE', { executable: true })
  await requireRegularFile(PROFILE_FIXTURE_PATH, 'PROFILE_FIXTURE_UNAVAILABLE')
  const text = await validateFixture(paths, contract.fixtures.text, true, deadline, signal)
  const scan = await validateFixture(paths, contract.fixtures.scan, true, deadline, signal)
  const homework = await validateFixture(paths, contract.fixtures.homework, false, deadline, signal)
  return {
    status: 'validated',
    phase: 'validate',
    live_gate_required: true,
    sidecar_started: false,
    uploads: 0,
    model_calls: 0,
    im_sends: 0,
    public_api_only: true,
    phase_hard_cap_ms: HARD_PHASE_MAX_MS,
    fixtures: { text, scan, homework },
  }
}

async function createPrivateFile(pathname, content = '') {
  const handle = await open(pathname, 'wx', PRIVATE_FILE_MODE)
  try {
    await handle.writeFile(content)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await chmod(pathname, PRIVATE_FILE_MODE)
}

async function writePrivateJSON(pathname, value) {
  const temporary = `${pathname}.tmp-${randomBytes(6).toString('hex')}`
  await createPrivateFile(temporary, `${JSON.stringify(value, null, 2)}\n`)
  await rename(temporary, pathname)
  await chmod(pathname, PRIVATE_FILE_MODE)
}

async function hasDirectFinalPathComponent(pathname) {
  return (await realpath(pathname)) === join(await realpath(dirname(pathname)), basename(pathname))
}

async function requirePrivateRunDirectory(runRoot, code = 'RUN_DIRECTORY_UNAVAILABLE') {
  let info
  try {
    info = await lstat(runRoot)
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (info.mode & 0o777) !== PRIVATE_DIRECTORY_MODE ||
      !(await hasDirectFinalPathComponent(runRoot))
    ) {
      throw new Error('unsafe run directory')
    }
  } catch {
    throw new HarnessError(code)
  }
}

async function loadState(runRoot) {
  try {
    await requirePrivateRunDirectory(runRoot, 'RUN_STATE_UNAVAILABLE')
    await requireRegularFile(join(runRoot, 'state.json'), 'RUN_STATE_UNAVAILABLE', {
      privateFile: true,
    })
    const value = JSON.parse(await readFile(join(runRoot, 'state.json'), 'utf8'))
    if (value?.schema_version !== 1) throw new Error('schema')
    return value
  } catch {
    throw new HarnessError('RUN_STATE_UNAVAILABLE')
  }
}

async function saveState(runRoot, state) {
  await requirePrivateRunDirectory(runRoot)
  state.updated_at = new Date().toISOString()
  await writePrivateJSON(join(runRoot, 'state.json'), state)
}

function prepareMarkerName(runRoot) {
  return `${PREPARE_MARKER_PREFIX}${sha256Text(`textbook-harness:${runRoot}`).slice(0, 16)}`
}

async function assertPrivateDirectory(pathname, code) {
  let info
  try {
    info = await lstat(pathname)
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (info.mode & 0o777) !== PRIVATE_DIRECTORY_MODE ||
      !(await hasDirectFinalPathComponent(pathname))
    ) {
      throw new Error('unsafe directory')
    }
  } catch {
    throw new HarnessError(code)
  }
}

async function assertRecoverableTree(pathname) {
  const info = await lstat(pathname)
  if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
    throw new HarnessError('RUN_DIRECTORY_RECOVERY_UNSAFE')
  }
  if (!info.isDirectory()) return
  for (const name of await readdir(pathname)) {
    await assertRecoverableTree(join(pathname, name))
  }
}

async function assertRedactedEvidenceDirectory(pathname) {
  await assertPrivateDirectory(pathname, 'RUN_DIRECTORY_RECOVERY_UNSAFE')
  for (const name of await readdir(pathname)) {
    if (!PHASES.some((phase) => name === `${phase}.json`)) {
      throw new HarnessError('RUN_DIRECTORY_RECOVERY_UNSAFE')
    }
    await requireRegularFile(join(pathname, name), 'RUN_DIRECTORY_RECOVERY_UNSAFE', {
      privateFile: true,
    })
    let receipt
    try {
      receipt = JSON.parse(await readFile(join(pathname, name), 'utf8'))
      assertEvidenceSafe(receipt)
    } catch {
      throw new HarnessError('RUN_DIRECTORY_RECOVERY_UNSAFE')
    }
  }
}

async function requirePrepareMarker(runRoot, code = 'RUN_DIRECTORY_RECOVERY_UNSAFE') {
  await assertPrivateDirectory(join(runRoot, prepareMarkerName(runRoot)), code)
}

export async function prepareRunDirectory(runRoot) {
  const marker = prepareMarkerName(runRoot)
  let rootExists = false
  try {
    const info = await lstat(runRoot)
    rootExists = true
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (info.mode & 0o777) !== PRIVATE_DIRECTORY_MODE ||
      !(await hasDirectFinalPathComponent(runRoot))
    ) {
      throw new HarnessError('RUN_DIRECTORY_NOT_EMPTY_OR_PRIVATE')
    }
  } catch (error) {
    if (error instanceof HarnessError) throw error
    if (error?.code !== 'ENOENT') throw new HarnessError('RUN_DIRECTORY_UNAVAILABLE')
  }

  if (!rootExists) {
    await mkdir(runRoot, { recursive: false, mode: PRIVATE_DIRECTORY_MODE })
    await chmod(runRoot, PRIVATE_DIRECTORY_MODE)
    if (!(await hasDirectFinalPathComponent(runRoot))) {
      throw new HarnessError('RUN_DIRECTORY_NOT_EMPTY_OR_PRIVATE')
    }
  }

  const initialEntries = await readdir(runRoot)
  let status = 'created'
  if (initialEntries.length === 0) {
    await mkdir(join(runRoot, marker), { mode: PRIVATE_DIRECTORY_MODE })
    await chmod(join(runRoot, marker), PRIVATE_DIRECTORY_MODE)
  } else {
    if (!initialEntries.includes(marker)) {
      throw new HarnessError('RUN_DIRECTORY_RECOVERY_UNSAFE')
    }
    await requirePrepareMarker(runRoot)
    const recoverable = new Set([
      marker,
      'evidence',
      ...PREPARE_RUNTIME_DIRECTORIES,
      ...PREPARE_RUNTIME_FILES,
    ])
    const unexpected = initialEntries.filter(
      (name) => !recoverable.has(name) && !/^state\.json\.tmp-[a-f0-9]{12}$/u.test(name),
    )
    if (unexpected.length > 0) throw new HarnessError('RUN_DIRECTORY_RECOVERY_UNSAFE')

    if (initialEntries.includes('evidence')) {
      await assertRedactedEvidenceDirectory(join(runRoot, 'evidence'))
    }
    const removable = initialEntries.filter(
      (name) =>
        PREPARE_RUNTIME_DIRECTORIES.includes(name) ||
        PREPARE_RUNTIME_FILES.has(name) ||
        /^state\.json\.tmp-[a-f0-9]{12}$/u.test(name),
    )
    for (const name of removable) {
      const target = join(runRoot, name)
      await assertRecoverableTree(target)
    }
    for (const name of removable) {
      await rm(join(runRoot, name), { recursive: true, force: false })
    }
    status = 'recovered'
  }

  for (const directory of PREPARE_RUNTIME_DIRECTORIES) {
    await mkdir(join(runRoot, directory), { mode: PRIVATE_DIRECTORY_MODE })
    await chmod(join(runRoot, directory), PRIVATE_DIRECTORY_MODE)
  }
  return { status, marker }
}

async function reservePort() {
  const server = createServer()
  server.unref()
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()))
  })
  if (!Number.isInteger(port) || port < 1024 || port >= 65534) {
    throw new HarnessError('LOOPBACK_PORT_INVALID')
  }
  return port
}

function toolEnvironment(env, home) {
  const output = {}
  for (const key of [
    'PATH',
    'LANG',
    'LC_ALL',
    'GOCACHE',
    'GOMODCACHE',
    'GOPATH',
    'GOPROXY',
    'GOSUMDB',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
  ]) {
    if (typeof env[key] === 'string' && env[key] !== '') output[key] = env[key]
  }
  return { ...output, HOME: home, TMPDIR: join(home, 'tmp') }
}

export async function runCommand(command, args, options, code) {
  const signal = phaseSignal(options.signal)
  assertPhaseActive(signal)
  try {
    return await execFile(command, args, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeout,
      signal,
      encoding: 'utf8',
      maxBuffer: 4 << 20,
    })
  } catch {
    if (signal?.aborted) throw new PhasePending('PHASE_WALL_CLOCK_PENDING')
    throw new HarnessError(code)
  }
}

function runtimeFromState(paths, state, env) {
  const runRoot = paths.runRoot
  return {
    runRoot,
    config: join(runRoot, state.runtime.config),
    store: join(runRoot, state.runtime.store),
    sidecar: join(runRoot, state.runtime.sidecar),
    helper: join(runRoot, state.runtime.helper),
    baseURL: `http://127.0.0.1:${state.runtime.port}`,
    env: toolEnvironment(env, runRoot),
  }
}

function startSidecar(runtime, capability, signal) {
  assertPhaseActive(signal)
  const hash = createHash('sha256')
  let bytes = 0
  const child = spawn(runtime.sidecar, ['serve', '--desktop', '--config', runtime.config], {
    cwd: runtime.runRoot,
    env: {
      ...runtime.env,
      HEXCLAW_SIDECAR_CAPABILITY_TOKEN: capability,
      DINGTALK_LIVE_SEND: '0',
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    signal,
  })
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => {
      bytes += chunk.length
      hash.update(chunk)
    })
  }
  const processState = { child, hash, bytes: () => bytes, spawnFailed: false }
  child.once('error', () => {
    processState.spawnFailed = true
  })
  return processState
}

async function stopSidecar(processState, deadline = 0) {
  if (!processState) return { log_sha256: sha256Text(''), log_bytes: 0 }
  const { child } = processState
  let graceful = child.exitCode !== null || child.signalCode !== null
  if (!graceful) {
    const closed = new Promise((resolveClose) => child.once('close', resolveClose))
    child.kill('SIGTERM')
    const remainingCleanup = deadline > 0 ? Math.max(0, deadline - Date.now()) : 10_000
    const gracefulBudget = Math.min(10_000, remainingCleanup)
    graceful =
      gracefulBudget > 0
        ? await Promise.race([closed.then(() => true), sleep(gracefulBudget).then(() => false)])
        : false
    if (!graceful && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      if (deadline <= 0) {
        await closed
      } else if (Date.now() < deadline) {
        await Promise.race([closed, sleep(Math.max(1, deadline - Date.now()))])
      }
    }
  }
  return {
    log_sha256: processState.hash.digest('hex'),
    log_bytes: processState.bytes(),
    forced: !graceful,
  }
}

async function apiContext(baseURL, capability) {
  return await playwrightRequest.newContext({
    baseURL,
    extraHTTPHeaders: capability
      ? { Authorization: `Bearer ${capability}`, Accept: 'application/json' }
      : { Accept: 'application/json' },
  })
}

export async function apiJSON(api, method, pathname, options = {}) {
  const signal = phaseSignal(options.signal)
  assertPhaseActive(signal)
  let timeout = options.timeout ?? REQUEST_TIMEOUT_MS
  if (activePhaseDeadline > 0) {
    timeout = boundedRequestTimeout(timeout, activePhaseDeadline)
  }
  let response
  try {
    response = await waitForAbortable(
      api.fetch(pathname, {
        method,
        data: options.data,
        multipart: options.multipart,
        headers: options.headers,
        timeout,
        failOnStatusCode: false,
      }),
      signal,
    )
  } catch {
    if (signal?.aborted) throw new PhasePending('PHASE_WALL_CLOCK_PENDING')
    if (activePhaseDeadline > 0 && Date.now() >= activePhaseDeadline - PHASE_CLEANUP_RESERVE_MS) {
      throw new PhasePending('PHASE_BUDGET_PENDING')
    }
    throw new HarnessError(options.code ?? 'PUBLIC_API_REQUEST_FAILED')
  }
  const raw = await response.text()
  const expected = options.status ?? 200
  if (response.status() !== expected) {
    const error = new HarnessError(options.code ?? 'PUBLIC_API_STATUS_INVALID')
    error.diagnostic_sha256 = sha256Text(raw)
    throw error
  }
  if (options.parse === false) return { status: response.status() }
  try {
    return JSON.parse(raw)
  } catch {
    throw new HarnessError(options.code ?? 'PUBLIC_API_JSON_INVALID')
  }
}

async function waitForSidecar(runtime, processState, deadline) {
  const anonymous = await apiContext(runtime.baseURL)
  try {
    const until = Math.min(deadline - PHASE_CLEANUP_RESERVE_MS, Date.now() + START_TIMEOUT_MS)
    while (Date.now() < until) {
      if (processState.spawnFailed) throw new HarnessError('SIDECAR_SPAWN_FAILED')
      if (processState.child.exitCode !== null || processState.child.signalCode !== null) {
        throw new HarnessError('SIDECAR_EXITED_BEFORE_READY')
      }
      try {
        await apiJSON(anonymous, 'GET', '/api/v1/version', {
          timeout: 2_000,
          code: 'SIDECAR_NOT_READY',
        })
        return
      } catch (error) {
        if (safeCode(error) !== 'SIDECAR_NOT_READY') throw error
      }
      await waitForAbortable(sleep(200), activePhaseSignal)
    }
    throw new HarnessError('SIDECAR_START_TIMEOUT')
  } finally {
    await anonymous.dispose()
  }
}

async function withSidecar(paths, state, env, deadline, operation) {
  const runtime = runtimeFromState(paths, state, env)
  const capability = randomBytes(32).toString('hex')
  const signal = activePhaseSignal
  const processState = startSidecar(runtime, capability, signal)
  let api
  let abortDisposal
  const disposeOnAbort = () => {
    if (api) abortDisposal = api.dispose().catch(() => {})
  }
  if (signal) signal.addEventListener('abort', disposeOnAbort, { once: true })
  try {
    await waitForSidecar(runtime, processState, deadline)
    api = await apiContext(runtime.baseURL, capability)
    const result = await operation(api, runtime, processState.child.pid)
    return result
  } finally {
    if (signal) signal.removeEventListener('abort', disposeOnAbort)
    if (abortDisposal) await abortDisposal
    else if (api) await api.dispose()
    state.last_process_log = await stopSidecar(processState, deadline)
  }
}

function assertPreparedProjection(llm, embeddingStatus, embeddingPolicy, helperReceipt) {
  const providers = object(llm?.providers, 'LLM_PROJECTION_INVALID')
  const providerNames = Object.keys(providers).sort()
  const expectedProviderNames = [EXPECTED_PROVIDER, helperReceipt.embedding_provider].sort()
  if (
    canonicalJSON(providerNames) !== canonicalJSON(expectedProviderNames) ||
    llm.default !== EXPECTED_PROVIDER ||
    llm.reasoning_provider !== EXPECTED_PROVIDER ||
    llm.reasoning_model !== EXPECTED_MODEL ||
    providers[EXPECTED_PROVIDER]?.model !== EXPECTED_MODEL ||
    canonicalJSON(providers[EXPECTED_PROVIDER]?.models) !== canonicalJSON([EXPECTED_MODEL]) ||
    embeddingStatus?.enabled !== true ||
    embeddingStatus?.configured !== true ||
    embeddingStatus?.ready !== true ||
    embeddingStatus?.provider !== helperReceipt.embedding_provider ||
    embeddingStatus?.model !== 'qwen3-embedding:8b'
  ) {
    throw new HarnessError('REAL_ROUTE_PROJECTION_INVALID')
  }
  const profiles = array(embeddingPolicy?.available_profiles, 'EMBEDDING_POLICY_INVALID')
  const matching = profiles.filter(
    (profile) =>
      profile?.model_name === 'qwen3-embedding:8b' &&
      profile?.dimension === 4096 &&
      profile?.capability === 'embedding' &&
      profile?.location === 'local' &&
      profile?.availability === 'installed',
  )
  if (matching.length !== 1) throw new HarnessError('EMBEDDING_PROFILE_NOT_EXACT')
  return {
    provider: EXPECTED_PROVIDER,
    model: EXPECTED_MODEL,
    fallback_allowed: false,
    embedding_provider: helperReceipt.embedding_provider,
    embedding_model: 'qwen3-embedding:8b',
    embedding_dimension: 4096,
    embedding_profile_id: nonEmpty(matching[0].profile_id, 'EMBEDDING_PROFILE_NOT_EXACT'),
    embedding_provider_id: nonEmpty(matching[0].provider_id, 'EMBEDDING_PROFILE_NOT_EXACT'),
    embedding_profile_hash: helperReceipt.embedding_profile_hash,
  }
}

async function registerAgent(api, agent) {
  await apiJSON(api, 'POST', '/api/v1/agents', {
    data: {
      name: agent.name,
      display_name: `${agent.child_name}的辅导助手`,
      description: `${agent.grade_term}数学辅导助手`,
      provider: EXPECTED_PROVIDER,
      model: EXPECTED_MODEL,
      system_prompt: 'Use the confirmed textbook and provide progressive K12 guidance.',
      skills: [],
      reasoning_policy: { mode: 'effort', effort: 'low' },
      metadata: {
        scenario: 'k12-tutor',
        'k12.learner_id': agent.name,
        'k12.child_name': agent.child_name,
        'k12.grade_term': agent.grade_term,
      },
    },
    code: 'AGENT_REGISTER_FAILED',
  })
}

async function preparePhase(paths, contract, env, deadline) {
  if (!paths.runRoot) throw new HarnessError('RUN_DIRECTORY_REQUIRED')
  try {
    const existing = await loadState(paths.runRoot)
    return {
      status: 'already_prepared',
      phase: 'prepare',
      run_id_sha256: sha256Text(existing.run_id),
      route: existing.route,
    }
  } catch (error) {
    if (safeCode(error) !== 'RUN_STATE_UNAVAILABLE') throw error
  }

  await prepareRunDirectory(paths.runRoot)
  await requireRegularFile(paths.ownerConfig, 'OWNER_CONFIG_UNAVAILABLE', { privateFile: true })
  const sidecar = join(paths.runRoot, 'bin', 'hexclaw')
  const helper = join(paths.runRoot, 'bin', 'k12-textbook-profile-fixture')
  const store = join(paths.runRoot, 'data.db')
  const targetConfig = join(paths.runRoot, '.hexclaw', 'hexclaw.yaml')
  await createPrivateFile(store)
  const environment = toolEnvironment(env, paths.runRoot)
  await runCommand(
    paths.goBinary,
    ['build', '-trimpath', '-o', sidecar, './cmd/hexclaw'],
    {
      cwd: paths.sourceRoot,
      env: environment,
      timeout: remaining(deadline, 8 * 60_000, 'SIDECAR_BUILD_PENDING'),
    },
    'SIDECAR_BUILD_FAILED',
  )
  await runCommand(
    paths.goBinary,
    ['build', '-trimpath', '-o', helper, PROFILE_FIXTURE_PATH],
    {
      cwd: paths.sourceRoot,
      env: environment,
      timeout: remaining(deadline, 4 * 60_000, 'PROFILE_FIXTURE_BUILD_PENDING'),
    },
    'PROFILE_FIXTURE_BUILD_FAILED',
  )
  const port = await reservePort()
  const prepared = await runCommand(
    helper,
    [
      '--source-config',
      paths.ownerConfig,
      '--target-config',
      targetConfig,
      '--store',
      store,
      '--profile',
      paths.runRoot,
      '--port',
      String(port),
    ],
    {
      cwd: paths.sourceRoot,
      env: environment,
      timeout: remaining(deadline, 60_000, 'PROFILE_PREPARE_PENDING'),
    },
    'PROFILE_PREPARE_FAILED',
  )
  let helperReceipt
  try {
    helperReceipt = JSON.parse(prepared.stdout)
  } catch {
    throw new HarnessError('PROFILE_PREPARE_RECEIPT_INVALID')
  }
  if (
    helperReceipt?.status !== 'prepared' ||
    helperReceipt?.provider !== EXPECTED_PROVIDER ||
    helperReceipt?.model !== EXPECTED_MODEL ||
    helperReceipt?.embedding_model !== 'qwen3-embedding:8b' ||
    helperReceipt?.embedding_protocol !== 'ollama_embeddings' ||
    helperReceipt?.embedding_dimension !== 4096 ||
    !SHA256.test(helperReceipt?.embedding_profile_hash ?? '') ||
    helperReceipt?.dingtalk_enabled !== false ||
    helperReceipt?.direct_database_touched !== false
  ) {
    throw new HarnessError('PROFILE_PREPARE_RECEIPT_INVALID')
  }
  const state = {
    schema_version: 1,
    run_id: `textbook-${randomUUID()}`,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    route: {
      provider: EXPECTED_PROVIDER,
      model: EXPECTED_MODEL,
      fallback_allowed: false,
      embedding_provider: helperReceipt.embedding_provider,
      embedding_model: helperReceipt.embedding_model,
      embedding_profile_hash: helperReceipt.embedding_profile_hash,
    },
    runtime: {
      config: relative(paths.runRoot, targetConfig),
      store: relative(paths.runRoot, store),
      sidecar: relative(paths.runRoot, sidecar),
      helper: relative(paths.runRoot, helper),
      port,
    },
    agents: {
      text: contract.agents.text,
      scan: contract.agents.scan,
    },
    documents: {},
    searches: {},
    bindings: {},
    grading: {},
  }
  await withSidecar(paths, state, env, deadline, async (api) => {
    await registerAgent(api, contract.agents.text)
    await registerAgent(api, contract.agents.scan)
    const [llm, embeddingStatus, embeddingPolicy] = await Promise.all([
      apiJSON(api, 'GET', '/api/v1/config/llm', { code: 'LLM_PROJECTION_FAILED' }),
      apiJSON(api, 'GET', '/api/v1/knowledge/embedding-status', {
        code: 'EMBEDDING_STATUS_FAILED',
      }),
      apiJSON(api, 'GET', '/api/v1/knowledge/corpora/default/embedding-policy', {
        code: 'EMBEDDING_POLICY_FAILED',
      }),
    ])
    state.route = assertPreparedProjection(llm, embeddingStatus, embeddingPolicy, helperReceipt)
  })
  await saveState(paths.runRoot, state)
  return {
    status: 'prepared',
    phase: 'prepare',
    run_id_sha256: sha256Text(state.run_id),
    route: state.route,
    sidecar_sha256: await sha256File(sidecar, activePhaseSignal),
    helper_sha256: await sha256File(helper, activePhaseSignal),
    sidecar_stopped: true,
    dingtalk_enabled: false,
  }
}

function documentKey(kind) {
  if (!['text', 'scan'].includes(kind)) throw new HarnessError('DOCUMENT_KIND_INVALID')
  return kind
}

async function assertNoForgedPrebinding(api, agentName) {
  const progressPath = `/api/k12/curriculum-progress?agent=${encodeURIComponent(
    agentName,
  )}&subject=math`
  const before = await apiJSON(api, 'GET', progressPath, {
    code: 'FORGED_IDENTITY_PROGRESS_FAILED',
  })
  if (before?.progress !== null || before?.revision !== 0) {
    throw new HarnessError('FORGED_IDENTITY_PRECONDITION_INVALID')
  }
  const marker = Buffer.from(`identity-negative-${randomUUID()}\n`, 'utf8')
  const accepted = await apiJSON(api, 'POST', '/api/v1/knowledge/documents', {
    status: 202,
    headers: { 'Idempotency-Key': `identity-negative-${randomUUID()}` },
    multipart: {
      corpus_id: 'default',
      agent_id: agentName,
      learner_id: agentName,
      subject: 'math',
      grade: '五年级下',
      file: { name: 'identity-negative.txt', mimeType: 'text/plain', buffer: marker },
    },
    code: 'FORGED_IDENTITY_UPLOAD_FAILED',
  })
  const documentID = nonEmpty(accepted?.document_id, 'FORGED_IDENTITY_UPLOAD_INVALID')
  const projection = await apiJSON(
    api,
    'GET',
    `/api/v1/knowledge/documents/${encodeURIComponent(documentID)}`,
    { code: 'FORGED_IDENTITY_PROJECTION_FAILED' },
  )
  if (
    projection?.document_id !== documentID ||
    projection?.corpus_id !== 'default' ||
    !nonEmpty(projection?.owner_id, 'FORGED_IDENTITY_PROJECTION_FAILED')
  ) {
    throw new HarnessError('FORGED_IDENTITY_OWNER_SCOPE_DRIFT')
  }
  const after = await apiJSON(api, 'GET', progressPath, {
    code: 'FORGED_IDENTITY_PROGRESS_FAILED',
  })
  if (after?.progress !== null || after?.revision !== 0) {
    throw new HarnessError('FORGED_IDENTITY_PREBOUND')
  }
  await apiJSON(api, 'DELETE', `/api/v1/knowledge/documents/${encodeURIComponent(documentID)}`, {
    parse: false,
    status: 200,
    code: 'FORGED_IDENTITY_CLEANUP_FAILED',
  })
  return {
    forged_metadata_not_binding_authority: true,
    authenticated_owner_via_capability: true,
    prebound_progress_revision: 0,
    publicly_deleted: true,
  }
}

async function uploadDocumentPhase(paths, contract, env, deadline, kind) {
  const key = documentKey(kind)
  const state = await loadState(paths.runRoot)
  if (state.documents[key]) {
    return {
      status: 'already_uploaded',
      phase: `upload-${key}`,
      document_id_sha256: sha256Text(state.documents[key].document_id),
    }
  }
  const fixture = contract.fixtures[key]
  const pathname = fixturePath(paths, fixture)
  await validateFixture(paths, fixture)
  await withSidecar(paths, state, env, deadline, async (api) => {
    if (key === 'text' && !state.identity_negative) {
      state.identity_negative = await assertNoForgedPrebinding(api, state.agents.text.name)
    }
    const bytes = await readFile(pathname)
    const accepted = await apiJSON(api, 'POST', '/api/v1/knowledge/documents', {
      status: 202,
      headers: { 'Idempotency-Key': `textbook-${key}-${fixture.sha256}` },
      multipart: {
        corpus_id: 'default',
        file: { name: basename(pathname), mimeType: 'application/pdf', buffer: bytes },
      },
      timeout: remaining(deadline, 4 * 60_000, 'DOCUMENT_UPLOAD_PENDING'),
      code: 'DOCUMENT_UPLOAD_FAILED',
    })
    state.documents[key] = {
      document_id: nonEmpty(accepted?.document_id, 'DOCUMENT_UPLOAD_RECEIPT_INVALID'),
      job_id: nonEmpty(accepted?.job_id, 'DOCUMENT_UPLOAD_RECEIPT_INVALID'),
      operation_id: nonEmpty(accepted?.operation_id, 'DOCUMENT_UPLOAD_RECEIPT_INVALID'),
      source_digest: fixture.sha256,
      pages: fixture.pages,
      text_index_state: accepted.text_index_state,
      vector_index_state: accepted.vector_index_state,
    }
  })
  await saveState(paths.runRoot, state)
  return {
    status: 'uploaded',
    phase: `upload-${key}`,
    document_id_sha256: sha256Text(state.documents[key].document_id),
    job_id_sha256: sha256Text(state.documents[key].job_id),
    source_digest: state.documents[key].source_digest,
    identity_negative: key === 'text' ? state.identity_negative : undefined,
    multipart_fields: ['corpus_id', 'file'],
  }
}

function findManifestOption(payload, documentID) {
  return array(payload?.items, 'BINDING_OPTIONS_INVALID').find(
    (item) => item?.document_id === documentID,
  )
}

function projectDocumentProgress(document, job, vectorJob, policy, manifest) {
  return {
    document_generation: document?.document_generation,
    source_digest: document?.source_digest ?? document?.sha256,
    page_count: document?.page_count,
    pages_done: document?.pages_done,
    text_index_state: document?.text_index_state,
    vector_index_state: document?.vector_index_state,
    vector_job_state: document?.vector_job_state,
    warnings_count: Array.isArray(document?.warnings) ? document.warnings.length : 0,
    job_state: job?.state,
    job_stage: job?.stage,
    job_pages_done: job?.pages_done,
    job_pages_total: job?.pages_total,
    job_chunks_done: job?.chunks_done,
    job_chunks_total: job?.chunks_total,
    vector_job_state: vectorJob?.state ?? document?.vector_job_state,
    vector_job_stage: vectorJob?.stage ?? document?.vector_job_stage,
    vector_chunks_done: vectorJob?.chunks_done ?? document?.vector_chunks_done,
    vector_chunks_total: vectorJob?.chunks_total ?? document?.vector_chunks_total,
    active_revision_state: policy?.active_revision?.state,
    active_revision_id_sha256:
      typeof policy?.active_revision?.revision_id === 'string'
        ? sha256Text(policy.active_revision.revision_id)
        : undefined,
    manifest_state: manifest?.state ?? 'not_materialized',
    manifest_id_sha256:
      typeof manifest?.manifest_id === 'string' ? sha256Text(manifest.manifest_id) : undefined,
  }
}

function assertIndexedDocument(
  kind,
  fixture,
  saved,
  document,
  job,
  vectorJob,
  policy,
  manifest,
  route,
) {
  if (
    document?.text_index_state !== 'ready' ||
    document?.vector_index_state !== 'ready' ||
    document?.page_count !== fixture.pages ||
    document?.pages_done !== fixture.pages ||
    (document?.source_digest ?? document?.sha256) !== fixture.sha256 ||
    !Number.isInteger(document?.document_generation) ||
    document.document_generation < 1 ||
    document?.document_id !== saved.document_id ||
    job?.job_id !== saved.job_id ||
    job?.document_id !== saved.document_id ||
    job?.kind !== 'ingest' ||
    job?.state !== 'succeeded' ||
    job?.stage !== 'text_indexing' ||
    job?.pages_done !== fixture.pages ||
    job?.pages_total !== fixture.pages ||
    !Number.isInteger(job?.chunks_done) ||
    job.chunks_done <= 0 ||
    job.chunks_done !== job?.chunks_total ||
    !Number.isInteger(document?.chunks_done) ||
    document.chunks_done <= 0 ||
    document.chunks_done !== document?.chunks_total ||
    manifest?.state !== 'ready_for_confirmation' ||
    manifest?.text_index_state !== 'ready' ||
    manifest?.vector_index_state !== 'ready' ||
    !manifest?.catalog
  ) {
    throw new HarnessError('DOCUMENT_NOT_READY')
  }
  const activeRevision = assertActiveEmbeddingRevision(policy, document, vectorJob, {
    provider_id: route.embedding_provider_id,
    provider_name: route.embedding_provider,
    profile_id: route.embedding_profile_id,
    model: 'qwen3-embedding:8b',
    dimension: 4096,
  })
  let ocr = []
  if (kind === 'scan') {
    const documentReceipts = assertRealOCRReceipts(document.ocr_page_route_receipts, fixture)
    const jobReceipts = assertRealOCRReceipts(job.ocr_page_route_receipts, fixture)
    try {
      assertExactSet(documentReceipts, jobReceipts, 'OCR_PUBLIC_EXACT_SET_DRIFT')
    } catch {
      throw new HarnessError('OCR_PUBLIC_EXACT_SET_DRIFT')
    }
    ocr = documentReceipts
  }
  return {
    ocr,
    active_revision: activeRevision,
    ingest_job: {
      job_id: job.job_id,
      document_id: job.document_id,
      kind: job.kind,
      state: job.state,
      stage: job.stage,
      pages_done: job.pages_done,
      pages_total: job.pages_total,
      chunks_done: job.chunks_done,
      chunks_total: job.chunks_total,
    },
    vector_job: {
      job_id: vectorJob.job_id,
      document_id: vectorJob.document_id,
      target_revision_id: vectorJob.target_revision_id,
      kind: vectorJob.kind,
      state: vectorJob.state,
      stage: vectorJob.stage,
      chunks_done: vectorJob.chunks_done,
      chunks_total: vectorJob.chunks_total,
    },
  }
}

async function advanceDocumentPhase(paths, contract, env, deadline, kind) {
  const key = documentKey(kind)
  const state = await loadState(paths.runRoot)
  const saved = state.documents[key]
  if (!saved) throw new HarnessError('DOCUMENT_UPLOAD_REQUIRED')
  let last = {}
  await withSidecar(paths, state, env, deadline, async (api) => {
    while (Date.now() < deadline - PHASE_CLEANUP_RESERVE_MS) {
      const document = await apiJSON(
        api,
        'GET',
        `/api/v1/knowledge/documents/${encodeURIComponent(saved.document_id)}`,
        { code: 'DOCUMENT_PROJECTION_FAILED' },
      )
      const job = await apiJSON(
        api,
        'GET',
        `/api/v1/knowledge/jobs/${encodeURIComponent(saved.job_id)}`,
        { code: 'DOCUMENT_JOB_PROJECTION_FAILED' },
      )
      const [options, policy] = await Promise.all([
        apiJSON(
          api,
          'GET',
          `/api/k12/textbook-binding-options?agent=${encodeURIComponent(
            state.agents[key].name,
          )}&subject=math`,
          { code: 'BINDING_OPTIONS_FAILED' },
        ),
        apiJSON(api, 'GET', '/api/v1/knowledge/corpora/default/embedding-policy', {
          code: 'EMBEDDING_POLICY_PROJECTION_FAILED',
        }),
      ])
      const vectorJob = document?.vector_job_id
        ? await apiJSON(
            api,
            'GET',
            `/api/v1/knowledge/jobs/${encodeURIComponent(document.vector_job_id)}`,
            { code: 'VECTOR_JOB_PROJECTION_FAILED' },
          )
        : undefined
      const manifest = findManifestOption(options, saved.document_id)
      last = projectDocumentProgress(document, job, vectorJob, policy, manifest)
      try {
        const proof = assertIndexedDocument(
          key,
          contract.fixtures[key],
          saved,
          document,
          job,
          vectorJob,
          policy,
          manifest,
          state.route,
        )
        saved.document_generation = document.document_generation
        saved.text_index_state = document.text_index_state
        saved.vector_index_state = document.vector_index_state
        saved.chunks_done = document.chunks_done
        saved.chunks_total = document.chunks_total
        saved.job_state = job.state
        saved.ingest_job = proof.ingest_job
        saved.vector_job = proof.vector_job
        saved.active_revision = proof.active_revision
        saved.manifest = {
          manifest_id: manifest.manifest_id,
          document_generation: manifest.document_generation,
          state: manifest.state,
          catalog: manifest.catalog,
        }
        saved.ocr_receipts = proof.ocr
        state.route.query_profile_config_hash = proof.active_revision.profile_config_hash
        for (const candidate of Object.values(state.documents)) {
          if (candidate?.active_revision?.revision_id === proof.active_revision.revision_id) {
            candidate.active_revision = proof.active_revision
          }
        }
        return
      } catch (error) {
        if (safeCode(error) !== 'DOCUMENT_NOT_READY') throw error
      }
      if (document?.text_index_state === 'failed' || document?.vector_index_state === 'failed') {
        throw new HarnessError('DOCUMENT_INDEX_FAILED')
      }
      await waitForAbortable(sleep(2_000), activePhaseSignal)
    }
    throw new PhasePending('DOCUMENT_ADVANCE_PENDING', last)
  })
  await saveState(paths.runRoot, state)
  return {
    status: 'ready',
    phase: `advance-${key}`,
    document_id_sha256: sha256Text(saved.document_id),
    generation: saved.document_generation,
    source_digest: saved.source_digest,
    pages: saved.pages,
    warnings_tolerated: contract.fixtures[key].allow_nonfatal_warnings === true,
    real_ocr_receipts: saved.ocr_receipts?.length ?? 0,
    manifest_id_sha256: sha256Text(saved.manifest.manifest_id),
  }
}

function assertQueryReceipt(receipts, query, state, expectedRevisionID) {
  const wantedDigest = `sha256:${sha256Text(query)}`
  const matches = array(receipts, 'QUERY_RECEIPTS_REQUIRED').filter(
    (receipt) => receipt?.query_digest === wantedDigest,
  )
  if (matches.length !== 1) throw new HarnessError('ORIGINAL_QUERY_RECEIPT_NOT_EXACT')
  const receipt = matches[0]
  if (
    receipt.operation !== 'query_embedding' ||
    receipt.status !== 'succeeded' ||
    receipt.provider_id !== state.route.embedding_provider_id ||
    receipt.model !== 'qwen3-embedding:8b' ||
    receipt.dimension !== 4096 ||
    !nonEmpty(receipt.provider_id, 'QUERY_RECEIPT_INVALID') ||
    !nonEmpty(receipt.profile_id, 'QUERY_RECEIPT_INVALID') ||
    !SHA256.test(receipt.profile_config_hash ?? '') ||
    !nonEmpty(receipt.revision_id, 'QUERY_RECEIPT_INVALID') ||
    (expectedRevisionID && receipt.revision_id !== expectedRevisionID)
  ) {
    throw new HarnessError('QUERY_RECEIPT_INVALID')
  }
  if (state.route.embedding_profile_id && receipt.profile_id !== state.route.embedding_profile_id) {
    throw new HarnessError('QUERY_EMBEDDING_PROFILE_DRIFT')
  }
  if (
    state.route.query_profile_config_hash &&
    receipt.profile_config_hash !== state.route.query_profile_config_hash
  ) {
    throw new HarnessError('QUERY_EMBEDDING_CONFIG_DRIFT')
  }
  state.route.query_profile_config_hash = receipt.profile_config_hash
  return {
    operation: receipt.operation,
    status: receipt.status,
    provider_id: receipt.provider_id,
    model: receipt.model,
    profile_id: receipt.profile_id,
    profile_config_hash: receipt.profile_config_hash,
    dimension: receipt.dimension,
    revision_id: receipt.revision_id,
    query_digest: receipt.query_digest,
  }
}

function projectSearchHit(hit, saved, receipt) {
  if (
    hit?.doc_id !== saved.document_id ||
    hit?.document_generation !== saved.document_generation ||
    hit?.revision_id !== receipt.revision_id ||
    !nonEmpty(hit?.chunk_id, 'SEARCH_HIT_INVALID') ||
    !SHA256.test(hit?.source_digest ?? '') ||
    hit.source_digest !== saved.source_digest ||
    !SHA256.test(hit?.citation_digest ?? '') ||
    !Number.isInteger(hit?.source_offset_start) ||
    !Number.isInteger(hit?.source_offset_end) ||
    hit.source_offset_end <= hit.source_offset_start ||
    !Number.isInteger(hit?.page_start) ||
    !Number.isInteger(hit?.page_end) ||
    hit.page_start < 1 ||
    hit.page_end < hit.page_start ||
    hit.page_end > saved.pages
  ) {
    throw new HarnessError('SEARCH_HIT_INVALID')
  }
  return {
    doc_id: hit.doc_id,
    document_generation: hit.document_generation,
    revision_id: hit.revision_id,
    chunk_id: hit.chunk_id,
    page_start: hit.page_start,
    page_end: hit.page_end,
    source_digest: hit.source_digest,
    citation_digest: hit.citation_digest,
    source_offset_start: hit.source_offset_start,
    source_offset_end: hit.source_offset_end,
    source: hit.source,
  }
}

export function retrievalRequestForOracle(oracle, expectedPageMatch = 'exact-set') {
  const projected = projectScanRetrievalOracle(
    oracle,
    Number.MAX_SAFE_INTEGER,
    expectedPageMatch,
  )
  return { query: projected.query, top_k: projected.top_k }
}

export function assertOracleSearchExactSet(
  results,
  oracle,
  saved,
  receipt,
  expectedPageMatch = 'exact-set',
) {
  const projectedOracle = projectScanRetrievalOracle(oracle, saved?.pages, expectedPageMatch)
  const source = array(results, 'SEARCH_RESULTS_INVALID')
  if (source.length > projectedOracle.top_k) {
    throw new HarnessError('ORACLE_PHYSICAL_PAGE_EXACT_SET_INVALID')
  }
  const hits = source.map((hit) => projectSearchHit(hit, saved, receipt))
  const actualPages = new Set()
  for (const hit of hits) {
    for (let page = hit.page_start; page <= hit.page_end; page += 1) actualPages.add(page)
  }
  const pages = [...actualPages].sort((left, right) => left - right)
  const pageMatch =
    expectedPageMatch === 'contains'
      ? projectedOracle.expected_physical_pages.every((page) => actualPages.has(page))
      : canonicalJSON(pages) === canonicalJSON(projectedOracle.expected_physical_pages)
  if (!pageMatch) {
    throw new HarnessError('ORACLE_PHYSICAL_PAGE_EXACT_SET_INVALID')
  }
  return hits
}

async function retrieveDocumentPhase(paths, contract, env, deadline, kind) {
  const key = documentKey(kind)
  const state = await loadState(paths.runRoot)
  const saved = state.documents[key]
  if (!saved?.manifest || !saved?.active_revision || saved.vector_index_state !== 'ready') {
    throw new HarnessError('DOCUMENT_READY_REQUIRED')
  }
  const observed = []
  await withSidecar(paths, state, env, deadline, async (api) => {
    for (const oracle of contract.fixtures[key].oracles) {
      const expectedPageMatch = key === 'scan' ? 'exact-set' : 'contains'
      const request = retrievalRequestForOracle(oracle, expectedPageMatch)
      const payload = await apiJSON(api, 'POST', '/api/v1/knowledge/search', {
        data: request,
        timeout: remaining(deadline, 3 * 60_000, 'SEARCH_PENDING'),
        code: 'KNOWLEDGE_SEARCH_FAILED',
      })
      const receipt = assertQueryReceipt(
        payload?.query_receipts,
        oracle.query,
        state,
        saved.active_revision.revision_id,
      )
      const hits = assertOracleSearchExactSet(
        payload?.results,
        oracle,
        saved,
        receipt,
        expectedPageMatch,
      )
      if (hits.length === 0) throw new HarnessError('ORACLE_PHYSICAL_PAGE_NOT_RETRIEVED')
      observed.push({ physical_page: oracle.physical_page, query_receipt: receipt, hits })
    }
  })
  const sources = [
    ...new Set(observed.flatMap((oracle) => oracle.hits.map((hit) => hit.source).filter(Boolean))),
  ]
  if (sources.length !== 1) throw new HarnessError('DOCUMENT_SOURCE_NOT_EXACT')
  state.searches[key] = {
    manifest_id: saved.manifest.manifest_id,
    document_id: saved.document_id,
    document_generation: saved.document_generation,
    source_digest: saved.source_digest,
    source: sources[0],
    oracles: observed,
  }
  await saveState(paths.runRoot, state)
  return {
    status: 'retrieved',
    phase: `retrieve-${key}`,
    document_id_sha256: sha256Text(saved.document_id),
    source_digest: saved.source_digest,
    physical_pages: observed.map((item) => item.physical_page).sort((a, b) => a - b),
    query_receipts: observed.map((item) => ({
      model: item.query_receipt.model,
      profile_id: item.query_receipt.profile_id,
      profile_config_hash: item.query_receipt.profile_config_hash,
      revision_id: item.query_receipt.revision_id,
      query_digest: item.query_receipt.query_digest,
      hit_count: item.hits.length,
    })),
    real_ocr_receipts: saved.ocr_receipts?.length ?? 0,
  }
}

function catalogObject(raw) {
  if (typeof raw === 'string') {
    try {
      return object(JSON.parse(raw), 'TEXTBOOK_CATALOG_INVALID')
    } catch {
      throw new HarnessError('TEXTBOOK_CATALOG_INVALID')
    }
  }
  return object(raw, 'TEXTBOOK_CATALOG_INVALID')
}

function projectBoundCatalog(raw, agent, binding) {
  const value = catalogObject(raw)
  const subject = nonEmpty(value.subject, 'CURRICULUM_CATALOG_INVALID')
  const pageMin = positiveInteger(value.page_min, 'CURRICULUM_CATALOG_INVALID')
  const pageMax = positiveInteger(value.page_max, 'CURRICULUM_CATALOG_INVALID')
  const units = array(value.units, 'CURRICULUM_CATALOG_INVALID')
  if (subject !== 'math' || pageMax < pageMin || units.length === 0) {
    throw new HarnessError('CURRICULUM_CATALOG_INVALID')
  }
  return {
    agent: agent.name,
    subject,
    textbook_binding_id: binding.binding_id,
    textbook_edition: nonEmpty(value.textbook_edition, 'CURRICULUM_CATALOG_INVALID'),
    textbook_version: nonEmpty(value.textbook_version, 'CURRICULUM_CATALOG_INVALID'),
    title: nonEmpty(value.title, 'CURRICULUM_CATALOG_INVALID'),
    volume: nonEmpty(value.volume, 'CURRICULUM_CATALOG_INVALID'),
    page_min: pageMin,
    page_max: pageMax,
    units,
  }
}

function chooseCatalogProgress(catalog, preferredPage) {
  const value = catalogObject(catalog)
  const units = array(value.units, 'TEXTBOOK_CATALOG_UNITS_INVALID')
  if (units.length === 0) throw new HarnessError('TEXTBOOK_CATALOG_UNITS_INVALID')
  const unit =
    units.find(
      (candidate) =>
        Number.isInteger(candidate?.page_from) &&
        Number.isInteger(candidate?.page_to) &&
        candidate.page_from <= preferredPage &&
        candidate.page_to >= preferredPage,
    ) ?? units[0]
  const lessons = Array.isArray(unit.lessons) ? unit.lessons : []
  const lesson =
    lessons.find(
      (candidate) => candidate?.page_from <= preferredPage && candidate?.page_to >= preferredPage,
    ) ?? lessons[0]
  const pageFrom = lesson?.page_from ?? unit.page_from
  const pageTo = lesson?.page_to ?? unit.page_to
  return {
    unit_id: nonEmpty(unit.unit_id, 'TEXTBOOK_CATALOG_UNIT_INVALID'),
    lesson_id:
      typeof lesson?.lesson_id === 'string' && lesson.lesson_id.trim() !== ''
        ? lesson.lesson_id.trim()
        : undefined,
    page_from: positiveInteger(pageFrom, 'TEXTBOOK_CATALOG_PAGE_INVALID'),
    page_to: positiveInteger(pageTo, 'TEXTBOOK_CATALOG_PAGE_INVALID'),
  }
}

function profileBundleRequest(agent, saved, preferredPage) {
  const progress = chooseCatalogProgress(saved.manifest.catalog, preferredPage)
  return {
    agent: agent.name,
    idempotency_key: `textbook-binding-${saved.manifest.manifest_id}`,
    expected_profile_revision: 0,
    expected_progress_revision: 0,
    expected_settings_revision: 0,
    agent_config: {
      display_name: `${agent.child_name}的辅导助手`,
      description: `${agent.grade_term}数学辅导助手`,
      system_prompt: 'Use the confirmed textbook and provide progressive K12 guidance.',
      provider: EXPECTED_PROVIDER,
      model: EXPECTED_MODEL,
      skills: [],
    },
    profile: {
      child_name: agent.child_name,
      grade_term: agent.grade_term,
      subject_textbooks: {
        math: agent.edition,
        chinese: '统编版',
        english: '外研版',
        science: '教科版',
        information_technology: '浙教版',
        art: '人美版',
      },
    },
    curriculum_progress: {
      subject: 'math',
      textbook_manifest_id: saved.manifest.manifest_id,
      volume: agent.volume,
      unit_id: progress.unit_id,
      ...(progress.lesson_id ? { lesson_id: progress.lesson_id } : {}),
      page_from: progress.page_from,
      page_to: progress.page_to,
      evidence_source: 'parent_confirmed',
    },
    weekly_practice_settings: {
      timezone: 'Asia/Shanghai',
      textbook_consolidation_enabled: true,
      textbook_consolidation_tier: 'standard',
      arithmetic_warmup_enabled: false,
      arithmetic_minutes: 2,
    },
  }
}

function assertBindingProjection(payload, agent, saved) {
  const progress = object(payload?.curriculum_progress, 'PROFILE_BUNDLE_PROGRESS_INVALID')
  if (
    progress.agent !== agent.name ||
    progress.subject !== 'math' ||
    progress.textbook_manifest_id !== saved.manifest.manifest_id ||
    !nonEmpty(progress.textbook_binding_id, 'PROFILE_BUNDLE_BINDING_INVALID') ||
    !Number.isInteger(progress.revision) ||
    progress.revision < 1
  ) {
    throw new HarnessError('PROFILE_BUNDLE_BINDING_INVALID')
  }
  return {
    binding_id: progress.textbook_binding_id,
    manifest_id: progress.textbook_manifest_id,
    document_id: saved.document_id,
    document_generation: saved.document_generation,
    source_digest: saved.source_digest,
    revision: progress.revision,
  }
}

function projectCurriculumProgress(progress, agent, binding) {
  const value = object(progress, 'CURRICULUM_PROGRESS_INVALID')
  const segmentRefs = array(value.segment_refs, 'CURRICULUM_PROGRESS_INVALID').map((segment) =>
    nonEmpty(segment, 'CURRICULUM_PROGRESS_INVALID'),
  )
  if (
    value.agent !== agent.name ||
    value.subject !== 'math' ||
    value.revision !== binding.revision ||
    value.textbook_binding_id !== binding.binding_id ||
    value.textbook_manifest_id !== binding.manifest_id ||
    segmentRefs.length === 0 ||
    new Set(segmentRefs).size !== segmentRefs.length
  ) {
    throw new HarnessError('CURRICULUM_PROGRESS_BINDING_DRIFT')
  }
  return {
    agent: value.agent,
    subject: value.subject,
    revision: value.revision,
    textbook_binding_id: value.textbook_binding_id,
    textbook_manifest_id: value.textbook_manifest_id,
    textbook_edition: nonEmpty(value.textbook_edition, 'CURRICULUM_PROGRESS_INVALID'),
    textbook_version: nonEmpty(value.textbook_version, 'CURRICULUM_PROGRESS_INVALID'),
    title: nonEmpty(value.title, 'CURRICULUM_PROGRESS_INVALID'),
    volume: nonEmpty(value.volume, 'CURRICULUM_PROGRESS_INVALID'),
    unit_id: nonEmpty(value.unit_id, 'CURRICULUM_PROGRESS_INVALID'),
    unit_title: nonEmpty(value.unit_title, 'CURRICULUM_PROGRESS_INVALID'),
    lesson_id: value.lesson_id ?? '',
    lesson_title: value.lesson_title ?? '',
    requested_page_from: value.requested_page_from ?? null,
    requested_page_to: value.requested_page_to ?? null,
    verified_page_from: value.verified_page_from ?? null,
    verified_page_to: value.verified_page_to ?? null,
    page_verification_status: nonEmpty(
      value.page_verification_status,
      'CURRICULUM_PROGRESS_INVALID',
    ),
    segment_refs: [...segmentRefs].sort(),
    evidence_source: nonEmpty(value.evidence_source, 'CURRICULUM_PROGRESS_INVALID'),
  }
}

async function bindPhase(paths, contract, env, deadline) {
  const state = await loadState(paths.runRoot)
  for (const kind of ['text', 'scan']) {
    if (!state.searches[kind]) throw new HarnessError('DOCUMENT_RETRIEVAL_REQUIRED')
  }
  await withSidecar(paths, state, env, deadline, async (api) => {
    for (const kind of ['text', 'scan']) {
      if (state.bindings[kind]) continue
      const agent = state.agents[kind]
      const saved = state.documents[kind]
      const preferredPage = contract.fixtures[kind].oracles[0].physical_page
      const response = await apiJSON(api, 'PUT', '/api/k12/profile-bundle', {
        data: profileBundleRequest(agent, saved, preferredPage),
        code: 'PROFILE_BUNDLE_FAILED',
      })
      state.bindings[kind] = assertBindingProjection(response, agent, saved)
      const persisted = await apiJSON(
        api,
        'GET',
        `/api/k12/curriculum-progress?agent=${encodeURIComponent(agent.name)}&subject=math`,
        { code: 'CURRICULUM_PROGRESS_FAILED' },
      )
      const progress = object(persisted?.progress, 'CURRICULUM_PROGRESS_INVALID')
      state.bindings[kind].progress = projectCurriculumProgress(
        progress,
        agent,
        state.bindings[kind],
      )
      const catalog = await apiJSON(
        api,
        'GET',
        `/api/k12/curriculum-catalog?agent=${encodeURIComponent(agent.name)}&subject=math`,
        { code: 'CURRICULUM_CATALOG_FAILED' },
      )
      const expectedCatalog = projectBoundCatalog(
        saved.manifest.catalog,
        agent,
        state.bindings[kind],
      )
      try {
        assert.deepEqual(catalog, expectedCatalog)
      } catch {
        throw new HarnessError('CURRICULUM_CATALOG_BINDING_DRIFT')
      }
      state.bindings[kind].catalog_digest = sha256Text(canonicalJSON(expectedCatalog))
    }
  })
  await saveState(paths.runRoot, state)
  return {
    status: 'bound',
    phase: 'bind',
    bindings: Object.fromEntries(
      Object.entries(state.bindings).map(([kind, binding]) => [
        kind,
        {
          binding_id_sha256: sha256Text(binding.binding_id),
          manifest_id_sha256: sha256Text(binding.manifest_id),
          document_id_sha256: sha256Text(binding.document_id),
          generation: binding.document_generation,
          source_digest: binding.source_digest,
        },
      ]),
    ),
  }
}

function imageTaskURL(dispatchID, agentName, suffix = '') {
  return `/api/k12/image-tasks/${encodeURIComponent(dispatchID)}${suffix}?agent=${encodeURIComponent(
    agentName,
  )}`
}

function projectFinalArtifact(artifact, agentName) {
  const value = object(artifact, 'FINAL_ARTIFACT_REQUIRED')
  const summaryInvocationID = nonEmpty(
    value.summary_invocation_id,
    'FINAL_ARTIFACT_SUMMARY_INVOCATION_REQUIRED',
  )
  if (
    !nonEmpty(value.artifact_id, 'FINAL_ARTIFACT_INVALID') ||
    value.agent_name !== agentName ||
    !nonEmpty(value.job_id, 'FINAL_ARTIFACT_INVALID') ||
    value.structure_version < 1 ||
    !['complete', 'with_skips'].includes(value.coverage_status) ||
    !Number.isInteger(value.total_count) ||
    value.total_count < 1 ||
    !Number.isInteger(value.published_count) ||
    !Number.isInteger(value.skipped_count) ||
    value.published_count + value.skipped_count !== value.total_count ||
    !SHA256.test(value.artifact_digest ?? '')
  ) {
    throw new HarnessError('FINAL_ARTIFACT_INVALID')
  }
  return {
    artifact_id: value.artifact_id,
    job_id: value.job_id,
    structure_version: value.structure_version,
    coverage_status: value.coverage_status,
    total_count: value.total_count,
    published_count: value.published_count,
    skipped_count: value.skipped_count,
    artifact_digest: value.artifact_digest,
    summary_invocation_id: summaryInvocationID,
  }
}

function projectSummaryInvocationReceipt(receipts, summaryInvocationID) {
  const matching = array(receipts, 'IMAGE_TASK_OPERATION_RECEIPTS_REQUIRED').filter(
    (receipt) => receipt?.invocation_id === summaryInvocationID,
  )
  if (matching.length !== 1) {
    throw new HarnessError('FINAL_ARTIFACT_SUMMARY_RECEIPT_NOT_EXACT')
  }
  const receipt = matching[0]
  if (
    receipt?.operation !== 'projecting' ||
    receipt?.provider !== EXPECTED_PROVIDER ||
    receipt?.model !== EXPECTED_MODEL ||
    !['succeeded', 'reconciled'].includes(receipt?.status) ||
    ![SHA256, PREFIXED_SHA256].some((pattern) => pattern.test(receipt?.result_digest ?? ''))
  ) {
    throw new HarnessError('FINAL_ARTIFACT_SUMMARY_RECEIPT_INVALID')
  }
  return {
    invocation_id: summaryInvocationID,
    operation: receipt.operation,
    provider: receipt.provider,
    model: receipt.model,
    status: receipt.status,
    result_digest: receipt.result_digest,
  }
}

export function assertArtifactReceiptBinding(artifact, agentName, operationReceipts) {
  const projectedArtifact = projectFinalArtifact(artifact, agentName)
  const summaryReceipt = projectSummaryInvocationReceipt(
    operationReceipts,
    projectedArtifact.summary_invocation_id,
  )
  return { artifact: projectedArtifact, summary_receipt: summaryReceipt }
}

export function projectImageTaskReceipts(result) {
  const receipts = array(result?.operation_receipts, 'IMAGE_TASK_OPERATION_RECEIPTS_REQUIRED')
  if (receipts.length === 0) throw new HarnessError('IMAGE_TASK_OPERATION_RECEIPTS_REQUIRED')
  const projected = []
  for (const receipt of receipts) {
    const terminalStatus = ['succeeded', 'reconciled', 'failed', 'outcome_unknown'].includes(
      receipt?.status,
    )
    const successfulResult = ['succeeded', 'reconciled'].includes(receipt?.status)
    const validResultDigest = [SHA256, PREFIXED_SHA256].some((pattern) =>
      pattern.test(receipt?.result_digest ?? ''),
    )
    if (
      receipt?.provider !== EXPECTED_PROVIDER ||
      receipt?.model !== EXPECTED_MODEL ||
      !terminalStatus ||
      !nonEmpty(receipt?.operation, 'IMAGE_TASK_OPERATION_RECEIPT_INVALID') ||
      !nonEmpty(receipt?.invocation_id, 'IMAGE_TASK_OPERATION_RECEIPT_INVALID') ||
      (successfulResult && !validResultDigest) ||
      (!successfulResult && receipt?.result_digest && !validResultDigest)
    ) {
      throw new HarnessError('IMAGE_TASK_OPERATION_RECEIPT_INVALID')
    }
    projected.push({
      operation: receipt.operation,
      provider: receipt.provider,
      model: receipt.model,
      status: receipt.status,
      invocation_id_sha256: sha256Text(receipt.invocation_id),
      result_digest: receipt.result_digest,
    })
  }
  return projected.sort((left, right) => canonicalJSON(left).localeCompare(canonicalJSON(right)))
}

function recognizedKnowledgePoints(dispatch) {
  const target = object(dispatch?.target_projection, 'HOMEWORK_TARGET_PROJECTION_REQUIRED')
  if (target.kind !== 'homework') throw new HarnessError('HOMEWORK_TARGET_PROJECTION_REQUIRED')
  const questions = array(target?.recognition?.questions, 'HOMEWORK_RECOGNITION_REQUIRED')
  if (questions.length === 0) throw new HarnessError('HOMEWORK_RECOGNITION_REQUIRED')
  const concepts = [
    ...new Set(
      questions.flatMap((question) =>
        array(question?.knowledge_points, 'HOMEWORK_KNOWLEDGE_POINTS_REQUIRED')
          .map((value) => (typeof value === 'string' ? value.trim() : ''))
          .filter(Boolean),
      ),
    ),
  ]
  if (concepts.length === 0) throw new HarnessError('HOMEWORK_KNOWLEDGE_POINTS_REQUIRED')
  return { target, questions, concepts }
}

function groundingQueryMap(state, concepts) {
  const catalog = catalogObject(state.documents.text.manifest.catalog)
  const edition = nonEmpty(catalog.textbook_edition, 'TEXTBOOK_CATALOG_EDITION_REQUIRED')
  const volume = nonEmpty(catalog.volume, 'TEXTBOOK_CATALOG_VOLUME_REQUIRED')
  const grade = nonEmpty(state.agents.text.grade_term, 'TEXTBOOK_GRADE_REQUIRED')
  const output = new Map()
  for (const concept of concepts) {
    const value = [edition, volume, grade, concept, '教材讲法'].filter(Boolean).join(' ')
    output.set(`sha256:${sha256Text(value)}`, value)
  }
  return output
}

function verifiedCatalogPages(state) {
  const catalog = catalogObject(state.documents.text.manifest.catalog)
  const pages = array(catalog.page_refs, 'TEXTBOOK_CATALOG_PAGE_REFS_REQUIRED').map((page) => ({
    logical_page: positiveInteger(page?.logical_page, 'TEXTBOOK_CATALOG_PAGE_REF_INVALID'),
    pdf_page: positiveInteger(page?.pdf_page, 'TEXTBOOK_CATALOG_PAGE_REF_INVALID'),
    segment_refs: array(page?.segment_refs, 'TEXTBOOK_CATALOG_PAGE_REF_INVALID').map((segment) =>
      nonEmpty(segment, 'TEXTBOOK_CATALOG_PAGE_REF_INVALID'),
    ),
  }))
  if (pages.length === 0 || pages.some((page) => page.segment_refs.length === 0)) {
    throw new HarnessError('TEXTBOOK_CATALOG_PAGE_REFS_REQUIRED')
  }
  return pages
}

async function independentlyObserveGrounding(api, state, receipts, concepts, deadline) {
  const targetReceipts = array(receipts, 'GROUNDING_RECEIPTS_REQUIRED')
  if (targetReceipts.length === 0) throw new HarnessError('GROUNDING_RECEIPTS_REQUIRED')
  const queries = groundingQueryMap(state, concepts)
  const pages = verifiedCatalogPages(state)
  const allowedSegments = new Set(pages.flatMap((page) => page.segment_refs))
  const wantedDigests = [...new Set(targetReceipts.map((receipt) => receipt?.query_digest))].sort()
  const envelopes = []
  for (const queryDigest of wantedDigests) {
    const query = queries.get(queryDigest)
    if (!query) throw new HarnessError('GROUNDING_QUERY_NOT_DERIVABLE')
    const payload = await apiJSON(api, 'POST', '/api/v1/knowledge/search', {
      data: {
        query,
        top_k: 50,
        sources: [state.searches.text.source],
      },
      timeout: remaining(deadline, 3 * 60_000, 'GROUNDING_SEARCH_PENDING'),
      code: 'GROUNDING_PUBLIC_SEARCH_FAILED',
    })
    const queryReceipt = assertQueryReceipt(
      payload?.query_receipts,
      query,
      state,
      state.documents.text.active_revision.revision_id,
    )
    const hits = array(payload?.results, 'GROUNDING_PUBLIC_RESULTS_INVALID')
      .filter(
        (hit) =>
          hit?.doc_id === state.documents.text.document_id &&
          hit?.document_generation === state.documents.text.document_generation &&
          hit?.revision_id === queryReceipt.revision_id &&
          allowedSegments.has(hit?.chunk_id),
      )
      .slice(0, 3)
    for (const hit of hits) {
      const mappedPages = pages.filter((page) => page.segment_refs.includes(hit.chunk_id))
      if (mappedPages.length === 0) throw new HarnessError('GROUNDING_PAGE_MAP_REQUIRED')
      const physicalPages = mappedPages.map((page) => page.pdf_page)
      if (
        hit.page_start !== Math.min(...physicalPages) ||
        hit.page_end !== Math.max(...physicalPages) ||
        hit.source_digest !== state.documents.text.source_digest ||
        !SHA256.test(hit.citation_digest ?? '')
      ) {
        throw new HarnessError('GROUNDING_PUBLIC_HIT_INVALID')
      }
      for (const page of mappedPages) {
        envelopes.push({
          binding_id: state.bindings.text.binding_id,
          manifest_id: state.documents.text.manifest.manifest_id,
          logical_page: page.logical_page,
          pdf_page: page.pdf_page,
          query_receipt: queryReceipt,
          hit,
        })
      }
    }
  }
  return assertGroundingExactSet(targetReceipts, envelopes)
}

function assertGroundingCopies(targetReceipts, resultReceipts) {
  let target
  let result
  try {
    target = array(targetReceipts, 'GROUNDING_RECEIPTS_REQUIRED').map(groundingKeyFromReceipt)
    result = array(resultReceipts, 'GROUNDING_RESULT_RECEIPTS_REQUIRED').map(
      groundingKeyFromReceipt,
    )
    assertExactSet(target, result, 'GROUNDING_PUBLIC_PROJECTION_DRIFT')
  } catch {
    throw new HarnessError('GROUNDING_PUBLIC_PROJECTION_DRIFT')
  }
  return target.sort((left, right) => canonicalJSON(left).localeCompare(canonicalJSON(right)))
}

function closureSnapshot(state, gradingClosure) {
  return {
    documents: ['text', 'scan'].map((kind) => ({
      kind,
      document_id: state.documents[kind].document_id,
      document_generation: state.documents[kind].document_generation,
      source_digest: state.documents[kind].source_digest,
      pages_done: state.documents[kind].pages,
      pages_total: state.documents[kind].pages,
      chunks_done: state.documents[kind].chunks_done,
      chunks_total: state.documents[kind].chunks_total,
      text_index_state: state.documents[kind].text_index_state,
      vector_index_state: state.documents[kind].vector_index_state,
      manifest_id: state.documents[kind].manifest.manifest_id,
      catalog_digest: sha256Text(
        canonicalJSON(catalogObject(state.documents[kind].manifest.catalog)),
      ),
    })),
    ingest_jobs: ['text', 'scan'].map((kind) => ({
      kind,
      ...state.documents[kind].ingest_job,
    })),
    vector_jobs: ['text', 'scan'].map((kind) => ({
      kind,
      ...state.documents[kind].vector_job,
    })),
    active_revision: ['text', 'scan'].map((kind) => ({
      kind,
      ...state.documents[kind].active_revision,
    })),
    ocr_receipts: [...(state.documents.scan.ocr_receipts || [])].sort((left, right) =>
      canonicalJSON(left).localeCompare(canonicalJSON(right)),
    ),
    textbook_bindings: ['text', 'scan'].map((kind) => ({
      kind,
      binding_id: state.bindings[kind].binding_id,
      manifest_id: state.bindings[kind].manifest_id,
      document_id: state.bindings[kind].document_id,
      document_generation: state.bindings[kind].document_generation,
      source_digest: state.bindings[kind].source_digest,
      catalog_digest: state.bindings[kind].catalog_digest,
    })),
    curriculum_progress: ['text', 'scan'].map((kind) => ({
      kind,
      ...state.bindings[kind].progress,
    })),
    final_artifact: gradingClosure.final_artifact,
    operation_receipts: gradingClosure.operation_receipts,
    grounding_evidence_receipts: gradingClosure.grounding,
    problem_grounding_receipts: gradingClosure.problem_grounding_receipts,
  }
}

function safeImageTaskProgress(dispatch) {
  return {
    dispatch_id_sha256:
      typeof dispatch?.dispatch_id === 'string' ? sha256Text(dispatch.dispatch_id) : undefined,
    status: dispatch?.status,
    task_intent: dispatch?.task_intent,
    version: dispatch?.version,
    operation: dispatch?.progress?.operation,
    state: dispatch?.progress?.state,
    target_kind: dispatch?.target_projection?.kind,
    target_stage: dispatch?.target_projection?.stage,
    confirmation_state: dispatch?.target_projection?.confirmation_state,
    recognized_questions: Array.isArray(dispatch?.target_projection?.recognition?.questions)
      ? dispatch.target_projection.recognition.questions.length
      : 0,
  }
}

function assertHomeworkSourceResult(result, fixture, dispatchSourceDigest) {
  if (
    result?.task_intent !== 'completed_homework' ||
    result?.status !== 'routed' ||
    result?.source_digest !== dispatchSourceDigest
  ) {
    throw new HarnessError('IMAGE_TASK_RESULT_IDENTITY_INVALID')
  }
  const attachments = array(result?.source_attachments, 'IMAGE_TASK_SOURCE_RECEIPT_REQUIRED')
  if (
    attachments.length !== 1 ||
    attachments[0]?.digest !== `sha256:${fixture.sha256}` ||
    attachments[0]?.size_bytes !== fixture.size_bytes
  ) {
    throw new HarnessError('IMAGE_TASK_SOURCE_RECEIPT_INVALID')
  }
  return {
    digest: attachments[0].digest,
    size_bytes: attachments[0].size_bytes,
    dispatch_digest: dispatchSourceDigest,
  }
}

async function observeCompletedGrading(api, state, contract, dispatch, deadline, options = {}) {
  if (
    dispatch?.status !== 'routed' ||
    dispatch?.task_intent !== 'completed_homework' ||
    dispatch?.model_id !== EXPECTED_MODEL
  ) {
    throw new HarnessError('COMPLETED_IMAGE_TASK_IDENTITY_INVALID')
  }
  const { target, questions, concepts } = recognizedKnowledgePoints(dispatch)
  if (
    target.stage !== 'completed' ||
    target.confirmation_state !== 'confirmed' ||
    target.progressive?.coverage?.status !== 'complete'
  ) {
    throw new HarnessError('COMPLETED_HOMEWORK_PROJECTION_INVALID')
  }
  const result = await apiJSON(
    api,
    'GET',
    imageTaskURL(state.grading.dispatch_id, state.agents.text.name, '/result'),
    { code: 'IMAGE_TASK_RESULT_FAILED' },
  )
  if (result?.dispatch_id !== state.grading.dispatch_id) {
    throw new HarnessError('IMAGE_TASK_RESULT_IDENTITY_INVALID')
  }
  const sourceAttachment = assertHomeworkSourceResult(
    result,
    contract.fixtures.homework,
    state.grading.asset.dispatch_source_digest,
  )
  const artifactBinding = assertArtifactReceiptBinding(
    target.final_artifact,
    state.agents.text.name,
    result.operation_receipts,
  )
  const artifact = artifactBinding.artifact
  const operationReceipts = projectImageTaskReceipts(result)
  const projectedGrounding = assertGroundingCopies(
    target.grounding_evidence_receipts,
    result.grounding_evidence_receipts,
  )
  const problemGrounding = assertProblemGroundingExactSet(
    questions.map((question) => nonEmpty(question?.problem_id, 'HOMEWORK_PROBLEM_ID_REQUIRED')),
    target.progressive.problem_progress,
    target.problem_grounding_receipts,
    result.problem_grounding_receipts,
  )
  const grounding = await resolveGroundingForClosure(
    options.groundingMode ?? 'grade',
    projectedGrounding,
    async () => {
      const observed = await independentlyObserveGrounding(
        api,
        state,
        target.grounding_evidence_receipts,
        concepts,
        deadline,
      )
      try {
        assert.deepEqual(observed, projectedGrounding)
      } catch {
        throw new HarnessError('GROUNDING_FINAL_ARTIFACT_PROJECTION_DRIFT')
      }
      return observed
    },
  )
  return {
    dispatch_id: state.grading.dispatch_id,
    task_intent: dispatch.task_intent,
    source_attachment: sourceAttachment,
    final_artifact: artifact,
    summary_receipt: artifactBinding.summary_receipt,
    grounding,
    problem_grounding_receipts: problemGrounding,
    operation_receipts: operationReceipts,
    knowledge_point_digests: concepts.map(sha256Text).sort(),
  }
}

async function uploadHomeworkAsset(api, state, paths, contract, deadline) {
  const fixture = contract.fixtures.homework
  const pathname = fixturePath(paths, fixture)
  await validateFixture(paths, fixture, false)
  const bytes = await readFile(pathname)
  const uploaded = await apiJSON(
    api,
    'POST',
    `/api/k12/assets?agent=${encodeURIComponent(state.agents.text.name)}`,
    {
      multipart: {
        file: { name: basename(pathname), mimeType: 'image/png', buffer: bytes },
      },
      timeout: remaining(deadline, 3 * 60_000, 'HOMEWORK_ASSET_UPLOAD_PENDING'),
      code: 'HOMEWORK_ASSET_UPLOAD_FAILED',
    },
  )
  if (
    !nonEmpty(uploaded?.asset_id, 'HOMEWORK_ASSET_UPLOAD_INVALID') ||
    uploaded.size !== fixture.size_bytes
  ) {
    throw new HarnessError('HOMEWORK_ASSET_UPLOAD_INVALID')
  }
  return {
    asset_id: uploaded.asset_id,
    size_bytes: uploaded.size,
    attachment_digest: `sha256:${fixture.sha256}`,
    dispatch_source_digest: imageTaskSourceDigest([bytes]),
  }
}

async function createHomeworkImageTask(api, state) {
  const sourceSession = `textbook-grounding-${state.run_id}`
  const created = await apiJSON(api, 'POST', '/api/k12/image-tasks', {
    data: {
      agent: state.agents.text.name,
      source_session: sourceSession,
      source_kind: 'api',
      source_ref: `homework-${state.run_id}`,
      source_asset_refs: [state.grading.asset.asset_id],
      message_intent: '这是一张已经完成并写有答案的数学作业，请逐题批改并依据已绑定教材讲解。',
      attempt_generation: 1,
      route_request: {
        provider: EXPECTED_PROVIDER,
        model: EXPECTED_MODEL,
        selection_source: 'explicit',
      },
    },
    code: 'IMAGE_TASK_CREATE_FAILED',
  })
  const dispatch = object(created?.dispatch, 'IMAGE_TASK_CREATE_INVALID')
  return {
    dispatch_id: nonEmpty(dispatch.dispatch_id, 'IMAGE_TASK_CREATE_INVALID'),
    source_session: sourceSession,
    initial_version: positiveInteger(dispatch.version, 'IMAGE_TASK_CREATE_INVALID'),
  }
}

async function confirmImageTaskIntent(api, state, dispatch) {
  const confirmed = await apiJSON(
    api,
    'POST',
    `/api/k12/image-tasks/${encodeURIComponent(state.grading.dispatch_id)}/confirm`,
    {
      data: {
        agent: state.agents.text.name,
        version: dispatch.version,
        intent: 'completed_homework',
      },
      code: 'IMAGE_TASK_INTENT_CONFIRM_FAILED',
    },
  )
  return object(confirmed?.dispatch, 'IMAGE_TASK_INTENT_CONFIRM_INVALID')
}

async function confirmHomeworkRecognition(api, state, dispatch) {
  const { questions } = recognizedKnowledgePoints(dispatch)
  const corrections = questions.map((question, index) => ({
    index,
    problem_id: nonEmpty(question?.problem_id, 'HOMEWORK_PROBLEM_ID_REQUIRED'),
    confirmed: true,
  }))
  const confirmed = await apiJSON(
    api,
    'POST',
    `/api/k12/image-tasks/${encodeURIComponent(state.grading.dispatch_id)}/confirm`,
    {
      data: {
        agent: state.agents.text.name,
        version: dispatch.version,
        homework: {
          subject: '数学',
          grade: state.agents.text.grade_term,
          question_corrections: corrections,
        },
      },
      code: 'HOMEWORK_RECOGNITION_CONFIRM_FAILED',
    },
  )
  object(confirmed?.dispatch, 'HOMEWORK_RECOGNITION_CONFIRM_INVALID')
  return { question_count: corrections.length }
}

async function gradePhase(paths, contract, env, deadline) {
  const state = await loadState(paths.runRoot)
  if (!state.bindings.text || !state.bindings.scan) throw new HarnessError('BINDING_REQUIRED')
  state.grading = state.grading || {}
  if (state.grading.closure) {
    return {
      status: 'already_completed',
      phase: 'grade',
      dispatch_id_sha256: sha256Text(state.grading.dispatch_id),
      artifact_id_sha256: sha256Text(state.grading.closure.final_artifact.artifact_id),
      artifact_digest: state.grading.closure.final_artifact.artifact_digest,
      summary_invocation_id_sha256: sha256Text(
        state.grading.closure.final_artifact.summary_invocation_id,
      ),
      grounding_receipts: state.grading.closure.grounding.length,
    }
  }
  let last = {}
  await withSidecar(paths, state, env, deadline, async (api, _runtime, processID) => {
    state.grading.sidecar_pid = processID
    if (!state.grading.asset) {
      state.grading.asset = await uploadHomeworkAsset(api, state, paths, contract, deadline)
      await saveState(paths.runRoot, state)
    }
    if (!state.grading.dispatch_id) {
      Object.assign(state.grading, await createHomeworkImageTask(api, state))
      await saveState(paths.runRoot, state)
    }
    let observedState = ''
    while (Date.now() < deadline - PHASE_CLEANUP_RESERVE_MS) {
      let projection = await apiJSON(
        api,
        'GET',
        imageTaskURL(state.grading.dispatch_id, state.agents.text.name),
        { code: 'IMAGE_TASK_PROJECTION_FAILED' },
      )
      let dispatch = object(projection?.dispatch, 'IMAGE_TASK_PROJECTION_INVALID')
      last = safeImageTaskProgress(dispatch)
      const stateKey = canonicalJSON(last)
      if (stateKey !== observedState) {
        observedState = stateKey
        state.grading.last_progress = last
        await saveState(paths.runRoot, state)
      }
      if (dispatch.status === 'failed') throw new HarnessError('IMAGE_TASK_FAILED')
      if (dispatch.status === 'cancelled') throw new HarnessError('IMAGE_TASK_CANCELLED')
      if (dispatch.status === 'awaiting_confirmation') {
        dispatch = await confirmImageTaskIntent(api, state, dispatch)
        state.grading.intent_confirmed = true
        await saveState(paths.runRoot, state)
        continue
      }
      if (
        dispatch.target_projection?.kind === 'homework' &&
        dispatch.target_projection?.stage === 'awaiting_confirmation' &&
        dispatch.target_projection?.confirmation_state === 'pending'
      ) {
        state.grading.recognition_confirmation = await confirmHomeworkRecognition(
          api,
          state,
          dispatch,
        )
        await saveState(paths.runRoot, state)
        continue
      }
      if (
        dispatch.target_projection?.kind === 'homework' &&
        dispatch.target_projection?.stage === 'completed'
      ) {
        state.grading.closure = await observeCompletedGrading(
          api,
          state,
          contract,
          dispatch,
          deadline,
        )
        state.grading.restart_baseline = closureSnapshot(state, state.grading.closure)
        await saveState(paths.runRoot, state)
        return
      }
      await waitForAbortable(sleep(2_000), activePhaseSignal)
    }
    throw new PhasePending('IMAGE_TASK_GRADE_PENDING', last)
  })
  await saveState(paths.runRoot, state)
  return {
    status: 'completed',
    phase: 'grade',
    dispatch_id_sha256: sha256Text(state.grading.dispatch_id),
    source_digest: state.grading.closure.source_attachment.digest,
    artifact_id_sha256: sha256Text(state.grading.closure.final_artifact.artifact_id),
    artifact_digest: state.grading.closure.final_artifact.artifact_digest,
    summary_invocation_id_sha256: sha256Text(
      state.grading.closure.final_artifact.summary_invocation_id,
    ),
    grounding_receipts: state.grading.closure.grounding.length,
    operation_receipts: state.grading.closure.operation_receipts,
    sidecar_stopped: true,
  }
}

async function observeRestartDocument(api, state, contract, kind) {
  const saved = state.documents[kind]
  const [document, job, options, policy] = await Promise.all([
    apiJSON(api, 'GET', `/api/v1/knowledge/documents/${encodeURIComponent(saved.document_id)}`, {
      code: 'RESTART_DOCUMENT_PROJECTION_FAILED',
    }),
    apiJSON(api, 'GET', `/api/v1/knowledge/jobs/${encodeURIComponent(saved.job_id)}`, {
      code: 'RESTART_DOCUMENT_JOB_FAILED',
    }),
    apiJSON(
      api,
      'GET',
      `/api/k12/textbook-binding-options?agent=${encodeURIComponent(
        state.agents[kind].name,
      )}&subject=math`,
      { code: 'RESTART_BINDING_OPTIONS_FAILED' },
    ),
    apiJSON(api, 'GET', '/api/v1/knowledge/corpora/default/embedding-policy', {
      code: 'RESTART_EMBEDDING_POLICY_FAILED',
    }),
  ])
  const vectorJobID = nonEmpty(document?.vector_job_id, 'RESTART_VECTOR_JOB_REQUIRED')
  const vectorJob = await apiJSON(
    api,
    'GET',
    `/api/v1/knowledge/jobs/${encodeURIComponent(vectorJobID)}`,
    { code: 'RESTART_VECTOR_JOB_FAILED' },
  )
  const manifest = findManifestOption(options, saved.document_id)
  const proof = assertIndexedDocument(
    kind,
    contract.fixtures[kind],
    saved,
    document,
    job,
    vectorJob,
    policy,
    manifest,
    state.route,
  )
  if (
    document.document_generation !== saved.document_generation ||
    document.chunks_done !== saved.chunks_done ||
    document.chunks_total !== saved.chunks_total ||
    manifest?.manifest_id !== saved.manifest.manifest_id ||
    manifest?.document_generation !== saved.manifest.document_generation ||
    canonicalJSON(catalogObject(manifest?.catalog)) !==
      canonicalJSON(catalogObject(saved.manifest.catalog))
  ) {
    throw new HarnessError('RESTART_DOCUMENT_IDENTITY_DRIFT')
  }
  try {
    assert.deepEqual(proof.ingest_job, saved.ingest_job)
    assert.deepEqual(proof.vector_job, saved.vector_job)
    assert.deepEqual(proof.active_revision, saved.active_revision)
  } catch {
    throw new HarnessError('RESTART_DOCUMENT_JOB_DRIFT')
  }
  if (kind === 'scan') {
    try {
      assertExactSet(proof.ocr, saved.ocr_receipts, 'RESTART_OCR_DRIFT')
    } catch {
      throw new HarnessError('RESTART_OCR_DRIFT')
    }
  }
}

async function observeRestartBinding(api, state, kind) {
  const agent = state.agents[kind]
  const binding = state.bindings[kind]
  const [progressPayload, catalog] = await Promise.all([
    apiJSON(
      api,
      'GET',
      `/api/k12/curriculum-progress?agent=${encodeURIComponent(agent.name)}&subject=math`,
      { code: 'RESTART_CURRICULUM_PROGRESS_FAILED' },
    ),
    apiJSON(
      api,
      'GET',
      `/api/k12/curriculum-catalog?agent=${encodeURIComponent(agent.name)}&subject=math`,
      { code: 'RESTART_CURRICULUM_CATALOG_FAILED' },
    ),
  ])
  const progress = object(progressPayload?.progress, 'RESTART_CURRICULUM_PROGRESS_INVALID')
  const projectedProgress = projectCurriculumProgress(progress, agent, binding)
  const expectedCatalog = projectBoundCatalog(
    state.documents[kind].manifest.catalog,
    agent,
    binding,
  )
  if (
    progress.textbook_binding_id !== binding.binding_id ||
    progress.textbook_manifest_id !== binding.manifest_id ||
    catalog?.textbook_binding_id !== binding.binding_id ||
    canonicalJSON(catalog) !== canonicalJSON(expectedCatalog) ||
    sha256Text(canonicalJSON(catalog)) !== binding.catalog_digest
  ) {
    throw new HarnessError('RESTART_BINDING_DRIFT')
  }
  try {
    assert.deepEqual(projectedProgress, binding.progress)
  } catch {
    throw new HarnessError('RESTART_CURRICULUM_PROGRESS_DRIFT')
  }
}

function assertRestartRoute(llm, embeddingStatus, state) {
  const providers = object(llm?.providers, 'RESTART_LLM_PROJECTION_INVALID')
  if (
    canonicalJSON(Object.keys(providers).sort()) !==
      canonicalJSON([EXPECTED_PROVIDER, state.route.embedding_provider].sort()) ||
    llm.default !== EXPECTED_PROVIDER ||
    llm.reasoning_provider !== EXPECTED_PROVIDER ||
    llm.reasoning_model !== EXPECTED_MODEL ||
    providers[EXPECTED_PROVIDER]?.model !== EXPECTED_MODEL ||
    canonicalJSON(providers[EXPECTED_PROVIDER]?.models) !== canonicalJSON([EXPECTED_MODEL]) ||
    embeddingStatus?.ready !== true ||
    embeddingStatus?.provider !== state.route.embedding_provider ||
    embeddingStatus?.model !== 'qwen3-embedding:8b'
  ) {
    throw new HarnessError('RESTART_ROUTE_DRIFT')
  }
}

async function restartPhase(paths, contract, env, deadline) {
  const state = await loadState(paths.runRoot)
  if (!state.grading?.restart_baseline || !state.grading?.dispatch_id) {
    throw new HarnessError('GRADE_COMPLETION_REQUIRED')
  }
  if (state.grading.restart_verified) {
    return {
      status: 'already_verified',
      phase: 'restart',
      artifact_digest: state.grading.closure.final_artifact.artifact_digest,
      grounding_receipts: state.grading.closure.grounding.length,
    }
  }
  let restartedPID = 0
  await withSidecar(paths, state, env, deadline, async (api, _runtime, processID) => {
    restartedPID = processID
    if (processID === state.grading.sidecar_pid)
      throw new HarnessError('SIDECAR_RESTART_NOT_PROVEN')
    const [llm, embeddingStatus] = await Promise.all([
      apiJSON(api, 'GET', '/api/v1/config/llm', { code: 'RESTART_LLM_PROJECTION_FAILED' }),
      apiJSON(api, 'GET', '/api/v1/knowledge/embedding-status', {
        code: 'RESTART_EMBEDDING_STATUS_FAILED',
      }),
    ])
    assertRestartRoute(llm, embeddingStatus, state)
    for (const kind of ['text', 'scan']) {
      await observeRestartDocument(api, state, contract, kind)
      await observeRestartBinding(api, state, kind)
    }
    const projection = await apiJSON(
      api,
      'GET',
      imageTaskURL(state.grading.dispatch_id, state.agents.text.name),
      { code: 'RESTART_IMAGE_TASK_PROJECTION_FAILED' },
    )
    const dispatch = object(projection?.dispatch, 'RESTART_IMAGE_TASK_PROJECTION_INVALID')
    const grading = await observeCompletedGrading(api, state, contract, dispatch, deadline, {
      groundingMode: 'restart',
    })
    const after = closureSnapshot(state, grading)
    assertRestartInvariant(state.grading.restart_baseline, after)
    state.grading.restart_verified = {
      process_id_sha256: sha256Text(processID),
      verified_at: new Date().toISOString(),
      closure: after,
    }
  })
  await saveState(paths.runRoot, state)
  return {
    status: 'verified',
    phase: 'restart',
    separate_process: restartedPID !== state.grading.sidecar_pid,
    process_id_sha256: sha256Text(restartedPID),
    artifact_id_sha256: sha256Text(state.grading.closure.final_artifact.artifact_id),
    artifact_digest: state.grading.closure.final_artifact.artifact_digest,
    grounding_receipts: state.grading.closure.grounding.length,
    real_ocr_receipts: state.documents.scan.ocr_receipts.length,
    sidecar_stopped: true,
  }
}

async function statusPhase(paths, _contract, env, deadline) {
  const state = await loadState(paths.runRoot)
  const documents = {}
  let imageTask
  await withSidecar(paths, state, env, deadline, async (api) => {
    for (const kind of ['text', 'scan']) {
      const saved = state.documents[kind]
      if (!saved) continue
      const projection = await apiJSON(
        api,
        'GET',
        `/api/v1/knowledge/documents/${encodeURIComponent(saved.document_id)}`,
        { code: 'STATUS_DOCUMENT_FAILED' },
      )
      documents[kind] = {
        document_id_sha256: sha256Text(saved.document_id),
        generation: projection.document_generation,
        text_index_state: projection.text_index_state,
        vector_index_state: projection.vector_index_state,
        pages_done: projection.pages_done,
        pages_total: projection.pages_total,
        ocr_receipts: Array.isArray(projection.ocr_page_route_receipts)
          ? projection.ocr_page_route_receipts.length
          : 0,
      }
    }
    if (state.grading?.dispatch_id) {
      const projection = await apiJSON(
        api,
        'GET',
        imageTaskURL(state.grading.dispatch_id, state.agents.text.name),
        { code: 'STATUS_IMAGE_TASK_FAILED' },
      )
      imageTask = safeImageTaskProgress(projection?.dispatch)
    }
  })
  await saveState(paths.runRoot, state)
  return {
    status: 'observed',
    phase: 'status',
    documents,
    bindings: Object.keys(state.bindings || {}).sort(),
    image_task: imageTask,
    restart_verified: Boolean(state.grading?.restart_verified),
    public_get_only: true,
    sidecar_stopped: true,
  }
}

export async function persistPhaseEvidence(paths, receipt) {
  if (!paths.runRoot) return undefined
  try {
    await requirePrivateRunDirectory(paths.runRoot)
    await requirePrepareMarker(paths.runRoot)
  } catch {
    return undefined
  }
  const evidenceRoot = join(paths.runRoot, 'evidence')
  try {
    await mkdir(evidenceRoot, { mode: PRIVATE_DIRECTORY_MODE })
  } catch (error) {
    if (error?.code !== 'EEXIST') throw new HarnessError('EVIDENCE_DIRECTORY_UNAVAILABLE')
  }
  const evidenceInfo = await lstat(evidenceRoot)
  if (!evidenceInfo.isDirectory() || evidenceInfo.isSymbolicLink()) {
    throw new HarnessError('EVIDENCE_DIRECTORY_UNAVAILABLE')
  }
  await chmod(evidenceRoot, PRIVATE_DIRECTORY_MODE)
  const evidenceFile = `${receipt.phase}.json`
  assertEvidenceSafe(receipt)
  await writePrivateJSON(join(evidenceRoot, evidenceFile), receipt)
  return evidenceFile
}

async function dispatchPhase(phase, env, deadline, signal) {
  activePhaseDeadline = deadline
  activePhaseSignal = signal
  try {
    const validation = await validateStatic(env, deadline, signal)
    if (phase === 'validate') return validation
    if (env.HEXCLAW_TEXTBOOK_GROUNDING_LIVE !== '1') {
      throw new HarnessError('LIVE_GATE_REQUIRED')
    }
    const paths = runtimePaths(env)
    if (!paths.runRoot) throw new HarnessError('RUN_DIRECTORY_REQUIRED')
    const contract = await loadContract()
    switch (phase) {
      case 'prepare':
        return await preparePhase(paths, contract, env, deadline)
      case 'upload-text':
        return await uploadDocumentPhase(paths, contract, env, deadline, 'text')
      case 'advance-text':
        return await advanceDocumentPhase(paths, contract, env, deadline, 'text')
      case 'retrieve-text':
        return await retrieveDocumentPhase(paths, contract, env, deadline, 'text')
      case 'upload-scan':
        return await uploadDocumentPhase(paths, contract, env, deadline, 'scan')
      case 'advance-scan':
        return await advanceDocumentPhase(paths, contract, env, deadline, 'scan')
      case 'retrieve-scan':
        return await retrieveDocumentPhase(paths, contract, env, deadline, 'scan')
      case 'bind':
        return await bindPhase(paths, contract, env, deadline)
      case 'grade':
        return await gradePhase(paths, contract, env, deadline)
      case 'restart':
        return await restartPhase(paths, contract, env, deadline)
      case 'status':
        return await statusPhase(paths, contract, env, deadline)
      default:
        throw new HarnessError('INVALID_PHASE')
    }
  } finally {
    activePhaseDeadline = 0
    activePhaseSignal = undefined
  }
}

async function main() {
  let phase = 'validate'
  let paths
  try {
    phase = resolvePhase(process.argv.slice(2))
    if (phase === 'help') {
      process.stdout.write(`${usageText()}\n`)
      return
    }
    paths = runtimePaths(process.env)
    const hardTimeout = phaseBudgetMilliseconds(process.env)
    const complete = await withPhaseWallClock(hardTimeout, async ({ deadline, signal }) => {
      const receipt = await dispatchPhase(phase, process.env, deadline, signal)
      const result = {
        ...receipt,
        hard_timeout_ms: hardTimeout,
        automatic_continuation: false,
      }
      assertEvidenceSafe(result)
      if (phase !== 'validate') {
        result.evidence_file = await persistPhaseEvidence(paths, result)
      }
      return result
    })
    process.stdout.write(`${JSON.stringify(complete)}\n`)
  } catch (error) {
    const pending = error instanceof PhasePending
    const receipt = {
      status: pending ? 'pending' : 'failed',
      phase,
      error_code: safeCode(error),
      ...(pending ? { projection: error.projection } : {}),
      ...(SHA256.test(error?.diagnostic_sha256 ?? '')
        ? { diagnostic_sha256: error.diagnostic_sha256 }
        : {}),
      hard_timeout_ms: phaseBudgetMilliseconds(process.env),
      automatic_continuation: false,
    }
    assertEvidenceSafe(receipt)
    if (phase !== 'validate' && paths) {
      try {
        receipt.evidence_file = await persistPhaseEvidence(paths, receipt)
      } catch {
        // 失败证据无法安全落盘时，保留原始错误码，避免掩盖根因。
      }
    }
    process.stderr.write(`${JSON.stringify(receipt)}\n`)
    process.exitCode = pending ? PENDING_EXIT_CODE : 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  await main()
}
