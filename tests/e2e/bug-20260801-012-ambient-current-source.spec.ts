import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
  type Route,
} from '@playwright/test'
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const evidenceRoot = path.resolve(
  desktopRoot,
  '../hexclaw-docs/test/evidence/bug-20260801-012-ambient-current-source',
)
const pixelDiffTool = path.resolve(desktopRoot, 'tests/e2e/tools/visual_pixel_diff.py')
const sourceURL = process.env.HEX_K12_AMBIENT_SOURCE_URL!
const referenceURL = process.env.HEX_K12_AMBIENT_REFERENCE_URL!
const viewport = { width: 2048, height: 924 }
const fixedNowMs = Date.parse('2026-07-29T12:49:13+08:00')
const k12Appearance = JSON.stringify({ version: 1, preference: 'k12', introSeen: true })

type Theme = 'light' | 'dark'
type Implementation = 'reference' | 'current'

const expectedLogs = [
  ['12:48:02', 'INFO', 'sidecar', 'engine started · listening on :16060'],
  ['12:48:02', 'DEBUG', 'channels', 'loaded 6 platform adapters, 0 instances enabled'],
  ['12:48:05', 'INFO', 'llm', 'local model (Ollama) connected · qwen3.5:9b ready'],
  ['12:49:13', 'WARN', 'knowledge', 'embedding 未配置，知识库使用基础检索'],
]

const logs = [
  {
    id: 'log-1',
    timestamp: '2026-07-29T12:48:02+08:00',
    level: 'info',
    source: 'sidecar',
    message: 'engine started · listening on :16060',
    trace_id: 'engine-start',
    domain: 'engine',
  },
  {
    id: 'log-2',
    timestamp: '2026-07-29T12:48:02+08:00',
    level: 'debug',
    source: 'channels',
    message: 'loaded 6 platform adapters, 0 instances enabled',
    trace_id: 'channels-load',
    domain: 'integration',
  },
  {
    id: 'log-3',
    timestamp: '2026-07-29T12:48:05+08:00',
    level: 'info',
    source: 'llm',
    message: 'local model (Ollama) connected · qwen3.5:9b ready',
    trace_id: 'llm-ready',
    domain: 'chat',
  },
  {
    id: 'log-4',
    timestamp: '2026-07-29T12:49:13+08:00',
    level: 'warn',
    source: 'knowledge',
    message: 'embedding 未配置，知识库使用基础检索',
    trace_id: 'kb-fallback',
    domain: 'knowledge',
  },
]

const expectedRightAnchors = [
  ['78%', '13%'],
  ['84%', '23%'],
  ['91%', '11%'],
  ['96%', '19%'],
  ['80%', '43%'],
  ['90%', '34%'],
  ['96%', '51%'],
  ['78%', '65%'],
  ['87%', '74%'],
  ['96%', '84%'],
  ['76%', '31%'],
  ['83%', '54%'],
  ['93%', '66%'],
  ['82%', '88%'],
]
const expectedSidebarAnchors = [
  ['1.5%', '68%'],
  ['9.5%', '70%'],
  ['2.6%', '83%'],
  ['10%', '85%'],
]

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

async function installSourceFixture(page: Page, theme: Theme, externalRequests: string[]) {
  await page.addInitScript(
    ({ appearance, nextTheme, now }) => {
      localStorage.clear()
      sessionStorage.clear()
      Date.now = () => now
      localStorage.setItem('hc-theme', nextTheme)
      localStorage.setItem('hc-k12-appearance-v1', appearance)
      localStorage.setItem('hexclaw:welcomeRedirectDone', '1')
      sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
      localStorage.setItem('hexclaw_lastSessionId', 'session-k12')
      localStorage.setItem('hexclaw_sessionAgents', JSON.stringify({ 'session-k12': 'mingming' }))

      class FixtureWebSocket extends EventTarget {
        static readonly CONNECTING = 0
        static readonly OPEN = 1
        static readonly CLOSING = 2
        static readonly CLOSED = 3
        readonly CONNECTING = 0
        readonly OPEN = 1
        readonly CLOSING = 2
        readonly CLOSED = 3
        binaryType: BinaryType = 'blob'
        bufferedAmount = 0
        extensions = ''
        protocol = ''
        readyState = FixtureWebSocket.CONNECTING
        url: string
        onclose: ((this: WebSocket, ev: CloseEvent) => unknown) | null = null
        onerror: ((this: WebSocket, ev: Event) => unknown) | null = null
        onmessage: ((this: WebSocket, ev: MessageEvent) => unknown) | null = null
        onopen: ((this: WebSocket, ev: Event) => unknown) | null = null
        constructor(url: string | URL) {
          super()
          this.url = String(url)
          queueMicrotask(() => {
            this.readyState = FixtureWebSocket.OPEN
            const event = new Event('open')
            this.onopen?.call(this as unknown as WebSocket, event)
            this.dispatchEvent(event)
          })
        }
        close() {
          this.readyState = FixtureWebSocket.CLOSED
          const event = new CloseEvent('close')
          this.onclose?.call(this as unknown as WebSocket, event)
          this.dispatchEvent(event)
        }
        send() {}
      }
      window.WebSocket = FixtureWebSocket as unknown as typeof WebSocket
    },
    { appearance: k12Appearance, nextTheme: theme, now: fixedNowMs },
  )

  page.on('request', (request) => {
    const url = new URL(request.url())
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) externalRequests.push(request.url())
  })
  await page.route('http://localhost:11434/**', (route) =>
    json(route, { running: false, associated: false, models: [] }),
  )
  await page.route('**/_hexclaw/**', (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const apiPath = url.pathname.replace(/^\/_hexclaw/, '')

    if (apiPath === '/health') return json(route, { status: 'ok' })
    // Desktop 的后端合同是 newest-first；store 会反转后按时间正序展示。
    if (apiPath === '/api/v1/logs')
      return json(route, { logs: [...logs].reverse(), total: logs.length })
    if (apiPath === '/api/v1/logs/stats') {
      return json(route, {
        total: logs.length,
        by_level: { debug: 1, info: 2, warn: 1, error: 0 },
        by_source: { sidecar: 1, channels: 1, llm: 1, knowledge: 1 },
        requests_per_minute: 0,
      })
    }
    if (apiPath === '/api/v1/config') {
      return json(route, {
        server: { host: '127.0.0.1', port: 16060, mode: 'desktop' },
        llm: { default: '', providers: {} },
        knowledge: { enabled: true },
        mcp: { enabled: true },
        cron: { enabled: true },
        webhook: { enabled: true },
        canvas: { enabled: true },
        voice: { enabled: true },
        sandbox: { network_enabled: true, allowed_paths: [] },
        security: {
          gateway_enabled: true,
          injection_detection: true,
          pii_filter: false,
          content_filter: true,
          rate_limit_rpm: 60,
        },
      })
    }
    if (apiPath === '/api/v1/config/llm') {
      return json(route, {
        default: '',
        providers: {},
        routing: { enabled: false, strategy: 'cost-aware' },
        cache: { enabled: false },
      })
    }
    if (apiPath === '/api/v1/ollama/status') {
      return json(route, { running: false, associated: false, models: [] })
    }
    if (apiPath === '/api/v1/agents') {
      return json(route, {
        agents: [
          {
            name: 'mingming',
            display_name: '小明的辅导助手',
            description: '五年级辅导',
            provider: '',
            model: '',
            metadata: {
              scenario: 'k12-tutor',
              avatar: '🎓',
              'k12.child_name': '小明',
              'k12.grade_term': '五年级下',
              'k12.textbook_edition': '人教版',
            },
          },
        ],
        total: 1,
        default: 'mingming',
      })
    }
    if (apiPath === '/api/v1/sessions') {
      return json(route, {
        sessions: [
          {
            id: 'session-k12',
            title: '小明的辅导助手 · 五年级',
            created_at: '2026-07-29T12:00:00+08:00',
            updated_at: '2026-07-29T12:48:00+08:00',
            message_count: 0,
          },
        ],
        total: 1,
      })
    }
    if (apiPath === '/api/v1/sessions/session-k12/messages') {
      return json(route, { messages: [], total: 0 })
    }
    if (apiPath === '/api/v1/streams/active') return json(route, { streams: [], total: 0 })
    if (apiPath === '/api/k12/view-descriptor') {
      return json(route, {
        header_tabs: ['辅导', '学习档案', '学情'],
        message_badges: [],
        composer_placeholder: '',
        composer_chips: [],
        record_collections: [],
        side_panels: [],
        actions: [],
        i18n_keys: [],
        schema_version: 1,
      })
    }
    if (apiPath.startsWith('/api/k12/')) return json(route, { items: [] })
    if (apiPath.startsWith('/api/v1/')) return json(route, { items: [], total: 0 })
    return json(route, {})
  })
}

async function installReferenceFixture(page: Page, theme: Theme, externalRequests: string[]) {
  await page.addInitScript(
    ({ appearance }) => {
      localStorage.setItem('hexclaw.prototype.k12Appearance.v1', appearance)
    },
    { appearance: JSON.stringify({ preference: 'k12', introSeen: true }) },
  )
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) externalRequests.push(request.url())
  })
  await page.goto(referenceURL)
  await page.evaluate((nextTheme) => {
    const api = window as typeof window & {
      applyThemeState?: (theme: Theme, announce: boolean) => void
    }
    api.applyThemeState?.(nextTheme, false)
  }, theme)
  const logsNav = page.locator('.sb-item[data-screen="logs"]')
  await expect(logsNav).toBeVisible()
  await logsNav.click()
  await expect(page.locator('.screen[data-pane="logs"]')).toHaveClass(/\bon\b/)
  await expect(page.locator('body')).toHaveAttribute('data-k12-skin-active', 'k12')
}

async function openSource(page: Page, theme: Theme) {
  await page.goto(`${sourceURL}/logs`)
  await expect(page.locator('.hc-logs-page')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('#splash-screen')).toHaveCount(0, { timeout: 30_000 })
  await expect(page.locator('.hc-logs__row')).toHaveCount(4)
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
  await expect(page.locator('body')).toHaveAttribute('data-k12-skin-active', 'k12')
}

async function waitForRenderedAssets(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready
    const urls = new Set<string>()
    const collect = (style: CSSStyleDeclaration) => {
      for (const match of style.backgroundImage.matchAll(/url\(["']?(.*?)["']?\)/g)) {
        if (match[1]) urls.add(match[1])
      }
    }
    for (const node of document.querySelectorAll<HTMLElement>('*')) {
      collect(getComputedStyle(node))
      collect(getComputedStyle(node, '::before'))
      collect(getComputedStyle(node, '::after'))
    }
    await Promise.all([...urls].map((url) => fetch(url).then((response) => response.arrayBuffer())))
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    )
  })
}

async function collectSemantic(page: Page, implementation: Implementation) {
  return page.evaluate((kind) => {
    const text = (selector: string, root: ParentNode) =>
      root.querySelector<HTMLElement>(selector)?.innerText.replace(/\s+/g, ' ').trim() ?? ''
    const rowSelector = kind === 'current' ? '.hc-logs__row' : '.logrow'
    const selectors =
      kind === 'current'
        ? ['.hc-logs__row-time', '.hc-logs__row-level', '.hc-logs__row-source', '.hc-logs__row-msg']
        : ['.t', '.lv', '.src', '.msg']
    const rows = [...document.querySelectorAll<HTMLElement>(rowSelector)].map((row) => [
      text(selectors[0]!, row).replace(/\.000$/, ''),
      text(selectors[1]!, row).toUpperCase(),
      text(selectors[2]!, row),
      text(selectors[3]!, row),
    ])
    return {
      viewport: {
        width: innerWidth,
        height: innerHeight,
        devicePixelRatio,
        locale: navigator.language,
      },
      theme: document.documentElement.dataset.theme,
      skin: document.body.dataset.k12SkinActive,
      route: kind === 'current' ? location.pathname : 'logs',
      rows,
    }
  }, implementation)
}

async function collectAmbientFacts(page: Page, implementation: Implementation) {
  return page.evaluate(async (kind) => {
    const selectors =
      kind === 'current'
        ? {
            root: '[data-testid="k12-global-presentation"]',
            sidebar: '.k12-global-presentation__sidebar-scene',
            butterflies: '.k12-global-presentation__butterflies',
            fireflies: '.k12-global-presentation__fireflies',
          }
        : {
            root: 'body',
            sidebar: '.k12-sidebar-art',
            butterflies: '.k12-sidebar-ambient',
            fireflies: '.k12-global-ambient',
          }

    const round = (value: number) => Math.round(value * 1000) / 1000
    const rect = (node: Element) => {
      const value = node.getBoundingClientRect()
      return {
        x: round(value.x),
        y: round(value.y),
        width: round(value.width),
        height: round(value.height),
        right: round(value.right),
        bottom: round(value.bottom),
      }
    }
    const styleFacts = (selector: string) => {
      const node = document.querySelector<HTMLElement>(selector)
      if (!node) return null
      const style = getComputedStyle(node)
      return {
        selector,
        rect: rect(node),
        position: style.position,
        display: style.display,
        visibility: style.visibility,
        opacity: style.opacity,
        zIndex: style.zIndex,
        pointerEvents: style.pointerEvents,
        top: style.top,
        right: style.right,
        bottom: style.bottom,
        left: style.left,
        width: style.width,
        height: style.height,
        backgroundColor: style.backgroundColor,
        backgroundImage: style.backgroundImage,
        backgroundPosition: style.backgroundPosition,
        backgroundSize: style.backgroundSize,
        maskImage: style.maskImage || style.getPropertyValue('-webkit-mask-image'),
        overflow: style.overflow,
      }
    }
    const nodeFacts = (selector: string) =>
      [...document.querySelectorAll<HTMLElement>(selector)].map((node, index) => {
        const style = getComputedStyle(node)
        let translation = { x: 0, y: 0, magnitude: 0 }
        if (style.transform !== 'none') {
          const matrix = new DOMMatrixReadOnly(style.transform)
          translation = {
            x: round(matrix.m41),
            y: round(matrix.m42),
            magnitude: round(Math.hypot(matrix.m41, matrix.m42)),
          }
        }
        return {
          index,
          className: node.className,
          rect: rect(node),
          anchor: {
            cssLeft: style.left,
            cssTop: style.top,
            x: style.getPropertyValue('--x').trim(),
            y: style.getPropertyValue('--y').trim(),
          },
          size: { width: style.width, height: style.height },
          display: style.display,
          visibility: style.visibility,
          opacity: style.opacity,
          pointerEvents: style.pointerEvents,
          animationName: style.animationName,
          animationDuration: style.animationDuration,
          animationDelay: style.animationDelay,
          transform: style.transform,
          translation,
          backgroundImage: style.backgroundImage,
          backgroundPosition: style.backgroundPosition,
          mixBlendMode: style.mixBlendMode,
          maskImage: style.maskImage || style.getPropertyValue('-webkit-mask-image'),
          borderRadius: style.borderRadius,
          boxShadow: style.boxShadow,
          ariaExcluded: Boolean(node.closest('[aria-hidden="true"]')),
          sidebar: node.classList.contains('k12-ambient-firefly--sidebar'),
        }
      })

    const sidebar = document.querySelector<HTMLElement>(selectors.sidebar)
    let assetSha256: string | null = null
    if (sidebar) {
      const background = getComputedStyle(sidebar).backgroundImage
      const url = background.match(/url\(["']?(.*?)["']?\)/)?.[1]
      if (url) {
        const bytes = await (await fetch(url)).arrayBuffer()
        const digest = await crypto.subtle.digest('SHA-256', bytes)
        assetSha256 = [...new Uint8Array(digest)]
          .map((byte) => byte.toString(16).padStart(2, '0'))
          .join('')
      }
    }

    const butterflies = nodeFacts('.k12-ambient-butterfly')
    const fireflies = nodeFacts('.k12-ambient-firefly')
    const legacyScene = document.querySelector<HTMLElement>('.k12-scene-layer')
    const legacySceneFacts = legacyScene
      ? (() => {
          const before = getComputedStyle(legacyScene, '::before')
          const after = getComputedStyle(legacyScene, '::after')
          return {
            rect: rect(legacyScene),
            before: { opacity: before.opacity, backgroundImage: before.backgroundImage },
            after: { opacity: after.opacity, backgroundImage: after.backgroundImage },
            active: Number(before.opacity) > 0 || Number(after.opacity) > 0,
          }
        })()
      : null
    return {
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      selectors,
      root: styleFacts(selectors.root),
      sidebar: styleFacts(selectors.sidebar),
      butterflyLayer: styleFacts(selectors.butterflies),
      fireflyLayer: styleFacts(selectors.fireflies),
      butterflies,
      fireflies,
      counts: {
        butterflies: butterflies.length,
        fireflies: fireflies.length,
        rightFireflies: fireflies.filter((node) => !node.sidebar).length,
        sidebarFireflies: fireflies.filter((node) => node.sidebar).length,
        visibleButterflies: butterflies.filter(
          (node) =>
            node.display !== 'none' && node.visibility !== 'hidden' && Number(node.opacity) > 0,
        ).length,
        visibleFireflies: fireflies.filter(
          (node) =>
            node.display !== 'none' && node.visibility !== 'hidden' && Number(node.opacity) > 0,
        ).length,
      },
      assetSha256,
      legacyFullViewportScene: legacySceneFacts,
      extraAmbientNodes: document.querySelectorAll(
        '[data-k12-ambient-layer] .k12-ambient-butterfly:not(.k12-ambient-butterfly--one):not(.k12-ambient-butterfly--two)',
      ).length,
    }
  }, implementation)
}

function sameRect(
  left: { x: number; y: number; width: number; height: number },
  right: typeof left,
) {
  return (
    Math.abs(left.x - right.x) <= 0.01 &&
    Math.abs(left.y - right.y) <= 0.01 &&
    Math.abs(left.width - right.width) <= 0.01 &&
    Math.abs(left.height - right.height) <= 0.01
  )
}

function anchorPairs(nodes: Awaited<ReturnType<typeof collectAmbientFacts>>['fireflies']) {
  return nodes.map((node) => [node.anchor.x, node.anchor.y])
}

function baseAnimationName(value: string) {
  for (const name of ['k12ButterflyDriftOne', 'k12ButterflyDriftTwo', 'k12FireflyDrift']) {
    if (value.startsWith(name)) return name
  }
  return value
}

function exactSet(theme: Theme, facts: Awaited<ReturnType<typeof collectAmbientFacts>>) {
  const right = facts.fireflies.filter((node) => !node.sidebar)
  const sidebar = facts.fireflies.filter((node) => node.sidebar)
  const checks = [
    {
      name: 'two butterfly nodes',
      pass: facts.counts.butterflies === 2,
      actual: facts.counts.butterflies,
    },
    {
      name: '14 right firefly nodes',
      pass: facts.counts.rightFireflies === 14,
      actual: facts.counts.rightFireflies,
    },
    {
      name: '4 sidebar firefly nodes',
      pass: facts.counts.sidebarFireflies === 4,
      actual: facts.counts.sidebarFireflies,
    },
    {
      name: 'visible exact-set for active theme',
      pass:
        theme === 'light'
          ? facts.counts.visibleButterflies === 2 && facts.counts.visibleFireflies === 0
          : facts.counts.visibleButterflies === 0 && facts.counts.visibleFireflies === 18,
      actual: {
        butterflies: facts.counts.visibleButterflies,
        fireflies: facts.counts.visibleFireflies,
      },
    },
    {
      name: 'right firefly anchors',
      pass: JSON.stringify(anchorPairs(right)) === JSON.stringify(expectedRightAnchors),
      actual: anchorPairs(right),
    },
    {
      name: 'sidebar firefly anchors',
      pass: JSON.stringify(anchorPairs(sidebar)) === JSON.stringify(expectedSidebarAnchors),
      actual: anchorPairs(sidebar),
    },
    {
      name: 'butterfly anchors',
      pass:
        JSON.stringify(
          facts.butterflies.map((node) => [node.anchor.cssLeft, node.anchor.cssTop]),
        ) ===
        JSON.stringify([
          ['154px', '360px'],
          ['130px', '412px'],
        ]),
      actual: facts.butterflies.map((node) => [node.anchor.cssLeft, node.anchor.cssTop]),
    },
    {
      name: 'ambient nodes are excluded from accessibility and pointer hit testing',
      pass: [...facts.butterflies, ...facts.fireflies].every(
        (node) => node.ariaExcluded && node.pointerEvents === 'none',
      ),
    },
    {
      name: 'no extra ambient butterfly node',
      pass: facts.extraAmbientNodes === 0,
      actual: facts.extraAmbientNodes,
    },
    {
      name: 'no active legacy full viewport scene underlay',
      pass: facts.legacyFullViewportScene?.active !== true,
      actual: facts.legacyFullViewportScene,
    },
  ]
  return { pass: checks.every((check) => check.pass), checks }
}

function geometryComparison(
  reference: Awaited<ReturnType<typeof collectAmbientFacts>>,
  current: Awaited<ReturnType<typeof collectAmbientFacts>>,
) {
  const checks = [
    {
      name: 'reference Sidebar material is bottom 340px',
      pass:
        reference.sidebar?.rect.y === 584 &&
        reference.sidebar.rect.height === 340 &&
        reference.sidebar.rect.bottom === 924,
      actual: reference.sidebar?.rect,
    },
    {
      name: 'current Sidebar material is bottom 340px',
      pass:
        current.sidebar?.rect.y === 584 &&
        current.sidebar.rect.height === 340 &&
        current.sidebar.rect.bottom === 924,
      actual: current.sidebar?.rect,
    },
    {
      name: 'Sidebar material bbox width matches reference',
      pass: reference.sidebar?.rect.width === current.sidebar?.rect.width,
      actual: { reference: reference.sidebar?.rect.width, current: current.sidebar?.rect.width },
    },
    {
      name: 'reference Sidebar material width is 226px',
      pass: reference.sidebar?.rect.width === 226,
      actual: reference.sidebar?.rect.width,
    },
    {
      name: 'current Sidebar material width is 226px',
      pass: current.sidebar?.rect.width === 226,
      actual: current.sidebar?.rect.width,
    },
    {
      name: 'Dark firefly layer reference covers viewport',
      pass:
        reference.fireflyLayer != null &&
        sameRect(reference.fireflyLayer.rect, { x: 0, y: 0, width: 2048, height: 924 }),
      actual: reference.fireflyLayer?.rect,
    },
    {
      name: 'Dark firefly layer current covers viewport',
      pass:
        current.fireflyLayer != null &&
        sameRect(current.fireflyLayer.rect, { x: 0, y: 0, width: 2048, height: 924 }),
      actual: current.fireflyLayer?.rect,
    },
    {
      name: 'current and reference butterfly visible bboxes match',
      pass: current.butterflies.every((node, index) =>
        sameRect(node.rect, reference.butterflies[index]!.rect),
      ),
      actual: {
        reference: reference.butterflies.map((node) => node.rect),
        current: current.butterflies.map((node) => node.rect),
      },
    },
    {
      name: 'current and reference firefly anchor bboxes match',
      pass: current.fireflies.every((node, index) =>
        sameRect(node.rect, reference.fireflies[index]!.rect),
      ),
      actual: {
        reference: reference.fireflies.map((node) => node.rect),
        current: current.fireflies.map((node) => node.rect),
      },
    },
  ]
  return { pass: checks.every((check) => check.pass), checks }
}

function computedStyleComparison(
  theme: Theme,
  reference: Awaited<ReturnType<typeof collectAmbientFacts>>,
  current: Awaited<ReturnType<typeof collectAmbientFacts>>,
) {
  const differences: Array<{
    target: string
    field: string
    reference: unknown
    current: unknown
  }> = []
  const compare = (target: string, field: string, left: unknown, right: unknown) => {
    if (left !== right) differences.push({ target, field, reference: left, current: right })
  }
  for (const field of [
    'position',
    'bottom',
    'height',
    'backgroundColor',
    'backgroundPosition',
    'backgroundSize',
    'maskImage',
    'opacity',
  ] as const) {
    compare('Sidebar material', field, reference.sidebar?.[field], current.sidebar?.[field])
  }
  compare('Sidebar material', 'assetSha256', reference.assetSha256, current.assetSha256)
  compare(
    'full viewport scene underlay',
    'active',
    reference.legacyFullViewportScene?.active ?? false,
    current.legacyFullViewportScene?.active ?? false,
  )
  for (const field of ['position', 'top', 'right', 'bottom', 'left', 'pointerEvents'] as const) {
    compare('firefly layer', field, reference.fireflyLayer?.[field], current.fireflyLayer?.[field])
  }
  for (const [index, node] of reference.butterflies.entries()) {
    const currentNode = current.butterflies[index]!
    for (const field of [
      'size',
      'opacity',
      'backgroundPosition',
      'mixBlendMode',
      'maskImage',
      'pointerEvents',
    ] as const) {
      compare(
        `butterfly ${index + 1}`,
        field,
        JSON.stringify(node[field]),
        JSON.stringify(currentNode[field]),
      )
    }
  }
  if (theme === 'dark') {
    for (const [index, node] of reference.fireflies.entries()) {
      const currentNode = current.fireflies[index]!
      for (const field of [
        'size',
        'opacity',
        'borderRadius',
        'boxShadow',
        'pointerEvents',
      ] as const) {
        compare(
          `firefly ${index + 1}`,
          field,
          JSON.stringify(node[field]),
          JSON.stringify(currentNode[field]),
        )
      }
    }
  }
  return { pass: differences.length === 0, differences }
}

function reducedMotionResult(
  before: Awaited<ReturnType<typeof collectAmbientFacts>>,
  after: Awaited<ReturnType<typeof collectAmbientFacts>>,
) {
  const beforeNodes = [...before.butterflies, ...before.fireflies]
  const afterNodes = [...after.butterflies, ...after.fireflies]
  const checks = beforeNodes.map((node, index) => ({
    index,
    animationName: node.animationName,
    stationary: sameRect(node.rect, afterNodes[index]!.rect),
    pass: node.animationName === 'none' && sameRect(node.rect, afterNodes[index]!.rect),
  }))
  return { pass: checks.every((check) => check.pass), checks }
}

async function pixelDiff(reference: string, current: string, diff: string) {
  const { stdout } = await execFileAsync(
    'uv',
    [
      'run',
      '--offline',
      '--isolated',
      '--python',
      '3.12',
      '--with',
      'pillow==10.4.0',
      'python',
      pixelDiffTool,
      reference,
      current,
      diff,
      '8',
    ],
    { cwd: desktopRoot },
  )
  return JSON.parse(stdout.trim())
}

async function genericVisibility(page: Page, implementation: Implementation) {
  if (implementation === 'current') {
    await page.goto(`${sourceURL}/settings`)
    await expect(page.locator('.hc-settings')).toBeVisible({ timeout: 30_000 })
    await page.getByRole('tab', { name: '系统设置', exact: true }).click()
    await page.getByRole('radio', { name: /通用外观/ }).click()
  } else {
    await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>('.sb-item[data-screen="settings"]')?.click()
      ;[
        ...document.querySelectorAll<HTMLButtonElement>(
          '.screen[data-pane="settings"] [role="tab"]',
        ),
      ]
        .find((tab) => tab.textContent?.trim() === '系统设置')
        ?.click()
    })
    await page.getByRole('radio', { name: /通用外观/ }).click()
  }
  await expect(page.locator('body')).toHaveAttribute('data-k12-skin-active', 'default')
  return page.evaluate((kind) => {
    const candidates =
      kind === 'current'
        ? ['[data-testid="k12-global-presentation"]']
        : ['.k12-sidebar-art', '.k12-sidebar-ambient', '.k12-global-ambient']
    return candidates.map((selector) => {
      const node = document.querySelector<HTMLElement>(selector)!
      const style = getComputedStyle(node)
      const rect = node.getBoundingClientRect()
      const visible =
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity) > 0 &&
        rect.width > 0 &&
        rect.height > 0
      return {
        selector,
        display: style.display,
        visibility: style.visibility,
        opacity: style.opacity,
        visible,
      }
    })
  }, implementation)
}

function semanticComparison(
  reference: Awaited<ReturnType<typeof collectSemantic>>,
  current: Awaited<ReturnType<typeof collectSemantic>>,
) {
  const expected = JSON.stringify(expectedLogs)
  return {
    comparable:
      JSON.stringify(reference.rows) === expected &&
      JSON.stringify(current.rows) === expected &&
      JSON.stringify(reference.viewport) === JSON.stringify(current.viewport) &&
      reference.theme === current.theme &&
      reference.skin === current.skin,
    expected: expectedLogs,
    reference,
    current,
  }
}

function visibleDrift(
  geometry: ReturnType<typeof geometryComparison>,
  computedStyle: ReturnType<typeof computedStyleComparison>,
  fullPage: { changed_pixel_ratio: number },
  ambientCrop: { changed_pixel_ratio: number },
  materialScene: { changed_pixel_ratio: number },
) {
  const drift: string[] = []
  for (const check of geometry.checks.filter((item) => !item.pass)) drift.push(check.name)
  for (const difference of computedStyle.differences) {
    drift.push(
      `${difference.target}.${difference.field}: ${difference.reference} -> ${difference.current}`,
    )
  }
  if (ambientCrop.changed_pixel_ratio > 0.01) {
    drift.push(
      `bottom 340px Sidebar crop pixel difference ${(ambientCrop.changed_pixel_ratio * 100).toFixed(3)}%`,
    )
  }
  if (materialScene.changed_pixel_ratio > 0.01) {
    drift.push(
      `Sidebar material-only crop pixel difference ${(materialScene.changed_pixel_ratio * 100).toFixed(3)}%`,
    )
  }
  if (fullPage.changed_pixel_ratio > 0.01) {
    drift.push(`full-page pixel difference ${(fullPage.changed_pixel_ratio * 100).toFixed(3)}%`)
  }
  return drift
}

async function makeContexts(browser: Browser, reducedMotion: 'reduce' | 'no-preference') {
  const options = { viewport, deviceScaleFactor: 1, locale: 'zh-CN', reducedMotion } as const
  const source = await browser.newContext(options)
  const reference = await browser.newContext(options)
  return { source, reference }
}

async function closeContexts(...contexts: BrowserContext[]) {
  await Promise.all(contexts.map((context) => context.close()))
}

for (const theme of ['light', 'dark'] as const) {
  test(`${theme}: reduced-motion paired ambient geometry and computed evidence`, async ({
    browser,
  }) => {
    const externalRequests: string[] = []
    const contexts = await makeContexts(browser, 'reduce')
    const source = await contexts.source.newPage()
    const reference = await contexts.reference.newPage()
    try {
      await Promise.all([
        installSourceFixture(source, theme, externalRequests),
        installReferenceFixture(reference, theme, externalRequests),
      ])
      await openSource(source, theme)
      await Promise.all([
        expect(reference.locator('html')).toHaveAttribute('data-theme', theme),
        expect(reference.locator('.logrow')).toHaveCount(4),
      ])
      await Promise.all([waitForRenderedAssets(source), waitForRenderedAssets(reference)])
      await Promise.all([source.mouse.move(1800, 20), reference.mouse.move(1800, 20)])

      const [referenceSemantic, currentSemantic, referenceBefore, currentBefore] =
        await Promise.all([
          collectSemantic(reference, 'reference'),
          collectSemantic(source, 'current'),
          collectAmbientFacts(reference, 'reference'),
          collectAmbientFacts(source, 'current'),
        ])
      const semantic = semanticComparison(referenceSemantic, currentSemantic)
      await Promise.all([source.waitForTimeout(650), reference.waitForTimeout(650)])
      const [referenceAfter, currentAfter] = await Promise.all([
        collectAmbientFacts(reference, 'reference'),
        collectAmbientFacts(source, 'current'),
      ])

      await mkdir(evidenceRoot, { recursive: true })
      const stem = `${theme}-logs-2048x924-dpr1-zh-CN-reduced-chromium`
      const referencePath = path.join(evidenceRoot, `reference-${stem}.png`)
      const currentPath = path.join(evidenceRoot, `current-${stem}.png`)
      const diffPath = path.join(evidenceRoot, `diff-${stem}.png`)
      const referenceCropPath = path.join(evidenceRoot, `reference-sidebar-bottom340-${stem}.png`)
      const currentCropPath = path.join(evidenceRoot, `current-sidebar-bottom340-${stem}.png`)
      const cropDiffPath = path.join(evidenceRoot, `diff-sidebar-bottom340-${stem}.png`)
      // 底部版本条属于业务壳层；另取其上方 280px，隔离 Sidebar 场景材质本身。
      const referenceMaterialPath = path.join(
        evidenceRoot,
        `reference-sidebar-material-${stem}.png`,
      )
      const currentMaterialPath = path.join(evidenceRoot, `current-sidebar-material-${stem}.png`)
      const materialDiffPath = path.join(evidenceRoot, `diff-sidebar-material-${stem}.png`)
      await Promise.all([
        reference.screenshot({ path: referencePath, animations: 'disabled' }),
        source.screenshot({ path: currentPath, animations: 'disabled' }),
        reference.screenshot({
          path: referenceCropPath,
          animations: 'disabled',
          clip: { x: 0, y: 584, width: 226, height: 340 },
        }),
        source.screenshot({
          path: currentCropPath,
          animations: 'disabled',
          clip: { x: 0, y: 584, width: 226, height: 340 },
        }),
        reference.screenshot({
          path: referenceMaterialPath,
          animations: 'disabled',
          clip: { x: 0, y: 584, width: 226, height: 280 },
        }),
        source.screenshot({
          path: currentMaterialPath,
          animations: 'disabled',
          clip: { x: 0, y: 584, width: 226, height: 280 },
        }),
      ])
      const [fullPage, ambientCrop, materialScene] = await Promise.all([
        pixelDiff(referencePath, currentPath, diffPath),
        pixelDiff(referenceCropPath, currentCropPath, cropDiffPath),
        pixelDiff(referenceMaterialPath, currentMaterialPath, materialDiffPath),
      ])

      const referenceExactSet = exactSet(theme, referenceBefore)
      const currentExactSet = exactSet(theme, currentBefore)
      const geometry = geometryComparison(referenceBefore, currentBefore)
      const computedStyle = computedStyleComparison(theme, referenceBefore, currentBefore)
      const referenceReduced = reducedMotionResult(referenceBefore, referenceAfter)
      const currentReduced = reducedMotionResult(currentBefore, currentAfter)

      await Promise.all([
        source.setViewportSize({ width: 1040, height: 924 }),
        reference.setViewportSize({ width: 1040, height: 924 }),
      ])
      const responsiveFacts = await Promise.all([
        reference.locator('.k12-global-ambient').evaluate((node) => getComputedStyle(node).display),
        source
          .locator('.k12-global-presentation__fireflies')
          .evaluate((node) => getComputedStyle(node).display),
      ])
      await Promise.all([source.setViewportSize(viewport), reference.setViewportSize(viewport)])
      const [referenceGeneric, currentGeneric] = await Promise.all([
        genericVisibility(reference, 'reference'),
        genericVisibility(source, 'current'),
      ])
      const responsiveAndGeneric = {
        pass:
          responsiveFacts[0] === 'none' &&
          responsiveFacts[1] === 'none' &&
          referenceGeneric.every((item) => !item.visible) &&
          currentGeneric.every((item) => !item.visible),
        responsiveFacts: { reference: responsiveFacts[0], current: responsiveFacts[1] },
        generic: { reference: referenceGeneric, current: currentGeneric },
      }
      const reducedMotion = {
        pass: referenceReduced.pass && currentReduced.pass,
        reference: referenceReduced,
        current: currentReduced,
      }
      const exactSetResult = {
        pass: referenceExactSet.pass && currentExactSet.pass,
        reference: referenceExactSet,
        current: currentExactSet,
      }
      const pixel = {
        fullPage: { ...fullPage, pass: fullPage.changed_pixel_ratio <= 0.01 },
        ambientCrop: { ...ambientCrop, pass: ambientCrop.changed_pixel_ratio <= 0.01 },
        materialScene: { ...materialScene, pass: materialScene.changed_pixel_ratio <= 0.01 },
      }
      const drift = visibleDrift(geometry, computedStyle, fullPage, ambientCrop, materialScene)
      const ambientTargetDecision =
        semantic.comparable &&
        exactSetResult.pass &&
        geometry.pass &&
        computedStyle.pass &&
        reducedMotion.pass &&
        responsiveAndGeneric.pass &&
        pixel.materialScene.pass
          ? 'PASS'
          : semantic.comparable
            ? 'NOT_PASS'
            : 'NOT_COMPARABLE'
      const decision = !semantic.comparable
        ? 'NOT_COMPARABLE'
        : exactSetResult.pass &&
            geometry.pass &&
            computedStyle.pass &&
            reducedMotion.pass &&
            responsiveAndGeneric.pass &&
            pixel.fullPage.pass &&
            pixel.ambientCrop.pass
          ? 'PASS'
          : 'NOT_PASS'
      const comparison = {
        bugId: 'BUG-20260801-012',
        theme,
        semantic,
        exactSet: exactSetResult,
        geometry,
        computedStyle,
        reducedMotion,
        responsiveAndGeneric,
        pixel,
        visibleDrift: drift,
        ambientTargetDecision,
        decision,
        network: { externalRequests },
      }
      await Promise.all([
        writeFile(
          path.join(evidenceRoot, `bbox-computed-${theme}.json`),
          JSON.stringify(
            {
              reference: { before: referenceBefore, after650ms: referenceAfter },
              current: { before: currentBefore, after650ms: currentAfter },
            },
            null,
            2,
          ),
        ),
        writeFile(
          path.join(evidenceRoot, `comparison-${theme}.json`),
          JSON.stringify(comparison, null, 2),
        ),
      ])

      expect(semantic.comparable).toBe(true)
      expect(externalRequests).toEqual([])
    } finally {
      await closeContexts(contexts.source, contexts.reference)
    }
  })

  test(`${theme}: no-preference 650ms motion evidence`, async ({ browser }) => {
    const externalRequests: string[] = []
    const contexts = await makeContexts(browser, 'no-preference')
    const source = await contexts.source.newPage()
    const reference = await contexts.reference.newPage()
    try {
      await Promise.all([
        installSourceFixture(source, theme, externalRequests),
        installReferenceFixture(reference, theme, externalRequests),
      ])
      await openSource(source, theme)
      await expect(reference.locator('.logrow')).toHaveCount(4)
      await Promise.all([waitForRenderedAssets(source), waitForRenderedAssets(reference)])
      if (theme === 'dark')
        await Promise.all([source.waitForTimeout(4000), reference.waitForTimeout(4000)])

      const [referenceSemantic, currentSemantic] = await Promise.all([
        collectSemantic(reference, 'reference'),
        collectSemantic(source, 'current'),
      ])
      const semantic = semanticComparison(referenceSemantic, currentSemantic)
      await mkdir(evidenceRoot, { recursive: true })
      const stem = `${theme}-logs-2048x924-dpr1-zh-CN-motion-chromium`
      const referenceBeforePath = path.join(evidenceRoot, `reference-motion-before-${stem}.png`)
      const referenceAfterPath = path.join(evidenceRoot, `reference-motion-after650-${stem}.png`)
      const referenceDiffPath = path.join(evidenceRoot, `reference-motion-diff650-${stem}.png`)
      const currentBeforePath = path.join(evidenceRoot, `current-motion-before-${stem}.png`)
      const currentAfterPath = path.join(evidenceRoot, `current-motion-after650-${stem}.png`)
      const currentDiffPath = path.join(evidenceRoot, `current-motion-diff650-${stem}.png`)
      const motionResult = (
        before: Awaited<ReturnType<typeof collectAmbientFacts>>,
        after: Awaited<ReturnType<typeof collectAmbientFacts>>,
      ) => {
        const beforeNodes = theme === 'light' ? before.butterflies : before.fireflies
        const afterNodes = theme === 'light' ? after.butterflies : after.fireflies
        const nodes = beforeNodes.map((node, index) => {
          const next = afterNodes[index]!
          const centerDisplacement = Math.hypot(
            node.rect.x + node.rect.width / 2 - (next.rect.x + next.rect.width / 2),
            node.rect.y + node.rect.height / 2 - (next.rect.y + next.rect.height / 2),
          )
          const bboxSizeDelta = Math.max(
            Math.abs(node.rect.width - next.rect.width),
            Math.abs(node.rect.height - next.rect.height),
          )
          return {
            index,
            animationName: node.animationName,
            animationFamily: baseAnimationName(node.animationName),
            animationDuration: node.animationDuration,
            centerDisplacement,
            bboxSizeDelta,
            beforeTranslation: node.translation,
            afterTranslation: next.translation,
            transformChanged: node.transform !== next.transform,
          }
        })
        const expectedFamilies =
          theme === 'light'
            ? ['k12ButterflyDriftOne', 'k12ButterflyDriftTwo']
            : Array(18).fill('k12FireflyDrift')
        const pass =
          JSON.stringify(nodes.map((node) => node.animationFamily)) ===
            JSON.stringify(expectedFamilies) &&
          nodes.every((node) => node.transformChanged) &&
          (theme === 'light'
            ? nodes.every((node) => {
                const seconds = Number.parseFloat(node.animationDuration)
                return seconds >= 6 && seconds <= 8
              }) && Math.max(...nodes.map((node) => node.centerDisplacement)) >= 4
            : nodes.every(
                (node) =>
                  node.beforeTranslation.magnitude <= 6 && node.afterTranslation.magnitude <= 6,
              ) &&
              Math.max(
                ...nodes.map((node) => Math.max(node.centerDisplacement, node.bboxSizeDelta)),
              ) >= 2)
        return { pass, nodes }
      }
      // CSS 动画从页面装载时开始，固定的 650ms 采样可能落在位移峰值之外。
      // 只等待自然动画进入下一采样窗口，不改写 animation、delay 或 DOM，最终 pair 仍严格相隔 650ms。
      let referenceBefore = await collectAmbientFacts(reference, 'reference')
      let currentBefore = await collectAmbientFacts(source, 'current')
      let referenceAfter = referenceBefore
      let currentAfter = currentBefore
      let referencePixel: Awaited<ReturnType<typeof pixelDiff>>
      let currentPixel: Awaited<ReturnType<typeof pixelDiff>>
      let referenceMotion = motionResult(referenceBefore, referenceAfter)
      let currentMotion = motionResult(currentBefore, currentAfter)
      let motionAttempts = 0
      const motionSamplingStartedAt = Date.now()
      const motionSamplingDeadline = motionSamplingStartedAt + 12_000
      while (true) {
        motionAttempts += 1
        await Promise.all([
          reference.screenshot({ path: referenceBeforePath }),
          source.screenshot({ path: currentBeforePath }),
        ])
        await Promise.all([source.waitForTimeout(650), reference.waitForTimeout(650)])
        ;[referenceAfter, currentAfter] = await Promise.all([
          collectAmbientFacts(reference, 'reference'),
          collectAmbientFacts(source, 'current'),
        ])
        await Promise.all([
          reference.screenshot({ path: referenceAfterPath }),
          source.screenshot({ path: currentAfterPath }),
        ])
        ;[referencePixel, currentPixel] = await Promise.all([
          pixelDiff(referenceBeforePath, referenceAfterPath, referenceDiffPath),
          pixelDiff(currentBeforePath, currentAfterPath, currentDiffPath),
        ])
        referenceMotion = motionResult(referenceBefore, referenceAfter)
        currentMotion = motionResult(currentBefore, currentAfter)
        if ((referenceMotion.pass && currentMotion.pass) || Date.now() >= motionSamplingDeadline) {
          break
        }
        await Promise.all([source.waitForTimeout(200), reference.waitForTimeout(200)])
        ;[referenceBefore, currentBefore] = await Promise.all([
          collectAmbientFacts(reference, 'reference'),
          collectAmbientFacts(source, 'current'),
        ])
      }
      const report = {
        bugId: 'BUG-20260801-012',
        theme,
        semantic,
        reference: { ...referenceMotion, pixel: referencePixel },
        current: { ...currentMotion, pixel: currentPixel },
        motionSampling: {
          attempts: motionAttempts,
          elapsedMs: Date.now() - motionSamplingStartedAt,
          intervalMs: 650,
          naturalAnimationOnly: true,
        },
        network: { externalRequests },
      }
      await writeFile(
        path.join(evidenceRoot, `motion-${theme}.json`),
        JSON.stringify(report, null, 2),
      )
      expect(semantic.comparable).toBe(true)
      expect(externalRequests).toEqual([])
      expect(referenceMotion.pass).toBe(true)
      expect(currentMotion.pass).toBe(true)
    } finally {
      await closeContexts(contexts.source, contexts.reference)
    }
  })
}
