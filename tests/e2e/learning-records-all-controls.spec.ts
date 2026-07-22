import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { expect, test, type APIRequestContext, type Download, type Page } from '@playwright/test'
import {
  assertLiveRuntime,
  cleanupLiveChild,
  liveGateBlockers,
  liveJSON,
  liveSkipReason,
} from '../live/k12-live-helpers'

/**
 * REG-DD-029 / UICLICK-018
 *
 * This suite intentionally uses the visible K12 UI and the real sidecar.  It
 * must not be pointed at a developer profile containing irreplaceable data.
 * Every object it creates is owned by the unique child name below and cleanup
 * only removes that exact TutorAgent.
 */
const blockers = liveGateBlockers({ isolatedProfile: true, model: true })
const ARCHIVE_TABS = [
  ['subtab-week', '本周复习'],
  ['subtab-mistakes', '全部错题'],
  ['subtab-practicesets', '练习集'],
  ['subtab-accumulation', '积累'],
  ['subtab-works', '作品'],
] as const
const ARCHIVE_ACTIONS = ['导出 PDF', '导出 Word', '导出 Markdown', '备份 / 恢复']

interface AgentProjection {
  name?: string
  metadata?: Record<string, string>
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

async function json<T>(response: import('@playwright/test').APIResponse): Promise<T> {
  const body = await response.text()
  expect(
    response.ok(),
    `${response.request().method()} ${new URL(response.url()).pathname} => HTTP ${response.status()} (body redacted)`,
  ).toBe(true)
  return JSON.parse(body) as T
}

async function createTutor(page: Page, childName: string): Promise<void> {
  await page.addInitScript(() => sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1'))
  await page.goto('/agents', { waitUntil: 'domcontentloaded' })
  const skip = page.getByRole('button', { name: '跳过' })
  if (await skip.isVisible().catch(() => false)) await skip.click()
  await page.getByText('模板库', { exact: false }).first().click()
  await page.getByText('作业辅导助手', { exact: false }).first().click()
  await expect(page.getByText('创建「K12 辅导助手」')).toBeVisible({ timeout: 20_000 })
  await page.locator('.k12pf__input').first().fill(childName)
  await page.locator('.k12pf .hc-select__trigger').nth(0).click()
  await page.locator('.hc-select__dropdown .hc-select__option', { hasText: '五年级下' }).click()
  await page.getByRole('button', { name: '创建', exact: true }).click()
  await expect(page.locator('.k12pf')).toHaveCount(0, { timeout: 30_000 })
  await page.getByText('我的智能体', { exact: false }).first().click()
  const card = page.locator('.hc-cxcard', { hasText: childName })
  await expect(card).toBeVisible({ timeout: 30_000 })
  await card.getByRole('button', { name: /错题本|学习档案/ }).click()
  await expect(page.locator('.k12rec')).toBeVisible({ timeout: 30_000 })
}

async function tutorAgentID(request: APIRequestContext, childName: string): Promise<string> {
  const payload = await liveJSON<{ agents?: AgentProjection[] }>(request, 'GET', '/api/v1/agents')
  const matches = (payload.agents || []).filter(
    (agent) => agent.metadata?.['k12.child_name'] === childName,
  )
  expect(matches, `child ${childName} must resolve to exactly one TutorAgent`).toHaveLength(1)
  expect(matches[0]?.name, 'TutorAgent must have a stable owner id').toBeTruthy()
  return matches[0]!.name!
}

async function downloadedBytes(download: Download): Promise<Buffer> {
  const failure = await download.failure()
  expect(failure, `download ${download.suggestedFilename()} must complete`).toBeNull()
  const path = await download.path()
  expect(path, `download ${download.suggestedFilename()} must have a real file`).toBeTruthy()
  return readFileSync(path!)
}

async function exportFromOpenMenu(
  page: Page,
  label: '导出 PDF' | '导出 Word' | '导出 Markdown',
  agentID: string,
): Promise<{ sourceDigest: string; bytes: Buffer }> {
  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return url.pathname.endsWith('/api/v1/k12/export') && url.searchParams.get('agent') === agentID
  })
  const downloadPromise = page.waitForEvent('download')
  await page.locator('.k12rec__menu').getByRole('button', { name: label, exact: true }).click()
  const [response, download] = await Promise.all([responsePromise, downloadPromise])
  const payload = await json<{ content?: string; render_error?: string }>(response)
  expect(payload.render_error || '', `${label} must not hide a renderer failure`).toBe('')
  expect(
    payload.content?.trim().length,
    `${label} must render the canonical archive, not an empty shell`,
  ).toBeGreaterThan(20)
  return { sourceDigest: sha256(payload.content!), bytes: await downloadedBytes(download) }
}

test.describe.serial('K12 learning-record controls and real artifacts', () => {
  test.setTimeout(15 * 60_000)
  test.skip(
    blockers.length > 0,
    liveSkipReason(blockers, 'installed RC + isolated profile + authorized real model'),
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
    }
  })

  test('five tabs expose the exact same four actions and export one canonical owner scope', async ({
    page,
    request,
  }) => {
    childName = `档案控件${Date.now().toString(36)}`
    await createTutor(page, childName)
    const agentID = await tutorAgentID(request, childName)
    const sourceDigests = new Set<string>()

    for (const [testID, tabName] of ARCHIVE_TABS) {
      const tab =
        testID === 'subtab-accumulation'
          ? page.locator('.k12rec__tabs .seg button', { hasText: tabName })
          : page.getByTestId(testID)
      await tab.click()
      await expect(tab, `${tabName} must become the selected archive object`).toHaveClass(/on/)

      const more = page.locator('.k12rec__export > button')
      await more.click()
      const menu = page.locator('.k12rec__menu')
      await expect(menu).toBeVisible()
      const visibleActions = (await menu.locator(':scope > button').allTextContents()).map((text) =>
        text.trim(),
      )
      expect(visibleActions, `${tabName} overflow is an exact-set contract`).toEqual(
        ARCHIVE_ACTIONS,
      )

      for (const format of ['导出 PDF', '导出 Word', '导出 Markdown'] as const) {
        if (!(await menu.isVisible())) await more.click()
        const artifact = await exportFromOpenMenu(page, format, agentID)
        sourceDigests.add(artifact.sourceDigest)
        expect(
          artifact.bytes.length,
          `${tabName}/${format} must create a non-empty file`,
        ).toBeGreaterThan(20)
        if (format === '导出 PDF') {
          expect(artifact.bytes.subarray(0, 5).toString(), 'PDF must have the real PDF magic').toBe(
            '%PDF-',
          )
        } else if (format === '导出 Word') {
          expect(
            artifact.bytes.subarray(0, 4).toString('hex'),
            'Word must be a DOCX ZIP, not HTML renamed as Word',
          ).toBe('504b0304')
        } else {
          expect(artifact.bytes.toString('utf8')).toContain(childName)
        }
      }

      await more.click()
      await menu.getByRole('button', { name: '备份 / 恢复', exact: true }).click()
      const backupDialog = page.getByRole('dialog')
      await expect(backupDialog).toContainText('家庭学习档案')
      await expect(backupDialog.locator('input[type="file"]')).toHaveAttribute('accept', /hexbak/)
      await backupDialog.getByRole('button', { name: '关闭', exact: true }).last().click()
    }

    expect(
      [...sourceDigests],
      'all tabs and formats must share one canonical source digest',
    ).toHaveLength(1)
    await page.goto('/settings', { waitUntil: 'domcontentloaded' })
    await expect(page.getByText('家庭学习档案', { exact: false })).toHaveCount(0)
    await expect(page.getByText('按 Tutor 备份', { exact: false })).toHaveCount(0)
  })

  test('backup is a real file; closing restore is side-effect free and confirmation is durable', async ({
    page,
    request,
  }) => {
    childName = `档案恢复${Date.now().toString(36)}`
    await createTutor(page, childName)
    const agentID = await tutorAgentID(request, childName)
    const before = await liveJSON<{ records?: unknown[] }>(
      request,
      'GET',
      `/api/v1/k12/backup?agent=${encodeURIComponent(agentID)}`,
    )

    const more = page.locator('.k12rec__export > button')
    await more.click()
    await page
      .locator('.k12rec__menu')
      .getByRole('button', { name: '备份 / 恢复', exact: true })
      .click()
    let dialog = page.getByRole('dialog')
    const downloadPromise = page.waitForEvent('download')
    await dialog.getByRole('button', { name: /一键导出归档|导出.*备份|导出档案/ }).click()
    const backupDownload = await downloadPromise
    const backupBytes = await downloadedBytes(backupDownload)
    expect(backupDownload.suggestedFilename()).toMatch(/\.hexbak$/)
    const archive = JSON.parse(backupBytes.toString('utf8')) as {
      agent_name?: string
      checksum?: string
      records?: unknown[]
    }
    expect(archive.agent_name).toBe(agentID)
    expect(archive.checksum).toMatch(/^[a-f0-9]{64}$/)
    expect(archive.records?.length).toBe(before.records?.length ?? 0)

    await dialog.locator('input[type="file"]').setInputFiles({
      name: backupDownload.suggestedFilename(),
      mimeType: 'application/octet-stream',
      buffer: backupBytes,
    })
    await expect(dialog.getByTestId('backup-restore-preview')).toBeVisible()
    await dialog.getByRole('button', { name: '关闭', exact: true }).last().click()
    const afterCancel = await liveJSON<{ records?: unknown[] }>(
      request,
      'GET',
      `/api/v1/k12/backup?agent=${encodeURIComponent(agentID)}`,
    )
    expect(
      afterCancel.records?.length ?? 0,
      'closing restore must have zero write side effects',
    ).toBe(before.records?.length ?? 0)

    await more.click()
    await page
      .locator('.k12rec__menu')
      .getByRole('button', { name: '备份 / 恢复', exact: true })
      .click()
    dialog = page.getByRole('dialog')
    await dialog.locator('input[type="file"]').setInputFiles({
      name: backupDownload.suggestedFilename(),
      mimeType: 'application/octet-stream',
      buffer: backupBytes,
    })
    const restoreResponse = page.waitForResponse(
      (response) =>
        response.url().includes('/api/v1/k12/restore') && response.request().method() === 'POST',
    )
    await dialog.getByTestId('backup-restore-confirm').click()
    expect(
      (await restoreResponse).ok(),
      'confirmed restore must reach a successful real terminal',
    ).toBe(true)
    await expect(dialog).toContainText(/已恢复|校验通过/)
  })
})
