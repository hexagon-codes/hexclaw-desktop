import { test, expect, type Page } from '@playwright/test'
import { cleanupK12Child } from './live-fixture-cleanup'

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

  test.afterEach(async ({ request }) => {
    await cleanupK12Child(request, CHILD)
  })

  test('建档 → 进辅导 → 头部tab/chips → 错题本 → 学情 → 备课卡 → 改档', async ({ page }: { page: Page }) => {
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
    // 20260709 文案评审：对家长的呈现名统一「辅导助手」（原「辅导老师」）
    const cardName = `${CHILD}的辅导助手 · 六年级`
    await expect(card).toContainText(cardName)

    // 4) 进入辅导（K12AgentCard 快捷入口，作用于该卡）
    await card.getByRole('button', { name: /进入辅导/ }).click()
    await expect(page).toHaveURL(/\/chat/, { timeout: 15_000 })

    // 5) 会话即入口：头部 tab（辅导/错题本）+ composer 预设 chips（后端 descriptor 下发）。
    //    BUG-20260709：chips 改数据流上交（update:composerChips → ChatInput presetChips），
    //    必须渲染在对话框盒（.hc-composer__box）**内部**，不再是输入框上方 Teleport 浮动行。
    //    （备课提醒 nudge 条已于 20260709 退役——辅导要点内联进识题流。）
    await expect(page.locator('.k12enh-seg')).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('.k12enh-seg')).toContainText('错题本')
    const presetChips = page.locator('.hc-composer__box [data-testid="composer-preset-chip"]')
    await expect(presetChips.first()).toContainText('数学讲解', { timeout: 15_000 })
    await expect(presetChips).toHaveCount(3)

    // 6) 错题本 tab → 记录视图接管消息区
    await page.locator('.k12enh-seg button', { hasText: '错题本' }).click()
    await expect(page.locator('.k12rec')).toBeVisible({ timeout: 15_000 })
    // 二级 tab：错题 / 积累 / 学情
    await expect(page.locator('.k12rec__tabs')).toContainText('学情')

    // 7) 学情 tab → 真实 insight-report（有数据=趋势/学习时长；fresh-DB=空态文案。均属 UI 抵达）
    await page.locator('.k12rec__tabs .seg button', { hasText: '学情' }).click()
    await expect(page.getByText(/学习时长|还没有错题记录/)).toBeVisible({ timeout: 15_000 })

    // 8) 识题唯一入口=composer 图片自动改道（BUG-20260711-E：手动相机 toggle 已删，勿加回）。
    //    上传 1px 图片验证护栏自动打开（识题请求本身依赖 LLM，冒烟不等结果）。
    await page.locator('.k12enh-seg button', { hasText: '辅导' }).click()
    await expect(page.locator('[data-testid="k12-recognize-toggle"]')).toHaveCount(0) // 回归锁
    const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
    await page.locator('.hc-composer input[type="file"]').setInputFiles({ name: 'hw.png', mimeType: 'image/png', buffer: tinyPng })
    await expect(page.locator('[data-testid="recognize-guard"]')).toBeVisible({ timeout: 15_000 })

    // 9) 改档：该卡「编辑档案」→ 改档表单预填当前档案
    await page.goto('/agents', { waitUntil: 'domcontentloaded' })
    const card2 = page.locator('.hc-cxcard', { hasText: CHILD })
    await card2.getByRole('button', { name: /编辑档案/ }).click()
    await expect(page.getByText(`孩子档案 · ${cardName}`, { exact: false })).toBeVisible({ timeout: 15_000 })
    // 预填年级 = 六年级上（读后端 k12.grade_term）——HcSelect trigger 文案即当前值
    await expect(page.locator('.k12pf .hc-select__trigger').nth(0)).toContainText('六年级上')
  })
})
