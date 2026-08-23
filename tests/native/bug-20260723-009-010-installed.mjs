#!/usr/bin/env node

/**
 * BUG-20260723-009/010 的真实安装态 MCP 验收。
 *
 * 本 harness 每轮从当前 worktree 构建唯一 Bundle ID 的临时 Test.app，使用真实 Tauri
 * WKWebView、独立 HOME、loopback fixture/sidecar 和 macOS 窗口截图。它不读取或覆盖
 * /Applications，不接触真实用户数据、模型、IM 或外部网络；任何内容/布局差异均保留
 * 为 RED，不能用脚本注入 DOM 或共享安装包截图伪造 PASS。
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
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
const evidenceRoot = join(repoRoot, 'test/evidence/bug-20260723-009-010-current-source/native')
const pixelDiffTool = join(repoRoot, 'tests/e2e/tools/visual_pixel_diff.py')
const fixtureId = 'bug-20260723-009-010-homomorphic-v2'
const runNonce = `${Date.now()}-${process.pid}`
const productName = `HexClaw MCP Test ${runNonce}`
const bundleIdentifier = `com.hexclaw.desktop.bug-20260723-009-010-${process.pid}`
const viewport = { width: 1440, height: 960 }
const deviceScaleFactor = 1
const commandTimeoutMs = 15 * 60_000
const maxChangedPixelRatio = 0.01

const mcpServers = [
  {
    name: 'filesystem',
    description: 'stdio · npx -y @modelcontextprotocol/server-filesystem ~/Documents',
    status: 'connected',
  },
  {
    name: 'postgres-readonly',
    description: 'stdio · 只读数据库工具 · 3 个工具',
    status: 'pending_authorization',
  },
]

const mcpTools = [
  {
    name: 'filesystem.read_file',
    description: '读取允许目录内的文件内容',
    input_schema: {
      properties: { path: { type: 'string', description: '绝对路径' } },
    },
  },
  {
    name: 'postgres.query',
    description: '执行只读 SQL 查询',
    input_schema: {
      properties: { sql: { type: 'string' }, limit: { type: 'number', default: 100 } },
    },
  },
]

const styleKeys = [
  'display',
  'position',
  'boxSizing',
  'width',
  'height',
  'minWidth',
  'minHeight',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'gap',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'borderRadius',
  'backgroundColor',
  'color',
  'fontSize',
  'fontWeight',
  'lineHeight',
  'overflowX',
  'whiteSpace',
]

const sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds))

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function sha256File(file) {
  return existsSync(file) ? sha256(readFileSync(file)) : null
}

function sanitize(value, sandbox = '') {
  let text = String(value ?? '')
    .replaceAll(repoRoot, '<hexclaw-desktop>')
    .replaceAll(docsRoot, '<hexclaw-docs>')
  if (sandbox) text = text.replaceAll(sandbox, '<sandbox>')
  const userPathPattern = sep === '\\' ? /[A-Za-z]:\\Users\\[^\\\s]+/g : /\/Users\/[^/\s]+/g
  return text.replace(userPathPattern, '<user-home>')
}

function sanitizedValue(value, sandbox = '') {
  return JSON.parse(sanitize(JSON.stringify(value), sandbox))
}

function writeJson(file, value, sandbox = '') {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(file, `${JSON.stringify(sanitizedValue(value, sandbox), null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
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
      rejectCommand(new Error(`${command} timed out after ${options.timeoutMs || commandTimeoutMs}ms`))
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

function listenerPids(port) {
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

function contentType(file) {
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
    }[extname(file).toLowerCase()] || 'application/octet-stream'
  )
}

function apiFixture(method, rawPath) {
  const url = new URL(rawPath, 'http://fixture.invalid')
  const path = url.pathname
  if (path === '/health') return { status: 'ok' }
  if (path === '/api/v1/config') {
    return {
      general: { language: 'zh-CN', welcomeCompleted: true },
      llm: { default: '', providers: {}, routing: { enabled: false }, cache: { enabled: false } },
      security: {
        gateway_enabled: true,
        injection_detection: true,
        pii_filter: false,
        content_filter: true,
        rate_limit_rpm: 60,
      },
      notification: { system_enabled: false, sound_enabled: false, agent_complete: false },
      mcp: { enabled: true },
      memory: { enabled: false },
      sandbox: { network_enabled: false, allowed_paths: [] },
    }
  }
  if (path === '/api/v1/config/llm') {
    return { default: '', providers: {}, routing: { enabled: false }, cache: { enabled: false } }
  }
  if (path === '/api/v1/ollama/status') return { running: false, associated: false, models: [] }
  if (path === '/api/v1/streams/active') return { streams: [], total: 0 }
  if (path === '/api/v1/skills') return { skills: [], total: 0 }
  if (path === '/api/v1/mcp/servers') return { servers: mcpServers, total: mcpServers.length }
  if (path === '/api/v1/mcp/status') {
    return {
      statuses: { filesystem: 'connected', 'postgres-readonly': 'pending_authorization' },
      total: mcpServers.length,
    }
  }
  if (path === '/api/v1/mcp/tools') return { tools: mcpTools, total: mcpTools.length }
  if (path === '/api/v1/clawhub/search') return { skills: [], total: 0 }
  if (method === 'GET' && path.startsWith('/api/')) return {}
  return null
}

function createFixtureServer(port) {
  const state = {
    reports: [],
    released: new Set(),
    apiRequests: [],
    staticRequests: [],
    unexpectedRequests: [],
    blockedExternalRequests: [],
  }
  const server = createServer(async (request, response) => {
    try {
      const rawUrl = request.url || '/'
      if (request.method === 'CONNECT' || /^https?:\/\//i.test(rawUrl)) {
        state.blockedExternalRequests.push({ method: request.method, target: rawUrl.slice(0, 300) })
        response.writeHead(502, { connection: 'close' })
        response.end()
        return
      }
      const url = new URL(rawUrl, `http://127.0.0.1:${port}`)
      if (request.method === 'OPTIONS') {
        response.writeHead(204, {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET,POST,OPTIONS',
          'access-control-allow-headers': 'content-type',
        })
        response.end()
        return
      }
      if (request.method === 'POST' && url.pathname === '/__bug009010__/report') {
        const chunks = []
        for await (const chunk of request) chunks.push(chunk)
        state.reports.push(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
        const body = JSON.stringify({ ok: true })
        response.writeHead(200, { 'access-control-allow-origin': '*', 'content-type': 'application/json' })
        response.end(body)
        return
      }
      if (request.method === 'GET' && url.pathname === '/__bug009010__/gate') {
        const stage = url.searchParams.get('stage') || ''
        response.writeHead(200, { 'access-control-allow-origin': '*', 'content-type': 'application/json' })
        response.end(JSON.stringify({ released: state.released.has(stage) }))
        return
      }
      if (request.method === 'GET' && url.pathname === '/updater') {
        response.writeHead(204, { 'access-control-allow-origin': '*' })
        response.end()
        return
      }
      if (request.method === 'GET' && url.pathname === '/app.html') {
        const file = join(prototypeRoot, 'app.html')
        const body = readFileSync(file)
        state.staticRequests.push(url.pathname)
        response.writeHead(200, { 'content-type': contentType(file), 'content-length': body.length })
        response.end(body)
        return
      }
      if (request.method === 'GET' && !url.pathname.startsWith('/api/')) {
        const file = resolve(prototypeRoot, `.${decodeURIComponent(url.pathname)}`)
        if (file.startsWith(`${prototypeRoot}/`) && existsSync(file)) {
          const body = readFileSync(file)
          state.staticRequests.push(url.pathname)
          response.writeHead(200, { 'content-type': contentType(file), 'content-length': body.length })
          response.end(body)
          return
        }
      }
      if (url.pathname.startsWith('/api/') || url.pathname === '/health') {
        state.apiRequests.push(`${request.method} ${url.pathname}${url.search}`)
        const payload = apiFixture(request.method || 'GET', `${url.pathname}${url.search}`)
        if (payload !== null) {
          const body = JSON.stringify(payload)
          response.writeHead(200, { 'access-control-allow-origin': '*', 'content-type': 'application/json' })
          response.end(body)
          return
        }
      }
      state.unexpectedRequests.push(`${request.method} ${url.pathname}${url.search}`)
      response.writeHead(404, { 'access-control-allow-origin': '*', 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'unexpected fixture request' }))
    } catch (error) {
      state.unexpectedRequests.push(`fixture-error:${error instanceof Error ? error.message : String(error)}`)
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

function snapshotFromDom() {
  const round = (value) => Math.round(value * 100) / 100
  const text = (element) => (element?.textContent || '').replace(/\s+/g, ' ').trim()
  const rect = (element) => {
    if (!(element instanceof HTMLElement)) return null
    const box = element.getBoundingClientRect()
    return { x: round(box.x), y: round(box.y), width: round(box.width), height: round(box.height) }
  }
  const union = (elements) => {
    const boxes = elements.map(rect).filter(Boolean)
    if (!boxes.length) return null
    const left = Math.min(...boxes.map((box) => box.x))
    const top = Math.min(...boxes.map((box) => box.y))
    const right = Math.max(...boxes.map((box) => box.x + box.width))
    const bottom = Math.max(...boxes.map((box) => box.y + box.height))
    return { x: round(left), y: round(top), width: round(right - left), height: round(bottom - top) }
  }
  const css = (element) => {
    if (!(element instanceof HTMLElement)) return {}
    const style = getComputedStyle(element)
    return Object.fromEntries([
      'display', 'position', 'boxSizing', 'width', 'height', 'minWidth', 'minHeight',
      'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'gap',
      'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
      'borderRadius', 'backgroundColor', 'color', 'fontSize', 'fontWeight', 'lineHeight',
      'overflowX', 'whiteSpace',
    ].map((key) => [key, style[key]]))
  }
  const normalizeOperation = (value) => {
    if (/重启|restart/i.test(value)) return 'restart'
    if (/删除|移除|delete|remove/i.test(value)) return 'delete'
    if (/授权|authorize|settings/i.test(value)) return 'authorize'
    if (/测试|执行|test|execute/i.test(value)) return 'test'
    return value
  }
  const prototypeMode = Boolean(document.querySelector('.screen.on [data-sub="in1"]'))
  const panel = prototypeMode
    ? document.querySelector('.screen.on [data-sub="in1"]')
    : document.querySelector('.hc-capability-content-pad')
  const serverRows = prototypeMode
    ? Array.from(document.querySelectorAll('.screen.on [data-sub="in1"] [data-mcp-panel="servers"].mcp-row'))
    : Array.from(document.querySelectorAll('.hc-capability-installed-row--mcp'))
  const toolRows = prototypeMode
    ? Array.from(document.querySelectorAll('.screen.on [data-sub="in1"] [data-mcp-panel="tools"].mcp-row'))
    : Array.from(document.querySelectorAll('.hc-capability-installed-row--tool'))
  const makeRow = (element, kind) => {
    const query = (selector) => element.querySelector(selector)
    const name = text(query(prototypeMode ? '.main .name' : kind === 'tool' ? '.hc-capability-installed-tool-name' : '.hc-capability-installed-server-name'))
    const description = text(query(prototypeMode ? '.main .desc' : kind === 'tool' ? '.hc-capability-installed-main p' : '[data-mcp-description]'))
    const status = kind === 'server'
      ? text(query(prototypeMode ? '.pill' : '.hc-capability-installed-actions > span'))
      : null
    const schemaText = text(query(prototypeMode ? '.schema' : '.hc-capability-installed-schema'))
    let schema = null
    if (schemaText) {
      try { schema = JSON.parse(schemaText) } catch { schema = schemaText }
    }
    const inputs = Array.from(element.querySelectorAll('input')).map((input) => ({
      value: input.value,
      ariaLabel: input.getAttribute('aria-label'),
      static: Boolean(input.closest('[data-mcp-static-input]')),
    }))
    const operations = Array.from(element.querySelectorAll('button')).map((button) => normalizeOperation(text(button))).sort()
    return {
      semantics: { name, description, status, schema, inputs, operations },
      bbox: rect(element),
      computed: css(element),
      main: rect(query(prototypeMode ? '.main' : '.hc-capability-installed-main')),
      actions: rect(query(prototypeMode ? 'button:last-of-type' : '.hc-capability-installed-actions')),
    }
  }
  const activeTools = !prototypeMode && Boolean(document.querySelector('.hc-capability-installed-row--tool'))
  const rows = activeTools ? toolRows : serverRows
  const root = prototypeMode ? union(rows) : rect(document.querySelector('.hc-capability-installed-track'))
  return {
    environment: { viewport: { width: innerWidth, height: innerHeight }, devicePixelRatio, locale: navigator.language, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, route: location.pathname },
    kind: activeTools ? 'tools' : 'servers',
    root,
    panel: rect(panel),
    computed: css(prototypeMode ? panel : document.querySelector('.hc-capability-installed-track')),
    rows: rows.map((row) => makeRow(row, activeTools ? 'tool' : 'server')),
  }
}

function renderInstalledFixture(fixtureOrigin, sidecarPort) {
  const snapshotSource = snapshotFromDom.toString()
  return `;(async function runBug009010InstalledBoundary() {
  'use strict'
  const fixtureOrigin = ${JSON.stringify(fixtureOrigin)}
  const sidecarOrigin = ${JSON.stringify(`http://127.0.0.1:${sidecarPort}`)}
  const mcpServers = ${JSON.stringify(mcpServers)}
  const mcpTools = ${JSON.stringify(mcpTools)}
  const nativeFetch = globalThis.fetch.bind(globalThis)
  const nativeTauri = globalThis.isTauri === true
  // 保留真实 WKWebView/Tauri internals 与 sidecar 健康请求；仅让页面 API 走本轮
  // loopback fixture，以便同一 fixture 在原型与安装态中可重复、可追溯地渲染。
  globalThis.isTauri = false
  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
  const report = async (payload) => {
    const endpoint = fixtureOrigin + '/__bug009010__/report'
    const body = JSON.stringify(payload)
    try {
      // 使用 simple request 让 tauri://localhost 不因 JSON 预检丢失报告；服务端仍按 JSON 解析 body。
      const result = await nativeFetch(endpoint, { method: 'POST', mode: 'no-cors', body })
      if (result.type === 'opaque' || result.ok) return
    } catch {
      // sendBeacon 作为 WKWebView 关闭/跨源 fetch 的回退通道。
    }
    if (typeof navigator.sendBeacon === 'function') {
      const accepted = navigator.sendBeacon(endpoint, new Blob([body], { type: 'text/plain;charset=UTF-8' }))
      if (accepted) return
    }
    throw new Error('fixture report delivery failed')
  }
  const reportError = (error) => {
    const message = error instanceof Error ? [error.name + ': ' + error.message, error.stack].filter(Boolean).join('\\n') : String(error)
    void report({ stage: 'fixture-error', message }).catch(() => {})
  }
  addEventListener('error', (event) => reportError(event.error || event.message))
  addEventListener('unhandledrejection', (event) => reportError(event.reason))
  void report({
    stage: 'fixture-script-start',
    isTauri: nativeTauri,
    location: location.href,
    readyState: document.readyState,
  }).catch(() => {})
  const responseFor = (method, rawPath) => {
    const url = new URL(rawPath, fixtureOrigin)
    const body = (${apiFixture.toString()})(method, url.pathname + url.search)
    return body === null ? null : new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } })
  }
  globalThis.fetch = async (input, init) => {
    const raw = input instanceof Request ? input.url : String(input)
    const url = new URL(raw, location.href)
    if ((url.origin === fixtureOrigin || url.origin === sidecarOrigin) && (url.pathname === '/health' || url.pathname.startsWith('/api/'))) {
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
  history.replaceState(null, '', '/integration/mcp')
  const waitFor = async (read, label, timeout = 75000) => {
    const deadline = Date.now() + timeout
    let lastError
    while (Date.now() < deadline) {
      try { const value = read(); if (value) return value } catch (error) { lastError = error }
      await sleep(80)
    }
    throw new Error('timed out waiting for ' + label + (lastError ? ': ' + lastError : ''))
  }
  const waitForGate = async (stage) => waitFor(async () => {
    const response = await nativeFetch(fixtureOrigin + '/__bug009010__/gate?stage=' + encodeURIComponent(stage))
    return (await response.json()).released
  }, 'gate ' + stage)
  let sidecarHealth = false
  let sidecarHealthError = null
  try {
    // 通过当前 Test.app 的 Tauri Rust command 发起真实 sidecar /health 请求；
    // 不把 WebView 直连 sidecar 的 CORS 失败误报成引擎不可用。
    sidecarHealth = nativeTauri && typeof globalThis.__TAURI_INTERNALS__?.invoke === 'function'
      ? await globalThis.__TAURI_INTERNALS__.invoke('check_engine_health')
      : false
  } catch (error) {
    sidecarHealthError = error instanceof Error ? error.message : String(error)
  }
  await report({
    stage: 'bootstrap',
    isTauri: nativeTauri,
    transportFixtureMode: true,
    hasTauriInternals: typeof globalThis.__TAURI_INTERNALS__?.invoke === 'function',
    sidecarHealth: { ok: sidecarHealth === true, error: sidecarHealthError },
    location: location.href,
    readyState: document.readyState,
  })
  const debugState = () => ({
    location: location.href,
    readyState: document.readyState,
    title: document.title,
    html: document.documentElement?.outerHTML?.slice(0, 8000) || '',
    bodyText: document.body?.innerText?.slice(0, 2000) || '',
    scripts: Array.from(document.scripts).map((script) => ({ src: script.src, type: script.type, ready: script.readyState })),
  })
  const clickMcpTools = () => {
    const tabs = Array.from(document.querySelectorAll('[role="tab"],button'))
    const tab = tabs.find((element) => /工具/.test((element.textContent || '').replace(/\\s+/g, ' ')))
    if (!tab) throw new Error('MCP tools tab missing')
    tab.click()
  }
  const execute = async () => {
    if (document.readyState === 'loading') await new Promise((resolve) => addEventListener('DOMContentLoaded', resolve, { once: true }))
    try {
      await waitFor(() => document.querySelector('.hc-app'), 'application root')
    } catch (error) {
      await report({ stage: 'fixture-debug-root', error: String(error), debug: debugState() })
      throw error
    }
    try {
      await waitFor(() => document.querySelectorAll('.hc-capability-installed-row--mcp').length === 2, 'MCP server rows')
    } catch (error) {
      await report({ stage: 'fixture-debug-servers', error: String(error), debug: debugState() })
      throw error
    }
    await waitFor(() => document.querySelector('[data-mcp-description]')?.textContent?.includes('filesystem'), 'server descriptions')
    await waitFor(() => { const splash = document.querySelector('#splash-screen'); return !splash || splash.classList.contains('fade-out') || getComputedStyle(splash).opacity === '0' || getComputedStyle(splash).display === 'none' || getComputedStyle(splash).visibility === 'hidden' }, 'splash hidden')
    await document.fonts.ready
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const servers = (${snapshotSource})()
    await report({ stage: 'native-servers', fixture: ${JSON.stringify(fixtureId)}, snapshot: servers })
    await waitForGate('native-servers')
    clickMcpTools()
    await waitFor(() => document.querySelectorAll('.hc-capability-installed-row--tool').length === 2, 'MCP tool rows')
    await waitFor(() => document.querySelectorAll('.hc-capability-installed-row--tool .hc-capability-installed-schema').length >= 2, 'static MCP schemas')
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const tools = (${snapshotSource})()
    await report({ stage: 'native-tools', fixture: ${JSON.stringify(fixtureId)}, snapshot: tools })
    await waitForGate('native-tools')
  }
  void execute().catch(reportError)
})()
`
}

function renderConfig(sandbox, sidecarPort) {
  return `server:
  host: 127.0.0.1
  port: ${sidecarPort}
  mode: development
storage:
  driver: sqlite
  sqlite:
    path: ${JSON.stringify(join(sandbox, '.hexclaw/data.db'))}
llm:
  default: ""
  providers: {}
  routing:
    enabled: false
  cache:
    enabled: false
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

function nativeTargetTriple() {
  if (process.arch === 'arm64') return 'aarch64-apple-darwin'
  if (process.arch === 'x64') return 'x86_64-apple-darwin'
  throw new Error(`unsupported macOS architecture: ${process.arch}`)
}

function prepareSidecar(sandbox) {
  const triple = nativeTargetTriple()
  const source = join(srcTauriRoot, 'binaries', `hexclaw-${triple}`)
  assert.ok(existsSync(source), `sidecar missing: ${relative(repoRoot, source)}`)
  const directory = join(sandbox, 'binaries')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const base = join(directory, 'hexclaw')
  const destination = `${base}-${triple}`
  copyFileSync(source, destination)
  chmodSync(destination, 0o700)
  return { base, destination, sha256: sha256File(destination), triple }
}

async function buildFrontend(sandbox, fixtureOrigin, sidecarPort) {
  const frontend = join(sandbox, 'frontend')
  const env = {
    ...process.env,
    CARGO_NET_OFFLINE: 'true',
    PNPM_CONFIG_OFFLINE: 'true',
    npm_config_offline: 'true',
    GOENV: 'off',
    GOPROXY: 'off',
    GOSUMDB: 'off',
  }
  const build = await runCommand('pnpm', ['exec', 'vite', 'build', '--outDir', frontend, '--emptyOutDir'], { env })
  const indexPath = join(frontend, 'index.html')
  // 注入夹具会把运行时路由切到 /integration/mcp；把 Vite 入口与样式改为根相对
  // 资产，避免模块脚本在解析前被重定向到 /integration/assets 下而使真实 App 停在闪屏。
  const index = readFileSync(indexPath, 'utf8').replaceAll('="./assets/', '="/assets/')
  const entry = index.match(/<script type="module" crossorigin src="(?:\.\/|\/)?assets\/([^"]+\.js)">/)
  assert.ok(entry, 'current-source module entry missing')
  const modulePath = join(frontend, 'assets', entry[1])
  let moduleSource = readFileSync(modulePath, 'utf8')
  const platformProbe = /function [A-Za-z_$][\w$]*\(\)\{return!!globalThis\.isTauri\}/g
  assert.equal((moduleSource.match(platformProbe) || []).length, 1, 'platform probe shape changed')
  moduleSource = moduleSource
    .replace(platformProbe, (match) => match.replace('return!!globalThis.isTauri', 'return!1'))
    .replaceAll('http://localhost:16060', fixtureOrigin)
    .replaceAll('ws://localhost:16060', fixtureOrigin.replace('http://', 'ws://'))
    .replaceAll('ws://127.0.0.1:16060', fixtureOrigin.replace('http://', 'ws://'))
  writeFileSync(modulePath, moduleSource, { encoding: 'utf8', mode: 0o600 })
  const fixtureSource = renderInstalledFixture(fixtureOrigin, sidecarPort)
  assert.doesNotThrow(() => new Function(fixtureSource))
  const fixtureScriptPath = join(frontend, 'fixture-bridge.js')
  writeFileSync(fixtureScriptPath, fixtureSource, { encoding: 'utf8', mode: 0o600 })
  writeFileSync(
    indexPath,
    index.replace('<head>', `<head><style>*{animation:none!important;transition:none!important;caret-color:transparent!important}</style><script src="/fixture-bridge.js"></script>`),
    { encoding: 'utf8', mode: 0o600 },
  )
  return {
    frontend,
    modulePath,
    moduleSha256: sha256File(modulePath),
    fixtureScriptPath,
    fixtureSha256: sha256(fixtureSource),
    build,
  }
}

function writeOverlay(sandbox, frontend, sidecarBase, sidecarPort, fixtureOrigin) {
  const overlay = join(sandbox, 'tauri.bug009010.mcp.json')
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "style-src-attr 'unsafe-inline'",
    `img-src 'self' data: blob: ${fixtureOrigin}`,
    `connect-src 'self' http://127.0.0.1:${sidecarPort} ws://127.0.0.1:${sidecarPort} ${fixtureOrigin}`,
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ')
  writeJson(overlay, {
    productName,
    identifier: bundleIdentifier,
    // 使用 sandbox 内构建产物的绝对路径，避免临时 overlay 的相对路径被 Tauri
    // 按 src-tauri 配置目录再次解释，导致安装 bundle 实际加载旧 dist。
    build: { frontendDist: frontend, beforeBuildCommand: '' },
    app: {
      windows: [
        {
          label: 'main',
          title: productName,
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
      updater: { endpoints: [`${fixtureOrigin}/updater`], dangerousInsecureTransportProtocol: true },
    },
  })
  return overlay
}

function appEnvironment(sandbox, sidecarPort, fixtureOrigin) {
  const temporary = join(sandbox, 'tmp')
  mkdirSync(temporary, { recursive: true, mode: 0o700 })
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
    if (appProcess.exitCode !== null) throw new Error('Test.app exited before sidecar health')
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) })
      if (response.ok) return
    } catch {
      // sidecar is still starting
    }
    await sleep(250)
  }
  throw new Error(`sidecar health timed out on ${port}`)
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
  for (const pid of listenerPids(port)) {
    const command = processCommand(pid)
    if (!command.includes(`${appBundle}/Contents/MacOS/hexclaw serve --desktop`)) {
      throw new Error(`dedicated port ${port} has unexpected owner ${pid}: ${command}`)
    }
    process.kill(pid, 'SIGTERM')
    stopped.push(pid)
  }
  const deadline = Date.now() + 10_000
  while (listenerPids(port).length && Date.now() < deadline) await sleep(100)
  assert.deepEqual(listenerPids(port), [])
  return stopped
}

function windowInfoForPid(pid) {
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
  assert.ok(output, `no visible native window for PID ${pid}`)
  const [id, x, y, width, height] = output.split('|').map(Number)
  assert.ok([id, x, y, width, height].every(Number.isFinite), output)
  return { id, x, y, width, height }
}

function imageDimensions(file) {
  const output = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file], { encoding: 'utf8' })
  const width = Number(output.match(/pixelWidth:\s*(\d+)/)?.[1])
  const height = Number(output.match(/pixelHeight:\s*(\d+)/)?.[1])
  assert.ok(Number.isFinite(width) && Number.isFinite(height), output)
  return { width, height }
}

function imageProfile(file) {
  const output = execFileSync('sips', ['-g', 'profile', file], { encoding: 'utf8' })
  return output.match(/profile:\s*(.+)/)?.[1]?.trim() || '<nil>'
}

function captureWindow(pid, destination) {
  const window = windowInfoForPid(pid)
  execFileSync('/usr/sbin/screencapture', ['-x', '-o', '-l', String(window.id), destination])
  assert.ok(existsSync(destination) && statSync(destination).size > 1024)
  return { ...window, pixels: imageDimensions(destination), bytes: statSync(destination).size }
}

function cropState(fullPath, destination, snapshot) {
  const full = imageDimensions(fullPath)
  const expected = { width: viewport.width * deviceScaleFactor, height: viewport.height * deviceScaleFactor }
  assert.deepEqual(full, expected, `native screenshot dimensions: ${JSON.stringify(full)}`)
  const root = snapshot.root
  assert.ok(root, 'snapshot root bbox missing')
  const width = Math.round(root.width * deviceScaleFactor)
  const height = Math.round(root.height * deviceScaleFactor)
  const x = Math.round(root.x * deviceScaleFactor)
  const y = Math.round(root.y * deviceScaleFactor)
  execFileSync('sips', ['-c', String(height), String(width), '--cropOffset', String(y), String(x), fullPath, '--out', destination], { stdio: 'pipe' })
  assert.deepEqual(imageDimensions(destination), { width, height })
  return { full, crop: { x, y, width, height } }
}

function pixelDiff(reference, implementation, output) {
  const result = spawnSync('uv', [
    'run', '--offline', '--isolated', '--python', '3.12', '--with', 'pillow==10.4.0',
    'python', pixelDiffTool, reference, implementation, output, '8',
  ], { cwd: repoRoot, encoding: 'utf8' })
  if (result.status !== 0) return { status: 'NOT_RUN', error: result.stderr || result.stdout }
  try { return JSON.parse(result.stdout.trim()) } catch { return { status: 'NOT_RUN', error: result.stdout } }
}

function differences(reference, implementation, tolerance = 0, prefix = '$') {
  if (typeof reference === 'number' && typeof implementation === 'number') {
    return Math.abs(reference - implementation) <= tolerance ? [] : [`${prefix}: ${reference} != ${implementation}`]
  }
  if (Array.isArray(reference) && Array.isArray(implementation)) {
    const output = []
    if (reference.length !== implementation.length) output.push(`${prefix}.length: ${reference.length} != ${implementation.length}`)
    for (let index = 0; index < Math.min(reference.length, implementation.length); index += 1) output.push(...differences(reference[index], implementation[index], tolerance, `${prefix}[${index}]`))
    return output
  }
  if (reference && implementation && typeof reference === 'object' && typeof implementation === 'object') {
    const output = []
    for (const key of [...new Set([...Object.keys(reference), ...Object.keys(implementation)])].sort()) output.push(...differences(reference[key], implementation[key], tolerance, `${prefix}.${key}`))
    return output
  }
  return Object.is(reference, implementation) ? [] : [`${prefix}: ${JSON.stringify(reference)} != ${JSON.stringify(implementation)}`]
}

async function captureReference(fixture) {
  const externalRequests = []
  const browser = await webkit.launch()
  const context = await browser.newContext({ viewport, deviceScaleFactor, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', colorScheme: 'light', reducedMotion: 'reduce', serviceWorkers: 'block' })
  const page = await context.newPage()
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) externalRequests.push(request.url())
  })
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url())
    return ['127.0.0.1', 'localhost', '::1'].includes(url.hostname) ? route.continue() : route.abort('blockedbyclient')
  })
  const states = {}
  try {
    await page.goto(`${fixture.origin}/app.html`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => typeof globalThis.showPane === 'function')
    await page.evaluate(() => globalThis.showPane('integration', '集成'))
    await page.locator('[data-segset="in"] button').nth(1).click()
    await page.locator('.screen.on [data-sub="in1"] .mcp-row[data-mcp-panel="servers"]').first().waitFor({ state: 'visible' })
    await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}' })
    await page.evaluate(async () => { await document.fonts.ready; await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))) })
    const serverTarget = page.locator('.screen.on [data-sub="in1"] .mcp-row[data-mcp-panel="servers"]').first()
    const serverSnapshot = await page.evaluate(snapshotFromDom)
    const serverRoot = serverSnapshot.root
    const serverPath = join(evidenceRoot, 'reference-servers.png')
    await page.screenshot({ path: serverPath, animations: 'disabled', caret: 'hide', clip: serverRoot })
    states.servers = { snapshot: serverSnapshot, path: serverPath }
    await page.locator('.screen.on [data-sub="in1"] .utab[data-mcp-tab="tools"]').click()
    await page.locator('.screen.on [data-sub="in1"] .mcp-row[data-mcp-panel="tools"]').first().waitFor({ state: 'visible' })
    await page.evaluate(async () => { await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))) })
    const toolSnapshot = await page.evaluate(snapshotFromDom)
    const toolPath = join(evidenceRoot, 'reference-tools.png')
    await page.screenshot({ path: toolPath, animations: 'disabled', caret: 'hide', clip: toolSnapshot.root })
    states.tools = { snapshot: toolSnapshot, path: toolPath }
    return { states, externalRequests }
  } finally {
    await context.close()
    await browser.close()
  }
}

function windowStateEnvironment(report) {
  return {
    viewport,
    devicePixelRatio: report?.environment?.devicePixelRatio,
    locale: report?.environment?.locale,
    timezone: report?.environment?.timezone,
    route: report?.environment?.route,
  }
}

async function main() {
  assert.equal(process.platform, 'darwin', 'installed Test.app gate is macOS-only')
  mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 })
  const sandbox = mkdtempSync(join(tmpdir(), 'hexclaw-bug009010-mcp.'))
  chmodSync(sandbox, 0o700)
  mkdirSync(join(sandbox, '.hexclaw'), { recursive: true, mode: 0o700 })
  const fixturePort = await reserveLoopbackPort()
  const sidecarPort = await reserveLoopbackPort()
  assert.notEqual(fixturePort, sidecarPort)
  const fixture = createFixtureServer(fixturePort)
  const fixtureOrigin = fixture.origin
  const appBundle = join(srcTauriRoot, 'target/release/bundle/macos', `${productName}.app`)
  assert.equal(existsSync(appBundle), false, `unique Test.app already exists: ${appBundle}`)
  let appProcess = null
  let appLog = null
  let appLogPath = ''
  let buildReceipts = []
  let stoppedSidecars = []
  let result = null
  let failure = null
  const startedAt = Date.now()
  try {
    await fixture.listen()
    const reference = await captureReference(fixture)
    assert.deepEqual(reference.externalRequests, [], 'prototype attempted external network')
    writeJson(join(evidenceRoot, 'reference-bbox-computed-style.json'), reference.states)
    writeFileSync(join(sandbox, '.hexclaw/hexclaw.yaml'), renderConfig(sandbox, sidecarPort), { encoding: 'utf8', mode: 0o600 })
    chmodSync(join(sandbox, '.hexclaw/hexclaw.yaml'), 0o600)
    const sidecar = prepareSidecar(sandbox)
    const frontend = await buildFrontend(sandbox, fixtureOrigin, sidecarPort)
    buildReceipts.push(frontend.build)
    const overlay = writeOverlay(sandbox, frontend.frontend, sidecar.base, sidecarPort, fixtureOrigin)
    const offlineEnv = {
      ...process.env,
      CARGO_NET_OFFLINE: 'true',
      CARGO_TARGET_DIR: join(srcTauriRoot, 'target'),
      PNPM_CONFIG_OFFLINE: 'true',
      npm_config_offline: 'true',
      GOENV: 'off',
      GOPROXY: 'off',
      GOSUMDB: 'off',
    }
    if (existsSync(appBundle)) throw new Error(`refusing to overwrite existing unique app ${appBundle}`)
    buildReceipts.push(await runCommand('pnpm', ['exec', 'tauri', 'build', '--config', overlay, '--bundles', 'app'], { env: offlineEnv }))
    const infoPlist = join(appBundle, 'Contents/Info.plist')
    const executable = join(appBundle, 'Contents/MacOS/hexclaw-desktop')
    const bundledSidecar = join(appBundle, 'Contents/MacOS/hexclaw')
    assert.ok(existsSync(infoPlist) && existsSync(executable) && existsSync(bundledSidecar), 'temporary Test.app bundle incomplete')
    const identifier = execFileSync('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', infoPlist], { encoding: 'utf8' }).trim()
    assert.equal(identifier, bundleIdentifier)
    assert.equal(sha256File(bundledSidecar), sidecar.sha256)
    appLogPath = join(sandbox, 'app.log')
    appLog = (await import('node:fs')).createWriteStream(appLogPath, { flags: 'wx', mode: 0o600 })
    appProcess = spawn(executable, ['-AppleLanguages', '(zh-Hans)', '-AppleLocale', 'zh_CN'], { cwd: sandbox, env: appEnvironment(sandbox, sidecarPort, fixtureOrigin), stdio: ['ignore', 'pipe', 'pipe'] })
    appProcess.stdout.pipe(appLog, { end: false })
    appProcess.stderr.pipe(appLog, { end: false })
    await waitForHealth(sidecarPort, appProcess)
    assert.equal(listenerPids(sidecarPort).length, 1, 'temporary Test.app must own one sidecar listener')
    const nativeServers = await waitForReport(fixture.state, appProcess, 'native-servers')
    assert.equal(nativeServers.fixture, fixtureId)
    assert.equal(nativeServers.snapshot.kind, 'servers')
    const serversFullPath = join(evidenceRoot, 'native-servers-full.png')
    const serversCapture = captureWindow(appProcess.pid, serversFullPath)
    const serversImplementationPath = join(evidenceRoot, 'installed-servers.png')
    const serversCrop = cropState(serversFullPath, serversImplementationPath, nativeServers.snapshot)
    fixture.state.released.add('native-servers')
    const nativeTools = await waitForReport(fixture.state, appProcess, 'native-tools')
    assert.equal(nativeTools.fixture, fixtureId)
    assert.equal(nativeTools.snapshot.kind, 'tools')
    const toolsFullPath = join(evidenceRoot, 'native-tools-full.png')
    const toolsCapture = captureWindow(appProcess.pid, toolsFullPath)
    const toolsImplementationPath = join(evidenceRoot, 'installed-tools.png')
    const toolsCrop = cropState(toolsFullPath, toolsImplementationPath, nativeTools.snapshot)
    fixture.state.released.add('native-tools')
    const states = {
      servers: { reference: reference.states.servers, installed: { snapshot: nativeServers.snapshot, path: serversImplementationPath }, capture: serversCapture, crop: serversCrop },
      tools: { reference: reference.states.tools, installed: { snapshot: nativeTools.snapshot, path: toolsImplementationPath }, capture: toolsCapture, crop: toolsCrop },
    }
    const comparisons = {}
    for (const [kind, state] of Object.entries(states)) {
      const semanticDifferences = differences(state.reference.snapshot.rows.map((row) => row.semantics), state.installed.snapshot.rows.map((row) => row.semantics))
      const geometryDifferences = differences(state.reference.snapshot.root, state.installed.snapshot.root, 1)
      const styleDifferences = differences(state.reference.snapshot.computed, state.installed.snapshot.computed)
      const diffPath = join(evidenceRoot, `pixel-diff-${kind}.png`)
      const pixels = pixelDiff(state.reference.path, state.installed.path, diffPath)
      const renderingProfiles = { reference: imageProfile(state.reference.path), installed: imageProfile(state.installed.path) }
      const comparableRaster = renderingProfiles.reference === renderingProfiles.installed
      comparisons[kind] = {
        status: semanticDifferences.length || geometryDifferences.length || styleDifferences.length ? 'RED' : comparableRaster && pixels.changed_pixel_ratio <= maxChangedPixelRatio ? 'PASS' : 'PASS_SCOPED_NATIVE_LAYOUT',
        semanticDifferences,
        geometryDifferences,
        styleDifferences,
        pixels,
        visual: { status: comparableRaster && pixels.changed_pixel_ratio <= maxChangedPixelRatio ? 'PASS' : 'NOT_COMPARABLE_NATIVE_RASTER', comparableRaster, renderingProfiles },
        files: { reference: relative(evidenceRoot, state.reference.path), implementation: relative(evidenceRoot, state.installed.path), pixelDiff: relative(evidenceRoot, diffPath) },
      }
    }
    const content = {
      servers: comparisons.servers.semanticDifferences.length === 0 ? 'PASS' : 'RED',
      tools: comparisons.tools.semanticDifferences.length === 0 ? 'PASS' : 'RED',
    }
    result = {
      schemaVersion: 1,
      bug: 'BUG-20260723-009/010',
      fixture: fixtureId,
      status: Object.values(comparisons).every((comparison) => comparison.status !== 'RED') && Object.values(content).every((value) => value === 'PASS') ? 'PASS' : 'RED',
      boundary: 'current-worktree temporary Test.app / real macOS WKWebView / native window capture',
      durationMs: Date.now() - startedAt,
      environment: { viewport, deviceScaleFactor, locale: 'zh-CN', timezone: 'Asia/Shanghai', colorScheme: 'light', reducedMotion: 'reduce' },
      content,
      comparisons,
      fixtureReceipts: fixture.state,
      source: { mcpView: sha256File(join(repoRoot, 'src/views/McpView.vue')), mcpApi: sha256File(join(repoRoot, 'src/api/mcp.ts')), mcpTypes: sha256File(join(repoRoot, 'src/types/mcp.ts')), prototype: sha256File(join(prototypeRoot, 'app.html')), harness: sha256File(fileURLToPath(import.meta.url)) },
      build: { productName, bundleIdentifier: identifier, appExecutableSha256: sha256File(executable), sidecarSha256: sidecar.sha256, frontendModuleSha256: frontend.moduleSha256, fixtureSha256: frontend.fixtureSha256, commands: buildReceipts.map(({ command, args, code, durationMs }) => ({ command, args, code, durationMs })), source: 'current worktree Vite build; no pre-existing dist reused' },
      isolation: { testHomeMode: '0700', configMode: '0600', fixturePort, sidecarPort, realWKWebView: true, applicationsDirectoryTouched: false, userHomeReadOrWritten: false, externalNetworkAttempts: fixture.state.blockedExternalRequests, realModelInvocations: 0, realIMInvocations: 0 },
      files: { referenceBboxComputedStyle: 'reference-bbox-computed-style.json', bboxComputedStyle: 'bbox-computed-style.json', buildProvenance: 'build-provenance.json', cleanup: 'cleanup.json' },
    }
    writeJson(join(evidenceRoot, 'bbox-computed-style.json'), states)
    writeJson(join(evidenceRoot, 'build-provenance.json'), result.build)
    process.stdout.write(`\nBUG-20260723-009/010 installed ${result.status}: ${relative(repoRoot, evidenceRoot)}\n`)
  } catch (error) {
    failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  } finally {
    await stopProcess(appProcess).catch((error) => { if (!failure) failure = String(error) })
    if (appLog) await new Promise((resolveEnd) => appLog.end(resolveEnd))
    try { stoppedSidecars = await stopOwnedSidecar(sidecarPort, appBundle) } catch (error) { if (!failure) failure = error instanceof Error ? error.message : String(error) }
    await fixture.close().catch((error) => { if (!failure) failure = String(error) })
    if (appLogPath && existsSync(appLogPath)) writeFileSync(join(evidenceRoot, 'app.log'), sanitize(readFileSync(appLogPath, 'utf8'), sandbox), { encoding: 'utf8', mode: 0o600 })
    writeFileSync(join(evidenceRoot, 'build.log'), sanitize(buildReceipts.map((receipt) => receipt.output || '').join('\n'), sandbox), { encoding: 'utf8', mode: 0o600 })
    const appBundleExistedBeforeCleanup = existsSync(appBundle)
    rmSync(appBundle, { recursive: true, force: true })
    rmSync(sandbox, { recursive: true, force: true })
    writeJson(join(evidenceRoot, 'cleanup.json'), { status: failure ? 'FAIL' : result?.status || 'NOT_PASS', failure, appProcessStopped: !appProcess || appProcess.exitCode !== null || appProcess.signalCode !== null, sidecarPortReleased: listenerPids(sidecarPort).length === 0, fixtureClosed: true, appBundleExistedBeforeCleanup, appBundleRemoved: !existsSync(appBundle), sandboxRemoved: !existsSync(sandbox), stoppedSidecars, applicationsDirectoryTouched: false, userHomeReadOrWritten: false })
    if (!result) writeJson(join(evidenceRoot, 'summary.json'), { bug: 'BUG-20260723-009/010', fixture: fixtureId, status: 'BLOCKED', error: failure, boundary: 'temporary Test.app gate did not produce native reports', fixtureReceipts: fixture.state, isolation: { fixturePort, sidecarPort, applicationsDirectoryTouched: false, userHomeReadOrWritten: false } })
    else writeJson(join(evidenceRoot, 'summary.json'), { ...result, failure })
    writeFileSync(join(evidenceRoot, 'README.md'), `# BUG-20260723-009/010 installed MCP evidence\n\n- Fixture: **${fixtureId}**\n- Status: **${failure ? 'BLOCKED' : result?.status || 'NOT_PASS'}**\n- Boundary: current-source temporary Test.app, real macOS WKWebView, loopback-only fixture.\n- Native screenshots and DOM/bbox/computed-style evidence are captured separately for server and tool states.\n- No /Applications app, real user HOME, real model, IM, or external network is used.\n- A RED result is retained as evidence; this harness never converts a mismatch into PASS.\n`, { encoding: 'utf8', mode: 0o600 })
  }
  if (failure) throw new Error(failure)
  if (result?.status !== 'PASS') throw new Error(`BUG-20260723-009/010 installed gate ${result?.status || 'NOT_PASS'}`)
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`)
  process.exitCode = 1
})
