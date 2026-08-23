#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
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
const evidenceRoot = resolve(
  repositoryRoot,
  '../hexclaw-docs/test/evidence/bug-20260725-008-delayed-ready-20260822',
)
const productName = 'HexClaw Delayed Ready Test'
const bundleIdentifier = 'com.hexclaw.desktop.bug-20260725-008'
const sidecarDelayMilliseconds = 7000
const restartProofConnectionName = 'restart-proof-conn'
const sleep = (milliseconds) =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds))

function createReportServer(port) {
  const state = { reports: [], restartRequested: false }
  const server = createServer(async (request, response) => {
    const url = new URL(request.url || '/', `http://127.0.0.1:${port}`)
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST,OPTIONS',
        'Access-Control-Allow-Origin': '*',
      })
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
    if (request.method === 'GET' && url.pathname === '/__bug_20260725_008__/command') {
      response.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json',
      })
      response.end(JSON.stringify({ restartRequested: state.restartRequested }))
      return
    }
    response.writeHead(404, { 'Access-Control-Allow-Origin': '*' })
    response.end()
  })
  return {
    state,
    origin: `http://127.0.0.1:${port}`,
    listen: () =>
      new Promise((resolveListen, rejectListen) => {
        server.once('error', rejectListen)
        server.listen(port, '127.0.0.1', resolveListen)
      }),
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

async function probeConnectionsHTTP(port, capabilityFile) {
  const startedAt = Date.now()
  const capability = readFileSync(capabilityFile, 'utf8').trim()
  assert.ok(capability, 'test Sidecar capability token was not captured')
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/connections`, {
    headers: { Authorization: `Bearer ${capability}` },
    signal: AbortSignal.timeout(5000),
  })
  const rawBody = await response.text()
  let payload = null
  try {
    payload = JSON.parse(rawBody)
  } catch {
    // 保留原始 HTTP 证据，让断言给出状态码和响应体，而不是伪造成功形状。
  }
  return {
    stage: 'connections-response',
    requestOrdinal: 0,
    startedAt,
    completedAt: Date.now(),
    status: response.status,
    transport: 'host-fetch',
    responseShape: {
      hasConnections: Array.isArray(payload?.connections),
      total: payload?.total ?? null,
      names: Array.isArray(payload?.connections)
        ? payload.connections.map((connection) => connection?.name).filter(Boolean)
        : [],
    },
    rawBody: rawBody.slice(0, 2000),
  }
}

function injectObserver(frontend, fixtureOrigin, sidecarPort) {
  const indexPath = join(frontend, 'index.html')
  const index = readFileSync(indexPath, 'utf8')
  const observerName = 'bug-20260725-008-delayed-ready-observer.js'
  const moduleEntry = index.match(
    /<script type="module" crossorigin src="\.\/assets\/([^"]+\.js)">/,
  )
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
  const restartProofConnectionName = ${JSON.stringify(restartProofConnectionName)}
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
  let connectionRequestOrdinal = 0
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
    const requestOrdinal = isConnections ? ++connectionRequestOrdinal : 0
    const startedAt = Date.now()
    try {
      const response = await nativeFetch(input, init)
      if (isConnections) {
        void post({ stage: 'connections-response', requestOrdinal, startedAt, completedAt: Date.now(), status: response.status }).catch(reportError)
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
      if (isConnections) void post({ stage: 'connections-error', requestOrdinal, startedAt, completedAt: Date.now(), message: String(error) }).catch(reportError)
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
  let restartClicked = false
  let restartClickedAt = 0
  let restartProofOpened = false
  let restartProofReported = false
  let nativeConnectionsProbeStarted = false
  const probeNativeConnections = async () => {
    const startedAt = Date.now()
    const internals = globalThis.__TAURI_INTERNALS__
    const invoke = internals?.invoke
    if (typeof invoke !== 'function') {
      await post({ stage: 'native-connections-error', startedAt, completedAt: Date.now(), message: 'Tauri invoke is unavailable' })
      return
    }
    try {
      const result = await invoke.call(internals, 'proxy_api_request', {
        method: 'GET', path: '/api/v1/connections', body: null,
      })
      const payload = JSON.parse(String(result))
      await post({
        stage: 'native-connections-response',
        startedAt,
        completedAt: Date.now(),
        status: 200,
        responseShape: {
          hasConnections: Array.isArray(payload?.connections),
          total: payload?.total ?? null,
          names: Array.isArray(payload?.connections)
            ? payload.connections.map((connection) => connection?.name).filter(Boolean)
            : [],
        },
      })
    } catch (error) {
      await post({ stage: 'native-connections-error', startedAt, completedAt: Date.now(), message: String(error) })
    }
  }
  const restartCommandTimer = setInterval(async () => {
    try {
      if (!restartClicked) {
        const response = await nativeFetch(reportOrigin + '/__bug_20260725_008__/command')
        const command = await response.json()
        if (!command.restartRequested) return
        const restart = document.querySelector('.hc-sidebar__restart-btn')
        if (!(restart instanceof HTMLButtonElement) || restart.disabled) return
        restartClicked = true
        restartClickedAt = Date.now()
        await post({ stage: 'sidecar-restart-clicked', observedAt: restartClickedAt })
        restart.click()
        return
      }
      if (!restartProofOpened && Date.now() - restartClickedAt >= ${sidecarDelayMilliseconds + 2000}) {
        const editor = document.querySelector('[data-testid="chat-input"]')
        if (!(editor instanceof HTMLElement)) return
        editor.focus()
        editor.textContent = '@' + restartProofConnectionName
        const textNode = editor.firstChild
        const selection = globalThis.getSelection?.()
        if (textNode && selection) {
          const range = document.createRange()
          range.setStart(textNode, textNode.textContent?.length ?? 0)
          range.collapse(true)
          selection.removeAllRanges()
          selection.addRange(range)
        }
        editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '@' + restartProofConnectionName }))
        restartProofOpened = true
        void post({
          stage: 'restart-input-probe',
          observedAt: Date.now(),
          text: editor.textContent,
          canonical: editor.getAttribute('data-canonical-source'),
          contentEditable: editor.getAttribute('contenteditable'),
          active: document.activeElement === editor,
          mentionVisible: Boolean(document.querySelector('.hc-mention')),
          mentionNames: [...document.querySelectorAll('.hc-mention__name')].map((node) => node.textContent?.trim()).filter(Boolean),
        }).catch(reportError)
      }
      if (!nativeConnectionsProbeStarted && Date.now() - restartClickedAt >= ${sidecarDelayMilliseconds + 2000}) {
        nativeConnectionsProbeStarted = true
        void probeNativeConnections()
      }
      if (restartProofOpened && !restartProofReported) {
        const match = [...document.querySelectorAll('.hc-mention__name')]
          .find((node) => node.textContent?.trim() === restartProofConnectionName)
        if (!match) return
        restartProofReported = true
        await post({
          stage: 'restart-connection-visible',
          observedAt: Date.now(),
          name: match.textContent?.trim(),
          empty: Boolean(document.querySelector('[data-testid="chat-connections-empty"]')),
          error: Boolean(document.querySelector('[data-testid="chat-connections-error"]')),
        })
      }
    } catch (error) {
      reportError(error)
    }
  }, 250)
  addEventListener('beforeunload', () => {
    clearInterval(connectionDOMTimer)
    clearInterval(restartCommandTimer)
  }, { once: true })
})()
`
  writeFileSync(join(frontend, observerName), observer, { mode: 0o600 })
  writeFileSync(
    indexPath,
    index.replace('<head>', `<head>\n<script src="./${observerName}"></script>`),
    { mode: 0o600 },
  )
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
  writeFileSync(
    overlayPath,
    `${JSON.stringify(
      {
        productName,
        identifier: bundleIdentifier,
        build: { frontendDist: relative(snapshotTauriRoot, frontend), beforeBuildCommand: '' },
        app: {
          windows: [{ label: 'main', title: productName, width: 1100, height: 760, visible: true }],
          security: { csp },
        },
        bundle: { targets: ['app'], createUpdaterArtifacts: false },
        plugins: {
          updater: {
            endpoints: [`${fixtureOrigin}/updater`],
            dangerousInsecureTransportProtocol: true,
          },
        },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  )
  return overlayPath
}

async function main() {
  assert.equal(process.platform, 'darwin', 'native delayed-ready gate is macOS-only')
  const sandbox = mkdtempSync(join(tmpdir(), 'hexclaw-delayed-ready-'))
  const frontend = join(sandbox, 'frontend')
  const home = join(sandbox, '.hexclaw')
  const temporary = join(sandbox, 'tmp')
  const capabilityFile = join(sandbox, 'sidecar-capability-token')
  const reuseBuiltBinary = process.env.HEXCLAW_DELAYED_READY_REUSE_BUILD === '1'
  // 复用刚构建的原生二进制时，内嵌观察器/CSP 已冻结本次构建的环回端口。
  const fixturePort = reuseBuiltBinary ? 51104 : await reserveLoopbackPort()
  const sidecarPort = reuseBuiltBinary ? 51105 : await reserveLoopbackPort()
  const fixture = createReportServer(fixturePort)
  const appBundle = join(tauriRoot, 'target', 'release', 'bundle', 'macos', `${productName}.app`)
  let runtimeRoot = join(appBundle, 'Contents', 'MacOS')
  let appProcess = null
  let appLog = null
  let resultSummary = null
  let screenshot = null
  let screenshotError = ''

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
    const environment = {
      ...process.env,
      CARGO_NET_OFFLINE: 'true',
      CARGO_TARGET_DIR: join(tauriRoot, 'target'),
      GOENV: 'off',
      GOPROXY: 'off',
      GOSUMDB: 'off',
      PNPM_CONFIG_OFFLINE: 'true',
      npm_config_offline: 'true',
      HEXCLAW_PACKAGE_LOCAL_DIST_DIR: frontend,
      HEXCLAW_TEST_ALLOW_AUTO_LOCAL_OLLAMA: '0',
      GOROOT: '/opt/homebrew/opt/go/libexec',
    }
    if (reuseBuiltBinary) {
      const reusableBundle = join(tauriRoot, 'target', 'release', 'bundle', 'macos', 'HexClaw.app')
      const runtimeBundle = join(sandbox, `${productName}.app`)
      assert.ok(existsSync(reusableBundle), `missing reusable app container: ${reusableBundle}`)
      cpSync(reusableBundle, runtimeBundle, { recursive: true, preserveTimestamps: true })
      runtimeRoot = join(runtimeBundle, 'Contents', 'MacOS')
      copyFileSync(
        join(tauriRoot, 'target', 'release', 'hexclaw-desktop'),
        join(runtimeRoot, 'hexclaw-desktop'),
      )
      copyFileSync(join(tauriRoot, 'target', 'release', 'hexclaw'), join(runtimeRoot, 'hexclaw'))
    } else {
      const snapshot = createSourceSnapshot(sandbox, sourceManifest)
      await runCommand('pnpm', ['build-only:package-local'], {
        cwd: snapshot.root,
        env: environment,
      })
      injectObserver(frontend, fixture.origin, sidecarPort)
      const overlay = writeOverlay(
        sandbox,
        frontend,
        sidecarPort,
        fixture.origin,
        join(snapshot.root, 'src-tauri'),
      )
      await runCommand(
        'pnpm',
        ['exec', 'tauri', 'build', '--config', overlay, '--bundles', 'app'],
        { cwd: snapshot.root, env: environment },
      )
    }

    const desktopExecutable = join(runtimeRoot, 'hexclaw-desktop')
    const sidecarExecutable = join(runtimeRoot, 'hexclaw')
    assert.ok(existsSync(desktopExecutable), `missing desktop executable: ${desktopExecutable}`)
    assert.ok(existsSync(sidecarExecutable), `missing sidecar executable: ${sidecarExecutable}`)
    renameSync(sidecarExecutable, `${sidecarExecutable}.real`)
    const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`
    writeFileSync(
      sidecarExecutable,
      `#!/bin/sh
umask 077
printf '%s' "$HEXCLAW_SIDECAR_CAPABILITY_TOKEN" > ${shellQuote(capabilityFile)}
sleep ${sidecarDelayMilliseconds / 1000}
exec "$(dirname "$0")/hexclaw.real" "$@"
`,
      { mode: 0o700 },
    )
    chmodSync(sidecarExecutable, 0o700)

    appLog = createWriteStream(join(sandbox, 'app.log'), { flags: 'wx', mode: 0o600 })
    appProcess = spawn(desktopExecutable, [], {
      cwd: sandbox,
      env: {
        ...environment,
        HOME: sandbox,
        USERPROFILE: sandbox,
        CFFIXED_USER_HOME: sandbox,
        TMPDIR: temporary,
        TEMP: temporary,
        TMP: temporary,
        HEXCLAW_TEST_MODE: '1',
        HEXCLAW_TEST_HOME: sandbox,
        HEXCLAW_SIDECAR_PORT: String(sidecarPort),
        HEXCLAW_TEST_LLM_CONFIG_MODE: 'preseeded-owner-yaml',
        HEXCLAW_DISABLE_BACKGROUND_EGRESS: '1',
        NO_PROXY: '*',
        no_proxy: '*',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    appProcess.stdout.pipe(appLog, { end: false })
    appProcess.stderr.pipe(appLog, { end: false })

    const bootstrap = await waitForReport(
      fixture.state,
      (report) => report.stage === 'bootstrap',
      'WebView bootstrap',
      20000,
    )
    assert.equal(bootstrap.isTauri, true)
    assert.deepEqual(listenerPIDs(sidecarPort), [], 'sidecar started before the WebView observer')
    const dom = await waitForReport(
      fixture.state,
      (report) => report.stage === 'dom-probe',
      'ChatView route probe',
    )
    assert.equal(dom.chat, true, `ChatView did not mount: ${JSON.stringify(dom)}`)
    const firstFailure = await waitForReport(
      fixture.state,
      (report) =>
        report.stage === 'connection-dom' && report.chat === true && report.error === true,
      'initial connection-directory error projection',
    )
    await waitForHealth(sidecarPort, appProcess)
    const recovered = await waitForReport(
      fixture.state,
      (report) =>
        report.stage === 'connection-dom' &&
        report.observedAt > firstFailure.observedAt &&
        report.empty === true &&
        report.error === false,
      'sidecar-ready connection-directory recovery projection',
    )
    assert.ok(
      recovered.observedAt - firstFailure.observedAt >= sidecarDelayMilliseconds - 1200,
      'recovery occurred before delayed native ready',
    )
    const initialConnectionsResponse = await probeConnectionsHTTP(sidecarPort, capabilityFile)
    assert.equal(
      initialConnectionsResponse.status,
      200,
      `initial /connections was not HTTP 200: ${JSON.stringify(initialConnectionsResponse)}`,
    )

    const sidecarBeforeRestart = listenerPIDs(sidecarPort)
    assert.equal(
      sidecarBeforeRestart.length,
      1,
      'expected exactly one Sidecar listener before native restart',
    )
    execFileSync('sqlite3', [
      join(home, 'data.db'),
      `
      PRAGMA busy_timeout=5000;
      INSERT INTO platform_instances
        (id,provider,name,enabled,mode,status,config_json,last_error,created_at,updated_at)
      VALUES
        ('restart-generation-proof-id','dingtalk','${restartProofConnectionName}',0,'stream','stopped','{}','',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
    `,
    ])
    fixture.state.restartRequested = true
    const restartClicked = await waitForReport(
      fixture.state,
      (report) => report.stage === 'sidecar-restart-clicked',
      'native Sidecar restart click',
    )
    const restartedListenerDeadline = Date.now() + 60000
    let sidecarAfterRestart = []
    while (Date.now() < restartedListenerDeadline) {
      sidecarAfterRestart = listenerPIDs(sidecarPort)
      if (sidecarAfterRestart.length === 1 && sidecarAfterRestart[0] !== sidecarBeforeRestart[0])
        break
      await sleep(100)
    }
    assert.equal(
      sidecarAfterRestart.length,
      1,
      'expected exactly one Sidecar listener after native restart',
    )
    assert.notEqual(
      sidecarAfterRestart[0],
      sidecarBeforeRestart[0],
      'native restart kept the old Sidecar process',
    )
    await waitForHealth(sidecarPort, appProcess)
    const authoritativeConnections = JSON.parse(
      execFileSync(
        'sqlite3',
        ['-json', join(home, 'data.db'), 'SELECT name FROM platform_instances ORDER BY name;'],
        { encoding: 'utf8' },
      ),
    )
    assert.equal(authoritativeConnections.length, 1)
    assert.equal(authoritativeConnections[0].name, restartProofConnectionName)
    const restartedConnectionsResponse = await probeConnectionsHTTP(sidecarPort, capabilityFile)
    assert.equal(
      restartedConnectionsResponse.status,
      200,
      `second-generation /connections was not HTTP 200: ${JSON.stringify(restartedConnectionsResponse)}`,
    )
    assert.deepEqual(restartedConnectionsResponse.responseShape.names, [restartProofConnectionName])
    const restartConnectionVisible = await waitForReport(
      fixture.state,
      (report) =>
        report.stage === 'restart-connection-visible' &&
        report.observedAt >= restartedConnectionsResponse.completedAt &&
        report.name === restartProofConnectionName &&
        report.empty === false &&
        report.error === false,
      'second-generation exact connection visibility',
      60000,
    )
    const restartedProjection = await waitForReport(
      fixture.state,
      (report) =>
        report.stage === 'connection-dom' &&
        report.observedAt >= restartConnectionVisible.observedAt &&
        report.empty === false &&
        report.error === false,
      'second-generation connection-directory projection',
      60000,
    )
    const restartedProjectionStable = await waitForReport(
      fixture.state,
      (report) =>
        report.stage === 'connection-dom' &&
        report.observedAt >= restartedProjection.observedAt + 500 &&
        report.empty === false &&
        report.error === false,
      'stable second-generation connection-directory projection',
    )

    try {
      screenshot = captureWindow(
        appProcess.pid,
        join(evidenceRoot, 'recovered-after-sidecar-restart-chat-connections.png'),
      )
    } catch (error) {
      if (!reuseBuiltBinary) throw error
      screenshotError = error instanceof Error ? error.message : String(error)
    }
    resultSummary = {
      bug: 'BUG-20260725-008',
      result: 'PASS',
      sourceDigest: sourceManifest.digest,
      app: {
        bundleIdentifier,
        reusedBuiltBinary: reuseBuiltBinary,
        desktopSHA256: sha256File(desktopExecutable),
        sidecarSHA256: sha256File(`${sidecarExecutable}.real`),
        injectedFrontendSHA256: reuseBuiltBinary ? null : treeManifest(frontend).digest,
      },
      timing: {
        sidecarDelayMilliseconds,
        firstFailureAt: firstFailure.observedAt,
        recoveredAt: recovered.observedAt,
      },
      restart: {
        beforePID: sidecarBeforeRestart[0],
        afterPID: sidecarAfterRestart[0],
        clickedAt: restartClicked.observedAt,
      },
      authoritativeConnections: {
        total: authoritativeConnections.length,
        name: authoritativeConnections[0].name,
      },
      webView: {
        bootstrap,
        firstFailure,
        recovered,
        initialConnectionsResponse,
        restartedConnectionsResponse,
        restartConnectionVisible,
        restartedProjection,
        restartedProjectionStable,
      },
      isolation: {
        applicationsDirectoryTouched: false,
        realHomeRead: false,
        externalNetwork: false,
        sidecarPort,
        fixturePort,
      },
      screenshot: screenshot
        ? { file: 'recovered-after-sidecar-restart-chat-connections.png', ...screenshot }
        : { file: null, unavailableReason: screenshotError },
    }
    writeFileSync(
      join(evidenceRoot, 'pass-summary.json'),
      `${JSON.stringify(resultSummary, null, 2)}\n`,
      { mode: 0o600 },
    )
    process.stdout.write(`${JSON.stringify(resultSummary)}\n`)
  } finally {
    await stopProcess(appProcess)
    if (appLog) await new Promise((resolveEnd) => appLog.end(resolveEnd))
    for (const pid of listenerPIDs(sidecarPort)) {
      const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
        encoding: 'utf8',
      }).trim()
      assert.ok(command.includes(`${runtimeRoot}/hexclaw`), `unexpected sidecar owner: ${command}`)
      process.kill(pid, 'SIGTERM')
    }
    const cleanupDeadline = Date.now() + 10000
    while (listenerPIDs(sidecarPort).length && Date.now() < cleanupDeadline) await sleep(100)
    assert.deepEqual(
      listenerPIDs(sidecarPort),
      [],
      'delayed Test.app sidecar remains after cleanup',
    )
    await fixture.close()
    if (!reuseBuiltBinary) rmSync(appBundle, { recursive: true, force: true })
    rmSync(sandbox, { recursive: true, force: true })
    writeFileSync(
      join(evidenceRoot, 'cleanup.json'),
      `${JSON.stringify(
        {
          status: resultSummary?.result ?? 'NOT_PASS',
          appProcessStopped:
            !appProcess || appProcess.exitCode !== null || appProcess.signalCode !== null,
          sidecarPortReleased: listenerPIDs(sidecarPort).length === 0,
          fixturePortReleased: listenerPIDs(fixturePort).length === 0,
          uniqueAppBundleRemoved: reuseBuiltBinary || !existsSync(appBundle),
          sandboxRemoved: !existsSync(sandbox),
          screenshot: screenshot ? 'recovered-after-sidecar-restart-chat-connections.png' : null,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    )
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`)
  process.exitCode = 1
})
