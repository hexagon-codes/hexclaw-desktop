#!/usr/bin/env node

import { execFile as execFileCallback, spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  chmod,
  constants as fsConstants,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  stat,
} from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'

const execFile = promisify(execFileCallback)
const LIVE_ROOT = dirname(fileURLToPath(import.meta.url))
const DESKTOP_ROOT = resolve(LIVE_ROOT, '../..')
const DEFAULT_SOURCE_ROOT = resolve(DESKTOP_ROOT, '../hexclaw')
const DEFAULT_SIDECAR = '/Applications/HexClaw.app/Contents/MacOS/hexclaw'
const DEFAULT_DESKTOP = '/Applications/HexClaw.app/Contents/MacOS/hexclaw-desktop'
const PROFILE_HELPER = join(LIVE_ROOT, 'k12-recovering-lock-profile-fixture.go')
const READONLY_PROBE_SOURCE = join(LIVE_ROOT, 'k12-recovering-lock-readonly-probe.swift')
const CONTRACT_PATH = join(LIVE_ROOT, 'k12-recovering-lock-public-api.contract.json')
const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
const LIVE_BUDGET_MS = 12 * 60_000
const SIDE_CAR_START_MS = 45_000
const RECOVERING_WAIT_MS = 45_000
const PROVIDER = 'recovery-fixture'
const MODEL = 'fixture-vision'
const SESSION_TITLE = 'Recovery Lock Fixture'
const SOURCE_MESSAGE = 'Please grade this homework image.'
const RECOVERY_TEXT = '正在恢复批改结果'
const SHA256 = /^[a-f0-9]{64}$/u
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

class HarnessError extends Error {
  constructor(code, diagnostic = '') {
    super(code)
    this.name = 'HarnessError'
    this.code = code
    if (SHA256.test(diagnostic)) this.diagnosticSHA256 = diagnostic
  }
}

function fail(code, diagnostic = '') {
  throw new HarnessError(code, diagnostic)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function safeCode(error) {
  if (error instanceof HarnessError) return error.code
  return 'UNEXPECTED_HARNESS_FAILURE'
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

function nonEmpty(value, code) {
  if (typeof value !== 'string' || value.trim() === '') fail(code)
  return value.trim()
}

export function staticValidation() {
  return {
    status: 'validated',
    mode: 'static',
    public_api_only: true,
    sidecar_started: false,
    provider_posts: 0,
    dingtalk_sends: 0,
    database_mutations: 0,
    live_layer_a_required: true,
    installed_ui_layer_b_required: true,
    provider_query_layer_c_conditional: true,
  }
}

export function assertRecoveringProjection(value) {
  const dispatch = value?.dispatch
  const serialized = JSON.stringify(value)
  if (
    !dispatch ||
    typeof dispatch !== 'object' ||
    typeof dispatch.dispatch_id !== 'string' ||
    dispatch.dispatch_id.trim() === '' ||
    dispatch.status !== 'failed' ||
    dispatch.retryable !== false ||
    dispatch.progress?.operation !== 'classification' ||
    dispatch.progress?.state !== 'recovering' ||
    !Number.isInteger(dispatch.version) ||
    dispatch.version <= 0 ||
    serialized.includes('outcome_unknown') ||
    serialized.includes('classification_outcome_unknown')
  ) {
    fail('PUBLIC_RECOVERING_DTO_INVALID')
  }
  return {
    dispatch_id: dispatch.dispatch_id,
    dispatch_status: dispatch.status,
    version: dispatch.version,
    retryable: dispatch.retryable,
    progress_operation: dispatch.progress.operation,
    progress_state: dispatch.progress.state,
  }
}

export function assertRestartQueryOnly(before, after, evidence) {
  const left = assertRecoveringProjection(before)
  const right = assertRecoveringProjection(after)
  const requests = Array.isArray(evidence?.restart_business_requests)
    ? evidence.restart_business_requests
    : []
  const methods = [...new Set(requests.map((entry) => String(entry).split(' ', 1)[0]))].sort()
  const providerBefore = evidence?.provider_posts_before
  const providerAfter = evidence?.provider_posts_after
  if (
    left.dispatch_id !== right.dispatch_id ||
    left.version !== right.version ||
    left.dispatch_status !== right.dispatch_status ||
    left.progress_state !== right.progress_state ||
    !Number.isInteger(providerBefore) ||
    !Number.isInteger(providerAfter) ||
    providerAfter !== providerBefore ||
    requests.length === 0 ||
    methods.length !== 1 ||
    methods[0] !== 'GET'
  ) {
    fail('RESTART_QUERY_ONLY_INVALID')
  }
  return {
    dispatch_id: left.dispatch_id,
    version: left.version,
    provider_post_delta: providerAfter - providerBefore,
    restart_business_methods: methods,
    query_only: true,
  }
}

export function layerSupport() {
  return {
    layer_a: { supported: true, command: 'run-a' },
    layer_b: {
      supported: true,
      command: 'run-b',
      boundary: 'installed_ui',
    },
    layer_c: {
      supported: false,
      code: 'PROVIDER_QUERY_IDENTITY_UNAVAILABLE',
      conditional: true,
    },
  }
}

async function loadContract() {
  let contract
  try {
    contract = JSON.parse(await readFile(CONTRACT_PATH, 'utf8'))
  } catch {
    fail('CONTRACT_UNAVAILABLE')
  }
  if (
    contract?.schema_version !== 1 ||
    contract?.layer_a?.direct_database_mutation !== false ||
    contract?.layer_b?.api_only_harness_can_complete !== false ||
    contract?.layer_c?.image_task_public_reconcile_api !== false ||
    contract?.layer_c?.must_not_invent_reconciliation_api !== true
  ) {
    fail('CONTRACT_INVALID')
  }
  return contract
}

async function requireFile(pathname, code, { executable = false, privateFile = false } = {}) {
  let info
  try {
    info = await lstat(pathname)
  } catch {
    fail(code)
  }
  if (!info.isFile() || info.isSymbolicLink()) fail(code)
  if (executable && (info.mode & 0o111) === 0) fail(code)
  if (privateFile && (info.mode & 0o777) !== PRIVATE_FILE_MODE) fail(code)
  return info
}

async function requireDirectory(pathname, code) {
  let info
  try {
    info = await lstat(pathname)
  } catch {
    fail(code)
  }
  if (!info.isDirectory() || info.isSymbolicLink()) fail(code)
  return info
}

async function createPrivateFile(pathname, bytes = Buffer.alloc(0)) {
  const handle = await open(pathname, 'wx', PRIVATE_FILE_MODE)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await chmod(pathname, PRIVATE_FILE_MODE)
}

function inside(parent, child) {
  return child === parent || child.startsWith(`${parent}${sep}`)
}

async function createRunRoot() {
  const canonicalTmp = await realpath('/tmp')
  const created = await mkdtemp('/tmp/hexclaw-recovering-lock-')
  await chmod(created, PRIVATE_DIRECTORY_MODE)
  const root = await realpath(created)
  if (!inside(canonicalTmp, root) || root === canonicalTmp) fail('TEMP_ROOT_INVALID')
  return { root, canonicalTmp }
}

async function cleanupRunRoot(runtime) {
  let root
  try {
    root = await realpath(runtime.root)
  } catch {
    return
  }
  if (!inside(runtime.canonicalTmp, root) || root === runtime.canonicalTmp) {
    fail('TEMP_CLEANUP_REFUSED')
  }
  await rm(root, { recursive: true, force: false, maxRetries: 0 })
}

async function reservePort() {
  const server = createServer()
  server.unref()
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()))
  })
  if (!Number.isInteger(port) || port < 1024 || [16060, 16070].includes(port)) {
    fail('LOOPBACK_PORT_INVALID')
  }
  return port
}

function boundedEnvironment(env, root) {
  const result = {
    HOME: root,
    TMPDIR: join(root, 'tmp'),
    PATH: env.PATH ?? '/usr/bin:/bin',
    LANG: env.LANG ?? 'C.UTF-8',
    DINGTALK_LIVE_SEND: '0',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  }
  for (const name of ['GOROOT', 'GOCACHE', 'GOMODCACHE', 'GOPATH', 'GOPROXY', 'GOSUMDB']) {
    if (typeof env[name] === 'string' && env[name] !== '') result[name] = env[name]
  }
  return result
}

async function sha256File(pathname) {
  return sha256(await readFile(pathname))
}

async function runCommand(command, args, options, code) {
  try {
    return await execFile(command, args, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeout,
      maxBuffer: 8 << 20,
      encoding: 'utf8',
      windowsHide: true,
    })
  } catch (error) {
    const digest = sha256(`${error?.stdout ?? ''}\n${error?.stderr ?? ''}`)
    fail(code, digest)
  }
}

function isImageRequest(raw) {
  return raw.includes('data:image/') || raw.includes('"image_url"') || raw.includes('"input_image"')
}

export async function startAmbiguousVisionTransport(port) {
  const state = {
    requests: [],
    provider_posts: 0,
    image_posts: 0,
    passed_image_posts: 0,
    dropped_image_posts: 0,
  }
  const server = createServer((request, response) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > 8 << 20) {
        request.socket.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      state.requests.push({
        method: request.method ?? '',
        path: request.url ?? '',
        body_sha256: sha256(raw),
      })
      if (request.method === 'GET' && request.url?.endsWith('/models')) {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ object: 'list', data: [{ id: MODEL, object: 'model' }] }))
        return
      }
      if (request.method === 'POST') {
        state.provider_posts += 1
        if (isImageRequest(raw)) {
          state.image_posts += 1
          if (state.passed_image_posts === 0) {
            state.passed_image_posts += 1
            response.writeHead(200, { 'Content-Type': 'application/json' })
            response.end(
              JSON.stringify({
                id: 'fixture-vision-probe',
                object: 'chat.completion',
                created: 1,
                model: MODEL,
                choices: [
                  {
                    index: 0,
                    message: { role: 'assistant', content: 'OK' },
                    finish_reason: 'stop',
                  },
                ],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
              }),
            )
            return
          }
          state.dropped_image_posts += 1
          request.socket.destroy()
          return
        }
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(
          JSON.stringify({
            id: `fixture-${state.provider_posts}`,
            object: 'chat.completion',
            created: 1,
            model: MODEL,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: '{}' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        )
        return
      }
      response.writeHead(404, { 'Content-Type': 'application/json' })
      response.end('{"error":"not found"}')
    })
  })
  server.unref()
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(port, '127.0.0.1', resolveListen)
  })
  return {
    state,
    async close() {
      await new Promise((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()))
        server.closeIdleConnections?.()
        server.closeAllConnections?.()
      })
    },
  }
}

function logCollector() {
  let stdoutBytes = 0
  let stderrBytes = 0
  let stdoutTail = ''
  let stderrTail = ''
  const stdoutHash = createHash('sha256')
  const stderrHash = createHash('sha256')
  const appendTail = (current, chunk) => `${current}${chunk.toString('utf8')}`.slice(-64_000)
  return {
    stdout(chunk) {
      stdoutBytes += chunk.length
      stdoutHash.update(chunk)
      stdoutTail = appendTail(stdoutTail, chunk)
    },
    stderr(chunk) {
      stderrBytes += chunk.length
      stderrHash.update(chunk)
      stderrTail = appendTail(stderrTail, chunk)
    },
    receipt() {
      return {
        stdout_bytes: stdoutBytes,
        stderr_bytes: stderrBytes,
        stdout_sha256: stdoutHash.copy().digest('hex'),
        stderr_sha256: stderrHash.copy().digest('hex'),
      }
    },
    debugTail() {
      return { stdout: stdoutTail, stderr: stderrTail }
    },
  }
}

function startSidecar(runtime, capability) {
  const collector = logCollector()
  let resolveExit
  const exit = new Promise((resolveValue) => {
    resolveExit = resolveValue
  })
  const child = spawn(runtime.sidecar, ['serve', '--desktop', '--config', runtime.config], {
    cwd: runtime.root,
    env: {
      ...runtime.environment,
      HEXCLAW_SIDECAR_CAPABILITY_TOKEN: capability,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stdout.on('data', (chunk) => collector.stdout(chunk))
  child.stderr.on('data', (chunk) => collector.stderr(chunk))
  child.once('error', () => resolveExit({ spawn_error: true, code: null, signal: null }))
  child.once('close', (code, signal) => resolveExit({ spawn_error: false, code, signal }))
  return { child, exit, collector, stopped: false }
}

async function stopSidecar(state) {
  if (!state || state.stopped) return state?.receipt
  if (state.child.exitCode === null && state.child.signalCode === null) state.child.kill('SIGTERM')
  let terminal = await Promise.race([state.exit, sleep(10_000).then(() => null)])
  if (!terminal) {
    state.child.kill('SIGKILL')
    terminal = await state.exit
  }
  state.stopped = true
  state.receipt = {
    ...state.collector.receipt(),
    exited: true,
    forced: terminal?.signal === 'SIGKILL',
  }
  return state.receipt
}

async function compileReadonlyProbe(runtime, deadline) {
  await requireFile(READONLY_PROBE_SOURCE, 'READONLY_PROBE_SOURCE_UNAVAILABLE')
  const destination = join(runtime.root, 'bin', 'recovering-lock-readonly-probe')
  await runCommand(
    '/usr/bin/xcrun',
    ['swiftc', '-O', READONLY_PROBE_SOURCE, '-o', destination],
    {
      cwd: DESKTOP_ROOT,
      env: runtime.environment,
      timeout: Math.min(2 * 60_000, Math.max(1, deadline - Date.now())),
    },
    'READONLY_PROBE_BUILD_FAILED',
  )
  await requireFile(destination, 'READONLY_PROBE_BUILD_INVALID', { executable: true })
  return destination
}

async function runReadonlyProbe(
  runtime,
  probe,
  command,
  args = [],
  code = 'READONLY_PROBE_FAILED',
) {
  const result = await runCommand(
    probe,
    [command, ...args.map(String)],
    { cwd: runtime.root, env: runtime.environment, timeout: 30_000 },
    code,
  )
  try {
    return JSON.parse(result.stdout)
  } catch {
    fail(`${code}_JSON_INVALID`, sha256(result.stdout))
  }
}

async function listenerPIDs(port) {
  try {
    const result = await execFile(
      '/usr/sbin/lsof',
      ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'],
      { encoding: 'utf8', timeout: 5_000 },
    )
    return result.stdout
      .split(/\s+/u)
      .filter(Boolean)
      .map(Number)
      .filter((value) => Number.isInteger(value) && value > 0)
  } catch {
    return []
  }
}

async function processCommand(pid) {
  try {
    const result = await execFile('/bin/ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      timeout: 5_000,
    })
    return result.stdout.trim()
  } catch {
    return ''
  }
}

async function installedDesktopPIDs(desktop) {
  const result = await execFile('/bin/ps', ['-axo', 'pid=,command='], {
    encoding: 'utf8',
    timeout: 5_000,
  })
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .flatMap((line) => {
      const match = line.match(/^(\d+)\s+(.+)$/u)
      if (!match) return []
      const command = match[2]
      return command === desktop || command.startsWith(`${desktop} `) ? [Number(match[1])] : []
    })
}

function installedDesktopEnvironment(runtime) {
  return {
    ...runtime.environment,
    USERPROFILE: runtime.root,
    CFFIXED_USER_HOME: runtime.root,
    TEMP: join(runtime.root, 'tmp'),
    TMP: join(runtime.root, 'tmp'),
    USER: 'hexclaw-test',
    LOGNAME: 'hexclaw-test',
    LC_ALL: 'zh_CN.UTF-8',
    HEXCLAW_TEST_MODE: '1',
    HEXCLAW_TEST_HOME: runtime.root,
    HEXCLAW_SIDECAR_PORT: String(runtime.sidecarPort),
    HEXCLAW_TEST_LLM_CONFIG_MODE: 'preseeded-owner-yaml',
    HEXCLAW_TEST_ALLOW_AUTO_LOCAL_OLLAMA: '0',
    DINGTALK_LIVE_SEND: '0',
    HTTP_PROXY: 'http://127.0.0.1:9',
    HTTPS_PROXY: 'http://127.0.0.1:9',
    ALL_PROXY: 'http://127.0.0.1:9',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  }
}

function startInstalledDesktop(runtime, desktop) {
  const collector = logCollector()
  let resolveExit
  const exit = new Promise((resolveValue) => {
    resolveExit = resolveValue
  })
  const child = spawn(desktop, [], {
    cwd: runtime.root,
    env: installedDesktopEnvironment(runtime),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stdout.on('data', (chunk) => collector.stdout(chunk))
  child.stderr.on('data', (chunk) => collector.stderr(chunk))
  child.once('error', () => resolveExit({ spawn_error: true, code: null, signal: null }))
  child.once('exit', (code, signal) => resolveExit({ spawn_error: false, code, signal }))
  return { child, exit, collector, stopped: false }
}

async function stopInstalledDesktop(state) {
  if (!state || state.stopped) return state?.receipt
  if (state.child.exitCode === null && state.child.signalCode === null) state.child.kill('SIGTERM')
  let terminal = await Promise.race([state.exit, sleep(10_000).then(() => null)])
  if (!terminal) {
    state.child.kill('SIGKILL')
    terminal = await state.exit
  }
  state.stopped = true
  state.receipt = {
    ...state.collector.receipt(),
    exited: true,
    forced: terminal?.signal === 'SIGKILL',
  }
  return state.receipt
}

async function stopOwnedInstalledSidecar(runtime) {
  const initial = await listenerPIDs(runtime.sidecarPort)
  for (const pid of initial) {
    const command = await processCommand(pid)
    if (!command.includes(DEFAULT_SIDECAR) || !command.includes('serve --desktop')) {
      fail('UNOWNED_LISTENER_REFUSED')
    }
    process.kill(pid, 'SIGTERM')
  }
  const gracefulDeadline = Date.now() + 5_000
  let remaining = await listenerPIDs(runtime.sidecarPort)
  while (remaining.length > 0 && Date.now() < gracefulDeadline) {
    await sleep(100)
    remaining = await listenerPIDs(runtime.sidecarPort)
  }
  let forced = false
  for (const pid of remaining) {
    const command = await processCommand(pid)
    if (!command.includes(DEFAULT_SIDECAR) || !command.includes('serve --desktop')) {
      fail('UNOWNED_LISTENER_REFUSED')
    }
    process.kill(pid, 'SIGKILL')
    forced = true
  }
  if (initial.length > 0) await waitPortReleased(runtime.sidecarPort)
  return { listeners: initial.length, forced }
}

async function waitForInstalledDesktop(runtime, desktopState) {
  const deadline = Date.now() + SIDE_CAR_START_MS
  while (Date.now() < deadline) {
    if (desktopState.child.exitCode !== null || desktopState.child.signalCode !== null) {
      fail('INSTALLED_DESKTOP_EXITED_BEFORE_READY')
    }
    try {
      const response = await fetch(`http://127.0.0.1:${runtime.sidecarPort}/health`, {
        signal: AbortSignal.timeout(1_500),
      })
      if (response.ok) return
    } catch {
      // 安装应用仍在启动它拥有的隔离 Sidecar。
    }
    await sleep(200)
  }
  fail('INSTALLED_DESKTOP_START_TIMEOUT')
}

function rowText(row) {
  return [row?.title, row?.description].filter(Boolean).join(' ')
}

function visibleRows(rows) {
  return Array.isArray(rows) ? rows.filter((row) => row?.visible !== false) : []
}

function relativeBounds(row, windowRow) {
  if (!row?.bounds || !windowRow?.bounds) return null
  return {
    x: Number(row.bounds.x) - Number(windowRow.bounds.x),
    y: Number(row.bounds.y) - Number(windowRow.bounds.y),
    width: Number(row.bounds.width),
    height: Number(row.bounds.height),
  }
}

function installedUISnapshot(rows) {
  const visible = visibleRows(rows)
  const windowRow = visible.find((row) => row.role === 'AXWindow' && row.bounds)
  const sessionTitle = visible.find(
    (row) => row.title === SESSION_TITLE || row.description === SESSION_TITLE,
  )
  const editors = visible
    .filter((row) => row.role === 'AXTextArea' && row.enabled === true && row.bounds)
    .sort((left, right) => Number(right.bounds.y) - Number(left.bounds.y))
  return {
    editor: editors[0] ?? null,
    send_actions: visible.filter((row) => /发送消息|Send message/iu.test(rowText(row))),
    stop_actions: visible.filter((row) => /停止生成|Stop generating/iu.test(rowText(row))),
    progress_indicators: visible.filter((row) => row.role === 'AXProgressIndicator'),
    session_title: sessionTitle ?? null,
    session_title_relative_bounds: relativeBounds(sessionTitle, windowRow),
    source_message_visible: visible.some((row) => rowText(row).includes(SOURCE_MESSAGE)),
    recovering_visible: visible.some((row) => rowText(row).includes(RECOVERY_TEXT)),
  }
}

async function waitForInstalledUISnapshot(runtime, probe, desktopState, expectRecovering) {
  const configuredWait = Number(process.env.HEXCLAW_UI_WAIT_MS)
  const waitMS = Number.isFinite(configuredWait)
    ? Math.min(90_000, Math.max(5_000, configuredWait))
    : 90_000
  const deadline = Date.now() + waitMS
  let latest
  let latestRows = []
  while (Date.now() < deadline) {
    if (desktopState.child.exitCode !== null || desktopState.child.signalCode !== null) {
      fail('INSTALLED_DESKTOP_EXITED_DURING_AX')
    }
    const rows = await runReadonlyProbe(
      runtime,
      probe,
      'ax',
      [desktopState.child.pid],
      'INSTALLED_UI_AX_READ_FAILED',
    )
    latestRows = rows
    latest = installedUISnapshot(rows)
    if (
      latest.editor?.enabled === true &&
      latest.send_actions.length > 0 &&
      latest.stop_actions.length === 0 &&
      latest.session_title_relative_bounds &&
      latest.source_message_visible &&
      latest.recovering_visible === expectRecovering
    ) {
      return latest
    }
    await sleep(300)
  }
  if (process.env.HEXCLAW_LIVE_DEBUG === '1') {
    process.stderr.write(
      `${JSON.stringify({
        installed_ui_snapshot: latest ?? null,
        visible_ax_sample: visibleRows(latestRows)
          .map((row) => ({ role: row.role, text: rowText(row), bounds: row.bounds }))
          .filter((row) => row.text || row.role === 'AXWindow' || row.role === 'AXTextArea')
          .slice(0, 80),
      })}\n`,
    )
  }
  const exposedRoles = new Set(
    visibleRows(latestRows)
      .map((row) => row?.role)
      .filter((role) => typeof role === 'string' && role !== ''),
  )
  if (
    exposedRoles.size > 0 &&
    [...exposedRoles].every((role) =>
      ['AXApplication', 'AXMenuBar', 'AXMenuBarItem', 'AXMenu'].includes(role),
    )
  ) {
    fail('INSTALLED_UI_WEBVIEW_AX_TREE_UNAVAILABLE', sha256(JSON.stringify([...exposedRoles])))
  }
  fail('INSTALLED_UI_STATE_TIMEOUT', sha256(JSON.stringify(latest ?? {})))
}

async function evidenceDirectory(env) {
  const configured =
    typeof env.HEXCLAW_EVIDENCE_DIR === 'string' ? env.HEXCLAW_EVIDENCE_DIR.trim() : ''
  if (configured !== '') {
    const directory = resolve(configured)
    await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
    const info = await stat(directory)
    if (!info.isDirectory()) fail('EVIDENCE_DIRECTORY_INVALID')
    return directory
  }
  const directory = await mkdtemp('/tmp/hexclaw-recovering-lock-ui-evidence-')
  await chmod(directory, PRIVATE_DIRECTORY_MODE)
  return directory
}

async function captureInstalledWindow(runtime, probe, desktopState, destination) {
  const window = await runReadonlyProbe(
    runtime,
    probe,
    'window',
    [desktopState.child.pid],
    'INSTALLED_UI_WINDOW_READ_FAILED',
  )
  if (!Number.isInteger(window?.window_id) || window.window_id <= 0) {
    fail('INSTALLED_UI_WINDOW_INVALID')
  }
  await runCommand(
    '/usr/sbin/screencapture',
    ['-x', '-l', String(window.window_id), destination],
    { cwd: runtime.root, env: runtime.environment, timeout: 30_000 },
    'INSTALLED_UI_SCREENSHOT_FAILED',
  )
  const info = await requireFile(destination, 'INSTALLED_UI_SCREENSHOT_INVALID')
  if (info.size <= 1_024) fail('INSTALLED_UI_SCREENSHOT_INVALID')
  return { bytes: info.size, sha256: await sha256File(destination) }
}

function assertUnlockedGeometry(baseline, recovering) {
  for (const snapshot of [baseline, recovering]) {
    if (
      snapshot.editor?.enabled !== true ||
      snapshot.send_actions.length === 0 ||
      snapshot.stop_actions.length !== 0 ||
      !snapshot.session_title_relative_bounds
    ) {
      fail('INSTALLED_UI_UNLOCKED_PROJECTION_INVALID')
    }
  }
  for (const key of ['x', 'y', 'width', 'height']) {
    if (
      Math.abs(
        Number(baseline.session_title_relative_bounds[key]) -
          Number(recovering.session_title_relative_bounds[key]),
      ) > 1
    ) {
      fail('INSTALLED_UI_SESSION_SPINNER_GEOMETRY_DRIFT')
    }
  }
  if (baseline.recovering_visible || !recovering.recovering_visible) {
    fail('INSTALLED_UI_RECOVERING_VISIBILITY_INVALID')
  }
  return {
    composer_enabled: true,
    send_action_present: true,
    stop_action_absent: true,
    session_spinner_absent: true,
    session_title_relative_bounds: recovering.session_title_relative_bounds,
  }
}

async function waitPortReleased(port) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const server = createServer()
    server.unref()
    const available = await new Promise((resolveCheck) => {
      server.once('error', () => resolveCheck(false))
      server.listen(port, '127.0.0.1', () => server.close(() => resolveCheck(true)))
    })
    if (available) return
    await sleep(100)
  }
  fail('SIDECAR_PORT_NOT_RELEASED')
}

function normalizeExpectedStatus(value) {
  return Array.isArray(value) ? value : [value]
}

async function apiRequest(runtime, phase, method, pathname, options = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeout ?? 20_000)
  const headers = { Accept: 'application/json' }
  if (options.capability) headers.Authorization = `Bearer ${options.capability}`
  let body
  if (options.json !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(options.json)
  } else if (options.form !== undefined) {
    body = options.form
  }
  runtime.requestJournal.push(`${phase}:${method} ${pathname.split('?', 1)[0]}`)
  let response
  let raw = ''
  try {
    response = await fetch(`${runtime.baseURL}${pathname}`, {
      method,
      headers,
      body,
      redirect: 'error',
      signal: controller.signal,
    })
    raw = await response.text()
  } catch {
    fail(options.code ?? 'PUBLIC_API_REQUEST_FAILED')
  } finally {
    clearTimeout(timer)
  }
  if (!normalizeExpectedStatus(options.status ?? 200).includes(response.status)) {
    fail(options.code ?? 'PUBLIC_API_STATUS_INVALID', sha256(raw))
  }
  if (options.parse === false) return { status: response.status }
  try {
    return JSON.parse(raw)
  } catch {
    fail(options.code ?? 'PUBLIC_API_JSON_INVALID', sha256(raw))
  }
}

async function waitForSidecar(runtime, sidecar, capability) {
  const deadline = Date.now() + SIDE_CAR_START_MS
  while (Date.now() < deadline) {
    if (sidecar.child.exitCode !== null || sidecar.child.signalCode !== null) {
      fail('SIDECAR_EXITED_BEFORE_READY')
    }
    try {
      return await apiRequest(runtime, 'control', 'GET', '/api/v1/version', {
        capability,
        status: 200,
        timeout: 2_000,
        code: 'SIDECAR_NOT_READY',
      })
    } catch (error) {
      if (safeCode(error) !== 'SIDECAR_NOT_READY') throw error
    }
    await sleep(150)
  }
  fail('SIDECAR_START_TIMEOUT')
}

async function prepareRuntime(env, deadline) {
  const owned = await createRunRoot()
  for (const directory of ['bin', 'tmp', '.hexclaw']) {
    await mkdir(join(owned.root, directory), { mode: PRIVATE_DIRECTORY_MODE })
  }
  const sourceRoot = resolve(env.HEXCLAW_SOURCE_ROOT || DEFAULT_SOURCE_ROOT)
  const sidecarInput = resolve(env.HEXCLAW_SIDECAR_BINARY || DEFAULT_SIDECAR)
  const goBinary = resolve(
    env.HEXCLAW_GO_BIN ||
      (typeof env.GOROOT === 'string' && env.GOROOT !== ''
        ? join(env.GOROOT, 'bin', 'go')
        : '/usr/local/go/bin/go'),
  )
  await requireDirectory(sourceRoot, 'SOURCE_ROOT_UNAVAILABLE')
  await requireFile(join(sourceRoot, 'go.mod'), 'SOURCE_MODULE_UNAVAILABLE')
  await requireFile(sidecarInput, 'INSTALLED_SIDECAR_UNAVAILABLE', { executable: true })
  await requireFile(goBinary, 'GO_BINARY_UNAVAILABLE', { executable: true })
  await requireFile(PROFILE_HELPER, 'PROFILE_HELPER_UNAVAILABLE')

  const sidecar = join(owned.root, 'bin', 'hexclaw')
  const helper = join(owned.root, 'bin', 'recovering-lock-profile-fixture')
  const config = join(owned.root, '.hexclaw', 'hexclaw.yaml')
  const store = join(owned.root, 'data.db')
  await copyFile(sidecarInput, sidecar, fsConstants.COPYFILE_EXCL)
  await chmod(sidecar, 0o700)
  await createPrivateFile(store)
  const environment = boundedEnvironment(env, owned.root)
  await runCommand(
    goBinary,
    ['build', '-trimpath', '-o', helper, PROFILE_HELPER],
    {
      cwd: sourceRoot,
      env: environment,
      timeout: Math.min(4 * 60_000, Math.max(1, deadline - Date.now())),
    },
    'PROFILE_HELPER_BUILD_FAILED',
  )
  await requireFile(helper, 'PROFILE_HELPER_BUILD_INVALID', { executable: true })
  const sidecarPort = await reservePort()
  let providerPort = await reservePort()
  if (providerPort === sidecarPort || providerPort === sidecarPort + 1)
    providerPort = await reservePort()
  const endpoint = `http://127.0.0.1:${providerPort}/v1`
  const prepared = await runCommand(
    helper,
    [
      '--target-config',
      config,
      '--store',
      store,
      '--profile',
      owned.root,
      '--endpoint',
      endpoint,
      '--port',
      String(sidecarPort),
    ],
    { cwd: sourceRoot, env: environment, timeout: 30_000 },
    'PROFILE_PREPARE_FAILED',
  )
  let helperReceipt
  try {
    helperReceipt = JSON.parse(prepared.stdout)
  } catch {
    fail('PROFILE_PREPARE_RECEIPT_INVALID')
  }
  if (
    helperReceipt?.status !== 'prepared' ||
    helperReceipt?.provider !== PROVIDER ||
    helperReceipt?.model !== MODEL ||
    helperReceipt?.dingtalk_enabled !== false ||
    helperReceipt?.direct_database_touched !== false ||
    !SHA256.test(helperReceipt?.config_sha256 ?? '') ||
    !SHA256.test(helperReceipt?.endpoint_sha256 ?? '')
  ) {
    fail('PROFILE_PREPARE_RECEIPT_INVALID')
  }
  await requireFile(config, 'ISOLATED_CONFIG_INVALID', { privateFile: true })
  const inputSHA = await sha256File(sidecarInput)
  const runtimeSHA = await sha256File(sidecar)
  if (inputSHA !== runtimeSHA) fail('INSTALLED_SIDECAR_COPY_DRIFT')
  return {
    ...owned,
    sourceRoot,
    sidecar,
    helper,
    config,
    store,
    environment,
    sidecarPort,
    providerPort,
    baseURL: `http://127.0.0.1:${sidecarPort}`,
    requestJournal: [],
    evidence: {
      installed_sidecar_sha256: inputSHA,
      runtime_sidecar_sha256: runtimeSHA,
      exact_binary_copy: true,
      helper_sha256: await sha256File(helper),
      config_sha256: helperReceipt.config_sha256,
      endpoint_sha256: helperReceipt.endpoint_sha256,
      dingtalk_enabled: false,
      direct_database_touched: false,
    },
  }
}

async function seedPublicInputs(runtime, capability) {
  const suffix = randomUUID()
  const agent = `recovering-lock-${suffix}`
  const session = `session-${suffix}`
  const message = `message-${suffix}`
  await apiRequest(runtime, 'initial', 'POST', '/api/v1/agents', {
    capability,
    json: {
      name: agent,
      display_name: SESSION_TITLE,
      description: 'K12 recovering public API fixture',
      provider: PROVIDER,
      model: MODEL,
      system_prompt: 'Use the supplied image only.',
      skills: [],
      metadata: {
        scenario: 'k12-tutor',
        'k12.learner_id': agent,
        'k12.child_name': 'Fixture',
        'k12.grade_term': '五年级下',
      },
    },
    status: 200,
    code: 'AGENT_CREATE_FAILED',
  })
  await apiRequest(runtime, 'initial', 'POST', '/api/v1/sessions?user_id=desktop-user', {
    capability,
    json: { id: session, title: SESSION_TITLE, user_id: 'desktop-user' },
    status: 201,
    code: 'SESSION_CREATE_FAILED',
  })
  await apiRequest(
    runtime,
    'initial',
    'POST',
    `/api/v1/sessions/${encodeURIComponent(session)}/messages?user_id=desktop-user`,
    {
      capability,
      json: { id: message, role: 'user', content: SOURCE_MESSAGE },
      status: 201,
      code: 'MESSAGE_CREATE_FAILED',
    },
  )
  const form = new FormData()
  form.append('file', new Blob([TINY_PNG], { type: 'image/png' }), 'recovery-fixture.png')
  const uploaded = await apiRequest(
    runtime,
    'initial',
    'POST',
    `/api/k12/assets?agent=${encodeURIComponent(agent)}`,
    {
      capability,
      form,
      status: 200,
      timeout: 30_000,
      code: 'ASSET_UPLOAD_FAILED',
    },
  )
  const asset = nonEmpty(uploaded?.asset_id, 'ASSET_UPLOAD_INVALID')
  return { agent, session, message, asset }
}

async function createPublicImageTask(runtime, capability, identity) {
  const created = await apiRequest(runtime, 'initial', 'POST', '/api/k12/image-tasks', {
    capability,
    json: {
      agent: identity.agent,
      source_session: identity.session,
      source_kind: 'desktop',
      source_ref: identity.message,
      source_asset_refs: [identity.asset],
      message_intent: 'This is completed math homework. Grade it problem by problem.',
      attempt_generation: 1,
      route_request: {
        provider: PROVIDER,
        model: MODEL,
        selection_source: 'explicit',
      },
    },
    status: 200,
    code: 'IMAGE_TASK_CREATE_FAILED',
  })
  const dispatchID = nonEmpty(created?.dispatch?.dispatch_id, 'IMAGE_TASK_CREATE_INVALID')
  return { ...identity, dispatchID }
}

async function createPublicState(runtime, capability) {
  return createPublicImageTask(runtime, capability, await seedPublicInputs(runtime, capability))
}

async function primeVisionCapabilityReceipt(runtime, capability) {
  const llmConfig = await apiRequest(runtime, 'initial', 'GET', '/api/v1/config/llm', {
    capability,
    status: 200,
    code: 'LLM_CONFIG_READ_FAILED',
  })
  const providerInstanceID = nonEmpty(
    llmConfig?.providers?.[PROVIDER]?.provider_instance_id,
    'PROVIDER_INSTANCE_ID_UNAVAILABLE',
  )
  const probed = await apiRequest(runtime, 'initial', 'POST', '/api/v1/config/llm/probe', {
    capability,
    json: {
      provider_instance_id: providerInstanceID,
      model: MODEL,
      kinds: ['vision'],
    },
    status: 200,
    timeout: 30_000,
    code: 'VISION_CAPABILITY_PROBE_FAILED',
  })
  const results = Array.isArray(probed?.results) ? probed.results : []
  const result = results[0]
  if (
    probed?.provider_instance_id !== providerInstanceID ||
    probed?.model !== MODEL ||
    results.length !== 1 ||
    result?.probe_kind !== 'vision' ||
    result?.outcome !== 'passed' ||
    result?.persisted !== true
  ) {
    fail('VISION_CAPABILITY_PROBE_INVALID')
  }
  return { provider_instance_id_sha256: sha256(providerInstanceID), persisted: true }
}

async function waitRecovering(runtime, phase, capability, identity) {
  const pathname = `/api/k12/image-tasks/${encodeURIComponent(
    identity.dispatchID,
  )}?agent=${encodeURIComponent(identity.agent)}`
  const deadline = Date.now() + RECOVERING_WAIT_MS
  let latest
  while (Date.now() < deadline) {
    latest = await apiRequest(runtime, phase, 'GET', pathname, {
      capability,
      status: 200,
      code: 'IMAGE_TASK_READ_FAILED',
    })
    try {
      assertRecoveringProjection(latest)
      return latest
    } catch (error) {
      if (safeCode(error) !== 'PUBLIC_RECOVERING_DTO_INVALID') throw error
    }
    await sleep(200)
  }
  if (process.env.HEXCLAW_LIVE_DEBUG === '1') {
    const dispatch = latest?.dispatch
    process.stderr.write(
      `${JSON.stringify({
        recovering_dto_debug: {
          status: dispatch?.status ?? null,
          retryable: dispatch?.retryable ?? null,
          failure_kind: dispatch?.failure_kind ?? null,
          progress_operation: dispatch?.progress?.operation ?? null,
          progress_state: dispatch?.progress?.state ?? null,
          version: dispatch?.version ?? null,
        },
      })}\n`,
    )
  }
  fail('PUBLIC_RECOVERING_DTO_TIMEOUT', sha256(JSON.stringify(latest ?? {})))
}

function restartBusinessRequests(runtime) {
  return runtime.requestJournal
    .filter((entry) => entry.startsWith('restart:'))
    .map((entry) => entry.slice('restart:'.length))
    .filter((entry) => entry.includes('/api/k12/'))
}

function redactedIdentity(identity) {
  return {
    agent_sha256: sha256(identity.agent),
    session_sha256: sha256(identity.session),
    source_message_sha256: sha256(identity.message),
    asset_sha256: sha256(identity.asset),
    dispatch_sha256: sha256(identity.dispatchID),
  }
}

async function writeEvidence(env, evidence) {
  const configured =
    typeof env.HEXCLAW_EVIDENCE_DIR === 'string' ? env.HEXCLAW_EVIDENCE_DIR.trim() : ''
  if (configured === '') return null
  const directory = resolve(configured)
  await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
  const info = await stat(directory)
  if (!info.isDirectory()) fail('EVIDENCE_DIRECTORY_INVALID')
  const filename = `k12-recovering-lock-public-api-${Date.now()}-${randomBytes(4).toString('hex')}.json`
  await createPrivateFile(join(directory, filename), `${JSON.stringify(evidence, null, 2)}\n`)
  return filename
}

export async function runLayerA(env = process.env) {
  const startedAt = Date.now()
  const deadline = startedAt + LIVE_BUDGET_MS
  await loadContract()
  let runtime
  let transport
  let sidecar
  const logs = []
  try {
    runtime = await prepareRuntime(env, deadline)
    transport = await startAmbiguousVisionTransport(runtime.providerPort)

    const firstCapability = randomBytes(32).toString('hex')
    sidecar = startSidecar(runtime, firstCapability)
    const version = await waitForSidecar(runtime, sidecar, firstCapability)
    const capabilityProbe = await primeVisionCapabilityReceipt(runtime, firstCapability)
    const identity = await createPublicState(runtime, firstCapability)
    const before = await waitRecovering(runtime, 'initial', firstCapability, identity)
    const firstProjection = assertRecoveringProjection(before)
    if (
      transport.state.image_posts !== 2 ||
      transport.state.passed_image_posts !== 1 ||
      transport.state.dropped_image_posts !== 1 ||
      transport.state.provider_posts !== 2
    ) {
      fail('AMBIGUOUS_PROVIDER_POST_CARDINALITY_INVALID')
    }
    const providerBefore = transport.state.provider_posts
    logs.push(await stopSidecar(sidecar))
    sidecar = null
    await waitPortReleased(runtime.sidecarPort)

    const secondCapability = randomBytes(32).toString('hex')
    if (secondCapability === firstCapability) fail('CAPABILITY_ROTATION_FAILED')
    sidecar = startSidecar(runtime, secondCapability)
    await waitForSidecar(runtime, sidecar, secondCapability)
    const after = await waitRecovering(runtime, 'restart', secondCapability, identity)
    await apiRequest(
      runtime,
      'restart',
      'GET',
      `/api/k12/image-tasks/${encodeURIComponent(
        identity.dispatchID,
      )}/result?agent=${encodeURIComponent(identity.agent)}`,
      {
        capability: secondCapability,
        status: 200,
        code: 'IMAGE_TASK_RESULT_READ_FAILED',
      },
    )
    await sleep(500)
    const providerAfter = transport.state.provider_posts
    const restart = assertRestartQueryOnly(before, after, {
      provider_posts_before: providerBefore,
      provider_posts_after: providerAfter,
      restart_business_requests: restartBusinessRequests(runtime),
    })
    logs.push(await stopSidecar(sidecar))
    sidecar = null
    await waitPortReleased(runtime.sidecarPort)

    const evidence = {
      schema_version: 1,
      status: 'passed',
      scope: 'layer_a_public_dto_restart_query_only',
      elapsed_ms: Date.now() - startedAt,
      runtime: runtime.evidence,
      installed_version: typeof version?.version === 'string' ? version.version : 'unknown',
      identity: redactedIdentity(identity),
      public_projection: {
        dispatch_status: firstProjection.dispatch_status,
        version: firstProjection.version,
        retryable: firstProjection.retryable,
        progress_operation: firstProjection.progress_operation,
        progress_state: firstProjection.progress_state,
        dispatch_id_sha256: sha256(firstProjection.dispatch_id),
        internal_outcome_unknown_visible: false,
      },
      provider_boundary: {
        capability_probe: capabilityProbe,
        provider_posts: providerAfter,
        image_posts: transport.state.image_posts,
        passed_image_posts: transport.state.passed_image_posts,
        dropped_image_posts: transport.state.dropped_image_posts,
        restart_provider_post_delta: providerAfter - providerBefore,
      },
      restart: {
        dispatch_id_sha256: sha256(restart.dispatch_id),
        version: restart.version,
        provider_post_delta: restart.provider_post_delta,
        business_methods: restart.restart_business_methods,
        query_only: restart.query_only,
        create_confirm_retry_generate_delta: 0,
      },
      external_boundaries: {
        real_model_calls: 0,
        real_im_sends: 0,
        dingtalk_sends: 0,
        loopback_fake_transport_only: true,
      },
      process_logs: logs,
      layers: {
        a: { status: 'passed' },
        b: { status: 'not_run', code: 'INSTALLED_UI_EVIDENCE_REQUIRED' },
        c: {
          status: 'not_applicable',
          code: 'PROVIDER_QUERY_IDENTITY_UNAVAILABLE',
          conditional: true,
        },
      },
    }
    const evidenceFile = await writeEvidence(env, evidence)
    if (evidenceFile) evidence.evidence_file = evidenceFile
    return evidence
  } finally {
    if (sidecar) {
      try {
        await stopSidecar(sidecar)
      } catch {
        // 清理失败不会被改写成通过证据。
      }
    }
    if (transport) {
      try {
        await transport.close()
      } catch {
        // 精确临时根仍由当前运行清理。
      }
    }
    if (runtime) await cleanupRunRoot(runtime)
  }
}

async function runInstalledUIPhase({ runtime, desktop, probe, expectRecovering, screenshotPath }) {
  if ((await installedDesktopPIDs(desktop)).length !== 0) {
    fail('INSTALLED_DESKTOP_ALREADY_RUNNING')
  }
  const desktopState = startInstalledDesktop(runtime, desktop)
  let snapshot
  let screenshot
  let processLog
  try {
    await waitForInstalledDesktop(runtime, desktopState)
    snapshot = await waitForInstalledUISnapshot(runtime, probe, desktopState, expectRecovering)
    screenshot = await captureInstalledWindow(runtime, probe, desktopState, screenshotPath)
  } finally {
    processLog = await stopInstalledDesktop(desktopState)
    if (process.env.HEXCLAW_LIVE_DEBUG === '1') {
      const raw = desktopState.collector.debugTail()
      const sanitize = (value) =>
        value
          .replaceAll(runtime.root, '<test-home>')
          .replace(/\/Users\/[^/\s]+/gu, '<user-home>')
          .replace(/(authorization\s*[:=]\s*)([^\s,;]+)/giu, '$1<redacted>')
          .replace(/(bearer\s+)([^\s,;]+)/giu, '$1<redacted>')
      process.stderr.write(
        `${JSON.stringify({
          installed_desktop_log_tail: {
            stdout: sanitize(raw.stdout),
            stderr: sanitize(raw.stderr),
          },
        })}\n`,
      )
    }
    await sleep(500)
    await stopOwnedInstalledSidecar(runtime)
    await waitPortReleased(runtime.sidecarPort)
  }
  return { snapshot, screenshot, process_log: processLog }
}

export async function runLayerB(env = process.env) {
  const startedAt = Date.now()
  const deadline = startedAt + LIVE_BUDGET_MS
  await loadContract()
  let runtime
  let transport
  let sidecar
  const processLogs = []
  try {
    runtime = await prepareRuntime(env, deadline)
    const desktop = resolve(env.HEXCLAW_DESKTOP_BINARY || DEFAULT_DESKTOP)
    await requireFile(desktop, 'INSTALLED_DESKTOP_UNAVAILABLE', { executable: true })
    if ((await installedDesktopPIDs(desktop)).length !== 0) {
      fail('INSTALLED_DESKTOP_ALREADY_RUNNING')
    }
    const desktopSHA256 = await sha256File(desktop)
    const probe = await compileReadonlyProbe(runtime, deadline)
    const preflight = await runReadonlyProbe(
      runtime,
      probe,
      'preflight',
      [],
      'INSTALLED_UI_PREFLIGHT_FAILED',
    )
    if (preflight?.accessibility !== true) fail('ACCESSIBILITY_PERMISSION_REQUIRED')
    if (preflight?.screen_capture !== true) fail('SCREEN_CAPTURE_PERMISSION_REQUIRED')
    const evidenceRoot = await evidenceDirectory(env)
    const evidencePrefix = `k12-recovering-lock-${Date.now()}-${randomBytes(4).toString('hex')}`
    const referencePath = join(evidenceRoot, `${evidencePrefix}-reference.png`)
    const implementationPath = join(evidenceRoot, `${evidencePrefix}-implementation.png`)
    const differencePath = join(evidenceRoot, `${evidencePrefix}-pixel-diff.png`)

    transport = await startAmbiguousVisionTransport(runtime.providerPort)
    const firstCapability = randomBytes(32).toString('hex')
    sidecar = startSidecar(runtime, firstCapability)
    await waitForSidecar(runtime, sidecar, firstCapability)
    const capabilityProbe = await primeVisionCapabilityReceipt(runtime, firstCapability)
    const seed = await seedPublicInputs(runtime, firstCapability)
    if (
      transport.state.provider_posts !== 1 ||
      transport.state.image_posts !== 1 ||
      transport.state.passed_image_posts !== 1 ||
      transport.state.dropped_image_posts !== 0
    ) {
      fail('BASELINE_PROVIDER_POST_CARDINALITY_INVALID')
    }
    processLogs.push(await stopSidecar(sidecar))
    sidecar = null
    await waitPortReleased(runtime.sidecarPort)

    const baseline = await runInstalledUIPhase({
      runtime,
      desktop,
      probe,
      expectRecovering: false,
      screenshotPath: referencePath,
    })
    processLogs.push(baseline.process_log)
    if (transport.state.provider_posts !== 1) fail('BASELINE_UI_PROVIDER_POST_INVALID')

    const secondCapability = randomBytes(32).toString('hex')
    sidecar = startSidecar(runtime, secondCapability)
    await waitForSidecar(runtime, sidecar, secondCapability)
    const identity = await createPublicImageTask(runtime, secondCapability, seed)
    const before = await waitRecovering(runtime, 'initial', secondCapability, identity)
    const firstProjection = assertRecoveringProjection(before)
    if (
      transport.state.provider_posts !== 2 ||
      transport.state.image_posts !== 2 ||
      transport.state.passed_image_posts !== 1 ||
      transport.state.dropped_image_posts !== 1
    ) {
      fail('AMBIGUOUS_PROVIDER_POST_CARDINALITY_INVALID')
    }
    const providerBeforeUI = transport.state.provider_posts
    processLogs.push(await stopSidecar(sidecar))
    sidecar = null
    await waitPortReleased(runtime.sidecarPort)

    const recovering = await runInstalledUIPhase({
      runtime,
      desktop,
      probe,
      expectRecovering: true,
      screenshotPath: implementationPath,
    })
    processLogs.push(recovering.process_log)
    if (transport.state.provider_posts !== providerBeforeUI) {
      fail('INSTALLED_UI_RECOVERY_REDISPATCHED')
    }
    const unlocked = assertUnlockedGeometry(baseline.snapshot, recovering.snapshot)

    const thirdCapability = randomBytes(32).toString('hex')
    sidecar = startSidecar(runtime, thirdCapability)
    await waitForSidecar(runtime, sidecar, thirdCapability)
    const after = await waitRecovering(runtime, 'restart', thirdCapability, identity)
    await apiRequest(
      runtime,
      'restart',
      'GET',
      `/api/k12/image-tasks/${encodeURIComponent(
        identity.dispatchID,
      )}/result?agent=${encodeURIComponent(identity.agent)}`,
      {
        capability: thirdCapability,
        status: 200,
        code: 'IMAGE_TASK_RESULT_READ_FAILED',
      },
    )
    await sleep(500)
    const restart = assertRestartQueryOnly(before, after, {
      provider_posts_before: providerBeforeUI,
      provider_posts_after: transport.state.provider_posts,
      restart_business_requests: restartBusinessRequests(runtime),
    })
    processLogs.push(await stopSidecar(sidecar))
    sidecar = null
    await waitPortReleased(runtime.sidecarPort)

    const pixelDifference = await runReadonlyProbe(
      runtime,
      probe,
      'diff',
      [referencePath, implementationPath, differencePath],
      'INSTALLED_UI_PIXEL_DIFF_FAILED',
    )
    const differenceInfo = await requireFile(differencePath, 'INSTALLED_UI_PIXEL_DIFF_INVALID')
    if (differenceInfo.size <= 1_024) fail('INSTALLED_UI_PIXEL_DIFF_INVALID')

    const evidence = {
      schema_version: 1,
      status: 'passed',
      scope: 'layer_b_installed_ui_real_public_recovering_dto',
      elapsed_ms: Date.now() - startedAt,
      runtime: {
        ...runtime.evidence,
        installed_desktop_sha256: desktopSHA256,
        readonly_probe_sha256: await sha256File(probe),
      },
      identity: redactedIdentity(identity),
      public_projection: {
        dispatch_status: firstProjection.dispatch_status,
        version: firstProjection.version,
        retryable: firstProjection.retryable,
        progress_operation: firstProjection.progress_operation,
        progress_state: firstProjection.progress_state,
        dispatch_id_sha256: sha256(firstProjection.dispatch_id),
      },
      provider_boundary: {
        capability_probe: capabilityProbe,
        provider_posts: transport.state.provider_posts,
        passed_image_posts: transport.state.passed_image_posts,
        dropped_image_posts: transport.state.dropped_image_posts,
        installed_ui_provider_post_delta: transport.state.provider_posts - providerBeforeUI,
      },
      installed_ui: {
        ...unlocked,
        recovering_visible: true,
        source_message_visible: true,
        baseline_progress_indicators: baseline.snapshot.progress_indicators.length,
        recovering_progress_indicators: recovering.snapshot.progress_indicators.length,
        task_shell_same_dispatch_query_only: restart.query_only,
      },
      screenshots: {
        reference: { path: referencePath, ...baseline.screenshot },
        implementation: { path: implementationPath, ...recovering.screenshot },
        pixel_difference: {
          path: differencePath,
          bytes: differenceInfo.size,
          sha256: await sha256File(differencePath),
          ...pixelDifference,
          dynamic_business_content_is_not_an_acceptance_failure: true,
        },
      },
      restart: {
        dispatch_id_sha256: sha256(restart.dispatch_id),
        version: restart.version,
        provider_post_delta: restart.provider_post_delta,
        business_methods: restart.restart_business_methods,
        create_confirm_retry_generate_delta: 0,
      },
      external_boundaries: {
        real_model_calls: 0,
        real_im_sends: 0,
        dingtalk_sends: 0,
        loopback_fake_transport_only: true,
        foreground_input_automation: false,
        webview_injection: false,
      },
      process_logs: processLogs,
      layers: {
        a: { status: 'passed_as_prerequisite' },
        b: { status: 'passed' },
        c: {
          status: 'not_applicable',
          code: 'PROVIDER_QUERY_IDENTITY_UNAVAILABLE',
          conditional: true,
        },
      },
    }
    const evidencePath = join(evidenceRoot, `${evidencePrefix}-summary.json`)
    await createPrivateFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)
    evidence.evidence_file = evidencePath
    return evidence
  } finally {
    if (sidecar) {
      try {
        await stopSidecar(sidecar)
      } catch {
        // 清理失败不会被改写成通过证据。
      }
    }
    if (runtime) {
      try {
        await stopOwnedInstalledSidecar(runtime)
      } catch {
        // 精确临时根仍由当前运行清理。
      }
    }
    if (transport) {
      try {
        await transport.close()
      } catch {
        // fake transport 只绑定当前随机回环端口。
      }
    }
    if (runtime) await cleanupRunRoot(runtime)
  }
}

function failureReceipt(error) {
  const receipt = { status: 'failed', code: safeCode(error) }
  if (SHA256.test(error?.diagnosticSHA256 ?? '')) {
    receipt.diagnostic_sha256 = error.diagnosticSHA256
  }
  return receipt
}

function usage() {
  return [
    'Usage:',
    '  node tests/live/k12-recovering-lock-public-api-headless.mjs validate',
    '  HEXCLAW_SIDECAR_BINARY=/Applications/HexClaw.app/Contents/MacOS/hexclaw \\',
    '    node tests/live/k12-recovering-lock-public-api-headless.mjs run-a',
    '  HEXCLAW_DESKTOP_BINARY=/Applications/HexClaw.app/Contents/MacOS/hexclaw-desktop \\',
    '    node tests/live/k12-recovering-lock-public-api-headless.mjs run-b',
    '',
    'run-a proves Layer A. run-b opens the isolated installed App without clicks or input and',
    'proves Layer B. Provider reconciliation remains conditional on query identity (Layer C).',
  ].join('\n')
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const command = argv[0] ?? 'validate'
  if (command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(`${usage()}\n`)
    return
  }
  try {
    let receipt
    if (command === 'validate') {
      await loadContract()
      receipt = { ...staticValidation(), layers: layerSupport() }
    } else if (command === 'run-a') {
      receipt = await runLayerA(env)
    } else if (command === 'run-b') {
      receipt = await runLayerB(env)
    } else {
      fail('COMMAND_INVALID')
    }
    process.stdout.write(`${JSON.stringify(receipt)}\n`)
  } catch (error) {
    process.stdout.write(`${JSON.stringify(failureReceipt(error))}\n`)
    process.exitCode = 1
  }
}

const invoked =
  process.argv[1] && isAbsolute(resolve(process.argv[1]))
    ? pathToFileURL(resolve(process.argv[1])).href
    : ''
if (invoked === import.meta.url) await main()
