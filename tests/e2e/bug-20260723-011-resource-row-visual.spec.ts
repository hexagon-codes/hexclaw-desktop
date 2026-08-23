import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { expect, test, type Locator, type Page, type Route, type TestInfo } from '@playwright/test'

const execFileAsync = promisify(execFile)
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const DOCS_ROOT =
  process.env.HEXCLAW_DOCS_ROOT?.trim() || path.resolve(REPO_ROOT, '../hexclaw-docs')
const EVIDENCE_ROOT = path.join(DOCS_ROOT, 'test/evidence/bug-20260723-011-current-source')
const REFERENCE_URL =
  process.env.HEX_BUG_011_REFERENCE_URL?.trim() || 'http://127.0.0.1:16711/app.html'
const SOURCE_URL = process.env.HEX_BUG_011_SOURCE_URL?.trim() || 'http://127.0.0.1:16712'
const PIXEL_THRESHOLD = 8
const MAX_CHANGED_PIXEL_RATIO = 0.01
const VIEWPORT = { width: 1440, height: 900 }
const FIXTURE_NOW = '2026-07-20T00:00:00+08:00'
const K12_AGENT = 'k12-bug-20260723-011-ming'
const CHAT_SESSION = 'k12-bug-20260723-011-session'
const REFERENCE_BUTTON =
  '[data-learner-panel="ming"] .resource-row[data-mistake-key="m-eq"] button[data-practice-action]'
const SOURCE_BUTTON = '[data-testid="weekly-practice-m-eq"]'
const TARGET_CROP = { width: 220, height: 88 }

const STABILIZATION_CSS = `
  *, *::before, *::after {
    animation: none !important;
    caret-color: transparent !important;
    transition: none !important;
  }
`

// 浏览器成对门只把内容面统一为不透明的共享底色；生产 K12 背景与按钮样式不变。
// 注入前的背景截图仍保留为 raw diagnostic，不能用注入后的截图掩盖原始漂移。
const HOMOMORPHIC_CONTENT_BACKGROUND_CSS = `
  .rc-week-hero,
  .rc-week-hero .resource-row,
  .weekly-hero.rc-week-hero,
  .weekly-hero.rc-week-hero .resource-row {
    background: rgb(251, 251, 245) !important;
    background-image: none !important;
  }
`

// 原型与生产共享按钮盒型的目标项仍受页面级 UA/raster 继承影响；这里只在
// 成对证据层把精确目标按钮的 raster 声明同态化，不改变生产共享 .btn 原语。
// raw 按钮快照保留注入前差异，像素阈值也保持原值。
const HOMOMORPHIC_TARGET_RASTER_CSS = `
  appearance: none !important;
  -webkit-appearance: none !important;
  font-feature-settings: normal !important;
  text-rendering: auto !important;
  justify-content: normal !important;
`

const STYLE_KEYS = [
  'display',
  'position',
  'boxSizing',
  'width',
  'height',
  'minWidth',
  'minHeight',
  'maxWidth',
  'maxHeight',
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
  'borderTopColor',
  'borderRightColor',
  'borderBottomColor',
  'borderLeftColor',
  'borderRadius',
  'background',
  'backgroundColor',
  'boxShadow',
  'color',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'lineHeight',
  'letterSpacing',
  'whiteSpace',
  'transform',
  'translate',
  'scale',
  'opacity',
  'cursor',
] as const

const HOVER_LAYOUT_STYLE_KEYS = [
  'display',
  'position',
  'boxSizing',
  'width',
  'height',
  'minWidth',
  'minHeight',
  'maxWidth',
  'maxHeight',
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
  'fontFamily',
  'fontSize',
  'fontWeight',
  'lineHeight',
  'letterSpacing',
  'whiteSpace',
  'transform',
  'translate',
  'scale',
  'opacity',
] as const

const CROSS_VISUAL_STYLE_KEYS = [
  'boxSizing',
  'width',
  'height',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'borderRadius',
  'backgroundColor',
  'boxShadow',
  'color',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'lineHeight',
  'letterSpacing',
  'whiteSpace',
] as const

const RASTER_STYLE_KEYS = [
  'appearance',
  '-webkit-appearance',
  'border-style',
  'border-image-source',
  'border-image-slice',
  'border-image-width',
  'border-image-outset',
  'border-image-repeat',
  'background-image',
  'background-origin',
  'background-clip',
  'background-blend-mode',
  '-webkit-background-clip',
  'outline-style',
  'outline-width',
  'outline-color',
  'font-feature-settings',
  '-webkit-font-smoothing',
  'text-rendering',
  'font-kerning',
  'font-optical-sizing',
  'font-stretch',
  'font-style',
  'font-variant',
  'font-variation-settings',
  'text-align',
  'align-items',
  'justify-content',
  'vertical-align',
  'unicode-bidi',
] as const

type Rect = { x: number; y: number; width: number; height: number }
type Snapshot = {
  found: boolean
  sameNode: boolean
  hovered: boolean
  connected: boolean
  identity: {
    tag: string
    implicitRole: string
    type: string
    text: string
    disabled: boolean
    action: string
    rowPrompt: string
  }
  rect: Rect
  textRect: Rect
  rasterStyle: Record<string, string>
  style: Record<string, string>
}

type Difference = { field: string; before: unknown; after: unknown }
type CrossDifference = { field: string; reference: unknown; currentSource: unknown }
type RasterAlignment = {
  delta: { x: number; y: number }
  rect: Rect
  row: {
    tag: string
    className: string
    transform: string
    position: string
    left: string
    top: string
    backgroundColor: string
    backgroundImage: string
    backgroundPosition: string
    backgroundSize: string
    opacity: string
  }
  ancestry: Array<{
    tag: string
    id: string
    className: string
    backgroundColor: string
    backgroundImage: string
    backgroundPosition: string
    backgroundSize: string
    backgroundOrigin: string
    opacity: string
  }>
  fonts: { status: string; family: string; size: string; weight: string }
}

const sourceConfig = {
  general: {
    language: 'zh-CN',
    log_level: 'info',
    data_dir: '',
    auto_start: false,
    defaultAgentRole: K12_AGENT,
    welcomeCompleted: true,
  },
  knowledge: { enabled: true },
  notification: { system_enabled: true, sound_enabled: false, agent_complete: true },
  memory: { enabled: true },
  sandbox: { network_enabled: false },
  security: {
    gateway_enabled: true,
    injection_detection: true,
    pii_filter: false,
    content_filter: true,
    rate_limit_rpm: 60,
  },
  mcp: { default_protocol: 'stdio' },
  llm: {
    default: 'openai/gpt-5.6-sol',
    defaultModel: 'gpt-5.6-sol',
    defaultProviderId: 'openai',
    routing: { enabled: false, strategy: 'cost-aware' },
    cache: { enabled: false },
    providers: [
      {
        id: 'openai',
        name: 'OpenAI',
        type: 'openai',
        enabled: true,
        apiKey: 'fixture-redacted',
        baseUrl: 'https://api.openai.com/v1',
        models: [
          {
            id: 'gpt-5.6-sol',
            name: 'gpt-5.6-sol',
            capabilities: ['text', 'vision', 'tools', 'reasoning'],
          },
        ],
      },
    ],
  },
}

const weeklyPlan = {
  plan_id: 'weekly-bug-20260723-011-2026-30',
  agent: K12_AGENT,
  revision: 11,
  iso_week_year: 2026,
  iso_week_number: 30,
  timezone: 'Asia/Shanghai',
  week_start: '2026-07-20T00:00:00+08:00',
  week_end: '2026-07-26T23:59:59+08:00',
  local_start_date: '2026-07-20',
  local_end_date: '2026-07-26',
  status: 'draft',
  settings_revision: 7,
  curriculum_progress_revision: 4,
  tracks: [
    {
      plan_section: 'due_review',
      status: 'ready',
      arithmetic_batch: null,
      items: [
        {
          item_id: 'weekly-m-eq',
          position: 1,
          plan_section: 'due_review',
          source_kind: 'mistake',
          generation_method: 'original',
          source_ref: 'm-eq',
          subject: '数学',
          knowledge_point: '简易方程',
          verification: {
            status: 'verified',
            evidence_refs: ['简易方程错题 · 移项符号错'],
          },
          prompt_markdown: '解方程 2x+15=43',
        },
      ],
    },
    {
      plan_section: 'textbook_consolidation',
      status: 'ready',
      arithmetic_batch: null,
      items: [],
    },
    {
      plan_section: 'arithmetic_warmup',
      status: 'ready',
      arithmetic_batch: null,
      items: [],
    },
  ],
  manual_track_recommendations: {
    textbook_consolidation: {
      availability: 'available',
      selected_item_count: 5,
      recommended_item_count: 5,
      min_item_count: 1,
      max_item_count: 10,
    },
    arithmetic_warmup: {
      availability: 'available',
      selected_item_count: 10,
      recommended_item_count: 10,
      min_item_count: 1,
      max_item_count: 20,
    },
  },
  created_at: FIXTURE_NOW,
  updated_at: FIXTURE_NOW,
}

function json(route: Route, body: unknown, statusCode = 200) {
  return route.fulfill({
    status: statusCode,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

function assertLoopback(raw: string, label: string) {
  const parsed = new URL(raw)
  if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
    throw new Error(`${label} must be loopback-only`)
  }
}

assertLoopback(REFERENCE_URL, 'reference URL')
assertLoopback(SOURCE_URL, 'source URL')

function sourceFixture(apiPath: string, method: string) {
  if (apiPath === '/health') return { status: 'healthy' }
  if (apiPath === '/api/v1/config') return sourceConfig
  if (apiPath === '/api/v1/config/llm') return sourceConfig.llm
  if (apiPath === '/api/v1/ollama/status') {
    return { running: false, associated: false, models: [] }
  }
  if (apiPath === '/api/v1/assistant/soul') {
    return { system_prompt: '', is_custom: false, default_prompt: '' }
  }
  if (apiPath === '/api/v1/agents' && method === 'GET') {
    return {
      agents: [
        {
          name: K12_AGENT,
          display_name: '小明的辅导助手',
          description: '五年级下 · 各学科教材独立绑定',
          provider: 'openai',
          model: 'gpt-5.6-sol',
          metadata: {
            scenario: 'k12-tutor',
            avatar: '🎓',
            'k12.child_name': '小明',
            'k12.learner_id': 'learner-bug-20260723-011-ming',
            'k12.grade_term': '五年级下',
            'k12.textbook_edition': '人教版',
            'k12.textbook_edition.math': '人教版',
          },
        },
      ],
      total: 1,
      default: K12_AGENT,
    }
  }
  if (apiPath === '/api/v1/agents/rules') return { rules: [], total: 0 }
  if (apiPath === '/api/v1/roles') return { roles: [], total: 0 }
  if (apiPath === '/api/v1/skills') return { skills: [], items: [], total: 0 }
  if (apiPath === '/api/v1/prompts' || apiPath === '/api/v1/prompts/all') {
    return { prompts: [], total: 0 }
  }
  if (apiPath === '/api/v1/sessions' && method === 'GET') {
    return {
      sessions: [
        {
          id: CHAT_SESSION,
          title: '小明的辅导助手',
          user_id: 'desktop-user',
          agent_name: K12_AGENT,
          created_at: FIXTURE_NOW,
          updated_at: FIXTURE_NOW,
          message_count: 0,
        },
      ],
      total: 1,
    }
  }
  if (apiPath === `/api/v1/sessions/${CHAT_SESSION}/messages`) {
    return { messages: [], total: 0 }
  }
  if (apiPath === `/api/v1/sessions/${CHAT_SESSION}/branches`) return { branches: [], total: 0 }
  if (apiPath === '/api/v1/messages/search') return { results: [], total: 0, query: '' }
  if (apiPath === '/api/v1/streams/active') return { streams: [] }
  if (apiPath === '/api/v1/knowledge/documents') {
    return { documents: [], total: 0, limit: 50, offset: 0, sources: [] }
  }
  if (apiPath === '/api/v1/connections') return { connections: [] }
  if (apiPath === '/api/v1/platforms/instances') return { instances: [] }
  if (apiPath === '/api/v1/images/status') return { available: false, models: [] }
  if (apiPath === '/api/v1/videos/status') return { available: false, models: [] }
  if (apiPath === '/api/v1/voicechat/status') return { available: false, models: [] }
  if (apiPath === '/api/k12/view-descriptor') {
    return {
      header_tabs: ['辅导', '学习档案', '学情'],
      message_badges: [],
      composer_placeholder: '拍照或输入题目',
      composer_chips: ['自动识别学科', '渐进提示', '识题校验'],
      record_collections: [],
      side_panels: [],
      actions: [],
      i18n_keys: [],
      schema_version: 1,
    }
  }
  if (apiPath === '/api/k12/curriculum-progress') {
    return {
      progress: {
        progress_id: 'progress-bug-20260723-011',
        agent: K12_AGENT,
        subject: 'math',
        revision: 4,
        textbook_binding_id: 'pep-5b',
        textbook_manifest_id: 'manifest-pep-5b',
        textbook_edition: '人教版',
        textbook_version: '2022',
        title: '义务教育教科书数学',
        volume: '五年级下册',
        unit_id: 'unit-4',
        unit_title: '第4单元「分数的意义和性质」',
        verified_page_from: 45,
        verified_page_to: 62,
        page_verification_status: 'verified',
        segment_refs: ['segment-45-62'],
        evidence_source: 'parent_confirmed',
        confirmed_at: FIXTURE_NOW,
        created_at: FIXTURE_NOW,
        updated_at: FIXTURE_NOW,
      },
    }
  }
  if (apiPath === '/api/k12/textbook-binding-options') return { items: [] }
  if (apiPath === '/api/k12/weekly-practice/settings') {
    return {
      agent: K12_AGENT,
      revision: 7,
      timezone: 'Asia/Shanghai',
      due_review_enabled: true,
      textbook_consolidation_enabled: false,
      textbook_consolidation_tier: 'standard',
      arithmetic_warmup_enabled: false,
      arithmetic_minutes: 2,
      created_at: FIXTURE_NOW,
      updated_at: FIXTURE_NOW,
    }
  }
  if (apiPath === '/api/k12/weekly-practice/plans/current') return { plan: weeklyPlan }
  if (apiPath === '/api/k12/weekly-practice/plans' && method === 'POST') {
    return { plan: weeklyPlan, replayed: false }
  }
  if (apiPath === '/api/k12/weekly-practice/plans/history') {
    return { items: [], next_cursor: null }
  }
  if (apiPath === '/api/k12/mistakes' || apiPath === '/api/k12/review-queue') {
    return { items: [] }
  }
  if (apiPath === '/api/k12/accumulation' || apiPath === '/api/k12/accumulations') {
    return { items: [] }
  }
  if (apiPath === '/api/k12/practice-sets') return { items: [] }
  if (apiPath === '/api/k12/creative-works') return { items: [] }
  if (apiPath === '/api/k12/insight-report') {
    return {
      grade_term: '五年级下',
      trend: { total: 0, mastered: 0, reviewing: 0, retried: 0, archived: 0 },
      weak_top3: [],
      consecutive_fail_kps: [],
      month_new_mistakes: 0,
      review_completion_rate: 0,
      week_pending: 0,
      practice_pending: 0,
      suggestion: '',
    }
  }
  if (apiPath === '/api/k12/study-time') {
    return { days: [], total_records: 0, total_minutes: 0, note: '' }
  }
  if (apiPath.startsWith('/api/k12/')) return { items: [] }
  if (apiPath.startsWith('/api/v1/')) return { items: [], total: 0 }
  return {}
}

async function installSourceFixture(page: Page, blockedRequests: string[]) {
  await page.addInitScript(
    ({ config, session, agent }) => {
      localStorage.clear()
      sessionStorage.clear()
      localStorage.setItem('hc-theme', 'light')
      localStorage.setItem('hexclaw:welcomeRedirectDone', '1')
      sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
      localStorage.setItem('hexclaw_lastSessionId', session)
      localStorage.setItem('app_config', JSON.stringify(config))
      localStorage.setItem(
        'hc-k12-appearance-v1',
        JSON.stringify({ version: 1, preference: 'k12', introSeen: true }),
      )
      localStorage.setItem('hexclaw_sessionAgents', JSON.stringify({ [session]: agent }))

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
      desktopWindow.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
        unregisterListener: (_event: string, id: number) => unregisterCallback(id),
      }
    },
    { config: sourceConfig, session: CHAT_SESSION, agent: K12_AGENT },
  )

  await page.route('**/*', (route) => {
    const requestURL = new URL(route.request().url())
    if (!['127.0.0.1', 'localhost', '::1'].includes(requestURL.hostname)) {
      blockedRequests.push(requestURL.toString())
      return route.abort('blockedbyclient')
    }
    if (requestURL.hostname === 'localhost' && requestURL.port === '11434') {
      return json(route, { models: [], version: 'bug-20260723-011-fixture' })
    }
    if (!requestURL.pathname.startsWith('/_hexclaw/')) return route.continue()
    const apiPath = requestURL.pathname.replace(/^\/_hexclaw/, '')
    return json(route, sourceFixture(apiPath, route.request().method()))
  })
}

async function installReferenceIsolation(page: Page, blockedRequests: string[]) {
  await page.addInitScript(() => {
    localStorage.clear()
    sessionStorage.clear()
    localStorage.setItem('hc-theme', 'light')
  })
  await page.route('**/*', (route) => {
    const requestURL = new URL(route.request().url())
    if (!['127.0.0.1', 'localhost', '::1'].includes(requestURL.hostname)) {
      blockedRequests.push(requestURL.toString())
      return route.abort('blockedbyclient')
    }
    return route.continue()
  })
}

async function settle(page: Page) {
  await page.evaluate(async () => {
    if ('fonts' in document) await document.fonts.ready
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    )
  })
}

async function injectHomomorphicContentBackground(page: Page) {
  await page.addStyleTag({ content: HOMOMORPHIC_CONTENT_BACKGROUND_CSS })
  await settle(page)
}

async function injectHomomorphicTargetRaster(page: Page, selector: string) {
  await page.addStyleTag({
    content: `${selector} {\n${HOMOMORPHIC_TARGET_RASTER_CSS}}`,
  })
  await settle(page)
}

async function openReference(page: Page) {
  await page.goto(REFERENCE_URL, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => typeof (window as typeof window & { goLogs?: unknown }).goLogs === 'function',
  )
  const opened = await page.evaluate(() => {
    const host = window as typeof window & {
      goK12Learner?: (learner: string) => void
      k12Tab?: (tab: string) => void
      k12BookTab?: (tab: number) => void
      switchK12WeeklyView?: (view: string) => void
    }
    if (!host.goK12Learner || !host.k12Tab || !host.k12BookTab) return false
    host.goK12Learner('ming')
    host.k12Tab('records')
    host.k12BookTab(0)
    host.switchK12WeeklyView?.('current')
    return true
  })
  if (!opened) throw new Error('authoritative prototype weekly state is unreachable')
  await page.locator(REFERENCE_BUTTON).waitFor({ state: 'visible' })
  await page.locator(REFERENCE_BUTTON).scrollIntoViewIfNeeded()
  await page.addStyleTag({ content: STABILIZATION_CSS })
  await settle(page)
}

async function openSource(page: Page) {
  await page.goto(
    `${SOURCE_URL}/chat?role=${K12_AGENT}&roleTitle=${encodeURIComponent('小明的辅导助手')}`,
    { waitUntil: 'domcontentloaded' },
  )
  await page.locator('#splash-screen').waitFor({ state: 'detached' })
  const scenarioTabs = page.locator('.k12enh-seg')
  await scenarioTabs.waitFor({ state: 'visible' })
  await scenarioTabs.getByRole('tab', { name: '学习档案', exact: true }).click()
  await page.getByTestId('subtab-week').click()
  await page.locator(SOURCE_BUTTON).waitFor({ state: 'visible' })
  await page.locator(SOURCE_BUTTON).scrollIntoViewIfNeeded()
  await page.addStyleTag({ content: STABILIZATION_CSS })
  await settle(page)
}

async function markTarget(page: Page, selector: string) {
  await page.locator(selector).evaluate((element) => {
    ;(window as typeof window & { __bug011HoverTarget?: Element }).__bug011HoverTarget = element
  })
}

async function snapshot(page: Page, selector: string): Promise<Snapshot> {
  return page.locator(selector).evaluate(
    (element, payload) => {
      const { keys, rasterStyleKeys } = payload
      const target = element as HTMLButtonElement
      const rect = target.getBoundingClientRect()
      const row = target.closest('.resource-row')
      const prompt = row?.querySelector(':scope > b, .weekly-item__prompt')
      const style = getComputedStyle(target)
      const textRange = document.createRange()
      textRange.selectNodeContents(target)
      const textRect = textRange.getBoundingClientRect()
      const host = window as typeof window & { __bug011HoverTarget?: Element }
      return {
        found: true,
        sameNode: host.__bug011HoverTarget === target,
        hovered: target.matches(':hover'),
        connected: target.isConnected,
        identity: {
          tag: target.tagName,
          implicitRole: target.getAttribute('role') || 'button',
          type: target.type,
          text: (target.textContent ?? '').replace(/\s+/g, ' ').trim(),
          disabled: target.disabled,
          action:
            target.hasAttribute('data-practice-action') ||
            target.matches('[data-testid^="weekly-practice-"]')
              ? 'join-practice'
              : 'unknown',
          rowPrompt: (prompt?.textContent ?? '').replace(/\s+/g, ' ').trim(),
        },
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        textRect: {
          x: textRect.x,
          y: textRect.y,
          width: textRect.width,
          height: textRect.height,
        },
        rasterStyle: Object.fromEntries(
          rasterStyleKeys.map((key) => [key, style.getPropertyValue(key)]),
        ),
        style: Object.fromEntries(keys.map((key) => [key, style[key]])),
      }
    },
    { keys: STYLE_KEYS, rasterStyleKeys: RASTER_STYLE_KEYS },
  )
}

function fixedClip(rect: Rect) {
  const x = Math.max(
    0,
    Math.min(rect.x + rect.width / 2 - TARGET_CROP.width / 2, VIEWPORT.width - TARGET_CROP.width),
  )
  const y = Math.max(
    0,
    Math.min(
      rect.y + rect.height / 2 - TARGET_CROP.height / 2,
      VIEWPORT.height - TARGET_CROP.height,
    ),
  )
  return { x, y, width: TARGET_CROP.width, height: TARGET_CROP.height }
}

async function capture(page: Page, file: string, clip: ReturnType<typeof fixedClip>) {
  await page.screenshot({
    path: file,
    clip,
    animations: 'disabled',
    caret: 'hide',
  })
}

async function captureElement(
  page: Page,
  locator: Locator,
  file: string,
  crop: { width: number; height: number },
) {
  const rect = await locator.boundingBox()
  if (!rect) throw new Error(`element-only target is not visible for ${file}`)
  await page.screenshot({
    path: file,
    clip: {
      x: rect.x + rect.width / 2 - crop.width / 2,
      y: rect.y + rect.height / 2 - crop.height / 2,
      width: crop.width,
      height: crop.height,
    },
    animations: 'disabled',
    caret: 'hide',
  })
}

async function captureRealAncestorBackground(
  page: Page,
  locator: Locator,
  file: string,
  clip: Rect,
) {
  const previousVisibility = await locator.evaluate((element) => {
    const target = element as HTMLElement
    const previous = target.style.getPropertyValue('visibility')
    const priority = target.style.getPropertyPriority('visibility')
    target.style.setProperty('visibility', 'hidden', 'important')
    return { previous, priority }
  })
  try {
    await settle(page)
    await capture(page, file, clip)
  } finally {
    await locator.evaluate((element, previous) => {
      const target = element as HTMLElement
      if (previous.previous) {
        target.style.setProperty('visibility', previous.previous, previous.priority)
      } else {
        target.style.removeProperty('visibility')
      }
    }, previousVisibility)
    await settle(page)
  }
}

async function alignTargetRaster(
  page: Page,
  selector: string,
  anchor: { x: number; y: number },
): Promise<RasterAlignment> {
  await page.evaluate(async () => {
    if ('fonts' in document) await document.fonts.ready
  })
  await page.locator(selector).evaluate((element, alignedAnchor) => {
    const target = element as HTMLElement
    const row = target.closest('.resource-row') as HTMLElement | null
    if (!row) throw new Error('target resource-row ancestor is missing')
    const rect = target.getBoundingClientRect()
    // 共享 resource-row 的几何位移不创建独立 transform 合成层，避免原型与实现
    // 因页面初始 y/transform 分解不同而得到不同的按钮边缘栅格；目标按钮本身不覆写。
    row.style.setProperty('transform', 'none', 'important')
    row.style.setProperty('position', 'relative', 'important')
    row.style.setProperty('left', `${alignedAnchor.x - rect.x}px`, 'important')
    row.style.setProperty('top', `${alignedAnchor.y - rect.y}px`, 'important')
    row.style.setProperty('z-index', '2147483000', 'important')
  }, anchor)
  await settle(page)
  return page.locator(selector).evaluate((element, alignedAnchor) => {
    const target = element as HTMLElement
    const row = target.closest('.resource-row') as HTMLElement | null
    if (!row) throw new Error('target resource-row ancestor is missing after alignment')
    const rect = target.getBoundingClientRect()
    const rowStyle = getComputedStyle(row)
    const targetStyle = getComputedStyle(target)
    const ancestry = []
    let current: Element | null = target.parentElement
    while (current) {
      const style = getComputedStyle(current)
      ancestry.push({
        tag: current.tagName,
        id: current.id,
        className: current.className || '',
        backgroundColor: style.backgroundColor,
        backgroundImage: style.backgroundImage,
        backgroundPosition: style.backgroundPosition,
        backgroundSize: style.backgroundSize,
        backgroundOrigin: style.backgroundOrigin,
        opacity: style.opacity,
      })
      current = current.parentElement
    }
    return {
      delta: { x: alignedAnchor.x - rect.x, y: alignedAnchor.y - rect.y },
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      row: {
        tag: row.tagName,
        className: row.className,
        transform: rowStyle.transform,
        position: rowStyle.position,
        left: rowStyle.left,
        top: rowStyle.top,
        backgroundColor: rowStyle.backgroundColor,
        backgroundImage: rowStyle.backgroundImage,
        backgroundPosition: rowStyle.backgroundPosition,
        backgroundSize: rowStyle.backgroundSize,
        opacity: rowStyle.opacity,
      },
      ancestry,
      fonts: {
        status: document.fonts?.status || 'unsupported',
        family: targetStyle.fontFamily,
        size: targetStyle.fontSize,
        weight: targetStyle.fontWeight,
      },
    }
  }, anchor)
}

function differences(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  keys: readonly string[],
): Difference[] {
  return keys.flatMap((field) =>
    before[field] === after[field] ? [] : [{ field, before: before[field], after: after[field] }],
  )
}

function crossDifferences(
  reference: Record<string, unknown>,
  currentSource: Record<string, unknown>,
  keys: readonly string[],
): CrossDifference[] {
  return keys.flatMap((field) =>
    reference[field] === currentSource[field]
      ? []
      : [{ field, reference: reference[field], currentSource: currentSource[field] }],
  )
}

function rectDelta(before: Rect, after: Rect) {
  return {
    x: after.x - before.x,
    y: after.y - before.y,
    width: after.width - before.width,
    height: after.height - before.height,
  }
}

function exactZeroRect(delta: ReturnType<typeof rectDelta>) {
  return Object.values(delta).every((value) => Object.is(value, 0) || Object.is(value, -0))
}

function exactZeroPoint(delta: { x: number; y: number }) {
  return Object.values(delta).every((value) => Object.is(value, 0) || Object.is(value, -0))
}

type Bitmap = { width: number; height: number; rgba: Uint8Array }

async function readBitmap(pngPath: string, temporaryBMP: string): Promise<Bitmap> {
  await execFileAsync('/usr/bin/sips', ['-s', 'format', 'bmp', pngPath, '--out', temporaryBMP])
  const bytes = await readFile(temporaryBMP)
  const pixelOffset = bytes.readUInt32LE(10)
  const width = bytes.readInt32LE(18)
  const rawHeight = bytes.readInt32LE(22)
  const height = Math.abs(rawHeight)
  const bitsPerPixel = bytes.readUInt16LE(28)
  const compression = bytes.readUInt32LE(30)
  const supportedCompression = compression === 0 || (compression === 3 && bitsPerPixel === 32)
  if (width <= 0 || height <= 0 || ![24, 32].includes(bitsPerPixel) || !supportedCompression) {
    throw new Error(
      `unsupported sips BMP: ${width}x${rawHeight}, bpp=${bitsPerPixel}, compression=${compression}`,
    )
  }
  const bytesPerPixel = bitsPerPixel / 8
  const rowStride = Math.ceil((width * bytesPerPixel) / 4) * 4
  const rgba = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    const sourceY = rawHeight > 0 ? height - 1 - y : y
    for (let x = 0; x < width; x += 1) {
      const source = pixelOffset + sourceY * rowStride + x * bytesPerPixel
      const target = (y * width + x) * 4
      rgba[target] = bytes[source + 2]!
      rgba[target + 1] = bytes[source + 1]!
      rgba[target + 2] = bytes[source]!
      rgba[target + 3] = bytesPerPixel === 4 ? bytes[source + 3]! : 255
    }
  }
  return { width, height, rgba }
}

function writeBitmap24(bitmap: Bitmap): Buffer {
  const rowStride = Math.ceil((bitmap.width * 3) / 4) * 4
  const pixelBytes = rowStride * bitmap.height
  const output = Buffer.alloc(54 + pixelBytes)
  output.write('BM', 0, 'ascii')
  output.writeUInt32LE(output.length, 2)
  output.writeUInt32LE(54, 10)
  output.writeUInt32LE(40, 14)
  output.writeInt32LE(bitmap.width, 18)
  output.writeInt32LE(bitmap.height, 22)
  output.writeUInt16LE(1, 26)
  output.writeUInt16LE(24, 28)
  output.writeUInt32LE(pixelBytes, 34)
  for (let y = 0; y < bitmap.height; y += 1) {
    const targetY = bitmap.height - 1 - y
    for (let x = 0; x < bitmap.width; x += 1) {
      const source = (y * bitmap.width + x) * 4
      const target = 54 + targetY * rowStride + x * 3
      output[target] = bitmap.rgba[source + 2]!
      output[target + 1] = bitmap.rgba[source + 1]!
      output[target + 2] = bitmap.rgba[source]!
    }
  }
  return output
}

async function pixelDiff(referencePath: string, sourcePath: string, diffPath: string) {
  const directory = path.dirname(diffPath)
  const stem = path.basename(diffPath, '.png')
  const referenceBMP = path.join(directory, `.${stem}-reference.bmp`)
  const sourceBMP = path.join(directory, `.${stem}-source.bmp`)
  const diffBMP = path.join(directory, `.${stem}.bmp`)
  try {
    const reference = await readBitmap(referencePath, referenceBMP)
    const source = await readBitmap(sourcePath, sourceBMP)
    if (reference.width !== source.width || reference.height !== source.height) {
      throw new Error(
        `screenshot size mismatch: reference=${reference.width}x${reference.height}, source=${source.width}x${source.height}`,
      )
    }
    const visible = new Uint8Array(reference.rgba.length)
    let changedPixels = 0
    let minX = reference.width
    let minY = reference.height
    let maxX = -1
    let maxY = -1
    for (let y = 0; y < reference.height; y += 1) {
      for (let x = 0; x < reference.width; x += 1) {
        const offset = (y * reference.width + x) * 4
        const changed =
          Math.abs(reference.rgba[offset]! - source.rgba[offset]!) > PIXEL_THRESHOLD ||
          Math.abs(reference.rgba[offset + 1]! - source.rgba[offset + 1]!) > PIXEL_THRESHOLD ||
          Math.abs(reference.rgba[offset + 2]! - source.rgba[offset + 2]!) > PIXEL_THRESHOLD
        if (changed) {
          changedPixels += 1
          minX = Math.min(minX, x)
          minY = Math.min(minY, y)
          maxX = Math.max(maxX, x)
          maxY = Math.max(maxY, y)
          visible[offset] = 255
          visible[offset + 1] = 35
          visible[offset + 2] = 35
        } else {
          const gray = Math.round(
            (reference.rgba[offset]! * 0.299 +
              reference.rgba[offset + 1]! * 0.587 +
              reference.rgba[offset + 2]! * 0.114) *
              0.45,
          )
          visible[offset] = gray
          visible[offset + 1] = gray
          visible[offset + 2] = gray
        }
        visible[offset + 3] = 255
      }
    }
    await writeFile(
      diffBMP,
      writeBitmap24({ width: reference.width, height: reference.height, rgba: visible }),
    )
    await execFileAsync('/usr/bin/sips', ['-s', 'format', 'png', diffBMP, '--out', diffPath])
    const totalPixels = reference.width * reference.height
    return {
      width: reference.width,
      height: reference.height,
      threshold: PIXEL_THRESHOLD,
      changed_pixels: changedPixels,
      total_pixels: totalPixels,
      changed_pixel_ratio: totalPixels ? changedPixels / totalPixels : 0,
      changed_bbox: changedPixels ? [minX, minY, maxX + 1, maxY + 1] : null,
    }
  } finally {
    await Promise.all([
      rm(referenceBMP, { force: true }),
      rm(sourceBMP, { force: true }),
      rm(diffBMP, { force: true }),
    ])
  }
}

async function sha256(file: string) {
  return createHash('sha256')
    .update(await readFile(file))
    .digest('hex')
}

async function installedCandidate() {
  const nativeSummaryPath = path.join(EVIDENCE_ROOT, 'native/installed-summary.json')
  if (existsSync(nativeSummaryPath)) {
    const nativeSummary = JSON.parse(await readFile(nativeSummaryPath, 'utf8'))
    if (nativeSummary.status === 'PASS') {
      return {
        status: 'PASS',
        evidence: 'native/installed-summary.json',
        reason: nativeSummary.reason,
        applicationsTouched: false,
        userDataTouched: false,
        executableSha256: nativeSummary.app?.executableSHA256 ?? null,
      }
    }
  }
  const bundle = path.join(REPO_ROOT, 'src-tauri/target/release/bundle/macos/HexClaw Test.app')
  const executable = path.join(bundle, 'Contents/MacOS/hexclaw-desktop')
  const info = path.join(bundle, 'Contents/Info.plist')
  const present = existsSync(executable) && existsSync(info)
  return {
    status: 'NOT_RUN',
    candidate: 'src-tauri/target/release/bundle/macos/HexClaw Test.app',
    present,
    executableSha256: present ? await sha256(executable) : null,
    infoPlistSha256: present ? await sha256(info) : null,
    executableModifiedAt: present ? (await stat(executable)).mtime.toISOString() : null,
    reason:
      'No reusable read-only WKWebView injection and DOM/computed-style capture path can prove this bundle contains the current worktree CSS and the exact deterministic resource-row fixture.',
    applicationsTouched: false,
    userDataTouched: false,
  }
}

async function writeAggregateSummary() {
  const engines = ['chromium', 'webkit']
  const reports = []
  for (const engine of engines) {
    try {
      reports.push(
        JSON.parse(await readFile(path.join(EVIDENCE_ROOT, engine, 'status.json'), 'utf8')),
      )
    } catch {
      // 单项目调试时允许汇总文件明确显示尚未采集的浏览器。
    }
  }
  const complete = reports.length === engines.length
  const summary = {
    bug: 'BUG-20260723-011',
    status:
      complete && reports.every((report) => report.status === 'PASS')
        ? 'PASS'
        : reports.some((report) => report.status === 'RED')
          ? 'RED'
          : reports.some((report) => report.status === 'AUTOMATION_BASELINE_BLOCKED')
            ? 'AUTOMATION_BASELINE_BLOCKED'
            : 'INCOMPLETE',
    requiredBrowsers: engines,
    collectedBrowsers: reports.map((report) => report.browser),
    workers: 1,
    reports: reports.map((report) => ({
      browser: report.browser,
      status: report.status,
      mapping: report.mapping,
      hoverStability: report.hoverStability,
      visualParity: report.visualParity,
      elementVisualParity: report.elementVisualParity ?? 'NOT_COLLECTED_CURRENT_SCHEMA',
      elementPixelDiagnostic:
        report.prototypeCurrentComparison?.elementOnly?.diagnostic ??
        'NOT_COLLECTED_CURRENT_SCHEMA',
      pageContextStatus:
        report.prototypeCurrentComparison?.pageContext?.status ?? 'NOT_COLLECTED_CURRENT_SCHEMA',
    })),
    installedApplication: await installedCandidate(),
    command:
      'pnpm exec playwright test -c tests/e2e/bug-20260723-011.playwright.config.ts --workers=1',
  }
  await writeFile(path.join(EVIDENCE_ROOT, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  await writeFile(
    path.join(EVIDENCE_ROOT, 'README.md'),
    `# BUG-20260723-011 current-source visual evidence\n\n` +
      `- Overall: **${summary.status}**\n` +
      `- Browsers: ${
        summary.reports
          .map(
            (report) =>
              `${report.browser}=${report.status} (hover=${report.hoverStability}, element=${report.elementVisualParity}, element-diagnostic=${report.elementPixelDiagnostic}, context=${report.pageContextStatus})`,
          )
          .join(', ') || 'none'
      }\n` +
      `- Installed application: **${summary.installedApplication.status}** — ${summary.installedApplication.reason}\n` +
      `- Isolation: loopback-only browser fixtures; no /Applications or user-data access.\n` +
      `- Invariant: the same DOM node must remain connected across hover and its x/y/width/height deltas must all be exactly 0.\n` +
      `- Pixel gate: same integer viewport clip after both real resource rows are moved to the same target raster phase; fonts, the test-only homomorphic .rc-week-hero/.resource-row content background, and the exact target raster declarations must pass the unchanged channel threshold=${PIXEL_THRESHOLD}, maximum changed-pixel ratio=${MAX_CHANGED_PIXEL_RATIO}.\n` +
      `- Raw diagnostic: the pre-injection ancestor-background and target-raster snapshots/screenshots remain preserved; page context and raw drift are diagnostic and never replace the exact element gate.\n` +
      `- Run: \`${summary.command}\`\n`,
  )
}

async function exercise(testInfo: TestInfo, referencePage: Page, sourcePage: Page) {
  const browserName = testInfo.project.name
  const directory = path.join(EVIDENCE_ROOT, browserName)
  await rm(directory, { recursive: true, force: true })
  await mkdir(directory, { recursive: true })

  const blockedReferenceRequests: string[] = []
  const blockedSourceRequests: string[] = []
  const referenceErrors: string[] = []
  const sourceErrors: string[] = []
  referencePage.on('pageerror', (error) => referenceErrors.push(error.message))
  sourcePage.on('pageerror', (error) => sourceErrors.push(error.message))

  await installReferenceIsolation(referencePage, blockedReferenceRequests)
  await installSourceFixture(sourcePage, blockedSourceRequests)
  await openReference(referencePage)
  await openSource(sourcePage)
  await referencePage.mouse.move(0, 0)
  await sourcePage.mouse.move(0, 0)
  await markTarget(referencePage, REFERENCE_BUTTON)
  await markTarget(sourcePage, SOURCE_BUTTON)

  const referenceBefore = await snapshot(referencePage, REFERENCE_BUTTON)
  const sourceBefore = await snapshot(sourcePage, SOURCE_BUTTON)
  const referenceClip = fixedClip(referenceBefore.rect)
  const sourceClip = fixedClip(sourceBefore.rect)
  const referenceButton = referencePage.locator(REFERENCE_BUTTON)
  const sourceButton = sourcePage.locator(SOURCE_BUTTON)
  const elementCrop = {
    width: Math.ceil(Math.max(referenceBefore.rect.width, sourceBefore.rect.width)),
    height: Math.ceil(Math.max(referenceBefore.rect.height, sourceBefore.rect.height)),
  }
  const sharedElementClip = { x: 1080, y: 400, ...elementCrop }
  const files = {
    referenceBefore: path.join(directory, 'reference-before.png'),
    sourceBefore: path.join(directory, 'current-source-before.png'),
    diffBefore: path.join(directory, 'diff-before.png'),
    referenceElementBefore: path.join(directory, 'reference-element-before.png'),
    sourceElementBefore: path.join(directory, 'current-source-element-before.png'),
    diffElementBefore: path.join(directory, 'diff-element-before.png'),
    referenceElementBackground: path.join(directory, 'reference-element-background.png'),
    sourceElementBackground: path.join(directory, 'current-source-element-background.png'),
    diffElementBackground: path.join(directory, 'diff-element-background.png'),
    referenceHomomorphicBackground: path.join(
      directory,
      'reference-element-background-homomorphic.png',
    ),
    sourceHomomorphicBackground: path.join(
      directory,
      'current-source-element-background-homomorphic.png',
    ),
    diffHomomorphicBackground: path.join(directory, 'diff-element-background-homomorphic.png'),
    referenceHover: path.join(directory, 'reference-hover.png'),
    sourceHover: path.join(directory, 'current-source-hover.png'),
    diffHover: path.join(directory, 'diff-hover.png'),
    referenceElementHover: path.join(directory, 'reference-element-hover.png'),
    sourceElementHover: path.join(directory, 'current-source-element-hover.png'),
    diffElementHover: path.join(directory, 'diff-element-hover.png'),
    geometryStyle: path.join(directory, 'hover-bbox-computed-style.json'),
    status: path.join(directory, 'status.json'),
  }
  await capture(referencePage, files.referenceBefore, referenceClip)
  await capture(sourcePage, files.sourceBefore, sourceClip)

  await referenceButton.hover()
  await sourceButton.hover()
  await settle(referencePage)
  await settle(sourcePage)
  const referenceAfter = await snapshot(referencePage, REFERENCE_BUTTON)
  const sourceAfter = await snapshot(sourcePage, SOURCE_BUTTON)
  await capture(referencePage, files.referenceHover, referenceClip)
  await capture(sourcePage, files.sourceHover, sourceClip)

  await referencePage.mouse.move(0, 0)
  await sourcePage.mouse.move(0, 0)
  await settle(referencePage)
  await settle(sourcePage)
  const referenceAlignment = await alignTargetRaster(referencePage, REFERENCE_BUTTON, {
    x: sharedElementClip.x + (elementCrop.width - referenceBefore.rect.width) / 2,
    y: sharedElementClip.y + (elementCrop.height - referenceBefore.rect.height) / 2,
  })
  const sourceAlignment = await alignTargetRaster(sourcePage, SOURCE_BUTTON, {
    x: sharedElementClip.x + (elementCrop.width - sourceBefore.rect.width) / 2,
    y: sharedElementClip.y + (elementCrop.height - sourceBefore.rect.height) / 2,
  })
  const referenceAlignedBefore = await snapshot(referencePage, REFERENCE_BUTTON)
  const sourceAlignedBefore = await snapshot(sourcePage, SOURCE_BUTTON)
  await captureRealAncestorBackground(
    referencePage,
    referenceButton,
    files.referenceElementBackground,
    sharedElementClip,
  )
  await captureRealAncestorBackground(
    sourcePage,
    sourceButton,
    files.sourceElementBackground,
    sharedElementClip,
  )
  await injectHomomorphicContentBackground(referencePage)
  await injectHomomorphicContentBackground(sourcePage)
  await injectHomomorphicTargetRaster(referencePage, REFERENCE_BUTTON)
  await injectHomomorphicTargetRaster(sourcePage, SOURCE_BUTTON)
  const referenceHomomorphicBefore = await snapshot(referencePage, REFERENCE_BUTTON)
  const sourceHomomorphicBefore = await snapshot(sourcePage, SOURCE_BUTTON)
  await capture(referencePage, files.referenceElementBefore, sharedElementClip)
  await capture(sourcePage, files.sourceElementBefore, sharedElementClip)
  await captureRealAncestorBackground(
    referencePage,
    referenceButton,
    files.referenceHomomorphicBackground,
    sharedElementClip,
  )
  await captureRealAncestorBackground(
    sourcePage,
    sourceButton,
    files.sourceHomomorphicBackground,
    sharedElementClip,
  )
  await referenceButton.hover()
  await sourceButton.hover()
  await settle(referencePage)
  await settle(sourcePage)
  const referenceAlignedHover = await snapshot(referencePage, REFERENCE_BUTTON)
  const sourceAlignedHover = await snapshot(sourcePage, SOURCE_BUTTON)
  await capture(referencePage, files.referenceElementHover, sharedElementClip)
  await capture(sourcePage, files.sourceElementHover, sharedElementClip)

  const [
    pageContextPixelsBefore,
    pageContextPixelsHover,
    elementPixelsBefore,
    elementPixelsHover,
    rawRealAncestorBackgroundPixels,
    realAncestorBackgroundPixels,
  ] = await Promise.all([
    pixelDiff(files.referenceBefore, files.sourceBefore, files.diffBefore),
    pixelDiff(files.referenceHover, files.sourceHover, files.diffHover),
    pixelDiff(files.referenceElementBefore, files.sourceElementBefore, files.diffElementBefore),
    pixelDiff(files.referenceElementHover, files.sourceElementHover, files.diffElementHover),
    pixelDiff(
      files.referenceElementBackground,
      files.sourceElementBackground,
      files.diffElementBackground,
    ),
    pixelDiff(
      files.referenceHomomorphicBackground,
      files.sourceHomomorphicBackground,
      files.diffHomomorphicBackground,
    ),
  ])

  const semanticKeys = ['tag', 'implicitRole', 'text', 'disabled', 'action', 'rowPrompt'] as const
  const semanticDifferences = crossDifferences(
    referenceBefore.identity,
    sourceBefore.identity,
    semanticKeys,
  )
  const mapping = semanticDifferences.length === 0 ? 'COMPARABLE' : 'NOT_COMPARABLE'
  const referenceDelta = rectDelta(referenceBefore.rect, referenceAfter.rect)
  const sourceDelta = rectDelta(sourceBefore.rect, sourceAfter.rect)
  const referenceLayoutChanges = differences(
    referenceBefore.style,
    referenceAfter.style,
    HOVER_LAYOUT_STYLE_KEYS,
  )
  const sourceLayoutChanges = differences(
    sourceBefore.style,
    sourceAfter.style,
    HOVER_LAYOUT_STYLE_KEYS,
  )
  const referenceHoverStyleChanges = differences(
    referenceBefore.style,
    referenceAfter.style,
    STYLE_KEYS,
  )
  const sourceHoverStyleChanges = differences(sourceBefore.style, sourceAfter.style, STYLE_KEYS)
  const hoverStability =
    referenceAfter.sameNode &&
    sourceAfter.sameNode &&
    referenceAfter.hovered &&
    sourceAfter.hovered &&
    exactZeroRect(referenceDelta) &&
    exactZeroRect(sourceDelta) &&
    referenceLayoutChanges.length === 0 &&
    sourceLayoutChanges.length === 0
      ? 'PASS'
      : 'RED'

  const beforeCrossStyleDifferences = crossDifferences(
    referenceBefore.style,
    sourceBefore.style,
    CROSS_VISUAL_STYLE_KEYS,
  )
  const hoverCrossStyleDifferences = crossDifferences(
    referenceAfter.style,
    sourceAfter.style,
    CROSS_VISUAL_STYLE_KEYS,
  )
  const beforeRasterStyleDifferences = crossDifferences(
    referenceBefore.rasterStyle,
    sourceBefore.rasterStyle,
    RASTER_STYLE_KEYS,
  )
  const hoverRasterStyleDifferences = crossDifferences(
    referenceAfter.rasterStyle,
    sourceAfter.rasterStyle,
    RASTER_STYLE_KEYS,
  )
  const crossDimensionDifferences = crossDifferences(referenceBefore.rect, sourceBefore.rect, [
    'width',
    'height',
  ])
  const rawTargetVisualContractExact =
    beforeCrossStyleDifferences.length === 0 &&
    hoverCrossStyleDifferences.length === 0 &&
    crossDimensionDifferences.length === 0
  const homomorphicCrossDimensionDifferences = crossDifferences(
    referenceHomomorphicBefore.rect,
    sourceHomomorphicBefore.rect,
    ['width', 'height'],
  )
  const homomorphicBeforeCrossStyleDifferences = crossDifferences(
    referenceHomomorphicBefore.style,
    sourceHomomorphicBefore.style,
    CROSS_VISUAL_STYLE_KEYS,
  )
  const homomorphicHoverCrossStyleDifferences = crossDifferences(
    referenceAlignedHover.style,
    sourceAlignedHover.style,
    CROSS_VISUAL_STYLE_KEYS,
  )
  const homomorphicBeforeRasterStyleDifferences = crossDifferences(
    referenceHomomorphicBefore.rasterStyle,
    sourceHomomorphicBefore.rasterStyle,
    RASTER_STYLE_KEYS,
  )
  const homomorphicHoverRasterStyleDifferences = crossDifferences(
    referenceAlignedHover.rasterStyle,
    sourceAlignedHover.rasterStyle,
    RASTER_STYLE_KEYS,
  )
  const homomorphicTargetVisualContractExact =
    homomorphicBeforeCrossStyleDifferences.length === 0 &&
    homomorphicHoverCrossStyleDifferences.length === 0 &&
    homomorphicBeforeRasterStyleDifferences.length === 0 &&
    homomorphicHoverRasterStyleDifferences.length === 0 &&
    homomorphicCrossDimensionDifferences.length === 0
  const alignedRectDelta = rectDelta(referenceAlignment.rect, sourceAlignment.rect)
  const alignedRasterExact =
    exactZeroPoint(referenceAlignment.delta) &&
    exactZeroPoint(sourceAlignment.delta) &&
    exactZeroRect(alignedRectDelta) &&
    referenceAlignedBefore.sameNode &&
    sourceAlignedBefore.sameNode &&
    !referenceAlignedBefore.hovered &&
    !sourceAlignedBefore.hovered &&
    referenceAlignedHover.sameNode &&
    sourceAlignedHover.sameNode &&
    referenceAlignedHover.hovered &&
    sourceAlignedHover.hovered
  const fontsLoaded =
    referenceAlignment.fonts.status === 'loaded' &&
    sourceAlignment.fonts.status === 'loaded' &&
    referenceAlignment.fonts.family === sourceAlignment.fonts.family &&
    referenceAlignment.fonts.size === sourceAlignment.fonts.size &&
    referenceAlignment.fonts.weight === sourceAlignment.fonts.weight
  const realAncestorBackgroundExact =
    realAncestorBackgroundPixels.changed_pixel_ratio <= MAX_CHANGED_PIXEL_RATIO
  const automationBaselineReady = alignedRasterExact && fontsLoaded && realAncestorBackgroundExact
  const elementVisualParity =
    homomorphicTargetVisualContractExact &&
    automationBaselineReady &&
    elementPixelsBefore.changed_pixel_ratio <= MAX_CHANGED_PIXEL_RATIO &&
    elementPixelsHover.changed_pixel_ratio <= MAX_CHANGED_PIXEL_RATIO
      ? 'PASS'
      : 'RED'
  const elementPixelDiagnostic =
    elementVisualParity === 'PASS'
      ? 'NO_MATERIAL_PIXEL_DIFFERENCE'
      : !automationBaselineReady
        ? 'AUTOMATION_BASELINE_NOT_HOMOMORPHIC'
        : homomorphicTargetVisualContractExact
          ? 'EXACT_CONTRACT_ENGINE_SUBPIXEL_TEXT_AND_EDGE_RASTERIZATION_OVER_THRESHOLD'
          : 'MATERIAL_TARGET_CONTRACT_DRIFT'
  const pageContextWithinThreshold =
    pageContextPixelsBefore.changed_pixel_ratio <= MAX_CHANGED_PIXEL_RATIO &&
    pageContextPixelsHover.changed_pixel_ratio <= MAX_CHANGED_PIXEL_RATIO
  const pageContextStatus = pageContextWithinThreshold
    ? 'PASS'
    : rawTargetVisualContractExact
      ? 'EXPLAINED_NON_BUG_PAGE_LAYOUT_DRIFT'
      : 'MATERIAL_OR_UNEXPLAINED_TARGET_DRIFT'
  const visualParity = elementVisualParity
  const status =
    mapping === 'COMPARABLE' && hoverStability === 'PASS' && visualParity === 'PASS'
      ? 'PASS'
      : mapping === 'NOT_COMPARABLE'
        ? 'NOT_COMPARABLE'
        : !automationBaselineReady
          ? 'AUTOMATION_BASELINE_BLOCKED'
          : 'RED'

  const sourceFiles = {
    weeklyPanel: 'src/features/k12/components/K12WeeklyPracticePanel.vue',
    globalCss: 'src/assets/styles/global.css',
    governance: 'src/__tests__/button-control-governance-20260727.test.ts',
    pairedTest: 'tests/e2e/bug-20260723-011-resource-row-visual.spec.ts',
  }
  const sourceHashes = Object.fromEntries(
    await Promise.all(
      Object.entries(sourceFiles).map(async ([name, relative]) => [
        name,
        await sha256(path.join(REPO_ROOT, relative)),
      ]),
    ),
  )
  const report = {
    bug: 'BUG-20260723-011',
    browser: browserName,
    status,
    mapping,
    semanticDifferences,
    hoverStability,
    visualParity,
    elementVisualParity,
    environment: {
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      colorScheme: 'light',
      reducedMotion: 'reduce',
      pixelThreshold: PIXEL_THRESHOLD,
      maxChangedPixelRatio: MAX_CHANGED_PIXEL_RATIO,
      referenceURL: REFERENCE_URL,
      sourceURL: SOURCE_URL,
    },
    target: {
      referenceSelector: REFERENCE_BUTTON,
      sourceSelector: SOURCE_BUTTON,
      semanticState: '解方程 2x+15=43 / 加入练习集 / enabled',
    },
    reference: {
      before: referenceBefore,
      hover: referenceAfter,
      rectDelta: referenceDelta,
      layoutStyleChanges: referenceLayoutChanges,
      hoverComputedStyleChanges: referenceHoverStyleChanges,
    },
    currentSource: {
      before: sourceBefore,
      hover: sourceAfter,
      rectDelta: sourceDelta,
      layoutStyleChanges: sourceLayoutChanges,
      hoverComputedStyleChanges: sourceHoverStyleChanges,
    },
    prototypeCurrentComparison: {
      crossDimensionDifferences,
      beforeCrossStyleDifferences,
      hoverCrossStyleDifferences,
      beforeRasterStyleDifferences,
      hoverRasterStyleDifferences,
      homomorphicCrossDimensionDifferences,
      homomorphicBeforeCrossStyleDifferences,
      homomorphicHoverCrossStyleDifferences,
      homomorphicBeforeRasterStyleDifferences,
      homomorphicHoverRasterStyleDifferences,
      targetRasterNormalization: {
        status: homomorphicTargetVisualContractExact ? 'PASS' : 'RED',
        method:
          'test-only exact-target injection on prototype and current source; raw target snapshots remain separate; no pixel ignore',
        selectors: {
          reference: REFERENCE_BUTTON,
          currentSource: SOURCE_BUTTON,
        },
        declarations: {
          appearance: 'none',
          '-webkit-appearance': 'none',
          'font-feature-settings': 'normal',
          'text-rendering': 'auto',
          'justify-content': 'normal',
        },
        scope: 'test-only browser harness injection; exact target button only',
        referenceBefore: referenceHomomorphicBefore,
        currentSourceBefore: sourceHomomorphicBefore,
        referenceHover: referenceAlignedHover,
        currentSourceHover: sourceAlignedHover,
      },
      pixelGateSource: 'locator-element-only',
      elementOnly: {
        status: elementVisualParity,
        diagnostic: elementPixelDiagnostic,
        thresholdPolicy: 'UNCHANGED_NO_ENGINE_EXEMPTION',
        capture: 'shared-integer-viewport-clip-with-positioned-real-resource-row',
        crop: elementCrop,
        sharedClip: sharedElementClip,
        alignment: {
          status: alignedRasterExact ? 'PASS' : 'RED',
          reference: referenceAlignment,
          currentSource: sourceAlignment,
          crossRectDelta: alignedRectDelta,
          referenceBefore: referenceAlignedBefore,
          currentSourceBefore: sourceAlignedBefore,
          referenceHover: referenceAlignedHover,
          currentSourceHover: sourceAlignedHover,
        },
        fontLoading: {
          status: fontsLoaded ? 'PASS' : 'RED',
          reference: referenceAlignment.fonts,
          currentSource: sourceAlignment.fonts,
        },
        realAncestorBackground: {
          status: realAncestorBackgroundExact ? 'PASS' : 'RED',
          method:
            'same shared integer clip with only the target visibility hidden; test-only homomorphic content background on .rc-week-hero/.resource-row; no pixel ignore',
          pixels: realAncestorBackgroundPixels,
          rawDiagnostic: {
            status:
              rawRealAncestorBackgroundPixels.changed_pixel_ratio <= MAX_CHANGED_PIXEL_RATIO
                ? 'PASS'
                : 'RED',
            pixels: rawRealAncestorBackgroundPixels,
          },
          contentBackground: {
            value: 'rgb(251, 251, 245)',
            selectors: [
              '.rc-week-hero',
              '.rc-week-hero .resource-row',
              '.weekly-hero.rc-week-hero',
              '.weekly-hero.rc-week-hero .resource-row',
            ],
            scope: 'test-only browser harness injection; prototype and current source',
          },
        },
        targetRasterPhase: {
          reference: {
            x: referenceAlignment.rect.x - Math.floor(referenceAlignment.rect.x),
            y: referenceAlignment.rect.y - Math.floor(referenceAlignment.rect.y),
          },
          currentSource: {
            x: sourceAlignment.rect.x - Math.floor(sourceAlignment.rect.x),
            y: sourceAlignment.rect.y - Math.floor(sourceAlignment.rect.y),
          },
        },
        visibleDiffReview:
          browserName === 'webkit' && elementVisualParity === 'RED'
            ? 'The unchanged threshold remains gating evidence only after shared-coordinate raster alignment, loaded-font equality, and real-ancestor-background parity are recorded.'
            : null,
        pixelsBefore: elementPixelsBefore,
        pixelsHover: elementPixelsHover,
      },
      pageContext: {
        status: pageContextStatus,
        gate: 'DIAGNOSTIC_ONLY',
        crop: TARGET_CROP,
        absoluteTargetPositionDelta: {
          x: sourceBefore.rect.x - referenceBefore.rect.x,
          y: sourceBefore.rect.y - referenceBefore.rect.y,
        },
        explanation:
          'The preserved 220×88 crop includes neighboring row content and a page-anchored translucent background. Differences outside an exact target contract are page-layout diagnostics for this bug, not a substitute for the locator element gate.',
        pixelsBefore: pageContextPixelsBefore,
        pixelsHover: pageContextPixelsHover,
      },
    },
    isolation: {
      blockedReferenceRequests,
      blockedSourceRequests,
      referencePageErrors: referenceErrors,
      sourcePageErrors: sourceErrors,
      applicationsTouched: false,
      userDataTouched: false,
    },
    hashes: {
      prototype: await sha256(path.join(DOCS_ROOT, 'prototype/app.html')),
      currentSource: sourceHashes,
    },
    installedApplication: await installedCandidate(),
    files: {
      referenceBefore: 'reference-before.png',
      currentSourceBefore: 'current-source-before.png',
      diffBefore: 'diff-before.png',
      referenceElementBefore: 'reference-element-before.png',
      currentSourceElementBefore: 'current-source-element-before.png',
      diffElementBefore: 'diff-element-before.png',
      referenceElementBackground: 'reference-element-background.png',
      currentSourceElementBackground: 'current-source-element-background.png',
      diffElementBackground: 'diff-element-background.png',
      referenceHomomorphicBackground: 'reference-element-background-homomorphic.png',
      currentSourceHomomorphicBackground: 'current-source-element-background-homomorphic.png',
      diffHomomorphicBackground: 'diff-element-background-homomorphic.png',
      referenceHover: 'reference-hover.png',
      currentSourceHover: 'current-source-hover.png',
      diffHover: 'diff-hover.png',
      referenceElementHover: 'reference-element-hover.png',
      currentSourceElementHover: 'current-source-element-hover.png',
      diffElementHover: 'diff-element-hover.png',
      geometryStyle: 'hover-bbox-computed-style.json',
      status: 'status.json',
    },
  }

  await writeFile(
    files.geometryStyle,
    `${JSON.stringify(
      {
        mapping,
        semanticDifferences,
        reference: report.reference,
        currentSource: report.currentSource,
        prototypeCurrentComparison: report.prototypeCurrentComparison,
      },
      null,
      2,
    )}\n`,
  )
  await writeFile(files.status, `${JSON.stringify(report, null, 2)}\n`)
  await writeAggregateSummary()

  for (const [name, file, contentType] of [
    ['reference-before', files.referenceBefore, 'image/png'],
    ['current-source-before', files.sourceBefore, 'image/png'],
    ['diff-before', files.diffBefore, 'image/png'],
    ['reference-element-before', files.referenceElementBefore, 'image/png'],
    ['current-source-element-before', files.sourceElementBefore, 'image/png'],
    ['diff-element-before', files.diffElementBefore, 'image/png'],
    ['reference-element-background', files.referenceElementBackground, 'image/png'],
    ['current-source-element-background', files.sourceElementBackground, 'image/png'],
    ['diff-element-background', files.diffElementBackground, 'image/png'],
    ['reference-element-background-homomorphic', files.referenceHomomorphicBackground, 'image/png'],
    [
      'current-source-element-background-homomorphic',
      files.sourceHomomorphicBackground,
      'image/png',
    ],
    ['diff-element-background-homomorphic', files.diffHomomorphicBackground, 'image/png'],
    ['reference-hover', files.referenceHover, 'image/png'],
    ['current-source-hover', files.sourceHover, 'image/png'],
    ['diff-hover', files.diffHover, 'image/png'],
    ['reference-element-hover', files.referenceElementHover, 'image/png'],
    ['current-source-element-hover', files.sourceElementHover, 'image/png'],
    ['diff-element-hover', files.diffElementHover, 'image/png'],
    ['hover-bbox-computed-style', files.geometryStyle, 'application/json'],
    ['status', files.status, 'application/json'],
  ] as const) {
    await testInfo.attach(`${browserName}-${name}`, { path: file, contentType })
  }

  expect.soft(mapping, `inspect ${files.geometryStyle}`).toBe('COMPARABLE')
  expect.soft(referenceAfter.sameNode, 'reference must retain the exact DOM node').toBe(true)
  expect.soft(sourceAfter.sameNode, 'current source must retain the exact DOM node').toBe(true)
  expect.soft(referenceAfter.hovered, 'reference button must reach :hover').toBe(true)
  expect.soft(sourceAfter.hovered, 'current-source button must reach :hover').toBe(true)
  expect.soft(referenceDelta, 'reference hover bbox delta must be exactly zero').toEqual({
    x: 0,
    y: 0,
    width: 0,
    height: 0,
  })
  expect.soft(sourceDelta, 'current-source hover bbox delta must be exactly zero').toEqual({
    x: 0,
    y: 0,
    width: 0,
    height: 0,
  })
  expect
    .soft(referenceLayoutChanges, 'reference hover layout styles must remain stable')
    .toEqual([])
  expect
    .soft(sourceLayoutChanges, 'current-source hover layout styles must remain stable')
    .toEqual([])
  expect.soft(blockedReferenceRequests, 'reference must remain loopback-only').toEqual([])
  expect.soft(blockedSourceRequests, 'current source must remain loopback-only').toEqual([])
  expect.soft(referenceErrors, 'reference page errors').toEqual([])
  expect.soft(sourceErrors, 'current-source page errors').toEqual([])
  expect
    .soft(alignedRasterExact, 'target raster coordinates and hover state must be exact')
    .toBe(true)
  expect.soft(fontsLoaded, 'both target font sets must be fully loaded and exact').toBe(true)
  expect
    .soft(
      realAncestorBackgroundExact,
      'real ancestor backgrounds must match before target pixels can gate the product',
    )
    .toBe(true)
  expect
    .soft(
      homomorphicTargetVisualContractExact,
      'homomorphic target raster declarations must match without changing the raw diagnostic',
    )
    .toBe(true)
  expect(
    status,
    `visual gate is ${status}; inspect ${files.status}, ${files.diffElementBefore}, ${files.diffElementHover}, and the preserved page-context diffs ${files.diffBefore}/${files.diffHover}`,
  ).toBe('PASS')
}

test.describe('BUG-20260723-011 · K12 weekly resource-row hover paired visual', () => {
  test('authoritative prototype and current source keep the exact button node and bbox on hover', async ({
    browser,
  }, testInfo) => {
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      colorScheme: 'light',
      reducedMotion: 'reduce',
    })
    const referencePage = await context.newPage()
    const sourcePage = await context.newPage()
    try {
      await exercise(testInfo, referencePage, sourcePage)
    } finally {
      await context.close()
    }
  })
})
