#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.HEXCLAW_NATIVE_LIBRARY = '1'
const {
  createSourceSnapshot,
  captureWindow,
  currentSourceManifest,
  listenerPIDs,
  renderConfig,
  reserveLoopbackPort,
  runCommand,
  sha256File,
  stopProcess,
  treeManifest,
  waitForHealth,
} = await import('./bug-20260728-007-current-worktree-wkwebview.mjs')

const nativeDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(nativeDirectory, '../..')
const tauriRoot = join(repositoryRoot, 'src-tauri')
const evidenceRoot = resolve(repositoryRoot, '../hexclaw-docs/test/evidence/bug-20260725-008-delayed-ready-20260822')
const productName = 'HexClaw Delayed Ready Test'
const bundleIdentifier = 'com.hexclaw.desktop.bug-20260725-008'
const sidecarDelayMilliseconds = 7000
const sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds))

function createReportServer(port) {
  const state = { reports: [] }
  const server = createServer(async (request, response) => {
    const url = new URL(request.url || '/', `http://127.0.0.1:${port}`)
    if (request.method === 'OPTIONS') {
      response.writeHead(204, { 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST,OPTIONS', 'Access-Control-Allow-Origin': '*' })
      response.end()
      return
    }
    if (request.method === 'POST' && url.pathname === '/__bug_20260725_008__/report') {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      state.reports.push(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      response.writeHead(204, { 'Access-Control-Allow-Origin': '*' })
      response.end()
      return
    }
    if (request.method === 'GET' && url.pathname === '/updater') {
      response.writeHead(204, { 'Access-Control-Allow-Origin': '*' })
      response.end()
      return
    }
    response.writeHead(404, { 'Access-Control-Allow-Origin': '*' })
    response.end()
  })
  return {
    state,
    origin: `http://127.0.0.1:${port}`,
    listen: () => new Promise((resolveListen, rejectListen) => { server.once('error', rejectListen); server.listen(port, '127.0.0.1', resolveListen) }),
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  }
}

async function waitForReport(state, predicate, label, timeoutMilliseconds = 30000) {
  const deadline = Date.now() + timeoutMilliseconds
  while (Date.now() < deadline) {
    const fixtureError = state.reports.find((report) => report.stage === 'fixture-error')
    if (fixtureError) throw new Error(`WebView fixture error: ${fixtureError.message}`)
    const report = state.reports.find(predicate)
    if (report) return report
    await sleep(100)
  }
  throw new Error(`timed out waiting for ${label}; reports=${JSON.stringify(state.reports)}`)
}

function injectObserver(frontend, fixtureOrigin, sidecarPort) {
  const indexPath = join(frontend, 'index.html')
  const index = readFileSync(indexPath, 'utf8')
  const observerName = 'bug-20260725-008-delayed-ready-observer.js'
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
    .replaceAll('http://localhost:16060', `http://127.0.0.1:${sidecarPort}`)
  writeFileSync(modulePath, moduleSource, { mode: 0o600 })
  const observer = `;(function observeDelayedReady() {
  'use strict'
  const nativeFetch = globalThis.fetch.bind(globalThis)
  const reportOrigin = ${JSON.stringify(fixtureOrigin)}
  const post = async (payload) => {
    const response = await nativeFetch(reportOrigin + '/__bug_20260725_008__/report', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    })
    if (!response.ok) throw new Error('report failed: ' + response.status)
  }
  const reportError = (error) => {
    const message = error instanceof Error ? [error.name + ': ' + error.message, error.stack].filter(Boolean).join('\\n') : String(error)
    void post({ stage: 'fixture-error', message }).catch(() => {})
  }
  addEventListener('error', (event) => reportError(event.error || event.message))
  addEventListener('unhandledrejection', (event) => reportError(event.reason))
  sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
  localStorage.setItem('hexclaw:welcomeRedirectDone', '1')
  try { history.replaceState({}, '', '/chat') } catch {}
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href)
    if (url.pathname === '/api/v1/config') {
      return new Response(JSON.stringify({
        general: { language: 'zh-CN', welcomeCompleted: true },
        knowledge: { enabled: false },
        llm: { default: '', providers: [], routing: { enabled: false }, cache: { enabled: false } },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.pathname === '/api/v1/config/llm') {
      return new Response(JSON.stringify({ default: '', providers: [], routing: { enabled: false }, cache: { enabled: false } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }
    const isConnections = url.hostname === '127.0.0.1' && url.port === ${JSON.stringify(String(sidecarPort))} && url.pathname === '/api/v1/connections'
    const startedAt = Date.now()
    try {
      const response = await nativeFetch(input, init)
      if (isConnections) {
        void post({ stage: 'connections-response', startedAt, completedAt: Date.now(), status: response.status }).catch(reportError)
        setTimeout(() => {
          void post({
            stage: 'connections-ui-after-recovery',
            empty: Boolean(document.querySelector('[data-testid="chat-connections-empty"]')),
            error: Boolean(document.querySelector('[data-testid="chat-connections-error"]')),
          }).catch(reportError)
        }, 300)
      }
      return response
    } catch (error) {
      if (isConnections) void post({ stage: 'connections-error', startedAt, completedAt: Date.now(), message: String(error) }).catch(reportError)
      throw error
    }
  }
  void post({ stage: 'bootstrap', isTauri: globalThis.isTauri === true, hasTauriInternals: true }).catch(reportError)
  const reportConnectionDOM = (stage) => {
    void post({
      stage,
      observedAt: Date.now(),
      chat: Boolean(document.querySelector('.hc-chat__main')),
      empty: Boolean(document.querySelector('[data-testid="chat-connections-empty"]')),
      error: Boolean(document.querySelector('[data-testid="chat-connections-error"]')),
    }).catch(reportError)
  }
  setTimeout(() => {
    void post({
      stage: 'dom-probe',
      path: location.pathname,
      chat: Boolean(document.querySelector('.hc-chat__main')),
      welcome: Boolean(document.querySelector('[data-testid="welcome-view"], .welcome-view')),
      splash: Boolean(document.querySelector('#splash-screen')),
      bodyText: document.body.innerText.slice(0, 240),
    }).catch(reportError)
  }, 1500)
  const connectionDOMTimer = setInterval(() => reportConnectionDOM('connection-dom'), 500)
  addEventListener('beforeunload', () => clearInterval(connectionDOMTimer), { once: true })
})()
`
  writeFileSync(join(frontend, observerName), observer, { mode: 0o600 })
  writeFileSync(indexPath, index.replace('<head>', `<head>\n<script src="./${observerName}"></script>`), { mode: 0o600 })
}

function writeOverlay(sandbox, frontend, sidecarPort, fixtureOrigin, snapshotTauriRoot) {
  const overlayPath = join(sandbox, 'tauri.bug-20260725-008.conf.json')
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    `connect-src 'self' http://127.0.0.1:${sidecarPort} ws://127.0.0.1:${sidecarPort} ${fixtureOrigin}`,
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ')
  writeFileSync(overlayPath, `${JSON.stringify({
    productName,
    identifier: bundleIdentifier,
    build: { frontendDist: relative(snapshotTauriRoot, frontend), beforeBuildCommand: '' },
    app: { windows: [{ label: 'main', title: productName, width: 1100, height: 760, visible: true }], security: { csp } },
    bundle: { targets: ['app'], createUpdaterArtifacts: false },
    plugins: { updater: { endpoints: [`${fixtureOrigin}/updater`], dangerousInsecureTransportProtocol: true } },
  }, null, 2)}\n`, { mode: 0o600 })
  return overlayPath
}

async function main() {
  assert.equal(process.platform, 'darwin', 'native delayed-ready gate is macOS-only')
  const sandbox = mkdtempSync(join(tmpdir(), 'hexclaw-delayed-ready-'))
  const frontend = join(sandbox, 'frontend')
  const home = join(sandbox, '.hexclaw')
  const temporary = join(sandbox, 'tmp')
  const fixturePort = await reserveLoopbackPort()
  const sidecarPort = await reserveLoopbackPort()
  const fixture = createReportServer(fixturePort)
  const appBundle = join(tauriRoot, 'target', 'release', 'bundle', 'macos', `${productName}.app`)
  let appProcess = null
  let appLog = null
  let resultSummary = null
  let screenshot = null

  try {
    mkdirSync(home, { recursive: true, mode: 0o700 })
    mkdirSync(temporary, { recursive: true, mode: 0o700 })
    mkdirSync(evidenceRoot, { recursive: true })
    chmodSync(sandbox, 0o700)
    await fixture.listen()
    const configPath = join(home, 'hexclaw.yaml')
    writeFileSync(configPath, renderConfig(sandbox, sidecarPort, fixture.origin), { mode: 0o600 })
    chmodSync(configPath, 0o600)

    const sourceManifest = currentSourceManifest()
    const snapshot = createSourceSnapshot(sandbox, sourceManifest)
    const environment = {
      ...process.env,
      CARGO_NET_OFFLINE: 'true', CARGO_TARGET_DIR: join(tauriRoot, 'target'),
      GOENV: 'off', GOPROXY: 'off', GOSUMDB: 'off',
      PNPM_CONFIG_OFFLINE: 'true', npm_config_offline: 'true',
      HEXCLAW_PACKAGE_LOCAL_DIST_DIR: frontend, HEXCLAW_TEST_ALLOW_AUTO_LOCAL_OLLAMA: '0',
      GOROOT: '/opt/homebrew/opt/go/libexec',
    }
    await runCommand('pnpm', ['build-only:package-local'], { cwd: snapshot.root, env: environment })
    injectObserver(frontend, fixture.origin, sidecarPort)
    const overlay = writeOverlay(sandbox, frontend, sidecarPort, fixture.origin, join(snapshot.root, 'src-tauri'))
    await runCommand('pnpm', ['exec', 'tauri', 'build', '--config', overlay, '--bundles', 'app'], { cwd: snapshot.root, env: environment })

    const desktopExecutable = join(appBundle, 'Contents', 'MacOS', 'hexclaw-desktop')
    const sidecarExecutable = join(appBundle, 'Contents', 'MacOS', 'hexclaw')
    assert.ok(existsSync(desktopExecutable), `missing desktop executable: ${desktopExecutable}`)
    assert.ok(existsSync(sidecarExecutable), `missing sidecar executable: ${sidecarExecutable}`)
    renameSync(sidecarExecutable, `${sidecarExecutable}.real`)
    writeFileSync(sidecarExecutable, `#!/bin/sh\nsleep ${sidecarDelayMilliseconds / 1000}\nexec "$(dirname \"$0\")/hexclaw.real" "$@"\n`, { mode: 0o700 })
    chmodSync(sidecarExecutable, 0o700)

    appLog = createWriteStream(join(sandbox, 'app.log'), { flags: 'wx', mode: 0o600 })
    appProcess = spawn(desktopExecutable, [], {
      cwd: sandbox,
      env: {
        ...environment,
        HOME: sandbox, USERPROFILE: sandbox, CFFIXED_USER_HOME: sandbox,
        TMPDIR: temporary, TEMP: temporary, TMP: temporary,
        HEXCLAW_TEST_MODE: '1', HEXCLAW_TEST_HOME: sandbox,
        HEXCLAW_SIDECAR_PORT: String(sidecarPort), HEXCLAW_TEST_LLM_CONFIG_MODE: 'preseeded-owner-yaml',
        HEXCLAW_DISABLE_BACKGROUND_EGRESS: '1', NO_PROXY: '*', no_proxy: '*',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    appProcess.stdout.pipe(appLog, { end: false })
    appProcess.stderr.pipe(appLog, { end: false })

    const bootstrap = await waitForReport(fixture.state, (report) => report.stage === 'bootstrap', 'WebView bootstrap', 20000)
    assert.equal(bootstrap.isTauri, true)
    assert.deepEqual(listenerPIDs(sidecarPort), [], 'sidecar started before the WebView observer')
    const dom = await waitForReport(fixture.state, (report) => report.stage === 'dom-probe', 'ChatView route probe')
    assert.equal(dom.chat, true, `ChatView did not mount: ${JSON.stringify(dom)}`)
    const firstFailure = await waitForReport(
      fixture.state,
      (report) => report.stage === 'connection-dom' && report.chat === true && report.error === true,
      'initial connection-directory error projection',
    )
    await waitForHealth(sidecarPort, appProcess)
    const recovered = await waitForReport(
      fixture.state,
      (report) => report.stage === 'connection-dom' && report.observedAt > firstFailure.observedAt && report.empty === true && report.error === false,
      'sidecar-ready connection-directory recovery projection',
    )
    assert.ok(recovered.observedAt - firstFailure.observedAt >= sidecarDelayMilliseconds - 1200, 'recovery occurred before delayed native ready')

    screenshot = captureWindow(appProcess.pid, join(evidenceRoot, 'recovered-chat-connections.png'))
    resultSummary = {
      bug: 'BUG-20260725-008', result: 'PASS', sourceDigest: sourceManifest.digest,
      app: { bundleIdentifier, desktopSHA256: sha256File(desktopExecutable), sidecarSHA256: sha256File(`${sidecarExecutable}.real`), injectedFrontendSHA256: treeManifest(frontend).digest },
      timing: { sidecarDelayMilliseconds, firstFailureAt: firstFailure.observedAt, recoveredAt: recovered.observedAt },
      webView: { bootstrap, firstFailure, recovered },
      isolation: { applicationsDirectoryTouched: false, realHomeRead: false, externalNetwork: false, sidecarPort, fixturePort },
      screenshot: { file: 'recovered-chat-connections.png', ...screenshot },
    }
    writeFileSync(join(evidenceRoot, 'pass-summary.json'), `${JSON.stringify(resultSummary, null, 2)}\n`, { mode: 0o600 })
    process.stdout.write(`${JSON.stringify(resultSummary)}\n`)
  } finally {
    await stopProcess(appProcess)
    if (appLog) await new Promise((resolveEnd) => appLog.end(resolveEnd))
    for (const pid of listenerPIDs(sidecarPort)) {
      const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim()
      assert.ok(command.includes(`${appBundle}/Contents/MacOS/hexclaw`), `unexpected sidecar owner: ${command}`)
      process.kill(pid, 'SIGTERM')
    }
    const cleanupDeadline = Date.now() + 10000
    while (listenerPIDs(sidecarPort).length && Date.now() < cleanupDeadline) await sleep(100)
    assert.deepEqual(listenerPIDs(sidecarPort), [], 'delayed Test.app sidecar remains after cleanup')
    await fixture.close()
    rmSync(appBundle, { recursive: true, force: true })
    rmSync(sandbox, { recursive: true, force: true })
    writeFileSync(join(evidenceRoot, 'cleanup.json'), `${JSON.stringify({
      status: resultSummary?.result ?? 'NOT_PASS',
      appProcessStopped: !appProcess || appProcess.exitCode !== null || appProcess.signalCode !== null,
      sidecarPortReleased: listenerPIDs(sidecarPort).length === 0,
      fixturePortReleased: listenerPIDs(fixturePort).length === 0,
      uniqueAppBundleRemoved: !existsSync(appBundle),
      sandboxRemoved: !existsSync(sandbox),
      screenshot: screenshot ? 'recovered-chat-connections.png' : null,
    }, null, 2)}\n`, { mode: 0o600 })
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`)
  process.exitCode = 1
})
