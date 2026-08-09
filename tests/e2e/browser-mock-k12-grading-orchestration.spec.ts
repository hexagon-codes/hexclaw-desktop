import { expect, test, type Page } from '@playwright/test'

async function createK12Tutor(page: Page, childName: string): Promise<string> {
  await page.addInitScript(() => sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1'))
  await page.goto('/agents', { waitUntil: 'domcontentloaded' })
  const skip = page.getByRole('button', { name: '跳过' })
  if (await skip.isVisible().catch(() => false)) await skip.click()

  await page.getByText('模板库', { exact: false }).first().click()
  await page.getByText('作业辅导助手', { exact: false }).first().click()
  const dialog = page.getByRole('dialog')
  await dialog.locator('.k12pf__input').fill(childName)
  await dialog.locator('.hc-select__trigger').nth(0).click()
  await page.locator('.hc-select__dropdown .hc-select__option', { hasText: '六年级' }).click()
  await dialog.locator('.hc-select__trigger').nth(1).click()
  await page.locator('.hc-select__dropdown .hc-select__option', { hasText: '上学期' }).click()
  await dialog.getByRole('button', { name: '创建', exact: true }).click()
  await expect(dialog).toHaveCount(0, { timeout: 30_000 })

  const response = await page.request.get('/_hexclaw/api/v1/agents')
  expect(response.ok()).toBe(true)
  const payload = (await response.json()) as {
    agents?: Array<{ name?: string; metadata?: Record<string, string> }>
  }
  const owners = (payload.agents || []).filter(
    (agent) => agent.metadata?.['k12.child_name'] === childName,
  )
  expect(owners).toHaveLength(1)

  await page.getByText('我的智能体', { exact: false }).first().click()
  await page
    .locator('.hc-cxcard', { hasText: childName })
    .getByRole('button', { name: /进入辅导/ })
    .click()
  await expect(page.locator('.hc-composer input[type="file"]')).toBeAttached({
    timeout: 30_000,
  })
  return owners[0]!.name!
}

test.describe('BUG-20260728-018 real-Sidecar grading orchestration', () => {
  test.setTimeout(240_000)

  test('explicit text+vision route creates the one grading projection for a routed homework submission', async ({
    page,
  }) => {
    await page.setContent(`
      <style>
        body { margin: 0; background: #ddd; }
        #sheet { position: relative; width: 800px; height: 600px; background: white; color: #111;
          font: 700 42px/1.2 Arial, sans-serif; }
        .title { position: absolute; left: 60px; top: 35px; font-size: 28px; }
        .q1 { position: absolute; left: 100px; top: 155px; }
        .q2 { position: absolute; left: 100px; top: 300px; }
        .answer { position: absolute; left: 400px; top: 295px; font: 900 60px/1 Arial, sans-serif; }
      </style>
      <div id="sheet">
        <div class="title">六年级数学 · 编排回归卷</div>
        <div class="q1">1. 6 × 7 =</div>
        <div class="q2">2. 8 × 7 =</div>
        <div class="answer">54</div>
      </div>
    `)
    const worksheet = await page.locator('#sheet').screenshot()

    const childName = `MockOrchestration${Date.now().toString(36)}`
    const owner = await createK12Tutor(page, childName)
    const createResponsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return response.request().method() === 'POST' && url.pathname.endsWith('/api/k12/image-tasks')
    })

    await page.locator('.hc-composer input[type="file"]').setInputFiles({
      name: 'synthetic-grading-orchestration.png',
      mimeType: 'image/png',
      buffer: worksheet,
    })

    const createResponse = await createResponsePromise
    expect(createResponse.ok()).toBe(true)
    const createPayload = (await createResponse.json()) as {
      dispatch?: { dispatch_id?: string }
      dispatch_id?: string
    }
    const dispatchID = createPayload.dispatch?.dispatch_id || createPayload.dispatch_id
    expect(dispatchID).toBeTruthy()

    await expect
      .poll(
        async () => {
          const response = await page.request.get(
            `/_hexclaw/api/k12/image-tasks/${encodeURIComponent(dispatchID!)}?agent=${encodeURIComponent(owner)}`,
          )
          if (!response.ok()) return { status: `http-${response.status()}` }
          const body = (await response.json()) as { dispatch?: Record<string, unknown> }
          return (body.dispatch || body) as Record<string, unknown>
        },
        {
          timeout: 60_000,
          intervals: [250, 500, 1_000],
          message: 'the one image dispatch must route to the existing homework submission',
        },
      )
      .toMatchObject({
        task_intent: 'completed_homework',
        status: 'routed',
      })

    await expect(
      page.getByTestId('photo-grade-overlay'),
      'routed homework must converge to the durable final grading projection',
    ).toBeVisible({ timeout: 120_000 })
    await expect(page.getByTestId('recognize-guard')).not.toContainText(
      /requires a frozen grading budget policy/i,
    )
    await expect(page.getByTestId('recognize-guard')).not.toContainText(
      /invalid image task result response/i,
    )
  })
})
