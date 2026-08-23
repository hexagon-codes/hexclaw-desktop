import { expect, test, type Locator, type Page } from '@playwright/test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DESKTOP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const SOURCE_PORT = Number(process.env.HEX_BUG_20260816_003_SOURCE_PORT || '27203')
const REFERENCE_PORT = Number(process.env.HEX_BUG_20260816_003_REFERENCE_PORT || '27213')
const SOURCE_URL = `http://127.0.0.1:${SOURCE_PORT}/chat`
const REFERENCE_URL = `http://127.0.0.1:${REFERENCE_PORT}/app.html`
const EVIDENCE_ROOT = path.resolve(
  process.env.HEX_BUG_20260816_003_EVIDENCE_ROOT ||
    path.resolve(
      DESKTOP_ROOT,
      '../hexclaw-docs/test/evidence/bug-20260816-003-cold-agents-current-source',
    ),
)
const SESSION_MING = 'session-k12-cold-ming'
const SESSION_HONG = 'session-k12-cold-hong'
const SESSION_NORMAL = 'session-normal-newer'
const K12_AGENT_MING = 'k12-tutor-cold-ming'
const K12_AGENT_HONG = 'k12-tutor-cold-hong'
const SCREENSHOT_SIZE = { width: 240, height: 58 }
const PIXEL_THRESHOLD = 8

type AgentMode = 'not-ready' | 'empty'

type AgentEndpointState = {
  mode: AgentMode
  requests: number
  statuses: number[]
  responseExactSets: Array<{ agents: unknown[]; total: number; default: string } | { error: string }>
}

type ElementSnapshot = {
  text: string
  attributes: Record<string, string | null | boolean>
  bbox: { x: number; y: number; width: number; height: number } | null
  style: Record<string, string>
  title: {
    text: string
    bbox: { x: number; y: number; width: number; height: number } | null
    style: Record<string, string>
  }
  pin: {
    disabled: boolean
    bbox: { x: number; y: number; width: number; height: number } | null
    style: Record<string, string>
  }
}

function json(
  route: Parameters<Parameters<Page['route']>[1]>[0],
  body: unknown,
  status = 200,
) {
  return route.fulfill({
    status,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify(body),
  })
}

function fixedConfig() {
  return {
    general: { language: 'zh-CN', welcomeCompleted: true },
    knowledge: { enabled: true },
    llm: {
      default: '',
      providers: {},
      routing: { enabled: false },
      cache: {},
    },
  }
}

function sessionsFixture() {
  return {
    sessions: [
      {
        id: SESSION_NORMAL,
        title: '普通新会话',
        created_at: '2026-08-21T08:00:00+08:00',
        updated_at: '2026-08-21T08:00:00+08:00',
        message_count: 1,
      },
      {
        id: SESSION_MING,
        // 当前 Sidecar 的 durable Session API 不返回 agent_id/agent_name：冷启动恢复
        // 只能消费已落库的 title（此处为深链创建时保存的 Agent 内部名）。
        title: K12_AGENT_MING,
        created_at: '2026-06-16T08:00:00+08:00',
        updated_at: '2026-06-16T08:00:00+08:00',
        message_count: 6,
      },
      {
        id: SESSION_HONG,
        title: K12_AGENT_HONG,
        created_at: '2026-06-15T08:00:00+08:00',
        updated_at: '2026-06-15T08:00:00+08:00',
        message_count: 2,
      },
    ],
    total: 3,
  }
}

async function installSourceRoutes(page: Page, mode: AgentMode) {
  const agentEndpointState: AgentEndpointState = {
    mode,
    requests: 0,
    statuses: [],
    responseExactSets: [],
  }
  const unexpectedApiPaths: string[] = []

  await page.route('http://localhost:11434/**', (route) =>
    json(route, { models: [] }),
  )
  await page.route(/\/_hexclaw\/api\//u, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const apiPath = url.pathname.replace(/^\/_hexclaw/u, '')
    const method = request.method()

    if (method === 'GET' && apiPath === '/api/v1/agents') {
      agentEndpointState.requests += 1
      if (mode === 'not-ready') {
        const body = { error: 'agents directory not ready' }
        agentEndpointState.statuses.push(503)
        agentEndpointState.responseExactSets.push(body)
        return json(route, body, 503)
      }
      const body = { agents: [], total: 0, default: '' }
      agentEndpointState.statuses.push(200)
      agentEndpointState.responseExactSets.push(body)
      return json(route, body)
    }
    if (method === 'GET' && apiPath === '/api/v1/config') return json(route, fixedConfig())
    if (method === 'GET' && apiPath === '/api/v1/config/llm')
      return json(route, {
        default: '',
        providers: {},
        routing: { enabled: false, strategy: 'cost-aware' },
        cache: { enabled: false, similarity: 0.9, ttl: '1h', max_entries: 0 },
      })
    if (method === 'GET' && apiPath === '/api/v1/roles')
      return json(route, { roles: [], total: 0 })
    if (method === 'GET' && apiPath === '/api/v1/sessions')
      return json(route, sessionsFixture())
    if (method === 'GET' && /^\/api\/v1\/sessions\/[^/]+\/messages$/u.test(apiPath))
      return json(route, { messages: [], total: 0 })
    if (method === 'GET' && /^\/api\/v1\/sessions\/[^/]+\/artifacts$/u.test(apiPath))
      return json(route, { artifacts: [], total: 0 })
    if (method === 'GET' && apiPath === '/api/v1/streams/active')
      return json(route, { streams: [], total: 0 })
    if (method === 'GET' && apiPath === '/api/v1/skills')
      return json(route, { skills: [], total: 0, dir: '' })
    if (method === 'GET' && apiPath === '/api/v1/knowledge/documents')
      return json(route, { documents: [], total: 0 })
    if (method === 'GET' && apiPath === '/api/v1/connections')
      return json(route, { connections: [], total: 0 })
    if (
      method === 'GET' &&
      ['/api/v1/images/status', '/api/v1/videos/status', '/api/v1/voicechat/status'].includes(
        apiPath,
      )
    ) {
      return json(route, { available: false, models: [] })
    }

    unexpectedApiPaths.push(`${method} ${apiPath}`)
    return json(route, {})
  })

  return { agentEndpointState, unexpectedApiPaths }
}

async function freezePage(page: Page) {
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation: none !important;
        transition: none !important;
        caret-color: transparent !important;
      }
    `,
  })
  await page.evaluate(() => document.fonts.ready)
}

function roundedBox(box: { x: number; y: number; width: number; height: number } | null) {
  if (!box) return null
  return Object.fromEntries(
    Object.entries(box).map(([key, value]) => [key, Number(value.toFixed(3))]),
  ) as { x: number; y: number; width: number; height: number }
}

async function elementSnapshot(
  row: Locator,
  titleSelector: string,
  pinSelector: string,
): Promise<ElementSnapshot> {
  return row.evaluate(
    (element, selectors) => {
      const readBox = (target: Element | null) => {
        if (!target) return null
        const box = target.getBoundingClientRect()
        return { x: box.x, y: box.y, width: box.width, height: box.height }
      }
      const style = (target: Element | null, fields: string[]) => {
        if (!target) return {}
        const computed = getComputedStyle(target)
        return Object.fromEntries(fields.map((field) => [field, computed.getPropertyValue(field)]))
      }
      const title = element.querySelector(selectors.title)
      const pin = element.querySelector<HTMLButtonElement>(selectors.pin)
      return {
        text: (element.textContent ?? '').replace(/\s+/gu, ' ').trim(),
        attributes: {
          class: element.getAttribute('class'),
          dataPinned: element.getAttribute('data-pinned'),
          dataPinLocked: element.getAttribute('data-pin-locked'),
          sessionId: element.getAttribute('data-session-id'),
          pinAriaLabel: pin?.getAttribute('aria-label') ?? null,
          pinTitle: pin?.getAttribute('title') ?? null,
          pinDisabled: pin?.disabled ?? false,
        },
        bbox: readBox(element),
        style: style(element, [
          'display',
          'grid-template-columns',
          'align-items',
          'width',
          'padding',
          'margin-bottom',
          'border-radius',
          'background-color',
        ]),
        title: {
          text: (title?.textContent ?? '').replace(/\s+/gu, ' ').trim(),
          bbox: readBox(title),
          style: style(title, [
            'font-size',
            'font-weight',
            'line-height',
            'color',
            'white-space',
            'overflow',
            'text-overflow',
          ]),
        },
        pin: {
          disabled: pin?.disabled ?? false,
          bbox: readBox(pin),
          style: style(pin, [
            'display',
            'width',
            'height',
            'opacity',
            'color',
            'cursor',
            'background-color',
          ]),
        },
      }
    },
    { title: titleSelector, pin: pinSelector },
  )
}

function normalizeSnapshot(snapshot: ElementSnapshot): ElementSnapshot {
  return {
    ...snapshot,
    bbox: roundedBox(snapshot.bbox),
    title: { ...snapshot.title, bbox: roundedBox(snapshot.title.bbox) },
    pin: { ...snapshot.pin, bbox: roundedBox(snapshot.pin.bbox) },
  }
}

async function fixedRowScreenshot(page: Page, row: Locator, outputPath: string) {
  const box = await row.boundingBox()
  if (!box) throw new Error('target row has no bounding box')
  await page.screenshot({
    path: outputPath,
    animations: 'disabled',
    caret: 'hide',
    scale: 'css',
    clip: {
      x: box.x,
      y: box.y,
      width: SCREENSHOT_SIZE.width,
      height: SCREENSHOT_SIZE.height,
    },
  })
}

async function createPixelDiff(
  page: Page,
  referencePath: string,
  currentPath: string,
  diffPath: string,
) {
  const [reference, current] = await Promise.all([
    readFile(referencePath, 'base64'),
    readFile(currentPath, 'base64'),
  ])
  const result = await page.evaluate(
    async ({ referencePng, currentPng, threshold }) => {
      const loadImage = (source: string) =>
        new Promise<HTMLImageElement>((resolveImage, rejectImage) => {
          const image = new Image()
          image.onload = () => resolveImage(image)
          image.onerror = () => rejectImage(new Error('pixel diff image decode failed'))
          image.src = `data:image/png;base64,${source}`
        })
      const [referenceImage, currentImage] = await Promise.all([
        loadImage(referencePng),
        loadImage(currentPng),
      ])
      if (
        referenceImage.width !== currentImage.width ||
        referenceImage.height !== currentImage.height
      ) {
        throw new Error('pixel diff screenshots have different dimensions')
      }
      const { width, height } = referenceImage
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d')!
      context.drawImage(referenceImage, 0, 0)
      const referencePixels = context.getImageData(0, 0, width, height).data
      context.clearRect(0, 0, width, height)
      context.drawImage(currentImage, 0, 0)
      const currentPixels = context.getImageData(0, 0, width, height).data
      const diffCanvas = document.createElement('canvas')
      diffCanvas.width = width
      diffCanvas.height = height
      const diffContext = diffCanvas.getContext('2d')!
      const output = diffContext.createImageData(width, height)
      let changedPixels = 0
      let minX = width
      let minY = height
      let maxX = -1
      let maxY = -1
      for (let index = 0; index < referencePixels.length; index += 4) {
        const changed =
          Math.max(
            Math.abs(referencePixels[index]! - currentPixels[index]!),
            Math.abs(referencePixels[index + 1]! - currentPixels[index + 1]!),
            Math.abs(referencePixels[index + 2]! - currentPixels[index + 2]!),
            Math.abs(referencePixels[index + 3]! - currentPixels[index + 3]!),
          ) > threshold
        const pixel = index / 4
        const x = pixel % width
        const y = Math.floor(pixel / width)
        if (changed) {
          changedPixels += 1
          minX = Math.min(minX, x)
          minY = Math.min(minY, y)
          maxX = Math.max(maxX, x)
          maxY = Math.max(maxY, y)
          output.data[index] = 255
          output.data[index + 1] = 35
          output.data[index + 2] = 35
        } else {
          const luminance = Math.round(
            (referencePixels[index]! * 0.299 +
              referencePixels[index + 1]! * 0.587 +
              referencePixels[index + 2]! * 0.114) *
              0.45,
          )
          output.data[index] = luminance
          output.data[index + 1] = luminance
          output.data[index + 2] = luminance
        }
        output.data[index + 3] = 255
      }
      diffContext.putImageData(output, 0, 0)
      return {
        png: diffCanvas.toDataURL('image/png').split(',')[1]!,
        width,
        height,
        threshold,
        changed_pixels: changedPixels,
        total_pixels: width * height,
        changed_pixel_ratio: changedPixels / (width * height),
        changed_bbox: changedPixels ? [minX, minY, maxX + 1, maxY + 1] : null,
      }
    },
    { referencePng: reference, currentPng: current, threshold: PIXEL_THRESHOLD },
  )
  await writeFile(diffPath, Buffer.from(result.png, 'base64'))
  const { png: _png, ...summary } = result
  return summary
}

async function prepareReference(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('hc-theme', 'light')
  })
  await page.goto(REFERENCE_URL, { waitUntil: 'domcontentloaded' })
  await freezePage(page)
  const row = page.locator('.cs-item[data-session-id="k12-hong"]')
  await expect(row).toBeVisible()
  const pin = row.locator('.cs-pin')
  await expect(pin).toBeDisabled()
  await expect(pin).toHaveAttribute('aria-label', '固定置顶')
  await expect(row).toHaveAttribute('data-pinned', 'true')
  await expect(row).toHaveAttribute('data-pin-locked', 'true')
  return row
}

async function prepareSource(page: Page, mode: AgentMode) {
  await page.clock.setFixedTime(new Date('2026-08-22T08:00:00+08:00'))
  await page.addInitScript(() => {
    // 仅跳过首次欢迎流程；不得注入 localStorage 的会话、置顶或 Agent 绑定。
    // 该 fixture 的会话身份只来自 Sidecar /sessions 的 durable title。
    sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
  })
  const routeEvidence = await installSourceRoutes(page, mode)
  await page.goto(SOURCE_URL, { waitUntil: 'domcontentloaded' })
  await freezePage(page)
  const row = page.locator(`.hc-sessions__item[data-session-id="${SESSION_HONG}"]`)
  await expect(row).toBeVisible()
  return { row, ...routeEvidence }
}

for (const mode of ['not-ready', 'empty'] as const) {
  test(`${mode === 'not-ready' ? 'agents-not-ready' : 'agents-empty'} keeps K12 sessions locked at the top without a visual jump`, async ({
    browser,
  }) => {
    const referenceContext = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      deviceScaleFactor: 1,
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      colorScheme: 'light',
      reducedMotion: 'reduce',
    })
    const sourceContext = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      deviceScaleFactor: 1,
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      colorScheme: 'light',
      reducedMotion: 'reduce',
    })
    const referencePage = await referenceContext.newPage()
    const sourcePage = await sourceContext.newPage()
    try {
      const [referenceRow, source] = await Promise.all([
        prepareReference(referencePage),
        prepareSource(sourcePage, mode),
      ])
      const sourceRow = source.row
      const pin = sourceRow.locator('.hc-sessions__pin-action')
      await expect(sourceRow).toHaveClass(/hc-sessions__item--pinned/u)
      await expect(pin).toBeDisabled()
      await expect(pin).toHaveAttribute('aria-label', '固定置顶')
      await expect
        .poll(() => sourcePage.evaluate(() => localStorage.getItem('hexclaw_sessionAgents')))
        .toBeNull()

      const firstSection = sourcePage.locator('.hc-sessions__section').first()
      await expect(firstSection.locator('.hc-sessions__section-label')).toHaveText('已置顶')
      const orderBefore = await sourcePage
        .locator('.hc-sessions__item')
        .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-session-id')))
      expect(orderBefore).toEqual([SESSION_MING, SESSION_HONG, SESSION_NORMAL])
      const beforeBox = await sourceRow.boundingBox()
      expect(beforeBox).not.toBeNull()

      await sourcePage.waitForTimeout(700)
      const orderAfter = await sourcePage
        .locator('.hc-sessions__item')
        .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-session-id')))
      const afterBox = await sourceRow.boundingBox()
      expect(orderAfter).toEqual(orderBefore)
      expect(afterBox).not.toBeNull()
      expect(Math.abs(afterBox!.y - beforeBox!.y)).toBeLessThanOrEqual(0.5)

      if (mode === 'not-ready') {
        expect(source.agentEndpointState.mode).toBe('not-ready')
        expect(source.agentEndpointState.requests).toBeGreaterThanOrEqual(3)
        expect(source.agentEndpointState.statuses).toHaveLength(
          source.agentEndpointState.requests,
        )
        expect(source.agentEndpointState.statuses.every((status) => status === 503)).toBe(true)
        expect(
          source.agentEndpointState.responseExactSets.every(
            (body) => 'error' in body && body.error === 'agents directory not ready',
          ),
        ).toBe(true)
      } else {
        expect(source.agentEndpointState).toEqual({
          mode: 'empty',
          requests: 1,
          statuses: [200],
          responseExactSets: [{ agents: [], total: 0, default: '' }],
        })
      }

      await pin.evaluate((button: HTMLButtonElement) => button.click())
      expect(
        await sourcePage.evaluate(() =>
          JSON.parse(localStorage.getItem('hexclaw_pinned_sessions') || '[]'),
        ),
      ).toEqual([])

      const evidenceDir = path.join(EVIDENCE_ROOT, mode === 'not-ready' ? 'agents-not-ready' : 'agents-empty')
      await mkdir(evidenceDir, { recursive: true })
      const referencePath = path.join(evidenceDir, 'reference.png')
      const currentPath = path.join(evidenceDir, 'current.png')
      const diffPath = path.join(evidenceDir, 'pixel-diff.png')
      await Promise.all([
        fixedRowScreenshot(referencePage, referenceRow, referencePath),
        fixedRowScreenshot(sourcePage, sourceRow, currentPath),
      ])
      const pixelDiff = await createPixelDiff(sourcePage, referencePath, currentPath, diffPath)
      const [referenceSnapshot, currentSnapshot] = await Promise.all([
        elementSnapshot(referenceRow, '.cs-t', '.cs-pin').then(normalizeSnapshot),
        elementSnapshot(sourceRow, '.hc-sessions__title', '.hc-sessions__pin-action').then(
          normalizeSnapshot,
        ),
      ])
      const stateEquivalence = false
      const report = {
        bug: 'BUG-20260816-003',
        currentBehaviorStatus: 'PASS',
        visualComparisonStatus: 'NOT_COMPARABLE',
        stateEquivalence: false,
        reason:
          'The authoritative prototype is a static pinned-row projection and exposes no agents endpoint lifecycle, so it cannot represent the current-source agents pending/503 or authoritative empty-catalog state. Pixel and style outputs are diagnostic only.',
        environment: {
          viewport: { width: 1440, height: 1000 },
          deviceScaleFactor: 1,
          locale: 'zh-CN',
          timezoneId: 'Asia/Shanghai',
          colorScheme: 'light',
        },
        currentBehavior: {
          agentEndpointState: source.agentEndpointState,
          fixture: {
            k12AgentIDs: [K12_AGENT_MING, K12_AGENT_HONG],
            localPinnedSessionIDs: [],
            sessionAgentStorage: null,
            durableSessionTitles: {
              [SESSION_MING]: K12_AGENT_MING,
              [SESSION_HONG]: K12_AGENT_HONG,
            },
          },
          pinnedClass: true,
          pinDisabled: true,
          pinAriaLabel: '固定置顶',
          orderBefore,
          orderAfter,
          yBefore: roundedBox(beforeBox)?.y,
          yAfter: roundedBox(afterBox)?.y,
          unexpectedApiPaths: source.unexpectedApiPaths,
        },
        pixelDiff,
        files: {
          reference: 'reference.png',
          current: 'current.png',
          pixelDiff: 'pixel-diff.png',
          bboxComputedStyle: 'bbox-computed-style.json',
        },
      }
      await Promise.all([
        writeFile(
          path.join(evidenceDir, 'bbox-computed-style.json'),
          `${JSON.stringify(
            {
              stateEquivalence,
              reference: referenceSnapshot,
              current: currentSnapshot,
            },
            null,
            2,
          )}\n`,
        ),
        writeFile(
          path.join(evidenceDir, 'comparison-report.json'),
          `${JSON.stringify(report, null, 2)}\n`,
        ),
      ])

      expect(report.currentBehaviorStatus).toBe('PASS')
      expect(report.visualComparisonStatus).toBe('NOT_COMPARABLE')
      expect(report.stateEquivalence).toBe(false)
    } finally {
      await Promise.all([referenceContext.close(), sourceContext.close()])
    }
  })
}
