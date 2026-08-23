#!/usr/bin/env node

/**
 * BUG-20260728-007 的共享 Test.app 只读边界探针。
 *
 * 仅在独立 0700 Test Home 下启动现有测试包，记录窗口与截图能力，并对包内关键文件做
 * 启动前后摘要校验。不会重建、复制或修改 App，也不会访问 /Applications。
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
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const nativeDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(nativeDir, '../..')
const evidenceRoot = join(repoRoot, 'test/evidence/bug-20260728-007-current-source/native')
const bundle = join(repoRoot, 'src-tauri/target/release/bundle/macos/HexClaw Test.app')
const infoPlist = join(bundle, 'Contents/Info.plist')
const executable = join(bundle, 'Contents/MacOS/hexclaw-desktop')
const sidecarExecutable = join(bundle, 'Contents/MacOS/hexclaw')
const sidecarPort = 16061
const sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds))

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function fileFact(file) {
  if (!existsSync(file)) return { exists: false }
  const stat = statSync(file)
  return {
    exists: true,
    path: relative(repoRoot, file),
    bytes: stat.size,
    mode: (stat.mode & 0o777).toString(8).padStart(4, '0'),
    modifiedAt: stat.mtime.toISOString(),
    sha256: sha256File(file),
  }
}

function imageDimensions(file) {
  try {
    const output = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file], {
      encoding: 'utf8',
    })
    const width = Number(output.match(/pixelWidth:\s*(\d+)/)?.[1])
    const height = Number(output.match(/pixelHeight:\s*(\d+)/)?.[1])
    return Number.isFinite(width) && Number.isFinite(height) ? { width, height } : null
  } catch {
    return null
  }
}

function bundleSignature() {
  return {
    infoPlist: fileFact(infoPlist),
    executable: fileFact(executable),
    sidecar: fileFact(sidecarExecutable),
  }
}

function plistValue(key) {
  if (!existsSync(infoPlist)) return null
  try {
    return execFileSync('plutil', ['-extract', key, 'raw', '-o', '-', infoPlist], {
      encoding: 'utf8',
    }).trim()
  } catch {
    return null
  }
}

function listenerPIDs(port) {
  try {
    return execFileSync(
      'lsof',
      ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'],
      { encoding: 'utf8' },
    )
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number)
      .filter(Number.isFinite)
  } catch {
    return []
  }
}

function processCommand(pid) {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

function ownedSidecarPIDs() {
  const marker = `${bundle}/Contents/MacOS/hexclaw serve --desktop`
  try {
    return execFileSync('ps', ['-Ao', 'pid=,command='], { encoding: 'utf8' })
      .split('\n')
      .map((line) => line.match(/^\s*(\d+)\s+(.+)$/))
      .filter((match) => match && match[2].includes(marker))
      .map((match) => Number(match[1]))
      .filter(Number.isFinite)
  } catch {
    return []
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function windowInfoForPID(pid) {
  const swift = `
import CoreGraphics
import Foundation
let target: Int32 = ${Number(pid)}
let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
let rows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] ?? []
for row in rows {
  let owner = (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value ?? -1
  let layer = (row[kCGWindowLayer as String] as? NSNumber)?.intValue ?? -1
  let alpha = (row[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 0
  if owner == target && layer == 0 && alpha > 0,
     let id = (row[kCGWindowNumber as String] as? NSNumber)?.intValue,
     let bounds = row[kCGWindowBounds as String] as? [String: Any],
     let x = (bounds["X"] as? NSNumber)?.doubleValue,
     let y = (bounds["Y"] as? NSNumber)?.doubleValue,
     let width = (bounds["Width"] as? NSNumber)?.doubleValue,
     let height = (bounds["Height"] as? NSNumber)?.doubleValue {
    print("\\(id)|\\(x)|\\(y)|\\(width)|\\(height)")
    break
  }
}
`
  const output = execFileSync('/usr/bin/swift', ['-e', swift], { encoding: 'utf8' }).trim()
  if (!output) return null
  const [id, x, y, width, height] = output.split('|').map(Number)
  if (![id, x, y, width, height].every(Number.isFinite)) return null
  return { id, x, y, width, height }
}

async function waitForWindow(processHandle, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) return null
    const window = windowInfoForPID(processHandle.pid)
    if (window) return window
    await sleep(500)
  }
  return null
}

async function stopProcess(processHandle) {
  if (!processHandle || processHandle.exitCode !== null) return
  processHandle.kill('SIGTERM')
  const exited = await Promise.race([
    new Promise((resolveExit) => processHandle.once('exit', () => resolveExit(true))),
    sleep(5_000).then(() => false),
  ])
  if (!exited && processHandle.exitCode === null) {
    processHandle.kill('SIGKILL')
    await new Promise((resolveExit) => processHandle.once('exit', resolveExit))
  }
}

function sanitize(raw, sandbox) {
  return raw.replaceAll(repoRoot, '<repo>').replaceAll(sandbox, '<test-home>')
}

assert.equal(process.platform, 'darwin', 'Test.app read-only probe is macOS-only')
mkdirSync(evidenceRoot, { recursive: true })
const sandbox = mkdtempSync(join(tmpdir(), 'hexclaw-bug-20260728-007-native.'))
chmodSync(sandbox, 0o700)
mkdirSync(join(sandbox, '.hexclaw'), { mode: 0o700 })
mkdirSync(join(sandbox, 'tmp'), { mode: 0o700 })

const before = bundleSignature()
const report = {
  bug: 'BUG-20260728-007',
  status: 'NOT_RUN',
  visualConclusion: 'NOT_COMPARABLE',
  app: {
    bundle: relative(repoRoot, bundle),
    outsideApplications: !bundle.startsWith('/Applications/'),
    bundleExists: existsSync(bundle),
    identifier: plistValue('CFBundleIdentifier'),
    displayName: plistValue('CFBundleDisplayName'),
    version: plistValue('CFBundleShortVersionString'),
    launched: false,
    rebuilt: false,
    copied: false,
    modified: false,
    before,
    after: null,
  },
  isolation: {
    testHomeMode: (statSync(sandbox).mode & 0o777).toString(8).padStart(4, '0'),
    configMode: null,
    realHomePassedToChild: false,
    realUserDataWritten: false,
    testHomeWritesAllowed: true,
    externalNetworkRequestsObserved: [],
    externalNetworkObservation: 'not instrumented; Provider is disabled and the Test.app CSP is loopback-only',
    realModelCalls: 0,
    sidecarPort,
    preexistingSidecarPIDs: listenerPIDs(sidecarPort),
    stoppedOwnedSidecarPIDs: [],
    remainingSidecarPIDs: [],
    testHomeRemoved: false,
  },
  window: null,
  screenshot: null,
  provenance: {
    currentSourceTraceableInBundle: false,
    equivalentFixtureInjectedIntoWKWebView: false,
    reasons: [
      'The shared Test.app has no receipt binding its embedded frontend to this current worktree.',
      'The browser fixture uses route interception and DOM-only inert content normalization that are unavailable in the closed WKWebView.',
      'The native window size, DPR and visible chat state cannot be forced to the browser pair without rebuilding or mutating the shared App.',
    ],
  },
}

let processHandle = null
let logStream = null
const logPath = join(sandbox, 'app.log')
let nativeError = null

try {
  assert.ok(report.app.outsideApplications, 'probe must never use /Applications')
  assert.ok(existsSync(bundle), `shared Test.app is missing: ${bundle}`)
  assert.ok(existsSync(executable), `shared Test.app executable is missing: ${executable}`)
  assert.ok(existsSync(sidecarExecutable), `shared Test.app Sidecar is missing: ${sidecarExecutable}`)
  if (report.isolation.preexistingSidecarPIDs.length > 0) {
    report.status = 'NOT_RUN_PORT_OCCUPIED'
  } else {
    const configPath = join(sandbox, '.hexclaw/hexclaw.yaml')
    writeFileSync(
      configPath,
      `server:\n  host: 127.0.0.1\n  port: ${sidecarPort}\n  mode: development\nllm:\n  providers: {}\n  routing:\n    enabled: false\n  cache:\n    enabled: false\nknowledge:\n  enabled: false\nmemory:\n  long_term:\n    enabled: false\nheartbeat:\n  enabled: false\nmcp:\n  enabled: false\nskills:\n  enabled: false\n  auto_load: false\nvoice:\n  enabled: false\nobserve:\n  log_level: error\n`,
      { mode: 0o600 },
    )
    chmodSync(configPath, 0o600)
    report.isolation.configMode = (statSync(configPath).mode & 0o777)
      .toString(8)
      .padStart(4, '0')
    logStream = createWriteStream(logPath, { flags: 'wx', mode: 0o600 })
    processHandle = spawn(executable, [], {
      cwd: sandbox,
      env: {
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
        DINGTALK_LIVE_SEND: '0',
        NO_PROXY: '*',
        no_proxy: '*',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    processHandle.stdout.pipe(logStream, { end: false })
    processHandle.stderr.pipe(logStream, { end: false })
    report.app.launched = true

    const window = await waitForWindow(processHandle)
    report.window = window
    if (window) {
      const screenshotPath = join(evidenceRoot, 'test-app-readonly.png')
      try {
        execFileSync('/usr/sbin/screencapture', ['-x', '-l', String(window.id), screenshotPath])
        const screenshot = { ...fileFact(screenshotPath), pixels: imageDimensions(screenshotPath) }
        report.screenshot = screenshot
        report.status = screenshot.exists && screenshot.bytes > 1024 ? 'LIMITED_PASS' : 'NOT_PASS'
      } catch (error) {
        nativeError = `screen-capture:${error instanceof Error ? error.message : String(error)}`
        report.status = 'BLOCKED_SCREEN_CAPTURE'
      }
    } else {
      nativeError = 'no-visible-window-within-20s'
      report.status = 'BLOCKED_NO_WINDOW'
    }
  }
} catch (error) {
  nativeError = error instanceof Error ? error.message : String(error)
  report.status = 'NOT_PASS'
} finally {
  await stopProcess(processHandle)
  if (logStream) await new Promise((resolveEnd) => logStream.end(resolveEnd))
  await sleep(500)
  for (const pid of [...new Set([...ownedSidecarPIDs(), ...listenerPIDs(sidecarPort)])]) {
    const command = processCommand(pid)
    if (command.includes(`${bundle}/Contents/MacOS/hexclaw serve --desktop`)) {
      process.kill(pid, 'SIGTERM')
      report.isolation.stoppedOwnedSidecarPIDs.push(pid)
    } else {
      nativeError = `${nativeError ? `${nativeError};` : ''}unexpected-listener:${pid}`
      report.status = 'NOT_PASS'
    }
  }
  const deadline = Date.now() + 5_000
  while (
    (ownedSidecarPIDs().length > 0 || listenerPIDs(sidecarPort).length > 0) &&
    Date.now() < deadline
  ) {
    await sleep(100)
  }
  for (const pid of [...new Set([...ownedSidecarPIDs(), ...listenerPIDs(sidecarPort)])]) {
    const command = processCommand(pid)
    if (command.includes(`${bundle}/Contents/MacOS/hexclaw serve --desktop`)) {
      process.kill(pid, 'SIGKILL')
      if (!report.isolation.stoppedOwnedSidecarPIDs.includes(pid)) {
        report.isolation.stoppedOwnedSidecarPIDs.push(pid)
      }
    } else {
      nativeError = `${nativeError ? `${nativeError};` : ''}unexpected-listener:${pid}`
      report.status = 'NOT_PASS'
    }
  }
  const killDeadline = Date.now() + 5_000
  while (
    (ownedSidecarPIDs().some(processExists) || listenerPIDs(sidecarPort).length > 0) &&
    Date.now() < killDeadline
  ) {
    await sleep(100)
  }
  report.isolation.remainingSidecarPIDs = [
    ...new Set([...ownedSidecarPIDs().filter(processExists), ...listenerPIDs(sidecarPort)]),
  ]
  if (report.isolation.remainingSidecarPIDs.length > 0) report.status = 'NOT_PASS'

  report.app.after = bundleSignature()
  report.app.modified = JSON.stringify(report.app.before) !== JSON.stringify(report.app.after)
  if (report.app.modified) report.status = 'NOT_PASS'
  if (existsSync(logPath)) {
    writeFileSync(join(evidenceRoot, 'test-app-readonly.log'), sanitize(readFileSync(logPath, 'utf8'), sandbox), {
      mode: 0o600,
    })
  }
  report.error = nativeError
  rmSync(sandbox, { recursive: true })
  report.isolation.testHomeRemoved = !existsSync(sandbox)
  writeFileSync(
    join(evidenceRoot, 'test-app-readonly.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    { mode: 0o600 },
  )
}

assert.equal(report.app.modified, false, 'shared Test.app changed during the read-only probe')
assert.equal(report.isolation.testHomeRemoved, true, 'isolated Test Home was not removed')
assert.notEqual(report.status, 'NOT_PASS', JSON.stringify(report, null, 2))
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
