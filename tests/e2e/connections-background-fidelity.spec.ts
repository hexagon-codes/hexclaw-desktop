import { expect, test, type Page, type Route, type TestInfo } from '@playwright/test'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const REFERENCE_URL = process.env.HEX_UI_REFERENCE_URL?.trim() || 'http://127.0.0.1:16070/app.html'
const IMPLEMENTATION_URL = process.env.HEX_UI_IMPLEMENTATION_URL?.trim() || 'http://127.0.0.1:16061'
const EVIDENCE_ROOT = path.resolve(
  'test-results/branch-ui-fidelity/evidence/connections-background',
)
const PIXEL_DIFF_TOOL = path.resolve('tests/e2e/tools/visual_pixel_diff.py')
const PIXEL_SAMPLE_TOOL = path.resolve('tests/e2e/tools/visual_pixel_samples.py')
const SAMPLE_Y = [38, 80, 120, 180, 220, 257] as const

interface ShellLayerCandidate {
  name: string
  selector: string
  pseudo?: '::before' | '::after'
}

interface LayerEvidence extends ShellLayerCandidate {
  found: boolean
  active: boolean
  kind: 'texture' | 'glow' | 'none'
  elementRect?: RectEvidence
  paintRect?: RectEvidence
  style?: Record<string, string>
}

interface RectEvidence {
  x: number
  y: number
  width: number
  height: number
}

interface PixelSample {
  y: number
  rgb: number[]
  rgba: number[]
}

interface PixelSampleReport {
  width: number
  height: number
  x: number
  samples: PixelSample[]
}

const referenceShellLayers: ShellLayerCandidate[] = [
  { name: 'prototype-texture', selector: '.app', pseudo: '::after' },
  { name: 'prototype-glow', selector: '.mn-glow' },
]

const implementationShellLayers: ShellLayerCandidate[] = [
  { name: 'global-texture', selector: '.hc-app', pseudo: '::after' },
  { name: 'layout-texture', selector: '.hc-app__body', pseudo: '::after' },
  { name: 'global-glow', selector: '.hc-app__content', pseudo: '::before' },
  { name: 'layout-glow', selector: '.hc-app__glow' },
]

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

async function installImplementationFixture(page: Page) {
  await page.addInitScript(() => {
    localStorage.clear()
    sessionStorage.clear()
    localStorage.setItem('hexclaw:welcomeRedirectDone', '1')
    sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
    localStorage.setItem('hc-theme', 'light')

    const callbacks = new Map<number, (payload: unknown) => unknown>()
    let nextCallbackID = 1

    const tauriWindow = window as typeof window & {
      __TAURI_INTERNALS__?: {
        invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown>
        transformCallback?: (callback?: (payload: unknown) => unknown, once?: boolean) => number
        unregisterCallback?: (id: number) => void
        runCallback?: (id: number, payload: unknown) => unknown
        callbacks?: Map<number, (payload: unknown) => unknown>
      }
      __TAURI_EVENT_PLUGIN_INTERNALS__?: {
        unregisterListener?: (_event: string, id: number) => void
      }
    }

    const unregisterCallback = (id: number) => callbacks.delete(id)
    const transformCallback = (callback?: (payload: unknown) => unknown, once = false) => {
      const id = nextCallbackID++
      callbacks.set(id, (payload) => {
        if (once) unregisterCallback(id)
        return callback?.(payload)
      })
      return id
    }

    tauriWindow.__TAURI_INTERNALS__ = {
      callbacks,
      transformCallback,
      unregisterCallback,
      runCallback: (id, payload) => callbacks.get(id)?.(payload),
      invoke: async (command, args = {}) => {
        if (command === 'check_engine_health') return true
        if (command === 'plugin:event|listen') return Number(args.handler ?? 0)
        if (command === 'plugin:event|unlisten') return null
        if (command === 'plugin:event|emit') return null
        if (command === 'proxy_api_request') {
          const apiPath = String(args.path ?? '')
          const response = await fetch(`/_hexclaw${apiPath}`, {
            method: String(args.method ?? 'GET'),
            body: typeof args.body === 'string' ? args.body : undefined,
            headers: { 'content-type': 'application/json' },
          })
          if (!response.ok) {
            throw new Error(`fixture request failed: ${response.status} ${apiPath}`)
          }
          return response.text()
        }
        return null
      },
    }
    tauriWindow.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener: (_event, id) => unregisterCallback(id),
    }
  })

  await page.route('http://localhost:11434/**', (route) =>
    json(route, { models: [], version: 'connections-background-fixture' }),
  )
  await page.route('**/_hexclaw/**', async (route) => {
    const request = route.request()
    const requestURL = new URL(request.url())
    const apiPath = requestURL.pathname.replace(/^\/_hexclaw/, '')
    const method = request.method()

    if (apiPath === '/health') return json(route, { status: 'healthy' })
    if (apiPath === '/api/v1/config' && method === 'GET') {
      return json(route, {
        general: { language: 'zh-CN', welcomeCompleted: true },
        knowledge: { enabled: true },
        llm: {
          default: '',
          providers: [],
          routing: { enabled: false },
          cache: { enabled: false },
        },
      })
    }
    if (apiPath === '/api/v1/config/llm' && method === 'GET') {
      return json(route, {
        default: '',
        providers: [],
        routing: { enabled: false },
        cache: { enabled: false },
      })
    }
    if (apiPath === '/api/v1/platforms/instances' && method === 'GET') {
      return json(route, {
        instances: [
          {
            id: 'fixture-feishu',
            provider: 'feishu',
            name: '飞书 · 日报机器人',
            enabled: true,
            status: 'running',
            config: {
              app_id: 'cli_a1b2_fixture',
              app_secret: 'fixture-redacted',
            },
            created_at: '2026-07-01T08:00:00+08:00',
          },
          {
            id: 'fixture-dingtalk',
            provider: 'dingtalk',
            name: '钉钉 · 我的辅导机器人',
            enabled: true,
            status: 'running',
            config: {
              app_key: 'ding_kf8_fixture',
              app_secret: 'fixture-redacted',
              robot_code: 'fixture-robot',
            },
            created_at: '2026-07-02T08:00:00+08:00',
          },
        ],
      })
    }
    if (apiPath === '/api/v1/platforms/instances/health' && method === 'GET') {
      return json(route, {
        instances: [
          {
            name: '飞书 · 日报机器人',
            provider: 'feishu',
            status: 'running',
            enabled: true,
          },
          {
            name: '钉钉 · 我的辅导机器人',
            provider: 'dingtalk',
            status: 'running',
            enabled: true,
          },
        ],
      })
    }
    if (apiPath === '/api/v1/cronjob' && method === 'POST') {
      return json(route, { action: 'list', jobs: [], total: 0 })
    }
    if (apiPath === '/api/v1/agents' && method === 'GET') {
      return json(route, {
        agents: [
          {
            name: 'default',
            display_name: '小蟹 · 默认助理',
            description: '连接页同态 fixture',
            provider: '',
            model: '',
            metadata: {},
          },
        ],
        total: 1,
        default: 'default',
      })
    }
    if (apiPath === '/api/v1/agents/rules') {
      return json(route, { rules: [], total: 0 })
    }
    if (apiPath === '/api/v1/roles') return json(route, { roles: [], total: 0 })
    if (apiPath === '/api/v1/skills') return json(route, { skills: [], total: 0 })
    if (apiPath === '/api/v1/streams/active') {
      return json(route, { streams: [], total: 0 })
    }
    if (apiPath.startsWith('/api/v1/')) {
      return json(route, { items: [], total: 0 })
    }
    return json(route, {})
  })
}

async function freezeVisualState(page: Page) {
  await page.addStyleTag({
    content: `
      *,
      *::before,
      *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
        caret-color: transparent !important;
      }
      html { scroll-behavior: auto !important; }
    `,
  })
  await page.evaluate(async () => {
    await document.fonts.ready
    window.scrollTo(0, 0)
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    )
  })
  await page.mouse.move(1, 1)
}

async function openReferenceConnections(page: Page) {
  await page.goto(REFERENCE_URL, { waitUntil: 'domcontentloaded' })
  await page.locator('.sb-item[data-screen="channels"]').click()
  await expect(page.locator('.screen.on[data-pane="channels"]')).toBeVisible()
  await expect(
    page.locator('.screen.on[data-pane="channels"] .cxview[data-cx="0"] .cxcards > .cxcard'),
  ).toHaveCount(2)
}

async function openImplementationConnections(page: Page) {
  await page.goto(`${IMPLEMENTATION_URL}/channels`, {
    waitUntil: 'domcontentloaded',
  })
  await expect(page.locator('.hc-connections')).toBeVisible()
  await expect(page.locator('.hc-cxcard')).toHaveCount(2)
  await expect(page.getByTestId('segmented-channels')).toContainText('通道与账号 2')
  await page.locator('#splash-screen').waitFor({ state: 'detached', timeout: 10_000 })
}

async function shellLayers(
  page: Page,
  candidates: ShellLayerCandidate[],
): Promise<LayerEvidence[]> {
  return page.evaluate((layerCandidates) => {
    const toRect = (rect: DOMRect): { x: number; y: number; width: number; height: number } => ({
      x: Number(rect.x.toFixed(2)),
      y: Number(rect.y.toFixed(2)),
      width: Number(rect.width.toFixed(2)),
      height: Number(rect.height.toFixed(2)),
    })
    const px = (value: string, fallback = 0) => {
      const parsed = Number.parseFloat(value)
      return Number.isFinite(parsed) ? parsed : fallback
    }

    return layerCandidates.map((candidate) => {
      const element = document.querySelector(candidate.selector)
      if (!element) {
        return {
          ...candidate,
          found: false,
          active: false,
          kind: 'none' as const,
        }
      }

      const node = element as HTMLElement
      const elementRect = node.getBoundingClientRect()
      const style = getComputedStyle(node, candidate.pseudo)
      const backgroundImage = style.backgroundImage
      const kind = backgroundImage.includes('image/svg+xml')
        ? ('texture' as const)
        : backgroundImage.includes('radial-gradient')
          ? ('glow' as const)
          : ('none' as const)
      const pseudoGenerated = candidate.pseudo ? style.content !== 'none' : true
      const active =
        pseudoGenerated &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity || '1') > 0 &&
        backgroundImage !== 'none'
      const width = px(style.width, elementRect.width)
      const height = px(style.height, elementRect.height)
      const paintRect = new DOMRect(
        elementRect.x + px(style.left),
        elementRect.y + px(style.top),
        width,
        height,
      )

      return {
        ...candidate,
        found: true,
        active,
        kind,
        elementRect: toRect(elementRect),
        paintRect: toRect(paintRect),
        style: {
          content: style.content,
          display: style.display,
          visibility: style.visibility,
          opacity: style.opacity,
          backgroundColor: style.backgroundColor,
          backgroundImage,
          backgroundSize: style.backgroundSize,
          backgroundBlendMode: style.backgroundBlendMode,
          mixBlendMode: style.mixBlendMode,
          position: style.position,
          inset: style.inset,
          top: style.top,
          right: style.right,
          bottom: style.bottom,
          left: style.left,
          width: style.width,
          height: style.height,
          zIndex: style.zIndex,
        },
      }
    })
  }, candidates)
}

async function rootSurface(page: Page, selectors: string[]) {
  return page.evaluate((surfaceSelectors) => {
    return surfaceSelectors.map((selector) => {
      const element = document.querySelector(selector)
      if (!element) return { selector, found: false }
      const node = element as HTMLElement
      const style = getComputedStyle(node)
      const rect = node.getBoundingClientRect()
      return {
        selector,
        found: true,
        rect: {
          x: Number(rect.x.toFixed(2)),
          y: Number(rect.y.toFixed(2)),
          width: Number(rect.width.toFixed(2)),
          height: Number(rect.height.toFixed(2)),
        },
        style: {
          backgroundColor: style.backgroundColor,
          backgroundImage: style.backgroundImage,
          opacity: style.opacity,
          visibility: style.visibility,
          display: style.display,
        },
      }
    })
  }, selectors)
}

async function mainCenterX(page: Page, selector: string) {
  const rect = await page.locator(selector).evaluate((element) => {
    const value = element.getBoundingClientRect()
    return {
      x: value.x,
      width: value.width,
    }
  })
  return Math.floor(rect.x + rect.width / 2)
}

async function samplePixels(screenshotPath: string, x: number): Promise<PixelSampleReport> {
  const { stdout } = await execFileAsync('python3', [
    PIXEL_SAMPLE_TOOL,
    screenshotPath,
    String(x),
    SAMPLE_Y.join(','),
  ])
  return JSON.parse(stdout.trim()) as PixelSampleReport
}

function activeOfKind(layers: LayerEvidence[], kind: 'texture' | 'glow') {
  return layers.filter((layer) => layer.active && layer.kind === kind)
}

function layerSemantics(layer: LayerEvidence) {
  return {
    backgroundImage: layer.style?.backgroundImage,
    backgroundSize: layer.style?.backgroundSize,
    mixBlendMode: layer.style?.mixBlendMode,
    y: layer.paintRect?.y,
    height: layer.paintRect?.height,
    zIndex: layer.style?.zIndex,
  }
}

async function attachFile(testInfo: TestInfo, name: string, filePath: string, contentType: string) {
  await testInfo.attach(name, {
    body: await readFile(filePath),
    contentType,
  })
}

test.describe('Connections shared shell/background fidelity', () => {
  test('prototype and source implementation have one-to-one shell layers and exact sampled pixels', async ({
    context,
  }, testInfo) => {
    const referencePage = await context.newPage()
    const implementationPage = await context.newPage()
    await installImplementationFixture(implementationPage)

    await openReferenceConnections(referencePage)
    await openImplementationConnections(implementationPage)
    await freezeVisualState(referencePage)
    await freezeVisualState(implementationPage)

    const outputDir = path.join(EVIDENCE_ROOT, testInfo.project.name)
    await mkdir(outputDir, { recursive: true })

    const contentReferencePath = path.join(outputDir, 'content-reference.png')
    const contentImplementationPath = path.join(outputDir, 'content-implementation.png')
    await referencePage.screenshot({
      path: contentReferencePath,
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
    })
    await implementationPage.screenshot({
      path: contentImplementationPath,
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
    })

    const [referenceLayers, implementationLayers, referenceRoots, implementationRoots] =
      await Promise.all([
        shellLayers(referencePage, referenceShellLayers),
        shellLayers(implementationPage, implementationShellLayers),
        rootSurface(referencePage, [
          '.screen.on[data-pane="channels"]',
          '.screen.on[data-pane="channels"] > .content',
        ]),
        rootSurface(implementationPage, ['.hc-connections', '.hc-conn-panel']),
      ])

    const state = {
      reference: {
        activePane: await referencePage.locator('.screen.on').getAttribute('data-pane'),
        activeConnectionTab: await referencePage.locator('[data-cxseg] > button.on').innerText(),
        cardCount: await referencePage
          .locator('.screen.on[data-pane="channels"] .cxview[data-cx="0"] .cxcards > .cxcard')
          .count(),
      },
      implementation: {
        route: new URL(implementationPage.url()).pathname,
        activeConnectionTab: await implementationPage.getByTestId('segmented-channels').innerText(),
        cardCount: await implementationPage.locator('.hc-cxcard').count(),
      },
      contentPixelComparison: {
        status: 'informational-only',
        reason:
          'The same high-level tab and two-card count are fixed, but prototype static copy and card internals are not the same fixture contract.',
      },
    }

    await referencePage.addStyleTag({
      content: '.screen.on[data-pane="channels"] > * { visibility: hidden !important; }',
    })
    await implementationPage.addStyleTag({
      content: '.hc-app__view { visibility: hidden !important; }',
    })
    await freezeVisualState(referencePage)
    await freezeVisualState(implementationPage)

    const shellReferencePath = path.join(outputDir, 'shell-reference.png')
    const shellImplementationPath = path.join(outputDir, 'shell-implementation.png')
    const shellDiffPath = path.join(outputDir, 'shell-pixel-diff.png')
    await referencePage.screenshot({
      path: shellReferencePath,
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
    })
    await implementationPage.screenshot({
      path: shellImplementationPath,
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
    })

    const referenceX = await mainCenterX(referencePage, '.mn')
    const implementationX = await mainCenterX(implementationPage, '.hc-app__content')
    const sharedSampleX = Math.round((referenceX + implementationX) / 2)
    const [referenceSamples, implementationSamples, shellDiffResult] = await Promise.all([
      samplePixels(shellReferencePath, sharedSampleX),
      samplePixels(shellImplementationPath, sharedSampleX),
      execFileAsync('python3', [
        PIXEL_DIFF_TOOL,
        shellReferencePath,
        shellImplementationPath,
        shellDiffPath,
        '0',
      ]),
    ])

    const shellDiff = JSON.parse(shellDiffResult.stdout.trim()) as Record<string, unknown>
    const evidencePath = path.join(outputDir, 'background-evidence.json')
    await writeFile(
      evidencePath,
      `${JSON.stringify(
        {
          viewport: referencePage.viewportSize(),
          deviceScaleFactor: 1,
          colorScheme: 'light',
          referenceURL: REFERENCE_URL,
          implementationURL: IMPLEMENTATION_URL,
          state,
          roots: {
            reference: referenceRoots,
            implementation: implementationRoots,
          },
          layers: {
            reference: referenceLayers,
            implementation: implementationLayers,
          },
          samples: {
            y: SAMPLE_Y,
            mainCenterX: {
              reference: referenceX,
              implementation: implementationX,
            },
            sharedSampleX,
            reference: referenceSamples,
            implementation: implementationSamples,
          },
          shellPixelDiff: {
            status: 'informational-only',
            reason:
              'The sidebar markup and main-column width differ; strict background evidence is the center-column sample set below.',
            ...shellDiff,
          },
        },
        null,
        2,
      )}\n`,
    )

    await Promise.all([
      attachFile(testInfo, 'connections-content-reference', contentReferencePath, 'image/png'),
      attachFile(
        testInfo,
        'connections-content-implementation',
        contentImplementationPath,
        'image/png',
      ),
      attachFile(testInfo, 'connections-shell-reference', shellReferencePath, 'image/png'),
      attachFile(
        testInfo,
        'connections-shell-implementation',
        shellImplementationPath,
        'image/png',
      ),
      attachFile(testInfo, 'connections-shell-pixel-diff', shellDiffPath, 'image/png'),
      attachFile(testInfo, 'connections-background-evidence', evidencePath, 'application/json'),
    ])

    for (const root of [...referenceRoots, ...implementationRoots]) {
      expect.soft(root.found, `${root.selector} exists`).toBe(true)
      if ('style' in root && root.style) {
        expect
          .soft(root.style.backgroundColor, `${root.selector} remains transparent`)
          .toBe('rgba(0, 0, 0, 0)')
        expect
          .soft(root.style.backgroundImage, `${root.selector} does not add a page-local background`)
          .toBe('none')
      }
    }

    for (const kind of ['texture', 'glow'] as const) {
      const expected = activeOfKind(referenceLayers, kind)
      const actual = activeOfKind(implementationLayers, kind)
      expect.soft(actual.length, `${kind} active layer exact-set count`).toBe(expected.length)
      if (expected.length === 1 && actual.length === 1) {
        expect
          .soft(layerSemantics(actual[0]!), `${kind} layer semantics`)
          .toEqual(layerSemantics(expected[0]!))
      }
    }

    const referenceRGB = referenceSamples.samples.map((sample) => sample.rgb)
    const implementationRGB = implementationSamples.samples.map((sample) => sample.rgb)
    expect
      .soft(implementationRGB, `main-center RGB at y=${SAMPLE_Y.join(',')}`)
      .toEqual(referenceRGB)
  })
})
