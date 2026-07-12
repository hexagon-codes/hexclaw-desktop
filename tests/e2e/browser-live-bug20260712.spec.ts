import { test, expect, type Page } from '@playwright/test'

/**
 * BUG-20260712 批次 · 真实点击验证（live sidecar :16060 + vite :5173 + 真实视觉模型）。
 *
 * 覆盖用户报告的四件事：
 *  ① composer 样式审计（「输入框样式错乱」）：结构/字号/工具行断言 + 截图取证；
 *  ② 识题链路真实上传作业照片：计时（「识题很慢」量化）+ 结果行出现；
 *  ③ Bug S 保活：切错题本→回辅导，结果仍在、不重新识题；错题本页无 prep-card 红字（abort 泄漏）；
 *  ④ 「这份作业的辅导要点」📱发送到手机（剪贴板真断言）+ 🖨打印（打印 iframe 真断言）。
 *
 * 前置：pnpm dev + sidecar 在跑；HEX_E2E_HOMEWORK 指向作业照片（缺省用 scratchpad 暂存）。
 */

const HOMEWORK = process.env.HEX_E2E_HOMEWORK
  || '/private/tmp/claude-502/-Users-guoyanjun-work-hexclaw-desktop/276663ef-5727-43e2-879e-a580be504f87/scratchpad/homework.jpg'

test.describe('BUG-20260712 真实点击验证', () => {
  test.setTimeout(420_000)

  test('composer 审计 → 上传识题 → tab 保活 → 辅导要点 📱/🖨', async ({ page, context }: { page: Page; context: import('@playwright/test').BrowserContext }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.addInitScript(() => {
      sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
      // 打印取证：打印发生在隐藏 iframe 的 window 上，init script 注入每个 frame
      if (window !== window.top) {
        try { (window as unknown as { print: () => void }).print = () => { (window.top as unknown as { __prepPrinted?: boolean }).__prepPrinted = true } } catch { /* cross-origin 忽略 */ }
      }
    })

    // 1) 真实用户路径：模板库建档 → 卡片 → 进入辅导（隔离引擎空库，从零建）
    const CHILD = `验证${Math.random().toString(36).slice(2, 5)}`
    await page.goto('/agents', { waitUntil: 'domcontentloaded' })
    const skip = page.getByRole('button', { name: '跳过' })
    if (await skip.isVisible().catch(() => false)) await skip.click()
    await page.getByText('模板库', { exact: false }).first().click()
    await page.getByText('作业辅导助手', { exact: false }).first().click()
    await expect(page.getByText('创建「作业辅导助手」')).toBeVisible({ timeout: 15_000 })
    await page.locator('.k12pf__input').first().fill(CHILD)
    await page.getByRole('button', { name: '创建' }).click()
    await expect(page.locator('.k12pf')).toHaveCount(0, { timeout: 20_000 })
    await page.getByText('我的智能体', { exact: false }).first().click()
    const card = page.locator('.hc-cxcard', { hasText: CHILD })
    await expect(card).toBeVisible({ timeout: 20_000 })
    await card.getByRole('button', { name: /进入辅导/ }).click()
    await expect(page).toHaveURL(/\/chat/, { timeout: 15_000 })
    await expect(page.locator('.k12enh-seg')).toBeVisible({ timeout: 20_000 })

    // 2) composer 样式审计（「样式错乱」定位）：盒可见、textarea 字号正常、工具行齐全、发送键在
    const box = page.locator('.hc-composer__box')
    await expect(box).toBeVisible()
    const ta = box.locator('textarea')
    const fontSize = await ta.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))
    expect(fontSize, `composer 字号异常放大: ${fontSize}px`).toBeLessThanOrEqual(16)
    const toolCount = await box.locator('.hc-composer__tool:visible').count()
    expect(toolCount, 'composer 工具行按钮缺失').toBeGreaterThanOrEqual(4) // + / Skill / Prompt / 🎤
    await expect(box.locator('.hc-composer__send')).toBeVisible()
    const boxBB = await box.boundingBox()
    const vp = page.viewportSize()!
    expect(boxBB!.x, 'composer 左缘越界（圆角被裁）').toBeGreaterThanOrEqual(0)
    expect(boxBB!.x + boxBB!.width, 'composer 右缘越界').toBeLessThanOrEqual(vp.width + 1)
    await box.screenshot({ path: 'test-results/bug20260712-composer.png' })

    // 3) 真实上传作业照片 → 自动改道识题（计时）
    await page.locator('.hc-composer input[type="file"]').setInputFiles(HOMEWORK)
    const guard = page.locator('[data-testid="recognize-guard"]')
    await expect(guard).toBeVisible({ timeout: 15_000 })
    const t0 = Date.now()
    await expect(guard.locator('[data-testid="rq-item"]').first()).toBeVisible({ timeout: 240_000 })
    const recognizeSecs = Math.round((Date.now() - t0) / 1000)
    const rowCount = await guard.locator('[data-testid="rq-item"]').count()
    console.log(`[perf] 识题耗时 ${recognizeSecs}s · 识出 ${rowCount} 题`)

    // 4) Bug S 保活：切错题本 → 无 prep-card 红字 → 回辅导 → 结果仍在、不重新识题
    await page.locator('.k12enh-seg button', { hasText: '错题本' }).click()
    await expect(page.locator('.k12rec')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText('Fetch is aborted')).toHaveCount(0)
    await expect(page.getByText('prep-card')).toHaveCount(0)
    await page.locator('.k12enh-seg button', { hasText: '辅导' }).click()
    await expect(guard.locator('[data-testid="rq-item"]').first()).toBeVisible({ timeout: 5_000 })
    await expect(guard.getByText('正在识题分题')).toHaveCount(0) // 不得重新识题

    // 5) 确认读对 → 辅导要点生成（真实 LLM）
    await guard.locator('[data-testid="recognize-confirm-all"]').click()
    const prep = page.locator('[data-testid="tutor-guide"]')
    await expect(prep).toBeVisible({ timeout: 15_000 })
    await expect(prep.locator('.tutor-section').first()).toBeVisible({ timeout: 240_000 })

    // 6) 📱 发送到手机 = 复制文本到剪贴板（真剪贴板断言）
    await prep.locator('[data-testid="prep-send"]').click()
    const clip = await page.evaluate(() => navigator.clipboard.readText())
    expect(clip.length, '剪贴板应有辅导要点全文').toBeGreaterThan(20)
    console.log(`[clip] 剪贴板前 60 字: ${clip.slice(0, 60).replace(/\n/g, ' ')}`)

    // 7) 🖨 打印 = 隐藏 iframe + window.print（frame 内 print 已打桩取证）
    await prep.locator('[data-testid="prep-print"]').click()
    await expect
      .poll(async () => page.evaluate(() => (window as unknown as { __prepPrinted?: boolean }).__prepPrinted === true
        || document.querySelectorAll('iframe').length > 0), { timeout: 3_000 })
      .toBe(true)
    console.log('[print] 打印 iframe/print() 已发起')
  })
})
