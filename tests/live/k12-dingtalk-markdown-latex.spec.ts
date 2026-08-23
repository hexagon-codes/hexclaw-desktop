import { expect, test, type TestInfo } from '@playwright/test'
import {
  assertCanonicalContent,
  assertLiveRuntime,
  assertRenderManifest,
  attachJSON,
  envValue,
  liveGateBlockers,
  liveJSON,
  liveSkipReason,
  sha256Text,
  type MessageContentEvidence,
  type RenderManifestEvidence,
} from './k12-live-helpers'

const blockers = liveGateBlockers({ dingTalk: true })
if (!envValue('HEX_K12_LIVE_FINAL_ARTIFACT_ID')) {
  blockers.push('HEX_K12_LIVE_FINAL_ARTIFACT_ID')
}
if (!/^(?:sha256:)?[0-9a-f]{64}$/i.test(envValue('HEX_K12_LIVE_FINAL_ARTIFACT_DIGEST'))) {
  blockers.push('HEX_K12_LIVE_FINAL_ARTIFACT_DIGEST(valid-sha256)')
}

type DeliveryStatus = 'pending' | 'sending' | 'delivered' | 'failed' | 'outcome_unknown'

interface DeliveryReceipt {
  delivery_id: string
  agent_name: string
  object_kind: string
  object_id: string
  binding_id: string
  target: {
    platform: string
    instance_id?: string
    chat_id: string
    label?: string
  }
  status: DeliveryStatus
  dedupe_key: string
  payload_digest: string
  payload_json: string
  render_manifest_json: string
  external_message_id?: string
  attempt: number
  created_at: number
  updated_at: number
}

interface DeliveryBatch {
  batch_id: string
  agent_name: string
  object_kind: string
  object_id: string
  dedupe_key: string
  content_digest: string
  status: DeliveryStatus | 'partial_failed'
  receipts: DeliveryReceipt[]
  created_at: number
  updated_at: number
}

interface FrozenChannelMessage {
  Text?: string
  Content?: MessageContentEvidence
  RenderManifest?: RenderManifestEvidence
  Attachments?: unknown[] | null
}

async function convergeReceipt(
  request: Parameters<typeof liveJSON>[0],
  agentName: string,
  initial: DeliveryReceipt,
): Promise<DeliveryReceipt> {
  let latest = initial
  await expect
    .poll(
      async () => {
        if (latest.status === 'failed') {
          throw new Error('DingTalk provider reported a terminal failure (detail redacted)')
        }
        if (latest.status === 'delivered') return latest.status
        latest = await liveJSON<DeliveryReceipt>(
          request,
          'POST',
          `/api/k12/delivery-receipts/${encodeURIComponent(latest.delivery_id)}/query`,
          { agent: agentName },
        )
        return latest.status
      },
      {
        timeout: 180_000,
        intervals: [1_000, 2_000, 4_000, 8_000],
        message:
          'provider acceptance is not delivery; the durable Receipt must converge to delivered',
      },
    )
    .toBe('delivered')
  return latest
}

test.describe
  .serial('LIVE K12 frozen solution artifact → DingTalk Markdown receipt acceptance', () => {
  test.skip(
    blockers.length > 0,
    liveSkipReason(blockers, 'explicit real DingTalk direct authorization'),
  )

  test('sends only the exact frozen solution, preserves Markdown and converges one idempotent Receipt', async ({
    page,
    request,
  }, testInfo: TestInfo) => {
    await assertLiveRuntime(page, request, testInfo)
    const instanceName = envValue('DINGTALK_LIVE_INSTANCE')
    const instanceID = envValue('DINGTALK_LIVE_INSTANCE_ID')
    const approvedUserID = envValue('DINGTALK_LIVE_USERID')
    const agentName = envValue('HEX_K12_LIVE_AGENT')
    const artifactID = envValue('HEX_K12_LIVE_FINAL_ARTIFACT_ID')
    const artifactDigest = envValue('HEX_K12_LIVE_FINAL_ARTIFACT_DIGEST').replace(/^sha256:/i, '')

    const health = await liveJSON<{
      name?: string
      provider?: string
      mode?: string
      status?: string
      healthy?: boolean
    }>(request, 'GET', `/api/v1/platforms/instances/${encodeURIComponent(instanceName)}/health`)
    expect(
      health.name === instanceName,
      'health response must belong to the approved instance (value redacted)',
    ).toBe(true)
    expect(health.provider).toBe('dingtalk')
    expect(health.status).toBe('running')
    expect(health.healthy).toBe(true)

    const initialBatch = await liveJSON<DeliveryBatch>(
      request,
      'POST',
      '/api/k12/tutoring-tips/send',
      {
        agent: agentName,
        final_artifact_id: artifactID,
        final_artifact_digest: artifactDigest,
      },
    )
    expect(
      initialBatch.agent_name === agentName,
      'Batch owner must equal the gated K12 Agent (value redacted)',
    ).toBe(true)
    expect(initialBatch.object_kind).toBe('grading_final_artifact')
    expect(initialBatch.object_id).toBe(`${artifactID}:${artifactDigest}`)
    expect(initialBatch.receipts).toHaveLength(1)
    const initial = initialBatch.receipts[0]!
    expect(initial.object_kind).toBe('grading_final_artifact')
    expect(initial.object_id).toBe(initialBatch.object_id)
    expect(initial.binding_id).toMatch(/^agent-rule:/)
    expect(initial.target.platform).toBe('dingtalk')
    expect(
      initial.target.instance_id === instanceID,
      'Receipt instance must equal the approved instance ID (value redacted)',
    ).toBe(true)
    expect(
      initial.target.chat_id === approvedUserID,
      'Receipt target must equal the approved direct user (value redacted)',
    ).toBe(true)
    expect(
      initial.external_message_id?.trim().length,
      'provider acceptance must return an external query key',
    ).toBeGreaterThan(0)
    expect(['sending', 'delivered', 'outcome_unknown']).toContain(initial.status)
    expect(initial.attempt).toBeGreaterThanOrEqual(1)
    expect(initial.payload_digest).toBe(`sha256:${sha256Text(initial.payload_json)}`)
    expect(initial.dedupe_key).toMatch(/^sha256:[0-9a-f]{64}$/)

    const payload = JSON.parse(initial.payload_json) as FrozenChannelMessage
    const content = assertCanonicalContent(payload.Content, 'k12')
    expect(content.markdown).toContain('# 作业批改结果')
    const manifest = assertRenderManifest(
      JSON.parse(initial.render_manifest_json) as RenderManifestEvidence,
      content,
      'channel',
    )
    expect(payload.RenderManifest).toEqual(manifest)
    expect(manifest.capability_snapshot.markdown).toBe(true)
    expect(manifest.capability_snapshot.tex_math).toBe(false)
    expect(manifest.capability_snapshot.unicode_math).toBe(true)
    expect(manifest.fallback_reason).toBe('math_to_readable_text')
    expect(manifest.parts).toHaveLength(1)
    expect(manifest.parts[0]?.kind).toBe('markdown')
    const projected = manifest.parts[0]?.kind === 'markdown' ? manifest.parts[0].text : ''
    expect(payload.Text).toBe(projected)
    expect(projected).toMatch(/^# 作业批改结果/m)
    expect(projected).toMatch(/^[-*] /m)
    expect(projected).toContain('# 这份作业的辅导要点')
    expect(projected).toMatch(/每道题怎么带|家长怎么讲/)
    expect(projected).not.toContain('work_evaluation_json')
    expect(projected).not.toMatch(/\\(?:frac|begin|mathrm|times|circ)\b|\$[^$\n]+\$|\$\$/)
    expect(
      projected,
      'readable channel projection must not leak LaTeX spacing commands',
    ).not.toContain('\\,')
    expect(
      payload.Attachments == null || payload.Attachments.length === 0,
      'message body, not an attachment, must carry the frozen solution',
    ).toBe(true)

    const delivered = await convergeReceipt(request, agentName, initial)
    expect(delivered.delivery_id).toBe(initial.delivery_id)
    expect(delivered.status).toBe('delivered')
    expect(delivered.external_message_id).toBe(initial.external_message_id)
    expect(delivered.payload_digest).toBe(initial.payload_digest)

    // 同一个冻结成品身份必须命中同一批次与同一回执，不能产生第二条真实钉钉消息。
    const replayBatch = await liveJSON<DeliveryBatch>(
      request,
      'POST',
      '/api/k12/tutoring-tips/send',
      {
        agent: agentName,
        final_artifact_id: artifactID,
        final_artifact_digest: artifactDigest,
      },
    )
    expect(replayBatch.batch_id).toBe(initialBatch.batch_id)
    expect(replayBatch.receipts).toHaveLength(1)
    const replay = replayBatch.receipts[0]!
    expect(replay.delivery_id).toBe(delivered.delivery_id)
    expect(replay.dedupe_key).toBe(delivered.dedupe_key)
    expect(replay.external_message_id).toBe(delivered.external_message_id)
    expect(replay.attempt, 'idempotent replay must not start a second provider attempt').toBe(
      delivered.attempt,
    )

    const durableBatch = await liveJSON<DeliveryBatch>(
      request,
      'GET',
      `/api/k12/delivery-batches/${encodeURIComponent(initialBatch.batch_id)}?agent=${encodeURIComponent(agentName)}`,
    )
    expect(durableBatch.status).toBe('delivered')
    expect(durableBatch.receipts).toHaveLength(1)
    const durable = durableBatch.receipts[0]!
    expect(durable.status).toBe('delivered')
    expect(durable.payload_digest).toBe(initial.payload_digest)
    expect(durable.render_manifest_json).toBe(initial.render_manifest_json)

    await attachJSON(testInfo, 'dingtalk-receipt-evidence', {
      delivery_id_sha256: sha256Text(delivered.delivery_id),
      external_message_id_sha256: sha256Text(delivered.external_message_id ?? ''),
      target_sha256: sha256Text(`${delivered.target.instance_id}\0${delivered.target.chat_id}`),
      object_id_sha256: sha256Text(delivered.object_id),
      final_artifact_id_sha256: sha256Text(artifactID),
      final_artifact_digest: artifactDigest,
      payload_digest: delivered.payload_digest,
      source_digest: content.source_digest,
      render_id: manifest.render_id,
      renderer_version: manifest.renderer_version,
      capability_snapshot: manifest.capability_snapshot,
      fallback_reason: manifest.fallback_reason,
      status: durable.status,
      attempt: durable.attempt,
      batch_id_sha256: sha256Text(initialBatch.batch_id),
      idempotent_replay: true,
      real_client_visual_confirmation:
        'separate Android/iOS/Desktop DEVICE evidence; not claimed by this API receipt lane',
    })
  })
})
