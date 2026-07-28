import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test, type APIRequestContext } from '@playwright/test'

import { BASE_URL, e2eMarker } from './helpers'

const OWNER = 'desktop-user'
const agentName = e2eMarker('k12-webhook-agent')
const learnerID = e2eMarker('k12-webhook-learner')
const bindingName = e2eMarker('k12-webhook-binding')
let secret = ''

type Receipt = {
  receipt_id: string
  status: 'accepted' | 'processing' | 'succeeded' | 'failed' | 'outcome_unknown' | 'rejected'
  job_or_execution_ref?: string
  retryable: boolean
  attempt_count: number
}

async function jsonRequest<T>(
  request: APIRequestContext,
  method: string,
  path: string,
  data?: Record<string, unknown>,
): Promise<T> {
  const response = await request.fetch(`${BASE_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    data,
  })
  const body = await response.text()
  expect(response.ok(), `${method} ${path}: ${response.status()} ${body}`).toBe(true)
  return (body ? JSON.parse(body) : {}) as T
}

async function sendSignedSubmission(
  request: APIRequestContext,
  eventID: string,
  payload: Record<string, unknown>,
): Promise<Receipt> {
  const raw = JSON.stringify({
    event_id: eventID,
    event_type: 'k12.submission.requested.v1',
    payload,
  })
  const timestamp = new Date().toISOString()
  const nonce = e2eMarker('nonce')
  const signature = `sha256=${createHmac('sha256', secret).update(timestamp).update(nonce).update(raw).digest('hex')}`
  const response = await request.fetch(
    `${BASE_URL}/api/v1/webhooks/${encodeURIComponent(bindingName)}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-HexClaw-Timestamp': timestamp,
        'X-HexClaw-Nonce': nonce,
        'X-HexClaw-Signature': signature,
      },
      data: raw,
    },
  )
  const body = await response.text()
  expect(response.status(), body).toBe(202)
  return (JSON.parse(body) as { receipt: Receipt }).receipt
}

async function receiptByID(request: APIRequestContext, receiptID: string): Promise<Receipt> {
  const result = await jsonRequest<{ receipt: Receipt }>(
    request,
    'GET',
    `/api/v1/webhooks?user_id=${OWNER}&agent_id=${encodeURIComponent(agentName)}&receipt_id=${encodeURIComponent(receiptID)}`,
  )
  return result.receipt
}

async function waitForReceipt(
  request: APIRequestContext,
  receiptID: string,
  wanted: Receipt['status'],
): Promise<Receipt> {
  let last: Receipt | undefined
  await expect
    .poll(
      async () => {
        last = await receiptByID(request, receiptID)
        return last.status
      },
      { timeout: 180_000, intervals: [100, 250, 500, 1_000] },
    )
    .toBe(wanted)
  return last!
}

test.describe.serial('Desktop + real Sidecar signed K12 webhook lane', () => {
  test.setTimeout(300_000)

  test.beforeAll(async ({ request }) => {
    await jsonRequest(request, 'POST', '/api/v1/agents', {
      name: agentName,
      display_name: 'Webhook E2E Tutor',
      provider: 'mock-openai',
      model: 'mock-model',
      metadata: {
        scenario: 'k12-tutor',
        'k12.learner_id': learnerID,
        'k12.child_name': 'Webhook E2E',
        'k12.grade_term': '六年级上',
      },
    })
    const created = await jsonRequest<{ secret: string }>(request, 'POST', '/api/v1/webhooks', {
      name: bindingName,
      type: 'k12',
      agent_id: agentName,
      learner_id: learnerID,
      allowed_events: ['k12.submission.requested.v1'],
      user_id: OWNER,
      enabled: false,
    })
    secret = created.secret
    expect(secret).toMatch(/^whs_k12_/)
    await jsonRequest(
      request,
      'PATCH',
      `/api/v1/webhooks/${encodeURIComponent(bindingName)}?user_id=${OWNER}&agent_id=${encodeURIComponent(agentName)}`,
      { enabled: true },
    )
  })

  test.afterAll(async ({ request }) => {
    if (bindingName) {
      await request.delete(
        `${BASE_URL}/api/v1/webhooks/${encodeURIComponent(bindingName)}?user_id=${OWNER}&agent_id=${encodeURIComponent(agentName)}`,
      )
    }
    await request.delete(`${BASE_URL}/api/v1/agents/${encodeURIComponent(agentName)}`)
  })

  test('signed text → Receipt poll → internal grading reference without public route', async ({
    request,
  }) => {
    const accepted = await sendSignedSubmission(request, e2eMarker('text-event'), {
      text: '6 × 7 =',
      subject: '数学',
      grade: '六年级上',
      source_session: 'webhook-e2e-text',
    })
    const delivered = await waitForReceipt(request, accepted.receipt_id, 'succeeded')
    expect(delivered.attempt_count).toBe(1)
    expect(delivered.retryable).toBe(false)
    expect(delivered.job_or_execution_ref).toMatch(/^grading_job:/)

    const jobID = delivered.job_or_execution_ref!.replace(/^grading_job:/, '')
    const removedPublicRoute = await request.get(
      `${BASE_URL}/api/k12/grading-jobs/${encodeURIComponent(jobID)}?agent=${encodeURIComponent(agentName)}`,
    )
    expect([404, 405]).toContain(removedPublicRoute.status())
  })

  test('real non-1x1 fixture upload → signed image event → Receipt/image-task poll → Desktop history', async ({
    page,
    request,
  }) => {
    const fixture = Buffer.from(
      readFileSync(resolve('tests/fixtures/k12/webhook-homework-16x12.png.base64'), 'utf8').trim(),
      'base64',
    )
    expect(fixture.subarray(1, 4).toString('ascii')).toBe('PNG')
    expect(fixture.readUInt32BE(16)).toBe(16)
    expect(fixture.readUInt32BE(20)).toBe(12)
    const uploaded = await jsonRequest<{ asset_id: string; size: number }>(
      request,
      'POST',
      '/api/k12/assets',
      { agent: agentName, data_base64: fixture.toString('base64') },
    )
    expect(uploaded.size).toBe(fixture.length)
    expect(uploaded.asset_id).toMatch(/^asset:\/\//)

    const accepted = await sendSignedSubmission(request, e2eMarker('image-event'), {
      asset_refs: [uploaded.asset_id],
      subject: '数学',
      grade: '六年级上',
      source_session: 'webhook-e2e-image',
    })
    const delivered = await waitForReceipt(request, accepted.receipt_id, 'succeeded')
    expect(delivered.job_or_execution_ref).toMatch(/^image_task:/)

    await page.addInitScript(() => sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1'))
    await page.goto('/automation/webhooks', { waitUntil: 'domcontentloaded' })
    // K12 Webhook 是场景页的直接可见面板；旧的额外展开开关已按原型移除。
    await expect(page.getByTestId('k12-webhook-panel')).toBeVisible()
    const agentSelector = page.getByRole('combobox', { name: '孩子 / 辅导实例' })
    if (!(await agentSelector.textContent())?.includes('Webhook E2E')) {
      const scopedBindingResponse = page.waitForResponse((response) => {
        const url = new URL(response.url())
        return (
          response.request().method() === 'GET' &&
          url.pathname.endsWith('/api/v1/webhooks') &&
          url.searchParams.get('agent_id') === agentName &&
          response.ok()
        )
      })
      await agentSelector.click()
      await page.getByRole('option', { name: 'Webhook E2E', exact: true }).click()
      await scopedBindingResponse
    }
    await expect(agentSelector).toContainText('Webhook E2E')
    await expect(page.getByTestId(`k12-webhook-row-${bindingName}`)).toBeVisible({
      timeout: 30_000,
    })
    await page.getByTestId(`k12-webhook-history-${bindingName}`).click()
    await expect(page.getByTestId('k12-webhook-panel')).toContainText(
      delivered.job_or_execution_ref!,
      {
        timeout: 30_000,
      },
    )
  })
})
