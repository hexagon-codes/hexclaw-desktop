import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, test, type Browser, type Page, type Route } from '@playwright/test'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const EVIDENCE_ROOT = path.join(
  REPO_ROOT,
  'test/evidence/bug-20260728-007-current-source',
)
const REFERENCE_URL =
  process.env.HEX_BUG_20260728_007_REFERENCE_URL?.trim() || 'http://127.0.0.1:16707/app.html'
const IMPLEMENTATION_URL =
  process.env.HEX_BUG_20260728_007_IMPLEMENTATION_URL?.trim() || 'http://127.0.0.1:16708/chat'
const VIEWPORT = { width: 1440, height: 900 }
const FRAME = { width: 1100, height: 760 }
const DEVICE_SCALE_FACTOR = 1
const PIXEL_THRESHOLD = 8
const SESSION_ID = 'bug-20260728-007-grid-session'
const FIXED_TIME = '2026-07-28T08:00:00.000Z'

const appConfig = {
  general: {
    language: 'zh-CN',
    log_level: 'info',
    data_dir: '',
    auto_start: false,
    defaultAgentRole: '',
    welcomeCompleted: true,
  },
  knowledge: { enabled: true },
  notification: { system_enabled: true, sound_enabled: false, agent_complete: true },
  memory: { enabled: true },
  sandbox: { network_enabled: false },
  security: {
    gateway_enabled: false,
    injection_detection: false,
    pii_filter: false,
    content_filter: false,
    rate_limit_rpm: 60,
  },
  mcp: { default_protocol: 'stdio' },
  llm: {
    defaultModel: 'gpt-5.6-terra',
    defaultProviderId: 'fixture-provider-id',
    defaultReasoningPolicy: { mode: 'effort', effort: 'high' },
    routing: { enabled: false, strategy: 'cost-aware' },
    cache: { enabled: false },
    providers: [
      {
        id: 'fixture-provider-id',
        providerInstanceId: `pvd_v1_${'f'.repeat(32)}`,
        backendKey: 'fixture-provider',
        name: 'OpenAI',
        type: 'openai',
        enabled: true,
        apiKey: 'fixture-redacted',
        baseUrl: 'https://example.invalid/v1',
        selectedModelId: 'gpt-5.6-terra',
        models: [
          {
            id: 'gpt-5.6-terra',
            name: 'gpt-5.6-terra',
            capabilities: ['text', 'vision'],
            reasoningSupport: 'supported',
            reasoningControl: {
              dialect: 'reasoning_effort',
              on: 'high',
              off: 'none',
              allowed_efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
            },
          },
        ],
      },
    ],
  },
}

const backendLLMConfig = {
  default: 'fixture-provider',
  default_reasoning_policy: { mode: 'effort', effort: 'high' },
  routing: { enabled: false, strategy: 'cost-aware' },
  cache: { enabled: false },
  providers: {
    'fixture-provider': {
      provider_instance_id: `pvd_v1_${'f'.repeat(32)}`,
      display_name: 'OpenAI',
      type: 'openai',
      enabled: true,
      compatible: 'openai',
      api_key: 'fixture-redacted',
      base_url: 'https://example.invalid/v1',
      model: 'gpt-5.6-terra',
      models: ['gpt-5.6-terra'],
      model_specs: [
        {
          id: 'gpt-5.6-terra',
          display_name: 'gpt-5.6-terra',
          capabilities: ['text', 'vision'],
          reasoning_support: 'supported',
          reasoning_control: {
            dialect: 'reasoning_effort',
            on: 'high',
            off: 'none',
            allowed_efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
          },
        },
      ],
    },
  },
}

type Rect = {
  x: number
  y: number
  width: number
  height: number
  top: number
  right: number
  bottom: number
  left: number
}

type ElementFact = {
  selector: string
  rect: Rect
  style: Record<string, string>
}

type GridSnapshot = {
  source: 'reference' | 'implementation'
  environment: {
    viewport: typeof VIEWPORT
    frame: typeof FRAME
    deviceScaleFactor: number
    locale: string
    timezoneId: string
    colorScheme: string
    reducedMotion: string
    contentState: string
  }
  elements: Record<string, ElementFact>
  contract: {
    messagePaddingLeft: number
    messagePaddingRight: number
    messageSafeLeft: number
    messageSafeRight: number
    composerSafeLeft: number
    composerSafeRight: number
    composerSurfaceWidth: number
    expectedComposerSurfaceWidth: number
    inputWrapMaxWidth: string
    composerSurfaceMaxWidth: string
    composerPaddingTop: number
    composerPaddingRight: number
    composerPaddingBottom: number
    composerPaddingLeft: number
  }
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

function runtimeFixture(apiPath: string, method: string) {
  if (apiPath === '/health') return { status: 'healthy' }
  if (apiPath === '/api/v1/config') return appConfig
  if (apiPath === '/api/v1/config/llm') return backendLLMConfig
  if (apiPath === '/api/v1/ollama/status') return { running: false, associated: false, models: [] }
  if (apiPath === '/api/v1/assistant/soul') {
    return { system_prompt: '', is_custom: false, default_prompt: '' }
  }
  if (apiPath === '/api/v1/agents' && method === 'GET') {
    return { agents: [], total: 0, default: '' }
  }
  if (apiPath === '/api/v1/agents/rules') return { rules: [], total: 0 }
  if (apiPath === '/api/v1/roles') return { roles: [], total: 0 }
  if (apiPath === '/api/v1/sessions' && method === 'GET') {
    return {
      sessions: [
        {
          id: SESSION_ID,
          title: '24px 栅格视觉基准',
          user_id: 'desktop-user',
          created_at: FIXED_TIME,
          updated_at: FIXED_TIME,
          message_count: 0,
        },
      ],
      total: 1,
    }
  }
  if (apiPath === `/api/v1/sessions/${SESSION_ID}/messages`) {
    return { messages: [], total: 0 }
  }
  if (apiPath === `/api/v1/sessions/${SESSION_ID}/branches`) return { branches: [], total: 0 }
  if (apiPath === `/api/v1/sessions/${SESSION_ID}/artifacts`) return { artifacts: [], total: 0 }
  if (apiPath === '/api/v1/streams/active') return { streams: [], total: 0 }
  if (apiPath === '/api/v1/skills') return { dir: '/tmp/hexclaw-grid-skills', skills: [] }
  if (apiPath === '/api/v1/prompts' || apiPath === '/api/v1/prompts/all') {
    return { prompts: [], total: 0 }
  }
  if (apiPath === '/api/v1/knowledge/documents') {
    return { documents: [], total: 0, limit: 50, offset: 0, sources: [] }
  }
  if (apiPath === '/api/v1/connections') return { connections: [], total: 0 }
  if (apiPath === '/api/v1/platforms/instances') return { instances: [] }
  if (apiPath === '/api/v1/images/status') return { available: false, models: [] }
  if (apiPath === '/api/v1/videos/status') return { available: false, models: [] }
  if (apiPath === '/api/v1/voicechat/status') return { available: false, models: [] }
  if (apiPath === '/api/v1/llm/capabilities') return { models: [] }
  if (apiPath.startsWith('/api/k12/')) return { items: [] }
  if (apiPath.startsWith('/api/v1/')) return { items: [], total: 0 }
  return {}
}

async function installImplementationFixture(page: Page, blockedRequests: string[]) {
  await page.addInitScript(
    ({ config, session }) => {
      localStorage.clear()
      sessionStorage.clear()
      localStorage.setItem('hc-theme', 'light')
      localStorage.setItem('hc-locale', 'zh-CN')
      localStorage.setItem('hexclaw:welcomeRedirectDone', '1')
      sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
      localStorage.setItem('hexclaw_lastSessionId', session)
      localStorage.setItem('app_config', JSON.stringify(config))
      localStorage.setItem(
        'hexclaw_sessionDeepThinking',
        JSON.stringify({ [session]: { mode: 'effort', effort: 'high' } }),
      )

      class MockWebSocket extends EventTarget {
        static CONNECTING = 0
        static OPEN = 1
        static CLOSING = 2
        static CLOSED = 3
        readyState = MockWebSocket.CONNECTING
        onopen: ((event: Event) => void) | null = null
        onmessage: ((event: MessageEvent) => void) | null = null
        onerror: ((event: Event) => void) | null = null
        onclose: ((event: CloseEvent) => void) | null = null

        constructor() {
          super()
          queueMicrotask(() => {
            this.readyState = MockWebSocket.OPEN
            const event = new Event('open')
            this.onopen?.(event)
            this.dispatchEvent(event)
          })
        }

        send() {}

        close() {
          this.readyState = MockWebSocket.CLOSED
          const event = new CloseEvent('close')
          this.onclose?.(event)
          this.dispatchEvent(event)
        }
      }

      Object.defineProperty(window, 'WebSocket', {
        configurable: true,
        writable: true,
        value: MockWebSocket,
      })
    },
    { config: appConfig, session: SESSION_ID },
  )

  await page.route('**/*', (route) => {
    const requestURL = new URL(route.request().url())
    if (['127.0.0.1', 'localhost', '::1'].includes(requestURL.hostname)) {
      return route.continue()
    }
    blockedRequests.push(requestURL.toString())
    return route.abort('blockedbyclient')
  })
  await page.route('http://localhost:11434/**', (route) =>
    json(route, { models: [], version: 'bug-20260728-007-grid-fixture' }),
  )
  await page.route('**/_hexclaw/**', (route) => {
    const requestURL = new URL(route.request().url())
    const apiPath = requestURL.pathname.replace(/^\/_hexclaw/, '')
    return json(route, runtimeFixture(apiPath, route.request().method()))
  })
}

async function installReferenceNetworkGate(page: Page, blockedRequests: string[]) {
  await page.route('**/*', (route) => {
    const requestURL = new URL(route.request().url())
    if (['127.0.0.1', 'localhost', '::1'].includes(requestURL.hostname)) {
      return route.continue()
    }
    blockedRequests.push(requestURL.toString())
    return route.abort('blockedbyclient')
  })
}

async function prepareReference(page: Page) {
  await page.goto(REFERENCE_URL, { waitUntil: 'domcontentloaded' })
  await page.locator('.screen[data-pane="chat"]').waitFor({ state: 'visible' })
  await page.evaluate(() => {
    const prototypeWindow = window as typeof window & {
      openNormalChat?: () => void
      applyChatWorkspaceMode?: (mode: string) => void
      setChatComposerPrototypeState?: (state: string) => void
    }
    prototypeWindow.openNormalChat?.()
    prototypeWindow.applyChatWorkspaceMode?.('sessions')
    prototypeWindow.setChatComposerPrototypeState?.('empty')
  })
  await page.locator('#chatNormalView .chat-input').waitFor({ state: 'visible' })
  await mountFixedFrame(page, 'reference')
}

async function prepareImplementation(page: Page) {
  await page.goto(IMPLEMENTATION_URL, { waitUntil: 'domcontentloaded' })
  await page.locator('#splash-screen').waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {})
  await page.locator('.hc-composer__box--primary').waitFor({ state: 'visible', timeout: 10_000 })
  await page.locator('.hc-model-selector__name').filter({ hasText: 'gpt-5.6-terra' }).waitFor({
    state: 'visible',
    timeout: 10_000,
  })
  await mountFixedFrame(page, 'implementation')
}

async function mountFixedFrame(page: Page, source: 'reference' | 'implementation') {
  await page.evaluate(
    ({ sourceName, frame }) => {
      document.documentElement.dataset.theme = 'light'
      const main = document.querySelector(
        sourceName === 'reference' ? '.chat-main' : '.hc-chat__main',
      ) as HTMLElement | null
      const messages = document.querySelector(
        sourceName === 'reference' ? '#chatNormalView .chat-thread' : '.hc-chat__messages',
      ) as HTMLElement | null
      if (!main || !messages) throw new Error(`${sourceName} chat grid target is missing`)

      const fixture = document.createElement('div')
      fixture.dataset.gridContentFixture = 'same-content-state'
      fixture.innerHTML = `
        <div style="width:320px;height:46px;border-radius:14px;background:#dbeafe;border:1px solid #bfdbfe"></div>
        <div style="width:420px;height:58px;margin-top:16px;border-radius:14px;background:#f3f4f6;border:1px solid #e5e7eb"></div>
      `
      messages.replaceChildren(fixture)

      const frameElement = document.createElement('main')
      frameElement.id = 'bug-20260728-007-grid-frame'
      frameElement.dataset.source = sourceName
      frameElement.style.width = `${frame.width}px`
      frameElement.style.height = `${frame.height}px`
      frameElement.append(main)
      document.body.replaceChildren(frameElement)
    },
    { sourceName: source, frame: FRAME },
  )
  await page.addStyleTag({
    content: `
      html, body {
        margin: 0 !important;
        width: 100% !important;
        min-height: 100% !important;
        overflow: hidden !important;
        background: var(--hc-bg-main) !important;
      }
      *, *::before, *::after {
        animation: none !important;
        caret-color: transparent !important;
        transition: none !important;
      }
      #bug-20260728-007-grid-frame {
        box-sizing: border-box;
        overflow: hidden;
        color: var(--hc-text-primary);
        background: var(--hc-bg-main);
        font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', sans-serif;
      }
      #bug-20260728-007-grid-frame > .chat-main,
      #bug-20260728-007-grid-frame > .hc-chat__main {
        box-sizing: border-box;
        width: 100% !important;
        height: 100% !important;
        min-height: 0 !important;
        flex: none !important;
      }
      [data-grid-content-fixture='same-content-state'] {
        box-sizing: border-box;
        width: 100%;
      }
    `,
  })
  await page.evaluate(async () => {
    if ('fonts' in document) await document.fonts.ready
    ;(document.activeElement as HTMLElement | null)?.blur()
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })
}

async function captureGridSnapshot(
  page: Page,
  source: 'reference' | 'implementation',
): Promise<GridSnapshot> {
  return page.evaluate((sourceName) => {
    const selectors =
      sourceName === 'reference'
        ? {
            main: '.chat-main',
            messages: '#chatNormalView .chat-thread',
            messageFixture: '[data-grid-content-fixture]',
            composerHost: '#chatNormalView .chat-input',
            inputWrap: '#chatNormalView .chat-input',
            composerSurface: '#chatNormalView .chat-input',
            editor: '#chatNormalView [data-chat-composer-input]',
          }
        : {
            main: '.hc-chat__main',
            messages: '.hc-chat__messages',
            messageFixture: '[data-grid-content-fixture]',
            composerHost: '.hc-chat__input-area',
            inputWrap: '.hc-chat__input-wrap',
            composerSurface: '.hc-composer__box--primary',
            editor: '[data-testid="chat-input"]',
          }
    const round = (value: number) => Number(value.toFixed(2))
    const px = (value: string) => Number.parseFloat(value) || 0
    const styleKeys = [
      'display',
      'position',
      'boxSizing',
      'width',
      'height',
      'minWidth',
      'maxWidth',
      'paddingTop',
      'paddingRight',
      'paddingBottom',
      'paddingLeft',
      'marginTop',
      'marginRight',
      'marginBottom',
      'marginLeft',
      'borderTopWidth',
      'borderRightWidth',
      'borderBottomWidth',
      'borderLeftWidth',
      'borderRadius',
      'backgroundColor',
      'overflowX',
      'overflowY',
    ]
    const elements = Object.fromEntries(
      Object.entries(selectors).map(([name, selector]) => {
        const element = document.querySelector(selector) as HTMLElement | null
        if (!element) throw new Error(`${sourceName} selector is missing: ${selector}`)
        const rect = element.getBoundingClientRect()
        const computed = getComputedStyle(element)
        return [
          name,
          {
            selector,
            rect: {
              x: round(rect.x),
              y: round(rect.y),
              width: round(rect.width),
              height: round(rect.height),
              top: round(rect.top),
              right: round(rect.right),
              bottom: round(rect.bottom),
              left: round(rect.left),
            },
            style: Object.fromEntries(styleKeys.map((key) => [key, computed[key]])),
          },
        ]
      }),
    ) as Record<string, ElementFact>

    const main = elements.main.rect
    const messages = elements.messages
    const messageFixture = elements.messageFixture.rect
    const composerSurface = elements.composerSurface
    const inputWrap = elements.inputWrap
    const contract = {
      messagePaddingLeft: px(messages.style.paddingLeft),
      messagePaddingRight: px(messages.style.paddingRight),
      messageSafeLeft: round(messageFixture.left - main.left),
      messageSafeRight: round(main.right - (messages.rect.right - px(messages.style.paddingRight))),
      composerSafeLeft: round(composerSurface.rect.left - main.left),
      composerSafeRight: round(main.right - composerSurface.rect.right),
      composerSurfaceWidth: composerSurface.rect.width,
      expectedComposerSurfaceWidth: round(main.width - 48),
      inputWrapMaxWidth: inputWrap.style.maxWidth,
      composerSurfaceMaxWidth: composerSurface.style.maxWidth,
      composerPaddingTop: px(composerSurface.style.paddingTop),
      composerPaddingRight: px(composerSurface.style.paddingRight),
      composerPaddingBottom: px(composerSurface.style.paddingBottom),
      composerPaddingLeft: px(composerSurface.style.paddingLeft),
    }
    return {
      source: sourceName,
      environment: {
        viewport: { width: 1440, height: 900 },
        frame: { width: 1100, height: 760 },
        deviceScaleFactor: 1,
        locale: 'zh-CN',
        timezoneId: 'Asia/Shanghai',
        colorScheme: 'light',
        reducedMotion: 'reduce',
        contentState: 'normal chat; session sidebar excluded; identical two-block message fixture; empty blurred composer',
      },
      elements,
      contract,
    }
  }, source)
}

async function addGridGuides(page: Page, snapshot: GridSnapshot) {
  await page.evaluate((facts) => {
    const main = document.querySelector(
      facts.source === 'reference' ? '.chat-main' : '.hc-chat__main',
    ) as HTMLElement | null
    if (!main) throw new Error('chat main is missing while adding visual guides')
    const overlay = document.createElement('div')
    overlay.dataset.gridEvidenceOverlay = 'true'
    Object.assign(overlay.style, {
      position: 'absolute',
      inset: '0',
      pointerEvents: 'none',
      zIndex: '2147483647',
    })
    const line = (left: number, top: number, height: number, color: string) => {
      const marker = document.createElement('div')
      Object.assign(marker.style, {
        position: 'absolute',
        left: `${left}px`,
        top: `${top}px`,
        width: '1px',
        height: `${height}px`,
        background: color,
        boxShadow: `0 0 0 1px color-mix(in srgb, ${color} 24%, transparent)`,
      })
      overlay.append(marker)
    }
    const mainRect = facts.elements.main.rect
    const messages = facts.elements.messages.rect
    const composer = facts.elements.composerSurface.rect
    line(24, messages.top - mainRect.top, composer.bottom - messages.top, '#2563eb')
    line(mainRect.width - 24, messages.top - mainRect.top, composer.bottom - messages.top, '#2563eb')
    line(
      facts.contract.composerSafeLeft + facts.contract.composerPaddingLeft,
      composer.top - mainRect.top,
      composer.height,
      '#dc2626',
    )
    line(
      mainRect.width - facts.contract.composerSafeRight - facts.contract.composerPaddingRight,
      composer.top - mainRect.top,
      composer.height,
      '#dc2626',
    )
    main.append(overlay)
  }, snapshot)
}

function contractDifferences(snapshot: GridSnapshot) {
  const differences: string[] = []
  const expected: Record<keyof GridSnapshot['contract'], number | string> = {
    messagePaddingLeft: 24,
    messagePaddingRight: 24,
    messageSafeLeft: 24,
    messageSafeRight: 24,
    composerSafeLeft: 24,
    composerSafeRight: 24,
    composerSurfaceWidth: snapshot.contract.expectedComposerSurfaceWidth,
    expectedComposerSurfaceWidth: snapshot.contract.expectedComposerSurfaceWidth,
    inputWrapMaxWidth: 'none',
    composerSurfaceMaxWidth: 'none',
    composerPaddingTop: 14,
    composerPaddingRight: 16,
    composerPaddingBottom: 12,
    composerPaddingLeft: 16,
  }
  for (const [key, value] of Object.entries(expected) as [keyof typeof expected, number | string][]) {
    const actual = snapshot.contract[key]
    if (typeof value === 'number' && typeof actual === 'number') {
      if (Math.abs(actual - value) > 0.5) differences.push(`${key}: expected ${value}, got ${actual}`)
    } else if (actual !== value) {
      differences.push(`${key}: expected ${value}, got ${actual}`)
    }
  }
  return differences
}

async function renderNormalizedContract(
  browser: Browser,
  snapshot: GridSnapshot,
  destination: string,
) {
  const context = await browser.newContext({
    viewport: { width: 1100, height: 320 },
    deviceScaleFactor: 1,
    locale: 'zh-CN',
    colorScheme: 'light',
  })
  const page = await context.newPage()
  try {
    const facts = snapshot.contract
    await page.setContent(`<!doctype html>
      <html lang="zh-CN"><head><meta charset="utf-8"><style>
        *{box-sizing:border-box}html,body{margin:0;background:#f7f8fa;color:#172033;font-family:Arial,'PingFang SC',sans-serif}
        #contract{width:1100px;height:320px;padding:22px 0;background:#f7f8fa}
        h1{margin:0 24px 18px;font-size:17px;line-height:24px}
        .row{height:70px;margin-bottom:10px;position:relative;border-top:1px dashed #cbd5e1;border-bottom:1px dashed #cbd5e1}
        .bar{position:absolute;top:12px;height:44px;border-radius:10px;background:#dbeafe;border:1px solid #60a5fa}
        .bar.inner{background:#fee2e2;border-color:#f87171;height:28px;top:20px}
        .label{position:absolute;left:24px;top:-11px;padding:0 6px;background:#f7f8fa;font-size:12px;color:#475569}
        .value{position:absolute;right:24px;top:-11px;padding:0 6px;background:#f7f8fa;font-size:12px;color:#475569}
        .footer{margin:2px 24px 0;font:12px/18px ui-monospace,SFMono-Regular,Menlo,monospace;color:#334155}
      </style></head><body><main id="contract">
        <h1>BUG-20260728-007 · 24px 页面栅格归一化投影</h1>
        <section class="row"><span class="label">消息内容轨道</span><span class="value">24 / 24px</span><div class="bar" style="left:${facts.messageSafeLeft}px;width:${FRAME.width - facts.messageSafeLeft - facts.messageSafeRight}px"></div></section>
        <section class="row"><span class="label">Composer 外沿</span><span class="value">24 / 24px · max-width:none</span><div class="bar" style="left:${facts.composerSafeLeft}px;width:${facts.composerSurfaceWidth}px"></div></section>
        <section class="row"><span class="label">Composer 内部内容</span><span class="value">padding ${facts.composerPaddingTop}/${facts.composerPaddingRight}/${facts.composerPaddingBottom}/${facts.composerPaddingLeft}px</span><div class="bar inner" style="left:${facts.composerSafeLeft + facts.composerPaddingLeft}px;width:${facts.composerSurfaceWidth - facts.composerPaddingLeft - facts.composerPaddingRight}px"></div></section>
        <p class="footer">frame=1100×760 · viewport=1440×900 · DPR=1 · zh-CN · light · reduced-motion</p>
      </main></body></html>`)
    await page.locator('#contract').screenshot({ path: destination, animations: 'disabled', scale: 'css' })
  } finally {
    await context.close()
  }
}

async function pixelDiff(
  page: Page,
  reference: string,
  implementation: string,
  destination: string,
) {
  const [referencePng, implementationPng] = await Promise.all([
    readFile(reference, 'base64'),
    readFile(implementation, 'base64'),
  ])
  const result = await page.evaluate(
    async ({ referenceBase64, implementationBase64, threshold }) => {
      const loadImage = (base64: string) =>
        new Promise<HTMLImageElement>((resolve, reject) => {
          const image = new Image()
          image.onload = () => resolve(image)
          image.onerror = reject
          image.src = `data:image/png;base64,${base64}`
        })
      const [referenceImage, implementationImage] = await Promise.all([
        loadImage(referenceBase64),
        loadImage(implementationBase64),
      ])
      if (
        referenceImage.width !== implementationImage.width ||
        referenceImage.height !== implementationImage.height
      ) {
        throw new Error(
          `screenshot size mismatch: reference=${referenceImage.width}x${referenceImage.height}, implementation=${implementationImage.width}x${implementationImage.height}`,
        )
      }
      const width = referenceImage.width
      const height = referenceImage.height
      const sourceCanvas = document.createElement('canvas')
      sourceCanvas.width = width
      sourceCanvas.height = height
      const sourceContext = sourceCanvas.getContext('2d')!
      sourceContext.drawImage(referenceImage, 0, 0)
      const referencePixels = sourceContext.getImageData(0, 0, width, height).data
      sourceContext.clearRect(0, 0, width, height)
      sourceContext.drawImage(implementationImage, 0, 0)
      const implementationPixels = sourceContext.getImageData(0, 0, width, height).data
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
            Math.abs(referencePixels[index]! - implementationPixels[index]!),
            Math.abs(referencePixels[index + 1]! - implementationPixels[index + 1]!),
            Math.abs(referencePixels[index + 2]! - implementationPixels[index + 2]!),
            Math.abs(referencePixels[index + 3]! - implementationPixels[index + 3]!),
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
        changed_bbox: changedPixels > 0 ? [minX, minY, maxX + 1, maxY + 1] : null,
      }
    },
    {
      referenceBase64: referencePng,
      implementationBase64: implementationPng,
      threshold: PIXEL_THRESHOLD,
    },
  )
  await writeFile(destination, Buffer.from(result.png, 'base64'))
  return {
    width: result.width,
    height: result.height,
    threshold: result.threshold,
    changed_pixels: result.changed_pixels,
    total_pixels: result.total_pixels,
    changed_pixel_ratio: result.changed_pixel_ratio,
    changed_bbox: result.changed_bbox,
  }
}

test('BUG-20260728-007 keeps messages and Composer on the same 24px page grid', async ({
  browser,
}) => {
  await mkdir(EVIDENCE_ROOT, { recursive: true })
  const contextOptions = {
    viewport: VIEWPORT,
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    colorScheme: 'light' as const,
    reducedMotion: 'reduce' as const,
  }
  const referenceContext = await browser.newContext(contextOptions)
  const implementationContext = await browser.newContext(contextOptions)
  const referencePage = await referenceContext.newPage()
  const implementationPage = await implementationContext.newPage()
  const referenceBlockedRequests: string[] = []
  const implementationBlockedRequests: string[] = []

  try {
    await installReferenceNetworkGate(referencePage, referenceBlockedRequests)
    await installImplementationFixture(implementationPage, implementationBlockedRequests)
    await Promise.all([prepareReference(referencePage), prepareImplementation(implementationPage)])

    const [referenceSnapshot, implementationSnapshot] = await Promise.all([
      captureGridSnapshot(referencePage, 'reference'),
      captureGridSnapshot(implementationPage, 'implementation'),
    ])
    await Promise.all([
      addGridGuides(referencePage, referenceSnapshot),
      addGridGuides(implementationPage, implementationSnapshot),
    ])

    const referencePath = path.join(EVIDENCE_ROOT, 'reference.png')
    const implementationPath = path.join(EVIDENCE_ROOT, 'implementation.png')
    const diffPath = path.join(EVIDENCE_ROOT, 'pixel-diff.png')
    await Promise.all([
      referencePage.locator('#bug-20260728-007-grid-frame').screenshot({
        path: referencePath,
        animations: 'disabled',
        caret: 'hide',
        scale: 'css',
      }),
      implementationPage.locator('#bug-20260728-007-grid-frame').screenshot({
        path: implementationPath,
        animations: 'disabled',
        caret: 'hide',
        scale: 'css',
      }),
    ])
    const pagePixels = await pixelDiff(
      implementationPage,
      referencePath,
      implementationPath,
      diffPath,
    )

    const normalizedReferencePath = path.join(EVIDENCE_ROOT, 'grid-reference.png')
    const normalizedImplementationPath = path.join(EVIDENCE_ROOT, 'grid-implementation.png')
    const normalizedDiffPath = path.join(EVIDENCE_ROOT, 'grid-pixel-diff.png')
    await renderNormalizedContract(browser, referenceSnapshot, normalizedReferencePath)
    await renderNormalizedContract(browser, implementationSnapshot, normalizedImplementationPath)
    const normalizedPixels = await pixelDiff(
      implementationPage,
      normalizedReferencePath,
      normalizedImplementationPath,
      normalizedDiffPath,
    )

    const referenceDifferences = contractDifferences(referenceSnapshot)
    const implementationDifferences = contractDifferences(implementationSnapshot)
    const crossDifferences = Object.entries(referenceSnapshot.contract)
      .filter(([key, value]) => {
        if (key === 'expectedComposerSurfaceWidth') return false
        return implementationSnapshot.contract[key as keyof GridSnapshot['contract']] !== value
      })
      .map(([key]) => key)
    const status =
      referenceDifferences.length === 0 &&
      implementationDifferences.length === 0 &&
      crossDifferences.length === 0 &&
      referenceBlockedRequests.length === 0 &&
      implementationBlockedRequests.length === 0 &&
      normalizedPixels.changed_pixel_ratio === 0
        ? 'PASS'
        : 'NOT_PASS'
    const report = {
      bug: 'BUG-20260728-007',
      status,
      scope: 'chat message/composer horizontal 24px grid only',
      environment: referenceSnapshot.environment,
      network: {
        policy: 'loopback-only; current API and WebSocket are deterministic local fixtures',
        referenceBlockedRequests,
        implementationBlockedRequests,
        realModelCalls: 0,
        realUserDataAccess: false,
      },
      normalization: [
        'Canonical prototype and implementation chat-main nodes run in the same 1100x760 frame inside the same 1440x900 browser viewport.',
        'Message descendants are replaced by the same inert two-block fixture; message/composer containers and production styles remain authoritative.',
        'Blue guides show the 24px page-safe edges; red guides show the Composer internal horizontal padding.',
        'The normalized grid images are derived from live bbox/computed-style facts and isolate this Bug from unrelated toolbar, vertical-rhythm and component-structure drift.',
      ],
      reference: referenceSnapshot,
      implementation: implementationSnapshot,
      differences: {
        referenceContract: referenceDifferences,
        implementationContract: implementationDifferences,
        crossContract: crossDifferences,
      },
      pixels: {
        liveTarget: {
          ...pagePixels,
          interpretation:
            'diagnostic only; non-grid pixels include unrelated toolbar, vertical rhythm and component structure and do not gate this Bug',
        },
        normalizedGrid: {
          ...normalizedPixels,
          interpretation: 'gating visual projection of the measured 24px/max-width/padding contract',
        },
      },
      files: {
        reference: 'reference.png',
        implementation: 'implementation.png',
        pixelDiff: 'pixel-diff.png',
        gridReference: 'grid-reference.png',
        gridImplementation: 'grid-implementation.png',
        gridPixelDiff: 'grid-pixel-diff.png',
        bboxComputedStyle: 'bbox-computed-style.json',
      },
    }
    await Promise.all([
      writeFile(
        path.join(EVIDENCE_ROOT, 'bbox-computed-style.json'),
        `${JSON.stringify({ reference: referenceSnapshot, implementation: implementationSnapshot }, null, 2)}\n`,
      ),
      writeFile(
        path.join(EVIDENCE_ROOT, 'pixel-diff.json'),
        `${JSON.stringify({ liveTarget: pagePixels, normalizedGrid: normalizedPixels }, null, 2)}\n`,
      ),
      writeFile(path.join(EVIDENCE_ROOT, 'summary.json'), `${JSON.stringify(report, null, 2)}\n`),
    ])

    expect(report.status, JSON.stringify(report.differences, null, 2)).toBe('PASS')
  } finally {
    await Promise.all([referenceContext.close(), implementationContext.close()])
  }
})
