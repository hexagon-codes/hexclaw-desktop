import { expect, test } from '@playwright/test'
import { e2eMarker } from './helpers'

const required = {
  send: process.env.DINGTALK_LIVE_SEND,
  confirm: process.env.DINGTALK_LIVE_CONFIRM,
  instance: process.env.DINGTALK_LIVE_INSTANCE,
  userID: process.env.DINGTALK_LIVE_USERID,
}
const ready =
  required.send === '1' &&
  required.confirm === 'SEND_TO_EXPLICIT_DINGTALK_USER' &&
  Boolean(required.instance?.trim()) &&
  Boolean(required.userID?.trim())

test('LIVE K12/DingTalk canary is BLOCKED without explicit real-device credentials', async ({
  request,
}) => {
  test.skip(
    !ready,
    'BLOCKED: requires DINGTALK_LIVE_SEND=1, DINGTALK_LIVE_CONFIRM=SEND_TO_EXPLICIT_DINGTALK_USER, DINGTALK_LIVE_INSTANCE and DINGTALK_LIVE_USERID; synthetic credentials are not a live PASS',
  )

  const list = await request.get('/_hexclaw/api/v1/platforms/instances')
  expect(list.ok(), await list.text()).toBe(true)
  const payload = (await list.json()) as {
    instances?: Array<{ id: string; name: string; provider: string; enabled: boolean }>
  }
  const instance = payload.instances?.find(
    (item) => item.provider === 'dingtalk' && item.name === required.instance,
  )
  expect(instance, `explicit DingTalk instance ${required.instance} must exist`).toBeTruthy()
  expect(instance!.enabled).toBe(true)

  const sent = await request.post(
    `/_hexclaw/api/v1/platforms/instances/by-id/${encodeURIComponent(instance!.id)}/send-test`,
    {
      data: {
        target: required.userID,
        content: `HexClaw K12 live canary ${e2eMarker('dingtalk')}`,
      },
    },
  )
  expect(sent.ok(), await sent.text()).toBe(true)
  const result = (await sent.json()) as { success?: boolean; message?: string }
  expect(result.success, result.message).toBe(true)
})
