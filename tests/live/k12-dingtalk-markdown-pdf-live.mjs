#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, realpath, stat } from 'node:fs/promises'
import { basename, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const SHA256 = /^[a-f0-9]{64}$/u
const PREFIXED_SHA256 = /^sha256:[a-f0-9]{64}$/u
const CONTENT_ID = /^content:[a-f0-9]{64}$/u
const RENDER_ID = /^render:[a-f0-9]{64}$/u
const DEFAULT_PHASE_MS = 24 * 60_000
const HARD_PHASE_MAX_MS = 29 * 60_000
const REQUEST_TIMEOUT_MS = 90_000
const CHECKPOINT_POLL_MS = 1_000
const SEND_PATH = '/api/k12/weekly-practice/snapshots/{snapshot_id}/send'
const BATCH_PATH = '/api/k12/delivery-batches/{batch_id}'
const QUERY_PATH = '/api/k12/delivery-batches/{batch_id}/query'
const RESTART_CHECKPOINT = 'HEX_K12_LIVE_RESTART_CHECKPOINT'
const CLIENT_CHECKPOINT = 'HEX_K12_LIVE_CLIENT_CHECKPOINT'

export const LIVE_CONTRACT = Object.freeze({
  schema_version: 1,
  mode: 'one_stage_under_30_minutes',
  transport: {
    product_operations: 'hexclaw_public_http_api_only',
    bound_instance_only: true,
    dws_cli: false,
    direct_dingtalk_http: false,
    direct_store_read: false,
    starts_sidecar: false,
  },
  public_api: {
    rules: '/api/v1/agents/rules',
    instances: '/api/v1/platforms/instances',
    snapshot: '/api/k12/weekly-practice/snapshots/{snapshot_id}',
    artifact: '/api/k12/print-artifacts/{artifact_id}/content',
    send: SEND_PATH,
    batch: BATCH_PATH,
    query: QUERY_PATH,
  },
  delivery: {
    request_count: 1,
    target_mode: 'all_deduplicated_direct_physical_bindings',
    parts_per_target: 2,
    part_order: ['markdown', 'artifact'],
    part_transport: ['sampleMarkdown', 'sampleFile'],
    artifact_mime: 'application/pdf',
    outcome_unknown_action: 'query_only',
    retry_allowed: false,
    all_artifacts_prepared_before_first_visible_send: true,
  },
  checkpoints: {
    restart: 'hexclaw-native-restart-observer',
    real_client: 'dingtalk-real-client-observer',
    require_marker_and_digests: true,
    harness_may_create_checkpoint: false,
  },
  validate_side_effects: {
    sidecar_starts: 0,
    uploads: 0,
    sends: 0,
    provider_queries: 0,
  },
})

class HarnessError extends Error {
  constructor(code) {
    super(code)
    this.name = 'HarnessError'
    this.code = code
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

function integer(value, code) {
  if (!Number.isSafeInteger(value)) throw new HarnessError(code)
  return value
}

function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex')
}

function sha256Text(value) {
  return sha256Bytes(Buffer.from(String(value), 'utf8'))
}

function prefixedDigest(value) {
  return `sha256:${sha256Bytes(value)}`
}

function normalizedDigest(value, code) {
  const text = nonEmpty(value, code).toLowerCase()
  if (SHA256.test(text)) return text
  if (PREFIXED_SHA256.test(text)) return text.slice('sha256:'.length)
  throw new HarnessError(code)
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

function trimGoSpace(value) {
  return String(value ?? '').replace(
    /^[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/gu,
    '',
  )
}

function compareText(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right))
}

function stableBindingID(rule) {
  if (rule.id > 0) return `agent-rule:${rule.id}`
  const identity = [
    rule.platform,
    rule.instance_id,
    rule.user_id,
    rule.chat_id,
    rule.agent_name,
  ].join('\0')
  return `agent-rule:sha256:${sha256Text(identity)}`
}

function targetIdentity(target) {
  return `${target.platform}\0${target.instance_id}\0${target.chat_id}`
}

function targetDigest(target) {
  return sha256Text(targetIdentity(target))
}

function ensureNoLocalReference(value) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value)
  if (/(?:asset|file):\/\/|(?:^|["'\s])\/Users\/|[A-Za-z]:\\/u.test(serialized)) {
    throw new HarnessError('LOCAL_REFERENCE_FORBIDDEN')
  }
}

function ensureSafePDFName(value) {
  const name = nonEmpty(value, 'PDF_FILENAME_REQUIRED')
  if (
    /[\/\\\u0000-\u001f\u007f]/u.test(name) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(name) ||
    /[\[\]()<>!]/u.test(name) ||
    !name.toLowerCase().endsWith('.pdf')
  ) {
    throw new HarnessError('PDF_FILENAME_INVALID')
  }
  return name
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

function requiredEnv(env, name) {
  return nonEmpty(env[name], `MISSING_${name}`)
}

function validCapability(value) {
  const bytes = Buffer.byteLength(value)
  return bytes >= 32 && bytes <= 512 && !/[\p{Cc}\p{White_Space}]/u.test(value)
}

function loopbackOrigin(raw) {
  let value
  try {
    value = new URL(raw)
  } catch {
    throw new HarnessError('SIDECAR_URL_INVALID')
  }
  if (
    !['http:', 'https:'].includes(value.protocol) ||
    value.username ||
    value.password ||
    !['127.0.0.1', '[::1]', 'localhost'].includes(value.hostname) ||
    value.pathname !== '/' ||
    value.search ||
    value.hash
  ) {
    throw new HarnessError('SIDECAR_URL_INVALID')
  }
  return value.origin
}

function route(template, key, value) {
  return template.replace(`{${key}}`, encodeURIComponent(value))
}

function isSameTarget(left, right) {
  return (
    left.platform === right.platform &&
    left.instance_id === right.instance_id &&
    left.chat_id === right.chat_id
  )
}

function sameExactSet(actual, expected) {
  return canonicalJSON(actual) === canonicalJSON(expected)
}

export function phaseBudgetMilliseconds(env = process.env) {
  const requested = Number.parseInt(env.HEX_K12_DINGTALK_PDF_TIMEOUT_MS ?? '', 10)
  if (!Number.isFinite(requested) || requested <= 0) return DEFAULT_PHASE_MS
  return Math.min(requested, HARD_PHASE_MAX_MS)
}

export function validateContract(contract) {
  const root = object(contract, 'CONTRACT_INVALID')
  if (root.schema_version !== 1 || root.mode !== 'one_stage_under_30_minutes') {
    throw new HarnessError('CONTRACT_VERSION_INVALID')
  }
  const transport = object(root.transport, 'TRANSPORT_CONTRACT_INVALID')
  if (
    transport.product_operations !== 'hexclaw_public_http_api_only' ||
    transport.bound_instance_only !== true ||
    transport.dws_cli !== false ||
    transport.direct_dingtalk_http !== false ||
    transport.direct_store_read !== false ||
    transport.starts_sidecar !== false
  ) {
    throw new HarnessError('TRANSPORT_CONTRACT_INVALID')
  }
  const publicAPI = object(root.public_api, 'PUBLIC_API_CONTRACT_INVALID')
  const expectedAPI = {
    rules: '/api/v1/agents/rules',
    instances: '/api/v1/platforms/instances',
    snapshot: '/api/k12/weekly-practice/snapshots/{snapshot_id}',
    artifact: '/api/k12/print-artifacts/{artifact_id}/content',
    send: SEND_PATH,
    batch: BATCH_PATH,
    query: QUERY_PATH,
  }
  if (!sameExactSet(publicAPI, expectedAPI)) throw new HarnessError('PUBLIC_API_CONTRACT_INVALID')

  const delivery = object(root.delivery, 'DELIVERY_CONTRACT_INVALID')
  if (
    delivery.request_count !== 1 ||
    delivery.target_mode !== 'all_deduplicated_direct_physical_bindings' ||
    delivery.parts_per_target !== 2 ||
    !sameExactSet(delivery.part_order, ['markdown', 'artifact']) ||
    !sameExactSet(delivery.part_transport, ['sampleMarkdown', 'sampleFile']) ||
    delivery.artifact_mime !== 'application/pdf' ||
    delivery.outcome_unknown_action !== 'query_only' ||
    delivery.retry_allowed !== false ||
    delivery.all_artifacts_prepared_before_first_visible_send !== true
  ) {
    throw new HarnessError('DELIVERY_CONTRACT_INVALID')
  }
  const checkpoints = object(root.checkpoints, 'CHECKPOINT_CONTRACT_INVALID')
  if (
    checkpoints.restart !== 'hexclaw-native-restart-observer' ||
    checkpoints.real_client !== 'dingtalk-real-client-observer' ||
    checkpoints.require_marker_and_digests !== true ||
    checkpoints.harness_may_create_checkpoint !== false
  ) {
    throw new HarnessError('CHECKPOINT_CONTRACT_INVALID')
  }
  const validateSideEffects = object(
    root.validate_side_effects,
    'VALIDATE_SIDE_EFFECT_CONTRACT_INVALID',
  )
  if (
    validateSideEffects.sidecar_starts !== 0 ||
    validateSideEffects.uploads !== 0 ||
    validateSideEffects.sends !== 0 ||
    validateSideEffects.provider_queries !== 0
  ) {
    throw new HarnessError('VALIDATE_SIDE_EFFECT_CONTRACT_INVALID')
  }
  return {
    public_api: { ...publicAPI },
    delivery: {
      ...delivery,
      part_order: [...delivery.part_order],
      part_transport: [...delivery.part_transport],
    },
    validate_side_effects: { ...validateSideEffects },
    require_real_client_checkpoint: true,
    require_restart_checkpoint: true,
  }
}

export function runValidate() {
  const contract = validateContract(LIVE_CONTRACT)
  return {
    status: 'VALIDATED_OFFLINE_NOT_LIVE_PASS',
    live_pass: false,
    phase_budget_ms: phaseBudgetMilliseconds({}),
    side_effects: contract.validate_side_effects,
    required_live_evidence: [
      'installed_app_sha256',
      'frozen_snapshot_and_pdf_digest',
      'N_x_2_provider_receipts',
      'native_restart_checkpoint',
      'real_dingtalk_client_checkpoint',
    ],
  }
}

/**
 * 与生产的物理目标规范化、排序和去重保持同一语义；只做发送前快照比对，
 * 不参与渠道选择，也不会修改任何绑定。
 */
export function resolveDirectTargets(rules, agentName) {
  const owner = trimGoSpace(agentName)
  const normalized = array(rules, 'RULES_INVALID')
    .map((raw) => {
      const rule = object(raw, 'RULE_INVALID')
      return {
        id: Number.isSafeInteger(rule.id) ? Number(rule.id) : 0,
        platform: trimGoSpace(rule.platform).toLowerCase(),
        instance_id: trimGoSpace(rule.instance_id),
        user_id: trimGoSpace(rule.user_id),
        chat_id: trimGoSpace(rule.chat_id),
        agent_name: trimGoSpace(rule.agent_name),
      }
    })
    .filter(
      (rule) =>
        rule.agent_name === owner &&
        rule.platform !== '' &&
        rule.chat_id !== '' &&
        rule.chat_id.charCodeAt(0) >= 0x20,
    )
    .sort((left, right) => {
      for (const key of ['platform', 'instance_id', 'chat_id']) {
        const compared = compareText(left[key], right[key])
        if (compared !== 0) return compared
      }
      if (left.id > 0 && right.id > 0 && left.id !== right.id) return left.id - right.id
      return compareText(stableBindingID(left), stableBindingID(right))
    })

  const result = []
  for (const rule of normalized) {
    const candidate = {
      binding_id: stableBindingID(rule),
      platform: rule.platform,
      instance_id: rule.instance_id,
      chat_id: rule.chat_id,
    }
    if (result.length > 0 && isSameTarget(result.at(-1), candidate)) continue
    result.push(candidate)
  }
  return result
}

function validateCanonicalContent(raw, expected) {
  const content = object(raw, 'CANONICAL_CONTENT_REQUIRED')
  if (
    !CONTENT_ID.test(content.content_id ?? '') ||
    content.content_version !== '1.0' ||
    content.producer_kind !== 'k12' ||
    content.locale !== 'zh-CN' ||
    !PREFIXED_SHA256.test(content.source_digest ?? '') ||
    !String(content.markdown ?? '').includes(expected.marker) ||
    expected.marker_sha256 !== sha256Text(expected.marker)
  ) {
    throw new HarnessError('CANONICAL_CONTENT_INVALID')
  }
  const attachments = array(content.attachments, 'CANONICAL_PDF_REFERENCE_REQUIRED')
  if (attachments.length !== 1) throw new HarnessError('CANONICAL_PDF_REFERENCE_REQUIRED')
  const attachment = object(attachments[0], 'CANONICAL_PDF_REFERENCE_REQUIRED')
  if (
    attachment.mime !== 'application/pdf' ||
    normalizedDigest(attachment.digest, 'CANONICAL_PDF_DIGEST_INVALID') !== expected.pdf_sha256 ||
    attachment.asset_id !== `inline:${expected.pdf_sha256}` ||
    ensureSafePDFName(attachment.name) !==
      nonEmpty(attachment.alt_text, 'CANONICAL_PDF_ALT_REQUIRED')
  ) {
    throw new HarnessError('CANONICAL_PDF_REFERENCE_INVALID')
  }
  ensureNoLocalReference(content)
  const digestInput = {
    content_version: content.content_version,
    producer_kind: content.producer_kind,
    markdown: content.markdown,
    locale: content.locale,
    attachments: content.attachments,
  }
  const wantSourceDigest = prefixedDigest(Buffer.from(JSON.stringify(digestInput)))
  if (
    content.source_digest !== wantSourceDigest ||
    content.content_id !== `content:${wantSourceDigest.slice('sha256:'.length)}`
  ) {
    throw new HarnessError('CANONICAL_SOURCE_DIGEST_DRIFT')
  }
  return content
}

function validateManifest(raw, content, expected, projectedMarkdown) {
  const manifest = object(raw, 'CANONICAL_MANIFEST_REQUIRED')
  const capability = object(manifest.capability_snapshot, 'CAPABILITY_SNAPSHOT_REQUIRED')
  const parts = array(manifest.parts, 'CANONICAL_MANIFEST_PARTS_INVALID')
  if (
    !RENDER_ID.test(manifest.render_id ?? '') ||
    manifest.content_id !== content.content_id ||
    manifest.source_digest !== content.source_digest ||
    manifest.surface !== 'channel' ||
    capability.markdown !== true ||
    capability.attachments !== true ||
    nonEmpty(manifest.renderer_version, 'RENDERER_VERSION_REQUIRED') === '' ||
    parts.length !== 2 ||
    parts[0]?.kind !== 'markdown' ||
    parts[0]?.text !== projectedMarkdown ||
    !String(parts[0]?.text ?? '').includes(expected.marker) ||
    parts[1]?.kind !== 'artifact' ||
    parts[1]?.artifact_ref !== content.attachments[0].asset_id ||
    normalizedDigest(parts[1]?.artifact_digest, 'CANONICAL_MANIFEST_DRIFT') !==
      expected.pdf_sha256 ||
    parts[1]?.alt_text !== content.attachments[0].alt_text
  ) {
    throw new HarnessError('CANONICAL_MANIFEST_DRIFT')
  }
  ensureNoLocalReference(manifest)
  return manifest
}

function normalizeReceiptTarget(receipt) {
  const target = object(receipt.target, 'RECEIPT_TARGET_INVALID')
  return {
    binding_id: nonEmpty(receipt.binding_id, 'RECEIPT_BINDING_INVALID'),
    platform: trimGoSpace(target.platform).toLowerCase(),
    instance_id: trimGoSpace(target.instance_id),
    chat_id: trimGoSpace(target.chat_id),
  }
}

function deliveryIdentity(receipt) {
  return {
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
  }
}

export function assertBatchExactSet(rawBatch, expected) {
  const batch = object(rawBatch, 'BATCH_INVALID')
  const targets = array(expected.targets, 'EXPECTED_TARGETS_INVALID')
  if (targets.length === 0 || targets.some((target) => target.platform !== 'dingtalk')) {
    throw new HarnessError('DINGTALK_TARGETS_REQUIRED')
  }
  if (
    nonEmpty(batch.batch_id, 'BATCH_ID_REQUIRED') === '' ||
    batch.agent_name !== expected.agent_name ||
    batch.object_kind !== 'weekly_practice_snapshot' ||
    batch.object_id !== expected.snapshot_id ||
    batch.status !== 'delivered' ||
    !PREFIXED_SHA256.test(batch.content_digest ?? '')
  ) {
    throw new HarnessError('BATCH_IDENTITY_INVALID')
  }
  const receipts = array(batch.receipts, 'RECEIPTS_REQUIRED')
  if (receipts.length !== targets.length * 2) throw new HarnessError('RECEIPT_EXACT_SET_INVALID')

  const expectedTargetSet = targets.map((target) => ({ ...target }))
  const actualTargetSet = []
  const externalIDHashes = []
  const receiptIdentities = []
  const targetProofs = []
  let canonicalSourceDigest = ''
  let renderID = ''
  let pdfFilename = ''
  const seenExternalIDs = new Set()
  const seenDeliveryIDs = new Set()

  for (let index = 0; index < targets.length; index++) {
    const expectedTarget = targets[index]
    const markdownReceipt = object(receipts[index * 2], 'RECEIPT_INVALID')
    const fileReceipt = object(receipts[index * 2 + 1], 'RECEIPT_INVALID')
    const actualTarget = normalizeReceiptTarget(markdownReceipt)
    const fileTarget = normalizeReceiptTarget(fileReceipt)
    if (
      !sameExactSet(actualTarget, expectedTarget) ||
      !sameExactSet(fileTarget, expectedTarget) ||
      markdownReceipt.batch_ordinal !== index * 2 + 1 ||
      fileReceipt.batch_ordinal !== index * 2 + 2
    ) {
      throw new HarnessError('TARGET_EXACT_SET_DRIFT')
    }
    actualTargetSet.push(actualTarget)

    for (const [receipt, wantKind, wantMIME, wantOrdinal] of [
      [markdownReceipt, 'markdown', '', 1],
      [fileReceipt, 'artifact', 'application/pdf', 2],
    ]) {
      if (
        receipt.batch_id !== batch.batch_id ||
        receipt.agent_name !== expected.agent_name ||
        receipt.object_kind !== batch.object_kind ||
        receipt.object_id !== batch.object_id ||
        receipt.status !== 'delivered' ||
        receipt.part_kind !== wantKind ||
        (receipt.part_mime ?? '') !== wantMIME ||
        receipt.part_ordinal !== wantOrdinal ||
        !PREFIXED_SHA256.test(receipt.part_digest ?? '') ||
        !PREFIXED_SHA256.test(receipt.payload_digest ?? '') ||
        integer(receipt.attempt, 'RECEIPT_ATTEMPT_INVALID') < 1
      ) {
        throw new HarnessError('RECEIPT_IDENTITY_INVALID')
      }
      const deliveryID = nonEmpty(receipt.delivery_id, 'DELIVERY_ID_REQUIRED')
      const externalID = nonEmpty(receipt.external_message_id, 'EXTERNAL_MESSAGE_ID_REQUIRED')
      if (seenDeliveryIDs.has(deliveryID) || seenExternalIDs.has(externalID)) {
        throw new HarnessError('RECEIPT_IDENTITY_DUPLICATED')
      }
      seenDeliveryIDs.add(deliveryID)
      seenExternalIDs.add(externalID)
      externalIDHashes.push(sha256Text(externalID))
      receiptIdentities.push(deliveryIdentity(receipt))
    }

    if (
      prefixedDigest(Buffer.from(markdownReceipt.payload_json, 'utf8')) !==
      markdownReceipt.payload_digest
    ) {
      throw new HarnessError('PAYLOAD_DIGEST_DRIFT')
    }
    if (
      prefixedDigest(Buffer.from(fileReceipt.payload_json, 'utf8')) !== fileReceipt.payload_digest
    ) {
      throw new HarnessError('PAYLOAD_DIGEST_DRIFT')
    }
    ensureNoLocalReference(markdownReceipt.payload_json)
    ensureNoLocalReference(fileReceipt.payload_json)

    let markdownPayload
    let filePayload
    let manifestFromReceipt
    try {
      markdownPayload = JSON.parse(markdownReceipt.payload_json)
      filePayload = JSON.parse(fileReceipt.payload_json)
      manifestFromReceipt = JSON.parse(markdownReceipt.render_manifest_json)
    } catch {
      throw new HarnessError('FROZEN_PAYLOAD_JSON_INVALID')
    }
    let fileManifestFromReceipt
    try {
      fileManifestFromReceipt = JSON.parse(fileReceipt.render_manifest_json)
    } catch {
      throw new HarnessError('FROZEN_PAYLOAD_JSON_INVALID')
    }
    if (
      markdownPayload.kind !== 'markdown' ||
      markdownPayload.ordinal !== 1 ||
      normalizedDigest(markdownPayload.digest, 'MARKDOWN_DIGEST_INVALID') !==
        sha256Text(markdownPayload.message_content?.markdown ?? '') ||
      markdownReceipt.part_digest !== markdownPayload.digest
    ) {
      throw new HarnessError('MARKDOWN_PART_INVALID')
    }
    const content = validateCanonicalContent(markdownPayload.message_content, expected)
    const manifest = validateManifest(
      markdownPayload.render_manifest,
      content,
      expected,
      markdownPayload.text,
    )
    if (
      canonicalJSON(manifest) !== canonicalJSON(manifestFromReceipt) ||
      canonicalJSON(fileManifestFromReceipt) !== canonicalJSON(manifest) ||
      canonicalJSON(filePayload.message_content) !== canonicalJSON(content) ||
      canonicalJSON(filePayload.render_manifest) !== canonicalJSON(manifest)
    ) {
      throw new HarnessError('CANONICAL_MANIFEST_DRIFT')
    }
    if (
      filePayload.kind !== 'artifact' ||
      filePayload.mime !== 'application/pdf' ||
      filePayload.ordinal !== 2 ||
      normalizedDigest(filePayload.digest, 'PDF_PART_DIGEST_INVALID') !== expected.pdf_sha256 ||
      fileReceipt.part_digest !== filePayload.digest
    ) {
      throw new HarnessError('PDF_PART_INVALID')
    }
    const attachment = object(filePayload.attachment, 'PDF_ATTACHMENT_REQUIRED')
    if (
      !sameExactSet(Object.keys(attachment).sort(), ['Data', 'MIME', 'Name']) ||
      attachment.MIME !== 'application/pdf'
    ) {
      throw new HarnessError('PDF_ATTACHMENT_INVALID')
    }
    const pdfBytes = decodeCanonicalBase64(attachment.Data, 'PDF_ATTACHMENT_BYTES_INVALID')
    if (
      sha256Bytes(pdfBytes) !== expected.pdf_sha256 ||
      !pdfBytes.subarray(0, 5).equals(Buffer.from('%PDF-')) ||
      !pdfBytes.equals(expected.pdf_bytes)
    ) {
      throw new HarnessError('PDF_BYTES_DRIFT')
    }
    const filename = ensureSafePDFName(attachment.Name)
    ensureNoLocalReference(filename)
    if (filename !== content.attachments[0].name) throw new HarnessError('PDF_FILENAME_DRIFT')
    if (canonicalSourceDigest && canonicalSourceDigest !== content.source_digest) {
      throw new HarnessError('CANONICAL_SOURCE_EXACT_SET_DRIFT')
    }
    if (renderID && renderID !== manifest.render_id) {
      throw new HarnessError('CANONICAL_MANIFEST_EXACT_SET_DRIFT')
    }
    canonicalSourceDigest = content.source_digest
    renderID = manifest.render_id
    pdfFilename = filename
    targetProofs.push({
      target_sha256: targetDigest(expectedTarget),
      markdown_external_message_id_sha256: sha256Text(markdownReceipt.external_message_id),
      file_external_message_id_sha256: sha256Text(fileReceipt.external_message_id),
    })
  }
  if (!sameExactSet(actualTargetSet, expectedTargetSet)) {
    throw new HarnessError('TARGET_EXACT_SET_DRIFT')
  }

  const targetSetHashes = targets.map(targetDigest).sort()
  const externalSorted = [...externalIDHashes].sort()
  const receiptSetSHA = sha256Text(canonicalJSON(receiptIdentities))
  return {
    target_count: targets.length,
    receipt_count: receipts.length,
    part_transports: ['sampleMarkdown', 'sampleFile'],
    marker_sha256: expected.marker_sha256,
    pdf_sha256: expected.pdf_sha256,
    pdf_filename_sha256: sha256Text(pdfFilename),
    canonical_source_digest: canonicalSourceDigest,
    render_id: renderID,
    target_set_sha256: sha256Text(canonicalJSON(targetSetHashes)),
    receipt_set_sha256: receiptSetSHA,
    external_message_id_set_sha256: sha256Text(canonicalJSON(externalSorted)),
    external_message_id_sha256: externalSorted,
    target_proofs: targetProofs.sort((left, right) =>
      compareText(left.target_sha256, right.target_sha256),
    ),
  }
}

export function assertRestartCheckpoint(rawCheckpoint, expected) {
  const checkpoint = object(rawCheckpoint, 'RESTART_CHECKPOINT_INVALID')
  const batch = object(expected.batch, 'BATCH_INVALID')
  if (
    checkpoint.schema_version !== 1 ||
    checkpoint.source !== 'hexclaw-native-restart-observer' ||
    checkpoint.marker_sha256 !== sha256Text(expected.marker) ||
    checkpoint.batch_id_sha256 !== sha256Text(batch.batch_id) ||
    checkpoint.content_digest !== batch.content_digest ||
    !SHA256.test(checkpoint.process_before_sha256 ?? '') ||
    !SHA256.test(checkpoint.process_after_sha256 ?? '')
  ) {
    throw new HarnessError('RESTART_CHECKPOINT_IDENTITY_INVALID')
  }
  if (checkpoint.process_before_sha256 === checkpoint.process_after_sha256) {
    throw new HarnessError('RESTART_PROCESS_IDENTITY_INVALID')
  }
  if (
    checkpoint.read_method !== 'GET' ||
    checkpoint.read_path_sha256 !== sha256Text(route(BATCH_PATH, 'batch_id', batch.batch_id)) ||
    checkpoint.observed_receipt_set_sha256 !== expected.delivery.receipt_set_sha256 ||
    checkpoint.observed_external_message_id_set_sha256 !==
      expected.delivery.external_message_id_set_sha256 ||
    checkpoint.send_calls !== 0 ||
    checkpoint.upload_calls !== 0 ||
    checkpoint.retry_calls !== 0
  ) {
    throw new HarnessError('RESTART_NOT_READ_ONLY')
  }
  const observedAt = nonEmpty(checkpoint.observed_at, 'RESTART_OBSERVED_AT_REQUIRED')
  const observedAtMS = Date.parse(observedAt)
  if (!Number.isFinite(observedAtMS) || observedAtMS < Number(batch.created_at ?? 0) * 1_000) {
    throw new HarnessError('RESTART_OBSERVED_AT_INVALID')
  }
  return {
    source: checkpoint.source,
    process_changed: true,
    read_only: true,
    observed_at: observedAt,
  }
}

async function safeEvidenceFile(pathname, evidenceRoot, wantDigest, code) {
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
    code.endsWith('_SCREENSHOT') &&
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
}

export async function assertClientCheckpoint(rawCheckpoint, expected) {
  const checkpoint = object(rawCheckpoint, 'REAL_CLIENT_CHECKPOINT_INVALID')
  const batch = object(expected.batch, 'BATCH_INVALID')
  const client = nonEmpty(checkpoint.client, 'REAL_CLIENT_KIND_REQUIRED')
  if (
    checkpoint.schema_version !== 1 ||
    checkpoint.source !== 'dingtalk-real-client-observer' ||
    !['ios', 'android', 'desktop'].includes(client) ||
    checkpoint.marker !== expected.marker ||
    checkpoint.marker_sha256 !== sha256Text(expected.marker) ||
    checkpoint.batch_id_sha256 !== sha256Text(batch.batch_id) ||
    checkpoint.content_digest !== batch.content_digest ||
    checkpoint.pdf_sha256 !== expected.pdf_sha256 ||
    checkpoint.pdf_filename_sha256 !== expected.delivery.pdf_filename_sha256 ||
    checkpoint.target_set_sha256 !== expected.delivery.target_set_sha256
  ) {
    throw new HarnessError('REAL_CLIENT_CHECKPOINT_IDENTITY_INVALID')
  }
  const observations = array(checkpoint.observations, 'REAL_CLIENT_OBSERVATIONS_REQUIRED')
  if (observations.length !== expected.delivery.target_count) {
    throw new HarnessError('REAL_CLIENT_OBSERVATION_EXACT_SET_INVALID')
  }
  const wantProofs = [...expected.delivery.target_proofs].sort((left, right) =>
    compareText(left.target_sha256, right.target_sha256),
  )
  const observedProofs = []
  for (const rawObservation of observations) {
    const observation = object(rawObservation, 'REAL_CLIENT_OBSERVATION_INVALID')
    const proof = {
      target_sha256: nonEmpty(observation.target_sha256, 'REAL_CLIENT_TARGET_DIGEST_REQUIRED'),
      markdown_external_message_id_sha256: nonEmpty(
        observation.markdown_external_message_id_sha256,
        'REAL_CLIENT_EXTERNAL_ID_REQUIRED',
      ),
      file_external_message_id_sha256: nonEmpty(
        observation.file_external_message_id_sha256,
        'REAL_CLIENT_EXTERNAL_ID_REQUIRED',
      ),
    }
    for (const value of Object.values(proof)) {
      if (!SHA256.test(value)) throw new HarnessError('REAL_CLIENT_DIGEST_INVALID')
    }
    if (
      observation.markdown_marker_visible !== true ||
      observation.pdf_filename_visible !== true ||
      observation.pdf_opened !== true
    ) {
      throw new HarnessError('REAL_CLIENT_VISIBLE_EVIDENCE_REQUIRED')
    }
    await safeEvidenceFile(
      nonEmpty(observation.markdown_screenshot_path, 'MARKDOWN_SCREENSHOT_REQUIRED'),
      expected.evidence_root,
      observation.markdown_screenshot_sha256,
      'MARKDOWN_SCREENSHOT',
    )
    await safeEvidenceFile(
      nonEmpty(observation.pdf_screenshot_path, 'PDF_SCREENSHOT_REQUIRED'),
      expected.evidence_root,
      observation.pdf_screenshot_sha256,
      'PDF_SCREENSHOT',
    )
    observedProofs.push(proof)
  }
  observedProofs.sort((left, right) => compareText(left.target_sha256, right.target_sha256))
  if (!sameExactSet(observedProofs, wantProofs)) {
    throw new HarnessError('REAL_CLIENT_EXTERNAL_ID_DRIFT')
  }
  const observedAt = nonEmpty(checkpoint.observed_at, 'REAL_CLIENT_OBSERVED_AT_REQUIRED')
  const observedAtMS = Date.parse(observedAt)
  if (!Number.isFinite(observedAtMS) || observedAtMS < Number(batch.created_at ?? 0) * 1_000) {
    throw new HarnessError('REAL_CLIENT_OBSERVED_AT_INVALID')
  }
  return {
    source: checkpoint.source,
    client,
    observation_count: observations.length,
    markdown_visible: true,
    pdf_opened: true,
    observed_at: observedAt,
  }
}

async function sha256File(pathname) {
  const hash = createHash('sha256')
  await new Promise((resolveStream, rejectStream) => {
    const stream = createReadStream(pathname)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.once('error', rejectStream)
    stream.once('end', resolveStream)
  })
  return hash.digest('hex')
}

async function assertPrivateJSONFile(pathname, code) {
  const info = await lstat(pathname)
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    info.size > 1_048_576
  ) {
    throw new HarnessError(code)
  }
  let value
  try {
    value = JSON.parse(await readFile(pathname, 'utf8'))
  } catch {
    throw new HarnessError(code)
  }
  return value
}

async function awaitCheckpoint(env, envName, deadline) {
  const pathname = requiredEnv(env, envName)
  while (Date.now() < deadline) {
    try {
      return await assertPrivateJSONFile(pathname, `${envName}_INVALID`)
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, CHECKPOINT_POLL_MS))
  }
  throw new HarnessError(`${envName}_TIMEOUT`)
}

async function apiJSON(api, method, pathname, token, data) {
  let response
  try {
    response = await api.fetch(pathname, {
      method,
      data,
      headers: { Authorization: `Bearer ${token}` },
      maxRedirects: 0,
      timeout: REQUEST_TIMEOUT_MS,
    })
  } catch {
    throw new HarnessError('PUBLIC_API_REQUEST_FAILED')
  }
  if (!response.ok()) throw new HarnessError(`PUBLIC_API_HTTP_${response.status()}`)
  try {
    return await response.json()
  } catch {
    throw new HarnessError('PUBLIC_API_JSON_INVALID')
  }
}

async function apiBytes(api, pathname, token) {
  let response
  try {
    response = await api.get(pathname, {
      headers: { Authorization: `Bearer ${token}` },
      maxRedirects: 0,
      timeout: REQUEST_TIMEOUT_MS,
    })
  } catch {
    throw new HarnessError('PUBLIC_ARTIFACT_REQUEST_FAILED')
  }
  if (!response.ok()) throw new HarnessError(`PUBLIC_ARTIFACT_HTTP_${response.status()}`)
  return { bytes: Buffer.from(await response.body()), headers: response.headers() }
}

async function assertInstalledRuntime(api, token, env) {
  const binaryPath = requiredEnv(env, 'HEX_K12_LIVE_APP_BINARY')
  const binaryInfo = await stat(binaryPath)
  if (!binaryInfo.isFile()) throw new HarnessError('INSTALLED_BINARY_INVALID')
  const binaryDigest = await sha256File(binaryPath)
  if (
    binaryDigest !==
    normalizedDigest(requiredEnv(env, 'HEX_K12_LIVE_APP_SHA256'), 'APP_SHA_INVALID')
  ) {
    throw new HarnessError('INSTALLED_BINARY_DIGEST_DRIFT')
  }
  const health = await apiJSON(api, 'GET', '/health', token)
  if (health?.status !== 'healthy') throw new HarnessError('SIDECAR_UNHEALTHY')
  const version = await apiJSON(api, 'GET', '/api/v1/version', token)
  if (version?.version !== requiredEnv(env, 'HEX_K12_LIVE_EXPECTED_VERSION')) {
    throw new HarnessError('SIDECAR_VERSION_DRIFT')
  }
  return {
    binary_name: basename(binaryPath),
    binary_sha256: binaryDigest,
    sidecar_version: version.version,
    engine: version.engine,
    engine_version: version.engine_version,
  }
}

async function assertTargetInstances(api, token, targets) {
  const response = await apiJSON(api, 'GET', '/api/v1/platforms/instances', token)
  const instances = array(response.instances ?? [], 'PLATFORM_INSTANCES_INVALID')
  const running = instances.filter(
    (instance) => instance.enabled === true && instance.status === 'running',
  )
  const resolvedNames = new Set()
  for (const target of targets) {
    const candidates = target.instance_id
      ? running.filter(
          (instance) => instance.id === target.instance_id || instance.name === target.instance_id,
        )
      : running.filter((instance) => instance.provider === target.platform)
    if (candidates.length !== 1 || candidates[0].provider !== target.platform) {
      throw new HarnessError('BOUND_DINGTALK_INSTANCE_INVALID')
    }
    const name = candidates[0].name
    if (resolvedNames.has(name)) continue
    resolvedNames.add(name)
    const health = await apiJSON(
      api,
      'GET',
      `/api/v1/platforms/instances/${encodeURIComponent(name)}/health`,
      token,
    )
    if (
      health?.name !== name ||
      health?.provider !== target.platform ||
      health?.status !== 'running' ||
      health?.healthy !== true
    ) {
      throw new HarnessError('BOUND_DINGTALK_INSTANCE_UNHEALTHY')
    }
  }
}

function frozenReceiptIdentity(batch) {
  return array(batch.receipts, 'RECEIPTS_REQUIRED').map(deliveryIdentity)
}

function assertFrozenIdentity(before, after) {
  if (
    before.batch_id !== after.batch_id ||
    before.agent_name !== after.agent_name ||
    before.object_kind !== after.object_kind ||
    before.object_id !== after.object_id ||
    before.dedupe_key !== after.dedupe_key ||
    before.content_digest !== after.content_digest ||
    canonicalJSON(frozenReceiptIdentity(before)) !== canonicalJSON(frozenReceiptIdentity(after))
  ) {
    throw new HarnessError('QUERY_MUTATED_FROZEN_IDENTITY')
  }
}

async function convergeBatch(api, token, agentName, initial, deadline) {
  let batch = initial
  let queryCalls = 0
  const frozen = structuredClone(initial)
  while (Date.now() < deadline) {
    if (batch.status === 'delivered') return { batch, query_calls: queryCalls }
    if (batch.status === 'failed' || batch.status === 'partial_failed') {
      throw new HarnessError('DELIVERY_TERMINAL_FAILURE')
    }
    const batchPath = `${route(BATCH_PATH, 'batch_id', batch.batch_id)}?agent=${encodeURIComponent(agentName)}`
    batch = await apiJSON(api, 'GET', batchPath, token)
    assertFrozenIdentity(frozen, batch)
    if (['pending', 'sending', 'outcome_unknown'].includes(batch.status)) {
      batch = await apiJSON(api, 'POST', route(QUERY_PATH, 'batch_id', batch.batch_id), token, {
        agent: agentName,
      })
      queryCalls++
      assertFrozenIdentity(frozen, batch)
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, CHECKPOINT_POLL_MS))
  }
  throw new HarnessError('DELIVERY_CONVERGENCE_TIMEOUT')
}

function liveEnvironment(env) {
  if (
    env.HEX_K12_LIVE_RUN !== '1' ||
    env.DINGTALK_LIVE_SEND !== '1' ||
    env.DINGTALK_LIVE_CONFIRM !== 'SEND_TO_ALL_CURRENT_AGENT_BINDINGS'
  ) {
    throw new HarnessError('LIVE_SEND_GATE_REQUIRED')
  }
  const token = requiredEnv(env, 'HEXCLAW_SIDECAR_CAPABILITY_TOKEN')
  if (!validCapability(token)) throw new HarnessError('SIDECAR_CAPABILITY_INVALID')
  const marker = requiredEnv(env, 'HEX_K12_LIVE_MARKER')
  if (marker.length < 16 || marker.length > 160) throw new HarnessError('LIVE_MARKER_INVALID')
  return {
    sidecar_origin: loopbackOrigin(requiredEnv(env, 'HEX_K12_LIVE_SIDECAR_URL')),
    token,
    agent_name: requiredEnv(env, 'HEX_K12_LIVE_AGENT'),
    snapshot_id: requiredEnv(env, 'HEX_K12_LIVE_WEEKLY_SNAPSHOT_ID'),
    snapshot_digest: normalizedDigest(
      requiredEnv(env, 'HEX_K12_LIVE_WEEKLY_SNAPSHOT_DIGEST'),
      'SNAPSHOT_DIGEST_INVALID',
    ),
    artifact_id: requiredEnv(env, 'HEX_K12_LIVE_WEEKLY_ARTIFACT_ID'),
    pdf_sha256: normalizedDigest(
      requiredEnv(env, 'HEX_K12_LIVE_WEEKLY_PDF_SHA256'),
      'PDF_DIGEST_INVALID',
    ),
    idempotency_key: requiredEnv(env, 'HEX_K12_LIVE_IDEMPOTENCY_KEY'),
    marker,
    evidence_root: requiredEnv(env, 'HEX_K12_LIVE_EVIDENCE_ROOT'),
  }
}

async function runLive(env = process.env) {
  validateContract(LIVE_CONTRACT)
  const runtime = liveEnvironment(env)
  const deadline = Date.now() + phaseBudgetMilliseconds(env)
  const rootInfo = await lstat(runtime.evidence_root)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || (rootInfo.mode & 0o077) !== 0) {
    throw new HarnessError('EVIDENCE_ROOT_UNSAFE')
  }

  const { request: playwrightRequest } = await import('@playwright/test')
  const api = await playwrightRequest.newContext({ baseURL: runtime.sidecar_origin })
  try {
    const installed = await assertInstalledRuntime(api, runtime.token, env)
    const rulesResponse = await apiJSON(api, 'GET', '/api/v1/agents/rules', runtime.token)
    const targets = resolveDirectTargets(rulesResponse.rules ?? [], runtime.agent_name)
    if (targets.length === 0 || targets.some((target) => target.platform !== 'dingtalk')) {
      throw new HarnessError('DINGTALK_TARGETS_REQUIRED')
    }
    await assertTargetInstances(api, runtime.token, targets)

    const snapshot = await apiJSON(
      api,
      'GET',
      `${route(LIVE_CONTRACT.public_api.snapshot, 'snapshot_id', runtime.snapshot_id)}?agent=${encodeURIComponent(runtime.agent_name)}`,
      runtime.token,
    )
    if (
      snapshot?.snapshot_id !== runtime.snapshot_id ||
      snapshot?.artifact_id !== runtime.artifact_id ||
      normalizedDigest(snapshot?.snapshot_digest, 'SNAPSHOT_DIGEST_INVALID') !==
        runtime.snapshot_digest ||
      !array(snapshot?.tracks, 'WEEKLY_TRACKS_INVALID').some((track) =>
        array(track?.items, 'WEEKLY_ITEMS_INVALID').some(
          (item) =>
            item?.verification?.status === 'verified' &&
            String(item?.prompt_markdown ?? '').includes(runtime.marker),
        ),
      )
    ) {
      throw new HarnessError('FROZEN_SNAPSHOT_IDENTITY_DRIFT')
    }
    const artifactPath = `${route(LIVE_CONTRACT.public_api.artifact, 'artifact_id', runtime.artifact_id)}?agent=${encodeURIComponent(runtime.agent_name)}`
    const artifact = await apiBytes(api, artifactPath, runtime.token)
    if (
      artifact.headers['content-type']?.split(';')[0]?.trim() !== 'application/pdf' ||
      normalizedDigest(artifact.headers['x-content-sha256'], 'PDF_HEADER_DIGEST_INVALID') !==
        runtime.pdf_sha256 ||
      sha256Bytes(artifact.bytes) !== runtime.pdf_sha256 ||
      !artifact.bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))
    ) {
      throw new HarnessError('FROZEN_PDF_IDENTITY_DRIFT')
    }

    // 唯一发送请求：幂等键绑定本次预冻结 marker，不能在 runner 内重放或重试。
    const initialBatch = await apiJSON(
      api,
      'POST',
      route(SEND_PATH, 'snapshot_id', runtime.snapshot_id),
      runtime.token,
      { agent: runtime.agent_name, idempotency_key: runtime.idempotency_key },
    )
    const converged = await convergeBatch(
      api,
      runtime.token,
      runtime.agent_name,
      initialBatch,
      deadline,
    )
    const delivery = assertBatchExactSet(converged.batch, {
      agent_name: runtime.agent_name,
      snapshot_id: runtime.snapshot_id,
      marker: runtime.marker,
      marker_sha256: sha256Text(runtime.marker),
      pdf_sha256: runtime.pdf_sha256,
      pdf_bytes: artifact.bytes,
      targets,
    })

    // 外部原生重启观察器以这条非敏感 handoff 定位原批次；不会暴露绑定或能力令牌。
    process.stdout.write(
      `${JSON.stringify({
        status: 'AWAITING_EXTERNAL_CHECKPOINTS',
        batch_id: converged.batch.batch_id,
        marker_sha256: sha256Text(runtime.marker),
        pdf_sha256: runtime.pdf_sha256,
        target_set_sha256: delivery.target_set_sha256,
        receipt_set_sha256: delivery.receipt_set_sha256,
      })}\n`,
    )

    // 两份 checkpoint 均由 runner 外部的真实边界观察器产生；runner 只读且不会伪造。
    const restartRaw = await awaitCheckpoint(env, RESTART_CHECKPOINT, deadline)
    const restart = assertRestartCheckpoint(restartRaw, {
      batch: converged.batch,
      marker: runtime.marker,
      delivery,
    })
    const clientRaw = await awaitCheckpoint(env, CLIENT_CHECKPOINT, deadline)
    const client = await assertClientCheckpoint(clientRaw, {
      evidence_root: runtime.evidence_root,
      batch: converged.batch,
      marker: runtime.marker,
      pdf_sha256: runtime.pdf_sha256,
      delivery,
    })

    return {
      status: 'PASS',
      installed,
      marker_sha256: sha256Text(runtime.marker),
      snapshot_id_sha256: sha256Text(runtime.snapshot_id),
      snapshot_digest: `sha256:${runtime.snapshot_digest}`,
      artifact_id_sha256: sha256Text(runtime.artifact_id),
      pdf_sha256: runtime.pdf_sha256,
      batch_id_sha256: sha256Text(converged.batch.batch_id),
      content_digest: converged.batch.content_digest,
      delivery,
      outcome_unknown_query_calls: converged.query_calls,
      restart,
      real_client: client,
      preparation_barrier: {
        required: true,
        provider_resource_redacted_by_public_api: true,
        release_binary_sha256: installed.binary_sha256,
      },
    }
  } finally {
    await api.dispose()
  }
}

async function main() {
  const phase = process.argv[2] ?? 'validate'
  if (!['validate', 'run'].includes(phase) || process.argv.length > 3) {
    throw new HarnessError('INVALID_PHASE')
  }
  const result = phase === 'validate' ? runValidate() : await runLive(process.env)
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(SCRIPT_PATH)) {
  main().catch((error) => {
    process.stderr.write(`${error?.code ?? 'UNEXPECTED_FAILURE'}\n`)
    process.exitCode = 1
  })
}
