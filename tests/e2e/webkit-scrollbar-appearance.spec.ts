import { test, expect } from '@playwright/test'

/**
 * 滚动条外观一致性 @ WebKit（bug-20260704 会话框滚动条为准：更浅 + 失焦即隐）
 *
 * 用户反馈两条：
 *   ①「各页面滚动条以会话框(会话列表)的下拉滚动条为准，再浅色一点，之前比这浅很多」
 *      —— 全应用滚动条 thumb 统一走 var(--hc-scrollbar-thumb)（会话列表 .hc-sessions / 输入框
 *      .hc-composer__field / 各页面滚动宿主都引用同一变量），故把变量调浅即全局对齐、变浅。
 *   ②「设置页滚动条失去焦点仍显示，期望不显示」
 *      —— WebKit 经典滚动条在窗口失活(:window-inactive)时不随 :hover 隐藏；加全局
 *      `::-webkit-scrollbar-thumb:window-inactive{background:transparent}` 让失焦即隐（全局生效，非仅设置页）。
 *
 * 这两条都是「真机手感」范畴（WKWebView 特异），放 webkit-feel 门里长期回归。
 */
test.describe('滚动条外观 @ WebKit（bug-20260704）', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try {
        localStorage.setItem('hexclaw:welcomeRedirectDone', '1')
        sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
      } catch { /* ignore */ }
    })
    await page.goto('/chat')
    await page.waitForSelector('.hc-chat__input-area', { timeout: 20_000 })
  })

  // ① thumb 变量在两套主题下都足够「浅」（alpha ≤ 阈值）——旧值 light .20 / dark .22 会 RED
  test('① 滚动条 thumb 变量在 light/dark 下都更浅（alpha ≤ 0.16）', async ({ page }) => {
    const alphas = await page.evaluate(() => {
      const parseAlpha = (v: string): number => {
        const m = v.match(/rgba?\([^)]*?,\s*([\d.]+)\s*\)/)
        return m ? parseFloat(m[1]!) : 1 // 无 alpha（如 #rrggbb / rgb()）视作不透明
      }
      const read = (theme: string) => {
        document.documentElement.setAttribute('data-theme', theme)
        const cs = getComputedStyle(document.documentElement)
        return {
          base: parseAlpha(cs.getPropertyValue('--hc-scrollbar-thumb').trim()),
          hover: parseAlpha(cs.getPropertyValue('--hc-scrollbar-thumb-hover').trim()),
          active: parseAlpha(cs.getPropertyValue('--hc-scrollbar-thumb-active').trim()),
        }
      }
      return { light: read('light'), dark: read('dark') }
    })
    for (const theme of ['light', 'dark'] as const) {
      expect(alphas[theme].base, `${theme} base thumb alpha`).toBeLessThanOrEqual(0.16)
      // hover / active 允许更明显但仍受约束，防回归成「一碰就很深」
      expect(alphas[theme].hover, `${theme} hover thumb alpha`).toBeLessThanOrEqual(0.28)
      expect(alphas[theme].active, `${theme} active thumb alpha`).toBeLessThanOrEqual(0.42)
    }
  })

  // ② 存在全局「窗口失活时 thumb 透明」规则（:window-inactive）——旧代码无此规则会 RED
  test('② 失焦即隐：全局存在 ::-webkit-scrollbar-thumb:window-inactive 透明规则', async ({ page }) => {
    const found = await page.evaluate(() => {
      const hits: string[] = []
      for (const sheet of Array.from(document.styleSheets)) {
        let rules: CSSRuleList
        try {
          rules = sheet.cssRules
        } catch {
          continue // 跨域样式表读不到，跳过
        }
        for (const rule of Array.from(rules)) {
          const sel = (rule as CSSStyleRule).selectorText
          if (!sel) continue
          if (/scrollbar-thumb:window-inactive/.test(sel)) {
            const bg = (rule as CSSStyleRule).style?.backgroundColor || ''
            hits.push(`${sel} => ${bg}`)
          }
        }
      }
      return hits
    })
    expect(found.length, '应存在 ::-webkit-scrollbar-thumb:window-inactive 规则').toBeGreaterThan(0)
    // 该规则必须把背景置为透明（隐藏 thumb）
    expect(found.some((h) => /transparent|rgba\([^)]*,\s*0\s*\)/.test(h)), `window-inactive 规则应透明：${JSON.stringify(found)}`).toBe(true)
  })

  // ③ 一致性：会话列表 / 输入框 / 页面滚动宿主 resolve 到同一个 thumb 变量（全部以会话框为准）
  test('③ 全应用滚动条共用同一 thumb 变量（以会话列表为准）', async ({ page }) => {
    const same = await page.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'light')
      const varOf = (el: Element | null) =>
        el ? getComputedStyle(el).getPropertyValue('--hc-scrollbar-thumb').trim() : null
      const sessions = varOf(document.querySelector('.hc-sessions'))
      const composer = varOf(document.querySelector('.hc-composer__field'))
      const root = getComputedStyle(document.documentElement).getPropertyValue('--hc-scrollbar-thumb').trim()
      return { sessions, composer, root }
    })
    // 会话列表存在时必须与 root 一致；输入框存在时同理
    expect(same.root.length).toBeGreaterThan(0)
    if (same.sessions !== null) expect(same.sessions).toBe(same.root)
    if (same.composer !== null) expect(same.composer).toBe(same.root)
  })
})
