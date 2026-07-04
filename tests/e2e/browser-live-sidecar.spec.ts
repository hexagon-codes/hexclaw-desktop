import { test, expect } from '@playwright/test'

test.describe('Browser UI against live sidecar', () => {
  test.setTimeout(600_000)

  test('chat page loads through Vite proxy and can complete a real chat request', async ({ page }) => {
    await page.addInitScript(() => {
      sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
    })

    const liveModel = process.env.HEX_E2E_MODEL || 'qwen3.5:9b'
    await page.goto(`/chat?model=${encodeURIComponent(liveModel)}`, { waitUntil: 'domcontentloaded' })

    const input = page.getByTestId('chat-input')
    await expect(input).toBeVisible({ timeout: 30_000 })

    const suffix = Math.random().toString(36).replace(/[^a-z]/g, '').slice(0, 8)
    const marker = `live-browser-ok-${suffix}`
    const prompt = `请只回复 ${marker}，不要添加其他文字。`
    await input.fill(prompt)
    await page.getByTestId('chat-send').click()

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
        return !isPlaceholder && text.includes(marker) ? 1 : 0
      },
      { timeout: 120_000, message: 'Assistant reply should contain meaningful content, not just a placeholder' },
    ).toBe(1)
  })
})
