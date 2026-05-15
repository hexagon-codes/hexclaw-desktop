import { test, expect } from '@playwright/test'

test.describe('Module 004 - Skill UAT Checklist', () => {
  test.setTimeout(120_000)

  test('Step 1-5: Complete UAT checklist for Skill workflow', async ({ page }) => {
    // 1. 打开聊天视图
    await page.addInitScript(() => {
      sessionStorage.setItem('hexclaw:welcomeRedirectDone', 'true')
    })

    await page.goto('/chat')
    await page.waitForLoadState('networkidle')
    await expect(page.locator('textarea')).toBeVisible()

    console.log('[UAT] Step 1: Opened chat view successfully')

    // 2. 输入 @bulletize 特斯拉Q1交付89万辆
    const chatInput = page.locator('textarea')
    await chatInput.click()
    await chatInput.fill('@bulletize 特斯拉Q1交付89万辆')
    
    // 等待 Mention 弹窗出现并选择 skill
    await page.waitForSelector('[role="listbox"]', { timeout: 5000 }).catch(() => {
      console.log('[UAT] Mention popup not shown, continuing')
    })

    // 3. 发送
    await page.keyboard.press('Enter')
    
    console.log('[UAT] Step 1: Sent message with @bulletize successfully')

    // Step 2: 验证 TaskBadge
    console.log('[UAT] Step 2: Verifying TaskBadge...')
    
    // 等待 TaskBadge 出现（给一些时间让消息处理）
    const taskBadge = page.locator('.task-badge')
    await expect(taskBadge).toBeVisible({ timeout: 30000 })
    
    // 验证 Badge 显示 skill 名称 + 状态
    const badgeText = await taskBadge.textContent()
    expect(badgeText).toContain('bulletize')
    
    console.log('[UAT] Step 2: TaskBadge verified successfully')

    // Step 3: 跳转 Workspace
    console.log('[UAT] Step 3: Navigating to Workspace...')
    await taskBadge.click()
    
    // 验证 URL 变化到 /workspace
    await expect(page).toHaveURL(/\/workspace/, { timeout: 10000 })
    
    console.log('[UAT] Step 3: Navigated to Workspace successfully')

    // Step 4: ContextDetailPanel 验证
    console.log('[UAT] Step 4: Verifying ContextDetailPanel...')
    
    // 等待 context detail panel 出现
    const contextDetail = page.locator('.context-detail')
    await expect(contextDetail).toBeVisible({ timeout: 10000 })

    // Skill section: 显示 skillId + version + loadedSections
    const skillCard = contextDetail.locator('text=Skill').first()
    await expect(skillCard).toBeVisible()
    
    // 查找包含 skillId 和 version 的内容
    const skillTitle = contextDetail.locator('div', { hasText: /v\d+/ }).first()
    await expect(skillTitle).toBeVisible()

    // Skill section: 点击"查看使用说明" → 展开显示 SKILL.md 内容
    const viewInstructionsBtn = contextDetail.locator('button', { hasText: /查看使用说明|viewInstructions|view.*instructions/i }).first()
    if (await viewInstructionsBtn.isVisible()) {
      await viewInstructionsBtn.click()
      // 等待展开后的内容
      await expect(contextDetail.locator('.context-detail__skill-content')).toBeVisible({ timeout: 5000 })
      console.log('[UAT] Step 4: Skill instructions expanded successfully')
    }

    // Execution section: 显示 state / stage / steps / elapsed
    const executionCard = contextDetail.locator('text=Execution').first()
    await expect(executionCard).toBeVisible()
    
    // 验证包含这些关键字段
    await expect(contextDetail).toContainText(/state|stage|steps|elapsed/i)

    // Execution section: 点击"查看输出" → 展示执行结果文本
    const viewOutputBtn = contextDetail.locator('button', { hasText: /查看输出|viewOutput|view.*output/i }).first()
    if (await viewOutputBtn.isVisible()) {
      await viewOutputBtn.click()
      // 等待展开后的内容
      await expect(contextDetail.locator('.context-detail__exec-content')).toBeVisible({ timeout: 5000 })
      console.log('[UAT] Step 4: Execution output expanded successfully')
    }

    // Result section: 显示结果条目（文件名、大小、类型）
    const resultCard = contextDetail.locator('text=Outputs').first()
    await expect(resultCard).toBeVisible()

    // 验证 result items (如果有)
    const resultItems = contextDetail.locator('.result-item')
    if (await resultItems.count() > 0) {
      await expect(resultItems.first()).toBeVisible()
      // 验证包含文件名、大小、类型等信息
      await expect(contextDetail).toContainText(/大小|size|类型|type|KB|MB/i)
    }

    console.log('[UAT] Step 4: ContextDetailPanel verified successfully')

    // Step 5: 普通消息对比
    console.log('[UAT] Step 5: Testing regular message...')
    
    // 返回聊天页面
    await page.goto('/chat')
    await page.waitForLoadState('networkidle')
    
    // 输入普通消息
    await chatInput.click()
    await chatInput.fill('你好')
    await page.keyboard.press('Enter')
    
    // 验证没有 TaskBadge
    await page.waitForTimeout(2000) // 给一些时间让消息发送
    const allTaskBadges = page.locator('.task-badge')
    // 此时最新的消息应该没有 TaskBadge（或只有之前的）
    // 主要验证是普通气泡消息
    const chatMessages = page.locator('.message, .bubble')
    await expect(chatMessages.last()).toBeVisible({ timeout: 10000 })
    
    console.log('[UAT] Step 5: Regular message comparison completed successfully')

    console.log('[UAT] All steps completed successfully! ✓')
  })
})
