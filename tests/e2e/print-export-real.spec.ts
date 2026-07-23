import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import {
  assertLiveRuntime,
  cleanupLiveChild,
  liveGateBlockers,
  liveJSON,
  liveSkipReason,
} from '../live/k12-live-helpers'

/** DD-023A / UICLICK-EXPORT-20260719-001: Save PDF and native PrintJob are separate contracts. */
const blockers = liveGateBlockers({ isolatedProfile: true, model: true })
const DOCS_ROOT = process.env.HEXCLAW_DOCS_ROOT || '/Users/guoyanjun/work/hexclaw-docs'
const ART = {
  path: process.env.HEX_K12_ART_FIXTURE || resolve(DOCS_ROOT, 'test/k12-test-美术.png'),
  bytes: 2_713_090,
  sha256: '7eb16fdbe398236cdf2ce31ea6d2fac5e4787ea3004b96ab74a3eebd540f1d93',
}

type Json = Record<string, unknown>

function fileSHA(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function assertArtFixture(): void {
  expect(statSync(ART.path).isFile()).toBe(true)
  expect(statSync(ART.path).size).toBe(ART.bytes)
  expect(readFileSync(ART.path).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  expect(fileSHA(ART.path)).toBe(ART.sha256)
}

async function json(response: import('@playwright/test').APIResponse): Promise<Json> {
  const text = await response.text()
  expect(
    response.ok(),
    `${new URL(response.url()).pathname} => HTTP ${response.status()} (body redacted)`,
  ).toBe(true)
  return text ? (JSON.parse(text) as Json) : {}
}

async function createTutor(page: Page, childName: string): Promise<string> {
  await page.addInitScript(() => sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1'))
  await page.goto('/agents', { waitUntil: 'domcontentloaded' })
  const skip = page.getByRole('button', { name: '跳过' })
  if (await skip.isVisible().catch(() => false)) await skip.click()
  await page.getByText('模板库', { exact: false }).first().click()
  await page.getByText('作业辅导助手', { exact: false }).first().click()
  await page.locator('.k12pf__input').first().fill(childName)
  await page.locator('.k12pf .hc-select__trigger').nth(0).click()
  await page.locator('.hc-select__dropdown .hc-select__option', { hasText: '五年级' }).click()
  await page.locator('.k12pf .hc-select__trigger').nth(1).click()
  await page.locator('.hc-select__dropdown .hc-select__option', { hasText: '下学期' }).click()
  await page.getByRole('button', { name: '创建', exact: true }).click()
  await expect(page.locator('.k12pf')).toHaveCount(0, { timeout: 30_000 })
  const agents = await liveJSON<Json>(page.request, 'GET', '/api/v1/agents')
  const owner = (Array.isArray(agents.agents) ? (agents.agents as Json[]) : []).find(
    (agent) => (agent.metadata as Json | undefined)?.['k12.child_name'] === childName,
  )
  const agentID = String(owner?.name || '')
  expect(agentID).not.toBe('')
  await page.getByText('我的智能体', { exact: false }).first().click()
  const card = page.locator('.hc-cxcard', { hasText: childName })
  await expect(card).toBeVisible({ timeout: 30_000 })
  await card.getByRole('button', { name: /错题本|学习档案/ }).click()
  await expect(page.locator('.k12rec')).toBeVisible({ timeout: 30_000 })
  return agentID
}

async function createArtPracticeCard(
  page: Page,
  childName: string,
): Promise<{ agentID: string; recordID: string; title: string; cardText: string }> {
  assertArtFixture()
  const agentID = await createTutor(page, childName)
  await page.getByTestId('subtab-works').click()
  await page.getByTestId('cw-add-open').click()
  const dialog = page.getByTestId('cw-add-modal')
  await dialog.getByTestId('cw-add-type-art').click()
  const uploadResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname.endsWith('/api/v1/k12/assets'),
  )
  await dialog.getByTestId('cw-add-photo-input').setInputFiles(ART.path)
  expect(
    (await uploadResponse).ok(),
    'art fixture must be persisted by the real asset service',
  ).toBe(true)
  await expect(dialog.getByTestId('cw-photo-ok')).toBeVisible({ timeout: 120_000 })
  const title = `三档明暗-${Date.now().toString(36)}`
  await dialog.getByTestId('cw-add-title').fill(title)
  await dialog.getByTestId('cw-add-task').fill('观察画面中的明暗、颜色和主体关系')
  await dialog
    .getByTestId('cw-add-intent')
    .fill('用三档明暗重新画主体，保留彩虹、小猫和人物位置关系')
  const createResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname.endsWith('/api/v1/k12/creative-works'),
  )
  await dialog.getByTestId('cw-add-submit').click()
  const created = await createResponse
  expect(created.ok()).toBe(true)
  const createPayload = (await created.json()) as { record_id?: string }
  const recordID = createPayload.record_id || ''
  expect(recordID).not.toBe('')

  const work = page.locator('.k12cw__card').filter({ hasText: title })
  await expect(work).toBeVisible({ timeout: 60_000 })
  await work.getByTestId('cw-detail-toggle').click()
  const generate = work.getByTestId('cw-feedback-generate')
  await expect(generate).toBeVisible()
  const feedbackResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname.endsWith(
        `/api/v1/k12/creative-works/${recordID}/generate-feedback`,
      ),
  )
  await generate.click()
  expect(
    (await feedbackResponse).ok(),
    'practice card must come from real evidence-grounded feedback',
  ).toBe(true)
  const practiceCard = work.getByTestId('cw-practice-card')
  await expect(practiceCard).toBeVisible({ timeout: 5 * 60_000 })
  const cardText = (await practiceCard.locator('.k12cw__pcardtext').innerText()).trim()
  expect(cardText.length).toBeGreaterThan(20)
  expect(cardText).toMatch(/明暗|颜色|主体|观察/)
  return { agentID, recordID, title, cardText }
}

async function creativeWork(
  request: APIRequestContext,
  agentID: string,
  recordID: string,
): Promise<Json> {
  return liveJSON<Json>(
    request,
    'GET',
    `/api/v1/k12/creative-works/${encodeURIComponent(recordID)}?agent=${encodeURIComponent(agentID)}`,
  )
}

test('XPORT-ART-001 immutable art source retains frozen PNG bytes and SHA', () => {
  assertArtFixture()
})

test.describe.serial('real observation-card PDF artifact', () => {
  test.setTimeout(12 * 60_000)
  test.skip(
    blockers.length > 0,
    liveSkipReason(blockers, 'installed RC + isolated profile + authorized real visual model'),
  )

  let childName = ''

  test.beforeEach(async ({ page, request }, testInfo) => {
    await assertLiveRuntime(page, request, testInfo)
  })

  test.afterEach(async ({ request }) => {
    try {
      await cleanupLiveChild(request, childName)
    } finally {
      childName = ''
      assertArtFixture()
    }
  })

  test('works card saves a real openable PDF and close/cancel has zero business side effects', async ({
    page,
    request,
  }) => {
    childName = `打印作品${Date.now().toString(36)}`
    const created = await createArtPracticeCard(page, childName)
    const work = page.locator('.k12cw__card').filter({ hasText: created.title })
    const before = await creativeWork(request, created.agentID, created.recordID)
    const renderRequestPromise = page.waitForRequest(
      (req) => req.method() === 'POST' && new URL(req.url()).pathname.endsWith('/api/v1/render'),
    )
    const downloadPromise = page.waitForEvent('download')
    await work.getByTestId('cw-card-save-pdf').click()
    const [renderRequest, download] = await Promise.all([renderRequestPromise, downloadPromise])
    const renderPayload = renderRequest.postDataJSON() as {
      content?: string
      format?: string
      title?: string
    }
    expect(renderPayload.format).toBe('pdf')
    expect(renderPayload.content).toContain(created.cardText)
    expect(renderPayload.title).toContain(created.title)
    const renderResponse = await renderRequest.response()
    expect(renderResponse?.ok()).toBe(true)
    expect((await renderResponse!.headerValue('content-type')) || '').toContain('application/pdf')

    expect(download.suggestedFilename()).toMatch(/\.pdf$/)
    expect(download.suggestedFilename()).not.toMatch(/\.html$/)
    const path = await download.path()
    expect(path, 'Save PDF must create a physical artifact').toBeTruthy()
    const bytes = readFileSync(path!)
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-')
    expect(bytes.length).toBeGreaterThan(1_000)
    const info = execFileSync('pdfinfo', [path!], { encoding: 'utf8' })
    expect(info).toMatch(/^Pages:\s*[1-9]\d*$/m)
    expect(info).toMatch(/^Page size:\s+.*A4/m)
    const text = execFileSync('pdftotext', [path!, '-'], { encoding: 'utf8' })
    expect(text).toContain('观察练习卡')
    expect(text).toContain(created.title)

    const requestsBeforeClose = page.context().pages().length
    await work.getByTestId('cw-detail-toggle').click()
    await expect(work.getByTestId('cw-practice-card')).toBeHidden()
    expect(
      page.context().pages().length,
      'closing inline details must not open a fake artifact window',
    ).toBe(requestsBeforeClose)
    expect(
      await creativeWork(request, created.agentID, created.recordID),
      'close/cancel must not mutate CreativeWork',
    ).toEqual(before)
  })
})

test.describe.serial('packaged Desktop native Save/Print dialogs', () => {
  test.setTimeout(12 * 60_000)
  test.skip(
    blockers.length > 0,
    liveSkipReason(blockers, 'installed RC + isolated profile + authorized real visual model'),
  )

  let childName = ''

  test.beforeEach(async ({ page, request }, testInfo) => {
    await assertLiveRuntime(page, request, testInfo)
  })

  test.afterEach(async ({ request }) => {
    try {
      await cleanupLiveChild(request, childName)
    } finally {
      childName = ''
      assertArtFixture()
    }
  })

  test('Save cancel writes no file; native Print cancel is retryable; submit returns one OS receipt', async ({
    page,
    request,
  }) => {
    const driver = process.env.HEX_K12_NATIVE_DIALOG_DRIVER_URL?.replace(/\/$/, '')
    test.skip(
      !driver,
      'NOT RUN: requires HEX_K12_NATIVE_DIALOG_DRIVER_URL controlling the packaged app OS Save/Print dialogs',
    )
    childName = `原生打印${Date.now().toString(36)}`
    const created = await createArtPracticeCard(page, childName)
    const work = page.locator('.k12cw__card').filter({ hasText: created.title })
    const cardDigest = createHash('sha256').update(created.cardText).digest('hex')
    const before = await creativeWork(request, created.agentID, created.recordID)

    let armed = await request.post(`${driver}/v1/dialogs/arm`, {
      data: { kind: 'save', outcome: 'cancel', expected_content_digest: cardDigest },
    })
    expect(armed.ok(), `POST /v1/dialogs/arm => HTTP ${armed.status()} (body redacted)`).toBe(true)
    await work.getByTestId('cw-card-save-pdf').click()
    let event = await json(
      await request.get(`${driver}/v1/dialogs/next?kind=save&timeout_ms=30000`),
    )
    expect(event).toMatchObject({ kind: 'save', outcome: 'cancelled', files_written: 0 })
    expect(event.content_digest).toBe(cardDigest)
    expect(await creativeWork(request, created.agentID, created.recordID)).toEqual(before)

    armed = await request.post(`${driver}/v1/dialogs/arm`, {
      data: { kind: 'print', outcome: 'cancel', expected_content_digest: cardDigest },
    })
    expect(armed.ok(), `POST /v1/dialogs/arm => HTTP ${armed.status()} (body redacted)`).toBe(true)
    await work.getByTestId('cw-card-print').click()
    event = await json(await request.get(`${driver}/v1/dialogs/next?kind=print&timeout_ms=30000`))
    expect(event).toMatchObject({
      kind: 'print',
      dialog_seen: true,
      outcome: 'cancelled',
      jobs_submitted: 0,
    })
    expect(event.content_digest).toBe(cardDigest)
    await expect(
      work.getByTestId('cw-card-print-error'),
      'native cancellation must not be reported as success',
    ).toBeVisible()
    await expect(work.getByTestId('cw-card-print-retry')).toBeVisible()
    expect(await creativeWork(request, created.agentID, created.recordID)).toEqual(before)

    armed = await request.post(`${driver}/v1/dialogs/arm`, {
      data: { kind: 'print', outcome: 'submit', expected_content_digest: cardDigest },
    })
    expect(armed.ok(), `POST /v1/dialogs/arm => HTTP ${armed.status()} (body redacted)`).toBe(true)
    await work.getByTestId('cw-card-print-retry').click()
    event = await json(await request.get(`${driver}/v1/dialogs/next?kind=print&timeout_ms=30000`))
    expect(event).toMatchObject({
      kind: 'print',
      dialog_seen: true,
      outcome: 'submitted',
      jobs_submitted: 1,
    })
    expect(
      String(event.os_receipt_id || ''),
      'native PrintJob needs an OS/driver receipt',
    ).not.toBe('')
    expect(event.content_digest).toBe(cardDigest)
    await expect(work.getByTestId('cw-card-print-error')).toHaveCount(0)
  })
})
