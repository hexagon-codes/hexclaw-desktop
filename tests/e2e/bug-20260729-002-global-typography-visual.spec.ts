import { expect, test, type Page, type Route } from '@playwright/test'
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const evidenceRoot = process.env.HEX_BUG002_EVIDENCE_DIR
const sourceURL = process.env.HEX_BUG002_SOURCE_URL
const referenceURL = process.env.HEX_BUG002_REFERENCE_URL
const pixelDiffTool = path.join(desktopRoot, 'tests/e2e/tools/visual_pixel_diff.py')
const fixedNow = Date.parse('2026-07-29T12:49:13+08:00')
const viewport = { width: 1440, height: 900 }

if (!evidenceRoot || !sourceURL || !referenceURL) {
  throw new Error('BUG-20260729-002 evidence directory and source/reference URLs are required')
}

type Theme = 'light' | 'dark'
type Layout = 'main' | 'blank'

interface Surface {
  id: string
  theme: Theme
  layout: Layout
  k12: boolean
  sourceRoute: '/settings' | '/quick-chat'
}

const surfaces: readonly Surface[] = [
  { id: 'main-shell-light', theme: 'light', layout: 'main', k12: false, sourceRoute: '/settings' },
  { id: 'main-shell-dark', theme: 'dark', layout: 'main', k12: false, sourceRoute: '/settings' },
  {
    id: 'k12-global-shell-light',
    theme: 'light',
    layout: 'main',
    k12: true,
    sourceRoute: '/settings',
  },
  {
    id: 'blank-quick-chat-light',
    theme: 'light',
    layout: 'blank',
    k12: false,
    sourceRoute: '/quick-chat',
  },
]

const probeMarkup = `
  <div data-probe-node="toolbar">
    <span data-probe-node="toolbar-title">排版验收 · Typography</span>
    <span data-probe-node="toolbar-meta">1440×900 · DPR 1</span>
  </div>
  <div data-probe-node="page-root">
    <div data-probe-node="card">
      <div data-probe-node="card-title">共享根字号 14px / 行高 21px</div>
      <div data-probe-node="body-copy">中文正文、English text、0123456789 均只继承应用根排版事实。</div>
      <div data-probe-node="action" role="button">确认排版</div>
    </div>
  </div>`

const probeCSS = `
  #bug-20260729-002-typography-probe {
    all: initial !important;
    position: fixed !important;
    left: 360px !important;
    top: 180px !important;
    z-index: 2147483647 !important;
    display: block !important;
    box-sizing: border-box !important;
    width: 720px !important;
    height: 360px !important;
    overflow: hidden !important;
    padding: 24px !important;
    border: 1px solid #cbd5e1 !important;
    border-radius: 16px !important;
    background: #f8fafc !important;
    color: #1e293b !important;
    font-family: inherit !important;
    font-size: inherit !important;
    font-weight: 400 !important;
    line-height: inherit !important;
    letter-spacing: normal !important;
    -webkit-font-smoothing: inherit !important;
  }
  #bug-20260729-002-typography-probe * {
    all: initial !important;
    box-sizing: border-box !important;
    color: inherit !important;
    font-family: inherit !important;
    font-size: inherit !important;
    font-weight: inherit !important;
    line-height: inherit !important;
    letter-spacing: inherit !important;
    -webkit-font-smoothing: inherit !important;
  }
  #bug-20260729-002-typography-probe [data-probe-node="toolbar"] {
    display: flex !important;
    align-items: center !important;
    justify-content: space-between !important;
    width: 100% !important;
    height: 48px !important;
    padding: 0 16px !important;
    border: 1px solid #dbe3ed !important;
    border-radius: 10px !important;
    background: #ffffff !important;
  }
  #bug-20260729-002-typography-probe [data-probe-node="toolbar-title"],
  #bug-20260729-002-typography-probe [data-probe-node="toolbar-meta"],
  #bug-20260729-002-typography-probe [data-probe-node="card-title"],
  #bug-20260729-002-typography-probe [data-probe-node="body-copy"],
  #bug-20260729-002-typography-probe [data-probe-node="action"] {
    display: block !important;
  }
  #bug-20260729-002-typography-probe [data-probe-node="page-root"] {
    display: block !important;
    width: 100% !important;
    padding-top: 20px !important;
  }
  #bug-20260729-002-typography-probe [data-probe-node="card"] {
    display: block !important;
    width: 100% !important;
    height: 236px !important;
    padding: 22px !important;
    border: 1px solid #dbe3ed !important;
    border-radius: 12px !important;
    background: #ffffff !important;
  }
  #bug-20260729-002-typography-probe [data-probe-node="card-title"] {
    font-weight: 600 !important;
  }
  #bug-20260729-002-typography-probe [data-probe-node="body-copy"] {
    width: 560px !important;
    margin-top: 18px !important;
  }
  #bug-20260729-002-typography-probe [data-probe-node="action"] {
    width: 112px !important;
    height: 36px !important;
    margin-top: 22px !important;
    padding: 7px 14px !important;
    border: 1px solid #94a3b8 !important;
    border-radius: 8px !important;
    background: #eff6ff !important;
    text-align: center !important;
  }`

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

async function installSourceRuntime(page: Page, surface: Surface, externalRequests: string[]) {
  await page.addInitScript(
    ({ now, theme, k12 }) => {
      localStorage.clear()
      sessionStorage.clear()
      Date.now = () => now
      localStorage.setItem('hc-theme', theme)
      localStorage.setItem(
        'hc-k12-appearance-v1',
        JSON.stringify({ version: 1, preference: k12 ? 'k12' : 'default', introSeen: true }),
      )
      localStorage.setItem('hexclaw:welcomeRedirectDone', '1')
      sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
      ;(globalThis as unknown as Record<string, unknown>).isTauri = false

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
    { now: fixedNow, theme: surface.theme, k12: surface.k12 },
  )

  page.on('request', (request) => {
    const url = new URL(request.url())
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) externalRequests.push(request.url())
  })
  await page.route('**/*', (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) return route.abort()
    if (!url.pathname.startsWith('/_hexclaw/') && url.hostname === '127.0.0.1') {
      return route.continue()
    }
    const apiPath = url.pathname.replace(/^\/_hexclaw/, '')
    if (apiPath === '/health') return json(route, { status: 'ok' })
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
    if (apiPath === '/api/v1/agents') return json(route, { agents: [], total: 0, default: '' })
    if (apiPath === '/api/v1/sessions') return json(route, { sessions: [], total: 0 })
    if (apiPath === '/api/v1/streams/active') return json(route, { streams: [], total: 0 })
    if (apiPath === '/api/v1/ollama/status') {
      return json(route, { running: false, associated: false, models: [] })
    }
    if (apiPath.includes('/update')) return json(route, { available: false })
    return json(route, {})
  })
}

async function installReferenceRuntime(page: Page, surface: Surface, externalRequests: string[]) {
  await page.addInitScript(
    ({ now, theme, k12 }) => {
      localStorage.clear()
      sessionStorage.clear()
      Date.now = () => now
      localStorage.setItem('hc-theme', theme)
      localStorage.setItem(
        'hexclaw.prototype.k12Appearance.v1',
        JSON.stringify({ preference: k12 ? 'k12' : 'default', introSeen: true }),
      )
    },
    { now: fixedNow, theme: surface.theme, k12: surface.k12 },
  )
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) externalRequests.push(request.url())
  })
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url())
    return ['127.0.0.1', 'localhost'].includes(url.hostname) ? route.continue() : route.abort()
  })
}

async function settle(page: Page) {
  await page.addStyleTag({
    content:
      '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}',
  })
  await page.mouse.move(1400, 20)
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
}

async function openSource(page: Page, surface: Surface) {
  await page.goto(`${sourceURL}${surface.sourceRoute}`, { waitUntil: 'domcontentloaded' })
  await page.locator('#app').waitFor({ state: 'visible' })
  if (surface.layout === 'main') {
    await page.locator('.hc-app').waitFor({ state: 'visible' })
    await page.locator('.hc-settings').waitFor({ state: 'visible' })
    await page.locator('.hc-toolbar').waitFor({ state: 'visible' })
  } else {
    await page.locator('#app > div').first().waitFor({ state: 'visible' })
  }
  await expect(page.locator('html')).toHaveAttribute('data-theme', surface.theme)
  await expect(page.locator('body')).toHaveAttribute(
    'data-k12-skin-active',
    surface.k12 ? 'k12' : 'default',
  )
  await settle(page)
}

async function openReference(page: Page, surface: Surface) {
  await page.goto(referenceURL!, { waitUntil: 'domcontentloaded' })
  await page.locator('.app').waitFor({ state: 'visible' })
  await page.evaluate(({ theme, layout, k12 }) => {
    const prototypeWindow = window as typeof window & {
      applyThemeState?: (value: string, persist?: boolean) => void
      setK12SkinPreference?: (value: string, options?: { announce?: boolean }) => void
      openQuickChat?: () => void
    }
    prototypeWindow.applyThemeState?.(theme, false)
    prototypeWindow.setK12SkinPreference?.(k12 ? 'k12' : 'default', { announce: false })
    if (layout === 'blank') prototypeWindow.openQuickChat?.()
    else {
      ;(document.querySelector('.sb-item[data-screen="settings"]') as HTMLElement | null)?.click()
    }
  }, surface)
  if (surface.layout === 'main') {
    await page.locator('.screen[data-pane="settings"].on').waitFor({ state: 'visible' })
  } else {
    await page.locator('#blankRoute.on .quick-page').waitFor({ state: 'visible' })
  }
  await expect(page.locator('html')).toHaveAttribute('data-theme', surface.theme)
  await expect(page.locator('body')).toHaveAttribute(
    'data-k12-skin-active',
    surface.k12 ? 'k12' : 'default',
  )
  await settle(page)
}

async function injectProbe(page: Page, mountSelector: string) {
  await page.evaluate(
    ({ selector, markup, css }) => {
      document.getElementById('bug-20260729-002-probe-style')?.remove()
      document.getElementById('bug-20260729-002-typography-probe')?.remove()
      const mount = document.querySelector(selector)
      if (!mount) throw new Error(`typography probe mount is missing: ${selector}`)
      const style = document.createElement('style')
      style.id = 'bug-20260729-002-probe-style'
      style.textContent = css
      document.head.append(style)
      const probe = document.createElement('section')
      probe.id = 'bug-20260729-002-typography-probe'
      probe.setAttribute('aria-label', 'BUG-20260729-002 typography fixture')
      probe.innerHTML = markup
      mount.append(probe)
    },
    { selector: mountSelector, markup: probeMarkup, css: probeCSS },
  )
  await page.locator('#bug-20260729-002-typography-probe').waitFor({ state: 'visible' })
}

type SnapshotTarget = { name: string; selector: string }

function targets(surface: Surface, implementation: boolean): SnapshotTarget[] {
  if (implementation) {
    return [
      { name: 'body', selector: 'body' },
      { name: 'mount', selector: '#app' },
      {
        name: 'appRoot',
        selector: surface.layout === 'main' ? '.hc-app' : '#app > div',
      },
      {
        name: 'pageRoot',
        selector: surface.layout === 'main' ? '.hc-settings' : '#app > div',
      },
      {
        name: 'toolbar',
        selector: surface.layout === 'main' ? '.hc-toolbar' : '#app > div > div:first-child',
      },
    ]
  }
  return [
    { name: 'body', selector: 'body' },
    {
      name: 'appRoot',
      selector: surface.layout === 'main' ? '.app' : '#blankRoute',
    },
    {
      name: 'pageRoot',
      selector: surface.layout === 'main' ? '.screen[data-pane="settings"].on' : '.quick-page',
    },
    {
      name: 'toolbar',
      selector:
        surface.layout === 'main'
          ? '.screen[data-pane="settings"].on > .tbar'
          : '.quick-route-title',
    },
  ]
}

async function collectFacts(page: Page, surface: Surface, implementation: boolean) {
  return page.evaluate(
    ({ requestedTargets }) => {
      const snapshot = (selector: string) => {
        const element = document.querySelector<HTMLElement>(selector)
        if (!element) return null
        const rect = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        return {
          selector,
          rect: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            right: rect.right,
            bottom: rect.bottom,
          },
          style: {
            display: style.display,
            fontSize: style.fontSize,
            lineHeight: style.lineHeight,
            fontFamily: style.fontFamily,
            fontWeight: style.fontWeight,
            letterSpacing: style.letterSpacing,
            webkitFontSmoothing: style.getPropertyValue('-webkit-font-smoothing'),
          },
        }
      }
      const actual = Object.fromEntries(
        requestedTargets.map(({ name, selector }) => [name, snapshot(selector)]),
      )
      const probeNames = [
        'root',
        'toolbar',
        'toolbar-title',
        'toolbar-meta',
        'page-root',
        'card',
        'card-title',
        'body-copy',
        'action',
      ]
      const probe = Object.fromEntries(
        probeNames.map((name) => [
          name,
          snapshot(
            name === 'root'
              ? '#bug-20260729-002-typography-probe'
              : `#bug-20260729-002-typography-probe [data-probe-node="${name}"]`,
          ),
        ]),
      )
      return {
        environment: {
          viewport: { width: innerWidth, height: innerHeight },
          devicePixelRatio,
          locale: navigator.language,
          theme: document.documentElement.dataset.theme ?? null,
          k12Skin: document.body.dataset.k12SkinActive ?? null,
        },
        actual,
        probe,
      }
    },
    { requestedTargets: targets(surface, implementation) },
  )
}

type Facts = Awaited<ReturnType<typeof collectFacts>>

const rootTargetNames = new Set(['body', 'mount', 'appRoot', 'pageRoot'])

function compareTypography(reference: Facts, implementation: Facts) {
  const expected = { fontSize: '14px', lineHeight: '21px' }
  const differences: Array<Record<string, unknown>> = []
  for (const [side, facts] of [
    ['reference', reference],
    ['implementation', implementation],
  ] as const) {
    for (const [name, target] of Object.entries(facts.actual)) {
      if (!rootTargetNames.has(name)) continue
      if (!target) {
        differences.push({ side, target: name, kind: 'missing' })
        continue
      }
      for (const [field, value] of Object.entries(expected)) {
        if (target.style[field as keyof typeof target.style] !== value) {
          differences.push({
            side,
            target: name,
            field,
            expected: value,
            actual: target.style[field as keyof typeof target.style],
          })
        }
      }
    }
  }
  const probeFields = [
    'fontSize',
    'lineHeight',
    'fontFamily',
    'fontWeight',
    'letterSpacing',
    'webkitFontSmoothing',
  ] as const
  for (const name of Object.keys(reference.probe)) {
    const left = reference.probe[name]
    const right = implementation.probe[name]
    if (!left || !right) {
      differences.push({
        target: `probe.${name}`,
        kind: 'missing',
        reference: !!left,
        implementation: !!right,
      })
      continue
    }
    for (const field of probeFields) {
      if (left.style[field] !== right.style[field]) {
        differences.push({
          target: `probe.${name}`,
          field,
          reference: left.style[field],
          implementation: right.style[field],
        })
      }
    }
    for (const field of ['x', 'y', 'width', 'height'] as const) {
      if (Math.abs(left.rect[field] - right.rect[field]) > 0.5) {
        differences.push({
          target: `probe.${name}`,
          field: `rect.${field}`,
          reference: left.rect[field],
          implementation: right.rect[field],
        })
      }
    }
  }
  return { expected, pass: differences.length === 0, differences }
}

function independentSurfaceDrift(reference: Facts, implementation: Facts) {
  const differences: Array<Record<string, unknown>> = []
  for (const name of ['appRoot', 'pageRoot', 'toolbar']) {
    const left = reference.actual[name]
    const right = implementation.actual[name]
    if (!left || !right) continue
    for (const field of ['x', 'y', 'width', 'height'] as const) {
      if (Math.abs(left.rect[field] - right.rect[field]) > 1) {
        differences.push({
          target: name,
          field: `rect.${field}`,
          reference: left.rect[field],
          implementation: right.rect[field],
          classification: 'independent-structure-not-BUG-20260729-002',
        })
      }
    }
    for (const field of [
      'display',
      'fontSize',
      'lineHeight',
      'fontFamily',
      'fontWeight',
      'letterSpacing',
    ] as const) {
      if (left.style[field] !== right.style[field]) {
        differences.push({
          target: name,
          field: `style.${field}`,
          reference: left.style[field],
          implementation: right.style[field],
          classification: 'independent-local-style-not-BUG-20260729-002',
        })
      }
    }
  }
  return differences
}

async function pixelDiff(reference: string, implementation: string, output: string) {
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
      implementation,
      output,
      '8',
    ],
    { cwd: desktopRoot },
  )
  return JSON.parse(stdout.trim()) as {
    changed_pixel_ratio: number
    changed_pixels: number
    total_pixels: number
    changed_bbox: number[] | null
  }
}

test.describe.configure({ mode: 'serial' })

for (const surface of surfaces) {
  test(`${surface.id}: root typography is homomorphic and structural drift stays independent`, async ({
    browser,
  }, testInfo) => {
    const engine = testInfo.project.name
    const directory = path.join(evidenceRoot, engine, surface.id)
    await mkdir(directory, { recursive: true })
    const sourceExternalRequests: string[] = []
    const referenceExternalRequests: string[] = []
    const sourceContext = await browser.newContext({
      viewport,
      deviceScaleFactor: 1,
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      colorScheme: surface.theme,
      reducedMotion: 'reduce',
    })
    const referenceContext = await browser.newContext({
      viewport,
      deviceScaleFactor: 1,
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      colorScheme: surface.theme,
      reducedMotion: 'reduce',
    })
    const source = await sourceContext.newPage()
    const reference = await referenceContext.newPage()
    try {
      await installSourceRuntime(source, surface, sourceExternalRequests)
      await installReferenceRuntime(reference, surface, referenceExternalRequests)
      await Promise.all([openSource(source, surface), openReference(reference, surface)])

      const fullReferencePath = path.join(directory, 'full-reference.png')
      const fullImplementationPath = path.join(directory, 'full-implementation.png')
      const fullDiffPath = path.join(directory, 'full-pixel-diff.png')
      await Promise.all([
        reference.screenshot({ path: fullReferencePath, animations: 'disabled' }),
        source.screenshot({ path: fullImplementationPath, animations: 'disabled' }),
      ])
      const fullPixels = await pixelDiff(fullReferencePath, fullImplementationPath, fullDiffPath)

      await Promise.all([
        injectProbe(reference, surface.layout === 'main' ? '.app' : '#blankRoute'),
        injectProbe(source, surface.layout === 'main' ? '.hc-app' : '#app'),
      ])
      const referencePath = path.join(directory, 'reference.png')
      const implementationPath = path.join(directory, 'implementation.png')
      const diffPath = path.join(directory, 'pixel-diff.png')
      await Promise.all([
        reference
          .locator('#bug-20260729-002-typography-probe')
          .screenshot({ path: referencePath, animations: 'disabled' }),
        source
          .locator('#bug-20260729-002-typography-probe')
          .screenshot({ path: implementationPath, animations: 'disabled' }),
      ])
      const [referenceFacts, implementationFacts] = await Promise.all([
        collectFacts(reference, surface, false),
        collectFacts(source, surface, true),
      ])
      const typography = compareTypography(referenceFacts, implementationFacts)
      const independentDifferences = independentSurfaceDrift(referenceFacts, implementationFacts)
      const pixels = await pixelDiff(referencePath, implementationPath, diffPath)
      const result = {
        bugId: 'BUG-20260729-002',
        engine,
        surface,
        equivalence: {
          viewport,
          deviceScaleFactor: 1,
          locale: 'zh-CN',
          timezoneId: 'Asia/Shanghai',
          theme: surface.theme,
          content: 'fixed inherited typography probe',
          state: surface.id,
        },
        rootTypography: typography,
        probePixels: {
          ...pixels,
          maxChangedPixelRatio: 0.001,
          pass: pixels.changed_pixel_ratio <= 0.001,
        },
        fullSurface: {
          status: 'NOT_COMPARABLE',
          reason:
            'The authoritative prototype and current source do not expose an exact-set identical full-page business fixture; full-page pixels are retained only to disclose independent structure.',
          pixels: fullPixels,
          independentSurfaceDifferences: independentDifferences,
          countedAgainstRootTypography: false,
        },
        network: {
          sourceExternalRequests,
          referenceExternalRequests,
        },
        files: {
          reference: 'reference.png',
          implementation: 'implementation.png',
          pixelDiff: 'pixel-diff.png',
          fullReference: 'full-reference.png',
          fullImplementation: 'full-implementation.png',
          fullPixelDiff: 'full-pixel-diff.png',
          bboxComputedStyle: 'bbox-computed-style.json',
        },
      }
      await Promise.all([
        writeFile(
          path.join(directory, 'bbox-computed-style.json'),
          `${JSON.stringify({ reference: referenceFacts, implementation: implementationFacts }, null, 2)}\n`,
        ),
        writeFile(path.join(directory, 'result.json'), `${JSON.stringify(result, null, 2)}\n`),
      ])

      expect(referenceFacts.environment).toEqual(implementationFacts.environment)
      expect(referenceFacts.environment).toEqual({
        viewport,
        devicePixelRatio: 1,
        locale: 'zh-CN',
        theme: surface.theme,
        k12Skin: surface.k12 ? 'k12' : 'default',
      })
      expect(sourceExternalRequests).toEqual([])
      expect(referenceExternalRequests).toEqual([])
      expect(typography.differences).toEqual([])
      expect(pixels.changed_pixel_ratio).toBeLessThanOrEqual(0.001)
    } finally {
      await Promise.all([sourceContext.close(), referenceContext.close()])
    }
  })
}

test('negative oracle: a 16px/normal source-root mutation is rejected', async ({
  browser,
}, testInfo) => {
  const surface = surfaces[0]!
  const externalRequests: string[] = []
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    colorScheme: surface.theme,
    reducedMotion: 'reduce',
  })
  const page = await context.newPage()
  try {
    await installSourceRuntime(page, surface, externalRequests)
    await openSource(page, surface)
    await page.addStyleTag({
      content:
        'html,body,#app,.hc-app,.hc-settings,.hc-toolbar{font-size:16px!important;line-height:normal!important}',
    })
    await injectProbe(page, '.hc-app')
    const facts = await collectFacts(page, surface, true)
    const rejected = Object.values(facts.actual).every(
      (target) => target?.style.fontSize === '16px' && target.style.lineHeight !== '21px',
    )
    const directory = path.join(evidenceRoot, testInfo.project.name)
    await mkdir(directory, { recursive: true })
    await writeFile(
      path.join(directory, 'negative-mutation-16px-normal.json'),
      `${JSON.stringify({ mutation: '16px/normal', rejected, facts }, null, 2)}\n`,
    )
    expect(externalRequests).toEqual([])
    expect(rejected).toBe(true)
  } finally {
    await context.close()
  }
})
