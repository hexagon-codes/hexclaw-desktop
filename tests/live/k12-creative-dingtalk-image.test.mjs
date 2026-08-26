import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const LIVE_ROOT = dirname(fileURLToPath(import.meta.url))
const SCRIPT_PATH = resolve(LIVE_ROOT, 'k12-creative-dingtalk-image.mjs')
const CONTRACT_PATH = resolve(LIVE_ROOT, 'k12-creative-dingtalk-image.contract.json')
const CREATIVE_HANDLER_PATH = resolve(
  LIVE_ROOT,
  '../../../hexclaw/scenarios/k12/apihttp/creativework_handler.go',
)
const modulePromise = import('./k12-creative-dingtalk-image.mjs')

const ART_BYTES = Buffer.from('frozen-art-original-bytes')
const WRITING_BYTES = Buffer.from('frozen-writing-original-bytes')
const TARGETS = Object.freeze([
  { platform: 'dingtalk', instance_id: 'family-a', chat_id: 'parent-a' },
  { platform: 'dingtalk', instance_id: 'family-b', chat_id: 'parent-b' },
])
const APPROVED_FEEDBACK_MARKDOWN = [
  '## 可见证据',
  '',
  '- **构图**：画面中央的女孩举起左手，右下角有一只橙色小猫。',
  '',
  '## 先这样肯定',
  '',
  '可以先这样肯定孩子：“我看到了你把人物、彩虹和小猫安排得很清楚。”',
  '',
  '## 家长可以这样问或讲',
  '',
  '可以问孩子：“画面里你最想保留的是哪一处？为什么？”',
  '',
  '## 下一次只试一个点',
  '',
  '下一次只试着让主体旁边少一个装饰，看看主体会不会更突出。',
  '',
  '说明：仅依据本次提交的可见画面进行观察，不评分、不排名，也不替孩子重画。',
].join('\n')

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function screenshotBytes(fill = 0x31) {
  const bytes = Buffer.alloc(2_048, fill)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes)
  return bytes
}

function creativeWork(kind = 'art') {
  const bytes = kind === 'art' ? ART_BYTES : WRITING_BYTES
  const marker = kind === 'art' ? 'HC-CREATIVE-ART-20260825' : 'HC-CREATIVE-WRITING-20260825'
  const display = kind === 'art' ? '美术作品' : '语文写作'
  const body = kind === 'art' ? '' : '春天到了，校园里的花开了。'
  const feedback = APPROVED_FEEDBACK_MARKDOWN
  return {
    work_id: `work-${kind}`,
    work_type: kind === 'art' ? 'art' : 'writing',
    display_name: display,
    work_title: marker,
    content_markdown: body,
    source_asset_id: `asset://xiaoming/${sha256(bytes)}.png`,
    row_version: 2,
    initial_feedback: {
      generation_id: `generation-${kind}`,
      status: 'succeeded',
      feedback: {
        feedback_id: `feedback-${kind}`,
        projection_markdown: feedback,
        source_snapshot: { source: 'ai', method_ref: 'fixture', capability: 'vision' },
      },
    },
    latest_feedback: {
      generation_id: `generation-${kind}`,
      status: 'succeeded',
      feedback: {
        feedback_id: `feedback-${kind}`,
        projection_markdown: feedback,
        source_snapshot: { source: 'ai', method_ref: 'fixture', capability: 'vision' },
      },
    },
    created_at: 1,
    latest_generation_at: 2,
  }
}

function canonicalMarkdown(work) {
  return [
    work.display_name,
    work.work_title,
    work.content_markdown,
    work.latest_feedback.feedback.projection_markdown,
  ]
    .filter(Boolean)
    .join('\n\n')
}

function deliveryPart(kind, markdown, bytes) {
  const imageDigest = `sha256:${sha256(bytes)}`
  const markdownDigest = `sha256:${sha256(markdown)}`
  const common = {
    message_content: {
      content_id: `content:${'c'.repeat(64)}`,
      content_version: '1.0',
      producer_kind: 'k12',
      markdown,
      source_digest: `sha256:${'d'.repeat(64)}`,
      locale: 'zh-CN',
      attachments: [{ name: '作品原图.png', mime: 'image/png', digest: imageDigest }],
    },
    render_manifest: {
      render_id: `render:${'e'.repeat(64)}`,
      content_id: `content:${'c'.repeat(64)}`,
      surface: 'channel',
      source_digest: `sha256:${'d'.repeat(64)}`,
      parts: [
        { kind: 'markdown', text: markdown },
        {
          kind: 'artifact',
          artifact_ref: `inline:${sha256(bytes)}`,
          artifact_digest: imageDigest,
          alt_text: '作品原图.png',
        },
      ],
    },
  }
  if (kind === 'markdown') {
    return {
      kind,
      ordinal: 1,
      digest: markdownDigest,
      text: markdown,
      ...common,
    }
  }
  return {
    kind: 'artifact',
    mime: 'image/png',
    ordinal: 2,
    digest: imageDigest,
    attachment: { Name: '作品原图.png', MIME: 'image/png', Data: bytes.toString('base64') },
    ...common,
  }
}

function deliveredBatch(work, bytes, targets = TARGETS) {
  const markdown = canonicalMarkdown(work)
  const receipts = []
  let ordinal = 1
  for (const target of targets) {
    const physicalExternalMessageID = `external-${work.work_id}-${target.instance_id}`
    for (const kind of ['markdown', 'artifact']) {
      const part = deliveryPart(kind, markdown, bytes)
      const payloadJSON = JSON.stringify(part)
      receipts.push({
        delivery_id: `delivery-${work.work_id}-${ordinal}`,
        batch_id: `batch-${work.work_id}`,
        batch_ordinal: ordinal++,
        part_kind: kind,
        part_mime: kind === 'artifact' ? 'image/png' : '',
        part_ordinal: kind === 'artifact' ? 2 : 1,
        part_digest: part.digest,
        agent_name: 'xiaoming',
        object_kind: 'creative_work',
        object_id: work.work_id,
        binding_id: `binding-${target.instance_id}`,
        target,
        status: 'delivered',
        dedupe_key: `dedupe-${target.instance_id}-${kind}`,
        payload_digest: `sha256:${sha256(payloadJSON)}`,
        payload_json: payloadJSON,
        render_manifest_json: JSON.stringify(part.render_manifest),
        external_message_id: physicalExternalMessageID,
        attempt: 1,
        created_at: 1,
        updated_at: 2,
      })
    }
  }
  return {
    batch_id: `batch-${work.work_id}`,
    agent_name: 'xiaoming',
    object_kind: 'creative_work',
    object_id: work.work_id,
    dedupe_key: `batch-dedupe-${work.work_id}`,
    content_digest: `sha256:${'f'.repeat(64)}`,
    status: 'delivered',
    receipts,
    created_at: 1,
    updated_at: 2,
  }
}

function expectedArtifact(kind = 'art') {
  const bytes = kind === 'art' ? ART_BYTES : WRITING_BYTES
  const work = creativeWork(kind)
  return {
    agent_name: 'xiaoming',
    work_id: work.work_id,
    work_type: work.work_type,
    marker: work.work_title,
    source_mime: 'image/png',
    source_digest: sha256(bytes),
    source_bytes: bytes,
    canonical_markdown: canonicalMarkdown(work),
    expected_targets: TARGETS,
  }
}

function imageTaskResult(kind = 'art') {
  const sourceDigest = kind === 'art' ? sha256(ART_BYTES) : sha256(WRITING_BYTES)
  const receipts = []
  if (kind === 'writing') {
    receipts.push({
      invocation_id: 'writing-ocr-invocation',
      operation: 'writing_ocr',
      canonical_input_digest: sourceDigest,
      provider: 'hexclaw-gpt',
      model: 'gpt-5.6-sol',
      status: 'succeeded',
      attempt: 1,
      result_digest: `sha256:${sha256('writing-ocr-result')}`,
    })
  }
  receipts.push({
    invocation_id: `work-feedback-${kind}-invocation`,
    operation: 'work_feedback',
    canonical_input_digest: sourceDigest,
    provider: 'hexclaw-gpt',
    model: 'gpt-5.6-sol',
    status: 'succeeded',
    attempt: 1,
    result_digest: `sha256:${sha256(`work-feedback-${kind}-result`)}`,
  })
  return { operation_receipts: receipts }
}

test('phases are checkpointable and every phase stays below 30 minutes', async () => {
  const { PHASES, phaseBudgetMilliseconds, resolvePhase } = await modulePromise
  assert.deepEqual(PHASES, [
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
  for (const phase of PHASES) assert.equal(resolvePhase([phase]), phase)
  assert.equal(resolvePhase([]), 'validate')
  assert.throws(() => resolvePhase(['run']), /INVALID_PHASE/u)
  assert.throws(() => resolvePhase(['validate', 'prepare']), /INVALID_PHASE/u)
  assert.ok(phaseBudgetMilliseconds({}) > 0)
  assert.ok(phaseBudgetMilliseconds({}) < 30 * 60_000)
  assert.equal(
    phaseBudgetMilliseconds({ HEXCLAW_CREATIVE_DINGTALK_IMAGE_PHASE_TIMEOUT_MS: '1800000' }),
    29 * 60_000,
  )
})

test('contract freezes public APIs, real route, two image fixtures and zero-send validate', async () => {
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
    bound_instance_only: true,
    dws_cli: false,
    direct_dingtalk_http: false,
    direct_store_read: false,
    sqlite_seed_or_write: false,
  })
  assert.deepEqual(projection.fixtureKeys, ['art', 'writing'])
  assert.equal(
    projection.fixtures.art.sha256,
    '7eb16fdbe398236cdf2ce31ea6d2fac5e4787ea3004b96ab74a3eebd540f1d93',
  )
  assert.equal(projection.fixtures.art.size_bytes, 2713090)
  assert.equal(projection.fixtures.art.width, 1254)
  assert.equal(projection.fixtures.art.height, 1254)
  assert.equal(
    projection.fixtures.writing.sha256,
    '3b238c46e0ae4515f7b35a28bcfd37081ba1d59a9dfa2b30bf17784aaf3e9157',
  )
  assert.equal(projection.fixtures.writing.size_bytes, 2509035)
  assert.equal(projection.fixtures.writing.width, 1086)
  assert.equal(projection.fixtures.writing.height, 1448)
  assert.equal(projection.delivery.parts_per_target, 2)
  assert.equal(
    projection.public_api.delivery_retry,
    '/api/k12/delivery-batches/{batch_id}/retry',
  )
  assert.equal(projection.delivery.physical_messages_per_target, 1)
  assert.equal(projection.delivery.initial_product_send_posts_per_work, 1)
  assert.equal(projection.delivery.component_rows_share_external_message_id, true)
  assert.equal(projection.delivery.physical_external_message_ids_distinct_across_targets, true)
  assert.equal(projection.delivery.target_count, 'all_deduplicated_bound_targets')
  assert.deepEqual(projection.delivery.markdown_policy, {
    h2_exact_order: [
      '可见证据',
      '先这样肯定',
      '家长可以这样问或讲',
      '下一次只试一个点',
    ],
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
  assert.equal(projection.client_checkpoint.marker_and_image_same_card, true)
  assert.equal(projection.client_checkpoint.source, 'dingtalk-real-client-observer')
  assert.deepEqual(projection.client_checkpoint.allowed_clients, ['ios', 'android', 'desktop'])
  assert.equal(projection.client_checkpoint.observed_at_required, true)
  assert.equal(projection.client_checkpoint.screenshot_bytes_required, true)
  assert.equal(projection.client_checkpoint.screenshot_within_checkpoint_directory, true)
  assert.equal(projection.client_checkpoint.observed_physical_messages_per_target, 1)
  assert.equal(projection.client_checkpoint.duplicate_physical_messages_per_target, 0)
  assert.equal(projection.frozen_replay.restart_action, 'query_only')
  assert.equal(projection.frozen_replay.duplicate_product_send_posts_per_work, 1)
  assert.equal(projection.frozen_replay.new_delivery_receipts_per_work, 0)
  assert.equal(projection.frozen_replay.new_external_message_ids_per_work, 0)
  assert.equal(projection.frozen_replay.new_physical_messages_per_work, 0)
  assert.equal(projection.frozen_replay.new_provider_send_count, 0)
  assert.deepEqual(projection.validate_side_effects, {
    sidecar_starts: 0,
    asset_uploads: 0,
    image_task_posts: 0,
    model_calls: 0,
    im_sends: 0,
    provider_queries: 0,
  })

  const initialCardinalityDrift = structuredClone(contract)
  initialCardinalityDrift.delivery.initial_product_send_posts_per_work = 2
  assert.throws(() => validateContract(initialCardinalityDrift), /CONTRACT_DELIVERY_INVALID/u)

  for (const [field, invalid] of [
    ['duplicate_product_send_posts_per_work', 2],
    ['new_delivery_receipts_per_work', 1],
    ['new_external_message_ids_per_work', 1],
    ['new_physical_messages_per_work', 1],
  ]) {
    const replayDrift = structuredClone(contract)
    replayDrift.frozen_replay[field] = invalid
    assert.throws(() => validateContract(replayDrift), /CONTRACT_REPLAY_INVALID/u)
  }
})

test('creative Markdown enforces the approved four-section Chinese parent-facing contract', async () => {
  const { assertCreativeMarkdownContent } = await modulePromise
  assert.equal(typeof assertCreativeMarkdownContent, 'function')

  const proof = assertCreativeMarkdownContent(APPROVED_FEEDBACK_MARKDOWN)
  assert.deepEqual(proof.h2_order, [
    '可见证据',
    '先这样肯定',
    '家长可以这样问或讲',
    '下一次只试一个点',
  ])
  assert.equal(proof.parent_question_present, true)
  assert.equal(proof.next_step_present, true)
  assert.equal(proof.light_limitation_present, true)

  assert.doesNotThrow(() =>
    assertCreativeMarkdownContent(
      APPROVED_FEEDBACK_MARKDOWN.replace(
        '下一次只试着让主体旁边少一个装饰，看看主体会不会更突出。',
        '下一次只用 5 分钟画三个小框图，比一比主体放在不同位置时的效果。',
      ),
    ),
  )

  const invalid = [
    APPROVED_FEEDBACK_MARKDOWN.replace('## 先这样肯定', '## 额外结论'),
    APPROVED_FEEDBACK_MARKDOWN.replace(
      '- **构图**：画面中央的女孩举起左手，右下角有一只橙色小猫。',
      '- **composition**: the subject is centered.',
    ),
    APPROVED_FEEDBACK_MARKDOWN.replace(
      '下一次只试着让主体旁边少一个装饰，看看主体会不会更突出。',
      '这幅作品可以得 95 分。',
    ),
    APPROVED_FEEDBACK_MARKDOWN.replace(
      '下一次只试着让主体旁边少一个装饰，看看主体会不会更突出。',
      '这幅作品在班里排名第 1。',
    ),
    APPROVED_FEEDBACK_MARKDOWN.replace(
      '下一次只试着让主体旁边少一个装饰，看看主体会不会更突出。',
      '范文如下：春天来了。',
    ),
    APPROVED_FEEDBACK_MARKDOWN.replace(
      '可以问孩子：“画面里你最想保留的是哪一处？为什么？”',
      '想想？',
    ),
    APPROVED_FEEDBACK_MARKDOWN.replace(
      '下一次只试着让主体旁边少一个装饰，看看主体会不会更突出。',
      '改改。',
    ),
    APPROVED_FEEDBACK_MARKDOWN.replace('说明：', '## 说明\n\n'),
    `${APPROVED_FEEDBACK_MARKDOWN}\n\n说明之后又追加了一段。`,
  ]
  for (const markdown of invalid) {
    assert.throws(() => assertCreativeMarkdownContent(markdown), /CREATIVE_MARKDOWN_/u)
  }
})

test('visible DingTalk content rejects every protected reference class from the production contract', async () => {
  const { assertDingTalkVisibleContentSafe } = await modulePromise
  assert.equal(typeof assertDingTalkVisibleContentSafe, 'function')
  assert.doesNotThrow(() => assertDingTalkVisibleContentSafe(APPROVED_FEEDBACK_MARKDOWN))

  for (const leaked of [
    '原图：asset://xiaoming/internal.png',
    '原图：file:///private/tmp/work.png',
    '原图：blob:https://desktop.invalid/id',
    '原图：data:image/png;base64,AAAA',
    '原图：http://127.0.0.1:16060/api/k12/assets/internal.png',
    '原图：/private/tmp/work.png',
    String.raw`原图：C:\\Users\\owner\\work.png`,
    String.raw`原图：\\server\\share\\work.png`,
    `原图：inline:${'a'.repeat(64)}`,
    `原图：${'b'.repeat(64)}.png`,
  ]) {
    assert.throws(() => assertDingTalkVisibleContentSafe(leaked), /DINGTALK_VISIBLE_CONTENT_/u)
  }
})

test('offline validate hashes fixtures and cannot start sidecar, model or IM traffic', async () => {
  const { validateStatic } = await modulePromise
  const projection = await validateStatic({
    HEXCLAW_DOCS_ROOT: resolve(LIVE_ROOT, '../../../hexclaw-docs'),
  })
  assert.equal(projection.status, 'validated')
  assert.equal(projection.phase, 'validate')
  assert.equal(projection.sidecar_started, false)
  assert.equal(projection.asset_uploads, 0)
  assert.equal(projection.image_task_posts, 0)
  assert.equal(projection.model_calls, 0)
  assert.equal(projection.im_sends, 0)
  assert.equal(projection.provider_queries, 0)
  assert.deepEqual(Object.keys(projection.fixtures), ['art', 'writing'])
})

test('public creative artifact reconciles source identity, exact bytes and canonical Markdown', async () => {
  const { assertPublicCreativeArtifact } = await modulePromise
  for (const kind of ['art', 'writing']) {
    const bytes = kind === 'art' ? ART_BYTES : WRITING_BYTES
    const proof = assertPublicCreativeArtifact(creativeWork(kind), bytes, expectedArtifact(kind))
    assert.equal(proof.source_digest, sha256(bytes))
    assert.equal(proof.markdown_digest, sha256(canonicalMarkdown(creativeWork(kind))))
    assert.ok(proof.canonical_markdown.includes(expectedArtifact(kind).marker))
  }
})

test('canonical creative Markdown emits an equal display name and work title only once', async () => {
  const { canonicalCreativeMarkdown } = await modulePromise
  assert.equal(typeof canonicalCreativeMarkdown, 'function')
  const work = creativeWork('art')
  work.display_name = work.work_title
  const markdown = canonicalCreativeMarkdown(work)
  assert.equal(markdown.match(new RegExp(work.work_title, 'gu'))?.length, 1)
  assert.equal(
    markdown,
    [work.display_name, work.content_markdown, work.latest_feedback.feedback.projection_markdown]
      .filter(Boolean)
      .join('\n\n'),
  )
})

test('public creative artifact fails closed on missing source, owner drift or digest drift', async () => {
  const { assertPublicCreativeArtifact } = await modulePromise
  const base = creativeWork('art')
  for (const drifted of [
    { ...base, source_asset_id: '' },
    { ...base, source_asset_id: base.source_asset_id.replace('xiaoming', 'other') },
    { ...base, source_asset_id: `asset://xiaoming/${'0'.repeat(64)}.png` },
    { ...base, latest_feedback: { status: 'running' } },
  ]) {
    assert.throws(
      () => assertPublicCreativeArtifact(drifted, ART_BYTES, expectedArtifact('art')),
      /CREATIVE_ARTIFACT_/u,
    )
  }
  assert.throws(
    () => assertPublicCreativeArtifact(base, Buffer.from('changed'), expectedArtifact('art')),
    /CREATIVE_ARTIFACT_/u,
  )
})

test('delivery exact-set keeps N times two component rows in N physical messages', async () => {
  const { assertDeliveryExactSet } = await modulePromise
  const work = creativeWork('art')
  const proof = assertDeliveryExactSet(deliveredBatch(work, ART_BYTES), expectedArtifact('art'))
  assert.equal(proof.target_count, TARGETS.length)
  assert.equal(proof.receipt_count, TARGETS.length * 2)
  assert.equal(proof.component_row_count, TARGETS.length * 2)
  assert.equal(proof.physical_message_count, TARGETS.length)
  assert.equal(proof.physical_external_message_id_hashes.length, TARGETS.length)
  assert.equal(new Set(proof.physical_external_message_id_hashes).size, TARGETS.length)
  assert.equal(proof.markdown_digest, sha256(canonicalMarkdown(work)))
  assert.equal(proof.image_digest, sha256(ART_BYTES))
})

test('delivery exact-set rejects missing part, target drift, split group, shared cross-target ID or original byte drift', async () => {
  const { assertDeliveryExactSet } = await modulePromise
  const work = creativeWork('art')
  const expected = expectedArtifact('art')
  const missing = deliveredBatch(work, ART_BYTES)
  missing.receipts.pop()
  assert.throws(() => assertDeliveryExactSet(missing, expected), /DELIVERY_/u)

  const duplicateTarget = deliveredBatch(work, ART_BYTES)
  duplicateTarget.receipts[2].target = { ...duplicateTarget.receipts[0].target }
  assert.throws(() => assertDeliveryExactSet(duplicateTarget, expected), /DELIVERY_/u)

  const splitExternal = deliveredBatch(work, ART_BYTES)
  splitExternal.receipts[1].external_message_id = 'external-split-component'
  assert.throws(() => assertDeliveryExactSet(splitExternal, expected), /DELIVERY_/u)

  const splitAttempt = deliveredBatch(work, ART_BYTES)
  splitAttempt.receipts[1].attempt = 2
  assert.throws(() => assertDeliveryExactSet(splitAttempt, expected), /DELIVERY_/u)

  const sharedAcrossTargets = deliveredBatch(work, ART_BYTES)
  sharedAcrossTargets.receipts[2].external_message_id =
    sharedAcrossTargets.receipts[0].external_message_id
  sharedAcrossTargets.receipts[3].external_message_id =
    sharedAcrossTargets.receipts[0].external_message_id
  assert.throws(() => assertDeliveryExactSet(sharedAcrossTargets, expected), /DELIVERY_/u)

  const changedBytes = deliveredBatch(work, Buffer.from('wrong-original'))
  assert.throws(() => assertDeliveryExactSet(changedBytes, expected), /DELIVERY_/u)
})

test('restart and duplicate send preserve the same public work, source and frozen delivery batch', async () => {
  const { assertFrozenReplayInvariant } = await modulePromise
  const work = creativeWork('writing')
  const before = {
    work,
    source_digest: sha256(WRITING_BYTES),
    batch: deliveredBatch(work, WRITING_BYTES),
  }
  assert.doesNotThrow(() => assertFrozenReplayInvariant(before, structuredClone(before)))

  const resent = structuredClone(before)
  resent.batch.receipts[0].attempt = 2
  assert.throws(() => assertFrozenReplayInvariant(before, resent), /FROZEN_REPLAY_DRIFT/u)

  const rereadChanged = structuredClone(before)
  rereadChanged.source_digest = sha256('mutated-resource')
  assert.throws(() => assertFrozenReplayInvariant(before, rereadChanged), /FROZEN_REPLAY_DRIFT/u)

  const newReceipt = structuredClone(before)
  newReceipt.batch.receipts.push(structuredClone(newReceipt.batch.receipts[0]))
  assert.throws(() => assertFrozenReplayInvariant(before, newReceipt), /FROZEN_REPLAY_DRIFT/u)

  const newPhysicalMessage = structuredClone(before)
  newPhysicalMessage.batch.receipts[0].external_message_id = 'unexpected-physical-message'
  newPhysicalMessage.batch.receipts[1].external_message_id = 'unexpected-physical-message'
  assert.throws(
    () => assertFrozenReplayInvariant(before, newPhysicalMessage),
    /FROZEN_REPLAY_DRIFT/u,
  )
})

test('real DingTalk client checkpoint binds every one-card observation to private screenshot bytes', async (t) => {
  const { assertClientCheckpoint, checkpointExpectationFromDelivery } = await modulePromise
  const work = creativeWork('art')
  const batch = deliveredBatch(work, ART_BYTES)
  const evidenceRoot = await mkdtemp(join(tmpdir(), 'hexclaw-creative-client-evidence-'))
  await chmod(evidenceRoot, 0o700)
  t.after(() => rm(evidenceRoot, { recursive: true, force: true }))
  const screenshotPaths = []
  for (let index = 0; index < TARGETS.length; index += 1) {
    const pathname = join(evidenceRoot, `creative-${index + 1}.png`)
    await writeFile(pathname, screenshotBytes(0x31 + index), { mode: 0o600 })
    await chmod(pathname, 0o600)
    screenshotPaths.push(pathname)
  }
  const expected = {
    ...checkpointExpectationFromDelivery(batch, expectedArtifact('art')),
    evidence_root: evidenceRoot,
  }
  const checkpoint = {
    schema_version: 1,
    scenario: 'k12_real_dingtalk_creative_images',
    source: 'dingtalk-real-client-observer',
    client: 'ios',
    observed_at: '2026-08-27T12:00:00.000Z',
    work_marker: expected.marker,
    markdown_digest: `sha256:${expected.markdown_digest}`,
    image_digest: `sha256:${expected.image_digest}`,
    observations: expected.targets.map((target, index) => ({
      ...target,
      marker_visible: true,
      markdown_rendered: true,
      image_visible: true,
      marker_and_image_same_card: true,
      observed_physical_message_count: 1,
      duplicate_physical_message_count: 0,
      observed_markdown_digest: `sha256:${expected.markdown_digest}`,
      observed_image_digest: `sha256:${expected.image_digest}`,
      screenshot_path: screenshotPaths[index],
      screenshot_sha256: sha256(screenshotBytes(0x31 + index)),
    })),
  }
  const proof = await assertClientCheckpoint(checkpoint, expected)
  assert.equal(proof.observation_count, TARGETS.length)
  assert.equal(proof.source, 'dingtalk-real-client-observer')
  assert.equal(proof.client, 'ios')
  assert.equal(proof.observed_at, checkpoint.observed_at)
  assert.equal(proof.screenshot_sha256s.length, TARGETS.length)
  for (const target of expected.targets) {
    assert.match(target.physical_external_message_id_sha256, /^[a-f0-9]{64}$/u)
    assert.equal('markdown_external_message_id_sha256' in target, false)
    assert.equal('image_external_message_id_sha256' in target, false)
  }

  const missing = structuredClone(checkpoint)
  missing.observations.pop()
  await assert.rejects(Promise.resolve().then(() => assertClientCheckpoint(missing, expected)), /CLIENT_CHECKPOINT_/u)
  const detached = structuredClone(checkpoint)
  detached.observations[0].marker_and_image_same_card = false
  await assert.rejects(Promise.resolve().then(() => assertClientCheckpoint(detached, expected)), /CLIENT_CHECKPOINT_/u)
  const wrongPhysicalMessage = structuredClone(checkpoint)
  wrongPhysicalMessage.observations[0].physical_external_message_id_sha256 = '0'.repeat(64)
  await assert.rejects(Promise.resolve().then(() => assertClientCheckpoint(wrongPhysicalMessage, expected)), /CLIENT_CHECKPOINT_/u)
  const wrongDigest = structuredClone(checkpoint)
  wrongDigest.observations[0].observed_image_digest = `sha256:${'0'.repeat(64)}`
  await assert.rejects(Promise.resolve().then(() => assertClientCheckpoint(wrongDigest, expected)), /CLIENT_CHECKPOINT_/u)

  for (const mutate of [
    (value) => {
      value.source = 'manual-json'
    },
    (value) => {
      value.client = 'api'
    },
    (value) => {
      value.observed_at = 'not-a-time'
    },
    (value) => {
      value.observations[0].observed_physical_message_count = 2
    },
    (value) => {
      value.observations[0].duplicate_physical_message_count = 1
    },
    (value) => {
      value.observations[0].screenshot_sha256 = '0'.repeat(64)
    },
  ]) {
    const drifted = structuredClone(checkpoint)
    mutate(drifted)
    await assert.rejects(
      Promise.resolve().then(() => assertClientCheckpoint(drifted, expected)),
      /CLIENT_(?:CHECKPOINT|SCREENSHOT)_/u,
    )
  }

  const outside = structuredClone(checkpoint)
  const outsidePath = join(tmpdir(), `hexclaw-creative-outside-${Date.now()}.png`)
  await writeFile(outsidePath, screenshotBytes(0x41), { mode: 0o600 })
  t.after(() => rm(outsidePath, { force: true }))
  outside.observations[0].screenshot_path = outsidePath
  outside.observations[0].screenshot_sha256 = sha256(screenshotBytes(0x41))
  await assert.rejects(
    Promise.resolve().then(() => assertClientCheckpoint(outside, expected)),
    /CLIENT_SCREENSHOT_OUTSIDE_ROOT/u,
  )
})

test('source contract checks replay before mutable asset read and forbids non-product DingTalk access', async () => {
  const { assertCreativeReplayBeforeAssetRead } = await modulePromise
  const [handlerSource, runnerSource] = await Promise.all([
    readFile(CREATIVE_HANDLER_PATH, 'utf8'),
    readFile(SCRIPT_PATH, 'utf8'),
  ])
  assert.doesNotThrow(() => assertCreativeReplayBeforeAssetRead(handlerSource))
  assert.match(
    runnerSource,
    /\/api\/k12\/creative-works\/\$\{encodeURIComponent\(workID\)\}\/send/u,
  )
  assert.match(runnerSource, /\/api\/k12\/delivery-batches\//u)
  assert.doesNotMatch(runnerSource, /(?:dev\.dingtalk\.com|oapi\.dingtalk\.com)/iu)
  assert.doesNotMatch(runnerSource, /\b(?:curl|sqlite3)\b/u)
  assert.doesNotMatch(runnerSource, /from ['"](?:child_process|node:child_process)['"].*\bdws\b/iu)
  const validateStart = runnerSource.indexOf('export async function validateStatic')
  const validateEnd = runnerSource.indexOf('\nfunction physicalTarget', validateStart)
  assert.ok(validateStart >= 0 && validateEnd > validateStart)
  assert.doesNotMatch(
    runnerSource.slice(validateStart, validateEnd),
    /(?:withSidecar|startSidecar|apiRequest|liveRuntime|DINGTALK_LIVE_SEND)/u,
  )
})

test('existing creative delivery batches resume without creating a second send', async () => {
  const { creativeDeliveryResumeAction } = await modulePromise
  const work = (deliveryBatchID = '') => ({ delivery_batch_id: deliveryBatchID })
  const batch = (status, batchID = 'batch-1') => ({ batch_id: batchID, status })

  assert.equal(creativeDeliveryResumeAction(work(), null), 'send')
  assert.equal(creativeDeliveryResumeAction(work('batch-1'), batch('delivered')), 'delivered')
  for (const status of ['pending', 'sending', 'outcome_unknown']) {
    assert.equal(creativeDeliveryResumeAction(work('batch-1'), batch(status)), 'query')
  }
  for (const status of ['failed', 'partial_failed']) {
    assert.equal(creativeDeliveryResumeAction(work('batch-1'), batch(status)), 'retry')
  }

  assert.throws(
    () => creativeDeliveryResumeAction(work('batch-1'), batch('failed', 'batch-2')),
    /DELIVERY_BATCH_ID_DRIFT/u,
  )
  assert.throws(
    () => creativeDeliveryResumeAction(work('batch-1'), batch('unknown')),
    /DELIVERY_BATCH_STATUS_INVALID/u,
  )
})

test('failed delivery batch resumes with GET then retry and never creative-sends', async () => {
  const { resumeCreativeDelivery } = await modulePromise
  assert.equal(typeof resumeCreativeDelivery, 'function')

  const calls = []
  const response = (value) => ({
    status: () => 200,
    headers: () => ({ 'content-type': 'application/json' }),
    body: async () => Buffer.from(JSON.stringify(value)),
  })
  const api = {
    fetch: async (pathname, options) => {
      calls.push({ pathname, method: options.method })
      if (options.method === 'GET') {
        return response({ batch_id: 'batch-art', status: 'failed' })
      }
      if (options.method === 'POST' && pathname.endsWith('/retry')) {
        return response({ batch_id: 'batch-art', status: 'delivered' })
      }
      throw new Error(`unexpected request: ${options.method} ${pathname}`)
    },
  }

  const resumed = await resumeCreativeDelivery(
    api,
    { agent_name: 'xiaoming' },
    { delivery_batch_id: 'batch-art' },
    'work-art',
  )

  assert.deepEqual(resumed, { batch_id: 'batch-art', status: 'delivered' })
  assert.deepEqual(calls, [
    {
      pathname: '/api/k12/delivery-batches/batch-art?agent=xiaoming',
      method: 'GET',
    },
    {
      pathname: '/api/k12/delivery-batches/batch-art/retry',
      method: 'POST',
    },
  ])
  assert.equal(calls.some(({ pathname }) => pathname.endsWith('/creative-works/work-art/send')), false)
})

test('source performs one guarded initial and one idempotent replay product POST per work', async () => {
  const runnerSource = await readFile(SCRIPT_PATH, 'utf8')
  const phaseBody = (startMarker, endMarker) => {
    const start = runnerSource.indexOf(startMarker)
    const end = runnerSource.indexOf(endMarker, start)
    assert.ok(start >= 0 && end > start)
    return runnerSource.slice(start, end)
  }
  const resume = phaseBody(
    'async function resumeCreativeDelivery',
    '\nasync function sendCreativeCasePhase',
  )
  const initial = phaseBody(
    'async function sendCreativeCasePhase',
    '\nasync function getDeliveryBatch',
  )
  const restart = phaseBody('async function restartPhase', '\nasync function replayPhase')
  const replay = phaseBody('async function replayPhase', '\nasync function loadClientCheckpoint')
  const dispatch = phaseBody('async function executePhase', '\nexport async function runPhase')
  const productPostPattern = /apiRequest\(api, 'POST', creativeSendPath\(/gu

  assert.equal(resume.match(productPostPattern)?.length, 1)
  assert.match(resume, /\/api\/k12\/delivery-batches\/\$\{encodeURIComponent\(batchID\)\}\/retry/u)
  assert.doesNotMatch(initial, productPostPattern)
  assert.match(initial, /resumeCreativeDelivery\(api, state, work, caseState\.work_id\)/u)
  assert.doesNotMatch(restart, productPostPattern)
  assert.equal(replay.match(productPostPattern)?.length, 1)
  assert.match(replay, /for \(const key of \['art', 'writing'\]\)/u)
  assert.equal(dispatch.match(/sendCreativeCasePhase\(/gu)?.length, 2)
  assert.match(dispatch, /case 'send-art':[\s\S]*?sendCreativeCasePhase\(env, deadline, 'art'\)/u)
  assert.match(
    dispatch,
    /case 'send-writing':[\s\S]*?sendCreativeCasePhase\(env, deadline, 'writing'\)/u,
  )
})

test('evidence redacts raw target and provider identities', async () => {
  const { assertEvidenceSafe, redactEvidence } = await modulePromise
  const safe = redactEvidence({
    instance_id: 'family-a',
    chat_id: 'parent-a',
    external_message_id: 'provider-1',
    payload_json: '{secret}',
    nested: { marker: 'HC-CREATIVE' },
  })
  assertEvidenceSafe(safe)
  assert.equal(safe.instance_id, undefined)
  assert.equal(safe.payload_json, undefined)
  assert.match(safe.instance_id_sha256, /^[a-f0-9]{64}$/u)
  assert.throws(() => assertEvidenceSafe({ chat_id: 'raw' }), /EVIDENCE_RAW_ID/u)
})

test('prepare waits for every bound DingTalk instance to reach running', async () => {
  const { waitForBoundInstancesProjection } = await modulePromise
  const runtime = {
    expectedTargets: [{ platform: 'dingtalk', instance_id: 'pi-1', chat_id: 'parent' }],
  }
  let calls = 0
  const projection = await waitForBoundInstancesProjection(
    runtime,
    async () => {
      calls += 1
      return {
        instances: [
          {
            id: 'pi-1',
            provider: 'dingtalk',
            name: '钉钉',
            enabled: true,
            status: calls === 1 ? 'error' : 'running',
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

test('bound instance projection treats DingTalk app_key as an identifier, not a secret', async () => {
  const { maskedInstanceConfig } = await modulePromise
  assert.equal(maskedInstanceConfig({ app_key: 'ding-public-app-id', app_secret: '****' }), true)
  assert.equal(maskedInstanceConfig({ app_secret: 'raw-secret' }), false)
})

test('prepare ignores unrelated global defaults and gates the explicit Agent Sol route', async () => {
  const { assertPreparedPublicProjection } = await modulePromise
  assert.equal(typeof assertPreparedPublicProjection, 'function')
  const runtime = {
    agentName: 'xiaoming',
    expectedTargets: [{ platform: 'dingtalk', instance_id: 'pi-1', chat_id: 'parent' }],
  }
  const llm = {
    default: 'other-provider',
    providers: {
      'hexclaw-gpt': {
        model: 'gpt-5.6-terra',
        models: ['gpt-5.6-terra', 'gpt-5.6-sol'],
        credential_present: true,
      },
    },
  }
  const instances = {
    instances: [
      {
        id: 'pi-1',
        provider: 'dingtalk',
        enabled: true,
        status: 'running',
        config: { app_key: 'ding-public-app-id', app_secret: '****' },
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
        instance_id: 'pi-1',
        chat_id: 'parent',
      },
    ],
  }

  const proof = assertPreparedPublicProjection(runtime, llm, instances, agents)
  assert.equal(proof.provider, 'hexclaw-gpt')
  assert.equal(proof.model, 'gpt-5.6-sol')
  assert.equal(proof.target_count, 1)

  const wrongAgent = structuredClone(agents)
  wrongAgent.agents[0].model = 'gpt-5.6-terra'
  assert.throws(
    () => assertPreparedPublicProjection(runtime, llm, instances, wrongAgent),
    /AGENT_ROUTE_PROJECTION_INVALID/u,
  )
})

test('image task optimistic version accepts the initial durable version zero', async () => {
  const { imageTaskVersion } = await modulePromise
  assert.equal(imageTaskVersion(0), 0)
  assert.equal(imageTaskVersion(3), 3)
  assert.throws(() => imageTaskVersion(-1), /IMAGE_TASK_VERSION_INVALID/u)
})

test('public result proves one exact succeeded work-feedback model invocation', async () => {
  const { assertExactWorkFeedbackReceipt } = await modulePromise
  assert.equal(typeof assertExactWorkFeedbackReceipt, 'function')

  const proof = assertExactWorkFeedbackReceipt(imageTaskResult('art'))
  assert.deepEqual(
    {
      provider: proof.provider,
      model: proof.model,
      status: proof.status,
      attempt: proof.attempt,
    },
    {
      provider: 'hexclaw-gpt',
      model: 'gpt-5.6-sol',
      status: 'succeeded',
      attempt: 1,
    },
  )
  assert.match(proof.invocation_id_sha256, /^[a-f0-9]{64}$/u)
  assert.match(proof.result_digest, /^sha256:[a-f0-9]{64}$/u)
  assert.match(proof.receipt_sha256, /^[a-f0-9]{64}$/u)

  for (const mutate of [
    (receipt) => {
      receipt.provider = 'other-provider'
    },
    (receipt) => {
      receipt.model = 'other-model'
    },
    (receipt) => {
      receipt.status = 'failed'
    },
    (receipt) => {
      receipt.attempt = 2
    },
    (receipt) => {
      receipt.invocation_id = ''
    },
    (receipt) => {
      receipt.result_digest = ''
    },
  ]) {
    const drifted = imageTaskResult('art')
    mutate(drifted.operation_receipts[0])
    assert.throws(() => assertExactWorkFeedbackReceipt(drifted), /WORK_FEEDBACK_RECEIPT_INVALID/u)
  }
  const duplicated = imageTaskResult('art')
  duplicated.operation_receipts.push(structuredClone(duplicated.operation_receipts[0]))
  assert.throws(
    () => assertExactWorkFeedbackReceipt(duplicated),
    /WORK_FEEDBACK_RECEIPT_EXACT_SET_INVALID/u,
  )
})

test('send boundary keeps the public operation-receipt exact-set unchanged with zero new model calls', async () => {
  const { assertModelOperationReceiptsUnchanged } = await modulePromise
  assert.equal(typeof assertModelOperationReceiptsUnchanged, 'function')

  const before = imageTaskResult('writing')
  const proof = assertModelOperationReceiptsUnchanged(before, structuredClone(before))
  assert.equal(proof.receipt_count, 2)
  assert.equal(proof.new_model_calls, 0)
  assert.equal(proof.before_sha256, proof.after_sha256)

  const added = structuredClone(before)
  added.operation_receipts.push({
    invocation_id: 'unexpected-model-call',
    operation: 'work_feedback',
    canonical_input_digest: sha256(WRITING_BYTES),
    provider: 'hexclaw-gpt',
    model: 'gpt-5.6-sol',
    status: 'succeeded',
    attempt: 1,
    result_digest: `sha256:${sha256('unexpected-result')}`,
  })
  assert.throws(
    () => assertModelOperationReceiptsUnchanged(before, added),
    /MODEL_OPERATION_RECEIPTS_CHANGED/u,
  )

  const mutated = structuredClone(before)
  mutated.operation_receipts[1].result_digest = `sha256:${sha256('changed-result')}`
  assert.throws(
    () => assertModelOperationReceiptsUnchanged(before, mutated),
    /MODEL_OPERATION_RECEIPTS_CHANGED/u,
  )
})
