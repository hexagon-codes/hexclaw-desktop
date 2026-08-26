import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const LIVE_ROOT = dirname(fileURLToPath(import.meta.url))
const SCRIPT_PATH = resolve(LIVE_ROOT, 'k12-dingtalk-photo-grading-headless.mjs')
const CONTRACT_PATH = resolve(LIVE_ROOT, 'k12-dingtalk-photo-grading-headless.contract.json')
const modulePromise = import('./k12-dingtalk-photo-grading-headless.mjs')
const CANONICAL_MARKDOWN = '## 作业批改\n\n请重点订正错题。'
const ANNOTATED_BYTES = Buffer.from('frozen-annotated-image-bytes')
const FINAL_ARTIFACT_DIGEST = '8'.repeat(64)
const CLEAR_ORACLE = Object.freeze([
  ...Array.from({ length: 14 }, (_, index) => ({ question: `Q${index + 1}`, status: 'correct' })),
  { question: 'Q15', status: 'correct_with_process_issue' },
  { question: 'Q16', status: 'correct_with_process_issue' },
])
const MESSY_ORACLE = Object.freeze(
  Array.from({ length: 16 }, (_, index) => {
    const ordinal = index + 1
    const status = [8, 10, 15].includes(ordinal)
      ? 'wrong'
      : ordinal === 16
        ? 'unanswered'
        : 'correct'
    return { question: `Q${ordinal}`, status }
  }),
)

function sourceIdentity(section, label, ordinal, numberPath = [], displayLabel = '') {
  return {
    source_number_path: numberPath,
    display_label: displayLabel,
    source_section_path: [section],
    source_section_label: label,
    system_section_ordinal: ordinal,
    system_display_label: ordinal > 0 ? `第 ${ordinal} 题（系统序号）` : '',
  }
}

const FROZEN_SOURCES = Object.freeze([
  ...Array.from({ length: 9 }, (_, index) => sourceIdentity('一', '一、直接写得数', index + 1)),
  ...Array.from({ length: 3 }, (_, index) =>
    sourceIdentity('二', '二、计算下面各题，能简算的要简算', index + 1),
  ),
  sourceIdentity('三', '三、列式计算', 0, ['三', '1'], '三、1'),
  sourceIdentity('三', '三、列式计算', 0, ['三', '2'], '三、2'),
  sourceIdentity('四', '四、应用题', 1),
  sourceIdentity('五', '五、思维题', 1),
])

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

function photoReplyObjectID() {
  return `photo-reply-${digest(`receipt-1\0artifact-1\0${FINAL_ARTIFACT_DIGEST}`)}`
}

const identity = Object.freeze({
  platform: 'dingtalk',
  instance_id: 'family-test',
  chat_id: 'parent-chat',
  provider_message_id: 'provider-message-1',
})

function inboundBundle(overrides = {}) {
  const base = {
    receipt: {
      receipt_id: 'receipt-1',
      agent_name: 'xiaoming',
      binding_id: 'binding-1',
      identity,
      command_digest: `sha256:${'1'.repeat(64)}`,
      created_at: 1,
      updated_at: 2,
    },
    asset: {
      asset_id: 'asset-1',
      receipt_id: 'receipt-1',
      name: 'homework.png',
      mime: 'image/png',
      size: 1024,
      digest: `sha256:${'2'.repeat(64)}`,
      created_at: 1,
    },
    dispatch: {
      dispatch_id: 'dispatch-1',
      receipt_id: 'receipt-1',
      processing_status: 'final_artifact_ready',
      routing_decision: 'new_submission',
      confirmation_status: 'not_required',
      image_task_id: 'image-task-1',
      final_artifact_id: 'artifact-1',
      reply_status: 'delivered',
      delivery_batch_id: 'batch-1',
      version: 5,
      created_at: 1,
      updated_at: 2,
    },
  }
  return Object.assign(structuredClone(base), overrides)
}

function deliveredBatch(
  targets = [{ platform: 'dingtalk', instance_id: 'family-test', chat_id: 'parent-chat' }],
) {
  const markdownDigest = digest(CANONICAL_MARKDOWN)
  const annotatedDigest = digest(ANNOTATED_BYTES)
  const receipts = []
  let ordinal = 1
  for (const target of targets) {
    const markdownPayload = JSON.stringify({
      kind: 'markdown',
      ordinal: 1,
      digest: `sha256:${markdownDigest}`,
      text: '## 作业批改\n\n请重点订正错题。',
      message_content: { locale: 'zh-CN', markdown: CANONICAL_MARKDOWN },
    })
    receipts.push({
      delivery_id: `delivery-${ordinal}`,
      batch_id: 'batch-1',
      batch_ordinal: ordinal++,
      part_kind: 'markdown',
      part_mime: '',
      part_ordinal: 1,
      part_digest: `sha256:${markdownDigest}`,
      binding_id: `binding-${target.instance_id}`,
      target,
      status: 'delivered',
      dedupe_key: `dedupe-${target.instance_id}-markdown`,
      payload_digest: `sha256:${digest(markdownPayload)}`,
      payload_json: markdownPayload,
      external_message_id: `external-${target.instance_id}-markdown`,
      attempt: 1,
    })
    const artifactPayload = JSON.stringify({
      kind: 'artifact',
      mime: 'image/png',
      ordinal: 2,
      digest: `sha256:${annotatedDigest}`,
      attachment: {
        name: 'annotated.png',
        mime: 'image/png',
        data: ANNOTATED_BYTES.toString('base64'),
      },
      message_content: { locale: 'zh-CN', markdown: CANONICAL_MARKDOWN },
    })
    receipts.push({
      delivery_id: `delivery-${ordinal}`,
      batch_id: 'batch-1',
      batch_ordinal: ordinal++,
      part_kind: 'artifact',
      part_mime: 'image/png',
      part_ordinal: 2,
      part_digest: `sha256:${annotatedDigest}`,
      binding_id: `binding-${target.instance_id}`,
      target,
      status: 'delivered',
      dedupe_key: `dedupe-${target.instance_id}-image`,
      payload_digest: `sha256:${digest(artifactPayload)}`,
      payload_json: artifactPayload,
      external_message_id: `external-${target.instance_id}-image`,
      attempt: 1,
    })
  }
  return {
    batch_id: 'batch-1',
    agent_name: 'xiaoming',
    object_kind: 'dingtalk_photo_grading_reply',
    object_id: photoReplyObjectID(),
    dedupe_key: 'batch-dedupe-1',
    content_digest: `sha256:${'7'.repeat(64)}`,
    status: 'delivered',
    receipts,
  }
}

function deliveryExpectation(expectedTargets) {
  return {
    agent_name: 'xiaoming',
    inbound_receipt_id: 'receipt-1',
    final_artifact_id: 'artifact-1',
    final_artifact_digest: FINAL_ARTIFACT_DIGEST,
    expected_targets: expectedTargets,
    canonical_markdown: CANONICAL_MARKDOWN,
    annotated_mime: 'image/png',
    annotated_digest: digest(ANNOTATED_BYTES),
    annotated_bytes: ANNOTATED_BYTES,
  }
}

function modelOperationReceipts() {
  return [
    {
      invocation_id: 'invocation-grade-1',
      parent_invocation_id: '',
      physical_unit: 'grade',
      operation: 'grade',
      canonical_input_digest: `sha256:${'9'.repeat(64)}`,
      provider: 'hexclaw-gpt',
      model: 'gpt-5.6-sol',
      status: 'succeeded',
      attempt: 1,
      result_digest: `sha256:${'8'.repeat(64)}`,
      request_policy_digest: `sha256:${'7'.repeat(64)}`,
    },
  ]
}

function restartCheckpointSnapshot(stage) {
  const inbound = inboundBundle()
  const dispatch = inbound.dispatch
  const snapshot = {
    inbound,
    canonical_source: {
      aggregate_digest: '9'.repeat(64),
      attachment_digest: 'a'.repeat(64),
      attachment_size: 1024,
    },
    operation_receipts: modelOperationReceipts(),
  }
  if (stage === 'admission') {
    dispatch.processing_status = 'admitted'
    dispatch.reply_status = 'pending'
    delete dispatch.image_task_id
    delete dispatch.final_artifact_id
    delete dispatch.delivery_batch_id
    delete snapshot.canonical_source
    return snapshot
  }
  if (stage === 'grading') {
    dispatch.processing_status = 'image_task_submitted'
    dispatch.reply_status = 'pending'
    delete dispatch.final_artifact_id
    delete dispatch.delivery_batch_id
  }
  snapshot.final_artifact = {
    artifact_id: 'artifact-1',
    artifact_digest: FINAL_ARTIFACT_DIGEST,
  }
  snapshot.annotated = { mime: 'image/png', digest: digest(ANNOTATED_BYTES) }
  if (stage === 'before_send') {
    dispatch.reply_status = 'ready'
    delete dispatch.delivery_batch_id
    return snapshot
  }
  snapshot.batch = deliveredBatch()
  return snapshot
}

test('phases are checkpointable and every command has a hard cap below 30 minutes', async () => {
  const { PHASES, phaseBudgetMilliseconds, resolvePhase } = await modulePromise
  assert.deepEqual(PHASES, [
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
  for (const phase of PHASES) assert.equal(resolvePhase([phase]), phase)
  assert.equal(resolvePhase([]), 'validate')
  assert.throws(() => resolvePhase(['run']), /INVALID_PHASE/u)
  assert.throws(() => resolvePhase(['validate', 'prepare']), /INVALID_PHASE/u)
  assert.ok(phaseBudgetMilliseconds({}) > 0)
  assert.ok(phaseBudgetMilliseconds({}) < 30 * 60_000)
  assert.equal(
    phaseBudgetMilliseconds({ HEXCLAW_DINGTALK_PHOTO_PHASE_TIMEOUT_MS: '1800000' }),
    29 * 60_000,
  )
})

test('contract freezes real model, real bound-app transport, fixtures, EXIF6 and offline validate mode', async () => {
  const { validateContract } = await modulePromise
  const contract = JSON.parse(await readFile(CONTRACT_PATH, 'utf8'))
  const projection = validateContract(contract)

  assert.deepEqual(projection.route, {
    provider: 'hexclaw-gpt',
    model: 'gpt-5.6-sol',
    fallback_allowed: false,
  })
  assert.deepEqual(projection.transport, {
    product_operations: 'hexclaw_public_http_api_only',
    http_driver: 'playwright_api_request_context',
    dws_cli: false,
    direct_dingtalk_http: false,
    direct_store_read: false,
    sqlite_seed_or_write: false,
  })
  assert.deepEqual(projection.fixtureKeys, ['clear', 'messy', 'exif6'])
  assert.deepEqual(
    {
      ...projection.fixtures.clear,
      expected_items: projection.fixtures.clear.expected_items.map(({ question, status }) => ({
        question,
        status,
      })),
    },
    {
      sha256: '0c4b1a972319203b1483ffbce43e8835b1367be53edceea23c89368a2f2bc861',
      size_bytes: 2178059,
      width: 1086,
      height: 1448,
      expected_counts: { green: 14, purple: 2, red: 0, no_mark: 0 },
      expected_items: CLEAR_ORACLE,
    },
  )
  assert.deepEqual(
    {
      ...projection.fixtures.messy,
      expected_items: projection.fixtures.messy.expected_items.map(({ question, status }) => ({
        question,
        status,
      })),
    },
    {
      sha256: '78cf3a1b5c52e12ca17ca13aa71c7a9439baed244e88b438aa2f1f70cd782fb5',
      size_bytes: 191048,
      width: 1280,
      height: 1707,
      expected_counts: { green: 12, purple: 0, red: 3, no_mark: 1 },
      expected_items: MESSY_ORACLE,
    },
  )
  assert.deepEqual(
    projection.fixtures.clear.expected_items.map((item) => item.source_identity),
    FROZEN_SOURCES,
  )
  assert.equal(projection.fixtures.exif6.orientation, 6)
  assert.equal(projection.fixtures.exif6.source_fixture, 'clear')
  assert.equal(
    projection.fixtures.exif6.source_sha256,
    projection.fixtures.clear.sha256,
  )
  assert.equal(projection.fixtures.exif6.source_size_bytes, projection.fixtures.clear.size_bytes)
  assert.equal(projection.fixtures.exif6.source_width, projection.fixtures.clear.width)
  assert.equal(projection.fixtures.exif6.source_height, projection.fixtures.clear.height)
  assert.equal(
    projection.fixtures.exif6.sha256,
    '04f518b246b262adb8cf2fe1cff1d6ff65c5c6a2cd38054b9a0f07fa3ea03ee1',
  )
  assert.equal(projection.fixtures.exif6.encoded_width, 1448)
  assert.equal(projection.fixtures.exif6.encoded_height, 1086)
  assert.equal(projection.fixtures.exif6.display_width, 1086)
  assert.equal(projection.fixtures.exif6.display_height, 1448)
  assert.equal(
    projection.fixtures.exif6.canonical_sha256,
    '43c6d2f3266ff98b341c060acd80e130dafbf824cb8e6f6cae770853b09e7654',
  )
  assert.equal(
    projection.fixtures.exif6.canonical_aggregate_sha256,
    'c2e58c080093481f50c66b2786f9b634d0645a2e7a1c2b2d411c827a27113fe2',
  )
  assert.equal(projection.fixtures.exif6.canonical_size_bytes, 1454456)
  assert.deepEqual(Object.keys(projection.fixtures.exif6.corner_samples).sort(), [
    'bottom_left',
    'bottom_right',
    'top_left',
    'top_right',
  ])
  assert.deepEqual(projection.fixtures.exif6.corner_mapping, [
    {
      encoded: 'top_left',
      encoded_xy: [0, 0],
      canonical: 'top_right',
      canonical_xy: [1085, 0],
    },
    {
      encoded: 'top_right',
      encoded_xy: [1447, 0],
      canonical: 'bottom_right',
      canonical_xy: [1085, 1447],
    },
    {
      encoded: 'bottom_right',
      encoded_xy: [1447, 1085],
      canonical: 'bottom_left',
      canonical_xy: [0, 1447],
    },
    {
      encoded: 'bottom_left',
      encoded_xy: [0, 1085],
      canonical: 'top_left',
      canonical_xy: [0, 0],
    },
  ])
  assert.deepEqual(projection.annotation_oracle, {
    exif6_pixel_baseline: 'independent_canonical_png',
    max_ignored_changed_pixel_ratio: 0,
  })
  assert.deepEqual(projection.restart_checkpoints, {
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
  })
  assert.deepEqual(projection.validate_side_effects, {
    sidecar_starts: 0,
    callback_posts: 0,
    model_calls: 0,
    im_sends: 0,
    provider_queries: 0,
  })
  assert.equal(contract.delivery.object_kind, 'dingtalk_photo_grading_reply')
  assert.equal(contract.delivery.object_id_prefix, 'photo-reply-')
  assert.deepEqual(contract.delivery.object_id_hash_fields, [
    'inbound_receipt_id',
    'final_artifact_id',
    'final_artifact_digest',
  ])
  assert.equal(contract.delivery.object_id_equals_final_artifact_id, false)
  assert.equal(contract.delivery.target_mode, 'inbound_callback_direct_target')
  assert.equal(contract.delivery.target_count, 1)
})

test('manual Q1-Q16 oracle binds by frozen source identity and rejects model status drift', async () => {
  const { buildTrustedGeometryItems, validateContract } = await modulePromise
  const contract = JSON.parse(await readFile(CONTRACT_PATH, 'utf8'))
  const projection = validateContract(contract)
  const payloadItems = projection.fixtures.clear.expected_items.map((expected, index) => ({
    status: expected.status,
    question: {
      problem_id: `problem-${index + 1}`,
      attempt_id: `attempt-${index + 1}`,
      ...structuredClone(expected.source_identity),
      bbox: { x: 0.99, y: 0.99, w: 0.01, h: 0.01 },
    },
  }))
  const payload = { items: [...payloadItems].reverse() }

  const clear = buildTrustedGeometryItems(payload, projection.fixtures.clear)

  assert.deepEqual(
    clear.map(({ question, status }) => ({ question, status })),
    CLEAR_ORACLE,
  )
  assert.deepEqual(
    clear.map((item) => item.bbox),
    projection.fixtures.clear.expected_items.map((item) => item.bbox),
  )
  assert.deepEqual(
    clear.map((item) => item.source_identity),
    FROZEN_SOURCES,
  )

  const drifted = structuredClone(payload)
  drifted.items[0].status = 'failed'
  assert.throws(
    () => buildTrustedGeometryItems(drifted, projection.fixtures.clear),
    /PHOTO_ITEM_STATUS_DRIFT/u,
  )
})

test('EXIF6 freezes exact clear-sheet rotation geometry and samples asymmetric canonical bytes', async () => {
  const { exif6CornerMapping } = await modulePromise
  assert.deepEqual(exif6CornerMapping(1448, 1086), [
    {
      encoded: 'top_left',
      encoded_xy: [0, 0],
      canonical: 'top_right',
      canonical_xy: [1085, 0],
    },
    {
      encoded: 'top_right',
      encoded_xy: [1447, 0],
      canonical: 'bottom_right',
      canonical_xy: [1085, 1447],
    },
    {
      encoded: 'bottom_right',
      encoded_xy: [1447, 1085],
      canonical: 'bottom_left',
      canonical_xy: [0, 1447],
    },
    {
      encoded: 'bottom_left',
      encoded_xy: [0, 1085],
      canonical: 'top_left',
      canonical_xy: [0, 0],
    },
  ])
})

test('outcome_unknown is queried once through batch query and never resent', async () => {
  const { reconcileOutcomeUnknownBatch } = await modulePromise
  const calls = []
  const resolved = await reconcileOutcomeUnknownBatch(
    { status: 'outcome_unknown' },
    {
      batch_id: 'batch-1',
      agent_name: 'xiaoming',
      query_already_invoked: false,
      query: async (request) => {
        calls.push(request)
        return { status: 'delivered' }
      },
    },
  )
  assert.deepEqual(calls, [
    {
      method: 'POST',
      path: '/api/k12/delivery-batches/batch-1/query',
      data: { agent: 'xiaoming' },
    },
  ])
  assert.equal(resolved.provider_query_invoked, true)
  assert.equal(resolved.batch.status, 'delivered')
  await assert.rejects(
    () =>
      reconcileOutcomeUnknownBatch(
        { status: 'outcome_unknown' },
        {
          batch_id: 'batch-1',
          agent_name: 'xiaoming',
          query_already_invoked: true,
          query: async () => {
            throw new Error('query must not repeat')
          },
        },
      ),
    /DELIVERY_OUTCOME_UNKNOWN_PENDING/u,
  )
})

test('restart checkpoints preserve every identity already frozen at the exact product fence', async () => {
  const { assertRestartCheckpoint } = await modulePromise
  for (const stage of ['admission', 'grading', 'before_send', 'after_send']) {
    const before = restartCheckpointSnapshot(stage)
    const after = structuredClone(before)
    after.inbound.dispatch.version += 1
    assert.equal(assertRestartCheckpoint(stage, before, after), after)
    if (stage !== 'admission') {
      const repeatedModel = structuredClone(after)
      repeatedModel.operation_receipts[0].attempt = 2
      assert.throws(
        () => assertRestartCheckpoint(stage, before, repeatedModel),
        /RESTART_CHECKPOINT_IDENTITY_DRIFT/u,
      )
    }
  }
})

test('six-stage canonical digest audit accepts one frozen canonical root and rejects stage drift', async () => {
  const { assertStageDigestChain } = await modulePromise
  const canonicalDigest = '2'.repeat(64)
  const chain = {
    expected_raw_digest: '1'.repeat(64),
    admission_raw_digest: `sha256:${'1'.repeat(64)}`,
    canonical_aggregate_digest: canonicalDigest,
    canonical_attachment_digest: '3'.repeat(64),
    final_artifact_digest: '4'.repeat(64),
    final_annotated_digest: '5'.repeat(64),
    delivered_annotated_digest: `sha256:${'5'.repeat(64)}`,
    operation_receipts: [
      'classification',
      'recognizing',
      'locating',
      'solve',
      'grade',
      'annotation',
    ].map((operation, index) => ({
      invocation_id: `invocation-${index + 1}`,
      operation,
      canonical_input_digest: `sha256:${canonicalDigest}`,
      result_digest:
        operation === 'annotation' ? `sha256:${'5'.repeat(64)}` : `sha256:${'7'.repeat(64)}`,
    })),
  }
  assert.deepEqual(assertStageDigestChain(chain), {
    canonical_input_digest: canonicalDigest,
    stage_count: 6,
  })
  chain.operation_receipts[4].canonical_input_digest = `sha256:${'6'.repeat(64)}`
  assert.throws(() => assertStageDigestChain(chain), /PHOTO_STAGE_DIGEST_DRIFT/u)

  chain.operation_receipts[4].canonical_input_digest = `sha256:${canonicalDigest}`
  chain.operation_receipts[5].result_digest = `sha256:${'9'.repeat(64)}`
  assert.throws(() => assertStageDigestChain(chain), /PHOTO_STAGE_DIGEST_DRIFT/u)
})

test('EXIF parser recognizes the fixed orientation-6 APP1 segment', async () => {
  const { parseJPEGExifOrientation } = await modulePromise
  const exif = Buffer.from([
    0xff, 0xd8, 0xff, 0xe1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x4d, 0x4d, 0x00, 0x2a,
    0x00, 0x00, 0x00, 0x08, 0x00, 0x01, 0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x06,
    0x00, 0x00, 0x00, 0x00, 0xff, 0xd9,
  ])
  assert.equal(parseJPEGExifOrientation(exif), 6)
  assert.equal(parseJPEGExifOrientation(Buffer.from([0xff, 0xd8, 0xff, 0xd9])), 1)
  assert.throws(() => parseJPEGExifOrientation(Buffer.from('not-a-jpeg')), /JPEG_INVALID/u)
})

test('bound-instance projection accepts only the sidecar credential mask shapes', async () => {
  const { maskedInstanceConfig } = await modulePromise
  assert.equal(
    maskedInstanceConfig({ app_key: 'ding-public-app-id', app_secret: '****' }),
    true,
  )
  assert.equal(maskedInstanceConfig({ app_key: '****1234', app_secret: '****' }), true)
  assert.equal(maskedInstanceConfig(JSON.stringify({ access_token: '••••••••' })), true)
  assert.equal(maskedInstanceConfig({ app_secret: '[REDACTED]' }), true)
  assert.equal(maskedInstanceConfig({ app_secret: 'secret' }), false)
  assert.equal(maskedInstanceConfig({ app_secret: '****secret' }), false)
})

test('inbound proof requires the full DingTalk identity and exposes no secret/raw storage fields', async () => {
  const { assertInboundBundle } = await modulePromise
  const bundle = inboundBundle()
  const projected = assertInboundBundle(bundle, {
    identity,
    agent_name: 'xiaoming',
    expected_asset_digest: `sha256:${'2'.repeat(64)}`,
  })
  assert.deepEqual(Object.keys(projected.identity).sort(), [
    'chat_id_sha256',
    'instance_id_sha256',
    'platform',
    'provider_message_id_sha256',
  ])
  assert.equal(projected.identity.platform, 'dingtalk')
  assert.equal(projected.receipt_id, 'receipt-1')
  assert.equal(projected.dispatch_id, 'dispatch-1')
  assert.equal(projected.delivery_batch_id, 'batch-1')
  assert.equal(JSON.stringify(projected).includes('parent-chat'), false)

  for (const field of ['platform', 'instance_id', 'chat_id', 'provider_message_id']) {
    const drifted = inboundBundle()
    drifted.receipt.identity[field] = `drift-${field}`
    assert.throws(
      () => assertInboundBundle(drifted, { identity, agent_name: 'xiaoming' }),
      /INBOUND_IDENTITY_DRIFT/u,
    )
  }
  for (const forbidden of ['owner_scope', 'command_json', 'bytes']) {
    const leaked = inboundBundle()
    leaked.receipt[forbidden] = 'secret'
    assert.throws(
      () => assertInboundBundle(leaked, { identity, agent_name: 'xiaoming' }),
      /INBOUND_PROJECTION_SECRET/u,
    )
  }
})

test('delivery proof is one direct target x exactly two: Chinese Markdown first and annotated image second', async () => {
  const { assertDeliveryExactSet } = await modulePromise
  const targets = [{ platform: 'dingtalk', instance_id: 'family-a', chat_id: 'parent-a' }]
  const batch = deliveredBatch(targets)
  const proof = assertDeliveryExactSet(batch, deliveryExpectation(targets))
  assert.equal(proof.target_count, 1)
  assert.equal(proof.receipt_count, 2)
  assert.equal(proof.external_message_id_hashes.length, 2)
  assert.equal(new Set(proof.external_message_id_hashes).size, 2)
  assert.equal(JSON.stringify(proof).includes('parent-a'), false)

  const multipleTargets = [
    targets[0],
    { platform: 'dingtalk', instance_id: 'family-b', chat_id: 'parent-b' },
  ]
  assert.throws(
    () =>
      assertDeliveryExactSet(deliveredBatch(multipleTargets), deliveryExpectation(multipleTargets)),
    /DELIVERY_TARGET_EXACT_SET_INVALID/u,
  )

  const duplicateTarget = structuredClone(batch)
  duplicateTarget.receipts.push(structuredClone(duplicateTarget.receipts[0]))
  assert.throws(
    () => assertDeliveryExactSet(duplicateTarget, deliveryExpectation(targets)),
    /DELIVERY_EXACT_SET/u,
  )
  for (const [field, value] of [
    ['part_kind', 'text'],
    ['part_mime', 'text/plain'],
    ['part_ordinal', 2],
    ['status', 'sending'],
    ['external_message_id', ''],
  ]) {
    const drifted = structuredClone(batch)
    drifted.receipts[0][field] = value
    assert.throws(() => assertDeliveryExactSet(drifted, deliveryExpectation(targets)), /DELIVERY_/u)
  }
  const nonChinese = structuredClone(batch)
  nonChinese.receipts[0].payload_json = JSON.stringify({
    kind: 'markdown',
    ordinal: 1,
    text: 'Homework grading',
    message_content: { locale: 'en-US', markdown: 'Homework grading' },
  })
  assert.throws(
    () => assertDeliveryExactSet(nonChinese, deliveryExpectation(targets)),
    /DELIVERY_MARKDOWN_INVALID/u,
  )
})

test('delivery batch uses the frozen photo-reply object kind and opaque digest identity', async () => {
  const { assertDeliveryExactSet } = await modulePromise
  const targets = [{ platform: 'dingtalk', instance_id: 'family-a', chat_id: 'parent-a' }]
  const batch = deliveredBatch(targets)
  assert.notEqual(batch.object_id, 'artifact-1')
  assert.match(batch.object_id, /^photo-reply-[a-f0-9]{64}$/u)
  assert.doesNotThrow(() => assertDeliveryExactSet(batch, deliveryExpectation(targets)))

  const legacyIdentity = structuredClone(batch)
  legacyIdentity.object_id = 'artifact-1'
  assert.throws(
    () => assertDeliveryExactSet(legacyIdentity, deliveryExpectation(targets)),
    /DELIVERY_BATCH_INVALID/u,
  )
})

test('prepared projection accepts extra Agent bindings while freezing one callback direct target', async () => {
  const { assertPreparedPublicProjection } = await modulePromise
  const runtime = {
    agentName: 'xiaoming',
    instanceID: 'family-a',
    expectedTargets: [{ platform: 'dingtalk', instance_id: 'family-a', chat_id: 'parent-a' }],
  }
  const llm = {
    default: 'hexclaw-gpt',
    providers: {
      'hexclaw-gpt': {
        model: 'gpt-5.6-sol',
        models: ['gpt-5.6-sol'],
        credential_present: true,
      },
    },
  }
  const instances = {
    instances: [
      {
        provider: 'dingtalk',
        name: 'family-a',
        enabled: true,
        status: 'running',
        config: { app_key: '****1234', app_secret: '****' },
      },
    ],
  }
  const agents = {
    agents: [
      {
        name: 'xiaoming',
        provider: 'hexclaw-gpt',
        model: 'gpt-5.6-sol',
        metadata: { scenario: 'k12-tutor' },
      },
    ],
    rules: [
      {
        agent_name: 'xiaoming',
        platform: 'dingtalk',
        instance_id: 'family-a',
        chat_id: 'parent-a',
      },
      {
        agent_name: 'xiaoming',
        platform: 'dingtalk',
        instance_id: 'family-b',
        chat_id: 'parent-b',
      },
    ],
  }

  const projection = assertPreparedPublicProjection(runtime, llm, instances, agents)
  assert.equal(projection.target_hashes.length, 1)
})

test('prepare waits for the bound DingTalk instance to reach running after HTTP readiness', async () => {
  const { waitForBoundInstanceProjection } = await modulePromise
  const runtime = { instanceID: '钉钉' }
  let calls = 0
  const projection = await waitForBoundInstanceProjection(
    runtime,
    async () => {
      calls += 1
      return {
        instances: [
          {
            provider: 'dingtalk',
            name: '钉钉',
            enabled: true,
            status: calls === 1 ? 'stopped' : 'running',
            config: { app_key: '****' },
          },
        ],
      }
    },
    Date.now() + 1_000,
    0,
  )

  assert.equal(calls, 2)
  assert.equal(projection.instances[0].status, 'running')
})

test('restart is query-only and duplicate callback cannot change identities, attempts or external sends', async () => {
  const { assertDuplicateCallbackInvariant, assertRestartInvariant } = await modulePromise
  const before = {
    inbound: inboundBundle(),
    batch: deliveredBatch(),
    final_artifact: {
      artifact_id: 'artifact-1',
      artifact_digest: FINAL_ARTIFACT_DIGEST,
    },
    canonical_source: {
      aggregate_digest: '9'.repeat(64),
      attachment_digest: 'a'.repeat(64),
      attachment_size: 1024,
    },
    annotated: { mime: 'image/png', digest: digest(ANNOTATED_BYTES) },
    operation_receipts: modelOperationReceipts(),
  }
  const after = structuredClone(before)
  assert.deepEqual(assertRestartInvariant(before, after), before)
  assert.deepEqual(assertDuplicateCallbackInvariant(before, after), before)

  const changedBatch = structuredClone(after)
  changedBatch.batch.receipts[0].external_message_id = 'new-provider-id'
  assert.throws(() => assertRestartInvariant(before, changedBatch), /RESTART_EXACT_SET/u)
  assert.throws(() => assertDuplicateCallbackInvariant(before, changedBatch), /CALLBACK_REPLAY/u)
  const changedAttempt = structuredClone(after)
  changedAttempt.batch.receipts[0].attempt = 2
  assert.throws(() => assertDuplicateCallbackInvariant(before, changedAttempt), /CALLBACK_REPLAY/u)
  const changedTask = structuredClone(after)
  changedTask.inbound.dispatch.image_task_id = 'image-task-2'
  assert.throws(() => assertRestartInvariant(before, changedTask), /RESTART_EXACT_SET/u)
})

test('evidence is irreversibly redacted and rejects credentials, callback media codes and raw chat IDs', async () => {
  const { assertEvidenceSafe, redactEvidence } = await modulePromise
  const safe = redactEvidence({
    instance_id: 'family-test',
    chat_id: 'parent-chat',
    provider_message_id: 'provider-message-1',
    external_message_id: 'external-1',
    status: 'delivered',
  })
  assert.equal(safe.status, 'delivered')
  for (const field of [
    'instance_id_sha256',
    'chat_id_sha256',
    'provider_message_id_sha256',
    'external_message_id_sha256',
  ])
    assert.match(safe[field], /^[a-f0-9]{64}$/u)
  assert.equal(JSON.stringify(safe).includes('parent-chat'), false)
  assert.deepEqual(assertEvidenceSafe(safe), safe)
  assert.throws(() => assertEvidenceSafe({ app_secret: 'secret' }), /EVIDENCE_SECRET/u)
  assert.throws(() => assertEvidenceSafe({ download_code: 'private-code' }), /EVIDENCE_SECRET/u)
  assert.throws(() => assertEvidenceSafe({ chat_id: 'parent-chat' }), /EVIDENCE_RAW_ID/u)
})

test('harness source uses canonical geometry oracle and never bypasses HexClaw for DingTalk or persistence', async () => {
  const source = await readFile(SCRIPT_PATH, 'utf8')
  assert.match(source, /k12-photo-annotation-coverage\.ts/u)
  assert.match(source, /analyzePhotoAnnotationGeometry/u)
  assert.match(source, /createServer/u)
  assert.match(source, /playwrightRequest/u)
  assert.match(source, /\/api\/v1\/platforms\/hooks\/dingtalk/u)
  assert.match(source, /\/api\/k12\/delivery-batches/u)
  assert.match(source, /\/api\/k12\/image-tasks/u)
  assert.match(source, /HEXCLAW_K12_DINGTALK_PHOTO_TEST_FENCE_STAGE/u)
  assert.match(source, /RESTART_PROCESS_DID_NOT_CHANGE/u)
  assert.doesNotMatch(source, /\/api\/k12\/delivery-batches\/[^'"`]*\/retry/u)
  assert.doesNotMatch(source, /RESTART_DETERMINISTIC_FENCE_UNAVAILABLE/u)
  assert.doesNotMatch(source, /new_provider_send_count:\s*0/u)
  assert.doesNotMatch(source, /\bdws\b|DingTalk CLI/iu)
  assert.doesNotMatch(source, /\bcurl\b|openapi\.dingtalk|api\.dingtalk|oapi\.dingtalk/iu)
  assert.doesNotMatch(source, /sqlite3|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM/iu)
  assert.doesNotMatch(source, /PreparedResourceID/u)
})
