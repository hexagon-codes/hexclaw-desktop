import { test, expect } from '@playwright/test'

/**
 * 结构化人设编辑器 · 真机手感（WebKit）真实点击门 —— 补 BUG-20260704 回归。
 *
 * 为什么在 WebKit 里跑：编辑器左栏是 `overflow-y-auto` 的 flex 竖列，段卡带 `overflow-hidden`；
 * 缺 `flex-shrink-0` 时 flex 子项 min-height 归零，内容超高会被「压扁裁剪」成一条缝（实机表现
 * ＝人设编辑器「编辑不了」＋显示错乱），而非滚动。这类 flex/overflow 几何回归 Chromium/jsdom
 * 未必照得出，须在 WKWebView 同引擎家族（WebKit）里用真实点击验证。
 *
 * 自包含、不依赖 sidecar：onMounted 的 loadRoles/loadAgents/loadRules/loadConfig 全部内部 try/catch
 * 并降级，故 `?create=1` 无论后端在不在都会打开新建弹窗；本套件再 stub `/_hexclaw/**` 让渲染确定化。
 * 编辑器本身零后端契约（自由段合成纯前端）。前置：`npx playwright install webkit`；跑：`pnpm test:webkit-feel`。
 */

test.describe('结构化人设编辑器 @ WebKit（真实点击）', () => {
  test.beforeEach(async ({ page }) => {
    // 跳过首配向导重定向，直达 /agents
    await page.addInitScript(() => {
      try {
        localStorage.setItem('hexclaw:welcomeRedirectDone', '1')
        sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
      } catch { /* ignore */ }
    })
    // 后端解耦：所有 /_hexclaw 调用给确定的空壳响应，渲染不依赖 sidecar 是否在跑
    await page.route('**/_hexclaw/**', (route) => {
      const url = route.request().url()
      let body: unknown = {}
      if (url.includes('/agents')) body = { agents: [], total: 0, default: '' }
      else if (url.includes('/roles')) body = { roles: [] }
      else if (url.includes('/rules')) body = { rules: [], total: 0 }
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    })
    await page.goto('/agents?create=1')
  })

  // 打开创建流程 → 空白新建 → 专注编辑，返回结构化编辑器的 overlay locator
  async function openEditor(page: import('@playwright/test').Page) {
    await page.locator('[data-testid="start-blank"]').click()
    await page.locator('[data-testid="agent-soul-focus-add"]').click()
    const overlay = page.locator('[data-testid="soul-editor-overlay"]')
    await expect(overlay).toBeVisible({ timeout: 10_000 })
    return overlay
  }

  test('① 打开即渲染：左栏可滚动、绝不压扁裁剪（BUG-20260704 核心回归）', async ({ page }) => {
    await openEditor(page)
    const geo = await page.evaluate(() => {
      const col = document.querySelector('[data-testid="soul-seg-column"]') as HTMLElement
      const idInput = document.querySelector('[data-testid="soul-seg-input-identity"]') as HTMLTextAreaElement
      const kids = Array.from(col.children)
      return {
        childCount: kids.length,
        allShrink0: kids.every((k) => k.classList.contains('flex-shrink-0')),
        scrollable: col.scrollHeight > col.clientHeight + 2,
        identityTextareaH: Math.round(idInput.getBoundingClientRect().height),
        segInputCount: document.querySelectorAll('[data-testid^="soul-seg-input-"]').length,
      }
    })
    expect(geo.childCount).toBeGreaterThan(7)          // 提示 + 7 段 + 自动注入标题 + 3 自动卡
    expect(geo.allShrink0).toBe(true)                  // 全部 flex-shrink-0
    expect(geo.scrollable).toBe(true)                  // 内容超高 → 滚动而非压扁
    expect(geo.identityTextareaH).toBeGreaterThan(30)  // textarea 是正常高度，不是被裁的缝
    expect(geo.segInputCount).toBe(7)
  })

  test('② 预设切换 + 段开关 + 体检联动（真实点击）', async ({ page }) => {
    await openEditor(page)
    const score = () => page.locator('[data-testid="soul-health-score"]')

    // 完整 → 高分
    await expect(score()).toHaveText(/(8[0-9]|9[0-9]|100)/)

    // 空白 → 仅基础分 12、无输入框
    await page.locator('[data-testid="soul-preset-blank"]').click()
    await expect(score()).toHaveText('12')
    await expect(page.locator('[data-testid^="soul-seg-input-"]')).toHaveCount(0)

    // 开启身份段 → 自动回填示例、输入框出现、分数抬升
    await page.locator('[data-testid="soul-seg-toggle-identity"]').click()
    const idInput = page.locator('[data-testid="soul-seg-input-identity"]')
    await expect(idInput).toBeVisible()
    await expect(idInput).not.toHaveValue('')
    await expect(score()).not.toHaveText('12')
  })

  test('③ 手动输入 + 原文预览 + 完成回填全链路（真实点击）', async ({ page }) => {
    await openEditor(page)

    // 从空白起，只开身份段并手写内容
    await page.locator('[data-testid="soul-preset-blank"]').click()
    await page.locator('[data-testid="soul-seg-toggle-identity"]').click()
    const idInput = page.locator('[data-testid="soul-seg-input-identity"]')
    await idInput.fill('你是小蟹，靠谱的桌面助理。')

    // 原文预览：出 markdown 小节
    await page.locator('[data-testid="soul-preview-raw-tab"]').click()
    await expect(page.locator('[data-testid="soul-preview-body"] pre')).toContainText('## 身份（Identity）')
    await expect(page.locator('[data-testid="soul-preview-body"] pre')).toContainText('你是小蟹，靠谱的桌面助理。')

    // 完成并回填：编辑器关闭 + 人设文本框拿到合成结果
    await page.locator('[data-testid="soul-apply"]').click()
    await expect(page.locator('[data-testid="soul-editor-overlay"]')).toHaveCount(0)
    const backfilled = await page.evaluate(() =>
      Array.from(document.querySelectorAll('textarea')).map((t) => t.value).find((v) => v.includes('身份（Identity）')) ?? '',
    )
    expect(backfilled).toContain('## 身份（Identity）')
    expect(backfilled).toContain('你是小蟹，靠谱的桌面助理。')
  })
})
