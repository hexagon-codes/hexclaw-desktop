#!/usr/bin/env node

/**
 * K12 recovering 会话执行锁最终安装包门禁。
 *
 * `validate` 只做源码、脚本与安装包身份的静态校验，不启动应用。`run` 直接执行
 * `/Applications/HexClaw.app/Contents/MacOS/hexclaw-desktop` 的精确字节，使用隔离
 * Test Home、离线持久夹具、正常只读 API、只读 AX 与窗口截图验证 recovering 不占用
 * SessionExecutionRegistry 的用户可见投影。脚本不注入 WebView，不执行点击、键盘、剪贴板、
 * 模型或 IM 操作。
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
  readdirSync,
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
const hexclawRoot = resolve(repoRoot, '../hexclaw')
const docsRoot = resolve(repoRoot, '../hexclaw-docs')
const evidenceRoot = resolve(
  process.env.HEXCLAW_RECOVERING_LOCK_EVIDENCE ||
    join(docsRoot, 'test/evidence/bug-k12-recovering-execution-lock-20260824'),
)
const installedBundle = '/Applications/HexClaw.app'
const installedExecutable = join(installedBundle, 'Contents/MacOS/hexclaw-desktop')
const installedSidecar = join(installedBundle, 'Contents/MacOS/hexclaw')
const installedInfoPlist = join(installedBundle, 'Contents/Info.plist')
const expectedInstalledDesktopSHA256 =
  '6e00622437fe09bd13aaeccbcd50ec96145dbbc226f823a3fd4d6cdd70a7a147'
const expectedInstalledSidecarSHA256 =
  '9d66400f9ddc83f1ab9847947b98fc3cd47f79cc1156d5a78f6b24282b1a7ea2'
const runOptIn = 'HEXCLAW_RUN_RECOVERING_LOCK_INSTALLED'
const foregroundOptIn = 'HEXCLAW_ALLOW_FOREGROUND_NATIVE_UI'
const apiToken = 'recovering-lock-isolated-api-token'
const sessionTitle = 'K12 recovering query-only gate'
const sourceMessageText = 'Recovering query-only fixture message'
const recoveryText = '正在恢复批改结果'
const commandTimeoutMs = 10 * 60_000
const sleep = (milliseconds) =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds))

function usage() {
  return `Usage:
  node tests/native/bug-20260824-recovering-execution-lock-installed.mjs --help
  node tests/native/bug-20260824-recovering-execution-lock-installed.mjs validate
  ${runOptIn}=1 ${foregroundOptIn}=1 node tests/native/bug-20260824-recovering-execution-lock-installed.mjs run

Commands:
  validate  Static-only validation. Does not launch an App or call AX at runtime.
  run       Directly launch the exact installed Desktop in an isolated Test Home.

The run command opens a native application window. Both explicit opt-ins are required.
It performs no WebView injection, foreground automation, click, key, clipboard, model, or IM action.
`
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function sha256Text(value) {
  return createHash('sha256').update(String(value)).digest('hex')
}

function writeJSON(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

function installedArtifactIdentity() {
  for (const path of [installedExecutable, installedSidecar, installedInfoPlist]) {
    assert.ok(existsSync(path) && statSync(path).isFile(), `installed artifact missing: ${path}`)
  }
  const identifier = execFileSync(
    'plutil',
    ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', installedInfoPlist],
    { encoding: 'utf8' },
  ).trim()
  const version = execFileSync(
    'plutil',
    ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', installedInfoPlist],
    { encoding: 'utf8' },
  ).trim()
  const desktopSHA256 = sha256File(installedExecutable)
  const sidecarSHA256 = sha256File(installedSidecar)
  assert.equal(identifier, 'com.hexclaw.desktop', 'installed bundle identifier drifted')
  assert.equal(version, '0.5.0-beta', 'installed version drifted')
  assert.equal(
    desktopSHA256,
    expectedInstalledDesktopSHA256,
    'installed Desktop is not the final candidate',
  )
  assert.equal(
    sidecarSHA256,
    expectedInstalledSidecarSHA256,
    'installed Sidecar is not the final candidate',
  )
  return { identifier, version, desktopSHA256, sidecarSHA256 }
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
  assert.ok(![16060, 11434].includes(port), `forbidden shared port selected: ${port}`)
  return port
}

function listenerPIDs(port) {
  try {
    return execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
      encoding: 'utf8',
    })
      .split(/\s+/u)
      .filter(Boolean)
      .map(Number)
  } catch {
    return []
  }
}

function existingInstalledDesktopPIDs() {
  const rows = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
  return rows
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const match = line.match(/^(\d+)\s+(.+)$/u)
      if (!match) return []
      const command = match[2]
      return command === installedExecutable || command.startsWith(`${installedExecutable} `)
        ? [Number(match[1])]
        : []
    })
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

function sqliteRows(databasePath, sql) {
  const output = execFileSync('sqlite3', ['-json', databasePath, sql], {
    encoding: 'utf8',
  }).trim()
  return output ? JSON.parse(output) : []
}

function sqliteExec(databasePath, sql) {
  execFileSync('sqlite3', [databasePath, sql], { stdio: ['ignore', 'ignore', 'pipe'] })
}

function sanitizeText(raw, sandbox) {
  return String(raw || '')
    .replaceAll(repoRoot, '<desktop>')
    .replaceAll(hexclawRoot, '<hexclaw>')
    .replaceAll(docsRoot, '<docs>')
    .replaceAll(sandbox, '<sandbox>')
    .replace(/\/Users\/[^/\s]+/gu, '<user-home>')
    .replace(/(authorization\s*[:=]\s*)([^\s,;]+)/giu, '$1<redacted>')
    .replace(/(bearer\s+)([^\s,;]+)/giu, '$1<redacted>')
    .replaceAll(apiToken, '<test-token>')
}

function renderConfig(sandbox, sidecarPort) {
  return `server:
  host: 127.0.0.1
  port: ${sidecarPort}
  mode: development
  api_token: ${apiToken}
platforms:
  web:
    enabled: true
llm:
  providers: {}
  routing:
    enabled: false
  cache:
    enabled: false
storage:
  driver: sqlite
  sqlite:
    path: ${JSON.stringify(join(sandbox, '.hexclaw/data.db'))}
knowledge:
  enabled: false
memory:
  long_term:
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
observe:
  log_level: info
`
}

function runPrivateCommand(command, args, options = {}) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, {
      cwd: options.cwd || repoRoot,
      env: options.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      rejectCommand(new Error(`${options.label || command} timed out`))
    }, options.timeoutMs || commandTimeoutMs)
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
      rejectCommand(
        new Error(
          `${options.label || command} failed (${code ?? signal}): ${String(stderr || stdout).slice(-2000)}`,
        ),
      )
    })
  })
}

async function prepareFixture(sandbox, databasePath, sidecarPort) {
  const manifestPath = join(sandbox, 'fixture-manifest.json')
  const runID = `recovering-lock-${process.pid}-${Date.now()}`
  const result = await runPrivateCommand(
    'go',
    [
      'run',
      '-tags',
      'testtools',
      './cmd/k12-live-fixture-testtools',
      'start',
      '--profile',
      sandbox,
      '--store',
      databasePath,
      '--manifest',
      manifestPath,
      '--run-id',
      runID,
      '--learner',
      'recovering-lock-learner',
      '--provider',
      'offline-fixture',
      '--model',
      'offline-fixture',
      '--lease',
      '20m',
    ],
    {
      cwd: hexclawRoot,
      env: {
        ...process.env,
        GOENV: 'off',
        GOPROXY: 'off',
        GOSUMDB: 'off',
      },
      label: 'offline durable recovering fixture',
    },
  )
  const startReceipt = JSON.parse(result.stdout)
  assert.deepEqual(startReceipt.boundary_calls, {
    model_calls: 0,
    dingtalk_sends: 0,
    im_sends: 0,
  })
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const dispatches = sqliteRows(
    databasePath,
    `SELECT dispatch_id,source_ref,source_session_id,status,retry_safe,failure_kind
       FROM k12_image_task_dispatches
      WHERE dispatch_id IN (${sqlString(manifest.retryable_dispatch_id)},${sqlString(manifest.outcome_unknown_dispatch_id)})
      ORDER BY dispatch_id;`,
  )
  assert.equal(dispatches.length, 2, 'fixture did not create both durable dispatches')
  const outcome = dispatches.find((row) => row.dispatch_id === manifest.outcome_unknown_dispatch_id)
  assert.ok(outcome, 'outcome_unknown dispatch is missing')
  assert.equal(outcome.status, 'failed')
  assert.equal(Number(outcome.retry_safe), 0)
  assert.match(outcome.failure_kind, /outcome_unknown/u)

  const controlSession = `${manifest.ownership}-control`
  const now = '2026-08-24T12:00:00+08:00'
  sqliteExec(
    databasePath,
    `BEGIN IMMEDIATE;
     UPDATE k12_image_task_dispatches
        SET source_session_id=${sqlString(controlSession)}
      WHERE dispatch_id IN (${sqlString(manifest.retryable_dispatch_id)},${sqlString(manifest.outcome_unknown_dispatch_id)});
     INSERT INTO sessions(id,user_id,platform,title,status,message_count,last_message_preview,created_at,updated_at)
     VALUES(${sqlString(manifest.ownership)},'desktop-user','web',${sqlString(sessionTitle)},1,1,${sqlString(sourceMessageText)},${sqlString(now)},${sqlString(now)});
     INSERT INTO messages(id,session_id,role,content,content_type,created_at)
     VALUES(${sqlString(outcome.source_ref)},${sqlString(manifest.ownership)},'user',${sqlString(sourceMessageText)},'text',${sqlString(now)});
     COMMIT;`,
  )
  const configPath = join(sandbox, '.hexclaw/hexclaw.yaml')
  writeFileSync(configPath, renderConfig(sandbox, sidecarPort), { mode: 0o600 })
  chmodSync(configPath, 0o600)
  return {
    manifestPath,
    startReceipt,
    agentName: manifest.agent_name,
    sessionID: manifest.ownership,
    sourceMessageID: outcome.source_ref,
    outcomeDispatchID: manifest.outcome_unknown_dispatch_id,
    retryableDispatchID: manifest.retryable_dispatch_id,
    controlSession,
  }
}

function databaseBoundarySnapshot(databasePath) {
  const tables = [
    'k12_image_task_dispatches',
    'k12_image_task_invocations',
    'k12_model_invocations',
    'k12_model_physical_invocations',
    'k12_delivery_receipts',
    'k12_delivery_batches',
    'sessions',
    'messages',
  ]
  const counts = {}
  for (const table of tables) {
    const rows = sqliteRows(databasePath, `SELECT COUNT(*) AS count FROM ${table};`)
    counts[table] = Number(rows[0]?.count ?? -1)
  }
  return counts
}

function readOnlyProbeSource() {
  return `
import ApplicationServices
import CoreGraphics
import Foundation

enum ProbeError: Error, CustomStringConvertible {
    case invalidArguments(String)
    var description: String {
        switch self { case .invalidArguments(let message): return message }
    }
}

func emitJSON(_ value: Any) throws {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    guard let text = String(data: data, encoding: .utf8) else {
        throw ProbeError.invalidArguments("failed to encode JSON")
    }
    print(text)
}

func pidArgument(_ raw: String) throws -> pid_t {
    guard let value = Int32(raw), value > 0 else {
        throw ProbeError.invalidArguments("pid must be a positive integer")
    }
    return value
}

func attribute(_ element: AXUIElement, _ name: CFString) -> AnyObject? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name, &value) == .success else { return nil }
    return value
}

func stringAttribute(_ element: AXUIElement, _ name: CFString) -> String? {
    attribute(element, name) as? String
}

func boolAttribute(_ element: AXUIElement, _ name: CFString) -> Bool? {
    guard let value = attribute(element, name), CFGetTypeID(value) == CFBooleanGetTypeID() else {
        return nil
    }
    return CFBooleanGetValue(value as! CFBoolean)
}

func pointAttribute(_ element: AXUIElement, _ name: CFString) -> CGPoint? {
    guard let value = attribute(element, name), CFGetTypeID(value) == AXValueGetTypeID() else {
        return nil
    }
    var point = CGPoint.zero
    guard AXValueGetValue(value as! AXValue, .cgPoint, &point) else { return nil }
    return point
}

func sizeAttribute(_ element: AXUIElement, _ name: CFString) -> CGSize? {
    guard let value = attribute(element, name), CFGetTypeID(value) == AXValueGetTypeID() else {
        return nil
    }
    var size = CGSize.zero
    guard AXValueGetValue(value as! AXValue, .cgSize, &size) else { return nil }
    return size
}

func children(_ element: AXUIElement) -> [AXUIElement] {
    (attribute(element, kAXChildrenAttribute as CFString) as? [AXUIElement]) ?? []
}

func describe(_ element: AXUIElement, depth: Int) -> [String: Any] {
    var row: [String: Any] = ["depth": depth]
    if let value = stringAttribute(element, kAXRoleAttribute as CFString) { row["role"] = value }
    if let value = stringAttribute(element, kAXTitleAttribute as CFString), !value.isEmpty { row["title"] = value }
    if let value = stringAttribute(element, kAXDescriptionAttribute as CFString), !value.isEmpty { row["description"] = value }
    if let value = boolAttribute(element, kAXEnabledAttribute as CFString) { row["enabled"] = value }
    if let value = boolAttribute(element, "AXVisible" as CFString) { row["visible"] = value }
    if let point = pointAttribute(element, kAXPositionAttribute as CFString),
       let size = sizeAttribute(element, kAXSizeAttribute as CFString) {
        row["bounds"] = ["x": point.x, "y": point.y, "width": size.width, "height": size.height]
        if row["visible"] == nil { row["visible"] = size.width > 0 && size.height > 0 }
    }
    return row
}

func walk(_ root: AXUIElement) -> [[String: Any]] {
    var result: [[String: Any]] = []
    var queue: [(AXUIElement, Int)] = [(root, 0)]
    var cursor = 0
    while cursor < queue.count && result.count < 5000 {
        let (element, depth) = queue[cursor]
        cursor += 1
        result.append(describe(element, depth: depth))
        if depth < 16 {
            for child in children(element) { queue.append((child, depth + 1)) }
        }
    }
    return result
}

do {
    let arguments = Array(CommandLine.arguments.dropFirst())
    guard let command = arguments.first else { throw ProbeError.invalidArguments("missing command") }
    switch command {
    case "preflight":
        try emitJSON(["accessibility": AXIsProcessTrusted(), "screenCapture": CGPreflightScreenCaptureAccess()])
    case "ax":
        guard arguments.count == 2 else { throw ProbeError.invalidArguments("ax requires pid") }
        try emitJSON(walk(AXUIElementCreateApplication(try pidArgument(arguments[1]))))
    default:
        throw ProbeError.invalidArguments("unknown read-only command")
    }
} catch {
    FileHandle.standardError.write(Data("\\(error)\\n".utf8))
    exit(2)
}
`
}

function compileReadOnlyProbe(sandbox) {
  const destination = join(sandbox, 'native-readonly-probe')
  execFileSync('/usr/bin/xcrun', ['swiftc', '-O', '-', '-o', destination], {
    input: readOnlyProbeSource(),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  chmodSync(destination, 0o700)
  return destination
}

function runProbe(probe, command, ...args) {
  const output = execFileSync(probe, [command, ...args.map(String)], {
    encoding: 'utf8',
  }).trim()
  return output ? JSON.parse(output) : null
}

function visibleAXRows(rows) {
  return rows.filter((row) => row.visible !== false)
}

function rowText(row) {
  return [row.title, row.description].filter(Boolean).join(' ')
}

function exactTextRow(rows, text) {
  return visibleAXRows(rows).find((row) => row.title === text || row.description === text)
}

function composerSnapshot(rows) {
  const visible = visibleAXRows(rows)
  const editors = visible
    .filter((row) => row.role === 'AXTextArea' && row.enabled === true && row.bounds)
    .sort((a, b) => Number(b.bounds.y) - Number(a.bounds.y))
  const stopActions = visible.filter((row) => /停止生成|Stop generating/iu.test(rowText(row)))
  const sendActions = visible.filter((row) => /发送消息|Send message/iu.test(rowText(row)))
  return {
    editor: editors[0] || null,
    sendActions,
    stopActions,
    sessionTitle: exactTextRow(rows, sessionTitle) || null,
    sourceMessage: exactTextRow(rows, sourceMessageText) || null,
    recovering: visible.some((row) => rowText(row).includes(recoveryText)),
  }
}

async function waitForAXSnapshot(probe, pid, expectRecovering) {
  const deadline = Date.now() + 90_000
  let last = null
  while (Date.now() < deadline) {
    const rows = runProbe(probe, 'ax', pid)
    const snapshot = composerSnapshot(rows)
    last = { rows, snapshot }
    if (
      snapshot.editor &&
      snapshot.sessionTitle &&
      snapshot.sourceMessage &&
      snapshot.sendActions.length > 0 &&
      snapshot.stopActions.length === 0 &&
      snapshot.recovering === expectRecovering
    ) {
      return last
    }
    await sleep(300)
  }
  throw new Error(
    `AX state timed out: recovering=${expectRecovering}, snapshot=${JSON.stringify(last?.snapshot || null)}`,
  )
}

function captureWindow(pid, destination) {
  const swift = `
import Foundation
import CoreGraphics
let target: Int32 = ${Number(pid)}
let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
for row in rows {
  let owner = (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value ?? -1
  let layer = (row[kCGWindowLayer as String] as? NSNumber)?.intValue ?? -1
  if owner == target && layer == 0, let id = (row[kCGWindowNumber as String] as? NSNumber)?.intValue { print(id); break }
}
`
  const windowID = execFileSync('/usr/bin/swift', ['-e', swift], {
    encoding: 'utf8',
  }).trim()
  assert.ok(windowID, `native window missing for PID ${pid}`)
  execFileSync('/usr/sbin/screencapture', ['-x', '-l', windowID, destination])
  assert.ok(existsSync(destination) && statSync(destination).size > 1024)
  return { bytes: statSync(destination).size, sha256: sha256File(destination) }
}

async function waitForHealth(port, appProcess) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (appProcess.exitCode !== null)
      throw new Error('installed Desktop exited before Sidecar health')
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1500),
      })
      if (response.ok) return
    } catch {
      // Sidecar 仍在启动。
    }
    await sleep(250)
  }
  throw new Error(`Sidecar health timed out on port ${port}`)
}

async function apiGET(port, path, audit) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { Authorization: `Bearer ${apiToken}` },
    signal: AbortSignal.timeout(5000),
  })
  audit.push({ method: 'GET', path, status: response.status })
  const body = await response.json()
  assert.ok(response.ok, `GET ${path} failed: ${response.status}`)
  return body
}

async function stopProcess(processHandle) {
  if (!processHandle || processHandle.exitCode !== null) return
  processHandle.kill('SIGTERM')
  const exited = await Promise.race([
    new Promise((resolveExit) => processHandle.once('exit', () => resolveExit(true))),
    sleep(5000).then(() => false),
  ])
  if (!exited && processHandle.exitCode === null) {
    processHandle.kill('SIGKILL')
    await new Promise((resolveExit) => processHandle.once('exit', resolveExit))
  }
}

async function stopOwnedSidecar(port) {
  const stopped = []
  for (const pid of listenerPIDs(port)) {
    const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
    }).trim()
    assert.ok(
      command.includes(`${installedSidecar} serve --desktop`),
      `refusing to stop unowned listener ${pid}: ${command}`,
    )
    process.kill(pid, 'SIGTERM')
    stopped.push(pid)
  }
  const deadline = Date.now() + 10_000
  while (listenerPIDs(port).length && Date.now() < deadline) await sleep(100)
  assert.deepEqual(listenerPIDs(port), [], `owned Sidecar remains on port ${port}`)
  return stopped
}

function appEnvironment(sandbox, sidecarPort) {
  const temporaryDirectory = join(sandbox, 'tmp')
  return {
    PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: 'zh_CN.UTF-8',
    LC_ALL: 'zh_CN.UTF-8',
    HOME: sandbox,
    USERPROFILE: sandbox,
    CFFIXED_USER_HOME: sandbox,
    TMPDIR: temporaryDirectory,
    TEMP: temporaryDirectory,
    TMP: temporaryDirectory,
    USER: 'hexclaw-test',
    LOGNAME: 'hexclaw-test',
    HEXCLAW_TEST_MODE: '1',
    HEXCLAW_TEST_HOME: sandbox,
    HEXCLAW_SIDECAR_PORT: String(sidecarPort),
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

async function runExactPhase({ name, sandbox, sidecarPort, probe, fixture, expectRecovering }) {
  assert.deepEqual(
    existingInstalledDesktopPIDs(),
    [],
    'an installed HexClaw process is already running; refusing to trigger single-instance focus',
  )
  const rawLog = join(sandbox, `${name}.log`)
  const logStream = createWriteStream(rawLog, { flags: 'wx', mode: 0o600 })
  const appProcess = spawn(installedExecutable, [], {
    cwd: sandbox,
    env: appEnvironment(sandbox, sidecarPort),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  appProcess.stdout.pipe(logStream, { end: false })
  appProcess.stderr.pipe(logStream, { end: false })
  const apiAudit = []
  try {
    await waitForHealth(sidecarPort, appProcess)
    const sidecarPIDs = listenerPIDs(sidecarPort)
    assert.equal(sidecarPIDs.length, 1, 'exact installed Desktop must own one Sidecar listener')
    const sessions = await apiGET(sidecarPort, '/api/v1/sessions', apiAudit)
    assert.ok(sessions.sessions.some((session) => session.id === fixture.sessionID))
    const agents = await apiGET(sidecarPort, '/api/v1/agents', apiAudit)
    assert.ok(agents.agents.some((agent) => agent.name === fixture.agentName))
    const messages = await apiGET(
      sidecarPort,
      `/api/v1/sessions/${encodeURIComponent(fixture.sessionID)}/messages`,
      apiAudit,
    )
    assert.ok(messages.messages.some((message) => message.id === fixture.sourceMessageID))
    const recoveryPath = `/api/k12/image-tasks/recoverable?agent=${encodeURIComponent(fixture.agentName)}&session=${encodeURIComponent(fixture.sessionID)}`
    const recoverable = await apiGET(sidecarPort, recoveryPath, apiAudit)
    if (expectRecovering) {
      assert.equal(recoverable.items.length, 1)
      assert.equal(recoverable.items[0].dispatch_id, fixture.outcomeDispatchID)
      assert.equal(recoverable.items[0].source_message_id, fixture.sourceMessageID)
      assert.equal(recoverable.items[0].stage, 'recovering')
      await apiGET(
        sidecarPort,
        `/api/k12/image-tasks/${encodeURIComponent(fixture.outcomeDispatchID)}?agent=${encodeURIComponent(fixture.agentName)}`,
        apiAudit,
      )
    } else {
      assert.deepEqual(recoverable.items, [])
    }
    const ax = await waitForAXSnapshot(probe, appProcess.pid, expectRecovering)
    const screenshot = captureWindow(
      appProcess.pid,
      join(evidenceRoot, `exact-installed-${name}.png`),
    )
    assert.ok(apiAudit.every((request) => request.method === 'GET'))
    return {
      appPID: appProcess.pid,
      sidecarPID: sidecarPIDs[0],
      apiAudit,
      recoverable,
      ax: { snapshot: ax.snapshot, rows: ax.rows },
      screenshot,
      executableSHA256: sha256File(installedExecutable),
    }
  } finally {
    await stopProcess(appProcess)
    await stopOwnedSidecar(sidecarPort)
    await new Promise((resolveEnd) => logStream.end(resolveEnd))
    if (existsSync(rawLog)) {
      writeFileSync(
        join(evidenceRoot, `exact-installed-${name}.log`),
        sanitizeText(readFileSync(rawLog, 'utf8'), sandbox),
        { mode: 0o600 },
      )
    }
    assert.deepEqual(listenerPIDs(sidecarPort), [])
  }
}

function assertEquivalentUnlockedProjection(baseline, recovering) {
  for (const phase of [baseline, recovering]) {
    assert.ok(phase.ax.snapshot.editor, 'composer editor is missing')
    assert.equal(phase.ax.snapshot.editor.enabled, true, 'composer editor is disabled')
    assert.ok(phase.ax.snapshot.sendActions.length > 0, 'send action is missing')
    assert.deepEqual(phase.ax.snapshot.stopActions, [], 'stop action is visible')
    assert.ok(phase.ax.snapshot.sessionTitle?.bounds, 'session title bounds are missing')
  }
  const baseBounds = baseline.ax.snapshot.sessionTitle.bounds
  const recoveringBounds = recovering.ax.snapshot.sessionTitle.bounds
  for (const key of ['x', 'y', 'width', 'height']) {
    assert.ok(
      Math.abs(Number(baseBounds[key]) - Number(recoveringBounds[key])) <= 1,
      `sidebar session title ${key} shifted under recovering`,
    )
  }
  assert.equal(baseline.ax.snapshot.recovering, false)
  assert.equal(recovering.ax.snapshot.recovering, true)
}

function validateStatic() {
  assert.equal(process.platform, 'darwin', 'native installed validation is macOS-only')
  const installedIdentity = installedArtifactIdentity()
  const source = readFileSync(fileURLToPath(import.meta.url), 'utf8')
  const registry = readFileSync(join(repoRoot, 'src/stores/session-execution-registry.ts'), 'utf8')
  const registryTest = readFileSync(
    join(repoRoot, 'src/stores/__tests__/bug-20260726-027-028-session-execution-lock.test.ts'),
    'utf8',
  )
  const recognizePanel = readFileSync(
    join(repoRoot, 'src/features/k12/views/RecognizeGuardPanel.vue'),
    'utf8',
  )
  assert.match(registry, /QUERY_ONLY_STATES/u)
  assert.match(registry, /recovering/u)
  assert.match(registry, /outcome_unknown/u)
  assert.match(registryTest, /keeps another active execution locked/u)
  assert.match(registryTest, /same dispatch again when assessing resumes/u)
  assert.match(recognizePanel, /syncExecutionState\(currentDispatchId\.value \? 'recovering'/u)
  assert.match(source, /spawn\(installedExecutable/u)
  assert.match(source, /apiGET/u)
  assert.match(source, /exact-installed-/u)
  assert.match(source, /HEXCLAW_TEST_HOME: sandbox/u)
  assert.match(source, /HEXCLAW_TEST_LLM_CONFIG_MODE: 'preseeded-owner-yaml'/u)
  for (const [needle, message] of [
    ['globalThis.' + 'fetch =', 'WebView fetch injection is forbidden'],
    ['AXUIElement' + 'PerformAction', 'AX mutation is forbidden'],
    ['CG' + 'Event', 'foreground input automation is forbidden'],
    ['NSPaste' + 'board', 'clipboard access is forbidden'],
    ['pb' + 'copy', 'clipboard access is forbidden'],
    ['pb' + 'paste', 'clipboard access is forbidden'],
    ['navigator.' + 'clipboard', 'clipboard access is forbidden'],
    ['d' + 'ws ', 'external DingTalk CLI is forbidden'],
  ]) {
    assert.equal(source.includes(needle), false, message)
  }
  const typecheck = spawnSync('/usr/bin/xcrun', ['swiftc', '-typecheck', '-'], {
    input: readOnlyProbeSource(),
    encoding: 'utf8',
  })
  assert.equal(typecheck.status, 0, typecheck.stderr || 'native probe typecheck failed')
  return {
    status: 'PASS',
    mode: 'static-only',
    appLaunched: false,
    axInvoked: false,
    modelInvocations: 0,
    imInvocations: 0,
    installedIdentity,
    exactInstalledRunDeferred: true,
  }
}

async function runInstalled() {
  assert.equal(process.platform, 'darwin', 'installed boundary is macOS-only')
  assert.equal(process.env[runOptIn], '1', `${runOptIn}=1 is required for run`)
  assert.equal(
    process.env[foregroundOptIn],
    '1',
    `${foregroundOptIn}=1 is required because the exact installed app opens a window`,
  )
  const installedIdentity = installedArtifactIdentity()
  mkdirSync(evidenceRoot, { recursive: true })
  for (const entry of readdirSync(evidenceRoot)) {
    if (/^exact-installed-/u.test(entry)) rmSync(join(evidenceRoot, entry), { force: true })
  }
  const sandbox = mkdtempSync(join(tmpdir(), 'hexclaw-recovering-lock-exact.'))
  chmodSync(sandbox, 0o700)
  mkdirSync(join(sandbox, '.hexclaw'), { mode: 0o700 })
  mkdirSync(join(sandbox, 'tmp'), { mode: 0o700 })
  const databasePath = join(sandbox, '.hexclaw/data.db')
  writeFileSync(databasePath, '', { mode: 0o600 })
  chmodSync(databasePath, 0o600)
  const sidecarPort = await reserveLoopbackPort()
  let status = 'NOT_PASS'
  let failure = null
  let fixture = null
  let baseline = null
  let recovering = null
  try {
    assert.deepEqual(listenerPIDs(sidecarPort), [])
    assert.deepEqual(
      existingInstalledDesktopPIDs(),
      [],
      'an installed HexClaw process is already running; refusing to trigger single-instance focus',
    )
    fixture = await prepareFixture(sandbox, databasePath, sidecarPort)
    const probe = compileReadOnlyProbe(sandbox)
    const preflight = runProbe(probe, 'preflight')
    assert.equal(preflight.accessibility, true, 'Accessibility permission is required')
    assert.equal(preflight.screenCapture, true, 'Screen Recording permission is required')
    const before = databaseBoundarySnapshot(databasePath)
    baseline = await runExactPhase({
      name: 'baseline',
      sandbox,
      sidecarPort,
      probe,
      fixture,
      expectRecovering: false,
    })
    sqliteExec(
      databasePath,
      `UPDATE k12_image_task_dispatches
          SET source_session_id=${sqlString(fixture.sessionID)}
        WHERE dispatch_id=${sqlString(fixture.outcomeDispatchID)};`,
    )
    const afterFixtureProjection = databaseBoundarySnapshot(databasePath)
    assert.deepEqual(afterFixtureProjection, before, 'fixture projection update changed row counts')
    recovering = await runExactPhase({
      name: 'recovering',
      sandbox,
      sidecarPort,
      probe,
      fixture,
      expectRecovering: true,
    })
    const after = databaseBoundarySnapshot(databasePath)
    assert.deepEqual(after, before, 'installed GET-only recovery changed durable boundary counts')
    assertEquivalentUnlockedProjection(baseline, recovering)
    const allRequests = [...baseline.apiAudit, ...recovering.apiAudit]
    assert.ok(allRequests.every((request) => request.method === 'GET'))
    const summary = {
      schemaVersion: 1,
      status: 'PASS',
      acceptance: [
        'K12-OUTCOME-UNKNOWN-NOT-EXECUTING-001',
        'K12-SESSION-SERIAL-009',
        'K12-SESSION-DEADLINE-010',
      ],
      boundary: 'exact-installed-desktop-normal-api-readonly-ax',
      installedArtifact: { ...installedIdentity, launched: true, mutated: false },
      isolation: {
        testHomeMode: '0700',
        configMode: '0600',
        storeMode: '0600',
        sidecarPort,
        userHomeReadOrWritten: false,
        applicationsDirectoryMutated: false,
        webViewInjection: false,
        foregroundInputAutomation: false,
      },
      fixture: {
        agentNameSHA256: sha256Text(fixture.agentName),
        sessionIDSHA256: sha256Text(fixture.sessionID),
        sourceMessageIDSHA256: sha256Text(fixture.sourceMessageID),
        outcomeDispatchIDSHA256: sha256Text(fixture.outcomeDispatchID),
        boundaryCalls: fixture.startReceipt.boundary_calls,
      },
      assertions: {
        normalAPIOnlyGET: true,
        apiProjectedRecovering: true,
        recoveringVisible: true,
        composerEditorEnabled: true,
        sendActionPresent: true,
        stopActionAbsent: true,
        sidebarExecutionGeometryUnchanged: true,
        durableRowCountDelta: 0,
        modelDelta: 0,
        imDelta: 0,
      },
      database: { before, after },
      baseline,
      recovering,
    }
    writeJSON(join(evidenceRoot, 'exact-installed-summary.json'), summary)
    status = 'PASS'
    process.stdout.write(
      `Exact installed recovering-lock gate PASS: ${relative(repoRoot, evidenceRoot)}\n`,
    )
  } catch (error) {
    failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    throw error
  } finally {
    try {
      await stopOwnedSidecar(sidecarPort)
    } catch (error) {
      if (!failure) failure = error instanceof Error ? error.message : String(error)
    }
    rmSync(sandbox, { recursive: true, force: true })
    writeJSON(join(evidenceRoot, 'exact-installed-cleanup.json'), {
      status,
      error: failure,
      sidecarPortReleased: listenerPIDs(sidecarPort).length === 0,
      sandboxRemoved: !existsSync(sandbox),
      installedApplicationMutated: false,
      userHomeModified: false,
      modelInvocations: 0,
      imInvocations: 0,
    })
  }
}

const command = process.argv[2] || '--help'
if (command === '--help' || command === '-h' || command === 'help') {
  process.stdout.write(usage())
} else if (command === 'validate') {
  process.stdout.write(`${JSON.stringify(validateStatic(), null, 2)}\n`)
} else if (command === 'run') {
  await runInstalled()
} else {
  process.stderr.write(`Unknown command: ${command}\n\n${usage()}`)
  process.exitCode = 2
}
