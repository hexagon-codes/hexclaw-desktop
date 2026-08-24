#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFile as execFileCallback, spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { chromium, request as playwrightRequest } from '@playwright/test'
import { createServer as createViteServer } from 'vite'

const execFile = promisify(execFileCallback)
const SCRIPT_PATH = fileURLToPath(import.meta.url)
const LIVE_ROOT = dirname(SCRIPT_PATH)
const DESKTOP_ROOT = resolve(LIVE_ROOT, '../..')
const DEFAULT_DOCS_ROOT = resolve(DESKTOP_ROOT, '../hexclaw-docs')
const CONTRACT_PATH = resolve(LIVE_ROOT, 'k12-dingtalk-photo-grading-headless.contract.json')
const ANNOTATION_ORACLE_PATH = resolve(LIVE_ROOT, 'k12-photo-annotation-coverage.ts')
const INBOUND_QUERY_PATH = '/api/k12/dingtalk-inbound'
const EXPECTED_PROVIDER = 'hexclaw-gpt'
const EXPECTED_MODEL = 'gpt-5.6-sol'
const PHOTO_REPLY_OBJECT_KIND = 'dingtalk_photo_grading_reply'
const PHOTO_REPLY_OBJECT_ID_PREFIX = 'photo-reply-'
const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
const HARD_PHASE_MAX_MS = 29 * 60_000
const DEFAULT_PHASE_MS = 24 * 60_000
const REQUEST_TIMEOUT_MS = 90_000
const START_TIMEOUT_MS = 90_000
const PENDING_EXIT_CODE = 3
const SHA256 = /^[a-f0-9]{64}$/u
const PREFIXED_SHA256 = /^sha256:[a-f0-9]{64}$/u
const HAN = /[\u3400-\u9fff\uf900-\ufaff]/u

export const PHASES = Object.freeze([
  'validate',
  'prepare',
  'admit-clear',
  'verify-clear',
  'admit-messy',
  'verify-messy',
  'admit-exif6',
  'restart-admission',
  'restart-grading',
  'restart-before-send',
  'restart-after-send',
  'verify-exif6',
  'restart',
  'replay',
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

export function resolvePhase(args) {
  if (!Array.isArray(args) || args.length === 0) return 'validate'
  if (args.length !== 1 || !PHASES.includes(args[0])) throw new HarnessError('INVALID_PHASE')
  return args[0]
}

export function phaseBudgetMilliseconds(env = process.env) {
  const requested = Number.parseInt(env.HEXCLAW_DINGTALK_PHOTO_PHASE_TIMEOUT_MS ?? '', 10)
  if (!Number.isFinite(requested) || requested <= 0) return DEFAULT_PHASE_MS
  return Math.min(requested, HARD_PHASE_MAX_MS)
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

function decodeCanonicalBase64(value, code) {
  const text = nonEmpty(value, code)
  if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(text)) {
    throw new HarnessError(code)
  }
  const bytes = Buffer.from(text, 'base64')
  if (bytes.length === 0 || bytes.toString('base64') !== text) throw new HarnessError(code)
  return bytes
}

const MANUAL_ORACLE_STATUSES = new Set([
  'correct',
  'correct_with_process_issue',
  'wrong',
  'unanswered',
])

const SOURCE_IDENTITY_FIELDS = Object.freeze([
  'source_number_path',
  'display_label',
  'source_section_path',
  'source_section_label',
  'system_section_ordinal',
  'system_display_label',
])

function sourceIdentityProjection(
  value,
  code = 'FIXTURE_SOURCE_ORACLE_INVALID',
  requireExactKeys = true,
) {
  const identity = object(value, code)
  if (
    requireExactKeys &&
    canonicalJSON(Object.keys(identity).sort()) !==
      canonicalJSON([...SOURCE_IDENTITY_FIELDS].sort())
  ) {
    throw new HarnessError(code)
  }
  const projected = {
    source_number_path: array(identity.source_number_path, code).map((part) =>
      nonEmpty(part, code),
    ),
    display_label: typeof identity.display_label === 'string' ? identity.display_label : null,
    source_section_path: array(identity.source_section_path, code).map((part) =>
      nonEmpty(part, code),
    ),
    source_section_label: nonEmpty(identity.source_section_label, code),
    system_section_ordinal: identity.system_section_ordinal,
    system_display_label:
      typeof identity.system_display_label === 'string' ? identity.system_display_label : null,
  }
  if (
    projected.display_label === null ||
    projected.system_display_label === null ||
    !Number.isInteger(projected.system_section_ordinal) ||
    projected.system_section_ordinal < 0
  ) {
    throw new HarnessError(code)
  }
  return projected
}

function trustedBBoxProjection(value) {
  const bbox = object(value, 'FIXTURE_REGION_ORACLE_INVALID')
  if (canonicalJSON(Object.keys(bbox).sort()) !== canonicalJSON(['h', 'w', 'x', 'y'])) {
    throw new HarnessError('FIXTURE_REGION_ORACLE_INVALID')
  }
  for (const field of ['x', 'y', 'w', 'h']) {
    if (!Number.isFinite(bbox[field]) || bbox[field] < 0 || bbox[field] > 1) {
      throw new HarnessError('FIXTURE_REGION_ORACLE_INVALID')
    }
  }
  if (bbox.w <= 0 || bbox.h <= 0 || bbox.x + bbox.w > 1 || bbox.y + bbox.h > 1) {
    throw new HarnessError('FIXTURE_REGION_ORACLE_INVALID')
  }
  return { x: bbox.x, y: bbox.y, w: bbox.w, h: bbox.h }
}

function manualOracleProjection(value, sourceValue, regionValue) {
  const oracle = object(value, 'FIXTURE_ORACLE_INVALID')
  const sources = object(sourceValue, 'FIXTURE_SOURCE_ORACLE_INVALID')
  const regions = object(regionValue, 'FIXTURE_REGION_ORACLE_INVALID')
  const expectedKeys = Array.from({ length: 16 }, (_, index) => `Q${index + 1}`)
  if (
    canonicalJSON(Object.keys(oracle).sort()) !== canonicalJSON([...expectedKeys].sort()) ||
    canonicalJSON(Object.keys(sources).sort()) !== canonicalJSON([...expectedKeys].sort()) ||
    canonicalJSON(Object.keys(regions).sort()) !== canonicalJSON([...expectedKeys].sort())
  ) {
    throw new HarnessError('FIXTURE_ORACLE_INVALID')
  }
  return expectedKeys.map((question) => {
    const status = oracle[question]
    if (!MANUAL_ORACLE_STATUSES.has(status)) throw new HarnessError('FIXTURE_ORACLE_INVALID')
    return {
      question,
      status,
      source_identity: sourceIdentityProjection(sources[question]),
      bbox: trustedBBoxProjection(regions[question]),
    }
  })
}

function manualOracleCounts(items) {
  const counts = { green: 0, purple: 0, red: 0, no_mark: 0 }
  for (const item of items) {
    if (item.status === 'correct') counts.green += 1
    else if (item.status === 'correct_with_process_issue') counts.purple += 1
    else if (item.status === 'wrong') counts.red += 1
    else counts.no_mark += 1
  }
  return counts
}

export function exif6CornerMapping(encodedWidth, encodedHeight) {
  if (
    !Number.isInteger(encodedWidth) ||
    !Number.isInteger(encodedHeight) ||
    encodedWidth < 1 ||
    encodedHeight < 1
  ) {
    throw new HarnessError('EXIF_CORNER_MAPPING_INVALID')
  }
  return [
    {
      encoded: 'top_left',
      encoded_xy: [0, 0],
      canonical: 'top_right',
      canonical_xy: [encodedHeight - 1, 0],
    },
    {
      encoded: 'top_right',
      encoded_xy: [encodedWidth - 1, 0],
      canonical: 'bottom_right',
      canonical_xy: [encodedHeight - 1, encodedWidth - 1],
    },
    {
      encoded: 'bottom_right',
      encoded_xy: [encodedWidth - 1, encodedHeight - 1],
      canonical: 'bottom_left',
      canonical_xy: [0, encodedWidth - 1],
    },
    {
      encoded: 'bottom_left',
      encoded_xy: [0, encodedHeight - 1],
      canonical: 'top_left',
      canonical_xy: [0, 0],
    },
  ]
}

function fixtureProjection(value, key, expectedItems) {
  const fixture = object(value, 'FIXTURE_CONTRACT_INVALID')
  if (
    !SHA256.test(fixture.sha256 ?? '') ||
    !Number.isInteger(fixture.size_bytes) ||
    fixture.size_bytes < 1
  )
    throw new HarnessError('FIXTURE_CONTRACT_INVALID')
  const expectedCounts = object(fixture.expected_counts, 'FIXTURE_ORACLE_INVALID')
  for (const tone of ['green', 'purple', 'red', 'no_mark']) {
    if (!Number.isInteger(expectedCounts[tone]) || expectedCounts[tone] < 0) {
      throw new HarnessError('FIXTURE_ORACLE_INVALID')
    }
  }
  if (canonicalJSON(manualOracleCounts(expectedItems)) !== canonicalJSON(expectedCounts)) {
    throw new HarnessError('FIXTURE_ORACLE_INVALID')
  }
  if (key === 'exif6') {
    const derivation = object(fixture.derivation, 'EXIF_DERIVATION_CONTRACT_INVALID')
    const canonical = object(fixture.canonical, 'EXIF_CANONICAL_CONTRACT_INVALID')
    const frozenCorners = exif6CornerMapping(fixture.encoded_width, fixture.encoded_height)
    if (
      fixture.derived_from !== 'tests/live/k12-photo-exif6-fixture.go' ||
      derivation.tool !== 'go' ||
      derivation.fixture_source !== 'tests/live/k12-photo-exif6-fixture.go' ||
      derivation.jpeg_quality !== 94 ||
      derivation.exif_orientation !== 6 ||
      fixture.encoded_width !== 120 ||
      fixture.encoded_height !== 80 ||
      fixture.display_width !== 80 ||
      fixture.display_height !== 120 ||
      canonical.mime !== 'image/png' ||
      !SHA256.test(canonical.sha256 ?? '') ||
      !SHA256.test(canonical.aggregate_sha256 ?? '') ||
      !Number.isInteger(canonical.size_bytes) ||
      canonical.size_bytes < 1 ||
      canonical.width !== fixture.display_width ||
      canonical.height !== fixture.display_height ||
      canonicalJSON(canonical.corner_mapping) !== canonicalJSON(frozenCorners) ||
      canonicalJSON(
        Object.keys(object(canonical.corner_samples, 'EXIF_CANONICAL_CONTRACT_INVALID')).sort(),
      ) !== canonicalJSON(['bottom_left', 'bottom_right', 'top_left', 'top_right']) ||
      Object.values(canonical.corner_samples).some(
        (sample) =>
          !Array.isArray(sample) ||
          sample.length !== 4 ||
          sample.some((channel) => !Number.isInteger(channel) || channel < 0 || channel > 255),
      )
    )
      throw new HarnessError('EXIF_CANONICAL_CONTRACT_INVALID')
    return {
      sha256: fixture.sha256,
      size_bytes: fixture.size_bytes,
      orientation: derivation.exif_orientation,
      encoded_width: fixture.encoded_width,
      encoded_height: fixture.encoded_height,
      display_width: fixture.display_width,
      display_height: fixture.display_height,
      expected_counts: { ...expectedCounts },
      expected_items: expectedItems,
      canonical_sha256: canonical.sha256,
      canonical_aggregate_sha256: canonical.aggregate_sha256,
      canonical_size_bytes: canonical.size_bytes,
      corner_mapping: frozenCorners,
      corner_samples: structuredClone(canonical.corner_samples),
    }
  }
  if (
    typeof fixture.docs_relative_path !== 'string' ||
    !Number.isInteger(fixture.width) ||
    fixture.width < 1 ||
    !Number.isInteger(fixture.height) ||
    fixture.height < 1
  )
    throw new HarnessError('FIXTURE_CONTRACT_INVALID')
  return {
    sha256: fixture.sha256,
    size_bytes: fixture.size_bytes,
    width: fixture.width,
    height: fixture.height,
    expected_counts: { ...expectedCounts },
    expected_items: expectedItems,
  }
}

export function validateContract(contract) {
  const root = object(contract, 'CONTRACT_INVALID')
  if (root.schema_version !== 1) throw new HarnessError('CONTRACT_VERSION_INVALID')
  const route = object(root.route, 'ROUTE_CONTRACT_INVALID')
  if (
    route.provider !== EXPECTED_PROVIDER ||
    route.model !== EXPECTED_MODEL ||
    route.fallback_allowed !== false
  )
    throw new HarnessError('ROUTE_CONTRACT_INVALID')
  const transport = object(root.transport, 'TRANSPORT_CONTRACT_INVALID')
  if (
    transport.product_operations !== 'hexclaw_public_http_api_only' ||
    transport.http_driver !== 'playwright_api_request_context' ||
    transport.bound_instance_only !== true ||
    transport.dws_cli !== false ||
    transport.direct_dingtalk_http !== false ||
    transport.direct_store_read !== false ||
    transport.sqlite_seed_or_write !== false
  )
    throw new HarnessError('TRANSPORT_CONTRACT_INVALID')
  const publicAPI = object(root.public_api, 'PUBLIC_API_CONTRACT_INVALID')
  for (const [name, value] of Object.entries(publicAPI)) {
    if (name === 'inbound_identity_query') {
      if (value !== INBOUND_QUERY_PATH) {
        throw new HarnessError('INBOUND_QUERY_CONTRACT_INVALID')
      }
      continue
    }
    if (typeof value !== 'string' || !value.startsWith('/api/')) {
      throw new HarnessError('PUBLIC_API_CONTRACT_INVALID')
    }
  }
  const fixtureValues = object(root.fixtures, 'FIXTURE_CONTRACT_INVALID')
  const frozenFixtureKeys = ['clear', 'messy', 'exif6']
  if (
    canonicalJSON(Object.keys(fixtureValues).sort()) !==
    canonicalJSON([...frozenFixtureKeys].sort())
  ) {
    throw new HarnessError('FIXTURE_EXACT_SET_INVALID')
  }
  const clearOracle = manualOracleProjection(
    fixtureValues.clear?.expected_items,
    root.human_source_oracle,
    root.human_question_regions,
  )
  const messyOracle = manualOracleProjection(
    fixtureValues.messy?.expected_items,
    root.human_source_oracle,
    root.human_question_regions,
  )
  if (fixtureValues.exif6?.expected_items_from !== 'clear') {
    throw new HarnessError('FIXTURE_ORACLE_INVALID')
  }
  const fixtures = {
    clear: fixtureProjection(fixtureValues.clear, 'clear', clearOracle),
    messy: fixtureProjection(fixtureValues.messy, 'messy', messyOracle),
    exif6: fixtureProjection(fixtureValues.exif6, 'exif6', clearOracle),
  }
  const oracle = object(root.annotation_oracle, 'ANNOTATION_ORACLE_CONTRACT_INVALID')
  if (
    oracle.module !== 'tests/live/k12-photo-annotation-coverage.ts' ||
    oracle.export !== 'analyzePhotoAnnotationGeometry' ||
    oracle.require_status !== 'PASS' ||
    oracle.require_final_immutable_asset !== true ||
    oracle.max_ignored_changed_pixel_ratio !== 0
  )
    throw new HarnessError('ANNOTATION_ORACLE_CONTRACT_INVALID')
  const canonicalSource = object(root.canonical_source, 'CANONICAL_SOURCE_CONTRACT_INVALID')
  if (
    canonicalSource.aggregate_projection !== 'image_task_result.source_digest' ||
    canonicalSource.attachment_projection !== 'image_task_result.source_attachments[0]' ||
    canonicalSource.require_single_attachment !== true ||
    canonicalSource.raw_admission_digest_is_separate !== true ||
    canonicalSource.restart_immutable !== true
  ) {
    throw new HarnessError('CANONICAL_SOURCE_CONTRACT_INVALID')
  }
  const delivery = object(root.delivery, 'DELIVERY_CONTRACT_INVALID')
  if (
    delivery.object_kind !== PHOTO_REPLY_OBJECT_KIND ||
    delivery.object_id_prefix !== PHOTO_REPLY_OBJECT_ID_PREFIX ||
    canonicalJSON(delivery.object_id_hash_fields) !==
      canonicalJSON(['inbound_receipt_id', 'final_artifact_id', 'final_artifact_digest']) ||
    delivery.object_id_equals_final_artifact_id !== false ||
    delivery.target_mode !== 'inbound_callback_direct_target' ||
    delivery.target_count !== 1 ||
    canonicalJSON(delivery.physical_target_key) !==
      canonicalJSON(['platform', 'instance_id', 'chat_id']) ||
    delivery.parts_per_target !== 2 ||
    delivery.terminal_status !== 'delivered' ||
    delivery.external_message_id_required !== true ||
    delivery.distinct_external_message_ids !== true ||
    delivery.retry_after_response_loss !== false ||
    delivery.outcome_unknown_action !== 'query_once_then_wait' ||
    delivery.retry_endpoint_allowed !== false ||
    delivery.restart_action !== 'query_only'
  )
    throw new HarnessError('DELIVERY_CONTRACT_INVALID')
  const parts = array(delivery.parts, 'DELIVERY_PART_CONTRACT_INVALID')
  if (
    parts.length !== 2 ||
    parts[0]?.ordinal !== 1 ||
    parts[0]?.kind !== 'markdown' ||
    parts[0]?.mime !== '' ||
    parts[0]?.language !== 'zh-CN' ||
    parts[1]?.ordinal !== 2 ||
    parts[1]?.kind !== 'artifact' ||
    parts[1]?.mime_prefix !== 'image/' ||
    parts[1]?.artifact !== 'final_immutable_annotated_asset'
  )
    throw new HarnessError('DELIVERY_PART_CONTRACT_INVALID')
  const effects = object(root.validate_side_effects, 'VALIDATE_EFFECT_CONTRACT_INVALID')
  if (Object.values(effects).some((value) => value !== 0)) {
    throw new HarnessError('VALIDATE_EFFECT_CONTRACT_INVALID')
  }
  const phasePolicy = object(root.phase_policy, 'PHASE_POLICY_CONTRACT_INVALID')
  if (
    phasePolicy.hard_timeout_ms !== HARD_PHASE_MAX_MS ||
    phasePolicy.default_timeout_ms !== DEFAULT_PHASE_MS ||
    phasePolicy.pending_exit_code !== PENDING_EXIT_CODE
  )
    throw new HarnessError('PHASE_POLICY_CONTRACT_INVALID')
  const checkpointRoot = object(root.restart_checkpoints, 'RESTART_CHECKPOINT_CONTRACT_INVALID')
  if (checkpointRoot.case !== 'exif6') {
    throw new HarnessError('RESTART_CHECKPOINT_CONTRACT_INVALID')
  }
  const restartCheckpoints = {
    admission: {
      phase: 'restart-admission',
      processing_status: 'admitted',
      reply_status: 'pending',
      fence_required: true,
    },
    grading: {
      phase: 'restart-grading',
      processing_status: 'image_task_submitted',
      reply_status: 'pending',
      fence_required: true,
    },
    before_send: {
      phase: 'restart-before-send',
      processing_status: 'final_artifact_ready',
      reply_status: 'ready',
      fence_required: true,
    },
    after_send: {
      phase: 'restart-after-send',
      processing_status: 'final_artifact_ready',
      reply_status: 'delivered',
      fence_required: true,
    },
  }
  for (const [stage, expected] of Object.entries(restartCheckpoints)) {
    if (canonicalJSON(checkpointRoot[stage]) !== canonicalJSON(expected)) {
      throw new HarnessError('RESTART_CHECKPOINT_CONTRACT_INVALID')
    }
  }
  return {
    route: {
      provider: route.provider,
      model: route.model,
      fallback_allowed: route.fallback_allowed,
    },
    transport: {
      product_operations: transport.product_operations,
      http_driver: transport.http_driver,
      dws_cli: transport.dws_cli,
      direct_dingtalk_http: transport.direct_dingtalk_http,
      direct_store_read: transport.direct_store_read,
      sqlite_seed_or_write: transport.sqlite_seed_or_write,
    },
    fixtureKeys: frozenFixtureKeys,
    fixtures,
    annotation_oracle: {
      max_ignored_changed_pixel_ratio: oracle.max_ignored_changed_pixel_ratio,
    },
    restart_checkpoints: restartCheckpoints,
    validate_side_effects: { ...effects },
  }
}

function readUInt16(buffer, offset, little) {
  return little ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset)
}

function readUInt32(buffer, offset, little) {
  return little ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset)
}

export function parseJPEGExifOrientation(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    throw new HarnessError('JPEG_INVALID')
  }
  let offset = 2
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) break
    const marker = buffer[offset + 1]
    offset += 2
    if (marker === 0xd9 || marker === 0xda) break
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 2 > buffer.length) break
    const segmentLength = buffer.readUInt16BE(offset)
    if (segmentLength < 2 || offset + segmentLength > buffer.length) break
    const payloadStart = offset + 2
    const payloadEnd = offset + segmentLength
    if (
      marker === 0xe1 &&
      payloadEnd - payloadStart >= 14 &&
      buffer.subarray(payloadStart, payloadStart + 6).equals(Buffer.from('Exif\0\0', 'binary'))
    ) {
      const tiff = payloadStart + 6
      const byteOrder = buffer.subarray(tiff, tiff + 2).toString('ascii')
      const little = byteOrder === 'II'
      if (!little && byteOrder !== 'MM') throw new HarnessError('EXIF_INVALID')
      if (readUInt16(buffer, tiff + 2, little) !== 42) throw new HarnessError('EXIF_INVALID')
      const ifd = tiff + readUInt32(buffer, tiff + 4, little)
      if (ifd + 2 > payloadEnd) throw new HarnessError('EXIF_INVALID')
      const count = readUInt16(buffer, ifd, little)
      for (let index = 0; index < count; index += 1) {
        const entry = ifd + 2 + index * 12
        if (entry + 12 > payloadEnd) throw new HarnessError('EXIF_INVALID')
        if (readUInt16(buffer, entry, little) !== 0x0112) continue
        const orientation = readUInt16(buffer, entry + 8, little)
        if (orientation < 1 || orientation > 8) throw new HarnessError('EXIF_INVALID')
        return orientation
      }
    }
    offset += segmentLength
  }
  return 1
}

function hasForbiddenProjectionField(value, forbidden) {
  if (Array.isArray(value))
    return value.some((item) => hasForbiddenProjectionField(item, forbidden))
  if (!value || typeof value !== 'object') return false
  for (const [key, child] of Object.entries(value)) {
    if (forbidden.has(key.toLowerCase())) return true
    if (hasForbiddenProjectionField(child, forbidden)) return true
  }
  return false
}

function exactIdentity(value, code = 'INBOUND_IDENTITY_INVALID') {
  const identity = object(value, code)
  const output = {
    platform: nonEmpty(identity.platform, code).toLowerCase(),
    instance_id: nonEmpty(identity.instance_id, code),
    chat_id: nonEmpty(identity.chat_id, code),
    provider_message_id: nonEmpty(identity.provider_message_id, code),
  }
  if (canonicalJSON(Object.keys(identity).sort()) !== canonicalJSON(Object.keys(output).sort())) {
    throw new HarnessError(code)
  }
  return output
}

export function assertInboundBundle(bundle, expected) {
  const value = object(bundle, 'INBOUND_PROJECTION_INVALID')
  if (
    hasForbiddenProjectionField(
      value,
      new Set(['owner_scope', 'command_json', 'bytes', 'asset_bytes']),
    )
  )
    throw new HarnessError('INBOUND_PROJECTION_SECRET')
  const receipt = object(value.receipt, 'INBOUND_RECEIPT_INVALID')
  const asset = object(value.asset, 'INBOUND_ASSET_INVALID')
  const dispatch = object(value.dispatch, 'INBOUND_DISPATCH_INVALID')
  const actualIdentity = exactIdentity(receipt.identity)
  const wantedIdentity = exactIdentity(expected?.identity)
  if (canonicalJSON(actualIdentity) !== canonicalJSON(wantedIdentity)) {
    throw new HarnessError('INBOUND_IDENTITY_DRIFT')
  }
  if (
    nonEmpty(receipt.agent_name, 'INBOUND_RECEIPT_INVALID') !== expected?.agent_name ||
    !nonEmpty(receipt.receipt_id, 'INBOUND_RECEIPT_INVALID') ||
    !nonEmpty(receipt.binding_id, 'INBOUND_RECEIPT_INVALID') ||
    !PREFIXED_SHA256.test(receipt.command_digest ?? '')
  )
    throw new HarnessError('INBOUND_RECEIPT_INVALID')
  if (
    nonEmpty(asset.asset_id, 'INBOUND_ASSET_INVALID') === '' ||
    asset.receipt_id !== receipt.receipt_id ||
    !String(asset.mime ?? '').startsWith('image/') ||
    !Number.isInteger(asset.size) ||
    asset.size < 1 ||
    !PREFIXED_SHA256.test(asset.digest ?? '')
  )
    throw new HarnessError('INBOUND_ASSET_INVALID')
  if (expected?.expected_asset_digest && asset.digest !== expected.expected_asset_digest) {
    throw new HarnessError('INBOUND_ASSET_DIGEST_DRIFT')
  }
  const processing = new Set(['admitted', 'image_task_submitted', 'final_artifact_ready'])
  const routing = new Set(['pending', 'regrade', 'new_submission', 'asked_user'])
  const confirmation = new Set(['not_required', 'waiting', 'confirmed'])
  const reply = new Set(['pending', 'ready', 'bound', 'delivered'])
  if (
    dispatch.receipt_id !== receipt.receipt_id ||
    !nonEmpty(dispatch.dispatch_id, 'INBOUND_DISPATCH_INVALID') ||
    !processing.has(dispatch.processing_status) ||
    !routing.has(dispatch.routing_decision) ||
    !confirmation.has(dispatch.confirmation_status) ||
    !reply.has(dispatch.reply_status) ||
    !Number.isInteger(dispatch.version) ||
    dispatch.version < 1
  )
    throw new HarnessError('INBOUND_DISPATCH_INVALID')
  return {
    receipt_id: receipt.receipt_id,
    dispatch_id: dispatch.dispatch_id,
    asset_digest: asset.digest,
    processing_status: dispatch.processing_status,
    reply_status: dispatch.reply_status,
    image_task_id: dispatch.image_task_id ?? '',
    final_artifact_id: dispatch.final_artifact_id ?? '',
    delivery_batch_id: dispatch.delivery_batch_id ?? '',
    identity: {
      platform: actualIdentity.platform,
      instance_id_sha256: sha256Text(actualIdentity.instance_id),
      chat_id_sha256: sha256Text(actualIdentity.chat_id),
      provider_message_id_sha256: sha256Text(actualIdentity.provider_message_id),
    },
  }
}

function physicalTarget(value, code = 'DELIVERY_TARGET_INVALID') {
  const target = object(value, code)
  return {
    platform: nonEmpty(target.platform, code).toLowerCase(),
    instance_id: nonEmpty(target.instance_id, code),
    chat_id: nonEmpty(target.chat_id, code),
  }
}

function physicalTargetKey(value) {
  const target = physicalTarget(value)
  return `${target.platform}\u0000${target.instance_id}\u0000${target.chat_id}`
}

function deliveryPayload(receipt, code) {
  let payload
  try {
    payload = JSON.parse(nonEmpty(receipt.payload_json, code))
  } catch {
    throw new HarnessError(code)
  }
  if (normalizedDigest(receipt.payload_digest, code) !== sha256Text(receipt.payload_json)) {
    throw new HarnessError(code)
  }
  return object(payload, code)
}

function assertMarkdownPayload(receipt, canonicalMarkdown) {
  const payload = deliveryPayload(receipt, 'DELIVERY_MARKDOWN_INVALID')
  const text = typeof payload?.text === 'string' ? payload.text : ''
  const canonical =
    typeof payload?.message_content?.markdown === 'string' ? payload.message_content.markdown : ''
  if (
    payload?.kind !== 'markdown' ||
    payload?.ordinal !== 1 ||
    !HAN.test(text) ||
    !HAN.test(canonical) ||
    payload?.message_content?.locale !== 'zh-CN' ||
    canonical !== canonicalMarkdown ||
    normalizedDigest(payload?.digest, 'DELIVERY_MARKDOWN_INVALID') !==
      normalizedDigest(receipt.part_digest, 'DELIVERY_MARKDOWN_INVALID') ||
    normalizedDigest(receipt.part_digest, 'DELIVERY_MARKDOWN_INVALID') !==
      sha256Text(canonicalMarkdown)
  )
    throw new HarnessError('DELIVERY_MARKDOWN_INVALID')
}

function assertArtifactPayload(receipt, expected) {
  const payload = deliveryPayload(receipt, 'DELIVERY_ARTIFACT_INVALID')
  const attachment = object(payload?.attachment, 'DELIVERY_ARTIFACT_INVALID')
  const bytes = decodeCanonicalBase64(attachment.data, 'DELIVERY_ARTIFACT_INVALID')
  if (
    payload?.kind !== 'artifact' ||
    payload?.ordinal !== 2 ||
    payload?.mime !== receipt.part_mime ||
    attachment.mime !== expected.annotated_mime ||
    !nonEmpty(attachment.name, 'DELIVERY_ARTIFACT_INVALID') ||
    normalizedDigest(payload?.digest, 'DELIVERY_ARTIFACT_INVALID') !==
      normalizedDigest(receipt.part_digest, 'DELIVERY_ARTIFACT_INVALID') ||
    normalizedDigest(receipt.part_digest, 'DELIVERY_ARTIFACT_INVALID') !==
      expected.annotated_digest ||
    sha256Bytes(bytes) !== expected.annotated_digest ||
    !bytes.equals(expected.annotated_bytes) ||
    payload?.message_content?.markdown !== expected.canonical_markdown ||
    /asset:\/\/|file:\/\/|\/Users\/|[A-Za-z]:\\/u.test(receipt.payload_json)
  )
    throw new HarnessError('DELIVERY_ARTIFACT_INVALID')
}

export function assertDeliveryExactSet(batch, expected) {
  const value = object(batch, 'DELIVERY_BATCH_INVALID')
  const expectedTargets = array(expected?.expected_targets, 'DELIVERY_TARGETS_REQUIRED').map(
    (target) => physicalTarget(target),
  )
  if (
    expectedTargets.length !== 1 ||
    new Set(expectedTargets.map(physicalTargetKey)).size !== expectedTargets.length
  ) {
    throw new HarnessError('DELIVERY_TARGET_EXACT_SET_INVALID')
  }
  const inboundReceiptID = nonEmpty(expected.inbound_receipt_id, 'DELIVERY_BATCH_INVALID')
  const finalArtifactID = nonEmpty(expected.final_artifact_id, 'DELIVERY_BATCH_INVALID')
  const finalArtifactDigest = nonEmpty(
    expected.final_artifact_digest,
    'DELIVERY_BATCH_INVALID',
  ).toLowerCase()
  if (!SHA256.test(finalArtifactDigest)) throw new HarnessError('DELIVERY_BATCH_INVALID')
  const expectedObjectID = `${PHOTO_REPLY_OBJECT_ID_PREFIX}${sha256Text(
    [inboundReceiptID, finalArtifactID, finalArtifactDigest].join('\u0000'),
  )}`
  if (
    value.status !== 'delivered' ||
    value.agent_name !== expected.agent_name ||
    value.object_kind !== PHOTO_REPLY_OBJECT_KIND ||
    value.object_id !== expectedObjectID ||
    !nonEmpty(value.batch_id, 'DELIVERY_BATCH_INVALID') ||
    !nonEmpty(value.dedupe_key, 'DELIVERY_BATCH_INVALID') ||
    !PREFIXED_SHA256.test(value.content_digest ?? '')
  )
    throw new HarnessError('DELIVERY_BATCH_INVALID')
  const canonicalMarkdown = nonEmpty(expected.canonical_markdown, 'DELIVERY_MARKDOWN_INVALID')
  const annotatedDigest = normalizedDigest(expected.annotated_digest, 'DELIVERY_ARTIFACT_INVALID')
  const annotatedBytes = expected.annotated_bytes
  if (!Buffer.isBuffer(annotatedBytes) || sha256Bytes(annotatedBytes) !== annotatedDigest) {
    throw new HarnessError('DELIVERY_ARTIFACT_INVALID')
  }
  const annotatedMIME = nonEmpty(expected.annotated_mime, 'DELIVERY_ARTIFACT_INVALID')
  if (!annotatedMIME.startsWith('image/')) throw new HarnessError('DELIVERY_ARTIFACT_INVALID')
  const receipts = array(value.receipts, 'DELIVERY_EXACT_SET_INVALID')
  if (receipts.length !== expectedTargets.length * 2)
    throw new HarnessError('DELIVERY_EXACT_SET_INVALID')
  const byTarget = new Map()
  const ordinals = new Set()
  const external = new Set()
  for (const receipt of receipts) {
    const target = physicalTarget(receipt?.target)
    const key = physicalTargetKey(target)
    if (!expectedTargets.some((wanted) => physicalTargetKey(wanted) === key)) {
      throw new HarnessError('DELIVERY_TARGET_EXACT_SET_INVALID')
    }
    if (!byTarget.has(key)) byTarget.set(key, [])
    byTarget.get(key).push(receipt)
    if (
      receipt.batch_id !== value.batch_id ||
      !Number.isInteger(receipt.batch_ordinal) ||
      receipt.batch_ordinal < 1 ||
      ordinals.has(receipt.batch_ordinal) ||
      receipt.status !== 'delivered' ||
      !nonEmpty(receipt.delivery_id, 'DELIVERY_RECEIPT_INVALID') ||
      !nonEmpty(receipt.binding_id, 'DELIVERY_RECEIPT_INVALID') ||
      !nonEmpty(receipt.dedupe_key, 'DELIVERY_RECEIPT_INVALID') ||
      !PREFIXED_SHA256.test(receipt.part_digest ?? '') ||
      !PREFIXED_SHA256.test(receipt.payload_digest ?? '') ||
      !Number.isInteger(receipt.attempt) ||
      receipt.attempt < 1 ||
      !nonEmpty(receipt.external_message_id, 'DELIVERY_EXTERNAL_ID_REQUIRED')
    )
      throw new HarnessError('DELIVERY_RECEIPT_INVALID')
    ordinals.add(receipt.batch_ordinal)
    if (external.has(receipt.external_message_id))
      throw new HarnessError('DELIVERY_EXTERNAL_ID_DUPLICATE')
    external.add(receipt.external_message_id)
  }
  assert.deepEqual(
    [...ordinals].sort((a, b) => a - b),
    Array.from({ length: receipts.length }, (_, index) => index + 1),
    'DELIVERY_BATCH_ORDINAL_DRIFT',
  )
  for (const target of expectedTargets) {
    const parts = byTarget.get(physicalTargetKey(target)) ?? []
    if (parts.length !== 2) throw new HarnessError('DELIVERY_EXACT_SET_INVALID')
    parts.sort((left, right) => left.part_ordinal - right.part_ordinal)
    const [markdown, image] = parts
    if (
      markdown.part_kind !== 'markdown' ||
      markdown.part_mime !== '' ||
      markdown.part_ordinal !== 1
    )
      throw new HarnessError('DELIVERY_MARKDOWN_INVALID')
    if (
      image.part_kind !== 'artifact' ||
      !String(image.part_mime ?? '').startsWith('image/') ||
      image.part_ordinal !== 2
    )
      throw new HarnessError('DELIVERY_ARTIFACT_INVALID')
    assertMarkdownPayload(markdown, canonicalMarkdown)
    assertArtifactPayload(image, {
      canonical_markdown: canonicalMarkdown,
      annotated_mime: annotatedMIME,
      annotated_digest: annotatedDigest,
      annotated_bytes: annotatedBytes,
    })
  }
  if (byTarget.size !== expectedTargets.length) throw new HarnessError('DELIVERY_EXACT_SET_INVALID')
  return {
    batch_id_sha256: sha256Text(value.batch_id),
    target_count: expectedTargets.length,
    receipt_count: receipts.length,
    annotated_digest: annotatedDigest,
    target_hashes: expectedTargets.map((target) => sha256Text(physicalTargetKey(target))).sort(),
    external_message_id_hashes: [...external].map(sha256Text).sort(),
  }
}

function invariantSnapshot(value) {
  const root = object(value, 'INVARIANT_SNAPSHOT_INVALID')
  const inbound = object(root.inbound, 'INVARIANT_INBOUND_INVALID')
  const batch = object(root.batch, 'INVARIANT_BATCH_INVALID')
  const artifact = object(root.final_artifact, 'INVARIANT_ARTIFACT_INVALID')
  const canonicalSource = object(root.canonical_source, 'INVARIANT_CANONICAL_SOURCE_INVALID')
  const annotated = object(root.annotated, 'INVARIANT_ANNOTATED_INVALID')
  const receipt = object(inbound.receipt, 'INVARIANT_INBOUND_INVALID')
  const asset = object(inbound.asset, 'INVARIANT_INBOUND_INVALID')
  const dispatch = object(inbound.dispatch, 'INVARIANT_INBOUND_INVALID')
  return {
    inbound: {
      receipt_id: receipt.receipt_id,
      binding_id: receipt.binding_id,
      identity: receipt.identity,
      command_digest: receipt.command_digest,
      asset_id: asset.asset_id,
      asset_digest: asset.digest,
      dispatch_id: dispatch.dispatch_id,
      image_task_id: dispatch.image_task_id,
      final_artifact_id: dispatch.final_artifact_id,
      delivery_batch_id: dispatch.delivery_batch_id,
    },
    final_artifact: {
      artifact_id: artifact.artifact_id,
      artifact_digest: artifact.artifact_digest,
    },
    canonical_source: {
      aggregate_digest: canonicalSource.aggregate_digest,
      attachment_digest: canonicalSource.attachment_digest,
      attachment_size: canonicalSource.attachment_size,
    },
    annotated: {
      mime: annotated.mime,
      digest: annotated.digest,
    },
    batch: {
      batch_id: batch.batch_id,
      agent_name: batch.agent_name,
      object_kind: batch.object_kind,
      object_id: batch.object_id,
      dedupe_key: batch.dedupe_key,
      content_digest: batch.content_digest,
      receipts: array(batch.receipts, 'INVARIANT_RECEIPTS_INVALID')
        .map((receiptValue) => ({
          delivery_id: receiptValue.delivery_id,
          batch_ordinal: receiptValue.batch_ordinal,
          part_kind: receiptValue.part_kind,
          part_mime: receiptValue.part_mime,
          part_ordinal: receiptValue.part_ordinal,
          part_digest: receiptValue.part_digest,
          binding_id: receiptValue.binding_id,
          target: receiptValue.target,
          dedupe_key: receiptValue.dedupe_key,
          payload_digest: receiptValue.payload_digest,
          external_message_id: receiptValue.external_message_id,
          attempt: receiptValue.attempt,
        }))
        .sort((left, right) => left.batch_ordinal - right.batch_ordinal),
    },
  }
}

const RESTART_CHECKPOINT_STATUS = Object.freeze({
  grading: { processing_status: 'image_task_submitted', reply_status: 'pending' },
  before_send: { processing_status: 'final_artifact_ready', reply_status: 'ready' },
  after_send: { processing_status: 'final_artifact_ready', reply_status: 'delivered' },
})

function restartCheckpointInvariant(value, stage, enforceStage) {
  const expected = RESTART_CHECKPOINT_STATUS[stage]
  if (!expected) throw new HarnessError('RESTART_CHECKPOINT_STAGE_INVALID')
  const root = object(value, 'RESTART_CHECKPOINT_INVALID')
  const inbound = object(root.inbound, 'RESTART_CHECKPOINT_INVALID')
  const receipt = object(inbound.receipt, 'RESTART_CHECKPOINT_INVALID')
  const asset = object(inbound.asset, 'RESTART_CHECKPOINT_INVALID')
  const dispatch = object(inbound.dispatch, 'RESTART_CHECKPOINT_INVALID')
  const canonicalSource = object(root.canonical_source, 'RESTART_CHECKPOINT_INVALID')
  if (
    enforceStage &&
    (dispatch.processing_status !== expected.processing_status ||
      dispatch.reply_status !== expected.reply_status)
  ) {
    throw new HarnessError('RESTART_CHECKPOINT_STAGE_NOT_OBSERVED')
  }
  if (
    !nonEmpty(receipt.receipt_id, 'RESTART_CHECKPOINT_INVALID') ||
    !nonEmpty(receipt.binding_id, 'RESTART_CHECKPOINT_INVALID') ||
    !nonEmpty(asset.asset_id, 'RESTART_CHECKPOINT_INVALID') ||
    !nonEmpty(asset.digest, 'RESTART_CHECKPOINT_INVALID') ||
    !nonEmpty(dispatch.dispatch_id, 'RESTART_CHECKPOINT_INVALID') ||
    !nonEmpty(dispatch.image_task_id, 'RESTART_CHECKPOINT_INVALID')
  ) {
    throw new HarnessError('RESTART_CHECKPOINT_INVALID')
  }
  if (
    enforceStage &&
    stage === 'grading' &&
    (dispatch.final_artifact_id || dispatch.delivery_batch_id)
  ) {
    throw new HarnessError('RESTART_CHECKPOINT_STAGE_NOT_OBSERVED')
  }
  if (
    enforceStage &&
    stage === 'before_send' &&
    (!dispatch.final_artifact_id || dispatch.delivery_batch_id)
  ) {
    throw new HarnessError('RESTART_CHECKPOINT_STAGE_NOT_OBSERVED')
  }
  const projection = {
    inbound: {
      receipt_id: receipt.receipt_id,
      binding_id: receipt.binding_id,
      identity: receipt.identity,
      command_digest: receipt.command_digest,
      asset_id: asset.asset_id,
      asset_digest: asset.digest,
      dispatch_id: dispatch.dispatch_id,
      image_task_id: dispatch.image_task_id,
    },
    canonical_source: {
      aggregate_digest: normalizedDigest(
        canonicalSource.aggregate_digest,
        'RESTART_CHECKPOINT_INVALID',
      ),
      attachment_digest: normalizedDigest(
        canonicalSource.attachment_digest,
        'RESTART_CHECKPOINT_INVALID',
      ),
      attachment_size: canonicalSource.attachment_size,
    },
  }
  if (stage !== 'grading') {
    const artifact = object(root.final_artifact, 'RESTART_CHECKPOINT_INVALID')
    const annotated = object(root.annotated, 'RESTART_CHECKPOINT_INVALID')
    projection.final_artifact = {
      artifact_id: nonEmpty(artifact.artifact_id, 'RESTART_CHECKPOINT_INVALID'),
      artifact_digest: normalizedDigest(artifact.artifact_digest, 'RESTART_CHECKPOINT_INVALID'),
    }
    projection.annotated = {
      mime: nonEmpty(annotated.mime, 'RESTART_CHECKPOINT_INVALID'),
      digest: normalizedDigest(annotated.digest, 'RESTART_CHECKPOINT_INVALID'),
    }
  }
  if (stage === 'after_send') {
    projection.batch = invariantSnapshot(root).batch
  }
  return projection
}

export function assertRestartCheckpoint(stage, before, after) {
  if (!['admission', 'grading', 'before_send', 'after_send'].includes(stage)) {
    throw new HarnessError('RESTART_CHECKPOINT_STAGE_INVALID')
  }
  object(before, 'RESTART_CHECKPOINT_INVALID')
  object(after, 'RESTART_CHECKPOINT_INVALID')
  throw new HarnessError('RESTART_DETERMINISTIC_FENCE_UNAVAILABLE')
}

export function assertRestartInvariant(before, after) {
  if (canonicalJSON(invariantSnapshot(before)) !== canonicalJSON(invariantSnapshot(after))) {
    throw new HarnessError('RESTART_EXACT_SET_DRIFT')
  }
  return before
}

export function assertDuplicateCallbackInvariant(before, after) {
  if (canonicalJSON(invariantSnapshot(before)) !== canonicalJSON(invariantSnapshot(after))) {
    throw new HarnessError('CALLBACK_REPLAY_CHANGED_DELIVERY')
  }
  return before
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
  'timestamp',
  'download_code',
  'downloadcode',
  'callback_body',
  'command_json',
  'asset_bytes',
  'bytes',
  'payload_json',
  'canonical_markdown',
  'raw_model_output',
])
const RAW_IDENTITY_KEYS = new Set([
  'instance_id',
  'chat_id',
  'user_id',
  'provider_message_id',
  'external_message_id',
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

function fixturePath(docsRoot, fixture) {
  const pathname = resolve(docsRoot, fixture.docs_relative_path)
  if (relative(docsRoot, pathname).startsWith('..')) throw new HarnessError('FIXTURE_PATH_INVALID')
  return pathname
}

async function validateFixture(pathname, fixture) {
  const info = await requireRegularFile(pathname, 'FIXTURE_UNAVAILABLE')
  if (info.size !== fixture.size_bytes || (await sha256File(pathname)) !== fixture.sha256) {
    throw new HarnessError('FIXTURE_DIGEST_DRIFT')
  }
  return {
    sha256: fixture.sha256,
    size_bytes: fixture.size_bytes,
    width: fixture.width,
    height: fixture.height,
  }
}

function exifOrientation6Segment() {
  return Buffer.from([
    0xff, 0xe1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x49, 0x49, 0x2a, 0x00, 0x08, 0x00,
    0x00, 0x00, 0x01, 0x00, 0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
  ])
}

async function deriveExif6Fixture(_source, output, fixture) {
  const canonicalOutput = `${output}.canonical.png`
  const helper = resolve(DESKTOP_ROOT, fixture.derivation.fixture_source)
  await requireRegularFile(helper, 'EXIF_FIXTURE_GENERATOR_UNAVAILABLE')
  const commandEnvironment = { ...process.env }
  try {
    const homebrewGoRoot = '/opt/homebrew/opt/go/libexec'
    const info = await lstat(homebrewGoRoot)
    if (info.isDirectory()) commandEnvironment.GOROOT = homebrewGoRoot
  } catch {
    // 非 Homebrew Go 环境沿用调用者的 GOROOT。
  }
  let manifest
  try {
    const executed = await execFile(
      fixture.derivation.tool,
      ['run', helper, '--raw', output, '--canonical', canonicalOutput],
      {
        cwd: DESKTOP_ROOT,
        env: commandEnvironment,
        timeout: 60_000,
        maxBuffer: 1 << 20,
      },
    )
    manifest = JSON.parse(executed.stdout)
  } catch {
    throw new HarnessError('EXIF_DERIVATION_FAILED')
  }
  const finalBytes = await readFile(output)
  const canonicalBytes = await readFile(canonicalOutput)
  await chmod(output, PRIVATE_FILE_MODE)
  await chmod(canonicalOutput, PRIVATE_FILE_MODE)
  const canonical = fixture.canonical
  if (
    finalBytes.length !== fixture.size_bytes ||
    sha256Bytes(finalBytes) !== fixture.sha256 ||
    parseJPEGExifOrientation(finalBytes) !== 6 ||
    canonicalBytes.length !== canonical.size_bytes ||
    sha256Bytes(canonicalBytes) !== canonical.sha256 ||
    manifest.raw_sha256 !== fixture.sha256 ||
    manifest.raw_size_bytes !== fixture.size_bytes ||
    manifest.encoded_width !== fixture.encoded_width ||
    manifest.encoded_height !== fixture.encoded_height ||
    manifest.canonical_sha256 !== canonical.sha256 ||
    manifest.canonical_aggregate_sha256 !== canonical.aggregate_sha256 ||
    manifest.canonical_size_bytes !== canonical.size_bytes ||
    manifest.canonical_width !== canonical.width ||
    manifest.canonical_height !== canonical.height ||
    canonicalJSON(manifest.corner_samples) !== canonicalJSON(canonical.corner_samples)
  )
    throw new HarnessError('EXIF_FIXTURE_DIGEST_DRIFT')
  await rm(canonicalOutput, { force: true })
  return {
    sha256: fixture.sha256,
    size_bytes: fixture.size_bytes,
    orientation: 6,
    encoded_width: fixture.encoded_width,
    encoded_height: fixture.encoded_height,
    canonical_sha256: canonical.sha256,
    canonical_size_bytes: canonical.size_bytes,
    canonical_width: canonical.width,
    canonical_height: canonical.height,
    corner_samples: structuredClone(canonical.corner_samples),
  }
}

async function validateStatic(env = process.env) {
  const contract = await loadContract()
  const docsRoot = resolve(env.HEXCLAW_DOCS_ROOT || DEFAULT_DOCS_ROOT)
  await requireDirectory(docsRoot, 'DOCS_ROOT_UNAVAILABLE')
  await requireRegularFile(ANNOTATION_ORACLE_PATH, 'ANNOTATION_ORACLE_UNAVAILABLE')
  await requireRegularFile(
    resolve(DESKTOP_ROOT, contract.fixtures.exif6.derivation.fixture_source),
    'EXIF_FIXTURE_GENERATOR_UNAVAILABLE',
  )
  const clearPath = fixturePath(docsRoot, contract.fixtures.clear)
  const messyPath = fixturePath(docsRoot, contract.fixtures.messy)
  const clear = await validateFixture(clearPath, contract.fixtures.clear)
  const messy = await validateFixture(messyPath, contract.fixtures.messy)
  const temporary = await mkdtemp(join(tmpdir(), 'hexclaw-photo-exif6-'))
  let exif6
  try {
    exif6 = await deriveExif6Fixture(
      clearPath,
      join(temporary, 'phone-exif6.jpg'),
      contract.fixtures.exif6,
    )
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
  return {
    status: 'validated',
    phase: 'validate',
    live_gate_required: true,
    sidecar_started: false,
    callback_posts: 0,
    model_calls: 0,
    im_sends: 0,
    provider_queries: 0,
    public_api_only: true,
    phase_hard_cap_ms: HARD_PHASE_MAX_MS,
    fixtures: { clear, messy, exif6 },
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

function liveRuntime(env) {
  const runRoot = resolve(nonEmpty(env.HEXCLAW_DINGTALK_PHOTO_RUN_DIR, 'RUN_DIRECTORY_REQUIRED'))
  const config = resolve(nonEmpty(env.HEXCLAW_DINGTALK_TEST_CONFIG, 'TEST_CONFIG_REQUIRED'))
  const sidecar = resolve(nonEmpty(env.HEXCLAW_DINGTALK_SIDECAR_BIN, 'SIDECAR_BINARY_REQUIRED'))
  const assetRoot = resolve(nonEmpty(env.HEXCLAW_DINGTALK_ASSET_ROOT, 'ASSET_ROOT_REQUIRED'))
  const envelopeDirectory = resolve(
    nonEmpty(env.HEXCLAW_DINGTALK_CALLBACK_ENVELOPE_DIR, 'CALLBACK_ENVELOPE_DIRECTORY_REQUIRED'),
  )
  const inboundQueryPath = String(
    env.HEXCLAW_DINGTALK_INBOUND_QUERY_PATH || INBOUND_QUERY_PATH,
  ).trim()
  if (inboundQueryPath !== INBOUND_QUERY_PATH) {
    throw new HarnessError('INBOUND_PUBLIC_QUERY_PATH_INVALID')
  }
  let baseURL
  try {
    baseURL = new URL(nonEmpty(env.HEXCLAW_DINGTALK_BASE_URL, 'SIDECAR_BASE_URL_REQUIRED'))
  } catch {
    throw new HarnessError('SIDECAR_BASE_URL_INVALID')
  }
  if (
    baseURL.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost'].includes(baseURL.hostname) ||
    (baseURL.pathname !== '/' && baseURL.pathname !== '')
  )
    throw new HarnessError('SIDECAR_BASE_URL_INVALID')
  let expectedTargets
  try {
    expectedTargets = JSON.parse(
      nonEmpty(env.HEXCLAW_DINGTALK_EXPECTED_TARGETS_JSON, 'EXPECTED_TARGETS_REQUIRED'),
    )
  } catch {
    throw new HarnessError('EXPECTED_TARGETS_INVALID')
  }
  expectedTargets = array(expectedTargets, 'EXPECTED_TARGETS_INVALID').map(physicalTarget)
  if (
    expectedTargets.length !== 1 ||
    new Set(expectedTargets.map(physicalTargetKey)).size !== expectedTargets.length
  ) {
    throw new HarnessError('EXPECTED_TARGETS_INVALID')
  }
  return {
    runRoot,
    config,
    sidecar,
    assetRoot,
    envelopeDirectory,
    inboundQueryPath,
    baseURL: baseURL.origin,
    agentName: nonEmpty(env.HEXCLAW_DINGTALK_AGENT_NAME, 'AGENT_NAME_REQUIRED'),
    instanceID: nonEmpty(env.HEXCLAW_DINGTALK_INSTANCE_ID, 'INSTANCE_ID_REQUIRED'),
    expectedTargets,
  }
}

function sidecarEnvironment(env, runtime, capability) {
  const output = { ...env }
  output.HEXCLAW_ASSET_ROOT = runtime.assetRoot
  output.HEXCLAW_SIDECAR_CAPABILITY_TOKEN = capability
  output.DINGTALK_LIVE_SEND = '1'
  return output
}

function startSidecar(runtime, env, capability) {
  const hash = createHash('sha256')
  let bytes = 0
  const child = spawn(runtime.sidecar, ['serve', '--desktop', '--config', runtime.config], {
    cwd: runtime.runRoot,
    env: sidecarEnvironment(env, runtime, capability),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => {
      bytes += chunk.length
      hash.update(chunk)
    })
  }
  return { child, hash, bytes: () => bytes }
}

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds))
}

async function stopSidecar(processState) {
  if (!processState) return { log_sha256: sha256Text(''), log_bytes: 0 }
  const child = processState.child
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  const closed = new Promise((resolveClose) => child.once('close', resolveClose))
  const graceful = await Promise.race([closed.then(() => true), sleep(10_000).then(() => false)])
  if (!graceful && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
    await closed
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
      headers: options.headers,
      timeout: options.timeout ?? REQUEST_TIMEOUT_MS,
      failOnStatusCode: false,
    })
  } catch {
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
  if (response.status() === 404) return { status: 404, value: null }
  try {
    return { status: response.status(), value: JSON.parse(raw.toString('utf8')) }
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
  const api = await apiContext(runtime.baseURL, capability)
  try {
    await waitForSidecar(api, processState, deadline)
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
  const visit = (node, key = '') => {
    if (Array.isArray(node)) return node.every((child) => visit(child, key))
    if (!node || typeof node !== 'object') {
      if (!/(secret|token|key|credential|password)/iu.test(key)) return true
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

export function assertPreparedPublicProjection(runtime, llm, instances, agents) {
  const providers = object(llm?.providers, 'REAL_ROUTE_PROJECTION_INVALID')
  const provider = object(providers[EXPECTED_PROVIDER], 'REAL_ROUTE_PROJECTION_INVALID')
  if (
    llm.default !== EXPECTED_PROVIDER ||
    provider.model !== EXPECTED_MODEL ||
    !array(provider.models, 'REAL_ROUTE_PROJECTION_INVALID').includes(EXPECTED_MODEL) ||
    provider.credential_present !== true
  )
    throw new HarnessError('REAL_ROUTE_PROJECTION_INVALID')
  const matchingInstances = array(instances?.instances, 'INSTANCE_PROJECTION_INVALID').filter(
    (instance) => instance?.provider === 'dingtalk' && instance?.name === runtime.instanceID,
  )
  if (
    matchingInstances.length !== 1 ||
    matchingInstances[0].enabled !== true ||
    matchingInstances[0].status !== 'running' ||
    !maskedInstanceConfig(matchingInstances[0].config)
  )
    throw new HarnessError('BOUND_INSTANCE_PROJECTION_INVALID')
  const matchingAgents = array(agents?.agents, 'AGENT_PROJECTION_INVALID').filter(
    (agent) => agent?.name === runtime.agentName,
  )
  if (
    matchingAgents.length !== 1 ||
    matchingAgents[0].provider !== EXPECTED_PROVIDER ||
    matchingAgents[0].model !== EXPECTED_MODEL ||
    matchingAgents[0].metadata?.scenario !== 'k12-tutor'
  )
    throw new HarnessError('AGENT_ROUTE_PROJECTION_INVALID')
  const rules = array(agents?.rules, 'AGENT_RULE_PROJECTION_INVALID')
    .filter((rule) => rule?.agent_name === runtime.agentName)
    .map((rule) => ({
      platform: String(rule.platform ?? '').toLowerCase(),
      instance_id: String(rule.instance_id ?? ''),
      chat_id: String(rule.chat_id || rule.user_id || ''),
    }))
    .filter((rule) => rule.platform && rule.instance_id && rule.chat_id)
  const expectedTargets = array(runtime.expectedTargets, 'EXPECTED_TARGETS_INVALID').map(
    physicalTarget,
  )
  if (
    expectedTargets.length !== 1 ||
    !rules.some((rule) => physicalTargetKey(rule) === physicalTargetKey(expectedTargets[0]))
  ) {
    throw new HarnessError('CALLBACK_DIRECT_TARGET_BINDING_INVALID')
  }
  return {
    provider: EXPECTED_PROVIDER,
    model: EXPECTED_MODEL,
    instance_id_sha256: sha256Text(runtime.instanceID),
    agent_name_sha256: sha256Text(runtime.agentName),
    target_hashes: expectedTargets.map((target) => sha256Text(physicalTargetKey(target))),
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
    }
  } catch (error) {
    if (safeCode(error) !== 'RUN_STATE_UNAVAILABLE') throw error
  }
  await mkdir(runtime.runRoot, { recursive: false, mode: PRIVATE_DIRECTORY_MODE })
  await chmod(runtime.runRoot, PRIVATE_DIRECTORY_MODE)
  if ((await realpath(runtime.runRoot)) !== runtime.runRoot)
    throw new HarnessError('RUN_DIRECTORY_SYMLINKED')
  await mkdir(runtime.assetRoot, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
  await chmod(runtime.assetRoot, PRIVATE_DIRECTORY_MODE)
  await requireRegularFile(runtime.config, 'TEST_CONFIG_UNAVAILABLE', { privateFile: true })
  await requireRegularFile(runtime.sidecar, 'SIDECAR_BINARY_UNAVAILABLE', { executable: true })
  await requireDirectory(runtime.envelopeDirectory, 'CALLBACK_ENVELOPE_DIRECTORY_UNAVAILABLE', true)
  const docsRoot = resolve(env.HEXCLAW_DOCS_ROOT || DEFAULT_DOCS_ROOT)
  const clearPath = fixturePath(docsRoot, contract.fixtures.clear)
  await validateFixture(clearPath, contract.fixtures.clear)
  await validateFixture(fixturePath(docsRoot, contract.fixtures.messy), contract.fixtures.messy)
  const exifPath = join(runtime.runRoot, 'phone-exif6.jpg')
  await deriveExif6Fixture(clearPath, exifPath, contract.fixtures.exif6)
  const state = {
    schema_version: 1,
    run_id: `dingtalk-photo-${randomUUID()}`,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    route: { provider: EXPECTED_PROVIDER, model: EXPECTED_MODEL, fallback_allowed: false },
    runtime: {
      config_sha256: await sha256File(runtime.config),
      sidecar_sha256: await sha256File(runtime.sidecar),
      base_url_sha256: sha256Text(runtime.baseURL),
      inbound_query_path_sha256: sha256Text(runtime.inboundQueryPath),
      exif_fixture: basename(exifPath),
    },
    agent_name: runtime.agentName,
    instance_id: runtime.instanceID,
    expected_targets: runtime.expectedTargets,
    cases: {},
  }
  await withSidecar(runtime, env, deadline, async (api) => {
    const [llmResponse, instanceResponse, agentResponse] = await Promise.all([
      apiFetch(api, 'GET', '/api/v1/config/llm', { code: 'LLM_PROJECTION_FAILED' }),
      apiFetch(api, 'GET', '/api/v1/platforms/instances', { code: 'INSTANCE_PROJECTION_FAILED' }),
      apiFetch(api, 'GET', '/api/v1/agents', { code: 'AGENT_PROJECTION_FAILED' }),
    ])
    state.public_projection = assertPreparedPublicProjection(
      runtime,
      llmResponse.value,
      instanceResponse.value,
      agentResponse.value,
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
    sidecar_sha256: state.runtime.sidecar_sha256,
    config_sha256: state.runtime.config_sha256,
    exif_fixture_sha256: contract.fixtures.exif6.sha256,
    sidecar_stopped: true,
  }
  await recordEvidence(runtime.runRoot, 'prepare', projection)
  return projection
}

function caseKey(value) {
  if (!['clear', 'messy', 'exif6'].includes(value)) throw new HarnessError('CASE_INVALID')
  return value
}

function caseFixturePath(runtime, state, contract, env, key) {
  if (key === 'exif6') return join(runtime.runRoot, state.runtime.exif_fixture)
  const docsRoot = resolve(env.HEXCLAW_DOCS_ROOT || DEFAULT_DOCS_ROOT)
  return fixturePath(docsRoot, contract.fixtures[key])
}

async function loadCallbackEnvelope(runtime, key) {
  const pathname = join(runtime.envelopeDirectory, `${key}.json`)
  await requireRegularFile(pathname, 'CALLBACK_ENVELOPE_UNAVAILABLE', { privateFile: true })
  let envelope
  try {
    envelope = JSON.parse(await readFile(pathname, 'utf8'))
  } catch {
    throw new HarnessError('CALLBACK_ENVELOPE_INVALID')
  }
  const body = object(envelope.body, 'CALLBACK_ENVELOPE_INVALID')
  const headers = object(envelope.headers, 'CALLBACK_ENVELOPE_INVALID')
  if (
    envelope.instance_id !== runtime.instanceID ||
    body.msgtype !== 'picture' ||
    body.conversationType === '2' ||
    !nonEmpty(body.msgId, 'CALLBACK_ENVELOPE_INVALID') ||
    !nonEmpty(body.senderStaffId, 'CALLBACK_ENVELOPE_INVALID') ||
    !nonEmpty(body.content?.downloadCode, 'CALLBACK_ENVELOPE_INVALID') ||
    !nonEmpty(headers.timestamp, 'CALLBACK_ENVELOPE_INVALID') ||
    !nonEmpty(headers.sign, 'CALLBACK_ENVELOPE_INVALID')
  )
    throw new HarnessError('CALLBACK_ENVELOPE_INVALID')
  const callbackTarget = {
    platform: 'dingtalk',
    instance_id: runtime.instanceID,
    chat_id: body.senderStaffId,
  }
  if (physicalTargetKey(callbackTarget) !== physicalTargetKey(runtime.expectedTargets[0])) {
    throw new HarnessError('CALLBACK_DIRECT_TARGET_DRIFT')
  }
  return {
    body,
    headers: {
      timestamp: headers.timestamp,
      sign: headers.sign,
      'content-type': 'application/json',
    },
    identity: {
      platform: 'dingtalk',
      instance_id: runtime.instanceID,
      chat_id: body.senderStaffId,
      provider_message_id: body.msgId,
    },
    digest: sha256Text(canonicalJSON({ body, headers })),
  }
}

function inboundQueryPath(runtime, state, identity) {
  const query = new URLSearchParams({
    agent: state.agent_name,
    platform: identity.platform,
    instance_id: identity.instance_id,
    chat_id: identity.chat_id,
    provider_message_id: identity.provider_message_id,
  })
  return `${runtime.inboundQueryPath}?${query.toString()}`
}

async function queryInbound(api, runtime, state, identity, allowMissing = false) {
  const response = await apiFetch(api, 'GET', inboundQueryPath(runtime, state, identity), {
    allowed: allowMissing ? [200, 404] : [200],
    code: 'INBOUND_PUBLIC_QUERY_FAILED',
  })
  return response.value
}

async function postCallback(api, runtime, envelope) {
  const route = `/api/v1/platforms/hooks/dingtalk/${encodeURIComponent(runtime.instanceID)}`
  return await apiFetch(api, 'POST', route, {
    data: envelope.body,
    headers: envelope.headers,
    parse: false,
    code: 'CALLBACK_POST_FAILED',
  })
}

function assertAdmissionReplay(before, after) {
  const immutable = (bundle) => ({
    receipt_id: bundle.receipt?.receipt_id,
    asset_id: bundle.asset?.asset_id,
    asset_digest: bundle.asset?.digest,
    dispatch_id: bundle.dispatch?.dispatch_id,
    identity: bundle.receipt?.identity,
    command_digest: bundle.receipt?.command_digest,
  })
  if (canonicalJSON(immutable(before)) !== canonicalJSON(immutable(after))) {
    throw new HarnessError('CALLBACK_REPLAY_CHANGED_ADMISSION')
  }
}

async function admitPhase(env, deadline, rawKey) {
  const key = caseKey(rawKey)
  const contract = await loadContract()
  const runtime = liveRuntime(env)
  const state = await loadState(runtime.runRoot)
  if (state.cases[key]?.admitted) {
    return {
      status: 'already_admitted',
      phase: `admit-${key}`,
      ...state.cases[key].admission_evidence,
    }
  }
  const fixture = contract.fixtures[key]
  await validateFixture(caseFixturePath(runtime, state, contract, env, key), fixture)
  const envelope = await loadCallbackEnvelope(runtime, key)
  let first
  let replayed
  await withSidecar(runtime, env, deadline, async (api) => {
    await postCallback(api, runtime, envelope)
    const until = Math.min(deadline - 5_000, Date.now() + 90_000)
    while (Date.now() < until) {
      first = await queryInbound(api, runtime, state, envelope.identity, true)
      if (first) break
      await sleep(500)
    }
    if (!first) throw new HarnessError('DURABLE_ADMISSION_NOT_OBSERVED')
    assertInboundBundle(first, {
      identity: envelope.identity,
      agent_name: state.agent_name,
      expected_asset_digest: `sha256:${fixture.sha256}`,
    })
    // 同一个有效 callback 在 admission 后立即重放，避免媒体临时码过期掩盖幂等事实。
    await postCallback(api, runtime, envelope)
    replayed = await queryInbound(api, runtime, state, envelope.identity)
    assertAdmissionReplay(first, replayed)
  })
  const admissionEvidence = assertInboundBundle(replayed, {
    identity: envelope.identity,
    agent_name: state.agent_name,
    expected_asset_digest: `sha256:${fixture.sha256}`,
  })
  state.last_process_log = runtime.lastProcessLog
  state.cases[key] = {
    admitted: true,
    fixture_sha256: fixture.sha256,
    fixture_path: relative(runtime.runRoot, caseFixturePath(runtime, state, contract, env, key)),
    callback_envelope_digest: envelope.digest,
    callback_posts: 2,
    identity: envelope.identity,
    admission_bundle: replayed,
    admission_evidence: admissionEvidence,
  }
  await saveState(runtime.runRoot, state)
  const projection = {
    status: 'admitted',
    phase: `admit-${key}`,
    callback_posts: 2,
    fixture_sha256: fixture.sha256,
    ...admissionEvidence,
  }
  await recordEvidence(runtime.runRoot, `admit-${key}`, projection)
  return projection
}

function recursiveArtifact(value, artifactID) {
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = recursiveArtifact(child, artifactID)
      if (found) return found
    }
    return null
  }
  if (!value || typeof value !== 'object') return null
  if (value.artifact_id === artifactID) return value
  for (const child of Object.values(value)) {
    const found = recursiveArtifact(child, artifactID)
    if (found) return found
  }
  return null
}

function assertCanonicalSource(taskResult, fixture, key) {
  const aggregateDigest = normalizedDigest(
    taskResult?.source_digest,
    'CANONICAL_SOURCE_DIGEST_INVALID',
  )
  const attachments = array(taskResult?.source_attachments, 'CANONICAL_SOURCE_ATTACHMENTS_INVALID')
  if (attachments.length !== 1) throw new HarnessError('CANONICAL_SOURCE_ATTACHMENTS_INVALID')
  const attachment = object(attachments[0], 'CANONICAL_SOURCE_ATTACHMENTS_INVALID')
  const attachmentDigest = normalizedDigest(attachment.digest, 'CANONICAL_SOURCE_DIGEST_INVALID')
  if (!Number.isInteger(attachment.size_bytes) || attachment.size_bytes < 1) {
    throw new HarnessError('CANONICAL_SOURCE_ATTACHMENTS_INVALID')
  }
  if (key === 'exif6') {
    const canonical = object(fixture.canonical, 'EXIF_CANONICAL_CONTRACT_INVALID')
    if (
      attachmentDigest !== canonical.sha256 ||
      aggregateDigest !== canonical.aggregate_sha256 ||
      attachment.size_bytes !== canonical.size_bytes ||
      attachmentDigest === fixture.sha256
    ) {
      throw new HarnessError('EXIF_CANONICAL_SOURCE_DIGEST_DRIFT')
    }
  }
  return {
    aggregate_digest: aggregateDigest,
    attachment_digest: attachmentDigest,
    attachment_size: attachment.size_bytes,
  }
}

function assertRealModelRoute(task, taskResult) {
  if (
    task?.status !== 'routed' ||
    task?.model_id !== EXPECTED_MODEL ||
    !nonEmpty(task?.provider_display_name, 'REAL_IMAGE_TASK_ROUTE_INVALID')
  ) {
    throw new HarnessError('REAL_IMAGE_TASK_ROUTE_INVALID')
  }
  const succeeded = array(
    taskResult?.operation_receipts,
    'REAL_IMAGE_TASK_RECEIPTS_INVALID',
  ).filter((receipt) => receipt?.status === 'succeeded' && (receipt?.provider || receipt?.model))
  if (
    succeeded.length === 0 ||
    succeeded.some(
      (receipt) =>
        receipt.provider !== EXPECTED_PROVIDER ||
        receipt.model !== EXPECTED_MODEL ||
        !Number.isInteger(receipt.attempt) ||
        receipt.attempt < 1 ||
        !nonEmpty(receipt.result_digest, 'REAL_IMAGE_TASK_RECEIPTS_INVALID'),
    )
  ) {
    throw new HarnessError('REAL_IMAGE_TASK_RECEIPTS_INVALID')
  }
  return {
    provider: EXPECTED_PROVIDER,
    model: EXPECTED_MODEL,
    succeeded_receipt_count: succeeded.length,
    invocation_hashes: succeeded
      .map((receipt) =>
        sha256Text(nonEmpty(receipt.invocation_id, 'REAL_IMAGE_TASK_RECEIPTS_INVALID')),
      )
      .sort(),
  }
}

function assertFinalArtifact(artifact, inbound, payload) {
  const value = object(artifact, 'FINAL_ARTIFACT_INVALID')
  if (
    value.artifact_id !== inbound.dispatch.final_artifact_id ||
    !SHA256.test(value.artifact_digest ?? '') ||
    value.coverage_status !== 'complete' ||
    !HAN.test(String(value.canonical_markdown ?? ''))
  )
    throw new HarnessError('FINAL_ARTIFACT_INVALID')
  for (const privateField of [
    'annotated_asset_owner_scope',
    'annotated_asset_id',
    'annotated_mime',
    'annotated_digest',
    'original_source_digest',
  ]) {
    if (Object.hasOwn(value, privateField)) throw new HarnessError('FINAL_ARTIFACT_PRIVATE_FIELD')
  }
  const annotated = object(payload?.annotated_image, 'ANNOTATED_IMAGE_REQUIRED')
  const payloadBytes = decodeCanonicalBase64(annotated.data_base64, 'ANNOTATED_IMAGE_REQUIRED')
  const payloadDigest = normalizedDigest(annotated.digest, 'ANNOTATED_DIGEST_INVALID')
  if (
    !String(annotated.mime ?? '').startsWith('image/') ||
    sha256Bytes(payloadBytes) !== payloadDigest ||
    payload.markdown !== value.canonical_markdown
  )
    throw new HarnessError('FINAL_ARTIFACT_DIGEST_DRIFT')
  if (!HAN.test(String(payload.markdown ?? ''))) {
    throw new HarnessError('FINAL_MARKDOWN_NOT_CHINESE')
  }
  return {
    artifact: value,
    annotated_bytes: payloadBytes,
    annotated_mime: annotated.mime,
    annotated_digest: payloadDigest,
    canonical_markdown: value.canonical_markdown,
  }
}

export function assertStageDigestChain(value) {
  object(value, 'PHOTO_DIGEST_CHAIN_INVALID')
  throw new HarnessError('PHOTO_STAGE_DIGEST_EVIDENCE_UNAVAILABLE')
}

export function buildTrustedGeometryItems(payload, fixture) {
  const modelItems = array(payload?.items, 'PHOTO_ITEMS_INVALID')
  const expectedItems = array(fixture?.expected_items, 'FIXTURE_ORACLE_INVALID')
  if (modelItems.length !== expectedItems.length)
    throw new HarnessError('PHOTO_ITEMS_EXACT_SET_INVALID')
  const bySource = new Map()
  for (const item of modelItems) {
    const question = object(item?.question, 'PHOTO_ITEM_QUESTION_INVALID')
    nonEmpty(question.problem_id, 'PHOTO_ITEM_IDENTITY_INVALID')
    nonEmpty(question.attempt_id, 'PHOTO_ITEM_IDENTITY_INVALID')
    const sourceIdentity = sourceIdentityProjection(
      question,
      'PHOTO_ITEM_SOURCE_IDENTITY_INVALID',
      false,
    )
    const key = canonicalJSON(sourceIdentity)
    if (bySource.has(key)) throw new HarnessError('PHOTO_ITEMS_EXACT_SET_INVALID')
    bySource.set(key, item)
  }
  return expectedItems.map((expectedValue, index) => {
    const expected = object(expectedValue, 'FIXTURE_ORACLE_INVALID')
    if (expected.question !== `Q${index + 1}` || !MANUAL_ORACLE_STATUSES.has(expected.status)) {
      throw new HarnessError('FIXTURE_ORACLE_INVALID')
    }
    const sourceIdentity = sourceIdentityProjection(expected.source_identity)
    const item = bySource.get(canonicalJSON(sourceIdentity))
    if (!item) throw new HarnessError('PHOTO_ITEMS_EXACT_SET_INVALID')
    if (item.status !== expected.status) throw new HarnessError('PHOTO_ITEM_STATUS_DRIFT')
    const bbox = trustedBBoxProjection(expected.bbox)
    return {
      question: expected.question,
      identity: `oracle:${expected.question}\u0000source:${sha256Text(canonicalJSON(sourceIdentity))}`,
      source_identity: sourceIdentity,
      status: expected.status,
      bbox,
      index,
    }
  })
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
        const source = await decode(input.sourceBase64, input.sourceMIME)
        const annotated = await decode(input.annotatedBase64, input.annotatedMIME)
        if (source.width !== annotated.width || source.height !== annotated.height) {
          return {
            source_width: source.width,
            source_height: source.height,
            annotated_width: annotated.width,
            annotated_height: annotated.height,
            pixel_deltas: [],
          }
        }
        const pixelDeltas = []
        for (let offset = 0; offset < source.pixels.length; offset += 4) {
          if (
            source.pixels[offset] !== annotated.pixels[offset] ||
            source.pixels[offset + 1] !== annotated.pixels[offset + 1] ||
            source.pixels[offset + 2] !== annotated.pixels[offset + 2] ||
            source.pixels[offset + 3] !== annotated.pixels[offset + 3]
          ) {
            const pixel = offset / 4
            pixelDeltas.push({
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
          pixel_deltas: pixelDeltas,
        }
      },
      {
        sourceBase64: sourceBytes.toString('base64'),
        sourceMIME,
        annotatedBase64: annotatedBytes.toString('base64'),
        annotatedMIME,
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
    const oracle = await vite.ssrLoadModule('/tests/live/k12-photo-annotation-coverage.ts')
    if (typeof oracle.analyzePhotoAnnotationGeometry !== 'function') {
      throw new HarnessError('ANNOTATION_ORACLE_EXPORT_INVALID')
    }
    return oracle.analyzePhotoAnnotationGeometry(input)
  } finally {
    await vite.close()
  }
}

async function assertAnnotationGeometry(sourcePath, fixture, payload, artifact, annotatedBytes) {
  const sourceBytes = await readFile(sourcePath)
  const facts = await imagePixelDeltas(
    sourceBytes,
    fixture.mime,
    annotatedBytes,
    artifact.annotated_mime,
  )
  const expectedWidth = fixture.display_width ?? fixture.width
  const expectedHeight = fixture.display_height ?? fixture.height
  if (
    facts.source_width !== expectedWidth ||
    facts.source_height !== expectedHeight ||
    facts.annotated_width !== expectedWidth ||
    facts.annotated_height !== expectedHeight
  )
    throw new HarnessError('ANNOTATION_GEOMETRY_DIMENSION_DRIFT')
  const report = await analyzeGeometry({
    width: facts.source_width,
    height: facts.source_height,
    sourceDigest: artifact.original_source_digest,
    annotatedDigest: artifact.annotated_digest,
    changedPixels: facts.pixel_deltas,
    items: buildTrustedGeometryItems(payload, fixture),
    expectedCounts: fixture.expected_counts,
  })
  if (report?.status !== 'PASS') throw new HarnessError('ANNOTATION_GEOMETRY_FAILED')
  return report
}

export async function reconcileOutcomeUnknownBatch(batch, options) {
  const current = object(batch, 'DELIVERY_BATCH_QUERY_FAILED')
  if (current.status === 'delivered') {
    return { batch: current, provider_query_invoked: false }
  }
  if (current.status !== 'outcome_unknown') {
    throw new PhasePending('DELIVERY_NOT_TERMINAL', { batch_status: current.status ?? 'unknown' })
  }
  if (
    options?.query_allowed === false ||
    options?.query_already_invoked === true ||
    typeof options?.query !== 'function'
  ) {
    throw new PhasePending('DELIVERY_OUTCOME_UNKNOWN_PENDING', {
      batch_status: current.status,
      provider_query_invoked: options?.query_already_invoked === true,
    })
  }
  const batchID = encodeURIComponent(nonEmpty(options.batch_id, 'DELIVERY_BATCH_QUERY_FAILED'))
  const agentName = nonEmpty(options.agent_name, 'DELIVERY_BATCH_QUERY_FAILED')
  const request = {
    method: 'POST',
    path: `/api/k12/delivery-batches/${batchID}/query`,
    data: { agent: agentName },
  }
  const queried = object(await options.query(request), 'DELIVERY_PROVIDER_QUERY_FAILED')
  if (queried.status !== 'delivered') {
    throw new PhasePending('DELIVERY_OUTCOME_UNKNOWN_PENDING', {
      batch_status: queried.status ?? 'unknown',
      provider_query_invoked: true,
    })
  }
  return { batch: queried, provider_query_invoked: true }
}

async function fetchCaseSnapshot(api, runtime, state, saved, contract, env, key, allowQuery) {
  let inbound = await queryInbound(api, runtime, state, saved.identity)
  let inboundEvidence = assertInboundBundle(inbound, {
    identity: saved.identity,
    agent_name: state.agent_name,
    expected_asset_digest: `sha256:${saved.fixture_sha256}`,
  })
  if (
    inbound.dispatch?.processing_status !== 'final_artifact_ready' ||
    !inbound.dispatch?.image_task_id ||
    !inbound.dispatch?.final_artifact_id ||
    !inbound.dispatch?.delivery_batch_id
  )
    throw new PhasePending('PHOTO_GRADING_PENDING', inboundEvidence)
  const taskID = encodeURIComponent(inbound.dispatch.image_task_id)
  const agent = encodeURIComponent(state.agent_name)
  const taskResponse = await apiFetch(api, 'GET', `/api/k12/image-tasks/${taskID}?agent=${agent}`, {
    code: 'IMAGE_TASK_QUERY_FAILED',
  })
  const resultResponse = await apiFetch(
    api,
    'GET',
    `/api/k12/image-tasks/${taskID}/result?agent=${agent}`,
    { code: 'IMAGE_TASK_RESULT_QUERY_FAILED' },
  )
  const task = taskResponse.value
  const taskResult = resultResponse.value
  if (
    taskResult?.status !== 'routed' ||
    taskResult?.task_intent !== 'completed_homework' ||
    taskResult?.result?.kind !== 'completed_homework'
  )
    throw new HarnessError('REAL_IMAGE_TASK_ROUTE_INVALID')
  const modelRoute = assertRealModelRoute(task, taskResult)
  const canonicalSource = assertCanonicalSource(taskResult, contract.fixtures[key], key)
  const payload = object(taskResult.result.payload, 'PHOTO_RESULT_INVALID')
  const artifact = recursiveArtifact(task, inbound.dispatch.final_artifact_id)
  if (!artifact) throw new HarnessError('FINAL_ARTIFACT_NOT_PUBLIC')
  const final = assertFinalArtifact(artifact, inbound, payload)
  const batchPath = `/api/k12/delivery-batches/${encodeURIComponent(
    inbound.dispatch.delivery_batch_id,
  )}?agent=${agent}`
  let batch = (await apiFetch(api, 'GET', batchPath, { code: 'DELIVERY_BATCH_QUERY_FAILED' })).value
  const reconciled = await reconcileOutcomeUnknownBatch(batch, {
    batch_id: inbound.dispatch.delivery_batch_id,
    agent_name: state.agent_name,
    query_allowed: allowQuery,
    query_already_invoked: saved.provider_query_invoked === true,
    query: async (request) => {
      saved.provider_query_invoked = true
      return (
        await apiFetch(api, request.method, request.path, {
          data: request.data,
          code: 'DELIVERY_PROVIDER_QUERY_FAILED',
        })
      ).value
    },
  })
  batch = reconciled.batch
  if (reconciled.provider_query_invoked) saved.provider_query_invoked = true
  if (inbound.dispatch.reply_status !== 'delivered') {
    inbound = await queryInbound(api, runtime, state, saved.identity)
    inboundEvidence = assertInboundBundle(inbound, {
      identity: saved.identity,
      agent_name: state.agent_name,
      expected_asset_digest: `sha256:${saved.fixture_sha256}`,
    })
    if (inbound.dispatch?.reply_status !== 'delivered') {
      throw new PhasePending('DELIVERY_OUTCOME_UNKNOWN_PENDING', {
        ...inboundEvidence,
        batch_status: batch.status,
        provider_query_invoked: saved.provider_query_invoked === true,
      })
    }
  }
  const delivery = assertDeliveryExactSet(batch, {
    agent_name: state.agent_name,
    inbound_receipt_id: inbound.receipt.receipt_id,
    final_artifact_id: inbound.dispatch.final_artifact_id,
    final_artifact_digest: final.artifact.artifact_digest,
    expected_targets: state.expected_targets,
    canonical_markdown: final.canonical_markdown,
    annotated_mime: final.annotated_mime,
    annotated_digest: final.annotated_digest,
    annotated_bytes: final.annotated_bytes,
  })
  const sourcePath = caseFixturePath(runtime, state, contract, env, key)
  const contractProjection = validateContract(contract)
  const fixture = {
    ...contract.fixtures[key],
    expected_items: contractProjection.fixtures[key].expected_items,
  }
  const geometry = await assertAnnotationGeometry(
    sourcePath,
    fixture,
    payload,
    {
      original_source_digest: canonicalSource.attachment_digest,
      annotated_digest: final.annotated_digest,
      annotated_mime: final.annotated_mime,
    },
    final.annotated_bytes,
  )
  const digestChain = assertStageDigestChain({
    expected_raw_digest: saved.fixture_sha256,
    admission_raw_digest: inbound.asset.digest,
    canonical_aggregate_digest: canonicalSource.aggregate_digest,
    canonical_attachment_digest: canonicalSource.attachment_digest,
    final_artifact_digest: final.artifact.artifact_digest,
    final_annotated_digest: final.annotated_digest,
    delivered_annotated_digest: delivery.annotated_digest,
  })
  return {
    snapshot: {
      inbound,
      batch,
      final_artifact: final.artifact,
      canonical_source: canonicalSource,
      annotated: { mime: final.annotated_mime, digest: final.annotated_digest },
    },
    proof: {
      inbound: inboundEvidence,
      route: modelRoute,
      canonical_source_digest: canonicalSource.aggregate_digest,
      canonical_source_attachment_digest: canonicalSource.attachment_digest,
      canonical_source_attachment_size: canonicalSource.attachment_size,
      final_artifact_id_sha256: sha256Text(final.artifact.artifact_id),
      final_artifact_digest: final.artifact.artifact_digest,
      annotated_digest: final.annotated_digest,
      digest_chain: digestChain,
      image_task_id_sha256: sha256Text(inbound.dispatch.image_task_id),
      geometry: {
        status: geometry.status,
        width: geometry.width,
        height: geometry.height,
        changed_pixels: geometry.changed_pixels,
        palette_pixels: geometry.palette_pixels,
        ignored_changed_pixels: geometry.ignored_changed_pixels,
        ignored_changed_pixel_ratio: geometry.ignored_changed_pixel_ratio,
        max_ignored_changed_pixel_ratio: geometry.max_ignored_changed_pixel_ratio,
        expected_counts: geometry.expected_counts,
        observed_counts: geometry.observed_counts,
        mapping_hashes: geometry.mappings.map((mapping) => mapping.cluster_sha256).sort(),
      },
      delivery,
    },
  }
}

async function fetchRestartCheckpointSnapshot(
  api,
  runtime,
  state,
  saved,
  contract,
  env,
  stage,
  enforceStage,
) {
  if (stage === 'after_send') {
    const current = await fetchCaseSnapshot(
      api,
      runtime,
      state,
      saved,
      contract,
      env,
      'exif6',
      true,
    )
    restartCheckpointInvariant(current.snapshot, stage, enforceStage)
    return current.snapshot
  }
  const inbound = await queryInbound(api, runtime, state, saved.identity)
  assertInboundBundle(inbound, {
    identity: saved.identity,
    agent_name: state.agent_name,
    expected_asset_digest: `sha256:${saved.fixture_sha256}`,
  })
  if (!inbound.dispatch?.image_task_id) {
    throw new HarnessError('RESTART_CHECKPOINT_STAGE_NOT_OBSERVED')
  }
  const taskID = encodeURIComponent(inbound.dispatch.image_task_id)
  const agent = encodeURIComponent(state.agent_name)
  const taskResult = (
    await apiFetch(api, 'GET', `/api/k12/image-tasks/${taskID}/result?agent=${agent}`, {
      code: 'IMAGE_TASK_RESULT_QUERY_FAILED',
    })
  ).value
  const canonicalSource = assertCanonicalSource(taskResult, contract.fixtures.exif6, 'exif6')
  const snapshot = { inbound, canonical_source: canonicalSource }
  if (stage === 'before_send') {
    const task = (
      await apiFetch(api, 'GET', `/api/k12/image-tasks/${taskID}?agent=${agent}`, {
        code: 'IMAGE_TASK_QUERY_FAILED',
      })
    ).value
    const payload = object(taskResult?.result?.payload, 'PHOTO_RESULT_INVALID')
    const artifact = recursiveArtifact(task, inbound.dispatch.final_artifact_id)
    if (!artifact) throw new HarnessError('FINAL_ARTIFACT_NOT_PUBLIC')
    const final = assertFinalArtifact(artifact, inbound, payload)
    snapshot.final_artifact = final.artifact
    snapshot.annotated = { mime: final.annotated_mime, digest: final.annotated_digest }
  }
  restartCheckpointInvariant(snapshot, stage, enforceStage)
  return snapshot
}

async function restartCheckpointPhase(env, deadline, stage) {
  void env
  void deadline
  if (!['admission', 'grading', 'before_send', 'after_send'].includes(stage)) {
    throw new HarnessError('RESTART_CHECKPOINT_STAGE_INVALID')
  }
  throw new HarnessError('RESTART_DETERMINISTIC_FENCE_UNAVAILABLE')
}

async function verifyPhase(env, deadline, rawKey) {
  const key = caseKey(rawKey)
  const contract = await loadContract()
  const runtime = liveRuntime(env)
  const state = await loadState(runtime.runRoot)
  const saved = state.cases[key]
  if (!saved?.admitted) throw new HarnessError('CASE_ADMISSION_REQUIRED')
  if (saved.verified) return { status: 'already_verified', phase: `verify-${key}`, ...saved.proof }
  let result
  await withSidecar(runtime, env, deadline, async (api) => {
    while (Date.now() < deadline - 5_000) {
      try {
        result = await fetchCaseSnapshot(api, runtime, state, saved, contract, env, key, true)
        return
      } catch (error) {
        if (!(error instanceof PhasePending)) throw error
        saved.last_progress = error.projection
        await saveState(runtime.runRoot, state)
      }
      await sleep(2_000)
    }
    throw new PhasePending('PHOTO_GRADING_PENDING', saved.last_progress ?? {})
  })
  state.last_process_log = runtime.lastProcessLog
  saved.verified = true
  saved.snapshot = result.snapshot
  saved.proof = result.proof
  await saveState(runtime.runRoot, state)
  const projection = { status: 'verified', phase: `verify-${key}`, ...result.proof }
  await recordEvidence(runtime.runRoot, `verify-${key}`, projection)
  return projection
}

async function restartPhase(env, deadline) {
  const contract = await loadContract()
  const runtime = liveRuntime(env)
  const state = await loadState(runtime.runRoot)
  for (const key of ['clear', 'messy', 'exif6']) {
    if (!state.cases[key]?.verified) throw new HarnessError('ALL_CASES_VERIFIED_REQUIRED')
  }
  const proofs = {}
  await withSidecar(runtime, env, deadline, async (api) => {
    for (const key of ['clear', 'messy', 'exif6']) {
      const saved = state.cases[key]
      const current = await fetchCaseSnapshot(api, runtime, state, saved, contract, env, key, true)
      assertRestartInvariant(saved.snapshot, current.snapshot)
      proofs[key] = {
        invariant_sha256: sha256Text(canonicalJSON(invariantSnapshot(current.snapshot))),
        provider_action: 'query_only',
      }
    }
  })
  state.last_process_log = runtime.lastProcessLog
  state.restart = { verified: true, proofs }
  await saveState(runtime.runRoot, state)
  const projection = { status: 'verified', phase: 'restart', sidecar_stopped: true, cases: proofs }
  await recordEvidence(runtime.runRoot, 'restart', projection)
  return projection
}

async function replayPhase(env, deadline) {
  const contract = await loadContract()
  const runtime = liveRuntime(env)
  const state = await loadState(runtime.runRoot)
  const proofs = {}
  await withSidecar(runtime, env, deadline, async (api) => {
    for (const key of ['clear', 'messy', 'exif6']) {
      const saved = state.cases[key]
      if (!saved?.verified || saved.callback_posts !== 2) {
        throw new HarnessError('CALLBACK_REPLAY_ADMISSION_PROOF_REQUIRED')
      }
      const current = await fetchCaseSnapshot(api, runtime, state, saved, contract, env, key, false)
      assertDuplicateCallbackInvariant(saved.snapshot, current.snapshot)
      proofs[key] = {
        callback_posts: saved.callback_posts,
        new_provider_send_count: 0,
        invariant_sha256: sha256Text(canonicalJSON(invariantSnapshot(current.snapshot))),
      }
    }
  })
  state.last_process_log = runtime.lastProcessLog
  state.replay = { verified: true, proofs }
  await saveState(runtime.runRoot, state)
  const projection = { status: 'verified', phase: 'replay', cases: proofs }
  await recordEvidence(runtime.runRoot, 'replay', projection)
  return projection
}

async function statusPhase(env) {
  const runtime = liveRuntime(env)
  const state = await loadState(runtime.runRoot)
  const cases = {}
  for (const key of ['clear', 'messy', 'exif6']) {
    const saved = state.cases[key]
    cases[key] = {
      admitted: saved?.admitted === true,
      verified: saved?.verified === true,
      callback_posts: saved?.callback_posts ?? 0,
      fixture_sha256: saved?.fixture_sha256,
      final_artifact_digest: saved?.proof?.final_artifact_digest,
      annotated_digest: saved?.proof?.annotated_digest,
    }
  }
  return assertEvidenceSafe({
    status: 'observed',
    phase: 'status',
    run_id_sha256: sha256Text(state.run_id),
    cases,
    restart_verified: state.restart?.verified === true,
    restart_checkpoints: Object.fromEntries(
      ['admission', 'grading', 'before_send', 'after_send'].map((stage) => [
        stage,
        state.restart_checkpoints?.[stage]?.verified === true,
      ]),
    ),
    replay_verified: state.replay?.verified === true,
  })
}

async function runPhase(phase, env, deadline) {
  switch (phase) {
    case 'validate':
      return await validateStatic(env)
    case 'prepare':
      return await preparePhase(env, deadline)
    case 'admit-clear':
      return await admitPhase(env, deadline, 'clear')
    case 'verify-clear':
      return await verifyPhase(env, deadline, 'clear')
    case 'admit-messy':
      return await admitPhase(env, deadline, 'messy')
    case 'verify-messy':
      return await verifyPhase(env, deadline, 'messy')
    case 'admit-exif6':
      return await admitPhase(env, deadline, 'exif6')
    case 'verify-exif6':
      return await verifyPhase(env, deadline, 'exif6')
    case 'restart-admission':
      return await restartCheckpointPhase(env, deadline, 'admission')
    case 'restart-grading':
      return await restartCheckpointPhase(env, deadline, 'grading')
    case 'restart-before-send':
      return await restartCheckpointPhase(env, deadline, 'before_send')
    case 'restart-after-send':
      return await restartCheckpointPhase(env, deadline, 'after_send')
    case 'restart':
      return await restartPhase(env, deadline)
    case 'replay':
      return await replayPhase(env, deadline)
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
    process.stdout.write(`${JSON.stringify(assertEvidenceSafe(redactEvidence(result)), null, 2)}\n`)
  } catch (error) {
    const pending = error instanceof PhasePending
    const output = {
      status: pending ? 'pending' : 'failed',
      phase,
      code: safeCode(error),
      ...(error?.diagnostic_sha256 ? { diagnostic_sha256: error.diagnostic_sha256 } : {}),
      ...(pending ? { projection: redactEvidence(error.projection) } : {}),
    }
    process.stderr.write(`${JSON.stringify(assertEvidenceSafe(output), null, 2)}\n`)
    process.exitCode = pending ? PENDING_EXIT_CODE : 1
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath === resolve(SCRIPT_PATH)) await main()
