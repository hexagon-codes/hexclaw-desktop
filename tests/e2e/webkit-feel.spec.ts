import { test, expect } from '@playwright/test'
import katex from 'katex'

/**
 * 真机手感（WebKit）门 —— 每轮 hex-test 必跑。
 *
 * 为什么必须有：其它 e2e 全用 Desktop Chrome(Chromium)，照不出「Chromium 正常但 Tauri WKWebView 翻车」
 * 的引擎特异回归。本套件在 Apple WebKit（WKWebView 同引擎家族）里验证桌面端的交互手感原语：
 *   ① 应用在 WebKit 里能正常 boot（不白屏 / 不 JS 崩）；
 *   ② 滚动导航箭头几何（ChatGPT 风格：输入框上方居中）在 WebKit 渲染正确；
 *   ③ ResizeObserver 在 WebKit 回调（滚动派生标记的兜底重算源）；
 *   ④ scrollIntoView auto + smooth 在真实滚动容器里真的滚动（会话「滚到底/跟随」的底座）。
 *
 * 自包含、无需 sidecar：只用空状态即可渲染的 .hc-chat__messages / .hc-chat__input-area，
 * 几何/滚动探针自行注入元素，不依赖后端会话。前置：`npx playwright install webkit`。
 */

test.describe('真机手感 @ WebKit（Tauri WKWebView 同引擎）', () => {
  test.beforeEach(async ({ page }) => {
    // 跳过首配向导重定向，直达 /chat
    await page.addInitScript(() => {
      try {
        localStorage.setItem('hexclaw:welcomeRedirectDone', '1')
        sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
      } catch { /* ignore */ }
    })
    await page.goto('/chat')
    await page.waitForSelector('.hc-chat__input-area', { timeout: 20_000 })
  })

  test('① 应用在 WebKit 里正常 boot（输入区 + 消息容器渲染，不白屏）', async ({ page }) => {
    await expect(page.locator('.hc-chat__input-area')).toBeVisible()
    await expect(page.locator('.hc-chat__messages')).toHaveCount(1)
    await expect(page.getByTestId('chat-input')).toBeVisible()
  })

  test('② 滚动导航箭头几何：锚定输入框上方、水平居中、不重叠（WebKit 渲染）', async ({ page }) => {
    const g = await page.evaluate(() => {
      const area = document.querySelector('.hc-chat__input-area') as HTMLElement
      const cs = getComputedStyle(area)
      const scopeAttr = area.getAttributeNames().find((n) => n.startsWith('data-v-'))!
      const btn = document.createElement('button')
      btn.className = 'hc-chat__scroll-btn hc-chat__scroll-btn--bottom'
      btn.setAttribute(scopeAttr, '')
      area.appendChild(btn)
      const ar = area.getBoundingClientRect(), br = btn.getBoundingClientRect()
      const bcs = getComputedStyle(btn)
      const r = {
        areaPosition: cs.position,
        areaOverflow: cs.overflow,
        btnPosition: bcs.position,
        w: Math.round(br.width), h: Math.round(br.height),
        radius: bcs.borderRadius,
        horizCenteredDelta: Math.round((br.left + br.width / 2) - (ar.left + ar.width / 2)),
        gapAboveInput: Math.round(ar.top - br.bottom),
        aboveNotOverlap: br.bottom < ar.top,
      }
      btn.remove()
      return r
    })
    expect(g.areaPosition).toBe('relative')           // 锚点
    expect(g.areaOverflow).toBe('visible')            // 不裁剪上方溢出的按钮
    expect(g.btnPosition).toBe('absolute')
    expect(g.w).toBe(32); expect(g.h).toBe(32)
    expect(g.radius).toBe('50%')
    expect(Math.abs(g.horizCenteredDelta)).toBeLessThanOrEqual(1) // 水平居中
    expect(Math.abs(g.gapAboveInput - 12)).toBeLessThanOrEqual(3) // 输入框上方 ~12px
    expect(g.aboveNotOverlap).toBe(true)
  })

  test('③ ResizeObserver 在 WebKit 回调（observe + 内容重排各一次）', async ({ page }) => {
    const ro = await page.evaluate(async () => {
      if (typeof ResizeObserver === 'undefined') return { supported: false, firedOnObserve: false, firedOnResize: false }
      const el = document.createElement('div')
      el.style.cssText = 'position:fixed;top:0;left:0;width:50px;height:50px'
      document.body.appendChild(el)
      let fired = 0
      const obs = new ResizeObserver(() => { fired++ })
      obs.observe(el)
      await new Promise((r) => setTimeout(r, 80))
      const initial = fired
      el.style.height = '300px'
      await new Promise((r) => setTimeout(r, 120))
      const after = fired
      obs.disconnect(); el.remove()
      return { supported: true, firedOnObserve: initial >= 1, firedOnResize: after > initial }
    })
    expect(ro.supported).toBe(true)
    expect(ro.firedOnObserve).toBe(true)
    expect(ro.firedOnResize).toBe(true)
  })

  test('④ scrollIntoView auto + smooth 在真实滚动容器里真的滚动（WebKit）', async ({ page }) => {
    const s = await page.evaluate(async () => {
      const msgs = document.querySelector('.hc-chat__messages') as HTMLElement
      const spacer = document.createElement('div'); spacer.style.height = '3000px'; spacer.dataset.probe = '1'
      const sentinel = document.createElement('div'); sentinel.style.height = '1px'; sentinel.dataset.probe = '1'
      msgs.appendChild(spacer); msgs.appendChild(sentinel)
      msgs.scrollTop = 0
      const scrollable = msgs.scrollHeight > msgs.clientHeight
      // auto（瞬时）
      sentinel.scrollIntoView({ behavior: 'auto', block: 'end' })
      const autoTop = msgs.scrollTop
      // smooth（动画），轮询取峰值
      msgs.scrollTop = 0
      sentinel.scrollIntoView({ behavior: 'smooth', block: 'end' })
      let smoothMax = 0
      for (let i = 0; i < 24; i++) { await new Promise((r) => setTimeout(r, 50)); smoothMax = Math.max(smoothMax, msgs.scrollTop) }
      msgs.querySelectorAll('[data-probe]').forEach((n) => n.remove())
      return { scrollable, autoTop, smoothMax }
    })
    expect(s.scrollable).toBe(true)
    expect(s.autoTop).toBeGreaterThan(0)   // scrollIntoView auto 真滚了
    expect(s.smoothMax).toBeGreaterThan(0) // scrollIntoView smooth 真滚了
  })

  test('⑤ KaTeX 分数在 WebKit 中保持分子/分母堆叠与分数线，不塌散', async ({ page }) => {
    const fractionHtml = katex.renderToString(String.raw`\frac{3}{4}`, {
      displayMode: false,
      throwOnError: false,
    })
    const layout = await page.evaluate(async (renderedFraction) => {
      const host = document.createElement('div')
      host.dataset.probe = 'katex-fraction'
      host.style.cssText = 'position:fixed;left:40px;top:40px;font-size:28px'
      host.innerHTML = renderedFraction
      document.body.appendChild(host)
      const frac = host.querySelector('.mfrac') as HTMLElement
      const line = host.querySelector('.frac-line') as HTMLElement
      const vlistTable = host.querySelector('.vlist-t') as HTMLElement
      const numbers = Array.from(host.querySelectorAll<HTMLElement>('.katex-html .mfrac .mord')).filter(
        (el) => el.childElementCount === 0 && /^[34]$/.test(el.textContent ?? ''),
      )
      const boxes = numbers.map((el) => el.getBoundingClientRect())
      const result = {
        host: host.getBoundingClientRect().toJSON(),
        frac: frac?.getBoundingClientRect().toJSON(),
        lineWidth: line ? parseFloat(getComputedStyle(line).borderBottomWidth) : 0,
        tableDisplay: vlistTable ? getComputedStyle(vlistTable).display : '',
        numberTops: boxes.map((box) => box.top),
        numberCenters: boxes.map((box) => box.left + box.width / 2),
      }
      host.remove()
      return result
    }, fractionHtml)

    expect(layout.lineWidth).toBeGreaterThan(0)
    expect(layout.tableDisplay).toBe('inline-table')
    expect(layout.frac.height).toBeGreaterThan(20)
    expect(layout.numberTops).toHaveLength(2)
    expect(Math.abs(layout.numberTops[0]! - layout.numberTops[1]!)).toBeGreaterThan(8)
    expect(Math.abs(layout.numberCenters[0]! - layout.numberCenters[1]!)).toBeLessThan(4)
  })

  /**
   * ⑨ composer 盒内首行 chips 几何 + 药丸样式（对齐原型 .composer-chips/.composer-chip；防再漂移）
   *
   * 背景：K12 辅导会话 composer 首行渲染场景预设 chips（📚自动识别学科/💡渐进提示/📷识题校验），
   * 曾漂成 bg-active(2× 蓝) + 14px 圆角矩形 + 主文字色 + 1px 边、且 chips 行 padding-bottom:8px
   * + margin-bottom:6px 叠出 14px 空档（原型仅 margin-bottom:8px）。此处在真实 WebKit 里量几何取证：
   *   ① chip 左缘 == placeholder 左缘 == 盒 padding-left（同一垂直基线，不贴边不错位）；
   *   ② chip 为全圆角药丸（border-radius >= 半高），非圆角矩形；
   *   ③ chips 行与输入行间距 ~8px（对齐原型，非旧 14px）。
   * chips 只在场景会话出现，空态 /chat 无——故用原型同构的 scoped 元素注入真实盒内量真值
   *（与本套件 ② 滚动箭头同法：借盒的 data-v- scope 让 scoped CSS 生效）。
   */
  test('⑨ composer chips 首行：左缘对齐 placeholder + 药丸样式 + 与输入行 ~8px（WebKit）', async ({ page }) => {
    await page.waitForSelector('.hc-composer__box', { timeout: 20_000 })
    const g = await page.evaluate(() => {
      const box = document.querySelector('.hc-composer__box') as HTMLElement
      const scopeAttr = box.getAttributeNames().find((n) => n.startsWith('data-v-'))!
      const boxCS = getComputedStyle(box)
      const editor = box.querySelector<HTMLElement>('[data-testid="chat-input"]')!
      const editorCS = getComputedStyle(editor)

      const chips = document.createElement('div')
      chips.className = 'hc-composer__skills'
      chips.setAttribute(scopeAttr, '')
      const chip = document.createElement('span')
      chip.className = 'hc-composer__skill-chip'
      chip.setAttribute(scopeAttr, '')
      const name = document.createElement('span')
      name.className = 'hc-composer__skill-name'
      name.setAttribute(scopeAttr, '')
      name.textContent = '📚 自动识别学科'
      chip.appendChild(name)
      chips.appendChild(chip)
      // 关掉入场动效（fadeScaleIn 起始 translateY(8px)/scale）——否则量到动画中间帧偏移，非稳态几何
      chip.style.animation = 'none'
      box.insertBefore(chips, box.firstChild)

      const boxRect = box.getBoundingClientRect()
      const editorRect = editor.getBoundingClientRect()
      const chipRect = chip.getBoundingClientRect()
      const chipCS = getComputedStyle(chip)
      // 盒左内边距（content-left 相对盒左缘）
      const boxPadLeft = parseFloat(boxCS.borderLeftWidth) + parseFloat(boxCS.paddingLeft)
      // placeholder/文本 content-left（canonical editor 自身 padding:0，故 == 盒 padding-left）
      const editorContentLeft = (editorRect.left - boxRect.left)
        + parseFloat(editorCS.borderLeftWidth)
        + parseFloat(editorCS.paddingLeft)
      const chipLeft = chipRect.left - boxRect.left
      const r = {
        placeholderVsBoxPad: Math.round(editorContentLeft - boxPadLeft),
        chipVsPlaceholder: Math.round(chipLeft - editorContentLeft),
        chipRadius: parseFloat(chipCS.borderTopLeftRadius),
        chipHalfHeight: chipRect.height / 2,
        gapChipsToInput: Math.round(editorRect.top - chipRect.bottom),
      }
      chips.remove()
      return r
    })
    // ① placeholder 左缘 == 盒左内边距（不贴边不裁切；req: placeholder 左边界 == 输入区左内边距）
    expect(Math.abs(g.placeholderVsBoxPad)).toBeLessThanOrEqual(1)
    // ② chip 左缘与 placeholder 左缘同基线（有 chips 时左对齐一致）
    expect(Math.abs(g.chipVsPlaceholder)).toBeLessThanOrEqual(2)
    // ③ chip 为全圆角药丸（原型 999px；WebKit 计算值不裁剪返回 999px），非旧 14px 圆角矩形漂移。
    //    既断言远大于半高（药丸语义），又用 >=100 明确拒绝 14px 漂移值。
    expect(g.chipRadius).toBeGreaterThanOrEqual(100)
    expect(g.chipRadius).toBeGreaterThan(g.chipHalfHeight)
    // ④ chips 行与输入行间距对齐原型 ~8px（旧漂移为 14px），给 ±3px 容差
    expect(Math.abs(g.gapChipsToInput - 8)).toBeLessThanOrEqual(3)
  })
})

/**
 * 设置页滚动条落点 @ WebKit（bug-20260626 回归）
 * 旧实现把 overflow-y:auto 挂在 max-width:600px 的内层 section 上 → 滚动条贴着「窄列」右缘，
 * 在 1280 宽窗口里悬浮于中部，与顶栏右缘脱节。修复后滚动归全宽内容面板 .hc-settings__content，
 * 滚动条回到面板右缘（macOS/桌面端原生预期落点）。此处在真实 WebKit 里量几何取证。
 */
test.describe('真机手感 @ WebKit — 设置页滚动条落点（bug-20260626）', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try {
        localStorage.setItem('hexclaw:welcomeRedirectDone', '1')
        sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
      } catch { /* ignore */ }
    })
    await page.goto('/settings')
    await page.waitForSelector('.hc-settings__content', { timeout: 20_000 })
  })

  test('⑤ 滚动宿主是全宽内容面板（非 max-width 窄列）→ 滚动条贴面板右缘不悬浮中部', async ({ page }) => {
    const g = await page.evaluate(() => {
      const content = document.querySelector('.hc-settings__content') as HTMLElement
      const cs = getComputedStyle(content)
      // 强制溢出，使滚动占位/可滚动性显形（不依赖后端是否返回配置）
      const spacer = document.createElement('div')
      spacer.style.height = '4000px'
      spacer.dataset.probe = '1'
      content.appendChild(spacer)
      const r = {
        overflowY: cs.overflowY,
        overflowX: cs.overflowX,
        scrollable: content.scrollHeight > content.clientHeight,
        // 滚动视口的可视内宽：全宽面板应远宽于内层 600px 易读窄列
        innerWidth: Math.round(content.clientWidth),
      }
      content.querySelectorAll('[data-probe]').forEach((n) => n.remove())
      return r
    })
    expect(g.overflowY === 'auto' || g.overflowY === 'scroll').toBe(true) // 面板是滚动宿主（旧实现此处为 hidden）
    expect(g.overflowX).toBe('hidden')                                    // 不出横向滚动条
    expect(g.scrollable).toBe(true)                                       // 纵向真能滚
    expect(g.innerWidth).toBeGreaterThan(640)                             // 滚动视口 = 全宽面板，宽于 600px 窄列
  })
})

/**
 * 全路由「悬浮滚动条」巡检 @ WebKit（bug-20260626 横向扩散防回归 / AP-099）
 * 走遍全部主路由，在真实 WebKit 里逐元素扫描：凡「自身被 max-width/固定宽约束、且右侧留有可观空隙、
 * 且该空隙没有任何兄弟元素填充」的滚动容器，即判为悬浮滚动条（与 SettingsView 旧 bug 同构）。
 * master-detail 侧栏（如 ModelManagerModal 的 .mm-vendors：右侧紧邻 detail 兄弟/带分隔线）不算——
 * 检测器据「右侧是否有兄弟填充」自动豁免，不靠白名单硬编码。
 */
test.describe('全路由悬浮滚动条巡检 @ WebKit（bug-20260626 防扩散）', () => {
  const ROUTES = [
    '/chat', '/agents', '/knowledge', '/knowledge/memory',
    '/automation', '/automation/webhooks', '/automation/workflows',
    '/channels', '/integration', '/integration/mcp', '/integration/prompts',
    '/logs', '/settings',
  ]

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try {
        localStorage.setItem('hexclaw:welcomeRedirectDone', '1')
        sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
      } catch { /* ignore */ }
    })
  })

  test('⑥ 无任何路由存在「悬浮在面板中部」的滚动条', async ({ page }) => {
    const allFlagged: Array<{ route: string; cls: string; gapRight: number; maxW: string; w: number }> = []
    for (const route of ROUTES) {
      await page.goto(route, { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(700) // 等 Vue 挂载 + 导航守卫(config 加载失败也放行)落定
      const flagged = await page.evaluate(() => {
        const out: Array<{ cls: string; gapRight: number; maxW: string; w: number }> = []
        document.querySelectorAll<HTMLElement>('*').forEach((el) => {
          const cs = getComputedStyle(el)
          const ovf = `${cs.overflow} ${cs.overflowY}`
          if (!/(auto|scroll)/.test(ovf)) return
          const tag = el.tagName.toLowerCase()
          if (tag === 'textarea' || tag === 'input' || tag === 'select' || tag === 'pre') return // 文本/原生控件自有滚动
          const r = el.getBoundingClientRect()
          if (r.width < 80 || r.height < 80) return
          // 自身被宽度约束（max-width 非 none，或固定 px 宽）
          const constrained = cs.maxWidth !== 'none' || /\dpx$/.test(cs.width)
          if (!constrained) return
          const parent = el.parentElement
          if (!parent) return
          const pr = parent.getBoundingClientRect()
          const gapRight = pr.right - r.right // 滚动元素右缘 → 父右缘的空隙
          if (gapRight <= 48) return // 紧贴父右缘 = 不悬浮
          if (pr.width - r.width <= 48) return // 父并不比它明显宽
          // 右侧空隙若被任一兄弟占据（master-detail / 行布局）→ 不算悬浮
          const sibFillsRight = Array.from(parent.children).some((c) => {
            if (c === el) return false
            const cr = c.getBoundingClientRect()
            return cr.right > r.right + 8 && cr.left < pr.right && cr.height > 8
          })
          if (sibFillsRight) return
          out.push({
            cls: typeof el.className === 'string' ? el.className.slice(0, 60) : '(svg/other)',
            gapRight: Math.round(gapRight),
            maxW: cs.maxWidth,
            w: Math.round(r.width),
          })
        })
        return out
      })
      flagged.forEach((f) => allFlagged.push({ route, ...f }))
    }
    expect(allFlagged, `悬浮滚动条候选:\n${JSON.stringify(allFlagged, null, 2)}`).toEqual([])
  })

  // ⑦ 不变量 × 兼容性矩阵（高级矩阵方法 1+9）：设置页内容面板「永远是全宽滚动宿主」
  // 这一性质必须对 ∀ 视口宽（含窄窗）× 书写方向(LTR/RTL) 恒成立——不随窗口尺寸退化为窄列滚动。
  test('⑦ 设置页滚动宿主不变量 @ 视口矩阵 × LTR/RTL（WebKit）', async ({ page }) => {
    const widths = [880, 1024, 1280, 1440, 1920]
    const results: Array<{ w: number; dir: string; overflowY: string; innerW: number; panelFill: number }> = []
    for (const dir of ['ltr', 'rtl']) {
      for (const w of widths) {
        await page.setViewportSize({ width: w, height: 800 })
        await page.goto('/settings', { waitUntil: 'domcontentloaded' })
        await page.evaluate((d) => { document.documentElement.dir = d }, dir)
        await page.waitForSelector('.hc-settings__content', { timeout: 15_000 })
        await page.waitForTimeout(120)
        const m = await page.evaluate(() => {
          const content = document.querySelector('.hc-settings__content') as HTMLElement
          const cs = getComputedStyle(content)
          const parent = content.parentElement!
          const cr = content.getBoundingClientRect()
          const pr = parent.getBoundingClientRect()
          return {
            overflowY: cs.overflowY,
            innerW: Math.round(content.clientWidth),
            // 面板宽 / 其父(body)宽 —— 内容面板应几乎铺满父，不退化为窄列
            panelFill: Math.round((cr.width / pr.width) * 100),
          }
        })
        results.push({ w, dir, ...m })
      }
    }
    // 还原默认视口，避免污染后续 test
    await page.setViewportSize({ width: 1280, height: 720 })
    for (const r of results) {
      expect(r.overflowY === 'auto' || r.overflowY === 'scroll', `${r.dir}@${r.w} overflowY`).toBe(true)
      expect(r.panelFill, `${r.dir}@${r.w} 面板铺满父%`).toBeGreaterThan(80) // 内容面板≈铺满，绝非 600px 窄列
    }
  })
})

/**
 * 启动页 splash logo @ WebKit（BUG-20260703 B6 回归）
 * 装机版曾出现空白 splash：logo 用运行时路径 `/logo.png`（全 App 唯一不走打包 import 的图），
 * Tauri asset 协议 + 生产 CSP + splash 提前 dismiss 叠加导致这次异步 fetch 失败/来不及绘制。
 * 修复后 logo 内联 data-URI（boot 前即在 DOM，零 fetch 依赖）。此处在真实 WebKit 里解码取证——
 * 从服务端拿 index.html 原文断言内联契约，不受 splash 已被 dismiss 的时序影响。
 */
test.describe('真机手感 @ WebKit — 启动页 splash logo（BUG-20260703 B6）', () => {
  test('⑧ splash logo 内联 data-URI 且在 WebKit 真解码（装机零运行时 fetch 依赖）', async ({ page }) => {
    const resp = await page.goto('/')
    const html = await resp!.text()
    const m = html.match(/id="splash-screen"[\s\S]*?<img\s+[^>]*src="(data:image\/png;base64,[^"]+)"/)
    expect(m, 'splash logo 必须内联 data-URI').toBeTruthy()
    const decoded = await page.evaluate(async (src) => {
      const img = new Image()
      img.src = src
      try {
        await img.decode()
      } catch {
        return { ok: false, w: 0, h: 0 }
      }
      return { ok: true, w: img.naturalWidth, h: img.naturalHeight }
    }, m![1])
    expect(decoded.ok, 'splash logo data-URI 在 WebKit 解码失败').toBe(true)
    expect(decoded.w).toBeGreaterThan(0)
    expect(decoded.h).toBeGreaterThan(0)
  })
})
