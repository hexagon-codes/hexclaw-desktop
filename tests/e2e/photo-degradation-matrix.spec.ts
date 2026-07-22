import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import {
  assertLiveRuntime,
  cleanupLiveChild,
  liveGateBlockers,
  liveJSON,
  liveSkipReason,
} from '../live/k12-live-helpers'

/** UICLICK-006 / PHOTO-* / E2E grading-vs-solving golden matrix. */
const blockers = liveGateBlockers({ isolatedProfile: true, model: true })
const DOCS_ROOT = process.env.HEXCLAW_DOCS_ROOT || '/Users/guoyanjun/work/hexclaw-docs'

const FIXTURES = {
  clear: {
    id: 'FX-MATH-D5-CLEAR-001',
    path: process.env.HEX_K12_PHOTO_CLEAR || resolve(DOCS_ROOT, 'test/k12-test-批改作业.png'),
    sha256: '0c4b1a972319203b1483ffbce43e8835b1367be53edceea23c89368a2f2bc861',
    bytes: 2_178_059,
  },
  messy: {
    id: 'FX-MATH-D5-MESSY-001',
    path:
      process.env.HEX_K12_PHOTO_MESSY ||
      resolve(DOCS_ROOT, 'test/k12-test-批改（答题比较乱的）.jpg'),
    sha256: '78cf3a1b5c52e12ca17ca13aa71c7a9439baed244e88b438aa2f1f70cd782fb5',
    bytes: 191_048,
  },
  blank: {
    id: 'FX-MATH-D1-BLANK-001',
    path: process.env.HEX_K12_PHOTO_BLANK || resolve(DOCS_ROOT, 'test/k12-test-解题.JPG'),
    sha256: '76c3bbab79486619d680114b8c182c0e23d15ce305239dc762819a5f0407eed7',
    bytes: 204_498,
  },
} as const

type Fixture = (typeof FIXTURES)[keyof typeof FIXTURES]

function fileSHA(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function verifyFixture(fixture: Fixture): void {
  const bytes = readFileSync(fixture.path)
  expect(
    statSync(fixture.path).isFile(),
    `${fixture.id} must be a regular read-only source fixture`,
  ).toBe(true)
  expect(statSync(fixture.path).size, `${fixture.id} byte length drift`).toBe(fixture.bytes)
  expect(
    bytes.subarray(0, 8).toString('hex'),
    `${fixture.id} must retain its real image magic`,
  ).toMatch(fixture === FIXTURES.clear ? /^89504e470d0a1a0a$/ : /^ffd8ff/)
  expect(fileSHA(fixture.path), `${fixture.id} SHA-256 drift`).toBe(fixture.sha256)
}

async function createTutor(page: Page, childName: string): Promise<void> {
  await page.addInitScript(() => sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1'))
  await page.goto('/agents', { waitUntil: 'domcontentloaded' })
  const skip = page.getByRole('button', { name: '跳过' })
  if (await skip.isVisible().catch(() => false)) await skip.click()
  await page.getByText('模板库', { exact: false }).first().click()
  await page.getByText('作业辅导助手', { exact: false }).first().click()
  await page.locator('.k12pf__input').first().fill(childName)
  await page.locator('.k12pf .hc-select__trigger').nth(0).click()
  await page.locator('.hc-select__dropdown .hc-select__option', { hasText: '五年级下' }).click()
  await page.getByRole('button', { name: '创建', exact: true }).click()
  await expect(page.locator('.k12pf')).toHaveCount(0, { timeout: 30_000 })
  await page.getByText('我的智能体', { exact: false }).first().click()
  const card = page.locator('.hc-cxcard', { hasText: childName })
  await expect(card).toBeVisible({ timeout: 30_000 })
  await card.getByRole('button', { name: /进入辅导/ }).click()
  await expect(page.locator('.hc-composer input[type="file"]')).toBeAttached({ timeout: 30_000 })
}

async function uploadAndRecognize(page: Page, fixture: Fixture) {
  verifyFixture(fixture)
  const apiPaths: string[] = []
  const onRequest = (request: import('@playwright/test').Request) => {
    const pathname = new URL(request.url()).pathname
    if (pathname.includes('/api/v1/k12/')) apiPaths.push(`${request.method()} ${pathname}`)
  }
  page.on('request', onRequest)
  await page.locator('.hc-composer input[type="file"]').setInputFiles(fixture.path)
  const guard = page.getByTestId('recognize-guard').last()
  await expect(guard).toBeVisible({ timeout: 30_000 })
  await expect(guard.getByTestId('rq-item').first()).toBeVisible({ timeout: 6 * 60_000 })
  page.off('request', onRequest)

  expect(
    apiPaths.some((path) => path === 'POST /api/v1/k12/grading-jobs'),
    `${fixture.id} must enter through public GradingJob creation`,
  ).toBe(true)
  expect(
    apiPaths.some((path) => /\/recognize(?:$|\/)/.test(path)),
    `${fixture.id} must not bypass GradingJob via a public recognize endpoint`,
  ).toBe(false)
  await expect(guard.locator('.rec-panel__err')).toHaveCount(0)

  const subject = guard.getByTestId('recognize-subject')
  if (await subject.isVisible().catch(() => false)) {
    await subject.locator('.hc-select__trigger').click()
    await page.locator('.hc-select__dropdown .hc-select__option', { hasText: '数学' }).click()
  }
  for (const checkbox of await guard.locator('input[data-testid^="rq-confirm-"]').all()) {
    await checkbox.check()
  }
  const confirm = guard.getByTestId('recognize-confirm-all')
  await expect(confirm).toBeEnabled()
  await confirm.click()
  await expect(guard.getByTestId('recognize-batch-actions')).toBeVisible()
  return guard
}

async function inputValues(locator: Locator): Promise<string[]> {
  return locator.evaluateAll((inputs) =>
    inputs.map((input) => {
      if (!(input instanceof HTMLInputElement)) throw new Error('expected an input element')
      return input.value
    }),
  )
}

async function attachOverlayEvidence(
  guard: Locator,
  testInfo: TestInfo,
  attachmentName: string,
): Promise<void> {
  const overlay = guard.getByTestId('photo-grade-overlay')
  await expect(
    overlay.getByTestId('overlay-save'),
    'the authoritative grading overlay has no save control',
  ).toHaveCount(0)
  const screenshot = await overlay.screenshot({ type: 'png' })
  expect(screenshot.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  await testInfo.attach(attachmentName, { body: screenshot, contentType: 'image/png' })
}

async function countBackupRecords(page: Page): Promise<number> {
  const agents = await liveJSON<{
    agents?: Array<{ name?: string; metadata?: Record<string, string> }>
  }>(page.request, 'GET', '/api/v1/agents')
  const cardName = await page.locator('.k12enh-tutor__name').first().textContent()
  const child = cardName?.replace(/的辅导助手.*$/, '').trim()
  const owner = agents.agents?.find((agent) => agent.metadata?.['k12.child_name'] === child)?.name
  expect(owner, 'current K12 conversation must resolve to one owner').toBeTruthy()
  const payload = await liveJSON<{ records?: unknown[] }>(
    page.request,
    'GET',
    `/api/v1/k12/backup?agent=${encodeURIComponent(owner!)}`,
  )
  return payload.records?.length ?? 0
}

test('PHOTO-001 immutable grading photos retain frozen bytes, magic and SHA', () => {
  for (const fixture of Object.values(FIXTURES)) verifyFixture(fixture)
})

test.describe.serial('real K12 photo oracle and honest degradation', () => {
  test.setTimeout(15 * 60_000)
  test.skip(
    blockers.length > 0,
    liveSkipReason(blockers, 'installed RC + isolated profile + authorized real vision model'),
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
      for (const fixture of Object.values(FIXTURES)) verifyFixture(fixture)
    }
  })

  test('clear answered sheet keeps process-quality evidence and visible positioned grading', async ({
    page,
  }, testInfo) => {
    childName = `清晰卷${Date.now().toString(36)}`
    await createTutor(page, childName)
    const guard = await uploadAndRecognize(page, FIXTURES.clear)
    const answers = await inputValues(guard.locator('input[data-testid^="rq-answer-"]'))
    expect(
      answers.filter((answer) => answer.trim()).length,
      'clear answered sheet must not be mistaken for a blank worksheet',
    ).toBeGreaterThan(0)
    await expect(guard.getByTestId('recognize-grade-all')).toBeVisible()
    await guard.getByTestId('recognize-grade-all').click()
    const overlay = guard.getByTestId('photo-grade-overlay')
    await expect(overlay).toBeVisible({ timeout: 8 * 60_000 })
    const verdictCount = await overlay
      .locator('[data-testid^="overlay-mark-"], [data-testid^="overlay-degraded-"]')
      .count()
    expect(verdictCount).toBe(answers.filter((answer) => answer.trim()).length)
    const processEvidence = guard.locator('[data-testid^="rq-grade-details-"]').filter({
      hasText: /42\s*=\s*18\s*[×x*]\s*2/,
    })
    await expect(
      processEvidence,
      'answer 29 is correct but its 42=18×2 process issue must remain attached to that item',
    ).toHaveCount(1)
    await expect(processEvidence).toContainText(/出错步骤|错误原因|过程.*(?:错误|问题)/)
    await expect(overlay.locator('[data-testid^="overlay-degraded-"]')).toHaveCount(0)
    await attachOverlayEvidence(guard, testInfo, 'clear-sheet-grading-overlay.png')
  })

  test('messy sheet yields 12 correct, 3 wrong, 1 unanswered without guessing handwriting', async ({
    page,
  }, testInfo) => {
    childName = `凌乱卷${Date.now().toString(36)}`
    await createTutor(page, childName)
    const guard = await uploadAndRecognize(page, FIXTURES.messy)
    const answerableRows = guard.locator(
      '[data-testid="rq-item"]:not([data-problem-kind="compound_parent"])',
    )
    expect(
      await answerableRows.count(),
      'messy fixture oracle contains exactly 16 answerable items',
    ).toBe(16)
    const answers = await inputValues(guard.locator('input[data-testid^="rq-answer-"]'))
    expect(answers.filter((answer) => answer.trim()).length).toBe(15)
    await expect(guard.locator('[data-testid^="rq-blank-hint-"]')).toHaveCount(1)
    await expect(guard.locator('[data-testid^="rq-unclear-hint-"]')).toHaveCount(0)
    await expect(guard.getByTestId('recognize-grade-all')).toContainText('15')
    await expect(guard.getByTestId('recognize-solve-all')).toContainText('1')
    await guard.getByTestId('recognize-grade-all').click()
    const overlay = guard.getByTestId('photo-grade-overlay')
    await expect(overlay).toBeVisible({ timeout: 10 * 60_000 })
    const symbols = await overlay.locator('[data-testid^="overlay-sym-"]').allTextContents()
    const degradedVerdicts = await overlay
      .locator('.pg-overlay__degraded-verdict')
      .allTextContents()
    const verdicts = [...symbols, ...degradedVerdicts]
    expect(verdicts.filter((value) => value.includes('✓')).length, 'golden correct count').toBe(12)
    expect(verdicts.filter((value) => value.includes('✗')).length, 'golden wrong count').toBe(3)
    expect(verdicts, 'unanswered item must not receive a red cross').toHaveLength(15)
    await expect(guard).toContainText(/0\.5\s*\+\s*1\/3/)
    await expect(guard).toContainText(/88/)
    await expect(guard).toContainText(/225\s*(?:kg|千克)/)
    const degraded = overlay.locator('[data-testid^="overlay-degraded-"]')
    for (const item of await degraded.all()) {
      await expect(
        item.locator('.pg-overlay__degraded-q'),
        'degradation must identify the affected question',
      ).not.toBeEmpty()
      await expect(
        item.locator('.pg-overlay__degraded-verdict'),
        'degradation must state a real verdict',
      ).not.toBeEmpty()
    }
    await attachOverlayEvidence(guard, testInfo, 'messy-sheet-grading-overlay.png')
  })

  test('blank worksheet takes solve-only lane and creates no mistake or grading overlay', async ({
    page,
  }) => {
    childName = `空白卷${Date.now().toString(36)}`
    await createTutor(page, childName)
    const recordsBefore = await countBackupRecords(page)
    const guard = await uploadAndRecognize(page, FIXTURES.blank)
    const answerableRows = guard.locator(
      '[data-testid="rq-item"]:not([data-problem-kind="compound_parent"])',
    )
    const answers = await inputValues(guard.locator('input[data-testid^="rq-answer-"]'))
    expect(
      answers.length,
      'blank fixture must still recognize at least one question',
    ).toBeGreaterThan(0)
    expect(
      await answerableRows.count(),
      'every blank-fixture question must have one answer input',
    ).toBe(answers.length)
    expect(
      answers.every((answer) => answer.trim() === ''),
      'blank paper must not hallucinate student answers',
    ).toBe(true)
    await expect(guard.locator('[data-testid^="rq-blank-hint-"]')).toHaveCount(answers.length)
    await expect(guard.locator('[data-testid^="rq-unclear-hint-"]')).toHaveCount(0)
    await expect(guard.getByTestId('recognize-grade-all')).toHaveCount(0)
    await expect(guard.getByTestId('recognize-solve-all')).toBeVisible()
    await guard.getByTestId('recognize-solve-all').click()
    await expect(guard.getByTestId('recognize-solve-all')).toHaveCount(0, { timeout: 8 * 60_000 })
    await expect(guard.getByTestId('photo-grade-overlay')).toHaveCount(0)
    expect(await countBackupRecords(page), 'solve-only lane must not write a mistake record').toBe(
      recordsBefore,
    )
  })

  test('retryable recognition failure exposes a visible same-job retry control', async ({
    page,
  }) => {
    const chaosFixture = process.env.HEX_K12_PHOTO_RETRY_FIXTURE
    test.skip(
      !chaosFixture,
      'NOT RUN: set HEX_K12_PHOTO_RETRY_FIXTURE and configure the provider to fail the first GradingJob attempt retryably',
    )
    childName = `重试卷${Date.now().toString(36)}`
    await createTutor(page, childName)
    await page.locator('.hc-composer input[type="file"]').setInputFiles(chaosFixture!)
    const guard = page.getByTestId('recognize-guard').last()
    await expect(guard.locator('.rec-panel__err')).toBeVisible({ timeout: 6 * 60_000 })
    const retry = guard.getByRole('button', { name: /重试/ })
    await expect(retry, 'an error message without a retry action is a dead end').toBeVisible()
    await retry.click()
    await expect(guard.getByTestId('rq-item').first()).toBeVisible({ timeout: 6 * 60_000 })
    expect(basename(chaosFixture!)).not.toBe('')
  })
})
