import { expect, test } from '@playwright/test'

test.describe('K12 prototype visual conformance', () => {
  test('archive objects stay inside the viewport and works use the compact grid plus detail modal', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 820 })
    await page.addInitScript(() => sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1'))
    await page.goto('/agents', { waitUntil: 'domcontentloaded' })

    const skip = page.getByRole('button', { name: '跳过' })
    if (await skip.isVisible().catch(() => false)) await skip.click()

    const card = page.locator('.hc-cxcard').filter({ hasText: '辅导助手' }).first()
    await expect(card).toBeVisible({ timeout: 30_000 })
    const gridColumns = await page
      .locator('.hc-cxcards')
      .first()
      .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length)
    const cardGeometry = await card.evaluate((el) => {
      const rect = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      return { height: rect.height, paddingTop: style.paddingTop, gap: style.gap }
    })
    expect(gridColumns, '智能体页桌面宽度应保持原型双列卡片').toBe(2)
    expect(cardGeometry.height, '辅导助手卡不应被内部空行或等高网格撑高').toBeLessThan(210)
    expect(cardGeometry.paddingTop).toBe('16px')
    expect(cardGeometry.gap).toBe('12px')
    await page.screenshot({ path: 'test-results/agents-prototype-aligned.png', fullPage: true })
    await card.getByRole('button', { name: '学习档案', exact: true }).click()
    await expect(page).toHaveURL(/\/chat/, { timeout: 30_000 })
    await expect(page.locator('.k12rec')).toBeVisible({ timeout: 30_000 })

    const objectTabs = page.getByRole('tablist', { name: '学习档案', exact: true })
    const tabs = [
      ['本周该练', 'weekly'],
      ['全部错题', 'all-mistakes'],
      ['练习集', 'practice-sets'],
      ['积累', 'accumulation'],
      ['作品', 'works'],
    ] as const
    for (const [label, slug] of tabs) {
      await objectTabs.getByRole('tab', { name: new RegExp(`^${label}\\s+\\d+$`) }).click()
      await expect(page.locator('.k12rec__body')).toBeVisible()
      const archiveMore = page.locator('.k12rec__export > button')
      await archiveMore.click()
      const archiveMenu = page.locator('.k12rec__menu')
      await expect(archiveMenu).toBeVisible()
      await expect(archiveMenu).toContainText('导出 PDF')
      await expect(archiveMenu).toContainText('导出 Word')
      await expect(archiveMenu).toContainText('导出 Markdown')
      await expect(archiveMenu).toContainText('备份 / 恢复')
      await archiveMore.click()
      await expect(archiveMenu).toBeHidden()
      const overflow = await page
        .locator('.k12rec__body')
        .evaluate((el) => el.scrollWidth - el.clientWidth)
      expect(overflow, `${label} 不应出现横向页面漂移`).toBeLessThanOrEqual(1)
      await page.screenshot({ path: `test-results/k12-archive-${slug}.png`, fullPage: true })
    }

    const cards = page.locator('.k12cw__card')
    await expect(cards.first()).toBeVisible({ timeout: 30_000 })
    if ((await cards.count()) >= 2) {
      const first = await cards.nth(0).boundingBox()
      const second = await cards.nth(1).boundingBox()
      expect(first).not.toBeNull()
      expect(second).not.toBeNull()
      expect(Math.abs(first!.y - second!.y), '桌面宽度下作品卡应同排双列').toBeLessThan(4)
      expect(second!.x).toBeGreaterThan(first!.x + first!.width)
    }
    const detailTrigger = cards.first().getByTestId('cw-detail-toggle')
    await expect(detailTrigger).toHaveAttribute('aria-haspopup', 'dialog')
    await expect(detailTrigger).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByTestId('cw-detail-modal')).toHaveCount(0)
    await expect(page.getByTestId('cw-add-open')).toBeVisible()
    await page.screenshot({ path: 'test-results/k12-works-prototype-aligned.png', fullPage: true })

    await detailTrigger.click()
    const detailModal = page.getByTestId('cw-detail-modal')
    await expect(detailTrigger).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByTestId('cw-detail-overlay')).toBeVisible()
    await expect(detailModal).toBeVisible()
    await expect(detailModal).toHaveAttribute('role', 'dialog')
    await expect(detailModal).toHaveAttribute('aria-modal', 'true')
    await expect(detailModal.locator('.k12cw__details')).toBeVisible()
    const overlayBox = await page.getByTestId('cw-detail-overlay').boundingBox()
    expect(overlayBox).not.toBeNull()
    expect(overlayBox!.x).toBeCloseTo(0, 0)
    expect(overlayBox!.y).toBeCloseTo(0, 0)
    expect(overlayBox!.width).toBeCloseTo(1280, 0)
    expect(overlayBox!.height).toBeCloseTo(820, 0)
    const detailBox = await detailModal.boundingBox()
    expect(detailBox).not.toBeNull()
    expect(detailBox!.x).toBeGreaterThanOrEqual(0)
    expect(detailBox!.y).toBeGreaterThanOrEqual(0)
    expect(detailBox!.x + detailBox!.width).toBeLessThanOrEqual(1280)
    expect(detailBox!.y + detailBox!.height).toBeLessThanOrEqual(820)
    await page.screenshot({
      path: 'test-results/k12-work-detail-modal-prototype-aligned.png',
      fullPage: true,
    })
    await page.getByTestId('cw-detail-close').click()
    await expect(detailTrigger).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByTestId('cw-detail-modal')).toHaveCount(0)

    await page.locator('.k12enh-seg').getByRole('tab', { name: '辅导', exact: true }).click()
    const userMessage = page.getByTestId('chat-message-user').last()
    await expect(userMessage).toBeVisible()
    await userMessage.scrollIntoViewIfNeeded()
    const beforeHover = await userMessage.boundingBox()
    await userMessage.hover()
    const bubble = userMessage.locator('.hc-msg__bubble--user')
    const actions = userMessage.locator('.hc-msg__actions-float--right')
    await expect(actions).toBeVisible()
    const bubbleBox = await bubble.boundingBox()
    const actionsBox = await actions.boundingBox()
    expect(bubbleBox).not.toBeNull()
    expect(actionsBox).not.toBeNull()
    const afterHover = await userMessage.boundingBox()
    expect(beforeHover).not.toBeNull()
    expect(afterHover).not.toBeNull()
    expect(Math.abs(afterHover!.y - beforeHover!.y), '悬停不得让消息自身跳动').toBeLessThanOrEqual(
      1,
    )
    expect(
      Math.abs(afterHover!.height - beforeHover!.height),
      '悬停不得改变预留操作栏高度',
    ).toBeLessThanOrEqual(1)
    expect(actionsBox!.y, '用户消息工具栏应位于气泡下方').toBeGreaterThanOrEqual(
      bubbleBox!.y + bubbleBox!.height + 4,
    )
    expect(
      Math.abs(actionsBox!.x + actionsBox!.width - bubbleBox!.x - bubbleBox!.width),
      '用户消息工具栏应右对齐气泡',
    ).toBeLessThanOrEqual(2)

    const assistantMessage = page.getByTestId('chat-message-assistant').last()
    await expect(assistantMessage).toBeVisible()
    await assistantMessage.scrollIntoViewIfNeeded()
    const assistantBeforeHover = await assistantMessage.boundingBox()
    await assistantMessage.hover()
    const assistantActions = assistantMessage.locator('.hc-msg__actions-float--left')
    const assistantMeta = assistantMessage.locator('.hc-msg__meta')
    await expect(assistantActions).toBeVisible()
    await expect(assistantMeta).toBeVisible()
    const assistantActionsBox = await assistantActions.boundingBox()
    const assistantMetaBox = await assistantMeta.boundingBox()
    const assistantAfterHover = await assistantMessage.boundingBox()
    expect(assistantActionsBox).not.toBeNull()
    expect(assistantMetaBox).not.toBeNull()
    expect(assistantBeforeHover).not.toBeNull()
    expect(assistantAfterHover).not.toBeNull()
    expect(
      assistantActionsBox!.y + assistantActionsBox!.height,
      '助手工具栏不得遮挡时间与模型信息',
    ).toBeLessThanOrEqual(assistantMetaBox!.y)
    expect(
      Math.abs(assistantAfterHover!.height - assistantBeforeHover!.height),
      '助手悬停不得改变消息高度',
    ).toBeLessThanOrEqual(1)
    const copyAction = assistantActions.getByRole('button', { name: '复制' })
    await copyAction.click()
    await expect(copyAction).toBeFocused()
    await expect(assistantMeta).toBeVisible()

    const deepThinking = page.getByRole('button', { name: '深度思考' })
    const currentSession = page.locator('.hc-sessions__item--active')
    const currentSessionId = await currentSession.getAttribute('data-session-id')
    const otherSession = page.locator('.hc-sessions__item:not(.hc-sessions__item--active)').first()
    await deepThinking.click()
    await expect(deepThinking).toHaveClass(/hc-chat__research-btn--active/)
    if (currentSessionId && (await otherSession.count())) {
      await otherSession.click()
      await expect(deepThinking).not.toHaveClass(/hc-chat__research-btn--active/)
      await page.locator(`.hc-sessions__item[data-session-id="${currentSessionId}"]`).click()
      await expect(deepThinking).toHaveClass(/hc-chat__research-btn--active/)
    }
    await deepThinking.click()
    await expect(deepThinking).not.toHaveClass(/hc-chat__research-btn--active/)
    await page.screenshot({ path: 'test-results/message-actions-aligned.png', fullPage: true })
  })
})
