/**
 * BUG-20260820-007/008 的本地视觉证据：仅使用原型、当前源码与 loopback mock。
 * 产出同状态的 prototype/current/pixel-diff，以及关键 bbox/computed-style 快照。
 */
import { chromium } from '@playwright/test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const evidenceRoot = process.env.HEX_CHAT_SOURCE_VISUAL_EVIDENCE_DIR?.trim()
  ? path.resolve(process.env.HEX_CHAT_SOURCE_VISUAL_EVIDENCE_DIR)
  : path.join(root, 'test-results', 'chat-source-projection-20260821')
const referenceURL =
  process.env.HEX_CHAT_SOURCE_REFERENCE_URL?.trim() || 'http://127.0.0.1:16082/app.html'
const currentURL = process.env.HEX_CHAT_SOURCE_CURRENT_URL?.trim() || 'http://127.0.0.1:16083/chat'
const viewport = { width: 1440, height: 900 }
const deviceScaleFactor = 1
const pixelThreshold = 8
const maxChangedPixelRatio = 0.01
const sessionId = 'chat-source-projection-visual-session'
const modelAgent = 'model-agent'
const skillAgent = 'skill-agent'
const sourceDigest = `sha256:${'a'.repeat(64)}`
const sourceContentId = `content:${'a'.repeat(64)}`

const usage = `Usage: node tests/e2e/chat-source-projection-visual-evidence.mjs

Captures paired prototype/current-source evidence for BUG-20260820-007/008.
Both URLs must be loopback-only. The current-source page blocks every non-loopback
request and replaces WebSocket with a local fixture; it does not call a model.
`

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write(usage)
  process.exit(0)
}
if (process.argv.length > 2) {
  throw new Error(`unknown arguments: ${process.argv.slice(2).join(' ')}\n\n${usage}`)
}

function assertLoopbackURL(value, label) {
  const parsed = new URL(value)
  if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
    throw new Error(`${label} must be loopback-only: ${value}`)
  }
}

assertLoopbackURL(referenceURL, 'HEX_CHAT_SOURCE_REFERENCE_URL')
assertLoopbackURL(currentURL, 'HEX_CHAT_SOURCE_CURRENT_URL')

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

const reasoningControl = {
  dialect: 'reasoning_effort',
  on: 'high',
  off: 'none',
  allowed_efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
}

const sourceAppConfig = {
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
    defaultModel: 'gpt-5.6-sol',
    defaultProviderId: 'fixture-provider-id',
    defaultReasoningPolicy: { mode: 'off' },
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
        selectedModelId: 'gpt-5.6-sol',
        models: [
          {
            id: 'gpt-5.6-sol',
            name: 'gpt-5.6-sol',
            capabilities: ['text'],
            reasoningSupport: 'supported',
            reasoningControl,
          },
        ],
      },
    ],
  },
}

const backendLLMConfig = {
  default: 'fixture-provider',
  default_reasoning_policy: { mode: 'off' },
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
      model: 'gpt-5.6-sol',
      models: ['gpt-5.6-sol'],
      model_specs: [
        {
          id: 'gpt-5.6-sol',
          display_name: 'gpt-5.6-sol',
          capabilities: ['text'],
          reasoning_support: 'supported',
          reasoning_control: reasoningControl,
        },
      ],
    },
  },
}

const agents = [
  {
    name: modelAgent,
    display_name: '模型智能体',
    provider: 'fixture-provider',
    model: 'gpt-5.6-sol',
  },
  {
    name: skillAgent,
    display_name: '内置技能智能体',
    provider: '',
    model: '',
  },
]

const builtinSkillMessage = {
  id: 'builtin-skill-source-message',
  role: 'assistant',
  content: '杭州今天晴，最高 29°C。',
  timestamp: '2026-08-20T08:01:00.000Z',
  created_at: '2026-08-20T08:01:00.000Z',
  agent_name: skillAgent,
  message_content: {
    content_id: sourceContentId,
    content_version: '1.0',
    producer_kind: 'skill',
    markdown: '杭州今天晴，最高 29°C。',
    source_digest: sourceDigest,
    locale: 'zh-CN',
  },
  metadata: { producer_kind: 'skill' },
  tool_calls: [
    {
      id: 'weather-tool-call',
      name: 'weather',
      arguments: '{"city":"杭州"}',
      result: '{"weather":"晴"}',
    },
  ],
}

function runtimeFixture(apiPath, method) {
  if (apiPath === '/health') return { status: 'healthy' }
  if (apiPath === '/api/v1/config') return sourceAppConfig
  if (apiPath === '/api/v1/config/llm') return backendLLMConfig
  if (apiPath === '/api/v1/ollama/status') {
    return { running: false, associated: false, model_count: 0, models: [] }
  }
  if (apiPath === '/api/v1/agents' && method === 'GET') {
    return { agents, total: agents.length, default: '' }
  }
  if (apiPath === '/api/v1/agents/rules') return { rules: [], total: 0 }
  if (apiPath === '/api/v1/roles') return { roles: [] }
  if (apiPath === '/api/v1/sessions' && method === 'GET') {
    return {
      sessions: [
        {
          id: sessionId,
          title: '来源投影视觉基准',
          created_at: '2026-08-20T08:00:00.000Z',
          updated_at: '2026-08-20T08:01:00.000Z',
          message_count: 1,
        },
      ],
      total: 1,
    }
  }
  if (apiPath === `/api/v1/sessions/${sessionId}/messages` && method === 'GET') {
    return { messages: [builtinSkillMessage], total: 1 }
  }
  if (apiPath === `/api/v1/sessions/${sessionId}/artifacts`) return { artifacts: [], total: 0 }
  if (apiPath === `/api/v1/sessions/${sessionId}/branches`) return { branches: [], total: 0 }
  if (apiPath === '/api/v1/streams/active') return { streams: [], total: 0 }
  if (apiPath === '/api/v1/skills') return { skills: [], total: 0 }
  if (apiPath === '/api/v1/knowledge/documents') return { documents: [], total: 0 }
  if (apiPath === '/api/v1/connections') return { connections: [], total: 0 }
  if (apiPath === '/api/v1/images/status') return { available: false, models: [] }
  if (apiPath === '/api/v1/videos/status') return { available: false, models: [] }
  if (apiPath === '/api/v1/voicechat/status') return { available: false, models: [] }
  if (apiPath === '/api/v1/assistant/soul') {
    return { system_prompt: '', is_custom: false, default_prompt: '' }
  }
  if (apiPath.startsWith('/api/v1/')) return { items: [], total: 0 }
  return {}
}

async function installCurrentFixture(page, blockedRequests) {
  await page.addInitScript(
    ({ config, fixtureSession, boundAgent }) => {
      localStorage.clear()
      sessionStorage.clear()
      localStorage.setItem('hc-theme', 'light')
      localStorage.setItem('hc-locale', 'zh-CN')
      localStorage.setItem('hexclaw:welcomeRedirectDone', '1')
      sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
      localStorage.setItem('hexclaw_lastSessionId', fixtureSession)
      localStorage.setItem('app_config', JSON.stringify(config))
      localStorage.setItem(
        'hexclaw_sessionAgents',
        JSON.stringify({ [fixtureSession]: boundAgent }),
      )

      class MockWebSocket extends EventTarget {
        static CONNECTING = 0
        static OPEN = 1
        static CLOSING = 2
        static CLOSED = 3

        readyState = MockWebSocket.CONNECTING
        onopen = null
        onmessage = null
        onerror = null
        onclose = null

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
    { config: sourceAppConfig, fixtureSession: sessionId, boundAgent: modelAgent },
  )

  await page.route('**/*', (route) => {
    const requestURL = new URL(route.request().url())
    if (['127.0.0.1', 'localhost', '::1'].includes(requestURL.hostname)) return route.continue()
    blockedRequests.push(requestURL.toString())
    return route.abort('blockedbyclient')
  })
  await page.route('http://localhost:11434/**', (route) =>
    json(route, { models: [], version: 'chat-source-projection-visual-fixture' }),
  )
  await page.route('**/_hexclaw/**', (route) => {
    const requestURL = new URL(route.request().url())
    const apiPath = requestURL.pathname.replace(/^\/_hexclaw/, '')
    return json(route, runtimeFixture(apiPath, route.request().method()))
  })
}

async function freezeVisualState(page) {
  await page.addStyleTag({
    content:
      '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}',
  })
  await page.evaluate(async () => {
    if ('fonts' in document) await document.fonts.ready
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })
}

function frameStyle(kind) {
  if (kind === 'composer') {
    return `
      html,body{margin:0!important;width:100%;min-height:100%;background:var(--hc-bg-main)!important}
      body{overflow:hidden!important}
      #visual-compare-frame{box-sizing:border-box;width:360px;height:72px;padding:16px 20px;display:flex;align-items:center;background:var(--hc-bg-main);color:var(--hc-text-primary);font-family:-apple-system,BlinkMacSystemFont,'SF Pro Display','SF Pro Text','Helvetica Neue','PingFang SC','Hiragino Sans GB','Microsoft YaHei','Segoe UI',sans-serif}
      #visual-compare-frame .hc-model-selector{display:block!important}
    `
  }
  return `
    html,body{margin:0!important;width:100%;min-height:100%;background:var(--hc-bg-main)!important}
    body{overflow:hidden!important}
    #visual-compare-frame{box-sizing:border-box;width:820px;height:268px;padding:20px;overflow:hidden;background:var(--hc-bg-main);color:var(--hc-text-primary);font-family:-apple-system,BlinkMacSystemFont,'SF Pro Display','SF Pro Text','Helvetica Neue','PingFang SC','Hiragino Sans GB','Microsoft YaHei','Segoe UI',sans-serif}
    #visual-compare-frame .msg-body,#visual-compare-frame .hc-msg__body{display:block!important;flex:none!important;width:780px!important;max-width:780px!important}
    #visual-compare-frame .hc-msg__actions-inline,#visual-compare-frame .hc-msg__time{display:none!important}
  `
}

async function prepareReference(page, kind) {
  await page.goto(referenceURL, { waitUntil: 'domcontentloaded', timeout: 12_000 })
  await page.evaluate((frameKind) => {
    document.documentElement.dataset.theme = 'light'
    const frame = document.createElement('main')
    frame.id = 'visual-compare-frame'
    frame.dataset.source = 'prototype'
    frame.dataset.kind = frameKind
    if (frameKind === 'source') {
      const template = document.querySelector(
        'template[data-prototype-variant="chat-tool-display.builtin-skill-source"]',
      )
      const clone = template?.content.cloneNode(true)
      const body = clone?.querySelector('.msg-body')
      if (!(body instanceof HTMLElement))
        throw new Error('prototype builtin-skill source fixture is missing')
      const header = body.querySelector('.msg-name')
      if (header) header.textContent = '内置技能智能体'
      frame.append(body)
    } else {
      const model = document.querySelector('[data-chat-model-selector]')
      if (!(model instanceof HTMLElement)) throw new Error('prototype model selector is missing')
      const label = model.querySelector('[data-chat-model-label]')
      if (label) label.textContent = 'gpt-5.6-sol'
      frame.append(model)
    }
    document.body.replaceChildren(frame)
  }, kind)
  await page.addStyleTag({ content: frameStyle(kind) })
  await freezeVisualState(page)
}

async function prepareCurrent(page, kind, blockedRequests) {
  await installCurrentFixture(page, blockedRequests)
  await page.goto(currentURL, { waitUntil: 'domcontentloaded', timeout: 12_000 })
  await page
    .locator('#splash-screen')
    .waitFor({ state: 'detached', timeout: 10_000 })
    .catch(() => {})
  await page
    .locator('#msg-builtin-skill-source-message')
    .waitFor({ state: 'visible', timeout: 12_000 })
  await page.locator('.hc-model-selector__name').filter({ hasText: 'gpt-5.6-sol' }).waitFor({
    state: 'visible',
    timeout: 12_000,
  })
  await page.evaluate((frameKind) => {
    document.documentElement.dataset.theme = 'light'
    const frame = document.createElement('main')
    frame.id = 'visual-compare-frame'
    frame.dataset.source = 'current'
    frame.dataset.kind = frameKind
    if (frameKind === 'source') {
      const body = document.querySelector('#msg-builtin-skill-source-message .hc-msg__body')
      if (!(body instanceof HTMLElement))
        throw new Error('current builtin-skill message body is missing')
      frame.append(body)
    } else {
      const model = document.querySelector('.hc-model-selector')
      if (!(model instanceof HTMLElement)) throw new Error('current model selector is missing')
      frame.append(model)
    }
    document.body.replaceChildren(frame)
  }, kind)
  await page.addStyleTag({ content: frameStyle(kind) })
  await freezeVisualState(page)
}

const targets = {
  source: {
    prototype: {
      body: '.msg-body',
      header: '.msg-name',
      bubble: '.bubble.bot',
      tool: '.hc-tool',
      footer: '.msg-footer',
      source: '[data-message-source="builtin-skill"]',
    },
    current: {
      body: '.hc-msg__body',
      header: '.hc-msg__name',
      bubble: '.hc-msg__bubble--assistant',
      tool: '.hc-msg__tools .hc-tool',
      footer: '.hc-msg__footer',
      source: '.hc-msg__meta',
    },
  },
  composer: {
    prototype: { model: '[data-chat-model-selector]' },
    current: { model: '.hc-model-selector__btn' },
  },
}

async function inspect(page, kind, source) {
  return page.evaluate((selectors) => {
    const styleKeys = [
      'display',
      'visibility',
      'width',
      'height',
      'minHeight',
      'margin',
      'padding',
      'gap',
      'backgroundColor',
      'border',
      'borderRadius',
      'boxShadow',
      'color',
      'fontFamily',
      'fontSize',
      'fontWeight',
      'lineHeight',
      'whiteSpace',
      'opacity',
    ]
    const round = (value) => Number(value.toFixed(2))
    const elements = Object.fromEntries(
      Object.entries(selectors).map(([name, selector]) => {
        const element = document.querySelector(selector)
        if (!(element instanceof HTMLElement)) return [name, { found: false }]
        const rect = element.getBoundingClientRect()
        const computed = getComputedStyle(element)
        return [
          name,
          {
            found: true,
            text: (element.textContent ?? '').replace(/\s+/g, ' ').trim(),
            box: {
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
            attributes: {
              title: element.getAttribute('title'),
              ariaLabel: element.getAttribute('aria-label'),
              producerKind: element.dataset.producerKind ?? null,
              messageSource: element.dataset.messageSource ?? null,
            },
          },
        ]
      }),
    )
    if (!('tool' in selectors)) return elements

    const body = document.querySelector(selectors.body)
    const tool = document.querySelector(selectors.tool)
    const roleForChild = (child) => {
      if (child.matches(selectors.header)) return null
      if (child.matches(selectors.footer)) return 'footer'
      if (child.matches(selectors.tool) || child.querySelector(selectors.tool)) return 'tool'
      if (child.matches(selectors.bubble) || child.querySelector(selectors.bubble)) return 'body'
      return `unexpected:${child.tagName.toLowerCase()}.${[...child.classList].join('.')}`
    }
    const toolPart = (child) => {
      if (child.classList.contains('hc-tool__head')) return 'head'
      if (child.classList.contains('hc-tool__summary')) return 'summary'
      if (child.classList.contains('hc-tool__detail')) return 'detail'
      return `unexpected:${child.tagName.toLowerCase()}.${[...child.classList].join('.')}`
    }
    return {
      ...elements,
      domExactSet: {
        contentOrder:
          body instanceof HTMLElement ? [...body.children].map(roleForChild).filter(Boolean) : [],
        toolCount: body instanceof HTMLElement ? body.querySelectorAll(selectors.tool).length : 0,
        footerCount:
          body instanceof HTMLElement ? body.querySelectorAll(selectors.footer).length : 0,
        sourceCount:
          body instanceof HTMLElement ? body.querySelectorAll(selectors.source).length : 0,
        toolParts: tool instanceof HTMLElement ? [...tool.children].map(toolPart) : [],
        statusIconCount:
          tool instanceof HTMLElement ? tool.querySelectorAll('.hc-tool__status').length : 0,
        wrenchIconCount:
          tool instanceof HTMLElement ? tool.querySelectorAll('.hc-tool__wrench').length : 0,
        nameCount: tool instanceof HTMLElement ? tool.querySelectorAll('.hc-tool__name').length : 0,
        summaryCount:
          tool instanceof HTMLElement ? tool.querySelectorAll('.hc-tool__summary').length : 0,
        detailCount:
          tool instanceof HTMLElement ? tool.querySelectorAll('.hc-tool__detail').length : 0,
      },
    }
  }, targets[kind][source])
}

function semanticChecks(kind, prototype, current) {
  if (kind === 'source') {
    const expectedOrder = ['tool', 'body', 'footer']
    const expectedToolParts = ['head', 'summary', 'detail', 'detail']
    const exactSetMatches = (value, expected) =>
      Array.isArray(value) &&
      value.length === expected.length &&
      value.every((item, index) => item === expected[index])
    const hasApprovedToolCard = (snapshot) =>
      snapshot.tool?.found === true &&
      snapshot.domExactSet?.toolCount === 1 &&
      snapshot.domExactSet?.statusIconCount === 1 &&
      snapshot.domExactSet?.wrenchIconCount === 1 &&
      snapshot.domExactSet?.nameCount === 1 &&
      snapshot.domExactSet?.summaryCount === 1 &&
      snapshot.domExactSet?.detailCount === 2 &&
      exactSetMatches(snapshot.domExactSet?.toolParts, expectedToolParts)
    return {
      prototypeSourceExact: prototype.source?.text === '内置技能 · 未调用模型',
      currentSourceExact: current.source?.text === '内置技能 · 未调用模型',
      prototypeOrderExact: exactSetMatches(prototype.domExactSet?.contentOrder, expectedOrder),
      currentOrderExact: exactSetMatches(current.domExactSet?.contentOrder, expectedOrder),
      prototypeToolCardExact: hasApprovedToolCard(prototype),
      currentToolCardExact: hasApprovedToolCard(current),
      prototypeHasOneFooterAndSource:
        prototype.domExactSet?.footerCount === 1 && prototype.domExactSet?.sourceCount === 1,
      currentHasOneFooterAndSource:
        current.domExactSet?.footerCount === 1 && current.domExactSet?.sourceCount === 1,
      currentFooterDoesNotRepeatAgent: !current.source?.text?.includes('内置技能智能体'),
      currentFooterDoesNotClaimProviderOrModel:
        !current.source?.text?.includes('OpenAI') && !current.source?.text?.includes('gpt-5.6-sol'),
      currentHeaderPreservesAgent: current.header?.text === '内置技能智能体',
    }
  }
  return {
    prototypeModelExact: prototype.model?.text === 'gpt-5.6-sol',
    currentModelExact: current.model?.text === 'gpt-5.6-sol',
    currentComposerDoesNotRepeatAgent: !current.model?.text?.includes('模型智能体'),
  }
}

async function runPixelDiff(page, referencePath, currentPath, diffPath) {
  const [reference, current] = await Promise.all([
    readFile(referencePath, 'base64'),
    readFile(currentPath, 'base64'),
  ])
  const result = await page.evaluate(
    async ({ referencePng, currentPng, threshold }) => {
      const load = (source) =>
        new Promise((resolve, reject) => {
          const image = new Image()
          image.onload = () => resolve(image)
          image.onerror = reject
          image.src = `data:image/png;base64,${source}`
        })
      const [referenceImage, currentImage] = await Promise.all([
        load(referencePng),
        load(currentPng),
      ])
      if (
        referenceImage.width !== currentImage.width ||
        referenceImage.height !== currentImage.height
      ) {
        throw new Error(
          `screenshot size mismatch: prototype=${referenceImage.width}x${referenceImage.height}, current=${currentImage.width}x${currentImage.height}`,
        )
      }
      const width = referenceImage.width
      const height = referenceImage.height
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d')
      context.drawImage(referenceImage, 0, 0)
      const prototypePixels = context.getImageData(0, 0, width, height).data
      context.clearRect(0, 0, width, height)
      context.drawImage(currentImage, 0, 0)
      const currentPixels = context.getImageData(0, 0, width, height).data
      const diff = context.createImageData(width, height)
      let changedPixels = 0
      let minX = width
      let minY = height
      let maxX = -1
      let maxY = -1
      for (let index = 0; index < prototypePixels.length; index += 4) {
        const changed =
          Math.max(
            Math.abs(prototypePixels[index] - currentPixels[index]),
            Math.abs(prototypePixels[index + 1] - currentPixels[index + 1]),
            Math.abs(prototypePixels[index + 2] - currentPixels[index + 2]),
            Math.abs(prototypePixels[index + 3] - currentPixels[index + 3]),
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
          diff.data[index] = 255
          diff.data[index + 1] = 35
          diff.data[index + 2] = 35
        } else {
          const luminance = Math.round(
            (prototypePixels[index] * 0.299 +
              prototypePixels[index + 1] * 0.587 +
              prototypePixels[index + 2] * 0.114) *
              0.45,
          )
          diff.data[index] = luminance
          diff.data[index + 1] = luminance
          diff.data[index + 2] = luminance
        }
        diff.data[index + 3] = 255
      }
      context.putImageData(diff, 0, 0)
      return {
        png: canvas.toDataURL('image/png').split(',')[1],
        width,
        height,
        threshold,
        changed_pixels: changedPixels,
        total_pixels: width * height,
        changed_pixel_ratio: changedPixels / (width * height),
        changed_bbox: changedPixels > 0 ? [minX, minY, maxX + 1, maxY + 1] : null,
        decoder: 'browser-canvas',
      }
    },
    { referencePng: reference, currentPng: current, threshold: pixelThreshold },
  )
  await writeFile(diffPath, Buffer.from(result.png, 'base64'))
  delete result.png
  return result
}

await mkdir(evidenceRoot, { recursive: true })
const browser = await chromium.launch()
const results = []

try {
  for (const kind of ['source', 'composer']) {
    const contextOptions = {
      viewport,
      deviceScaleFactor,
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      colorScheme: 'light',
      reducedMotion: 'reduce',
    }
    const prototypeContext = await browser.newContext(contextOptions)
    const currentContext = await browser.newContext(contextOptions)
    const prototypePage = await prototypeContext.newPage()
    const currentPage = await currentContext.newPage()
    const blockedRequests = []
    const outputDirectory = path.join(evidenceRoot, kind)
    try {
      await Promise.all([
        prepareReference(prototypePage, kind),
        prepareCurrent(currentPage, kind, blockedRequests),
      ])
      await mkdir(outputDirectory, { recursive: true })
      const referencePath = path.join(outputDirectory, 'prototype.png')
      const currentPath = path.join(outputDirectory, 'current.png')
      const diffPath = path.join(outputDirectory, 'pixel-diff.png')
      await Promise.all([
        prototypePage.locator('#visual-compare-frame').screenshot({
          path: referencePath,
          animations: 'disabled',
          caret: 'hide',
          scale: 'css',
        }),
        currentPage.locator('#visual-compare-frame').screenshot({
          path: currentPath,
          animations: 'disabled',
          caret: 'hide',
          scale: 'css',
        }),
      ])
      const [prototype, current, pixels] = await Promise.all([
        inspect(prototypePage, kind, 'prototype'),
        inspect(currentPage, kind, 'current'),
        runPixelDiff(currentPage, referencePath, currentPath, diffPath),
      ])
      const checks = semanticChecks(kind, prototype, current)
      const semanticPassed = Object.values(checks).every(Boolean) && blockedRequests.length === 0
      const visualPassed = pixels.changed_pixel_ratio <= maxChangedPixelRatio
      const status = !semanticPassed ? 'FAIL' : visualPassed ? 'PASS' : 'NEEDS_VISUAL_ALIGNMENT'
      const report = {
        status,
        kind,
        environment: {
          viewport,
          deviceScaleFactor,
          locale: 'zh-CN',
          timezoneId: 'Asia/Shanghai',
          colorScheme: 'light',
          reducedMotion: 'reduce',
          referenceURL,
          currentURL,
          networkPolicy: 'loopback-only; mocked WebSocket; no model invocation',
        },
        normalization:
          kind === 'source'
            ? 'Both message bodies use the same fixed frame; current Footer action/time controls are hidden because the approved source fixture owns only source projection.'
            : 'Both model controls use the same fixed frame without replacing their component styles.',
        semanticChecks: checks,
        visualGate: { maxChangedPixelRatio, passed: visualPassed },
        blockedRequests,
        pixelDiff: pixels,
        bboxComputedStyle: { prototype, current },
        files: {
          prototype: 'prototype.png',
          current: 'current.png',
          pixelDiff: 'pixel-diff.png',
        },
      }
      await writeFile(
        path.join(outputDirectory, 'report.json'),
        `${JSON.stringify(report, null, 2)}\n`,
      )
      results.push(report)
      process.stdout.write(
        `${kind}: ${report.status}; changed=${(pixels.changed_pixel_ratio * 100).toFixed(3)}%; blocked=${blockedRequests.length}\n`,
      )
    } finally {
      await Promise.all([prototypeContext.close(), currentContext.close()])
    }
  }
} finally {
  await browser.close()
}

const summary = {
  status: results.every((result) => result.status === 'PASS')
    ? 'PASS'
    : results.some((result) => result.status === 'NEEDS_VISUAL_ALIGNMENT')
      ? 'NEEDS_VISUAL_ALIGNMENT'
      : 'FAIL',
  evidenceRoot,
  visualGate: { maxChangedPixelRatio },
  results,
}
await writeFile(path.join(evidenceRoot, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
process.stdout.write(
  `summary: ${summary.status}; ${results.filter((result) => result.status === 'PASS').length}/${results.length} PASS\n`,
)
if (summary.status !== 'PASS') process.exitCode = 1
