#!/usr/bin/env node

/**
 * BUG-20260801-012 当前工作树的隔离原生视觉边界。
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
const evidenceRoot = join(repoRoot, '../hexclaw-docs/test/evidence/bug-20260801-012-ambient-current-source/native')
const productName = 'HexClaw Ambient BUG012 Test'
const bundleIdentifier = 'com.hexclaw.desktop.bug-20260801-012'
const commandTimeoutMs = 15 * 60 * 1000
const frame = { width: 1480, height: 900 }
const sessionId = 'bug-20260801-012-grid-session'
const fixedTime = '2026-07-28T08:00:00.000Z'
const expectedRightAnchors = ['78%/13%', '84%/23%', '91%/11%', '96%/19%', '80%/43%', '90%/34%', '96%/51%', '78%/65%', '87%/74%', '96%/84%', '76%/31%', '83%/54%', '93%/66%', '82%/88%']
const expectedSidebarAnchors = ['1.5%/68%', '9.5%/70%', '2.6%/83%', '10%/85%']
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
    process.stdout.write(`\n[bug012-ambient-native] ${command} ${args.join(' ')}\n`)
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
  if (path === '/health') return { status: 'ok' }
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
  if (path === '/api/v1/logs') {
    return {
      logs: [
        { id: 'log-4', timestamp: '2026-07-29T12:49:13+08:00', level: 'warn', source: 'knowledge', message: 'embedding 未配置，知识库使用基础检索', trace_id: 'kb-fallback', domain: 'knowledge' },
        { id: 'log-3', timestamp: '2026-07-29T12:48:05+08:00', level: 'info', source: 'llm', message: 'local model (Ollama) connected · qwen3.5:9b ready', trace_id: 'llm-ready', domain: 'chat' },
        { id: 'log-2', timestamp: '2026-07-29T12:48:02+08:00', level: 'debug', source: 'channels', message: 'loaded 6 platform adapters, 0 instances enabled', trace_id: 'channels-load', domain: 'integration' },
        { id: 'log-1', timestamp: '2026-07-29T12:48:02+08:00', level: 'info', source: 'sidecar', message: 'engine started · listening on :16060', trace_id: 'engine-start', domain: 'engine' },
      ],
      total: 4,
    }
  }
  if (path === '/api/v1/logs/stats') return { total: 4, by_level: { debug: 1, info: 2, warn: 1, error: 0 }, by_source: { sidecar: 1, channels: 1, llm: 1, knowledge: 1 }, requests_per_minute: 0 }
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
      if (request.method === 'POST' && url.pathname === '/__bug012_ambient__/report') {
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
  default: fixture
  providers:
    fixture:
      api_key: local-fixture-only
      base_url: ${fixtureOrigin}/v1
      model: fixture-model
      models:
        - fixture-model
      model_specs_mode: explicit
      model_specs:
        - id: fixture-model
          display_name: Isolated Fixture Model
          capabilities:
            - text
      compatible: openai
      locality: cloud
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
  return `;(function runBug012AmbientBoundary() {
  'use strict'
  const fixtureOrigin = ${JSON.stringify(fixtureOrigin)}
  const provenance = ${JSON.stringify(provenance)}
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const post = async (payload) => {
    const response = await fetch(fixtureOrigin + '/__bug012_ambient__/report', {
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

  localStorage.clear()
  sessionStorage.clear()
  localStorage.setItem('hc-theme', 'light')
  localStorage.setItem('hc-locale', 'zh-CN')
  localStorage.setItem('hc-k12-appearance-v1', JSON.stringify({ version: 1, preference: 'k12', introSeen: true }))
  localStorage.setItem('hexclaw:welcomeRedirectDone', '1')
  sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
  try { history.replaceState({}, '', '/logs') } catch {}

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
  const waitForAbsent = async (selector, timeout = 35000) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (!document.querySelector(selector)) return
      await sleep(80)
    }
    throw new Error('timed out waiting for removal of ' + selector)
  }
  const splashState = () => {
    const node = document.getElementById('splash-screen')
    if (!node) return { exists: false }
    const style = getComputedStyle(node)
    const rect = node.getBoundingClientRect()
    return {
      exists: true,
      display: style.display,
      visibility: style.visibility,
      opacity: style.opacity,
      pointerEvents: style.pointerEvents,
      rect: {
        x: Number(rect.x.toFixed(3)),
        y: Number(rect.y.toFixed(3)),
        width: Number(rect.width.toFixed(3)),
        height: Number(rect.height.toFixed(3)),
      },
    }
  }
  const waitForPaintBarrier = async () => {
    const frames = []
    for (let index = 0; index < 3; index += 1) {
      await new Promise((resolve) => {
        requestAnimationFrame((timestamp) => {
          frames.push({ index, timestamp })
          resolve()
        })
      })
    }
    return {
      frameCount: frames.length,
      frameTimestamps: frames.map((frame) => Number(frame.timestamp.toFixed(3))),
      documentReadyState: document.readyState,
      visibilityState: document.visibilityState,
      splash: splashState(),
    }
  }
  const round = (value) => Number(value.toFixed(3))
  const rectOf = (node) => {
    const rect = node.getBoundingClientRect()
    return {
      x: round(rect.x), y: round(rect.y), width: round(rect.width), height: round(rect.height),
      right: round(rect.right), bottom: round(rect.bottom),
    }
  }
  const styleOf = (node) => {
    const style = getComputedStyle(node)
    return {
      rect: rectOf(node),
      position: style.position,
      display: style.display,
      visibility: style.visibility,
      opacity: style.opacity,
      pointerEvents: style.pointerEvents,
      top: style.top,
      right: style.right,
      bottom: style.bottom,
      left: style.left,
      width: style.width,
      height: style.height,
      backgroundColor: style.backgroundColor,
      backgroundImage: style.backgroundImage,
      backgroundPosition: style.backgroundPosition,
      backgroundSize: style.backgroundSize,
      maskImage: style.maskImage || style.getPropertyValue('-webkit-mask-image'),
      overflow: style.overflow,
    }
  }
  const nodesOf = (selector) => [...document.querySelectorAll(selector)].map((node, index) => {
    const style = getComputedStyle(node)
    return {
      index,
      className: node.className,
      rect: rectOf(node),
      anchor: {
        cssLeft: style.left,
        cssTop: style.top,
        x: style.getPropertyValue('--x').trim(),
        y: style.getPropertyValue('--y').trim(),
      },
      display: style.display,
      visibility: style.visibility,
      opacity: style.opacity,
      pointerEvents: style.pointerEvents,
      animationName: style.animationName,
      animationDuration: style.animationDuration,
      backgroundImage: style.backgroundImage,
      backgroundPosition: style.backgroundPosition,
      maskImage: style.maskImage || style.getPropertyValue('-webkit-mask-image'),
      borderRadius: style.borderRadius,
      boxShadow: style.boxShadow,
      ariaExcluded: Boolean(node.closest('[aria-hidden="true"]')),
      sidebar: node.classList.contains('k12-ambient-firefly--sidebar'),
    }
  })
  const collect = async (theme, stage) => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('hc-theme', theme)
    await waitForAbsent('#splash-screen')
    await document.fonts.ready
    const paint = await waitForPaintBarrier()
    const splash = splashState()
    if (splash.exists) throw new Error('splash-screen remained in the DOM after the paint barrier')
    const root = document.querySelector('[data-testid="k12-global-presentation"]')
    const sidebar = document.querySelector('.k12-global-presentation__sidebar-scene')
    const butterflyLayer = document.querySelector('.k12-global-presentation__butterflies')
    const fireflyLayer = document.querySelector('.k12-global-presentation__fireflies')
    if (!root || !sidebar || !butterflyLayer || !fireflyLayer) {
      throw new Error('K12 global presentation targets are missing')
    }
    const butterflies = nodesOf('.k12-ambient-butterfly')
    const fireflies = nodesOf('.k12-ambient-firefly')
    const visible = (node) => node.display !== 'none' && node.visibility !== 'hidden' && Number(node.opacity) > 0
    const report = {
      stage,
      provenance,
      environment: {
        runtime: 'Tauri Test.app WKWebView',
        isTauri: globalThis.isTauri === true,
        hasTauriInternals: typeof globalThis.__TAURI_INTERNALS__?.invoke === 'function',
        viewport: { width: innerWidth, height: innerHeight },
        deviceScaleFactor: devicePixelRatio,
        locale: navigator.language,
        theme: document.documentElement.dataset.theme,
        route: location.pathname,
        skin: document.body.dataset.k12SkinActive,
        businessDOMMutations: 0,
      },
      splash,
      paint,
      root: styleOf(root),
      sidebar: styleOf(sidebar),
      butterflyLayer: styleOf(butterflyLayer),
      fireflyLayer: styleOf(fireflyLayer),
      butterflies,
      fireflies,
      counts: {
        butterflies: butterflies.length,
        fireflies: fireflies.length,
        rightFireflies: fireflies.filter((node) => !node.sidebar).length,
        sidebarFireflies: fireflies.filter((node) => node.sidebar).length,
        visibleButterflies: butterflies.filter(visible).length,
        visibleFireflies: fireflies.filter(visible).length,
      },
      legacySceneCount: document.querySelectorAll('.k12-scene-layer').length,
      extraAmbientNodes: document.querySelectorAll(
        '[data-k12-ambient-layer] .k12-ambient-butterfly:not(.k12-ambient-butterfly--one):not(.k12-ambient-butterfly--two)',
      ).length,
    }
    await post(report)
  }

  const execute = async () => {
    await post({
      stage: 'bootstrap',
      provenance,
      environment: {
        isTauri: globalThis.isTauri === true,
        hasTauriInternals: typeof globalThis.__TAURI_INTERNALS__?.invoke === 'function',
        href: location.href,
      },
    })
    await waitFor('[data-testid="k12-global-presentation"]')
    await waitFor('.hc-logs-page')
    await waitForAbsent('#splash-screen')
    const startupPaint = await waitForPaintBarrier()
    if (startupPaint.splash.exists) {
      throw new Error('splash-screen remained in the DOM after startup paint barrier')
    }
    await collect('light', 'native-light-ready')
    await sleep(3500)
    await collect('dark', 'native-dark-ready')
    await sleep(3500)
  }
  void execute().catch(reportError)
})()
`
}
function prepareFrontend(frontend, fixtureOrigin, provenance) {
  const fixtureName = 'bug-20260801-012-current-worktree-wkwebview-fixture.js'
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
  const overlayPath = join(sandbox, 'tauri.bug012-ambient.conf.json')
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

async function waitForReportCount(state, stage, count, timeout = 60_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const matches = state.reports.filter((entry) => entry.stage === stage)
    if (matches.length >= count) return matches[count - 1]
    const error = state.reports.find((entry) => entry.stage === 'fixture-error')
    if (error) throw new Error(`WKWebView fixture failed: ${error.message}`)
    await sleep(100)
  }
  throw new Error(`timed out waiting for WKWebView report ${stage} #${count}`)
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
  }
}
`
  const output = execFileSync('/usr/bin/swift', ['-e', swift], { encoding: 'utf8' }).trim()
  assert.ok(output, `no visible native window found for PID ${pid}`)
  const windows = output.split('\n').filter(Boolean).map((line) => {
    const [id, x, y, width, height] = line.split('|').map(Number)
    assert.ok([id, x, y, width, height].every(Number.isFinite), `invalid window info: ${line}`)
    return { id, x, y, width, height }
  })
  assert.equal(
    windows.length,
    1,
    `native Test.app must expose exactly one visible layer-0 window for PID ${pid}; found ${windows.length}: ${output}`,
  )
  return { ...windows[0], windowCount: windows.length }
}

function activateProcess(pid) {
  const swift = `
import AppKit
let target: pid_t = ${Number(pid)}
guard let app = NSRunningApplication(processIdentifier: target) else {
  print("missing")
  exit(0)
}
let activated = app.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
print(activated ? "activated" : "not-activated")
`
  const output = execFileSync('/usr/bin/swift', ['-e', swift], { encoding: 'utf8' }).trim()
  assert.equal(output, 'activated', `could not activate native Test.app PID ${pid}: ${output}`)
}

async function waitForNativeCaptureReady(pid) {
  activateProcess(pid)
  let previous = null
  let stableSamples = 0
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const current = windowInfoForPID(pid)
    const signature = JSON.stringify({
      id: current.id,
      x: current.x,
      y: current.y,
      width: current.width,
      height: current.height,
    })
    stableSamples = signature === previous ? stableSamples + 1 : 1
    if (stableSamples >= 3) return { ...current, stableSamples }
    previous = signature
    await sleep(120)
  }
  throw new Error(`native Test.app window did not stabilize before capture for PID ${pid}`)
}

function captureWindowNow(window, destination) {
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

async function captureWindow(pid, destination, report) {
  assert.ok(report, 'official native ambient screenshots require a WKWebView report')
  assert.equal(report.splash?.exists, false, 'official native screenshot refused while splash exists')
  const window = await waitForNativeCaptureReady(pid)
  return captureWindowNow(window, destination)
}

async function captureDebugWindow(pid, destination) {
  const window = await waitForNativeCaptureReady(pid)
  return captureWindowNow(window, destination)
}

function sanitizeLog(raw, sandbox) {
  return raw.replaceAll(repoRoot, '<repo>').replaceAll(sandbox, '<sandbox>')
}

function ambientDifferences(report, theme) {
  const differences = []
  const requireFact = (condition, message) => {
    if (!condition) differences.push(message)
  }
  const viewport = report.environment.viewport
  const rightAnchors = report.fireflies
    .filter((node) => !node.sidebar)
    .map((node) => `${node.anchor.x}/${node.anchor.y}`)
  const sidebarAnchors = report.fireflies
    .filter((node) => node.sidebar)
    .map((node) => `${node.anchor.x}/${node.anchor.y}`)
  requireFact(report.environment.runtime === 'Tauri Test.app WKWebView', 'runtime is not WKWebView')
  requireFact(report.environment.isTauri === true, 'Tauri runtime marker is absent')
  requireFact(report.environment.hasTauriInternals === true, 'Tauri internals are absent')
  requireFact(report.environment.theme === theme, `theme expected ${theme}`)
  requireFact(report.environment.route === '/logs', 'business route is not /logs')
  requireFact(report.environment.skin === 'k12', 'K12 presentation is not active')
  requireFact(report.environment.businessDOMMutations === 0, 'fixture changed business DOM')
  requireFact(report.splash?.exists === false, 'splash-screen remained during ambient capture')
  requireFact(
    report.paint?.frameCount >= 3 && report.paint?.documentReadyState === 'complete',
    'ambient capture did not cross the three-frame document paint barrier',
  )
  requireFact(
    report.paint?.visibilityState === 'visible',
    'ambient capture was taken while the WKWebView document was not visible',
  )
  requireFact(report.sidebar.rect.x === 0 && report.sidebar.rect.width === 226, 'Sidebar scene is not 226px wide at x=0')
  requireFact(report.sidebar.rect.height === 340 && report.sidebar.rect.bottom === viewport.height, 'Sidebar scene is not the bottom 340px')
  requireFact(report.sidebar.maskImage !== 'none', 'Sidebar scene mask is absent')
  requireFact(report.fireflyLayer.position === 'fixed', 'firefly layer is not fixed')
  requireFact(report.fireflyLayer.rect.x === 0 && report.fireflyLayer.rect.y === 0 && report.fireflyLayer.rect.width === viewport.width && report.fireflyLayer.rect.height === viewport.height, 'firefly layer does not cover the WKWebView viewport')
  requireFact(report.counts.butterflies === 2, 'butterfly node exact-set is not 2')
  requireFact(report.counts.rightFireflies === 14 && report.counts.sidebarFireflies === 4, 'firefly node exact-set is not 14+4')
  requireFact(theme === 'light' ? report.counts.visibleButterflies === 2 && report.counts.visibleFireflies === 0 : report.counts.visibleButterflies === 0 && report.counts.visibleFireflies === 18, 'visible ambient exact-set does not match theme')
  requireFact(JSON.stringify(rightAnchors) === JSON.stringify(expectedRightAnchors), 'right firefly anchors drifted')
  requireFact(JSON.stringify(sidebarAnchors) === JSON.stringify(expectedSidebarAnchors), 'sidebar firefly anchors drifted')
  requireFact(report.butterflies.map((node) => `${node.anchor.cssLeft}/${node.anchor.cssTop}`).join(',') === '154px/360px,130px/412px', 'butterfly anchors drifted')
  requireFact([...report.butterflies, ...report.fireflies].every((node) => node.pointerEvents === 'none' && node.ariaExcluded), 'ambient semantics are interactive or exposed')
  requireFact(report.legacySceneCount === 0, 'legacy full-viewport scene exists')
  requireFact(report.extraAmbientNodes === 0, 'extra butterfly node exists')
  return differences
}

async function main() {
  assert.equal(process.platform, 'darwin', 'native WKWebView boundary is macOS-only')
  mkdirSync(evidenceRoot, { recursive: true })
  for (const name of [
    'native-current-worktree-provenance.json',
    'native-wkwebview-ambient.json',
    'native-wkwebview-light.png',
    'native-wkwebview-dark.png',
    'native-wkwebview-restart-light.png',
    'native-wkwebview-debug.png',
    'native-wkwebview-app.log',
    'native-wkwebview-cleanup.json',
  ]) {
    rmSync(join(evidenceRoot, name), { force: true })
  }
  const sandbox = mkdtempSync(join(tmpdir(), 'hexclaw-bug012-ambient-native.'))
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
  const screenshots = {}

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
      DINGTALK_LIVE_SEND: '0',
      NO_PROXY: '*',
      no_proxy: '*',
    }
    const launchApp = async () => {
      const processHandle = spawn(executable, [], {
        cwd: sandbox,
        env: runtimeEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      processHandle.stdout.pipe(appLog, { end: false })
      processHandle.stderr.pipe(appLog, { end: false })
      await waitForHealth(sidecarPort, processHandle)
      assert.equal(listenerPIDs(sidecarPort).length, 1, 'unique Test.app must own exactly one Sidecar listener')
      return processHandle
    }

    appProcess = await launchApp()
    await waitForReportCount(fixture.state, 'bootstrap', 1, 20_000)
    const lightReport = await waitForReportCount(fixture.state, 'native-light-ready', 1)
    const lightDifferences = ambientDifferences(lightReport, 'light')
    assert.deepEqual(lightDifferences, [])
    screenshots.light = await captureWindow(
      appProcess.pid,
      join(evidenceRoot, 'native-wkwebview-light.png'),
      lightReport,
    )
    const darkReport = await waitForReportCount(fixture.state, 'native-dark-ready', 1)
    const darkDifferences = ambientDifferences(darkReport, 'dark')
    assert.deepEqual(darkDifferences, [])
    screenshots.dark = await captureWindow(
      appProcess.pid,
      join(evidenceRoot, 'native-wkwebview-dark.png'),
      darkReport,
    )

    await stopProcess(appProcess)
    stoppedSidecars.push(...(await stopOwnedSidecar(sidecarPort, appBundle)))
    appProcess = await launchApp()
    await waitForReportCount(fixture.state, 'bootstrap', 2, 20_000)
    const restartLightReport = await waitForReportCount(fixture.state, 'native-light-ready', 2)
    const restartDifferences = ambientDifferences(restartLightReport, 'light')
    assert.deepEqual(restartDifferences, [])
    screenshots.restartLight = await captureWindow(
      appProcess.pid,
      join(evidenceRoot, 'native-wkwebview-restart-light.png'),
      restartLightReport,
    )

    for (const report of [lightReport, darkReport, restartLightReport]) {
      assert.equal(report.provenance.head, provenance.sourceBefore.head)
      assert.equal(report.provenance.sourceDigest, provenance.sourceBefore.digest)
      assert.equal(report.provenance.productionFrontendDigest, provenance.productionFrontend.digest)
    }
    assert.equal(fixture.state.chatRequests, 0)
    assert.deepEqual(fixture.state.unexpectedRequests, [])
    const rawLog = readFileSync(appLogPath, 'utf8')
    assert.doesNotMatch(rawLog, /localhost:11434/, 'isolated Test.app must not probe user Ollama')
    writeFileSync(
      join(evidenceRoot, 'native-wkwebview-ambient.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          status: 'PASS',
          bug: 'BUG-20260801-012',
          scope: 'K12 global ambient layer in current-source Test.app WKWebView',
          reports: { light: lightReport, dark: darkReport, restartLight: restartLightReport },
          differences: { light: lightDifferences, dark: darkDifferences, restartLight: restartDifferences },
          screenshots,
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
    process.stdout.write('\nBUG-20260801-012 native WKWebView boundary PASS\n')
  } catch (error) {
    finalError = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    if (appProcess && appProcess.exitCode === null) {
      try {
        await captureDebugWindow(appProcess.pid, join(evidenceRoot, 'native-wkwebview-debug.png'))
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

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`)
  process.exitCode = 1
})
