import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test, type APIResponse, type Page } from '@playwright/test'
import { BASE_URL, e2eMarker } from './helpers'
import { cleanupK12Child } from './live-fixture-cleanup'

/** UNIT/INT-PRACTICE + REG-PAPER/MANUAL + E2E-PAPER/RETURN integrity gate. */
const LIVE = process.env.HEX_K12_ACCEPTANCE_LIVE === '1' && process.env.HEX_K12_PRACTICE_LIVE === '1'
const DOCS_ROOT = process.env.HEXCLAW_DOCS_ROOT || resolve(process.cwd(), '../hexclaw-docs')
const RETURN_FIXTURE = {
  id: 'FX-MATH-D1-BLANK-001',
  path: process.env.HEX_K12_PHOTO_BLANK || resolve(DOCS_ROOT, 'test/k12-test-解题.JPG'),
  sha256: '76c3bbab79486619d680114b8c182c0e23d15ce305239dc762819a5f0407eed7',
  bytes: 204_498,
} as const

type Json = Record<string, unknown>

async function json<T>(response: APIResponse): Promise<T> {
  const text = await response.text()
  expect(response.ok(), `${new URL(response.url()).pathname} => ${response.status()} (body redacted)`).toBe(true)
  return JSON.parse(text) as T
}

function verifyReturnFixture(): void {
  const bytes = readFileSync(RETURN_FIXTURE.path)
  expect(statSync(RETURN_FIXTURE.path).isFile()).toBe(true)
  expect(bytes.length).toBe(RETURN_FIXTURE.bytes)
  expect(bytes[0]).toBe(0xff)
  expect(bytes[1]).toBe(0xd8)
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(RETURN_FIXTURE.sha256)
}

async function createTutorAndOpenPractice(page: Page, childName: string): Promise<string> {
  await page.addInitScript(() => sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1'))
  await page.goto('/agents', { waitUntil: 'domcontentloaded' })
  const skip = page.getByRole('button', { name: '跳过' })
  if (await skip.isVisible().catch(() => false)) await skip.click()
  await page.getByText('模板库', { exact: false }).first().click()
  await page.getByText('作业辅导助手', { exact: false }).first().click()
  const dialog = page.getByRole('dialog')
  await dialog.locator('.k12pf__input').fill(childName)
  await dialog.getByRole('button', { name: '创建', exact: true }).click()
  await expect(dialog).toHaveCount(0, { timeout: 30_000 })
  const agents = await json<{ agents?: Array<{ name?: string; metadata?: Record<string, string> }> }>(
    await page.request.get('/_hexclaw/api/v1/agents'),
  )
  const matches = (agents.agents || []).filter((agent) => agent.metadata?.['k12.child_name'] === childName)
  expect(matches).toHaveLength(1)
  const owner = matches[0]!.name!
  await page.getByText('我的智能体', { exact: false }).first().click()
  await page.locator('.hc-cxcard', { hasText: childName }).getByRole('button', { name: /错题本|学习档案/ }).click()
  await expect(page).toHaveURL(/(?:\?|&)scenarioTab=records(?:&|$)/)
  await expect(page.locator('.k12rec')).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('subtab-practicesets').click()
  await expect(page.getByTestId('practicesets-section')).toBeVisible()
  return owner
}

async function addBasketItem(
  page: Page,
  owner: string,
  item: Json,
): Promise<{ record_id: string; added: boolean }> {
  return json(await page.request.post(`${BASE_URL}/api/k12/practice-sets/basket/items`, {
    data: { agent: owner, source_session: 'e2e-practice-integrity', item },
  }))
}

async function verifyBasketItem(
  page: Page,
  owner: string,
  recordId: string,
  itemId: string,
  status: 'verified' | 'needs_review',
  evidence = '',
): Promise<Json> {
  return json(await page.request.post(
    `${BASE_URL}/api/k12/practice-sets/${encodeURIComponent(recordId)}/verify`,
    { data: { agent: owner, item_id: itemId, status, evidence } },
  ))
}

function numberedLines(text: string): string[] {
  return text.split('\n').map((line) => line.trim()).filter((line) => /^\d+[.、]/.test(line))
}

test('§1.2 practice return source reads the frozen photo SHA', () => {
  test.skip(!existsSync(RETURN_FIXTURE.path), `NOT RUN: private fixture is absent: ${RETURN_FIXTURE.id}`)
  verifyReturnFixture()
})

test.describe('real practice basket, paper projection and return evidence', () => {
  test.setTimeout(12 * 60_000)
  test.skip(
    !LIVE,
    'NOT RUN: requires HEX_K12_ACCEPTANCE_LIVE=1 and HEX_K12_PRACTICE_LIVE=1 with authorized verifier/regrade capacity',
  )
  let childName = ''
  test.afterEach(async ({ request }) => {
    await cleanupK12Child(request, childName)
    childName = ''
    verifyReturnFixture()
  })

  test('verified and blocked items produce one immutable question/answer exact-set', async ({ page }) => {
    childName = `练习卷-${e2eMarker('child')}`
    const owner = await createTutorAndOpenPractice(page, childName)
    const verifiedA = {
      item_id: `item-${e2eMarker('a')}`, source_problem_id: 'problem-fixture-a', subject: '数学', added_via: 'manual',
      question_markdown: '1. 6 × 7 = ____', expected_answer_markdown: 'ANSWER_ONLY_42',
      verification_status: 'pending',
    }
    const verifiedB = {
      item_id: `item-${e2eMarker('b')}`, source_problem_id: 'problem-fixture-b', subject: '数学', added_via: 'manual',
      question_markdown: '2. 8 × 7 = ____', expected_answer_markdown: 'ANSWER_ONLY_56',
      verification_status: 'pending',
    }
    const blocked = {
      item_id: `item-${e2eMarker('blocked')}`, source_problem_id: 'problem-fixture-unclear', subject: '科学', added_via: 'manual',
      question_markdown: 'BLOCKED_ONLY_QUESTION', expected_answer_markdown: 'BLOCKED_ONLY_ANSWER',
      verification_status: 'pending',
    }
    const first = await addBasketItem(page, owner, verifiedA)
    expect(first.added).toBe(true)
    const pending = await json<Json>(
      await page.request.get(`${BASE_URL}/api/k12/practice-sets/${encodeURIComponent(first.record_id)}?agent=${encodeURIComponent(owner)}`),
    )
    expect((pending.items as Json[])[0]?.verification_status, 'adding a candidate must not make it verified').toBe('pending')
    await verifyBasketItem(
      page,
      owner,
      first.record_id,
      String(verifiedA.item_id),
      'verified',
      `fixture:${RETURN_FIXTURE.sha256}:human-reviewed`,
    )
    expect((await addBasketItem(page, owner, verifiedA)).added, 'same item retry must be idempotent').toBe(false)
    expect((await addBasketItem(page, owner, verifiedB)).added).toBe(true)
    await verifyBasketItem(
      page,
      owner,
      first.record_id,
      String(verifiedB.item_id),
      'verified',
      `fixture:${RETURN_FIXTURE.sha256}:human-reviewed`,
    )
    expect((await addBasketItem(page, owner, blocked)).added).toBe(true)
    await verifyBasketItem(page, owner, first.record_id, String(blocked.item_id), 'needs_review')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.getByTestId('subtab-practicesets').click()

    await expect(page.getByTestId('ps-basket-count')).toContainText('3')
    await expect(page.getByTestId('ps-blocked-group')).toBeVisible()
    await expect(page.getByTestId('ps-finalize-print')).toBeEnabled()
    const preview = await json<Json>(
      await page.request.get(
        `${BASE_URL}/api/k12/practice-sets/${encodeURIComponent(first.record_id)}/paper?agent=${encodeURIComponent(owner)}&kind=question`,
      ),
    )
    expect(preview.preview).toBe(true)
    expect(preview.paper_no).toBe('')
    const previewText = String(preview.markdown)
    expect(previewText).toContain('6 × 7')
    expect(previewText).toContain('8 × 7')
    expect(previewText).not.toContain('ANSWER_ONLY_42')
    expect(previewText).not.toContain('ANSWER_ONLY_56')
    expect(previewText).not.toContain('BLOCKED_ONLY_QUESTION')

    const finalized = await json<{ set: Json; skipped_blocked_count: number }>(
      await page.request.post(`${BASE_URL}/api/k12/practice-sets/${encodeURIComponent(first.record_id)}/finalize`, {
        data: { agent: owner, via: 'print', target: '' },
      }),
    )
    expect(finalized.skipped_blocked_count).toBe(1)
    expect(finalized.set.paper_no).toMatch(/^P-/)
    expect(finalized.set.status).toBe('assigned')

    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.getByTestId('subtab-practicesets').click()
    const history = page.getByTestId('ps-history-list').locator('li').filter({ hasText: String(finalized.set.paper_no) })
    await expect(history).toBeVisible()
    await history.getByTestId('ps-paper-question').click()
    const questionModal = page.getByTestId('ps-paper-modal')
    await expect(questionModal).toContainText('6 × 7')
    const questionText = await questionModal.innerText()
    await questionModal.getByTestId('ps-paper-close').click()
    await history.getByTestId('ps-paper-answer').click()
    const answerModal = page.getByTestId('ps-paper-modal')
    await expect(answerModal).toContainText('ANSWER_ONLY_42')
    const answerText = await answerModal.innerText()
    expect(numberedLines(answerText).map((line) => line.replace(/ANSWER_ONLY_\d+/g, ''))).toHaveLength(numberedLines(questionText).length)
    expect(answerText).toContain('ANSWER_ONLY_42')
    expect(answerText).toContain('ANSWER_ONLY_56')
    expect(answerText).not.toContain('BLOCKED_ONLY_ANSWER')
    expect(questionText).not.toContain('ANSWER_ONLY_42')
    await answerModal.getByTestId('ps-paper-close').click()

    verifyReturnFixture()
    await history.getByTestId('ps-return-open').click()
    const returnModal = page.getByTestId('ps-return-modal')
    await returnModal.getByTestId('ps-return-file').setInputFiles(RETURN_FIXTURE.path)
    const choices = returnModal.locator('input[data-testid^="ps-return-item-"]')
    expect(await choices.count()).toBe(2)
    await choices.first().check()
    const submitResponse = page.waitForResponse((response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith(`/api/k12/practice-sets/${first.record_id}/submit`),
    )
    await expect(returnModal.getByTestId('ps-return-confirm')).toBeEnabled()
    await returnModal.getByTestId('ps-return-confirm').click()
    expect((await submitResponse).ok()).toBe(true)

    const persisted = await json<Json>(
      await page.request.get(`${BASE_URL}/api/k12/practice-sets/${encodeURIComponent(first.record_id)}?agent=${encodeURIComponent(owner)}`),
    )
    const returns = persisted.return_assets as Json[]
    expect(returns).toHaveLength(1)
    expect(String(returns[0]?.asset_id)).toContain(RETURN_FIXTURE.sha256)
    expect(returns[0]?.item_ids).toEqual([verifiedA.item_id])
  })
})
