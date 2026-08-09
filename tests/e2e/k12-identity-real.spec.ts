import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, test, type APIResponse, type Page } from '@playwright/test'
import { cleanupK12Child } from './live-fixture-cleanup'

const execFileAsync = promisify(execFile)
const exactIdentity = (child: string) => `你好，我是${child}的辅导助手。`

async function json<T>(response: APIResponse): Promise<T> {
  const body = await response.text()
  expect(response.ok(), `${new URL(response.url()).pathname} => ${response.status()}`).toBe(true)
  return JSON.parse(body) as T
}

async function createTutorAndEnter(page: Page, child: string): Promise<string> {
  await page.addInitScript(() => sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1'))
  await page.goto('/agents', { waitUntil: 'domcontentloaded' })
  const skip = page.getByRole('button', { name: '跳过' })
  if (await skip.isVisible().catch(() => false)) await skip.click()
  await page.getByText('模板库', { exact: false }).first().click()
  await page.getByText('作业辅导助手', { exact: false }).first().click()
  const dialog = page.getByRole('dialog')
  await dialog.locator('.k12pf__input').fill(child)
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
    (agent) => agent.metadata?.['k12.child_name'] === child,
  )
  expect(matches).toHaveLength(1)
  const owner = matches[0]!.name!

  await page.getByText('我的智能体', { exact: false }).first().click()
  const card = page.locator('.hc-cxcard', { hasText: child })
  await card.getByRole('button', { name: /进入辅导/ }).click()
  await expect(page.locator('.k12enh-seg')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('chat-input')).toBeVisible()
  return owner
}

async function sendAndRead(page: Page, prompt: string): Promise<string> {
  const completed = page.getByTestId('chat-message-assistant')
  const before = await completed.count()
  await page.getByTestId('chat-input').fill(prompt)
  await page.getByTestId('chat-send').click()
  await expect(completed).toHaveCount(before + 1, { timeout: 3 * 60_000 })
  const body = completed.nth(before).locator('.hc-msg__bubble--assistant .markdown-body')
  await expect(body).toBeVisible()
  await expect(
    page.getByTestId('chat-message-user').last().locator('.hc-msg__bubble--user'),
  ).toHaveText(prompt)
  return (await body.innerText()).trim()
}

async function restartInstalledSidecar() {
  const controller = process.env.HEX_E2E_SIDECAR_CONTROLLER
  const config = process.env.HEX_E2E_SIDECAR_CONTROLLER_CONFIG
  expect(controller, 'installed identity gate must own a sidecar controller').toBeTruthy()
  expect(config, 'installed identity gate must own a sidecar controller config').toBeTruthy()
  await execFileAsync(controller!, ['stop', '--config', config!], { timeout: 120_000 })
  await execFileAsync(controller!, ['start', '--config', config!], { timeout: 120_000 })
}

test('BUG-20260726-029 installed real model keeps the exact assistant identity across prompts and restart', async ({
  page,
}) => {
  test.setTimeout(15 * 60_000)
  const createdChildren: string[] = []
  let owner = ''
  try {
    owner = await createTutorAndEnter(page, '小明')
    createdChildren.push('小明')
    const initialAgents = await json<{
      agents?: Array<{ name?: string; system_prompt?: string; skills?: string[] }>
    }>(await page.request.get('/_hexclaw/api/v1/agents'))
    const initial = (initialAgents.agents || []).find((agent) => agent.name === owner)
    expect(initial?.system_prompt).toContain('像老师一样有耐心')
    expect(initial?.skills?.length).toBeGreaterThan(0)

    for (const prompt of ['你是谁？', '介绍下你', '你是老师吗？', '你是什么老师？']) {
      expect(await sendAndRead(page, prompt), prompt).toBe(exactIdentity('小明'))
    }

    const realityPrompt = '老师布置的作业怎么回复？'
    const realityReply = await sendAndRead(page, realityPrompt)
    expect(realityReply).toContain('老师')
    expect(realityReply).not.toContain('助手布置的作业')
    await page.locator('.hc-model-selector__btn').click()
    await page.locator('.hc-model-selector__item', { hasText: 'GPT-5.6 Sol' }).click()
    const deepThinking = page.getByRole('button', { name: '深度思考', exact: true })
    await deepThinking.click()
    await expect(deepThinking).toHaveClass(/hc-chat__research-btn--active/)
    expect(await sendAndRead(page, '介绍下你')).toBe(exactIdentity('小明'))

    await restartInstalledSidecar()
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.locator('.k12enh-seg')).toBeVisible({ timeout: 30_000 })
    expect(await sendAndRead(page, '介绍下你')).toBe(exactIdentity('小明'))

    const agents = await json<{
      agents?: Array<{
        name?: string
        metadata?: Record<string, string>
        system_prompt?: string
        skills?: string[]
      }>
    }>(await page.request.get('/_hexclaw/api/v1/agents'))
    const current = (agents.agents || []).find((agent) => agent.name === owner)
    expect(
      current?.metadata?.['k12.prompt_contract_version'],
      'identity contract version must persist after first use and restart',
    ).toBe('assistant-identity-v2')
    expect(current?.system_prompt).toBe(initial?.system_prompt)
    expect(current?.skills).toEqual(initial?.skills)

    const secondOwner = await createTutorAndEnter(page, '小红')
    createdChildren.push('小红')
    expect(await sendAndRead(page, '介绍下你')).toBe(exactIdentity('小红'))

    await page.goto(
      `/chat?role=${encodeURIComponent(owner)}&roleTitle=${encodeURIComponent('小明的辅导助手 · 五年级')}`,
      { waitUntil: 'domcontentloaded' },
    )
    await expect(page.locator('.k12enh-seg')).toBeVisible({ timeout: 30_000 })
    expect(await sendAndRead(page, '介绍下你')).toBe(exactIdentity('小明'))
    expect(secondOwner).not.toBe(owner)
  } finally {
    for (const child of createdChildren.reverse()) {
      await cleanupK12Child(page.request, child)
    }
  }
})

test('BUG-20260726-029 installed real model isolates identity across two children', async ({ page }) => {
  test.setTimeout(8 * 60_000)
  const createdChildren: string[] = []
  let firstOwner = ''
  try {
    firstOwner = await createTutorAndEnter(page, '小明')
    createdChildren.push('小明')
    expect(await sendAndRead(page, '介绍下你')).toBe(exactIdentity('小明'))

    const secondOwner = await createTutorAndEnter(page, '小红')
    createdChildren.push('小红')
    expect(secondOwner).not.toBe(firstOwner)
    expect(await sendAndRead(page, '介绍下你')).toBe(exactIdentity('小红'))

    await page.goto(
      `/chat?role=${encodeURIComponent(firstOwner)}&roleTitle=${encodeURIComponent('小明的辅导助手 · 五年级')}`,
      { waitUntil: 'domcontentloaded' },
    )
    await expect(page.locator('.k12enh-seg')).toBeVisible({ timeout: 30_000 })
    expect(await sendAndRead(page, '介绍下你')).toBe(exactIdentity('小明'))
  } finally {
    for (const child of createdChildren.reverse()) {
      await cleanupK12Child(page.request, child)
    }
  }
})
