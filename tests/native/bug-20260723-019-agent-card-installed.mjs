#!/usr/bin/env node

/**
 * BUG-20260723-019 的隔离安装态验收。
 *
 * 本 harness 只在临时目录构建唯一 Test.app，在真实 Tauri WKWebView 中注入与浏览器
 * paired gate 相同的四张只读智能体卡 fixture，并回传 DOM、bbox、computed-style 与
 * 稳定图标/按钮状态。运行时仅使用 0700 临时 HOME、SQLite、loopback 端口和临时
 * Cargo target；不访问 /Applications、真实用户目录、真实模型、IM 或外部网络。
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  cpSync,
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
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { webkit } from '@playwright/test'

const nativeDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(nativeDir, '../..')
const docsRoot = resolve(repoRoot, '../hexclaw-docs')
const prototypeRoot = join(docsRoot, 'prototype')
const srcTauriRoot = join(repoRoot, 'src-tauri')
const evidenceRoot = join(repoRoot, 'test/evidence/bug-20260723-019-installed')
const pixelDiffTool = join(repoRoot, 'tests/e2e/tools/visual_pixel_diff.py')
// 每轮使用唯一 bundle id，避免 macOS WKWebView 按旧 Test.app 身份复用网站数据，
// 让安装态夹具始终从当前构建的 index/module 开始。
const runNonce = `${Date.now()}-${process.pid}`
const productName = `HexClaw BUG019 Agents Test ${runNonce}`
const bundleIdentifier = `com.hexclaw.desktop.bug-20260723-019-agents-${process.pid}`
const referenceProductName = `HexClaw BUG019 Reference Test ${runNonce}`
const referenceBundleIdentifier = `com.hexclaw.desktop.bug-20260723-019-reference-${process.pid}`
// 临时前端目录位于仓库内；overlay 传入相对仓库根的路径，符合 Tauri CLI
// 外置配置的解析基准，避免被当作 devUrl URL。
const nativeFrontendRoot = join(srcTauriRoot, `bug019-native-frontend-${runNonce}`)
const viewport = { width: 1280, height: 820 }
const deviceScaleFactor = 2
const maxChangedPixelRatio = 0.01
const commandTimeoutMs = 15 * 60_000

const sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds))

function writeJSON(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function probeNativeBundle(executable) {
  const strings = spawnSync('strings', [executable], { encoding: 'utf8', maxBuffer: 96 * 1024 * 1024 })
  const output = String(strings.stdout || '')
  const devURLFragments = [...new Set(output.match(/http:\/\/localhost:5173[^\s]{0,240}/g) || [])].slice(0, 4)
  return {
    stringsExitCode: strings.status,
    hasReferenceReportMarker: output.includes('reference-ready'),
    hasInstalledReportMarker: output.includes('native-ready'),
    hasPrototypeAgentSection: output.includes('data-pane="agents"') || output.includes('agent-cards'),
    devURLFragments,
  }
}

function sanitize(value, sandbox = '') {
  let text = String(value || '')
    .replaceAll(repoRoot, '<hexclaw-desktop>')
    .replaceAll(docsRoot, '<hexclaw-docs>')
  if (sandbox) text = text.replaceAll(sandbox, '<sandbox>')
  const userPathPattern = sep === '\\' ? /[A-Za-z]:\\Users\\[^\\\s]+/g : /\/Users\/[^/\s]+/g
  return text.replace(userPathPattern, '<user-home>')
}

function runCommand(command, args, options = {}) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, {
      cwd: options.cwd || repoRoot,
      env: options.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    const append = (chunk) => {
      output += chunk.toString()
      if (options.echo !== false) process.stdout.write(chunk)
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
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
      const receipt = {
        command,
        args,
        code,
        signal,
        durationMs: Date.now() - (options.startedAt || Date.now()),
        output,
      }
      if (code === 0) resolveCommand(receipt)
      else rejectCommand(Object.assign(new Error(`Command failed (${code ?? signal})`), { receipt }))
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

function listenerPIDs(port) {
  const result = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
    encoding: 'utf8',
  })
  if (![0, 1].includes(result.status ?? -1)) {
    throw new Error(`lsof failed for port ${port}: ${result.stderr || result.stdout}`)
  }
  return String(result.stdout || '')
    .split(/\s+/)
    .filter(Boolean)
    .map(Number)
}

function processCommand(pid) {
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : ''
}

function contentType(path) {
  return (
    {
      '.css': 'text/css; charset=utf-8',
      '.html': 'text/html; charset=utf-8',
      '.ico': 'image/x-icon',
      '.js': 'text/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
      '.woff': 'font/woff',
      '.woff2': 'font/woff2',
    }[extname(path).toLowerCase()] || 'application/octet-stream'
  )
}

function fixtureData() {
  return {
    agents: [
      {
        name: 'daily-report-layout',
        display_name: '日报分析师',
        description: '日报整理 · 简洁理性',
        model: '',
        provider: '',
        metadata: { card_icon: 'bar-chart' },
      },
      {
        name: 'mail-layout',
        display_name: '邮件助理',
        description: '收发邮件 · 正式礼貌',
        model: '',
        provider: '',
        metadata: { card_icon: 'mail' },
      },
      {
        name: 'k12-ming-layout',
        display_name: '小明的辅导助手 · 五年级',
        description: '五年级上 · 数学教材与当前进度 · 按年级边界讲解',
        model: '',
        provider: '',
        metadata: {
          scenario: 'k12-tutor',
          avatar: '🎓',
          card_enter_variant: 'primary',
          'k12.child_name': '小明',
          'k12.grade_term': '五年级上',
        },
      },
      {
        name: 'k12-hong-layout',
        display_name: '小红的辅导助手 · 三年级',
        description: '三年级上 · 数学教材与当前进度 · 独立档案与学习记录',
        model: '',
        provider: '',
        metadata: {
          scenario: 'k12-tutor',
          avatar: '🎓',
          card_enter_variant: 'default',
          'k12.child_name': '小红',
          'k12.grade_term': '三年级上',
        },
      },
    ],
    rules: [
      { id: 1, platform: '飞书', agent_name: 'daily-report-layout', priority: 0 },
      { id: 2, platform: '邮箱', agent_name: 'mail-layout', priority: 0 },
      { id: 3, platform: 'dingtalk', agent_name: 'k12-ming-layout', priority: 0 },
      { id: 4, platform: 'dingtalk', agent_name: 'k12-hong-layout', priority: 0 },
    ],
  }
}

function apiFixture(data, method, rawPath) {
  const url = new URL(rawPath, 'http://sidecar.invalid')
  const path = url.pathname
  if (path === '/health') return { status: 'ok' }
  if (path === '/api/v1/config/llm') {
    return { default: '', providers: {}, routing: { enabled: false }, cache: { enabled: false } }
  }
  if (path === '/api/v1/config') {
    // 提供完整的运行时配置投影；应用壳层会在首屏同时读取这些分支，
    // 仅返回 server/llm 会让真实 WKWebView 在新版本壳层停在空白页。
    return {
      server: { host: '127.0.0.1', port: 16060, mode: 'desktop' },
      llm: { default: '', providers: {}, routing: { enabled: false }, cache: { enabled: false } },
      knowledge: { enabled: false },
      mcp: { enabled: false },
      cron: { enabled: false },
      webhook: { enabled: false },
      canvas: { enabled: false },
      voice: { enabled: false },
      sandbox: { network_enabled: false, allowed_paths: [] },
      security: {
        gateway_enabled: true,
        injection_detection: true,
        pii_filter: false,
        content_filter: true,
        rate_limit_rpm: 60,
      },
    }
  }
  if (path === '/api/v1/ollama/status') return { running: false, associated: false, models: [] }
  if (path === '/api/v1/roles') return { roles: [], total: 0 }
  if (path === '/api/v1/skills') return { skills: [], total: 0 }
  if (path === '/api/v1/assistant/soul') {
    return { system_prompt: '', default_prompt: '', is_custom: false }
  }
  if (path === '/api/v1/agents') {
    return { agents: data.agents, total: data.agents.length, default: 'daily-report-layout' }
  }
  if (path === '/api/v1/agents/rules') return { rules: data.rules, total: data.rules.length }
  if (path === '/api/k12/mistakes') {
    const count = url.searchParams.get('agent') === 'k12-ming-layout' ? 11 : 7
    return { items: Array.from({ length: count }, (_, index) => ({ id: `mistake-${index + 1}` })) }
  }
  if (path === '/api/k12/review-queue') {
    const count = url.searchParams.get('agent') === 'k12-ming-layout' ? 6 : 3
    return { items: Array.from({ length: count }, (_, index) => ({ id: `review-${index + 1}` })) }
  }
  if (method === 'GET' && path.startsWith('/api/')) return {}
  return null
}

async function readBody(request, limit = 4 * 1024 * 1024) {
  const chunks = []
  let bytes = 0
  for await (const chunk of request) {
    bytes += chunk.length
    if (bytes > limit) throw new Error('fixture body exceeds limit')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function createLoopbackFixture(port, data) {
  const state = {
    reports: [],
    staticRequests: [],
    blockedExternalRequests: [],
    unexpectedRequests: [],
    apiRequests: [],
  }
  const server = createServer(async (request, response) => {
    try {
      const rawURL = request.url || '/'
      if (request.method === 'CONNECT' || /^https?:\/\//i.test(rawURL)) {
        state.blockedExternalRequests.push({ method: request.method, target: rawURL.slice(0, 300) })
        response.writeHead(502, { connection: 'close' })
        response.end()
        return
      }
      const url = new URL(rawURL, `http://127.0.0.1:${port}`)
      if (request.method === 'OPTIONS') {
        response.writeHead(204, {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET,POST,OPTIONS',
          'access-control-allow-headers': 'content-type',
        })
        response.end()
        return
      }
      if (request.method === 'POST' && url.pathname === '/__bug019__/report') {
        const report = JSON.parse((await readBody(request)) || '{}')
        state.reports.push(report)
        const body = JSON.stringify({ ok: true })
        response.writeHead(200, {
          'access-control-allow-origin': '*',
          'content-type': 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(body),
        })
        response.end(body)
        return
      }
      if (request.method === 'GET' && url.pathname === '/updater') {
        response.writeHead(204, { 'access-control-allow-origin': '*' })
        response.end()
        return
      }
      if (request.method === 'GET' && url.pathname === '/app.html') {
        const path = join(prototypeRoot, 'app.html')
        state.staticRequests.push(url.pathname)
        const body = readFileSync(path)
        response.writeHead(200, { 'content-type': contentType(path), 'content-length': body.length })
        response.end(body)
        return
      }
      if (request.method === 'GET' && !url.pathname.startsWith('/api/')) {
        const candidate = resolve(prototypeRoot, `.${decodeURIComponent(url.pathname)}`)
        if (candidate.startsWith(`${prototypeRoot}/`) && existsSync(candidate)) {
          const body = readFileSync(candidate)
          state.staticRequests.push(url.pathname)
          response.writeHead(200, {
            'content-type': contentType(candidate),
            'content-length': body.length,
          })
          response.end(body)
          return
        }
      }
      if (url.pathname.startsWith('/api/') || url.pathname === '/health') {
        state.apiRequests.push(`${request.method} ${url.pathname}${url.search}`)
        const payload = apiFixture(data, request.method || 'GET', `${url.pathname}${url.search}`)
        if (payload !== null) {
          const body = JSON.stringify(payload)
          response.writeHead(200, {
            'access-control-allow-origin': '*',
            'content-type': 'application/json; charset=utf-8',
            'content-length': Buffer.byteLength(body),
          })
          response.end(body)
          return
        }
      }
      state.unexpectedRequests.push(`${request.method} ${url.pathname}${url.search}`)
      const body = JSON.stringify({ error: 'unexpected fixture request' })
      response.writeHead(404, {
        'access-control-allow-origin': '*',
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
      })
      response.end(body)
    } catch (error) {
      state.unexpectedRequests.push(
        `fixture-error:${error instanceof Error ? error.message : String(error)}`,
      )
      response.writeHead(500)
      response.end('fixture failure')
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

function renderConfig(sandbox, sidecarPort) {
  return `server:
  host: 127.0.0.1
  port: ${sidecarPort}
  mode: development
platforms:
  web:
    enabled: true
llm:
  default: ""
  providers: {}
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
skill:
  sandbox:
    enabled: false
  builtin:
    search: false
    weather: false
    browser: false
    code_exec: false
    file_ops: false
observe:
  log_level: info
  metrics:
    enabled: false
`
}

function snapshotFromDOM() {
  const round = (value) => Math.round(value * 100) / 100
  const rect = (element) => {
    const box = element.getBoundingClientRect()
    return { x: round(box.x), y: round(box.y), width: round(box.width), height: round(box.height) }
  }
  const relativeRect = (element, owner) => {
    const box = element.getBoundingClientRect()
    const parent = owner.getBoundingClientRect()
    return {
      x: round(box.x - parent.x),
      y: round(box.y - parent.y),
      width: round(box.width),
      height: round(box.height),
    }
  }
  const text = (element) => (element?.textContent || '').replace(/\s+/g, ' ').trim()
  const css = (element, properties) => {
    const style = getComputedStyle(element)
    return Object.fromEntries(properties.map((property) => [property, style.getPropertyValue(property)]))
  }
  const prototypeMode = Boolean(document.querySelector('.agent-cards'))
  const iconRole = (card) => {
    const logo = card.querySelector(prototypeMode ? '.cxlogo' : '.hc-cxlogo')
    const svg = logo?.querySelector('svg')
    if (!svg) return text(logo) === '🎓' ? 'avatar-graduation' : 'none'
    const paths = Array.from(svg.querySelectorAll('path')).map((node) => node.getAttribute('d') || '')
    const rects = Array.from(svg.querySelectorAll('rect')).map((node) => [
      node.getAttribute('width'),
      node.getAttribute('height'),
      node.getAttribute('x'),
      node.getAttribute('y'),
    ])
    // lucide-vue-next 更新后把坐标轴路径改成带圆角的等价路径；图标语义仍是
    // 稳定 metadata 投影的 bar-chart，夹具不得因 SVG 路径版本差异误报。
    if (paths.some((value) => value === 'M3 3v18h18' || value === 'M3 3v16a2 2 0 0 0 2 2h16')) return 'bar-chart'
    if (rects.some((value) => value.join('|') === '20|16|2|4')) return 'mail'
    return 'svg-unknown'
  }
  const cardSelector = prototypeMode ? '.agent-card' : '.hc-cxcard--dedicated'
  const grid = document.querySelector(prototypeMode ? '.agent-cards' : '.hc-cxcards')
  if (!(grid instanceof HTMLElement)) throw new Error('agent card grid missing')
  const cards = Array.from(grid.querySelectorAll(cardSelector))
  const cardSnapshots = cards.map((card) => {
    const header = card.querySelector(prototypeMode ? '.agent-card__header' : '.hc-agent-card__header')
    const facts = card.querySelector(prototypeMode ? '.agent-card__facts' : '.hc-agent-card__facts')
    const footer = card.querySelector(prototypeMode ? '.agent-card__footer' : '.hc-agent-card__footer')
    const name = card.querySelector(prototypeMode ? '.agent-card__name' : '.hc-cxnm__label')
    const description = card.querySelector(prototypeMode ? '.agent-card__description' : '.hc-cxmeta--card')
    if (!(header instanceof HTMLElement) || !(facts instanceof HTMLElement) || !(footer instanceof HTMLElement)) {
      throw new Error('agent card slots missing')
    }
    const badges = Array.from(card.querySelectorAll(prototypeMode ? '.agent-card__titleline .agent-card__badge' : '.hc-cxnm--card .hc-cxnm__badge'))
    const factItems = Array.from(card.querySelectorAll(prototypeMode ? '.agent-card__facts .tag, .agent-card__facts .pill' : '.hc-agent-card__facts .hc-tag, .hc-agent-card__facts .k12ac__tag'))
    const actions = Array.from(footer.querySelectorAll('button'))
    return {
      semantics: {
        kind: badges.some((badge) => text(badge) === 'K12') ? 'k12' : 'generic',
        name: text(name),
        description: text(description),
        badges: badges.map(text),
        facts: factItems.map(text),
        actions: actions.map(text),
      },
      iconRole: iconRole(card),
      actionStates: actions.map((action) => ({
        primary: action.classList.contains('hc-btn-primary') || action.classList.contains('btn-primary'),
        ghost: action.classList.contains('hc-btn-ghost') || action.classList.contains('btn-ghost'),
        danger: action.classList.contains('hc-btn--danger') || action.classList.contains('btn-ghost') && action.style.color !== '',
      })),
      absolute: {
        card: rect(card),
        header: rect(header),
        facts: rect(facts),
        footer: rect(footer),
        actions: actions.map(rect),
      },
      relative: {
        card: relativeRect(card, grid),
        header: relativeRect(header, card),
        facts: relativeRect(facts, card),
        footer: relativeRect(footer, card),
        actions: actions.map((action) => relativeRect(action, card)),
      },
      styles: {
        card: css(card, [
          'display', 'flex-direction', 'gap', 'min-height', 'padding-top', 'padding-right',
          'padding-bottom', 'padding-left', 'border-radius',
        ]),
        header: css(header, ['min-height', 'min-width']),
        facts: css(facts, ['display', 'min-height', 'align-content', 'flex-wrap']),
        footer: css(footer, ['display', 'gap', 'flex-wrap']),
        name: css(name, ['min-width', 'overflow', 'text-overflow', 'white-space']),
        description: css(description, ['min-width', 'overflow', 'text-overflow', 'white-space']),
        badges: badges.map((badge) => css(badge, ['flex-shrink', 'white-space', 'font-size', 'border-radius'])),
        actions: actions.map((action) => css(action, [
          'height', 'padding-left', 'padding-right', 'border-radius', 'border-top-color',
          'background-color', 'color', 'font-size', 'line-height', 'box-shadow',
        ])),
      },
    }
  })
  const gridStyle = getComputedStyle(grid)
  return {
    semantics: cardSnapshots.map((card) => card.semantics),
    icons: cardSnapshots.map((card) => card.iconRole),
    actionStates: cardSnapshots.map((card) => card.actionStates),
    absolute: {
      grid: rect(grid),
      cards: cardSnapshots.map((card) => card.absolute),
    },
    relative: {
      grid: { width: round(grid.getBoundingClientRect().width), height: round(grid.getBoundingClientRect().height) },
      cards: cardSnapshots.map((card) => card.relative),
    },
    styles: {
      grid: {
        display: gridStyle.display,
        columns: gridStyle.gridTemplateColumns.split(' ').filter(Boolean).length,
        columnGap: gridStyle.columnGap,
        rowGap: gridStyle.rowGap,
        alignItems: gridStyle.alignItems,
      },
      cards: cardSnapshots.map((card) => card.styles),
    },
    overflow: {
      grid: round(grid.scrollWidth - grid.clientWidth),
      cards: cards.map((card) => round(card.scrollWidth - card.clientWidth)),
    },
  }
}

function renderInstalledFixture(fixtureOrigin, data) {
  const snapshotSource = snapshotFromDOM.toString()
  return `;(function runBug019InstalledBoundary() {
  'use strict'
  const fixtureOrigin = ${JSON.stringify(fixtureOrigin)}
  const fixture = ${JSON.stringify(data)}
  const nativeFetch = globalThis.fetch.bind(globalThis)
  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
  const responseFor = (method, rawPath) => {
    const url = new URL(rawPath, fixtureOrigin)
    const body = ${apiFixture.toString()}(fixture, method, url.pathname + url.search)
    return body === null ? null : new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    })
  }
  globalThis.fetch = async (input, init) => {
    const raw = input instanceof Request ? input.url : String(input)
    const url = new URL(raw, location.href)
    if (url.origin === fixtureOrigin && (url.pathname === '/health' || url.pathname.startsWith('/api/'))) {
      const response = responseFor(init?.method || (input instanceof Request ? input.method : 'GET'), url.pathname + url.search)
      if (response) return response
    }
    return nativeFetch(input, init)
  }
  localStorage.clear()
  sessionStorage.clear()
  localStorage.setItem('hc-theme', 'light')
  localStorage.setItem('hexclaw:welcomeRedirectDone', '1')
  sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
  history.replaceState(null, '', '/agents')
  const waitFor = async (read, label, timeout = 60000) => {
    const deadline = Date.now() + timeout
    let lastError
    while (Date.now() < deadline) {
      try {
        const value = read()
        if (value) return value
      } catch (error) {
        lastError = error
      }
      await sleep(80)
    }
    throw new Error('timed out waiting for ' + label + (lastError ? ': ' + lastError : ''))
  }
  const report = async (payload) => {
    const result = await nativeFetch(fixtureOrigin + '/__bug019__/report', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!result.ok) throw new Error('fixture report failed: ' + result.status)
  }
  const reportError = (error) => {
    const message = error instanceof Error ? [error.name + ': ' + error.message, error.stack].filter(Boolean).join('\\n') : String(error)
    void report({ stage: 'fixture-error', message }).catch(() => {})
  }
  addEventListener('error', (event) => reportError(event.error || event.message))
  addEventListener('unhandledrejection', (event) => reportError(event.reason))
  void report({
    stage: 'bootstrap',
    isTauri: globalThis.isTauri === true,
    hasTauriInternals: typeof globalThis.__TAURI_INTERNALS__?.invoke === 'function',
    location: location.href,
  }).catch(() => {})
  const execute = async () => {
    if (document.readyState === 'loading') await new Promise((resolve) => addEventListener('DOMContentLoaded', resolve, { once: true }))
    await waitFor(() => document.querySelector('.hc-app'), 'application root')
    await waitFor(() => document.querySelectorAll('.hc-cxcard--dedicated').length === 4, 'four agent cards')
    await waitFor(() => {
      const splash = document.querySelector('#splash-screen')
      return !splash || splash.classList.contains('fade-out') || getComputedStyle(splash).opacity === '0' || getComputedStyle(splash).display === 'none' || getComputedStyle(splash).visibility === 'hidden'
    }, 'splash hidden')
    await waitFor(() => document.querySelector('.hc-cxcard--dedicated')?.textContent?.includes('日报分析师'), 'agent card text')
    await waitFor(() => document.fonts?.status === 'loaded', 'fonts')
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    await sleep(120)
    const snapshot = (${snapshotSource})()
    await report({
      stage: 'native-ready',
      environment: {
        viewport: { width: innerWidth, height: innerHeight },
        devicePixelRatio,
        locale: navigator.language,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        route: location.pathname,
        isTauri: globalThis.isTauri === true,
        hasTauriInternals: typeof globalThis.__TAURI_INTERNALS__?.invoke === 'function',
      },
      snapshot,
    })
  }
  void execute().catch(reportError)
})()
`
}

function renderReferenceFixture(fixtureOrigin, data) {
  const snapshotSource = snapshotFromDOM.toString()
  return `;(function runBug019ReferenceBoundary() {
  'use strict'
  const fixtureOrigin = ${JSON.stringify(fixtureOrigin)}
  const fixture = ${JSON.stringify(data)}
  const tauriRuntime = typeof globalThis.__TAURI_INTERNALS__?.invoke === 'function'
  if (tauriRuntime) globalThis.isTauri = true
  const nativeFetch = globalThis.fetch.bind(globalThis)
  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
  const responseFor = (method, rawPath) => {
    const url = new URL(rawPath, fixtureOrigin)
    const body = ${apiFixture.toString()}(fixture, method, url.pathname + url.search)
    return body === null ? null : new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    })
  }
  globalThis.fetch = async (input, init) => {
    const raw = input instanceof Request ? input.url : String(input)
    const url = new URL(raw, location.href)
    if (url.pathname === '/health' || url.pathname.startsWith('/api/')) {
      const response = responseFor(init?.method || (input instanceof Request ? input.method : 'GET'), url.pathname + url.search)
      if (response) return response
    }
    return nativeFetch(input, init)
  }
  localStorage.clear()
  sessionStorage.clear()
  localStorage.setItem('hc-theme', 'light')
  localStorage.setItem('hexclaw:welcomeRedirectDone', '1')
  sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
  history.replaceState(null, '', '/agents')
  const waitFor = async (read, label, timeout = 60000) => {
    const deadline = Date.now() + timeout
    let lastError
    while (Date.now() < deadline) {
      try {
        const value = read()
        if (value) return value
      } catch (error) {
        lastError = error
      }
      await sleep(80)
    }
    throw new Error('timed out waiting for ' + label + (lastError ? ': ' + lastError : ''))
  }
  const report = async (payload) => {
    const result = await nativeFetch(fixtureOrigin + '/__bug019__/report', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!result.ok) throw new Error('fixture report failed: ' + result.status)
  }
  const reportError = (error) => {
    const message = error instanceof Error ? [error.name + ': ' + error.message, error.stack].filter(Boolean).join('\\n') : String(error)
    void report({ stage: 'reference-fixture-error', message }).catch(() => {})
  }
  addEventListener('error', (event) => reportError(event.error || event.message))
  addEventListener('unhandledrejection', (event) => reportError(event.reason))
  const execute = async () => {
    if (document.readyState === 'loading') await new Promise((resolve) => addEventListener('DOMContentLoaded', resolve, { once: true }))
    // 原型 native 包只需复现既有 pane 状态；直接切换既有 screen，避免把
    // 原型脚本是否完成全量交互初始化混入四卡视觉门。
    await waitFor(() => document.querySelector('.screen[data-pane="agents"]'), 'agents reference screen')
    document.querySelectorAll('.screen').forEach((screen) => {
      screen.classList.toggle('on', screen.dataset.pane === 'agents')
    })
    document.getElementById('tbSection')?.replaceChildren(document.createTextNode('智能体'))
    await waitFor(() => document.querySelectorAll('.screen[data-pane="agents"] .agent-card').length === 4, 'four reference agent cards')
    await waitFor(() => document.querySelector('.screen[data-pane="agents"] .agent-card')?.textContent?.includes('日报分析师'), 'reference card text')
    await waitFor(() => document.fonts?.status === 'loaded', 'reference fonts')
    document.documentElement.dataset.theme = 'light'
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    await sleep(120)
    const snapshot = (${snapshotSource})()
    await report({
      stage: 'reference-ready',
      environment: {
        viewport: { width: innerWidth, height: innerHeight },
        devicePixelRatio,
        locale: navigator.language,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        route: location.pathname,
        isTauri: tauriRuntime,
        hasTauriInternals: tauriRuntime,
      },
      snapshot,
    })
  }
  void execute().catch(reportError)
})()
`
}

async function captureReference(fixture) {
  const externalRequests = []
  const browser = await webkit.launch()
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    colorScheme: 'light',
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
  })
  const page = await context.newPage()
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) externalRequests.push(request.url())
  })
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url())
    return ['127.0.0.1', 'localhost', '::1'].includes(url.hostname)
      ? route.continue()
      : route.abort('blockedbyclient')
  })
  try {
    await page.goto(`${fixture.origin}/app.html`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => typeof globalThis.showPane === 'function')
    await page.evaluate(() => globalThis.showPane('agents', '智能体'))
    await page.locator('.screen[data-pane="agents"] .agent-card').nth(0).waitFor({ state: 'visible' })
    await page.locator('.screen[data-pane="agents"] .agent-card').nth(3).waitFor({ state: 'visible' })
    await page.addStyleTag({
      content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}',
    })
    await page.evaluate(async () => {
      await document.fonts.ready
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    })
    const snapshot = await page.evaluate(snapshotFromDOM)
    const referencePath = join(evidenceRoot, 'reference.png')
    const pageReferencePath = join(evidenceRoot, 'page-reference.png')
    // 原型 locator 截图会按边框的向外取整多保留 2 个 DPR 像素；安装态由
    // native screencapture 按页面 bbox 裁剪。两端统一为同一 CSS clip，避免
    // 仅由截图边缘取整造成尺寸不等，保留真正内容差异。
    const grid = snapshot.absolute.grid
    await page.screenshot({
      path: referencePath,
      animations: 'disabled',
      caret: 'hide',
      clip: {
        x: Math.floor(grid.x),
        y: Math.floor(grid.y),
        width: Math.floor(grid.width),
        height: Math.ceil(grid.height),
      },
    })
    await page.screenshot({ path: pageReferencePath, animations: 'disabled', caret: 'hide' })
    return { snapshot, externalRequests, referencePath, pageReferencePath }
  } finally {
    await context.close()
    await browser.close()
  }
}

function prepareReferenceFrontend(sandbox, fixtureOrigin, data) {
  const frontend = join(nativeFrontendRoot, 'reference')
  cpSync(prototypeRoot, frontend, { recursive: true })
  const fixtureSource = renderReferenceFixture(fixtureOrigin, data)
  assert.doesNotMatch(fixtureSource, /<\/script>/i)
  assert.doesNotThrow(() => new Function(fixtureSource))
  const sourcePath = join(frontend, 'app.html')
  const indexPath = join(frontend, 'index.html')
  const inject = (html) => html.replace(
    '<head>',
    `<head>\n<style>*{animation:none!important;transition:none!important;caret-color:transparent!important}</style>\n<script>${fixtureSource}</script>`,
  )
  // Tauri 的 production WebView 在不同 frontendDist 形态下可能以 index.html
  // 或 app.html 作为入口；两份临时夹具都注入同一脚本，避免 native 门实际
  // 加载了未注入的原型页而只留下默认 chat 静态请求。
  writeFileSync(indexPath, inject(readFileSync(sourcePath, 'utf8')), { encoding: 'utf8', mode: 0o600 })
  writeFileSync(sourcePath, inject(readFileSync(sourcePath, 'utf8')), { encoding: 'utf8', mode: 0o600 })
  return {
    frontend,
    fixtureSha256: createHash('sha256').update(fixtureSource).digest('hex'),
    prototypeSha256: sha256File(sourcePath),
  }
}

function prepareFrontend(sandbox, fixtureOrigin, data) {
  const sourceFrontend = join(sandbox, 'frontend')
  const frontend = join(nativeFrontendRoot, 'implementation')
  cpSync(sourceFrontend, frontend, { recursive: true })
  const fixtureSource = renderInstalledFixture(fixtureOrigin, data)
  assert.doesNotMatch(fixtureSource, /<\/script>/i)
  assert.doesNotThrow(() => new Function(fixtureSource))
  const indexPath = join(frontend, 'index.html')
  const index = readFileSync(indexPath, 'utf8')
  const moduleEntry = index.match(/<script type="module" crossorigin src="\.\/assets\/([^"]+\.js)">/)
  assert.ok(moduleEntry, 'current-source module entry missing')
  const modulePath = join(frontend, 'assets', moduleEntry[1])
  let moduleSource = readFileSync(modulePath, 'utf8')
  const platformProbe = /function [A-Za-z_$][\w$]*\(\)\{return!!globalThis\.isTauri\}/g
  const probeMatches = moduleSource.match(platformProbe) || []
  assert.equal(probeMatches.length, 1, 'current-source platform probe shape changed')
  moduleSource = moduleSource
    .replace(platformProbe, (match) => match.replace('return!!globalThis.isTauri', 'return!1'))
    .replaceAll('http://localhost:16060', fixtureOrigin)
    .replaceAll('ws://localhost:16060', fixtureOrigin.replace('http://', 'ws://'))
    .replaceAll('ws://127.0.0.1:16060', fixtureOrigin.replace('http://', 'ws://'))
  writeFileSync(modulePath, moduleSource, { encoding: 'utf8', mode: 0o600 })
  writeFileSync(indexPath, index.replace('<head>', `<head>\n<style>*{animation:none!important;transition:none!important;caret-color:transparent!important}</style>\n<script>${fixtureSource}</script>`), { encoding: 'utf8', mode: 0o600 })
  return { frontend, modulePath, moduleSha256: sha256File(modulePath), fixtureSha256: createHash('sha256').update(fixtureSource).digest('hex') }
}

function nativeTargetTriple() {
  if (process.arch === 'arm64') return 'aarch64-apple-darwin'
  if (process.arch === 'x64') return 'x86_64-apple-darwin'
  throw new Error(`unsupported macOS architecture: ${process.arch}`)
}

function prepareSidecar(sandbox) {
  const triple = nativeTargetTriple()
  const source = join(srcTauriRoot, 'binaries', `hexclaw-${triple}`)
  assert.ok(existsSync(source), `support Sidecar is missing: ${relative(repoRoot, source)}`)
  const directory = join(sandbox, 'binaries')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const base = join(directory, 'hexclaw')
  const destination = `${base}-${triple}`
  copyFileSync(source, destination)
  chmodSync(destination, 0o700)
  return { base, destination, source, sha256: sha256File(destination), triple }
}

function writeOverlay(
  sandbox,
  frontend,
  sidecarBase,
  sidecarPort,
  fixtureOrigin,
  {
    productNameValue = productName,
    bundleIdentifierValue = bundleIdentifier,
    overlayName = 'tauri.bug019-agents.conf.json',
  } = {},
) {
  // `--config` 外置文件的相对资源基准由 Tauri 按配置目录解析；把本轮
  // overlay 放在 src-tauri 根；frontendDist 按仓库根相对路径传入，确保真正
  // 嵌入 Test.app 而不是被当作 devUrl URL。
  const overlay = join(srcTauriRoot, `.${runNonce}-${overlayName}`)
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "style-src-attr 'unsafe-inline'",
    `img-src 'self' data: blob: http://127.0.0.1:${sidecarPort} ${fixtureOrigin}`,
    `media-src 'self' data: blob: http://127.0.0.1:${sidecarPort} ${fixtureOrigin}`,
    `connect-src 'self' http://127.0.0.1:${sidecarPort} ws://127.0.0.1:${sidecarPort} ${fixtureOrigin}`,
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ')
  writeJSON(overlay, {
    productName: productNameValue,
    identifier: bundleIdentifierValue,
    build: { frontendDist: relative(repoRoot, frontend), beforeBuildCommand: '' },
    app: {
      windows: [
        {
          label: 'main',
          title: productNameValue,
          width: viewport.width,
          height: viewport.height,
          minWidth: viewport.width,
          minHeight: viewport.height,
          maxWidth: viewport.width,
          maxHeight: viewport.height,
          resizable: false,
          decorations: true,
          titleBarStyle: 'Overlay',
          hiddenTitle: true,
          center: true,
          visible: true,
        },
      ],
      security: { csp },
    },
    bundle: {
      targets: ['app'],
      createUpdaterArtifacts: false,
      externalBin: [relative(srcTauriRoot, sidecarBase)],
    },
    plugins: {
      updater: {
        endpoints: [`${fixtureOrigin}/updater`],
        dangerousInsecureTransportProtocol: true,
      },
    },
  })
  return overlay
}

function writeNativeBuildConfig(frontend, sidecarPort, fixtureOrigin, {
  productNameValue,
  bundleIdentifierValue,
}) {
  const configPath = join(srcTauriRoot, 'tauri.conf.json')
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "style-src-attr 'unsafe-inline'",
    `img-src 'self' data: blob: http://127.0.0.1:${sidecarPort} ${fixtureOrigin}`,
    `media-src 'self' data: blob: http://127.0.0.1:${sidecarPort} ${fixtureOrigin}`,
    `connect-src 'self' http://127.0.0.1:${sidecarPort} ws://127.0.0.1:${sidecarPort} ${fixtureOrigin}`,
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ')
  config.productName = productNameValue
  config.identifier = bundleIdentifierValue
  config.build = {
    ...config.build,
    // tauri::generate_context! 在编译期读取 tauri.conf.json；仅传 --config
    // overlay 不能替换已编译的资源映射，所以这里在临时构建前写入路径，
    // finally 原子恢复原文件。
    frontendDist: relative(srcTauriRoot, frontend),
    beforeBuildCommand: '',
    devUrl: null,
  }
  config.app = {
    ...config.app,
    windows: [{
      label: 'main',
      title: productNameValue,
      width: viewport.width,
      height: viewport.height,
      minWidth: viewport.width,
      minHeight: viewport.height,
      maxWidth: viewport.width,
      maxHeight: viewport.height,
      resizable: false,
      decorations: true,
      titleBarStyle: 'Overlay',
      hiddenTitle: true,
      center: true,
      visible: true,
    }],
    security: { ...(config.app?.security || {}), csp },
  }
  config.bundle = {
    ...config.bundle,
    targets: ['app'],
    createUpdaterArtifacts: false,
  }
  config.plugins = {
    ...config.plugins,
    updater: {
      ...(config.plugins?.updater || {}),
      endpoints: [`${fixtureOrigin}/updater`],
      dangerousInsecureTransportProtocol: true,
    },
  }
  writeJSON(configPath, config)
  return configPath
}

function appEnvironment(sandbox, sidecarPort, fixtureOrigin) {
  const temporary = join(sandbox, 'tmp')
  return {
    PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: 'zh_CN.UTF-8',
    LC_ALL: 'zh_CN.UTF-8',
    HOME: sandbox,
    USERPROFILE: sandbox,
    CFFIXED_USER_HOME: sandbox,
    TMPDIR: temporary,
    TEMP: temporary,
    TMP: temporary,
    USER: 'hexclaw-test',
    LOGNAME: 'hexclaw-test',
    HEXCLAW_TEST_MODE: '1',
    HEXCLAW_TEST_HOME: sandbox,
    HEXCLAW_SIDECAR_PORT: String(sidecarPort),
    HEXCLAW_DISABLE_BACKGROUND_EGRESS: '1',
    DINGTALK_LIVE_SEND: '0',
    HTTP_PROXY: fixtureOrigin,
    HTTPS_PROXY: fixtureOrigin,
    ALL_PROXY: fixtureOrigin,
    http_proxy: fixtureOrigin,
    https_proxy: fixtureOrigin,
    all_proxy: fixtureOrigin,
    NO_PROXY: '127.0.0.1,localhost,::1',
    no_proxy: '127.0.0.1,localhost,::1',
  }
}

async function waitForHealth(port, appProcess) {
  const deadline = Date.now() + 75_000
  while (Date.now() < deadline) {
    if (appProcess.exitCode !== null) throw new Error('Test.app exited before Sidecar health')
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) })
      if (response.ok) return
    } catch {
      // Sidecar is still starting.
    }
    await sleep(250)
  }
  throw new Error(`Sidecar health timed out on loopback port ${port}`)
}

async function waitForReport(state, appProcess, stage) {
  const deadline = Date.now() + 75_000
  while (Date.now() < deadline) {
    if (appProcess.exitCode !== null) throw new Error('Test.app exited before WKWebView report')
    const error = state.reports.find((entry) => entry.stage === 'fixture-error')
    if (error) throw new Error(`WKWebView fixture failed: ${error.message}`)
    const report = state.reports.find((entry) => entry.stage === stage)
    if (report) return report
    await sleep(100)
  }
  throw new Error(`timed out waiting for WKWebView report: ${stage}`)
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

async function stopOwnedSidecar(port, appBundle) {
  const stopped = []
  for (const pid of listenerPIDs(port)) {
    const command = processCommand(pid)
    if (!command.includes(`${appBundle}/Contents/MacOS/hexclaw serve --desktop`)) {
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
let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
let rows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] ?? []
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

function imageDimensions(path) {
  const output = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', path], { encoding: 'utf8' })
  const width = Number(output.match(/pixelWidth:\s*(\d+)/)?.[1])
  const height = Number(output.match(/pixelHeight:\s*(\d+)/)?.[1])
  assert.ok(Number.isFinite(width) && Number.isFinite(height), `invalid image dimensions: ${output}`)
  return { width, height }
}

function imageProfile(path) {
  const output = execFileSync('sips', ['-g', 'profile', path], { encoding: 'utf8' })
  return output.match(/profile:\s*(.+)/)?.[1]?.trim() || '<nil>'
}

function captureWindow(pid, destination) {
  const window = windowInfoForPID(pid)
  execFileSync('/usr/sbin/screencapture', ['-x', '-o', '-l', String(window.id), destination])
  assert.ok(existsSync(destination), `native screenshot missing: ${destination}`)
  assert.ok(statSync(destination).size > 1024, `native screenshot is empty: ${destination}`)
  return { ...window, pixels: imageDimensions(destination), bytes: statSync(destination).size }
}

function cropInstalledGrid(fullPath, destination, report) {
  const full = imageDimensions(fullPath)
  const expectedFull = {
    width: Math.round(report.environment.viewport.width * report.environment.devicePixelRatio),
    height: Math.round(report.environment.viewport.height * report.environment.devicePixelRatio),
  }
  assert.deepEqual(full, expectedFull, 'native screenshot must equal WKWebView pixel viewport')
  const grid = report.snapshot.absolute.grid
  const cropOffsetX = Math.round(grid.x * report.environment.devicePixelRatio)
  const cropOffsetY = Math.round(grid.y * report.environment.devicePixelRatio)
  const cropWidth = Math.round(grid.width * report.environment.devicePixelRatio)
  const cropHeight = Math.round(grid.height * report.environment.devicePixelRatio)
  execFileSync('sips', [
    '-c', String(cropHeight), String(cropWidth), '--cropOffset', String(cropOffsetY), String(cropOffsetX),
    fullPath, '--out', destination,
  ], { stdio: 'pipe' })
  assert.deepEqual(imageDimensions(destination), { width: cropWidth, height: cropHeight })
  return { full, crop: { width: cropWidth, height: cropHeight } }
}

function pixelDiff(reference, implementation, output) {
  const result = spawnSync('uv', [
    'run', '--offline', '--isolated', '--python', '3.12', '--with', 'pillow==10.4.0',
    'python', pixelDiffTool, reference, implementation, output, '8',
  ], { cwd: repoRoot, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return JSON.parse(result.stdout.trim())
}

function differences(reference, implementation, tolerance = 0, prefix = '$') {
  if (typeof reference === 'number' && typeof implementation === 'number') {
    return Math.abs(reference - implementation) <= tolerance
      ? []
      : [`${prefix}: reference=${reference} implementation=${implementation}`]
  }
  if (Array.isArray(reference) && Array.isArray(implementation)) {
    const output = []
    if (reference.length !== implementation.length) output.push(`${prefix}.length: reference=${reference.length} implementation=${implementation.length}`)
    for (let index = 0; index < Math.min(reference.length, implementation.length); index += 1) {
      output.push(...differences(reference[index], implementation[index], tolerance, `${prefix}[${index}]`))
    }
    return output
  }
  if (reference && implementation && typeof reference === 'object' && typeof implementation === 'object') {
    const output = []
    const keys = [...new Set([...Object.keys(reference), ...Object.keys(implementation)])].sort()
    for (const key of keys) output.push(...differences(reference[key], implementation[key], tolerance, `${prefix}.${key}`))
    return output
  }
  return Object.is(reference, implementation)
    ? []
    : [`${prefix}: reference=${JSON.stringify(reference)} implementation=${JSON.stringify(implementation)}`]
}

function stateDifferences(reference, implementation) {
  const expected = [
    ['bar-chart', [true, false]],
    ['mail', [true, false, false]],
    ['avatar-graduation', [true, false, false]],
    ['avatar-graduation', [false, false, false]],
  ]
  const output = []
  for (let index = 0; index < expected.length; index += 1) {
    if (reference.icons[index] !== expected[index][0]) output.push(`reference.icons[${index}]=${reference.icons[index]}`)
    if (implementation.icons[index] !== expected[index][0]) output.push(`implementation.icons[${index}]=${implementation.icons[index]}`)
    const expectedPrimary = expected[index][1]
    for (let action = 0; action < expectedPrimary.length; action += 1) {
      if (Boolean(reference.actionStates[index]?.[action]?.primary) !== expectedPrimary[action]) output.push(`reference.actionStates[${index}][${action}] primary mismatch`)
      if (Boolean(implementation.actionStates[index]?.[action]?.primary) !== expectedPrimary[action]) output.push(`implementation.actionStates[${index}][${action}] primary mismatch`)
    }
  }
  return output
}

async function main() {
  assert.equal(process.platform, 'darwin', 'installed Test.app gate is macOS-only')
  mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 })
  const sandbox = mkdtempSync(join(tmpdir(), 'hexclaw-bug019-agents.'))
  chmodSync(sandbox, 0o700)
  assert.equal(existsSync(nativeFrontendRoot), false, `temporary native frontend already exists: ${nativeFrontendRoot}`)
  mkdirSync(join(sandbox, '.hexclaw'), { recursive: true, mode: 0o700 })
  mkdirSync(join(sandbox, 'tmp'), { recursive: true, mode: 0o700 })
  // 每轮使用独立 Cargo target，避免其他本地安装门共享 artifact lock；Rust registry
  // 仍复用宿主缓存，Test.app、前端、配置和运行时 HOME 由本轮独占。
  const cargoTarget = join(sandbox, 'cargo-target')
  const appBundle = join(cargoTarget, `release/bundle/macos/${productName}.app`)
  const referenceAppBundle = join(cargoTarget, `release/bundle/macos/${referenceProductName}.app`)
  const fixturePort = await reserveLoopbackPort()
  const sidecarPort = await reserveLoopbackPort()
  assert.notEqual(fixturePort, sidecarPort)
  const data = fixtureData()
  const fixture = createLoopbackFixture(fixturePort, data)
  let referenceAppProcess = null
  let referenceAppStarted = false
  let referenceAppLog = null
  let referenceAppLogPath = ''
  let referenceSidecarStopped = false
  let appProcess = null
  let appStarted = false
  let appLog = null
  let appLogPath = ''
  let appSidecarStopped = false
  let failure = null
  let result = null
  let buildReceipts = []
  let stoppedSidecars = []
  let referenceOverlayPath = ''
  let overlayPath = ''
  const tauriConfigPath = join(srcTauriRoot, 'tauri.conf.json')
  const originalTauriConfig = readFileSync(tauriConfigPath)
  const originalTauriConfigMode = statSync(tauriConfigPath).mode
  let tauriConfigRestored = false
  const startedAt = Date.now()

  try {
    await fixture.listen()
    const browserReference = await captureReference(fixture)
    assert.deepEqual(browserReference.externalRequests, [], 'prototype attempted external network')
    writeJSON(join(evidenceRoot, 'reference-bbox-computed-style.json'), browserReference.snapshot)

    const configPath = join(sandbox, '.hexclaw/hexclaw.yaml')
    writeFileSync(configPath, renderConfig(sandbox, sidecarPort), { encoding: 'utf8', mode: 0o600 })
    chmodSync(configPath, 0o600)
    const sidecar = prepareSidecar(sandbox)
    const offlineEnv = {
      ...process.env,
      CARGO_NET_OFFLINE: 'true',
      CARGO_TARGET_DIR: cargoTarget,
      PNPM_CONFIG_OFFLINE: 'true',
      npm_config_offline: 'true',
      GOENV: 'off',
      GOPROXY: 'off',
      GOSUMDB: 'off',
    }
    const frontendBuild = await runCommand('pnpm', ['exec', 'vite', 'build', '--outDir', join(sandbox, 'frontend'), '--emptyOutDir'], { env: offlineEnv })
    buildReceipts.push(frontendBuild)
    const referenceFrontend = prepareReferenceFrontend(sandbox, fixture.origin, data)
    const frontend = prepareFrontend(sandbox, fixture.origin, data)
    rmSync(referenceAppBundle, { recursive: true, force: true })
    rmSync(appBundle, { recursive: true, force: true })
    writeNativeBuildConfig(referenceFrontend.frontend, sidecarPort, fixture.origin, {
      productNameValue: referenceProductName,
      bundleIdentifierValue: referenceBundleIdentifier,
    })
    buildReceipts.push(await runCommand('pnpm', ['exec', 'tauri', 'build', '--bundles', 'app'], { env: offlineEnv }))
    writeNativeBuildConfig(frontend.frontend, sidecarPort, fixture.origin, {
      productNameValue: productName,
      bundleIdentifierValue: bundleIdentifier,
    })
    buildReceipts.push(await runCommand('pnpm', ['exec', 'tauri', 'build', '--bundles', 'app'], { env: offlineEnv }))
    writeFileSync(tauriConfigPath, originalTauriConfig, { mode: originalTauriConfigMode })
    chmodSync(tauriConfigPath, originalTauriConfigMode)
    tauriConfigRestored = true

    const referenceInfoPlist = join(referenceAppBundle, 'Contents/Info.plist')
    const referenceExecutable = join(referenceAppBundle, 'Contents/MacOS/hexclaw-desktop')
    const referenceBundledSidecar = join(referenceAppBundle, 'Contents/MacOS/hexclaw')
    assert.ok(existsSync(referenceInfoPlist), 'reference Test.app Info.plist missing')
    assert.ok(existsSync(referenceExecutable), 'reference Test.app executable missing')
    assert.ok(existsSync(referenceBundledSidecar), 'reference Test.app sidecar missing')
    const referenceIdentifier = execFileSync('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', referenceInfoPlist], { encoding: 'utf8' }).trim()
    assert.equal(referenceIdentifier, referenceBundleIdentifier)
    const referenceBundledSidecarSha256 = sha256File(referenceBundledSidecar)

    const infoPlist = join(appBundle, 'Contents/Info.plist')
    const executable = join(appBundle, 'Contents/MacOS/hexclaw-desktop')
    const bundledSidecar = join(appBundle, 'Contents/MacOS/hexclaw')
    assert.ok(existsSync(infoPlist), 'Test.app Info.plist missing')
    assert.ok(existsSync(executable), 'Test.app executable missing')
    assert.ok(existsSync(bundledSidecar), 'Test.app sidecar missing')
    const identifier = execFileSync('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', infoPlist], { encoding: 'utf8' }).trim()
    assert.equal(identifier, bundleIdentifier)
    const bundledSidecarSha256 = sha256File(bundledSidecar)
    assert.equal(bundledSidecarSha256, referenceBundledSidecarSha256, 'reference and implementation must bundle the same sidecar')
    writeJSON(join(evidenceRoot, 'native-asset-probe.json'), {
      reference: probeNativeBundle(referenceExecutable),
      implementation: probeNativeBundle(executable),
      frontendDist: relative(repoRoot, referenceFrontend.frontend),
      implementationFrontendDist: relative(repoRoot, frontend.frontend),
      overlayDirectory: srcTauriRoot,
      bundledSidecarSha256: { reference: referenceBundledSidecarSha256, implementation: bundledSidecarSha256 },
      sourceSidecarSha256AfterBuild: sha256File(sidecar.source),
    })

    const referenceStart = {
      blockedExternal: fixture.state.blockedExternalRequests.length,
      unexpected: fixture.state.unexpectedRequests.length,
    }
    referenceAppLogPath = join(sandbox, 'reference-app.log')
    referenceAppLog = createWriteStream(referenceAppLogPath, { flags: 'wx', mode: 0o600 })
    referenceAppProcess = spawn(referenceExecutable, ['-AppleLanguages', '(zh-Hans)', '-AppleLocale', 'zh_CN'], {
      cwd: sandbox,
      env: appEnvironment(sandbox, sidecarPort, fixture.origin),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    referenceAppStarted = true
    referenceAppProcess.stdout.pipe(referenceAppLog, { end: false })
    referenceAppProcess.stderr.pipe(referenceAppLog, { end: false })
    await waitForHealth(sidecarPort, referenceAppProcess)
    assert.equal(listenerPIDs(sidecarPort).length, 1, 'reference Test.app must own one sidecar listener')
    const nativeReferenceReport = await waitForReport(fixture.state, referenceAppProcess, 'reference-ready')
    assert.deepEqual(nativeReferenceReport.environment, {
      viewport,
      devicePixelRatio: deviceScaleFactor,
      locale: 'zh-CN',
      timezone: 'Asia/Shanghai',
      route: '/agents',
      isTauri: true,
      hasTauriInternals: true,
    })
    assert.equal(nativeReferenceReport.snapshot.semantics.length, 4)
    const fullReferencePath = join(evidenceRoot, 'full-reference-window.png')
    const nativeReferencePath = join(evidenceRoot, 'reference-native.png')
    const nativeReferenceWindow = captureWindow(referenceAppProcess.pid, fullReferencePath)
    const nativeReferenceCrop = cropInstalledGrid(fullReferencePath, nativeReferencePath, nativeReferenceReport)
    writeJSON(join(evidenceRoot, 'reference-native-bbox-computed-style.json'), nativeReferenceReport.snapshot)
    await stopProcess(referenceAppProcess)
    stoppedSidecars.push(...await stopOwnedSidecar(sidecarPort, referenceAppBundle))
    referenceSidecarStopped = true

    const implementationStart = {
      blockedExternal: fixture.state.blockedExternalRequests.length,
      unexpected: fixture.state.unexpectedRequests.length,
    }
    appLogPath = join(sandbox, 'app.log')
    appLog = createWriteStream(appLogPath, { flags: 'wx', mode: 0o600 })
    appProcess = spawn(executable, ['-AppleLanguages', '(zh-Hans)', '-AppleLocale', 'zh_CN'], {
      cwd: sandbox,
      env: appEnvironment(sandbox, sidecarPort, fixture.origin),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    appStarted = true
    appProcess.stdout.pipe(appLog, { end: false })
    appProcess.stderr.pipe(appLog, { end: false })
    await waitForHealth(sidecarPort, appProcess)
    const sidecarPIDs = listenerPIDs(sidecarPort)
    assert.equal(sidecarPIDs.length, 1, 'Test.app must own one sidecar listener')
    const nativeReport = await waitForReport(fixture.state, appProcess, 'native-ready')
    assert.deepEqual(nativeReport.environment, {
      viewport,
      devicePixelRatio: deviceScaleFactor,
      locale: 'zh-CN',
      timezone: 'Asia/Shanghai',
      route: '/agents',
      isTauri: true,
      hasTauriInternals: true,
    })
    assert.equal(nativeReport.snapshot.semantics.length, 4)

    const fullInstalledPath = join(evidenceRoot, 'full-installed-window.png')
    const implementationPath = join(evidenceRoot, 'implementation.png')
    const pixelDiffPath = join(evidenceRoot, 'pixel-diff.png')
    const nativeWindow = captureWindow(appProcess.pid, fullInstalledPath)
    const crop = cropInstalledGrid(fullInstalledPath, implementationPath, nativeReport)
    const pixels = pixelDiff(nativeReferencePath, implementationPath, pixelDiffPath)
    const renderingProfiles = {
      reference: imageProfile(nativeReferencePath),
      installed: imageProfile(implementationPath),
    }
    const semanticDifferences = differences(nativeReferenceReport.snapshot.semantics, nativeReport.snapshot.semantics)
    const geometryDifferences = differences(nativeReferenceReport.snapshot.relative, nativeReport.snapshot.relative, 1)
    const styleDifferences = differences(nativeReferenceReport.snapshot.styles, nativeReport.snapshot.styles)
    const iconAndButtonDifferences = stateDifferences(nativeReferenceReport.snapshot, nativeReport.snapshot)
    const referenceBlockedExternalRequests = fixture.state.blockedExternalRequests.slice(referenceStart.blockedExternal)
    const implementationBlockedExternalRequests = fixture.state.blockedExternalRequests.slice(implementationStart.blockedExternal)
    const referenceUnexpectedRequests = fixture.state.unexpectedRequests.slice(referenceStart.unexpected, implementationStart.unexpected)
    const implementationUnexpectedRequests = fixture.state.unexpectedRequests.slice(implementationStart.unexpected)
    const externalRequestDifferences = [
      ...browserReference.externalRequests.map((url) => `browser reference blocked ${url}`),
      ...referenceBlockedExternalRequests.map((entry) => `native reference blocked ${JSON.stringify(entry)}`),
      ...implementationBlockedExternalRequests.map((entry) => `installed blocked ${JSON.stringify(entry)}`),
    ]
    const networkUnexpected = [
      ...referenceUnexpectedRequests.map((entry) => `native reference unexpected ${entry}`),
      ...implementationUnexpectedRequests.map((entry) => `installed unexpected ${entry}`),
    ]
    const nativeLayoutPass = semanticDifferences.length === 0 && geometryDifferences.length === 0 && styleDifferences.length === 0 && iconAndButtonDifferences.length === 0 && externalRequestDifferences.length === 0 && networkUnexpected.length === 0
    const comparableRaster = renderingProfiles.reference === renderingProfiles.installed
    const visualStatus = !comparableRaster
      ? 'NOT_COMPARABLE_NATIVE_RASTER'
      : pixels.changed_pixel_ratio <= maxChangedPixelRatio ? 'PASS' : 'FAIL_NATIVE_RASTER'
    // 参考与安装态均由临时 Tauri Test.app 的 macOS WKWebView 窗口采集，
    // 只有同一 ICC profile 且像素门通过时才允许声明全视觉 PASS。
    const status = nativeLayoutPass
      ? visualStatus === 'PASS' ? 'PASS' : visualStatus === 'NOT_COMPARABLE_NATIVE_RASTER' ? 'PASS_SCOPED_NATIVE_LAYOUT' : 'RED'
      : 'RED'
    const report = {
      schemaVersion: 1,
      bug: 'BUG-20260723-019',
      status,
      boundary: 'current-worktree temporary Test.app / real macOS WKWebView / native window capture',
      durationMs: Date.now() - startedAt,
      environment: { viewport, deviceScaleFactor, locale: 'zh-CN', timezone: 'Asia/Shanghai', colorScheme: 'light', reducedMotion: 'reduce' },
      semanticDifferences,
      geometryDifferences,
      styleDifferences,
      iconAndButtonDifferences,
      externalRequestDifferences,
      networkUnexpected,
      visual: {
        status: visualStatus,
        comparableRaster,
        renderingProfiles,
        reason: comparableRaster
          ? visualStatus === 'PASS' ? '' : `Native reference and installed captures share ${renderingProfiles.reference}, but changed pixel ratio ${pixels.changed_pixel_ratio} exceeds ${maxChangedPixelRatio}.`
          : 'Native reference and installed captures have different ICC profiles; raw pixel diff is retained as diagnostic only.',
      },
      pixels: { ...pixels, maximumChangedPixelRatio: maxChangedPixelRatio, pass: pixels.changed_pixel_ratio <= maxChangedPixelRatio },
      reference: {
        snapshot: nativeReferenceReport.snapshot,
        externalRequests: referenceBlockedExternalRequests,
        browserSnapshot: browserReference.snapshot,
        browserExternalRequests: browserReference.externalRequests,
        report: nativeReferenceReport,
        nativeWindow: nativeReferenceWindow,
        crop: nativeReferenceCrop,
      },
      installed: { report: nativeReport, nativeWindow, crop },
      fixture: { data, receipts: fixture.state },
      isolation: {
        testHomeMode: '0700',
        configMode: '0600',
        fixturePort,
        sidecarPort,
        realWKWebView: true,
        applicationsDirectoryTouched: false,
        userHomeReadOrWritten: false,
        externalNetworkAttempts: fixture.state.blockedExternalRequests,
        realModelInvocations: 0,
        realIMInvocations: 0,
      },
      files: {
        reference: 'reference-native.png',
        browserReference: 'reference.png',
        implementation: 'implementation.png',
        pixelDiff: 'pixel-diff.png',
        renderingProfiles: 'bbox-computed-style.json#/report/visual/renderingProfiles',
        fullReferenceWindow: 'full-reference-window.png',
        fullInstalledWindow: 'full-installed-window.png',
        referenceNativeBboxComputedStyle: 'reference-native-bbox-computed-style.json',
        referenceBboxComputedStyle: 'reference-bbox-computed-style.json',
        bboxComputedStyle: 'bbox-computed-style.json',
        buildProvenance: 'build-provenance.json',
        appLog: 'app.log',
        cleanup: 'cleanup.json',
      },
    }
    writeJSON(join(evidenceRoot, 'bbox-computed-style.json'), { reference: nativeReferenceReport, installed: nativeReport, report })
    writeJSON(join(evidenceRoot, 'build-provenance.json'), {
      bug: 'BUG-20260723-019',
      productName,
      bundleIdentifier: identifier,
      referenceProductName,
      referenceBundleIdentifier: referenceIdentifier,
      desktopHead: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim(),
      prototypeSha256: sha256File(join(prototypeRoot, 'app.html')),
      referenceFixtureSha256: referenceFrontend.fixtureSha256,
      referenceAppExecutableSha256: sha256File(referenceExecutable),
      frontendModuleSha256: frontend.moduleSha256,
      fixtureSha256: frontend.fixtureSha256,
      sidecarSha256: sidecar.sha256,
      appExecutableSha256: sha256File(executable),
      buildCommands: buildReceipts.map(({ command, args, code, durationMs }) => ({ command, args, code, durationMs })),
      source: 'current worktree Vite build; no pre-existing dist reused',
    })
    result = report
    process.stdout.write(`\nBUG-20260723-019 installed ${status}: ${relative(repoRoot, evidenceRoot)}\n`)
  } catch (error) {
    failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  } finally {
    if (failure && referenceAppProcess && referenceAppProcess.exitCode === null) {
      try {
        captureWindow(referenceAppProcess.pid, join(evidenceRoot, 'failure-reference-window.png'))
      } catch {
        // 原生参考窗口可能在启动失败前尚未出现。
      }
    }
    if (failure && appProcess && appProcess.exitCode === null) {
      try {
        captureWindow(appProcess.pid, join(evidenceRoot, 'failure-window.png'))
      } catch {
        // The app may have exited before a native window was available.
      }
    }
    await stopProcess(referenceAppProcess).catch((error) => { if (!failure) failure = String(error) })
    await stopProcess(appProcess).catch((error) => { if (!failure) failure = String(error) })
    if (referenceAppLog) await new Promise((resolveEnd) => referenceAppLog.end(resolveEnd))
    if (appLog) await new Promise((resolveEnd) => appLog.end(resolveEnd))
    if (referenceAppStarted && !referenceSidecarStopped) {
      try {
        stoppedSidecars.push(...await stopOwnedSidecar(sidecarPort, referenceAppBundle))
        referenceSidecarStopped = true
      } catch (error) {
        if (!failure) failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      }
    }
    if (appStarted && !appSidecarStopped) {
      try {
        stoppedSidecars.push(...await stopOwnedSidecar(sidecarPort, appBundle))
        appSidecarStopped = true
      } catch (error) {
        if (!failure) failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      }
    }
    await fixture.close().catch((error) => { if (!failure) failure = String(error) })
    if (referenceAppLogPath && existsSync(referenceAppLogPath)) writeFileSync(join(evidenceRoot, 'reference-app.log'), sanitize(readFileSync(referenceAppLogPath, 'utf8'), sandbox), { encoding: 'utf8', mode: 0o600 })
    if (appLogPath && existsSync(appLogPath)) writeFileSync(join(evidenceRoot, 'app.log'), sanitize(readFileSync(appLogPath, 'utf8'), sandbox), { encoding: 'utf8', mode: 0o600 })
    writeFileSync(join(evidenceRoot, 'build.log'), sanitize(buildReceipts.map((receipt) => receipt.output || '').join('\n'), sandbox), { encoding: 'utf8', mode: 0o600 })
    const referenceAppBundleExistedBeforeCleanup = existsSync(referenceAppBundle)
    const appBundleExistedBeforeCleanup = existsSync(appBundle)
    const nativeFrontendExistedBeforeCleanup = existsSync(nativeFrontendRoot)
    rmSync(referenceAppBundle, { recursive: true, force: true })
    rmSync(appBundle, { recursive: true, force: true })
    const referenceAppBundleRemoved = !existsSync(referenceAppBundle)
    const appBundleRemoved = !existsSync(appBundle)
    rmSync(nativeFrontendRoot, { recursive: true, force: true })
    const nativeFrontendRemoved = !existsSync(nativeFrontendRoot)
    const referenceOverlayExistedBeforeCleanup = Boolean(referenceOverlayPath && existsSync(referenceOverlayPath))
    const overlayExistedBeforeCleanup = Boolean(overlayPath && existsSync(overlayPath))
    if (referenceOverlayPath) rmSync(referenceOverlayPath, { force: true })
    if (overlayPath) rmSync(overlayPath, { force: true })
    const referenceOverlayRemoved = !referenceOverlayPath || !existsSync(referenceOverlayPath)
    const overlayRemoved = !overlayPath || !existsSync(overlayPath)
    if (!tauriConfigRestored) {
      writeFileSync(tauriConfigPath, originalTauriConfig, { mode: originalTauriConfigMode })
      chmodSync(tauriConfigPath, originalTauriConfigMode)
      tauriConfigRestored = true
    }
    rmSync(sandbox, { recursive: true, force: true })
    writeJSON(join(evidenceRoot, 'cleanup.json'), {
      status: failure ? 'FAIL' : result?.status || 'NOT_PASS',
      failure,
      referenceAppProcessStopped: !referenceAppProcess || referenceAppProcess.exitCode !== null || referenceAppProcess.signalCode !== null,
      appProcessStopped: !appProcess || appProcess.exitCode !== null || appProcess.signalCode !== null,
      sidecarPortReleased: listenerPIDs(sidecarPort).length === 0,
      fixtureClosed: true,
      referenceAppBundleExistedBeforeCleanup,
      referenceAppBundleRemoved,
      appBundleExistedBeforeCleanup,
      appBundleRemoved,
      nativeFrontendExistedBeforeCleanup,
      nativeFrontendRemoved,
      referenceOverlayExistedBeforeCleanup,
      referenceOverlayRemoved,
      overlayExistedBeforeCleanup,
      overlayRemoved,
      tauriConfigRestored,
      sandboxRemoved: !existsSync(sandbox),
      stoppedSidecars,
      applicationsDirectoryTouched: false,
      userHomeReadOrWritten: false,
    })
    if (!result) {
      writeJSON(join(evidenceRoot, 'summary.json'), {
        bug: 'BUG-20260723-019',
        status: 'BLOCKED',
        error: failure,
        evidence: 'installed four-card Test.app gate did not produce native-ready report',
        isolation: { fixturePort, sidecarPort, applicationsDirectoryTouched: false, userHomeReadOrWritten: false },
        fixtureReceipts: fixture.state,
      })
    } else {
      writeJSON(join(evidenceRoot, 'summary.json'), { ...result, failure })
    }
    writeFileSync(
      join(evidenceRoot, 'README.md'),
      [
        '# BUG-20260723-019 installed Test.app evidence',
        '',
        `- Status: **${failure ? 'BLOCKED' : result?.status || 'NOT_PASS'}**`,
        '- Boundary: temporary native reference Test.app and current-source implementation Test.app, both real macOS WKWebView windows, loopback-only fixture.',
        '- Fixture: the same authoritative four-card data and light state drive both native reference and installed implementation.',
        '- Native target scope: four-card semantics, geometry, computed styles, stable icon/button state, and loopback/cleanup gates.',
        '- Raster gate: reference-native.png and implementation.png are both native macOS window captures; reference.png is retained as the browser paired artifact.',
        '- If native ICC profiles differ, raw pixel diff remains diagnostic and visual status is NOT_COMPARABLE_NATIVE_RASTER; if profiles match, a changed ratio above the threshold is RED.',
        '- No /Applications app, real user HOME, real model, IM, or external network is used.',
        '- Evidence files: summary.json, bbox-computed-style.json, reference-native.png, implementation.png, pixel-diff.png.',
        '',
      ].join('\\n'),
    )
  }
  if (failure) throw new Error(failure)
  if (!String(result?.status || '').startsWith('PASS')) throw new Error(`BUG-20260723-019 installed gate ${result?.status || 'NOT_PASS'}`)
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`)
  process.exitCode = 1
})
