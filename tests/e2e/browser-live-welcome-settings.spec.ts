import { test, expect } from '@playwright/test'

test.describe('Welcome + Settings against live sidecar', () => {
  test.setTimeout(120_000)

  test('welcome skip reaches chat and settings page renders key sections', async ({ page }) => {
    await page.addInitScript(() => {
      sessionStorage.removeItem('hexclaw:welcomeRedirectDone')
    })

    await page.goto('/welcome')
    await page.waitForLoadState('networkidle')

    await expect(page.getByRole('heading', { name: '欢迎使用 HexClaw 河蟹 AI' })).toBeVisible()
    await expect(page.getByRole('button', { name: '跳过' })).toBeVisible()

    await page.getByRole('button', { name: '跳过' }).click()
    await expect(page).toHaveURL(/\/chat$/)
    await expect(page.locator('textarea').first()).toBeVisible()

    await page.goto('/settings')
    await page.waitForLoadState('networkidle')

    await expect(page).toHaveURL(/\/settings$/)
    await expect(page.getByText('LLM 服务商')).toBeVisible()
    await expect(page.getByText('系统设置')).toBeVisible()
    await expect(page.getByRole('button', { name: '保存配置' })).toBeVisible()
  })
})
