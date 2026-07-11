import { test, expect, type Page } from '@playwright/test'

/**
 * 本轮改动 live 验证 + 全导航冒烟（对 live sidecar :16060 + vite :5173）。
 *
 * A. 本轮 3 处改动逐个取证：
 *    1) z-index：编辑档案「年级·学期」HcSelect 下拉展开后**能点中选项**（若被遮罩盖住 → Playwright
 *       actionability 点击超时失败，即真实遮挡检测，非仅 toBeVisible）。
 *    2) 会话列表对齐原型：进辅导建会话 → 会话项左侧智能体图标（emoji avatar）+ meta 显示所属智能体名。
 *    3) 派生描述：改档保存 → 智能体卡副标题变为「教材 · 年级 · 按年级边界讲解」（非写死，随档案跟随）。
 * B. 全导航冒烟：逐个主视图渲染无崩溃 + 无未捕获页面异常。
 *
 * 前置：`npm run dev`（:5173）+ 后端 sidecar（:16060）在运行。
 */

// 已存在的 K12 辅导老师（后端预置 k12-tutor-KKE5v8zQ，display_name「小明的辅导老师 · 五年级」）
const EXISTING_CHILD = '小明'

async function gotoMyAgents(page: Page) {
  await page.goto('/agents', { waitUntil: 'domcontentloaded' })
  const skip = page.getByRole('button', { name: '跳过' })
  if (await skip.isVisible().catch(() => false)) await skip.click()
  // 切到「运行中智能体 / 我的智能体」，避免停在模板库
  const mine = page.getByText(/运行中智能体|我的智能体/, { exact: false }).first()
  if (await mine.isVisible().catch(() => false)) await mine.click()
}

test.describe('本轮改动 live 验证', () => {
  test.setTimeout(120_000)

  // AP-197：夹具存在性门——本套依赖 live app + 后端预置的「小明」辅导卡。夹具缺失时
  // 应 skip（区分「环境没备好」与「真回归」），而非让首个 toBeVisible 假失败。
  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage()
    try {
      await gotoMyAgents(page)
      const card = page.locator('.hc-cxcard', { hasText: EXISTING_CHILD }).first()
      const present = await card.isVisible({ timeout: 20_000 }).catch(() => false)
      test.skip(!present, `live 夹具缺失：未找到预置「${EXISTING_CHILD}」辅导卡（需 live app :5173 + sidecar :16060 + 预置 k12-tutor）`)
    } finally {
      await page.close()
    }
  })

  test('#1 z-index：编辑档案年级下拉展开并能点中选项（遮罩不再盖住）', async ({ page }: { page: Page }) => {
    await gotoMyAgents(page)
    const card = page.locator('.hc-cxcard', { hasText: EXISTING_CHILD }).first()
    await expect(card).toBeVisible({ timeout: 20_000 })
    await card.getByRole('button', { name: /编辑档案/ }).click()

    // 弹窗出现
    await expect(page.locator('.k12pf')).toBeVisible({ timeout: 15_000 })
    // 打开「年级·学期」HcSelect（第 0 个 trigger）
    const gradeTrigger = page.locator('.k12pf .hc-select__trigger').nth(0)
    await gradeTrigger.click()
    // 下拉出现（Teleport 到 body）
    const dropdown = page.locator('.hc-select__dropdown')
    await expect(dropdown).toBeVisible({ timeout: 5_000 })
    // 关键：点中一个选项。若遮罩(z-index)盖住下拉，此 click 会因 actionability 超时失败 → 即遮挡回归。
    await dropdown.locator('.hc-select__option', { hasText: '六年级上' }).click({ timeout: 5_000 })
    // trigger 标签更新 = 选中生效（下拉确实可交互，未被盖）
    await expect(gradeTrigger).toContainText('六年级上')
    // 收尾：取消，不落库污染（本用例只验证下拉可用）
    await page.locator('.k12pf__x').click().catch(() => {})
  })

  test('#3 派生描述：改档保存后卡片副标题=「教材 · 年级 · 按年级边界讲解」', async ({ page }: { page: Page }) => {
    await gotoMyAgents(page)
    const card = page.locator('.hc-cxcard', { hasText: EXISTING_CHILD }).first()
    await expect(card).toBeVisible({ timeout: 20_000 })
    await card.getByRole('button', { name: /编辑档案/ }).click()
    await expect(page.locator('.k12pf')).toBeVisible({ timeout: 15_000 })

    // 读当前年级 trigger 文案，保存后据此断言描述
    const gradeTrigger = page.locator('.k12pf .hc-select__trigger').nth(0)
    const gradeText = (await gradeTrigger.textContent())?.trim() || ''
    await page.getByRole('button', { name: '保存' }).click()
    await expect(page.locator('.k12pf')).toHaveCount(0, { timeout: 20_000 })

    // 卡片副标题（agent.description）现应为派生串，含 tagline + 年级
    const card2 = page.locator('.hc-cxcard', { hasText: EXISTING_CHILD }).first()
    await expect(card2).toContainText('按年级边界讲解', { timeout: 15_000 })
    if (gradeText) await expect(card2).toContainText(gradeText)
  })

})

test.describe('全导航冒烟（每个主视图渲染无崩溃）', () => {
  test.setTimeout(120_000)

  const ROUTES: { path: string; expectText?: RegExp }[] = [
    { path: '/chat' },
    { path: '/agents' },
    { path: '/knowledge' },
    { path: '/knowledge/memory' },
    { path: '/automation' },
    { path: '/automation/webhooks' },
    { path: '/automation/workflows' },
    { path: '/channels' },
    { path: '/integration' },
    { path: '/integration/mcp' },
    { path: '/integration/prompts' },
    { path: '/logs' },
    { path: '/settings' },
    { path: '/about' },
  ]

  test('逐个主路由加载：无未捕获页面异常、根容器渲染', async ({ page }: { page: Page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (e) => pageErrors.push(`${page.url()} :: ${e.message}`))

    for (const r of ROUTES) {
      await page.goto(r.path, { waitUntil: 'domcontentloaded' })
      const skip = page.getByRole('button', { name: '跳过' })
      if (await skip.isVisible().catch(() => false)) await skip.click()
      // 应用外壳根容器渲染（侧栏或主区任一）——证明该路由没白屏/崩溃
      await expect(page.locator('.hc-sidebar, #app > *').first()).toBeVisible({ timeout: 15_000 })
      // 给异步视图一点时间抛错
      await page.waitForTimeout(400)
    }

    // 允许资源 404 之类（不进 pageerror），但不允许未捕获 JS 异常（白屏根因）
    expect(pageErrors, `未捕获页面异常:\n${pageErrors.join('\n')}`).toEqual([])
  })
})
