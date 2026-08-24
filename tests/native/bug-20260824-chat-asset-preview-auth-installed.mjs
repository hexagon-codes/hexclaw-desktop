#!/usr/bin/env node

/**
 * K12-ASSET-PREVIEW-AUTH-001 / DESKTOP-BOUNDARY-FILE-010 原生诊断层 A。
 *
 * 运行态只使用临时 Test Home、独占回环端口、当前候选源码构建的 Test.app 与真实 Finder
 * 物理拖放。fixture 仅向临时前端副本注入生命周期审计，不伪造 Tauri drop/grant、资产上传、
 * 会话持久化或系统 Save 面板。模型、IM 与外部网络必须保持零调用。由于前端字节被注入，
 * 本层只能输出 DIAGNOSTIC_ONLY；必须另由直接运行最终安装包精确字节的 B 层通过后，整体才可 PASS。
 *
 * 默认或 --validate 仅做静态合同与 Swift typecheck；真正运行必须同时显式传入：
 *   HEXCLAW_CHAT_ASSET_NATIVE_RUN=1 node tests/native/bug-20260824-chat-asset-preview-auth-installed.mjs --run
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const nativeDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(nativeDir, '../..')
const srcTauriDir = join(repoRoot, 'src-tauri')
const sidecarRoot = resolve(repoRoot, '../hexclaw')
const installedCandidate = resolve(
  process.env.HEXCLAW_CHAT_ASSET_CANDIDATE_APP || '/Applications/HexClaw.app',
)
const installedDesktopExecutable = join(installedCandidate, 'Contents/MacOS/hexclaw-desktop')
const installedSidecarExecutable = join(installedCandidate, 'Contents/MacOS/hexclaw')
const defaultImagePath = resolve(repoRoot, '../hexclaw-docs/test/k12-test-美术.png')
const imagePath = resolve(process.env.HEXCLAW_CHAT_ASSET_IMAGE || defaultImagePath)
const evidenceRoot = resolve(
  process.env.HEXCLAW_CHAT_ASSET_EVIDENCE ||
    join(repoRoot, 'test-results/native-chat-asset-preview-auth'),
)
const productName = 'HexClaw Chat Asset Preview Auth Test'
const bundleIdentifier = 'com.hexclaw.desktop.chat-asset-preview-auth'
const syntheticCredential = 'chat-asset-preview-loopback-only'
const runTimeoutMs = 6 * 60 * 1000
const commandTimeoutMs = 14 * 60 * 1000
const sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds))

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function sha256File(path) {
  return sha256(readFileSync(path))
}

function deferred() {
  let resolvePromise
  const promise = new Promise((resolveDeferred) => {
    resolvePromise = resolveDeferred
  })
  return { promise, resolve: resolvePromise }
}

function runCommand(command, args, options = {}) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, {
      cwd: options.cwd || repoRoot,
      env: options.env || process.env,
      stdio: options.stdio || 'inherit',
    })
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      rejectCommand(new Error(`Command timed out: ${command}`))
    }, options.timeoutMs || commandTimeoutMs)
    child.once('error', (error) => {
      clearTimeout(timer)
      rejectCommand(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      if (code === 0) resolveCommand()
      else rejectCommand(new Error(`Command failed (${code ?? signal}): ${command}`))
    })
  })
}

async function reserveLoopbackPort() {
  const reservation = createServer()
  await new Promise((resolveListen, rejectListen) => {
    reservation.once('error', rejectListen)
    reservation.listen(0, '127.0.0.1', resolveListen)
  })
  const address = reservation.address()
  assert.ok(address && typeof address === 'object', 'Loopback reservation did not return a port')
  const port = address.port
  await new Promise((resolveClose, rejectClose) =>
    reservation.close((error) => (error ? rejectClose(error) : resolveClose())),
  )
  assert.notEqual(port, 16060, 'Test Sidecar must not use the user port')
  assert.notEqual(port, 11434, 'Test Sidecar must not use the Ollama port')
  return port
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

async function stopProcess(processHandle) {
  if (!processHandle || processHandle.exitCode !== null || processHandle.signalCode !== null) return
  processHandle.kill('SIGTERM')
  const stopped = await Promise.race([
    new Promise((resolveExit) => processHandle.once('exit', () => resolveExit(true))),
    sleep(5_000).then(() => false),
  ])
  if (!stopped && processHandle.exitCode === null) {
    processHandle.kill('SIGKILL')
    await new Promise((resolveExit) => processHandle.once('exit', resolveExit))
  }
}

async function stopOwnedSidecar(port, appBundle) {
  const expected = `${appBundle}/Contents/MacOS/hexclaw serve --desktop`
  const unexpected = []
  for (const pid of listenerPIDs(port)) {
    const command = processCommand(pid)
    if (!command.includes(expected)) {
      unexpected.push({ pid, command: command || '<unreadable>' })
      continue
    }
    process.kill(pid, 'SIGTERM')
  }
  const deadline = Date.now() + 5_000
  while (listenerPIDs(port).length && Date.now() < deadline) await sleep(100)
  return { unexpected, released: listenerPIDs(port).length === 0 }
}

async function waitForHealth(port, appProcess) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (appProcess.exitCode !== null || appProcess.signalCode !== null) {
      throw new Error('Test.app exited before the isolated Sidecar became healthy')
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1_000),
      })
      if (response.ok) return
    } catch {
      // Sidecar 仍在启动。
    }
    await sleep(150)
  }
  throw new Error('Isolated Sidecar health check timed out')
}

function sqliteRows(databasePath, sql) {
  if (!existsSync(databasePath)) return []
  const raw = execFileSync('sqlite3', ['-json', '-cmd', '.timeout 5000', databasePath, sql], {
    encoding: 'utf8',
    timeout: 10_000,
  })
  return JSON.parse(raw || '[]')
}

function sqliteTableNames(databasePath) {
  return sqliteRows(
    databasePath,
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;",
  ).map((row) => row.name)
}

function safeJSON(raw, fallback) {
  try {
    return raw ? JSON.parse(raw) : fallback
  } catch {
    return fallback
  }
}

function attachmentIdentities(row) {
  const metadata = safeJSON(row.metadata, {})
  const direct = safeJSON(row.attachments, [])
  const attachments = Array.isArray(direct)
    ? direct
    : Array.isArray(metadata?.attachments)
      ? metadata.attachments
      : []
  return attachments
    .map((attachment) => (typeof attachment?.data === 'string' ? attachment.data.trim() : ''))
    .filter(Boolean)
}

function snapshotDatabase(databasePath) {
  const tables = new Set(sqliteTableNames(databasePath))
  if (!tables.has('messages')) return { ready: false, error: 'messages table is absent' }
  const messageColumns = new Set(
    sqliteRows(databasePath, 'PRAGMA table_info(messages);').map((row) => row.name),
  )
  const attachmentsColumn = messageColumns.has('attachments') ? 'attachments' : "'' AS attachments"
  const messages = sqliteRows(
    databasePath,
    `SELECT id,session_id,content,metadata,${attachmentsColumn} FROM messages WHERE role='user' ORDER BY created_at,id;`,
  )
  const stableAssetIDs = messages.flatMap(attachmentIdentities).filter((value) => value.startsWith('asset://'))
  const forbiddenPersisted = messages
    .flatMap(attachmentIdentities)
    .filter((value) => value.startsWith('blob:') || /\/api\/k12\/assets\//.test(value))
  const count = (table) =>
    tables.has(table)
      ? Number(sqliteRows(databasePath, `SELECT COUNT(*) AS total FROM "${table}";`)[0]?.total || 0)
      : 0
  const deliveryCounts = [...tables]
    .filter((name) => /delivery|receipt/i.test(name))
    .map((name) => ({ table: name, total: count(name) }))
  return {
    ready: true,
    userMessageCount: messages.length,
    stableAssetIDs,
    forbiddenPersisted,
    assetCount: count('k12_page_assets'),
    imageTaskCount: count('k12_image_task_dispatches'),
    imageTaskInvocationCount: count('k12_image_task_invocations'),
    deliveryCounts,
  }
}

function publicSnapshot(snapshot) {
  return {
    ...snapshot,
    stableAssetIDs: snapshot.stableAssetIDs?.map((value) => `sha256:${sha256(value)}`),
  }
}

async function readBody(request, maxBytes = 1024 * 1024) {
  const chunks = []
  let total = 0
  for await (const chunk of request) {
    total += chunk.length
    if (total > maxBytes) throw new Error('Fixture request body exceeded its limit')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function sendJSON(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    'Content-Type': 'application/json; charset=utf-8',
  })
  response.end(body)
}

async function startFixtureServer(databasePath) {
  const reportDeferred = deferred()
  const state = {
    phase: 'initial',
    stages: [],
    report: null,
    providerCalls: 0,
    externalTargets: [],
    unexpectedPaths: [],
  }
  const server = createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1')
    try {
      if (request.method === 'OPTIONS') {
        response.writeHead(204, {
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
          'Access-Control-Allow-Origin': '*',
        })
        response.end()
        return
      }
      if (request.method === 'GET' && url.pathname === '/__chat_asset/state') {
        sendJSON(response, 200, { phase: state.phase })
        return
      }
      if (request.method === 'GET' && url.pathname === '/__chat_asset/snapshot') {
        sendJSON(response, 200, snapshotDatabase(databasePath))
        return
      }
      if (request.method === 'POST' && url.pathname === '/__chat_asset/phase') {
        const body = safeJSON((await readBody(request)).toString('utf8'), {})
        assert.ok(['refresh', 'lifecycle', 'failure'].includes(body.phase), 'Unknown fixture phase')
        state.phase = body.phase
        sendJSON(response, 200, { accepted: true })
        return
      }
      if (request.method === 'POST' && url.pathname === '/__chat_asset/stage') {
        const body = safeJSON((await readBody(request)).toString('utf8'), {})
        assert.equal(typeof body.stage, 'string', 'Fixture stage is missing')
        state.stages.push({ ...body, receivedAt: new Date().toISOString() })
        sendJSON(response, 200, { accepted: true })
        return
      }
      if (request.method === 'POST' && url.pathname === '/__chat_asset/report') {
        const body = safeJSON((await readBody(request)).toString('utf8'), {})
        state.report = body
        reportDeferred.resolve(body)
        sendJSON(response, 200, { accepted: true })
        return
      }
      if (url.pathname.startsWith('/v1/')) {
        state.providerCalls += 1
        await readBody(request)
        sendJSON(response, 503, { error: { message: 'Provider access is forbidden in this test' } })
        return
      }
      if (request.method === 'GET' && url.pathname === '/__chat_asset/updater') {
        response.writeHead(204, { 'Access-Control-Allow-Origin': '*' })
        response.end()
        return
      }
      state.unexpectedPaths.push(`${request.method || 'GET'} ${url.pathname}`)
      sendJSON(response, 404, { error: 'Fixture route not found' })
    } catch (error) {
      if (!response.headersSent) {
        sendJSON(response, 500, { error: error instanceof Error ? error.message : String(error) })
      } else {
        response.destroy()
      }
    }
  })
  server.on('connect', (request, socket) => {
    state.externalTargets.push(String(request.url || '').slice(0, 200))
    socket.destroy()
  })
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object', 'Fixture did not bind a loopback port')
  return {
    origin: `http://127.0.0.1:${address.port}`,
    state,
    async waitForStage(stage, timeoutMs = 120_000) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const found = state.stages.find((entry) => entry.stage === stage)
        if (found) return found
        if (state.report?.status === 'FAIL') {
          throw new Error(`WebView failed before ${stage}: ${state.report.error}`)
        }
        await sleep(100)
      }
      throw new Error(`Timed out waiting for WebView stage: ${stage}`)
    },
    async waitForReport(timeoutMs = runTimeoutMs) {
      if (state.report) return state.report
      let timer
      try {
        return await Promise.race([
          reportDeferred.promise,
          new Promise((_, rejectTimeout) => {
            timer = setTimeout(() => rejectTimeout(new Error('WebView report timed out')), timeoutMs)
          }),
        ])
      } finally {
        clearTimeout(timer)
      }
    },
    async close() {
      server.closeAllConnections?.()
      await new Promise((resolveClose, rejectClose) =>
        server.close((error) => (error ? rejectClose(error) : resolveClose())),
      )
    },
  }
}

// fixture 在生产 bundle 之前安装审计钩子；它不构造 File/DataTransfer，也不发合成 drop。
function installedWebViewFixture() {
  'use strict'
  const config = globalThis.__CHAT_ASSET_PREVIEW_CONFIG__
  const fixtureOrigin = config.fixtureOrigin
  sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
  const originalFetch = globalThis.fetch.bind(globalThis)
  const originalCreateObjectURL = URL.createObjectURL.bind(URL)
  const originalRevokeObjectURL = URL.revokeObjectURL.bind(URL)
  const originalAbort = AbortController.prototype.abort
  const audit = {
    created: [],
    revoked: [],
    aborts: 0,
    heldAssetReads: [],
    assetReadStarts: 0,
    assetReadCompletions: 0,
    protectedImageAssignments: [],
    taskCreateAttempts: 0,
    taskCreateBlocked: 0,
    persistFailures: 0,
    failNextPersist: false,
    holdAssetReads: true,
  }
  globalThis.__CHAT_ASSET_PREVIEW_AUDIT__ = audit

  const sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds))
  const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim()
  const invariant = (condition, message) => {
    if (!condition) throw new Error(message)
  }
  const requestURL = (input) =>
    new URL(input instanceof Request ? input.url : String(input), location.href)
  const requestMethod = (input, init) =>
    String(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase()
  const requestSignal = (input, init) => init?.signal || (input instanceof Request ? input.signal : null)
  const apiPath = (input) => requestURL(input).pathname.replace(/^\/_hexclaw/, '')

  URL.createObjectURL = function createAuditedObjectURL(blob) {
    const url = originalCreateObjectURL(blob)
    audit.created.push({
      url,
      size: Number(blob?.size || 0),
      type: String(blob?.type || ''),
      nativeGrant: Boolean(blob && Object.prototype.hasOwnProperty.call(blob, 'nativeFileGrant')),
      nativeSize: Number(blob?.nativeSize || 0),
      nativeSourceSha256: typeof blob?.nativeSourceSha256 === 'string',
    })
    return url
  }
  URL.revokeObjectURL = function revokeAuditedObjectURL(url) {
    audit.revoked.push(String(url))
    return originalRevokeObjectURL(url)
  }
  AbortController.prototype.abort = function abortAuditedController(reason) {
    audit.aborts += 1
    return originalAbort.call(this, reason)
  }

  function protectedAssetURL(value) {
    try {
      const parsed = new URL(String(value || ''), location.href)
      return /\/api\/k12\/assets\//.test(parsed.pathname)
    } catch {
      return false
    }
  }

  function inspectImages() {
    for (const image of document.querySelectorAll('img')) {
      const raw = image.getAttribute('src') || ''
      if (protectedAssetURL(raw)) audit.protectedImageAssignments.push(raw)
    }
  }
  new MutationObserver(inspectImages).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['src'],
    childList: true,
    subtree: true,
  })

  globalThis.fetch = async function auditedFetch(input, init) {
    const url = requestURL(input)
    if (url.origin === fixtureOrigin) return originalFetch(input, init)
    const path = apiPath(input)
    const method = requestMethod(input, init)
    if (method === 'POST' && path === '/api/k12/image-tasks') {
      audit.taskCreateAttempts += 1
      audit.taskCreateBlocked += 1
      return new Response(JSON.stringify({ error: 'ImageTask disabled by native boundary fixture' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (
      method === 'POST' &&
      /\/api\/v1\/sessions\/[^/]+\/messages$/.test(path) &&
      audit.failNextPersist
    ) {
      audit.failNextPersist = false
      audit.persistFailures += 1
      return new Response(JSON.stringify({ error: 'Deterministic persistence failure' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (method === 'GET' && /\/api\/k12\/assets\//.test(path)) {
      audit.assetReadStarts += 1
      if (audit.holdAssetReads) {
        return new Promise((resolveRead, rejectRead) => {
          const signal = requestSignal(input, init)
          const held = {
            released: false,
            async release() {
              if (held.released) return
              held.released = true
              signal?.removeEventListener('abort', onAbort)
              try {
                const response = await originalFetch(input, init)
                audit.assetReadCompletions += 1
                resolveRead(response)
              } catch (error) {
                rejectRead(error)
              }
            },
          }
          const onAbort = () => {
            if (held.released) return
            held.released = true
            rejectRead(new DOMException('Asset read aborted', 'AbortError'))
          }
          signal?.addEventListener('abort', onAbort, { once: true })
          audit.heldAssetReads.push(held)
        })
      }
      const response = await originalFetch(input, init)
      audit.assetReadCompletions += 1
      return response
    }
    return originalFetch(input, init)
  }

  async function json(path, init) {
    const response = await originalFetch(fixtureOrigin + path, { cache: 'no-store', ...init })
    if (!response.ok) throw new Error(`Fixture request failed: ${response.status} ${path}`)
    return response.json()
  }

  async function progress(stage, details = {}) {
    return json('/__chat_asset/stage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage, ...details }),
    })
  }

  async function phase(value) {
    return json('/__chat_asset/phase', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phase: value }),
    })
  }

  async function complete(report) {
    return json('/__chat_asset/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report),
    })
  }

  async function waitFor(read, label, timeout = 45_000, interval = 100) {
    const deadline = Date.now() + timeout
    let lastError = null
    while (Date.now() < deadline) {
      try {
        const value = await read()
        if (value) return value
      } catch (error) {
        lastError = error
      }
      await sleep(interval)
    }
    throw new Error(
      `Timed out waiting for ${label}${lastError instanceof Error ? `: ${lastError.message}` : ''}`,
    )
  }

  function enabledButton(root, matcher) {
    return [...root.querySelectorAll('button')].find(
      (button) => !button.disabled && matcher.test(clean(button.textContent)),
    )
  }

  function setTextControl(control, value) {
    invariant(
      control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement,
      'Expected a text control',
    )
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(control), 'value')
    invariant(typeof descriptor?.set === 'function', 'Native value setter is unavailable')
    descriptor.set.call(control, value)
    control.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }))
    control.dispatchEvent(new Event('change', { bubbles: true }))
  }

  function setEditable(control, value) {
    invariant(control instanceof HTMLElement && control.isContentEditable, 'Expected contenteditable')
    control.focus()
    control.textContent = value
    control.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }))
  }

  async function nav(id, readySelector) {
    const link = await waitFor(
      () => document.querySelector(`[data-nav-id="${id}"]`),
      `${id} navigation`,
    )
    link.click()
    return waitFor(() => document.querySelector(readySelector), `${id} view`)
  }

  async function createTutor() {
    await nav('agents', '.hc-agents__content')
    const templates = await waitFor(
      () => enabledButton(document, /模板库|Templates/i),
      'template catalog tab',
    )
    templates.click()
    const template = await waitFor(
      () =>
        [...document.querySelectorAll('button,article,div')].find(
          (node) => clean(node.textContent) === '作业辅导助手',
        ),
      'K12 tutor template',
    )
    template.click()
    const form = await waitFor(() => document.querySelector('.k12pf'), 'K12 profile form')
    setTextControl(form.querySelector('.k12pf__input'), config.childName)
    const triggers = form.querySelectorAll('.hc-select__trigger')
    invariant(triggers.length >= 2, 'K12 grade and semester controls are missing')
    triggers[0].click()
    const grade = await waitFor(
      () =>
        [...document.querySelectorAll('.hc-select__dropdown .hc-select__option')].find((node) =>
          clean(node.textContent).includes('五年级'),
        ),
      'fifth grade option',
    )
    grade.click()
    triggers[1].click()
    const semester = await waitFor(
      () =>
        [...document.querySelectorAll('.hc-select__dropdown .hc-select__option')].find((node) =>
          clean(node.textContent).includes('下学期'),
        ),
      'second semester option',
    )
    semester.click()
    const create = await waitFor(
      () => enabledButton(form, /^创建$|^Create$/i),
      'K12 create button',
    )
    create.click()
    await waitFor(() => !document.querySelector('.k12pf'), 'K12 profile form close')
    const mine = await waitFor(
      () => enabledButton(document, /我的智能体|My Agents/i),
      'my agents tab',
    )
    mine.click()
    const card = await waitFor(
      () =>
        [...document.querySelectorAll('.hc-cxcard')].find((node) =>
          clean(node.textContent).includes(config.childName),
        ),
      'created K12 card',
    )
    const enter = await waitFor(
      () => enabledButton(card, /进入辅导|Enter Tutoring/i),
      'enter tutoring button',
    )
    enter.click()
    await waitFor(() => document.querySelector('.k12enh-seg'), 'K12 chat enhancement')
    await waitFor(() => document.querySelector('.hc-composer'), 'K12 composer')
  }

  async function ensureK12Chat() {
    const current = document.querySelector('.k12enh-seg')
    if (current) return current
    await nav('chat', '.hc-chat')
    return waitFor(() => document.querySelector('.k12enh-seg'), 'restored K12 chat')
  }

  async function requestPhysicalDrop(label) {
    const composer = await waitFor(() => document.querySelector('.hc-composer'), 'composer drop target')
    const rect = composer.getBoundingClientRect()
    invariant(rect.width > 200 && rect.height > 60, 'Composer drop target is not measurable')
    await progress(label, {
      target: {
        viewportX: rect.left + Math.min(rect.width - 40, Math.max(120, rect.width * 0.72)),
        viewportY: rect.top + Math.min(rect.height - 24, Math.max(32, rect.height * 0.5)),
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        // WebKit screenY 在纵向副屏布局下使用与 AX/CGEvent 不同的原点，只作诊断，
        // 真实屏幕点由原生驱动通过 AXWebArea position + viewport point 计算。
        browserScreenX: window.screenX,
        browserScreenY: window.screenY,
      },
      devicePixelRatio: window.devicePixelRatio,
    })
  }

  function userMessages() {
    return [...document.querySelectorAll('[data-testid="chat-message-user"]')]
  }

  function userImage(message) {
    return message?.querySelector('.hc-msg__attachment-img') || null
  }

  async function waitForDecodedImage(message, label) {
    return waitFor(() => {
      const image = userImage(message)
      return image?.src?.startsWith('blob:') && image.complete && image.naturalWidth > 0 ? image : null
    }, label)
  }

  async function releaseHeldAssetReads() {
    const held = audit.heldAssetReads.filter((entry) => !entry.released)
    invariant(held.length > 0, 'No authenticated asset read is pending')
    audit.holdAssetReads = false
    await Promise.all(held.map((entry) => entry.release()))
  }

  function assertSnapshot(snapshot, expectedMessages) {
    invariant(snapshot.ready, snapshot.error || 'SQLite snapshot is unavailable')
    invariant(snapshot.userMessageCount === expectedMessages, 'Unexpected persisted user message count')
    invariant(snapshot.stableAssetIDs.length === expectedMessages, 'Every persisted image needs one asset identity')
    invariant(new Set(snapshot.stableAssetIDs).size === 1, 'Edited resend changed the immutable asset identity')
    invariant(snapshot.forbiddenPersisted.length === 0, 'Temporary or protected URL was persisted')
    invariant(snapshot.imageTaskCount === 0, 'ImageTask was created by the no-model boundary')
    invariant(snapshot.imageTaskInvocationCount === 0, 'ImageTask Provider invocation was persisted')
    invariant(snapshot.deliveryCounts.every((entry) => entry.total === 0), 'IM delivery state was created')
  }

  async function initialRun() {
    await createTutor()
    const before = userMessages().length
    await requestPhysicalDrop('native-drop-success-ready')
    const message = await waitFor(
      () => (userMessages().length === before + 1 ? userMessages().at(-1) : null),
      'native-dropped user message',
      90_000,
    )
    const pendingImage = await waitForDecodedImage(message, 'decodable pending local Blob preview')
    const pendingURL = pendingImage.src
    const nativePreview = audit.created.find(
      (entry) => entry.nativeGrant && entry.size === config.imageBytes,
    )
    invariant(nativePreview, 'Native grant did not produce the real local Blob preview bytes')
    invariant(audit.heldAssetReads.some((entry) => !entry.released), 'Authenticated asset read was not delayed')
    invariant(audit.protectedImageAssignments.length === 0, 'Protected asset URL reached an img element')
    await releaseHeldAssetReads()
    const authenticatedImage = await waitFor(() => {
      const image = userImage(message)
      return image?.src?.startsWith('blob:') && image.src !== pendingURL && image.naturalWidth > 0
        ? image
        : null
    }, 'authenticated Object URL replacement')
    invariant(audit.revoked.includes(pendingURL), 'Replaced local preview URL was not revoked')
    authenticatedImage.click()
    const zoom = await waitFor(() => document.querySelector('.hc-img-preview__img'), 'zoom preview')
    invariant(zoom.src === authenticatedImage.src, 'Zoom did not reuse the authenticated Object URL')
    document.querySelector('.hc-img-preview__close')?.click()
    await waitFor(() => !document.querySelector('.hc-img-preview__backdrop'), 'zoom close')

    const download = [...message.querySelectorAll('button')].find((button) =>
      /下载图片|Download image/i.test(
        `${button.getAttribute('aria-label') || ''} ${button.getAttribute('title') || ''}`,
      ),
    )
    invariant(download, 'Authenticated user image has no download action')
    await progress('download-dialog-opening')
    download.click()
    await waitFor(
      () => [...document.querySelectorAll('[role="status"],.hc-toast')].some((node) => /已保存到|Saved to/i.test(clean(node.textContent))),
      'native download success receipt',
      60_000,
    )
    const snapshot = await json('/__chat_asset/snapshot')
    assertSnapshot(snapshot, 1)
    await phase('refresh')
    location.reload()
  }

  async function refreshRun() {
    audit.holdAssetReads = false
    await ensureK12Chat()
    const first = await waitFor(() => userMessages()[0], 'reloaded user message')
    const firstImage = await waitForDecodedImage(first, 'reloaded authenticated image')
    invariant(audit.protectedImageAssignments.length === 0, 'Reload exposed a protected asset URL')

    const edit = await waitFor(
      () => first.querySelector('[aria-label="编辑消息"],[aria-label="Edit message"]'),
      'edit message action',
    )
    edit.click()
    const editImage = await waitFor(() => first.querySelector('.hc-msg__edit-att-img'), 'edit image')
    invariant(editImage.src === firstImage.src, 'Edit did not reuse the authenticated Object URL')
    const editor = await waitFor(() => first.querySelector('[contenteditable="true"]'), 'edit composer')
    setEditable(editor, config.editMarker)
    const send = await waitFor(
      () => first.querySelector('.hc-msg__edit-btn--send:not(:disabled)'),
      'edit resend button',
    )
    send.click()
    await waitFor(() => userMessages().length === 2, 'edited resend user message', 90_000)
    const second = userMessages()[1]
    await waitForDecodedImage(second, 'edited resend image')
    const snapshot = await json('/__chat_asset/snapshot')
    assertSnapshot(snapshot, 2)
    invariant(snapshot.assetCount === 1, 'Content-addressed resend duplicated the immutable asset')

    const activeURLs = [...document.querySelectorAll('.hc-msg__attachment-img')]
      .map((image) => image.src)
      .filter((url) => url.startsWith('blob:'))
    await nav('agents', '.hc-agents__content')
    await waitFor(
      () => activeURLs.every((url) => audit.revoked.includes(url)),
      'Object URL revocation on route removal',
    )
    await phase('lifecycle')
    location.reload()
  }

  async function lifecycleRun() {
    audit.holdAssetReads = true
    await ensureK12Chat()
    await waitFor(
      () => audit.heldAssetReads.some((entry) => !entry.released),
      'pending authenticated read',
    )
    const abortsBefore = audit.aborts
    await nav('agents', '.hc-agents__content')
    await waitFor(() => audit.aborts > abortsBefore, 'asset read abort on route removal')
    invariant(audit.protectedImageAssignments.length === 0, 'Lifecycle path exposed a protected asset URL')
    await phase('failure')
    location.reload()
  }

  async function failureRun() {
    audit.holdAssetReads = false
    await ensureK12Chat()
    await waitForDecodedImage(await waitFor(() => userMessages()[0], 'restored first image'), 'restored first image decode')
    await waitForDecodedImage(await waitFor(() => userMessages()[1], 'restored second image'), 'restored second image decode')
    const before = await json('/__chat_asset/snapshot')
    assertSnapshot(before, 2)
    const taskAttemptsBefore = audit.taskCreateAttempts
    const persistsBefore = audit.persistFailures
    audit.failNextPersist = true
    await requestPhysicalDrop('native-drop-persist-failure-ready')
    await waitFor(() => audit.persistFailures === persistsBefore + 1, 'deterministic persistence failure', 90_000)
    await sleep(800)
    const after = await json('/__chat_asset/snapshot')
    assertSnapshot(after, 2)
    invariant(after.assetCount === before.assetCount, 'Idempotent failed resend duplicated the asset')
    invariant(audit.taskCreateAttempts === taskAttemptsBefore, 'Persistence failure attempted ImageTask creation')
    invariant(userMessages().length === 2, 'Failed optimistic image message remained visible')
    invariant(audit.protectedImageAssignments.length === 0, 'Failure path exposed a protected asset URL')
    await complete({
      status: 'DIAGNOSTIC_ONLY',
      acceptance: ['K12-ASSET-PREVIEW-AUTH-001', 'DESKTOP-BOUNDARY-FILE-010'],
      nativeGrantObserved: audit.created.some((entry) => entry.nativeGrant),
      pendingBlobBytesObserved: audit.created.some(
        (entry) => entry.nativeGrant && entry.size === config.imageBytes,
      ),
      authenticatedReads: audit.assetReadCompletions,
      objectURLsCreated: audit.created.length,
      objectURLsRevoked: new Set(audit.revoked).size,
      aborts: audit.aborts,
      protectedImageAssignments: audit.protectedImageAssignments.length,
      taskCreateAttempts: audit.taskCreateAttempts,
      taskCreateBlocked: audit.taskCreateBlocked,
      persistenceFailureTaskDelta: audit.taskCreateAttempts - taskAttemptsBefore,
      finalSnapshot: {
        ...after,
        stableAssetIDs: after.stableAssetIDs.map(() => '<stable-asset-redacted>'),
      },
    })
  }

  async function execute() {
    const state = await json('/__chat_asset/state')
    if (state.phase === 'initial') return initialRun()
    if (state.phase === 'refresh') return refreshRun()
    if (state.phase === 'lifecycle') return lifecycleRun()
    if (state.phase === 'failure') return failureRun()
    throw new Error(`Unknown native boundary phase: ${state.phase}`)
  }

  execute().catch(async (error) => {
    try {
      await complete({
        status: 'FAIL',
        error: error instanceof Error ? error.message : String(error),
        diagnostic: {
          phase: (await json('/__chat_asset/state')).phase,
          pathname: location.pathname,
          userMessages: userMessages().length,
          createdObjectURLs: audit.created.length,
          revokedObjectURLs: new Set(audit.revoked).size,
          assetReadStarts: audit.assetReadStarts,
          assetReadCompletions: audit.assetReadCompletions,
          taskCreateAttempts: audit.taskCreateAttempts,
          persistFailures: audit.persistFailures,
          protectedImageAssignments: audit.protectedImageAssignments.length,
        },
      })
    } catch {
      // 主进程会保留超时与 App 日志。
    }
  })
}

// Finder 选中行必须产生真实 CGEvent drag；不允许用 DataTransfer 或脚本合成 drop 替代。
function nativeFinderDragSwift() {
  return String.raw`
import AppKit
import ApplicationServices
import Foundation

enum DriverFailure: Error, CustomStringConvertible {
    case invalid(String)
    var description: String {
        switch self { case .invalid(let value): return value }
    }
}

func attribute(_ element: AXUIElement, _ name: CFString) -> AnyObject? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name, &value) == .success else { return nil }
    return value
}

func stringAttribute(_ element: AXUIElement, _ name: CFString) -> String? {
    return attribute(element, name) as? String
}

func pointAttribute(_ element: AXUIElement, _ name: CFString) -> CGPoint? {
    guard let value = attribute(element, name) else { return nil }
    var point = CGPoint.zero
    return AXValueGetValue(value as! AXValue, .cgPoint, &point) ? point : nil
}

func sizeAttribute(_ element: AXUIElement, _ name: CFString) -> CGSize? {
    guard let value = attribute(element, name) else { return nil }
    var size = CGSize.zero
    return AXValueGetValue(value as! AXValue, .cgSize, &size) ? size : nil
}

func children(_ element: AXUIElement) -> [AXUIElement] {
    return (attribute(element, kAXChildrenAttribute as CFString) as? [AXUIElement]) ?? []
}

func walk(_ root: AXUIElement, limit: Int = 5000) -> [AXUIElement] {
    var queue = [root]
    var result: [AXUIElement] = []
    while !queue.isEmpty && result.count < limit {
        let current = queue.removeFirst()
        result.append(current)
        queue.append(contentsOf: children(current))
    }
    return result
}

func selectedFinderElement(pid: pid_t, leaf: String) throws -> AXUIElement {
    let root = AXUIElementCreateApplication(pid)
    for element in walk(root) {
        if let selected = attribute(element, kAXSelectedRowsAttribute as CFString) as? [AXUIElement],
           let first = selected.first {
            return first
        }
    }
    let matches = walk(root).filter { element in
        let values = [
            stringAttribute(element, kAXTitleAttribute as CFString),
            stringAttribute(element, kAXValueAttribute as CFString),
            stringAttribute(element, kAXDescriptionAttribute as CFString),
        ].compactMap { $0 }
        return values.contains { $0 == leaf || $0.contains(leaf) }
            && pointAttribute(element, kAXPositionAttribute as CFString) != nil
            && sizeAttribute(element, kAXSizeAttribute as CFString) != nil
    }
    guard let best = matches.min(by: {
        let lhs = sizeAttribute($0, kAXSizeAttribute as CFString) ?? .zero
        let rhs = sizeAttribute($1, kAXSizeAttribute as CFString) ?? .zero
        return lhs.width * lhs.height < rhs.width * rhs.height
    }) else {
        throw DriverFailure.invalid("Finder selected item was not found")
    }
    return best
}

func role(_ element: AXUIElement) -> String {
    return stringAttribute(element, kAXRoleAttribute as CFString) ?? ""
}

func appWindow(pid: pid_t, viewportWidth: CGFloat, viewportHeight: CGFloat) throws -> (AXUIElement, CGPoint, CGSize) {
    let root = AXUIElementCreateApplication(pid)
    let candidates = walk(root).compactMap { element -> (AXUIElement, CGPoint, CGSize, Double)? in
        guard let position = pointAttribute(element, kAXPositionAttribute as CFString),
              let size = sizeAttribute(element, kAXSizeAttribute as CFString),
              role(element) == "AXWindow",
              size.width >= viewportWidth - 4,
              size.height >= viewportHeight - 4,
              size.width <= viewportWidth + 120,
              size.height <= viewportHeight + 240 else { return nil }
        let delta = abs(size.width - viewportWidth) + abs(size.height - viewportHeight)
        return (element, position, size, Double(delta))
    }
    guard let best = candidates.min(by: { $0.3 < $1.3 }) else {
        throw DriverFailure.invalid("Test.app AXWindow was not found")
    }
    return (best.0, best.1, best.2)
}

func activeDisplayContains(_ point: CGPoint) -> Bool {
    var count: UInt32 = 0
    guard CGGetActiveDisplayList(0, nil, &count) == .success else { return false }
    var displays = Array(repeating: CGDirectDisplayID(), count: Int(count))
    guard CGGetActiveDisplayList(count, &displays, &count) == .success else { return false }
    return displays.prefix(Int(count)).contains { CGDisplayBounds($0).contains(point) }
}

func hitElement(_ point: CGPoint) -> (AXUIElement, pid_t)? {
    let system = AXUIElementCreateSystemWide()
    var element: AXUIElement?
    guard AXUIElementCopyElementAtPosition(system, Float(point.x), Float(point.y), &element) == .success,
          let element else { return nil }
    var pid: pid_t = 0
    guard AXUIElementGetPid(element, &pid) == .success else { return nil }
    return (element, pid)
}

func post(_ type: CGEventType, _ point: CGPoint, _ button: CGMouseButton = .left) throws {
    guard let source = CGEventSource(stateID: .hidSystemState),
          let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: button) else {
        throw DriverFailure.invalid("CGEvent creation failed")
    }
    event.post(tap: .cghidEventTap)
}

func drag(from start: CGPoint, to target: CGPoint) throws {
    try post(.mouseMoved, start)
    usleep(180_000)
    try post(.leftMouseDown, start)
    usleep(180_000)
    for step in 1...36 {
        let ratio = CGFloat(step) / 36.0
        let point = CGPoint(
            x: start.x + (target.x - start.x) * ratio,
            y: start.y + (target.y - start.y) * ratio
        )
        try post(.leftMouseDragged, point)
        usleep(25_000)
    }
    usleep(220_000)
    try post(.leftMouseUp, target)
}

do {
    let args = CommandLine.arguments
    guard args.count == 8,
          let appPIDValue = Int32(args[2]),
          let viewportX = Double(args[3]),
          let viewportY = Double(args[4]),
          let viewportWidth = Double(args[5]),
          let viewportHeight = Double(args[6]),
          args[7] == "physical-finder-drop" else {
        throw DriverFailure.invalid("Usage: finder-drag <leaf> <app-pid> <viewport-x> <viewport-y> <viewport-width> <viewport-height> physical-finder-drop")
    }
    guard AXIsProcessTrusted() else {
        throw DriverFailure.invalid("Accessibility permission is required for physical Finder drag")
    }
    guard let finder = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.finder").first else {
        throw DriverFailure.invalid("Finder is not running")
    }
    let element = try selectedFinderElement(pid: finder.processIdentifier, leaf: args[1])
    guard let position = pointAttribute(element, kAXPositionAttribute as CFString),
          let size = sizeAttribute(element, kAXSizeAttribute as CFString),
          size.width > 0, size.height > 0 else {
        throw DriverFailure.invalid("Finder item bounds are unavailable")
    }
    let start = CGPoint(x: position.x + min(max(size.width * 0.25, 12), 42), y: position.y + size.height * 0.5)
    let viewport = try appWindow(
        pid: appPIDValue,
        viewportWidth: CGFloat(viewportWidth),
        viewportHeight: CGFloat(viewportHeight)
    )
    let horizontalInset = max(0, (viewport.2.width - CGFloat(viewportWidth)) / 2)
    let verticalInset = max(0, viewport.2.height - CGFloat(viewportHeight))
    let contentOrigin = CGPoint(
        x: viewport.1.x + horizontalInset,
        y: viewport.1.y + verticalInset
    )
    let target = CGPoint(x: contentOrigin.x + viewportX, y: contentOrigin.y + viewportY)
    guard activeDisplayContains(target) else {
        throw DriverFailure.invalid("AX-derived drop target is outside every active display")
    }
    let targetHit = hitElement(target)
    let targetHitPID = targetHit?.1 ?? -1
    let targetHitRole = targetHit.map { role($0.0) } ?? ""
    guard let targetHit, targetHit.1 == appPIDValue else {
        throw DriverFailure.invalid(
            "Drop target does not hit Test.app: target=\(target), hitPID=\(targetHitPID), hitRole=\(targetHitRole)"
        )
    }
    try drag(from: start, to: target)
    let output: [String: Any] = [
        "status": "PASS",
        "sourceLeaf": args[1],
        "source": ["x": start.x, "y": start.y],
        "target": ["x": target.x, "y": target.y],
        "sourceElement": [
            "role": role(element),
            "title": stringAttribute(element, kAXTitleAttribute as CFString) ?? "",
            "x": position.x,
            "y": position.y,
            "width": size.width,
            "height": size.height,
        ],
        "targetHit": [
            "pid": targetHit.1,
            "role": role(targetHit.0),
            "title": stringAttribute(targetHit.0, kAXTitleAttribute as CFString) ?? "",
        ],
        "viewport": [
            "role": role(viewport.0),
            "x": viewport.1.x,
            "y": viewport.1.y,
            "width": viewport.2.width,
            "height": viewport.2.height,
        ],
        "contentOrigin": ["x": contentOrigin.x, "y": contentOrigin.y],
        "contentInsets": ["x": horizontalInset, "top": verticalInset],
        "transform": "AXWindow content origin + DOM viewport point (macOS points, no Retina scaling)",
        "event": "CGEvent.leftMouseDragged",
    ]
    let data = try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
    print(String(data: data, encoding: .utf8)!)
} catch {
    fputs("\(error)\n", stderr)
    exit(1)
}
`
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
compaction:
  enabled: false
skill:
  sandbox:
    enabled: false
  builtin:
    search: false
    weather: false
    browser: false
    code: false
    shell: false
    code_exec: false
    file_ops: false
observe:
  log_level: info
  metrics:
    enabled: false
`
}

async function prepareFrontend(sandbox, fixtureOrigin, imageBytes) {
  const frontend = join(sandbox, 'frontend')
  await runCommand('pnpm', ['exec', 'vite', 'build', '--outDir', frontend, '--emptyOutDir'], {
    env: { ...process.env, PNPM_CONFIG_OFFLINE: 'true', npm_config_offline: 'true' },
  })
  const indexPath = join(frontend, 'index.html')
  assert.ok(existsSync(indexPath), 'Current-source frontend build is missing')
  const fixturePath = join(frontend, 'chat-asset-preview-auth-fixture.js')
  const config = {
    fixtureOrigin,
    imageBytes,
    childName: `NativeAsset-${Date.now().toString(36)}`,
    editMarker: `native-edit-${Date.now().toString(36)}`,
  }
  writeFileSync(
    fixturePath,
    `globalThis.__CHAT_ASSET_PREVIEW_CONFIG__=${JSON.stringify(config)};\n(${installedWebViewFixture.toString()})();\n`,
    { mode: 0o600 },
  )
  const index = readFileSync(indexPath, 'utf8')
  assert.match(index, /<head>/, 'Frontend index has no head element')
  writeFileSync(
    indexPath,
    index.replace(
      '<head>',
      '<head>\n<script src="./chat-asset-preview-auth-fixture.js"></script>',
    ),
    { mode: 0o600 },
  )
  return { frontend, fixturePath, indexPath }
}

function writeOverlay(sandbox, frontend, sidecarPort, fixtureOrigin) {
  const overlayPath = join(sandbox, 'tauri.chat-asset-preview-auth.conf.json')
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
    build: { frontendDist: relative(srcTauriDir, frontend), beforeBuildCommand: '' },
    app: {
      windows: [
        {
          label: 'main',
          title: productName,
          width: 1280,
          height: 820,
          minWidth: 900,
          minHeight: 600,
          visible: true,
        },
      ],
      security: { csp },
    },
    bundle: { targets: ['app'], createUpdaterArtifacts: false },
    plugins: {
      updater: {
        endpoints: [`${fixtureOrigin}/__chat_asset/updater`],
        dangerousInsecureTransportProtocol: true,
      },
    },
  }
  writeFileSync(overlayPath, `${JSON.stringify(overlay, null, 2)}\n`, { mode: 0o600 })
  return overlayPath
}

function appEnvironment(sandbox, tempDir, sidecarPort) {
  return {
    PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: 'zh_CN.UTF-8',
    HOME: sandbox,
    USERPROFILE: sandbox,
    CFFIXED_USER_HOME: sandbox,
    TMPDIR: tempDir,
    TEMP: tempDir,
    TMP: tempDir,
    HEXCLAW_TEST_MODE: '1',
    HEXCLAW_TEST_HOME: sandbox,
    HEXCLAW_SIDECAR_PORT: String(sidecarPort),
    HEXCLAW_TEST_LLM_CONFIG_MODE: 'preseeded-owner-yaml',
    HEXCLAW_TEST_PROFILE_CATCHUP: '0',
    HEXCLAW_TEST_ALLOW_AUTO_LOCAL_OLLAMA: '0',
    HEXCLAW_DISABLE_BACKGROUND_EGRESS: '1',
    NO_PROXY: '*',
    no_proxy: '*',
  }
}

function compileFinderDriver(sandbox) {
  const sourcePath = join(sandbox, 'finder-native-drag.swift')
  const executable = join(sandbox, 'finder-native-drag')
  writeFileSync(sourcePath, nativeFinderDragSwift(), { mode: 0o600 })
  execFileSync('/usr/bin/xcrun', ['swiftc', sourcePath, '-o', executable], {
    encoding: 'utf8',
    timeout: 60_000,
  })
  chmodSync(executable, 0o700)
  return executable
}

function openOwnedFinderWindow(sourcePath, target, appPID) {
  const placeLeft = Number(target.viewportX) > Number(target.viewportWidth) * 0.5
  const bounds = placeLeft ? '{20, 80, 420, 700}' : '{1000, 80, 1400, 700}'
  const script = `
on run argv
  set sourceItem to POSIX file (item 1 of argv) as alias
  set appPid to (item 2 of argv) as integer
  tell application "System Events"
    set frontmost of first application process whose unix id is appPid to true
  end tell
  delay 0.5
  tell application "Finder"
    set parentFolder to container of sourceItem
    set ownedWindow to make new Finder window to parentFolder
    set current view of ownedWindow to list view
    set bounds of ownedWindow to ${bounds}
    select sourceItem
    activate
    delay 0.8
    return id of ownedWindow as string
  end tell
end run`
  const result = execFileSync(
    '/usr/bin/osascript',
    ['-e', script, '--', sourcePath, String(appPID)],
    {
    encoding: 'utf8',
    timeout: 20_000,
    },
  ).trim()
  assert.match(result, /^\d+$/, 'Owned Finder window ID is invalid')
  return Number(result)
}

function closeOwnedFinderWindow(windowID) {
  if (!Number.isInteger(windowID)) return
  const script = `
on run argv
  set targetID to (item 1 of argv) as integer
  tell application "Finder"
    if exists (first Finder window whose id is targetID) then close (first Finder window whose id is targetID)
  end tell
end run`
  execFileSync('/usr/bin/osascript', ['-e', script, '--', String(windowID)], {
    encoding: 'utf8',
    timeout: 10_000,
  })
}

function performPhysicalFinderDrop(driver, appPID, stage) {
  const target = stage.target
  for (const key of ['viewportX', 'viewportY', 'viewportWidth', 'viewportHeight']) {
    assert.ok(Number.isFinite(target?.[key]), `Drop target ${key} is invalid`)
  }
  let finderWindowID = null
  try {
    finderWindowID = openOwnedFinderWindow(imagePath, target, appPID)
    const raw = execFileSync(
      driver,
      [
        basename(imagePath),
        String(appPID),
        String(target.viewportX),
        String(target.viewportY),
        String(target.viewportWidth),
        String(target.viewportHeight),
        'physical-finder-drop',
      ],
      { encoding: 'utf8', timeout: 30_000 },
    )
    const receipt = JSON.parse(raw)
    assert.equal(receipt.status, 'PASS', 'Finder drag driver did not pass')
    assert.equal(receipt.event, 'CGEvent.leftMouseDragged', 'Finder drag was not physical')
    return receipt
  } finally {
    closeOwnedFinderWindow(finderWindowID)
  }
}

function automateSaveDialog(appPID, targetPath) {
  const targetDirectory = dirname(targetPath)
  const script = `
on run argv
  set targetPid to (item 1 of argv) as integer
  set targetDirectory to item 2 of argv
  set savedClipboard to the clipboard
  try
    set the clipboard to targetDirectory
    tell application "System Events"
      set targetProcess to first application process whose unix id is targetPid
      set frontmost of targetProcess to true
      delay 0.6
      keystroke "g" using {command down, shift down}
      delay 0.4
      keystroke "a" using {command down}
      keystroke "v" using {command down}
      delay 0.3
      key code 36
      delay 0.8
      key code 36
    end tell
    set the clipboard to savedClipboard
    return "saved-and-clipboard-restored"
  on error errorMessage number errorNumber
    try
      set the clipboard to savedClipboard
    end try
    error errorMessage number errorNumber
  end try
end run`
  const result = execFileSync(
    '/usr/bin/osascript',
    ['-e', script, '--', String(appPID), targetDirectory],
    {
      encoding: 'utf8',
      timeout: 30_000,
    },
  ).trim()
  assert.equal(
    result,
    'saved-and-clipboard-restored',
    'Native Save panel automation did not restore the clipboard',
  )
}

function sanitizeLog(raw, sandbox) {
  return raw
    .replaceAll(syntheticCredential, '[REDACTED]')
    .replaceAll(repoRoot, '<desktop-repo>')
    .replaceAll(sidecarRoot, '<sidecar-repo>')
    .replaceAll(sandbox, '<test-home>')
    .replaceAll(process.env.HOME || '<no-home>', '<user-home>')
}

async function runInstalledSidecarAPIPartial() {
  assert.equal(process.platform, 'darwin', 'Installed Sidecar API boundary is macOS-only')
  assert.ok(existsSync(imagePath), 'Selected K12 image fixture is missing')
  assert.ok(existsSync(installedSidecarExecutable), 'Installed candidate Sidecar is missing')
  mkdirSync(evidenceRoot, { recursive: true })
  const runDir = join(evidenceRoot, `api-only-${Date.now()}`)
  mkdirSync(runDir, { recursive: true, mode: 0o700 })
  const sandbox = mkdtempSync(join(tmpdir(), 'hexclaw-chat-asset-api.'))
  const configDir = join(sandbox, '.hexclaw')
  const tempDir = join(sandbox, 'tmp')
  for (const directory of [configDir, tempDir]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    chmodSync(directory, 0o700)
  }
  const databasePath = join(configDir, 'data.db')
  const sidecarPort = await reserveLoopbackPort()
  writeFileSync(
    join(configDir, 'hexclaw.yaml'),
    renderConfig(sandbox, sidecarPort, 'http://127.0.0.1:1'),
    { mode: 0o600 },
  )
  const rawLogPath = join(sandbox, 'sidecar.log')
  const rawLog = createWriteStream(rawLogPath, { flags: 'wx', mode: 0o600 })
  let sidecar = null
  let failure = null
  let restarted = false
  const start = async () => {
    const processHandle = spawn(installedSidecarExecutable, ['serve', '--desktop'], {
      cwd: sandbox,
      env: appEnvironment(sandbox, tempDir, sidecarPort),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    processHandle.stdout.pipe(rawLog, { end: false })
    processHandle.stderr.pipe(rawLog, { end: false })
    await waitForHealth(sidecarPort, processHandle)
    return processHandle
  }
  const api = async (path, init = {}) => {
    const response = await fetch(`http://127.0.0.1:${sidecarPort}${path}`, {
      ...init,
      signal: AbortSignal.timeout(30_000),
    })
    const bytes = Buffer.from(await response.arrayBuffer())
    if (!response.ok) {
      throw new Error(`${init.method || 'GET'} ${path}: ${response.status} ${bytes.toString('utf8')}`)
    }
    return { response, bytes }
  }
  try {
    sidecar = await start()
    const agent = `native-asset-api-${Date.now().toString(36)}`
    await api('/api/v1/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: agent,
        display_name: 'Native Asset API Boundary',
        provider: '',
        model: '',
        metadata: {
          scenario: 'k12-tutor',
          'k12.learner_id': `${agent}-learner`,
          'k12.child_name': 'Native Asset API',
          'k12.grade_term': '五年级下',
        },
      }),
    })
    const imageBytes = readFileSync(imagePath)
    const upload = async () => {
      const form = new FormData()
      form.append('file', new Blob([imageBytes], { type: 'image/png' }), basename(imagePath))
      const result = await api(`/api/k12/assets?agent=${encodeURIComponent(agent)}`, {
        method: 'POST',
        body: form,
      })
      return JSON.parse(result.bytes.toString('utf8'))
    }
    const first = await upload()
    const second = await upload()
    assert.match(first.asset_id, /^asset:\/\//, 'Asset upload returned no stable asset identity')
    assert.equal(second.asset_id, first.asset_id, 'Same bytes did not return the same asset identity')
    const file = first.asset_id.slice(first.asset_id.lastIndexOf('/') + 1)
    const initialRead = await api(
      `/api/k12/assets/${encodeURIComponent(file)}?agent=${encodeURIComponent(agent)}`,
    )
    assert.equal(sha256(initialRead.bytes), sha256(imageBytes), 'Authenticated asset read changed bytes')

    await stopProcess(sidecar)
    sidecar = await start()
    restarted = true
    const restartRead = await api(
      `/api/k12/assets/${encodeURIComponent(file)}?agent=${encodeURIComponent(agent)}`,
    )
    assert.equal(sha256(restartRead.bytes), sha256(imageBytes), 'Restart asset read changed bytes')
    const database = snapshotDatabase(databasePath)
    assert.equal(database.assetCount, 1, 'Idempotent upload created multiple asset rows')
    assert.equal(database.imageTaskCount, 0, 'API-only asset verification created an ImageTask')
    assert.equal(database.imageTaskInvocationCount, 0, 'API-only verification invoked a model')
    assert.ok(database.deliveryCounts.every((entry) => entry.total === 0), 'API-only verification created IM state')
    writeFileSync(
      join(runDir, 'api-partial.json'),
      `${JSON.stringify(
        {
          status: 'PARTIAL_PASS',
          overallInstalledGate: 'NOT_PASS',
          proven: [
            'Installed Sidecar exact bytes executed in an isolated Home and loopback port.',
            'Image upload returned one content-addressed identity for repeated bytes.',
            'Authenticated read returned exact bytes before and after Sidecar restart.',
            'ImageTask, model invocation, and IM delivery state remained zero.',
          ],
          notProven: [
            'Installed Desktop exact executable bytes were not launched.',
            'Finder physical drag, native grant, pending Blob preview, zoom, download, edit/resend, abort, and revoke were not exercised.',
          ],
          candidate: {
            installedDesktopSha256: sha256File(installedDesktopExecutable),
            installedSidecarSha256: sha256File(installedSidecarExecutable),
          },
          isolation: {
            temporaryHome: true,
            dedicatedLoopbackPort: sidecarPort,
            restarted,
            modelCalls: 0,
            imCalls: 0,
          },
          asset: {
            identitySha256: sha256(first.asset_id),
            sourceSha256: sha256(imageBytes),
            beforeRestartSha256: sha256(initialRead.bytes),
            afterRestartSha256: sha256(restartRead.bytes),
          },
          database: publicSnapshot(database),
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    )
    process.stdout.write(
      `Installed Sidecar API partial PASS; overall installed Desktop gate NOT PASS: ${relative(repoRoot, join(runDir, 'api-partial.json'))}\n`,
    )
  } catch (error) {
    failure = error
    throw error
  } finally {
    await stopProcess(sidecar)
    await new Promise((resolveClose) => rawLog.end(resolveClose))
    if (existsSync(rawLogPath)) {
      writeFileSync(join(runDir, 'api-sidecar.log'), sanitizeLog(readFileSync(rawLogPath, 'utf8'), sandbox), {
        mode: 0o600,
      })
    }
    const cleanup = {
      status: failure ? 'FAIL' : 'PARTIAL_PASS',
      portReleased: listenerPIDs(sidecarPort).length === 0,
      sandboxRemoved: false,
    }
    rmSync(sandbox, { recursive: true, force: true })
    cleanup.sandboxRemoved = !existsSync(sandbox)
    writeFileSync(join(runDir, 'api-cleanup.json'), `${JSON.stringify(cleanup, null, 2)}\n`, {
      mode: 0o600,
    })
    assert.equal(cleanup.portReleased, true, 'Installed Sidecar API port was not released')
  }
}

async function main() {
  assert.equal(process.platform, 'darwin', 'Native installed boundary is macOS-only')
  assert.equal(process.env.HEXCLAW_CHAT_ASSET_NATIVE_RUN, '1', 'Explicit native run opt-in is required')
  assert.ok(existsSync(imagePath), 'K12 image fixture is missing')
  assert.ok(existsSync(join(sidecarRoot, 'cmd/hexclaw')), 'Sidecar source root is missing')
  assert.ok(existsSync(installedDesktopExecutable), 'Installed candidate Desktop executable is missing')
  assert.ok(existsSync(installedSidecarExecutable), 'Installed candidate Sidecar is missing')

  mkdirSync(evidenceRoot, { recursive: true })
  const runDir = join(evidenceRoot, `run-${Date.now()}`)
  mkdirSync(runDir, { recursive: true, mode: 0o700 })
  const sandbox = mkdtempSync(join(tmpdir(), 'hexclaw-chat-asset-preview.'))
  chmodSync(sandbox, 0o700)
  const configDir = join(sandbox, '.hexclaw')
  const tempDir = join(sandbox, 'tmp')
  const cargoTarget = resolve(
    process.env.HEXCLAW_CHAT_ASSET_CARGO_TARGET || join(sandbox, 'cargo-target'),
  )
  const downloadDir = join(sandbox, 'downloads')
  for (const directory of [configDir, tempDir, downloadDir]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    chmodSync(directory, 0o700)
  }
  const databasePath = join(configDir, 'data.db')
  const sidecarPort = await reserveLoopbackPort()
  assert.deepEqual(listenerPIDs(sidecarPort), [], 'Dedicated Sidecar port is occupied')

  let fixture = null
  let appProcess = null
  let appBundle = ''
  let appLogStream = null
  let report = null
  let failure = null
  let finalStatus = 'FAIL'
  const physicalDropReceipts = []
  const appRawLog = join(sandbox, 'app.log')
  const cleanup = { portReleased: false, fixtureClosed: false, sandboxRemoved: false, unexpectedPortOwners: [] }

  try {
    fixture = await startFixtureServer(databasePath)
    writeFileSync(
      join(configDir, 'hexclaw.yaml'),
      renderConfig(sandbox, sidecarPort, fixture.origin),
      { mode: 0o600 },
    )
    const frontend = await prepareFrontend(sandbox, fixture.origin, readFileSync(imagePath).length)
    const overlay = writeOverlay(sandbox, frontend.frontend, sidecarPort, fixture.origin)
    const offlineEnv = {
      ...process.env,
      CARGO_NET_OFFLINE: 'true',
      CARGO_TARGET_DIR: cargoTarget,
      GOENV: 'off',
      GOPROXY: 'off',
      GOSUMDB: 'off',
      PNPM_CONFIG_OFFLINE: 'true',
      npm_config_offline: 'true',
    }
    delete offlineEnv.GOROOT
    await runCommand('pnpm', ['exec', 'tauri', 'build', '--config', overlay, '--bundles', 'app'], {
      env: offlineEnv,
    })
    appBundle = join(cargoTarget, `release/bundle/macos/${productName}.app`)
    const executable = join(appBundle, 'Contents/MacOS/hexclaw-desktop')
    const packagedSidecar = join(appBundle, 'Contents/MacOS/hexclaw')
    assert.ok(existsSync(executable), 'Temporary Test.app executable is missing')
    assert.ok(existsSync(packagedSidecar), 'Temporary Test.app Sidecar is missing')
    // Sidecar 使用最终安装候选的 exact bytes；临时 Test.app 只重编 Desktop 以注入审计前端。
    writeFileSync(packagedSidecar, readFileSync(installedSidecarExecutable), { mode: 0o755 })
    chmodSync(packagedSidecar, 0o755)
    const finderDriver = compileFinderDriver(sandbox)

    appLogStream = createWriteStream(appRawLog, { flags: 'wx', mode: 0o600 })
    appProcess = spawn(executable, [], {
      cwd: sandbox,
      env: appEnvironment(sandbox, tempDir, sidecarPort),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    appProcess.stdout.pipe(appLogStream, { end: false })
    appProcess.stderr.pipe(appLogStream, { end: false })
    await waitForHealth(sidecarPort, appProcess)

    const firstDrop = await fixture.waitForStage('native-drop-success-ready')
    const firstDropReceipt = performPhysicalFinderDrop(finderDriver, appProcess.pid, firstDrop)
    physicalDropReceipts.push(firstDropReceipt)
    writeFileSync(
      join(runDir, 'physical-drops.json'),
      `${JSON.stringify(physicalDropReceipts, null, 2)}\n`,
      { mode: 0o600 },
    )
    await fixture.waitForStage('download-dialog-opening')
    const downloadPath = join(downloadDir, basename(imagePath))
    automateSaveDialog(appProcess.pid, downloadPath)
    const failedDrop = await fixture.waitForStage('native-drop-persist-failure-ready')
    const failedDropReceipt = performPhysicalFinderDrop(finderDriver, appProcess.pid, failedDrop)
    physicalDropReceipts.push(failedDropReceipt)
    writeFileSync(
      join(runDir, 'physical-drops.json'),
      `${JSON.stringify(physicalDropReceipts, null, 2)}\n`,
      { mode: 0o600 },
    )
    report = await fixture.waitForReport()
    assert.equal(
      report.status,
      'DIAGNOSTIC_ONLY',
      report.error || 'WebView diagnostic boundary failed',
    )
    assert.ok(existsSync(downloadPath), 'Native image download output is missing')
    assert.equal(sha256File(downloadPath), sha256File(imagePath), 'Downloaded image bytes changed')
    assert.equal(fixture.state.providerCalls, 0, 'Model Provider was called')
    assert.deepEqual(fixture.state.externalTargets, [], 'External network target was observed')
    assert.deepEqual(fixture.state.unexpectedPaths, [], 'Unexpected fixture request was observed')
    const database = snapshotDatabase(databasePath)
    assert.equal(database.imageTaskCount, 0, 'ImageTask rows must remain zero')
    assert.equal(database.imageTaskInvocationCount, 0, 'ImageTask invocation rows must remain zero')
    assert.ok(database.deliveryCounts.every((entry) => entry.total === 0), 'IM delivery rows must remain zero')

    const evidence = {
      status: 'DIAGNOSTIC_ONLY',
      overallInstalledGate: 'NOT_PASS',
      installedExactBytesBoundary: {
        status: 'NOT_RUN',
        reason: 'The injected Test.app cannot prove the exact installed Desktop executable boundary.',
      },
      acceptance: ['K12-ASSET-PREVIEW-AUTH-001', 'DESKTOP-BOUNDARY-FILE-010'],
      isolation: {
        testHome: '<ephemeral-0700>',
        userHomeReadOrWritten: false,
        dedicatedSidecarPort: sidecarPort,
        userSidecarPortUsed: false,
        ollamaPortUsed: false,
        externalNetworkCalls: 0,
        modelCalls: fixture.state.providerCalls,
        imCalls: 0,
      },
      candidate: {
        installedBundle: '/Applications/HexClaw.app',
        installedDesktopSha256: sha256File(installedDesktopExecutable),
        installedSidecarSha256: sha256File(installedSidecarExecutable),
        frontendIndexSha256: sha256File(frontend.indexPath),
        fixtureSha256: sha256File(frontend.fixturePath),
        appExecutableSha256: sha256File(executable),
        sidecarExecutableSha256: sha256File(packagedSidecar),
        inputFixtureSha256: sha256File(imagePath),
      },
      native: {
        finderPhysicalDrops: [firstDropReceipt, failedDropReceipt],
        realTauriGrantObserved: report.nativeGrantObserved,
        nativePendingBlobBytesObserved: report.pendingBlobBytesObserved,
        nativeSystemSavePanel: true,
        downloadedSha256: sha256File(downloadPath),
      },
      webView: report,
      database: publicSnapshot(database),
    }
    writeFileSync(join(runDir, 'report.json'), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 })
    finalStatus = 'DIAGNOSTIC_ONLY'
    process.stdout.write(
      `Native chat asset preview auth diagnostic only (installed gate NOT PASS): ${relative(repoRoot, join(runDir, 'report.json'))}\n`,
    )
    process.exitCode = 2
  } catch (error) {
    failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    writeFileSync(
      join(runDir, 'failure.json'),
      `${JSON.stringify(
        {
          status: 'FAIL',
          error: failure,
          webView: report,
          physicalDropReceipts,
          fixture: fixture?.state || null,
          database: publicSnapshot(snapshotDatabase(databasePath)),
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    )
    throw error
  } finally {
    await stopProcess(appProcess)
    if (appLogStream) await new Promise((resolveClose) => appLogStream.end(resolveClose))
    const sidecarCleanup = appBundle
      ? await stopOwnedSidecar(sidecarPort, appBundle)
      : { unexpected: [], released: listenerPIDs(sidecarPort).length === 0 }
    cleanup.unexpectedPortOwners.push(...sidecarCleanup.unexpected)
    cleanup.portReleased = sidecarCleanup.released
    if (fixture) {
      await fixture.close()
      cleanup.fixtureClosed = true
    }
    if (existsSync(appRawLog)) {
      writeFileSync(join(runDir, 'app.log'), sanitizeLog(readFileSync(appRawLog, 'utf8'), sandbox), {
        mode: 0o600,
      })
    }
    rmSync(sandbox, { recursive: true, force: true })
    cleanup.sandboxRemoved = !existsSync(sandbox)
    writeFileSync(
      join(runDir, 'cleanup.json'),
      `${JSON.stringify({ status: finalStatus, error: failure, ...cleanup }, null, 2)}\n`,
      { mode: 0o600 },
    )
    assert.equal(cleanup.portReleased, true, 'Dedicated Sidecar port was not released')
    assert.deepEqual(cleanup.unexpectedPortOwners, [], 'Dedicated port had an unexpected owner')
  }
}

function validateHarness() {
  const entrySource = readFileSync(fileURLToPath(import.meta.url), 'utf8')
  assert.doesNotMatch(entrySource, /\/Users\//, 'Harness must not contain a personal absolute path')
  assert.doesNotMatch(entrySource, /\bdws\b|devops\.aliyun\.com/, 'Harness must not call an external IM tool')
  assert.match(entrySource, /HEXCLAW_TEST_MODE: '1'/, 'Test mode guard is missing')
  assert.match(entrySource, /HEXCLAW_TEST_HOME: sandbox/, 'Isolated Test Home is missing')
  assert.match(entrySource, /native-drop-success-ready/, 'Successful physical drop phase is missing')
  assert.match(entrySource, /native-drop-persist-failure-ready/, 'Persistence failure phase is missing')
  assert.match(entrySource, /CGEvent\.leftMouseDragged/, 'Physical Finder drag receipt is missing')
  assert.match(entrySource, /Authenticated user image has no download action/, 'Download gate is missing')
  assert.match(entrySource, /Edited resend changed the immutable asset identity/, 'Stable asset resend gate is missing')
  assert.match(entrySource, /Persistence failure attempted ImageTask creation/, 'Failure zero-task gate is missing')
  assert.match(entrySource, /Object URL revocation on route removal/, 'Object URL revoke gate is missing')
  assert.match(entrySource, /asset read abort on route removal/, 'Abort lifecycle gate is missing')
  assert.match(entrySource, /providerCalls, 0/, 'Zero-model assertion is missing')
  assert.match(entrySource, /deliveryCounts\.every/, 'Zero-IM receipt assertion is missing')
  assert.ok(existsSync(imagePath), 'Selected K12 image fixture is missing')
  assert.ok(existsSync(installedDesktopExecutable), 'Installed candidate Desktop executable is missing')
  assert.ok(existsSync(installedSidecarExecutable), 'Installed candidate Sidecar is missing')
  assert.ok(existsSync(join(repoRoot, 'src-tauri/src/native_file.rs')), 'Native grant implementation is missing')
  const swift = spawnSync('/usr/bin/xcrun', ['swiftc', '-typecheck', '-'], {
    input: nativeFinderDragSwift(),
    encoding: 'utf8',
    timeout: 60_000,
  })
  assert.equal(swift.status, 0, swift.stderr || 'Embedded Finder driver failed Swift typecheck')
  assert.match(renderConfig('/tmp/isolated-test-home', 23456, 'http://127.0.0.1:34567'), /enabled: false/)
  process.stdout.write('Native chat asset preview auth harness static validation PASS\n')
}

if (process.argv.includes('--api-only')) {
  runInstalledSidecarAPIPartial().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`)
    process.exitCode = 1
  })
} else if (process.argv.includes('--run')) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`)
    process.exitCode = 1
  })
} else {
  validateHarness()
}
