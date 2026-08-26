import { request as playwrightRequest } from '@playwright/test'
import { spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, open, readFile, realpath, rename } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const LIVE_ROOT = dirname(fileURLToPath(import.meta.url))
const CONTRACT_PATH = join(LIVE_ROOT, 'k12-creative-dingtalk-image.contract.json')
const DEFAULT_DOCS_ROOT = resolve(LIVE_ROOT, '../../../hexclaw-docs')
const EXPECTED_PROVIDER = 'hexclaw-gpt'
const EXPECTED_MODEL = 'gpt-5.6-sol'
const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
const REQUEST_TIMEOUT_MS = 120_000
const START_TIMEOUT_MS = 30_000
const POLL_INTERVAL_MS = 1_000
const DEFAULT_PHASE_MS = 24 * 60_000
export const HARD_PHASE_MAX_MS = 29 * 60_000
const PREFIXED_SHA256 = /^sha256:[a-f0-9]{64}$/u
const SHA256 = /^[a-f0-9]{64}$/u
const ASSET_ID = /^asset:\/\/([^/]+)\/([a-f0-9]{64})\.(png|jpg|jpeg|gif|webp)$/u
const APPROVED_CREATIVE_H2_ORDER = Object.freeze([
  '可见证据',
  '先这样肯定',
  '家长可以这样问或讲',
  '下一次只试一个点',
])
const APPROVED_CREATIVE_MARKDOWN_POLICY = Object.freeze({
  h2_exact_order: APPROVED_CREATIVE_H2_ORDER,
  body_language: 'zh-CN',
  each_section_contains_han: true,
  parent_question: {
    required: true,
    question_mark_required: true,
    minimum_han_characters: 6,
  },
  next_step: { required: true, minimum_han_characters: 6 },
  limitation: {
    optional: true,
    prefix: '说明：',
    must_follow_sections: true,
    must_be_final: true,
    h2_forbidden: true,
  },
  prohibited_feedback_semantics: ['scoring', 'ranking', 'ghostwriting'],
  forbidden_visible_references: [
    'asset_scheme',
    'file_scheme',
    'blob_scheme',
    'data_scheme',
    'protected_asset_api',
    'posix_absolute_path',
    'windows_absolute_path',
    'internal_asset_id',
  ],
})
const DINGTALK_REFERENCE_BOUNDARY = new Set([...`\"'([{<=:，。；、：`])
const DINGTALK_INTERNAL_ASSET_ID = /(?:^|[^a-f0-9])(?:inline:|sha256:)?[a-f0-9]{64}(?:\.(?:png|jpe?g|gif|webp))?(?=$|[^a-f0-9])/iu

export const PHASES = Object.freeze([
  'validate',
  'prepare',
  'create-art',
  'send-art',
  'create-writing',
  'send-writing',
  'restart',
  'replay',
  'checkpoint',
  'status',
])

export class HarnessError extends Error {
  constructor(code) {
    super(code)
    this.name = 'HarnessError'
    this.code = code
  }
}

export class PhasePending extends HarnessError {
  constructor(code, evidence = {}) {
    super(code)
    this.name = 'PhasePending'
    this.evidence = evidence
  }
}

function safeCode(error) {
  return typeof error?.code === 'string' ? error.code : String(error?.message || 'HARNESS_FAILED')
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
  const normalized = String(value ?? '').trim()
  if (!normalized) throw new HarnessError(code)
  return normalized
}

function positiveInteger(value, code) {
  if (!Number.isInteger(value) || value < 1) throw new HarnessError(code)
  return value
}

export function imageTaskVersion(value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new HarnessError('IMAGE_TASK_VERSION_INVALID')
  }
  return value
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalValue(value[key])]),
  )
}

function canonicalJSON(value) {
  return JSON.stringify(canonicalValue(value))
}

function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex')
}

function sha256Text(value) {
  return sha256Bytes(Buffer.from(String(value), 'utf8'))
}

async function sha256File(pathname) {
  return sha256Bytes(await readFile(pathname))
}

function normalizedDigest(value, code) {
  const digest = nonEmpty(value, code).toLowerCase()
  const raw = digest.startsWith('sha256:') ? digest.slice(7) : digest
  if (!SHA256.test(raw)) throw new HarnessError(code)
  return raw
}

function decodeCanonicalBase64(value, code) {
  const encoded = nonEmpty(value, code)
  let bytes
  try {
    bytes = Buffer.from(encoded, 'base64')
  } catch {
    throw new HarnessError(code)
  }
  if (bytes.length === 0 || bytes.toString('base64') !== encoded) throw new HarnessError(code)
  return bytes
}

function exactKeys(value, expected, code) {
  if (
    canonicalJSON(Object.keys(object(value, code)).sort()) !== canonicalJSON([...expected].sort())
  ) {
    throw new HarnessError(code)
  }
}

export function resolvePhase(args = process.argv.slice(2)) {
  if (args.length === 0) return 'validate'
  if (args.length !== 1 || !PHASES.includes(args[0])) throw new HarnessError('INVALID_PHASE')
  return args[0]
}

export function phaseBudgetMilliseconds(env = process.env) {
  const raw = Number(env.HEXCLAW_CREATIVE_DINGTALK_IMAGE_PHASE_TIMEOUT_MS || DEFAULT_PHASE_MS)
  if (!Number.isFinite(raw) || raw <= 0) throw new HarnessError('INVALID_PHASE_TIMEOUT')
  return Math.min(Math.floor(raw), HARD_PHASE_MAX_MS)
}

function validateFixtureContract(key, value) {
  const fixture = object(value, 'CONTRACT_FIXTURE_INVALID')
  const expected = {
    art: {
      path: 'test/k12-test-美术.png',
      workType: 'art',
      taskIntent: 'artwork',
      digest: '7eb16fdbe398236cdf2ce31ea6d2fac5e4787ea3004b96ab74a3eebd540f1d93',
      size: 2713090,
      width: 1254,
      height: 1254,
    },
    writing: {
      path: 'test/k12-test-作文.png',
      workType: 'writing',
      taskIntent: 'writing',
      digest: '3b238c46e0ae4515f7b35a28bcfd37081ba1d59a9dfa2b30bf17784aaf3e9157',
      size: 2509035,
      width: 1086,
      height: 1448,
    },
  }[key]
  if (
    !expected ||
    fixture.docs_relative_path !== expected.path ||
    fixture.work_type !== expected.workType ||
    fixture.task_intent !== expected.taskIntent ||
    fixture.mime !== 'image/png' ||
    fixture.sha256 !== expected.digest ||
    fixture.size_bytes !== expected.size ||
    fixture.width !== expected.width ||
    fixture.height !== expected.height
  ) {
    throw new HarnessError('CONTRACT_FIXTURE_INVALID')
  }
  return { ...fixture }
}

export function validateContract(contract) {
  const value = object(contract, 'CONTRACT_INVALID')
  if (value.schema_version !== 1 || value.scenario !== 'k12_real_dingtalk_creative_images') {
    throw new HarnessError('CONTRACT_INVALID')
  }
  const route = object(value.route, 'CONTRACT_ROUTE_INVALID')
  if (
    route.provider !== EXPECTED_PROVIDER ||
    route.model !== EXPECTED_MODEL ||
    route.fallback_allowed !== false
  ) {
    throw new HarnessError('CONTRACT_ROUTE_INVALID')
  }
  const transport = object(value.transport, 'CONTRACT_TRANSPORT_INVALID')
  exactKeys(
    transport,
    [
      'product_operations',
      'http_driver',
      'bound_instance_only',
      'dws_cli',
      'direct_dingtalk_http',
      'direct_store_read',
      'sqlite_seed_or_write',
    ],
    'CONTRACT_TRANSPORT_INVALID',
  )
  if (
    transport.product_operations !== 'hexclaw_public_http_api_only' ||
    transport.http_driver !== 'playwright_api_request_context' ||
    transport.bound_instance_only !== true ||
    transport.dws_cli !== false ||
    transport.direct_dingtalk_http !== false ||
    transport.direct_store_read !== false ||
    transport.sqlite_seed_or_write !== false
  ) {
    throw new HarnessError('CONTRACT_TRANSPORT_INVALID')
  }
  const publicAPI = object(value.public_api, 'CONTRACT_PUBLIC_API_INVALID')
  const requiredPaths = {
    version: '/api/v1/version',
    agents: '/api/v1/agents',
    llm_config: '/api/v1/config/llm',
    instances: '/api/v1/platforms/instances',
    asset_upload: '/api/k12/assets?agent={agent_name}',
    asset_get: '/api/k12/assets/{asset_file}?agent={agent_name}',
    image_task_create: '/api/k12/image-tasks',
    image_task_get: '/api/k12/image-tasks/{dispatch_id}?agent={agent_name}',
    image_task_confirm: '/api/k12/image-tasks/{dispatch_id}/confirm',
    creative_work: '/api/k12/creative-works/{work_id}?agent={agent_name}',
    creative_send: '/api/k12/creative-works/{work_id}/send',
    delivery_batch: '/api/k12/delivery-batches/{batch_id}?agent={agent_name}',
    delivery_query: '/api/k12/delivery-batches/{batch_id}/query',
    delivery_retry: '/api/k12/delivery-batches/{batch_id}/retry',
  }
  if (canonicalJSON(publicAPI) !== canonicalJSON(requiredPaths)) {
    throw new HarnessError('CONTRACT_PUBLIC_API_INVALID')
  }
  const fixtures = object(value.fixtures, 'CONTRACT_FIXTURES_INVALID')
  const fixtureKeys = Object.keys(fixtures)
  if (canonicalJSON(fixtureKeys) !== canonicalJSON(['art', 'writing'])) {
    throw new HarnessError('CONTRACT_FIXTURES_INVALID')
  }
  const normalizedFixtures = {
    art: validateFixtureContract('art', fixtures.art),
    writing: validateFixtureContract('writing', fixtures.writing),
  }
  const creative = object(value.creative_entry, 'CONTRACT_CREATIVE_INVALID')
  if (
    creative.kind !== 'new_work' ||
    creative.promotion_policy !== 'explicit_commit' ||
    creative.writing_ocr_must_freeze_before_commit !== true ||
    creative.feedback_terminal_status !== 'succeeded' ||
    creative.source_asset_required !== true ||
    creative.source_asset_public_exact_bytes !== true
  ) {
    throw new HarnessError('CONTRACT_CREATIVE_INVALID')
  }
  const delivery = object(value.delivery, 'CONTRACT_DELIVERY_INVALID')
  if (
    delivery.object_kind !== 'creative_work' ||
    delivery.target_mode !== 'all_effective_bound_physical_targets' ||
    delivery.target_count !== 'all_deduplicated_bound_targets' ||
    canonicalJSON(delivery.physical_target_key) !==
      canonicalJSON(['platform', 'instance_id', 'chat_id']) ||
    delivery.parts_per_target !== 2 ||
    delivery.physical_messages_per_target !== 1 ||
    delivery.initial_product_send_posts_per_work !== 1 ||
    delivery.component_rows_share_external_message_id !== true ||
    delivery.physical_external_message_ids_distinct_across_targets !== true ||
    delivery.external_message_id_required !== true ||
    delivery.terminal_status !== 'delivered'
  ) {
    throw new HarnessError('CONTRACT_DELIVERY_INVALID')
  }
  const parts = array(delivery.parts, 'CONTRACT_DELIVERY_INVALID')
  if (
    parts.length !== 2 ||
    canonicalJSON(parts[0]) !==
      canonicalJSON({ ordinal: 1, kind: 'markdown', mime: '', language: 'zh-CN' }) ||
    canonicalJSON(parts[1]) !==
      canonicalJSON({
        ordinal: 2,
        kind: 'artifact',
        mime: 'image/png',
        artifact: 'frozen_original_source_asset',
      })
  ) {
    throw new HarnessError('CONTRACT_DELIVERY_INVALID')
  }
  const markdownPolicy = object(delivery.markdown_policy, 'CONTRACT_MARKDOWN_POLICY_INVALID')
  if (canonicalJSON(markdownPolicy) !== canonicalJSON(APPROVED_CREATIVE_MARKDOWN_POLICY)) {
    throw new HarnessError('CONTRACT_MARKDOWN_POLICY_INVALID')
  }
  const replay = object(value.frozen_replay, 'CONTRACT_REPLAY_INVALID')
  if (
    replay.replay_lookup_before_source_open !== true ||
    replay.asset_open_failure_rechecks_frozen_batch !== true ||
    replay.restart_action !== 'query_only' ||
    replay.duplicate_product_send_posts_per_work !== 1 ||
    replay.duplicate_send_returns_same_batch !== true ||
    replay.same_delivery_ids !== true ||
    replay.same_external_message_ids !== true ||
    replay.same_attempts !== true ||
    replay.new_delivery_receipts_per_work !== 0 ||
    replay.new_external_message_ids_per_work !== 0 ||
    replay.new_physical_messages_per_work !== 0 ||
    replay.new_provider_send_count !== 0 ||
    replay.new_mutable_source_read_on_duplicate_send !== 0
  ) {
    throw new HarnessError('CONTRACT_REPLAY_INVALID')
  }
  const checkpoint = object(value.client_checkpoint, 'CONTRACT_CHECKPOINT_INVALID')
  if (
    checkpoint.required_before_pass !== true ||
    checkpoint.source !== 'dingtalk-real-client-observer' ||
    canonicalJSON(checkpoint.allowed_clients) !== canonicalJSON(['ios', 'android', 'desktop']) ||
    checkpoint.observed_at_required !== true ||
    checkpoint.one_observation_per_target !== true ||
    checkpoint.work_marker_required !== true ||
    checkpoint.markdown_digest_required !== true ||
    checkpoint.image_digest_required !== true ||
    checkpoint.marker_and_image_same_card !== true ||
    checkpoint.screenshot_bytes_required !== true ||
    checkpoint.screenshot_within_checkpoint_directory !== true ||
    checkpoint.observed_physical_messages_per_target !== 1 ||
    checkpoint.duplicate_physical_messages_per_target !== 0 ||
    checkpoint.raw_target_identity_allowed !== false ||
    checkpoint.raw_external_message_id_allowed !== false
  ) {
    throw new HarnessError('CONTRACT_CHECKPOINT_INVALID')
  }
  const validateSideEffects = object(value.validate_side_effects, 'CONTRACT_VALIDATE_INVALID')
  if (
    canonicalJSON(validateSideEffects) !==
    canonicalJSON({
      sidecar_starts: 0,
      asset_uploads: 0,
      image_task_posts: 0,
      model_calls: 0,
      im_sends: 0,
      provider_queries: 0,
    })
  ) {
    throw new HarnessError('CONTRACT_VALIDATE_INVALID')
  }
  const policy = object(value.phase_policy, 'CONTRACT_PHASE_INVALID')
  if (
    policy.default_timeout_ms !== DEFAULT_PHASE_MS ||
    policy.hard_timeout_ms !== HARD_PHASE_MAX_MS ||
    policy.pending_exit_code !== 3 ||
    policy.checkpoint_file !== 'state.json' ||
    policy.evidence_file !== 'evidence.json'
  ) {
    throw new HarnessError('CONTRACT_PHASE_INVALID')
  }
  return {
    route: { ...route },
    transport: { ...transport },
    public_api: { ...publicAPI },
    fixtureKeys,
    fixtures: normalizedFixtures,
    creative_entry: { ...creative },
    delivery: {
      ...delivery,
      parts: parts.map((part) => ({ ...part })),
      markdown_policy: canonicalValue(markdownPolicy),
    },
    frozen_replay: { ...replay },
    client_checkpoint: { ...checkpoint },
    validate_side_effects: { ...validateSideEffects },
  }
}

async function loadContract() {
  let contract
  try {
    contract = JSON.parse(await readFile(CONTRACT_PATH, 'utf8'))
  } catch {
    throw new HarnessError('CONTRACT_UNAVAILABLE')
  }
  validateContract(contract)
  return contract
}

async function requireRegularFile(pathname, code, options = {}) {
  let info
  try {
    info = await lstat(pathname)
  } catch {
    throw new HarnessError(code)
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new HarnessError(code)
  if (options.executable && (info.mode & 0o111) === 0) throw new HarnessError(code)
  if (options.privateFile && (info.mode & 0o077) !== 0) throw new HarnessError(code)
  return info
}

async function requireDirectory(pathname, code, privateDirectory = false) {
  let info
  try {
    info = await lstat(pathname)
  } catch {
    throw new HarnessError(code)
  }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new HarnessError(code)
  if (privateDirectory && (info.mode & 0o077) !== 0) throw new HarnessError(code)
  return info
}

function pngDimensions(bytes, code) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature)) throw new HarnessError(code)
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

async function validateFixture(pathname, fixture) {
  const info = await requireRegularFile(pathname, 'FIXTURE_UNAVAILABLE')
  const bytes = await readFile(pathname)
  const geometry = pngDimensions(bytes, 'FIXTURE_MEDIA_INVALID')
  if (
    info.size !== fixture.size_bytes ||
    bytes.length !== fixture.size_bytes ||
    sha256Bytes(bytes) !== fixture.sha256 ||
    geometry.width !== fixture.width ||
    geometry.height !== fixture.height
  ) {
    throw new HarnessError('FIXTURE_DIGEST_DRIFT')
  }
  return {
    sha256: fixture.sha256,
    size_bytes: fixture.size_bytes,
    mime: fixture.mime,
    width: geometry.width,
    height: geometry.height,
  }
}

function fixturePath(docsRoot, fixture) {
  const pathname = resolve(docsRoot, fixture.docs_relative_path)
  const prefix = `${resolve(docsRoot)}${join('/', '')}`
  if (!pathname.startsWith(prefix)) throw new HarnessError('FIXTURE_PATH_INVALID')
  return pathname
}

export async function validateStatic(env = process.env) {
  const contract = await loadContract()
  const docsRoot = resolve(env.HEXCLAW_DOCS_ROOT || DEFAULT_DOCS_ROOT)
  await requireDirectory(docsRoot, 'DOCS_ROOT_UNAVAILABLE')
  const fixtures = {}
  for (const key of ['art', 'writing']) {
    fixtures[key] = await validateFixture(
      fixturePath(docsRoot, contract.fixtures[key]),
      contract.fixtures[key],
    )
  }
  return {
    status: 'validated',
    phase: 'validate',
    live_gate_required: true,
    sidecar_started: false,
    asset_uploads: 0,
    image_task_posts: 0,
    model_calls: 0,
    im_sends: 0,
    provider_queries: 0,
    public_api_only: true,
    phase_hard_cap_ms: HARD_PHASE_MAX_MS,
    fixtures,
  }
}

function physicalTarget(value, code = 'DELIVERY_TARGET_INVALID') {
  const target = object(value, code)
  const normalized = {
    platform: nonEmpty(target.platform, code).toLowerCase(),
    instance_id: nonEmpty(target.instance_id, code),
    chat_id: nonEmpty(target.chat_id, code),
  }
  if (normalized.platform !== 'dingtalk') throw new HarnessError(code)
  return normalized
}

function physicalTargetKey(value) {
  const target = physicalTarget(value)
  return `${target.platform}\u0000${target.instance_id}\u0000${target.chat_id}`
}

function exactPhysicalTargets(values, code = 'DELIVERY_TARGET_EXACT_SET_INVALID') {
  const targets = array(values, code).map((target) => physicalTarget(target, code))
  if (targets.length === 0 || new Set(targets.map(physicalTargetKey)).size !== targets.length) {
    throw new HarnessError(code)
  }
  return targets
}

function assetIdentity(assetID, expectedAgent, expectedDigest, expectedMIME, code) {
  const match = ASSET_ID.exec(nonEmpty(assetID, code))
  const expectedExtension = expectedMIME === 'image/png' ? 'png' : ''
  if (
    !match ||
    match[1] !== expectedAgent ||
    match[2] !== expectedDigest ||
    !expectedExtension ||
    match[3] !== expectedExtension
  ) {
    throw new HarnessError(code)
  }
  return { agent: match[1], digest: match[2], extension: match[3], file: `${match[2]}.${match[3]}` }
}

function dingTalkReferenceBoundary(value) {
  return value === undefined || /\s/u.test(value) || DINGTALK_REFERENCE_BOUNDARY.has(value)
}

function containsDingTalkLocalPath(content) {
  const runes = Array.from(String(content ?? ''))
  for (let index = 0; index < runes.length; index += 1) {
    const value = runes[index]
    const boundary = dingTalkReferenceBoundary(runes[index - 1])
    if (
      boundary &&
      value === '\\' &&
      runes[index + 1] === '\\' &&
      runes[index + 2] !== undefined &&
      !/\s/u.test(runes[index + 2])
    ) {
      return true
    }
    if (
      boundary &&
      value === '/' &&
      runes[index + 1] !== undefined &&
      runes[index + 1] !== '/' &&
      !/\s/u.test(runes[index + 1])
    ) {
      return true
    }
    if (
      boundary &&
      /^[a-z]$/iu.test(value) &&
      runes[index + 1] === ':' &&
      (runes[index + 2] === '\\' || runes[index + 2] === '/')
    ) {
      return true
    }
  }
  return false
}

export function assertDingTalkVisibleContentSafe(
  content,
  code = 'DINGTALK_VISIBLE_CONTENT_INVALID',
) {
  const text = nonEmpty(content, code)
  const lower = text.toLowerCase()
  if (
    ['asset://', 'file://', 'blob:', 'data:', '/api/k12/assets/'].some((marker) =>
      lower.includes(marker),
    ) ||
    containsDingTalkLocalPath(text) ||
    DINGTALK_INTERNAL_ASSET_ID.test(text)
  ) {
    throw new HarnessError(code)
  }
  return true
}

function hanCharacterCount(value) {
  return String(value ?? '').match(/\p{Script=Han}/gu)?.length ?? 0
}

export function assertCreativeMarkdownContent(
  markdown,
  code = 'CREATIVE_MARKDOWN_INVALID',
) {
  const text = nonEmpty(markdown, code).replace(/\r\n?/gu, '\n')
  assertDingTalkVisibleContentSafe(text, `${code}_VISIBLE_CONTENT`)
  const lines = text.split('\n')
  const headings = []
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^##[ \t]+(.+?)[ \t]*$/u.exec(lines[index])
    if (match) headings.push({ index, title: match[1] })
  }
  if (
    canonicalJSON(headings.map(({ title }) => title)) !== canonicalJSON(APPROVED_CREATIVE_H2_ORDER)
  ) {
    throw new HarnessError(`${code}_H2_EXACT_SET`)
  }

  const limitationIndexes = lines
    .map((line, index) => ({ index, text: line.trim() }))
    .filter(({ text: line }) => line.startsWith('说明：'))
  if (limitationIndexes.length > 1) throw new HarnessError(`${code}_LIMITATION_POSITION`)
  const limitationIndex = limitationIndexes[0]?.index
  if (limitationIndex !== undefined) {
    const lastNonEmptyIndex = lines.reduce(
      (latest, line, index) => (line.trim() ? index : latest),
      -1,
    )
    if (
      limitationIndex <= headings.at(-1).index ||
      limitationIndex !== lastNonEmptyIndex ||
      hanCharacterCount(lines[limitationIndex].trim().slice('说明：'.length)) === 0
    ) {
      throw new HarnessError(`${code}_LIMITATION_POSITION`)
    }
  }

  const sections = headings.map((heading, index) => {
    const nextHeadingIndex = headings[index + 1]?.index ?? lines.length
    const end =
      limitationIndex !== undefined && limitationIndex < nextHeadingIndex
        ? limitationIndex
        : nextHeadingIndex
    return lines.slice(heading.index + 1, end).join('\n').trim()
  })
  if (sections.some((section) => hanCharacterCount(section) === 0)) {
    throw new HarnessError(`${code}_CHINESE_BODY_REQUIRED`)
  }

  const parentQuestion = sections[2]
  if (
    !/[?？]/u.test(parentQuestion) ||
    hanCharacterCount(parentQuestion) <
      APPROVED_CREATIVE_MARKDOWN_POLICY.parent_question.minimum_han_characters
  ) {
    throw new HarnessError(`${code}_PARENT_QUESTION_REQUIRED`)
  }
  const nextStep = sections[3]
  if (
    hanCharacterCount(nextStep) <
    APPROVED_CREATIVE_MARKDOWN_POLICY.next_step.minimum_han_characters
  ) {
    throw new HarnessError(`${code}_NEXT_STEP_REQUIRED`)
  }

  const feedbackBody = sections.join('\n')
  if (/(?:\d{1,3}\s*分(?!钟)|\d{1,3}\s*\/\s*100|(?:得分|评分)\s*(?:为|[:：])?\s*\d+)/u.test(feedbackBody)) {
    throw new HarnessError(`${code}_SCORING_FORBIDDEN`)
  }
  if (/(?:排名\s*(?:第\s*)?\d+|第\s*\d+\s*名|超过\s*\d+(?:\.\d+)?%\s*(?:的)?同学)/u.test(feedbackBody)) {
    throw new HarnessError(`${code}_RANKING_FORBIDDEN`)
  }
  if (/(?:范文如下|全文如下|改写全文|重写全文|替(?:你|孩子)写|帮(?:你|孩子)写|代写)/u.test(feedbackBody)) {
    throw new HarnessError(`${code}_GHOSTWRITING_FORBIDDEN`)
  }
  return {
    h2_order: [...APPROVED_CREATIVE_H2_ORDER],
    chinese_section_count: sections.length,
    parent_question_present: true,
    next_step_present: true,
    light_limitation_present: limitationIndex !== undefined,
  }
}

export function canonicalCreativeMarkdown(work) {
  const feedback = work?.latest_feedback?.feedback?.projection_markdown
  const workTitle = work?.work_title === work?.display_name ? '' : work?.work_title
  return [work?.display_name, workTitle, work?.content_markdown, feedback]
    .map((part) => String(part ?? '').trim())
    .filter(Boolean)
    .join('\n\n')
}

export function assertPublicCreativeArtifact(work, sourceBytes, expected) {
  const value = object(work, 'CREATIVE_ARTIFACT_INVALID')
  if (!Buffer.isBuffer(sourceBytes) || sourceBytes.length === 0) {
    throw new HarnessError('CREATIVE_ARTIFACT_BYTES_INVALID')
  }
  const digest = sha256Bytes(sourceBytes)
  const expectedDigest = normalizedDigest(
    expected?.source_digest,
    'CREATIVE_ARTIFACT_DIGEST_INVALID',
  )
  const expectedMIME = nonEmpty(expected?.source_mime, 'CREATIVE_ARTIFACT_MIME_INVALID')
  const expectedAgent = nonEmpty(expected?.agent_name, 'CREATIVE_ARTIFACT_OWNER_INVALID')
  const expectedWorkID = nonEmpty(expected?.work_id, 'CREATIVE_ARTIFACT_INVALID')
  const marker = nonEmpty(expected?.marker, 'CREATIVE_ARTIFACT_MARKER_INVALID')
  const feedbackMarkdown = nonEmpty(
    value.latest_feedback?.feedback?.projection_markdown,
    'CREATIVE_ARTIFACT_FEEDBACK_INVALID',
  )
  if (
    digest !== expectedDigest ||
    value.work_id !== expectedWorkID ||
    value.work_type !== expected.work_type ||
    value.work_title !== marker ||
    !nonEmpty(value.display_name, 'CREATIVE_ARTIFACT_INVALID') ||
    !Number.isInteger(value.row_version) ||
    value.row_version < 1 ||
    value.latest_feedback?.status !== 'succeeded' ||
    !nonEmpty(value.latest_feedback?.generation_id, 'CREATIVE_ARTIFACT_FEEDBACK_INVALID') ||
    !feedbackMarkdown
  ) {
    throw new HarnessError('CREATIVE_ARTIFACT_INVALID')
  }
  const feedbackContract = assertCreativeMarkdownContent(
    feedbackMarkdown,
    'CREATIVE_ARTIFACT_MARKDOWN_INVALID',
  )
  const identity = assetIdentity(
    value.source_asset_id,
    expectedAgent,
    expectedDigest,
    expectedMIME,
    'CREATIVE_ARTIFACT_SOURCE_ID_INVALID',
  )
  const markdown = canonicalCreativeMarkdown(value)
  if (
    !markdown.includes(marker) ||
    (expected.canonical_markdown && markdown !== expected.canonical_markdown)
  ) {
    throw new HarnessError('CREATIVE_ARTIFACT_MARKDOWN_INVALID')
  }
  if (
    value.work_type === 'writing' &&
    !nonEmpty(value.content_markdown, 'CREATIVE_ARTIFACT_INVALID')
  ) {
    throw new HarnessError('CREATIVE_ARTIFACT_INVALID')
  }
  return {
    work_id: value.work_id,
    work_type: value.work_type,
    source_asset_id: value.source_asset_id,
    source_file: identity.file,
    source_digest: digest,
    source_size: sourceBytes.length,
    source_mime: expectedMIME,
    canonical_markdown: markdown,
    markdown_digest: sha256Text(markdown),
    marker,
    feedback_contract: feedbackContract,
  }
}

function canonicalModelOperationReceipts(result, code) {
  const receipts = array(object(result, code).operation_receipts, code)
    .map((receipt) => object(receipt, code))
    .filter(
      (receipt) => String(receipt.provider ?? '').trim() || String(receipt.model ?? '').trim(),
    )
    .map((receipt) => {
      if (!String(receipt.provider ?? '').trim() || !String(receipt.model ?? '').trim()) {
        throw new HarnessError(code)
      }
      return canonicalValue(receipt)
    })
    .sort((left, right) => canonicalJSON(left).localeCompare(canonicalJSON(right)))
  if (new Set(receipts.map(canonicalJSON)).size !== receipts.length) {
    throw new HarnessError(code)
  }
  return receipts
}

export function assertExactWorkFeedbackReceipt(result) {
  const receipts = canonicalModelOperationReceipts(
    result,
    'WORK_FEEDBACK_RECEIPT_EXACT_SET_INVALID',
  ).filter((receipt) => receipt.operation === 'work_feedback')
  if (receipts.length !== 1) {
    throw new HarnessError('WORK_FEEDBACK_RECEIPT_EXACT_SET_INVALID')
  }
  const receipt = receipts[0]
  const invocationID = nonEmpty(receipt.invocation_id, 'WORK_FEEDBACK_RECEIPT_INVALID')
  const resultDigest = normalizedDigest(receipt.result_digest, 'WORK_FEEDBACK_RECEIPT_INVALID')
  if (
    receipt.provider !== EXPECTED_PROVIDER ||
    receipt.model !== EXPECTED_MODEL ||
    receipt.status !== 'succeeded' ||
    receipt.attempt !== 1
  ) {
    throw new HarnessError('WORK_FEEDBACK_RECEIPT_INVALID')
  }
  return {
    provider: receipt.provider,
    model: receipt.model,
    status: receipt.status,
    attempt: receipt.attempt,
    invocation_id_sha256: sha256Text(invocationID),
    result_digest: `sha256:${resultDigest}`,
    receipt_sha256: sha256Text(canonicalJSON(receipt)),
  }
}

export function assertModelOperationReceiptsUnchanged(before, after) {
  const beforeReceipts = canonicalModelOperationReceipts(before, 'MODEL_OPERATION_RECEIPTS_INVALID')
  const afterReceipts = canonicalModelOperationReceipts(after, 'MODEL_OPERATION_RECEIPTS_INVALID')
  const beforeJSON = canonicalJSON(beforeReceipts)
  const afterJSON = canonicalJSON(afterReceipts)
  if (beforeJSON !== afterJSON) {
    throw new HarnessError('MODEL_OPERATION_RECEIPTS_CHANGED')
  }
  return {
    receipt_count: beforeReceipts.length,
    new_model_calls: 0,
    before_sha256: sha256Text(beforeJSON),
    after_sha256: sha256Text(afterJSON),
  }
}

function deliveryPayload(receipt, code) {
  let payload
  const payloadJSON = nonEmpty(receipt?.payload_json, code)
  try {
    payload = JSON.parse(payloadJSON)
  } catch {
    throw new HarnessError(code)
  }
  if (normalizedDigest(receipt.payload_digest, code) !== sha256Text(payloadJSON)) {
    throw new HarnessError(code)
  }
  return object(payload, code)
}

function assertCanonicalPartEvidence(payload, receipt, expected, code) {
  const content = object(payload.message_content, code)
  const manifest = object(payload.render_manifest, code)
  const attachmentRefs = array(content.attachments, code)
  const renderParts = array(manifest.parts, code)
  if (
    content.producer_kind !== 'k12' ||
    content.locale !== 'zh-CN' ||
    content.markdown !== expected.canonical_markdown ||
    !PREFIXED_SHA256.test(content.source_digest ?? '') ||
    manifest.content_id !== content.content_id ||
    manifest.source_digest !== content.source_digest ||
    manifest.surface !== 'channel' ||
    attachmentRefs.length !== 1 ||
    attachmentRefs[0]?.mime !== expected.source_mime ||
    normalizedDigest(attachmentRefs[0]?.digest, code) !== expected.source_digest ||
    renderParts.length !== 2 ||
    renderParts[0]?.kind !== 'markdown' ||
    renderParts[0]?.text !== expected.canonical_markdown ||
    renderParts[1]?.kind !== 'artifact' ||
    normalizedDigest(renderParts[1]?.artifact_digest, code) !== expected.source_digest ||
    normalizedDigest(payload.digest, code) !== normalizedDigest(receipt.part_digest, code)
  ) {
    throw new HarnessError(code)
  }
  assertCreativeMarkdownContent(content.markdown, `${code}_MARKDOWN`)
  assertDingTalkVisibleContentSafe(attachmentRefs[0]?.name, `${code}_ATTACHMENT_NAME`)
  assertDingTalkVisibleContentSafe(renderParts[1]?.alt_text, `${code}_ALT_TEXT`)
  let frozenManifest
  try {
    frozenManifest = JSON.parse(nonEmpty(receipt.render_manifest_json, code))
  } catch {
    throw new HarnessError(code)
  }
  if (canonicalJSON(frozenManifest) !== canonicalJSON(manifest)) throw new HarnessError(code)
}

function assertMarkdownPart(receipt, expected) {
  const payload = deliveryPayload(receipt, 'DELIVERY_MARKDOWN_INVALID')
  assertCreativeMarkdownContent(payload.text, 'DELIVERY_MARKDOWN_INVALID')
  if (
    payload.kind !== 'markdown' ||
    payload.ordinal !== 1 ||
    payload.text !== expected.canonical_markdown ||
    !payload.text.includes(expected.marker) ||
    normalizedDigest(payload.digest, 'DELIVERY_MARKDOWN_INVALID') !==
      sha256Text(expected.canonical_markdown) ||
    normalizedDigest(receipt.part_digest, 'DELIVERY_MARKDOWN_INVALID') !==
      sha256Text(expected.canonical_markdown)
  ) {
    throw new HarnessError('DELIVERY_MARKDOWN_INVALID')
  }
  assertCanonicalPartEvidence(payload, receipt, expected, 'DELIVERY_MARKDOWN_INVALID')
}

function attachmentField(attachment, upper, lower) {
  return attachment?.[upper] ?? attachment?.[lower]
}

function assertArtifactPart(receipt, expected) {
  const payload = deliveryPayload(receipt, 'DELIVERY_ARTIFACT_INVALID')
  const attachment = object(payload.attachment, 'DELIVERY_ARTIFACT_INVALID')
  const name = nonEmpty(attachmentField(attachment, 'Name', 'name'), 'DELIVERY_ARTIFACT_INVALID')
  const mime = nonEmpty(attachmentField(attachment, 'MIME', 'mime'), 'DELIVERY_ARTIFACT_INVALID')
  const bytes = decodeCanonicalBase64(
    attachmentField(attachment, 'Data', 'data'),
    'DELIVERY_ARTIFACT_INVALID',
  )
  assertDingTalkVisibleContentSafe(name, 'DELIVERY_ARTIFACT_INVALID')
  if (
    payload.kind !== 'artifact' ||
    payload.ordinal !== 2 ||
    payload.mime !== expected.source_mime ||
    mime !== expected.source_mime ||
    !name.endsWith('.png') ||
    normalizedDigest(payload.digest, 'DELIVERY_ARTIFACT_INVALID') !== expected.source_digest ||
    normalizedDigest(receipt.part_digest, 'DELIVERY_ARTIFACT_INVALID') !== expected.source_digest ||
    sha256Bytes(bytes) !== expected.source_digest ||
    !bytes.equals(expected.source_bytes)
  ) {
    throw new HarnessError('DELIVERY_ARTIFACT_INVALID')
  }
  assertCanonicalPartEvidence(payload, receipt, expected, 'DELIVERY_ARTIFACT_INVALID')
}

function deliveryInvariant(batch) {
  const value = object(batch, 'DELIVERY_BATCH_INVALID')
  return {
    batch_id: value.batch_id,
    agent_name: value.agent_name,
    object_kind: value.object_kind,
    object_id: value.object_id,
    dedupe_key: value.dedupe_key,
    content_digest: value.content_digest,
    status: value.status,
    receipts: array(value.receipts, 'DELIVERY_EXACT_SET_INVALID')
      .map((receipt) => ({
        delivery_id: receipt.delivery_id,
        batch_id: receipt.batch_id,
        batch_ordinal: receipt.batch_ordinal,
        part_kind: receipt.part_kind,
        part_mime: receipt.part_mime ?? '',
        part_ordinal: receipt.part_ordinal,
        part_digest: receipt.part_digest,
        agent_name: receipt.agent_name,
        object_kind: receipt.object_kind,
        object_id: receipt.object_id,
        binding_id: receipt.binding_id,
        target: receipt.target,
        status: receipt.status,
        dedupe_key: receipt.dedupe_key,
        payload_digest: receipt.payload_digest,
        payload_json: receipt.payload_json,
        render_manifest_json: receipt.render_manifest_json,
        external_message_id: receipt.external_message_id,
        attempt: receipt.attempt,
      }))
      .sort((left, right) => left.batch_ordinal - right.batch_ordinal),
  }
}

export function assertDeliveryExactSet(batch, expected) {
  const value = object(batch, 'DELIVERY_BATCH_INVALID')
  const targets = exactPhysicalTargets(expected?.expected_targets)
  const sourceBytes = expected?.source_bytes
  const sourceDigest = normalizedDigest(expected?.source_digest, 'DELIVERY_ARTIFACT_INVALID')
  const sourceMIME = nonEmpty(expected?.source_mime, 'DELIVERY_ARTIFACT_INVALID')
  const canonicalMarkdown = nonEmpty(expected?.canonical_markdown, 'DELIVERY_MARKDOWN_INVALID')
  const marker = nonEmpty(expected?.marker, 'DELIVERY_MARKDOWN_INVALID')
  assertCreativeMarkdownContent(canonicalMarkdown, 'DELIVERY_MARKDOWN_INVALID')
  if (
    !Buffer.isBuffer(sourceBytes) ||
    sha256Bytes(sourceBytes) !== sourceDigest ||
    sourceMIME !== 'image/png' ||
    !canonicalMarkdown.includes(marker)
  ) {
    throw new HarnessError('DELIVERY_ARTIFACT_INVALID')
  }
  if (
    value.agent_name !== expected.agent_name ||
    value.object_kind !== 'creative_work' ||
    value.object_id !== expected.work_id ||
    value.status !== 'delivered' ||
    !nonEmpty(value.batch_id, 'DELIVERY_BATCH_INVALID') ||
    !nonEmpty(value.dedupe_key, 'DELIVERY_BATCH_INVALID') ||
    !PREFIXED_SHA256.test(value.content_digest ?? '')
  ) {
    throw new HarnessError('DELIVERY_BATCH_INVALID')
  }
  const receipts = array(value.receipts, 'DELIVERY_EXACT_SET_INVALID')
  if (receipts.length !== targets.length * 2) throw new HarnessError('DELIVERY_EXACT_SET_INVALID')
  const expectedTargetKeys = new Set(targets.map(physicalTargetKey))
  const byTarget = new Map()
  const batchOrdinals = new Set()
  const physicalExternalIDs = new Set()
  for (const receipt of receipts) {
    const target = physicalTarget(receipt?.target)
    const key = physicalTargetKey(target)
    if (!expectedTargetKeys.has(key)) throw new HarnessError('DELIVERY_TARGET_EXACT_SET_INVALID')
    if (!byTarget.has(key)) byTarget.set(key, [])
    byTarget.get(key).push(receipt)
    if (
      receipt.batch_id !== value.batch_id ||
      !Number.isInteger(receipt.batch_ordinal) ||
      receipt.batch_ordinal < 1 ||
      batchOrdinals.has(receipt.batch_ordinal) ||
      receipt.agent_name !== expected.agent_name ||
      receipt.object_kind !== 'creative_work' ||
      receipt.object_id !== expected.work_id ||
      receipt.status !== 'delivered' ||
      !nonEmpty(receipt.delivery_id, 'DELIVERY_RECEIPT_INVALID') ||
      !nonEmpty(receipt.binding_id, 'DELIVERY_RECEIPT_INVALID') ||
      !nonEmpty(receipt.dedupe_key, 'DELIVERY_RECEIPT_INVALID') ||
      !PREFIXED_SHA256.test(receipt.part_digest ?? '') ||
      !PREFIXED_SHA256.test(receipt.payload_digest ?? '') ||
      !Number.isInteger(receipt.attempt) ||
      receipt.attempt < 1 ||
      !nonEmpty(receipt.external_message_id, 'DELIVERY_EXTERNAL_ID_REQUIRED')
    ) {
      throw new HarnessError('DELIVERY_RECEIPT_INVALID')
    }
    batchOrdinals.add(receipt.batch_ordinal)
  }
  const ordinalProjection = [...batchOrdinals].sort((left, right) => left - right)
  const expectedOrdinals = Array.from({ length: receipts.length }, (_, index) => index + 1)
  if (canonicalJSON(ordinalProjection) !== canonicalJSON(expectedOrdinals)) {
    throw new HarnessError('DELIVERY_BATCH_ORDINAL_DRIFT')
  }
  for (const target of targets) {
    const parts = byTarget.get(physicalTargetKey(target)) ?? []
    if (parts.length !== 2) throw new HarnessError('DELIVERY_EXACT_SET_INVALID')
    parts.sort((left, right) => left.part_ordinal - right.part_ordinal)
    const [markdown, image] = parts
    if (
      markdown.part_kind !== 'markdown' ||
      (markdown.part_mime ?? '') !== '' ||
      markdown.part_ordinal !== 1
    ) {
      throw new HarnessError('DELIVERY_MARKDOWN_INVALID')
    }
    if (
      image.part_kind !== 'artifact' ||
      image.part_mime !== sourceMIME ||
      image.part_ordinal !== 2
    ) {
      throw new HarnessError('DELIVERY_ARTIFACT_INVALID')
    }
    const physicalExternalID = nonEmpty(
      markdown.external_message_id,
      'DELIVERY_EXTERNAL_ID_REQUIRED',
    )
    if (
      image.external_message_id !== physicalExternalID ||
      image.attempt !== markdown.attempt ||
      image.status !== markdown.status
    ) {
      throw new HarnessError('DELIVERY_COMPOSITE_GROUP_DRIFT')
    }
    if (physicalExternalIDs.has(physicalExternalID)) {
      throw new HarnessError('DELIVERY_PHYSICAL_EXTERNAL_ID_DUPLICATE')
    }
    physicalExternalIDs.add(physicalExternalID)
    assertMarkdownPart(markdown, {
      canonical_markdown: canonicalMarkdown,
      marker,
      source_digest: sourceDigest,
      source_mime: sourceMIME,
    })
    assertArtifactPart(image, {
      canonical_markdown: canonicalMarkdown,
      marker,
      source_digest: sourceDigest,
      source_mime: sourceMIME,
      source_bytes: sourceBytes,
    })
  }
  if (byTarget.size !== targets.length) throw new HarnessError('DELIVERY_EXACT_SET_INVALID')
  return {
    batch_id_sha256: sha256Text(value.batch_id),
    target_count: targets.length,
    receipt_count: receipts.length,
    component_row_count: receipts.length,
    physical_message_count: physicalExternalIDs.size,
    target_hashes: targets.map((target) => sha256Text(physicalTargetKey(target))).sort(),
    physical_external_message_id_hashes: [...physicalExternalIDs].map(sha256Text).sort(),
    markdown_digest: sha256Text(canonicalMarkdown),
    image_digest: sourceDigest,
  }
}

function creativeWorkInvariant(work) {
  const value = object(work, 'FROZEN_REPLAY_DRIFT')
  const generation = (item) => {
    if (!item) return null
    return {
      generation_id: item.generation_id,
      status: item.status,
      failure_message: item.failure_message ?? '',
      feedback: item.feedback
        ? {
            feedback_id: item.feedback.feedback_id,
            feedback_type: item.feedback.feedback_type,
            evidence_refs: item.feedback.evidence_refs,
            visible_evidence: item.feedback.visible_evidence,
            affirmation: item.feedback.affirmation,
            parent_guidance: item.feedback.parent_guidance,
            next_step: item.feedback.next_step,
            source_snapshot: item.feedback.source_snapshot,
            limitations: item.feedback.limitations,
            projection_markdown: item.feedback.projection_markdown,
          }
        : null,
    }
  }
  return {
    work_id: value.work_id,
    work_type: value.work_type,
    display_name: value.display_name,
    work_title: value.work_title,
    content_markdown: value.content_markdown ?? '',
    source_asset_id: value.source_asset_id,
    row_version: value.row_version,
    initial_feedback: generation(value.initial_feedback),
    latest_feedback: generation(value.latest_feedback),
    delivery_batch_id: value.delivery_batch_id ?? '',
    created_at: value.created_at,
    latest_generation_at: value.latest_generation_at,
  }
}

export function assertFrozenReplayInvariant(before, after) {
  const left = object(before, 'FROZEN_REPLAY_DRIFT')
  const right = object(after, 'FROZEN_REPLAY_DRIFT')
  const projection = (value) => ({
    work: creativeWorkInvariant(value.work),
    source_digest: normalizedDigest(value.source_digest, 'FROZEN_REPLAY_DRIFT'),
    batch: deliveryInvariant(value.batch),
  })
  if (canonicalJSON(projection(left)) !== canonicalJSON(projection(right))) {
    throw new HarnessError('FROZEN_REPLAY_DRIFT')
  }
  return before
}

export function checkpointExpectationFromDelivery(batch, expected) {
  assertDeliveryExactSet(batch, expected)
  const receipts = array(batch.receipts, 'CLIENT_CHECKPOINT_DELIVERY_INVALID')
  const targets = []
  for (const target of exactPhysicalTargets(expected.expected_targets)) {
    const key = physicalTargetKey(target)
    const parts = receipts.filter((receipt) => physicalTargetKey(receipt.target) === key)
    const markdown = parts.find((receipt) => receipt.part_kind === 'markdown')
    const image = parts.find((receipt) => receipt.part_kind === 'artifact')
    if (!markdown || !image || markdown.external_message_id !== image.external_message_id) {
      throw new HarnessError('CLIENT_CHECKPOINT_DELIVERY_INVALID')
    }
    targets.push({
      target_sha256: sha256Text(key),
      physical_external_message_id_sha256: sha256Text(markdown.external_message_id),
    })
  }
  return {
    marker: expected.marker,
    markdown_digest: sha256Text(expected.canonical_markdown),
    image_digest: normalizedDigest(expected.source_digest, 'CLIENT_CHECKPOINT_INVALID'),
    targets: targets.sort((left, right) => left.target_sha256.localeCompare(right.target_sha256)),
  }
}

async function safeEvidenceFile(pathname, evidenceRoot, wantDigest, code) {
  try {
    const linkInfo = await lstat(pathname)
    if (linkInfo.isSymbolicLink()) throw new HarnessError(`${code}_UNSAFE`)
    const root = await realpath(evidenceRoot)
    const candidate = await realpath(pathname)
    const rel = relative(root, candidate)
    if (rel === '' || rel.startsWith('..') || resolve(root, rel) !== candidate) {
      throw new HarnessError(`${code}_OUTSIDE_ROOT`)
    }
    const info = await lstat(candidate)
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      (info.mode & 0o077) !== 0 ||
      info.size < 1_024 ||
      info.size > 25 * 1024 * 1024
    ) {
      throw new HarnessError(`${code}_UNSAFE`)
    }
    const bytes = await readFile(candidate)
    if (
      !bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) &&
      !(
        bytes[0] === 0xff &&
        bytes[1] === 0xd8 &&
        bytes[bytes.length - 2] === 0xff &&
        bytes.at(-1) === 0xd9
      )
    ) {
      throw new HarnessError(`${code}_FORMAT_INVALID`)
    }
    const got = sha256Bytes(bytes)
    if (got !== normalizedDigest(wantDigest, `${code}_DIGEST_INVALID`)) {
      throw new HarnessError(`${code}_DIGEST_DRIFT`)
    }
    return got
  } catch (error) {
    if (error instanceof HarnessError) throw error
    throw new HarnessError(`${code}_UNSAFE`)
  }
}

export async function assertClientCheckpoint(checkpoint, expected) {
  const value = object(checkpoint, 'CLIENT_CHECKPOINT_INVALID')
  const targetExpectations = array(expected?.targets, 'CLIENT_CHECKPOINT_INVALID')
  const client = nonEmpty(value.client, 'CLIENT_CHECKPOINT_INVALID')
  const observedAt = nonEmpty(value.observed_at, 'CLIENT_CHECKPOINT_INVALID')
  const evidenceRoot = nonEmpty(expected?.evidence_root, 'CLIENT_SCREENSHOT_ROOT_REQUIRED')
  if (
    value.schema_version !== 1 ||
    value.scenario !== 'k12_real_dingtalk_creative_images' ||
    value.source !== 'dingtalk-real-client-observer' ||
    !['ios', 'android', 'desktop'].includes(client) ||
    !Number.isFinite(Date.parse(observedAt)) ||
    value.work_marker !== expected.marker ||
    normalizedDigest(value.markdown_digest, 'CLIENT_CHECKPOINT_DIGEST_INVALID') !==
      expected.markdown_digest ||
    normalizedDigest(value.image_digest, 'CLIENT_CHECKPOINT_DIGEST_INVALID') !==
      expected.image_digest
  ) {
    throw new HarnessError('CLIENT_CHECKPOINT_INVALID')
  }
  const observations = array(value.observations, 'CLIENT_CHECKPOINT_EXACT_SET_INVALID')
  if (observations.length !== targetExpectations.length) {
    throw new HarnessError('CLIENT_CHECKPOINT_EXACT_SET_INVALID')
  }
  const expectedByTarget = new Map(
    targetExpectations.map((target) => [
      normalizedDigest(target.target_sha256, 'CLIENT_CHECKPOINT_INVALID'),
      {
        ...target,
        physical_external_message_id_sha256: normalizedDigest(
          target.physical_external_message_id_sha256,
          'CLIENT_CHECKPOINT_INVALID',
        ),
      },
    ]),
  )
  const seen = new Set()
  const screenshotDigests = []
  for (const observation of observations) {
    const item = object(observation, 'CLIENT_CHECKPOINT_OBSERVATION_INVALID')
    if (
      'platform' in item ||
      'instance_id' in item ||
      'chat_id' in item ||
      'external_message_id' in item
    ) {
      throw new HarnessError('CLIENT_CHECKPOINT_RAW_IDENTITY')
    }
    const targetHash = normalizedDigest(
      item.target_sha256,
      'CLIENT_CHECKPOINT_OBSERVATION_INVALID',
    )
    const wanted = expectedByTarget.get(targetHash)
    if (
      !wanted ||
      seen.has(targetHash) ||
      normalizedDigest(
        item.physical_external_message_id_sha256,
        'CLIENT_CHECKPOINT_OBSERVATION_INVALID',
      ) !==
        wanted.physical_external_message_id_sha256 ||
      item.marker_visible !== true ||
      item.markdown_rendered !== true ||
      item.image_visible !== true ||
      item.marker_and_image_same_card !== true ||
      item.observed_physical_message_count !== 1 ||
      item.duplicate_physical_message_count !== 0 ||
      normalizedDigest(item.observed_markdown_digest, 'CLIENT_CHECKPOINT_DIGEST_INVALID') !==
        expected.markdown_digest ||
      normalizedDigest(item.observed_image_digest, 'CLIENT_CHECKPOINT_DIGEST_INVALID') !==
        expected.image_digest
    ) {
      throw new HarnessError('CLIENT_CHECKPOINT_OBSERVATION_INVALID')
    }
    screenshotDigests.push(
      await safeEvidenceFile(
        nonEmpty(item.screenshot_path, 'CLIENT_SCREENSHOT_REQUIRED'),
        evidenceRoot,
        item.screenshot_sha256,
        'CLIENT_SCREENSHOT',
      ),
    )
    seen.add(targetHash)
  }
  if (seen.size !== expectedByTarget.size)
    throw new HarnessError('CLIENT_CHECKPOINT_EXACT_SET_INVALID')
  return {
    marker_sha256: sha256Text(expected.marker),
    markdown_digest: expected.markdown_digest,
    image_digest: expected.image_digest,
    observation_count: observations.length,
    target_hashes: [...seen].sort(),
    source: value.source,
    client,
    observed_at: observedAt,
    screenshot_sha256s: screenshotDigests.sort(),
  }
}

export function assertCreativeReplayBeforeAssetRead(source) {
  const text = String(source ?? '')
  const functionStart = text.indexOf('func (h *handler) sendCreativeWork')
  const functionEnd = text.indexOf('\nfunc creativeWorkAttachmentIdentity', functionStart)
  if (functionStart < 0 || functionEnd < 0) throw new HarnessError('CREATIVE_REPLAY_SOURCE_INVALID')
  const body = text.slice(functionStart, functionEnd)
  const replayLookup = body.indexOf('ReplayDeliveryBatchForMessageIdentity')
  const sourceOpen = body.indexOf('OpenReady(')
  const firstReplayCall = body.indexOf('replayExisting()', replayLookup)
  const replayAfterOpenFailure = body.indexOf('replayExisting()', sourceOpen)
  const prepare = body.indexOf('PrepareAndSendMessageBatch', sourceOpen)
  if (
    replayLookup < 0 ||
    sourceOpen < 0 ||
    replayLookup > sourceOpen ||
    firstReplayCall < 0 ||
    firstReplayCall > sourceOpen ||
    replayAfterOpenFailure < sourceOpen ||
    prepare < sourceOpen
  ) {
    throw new HarnessError('CREATIVE_REPLAY_SOURCE_ORDER_INVALID')
  }
  return true
}

const SENSITIVE_EVIDENCE_KEYS = new Set([
  'app_key',
  'app_secret',
  'api_key',
  'access_token',
  'refresh_token',
  'token',
  'sign',
  'signature',
  'payload_json',
  'canonical_markdown',
  'raw_model_output',
  'source_bytes',
  'bytes',
])
const RAW_IDENTITY_KEYS = new Set([
  'instance_id',
  'chat_id',
  'user_id',
  'external_message_id',
  'binding_id',
])

export function assertEvidenceSafe(value) {
  const visit = (node) => {
    if (Array.isArray(node)) {
      node.forEach(visit)
      return
    }
    if (!node || typeof node !== 'object') return
    for (const [key, child] of Object.entries(node)) {
      const lower = key.toLowerCase()
      if (SENSITIVE_EVIDENCE_KEYS.has(lower)) throw new HarnessError('EVIDENCE_SECRET')
      if (RAW_IDENTITY_KEYS.has(lower)) throw new HarnessError('EVIDENCE_RAW_ID')
      visit(child)
    }
  }
  visit(value)
  return value
}

export function redactEvidence(value) {
  const visit = (node) => {
    if (Array.isArray(node)) return node.map(visit)
    if (!node || typeof node !== 'object') return node
    const output = {}
    for (const [key, child] of Object.entries(node)) {
      const lower = key.toLowerCase()
      if (SENSITIVE_EVIDENCE_KEYS.has(lower)) continue
      if (RAW_IDENTITY_KEYS.has(lower)) {
        output[`${key}_sha256`] = sha256Text(String(child))
        continue
      }
      output[key] = visit(child)
    }
    return output
  }
  return assertEvidenceSafe(visit(value))
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

async function loadState(runRoot) {
  try {
    const state = JSON.parse(await readFile(join(runRoot, 'state.json'), 'utf8'))
    if (state?.schema_version !== 1) throw new Error('schema')
    return state
  } catch {
    throw new HarnessError('RUN_STATE_UNAVAILABLE')
  }
}

async function saveState(runRoot, state) {
  state.updated_at = new Date().toISOString()
  await writePrivateJSON(join(runRoot, 'state.json'), state)
}

async function loadEvidence(runRoot) {
  try {
    const evidence = JSON.parse(await readFile(join(runRoot, 'evidence.json'), 'utf8'))
    return assertEvidenceSafe(evidence)
  } catch (error) {
    if (safeCode(error) === 'EVIDENCE_SECRET' || safeCode(error) === 'EVIDENCE_RAW_ID') throw error
    return { schema_version: 1, phases: {} }
  }
}

async function recordEvidence(runRoot, phase, projection) {
  const evidence = await loadEvidence(runRoot)
  evidence.updated_at = new Date().toISOString()
  evidence.phases[phase] = redactEvidence(projection)
  assertEvidenceSafe(evidence)
  await writePrivateJSON(join(runRoot, 'evidence.json'), evidence)
}

function liveRuntime(env = process.env) {
  const runRoot = resolve(
    nonEmpty(env.HEXCLAW_CREATIVE_DINGTALK_IMAGE_RUN_DIR, 'RUN_DIRECTORY_REQUIRED'),
  )
  const config = resolve(
    nonEmpty(env.HEXCLAW_CREATIVE_DINGTALK_IMAGE_CONFIG, 'TEST_CONFIG_REQUIRED'),
  )
  const sidecar = resolve(
    nonEmpty(env.HEXCLAW_CREATIVE_DINGTALK_IMAGE_SIDECAR_BIN, 'SIDECAR_BINARY_REQUIRED'),
  )
  const assetRoot = resolve(
    nonEmpty(env.HEXCLAW_CREATIVE_DINGTALK_IMAGE_ASSET_ROOT, 'ASSET_ROOT_REQUIRED'),
  )
  const checkpointDirectory = resolve(
    nonEmpty(
      env.HEXCLAW_CREATIVE_DINGTALK_IMAGE_CHECKPOINT_DIR,
      'CLIENT_CHECKPOINT_DIRECTORY_REQUIRED',
    ),
  )
  let baseURL
  try {
    baseURL = new URL(
      nonEmpty(env.HEXCLAW_CREATIVE_DINGTALK_IMAGE_BASE_URL, 'SIDECAR_BASE_URL_REQUIRED'),
    )
  } catch {
    throw new HarnessError('SIDECAR_BASE_URL_INVALID')
  }
  if (
    baseURL.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost'].includes(baseURL.hostname) ||
    (baseURL.pathname !== '/' && baseURL.pathname !== '')
  ) {
    throw new HarnessError('SIDECAR_BASE_URL_INVALID')
  }
  let expectedTargets
  try {
    expectedTargets = JSON.parse(
      nonEmpty(
        env.HEXCLAW_CREATIVE_DINGTALK_IMAGE_EXPECTED_TARGETS_JSON,
        'EXPECTED_TARGETS_REQUIRED',
      ),
    )
  } catch {
    throw new HarnessError('EXPECTED_TARGETS_INVALID')
  }
  expectedTargets = exactPhysicalTargets(expectedTargets, 'EXPECTED_TARGETS_INVALID')
  return {
    runRoot,
    config,
    sidecar,
    assetRoot,
    checkpointDirectory,
    baseURL: baseURL.origin,
    agentName: nonEmpty(env.HEXCLAW_CREATIVE_DINGTALK_IMAGE_AGENT_NAME, 'AGENT_NAME_REQUIRED'),
    expectedTargets,
    docsRoot: resolve(env.HEXCLAW_DOCS_ROOT || DEFAULT_DOCS_ROOT),
  }
}

function sidecarEnvironment(env, runtime, capability) {
  return {
    ...env,
    HEXCLAW_ASSET_ROOT: runtime.assetRoot,
    HEXCLAW_SIDECAR_CAPABILITY_TOKEN: capability,
    DINGTALK_LIVE_SEND: '1',
  }
}

function startSidecar(runtime, env, capability) {
  const hash = createHash('sha256')
  let bytes = 0
  const child = spawn(runtime.sidecar, ['serve', '--desktop', '--config', runtime.config], {
    cwd: runtime.runRoot,
    env: sidecarEnvironment(env, runtime, capability),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let spawnFailed = false
  child.once('error', () => {
    spawnFailed = true
  })
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => {
      bytes += chunk.length
      hash.update(chunk)
    })
  }
  return { child, hash, bytes: () => bytes, spawnFailed: () => spawnFailed }
}

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds))
}

async function stopSidecar(processState) {
  if (!processState) return { log_sha256: sha256Text(''), log_bytes: 0, forced: false }
  const { child } = processState
  let graceful = child.exitCode !== null || child.signalCode !== null
  if (!graceful) {
    const closed = new Promise((resolveClose) => child.once('close', resolveClose))
    child.kill('SIGTERM')
    graceful = await Promise.race([closed.then(() => true), sleep(10_000).then(() => false)])
    if (!graceful && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await closed
    }
  }
  return {
    log_sha256: processState.hash.digest('hex'),
    log_bytes: processState.bytes(),
    forced: !graceful,
  }
}

let activePhaseDeadline = 0

function remaining(deadline, requested, code) {
  const available = deadline - Date.now() - 5_000
  if (available <= 0) throw new PhasePending(code)
  return Math.max(1, Math.min(requested, available))
}

async function apiContext(baseURL, capability = '') {
  return await playwrightRequest.newContext({
    baseURL,
    extraHTTPHeaders: capability
      ? { Authorization: `Bearer ${capability}`, Accept: 'application/json' }
      : { Accept: 'application/json' },
  })
}

async function apiRequest(api, method, pathname, options = {}) {
  let timeout = options.timeout ?? REQUEST_TIMEOUT_MS
  if (activePhaseDeadline > 0) {
    timeout = remaining(activePhaseDeadline, timeout, 'PHASE_BUDGET_PENDING')
  }
  let response
  try {
    response = await api.fetch(pathname, {
      method,
      data: options.data,
      multipart: options.multipart,
      headers: options.headers,
      timeout,
      failOnStatusCode: false,
    })
  } catch {
    if (activePhaseDeadline > 0 && Date.now() >= activePhaseDeadline - 5_000) {
      throw new PhasePending('PHASE_BUDGET_PENDING')
    }
    throw new HarnessError(options.code ?? 'PUBLIC_API_REQUEST_FAILED')
  }
  const raw = await response.body()
  const allowed = options.allowed ?? [200]
  if (!allowed.includes(response.status())) {
    const error = new HarnessError(options.code ?? 'PUBLIC_API_STATUS_INVALID')
    error.diagnostic_sha256 = sha256Bytes(raw)
    throw error
  }
  if (options.parse === 'bytes') {
    return { status: response.status(), headers: response.headers(), bytes: raw }
  }
  if (options.parse === false) return { status: response.status() }
  try {
    return { status: response.status(), value: JSON.parse(raw.toString('utf8')) }
  } catch {
    throw new HarnessError(options.code ?? 'PUBLIC_API_JSON_INVALID')
  }
}

async function waitForSidecar(runtime, processState, deadline) {
  const anonymous = await apiContext(runtime.baseURL)
  try {
    const until = Math.min(deadline, Date.now() + START_TIMEOUT_MS)
    while (Date.now() < until) {
      if (processState.spawnFailed()) throw new HarnessError('SIDECAR_SPAWN_FAILED')
      if (processState.child.exitCode !== null || processState.child.signalCode !== null) {
        throw new HarnessError('SIDECAR_EXITED_BEFORE_READY')
      }
      try {
        await apiRequest(anonymous, 'GET', '/api/v1/version', {
          timeout: 2_000,
          code: 'SIDECAR_NOT_READY',
        })
        return
      } catch (error) {
        if (safeCode(error) !== 'SIDECAR_NOT_READY') throw error
      }
      await sleep(250)
    }
  } finally {
    await anonymous.dispose()
  }
  throw new HarnessError('SIDECAR_START_TIMEOUT')
}

async function withSidecar(runtime, env, deadline, operation) {
  const capability = randomBytes(32).toString('hex')
  const processState = startSidecar(runtime, env, capability)
  const api = await apiContext(runtime.baseURL, capability)
  try {
    await waitForSidecar(runtime, processState, deadline)
    return await operation(api)
  } finally {
    await api.dispose()
    runtime.lastProcessLog = await stopSidecar(processState)
  }
}

export function maskedInstanceConfig(config) {
  if (config === null || config === undefined) return true
  let value = config
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return false
    }
  }
  const isCredentialKey = (key) => {
    const compact = String(key).toLowerCase().trim().replaceAll('-', '_').replaceAll('_', '')
    if (
      new Set([
        'password',
        'passwd',
        'pwd',
        'secret',
        'token',
        'apikey',
        'authorization',
        'credential',
        'credentials',
        'aeskey',
        'encryptionkey',
        'privatekey',
        'accesskey',
        'secretkey',
      ]).has(compact)
    ) {
      return true
    }
    return ['password', 'secret', 'token', 'apikey', 'privatekey', 'credential'].some((suffix) =>
      compact.endsWith(suffix),
    )
  }
  const visit = (node, key = '') => {
    if (Array.isArray(node)) return node.every((child) => visit(child, key))
    if (!node || typeof node !== 'object') {
      if (!isCredentialKey(key)) return true
      const text = String(node ?? '').trim()
      return (
        text === '' ||
        text === '****' ||
        /^\*{4}.{4}$/su.test(text) ||
        /^•+$/u.test(text) ||
        text === '[REDACTED]'
      )
    }
    return Object.entries(node).every(([childKey, child]) => visit(child, childKey))
  }
  return visit(value)
}

export async function waitForBoundInstancesProjection(
  runtime,
  fetchProjection,
  deadline,
  intervalMilliseconds = 250,
) {
  const expectedInstances = new Set(runtime.expectedTargets.map((target) => target.instance_id))
  const until = Math.min(deadline, Date.now() + START_TIMEOUT_MS)
  while (Date.now() < until) {
    const projection = await fetchProjection()
    const matchingInstances = array(projection?.instances, 'INSTANCE_PROJECTION_INVALID').filter(
      (instance) => instance?.provider === 'dingtalk' && expectedInstances.has(instance?.id),
    )
    if (
      matchingInstances.length === expectedInstances.size &&
      matchingInstances.every(
        (instance) => instance.enabled === true && instance.status === 'running',
      )
    ) {
      return projection
    }
    await sleep(intervalMilliseconds)
  }
  throw new HarnessError('BOUND_INSTANCE_PROJECTION_INVALID')
}

export function assertPreparedPublicProjection(runtime, llm, instances, agents) {
  const providers = object(llm?.providers, 'REAL_ROUTE_PROJECTION_INVALID')
  const provider = object(providers[EXPECTED_PROVIDER], 'REAL_ROUTE_PROJECTION_INVALID')
  if (
    !array(provider.models, 'REAL_ROUTE_PROJECTION_INVALID').includes(EXPECTED_MODEL) ||
    provider.credential_present !== true
  ) {
    throw new HarnessError('REAL_ROUTE_PROJECTION_INVALID')
  }
  const expectedInstances = new Set(runtime.expectedTargets.map((target) => target.instance_id))
  const matchingInstances = array(instances?.instances, 'INSTANCE_PROJECTION_INVALID').filter(
    (instance) => instance?.provider === 'dingtalk' && expectedInstances.has(instance?.id),
  )
  if (
    matchingInstances.length !== expectedInstances.size ||
    matchingInstances.some(
      (instance) =>
        instance.enabled !== true ||
        instance.status !== 'running' ||
        !maskedInstanceConfig(instance.config),
    )
  ) {
    throw new HarnessError('BOUND_INSTANCE_PROJECTION_INVALID')
  }
  const matchingAgents = array(agents?.agents, 'AGENT_PROJECTION_INVALID').filter(
    (agent) => agent?.name === runtime.agentName,
  )
  if (
    matchingAgents.length !== 1 ||
    matchingAgents[0].provider !== EXPECTED_PROVIDER ||
    matchingAgents[0].model !== EXPECTED_MODEL ||
    matchingAgents[0].metadata?.scenario !== 'k12-tutor'
  ) {
    throw new HarnessError('AGENT_ROUTE_PROJECTION_INVALID')
  }
  const boundTargets = array(agents?.rules, 'AGENT_RULE_PROJECTION_INVALID')
    .filter((rule) => rule?.agent_name === runtime.agentName && rule?.platform === 'dingtalk')
    .map((rule) => ({
      platform: 'dingtalk',
      instance_id: String(rule.instance_id ?? ''),
      chat_id: String(rule.chat_id || rule.user_id || ''),
    }))
    .filter((target) => target.instance_id && target.chat_id)
  const uniqueBound = [
    ...new Map(
      boundTargets.map((target) => [physicalTargetKey(target), physicalTarget(target)]),
    ).values(),
  ]
  if (uniqueBound.length === 0) throw new HarnessError('AGENT_RULE_PROJECTION_INVALID')
  const expectedKeys = runtime.expectedTargets.map(physicalTargetKey).sort()
  const boundKeys = uniqueBound.map(physicalTargetKey).sort()
  if (canonicalJSON(expectedKeys) !== canonicalJSON(boundKeys)) {
    throw new HarnessError('BOUND_TARGET_EXACT_SET_INVALID')
  }
  return {
    provider: EXPECTED_PROVIDER,
    model: EXPECTED_MODEL,
    agent_name_sha256: sha256Text(runtime.agentName),
    target_hashes: runtime.expectedTargets
      .map((target) => sha256Text(physicalTargetKey(target)))
      .sort(),
    target_count: runtime.expectedTargets.length,
    instance_hashes: [...expectedInstances].map(sha256Text).sort(),
  }
}

async function preparePhase(env, deadline) {
  const contract = await loadContract()
  const runtime = liveRuntime(env)
  try {
    const existing = await loadState(runtime.runRoot)
    return {
      status: 'already_prepared',
      phase: 'prepare',
      run_id_sha256: sha256Text(existing.run_id),
      route: existing.route,
      target_count: existing.expected_targets.length,
    }
  } catch (error) {
    if (safeCode(error) !== 'RUN_STATE_UNAVAILABLE') throw error
  }
  await mkdir(runtime.runRoot, { recursive: false, mode: PRIVATE_DIRECTORY_MODE })
  await chmod(runtime.runRoot, PRIVATE_DIRECTORY_MODE)
  if ((await realpath(runtime.runRoot)) !== runtime.runRoot) {
    throw new HarnessError('RUN_DIRECTORY_SYMLINKED')
  }
  await mkdir(runtime.assetRoot, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
  await chmod(runtime.assetRoot, PRIVATE_DIRECTORY_MODE)
  await requireRegularFile(runtime.config, 'TEST_CONFIG_UNAVAILABLE', { privateFile: true })
  await requireRegularFile(runtime.sidecar, 'SIDECAR_BINARY_UNAVAILABLE', { executable: true })
  await requireDirectory(runtime.docsRoot, 'DOCS_ROOT_UNAVAILABLE')
  for (const key of ['art', 'writing']) {
    await validateFixture(
      fixturePath(runtime.docsRoot, contract.fixtures[key]),
      contract.fixtures[key],
    )
  }
  const state = {
    schema_version: 1,
    run_id: `creative-dingtalk-${randomUUID()}`,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    route: { provider: EXPECTED_PROVIDER, model: EXPECTED_MODEL, fallback_allowed: false },
    runtime: {
      config_sha256: await sha256File(runtime.config),
      sidecar_sha256: await sha256File(runtime.sidecar),
      base_url_sha256: sha256Text(runtime.baseURL),
    },
    agent_name: runtime.agentName,
    expected_targets: runtime.expectedTargets,
    cases: {},
  }
  await withSidecar(runtime, env, deadline, async (api) => {
    const [llm, instances, agents] = await Promise.all([
      apiRequest(api, 'GET', '/api/v1/config/llm', { code: 'LLM_PROJECTION_FAILED' }),
      waitForBoundInstancesProjection(
        runtime,
        async () =>
          (
            await apiRequest(api, 'GET', '/api/v1/platforms/instances', {
              code: 'INSTANCE_PROJECTION_FAILED',
            })
          ).value,
        deadline,
      ),
      apiRequest(api, 'GET', '/api/v1/agents', { code: 'AGENT_PROJECTION_FAILED' }),
    ])
    state.public_projection = assertPreparedPublicProjection(
      runtime,
      llm.value,
      instances,
      agents.value,
    )
  })
  state.last_process_log = runtime.lastProcessLog
  await saveState(runtime.runRoot, state)
  const projection = {
    status: 'prepared',
    phase: 'prepare',
    run_id_sha256: sha256Text(state.run_id),
    route: state.route,
    public_projection: state.public_projection,
    config_sha256: state.runtime.config_sha256,
    sidecar_sha256: state.runtime.sidecar_sha256,
    sidecar_stopped: true,
  }
  await recordEvidence(runtime.runRoot, 'prepare', projection)
  return projection
}

function caseKey(value) {
  if (!['art', 'writing'].includes(value)) throw new HarnessError('CASE_INVALID')
  return value
}

function markerFor(state, key) {
  const label = key === 'art' ? 'ART' : 'WRITING'
  return `HC-CREATIVE-${label}-${sha256Text(state.run_id).slice(0, 12).toUpperCase()}`
}

async function fixtureBytes(runtime, contract, key) {
  const fixture = contract.fixtures[caseKey(key)]
  const pathname = fixturePath(runtime.docsRoot, fixture)
  await validateFixture(pathname, fixture)
  return { pathname, bytes: await readFile(pathname), fixture }
}

function parseAssetForAgent(assetID, agent, expectedDigest) {
  return assetIdentity(assetID, agent, expectedDigest, 'image/png', 'ASSET_ID_INVALID')
}

function publicAssetPath(assetID, agent, expectedDigest) {
  const identity = parseAssetForAgent(assetID, agent, expectedDigest)
  return `/api/k12/assets/${encodeURIComponent(identity.file)}?agent=${encodeURIComponent(agent)}`
}

function creativeSendPath(workID) {
  return `/api/k12/creative-works/${encodeURIComponent(workID)}/send`
}

async function uploadAsset(api, state, fixture) {
  const uploaded = await apiRequest(
    api,
    'POST',
    `/api/k12/assets?agent=${encodeURIComponent(state.agent_name)}`,
    {
      multipart: {
        file: {
          name: basename(fixture.pathname),
          mimeType: fixture.fixture.mime,
          buffer: fixture.bytes,
        },
      },
      code: 'ASSET_UPLOAD_FAILED',
    },
  )
  const value = object(uploaded.value, 'ASSET_UPLOAD_INVALID')
  if (value.size !== fixture.fixture.size_bytes) throw new HarnessError('ASSET_UPLOAD_INVALID')
  parseAssetForAgent(value.asset_id, state.agent_name, fixture.fixture.sha256)
  return value.asset_id
}

async function getPublicAsset(api, state, assetID, expected) {
  const response = await apiRequest(
    api,
    'GET',
    publicAssetPath(assetID, state.agent_name, expected.source_digest),
    { parse: 'bytes', code: 'ASSET_GET_FAILED' },
  )
  const contentType = String(response.headers['content-type'] ?? '').split(';')[0]
  if (
    contentType !== expected.source_mime ||
    sha256Bytes(response.bytes) !== expected.source_digest ||
    !response.bytes.equals(expected.source_bytes)
  ) {
    throw new HarnessError('ASSET_PUBLIC_BYTES_DRIFT')
  }
  return response.bytes
}

async function getImageTask(api, state, dispatchID) {
  const response = await apiRequest(
    api,
    'GET',
    `/api/k12/image-tasks/${encodeURIComponent(dispatchID)}?agent=${encodeURIComponent(
      state.agent_name,
    )}`,
    { code: 'IMAGE_TASK_GET_FAILED' },
  )
  return object(response.value?.dispatch, 'IMAGE_TASK_GET_INVALID')
}

async function getImageTaskResult(api, state, dispatchID) {
  const response = await apiRequest(
    api,
    'GET',
    `/api/k12/image-tasks/${encodeURIComponent(dispatchID)}/result?agent=${encodeURIComponent(
      state.agent_name,
    )}`,
    { code: 'IMAGE_TASK_RESULT_FAILED' },
  )
  return object(response.value, 'IMAGE_TASK_RESULT_INVALID')
}

async function createImageTask(api, state, key, assetID) {
  const marker = markerFor(state, key)
  const created = await apiRequest(api, 'POST', '/api/k12/image-tasks', {
    data: {
      agent: state.agent_name,
      source_session: `creative-${state.run_id}`,
      source_kind: 'api',
      source_ref: marker,
      source_asset_refs: [assetID],
      message_intent:
        key === 'art'
          ? '这是一幅孩子的美术作品，请只依据画面中的可见构图、色彩与线条进行点评。'
          : '这是一篇孩子手写的作文，请先识别原文，确认后只依据原文进行点评。',
      attempt_generation: 1,
      route_request: {
        provider: EXPECTED_PROVIDER,
        model: EXPECTED_MODEL,
        selection_source: 'explicit',
      },
      creative_entry: {
        kind: 'new_work',
        task_intent: key === 'art' ? 'artwork' : 'writing',
      },
    },
    code: 'IMAGE_TASK_CREATE_FAILED',
  })
  const dispatch = object(created.value?.dispatch, 'IMAGE_TASK_CREATE_INVALID')
  return {
    dispatch_id: nonEmpty(dispatch.dispatch_id, 'IMAGE_TASK_CREATE_INVALID'),
    dispatch,
  }
}

async function confirmCreative(api, state, dispatchID, data, code) {
  const response = await apiRequest(
    api,
    'POST',
    `/api/k12/image-tasks/${encodeURIComponent(dispatchID)}/confirm`,
    {
      data: { agent: state.agent_name, ...data },
      code,
    },
  )
  return object(response.value?.dispatch, code)
}

async function waitForCreativeTarget(api, state, dispatchID, predicate, deadline, code) {
  while (Date.now() < deadline - 5_000) {
    const dispatch = await getImageTask(api, state, dispatchID)
    const target = dispatch.target_projection
    if (target && predicate(target, dispatch)) return { dispatch, target }
    if (dispatch.status === 'failed' && dispatch.retryable !== true) throw new HarnessError(code)
    await sleep(POLL_INTERVAL_MS)
  }
  throw new PhasePending(code, { dispatch_id_sha256: sha256Text(dispatchID) })
}

async function getCreativeWork(api, state, workID) {
  const response = await apiRequest(
    api,
    'GET',
    `/api/k12/creative-works/${encodeURIComponent(workID)}?agent=${encodeURIComponent(
      state.agent_name,
    )}`,
    { code: 'CREATIVE_WORK_GET_FAILED' },
  )
  return object(response.value, 'CREATIVE_WORK_GET_INVALID')
}

async function waitForCreativeFeedback(api, state, workID, deadline) {
  while (Date.now() < deadline - 5_000) {
    const work = await getCreativeWork(api, state, workID)
    if (work.latest_feedback?.status === 'succeeded' && work.latest_feedback?.feedback) return work
    if (work.latest_feedback?.status === 'failed')
      throw new HarnessError('CREATIVE_FEEDBACK_FAILED')
    await sleep(POLL_INTERVAL_MS)
  }
  throw new PhasePending('CREATIVE_FEEDBACK_PENDING', { work_id_sha256: sha256Text(workID) })
}

async function loadWritingConfirmation(runtime, target) {
  const conflicts = Array.isArray(target.conflicts) ? target.conflicts : []
  if (conflicts.length === 0) {
    return {
      canonical_version: positiveInteger(
        target.canonical_version,
        'WRITING_OCR_CANONICAL_VERSION_INVALID',
      ),
      canonical_content: nonEmpty(
        target.canonical_content,
        'WRITING_OCR_CANONICAL_CONTENT_INVALID',
      ),
      segment_corrections: [],
    }
  }
  const confirmationPath = join(runtime.runRoot, 'writing-ocr-confirmation.json')
  try {
    await requireRegularFile(confirmationPath, 'WRITING_OCR_CONFIRMATION_REQUIRED', {
      privateFile: true,
    })
  } catch {
    await writePrivateJSON(join(runtime.runRoot, 'writing-ocr-confirmation.template.json'), {
      schema_version: 1,
      canonical_version: target.canonical_version,
      canonical_content: target.canonical_content,
      segment_corrections: conflicts.map((conflict) => ({
        segment_id: conflict.segment_id,
        canonical_text: conflict.canonical_text || conflict.raw_text || '',
      })),
    })
    throw new PhasePending('WRITING_OCR_CONFIRMATION_REQUIRED', {
      conflict_count: conflicts.length,
      template_sha256: await sha256File(
        join(runtime.runRoot, 'writing-ocr-confirmation.template.json'),
      ),
    })
  }
  let confirmation
  try {
    confirmation = JSON.parse(await readFile(confirmationPath, 'utf8'))
  } catch {
    throw new HarnessError('WRITING_OCR_CONFIRMATION_INVALID')
  }
  const corrections = array(confirmation.segment_corrections, 'WRITING_OCR_CONFIRMATION_INVALID')
  const expectedSegments = conflicts.map((item) => item.segment_id).sort()
  const actualSegments = corrections
    .map((item) => nonEmpty(item.segment_id, 'WRITING_OCR_CONFIRMATION_INVALID'))
    .sort()
  if (
    confirmation.schema_version !== 1 ||
    confirmation.canonical_version !== target.canonical_version ||
    !nonEmpty(confirmation.canonical_content, 'WRITING_OCR_CONFIRMATION_INVALID') ||
    canonicalJSON(expectedSegments) !== canonicalJSON(actualSegments) ||
    corrections.some((item) => !nonEmpty(item.canonical_text, 'WRITING_OCR_CONFIRMATION_INVALID'))
  ) {
    throw new HarnessError('WRITING_OCR_CONFIRMATION_INVALID')
  }
  return confirmation
}

function expectedForCase(state, key, sourceBytes, work) {
  const sourceDigest = sha256Bytes(sourceBytes)
  return {
    agent_name: state.agent_name,
    work_id: work.work_id,
    work_type: key === 'art' ? 'art' : 'writing',
    marker: markerFor(state, key),
    source_mime: 'image/png',
    source_digest: sourceDigest,
    source_bytes: sourceBytes,
    canonical_markdown: canonicalCreativeMarkdown(work),
    expected_targets: state.expected_targets,
  }
}

async function createCreativeCasePhase(env, deadline, requestedKey) {
  const key = caseKey(requestedKey)
  const runtime = liveRuntime(env)
  const contract = await loadContract()
  const state = await loadState(runtime.runRoot)
  if (
    state.cases[key]?.stage === 'created' &&
    state.cases[key]?.work_feedback_receipt?.provider === EXPECTED_PROVIDER &&
    state.cases[key]?.work_feedback_receipt?.model === EXPECTED_MODEL
  ) {
    return {
      status: 'already_created',
      phase: `create-${key}`,
      work_id_sha256: sha256Text(state.cases[key].work_id),
      source_digest: state.cases[key].source_digest,
      markdown_digest: state.cases[key].markdown_digest,
      model_execution: state.cases[key].work_feedback_receipt,
    }
  }
  const fixture = await fixtureBytes(runtime, contract, key)
  const caseState = state.cases[key] ?? {
    stage: 'new',
    marker: markerFor(state, key),
    source_digest: fixture.fixture.sha256,
  }
  state.cases[key] = caseState
  let proof
  await withSidecar(runtime, env, deadline, async (api) => {
    if (!caseState.asset_id) {
      caseState.asset_id = await uploadAsset(api, state, fixture)
      caseState.stage = 'asset_uploaded'
      await saveState(runtime.runRoot, state)
    }
    if (!caseState.dispatch_id) {
      const created = await createImageTask(api, state, key, caseState.asset_id)
      caseState.dispatch_id = created.dispatch_id
      caseState.stage = 'image_task_created'
      await saveState(runtime.runRoot, state)
    }
    let dispatch = await getImageTask(api, state, caseState.dispatch_id)
    let target = dispatch.target_projection
    if (key === 'art') {
      if (target?.status !== 'promoted') {
        dispatch = await confirmCreative(
          api,
          state,
          caseState.dispatch_id,
          {
            version: imageTaskVersion(dispatch.version),
            creative: {
              action: 'commit',
              work_title: caseState.marker,
              task_requirement: '仅描述画面中可见的构图、色彩与线条。',
              content_markdown: '',
            },
          },
          'ART_COMMIT_FAILED',
        )
        target = dispatch.target_projection
      }
    } else {
      if (target?.status !== 'ready' && target?.status !== 'promoted') {
        const waiting = await waitForCreativeTarget(
          api,
          state,
          caseState.dispatch_id,
          (candidate) =>
            candidate.status === 'awaiting_confirmation' ||
            candidate.status === 'ready' ||
            candidate.status === 'promoted',
          deadline,
          'WRITING_OCR_PENDING',
        )
        dispatch = waiting.dispatch
        target = waiting.target
      }
      if (target.status === 'awaiting_confirmation') {
        const confirmation = await loadWritingConfirmation(runtime, target)
        dispatch = await confirmCreative(
          api,
          state,
          caseState.dispatch_id,
          {
            version: imageTaskVersion(dispatch.version),
            creative: {
              action: 'freeze_ocr',
              canonical_version: confirmation.canonical_version,
              canonical_content: confirmation.canonical_content,
              segment_corrections: confirmation.segment_corrections,
            },
          },
          'WRITING_OCR_FREEZE_FAILED',
        )
        target = dispatch.target_projection
      }
      if (target?.status !== 'promoted') {
        if (target?.status !== 'ready') throw new HarnessError('WRITING_COMMIT_STATE_INVALID')
        const content = nonEmpty(target.canonical_content, 'WRITING_FROZEN_CONTENT_INVALID')
        dispatch = await confirmCreative(
          api,
          state,
          caseState.dispatch_id,
          {
            version: imageTaskVersion(dispatch.version),
            creative: {
              action: 'commit',
              work_title: caseState.marker,
              task_requirement: '仅依据已确认的孩子原文进行点评。',
              content_markdown: content,
            },
          },
          'WRITING_COMMIT_FAILED',
        )
        target = dispatch.target_projection
      }
    }
    if (
      target?.status !== 'promoted' ||
      target.commit_state !== 'committed' ||
      !target.promoted_work_id
    ) {
      throw new HarnessError('CREATIVE_PROMOTION_INVALID')
    }
    caseState.work_id = target.promoted_work_id
    caseState.stage = 'feedback_pending'
    await saveState(runtime.runRoot, state)
    const work = await waitForCreativeFeedback(api, state, caseState.work_id, deadline)
    const expected = expectedForCase(state, key, fixture.bytes, work)
    const publicBytes = await getPublicAsset(api, state, work.source_asset_id, expected)
    proof = assertPublicCreativeArtifact(work, publicBytes, expected)
    const workFeedbackReceipt = assertExactWorkFeedbackReceipt(
      await getImageTaskResult(api, state, caseState.dispatch_id),
    )
    caseState.stage = 'created'
    caseState.work = work
    caseState.work_id = work.work_id
    caseState.source_asset_id = work.source_asset_id
    caseState.source_digest = proof.source_digest
    caseState.source_size = proof.source_size
    caseState.source_mime = proof.source_mime
    caseState.markdown_digest = proof.markdown_digest
    caseState.work_feedback_receipt = workFeedbackReceipt
    delete caseState.route
    await saveState(runtime.runRoot, state)
  })
  state.last_process_log = runtime.lastProcessLog
  await saveState(runtime.runRoot, state)
  const projection = {
    status: 'created',
    phase: `create-${key}`,
    work_type: key === 'art' ? 'art' : 'writing',
    work_id_sha256: sha256Text(caseState.work_id),
    dispatch_id_sha256: sha256Text(caseState.dispatch_id),
    source_asset_id_sha256: sha256Text(caseState.source_asset_id),
    source_digest: caseState.source_digest,
    source_size: caseState.source_size,
    markdown_digest: caseState.markdown_digest,
    marker_sha256: sha256Text(caseState.marker),
    model_execution: caseState.work_feedback_receipt,
    sidecar_stopped: true,
  }
  await recordEvidence(runtime.runRoot, `create-${key}`, projection)
  return projection
}

async function queryBatchUntilDelivered(api, state, batch, deadline) {
  let current = batch
  while (current?.status !== 'delivered' && Date.now() < deadline - 5_000) {
    if (['failed', 'partial_failed'].includes(current?.status)) {
      throw new HarnessError('DELIVERY_BATCH_FAILED')
    }
    const queried = await apiRequest(
      api,
      'POST',
      `/api/k12/delivery-batches/${encodeURIComponent(current.batch_id)}/query`,
      {
        data: { agent: state.agent_name },
        code: 'DELIVERY_QUERY_FAILED',
      },
    )
    current = queried.value
    if (current?.status !== 'delivered') await sleep(POLL_INTERVAL_MS)
  }
  if (current?.status !== 'delivered') {
    throw new PhasePending('DELIVERY_CONFIRMATION_PENDING', {
      batch_id_sha256: current?.batch_id ? sha256Text(current.batch_id) : '',
      status: current?.status ?? 'unknown',
    })
  }
  return current
}

export function creativeDeliveryResumeAction(work, batch) {
  const value = object(work, 'CREATIVE_WORK_INVALID')
  const batchID = String(value.delivery_batch_id ?? '').trim()
  if (!batchID) return 'send'
  const current = object(batch, 'DELIVERY_BATCH_GET_INVALID')
  if (nonEmpty(current.batch_id, 'DELIVERY_BATCH_GET_INVALID') !== batchID) {
    throw new HarnessError('DELIVERY_BATCH_ID_DRIFT')
  }
  switch (current.status) {
    case 'delivered':
      return 'delivered'
    case 'pending':
    case 'sending':
    case 'outcome_unknown':
      return 'query'
    case 'failed':
    case 'partial_failed':
      return 'retry'
    default:
      throw new HarnessError('DELIVERY_BATCH_STATUS_INVALID')
  }
}

export async function resumeCreativeDelivery(api, state, work, workID) {
  const batchID = String(work?.delivery_batch_id ?? '').trim()
  const batch = batchID ? await getDeliveryBatch(api, state, batchID) : null
  const action = creativeDeliveryResumeAction(work, batch)
  if (action === 'send') {
    const sent = await apiRequest(api, 'POST', creativeSendPath(workID), {
      data: { agent: state.agent_name },
      code: 'CREATIVE_SEND_FAILED',
    })
    return object(sent.value, 'DELIVERY_BATCH_INVALID')
  }
  if (action === 'retry') {
    const retried = await apiRequest(
      api,
      'POST',
      `/api/k12/delivery-batches/${encodeURIComponent(batchID)}/retry`,
      {
        data: { agent: state.agent_name },
        code: 'DELIVERY_RETRY_FAILED',
      },
    )
    return object(retried.value, 'DELIVERY_BATCH_INVALID')
  }
  return batch
}

async function sendCreativeCasePhase(env, deadline, requestedKey) {
  const key = caseKey(requestedKey)
  const runtime = liveRuntime(env)
  const contract = await loadContract()
  const state = await loadState(runtime.runRoot)
  const caseState = object(state.cases[key], 'CREATIVE_CASE_NOT_CREATED')
  if (caseState.stage === 'sent') {
    if (caseState.send_model_receipts?.new_model_calls !== 0) {
      throw new HarnessError('SEND_MODEL_RECEIPT_GATE_REQUIRED')
    }
    return {
      status: 'already_sent',
      phase: `send-${key}`,
      batch_id_sha256: sha256Text(caseState.batch.batch_id),
      receipt_count: caseState.batch.receipts.length,
      component_row_count: caseState.batch.receipts.length,
      physical_message_count: state.expected_targets.length,
      target_count: state.expected_targets.length,
      model_receipts: caseState.send_model_receipts,
    }
  }
  if (caseState.stage !== 'created') throw new HarnessError('CREATIVE_CASE_NOT_CREATED')
  const fixture = await fixtureBytes(runtime, contract, key)
  let deliveryProof
  let modelReceiptProof
  await withSidecar(runtime, env, deadline, async (api) => {
    let work = await getCreativeWork(api, state, caseState.work_id)
    let expected = expectedForCase(state, key, fixture.bytes, work)
    const sourceBytes = await getPublicAsset(api, state, work.source_asset_id, expected)
    assertPublicCreativeArtifact(work, sourceBytes, expected)
    const beforeResult = await getImageTaskResult(api, state, caseState.dispatch_id)
    const beforeWorkFeedback = assertExactWorkFeedbackReceipt(beforeResult)
    const resumed = await resumeCreativeDelivery(api, state, work, caseState.work_id)
    const batch = await queryBatchUntilDelivered(api, state, resumed, deadline)
    work = await getCreativeWork(api, state, caseState.work_id)
    expected = expectedForCase(state, key, fixture.bytes, work)
    deliveryProof = assertDeliveryExactSet(batch, expected)
    const afterResult = await getImageTaskResult(api, state, caseState.dispatch_id)
    const afterWorkFeedback = assertExactWorkFeedbackReceipt(afterResult)
    modelReceiptProof = assertModelOperationReceiptsUnchanged(beforeResult, afterResult)
    if (beforeWorkFeedback.receipt_sha256 !== afterWorkFeedback.receipt_sha256) {
      throw new HarnessError('WORK_FEEDBACK_RECEIPT_CHANGED_DURING_SEND')
    }
    modelReceiptProof.work_feedback_receipt_sha256 = beforeWorkFeedback.receipt_sha256
    if (work.delivery_batch_id !== batch.batch_id) {
      throw new HarnessError('CREATIVE_DELIVERY_BATCH_PROJECTION_DRIFT')
    }
    caseState.stage = 'sent'
    caseState.work = work
    caseState.batch = batch
    caseState.source_digest = expected.source_digest
    caseState.markdown_digest = deliveryProof.markdown_digest
    caseState.checkpoint_expectation = checkpointExpectationFromDelivery(batch, expected)
    caseState.send_model_receipts = modelReceiptProof
    await saveState(runtime.runRoot, state)
  })
  state.last_process_log = runtime.lastProcessLog
  await saveState(runtime.runRoot, state)
  const projection = {
    status: 'sent_and_provider_confirmed',
    phase: `send-${key}`,
    work_id_sha256: sha256Text(caseState.work_id),
    batch_id_sha256: sha256Text(caseState.batch.batch_id),
    target_count: deliveryProof.target_count,
    receipt_count: deliveryProof.receipt_count,
    component_row_count: deliveryProof.component_row_count,
    physical_message_count: deliveryProof.physical_message_count,
    target_hashes: deliveryProof.target_hashes,
    physical_external_message_id_hashes:
      deliveryProof.physical_external_message_id_hashes,
    markdown_digest: deliveryProof.markdown_digest,
    image_digest: deliveryProof.image_digest,
    original_image_exact_bytes: true,
    model_receipts: modelReceiptProof,
    sidecar_stopped: true,
  }
  await recordEvidence(runtime.runRoot, `send-${key}`, projection)
  return projection
}

async function getDeliveryBatch(api, state, batchID) {
  const response = await apiRequest(
    api,
    'GET',
    `/api/k12/delivery-batches/${encodeURIComponent(batchID)}?agent=${encodeURIComponent(
      state.agent_name,
    )}`,
    { code: 'DELIVERY_BATCH_GET_FAILED' },
  )
  return object(response.value, 'DELIVERY_BATCH_GET_INVALID')
}

async function restartPhase(env, deadline) {
  const runtime = liveRuntime(env)
  const contract = await loadContract()
  const state = await loadState(runtime.runRoot)
  const proofs = {}
  await withSidecar(runtime, env, deadline, async (api) => {
    for (const key of ['art', 'writing']) {
      const caseState = object(state.cases[key], 'RESTART_CASE_NOT_SENT')
      if (caseState.stage !== 'sent') throw new HarnessError('RESTART_CASE_NOT_SENT')
      const fixture = await fixtureBytes(runtime, contract, key)
      const work = await getCreativeWork(api, state, caseState.work_id)
      const expected = expectedForCase(state, key, fixture.bytes, work)
      const sourceBytes = await getPublicAsset(api, state, work.source_asset_id, expected)
      const artifact = assertPublicCreativeArtifact(work, sourceBytes, expected)
      const batch = await getDeliveryBatch(api, state, caseState.batch.batch_id)
      const delivery = assertDeliveryExactSet(batch, expected)
      assertFrozenReplayInvariant(
        {
          work: caseState.work,
          source_digest: caseState.source_digest,
          batch: caseState.batch,
        },
        { work, source_digest: artifact.source_digest, batch },
      )
      caseState.restart_verified = true
      proofs[key] = {
        work_id_sha256: sha256Text(work.work_id),
        batch_id_sha256: sha256Text(batch.batch_id),
        source_digest: artifact.source_digest,
        markdown_digest: delivery.markdown_digest,
        receipt_count: delivery.receipt_count,
        component_row_count: delivery.component_row_count,
        physical_message_count: delivery.physical_message_count,
      }
    }
  })
  state.last_process_log = runtime.lastProcessLog
  await saveState(runtime.runRoot, state)
  const projection = {
    status: 'restart_verified',
    phase: 'restart',
    restart_action: 'query_only',
    public_asset_gets: 2,
    creative_send_posts: 0,
    provider_queries: 0,
    im_sends: 0,
    cases: proofs,
    sidecar_stopped: true,
  }
  await recordEvidence(runtime.runRoot, 'restart', projection)
  return projection
}

async function replayPhase(env, deadline) {
  const runtime = liveRuntime(env)
  const contract = await loadContract()
  const state = await loadState(runtime.runRoot)
  const proofs = {}
  await withSidecar(runtime, env, deadline, async (api) => {
    for (const key of ['art', 'writing']) {
      const caseState = object(state.cases[key], 'REPLAY_CASE_NOT_SENT')
      if (caseState.stage !== 'sent' || caseState.restart_verified !== true) {
        throw new HarnessError('REPLAY_RESTART_GATE_REQUIRED')
      }
      const fixture = await fixtureBytes(runtime, contract, key)
      const expected = expectedForCase(state, key, fixture.bytes, caseState.work)
      const replayed = await apiRequest(api, 'POST', creativeSendPath(caseState.work_id), {
        data: { agent: state.agent_name },
        code: 'CREATIVE_REPLAY_FAILED',
      })
      const batch = object(replayed.value, 'CREATIVE_REPLAY_INVALID')
      const delivery = assertDeliveryExactSet(batch, expected)
      assertFrozenReplayInvariant(
        {
          work: caseState.work,
          source_digest: caseState.source_digest,
          batch: caseState.batch,
        },
        { work: caseState.work, source_digest: caseState.source_digest, batch },
      )
      caseState.replay_verified = true
      proofs[key] = {
        work_id_sha256: sha256Text(caseState.work_id),
        batch_id_sha256: sha256Text(batch.batch_id),
        receipt_count: delivery.receipt_count,
        component_row_count: delivery.component_row_count,
        physical_message_count: delivery.physical_message_count,
        physical_external_message_id_hashes:
          delivery.physical_external_message_id_hashes,
      }
    }
  })
  state.last_process_log = runtime.lastProcessLog
  await saveState(runtime.runRoot, state)
  const projection = {
    status: 'replay_verified',
    phase: 'replay',
    duplicate_product_send_posts: 2,
    runner_source_asset_gets: 0,
    provider_queries: 0,
    new_receipts: 0,
    new_external_message_ids: 0,
    new_provider_sends: 0,
    frozen_batch_exact: true,
    cases: proofs,
    sidecar_stopped: true,
  }
  await recordEvidence(runtime.runRoot, 'replay', projection)
  return projection
}

async function loadClientCheckpoint(runtime, key) {
  const pathname = join(runtime.checkpointDirectory, `${caseKey(key)}.json`)
  try {
    await requireRegularFile(pathname, 'CLIENT_CHECKPOINT_REQUIRED', { privateFile: true })
  } catch {
    throw new PhasePending('CLIENT_CHECKPOINT_REQUIRED', {
      case: key,
      expected_filename_sha256: sha256Text(`${key}.json`),
    })
  }
  try {
    return JSON.parse(await readFile(pathname, 'utf8'))
  } catch {
    throw new HarnessError('CLIENT_CHECKPOINT_JSON_INVALID')
  }
}

async function checkpointPhase(env) {
  const runtime = liveRuntime(env)
  const state = await loadState(runtime.runRoot)
  await requireDirectory(
    runtime.checkpointDirectory,
    'CLIENT_CHECKPOINT_DIRECTORY_UNAVAILABLE',
    true,
  )
  const proofs = {}
  for (const key of ['art', 'writing']) {
    const caseState = object(state.cases[key], 'CLIENT_CHECKPOINT_CASE_NOT_SENT')
    if (caseState.stage !== 'sent' || caseState.replay_verified !== true) {
      throw new HarnessError('CLIENT_CHECKPOINT_REPLAY_GATE_REQUIRED')
    }
    const checkpoint = await loadClientCheckpoint(runtime, key)
    proofs[key] = await assertClientCheckpoint(checkpoint, {
      ...caseState.checkpoint_expectation,
      evidence_root: runtime.checkpointDirectory,
    })
    caseState.client_checkpoint_verified = true
  }
  await saveState(runtime.runRoot, state)
  const projection = {
    status: 'client_checkpoint_verified',
    phase: 'checkpoint',
    real_dingtalk_client_observed: true,
    marker_and_digest_link_required: true,
    cases: proofs,
    sidecar_started: false,
    im_sends: 0,
  }
  await recordEvidence(runtime.runRoot, 'checkpoint', projection)
  return projection
}

async function statusPhase(env) {
  const runtime = liveRuntime(env)
  const state = await loadState(runtime.runRoot)
  const offline = await validateStatic(env)
  const evidence = await loadEvidence(runtime.runRoot)
  const requiredPhases = [
    'prepare',
    'create-art',
    'send-art',
    'create-writing',
    'send-writing',
    'restart',
    'replay',
    'checkpoint',
  ]
  for (const phase of requiredPhases) {
    if (!evidence.phases?.[phase]) throw new HarnessError('LIVE_PHASE_EVIDENCE_INCOMPLETE')
  }
  for (const key of ['art', 'writing']) {
    const caseState = object(state.cases[key], 'LIVE_CASE_INCOMPLETE')
    if (
      caseState.stage !== 'sent' ||
      caseState.restart_verified !== true ||
      caseState.replay_verified !== true ||
      caseState.client_checkpoint_verified !== true
    ) {
      throw new HarnessError('LIVE_CASE_INCOMPLETE')
    }
  }
  return {
    status: 'PASS',
    phase: 'status',
    scenario: 'k12_real_dingtalk_creative_images',
    run_id_sha256: sha256Text(state.run_id),
    route: state.route,
    target_count: state.expected_targets.length,
    work_count: 2,
    receipt_count: state.expected_targets.length * 2 * 2,
    component_row_count: state.expected_targets.length * 2 * 2,
    physical_message_count: state.expected_targets.length * 2,
    real_dingtalk_client_checkpoint: true,
    restart_exact: true,
    duplicate_send_exact: true,
    original_image_exact: true,
    offline_validate: offline.status,
    sidecar_started: false,
    im_sends: 0,
  }
}

async function executePhase(phase, env, deadline) {
  switch (phase) {
    case 'validate':
      return await validateStatic(env)
    case 'prepare':
      return await preparePhase(env, deadline)
    case 'create-art':
      return await createCreativeCasePhase(env, deadline, 'art')
    case 'send-art':
      return await sendCreativeCasePhase(env, deadline, 'art')
    case 'create-writing':
      return await createCreativeCasePhase(env, deadline, 'writing')
    case 'send-writing':
      return await sendCreativeCasePhase(env, deadline, 'writing')
    case 'restart':
      return await restartPhase(env, deadline)
    case 'replay':
      return await replayPhase(env, deadline)
    case 'checkpoint':
      return await checkpointPhase(env)
    case 'status':
      return await statusPhase(env)
    default:
      throw new HarnessError('INVALID_PHASE')
  }
}

export async function runPhase(phase, env = process.env) {
  const budget = phaseBudgetMilliseconds(env)
  const deadline = Date.now() + budget
  activePhaseDeadline = deadline
  try {
    return await executePhase(phase, env, deadline)
  } finally {
    activePhaseDeadline = 0
  }
}

async function main() {
  let phase = 'validate'
  try {
    phase = resolvePhase(process.argv.slice(2))
    const result = await runPhase(phase, process.env)
    process.stdout.write(`${JSON.stringify(redactEvidence(result), null, 2)}\n`)
  } catch (error) {
    const output = {
      status: error instanceof PhasePending ? 'PENDING' : 'FAIL',
      phase,
      code: safeCode(error),
    }
    if (error?.diagnostic_sha256) output.diagnostic_sha256 = error.diagnostic_sha256
    if (error instanceof PhasePending) output.evidence = redactEvidence(error.evidence)
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
    process.exitCode = error instanceof PhasePending ? 3 : 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
