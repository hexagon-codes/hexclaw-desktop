import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { isAbsolute, resolve } from 'node:path'
import { expect, test, type APIResponse, type Page, type TestInfo } from '@playwright/test'
import { BASE_URL, e2eMarker } from './helpers'
import { cleanupK12Child } from './live-fixture-cleanup'

/** REG-UPLOAD/WRITING/ART + INT/E2E-CREATIVE real-source release gate. */
const LIVE = process.env.HEX_K12_ACCEPTANCE_LIVE === '1'
const LIVE_AI =
  LIVE && process.env.HEX_K12_REAL_MODEL === '1' && process.env.HEX_K12_CREATIVE_AI === '1'
const EXPECTED_PROVIDER = process.env.HEX_E2E_PROVIDER?.trim() || 'hexclaw-gpt'
const EXPECTED_MODEL = process.env.HEX_E2E_MODEL?.trim() || 'gpt-5.6-sol'
const DOCS_ROOT = process.env.HEXCLAW_DOCS_ROOT || resolve(process.cwd(), '../hexclaw-docs')
// 主动删除夹具只读取父级运行器创建的隔离 Sidecar store，禁止从测试路径猜测。
const LOCAL_SIDECAR_DATABASE = process.env.HEX_K12_LIVE_FIXTURE_STORE?.trim() || ''
const FIXTURES = {
  writing: {
    id: 'FX-WRITING-001',
    path: process.env.HEX_K12_WRITING_IMAGE || resolve(DOCS_ROOT, 'test/k12-test-作文.png'),
    sha256: '3b238c46e0ae4515f7b35a28bcfd37081ba1d59a9dfa2b30bf17784aaf3e9157',
    bytes: 2_509_035,
    width: 1086,
    height: 1448,
  },
  art: {
    id: 'FX-ART-001',
    path: process.env.HEX_K12_ART_IMAGE || resolve(DOCS_ROOT, 'test/k12-test-美术.png'),
    sha256: '7eb16fdbe398236cdf2ce31ea6d2fac5e4787ea3004b96ab74a3eebd540f1d93',
    bytes: 2_713_090,
    width: 1254,
    height: 1254,
  },
} as const

type Fixture = (typeof FIXTURES)[keyof typeof FIXTURES]
type Json = Record<string, unknown>
type ActiveDeleteCounts = {
  agent_rows: number
  creative_work_rows: number
  feedback_generation_rows: number
  image_task_invocation_rows: number
  image_task_dispatch_rows: number
  creative_intake_rows: number
  current_create_receipt_rows: number
  agent_rule_rows: number
}

const ACTIVE_DELETE_RECEIPT = 'active-delete-receipt.json'
const ACTIVE_DELETE_OBSERVATION_MS = 500

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function activeDeleteCounts(database: DatabaseSync, agent: string): ActiveDeleteCounts {
  const row = database
    .prepare(
      `SELECT
      (SELECT COUNT(*) FROM agents WHERE name=?1) AS agent_rows,
      (SELECT COUNT(*) FROM k12_creative_works WHERE agent_name=?1) AS creative_work_rows,
      (SELECT COUNT(*) FROM k12_work_feedback_generations WHERE agent_name=?1)
        AS feedback_generation_rows,
      (SELECT COUNT(*) FROM k12_image_task_invocations WHERE agent_name=?1)
        AS image_task_invocation_rows,
      (SELECT COUNT(*) FROM k12_image_task_dispatches WHERE agent_name=?1)
        AS image_task_dispatch_rows,
      (SELECT COUNT(*) FROM k12_creative_work_intakes WHERE agent_name=?1)
        AS creative_intake_rows,
      (SELECT COUNT(*) FROM k12_current_create_receipts WHERE agent_name=?1)
        AS current_create_receipt_rows,
      (SELECT COUNT(*) FROM agent_rules WHERE agent_name=?1) AS agent_rule_rows`,
    )
    .get(agent) as ActiveDeleteCounts
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, Number(value)]),
  ) as ActiveDeleteCounts
}

function assertDeletedExactSet(counts: ActiveDeleteCounts) {
  expect(counts).toEqual({
    agent_rows: 0,
    creative_work_rows: 0,
    feedback_generation_rows: 0,
    image_task_invocation_rows: 0,
    image_task_dispatch_rows: 0,
    creative_intake_rows: 0,
    current_create_receipt_rows: 0,
    agent_rule_rows: 0,
  })
}

async function waitForSentWorkFeedbackInvocation(
  databasePath: string,
  agent: string,
  timeoutMS = 6 * 60_000,
) {
  expect(statSync(databasePath).isFile(), 'active-delete store must be a regular file').toBe(true)
  const database = new DatabaseSync(databasePath, { readOnly: true })
  database.exec('PRAGMA busy_timeout=2000')
  const invocation = database.prepare(`SELECT invocation_id,status,attempt,provider_request_key,
      route_snapshot_json
    FROM k12_image_task_invocations
    WHERE agent_name=? AND operation='work_feedback'
    ORDER BY created_at DESC,invocation_id DESC LIMIT 1`)
  const providerCalls = database.prepare(`SELECT COUNT(*) AS count
    FROM k12_image_task_invocations
    WHERE agent_name=? AND operation='work_feedback' AND provider_request_key<>''`)
  const deadline = Date.now() + timeoutMS
  try {
    while (Date.now() < deadline) {
      const row = invocation.get(agent) as
        | {
            invocation_id: string
            status: string
            attempt: number
            provider_request_key: string
            route_snapshot_json: string
          }
        | undefined
      if (row?.status === 'sent') {
        const count = Number((providerCalls.get(agent) as { count: number }).count)
        const counts = activeDeleteCounts(database, agent)
        expect(count, 'active-delete must observe exactly one physical Provider send').toBe(1)
        expect(row.attempt).toBe(1)
        expect(row.provider_request_key).not.toBe('')
        const routeSnapshot = JSON.parse(row.route_snapshot_json) as {
          provider?: string
          model?: string
          provider_instance_id?: string
          config_fingerprint?: string
          capability_receipt_digest?: string
          probe_policy_version?: string
        }
        expect(routeSnapshot.provider).toBe(EXPECTED_PROVIDER)
        expect(routeSnapshot.model).toBe(EXPECTED_MODEL)
        expect(routeSnapshot.provider_instance_id).toBeTruthy()
        expect(routeSnapshot.config_fingerprint).toMatch(/^[a-f0-9]{64}$/)
        expect(routeSnapshot.capability_receipt_digest).toMatch(/^[a-f0-9]{64}$/)
        expect(routeSnapshot.probe_policy_version).toBe('v4')
        expect(counts.agent_rows).toBe(1)
        expect(counts.creative_work_rows).toBe(1)
        expect(counts.feedback_generation_rows).toBe(1)
        expect(counts.image_task_invocation_rows).toBe(1)
        return {
          invocation_status: 'sent' as const,
          invocation_id_sha256: sha256(Buffer.from(row.invocation_id)),
          provider_request_key_sha256: sha256(Buffer.from(row.provider_request_key)),
          route_provider: routeSnapshot.provider,
          route_model: routeSnapshot.model,
          provider_instance_id_sha256: sha256(Buffer.from(routeSnapshot.provider_instance_id!)),
          config_fingerprint: routeSnapshot.config_fingerprint,
          capability_receipt_digest: routeSnapshot.capability_receipt_digest,
          probe_policy_version: routeSnapshot.probe_policy_version,
          attempt: row.attempt,
          provider_call_rows: count,
          target_rows: counts,
        }
      }
      if (row && ['succeeded', 'failed', 'outcome_unknown', 'reconciled'].includes(row.status)) {
        throw new Error(`active-delete missed durable sent boundary; terminal=${row.status}`)
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
    }
    throw new Error('active-delete timed out waiting for durable work_feedback sent receipt')
  } finally {
    database.close()
  }
}

function readActiveDeleteCounts(databasePath: string, agent: string): ActiveDeleteCounts {
  const database = new DatabaseSync(databasePath, { readOnly: true })
  database.exec('PRAGMA busy_timeout=2000')
  try {
    return activeDeleteCounts(database, agent)
  } finally {
    database.close()
  }
}

function verifyFixture(fixture: Fixture): Buffer {
  const bytes = readFileSync(fixture.path)
  expect(statSync(fixture.path).isFile()).toBe(true)
  expect(bytes.length, `${fixture.id} byte count drift`).toBe(fixture.bytes)
  expect(sha256(bytes), `${fixture.id} SHA drift`).toBe(fixture.sha256)
  expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  expect({ width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }).toEqual({
    width: fixture.width,
    height: fixture.height,
  })
  return bytes
}

async function json<T>(response: APIResponse): Promise<T> {
  const text = await response.text()
  expect(
    response.ok(),
    `${new URL(response.url()).pathname} => ${response.status()} (body redacted)`,
  ).toBe(true)
  return JSON.parse(text) as T
}

async function createTutorAndOpenWorks(page: Page, childName: string): Promise<string> {
  await page.addInitScript(() => sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1'))
  await page.goto('/agents', { waitUntil: 'domcontentloaded' })
  const skip = page.getByRole('button', { name: '跳过' })
  if (await skip.isVisible().catch(() => false)) await skip.click()
  await page.getByText('模板库', { exact: false }).first().click()
  await page.getByText('作业辅导助手', { exact: false }).first().click()
  const dialog = page.getByRole('dialog')
  await dialog.locator('.k12pf__input').fill(childName)
  await dialog.locator('.hc-select__trigger').nth(0).click()
  await page.locator('.hc-select__dropdown .hc-select__option', { hasText: '五年级' }).click()
  await dialog.locator('.hc-select__trigger').nth(1).click()
  await page.locator('.hc-select__dropdown .hc-select__option', { hasText: '下学期' }).click()
  await dialog.getByRole('button', { name: '创建', exact: true }).click()
  await expect(dialog).toHaveCount(0, { timeout: 30_000 })

  const agents = await json<{
    agents?: Array<{ name?: string; metadata?: Record<string, string> }>
  }>(await page.request.get('/_hexclaw/api/v1/agents'))
  const matches = (agents.agents || []).filter(
    (agent) => agent.metadata?.['k12.child_name'] === childName,
  )
  expect(matches).toHaveLength(1)
  const owner = matches[0]!.name!

  await page.getByText('我的智能体', { exact: false }).first().click()
  const card = page.locator('.hc-cxcard', { hasText: childName })
  await card.getByRole('button', { name: /错题本|学习档案/ }).click()
  await expect(page.locator('.k12rec')).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('subtab-works').click()
  await expect(page.getByTestId('works-section')).toBeVisible()
  return owner
}

async function openAddWork(page: Page, type: 'writing' | 'art') {
  await page.getByTestId('cw-add-open').click()
  const modal = page.getByTestId('cw-add-modal')
  await expect(modal).toBeVisible()
  await modal.getByTestId(type === 'writing' ? 'cw-add-type-writing' : 'cw-add-type-art').click()
  return modal
}

async function uploadWorkPhoto(page: Page, fixture: Fixture): Promise<string> {
  const source = verifyFixture(fixture)
  const uploadResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname.endsWith('/api/k12/assets'),
  )
  await page.getByTestId('cw-add-photo-input').setInputFiles(fixture.path)
  const response = await uploadResponse
  const payload = await json<{ asset_id: string; size: number }>(response)
  expect(payload.size).toBe(source.length)
  expect(payload.asset_id).toContain(fixture.sha256)
  await expect(
    page.getByTestId('cw-photo-ok'),
    'upload success must come from a server-confirmed asset id',
  ).toBeVisible()
  return payload.asset_id
}

async function listWorks(page: Page, owner: string): Promise<Json[]> {
  const response = await page.request.get(
    `${BASE_URL}/api/k12/creative-works?agent=${encodeURIComponent(owner)}`,
  )
  return (await json<{ items?: Json[] }>(response)).items || []
}

function feedbackPayload(work: Json | undefined): Json | undefined {
  const generation = (work?.latest_feedback ??
    work?.latest_feedback_generation ??
    work?.initial_feedback ??
    work?.initial_feedback_generation) as Json | undefined
  return generation?.feedback as Json | undefined
}

test('§1.2 creative manifest freezes writing and art source bytes', () => {
  const missing = Object.values(FIXTURES)
    .filter((fixture) => !existsSync(fixture.path))
    .map((fixture) => fixture.id)
  test.skip(missing.length > 0, `NOT RUN: private fixture(s) absent: ${missing.join(', ')}`)
  for (const fixture of Object.values(FIXTURES)) verifyFixture(fixture)
})

test('creative active-delete fixture requires its explicit isolated sidecar database', () => {
  test.skip(!LIVE, 'NOT RUN: the isolated Sidecar store is parent-owned')
  expect(LOCAL_SIDECAR_DATABASE).not.toBe('')
  expect(isAbsolute(LOCAL_SIDECAR_DATABASE)).toBe(true)
  expect(statSync(LOCAL_SIDECAR_DATABASE).isFile()).toBe(true)
})

test.describe('real creative source, OCR, owner and feedback', () => {
  test.setTimeout(15 * 60_000)
  test.skip(
    !LIVE,
    'NOT RUN: set HEX_K12_ACCEPTANCE_LIVE=1 for an isolated current-source Desktop + sidecar',
  )
  let childName = ''
  test.afterEach(async ({ request }) => {
    await cleanupK12Child(request, childName)
    childName = ''
    for (const fixture of Object.values(FIXTURES)) verifyFixture(fixture)
  })

  test('art upload stores the frozen image under the exact Tutor owner and round-trips its bytes', async ({
    page,
  }, testInfo: TestInfo) => {
    childName = `美术原图-${e2eMarker('child')}`
    const owner = await createTutorAndOpenWorks(page, childName)
    const modal = await openAddWork(page, 'art')
    await expect(
      modal.getByTestId('cw-add-submit'),
      'art cannot be saved before a real image is selected',
    ).toBeDisabled()
    const assetID = await uploadWorkPhoto(page, FIXTURES.art)
    expect(assetID).toMatch(new RegExp(`^asset://${owner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`))
    const assetFile = assetID.slice(assetID.lastIndexOf('/') + 1)
    const storedAsset = await page.request.get(
      `${BASE_URL}/api/k12/assets/${encodeURIComponent(assetFile)}?agent=${encodeURIComponent(owner)}`,
    )
    expect(storedAsset.status()).toBe(200)
    expect(sha256(Buffer.from(await storedAsset.body()))).toBe(FIXTURES.art.sha256)
    const title = `彩虹女孩-${e2eMarker('work')}`
    await modal.getByTestId('cw-add-title').fill(title)
    await expect(modal.getByTestId('cw-add-task')).toHaveCount(0)
    await expect(modal.getByTestId('cw-add-intent')).toHaveCount(0)
    await expect(modal.getByTestId('cw-add-submit')).toBeEnabled()
    const activeDelete = testInfo.project.name === 'system-chrome'
    const databasePath = LOCAL_SIDECAR_DATABASE
    const sentReceipt = activeDelete
      ? waitForSentWorkFeedbackInvocation(databasePath, owner)
      : undefined
    await modal.getByTestId('cw-add-submit').click()
    await expect(modal).toHaveCount(0, { timeout: 30_000 })

    if (sentReceipt) {
      const beforeDelete = await sentReceipt
      const deleted = await page.request.delete(
        `/_hexclaw/api/v1/agents/${encodeURIComponent(owner)}`,
      )
      expect(deleted.status()).toBe(200)
      const afterDelete = readActiveDeleteCounts(databasePath, owner)
      assertDeletedExactSet(afterDelete)
      await new Promise((resolvePromise) =>
        setTimeout(resolvePromise, ACTIVE_DELETE_OBSERVATION_MS),
      )
      const afterObservation = readActiveDeleteCounts(databasePath, owner)
      assertDeletedExactSet(afterObservation)

      const agents = await json<{
        agents?: Array<{ name?: string }>
      }>(await page.request.get('/_hexclaw/api/v1/agents'))
      expect((agents.agents || []).filter(({ name }) => name === owner)).toHaveLength(0)
      expect(await listWorks(page, owner)).toHaveLength(0)
      const deletedAsset = await page.request.get(
        `${BASE_URL}/api/k12/assets/${encodeURIComponent(assetFile)}?agent=${encodeURIComponent(owner)}`,
      )
      expect(deletedAsset.status()).toBe(404)

      const receipt = {
        schema_version: 1,
        transition: ['sent', 'delete_200', 'cascade_zero'],
        before_delete: beforeDelete,
        delete_http_status: 200,
        after_delete: {
          first_snapshot: afterDelete,
          observation_ms: ACTIVE_DELETE_OBSERVATION_MS,
          second_snapshot: afterObservation,
          agent_api_rows: 0,
          creative_work_api_rows: 0,
          asset_http_status: 404,
        },
        dingtalk_sends: 0,
      }
      const receiptPath = testInfo.outputPath(ACTIVE_DELETE_RECEIPT)
      writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
        mode: 0o600,
        flag: 'wx',
      })
      await testInfo.attach('K12 creative active-delete receipt', {
        path: receiptPath,
        contentType: 'application/json',
      })
      return
    }

    const work = (await listWorks(page, owner)).find((item) => item.work_title === title)
    expect(work, 'visible save must create a sidecar CreativeWork').toBeTruthy()
    expect(work?.work_type).toBe('art')
    expect(work?.source_asset_id).toBe(assetID)
    expect(work?.versions).toBeUndefined()

    const thumb = page.getByTestId('cw-thumb').first()
    await expect(thumb).toBeVisible()
    const src = await thumb.getAttribute('src')
    expect(src).toBeTruthy()
    // 缩略图使用浏览器 Blob URL；应在页面上下文读取并校验原始字节，不能交给 HTTP 客户端。
    const rendered = await page.evaluate(async (url) => {
      const response = await fetch(url)
      const bytes = await response.arrayBuffer()
      const digest = await crypto.subtle.digest('SHA-256', bytes)
      return {
        bytes: bytes.byteLength,
        sha256: Array.from(new Uint8Array(digest), (value) =>
          value.toString(16).padStart(2, '0'),
        ).join(''),
      }
    }, src!)
    expect(rendered, 'rendered thumbnail must return the immutable original bytes').toEqual({
      bytes: FIXTURES.art.bytes,
      sha256: FIXTURES.art.sha256,
    })
    await expect(page.getByTestId('works-section')).not.toContainText(
      /(?:评分|分数)\s*[:：]?\s*\d+(?:\.\d+)?(?:\s*分)?|排名\s*[:：]?\s*(?:第\s*)?\d+/,
    )
  })

  test('writing photo requires OCR confirmation, source-grounded feedback and a separate non-empty second work', async ({
    page,
  }) => {
    test.skip(
      !LIVE_AI,
      'NOT RUN: requires HEX_K12_REAL_MODEL=1 and HEX_K12_CREATIVE_AI=1 for authorized OCR/feedback',
    )
    childName = `作文原图-${e2eMarker('child')}`
    const owner = await createTutorAndOpenWorks(page, childName)
    const modal = await openAddWork(page, 'writing')
    const assetID = await uploadWorkPhoto(page, FIXTURES.writing)
    expect(assetID).toContain(FIXTURES.writing.sha256)
    await expect(
      modal.getByTestId('cw-ocr-awaiting'),
      'photo writing cannot skip the persisted OCR confirmation stop',
    ).toBeVisible({ timeout: 6 * 60_000 })
    const draft = modal.getByTestId('cw-add-draft')
    const confirmedText = await draft.inputValue()
    expect(
      confirmedText,
      'OCR draft must be the fixture content, not the old campus-spring sample',
    ).toMatch(/我的好爸爸|爸爸/)
    await modal.getByTestId('cw-ocr-confirm').click()
    await expect(modal.getByTestId('cw-ocr-confirmed')).toBeVisible({ timeout: 60_000 })
    await expect(modal.getByTestId('cw-add-title')).toHaveCount(0)
    await expect(modal.getByTestId('cw-add-task')).toHaveCount(0)
    await expect(modal.getByTestId('cw-add-intent')).toHaveCount(0)
    await expect(modal.getByTestId('cw-add-submit')).toBeEnabled()
    await modal.getByTestId('cw-add-submit').click()
    await expect(modal).toHaveCount(0, { timeout: 30_000 })

    await expect
      .poll(
        async () =>
          (await listWorks(page, owner)).filter((item) => item.source_asset_id === assetID).length,
        { timeout: 60_000 },
      )
      .toBe(1)
    const firstWork = (await listWorks(page, owner)).find(
      (item) => item.source_asset_id === assetID,
    )
    expect(firstWork, 'confirmed OCR save must create one independent writing work').toBeTruthy()
    expect(firstWork?.content_markdown).toBe(confirmedText.trim())
    expect(firstWork?.versions).toBeUndefined()
    const firstWorkID = String(firstWork?.work_id || '')
    expect(firstWorkID).not.toBe('')

    const card = page.locator(`.k12cw__card[data-work-id="${firstWorkID}"]`)
    await expect(card).toBeVisible()
    await expect(card.getByTestId('cw-detail-toggle')).toBeEnabled({ timeout: 6 * 60_000 })
    await card.getByTestId('cw-detail-toggle').click()
    const detail = page.getByTestId('cw-detail-modal')
    await expect(detail).toBeVisible()
    const firstFeedback = detail.getByTestId('cw-latest-feedback')
    await expect(
      firstFeedback,
      'saving a confirmed work must generate feedback without a separate first-generation action',
    ).toBeVisible({ timeout: 6 * 60_000 })
    await expect(detail.getByTestId('cw-feedback-generate')).toHaveCount(0)
    const feedback = await firstFeedback.innerText()
    expect(feedback).toMatch(/爸爸|程序员|河蟹|AI|数学/)
    expect(feedback).not.toMatch(/校园春景|柳枝像绿色丝带|评分|排名/)
    expect(await firstFeedback.getAttribute('data-generation-id')).toBeTruthy()
    expect(await firstFeedback.getAttribute('data-feedback-id')).toBeTruthy()
    await expect(detail.getByTestId('cw-revision-input')).toHaveCount(0)
    await expect(detail.getByTestId('cw-revision-submit')).toHaveCount(0)
    await expect(detail.locator('[data-testid="cw-version-content"]')).toHaveCount(0)
    await detail.getByTestId('cw-detail-close').click()

    const secondDraft = `第二篇-${e2eMarker('work')}：我补充了爸爸用提问引导我检查数学步骤的细节。`
    await page.getByTestId('cw-add-open').click()
    const secondModal = page.getByTestId('cw-add-modal')
    await expect(secondModal).toBeVisible()
    await secondModal.getByTestId('cw-add-type-writing').click()
    await expect(secondModal.getByTestId('cw-add-title')).toHaveCount(0)
    await expect(secondModal.getByTestId('cw-add-task')).toHaveCount(0)
    await expect(secondModal.getByTestId('cw-add-intent')).toHaveCount(0)
    await secondModal.getByTestId('cw-add-draft').fill(secondDraft)
    await expect(secondModal.getByTestId('cw-add-submit')).toBeEnabled()
    await secondModal.getByTestId('cw-add-submit').click()
    await expect(secondModal).toHaveCount(0, { timeout: 30_000 })

    await expect
      .poll(
        async () =>
          (await listWorks(page, owner)).filter((item) => item.content_markdown === secondDraft)
            .length,
        { timeout: 60_000 },
      )
      .toBe(1)
    const secondWork = (await listWorks(page, owner)).find(
      (item) => item.content_markdown === secondDraft,
    )
    expect(secondWork, 'second text must create another independent work').toBeTruthy()
    const secondWorkID = String(secondWork?.work_id || '')
    expect(secondWorkID).not.toBe('')
    expect(secondWorkID).not.toBe(firstWorkID)
    expect(secondWork?.source_asset_id).toBeUndefined()
    expect(secondWork?.versions).toBeUndefined()

    const secondCard = page.locator(`.k12cw__card[data-work-id="${secondWorkID}"]`)
    await expect(secondCard).toBeVisible()
    await expect(secondCard.getByTestId('cw-detail-toggle')).toBeEnabled({
      timeout: 6 * 60_000,
    })
    await secondCard.getByTestId('cw-detail-toggle').click()
    const secondDetail = page.getByTestId('cw-detail-modal')
    const secondFeedback = secondDetail.getByTestId('cw-latest-feedback')
    await expect(secondFeedback).toBeVisible({ timeout: 6 * 60_000 })
    expect(await secondFeedback.getAttribute('data-generation-id')).toBeTruthy()
    expect(await secondFeedback.getAttribute('data-feedback-id')).toBeTruthy()
    const persistedSecond = (await listWorks(page, owner)).find(
      (item) => item.work_id === secondWorkID,
    )
    expect(feedbackPayload(persistedSecond)).toBeTruthy()
  })

  test('art save automatically produces feedback that cites visible elements', async ({ page }) => {
    test.skip(!LIVE_AI, 'NOT RUN: requires authorized creative feedback generation')
    childName = `美术点评-${e2eMarker('child')}`
    const owner = await createTutorAndOpenWorks(page, childName)
    const modal = await openAddWork(page, 'art')
    await uploadWorkPhoto(page, FIXTURES.art)
    const title = `彩虹和小猫-${e2eMarker('work')}`
    await modal.getByTestId('cw-add-title').fill(title)
    await expect(modal.getByTestId('cw-add-task')).toHaveCount(0)
    await expect(modal.getByTestId('cw-add-intent')).toHaveCount(0)
    await modal.getByTestId('cw-add-submit').click()
    const card = page.locator('.k12cw__card', { hasText: title })
    await expect(card).toBeVisible({ timeout: 30_000 })
    await expect(card.getByTestId('cw-detail-toggle')).toBeEnabled({ timeout: 6 * 60_000 })
    await card.getByTestId('cw-detail-toggle').click()
    const detail = page.getByTestId('cw-detail-modal')
    await expect(detail).toBeVisible()
    const feedbackBlock = detail.getByTestId('cw-latest-feedback')
    await expect(
      feedbackBlock,
      'saving art must generate evidence-grounded feedback automatically',
    ).toBeVisible({ timeout: 6 * 60_000 })
    await expect(detail.getByTestId('cw-feedback-generate')).toHaveCount(0)
    const persisted = (await listWorks(page, owner)).find((item) => item.work_title === title)
    expect(persisted?.versions).toBeUndefined()
    const structured = feedbackPayload(persisted)
    expect(structured).toBeTruthy()
    const projection = String(structured?.projection_markdown)
    expect(projection).toMatch(/女孩|人物/)
    expect(projection).toMatch(/猫/)
    expect(projection).toMatch(/彩虹/)
    expect(projection).not.toMatch(
      /(?:未|没有|没能|看不(?:见|清)|无法(?:确认|识别))[^。；\n]{0,16}(?:女孩|人物)/,
    )
    expect(projection).not.toMatch(
      /(?:未|没有|没能|看不(?:见|清)|无法(?:确认|识别))[^。；\n]{0,16}(?:小猫|猫)/,
    )
    expect(projection).not.toMatch(
      /(?:未|没有|没能|看不(?:见|清)|无法(?:确认|识别))[^。；\n]{0,16}彩虹/,
    )
    const text = await feedbackBlock.innerText()
    expect(text).toMatch(
      /(?:中央|中间)[^。；\n]{0,48}(?:女孩|人物)|(?:女孩|人物)[^。；\n]{0,48}(?:中央|中间)/,
    )
    expect(text).toMatch(
      /(?:笑脸|橙|橘|画面|人物)[^。；\n]{0,32}(?:小猫|猫)|(?:小猫|猫)[^。；\n]{0,32}(?:笑脸|橙|橘|画面|人物)/,
    )
    expect(text).toMatch(
      /(?:明亮|白云|云朵|颜色|左上|上方)[^。；\n]{0,32}彩虹|彩虹[^。；\n]{0,32}(?:明亮|白云|云朵|颜色|爱心|星星)/,
    )
    expect(text).not.toMatch(
      /(?:未|没有|没能|看不(?:见|清)|无法(?:确认|识别))[^。；\n]{0,16}(?:女孩|人物)/,
    )
    expect(text).not.toMatch(
      /(?:未|没有|没能|看不(?:见|清)|无法(?:确认|识别))[^。；\n]{0,16}(?:小猫|猫)/,
    )
    expect(text).not.toMatch(/(?:未|没有|没能|看不(?:见|清)|无法(?:确认|识别))[^。；\n]{0,16}彩虹/)
    await expect(detail.getByTestId('cw-practice-card')).toHaveCount(0)
    const generatedContent = JSON.stringify({
      visible_evidence: structured?.visible_evidence,
      affirmation: structured?.affirmation,
      parent_guidance: structured?.parent_guidance,
      next_step: structured?.next_step,
    })
    expect(generatedContent).not.toMatch(
      /\d+\s*分(?!钟)|第[一二三四五六七八九十\d]+名|我来重画|帮你重画|代你画/,
    )
    expect(String(structured?.limitations)).toMatch(/不(?:评分|打分).*不排名.*不替孩子重画/)
  })

  test('BUG-20260725-009 real initial feedback and regeneration preserve generation identity', async ({
    page,
  }) => {
    test.skip(!LIVE_AI, 'NOT RUN: requires authorized creative feedback generation')
    childName = `点评代次-${e2eMarker('child')}`
    const owner = await createTutorAndOpenWorks(page, childName)
    const modal = await openAddWork(page, 'writing')
    const draft = `周末我和爸爸一起修好了旧台灯。爸爸没有直接告诉我答案，而是让我先检查插头和灯泡。我找到松动的灯泡后，台灯终于亮了。-${e2eMarker('work')}`
    await modal.getByTestId('cw-add-draft').fill(draft)
    await modal.getByTestId('cw-add-submit').click()
    await expect(modal).toHaveCount(0, { timeout: 30_000 })

    await expect
      .poll(
        async () =>
          (await listWorks(page, owner)).filter((item) => item.content_markdown === draft).length,
        { timeout: 60_000 },
      )
      .toBe(1)
    const created = (await listWorks(page, owner)).find((item) => item.content_markdown === draft)
    const workID = String(created?.work_id || '')
    expect(workID).not.toBe('')
    const card = page.locator(`.k12cw__card[data-work-id="${workID}"]`)
    await expect(card.getByTestId('cw-detail-toggle')).toBeEnabled({ timeout: 6 * 60_000 })
    await card.getByTestId('cw-detail-toggle').click()

    const detail = page.getByTestId('cw-detail-modal')
    const beforeRetry = (await listWorks(page, owner)).find((item) => item.work_id === workID)
    const initialState = (beforeRetry?.initial_feedback ??
      beforeRetry?.initial_feedback_generation) as Json | undefined
    const initialGenerationID = String(initialState?.generation_id || '')
    expect(initialGenerationID).not.toBe('')

    const failedInitial = detail.getByTestId('cw-initial-review-error')
    const initialBlock = detail.getByTestId('cw-latest-feedback')
    if (await failedInitial.isVisible().catch(() => false)) {
      await detail.getByTestId('cw-initial-review-retry').click()
    }
    await expect(initialBlock).toBeVisible({ timeout: 6 * 60_000 })
    expect(await initialBlock.getAttribute('data-generation-id')).toBe(initialGenerationID)
    const initialFeedbackID = await initialBlock.getAttribute('data-feedback-id')
    expect(initialFeedbackID).toBeTruthy()

    const regeneratePath = `/api/k12/creative-works/${encodeURIComponent(workID)}/generate-feedback`
    let regeneratePosts = 0
    let commandID = ''
    page.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith(regeneratePath)) {
        regeneratePosts++
        commandID = request.headers()['idempotency-key'] || commandID
      }
    })
    const regenerate = detail.getByTestId('cw-feedback-regenerate')
    await regenerate.evaluate((button) => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await expect(regenerate).toHaveAttribute('aria-busy', 'true')
    await expect(regenerate).not.toHaveAttribute('aria-busy', 'true', { timeout: 6 * 60_000 })
    expect(regeneratePosts, 'one synchronous double click must emit one provider command').toBe(1)
    expect(commandID).not.toBe('')

    const regeneratedBlock = detail.getByTestId('cw-latest-feedback')
    const regeneratedGenerationID = await regeneratedBlock.getAttribute('data-generation-id')
    const regeneratedFeedbackID = await regeneratedBlock.getAttribute('data-feedback-id')
    expect(regeneratedGenerationID).toBeTruthy()
    expect(regeneratedGenerationID).not.toBe(initialGenerationID)
    expect(regeneratedFeedbackID).toBeTruthy()
    expect(regeneratedFeedbackID).not.toBe(initialFeedbackID)

    const persisted = (await listWorks(page, owner)).find((item) => item.work_id === workID)
    const initial = (persisted?.initial_feedback ?? persisted?.initial_feedback_generation) as
      | Json
      | undefined
    const latest = (persisted?.latest_feedback ?? persisted?.latest_feedback_generation) as
      | Json
      | undefined
    expect(initial?.generation_id).toBe(initialGenerationID)
    expect(latest?.generation_id).toBe(regeneratedGenerationID)

    const replay = await json<Json>(
      await page.request.post(`${BASE_URL}${regeneratePath}`, {
        data: { agent: owner },
        headers: { 'Idempotency-Key': commandID },
      }),
    )
    const replayLatest = (replay.latest_feedback ?? replay.latest_feedback_generation) as
      | Json
      | undefined
    expect(replayLatest?.generation_id).toBe(regeneratedGenerationID)
  })
})
