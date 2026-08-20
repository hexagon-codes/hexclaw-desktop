import { chromium } from '@playwright/test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const ROOT = path.resolve(process.cwd())
const REFERENCE_URL =
  process.env.HEX_COMPOSER_REFERENCE_URL ?? 'http://127.0.0.1:16070/app.html'
const CURRENT_URL = process.env.HEX_COMPOSER_CURRENT_URL ?? 'http://127.0.0.1:16061/chat'
const EVIDENCE_ROOT =
  process.env.HEX_COMPOSER_EVIDENCE_ROOT ??
  path.resolve(
    ROOT,
    '../hexclaw-docs/test/evidence/chat-composer-voice-skill-prompt-001/visual-current-source',
  )
const VIEWPORT = { width: 1440, height: 900 }
const DEVICE_SCALE_FACTOR = 1
const PIXEL_THRESHOLD = 8
const MAX_CHANGED_PIXEL_RATIO = 0.01
const FRAME_WIDTH = 1100
const SESSION_ID = 'chat-composer-visual-session'
const NOW = '2026-08-20T08:00:00.000Z'
const TEXT_DRAFT = '请帮我整理今天的任务。'

const usage = `Usage: node tests/e2e/chat-composer-prototype-compare.mjs

Captures paired authoritative-prototype/current-source Composer evidence for:
  empty, text, recording, skills-popup, prompts-popup

Environment overrides:
  HEX_COMPOSER_REFERENCE_URL   default http://127.0.0.1:16070/app.html
  HEX_COMPOSER_CURRENT_URL     default http://127.0.0.1:16061/chat
  HEX_COMPOSER_EVIDENCE_ROOT   derived ../hexclaw-docs/test/evidence path

Both URLs must be loopback addresses. The source fixture blocks every non-loopback
HTTP request and replaces WebSocket plus speech recognition with local fakes.
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

assertLoopbackURL(REFERENCE_URL, 'HEX_COMPOSER_REFERENCE_URL')
assertLoopbackURL(CURRENT_URL, 'HEX_COMPOSER_CURRENT_URL')

const states = [
  { id: 'empty', kind: 'empty', frameHeight: 176 },
  { id: 'text', kind: 'text', frameHeight: 176 },
  { id: 'recording', kind: 'recording', frameHeight: 176 },
  { id: 'skills-popup', kind: 'skills-popup', frameHeight: 440 },
  { id: 'prompts-popup', kind: 'prompts-popup', frameHeight: 440 },
]

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
            reasoningControl,
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
          reasoning_control: reasoningControl,
        },
      ],
    },
  },
}

const fixtureSkills = [
  {
    name: 'translate-polish',
    display_name: '翻译润色',
    description: '把中英文内容翻译为地道表达，保留代码与专有名词。',
    version: '1.0.0',
    author: 'hexclaw',
    triggers: [],
    tags: ['writing'],
    enabled: true,
  },
  {
    name: 'web-fetch',
    display_name: '网页抓取',
    description: '读取网页正文，保留标题、作者、日期并生成摘要。',
    version: '1.0.0',
    author: 'hexclaw',
    triggers: [],
    tags: ['research'],
    enabled: true,
  },
  {
    name: 'sql-analyst',
    display_name: 'SQL 分析师',
    description: '根据自然语言生成查询、解释结果并发现异常。',
    version: '1.0.0',
    author: 'hexclaw',
    triggers: [],
    tags: ['data'],
    enabled: true,
  },
]

const fixturePrompts = [
  {
    id: 'pr-translate',
    type: 'prompt',
    title: '翻译润色',
    body_md: '把以下内容翻译为地道、通顺的中文。',
    args_json: '{}',
    tool_scope: '',
    model: '',
    category: '片段',
    enabled: true,
    updated_at: NOW,
  },
  {
    id: 'pr-minutes',
    type: 'prompt',
    title: '会议纪要',
    body_md: '把讨论整理为议题、结论与待办。',
    args_json: '{}',
    tool_scope: '',
    model: '',
    category: '片段',
    enabled: true,
    updated_at: NOW,
  },
  {
    id: 'pr-review',
    type: 'prompt',
    title: '每日复盘',
    body_md: '用三段结构整理当天完成、计划与卡点。',
    args_json: '{}',
    tool_scope: '',
    model: '',
    category: '片段',
    enabled: true,
    updated_at: NOW,
  },
]

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

function runtimeFixture(apiPath, method) {
  if (apiPath === '/health') return { status: 'healthy' }
  if (apiPath === '/api/v1/config') return sourceAppConfig
  if (apiPath === '/api/v1/config/llm') return backendLLMConfig
  if (apiPath === '/api/v1/ollama/status') {
    return { running: false, associated: false, models: [] }
  }
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
          title: 'Composer 视觉基准',
          user_id: 'desktop-user',
          created_at: NOW,
          updated_at: NOW,
          message_count: 0,
        },
      ],
      total: 1,
    }
  }
  if (apiPath === `/api/v1/sessions/${SESSION_ID}/messages`) {
    return { messages: [], total: 0 }
  }
  if (apiPath === `/api/v1/sessions/${SESSION_ID}/branches`) {
    return { branches: [], total: 0 }
  }
  if (apiPath === `/api/v1/sessions/${SESSION_ID}/artifacts`) {
    return { artifacts: [], total: 0 }
  }
  if (apiPath === '/api/v1/streams/active') return { streams: [], total: 0 }
  if (apiPath === '/api/v1/skills') {
    return { dir: '/tmp/hexclaw-composer-skills', skills: fixtureSkills, total: fixtureSkills.length }
  }
  if (apiPath === '/api/v1/prompts' || apiPath === '/api/v1/prompts/all') {
    return { prompts: fixturePrompts, total: fixturePrompts.length }
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

async function installSourceFixture(page, blockedRequests) {
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

      class MockSpeechRecognition extends EventTarget {
        continuous = false
        interimResults = true
        lang = 'zh-CN'
        onresult = null
        onerror = null
        onend = null

        start() {}

        stop() {
          queueMicrotask(() => this.onend?.())
        }

        abort() {
          queueMicrotask(() => this.onend?.())
        }
      }

      Object.defineProperty(window, 'WebSocket', {
        configurable: true,
        writable: true,
        value: MockWebSocket,
      })
      Object.defineProperty(window, 'SpeechRecognition', {
        configurable: true,
        writable: true,
        value: MockSpeechRecognition,
      })
      Object.defineProperty(window, 'webkitSpeechRecognition', {
        configurable: true,
        writable: true,
        value: MockSpeechRecognition,
      })
    },
    { config: sourceAppConfig, session: SESSION_ID },
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
    json(route, { models: [], version: 'chat-composer-visual-fixture' }),
  )
  await page.route('**/_hexclaw/**', (route) => {
    const requestURL = new URL(route.request().url())
    const apiPath = requestURL.pathname.replace(/^\/_hexclaw/, '')
    return json(route, runtimeFixture(apiPath, route.request().method()))
  })
}

async function prepareReference(page, state) {
  await page.goto(REFERENCE_URL, { waitUntil: 'domcontentloaded', timeout: 12_000 })
  await page.locator('.screen[data-pane="chat"]').waitFor({ state: 'visible', timeout: 5_000 })
  await page.evaluate((kind) => {
    window.openNormalChat?.()
    window.applyChatWorkspaceMode?.('sessions')
    const stateName = kind === 'text' ? 'text' : kind === 'recording' ? 'recording' : 'empty'
    window.setChatComposerPrototypeState?.(stateName)
  }, state.kind)
  await page.locator('#chatNormalView .chat-input').waitFor({ state: 'visible' })
  if (state.kind === 'recording') {
    await page.locator('#chatNormalView [data-chat-voice-panel]').waitFor({ state: 'visible' })
  }
  if (state.kind === 'skills-popup') {
    await page.locator('.ci-action', { hasText: '技能' }).click()
    await page.locator('.tpl-popup').waitFor({ state: 'visible' })
    await waitForPopupItems(page, 3)
  } else if (state.kind === 'prompts-popup') {
    await page.locator('.ci-action', { hasText: '提示词' }).click()
    await page.locator('.tpl-popup').waitFor({ state: 'visible' })
    await waitForPopupItems(page, 4)
  } else if (state.kind !== 'recording') {
    await page.evaluate(() => document.activeElement?.blur())
  }
  await mountComparisonFrame(page, 'reference', state.frameHeight)
  await repositionPopup(page, 'reference')
}

async function prepareCurrent(page, state, blockedRequests) {
  await installSourceFixture(page, blockedRequests)
  await page.goto(CURRENT_URL, { waitUntil: 'domcontentloaded', timeout: 12_000 })
  await page.locator('#splash-screen').waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {})
  await page.locator('.hc-composer__box--primary').waitFor({ state: 'visible', timeout: 10_000 })
  await page.locator('.hc-model-selector__name').filter({ hasText: 'gpt-5.6-terra' }).waitFor({
    state: 'visible',
    timeout: 10_000,
  })
  const skillTrigger = page.locator('.hc-composer__tool--labeled', { hasText: '技能' })
  await skillTrigger.waitFor({ state: 'visible' })
  await skillTrigger.evaluate((element) => {
    if (element.disabled) throw new Error('skill fixture did not enable the Skill trigger')
  })

  if (state.kind === 'text') {
    await page.locator('[data-testid="chat-input"]').fill(TEXT_DRAFT)
    await page.locator('[data-testid="chat-send"]').waitFor({ state: 'visible' })
  } else if (state.kind === 'recording') {
    await page.locator('[data-testid="chat-voice-start"]').click()
    await page.locator('[data-testid="chat-voice-panel"]').waitFor({ state: 'visible' })
  }

  if (state.kind === 'skills-popup') {
    await page.locator('.hc-composer__tool--labeled', { hasText: '技能' }).click()
    await page.locator('.tpl-popup').waitFor({ state: 'visible' })
    await waitForPopupItems(page, 3)
  } else if (state.kind === 'prompts-popup') {
    await page.locator('.hc-composer__tool--labeled', { hasText: '提示词' }).click()
    await page.locator('.tpl-popup').waitFor({ state: 'visible' })
    await waitForPopupItems(page, 4)
  } else if (state.kind !== 'recording') {
    await page.evaluate(() => document.activeElement?.blur())
  }
  await mountComparisonFrame(page, 'current', state.frameHeight)
  await repositionPopup(page, 'current')
}

async function waitForPopupItems(page, count) {
  await page.waitForFunction(
    (expected) => document.querySelectorAll('.tpl-popup .tpl-popup__item').length === expected,
    count,
  )
}

async function mountComparisonFrame(page, source, frameHeight) {
  await page.evaluate(
    ({ sourceName, height, width }) => {
      document.documentElement.dataset.theme = 'light'
      const composer = document.querySelector(
        sourceName === 'reference' ? '#chatNormalView .chat-input' : '.hc-composer',
      )
      if (!composer) throw new Error(`${sourceName} composer is missing`)
      const frame = document.createElement('main')
      frame.id = 'visual-compare-frame'
      frame.dataset.source = sourceName
      frame.style.width = `${width}px`
      frame.style.height = `${height}px`
      const popup = document.querySelector('.tpl-popup')
      if (sourceName === 'reference') {
        const scope = document.querySelector('#chatNormalView')
        if (!scope) throw new Error('reference Composer scope is missing')
        scope.replaceChildren(composer)
        frame.append(scope)
      } else {
        frame.append(composer)
      }
      document.body.replaceChildren(frame)
      if (popup) document.body.append(popup)
    },
    { sourceName: source, height: frameHeight, width: FRAME_WIDTH },
  )
  await page.addStyleTag({
    content: `
      html,body{margin:0!important;width:100%;min-height:100%;background:var(--hc-bg-main)!important}
      body{overflow:hidden!important}
      #visual-compare-frame{box-sizing:border-box;padding:30px 24px 18px;display:flex;align-items:flex-end;overflow:hidden;background:var(--hc-bg-main);color:var(--hc-text-primary);font-family:-apple-system,BlinkMacSystemFont,'SF Pro Display','SF Pro Text','Helvetica Neue','PingFang SC','Hiragino Sans GB','Microsoft YaHei','Segoe UI',sans-serif}
      #visual-compare-frame>#chatNormalView{display:contents!important}
      #visual-compare-frame .chat-input,#visual-compare-frame>.hc-composer{box-sizing:border-box;width:100%;margin:0!important;flex:none}
    `,
  })
}

async function repositionPopup(page, source) {
  await page.evaluate((sourceName) => {
    const popup = document.querySelector('.tpl-popup')
    if (!popup) return
    const composer = document.querySelector(
      sourceName === 'reference' ? '#chatNormalView .chat-input' : '.hc-composer',
    )
    if (!composer) throw new Error(`${sourceName} Composer is missing while positioning popup`)
    const composerRect = composer.getBoundingClientRect()
    const popupRect = popup.getBoundingClientRect()
    popup.style.left = `${Math.min(composerRect.left + 14, window.innerWidth - popupRect.width - 12)}px`
    popup.style.top = `${composerRect.top - popupRect.height - 8}px`
    popup.style.right = 'auto'
    popup.style.bottom = 'auto'
  }, source)
}

async function freezeVisualState(page) {
  await page.addStyleTag({
    content:
      '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}',
  })
  await page.evaluate(async () => {
    if ('fonts' in document) await document.fonts.ready
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const time = document.querySelector('.composer-voice__time,.hc-composer__voice-time')
    if (time) {
      const normalizeTime = () => {
        if (time.textContent !== '00:00') time.textContent = '00:00'
        if (time.getAttribute('datetime') !== 'PT0S') time.setAttribute('datetime', 'PT0S')
      }
      normalizeTime()
      new MutationObserver(normalizeTime).observe(time, {
        attributes: true,
        childList: true,
        characterData: true,
        subtree: true,
      })
    }
  })
}

const targetPairs = {
  base: [
    ['composer', '.chat-input', '.hc-composer__box'],
    ['editor', '[data-chat-composer-input]', '[data-testid="chat-input"]'],
    ['bar', '.chat-input .row', '.hc-composer__bar'],
    ['tools', '.chat-input .row', '.hc-composer__tools'],
    ['skill-trigger', '.ci-action:nth-of-type(2)', '.hc-composer__tool--labeled:nth-of-type(2)'],
    ['prompt-trigger', '.ci-action:nth-of-type(3)', '.hc-composer__tool--labeled:nth-of-type(3)'],
    ['model', '[data-chat-model-selector]', '.hc-model-selector__btn'],
    ['thinking', '[data-thinking-toggle]', '.hc-chat__thinking-control'],
    ['action-divider', '.ci-action-divider', '.hc-composer__action-divider'],
    ['primary', '[data-chat-primary-action]', '.hc-composer__send'],
  ],
  recording: [
    ['voice-panel', '[data-chat-voice-panel]', '[data-testid="chat-voice-panel"]'],
    ['voice-copy', '.composer-voice__copy', '.hc-composer__voice-copy'],
    ['voice-status', '.composer-voice__status', '.hc-composer__voice-status'],
    ['voice-time', '.composer-voice__time', '.hc-composer__voice-time'],
    ['voice-controls', '.composer-voice__controls', '.hc-composer__voice-controls'],
    ['voice-cancel', '.composer-voice__button:first-child', '[data-testid="chat-voice-cancel"]'],
    ['voice-wave', '.composer-voice__wave', '.hc-composer__voice-wave'],
    ['voice-send', '[data-voice-send]', '[data-testid="chat-voice-send"]'],
  ],
  popup: [
    ['popup', '.tpl-popup', '.tpl-popup'],
    ['popup-header', '.tpl-popup__header', '.tpl-popup__header'],
    ['popup-list', '.tpl-popup__list', '.tpl-popup__list'],
    ['popup-items', '.tpl-popup__item', '.tpl-popup__item', true],
    ['popup-icons', '.tpl-popup__item>.tpl-popup__icon', '.tpl-popup__item>.tpl-popup__icon', true],
    ['popup-actions', '.tpl-popup__skill-actions', '.tpl-popup__skill-actions'],
  ],
}

async function captureTargets(page, source, state) {
  const pairs = [
    ...targetPairs.base,
    ...(state.kind === 'recording' ? targetPairs.recording : []),
    ...(state.kind.endsWith('popup') ? targetPairs.popup : []),
  ]
  const sourceIndex = source === 'reference' ? 1 : 2
  const targets = pairs.map(([name, reference, current, all = false]) => ({
    name,
    selector: sourceIndex === 1 ? reference : current,
    all,
  }))
  return page.evaluate((items) => {
    const round = (value) => Number(value.toFixed(2))
    const styleKeys = [
      'display',
      'visibility',
      'position',
      'zIndex',
      'boxSizing',
      'width',
      'height',
      'minHeight',
      'maxHeight',
      'padding',
      'margin',
      'gap',
      'background',
      'backgroundColor',
      'backgroundImage',
      'border',
      'borderRadius',
      'boxShadow',
      'color',
      'fontFamily',
      'fontSize',
      'fontWeight',
      'lineHeight',
      'overflow',
      'opacity',
      'cursor',
    ]
    return items.flatMap((target) => {
      const elements = target.all
        ? [...document.querySelectorAll(target.selector)]
        : [...document.querySelectorAll(target.selector)].slice(0, 1)
      if (elements.length === 0) return [{ ...target, index: 0, found: false }]
      return elements.map((element, index) => {
        const rect = element.getBoundingClientRect()
        const computed = getComputedStyle(element)
        return {
          ...target,
          index,
          found: true,
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
          text: (element.textContent ?? '').replace(/\s+/g, ' ').trim(),
          attributes: {
            title: element.getAttribute('title'),
            ariaLabel: element.getAttribute('aria-label'),
            ariaBusy: element.getAttribute('aria-busy'),
            ariaPressed: element.getAttribute('aria-pressed'),
            disabled: 'disabled' in element ? element.disabled : null,
            hidden: element.hidden,
            dataMode: element.dataset.mode ?? null,
          },
        }
      })
    })
  }, targets)
}

async function captureContract(page, source, state) {
  return page.evaluate(
    ({ sourceName, stateKind, expectedText }) => {
      const reference = sourceName === 'reference'
      const one = (referenceSelector, currentSelector) =>
        document.querySelector(reference ? referenceSelector : currentSelector)
      const composer = one('.chat-input', '.hc-composer__box')
      const editor = one('[data-chat-composer-input]', '[data-testid="chat-input"]')
      const primary = one('[data-chat-primary-action]', '.hc-composer__send')
      const skill = one('.ci-action:nth-of-type(2)', '.hc-composer__tool--labeled:nth-of-type(2)')
      const prompt = one('.ci-action:nth-of-type(3)', '.hc-composer__tool--labeled:nth-of-type(3)')
      const popup = document.querySelector('.tpl-popup')
      const box = (element) => {
        if (!element) return null
        const rect = element.getBoundingClientRect()
        return {
          x: Number(rect.x.toFixed(2)),
          y: Number(rect.y.toFixed(2)),
          width: Number(rect.width.toFixed(2)),
          height: Number(rect.height.toFixed(2)),
        }
      }
      const text = (element) => (element?.textContent ?? '').replace(/\s+/g, ' ').trim()
      const editorText = reference ? editor?.value ?? '' : editor?.textContent ?? ''
      const editorPlaceholder = reference
        ? editor?.getAttribute('placeholder')
        : editor?.getAttribute('data-placeholder')
      const currentVoice = !reference && !!document.querySelector('[data-testid="chat-voice-start"]')
      const currentSend = !reference && !!document.querySelector('[data-testid="chat-send"]')
      const primaryMode = reference
        ? primary?.dataset.mode ?? null
        : currentVoice
          ? 'voice'
          : currentSend
            ? 'send'
            : null
      const voiceCancel = one(
        '.composer-voice__button:first-child',
        '[data-testid="chat-voice-cancel"]',
      )
      const voiceSend = one('[data-voice-send]', '[data-testid="chat-voice-send"]')
      const voiceTranscript = one(
        '[data-voice-transcript]:not([hidden])',
        '[data-testid="chat-voice-transcript"]',
      )
      const popupItems = [...document.querySelectorAll('.tpl-popup__item')]
      return {
        source: sourceName,
        state: stateKind,
        composer: {
          rect: box(composer),
          voice: composer?.classList.contains(
            reference ? 'is-voice-recording' : 'hc-composer__box--voice',
          ),
        },
        editor: {
          text: editorText,
          placeholder: editorPlaceholder,
          expectedText,
        },
        triggers: { skill: text(skill), prompt: text(prompt) },
        primary: {
          mode: primaryMode,
          disabled: primary && 'disabled' in primary ? primary.disabled : null,
          title: primary?.getAttribute('title') ?? null,
        },
        voice:
          stateKind === 'recording'
            ? {
                status: text(
                  one('.composer-voice__status', '.hc-composer__voice-status'),
                ),
                time: text(one('.composer-voice__time', '.hc-composer__voice-time')),
                cancelDisabled:
                  voiceCancel && 'disabled' in voiceCancel ? voiceCancel.disabled : null,
                sendDisabled: voiceSend && 'disabled' in voiceSend ? voiceSend.disabled : null,
                transcriptVisible: !!voiceTranscript,
                waveBars: document.querySelectorAll(
                  reference ? '.composer-voice__wave span' : '.hc-composer__voice-wave span',
                ).length,
              }
            : null,
        popup: popup
          ? {
              rect: box(popup),
              title: text(document.querySelector('.tpl-popup__title')),
              items: popupItems.map((item) => text(item)),
              actions: [...document.querySelectorAll('.tpl-popup__action')].map((item) => text(item)),
              relativeToComposer: {
                left: Number((popup.getBoundingClientRect().left - composer.getBoundingClientRect().left).toFixed(2)),
                gap: Number((composer.getBoundingClientRect().top - popup.getBoundingClientRect().bottom).toFixed(2)),
              },
            }
          : null,
      }
    },
    { sourceName: source, stateKind: state.kind, expectedText: TEXT_DRAFT },
  )
}

function semanticDifferences(reference, current, state) {
  const differences = []
  const compare = (pathName, left, right) => {
    if (JSON.stringify(left) !== JSON.stringify(right)) differences.push(pathName)
  }
  compare('composer.height', reference.composer.rect?.height, current.composer.rect?.height)
  if (reference.composer.rect?.height !== 116) differences.push('reference.composer.height!=116')
  if (current.composer.rect?.height !== 116) differences.push('current.composer.height!=116')
  compare('composer.voice', reference.composer.voice, current.composer.voice)
  compare('editor.text', reference.editor.text, current.editor.text)
  compare('editor.placeholder', reference.editor.placeholder, current.editor.placeholder)
  compare('triggers.skill', reference.triggers.skill, current.triggers.skill)
  compare('triggers.prompt', reference.triggers.prompt, current.triggers.prompt)
  compare('primary.mode', reference.primary.mode, current.primary.mode)
  compare('primary.disabled', reference.primary.disabled, current.primary.disabled)
  compare('primary.title', reference.primary.title, current.primary.title)
  if (state.kind === 'recording') {
    for (const key of [
      'status',
      'time',
      'cancelDisabled',
      'sendDisabled',
      'transcriptVisible',
      'waveBars',
    ]) {
      compare(`voice.${key}`, reference.voice?.[key], current.voice?.[key])
    }
    if (reference.voice?.sendDisabled !== false || current.voice?.sendDisabled !== false) {
      differences.push('voice.sendMustRemainEnabled')
    }
  }
  if (state.kind.endsWith('popup')) {
    for (const key of ['title', 'items', 'actions']) {
      compare(`popup.${key}`, reference.popup?.[key], current.popup?.[key])
    }
    for (const key of ['left', 'gap']) {
      const left = reference.popup?.relativeToComposer?.[key]
      const right = current.popup?.relativeToComposer?.[key]
      if (left == null || right == null || Math.abs(left - right) > 1) {
        differences.push(`popup.relativeToComposer.${key}`)
      }
    }
  } else if (reference.popup || current.popup) {
    differences.push('popup.unexpected')
  }
  return [...new Set(differences)]
}

const criticalStyleKeys = {
  composer: [
    'width',
    'height',
    'minHeight',
    'padding',
    'backgroundColor',
    'backgroundImage',
    'borderRadius',
    'boxShadow',
    'color',
    'fontSize',
    'lineHeight',
  ],
  editor: [
    'width',
    'height',
    'minHeight',
    'maxHeight',
    'backgroundColor',
    'color',
    'fontFamily',
    'fontSize',
    'fontWeight',
    'lineHeight',
  ],
  bar: [
    'width',
    'height',
    'margin',
    'backgroundColor',
    'color',
    'fontFamily',
    'fontSize',
    'fontWeight',
    'lineHeight',
  ],
  'skill-trigger': [
    'width',
    'height',
    'padding',
    'gap',
    'backgroundColor',
    'borderRadius',
    'color',
    'fontSize',
    'fontWeight',
    'lineHeight',
    'opacity',
  ],
  'prompt-trigger': [
    'width',
    'height',
    'padding',
    'gap',
    'backgroundColor',
    'borderRadius',
    'color',
    'fontSize',
    'fontWeight',
    'lineHeight',
    'opacity',
  ],
  model: [
    'width',
    'height',
    'padding',
    'gap',
    'backgroundColor',
    'borderRadius',
    'color',
    'fontSize',
    'fontWeight',
    'lineHeight',
    'opacity',
  ],
  thinking: [
    'width',
    'height',
    'padding',
    'gap',
    'backgroundColor',
    'borderRadius',
    'color',
    'fontSize',
    'fontWeight',
    'lineHeight',
    'opacity',
  ],
  'action-divider': ['width', 'height', 'margin', 'backgroundColor', 'opacity'],
  primary: [
    'width',
    'height',
    'backgroundColor',
    'backgroundImage',
    'borderRadius',
    'boxShadow',
    'color',
    'opacity',
    'cursor',
  ],
  'voice-panel': ['width', 'height', 'minHeight', 'padding', 'gap', 'backgroundColor', 'color'],
  'voice-copy': [
    'width',
    'height',
    'padding',
    'gap',
    'color',
    'fontSize',
    'fontWeight',
    'lineHeight',
  ],
  'voice-status': [
    'width',
    'height',
    'padding',
    'gap',
    'color',
    'fontSize',
    'fontWeight',
    'lineHeight',
  ],
  'voice-time': ['width', 'height', 'padding', 'color', 'fontSize', 'fontWeight', 'lineHeight'],
  'voice-controls': ['width', 'height', 'padding', 'gap', 'color'],
  'voice-cancel': [
    'width',
    'height',
    'backgroundColor',
    'borderRadius',
    'boxShadow',
    'color',
    'opacity',
    'cursor',
  ],
  'voice-wave': ['width', 'height', 'gap', 'color', 'overflow', 'opacity'],
  'voice-send': [
    'width',
    'height',
    'backgroundColor',
    'borderRadius',
    'boxShadow',
    'color',
    'opacity',
    'cursor',
  ],
  popup: [
    'width',
    'height',
    'padding',
    'backgroundColor',
    'borderRadius',
    'boxShadow',
    'color',
    'fontFamily',
    'fontSize',
    'fontWeight',
    'lineHeight',
    'overflow',
    'opacity',
  ],
  'popup-header': [
    'width',
    'height',
    'padding',
    'backgroundColor',
    'color',
    'fontSize',
    'fontWeight',
    'lineHeight',
  ],
  'popup-list': ['width', 'height', 'padding', 'backgroundColor', 'color', 'overflow'],
  'popup-items': [
    'width',
    'height',
    'padding',
    'gap',
    'backgroundColor',
    'borderRadius',
    'color',
    'fontSize',
    'fontWeight',
    'lineHeight',
  ],
  'popup-icons': ['width', 'height', 'padding', 'color', 'opacity'],
  'popup-actions': ['width', 'height', 'padding', 'backgroundColor', 'color'],
}

function structuralDifferences(referenceTargets, currentTargets, state) {
  const normalNames = [
    'composer',
    'editor',
    'bar',
    'skill-trigger',
    'prompt-trigger',
    'model',
    'thinking',
    'action-divider',
    'primary',
  ]
  const voiceNames = [
    'composer',
    'voice-panel',
    'voice-copy',
    'voice-status',
    'voice-time',
    'voice-controls',
    'voice-cancel',
    'voice-wave',
    'voice-send',
  ]
  const popupNames = [
    'popup',
    'popup-header',
    'popup-list',
    'popup-items',
    'popup-icons',
    'popup-actions',
  ]
  const targetNames = [
    ...(state.kind === 'recording' ? voiceNames : normalNames),
    ...(state.kind.endsWith('popup') ? popupNames : []),
  ]
  const group = (targets) =>
    targets.reduce((result, target) => {
      ;(result[target.name] ??= []).push(target)
      return result
    }, {})
  const reference = group(referenceTargets)
  const current = group(currentTargets)
  const differences = []
  for (const name of targetNames) {
    const referenceItems = reference[name] ?? []
    const currentItems = current[name] ?? []
    if (referenceItems.length !== currentItems.length) {
      differences.push(`${name}.count`)
      continue
    }
    for (let index = 0; index < referenceItems.length; index += 1) {
      const referenceItem = referenceItems[index]
      const currentItem = currentItems[index]
      if (referenceItem.found !== currentItem.found) {
        differences.push(`${name}[${index}].found`)
        continue
      }
      if (!referenceItem.found) continue
      for (const key of ['x', 'y', 'width', 'height']) {
        if (Math.abs(referenceItem.rect[key] - currentItem.rect[key]) > 0.5) {
          differences.push(`${name}[${index}].rect.${key}`)
        }
      }
      for (const key of criticalStyleKeys[name] ?? []) {
        if (referenceItem.style[key] !== currentItem.style[key]) {
          differences.push(`${name}[${index}].style.${key}`)
        }
      }
    }
  }
  return differences
}

async function runPixelDiff(page, referencePath, currentPath, diffPath) {
  const [reference, current] = await Promise.all([
    readFile(referencePath, 'base64'),
    readFile(currentPath, 'base64'),
  ])
  const result = await page.evaluate(
    async ({ referencePng, currentPng, threshold }) => {
      const loadImage = (source) =>
        new Promise((resolve, reject) => {
          const image = new Image()
          image.onload = () => resolve(image)
          image.onerror = reject
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
        throw new Error(
          `screenshot size mismatch: reference=${referenceImage.width}x${referenceImage.height}, current=${currentImage.width}x${currentImage.height}`,
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
      sourceContext.drawImage(currentImage, 0, 0)
      const currentPixels = sourceContext.getImageData(0, 0, width, height).data
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
            Math.abs(referencePixels[index] - currentPixels[index]),
            Math.abs(referencePixels[index + 1] - currentPixels[index + 1]),
            Math.abs(referencePixels[index + 2] - currentPixels[index + 2]),
            Math.abs(referencePixels[index + 3] - currentPixels[index + 3]),
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
        threshold,
        changed_pixels: changedPixels,
        total_pixels: width * height,
        changed_pixel_ratio: changedPixels / (width * height),
        changed_bbox: changedPixels > 0 ? [minX, minY, maxX + 1, maxY + 1] : null,
      }
    },
    { referencePng: reference, currentPng: current, threshold: PIXEL_THRESHOLD },
  )
  await writeFile(diffPath, Buffer.from(result.png, 'base64'))
  delete result.png
  return result
}

await mkdir(EVIDENCE_ROOT, { recursive: true })
const browser = await chromium.launch()
const contextOptions = {
  viewport: VIEWPORT,
  deviceScaleFactor: DEVICE_SCALE_FACTOR,
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
  colorScheme: 'light',
  reducedMotion: 'reduce',
}
const results = []

try {
  for (const state of states) {
    const referenceContext = await browser.newContext(contextOptions)
    const currentContext = await browser.newContext(contextOptions)
    const referencePage = await referenceContext.newPage()
    const currentPage = await currentContext.newPage()
    const blockedRequests = []
    try {
      await Promise.all([
        prepareReference(referencePage, state),
        prepareCurrent(currentPage, state, blockedRequests),
      ])
      await Promise.all([freezeVisualState(referencePage), freezeVisualState(currentPage)])

      const outputDir = path.join(EVIDENCE_ROOT, state.id)
      await mkdir(outputDir, { recursive: true })
      const referencePath = path.join(outputDir, 'reference.png')
      const currentPath = path.join(outputDir, 'current.png')
      const diffPath = path.join(outputDir, 'pixel-diff.png')
      const bboxPath = path.join(outputDir, 'bbox-computed-style.json')
      const reportPath = path.join(outputDir, 'comparison-report.json')

      await Promise.all([
        referencePage.locator('#visual-compare-frame').screenshot({
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
      const pixels = await runPixelDiff(currentPage, referencePath, currentPath, diffPath)
      const [referenceTargets, currentTargets, referenceContract, currentContract] =
        await Promise.all([
          captureTargets(referencePage, 'reference', state),
          captureTargets(currentPage, 'current', state),
          captureContract(referencePage, 'reference', state),
          captureContract(currentPage, 'current', state),
        ])
      const semanticDiffs = semanticDifferences(referenceContract, currentContract, state)
      const structuralDiffs = structuralDifferences(referenceTargets, currentTargets, state)
      const status =
        semanticDiffs.length === 0 &&
        structuralDiffs.length === 0 &&
        blockedRequests.length === 0 &&
        pixels.changed_pixel_ratio <= MAX_CHANGED_PIXEL_RATIO
          ? 'PASS'
          : 'RED'
      const evidence = {
        state,
        environment: {
          viewport: VIEWPORT,
          deviceScaleFactor: DEVICE_SCALE_FACTOR,
          locale: 'zh-CN',
          timezoneId: 'Asia/Shanghai',
          colorScheme: 'light',
          reducedMotion: 'reduce',
          frame: { width: FRAME_WIDTH, height: state.frameHeight },
          referenceURL: REFERENCE_URL,
          currentURL: CURRENT_URL,
          networkPolicy: 'loopback-only; mocked WebSocket and SpeechRecognition',
        },
        normalization: [
          'Both canonical Composer nodes are moved into the same fixed comparison frame.',
          'The frame supplies equal parent padding/background without replacing component styles.',
          'Animations, transitions and caret are disabled; recording time is normalized to 00:00.',
        ],
        structuralComparison: {
          geometryTolerancePixels: 0.5,
          criticalStyleKeys,
          differences: structuralDiffs,
        },
        reference: { contract: referenceContract, targets: referenceTargets },
        current: { contract: currentContract, targets: currentTargets },
      }
      const report = {
        id: state.id,
        status,
        semanticDifferences: semanticDiffs,
        structuralDifferences: structuralDiffs,
        blockedRequests,
        pixels: { ...pixels, maxChangedPixelRatio: MAX_CHANGED_PIXEL_RATIO },
        files: {
          reference: 'reference.png',
          current: 'current.png',
          pixelDiff: 'pixel-diff.png',
          bboxComputedStyle: 'bbox-computed-style.json',
        },
      }
      await Promise.all([
        writeFile(bboxPath, `${JSON.stringify(evidence, null, 2)}\n`),
        writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`),
      ])
      results.push(report)
      process.stdout.write(
        `${state.id}: ${status}; changed=${(pixels.changed_pixel_ratio * 100).toFixed(3)}%; semantic=${semanticDiffs.join(',') || 'none'}; structural=${structuralDiffs.join(',') || 'none'}\n`,
      )
    } finally {
      await Promise.all([referenceContext.close(), currentContext.close()])
    }
  }
} finally {
  await browser.close()
}

const summary = {
  status: results.every((result) => result.status === 'PASS') ? 'PASS' : 'RED',
  total: states.length,
  passed: results.filter((result) => result.status === 'PASS').length,
  environment: {
    viewport: VIEWPORT,
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    colorScheme: 'light',
  },
  thresholds: { pixel: PIXEL_THRESHOLD, maxChangedPixelRatio: MAX_CHANGED_PIXEL_RATIO },
  results,
}
await writeFile(path.join(EVIDENCE_ROOT, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
process.stdout.write(`summary: ${summary.status}; ${summary.passed}/${summary.total} PASS\n`)
if (summary.status !== 'PASS') process.exitCode = 1
