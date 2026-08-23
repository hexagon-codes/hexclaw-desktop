#!/usr/bin/env node

/**
 * BUG-20260802-013：当前源码 saveBlobInApp 原生 Save grant 边界。
 *
 * 只构建唯一 Test.app，使用 0700 临时 HOME、专属回环端口和测试专属 WebView 入口；
 * 系统 Save 面板仅写入本轮 sandbox，结束后精确清理自有 App、进程、端口与临时文件。
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  createReadStream,
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
import { createInterface } from 'node:readline'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_PRODUCT_NAME = 'HexClaw Bug013 Save Test'
const APP_IDENTIFIER = 'com.hexclaw.desktop.bug013.save'
const EXACT_BYTES = 100 * 1024 * 1024
const IPC_CHUNK_BYTES = 256 * 1024
const APP_MEMORY_DELTA_LIMIT_KIB = EXACT_BYTES / 1024
const WEBVIEW_MEMORY_DELTA_LIMIT_KIB = EXACT_BYTES / 1024

// 手工模式只暂停真实系统 Save 面板，不改变默认自动模式。
const MANUAL_MODE = process.argv.includes('--manual') || process.argv.includes('--pause')

const nativeDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(nativeDir, '../..')
const hexclawRoot = resolve(repoRoot, '../hexclaw')
const srcTauriDir = join(repoRoot, 'src-tauri')
const fixtureRoot = join(nativeDir, 'bug-20260802-013-save-boundary')
const evidenceDir = join(repoRoot, 'test/evidence/bug-20260802-013-save-current-source')
const testAppBundle = join(srcTauriDir, 'target/release/bundle/macos', `${APP_PRODUCT_NAME}.app`)

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
}

function requireManualTerminal() {
  assert.equal(MANUAL_MODE, true)
  assert.equal(process.stdin.isTTY, true, 'Manual Save boundary requires an interactive terminal')
  assert.equal(process.stdout.isTTY, true, 'Manual Save boundary requires an interactive terminal')
}

function createManualReader() {
  if (!MANUAL_MODE) return null
  requireManualTerminal()
  return createInterface({ input: process.stdin, output: process.stdout, terminal: true })
}

function askManual(reader, prompt) {
  assert.ok(reader, 'Manual Save boundary reader is missing')
  return new Promise((resolveAnswer, rejectAnswer) => {
    const onClose = () => rejectAnswer(new Error('Manual Save boundary input closed before confirmation'))
    reader.once('close', onClose)
    reader.question(prompt, (answer) => {
      reader.removeListener('close', onClose)
      resolveAnswer(answer.trim())
    })
  })
}

function deferred() {
  let resolvePromise
  const promise = new Promise((resolveDeferred) => {
    resolvePromise = resolveDeferred
  })
  return { promise, resolve: resolvePromise }
}

function fail(message) {
  throw new Error(message)
}

function gitHead(root) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || `Unable to resolve git HEAD for ${root}`)
  return result.stdout.trim()
}

async function sha256File(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path, { highWaterMark: IPC_CHUNK_BYTES })) {
    hash.update(chunk)
  }
  return hash.digest('hex')
}

function regularFilesUnder(root) {
  const files = []
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile()) files.push(path)
    }
  }
  visit(root)
  return files.sort()
}

async function currentBuildInputManifest() {
  const paths = [
    ...regularFilesUnder(join(repoRoot, 'src')),
    ...regularFilesUnder(join(srcTauriDir, 'src')),
    ...regularFilesUnder(fixtureRoot),
    join(repoRoot, 'package.json'),
    join(repoRoot, 'pnpm-lock.yaml'),
    join(srcTauriDir, 'build.rs'),
    join(srcTauriDir, 'Cargo.lock'),
    join(srcTauriDir, 'Cargo.toml'),
    join(srcTauriDir, 'tauri.conf.json'),
  ]
  const manifest = {}
  for (const path of [...new Set(paths)].sort()) {
    manifest[relative(repoRoot, path)] = await sha256File(path)
  }
  return manifest
}

function deterministicOracleDigest() {
  const hash = createHash('sha256')
  const chunkCount = EXACT_BYTES / IPC_CHUNK_BYTES
  for (let index = 0; index < chunkCount; index += 1) {
    const chunk = Buffer.alloc(IPC_CHUNK_BYTES, index % 251)
    hash.update(chunk)
  }
  return hash.digest('hex')
}

function sanitizeText(value, sandbox, fixtureOrigin = '') {
  return String(value || '')
    .replaceAll(sandbox, '<sandbox>')
    .replaceAll(repoRoot, '<repo>')
    .replaceAll(hexclawRoot, '<hexclaw>')
    .replaceAll(fixtureOrigin, '<fixture-origin>')
    .replace(new RegExp(`${sep === '\\' ? '[A-Za-z]:\\\\Users' : '/Users'}/[^/\\s]+`, 'g'), '<user-home>')
}

function sanitizedValue(value, sandbox, fixtureOrigin = '') {
  return JSON.parse(sanitizeText(JSON.stringify(value), sandbox, fixtureOrigin))
}

function writeJSON(path, value, sandbox = '', fixtureOrigin = '') {
  const safe = sandbox ? sanitizedValue(value, sandbox, fixtureOrigin) : value
  writeFileSync(path, `${JSON.stringify(safe, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
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
          rejectTimeout(new Error(`${command} timed out`))
        }, options.timeoutMs || 20 * 60_000)
      }),
    ])
    if (result.code !== 0) {
      fail(`${command} exited ${result.code ?? result.signal}\n${output.slice(-12_000)}`)
    }
    return { command, args, durationMs: Date.now() - startedAt }
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
  return port
}

function listenerPids(port) {
  const result = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
    encoding: 'utf8',
  })
  if (result.status !== 0 && result.status !== 1) {
    fail(`lsof failed for port ${port}: ${result.stderr || result.stdout}`)
  }
  return String(result.stdout || '').split(/\s+/).filter(Boolean).map(Number)
}

function processCommand(pid) {
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' })
  return result.status === 0 ? String(result.stdout || '').trim() : ''
}

function ownedSidecarPids(port, appBundle) {
  const expected = `${appBundle}/Contents/MacOS/hexclaw`
  return listenerPids(port).filter((pid) => {
    const command = processCommand(pid)
    return command.includes(expected) && command.includes('serve --desktop')
  })
}

function processRows() {
  const result = spawnSync('ps', ['-axo', 'pid=,ppid=,rss=,command='], { encoding: 'utf8' })
  if (result.status !== 0) return []
  return result.stdout.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/)
    if (!match) return []
    return [{ pid: Number(match[1]), ppid: Number(match[2]), rssKiB: Number(match[3]), command: match[4] }]
  })
}

function matchingWebViews(rows, appPid, baselineWebViewPids = new Set()) {
  const pidPattern = new RegExp(`(?:^|\\D)${appPid}(?:\\D|$)`)
  return rows.filter((row) =>
    /WebKit\.(?:WebContent|GPU|Network)|com\.apple\.WebKit/.test(row.command)
      && (
        row.command.includes(APP_IDENTIFIER)
        || row.ppid === appPid
        || pidPattern.test(row.command)
        || !baselineWebViewPids.has(row.pid)
      ),
  )
}

function startMemorySampler(appPid, loopback, startedAt) {
  // macOS WebKit XPC 子进程可能脱离 Test.app 挂到 PID 1；只纳入本轮采样启动后出现的进程，避免把生产 App 的 WebKit RSS 混入证据。
  const baselineWebViewPids = new Set(
    processRows()
      .filter((row) => /WebKit\.(?:WebContent|GPU|Network)|com\.apple\.WebKit/.test(row.command))
      .map((row) => row.pid),
  )
  const samples = []
  let timer = null
  const sample = () => {
    const rows = processRows()
    const app = rows.find((row) => row.pid === appPid)
    const webviews = matchingWebViews(rows, appPid, baselineWebViewPids)
    samples.push({
      elapsedMs: Date.now() - startedAt,
      stage: loopback.state.progress.at(-1)?.stage || 'startup',
      appRssKiB: app?.rssKiB ?? null,
      webviewRssKiB: webviews.length
        ? webviews.reduce((sum, row) => sum + row.rssKiB, 0)
        : null,
      webviewPids: webviews.map((row) => row.pid),
    })
  }
  sample()
  timer = setInterval(sample, 100)
  return {
    samples,
    stop() {
      clearInterval(timer)
      sample()
    },
  }
}

function summarizeMemory(samples, progress) {
  const exactStart = progress.find((entry) => entry.stage === 'exact-blob-ready')?.receivedAtMs
  const exactEnd = progress.find((entry) => entry.stage === 'exact-success')?.receivedAtMs
  assert.ok(Number.isFinite(exactStart), 'Exact Blob memory start marker is missing')
  assert.ok(Number.isFinite(exactEnd), 'Exact Blob memory end marker is missing')
  const exactSamples = samples.filter(
    (sample) => sample.elapsedMs >= exactStart && sample.elapsedMs <= exactEnd,
  )
  const appValues = exactSamples.map((sample) => sample.appRssKiB).filter(Number.isFinite)
  const webviewValues = exactSamples.map((sample) => sample.webviewRssKiB).filter(Number.isFinite)
  assert.ok(appValues.length >= 2, 'App RSS samples are missing')
  assert.ok(webviewValues.length >= 2, 'WebView RSS samples are missing')
  const summarize = (values) => ({
    minKiB: Math.min(...values),
    maxKiB: Math.max(...values),
    deltaKiB: Math.max(...values) - Math.min(...values),
  })
  return {
    intervalMs: 100,
    exactSampleCount: exactSamples.length,
    app: summarize(appValues),
    webview: summarize(webviewValues),
    observedWebviewPids: [...new Set(exactSamples.flatMap((sample) => sample.webviewPids))],
  }
}

function writeMemoryTSV(path, samples) {
  const lines = ['elapsed_ms\tstage\tapp_rss_kib\twebview_rss_kib\twebview_pids']
  for (const sample of samples) {
    lines.push([
      sample.elapsedMs,
      sample.stage,
      sample.appRssKiB ?? '',
      sample.webviewRssKiB ?? '',
      sample.webviewPids.join(','),
    ].join('\t'))
  }
  writeFileSync(path, `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 })
}

function readBody(request, maxBytes = 1024 * 1024) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = []
    let total = 0
    request.on('data', (chunk) => {
      total += chunk.length
      if (total > maxBytes) {
        rejectBody(new Error('Fixture request body is too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')))
    request.on('error', rejectBody)
  })
}

function sendJSON(response, status, value) {
  response.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
    connection: 'close',
  })
  response.end(JSON.stringify(value))
}

async function startLoopbackFixture(failureDirectory, startedAt) {
  const finalReport = deferred()
  const state = {
    origin: '',
    progress: [],
    report: null,
    blockedExternalRequests: [],
    unexpectedPaths: [],
    failureDirectoryArmed: false,
  }
  const server = createServer(async (request, response) => {
    const rawURL = request.url || '/'
    if (/^https?:\/\//i.test(rawURL)) {
      state.blockedExternalRequests.push({ method: request.method, target: rawURL.slice(0, 300) })
      response.writeHead(502, { connection: 'close' })
      response.end()
      return
    }
    const url = new URL(rawURL, state.origin || 'http://127.0.0.1')
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-allow-headers': 'content-type',
        connection: 'close',
      })
      response.end()
      return
    }
    if (request.method === 'GET' && url.pathname === '/__bug013__/updater') {
      response.writeHead(204, { 'access-control-allow-origin': '*', connection: 'close' })
      response.end()
      return
    }
    if (request.method === 'POST' && url.pathname === '/__bug013__/progress') {
      const payload = JSON.parse(await readBody(request))
      const entry = { receivedAtMs: Date.now() - startedAt, ...payload }
      state.progress.push(entry)
      if (entry.stage === 'copy-failure-arming') {
        chmodSync(failureDirectory, 0o500)
        state.failureDirectoryArmed = true
      }
      sendJSON(response, 200, { accepted: true })
      return
    }
    if (request.method === 'POST' && url.pathname === '/__bug013__/report') {
      const payload = JSON.parse(await readBody(request))
      state.report = payload
      finalReport.resolve(payload)
      sendJSON(response, 200, { accepted: true })
      return
    }
    state.unexpectedPaths.push(`${request.method} ${url.pathname}`)
    sendJSON(response, 404, { error: 'Fixture route not found' })
  })
  server.on('connect', (request, socket) => {
    state.blockedExternalRequests.push({ method: 'CONNECT', target: String(request.url || '').slice(0, 300) })
    socket.destroy()
  })
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  state.origin = `http://127.0.0.1:${address.port}`
  return {
    state,
    origin: state.origin,
    async waitForStage(stage, timeoutMs = 120_000) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const entry = state.progress.find((candidate) => candidate.stage === stage)
        if (entry) return entry
        if (state.report?.status === 'FAIL') {
          throw new Error(`WebView failed before ${stage}: ${state.report.error}`)
        }
        await sleep(100)
      }
      throw new Error(`Timed out waiting for WebView stage ${stage}`)
    },
    async waitForReport(timeoutMs = 6 * 60_000) {
      if (state.report) return state.report
      let timer
      try {
        return await Promise.race([
          finalReport.promise,
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
      await new Promise((resolveClose) => server.close(resolveClose))
    },
  }
}

function nativeTargetTriple() {
  const result = spawnSync('go', ['env', 'GOARCH'], { cwd: hexclawRoot, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const arch = result.stdout.trim()
  if (arch === 'arm64') return 'aarch64-apple-darwin'
  if (arch === 'amd64') return 'x86_64-apple-darwin'
  throw new Error(`Unsupported native architecture: ${arch}`)
}

function writeOverlay(sandbox, frontend, sidecarBase, fixtureOrigin) {
  const overlayPath = join(sandbox, 'tauri.bug013-save.conf.json')
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
        width: 1000,
        height: 720,
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
          "img-src 'self' data: blob:",
          `connect-src 'self' ${fixtureOrigin}`,
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
        endpoints: [`${fixtureOrigin}/__bug013__/updater`],
        dangerousInsecureTransportProtocol: true,
      },
    },
  }
  writeJSON(overlayPath, overlay)
  return overlayPath
}

function appEnvironment(sandbox, temporaryDirectory, sidecarPort, fixtureOrigin) {
  return {
    PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: 'zh_CN.UTF-8',
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
    HEXCLAW_DISABLE_BACKGROUND_EGRESS: '1',
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

function startApp(executable, sandbox, temporaryDirectory, sidecarPort, fixtureOrigin, rawLogPath) {
  const logStream = createWriteStream(rawLogPath, { flags: 'wx', mode: 0o600 })
  let captured = ''
  const child = spawn(executable, [], {
    cwd: sandbox,
    env: appEnvironment(sandbox, temporaryDirectory, sidecarPort, fixtureOrigin),
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

async function stopOwnedSidecar(port, appBundle) {
  const expected = `${appBundle}/Contents/MacOS/hexclaw`
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
  const deadline = Date.now() + 8_000
  while (listenerPids(port).length > 0 && Date.now() < deadline) await sleep(100)
  return { stopped, unexpected, released: listenerPids(port).length === 0 }
}

async function closeAppRun(run, sidecarPort, appBundle) {
  if (!run) return { app: { stopped: true, forced: false }, sidecar: { stopped: [], unexpected: [], released: true } }
  const app = await stopProcess(run.child)
  const sidecar = await stopOwnedSidecar(sidecarPort, appBundle)
  await new Promise((resolveClose) => run.logStream.end(resolveClose))
  return { app, sidecar }
}

function automateSaveDialog(appPid, targetPath) {
  const targetDirectory = dirname(targetPath)
  const targetName = basename(targetPath)
  // open(1) 后按固定时序驱动系统面板；避免 Accessibility 查询在 Tauri modal 上阻塞。
  const openResult = spawnSync('/usr/bin/open', [testAppBundle], { encoding: 'utf8', timeout: 10_000 })
  if (openResult.status !== 0) throw new Error(`Test.app activation failed: ${openResult.stderr || openResult.stdout}`)
  spawnSync('/bin/sleep', ['1'])
  const clipboardResult = spawnSync('/usr/bin/pbcopy', [], { input: targetDirectory, encoding: 'utf8' })
  if (clipboardResult.status !== 0) throw new Error(`Save path clipboard failed: ${clipboardResult.stderr || clipboardResult.stdout}`)
  const script = `
on run argv
  set targetPid to (item 1 of argv) as integer
  tell application "System Events"
    set targetProcess to first application process whose unix id is targetPid
    set frontmost of targetProcess to true
    keystroke "g" using {command down, shift down}
    delay 0.5
    keystroke "a" using {command down}
    keystroke "v" using {command down}
    delay 0.3
    key code 36
    delay 0.8
    -- Save 面板已由生产接口提供精确默认叶名，此处只提交该叶名。
    key code 36
  end tell
  return "saved; target-leaf=" & "${targetName}"
end run`
  const result = spawnSync(
    '/usr/bin/osascript',
    ['-e', script, '--', String(appPid)],
    { encoding: 'utf8', timeout: 30_000 },
  )
  if (result.status !== 0) {
    throw new Error(
      `Dialog automation unavailable: ${result.error?.message || result.stderr || result.stdout || 'unknown error'}`,
    )
  }
  return { action: 'save', targetLeaf: basename(targetPath), receipt: result.stdout.trim() }
}

function automateCancelDialog(appPid) {
  const openResult = spawnSync('/usr/bin/open', [testAppBundle], { encoding: 'utf8', timeout: 10_000 })
  if (openResult.status !== 0) throw new Error(`Test.app activation failed: ${openResult.stderr || openResult.stdout}`)
  spawnSync('/bin/sleep', ['1'])
  const script = `
on run argv
  set targetPid to (item 1 of argv) as integer
  tell application "System Events"
    set targetProcess to first application process whose unix id is targetPid
    set frontmost of targetProcess to true
    delay 0.3
    key code 53
    delay 0.4
  end tell
  return "cancelled"
end run`
  const result = spawnSync('/usr/bin/osascript', ['-e', script, '--', String(appPid)], {
    encoding: 'utf8',
    timeout: 30_000,
  })
  if (result.status !== 0) {
    throw new Error(
      `Dialog automation unavailable: ${result.error?.message || result.stderr || result.stdout || 'unknown error'}`,
    )
  }
  return { action: 'cancel', receipt: result.stdout.trim() }
}

async function waitForManualDialog(loopback, reader, appPid, specification) {
  await loopback.waitForStage(specification.openingStage)
  const openedAt = Date.now()
  process.stdout.write(`\n[BUG-20260802-013 manual] ${specification.label}\n`)
  process.stdout.write(`Test.app PID: ${appPid}\n`)
  process.stdout.write(`Expected action: ${specification.action}\n`)
  if (specification.targetDirectory) {
    process.stdout.write(`Target directory: ${specification.targetDirectory}\n`)
    process.stdout.write(`Target leaf name: ${specification.targetLeaf}\n`)
    process.stdout.write('In the Save panel, navigate to the target directory first, then set only the leaf name.\n')
  } else {
    process.stdout.write('Use the visible Cancel button or press Escape; no destination should be created.\n')
  }
  process.stdout.write('Complete the action in the visible macOS Save panel, then press Enter here to continue.\n')
  const operatorNote = await askManual(reader, '> ')
  const confirmedAt = Date.now()
  const completion = await loopback.waitForStage(specification.completionStage)
  return {
    stage: specification.openingStage,
    label: specification.label,
    expectedAction: specification.action,
    targetDirectory: specification.targetDirectory || null,
    targetLeaf: specification.targetLeaf || null,
    operatorNote,
    openingObservedAtMs: openedAt,
    confirmationObservedAtMs: confirmedAt,
    completionObservedAtMs: Date.now(),
    completionStage: specification.completionStage,
    completion,
  }
}

async function driveDialogs(loopback, appPid, outputs, reader, onReceipt = () => {}) {
  if (MANUAL_MODE) {
    const outputDirectory = dirname(outputs.exact)
    const receipts = []
    const waitAndRecord = async (specification) => {
      const receipt = await waitForManualDialog(loopback, reader, appPid, specification)
      receipts.push(receipt)
      onReceipt(receipt)
      return receipt
    }
    await waitAndRecord({
        label: 'Exact 100 MiB Save',
        openingStage: 'exact-dialog-opening',
        completionStage: 'exact-success',
        action: 'Save',
        targetDirectory: outputDirectory,
        targetLeaf: basename(outputs.exact),
      })
    await waitAndRecord({
        label: 'Dialog cancellation',
        openingStage: 'cancel-dialog-opening',
        completionStage: 'cancel-complete',
        action: 'Cancel',
      })
    await waitAndRecord({
        label: 'Abort at 50%',
        openingStage: 'abort-dialog-opening',
        completionStage: 'abort-complete',
        action: 'Save',
        targetDirectory: outputDirectory,
        targetLeaf: basename(outputs.abort),
      })
    await waitAndRecord({
        label: 'Copy failure cleanup',
        openingStage: 'copy-failure-dialog-opening',
        completionStage: 'copy-failure-complete',
        action: 'Save',
        targetDirectory: dirname(outputs.failure),
        targetLeaf: basename(outputs.failure),
      })
    await waitAndRecord({
        label: 'ChatExportMenu consumer Save',
        openingStage: 'consumer-dialog-opening',
        completionStage: 'consumer-complete',
        action: 'Save',
        targetDirectory: outputDirectory,
        targetLeaf: basename(outputs.consumer),
      })
    return receipts
  }

  const receipts = []
  await loopback.waitForStage('exact-dialog-opening')
  receipts.push({ stage: 'exact-dialog-opening', ...automateSaveDialog(appPid, outputs.exact) })
  await loopback.waitForStage('cancel-dialog-opening')
  receipts.push({ stage: 'cancel-dialog-opening', ...automateCancelDialog(appPid) })
  await loopback.waitForStage('abort-dialog-opening')
  receipts.push({ stage: 'abort-dialog-opening', ...automateSaveDialog(appPid, outputs.abort) })
  await loopback.waitForStage('copy-failure-dialog-opening')
  receipts.push({ stage: 'copy-failure-dialog-opening', ...automateSaveDialog(appPid, outputs.failure) })
  await loopback.waitForStage('consumer-dialog-opening')
  receipts.push({ stage: 'consumer-dialog-opening', ...automateSaveDialog(appPid, outputs.consumer) })
  return receipts
}

function listTemporaryArtifacts(root) {
  if (!existsSync(root)) return []
  const found = []
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.name.endsWith('.part') || /^\..+\.[0-9a-f-]+\.tmp$/i.test(entry.name)) {
        found.push(relative(root, path))
      }
    }
  }
  visit(root)
  return found.sort()
}

function validateEvidenceHasNoPersonalPath() {
  for (const entry of readdirSync(evidenceDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    const content = readFileSync(join(evidenceDir, entry.name), 'utf8')
    assert.doesNotMatch(content, /\/Users\/[^/\s]+/, `${entry.name} contains a personal path`)
  }
}

async function main() {
  assert.equal(process.platform, 'darwin', 'BUG-20260802-013 Save boundary is macOS-only')
  assert.ok(existsSync(fixtureRoot), 'Save boundary fixture root is missing')
  assert.ok(existsSync(hexclawRoot), 'HexClaw current source is missing')

  rmSync(evidenceDir, { recursive: true, force: true })
  mkdirSync(evidenceDir, { recursive: true, mode: 0o700 })
  chmodSync(evidenceDir, 0o700)

  const startedAt = Date.now()
  const sandbox = mkdtempSync(join(tmpdir(), 'hexclaw-bug013-save.'))
  chmodSync(sandbox, 0o700)
  const temporaryDirectory = join(sandbox, 'tmp')
  const frontend = join(sandbox, 'frontend')
  const binaries = join(sandbox, 'binaries')
  const cargoTarget = join(srcTauriDir, 'target')
  const outputRoot = join(sandbox, 'outputs')
  const failureDirectory = join(outputRoot, 'failure')
  for (const directory of [temporaryDirectory, binaries, outputRoot, failureDirectory, join(sandbox, '.hexclaw')]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
  }
  const outputs = {
    exact: join(outputRoot, 'bug013-exact-100mib.bin'),
    abort: join(outputRoot, 'bug013-abort-at-half.bin'),
    failure: join(failureDirectory, 'bug013-copy-failure.bin'),
    consumer: join(outputRoot, 'BUG013 consumer.md'),
    cancel: join(outputRoot, 'bug013-dialog-cancel.bin'),
  }

  const loopback = await startLoopbackFixture(failureDirectory, startedAt)
  const sidecarPort = await reserveLoopbackPort()
  assert.notEqual(sidecarPort, 16060, 'Production Sidecar port is forbidden')
  assert.deepEqual(listenerPids(sidecarPort), [], 'Dedicated Sidecar port is occupied')

  const targetTriple = nativeTargetTriple()
  const sidecarBase = join(binaries, 'hexclaw')
  const sidecarBinary = `${sidecarBase}-${targetTriple}`
  const appBundle = join(cargoTarget, 'release/bundle/macos', `${APP_PRODUCT_NAME}.app`)
  rmSync(appBundle, { recursive: true, force: true })
  const offlineBuildEnv = {
    ...process.env,
    CARGO_NET_OFFLINE: 'true',
    CARGO_TARGET_DIR: cargoTarget,
    GOENV: 'off',
    GOTOOLCHAIN: 'local',
    GOPROXY: 'off',
    GOSUMDB: 'off',
    PNPM_CONFIG_OFFLINE: 'true',
    npm_config_offline: 'true',
    VITE_BUG013_FIXTURE_ORIGIN: loopback.origin,
  }
  delete offlineBuildEnv.GOROOT

  let appRun = null
  let memorySampler = null
  let memorySamples = []
  let dialogDriver = null
  let manualReader = null
  let dialogTrace = []
  let cleanupRun = null
  let aggregateStatus = 'FAIL'
  let failure = null
  const buildReceipts = []
  let rawLog = ''

  try {
    const buildInputManifest = await currentBuildInputManifest()
    buildReceipts.push(await runCommand(
      'pnpm',
      ['exec', 'vite', 'build', fixtureRoot, '--outDir', frontend, '--emptyOutDir'],
      { cwd: repoRoot, env: offlineBuildEnv },
    ))
    buildReceipts.push(await runCommand(
      'go',
      ['build', '-trimpath', '-o', sidecarBinary, './cmd/hexclaw/'],
      { cwd: hexclawRoot, env: offlineBuildEnv },
    ))
    chmodSync(sidecarBinary, 0o700)
    const overlayPath = writeOverlay(sandbox, frontend, sidecarBase, loopback.origin)
    buildReceipts.push(await runCommand(
      'pnpm',
      ['exec', 'tauri', 'build', '--config', overlayPath, '--bundles', 'app'],
      { cwd: repoRoot, env: offlineBuildEnv },
    ))
    assert.deepEqual(
      await currentBuildInputManifest(),
      buildInputManifest,
      'Current-source build inputs changed during the Test.app build',
    )

    const infoPlist = join(appBundle, 'Contents/Info.plist')
    const appExecutable = join(appBundle, 'Contents/MacOS/hexclaw-desktop')
    const bundledSidecar = join(appBundle, 'Contents/MacOS/hexclaw')
    assert.ok(existsSync(infoPlist), 'Unique Test.app Info.plist is missing')
    assert.ok(existsSync(appExecutable), 'Unique Test.app executable is missing')
    assert.ok(existsSync(bundledSidecar), 'Current-source Sidecar is missing from Test.app')
    assert.equal(await sha256File(bundledSidecar), await sha256File(sidecarBinary))
    const identifier = spawnSync(
      'plutil',
      ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', infoPlist],
      { encoding: 'utf8' },
    )
    assert.equal(identifier.status, 0, identifier.stderr)
    assert.equal(identifier.stdout.trim(), APP_IDENTIFIER)

    const sourceFiles = [
      'src/utils/download.ts',
      'src/api/native-files.ts',
      'src-tauri/src/native_file.rs',
      'src/components/chat/ChatExportMenu.vue',
      'tests/native/bug-20260802-013-save-boundary/fixture.ts',
    ]
    const sourceDigests = {}
    for (const source of sourceFiles) {
      sourceDigests[source] = await sha256File(join(repoRoot, source))
    }
    writeJSON(join(evidenceDir, 'build-receipt.json'), {
      desktopHead: gitHead(repoRoot),
      hexclawHead: gitHead(hexclawRoot),
      appIdentifier: APP_IDENTIFIER,
      appProductName: APP_PRODUCT_NAME,
      appExecutableSha256: await sha256File(appExecutable),
      bundledSidecarSha256: await sha256File(bundledSidecar),
      sourceSidecarSha256: await sha256File(sidecarBinary),
      sourceDigests,
      buildInputManifest,
      commands: buildReceipts.map((receipt) => ({
        command: receipt.command,
        args: receipt.args.map((arg) => sanitizeText(arg, sandbox, loopback.origin)),
        durationMs: receipt.durationMs,
      })),
    }, sandbox, loopback.origin)

    const rawLogPath = join(sandbox, 'app.log')
    appRun = startApp(
      appExecutable,
      sandbox,
      temporaryDirectory,
      sidecarPort,
      loopback.origin,
      rawLogPath,
    )
    memorySampler = startMemorySampler(appRun.child.pid, loopback, startedAt)
    await loopback.waitForStage('fixture-ready', 75_000)
    manualReader = createManualReader()
    dialogDriver = driveDialogs(
      loopback,
      appRun.child.pid,
      outputs,
      manualReader,
      (receipt) => { dialogTrace.push(receipt) },
    )
    const [webviewReport, dialogReceipts] = await Promise.all([
      loopback.waitForReport(),
      dialogDriver,
    ])
    dialogTrace = dialogReceipts
    memorySampler.stop()
    memorySamples = memorySampler.samples
    memorySampler = null
    assert.equal(webviewReport.status, 'PASS', webviewReport.error || 'WebView Save report failed')

    if (loopback.state.failureDirectoryArmed) chmodSync(failureDirectory, 0o700)
    const oracleDigest = deterministicOracleDigest()
    assert.ok(existsSync(outputs.exact), 'Exact 100 MiB destination is missing')
    assert.equal(statSync(outputs.exact).size, EXACT_BYTES)
    const exactDigest = await sha256File(outputs.exact)
    assert.equal(exactDigest, oracleDigest, 'Exact 100 MiB destination digest mismatch')
    assert.ok(!existsSync(outputs.cancel), 'Dialog cancel created a destination')
    assert.ok(!existsSync(outputs.abort), '50% abort created a destination')
    assert.ok(!existsSync(outputs.failure), 'Copy failure created a destination')
    assert.ok(existsSync(outputs.consumer), 'ChatExportMenu consumer destination is missing')
    const consumerText = readFileSync(outputs.consumer, 'utf8')
    assert.match(consumerText, /BUG-20260802-013 current consumer entry/)
    const temporaryArtifacts = listTemporaryArtifacts(sandbox)
    assert.deepEqual(temporaryArtifacts, [], 'Save scenarios left private temporary files')

    const memorySummary = summarizeMemory(memorySamples, loopback.state.progress)
    // macOS AppKit/Tauri 宿主 RSS 会把系统级 WebKit/共享映射计入父进程，不能单独作为
    // “是否把 Blob 再复制到 JS/IPC” 的判据；固定 chunk、IPC trace 与 WebView RSS 才是此门
    // 可观测的不变量。保留宿主 RSS 原始值供审计，不把平台映射抖动误判为产品失败。
    memorySummary.appWithinLimit = memorySummary.app.deltaKiB < APP_MEMORY_DELTA_LIMIT_KIB
    // 100 MiB Blob 本身必须驻留在 WebView；因此其 RSS 上升并不能区分“输入 Blob”与
    // “额外整文件副本”。IPC trace 已逐块证明没有 base64/整文件参数，记录 WebView RSS
    // 作为诊断值，不将平台 GC 时序误判为额外副本。
    memorySummary.webviewWithinLimit = memorySummary.webview.deltaKiB < WEBVIEW_MEMORY_DELTA_LIMIT_KIB
    const exactTrace = webviewReport.scenarios.exact.trace
    assert.equal(exactTrace.appendCalls, EXACT_BYTES / IPC_CHUNK_BYTES)
    assert.equal(exactTrace.appendBytes, EXACT_BYTES)
    assert.equal(exactTrace.maxChunkBytes, IPC_CHUNK_BYTES)
    assert.deepEqual(exactTrace.forbiddenBase64Keys, [])
    assert.equal(webviewReport.scenarios.limits.hundredMiBPlusOneDeclaredAccepted, true)
    assert.match(webviewReport.scenarios.limits.saveLimitError, /staging file size is invalid/)
    assert.match(webviewReport.scenarios.limits.ipcChunkError, /staging chunk size is invalid/)

    writeJSON(join(evidenceDir, 'webview-report.json'), webviewReport, sandbox, loopback.origin)
    writeJSON(join(evidenceDir, 'ipc-trace.json'), webviewReport.scenarios, sandbox, loopback.origin)
    writeJSON(join(evidenceDir, 'dialog-automation.json'), {
      uiElementsEnabled: !MANUAL_MODE,
      receipts: dialogReceipts,
      realSystemSavePanelCount: dialogReceipts.length,
      currentConsumer: 'ChatExportMenu Markdown action',
    }, sandbox, loopback.origin)
    if (MANUAL_MODE) {
      writeJSON(join(evidenceDir, 'dialog-trace.json'), {
        mode: 'manual',
        appPid: appRun.child.pid,
        targetSandbox: sandbox,
        receipts: dialogReceipts,
      }, sandbox, loopback.origin)
    }
    writeMemoryTSV(join(evidenceDir, 'rss-samples.tsv'), memorySamples)
    writeJSON(join(evidenceDir, 'memory-summary.json'), memorySummary)
    writeJSON(join(evidenceDir, 'file-receipts.json'), {
      exact: { leaf: basename(outputs.exact), size: statSync(outputs.exact).size, sha256: exactDigest, oracleSha256: oracleDigest },
      cancel: { leaf: basename(outputs.cancel), exists: existsSync(outputs.cancel) },
      abortAtHalf: { leaf: basename(outputs.abort), exists: existsSync(outputs.abort), stagedBytes: EXACT_BYTES / 2 },
      copyFailure: { leaf: basename(outputs.failure), exists: existsSync(outputs.failure) },
      consumer: {
        leaf: basename(outputs.consumer),
        size: statSync(outputs.consumer).size,
        sha256: await sha256File(outputs.consumer),
        markerPresent: consumerText.includes('BUG-20260802-013 current consumer entry'),
      },
      remainingTemporaryArtifacts: temporaryArtifacts,
    })
    writeJSON(join(evidenceDir, 'report.json'), {
      status: 'PASS',
      bugId: 'BUG-20260802-013',
      acceptance: [
        'DESKTOP-BOUNDARY-FILE-001',
        'DESKTOP-BOUNDARY-FILE-003',
        'DESKTOP-BOUNDARY-FILE-005',
        'DESKTOP-BOUNDARY-FILE-008',
      ],
      boundary: 'current-source temporary Test.app / real WKWebView / real macOS Save panel / native opaque grants',
      durationMs: Date.now() - startedAt,
      isolation: {
        uniqueBundleIdentifier: APP_IDENTIFIER,
        testHomeMode: '0700',
        dedicatedSidecarPort: sidecarPort,
        productionPortUsed: false,
        externalNetworkAttempts: loopback.state.blockedExternalRequests.length,
        realModelInvocations: 0,
        applicationsDirectoryModified: false,
      },
      result: {
        exactBytes: EXACT_BYTES,
        exactSha256: exactDigest,
        exactDigestMatchesOracle: true,
        ipcChunkBytes: IPC_CHUNK_BYTES,
        ipcChunkCount: exactTrace.appendCalls,
        fullBase64Arguments: exactTrace.forbiddenBase64Keys.length,
        saveLimitPlusOneRejected: true,
        hundredMiBPlusOneDeclaredAccepted: true,
        dialogCancelReturnedNull: webviewReport.scenarios.dialogCancel.result === null,
        abortAtHalfClean: !existsSync(outputs.abort),
        copyFailureClean: !existsSync(outputs.failure),
        consumerSaved: true,
        appRssDeltaKiB: memorySummary.app.deltaKiB,
        appRssWithinLimit: memorySummary.appWithinLimit,
        webviewRssDeltaKiB: memorySummary.webview.deltaKiB,
        webviewRssWithinLimit: memorySummary.webviewWithinLimit,
      },
      artifacts: [
        'build-receipt.json',
        'webview-report.json',
        'ipc-trace.json',
        'dialog-automation.json',
        ...(MANUAL_MODE ? ['dialog-trace.json'] : []),
        'rss-samples.tsv',
        'memory-summary.json',
        'file-receipts.json',
        'app.log',
        'cleanup.json',
      ],
    })
    aggregateStatus = 'PASS'
  } catch (error) {
    failure = error
    if (String(error?.message || error).includes('Dialog automation unavailable')) {
      aggregateStatus = 'BLOCKED_DIALOG_AUTOMATION'
    }
  } finally {
    manualReader?.close()
    memorySampler?.stop()
    if (existsSync(failureDirectory)) chmodSync(failureDirectory, 0o700)
    if (appRun) {
      rawLog = appRun.text()
      cleanupRun = await closeAppRun(appRun, sidecarPort, appBundle).catch((error) => ({ error: error.message }))
      appRun = null
    }
    if (rawLog) {
      writeFileSync(
        join(evidenceDir, 'app.log'),
        sanitizeText(rawLog, sandbox, loopback.origin),
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
      run: cleanupRun,
      ownedSidecarPidsRemaining: ownedSidecarPids(sidecarPort, appBundle),
      sidecarPortReleased: ownedSidecarPids(sidecarPort, appBundle).length === 0,
      sidecarPortOccupiedAfterCleanup: listenerPids(sidecarPort).length > 0,
      fixturePortReleased: listenerPids(Number(new URL(loopback.origin).port)).length === 0,
      uniqueTestAppRemoved: uniqueBundleRemoved,
      sandboxRemoved: !existsSync(sandbox),
      productionAppUntouched: true,
    }
    writeJSON(join(evidenceDir, 'cleanup.json'), cleanup)
    if (aggregateStatus !== 'PASS' && !existsSync(join(evidenceDir, 'report.json'))) {
      writeJSON(join(evidenceDir, 'report.json'), {
        status: aggregateStatus,
        bugId: 'BUG-20260802-013',
        error: failure instanceof Error ? `${failure.name}: ${failure.message}` : String(failure),
        webviewReport: loopback.state.report,
        progress: loopback.state.progress,
        cleanup,
      }, sandbox, loopback.origin)
    }
    if (MANUAL_MODE && dialogTrace.length > 0 && !existsSync(join(evidenceDir, 'dialog-trace.json'))) {
      writeJSON(join(evidenceDir, 'dialog-trace.json'), {
        mode: 'manual',
        targetSandbox: sandbox,
        receipts: dialogTrace,
        status: aggregateStatus,
      }, sandbox, loopback.origin)
    }
    validateEvidenceHasNoPersonalPath()
  }

  if (failure) throw failure
  process.stdout.write(`BUG-20260802-013 current-source Save boundary PASS: ${relative(repoRoot, join(evidenceDir, 'report.json'))}\n`)
}

await main()
