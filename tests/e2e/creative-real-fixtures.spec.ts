import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test, type APIResponse, type Page } from '@playwright/test'
import { BASE_URL, e2eMarker } from './helpers'
import { cleanupK12Child } from './live-fixture-cleanup'

/** REG-UPLOAD/WRITING/ART + INT/E2E-CREATIVE real-source release gate. */
const LIVE = process.env.HEX_K12_ACCEPTANCE_LIVE === '1'
const LIVE_AI = LIVE && process.env.HEX_K12_REAL_MODEL === '1' && process.env.HEX_K12_CREATIVE_AI === '1'
const DOCS_ROOT = process.env.HEXCLAW_DOCS_ROOT || resolve(process.cwd(), '../hexclaw-docs')
const FIXTURES = {
  writing: {
    id: 'FX-WRITING-001', path: process.env.HEX_K12_WRITING_IMAGE || resolve(DOCS_ROOT, 'test/k12-test-作文.png'),
    sha256: '3b238c46e0ae4515f7b35a28bcfd37081ba1d59a9dfa2b30bf17784aaf3e9157', bytes: 2_509_035,
    width: 1086, height: 1448,
  },
  art: {
    id: 'FX-ART-001', path: process.env.HEX_K12_ART_IMAGE || resolve(DOCS_ROOT, 'test/k12-test-美术.png'),
    sha256: '7eb16fdbe398236cdf2ce31ea6d2fac5e4787ea3004b96ab74a3eebd540f1d93', bytes: 2_713_090,
    width: 1254, height: 1254,
  },
} as const

type Fixture = (typeof FIXTURES)[keyof typeof FIXTURES]
type Json = Record<string, unknown>

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
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
  expect(response.ok(), `${new URL(response.url()).pathname} => ${response.status()} (body redacted)`).toBe(true)
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

  const agents = await json<{ agents?: Array<{ name?: string; metadata?: Record<string, string> }> }>(
    await page.request.get('/_hexclaw/api/v1/agents'),
  )
  const matches = (agents.agents || []).filter((agent) => agent.metadata?.['k12.child_name'] === childName)
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
  const uploadResponse = page.waitForResponse((response) =>
    response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/api/k12/assets'),
  )
  await page.getByTestId('cw-add-photo-input').setInputFiles(fixture.path)
  const response = await uploadResponse
  const payload = await json<{ asset_id: string; size: number }>(response)
  expect(payload.size).toBe(source.length)
  expect(payload.asset_id).toContain(fixture.sha256)
  await expect(page.getByTestId('cw-photo-ok'), 'upload success must come from a server-confirmed asset id').toBeVisible()
  return payload.asset_id
}

async function listWorks(page: Page, owner: string): Promise<Json[]> {
  const response = await page.request.get(`${BASE_URL}/api/k12/creative-works?agent=${encodeURIComponent(owner)}`)
  return (await json<{ items?: Json[] }>(response)).items || []
}

test('§1.2 creative manifest freezes writing and art source bytes', () => {
  const missing = Object.values(FIXTURES).filter((fixture) => !existsSync(fixture.path)).map((fixture) => fixture.id)
  test.skip(missing.length > 0, `NOT RUN: private fixture(s) absent: ${missing.join(', ')}`)
  for (const fixture of Object.values(FIXTURES)) verifyFixture(fixture)
})

test.describe('real creative source, OCR, owner and feedback', () => {
  test.setTimeout(15 * 60_000)
  test.skip(!LIVE, 'NOT RUN: set HEX_K12_ACCEPTANCE_LIVE=1 for an isolated current-source Desktop + sidecar')
  let childName = ''
  test.afterEach(async ({ request }) => {
    await cleanupK12Child(request, childName)
    childName = ''
    for (const fixture of Object.values(FIXTURES)) verifyFixture(fixture)
  })

  test('art upload stores the frozen image under the exact Tutor owner and round-trips its bytes', async ({ page }) => {
    childName = `美术原图-${e2eMarker('child')}`
    const owner = await createTutorAndOpenWorks(page, childName)
    const modal = await openAddWork(page, 'art')
    await expect(modal.getByTestId('cw-add-submit'), 'art cannot be saved before a real image is selected').toBeDisabled()
    const assetID = await uploadWorkPhoto(page, FIXTURES.art)
    expect(assetID).toMatch(new RegExp(`^asset://${owner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`))
    await modal.getByTestId('cw-add-title').fill(`彩虹女孩-${e2eMarker('work')}`)
    await modal.getByTestId('cw-add-task').fill('画一幅包含人物、动物和彩虹的彩铅画')
    await modal.getByTestId('cw-add-intent').fill('练习人物、猫和彩虹的构图关系')
    await expect(modal.getByTestId('cw-add-submit')).toBeEnabled()
    await modal.getByTestId('cw-add-submit').click()
    await expect(modal).toHaveCount(0, { timeout: 30_000 })

    const work = (await listWorks(page, owner)).find((item) => item.title?.toString().startsWith('彩虹女孩-'))
    expect(work, 'visible save must create a sidecar CreativeWork').toBeTruthy()
    expect(work?.work_type).toBe('art')
    const versions = work?.versions as Json[]
    expect(versions).toHaveLength(1)
    expect(versions[0]?.source_asset_id).toBe(assetID)

    const thumb = page.getByTestId('cw-thumb').first()
    await expect(thumb).toBeVisible()
    const src = await thumb.getAttribute('src')
    expect(src).toBeTruthy()
    const bytes = Buffer.from(await (await page.request.get(src!)).body())
    expect(sha256(bytes), 'rendered thumbnail must return the immutable original bytes').toBe(FIXTURES.art.sha256)
    await expect(page.getByTestId('works-section')).not.toContainText(/评分|排名|分数/)
  })

  test('writing photo requires OCR confirmation, source-grounded feedback and a non-empty v2', async ({ page }) => {
    test.skip(!LIVE_AI, 'NOT RUN: requires HEX_K12_REAL_MODEL=1 and HEX_K12_CREATIVE_AI=1 for authorized OCR/feedback')
    childName = `作文原图-${e2eMarker('child')}`
    const owner = await createTutorAndOpenWorks(page, childName)
    const modal = await openAddWork(page, 'writing')
    const assetID = await uploadWorkPhoto(page, FIXTURES.writing)
    expect(assetID).toContain(FIXTURES.writing.sha256)
    await expect(modal.getByTestId('cw-ocr-awaiting'), 'photo writing cannot skip the persisted OCR confirmation stop').toBeVisible({ timeout: 6 * 60_000 })
    const draft = modal.getByTestId('cw-add-draft')
    const confirmedText = await draft.inputValue()
    expect(confirmedText, 'OCR draft must be the fixture content, not the old campus-spring sample').toMatch(/我的好爸爸|爸爸/)
    await modal.getByTestId('cw-ocr-confirm').click()
    await expect(modal.getByTestId('cw-ocr-confirmed')).toBeVisible({ timeout: 60_000 })
    const title = `我的好爸爸-${e2eMarker('work')}`
    await modal.getByTestId('cw-add-title').fill(title)
    await modal.getByTestId('cw-add-task').fill('围绕真实人物与具体事件完成写人作文')
    await expect(modal.getByTestId('cw-add-submit')).toBeEnabled()
    await modal.getByTestId('cw-add-submit').click()
    await expect(modal).toHaveCount(0, { timeout: 30_000 })

    const card = page.locator('.k12cw__card', { hasText: title })
    await expect(card).toBeVisible()
    await card.getByTestId('cw-detail-toggle').click()
    const detail = page.getByTestId('cw-detail-modal')
    await expect(detail).toBeVisible()
    await detail.getByTestId('cw-feedback-generate').click()
    await expect(detail.getByTestId('cw-structured-feedback')).toBeVisible({ timeout: 6 * 60_000 })
    const feedback = await detail.getByTestId('cw-structured-feedback').innerText()
    expect(feedback).toMatch(/爸爸|程序员|河蟹|AI|数学/)
    expect(feedback).not.toMatch(/校园春景|柳枝像绿色丝带|评分|排名/)
    await expect(detail.getByTestId('cw-feedback-provenance').first()).toContainText(/AI|方法|证据/)

    const revision = `第二稿-${e2eMarker('revision')}：我补充了爸爸用提问引导我检查数学步骤的细节。`
    await detail.getByTestId('cw-revision-input').fill(revision)
    await detail.getByTestId('cw-revision-submit').click()
    await expect(detail.locator('[data-testid="cw-version-content"]')).toHaveCount(2, { timeout: 30_000 })

    const work = (await listWorks(page, owner)).find((item) => item.title === title)!
    const versions = work.versions as Json[]
    expect(versions).toHaveLength(2)
    expect(versions[0]?.source_asset_id).toBe(assetID)
    expect(versions[0]?.ocr_job_id).toBeTruthy()
    expect(versions[0]?.ocr_confirmed_digest).toBeTruthy()
    expect(versions[0]?.content_markdown).toBe(confirmedText.trim())
    expect(versions[1]?.content_markdown).toBe(revision)
  })

  test('art feedback cites visible elements and produces a real observation card', async ({ page }) => {
    test.skip(!LIVE_AI, 'NOT RUN: requires authorized creative feedback generation')
    childName = `美术点评-${e2eMarker('child')}`
    const owner = await createTutorAndOpenWorks(page, childName)
    const modal = await openAddWork(page, 'art')
    await uploadWorkPhoto(page, FIXTURES.art)
    const title = `彩虹和小猫-${e2eMarker('work')}`
    await modal.getByTestId('cw-add-title').fill(title)
    await modal.getByTestId('cw-add-task').fill('观察人物、猫、彩虹和地面的构图')
    await modal.getByTestId('cw-add-intent').fill('想画快乐的户外场景')
    await modal.getByTestId('cw-add-submit').click()
    const card = page.locator('.k12cw__card', { hasText: title })
    await expect(card).toBeVisible({ timeout: 30_000 })
    await card.getByTestId('cw-detail-toggle').click()
    const detail = page.getByTestId('cw-detail-modal')
    await expect(detail).toBeVisible()
    await detail.getByTestId('cw-feedback-generate').click()
    await expect(detail.getByTestId('cw-structured-feedback')).toBeVisible({ timeout: 6 * 60_000 })
    const persisted = (await listWorks(page, owner)).find((item) => item.title === title)
    const versions = Array.isArray(persisted?.versions) ? (persisted.versions as Json[]) : []
    const structured = versions.at(-1)?.structured_feedback as Json
    expect(structured).toBeTruthy()
    const projection = String(structured.projection_markdown)
    expect(projection).toMatch(/女孩|人物/)
    expect(projection).toMatch(/猫/)
    expect(projection).toMatch(/彩虹/)
    expect(projection).not.toMatch(/(?:未|没有|没能|看不(?:见|清)|无法(?:确认|识别))[^。；\n]{0,16}(?:女孩|人物)/)
    expect(projection).not.toMatch(/(?:未|没有|没能|看不(?:见|清)|无法(?:确认|识别))[^。；\n]{0,16}(?:小猫|猫)/)
    expect(projection).not.toMatch(/(?:未|没有|没能|看不(?:见|清)|无法(?:确认|识别))[^。；\n]{0,16}彩虹/)
    const text = await detail.getByTestId('cw-structured-feedback').innerText()
    expect(text).toMatch(/(?:中央|中间)[^。；\n]{0,48}(?:女孩|人物)|(?:女孩|人物)[^。；\n]{0,48}(?:中央|中间)/)
    expect(text).toMatch(/(?:笑脸|橙|橘|画面|人物)[^。；\n]{0,32}(?:小猫|猫)|(?:小猫|猫)[^。；\n]{0,32}(?:笑脸|橙|橘|画面|人物)/)
    expect(text).toMatch(/(?:明亮|白云|云朵|颜色|左上|上方)[^。；\n]{0,32}彩虹|彩虹[^。；\n]{0,32}(?:明亮|白云|云朵|颜色|爱心|星星)/)
    expect(text).not.toMatch(/(?:未|没有|没能|看不(?:见|清)|无法(?:确认|识别))[^。；\n]{0,16}(?:女孩|人物)/)
    expect(text).not.toMatch(/(?:未|没有|没能|看不(?:见|清)|无法(?:确认|识别))[^。；\n]{0,16}(?:小猫|猫)/)
    expect(text).not.toMatch(/(?:未|没有|没能|看不(?:见|清)|无法(?:确认|识别))[^。；\n]{0,16}彩虹/)
    await expect(detail.getByTestId('cw-practice-card')).toBeVisible()
    const generatedContent = JSON.stringify({
      observations: structured.observations,
      suggestions: structured.suggestions,
    })
    expect(generatedContent).not.toMatch(/\d+\s*分(?!钟)|第[一二三四五六七八九十\d]+名|我来重画|帮你重画|代你画/)
    expect(String(structured.limitations)).toMatch(/不(?:评分|打分).*不排名.*不替孩子重画/)
  })
})
