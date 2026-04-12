import { test, expect } from '@playwright/test'

test.describe('Browser UI against live sidecar', () => {
  test.setTimeout(180_000)

  test('chat page loads through Vite proxy and can complete a real chat request', async ({ page }) => {
    await page.addInitScript(() => {
      sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
    })

    await page.goto('/chat?model=qwen3.5:9b')
    await page.waitForLoadState('networkidle')

    const input = page.locator('textarea').first()
    await expect(input).toBeVisible()

    const prompt = `live-browser-sidecar-${Date.now()} 请只回复 ok`
    await input.fill(prompt)
    await page.getByTitle('发送').click()

    await expect(page.locator('.hc-msg--user').filter({ hasText: prompt })).toBeVisible()

    const assistantCard = page.locator('.hc-msg--assistant').last()
    await expect(assistantCard).toBeVisible({ timeout: 120_000 })

    // 等待流式输出完成：助手卡片不再是空占位（需要有实质内容）
    // 排除假阳性：仅检测长度不够，还需确认不是 loading/error 占位
    await expect.poll(
      async () => {
        const text = (await assistantCard.innerText()).replace(/\s+/g, '')
        // 排除常见的空态/错误态占位文本
        const isPlaceholder = text === '' || text.includes('发送失败') || text.includes('请检查')
        return isPlaceholder ? 0 : text.length
      },
      { timeout: 120_000, message: 'Assistant reply should contain meaningful content, not just a placeholder' },
    ).toBeGreaterThan(10) // 真实回复至少 10 个有效字符
  })
})
