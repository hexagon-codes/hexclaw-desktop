#!/usr/bin/env node

/**
 * E2E-CHAT-THINK-PROGRESS-001A 已安装应用真实模型门禁。
 *
 * 运行时从 freshly attested Test.app 复用 Sidecar 二进制，在当前 Desktop 源码的
 * 临时前端副本中注入只读取证驱动；真实 HOME、/Applications、生产源码和生产 UI
 * 均不修改。真实模型执行必须通过命令行与六个精确环境变量双重显式授权。
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const nativeDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(nativeDir, '../..')
const hexclawRoot = resolve(repoRoot, '../hexclaw')
const docsRoot = resolve(repoRoot, '../hexclaw-docs')
const srcTauriDir = join(repoRoot, 'src-tauri')
const fixtureSource = join(nativeDir, 'chat-assistant-run-status-real-installed-fixture.js')
const defaultCandidateApp = join(
  srcTauriDir,
  'target/release/bundle/macos/HexClaw Test.app',
)
const expectedProvider = 'hexclaw-gpt'
const expectedModel = 'gpt-5.6-sol'
const expectedNeutralLabel = '正在回复…'
const userMarker = 'HEX_CHAT_STATUS_REAL_INSTALLED_USER_001'
const frame = { width: 1440, height: 900 }
const commandTimeoutMs = 20 * 60_000
const sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds))

const help = `Usage:
  node tests/native/chat-assistant-run-status-real-installed.mjs --execute-real

Required environment:
  HEX_CHAT_STATUS_REAL_INSTALLED_AUTHORIZED=1
  HEX_CHAT_STATUS_PROVIDER=hexclaw-gpt
  HEX_CHAT_STATUS_MODEL=gpt-5.6-sol
  HEX_CHAT_STATUS_SOURCE_CONFIG=/absolute/path/to/0600/hexclaw.yaml
  HEX_CHAT_STATUS_EXPECTED_DESKTOP_SHA256=<64 lowercase hex>
  HEX_CHAT_STATUS_EXPECTED_SIDECAR_SHA256=<64 lowercase hex>

Optional environment:
  HEX_CHAT_STATUS_APP_BUNDLE=/absolute/path/to/fresh/HexClaw Test.app
  HEX_CHAT_STATUS_EVIDENCE_DIR=/new/absolute/evidence/directory

This command performs exactly one real chat submission. It uses an isolated 0700
Test Home, a dedicated Sidecar port, Web-only platform config, and disables
DingTalk/IM delivery. Without all authority inputs it exits before building or
starting the app.
`

function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex')
}

function sha256File(path) {
  return sha256Bytes(readFileSync(path))
}

function writeJSON(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
}

function privateRegularFile(path, label) {
  assert.ok(isAbsolute(path), `${label} must be absolute`)
  const info = lstatSync(path)
  assert.ok(info.isFile() && !info.isSymbolicLink(), `${label} must be a regular non-symlink file`)
  assert.equal(info.mode & 0o777, 0o600, `${label} permissions must be 0600`)
  return path
}

function sanitizeText(raw, sandbox, sourceConfig, candidatePolicy) {
  return String(raw || '')
    .replaceAll(repoRoot, '<desktop>')
    .replaceAll(hexclawRoot, '<hexclaw>')
    .replaceAll(docsRoot, '<docs>')
    .replaceAll(sandbox, '<sandbox>')
    .replaceAll(sourceConfig, '<source-config>')
    .replaceAll(candidatePolicy, '<candidate-policy>')
    .replace(/\/Users\/[^/\s]+/gu, '<user-home>')
    .replace(/(authorization\s*[:=]\s*)([^\s,;]+)/giu, '$1<redacted>')
    .replace(/(bearer\s+)([^\s,;]+)/giu, '$1<redacted>')
    .replace(/(api[_-]?key\s*[:=]\s*)([^\s,;]+)/giu, '$1<redacted>')
}

function validateTextEvidence(path) {
  const raw = readFileSync(path, 'utf8')
  assert.doesNotMatch(raw, /\/Users\/[^/\s]+/u, `${path} contains a personal path`)
  assert.doesNotMatch(
    raw,
    /api[_-]?key\s*[:=]\s*(?!<redacted>)/iu,
    `${path} contains unredacted API key data`,
  )
  assert.doesNotMatch(raw, /authorization\s*[:=]\s*(?!<redacted>)/iu, `${path} contains authorization data`)
}

function nativeTargetTriple() {
  if (process.arch === 'arm64') return 'aarch64-apple-darwin'
  if (process.arch === 'x64') return 'x86_64-apple-darwin'
  throw new Error(`Unsupported macOS architecture: ${process.arch}`)
}

function runPrivateCommand(command, args, options = {}) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, {
      cwd: options.cwd || repoRoot,
      env: options.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGTERM') } catch { /* 已退出。 */ }
      rejectCommand(new Error(`${options.label || command} timed out`))
    }, options.timeoutMs || 5 * 60_000)
    child.once('error', (error) => {
      clearTimeout(timer)
      rejectCommand(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      if (code === 0) {
        resolveCommand({ stdout, stderr })
        return
      }
      const safeError = options.sanitize
        ? options.sanitize(stderr || stdout)
        : String(stderr || stdout).slice(-2_000)
      rejectCommand(new Error(`${options.label || command} failed (${code ?? signal}): ${safeError}`))
    })
  })
}

function readJSONBody(request, limit = 2 * 1024 * 1024) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = []
    let bytes = 0
    request.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > limit) {
        rejectBody(new Error('Control payload exceeded the size limit'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch (error) {
        rejectBody(error)
      }
    })
    request.on('error', rejectBody)
  })
}

function sendJSON(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    connection: 'close',
  })
  response.end(body)
}

function createControlServer(port) {
  const state = {
    phase: 'initial',
    releaseFirstInbound: false,
    reports: [],
    traces: [],
    runtimeErrors: [],
    unexpected: [],
  }
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', `http://127.0.0.1:${port}`)
      if (request.method === 'OPTIONS') {
        response.writeHead(204, {
          'access-control-allow-origin': '*',
          'access-control-allow-headers': 'content-type',
          'access-control-allow-methods': 'GET,POST,OPTIONS',
          connection: 'close',
        })
        response.end()
        return
      }
      if (request.method === 'GET' && url.pathname === '/updater') {
        response.writeHead(204, { 'access-control-allow-origin': '*', connection: 'close' })
        response.end()
        return
      }
      if (request.method === 'GET' && url.pathname === '/mode') {
        sendJSON(response, 200, { phase: state.phase })
        return
      }
      if (request.method === 'GET' && url.pathname === '/barrier') {
        sendJSON(response, 200, { release_first_inbound: state.releaseFirstInbound })
        return
      }
      if (request.method === 'GET' && url.pathname === '/baseline') {
        const terminal = state.reports.find((entry) => entry.stage === 'terminal')
        if (!terminal) {
          sendJSON(response, 409, { error: 'Terminal baseline is unavailable' })
          return
        }
        sendJSON(response, 200, {
          assistant_message_id: terminal.status?.assistant_message_id || '',
          thought: terminal.status?.thought || '',
        })
        return
      }
      if (request.method === 'POST' && url.pathname === '/report') {
        state.reports.push(await readJSONBody(request))
        sendJSON(response, 200, { accepted: true })
        return
      }
      if (request.method === 'POST' && url.pathname === '/trace') {
        state.traces.push(await readJSONBody(request))
        sendJSON(response, 200, { accepted: true })
        return
      }
      if (request.method === 'POST' && url.pathname === '/runtime-error') {
        state.runtimeErrors.push(await readJSONBody(request))
        sendJSON(response, 200, { accepted: true })
        return
      }
      state.unexpected.push(`${request.method} ${url.pathname}`)
      sendJSON(response, 404, { error: 'Control route not found' })
    } catch (error) {
      sendJSON(response, 500, {
        error: error instanceof Error ? error.message : String(error),
      })
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
      server.closeAllConnections?.()
      await new Promise((resolveClose) => server.close(resolveClose))
    },
  }
}

async function waitForStage(control, stage, timeout = 180_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const report = control.state.reports.find((entry) => entry.stage === stage)
    if (report) return report
    if (control.state.runtimeErrors.length) {
      throw new Error(`WKWebView fixture failed: ${control.state.runtimeErrors.at(-1).message}`)
    }
    await sleep(100)
  }
  throw new Error(`Timed out waiting for WKWebView report: ${stage}`)
}

async function waitForTargetTraceCount(control, expected, timeout = 10_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const count = control.state.traces.filter((entry) => entry.kind === 'target-request').length
    if (count === expected) return count
    if (count > expected) {
      throw new Error(`Observed ${count} provider-bound requests; expected ${expected}`)
    }
    if (control.state.runtimeErrors.length) {
      throw new Error(`WKWebView fixture failed: ${control.state.runtimeErrors.at(-1).message}`)
    }
    await sleep(50)
  }
  throw new Error(`Timed out waiting for ${expected} provider-bound request trace`)
}

function injectFixture(frontend, controlOrigin) {
  const fixtureName = 'chat-assistant-run-status-real-installed-fixture.js'
  const fixture = readFileSync(fixtureSource, 'utf8').replaceAll(
    '__HEX_CHAT_STATUS_CONTROL_ORIGIN__',
    controlOrigin,
  )
  writeFileSync(join(frontend, fixtureName), fixture, { mode: 0o600 })
  const indexPath = join(frontend, 'index.html')
  const index = readFileSync(indexPath, 'utf8')
  assert.match(index, /<head>/u, 'Built frontend index has no head element')
  const observer = [
    '<head>',
    '<style data-chat-status-test-reduced-motion>',
    '*,*::before,*::after{animation-duration:0s!important;animation-iteration-count:1!important;transition-duration:0s!important}',
    '</style>',
    `<script src="./${fixtureName}"></script>`,
  ].join('\n')
  writeFileSync(indexPath, index.replace('<head>', observer), { mode: 0o600 })
}

function writeOverlay({ sandbox, frontend, snapshotSrcTauriDir, sidecarBase, sidecarPort, controlOrigin, productName, bundleIdentifier }) {
  const overlayPath = join(sandbox, 'tauri.chat-status-real-installed.json')
  const overlay = {
    productName,
    identifier: bundleIdentifier,
    build: {
      frontendDist: relative(snapshotSrcTauriDir, frontend),
      beforeBuildCommand: '',
    },
    app: {
      windows: [{
        label: 'main',
        title: productName,
        width: frame.width,
        height: frame.height,
        minWidth: frame.width,
        minHeight: frame.height,
        resizable: false,
        center: true,
        visible: true,
      }],
      security: {
        csp: [
          "default-src 'self'",
          "script-src 'self' 'unsafe-inline'",
          "style-src 'self' 'unsafe-inline'",
          "style-src-attr 'unsafe-inline'",
          `img-src 'self' data: blob: http://localhost:${sidecarPort} http://127.0.0.1:${sidecarPort}`,
          `media-src 'self' data: blob: http://localhost:${sidecarPort} http://127.0.0.1:${sidecarPort}`,
          `connect-src 'self' http://localhost:${sidecarPort} ws://localhost:${sidecarPort} http://127.0.0.1:${sidecarPort} ws://127.0.0.1:${sidecarPort} ${controlOrigin}`,
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
      externalBin: [relative(snapshotSrcTauriDir, sidecarBase)],
    },
    plugins: {
      updater: {
        endpoints: [`${controlOrigin}/updater`],
        dangerousInsecureTransportProtocol: true,
      },
    },
  }
  writeJSON(overlayPath, overlay)
  return overlayPath
}

function sqliteRows(databasePath, sql) {
  const result = spawnSync('/usr/bin/sqlite3', ['-json', databasePath, sql], {
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr || 'SQLite query failed')
  return result.stdout.trim() ? JSON.parse(result.stdout) : []
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

function parseObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  if (typeof value !== 'string' || !value.trim()) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function readDatabaseSnapshot(databasePath) {
  const sessions = sqliteRows(
    databasePath,
    `SELECT session_id FROM messages WHERE role='user' AND content=${sqlString(userMarker)} ORDER BY created_at DESC LIMIT 1;`,
  )
  assert.equal(sessions.length, 1, 'Isolated database has no unique target session')
  const sessionId = sessions[0].session_id
  const rows = sqliteRows(
    databasePath,
    `SELECT id,session_id,role,content,request_id,metadata,meta,created_at FROM messages WHERE session_id=${sqlString(sessionId)} ORDER BY created_at,id;`,
  )
  const messages = rows.map((row) => {
    const metadata = { ...parseObject(row.metadata), ...parseObject(row.meta) }
    return {
      id: row.id,
      session_id: row.session_id,
      role: row.role,
      request_id: row.request_id || '',
      content_length: typeof row.content === 'string' ? row.content.length : 0,
      content_sha256: sha256Bytes(String(row.content || '')),
      is_target_user: row.role === 'user' && row.content === userMarker,
      provider: typeof metadata.provider === 'string' ? metadata.provider : '',
      model: typeof metadata.model === 'string' ? metadata.model : '',
      thinking_duration: Number(metadata.thinking_duration) || 0,
      assistant_message_id: typeof metadata.assistant_message_id === 'string'
        ? metadata.assistant_message_id
        : '',
      last_sequence: Number(metadata.last_sequence) || 0,
      runtime_event_count: Array.isArray(metadata.runtime_events) ? metadata.runtime_events.length : 0,
      reasoning_receipt: parseObject(metadata.reasoning_receipt),
    }
  })
  const assistants = messages.filter((message) => message.role === 'assistant')
  assert.equal(assistants.length, 1, 'Isolated target session must contain one assistant message')
  assert.deepEqual(assistants[0].reasoning_receipt, {
    version: 1,
    reasoning_request: 'on',
    reasoning_support: 'supported',
    reasoning_execution: 'applied',
  })
  assert.equal(assistants[0].provider, expectedProvider)
  assert.equal(assistants[0].model, expectedModel)
  assert.ok(assistants[0].thinking_duration >= 0)
  return { session_id: sessionId, messages }
}

function startApp(executable, sandbox, sidecarPort, logPath) {
  const stream = createWriteStream(logPath, { flags: 'wx', mode: 0o600 })
  const env = {
    PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: 'zh_CN.UTF-8',
    LC_ALL: 'zh_CN.UTF-8',
    HOME: sandbox,
    USERPROFILE: sandbox,
    CFFIXED_USER_HOME: sandbox,
    TMPDIR: join(sandbox, 'tmp'),
    TEMP: join(sandbox, 'tmp'),
    TMP: join(sandbox, 'tmp'),
    USER: 'hexclaw-test',
    LOGNAME: 'hexclaw-test',
    HEXCLAW_TEST_MODE: '1',
    HEXCLAW_TEST_HOME: sandbox,
    HEXCLAW_SIDECAR_PORT: String(sidecarPort),
    HEXCLAW_TEST_LLM_CONFIG_MODE: 'preseeded-owner-yaml',
    HEXCLAW_TEST_ALLOW_AUTO_LOCAL_OLLAMA: '0',
    DINGTALK_LIVE_SEND: '0',
    NO_PROXY: '*',
    no_proxy: '*',
  }
  const child = spawn(executable, [], {
    cwd: sandbox,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.pipe(stream, { end: false })
  child.stderr.pipe(stream, { end: false })
  return { child, stream, logPath }
}

async function closeAppRun(run, sidecarPort, appBundle, native) {
  if (!run) return { appStopped: true, stoppedSidecars: [] }
  await native.stopProcess(run.child)
  const stoppedSidecars = await native.stopOwnedSidecar(sidecarPort, appBundle)
  await new Promise((resolveEnd) => run.stream.end(resolveEnd))
  return {
    appStopped: run.child.exitCode !== null || run.child.signalCode !== null,
    stoppedSidecars,
  }
}

function assertInstalledReport(before, after, terminal, restored) {
  assert.equal(before.status.neutral_host_count, 1)
  assert.deepEqual(before.status.neutral_texts, [expectedNeutralLabel])
  assert.equal(before.status.live_region_count, 1)
  assert.equal(before.status.typing_dots_count, 0)
  assert.equal(before.status.answer_visible, false)
  assert.equal(after.status.neutral_host_count, 0)
  assert.equal(after.status.typing_dots_count, 0)
  assert.equal(after.status.answer_visible, true)
  assert.equal(terminal.status.reasoning_request, 'on')
  assert.equal(terminal.status.reasoning_support, 'supported')
  assert.equal(terminal.status.reasoning_execution, 'applied')
  assert.match(terminal.status.thought, /^思考了\s+(?:\d+s|\d+m(?:\s+\d+s)?)$/u)
  assert.equal(terminal.outbound.provider, expectedProvider)
  assert.equal(terminal.outbound.model, expectedModel)
  assert.equal(terminal.outbound.thinking, 'on')
  assert.equal(terminal.outbound.thinking_effort, 'low')
  assert.equal(terminal.target_request_count, 1)
  assert.equal(terminal.fallback_request_count, 0)
  assert.equal(restored.status.assistant_message_id, terminal.status.assistant_message_id)
  assert.equal(restored.status.thought, terminal.status.thought)
  assert.equal(restored.status.reasoning_execution, 'applied')
  assert.equal(restored.target_request_count_this_run, 0)
  assert.equal(restored.fallback_request_count_this_run, 0)
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(help)
    return
  }
  assert.deepEqual(args, ['--execute-real'], 'Use --execute-real for the real installed boundary')
  assert.equal(process.platform, 'darwin', 'Installed Test.app boundary is macOS-only')
  assert.equal(process.env.HEX_CHAT_STATUS_REAL_INSTALLED_AUTHORIZED, '1', 'Real installed execution is not authorized')
  assert.equal(process.env.HEX_CHAT_STATUS_PROVIDER, expectedProvider, 'Authorized provider must be hexclaw-gpt')
  assert.equal(process.env.HEX_CHAT_STATUS_MODEL, expectedModel, 'Authorized model must be gpt-5.6-sol')
  assert.ok(existsSync(fixtureSource), 'Installed WKWebView fixture is missing')
  assert.ok(existsSync(hexclawRoot), 'HexClaw source repository is missing')

  const sourceConfig = privateRegularFile(
    process.env.HEX_CHAT_STATUS_SOURCE_CONFIG || '',
    'Source config',
  )
  const candidateApp = resolve(process.env.HEX_CHAT_STATUS_APP_BUNDLE || defaultCandidateApp)
  const candidateInfo = join(candidateApp, 'Contents/Info.plist')
  const candidateExecutable = join(candidateApp, 'Contents/MacOS/hexclaw-desktop')
  const candidateSidecar = join(candidateApp, 'Contents/MacOS/hexclaw')
  for (const path of [candidateInfo, candidateExecutable, candidateSidecar]) {
    assert.ok(existsSync(path) && statSync(path).isFile(), 'Fresh candidate Test.app is incomplete')
  }
  const expectedDesktopSHA256 = process.env.HEX_CHAT_STATUS_EXPECTED_DESKTOP_SHA256 || ''
  const expectedSidecarSHA256 = process.env.HEX_CHAT_STATUS_EXPECTED_SIDECAR_SHA256 || ''
  assert.match(expectedDesktopSHA256, /^[a-f0-9]{64}$/u, 'Expected Desktop SHA-256 is required')
  assert.match(expectedSidecarSHA256, /^[a-f0-9]{64}$/u, 'Expected Sidecar SHA-256 is required')
  assert.equal(sha256File(candidateExecutable), expectedDesktopSHA256, 'Candidate Desktop SHA-256 drifted')
  assert.equal(sha256File(candidateSidecar), expectedSidecarSHA256, 'Candidate Sidecar SHA-256 drifted')

  process.env.HEXCLAW_NATIVE_LIBRARY = '1'
  const native = await import('./bug-20260728-007-current-worktree-wkwebview.mjs')
  const sandbox = mkdtempSync('/tmp/hexclaw-chat-status-real-installed.')
  chmodSync(sandbox, 0o700)
  const configDir = join(sandbox, '.hexclaw')
  const temporaryDirectory = join(sandbox, 'tmp')
  const frontend = join(sandbox, 'frontend')
  mkdirSync(configDir, { mode: 0o700 })
  mkdirSync(temporaryDirectory, { mode: 0o700 })
  const databasePath = join(configDir, 'data.db')
  writeFileSync(databasePath, '', { mode: 0o600 })
  chmodSync(databasePath, 0o600)
  const candidatePolicy = join(sandbox, 'candidate-policy.json')
  writeJSON(candidatePolicy, {
    policy_version: 1,
    queued_seconds: 600,
    normalizing_seconds: 600,
    recognizing_seconds: 600,
    locating_seconds: 600,
    rendering_seconds: 600,
    projecting_seconds: 600,
    recognition_plan_version: 1,
    assessing_buckets: [
      { max_problems: 1, seconds: 600 },
      { max_problems: 8, seconds: 600 },
      { max_problems: 16, seconds: 600 },
      { max_problems: 32, seconds: 600 },
    ],
    item_concurrency: 1,
  })

  const runName = `run-${new Date().toISOString().replace(/[:.]/gu, '-')}-${process.pid}`
  const evidenceRoot = process.env.HEX_CHAT_STATUS_EVIDENCE_DIR
    ? resolve(process.env.HEX_CHAT_STATUS_EVIDENCE_DIR)
    : join(docsRoot, 'evidence/bug-k12-closure-20260824/chat-status-installed', runName)
  assert.ok(isAbsolute(evidenceRoot), 'Evidence directory must be absolute')
  assert.ok(!existsSync(evidenceRoot), 'Evidence directory already exists')
  mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 })
  chmodSync(evidenceRoot, 0o700)

  const controlPort = await native.reserveLoopbackPort()
  const sidecarPort = await native.reserveLoopbackPort()
  assert.notEqual(controlPort, sidecarPort)
  assert.notEqual(sidecarPort, 16060)
  assert.deepEqual(native.listenerPIDs(sidecarPort), [], 'Dedicated Sidecar port is occupied')
  const control = createControlServer(controlPort)
  const productName = `HexClaw Chat Status Test ${process.pid}`
  const bundleIdentifier = `com.hexclaw.desktop.chat-status-${process.pid}`
  const cargoTarget = join(srcTauriDir, 'target')
  const appBundle = join(cargoTarget, `release/bundle/macos/${productName}.app`)
  const provenance = {
    schema_version: 1,
    acceptance_id: 'E2E-CHAT-THINK-PROGRESS-001A',
    source_before: null,
    source_snapshot: null,
    source_after: null,
    source_stable: false,
    production_frontend: null,
    instrumented_frontend: null,
    candidate: {
      info_plist_sha256: sha256File(candidateInfo),
      executable_sha256: sha256File(candidateExecutable),
      sidecar_sha256: sha256File(candidateSidecar),
    },
    installed_test_app: null,
  }
  let firstRun = null
  let restartRun = null
  let firstCleanup = null
  let restartCleanup = null
  let status = 'NOT_PASS'
  let failure = null
  const screenshots = {}

  try {
    await control.listen()
    const prepare = await runPrivateCommand(
      'go',
      [
        'run', '-tags', 'testtools', './cmd/k12-live-fixture-testtools',
        'prepare-profile',
        '--source-config', sourceConfig,
        '--profile', sandbox,
        '--store', databasePath,
        '--candidate-policy', candidatePolicy,
        '--port', String(sidecarPort),
      ],
      {
        cwd: hexclawRoot,
        label: 'isolated exact-model profile preparation',
        timeoutMs: 8 * 60_000,
        sanitize: (raw) => sanitizeText(raw, sandbox, sourceConfig, candidatePolicy),
      },
    )
    const profileReceipt = JSON.parse(prepare.stdout)
    assert.equal(profileReceipt.status, 'prepared')
    assert.match(profileReceipt.config_sha256, /^[a-f0-9]{64}$/u)
    const preparedConfig = join(configDir, 'hexclaw.yaml')
    assert.equal(statSync(preparedConfig).mode & 0o777, 0o600)

    provenance.source_before = native.currentSourceManifest()
    const snapshot = native.createSourceSnapshot(sandbox, provenance.source_before)
    provenance.source_snapshot = snapshot.manifest
    const snapshotSrcTauriDir = join(snapshot.root, 'src-tauri')
    const sidecarDirectory = join(snapshotSrcTauriDir, 'chat-status-binaries')
    mkdirSync(sidecarDirectory, { recursive: true, mode: 0o700 })
    const sidecarBase = join(sidecarDirectory, 'hexclaw')
    const sidecarTarget = `${sidecarBase}-${nativeTargetTriple()}`
    copyFileSync(candidateSidecar, sidecarTarget)
    chmodSync(sidecarTarget, 0o700)
    assert.equal(sha256File(sidecarTarget), provenance.candidate.sidecar_sha256)

    const offlineEnvironment = {
      ...process.env,
      CARGO_NET_OFFLINE: 'true',
      CARGO_TARGET_DIR: cargoTarget,
      GOENV: 'off',
      GOPROXY: 'off',
      GOSUMDB: 'off',
      PNPM_CONFIG_OFFLINE: 'true',
      npm_config_offline: 'true',
      HEXCLAW_PACKAGE_LOCAL_DIST_DIR: frontend,
      HEXCLAW_TEST_ALLOW_AUTO_LOCAL_OLLAMA: '0',
    }
    delete offlineEnvironment.GOROOT
    await native.runCommand('pnpm', ['build-only:package-local'], {
      cwd: snapshot.root,
      env: offlineEnvironment,
      timeoutMs: commandTimeoutMs,
    })
    provenance.production_frontend = native.treeManifest(frontend)
    injectFixture(frontend, control.origin)
    provenance.instrumented_frontend = native.treeManifest(frontend)
    const overlay = writeOverlay({
      sandbox,
      frontend,
      snapshotSrcTauriDir,
      sidecarBase,
      sidecarPort,
      controlOrigin: control.origin,
      productName,
      bundleIdentifier,
    })
    await native.runCommand(
      'pnpm',
      ['exec', 'tauri', 'build', '--config', overlay, '--bundles', 'app'],
      { cwd: snapshot.root, env: offlineEnvironment, timeoutMs: commandTimeoutMs },
    )

    const infoPlist = join(appBundle, 'Contents/Info.plist')
    const executable = join(appBundle, 'Contents/MacOS/hexclaw-desktop')
    const bundledSidecar = join(appBundle, 'Contents/MacOS/hexclaw')
    for (const path of [infoPlist, executable, bundledSidecar]) {
      assert.ok(existsSync(path) && statSync(path).isFile(), 'Instrumented Test.app is incomplete')
    }
    assert.equal(sha256File(bundledSidecar), provenance.candidate.sidecar_sha256)
    const installedIdentifier = execFileSync(
      'plutil',
      ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', infoPlist],
      { encoding: 'utf8' },
    ).trim()
    assert.equal(installedIdentifier, bundleIdentifier)
    provenance.installed_test_app = {
      bundle_identifier: installedIdentifier,
      executable_sha256: sha256File(executable),
      sidecar_sha256: sha256File(bundledSidecar),
      info_plist_sha256: sha256File(infoPlist),
      real_tauri_wkwebview: true,
      candidate_sidecar_reused: true,
    }
    provenance.source_after = native.currentSourceManifest()
    provenance.source_stable =
      provenance.source_after.head === provenance.source_before.head &&
      provenance.source_after.digest === provenance.source_before.digest
    assert.ok(provenance.source_stable, 'Desktop source changed during the installed build')

    firstRun = startApp(executable, sandbox, sidecarPort, join(sandbox, 'app-first.log'))
    await native.waitForHealth(sidecarPort, firstRun.child)
    const bootstrap = await waitForStage(control, 'bootstrap-initial', 90_000)
    assert.equal(bootstrap.environment.runtime, 'Tauri Test.app WKWebView')
    assert.equal(bootstrap.environment.is_tauri, true)
    assert.equal(bootstrap.environment.has_tauri_internals, true)
    assert.deepEqual(bootstrap.environment.viewport, frame)
    assert.ok(
      Number.isFinite(bootstrap.environment.device_pixel_ratio) &&
        bootstrap.environment.device_pixel_ratio >= 1,
      'WKWebView device pixel ratio is invalid',
    )
    assert.equal(bootstrap.environment.reduced_motion, true)

    const before = await waitForStage(control, 'before-first-content', 90_000)
    screenshots.before_first_content = native.captureWindow(
      firstRun.child.pid,
      join(evidenceRoot, 'installed-before-first-content.png'),
    )
    control.state.releaseFirstInbound = true
    const after = await waitForStage(control, 'after-first-content', 180_000)
    screenshots.after_first_content = native.captureWindow(
      firstRun.child.pid,
      join(evidenceRoot, 'installed-after-first-content.png'),
    )
    const terminal = await waitForStage(control, 'terminal', 180_000)
    await waitForTargetTraceCount(control, 1)
    screenshots.terminal = native.captureWindow(
      firstRun.child.pid,
      join(evidenceRoot, 'installed-terminal.png'),
    )

    firstCleanup = await closeAppRun(firstRun, sidecarPort, appBundle, native)
    firstRun = null
    const beforeRestart = readDatabaseSnapshot(databasePath)
    writeJSON(join(evidenceRoot, 'sqlite-before-restart.json'), beforeRestart)
    assert.deepEqual(native.listenerPIDs(sidecarPort), [], 'Sidecar port remained occupied before restart')

    control.state.phase = 'restart'
    restartRun = startApp(executable, sandbox, sidecarPort, join(sandbox, 'app-restart.log'))
    await native.waitForHealth(sidecarPort, restartRun.child)
    const restartBootstrap = await waitForStage(control, 'bootstrap-restart', 90_000)
    assert.equal(restartBootstrap.environment.is_tauri, true)
    const restored = await waitForStage(control, 'restart-restored', 90_000)
    screenshots.restart_restored = native.captureWindow(
      restartRun.child.pid,
      join(evidenceRoot, 'installed-restart-restored.png'),
    )
    assertInstalledReport(before, after, terminal, restored)
    await sleep(500)
    await waitForTargetTraceCount(control, 1)

    restartCleanup = await closeAppRun(restartRun, sidecarPort, appBundle, native)
    restartRun = null
    const afterRestart = readDatabaseSnapshot(databasePath)
    writeJSON(join(evidenceRoot, 'sqlite-after-restart.json'), afterRestart)
    assert.deepEqual(afterRestart, beforeRestart, 'Durable assistant snapshot changed after restart')

    const targetRequests = control.state.traces.filter((entry) => entry.kind === 'target-request')
    const targetHTTPRequests = control.state.traces.filter((entry) => entry.kind === 'target-http-request')
    assert.equal(targetRequests.length, 1, 'App restart caused a second provider-bound request')
    assert.equal(targetHTTPRequests.length, 0, 'Target request used an HTTP fallback path')
    assert.deepEqual(control.state.unexpected, [])
    assert.deepEqual(control.state.runtimeErrors, [])
    const transport = {
      schema_version: 1,
      provider: expectedProvider,
      model: expectedModel,
      reasoning_request: 'on',
      reasoning_effort: 'low',
      applied_receipt: terminal.applied_receipts.at(-1).reasoning_receipt,
      provider_bound_requests_before_restart: 1,
      provider_bound_requests_after_restart: targetRequests.length,
      provider_bound_request_increment_on_restart: targetRequests.length - 1,
      target_http_fallback_requests: targetHTTPRequests.length,
      assistant_message_id: terminal.status.assistant_message_id,
      terminal_thought: terminal.status.thought,
      screenshots,
    }
    assert.equal(transport.provider_bound_request_increment_on_restart, 0)
    writeJSON(join(evidenceRoot, 'transport-receipt.json'), transport)
    writeJSON(join(evidenceRoot, 'wkwebview-reports.json'), {
      reports: control.state.reports,
      traces: control.state.traces,
    })
    writeJSON(join(evidenceRoot, 'provenance.json'), {
      ...provenance,
      profile: {
        mode: '0700',
        config_mode: '0600',
        store_mode: '0600',
        config_sha256: profileReceipt.config_sha256,
        platforms: ['web'],
        dingtalk_live_send: false,
        im_delivery_calls: 0,
      },
      status: 'PASS',
    })

    for (const [source, destination] of [
      [join(sandbox, 'app-first.log'), join(evidenceRoot, 'app-first.log')],
      [join(sandbox, 'app-restart.log'), join(evidenceRoot, 'app-restart.log')],
    ]) {
      if (!existsSync(source)) continue
      writeFileSync(
        destination,
        sanitizeText(readFileSync(source, 'utf8'), sandbox, sourceConfig, candidatePolicy),
        { mode: 0o600 },
      )
    }
    for (const entry of readdirSync(evidenceRoot)) {
      if (/\.(?:json|log)$/u.test(entry)) validateTextEvidence(join(evidenceRoot, entry))
    }
    status = 'PASS'
    process.stdout.write(`Installed assistant run status boundary PASS: ${relative(repoRoot, evidenceRoot)}\n`)
  } catch (error) {
    failure = sanitizeText(
      error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      sandbox,
      sourceConfig,
      candidatePolicy,
    )
    throw error
  } finally {
    try {
      if (firstRun) firstCleanup = await closeAppRun(firstRun, sidecarPort, appBundle, native)
      if (restartRun) restartCleanup = await closeAppRun(restartRun, sidecarPort, appBundle, native)
    } catch (error) {
      if (!failure) {
        failure = sanitizeText(
          error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          sandbox,
          sourceConfig,
          candidatePolicy,
        )
      }
    }
    await control.close().catch(() => {})
    rmSync(appBundle, { recursive: true, force: true })
    rmSync(sandbox, { recursive: true, force: true })
    writeJSON(join(evidenceRoot, 'cleanup.json'), {
      status,
      error: failure,
      first_run: firstCleanup,
      restart_run: restartCleanup,
      app_bundle_removed: !existsSync(appBundle),
      sandbox_removed: !existsSync(sandbox),
      sidecar_port_released: native.listenerPIDs(sidecarPort).length === 0,
      control_port_released: native.listenerPIDs(controlPort).length === 0,
      applications_directory_touched: false,
      real_home_modified: false,
      dingtalk_or_im_invocations: 0,
    })
    validateTextEvidence(join(evidenceRoot, 'cleanup.json'))
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`)
  process.exitCode = 1
})
