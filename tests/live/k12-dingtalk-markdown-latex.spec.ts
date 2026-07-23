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

interface FrozenChannelMessage {
  Text?: string
  Content?: MessageContentEvidence
  RenderManifest?: RenderManifestEvidence
  Attachments?: unknown[] | null
}

function dingTalkBody(runID: string): string {
  return `## LIVE-DING-M01-M06-${runID}

**M01 基础 Markdown**与*强调*、~~删除线~~。

> 这是家长批准 direct 目标的发布验收消息。

1. 先读题
   - 再列式
2. 最后验算

- [x] 已核对题意
- [ ] 等待家长查看

---

### M02 结构化内容

| 来源 | 用途 |
| --- | --- |
| 教材第 42 页 | 分数加法 |
| 本次验算 | 核对答案 |

运行命令写作 \`pnpm test\`，来源链接为 [教育部](https://www.moe.gov.cn/)。

### M03 行内数学

行内分数 $\\frac{3}{4}$，长度 $12\\,\\mathrm{cm}$，角度 $60^{\\circ}$，乘法 $3\\times 4=12$。

### M04 块级数学

$$
\\frac{1}{2}+\\frac{1}{3}=\\frac{5}{6}
$$

### M05 混排教学回答

- 已知：两个异分母分数
- 思路：先通分
- 结论：$\\frac{5}{6}$
- 自检：$\\frac{5}{6}<1$

### M06 非数学 Markdown

作文观察：句子有具体动作；建议补充一种声音，不评分、不排名、不代写。`
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

test.describe.serial('LIVE K12 DingTalk Markdown/LaTeX receipt acceptance', () => {
  test.skip(
    blockers.length > 0,
    liveSkipReason(blockers, 'explicit real DingTalk direct authorization'),
  )

  test('M01..M06 freeze canonical source, readable math projection and one delivered idempotent Receipt', async ({
    page,
    request,
  }, testInfo: TestInfo) => {
    await assertLiveRuntime(page, request, testInfo)
    const instanceName = envValue('DINGTALK_LIVE_INSTANCE')
    const instanceID = envValue('DINGTALK_LIVE_INSTANCE_ID')
    const approvedUserID = envValue('DINGTALK_LIVE_USERID')
    const agentName = envValue('HEX_K12_LIVE_AGENT')

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

    const body = dingTalkBody(envValue('HEX_K12_LIVE_RUN_ID'))
    const initial = await liveJSON<DeliveryReceipt>(request, 'POST', '/api/k12/tutoring-tips/send', {
      agent: agentName,
      content: body,
    })
    expect(
      initial.agent_name === agentName,
      'Receipt owner must equal the gated K12 Agent (value redacted)',
    ).toBe(true)
    expect(initial.object_kind).toBe('tutoring_tips')
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
    expect(content.markdown).toBe(body)
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
    expect(projected).toContain(`LIVE-DING-M01-M06-${envValue('HEX_K12_LIVE_RUN_ID')}`)
    expect(projected).toContain('3/4')
    expect(projected).toContain('60°')
    expect(projected).toContain('3× 4=12')
    expect(projected).toContain('5/6')
    expect(projected).not.toMatch(/\\(?:frac|begin|mathrm|times|circ)\b|\$[^$\n]+\$|\$\$/)
    expect(
      projected,
      'readable channel projection must not leak LaTeX spacing commands',
    ).not.toContain('\\,')
    expect(
      payload.Attachments == null || payload.Attachments.length === 0,
      'message body, not an attachment, must carry M01..M06',
    ).toBe(true)

    const delivered = await convergeReceipt(request, agentName, initial)
    expect(delivered.delivery_id).toBe(initial.delivery_id)
    expect(delivered.status).toBe('delivered')
    expect(delivered.external_message_id).toBe(initial.external_message_id)
    expect(delivered.payload_digest).toBe(initial.payload_digest)

    // The same business object + canonical payload must resolve to the frozen
    // Receipt instead of producing a second real DingTalk message. This also
    // lets Chromium and WebKit share one approved external send per run ID.
    const replay = await liveJSON<DeliveryReceipt>(request, 'POST', '/api/k12/tutoring-tips/send', {
      agent: agentName,
      content: body,
    })
    expect(replay.delivery_id).toBe(delivered.delivery_id)
    expect(replay.dedupe_key).toBe(delivered.dedupe_key)
    expect(replay.external_message_id).toBe(delivered.external_message_id)
    expect(replay.attempt, 'idempotent replay must not start a second provider attempt').toBe(
      delivered.attempt,
    )

    const durable = await liveJSON<DeliveryReceipt>(
      request,
      'GET',
      `/api/k12/delivery-receipts/${encodeURIComponent(delivered.delivery_id)}?agent=${encodeURIComponent(agentName)}`,
    )
    expect(durable.status).toBe('delivered')
    expect(durable.payload_digest).toBe(initial.payload_digest)
    expect(durable.render_manifest_json).toBe(initial.render_manifest_json)

    await attachJSON(testInfo, 'dingtalk-receipt-evidence', {
      delivery_id_sha256: sha256Text(delivered.delivery_id),
      external_message_id_sha256: sha256Text(delivered.external_message_id ?? ''),
      target_sha256: sha256Text(`${delivered.target.instance_id}\0${delivered.target.chat_id}`),
      object_id_sha256: sha256Text(delivered.object_id),
      payload_digest: delivered.payload_digest,
      source_digest: content.source_digest,
      render_id: manifest.render_id,
      renderer_version: manifest.renderer_version,
      capability_snapshot: manifest.capability_snapshot,
      fallback_reason: manifest.fallback_reason,
      status: durable.status,
      attempt: durable.attempt,
      idempotent_replay: true,
      real_client_visual_confirmation:
        'separate Android/iOS/Desktop DEVICE evidence; not claimed by this API receipt lane',
    })
  })
})
