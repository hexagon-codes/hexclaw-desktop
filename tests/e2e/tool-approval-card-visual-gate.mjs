import { chromium } from '@playwright/test'
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const ROOT = path.resolve(process.cwd())
const REFERENCE_URL = process.env.HEX_UI_REFERENCE_URL?.trim() || 'http://127.0.0.1:16070/app.html'
const SOURCE_URL = process.env.HEX_UI_SOURCE_URL?.trim() || 'http://127.0.0.1:16061'
const EVIDENCE_ROOT = path.resolve(
  ROOT,
  '../hexclaw-docs/test/evidence/tool-approval-card-visual-20260820/chromium',
)
const PIXEL_DIFF_TOOL = path.resolve(ROOT, 'tests/e2e/tools/visual_pixel_diff.py')
const PIXEL_DIFF_RUNTIME = process.env.HEX_UI_PIXEL_DIFF_RUNTIME?.trim() || 'uv'
const VIEWPORT = { width: 1440, height: 1000 }
const PIXEL_THRESHOLD = 8
const MAX_CHANGED_PIXEL_RATIO = 0.001
const NOW = '2026-08-20T14:00:00.000Z'
const FIXTURE_NOW = Date.parse(NOW)
const CHAT_SESSION = 'normal-main-tool-approval-visual'
const CRITICAL_STYLE_FIELDS = [
  'display',
  'boxSizing',
  'width',
  'height',
  'margin',
  'padding',
  'borderRadius',
  'backgroundColor',
  'color',
  'opacity',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'lineHeight',
  'gap',
]

const approvalIdentity = {
  requestId: 'approval-filesystem-write-001',
  sessionId: CHAT_SESSION,
  ownerId: 'desktop-user',
  invocationId: 'invocation-filesystem-write-001',
  toolName: 'filesystem.write_file',
  argumentsDigest: 'fixture-arguments-digest',
  securityScopeDigest: 'fixture-security-scope-digest',
  scopeSchemaVersion: 1,
  risk: 'sensitive',
  reason: '敏感操作：写入本地文件 `~/Desktop/report.md`。需要用户允许后继续。',
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

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

function runtimeFixture(apiPath, method) {
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
    return { agents: [], total: 0, default: '' }
  }
  if (apiPath === '/api/v1/agents/rules' || apiPath === '/api/v1/roles') {
    return { rules: [], total: 0 }
  }
  if (apiPath === '/api/v1/sessions' && method === 'GET') {
    return {
      sessions: [
        {
          id: CHAT_SESSION,
          title: '小数乘法讲解',
          user_id: approvalIdentity.ownerId,
          created_at: NOW,
          updated_at: NOW,
          message_count: 2,
        },
      ],
      total: 1,
    }
  }
  if (apiPath === `/api/v1/sessions/${CHAT_SESSION}/messages` && method === 'GET') {
    return {
      messages: [
        {
          id: 'user-math',
          role: 'user',
          content: '请解释 2.8 × 3.85。',
          timestamp: NOW,
          created_at: NOW,
        },
        {
          id: 'assistant-math',
          role: 'assistant',
          content: '把小数按整数相乘，再补回三位小数，最终结果是 **10.78**。',
          timestamp: NOW,
          created_at: NOW,
          metadata: { provider: 'openai', model: 'gpt-5.6-sol' },
        },
      ],
      total: 2,
    }
  }
  if (apiPath === `/api/v1/sessions/${CHAT_SESSION}/branches`) return { branches: [], total: 0 }
  if (apiPath === '/api/v1/streams/active') return { streams: [], total: 0 }
  if (apiPath === '/api/v1/skills') return { dir: '/tmp/fixture-skills', skills: [], total: 0 }
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
  if (apiPath.startsWith('/api/k12/')) return { items: [] }
  if (apiPath.startsWith('/api/v1/')) return { items: [], total: 0 }
  return {}
}

async function installSourceFixture(page) {
  await page.addInitScript(
    ({ config, session, now }) => {
      localStorage.clear()
      sessionStorage.clear()
      Date.now = () => now
      localStorage.setItem('hc-theme', 'light')
      localStorage.setItem('hexclaw:welcomeRedirectDone', '1')
      sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
      localStorage.setItem('hexclaw_lastSessionId', session)
      localStorage.setItem('app_config', JSON.stringify(config))
      ;(window).__approvalVisualErrors = []
      window.addEventListener('error', (event) => {
        window.__approvalVisualErrors.push(String(event.error ?? event.message))
      })
      window.addEventListener('unhandledrejection', (event) => {
        window.__approvalVisualErrors.push(String(event.reason))
      })

      const callbacks = new Map()
      let nextCallbackID = 1
      const desktopWindow = window
      const unregisterCallback = (id) => callbacks.delete(id)
      const transformCallback = (callback, once = false) => {
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
      desktopWindow.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
        unregisterListener: (_event, id) => unregisterCallback(id),
      }
    },
    { config: sourceConfig, session: CHAT_SESSION, now: FIXTURE_NOW },
  )

  await page.route('http://localhost:11434/**', (route) =>
    json(route, { models: [], version: 'tool-approval-visual-fixture' }),
  )
  await page.route('**/_hexclaw/**', (route) => {
    const requestURL = new URL(route.request().url())
    const apiPath = requestURL.pathname.replace(/^\/_hexclaw/, '')
    return json(route, runtimeFixture(apiPath, route.request().method()))
  })
}

async function settle(page, milliseconds = 220) {
  await page.evaluate(async () => {
    if ('fonts' in document) await document.fonts.ready
  })
  await page.waitForTimeout(milliseconds)
}

function assertThat(condition, message) {
  if (!condition) throw new Error(message)
}

async function openReference(page) {
  await page.goto(REFERENCE_URL, { waitUntil: 'domcontentloaded', timeout: 12_000 })
  await page.locator('.screen[data-pane="chat"]').waitFor({ state: 'visible', timeout: 5_000 })
  await page.evaluate(() => {
    window.openNormalChat?.()
    window.applyChatWorkspaceMode?.('sessions')
  })
  const card = page.locator('.approval-card[data-approval-request-id="approval-filesystem-write-001"]')
  await card.waitFor({ state: 'visible', timeout: 5_000 })
  await card.scrollIntoViewIfNeeded()
  await settle(page)
  return card
}

async function injectApproval(page) {
  await page.evaluate(
    async ({ identity, deadlineAt }) => {
      const dynamicImport = new Function('modulePath', 'return import(modulePath)')
      const module = await dynamicImport('/src/api/websocket.ts')
      module.hexclawWS.handleMessage(
        JSON.stringify({
          type: 'tool_approval_request',
          content: identity.reason,
          request_id: identity.requestId,
          owner_id: identity.ownerId,
          invocation_id: identity.invocationId,
          session_id: identity.sessionId,
          tool_name: identity.toolName,
          arguments: { path: '~/Desktop/report.md', content: '# report' },
          arguments_digest: identity.argumentsDigest,
          security_scope_digest: identity.securityScopeDigest,
          scope_schema_version: identity.scopeSchemaVersion,
          deadline_at: deadlineAt,
          metadata: { risk: identity.risk },
        }),
      )
    },
    { identity: approvalIdentity, deadlineAt: new Date(FIXTURE_NOW + 27_000).toISOString() },
  )
}

async function openSource(page) {
  await installSourceFixture(page)
  await page.goto(`${SOURCE_URL}/chat`, { waitUntil: 'domcontentloaded', timeout: 12_000 })
  await page.locator('.hc-chat').waitFor({ state: 'visible', timeout: 8_000 })
  await page.locator('.hc-msg').first().waitFor({ state: 'visible', timeout: 8_000 })
  await page.locator('#splash-screen').evaluate((node) => node.remove()).catch(() => undefined)
  assertThat(await page.locator('#splash-screen').count() === 0, 'Source startup splash still covers visual fixture')
  await injectApproval(page)
  const card = page.locator('.hc-approval').first()
  await card.waitFor({ state: 'visible', timeout: 5_000 })
  await card.scrollIntoViewIfNeeded()
  await settle(page)
  assertThat(
    await page.locator('.hc-chat:not(.hc-chat--conversation-only) .hc-approval--message-track').count() === 1,
    'Source fixture is not a normal main-session approval card on the approved message track',
  )
  const timer = await card.locator('.hc-approval__timer').innerText()
  assertThat(timer === '27s', `Source countdown drifted: ${timer}`)
  return card
}

async function readSourceIdentity(page) {
  return page.evaluate(async () => {
    const dynamicImport = new Function('modulePath', 'return import(modulePath)')
    const module = await dynamicImport('/src/stores/chat.ts')
    const pending = module.useChatStore().pendingApproval
    if (!pending) return null
    return {
      requestId: pending.requestId,
      sessionId: pending.sessionId,
      ownerId: pending.ownerId,
      invocationId: pending.invocationId,
      toolName: pending.toolName,
      argumentsDigest: pending.argumentsDigest,
      securityScopeDigest: pending.securityScopeDigest,
      scopeSchemaVersion: pending.scopeSchemaVersion,
      risk: pending.risk,
      reason: pending.reason,
      deadlineAt: pending.deadlineAt,
    }
  })
}

async function readReferenceIdentity(page) {
  return page.locator('.approval-card[data-approval-request-id="approval-filesystem-write-001"]').evaluate((card) => ({
    requestId: card.getAttribute('data-approval-request-id'),
    invocationId: card.getAttribute('data-approval-invocation-id'),
    state: card.getAttribute('data-approval-state'),
    ariaBusy: card.getAttribute('aria-busy'),
    toolName: card.querySelector('code')?.textContent?.trim() ?? '',
    reason: card.querySelector('.approval-card__head + div')?.textContent?.trim() ?? '',
    timer: card.querySelector('.approval-card__head span:last-child')?.textContent?.trim() ?? '',
  }))
}

async function collectGeometryAndStyles(page, targets) {
  return page.evaluate((input) => input.map(({ name, selector }) => {
    const node = document.querySelector(selector)
    if (!node) return { name, selector, present: false }
    const rect = node.getBoundingClientRect()
    const style = getComputedStyle(node)
    return {
      name,
      selector,
      present: true,
      bbox: {
        x: Number(rect.x.toFixed(2)),
        y: Number(rect.y.toFixed(2)),
        width: Number(rect.width.toFixed(2)),
        height: Number(rect.height.toFixed(2)),
      },
      style: {
        display: style.display,
        boxSizing: style.boxSizing,
        width: style.width,
        height: style.height,
        margin: style.margin,
        padding: style.padding,
        border: style.border,
        borderRadius: style.borderRadius,
        backgroundColor: style.backgroundColor,
        color: style.color,
        opacity: style.opacity,
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        lineHeight: style.lineHeight,
        gap: style.gap,
      },
      ariaBusy: node.getAttribute('aria-busy'),
      disabled: 'disabled' in node ? node.disabled : undefined,
      text: node.textContent?.trim() ?? '',
    }
  }), targets)
}

async function capture(page, selector, directory, prefix) {
  const card = page.locator(selector).first()
  await card.scrollIntoViewIfNeeded()
  const box = await card.boundingBox()
  assertThat(box, `Unable to measure ${prefix} approval card`)
  await card.screenshot({ path: path.join(directory, `${prefix}-card.png`), animations: 'disabled' })
  await page.screenshot({ path: path.join(directory, `${prefix}-page.png`), animations: 'disabled' })
  assertThat(await card.isVisible(), `${prefix} approval card disappeared during capture`)
  return {
    x: Number(box.x.toFixed(2)),
    y: Number(box.y.toFixed(2)),
    width: Number(box.width.toFixed(2)),
    height: Number(box.height.toFixed(2)),
  }
}

async function alignCaptureRasterOrigin(referencePage, sourcePage) {
  const [referenceTop, sourceTop] = await Promise.all([
    referencePage.locator('.approval-card[data-approval-request-id="approval-filesystem-write-001"]').evaluate((node) => node.getBoundingClientRect().top),
    sourcePage.locator('.hc-approval').evaluate((node) => node.getBoundingClientRect().top),
  ])
  const offset = (referenceTop - Math.floor(referenceTop)) - (sourceTop - Math.floor(sourceTop))
  const sourceTopApplied = await sourcePage.locator('.hc-approval').evaluate((node, delta) => {
    const currentTop = Number.parseFloat(getComputedStyle(node).top)
    const top = Number.isFinite(currentTop) ? currentTop + delta : delta
    node.style.position = 'relative'
    node.style.top = `${top}px`
    return top
  }, offset)
  return {
    referenceTop: Number(referenceTop.toFixed(2)),
    sourceTop: Number(sourceTop.toFixed(2)),
    sourceTopOffset: Number(offset.toFixed(2)),
    sourceTopApplied: Number(sourceTopApplied.toFixed(2)),
  }
}

function comparableTargets(kind) {
  if (kind === 'reference') {
    return [
      { name: 'card', selector: '.approval-card[data-approval-request-id="approval-filesystem-write-001"]' },
      { name: 'header', selector: '.approval-card__head' },
      { name: 'tool-name', selector: '.approval-card__head code' },
      { name: 'timer', selector: '.approval-card__head span:last-child' },
      { name: 'actions', selector: '.approval-actions' },
      { name: 'remember', selector: '.approval-actions .mini-check' },
      { name: 'remember-input', selector: '.approval-actions .mini-check input' },
      { name: 'deny', selector: '.approval-actions .btn:not(.btn-primary)' },
      { name: 'approve', selector: '.approval-actions .btn-primary' },
    ]
  }
  return [
    { name: 'card', selector: '.hc-approval' },
    { name: 'header', selector: '.hc-approval__header' },
    { name: 'tool-name', selector: '.hc-approval__header code' },
    { name: 'timer', selector: '.hc-approval__timer' },
    { name: 'actions', selector: '.hc-approval__actions' },
    { name: 'remember', selector: '.hc-approval__remember' },
    { name: 'remember-input', selector: '.hc-approval__remember input' },
    { name: 'deny', selector: '.hc-approval__btn--deny' },
    { name: 'approve', selector: '.hc-approval__btn--approve' },
  ]
}

function sameRect(left, right) {
  return left && right
    && Math.abs(left.x - right.x) < 0.01
    && Math.abs(left.y - right.y) < 0.01
    && Math.abs(left.width - right.width) < 0.01
    && Math.abs(left.height - right.height) < 0.01
}

function assertComparableCardPresentation(reference, implementation) {
  const referenceByName = new Map(reference.map((entry) => [entry.name, entry]))
  const implementationByName = new Map(implementation.map((entry) => [entry.name, entry]))
  const referenceCard = referenceByName.get('card')
  const implementationCard = implementationByName.get('card')
  assertThat(referenceCard?.present && implementationCard?.present, 'Approval card geometry is unavailable')

  for (const [name, referenceEntry] of referenceByName) {
    const implementationEntry = implementationByName.get(name)
    assertThat(implementationEntry?.present, `Implementation target is missing: ${name}`)
    for (const field of ['width', 'height']) {
      assertThat(
        Math.abs(referenceEntry.bbox[field] - implementationEntry.bbox[field]) < 0.01,
        `${name} ${field} drifted`,
      )
    }
    for (const field of ['x', 'y']) {
      const referenceOffset = referenceEntry.bbox[field] - referenceCard.bbox[field]
      const implementationOffset = implementationEntry.bbox[field] - implementationCard.bbox[field]
      assertThat(Math.abs(referenceOffset - implementationOffset) < 0.01, `${name} relative ${field} drifted`)
    }
    for (const field of CRITICAL_STYLE_FIELDS) {
      assertThat(
        referenceEntry.style[field] === implementationEntry.style[field],
        `${name} computed ${field} drifted`,
      )
    }
    assertThat(referenceEntry.ariaBusy === implementationEntry.ariaBusy, `${name} aria-busy drifted`)
    assertThat(referenceEntry.disabled === implementationEntry.disabled, `${name} disabled state drifted`)
  }
}

async function recordState({ id, referencePage, sourcePage }) {
  const directory = path.join(EVIDENCE_ROOT, id)
  await mkdir(directory, { recursive: true })
  const [referenceGeometry, sourceGeometry, referenceIdentity, sourceIdentity] = await Promise.all([
    collectGeometryAndStyles(referencePage, comparableTargets('reference')),
    collectGeometryAndStyles(sourcePage, comparableTargets('source')),
    readReferenceIdentity(referencePage),
    readSourceIdentity(sourcePage),
  ])
  assertComparableCardPresentation(referenceGeometry, sourceGeometry)
  const rasterOrigin = await alignCaptureRasterOrigin(referencePage, sourcePage)
  const [referenceCapture, sourceCapture] = await Promise.all([
    capture(
      referencePage,
      '.approval-card[data-approval-request-id="approval-filesystem-write-001"]',
      directory,
      'reference',
    ),
    capture(sourcePage, '.hc-approval', directory, 'implementation'),
  ])
  const diff = await execFileAsync(PIXEL_DIFF_RUNTIME, [
    'run',
    '--isolated',
    '--python',
    '3.12',
    '--with',
    'pillow==10.4.0',
    'python',
    PIXEL_DIFF_TOOL,
    path.join(directory, 'reference-card.png'),
    path.join(directory, 'implementation-card.png'),
    path.join(directory, 'pixel-diff.png'),
    String(PIXEL_THRESHOLD),
  ])
  const pixel = JSON.parse(diff.stdout)
  const entry = {
    id,
    viewport: { ...VIEWPORT, deviceScaleFactor: 1, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' },
    identity: { expected: approvalIdentity, reference: referenceIdentity, implementation: sourceIdentity },
    capture: { reference: referenceCapture, implementation: sourceCapture, rasterOrigin },
    pixel,
    visualStatus: pixel.changed_pixel_ratio <= MAX_CHANGED_PIXEL_RATIO ? 'PASS' : 'DRIFT',
    reference: referenceGeometry,
    implementation: sourceGeometry,
  }
  await writeFile(path.join(directory, 'geometry-and-styles.json'), `${JSON.stringify(entry, null, 2)}\n`)
  return entry
}

async function run() {
  await mkdir(EVIDENCE_ROOT, { recursive: true })
  const browser = await chromium.launch({ headless: true })
  const options = {
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    colorScheme: 'light',
    reducedMotion: 'reduce',
  }
  try {
    const referenceContext = await browser.newContext(options)
    const sourceContext = await browser.newContext(options)
    const referencePage = await referenceContext.newPage()
    const sourcePage = await sourceContext.newPage()

    const [referenceCard, sourceCard] = await Promise.all([
      openReference(referencePage),
      openSource(sourcePage),
    ])
    const pending = await recordState({
      id: 'pending',
      referencePage,
      sourcePage,
    })

    const sourceRectBefore = await sourceCard.boundingBox()
    await Promise.all([
      referenceCard.locator('.btn-primary').click(),
      sourceCard.locator('.hc-approval__btn--approve').click(),
    ])
    await sourceCard.locator('.hc-approval__btn--approve').waitFor({ state: 'visible' })
    await settle(referencePage, 420)
    await settle(sourcePage, 420)
    const sourceRectAfter = await sourceCard.boundingBox()
    assertThat(await referenceCard.getAttribute('data-approval-state') === 'awaiting_ack', 'Reference did not enter awaiting_ack')
    assertThat(await referenceCard.getAttribute('aria-busy') === 'true', 'Reference aria-busy did not become true')
    assertThat(await sourceCard.getAttribute('aria-busy') === 'true', 'Source aria-busy did not become true')
    assertThat(await sourceCard.locator('.hc-approval__btn--approve').isDisabled(), 'Source allow button remained enabled')
    assertThat(await sourceCard.locator('.hc-approval__btn--deny').isDisabled(), 'Source deny button remained enabled')
    assertThat(await sourceCard.locator('.hc-approval__remember input').isDisabled(), 'Source remember control remained enabled')
    assertThat(sameRect(sourceRectBefore, sourceRectAfter), 'Source card moved or resized while awaiting ACK')
    const sourceErrors = await sourcePage.evaluate(() => window.__approvalVisualErrors ?? [])
    assertThat(sourceErrors.length === 0, `Source reached an unhandled render error: ${sourceErrors.join('; ')}`)
    const awaitingAck = await recordState({
      id: 'awaiting-ack',
      referencePage,
      sourcePage,
    })

    const summary = {
      generatedAt: new Date().toISOString(),
      oracle: {
        reference: REFERENCE_URL,
        implementation: SOURCE_URL,
        visualScope: 'normal main-session ToolApprovalCard only; K12 and focus are excluded',
        network: 'all application API/model requests are route-fulfilled by fixture; approval arrives through mock wire',
      },
      states: [pending, awaitingAck],
      status: [pending, awaitingAck].every((state) => state.visualStatus === 'PASS') ? 'PASS' : 'DRIFT',
    }
    await writeFile(path.join(EVIDENCE_ROOT, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
    console.log(JSON.stringify(summary, null, 2))
    if (summary.status !== 'PASS') process.exitCode = 1
  } finally {
    await browser.close()
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.stack : error)
  process.exitCode = 1
})
