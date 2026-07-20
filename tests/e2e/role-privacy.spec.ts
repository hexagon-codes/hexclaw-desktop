import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test, type APIResponse, type Page } from '@playwright/test'
import { BASE_URL, e2eMarker } from './helpers'
import { cleanupK12Child } from './live-fixture-cleanup'

/** E2E-AUTH/PRIV/MULTI + NFR-PRIV: visible owner boundaries, not CSS-only hiding. */
const LIVE = process.env.HEX_K12_ACCEPTANCE_LIVE === '1'
const ROLE_MODE = process.env.HEX_K12_ROLE_MODE === '1'
const DOCS_ROOT = process.env.HEXCLAW_DOCS_ROOT || resolve(process.cwd(), '../hexclaw-docs')
const ART = {
  id: 'FX-ART-001',
  path: process.env.HEX_K12_ART_IMAGE || resolve(DOCS_ROOT, 'test/k12-test-美术.png'),
  sha256: '7eb16fdbe398236cdf2ce31ea6d2fac5e4787ea3004b96ab74a3eebd540f1d93',
  bytes: 2_713_090,
} as const

type Json = Record<string, unknown>

async function json<T>(response: APIResponse): Promise<T> {
  const text = await response.text()
  expect(response.ok(), `${new URL(response.url()).pathname} => ${response.status()} (body redacted)`).toBe(true)
  return JSON.parse(text) as T
}

function verifyArt(): Buffer {
  const bytes = readFileSync(ART.path)
  expect(statSync(ART.path).isFile()).toBe(true)
  expect(bytes.length).toBe(ART.bytes)
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(ART.sha256)
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
  await dialog.getByRole('button', { name: '创建', exact: true }).click()
  await expect(dialog).toHaveCount(0, { timeout: 30_000 })
  const agents = await json<{ agents?: Array<{ name?: string; metadata?: Record<string, string> }> }>(
    await page.request.get('/_hexclaw/api/v1/agents'),
  )
  const matches = (agents.agents || []).filter((agent) => agent.metadata?.['k12.child_name'] === childName)
  expect(matches).toHaveLength(1)
  return matches[0]!.name!
}

async function openWorks(page: Page, childName: string): Promise<void> {
  await page.goto('/agents', { waitUntil: 'domcontentloaded' })
  await page.getByText('我的智能体', { exact: false }).first().click()
  await page.locator('.hc-cxcard', { hasText: childName }).getByRole('button', { name: /错题本|学习档案/ }).click()
  await expect(page.locator('.k12rec')).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('subtab-works').click()
  await expect(page.getByTestId('works-section')).toBeVisible()
}

async function createArt(page: Page, title: string): Promise<{ recordID: string; assetID: string }> {
  verifyArt()
  await page.getByTestId('cw-add-open').click()
  const modal = page.getByTestId('cw-add-modal')
  await modal.getByTestId('cw-add-type-art').click()
  const assetResponse = page.waitForResponse((response) =>
    response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/api/k12/assets'),
  )
  await modal.getByTestId('cw-add-photo-input').setInputFiles(ART.path)
  const asset = await json<{ asset_id: string }>(await assetResponse)
  await expect(modal.getByTestId('cw-photo-ok'), 'visible upload must reach a server-confirmed asset').toBeVisible()
  await modal.getByTestId('cw-add-title').fill(title)
  await modal.getByTestId('cw-add-task').fill('owner isolation fixture')
  const createResponse = page.waitForResponse((response) =>
    response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/api/k12/creative-works'),
  )
  await expect(modal.getByTestId('cw-add-submit')).toBeEnabled()
  await modal.getByTestId('cw-add-submit').click()
  const created = await json<{ record_id: string }>(await createResponse)
  return { recordID: created.record_id, assetID: asset.asset_id }
}

test('§1.2 privacy source reads the frozen art SHA without logging payload bytes', () => {
  test.skip(!existsSync(ART.path), `NOT RUN: private fixture is absent: ${ART.id}`)
  verifyArt()
})

test.describe('K12 role and privacy release boundary', () => {
  test.setTimeout(10 * 60_000)
  test.skip(!LIVE, 'NOT RUN: set HEX_K12_ACCEPTANCE_LIVE=1 for an isolated current-source Desktop + sidecar')
  const cleanupNames = new Set<string>()
  test.afterEach(async ({ request }) => {
    for (const childName of cleanupNames) await cleanupK12Child(request, childName)
    cleanupNames.clear()
    verifyArt()
  })

  test('same real image remains owner-scoped in DOM, asset HTTP and CreativeWork detail', async ({ page }) => {
    const childA = `隐私甲-${e2eMarker('child')}`
    const childB = `隐私乙-${e2eMarker('child')}`
    cleanupNames.add(childA)
    cleanupNames.add(childB)
    const ownerA = await createTutor(page, childA)
    const ownerB = await createTutor(page, childB)

    await openWorks(page, childA)
    const title = `仅甲可见-${e2eMarker('work')}`
    const createdA = await createArt(page, title)
    expect(createdA.assetID).toContain(ART.sha256)
    expect(createdA.assetID).toContain(`asset://${ownerA}/`)
    const file = createdA.assetID.slice(createdA.assetID.lastIndexOf('/') + 1)
    const ownAsset = await page.request.get(`${BASE_URL}/api/k12/assets/${encodeURIComponent(file)}?agent=${encodeURIComponent(ownerA)}`)
    expect(ownAsset.ok()).toBe(true)
    expect(createHash('sha256').update(Buffer.from(await ownAsset.body())).digest('hex')).toBe(ART.sha256)
    const crossAsset = await page.request.get(`${BASE_URL}/api/k12/assets/${encodeURIComponent(file)}?agent=${encodeURIComponent(ownerB)}`)
    expect([403, 404], 'another Tutor owner must not read the source image').toContain(crossAsset.status())
    const crossWork = await page.request.get(`${BASE_URL}/api/k12/creative-works/${encodeURIComponent(createdA.recordID)}?agent=${encodeURIComponent(ownerB)}`)
    expect([403, 404], 'another Tutor owner must not resolve the record id').toContain(crossWork.status())

    await openWorks(page, childB)
    await expect(page.getByTestId('works-section')).not.toContainText(title)
    const createdB = await createArt(page, `乙作品-${e2eMarker('work')}`)
    expect(createdB.assetID).toContain(ART.sha256)
    expect(createdB.assetID).toContain(`asset://${ownerB}/`)
    expect(createdB.assetID).not.toBe(createdA.assetID)
  })

  test('common privacy notice remains in Settings without a K12-only data-route promise', async ({ page }) => {
    for (const path of ['/agents', '/knowledge', '/settings']) {
      await page.goto(path, { waitUntil: 'domcontentloaded' })
      await expect(page.locator('body')).not.toContainText(/儿童数据路由|K12\s*数据路由|儿童专属云端同意|儿童数据地域/)
    }
    const notice = page.getByTestId('third-party-ai-services-notice')
    const link = notice.getByTestId('third-party-ai-services-link')
    await expect(notice, 'privacy disclosure stays in the common Provider settings').toBeVisible()
    await expect(link).toHaveAttribute('href', /\/zh\/third-party-ai-services$/)
    await expect(link).toHaveAttribute('target', '_blank')
    await expect(link).toHaveAttribute('rel', /noopener/)
  })

  test('child role cannot reach answer/export/delete/model controls or mutate them', async ({ page }) => {
    test.skip(!ROLE_MODE, 'NOT RUN: set HEX_K12_ROLE_MODE=1 only when the build exposes the approved parent/child role switch and authentication fixture')
    const childName = `孩子模式-${e2eMarker('child')}`
    cleanupNames.add(childName)
    await createTutor(page, childName)
    const switcher = page.getByRole('button', { name: /进入孩子模式|孩子模式/ })
    await expect(switcher, 'authorized role-mode build must expose a visible mode switch').toBeVisible()
    await switcher.click()
    await openWorks(page, childName)
    const archive = page.locator('.k12rec__export > button')
    if (await archive.isVisible().catch(() => false)) {
      await archive.click()
      await expect(page.locator('.k12rec__menu')).not.toContainText(/导出|备份|恢复/)
    }
    await expect(page.getByTestId('k12pf-delete')).toHaveCount(0)
    await page.goto('/settings', { waitUntil: 'domcontentloaded' })
    await expect(page.locator('body')).not.toContainText(/模型服务商|删除所有数据|导出数据/)
  })

  test('third-party embedding payload boundary is checked by an external capture fixture', async ({ page }) => {
    const spyURL = process.env.HEX_K12_THIRD_PARTY_SPY_URL
    const cloudLabel = process.env.HEX_K12_CLOUD_EMBEDDING_LABEL
    test.skip(!spyURL || !cloudLabel, 'NOT RUN: requires HEX_K12_THIRD_PARTY_SPY_URL and HEX_K12_CLOUD_EMBEDDING_LABEL for sidecar-outbound capture')
    const reset = await fetch(`${spyURL!.replace(/\/$/, '')}/requests`, { method: 'DELETE' })
    expect(reset.ok).toBe(true)
    await page.goto('/knowledge', { waitUntil: 'domcontentloaded' })
    const card = page.getByTestId('kb-semantic-index-card')
    await card.getByTestId('kb-semantic-index-header').click()
    await card.getByTestId('kb-index-model-trigger').click()
    await page.getByRole('option', { name: cloudLabel!, exact: true }).click()
    const captured = await fetch(`${spyURL!.replace(/\/$/, '')}/requests`).then((response) => response.json()) as { requests?: Json[] }
    expect(captured.requests?.length, 'enabled capture lane must observe at least one real outbound request').toBeGreaterThan(0)
    for (const request of captured.requests || []) {
      const serialized = JSON.stringify(request)
      expect(serialized).not.toContain(ART.path)
      expect(serialized).not.toContain('k12-test-美术.png')
      expect(serialized).not.toContain(readFileSync(ART.path).toString('base64').slice(0, 128))
    }
  })
})
