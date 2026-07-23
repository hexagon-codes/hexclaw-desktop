import { expect, test } from '@playwright/test'

test.describe('Browser UI + real Sidecar + synthetic K12 provider', () => {
  test.setTimeout(300_000)

  test('mixed worksheet: recognize → solve blank → grade answered → prototype result → learning archive', async ({
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
    await expect(page.getByText('创建「K12 辅导助手」')).toBeVisible({ timeout: 30_000 })
    await page.locator('.k12pf__input').first().fill(child)
    await page.locator('.k12pf .hc-select__trigger').nth(0).click()
    await page.locator('.hc-select__dropdown .hc-select__option', { hasText: '六年级' }).click()
    await page.locator('.k12pf .hc-select__trigger').nth(1).click()
    await page.locator('.hc-select__dropdown .hc-select__option', { hasText: '上学期' }).click()
    await page.getByRole('button', { name: '创建' }).click()
    await expect(page.locator('.k12pf')).toHaveCount(0, { timeout: 30_000 })

    await page.getByText('我的智能体', { exact: false }).first().click()
    const card = page.locator('.hc-cxcard', { hasText: child })
    await expect(card).toBeVisible({ timeout: 30_000 })
    await card.getByRole('button', { name: /进入辅导/ }).click()
    await expect(page).toHaveURL(/\/chat/, { timeout: 30_000 })
    const scenarioTabs = page.locator('.k12enh-seg')
    await expect(scenarioTabs.getByRole('tab')).toHaveText(['辅导', '学习档案', '学情'])
    await expect(page.getByTestId('chat-input')).toHaveAttribute(
      'placeholder',
      '发消息、粘贴带分数/公式的题目，或 ⌘V 粘贴作业照片',
    )
    await expect(page.getByTestId('scenario-composer-hint')).toContainText('支持粘贴分数与数学公式')
    const presetChips = page.locator('.hc-composer__box [data-testid="composer-preset-chip"]')
    await expect(presetChips).toHaveCount(3)
    await expect(presetChips.first()).toContainText('自动识别学科')

    // 权威原型：首个能力 chip 可打开六学科说明；关闭后焦点回到触发器。
    const subjectCapabilityTrigger = page.getByTestId('composer-preset-chip-action')
    await subjectCapabilityTrigger.click()
    const capabilityDialog = page.getByTestId('k12-capability-dialog')
    await expect(capabilityDialog).toBeVisible()
    await expect(capabilityDialog.getByTestId('k12-subject-capability')).toHaveCount(6)
    await capabilityDialog.getByTestId('k12-capability-close').click()
    await expect(capabilityDialog).toHaveCount(0)
    await expect(subjectCapabilityTrigger).toBeFocused()

    // Footer 能力说明不是死按钮：主操作将原型示例填回通用 composer 并聚焦。
    await page.getByTestId('k12-general-capabilities').click()
    await expect(capabilityDialog.getByTestId('k12-general-capability')).toHaveCount(3)
    await capabilityDialog.getByTestId('k12-capability-primary').click()
    const chatInput = page.getByTestId('chat-input')
    await expect(chatInput).toBeFocused()
    await expect(chatInput).not.toHaveValue('')
    await chatInput.fill('')

    await page.locator('.hc-composer input[type="file"]').setInputFiles({
      name: 'synthetic-mixed-worksheet.png',
      mimeType: 'image/png',
      buffer: worksheet,
    })
    await expect(page.getByTestId('recognize-guard')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('rq-item')).toHaveCount(2, { timeout: 120_000 })
    await expect(page.getByTestId('recognize-pipeline')).toBeVisible()
    await expect(page.getByTestId('recognize-confirm-branch')).toBeVisible()
    await expect(page.getByTestId('recognize-anchor-branch')).toBeVisible()
    await expect(page.getByTestId('k12-photo-assistant-message')).toBeVisible()
    await expect(
      page.getByTestId('k12-photo-assistant-message').locator('.k12enh-tutor__name'),
    ).toContainText(child)
    await expect(page.getByTestId('recognize-confirm-all')).toContainText('读得对，开始辅导')
    await expect(page.getByTestId('recognize-correct')).toContainText('有地方读错了')
    await expect(page.getByTestId('rq-grade-0')).toHaveCount(0)
    await page.screenshot({
      path: 'test-results/k12-photo-confirm-prototype-aligned.png',
      fullPage: true,
    })

    await page.getByTestId('recognize-confirm-all').click()
    await expect(page.getByTestId('rq-answer-0')).toHaveValue('')
    await expect(page.getByTestId('rq-answer-1')).toHaveValue('54')
    await expect(page.getByTestId('rq-solve-0')).toBeEnabled()
    await page.getByTestId('rq-solve-0').click()
    await expect(page.getByTestId('rq-grade-details-0')).toContainText('42', { timeout: 120_000 })

    await expect(page.getByTestId('rq-grade-1')).toBeEnabled()
    await page.getByTestId('rq-grade-1').click()
    const gradeResult = page.getByTestId('photo-grade-overlay')
    await expect(gradeResult).toBeVisible({ timeout: 120_000 })
    await expect(gradeResult).toHaveClass(/grade-result/)
    await expect(gradeResult.locator('.grade-summary .grade-stat')).toHaveCount(4)
    await expect(gradeResult.locator('.grade-workspace')).toBeVisible()
    await expect(gradeResult.locator('.grade-media')).toBeVisible()
    await expect(gradeResult.locator('.grade-analysis')).toBeVisible()
    await expect(gradeResult.locator('.grade-legend [data-grade-status]')).toHaveCount(8)
    await expect(gradeResult.locator('.grade-card--issue[open]').first()).toBeVisible()
    const correctCards = gradeResult.locator('.grade-card--correct')
    for (let index = 0; index < (await correctCards.count()); index += 1) {
      await expect(correctCards.nth(index)).not.toHaveAttribute('open', '')
    }
    await expect(page.getByTestId('overlay-sym-0')).toHaveText('✗')
    const overlayToggle = page.getByTestId('overlay-toggle')
    await expect(overlayToggle).toHaveAttribute('aria-pressed', 'true')
    await overlayToggle.click()
    await expect(overlayToggle).toHaveAttribute('aria-pressed', 'false')
    await expect(page.getByTestId('overlay-sym-0')).toHaveCount(0)
    await expect(gradeResult.locator('.grade-analysis')).toBeVisible()
    await overlayToggle.click()
    await expect(overlayToggle).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('overlay-sym-0')).toBeVisible()
    await page.screenshot({
      path: 'test-results/k12-photo-grade-result-prototype-aligned.png',
      fullPage: true,
    })

    await scenarioTabs.getByRole('tab', { name: '学习档案', exact: true }).click()
    await expect(page.locator('.k12rec')).toBeVisible({ timeout: 30_000 })
    const objectTabs = page.locator('.k12rec__object-tabs').getByRole('tab')
    await expect(objectTabs).toHaveCount(5)
    for (const [index, label] of ['本周复习', '全部错题', '练习集', '积累', '作品'].entries()) {
      await expect(objectTabs.nth(index)).toHaveAccessibleName(new RegExp(`^${label} \\d+$`))
    }
    await expect(page.getByTestId('week-section')).toBeVisible()
    await page.getByTestId('subtab-mistakes').click()
    await expect(page.getByTestId('mistakes-section')).toBeVisible()
    await expect(page.locator('.k12rec')).toContainText('8×7=', { timeout: 30_000 })
    await page.screenshot({
      path: 'test-results/k12-learning-archive-prototype-aligned.png',
      fullPage: true,
    })
  })
})
