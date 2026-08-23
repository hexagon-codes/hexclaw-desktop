#!/usr/bin/env node

/**
 * BUG-20260728-007 当前工作树的隔离原生视觉边界。
 *
 * 前端在临时目录按 package-local 模式构建；测试传输与只读取证脚本只注入临时副本。
 * 唯一 Bundle ID、Test Home、Sidecar 端口和回执端口均隔离，不触碰 /Applications 或真实 HOME。
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const nativeDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(nativeDir, '../..')
const srcTauriDir = join(repoRoot, 'src-tauri')
const evidenceRoot = join(repoRoot, 'test/evidence/bug-20260728-007-current-source/native')
const productName = 'HexClaw Composer Grid Test'
const bundleIdentifier = 'com.hexclaw.desktop.bug-20260728-007'
const commandTimeoutMs = 15 * 60 * 1000
const frame = { width: 1100, height: 760 }
const sessionId = 'bug-20260728-007-grid-session'
const fixedTime = '2026-07-28T08:00:00.000Z'
const sleep = (milliseconds) =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds))

function sha256Buffer(value) {
  return createHash('sha256').update(value).digest('hex')
}

function sha256File(path) {
  return sha256Buffer(readFileSync(path))
}

function walkFiles(path, output = []) {
  if (!existsSync(path)) return output
  const stat = lstatSync(path)
  if (stat.isFile()) {
    output.push(path)
    return output
  }
  if (!stat.isDirectory()) return output
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name === '.DS_Store') continue
    walkFiles(join(path, entry.name), output)
  }
  return output
}

function manifestForFiles(files, root = repoRoot) {
  const entries = [...new Set(files)]
    .filter((path) => existsSync(path) && lstatSync(path).isFile())
    .sort()
    .map((path) => {
      const stat = statSync(path)
      return {
        path: relative(root, path),
        bytes: stat.size,
        mode: (stat.mode & 0o777).toString(8).padStart(4, '0'),
        sha256: sha256File(path),
      }
    })
  return { entries, digest: sha256Buffer(JSON.stringify(entries)) }
}

function treeManifest(root) {
  return manifestForFiles(walkFiles(root), root)
}

function currentSourceManifest() {
  const architecture = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
  const paths = [
    ...walkFiles(join(repoRoot, 'src')),
    ...walkFiles(join(repoRoot, 'public')),
    ...walkFiles(join(srcTauriDir, 'src')),
    ...walkFiles(join(srcTauriDir, 'capabilities')),
    ...walkFiles(join(srcTauriDir, 'icons')),
    ...walkFiles(join(srcTauriDir, 'render-assets')),
    join(repoRoot, 'index.html'),
    join(repoRoot, 'package.json'),
    join(repoRoot, 'pnpm-lock.yaml'),
    join(repoRoot, 'rust-toolchain.toml'),
    join(repoRoot, 'tsconfig.json'),
    join(repoRoot, 'tsconfig.app.json'),
    join(repoRoot, 'tsconfig.node.json'),
    join(repoRoot, 'tsconfig.vitest.json'),
    join(repoRoot, 'vite.config.ts'),
    join(repoRoot, 'scripts/ci/pdf-worker-package-asset.mjs'),
    join(srcTauriDir, 'Cargo.toml'),
    join(srcTauriDir, 'Cargo.lock'),
    join(srcTauriDir, 'build.rs'),
    join(srcTauriDir, 'Info.plist'),
    join(srcTauriDir, 'tauri.conf.json'),
    join(srcTauriDir, `binaries/hexclaw-${architecture}-apple-darwin`),
    join(srcTauriDir, `binaries/pandoc-${architecture}-apple-darwin`),
    join(srcTauriDir, `binaries/typst-${architecture}-apple-darwin`),
    join(srcTauriDir, 'binaries/ollama-bundle/ollama'),
  ]
  // 测试源码不会进入 Vite/Tauri 产物；并行测试补充不应伪装成产品构建输入漂移。
  const buildInputs = paths.filter(
    (path) =>
      !path.includes(`${join(repoRoot, 'src', '__tests__')}/`) &&
      !path.includes('/__tests__/') &&
      !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path),
  )
  const manifest = manifestForFiles(buildInputs)
  const head = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim()
  const status = execFileSync(
    'git',
    [
      'status',
      '--short',
      '--untracked-files=all',
      '--',
      'src',
      'public',
      'index.html',
      'package.json',
      'pnpm-lock.yaml',
      'tsconfig*.json',
      'vite.config.ts',
      'scripts/ci/pdf-worker-package-asset.mjs',
      'src-tauri/src',
      'src-tauri/capabilities',
      'src-tauri/Cargo.toml',
      'src-tauri/Cargo.lock',
      'src-tauri/build.rs',
      'src-tauri/Info.plist',
      'src-tauri/tauri.conf.json',
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  )
    .trim()
    .split('\n')
    .filter(Boolean)
  return { head, status, ...manifest }
}

function createSourceSnapshot(sandbox, sourceManifest) {
  const snapshotRoot = join(sandbox, 'source-snapshot')
  mkdirSync(snapshotRoot, { recursive: true, mode: 0o700 })
  for (const entry of sourceManifest.entries) {
    const source = join(repoRoot, entry.path)
    const destination = join(snapshotRoot, entry.path)
    mkdirSync(dirname(destination), { recursive: true })
    cpSync(source, destination, { preserveTimestamps: true })
    chmodSync(destination, Number.parseInt(entry.mode, 8))
  }
  symlinkSync(join(repoRoot, 'node_modules'), join(snapshotRoot, 'node_modules'), 'dir')
  const snapshotManifest = manifestForFiles(
    sourceManifest.entries.map((entry) => join(snapshotRoot, entry.path)),
    snapshotRoot,
  )
  assert.equal(
    snapshotManifest.digest,
    sourceManifest.digest,
    'source snapshot must match the point-in-time worktree manifest',
  )
  return { root: snapshotRoot, manifest: snapshotManifest }
}

function runCommand(command, args, options = {}) {
  return new Promise((resolveCommand, rejectCommand) => {
    process.stdout.write(`\n[composer-grid-native] ${command} ${args.join(' ')}\n`)
    const child = spawn(command, args, {
      cwd: options.cwd || repoRoot,
      env: options.env || process.env,
      stdio: 'inherit',
      detached: true,
    })
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {
        // 子进程已退出。
      }
      rejectCommand(new Error(`Command timed out: ${command} ${args.join(' ')}`))
    }, options.timeoutMs || commandTimeoutMs)
    child.once('error', (error) => {
      clearTimeout(timer)
      rejectCommand(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      if (code === 0) resolveCommand()
      else rejectCommand(new Error(`Command failed (${code ?? signal}): ${command} ${args.join(' ')}`))
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

function sendJSON(response, status, value) {
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

const appConfig = {
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
        baseUrl: 'http://127.0.0.1/fixture-only',
        selectedModelId: 'gpt-5.6-terra',
        models: [
          {
            id: 'gpt-5.6-terra',
            name: 'gpt-5.6-terra',
            capabilities: ['text', 'vision'],
            reasoningSupport: 'supported',
            reasoningControl: {
              dialect: 'reasoning_effort',
              on: 'high',
              off: 'none',
              allowed_efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
            },
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
      base_url: 'http://127.0.0.1/fixture-only',
      model: 'gpt-5.6-terra',
      models: ['gpt-5.6-terra'],
      model_specs: [
        {
          id: 'gpt-5.6-terra',
          display_name: 'gpt-5.6-terra',
          capabilities: ['text', 'vision'],
          reasoning_support: 'supported',
          reasoning_control: {
            dialect: 'reasoning_effort',
            on: 'high',
            off: 'none',
            allowed_efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
          },
        },
      ],
    },
  },
}

function runtimeFixture(path, method) {
  if (path === '/health') return { status: 'healthy' }
  if (path === '/api/v1/config') return appConfig
  if (path === '/api/v1/config/llm') return backendLLMConfig
  if (path === '/api/v1/ollama/status') return { running: false, associated: false, models: [] }
  if (path === '/api/v1/assistant/soul') return { system_prompt: '', is_custom: false, default_prompt: '' }
  if (path === '/api/v1/agents' && method === 'GET') return { agents: [], total: 0, default: '' }
  if (path === '/api/v1/agents/rules') return { rules: [], total: 0 }
  if (path === '/api/v1/roles') return { roles: [], total: 0 }
  if (path === '/api/v1/sessions' && method === 'GET') {
    return {
      sessions: [
        {
          id: sessionId,
          title: '24px 栅格视觉基准',
          user_id: 'desktop-user',
          created_at: fixedTime,
          updated_at: fixedTime,
          message_count: 0,
        },
      ],
      total: 1,
    }
  }
  if (path === `/api/v1/sessions/${sessionId}/messages`) return { messages: [], total: 0 }
  if (path === `/api/v1/sessions/${sessionId}/branches`) return { branches: [], total: 0 }
  if (path === `/api/v1/sessions/${sessionId}/artifacts`) return { artifacts: [], total: 0 }
  if (path === '/api/v1/streams/active') return { streams: [], total: 0 }
  if (path === '/api/v1/skills') return { dir: '/tmp/hexclaw-grid-skills', skills: [] }
  if (path === '/api/v1/prompts' || path === '/api/v1/prompts/all') return { prompts: [], total: 0 }
  if (path === '/api/v1/knowledge/documents') {
    return { documents: [], total: 0, limit: 50, offset: 0, sources: [] }
  }
  if (path === '/api/v1/connections') return { connections: [], total: 0 }
  if (path === '/api/v1/platforms/instances') return { instances: [] }
  if (path === '/api/v1/images/status') return { available: false, models: [] }
  if (path === '/api/v1/videos/status') return { available: false, models: [] }
  if (path === '/api/v1/voicechat/status') return { available: false, models: [] }
  if (path === '/api/v1/llm/capabilities') return { models: [] }
  if (path.startsWith('/api/k12/')) return { items: [] }
  if (path.startsWith('/api/v1/')) return { items: [], total: 0 }
  return {}
}

function createFixtureServer(port) {
  const state = {
    reports: [],
    requests: [],
    chatRequests: 0,
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
      if (request.method === 'POST' && url.pathname === '/__composer_grid__/report') {
        state.reports.push(await readJSONBody(request))
        sendJSON(response, 200, { ok: true })
        return
      }
      state.requests.push(`${request.method} ${url.pathname}${url.search}`)
      if (request.method === 'GET' && url.pathname === '/updater') {
        state.updaterRequests += 1
        response.writeHead(204, { 'Access-Control-Allow-Origin': '*' })
        response.end()
        return
      }
      if (request.method === 'GET' && url.pathname === '/v1/models') {
        sendJSON(response, 200, {
          object: 'list',
          data: [{ id: 'fixture-model', object: 'model', created: 0, owned_by: 'loopback' }],
        })
        return
      }
      if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
        state.chatRequests += 1
        sendJSON(response, 503, { error: { message: 'model calls are forbidden in this gate' } })
        return
      }
      const apiPath = url.pathname.replace(/^\/_hexclaw/, '')
      if (apiPath === '/health' || apiPath.startsWith('/api/')) {
        sendJSON(response, 200, runtimeFixture(apiPath, request.method || 'GET'))
        return
      }
      state.unexpectedRequests.push(`${request.method} ${url.pathname}`)
      sendJSON(response, 404, { error: 'unexpected fixture request' })
    } catch (error) {
      state.unexpectedRequests.push(
        `fixture-error:${error instanceof Error ? error.message : String(error)}`,
      )
      sendJSON(response, 500, { error: 'fixture failure' })
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
  default: ''
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

function renderWKWebViewFixture(fixtureOrigin, provenance) {
  return `;(function runComposerGridBoundary() {
  'use strict'
  const fixtureOrigin = ${JSON.stringify(fixtureOrigin)}
  const provenance = ${JSON.stringify(provenance)}
  const appConfig = ${JSON.stringify(appConfig)}
  const sessionId = ${JSON.stringify(sessionId)}
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const post = async (payload) => {
    const response = await fetch(fixtureOrigin + '/__composer_grid__/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!response.ok) throw new Error('fixture report failed: ' + response.status)
  }
  const reportError = (error) => {
    const message = error instanceof Error
      ? [error.name + ': ' + error.message, error.stack].filter(Boolean).join('\\n')
      : String(error)
    void post({ stage: 'fixture-error', message, provenance }).catch(() => {})
  }
  addEventListener('error', (event) => reportError(event.error || event.message))
  addEventListener('unhandledrejection', (event) => reportError(event.reason))
  void post({
    stage: 'bootstrap',
    provenance,
    environment: {
      isTauri: globalThis.isTauri === true,
      hasTauriInternals: typeof globalThis.__TAURI_INTERNALS__?.invoke === 'function',
      href: location.href,
    },
  }).catch(reportError)

  localStorage.clear()
  sessionStorage.clear()
  localStorage.setItem('hc-theme', 'light')
  localStorage.setItem('hc-locale', 'zh-CN')
  localStorage.setItem('hexclaw:welcomeRedirectDone', '1')
  sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
  localStorage.setItem('hexclaw_lastSessionId', sessionId)
  localStorage.setItem('app_config', JSON.stringify(appConfig))
  localStorage.setItem(
    'hexclaw_sessionDeepThinking',
    JSON.stringify({ [sessionId]: { mode: 'effort', effort: 'high' } }),
  )
  try { history.replaceState({}, '', '/chat') } catch {}

  let webSocketInstances = 0
  class FixtureWebSocket extends EventTarget {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSING = 2
    static CLOSED = 3
    readyState = FixtureWebSocket.CONNECTING
    onopen = null
    onmessage = null
    onerror = null
    onclose = null
    constructor() {
      super()
      webSocketInstances += 1
      queueMicrotask(() => {
        this.readyState = FixtureWebSocket.OPEN
        const event = new Event('open')
        this.onopen?.(event)
        this.dispatchEvent(event)
      })
    }
    send() {}
    close() {
      this.readyState = FixtureWebSocket.CLOSED
      const event = new CloseEvent('close')
      this.onclose?.(event)
      this.dispatchEvent(event)
    }
  }
  Object.defineProperty(globalThis, 'WebSocket', {
    configurable: true,
    writable: true,
    value: FixtureWebSocket,
  })
  const nativeFetch = globalThis.fetch.bind(globalThis)
  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href)
    if (url.hostname === 'localhost' && url.port === '11434') {
      return Promise.resolve(new Response(JSON.stringify({ models: [], version: 'fixture-only' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
    }
    if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname) && url.protocol !== 'tauri:') {
      return Promise.resolve(new Response(JSON.stringify({ error: 'external network blocked' }), {
        status: 451,
        headers: { 'content-type': 'application/json' },
      }))
    }
    return nativeFetch(input, init)
  }

  const waitFor = async (selector, timeout = 30000) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const element = document.querySelector(selector)
      if (element && element.getBoundingClientRect().width > 0) return element
      await sleep(80)
    }
    throw new Error('timed out waiting for ' + selector)
  }
  const round = (value) => Number(value.toFixed(2))
  const px = (value) => Number.parseFloat(value) || 0
  const rectOf = (element) => {
    const rect = element.getBoundingClientRect()
    return {
      x: round(rect.x), y: round(rect.y), width: round(rect.width), height: round(rect.height),
      top: round(rect.top), right: round(rect.right), bottom: round(rect.bottom), left: round(rect.left),
    }
  }
  const styleKeys = [
    'display', 'position', 'boxSizing', 'width', 'height', 'minWidth', 'maxWidth',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'marginTop', 'marginRight',
    'marginBottom', 'marginLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth',
    'borderLeftWidth', 'borderRadius', 'backgroundColor', 'overflowX', 'overflowY',
  ]
  const execute = async () => {
    await waitFor('.hc-composer__box--primary')
    await waitFor('.hc-model-selector__name')
    document.documentElement.dataset.theme = 'light'
    const main = document.querySelector('.hc-chat__main')
    const messages = document.querySelector('.hc-chat__messages')
    if (!(main instanceof HTMLElement) || !(messages instanceof HTMLElement)) {
      throw new Error('chat grid target is missing')
    }
    const content = document.createElement('div')
    content.dataset.gridContentFixture = 'same-content-state'
    content.innerHTML = [
      '<div style="width:320px;height:46px;border-radius:14px;background:#dbeafe;border:1px solid #bfdbfe"></div>',
      '<div style="width:420px;height:58px;margin-top:16px;border-radius:14px;background:#f3f4f6;border:1px solid #e5e7eb"></div>',
    ].join('')
    messages.replaceChildren(content)
    const fixedFrame = document.createElement('main')
    fixedFrame.id = 'bug-20260728-007-grid-frame'
    fixedFrame.style.width = '${frame.width}px'
    fixedFrame.style.height = '${frame.height}px'
    fixedFrame.append(main)
    document.body.replaceChildren(fixedFrame)
    const style = document.createElement('style')
    style.textContent = \`
      html, body { margin:0 !important; width:100% !important; min-height:100% !important; overflow:hidden !important; background:var(--hc-bg-main) !important; }
      *, *::before, *::after { animation:none !important; caret-color:transparent !important; transition:none !important; }
      #bug-20260728-007-grid-frame { box-sizing:border-box; overflow:hidden; color:var(--hc-text-primary); background:var(--hc-bg-main); font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','PingFang SC',sans-serif; }
      #bug-20260728-007-grid-frame > .hc-chat__main { box-sizing:border-box; width:100% !important; height:100% !important; min-height:0 !important; flex:none !important; }
      [data-grid-content-fixture='same-content-state'] { box-sizing:border-box; width:100%; }
    \`
    document.head.append(style)
    document.activeElement?.blur()
    if ('fonts' in document) await document.fonts.ready
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))

    const selectors = {
      main: '.hc-chat__main', messages: '.hc-chat__messages',
      messageFixture: '[data-grid-content-fixture]', composerHost: '.hc-chat__input-area',
      inputWrap: '.hc-chat__input-wrap', composerSurface: '.hc-composer__box--primary',
      editor: '[data-testid="chat-input"]',
    }
    const elements = Object.fromEntries(Object.entries(selectors).map(([name, selector]) => {
      const element = document.querySelector(selector)
      if (!(element instanceof HTMLElement)) throw new Error('selector is missing: ' + selector)
      const computed = getComputedStyle(element)
      return [name, {
        selector,
        rect: rectOf(element),
        style: Object.fromEntries(styleKeys.map((key) => [key, computed[key]])),
      }]
    }))
    const mainRect = elements.main.rect
    const messagesFact = elements.messages
    const messageFixture = elements.messageFixture.rect
    const composer = elements.composerSurface
    const contract = {
      messagePaddingLeft: px(messagesFact.style.paddingLeft),
      messagePaddingRight: px(messagesFact.style.paddingRight),
      messageSafeLeft: round(messageFixture.left - mainRect.left),
      messageSafeRight: round(mainRect.right - (messagesFact.rect.right - px(messagesFact.style.paddingRight))),
      composerSafeLeft: round(composer.rect.left - mainRect.left),
      composerSafeRight: round(mainRect.right - composer.rect.right),
      composerSurfaceWidth: composer.rect.width,
      expectedComposerSurfaceWidth: round(mainRect.width - 48),
      inputWrapMaxWidth: elements.inputWrap.style.maxWidth,
      composerSurfaceMaxWidth: composer.style.maxWidth,
      composerPaddingTop: px(composer.style.paddingTop),
      composerPaddingRight: px(composer.style.paddingRight),
      composerPaddingBottom: px(composer.style.paddingBottom),
      composerPaddingLeft: px(composer.style.paddingLeft),
    }
    const overlay = document.createElement('div')
    overlay.dataset.gridEvidenceOverlay = 'true'
    Object.assign(overlay.style, { position:'absolute', inset:'0', pointerEvents:'none', zIndex:'2147483647' })
    const line = (left, top, height, color) => {
      const marker = document.createElement('div')
      Object.assign(marker.style, {
        position:'absolute', left:left + 'px', top:top + 'px', width:'1px', height:height + 'px',
        background:color, boxShadow:'0 0 0 1px color-mix(in srgb, ' + color + ' 24%, transparent)',
      })
      overlay.append(marker)
    }
    line(24, messagesFact.rect.top - mainRect.top, composer.rect.bottom - messagesFact.rect.top, '#2563eb')
    line(mainRect.width - 24, messagesFact.rect.top - mainRect.top, composer.rect.bottom - messagesFact.rect.top, '#2563eb')
    line(contract.composerSafeLeft + contract.composerPaddingLeft, composer.rect.top - mainRect.top, composer.rect.height, '#dc2626')
    line(mainRect.width - contract.composerSafeRight - contract.composerPaddingRight, composer.rect.top - mainRect.top, composer.rect.height, '#dc2626')
    main.append(overlay)
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    await post({
      stage: 'native-grid-ready',
      provenance,
      environment: {
        runtime: 'Tauri Test.app WKWebView', isTauri: globalThis.isTauri === true,
        hasTauriInternals: typeof globalThis.__TAURI_INTERNALS__?.invoke === 'function',
        viewport: { width: innerWidth, height: innerHeight }, frame: ${JSON.stringify(frame)},
        deviceScaleFactor: devicePixelRatio, locale: navigator.language,
        colorScheme: document.documentElement.dataset.theme, reducedMotion: 'forced by test-only CSS',
        contentState: 'normal chat; session sidebar excluded; identical two-block message fixture; empty blurred composer',
        webSocketInstances,
      },
      elements,
      contract,
    })
  }
  void execute().catch(reportError)
})()
`
}

function prepareFrontend(frontend, fixtureOrigin, provenance) {
  const fixtureName = 'bug-20260728-007-current-worktree-wkwebview-fixture.js'
  writeFileSync(join(frontend, fixtureName), renderWKWebViewFixture(fixtureOrigin, provenance), {
    mode: 0o600,
  })
  const indexPath = join(frontend, 'index.html')
  const index = readFileSync(indexPath, 'utf8')
  assert.match(index, /<head>/)
  const moduleEntry = index.match(/<script type="module" crossorigin src="\.\/assets\/([^"]+\.js)">/)
  assert.ok(moduleEntry, 'current package-local module entry is missing')
  const modulePath = join(frontend, 'assets', moduleEntry[1])
  let moduleSource = readFileSync(modulePath, 'utf8')
  const platformProbe = /function [A-Za-z_$][\w$]*\(\)\{return!!globalThis\.isTauri\}/g
  const platformMatches = moduleSource.match(platformProbe) || []
  assert.equal(platformMatches.length, 1, 'current frontend must contain one platform probe')
  assert.ok(moduleSource.includes('http://localhost:16060'), 'current frontend API base is missing')
  moduleSource = moduleSource
    .replace(platformProbe, (match) => match.replace('return!!globalThis.isTauri', 'return!1'))
    .replaceAll('http://localhost:16060', fixtureOrigin)
  writeFileSync(modulePath, moduleSource, { mode: 0o600 })
  writeFileSync(indexPath, index.replace('<head>', `<head>\n<script src="./${fixtureName}"></script>`), {
    mode: 0o600,
  })
}

function writeOverlay(sandbox, frontend, sidecarPort, fixtureOrigin, snapshotSrcTauriDir) {
  const overlayPath = join(sandbox, 'tauri.composer-grid.conf.json')
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
    build: { frontendDist: relative(snapshotSrcTauriDir, frontend), beforeBuildCommand: '' },
    app: {
      windows: [
        {
          label: 'main',
          title: productName,
          width: frame.width,
          height: frame.height,
          minWidth: frame.width,
          minHeight: frame.height,
          decorations: true,
          titleBarStyle: 'Overlay',
          hiddenTitle: true,
          resizable: false,
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
      // Sidecar 尚在启动。
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

function captureWindow(pid, destination) {
  const window = windowInfoForPID(pid)
  execFileSync('/usr/sbin/screencapture', ['-x', '-l', String(window.id), destination])
  assert.ok(existsSync(destination), `native screenshot missing: ${destination}`)
  assert.ok(statSync(destination).size > 1024, `native screenshot is empty: ${destination}`)
  const dimensions = execFileSync(
    'sips',
    ['-g', 'pixelWidth', '-g', 'pixelHeight', destination],
    { encoding: 'utf8' },
  )
  return {
    ...window,
    bytes: statSync(destination).size,
    pixelWidth: Number(dimensions.match(/pixelWidth:\s*(\d+)/)?.[1]),
    pixelHeight: Number(dimensions.match(/pixelHeight:\s*(\d+)/)?.[1]),
    sha256: sha256File(destination),
  }
}

function sanitizeLog(raw, sandbox) {
  return raw.replaceAll(repoRoot, '<repo>').replaceAll(sandbox, '<sandbox>')
}

function contractDifferences(contract) {
  const expected = {
    messagePaddingLeft: 24,
    messagePaddingRight: 24,
    messageSafeLeft: 24,
    messageSafeRight: 24,
    composerSafeLeft: 24,
    composerSafeRight: 24,
    composerSurfaceWidth: 1052,
    expectedComposerSurfaceWidth: 1052,
    inputWrapMaxWidth: 'none',
    composerSurfaceMaxWidth: 'none',
    composerPaddingTop: 14,
    composerPaddingRight: 16,
    composerPaddingBottom: 12,
    composerPaddingLeft: 16,
  }
  return Object.entries(expected).flatMap(([key, value]) => {
    const actual = contract[key]
    if (typeof value === 'number' && typeof actual === 'number') {
      return Math.abs(actual - value) <= 0.5 ? [] : [`${key}: expected ${value}, got ${actual}`]
    }
    return actual === value ? [] : [`${key}: expected ${value}, got ${actual}`]
  })
}

async function main() {
  assert.equal(process.platform, 'darwin', 'native WKWebView boundary is macOS-only')
  mkdirSync(evidenceRoot, { recursive: true })
  for (const name of [
    'native-current-worktree-provenance.json',
    'native-wkwebview-layout.json',
    'native-wkwebview-implementation.png',
    'native-wkwebview-debug.png',
    'native-wkwebview-app.log',
    'native-wkwebview-cleanup.json',
  ]) {
    rmSync(join(evidenceRoot, name), { force: true })
  }
  const sandbox = mkdtempSync(join(tmpdir(), 'hexclaw-composer-grid-native.'))
  chmodSync(sandbox, 0o700)
  mkdirSync(join(sandbox, '.hexclaw'), { mode: 0o700 })
  mkdirSync(join(sandbox, 'tmp'), { mode: 0o700 })
  const frontend = join(sandbox, 'frontend')
  // 复用仓库的忽略型 Cargo 缓存；唯一 Bundle 名称仍保证 Test.app 互不覆盖。
  const cargoTarget = join(srcTauriDir, 'target')
  const appBundle = join(cargoTarget, `release/bundle/macos/${productName}.app`)
  const fixturePort = await reserveLoopbackPort()
  const sidecarPort = await reserveLoopbackPort()
  assert.notEqual(fixturePort, sidecarPort)
  const fixture = createFixtureServer(fixturePort)
  const provenance = {
    schemaVersion: 1,
    buildCommand: 'pnpm build-only:package-local',
    sourceBefore: null,
    sourceSnapshot: null,
    sourceCaptureAfterCopy: null,
    sourceAfter: null,
    sourceStable: false,
    snapshotBound: false,
    productionFrontend: null,
    injectedFrontend: null,
    app: null,
    toolchain: null,
  }
  let appProcess = null
  let appLog = null
  let stoppedSidecars = []
  let finalStatus = 'NOT_PASS'
  let finalError = null
  let screenshot = null

  try {
    await fixture.listen()
    const configPath = join(sandbox, '.hexclaw/hexclaw.yaml')
    writeFileSync(configPath, renderConfig(sandbox, sidecarPort, fixture.origin), { mode: 0o600 })
    chmodSync(configPath, 0o600)
    provenance.sourceBefore = currentSourceManifest()
    const snapshot = createSourceSnapshot(sandbox, provenance.sourceBefore)
    provenance.sourceSnapshot = snapshot.manifest
    provenance.sourceCaptureAfterCopy = currentSourceManifest()
    provenance.snapshotBound =
      provenance.sourceSnapshot.digest === provenance.sourceBefore.digest &&
      provenance.sourceCaptureAfterCopy.head === provenance.sourceBefore.head &&
      provenance.sourceCaptureAfterCopy.digest === provenance.sourceBefore.digest
    assert.ok(provenance.snapshotBound, 'could not capture a stable point-in-time source snapshot')
    const snapshotSrcTauriDir = join(snapshot.root, 'src-tauri')
    provenance.toolchain = {
      node: process.version,
      pnpm: execFileSync('pnpm', ['--version'], { cwd: snapshot.root, encoding: 'utf8' }).trim(),
      rustc: execFileSync('rustc', ['--version'], { cwd: snapshot.root, encoding: 'utf8' }).trim(),
      cargo: execFileSync('cargo', ['--version'], { cwd: snapshot.root, encoding: 'utf8' }).trim(),
    }
    const offlineEnv = {
      ...process.env,
      CARGO_NET_OFFLINE: 'true',
      CARGO_TARGET_DIR: cargoTarget,
      GOENV: 'off',
      GOPROXY: 'off',
      GOSUMDB: 'off',
      PNPM_CONFIG_OFFLINE: 'true',
      npm_config_offline: 'true',
      HEXCLAW_PACKAGE_LOCAL_DIST_DIR: frontend,
      // 隔离 Test.app 不得继承宿主机的自动注册开关，避免把用户 Ollama 投影进测试态。
      HEXCLAW_TEST_ALLOW_AUTO_LOCAL_OLLAMA: '0',
    }
    delete offlineEnv.GOROOT
    await runCommand('pnpm', ['build-only:package-local'], {
      cwd: snapshot.root,
      env: offlineEnv,
    })
    provenance.productionFrontend = treeManifest(frontend)
    const embeddedProvenance = {
      head: provenance.sourceBefore.head,
      sourceDigest: provenance.sourceBefore.digest,
      productionFrontendDigest: provenance.productionFrontend.digest,
      buildMode: 'package-local',
    }
    prepareFrontend(frontend, fixture.origin, embeddedProvenance)
    provenance.injectedFrontend = treeManifest(frontend)
    const overlay = writeOverlay(
      sandbox,
      frontend,
      sidecarPort,
      fixture.origin,
      snapshotSrcTauriDir,
    )
    await runCommand('pnpm', ['exec', 'tauri', 'build', '--config', overlay, '--bundles', 'app'], {
      cwd: snapshot.root,
      env: offlineEnv,
    })

    const infoPlist = join(appBundle, 'Contents/Info.plist')
    const executable = join(appBundle, 'Contents/MacOS/hexclaw-desktop')
    const sidecarExecutable = join(appBundle, 'Contents/MacOS/hexclaw')
    assert.ok(existsSync(infoPlist), `unique Test.app missing: ${infoPlist}`)
    assert.ok(existsSync(executable), `unique Test.app executable missing: ${executable}`)
    assert.ok(existsSync(sidecarExecutable), `unique Test.app Sidecar missing: ${sidecarExecutable}`)
    const identifier = execFileSync(
      'plutil',
      ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', infoPlist],
      { encoding: 'utf8' },
    ).trim()
    assert.equal(identifier, bundleIdentifier)
    provenance.app = {
      productName,
      identifier,
      executableSHA256: sha256File(executable),
      sidecarSHA256: sha256File(sidecarExecutable),
      infoPlistSHA256: sha256File(infoPlist),
    }
    provenance.sourceAfter = currentSourceManifest()
    provenance.sourceStable =
      provenance.sourceAfter.head === provenance.sourceBefore.head &&
      provenance.sourceAfter.digest === provenance.sourceBefore.digest
    assert.ok(provenance.snapshotBound, 'Test.app source snapshot provenance is not exact')
    assert.ok(
      provenance.sourceStable,
      'current worktree changed during Test.app build; rerun against a stable source snapshot',
    )
    const snapshotAfterBuild = manifestForFiles(
      provenance.sourceSnapshot.entries.map((entry) => join(snapshot.root, entry.path)),
      snapshot.root,
    )
    assert.equal(
      snapshotAfterBuild.digest,
      provenance.sourceSnapshot.digest,
      'source snapshot changed during Test.app build',
    )
    assert.equal(statSync(sandbox).mode & 0o777, 0o700)
    assert.equal(statSync(join(sandbox, '.hexclaw')).mode & 0o777, 0o700)
    assert.equal(statSync(configPath).mode & 0o777, 0o600)
    assert.deepEqual(listenerPIDs(sidecarPort), [], `dedicated Sidecar port ${sidecarPort} is occupied`)

    const appLogPath = join(sandbox, 'app.log')
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
      HEXCLAW_TEST_ALLOW_AUTO_LOCAL_OLLAMA: '0',
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
    const sidecarPIDs = listenerPIDs(sidecarPort)
    assert.equal(sidecarPIDs.length, 1, 'unique Test.app must own exactly one Sidecar listener')
    await waitForReport(fixture.state, 'bootstrap', 20_000)
    const report = await waitForReport(fixture.state, 'native-grid-ready')
    const differences = contractDifferences(report.contract)
    assert.deepEqual(differences, [])
    assert.equal(report.environment.runtime, 'Tauri Test.app WKWebView')
    assert.equal(report.environment.isTauri, true)
    assert.equal(report.environment.hasTauriInternals, true)
    assert.deepEqual(report.environment.frame, frame)
    assert.equal(report.elements.main.rect.width, frame.width)
    assert.equal(report.provenance.head, provenance.sourceBefore.head)
    assert.equal(report.provenance.sourceDigest, provenance.sourceBefore.digest)
    assert.equal(
      report.provenance.productionFrontendDigest,
      provenance.productionFrontend.digest,
    )
    assert.equal(fixture.state.chatRequests, 0)
    assert.deepEqual(fixture.state.unexpectedRequests, [])
    await sleep(500)
    screenshot = captureWindow(
      appProcess.pid,
      join(evidenceRoot, 'native-wkwebview-implementation.png'),
    )
    const rawLog = readFileSync(appLogPath, 'utf8')
    assert.doesNotMatch(rawLog, /localhost:11434/, 'isolated Test.app must not probe user Ollama')
    writeFileSync(
      join(evidenceRoot, 'native-wkwebview-layout.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          status: 'PASS',
          bug: 'BUG-20260728-007',
          scope: 'chat message/composer horizontal 24px grid only',
          report,
          differences,
          screenshot,
          app: { ...provenance.app, realWKWebView: true, nativeWindow: true },
          isolation: {
            testHomeMode: '0700',
            configMode: '0600',
            uniqueBundleIdentifier: true,
            sidecarPort,
            fixturePort,
            applicationsDirectoryTouched: false,
            realHomeRead: false,
            externalNetworkPolicy: 'loopback-only',
            realModelInvocations: 0,
            realIMInvocations: 0,
          },
          fixtureReceipts: fixture.state,
        },
        null,
        2,
      )}\n`,
    )
    finalStatus = 'PASS'
    process.stdout.write('\nBUG-20260728-007 native WKWebView boundary PASS\n')
  } catch (error) {
    finalError = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    if (appProcess && appProcess.exitCode === null) {
      try {
        captureWindow(appProcess.pid, join(evidenceRoot, 'native-wkwebview-debug.png'))
      } catch {
        // 没有可见窗口时仅保留结构化失败回执。
      }
    }
    throw error
  } finally {
    await stopProcess(appProcess)
    if (appLog) await new Promise((resolveEnd) => appLog.end(resolveEnd))
    try {
      stoppedSidecars = await stopOwnedSidecar(sidecarPort, appBundle)
    } catch (error) {
      if (!finalError) finalError = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    }
    await fixture.close()
    const logPath = join(sandbox, 'app.log')
    if (existsSync(logPath)) {
      writeFileSync(
        join(evidenceRoot, 'native-wkwebview-app.log'),
        sanitizeLog(readFileSync(logPath, 'utf8'), sandbox),
      )
    }
    writeFileSync(
      join(evidenceRoot, 'native-current-worktree-provenance.json'),
      `${JSON.stringify({ ...provenance, status: finalStatus, error: finalError }, null, 2)}\n`,
    )
    rmSync(appBundle, { recursive: true, force: true })
    const uniqueAppBundleRemoved = !existsSync(appBundle)
    rmSync(sandbox, { recursive: true, force: true })
    writeFileSync(
      join(evidenceRoot, 'native-wkwebview-cleanup.json'),
      `${JSON.stringify(
        {
          status: finalStatus,
          error: finalError,
          appProcessStopped:
            !appProcess || appProcess.exitCode !== null || appProcess.signalCode !== null,
          sidecarPortReleased: listenerPIDs(sidecarPort).length === 0,
          fixturePortReleased: listenerPIDs(fixturePort).length === 0,
          uniqueAppBundleRemoved,
          sandboxRemoved: !existsSync(sandbox),
          stoppedSidecars,
          reports: fixture.state.reports,
        },
        null,
        2,
      )}\n`,
    )
  }
}

// 其它当前源码原生门复用同一份隔离构建/清理工具；直接执行本文件时仍保持原有行为。
export {
  captureWindow,
  createSourceSnapshot,
  currentSourceManifest,
  listenerPIDs,
  manifestForFiles,
  renderConfig,
  reserveLoopbackPort,
  runCommand,
  sanitizeLog,
  sha256File,
  stopOwnedSidecar,
  stopProcess,
  treeManifest,
  waitForHealth,
}

if (process.env.HEXCLAW_NATIVE_LIBRARY !== '1') {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
