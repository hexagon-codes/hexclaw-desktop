import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  LIVE_CONTRACT,
  assertBatchExactSet,
  assertClientCheckpoint,
  assertRestartCheckpoint,
  phaseBudgetMilliseconds,
  resolveDirectTargets,
  runValidate,
  validateContract,
} from './k12-dingtalk-markdown-pdf-live.mjs'

const MARKER = 'HEX-K12-PDF-LIVE-20260825-7f21'
const MARKDOWN = `## 本周练习卷\n\n请完成后拍照提交。\n\n${MARKER}`
const PDF_BYTES = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n')

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function prefixed(value) {
  return `sha256:${sha256(value)}`
}

function screenshotBytes(seed) {
  const bytes = Buffer.alloc(2048, seed)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes)
  return bytes
}

function canonicalContent() {
  const attachmentDigest = prefixed(PDF_BYTES)
  const input = {
    content_version: '1.0',
    producer_kind: 'k12',
    markdown: MARKDOWN,
    locale: 'zh-CN',
    attachments: [
      {
        asset_id: `inline:${attachmentDigest.slice('sha256:'.length)}`,
        name: '本周练习卷.pdf',
        mime: 'application/pdf',
        digest: attachmentDigest,
        alt_text: '本周练习卷.pdf',
      },
    ],
  }
  const sourceDigest = prefixed(Buffer.from(JSON.stringify(input)))
  return {
    content_id: `content:${sourceDigest.slice('sha256:'.length)}`,
    ...input,
    source_digest: sourceDigest,
  }
}

function canonicalManifest(content) {
  return {
    render_id: `render:${'9'.repeat(64)}`,
    content_id: content.content_id,
    surface: 'channel',
    capability_snapshot: {
      markdown: true,
      tex_math: false,
      attachments: true,
    },
    renderer_version: 'channel-markdown-v1',
    source_digest: content.source_digest,
    parts: [
      { kind: 'markdown', text: MARKDOWN },
      {
        kind: 'artifact',
        artifact_ref: content.attachments[0].asset_id,
        artifact_digest: content.attachments[0].digest,
        alt_text: content.attachments[0].alt_text,
      },
    ],
  }
}

function target(index) {
  return {
    binding_id: `agent-rule:${index}`,
    platform: 'dingtalk',
    instance_id: `family-bot-${index}`,
    chat_id: `parent-${index}`,
  }
}

function deliveredBatch(targets = [target(1), target(2)]) {
  const content = canonicalContent()
  const manifest = canonicalManifest(content)
  const receipts = []
  let batchOrdinal = 1
  for (const expected of targets) {
    const markdownPayload = JSON.stringify({
      kind: 'markdown',
      ordinal: 1,
      digest: prefixed(Buffer.from(MARKDOWN)),
      text: MARKDOWN,
      message_content: content,
      render_manifest: manifest,
    })
    receipts.push({
      delivery_id: `delivery-${batchOrdinal}`,
      batch_id: 'batch-1',
      batch_ordinal: batchOrdinal++,
      part_kind: 'markdown',
      part_ordinal: 1,
      part_digest: prefixed(Buffer.from(MARKDOWN)),
      agent_name: 'xiaoming',
      object_kind: 'weekly_practice_snapshot',
      object_id: 'snapshot-1',
      binding_id: expected.binding_id,
      target: {
        platform: expected.platform,
        instance_id: expected.instance_id,
        chat_id: expected.chat_id,
      },
      status: 'delivered',
      dedupe_key: `dedupe-${batchOrdinal}-markdown`,
      payload_digest: prefixed(Buffer.from(markdownPayload)),
      payload_json: markdownPayload,
      render_manifest_json: JSON.stringify(manifest),
      external_message_id: `external-${expected.instance_id}-markdown`,
      attempt: 1,
      created_at: 1,
      updated_at: 2,
    })

    const artifactPayload = JSON.stringify({
      kind: 'artifact',
      mime: 'application/pdf',
      ordinal: 2,
      digest: prefixed(PDF_BYTES),
      attachment: {
        name: '本周练习卷.pdf',
        mime: 'application/pdf',
        data: PDF_BYTES.toString('base64'),
      },
      message_content: content,
      render_manifest: manifest,
    })
    receipts.push({
      delivery_id: `delivery-${batchOrdinal}`,
      batch_id: 'batch-1',
      batch_ordinal: batchOrdinal++,
      part_kind: 'artifact',
      part_mime: 'application/pdf',
      part_ordinal: 2,
      part_digest: prefixed(PDF_BYTES),
      agent_name: 'xiaoming',
      object_kind: 'weekly_practice_snapshot',
      object_id: 'snapshot-1',
      binding_id: expected.binding_id,
      target: {
        platform: expected.platform,
        instance_id: expected.instance_id,
        chat_id: expected.chat_id,
      },
      status: 'delivered',
      dedupe_key: `dedupe-${batchOrdinal}-artifact`,
      payload_digest: prefixed(Buffer.from(artifactPayload)),
      payload_json: artifactPayload,
      render_manifest_json: JSON.stringify(manifest),
      external_message_id: `external-${expected.instance_id}-file`,
      attempt: 1,
      created_at: 1,
      updated_at: 3,
    })
  }
  return {
    batch_id: 'batch-1',
    agent_name: 'xiaoming',
    object_kind: 'weekly_practice_snapshot',
    object_id: 'snapshot-1',
    dedupe_key: 'batch-dedupe-1',
    content_digest: prefixed(Buffer.from('batch-content')),
    status: 'delivered',
    receipts,
    created_at: 1,
    updated_at: 3,
  }
}

function expectedFacts(targets = [target(1), target(2)]) {
  return {
    agent_name: 'xiaoming',
    snapshot_id: 'snapshot-1',
    marker: MARKER,
    marker_sha256: sha256(MARKER),
    pdf_sha256: sha256(PDF_BYTES),
    pdf_bytes: PDF_BYTES,
    targets,
  }
}

test('contract freezes one public app request, send-all, Markdown+PDF and zero-side-effect validate', () => {
  const projection = validateContract(LIVE_CONTRACT)
  assert.deepEqual(projection.public_api, {
    rules: '/api/v1/agents/rules',
    instances: '/api/v1/platforms/instances',
    snapshot: '/api/k12/weekly-practice/snapshots/{snapshot_id}',
    artifact: '/api/k12/print-artifacts/{artifact_id}/content',
    send: '/api/k12/weekly-practice/snapshots/{snapshot_id}/send',
    batch: '/api/k12/delivery-batches/{batch_id}',
    query: '/api/k12/delivery-batches/{batch_id}/query',
  })
  assert.equal(projection.delivery.request_count, 1)
  assert.equal(projection.delivery.parts_per_target, 2)
  assert.deepEqual(projection.delivery.part_transport, ['sampleMarkdown', 'sampleFile'])
  assert.deepEqual(projection.validate_side_effects, {
    sidecar_starts: 0,
    uploads: 0,
    sends: 0,
    provider_queries: 0,
  })
  assert.equal(projection.require_real_client_checkpoint, true)
  assert.equal(projection.require_restart_checkpoint, true)
})

test('validate is offline-only and cannot be reported as a live PASS', () => {
  const result = runValidate()
  assert.equal(result.status, 'VALIDATED_OFFLINE_NOT_LIVE_PASS')
  assert.equal(result.live_pass, false)
  assert.deepEqual(result.side_effects, {
    sidecar_starts: 0,
    uploads: 0,
    sends: 0,
    provider_queries: 0,
  })
  assert.ok(phaseBudgetMilliseconds({}) > 0)
  assert.ok(phaseBudgetMilliseconds({}) < 30 * 60_000)
  assert.equal(
    phaseBudgetMilliseconds({ HEX_K12_DINGTALK_PDF_TIMEOUT_MS: '99999999' }),
    29 * 60_000,
  )
})

test('direct targets normalize, sort and dedupe exact physical DingTalk identities', () => {
  const rules = [
    {
      id: 9,
      platform: ' DingTalk ',
      instance_id: ' bot-b ',
      chat_id: ' parent-b ',
      user_id: 'duplicate-user',
      agent_name: ' 小明 ',
    },
    {
      id: 3,
      platform: 'dingtalk',
      instance_id: 'bot-a',
      chat_id: 'parent-a',
      user_id: 'user-a',
      agent_name: '小明',
    },
    {
      id: 10,
      platform: 'dingtalk',
      instance_id: 'bot-b',
      chat_id: 'parent-b',
      user_id: 'another-user',
      agent_name: '小明',
    },
    {
      id: 11,
      platform: 'dingtalk',
      instance_id: 'bot-c',
      chat_id: '\u0000group',
      agent_name: '小明',
    },
  ]
  assert.deepEqual(resolveDirectTargets(rules, '小明'), [
    {
      binding_id: 'agent-rule:3',
      platform: 'dingtalk',
      instance_id: 'bot-a',
      chat_id: 'parent-a',
    },
    {
      binding_id: 'agent-rule:9',
      platform: 'dingtalk',
      instance_id: 'bot-b',
      chat_id: 'parent-b',
    },
  ])
})

test('delivered batch must be N x (sampleMarkdown + sampleFile) with canonical PDF bytes', () => {
  const targets = [target(1), target(2)]
  const projection = assertBatchExactSet(deliveredBatch(targets), expectedFacts(targets))
  assert.equal(projection.target_count, 2)
  assert.equal(projection.receipt_count, 4)
  assert.deepEqual(projection.part_transports, ['sampleMarkdown', 'sampleFile'])
  assert.equal(projection.marker_sha256, sha256(MARKER))
  assert.equal(projection.pdf_sha256, sha256(PDF_BYTES))
  assert.equal(projection.external_message_id_sha256.length, 4)
  assert.equal(new Set(projection.external_message_id_sha256).size, 4)
  assert.equal(projection.canonical_source_digest, canonicalContent().source_digest)
})

test('Markdown visible projection may apply the frozen math fallback without changing canonical source', () => {
  const batch = deliveredBatch([target(1)])
  const projected = `${MARKDOWN.replace('请完成后拍照提交。', '请完成 1/2 + 1/2。')}\n`
  for (const receipt of batch.receipts) {
    const payload = JSON.parse(receipt.payload_json)
    payload.render_manifest.parts[0].text = projected
    if (payload.kind === 'markdown') payload.text = projected
    receipt.payload_json = JSON.stringify(payload)
    receipt.payload_digest = prefixed(Buffer.from(receipt.payload_json))
    receipt.render_manifest_json = JSON.stringify(payload.render_manifest)
  }
  const projection = assertBatchExactSet(batch, expectedFacts([target(1)]))
  assert.equal(projection.canonical_source_digest, canonicalContent().source_digest)
})

test('batch evidence fails closed on missing external IDs, unsafe paths, duplicate/missing parts and drift', () => {
  const targets = [target(1), target(2)]
  const missingExternal = deliveredBatch(targets)
  delete missingExternal.receipts[0].external_message_id
  assert.throws(
    () => assertBatchExactSet(missingExternal, expectedFacts(targets)),
    /EXTERNAL_MESSAGE_ID_REQUIRED/u,
  )

  const missingPDF = deliveredBatch(targets)
  missingPDF.receipts.splice(1, 1)
  assert.throws(
    () => assertBatchExactSet(missingPDF, expectedFacts(targets)),
    /RECEIPT_EXACT_SET_INVALID/u,
  )

  const unsafePath = deliveredBatch(targets)
  const payload = JSON.parse(unsafePath.receipts[1].payload_json)
  payload.attachment.name = 'file:///private/tmp/secret.pdf'
  unsafePath.receipts[1].payload_json = JSON.stringify(payload)
  unsafePath.receipts[1].payload_digest = prefixed(Buffer.from(unsafePath.receipts[1].payload_json))
  assert.throws(
    () => assertBatchExactSet(unsafePath, expectedFacts(targets)),
    /LOCAL_REFERENCE_FORBIDDEN/u,
  )

  const remoteName = deliveredBatch(targets)
  const remotePayload = JSON.parse(remoteName.receipts[1].payload_json)
  remotePayload.attachment.name = 'https://example.invalid/practice.pdf'
  remoteName.receipts[1].payload_json = JSON.stringify(remotePayload)
  remoteName.receipts[1].payload_digest = prefixed(Buffer.from(remoteName.receipts[1].payload_json))
  assert.throws(
    () => assertBatchExactSet(remoteName, expectedFacts(targets)),
    /PDF_FILENAME_INVALID/u,
  )

  const manifestDrift = deliveredBatch(targets)
  const driftPayload = JSON.parse(manifestDrift.receipts[3].payload_json)
  driftPayload.render_manifest.parts[1].artifact_digest = `sha256:${'0'.repeat(64)}`
  manifestDrift.receipts[3].payload_json = JSON.stringify(driftPayload)
  manifestDrift.receipts[3].payload_digest = prefixed(
    Buffer.from(manifestDrift.receipts[3].payload_json),
  )
  assert.throws(
    () => assertBatchExactSet(manifestDrift, expectedFacts(targets)),
    /CANONICAL_MANIFEST_DRIFT/u,
  )
})

test('restart checkpoint proves a different process read only the original frozen batch', () => {
  const batch = deliveredBatch()
  const projection = assertBatchExactSet(batch, expectedFacts())
  const checkpoint = {
    schema_version: 1,
    source: 'hexclaw-native-restart-observer',
    marker_sha256: sha256(MARKER),
    batch_id_sha256: sha256(batch.batch_id),
    content_digest: batch.content_digest,
    process_before_sha256: '1'.repeat(64),
    process_after_sha256: '2'.repeat(64),
    read_method: 'GET',
    read_path_sha256: sha256(`/api/k12/delivery-batches/${batch.batch_id}`),
    observed_receipt_set_sha256: projection.receipt_set_sha256,
    observed_external_message_id_set_sha256: projection.external_message_id_set_sha256,
    send_calls: 0,
    upload_calls: 0,
    retry_calls: 0,
    observed_at: '2026-08-25T10:00:00.000Z',
  }
  assert.deepEqual(
    assertRestartCheckpoint(checkpoint, {
      batch,
      marker: MARKER,
      delivery: projection,
    }),
    {
      source: checkpoint.source,
      process_changed: true,
      read_only: true,
      observed_at: checkpoint.observed_at,
    },
  )

  assert.throws(
    () =>
      assertRestartCheckpoint(
        { ...checkpoint, process_after_sha256: checkpoint.process_before_sha256 },
        { batch, marker: MARKER, delivery: projection },
      ),
    /RESTART_PROCESS_IDENTITY_INVALID/u,
  )
  assert.throws(
    () =>
      assertRestartCheckpoint(
        { ...checkpoint, send_calls: 1 },
        { batch, marker: MARKER, delivery: projection },
      ),
    /RESTART_NOT_READ_ONLY/u,
  )
})

test('real client checkpoint must match marker, both provider IDs, PDF digest and screenshot bytes', async () => {
  const batch = deliveredBatch([target(1)])
  const delivery = assertBatchExactSet(batch, expectedFacts([target(1)]))
  const evidenceRoot = await mkdtemp(join(tmpdir(), 'hexclaw-dingtalk-client-evidence-'))
  await chmod(evidenceRoot, 0o700)
  const markdownScreenshot = join(evidenceRoot, 'markdown.png')
  const pdfScreenshot = join(evidenceRoot, 'pdf.png')
  await writeFile(markdownScreenshot, screenshotBytes(0x31), { mode: 0o600 })
  await writeFile(pdfScreenshot, screenshotBytes(0x32), { mode: 0o600 })

  const markdownID = sha256(batch.receipts[0].external_message_id)
  const pdfID = sha256(batch.receipts[1].external_message_id)
  const targetDigest = sha256('dingtalk\u0000family-bot-1\u0000parent-1')
  const checkpoint = {
    schema_version: 1,
    source: 'dingtalk-real-client-observer',
    client: 'ios',
    marker: MARKER,
    marker_sha256: sha256(MARKER),
    batch_id_sha256: sha256(batch.batch_id),
    content_digest: batch.content_digest,
    pdf_sha256: sha256(PDF_BYTES),
    pdf_filename_sha256: delivery.pdf_filename_sha256,
    target_set_sha256: delivery.target_set_sha256,
    observations: [
      {
        target_sha256: targetDigest,
        markdown_external_message_id_sha256: markdownID,
        file_external_message_id_sha256: pdfID,
        markdown_marker_visible: true,
        pdf_filename_visible: true,
        pdf_opened: true,
        markdown_screenshot_path: markdownScreenshot,
        markdown_screenshot_sha256: sha256(screenshotBytes(0x31)),
        pdf_screenshot_path: pdfScreenshot,
        pdf_screenshot_sha256: sha256(screenshotBytes(0x32)),
      },
    ],
    observed_at: '2026-08-25T10:01:00.000Z',
  }
  const projection = await assertClientCheckpoint(checkpoint, {
    evidence_root: evidenceRoot,
    batch,
    marker: MARKER,
    pdf_sha256: sha256(PDF_BYTES),
    delivery,
  })
  assert.equal(projection.source, 'dingtalk-real-client-observer')
  assert.equal(projection.client, 'ios')
  assert.equal(projection.observation_count, 1)
  assert.equal(projection.markdown_visible, true)
  assert.equal(projection.pdf_opened, true)

  await assert.rejects(
    () =>
      assertClientCheckpoint(
        {
          ...checkpoint,
          observations: [
            {
              ...checkpoint.observations[0],
              markdown_external_message_id_sha256: '0'.repeat(64),
            },
          ],
        },
        {
          evidence_root: evidenceRoot,
          batch,
          marker: MARKER,
          pdf_sha256: sha256(PDF_BYTES),
          delivery,
        },
      ),
    /REAL_CLIENT_EXTERNAL_ID_DRIFT/u,
  )
})

test('harness source cannot upload, retry, invoke DingTalk directly, fabricate checkpoints or exceed one send request', async () => {
  const source = await readFile(
    new URL('./k12-dingtalk-markdown-pdf-live.mjs', import.meta.url),
    'utf8',
  )
  assert.doesNotMatch(source, /\bdws\b/u)
  assert.doesNotMatch(source, /openapi\.dingtalk|api\.dingtalk|oapi\.dingtalk/iu)
  assert.doesNotMatch(source, /\/delivery-batches\/\$\{[^}]+\}\/retry/u)
  assert.doesNotMatch(source, /\/api\/k12\/assets|multipart|formdata/iu)
  assert.doesNotMatch(source, /writeFile|appendFile|createWriteStream/u)
  assert.doesNotMatch(source, /spawn|execFile|child_process/u)
  assert.match(source, /request_count:\s*1/u)
  assert.match(source, /await apiJSON\([\s\S]*?SEND_PATH/u)
  assert.match(source, /awaitCheckpoint\([\s\S]*?RESTART_CHECKPOINT/u)
  assert.match(source, /awaitCheckpoint\([\s\S]*?CLIENT_CHECKPOINT/u)
})
