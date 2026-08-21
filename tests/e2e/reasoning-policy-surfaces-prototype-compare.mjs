import { chromium } from '@playwright/test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const ROOT = path.resolve(process.cwd())
const EVIDENCE_ROOT = path.resolve(
  ROOT,
  '../hexclaw-docs/test/evidence/reg-chat-thinking-intensity-021/visual-current-source',
)
const REFERENCE_URL =
  process.env.HEX_REASONING_POLICY_REFERENCE_URL ?? 'http://127.0.0.1:16070/app.html'
const IMPLEMENTATION_URL =
  process.env.HEX_REASONING_POLICY_IMPLEMENTATION_URL ?? 'http://127.0.0.1:5173'
const VIEWPORT = { width: 1440, height: 1000 }
const DEVICE_SCALE_FACTOR = 1
const PIXEL_THRESHOLD = 8
const MAX_CHANGED_PIXEL_RATIO = 0.01

const effortControl = {
  dialect: 'reasoning_effort',
  on: 'high',
  off: 'none',
  allowed_efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
}

const sourceConfig = {
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
    defaultModel: 'qwen3.5:32b',
    defaultProviderId: 'fixture-provider-id',
    defaultReasoningPolicy: { mode: 'auto' },
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
        apiKey: '',
        baseUrl: '',
        selectedModelId: 'qwen3.5:32b',
        models: [
          {
            id: 'qwen3.5:32b',
            name: 'qwen3.5:32b',
            capabilities: ['text'],
            reasoningSupport: 'supported',
            reasoningControl: { dialect: 'think', on: true, off: false },
          },
          {
            id: 'gpt-5.6-terra',
            name: 'gpt-5.6-terra',
            capabilities: ['text'],
            reasoningSupport: 'supported',
            reasoningControl: effortControl,
          },
          {
            id: 'gpt-5.6-sol',
            name: 'gpt-5.6-sol',
            capabilities: ['text'],
            reasoningSupport: 'supported',
            reasoningControl: effortControl,
          },
          {
            id: 'GPT-4o',
            name: 'GPT-4o',
            capabilities: ['text'],
            reasoningSupport: 'unsupported',
          },
          {
            id: 'pending-model',
            name: 'pending-model',
            capabilities: ['text'],
            reasoningSupport: 'unknown',
          },
        ],
      },
    ],
  },
}

const backendConfig = {
  default: 'fixture-provider',
  default_reasoning_policy: { mode: 'auto' },
  routing: { enabled: false, strategy: 'cost-aware' },
  cache: { enabled: false, similarity: 0.92, ttl: '24h', max_entries: 10000 },
  providers: {
    'fixture-provider': {
      provider_instance_id: `pvd_v1_${'f'.repeat(32)}`,
      display_name: 'Fixture Provider',
      type: 'openai',
      enabled: true,
      compatible: 'openai',
      api_key: '',
      base_url: '',
      model: 'qwen3.5:32b',
      models: ['qwen3.5:32b', 'gpt-5.6-terra', 'gpt-5.6-sol', 'GPT-4o', 'pending-model'],
      model_specs: [
        {
          id: 'qwen3.5:32b',
          display_name: 'qwen3.5:32b',
          capabilities: ['text'],
          reasoning_support: 'supported',
          reasoning_control: { dialect: 'think', on: true, off: false },
        },
        {
          id: 'gpt-5.6-terra',
          display_name: 'gpt-5.6-terra',
          capabilities: ['text'],
          reasoning_support: 'supported',
          reasoning_control: effortControl,
        },
        {
          id: 'gpt-5.6-sol',
          display_name: 'gpt-5.6-sol',
          capabilities: ['text'],
          reasoning_support: 'supported',
          reasoning_control: effortControl,
        },
        {
          id: 'GPT-4o',
          display_name: 'GPT-4o',
          capabilities: ['text'],
          reasoning_support: 'unsupported',
        },
        {
          id: 'pending-model',
          display_name: 'pending-model',
          capabilities: ['text'],
          reasoning_support: 'unknown',
        },
      ],
    },
  },
}

const agentFixtures = {
  edit: {
    name: 'reporter',
    display_name: '日报分析师',
    provider: 'fixture-provider',
    model: 'gpt-5.6-terra',
    system_prompt: '整理并分析日报。',
    skills: [],
    reasoning_policy: { mode: 'effort', effort: 'high' },
  },
  supported: {
    name: 'tutor',
    display_name: '小明的辅导助手 · 五年级',
    provider: 'fixture-provider',
    model: 'gpt-5.6-sol',
    system_prompt: '帮助学生理解题目。',
    skills: [],
    reasoning_policy: { mode: 'effort', effort: 'high' },
  },
  unsupported: {
    name: 'support',
    display_name: '客服小蟹',
    provider: 'fixture-provider',
    model: 'GPT-4o',
    system_prompt: '处理客服问题。',
    skills: [],
    reasoning_policy: { mode: 'on' },
  },
  unknown: {
    name: 'pending',
    display_name: '待检测智能体',
    provider: 'fixture-provider',
    model: 'pending-model',
    system_prompt: '等待能力检测。',
    skills: [],
    reasoning_policy: { mode: 'auto' },
  },
}

const states = [
  { id: 'settings-default-auto', surface: 'settings', frame: { width: 760, height: 76 } },
  {
    id: 'agent-create-advanced',
    surface: 'agent-create',
    expectedPolicyText: '跟随全局',
    frame: { width: 560, height: 250 },
  },
  {
    id: 'agent-edit-advanced',
    surface: 'agent-edit',
    expectedPolicyText: '高',
    frame: { width: 560, height: 250 },
  },
  {
    id: 'channel-supported-high',
    surface: 'channel',
    capability: 'supported',
    frame: { width: 480, height: 92 },
  },
  {
    id: 'channel-unsupported-hidden',
    surface: 'channel',
    capability: 'unsupported',
    frame: { width: 480, height: 92 },
  },
  {
    id: 'channel-unknown-hidden',
    surface: 'channel',
    capability: 'unknown',
    frame: { width: 480, height: 92 },
  },
]

const stableStyles = `
  *, *::before, *::after {
    animation: none !important;
    transition: none !important;
    caret-color: transparent !important;
  }
  html, body { margin: 0 !important; background: var(--hc-bg-main, #f7f8fa) !important; }
  body { overflow: hidden !important; }
  #visual-compare-frame {
    box-sizing: border-box;
    overflow: hidden;
    padding: 16px;
    background: var(--hc-bg-main, #f7f8fa);
    color: var(--hc-text-primary, #1f2937);
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text',
      'Helvetica Neue', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif;
  }
  #visual-compare-frame > [data-visual-role="root"] { width: 100%; box-sizing: border-box; }
  #visual-compare-frame .visual-current-agent-shell {
    width: 100%;
    box-sizing: border-box;
  }
`

function json(route, payload, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(payload),
  })
}

function channelFixture(capability) {
  const agent = agentFixtures[capability]
  return {
    instance: {
      id: `dingtalk-${capability}`,
      provider: 'dingtalk',
      name: `钉钉-${capability}`,
      enabled: true,
      status: 'running',
      config: { client_id: 'fixture-client', client_secret: 'fixture-secret' },
      created_at: '2026-08-20T08:00:00.000Z',
      updated_at: '2026-08-20T08:00:00.000Z',
    },
    agent,
    rule: {
      id: 21,
      platform: 'dingtalk',
      instance_id: `钉钉-${capability}`,
      user_id: '',
      chat_id: '',
      agent_name: agent.name,
      priority: 0,
    },
  }
}

function runtimeFixture(apiPath, method, state) {
  if (apiPath === '/api/v1/config/llm') return backendConfig
  if (apiPath === '/api/v1/config') return sourceConfig
  if (apiPath === '/api/v1/ollama/status') {
    return { running: false, associated: false, models: [] }
  }
  if (apiPath === '/api/v1/roles') return { roles: [] }
  if (apiPath === '/api/v1/skills') return { skills: [], total: 0, dir: '' }
  if (apiPath === '/api/v1/agents') {
    const agents =
      state.surface === 'channel' ? [channelFixture(state.capability).agent] : [agentFixtures.edit]
    return { agents, total: agents.length, default: agents[0]?.name ?? '' }
  }
  if (apiPath === '/api/v1/agents/rules') {
    const rules = state.surface === 'channel' ? [channelFixture(state.capability).rule] : []
    return { rules, total: rules.length }
  }
  if (apiPath === '/api/v1/platforms/instances') {
    return state.surface === 'channel'
      ? { instances: [channelFixture(state.capability).instance] }
      : { instances: [] }
  }
  if (apiPath === '/api/v1/platforms/instances/health') return { instances: [] }
  if (apiPath === '/api/v1/cronjob' && method === 'POST') {
    return { jobs: [], total: 0 }
  }
  if (apiPath === '/api/v1/mcp/servers') return { servers: [] }
  if (apiPath === '/api/v1/connectors') return { connectors: [], total: 0 }
  if (apiPath.startsWith('/api/k12/')) return { items: [] }
  if (apiPath.startsWith('/api/v1/')) return { items: [], total: 0 }
  return {}
}

async function installImplementationFixture(page, state, externalAttempts) {
  await page.addInitScript((config) => {
    localStorage.clear()
    sessionStorage.clear()
    localStorage.setItem('hc-theme', 'light')
    localStorage.setItem('hc-locale', 'zh-CN')
    localStorage.setItem('hexclaw:welcomeRedirectDone', '1')
    sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
    localStorage.setItem('app_config', JSON.stringify(config))

    const callbacks = new Map()
    let nextCallbackID = 1
    const unregisterCallback = (id) => callbacks.delete(id)
    const transformCallback = (callback, once = false) => {
      const id = nextCallbackID++
      callbacks.set(id, (payload) => {
        if (once) unregisterCallback(id)
        return callback?.(payload)
      })
      return id
    }
    window.__TAURI_INTERNALS__ = {
      callbacks,
      transformCallback,
      unregisterCallback,
      runCallback: (id, payload) => callbacks.get(id)?.(payload),
      invoke: async (command, args = {}) => {
        if (command === 'check_engine_health') return true
        if (command === 'plugin:event|listen') return Number(args.handler ?? 0)
        if (
          command === 'plugin:event|unlisten' ||
          command === 'plugin:event|emit' ||
          command === 'plugin:clipboard-manager|write_text'
        ) {
          return null
        }
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
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener: (_event, id) => unregisterCallback(id),
    }
  }, sourceConfig)

  await page.route('http://localhost:11434/**', (route) =>
    json(route, { models: [], version: 'reasoning-policy-visual' }),
  )
  await page.route('**/_hexclaw/**', (route) => {
    const requestURL = new URL(route.request().url())
    const apiPath = requestURL.pathname.replace(/^\/_hexclaw/, '')
    return json(route, runtimeFixture(apiPath, route.request().method(), state))
  })
  await page.route(/^https?:\/\//, (route) => {
    const url = new URL(route.request().url())
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return route.fallback()
    externalAttempts.push(url.toString())
    return route.abort('blockedbyclient')
  })
}

async function installReferenceNetworkGuard(page, externalAttempts) {
  await page.route(/^https?:\/\//, (route) => {
    const url = new URL(route.request().url())
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return route.continue()
    externalAttempts.push(url.toString())
    return route.abort('blockedbyclient')
  })
}

async function waitForImplementation(page) {
  await page
    .locator('#splash-screen')
    .waitFor({ state: 'detached', timeout: 10_000 })
    .catch(() => undefined)
  await page.evaluate(() => document.fonts.ready)
}

async function createFrame(page, frame, targetSelector, source) {
  await page.evaluate(
    ({ dimensions, selector, sourceName }) => {
      const target = document.querySelector(selector)
      if (!target) throw new Error(`${sourceName} visual target is missing: ${selector}`)
      target.setAttribute('data-visual-role', 'root')
      const host = document.createElement('main')
      host.id = 'visual-compare-frame'
      host.style.width = `${dimensions.width}px`
      host.style.height = `${dimensions.height}px`
      host.append(target)
      document.body.replaceChildren(host)
      document.documentElement.dataset.theme = 'light'
    },
    { dimensions: frame, selector: targetSelector, sourceName: source },
  )
  await page.addStyleTag({ content: stableStyles })
  await page.evaluate(() => document.fonts.ready)
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  )
}

async function prepareReference(page, state) {
  await page.goto(REFERENCE_URL, { waitUntil: 'domcontentloaded' })
  if (state.surface === 'settings') {
    await page.evaluate(() => window.showPane('settings', '设置'))
    await page.evaluate(() => {
      const row = document.querySelector('[data-default-reasoning-row]')
      const label = row?.querySelector('.lbl')
      const control = row?.querySelector('[data-default-reasoning-policy]')
      label?.setAttribute('data-visual-role', 'label')
      control?.setAttribute('data-visual-role', 'control')
    })
    await createFrame(page, state.frame, '[data-default-reasoning-row]', 'reference')
    await page.evaluate(() => {
      const frame = document.querySelector('#visual-compare-frame')
      frame?.classList.add('screen', 'on')
      if (frame) frame.dataset.pane = 'settings'
    })
    return
  }

  if (state.surface === 'agent-create' || state.surface === 'agent-edit') {
    if (state.surface === 'agent-create') {
      await page.evaluate(() => window.agentForm('blank'))
    } else {
      await page.evaluate(() =>
        window.editAgentForm('日报分析师', 'Fixture Provider', 'gpt-5.6-terra'),
      )
    }
    await page.evaluate(() => {
      const fold = document.querySelector('#overlayCard .agfold')
      if (!fold) throw new Error('prototype Agent advanced fold is missing')
      fold.open = true
      fold.querySelector('summary')?.setAttribute('data-visual-role', 'summary')
      fold.querySelector('.agfold-label')?.setAttribute('data-visual-role', 'summaryLabel')
      fold.querySelector('.agfold-sum')?.setAttribute('data-visual-role', 'summaryValue')
      fold.querySelector('.inline-form')?.setAttribute('data-visual-role', 'model')
      fold.querySelector('.ag-provider-select')?.setAttribute('data-visual-role', 'source')
      fold.querySelector('#agModelBox')?.setAttribute('data-visual-role', 'reasoning')
      fold.querySelector('#agReasoningPolicy')?.setAttribute('data-visual-role', 'control')
      const reasoningField = fold.querySelector('#agReasoningPolicy')?.closest('.mfield')
      reasoningField?.querySelector('label')?.setAttribute('data-visual-role', 'label')
      reasoningField
        ?.querySelector('.reasoning-policy-note')
        ?.setAttribute('data-visual-role', 'note')
    })
    if (state.surface === 'agent-edit') {
      await page.locator('#agReasoningPolicy').click()
      await page.locator('.menu button').filter({ hasText: /^高$/ }).click()
    }
    await createFrame(page, state.frame, '#overlayCard .agfold', 'reference')
    return
  }

  await page.evaluate((capability) => {
    const stacks = [...document.querySelectorAll('[data-channel-derived]')]
    let stack
    if (capability === 'supported')
      stack = stacks.find((item) => !item.querySelector('[data-channel-derived-reasoning]')?.hidden)
    else
      stack = stacks.find(
        (item) =>
          item.querySelector('[data-channel-derived-reasoning]')?.dataset.reasoningSupport ===
          'unsupported',
      )
    if (!stack) throw new Error(`prototype Channel derived stack is missing: ${capability}`)
    const model = stack.querySelector('[data-channel-derived-model-id]')
    const reasoning = stack.querySelector('[data-channel-derived-reasoning]')
    const source = stack.querySelector('[data-channel-derived-source]')
    stack.querySelector('.cxderive__label')?.setAttribute('data-visual-role', 'label')
    if (capability === 'unknown' && reasoning) {
      reasoning.dataset.reasoningSupport = 'unknown'
      reasoning.dataset.reasoningPolicy = ''
      reasoning.textContent = ''
      reasoning.hidden = true
      if (model) model.textContent = 'pending-model'
      if (source) source.textContent = '来源：Agent 待检测智能体'
    }
    model?.setAttribute('data-visual-role', 'model')
    reasoning?.setAttribute('data-visual-role', 'reasoning')
    source?.setAttribute('data-visual-role', 'source')
  }, state.capability)
  const selector =
    state.capability === 'supported'
      ? '[data-channel-derived]:has([data-channel-derived-reasoning]:not([hidden]))'
      : `[data-channel-derived]:has([data-channel-derived-reasoning][data-reasoning-support="${state.capability}"])`
  await createFrame(page, state.frame, selector, 'reference')
}

async function prepareImplementation(page, state) {
  if (state.surface === 'settings') {
    await page.goto(new URL('/settings', IMPLEMENTATION_URL).toString(), {
      waitUntil: 'domcontentloaded',
    })
    await waitForImplementation(page)
    const control = page.getByTestId('llm-default-reasoning-policy')
    await control.waitFor({ state: 'visible', timeout: 10_000 })
    await page.evaluate(() => {
      const control = document.querySelector('[data-testid="llm-default-reasoning-policy"]')
      const row = control?.closest('.hc-settings__row')
      row?.setAttribute('data-visual-settings-row', '')
      row?.querySelector('.hc-settings__row-label')?.setAttribute('data-visual-role', 'label')
      control?.querySelector('.hc-select__trigger')?.setAttribute('data-visual-role', 'control')
    })
    await createFrame(page, state.frame, '[data-visual-settings-row]', 'implementation')
    return
  }

  if (state.surface === 'agent-create') {
    await page.goto(new URL('/agents?create=1', IMPLEMENTATION_URL).toString(), {
      waitUntil: 'domcontentloaded',
    })
    await waitForImplementation(page)
    await page.getByTestId('start-blank').click()
    await page.getByTestId('agent-add-adv-toggle').click()
    await page.evaluate(() => {
      const toggle = document.querySelector('[data-testid="agent-add-adv-toggle"]')
      const shell = toggle?.closest('[data-testid="agent-add-model-fold"]')
      if (!toggle || !shell) throw new Error('implementation Agent create advanced area is missing')
      shell.classList.add('visual-current-agent-shell')
      shell.setAttribute('data-visual-role', 'root')
      toggle.setAttribute('data-visual-role', 'summary')
      toggle
        .querySelector('.hc-agent-fold__summary-label')
        ?.setAttribute('data-visual-role', 'summaryLabel')
      toggle
        .querySelector('.hc-agent-fold__summary-value')
        ?.setAttribute('data-visual-role', 'summaryValue')
      shell
        .querySelector('[data-testid="agent-add-model-grid"]')
        ?.setAttribute('data-visual-role', 'model')
      shell
        .querySelector('[data-testid="agent-add-model-grid"] .hc-select__trigger')
        ?.setAttribute('data-visual-role', 'source')
      shell
        .querySelector('[data-testid="agent-add-model-follow"]')
        ?.setAttribute('data-visual-role', 'reasoning')
      const control = shell.querySelector('[data-testid="agent-add-reasoning-policy"]')
      control?.querySelector('.hc-select__trigger')?.setAttribute('data-visual-role', 'control')
      const field = control?.parentElement
      field?.querySelector('label')?.setAttribute('data-visual-role', 'label')
      field?.querySelector(':scope > span')?.setAttribute('data-visual-role', 'note')
    })
    await createFrame(page, state.frame, '.visual-current-agent-shell', 'implementation')
    return
  }

  if (state.surface === 'agent-edit') {
    await page.goto(new URL('/agents?edit=reporter', IMPLEMENTATION_URL).toString(), {
      waitUntil: 'domcontentloaded',
    })
    await waitForImplementation(page)
    await page.getByTestId('agent-adv-toggle').waitFor({ state: 'visible', timeout: 10_000 })
    await page.getByTestId('agent-adv-toggle').click()
    await page.evaluate(() => {
      const toggle = document.querySelector('[data-testid="agent-adv-toggle"]')
      const shell = toggle?.parentElement
      if (!toggle || !shell) throw new Error('implementation Agent edit advanced area is missing')
      shell.classList.add('visual-current-agent-shell')
      shell.setAttribute('data-visual-role', 'root')
      toggle.setAttribute('data-visual-role', 'summary')
      toggle
        .querySelector('.hc-agent-fold__summary-label')
        ?.setAttribute('data-visual-role', 'summaryLabel')
      toggle
        .querySelector('.hc-agent-fold__summary-value')
        ?.setAttribute('data-visual-role', 'summaryValue')
      shell
        .querySelector('[data-testid="agent-edit-model-grid"]')
        ?.setAttribute('data-visual-role', 'model')
      shell
        .querySelector('[data-testid="agent-edit-model-grid"] .hc-select__trigger')
        ?.setAttribute('data-visual-role', 'source')
      shell
        .querySelector('[data-testid="agent-edit-model-follow"]')
        ?.setAttribute('data-visual-role', 'reasoning')
      const control = shell.querySelector('[data-testid="agent-edit-reasoning-policy"]')
      control?.querySelector('.hc-select__trigger')?.setAttribute('data-visual-role', 'control')
      const field = control?.parentElement
      field?.querySelector('label')?.setAttribute('data-visual-role', 'label')
      field?.querySelector(':scope > span')?.setAttribute('data-visual-role', 'note')
    })
    await createFrame(page, state.frame, '.visual-current-agent-shell', 'implementation')
    return
  }

  await page.goto(new URL('/channels', IMPLEMENTATION_URL).toString(), {
    waitUntil: 'domcontentloaded',
  })
  await waitForImplementation(page)
  await page.locator('.hc-cab__effmodel').waitFor({ state: 'visible', timeout: 10_000 })
  await page.evaluate(() => {
    const root = document.querySelector('.hc-cab__effmodel')
    root?.querySelector('.hc-cab__effmodel-label')?.setAttribute('data-visual-role', 'label')
    root?.querySelector('.hc-cab__effmodel-badge')?.setAttribute('data-visual-role', 'model')
    root
      ?.querySelector('.hc-cab__effmodel-reasoning')
      ?.setAttribute('data-visual-role', 'reasoning')
    root?.querySelector('.hc-cab__effmodel-source')?.setAttribute('data-visual-role', 'source')
  })
  await createFrame(page, state.frame, '.hc-cab__effmodel', 'implementation')
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
        visibility: computed.visibility,
        opacity: computed.opacity,
        color: computed.color,
        backgroundColor: computed.backgroundColor,
        border: computed.border,
        borderRadius: computed.borderRadius,
        boxShadow: computed.boxShadow,
        fontFamily: computed.fontFamily,
        fontSize: computed.fontSize,
        fontWeight: computed.fontWeight,
        lineHeight: computed.lineHeight,
        margin: computed.margin,
        padding: computed.padding,
        gap: computed.gap,
      }
    }
    const nodes = {}
    for (const role of [
      'root',
      'summary',
      'summaryLabel',
      'summaryValue',
      'label',
      'control',
      'model',
      'reasoning',
      'source',
      'note',
    ]) {
      const elements = [...document.querySelectorAll(`[data-visual-role="${role}"]`)]
      nodes[role] = elements.map((element) => ({
        rect: rect(element),
        style: style(element),
        text: (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim(),
        hidden:
          element.hidden ||
          getComputedStyle(element).display === 'none' ||
          getComputedStyle(element).visibility === 'hidden',
        disabled: 'disabled' in element ? Boolean(element.disabled) : null,
        ariaDisabled: element.getAttribute('aria-disabled'),
        ariaExpanded: element.getAttribute('aria-expanded'),
        reasoningSupport: element.getAttribute('data-reasoning-support'),
        reasoningPolicy: element.getAttribute('data-reasoning-policy'),
      }))
    }
    return {
      source: sourceName,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
        language: document.documentElement.lang,
        theme: document.documentElement.dataset.theme,
      },
      frame: {
        rect: rect(document.querySelector('#visual-compare-frame')),
        style: style(document.querySelector('#visual-compare-frame')),
      },
      nodes,
    }
  }, source)
}

function semanticDifferences(reference, implementation, state) {
  const differences = []
  const one = (snapshot, role) => snapshot.nodes[role]?.[0]
  if (reference.viewport.devicePixelRatio !== DEVICE_SCALE_FACTOR) {
    differences.push('reference.viewport.devicePixelRatio')
  }
  if (implementation.viewport.devicePixelRatio !== DEVICE_SCALE_FACTOR) {
    differences.push('implementation.viewport.devicePixelRatio')
  }
  if (one(reference, 'label')?.text !== one(implementation, 'label')?.text) {
    differences.push('label.text')
  }
  if (state.surface === 'settings') {
    if (!one(reference, 'control')?.text.includes('自动（推荐）'))
      differences.push('reference.control.auto')
    if (!one(implementation, 'control')?.text.includes('自动（推荐）'))
      differences.push('implementation.control.auto')
  }
  if (state.surface.startsWith('agent-')) {
    if (!one(reference, 'control')?.text.includes(state.expectedPolicyText))
      differences.push('reference.control.policy')
    if (!one(implementation, 'control')?.text.includes(state.expectedPolicyText))
      differences.push('implementation.control.policy')
    if (one(reference, 'note')?.text !== one(implementation, 'note')?.text)
      differences.push('note.text')
  }
  if (state.surface === 'channel') {
    const referenceReasoning = reference.nodes.reasoning.filter((item) => !item.hidden)
    const implementationReasoning = implementation.nodes.reasoning.filter((item) => !item.hidden)
    if (state.capability === 'supported') {
      if (referenceReasoning.length !== 1 || referenceReasoning[0]?.text !== '思考 · 高') {
        differences.push('reference.reasoning.supported')
      }
      if (
        implementationReasoning.length !== 1 ||
        implementationReasoning[0]?.text !== '思考 · 高'
      ) {
        differences.push('implementation.reasoning.supported')
      }
    } else {
      if (referenceReasoning.length !== 0) differences.push('reference.reasoning.mustHide')
      if (implementationReasoning.length !== 0)
        differences.push('implementation.reasoning.mustHide')
    }
    if (one(reference, 'source')?.text !== one(implementation, 'source')?.text) {
      differences.push('source.text')
    }
  }
  return differences
}

async function createPixelDiff(page, referencePath, implementationPath, diffPath) {
  const [reference, implementation] = await Promise.all([
    readFile(referencePath, 'base64'),
    readFile(implementationPath, 'base64'),
  ])
  const result = await page.evaluate(
    async ({ referencePng, implementationPng, threshold }) => {
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
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d')
      context.drawImage(referenceImage, 0, 0)
      const referencePixels = context.getImageData(0, 0, width, height).data
      context.clearRect(0, 0, width, height)
      context.drawImage(implementationImage, 0, 0)
      const implementationPixels = context.getImageData(0, 0, width, height).data
      const output = context.createImageData(width, height)
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
      context.putImageData(output, 0, 0)
      return {
        png: canvas.toDataURL('image/png').split(',')[1],
        width,
        height,
        threshold,
        changedPixels,
        totalPixels: width * height,
        changedPixelRatio: changedPixels / (width * height),
        changedBoundingBox: changedPixels > 0 ? [minX, minY, maxX + 1, maxY + 1] : null,
      }
    },
    { referencePng: reference, implementationPng: implementation, threshold: PIXEL_THRESHOLD },
  )
  await writeFile(diffPath, Buffer.from(result.png, 'base64'))
  const { png: _png, ...metrics } = result
  return metrics
}

async function main() {
  await mkdir(EVIDENCE_ROOT, { recursive: true })
  const browser = await chromium.launch({ headless: true })
  const diffPage = await browser.newPage({
    viewport: VIEWPORT,
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
  })
  const reports = []
  try {
    for (const state of states) {
      const outputDir = path.join(EVIDENCE_ROOT, state.id)
      await mkdir(outputDir, { recursive: true })
      const contextOptions = {
        viewport: VIEWPORT,
        deviceScaleFactor: DEVICE_SCALE_FACTOR,
        locale: 'zh-CN',
        timezoneId: 'Asia/Shanghai',
        colorScheme: 'light',
        reducedMotion: 'reduce',
      }
      const [referenceContext, implementationContext] = await Promise.all([
        browser.newContext(contextOptions),
        browser.newContext(contextOptions),
      ])
      const referencePage = await referenceContext.newPage()
      const implementationPage = await implementationContext.newPage()
      const externalAttempts = { reference: [], implementation: [] }
      let report
      try {
        await installReferenceNetworkGuard(referencePage, externalAttempts.reference)
        await installImplementationFixture(
          implementationPage,
          state,
          externalAttempts.implementation,
        )
        await prepareReference(referencePage, state)
        await prepareImplementation(implementationPage, state)
        const [referenceEvidence, implementationEvidence] = await Promise.all([
          snapshot(referencePage, 'reference'),
          snapshot(implementationPage, 'implementation'),
        ])
        const referencePath = path.join(outputDir, 'reference.png')
        const implementationPath = path.join(outputDir, 'current.png')
        const diffPath = path.join(outputDir, 'pixel-diff.png')
        await Promise.all([
          referencePage.locator('#visual-compare-frame').screenshot({ path: referencePath }),
          implementationPage.locator('#visual-compare-frame').screenshot({
            path: implementationPath,
          }),
        ])
        const pixels = await createPixelDiff(diffPage, referencePath, implementationPath, diffPath)
        const semantic = semanticDifferences(referenceEvidence, implementationEvidence, state)
        const networkClean =
          externalAttempts.reference.length === 0 && externalAttempts.implementation.length === 0
        const status =
          semantic.length === 0 &&
          networkClean &&
          pixels.changedPixelRatio <= MAX_CHANGED_PIXEL_RATIO
            ? 'PASS'
            : 'RED'
        const bboxPath = path.join(outputDir, 'bbox-computed-style.json')
        await writeFile(
          bboxPath,
          `${JSON.stringify({ reference: referenceEvidence, implementation: implementationEvidence }, null, 2)}\n`,
        )
        report = {
          state,
          status,
          semanticDifferences: semantic,
          externalNetworkAttempts: externalAttempts,
          pixels: { ...pixels, maxChangedPixelRatio: MAX_CHANGED_PIXEL_RATIO },
          files: {
            reference: 'reference.png',
            current: 'current.png',
            pixelDiff: 'pixel-diff.png',
            bboxComputedStyle: 'bbox-computed-style.json',
          },
        }
      } catch (error) {
        report = {
          state,
          status: 'BLOCKED',
          error: error instanceof Error ? (error.stack ?? error.message) : String(error),
          externalNetworkAttempts: externalAttempts,
        }
      } finally {
        await Promise.all([referenceContext.close(), implementationContext.close()])
      }
      await writeFile(
        path.join(outputDir, 'comparison-report.json'),
        `${JSON.stringify(report, null, 2)}\n`,
      )
      reports.push(report)
    }
  } finally {
    await browser.close()
  }
  const summary = {
    generatedAt: new Date().toISOString(),
    contract: {
      viewport: VIEWPORT,
      deviceScaleFactor: DEVICE_SCALE_FACTOR,
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      colorScheme: 'light',
      reducedMotion: 'reduce',
      pixelThreshold: PIXEL_THRESHOLD,
      maxChangedPixelRatio: MAX_CHANGED_PIXEL_RATIO,
      externalNetworkAllowed: false,
    },
    status: reports.every((item) => item.status === 'PASS') ? 'PASS' : 'RED',
    reports,
  }
  await writeFile(path.join(EVIDENCE_ROOT, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  if (summary.status !== 'PASS') process.exitCode = 1
}

await main()
