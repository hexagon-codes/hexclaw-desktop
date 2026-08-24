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
  resolveLiveDirectPhysicalTargets,
  sha256Text,
  type LiveAgentRule,
  type LiveDirectPhysicalTarget,
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

interface PlatformInstance {
  id: string
  provider: string
  name: string
  enabled: boolean
  status?: string
}

function receiptTarget(receipt: DeliveryReceipt): LiveDirectPhysicalTarget {
  return {
    binding_id: receipt.binding_id,
    platform: receipt.target.platform,
    instance_id: receipt.target.instance_id ?? '',
    chat_id: receipt.target.chat_id,
  }
}

function sameTargetSnapshot(
  actual: LiveDirectPhysicalTarget[],
  expected: LiveDirectPhysicalTarget[],
): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected)
}

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) delete process.env[name]
  else process.env[name] = previous
}

function resolveRunningInstance(
  instances: PlatformInstance[],
  target: LiveDirectPhysicalTarget,
): PlatformInstance {
  const running = instances.filter((instance) => instance.enabled && instance.status === 'running')
  if (target.instance_id) {
    const byID = running.filter((instance) => instance.id === target.instance_id)
    if (byID.length > 0) {
      expect(
        byID.length === 1,
        'a direct target instance ID must resolve once (values redacted)',
      ).toBe(true)
      return byID[0]!
    }
    const byName = running.filter((instance) => instance.name === target.instance_id)
    expect(
      byName.length === 1,
      'a direct target instance name must resolve once (values redacted)',
    ).toBe(true)
    return byName[0]!
  }

  const byProvider = running
    .filter((instance) => instance.provider === target.platform)
    .sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)))
  expect(
    byProvider.length,
    'a platform fallback target must resolve to a running instance',
  ).toBeGreaterThan(0)
  return byProvider[0]!
}

async function currentDirectTargetSnapshot(
  request: Parameters<typeof liveJSON>[0],
  agentName: string,
): Promise<LiveDirectPhysicalTarget[]> {
  const rulesResponse = await liveJSON<{ rules?: LiveAgentRule[] }>(
    request,
    'GET',
    '/api/v1/agents/rules',
  )
  const targets = resolveLiveDirectPhysicalTargets(rulesResponse.rules ?? [], agentName)
  expect(targets.length, 'the gated K12 Agent must have direct physical targets').toBeGreaterThan(0)

  const instancesResponse = await liveJSON<{ instances?: PlatformInstance[] }>(
    request,
    'GET',
    '/api/v1/platforms/instances',
  )
  const instances = instancesResponse.instances ?? []
  const checkedNames = new Set<string>()
  for (const target of targets) {
    const instance = resolveRunningInstance(instances, target)
    expect(instance.provider).toBe(target.platform)
    if (checkedNames.has(instance.name)) continue
    checkedNames.add(instance.name)
    const health = await liveJSON<{
      name?: string
      provider?: string
      status?: string
      healthy?: boolean
    }>(request, 'GET', `/api/v1/platforms/instances/${encodeURIComponent(instance.name)}/health`)
    expect(
      health.name === instance.name,
      'health response must belong to the resolved instance (values redacted)',
    ).toBe(true)
    expect(health.provider).toBe(target.platform)
    expect(health.status).toBe('running')
    expect(health.healthy).toBe(true)
  }
  return targets
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

test.describe('LIVE harness contracts (no provider send)', () => {
  test('normalizes, sorts, and deduplicates every direct physical target like production', () => {
    const agentName = 'Tutor Agent'
    const rules: LiveAgentRule[] = [
      {
        id: 8,
        platform: ' DingTalk ',
        instance_id: ' bot-a ',
        user_id: 'user-duplicate',
        chat_id: ' direct-a ',
        agent_name: ` ${agentName} `,
      },
      {
        id: 7,
        platform: 'dingtalk',
        instance_id: 'bot-a',
        user_id: 'user-canonical',
        chat_id: 'direct-a',
        agent_name: agentName,
      },
      {
        id: 9,
        platform: 'dingtalk',
        instance_id: 'bot-b',
        chat_id: 'direct-b',
        agent_name: agentName,
      },
      {
        id: 6,
        platform: 'feishu',
        instance_id: 'fs-1',
        chat_id: 'direct-c',
        agent_name: agentName,
      },
      {
        id: 5,
        platform: 'dingtalk',
        instance_id: 'bot-a',
        chat_id: '\0dingtalk-group:forbidden',
        agent_name: agentName,
      },
      {
        id: 4,
        platform: 'dingtalk',
        instance_id: 'bot-a',
        chat_id: 'other-agent',
        agent_name: 'Different Agent',
      },
      {
        platform: '\u0085wecom\u0085',
        instance_id: 'wx-1',
        user_id: 'direct-user',
        chat_id: 'direct-d',
        agent_name: `\u0085${agentName}\u0085`,
      },
    ]

    expect(resolveLiveDirectPhysicalTargets(rules, agentName)).toEqual([
      {
        binding_id: 'agent-rule:7',
        platform: 'dingtalk',
        instance_id: 'bot-a',
        chat_id: 'direct-a',
      },
      {
        binding_id: 'agent-rule:9',
        platform: 'dingtalk',
        instance_id: 'bot-b',
        chat_id: 'direct-b',
      },
      {
        binding_id: 'agent-rule:6',
        platform: 'feishu',
        instance_id: 'fs-1',
        chat_id: 'direct-c',
      },
      {
        binding_id: `agent-rule:sha256:${sha256Text(
          ['wecom', 'wx-1', 'direct-user', 'direct-d', agentName].join('\0'),
        )}`,
        platform: 'wecom',
        instance_id: 'wx-1',
        chat_id: 'direct-d',
      },
    ])
  })

  test('adds the process capability only to a non-redirecting Sidecar request', async () => {
    const capability = 'c'.repeat(64)
    const previousURL = process.env.HEX_K12_LIVE_SIDECAR_URL
    const previousCapability = process.env.HEXCLAW_SIDECAR_CAPABILITY_TOKEN
    let capturedHeaders: Record<string, string> | undefined
    let capturedMaxRedirects: number | undefined
    const fakeRequest = {
      fetch: async (
        _url: string,
        options: { headers?: Record<string, string>; maxRedirects?: number },
      ) => {
        capturedHeaders = options.headers
        capturedMaxRedirects = options.maxRedirects
        return {
          ok: () => true,
          json: async () => ({ status: 'healthy' }),
          status: () => 200,
        }
      },
    } as unknown as Parameters<typeof liveJSON>[0]

    process.env.HEX_K12_LIVE_SIDECAR_URL = 'http://127.0.0.1:16060'
    process.env.HEXCLAW_SIDECAR_CAPABILITY_TOKEN = capability
    try {
      const evidence = await liveJSON<{ status: string }>(fakeRequest, 'GET', '/health')
      expect(
        capturedHeaders?.Authorization === `Bearer ${capability}`,
        'Sidecar request must carry the process capability (value redacted)',
      ).toBe(true)
      expect(capturedMaxRedirects, 'Sidecar requests must never follow redirects').toBe(0)
      expect(evidence).toEqual({ status: 'healthy' })
      expect(
        JSON.stringify(evidence).includes(capability),
        'Sidecar capability must not enter serialized evidence',
      ).toBe(false)

      const failingRequest = {
        fetch: async () => {
          throw new Error(`transport failure ${capability}`)
        },
      } as unknown as Parameters<typeof liveJSON>[0]
      let failureMessage = ''
      try {
        await liveJSON(failingRequest, 'GET', '/health')
      } catch (error) {
        failureMessage = error instanceof Error ? error.message : ''
      }
      expect(
        failureMessage.includes(capability),
        'Sidecar capability must not enter a reported transport error',
      ).toBe(false)
      expect(failureMessage).toContain('detail redacted')
    } finally {
      restoreEnv('HEX_K12_LIVE_SIDECAR_URL', previousURL)
      restoreEnv('HEXCLAW_SIDECAR_CAPABILITY_TOKEN', previousCapability)
    }
  })

  test('rejects unsafe Sidecar origins before transport', async () => {
    const capability = 'd'.repeat(64)
    const previousURL = process.env.HEX_K12_LIVE_SIDECAR_URL
    const previousCapability = process.env.HEXCLAW_SIDECAR_CAPABILITY_TOKEN
    let fetchCalls = 0
    const fakeRequest = {
      fetch: async () => {
        fetchCalls += 1
        return {
          ok: () => true,
          json: async () => ({ status: 'healthy' }),
          status: () => 200,
        }
      },
    } as unknown as Parameters<typeof liveJSON>[0]

    process.env.HEXCLAW_SIDECAR_CAPABILITY_TOKEN = capability
    const failures: string[] = []
    try {
      for (const unsafeURL of [
        'https://sidecar.example.invalid:16060',
        'http://user:secret@127.0.0.1:16060',
      ]) {
        process.env.HEX_K12_LIVE_SIDECAR_URL = unsafeURL
        try {
          await liveJSON(fakeRequest, 'GET', '/health')
        } catch (error) {
          failures.push(error instanceof Error ? error.message : '')
        }
      }

      expect(fetchCalls, 'unsafe Sidecar origins must be rejected before fake fetch').toBe(0)
      expect(failures).toHaveLength(2)
      expect(
        failures.every(
          (message) => message.includes('loopback origin') && !message.includes(capability),
        ),
        'origin rejection must be explicit and capability-safe',
      ).toBe(true)
    } finally {
      restoreEnv('HEX_K12_LIVE_SIDECAR_URL', previousURL)
      restoreEnv('HEXCLAW_SIDECAR_CAPABILITY_TOKEN', previousCapability)
    }
  })
})

test.describe
  .serial('LIVE K12 frozen solution artifact → DingTalk Markdown receipt acceptance', () => {
  test.skip(
    blockers.length > 0,
    liveSkipReason(blockers, 'explicit real DingTalk direct authorization'),
  )

  test('sends the exact frozen solution to every direct physical target and converges idempotent Receipts', async ({
    page,
    request,
  }, testInfo: TestInfo) => {
    await assertLiveRuntime(page, request, testInfo)
    const agentName = envValue('HEX_K12_LIVE_AGENT')
    const artifactID = envValue('HEX_K12_LIVE_FINAL_ARTIFACT_ID')
    const artifactDigest = envValue('HEX_K12_LIVE_FINAL_ARTIFACT_DIGEST').replace(/^sha256:/i, '')
    const expectedTargets = await currentDirectTargetSnapshot(request, agentName)

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
    expect(initialBatch.receipts).toHaveLength(expectedTargets.length)
    expect(
      sameTargetSnapshot(initialBatch.receipts.map(receiptTarget), expectedTargets),
      'initial Receipts must exactly cover the frozen direct target snapshot (values redacted)',
    ).toBe(true)
    expect(new Set(initialBatch.receipts.map((receipt) => receipt.delivery_id)).size).toBe(
      expectedTargets.length,
    )
    expect(new Set(initialBatch.receipts.map((receipt) => receipt.dedupe_key)).size).toBe(
      expectedTargets.length,
    )
    const initial = initialBatch.receipts[0]!
    for (const receipt of initialBatch.receipts) {
      expect(receipt.object_kind).toBe('grading_final_artifact')
      expect(receipt.object_id).toBe(initialBatch.object_id)
      expect(receipt.binding_id).toMatch(/^agent-rule:/)
      expect(
        receipt.external_message_id?.trim().length,
        'provider acceptance must return an external query key',
      ).toBeGreaterThan(0)
      expect(['sending', 'delivered', 'outcome_unknown']).toContain(receipt.status)
      expect(receipt.attempt).toBeGreaterThanOrEqual(1)
      expect(receipt.payload_digest).toBe(`sha256:${sha256Text(receipt.payload_json)}`)
      expect(receipt.dedupe_key).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect(receipt.payload_digest).toBe(initial.payload_digest)
      expect(sha256Text(receipt.render_manifest_json)).toBe(
        sha256Text(initial.render_manifest_json),
      )
    }

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

    const deliveredReceipts: DeliveryReceipt[] = []
    for (const initialReceipt of initialBatch.receipts) {
      const delivered = await convergeReceipt(request, agentName, initialReceipt)
      expect(delivered.delivery_id).toBe(initialReceipt.delivery_id)
      expect(delivered.status).toBe('delivered')
      expect(delivered.external_message_id).toBe(initialReceipt.external_message_id)
      expect(delivered.payload_digest).toBe(initialReceipt.payload_digest)
      deliveredReceipts.push(delivered)
    }

    // 同一个冻结成品身份必须命中同一批次与整组原回执，不能对任一目标产生第二条消息。
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
    expect(replayBatch.receipts).toHaveLength(expectedTargets.length)
    expect(
      sameTargetSnapshot(replayBatch.receipts.map(receiptTarget), expectedTargets),
      'replay Receipts must preserve the frozen target snapshot (values redacted)',
    ).toBe(true)
    const replayIdentity = replayBatch.receipts.map((receipt) => ({
      delivery_id: receipt.delivery_id,
      dedupe_key: receipt.dedupe_key,
      external_message_id: receipt.external_message_id,
      attempt: receipt.attempt,
    }))
    const deliveredIdentity = deliveredReceipts.map((receipt) => ({
      delivery_id: receipt.delivery_id,
      dedupe_key: receipt.dedupe_key,
      external_message_id: receipt.external_message_id,
      attempt: receipt.attempt,
    }))
    expect(
      JSON.stringify(replayIdentity) === JSON.stringify(deliveredIdentity),
      'idempotent replay must not start a second provider attempt (values redacted)',
    ).toBe(true)

    const durableBatch = await liveJSON<DeliveryBatch>(
      request,
      'GET',
      `/api/k12/delivery-batches/${encodeURIComponent(initialBatch.batch_id)}?agent=${encodeURIComponent(agentName)}`,
    )
    expect(durableBatch.status).toBe('delivered')
    expect(durableBatch.receipts).toHaveLength(expectedTargets.length)
    expect(
      sameTargetSnapshot(durableBatch.receipts.map(receiptTarget), expectedTargets),
      'durable Receipts must preserve the frozen target snapshot (values redacted)',
    ).toBe(true)
    for (const durable of durableBatch.receipts) {
      expect(durable.status).toBe('delivered')
      expect(durable.payload_digest).toBe(initial.payload_digest)
      expect(sha256Text(durable.payload_json)).toBe(sha256Text(initial.payload_json))
      expect(sha256Text(durable.render_manifest_json)).toBe(
        sha256Text(initial.render_manifest_json),
      )
    }

    await attachJSON(testInfo, 'dingtalk-receipt-evidence', {
      expected_target_count: expectedTargets.length,
      target_snapshot_sha256: sha256Text(JSON.stringify(expectedTargets)),
      receipts: durableBatch.receipts.map((receipt) => ({
        delivery_id_sha256: sha256Text(receipt.delivery_id),
        external_message_id_sha256: sha256Text(receipt.external_message_id ?? ''),
        binding_id_sha256: sha256Text(receipt.binding_id),
        target_sha256: sha256Text(
          `${receipt.target.platform}\0${receipt.target.instance_id ?? ''}\0${receipt.target.chat_id}`,
        ),
        payload_digest: receipt.payload_digest,
        status: receipt.status,
        attempt: receipt.attempt,
      })),
      object_id_sha256: sha256Text(initialBatch.object_id),
      final_artifact_id_sha256: sha256Text(artifactID),
      final_artifact_digest: artifactDigest,
      payload_digest: initial.payload_digest,
      source_digest: content.source_digest,
      render_id: manifest.render_id,
      renderer_version: manifest.renderer_version,
      capability_snapshot: manifest.capability_snapshot,
      fallback_reason: manifest.fallback_reason,
      status: durableBatch.status,
      batch_id_sha256: sha256Text(initialBatch.batch_id),
      idempotent_replay: true,
      real_client_visual_confirmation:
        'separate Android/iOS/Desktop DEVICE evidence; not claimed by this API receipt lane',
    })
  })
})
