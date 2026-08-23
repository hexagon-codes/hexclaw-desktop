/**
 * 流式回复首正文到达前的成对视觉证据。
 *
 * 参考侧只调用权威原型公开状态接口；实现侧使用真实 ChatView 与浏览器内 WebSocket，
 * 故不会访问 Provider、Sidecar、IM 或安装应用。
 */
import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const DOCS_ROOT = process.env.HEXCLAW_DOCS_ROOT?.trim()
  ? path.resolve(process.env.HEXCLAW_DOCS_ROOT)
  : path.resolve(ROOT, '../hexclaw-docs')
const OUTPUT = path.resolve(
  DOCS_ROOT,
  'test/evidence/bug-20260816-002-current-source-visual',
)
const IMPLEMENTATION_URL = 'http://127.0.0.1:27102/chat'
const PROTOTYPE_URL = 'http://127.0.0.1:27112/app.html'
const VIEWPORT = { width: 1440, height: 1000 }
const SESSION_ID = 'bug-20260816-002-live-empty'
const CAPTURE_SIZE = { width: 760, height: 112 }
const ANSWER_SLOT_SIZE = { width: 560, height: 40 }
const PIXEL_THRESHOLD = 8
const MAX_ANSWER_SLOT_CHANGED_RATIO = 0.01
const REPORT_PATH = path.join(OUTPUT, 'report.json')
const RED_REPORT_PATH = path.join(OUTPUT, 'report-red-whole-message-contaminated.json')

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function round(value) {
  return Math.round(value * 100) / 100
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

function isLoopbackOrEmbedded(rawUrl) {
  try {
    const url = new URL(rawUrl)
    if (['about:', 'blob:', 'data:'].includes(url.protocol)) return true
    return ['127.0.0.1', 'localhost', '::1'].includes(url.hostname)
  } catch {
    return false
  }
}

async function installLoopbackFailClosed(page) {
  const blocked = []
  await page.route('**/*', async (route) => {
    const request = route.request()
    if (isLoopbackOrEmbedded(request.url())) return route.continue()
    blocked.push({ url: request.url(), resourceType: request.resourceType() })
    return route.abort('blockedbyclient')
  })
  page.on('websocket', (socket) => {
    if (!isLoopbackOrEmbedded(socket.url())) {
      blocked.push({ url: socket.url(), resourceType: 'websocket' })
    }
  })
  return blocked
}

async function waitForURL(url, child, logs) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Local server exited before readiness: ${logs.join('').slice(-4000)}`)
    }
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // 本地服务尚未监听，继续短轮询。
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Local server readiness timeout: ${url}`)
}

async function startServer(command, args, cwd, readyURL) {
  const logs = []
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => logs.push(String(chunk)))
  child.stderr.on('data', (chunk) => logs.push(String(chunk)))
  await waitForURL(readyURL, child, logs)
  return { child, logs }
}

async function stopServer(server) {
  if (!server || server.child.exitCode !== null) return
  server.child.kill('SIGTERM')
  await Promise.race([
    new Promise((resolve) => server.child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ])
  if (server.child.exitCode === null) server.child.kill('SIGKILL')
}

function appConfig() {
  return {
    general: { language: 'zh-CN', welcomeCompleted: true },
    knowledge: { enabled: true },
    llm: {
      defaultModel: 'fixture-model',
      defaultProviderId: 'fixture-provider-id',
      routing: { enabled: false, strategy: 'cost-aware' },
      cache: { enabled: false },
      providers: [
        {
          id: 'fixture-provider-id',
          providerInstanceId: `pvd_v1_${'f'.repeat(32)}`,
          backendKey: 'fixture-provider',
          name: 'Fixture Provider',
          type: 'openai',
          enabled: true,
          apiKey: 'fixture-redacted',
          baseUrl: 'https://example.invalid/v1',
          selectedModelId: 'fixture-model',
          models: [
            {
              id: 'fixture-model',
              name: 'Fixture Model',
              capabilities: ['text'],
              reasoningSupport: 'supported',
            },
          ],
        },
      ],
    },
  }
}

function backendConfig() {
  return {
    default: 'fixture-provider',
    routing: { enabled: false, strategy: 'cost-aware' },
    cache: { enabled: false },
    providers: {
      'fixture-provider': {
        provider_instance_id: `pvd_v1_${'f'.repeat(32)}`,
        display_name: 'Fixture Provider',
        type: 'openai',
        enabled: true,
        compatible: 'openai',
        api_key: 'fixture-redacted',
        base_url: 'https://example.invalid/v1',
        model: 'fixture-model',
        models: ['fixture-model'],
        model_specs: [
          {
            id: 'fixture-model',
            display_name: 'Fixture Model',
            capabilities: ['text'],
            reasoning_support: 'supported',
          },
        ],
      },
    },
  }
}

async function prepareImplementationPage(browser) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    colorScheme: 'light',
  })
  const page = await context.newPage()
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'light' })
  const blocked = await installLoopbackFailClosed(page)
  const config = appConfig()

  await page.addInitScript(
    ({ sessionId, sourceConfig }) => {
      localStorage.clear()
      sessionStorage.clear()
      localStorage.setItem('hc-theme', 'light')
      localStorage.setItem('hc-locale', 'zh-CN')
      localStorage.setItem('hexclaw:welcomeRedirectDone', '1')
      sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
      localStorage.setItem('hexclaw_lastSessionId', sessionId)
      localStorage.setItem('app_config', JSON.stringify(sourceConfig))
      localStorage.setItem('hexclaw_sessionDeepThinking', JSON.stringify({ [sessionId]: { mode: 'off' } }))

      class DelayedFirstChunkWebSocket extends EventTarget {
        static CONNECTING = 0
        static OPEN = 1
        static CLOSING = 2
        static CLOSED = 3
        readyState = DelayedFirstChunkWebSocket.CONNECTING
        onopen = null
        onmessage = null
        onerror = null
        onclose = null

        constructor(url) {
          super()
          this.url = url
          setTimeout(() => {
            this.readyState = DelayedFirstChunkWebSocket.OPEN
            const event = new Event('open')
            this.onopen?.(event)
            this.dispatchEvent(event)
          }, 0)
        }

        // 所有 message 帧均故意保持未完成，确保截图发生在首正文到达前。
        send(raw) {
          try {
            const payload = JSON.parse(raw)
            if (payload.type === 'message') {
              window.__bug20260816002SentMessage = {
                type: payload.type,
                session_id: payload.session_id,
                has_content: Boolean(payload.content),
              }
            }
          } catch {
            // 心跳等非 JSON 数据不影响此状态门。
          }
        }

        close() {
          if (this.readyState === DelayedFirstChunkWebSocket.CLOSED) return
          this.readyState = DelayedFirstChunkWebSocket.CLOSED
          const event = new CloseEvent('close')
          this.onclose?.(event)
          this.dispatchEvent(event)
        }
      }

      Object.defineProperty(window, 'WebSocket', {
        configurable: true,
        writable: true,
        value: DelayedFirstChunkWebSocket,
      })
    },
    { sessionId: SESSION_ID, sourceConfig: config },
  )

  await page.route('http://localhost:11434/**', (route) => json(route, { models: [] }))
  await page.route('**/health', (route) => json(route, { status: 'healthy' }))
  await page.route('**/_hexclaw/**', async (route) => {
    const requestURL = new URL(route.request().url())
    const apiPath = requestURL.pathname.replace(/^\/_hexclaw/, '')
    const method = route.request().method()
    if (apiPath === '/api/v1/config') return json(route, config)
    if (apiPath === '/api/v1/config/llm') return json(route, backendConfig())
    if (apiPath === '/api/v1/ollama/status') {
      return json(route, { running: false, associated: false, models: [], model_count: 0 })
    }
    if (apiPath === '/api/v1/sessions' && method === 'GET') {
      return json(route, {
        sessions: [
          {
            id: SESSION_ID,
            title: '首正文未到',
            created_at: '2026-08-22T00:00:00.000Z',
            updated_at: '2026-08-22T00:00:00.000Z',
            message_count: 0,
          },
        ],
        total: 1,
      })
    }
    if (apiPath === `/api/v1/sessions/${SESSION_ID}/messages` && method === 'GET') {
      return json(route, { messages: [], total: 0 })
    }
    if (apiPath === `/api/v1/sessions/${SESSION_ID}/artifacts`) {
      return json(route, { artifacts: [], total: 0 })
    }
    if (apiPath === '/api/v1/streams/active') return json(route, { streams: [], total: 0 })
    if (apiPath === '/api/v1/agents') return json(route, { agents: [], total: 0, default: '' })
    if (apiPath === '/api/v1/agents/rules') return json(route, { rules: [], total: 0 })
    if (apiPath === '/api/v1/roles') return json(route, { roles: [], total: 0 })
    if (apiPath === '/api/v1/skills') return json(route, { skills: [], total: 0 })
    return json(route, {})
  })

  await page.goto(IMPLEMENTATION_URL, { waitUntil: 'domcontentloaded' })
  const input = page.getByTestId('chat-input')
  await input.waitFor({ state: 'visible', timeout: 15_000 })
  await input.fill('捕获首正文到达前状态')
  const send = page.getByTestId('chat-send')
  await send.waitFor({ state: 'visible' })
  await send.click()
  const pending = page.getByTestId('chat-assistant-pending')
  await pending.waitFor({ state: 'visible', timeout: 15_000 })
  await page.locator('.hc-assistant-run-status').waitFor({ state: 'visible', timeout: 15_000 })
  await page.waitForTimeout(150)
  return { context, page, blocked }
}

async function preparePrototypePage(browser) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    colorScheme: 'light',
  })
  const page = await context.newPage()
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'light' })
  const blocked = await installLoopbackFailClosed(page)
  await page.goto(PROTOTYPE_URL, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => {
    window.setChatReasoningPrototypeState({
      surface: 'chat',
      request: 'off',
      support: 'unknown',
      execution: 'unknown',
      phase: 'preparing',
    })
  })
  await page.locator('[data-reasoning-fixture-message]').waitFor({ state: 'visible' })
  await page
    .locator('[data-reasoning-status-host] [data-component="AssistantRunStatus"]')
    .waitFor({ state: 'visible' })
  await page.waitForTimeout(150)
  return { context, page, blocked }
}

async function prepareComparableFrame(page, source) {
  return page.evaluate((sourceName) => {
    const isReference = sourceName === 'reference'
    const status = document.querySelector(
      isReference
        ? '[data-reasoning-status-host] > [data-component="AssistantRunStatus"]'
        : '[data-testid="chat-assistant-pending"] .hc-assistant-run-status',
    )
    if (!status) throw new Error('Comparable assistant status is missing')
    const frame = document.createElement('main')
    frame.id = 'bug-20260816-002-comparable-frame'
    frame.dataset.source = sourceName
    const answerSlot = document.createElement('div')
    answerSlot.dataset.liveEmptyAnswerSlot = 'true'
    frame.append(status, answerSlot)
    document.body.replaceChildren(frame)
    document.documentElement.dataset.theme = 'light'
    const style = document.createElement('style')
    style.textContent = `
      html, body {
        margin: 0 !important;
        width: 760px;
        height: 112px;
        overflow: hidden;
        background: var(--hc-bg-main) !important;
      }
      #bug-20260816-002-comparable-frame {
        box-sizing: border-box;
        width: 760px;
        height: 112px;
        padding: 16px;
        overflow: hidden;
        background: var(--hc-bg-main);
        color: var(--hc-text-primary);
        font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text', 'Helvetica Neue', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Segoe UI', sans-serif;
      }
      [data-live-empty-answer-slot] {
        width: 560px;
        height: 40px;
        background: transparent;
        border: 0;
      }
    `
    document.head.append(style)
    return true
  }, source)
}

async function inspectComparableFrame(page, source) {
  return page.evaluate((sourceName) => {
    const isReference = sourceName === 'reference'
    const root = document.querySelector(
      '#bug-20260816-002-comparable-frame > [data-component="AssistantRunStatus"]',
    )
    const visual = isReference ? root?.querySelector('.think-summary') : root
    const spinner = isReference
      ? root?.querySelector('.ti')
      : root?.querySelector('.hc-assistant-run-status__spinner')
    const slot = document.querySelector('[data-live-empty-answer-slot]')
    const clean = (value) => Math.round(value * 100) / 100
    const box = (element) => {
      if (!element) return null
      const rect = element.getBoundingClientRect()
      return {
        x: clean(rect.x),
        y: clean(rect.y),
        width: clean(rect.width),
        height: clean(rect.height),
        top: clean(rect.top),
        right: clean(rect.right),
        bottom: clean(rect.bottom),
        left: clean(rect.left),
      }
    }
    const read = (element) => {
      if (!element) return null
      const style = getComputedStyle(element)
      return {
        display: style.display,
        alignItems: style.alignItems,
        maxWidth: style.maxWidth,
        color: style.color,
        backgroundColor: style.backgroundColor,
        border: style.border,
        borderRadius: style.borderRadius,
        padding: style.padding,
        margin: style.margin,
        gap: style.gap,
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        lineHeight: style.lineHeight,
        animationName: style.animationName,
      }
    }
    return {
      source: sourceName,
      frame: { box: box(document.querySelector('#bug-20260816-002-comparable-frame')) },
      root: { box: box(root), style: read(root) },
      visual: {
        box: box(visual),
        style: read(visual),
        text: visual?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
        role: root?.getAttribute('role') ?? null,
        ariaLive: root?.getAttribute('aria-live') ?? null,
        ariaAtomic: root?.getAttribute('aria-atomic') ?? null,
      },
      spinner: { box: box(spinner), style: read(spinner), ariaHidden: spinner?.getAttribute('aria-hidden') ?? null },
      answerSlot: { box: box(slot), style: read(slot), childCount: slot?.childElementCount ?? -1 },
      composite: {
        display: read(visual)?.display,
        alignItems: read(visual)?.alignItems,
        maxWidth: read(root)?.maxWidth,
        color: read(visual)?.color,
        padding: read(visual)?.padding,
        margin: read(root)?.margin,
        gap: read(visual)?.gap,
        fontFamily: read(visual)?.fontFamily,
        fontSize: read(visual)?.fontSize,
        fontWeight: read(visual)?.fontWeight,
        lineHeight: read(visual)?.lineHeight,
      },
    }
  }, source)
}

async function inspect(page, source) {
  return page.evaluate(async (sourceName) => {
    const clean = (value) => Math.round(value * 100) / 100
    const box = (element) => {
      if (!element) return null
      const rect = element.getBoundingClientRect()
      return {
        x: clean(rect.x),
        y: clean(rect.y),
        width: clean(rect.width),
        height: clean(rect.height),
        top: clean(rect.top),
        right: clean(rect.right),
        bottom: clean(rect.bottom),
        left: clean(rect.left),
      }
    }
    const style = (element, pseudo = null) => {
      if (!element) return null
      const computed = getComputedStyle(element, pseudo)
      return {
        display: computed.display,
        visibility: computed.visibility,
        opacity: computed.opacity,
        color: computed.color,
        backgroundColor: computed.backgroundColor,
        border: computed.border,
        borderRadius: computed.borderRadius,
        boxShadow: computed.boxShadow,
        padding: computed.padding,
        margin: computed.margin,
        gap: computed.gap,
        fontFamily: computed.fontFamily,
        fontSize: computed.fontSize,
        fontWeight: computed.fontWeight,
        lineHeight: computed.lineHeight,
        content: computed.content,
      }
    }
    const isReference = sourceName === 'reference'
    const message = document.querySelector(
      isReference ? '[data-reasoning-fixture-message]' : '[data-testid="chat-assistant-pending"]',
    )
    const body = message?.querySelector(isReference ? '.msg-body' : '.hc-msg__body') ?? null
    const status = message?.querySelector(
      isReference
        ? '[data-reasoning-status-host] [data-component="AssistantRunStatus"]'
        : '.hc-assistant-run-status',
    ) ?? null
    const answer = isReference
      ? message?.querySelector('[data-reasoning-answer]') ?? null
      : message?.querySelector('.hc-msg__bubble-wrap') ?? null
    const emptyCard = isReference
      ? message?.querySelector('.hc-msg__bubble--empty') ?? null
      : message?.querySelector('.hc-msg__bubble--empty') ?? null
    let stream = null
    if (!isReference) {
      const module = await import('/src/stores/chat.ts')
      const store = module.useChatStore()
      const current = store.activeStreams?.[store.currentSessionId ?? ''] ?? null
      stream = current
        ? {
            live: true,
            sessionId: current.sessionId,
            assistantMessageId: current.assistantMessageId,
            content: current.content,
            state: current.state,
          }
        : { live: false }
    }
    return {
      source: sourceName,
      message: {
        box: box(message),
        style: style(message),
        text: message?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      },
      body: { box: box(body), style: style(body) },
      status: status
        ? {
            box: box(status),
            style: style(status),
            text: status.textContent?.replace(/\s+/g, ' ').trim() ?? '',
            role: status.getAttribute('role'),
            ariaLive: status.getAttribute('aria-live'),
            ariaAtomic: status.getAttribute('aria-atomic'),
            component: status.getAttribute('data-component'),
            request: status.getAttribute('data-reasoning-request'),
            support: status.getAttribute('data-reasoning-support'),
            execution: status.getAttribute('data-reasoning-execution'),
          }
        : null,
      answer: {
        exists: Boolean(answer),
        visible: Boolean(answer && getComputedStyle(answer).display !== 'none'),
        hiddenAttribute: answer?.hasAttribute('hidden') ?? false,
        box: box(answer),
        style: style(answer),
      },
      emptyCard: {
        count: message?.querySelectorAll('.hc-msg__bubble--empty').length ?? 0,
        box: box(emptyCard),
        style: style(emptyCard),
        before: style(emptyCard, '::before'),
      },
      bubbleWrapCount: message?.querySelectorAll('.hc-msg__bubble-wrap').length ?? 0,
      visiblePrototypeBubbleCount: isReference
        ? Array.from(message?.querySelectorAll('.bubble.bot') ?? []).filter(
            (element) => getComputedStyle(element).display !== 'none',
          ).length
        : null,
      stream,
      sentMessage: isReference ? null : (window.__bug20260816002SentMessage ?? null),
      prototypeState: isReference
        ? {
            phase: message?.getAttribute('data-request-phase'),
            request: message?.getAttribute('data-reasoning-request'),
            support: message?.getAttribute('data-reasoning-support'),
            execution: message?.getAttribute('data-reasoning-execution'),
          }
        : null,
    }
  }, source)
}

function clipFromAnchor(anchor, size) {
  return {
    x: Math.max(0, Math.min(VIEWPORT.width - size.width, round(anchor.x))),
    y: Math.max(0, Math.min(VIEWPORT.height - size.height, round(anchor.y))),
    width: size.width,
    height: size.height,
  }
}

async function capture(page, clip, filename) {
  await page.screenshot({ path: path.join(OUTPUT, filename), clip })
}

async function pixelDiff(page, referencePath, implementationPath, diffPath) {
  const [reference, implementation] = await Promise.all([
    readFile(referencePath, 'base64'),
    readFile(implementationPath, 'base64'),
  ])
  const result = await page.evaluate(
    async ({ referencePng, implementationPng, threshold }) => {
      const load = (base64) =>
        new Promise((resolve, reject) => {
          const image = new Image()
          image.onload = () => resolve(image)
          image.onerror = reject
          image.src = `data:image/png;base64,${base64}`
        })
      const [left, right] = await Promise.all([load(referencePng), load(implementationPng)])
      if (left.width !== right.width || left.height !== right.height) {
        throw new Error('Screenshot dimensions differ')
      }
      const width = left.width
      const height = left.height
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d')
      context.drawImage(left, 0, 0)
      const leftPixels = context.getImageData(0, 0, width, height).data
      context.clearRect(0, 0, width, height)
      context.drawImage(right, 0, 0)
      const rightPixels = context.getImageData(0, 0, width, height).data
      const output = context.createImageData(width, height)
      let changed = 0
      let minX = width
      let minY = height
      let maxX = -1
      let maxY = -1
      for (let index = 0; index < leftPixels.length; index += 4) {
        const delta = Math.max(
          Math.abs(leftPixels[index] - rightPixels[index]),
          Math.abs(leftPixels[index + 1] - rightPixels[index + 1]),
          Math.abs(leftPixels[index + 2] - rightPixels[index + 2]),
          Math.abs(leftPixels[index + 3] - rightPixels[index + 3]),
        )
        const pixel = index / 4
        const x = pixel % width
        const y = Math.floor(pixel / width)
        if (delta > threshold) {
          changed += 1
          minX = Math.min(minX, x)
          minY = Math.min(minY, y)
          maxX = Math.max(maxX, x)
          maxY = Math.max(maxY, y)
          output.data[index] = 255
          output.data[index + 1] = 35
          output.data[index + 2] = 35
        } else {
          const gray = Math.round(
            (leftPixels[index] * 0.299 + leftPixels[index + 1] * 0.587 + leftPixels[index + 2] * 0.114) * 0.45,
          )
          output.data[index] = gray
          output.data[index + 1] = gray
          output.data[index + 2] = gray
        }
        output.data[index + 3] = 255
      }
      context.putImageData(output, 0, 0)
      return {
        png: canvas.toDataURL('image/png').split(',')[1],
        width,
        height,
        threshold,
        changed_pixels: changed,
        total_pixels: width * height,
        changed_pixel_ratio: changed / (width * height),
        changed_bbox: changed ? [minX, minY, maxX + 1, maxY + 1] : null,
      }
    },
    { referencePng: reference, implementationPng: implementation, threshold: PIXEL_THRESHOLD },
  )
  await writeFile(diffPath, Buffer.from(result.png, 'base64'))
  delete result.png
  return result
}

let viteServer
let prototypeServer
let browser
let referenceContext
let implementationContext

try {
  await mkdir(OUTPUT, { recursive: true })
  try {
    await access(REPORT_PATH)
    try {
      await access(RED_REPORT_PATH)
    } catch {
      await copyFile(REPORT_PATH, RED_REPORT_PATH)
    }
  } catch {
    // 首次运行没有旧报告，不生成空的 RED 证据。
  }
  viteServer = await startServer(
    path.join(ROOT, 'node_modules/.bin/vite'),
    ['--host', '127.0.0.1', '--port', '27102', '--strictPort'],
    ROOT,
    IMPLEMENTATION_URL,
  )
  prototypeServer = await startServer(
    'python3',
    ['-m', 'http.server', '27112', '--bind', '127.0.0.1', '--directory', path.join(DOCS_ROOT, 'prototype')],
    ROOT,
    PROTOTYPE_URL,
  )

  browser = await chromium.launch({ headless: true })
  const referencePrepared = await preparePrototypePage(browser)
  const implementationPrepared = await prepareImplementationPage(browser)
  referenceContext = referencePrepared.context
  implementationContext = implementationPrepared.context
  const referencePage = referencePrepared.page
  const implementationPage = implementationPrepared.page

  const [referenceState, implementationState] = await Promise.all([
    inspect(referencePage, 'reference'),
    inspect(implementationPage, 'implementation'),
  ])

  assert(referenceState.prototypeState?.phase === 'preparing', 'Prototype phase is not preparing')
  assert(referenceState.answer.exists, 'Prototype answer host is missing')
  assert(!referenceState.answer.visible, 'Prototype answer must be hidden before first content')
  assert(referenceState.visiblePrototypeBubbleCount === 0, 'Prototype shows a visible answer bubble')
  assert(implementationState.stream?.live === true, 'Current source does not expose a live stream')
  assert(implementationState.stream?.content === '', 'Current live stream content is not empty')
  assert(implementationState.bubbleWrapCount === 0, 'Current source renders an answer bubble before first content')
  assert(implementationState.emptyCard.count === 0, 'Current source renders an empty-reply card while live')
  assert(referenceState.status?.text === implementationState.status?.text, 'Run status text differs')
  assert(referenceState.status?.role === implementationState.status?.role, 'Run status role differs')
  assert(referenceState.status?.ariaLive === implementationState.status?.ariaLive, 'Run status aria-live differs')
  assert(referenceState.status?.support === implementationState.status?.support, 'Run status support differs')

  // 原型公开状态 API 不拥有其完成态示例的来源、记忆和工具 siblings；视觉门只比较
  // 两端共同拥有的运行状态宿主，并用独立空槽保留“首正文尚未出现”的可见不变量。
  await Promise.all([
    prepareComparableFrame(referencePage, 'reference'),
    prepareComparableFrame(implementationPage, 'implementation'),
  ])
  const [referenceComparable, implementationComparable] = await Promise.all([
    inspectComparableFrame(referencePage, 'reference'),
    inspectComparableFrame(implementationPage, 'implementation'),
  ])

  const files = {
    referenceOwnedState: path.join(OUTPUT, 'reference-live-empty-owned-state.png'),
    implementationOwnedState: path.join(OUTPUT, 'current-live-empty-owned-state.png'),
    ownedStateDiff: path.join(OUTPUT, 'diff-live-empty-owned-state.png'),
    redReport: RED_REPORT_PATH,
  }
  const frameClip = { x: 0, y: 0, width: 760, height: 112 }
  await capture(referencePage, frameClip, path.basename(files.referenceOwnedState))
  await capture(implementationPage, frameClip, path.basename(files.implementationOwnedState))
  const ownedStateDiff = await pixelDiff(
    implementationPage,
    files.referenceOwnedState,
    files.implementationOwnedState,
    files.ownedStateDiff,
  )

  const artifactHashes = Object.fromEntries(
    await Promise.all(
      Object.entries(files).map(async ([name, filename]) => {
        const bytes = await readFile(filename)
        return [name, { file: path.basename(filename), bytes: bytes.length, sha256: sha256(bytes) }]
      }),
    ),
  )
  const semanticPass =
    !referenceState.answer.visible &&
    referenceState.visiblePrototypeBubbleCount === 0 &&
    implementationState.stream?.live === true &&
    implementationState.stream?.content === '' &&
    implementationState.bubbleWrapCount === 0 &&
    implementationState.emptyCard.count === 0 &&
    referenceState.status?.text === implementationState.status?.text &&
    referenceState.status?.support === implementationState.status?.support &&
    referenceComparable.answerSlot.childCount === 0 &&
    implementationComparable.answerSlot.childCount === 0
  const comparableStylePass =
    JSON.stringify(referenceComparable.composite) === JSON.stringify(implementationComparable.composite) &&
    referenceComparable.visual.text === implementationComparable.visual.text &&
    referenceComparable.visual.role === implementationComparable.visual.role &&
    referenceComparable.visual.ariaLive === implementationComparable.visual.ariaLive &&
    referenceComparable.visual.ariaAtomic === implementationComparable.visual.ariaAtomic &&
    JSON.stringify(referenceComparable.spinner.box) === JSON.stringify(implementationComparable.spinner.box) &&
    referenceComparable.spinner.style.border === implementationComparable.spinner.style.border &&
    referenceComparable.spinner.style.borderRadius === implementationComparable.spinner.style.borderRadius
  const ownedStatePixelPass = ownedStateDiff.changed_pixel_ratio <= MAX_ANSWER_SLOT_CHANGED_RATIO
  const report = {
    schema: 'bug-20260816-002-live-empty-visual-v2',
    generated_at: new Date().toISOString(),
    verdict: semanticPass && comparableStylePass && ownedStatePixelPass ? 'PASS' : 'NOT_PASS',
    comparable: true,
    fixture: {
      viewport: VIEWPORT,
      device_scale_factor: 1,
      locale: 'zh-CN',
      timezone: 'Asia/Shanghai',
      color_scheme: 'light',
      reduced_motion: 'reduce',
      prototype_state: 'AssistantRunStatus.generating.reasoning-off + support=unknown + phase=preparing',
      implementation_state: 'real ChatView + delayed first WebSocket chunk',
      comparison_scope: 'state-machine-owned status host + explicit empty answer slot',
      excluded_prototype_siblings: 'completed-answer source, memory, tool and footer fixture nodes',
      provider_calls: 0,
      im_sends: 0,
      installed_app_launches: 0,
    },
    gates: {
      semantic_pass: semanticPass,
      comparable_style_pass: comparableStylePass,
      owned_state_pixel_pass: ownedStatePixelPass,
      max_owned_state_changed_pixel_ratio: MAX_ANSWER_SLOT_CHANGED_RATIO,
      blocked_external_requests: [
        ...referencePrepared.blocked,
        ...implementationPrepared.blocked,
      ],
    },
    reference: referenceState,
    implementation: implementationState,
    comparable_state: {
      reference: referenceComparable,
      implementation: implementationComparable,
    },
    captures: {
      owned_state: {
        reference_clip: frameClip,
        implementation_clip: frameClip,
        pixel_diff: ownedStateDiff,
      },
    },
    artifacts: artifactHashes,
    source_hashes: {
      prototype_app_html: sha256(await readFile(path.join(DOCS_ROOT, 'prototype/app.html'))),
      chat_view_vue: sha256(await readFile(path.join(ROOT, 'src/views/ChatView.vue'))),
      runner: sha256(await readFile(fileURLToPath(import.meta.url))),
    },
  }
  await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify({ verdict: report.verdict, output: OUTPUT, ownedStateDiff }, null, 2))
  if (report.verdict !== 'PASS') process.exitCode = 1
} finally {
  await implementationContext?.close().catch(() => {})
  await referenceContext?.close().catch(() => {})
  await browser?.close().catch(() => {})
  await stopServer(prototypeServer)
  await stopServer(viteServer)
}
