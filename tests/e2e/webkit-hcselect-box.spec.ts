import { test, expect } from '@playwright/test'

/**
 * BUG-20260708 B1 · HcSelect 盒型 @ WebKit（Tauri WKWebView 同引擎）真机像素验证。
 *
 * 症状（真机）：SettingsView「默认模型」在无 provider（→ disabled + 空 options）时，HcSelect 触发器
 * 在 macOS WKWebView 里渲染成「更高更圆」的胶囊，与同页正常 HcSelect（Agent 模式）盒型不一致。
 * 此前把原生 disabled 改 aria-disabled 仍变形 → 根因是 WKWebView 对 <button> 的 UA 外观（push-button
 * 高圆胶囊）在 appearance:none 之外仍渗漏；修复加了 box-sizing/min-height/显式 border-radius 显式盒约束。
 *
 * jsdom 无 WebKit 布局照不出，本探针在真实 WebKit 里量 computed 圆角/外观/高度：证明 HcSelect 触发器
 * 是规整令牌圆角矩形（radius=10px、appearance=none、高度有界 32–44px），绝非高圆胶囊；且同页两个
 * HcSelect 圆角一致（不再「更圆」）。activeSection 默认 'llm'，/settings 一加载即在场。
 * 禁用态的「不挂原生 disabled 属性」机制由 jsdom 单测 HcSelect-disabled-deform-20260708 并行锁死。
 */
test.describe('BUG-20260708 B1 · HcSelect 盒型 @ WebKit', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try {
        localStorage.setItem('hexclaw:welcomeRedirectDone', '1')
        sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
      } catch { /* ignore */ }
    })
    await page.goto('/settings', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="llm-default-model-select"] .hc-select__trigger', { timeout: 20_000 })
  })

  test('HcSelect 触发器是规整圆角矩形非胶囊：圆角=令牌值、UA 外观压平、高度有界、同页圆角一致', async ({ page }) => {
    const g = await page.evaluate(() => {
      const measure = (testid: string) => {
        const trig = document.querySelector(`[data-testid="${testid}"] .hc-select__trigger`) as HTMLElement | null
        if (!trig) return null
        const r = trig.getBoundingClientRect()
        const cs = getComputedStyle(trig)
        return {
          h: Math.round(r.height),
          radius: cs.borderTopLeftRadius, // px 值（非 50%/半高胶囊）
          appearance: cs.webkitAppearance || cs.appearance,
        }
      }
      return { def: measure('llm-default-model-select'), agent: measure('llm-agent-mode-select') }
    })

    const dbg = JSON.stringify(g)
    expect(g.def, `默认模型 HcSelect 触发器应存在 · ${dbg}`).not.toBeNull()

    // ① 圆角是令牌矩形圆角（10px），不是被 WKWebView UA 撑成的高圆胶囊
    expect(g.def!.radius, dbg).toBe('10px')
    // ② UA 外观被压平（none），不是 push-button
    expect(g.def!.appearance, dbg).toBe('none')
    // ③ 高度有界（min-height:36px 附近），绝不是变高的胶囊
    expect(g.def!.h, dbg).toBeGreaterThanOrEqual(32)
    expect(g.def!.h, dbg).toBeLessThanOrEqual(44)

    // ④ 同页两个 HcSelect 圆角一致（核心：修复前默认模型 select「更圆」），高度同量级（不再「更高」）
    if (g.agent) {
      expect(g.agent.radius, dbg).toBe('10px')
      expect(g.def!.radius, `同页 HcSelect 圆角应一致 · ${dbg}`).toBe(g.agent.radius)
      expect(Math.abs(g.def!.h - g.agent.h), `同页 HcSelect 高度应同量级 · ${dbg}`).toBeLessThanOrEqual(3)
    }
  })
})
