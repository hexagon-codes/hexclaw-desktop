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
    await expect.poll(
      async () => (await assistantCard.innerText()).replace(/\s+/g, '').length,
      { timeout: 120_000 },
    ).toBeGreaterThan('小蟹'.length)
  })
})
