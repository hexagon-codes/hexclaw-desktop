import { test, expect, type Page } from '@playwright/test'
import { cleanupK12Child } from './live-fixture-cleanup'

/**
 * K12 家长辅导助手 · 全链路 UI 冒烟（对 live sidecar :16060 + vite :5173）。
 *
 * 覆盖：建档（/agents 模板库 → 作业辅导助手 → 表单）→ 智能体卡快捷入口 →
 * 会话即入口（头部 tab / composer 预设 chips）→ 学习档案五对象 → 顶栏学情 → 编辑档案。
 *
 * LLM 无关：建档/描述符/学习档案/学情均不依赖云端模型（grade/tutoringTips 内容依赖 LLM，此处只验证 UI 抵达）。
 * 前置：`pnpm dev`（:5173）+ 后端 sidecar（:16060）已在运行。
 */

const CHILD = `冒烟${Math.random().toString(36).slice(2, 6)}`

test.describe('K12 全链路 UI 冒烟', () => {
  test.setTimeout(180_000)

  test.afterEach(async ({ request }) => {
    await cleanupK12Child(request, CHILD)
  })

  test('建档 → 进辅导 → 头部tab/chips → 学习档案五对象 → 学情 → 改档', async ({
    page,
  }: {
    page: Page
  }) => {
    // 平台默认全功能全导航（三模式 / 首启模式选择器已下线 · 2026-07-08）；K12 = 作业辅导智能体，
    // 从 /agents 模板库建档进入，不再走首启模式门控。
    // fresh-DB（无 provider）下路由守卫会重定向 /welcome：预置本 session 的完成标记跳过
    //（建档/描述符/记录链路全部 LLM 无关，无需真配 provider）。
    await page.addInitScript(() => sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1'))
    // 1) 建档：智能体 → 模板库 → 作业辅导助手 → 表单（welcome 若拦截先跳过）
    await page.goto('/agents', { waitUntil: 'domcontentloaded' })
    const skip = page.getByRole('button', { name: '跳过' })
    if (await skip.isVisible().catch(() => false)) await skip.click()
    await page.getByText('模板库', { exact: false }).first().click()
    await page.getByText('作业辅导助手', { exact: false }).first().click()
    // K12ProfileForm 弹出
    await expect(page.getByText('创建「K12 辅导助手」')).toBeVisible({ timeout: 15_000 })
    await page.locator('.k12pf__input').first().fill(CHILD)
    // 年级与学期分别走 HcSelect；value 在提交时仍合成为既有 grade_term。
    await page.locator('.k12pf .hc-select__trigger').nth(0).click()
    await page.locator('.hc-select__dropdown .hc-select__option', { hasText: '六年级' }).click()
    await page.locator('.k12pf .hc-select__trigger').nth(1).click()
    await page.locator('.hc-select__dropdown .hc-select__option', { hasText: '上学期' }).click()
    await page.getByRole('button', { name: '创建' }).click()
    await expect(page.locator('.k12pf')).toHaveCount(0, { timeout: 20_000 }) // 表单关闭 = 建档成功

    // 3) 切「我的智能体」→ 定位刚建的辅导老师卡（含孩子称呼）
    await page.getByText('我的智能体', { exact: false }).first().click()
    const card = page.locator('.hc-cxcard', { hasText: CHILD })
    await expect(card).toBeVisible({ timeout: 20_000 })
    // 20260709 文案评审：对家长的呈现名统一「辅导助手」（原「辅导老师」）
    const cardName = `${CHILD}的辅导助手 · 六年级`
    await expect(card).toContainText(cardName)

    // 4) 进入辅导（K12AgentCard 快捷入口，作用于该卡）
    await card.getByRole('button', { name: /进入辅导/ }).click()
    await expect(page).toHaveURL(/\/chat/, { timeout: 15_000 })

    // 5) 会话即入口：头部严格三段（辅导 / 学习档案 / 学情）
    //    + composer 预设 chips（后端 descriptor 下发）。
    //    BUG-20260709：chips 改数据流上交（update:composerChips → ChatInput presetChips），
    //    必须渲染在对话框盒（.hc-composer__box）**内部**，不再是输入框上方 Teleport 浮动行。
    //    辅导要点只在识题持久确认后内联，不存在独立提醒入口。
    const scenarioTabs = page.locator('.k12enh-seg')
    await expect(scenarioTabs).toBeVisible({ timeout: 20_000 })
    await expect(scenarioTabs.getByRole('tab')).toHaveCount(3)
    await expect(scenarioTabs.getByRole('tab')).toHaveText(['辅导', '学习档案', '学情'])
    await expect(scenarioTabs.getByRole('tab', { name: '辅导', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    const presetChips = page.locator('.hc-composer__box [data-testid="composer-preset-chip"]')
    await expect(presetChips.first()).toContainText('自动识别学科', { timeout: 15_000 })
    await expect(presetChips).toHaveCount(3)

    // 6) 学习档案 tab → 五对象视图接管消息区。学情不得退回二级 Tab。
    await scenarioTabs.getByRole('tab', { name: '学习档案', exact: true }).click()
    await expect(page.locator('.k12rec')).toBeVisible({ timeout: 15_000 })
    const objectTabs = page.getByRole('tablist', { name: '学习档案', exact: true })
    const objectTabItems = objectTabs.getByRole('tab')
    await expect(objectTabItems).toHaveCount(5)
    const objectTabNames = [
      /^本周该练\s+\d+$/,
      /^全部错题\s*\d+$/,
      /^练习集\s*\d+$/,
      /^积累\s*\d+$/,
      /^作品\s*\d+$/,
    ]
    for (const [index, name] of objectTabNames.entries()) {
      await expect(objectTabItems.nth(index)).toHaveAccessibleName(name)
    }
    await expect(objectTabs.getByRole('tab', { name: /学情/ })).toHaveCount(0)
    await expect(page.getByTestId('week-section')).toBeVisible()

    // 7) 顶栏学情 → 真实 insight-report。有数据时展示四张路由卡；fresh-DB 展示证据不足空态。
    await scenarioTabs.getByRole('tab', { name: '学情', exact: true }).click()
    await expect(page.getByTestId('insight-panel')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('insight-title')).toHaveText('六年级上学习概览')
    await expect(page.getByTestId('insight-loading')).toHaveCount(0, { timeout: 15_000 })
    const insightSettledState = page.locator(
      '[data-testid="insight-empty"], [data-testid="insight-tile-semester"]',
    )
    await expect(insightSettledState.first()).toBeVisible({ timeout: 15_000 })
    if (await page.getByTestId('insight-tile-semester').count()) {
      await expect(page.locator('.k12ins__tiles [data-testid^="insight-tile-"]')).toHaveCount(4)
    }

    // 8) 识题唯一入口=composer 图片自动改道（BUG-20260711-E：手动相机 toggle 已删，勿加回）。
    //    上传 1px 图片验证护栏自动打开（识题请求本身依赖 LLM，冒烟不等结果）。
    await scenarioTabs.getByRole('tab', { name: '辅导', exact: true }).click()
    await expect(page.locator('[data-testid="k12-recognize-toggle"]')).toHaveCount(0) // 回归锁
    const tinyPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    )
    await page
      .locator('.hc-composer input[type="file"]')
      .setInputFiles({ name: 'hw.png', mimeType: 'image/png', buffer: tinyPng })
    await expect(page.locator('[data-testid="recognize-guard"]')).toBeVisible({ timeout: 15_000 })

    // 9) 改档：该卡「编辑档案」→ 改档表单预填当前档案
    await page.goto('/agents', { waitUntil: 'domcontentloaded' })
    const card2 = page.locator('.hc-cxcard', { hasText: CHILD })
    await card2.getByRole('button', { name: /编辑档案/ }).click()
    await expect(page.getByText(`孩子档案 · ${CHILD}`, { exact: true })).toBeVisible({
      timeout: 15_000,
    })
    // 既有 grade_term=六年级上 无损拆成两个 HcSelect。
    await expect(page.locator('.k12pf .hc-select__trigger').nth(0)).toContainText('六年级')
    await expect(page.locator('.k12pf .hc-select__trigger').nth(1)).toContainText('上学期')
  })
})
