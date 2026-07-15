import { expect, test } from '@playwright/test'

test.describe('Browser UI + real Sidecar + synthetic provider', () => {
  test('sends a chat through the real sidecar without browser request interception', async ({ page }) => {
    await page.addInitScript(() => {
      sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
    })

    await page.goto('/chat?model=mock-model', { waitUntil: 'domcontentloaded' })

    const input = page.getByTestId('chat-input')
    await expect(input).toBeVisible({ timeout: 30_000 })
    await input.fill('Return the deterministic local mock response.')
    await page.getByTestId('chat-send').click()

    await expect(page.locator('.hc-msg--assistant').last()).toContainText(
      'HEXCLAW_MOCK_CHAT_OK',
      { timeout: 120_000 },
    )
  })
})
