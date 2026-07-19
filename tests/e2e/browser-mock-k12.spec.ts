import { expect, test } from '@playwright/test'

test.describe('Browser UI + real Sidecar + synthetic K12 provider', () => {
  test.setTimeout(300_000)

  test('mixed worksheet: recognize → solve blank → grade answered → overlay → mistake book', async ({
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
        .answer { position: absolute; left: 400px; top: 295px; font: 900 60px/1 Arial, sans-serif;
          transform: rotate(-3deg); }
      </style>
      <div id="sheet">
        <div class="title">六年级数学 · 合成测试卷</div>
        <div class="q1">1. 6 × 7 =</div>
        <div class="q2">2. 8 × 7 =</div>
        <div class="answer">54</div>
      </div>
    `)
    const worksheet = await page.locator('#sheet').screenshot()

    await page.addInitScript(() => sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1'))
    const child = `MockK12${Date.now().toString(36)}`
    await page.goto('/agents', { waitUntil: 'domcontentloaded' })
    const skip = page.getByRole('button', { name: '跳过' })
    if (await skip.isVisible().catch(() => false)) await skip.click()
    await page.getByText('模板库', { exact: false }).first().click()
    await page.getByText('作业辅导助手', { exact: false }).first().click()
    await expect(page.getByText('创建「作业辅导助手」')).toBeVisible({ timeout: 30_000 })
    await page.locator('.k12pf__input').first().fill(child)
    await page.locator('.k12pf .hc-select__trigger').nth(0).click()
    await page.locator('.hc-select__dropdown .hc-select__option', { hasText: '六年级上' }).click()
    await page.getByRole('button', { name: '创建' }).click()
    await expect(page.locator('.k12pf')).toHaveCount(0, { timeout: 30_000 })

    await page.getByText('我的智能体', { exact: false }).first().click()
    const card = page.locator('.hc-cxcard', { hasText: child })
    await expect(card).toBeVisible({ timeout: 30_000 })
    await card.getByRole('button', { name: /进入辅导/ }).click()
    await expect(page).toHaveURL(/\/chat/, { timeout: 30_000 })

    await page.locator('.hc-composer input[type="file"]').setInputFiles({
      name: 'synthetic-mixed-worksheet.png',
      mimeType: 'image/png',
      buffer: worksheet,
    })
    await expect(page.getByTestId('recognize-guard')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('rq-item')).toHaveCount(2, { timeout: 120_000 })
    await expect(page.getByTestId('k12-photo-assistant-message')).toBeVisible()
    await expect(page.getByTestId('k12-photo-assistant-message').locator('.k12enh-tutor__name')).toContainText(child)
    await expect(page.getByTestId('recognize-confirm-all')).toContainText('读得对，开始辅导')
    await expect(page.getByTestId('recognize-correct')).toContainText('有地方读错了')
    await expect(page.getByTestId('rq-grade-0')).toHaveCount(0)
    await page.screenshot({ path: 'test-results/k12-photo-confirm-prototype-aligned.png', fullPage: true })
    await expect(page.getByTestId('rq-answer-0')).toHaveValue('')
    await expect(page.getByTestId('rq-answer-1')).toHaveValue('54')

    await page.getByTestId('recognize-confirm-all').click()
    await expect(page.getByTestId('rq-solve-0')).toBeEnabled()
    await page.getByTestId('rq-solve-0').click()
    await expect(page.getByTestId('rq-grade-details-0')).toContainText('42', { timeout: 120_000 })

    await expect(page.getByTestId('rq-grade-1')).toBeEnabled()
    await page.getByTestId('rq-grade-1').click()
    await expect(page.getByTestId('photo-grade-overlay')).toBeVisible({ timeout: 120_000 })
    await expect(page.getByTestId('overlay-sym-0')).toHaveText('✗')
    await page.getByTestId('overlay-toggle').click()
    await expect(page.getByTestId('overlay-sym-0')).toHaveCount(0)
    await page.getByTestId('overlay-toggle').click()
    await expect(page.getByTestId('overlay-sym-0')).toBeVisible()

    await page.locator('.k12enh-seg button', { hasText: '错题本' }).click()
    await expect(page.locator('.k12rec')).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('.k12rec')).toContainText('8×7=', { timeout: 30_000 })
  })
})
