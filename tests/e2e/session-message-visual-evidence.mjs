/**
 * 会话列表与消息操作的本地视觉证据。
 *
 * 仅使用浏览器内 mock：app.html 为参考，Vite 当前源码为实现；不访问真实 sidecar。
 * 运行前启动本地 Vite 与 prototype 静态服务，或通过环境变量覆盖两个 URL。
 */
import { chromium } from '@playwright/test'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const outputDirectory = process.env.HEX_SESSION_MESSAGE_VISUAL_EVIDENCE_DIR?.trim()
  ? path.resolve(process.env.HEX_SESSION_MESSAGE_VISUAL_EVIDENCE_DIR)
  : path.join(root, 'test-results', 'session-message-visual-20260820')
const prototypeUrl =
  process.env.HEX_VISUAL_PROTOTYPE_URL?.trim() || 'http://127.0.0.1:16070/app.html'
const implementationUrl =
  process.env.HEX_VISUAL_IMPLEMENTATION_URL?.trim() || 'http://127.0.0.1:5173'
const viewport = { width: 1440, height: 1000 }
const visualSessionId = 's-visual'
const messageSessionId = 's-message-visual'
const maxChangedPixelRatio = Number(process.env.HEX_SESSION_MESSAGE_MAX_PIXEL_RATIO ?? '0.01')
const prototypeArtifactPath = path.resolve(root, '../hexclaw-docs/prototype/app.html')

function currentShanghaiDate() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

// 参考原型的会话元数据展示为当天 14:32。fixture 固定同一显示状态而非依赖执行日期。
const visualTimestamp = `${currentShanghaiDate()}T06:32:00.000Z`

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

function isLoopbackOrEmbeddedUrl(rawUrl) {
  try {
    const url = new URL(rawUrl)
    if (['about:', 'blob:', 'data:'].includes(url.protocol)) return true
    return ['127.0.0.1', '::1', 'localhost'].includes(url.hostname)
  } catch {
    return false
  }
}

async function installLoopbackFailClosed(page) {
  const blockedRequests = []
  const block = (url, resourceType) => {
    blockedRequests.push({ url, resourceType })
  }
  await page.route('**/*', async (route) => {
    const request = route.request()
    if (isLoopbackOrEmbeddedUrl(request.url())) return route.continue()
    block(request.url(), request.resourceType())
    return route.abort('blockedbyclient')
  })
  page.on('websocket', (socket) => {
    if (!isLoopbackOrEmbeddedUrl(socket.url())) block(socket.url(), 'websocket')
  })
  return blockedRequests
}

async function sha256(file) {
  return createHash('sha256')
    .update(await readFile(file))
    .digest('hex')
}

function rounded(value) {
  return Math.round(value * 100) / 100
}

function stableClip(box, width, height) {
  return {
    x: Math.max(0, Math.min(viewport.width - width, rounded(box.x))),
    y: Math.max(0, Math.min(viewport.height - height, rounded(box.y))),
    width,
    height,
  }
}

async function screenshotFromBox(page, selector, filename, width, height) {
  const locator = page.locator(selector)
  await locator.scrollIntoViewIfNeeded()
  const box = await locator.boundingBox()
  if (!box) throw new Error(`缺少截图目标：${selector}`)
  await page.screenshot({
    path: path.join(outputDirectory, filename),
    clip: stableClip(box, width, height),
  })
}

async function inspect(page, selectors) {
  return await page.evaluate((requestedSelectors) => {
    const styleFields = [
      'display',
      'visibility',
      'opacity',
      'width',
      'height',
      'minHeight',
      'marginLeft',
      'marginTop',
      'marginRight',
      'marginBottom',
      'padding',
      'gap',
      'fontFamily',
      'fontSize',
      'fontWeight',
      'fontVariantNumeric',
      'letterSpacing',
      'lineHeight',
      'textAlign',
      'color',
      'backgroundColor',
      'border',
      'borderRadius',
      'boxShadow',
      'whiteSpace',
      'overflow',
      'pointerEvents',
      'transform',
      'scrollbarWidth',
      'stroke',
      'strokeWidth',
      'strokeLinecap',
      'strokeLinejoin',
      'fill',
    ]
    const readStyle = (style, fields = styleFields) =>
      Object.fromEntries(fields.map((field) => [field, style[field]]))
    const svgSignature = (svg) => {
      if (!svg) return null
      const visualAttributeNames = new Set([
        'd',
        'x',
        'y',
        'x1',
        'x2',
        'y1',
        'y2',
        'width',
        'height',
        'rx',
        'ry',
        'cx',
        'cy',
        'r',
        'points',
        'fill',
        'stroke',
        'stroke-width',
        'stroke-linecap',
        'stroke-linejoin',
      ])
      return {
        viewBox: svg.getAttribute('viewBox') ?? '',
        geometry: Array.from(svg.children).map((child) => ({
          tagName: child.tagName.toLowerCase(),
          attributes: Object.fromEntries(
            Array.from(child.attributes)
              .filter((attribute) => visualAttributeNames.has(attribute.name))
              .map((attribute) => [attribute.name, attribute.value]),
          ),
        })),
        style: readStyle(getComputedStyle(svg), [
          'width',
          'height',
          'stroke',
          'strokeWidth',
          'strokeLinecap',
          'strokeLinejoin',
          'fill',
        ]),
      }
    }
    const read = (selector) => {
      const element = document.querySelector(selector)
      if (!element) return null
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      const svg = element instanceof SVGElement ? element : element.querySelector('svg')
      const directButtons = Array.from(element.children)
        .filter((child) => child instanceof HTMLButtonElement)
        .map((button) => ({
          ariaLabel: button.getAttribute('aria-label') ?? '',
          title: button.getAttribute('title') ?? '',
          disabled: button.disabled,
          icon: svgSignature(button.querySelector('svg')),
        }))
      return {
        text:
          element.tagName === 'HTML'
            ? ''
            : (element.textContent?.replace(/\s+/g, ' ').trim() ?? ''),
        value:
          element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
            ? element.value
            : null,
        hidden: element.hidden,
        ariaHidden: element.getAttribute('aria-hidden'),
        box: {
          x: Math.round(rect.x * 100) / 100,
          y: Math.round(rect.y * 100) / 100,
          width: Math.round(rect.width * 100) / 100,
          height: Math.round(rect.height * 100) / 100,
          top: Math.round(rect.top * 100) / 100,
          right: Math.round(rect.right * 100) / 100,
          bottom: Math.round(rect.bottom * 100) / 100,
          left: Math.round(rect.left * 100) / 100,
        },
        style: readStyle(style),
        pseudo: {
          selection: readStyle(getComputedStyle(element, '::selection'), [
            'backgroundColor',
            'color',
          ]),
          webkitScrollbar: readStyle(getComputedStyle(element, '::-webkit-scrollbar'), [
            'width',
            'height',
            'backgroundColor',
          ]),
          webkitScrollbarThumb: readStyle(getComputedStyle(element, '::-webkit-scrollbar-thumb'), [
            'backgroundColor',
          ]),
        },
        structure:
          element.tagName === 'HTML'
            ? { childCount: 0, children: [], directButtons: [] }
            : {
                childCount: element.children.length,
                children: Array.from(element.children).map((child) => ({
                  tagName: child.tagName.toLowerCase(),
                  className: child.getAttribute('class') ?? '',
                  text: child.textContent?.replace(/\s+/g, ' ').trim() ?? '',
                })),
                directButtons,
              },
        svg: svgSignature(svg),
      }
    }
    return Object.fromEntries(requestedSelectors.map((selector) => [selector, read(selector)]))
  }, selectors)
}

function comparePseudo(reference, implementation, pairs) {
  const diffs = []
  for (const pair of pairs) {
    const referenceValue = reference[pair.reference]
    const implementationValue = implementation[pair.implementation]
    if (!referenceValue || !implementationValue) {
      diffs.push({
        target: pair.target,
        reason: 'missing-target',
        referencePresent: Boolean(referenceValue),
        implementationPresent: Boolean(implementationValue),
      })
      continue
    }
    for (const field of pair.fields) {
      const referenceField = referenceValue.pseudo[pair.pseudo][field]
      const implementationField = implementationValue.pseudo[pair.pseudo][field]
      if (referenceField !== implementationField) {
        diffs.push({
          target: pair.target,
          pseudo: pair.pseudo,
          field,
          reference: referenceField,
          implementation: implementationField,
        })
      }
    }
  }
  return diffs
}

function compareStyles(reference, implementation, pairs) {
  const diffs = []
  for (const pair of pairs) {
    const referenceValue = reference[pair.reference]
    const implementationValue = implementation[pair.implementation]
    if (!referenceValue || !implementationValue) {
      diffs.push({
        target: pair.target,
        reason: 'missing-target',
        referencePresent: Boolean(referenceValue),
        implementationPresent: Boolean(implementationValue),
      })
      continue
    }
    for (const field of pair.fields) {
      const referenceField = referenceValue.style[field]
      const implementationField = implementationValue.style[field]
      if (referenceField !== implementationField) {
        diffs.push({
          target: pair.target,
          field,
          reference: referenceField,
          implementation: implementationField,
        })
      }
    }
  }
  return diffs
}

async function pngToBitmap(input, output) {
  await execFileAsync('sips', ['-s', 'format', 'bmp', input, '--out', output], { cwd: root })
}

async function readBitmap(file) {
  const source = await readFile(file)
  if (source.toString('ascii', 0, 2) !== 'BM') throw new Error(`不是 BMP：${file}`)
  const pixelOffset = source.readUInt32LE(10)
  const width = source.readInt32LE(18)
  const rawHeight = source.readInt32LE(22)
  const bitsPerPixel = source.readUInt16LE(28)
  const compression = source.readUInt32LE(30)
  if (width <= 0 || rawHeight === 0 || ![24, 32].includes(bitsPerPixel) || compression !== 0) {
    throw new Error(`不支持的 BMP：${file}`)
  }
  const height = Math.abs(rawHeight)
  const bytesPerPixel = bitsPerPixel / 8
  const rowStride = Math.floor((bitsPerPixel * width + 31) / 32) * 4
  const pixels = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    const sourceY = rawHeight > 0 ? height - 1 - y : y
    const rowStart = pixelOffset + sourceY * rowStride
    for (let x = 0; x < width; x += 1) {
      const sourceIndex = rowStart + x * bytesPerPixel
      const targetIndex = (y * width + x) * 4
      pixels[targetIndex] = source[sourceIndex + 2]
      pixels[targetIndex + 1] = source[sourceIndex + 1]
      pixels[targetIndex + 2] = source[sourceIndex]
      pixels[targetIndex + 3] = 255
    }
  }
  return { width, height, pixels }
}

function bitmapBuffer(width, height, pixels) {
  const rowStride = Math.ceil((width * 3) / 4) * 4
  const imageSize = rowStride * height
  const output = Buffer.alloc(54 + imageSize)
  output.write('BM', 0, 'ascii')
  output.writeUInt32LE(output.length, 2)
  output.writeUInt32LE(54, 10)
  output.writeUInt32LE(40, 14)
  output.writeInt32LE(width, 18)
  output.writeInt32LE(height, 22)
  output.writeUInt16LE(1, 26)
  output.writeUInt16LE(24, 28)
  output.writeUInt32LE(imageSize, 34)
  for (let row = 0; row < height; row += 1) {
    const sourceY = height - 1 - row
    const rowStart = 54 + row * rowStride
    for (let x = 0; x < width; x += 1) {
      const sourceIndex = (sourceY * width + x) * 4
      const targetIndex = rowStart + x * 3
      output[targetIndex] = pixels[sourceIndex + 2]
      output[targetIndex + 1] = pixels[sourceIndex + 1]
      output[targetIndex + 2] = pixels[sourceIndex]
    }
  }
  return output
}

async function runPixelDiff(reference, implementation, diff) {
  const referenceBitmap = reference.replace(/\.png$/, '.bmp')
  const implementationBitmap = implementation.replace(/\.png$/, '.bmp')
  const diffBitmap = diff.replace(/\.png$/, '.bmp')
  await pngToBitmap(reference, referenceBitmap)
  await pngToBitmap(implementation, implementationBitmap)
  const referenceImage = await readBitmap(referenceBitmap)
  const implementationImage = await readBitmap(implementationBitmap)
  if (
    referenceImage.width !== implementationImage.width ||
    referenceImage.height !== implementationImage.height
  ) {
    throw new Error(
      `截图尺寸不一致：reference=${referenceImage.width}x${referenceImage.height}，implementation=${implementationImage.width}x${implementationImage.height}`,
    )
  }

  const threshold = 8
  const visibleDiff = Buffer.alloc(referenceImage.pixels.length)
  let changedPixels = 0
  let minX = referenceImage.width
  let minY = referenceImage.height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < referenceImage.height; y += 1) {
    for (let x = 0; x < referenceImage.width; x += 1) {
      const index = (y * referenceImage.width + x) * 4
      const changed =
        Math.abs(referenceImage.pixels[index] - implementationImage.pixels[index]) > threshold ||
        Math.abs(referenceImage.pixels[index + 1] - implementationImage.pixels[index + 1]) >
          threshold ||
        Math.abs(referenceImage.pixels[index + 2] - implementationImage.pixels[index + 2]) >
          threshold
      if (changed) {
        changedPixels += 1
        minX = Math.min(minX, x)
        minY = Math.min(minY, y)
        maxX = Math.max(maxX, x)
        maxY = Math.max(maxY, y)
        visibleDiff[index] = 255
        visibleDiff[index + 1] = 35
        visibleDiff[index + 2] = 35
      } else {
        const gray = Math.round(
          ((referenceImage.pixels[index] +
            referenceImage.pixels[index + 1] +
            referenceImage.pixels[index + 2]) /
            3) *
            0.45,
        )
        visibleDiff[index] = gray
        visibleDiff[index + 1] = gray
        visibleDiff[index + 2] = gray
      }
      visibleDiff[index + 3] = 255
    }
  }
  await writeFile(
    diffBitmap,
    bitmapBuffer(referenceImage.width, referenceImage.height, visibleDiff),
  )
  await execFileAsync('sips', ['-s', 'format', 'png', diffBitmap, '--out', diff], { cwd: root })
  return {
    width: referenceImage.width,
    height: referenceImage.height,
    threshold,
    changed_pixels: changedPixels,
    total_pixels: referenceImage.width * referenceImage.height,
    changed_pixel_ratio: changedPixels / (referenceImage.width * referenceImage.height),
    changed_bbox: maxX < 0 ? null : [minX, minY, maxX + 1, maxY + 1],
    decoder: 'sips-bmp-fallback',
  }
}

async function prepareImplementationPage(browser) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    colorScheme: 'light',
  })
  const page = await context.newPage()
  const blockedRequests = await installLoopbackFailClosed(page)
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'light' })

  await page.addInitScript(
    ({ sessionId }) => {
      localStorage.setItem('hexclaw:welcomeRedirectDone', '1')
      sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
      localStorage.setItem('hexclaw_lastSessionId', sessionId)
      localStorage.setItem('hc-theme', 'light')

      class BrowserMockWebSocket extends EventTarget {
        static CONNECTING = 0
        static OPEN = 1
        static CLOSING = 2
        static CLOSED = 3

        readyState = BrowserMockWebSocket.CONNECTING
        onopen = null
        onmessage = null
        onerror = null
        onclose = null

        constructor(url) {
          super()
          this.url = url
          setTimeout(() => {
            this.readyState = BrowserMockWebSocket.OPEN
            const event = new Event('open')
            this.onopen?.(event)
            this.dispatchEvent(event)
          }, 0)
        }

        send() {}

        close() {
          if (this.readyState === BrowserMockWebSocket.CLOSED) return
          this.readyState = BrowserMockWebSocket.CLOSED
          const event = new CloseEvent('close')
          this.onclose?.(event)
          this.dispatchEvent(event)
        }
      }

      Object.defineProperty(window, 'WebSocket', {
        configurable: true,
        writable: true,
        value: BrowserMockWebSocket,
      })
    },
    { sessionId: messageSessionId },
  )

  const messages = [
    {
      id: 'm-visual-user',
      role: 'user',
      content: '普通消息时间和操作布局的浏览器 mock 证据。',
      timestamp: '2026-08-20T06:09:00.000Z',
      created_at: '2026-08-20T06:09:00.000Z',
    },
    {
      id: 'm-visual-assistant',
      role: 'assistant',
      content: '普通助手消息。',
      timestamp: '2026-08-20T06:10:00.000Z',
      created_at: '2026-08-20T06:10:00.000Z',
      agent_name: '小王的辅导助手 · 五年级',
      metadata: {
        provider: 'HexClaw-GPT',
        model: 'gpt-5.6-sol',
      },
    },
  ]

  await page.route('http://localhost:11434/**', (route) => json(route, { models: [] }))
  await page.route('**/health', (route) => json(route, { status: 'healthy' }))
  await page.route('**/_hexclaw/**', async (route) => {
    const requestUrl = new URL(route.request().url())
    const apiPath = requestUrl.pathname.replace(/^\/_hexclaw/, '')
    const method = route.request().method()
    if (apiPath === '/api/v1/config/llm') {
      return json(route, {
        default: 'HexClaw-GPT',
        providers: {
          'HexClaw-GPT': {
            api_key: '',
            base_url: 'http://127.0.0.1:11434/v1',
            model: 'gpt-5.6-sol',
            models: ['gpt-5.6-sol'],
            compatible: '',
            tools_enabled: null,
            max_tools: 0,
          },
        },
        routing: { enabled: false, strategy: 'cost-aware' },
        cache: { enabled: false, similarity: 0.88, ttl: '24h', max_entries: 1000 },
      })
    }
    if (apiPath === '/api/v1/ollama/status') {
      return json(route, {
        running: true,
        version: 'mock',
        associated: true,
        model_count: 0,
        models: [],
      })
    }
    if (apiPath === '/api/v1/sessions' && method === 'GET') {
      return json(route, {
        sessions: [
          {
            id: messageSessionId,
            title: '普通消息布局',
            created_at: visualTimestamp,
            updated_at: visualTimestamp,
            message_count: messages.length,
          },
          {
            id: visualSessionId,
            title: '小数乘法讲解',
            created_at: visualTimestamp,
            updated_at: visualTimestamp,
            message_count: 2,
          },
        ],
        total: 1,
      })
    }
    if (apiPath === `/api/v1/sessions/${messageSessionId}/messages` && method === 'GET') {
      return json(route, { messages, total: messages.length })
    }
    if (apiPath === `/api/v1/sessions/${messageSessionId}/artifacts`) {
      return json(route, { artifacts: [], total: 0 })
    }
    if (apiPath === '/api/v1/streams/active') return json(route, { streams: [], total: 0 })
    if (apiPath === '/api/v1/agents') return json(route, { agents: [], total: 0, default: '' })
    if (apiPath === '/api/v1/agents/rules') return json(route, { rules: [], total: 0 })
    if (apiPath === '/api/v1/roles') return json(route, { roles: [], total: 0 })
    if (apiPath === '/api/v1/skills') return json(route, { skills: [], total: 0 })
    return json(route, {})
  })

  await page.goto(`${implementationUrl.replace(/\/$/, '')}/chat`, { waitUntil: 'domcontentloaded' })
  await page
    .locator(`[data-session-id="${visualSessionId}"]`)
    .waitFor({ state: 'visible', timeout: 15_000 })
  await page.locator('#msg-m-visual-assistant').waitFor({ state: 'visible', timeout: 15_000 })
  await page.waitForTimeout(350)
  return { context, page, blockedRequests }
}

async function preparePrototypePage(browser) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    colorScheme: 'light',
  })
  const page = await context.newPage()
  const blockedRequests = await installLoopbackFailClosed(page)
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'light' })
  await page.goto(prototypeUrl, { waitUntil: 'domcontentloaded' })
  await page
    .locator('.cs-item[data-session-id="decimal"]')
    .waitFor({ state: 'visible', timeout: 15_000 })
  await page.waitForTimeout(350)
  return { context, page, blockedRequests }
}

async function capturePrototypeStates(page) {
  const state = {}
  const session = page.locator('.cs-item[data-session-id="decimal"]')
  await session.hover()
  await page.waitForTimeout(200)
  state.sessionHover = await inspect(page, [
    'html',
    '.cs-item[data-session-id="decimal"]',
    '.cs-item[data-session-id="decimal"] .cs-pin',
    '.cs-item[data-session-id="decimal"] .cs-pin svg',
    '.cs-item[data-session-id="decimal"] .cs-more',
    '.cs-item[data-session-id="decimal"] .cs-more svg',
    '.cs-item[data-session-id="decimal"] .cs-m',
    '.cs-item[data-session-id="decimal"] .cs-m > span:first-child',
    '.cs-item[data-session-id="decimal"] .cs-cnt',
  ])
  await screenshotFromBox(
    page,
    '.cs-item[data-session-id="decimal"]',
    'reference-session-hover.png',
    280,
    58,
  )

  const renameRowHeightBefore = state.sessionHover['.cs-item[data-session-id="decimal"]'].box.height
  await session.locator('.cs-more').click()
  await page.getByRole('menuitem', { name: '重命名' }).click()
  await page
    .locator('.cs-item[data-session-id="decimal"] .cs-rename-input')
    .waitFor({ state: 'visible' })
  await page.waitForTimeout(100)
  state.rename = await inspect(page, [
    '.cs-item[data-session-id="decimal"]',
    '.cs-item[data-session-id="decimal"] .cs-rename-input',
    '.cs-item[data-session-id="decimal"] .cs-rename-clear',
    '.cs-item[data-session-id="decimal"] .cs-rename-clear svg',
    '.cs-item[data-session-id="decimal"] .cs-m',
    '.cs-item[data-session-id="decimal"] .cs-t',
  ])
  state.rename.rowHeightBefore = renameRowHeightBefore
  state.rename.rowHeightDelta = rounded(
    state.rename['.cs-item[data-session-id="decimal"]'].box.height - renameRowHeightBefore,
  )
  await screenshotFromBox(
    page,
    '.cs-item[data-session-id="decimal"]',
    'reference-session-rename.png',
    280,
    58,
  )

  const user = page.locator('.chat-thread > .msg.user').first()
  await user.hover()
  await page.waitForTimeout(200)
  state.userHover = await inspect(page, [
    '.chat-thread > .msg.user .msg-footer--user',
    '.chat-thread > .msg.user .msg-user-controls',
    '.chat-thread > .msg.user .msg-time',
    '.chat-thread > .msg.user .msg-actions--user',
  ])
  await screenshotFromBox(
    page,
    '.chat-thread > .msg.user .msg-footer--user',
    'reference-user-hover.png',
    170,
    40,
  )

  state.assistantFooter = await inspect(page, [
    '.chat-thread > .msg.bot .msg-footer',
    '.chat-thread > .msg.bot .msg-meta',
    '.chat-thread > .msg.bot .msg-actions--assistant',
    '.chat-thread > .msg.bot .msg-action-sep',
    '.chat-thread > .msg.bot .msg-time',
  ])
  await screenshotFromBox(
    page,
    '.chat-thread > .msg.bot .msg-footer',
    'reference-assistant-footer.png',
    500,
    40,
  )
  return state
}

async function captureImplementationStates(page) {
  const state = {}
  const sessionSelector = `[data-session-id="${visualSessionId}"]`
  const session = page.locator(sessionSelector)
  await session.hover()
  await page.waitForTimeout(200)
  state.sessionHover = await inspect(page, [
    'html',
    sessionSelector,
    `${sessionSelector} .hc-sessions__pin-action`,
    `${sessionSelector} .hc-sessions__pin-action svg`,
    `${sessionSelector} .hc-sessions__actions`,
    `${sessionSelector} .hc-sessions__actions svg`,
    `${sessionSelector} .hc-sessions__meta`,
    `${sessionSelector} .hc-sessions__time`,
    `${sessionSelector} .hc-sessions__count`,
  ])
  await screenshotFromBox(
    page,
    sessionSelector,
    'implementation-session-hover.png',
    280,
    58,
  )

  const renameRowHeightBefore = state.sessionHover[sessionSelector].box.height
  await session.locator('.hc-sessions__actions').click()
  await page.getByRole('menuitem', { name: '重命名' }).click()
  await session.locator('.hc-sessions__rename-input').waitFor({ state: 'visible' })
  await page.waitForTimeout(100)
  state.rename = await inspect(page, [
    sessionSelector,
    `${sessionSelector} .hc-sessions__rename-input`,
    `${sessionSelector} .hc-clearable-field__button`,
    `${sessionSelector} .hc-clearable-field__button svg`,
    `${sessionSelector} .hc-sessions__meta`,
    `${sessionSelector} .hc-sessions__title`,
  ])
  state.rename.rowHeightBefore = renameRowHeightBefore
  state.rename.rowHeightDelta = rounded(
    state.rename[sessionSelector].box.height - renameRowHeightBefore,
  )
  await screenshotFromBox(
    page,
    sessionSelector,
    'implementation-session-rename.png',
    280,
    58,
  )

  const user = page.locator('#msg-m-visual-user')
  await user.hover()
  await page.waitForTimeout(200)
  state.userHover = await inspect(page, [
    '#msg-m-visual-user .hc-msg__footer--right',
    '#msg-m-visual-user .hc-msg__actions-float',
    '#msg-m-visual-user .hc-msg__time',
    '#msg-m-visual-user .hc-msg-actions--user',
  ])
  await screenshotFromBox(
    page,
    '#msg-m-visual-user .hc-msg__footer--right',
    'implementation-user-hover.png',
    170,
    40,
  )

  state.assistantFooter = await inspect(page, [
    '#msg-m-visual-assistant .hc-msg__footer',
    '#msg-m-visual-assistant .hc-msg__meta',
    '#msg-m-visual-assistant .hc-msg-actions--assistant',
    '#msg-m-visual-assistant .hc-msg-actions__divider',
    '#msg-m-visual-assistant .hc-msg__time',
  ])
  await screenshotFromBox(
    page,
    '#msg-m-visual-assistant .hc-msg__footer',
    'implementation-assistant-footer.png',
    500,
    40,
  )
  return state
}

function semanticChecks(reference, implementation) {
  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right)
  const actionControls = (actions) =>
    actions.map(({ ariaLabel, title, disabled }) => ({ ariaLabel, title, disabled }))
  const actionIconGeometry = (actions) => actions.map((action) => action.icon?.geometry ?? null)
  const referenceUserActions =
    reference.userHover['.chat-thread > .msg.user .msg-actions--user'].structure.directButtons
  const implementationUserActions =
    implementation.userHover['#msg-m-visual-user .hc-msg-actions--user'].structure.directButtons
  const referenceAssistantActions =
    reference.assistantFooter['.chat-thread > .msg.bot .msg-actions--assistant'].structure
      .directButtons
  const implementationAssistantActions =
    implementation.assistantFooter['#msg-m-visual-assistant .hc-msg-actions--assistant'].structure
      .directButtons
  const referenceAssistantMeta = reference.assistantFooter['.chat-thread > .msg.bot .msg-meta']
  const implementationAssistantMeta =
    implementation.assistantFooter['#msg-m-visual-assistant .hc-msg__meta']
  const hasUnexpectedAction = (actions) =>
    actions.some((action) => /更多|删除|more|delete/i.test(`${action.ariaLabel} ${action.title}`))
  const checks = {
    referenceRenameKeepsRowHeight: reference.rename.rowHeightDelta === 0,
    implementationRenameKeepsRowHeight: implementation.rename.rowHeightDelta === 0,
    referenceUserTimeBeforeActions:
      reference.userHover['.chat-thread > .msg.user .msg-time'].box.right <=
      reference.userHover['.chat-thread > .msg.user .msg-actions--user'].box.left,
    implementationUserTimeBeforeActions:
      implementation.userHover['#msg-m-visual-user .hc-msg__time'].box.right <=
      implementation.userHover['#msg-m-visual-user .hc-msg-actions--user'].box.left,
    referenceAssistantActionsBeforeTime:
      reference.assistantFooter['.chat-thread > .msg.bot .msg-actions--assistant'].box.right <=
      reference.assistantFooter['.chat-thread > .msg.bot .msg-time'].box.left,
    implementationAssistantActionsBeforeTime:
      implementation.assistantFooter['#msg-m-visual-assistant .hc-msg-actions--assistant'].box
        .right <= implementation.assistantFooter['#msg-m-visual-assistant .hc-msg__time'].box.left,
    referenceAssistantActionGapIsTwo:
      reference.assistantFooter['.chat-thread > .msg.bot .msg-actions--assistant'].style.gap ===
      '2px',
    implementationAssistantActionGapIsTwo:
      implementation.assistantFooter['#msg-m-visual-assistant .hc-msg-actions--assistant'].style
        .gap === '2px',
    referenceAssistantFooterGapIsEight:
      reference.assistantFooter['.chat-thread > .msg.bot .msg-footer'].style.gap === '8px',
    implementationAssistantFooterGapIsEight:
      implementation.assistantFooter['#msg-m-visual-assistant .hc-msg__footer'].style.gap === '8px',
    referenceSessionActionsVisible:
      reference.sessionHover['.cs-item[data-session-id="decimal"] .cs-more'].style.opacity === '1',
    implementationSessionActionsVisible:
      implementation.sessionHover[`[data-session-id="${visualSessionId}"] .hc-sessions__actions`]
        .style.opacity === '1',
    referenceSessionCountTouchesPin:
      Math.abs(
        reference.sessionHover['.cs-item[data-session-id="decimal"] .cs-pin'].box.left -
          reference.sessionHover['.cs-item[data-session-id="decimal"] .cs-cnt'].box.right,
      ) <= 0.01,
    implementationSessionCountTouchesPin:
      Math.abs(
        implementation.sessionHover[
          `[data-session-id="${visualSessionId}"] .hc-sessions__pin-action`
        ].box.left -
          implementation.sessionHover[`[data-session-id="${visualSessionId}"] .hc-sessions__count`]
            .box.right,
      ) <= 0.01,
    referenceRenameHasClearControl:
      Boolean(reference.rename['.cs-item[data-session-id="decimal"] .cs-rename-clear']) &&
      Boolean(reference.rename['.cs-item[data-session-id="decimal"] .cs-rename-clear svg']),
    implementationRenameHasClearControl:
      Boolean(
        implementation.rename[`[data-session-id="${visualSessionId}"] .hc-clearable-field__button`],
      ) &&
      Boolean(
        implementation.rename[
          `[data-session-id="${visualSessionId}"] .hc-clearable-field__button svg`
        ],
      ),
    referenceUserActionExactSet:
      referenceUserActions.length === 2 && !hasUnexpectedAction(referenceUserActions),
    implementationUserActionExactSet:
      implementationUserActions.length === 2 &&
      same(actionControls(referenceUserActions), actionControls(implementationUserActions)) &&
      !hasUnexpectedAction(implementationUserActions),
    referenceAssistantActionExactSet:
      referenceAssistantActions.length === 6 && !hasUnexpectedAction(referenceAssistantActions),
    implementationAssistantActionExactSet:
      implementationAssistantActions.length === 6 &&
      same(
        actionControls(referenceAssistantActions),
        actionControls(implementationAssistantActions),
      ) &&
      !hasUnexpectedAction(implementationAssistantActions),
    userActionIconGeometryExact: same(
      actionIconGeometry(referenceUserActions),
      actionIconGeometry(implementationUserActions),
    ),
    assistantActionIconGeometryExact: same(
      actionIconGeometry(referenceAssistantActions),
      actionIconGeometry(implementationAssistantActions),
    ),
    referenceAssistantMetaSingleSource:
      referenceAssistantMeta.structure.childCount === 1 &&
      referenceAssistantMeta.structure.children[0]?.tagName === 'span',
    implementationAssistantMetaSingleSource:
      implementationAssistantMeta.structure.childCount === 1 &&
      implementationAssistantMeta.structure.children[0]?.tagName === 'span',
    assistantMetaExactStructure: same(
      referenceAssistantMeta.structure.children,
      implementationAssistantMeta.structure.children,
    ),
    sessionPinIconGeometryExact: same(
      reference.sessionHover['.cs-item[data-session-id="decimal"] .cs-pin svg'].svg?.geometry,
      implementation.sessionHover[
        `[data-session-id="${visualSessionId}"] .hc-sessions__pin-action svg`
      ].svg?.geometry,
    ),
    sessionMoreIconGeometryExact: same(
      reference.sessionHover['.cs-item[data-session-id="decimal"] .cs-more svg'].svg?.geometry,
      implementation.sessionHover[
        `[data-session-id="${visualSessionId}"] .hc-sessions__actions svg`
      ].svg?.geometry,
    ),
  }
  return checks
}

await mkdir(outputDirectory, { recursive: true })
const browser = await chromium.launch()
let prototypeContext
let implementationContext

try {
  const prototype = await preparePrototypePage(browser)
  prototypeContext = prototype.context
  const implementation = await prepareImplementationPage(browser)
  implementationContext = implementation.context

  const reference = await capturePrototypeStates(prototype.page)
  const implementationState = await captureImplementationStates(implementation.page)
  const blockedRequests = [...prototype.blockedRequests, ...implementation.blockedRequests]
  const checks = semanticChecks(reference, implementationState)
  const failedChecks = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name)

  const styleDiffs = [
    ...compareStyles(reference.rename, implementationState.rename, [
      {
        target: 'rename-input',
        reference: '.cs-item[data-session-id="decimal"] .cs-rename-input',
        implementation: `[data-session-id="${visualSessionId}"] .hc-sessions__rename-input`,
        fields: [
          'height',
          'fontSize',
          'lineHeight',
          'color',
          'border',
          'borderRadius',
          'boxShadow',
        ],
      },
      {
        target: 'rename-meta',
        reference: '.cs-item[data-session-id="decimal"] .cs-m',
        implementation: `[data-session-id="${visualSessionId}"] .hc-sessions__meta`,
        fields: ['visibility', 'opacity', 'marginTop'],
      },
      {
        target: 'rename-clear-control',
        reference: '.cs-item[data-session-id="decimal"] .cs-rename-clear',
        implementation: `[data-session-id="${visualSessionId}"] .hc-clearable-field__button`,
        fields: ['width', 'height', 'borderRadius', 'color', 'backgroundColor', 'opacity'],
      },
      {
        target: 'rename-clear-icon',
        reference: '.cs-item[data-session-id="decimal"] .cs-rename-clear svg',
        implementation: `[data-session-id="${visualSessionId}"] .hc-clearable-field__button svg`,
        fields: [
          'width',
          'height',
          'stroke',
          'strokeWidth',
          'strokeLinecap',
          'strokeLinejoin',
          'fill',
        ],
      },
    ]),
    ...compareStyles(reference.sessionHover, implementationState.sessionHover, [
      {
        target: 'session-row',
        reference: '.cs-item[data-session-id="decimal"]',
        implementation: `[data-session-id="${visualSessionId}"]`,
        fields: ['width', 'height', 'padding', 'borderRadius', 'backgroundColor'],
      },
      {
        target: 'session-time',
        reference: '.cs-item[data-session-id="decimal"] .cs-m > span:first-child',
        implementation: `[data-session-id="${visualSessionId}"] .hc-sessions__time`,
        fields: [
          'fontFamily',
          'fontSize',
          'fontWeight',
          'fontVariantNumeric',
          'letterSpacing',
          'lineHeight',
          'color',
        ],
      },
      {
        target: 'session-count',
        reference: '.cs-item[data-session-id="decimal"] .cs-cnt',
        implementation: `[data-session-id="${visualSessionId}"] .hc-sessions__count`,
        fields: [
          'fontFamily',
          'fontSize',
          'fontWeight',
          'fontVariantNumeric',
          'letterSpacing',
          'lineHeight',
          'color',
        ],
      },
      {
        target: 'session-pin-hover',
        reference: '.cs-item[data-session-id="decimal"] .cs-pin',
        implementation: `[data-session-id="${visualSessionId}"] .hc-sessions__pin-action`,
        fields: ['width', 'height', 'opacity', 'color', 'backgroundColor', 'borderRadius'],
      },
      {
        target: 'session-pin-icon',
        reference: '.cs-item[data-session-id="decimal"] .cs-pin svg',
        implementation: `[data-session-id="${visualSessionId}"] .hc-sessions__pin-action svg`,
        fields: [
          'width',
          'height',
          'stroke',
          'strokeWidth',
          'strokeLinecap',
          'strokeLinejoin',
          'fill',
        ],
      },
      {
        target: 'session-more-hover',
        reference: '.cs-item[data-session-id="decimal"] .cs-more',
        implementation: `[data-session-id="${visualSessionId}"] .hc-sessions__actions`,
        fields: ['width', 'height', 'opacity', 'color', 'backgroundColor', 'borderRadius'],
      },
      {
        target: 'session-more-icon',
        reference: '.cs-item[data-session-id="decimal"] .cs-more svg',
        implementation: `[data-session-id="${visualSessionId}"] .hc-sessions__actions svg`,
        fields: [
          'width',
          'height',
          'stroke',
          'strokeWidth',
          'strokeLinecap',
          'strokeLinejoin',
          'fill',
        ],
      },
    ]),
    ...compareStyles(reference.userHover, implementationState.userHover, [
      {
        target: 'user-time',
        reference: '.chat-thread > .msg.user .msg-time',
        implementation: '#msg-m-visual-user .hc-msg__time',
        fields: ['fontSize', 'color', 'whiteSpace', 'opacity'],
      },
      {
        target: 'user-actions',
        reference: '.chat-thread > .msg.user .msg-actions--user',
        implementation: '#msg-m-visual-user .hc-msg-actions--user',
        fields: ['height', 'padding', 'border', 'borderRadius', 'backgroundColor', 'gap'],
      },
    ]),
    ...compareStyles(reference.assistantFooter, implementationState.assistantFooter, [
      {
        target: 'assistant-time',
        reference: '.chat-thread > .msg.bot .msg-time',
        implementation: '#msg-m-visual-assistant .hc-msg__time',
        fields: ['fontSize', 'color', 'whiteSpace', 'opacity'],
      },
      {
        target: 'assistant-action-gap',
        reference: '.chat-thread > .msg.bot .msg-actions--assistant',
        implementation: '#msg-m-visual-assistant .hc-msg-actions--assistant',
        fields: ['gap'],
      },
      {
        target: 'assistant-footer-gap',
        reference: '.chat-thread > .msg.bot .msg-footer',
        implementation: '#msg-m-visual-assistant .hc-msg__footer',
        fields: ['gap'],
      },
      {
        target: 'assistant-meta',
        reference: '.chat-thread > .msg.bot .msg-meta',
        implementation: '#msg-m-visual-assistant .hc-msg__meta',
        fields: ['display', 'fontSize', 'lineHeight', 'color', 'opacity', 'whiteSpace', 'gap'],
      },
      {
        target: 'assistant-divider',
        reference: '.chat-thread > .msg.bot .msg-action-sep',
        implementation: '#msg-m-visual-assistant .hc-msg-actions__divider',
        fields: ['width', 'height', 'marginLeft', 'marginRight', 'backgroundColor'],
      },
    ]),
    ...compareStyles(reference.sessionHover, implementationState.sessionHover, [
      {
        target: 'document-scrollbar-width',
        reference: 'html',
        implementation: 'html',
        fields: ['scrollbarWidth'],
      },
    ]),
    ...comparePseudo(reference.rename, implementationState.rename, [
      {
        target: 'rename-input-selection',
        reference: '.cs-item[data-session-id="decimal"] .cs-rename-input',
        implementation: `[data-session-id="${visualSessionId}"] .hc-sessions__rename-input`,
        pseudo: 'selection',
        fields: ['backgroundColor', 'color'],
      },
    ]),
    ...comparePseudo(reference.sessionHover, implementationState.sessionHover, [
      {
        target: 'document-webkit-scrollbar',
        reference: 'html',
        implementation: 'html',
        pseudo: 'webkitScrollbar',
        fields: ['width', 'height', 'backgroundColor'],
      },
      {
        target: 'document-webkit-scrollbar-thumb',
        reference: 'html',
        implementation: 'html',
        pseudo: 'webkitScrollbarThumb',
        fields: ['backgroundColor'],
      },
    ]),
  ]

  const screenshotPairs = ['session-hover', 'session-rename', 'user-hover', 'assistant-footer']
  const pixelDiffs = {}
  for (const name of screenshotPairs) {
    const referencePath = path.join(outputDirectory, `reference-${name}.png`)
    const implementationPath = path.join(outputDirectory, `implementation-${name}.png`)
    const diffPath = path.join(outputDirectory, `diff-${name}.png`)
    pixelDiffs[name] = await runPixelDiff(referencePath, implementationPath, diffPath)
  }
  const pixelFailures = Object.entries(pixelDiffs)
    .filter(([, diff]) => diff.changed_pixel_ratio > maxChangedPixelRatio)
    .map(([name, diff]) => ({ name, changed_pixel_ratio: diff.changed_pixel_ratio }))
  const prototypeSha256 = await sha256(prototypeArtifactPath)

  const report = {
    generatedAt: new Date().toISOString(),
    mode: 'browser-mock-only',
    viewport: { ...viewport, deviceScaleFactor: 1, locale: 'zh-CN', colorScheme: 'light' },
    sources: { prototypeUrl, implementationUrl, prototypeSha256 },
    fixture: {
      session: { title: '小数乘法讲解', time: '14:32', count: '2' },
      userMessage: { time: '14:09', actions: ['copy', 'edit'] },
      assistantMessage: {
        provider: 'HexClaw-GPT',
        model: 'gpt-5.6-sol',
        agent: '小王的辅导助手 · 五年级',
        time: '14:10',
      },
    },
    semanticChecks: checks,
    failedChecks,
    styleDiffs,
    pixelDiffs,
    network: {
      policy: 'loopback-fail-closed',
      blockedRequests,
    },
    acceptance: {
      maxChangedPixelRatio,
      pixelFailures,
      passed:
        failedChecks.length === 0 &&
        styleDiffs.length === 0 &&
        pixelFailures.length === 0 &&
        blockedRequests.length === 0,
    },
    geometry: { reference, implementation: implementationState },
  }
  await writeFile(path.join(outputDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)

  if (failedChecks.length || styleDiffs.length || pixelFailures.length || blockedRequests.length) {
    throw new Error(
      `视觉验收失败：语义=${failedChecks.join(', ') || '无'}；样式=${
        styleDiffs.map((diff) => `${diff.target}.${diff.field ?? diff.reason}`).join(', ') || '无'
      }；像素=${
        pixelFailures
          .map((failure) => `${failure.name}:${(failure.changed_pixel_ratio * 100).toFixed(2)}%`)
          .join(', ') || '无'
      }；出站=${blockedRequests.length ? JSON.stringify(blockedRequests) : '无'}`,
    )
  }
  console.log(JSON.stringify({ outputDirectory, pixelDiffs, styleDiffs }, null, 2))
} finally {
  await prototypeContext?.close()
  await implementationContext?.close()
  await browser.close()
}
