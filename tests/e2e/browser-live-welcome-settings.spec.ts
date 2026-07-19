import { test, expect } from '@playwright/test'

test.describe('Welcome + Settings against live sidecar', () => {
  test.setTimeout(180_000)

  test('welcome skip reaches chat and settings page renders key sections', async ({ page }) => {
    await page.addInitScript(() => {
      sessionStorage.removeItem('hexclaw:welcomeRedirectDone')
      localStorage.setItem('hc-theme', 'light')
    })

    await page.goto('/welcome', { waitUntil: 'domcontentloaded' })

    await expect(page.getByRole('heading', { name: '欢迎使用 HexClaw 河蟹 AI' })).toBeVisible()
    await expect(page.getByRole('button', { name: '跳过' })).toBeVisible()

    await page.getByRole('button', { name: '跳过' }).click()
    await expect(page).toHaveURL(/\/chat$/)
    await expect(page.locator('textarea').first()).toBeVisible()

    await page.goto('/settings', { waitUntil: 'domcontentloaded' })

    await expect(page).toHaveURL(/\/settings$/)
    await expect(page.getByRole('tab', { name: 'LLM 服务商' })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole('tab', { name: '系统设置' })).toBeVisible()
    await expect(page.getByRole('button', { name: '保存配置' })).toBeVisible()

    await page.getByRole('tab', { name: '系统设置' }).click()
    await expect(page.getByText('系统信息', { exact: true })).toBeVisible()
    await expect(page.getByText('关于河蟹', { exact: true })).toBeVisible()

    const themeCards = page.locator('.hc-settings__theme-card')
    await expect(themeCards).toHaveCount(3)
    await expect(themeCards.first()).toHaveCSS('background-color', 'rgba(255, 255, 255, 0.8)')
    await expect(themeCards.nth(1)).toHaveCSS('background-color', 'rgba(255, 255, 255, 0.8)')
    await expect(themeCards.nth(2)).toHaveCSS('background-color', 'rgba(255, 255, 255, 0.8)')
    await expect(page.locator('.hc-settings__theme-card--active')).toHaveCount(0)
    await expect(page.locator('.hc-settings__info-card')).toHaveCSS('border-radius', '10px')

    const systemLayout = await page.evaluate(() => {
      const rect = (selector: string) => {
        const node = document.querySelector<HTMLElement>(selector)
        if (!node) throw new Error(`Missing system-settings node: ${selector}`)
        const box = node.getBoundingClientRect()
        return { top: box.top, width: box.width, height: box.height }
      }
      const section = rect('.hc-settings__section')
      const themeGrid = rect('.hc-settings__theme-grid')
      const languageRow = rect('.hc-settings__row')
      const separators = [...document.querySelectorAll<HTMLElement>('.hc-settings__sep')].map((node) => {
        const box = node.getBoundingClientRect()
        return { top: box.top, height: box.height }
      })
      const toggles = [...document.querySelectorAll<HTMLElement>('.hc-settings__toggle-row')].map((node) => {
        const box = node.getBoundingClientRect()
        return { top: box.top, height: box.height }
      })
      const gridStyle = getComputedStyle(document.querySelector<HTMLElement>('.hc-settings__theme-grid')!)
      return {
        section,
        themeGrid,
        languageRow,
        separators,
        toggles,
        gridGap: gridStyle.gap,
        gridMarginTop: gridStyle.marginTop,
        gridMarginBottom: gridStyle.marginBottom,
      }
    })

    expect(systemLayout.section.width).toBeCloseTo(520, 0)
    expect(systemLayout.themeGrid.top - systemLayout.section.top).toBeCloseTo(32.5, 0)
    expect(systemLayout.themeGrid.height).toBeCloseTo(60, 0)
    expect(systemLayout.languageRow.top - systemLayout.section.top).toBeCloseTo(106.5, 0)
    expect(systemLayout.separators[2]!.top - systemLayout.section.top).toBeCloseTo(377.5, 0)
    expect(systemLayout.separators[3]!.top - systemLayout.section.top).toBeCloseTo(526.75, 0)
    expect(systemLayout.toggles.map(({ height }) => height)).toEqual([51.5, 51.5, 51.5])
    expect(systemLayout.gridGap).toBe('10px')
    expect(systemLayout.gridMarginTop).toBe('8px')
    expect(systemLayout.gridMarginBottom).toBe('14px')

    await themeCards.nth(1).hover()
    await expect(themeCards.nth(1)).toHaveCSS('border-color', 'rgba(95, 179, 234, 0.32)')
    await expect(page.locator('.hc-sidebar__engine-label')).toContainText('Hexagon')

    await expect(page.getByText('高级与诊断', { exact: true })).toHaveCount(0)
    await expect(page.getByText('应用数据', { exact: true })).toHaveCount(0)
    await expect(page.getByText('仅用于故障排查，请勿手动修改目录内容', { exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '在访达中显示' })).toHaveCount(0)
    await expect(page.locator('[data-testid="settings-app-data"]')).toHaveCount(0)
  })
})
