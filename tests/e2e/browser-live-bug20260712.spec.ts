import { test, expect, type Page } from '@playwright/test'
import { cleanupK12Child } from './live-fixture-cleanup'

/**
 * BUG-20260712 批次 · 真实点击验证（live sidecar :16060 + vite :5173 + 真实视觉模型）。
 *
 * 覆盖用户报告的四件事：
 *  ① composer 样式审计（「输入框样式错乱」）：结构/字号/工具行断言 + 截图取证；
 *  ② 识题链路真实上传作业照片：计时（「识题很慢」量化）+ 结果行出现；
 *  ③ Bug S 保活：切错题本→回辅导，结果仍在、不重新识题；错题本页无 tutoring-tips 红字（abort 泄漏）；
 *  ④ 「这份作业的辅导要点」📱发送到手机（剪贴板真断言）+ 🖨打印（打印 iframe 真断言）；
 *  ⑤ 已答卷整张批改 → 原图全量叠加 → Playwright 截图附件留证。
 *
 * 前置：pnpm dev + sidecar 在跑；HEX_E2E_HOMEWORK 指向一张真实作业照片。
 * 图片是外部真实夹具，不得回退到某次会话的临时 scratchpad 路径；夹具缺失应明确 skip。
 */

const HOMEWORK = process.env.HEX_E2E_HOMEWORK
const GRADED_OUTPUT = process.env.HEX_E2E_GRADED_OUTPUT
let createdChild = ''

test.describe('BUG-20260712 真实点击验证', () => {
  test.setTimeout(600_000)
  test.skip(
    !HOMEWORK,
    '缺少真实作业图片夹具：请设置 HEX_E2E_HOMEWORK=/absolute/path/to/homework.jpg',
  )

  test.afterEach(async ({ request }) => {
    await cleanupK12Child(request, createdChild)
    createdChild = ''
  })

  test('composer 审计 → 上传识题 → tab 保活 → 辅导要点 📱/🖨', async ({
    page,
    context,
  }: {
    page: Page
    context: import('@playwright/test').BrowserContext
  }, testInfo) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.addInitScript(() => {
      sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
      // 打印取证：打印发生在隐藏 iframe 的 window 上，init script 注入每个 frame
      if (window !== window.top) {
        try {
          ;(window as unknown as { print: () => void }).print = () => {
            ;(window.top as unknown as { __tutoringTipsPrinted?: boolean }).__tutoringTipsPrinted = true
          }
        } catch {
          /* cross-origin 忽略 */
        }
      }
    })

    // 1) 真实用户路径：模板库建档 → 卡片 → 进入辅导（隔离引擎空库，从零建）
    const CHILD = `验证${Math.random().toString(36).slice(2, 5)}`
    createdChild = CHILD
    await page.goto('/agents', { waitUntil: 'domcontentloaded' })
    const skip = page.getByRole('button', { name: '跳过' })
    if (await skip.isVisible().catch(() => false)) await skip.click()
    await page.getByText('模板库', { exact: false }).first().click()
    await page.getByText('作业辅导助手', { exact: false }).first().click()
    await expect(page.getByText('创建「K12 辅导助手」')).toBeVisible({ timeout: 15_000 })
    await page.locator('.k12pf__input').first().fill(CHILD)
    // 真实夹具是五年级下册作业；明确选同年级学期，避免合法题目被误判为超纲。
    await page.locator('.k12pf .hc-select__trigger').nth(0).click()
    await page.locator('.hc-select__dropdown .hc-select__option', { hasText: '五年级' }).click()
    await page.locator('.k12pf .hc-select__trigger').nth(1).click()
    await page.locator('.hc-select__dropdown .hc-select__option', { hasText: '下学期' }).click()
    await page.getByRole('button', { name: '创建' }).click()
    await expect(page.locator('.k12pf')).toHaveCount(0, { timeout: 20_000 })
    await page.getByText('我的智能体', { exact: false }).first().click()
    const card = page.locator('.hc-cxcard', { hasText: CHILD })
    await expect(card).toBeVisible({ timeout: 20_000 })
    await card.getByRole('button', { name: /进入辅导/ }).click()
    await expect(page).toHaveURL(/\/chat/, { timeout: 15_000 })
    await expect(page.locator('.k12enh-seg')).toBeVisible({ timeout: 20_000 })

    // 2) composer 样式审计（「样式错乱」定位）：盒可见、canonical editor 字号正常、工具行齐全、发送键在
    const box = page.locator('.hc-composer__box')
    await expect(box).toBeVisible()
    const editor = box.getByTestId('chat-input')
    const fontSize = await editor.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))
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
    await page.locator('.hc-composer input[type="file"]').setInputFiles(HOMEWORK!)
    const guard = page.locator('[data-testid="recognize-guard"]')
    await expect(guard).toBeVisible({ timeout: 15_000 })
    const t0 = Date.now()
    await expect(guard.locator('[data-testid="rq-item"]').first()).toBeVisible({ timeout: 240_000 })
    const recognizeSecs = Math.round((Date.now() - t0) / 1000)
    const rowCount = await guard.locator('[data-testid="rq-item"]').count()
    console.log(`[perf] 识题耗时 ${recognizeSecs}s · 识出 ${rowCount} 题`)
    // 图片批改不是可选装饰：真实已答卷必须等独立坐标阶段完成。旧实现把
    // 耗时的答案重誊录串在坐标响应后，用户批改完成仍拿不到任何 bbox。
    await expect(guard.locator('[data-testid="recognize-anchor-status"]')).toHaveCount(0, {
      timeout: 240_000,
    })

    // 4) Bug S 保活：切错题本 → 无 tutoring-tips 红字 → 回辅导 → 结果仍在、不重新识题
    await page.locator('.k12enh-seg button', { hasText: '错题本' }).click()
    await expect(page.locator('.k12rec')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText('Fetch is aborted')).toHaveCount(0)
    await expect(page.getByText('tutoring-tips')).toHaveCount(0)
    await page.locator('.k12enh-seg button', { hasText: '辅导' }).click()
    await expect(guard.locator('[data-testid="rq-item"]').first()).toBeVisible({ timeout: 5_000 })
    await expect(guard.getByText('正在识题分题')).toHaveCount(0) // 不得重新识题

    // 5) 确认读对 → 辅导要点生成（真实 LLM）
    await guard.locator('[data-testid="recognize-confirm-all"]').click()
    const tutoringTips = page.locator('[data-testid="tutoring-tips"]')
    await expect(tutoringTips).toBeVisible({ timeout: 15_000 })
    await expect(tutoringTips.locator('.tutoring-tips__section').first()).toBeVisible({ timeout: 240_000 })

    // 6) 已答卷整张批改：只批改读出的 student_answer；有 bbox 但未读清的题必须提示补录，
    // 不得混进“空白题求解”。真实模型批改结束后，每道成功结果都进入原图批改层。
    const answeredCount = await guard
      .locator('[data-testid^="rq-answer-"]')
      .evaluateAll(
        (inputs) =>
          inputs.filter((input) => (input as HTMLInputElement).value.trim().length > 0).length,
      )
    expect(answeredCount, '真实已答卷至少应识出一题学生作答').toBeGreaterThan(0)
    const gradeAll = guard.locator('[data-testid="recognize-grade-all"]')
    await expect(gradeAll).toBeVisible()
    await gradeAll.click()
    await expect(gradeAll).toHaveCount(0, { timeout: 480_000 })
    const overlay = guard.locator('[data-testid="photo-grade-overlay"]')
    await expect(overlay).toBeVisible()
    const positionedCount = await overlay.locator('[data-testid^="overlay-mark-"]').count()
    const degradedCount = await overlay.locator('[data-testid^="overlay-degraded-"]').count()
    const outOfScopeCount = await overlay.locator('.pg-overlay__degraded-verdict.is-scope').count()
    const renderedVerdicts = positionedCount + degradedCount
    expect(renderedVerdicts, '每道已批改题都应有原图标记或诚实降级文字结论').toBe(answeredCount)
    expect(
      positionedCount,
      '真实已答作业的每道范围内已批改题都必须获得独立核验坐标，不能退化成纯文字',
    ).toBe(answeredCount - outOfScopeCount)
    expect(positionedCount, '真实图片批改至少应在原图上产生一个可信标记').toBeGreaterThan(0)
    expect(degradedCount, '只有超出当前学段的题可以不画勾叉；其他题缺坐标必须使门禁失败').toBe(
      outOfScopeCount,
    )

    // 权威原型不提供“保存批改图”；以可见批改层截图作为真实测试证据。
    await expect(
      overlay.getByTestId('overlay-save'),
      'the authoritative grading overlay has no save control',
    ).toHaveCount(0)
    const overlayScreenshot = await overlay.screenshot(
      GRADED_OUTPUT ? { path: GRADED_OUTPUT, type: 'png' } : { type: 'png' },
    )
    expect(overlayScreenshot.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    await testInfo.attach('bug20260712-grading-overlay.png', {
      body: overlayScreenshot,
      contentType: 'image/png',
    })
    console.log(`[grade] 已答 ${answeredCount} 题全部批改并叠加，截图证据已附加`)

    // 7) 📱 发送到手机 = 复制文本到剪贴板（真剪贴板断言）
    await tutoringTips.locator('[data-testid="tutoring-tips-send"]').click()
    const clip = await page.evaluate(() => navigator.clipboard.readText())
    expect(clip.length, '剪贴板应有辅导要点全文').toBeGreaterThan(20)
    console.log(`[clip] 剪贴板内容已验证，字符数=${[...clip].length}`)

    // 8) 🖨 打印 = 隐藏 iframe + window.print（frame 内 print 已打桩取证）
    await tutoringTips.locator('[data-testid="tutoring-tips-print"]').click()
    await expect
      .poll(
        async () =>
          page.evaluate(
            () =>
              (window as unknown as { __tutoringTipsPrinted?: boolean }).__tutoringTipsPrinted === true ||
              document.querySelectorAll('iframe').length > 0,
          ),
        { timeout: 3_000 },
      )
      .toBe(true)
    console.log('[print] 打印 iframe/print() 已发起')
  })
})
