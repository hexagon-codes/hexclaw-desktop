import { expect, test, type Page, type Route, type TestInfo } from '@playwright/test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const REFERENCE_URL = process.env.HEX_UI_REFERENCE_URL?.trim() || 'http://127.0.0.1:16070/app.html'
const SOURCE_URL = process.env.HEX_UI_SOURCE_URL?.trim() || 'http://127.0.0.1:16061'
const EVIDENCE_ROOT = path.resolve('test-results/branch-ui-fidelity/background-matrix')

type PrototypeSwitch =
  | { kind: 'segment'; set: 'kn' | 'au' | 'in'; index: number }
  | { kind: 'connection'; index: number }

interface SelectorTriplet {
  pageRoot: string
  toolbar: string
  content: string
}

interface RouteSurface {
  id: string
  route: string
  prototypePane:
    | 'chat'
    | 'agents'
    | 'knowledge'
    | 'automation'
    | 'channels'
    | 'integration'
    | 'logs'
    | 'settings'
  prototypeSwitch?: PrototypeSwitch
  reference: SelectorTriplet
  implementation: SelectorTriplet
}

interface ShellLayerCandidate {
  id: string
  selector: string
  pseudo?: '::before' | '::after'
}

interface BackgroundSnapshot {
  selector: string
  count: number
  tag: string
  className: string
  rect: {
    x: number
    y: number
    width: number
    height: number
  }
  style: {
    backgroundColor: string
    backgroundImage: string
    backgroundPosition: string
    backgroundSize: string
    backgroundRepeat: string
    backgroundBlendMode: string
    mixBlendMode: string
    backdropFilter: string
    opacity: string
  }
  tokens: {
    bgMain: string
    bgPanel: string
    bgGradient: string
  }
}

interface ShellLayerSnapshot {
  id: string
  selector: string
  pseudo?: '::before' | '::after'
  found: boolean
  active: boolean
  kind: 'texture' | 'glow' | 'other' | 'none'
  hostRect?: {
    x: number
    y: number
    width: number
    height: number
  }
  style?: {
    content: string
    display: string
    visibility: string
    opacity: string
    backgroundColor: string
    backgroundImage: string
    backgroundPosition: string
    backgroundSize: string
    backgroundRepeat: string
    backgroundBlendMode: string
    mixBlendMode: string
    position: string
    inset: string
    top: string
    right: string
    bottom: string
    left: string
    width: string
    height: string
    zIndex: string
  }
}

const commonReference = (pane: RouteSurface['prototypePane']): SelectorTriplet => ({
  pageRoot: `.screen[data-pane="${pane}"]`,
  toolbar: `.screen[data-pane="${pane}"] > .tbar`,
  content: `.screen[data-pane="${pane}"] > .content`,
})

const commonImplementation = (content: string, toolbar = '.hc-toolbar'): SelectorTriplet => ({
  pageRoot: '.hc-app__view > :first-child',
  toolbar,
  content,
})

const surfaces: RouteSurface[] = [
  {
    id: 'chat',
    route: '/chat',
    prototypePane: 'chat',
    reference: {
      pageRoot: '.screen[data-pane="chat"] .chat',
      toolbar: '.screen[data-pane="chat"] .chat-top',
      content: '.screen[data-pane="chat"] .chat-main',
    },
    implementation: commonImplementation('.hc-chat__main', '.hc-chat__toolbar'),
  },
  {
    id: 'agents',
    route: '/agents',
    prototypePane: 'agents',
    reference: commonReference('agents'),
    implementation: commonImplementation('.hc-agents__content'),
  },
  {
    id: 'knowledge-documents',
    route: '/knowledge',
    prototypePane: 'knowledge',
    prototypeSwitch: { kind: 'segment', set: 'kn', index: 0 },
    reference: commonReference('knowledge'),
    implementation: commonImplementation('.hc-page-shell__content'),
  },
  {
    id: 'knowledge-memory',
    route: '/knowledge/memory',
    prototypePane: 'knowledge',
    prototypeSwitch: { kind: 'segment', set: 'kn', index: 1 },
    reference: commonReference('knowledge'),
    implementation: commonImplementation('.hc-page-shell__content'),
  },
  {
    id: 'automation-tasks',
    route: '/automation',
    prototypePane: 'automation',
    prototypeSwitch: { kind: 'segment', set: 'au', index: 0 },
    reference: commonReference('automation'),
    implementation: commonImplementation('.hc-page-shell__content'),
  },
  {
    id: 'automation-webhooks',
    route: '/automation/webhooks',
    prototypePane: 'automation',
    prototypeSwitch: { kind: 'segment', set: 'au', index: 1 },
    reference: commonReference('automation'),
    implementation: commonImplementation('.hc-page-shell__content'),
  },
  {
    id: 'automation-workflows',
    route: '/automation/workflows',
    prototypePane: 'automation',
    prototypeSwitch: { kind: 'segment', set: 'au', index: 2 },
    reference: commonReference('automation'),
    implementation: commonImplementation('.hc-page-shell__content'),
  },
  {
    id: 'channels-accounts',
    route: '/channels',
    prototypePane: 'channels',
    prototypeSwitch: { kind: 'connection', index: 0 },
    reference: commonReference('channels'),
    implementation: commonImplementation('.hc-conn-panel'),
  },
  {
    id: 'channels-connectors',
    route: '/channels',
    prototypePane: 'channels',
    prototypeSwitch: { kind: 'connection', index: 1 },
    reference: commonReference('channels'),
    implementation: commonImplementation('.hc-conn-panel'),
  },
  {
    id: 'integration-skills',
    route: '/integration',
    prototypePane: 'integration',
    prototypeSwitch: { kind: 'segment', set: 'in', index: 0 },
    reference: commonReference('integration'),
    implementation: commonImplementation('.hc-page-shell__content'),
  },
  {
    id: 'integration-mcp',
    route: '/integration/mcp',
    prototypePane: 'integration',
    prototypeSwitch: { kind: 'segment', set: 'in', index: 1 },
    reference: commonReference('integration'),
    implementation: commonImplementation('.hc-page-shell__content'),
  },
  {
    id: 'integration-prompts',
    route: '/integration/prompts',
    prototypePane: 'integration',
    prototypeSwitch: { kind: 'segment', set: 'in', index: 2 },
    reference: commonReference('integration'),
    implementation: commonImplementation('.hc-page-shell__content'),
  },
  {
    id: 'logs',
    route: '/logs',
    prototypePane: 'logs',
    reference: commonReference('logs'),
    implementation: commonImplementation('.hc-logs__stream'),
  },
  {
    id: 'settings',
    route: '/settings',
    prototypePane: 'settings',
    reference: commonReference('settings'),
    implementation: commonImplementation('.hc-settings__content'),
  },
]

const referenceShellCandidates: ShellLayerCandidate[] = [
  { id: 'reference-app-before', selector: '.app', pseudo: '::before' },
  { id: 'reference-app-after', selector: '.app', pseudo: '::after' },
  { id: 'reference-main-before', selector: '.mn', pseudo: '::before' },
  { id: 'reference-main-after', selector: '.mn', pseudo: '::after' },
  { id: 'reference-main-glow', selector: '.mn-glow' },
  { id: 'reference-main-glow-before', selector: '.mn-glow', pseudo: '::before' },
  { id: 'reference-main-glow-after', selector: '.mn-glow', pseudo: '::after' },
]

const implementationShellCandidates: ShellLayerCandidate[] = [
  { id: 'implementation-app-before', selector: '.hc-app', pseudo: '::before' },
  { id: 'implementation-app-after', selector: '.hc-app', pseudo: '::after' },
  {
    id: 'implementation-body-before',
    selector: '.hc-app__body',
    pseudo: '::before',
  },
  {
    id: 'implementation-body-after',
    selector: '.hc-app__body',
    pseudo: '::after',
  },
  {
    id: 'implementation-content-before',
    selector: '.hc-app__content',
    pseudo: '::before',
  },
  {
    id: 'implementation-content-after',
    selector: '.hc-app__content',
    pseudo: '::after',
  },
  { id: 'implementation-main-glow', selector: '.hc-app__glow' },
  {
    id: 'implementation-main-glow-before',
    selector: '.hc-app__glow',
    pseudo: '::before',
  },
  {
    id: 'implementation-main-glow-after',
    selector: '.hc-app__glow',
    pseudo: '::after',
  },
]

function fulfillJSON(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

function runtimeFixture(apiPath: string, method: string): unknown {
  if (apiPath === '/health') return { status: 'ok' }
  if (apiPath === '/api/v1/config/llm') {
    return {
      default: '',
      providers: {},
      routing: { enabled: false, strategy: 'cost-aware' },
      cache: { enabled: false },
    }
  }
  if (apiPath === '/api/v1/config') {
    return {
      general: { language: 'zh-CN', welcomeCompleted: true },
      knowledge: { enabled: true },
      security: {},
      sandbox: { network_enabled: true },
      llm: {
        default: '',
        providers: {},
        routing: { enabled: false, strategy: 'cost-aware' },
        cache: { enabled: false },
      },
    }
  }
  if (apiPath === '/api/v1/config/memory') {
    return {
      enabled: true,
      auto_memory: 'inline',
      recall_min_score: 0.3,
      active_recall: true,
      profile: true,
      profile_interval_mins: 1440,
    }
  }
  if (apiPath === '/api/v1/assistant/soul') {
    return { system_prompt: '', is_custom: false, default_prompt: '' }
  }
  if (apiPath === '/api/v1/agents' && method === 'GET') {
    return { agents: [], total: 0, default: '' }
  }
  if (apiPath === '/api/v1/agents/rules') return { rules: [], total: 0 }
  if (apiPath === '/api/v1/roles') return { roles: [] }
  if (apiPath === '/api/v1/skills') return { skills: [], total: 0, dir: '' }
  if (apiPath === '/api/v1/prompts' || apiPath === '/api/v1/prompts/all') {
    return { prompts: [], total: 0 }
  }
  if (apiPath === '/api/v1/mcp/tools') return { tools: [], total: 0 }
  if (apiPath === '/api/v1/mcp/servers') return { servers: [], total: 0 }
  if (apiPath === '/api/v1/mcp/status') {
    return { statuses: {}, servers: [], total: 0 }
  }
  if (apiPath === '/api/v1/clawhub/search') {
    return { skills: [], total: 0 }
  }
  if (apiPath === '/api/v1/knowledge/documents') {
    return { documents: [], total: 0, sources: [] }
  }
  if (apiPath === '/api/v1/knowledge/config') {
    return {
      rerank_enabled: false,
      rerank_model: '',
      query_expansion: false,
      contextual: false,
      min_score: 0.2,
      candidate_k: 50,
    }
  }
  if (apiPath === '/api/v1/knowledge/embedding-status') {
    return {
      enabled: true,
      configured: false,
      local: false,
      ready: false,
      pulling: false,
    }
  }
  if (apiPath === '/api/v1/memory') {
    return {
      entries: [],
      summary: '',
      capacity: { used: 0, max: 500 },
      total: 0,
      has_more: false,
    }
  }
  if (apiPath === '/api/v1/cronjob' && method === 'POST') {
    return {
      action: 'list',
      jobs: [],
      total: 0,
      quota: { used: 0, limit: 100 },
    }
  }
  if (apiPath === '/api/v1/autonomy/summary') {
    return {
      profile: 'balanced',
      counts: { tasks: 0, ready: 0, pending: 0, grants: 0 },
      pending: [],
      tasks: [],
    }
  }
  if (apiPath === '/api/v1/webhooks') {
    return { webhooks: [], k12_bindings: [], total: 0 }
  }
  if (apiPath === '/api/v1/canvas/workflows') return { workflows: [] }
  if (apiPath === '/api/v1/canvas/panels') return { panels: [], total: 0 }
  if (apiPath === '/api/v1/logs') return { logs: [], total: 0 }
  if (apiPath === '/api/v1/logs/stats') {
    return { total: 0, by_level: {}, by_source: {}, by_domain: {} }
  }
  if (apiPath === '/api/v1/sessions') {
    return { sessions: [], total: 0 }
  }
  if (apiPath === '/api/v1/streams/active') return { streams: [], total: 0 }
  if (apiPath.startsWith('/api/v1/')) return { items: [], total: 0 }
  return {}
}

async function installSourceFixture(page: Page) {
  await page.addInitScript(() => {
    localStorage.clear()
    sessionStorage.clear()
    localStorage.setItem('hc-theme', 'light')
    localStorage.setItem(
      'app_config',
      JSON.stringify({
        llm: {
          providers: [],
          defaultModel: '',
          defaultProviderId: '',
          routing: { enabled: false, strategy: 'cost-aware' },
        },
        security: {
          gateway_enabled: true,
          injection_detection: true,
          pii_filter: false,
          content_filter: true,
          rate_limit_rpm: 60,
        },
        general: {
          language: 'zh-CN',
          log_level: 'info',
          data_dir: '',
          auto_start: false,
          defaultAgentRole: '',
          welcomeCompleted: true,
        },
        notification: {
          system_enabled: true,
          sound_enabled: false,
          agent_complete: true,
        },
        mcp: { default_protocol: 'stdio' },
        memory: { enabled: true },
        sandbox: { network_enabled: true },
      }),
    )
    sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
    localStorage.setItem('hexclaw:welcomeRedirectDone', '1')
  })

  await page.route('http://localhost:11434/**', (route) => {
    const pathname = new URL(route.request().url()).pathname
    if (pathname === '/api/version') return fulfillJSON(route, { version: 'fixture' })
    if (pathname === '/api/ps') return fulfillJSON(route, { models: [] })
    return fulfillJSON(route, { models: [] })
  })

  await page.route('**/_hexclaw/**', (route) => {
    const requestURL = new URL(route.request().url())
    const apiPath = requestURL.pathname.replace(/^\/_hexclaw/, '')
    return fulfillJSON(route, runtimeFixture(apiPath, route.request().method()))
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

async function openReference(page: Page, surface: RouteSurface) {
  await page.goto(REFERENCE_URL, { waitUntil: 'domcontentloaded' })
  await page.evaluate(
    ({ pane, paneSwitch }) => {
      const nav = document.querySelector<HTMLElement>(`.sb-item[data-screen="${pane}"]`)
      if (!nav) throw new Error(`prototype navigation pane is missing: ${pane}`)
      nav.click()

      if (!paneSwitch) return
      const api = window as typeof window & {
        seg?: (set: string, index: number) => void
        ctab?: (index: number) => void
      }
      if (paneSwitch.kind === 'segment') {
        if (!api.seg) throw new Error('prototype segment API is unavailable')
        api.seg(paneSwitch.set, paneSwitch.index)
      } else {
        if (!api.ctab) throw new Error('prototype connection tab API is unavailable')
        api.ctab(paneSwitch.index)
      }
    },
    { pane: surface.prototypePane, paneSwitch: surface.prototypeSwitch },
  )
  await expect(page.locator(`.screen[data-pane="${surface.prototypePane}"].on`)).toBeVisible()
}

async function openSource(page: Page, surface: RouteSurface) {
  await page.goto(`${SOURCE_URL}${surface.route}`, {
    waitUntil: 'domcontentloaded',
  })
  await expect(page.locator(surface.implementation.pageRoot).first()).toBeVisible()
  await page
    .locator('#splash-screen')
    .waitFor({ state: 'detached', timeout: 10_000 })
    .catch(() => undefined)

  if (surface.id === 'channels-connectors') {
    await page.getByTestId('segmented-connectors').click()
    await expect(page.getByTestId('segmented-connectors')).toHaveAttribute('aria-selected', 'true')
  }
}

async function backgroundSnapshot(page: Page, selector: string): Promise<BackgroundSnapshot> {
  const locator = page.locator(selector)
  await expect(locator.first(), `missing background target: ${selector}`).toBeVisible()
  return locator.evaluateAll((elements, targetSelector) => {
    const element = elements[0] as HTMLElement
    const style = getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    return {
      selector: targetSelector,
      count: elements.length,
      tag: element.tagName.toLowerCase(),
      className: element.className,
      rect: {
        x: Number(rect.x.toFixed(2)),
        y: Number(rect.y.toFixed(2)),
        width: Number(rect.width.toFixed(2)),
        height: Number(rect.height.toFixed(2)),
      },
      style: {
        backgroundColor: style.backgroundColor,
        backgroundImage: style.backgroundImage,
        backgroundPosition: style.backgroundPosition,
        backgroundSize: style.backgroundSize,
        backgroundRepeat: style.backgroundRepeat,
        backgroundBlendMode: style.backgroundBlendMode,
        mixBlendMode: style.mixBlendMode,
        backdropFilter: style.backdropFilter,
        opacity: style.opacity,
      },
      tokens: {
        bgMain: style.getPropertyValue('--hc-bg-main').trim(),
        bgPanel: style.getPropertyValue('--hc-bg-panel').trim(),
        bgGradient: style.getPropertyValue('--hc-bg-gradient').trim(),
      },
    }
  }, selector)
}

async function backgroundTriplet(page: Page, selectors: SelectorTriplet) {
  const [pageRoot, toolbar, content] = await Promise.all([
    backgroundSnapshot(page, selectors.pageRoot),
    backgroundSnapshot(page, selectors.toolbar),
    backgroundSnapshot(page, selectors.content),
  ])
  return { pageRoot, toolbar, content }
}

async function shellLayers(
  page: Page,
  candidates: ShellLayerCandidate[],
): Promise<ShellLayerSnapshot[]> {
  return page.evaluate((layerCandidates) => {
    return layerCandidates.map((candidate) => {
      const element = document.querySelector<HTMLElement>(candidate.selector)
      if (!element) {
        return {
          ...candidate,
          found: false,
          active: false,
          kind: 'none' as const,
        }
      }

      const style = getComputedStyle(element, candidate.pseudo)
      const backgroundImage = style.backgroundImage
      const pseudoIsPainted =
        !candidate.pseudo ||
        (style.content !== 'none' && style.content !== 'normal' && style.content !== '')
      const visible =
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity || '1') > 0
      const active = pseudoIsPainted && visible && backgroundImage !== 'none'
      const kind = backgroundImage.includes('radial-gradient')
        ? ('glow' as const)
        : backgroundImage.includes('image/svg+xml')
          ? ('texture' as const)
          : backgroundImage === 'none'
            ? ('none' as const)
            : ('other' as const)
      const rect = element.getBoundingClientRect()

      return {
        ...candidate,
        found: true,
        active,
        kind,
        hostRect: {
          x: Number(rect.x.toFixed(2)),
          y: Number(rect.y.toFixed(2)),
          width: Number(rect.width.toFixed(2)),
          height: Number(rect.height.toFixed(2)),
        },
        style: {
          content: style.content,
          display: style.display,
          visibility: style.visibility,
          opacity: style.opacity,
          backgroundColor: style.backgroundColor,
          backgroundImage,
          backgroundPosition: style.backgroundPosition,
          backgroundSize: style.backgroundSize,
          backgroundRepeat: style.backgroundRepeat,
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

function activeLayerIDs(layers: ShellLayerSnapshot[]) {
  return layers.filter((layer) => layer.active).map((layer) => layer.id)
}

function layerOfKind(layers: ShellLayerSnapshot[], kind: 'texture' | 'glow') {
  return layers.find((layer) => layer.active && layer.kind === kind)
}

function assertMatchingBackground(
  surface: RouteSurface,
  role: keyof SelectorTriplet,
  reference: BackgroundSnapshot,
  implementation: BackgroundSnapshot,
  evidencePath: string,
) {
  expect
    .soft(
      implementation.style.backgroundColor,
      `${surface.id} ${role} background-color drift; evidence=${evidencePath}`,
    )
    .toBe(reference.style.backgroundColor)
  expect
    .soft(
      implementation.style.backgroundImage,
      `${surface.id} ${role} background-image drift; evidence=${evidencePath}`,
    )
    .toBe(reference.style.backgroundImage)
}

async function captureRouteSurface(
  referencePage: Page,
  implementationPage: Page,
  surface: RouteSurface,
  testInfo: TestInfo,
) {
  await openReference(referencePage, surface)
  await openSource(implementationPage, surface)
  await freezeVisualState(referencePage)
  await freezeVisualState(implementationPage)

  const outputDir = path.join(EVIDENCE_ROOT, testInfo.project.name, surface.id)
  await mkdir(outputDir, { recursive: true })
  const referenceScreenshot = path.join(outputDir, 'reference.png')
  const implementationScreenshot = path.join(outputDir, 'current-source.png')
  const evidencePath = path.join(outputDir, 'background-evidence.json')

  await Promise.all([
    referencePage.screenshot({
      path: referenceScreenshot,
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
    }),
    implementationPage.screenshot({
      path: implementationScreenshot,
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
    }),
  ])

  const [
    referenceBackgrounds,
    implementationBackgrounds,
    referenceLayers,
    implementationLayers,
    referenceShellSurface,
    implementationShellSurface,
  ] = await Promise.all([
    backgroundTriplet(referencePage, surface.reference),
    backgroundTriplet(implementationPage, surface.implementation),
    shellLayers(referencePage, referenceShellCandidates),
    shellLayers(implementationPage, implementationShellCandidates),
    backgroundSnapshot(referencePage, '.mn'),
    backgroundSnapshot(implementationPage, '.hc-app__content'),
  ])

  const evidence = {
    surface: surface.id,
    route: surface.route,
    viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
    locale: 'zh-CN',
    timezone: 'Asia/Shanghai',
    urls: {
      reference: referencePage.url(),
      currentSource: implementationPage.url(),
    },
    screenshots: {
      reference: referenceScreenshot,
      currentSource: implementationScreenshot,
    },
    comparison: {
      shellLayers: {
        status: 'COMPARABLE',
        rule: 'The prototype and current source must expose the same one-texture/one-glow shell exact-set.',
      },
      backgroundStyles: {
        status: 'COMPARABLE',
        rule: 'Computed background-color/background-image are compared for pageRoot, toolbar and content.',
      },
      contentPixels: {
        status: 'NOT_COMPARABLE',
        reason:
          'Prototype sample content and current-source API fixture are intentionally different; no content pixel assertion is made.',
      },
    },
    backgrounds: {
      reference: referenceBackgrounds,
      currentSource: implementationBackgrounds,
      shellSurface: {
        reference: referenceShellSurface,
        currentSource: implementationShellSurface,
      },
    },
    shellLayers: {
      reference: referenceLayers,
      currentSource: implementationLayers,
      activeExactSet: {
        reference: activeLayerIDs(referenceLayers),
        currentSource: activeLayerIDs(implementationLayers),
      },
    },
  }
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)

  await testInfo.attach(`${surface.id}-reference`, {
    body: await readFile(referenceScreenshot),
    contentType: 'image/png',
  })
  await testInfo.attach(`${surface.id}-current-source`, {
    body: await readFile(implementationScreenshot),
    contentType: 'image/png',
  })
  await testInfo.attach(`${surface.id}-background-evidence`, {
    body: await readFile(evidencePath),
    contentType: 'application/json',
  })

  expect
    .soft(
      activeLayerIDs(referenceLayers),
      `${surface.id} prototype shell exact-set changed; evidence=${evidencePath}`,
    )
    .toEqual(['reference-app-after', 'reference-main-glow'])
  expect
    .soft(
      activeLayerIDs(implementationLayers),
      `${surface.id} current-source has an extra/missing shell texture or glow; evidence=${evidencePath}`,
    )
    .toEqual(['implementation-body-after', 'implementation-main-glow'])

  const referenceTexture = layerOfKind(referenceLayers, 'texture')
  const implementationTexture = layerOfKind(implementationLayers, 'texture')
  const referenceGlow = layerOfKind(referenceLayers, 'glow')
  const implementationGlow = layerOfKind(implementationLayers, 'glow')

  expect
    .soft(
      implementationTexture?.style?.backgroundImage,
      `${surface.id} shell texture paint differs; evidence=${evidencePath}`,
    )
    .toBe(referenceTexture?.style?.backgroundImage)
  expect
    .soft(
      implementationTexture?.style?.backgroundSize,
      `${surface.id} shell texture size differs; evidence=${evidencePath}`,
    )
    .toBe(referenceTexture?.style?.backgroundSize)
  expect
    .soft(
      implementationTexture?.style?.mixBlendMode,
      `${surface.id} shell texture blend mode differs; evidence=${evidencePath}`,
    )
    .toBe(referenceTexture?.style?.mixBlendMode)
  expect
    .soft(
      implementationGlow?.style?.backgroundImage,
      `${surface.id} shell glow paint differs; evidence=${evidencePath}`,
    )
    .toBe(referenceGlow?.style?.backgroundImage)
  expect
    .soft(
      implementationGlow?.style?.height,
      `${surface.id} shell glow height differs; evidence=${evidencePath}`,
    )
    .toBe(referenceGlow?.style?.height)

  assertMatchingBackground(
    surface,
    'pageRoot',
    referenceBackgrounds.pageRoot,
    implementationBackgrounds.pageRoot,
    evidencePath,
  )
  assertMatchingBackground(
    surface,
    'toolbar',
    referenceBackgrounds.toolbar,
    implementationBackgrounds.toolbar,
    evidencePath,
  )
  assertMatchingBackground(
    surface,
    'content',
    referenceBackgrounds.content,
    implementationBackgrounds.content,
    evidencePath,
  )
  assertMatchingBackground(
    surface,
    'pageRoot',
    referenceShellSurface,
    implementationShellSurface,
    evidencePath,
  )
}

test.describe('all main routes — prototype/current-source shell background matrix', () => {
  for (const surface of surfaces) {
    test(`${surface.id}: shell/background is comparable; content pixels are not`, async ({
      browser,
    }, testInfo) => {
      const referencePage = await browser.newPage()
      const implementationPage = await browser.newPage()
      await installSourceFixture(implementationPage)
      try {
        await captureRouteSurface(referencePage, implementationPage, surface, testInfo)
      } finally {
        await Promise.all([referencePage.close(), implementationPage.close()])
      }
    })
  }
})
