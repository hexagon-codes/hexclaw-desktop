import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test, type APIResponse, type Locator, type Page } from '@playwright/test'
import { e2eMarker } from './helpers'
import { cleanupK12Child } from './live-fixture-cleanup'

/** E2E-RESP-001 + E2E-A11Y-001 + NFR-A11Y/UI: real DOM geometry and keyboard semantics. */
const LIVE = process.env.HEX_K12_ACCEPTANCE_LIVE === '1'
const LIVE_VISION = LIVE && process.env.HEX_K12_REAL_MODEL === '1'
const DOCS_ROOT = process.env.HEXCLAW_DOCS_ROOT || resolve(process.cwd(), '../hexclaw-docs')
const CLEAR = {
  id: 'FX-MATH-D5-CLEAR-001',
  path: process.env.HEX_K12_PHOTO_CLEAR || resolve(DOCS_ROOT, 'test/k12-test-批改作业.png'),
  sha256: '0c4b1a972319203b1483ffbce43e8835b1367be53edceea23c89368a2f2bc861',
  bytes: 2_178_059,
} as const

const VIEWPORTS = [
  { width: 1440, height: 900, slug: '1440x900' },
  { width: 1280, height: 720, slug: '1280x720' },
  { width: 390, height: 844, slug: '390x844' },
  { width: 320, height: 568, slug: '320x568' },
] as const

type Box = { x: number; y: number; width: number; height: number }

function verifyClearFixture(): Buffer {
  const bytes = readFileSync(CLEAR.path)
  expect(statSync(CLEAR.path).isFile()).toBe(true)
  expect(bytes.length, `${CLEAR.id} byte count drift`).toBe(CLEAR.bytes)
  expect(createHash('sha256').update(bytes).digest('hex'), `${CLEAR.id} SHA drift`).toBe(CLEAR.sha256)
  expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  return bytes
}

async function json<T>(response: APIResponse): Promise<T> {
  const text = await response.text()
  expect(response.ok(), `${new URL(response.url()).pathname} => ${response.status()} (body redacted)`).toBe(true)
  return JSON.parse(text) as T
}

async function createTutorAndOpenArchive(page: Page, childName: string): Promise<string> {
  await page.addInitScript(() => sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1'))
  await page.goto('/agents', { waitUntil: 'domcontentloaded' })
  const skip = page.getByRole('button', { name: '跳过' })
  if (await skip.isVisible().catch(() => false)) await skip.click()
  await page.getByText('模板库', { exact: false }).first().click()
  await page.getByText('作业辅导助手', { exact: false }).first().click()
  const createDialog = page.getByRole('dialog')
  await createDialog.locator('.k12pf__input').fill(childName)
  await createDialog.locator('.hc-select__trigger').nth(0).click()
  await page.locator('.hc-select__dropdown .hc-select__option', { hasText: '五年级下' }).click()
  await createDialog.getByRole('button', { name: '创建', exact: true }).click()
  await expect(createDialog).toHaveCount(0, { timeout: 30_000 })
  const agents = await json<{ agents?: Array<{ name?: string; metadata?: Record<string, string> }> }>(
    await page.request.get('/_hexclaw/api/v1/agents'),
  )
  const matches = (agents.agents || []).filter((agent) => agent.metadata?.['k12.child_name'] === childName)
  expect(matches).toHaveLength(1)
  const owner = matches[0]!.name!
  await page.getByText('我的智能体', { exact: false }).first().click()
  await page.locator('.hc-cxcard', { hasText: childName }).getByRole('button', { name: /错题本|学习档案/ }).click()
  await expect(page.locator('.k12rec')).toBeVisible({ timeout: 30_000 })
  return owner
}

async function assertNoHorizontalOverflow(page: Page, label: string): Promise<void> {
  const overflow = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    body: document.body.scrollWidth - document.body.clientWidth,
  }))
  expect(overflow.document, `${label}: document must not horizontally overflow`).toBeLessThanOrEqual(1)
  expect(overflow.body, `${label}: body must not horizontally overflow`).toBeLessThanOrEqual(1)
}

async function assertInsideViewport(page: Page, locator: Locator, label: string): Promise<Box> {
  await expect(locator, `${label} must remain visible`).toBeVisible()
  await locator.scrollIntoViewIfNeeded()
  const box = await locator.boundingBox()
  expect(box, `${label} must have rendered geometry`).not.toBeNull()
  const viewport = page.viewportSize()!
  expect(box!.x, `${label} left edge`).toBeGreaterThanOrEqual(-1)
  expect(box!.y, `${label} top edge`).toBeGreaterThanOrEqual(-1)
  expect(box!.x + box!.width, `${label} right edge`).toBeLessThanOrEqual(viewport.width + 1)
  expect(box!.y + box!.height, `${label} bottom edge`).toBeLessThanOrEqual(viewport.height + 1)
  return box!
}

async function unnamedControls(scope: Locator): Promise<string[]> {
  return scope.locator('button, a[href], input:not([type="hidden"]), textarea, select, [role="button"], [role="tab"], [role="radio"], [role="menuitem"]').evaluateAll((nodes) => {
    function labelledBy(node: Element): string {
      return (node.getAttribute('aria-labelledby') || '')
        .split(/\s+/)
        .filter(Boolean)
        .map((id) => document.getElementById(id)?.textContent || '')
        .join(' ')
    }
    function labelText(node: Element): string {
      const control = node as HTMLInputElement
      const explicit = control.id ? document.querySelector(`label[for="${CSS.escape(control.id)}"]`)?.textContent : ''
      return explicit || node.closest('label')?.textContent || ''
    }
    return nodes.filter((node) => {
      const element = node as HTMLElement
      if (element.hidden || element.getAttribute('aria-hidden') === 'true') return false
      const style = getComputedStyle(element)
      if (style.display === 'none' || style.visibility === 'hidden') return false
      const name = [
        element.getAttribute('aria-label'), labelledBy(element), labelText(element),
        element.getAttribute('alt'), element.getAttribute('title'), element.innerText,
      ].find((value) => value?.trim())
      return !name
    }).map((node) => `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''}${node.getAttribute('data-testid') ? `[data-testid=${node.getAttribute('data-testid')}]` : ''}`)
  })
}

test('§1.2 responsive/a11y gate freezes the clear-sheet source identity', () => {
  test.skip(!existsSync(CLEAR.path), `NOT RUN: private fixture is absent: ${CLEAR.id}`)
  verifyClearFixture()
})

test.describe('K12 responsive and accessibility release gate', () => {
  test.setTimeout(12 * 60_000)
  test.skip(!LIVE, 'NOT RUN: set HEX_K12_ACCEPTANCE_LIVE=1 for an isolated current-source Desktop + sidecar')
  let childName = ''
  test.afterEach(async ({ request }) => {
    await cleanupK12Child(request, childName)
    childName = ''
    verifyClearFixture()
  })

  test('core archive and add-work dialog stay operable at four canonical viewports and 200% zoom', async ({ page }) => {
    childName = `响应式-${e2eMarker('child')}`
    await page.setViewportSize(VIEWPORTS[0])
    await createTutorAndOpenArchive(page, childName)

    for (const viewport of VIEWPORTS) {
      await page.setViewportSize(viewport)
      await page.evaluate(() => { document.documentElement.style.zoom = '1' })
      await page.getByTestId('subtab-works').click()
      await expect(page.getByTestId('works-section')).toBeVisible()
      await assertNoHorizontalOverflow(page, viewport.slug)
      await assertInsideViewport(page, page.getByTestId('subtab-works'), `${viewport.slug} works tab`)
      const add = page.getByTestId('cw-add-open')
      const addBox = await assertInsideViewport(page, add, `${viewport.slug} add-work`)
      if (viewport.width <= 390) {
        expect(Math.max(addBox.width, addBox.height), `${viewport.slug} add-work touch target`).toBeGreaterThanOrEqual(44)
      }
      await add.click()
      const overlay = page.getByTestId('cw-add-modal')
      const dialog = overlay.getByRole('dialog')
      await assertInsideViewport(page, dialog, `${viewport.slug} add-work dialog`)
      await assertInsideViewport(page, dialog.getByTestId('cw-add-photo'), `${viewport.slug} photo dropzone`)
      await assertInsideViewport(page, dialog.getByTestId('cw-add-submit'), `${viewport.slug} save action`)
      await assertNoHorizontalOverflow(page, `${viewport.slug} modal`)
      await page.screenshot({ path: `test-results/k12-responsive-${viewport.slug}.png`, fullPage: true })
      await dialog.getByRole('button', { name: /取消/ }).last().click()
      await expect(overlay).toHaveCount(0)
    }

    await page.setViewportSize({ width: 640, height: 1136 })
    await page.evaluate(() => { document.documentElement.style.zoom = '2' })
    await page.getByTestId('subtab-works').click()
    await assertNoHorizontalOverflow(page, '200% zoom')
    await assertInsideViewport(page, page.getByTestId('cw-add-open'), '200% zoom add-work')
    await page.getByTestId('cw-add-open').click()
    await assertInsideViewport(page, page.getByTestId('cw-add-modal').getByRole('dialog'), '200% zoom dialog')
    await assertInsideViewport(page, page.getByTestId('cw-add-submit'), '200% zoom save action')
    await page.screenshot({ path: 'test-results/k12-responsive-200-percent.png', fullPage: true })
  })

  test('archive controls and add-work modal expose names, roles, states, focus and Escape return', async ({ page }) => {
    childName = `无障碍-${e2eMarker('child')}`
    await page.setViewportSize({ width: 1280, height: 720 })
    await createTutorAndOpenArchive(page, childName)
    await expect(unnamedControls(page.locator('.k12rec'))).resolves.toEqual([])

    const works = page.getByTestId('subtab-works')
    await works.focus()
    await page.keyboard.press('Enter')
    await expect(works).toHaveClass(/on/)
    await expect(works).toBeFocused()
    const focusStyle = await works.evaluate((node) => {
      const style = getComputedStyle(node)
      return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth }
    })
    expect(focusStyle.outlineStyle).not.toBe('none')
    expect(Number.parseFloat(focusStyle.outlineWidth)).toBeGreaterThanOrEqual(2)

    const opener = page.getByTestId('cw-add-open')
    await opener.focus()
    await page.keyboard.press('Enter')
    const overlay = page.getByTestId('cw-add-modal')
    const dialog = overlay.getByRole('dialog')
    await expect(dialog).toHaveAttribute('aria-modal', 'true')
    await expect(dialog).toHaveAccessibleName(/作品|添加/)
    await expect(dialog.getByRole('radiogroup')).toHaveAccessibleName(/类型/)
    const writing = dialog.getByTestId('cw-add-type-writing')
    const art = dialog.getByTestId('cw-add-type-art')
    await expect(writing).toHaveAttribute('aria-pressed', 'true')
    await art.focus()
    await page.keyboard.press('Space')
    await expect(art).toHaveAttribute('aria-pressed', 'true')
    await expect(writing).toHaveAttribute('aria-pressed', 'false')
    await expect(unnamedControls(overlay)).resolves.toEqual([])
    expect(await page.locator('[id]').evaluateAll((nodes) => {
      const ids = nodes.map((node) => node.id).filter(Boolean)
      return ids.filter((id, index) => ids.indexOf(id) !== index)
    }), 'DOM ids must be unique for label/description resolution').toEqual([])
    await page.keyboard.press('Escape')
    await expect(overlay, 'Escape must close the modal').toHaveCount(0)
    await expect(opener, 'modal close must restore focus to its opener').toBeFocused()
  })

  test('reduced-motion keeps the core journey stable and disables infinite decorative motion', async ({ page }) => {
    childName = `减少动态-${e2eMarker('child')}`
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await createTutorAndOpenArchive(page, childName)
    await page.getByTestId('subtab-works').click()
    await page.getByTestId('cw-add-open').click()
    const offenders = await page.locator('body *').evaluateAll((nodes) => nodes.flatMap((node) => {
      const style = getComputedStyle(node)
      if (style.display === 'none' || style.visibility === 'hidden') return []
      return style.animationIterationCount === 'infinite' && style.animationName !== 'none'
        ? [`${node.tagName.toLowerCase()}.${(node as HTMLElement).className}`]
        : []
    }))
    expect(offenders, 'prefers-reduced-motion must not leave infinite decorative animations running').toEqual([])
    await expect(page.getByTestId('cw-add-modal').getByRole('dialog')).toBeVisible()
  })

  test('real photo recognition is completable by keyboard with named live status and non-color verdicts', async ({ page }) => {
    test.skip(!LIVE_VISION, 'NOT RUN: requires HEX_K12_REAL_MODEL=1 and an authorized vision provider')
    childName = `键盘批改-${e2eMarker('child')}`
    const owner = await createTutorAndOpenArchive(page, childName)
    await page.getByRole('button', { name: '辅导', exact: true }).click()
    const source = verifyClearFixture()
    const requestPromise = page.waitForRequest((request) =>
      request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/api/k12/grading-jobs'),
    )
    await page.locator('.hc-composer input[type="file"]').setInputFiles(CLEAR.path)
    const request = await requestPromise
    const payload = request.postDataJSON() as { agent?: string; image_base64?: string }
    expect(payload.agent).toBe(owner)
    expect(createHash('sha256').update(Buffer.from(payload.image_base64 || '', 'base64')).digest('hex')).toBe(CLEAR.sha256)
    expect(Buffer.from(payload.image_base64 || '', 'base64')).toHaveLength(source.length)

    const message = page.getByTestId('k12-photo-assistant-message').last()
    const guard = message.getByTestId('recognize-guard')
    await expect(guard).toBeVisible({ timeout: 30_000 })
    await expect(guard.locator('[aria-live], [role="status"]').first(), 'recognition progress must be announced').toBeAttached()
    await expect(guard.getByTestId('rq-item').first()).toBeVisible({ timeout: 6 * 60_000 })
    for (const checkbox of await guard.locator('input[data-testid^="rq-confirm-"]').all()) {
      await checkbox.focus()
      await page.keyboard.press('Space')
      await expect(checkbox).toBeChecked()
    }
    const confirm = guard.getByTestId('recognize-confirm-all')
    await confirm.focus()
    await page.keyboard.press('Enter')
    await expect(guard.getByTestId('recognize-batch-actions')).toBeVisible()
    const grade = guard.getByTestId('recognize-grade-all')
    await grade.focus()
    await page.keyboard.press('Enter')
    const overlay = guard.getByTestId('photo-grade-overlay')
    await expect(overlay).toBeVisible({ timeout: 8 * 60_000 })
    await expect(overlay, 'verdicts need text/symbol meaning in addition to color').toContainText(/正确|错误|对|错|✓|✗/)
    await expect(unnamedControls(guard)).resolves.toEqual([])
  })
})
