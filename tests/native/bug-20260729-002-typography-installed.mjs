#!/usr/bin/env node

/**
 * BUG-20260729-002 的 current-worktree 原生第三腿。
 *
 * 该 harness 只构建唯一临时 Test.app，在真实 WKWebView 内注入只读排版探针，并使用
 * 0700 临时 HOME、专属 loopback 端口与唯一测试 bundle。生产源码、权威原型、
 * /Applications 和真实 HOME 均不修改；finally 只清理本轮 PID、端口、Test.app 与沙箱。
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
  readdirSync,
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
const evidenceRoot = join(
  docsRoot,
  'test/evidence/bug-20260729-002-global-typography-current/installed-current-source',
)
const browserEvidenceRoot = dirname(evidenceRoot)
const pixelDiffTool = join(repoRoot, 'tests/e2e/tools/visual_pixel_diff.py')
const browserVisualSpec = join(
  repoRoot,
  'tests/e2e/bug-20260729-002-global-typography-visual.spec.ts',
)

const productName = 'HexClaw BUG002 Typography Test'
const bundleIdentifier = 'com.hexclaw.desktop.bug-20260729-002-typography'
const viewport = { width: 1440, height: 900 }
const deviceScaleFactor = 2
const maximumPixelDifference = 0.01
const commandTimeoutMs = 15 * 60_000
const expectedTypography = { fontSize: '14px', lineHeight: '21px' }

const sleep = (milliseconds) =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds))

function sha256Buffer(value) {
  return createHash('sha256').update(value).digest('hex')
}

function sha256File(path) {
  return sha256Buffer(readFileSync(path))
}

function writeJSON(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
}

function sanitize(value, sandbox = '') {
  let text = String(value || '')
    .replaceAll(repoRoot, '<hexclaw-desktop>')
    .replaceAll(docsRoot, '<hexclaw-docs>')
  if (sandbox) text = text.replaceAll(sandbox, '<sandbox>')
  const userPathPattern = sep === '\\' ? /[A-Za-z]:\\Users\\[^\\\s]+/g : /\/Users\/[^/\s]+/g
  return text.replace(userPathPattern, '<user-home>')
}

function git(args) {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || `git ${args.join(' ')} failed`)
  return result.stdout.trim()
}

function snapshotRelevantSources() {
  const files = [
    'index.html',
    'package.json',
    'pnpm-lock.yaml',
    'vite.config.ts',
    'src/main.ts',
    'src/App.vue',
    'src/assets/styles/global.css',
    'src/components/layout/AppLayout.vue',
    'src/views/SettingsView.vue',
    'src-tauri/Cargo.toml',
    'src-tauri/Cargo.lock',
    'src-tauri/tauri.conf.json',
    'src-tauri/src/main.rs',
    'src-tauri/src/lib.rs',
    'src-tauri/src/test_runtime.rs',
  ]
  return files.map((file) => {
    const absolute = join(repoRoot, file)
    assert.ok(existsSync(absolute), `provenance source is missing: ${file}`)
    return { file, bytes: statSync(absolute).size, sha256: sha256File(absolute) }
  })
}

function directoryManifest(root) {
  const rows = []
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) visit(absolute)
      else if (entry.isFile()) {
        rows.push({
          file: relative(root, absolute),
          bytes: statSync(absolute).size,
          sha256: sha256File(absolute),
        })
      }
    }
  }
  visit(root)
  return rows.sort((left, right) => left.file.localeCompare(right.file))
}

async function runCommand(command, args, options = {}) {
  const startedAt = Date.now()
  let output = ''
  const child = spawn(command, args, {
    cwd: options.cwd || repoRoot,
    env: options.env || process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const capture = (chunk, destination) => {
    const text = chunk.toString()
    output += text
    destination.write(text)
  }
  child.stdout.on('data', (chunk) => capture(chunk, process.stdout))
  child.stderr.on('data', (chunk) => capture(chunk, process.stderr))
  let timer
  try {
    const result = await Promise.race([
      new Promise((resolveExit, rejectExit) => {
        child.once('error', rejectExit)
        child.once('exit', (code, signal) => resolveExit({ code, signal }))
      }),
      new Promise((_, rejectTimeout) => {
        timer = setTimeout(() => {
          child.kill('SIGTERM')
          rejectTimeout(new Error(`${command} timed out after ${commandTimeoutMs}ms`))
        }, options.timeoutMs || commandTimeoutMs)
      }),
    ])
    if (result.code !== 0) {
      throw new Error(`${command} exited ${result.code ?? result.signal}\n${output.slice(-12_000)}`)
    }
    return {
      command,
      args: args.map((arg) => sanitize(arg, options.sandbox)),
      durationMs: Date.now() - startedAt,
      output,
    }
  } finally {
    clearTimeout(timer)
  }
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
      '.woff2': 'font/woff2',
    }[extname(path).toLowerCase()] || 'application/octet-stream'
  )
}

async function readRequestBody(request) {
  const chunks = []
  let bytes = 0
  for await (const chunk of request) {
    bytes += chunk.length
    if (bytes > 2 * 1024 * 1024) throw new Error('fixture report exceeds 2 MiB')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function createLoopbackFixture(port) {
  const state = {
    reports: [],
    updaterRequests: 0,
    staticRequests: [],
    blockedExternalRequests: [],
    unexpectedRequests: [],
  }
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
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
      if (request.method === 'OPTIONS' && url.pathname === '/__bug002__/report') {
        response.writeHead(204, cors)
        response.end()
        return
      }
      if (request.method === 'POST' && url.pathname === '/__bug002__/report') {
        state.reports.push(JSON.parse((await readRequestBody(request)) || '{}'))
        const body = JSON.stringify({ ok: true })
        response.writeHead(200, {
          ...cors,
          'content-type': 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(body),
        })
        response.end(body)
        return
      }
      if (request.method === 'GET' && url.pathname === '/__bug002__/updater') {
        state.updaterRequests += 1
        response.writeHead(204, cors)
        response.end()
        return
      }
      if (request.method === 'GET') {
        const decoded = decodeURIComponent(url.pathname === '/' ? '/app.html' : url.pathname)
        const absolute = resolve(prototypeRoot, `.${decoded}`)
        if (absolute.startsWith(`${prototypeRoot}${sep}`) && existsSync(absolute)) {
          const body = readFileSync(absolute)
          state.staticRequests.push(decoded)
          response.writeHead(200, {
            'cache-control': 'no-store',
            'content-type': contentType(absolute),
            'content-length': body.length,
          })
          response.end(body)
          return
        }
      }
      state.unexpectedRequests.push(`${request.method} ${url.pathname}`)
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('not found')
    } catch (error) {
      state.unexpectedRequests.push(
        `fixture-error:${error instanceof Error ? error.message : String(error)}`,
      )
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
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
      if (!server.listening) return
      await new Promise((resolveClose) => server.close(resolveClose))
    },
  }
}

function extractFixtureSource() {
  const source = readFileSync(browserVisualSpec, 'utf8')
  const extract = (name) => {
    const match = source.match(new RegExp('const ' + name + ' = `([\\s\\S]*?)`'))
    assert.ok(match, `${name} is missing from the browser visual oracle`)
    return match[1]
  }
  return { markup: extract('probeMarkup'), css: extract('probeCSS') }
}

function snapshotFunction() {
  return `
    const snapshot = (selector) => {
      const element = document.querySelector(selector)
      if (!(element instanceof HTMLElement)) return null
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return {
        selector,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom },
        style: {
          display: style.display,
          fontSize: style.fontSize,
          lineHeight: style.lineHeight,
          fontFamily: style.fontFamily,
          fontWeight: style.fontWeight,
          letterSpacing: style.letterSpacing,
          webkitFontSmoothing: style.getPropertyValue('-webkit-font-smoothing'),
        },
      }
    }
    const collect = (selectors) => Object.fromEntries(
      Object.entries(selectors).map(([name, selector]) => [name, snapshot(selector)]),
    )
  `
}

function renderInstalledFixture(fixtureOrigin, probe) {
  return `;(function runBug002InstalledTypographyBoundary() {
  'use strict'
  const fixtureOrigin = ${JSON.stringify(fixtureOrigin)}
  const probeMarkup = ${JSON.stringify(probe.markup)}
  const sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds))
  const post = async (payload) => {
    const response = await fetch(fixtureOrigin + '/__bug002__/report', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!response.ok) throw new Error('fixture report failed: ' + response.status)
  }
  const reportError = (error) => {
    const message = error instanceof Error
      ? [error.name + ': ' + error.message, error.stack].filter(Boolean).join('\\n')
      : String(error)
    void post({ stage: 'fixture-error', message }).catch(() => {})
  }
  addEventListener('error', (event) => reportError(event.error || event.message))
  addEventListener('unhandledrejection', (event) => reportError(event.reason))

  localStorage.clear()
  sessionStorage.clear()
  localStorage.setItem('hc-theme', 'light')
  localStorage.setItem('hc-k12-appearance-v1', JSON.stringify({ version: 1, preference: 'default', introSeen: true }))
  localStorage.setItem('hexclaw:welcomeRedirectDone', '1')
  sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
  history.replaceState(null, '', '/settings')

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
  ${snapshotFunction()}
  const execute = async () => {
    if (document.readyState === 'loading') {
      await new Promise((resolveReady) => addEventListener('DOMContentLoaded', resolveReady, { once: true }))
    }
    await waitFor(() => document.querySelector('.hc-app'), 'application root')
    await waitFor(() => document.querySelector('.hc-settings'), 'settings page root')
    await waitFor(() => document.querySelector('.hc-toolbar'), 'settings toolbar')
    const probe = document.createElement('section')
    probe.id = 'bug-20260729-002-typography-probe'
    probe.setAttribute('aria-label', 'BUG-20260729-002 typography fixture')
    probe.innerHTML = probeMarkup
    document.querySelector('.hc-app').append(probe)
    await waitFor(() => document.fonts?.status === 'loaded', 'fonts')
    await new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)))
    await sleep(250)
    const probeNames = ['root', 'toolbar', 'toolbar-title', 'toolbar-meta', 'page-root', 'card', 'card-title', 'body-copy', 'action']
    const probeFacts = Object.fromEntries(probeNames.map((name) => [
      name,
      snapshot(name === 'root' ? '#bug-20260729-002-typography-probe' : '#bug-20260729-002-typography-probe [data-probe-node="' + name + '"]'),
    ]))
    await post({
      stage: 'native-ready',
      environment: {
        viewport: { width: innerWidth, height: innerHeight },
        devicePixelRatio,
        locale: navigator.language,
        theme: document.documentElement.dataset.theme || null,
        k12Skin: document.body.dataset.k12SkinActive || null,
        route: location.pathname,
        isTauri: globalThis.isTauri === true,
        hasTauriInternals: typeof globalThis.__TAURI_INTERNALS__?.invoke === 'function',
      },
      actual: collect({
        documentElement: 'html',
        body: 'body',
        mount: '#app',
        appRoot: '.hc-app',
        pageRoot: '.hc-settings',
        toolbar: '.hc-toolbar',
      }),
      probe: probeFacts,
    })
  }
  void execute().catch(reportError)
})()
`
}

function prepareFrontend(sandbox, fixtureOrigin, probe) {
  const frontend = join(sandbox, 'frontend')
  return {
    frontend,
    async build(offlineEnvironment) {
      const receipt = await runCommand(
        'pnpm',
        ['exec', 'vite', 'build', '--outDir', frontend, '--emptyOutDir'],
        { env: offlineEnvironment, sandbox },
      )
      const currentSourceManifest = directoryManifest(frontend)
      const fixtureName = 'bug-20260729-002-typography-installed-fixture.js'
      writeFileSync(join(frontend, fixtureName), renderInstalledFixture(fixtureOrigin, probe), {
        encoding: 'utf8',
        mode: 0o600,
      })
      const indexPath = join(frontend, 'index.html')
      const index = readFileSync(indexPath, 'utf8')
      assert.match(index, /<head>/)
      const injectedStyles = [
        '<style id="bug-20260729-002-native-fixture-style">',
        '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}',
        probe.css,
        '</style>',
      ].join('\n')
      writeFileSync(
        indexPath,
        index.replace(
          '<head>',
          `<head>\n${injectedStyles}\n<script src="./${fixtureName}"></script>`,
        ),
        { encoding: 'utf8', mode: 0o600 },
      )
      return {
        receipt,
        currentSourceManifest,
        installedBundleManifest: directoryManifest(frontend),
      }
    },
  }
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
  return { base, source, destination, triple, sha256: sha256File(destination) }
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

function writeOverlay(sandbox, frontend, sidecarBase, sidecarPort, fixtureOrigin) {
  const overlayPath = join(sandbox, 'tauri.bug002-typography.conf.json')
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
  writeJSON(overlayPath, {
    productName,
    identifier: bundleIdentifier,
    build: { frontendDist: relative(srcTauriRoot, frontend), beforeBuildCommand: '' },
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
      updater: {
        endpoints: [`${fixtureOrigin}/__bug002__/updater`],
        dangerousInsecureTransportProtocol: true,
      },
    },
  })
  return overlayPath
}

async function waitForHealth(port, appProcess) {
  const deadline = Date.now() + 75_000
  while (Date.now() < deadline) {
    if (appProcess.exitCode !== null) throw new Error('Test.app exited before Sidecar health')
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

async function waitForNativeReport(state, appProcess) {
  const deadline = Date.now() + 75_000
  while (Date.now() < deadline) {
    if (appProcess.exitCode !== null) throw new Error('Test.app exited before WKWebView report')
    const failure = state.reports.find((entry) => entry.stage === 'fixture-error')
    if (failure) throw new Error(`WKWebView fixture failed: ${failure.message}`)
    const report = state.reports.find((entry) => entry.stage === 'native-ready')
    if (report) return report
    await sleep(100)
  }
  throw new Error('timed out waiting for native WKWebView typography report')
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
  const output = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', path], {
    encoding: 'utf8',
  })
  const width = Number(output.match(/pixelWidth:\s*(\d+)/)?.[1])
  const height = Number(output.match(/pixelHeight:\s*(\d+)/)?.[1])
  assert.ok(
    Number.isFinite(width) && Number.isFinite(height),
    `invalid image dimensions: ${output}`,
  )
  return { width, height }
}

function captureWindow(pid, destination) {
  const window = windowInfoForPID(pid)
  execFileSync('/usr/sbin/screencapture', ['-x', '-o', '-l', String(window.id), destination])
  assert.ok(existsSync(destination), `native screenshot is missing: ${destination}`)
  assert.ok(statSync(destination).size > 1024, `native screenshot is empty: ${destination}`)
  return { ...window, pixels: imageDimensions(destination), bytes: statSync(destination).size }
}

function cropInstalledProbe(fullPath, destination, report) {
  const full = imageDimensions(fullPath)
  const expectedFull = {
    width: Math.round(report.environment.viewport.width * report.environment.devicePixelRatio),
    height: Math.round(report.environment.viewport.height * report.environment.devicePixelRatio),
  }
  assert.deepEqual(
    full,
    expectedFull,
    'native no-shadow screenshot must equal the WKWebView pixel viewport',
  )
  const probe = report.probe.root
  assert.ok(probe, 'native probe root facts are missing')
  assert.deepEqual(
    {
      x: probe.rect.x,
      y: probe.rect.y,
      width: probe.rect.width,
      height: probe.rect.height,
    },
    { x: 360, y: 180, width: 720, height: 360 },
    'native probe rect must match the fixed same-state oracle rect',
  )
  const cropOffsetX = Math.round(probe.rect.x * report.environment.devicePixelRatio)
  const cropOffsetY = Math.round(probe.rect.y * report.environment.devicePixelRatio)
  const cropWidth = Math.round(probe.rect.width * report.environment.devicePixelRatio)
  const cropHeight = Math.round(probe.rect.height * report.environment.devicePixelRatio)
  execFileSync(
    'sips',
    [
      '-c',
      String(cropHeight),
      String(cropWidth),
      '--cropOffset',
      String(cropOffsetY),
      String(cropOffsetX),
      fullPath,
      '--out',
      destination,
    ],
    {
      stdio: 'pipe',
    },
  )
  assert.deepEqual(imageDimensions(destination), { width: cropWidth, height: cropHeight })
  return { full, crop: { width: cropWidth, height: cropHeight } }
}

async function captureReference(fixture, probe) {
  const externalRequests = []
  const browser = await webkit.launch()
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    colorScheme: 'light',
    reducedMotion: 'reduce',
  })
  const page = await context.newPage()
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) externalRequests.push(request.url())
  })
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url())
    return ['127.0.0.1', 'localhost'].includes(url.hostname) ? route.continue() : route.abort()
  })
  try {
    await page.goto(`${fixture.origin}/app.html`, { waitUntil: 'domcontentloaded' })
    await page.locator('.app').waitFor({ state: 'visible' })
    await page.evaluate(() => {
      const prototypeWindow = window
      prototypeWindow.applyThemeState?.('light', false)
      prototypeWindow.setK12SkinPreference?.('default', { announce: false })
      document.querySelector('.sb-item[data-screen="settings"]')?.click()
    })
    await page.locator('.screen[data-pane="settings"].on').waitFor({ state: 'visible' })
    await page.addStyleTag({
      content:
        '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}',
    })
    await page.evaluate(({ markup, css }) => {
      const style = document.createElement('style')
      style.id = 'bug-20260729-002-probe-style'
      style.textContent = css
      document.head.append(style)
      const element = document.createElement('section')
      element.id = 'bug-20260729-002-typography-probe'
      element.setAttribute('aria-label', 'BUG-20260729-002 typography fixture')
      element.innerHTML = markup
      document.querySelector('.app')?.append(element)
    }, probe)
    await page.evaluate(
      () =>
        new Promise((resolveFrame) =>
          requestAnimationFrame(() => requestAnimationFrame(resolveFrame)),
        ),
    )
    const referencePath = join(evidenceRoot, 'reference-dpr2.png')
    await page.locator('#bug-20260729-002-typography-probe').screenshot({
      path: referencePath,
      animations: 'disabled',
      scale: 'device',
    })
    const facts = await page.evaluate(() => {
      const snapshot = (selector) => {
        const element = document.querySelector(selector)
        if (!(element instanceof HTMLElement)) return null
        const rect = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        return {
          selector,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          style: {
            display: style.display,
            fontSize: style.fontSize,
            lineHeight: style.lineHeight,
            fontFamily: style.fontFamily,
            fontWeight: style.fontWeight,
            letterSpacing: style.letterSpacing,
            webkitFontSmoothing: style.getPropertyValue('-webkit-font-smoothing'),
          },
        }
      }
      const probeNames = [
        'root',
        'toolbar',
        'toolbar-title',
        'toolbar-meta',
        'page-root',
        'card',
        'card-title',
        'body-copy',
        'action',
      ]
      return {
        environment: {
          viewport: { width: innerWidth, height: innerHeight },
          devicePixelRatio,
          locale: navigator.language,
          theme: document.documentElement.dataset.theme || null,
          k12Skin: document.body.dataset.k12SkinActive || null,
        },
        actual: {
          body: snapshot('body'),
          appRoot: snapshot('.app'),
          pageRoot: snapshot('.screen[data-pane="settings"].on'),
          toolbar: snapshot('.screen[data-pane="settings"].on > .tbar'),
        },
        probe: Object.fromEntries(
          probeNames.map((name) => [
            name,
            snapshot(
              name === 'root'
                ? '#bug-20260729-002-typography-probe'
                : `#bug-20260729-002-typography-probe [data-probe-node="${name}"]`,
            ),
          ]),
        ),
      }
    })
    return { facts, referencePath, externalRequests, dimensions: imageDimensions(referencePath) }
  } finally {
    await context.close()
    await browser.close()
  }
}

async function pixelDiff(reference, implementation, output) {
  const result = spawnSync(
    'uv',
    [
      'run',
      '--offline',
      '--isolated',
      '--python',
      '3.12',
      '--with',
      'pillow==10.4.0',
      'python',
      pixelDiffTool,
      reference,
      implementation,
      output,
      '8',
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  )
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return JSON.parse(result.stdout.trim())
}

function verifyTypography(referenceFacts, nativeReport) {
  const differences = []
  for (const [side, facts, names] of [
    ['reference', referenceFacts, ['body', 'appRoot', 'pageRoot']],
    ['native', nativeReport, ['body', 'mount', 'appRoot', 'pageRoot']],
  ]) {
    for (const name of names) {
      const target = facts.actual[name]
      if (!target) {
        differences.push({ side, target: name, kind: 'missing' })
        continue
      }
      for (const [field, expected] of Object.entries(expectedTypography)) {
        if (target.style[field] !== expected) {
          differences.push({ side, target: name, field, expected, actual: target.style[field] })
        }
      }
    }
  }
  for (const name of Object.keys(referenceFacts.probe)) {
    const reference = referenceFacts.probe[name]
    const implementation = nativeReport.probe[name]
    if (!reference || !implementation) {
      differences.push({ target: `probe.${name}`, kind: 'missing' })
      continue
    }
    for (const field of ['fontSize', 'lineHeight', 'fontFamily', 'fontWeight', 'letterSpacing']) {
      if (reference.style[field] !== implementation.style[field]) {
        differences.push({
          target: `probe.${name}`,
          field,
          reference: reference.style[field],
          native: implementation.style[field],
        })
      }
    }
    for (const field of ['x', 'y', 'width', 'height']) {
      if (Math.abs(reference.rect[field] - implementation.rect[field]) > 0.5) {
        differences.push({
          target: `probe.${name}`,
          field: `rect.${field}`,
          reference: reference.rect[field],
          native: implementation.rect[field],
        })
      }
    }
  }
  return { expected: expectedTypography, pass: differences.length === 0, differences }
}

function classifyIndependentSurfaceStructure(referenceFacts, nativeReport) {
  const differences = []
  for (const name of ['appRoot', 'pageRoot', 'toolbar']) {
    const reference = referenceFacts.actual[name]
    const implementation = nativeReport.actual[name]
    if (!reference || !implementation) continue
    for (const field of ['x', 'y', 'width', 'height']) {
      if (Math.abs(reference.rect[field] - implementation.rect[field]) <= 0.5) continue
      differences.push({
        target: name,
        field: `rect.${field}`,
        reference: reference.rect[field],
        installedWKWebView: implementation.rect[field],
        classification: 'independent-structure-not-BUG-20260729-002',
      })
    }
  }
  return {
    status: differences.length === 0 ? 'MATCH' : 'DRIFT_DISCLOSED',
    reason:
      'The typography probe is exact-state; underlying prototype and implementation business shells are not an exact-set fixture.',
    differences,
    countedAgainstRootTypography: false,
  }
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
    HEXCLAW_TEST_LLM_CONFIG_MODE: 'preseeded-owner-yaml',
    HEXCLAW_DISABLE_BACKGROUND_EGRESS: '1',
    DINGTALK_LIVE_SEND: '0',
    HTTP_PROXY: fixtureOrigin,
    HTTPS_PROXY: fixtureOrigin,
    ALL_PROXY: fixtureOrigin,
    NO_PROXY: '127.0.0.1,localhost,::1',
    http_proxy: fixtureOrigin,
    https_proxy: fixtureOrigin,
    all_proxy: fixtureOrigin,
    no_proxy: '127.0.0.1,localhost,::1',
  }
}

async function main() {
  assert.equal(process.platform, 'darwin', 'BUG002 native typography boundary is macOS-only')
  mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 })
  const sandbox = mkdtempSync(join(tmpdir(), 'hexclaw-bug002-typography.'))
  chmodSync(sandbox, 0o700)
  mkdirSync(join(sandbox, '.hexclaw'), { mode: 0o700 })
  mkdirSync(join(sandbox, 'tmp'), { mode: 0o700 })

  // 复用工作区本地 compiler cache，避免并行验收重复编译第三方 Rust 依赖；只生成并清理
  // 本 Bundle ID 对应的唯一 .app，运行时 HOME/端口/前端与配置仍完全隔离。
  const cargoTarget = join(srcTauriRoot, 'target')
  const appBundle = join(cargoTarget, `release/bundle/macos/${productName}.app`)
  const fixturePort = await reserveLoopbackPort()
  const sidecarPort = await reserveLoopbackPort()
  assert.notEqual(fixturePort, sidecarPort)
  assert.deepEqual(listenerPIDs(fixturePort), [])
  assert.deepEqual(listenerPIDs(sidecarPort), [])
  const fixture = createLoopbackFixture(fixturePort)
  const probe = extractFixtureSource()
  const relevantSourcesBefore = snapshotRelevantSources()
  const buildReceipts = []
  let appProcess = null
  let appLog = null
  let appLogPath = ''
  let appPID = null
  let sidecarPID = null
  let stoppedSidecars = []
  let result = null
  let failure = null
  const startedAt = Date.now()

  try {
    await fixture.listen()
    const reference = await captureReference(fixture, probe)
    assert.deepEqual(reference.externalRequests, [], 'reference page attempted external network')
    assert.deepEqual(reference.facts.environment, {
      viewport,
      devicePixelRatio: deviceScaleFactor,
      locale: 'zh-CN',
      theme: 'light',
      k12Skin: 'default',
    })

    const configPath = join(sandbox, '.hexclaw/hexclaw.yaml')
    writeFileSync(configPath, renderConfig(sandbox, sidecarPort), {
      encoding: 'utf8',
      mode: 0o600,
    })
    chmodSync(configPath, 0o600)
    const sidecar = prepareSidecar(sandbox)
    const offlineEnvironment = {
      ...process.env,
      CARGO_NET_OFFLINE: 'true',
      CARGO_TARGET_DIR: cargoTarget,
      PNPM_CONFIG_OFFLINE: 'true',
      npm_config_offline: 'true',
    }
    const frontendBuilder = prepareFrontend(sandbox, fixture.origin, probe)
    const frontendBuild = await frontendBuilder.build(offlineEnvironment)
    buildReceipts.push(frontendBuild.receipt)
    const overlayPath = writeOverlay(
      sandbox,
      frontendBuilder.frontend,
      sidecar.base,
      sidecarPort,
      fixture.origin,
    )
    buildReceipts.push(
      await runCommand(
        'pnpm',
        ['exec', 'tauri', 'build', '--config', overlayPath, '--bundles', 'app'],
        { env: offlineEnvironment, sandbox },
      ),
    )

    const infoPlist = join(appBundle, 'Contents/Info.plist')
    const executable = join(appBundle, 'Contents/MacOS/hexclaw-desktop')
    const bundledSidecar = join(appBundle, 'Contents/MacOS/hexclaw')
    assert.ok(existsSync(infoPlist), 'unique Test.app Info.plist is missing')
    assert.ok(existsSync(executable), 'unique Test.app executable is missing')
    assert.ok(existsSync(bundledSidecar), 'unique Test.app Sidecar is missing')
    assert.equal(sha256File(bundledSidecar), sidecar.sha256)
    const identifier = execFileSync(
      'plutil',
      ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', infoPlist],
      { encoding: 'utf8' },
    ).trim()
    assert.equal(identifier, bundleIdentifier)
    assert.deepEqual(
      snapshotRelevantSources(),
      relevantSourcesBefore,
      'relevant sources changed during build',
    )

    appLogPath = join(sandbox, 'app.log')
    appLog = createWriteStream(appLogPath, { flags: 'wx', mode: 0o600 })
    appProcess = spawn(executable, ['-AppleLanguages', '(zh-Hans)', '-AppleLocale', 'zh_CN'], {
      cwd: sandbox,
      env: appEnvironment(sandbox, sidecarPort, fixture.origin),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    appPID = appProcess.pid
    appProcess.stdout.pipe(appLog, { end: false })
    appProcess.stderr.pipe(appLog, { end: false })
    await waitForHealth(sidecarPort, appProcess)
    const sidecarPIDs = listenerPIDs(sidecarPort)
    assert.equal(sidecarPIDs.length, 1, 'Test.app must own one Sidecar listener')
    sidecarPID = sidecarPIDs[0]
    const nativeReport = await waitForNativeReport(fixture.state, appProcess)
    assert.deepEqual(nativeReport.environment, {
      viewport,
      devicePixelRatio: deviceScaleFactor,
      locale: 'zh-CN',
      theme: 'light',
      k12Skin: 'default',
      route: '/settings',
      isTauri: true,
      hasTauriInternals: true,
    })

    const fullInstalledPath = join(evidenceRoot, 'full-installed-window.png')
    const implementationPath = join(evidenceRoot, 'implementation-dpr2.png')
    const pixelDiffPath = join(evidenceRoot, 'pixel-diff-dpr2.png')
    const nativeWindow = captureWindow(appPID, fullInstalledPath)
    const crop = cropInstalledProbe(fullInstalledPath, implementationPath, nativeReport)
    assert.deepEqual(reference.dimensions, crop.crop)
    const pixels = await pixelDiff(reference.referencePath, implementationPath, pixelDiffPath)
    const typography = verifyTypography(reference.facts, nativeReport)
    const independentSurfaceStructure = classifyIndependentSurfaceStructure(
      reference.facts,
      nativeReport,
    )
    writeJSON(join(evidenceRoot, 'bbox-computed-style.json'), {
      reference: reference.facts,
      installedWKWebView: nativeReport,
    })
    assert.deepEqual(typography.differences, [])
    assert.ok(
      pixels.changed_pixel_ratio <= maximumPixelDifference,
      `installed probe pixel difference ${pixels.changed_pixel_ratio} exceeds ${maximumPixelDifference}`,
    )
    assert.deepEqual(fixture.state.blockedExternalRequests, [])
    assert.deepEqual(fixture.state.unexpectedRequests, [])

    const provenance = {
      desktopHead: git(['rev-parse', 'HEAD']),
      desktopStatusSha256: sha256Buffer(git(['status', '--porcelain=v1', '--untracked-files=all'])),
      relevantSources: relevantSourcesBefore,
      relevantSourcesManifestSha256: sha256Buffer(JSON.stringify(relevantSourcesBefore)),
      globalCssSha256: sha256File(join(repoRoot, 'src/assets/styles/global.css')),
      prototypeHead: spawnSync('git', ['rev-parse', 'HEAD'], {
        cwd: docsRoot,
        encoding: 'utf8',
      }).stdout.trim(),
      prototypeSha256: sha256File(join(prototypeRoot, 'app.html')),
      probeOracleSourceSha256: sha256File(browserVisualSpec),
      probeMarkupSha256: sha256Buffer(probe.markup),
      probeCssSha256: sha256Buffer(probe.css),
      currentSourceFrontendManifest: frontendBuild.currentSourceManifest,
      currentSourceFrontendManifestSha256: sha256Buffer(
        JSON.stringify(frontendBuild.currentSourceManifest),
      ),
      installedBundleFrontendManifest: frontendBuild.installedBundleManifest,
      installedBundleFrontendManifestSha256: sha256Buffer(
        JSON.stringify(frontendBuild.installedBundleManifest),
      ),
      appExecutableSha256: sha256File(executable),
      supportSidecarSha256: sha256File(bundledSidecar),
      supportSidecarRole: 'startup/health support only; typography verdict is renderer-local',
      cargoTargetMode: 'shared local compiler cache; unique Test.app bundle is removed after run',
      bundleIdentifier: identifier,
      productName,
      buildCommands: buildReceipts.map(({ command, args, durationMs }) => ({
        command,
        args,
        durationMs,
      })),
    }
    writeJSON(join(evidenceRoot, 'build-provenance.json'), provenance)
    result = {
      schemaVersion: 1,
      status: 'PASS',
      bugId: 'BUG-20260729-002',
      boundary:
        'current-worktree temporary Test.app / real macOS WKWebView / native window capture',
      durationMs: Date.now() - startedAt,
      equivalence: {
        viewport,
        deviceScaleFactor,
        locale: 'zh-CN',
        timezone: 'Asia/Shanghai',
        theme: 'light',
        k12Skin: 'default',
        content: 'shared inherited typography probe extracted from browser oracle',
        state: 'settings main shell',
      },
      typography,
      independentSurfaceStructure,
      pixels: {
        ...pixels,
        maximumChangedPixelRatio: maximumPixelDifference,
        pass: pixels.changed_pixel_ratio <= maximumPixelDifference,
      },
      installed: {
        realWKWebView: true,
        nativeDOMReport: true,
        nativeWindowCapture: true,
        appPID,
        sidecarPID,
        nativeWindow,
      },
      isolation: {
        testHomeMode: '0700',
        configMode: '0600',
        fixtureBinding: '127.0.0.1',
        fixturePort,
        sidecarPort,
        applicationsDirectoryTouched: false,
        applicationRuntimeUserHomeReadOrWritten: false,
        externalNetworkAttempts: fixture.state.blockedExternalRequests,
        realModelInvocations: 0,
        realIMInvocations: 0,
      },
      files: {
        reference: 'reference-dpr2.png',
        implementation: 'implementation-dpr2.png',
        pixelDiff: 'pixel-diff-dpr2.png',
        fullInstalledWindow: 'full-installed-window.png',
        bboxComputedStyle: 'bbox-computed-style.json',
        buildProvenance: 'build-provenance.json',
        appLog: 'app.log',
        cleanup: 'cleanup.json',
      },
      fixtureReceipts: fixture.state,
    }
  } catch (error) {
    failure = error
  } finally {
    await stopProcess(appProcess).catch((error) => {
      if (!failure) failure = error
    })
    if (appLog) await new Promise((resolveEnd) => appLog.end(resolveEnd))
    try {
      stoppedSidecars = await stopOwnedSidecar(sidecarPort, appBundle)
    } catch (error) {
      if (!failure) failure = error
    }
    await fixture.close().catch((error) => {
      if (!failure) failure = error
    })
    if (appLogPath && existsSync(appLogPath)) {
      writeFileSync(
        join(evidenceRoot, 'app.log'),
        sanitize(readFileSync(appLogPath, 'utf8'), sandbox),
        { encoding: 'utf8', mode: 0o600 },
      )
    }
    writeFileSync(
      join(evidenceRoot, 'build.log'),
      sanitize(buildReceipts.map((receipt) => receipt.output).join('\n'), sandbox),
      { encoding: 'utf8', mode: 0o600 },
    )
    rmSync(appBundle, { recursive: true, force: true })
    const appBundleRemoved = !existsSync(appBundle)
    rmSync(sandbox, { recursive: true, force: true })
    const cleanup = {
      status: failure ? 'FAIL' : 'PASS',
      appPID,
      appProcessStopped:
        !appProcess || appProcess.exitCode !== null || appProcess.signalCode !== null,
      sidecarPID,
      stoppedSidecars,
      sidecarPortReleased: listenerPIDs(sidecarPort).length === 0,
      fixturePortReleased: listenerPIDs(fixturePort).length === 0,
      uniqueTestAppRemoved: appBundleRemoved,
      sandboxRemoved: !existsSync(sandbox),
      applicationsDirectoryTouched: false,
      applicationRuntimeUserHomeReadOrWritten: false,
    }
    writeJSON(join(evidenceRoot, 'cleanup.json'), cleanup)
    if (failure) {
      writeJSON(join(evidenceRoot, 'summary.json'), {
        status: 'FAIL',
        bugId: 'BUG-20260729-002',
        error: sanitize(
          failure instanceof Error ? failure.stack || failure.message : failure,
          sandbox,
        ),
        isolation: {
          fixturePort,
          sidecarPort,
          applicationsDirectoryTouched: false,
          applicationRuntimeUserHomeReadOrWritten: false,
        },
        fixtureReceipts: fixture.state,
        cleanup,
      })
    } else {
      result.cleanup = cleanup
      result.evidence = directoryManifest(evidenceRoot).filter(
        (entry) => entry.file !== 'summary.json',
      )
      writeJSON(join(evidenceRoot, 'summary.json'), result)
    }
  }

  if (failure) throw failure
  process.stdout.write(
    `\nBUG-20260729-002 installed WKWebView typography PASS: ${relative(repoRoot, evidenceRoot)}\n`,
  )
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`)
  process.exitCode = 1
})
