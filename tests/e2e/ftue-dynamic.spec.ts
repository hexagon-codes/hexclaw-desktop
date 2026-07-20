import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test, type APIResponse, type Page } from '@playwright/test'
import { e2eMarker } from './helpers'
import { cleanupK12Child } from './live-fixture-cleanup'

/** REG-FTUE-001/002 + E2E-FTUE-001/002 against a real Desktop/sidecar profile. */
const LIVE = process.env.HEX_K12_ACCEPTANCE_LIVE === '1'
const LIVE_MODEL = process.env.HEX_K12_REAL_MODEL === '1'
const DOCS_ROOT = process.env.HEXCLAW_DOCS_ROOT || resolve(process.cwd(), '../hexclaw-docs')
const FTUE_FIXTURE = {
  id: 'FX-MATH-D5-CLEAR-001',
  path: process.env.HEX_K12_PHOTO_CLEAR || resolve(DOCS_ROOT, 'test/k12-test-批改作业.png'),
  sha256: '0c4b1a972319203b1483ffbce43e8835b1367be53edceea23c89368a2f2bc861',
  bytes: 2_178_059,
} as const

interface AgentProjection {
  name?: string
  display_name?: string
  metadata?: Record<string, string>
}

async function responseJSON<T>(response: APIResponse): Promise<T> {
  const body = await response.text()
  expect(response.ok(), `${response.url()} => ${response.status()} ${body}`).toBe(true)
  return JSON.parse(body) as T
}

async function listAgents(page: Page): Promise<AgentProjection[]> {
  const payload = await responseJSON<{ agents?: AgentProjection[] }>(
    await page.request.get('/_hexclaw/api/v1/agents'),
  )
  return payload.agents || []
}

async function openTutorTemplate(page: Page): Promise<void> {
  await page.addInitScript(() => sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1'))
  await page.goto('/agents', { waitUntil: 'domcontentloaded' })
  const skip = page.getByRole('button', { name: '跳过' })
  if (await skip.isVisible().catch(() => false)) await skip.click()
  await page.getByText('模板库', { exact: false }).first().click()
  await page.getByText('作业辅导助手', { exact: false }).first().click()
  await expect(page.getByRole('dialog')).toContainText('创建「作业辅导助手」')
}

async function createTutor(
  page: Page,
  childName: string,
  grade = '五年级下',
  textbook = '北师大版',
): Promise<AgentProjection> {
  const existingAgentNames = new Set((await listAgents(page)).map((agent) => agent.name).filter(Boolean))
  await openTutorTemplate(page)
  const dialog = page.getByRole('dialog')
  await dialog.locator('.k12pf__input').fill(childName)
  await dialog.locator('.hc-select__trigger').nth(0).click()
  await page.locator('.hc-select__dropdown .hc-select__option', { hasText: grade }).click()
  await dialog.locator('.hc-select__trigger').nth(1).click()
  await page.locator('.hc-select__dropdown .hc-select__option', { hasText: textbook }).click()

  const profileResponse = page.waitForResponse((response) =>
    response.request().method() === 'PUT' && new URL(response.url()).pathname.endsWith('/api/k12/profile'),
  )
  await dialog.getByRole('button', { name: '创建', exact: true }).click()
  expect((await profileResponse).ok(), '建档必须真实写入 K12 Profile，而不是只关闭弹窗').toBe(true)
  await expect(dialog).toHaveCount(0, { timeout: 30_000 })

  const matches = (await listAgents(page)).filter(
    (agent) => agent.metadata?.['k12.child_name'] === childName && !existingAgentNames.has(agent.name),
  )
  expect(matches, `${childName} 本次建档必须新增唯一 TutorAgent owner`).toHaveLength(1)
  expect(matches[0]?.name).toMatch(/^k12-tutor-/)
  expect(matches[0]?.metadata?.['k12.learner_id'], '展示名不能充当 learner owner key').toBeTruthy()
  expect(matches[0]?.metadata?.['k12.grade_term']).toBe(grade)
  expect(matches[0]?.metadata?.['k12.textbook_edition']).toBe(textbook)
  return matches[0]!
}

async function enterTutor(page: Page, childName: string): Promise<void> {
  await page.goto('/agents', { waitUntil: 'domcontentloaded' })
  await page.getByText('我的智能体', { exact: false }).first().click()
  const card = page.locator('.hc-cxcard', { hasText: childName }).first()
  await expect(card).toBeVisible({ timeout: 30_000 })
  await card.getByRole('button', { name: /进入辅导/ }).click()
  await expect(page).toHaveURL(/\/chat/, { timeout: 30_000 })
  await expect(page.locator('.hc-composer input[type="file"]'), '首会话必须有真实上传入口').toBeAttached()
}

test('§1.2 FTUE upload anchor reads the frozen real-fixture SHA', () => {
  test.skip(!existsSync(FTUE_FIXTURE.path), `NOT RUN: private fixture is absent: ${FTUE_FIXTURE.id}`)
  const bytes = readFileSync(FTUE_FIXTURE.path)
  expect(statSync(FTUE_FIXTURE.path).isFile()).toBe(true)
  expect(bytes.length).toBe(FTUE_FIXTURE.bytes)
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(FTUE_FIXTURE.sha256)
  expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
})

test.describe('dynamic K12 first-use owner and thread', () => {
  test.setTimeout(8 * 60_000)
  test.skip(!LIVE, 'NOT RUN: set HEX_K12_ACCEPTANCE_LIVE=1 for an isolated current-source Desktop + sidecar')

  const cleanupNames = new Set<string>()
  test.afterEach(async ({ request }) => {
    for (const childName of cleanupNames) await cleanupK12Child(request, childName)
    cleanupNames.clear()
  })

  test('non-default textbook persists through the visible template flow and refresh', async ({ page }) => {
    const childName = `动态建档-${e2eMarker('child')}`
    cleanupNames.add(childName)
    const owner = await createTutor(page, childName, '五年级下', '北师大版')
    await enterTutor(page, childName)
    await expect(page.locator('.k12enh-grade')).toContainText('五年级下')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.locator('.k12enh-name')).toContainText(childName)
    const persisted = (await listAgents(page)).find((agent) => agent.name === owner.name)
    expect(persisted?.metadata?.['k12.textbook_edition']).toBe('北师大版')
  })

  test('the first request creates a visible durable thread and survives refresh', async ({ page }) => {
    test.skip(!LIVE_MODEL, 'NOT RUN: set HEX_K12_REAL_MODEL=1 only when a real configured chat provider is authorized')
    const childName = `首消息-${e2eMarker('child')}`
    cleanupNames.add(childName)
    await createTutor(page, childName)
    await enterTutor(page, childName)

    const marker = e2eMarker('first-turn')
    const prompt = `请只回复 ${marker}`
    await page.getByTestId('chat-input').fill(prompt)
    await page.getByTestId('chat-send').click()
    await expect(page.getByTestId('chat-message-user').filter({ hasText: marker })).toBeVisible()
    const assistant = page.getByTestId('chat-message-assistant').last()
    await expect(assistant).toContainText(marker, { timeout: 180_000 })
    const active = page.locator('.hc-sessions__item--active')
    await expect(active, '首条消息必须创建左侧独立 thread').toBeVisible()
    const sessionID = await active.getAttribute('data-session-id')
    expect(sessionID).toBeTruthy()

    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByTestId('chat-message-user').filter({ hasText: marker })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('chat-message-assistant').filter({ hasText: marker })).toBeVisible()
    await expect(page.locator(`.hc-sessions__item[data-session-id="${sessionID}"]`)).toBeVisible()
  })

  test('two equal display names keep distinct learner and TutorAgent identities when one is renamed', async ({ page }) => {
    const sharedName = `同名-${e2eMarker('child')}`
    const renamed = `${sharedName}-改名`
    cleanupNames.add(sharedName)
    cleanupNames.add(renamed)
    await createTutor(page, sharedName, '四年级上', '人教版')
    await createTutor(page, sharedName, '六年级下', '苏教版')
    const sameName = (await listAgents(page)).filter(
      (agent) => agent.metadata?.['k12.child_name'] === sharedName,
    )
    expect(sameName).toHaveLength(2)
    expect(new Set(sameName.map((agent) => agent.name)).size).toBe(2)
    expect(new Set(sameName.map((agent) => agent.metadata?.['k12.learner_id'])).size).toBe(2)

    await page.goto('/agents', { waitUntil: 'domcontentloaded' })
    await page.getByText('我的智能体', { exact: false }).first().click()
    const firstCard = page.locator('.hc-cxcard', { hasText: sharedName }).first()
    await firstCard.getByRole('button', { name: /编辑档案/ }).click()
    const dialog = page.getByRole('dialog')
    await dialog.locator('.k12pf__input').fill(renamed)
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await expect(dialog).toHaveCount(0, { timeout: 30_000 })
    const after = await listAgents(page)
    expect(after.filter((agent) => agent.metadata?.['k12.child_name'] === sharedName)).toHaveLength(1)
    expect(after.filter((agent) => agent.metadata?.['k12.child_name'] === renamed)).toHaveLength(1)
  })
})
