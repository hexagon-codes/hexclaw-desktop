import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
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

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function creativeWork(kind = 'art') {
  const bytes = kind === 'art' ? ART_BYTES : WRITING_BYTES
  const marker = kind === 'art' ? 'HC-CREATIVE-ART-20260825' : 'HC-CREATIVE-WRITING-20260825'
  const display = kind === 'art' ? '美术作品' : '语文写作'
  const body = kind === 'art' ? '' : '春天到了，校园里的花开了。'
  const feedback = '## 可见证据\n\n- **构图**：画面主体清楚。'
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
        external_message_id: `external-${work.work_id}-${target.instance_id}-${kind}`,
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
  assert.equal(projection.delivery.target_count, 'all_deduplicated_bound_targets')
  assert.deepEqual(projection.validate_side_effects, {
    sidecar_starts: 0,
    asset_uploads: 0,
    image_task_posts: 0,
    model_calls: 0,
    im_sends: 0,
    provider_queries: 0,
  })
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

test('delivery exact-set requires N targets times Markdown plus original image and unique external IDs', async () => {
  const { assertDeliveryExactSet } = await modulePromise
  const work = creativeWork('art')
  const proof = assertDeliveryExactSet(deliveredBatch(work, ART_BYTES), expectedArtifact('art'))
  assert.equal(proof.target_count, TARGETS.length)
  assert.equal(proof.receipt_count, TARGETS.length * 2)
  assert.equal(proof.external_message_id_hashes.length, TARGETS.length * 2)
  assert.equal(new Set(proof.external_message_id_hashes).size, TARGETS.length * 2)
  assert.equal(proof.markdown_digest, sha256(canonicalMarkdown(work)))
  assert.equal(proof.image_digest, sha256(ART_BYTES))
})

test('delivery exact-set rejects missing target part, duplicate target, external ID or original byte drift', async () => {
  const { assertDeliveryExactSet } = await modulePromise
  const work = creativeWork('art')
  const expected = expectedArtifact('art')
  const missing = deliveredBatch(work, ART_BYTES)
  missing.receipts.pop()
  assert.throws(() => assertDeliveryExactSet(missing, expected), /DELIVERY_/u)

  const duplicateTarget = deliveredBatch(work, ART_BYTES)
  duplicateTarget.receipts[2].target = { ...duplicateTarget.receipts[0].target }
  assert.throws(() => assertDeliveryExactSet(duplicateTarget, expected), /DELIVERY_/u)

  const duplicateExternal = deliveredBatch(work, ART_BYTES)
  duplicateExternal.receipts[1].external_message_id =
    duplicateExternal.receipts[0].external_message_id
  assert.throws(() => assertDeliveryExactSet(duplicateExternal, expected), /DELIVERY_/u)

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
})

test('real DingTalk client checkpoint ties each target Markdown marker to the matching image digest', async () => {
  const { assertClientCheckpoint, checkpointExpectationFromDelivery } = await modulePromise
  const work = creativeWork('art')
  const batch = deliveredBatch(work, ART_BYTES)
  const expected = checkpointExpectationFromDelivery(batch, expectedArtifact('art'))
  const checkpoint = {
    schema_version: 1,
    scenario: 'k12_real_dingtalk_creative_images',
    work_marker: expected.marker,
    markdown_digest: `sha256:${expected.markdown_digest}`,
    image_digest: `sha256:${expected.image_digest}`,
    observations: expected.targets.map((target) => ({
      ...target,
      marker_visible: true,
      markdown_rendered: true,
      image_visible: true,
      marker_and_image_same_chat: true,
      observed_markdown_digest: `sha256:${expected.markdown_digest}`,
      observed_image_digest: `sha256:${expected.image_digest}`,
    })),
  }
  const proof = assertClientCheckpoint(checkpoint, expected)
  assert.equal(proof.observation_count, TARGETS.length)

  const missing = structuredClone(checkpoint)
  missing.observations.pop()
  assert.throws(() => assertClientCheckpoint(missing, expected), /CLIENT_CHECKPOINT_/u)
  const detached = structuredClone(checkpoint)
  detached.observations[0].marker_and_image_same_chat = false
  assert.throws(() => assertClientCheckpoint(detached, expected), /CLIENT_CHECKPOINT_/u)
  const wrongDigest = structuredClone(checkpoint)
  wrongDigest.observations[0].observed_image_digest = `sha256:${'0'.repeat(64)}`
  assert.throws(() => assertClientCheckpoint(wrongDigest, expected), /CLIENT_CHECKPOINT_/u)
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
