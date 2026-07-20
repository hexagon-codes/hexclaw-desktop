import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { BASE_URL, e2eMarker } from './helpers'
import { cleanupK12Child } from './live-fixture-cleanup'

/** PHOTO-001..005 + E2E-GRADE-001/002 + E2E-SOLVE-001. */
const LIVE = process.env.HEX_K12_ACCEPTANCE_LIVE === '1' && process.env.HEX_K12_REAL_MODEL === '1'
const DOCS_ROOT = process.env.HEXCLAW_DOCS_ROOT || resolve(process.cwd(), '../hexclaw-docs')
const FIXTURES = {
  clear: {
    id: 'FX-MATH-D5-CLEAR-001', path: process.env.HEX_K12_PHOTO_CLEAR || resolve(DOCS_ROOT, 'test/k12-test-批改作业.png'),
    sha256: '0c4b1a972319203b1483ffbce43e8835b1367be53edceea23c89368a2f2bc861', bytes: 2_178_059,
    mime: 'image/png', width: 1086, height: 1448,
  },
  messy: {
    id: 'FX-MATH-D5-MESSY-001', path: process.env.HEX_K12_PHOTO_MESSY || resolve(DOCS_ROOT, 'test/k12-test-批改（答题比较乱的）.jpg'),
    sha256: '78cf3a1b5c52e12ca17ca13aa71c7a9439baed244e88b438aa2f1f70cd782fb5', bytes: 191_048,
    mime: 'image/jpeg', width: 1280, height: 1707,
  },
  blank: {
    id: 'FX-MATH-D1-BLANK-001', path: process.env.HEX_K12_PHOTO_BLANK || resolve(DOCS_ROOT, 'test/k12-test-解题.JPG'),
    sha256: '76c3bbab79486619d680114b8c182c0e23d15ce305239dc762819a5f0407eed7', bytes: 204_498,
    mime: 'image/jpeg', width: 936, height: 1280,
  },
} as const

type Fixture = (typeof FIXTURES)[keyof typeof FIXTURES]

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function dimensions(bytes: Buffer): { width: number; height: number } {
  if (bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('fixture is neither PNG nor JPEG')
  const sizeMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])
  let offset = 2
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue }
    const marker = bytes[offset + 1]!
    if (marker === 0xd8 || marker === 0xd9) { offset += 2; continue }
    const segmentLength = bytes.readUInt16BE(offset + 2)
    if (sizeMarkers.has(marker)) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) }
    }
    if (segmentLength < 2) break
    offset += 2 + segmentLength
  }
  throw new Error('JPEG size marker not found')
}

function verifyFixture(fixture: Fixture): Buffer {
  const bytes = readFileSync(fixture.path)
  expect(statSync(fixture.path).isFile()).toBe(true)
  expect(bytes.length, `${fixture.id} byte length drift`).toBe(fixture.bytes)
  expect(digest(bytes), `${fixture.id} SHA drift`).toBe(fixture.sha256)
  expect(dimensions(bytes), `${fixture.id} dimensions drift`).toEqual({ width: fixture.width, height: fixture.height })
  return bytes
}

async function createTutor(page: Page, childName: string): Promise<string> {
  await page.addInitScript(() => sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1'))
  await page.goto('/agents', { waitUntil: 'domcontentloaded' })
  const skip = page.getByRole('button', { name: '跳过' })
  if (await skip.isVisible().catch(() => false)) await skip.click()
  await page.getByText('模板库', { exact: false }).first().click()
  await page.getByText('作业辅导助手', { exact: false }).first().click()
  const dialog = page.getByRole('dialog')
  await dialog.locator('.k12pf__input').fill(childName)
  await dialog.locator('.hc-select__trigger').nth(0).click()
  await page.locator('.hc-select__dropdown .hc-select__option', { hasText: '五年级下' }).click()
  await dialog.getByRole('button', { name: '创建', exact: true }).click()
  await expect(dialog).toHaveCount(0, { timeout: 30_000 })
  const response = await page.request.get('/_hexclaw/api/v1/agents')
  expect(response.ok()).toBe(true)
  const payload = await response.json() as { agents?: Array<{ name?: string; metadata?: Record<string, string> }> }
  const matches = (payload.agents || []).filter((agent) => agent.metadata?.['k12.child_name'] === childName)
  expect(matches).toHaveLength(1)
  const owner = matches[0]!.name!
  await page.getByText('我的智能体', { exact: false }).first().click()
  await page.locator('.hc-cxcard', { hasText: childName }).getByRole('button', { name: /进入辅导/ }).click()
  await expect(page.locator('.hc-composer input[type="file"]')).toBeAttached({ timeout: 30_000 })
  return owner
}

async function uploadAndConfirm(page: Page, owner: string, fixture: Fixture) {
  const source = verifyFixture(fixture)
  const createRequest = page.waitForRequest((request) => {
    const path = new URL(request.url()).pathname
    return request.method() === 'POST' && path.endsWith('/api/k12/grading-jobs')
  })
  await page.locator('.hc-composer input[type="file"]').setInputFiles(fixture.path)
  const request = await createRequest
  const body = request.postDataJSON() as { agent?: string; image_base64?: string; source_kind?: string; source_key?: string }
  expect(body.agent).toBe(owner)
  expect(body.source_kind).toBe('desktop')
  expect(body.source_key).toBeTruthy()
  const transmitted = Buffer.from(body.image_base64 || '', 'base64')
  expect(transmitted.length).toBe(source.length)
  expect(digest(transmitted), 'GradingJob must receive the exact frozen source bytes').toBe(fixture.sha256)

  const guard = page.getByTestId('recognize-guard').last()
  await expect(guard, 'recognition belongs inside the Tutor conversation message').toBeVisible({ timeout: 30_000 })
  await expect(guard.getByTestId('rq-item').first()).toBeVisible({ timeout: 6 * 60_000 })
  await expect(guard.locator('.rec-panel__err')).toHaveCount(0)
  expect(await guard.evaluate((node) => Boolean(node.closest('[data-testid="k12-photo-assistant-message"]')))).toBe(true)

  const subject = guard.getByTestId('recognize-subject')
  if (await subject.isVisible().catch(() => false)) {
    await subject.locator('.hc-select__trigger').click()
    await page.locator('.hc-select__dropdown .hc-select__option', { hasText: '数学' }).click()
  }
  for (const checkbox of await guard.locator('input[data-testid^="rq-confirm-"]').all()) await checkbox.check()
  await expect(guard.getByTestId('recognize-confirm-all')).toBeEnabled()
  await guard.getByTestId('recognize-confirm-all').click()
  await expect(guard.getByTestId('recognize-batch-actions')).toBeVisible()

  const backup = await page.request.get(`${BASE_URL}/api/k12/backup?agent=${encodeURIComponent(owner)}`)
  expect(backup.ok()).toBe(true)
  const archive = await backup.json() as {
    problem_attempts?: Array<{ problems?: Array<{ page_asset_id?: string }> }>
    assets?: Array<{ asset_id?: string; owner_agent?: string; sha256?: string }>
  }
  const pages = (archive.problem_attempts || []).flatMap((snapshot) => snapshot.problems || [])
  const pageAssetID = pages.at(-1)?.page_asset_id || ''
  expect(pageAssetID).toMatch(new RegExp(`^asset://${owner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`))
  const packed = (archive.assets || []).find((asset) => asset.asset_id === pageAssetID)
  expect(packed?.owner_agent).toBe(owner)
  expect(packed?.sha256, 'v5 backup must pack the exact recognized page asset').toBe(fixture.sha256)
  return guard
}

async function backupRecordCount(page: Page, owner: string): Promise<number> {
  const response = await page.request.get(`${BASE_URL}/api/k12/backup?agent=${encodeURIComponent(owner)}`)
  expect(response.ok()).toBe(true)
  return ((await response.json()) as { records?: unknown[] }).records?.length || 0
}

test('§1.2 grading manifest has all three immutable image identities', () => {
  const missing = Object.values(FIXTURES).filter((fixture) => !existsSync(fixture.path)).map((fixture) => fixture.id)
  test.skip(missing.length > 0, `NOT RUN: private fixture(s) absent: ${missing.join(', ')}`)
  for (const fixture of Object.values(FIXTURES)) verifyFixture(fixture)
})

test.describe('real grading/solving fixture oracle', () => {
  test.setTimeout(15 * 60_000)
  test.skip(!LIVE, 'NOT RUN: requires HEX_K12_ACCEPTANCE_LIVE=1, HEX_K12_REAL_MODEL=1 and an authorized vision provider')
  let childName = ''
  test.afterEach(async ({ request }) => {
    await cleanupK12Child(request, childName)
    childName = ''
    for (const fixture of Object.values(FIXTURES)) verifyFixture(fixture)
  })

  test('clear sheet preserves the correct result plus process error and a real annotation artifact', async ({ page }) => {
    childName = `清晰卷-${e2eMarker('child')}`
    const owner = await createTutor(page, childName)
    const guard = await uploadAndConfirm(page, owner, FIXTURES.clear)
    const answers = await guard.locator('input[data-testid^="rq-answer-"]').inputValues()
    expect(answers.some((answer) => answer.trim() !== '')).toBe(true)
    await guard.getByTestId('recognize-grade-all').click()
    const overlay = guard.getByTestId('photo-grade-overlay')
    await expect(overlay).toBeVisible({ timeout: 8 * 60_000 })
    await expect(guard, '29 is correct but 42=18×2 must remain a visible process issue').toContainText(/过程|步骤|42\s*=\s*18\s*[×x*]\s*2/)
    await expect(guard.locator('[data-testid^="rq-correct-summary-"]').first(), 'correct questions default to compact rows').toBeVisible()
    const downloadPromise = page.waitForEvent('download')
    await overlay.getByTestId('overlay-save').click()
    const download = await downloadPromise
    const path = await download.path()
    expect(path).toBeTruthy()
    expect(readFileSync(path!).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  })

  test('messy sheet keeps the 12/3/1 oracle and never turns unanswered into a red cross', async ({ page }) => {
    childName = `凌乱卷-${e2eMarker('child')}`
    const owner = await createTutor(page, childName)
    const guard = await uploadAndConfirm(page, owner, FIXTURES.messy)
    expect(await guard.getByTestId('rq-item').count()).toBeGreaterThanOrEqual(16)
    const answers = await guard.locator('input[data-testid^="rq-answer-"]').inputValues()
    expect(answers.filter((answer) => answer.trim()).length).toBe(15)
    await expect(guard.locator('[data-testid^="rq-blank-hint-"]')).toHaveCount(1)
    await guard.getByTestId('recognize-grade-all').click()
    const overlay = guard.getByTestId('photo-grade-overlay')
    await expect(overlay).toBeVisible({ timeout: 10 * 60_000 })
    const verdicts = [
      ...await overlay.locator('[data-testid^="overlay-sym-"]').allTextContents(),
      ...await overlay.locator('.pg-overlay__degraded-verdict').allTextContents(),
    ]
    expect(verdicts.filter((value) => value.includes('✓')).length).toBe(12)
    expect(verdicts.filter((value) => value.includes('✗')).length).toBe(3)
    expect(verdicts).toHaveLength(15)
    await expect(guard).toContainText(/0\.5\s*\+\s*1\/3|88|225\s*(?:kg|千克)/)
  })

  test('blank sheet stays solve-only and does not create a mistake projection', async ({ page }) => {
    childName = `空白卷-${e2eMarker('child')}`
    const owner = await createTutor(page, childName)
    const before = await backupRecordCount(page, owner)
    const guard = await uploadAndConfirm(page, owner, FIXTURES.blank)
    const answers = await guard.locator('input[data-testid^="rq-answer-"]').inputValues()
    expect(answers.length).toBeGreaterThan(0)
    expect(answers.every((answer) => answer.trim() === '')).toBe(true)
    await expect(guard.getByTestId('recognize-grade-all')).toHaveCount(0)
    await expect(guard.getByTestId('recognize-solve-all')).toBeVisible()
    await guard.getByTestId('recognize-solve-all').click()
    await expect(guard.getByTestId('photo-grade-overlay')).toHaveCount(0)
    expect(await backupRecordCount(page, owner)).toBe(before)
  })
})
