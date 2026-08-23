#!/usr/bin/env node

/**
 * BUG-20260723-011 的隔离 Test.app / WKWebView hover 证据。
 *
 * 当前工作树前端构建到临时目录，注入与浏览器门同态的周练 fixture，再用唯一 Bundle ID
 * 构建临时 Test.app。运行时只使用 0700 Test Home、专用 loopback 端口和物理鼠标移动；
 * 不读取真实用户目录，不接触 /Applications，也不调用真实模型或 IM。
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const nativeDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(nativeDir, '../..')
const docsRoot = resolve(repoRoot, '../hexclaw-docs')
const srcTauriDir = join(repoRoot, 'src-tauri')
const evidenceRoot = join(docsRoot, 'test/evidence/bug-20260723-011-current-source/native')
const browserEvidenceRoot = dirname(evidenceRoot)
const productName = 'HexClaw BUG-011 Test'
const bundleIdentifier = 'com.hexclaw.desktop.bug-20260723-011'
const targetSelector = '[data-testid="weekly-practice-m-eq"]'
const k12Agent = 'k12-bug-20260723-011-ming'
const chatSession = 'k12-bug-20260723-011-session'
const fixtureNow = '2026-07-20T00:00:00+08:00'
const commandTimeoutMs = 20 * 60 * 1000
const sleep = (milliseconds) =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds))

const styleKeys = [
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
]

const layoutStyleKeys = [
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
]

const sourceConfig = {
  general: {
    language: 'zh-CN',
    log_level: 'info',
    data_dir: '',
    auto_start: false,
    defaultAgentRole: k12Agent,
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
    default: 'fixture/fixture-model',
    defaultModel: 'fixture-model',
    defaultProviderId: 'fixture',
    routing: { enabled: false, strategy: 'cost-aware' },
    cache: { enabled: false },
    providers: [
      {
        id: 'fixture',
        name: 'Isolated Fixture',
        type: 'openai',
        enabled: true,
        apiKey: 'fixture-redacted',
        baseUrl: 'http://127.0.0.1/never-used',
        models: [
          {
            id: 'fixture-model',
            name: 'fixture-model',
            capabilities: ['text'],
          },
        ],
      },
    ],
  },
}

const weeklyPlan = {
  plan_id: 'weekly-bug-20260723-011-2026-30',
  agent: k12Agent,
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
  created_at: fixtureNow,
  updated_at: fixtureNow,
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function sha256File(file) {
  return sha256(readFileSync(file))
}

function runCommand(command, args, options = {}) {
  return new Promise((resolveCommand, rejectCommand) => {
    process.stdout.write(`\n[bug011-native] ${command} ${args.join(' ')}\n`)
    const child = spawn(command, args, {
      cwd: options.cwd || repoRoot,
      env: options.env || process.env,
      stdio: 'inherit',
    })
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      rejectCommand(new Error(`Command timed out: ${command} ${args.join(' ')}`))
    }, options.timeoutMs || commandTimeoutMs)
    child.once('error', (error) => {
      clearTimeout(timer)
      rejectCommand(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      if (code === 0) resolveCommand()
      else {
        rejectCommand(new Error(`Command failed (${code ?? signal}): ${command} ${args.join(' ')}`))
      }
    })
  })
}

async function reserveLoopbackPort() {
  const server = createServer()
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const port = address.port
  await new Promise((resolveClose) => server.close(resolveClose))
  assert.notEqual(port, 16060)
  assert.notEqual(port, 11434)
  return port
}

function jsonResponse(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Origin': '*',
    'Content-Length': Buffer.byteLength(body),
    'Content-Type': 'application/json; charset=utf-8',
  })
  response.end(body)
}

async function readJSONBody(request) {
  const chunks = []
  let length = 0
  for await (const chunk of request) {
    length += chunk.length
    if (length > 1024 * 1024) throw new Error('fixture body exceeds 1 MiB')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

function createLoopbackFixture(port) {
  const state = {
    reports: [],
    command: 'WAIT',
    updaterRequests: 0,
    unexpectedRequests: [],
  }
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', `http://127.0.0.1:${port}`)
      if (request.method === 'OPTIONS') {
        response.writeHead(204, {
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
          'Access-Control-Allow-Origin': '*',
        })
        response.end()
        return
      }
      if (request.method === 'POST' && url.pathname === '/__bug011_native__/report') {
        state.reports.push(await readJSONBody(request))
        jsonResponse(response, 200, { ok: true })
        return
      }
      if (request.method === 'GET' && url.pathname === '/__bug011_native__/command') {
        jsonResponse(response, 200, { command: state.command })
        return
      }
      if (request.method === 'GET' && url.pathname === '/updater') {
        state.updaterRequests += 1
        response.writeHead(204, { 'Access-Control-Allow-Origin': '*' })
        response.end()
        return
      }
      state.unexpectedRequests.push(`${request.method} ${url.pathname}`)
      jsonResponse(response, 404, { error: 'unexpected fixture request' })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      state.unexpectedRequests.push(`fixture-error:${message}`)
      jsonResponse(response, 500, { error: 'fixture failure' })
    }
  })
  return {
    state,
    origin: `http://127.0.0.1:${port}`,
    async listen() {
      await new Promise((resolveListen, rejectListen) => {
        server.once('error', rejectListen)
        server.listen(port, '127.0.0.1', resolveListen)
      })
    },
    async close() {
      if (!server.listening) return
      await new Promise((resolveClose) => server.close(resolveClose))
    },
  }
}

function renderConfig(sandbox, sidecarPort, fixtureOrigin) {
  return `server:
  host: 127.0.0.1
  port: ${sidecarPort}
  mode: development
platforms:
  web:
    enabled: true
llm:
  default: fixture
  providers:
    fixture:
      api_key: local-fixture-only
      base_url: ${fixtureOrigin}/v1
      model: fixture-model
      models:
        - fixture-model
      compatible: openai
      tools_enabled: false
      enabled: true
  routing:
    enabled: false
  cache:
    enabled: false
  tools:
    enabled: "off"
storage:
  driver: sqlite
  sqlite:
    path: ${JSON.stringify(join(sandbox, '.hexclaw/data.db'))}
knowledge:
  enabled: false
  embedding:
    disable_auto_install: true
memory:
  long_term:
    enabled: false
  vector:
    enabled: false
file_memory:
  enabled: false
heartbeat:
  enabled: false
mcp:
  enabled: false
skills:
  enabled: false
  auto_load: false
router:
  enabled: false
voice:
  enabled: false
observe:
  log_level: info
  metrics:
    enabled: false
`
}

function sourceReceipt() {
  const paths = {
    weeklyPanel: 'src/features/k12/components/K12WeeklyPracticePanel.vue',
    globalCss: 'src/assets/styles/global.css',
    browserGate: 'tests/e2e/bug-20260723-011-resource-row-visual.spec.ts',
    packageJson: 'package.json',
    pnpmLock: 'pnpm-lock.yaml',
    tauriConfig: 'src-tauri/tauri.conf.json',
    cargoLock: 'src-tauri/Cargo.lock',
  }
  return {
    gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim(),
    gitStatusSha256: sha256(
      execFileSync('git', ['status', '--porcelain=v1'], { cwd: repoRoot, encoding: 'utf8' }),
    ),
    files: Object.fromEntries(
      Object.entries(paths).map(([name, file]) => [name, sha256File(join(repoRoot, file))]),
    ),
  }
}

function renderWebViewFixture(fixtureOrigin, provenance) {
  const fixture = {
    config: sourceConfig,
    weeklyPlan,
    agent: k12Agent,
    session: chatSession,
    now: fixtureNow,
  }
  return `;(function runBug011InstalledBoundary() {
  'use strict'
  const fixtureOrigin = ${JSON.stringify(fixtureOrigin)}
  const fixture = ${JSON.stringify(fixture)}
  const provenance = ${JSON.stringify(provenance)}
  const selector = ${JSON.stringify(targetSelector)}
  const styleKeys = ${JSON.stringify(styleKeys)}
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim()
  const post = async (payload) => {
    const response = await fetch(fixtureOrigin + '/__bug011_native__/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!response.ok) throw new Error('fixture report failed: ' + response.status)
  }
  const reportFixtureError = (error) => {
    const message = error instanceof Error ? [error.name + ': ' + error.message, error.stack].filter(Boolean).join('\\n') : String(error)
    void post({ stage: 'fixture-error', message }).catch(() => {})
  }
  addEventListener('error', (event) => reportFixtureError(event.error || event.message))
  addEventListener('unhandledrejection', (event) => reportFixtureError(event.reason))
  const waitFor = async (read, label, timeout = 45000) => {
    const deadline = Date.now() + timeout
    let lastError
    while (Date.now() < deadline) {
      try {
        const value = await read()
        if (value) return value
      } catch (error) {
        lastError = error
      }
      await sleep(80)
    }
    throw new Error('timed out waiting for ' + label + (lastError ? ': ' + lastError : ''))
  }
  const settle = async () => {
    if ('fonts' in document) await document.fonts.ready
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  }
  const response = (value, status = 200) => new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
  const apiResponse = (method, rawPath) => {
    const url = new URL(rawPath, 'http://sidecar.invalid')
    const path = url.pathname
    if (path === '/health') return response({ status: 'healthy' })
    if (path === '/api/v1/config') return response(fixture.config)
    if (path === '/api/v1/config/llm') return response(fixture.config.llm)
    if (path === '/api/v1/ollama/status') return response({ running: false, associated: false, models: [] })
    if (path === '/api/v1/assistant/soul') return response({ system_prompt: '', is_custom: false, default_prompt: '' })
    if (path === '/api/v1/agents' && method === 'GET') return response({
      agents: [{
        name: fixture.agent,
        display_name: '小明的辅导助手',
        description: '五年级下 · 各学科教材独立绑定',
        provider: 'fixture',
        model: 'fixture-model',
        metadata: {
          scenario: 'k12-tutor',
          avatar: '🎓',
          'k12.child_name': '小明',
          'k12.learner_id': 'learner-bug-20260723-011-ming',
          'k12.grade_term': '五年级下',
          'k12.textbook_edition': '人教版',
          'k12.textbook_edition.math': '人教版',
        },
      }],
      total: 1,
      default: fixture.agent,
    })
    if (path === '/api/v1/agents/rules') return response({ rules: [], total: 0 })
    if (path === '/api/v1/roles') return response({ roles: [], total: 0 })
    if (path === '/api/v1/skills') return response({ skills: [], items: [], total: 0 })
    if (path === '/api/v1/prompts' || path === '/api/v1/prompts/all') return response({ prompts: [], total: 0 })
    if (path === '/api/v1/sessions' && method === 'GET') return response({
      sessions: [{
        id: fixture.session,
        title: '小明的辅导助手',
        user_id: 'desktop-user',
        agent_name: fixture.agent,
        created_at: fixture.now,
        updated_at: fixture.now,
        message_count: 0,
      }],
      total: 1,
    })
    if (path === '/api/v1/sessions/' + fixture.session + '/messages') return response({ messages: [], total: 0 })
    if (path === '/api/v1/sessions/' + fixture.session + '/branches') return response({ branches: [], total: 0 })
    if (path === '/api/v1/messages/search') return response({ results: [], total: 0, query: '' })
    if (path === '/api/v1/streams/active') return response({ streams: [] })
    if (path === '/api/v1/knowledge/documents') return response({ documents: [], total: 0, limit: 50, offset: 0, sources: [] })
    if (path === '/api/v1/connections') return response({ connections: [] })
    if (path === '/api/v1/platforms/instances') return response({ instances: [] })
    if (path === '/api/v1/images/status' || path === '/api/v1/videos/status' || path === '/api/v1/voicechat/status') return response({ available: false, models: [] })
    if (path === '/api/k12/view-descriptor') return response({
      header_tabs: ['辅导', '学习档案', '学情'],
      message_badges: [],
      composer_placeholder: '拍照或输入题目',
      composer_chips: ['自动识别学科', '渐进提示', '识题校验'],
      record_collections: [],
      side_panels: [],
      actions: [],
      i18n_keys: [],
      schema_version: 1,
    })
    if (path === '/api/k12/curriculum-progress') return response({
      progress: {
        progress_id: 'progress-bug-20260723-011',
        agent: fixture.agent,
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
        confirmed_at: fixture.now,
        created_at: fixture.now,
        updated_at: fixture.now,
      },
    })
    if (path === '/api/k12/textbook-binding-options') return response({ items: [] })
    if (path === '/api/k12/weekly-practice/settings') return response({
      agent: fixture.agent,
      revision: 7,
      timezone: 'Asia/Shanghai',
      due_review_enabled: true,
      textbook_consolidation_enabled: false,
      textbook_consolidation_tier: 'standard',
      arithmetic_warmup_enabled: false,
      arithmetic_minutes: 2,
      created_at: fixture.now,
      updated_at: fixture.now,
    })
    if (path === '/api/k12/weekly-practice/plans/current') return response({ plan: fixture.weeklyPlan })
    if (path === '/api/k12/weekly-practice/plans' && method === 'POST') return response({ plan: fixture.weeklyPlan, replayed: false }, 201)
    if (path === '/api/k12/weekly-practice/plans/history') return response({ items: [], next_cursor: null })
    if (path === '/api/k12/mistakes' || path === '/api/k12/review-queue') return response({ items: [] })
    if (path === '/api/k12/accumulation' || path === '/api/k12/accumulations') return response({ items: [] })
    if (path === '/api/k12/practice-sets' || path === '/api/k12/creative-works') return response({ items: [] })
    if (path === '/api/k12/insight-report') return response({ grade_term: '五年级下', trend: { total: 0, mastered: 0, reviewing: 0, retried: 0, archived: 0 }, weak_top3: [], consecutive_fail_kps: [], month_new_mistakes: 0, review_completion_rate: 0, week_pending: 0, practice_pending: 0, suggestion: '' })
    if (path === '/api/k12/study-time') return response({ days: [], total_records: 0, total_minutes: 0, note: '' })
    if (path.startsWith('/api/k12/')) return response({ items: [] })
    if (path.startsWith('/api/v1/')) return response({ items: [], total: 0 })
    return response({})
  }

  const nativeFetch = globalThis.fetch.bind(globalThis)
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href)
    if (url.origin === fixtureOrigin && (url.pathname === '/health' || url.pathname.startsWith('/api/'))) {
      const request = input instanceof Request ? input : new Request(url, init)
      return apiResponse(request.method.toUpperCase(), url.pathname + url.search)
    }
    return nativeFetch(input, init)
  }

  localStorage.clear()
  sessionStorage.clear()
  localStorage.setItem('hc-theme', 'light')
  localStorage.setItem('hexclaw:welcomeRedirectDone', '1')
  sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
  localStorage.setItem('hexclaw_lastSessionId', fixture.session)
  localStorage.setItem('app_config', JSON.stringify(fixture.config))
  localStorage.setItem('hc-k12-appearance-v1', JSON.stringify({ version: 1, preference: 'k12', introSeen: true }))
  localStorage.setItem('hexclaw_sessionAgents', JSON.stringify({ [fixture.session]: fixture.agent }))

  class FixtureWebSocket extends EventTarget {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSING = 2
    static CLOSED = 3
    CONNECTING = 0
    OPEN = 1
    CLOSING = 2
    CLOSED = 3
    binaryType = 'blob'
    bufferedAmount = 0
    extensions = ''
    protocol = ''
    readyState = 0
    onclose = null
    onerror = null
    onmessage = null
    onopen = null
    constructor(url) {
      super()
      this.url = String(url)
      queueMicrotask(() => {
        this.readyState = FixtureWebSocket.OPEN
        const event = new Event('open')
        if (this.onopen) this.onopen.call(this, event)
        this.dispatchEvent(event)
      })
    }
    close() { this.readyState = FixtureWebSocket.CLOSED }
    send() {}
  }
  globalThis.WebSocket = FixtureWebSocket

  let markedTarget = null
  const snapshot = () => {
    const target = document.querySelector(selector)
    if (!(target instanceof HTMLButtonElement)) return { found: false }
    const row = target.closest('.resource-row')
    const prompt = row?.querySelector(':scope > b, .weekly-item__prompt')
    const rect = target.getBoundingClientRect()
    const style = getComputedStyle(target)
    const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    const elementAtCenter = document.elementFromPoint(center.x, center.y)
    return {
      found: true,
      sameNode: target === markedTarget,
      hovered: target.matches(':hover'),
      connected: target.isConnected,
      identity: {
        tag: target.tagName,
        implicitRole: target.getAttribute('role') || 'button',
        type: target.type,
        text: clean(target.textContent),
        disabled: target.disabled,
        action: target.matches('[data-testid^="weekly-practice-"]') ? 'join-practice' : 'unknown',
        rowPrompt: clean(prompt?.textContent),
      },
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      hitTest: {
        center,
        targetAtCenter: elementAtCenter === target || target.contains(elementAtCenter),
        elementTag: elementAtCenter?.tagName || null,
        elementText: clean(elementAtCenter?.textContent),
        splashPresent: document.getElementById('splash-screen') !== null,
      },
      style: Object.fromEntries(styleKeys.map((key) => [key, style[key]])),
      viewport: {
        innerWidth,
        innerHeight,
        outerWidth,
        outerHeight,
        screenX,
        screenY,
        dpr: devicePixelRatio,
        locale: navigator.language,
      },
    }
  }

  const execute = async () => {
    if (document.readyState === 'loading') await new Promise((resolve) => addEventListener('DOMContentLoaded', resolve, { once: true }))
    await post({
      stage: 'bootstrap',
      isTauri: globalThis.isTauri === true,
      hasInternals: typeof globalThis.__TAURI_INTERNALS__?.invoke === 'function',
      provenance,
    })
    const tabs = await waitFor(() => document.querySelector('.k12enh-seg'), 'K12 route tabs')
    const records = await waitFor(
      () => Array.from(tabs.querySelectorAll('[role="tab"]')).find((node) => clean(node.textContent) === '学习档案'),
      'records tab',
    )
    records.click()
    const week = await waitFor(() => document.querySelector('[data-testid="subtab-week"]'), 'weekly subtab')
    week.click()
    const target = await waitFor(() => document.querySelector(selector), 'weekly practice target')
    target.scrollIntoView({ block: 'center', inline: 'nearest' })
    await settle()
    await waitFor(() => {
      if (document.getElementById('splash-screen')) return false
      const rect = target.getBoundingClientRect()
      const elementAtCenter = document.elementFromPoint(
        rect.x + rect.width / 2,
        rect.y + rect.height / 2,
      )
      return elementAtCenter === target || target.contains(elementAtCenter)
    }, 'target visually hittable after splash')
    await settle()
    markedTarget = target
    let afterPosted = false
    addEventListener('mousemove', () => {
      if (afterPosted || !markedTarget?.matches(':hover')) return
      afterPosted = true
      void settle().then(() => post({ stage: 'hover-after', snapshot: snapshot() })).catch(reportFixtureError)
    }, { capture: true })
    await post({ stage: 'target-ready', snapshot: snapshot(), provenance })
    await waitFor(async () => {
      const response = await nativeFetch(fixtureOrigin + '/__bug011_native__/command')
      const value = await response.json()
      return value.command === 'SNAPSHOT_BEFORE'
    }, 'native before command')
    await settle()
    await post({ stage: 'hover-before', snapshot: snapshot() })
  }
  void execute().catch(reportFixtureError)
})()
`
}

function prepareFrontend(sandbox, fixtureOrigin, provenance, offlineEnv) {
  const frontend = join(sandbox, 'frontend')
  execFileSync('pnpm', ['exec', 'vite', 'build', '--outDir', frontend, '--emptyOutDir'], {
    cwd: repoRoot,
    env: offlineEnv,
    stdio: 'inherit',
  })
  const indexPath = join(frontend, 'index.html')
  assert.ok(existsSync(indexPath), 'isolated Vite index.html is missing')
  const index = readFileSync(indexPath, 'utf8')
  const moduleEntry = index.match(
    /<script type="module" crossorigin src="\.\/assets\/([^"]+\.js)">/,
  )
  assert.ok(moduleEntry, 'isolated Vite module entry is missing')
  const modulePath = join(frontend, 'assets', moduleEntry[1])
  const moduleBefore = readFileSync(modulePath, 'utf8')
  const platformProbe = /function [A-Za-z_$][\w$]*\(\)\{return!!globalThis\.isTauri\}/g
  const matches = moduleBefore.match(platformProbe) || []
  assert.equal(matches.length, 1, 'isolated frontend must contain one platform probe')
  assert.ok(
    moduleBefore.includes('http://localhost:16060'),
    'isolated frontend API base is missing',
  )
  const fixtureName = 'bug-20260723-011-installed-fixture.js'
  const fixtureSource = renderWebViewFixture(fixtureOrigin, provenance)
  const fixturePath = join(frontend, fixtureName)
  writeFileSync(fixturePath, fixtureSource, { mode: 0o600 })
  const moduleAfter = moduleBefore
    .replace(platformProbe, (match) => match.replace('return!!globalThis.isTauri', 'return!1'))
    .replaceAll('http://localhost:16060', fixtureOrigin)
  writeFileSync(modulePath, moduleAfter, { mode: 0o600 })
  writeFileSync(
    indexPath,
    index.replace('<head>', `<head>\n<script src="./${fixtureName}"></script>`),
    {
      mode: 0o600,
    },
  )
  return {
    frontend,
    receipt: {
      indexBeforeSHA256: sha256(index),
      indexAfterSHA256: sha256File(indexPath),
      moduleEntry: moduleEntry[1],
      moduleBeforeSHA256: sha256(moduleBefore),
      moduleAfterSHA256: sha256(moduleAfter),
      fixtureSHA256: sha256(fixtureSource),
    },
  }
}

function writeOverlay(sandbox, frontend, sidecarPort, fixtureOrigin) {
  const overlayPath = join(sandbox, 'tauri.bug011-installed.conf.json')
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "style-src-attr 'unsafe-inline'",
    `img-src 'self' data: blob: http://localhost:${sidecarPort} http://127.0.0.1:${sidecarPort}`,
    `media-src 'self' data: blob: http://localhost:${sidecarPort} http://127.0.0.1:${sidecarPort}`,
    `connect-src 'self' http://localhost:${sidecarPort} ws://localhost:${sidecarPort} http://127.0.0.1:${sidecarPort} ws://127.0.0.1:${sidecarPort} ${fixtureOrigin}`,
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ')
  const overlay = {
    productName,
    identifier: bundleIdentifier,
    build: { frontendDist: relative(srcTauriDir, frontend), beforeBuildCommand: '' },
    app: {
      windows: [
        {
          label: 'main',
          title: productName,
          width: 1280,
          height: 820,
          minWidth: 900,
          minHeight: 600,
          center: true,
          visible: true,
        },
      ],
      security: { csp },
    },
    bundle: { targets: ['app'], createUpdaterArtifacts: false },
    plugins: {
      updater: {
        endpoints: [`${fixtureOrigin}/updater`],
        dangerousInsecureTransportProtocol: true,
      },
    },
  }
  writeFileSync(overlayPath, `${JSON.stringify(overlay, null, 2)}\n`, { mode: 0o600 })
  return overlayPath
}

function listenerPIDs(port) {
  try {
    return execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
      encoding: 'utf8',
    })
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number)
      .filter(Number.isFinite)
  } catch {
    return []
  }
}

async function waitForHealth(port, processHandle) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) throw new Error('Test.app exited before Sidecar health')
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1_500),
      })
      if (response.ok) return
    } catch {
      // Sidecar is still starting.
    }
    await sleep(250)
  }
  throw new Error(`Sidecar health timed out on loopback port ${port}`)
}

async function waitForReport(state, stage, timeout = 60_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const report = state.reports.find((entry) => entry.stage === stage)
    if (report) return report
    const error = state.reports.find((entry) => entry.stage === 'fixture-error')
    if (error) throw new Error(`WKWebView fixture failed: ${error.message}`)
    await sleep(100)
  }
  throw new Error(`timed out waiting for WKWebView report: ${stage}`)
}

async function stopProcess(processHandle) {
  if (!processHandle || processHandle.exitCode !== null) return
  processHandle.kill('SIGTERM')
  const exited = await Promise.race([
    new Promise((resolveExit) => processHandle.once('exit', () => resolveExit(true))),
    sleep(5_000).then(() => false),
  ])
  if (!exited && processHandle.exitCode === null) {
    processHandle.kill('SIGKILL')
    await new Promise((resolveExit) => processHandle.once('exit', resolveExit))
  }
}

async function stopOwnedSidecar(port, bundle) {
  const stopped = []
  for (const pid of listenerPIDs(port)) {
    const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
    }).trim()
    if (!command.includes(`${bundle}/Contents/MacOS/hexclaw serve --desktop`)) {
      throw new Error(`dedicated port ${port} has unexpected owner ${pid}: ${command}`)
    }
    process.kill(pid, 'SIGTERM')
    stopped.push(pid)
  }
  const deadline = Date.now() + 10_000
  while (listenerPIDs(port).length && Date.now() < deadline) await sleep(100)
  assert.deepEqual(listenerPIDs(port), [], `Sidecar remains on dedicated port ${port}`)
  return stopped
}

function windowInfoForPID(pid) {
  const swift = `
import Foundation
import CoreGraphics
let target: Int32 = ${Number(pid)}
let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
for row in rows {
  let owner = (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value ?? -1
  let layer = (row[kCGWindowLayer as String] as? NSNumber)?.intValue ?? -1
  let alpha = (row[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 0
  if owner == target && layer == 0 && alpha > 0,
     let id = (row[kCGWindowNumber as String] as? NSNumber)?.intValue,
     let bounds = row[kCGWindowBounds as String] as? [String: Any],
     let x = (bounds["X"] as? NSNumber)?.doubleValue,
     let y = (bounds["Y"] as? NSNumber)?.doubleValue,
     let width = (bounds["Width"] as? NSNumber)?.doubleValue,
     let height = (bounds["Height"] as? NSNumber)?.doubleValue {
    print("\\(id)|\\(x)|\\(y)|\\(width)|\\(height)")
    break
  }
}
`
  const output = execFileSync('/usr/bin/swift', ['-e', swift], { encoding: 'utf8' }).trim()
  assert.ok(output, `no visible native window found for PID ${pid}`)
  const [id, x, y, width, height] = output.split('|').map(Number)
  assert.ok([id, x, y, width, height].every(Number.isFinite), `invalid window info: ${output}`)
  return { id, x, y, width, height }
}

function captureWindow(pid, destination) {
  const window = windowInfoForPID(pid)
  execFileSync('/usr/sbin/screencapture', ['-x', '-l', String(window.id), destination])
  assert.ok(existsSync(destination), `native screenshot missing: ${destination}`)
  assert.ok(statSync(destination).size > 1024, `native screenshot is empty: ${destination}`)
  return { ...window, bytes: statSync(destination).size, sha256: sha256File(destination) }
}

function captureScreenRect(rect, destination) {
  const x = Math.floor(rect.x)
  const y = Math.floor(rect.y)
  const width = Math.ceil(rect.x + rect.width) - x
  const height = Math.ceil(rect.y + rect.height) - y
  execFileSync('/usr/sbin/screencapture', ['-x', `-R${x},${y},${width},${height}`, destination])
  assert.ok(existsSync(destination), `target screenshot missing: ${destination}`)
  assert.ok(statSync(destination).size > 128, `target screenshot is empty: ${destination}`)
  return { x, y, width, height, bytes: statSync(destination).size, sha256: sha256File(destination) }
}

function imageDimensions(file) {
  const output = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file], {
    encoding: 'utf8',
  })
  return {
    width: Number(output.match(/pixelWidth:\s*(\d+)/)?.[1]),
    height: Number(output.match(/pixelHeight:\s*(\d+)/)?.[1]),
  }
}

function compileMouseDriver(sandbox) {
  const source = join(sandbox, 'mouse-driver.swift')
  const executable = join(sandbox, 'mouse-driver')
  writeFileSync(
    source,
    `import AppKit
import ApplicationServices
import CoreGraphics
let pid = Int32(CommandLine.arguments[1])!
let x = Double(CommandLine.arguments[2])!
let y = Double(CommandLine.arguments[3])!
NSRunningApplication(processIdentifier: pid)?.activate(options: [.activateAllWindows])
let point = CGPoint(x: x, y: y)
CGWarpMouseCursorPosition(point)
CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
print("trusted=\\(AXIsProcessTrusted())|x=\\(x)|y=\\(y)")
`,
    { mode: 0o600 },
  )
  execFileSync('/usr/bin/swiftc', [source, '-o', executable], { stdio: 'inherit' })
  chmodSync(executable, 0o700)
  return executable
}

function moveMouse(driver, pid, x, y) {
  return execFileSync(driver, [String(pid), String(x), String(y)], { encoding: 'utf8' }).trim()
}

function differences(before, after, keys) {
  return keys.flatMap((field) =>
    before[field] === after[field] ? [] : [{ field, before: before[field], after: after[field] }],
  )
}

function rectDelta(before, after) {
  return {
    x: after.x - before.x,
    y: after.y - before.y,
    width: after.width - before.width,
    height: after.height - before.height,
  }
}

function sanitizeLog(raw, sandbox) {
  return raw.replaceAll(repoRoot, '<repo>').replaceAll(sandbox, '<test-home>')
}

function updateBrowserSummary(nativeStatus, nativeEvidence, reason) {
  const installedApplication = {
    status: nativeStatus,
    evidence: '../native/installed-summary.json',
    reason,
    applicationsTouched: false,
    userDataTouched: false,
    executableSha256: nativeEvidence?.app?.executableSHA256 || null,
  }
  const summaryPath = join(browserEvidenceRoot, 'summary.json')
  if (existsSync(summaryPath)) {
    const summary = JSON.parse(readFileSync(summaryPath, 'utf8'))
    summary.installedApplication = {
      ...installedApplication,
      evidence: 'native/installed-summary.json',
    }
    writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`)
  }
  for (const browser of ['chromium', 'webkit']) {
    const statusPath = join(browserEvidenceRoot, browser, 'status.json')
    if (!existsSync(statusPath)) continue
    const status = JSON.parse(readFileSync(statusPath, 'utf8'))
    status.installedApplication = installedApplication
    writeFileSync(statusPath, `${JSON.stringify(status, null, 2)}\n`)
  }
  const readmePath = join(browserEvidenceRoot, 'README.md')
  if (existsSync(readmePath)) {
    const readme = readFileSync(readmePath, 'utf8')
    const line = `- Installed application: **${nativeStatus}** — ${reason}`
    writeFileSync(
      readmePath,
      readme.match(/^- Installed application:.*$/m)
        ? readme.replace(/^- Installed application:.*$/m, line)
        : `${readme.trimEnd()}\n${line}\n`,
    )
  }
}

async function main() {
  assert.equal(process.platform, 'darwin', 'native hover boundary is macOS-only')
  rmSync(evidenceRoot, { recursive: true, force: true })
  mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 })
  const sandbox = mkdtempSync(join(tmpdir(), 'hexclaw-bug011-native.'))
  chmodSync(sandbox, 0o700)
  mkdirSync(join(sandbox, '.hexclaw'), { mode: 0o700 })
  mkdirSync(join(sandbox, 'tmp'), { mode: 0o700 })
  const cargoTarget = join(sandbox, 'cargo-target')
  const appBundle = join(cargoTarget, `release/bundle/macos/${productName}.app`)
  const fixturePort = await reserveLoopbackPort()
  const sidecarPort = await reserveLoopbackPort()
  assert.notEqual(fixturePort, sidecarPort)
  const fixture = createLoopbackFixture(fixturePort)
  const provenance = sourceReceipt()
  provenance.fixtureContractSHA256 = sha256(
    JSON.stringify({ sourceConfig, weeklyPlan, k12Agent, chatSession, fixtureNow }),
  )
  provenance.buildNonce = sha256(JSON.stringify(provenance)).slice(0, 24)
  let appProcess = null
  let appLog = null
  let appLogPath = ''
  let phase = 'PREFLIGHT'
  let fixtureInjected = false
  let finalStatus = 'BLOCKED'
  let finalReason = 'Native harness did not start.'
  let summary = null
  let cleanup = null

  try {
    await fixture.listen()
    const configPath = join(sandbox, '.hexclaw/hexclaw.yaml')
    writeFileSync(configPath, renderConfig(sandbox, sidecarPort, fixture.origin), { mode: 0o600 })
    chmodSync(configPath, 0o600)
    const offlineEnv = {
      ...process.env,
      CARGO_NET_OFFLINE: 'true',
      CARGO_TARGET_DIR: cargoTarget,
      GOENV: 'off',
      GOPROXY: 'off',
      GOSUMDB: 'off',
      PNPM_CONFIG_OFFLINE: 'true',
      npm_config_offline: 'true',
    }
    delete offlineEnv.GOROOT
    phase = 'BUILD_FRONTEND'
    const frontend = prepareFrontend(sandbox, fixture.origin, provenance, offlineEnv)
    phase = 'BUILD_TEST_APP'
    const overlay = writeOverlay(sandbox, frontend.frontend, sidecarPort, fixture.origin)
    await runCommand('pnpm', ['exec', 'tauri', 'build', '--config', overlay, '--bundles', 'app'], {
      env: offlineEnv,
    })
    const infoPlist = join(appBundle, 'Contents/Info.plist')
    const executable = join(appBundle, 'Contents/MacOS/hexclaw-desktop')
    const sidecarExecutable = join(appBundle, 'Contents/MacOS/hexclaw')
    assert.ok(existsSync(infoPlist), `unique Test.app missing: ${infoPlist}`)
    assert.ok(existsSync(executable), `unique Test.app executable missing: ${executable}`)
    assert.ok(
      existsSync(sidecarExecutable),
      `unique Test.app Sidecar missing: ${sidecarExecutable}`,
    )
    const identifier = execFileSync(
      'plutil',
      ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', infoPlist],
      { encoding: 'utf8' },
    ).trim()
    assert.equal(identifier, bundleIdentifier)
    assert.equal(statSync(sandbox).mode & 0o777, 0o700)
    assert.equal(statSync(configPath).mode & 0o777, 0o600)
    assert.deepEqual(
      listenerPIDs(sidecarPort),
      [],
      `dedicated Sidecar port ${sidecarPort} is occupied`,
    )

    phase = 'LAUNCH_TEST_APP'
    appLogPath = join(sandbox, 'app.log')
    appLog = createWriteStream(appLogPath, { flags: 'wx', mode: 0o600 })
    const runtimeEnv = {
      PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
      LANG: 'zh_CN.UTF-8',
      LC_ALL: 'zh_CN.UTF-8',
      HOME: sandbox,
      USERPROFILE: sandbox,
      CFFIXED_USER_HOME: sandbox,
      TMPDIR: join(sandbox, 'tmp'),
      TEMP: join(sandbox, 'tmp'),
      TMP: join(sandbox, 'tmp'),
      HEXCLAW_TEST_MODE: '1',
      HEXCLAW_TEST_HOME: sandbox,
      HEXCLAW_SIDECAR_PORT: String(sidecarPort),
      HEXCLAW_TEST_LLM_CONFIG_MODE: 'preseeded-owner-yaml',
      DINGTALK_LIVE_SEND: '0',
      NO_PROXY: '*',
      no_proxy: '*',
    }
    appProcess = spawn(executable, [], {
      cwd: sandbox,
      env: runtimeEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    appProcess.stdout.pipe(appLog, { end: false })
    appProcess.stderr.pipe(appLog, { end: false })
    await waitForHealth(sidecarPort, appProcess)
    const window = windowInfoForPID(appProcess.pid)
    const bootstrap = await waitForReport(fixture.state, 'bootstrap')
    assert.equal(bootstrap.isTauri, true)
    assert.deepEqual(bootstrap.provenance, provenance)
    const targetReady = await waitForReport(fixture.state, 'target-ready')
    fixtureInjected = true
    assert.equal(targetReady.snapshot.identity.text, '加入练习集')
    assert.equal(targetReady.snapshot.identity.rowPrompt, '解方程 2x+15=43')
    assert.equal(targetReady.snapshot.identity.disabled, false)
    const mouseDriver = compileMouseDriver(sandbox)
    const safePoint = { x: window.x + 16, y: window.y + 12 }
    const safeMoveReceipt = moveMouse(mouseDriver, appProcess.pid, safePoint.x, safePoint.y)
    await sleep(250)
    fixture.state.command = 'SNAPSHOT_BEFORE'
    const before = await waitForReport(fixture.state, 'hover-before')
    assert.equal(before.snapshot.hovered, false, 'target must not be hovered before physical move')
    assert.equal(before.snapshot.sameNode, true)

    const viewport = before.snapshot.viewport
    const contentInsetX = (window.width - viewport.innerWidth) / 2
    const contentInsetY = window.height - viewport.innerHeight
    const targetScreenRect = {
      x: window.x + contentInsetX + before.snapshot.rect.x,
      y: window.y + contentInsetY + before.snapshot.rect.y,
      width: before.snapshot.rect.width,
      height: before.snapshot.rect.height,
    }
    const beforeWindow = captureWindow(
      appProcess.pid,
      join(evidenceRoot, 'installed-before-hover.png'),
    )
    const beforeTarget = captureScreenRect(
      targetScreenRect,
      join(evidenceRoot, 'installed-target-before-hover.png'),
    )

    phase = 'PHYSICAL_HOVER'
    const centerX = targetScreenRect.x + targetScreenRect.width / 2
    const centerY = targetScreenRect.y + targetScreenRect.height / 2
    const offsets = [0, -2, 2, -6, 6, -10, 10, -14, 14, -18, 18, -22, 22, 26, -26, 30, -30]
    const moveReceipts = []
    let after = null
    for (const offset of offsets) {
      moveReceipts.push(moveMouse(mouseDriver, appProcess.pid, centerX, centerY + offset))
      const deadline = Date.now() + 500
      while (Date.now() < deadline) {
        after = fixture.state.reports.find((entry) => entry.stage === 'hover-after') || null
        if (after) break
        await sleep(50)
      }
      if (after) break
    }
    if (!after) {
      throw new Error(
        'physical CGEvent mouse move did not produce :hover in the injected WKWebView',
      )
    }
    assert.equal(after.snapshot.hovered, true)
    assert.equal(after.snapshot.sameNode, true)
    assert.equal(after.snapshot.connected, true)
    const afterWindow = captureWindow(
      appProcess.pid,
      join(evidenceRoot, 'installed-after-hover.png'),
    )
    const afterTarget = captureScreenRect(
      targetScreenRect,
      join(evidenceRoot, 'installed-target-after-hover.png'),
    )

    const delta = rectDelta(before.snapshot.rect, after.snapshot.rect)
    const layoutChanges = differences(before.snapshot.style, after.snapshot.style, layoutStyleKeys)
    const computedStyleChanges = differences(before.snapshot.style, after.snapshot.style, styleKeys)
    assert.deepEqual(delta, { x: 0, y: 0, width: 0, height: 0 })
    assert.deepEqual(layoutChanges, [])
    assert.deepEqual(after.snapshot.identity, before.snapshot.identity)
    assert.equal(after.snapshot.identity.tag, 'BUTTON')
    assert.equal(after.snapshot.identity.action, 'join-practice')
    assert.deepEqual(fixture.state.unexpectedRequests, [])

    const hoverEvidence = {
      before: before.snapshot,
      after: after.snapshot,
      rectDelta: delta,
      layoutStyleChanges: layoutChanges,
      computedStyleChanges,
      domIdentityStable: true,
      physicalHover: {
        method: 'CGEvent.mouseMoved via isolated Swift driver',
        safeMoveReceipt,
        moveReceipts,
        targetScreenRect,
      },
    }
    writeFileSync(
      join(evidenceRoot, 'installed-hover-dom-style.json'),
      `${JSON.stringify(hoverEvidence, null, 2)}\n`,
      { mode: 0o600 },
    )

    summary = {
      schemaVersion: 1,
      bug: 'BUG-20260723-011',
      status: 'PASS',
      conclusion: 'REAL_WKWEBVIEW_HOVER_STABLE',
      app: {
        productName,
        identifier,
        bundle: relative(repoRoot, appBundle),
        executableSHA256: sha256File(executable),
        sidecarSHA256: sha256File(sidecarExecutable),
        infoPlistSHA256: sha256File(infoPlist),
        nativeWindow: true,
        realWKWebView: true,
      },
      provenance: {
        source: provenance,
        frontend: frontend.receipt,
        runtimeReceiptMatched: true,
      },
      fixture: {
        selector: targetSelector,
        semanticState: '解方程 2x+15=43 / 加入练习集 / enabled',
        injectedIntoBundledWKWebView: true,
      },
      hover: hoverEvidence,
      screenshots: {
        beforeWindow: {
          ...beforeWindow,
          dimensions: imageDimensions(join(evidenceRoot, 'installed-before-hover.png')),
        },
        afterWindow: {
          ...afterWindow,
          dimensions: imageDimensions(join(evidenceRoot, 'installed-after-hover.png')),
        },
        beforeTarget: {
          ...beforeTarget,
          dimensions: imageDimensions(join(evidenceRoot, 'installed-target-before-hover.png')),
        },
        afterTarget: {
          ...afterTarget,
          dimensions: imageDimensions(join(evidenceRoot, 'installed-target-after-hover.png')),
        },
      },
      isolation: {
        testHomeMode: '0700',
        configMode: '0600',
        uniqueBundleIdentifier: true,
        sidecarPort,
        fixturePort,
        applicationsDirectoryTouched: false,
        realUserHomeRead: false,
        realUserHomeWritten: false,
        externalNetworkRequests: 0,
        realModelInvocations: 0,
        realIMInvocations: 0,
      },
      fixtureReceipts: fixture.state,
    }
    finalStatus = 'PASS'
    finalReason =
      'Current-worktree Test.app executed the homomorphic weekly fixture in a real WKWebView; physical hover preserved DOM identity, bbox, and layout styles.'
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    finalStatus = fixtureInjected ? 'RED' : 'BLOCKED'
    finalReason = `${phase}: ${message}`
    summary = {
      schemaVersion: 1,
      bug: 'BUG-20260723-011',
      status: finalStatus,
      conclusion: fixtureInjected ? 'REAL_WKWEBVIEW_HOVER_NOT_PASS' : 'FIXTURE_INJECTION_BLOCKED',
      reason: finalReason,
      provenance: { source: provenance },
      fixture: {
        selector: targetSelector,
        injectedIntoBundledWKWebView: fixtureInjected,
      },
      isolation: {
        testHomeMode: '0700',
        sidecarPort,
        fixturePort,
        applicationsDirectoryTouched: false,
        realUserHomeRead: false,
        realUserHomeWritten: false,
        externalNetworkRequests: 0,
        realModelInvocations: 0,
        realIMInvocations: 0,
      },
      fixtureReceipts: fixture.state,
    }
    throw error
  } finally {
    await stopProcess(appProcess)
    if (appLog) await new Promise((resolveEnd) => appLog.end(resolveEnd))
    let stoppedSidecars = []
    try {
      stoppedSidecars = await stopOwnedSidecar(sidecarPort, appBundle)
    } catch (error) {
      finalStatus = finalStatus === 'PASS' ? 'RED' : finalStatus
      finalReason = `${finalReason}; cleanup: ${error instanceof Error ? error.message : String(error)}`
    }
    await fixture.close()
    if (existsSync(appLogPath)) {
      writeFileSync(
        join(evidenceRoot, 'installed-app.log'),
        sanitizeLog(readFileSync(appLogPath, 'utf8'), sandbox),
        { mode: 0o600 },
      )
    }
    if (summary) {
      summary.status = finalStatus
      summary.reason = finalReason
      writeFileSync(
        join(evidenceRoot, 'installed-summary.json'),
        `${JSON.stringify(summary, null, 2)}\n`,
        { mode: 0o600 },
      )
    }
    rmSync(appBundle, { recursive: true, force: true })
    rmSync(sandbox, { recursive: true, force: true })
    cleanup = {
      status: finalStatus,
      appProcessStopped:
        !appProcess || appProcess.exitCode !== null || appProcess.signalCode !== null,
      sidecarPortReleased: listenerPIDs(sidecarPort).length === 0,
      fixtureClosed: true,
      uniqueAppBundleRemoved: !existsSync(appBundle),
      sandboxRemoved: !existsSync(sandbox),
      stoppedSidecars,
      applicationsDirectoryTouched: false,
      realUserDataTouched: false,
    }
    writeFileSync(
      join(evidenceRoot, 'installed-cleanup.json'),
      `${JSON.stringify(cleanup, null, 2)}\n`,
      { mode: 0o600 },
    )
    updateBrowserSummary(finalStatus, summary, finalReason)
  }

  assert.equal(finalStatus, 'PASS', finalReason)
  assert.equal(cleanup.sidecarPortReleased, true)
  assert.equal(cleanup.sandboxRemoved, true)
  process.stdout.write(
    `\nBUG-011 native Test.app hover PASS: ${relative(repoRoot, evidenceRoot)}\n`,
  )
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`)
  process.exitCode = 1
})
