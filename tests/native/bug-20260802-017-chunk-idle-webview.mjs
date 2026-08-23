import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
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
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROVIDER_RELEASE_DELAY_MS = 65_000
const APP_PRODUCT_NAME = 'HexClaw Bug017 Test'
const APP_IDENTIFIER = 'com.hexclaw.desktop.bug017'
const USER_MARKER = 'BUG017_CURRENT_SOURCE_CHUNK_IDLE_USER'
const PARTIAL_MARKER = 'BUG017_CURRENT_SOURCE_PARTIAL'
const LATE_MARKER = 'BUG017_CURRENT_SOURCE_LATE_SUCCESS'
const ERROR_TEXT = 'WebSocket transport unavailable; retry will resume with the same request id'
const SYNTHETIC_API_TOKEN = 'bug017-loopback-api-token-0123456789abcdef'
const SYNTHETIC_PROVIDER_KEY = 'bug017-loopback-provider-key'

const nativeDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(nativeDir, '../..')
const hexclawRoot = resolve(repoRoot, '../hexclaw')
const srcTauriDir = join(repoRoot, 'src-tauri')
const fixtureSourcePath = join(nativeDir, 'bug-20260802-017-chunk-idle-webview-fixture.js')
const evidenceDir = join(repoRoot, 'test/evidence/bug-20260802-017-current-source')
const targetBundleDir = join(srcTauriDir, 'target/release/bundle/macos')
const appBundle = join(targetBundleDir, `${APP_PRODUCT_NAME}.app`)

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
}

function deferred() {
  let resolvePromise
  let rejectPromise
  const promise = new Promise((resolveDeferred, rejectDeferred) => {
    resolvePromise = resolveDeferred
    rejectPromise = rejectDeferred
  })
  return { promise, resolve: resolvePromise, reject: rejectPromise }
}

function fail(message) {
  throw new Error(message)
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function gitHead(root) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || `Unable to resolve git HEAD for ${root}`)
  return result.stdout.trim()
}

function writeJSON(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
}

function readSidecarFileLog(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

function sanitizeText(value, sandbox, fixtureOrigin = '') {
  return String(value || '')
    .replaceAll(sandbox, '<sandbox>')
    .replaceAll(repoRoot, '<repo>')
    .replaceAll(hexclawRoot, '<hexclaw>')
    .replaceAll(SYNTHETIC_API_TOKEN, '<synthetic-api-token>')
    .replaceAll(SYNTHETIC_PROVIDER_KEY, '<synthetic-provider-key>')
    .replaceAll(fixtureOrigin, '<fixture-origin>')
    .replace(new RegExp(`${sep === '\\' ? '[A-Za-z]:\\\\Users' : '/Users'}/[^/\\s]+`, 'g'), '<user-home>')
}

async function runCommand(command, args, options = {}) {
  const commandStartedAt = Date.now()
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
  const timeoutMs = options.timeoutMs || 20 * 60_000
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
          rejectTimeout(new Error(`${command} timed out after ${timeoutMs}ms`))
        }, timeoutMs)
      }),
    ])
    if (result.code !== 0) {
      fail(`${command} exited ${result.code ?? result.signal}\n${output.slice(-12_000)}`)
    }
    return {
      command,
      args,
      duration_ms: Date.now() - commandStartedAt,
      output,
    }
  } finally {
    clearTimeout(timer)
  }
}

function listenerPids(port) {
  const result = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
    encoding: 'utf8',
  })
  if (result.status !== 0 && result.status !== 1) {
    fail(`lsof failed for port ${port}: ${result.stderr || result.stdout}`)
  }
  return String(result.stdout || '')
    .split(/\s+/)
    .filter(Boolean)
    .map(Number)
}

function processCommand(pid) {
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' })
  return result.status === 0 ? String(result.stdout || '').trim() : ''
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
  return port
}

async function waitFor(read, timeoutMs, label, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const value = await read()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await sleep(intervalMs)
  }
  const suffix = lastError instanceof Error ? `: ${lastError.message}` : ''
  throw new Error(`${label} timed out${suffix}`)
}

function readBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')))
    request.on('error', rejectBody)
  })
}

function sendJSON(response, status, value) {
  response.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    connection: 'close',
  })
  response.end(JSON.stringify(value))
}

function openAIChunk(content, finishReason = null) {
  return {
    id: 'chatcmpl-bug017-loopback',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'bug017-mock-model',
    choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: finishReason }],
  }
}

async function startLoopbackFixture() {
  const initialReport = deferred()
  const restartReport = deferred()
  const providerReleased = deferred()
  const state = {
    started_at: Date.now(),
    origin: '',
    current_phase: 'initial',
    mode_requests: 0,
    updater_requests: 0,
    catalog_requests: 0,
    target_calls: [],
    auxiliary_provider_calls: [],
    blocked_external_requests: [],
    unexpected_paths: [],
    progress: [],
    reports: {},
    provider_released: false,
    release_timer: null,
  }

  const server = createServer(async (request, response) => {
    const rawURL = request.url || '/'
    if (request.method === 'CONNECT' || /^https?:\/\//i.test(rawURL)) {
      state.blocked_external_requests.push({ method: request.method, target: rawURL.slice(0, 300) })
      response.writeHead(502, { connection: 'close' })
      response.end()
      return
    }

    const requestURL = new URL(rawURL, state.origin || 'http://127.0.0.1')
    const path = requestURL.pathname
    if (request.method === 'OPTIONS' && path.startsWith('/__bug017__/')) {
      response.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
        connection: 'close',
      })
      response.end()
      return
    }
    if (request.method === 'GET' && path === '/__bug017__/updater') {
      state.updater_requests += 1
      response.writeHead(204, { 'access-control-allow-origin': '*', connection: 'close' })
      response.end()
      return
    }
    if (request.method === 'GET' && path === '/__bug017__/mode') {
      const phase = state.mode_requests === 0 ? 'initial' : 'restart'
      state.mode_requests += 1
      state.current_phase = phase
      sendJSON(response, 200, { phase })
      return
    }
    if (request.method === 'GET' && path === '/__bug017__/current-phase') {
      sendJSON(response, 200, { phase: state.current_phase })
      return
    }
    if (request.method === 'GET' && path === '/__bug017__/stats') {
      sendJSON(response, 200, {
        provider_released: state.provider_released,
        target_call_count: state.target_calls.length,
      })
      return
    }
    if (request.method === 'POST' && path === '/__bug017__/progress') {
      const payload = JSON.parse(await readBody(request))
      state.progress.push({ received_at_ms: Date.now() - state.started_at, ...payload })
      sendJSON(response, 200, { accepted: true })
      return
    }
    if (request.method === 'POST' && path === '/__bug017__/report') {
      const payload = JSON.parse(await readBody(request))
      state.reports[payload.phase] = payload
      if (payload.phase === 'initial') initialReport.resolve(payload)
      else if (payload.phase === 'restart') restartReport.resolve(payload)
      sendJSON(response, 200, { accepted: true })
      return
    }
    if (request.method === 'GET' && path === '/v1/models') {
      state.catalog_requests += 1
      sendJSON(response, 200, {
        object: 'list',
        data: [{ id: 'bug017-mock-model', object: 'model', owned_by: 'loopback-fixture' }],
      })
      return
    }
    if (request.method !== 'POST' || path !== '/v1/chat/completions') {
      state.unexpected_paths.push(`${request.method} ${path}`)
      sendJSON(response, 404, { error: { message: 'Fixture route not found' } })
      return
    }

    let payload
    try {
      payload = JSON.parse(await readBody(request))
    } catch (error) {
      sendJSON(response, 400, { error: { message: `Invalid fixture JSON: ${error.message}` } })
      return
    }
    const serializedMessages = JSON.stringify(payload.messages || [])
    const target = payload.stream === true && serializedMessages.includes(USER_MARKER)
    const safeReceipt = {
      received_at_ms: Date.now() - state.started_at,
      model: payload.model,
      stream: payload.stream === true,
      marker_present: serializedMessages.includes(USER_MARKER),
      authorization_present: typeof request.headers.authorization === 'string',
    }
    if (!target) {
      state.auxiliary_provider_calls.push(safeReceipt)
      if (payload.stream === true) {
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'close',
        })
        response.write(`data: ${JSON.stringify(openAIChunk('LOOPBACK_AUXILIARY_OK', 'stop'))}\n\n`)
        response.end('data: [DONE]\n\n')
      } else {
        sendJSON(response, 200, {
          id: 'chatcmpl-bug017-auxiliary',
          object: 'chat.completion',
          model: 'bug017-mock-model',
          choices: [{ index: 0, message: { role: 'assistant', content: 'LOOPBACK_AUXILIARY_OK' }, finish_reason: 'stop' }],
        })
      }
      return
    }

    state.target_calls.push({
      ...safeReceipt,
      first_chunk_at_ms: null,
      downstream_closed_at_ms: null,
      request_aborted_at_ms: null,
      release_at_ms: null,
      late_write_attempted: false,
      late_write_accepted: null,
      response_destroyed_at_release: null,
    })
    const receipt = state.target_calls.at(-1)
    if (state.target_calls.length > 1) {
      sendJSON(response, 409, { error: { message: 'Duplicate physical target request' } })
      return
    }

    response.on('error', () => {})
    request.on('aborted', () => {
      receipt.request_aborted_at_ms ??= Date.now() - state.started_at
    })
    response.on('close', () => {
      if (!response.writableEnded) {
        receipt.downstream_closed_at_ms ??= Date.now() - state.started_at
      }
    })
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'close',
    })
    response.flushHeaders?.()
    response.write(`data: ${JSON.stringify(openAIChunk(PARTIAL_MARKER))}\n\n`)
    receipt.first_chunk_at_ms = Date.now() - state.started_at

    state.release_timer = setTimeout(() => {
      receipt.release_at_ms = Date.now() - state.started_at
      receipt.late_write_attempted = true
      receipt.response_destroyed_at_release = response.destroyed
      try {
        receipt.late_write_accepted = response.write(
          `data: ${JSON.stringify(openAIChunk(LATE_MARKER, 'stop'))}\n\n`,
        )
        response.end('data: [DONE]\n\n')
      } catch {
        receipt.late_write_accepted = false
      }
      state.provider_released = true
      providerReleased.resolve(receipt)
    }, PROVIDER_RELEASE_DELAY_MS)
  })

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  state.origin = `http://127.0.0.1:${address.port}`

  async function waitForReport(phase, timeoutMs) {
    if (state.reports[phase]) return state.reports[phase]
    const source = phase === 'initial' ? initialReport.promise : restartReport.promise
    let timer
    try {
      return await Promise.race([
        source,
        new Promise((_, rejectTimeout) => {
          timer = setTimeout(() => rejectTimeout(new Error(`${phase} WebView report timed out`)), timeoutMs)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  async function close() {
    clearTimeout(state.release_timer)
    server.closeAllConnections?.()
    await new Promise((resolveClose) => server.close(resolveClose))
  }

  return {
    state,
    origin: state.origin,
    waitForReport,
    providerReleased: providerReleased.promise,
    close,
  }
}

function renderConfig(sandbox, sidecarPort, fixtureOrigin) {
  const databasePath = join(sandbox, '.hexclaw/data.db')
  return `server:
  host: 127.0.0.1
  port: ${sidecarPort}
  mode: development
  api_token: ${JSON.stringify(SYNTHETIC_API_TOKEN)}
platforms:
  web:
    enabled: true
llm:
  default: bug017-loopback
  providers:
    bug017-loopback:
      api_key: ${JSON.stringify(SYNTHETIC_PROVIDER_KEY)}
      base_url: ${fixtureOrigin}/v1
      model: bug017-mock-model
      models:
        - bug017-mock-model
      model_specs_mode: explicit
      model_specs:
        - id: bug017-mock-model
          display_name: Bug017 Loopback Model
          capabilities:
            - text
      compatible: openai
      locality: cloud
      tools_enabled: false
      enabled: true
    fixture-local-sentinel:
      api_key: ${JSON.stringify(SYNTHETIC_PROVIDER_KEY)}
      base_url: ${fixtureOrigin}/v1
      model: bug017-mock-model
      models:
        - bug017-mock-model
      model_specs_mode: explicit
      model_specs:
        - id: bug017-mock-model
          display_name: Bug017 Local Sentinel
          capabilities:
            - text
      compatible: openai
      locality: local
      tools_enabled: false
      enabled: true
  routing:
    enabled: false
  cache:
    enabled: false
  tools:
    enabled: off
storage:
  driver: sqlite
  sqlite:
    path: ${JSON.stringify(databasePath)}
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
    translate: false
    summary: false
    browser: false
    code: false
    shell: false
    code_exec: false
    file_ops: false
    media_gen: false
    send_message: false
    export_doc: false
observe:
  log_level: info
  metrics:
    enabled: false
`
}

function writeOverlay(sandbox, frontend, sidecarBase, sidecarPort, fixtureOrigin) {
  const overlayPath = join(sandbox, 'tauri.bug017.conf.json')
  const overlay = {
    productName: APP_PRODUCT_NAME,
    identifier: APP_IDENTIFIER,
    build: {
      frontendDist: relative(srcTauriDir, frontend),
      beforeBuildCommand: '',
    },
    app: {
      windows: [{
        label: 'main',
        title: APP_PRODUCT_NAME,
        width: 1280,
        height: 820,
        minWidth: 900,
        minHeight: 600,
        visible: true,
      }],
      security: {
        csp: [
          "default-src 'self'",
          "script-src 'self' 'unsafe-inline'",
          "style-src 'self' 'unsafe-inline'",
          "style-src-attr 'unsafe-inline'",
          `img-src 'self' data: blob: http://localhost:${sidecarPort}`,
          `media-src 'self' data: blob: http://localhost:${sidecarPort}`,
          `connect-src 'self' http://localhost:${sidecarPort} ws://localhost:${sidecarPort} ${fixtureOrigin}`,
          "font-src 'self'",
          "object-src 'none'",
          "base-uri 'self'",
          "form-action 'self'",
        ].join('; '),
      },
    },
    bundle: {
      targets: ['app'],
      createUpdaterArtifacts: false,
      externalBin: [relative(srcTauriDir, sidecarBase)],
    },
    plugins: {
      updater: {
        endpoints: [`${fixtureOrigin}/__bug017__/updater`],
        dangerousInsecureTransportProtocol: true,
      },
    },
  }
  writeJSON(overlayPath, overlay)
  return overlayPath
}

function injectFixture(frontend, fixtureOrigin) {
  const fixture = readFileSync(fixtureSourcePath, 'utf8').replaceAll(
    '__HEX_BUG017_FIXTURE_ORIGIN__',
    fixtureOrigin,
  )
  const fixtureTarget = join(frontend, 'bug-20260802-017-chunk-idle-webview-fixture.js')
  writeFileSync(fixtureTarget, fixture, { encoding: 'utf8', mode: 0o600 })
  const indexPath = join(frontend, 'index.html')
  const index = readFileSync(indexPath, 'utf8')
  assert.match(index, /<head>/)
  writeFileSync(
    indexPath,
    index.replace(
      '<head>',
      '<head>\n<script src="./bug-20260802-017-chunk-idle-webview-fixture.js"></script>',
    ),
  )
}

function nativeTargetTriple() {
  const arch = spawnSync('go', ['env', 'GOARCH'], { cwd: hexclawRoot, encoding: 'utf8' }).stdout.trim()
  if (arch === 'arm64') return 'aarch64-apple-darwin'
  if (arch === 'amd64') return 'x86_64-apple-darwin'
  throw new Error(`Unsupported native Go architecture: ${arch}`)
}

function appEnvironment(sandbox, tmp, sidecarPort, fixtureOrigin) {
  const proxy = fixtureOrigin
  return {
    PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: 'zh_CN.UTF-8',
    HOME: sandbox,
    USERPROFILE: sandbox,
    CFFIXED_USER_HOME: sandbox,
    TMPDIR: tmp,
    TEMP: tmp,
    TMP: tmp,
    USER: 'hexclaw-test',
    LOGNAME: 'hexclaw-test',
    HEXCLAW_TEST_MODE: '1',
    HEXCLAW_TEST_HOME: sandbox,
    HEXCLAW_SIDECAR_PORT: String(sidecarPort),
    HEXCLAW_TEST_LLM_CONFIG_MODE: 'preseeded-owner-yaml',
    HEXCLAW_DISABLE_BACKGROUND_EGRESS: '1',
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    ALL_PROXY: proxy,
    NO_PROXY: '127.0.0.1,localhost,::1',
    http_proxy: proxy,
    https_proxy: proxy,
    all_proxy: proxy,
    no_proxy: '127.0.0.1,localhost,::1',
  }
}

function startApp(executable, sandbox, tmp, sidecarPort, fixtureOrigin, rawLogPath) {
  const logStream = createWriteStream(rawLogPath, { flags: 'wx', mode: 0o600 })
  let captured = ''
  const child = spawn(executable, [], {
    cwd: sandbox,
    env: appEnvironment(sandbox, tmp, sidecarPort, fixtureOrigin),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const capture = (chunk) => {
    captured += chunk.toString()
    logStream.write(chunk)
  }
  child.stdout.on('data', capture)
  child.stderr.on('data', capture)
  return { child, logStream, text: () => captured }
}

async function waitForHealth(port, appProcess, logText) {
  await waitFor(async () => {
    if (appProcess.exitCode !== null || appProcess.signalCode !== null) {
      throw new Error(`Test.app exited before Sidecar health\n${logText().slice(-8_000)}`)
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1_200),
      })
      return response.ok
    } catch {
      return false
    }
  }, 75_000, 'Test.app Sidecar health', 250)
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return { stopped: true, forced: false }
  child.kill('SIGTERM')
  const exited = await Promise.race([
    new Promise((resolveExit) => child.once('exit', () => resolveExit(true))),
    sleep(7_000).then(() => false),
  ])
  if (!exited && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
    await Promise.race([
      new Promise((resolveExit) => child.once('exit', resolveExit)),
      sleep(3_000),
    ])
    return { stopped: child.exitCode !== null || child.signalCode !== null, forced: true }
  }
  return { stopped: true, forced: false }
}

async function stopOwnedSidecar(port, ownedAppBundle) {
  const expected = `${ownedAppBundle}/Contents/MacOS/hexclaw`
  const stopped = []
  const unexpected = []
  for (const pid of listenerPids(port)) {
    const command = processCommand(pid)
    if (command.includes(expected) && command.includes('serve --desktop')) {
      try {
        process.kill(pid, 'SIGTERM')
        stopped.push(pid)
      } catch (error) {
        if (error.code !== 'ESRCH') throw error
      }
    } else {
      unexpected.push({ pid, command })
    }
  }
  await waitFor(() => listenerPids(port).length === 0, 8_000, `release Sidecar port ${port}`)
  return { stopped, unexpected, released: listenerPids(port).length === 0 }
}

async function closeAppRun(run, sidecarPort) {
  if (!run) return { app: { stopped: true, forced: false }, sidecar: { stopped: [], unexpected: [], released: true } }
  const app = await stopProcess(run.child)
  const sidecar = await stopOwnedSidecar(sidecarPort, appBundle)
  await new Promise((resolveClose) => run.logStream.end(resolveClose))
  return { app, sidecar }
}

function sqliteJSON(databasePath, sql) {
  const result = spawnSync('/usr/bin/sqlite3', ['-json', databasePath, sql], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || 'sqlite3 query failed')
  return result.stdout.trim() ? JSON.parse(result.stdout) : []
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

function readSQLiteSnapshot(databasePath) {
  const sessions = sqliteJSON(
    databasePath,
    `SELECT session_id FROM messages WHERE role='user' AND content=${sqlString(USER_MARKER)} ORDER BY created_at DESC LIMIT 1;`,
  )
  if (sessions.length !== 1) return null
  const sessionId = sessions[0].session_id
  const messages = sqliteJSON(
    databasePath,
    `SELECT id, session_id, role, content, request_id,
      CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.request_id') END AS metadata_request_id,
      CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.is_error') END AS metadata_is_error,
      CASE WHEN json_valid(meta) THEN json_extract(meta, '$.request_id') END AS meta_request_id,
      created_at
     FROM messages WHERE session_id=${sqlString(sessionId)} ORDER BY created_at, id;`,
  )
  return { session_id: sessionId, messages }
}

function assertSQLiteInvariant(snapshot) {
  assert.ok(snapshot, 'Target session is missing from SQLite')
  const users = snapshot.messages.filter((message) => message.role === 'user')
  const assistants = snapshot.messages.filter((message) => message.role === 'assistant')
  assert.equal(users.length, 1, 'SQLite must contain one user row')
  assert.equal(users[0].content, USER_MARKER)
  assert.equal(assistants.length, 1, 'SQLite must contain one assistant row')
  const assistant = assistants[0]
  assert.equal(assistant.content, ERROR_TEXT)
  assert.ok(assistant.request_id, 'Error assistant top-level request_id is missing')
  assert.equal(assistant.id, `${assistant.request_id}:assistant`)
  assert.equal(assistant.metadata_request_id, assistant.request_id)
  assert.equal(Number(assistant.metadata_is_error), 1)
  assert.ok(!snapshot.messages.some((message) => String(message.content).includes(LATE_MARKER)))
  return assistant
}

function assertLogOrdering(logText, requestId) {
  const lines = logText.split(/\r?\n/)
  const cancelIndex = lines.findIndex(
    (line) => line.includes('WebSocket cancel') && line.includes(requestId),
  )
  assert.ok(cancelIndex >= 0, 'Sidecar log is missing the request-scoped cancel receipt')
  const disconnectIndex = lines.findIndex(
    (line, index) => index > cancelIndex && line.includes('WebSocket 连接断开'),
  )
  assert.ok(disconnectIndex > cancelIndex, 'Sidecar disconnect did not follow the cancel receipt')
  return {
    cancel_line_index: cancelIndex,
    disconnect_line_index: disconnectIndex,
    cancel_before_disconnect: true,
    cancel_line: lines[cancelIndex].slice(0, 500),
    disconnect_line: lines[disconnectIndex].slice(0, 500),
  }
}

function validateEvidenceHasNoPersonalPath() {
  for (const entry of readdirSync(evidenceDir)) {
    const path = join(evidenceDir, entry)
    if (!statSync(path).isFile()) continue
    const content = readFileSync(path, 'utf8')
    assert.doesNotMatch(content, /\/Users\/[^/\s]+/, `${entry} contains a personal absolute path`)
    assert.doesNotMatch(content, new RegExp(SYNTHETIC_PROVIDER_KEY), `${entry} contains the synthetic provider key`)
    assert.doesNotMatch(content, new RegExp(SYNTHETIC_API_TOKEN), `${entry} contains the synthetic API token`)
  }
}

async function main() {
  assert.equal(process.platform, 'darwin', 'BUG-20260802-017 Test.app boundary is macOS-only')
  assert.ok(existsSync(fixtureSourcePath), 'WebView fixture is missing')
  assert.ok(existsSync(hexclawRoot), 'HexClaw source repository is missing')

  rmSync(evidenceDir, { recursive: true, force: true })
  mkdirSync(evidenceDir, { recursive: true, mode: 0o700 })
  chmodSync(evidenceDir, 0o700)

  const sandbox = mkdtempSync(join(tmpdir(), 'hexclaw-bug017-webview.'))
  chmodSync(sandbox, 0o700)
  const configDir = join(sandbox, '.hexclaw')
  const tmp = join(sandbox, 'tmp')
  const frontend = join(sandbox, 'frontend')
  const binaries = join(sandbox, 'binaries')
  mkdirSync(configDir, { mode: 0o700 })
  mkdirSync(tmp, { mode: 0o700 })
  mkdirSync(binaries, { mode: 0o700 })
  const databasePath = join(configDir, 'data.db')
  const sidecarFileLogPath = join(configDir, 'logs', 'hexclaw.log')

  const loopback = await startLoopbackFixture()
  const sidecarPort = await reserveLoopbackPort()
  assert.notEqual(sidecarPort, 16060, 'Production Sidecar port is forbidden')
  assert.deepEqual(listenerPids(sidecarPort), [], 'Dedicated Sidecar port is occupied')

  const targetTriple = nativeTargetTriple()
  const sidecarBase = join(binaries, 'hexclaw')
  const sidecarBinary = `${sidecarBase}-${targetTriple}`
  const configPath = join(configDir, 'hexclaw.yaml')
  writeFileSync(configPath, renderConfig(sandbox, sidecarPort, loopback.origin), {
    encoding: 'utf8',
    mode: 0o600,
  })
  chmodSync(configPath, 0o600)

  const offlineBuildEnv = {
    ...process.env,
    CARGO_NET_OFFLINE: 'true',
    GOENV: 'off',
    GOTOOLCHAIN: 'local',
    GOPROXY: 'off',
    GOSUMDB: 'off',
    PNPM_CONFIG_OFFLINE: 'true',
    npm_config_offline: 'true',
  }
  delete offlineBuildEnv.GOROOT

  let firstRun = null
  let restartRun = null
  let firstCleanup = null
  let finalCleanup = null
  let firstLog = ''
  let restartLog = ''
  let firstSidecarFileLog = ''
  let aggregateStatus = 'FAIL'
  let failure = null
  const startedAt = Date.now()
  const buildReceipts = []

  try {
    rmSync(appBundle, { recursive: true, force: true })
    buildReceipts.push(await runCommand(
      'pnpm',
      ['exec', 'vite', 'build', '--outDir', frontend, '--emptyOutDir'],
      { cwd: repoRoot, env: offlineBuildEnv },
    ))
    injectFixture(frontend, loopback.origin)

    buildReceipts.push(await runCommand(
      'go',
      ['build', '-trimpath', '-o', sidecarBinary, './cmd/hexclaw/'],
      { cwd: hexclawRoot, env: offlineBuildEnv },
    ))
    chmodSync(sidecarBinary, 0o700)
    const overlayPath = writeOverlay(
      sandbox,
      frontend,
      sidecarBase,
      sidecarPort,
      loopback.origin,
    )
    buildReceipts.push(await runCommand(
      'pnpm',
      ['exec', 'tauri', 'build', '--config', overlayPath, '--bundles', 'app'],
      { cwd: repoRoot, env: offlineBuildEnv },
    ))

    const infoPlist = join(appBundle, 'Contents/Info.plist')
    const appExecutable = join(appBundle, 'Contents/MacOS/hexclaw-desktop')
    const bundledSidecar = join(appBundle, 'Contents/MacOS/hexclaw')
    assert.ok(existsSync(infoPlist), 'Unique Test.app Info.plist is missing')
    assert.ok(existsSync(appExecutable), 'Unique Test.app executable is missing')
    assert.ok(existsSync(bundledSidecar), 'Current-source Sidecar is missing from Test.app')
    assert.equal(sha256(bundledSidecar), sha256(sidecarBinary), 'Bundled Sidecar is not the current-source build')
    const plist = spawnSync(
      'plutil',
      ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', infoPlist],
      { encoding: 'utf8' },
    )
    assert.equal(plist.status, 0, plist.stderr)
    assert.equal(plist.stdout.trim(), APP_IDENTIFIER)

    const firstRawLog = join(sandbox, 'app-first.log')
    firstRun = startApp(
      appExecutable,
      sandbox,
      tmp,
      sidecarPort,
      loopback.origin,
      firstRawLog,
    )
    await waitForHealth(sidecarPort, firstRun.child, firstRun.text)
    const initialReport = await loopback.waitForReport('initial', 105_000)
    assert.equal(initialReport.status, 'PASS', initialReport.error || 'Initial WebView report failed')
    await loopback.providerReleased

    const beforeRestart = await waitFor(
      () => readSQLiteSnapshot(databasePath),
      12_000,
      'pre-restart SQLite snapshot',
    )
    const assistant = assertSQLiteInvariant(beforeRestart)
    writeJSON(join(evidenceDir, 'sqlite-before-restart.json'), beforeRestart)

    firstCleanup = await closeAppRun(firstRun, sidecarPort)
    firstSidecarFileLog = readSidecarFileLog(sidecarFileLogPath)
    firstLog = `${firstRun.text()}\n--- SIDECAR FILE LOG ---\n${firstSidecarFileLog}`
    writeFileSync(
      join(evidenceDir, 'app-first.log'),
      sanitizeText(firstLog, sandbox, loopback.origin),
      { encoding: 'utf8', mode: 0o600 },
    )
    firstRun = null
    assert.deepEqual(listenerPids(sidecarPort), [], 'Sidecar port remained occupied before restart')

    const restartRawLog = join(sandbox, 'app-restart.log')
    restartRun = startApp(
      appExecutable,
      sandbox,
      tmp,
      sidecarPort,
      loopback.origin,
      restartRawLog,
    )
    await waitForHealth(sidecarPort, restartRun.child, restartRun.text)
    const restartReport = await loopback.waitForReport('restart', 60_000)
    assert.equal(restartReport.status, 'PASS', restartReport.error || 'Restart WebView report failed')
    assert.equal(loopback.state.target_calls.length, 1, 'Restart triggered a second physical target call')

    const afterRestart = await waitFor(
      () => readSQLiteSnapshot(databasePath),
      10_000,
      'post-restart SQLite snapshot',
    )
    assertSQLiteInvariant(afterRestart)
    assert.deepEqual(afterRestart, beforeRestart, 'SQLite exact-set changed across App and Sidecar restart')
    writeJSON(join(evidenceDir, 'sqlite-after-restart.json'), afterRestart)

    finalCleanup = await closeAppRun(restartRun, sidecarPort)
    const allSidecarFileLog = readSidecarFileLog(sidecarFileLogPath)
    restartLog = `${restartRun.text()}\n--- SIDECAR FILE LOG ---\n${allSidecarFileLog.slice(firstSidecarFileLog.length)}`
    writeFileSync(
      join(evidenceDir, 'app-restart.log'),
      sanitizeText(restartLog, sandbox, loopback.origin),
      { encoding: 'utf8', mode: 0o600 },
    )
    restartRun = null

    const providerReceipt = loopback.state.target_calls[0]
    assert.ok(providerReceipt.downstream_closed_at_ms !== null, 'Provider downstream did not close on cancel')
    assert.ok(providerReceipt.release_at_ms !== null, 'Held late terminal was not released')
    assert.ok(
      providerReceipt.downstream_closed_at_ms < providerReceipt.release_at_ms,
      'Provider downstream closed after late terminal release',
    )
    assert.equal(providerReceipt.response_destroyed_at_release, true)
    assert.equal(loopback.state.blocked_external_requests.length, 0, 'Test.app attempted external network access')
    assert.deepEqual(loopback.state.unexpected_paths, [])
    assert.doesNotMatch(firstLog, /localhost:11434|127\.0\.0\.1:11434/, 'Test.app probed a real local model')

    const transportReceipt = {
      request_id: assistant.request_id,
      ...assertLogOrdering(firstLog, assistant.request_id),
      provider_downstream_closed_before_release: true,
      provider_call_count: loopback.state.target_calls.length,
      no_late_success_persisted: true,
      sqlite_exact_set_stable_after_restart: true,
    }
    writeJSON(join(evidenceDir, 'transport-receipt.json'), transportReceipt)
    writeJSON(join(evidenceDir, 'provider-receipt.json'), {
      fixture_binding: '127.0.0.1',
      release_delay_ms: PROVIDER_RELEASE_DELAY_MS,
      target_calls: loopback.state.target_calls,
      auxiliary_provider_calls: loopback.state.auxiliary_provider_calls,
      catalog_requests: loopback.state.catalog_requests,
      blocked_external_requests: loopback.state.blocked_external_requests,
      unexpected_paths: loopback.state.unexpected_paths,
    })
    writeJSON(join(evidenceDir, 'webview-trace.json'), {
      reports: loopback.state.reports,
      progress: loopback.state.progress,
    })

    const buildReceipt = {
      desktop_head: gitHead(repoRoot),
      hexclaw_head: gitHead(hexclawRoot),
      app_identifier: APP_IDENTIFIER,
      app_product_name: APP_PRODUCT_NAME,
      app_executable_sha256: sha256(appExecutable),
      sidecar_sha256: sha256(bundledSidecar),
      source_sidecar_sha256: sha256(sidecarBinary),
      commands: buildReceipts.map((receipt) => ({
        command: receipt.command,
        args: receipt.args.map((arg) => arg.startsWith(sandbox) ? arg.replace(sandbox, '<sandbox>') : arg),
        duration_ms: receipt.duration_ms,
      })),
    }
    writeJSON(join(evidenceDir, 'build-receipt.json'), buildReceipt)
    writeJSON(join(evidenceDir, 'report.json'), {
      status: 'PASS',
      bug_id: 'BUG-20260802-017',
      acceptance: ['DESKTOP-BOUNDARY-CHAT-003', 'DESKTOP-BOUNDARY-CHAT-004'],
      boundary: 'current-source temporary Test.app / real WKWebView / current-source Sidecar / loopback Provider',
      duration_ms: Date.now() - startedAt,
      isolation: {
        unique_bundle_identifier: APP_IDENTIFIER,
        test_home_mode: '0700',
        provider_config_mode: '0600 owner YAML',
        sidecar_port: sidecarPort,
        production_port_used: false,
        fixture_binding: '127.0.0.1',
        external_network_attempts: 0,
        real_model_invocations: 0,
        applications_directory_modified: false,
      },
      result: {
        chunk_idle_error_elapsed_ms: loopback.state.reports.initial.error_elapsed_from_partial_ms,
        request_id: assistant.request_id,
        assistant_id: assistant.id,
        provider_target_calls: loopback.state.target_calls.length,
        cancel_before_close: transportReceipt.cancel_before_disconnect,
        downstream_closed_before_late_release: true,
        late_success_rows: 0,
        before_restart_message_count: beforeRestart.messages.length,
        after_restart_message_count: afterRestart.messages.length,
        restart_exact_set: true,
        restart_visible_error_count: restartReport.messages.error_assistant_count,
      },
      artifacts: [
        'build-receipt.json',
        'webview-trace.json',
        'provider-receipt.json',
        'transport-receipt.json',
        'sqlite-before-restart.json',
        'sqlite-after-restart.json',
        'app-first.log',
        'app-restart.log',
        'cleanup.json',
      ],
    })
    aggregateStatus = 'PASS'
  } catch (error) {
    failure = error
  } finally {
    if (firstRun) {
      firstCleanup = await closeAppRun(firstRun, sidecarPort).catch((error) => ({ error: error.message }))
      firstSidecarFileLog = readSidecarFileLog(sidecarFileLogPath)
      firstLog = `${firstRun.text()}\n--- SIDECAR FILE LOG ---\n${firstSidecarFileLog}`
      writeFileSync(
        join(evidenceDir, 'app-first.log'),
        sanitizeText(firstLog, sandbox, loopback.origin),
        { encoding: 'utf8', mode: 0o600 },
      )
    }
    if (restartRun) {
      finalCleanup = await closeAppRun(restartRun, sidecarPort).catch((error) => ({ error: error.message }))
      const allSidecarFileLog = readSidecarFileLog(sidecarFileLogPath)
      restartLog = `${restartRun.text()}\n--- SIDECAR FILE LOG ---\n${allSidecarFileLog.slice(firstSidecarFileLog.length)}`
      writeFileSync(
        join(evidenceDir, 'app-restart.log'),
        sanitizeText(restartLog, sandbox, loopback.origin),
        { encoding: 'utf8', mode: 0o600 },
      )
    }
    await loopback.close().catch(() => {})
    const uniqueBundleRemoved = (() => {
      rmSync(appBundle, { recursive: true, force: true })
      return !existsSync(appBundle)
    })()
    rmSync(sandbox, { recursive: true, force: true })
    const cleanup = {
      status: aggregateStatus,
      first_run: firstCleanup,
      restart_run: finalCleanup,
      sidecar_port_released: listenerPids(sidecarPort).length === 0,
      fixture_port_released: listenerPids(Number(new URL(loopback.origin).port)).length === 0,
      unique_test_app_removed: uniqueBundleRemoved,
      sandbox_removed: !existsSync(sandbox),
      production_app_untouched: true,
    }
    writeJSON(join(evidenceDir, 'cleanup.json'), cleanup)
    if (!existsSync(join(evidenceDir, 'webview-trace.json'))) {
      writeJSON(join(evidenceDir, 'webview-trace.json'), {
        reports: loopback.state.reports,
        progress: loopback.state.progress,
      })
    }
    if (!existsSync(join(evidenceDir, 'provider-receipt.json'))) {
      writeJSON(join(evidenceDir, 'provider-receipt.json'), {
        fixture_binding: '127.0.0.1',
        release_delay_ms: PROVIDER_RELEASE_DELAY_MS,
        target_calls: loopback.state.target_calls,
        auxiliary_provider_calls: loopback.state.auxiliary_provider_calls,
        blocked_external_requests: loopback.state.blocked_external_requests,
        unexpected_paths: loopback.state.unexpected_paths,
      })
    }
    if (aggregateStatus !== 'PASS' && !existsSync(join(evidenceDir, 'report.json'))) {
      writeJSON(join(evidenceDir, 'report.json'), {
        status: 'FAIL',
        bug_id: 'BUG-20260802-017',
        error: failure instanceof Error ? `${failure.name}: ${failure.message}` : String(failure),
        cleanup,
      })
    }
    validateEvidenceHasNoPersonalPath()
  }

  if (failure) throw failure
  process.stdout.write(`BUG-20260802-017 native WebView chunk-idle PASS: ${relative(repoRoot, join(evidenceDir, 'report.json'))}\n`)
}

await main()
