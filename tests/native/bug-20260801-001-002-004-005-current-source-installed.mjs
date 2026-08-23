#!/usr/bin/env node

/**
 * BUG-20260801-001/002/004/005 的 current-source 安装态第三腿。
 *
 * 只把当前 dist 复制到临时目录，在真实 Tauri/WKWebView 内注入确定性、离线
 * K12 fixture，并通过 loopback 回传 DOM/bbox/computed-style 事实。不会触碰
 * /Applications、真实 HOME、Provider、IM 或生产配置。
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
const evidenceRoot = join(
  docsRoot,
  'test/evidence/bug-20260801-001-002-004-005-current-source/native',
)
const fixturePath = join(
  repoRoot,
  'tests/fixtures/local/bug-20260801-001-002-004-005-business-fixture.json',
)
const productName = 'HexClaw K12 Topbar Test'
const bundleIdentifier = 'com.hexclaw.desktop.bug-20260801-001-002-004-005'
const commandTimeoutMs = 15 * 60 * 1000
const sleep = (milliseconds) =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds))

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function sha256Text(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function sha256Tree(root) {
  const entries = []
  const visit = (current, prefix = '') => {
    for (const name of readdirSync(current).sort()) {
      const absolutePath = join(current, name)
      const relativePath = prefix ? `${prefix}/${name}` : name
      const info = statSync(absolutePath)
      if (info.isDirectory()) visit(absolutePath, relativePath)
      else entries.push({ path: relativePath, sha256: sha256File(absolutePath) })
    }
  }
  visit(root)
  return sha256Text(JSON.stringify(entries))
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    )
  }
  return value
}

function runCommand(command, args, options = {}) {
  return new Promise((resolveCommand, rejectCommand) => {
    process.stdout.write(`\n[k12-topbar-installed] ${command} ${args.join(' ')}\n`)
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
      else
        rejectCommand(new Error(`Command failed (${code ?? signal}): ${command} ${args.join(' ')}`))
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
    if (length > 2 * 1024 * 1024) throw new Error('fixture body exceeds 2 MiB')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

function fixtureData() {
  return JSON.parse(readFileSync(fixturePath, 'utf8'))
}

const sourceReceiptPaths = [
  'src/features/k12/appearance/K12GlobalPresentation.vue',
  'src/features/k12/views/K12ChatEnhancement.vue',
  'src/features/k12/views/K12RecordsView.vue',
  'src/views/SettingsView.vue',
]

function gitValue(args) {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

function sourceProvenance() {
  return {
    repository: 'hexclaw-desktop',
    head: gitValue(['rev-parse', 'HEAD']),
    worktreeStatus: gitValue(['status', '--porcelain', '--untracked-files=no']),
    files: sourceReceiptPaths.map((relativePath) => {
      const absolutePath = join(repoRoot, relativePath)
      return { path: relativePath, sha256: sha256File(absolutePath) }
    }),
  }
}

function fixtureReceipt(data) {
  const state = {
    fixtureId: data.fixtureId,
    schemaVersion: data.schemaVersion,
    locale: data.locale,
    reducedMotion: data.reducedMotion,
    now: data.now,
    appearance: data.appearance,
    agents: data.agents,
    sessions: data.sessions,
    pinnedSessionIds: data.pinnedSessionIds,
    mistakes: data.mistakes,
    insightReport: data.insightReport,
  }
  return {
    path: relative(repoRoot, fixturePath),
    sha256: sha256File(fixturePath),
    stateSha256: sha256Text(JSON.stringify(canonicalize(state))),
    state,
  }
}

function createFixture(port, data) {
  const state = {
    reports: [],
    unexpectedRequests: [],
    chatRequests: 0,
    externalRequests: 0,
    captureAcks: new Set(),
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
      if (request.method === 'POST' && url.pathname === '/__k12_topbar__/report') {
        state.reports.push(await readJSONBody(request))
        jsonResponse(response, 200, { ok: true })
        return
      }
      if (request.method === 'GET' && url.pathname === '/__k12_topbar__/capture-ack') {
        jsonResponse(response, 200, {
          ack: state.captureAcks.has(url.searchParams.get('key') || ''),
        })
        return
      }
      if (request.method === 'GET' && url.pathname === '/v1/models') {
        jsonResponse(response, 200, { object: 'list', data: [] })
        return
      }
      if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
        state.chatRequests += 1
        jsonResponse(response, 503, {
          error: { message: 'model calls are forbidden in this gate' },
        })
        return
      }
      if (request.method === 'GET' && url.pathname === '/updater') {
        response.writeHead(204, { 'Access-Control-Allow-Origin': '*' })
        response.end()
        return
      }
      state.unexpectedRequests.push(`${request.method} ${url.pathname}`)
      jsonResponse(response, 404, { error: 'unexpected fixture request' })
    } catch (error) {
      state.unexpectedRequests.push(
        `fixture-error:${error instanceof Error ? error.message : String(error)}`,
      )
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
      if (server.listening) await new Promise((resolveClose) => server.close(resolveClose))
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
      models: [fixture-model]
      model_specs_mode: explicit
      model_specs:
        - id: fixture-model
          display_name: Isolated Fixture Model
          capabilities: [text]
      compatible: openai
      locality: cloud
      tools_enabled: false
      enabled: true
  routing: { enabled: false }
  cache: { enabled: false }
  tools: { enabled: "off" }
storage:
  driver: sqlite
  sqlite:
    path: ${JSON.stringify(join(sandbox, '.hexclaw/data.db'))}
knowledge: { enabled: false, embedding: { disable_auto_install: true } }
memory: { long_term: { enabled: false }, vector: { enabled: false } }
file_memory: { enabled: false }
heartbeat: { enabled: false }
mcp: { enabled: false }
skills: { enabled: false, auto_load: false }
router: { enabled: false }
voice: { enabled: false }
skill:
  sandbox: { enabled: false }
  builtin: { search: false, weather: false, browser: false, code_exec: false, file_ops: false }
observe:
  log_level: info
  metrics: { enabled: false }
`
}

function renderFixtureSource(fixtureOrigin, data) {
  return `;(function runK12TopbarInstalledBoundary() {
  'use strict'
  const fixtureOrigin = ${JSON.stringify(fixtureOrigin)}
  const fixture = ${JSON.stringify(data)}
  const nativeBoundary = globalThis.isTauri === true
  // 真实 WKWebView 仍由 Test.app 承载；fixture 只让所有渲染分片统一走隔离 loopback API。
  try { globalThis.isTauri = false } catch {}
  const phaseKey = '__hexclaw_bug_20260801_001_005_phase__'
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim()
  const post = async (payload) => {
    const response = await fetch(fixtureOrigin + '/__k12_topbar__/report', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    })
    if (!response.ok) throw new Error('fixture report failed: ' + response.status)
  }
  const reportFixtureError = (error) => {
    const message = error instanceof Error ? [error.name + ': ' + error.message, error.stack].filter(Boolean).join('\\n') : String(error)
    void post({ stage: 'fixture-error', message }).catch(() => {})
  }
  addEventListener('error', (event) => reportFixtureError(event.error || event.message))
  addEventListener('unhandledrejection', (event) => reportFixtureError(event.reason))
  void post({ stage: 'bootstrap', isTauri: nativeBoundary, hasInternals: typeof globalThis.__TAURI_INTERNALS__?.invoke === 'function' }).catch(() => {})
  const response = (value, status = 200) => ({ status, headers: { 'content-type': 'application/json; charset=utf-8' }, body: Array.from(new TextEncoder().encode(JSON.stringify(value))) })
  const apiResponse = (method, rawPath) => {
    const path = new URL(rawPath, 'http://sidecar.invalid').pathname
    if (path === '/health') return response({ status: 'ok' })
    if (path === '/api/v1/config/llm') return response({ default: '', providers: {}, routing: { enabled: false }, cache: { enabled: false } })
    if (path === '/api/v1/config') return response({
      server: { host: '127.0.0.1', port: 16060, mode: 'desktop' },
      llm: { default: '', providers: {} },
      knowledge: { enabled: false },
      mcp: { enabled: false },
      cron: { enabled: false },
      webhook: { enabled: false },
      canvas: { enabled: true },
      voice: { enabled: false },
      sandbox: { network_enabled: false, allowed_paths: [] },
      security: { gateway_enabled: true, injection_detection: true, pii_filter: false, content_filter: true, rate_limit_rpm: 60 },
    })
    if (path === '/api/v1/ollama/status') return response({ running: false, associated: false, models: [] })
    if (path === '/api/v1/agents') return response({ agents: fixture.agents, total: fixture.agents.length, default: 'mingming' })
    if (path === '/api/v1/sessions') return response({ sessions: fixture.sessions, total: fixture.sessions.length })
    if (/^\\/api\\/v1\\/sessions\\/[^/]+\\/messages$/.test(path)) return response({ messages: [], total: 0 })
    if (path === '/api/v1/streams/active') return response({ streams: [], total: 0 })
    if (path === '/api/k12/view-descriptor') return response({ header_tabs: ['辅导', '学习档案', '学情'], message_badges: [], composer_placeholder: '', composer_chips: [], record_collections: [], side_panels: [], actions: [], i18n_keys: [], schema_version: 1 })
    if (path === '/api/k12/mistakes' || path === '/api/k12/review-queue') return response({ items: fixture.mistakes, total: fixture.mistakes.length })
    if (path === '/api/k12/insight-report') return response(fixture.insightReport)
    if (path === '/api/k12/curriculum-progress') return response({ progress: null })
    if (path === '/api/k12/weekly-practice/settings') return response({ agent: 'mingming', revision: 1, timezone: 'Asia/Shanghai', due_review_enabled: true, textbook_consolidation_enabled: false, arithmetic_warmup_enabled: false, arithmetic_minutes: 2 })
    if (path.startsWith('/api/k12/')) return response({ items: [] })
    if (path.startsWith('/api/v1/')) return response({ items: [], total: 0 })
    return response({})
  }
  const nativeFetch = globalThis.fetch.bind(globalThis)
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href)
    if (url.origin === 'http://localhost:11434') {
      return new Response(JSON.stringify({ running: false, associated: false, models: [] }), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } })
    }
    if (url.origin === fixtureOrigin && (url.pathname === '/health' || url.pathname.startsWith('/api/'))) {
      const request = input instanceof Request ? input : new Request(url, init)
      const result = apiResponse(request.method.toUpperCase(), url.pathname + url.search)
      return new Response(new Uint8Array(result.body), { status: result.status, headers: result.headers })
    }
    return nativeFetch(input, init)
  }
  if (!localStorage.getItem('__hexclaw_bug_20260801_001_005_initialized__')) {
    localStorage.setItem('__hexclaw_bug_20260801_001_005_initialized__', '1')
    localStorage.setItem(phaseKey, '0')
    localStorage.setItem('hc-theme', 'light')
    localStorage.setItem('hc-k12-appearance-v1', JSON.stringify(fixture.appearance))
    localStorage.setItem('hexclaw:welcomeRedirectDone', '1')
    sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
    localStorage.setItem('hexclaw_lastSessionId', 'session-k12')
    localStorage.setItem('hexclaw_sessionAgents', JSON.stringify({ 'session-k12': 'mingming' }))
    localStorage.setItem('hexclaw_pinned_sessions', JSON.stringify(fixture.pinnedSessionIds))
  }
  sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
  try {
    Object.defineProperty(Navigator.prototype, 'language', { configurable: true, get: () => fixture.locale })
    Object.defineProperty(Navigator.prototype, 'languages', { configurable: true, get: () => [fixture.locale] })
  } catch {}
  const nativeMatchMedia = globalThis.matchMedia?.bind(globalThis)
  if (nativeMatchMedia) {
    globalThis.matchMedia = (query) => {
      if (query.includes('prefers-reduced-motion')) return { matches: fixture.reducedMotion, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false } }
      return nativeMatchMedia(query)
    }
  }
  class FixtureWebSocket extends EventTarget {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3
    CONNECTING = 0; OPEN = 1; CLOSING = 2; CLOSED = 3; binaryType = 'blob'; bufferedAmount = 0; extensions = ''; protocol = ''; readyState = 0
    onclose = null; onerror = null; onmessage = null; onopen = null
    constructor(url) { super(); this.url = String(url); queueMicrotask(() => { this.readyState = 1; const event = new Event('open'); this.onopen?.call(this, event); this.dispatchEvent(event) }) }
    close() { this.readyState = 3 }
    send() {}
  }
  globalThis.WebSocket = FixtureWebSocket
  const waitFor = async (read, label, timeout = 30000) => { const deadline = Date.now() + timeout; let lastError; while (Date.now() < deadline) { try { const value = read(); if (value) return value } catch (error) { lastError = error } await sleep(80) } const diagnostic = { label, route: location.pathname + location.search + location.hash, body: clean(document.body?.innerText || '').slice(0, 1200), settings: document.querySelectorAll('.hc-settings').length, themeGroup: document.querySelectorAll('.hc-settings__theme-segmented').length, tabs: Array.from(document.querySelectorAll('[role="tab"]')).map((node) => clean(node.textContent)).slice(0, 20), configKeys: Object.keys(localStorage).sort() }; throw new Error('timed out waiting for ' + label + (lastError ? ': ' + lastError : '') + ' :: ' + JSON.stringify(diagnostic)) }
  const findText = (selector, text) => Array.from(document.querySelectorAll(selector)).find((node) => clean(node.textContent) === text)
  const measure = (selector) => { const node = document.querySelector(selector); if (!(node instanceof HTMLElement)) return null; const rect = node.getBoundingClientRect(); const style = getComputedStyle(node); return { selector, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, display: style.display, border: style.border, borderRadius: style.borderRadius, background: style.background, backgroundImage: style.backgroundImage, color: style.color, opacity: style.opacity, boxShadow: style.boxShadow, backdropFilter: style.getPropertyValue('backdrop-filter'), webkitBackdropFilter: style.getPropertyValue('-webkit-backdrop-filter') } }
  const targetChildren = (selector) => Array.from(document.querySelectorAll(selector + ' > *')).filter((node) => node instanceof HTMLElement && node.getClientRects().length).map((node) => { const rect = node.getBoundingClientRect(); const style = getComputedStyle(node); return { tag: node.tagName, className: node.className, text: clean(node.textContent), rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, display: style.display, lineHeight: style.lineHeight, padding: style.padding, border: style.border } })
  const snapshot = (surface) => {
    const implementation = surface === 'settings' ? { target: measure('.hc-toolbar'), children: targetChildren('.hc-toolbar') } : { target: measure('.k12enh-tabs'), children: targetChildren('.k12enh-tabs') }
    return { surface, route: location.pathname + location.search, viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, locale: navigator.language, reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches }, theme: document.documentElement.dataset.theme, skin: document.body.dataset.k12SkinActive, isTauri: nativeBoundary, geometry: { sidebar: measure('.hc-sidebar'), main: measure('.hc-app__content'), sessionSidebar: measure('.hc-chat__sidebar'), k12Header: surface === 'settings' ? measure('.hc-toolbar') : measure('.k12enh-tabs'), settingsToolbar: measure('.hc-toolbar'), themeGroup: measure('.hc-settings__theme-segmented'), k12Group: measure('.k12-appearance-settings__grid'), k12Card: measure('.k12-appearance-settings__card:first-child'), recordsOuter: measure('#k12-enh-view-records'), readingRail: measure('[data-testid="mistakes-section"]'), insightsOuter: measure('#k12-enh-view-insights'), insightTiles: measure('.k12ins__tiles'), priority: measure('[data-testid="insight-priority-card"]') }, target: implementation, scene: { butterflies: document.querySelectorAll('.k12-ambient-butterfly').length, fireflies: document.querySelectorAll('.k12-ambient-firefly').length, blackboardOverlayNodes: document.querySelectorAll('[data-k12-blackboard],.k12-blackboard,.k12-board').length, mainPersonNodes: document.querySelectorAll('.k12-main-person,[data-k12-main-person],.k12-main-character').length, visibleRightRails: Array.from(document.querySelectorAll('.hc-chat__side-panel,[data-testid="chat-side-panel"],.side-panel.on')).filter((node) => node instanceof HTMLElement && node.getClientRects().length).length, cardToken: getComputedStyle(document.body).getPropertyValue('--hc-bg-card').trim() }, semantic: { topTabs: surface === 'settings' ? Array.from(document.querySelectorAll('.hc-settings [role="tab"]')).map((node) => clean(node.textContent)) : [], selectedTopTab: surface === 'settings' ? clean(document.querySelector('.hc-settings [role="tab"][aria-selected="true"]')?.textContent) : '', records: surface === 'records' ? Array.from(document.querySelectorAll('[data-testid="mistakes-section"] [data-record-id]')).map((node) => node.getAttribute('data-record-id')).filter(Boolean) : [], insightTiles: surface === 'insights' ? Array.from(document.querySelectorAll('[data-testid^="insight-tile-"]')).map((node) => clean(node.textContent)) : [] } } }
  const openSettings = async () => { const item = await waitFor(() => document.querySelector('[data-nav-id="settings"]'), 'settings nav'); item.click(); await waitFor(() => document.querySelector('.hc-settings'), 'settings page'); const tab = await waitFor(() => findText('.hc-settings [role="tab"]', '系统设置'), 'system settings tab'); tab.click(); await waitFor(() => document.querySelector('[role="radiogroup"][aria-label="外观"]') || document.querySelector('.hc-settings__theme-segmented'), 'appearance settings'); await sleep(120); return snapshot('settings') }
  const openChat = async (surface) => { const item = await waitFor(() => document.querySelector('[data-nav-id="chat"]'), 'chat nav'); item.click(); await waitFor(() => document.querySelector('.k12enh-seg'), 'K12 tabs'); const label = surface === 'records' ? '学习档案' : '学情'; const tab = await waitFor(() => findText('.k12enh-seg [role="tab"]', label), label + ' tab'); tab.click(); if (surface === 'records') { const mistakesTab = await waitFor(() => document.querySelector('[data-testid="subtab-mistakes"]'), 'mistakes tab'); mistakesTab.click(); await waitFor(() => document.querySelectorAll('[data-testid="mistakes-section"] [data-record-id]').length === fixture.mistakes.length, 'mistake rows') } else await waitFor(() => document.querySelector('[data-testid="insight-priority-card"]'), 'insight priority'); await sleep(120); return snapshot(surface) }
  const waitForCaptureAck = async (key) => { const deadline = Date.now() + 30000; while (Date.now() < deadline) { const result = await fetch(fixtureOrigin + '/__k12_topbar__/capture-ack?key=' + encodeURIComponent(key)); const payload = await result.json(); if (payload.ack === true) return; await sleep(80) } throw new Error('timed out waiting for capture ack ' + key) }
  const visit = async (surface, phase) => { const observation = surface === 'settings' ? await openSettings() : await openChat(surface); await post({ stage: 'surface-ready', phase, surface, observation }); await waitForCaptureAck(phase + ':' + surface); return observation }
  const runRoutes = async (phase) => [await visit('settings', phase), await visit('records', phase), await visit('insights', phase)]
  const execute = async () => { if (document.readyState === 'loading') await new Promise((resolve) => addEventListener('DOMContentLoaded', resolve, { once: true })); await waitFor(() => document.body && document.body.innerText, 'body'); const phase = Number(localStorage.getItem(phaseKey) || '0'); const observations = await runRoutes(phase); if (phase === 0) { await post({ stage: 'light-routes', observations }); localStorage.setItem(phaseKey, '1'); localStorage.setItem('hc-theme', 'dark'); location.reload(); return } if (phase === 1) { localStorage.setItem(phaseKey, '2'); await post({ stage: 'ready-for-restart', observations, persisted: { theme: localStorage.getItem('hc-theme'), appearance: localStorage.getItem('hc-k12-appearance-v1') } }); return } if (phase === 2) { localStorage.setItem(phaseKey, '3'); await post({ stage: 'restarted-routes', observations, persisted: { theme: localStorage.getItem('hc-theme'), appearance: localStorage.getItem('hc-k12-appearance-v1') } }) } }
  void execute().catch(reportFixtureError)
})()
`
}

function prepareFrontend(sandbox, fixtureOrigin, fixtureSource) {
  const dist = join(repoRoot, 'dist')
  assert.ok(existsSync(join(dist, 'index.html')), 'current dist/index.html is missing')
  const frontend = join(sandbox, 'frontend')
  cpSync(dist, frontend, { recursive: true })
  assert.ok(!fixtureSource.includes('</script>'))
  try {
    new Function(fixtureSource)
  } catch (error) {
    writeFileSync(join(sandbox, 'fixture-source.js'), fixtureSource, { mode: 0o600 })
    writeFileSync(join(evidenceRoot, 'debug-fixture-source.js'), fixtureSource, { mode: 0o600 })
    throw error
  }
  const indexPath = join(frontend, 'index.html')
  const index = readFileSync(indexPath, 'utf8')
  const moduleEntry = index.match(
    /<script type="module" crossorigin src="\.\/assets\/([^"]+\.js)">/,
  )
  assert.ok(moduleEntry, 'current dist module entry is missing')
  const modulePath = join(frontend, 'assets', moduleEntry[1])
  let moduleSource = readFileSync(modulePath, 'utf8')
  const platformProbe = /function [A-Za-z_$][\w$]*\(\)\{return!!globalThis\.isTauri\}/g
  assert.equal(
    (moduleSource.match(platformProbe) || []).length,
    1,
    'current dist must contain one platform probe',
  )
  assert.ok(moduleSource.includes('http://localhost:16060'), 'current dist API base is missing')
  moduleSource = moduleSource
    .replace(platformProbe, (match) => match.replace('return!!globalThis.isTauri', 'return!1'))
    .replaceAll('http://localhost:16060', fixtureOrigin)
  writeFileSync(modulePath, moduleSource, { mode: 0o600 })
  writeFileSync(indexPath, index.replace('<head>', `<head>\n<script>${fixtureSource}</script>`))
  return frontend
}

function writeOverlay(sandbox, frontend, sidecarPort, fixtureOrigin) {
  const overlayPath = join(sandbox, 'tauri.k12-topbar-installed.conf.json')
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "style-src-attr 'unsafe-inline'",
    `img-src 'self' data: blob: http://localhost:${sidecarPort} http://127.0.0.1:${sidecarPort}`,
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
          width: 2048,
          height: 956,
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
      .split(/\s+/)
      .filter(Boolean)
      .map(Number)
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
        signal: AbortSignal.timeout(1500),
      })
      if (response.ok) return
    } catch {}
    await sleep(250)
  }
  throw new Error(`Sidecar health timed out on loopback port ${port}`)
}

async function waitForReport(state, stage, fromIndex = 0, timeout = 60_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const report = state.reports.slice(fromIndex).find((entry) => entry.stage === stage)
    if (report) return report
    const error = state.reports.slice(fromIndex).find((entry) => entry.stage === 'fixture-error')
    if (error)
      throw new Error(
        `WKWebView fixture failed: ${error.message} :: reports=${JSON.stringify(state.reports.slice(fromIndex))}`,
      )
    await sleep(100)
  }
  throw new Error(`timed out waiting for WKWebView report: ${stage}`)
}

async function waitForSurfaceReport(state, phase, surface, fromIndex = 0, timeout = 60_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const report = state.reports
      .slice(fromIndex)
      .find(
        (entry) =>
          entry.stage === 'surface-ready' && entry.phase === phase && entry.surface === surface,
      )
    if (report) return report
    const error = state.reports.slice(fromIndex).find((entry) => entry.stage === 'fixture-error')
    if (error)
      throw new Error(
        `WKWebView fixture failed: ${error.message} :: reports=${JSON.stringify(state.reports.slice(fromIndex))}`,
      )
    await sleep(100)
  }
  throw new Error(`timed out waiting for WKWebView surface report: ${phase}:${surface}`)
}

async function captureSurfacePhase(state, pid, phase, theme, restart = false, fromIndex = 0) {
  const surfaces = ['settings', 'records', 'insights']
  const observations = []
  const screenshots = {}
  for (const surface of surfaces) {
    const report = await waitForSurfaceReport(state, phase, surface, fromIndex)
    const suffix = restart ? '-restarted' : ''
    const destination = join(evidenceRoot, `installed-${theme}${suffix}-${surface}.png`)
    screenshots[surface] = captureWindow(pid, destination)
    observations.push(report)
    state.captureAcks.add(`${phase}:${surface}`)
  }
  return { observations, screenshots }
}

async function stopProcess(processHandle) {
  if (!processHandle || processHandle.exitCode !== null) return
  processHandle.kill('SIGTERM')
  const exited = await Promise.race([
    new Promise((resolveExit) => processHandle.once('exit', () => resolveExit(true))),
    sleep(5000).then(() => false),
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
    if (!command.includes(`${bundle}/Contents/MacOS/hexclaw serve --desktop`))
      throw new Error(`dedicated port ${port} has unexpected owner ${pid}: ${command}`)
    process.kill(pid, 'SIGTERM')
    stopped.push(pid)
  }
  const deadline = Date.now() + 10_000
  while (listenerPIDs(port).length && Date.now() < deadline) await sleep(100)
  assert.deepEqual(listenerPIDs(port), [])
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
  if owner == target && layer == 0 && alpha > 0, let id = (row[kCGWindowNumber as String] as? NSNumber)?.intValue, let bounds = row[kCGWindowBounds as String] as? [String: Any], let x = (bounds["X"] as? NSNumber)?.doubleValue, let y = (bounds["Y"] as? NSNumber)?.doubleValue, let width = (bounds["Width"] as? NSNumber)?.doubleValue, let height = (bounds["Height"] as? NSNumber)?.doubleValue { print("\\(id)|\\(x)|\\(y)|\\(width)|\\(height)"); break }
}
`
  const output = execFileSync('/usr/bin/swift', ['-e', swift], { encoding: 'utf8' }).trim()
  assert.ok(output, `no visible native window found for PID ${pid}`)
  const [id, x, y, width, height] = output.split('|').map(Number)
  assert.ok([id, x, y, width, height].every(Number.isFinite))
  return { id, x, y, width, height }
}

function captureWindow(pid, destination) {
  const window = windowInfoForPID(pid)
  execFileSync('/usr/sbin/screencapture', ['-x', '-l', String(window.id), destination])
  assert.ok(existsSync(destination) && statSync(destination).size > 1024)
  return { ...window, bytes: statSync(destination).size }
}

function sanitizeLog(raw, sandbox) {
  return raw.replaceAll(repoRoot, '<repo>').replaceAll(sandbox, '<sandbox>')
}

async function main() {
  assert.equal(process.platform, 'darwin', 'installed boundary is macOS-only')
  mkdirSync(evidenceRoot, { recursive: true })
  const sandbox = mkdtempSync(join(tmpdir(), 'hexclaw-k12-topbar-installed.'))
  chmodSync(sandbox, 0o700)
  mkdirSync(join(sandbox, '.hexclaw'), { mode: 0o700 })
  mkdirSync(join(sandbox, 'tmp'), { mode: 0o700 })
  const fixturePort = await reserveLoopbackPort()
  const sidecarPort = await reserveLoopbackPort()
  assert.notEqual(fixturePort, sidecarPort)
  const data = fixtureData()
  assert.equal(data.fixtureId, 'bug-20260801-001-002-004-005-business-fixture-v2')
  assert.equal(data.locale, 'zh-CN')
  assert.equal(data.reducedMotion, true)
  assert.equal(data.sessions.length, 12)
  assert.equal(data.mistakes.length, 6)
  const fixture = createFixture(fixturePort, data)
  const fixtureProvenance = fixtureReceipt(data)
  const sourceProvenanceReceipt = sourceProvenance()
  let appProcess = null
  let appLog = null
  let appLogGeneration = 0
  let finalStatus = 'NOT_PASS'
  let finalError = null
  let appBundle = ''
  try {
    await fixture.listen()
    const configPath = join(sandbox, '.hexclaw/hexclaw.yaml')
    writeFileSync(configPath, renderConfig(sandbox, sidecarPort, fixture.origin), { mode: 0o600 })
    chmodSync(configPath, 0o600)
    const offlineEnv = {
      ...process.env,
      CARGO_NET_OFFLINE: 'true',
      CARGO_TARGET_DIR: join(sandbox, 'cargo-target'),
      GOENV: 'off',
      GOPROXY: 'off',
      GOSUMDB: 'off',
      PNPM_CONFIG_OFFLINE: 'true',
      npm_config_offline: 'true',
    }
    delete offlineEnv.GOROOT
    await runCommand('pnpm', ['build-only'], { env: offlineEnv })
    const frontend = prepareFrontend(
      sandbox,
      fixture.origin,
      renderFixtureSource(fixture.origin, data),
    )
    const overlay = writeOverlay(sandbox, frontend, sidecarPort, fixture.origin)
    appBundle = join(sandbox, `cargo-target/release/bundle/macos/${productName}.app`)
    await runCommand('pnpm', ['exec', 'tauri', 'build', '--config', overlay, '--bundles', 'app'], {
      env: offlineEnv,
    })
    const infoPlist = join(appBundle, 'Contents/Info.plist')
    const executable = join(appBundle, 'Contents/MacOS/hexclaw-desktop')
    const sidecarExecutable = join(appBundle, 'Contents/MacOS/hexclaw')
    assert.ok(existsSync(infoPlist) && existsSync(executable) && existsSync(sidecarExecutable))
    const identifier = execFileSync(
      'plutil',
      ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', infoPlist],
      { encoding: 'utf8' },
    ).trim()
    assert.equal(identifier, bundleIdentifier)
    const runtimeEnv = {
      PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
      LANG: 'zh_CN.UTF-8',
      LC_ALL: 'zh_CN.UTF-8',
      HOME: sandbox,
      USERPROFILE: sandbox,
      CFFIXED_USER_HOME: sandbox,
      TMPDIR: join(sandbox, 'tmp'),
      TEMP: join(sandbox, 'tmp'),
      HEXCLAW_TEST_MODE: '1',
      HEXCLAW_TEST_HOME: sandbox,
      HEXCLAW_SIDECAR_PORT: String(sidecarPort),
      HEXCLAW_TEST_LLM_CONFIG_MODE: 'preseeded-owner-yaml',
      DINGTALK_LIVE_SEND: '0',
      NO_PROXY: '*',
      no_proxy: '*',
    }
    const generations = []
    const launch = async () => {
      appLogGeneration += 1
      const appLogPath = join(sandbox, `app-${appLogGeneration}.log`)
      appLog = createWriteStream(appLogPath, { flags: 'wx', mode: 0o600 })
      appProcess = spawn(executable, [], {
        cwd: sandbox,
        env: runtimeEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      appProcess.stdout.pipe(appLog, { end: false })
      appProcess.stderr.pipe(appLog, { end: false })
      await waitForHealth(sidecarPort, appProcess)
      const pids = listenerPIDs(sidecarPort)
      assert.equal(pids.length, 1)
      generations.push({ appPID: appProcess.pid, sidecarPID: pids[0] })
    }
    await launch()
    captureWindow(appProcess.pid, join(evidenceRoot, 'installed-debug-after-health.png'))
    const lightCaptures = await captureSurfacePhase(fixture.state, appProcess.pid, 0, 'light')
    const light = await waitForReport(fixture.state, 'light-routes')
    const reportsBeforeRestart = fixture.state.reports.length
    const darkCaptures = await captureSurfacePhase(fixture.state, appProcess.pid, 1, 'dark')
    const beforeRestart = await waitForReport(fixture.state, 'ready-for-restart')
    await stopProcess(appProcess)
    await new Promise((resolveEnd) => appLog.end(resolveEnd))
    appLog = null
    await stopOwnedSidecar(sidecarPort, appBundle)
    await launch()
    const restartedCaptures = await captureSurfacePhase(
      fixture.state,
      appProcess.pid,
      2,
      'dark',
      true,
      reportsBeforeRestart,
    )
    const restarted = await waitForReport(fixture.state, 'restarted-routes', reportsBeforeRestart)
    const all = [...light.observations, ...beforeRestart.observations, ...restarted.observations]
    assert.equal(light.observations.length, 3)
    assert.equal(beforeRestart.observations.length, 3)
    assert.equal(restarted.observations.length, 3)
    assert.equal(generations.length, 2)
    assert.notEqual(generations[0].appPID, generations[1].appPID)
    assert.notEqual(generations[0].sidecarPID, generations[1].sidecarPID)
    assert.ok(all.every((entry) => entry.isTauri === true && entry.skin === 'k12'))
    assert.ok(all.every((entry) => entry.geometry.sidebar?.rect.width === 226))
    assert.ok(
      all
        .filter((entry) => entry.surface !== 'settings')
        .every((entry) => entry.geometry.sessionSidebar?.rect.width === 256),
    )
    assert.ok(all.every((entry) => entry.geometry.k12Header?.rect.width > 0))
    assert.ok(
      all
        .filter((entry) => entry.surface === 'settings')
        .every((entry) => entry.semantic.selectedTopTab === '系统设置'),
    )
    assert.ok(
      all
        .filter((entry) => entry.surface === 'records')
        .every((entry) => entry.semantic.records.length === data.mistakes.length),
    )
    assert.ok(
      all
        .filter((entry) => entry.surface === 'insights')
        .every(
          (entry) =>
            entry.geometry.insightTiles?.rect.width === entry.geometry.priority?.rect.width,
        ),
    )
    assert.equal(beforeRestart.persisted.theme, 'dark')
    assert.equal(restarted.persisted.theme, 'dark')
    assert.deepEqual(fixture.state.unexpectedRequests, [])
    assert.equal(fixture.state.chatRequests, 0)
    const summary = {
      schemaVersion: 2,
      status: 'PASS',
      scope: ['BUG-20260801-001', 'BUG-20260801-002', 'BUG-20260801-004', 'BUG-20260801-005'],
      app: {
        productName,
        identifier,
        bundle: relative(repoRoot, appBundle),
        executableSHA256: sha256File(executable),
        sidecarSHA256: sha256File(sidecarExecutable),
        nativeWindow: true,
        realWKWebView: true,
      },
      sourceProvenance: sourceProvenanceReceipt,
      buildProvenance: {
        frontendDistSHA256: sha256Tree(join(sandbox, 'frontend')),
        executableSHA256: sha256File(executable),
        sidecarSHA256: sha256File(sidecarExecutable),
      },
      fixtureProvenance,
      isolation: {
        testHomeMode: '0700',
        configMode: '0600',
        uniqueBundleIdentifier: true,
        sidecarPort,
        fixturePort,
        applicationsDirectoryTouched: false,
        userHomeRead: false,
        externalNetworkRequests: 0,
        realModelInvocations: 0,
        realIMInvocations: 0,
      },
      generations,
      screenshots: {
        light: lightCaptures.screenshots,
        dark: darkCaptures.screenshots,
        darkRestarted: restartedCaptures.screenshots,
      },
      reports: {
        light,
        beforeRestart,
        restarted,
        surface: {
          light: lightCaptures.observations,
          dark: darkCaptures.observations,
          darkRestarted: restartedCaptures.observations,
        },
      },
      fixtureReceipts: {
        unexpectedRequests: fixture.state.unexpectedRequests,
        chatRequests: fixture.state.chatRequests,
        externalRequests: fixture.state.externalRequests,
        captureAcks: [...fixture.state.captureAcks],
      },
    }
    writeFileSync(
      join(evidenceRoot, 'installed-summary.json'),
      `${JSON.stringify(summary, null, 2)}\n`,
    )
    finalStatus = 'PASS'
    process.stdout.write(
      `\nK12 topbar installed Test.app boundary PASS: ${relative(repoRoot, evidenceRoot)}\n`,
    )
  } catch (error) {
    finalError = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    throw error
  } finally {
    await stopProcess(appProcess)
    if (appLog) await new Promise((resolveEnd) => appLog.end(resolveEnd))
    let stoppedSidecars = []
    try {
      stoppedSidecars = await stopOwnedSidecar(sidecarPort, appBundle)
    } catch (error) {
      if (!finalError)
        finalError = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    }
    await fixture.close()
    for (let generation = 1; generation <= appLogGeneration; generation += 1) {
      const source = join(sandbox, `app-${generation}.log`)
      if (existsSync(source))
        writeFileSync(
          join(evidenceRoot, `installed-app-${generation}.log`),
          sanitizeLog(readFileSync(source, 'utf8'), sandbox),
        )
    }
    const summaryPath = join(evidenceRoot, 'installed-summary.json')
    if (finalStatus !== 'PASS' || !existsSync(summaryPath))
      writeFileSync(
        summaryPath,
        `${JSON.stringify({
          schemaVersion: 2,
          status: finalStatus,
          error: finalError,
          scope: ['BUG-20260801-001', 'BUG-20260801-002', 'BUG-20260801-004', 'BUG-20260801-005'],
          sourceProvenance: sourceProvenanceReceipt,
          fixtureProvenance,
          reports: fixture.state.reports,
          fixtureReceipts: {
            unexpectedRequests: fixture.state.unexpectedRequests,
            chatRequests: fixture.state.chatRequests,
            externalRequests: fixture.state.externalRequests,
            captureAcks: [...fixture.state.captureAcks],
          },
        }, null, 2)}\n`,
      )
    rmSync(appBundle, { recursive: true, force: true })
    rmSync(sandbox, { recursive: true, force: true })
    writeFileSync(
      join(evidenceRoot, 'installed-cleanup.json'),
      `${JSON.stringify({ status: finalStatus, appProcessStopped: !appProcess || appProcess.exitCode !== null || appProcess.signalCode !== null, sidecarPortReleased: listenerPIDs(sidecarPort).length === 0, fixtureClosed: true, uniqueAppBundleRemoved: !existsSync(appBundle), sandboxRemoved: !existsSync(sandbox), stoppedSidecars }, null, 2)}\n`,
    )
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`)
  process.exitCode = 1
})
