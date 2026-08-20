import { chromium } from '@playwright/test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const ROOT = path.resolve(process.cwd())
const EVIDENCE_ROOT = path.resolve(
  ROOT,
  '../hexclaw-docs/test/evidence/chat-deep-think-progress-001/visual-current-source',
)
const REFERENCE_URL = process.env.HEX_REASONING_REFERENCE_URL ?? 'http://127.0.0.1:16070/app.html'
const IMPLEMENTATION_URL =
  process.env.HEX_REASONING_IMPLEMENTATION_URL ??
  'http://127.0.0.1:15151/tests/e2e/fixtures/reasoning-status.html'
const VIEWPORT = { width: 1440, height: 900 }
const PIXEL_THRESHOLD = 8
const MAX_CHANGED_PIXEL_RATIO = 0.001

const states = [
  {
    id: 'chat-supported-off-before',
    surface: 'chat',
    request: 'off',
    support: 'supported',
    execution: 'unknown',
    answer: false,
  },
  {
    id: 'chat-supported-off-after',
    surface: 'chat',
    request: 'off',
    support: 'supported',
    execution: 'unknown',
    answer: true,
  },
  {
    id: 'chat-unsupported-off-before',
    surface: 'chat',
    request: 'off',
    support: 'unsupported',
    execution: 'unknown',
    answer: false,
  },
  {
    id: 'chat-unsupported-off-after',
    surface: 'chat',
    request: 'off',
    support: 'unsupported',
    execution: 'unknown',
    answer: true,
  },
  {
    id: 'chat-unknown-off-before',
    surface: 'chat',
    request: 'off',
    support: 'unknown',
    execution: 'unknown',
    answer: false,
  },
  {
    id: 'chat-unknown-off-after',
    surface: 'chat',
    request: 'off',
    support: 'unknown',
    execution: 'unknown',
    answer: true,
  },
  {
    id: 'chat-supported-on-preparing',
    surface: 'chat',
    request: 'on',
    support: 'supported',
    execution: 'unknown',
    answer: false,
  },
  {
    id: 'chat-supported-on-applied-before',
    surface: 'chat',
    request: 'on',
    support: 'supported',
    execution: 'applied',
    answer: false,
  },
  {
    id: 'chat-supported-on-applied-after',
    surface: 'chat',
    request: 'on',
    support: 'supported',
    execution: 'applied',
    answer: true,
  },
  {
    id: 'chat-supported-on-ignored-before',
    surface: 'chat',
    request: 'on',
    support: 'supported',
    execution: 'ignored',
    answer: false,
  },
  {
    id: 'chat-supported-on-ignored-after',
    surface: 'chat',
    request: 'on',
    support: 'supported',
    execution: 'ignored',
    answer: true,
  },
  {
    id: 'chat-supported-on-rejected',
    surface: 'chat',
    request: 'on',
    support: 'supported',
    execution: 'rejected',
    answer: false,
  },
  {
    id: 'chat-unsupported-on-rejected',
    surface: 'chat',
    request: 'on',
    support: 'unsupported',
    execution: 'rejected',
    answer: false,
  },
  {
    id: 'chat-unknown-on-preparing',
    surface: 'chat',
    request: 'on',
    support: 'unknown',
    execution: 'unknown',
    answer: false,
  },
  {
    id: 'chat-unknown-on-applied-before',
    surface: 'chat',
    request: 'on',
    support: 'unknown',
    execution: 'applied',
    answer: false,
  },
  {
    id: 'chat-unknown-on-applied-after',
    surface: 'chat',
    request: 'on',
    support: 'unknown',
    execution: 'applied',
    answer: true,
  },
  {
    id: 'chat-unknown-on-ignored-after',
    surface: 'chat',
    request: 'on',
    support: 'unknown',
    execution: 'ignored',
    answer: true,
  },
  {
    id: 'chat-unknown-on-rejected',
    surface: 'chat',
    request: 'on',
    support: 'unknown',
    execution: 'rejected',
    answer: false,
  },
  {
    id: 'quick-off-before',
    surface: 'quick-chat',
    request: 'off',
    support: 'unknown',
    execution: 'unknown',
    answer: false,
  },
  {
    id: 'quick-off-after',
    surface: 'quick-chat',
    request: 'off',
    support: 'unknown',
    execution: 'unknown',
    answer: true,
  },
  {
    id: 'quick-conflicting-on-fails-closed',
    surface: 'quick-chat',
    request: 'off',
    support: 'unknown',
    execution: 'unknown',
    answer: false,
    requestedConflict: 'on',
  },
]

const controlStates = [
  { id: 'chat-toggle-supported-off', support: 'supported', request: 'off' },
  { id: 'chat-toggle-supported-on', support: 'supported', request: 'on' },
  { id: 'chat-toggle-unsupported-off', support: 'unsupported', request: 'off' },
  { id: 'chat-toggle-unknown-off', support: 'unknown', request: 'off' },
  { id: 'chat-toggle-unknown-on', support: 'unknown', request: 'on' },
]

const frameStyles = `
  html, body { margin: 0 !important; width: 100%; min-height: 100%; background: var(--hc-bg-main) !important; }
  body { overflow: hidden; }
  #app { width: max-content; }
  .visual-compare-frame {
    box-sizing: border-box;
    width: 760px;
    height: 112px;
    padding: 16px;
    overflow: hidden;
    background: var(--hc-bg-main);
    color: var(--hc-text-primary);
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text', 'Helvetica Neue', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Segoe UI', sans-serif;
  }
  .visual-compare-frame--quick-chat { width: 390px; }
  .visual-toggle-frame {
    display: flex;
    width: 220px;
    height: 62px;
    align-items: center;
  }
  .visual-answer {
    display: block;
    box-sizing: border-box;
    width: max-content;
    max-width: 85%;
    margin: 0;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    color: var(--hc-text-primary);
    font-size: 14px;
    line-height: 1.6;
  }
  .visual-compare-frame--quick-chat .visual-answer { font-size: 14px; line-height: 1.6; }
`

function implementationStateURL(state) {
  const url = new URL(IMPLEMENTATION_URL)
  url.searchParams.set('surface', state.surface)
  url.searchParams.set('request', state.request)
  url.searchParams.set('support', state.support)
  url.searchParams.set('execution', state.execution)
  url.searchParams.set('answer', String(state.answer))
  return url.toString()
}

async function prepareReference(page, state) {
  await page.goto(REFERENCE_URL, { waitUntil: 'load' })
  await page.evaluate((input) => {
    window.setChatReasoningPrototypeState({
      surface: input.surface,
      request: input.requestedConflict ?? input.request,
      support: input.support,
      execution: input.execution,
      phase: input.answer ? 'answering' : 'preparing',
    })
  }, state)
  await page.evaluate((input) => {
    const message =
      input.surface === 'quick-chat'
        ? document.querySelector('[data-quick-reasoning-fixture]')
        : document.querySelector('[data-reasoning-fixture-message]')
    if (!message) throw new Error('prototype reasoning fixture message is missing')
    const host = message.querySelector('[data-reasoning-status-host]')
    const answer = message.querySelector('[data-reasoning-answer]')
    if (!host || !answer) throw new Error('prototype reasoning fixture host is incomplete')
    const frame = document.createElement('main')
    frame.id = 'visual-compare-frame'
    frame.className = `visual-compare-frame visual-compare-frame--${input.surface}`
    frame.dataset.surface = input.surface
    answer.textContent = '这是首个可渲染回答正文。'
    answer.className = 'visual-answer'
    frame.append(host, answer)
    document.body.replaceChildren(frame)
    document.documentElement.dataset.theme = 'light'
  }, state)
  await page.addStyleTag({ content: frameStyles })
  await page.locator('#visual-compare-frame').waitFor({ state: 'visible' })
}

async function prepareImplementation(page, state) {
  await page.goto(implementationStateURL(state), { waitUntil: 'networkidle' })
  await page.addStyleTag({ content: frameStyles })
  await page.locator('#visual-compare-frame').waitFor({ state: 'visible' })
}

function modelControl(support) {
  return support === 'supported'
    ? {
        dialect: 'reasoning_effort',
        on: 'high',
        off: 'none',
        allowed_efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      }
    : undefined
}

function sourceAppConfig(support) {
  const control = modelControl(support)
  return {
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
    sandbox: { network_enabled: true },
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
          selectedModelId: 'gpt-5.6-sol',
          models: [
            {
              id: 'gpt-5.6-sol',
              name: 'Fixture Model',
              capabilities: ['text'],
              reasoningSupport: support,
              ...(control ? { reasoningControl: control } : {}),
            },
          ],
        },
      ],
    },
  }
}

function backendLLMConfig(support) {
  const control = modelControl(support)
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
        model: 'gpt-5.6-sol',
        models: ['gpt-5.6-sol'],
        model_specs: [
          {
            id: 'gpt-5.6-sol',
            display_name: 'Fixture Model',
            capabilities: ['text'],
            reasoning_support: support,
            ...(control ? { reasoning_control: control } : {}),
          },
        ],
      },
    },
  }
}

async function installControlSourceFixture(page, state) {
  const appConfig = sourceAppConfig(state.support)
  const sessionPolicy =
    state.request === 'off'
      ? { mode: 'off' }
      : state.support === 'supported'
        ? { mode: 'effort', effort: 'high' }
        : { mode: 'on' }
  await page.addInitScript(
    ({ config, policy }) => {
      localStorage.clear()
      sessionStorage.clear()
      localStorage.setItem('hc-theme', 'light')
      localStorage.setItem('hc-locale', 'zh-CN')
      localStorage.setItem('hexclaw:welcomeRedirectDone', '1')
      sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
      localStorage.setItem('hexclaw_lastSessionId', 'reasoning-control-session')
      localStorage.setItem('app_config', JSON.stringify(config))
      localStorage.setItem(
        'hexclaw_sessionDeepThinking',
        JSON.stringify({ 'reasoning-control-session': policy }),
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
          setTimeout(() => {
            this.readyState = MockWebSocket.OPEN
            const event = new Event('open')
            this.onopen?.(event)
            this.dispatchEvent(event)
          }, 0)
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
    { config: appConfig, policy: sessionPolicy },
  )

  const llmConfig = backendLLMConfig(state.support)
  await page.route('http://localhost:11434/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"models":[]}' }),
  )
  await page.route('**/_hexclaw/**', (route) => {
    const requestURL = new URL(route.request().url())
    const apiPath = requestURL.pathname.replace(/^\/_hexclaw/, '')
    const method = route.request().method()
    let body = {}
    if (apiPath === '/api/v1/config/llm') body = llmConfig
    else if (apiPath === '/api/v1/config') body = appConfig
    else if (apiPath === '/api/v1/ollama/status')
      body = { running: false, associated: false, models: [] }
    else if (apiPath === '/api/v1/roles') body = { roles: [] }
    else if (apiPath === '/api/v1/skills') body = { skills: [], total: 0 }
    else if (apiPath === '/api/v1/agents') body = { agents: [], total: 0, default: '' }
    else if (apiPath === '/api/v1/agents/rules') body = { rules: [], total: 0 }
    else if (apiPath === '/api/v1/streams/active') body = { streams: [], total: 0 }
    else if (apiPath === '/api/v1/sessions' && method === 'GET') {
      body = {
        sessions: [
          {
            id: 'reasoning-control-session',
            title: '推理状态验收',
            created_at: '2026-08-20T08:00:00.000Z',
            updated_at: '2026-08-20T08:00:00.000Z',
            message_count: 0,
          },
        ],
        total: 1,
      }
    } else if (apiPath === '/api/v1/sessions/reasoning-control-session/messages') {
      body = { messages: [], total: 0 }
    } else if (apiPath === '/api/v1/sessions/reasoning-control-session/branches') {
      body = { branches: [], total: 0 }
    } else if (apiPath === '/api/v1/sessions/reasoning-control-session/artifacts') {
      body = { artifacts: [], total: 0 }
    } else if (apiPath === '/api/v1/llm/capabilities') body = { models: [] }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    })
  })
}

async function prepareControlReference(page, state) {
  await page.goto(REFERENCE_URL, { waitUntil: 'load' })
  await page.evaluate((input) => {
    window.setChatReasoningPrototypeState({
      surface: 'chat',
      request: input.request,
      support: input.support,
      execution: 'unknown',
      phase: 'preparing',
    })
    const button = document.querySelector('[data-thinking-toggle]')
    if (!button) throw new Error('prototype thinking toggle is missing')
    const frame = document.createElement('main')
    frame.id = 'visual-compare-frame'
    frame.className = 'visual-compare-frame visual-toggle-frame'
    frame.append(button)
    document.body.replaceChildren(frame)
    document.documentElement.dataset.theme = 'light'
  }, state)
  await page.addStyleTag({ content: frameStyles })
  await page.locator('[data-thinking-toggle]').waitFor({ state: 'visible' })
}

async function prepareControlImplementation(page, state) {
  await installControlSourceFixture(page, state)
  await page.goto(new URL('/chat', IMPLEMENTATION_URL).toString(), {
    waitUntil: 'domcontentloaded',
  })
  await page
    .locator('#splash-screen')
    .waitFor({ state: 'detached', timeout: 10_000 })
    .catch(() => undefined)
  const button = page.locator('.hc-chat__research-btn')
  await button.waitFor({ state: 'visible', timeout: 10_000 })
  await page.evaluate(() => {
    const control = document.querySelector('.hc-chat__research-btn')
    if (!control) throw new Error('implementation thinking toggle is missing')
    const frame = document.createElement('main')
    frame.id = 'visual-compare-frame'
    frame.className = 'visual-compare-frame visual-toggle-frame'
    frame.append(control)
    document.body.replaceChildren(frame)
  })
  await page.addStyleTag({ content: frameStyles })
}

async function controlSnapshot(page, source) {
  return page.evaluate((sourceName) => {
    const button = document.querySelector(
      sourceName === 'reference' ? '[data-thinking-toggle]' : '.hc-chat__research-btn',
    )
    if (!button) throw new Error(`${sourceName} thinking toggle is missing`)
    const icon = button.querySelector('svg')
    const clean = (value) => Number(value.toFixed(2))
    const rect = (element) => {
      const box = element.getBoundingClientRect()
      return {
        x: clean(box.x),
        y: clean(box.y),
        width: clean(box.width),
        height: clean(box.height),
      }
    }
    const style = (element) => {
      const computed = getComputedStyle(element)
      return {
        display: computed.display,
        color: computed.color,
        backgroundColor: computed.backgroundColor,
        border: computed.border,
        borderRadius: computed.borderRadius,
        fontFamily: computed.fontFamily,
        fontSize: computed.fontSize,
        fontWeight: computed.fontWeight,
        lineHeight: computed.lineHeight,
        opacity: computed.opacity,
        cursor: computed.cursor,
        padding: computed.padding,
        gap: computed.gap,
      }
    }
    return {
      source: sourceName,
      button: {
        rect: rect(button),
        style: style(button),
        text: button.textContent?.replace(/\s+/g, ' ').trim() ?? '',
        title: button.getAttribute('title'),
        disabled: button.disabled,
        ariaDisabled: button.getAttribute('aria-disabled'),
        ariaPressed: button.getAttribute('aria-pressed'),
        support: sourceName === 'reference' ? button.getAttribute('data-reasoning-support') : null,
      },
      icon: icon
        ? { rect: rect(icon), style: style(icon), ariaHidden: icon.getAttribute('aria-hidden') }
        : null,
    }
  }, source)
}

function controlSemanticDifferences(reference, implementation, state) {
  const differences = []
  for (const key of ['text', 'title', 'disabled', 'ariaDisabled', 'ariaPressed']) {
    if ((reference.button[key] ?? null) !== (implementation.button[key] ?? null)) {
      differences.push(`button.${key}`)
    }
  }
  if (reference.button.support !== state.support) differences.push('reference.button.support')
  return differences
}

async function freezeVisualState(page) {
  await page.addStyleTag({
    content:
      '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}',
  })
  await page.evaluate(() => document.fonts.ready)
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  )
}

async function snapshot(page, source) {
  return page.evaluate((sourceName) => {
    const clean = (value) => Number(value.toFixed(2))
    const rect = (element) => {
      if (!element) return null
      const box = element.getBoundingClientRect()
      return {
        x: clean(box.x),
        y: clean(box.y),
        width: clean(box.width),
        height: clean(box.height),
      }
    }
    const style = (element) => {
      if (!element) return null
      const computed = getComputedStyle(element)
      return {
        display: computed.display,
        color: computed.color,
        backgroundColor: computed.backgroundColor,
        border: computed.border,
        borderRadius: computed.borderRadius,
        fontFamily: computed.fontFamily,
        fontSize: computed.fontSize,
        fontWeight: computed.fontWeight,
        lineHeight: computed.lineHeight,
        margin: computed.margin,
        padding: computed.padding,
        gap: computed.gap,
      }
    }
    const frame = document.querySelector('#visual-compare-frame')
    const status =
      sourceName === 'reference'
        ? document.querySelector('[data-reasoning-status-host] > *')
        : document.querySelector('[data-implementation-status-host] > *')
    const spinner =
      sourceName === 'reference'
        ? status?.querySelector('.think[data-thinking-state="running"] .ti')
        : status?.querySelector('.hc-assistant-run-status__spinner, .hc-thinking__spinner')
    const timer =
      sourceName === 'reference'
        ? status?.querySelector('.think-time')
        : status?.querySelector('.hc-thinking__elapsed')
    const answer = document.querySelector('[data-reasoning-answer]')
    return {
      source: sourceName,
      frame: { rect: rect(frame), style: style(frame) },
      status: status
        ? {
            rect: rect(status),
            style: style(status),
            text: (status.innerText || status.textContent || '').replace(/\s+/g, ' ').trim(),
            role: status.getAttribute('role'),
            ariaLive: status.getAttribute('aria-live'),
            ariaAtomic: status.getAttribute('aria-atomic'),
            component: status.getAttribute('data-component'),
            request: status.getAttribute('data-reasoning-request'),
            support: status.getAttribute('data-reasoning-support'),
            execution: status.getAttribute('data-reasoning-execution'),
          }
        : null,
      spinner: {
        count: document.querySelectorAll(
          sourceName === 'reference'
            ? '.think[data-thinking-state="running"] .ti'
            : '.hc-assistant-run-status__spinner, .hc-thinking__spinner',
        ).length,
        rect: rect(spinner),
        style: style(spinner),
        ariaHidden: spinner?.getAttribute('aria-hidden') ?? null,
      },
      timer: {
        count:
          status?.querySelectorAll(
            sourceName === 'reference' ? '.think-time' : '.hc-thinking__elapsed',
          ).length ?? 0,
        rect: rect(timer),
        style: style(timer),
        role: timer?.getAttribute('role') ?? null,
        ariaLive: timer?.getAttribute('aria-live') ?? null,
      },
      answer:
        answer && getComputedStyle(answer).display !== 'none'
          ? { rect: rect(answer), style: style(answer), text: answer.textContent?.trim() ?? '' }
          : null,
      ordinaryTypingDots: document.querySelectorAll('.hc-typing-dots').length,
    }
  }, source)
}

function semanticDifferences(reference, implementation) {
  const differences = []
  for (const key of ['text', 'role', 'ariaLive', 'ariaAtomic', 'request', 'support', 'execution']) {
    if ((reference.status?.[key] ?? null) !== (implementation.status?.[key] ?? null)) {
      differences.push(`status.${key}`)
    }
  }
  for (const key of ['count', 'ariaHidden']) {
    if ((reference.spinner?.[key] ?? null) !== (implementation.spinner?.[key] ?? null)) {
      differences.push(`spinner.${key}`)
    }
  }
  for (const key of ['count', 'role', 'ariaLive']) {
    if ((reference.timer?.[key] ?? null) !== (implementation.timer?.[key] ?? null)) {
      differences.push(`timer.${key}`)
    }
  }
  if ((reference.answer?.text ?? null) !== (implementation.answer?.text ?? null)) {
    differences.push('answer.text')
  }
  if (reference.ordinaryTypingDots !== 0 || implementation.ordinaryTypingDots !== 0) {
    differences.push('ordinaryTypingDots')
  }
  return differences
}

async function createPixelDiff(page, referencePath, implementationPath, diffPath, threshold) {
  const [reference, implementation] = await Promise.all([
    readFile(referencePath, 'base64'),
    readFile(implementationPath, 'base64'),
  ])
  const result = await page.evaluate(
    async ({ referencePng, implementationPng, pixelThreshold }) => {
      const loadImage = (source) =>
        new Promise((resolve, reject) => {
          const image = new Image()
          image.onload = () => resolve(image)
          image.onerror = reject
          image.src = `data:image/png;base64,${source}`
        })
      const [referenceImage, implementationImage] = await Promise.all([
        loadImage(referencePng),
        loadImage(implementationPng),
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
      const sourceContext = sourceCanvas.getContext('2d')
      sourceContext.drawImage(referenceImage, 0, 0)
      const referencePixels = sourceContext.getImageData(0, 0, width, height).data
      sourceContext.clearRect(0, 0, width, height)
      sourceContext.drawImage(implementationImage, 0, 0)
      const implementationPixels = sourceContext.getImageData(0, 0, width, height).data
      const diffCanvas = document.createElement('canvas')
      diffCanvas.width = width
      diffCanvas.height = height
      const diffContext = diffCanvas.getContext('2d')
      const output = diffContext.createImageData(width, height)
      let changedPixels = 0
      let minX = width
      let minY = height
      let maxX = -1
      let maxY = -1
      for (let index = 0; index < referencePixels.length; index += 4) {
        const changed =
          Math.max(
            Math.abs(referencePixels[index] - implementationPixels[index]),
            Math.abs(referencePixels[index + 1] - implementationPixels[index + 1]),
            Math.abs(referencePixels[index + 2] - implementationPixels[index + 2]),
            Math.abs(referencePixels[index + 3] - implementationPixels[index + 3]),
          ) > pixelThreshold
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
            (referencePixels[index] * 0.299 +
              referencePixels[index + 1] * 0.587 +
              referencePixels[index + 2] * 0.114) *
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
        png: diffCanvas.toDataURL('image/png').split(',')[1],
        width,
        height,
        threshold: pixelThreshold,
        changed_pixels: changedPixels,
        total_pixels: width * height,
        changed_pixel_ratio: changedPixels / (width * height),
        changed_bbox: changedPixels > 0 ? [minX, minY, maxX + 1, maxY + 1] : null,
      }
    },
    {
      referencePng: reference,
      implementationPng: implementation,
      pixelThreshold: threshold,
    },
  )
  await writeFile(diffPath, Buffer.from(result.png, 'base64'))
  delete result.png
  return result
}

await mkdir(EVIDENCE_ROOT, { recursive: true })
const browser = await chromium.launch()
const contextOptions = {
  viewport: VIEWPORT,
  deviceScaleFactor: 1,
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
  colorScheme: 'light',
  reducedMotion: 'reduce',
}
const referenceContext = await browser.newContext(contextOptions)
const implementationContext = await browser.newContext(contextOptions)
const referencePage = await referenceContext.newPage()
const implementationPage = await implementationContext.newPage()
const results = []

try {
  for (const state of states) {
    await Promise.all([
      prepareReference(referencePage, state),
      prepareImplementation(implementationPage, state),
    ])
    await Promise.all([freezeVisualState(referencePage), freezeVisualState(implementationPage)])

    const outputDir = path.join(EVIDENCE_ROOT, state.id)
    await mkdir(outputDir, { recursive: true })
    const referencePath = path.join(outputDir, 'reference.png')
    const implementationPath = path.join(outputDir, 'current.png')
    const diffPath = path.join(outputDir, 'pixel-diff.png')
    const evidencePath = path.join(outputDir, 'bbox-computed-style.json')
    const reportPath = path.join(outputDir, 'comparison-report.json')
    await Promise.all([
      referencePage
        .locator('#visual-compare-frame')
        .screenshot({ path: referencePath, animations: 'disabled', caret: 'hide', scale: 'css' }),
      implementationPage.locator('#visual-compare-frame').screenshot({
        path: implementationPath,
        animations: 'disabled',
        caret: 'hide',
        scale: 'css',
      }),
    ])
    const pixels = await createPixelDiff(
      implementationPage,
      referencePath,
      implementationPath,
      diffPath,
      PIXEL_THRESHOLD,
    )
    const [reference, implementation] = await Promise.all([
      snapshot(referencePage, 'reference'),
      snapshot(implementationPage, 'implementation'),
    ])
    const semanticDiffs = semanticDifferences(reference, implementation)
    const status =
      semanticDiffs.length === 0 && pixels.changed_pixel_ratio <= MAX_CHANGED_PIXEL_RATIO
        ? 'PASS'
        : 'RED'
    const evidence = {
      state,
      environment: {
        viewport: VIEWPORT,
        deviceScaleFactor: 1,
        locale: 'zh-CN',
        timezoneId: 'Asia/Shanghai',
        colorScheme: 'light',
        reducedMotion: 'reduce',
      },
      reference,
      current: implementation,
    }
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)
    await writeFile(
      reportPath,
      `${JSON.stringify({ state, status, semanticDifferences: semanticDiffs, pixels: { ...pixels, maxChangedPixelRatio: MAX_CHANGED_PIXEL_RATIO }, files: { reference: 'reference.png', current: 'current.png', pixelDiff: 'pixel-diff.png', bboxComputedStyle: 'bbox-computed-style.json' } }, null, 2)}\n`,
    )
    results.push({ id: state.id, status, semanticDifferences: semanticDiffs, pixels })
  }

  for (const state of controlStates) {
    const controlReferencePage = await referenceContext.newPage()
    const controlImplementationPage = await implementationContext.newPage()
    try {
      await Promise.all([
        prepareControlReference(controlReferencePage, state),
        prepareControlImplementation(controlImplementationPage, state),
      ])
      await Promise.all([
        freezeVisualState(controlReferencePage),
        freezeVisualState(controlImplementationPage),
      ])
      const outputDir = path.join(EVIDENCE_ROOT, state.id)
      await mkdir(outputDir, { recursive: true })
      const referencePath = path.join(outputDir, 'reference.png')
      const implementationPath = path.join(outputDir, 'current.png')
      const diffPath = path.join(outputDir, 'pixel-diff.png')
      const evidencePath = path.join(outputDir, 'bbox-computed-style.json')
      const reportPath = path.join(outputDir, 'comparison-report.json')
      await Promise.all([
        controlReferencePage
          .locator('#visual-compare-frame')
          .screenshot({ path: referencePath, animations: 'disabled', caret: 'hide', scale: 'css' }),
        controlImplementationPage.locator('#visual-compare-frame').screenshot({
          path: implementationPath,
          animations: 'disabled',
          caret: 'hide',
          scale: 'css',
        }),
      ])
      const pixels = await createPixelDiff(
        controlImplementationPage,
        referencePath,
        implementationPath,
        diffPath,
        PIXEL_THRESHOLD,
      )
      const [reference, implementation] = await Promise.all([
        controlSnapshot(controlReferencePage, 'reference'),
        controlSnapshot(controlImplementationPage, 'implementation'),
      ])
      const semanticDiffs = controlSemanticDifferences(reference, implementation, state)
      const status =
        semanticDiffs.length === 0 && pixels.changed_pixel_ratio <= MAX_CHANGED_PIXEL_RATIO
          ? 'PASS'
          : 'RED'
      await writeFile(
        evidencePath,
        `${JSON.stringify({ state, environment: { viewport: VIEWPORT, deviceScaleFactor: 1, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', colorScheme: 'light', reducedMotion: 'reduce' }, reference, current: implementation }, null, 2)}\n`,
      )
      await writeFile(
        reportPath,
        `${JSON.stringify({ state, status, semanticDifferences: semanticDiffs, pixels: { ...pixels, maxChangedPixelRatio: MAX_CHANGED_PIXEL_RATIO }, files: { reference: 'reference.png', current: 'current.png', pixelDiff: 'pixel-diff.png', bboxComputedStyle: 'bbox-computed-style.json' } }, null, 2)}\n`,
      )
      results.push({ id: state.id, status, semanticDifferences: semanticDiffs, pixels })
    } finally {
      await controlReferencePage.close()
      await controlImplementationPage.close()
    }
  }
} finally {
  await referenceContext.close()
  await implementationContext.close()
  await browser.close()
}

const summary = {
  contract: 'REG-CHAT-THINK-PROGRESS-019',
  environment: {
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    colorScheme: 'light',
    reducedMotion: 'reduce',
  },
  realProviderCalls: 0,
  totals: {
    states: results.length,
    passed: results.filter((result) => result.status === 'PASS').length,
    red: results.filter((result) => result.status === 'RED').length,
  },
  results,
}
await writeFile(path.join(EVIDENCE_ROOT, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
console.log(JSON.stringify(summary.totals))
if (summary.totals.red > 0) process.exitCode = 1
