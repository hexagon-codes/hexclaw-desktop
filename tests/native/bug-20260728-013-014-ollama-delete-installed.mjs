#!/usr/bin/env node

/**
 * BUG-20260728-013/014 的隔离 Test.app 原生边界。
 *
 * 当前生产前端只在临时产物中注入测试驱动和 loopback Ollama 地址重写；删除仍经过
 * 真实 WKWebView -> Tauri sidecar_fetch -> 当前 Sidecar -> fake Ollama。脚本不访问用户
 * HOME、用户 Ollama、/Applications、真实 Provider、外部模型或 IM。
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
const srcTauriDir = join(repoRoot, 'src-tauri')
const productName = 'HexClaw Ollama Delete Test'
const bundleIdentifier = 'com.hexclaw.desktop.bug-20260728-013-014'
const appBundle = join(srcTauriDir, `target/release/bundle/macos/${productName}.app`)
const appExecutable = join(appBundle, 'Contents/MacOS/hexclaw-desktop')
const sidecarExecutable = join(appBundle, 'Contents/MacOS/hexclaw')
const commandTimeoutMs = 15 * 60 * 1000
const testTimeoutMs = 12 * 60 * 1000
const timingModel = 'isolated-timing:latest'
const cancelModel = 'isolated-cancel:latest'
const failure4xxModel = 'isolated-4xx:latest'
const failure5xxModel = 'isolated-5xx:latest'
const initialModels = [timingModel, cancelModel, failure4xxModel, failure5xxModel]
const sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds))

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function listenerPIDs(port) {
  try {
    return execFileSync('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
      encoding: 'utf8',
      timeout: 5_000,
    })
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number)
      .filter(Number.isInteger)
  } catch (error) {
    if (error?.status === 1) return []
    throw error
  }
}

function processCommand(pid) {
  try {
    return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      timeout: 5_000,
    }).trim()
  } catch {
    return ''
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
  assert.notEqual(port, 11434)
  assert.notEqual(port, 16060)
  return port
}

function runCommand(command, args, options = {}) {
  return new Promise((resolveCommand, rejectCommand) => {
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
        // 子进程已经退出。
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

function sendJSON(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'DELETE,GET,OPTIONS,POST',
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
    if (length > 2 * 1024 * 1024) throw new Error('fixture request exceeds 2 MiB')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

function canonicalModel(value) {
  const name = String(value).toLowerCase()
  return name.includes(':') ? name : `${name}:latest`
}

function createFixtureServer(port) {
  const origin = `http://127.0.0.1:${port}`
  const state = {
    models: new Set(initialModels),
    directRequests: [],
    deleteCalls: [],
    reports: [],
    releasedStages: new Set(),
    unexpected: [],
  }
  const attempts = new Map()

  function publicState() {
    return {
      models: [...state.models],
      directRequests: state.directRequests,
      deleteCalls: state.deleteCalls,
      unexpected: state.unexpected,
    }
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url || '/', origin)
    try {
      if (request.method === 'OPTIONS') {
        response.writeHead(204, {
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Allow-Methods': 'DELETE,GET,OPTIONS,POST',
          'Access-Control-Allow-Origin': '*',
        })
        response.end()
        return
      }
      if (request.method === 'POST' && url.pathname === '/__report') {
        state.reports.push(await readJSONBody(request))
        sendJSON(response, 200, { ok: true })
        return
      }
      if (request.method === 'GET' && url.pathname === '/__state') {
        sendJSON(response, 200, publicState())
        return
      }
      if (request.method === 'GET' && url.pathname === '/__released') {
        sendJSON(response, 200, { released: state.releasedStages.has(url.searchParams.get('stage')) })
        return
      }
      if (request.method === 'GET' && url.pathname === '/updater') {
        response.writeHead(204, { 'Access-Control-Allow-Origin': '*' })
        response.end()
        return
      }
      if (request.method === 'GET' && url.pathname === '/v1/models') {
        sendJSON(response, 200, {
          object: 'list',
          data: [...state.models].map((id) => ({ id, object: 'model', owned_by: 'isolated' })),
        })
        return
      }
      if (request.method === 'POST' && url.pathname === '/v1/embeddings') {
        const body = await readJSONBody(request)
        state.directRequests.push({ method: 'POST', path: url.pathname, model: body.model })
        sendJSON(response, 200, {
          object: 'list',
          model: body.model,
          data: [{ object: 'embedding', index: 0, embedding: [1, 0, 0, 0] }],
          usage: { prompt_tokens: 1, total_tokens: 1 },
        })
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/version') {
        state.directRequests.push({ method: 'GET', path: url.pathname })
        sendJSON(response, 200, { version: '0.0.0-isolated' })
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/tags') {
        state.directRequests.push({ method: 'GET', path: url.pathname })
        sendJSON(response, 200, {
          models: [...state.models].map((name) => ({
            name,
            model: name,
            size: 1,
            modified_at: '2026-08-22T00:00:00Z',
            details: { parameter_size: 'isolated', quantization_level: 'none' },
          })),
        })
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/ps') {
        state.directRequests.push({ method: 'GET', path: url.pathname })
        sendJSON(response, 200, { models: [] })
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/generate') {
        const body = await readJSONBody(request)
        state.directRequests.push({ method: 'POST', path: url.pathname, model: body.model })
        sendJSON(response, 200, { model: body.model, done: true, response: '' })
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/chat') {
        const body = await readJSONBody(request)
        state.directRequests.push({ method: 'POST', path: url.pathname, model: body.model })
        sendJSON(response, 200, { model: body.model, done: true, message: { role: 'assistant', content: '' } })
        return
      }
      if (request.method === 'DELETE' && url.pathname === '/api/delete') {
        const body = await readJSONBody(request)
        const model = canonicalModel(body.model)
        const attempt = (attempts.get(model) || 0) + 1
        attempts.set(model, attempt)
        let status = 200
        if (model === failure4xxModel && attempt === 1) status = 409
        if (model === failure5xxModel && attempt === 1) status = 503
        state.deleteCalls.push({ model, attempt, status })
        if (status >= 200 && status < 300) state.models.delete(model)
        sendJSON(response, status, status === 200 ? { status: 'success' } : { error: `isolated ${status}` })
        return
      }
      state.unexpected.push(`${request.method} ${url.pathname}`)
      sendJSON(response, 404, { error: 'unexpected fixture request' })
    } catch (error) {
      state.unexpected.push(`fixture-error:${error instanceof Error ? error.message : String(error)}`)
      if (!response.headersSent) sendJSON(response, 500, { error: 'fixture failure' })
      else response.destroy()
    }
  })

  return {
    origin,
    state,
    release(stage) {
      state.releasedStages.add(stage)
    },
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
llm:
  default: isolated-ollama
  providers:
    isolated-ollama:
      provider_instance_id: pvd_v1_22222222222222222222222222222222
      display_name: Isolated Ollama
      api_key: ""
      base_url: ${fixtureOrigin}
      model: ${timingModel}
      models:
${initialModels.map((model) => `        - ${model}`).join('\n')}
      model_specs_mode: explicit
      model_specs:
${initialModels
  .map(
    (model) => `        - id: ${model}
          display_name: ${model}
          capabilities:
            - text${model === timingModel ? `
            - embedding
          embedding:
            protocol: ollama_embeddings
            dimension: 4
            normalization: l2` : ''}`,
  )
  .join('\n')}
      compatible: ollama
      locality: local
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
  enabled: true
  embedding:
    provider: isolated-ollama
    model: ${timingModel}
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

function renderFixtureScript(fixtureOrigin) {
  return `(() => {
  const fixtureOrigin = ${JSON.stringify(fixtureOrigin)}
  const timingModel = ${JSON.stringify(timingModel)}
  const cancelModel = ${JSON.stringify(cancelModel)}
  const failure4xxModel = ${JSON.stringify(failure4xxModel)}
  const failure5xxModel = ${JSON.stringify(failure5xxModel)}
  const initialModels = ${JSON.stringify(initialModels)}
  const rawFetch = globalThis.fetch.bind(globalThis)
  const invokeEvents = []
  const installInvokeTrace = () => {
    const tauriInternals = globalThis.__TAURI_INTERNALS__
    if (typeof tauriInternals?.invoke !== 'function' || tauriInternals.invoke.__hcOllamaDeleteTraced) return false
    const rawInvoke = tauriInternals.invoke.bind(tauriInternals)
    const tracedInvoke = async (command, args) => {
      try {
        const result = await rawInvoke(command, args)
        if (command === 'sidecar_fetch') invokeEvents.push({ command, method: args?.method, path: args?.path, status: result?.status })
        return result
      } catch (error) {
        if (command === 'sidecar_fetch') invokeEvents.push({ command, method: args?.method, path: args?.path, error: error?.message || String(error) })
        throw error
      }
    }
    Object.defineProperty(tracedInvoke, '__hcOllamaDeleteTraced', { value: true })
    try {
      Object.defineProperty(tauriInternals, 'invoke', { configurable: true, writable: true, value: tracedInvoke })
    } catch {
      tauriInternals.invoke = tracedInvoke
    }
    return true
  }
  installInvokeTrace()
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const inputURL = (input) => input instanceof Request ? input.url : String(input)
  globalThis.fetch = (input, init) => {
    const raw = inputURL(input)
    if (raw.startsWith('http://localhost:16060/')) return Promise.reject(new Error('isolated renderer sidecar bypass blocked'))
    if (!raw.startsWith('http://localhost:11434/')) return rawFetch(input, init)
    const rewritten = fixtureOrigin + raw.slice('http://localhost:11434'.length)
    if (input instanceof Request) return rawFetch(new Request(rewritten, input), init)
    return rawFetch(rewritten, init)
  }
  const post = async (value) => {
    await rawFetch(fixtureOrigin + '/__report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    })
  }
  const state = async () => (await rawFetch(fixtureOrigin + '/__state')).json()
  const waitFor = async (read, timeout = 20000, label = 'condition') => {
    const deadline = performance.now() + timeout
    while (performance.now() < deadline) {
      const value = await read()
      if (value) return value
      await sleep(10)
    }
    throw new Error('Timed out waiting for ' + label)
  }
  const click = (element) => element.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }))
  const deleteButton = (model) => [...document.querySelectorAll('button.ollama-card__model-btn--danger')]
    .find((button) => (button.getAttribute('title') || '').includes(model))
  const modelVisible = (model) => Boolean(deleteButton(model))
  const confirmButton = () => document.querySelector('.hc-dialog__btn--danger')
  const waitForDeleteCalls = (count) => waitFor(async () => {
    const current = await state()
    return current.deleteCalls.length >= count ? current : null
  }, 20000, count + ' delete calls')
  const waitForUnlock = async (_button, startedAt) => {
    await waitFor(() => {
      const current = confirmButton()
      return current && !current.disabled
    }, 4000, '1500ms confirmation unlock')
    const elapsedMs = performance.now() - startedAt
    if (elapsedMs < 1490) throw new Error('Confirmation unlocked too early: ' + elapsedMs)
    return elapsedMs
  }
  const openDelete = async (model) => {
    const button = await waitFor(() => deleteButton(model), 20000, model + ' delete button')
    const startedAt = performance.now()
    click(button)
    const confirm = await waitFor(() => confirmButton(), 2000, 'shared ConfirmDialog')
    return { confirm, startedAt }
  }
  const closeToasts = () => {
    for (const close of document.querySelectorAll('.hc-toast__close')) click(close)
  }
  const checkpoint = async (stage, facts) => {
    await post({ stage, facts })
    await waitFor(async () => {
      const response = await rawFetch(fixtureOrigin + '/__released?stage=' + encodeURIComponent(stage))
      return (await response.json()).released
    }, 10000, stage + ' release')
  }

  localStorage.clear()
  sessionStorage.clear()
  localStorage.setItem('hexclaw:welcomeRedirectDone', '1')
  sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
  history.replaceState(null, '', '/settings')

  const execute = async () => {
    await post({ stage: 'bootstrap', runtime: 'Tauri Test.app WKWebView', isTauri: globalThis.isTauri === true })
    await waitFor(() => document.querySelector('.hc-app'), 30000, 'HexClaw app')
    installInvokeTrace()
    await waitFor(() => document.querySelector('.ollama-card'), 30000, 'Ollama settings card')
    await waitFor(() => initialModels.every((model) => modelVisible(model)), 30000, 'isolated Ollama models')

    const deleteCountBeforeCancel = (await state()).deleteCalls.length
    const cancelDialog = await openDelete(cancelModel)
    if (!cancelDialog.confirm.disabled) throw new Error('Cancel target confirmation was not locked')
    const cancelButton = document.querySelector('.hc-dialog .hc-btn-secondary')
    if (!cancelButton) throw new Error('Shared cancel button is missing')
    click(cancelButton)
    await waitFor(() => !document.querySelector('.hc-dialog-overlay'), 2000, 'cancelled dialog close')
    await sleep(50)
    const afterCancel = await state()
    const cancelFacts = {
      deleteCallsBefore: deleteCountBeforeCancel,
      deleteCallsAfter: afterCancel.deleteCalls.length,
      targetStillVisible: modelVisible(cancelModel),
    }
    if (cancelFacts.deleteCallsAfter !== cancelFacts.deleteCallsBefore || !cancelFacts.targetStillVisible) {
      throw new Error('Cancel deleted or hid the target')
    }

    const timingCallsBefore = afterCancel.deleteCalls.length
    const timingDialog = await openDelete(timingModel)
    const at0Disabled = timingDialog.confirm.disabled
    click(timingDialog.confirm)
    await sleep(0)
    const at0Calls = (await state()).deleteCalls.length
    const waitUntil1499 = Math.max(0, timingDialog.startedAt + 1499 - performance.now())
    await sleep(waitUntil1499)
    const at1499Disabled = timingDialog.confirm.disabled
    const at1499Calls = (await state()).deleteCalls.length
    const unlockElapsedMs = await waitForUnlock(timingDialog.confirm, timingDialog.startedAt)
    click(confirmButton())
    const afterTimingCall = await waitForDeleteCalls(timingCallsBefore + 1)
    await waitFor(() => !modelVisible(timingModel), 10000, 'timing model refresh removal')
    const timingFacts = {
      at0Disabled,
      at0Calls,
      at1499Disabled,
      at1499Calls,
      unlockElapsedMs,
      deleteCall: afterTimingCall.deleteCalls.at(-1),
      targetRemovedAfterRefresh: !modelVisible(timingModel),
    }
    if (!at0Disabled || !at1499Disabled || at0Calls !== timingCallsBefore || at1499Calls !== timingCallsBefore) {
      throw new Error('Delete executed before the 1500ms confirmation boundary')
    }

    const exerciseFailure = async (model, expectedStatus, stage) => {
      const callsBefore = (await state()).deleteCalls.length
      const firstDialog = await openDelete(model)
      const firstUnlockMs = await waitForUnlock(firstDialog.confirm, firstDialog.startedAt)
      click(confirmButton())
      const failedState = await waitForDeleteCalls(callsBefore + 1)
      const toast = await waitFor(
        () => [...document.querySelectorAll('.hc-toast__msg')].find((node) => node.textContent?.includes('删除失败')),
        5000,
        expectedStatus + ' shared Toast',
      )
      const failedCall = failedState.deleteCalls.at(-1)
      const targetVisibleAfterFailure = modelVisible(model)
      const retryConfirm = await waitFor(() => confirmButton(), 2000, 'retry ConfirmDialog')
      const retryInitiallyDisabled = retryConfirm.disabled
      await checkpoint(stage, {
        model,
        expectedStatus,
        failedCall,
        firstUnlockMs,
        toastText: toast.textContent,
        targetVisibleAfterFailure,
        retryInitiallyDisabled,
      })
      if (failedCall.status !== expectedStatus || !targetVisibleAfterFailure || !retryInitiallyDisabled) {
        throw new Error(expectedStatus + ' failure state violated the shared contract')
      }
      await waitFor(() => {
        const current = confirmButton()
        return current && !current.disabled
      }, 4000, 'retry cooldown')
      click(confirmButton())
      const recoveredState = await waitForDeleteCalls(callsBefore + 2)
      await waitFor(() => !modelVisible(model), 10000, model + ' retry refresh removal')
      const calls = recoveredState.deleteCalls.slice(callsBefore)
      if (calls.length !== 2 || calls[0].model !== model || calls[1].model !== model || calls[1].status !== 200) {
        throw new Error(expectedStatus + ' retry targeted the wrong model or did not recover')
      }
      closeToasts()
      return { model, calls, targetRemovedAfterRetry: !modelVisible(model) }
    }

    const failure4xx = await exerciseFailure(failure4xxModel, 409, '4xx-toast')
    const failure5xx = await exerciseFailure(failure5xxModel, 503, '5xx-toast')
    const finalState = await state()
    const expectedRemaining = [cancelModel]
    if (JSON.stringify(finalState.models) !== JSON.stringify(expectedRemaining)) {
      throw new Error('Final fake Ollama model exact-set is wrong: ' + JSON.stringify(finalState.models))
    }
    if (finalState.unexpected.length !== 0) {
      throw new Error('Unexpected fixture requests: ' + JSON.stringify(finalState.unexpected))
    }
    await post({
      stage: 'final',
      status: 'PASS',
      runtime: 'Tauri Test.app WKWebView',
      facts: {
        cancel: cancelFacts,
        timing: timingFacts,
        failure4xx,
        failure5xx,
        finalModels: finalState.models,
        tagsRefreshCalls: finalState.directRequests.filter((event) => event.path === '/api/tags').length,
        directRequests: finalState.directRequests,
        deleteCalls: finalState.deleteCalls,
      },
    })
  }
  execute().catch(async (error) => {
    const message = error && error.message ? error.message : String(error)
    const fixtureState = await state().catch(() => null)
    await post({
      stage: 'fixture-error',
      message,
      invokeEvents,
      fixtureState,
      toastTexts: [...document.querySelectorAll('.hc-toast__msg')].map((node) => node.textContent),
      dialog: confirmButton() ? { disabled: confirmButton().disabled, connected: confirmButton().isConnected } : null,
    }).catch(() => undefined)
  })
})()
`
}

function prepareFrontend(frontend, fixtureOrigin) {
  const fixtureName = 'bug-20260728-013-014-ollama-delete-installed-fixture.js'
  writeFileSync(join(frontend, fixtureName), renderFixtureScript(fixtureOrigin), { mode: 0o600 })
  const indexPath = join(frontend, 'index.html')
  const index = readFileSync(indexPath, 'utf8')
  assert.match(index, /<head>/)
  writeFileSync(indexPath, index.replace('<head>', `<head>\n<script src="./${fixtureName}"></script>`), {
    mode: 0o600,
  })
}

function writeOverlay(sandbox, frontend, sidecarPort, fixtureOrigin) {
  const overlayPath = join(sandbox, 'tauri.ollama-delete.conf.json')
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
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
          width: 1100,
          height: 760,
          minWidth: 900,
          minHeight: 620,
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
      updater: { endpoints: [`${fixtureOrigin}/updater`], dangerousInsecureTransportProtocol: true },
    },
  }
  writeFileSync(overlayPath, `${JSON.stringify(overlay, null, 2)}\n`, { mode: 0o600 })
  return overlayPath
}

async function waitForHealth(port, appProcess) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (appProcess.exitCode !== null || appProcess.signalCode !== null) {
      throw new Error(`Test.app exited before Sidecar health: ${appProcess.exitCode ?? appProcess.signalCode}`)
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1_000),
      })
      if (response.ok) return
    } catch {
      // Sidecar 尚未就绪。
    }
    await sleep(150)
  }
  throw new Error('Timed out waiting for Test.app Sidecar health')
}

async function waitForReport(state, stage, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const report = state.reports.find((entry) => entry.stage === stage)
    if (report) return report
    const failure = state.reports.find((entry) => entry.stage === 'fixture-error')
    if (failure) throw new Error(`WKWebView fixture failed: ${JSON.stringify(failure)}`)
    await sleep(50)
  }
  throw new Error(`Timed out waiting for WKWebView report: ${stage}`)
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
     let bounds = row[kCGWindowBounds as String] as? [String: Any] {
    print("\\(id)|\\(bounds[\"X\"]!)|\\(bounds[\"Y\"]!)|\\(bounds[\"Width\"]!)|\\(bounds[\"Height\"]!)")
    break
  }
}
`
  const output = execFileSync('/usr/bin/swift', ['-e', swift], { encoding: 'utf8' }).trim()
  assert.ok(output, `No visible Test.app window for PID ${pid}`)
  const [id, x, y, width, height] = output.split('|').map(Number)
  return { id, x, y, width, height }
}

function captureWindow(pid, destination) {
  const window = windowInfoForPID(pid)
  execFileSync('/usr/sbin/screencapture', ['-x', '-l', String(window.id), destination], {
    timeout: 10_000,
  })
  assert.ok(existsSync(destination) && statSync(destination).size > 1024)
  return { ...window, bytes: statSync(destination).size, sha256: sha256File(destination) }
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  const exited = await Promise.race([
    new Promise((resolveExit) => child.once('exit', () => resolveExit(true))),
    sleep(5_000).then(() => false),
  ])
  if (!exited && child.exitCode === null) {
    child.kill('SIGKILL')
    await new Promise((resolveExit) => child.once('exit', resolveExit))
  }
}

async function stopOwnedSidecar(port) {
  const stopped = []
  const unexpected = []
  for (const pid of listenerPIDs(port)) {
    const command = processCommand(pid)
    if (!command.includes(sidecarExecutable)) {
      unexpected.push({ pid, command })
      continue
    }
    process.kill(pid, 'SIGTERM')
    stopped.push(pid)
  }
  const deadline = Date.now() + 10_000
  while (listenerPIDs(port).length > 0 && Date.now() < deadline) await sleep(100)
  return { stopped, unexpected, released: listenerPIDs(port).length === 0 }
}

function sanitize(raw, sandbox) {
  return String(raw)
    .replaceAll(repoRoot, '<repo>')
    .replaceAll(sandbox, '<test-home>')
    .replaceAll(process.env.HOME || '<real-home>', '<real-home>')
}

async function main() {
  assert.equal(process.platform, 'darwin', 'This Test.app boundary is macOS-only')
  const runName = new Date().toISOString().replaceAll(':', '').replaceAll('.', '-')
  const evidenceRoot = join(repoRoot, 'test/evidence/bug-20260728-013-014-test-app', runName)
  mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 })
  const sandbox = mkdtempSync(join(tmpdir(), 'hexclaw-ollama-delete.'))
  chmodSync(sandbox, 0o700)
  mkdirSync(join(sandbox, '.hexclaw'), { mode: 0o700 })
  mkdirSync(join(sandbox, 'tmp'), { mode: 0o700 })
  const frontend = join(sandbox, 'frontend')
  const fixturePort = await reserveLoopbackPort()
  const sidecarPort = await reserveLoopbackPort()
  assert.notEqual(fixturePort, sidecarPort)
  assert.deepEqual(listenerPIDs(fixturePort), [])
  assert.deepEqual(listenerPIDs(sidecarPort), [])
  const fixture = createFixtureServer(fixturePort)
  let appProcess = null
  let appLog = null
  let failure = null
  const screenshots = {}
  const cleanup = { appPID: null, sidecarPIDs: [], unexpectedPortOwners: [], sidecarPortReleased: false, fixturePortReleased: false }

  try {
    await fixture.listen()
    const configPath = join(sandbox, '.hexclaw/hexclaw.yaml')
    writeFileSync(configPath, renderConfig(sandbox, sidecarPort, fixture.origin), { mode: 0o600 })
    chmodSync(configPath, 0o600)
    const buildEnv = {
      ...process.env,
      CARGO_NET_OFFLINE: 'true',
      CARGO_TARGET_DIR: join(srcTauriDir, 'target'),
      GOENV: 'off',
      GOPROXY: 'off',
      GOSUMDB: 'off',
      PNPM_CONFIG_OFFLINE: 'true',
      npm_config_offline: 'true',
      HEXCLAW_PACKAGE_LOCAL_DIST_DIR: frontend,
      HEXCLAW_TEST_ALLOW_AUTO_LOCAL_OLLAMA: '0',
    }
    delete buildEnv.GOROOT
    await runCommand('pnpm', ['build-only:package-local'], { env: buildEnv })
    prepareFrontend(frontend, fixture.origin)
    const overlay = writeOverlay(sandbox, frontend, sidecarPort, fixture.origin)
    await runCommand('pnpm', ['exec', 'tauri', 'build', '--config', overlay, '--bundles', 'app'], {
      env: buildEnv,
    })
    assert.ok(existsSync(appExecutable), `Test.app executable is missing: ${appExecutable}`)
    assert.ok(existsSync(sidecarExecutable), `Test.app Sidecar is missing: ${sidecarExecutable}`)
    const infoPlist = join(appBundle, 'Contents/Info.plist')
    const identifier = execFileSync(
      'plutil',
      ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', infoPlist],
      { encoding: 'utf8' },
    ).trim()
    assert.equal(identifier, bundleIdentifier)

    const logPath = join(sandbox, 'app.log')
    appLog = createWriteStream(logPath, { flags: 'wx', mode: 0o600 })
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
      HEXCLAW_TEST_PROFILE_CATCHUP: '0',
      HEXCLAW_TEST_ALLOW_AUTO_LOCAL_OLLAMA: '0',
      DINGTALK_LIVE_SEND: '0',
      NO_PROXY: '*',
      no_proxy: '*',
    }
    appProcess = spawn(appExecutable, [], {
      cwd: sandbox,
      env: runtimeEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    cleanup.appPID = appProcess.pid
    appProcess.stdout.pipe(appLog, { end: false })
    appProcess.stderr.pipe(appLog, { end: false })
    await waitForHealth(sidecarPort, appProcess)
    const sidecarPIDs = listenerPIDs(sidecarPort)
    assert.equal(sidecarPIDs.length, 1, 'Test.app must own exactly one isolated Sidecar')
    assert.ok(processCommand(sidecarPIDs[0]).includes(sidecarExecutable))
    const bootstrap = await waitForReport(fixture.state, 'bootstrap', 30_000)
    assert.equal(bootstrap.runtime, 'Tauri Test.app WKWebView')
    assert.equal(bootstrap.isTauri, true)

    const report4xx = await waitForReport(fixture.state, '4xx-toast', 90_000)
    screenshots.failure4xx = captureWindow(appProcess.pid, join(evidenceRoot, '4xx-toast.png'))
    fixture.release('4xx-toast')
    const report5xx = await waitForReport(fixture.state, '5xx-toast', 90_000)
    screenshots.failure5xx = captureWindow(appProcess.pid, join(evidenceRoot, '5xx-toast.png'))
    fixture.release('5xx-toast')
    const finalReport = await waitForReport(fixture.state, 'final', 90_000)
    assert.equal(finalReport.status, 'PASS')
    screenshots.final = captureWindow(appProcess.pid, join(evidenceRoot, 'final.png'))

    assert.equal(report4xx.facts.expectedStatus, 409)
    assert.match(report4xx.facts.toastText, /删除失败/)
    assert.equal(report5xx.facts.expectedStatus, 503)
    assert.match(report5xx.facts.toastText, /删除失败/)
    assert.equal(finalReport.facts.cancel.deleteCallsAfter, finalReport.facts.cancel.deleteCallsBefore)
    assert.equal(finalReport.facts.cancel.targetStillVisible, true)
    assert.equal(finalReport.facts.timing.at0Disabled, true)
    assert.equal(finalReport.facts.timing.at1499Disabled, true)
    assert.ok(finalReport.facts.timing.unlockElapsedMs >= 1490)
    assert.equal(finalReport.facts.timing.targetRemovedAfterRefresh, true)
    assert.deepEqual(
      finalReport.facts.deleteCalls.map(({ model, status }) => ({ model, status })),
      [
        { model: timingModel, status: 200 },
        { model: failure4xxModel, status: 409 },
        { model: failure4xxModel, status: 200 },
        { model: failure5xxModel, status: 503 },
        { model: failure5xxModel, status: 200 },
      ],
    )
    assert.ok(finalReport.facts.tagsRefreshCalls >= 4)
    assert.deepEqual(finalReport.facts.finalModels, [cancelModel])

    const rawLog = readFileSync(logPath, 'utf8')
    writeFileSync(join(evidenceRoot, 'app.log'), sanitize(rawLog, sandbox), { mode: 0o600 })
    writeFileSync(
      join(evidenceRoot, 'summary.json'),
      `${JSON.stringify(
        {
          status: 'PASS',
          bugs: ['BUG-20260728-013', 'BUG-20260728-014'],
          boundary: 'current-source temporary Test.app / real WKWebView / real Tauri sidecar_fetch / isolated fake Ollama',
          app: {
            productName,
            bundleIdentifier,
            executableSHA256: sha256File(appExecutable),
            sidecarSHA256: sha256File(sidecarExecutable),
          },
          isolation: {
            temporaryHome: true,
            configMode: '0600',
            homeMode: '0700',
            sidecarPort,
            fixturePort,
            rendererOllamaRewrite: `http://localhost:11434 -> ${fixture.origin}`,
            userOllamaTouched: false,
            userSidecarTouched: false,
            applicationsTouched: false,
            realProviderCalls: 0,
            externalModelCalls: 0,
            realIMCalls: 0,
          },
          reports: { bootstrap, failure4xx: report4xx, failure5xx: report5xx, final: finalReport },
          fixture: {
            directRequests: fixture.state.directRequests,
            deleteCalls: fixture.state.deleteCalls,
            finalModels: [...fixture.state.models],
            unexpected: fixture.state.unexpected,
          },
          screenshots,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    )
    process.stdout.write(`PASS ${evidenceRoot}\n`)
  } catch (error) {
    failure = error
    throw error
  } finally {
    await stopProcess(appProcess)
    const stopped = await stopOwnedSidecar(sidecarPort)
    cleanup.sidecarPIDs.push(...stopped.stopped)
    cleanup.unexpectedPortOwners.push(...stopped.unexpected)
    cleanup.sidecarPortReleased = stopped.released
    await fixture.close()
    cleanup.fixturePortReleased = listenerPIDs(fixturePort).length === 0
    if (appLog) await new Promise((resolveEnd) => appLog.end(resolveEnd))
    writeFileSync(join(evidenceRoot, 'cleanup.json'), `${JSON.stringify(cleanup, null, 2)}\n`, {
      mode: 0o600,
    })
    rmSync(sandbox, { recursive: true, force: true })
    if (!cleanup.sidecarPortReleased || !cleanup.fixturePortReleased || cleanup.unexpectedPortOwners.length > 0) {
      const cleanupError = new Error('Isolated Test.app cleanup did not release owned resources')
      if (!failure) throw cleanupError
    }
  }
}

const timeout = setTimeout(() => {
  process.stderr.write('FAIL Ollama Test.app boundary exceeded 12 minutes\n')
  process.exitCode = 124
}, testTimeoutMs)

try {
  await main()
} finally {
  clearTimeout(timeout)
}
