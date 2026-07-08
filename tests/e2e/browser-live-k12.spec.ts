import { test, expect, type Page } from '@playwright/test'

/**
 * K12 家长备课助手 · 全链路 UI 冒烟（对 live sidecar :16060 + vite :5173）。
 *
 * 覆盖：建档（/agents 模板库 → 作业辅导助手 → 表单）→ 智能体卡快捷入口 →
 * 会话即入口（头部 tab / composer 预设 chips / 备课提醒）→ 错题本记录视图 → 学情 → 备课卡侧栏 → 编辑档案。
 *
 * LLM 无关：建档/描述符/记录列表/学情/备课卡开启 均不依赖云端模型（grade/prep 内容依赖 LLM，此处只验证 UI 抵达）。
 * 前置：`pnpm dev`（:5173）+ 后端 sidecar（:16060）已在运行。
 */

const CHILD = `冒烟${Math.random().toString(36).slice(2, 6)}`

test.describe('K12 全链路 UI 冒烟', () => {
  test.setTimeout(180_000)

  test('建档 → 进辅导 → 头部tab/chips → 错题本 → 学情 → 备课卡 → 改档', async ({ page }: { page: Page }) => {
    // 平台默认全功能全导航（三模式 / 首启模式选择器已下线 · 2026-07-08）；K12 = 作业辅导智能体，
    // 从 /agents 模板库建档进入，不再走首启模式门控。
    // 1) 建档：智能体 → 模板库 → 作业辅导助手 → 表单（welcome 若拦截先跳过）
    await page.goto('/agents', { waitUntil: 'domcontentloaded' })
    const skip = page.getByRole('button', { name: '跳过' })
    if (await skip.isVisible().catch(() => false)) await skip.click()
    await page.getByText('模板库', { exact: false }).first().click()
    await page.getByText('作业辅导助手', { exact: false }).first().click()
    // K12ProfileForm 弹出
    await expect(page.getByText('创建「作业辅导助手」')).toBeVisible({ timeout: 15_000 })
    await page.locator('.k12pf__input').first().fill(CHILD)
    // 年级·学期走 HcSelect（B2 迁移：原生 select → 自渲染下拉，Teleport 到 body）
    await page.locator('.k12pf .hc-select__trigger').nth(0).click()
    await page.locator('.hc-select__dropdown .hc-select__option', { hasText: '六年级上' }).click()
    await page.getByRole('button', { name: '创建' }).click()
    await expect(page.locator('.k12pf')).toHaveCount(0, { timeout: 20_000 }) // 表单关闭 = 建档成功

    // 3) 切「我的智能体」→ 定位刚建的辅导老师卡（含孩子称呼）
    await page.getByText('我的智能体', { exact: false }).first().click()
    const card = page.locator('.hc-cxcard', { hasText: CHILD })
    await expect(card).toBeVisible({ timeout: 20_000 })
    const cardName = `${CHILD}的辅导老师 · 六年级`
    await expect(card).toContainText(cardName)

    // 4) 进入辅导（K12AgentCard 快捷入口，作用于该卡）
    await card.getByRole('button', { name: /进入辅导/ }).click()
    await expect(page).toHaveURL(/\/chat/, { timeout: 15_000 })

    // 5) 会话即入口：头部 tab（辅导/错题本）+ composer 预设 chips（后端 descriptor 下发）+ 备课提醒
    await expect(page.locator('.k12enh-seg')).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('.k12enh-seg')).toContainText('错题本')
    await expect(page.locator('[data-testid="k12-composer-chips"]')).toContainText('数学讲解', { timeout: 15_000 })
    await expect(page.locator('.k12enh-nudge')).toBeVisible()

    // 6) 错题本 tab → 记录视图接管消息区
    await page.locator('.k12enh-seg button', { hasText: '错题本' }).click()
    await expect(page.locator('.k12rec')).toBeVisible({ timeout: 15_000 })
    // 二级 tab：错题 / 积累 / 学情
    await expect(page.locator('.k12rec__tabs')).toContainText('学情')

    // 7) 学情 tab → 真实 insight-report（趋势/建议 或空态，均属 UI 抵达）
    await page.locator('.k12rec__tabs .seg button', { hasText: '学情' }).click()
    await expect(page.locator('.k12rec__insight')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText('学习时长')).toBeVisible()

    // 8) 备课卡侧栏打开（内容依赖 LLM，仅验证侧栏抵达）。备课卡按钮由外层 k12enh 头唯一提供
    //    （实例上下文头卡收归 k12enh-tabs，RecordsView 不再自绘 · BUG-20260708 B8）。
    await page.locator('.k12enh-prepbtn').click()
    await expect(page.locator('.prep-panel.on')).toBeVisible({ timeout: 15_000 })

    // 9) 改档：该卡「编辑档案」→ 改档表单预填当前档案
    await page.goto('/agents', { waitUntil: 'domcontentloaded' })
    const card2 = page.locator('.hc-cxcard', { hasText: CHILD })
    await card2.getByRole('button', { name: /编辑档案/ }).click()
    await expect(page.getByText(`孩子档案 · ${cardName}`, { exact: false })).toBeVisible({ timeout: 15_000 })
    // 预填年级 = 六年级上（读后端 k12.grade_term）——HcSelect trigger 文案即当前值
    await expect(page.locator('.k12pf .hc-select__trigger').nth(0)).toContainText('六年级上')
  })
})
