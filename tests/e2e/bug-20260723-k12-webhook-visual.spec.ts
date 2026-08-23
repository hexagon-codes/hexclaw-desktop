import { expect, test, type Page, type Route, type TestInfo } from '@playwright/test'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const FIXTURE_PATH = path.resolve('tests/fixtures/local/ui-bug-equivalence-v1.json')
const EVIDENCE_ROOT = path.resolve('test-results/bug-20260723-k12-webhook-visual/evidence')
const PIXEL_DIFF_TOOL = path.resolve('tests/e2e/tools/visual_pixel_diff.py')
const REFERENCE_URL =
  process.env.HEX_UI_REFERENCE_URL?.trim() || 'http://127.0.0.1:16070/app.html'
const SOURCE_URL =
  process.env.HEX_UI_SOURCE_URL?.trim() ||
  process.env.HEX_UI_IMPLEMENTATION_URL?.trim() ||
  'http://127.0.0.1:16061'
const PIXEL_THRESHOLD = 8
const MAX_CHANGED_PIXEL_RATIO = 0.001

type Fixture = {
  schema_version: number
  meta: {
    fixture_id: string
    locale: string
    theme: string
    viewport: { width: number; height: number }
    device_scale_factor: number
    timezone: string
    reduced_motion: boolean
  }
  source: {
    config: Record<string, unknown>
    agents: Array<Record<string, unknown>>
    k12_bindings: Array<Record<string, unknown>>
    k12_receipts?: Array<Record<string, unknown>>
    webhooks: Array<Record<string, unknown>>
  }
}

type GeometryTarget = {
  name: string
  selector: string
  all?: boolean
}

type Rect = {
  x: number
  y: number
  width: number
  height: number
}

type GeometryEntry = {
  index: number
  found: boolean
  visible: boolean
  text?: string
  rect?: Rect
  style?: Record<string, string>
}

type GeometryEvidence = {
  name: string
  selector: string
  entries: GeometryEntry[]
}

type K12Projection = {
  rootFound: boolean
  cardFound: boolean
  child: string
  status: string
  events: string[]
  replayWindowMinutes: number | null
  signature: string
  receiptFacts: string[]
  visibleTextDigest: string
  viewport: { width: number; height: number; devicePixelRatio: number }
}

type PixelDiff = {
  width: number
  height: number
  threshold: number
  changed_pixels: number
  total_pixels: number
  changed_pixel_ratio: number
  changed_bbox: number[] | null
}

const fixture = JSON.parse(await readFile(FIXTURE_PATH, 'utf8')) as Fixture
const sourceFixture = fixture.source
const k12Agent = sourceFixture.agents.find(
  (agent) => (agent.metadata as Record<string, unknown> | undefined)?.scenario === 'k12-tutor',
)
const k12Binding = sourceFixture.k12_bindings[0]

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

function sourceResponse(apiPath: string, method: string, requestURL: URL): unknown {
  if (apiPath === '/health') return { status: 'healthy' }
  if (apiPath === '/api/v1/config') return sourceFixture.config
  if (apiPath === '/api/v1/config/llm') {
    return (sourceFixture.config.llm as Record<string, unknown> | undefined) ?? {}
  }
  if (apiPath === '/api/v1/ollama/status') return { running: false, associated: false, models: [] }
  if (apiPath === '/api/v1/assistant/soul') {
    return { system_prompt: '', is_custom: false, default_prompt: '' }
  }
  if (apiPath === '/api/v1/agents' && method === 'GET') {
    return {
      agents: sourceFixture.agents,
      total: sourceFixture.agents.length,
      default: (sourceFixture.agents[0] as { name?: string } | undefined)?.name ?? '',
    }
  }
  if (apiPath === '/api/v1/agents/rules') return { rules: [], total: 0 }
  if (apiPath === '/api/v1/roles') return { roles: [], total: 0 }
  if (apiPath === '/api/v1/sessions') return { sessions: [], total: 0 }
  if (apiPath === '/api/v1/streams/active') return { streams: [], total: 0 }
  if (apiPath === '/api/v1/skills/disabled') return { disabled: [] }
  if (apiPath === '/api/v1/cronjob' && method === 'POST') {
    return { action: 'list', jobs: [], total: 0, quota: { used: 0, limit: 100 } }
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
    if (requestURL.searchParams.has('binding_name')) {
      return {
        receipts: sourceFixture.k12_receipts ?? [],
        total: sourceFixture.k12_receipts?.length ?? 0,
      }
    }
    if (requestURL.searchParams.has('agent_id')) {
      return { k12_bindings: sourceFixture.k12_bindings, total: sourceFixture.k12_bindings.length }
    }
    return { webhooks: sourceFixture.webhooks, total: sourceFixture.webhooks.length }
  }
  if (apiPath === '/api/v1/skills') return { skills: [], total: 0, dir: '' }
  if (apiPath.startsWith('/api/v1/')) return { items: [], total: 0 }
  return {}
}

async function installSourceFixture(page: Page, unknownRequests: Set<string>) {
  await page.addInitScript((config) => {
    localStorage.clear()
    sessionStorage.clear()
    localStorage.setItem('hc-theme', 'light')
    localStorage.setItem('hexclaw:welcomeRedirectDone', '1')
    sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
    localStorage.setItem('app_config', JSON.stringify(config))

    const callbacks = new Map<number, (payload: unknown) => unknown>()
    let nextCallbackID = 1
    const desktopWindow = window as typeof window & {
      __TAURI_INTERNALS__?: Record<string, unknown>
      __TAURI_EVENT_PLUGIN_INTERNALS__?: Record<string, unknown>
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
    desktopWindow.__TAURI_INTERNALS__ = {
      callbacks,
      transformCallback,
      unregisterCallback,
      runCallback: (id: number, payload: unknown) => callbacks.get(id)?.(payload),
      invoke: async (command: string, args: Record<string, unknown> = {}) => {
        if (command === 'check_engine_health') return true
        if (command === 'plugin:event|listen') return Number(args.handler ?? 0)
        if (command === 'plugin:event|unlisten' || command === 'plugin:event|emit') return null
        if (command === 'proxy_api_request') {
          const apiPath = String(args.path ?? '')
          const response = await fetch(`/_hexclaw${apiPath}`, {
            method: String(args.method ?? 'GET'),
            body: typeof args.body === 'string' ? args.body : undefined,
            headers: { 'content-type': 'application/json' },
          })
          if (!response.ok) throw new Error(`fixture request failed: ${response.status} ${apiPath}`)
          return response.text()
        }
        if (command === 'get_disabled_skills') return []
        return null
      },
    }
    desktopWindow.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener: (_event: string, id: number) => unregisterCallback(id),
    }
  }, sourceFixture.config)
  await page.addInitScript(() => {
    const fixedNow = Date.parse('2026-07-23T12:02:00.000Z')
    Date.now = () => fixedNow
  })

  await page.route('http://localhost:11434/**', (route) =>
    json(route, { models: [], version: fixture.meta.fixture_id }),
  )
  await page.route('**/_hexclaw/**', (route) => {
    const requestURL = new URL(route.request().url())
    const apiPath = requestURL.pathname.replace(/^\/_hexclaw/, '')
    const knownPrefixes = [
      '/health',
      '/api/v1/config',
      '/api/v1/ollama/status',
      '/api/v1/assistant/soul',
      '/api/v1/agents',
      '/api/v1/roles',
      '/api/v1/sessions',
      '/api/v1/streams/active',
      '/api/v1/skills',
      '/api/v1/cronjob',
      '/api/v1/autonomy/',
      '/api/v1/webhooks',
    ]
    if (!knownPrefixes.some((prefix) => apiPath.startsWith(prefix))) unknownRequests.add(apiPath)
    return json(route, sourceResponse(apiPath, route.request().method(), requestURL))
  })
}

async function openReference(page: Page) {
  await page.goto(REFERENCE_URL, { waitUntil: 'domcontentloaded' })
  const opened = await page.evaluate(() => {
    const api = window as typeof window & {
      showPane?: (pane: string) => void
      seg?: (group: string, index: number) => void
    }
    if (!api.showPane || !api.seg) return false
    api.showPane('automation')
    api.seg('au', 1)
    return true
  })
  expect(opened).toBe(true)
  await expect(page.locator('.screen[data-pane="automation"] [data-sub="au1"]')).toBeVisible()
  await expect(
    page.locator('.screen[data-pane="automation"] [data-sub="au1"] .k12-webhook-card'),
  ).toBeVisible()
}

async function openSource(page: Page) {
  await page.goto(`${SOURCE_URL.replace(/\/$/, '')}/automation/webhooks`, {
    waitUntil: 'domcontentloaded',
  })
  await page
    .locator('#splash-screen')
    .waitFor({ state: 'detached', timeout: 10_000 })
    .catch(() => undefined)
  await expect(page.getByTestId('k12-webhook-panel')).toBeVisible()
  await expect(page.getByTestId('k12-webhook-row-homework-hook')).toBeVisible()
  await page.waitForLoadState('networkidle').catch(() => undefined)
}

async function freezeVisualState(page: Page) {
  await page.addStyleTag({
    content:
      '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}html{scroll-behavior:auto!important}',
  })
  await page.evaluate(async () => {
    if (document.fonts?.ready) await document.fonts.ready
    window.scrollTo(0, 0)
  })
  await page.mouse.move(1, 1)
}

async function collectGeometry(page: Page, targets: GeometryTarget[]): Promise<GeometryEvidence[]> {
  return page.evaluate((definitions) => {
    const styleKeys = [
      'display',
      'position',
      'backgroundColor',
      'backgroundImage',
      'color',
      'borderTopWidth',
      'borderTopStyle',
      'borderTopColor',
      'borderRadius',
      'boxShadow',
      'padding',
      'gap',
      'fontSize',
      'fontWeight',
      'lineHeight',
      'overflowX',
      'overflowY',
    ] as const
    const visible = (element: Element) => {
      const node = element as HTMLElement
      const rect = node.getBoundingClientRect()
      const style = getComputedStyle(node)
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
    }
    return definitions.map((definition) => {
      const nodes = Array.from(document.querySelectorAll<HTMLElement>(definition.selector))
      const selected = definition.all ? nodes : nodes.slice(0, 1)
      return {
        name: definition.name,
        selector: definition.selector,
        entries: selected.map((node, index) => {
          const rect = node.getBoundingClientRect()
          const computed = getComputedStyle(node)
          const style = Object.fromEntries(styleKeys.map((key) => [key, computed[key]]))
          return {
            index,
            found: true,
            visible: visible(node),
            text: (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 600),
            rect: {
              x: Number(rect.x.toFixed(2)),
              y: Number(rect.y.toFixed(2)),
              width: Number(rect.width.toFixed(2)),
              height: Number(rect.height.toFixed(2)),
            },
            style,
          }
        }),
      }
    })
  }, targets)
}

async function collectProjection(page: Page, side: 'reference' | 'source'): Promise<K12Projection> {
  return page.evaluate((kind) => {
    const rootSelector =
      kind === 'reference'
        ? '.screen[data-pane="automation"] [data-sub="au1"]'
        : '[data-testid="k12-webhook-panel"]'
    const cardSelector = kind === 'reference' ? '.k12-webhook-card' : '[data-testid^="k12-webhook-row-"]'
    const root = document.querySelector<HTMLElement>(rootSelector)
    const card = root?.querySelector<HTMLElement>(cardSelector)
    const clean = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim()
    const cardText = clean(card?.innerText)
    const events = Array.from(
      card?.querySelectorAll<HTMLElement>(kind === 'reference' ? '.k12-webhook-event' : '.k12wh__event') ?? [],
    ).map((node) => clean(node.textContent))
    const status = clean(
      card?.querySelector<HTMLElement>(kind === 'reference' ? '.pill' : '.k12wh__status')?.textContent,
    )
    const child = clean(
      card?.querySelector<HTMLElement>(kind === 'reference' ? '.cxmeta' : '.k12wh__meta')?.textContent,
    )
    const signature = clean(
      card?.querySelector<HTMLElement>(kind === 'reference' ? '.k12-webhook-card .resource-row' : '.k12wh__signature')
        ?.textContent,
    )
    const replayMatch = signature.match(/重放窗口\s*(\d+)\s*分钟/)
    const receiptFacts =
      kind === 'reference'
        ? Array.from(card?.querySelectorAll<HTMLElement>('.task-meta') ?? [])
            .slice(1)
            .map((node) => clean(node.textContent))
        : Array.from(card?.querySelectorAll<HTMLElement>('.k12wh__receipt-facts') ?? []).map((node) =>
            clean(node.textContent),
          )
    return {
      rootFound: Boolean(root),
      cardFound: Boolean(card),
      child,
      status,
      events,
      replayWindowMinutes: replayMatch ? Number(replayMatch[1]) : null,
      signature,
      receiptFacts,
      visibleTextDigest: clean(root?.innerText).slice(0, 2400),
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
    }
  }, side)
}

async function createPixelDiff(
  referencePath: string,
  sourcePath: string,
  diffPath: string,
): Promise<PixelDiff> {
  const { stdout } = await execFileAsync('python3', [
    PIXEL_DIFF_TOOL,
    referencePath,
    sourcePath,
    diffPath,
    String(PIXEL_THRESHOLD),
  ])
  return JSON.parse(stdout.trim()) as PixelDiff
}

async function attach(testInfo: TestInfo, name: string, filePath: string, contentType: string) {
  await testInfo.attach(name, { body: await readFile(filePath), contentType })
}

function stateMismatches(reference: K12Projection, current: K12Projection): string[] {
  const expectedEvents = (k12Binding.allowed_events as string[] | undefined) ?? []
  const expectedReplayWindow = Number(k12Binding.replay_window_minutes)
  const mismatches: string[] = []
  if (!reference.rootFound || !current.rootFound) mismatches.push('manager root is missing')
  if (!reference.cardFound || !current.cardFound) mismatches.push('K12 binding card is missing')
  if (!reference.events.join('|').includes(expectedEvents.join('|'))) {
    mismatches.push('prototype event projection differs from the existing K12 fixture')
  }
  if (current.events.join('|') !== expectedEvents.join('|')) {
    mismatches.push('current event projection differs from the existing K12 fixture')
  }
  if (reference.replayWindowMinutes !== expectedReplayWindow) {
    mismatches.push('prototype replay-window projection differs from the existing K12 fixture')
  }
  if (current.replayWindowMinutes !== expectedReplayWindow) {
    mismatches.push('current replay-window projection differs from the existing K12 fixture')
  }
  if (!reference.status.includes('启用') || !current.status.includes('启用')) {
    mismatches.push('enabled status is not visible on both surfaces')
  }
  return mismatches
}

test.describe.configure({ mode: 'serial', timeout: 120_000 })

test('BUG-20260723-024 K12 Webhook manager paired visual evidence', async ({ browser }, testInfo) => {
  expect(fixture.schema_version).toBe(1)
  expect(fixture.meta.viewport).toEqual({ width: 1440, height: 900 })
  expect(k12Agent).toBeTruthy()
  expect(k12Binding).toBeTruthy()

  const context = await browser.newContext({
    viewport: fixture.meta.viewport,
    deviceScaleFactor: fixture.meta.device_scale_factor,
    locale: fixture.meta.locale,
    timezoneId: fixture.meta.timezone,
    colorScheme: fixture.meta.theme === 'dark' ? 'dark' : 'light',
    reducedMotion: fixture.meta.reduced_motion ? 'reduce' : 'no-preference',
  })
  const referencePage = await context.newPage()
  const sourcePage = await context.newPage()
  const unknownRequests = new Set<string>()
  const outputDir = path.join(EVIDENCE_ROOT, testInfo.project.name)
  await mkdir(outputDir, { recursive: true })

  const referencePath = path.join(outputDir, 'reference.png')
  const sourcePath = path.join(outputDir, 'current-source.png')
  const diffPath = path.join(outputDir, 'pixel-diff.png')
  const cardReferencePath = path.join(outputDir, 'k12-card-reference.png')
  const cardSourcePath = path.join(outputDir, 'k12-card-current-source.png')
  const cardDiffPath = path.join(outputDir, 'k12-card-pixel-diff.png')
  const geometryPath = path.join(outputDir, 'geometry.json')
  const reportPath = path.join(outputDir, 'gate-report.json')

  const referenceTargets: GeometryTarget[] = [
    { name: 'manager-root', selector: '.screen[data-pane="automation"] [data-sub="au1"]' },
    { name: 'k12-card', selector: '.screen[data-pane="automation"] .k12-webhook-card' },
    { name: 'signature-row', selector: '.screen[data-pane="automation"] .k12-webhook-card .resource-row' },
    { name: 'signature-action', selector: '.screen[data-pane="automation"] .k12-webhook-card .resource-row .btn-ghost' },
    { name: 'event-pills', selector: '.screen[data-pane="automation"] .k12-webhook-event', all: true },
    { name: 'receipt-facts', selector: '.screen[data-pane="automation"] .k12-webhook-card .task-meta', all: true },
    { name: 'action-buttons', selector: '.screen[data-pane="automation"] .k12-webhook-card .task-actions button', all: true },
    { name: 'actions', selector: '.screen[data-pane="automation"] .k12-webhook-card .task-actions' },
  ]
  const sourceTargets: GeometryTarget[] = [
    { name: 'manager-root', selector: '[data-testid="k12-webhook-panel"]' },
    { name: 'k12-card', selector: '[data-testid="k12-webhook-row-homework-hook"]' },
    { name: 'signature-row', selector: '[data-testid="k12-webhook-row-homework-hook"] .k12wh__signature' },
    { name: 'signature-action', selector: '[data-testid="k12-webhook-row-homework-hook"] .k12wh__signature .k12wh__button--ghost' },
    { name: 'event-pills', selector: '[data-testid="k12-webhook-row-homework-hook"] .k12wh__event', all: true },
    { name: 'receipt-facts', selector: '[data-testid="k12-webhook-row-homework-hook"] .k12wh__receipt-facts' },
    { name: 'action-buttons', selector: '[data-testid="k12-webhook-row-homework-hook"] .k12wh__actions button', all: true },
    { name: 'actions', selector: '[data-testid="k12-webhook-row-homework-hook"] .k12wh__actions' },
  ]

  try {
    await installSourceFixture(sourcePage, unknownRequests)
    await Promise.all([openReference(referencePage), openSource(sourcePage)])
    await Promise.all([freezeVisualState(referencePage), freezeVisualState(sourcePage)])

    const [referenceProjection, currentProjection, referenceGeometry, currentGeometry] = await Promise.all([
      collectProjection(referencePage, 'reference'),
      collectProjection(sourcePage, 'source'),
      collectGeometry(referencePage, referenceTargets),
      collectGeometry(sourcePage, sourceTargets),
    ])
    await Promise.all([
      referencePage.screenshot({ path: referencePath, animations: 'disabled', caret: 'hide', scale: 'css' }),
      sourcePage.screenshot({ path: sourcePath, animations: 'disabled', caret: 'hide', scale: 'css' }),
    ])
    const pixels = await createPixelDiff(referencePath, sourcePath, diffPath)
    const cardEntry = referenceGeometry
      .find((item) => item.name === 'k12-card')
      ?.entries.find((entry) => entry.rect)
    if (!cardEntry?.rect) throw new Error('K12 card geometry is missing')
    const cardClip = cardEntry.rect
    await Promise.all([
      referencePage.screenshot({
        path: cardReferencePath,
        clip: cardClip,
        animations: 'disabled',
        caret: 'hide',
        scale: 'css',
      }),
      sourcePage.screenshot({
        path: cardSourcePath,
        clip: cardClip,
        animations: 'disabled',
        caret: 'hide',
        scale: 'css',
      }),
    ])
    const cardPixels = await createPixelDiff(cardReferencePath, cardSourcePath, cardDiffPath)
    const mismatches = stateMismatches(referenceProjection, currentProjection)
    const report = {
      bug_id: 'BUG-20260723-024',
      fixture: fixture.meta.fixture_id,
      urls: { reference: REFERENCE_URL, current: SOURCE_URL },
      viewport: fixture.meta.viewport,
      device_scale_factor: fixture.meta.device_scale_factor,
      state_status: mismatches.length === 0 ? 'COMPARABLE' : 'NOT_COMPARABLE',
      state_mismatches: mismatches,
      visual_status:
        cardPixels.changed_pixel_ratio <= MAX_CHANGED_PIXEL_RATIO ? 'PASS' : 'RED',
      page_visual_status:
        pixels.changed_pixel_ratio <= MAX_CHANGED_PIXEL_RATIO
          ? 'PASS'
          : 'RED_OUT_OF_SCOPE_GENERIC_WEBHOOK',
      max_changed_pixel_ratio: MAX_CHANGED_PIXEL_RATIO,
      pixels,
      scoped_target: 'K12 binding card only; generic Webhook cards remain BUG-20260723-033 scope',
      scoped_pixels: cardPixels,
      business_data_projection: {
        fixture_binding: k12Binding,
        reference: referenceProjection,
        current: currentProjection,
      },
      unknown_fixture_requests: [...unknownRequests].sort(),
      evidence: {
        reference: 'reference.png',
        current: 'current-source.png',
        diff: 'pixel-diff.png',
        scoped_reference: 'k12-card-reference.png',
        scoped_current: 'k12-card-current-source.png',
        scoped_diff: 'k12-card-pixel-diff.png',
        geometry: 'geometry.json',
      },
    }
    await Promise.all([
      writeFile(geometryPath, `${JSON.stringify({ reference: referenceGeometry, current: currentGeometry }, null, 2)}\n`),
      writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`),
    ])
    await Promise.all([
      attach(testInfo, 'k12-webhook-reference', referencePath, 'image/png'),
      attach(testInfo, 'k12-webhook-current', sourcePath, 'image/png'),
      attach(testInfo, 'k12-webhook-pixel-diff', diffPath, 'image/png'),
      attach(testInfo, 'k12-card-reference', cardReferencePath, 'image/png'),
      attach(testInfo, 'k12-card-current', cardSourcePath, 'image/png'),
      attach(testInfo, 'k12-card-pixel-diff', cardDiffPath, 'image/png'),
      attach(testInfo, 'k12-webhook-geometry', geometryPath, 'application/json'),
      attach(testInfo, 'k12-webhook-gate-report', reportPath, 'application/json'),
    ])

    expect(referenceProjection.viewport).toEqual(currentProjection.viewport)
    expect(mismatches).toEqual([])
    expect(cardPixels.changed_pixel_ratio).toBeLessThanOrEqual(MAX_CHANGED_PIXEL_RATIO)
  } finally {
    await Promise.all([referencePage.close(), sourcePage.close(), context.close()])
  }
})
