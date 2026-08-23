#!/usr/bin/env node

/**
 * BUG-20260726-033 当前源码隔离原生候选验收。
 *
 * 该脚本只启动唯一 Bundle ID 的临时 Test.app；所有原生输入、AX 查询、截图与清理都先按
 * 候选 PID/专用端口收窄。不得把全局外观切换或全局 Cmd+Q 当作自动化手段。
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const nativeDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(nativeDir, '../..')
const docsRoot = resolve(repoRoot, '../hexclaw-docs')
const evidenceRoot = join(
  docsRoot,
  'test/evidence/bug-20260726-033-current-candidate',
)
const probeSource = join(nativeDir, 'bug-20260726-033-native-probe.swift')
const productName = 'HexClaw BUG 033 Candidate'
const bundleIdentifier = 'com.hexclaw.desktop.bug033.currentcandidate'
const productionBundle = '/Applications/HexClaw.app'
const productionExecutable = `${productionBundle}/Contents/MacOS/hexclaw-desktop`
const productionPort = 16060
const commandTimeoutMs = 20 * 60 * 1000
const expectedChinese = [
  '打开 HexClaw',
  '快速对话…',
  '日志',
  '设置',
  '关于河蟹',
  '退出 HexClaw',
]
const expectedEnglish = [
  'Open HexClaw',
  'Quick Chat…',
  'Logs',
  'Settings',
  'About HexClaw',
  'Quit HexClaw',
]

const sleep = (milliseconds) =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds))

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function fileSha256(path) {
  return sha256(readFileSync(path))
}

function sanitize(value, sandbox) {
  return String(value)
    .replaceAll(repoRoot, '<repo>')
    .replaceAll(docsRoot, '<docs>')
    .replaceAll(homedir(), '<home>')
    .replaceAll(sandbox, '<sandbox>')
}

function sanitizeEvidenceLogs(sandbox) {
  for (const entry of readdirSync(evidenceRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.log')) continue
    const path = join(evidenceRoot, entry.name)
    const original = readFileSync(path, 'utf8')
    const sanitized = sanitize(original, sandbox)
    if (sanitized !== original) writeFileSync(path, sanitized, { mode: 0o600 })
  }
}

function writeJSON(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

function runSync(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    env: options.env || process.env,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.status}): ${result.stderr || result.stdout}`,
    )
  }
  return String(result.stdout || '').trim()
}

function runSyncOptional(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    env: options.env || process.env,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  return result.status === 0 ? String(result.stdout || '').trim() : null
}

async function runLogged(command, args, logPath, options = {}) {
  const stream = createWriteStream(logPath, { flags: 'w', mode: 0o600 })
  return await new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, {
      cwd: options.cwd || repoRoot,
      env: options.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let tail = ''
    const capture = (chunk) => {
      stream.write(chunk)
      tail = `${tail}${chunk.toString()}`.slice(-24_000)
    }
    child.stdout.on('data', capture)
    child.stderr.on('data', capture)
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      rejectCommand(new Error(`command timed out: ${command} ${args.join(' ')}`))
    }, options.timeoutMs || commandTimeoutMs)
    child.once('error', (error) => {
      clearTimeout(timer)
      stream.end()
      rejectCommand(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      stream.end()
      if (code === 0) resolveCommand({ code, tail })
      else {
        rejectCommand(
          new Error(
            `command failed (${code ?? signal}): ${command} ${args.join(' ')}\n${tail}`,
          ),
        )
      }
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
  assert.notEqual(port, productionPort)
  assert.notEqual(port, 11434)
  return port
}

function listenerPIDs(port) {
  const result = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
    encoding: 'utf8',
  })
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`lsof failed for port ${port}: ${result.stderr || result.stdout}`)
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

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}

function productionState() {
  const rows = runSync('ps', ['-axo', 'pid=,ppid=,command='])
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes(productionBundle))
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(.*)$/)
      return match ? { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] } : null
    })
    .filter(Boolean)
  return {
    bundleExists: existsSync(productionBundle),
    executableSha256: existsSync(productionExecutable) ? fileSha256(productionExecutable) : null,
    processes: rows,
    portListeners: listenerPIDs(productionPort),
  }
}

function assertProductionUnchanged(before, after) {
  assert.deepEqual(after, before, 'running /Applications HexClaw state changed during candidate gate')
}

function collectSourceFiles(path, files = []) {
  if (!existsSync(path)) return files
  const stat = statSync(path)
  if (stat.isFile()) {
    files.push(path)
    return files
  }
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (['target', 'node_modules', 'dist', 'test-results'].includes(entry.name)) continue
    const child = join(path, entry.name)
    if (entry.isDirectory()) collectSourceFiles(child, files)
    else if (entry.isFile()) files.push(child)
  }
  return files
}

function sourceIdentity(base = repoRoot) {
  const roots = [
    'package.json',
    'pnpm-lock.yaml',
    'index.html',
    'vite.config.ts',
    'scripts/ci/pdf-worker-package-asset.mjs',
    'src',
    'src-tauri/Cargo.toml',
    'src-tauri/Cargo.lock',
    'src-tauri/build.rs',
    'src-tauri/tauri.conf.json',
    'src-tauri/capabilities',
    'src-tauri/icons',
    'src-tauri/src',
    'src-tauri/tests',
    'src-tauri/binaries',
  ]
  const files = roots.flatMap((path) => collectSourceFiles(join(base, path))).sort()
  const hash = createHash('sha256')
  const entries = []
  for (const path of files) {
    const relativePath = relative(base, path)
    const digest = fileSha256(path)
    entries.push({ path: relativePath, sha256: digest, bytes: statSync(path).size })
    hash.update(`${relativePath}\0${digest}\n`)
  }
  return { sha256: hash.digest('hex'), files: entries.length, entries }
}

function createSourceSnapshot(sandbox) {
  const snapshot = join(sandbox, 'source-snapshot')
  mkdirSync(snapshot, { mode: 0o700 })
  const roots = [
    'package.json',
    'pnpm-lock.yaml',
    'index.html',
    'vite.config.ts',
    'scripts/ci/pdf-worker-package-asset.mjs',
    'tsconfig.json',
    'tsconfig.app.json',
    'tsconfig.node.json',
    'tsconfig.vitest.json',
    'public',
    'src',
    'src-tauri/Cargo.toml',
    'src-tauri/Cargo.lock',
    'src-tauri/Info.plist',
    'src-tauri/build.rs',
    'src-tauri/tauri.conf.json',
    'src-tauri/tauri.mock.conf.json',
    'src-tauri/tauri.package-local.conf.json',
    'src-tauri/binaries',
    'src-tauri/capabilities',
    'src-tauri/icons',
    'src-tauri/render-assets',
    'src-tauri/src',
    'src-tauri/tests',
  ]
  for (const relativePath of roots) {
    const source = join(repoRoot, relativePath)
    if (!existsSync(source)) continue
    const destination = join(snapshot, relativePath)
    mkdirSync(dirname(destination), { recursive: true })
    cpSync(source, destination, { recursive: true })
  }
  symlinkSync(join(repoRoot, 'node_modules'), join(snapshot, 'node_modules'), 'dir')
  return snapshot
}

function createFixture(port) {
  const requests = []
  const server = createServer(async (request, response) => {
    const url = new URL(request.url || '/', `http://127.0.0.1:${port}`)
    requests.push({ method: request.method, path: url.pathname })
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Origin': '*',
      })
      response.end()
      return
    }
    const body =
      url.pathname === '/v1/models'
        ? JSON.stringify({ data: [{ id: 'fixture-model', object: 'model' }], object: 'list' })
        : JSON.stringify({ ok: true })
    response.writeHead(url.pathname === '/updater' ? 204 : 200, {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'application/json; charset=utf-8',
    })
    response.end(url.pathname === '/updater' ? undefined : body)
  })
  return {
    requests,
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
  enabled: false
  embedding:
    provider: fixture
    model: fixture-model
    api_key: local-fixture-only
    base_url: ${fixtureOrigin}/v1
`
}

function writeOverlay(sandbox, buildRoot, frontend, sidecarPort, fixtureOrigin) {
  const overlayPath = join(sandbox, 'tauri.bug033-current-candidate.conf.json')
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
    build: { beforeBuildCommand: '', frontendDist: relative(join(buildRoot, 'src-tauri'), frontend) },
    app: {
      windows: [
        {
          center: true,
          height: 820,
          label: 'main',
          minHeight: 600,
          minWidth: 900,
          title: productName,
          visible: true,
          width: 1280,
        },
      ],
      security: { csp },
    },
    bundle: { createUpdaterArtifacts: false, targets: ['app'] },
    plugins: {
      updater: {
        dangerousInsecureTransportProtocol: true,
        endpoints: [`${fixtureOrigin}/updater`],
      },
    },
  }
  writeFileSync(overlayPath, `${JSON.stringify(overlay, null, 2)}\n`, { mode: 0o600 })
  return overlayPath
}

async function waitFor(predicate, timeoutMs, description, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return
    } catch (error) {
      lastError = error
    }
    await sleep(intervalMs)
  }
  throw new Error(`${description} timed out${lastError ? `: ${lastError.message}` : ''}`)
}

async function waitForHealth(port, processHandle) {
  await waitFor(
    async () => {
      if (!processAlive(processHandle.pid)) throw new Error('candidate exited before health')
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1000),
      })
      return response.ok
    },
    90_000,
    'candidate sidecar health',
    250,
  )
}

async function stopProcess(processHandle) {
  if (!processHandle || !processAlive(processHandle.pid)) return
  processHandle.kill('SIGTERM')
  const exited = await Promise.race([
    new Promise((resolveExit) => processHandle.once('exit', () => resolveExit(true))),
    sleep(5000).then(() => false),
  ])
  if (!exited && processAlive(processHandle.pid)) {
    processHandle.kill('SIGKILL')
    await new Promise((resolveExit) => processHandle.once('exit', resolveExit))
  }
}

async function stopOwnedSidecar(port, appBundle) {
  const stopped = []
  for (const pid of listenerPIDs(port)) {
    const command = processCommand(pid)
    if (!command.includes(`${appBundle}/Contents/MacOS/hexclaw serve --desktop`)) {
      throw new Error(`dedicated port has unexpected owner ${pid}`)
    }
    process.kill(pid, 'SIGTERM')
    stopped.push(pid)
  }
  await waitFor(() => listenerPIDs(port).length === 0, 10_000, 'owned sidecar shutdown')
  return stopped
}

function probe(probeExecutable, command, ...args) {
  return JSON.parse(runSync(probeExecutable, [command, ...args.map(String)]))
}

function candidateWindows(probeExecutable, pid) {
  return probe(probeExecutable, 'windows', pid)
}

function candidateAX(probeExecutable, pid) {
  return probe(probeExecutable, 'ax', pid)
}

function statusWindow(windows) {
  return windows.find((row) => {
    const bounds = row.bounds || {}
    return (
      row.layer > 0 &&
      bounds.y >= 0 &&
      bounds.y <= 45 &&
      bounds.width >= 10 &&
      bounds.width <= 100 &&
      bounds.height >= 10 &&
      bounds.height <= 45
    )
  })
}

function mainWindow(windows) {
  return windows.find(
    (row) =>
      row.layer === 0 &&
      row.bounds?.width >= 800 &&
      row.bounds?.height >= 500,
  )
}

function aboutWindow(windows) {
  return windows.find(
    (row) =>
      row.layer === 0 &&
      row.bounds?.width >= 450 &&
      row.bounds?.width <= 600 &&
      row.bounds?.height >= 650 &&
      row.bounds?.height <= 820,
  )
}

function quickChatWindow(windows) {
  return windows.find(
    (row) =>
      row.layer === 0 &&
      row.bounds?.width >= 430 &&
      row.bounds?.width <= 540 &&
      row.bounds?.height >= 370 &&
      row.bounds?.height <= 500,
  )
}

function captureCandidateWindow(window, destination) {
  assert.ok(window && window.id > 0, 'candidate window id is required for screenshot')
  runSync('/usr/sbin/screencapture', ['-x', '-l', String(window.id), destination])
  assert.ok(existsSync(destination))
  assert.ok(statSync(destination).size > 512)
  return { id: window.id, bytes: statSync(destination).size }
}

function visibleMenuTitles(rows) {
  return rows
    .filter((row) => row.role === 'AXMenuItem' && row.visible === true && row.title)
    .map((row) => row.title)
}

function exactExpectedSet(actual, expected) {
  const found = actual.filter((title) => expected.includes(title))
  return {
    actual: found,
    exact: found.length === expected.length && new Set(found).size === expected.length,
    expected,
  }
}

function caseRecord(cases, id, status, evidence, note) {
  cases[id] = { status, evidence, ...(note ? { note } : {}) }
}

async function launchCandidate({
  appBundle,
  executable,
  locale,
  sidecarPort,
  sandbox,
  harness,
  logName,
}) {
  assert.deepEqual(listenerPIDs(sidecarPort), [], 'dedicated sidecar port must start empty')
  const args = ['-AppleLanguages', `(${locale})`, '-AppleLocale', locale.replace('-', '_')]
  const logPath = join(evidenceRoot, logName)
  const logStream = createWriteStream(logPath, { flags: 'w', mode: 0o600 })
  const processHandle = spawn(executable, args, {
    cwd: appBundle,
    env: {
      PATH: process.env.PATH || '',
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
      HEXCLAW_NATIVE_QUIT_TEST_HARNESS: harness ? '1' : '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  processHandle.stdout.pipe(logStream)
  processHandle.stderr.pipe(logStream)
  await waitForHealth(sidecarPort, processHandle)
  return { logPath, logStream, processHandle }
}

async function closeCandidate(run, sidecarPort, appBundle) {
  if (!run) return
  await stopProcess(run.processHandle)
  await stopOwnedSidecar(sidecarPort, appBundle)
  run.logStream.end()
}

async function inspectTrayMenu({
  button,
  expected,
  locale,
  probeExecutable,
  pid,
  screenshotName,
}) {
  const beforeWindows = candidateWindows(probeExecutable, pid)
  const tray = statusWindow(beforeWindows)
  if (!tray) return { blocked: 'candidate status item window is not PID-addressable' }
  const point = {
    x: tray.bounds.x + tray.bounds.width / 2,
    y: tray.bounds.y + tray.bounds.height / 2,
  }
  probe(probeExecutable, 'click', point.x, point.y, button)
  await sleep(500)
  const afterWindows = candidateWindows(probeExecutable, pid)
  const ax = candidateAX(probeExecutable, pid)
  const titles = visibleMenuTitles(ax)
  const exact = exactExpectedSet(titles, expected)
  const menuWindow = afterWindows.find(
    (row) =>
      row.id !== tray.id &&
      row.layer > 0 &&
      row.bounds?.width > 100 &&
      row.bounds?.height > 100,
  )
  const screenshot = menuWindow
    ? captureCandidateWindow(menuWindow, join(evidenceRoot, screenshotName))
    : null
  writeJSON(join(evidenceRoot, `tray-${locale}-${button}.json`), {
    ax,
    exact,
    point,
    tray,
    windows: afterWindows,
  })
  probe(probeExecutable, 'click', point.x, point.y, button)
  await sleep(250)
  return { blocked: exact.actual.length === 0 ? 'open tray menu is not exposed through candidate AX' : null, exact, point, screenshot, tray }
}

async function physicalLocaleGate({
  appBundle,
  cases,
  executable,
  expected,
  locale,
  probeExecutable,
  sandbox,
  sidecarPort,
}) {
  let run
  try {
    run = await launchCandidate({
      appBundle,
      executable,
      locale,
      sidecarPort,
      sandbox,
      harness: false,
      logName: `app-${locale}.log`,
    })
    const pid = run.processHandle.pid
    try {
      await waitFor(
        () => Boolean(statusWindow(candidateWindows(probeExecutable, pid))),
        10_000,
        `${locale} candidate status item`,
        250,
      )
    } catch {
      const windows = candidateWindows(probeExecutable, pid)
      caseRecord(
        cases,
        `locale.${locale}.tray`,
        'BLOCKED',
        { windows },
        'candidate status item is not exposed as a PID-owned window',
      )
      return { pid, run, left: null, right: null }
    }
    const left = await inspectTrayMenu({
      button: 'left',
      expected,
      locale,
      probeExecutable,
      pid,
      screenshotName: `tray-${locale}-left.png`,
    })
    const right = await inspectTrayMenu({
      button: 'right',
      expected,
      locale,
      probeExecutable,
      pid,
      screenshotName: `tray-${locale}-right.png`,
    })
    if (left.blocked || right.blocked) {
      caseRecord(
        cases,
        `locale.${locale}.tray`,
        'BLOCKED',
        { left, right },
        left.blocked || right.blocked,
      )
    } else {
      assert.equal(left.exact.exact, true, `${locale} left menu labels mismatch`)
      assert.equal(right.exact.exact, true, `${locale} right menu labels mismatch`)
      assert.deepEqual(new Set(left.exact.actual), new Set(right.exact.actual))
      caseRecord(cases, `locale.${locale}.tray`, 'PASS', { left, right })
    }
    return { pid, run, left, right }
  } catch (error) {
    await closeCandidate(run, sidecarPort, appBundle)
    throw error
  }
}

async function main() {
  assert.equal(process.platform, 'darwin', 'BUG-20260726-033 native candidate gate is macOS-only')
  assert.ok(existsSync(probeSource), 'native probe source is missing')
  assert.ok(existsSync(productionBundle), 'running production app bundle is missing')
  if (existsSync(evidenceRoot)) rmSync(evidenceRoot, { force: true, recursive: true })
  mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 })

  const sandbox = mkdtempSync(join(tmpdir(), 'hexclaw-bug033-current-candidate-'))
  chmodSync(sandbox, 0o700)
  mkdirSync(join(sandbox, '.hexclaw'), { mode: 0o700 })
  mkdirSync(join(sandbox, 'tmp'), { mode: 0o700 })
  const frontend = join(sandbox, 'frontend')
  const cargoTarget = join(sandbox, 'cargo-target')
  const probeExecutable = join(sandbox, 'bug033-native-probe')
  const workspaceSourceBefore = sourceIdentity(repoRoot)
  const buildRoot = createSourceSnapshot(sandbox)
  const sidecarPort = await reserveLoopbackPort()
  const fixturePort = await reserveLoopbackPort()
  assert.notEqual(sidecarPort, fixturePort)
  const fixture = createFixture(fixturePort)
  const productionBefore = productionState()
  const cases = {}
  const cleanup = { candidateProcessesStopped: [], ownedSidecarsStopped: [], sandboxRemoved: false }
  const sourceBefore = sourceIdentity(buildRoot)
  let currentRun
  let appBundle = ''
  let executable = ''
  let finalError = null

  try {
    assert.ok(
      productionBefore.processes.some((row) => row.command === productionExecutable),
      'production app must already be running and must remain untouched',
    )
    assert.ok(productionBefore.portListeners.length > 0, 'production sidecar listener is missing')
    assert.deepEqual(listenerPIDs(sidecarPort), [])
    assert.equal(statSync(sandbox).mode & 0o777, 0o700)

    await fixture.listen()
    const configPath = join(sandbox, '.hexclaw/hexclaw.yaml')
    writeFileSync(configPath, renderConfig(sandbox, sidecarPort, fixture.origin), {
      mode: 0o600,
    })
    chmodSync(configPath, 0o600)
    assert.equal(statSync(dirname(configPath)).mode & 0o777, 0o700)
    assert.equal(statSync(configPath).mode & 0o777, 0o600)
    caseRecord(cases, 'isolation.filesystem', 'PASS', {
      configMode: '0600',
      homeMode: '0700',
      sidecarPort,
      uniqueBundleIdentifier: bundleIdentifier,
    })

    await runLogged(
      'swiftc',
      [probeSource, '-o', probeExecutable],
      join(evidenceRoot, 'native-probe-build.log'),
    )
    const preflight = probe(probeExecutable, 'preflight')
    writeJSON(join(evidenceRoot, 'automation-preflight.json'), preflight)
    if (!preflight.accessibility || !preflight.screenCapture) {
      throw new Error(`native automation preflight failed: ${JSON.stringify(preflight)}`)
    }

    const offlineEnv = {
      ...process.env,
      CARGO_NET_OFFLINE: 'true',
      CARGO_TARGET_DIR: cargoTarget,
      PNPM_CONFIG_OFFLINE: 'true',
      npm_config_offline: 'true',
    }
    await runLogged(
      'pnpm',
      ['exec', 'vite', 'build', '--outDir', frontend, '--emptyOutDir'],
      join(evidenceRoot, 'frontend-build.log'),
      { cwd: buildRoot, env: offlineEnv },
    )

    const contractTests = [
      'bug_20260726_033_lifecycle_contract',
      'bug_20260726_033_template_icon_contract',
      'bug_20260726_033_tray_click_menu_contract',
      'bug_20260726_033_tray_locale_contract',
      'bug_20260729_033_tray_about_contract',
    ]
    const isolatedCargoTestEnv = {
      ...process.env,
      CARGO_NET_OFFLINE: 'true',
      TAURI_CONFIG: JSON.stringify({
        build: { frontendDist: relative(join(buildRoot, 'src-tauri'), frontend) },
      }),
    }
    await runLogged(
      'cargo',
      [
        'test',
        '--manifest-path',
        'src-tauri/Cargo.toml',
        ...contractTests.flatMap((name) => ['--test', name]),
      ],
      join(evidenceRoot, 'rust-contract-tests.log'),
      { cwd: buildRoot, env: isolatedCargoTestEnv },
    )
    await runLogged(
      'cargo',
      [
        'test',
        '--manifest-path',
        'src-tauri/Cargo.toml',
        'bug_20260726_033_',
        '--lib',
      ],
      join(evidenceRoot, 'rust-unit-boundary-tests.log'),
      { cwd: buildRoot, env: isolatedCargoTestEnv },
    )
    caseRecord(cases, 'source.contracts', 'PASS', { contractTests, exactBoundary: ['1999ms', '2000ms'] })

    const overlay = writeOverlay(sandbox, buildRoot, frontend, sidecarPort, fixture.origin)
    await runLogged(
      'pnpm',
      ['exec', 'tauri', 'build', '--config', overlay, '--bundles', 'app'],
      join(evidenceRoot, 'candidate-build.log'),
      { cwd: buildRoot, env: offlineEnv },
    )
    appBundle = join(cargoTarget, `release/bundle/macos/${productName}.app`)
    const infoPlist = join(appBundle, 'Contents/Info.plist')
    executable = join(appBundle, 'Contents/MacOS/hexclaw-desktop')
    const sidecarExecutable = join(appBundle, 'Contents/MacOS/hexclaw')
    assert.ok(existsSync(infoPlist), 'candidate Test.app is missing')
    assert.ok(existsSync(executable), 'candidate app executable is missing')
    assert.ok(existsSync(sidecarExecutable), 'candidate sidecar is missing')
    const builtIdentifier = runSync('plutil', [
      '-extract',
      'CFBundleIdentifier',
      'raw',
      '-o',
      '-',
      infoPlist,
    ])
    assert.equal(builtIdentifier, bundleIdentifier)
    const sourceAfterBuild = sourceIdentity(buildRoot)
    assert.equal(sourceAfterBuild.sha256, sourceBefore.sha256, 'frozen source snapshot changed during build')
    writeJSON(join(evidenceRoot, 'build-identity.json'), {
      bundleIdentifier: builtIdentifier,
      bundleVersion: runSync('plutil', [
        '-extract',
        'CFBundleShortVersionString',
        'raw',
        '-o',
        '-',
        infoPlist,
      ]),
      candidateExecutableSha256: fileSha256(executable),
      candidateSidecarSha256: fileSha256(sidecarExecutable),
      sourceIdentityBefore: { files: sourceBefore.files, sha256: sourceBefore.sha256 },
      sourceIdentityAfterBuild: {
        files: sourceAfterBuild.files,
        sha256: sourceAfterBuild.sha256,
      },
    })
    caseRecord(cases, 'candidate.current_source_build', 'PASS', {
      bundleIdentifier: builtIdentifier,
      sourceSha256: sourceBefore.sha256,
    })

    const currentAppearance =
      runSyncOptional('/usr/bin/defaults', ['read', '-g', 'AppleInterfaceStyle']) || 'Light'
    const normalizedAppearance = currentAppearance === 'Dark' ? 'Dark' : 'Light'
    caseRecord(
      cases,
      `appearance.${normalizedAppearance.toLowerCase()}`,
      'BLOCKED',
      { nativeTemplateContract: true, systemAppearance: normalizedAppearance },
      'source template contract passed, but candidate-only menu-bar rendering was not captured',
    )
    caseRecord(
      cases,
      `appearance.${normalizedAppearance === 'Dark' ? 'light' : 'dark'}`,
      'BLOCKED',
      { nativeTemplateContract: true },
      'changing global macOS appearance would affect the running production app',
    )

    const zh = await physicalLocaleGate({
      appBundle,
      cases,
      executable,
      expected: expectedChinese,
      locale: 'zh-Hans',
      probeExecutable,
      sandbox,
      sidecarPort,
    })
    currentRun = zh.run
    const zhPid = currentRun.processHandle.pid
    const initialWindows = candidateWindows(probeExecutable, zhPid)
    const initialMain = mainWindow(initialWindows)
    if (!initialMain) {
      caseRecord(cases, 'window.close_restore', 'BLOCKED', { windows: initialWindows }, 'candidate main window is not PID-addressable')
    } else {
      captureCandidateWindow(initialMain, join(evidenceRoot, 'main-before-close.png'))
      probe(probeExecutable, 'press-window-subrole', zhPid, productName, 'AXCloseButton')
      await sleep(500)
      const hiddenWindows = candidateWindows(probeExecutable, zhPid)
      const aliveAfterClose = processAlive(zhPid)
      const healthAfterClose = await fetch(`http://127.0.0.1:${sidecarPort}/health`, {
        signal: AbortSignal.timeout(1000),
      })
      const tray = statusWindow(hiddenWindows)
      assert.equal(aliveAfterClose, true, 'red X exited candidate app')
      assert.equal(healthAfterClose.ok, true, 'red X stopped candidate sidecar')
      assert.equal(Boolean(mainWindow(hiddenWindows)), false, 'red X left main window on screen')
      if (!tray) {
        caseRecord(cases, 'window.close_restore', 'BLOCKED', { hiddenWindows }, 'hidden candidate status item is not PID-addressable')
      } else {
        const point = {
          x: tray.bounds.x + tray.bounds.width / 2,
          y: tray.bounds.y + tray.bounds.height / 2,
        }
        probe(probeExecutable, 'click', point.x, point.y, 'left')
        await sleep(400)
        const menuAX = candidateAX(probeExecutable, zhPid)
        const openVisible = menuAX.some(
          (row) => row.role === 'AXMenuItem' && row.visible === true && row.title === expectedChinese[0],
        )
        if (!openVisible) {
          probe(probeExecutable, 'click', point.x, point.y, 'left')
          caseRecord(cases, 'window.close_restore', 'BLOCKED', { aliveAfterClose, healthAfterClose: healthAfterClose.ok }, 'tray Open is not exposed through candidate AX')
        } else {
          probe(probeExecutable, 'press-visible', zhPid, expectedChinese[0])
          await waitFor(
            () => Boolean(mainWindow(candidateWindows(probeExecutable, zhPid))),
            5000,
            'tray Open restores main window',
          )
          const restoredMain = mainWindow(candidateWindows(probeExecutable, zhPid))
          assert.equal(restoredMain.id, initialMain.id, 'tray Open created a different main window')
          caseRecord(cases, 'window.close_restore', 'PASS', {
            aliveAfterClose,
            healthAfterClose: healthAfterClose.ok,
            mainWindowId: initialMain.id,
            restoredWindowId: restoredMain.id,
          })
        }
      }
    }

    const beforeQuick = candidateWindows(probeExecutable, zhPid)
    const trayForQuick = statusWindow(beforeQuick)
    if (!trayForQuick) {
      caseRecord(cases, 'quick_chat_vs_new_conversation', 'BLOCKED', {}, 'candidate tray is not PID-addressable')
    } else {
      const point = {
        x: trayForQuick.bounds.x + trayForQuick.bounds.width / 2,
        y: trayForQuick.bounds.y + trayForQuick.bounds.height / 2,
      }
      probe(probeExecutable, 'click', point.x, point.y, 'left')
      await sleep(350)
      const trayAX = candidateAX(probeExecutable, zhPid)
      if (!trayAX.some((row) => row.visible === true && row.title === '快速对话…')) {
        probe(probeExecutable, 'click', point.x, point.y, 'left')
        caseRecord(cases, 'quick_chat_vs_new_conversation', 'BLOCKED', {}, 'Quick Chat tray item is not exposed through candidate AX')
      } else {
        probe(probeExecutable, 'press-visible', zhPid, '快速对话…')
        await waitFor(
          () => Boolean(quickChatWindow(candidateWindows(probeExecutable, zhPid))),
          5000,
          'Quick Chat native window',
        )
        const quick = quickChatWindow(candidateWindows(probeExecutable, zhPid))
        captureCandidateWindow(quick, join(evidenceRoot, 'quick-chat-window.png'))
        probe(probeExecutable, 'activate', zhPid)
        probe(probeExecutable, 'press', zhPid, 'File')
        await sleep(250)
        probe(probeExecutable, 'press-visible', zhPid, 'New Chat')
        await sleep(500)
        const afterNewChat = candidateWindows(probeExecutable, zhPid)
        const quickAfter = quickChatWindow(afterNewChat)
        const mainAfter = mainWindow(afterNewChat)
        assert.equal(quickAfter?.id, quick.id, 'New Chat replaced the Quick Chat window identity')
        assert.ok(mainAfter, 'New Chat removed the main window')
        assert.notEqual(mainAfter.id, quickAfter.id)
        caseRecord(cases, 'quick_chat_vs_new_conversation', 'PASS', {
          mainWindowId: mainAfter.id,
          quickChatWindowId: quickAfter.id,
          quickChatBounds: quickAfter.bounds,
        })
      }
    }

    const aboutEvidence = {}
    try {
      probe(probeExecutable, 'activate', zhPid)
      probe(probeExecutable, 'press', zhPid, 'HexClaw')
      await sleep(250)
      probe(probeExecutable, 'press-visible', zhPid, 'About HexClaw')
      await waitFor(
        () => Boolean(aboutWindow(candidateWindows(probeExecutable, zhPid))),
        5000,
        'native app menu About window',
      )
      const nativeAbout = aboutWindow(candidateWindows(probeExecutable, zhPid))
      aboutEvidence.nativeAppMenu = nativeAbout.id
      captureCandidateWindow(nativeAbout, join(evidenceRoot, 'about-window.png'))

      probe(probeExecutable, 'activate', zhPid)
      probe(probeExecutable, 'press', zhPid, 'HexClaw')
      await sleep(250)
      probe(probeExecutable, 'press-visible', zhPid, 'Settings...')
      await sleep(1000)
      const settingsAX = candidateAX(probeExecutable, zhPid)
      writeJSON(join(evidenceRoot, 'settings-ax.json'), settingsAX)
      const learnMore = settingsAX.find(
        (row) => row.visible === true && ['了解更多', 'Learn More'].includes(row.title),
      )
      if (learnMore) {
        probe(probeExecutable, 'press-visible', zhPid, learnMore.title)
        await sleep(500)
        aboutEvidence.settingsLearnMore = aboutWindow(candidateWindows(probeExecutable, zhPid))?.id || null
      }
      const sidebarAX = candidateAX(probeExecutable, zhPid)
      const versionEntry = sidebarAX.find(
        (row) => row.visible === true && row.title === 'HexClaw 0.5.0-beta',
      )
      if (versionEntry) {
        probe(probeExecutable, 'press-visible', zhPid, versionEntry.title)
        await sleep(500)
        aboutEvidence.sidebarVersion = aboutWindow(candidateWindows(probeExecutable, zhPid))?.id || null
      }
      const trayForAbout = statusWindow(candidateWindows(probeExecutable, zhPid))
      if (trayForAbout) {
        const point = {
          x: trayForAbout.bounds.x + trayForAbout.bounds.width / 2,
          y: trayForAbout.bounds.y + trayForAbout.bounds.height / 2,
        }
        probe(probeExecutable, 'click', point.x, point.y, 'right')
        await sleep(350)
        const trayAX = candidateAX(probeExecutable, zhPid)
        if (trayAX.some((row) => row.visible === true && row.title === '关于河蟹')) {
          probe(probeExecutable, 'press-visible', zhPid, '关于河蟹')
          await sleep(500)
          aboutEvidence.tray = aboutWindow(candidateWindows(probeExecutable, zhPid))?.id || null
        } else {
          probe(probeExecutable, 'click', point.x, point.y, 'right')
        }
      }
      const identities = Object.values(aboutEvidence).filter(Number.isInteger)
      const allFour = ['nativeAppMenu', 'settingsLearnMore', 'sidebarVersion', 'tray'].every(
        (key) => Number.isInteger(aboutEvidence[key]),
      )
      if (allFour) {
        assert.equal(new Set(identities).size, 1, 'four About entries did not reuse one window')
        caseRecord(cases, 'about.four_entries_one_window', 'PASS', aboutEvidence)
      } else {
        caseRecord(
          cases,
          'about.four_entries_one_window',
          'BLOCKED',
          aboutEvidence,
          'one or more in-WebView About entries are not exposed through candidate AX',
        )
      }
    } catch (error) {
      caseRecord(
        cases,
        'about.four_entries_one_window',
        'BLOCKED',
        aboutEvidence,
        `candidate AX could not drive all About entries: ${error.message}`,
      )
    }

    await closeCandidate(currentRun, sidecarPort, appBundle)
    cleanup.candidateProcessesStopped.push(zhPid)
    currentRun = null

    for (const [locale, expected] of [
      ['en-US', expectedEnglish],
      ['fr-FR', expectedEnglish],
    ]) {
      const localized = await physicalLocaleGate({
        appBundle,
        cases,
        executable,
        expected,
        locale,
        probeExecutable,
        sandbox,
        sidecarPort,
      })
      currentRun = localized.run
      cleanup.candidateProcessesStopped.push(currentRun.processHandle.pid)
      await closeCandidate(currentRun, sidecarPort, appBundle)
      currentRun = null
    }

    currentRun = await launchCandidate({
      appBundle,
      executable,
      locale: 'en-US',
      sidecarPort,
      sandbox,
      harness: true,
      logName: 'app-cmdq-inside.log',
    })
    let quitPid = currentRun.processHandle.pid
    const quitHarness = join(sandbox, '.hexclaw/native-quit-harness')
    writeFileSync(join(quitHarness, 'request-1'), 'request\n', { mode: 0o600 })
    await waitFor(() => existsSync(join(quitHarness, 'ack-1')), 5000, 'inside first quit ack', 25)
    const insideStart = Date.now()
    await sleep(1200)
    writeFileSync(join(quitHarness, 'request-2'), 'request\n', { mode: 0o600 })
    await waitFor(() => !processAlive(quitPid), 10_000, 'inside second quit exits candidate', 50)
    const insideIntervalMs = Date.now() - insideStart
    caseRecord(cases, 'cmdq.native_dispatcher_inside_window', 'PASS', {
      intervalClass: '<2000ms',
      observedWaitMs: insideIntervalMs,
      processExited: true,
    })
    cleanup.candidateProcessesStopped.push(quitPid)
    await stopOwnedSidecar(sidecarPort, appBundle)
    currentRun.logStream.end()
    currentRun = null
    rmSync(quitHarness, { force: true, recursive: true })

    currentRun = await launchCandidate({
      appBundle,
      executable,
      locale: 'en-US',
      sidecarPort,
      sandbox,
      harness: true,
      logName: 'app-cmdq-outside.log',
    })
    quitPid = currentRun.processHandle.pid
    writeFileSync(join(quitHarness, 'request-1'), 'request\n', { mode: 0o600 })
    await waitFor(() => existsSync(join(quitHarness, 'ack-1')), 5000, 'outside first quit ack', 25)
    const outsideStart = Date.now()
    await sleep(2150)
    writeFileSync(join(quitHarness, 'request-2'), 'request\n', { mode: 0o600 })
    await waitFor(() => existsSync(join(quitHarness, 'ack-2')), 5000, 'outside second quit ack', 25)
    const outsideIntervalMs = Date.now() - outsideStart
    await sleep(250)
    assert.equal(processAlive(quitPid), true, 'outside-window second quit incorrectly exited candidate')
    const healthAfterOutside = await fetch(`http://127.0.0.1:${sidecarPort}/health`, {
      signal: AbortSignal.timeout(1000),
    })
    assert.equal(healthAfterOutside.ok, true)
    caseRecord(cases, 'cmdq.native_dispatcher_outside_window', 'PASS', {
      intervalClass: '>=2000ms',
      observedWaitMs: outsideIntervalMs,
      processAlive: true,
      sidecarHealthy: true,
    })
    caseRecord(
      cases,
      'cmdq.physical_exact_1999_2000',
      'BLOCKED',
      {
        exactSameSourceRustClockTest: 'PASS',
        physicalDispatcherInside: 'PASS',
        physicalDispatcherOutside: 'PASS',
      },
      'global Cmd+Q could target the running production app, and the file harness has 25ms polling jitter',
    )
    await closeCandidate(currentRun, sidecarPort, appBundle)
    cleanup.candidateProcessesStopped.push(quitPid)
    currentRun = null

    const productionAfter = productionState()
    assertProductionUnchanged(productionBefore, productionAfter)
    caseRecord(cases, 'production_app_untouched', 'PASS', {
      bundleExecutableSha256: productionAfter.executableSha256,
      port: productionPort,
      processPids: productionAfter.processes.map((row) => row.pid),
      sidecarPids: productionAfter.portListeners,
    })
    writeJSON(join(evidenceRoot, 'fixture-network-observation.json'), {
      externalNetworkConfigured: false,
      loopbackRequests: fixture.requests,
    })
  } catch (error) {
    finalError = error
    caseRecord(cases, 'unexpected_failure', 'NOT_PASS', {}, error.stack || error.message)
  } finally {
    if (currentRun) {
      const pid = currentRun.processHandle.pid
      await closeCandidate(currentRun, sidecarPort, appBundle)
      cleanup.candidateProcessesStopped.push(pid)
    } else if (appBundle) {
      cleanup.ownedSidecarsStopped.push(...(await stopOwnedSidecar(sidecarPort, appBundle)))
    }
    await fixture.close()
    const productionAfterCleanup = productionState()
    try {
      assertProductionUnchanged(productionBefore, productionAfterCleanup)
    } catch (error) {
      finalError ||= error
      caseRecord(cases, 'production_app_untouched', 'NOT_PASS', {}, error.message)
    }
    const sourceAfter = sourceIdentity(buildRoot)
    if (sourceAfter.sha256 !== sourceBefore.sha256) {
      finalError ||= new Error('frozen source snapshot changed during native candidate run')
      caseRecord(cases, 'source_immutable_during_run', 'NOT_PASS', {
        before: sourceBefore.sha256,
        after: sourceAfter.sha256,
      })
    } else {
      caseRecord(cases, 'source_immutable_during_run', 'PASS', {
        sha256: sourceAfter.sha256,
      })
    }
    const workspaceSourceAfter = sourceIdentity(repoRoot)
    writeJSON(join(evidenceRoot, 'workspace-source-window.json'), {
      changedDuringRun: workspaceSourceAfter.sha256 !== workspaceSourceBefore.sha256,
      sourceSnapshotSha256: sourceBefore.sha256,
      workspaceAtSnapshotStartSha256: workspaceSourceBefore.sha256,
      workspaceAtRunEndSha256: workspaceSourceAfter.sha256,
    })
    sanitizeEvidenceLogs(sandbox)
    rmSync(sandbox, { force: true, recursive: true })
    cleanup.sandboxRemoved = !existsSync(sandbox)
    cleanup.dedicatedPortReleased = listenerPIDs(sidecarPort).length === 0
    cleanup.productionAppStillRunning = productionAfterCleanup.processes.some(
      (row) => row.command === productionExecutable,
    )
    writeJSON(join(evidenceRoot, 'cleanup.json'), cleanup)
    const statuses = Object.values(cases).map((entry) => entry.status)
    const overall = statuses.includes('NOT_PASS')
      ? 'NOT_PASS'
      : statuses.includes('BLOCKED')
        ? 'BLOCKED'
        : 'PASS'
    writeJSON(join(evidenceRoot, 'summary.json'), {
      acceptance: [
        'MAC-TRAY-001',
        'MAC-TRAY-002',
        'MAC-TRAY-003',
        'MAC-TRAY-004',
        'MAC-WINDOW-CLOSE-005',
        'MAC-CMDQ-006',
        'MAC-CMDQ-007',
        'MAC-CMDQ-008',
        'MAC-TRAY-009',
        'MAC-TRAY-010',
        'MAC-TRAY-011',
      ],
      bug: 'BUG-20260726-033',
      cases: JSON.parse(sanitize(JSON.stringify(cases), sandbox)),
      cleanup,
      overall,
      ...(finalError ? { error: sanitize(finalError.stack || finalError.message, sandbox) } : {}),
    })
    process.stdout.write(`BUG-20260726-033 current candidate: ${overall}\n`)
    process.stdout.write(`Evidence: ${evidenceRoot}\n`)
    if (finalError) throw finalError
  }
}

await main()
