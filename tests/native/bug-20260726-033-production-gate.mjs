#!/usr/bin/env node

/**
 * BUG-20260726-033 生产安装态真实系统门。
 *
 * 只操作 /Applications/HexClaw.app；不改产品代码、不触碰 Provider 明文、不操作打印机。
 * Light/Dark、locale 和应用生命周期均在 finally 中恢复到进入测试前的值。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const currentFile = fileURLToPath(import.meta.url)
const repoRoot = resolve(dirname(currentFile), '../..')
const docsRoot = resolve(repoRoot, '../hexclaw-docs')
const evidenceRoot = join(repoRoot, 'test/evidence/bug-20260726-033-production-gate')
const productionBundle = '/Applications/HexClaw.app'
const productionExecutable = `${productionBundle}/Contents/MacOS/hexclaw-desktop`
const sidecarExecutable = `${productionBundle}/Contents/MacOS/hexclaw`
const productionPort = 16060
const appProbeSource = join(repoRoot, 'tests/native/bug-20260726-033-native-probe.swift')
const systemProbeSource = join(repoRoot, 'tests/native/bug-20260726-033-system-probe.swift')
const expectedChinese = ['打开 HexClaw', '快速对话…', '日志', '设置', '关于河蟹', '退出 HexClaw']
const expectedEnglish = ['Open HexClaw', 'Quick Chat…', 'Logs', 'Settings', 'About HexClaw', 'Quit HexClaw']
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function fileSha256(path) {
  return existsSync(path) ? sha256(readFileSync(path)) : null
}

function sanitize(value, sandbox) {
  return String(value)
    .replaceAll(repoRoot, '<repo>')
    .replaceAll(docsRoot, '<docs>')
    .replaceAll(homedir(), '<home>')
    .replaceAll(sandbox, '<sandbox>')
}

function writeJSON(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    env: options.env || process.env,
    encoding: 'utf8',
    timeout: options.timeout || 30_000,
    maxBuffer: 32 * 1024 * 1024,
  })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status}): ${result.stderr || result.stdout}`)
  }
  return String(result.stdout || '').trim()
}

function optional(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    env: options.env || process.env,
    encoding: 'utf8',
    timeout: options.timeout || 10_000,
    maxBuffer: 8 * 1024 * 1024,
  })
  return result.status === 0 ? String(result.stdout || '').trim() : null
}

function listenerPIDs(port = productionPort) {
  const result = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' })
  if (![0, 1].includes(result.status)) throw new Error(`lsof failed: ${result.stderr || result.stdout}`)
  return String(result.stdout || '').split(/\s+/).filter(Boolean).map(Number)
}

function processCommand(pid) {
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' })
  return result.status === 0 ? String(result.stdout || '').trim() : ''
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}

function productionPID() {
  const rows = run('ps', ['-axo', 'pid=,ppid=,command='])
    .split('\n')
    .map((line) => line.trim())
    .map((line) => line.match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }))
  return rows.find((row) => row.command === productionExecutable)?.pid || null
}

function productionProcesses() {
  return run('ps', ['-axo', 'pid=,ppid=,command='])
    .split('\n')
    .map((line) => line.trim())
    .map((line) => line.match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }))
    .filter((row) => row.command.includes(productionBundle))
}

function configSnapshot() {
  const paths = [
    join(homedir(), '.hexclaw/hexclaw.yaml'),
    join(homedir(), '.hexclaw/data.db'),
    join(homedir(), '.hexclaw/ui-state.json'),
  ]
  return paths.map((path) => {
    if (!existsSync(path)) return { path: path.replace(homedir(), '<home>'), exists: false }
    const stat = statSync(path)
    return {
      path: path.replace(homedir(), '<home>'),
      exists: true,
      mode: (stat.mode & 0o777).toString(8).padStart(4, '0'),
      bytes: stat.size,
      sha256: fileSha256(path),
    }
  })
}

function binarySnapshot() {
  const info = join(productionBundle, 'Contents/Info.plist')
  return {
    bundleIdentifier: optional('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', info]),
    version: optional('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', info]),
    desktopSha256: fileSha256(productionExecutable),
    sidecarSha256: fileSha256(sidecarExecutable),
    infoPlistSha256: fileSha256(info),
  }
}

function globalPreferences() {
  const dark = optional('/usr/bin/osascript', [
    '-e',
    'tell application "System Events" to get dark mode of appearance preferences',
  ])
  return {
    appleLanguages: optional('/usr/bin/defaults', ['read', '-g', 'AppleLanguages']),
    appleLocale: optional('/usr/bin/defaults', ['read', '-g', 'AppleLocale']),
    appleInterfaceStyle: optional('/usr/bin/defaults', ['read', '-g', 'AppleInterfaceStyle']),
    darkMode: dark === 'true',
  }
}

function health() {
  return fetch(`http://127.0.0.1:${productionPort}/health`, { signal: AbortSignal.timeout(1500) })
    .then(async (response) => ({ ok: response.ok, status: response.status, body: await response.text() }))
    .catch((error) => ({ ok: false, error: error.message }))
}

async function waitFor(predicate, timeoutMs, description, intervalMs = 150) {
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

function probe(probePath, command, ...args) {
  return JSON.parse(run(probePath, [command, ...args.map(String)], { timeout: 30_000 }))
}

function windows(probePath, pid) {
  return probe(probePath, 'windows', pid)
}

function ax(probePath, pid) {
  return probe(probePath, 'ax', pid)
}

function mainWindow(rows) {
  return rows.find((row) => row.layer === 0 && row.bounds?.width >= 800 && row.bounds?.height >= 500)
}

function quickWindow(rows) {
  return rows.find((row) => row.layer >= 0 && row.bounds?.width >= 430 && row.bounds?.width <= 540 && row.bounds?.height >= 370 && row.bounds?.height <= 500)
}

function aboutWindow(rows) {
  return rows.find((row) => row.layer >= 0 && row.bounds?.width >= 450 && row.bounds?.width <= 600 && row.bounds?.height >= 650 && row.bounds?.height <= 820)
}

function visibleMenuEntries(rows) {
  return rows
    .filter((row) => row.role === 'AXMenuItem' && row.visible === true)
    .map((row) => ({ title: row.title || null, enabled: row.enabled ?? null }))
}

function expectedMenuEntries(labels) {
  return [
    { title: labels[0], enabled: true },
    { title: null, enabled: false },
    { title: labels[1], enabled: true },
    { title: labels[2], enabled: true },
    { title: labels[3], enabled: true },
    { title: labels[4], enabled: true },
    { title: null, enabled: false },
    { title: labels[5], enabled: true },
  ]
}

function trayStatusRow(systemProbe, pid) {
  const rows = probe(systemProbe, 'scan-top')
  return rows.find((row) => row.pid === pid && row.subrole === 'AXMenuExtra') || null
}

function trayPoint(row) {
  return {
    x: row.bounds.x + row.bounds.width / 2,
    y: row.bounds.y + row.bounds.height / 2,
  }
}

async function openApplicationMenu(appProbe, pid, title) {
  const menuBarItem = ax(appProbe, pid).find(
    (row) => row.role === 'AXMenuBarItem' && row.title === title && row.visible === true,
  )
  assert.ok(menuBarItem?.bounds, `application menu ${title} is not visible`)
  const point = {
    x: menuBarItem.bounds.x + menuBarItem.bounds.width / 2,
    y: menuBarItem.bounds.y + menuBarItem.bounds.height / 2,
  }
  probe(appProbe, 'click', point.x, point.y, 'left')
  await sleep(300)
  return point
}

async function closeTrayMenu(appProbe, row) {
  const point = trayPoint(row)
  probe(appProbe, 'click', point.x, point.y, 'left')
  await sleep(600)
}

async function openTrayMenu(appProbe, systemProbe, pid, button, screenshotPath) {
  let row = trayStatusRow(systemProbe, pid)
  assert.ok(row, `production status item missing for pid ${pid}`)
  let point = trayPoint(row)
  let entries = []
  let attempts = 0
  // macOS may leave the status item visible while another app owns the active
  // menu bar; activate the target before sending the CGEvent so AX exposes the
  // product menu rather than returning an empty menu tree. AX can also lag one
  // event behind after a previous menu dismissal, so retry the same bounded
  // click/re-open sequence instead of treating an empty snapshot as a product
  // menu contract failure.
  while (attempts < 4 && entries.length === 0) {
    attempts += 1
    run('/usr/bin/osascript', ['-e', 'tell application "HexClaw" to activate'])
    probe(appProbe, 'activate', pid)
    await sleep(500 + attempts * 250)
    // 激活目标应用后 macOS 可能重新排布状态栏；重新读取 AXMenuExtra，
    // 不能复用激活前的屏幕坐标。
    row = trayStatusRow(systemProbe, pid) || row
    point = trayPoint(row)
    probe(appProbe, 'click', point.x, point.y, button)
    await sleep(700 + attempts * 250)
    entries = visibleMenuEntries(ax(appProbe, pid))
    if (entries.length === 0) {
      try { probe(appProbe, 'click', point.x, point.y, button) } catch {}
      await sleep(250)
    }
  }
  const screenshot = screenshotPath
    ? (() => {
        run('/usr/sbin/screencapture', ['-x', screenshotPath], { timeout: 15_000 })
        return { path: screenshotPath, bytes: statSync(screenshotPath).size }
      })()
    : null
  return { button, row, point, attempts, entries, screenshot }
}

async function activateTrayItem(appProbe, pid, title) {
  const item = ax(appProbe, pid).find(
    (row) => row.role === 'AXMenuItem' && row.visible === true && row.title === title,
  )
  assert.ok(item?.bounds, `tray item ${title} is not visible`)
  try {
    probe(appProbe, 'press-visible', pid, title)
  } catch {
    const point = {
      x: item.bounds.x + item.bounds.width / 2,
      y: item.bounds.y + item.bounds.height / 2,
    }
    probe(appProbe, 'click', point.x, point.y, 'left')
  }
  await sleep(500)
}

async function waitForProduction() {
  await waitFor(() => productionPID() !== null, 20_000, 'production App launch', 200)
  const pid = productionPID()
  await waitFor(async () => (await health()).ok, 45_000, 'production Sidecar health', 250)
  return pid
}

async function launchProduction() {
  run('/usr/bin/open', ['-a', productionBundle], { timeout: 15_000 })
  return waitForProduction()
}

async function quitProduction(appProbe, systemProbe, pid, label) {
  assert.equal(productionPID(), pid, 'production pid changed before quit')
  const tray = await openTrayMenu(appProbe, systemProbe, pid, 'left', null)
  const visible = tray.entries.map((entry) => entry.title)
  const quitLabel = visible.includes(label) ? label : visible.includes('退出 HexClaw') ? '退出 HexClaw' : 'Quit HexClaw'
  assert.ok(visible.includes(quitLabel), 'explicit tray Quit item is not visible')
  await activateTrayItem(appProbe, pid, quitLabel)
  await waitFor(() => productionPID() === null, 20_000, 'production App graceful quit', 100)
  await waitFor(() => listenerPIDs().length === 0, 20_000, 'production Sidecar graceful stop', 100)
  return { pid, quitLabel }
}

function writeLocale(language, locale) {
  run('/usr/bin/defaults', ['write', '-g', 'AppleLanguages', '-array', language])
  run('/usr/bin/defaults', ['write', '-g', 'AppleLocale', locale])
}

function writeDarkMode(dark) {
  run('/usr/bin/osascript', [
    '-e',
    `tell application "System Events" to set dark mode of appearance preferences to ${dark ? 'true' : 'false'}`,
  ])
}

function parseLanguages(raw) {
  if (!raw) return []
  return [...raw.matchAll(/["']([^"']+)["']/g)].map((match) => match[1])
}

function restoreGlobalPreferences(before) {
  const languages = parseLanguages(before.appleLanguages)
  if (languages.length) run('/usr/bin/defaults', ['write', '-g', 'AppleLanguages', '-array', ...languages])
  else optional('/usr/bin/defaults', ['delete', '-g', 'AppleLanguages'])
  if (before.appleLocale) run('/usr/bin/defaults', ['write', '-g', 'AppleLocale', before.appleLocale])
  else optional('/usr/bin/defaults', ['delete', '-g', 'AppleLocale'])
  if (before.appleInterfaceStyle) run('/usr/bin/defaults', ['write', '-g', 'AppleInterfaceStyle', before.appleInterfaceStyle])
  else optional('/usr/bin/defaults', ['delete', '-g', 'AppleInterfaceStyle'])
  writeDarkMode(before.darkMode)
}

async function ensureRestored(appProbe, systemProbe, beforePrefs) {
  const pid = productionPID()
  if (pid !== null) {
    const currentLabel = globalPreferences().appleLanguages?.includes('zh') ? '退出 HexClaw' : 'Quit HexClaw'
    try {
      await quitProduction(appProbe, systemProbe, pid, currentLabel)
    } catch {
      // 恢复阶段仍优先保留生产 App；只有确认进程无响应才使用 TERM 结束自身启动的同一进程。
      if (alive(pid)) process.kill(pid, 'SIGTERM')
      await waitFor(() => productionPID() === null, 10_000, 'production App cleanup', 100)
      // App 被系统退出事件隐藏后，Sidecar 可能没有收到 Tauri 的正常
      // shutdown 回调；这里仅按已确认的 production sidecar 可执行路径回收，
      // 避免清理等待本身把真实门误报为失败。
      for (const listenerPID of listenerPIDs()) {
        if (processCommand(listenerPID).includes(sidecarExecutable)) {
          try { process.kill(listenerPID, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
        }
      }
      await waitFor(() => listenerPIDs().length === 0, 10_000, 'production Sidecar cleanup', 100)
    }
  }
  for (const pid of listenerPIDs()) {
    if (processCommand(pid).includes(sidecarExecutable)) {
      try { process.kill(pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
    }
  }
  await waitFor(() => listenerPIDs().length === 0, 10_000, 'orphan production Sidecar cleanup', 100)
  restoreGlobalPreferences(beforePrefs)
  await launchProduction()
}

async function main() {
  assert.equal(process.platform, 'darwin', 'BUG-20260726-033 production gate is macOS-only')
  assert.ok(existsSync(productionExecutable), 'installed production App is missing')
  assert.ok(existsSync(appProbeSource), 'app native probe is missing')
  assert.ok(existsSync(systemProbeSource), 'system native probe is missing')
  mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 })
  const sandbox = mkdtempSync(join(tmpdir(), 'hexclaw-bug033-production-gate-'))
  mkdirSync(join(sandbox, 'tmp'), { recursive: true, mode: 0o700 })
  const appProbe = join(sandbox, 'app-probe')
  const systemProbe = join(sandbox, 'system-probe')
  const cases = {}
  const beforePrefs = globalPreferences()
  const beforeBinary = binarySnapshot()
  const beforeConfig = configSnapshot()
  const beforeProcesses = productionProcesses()
  const beforeListeners = listenerPIDs()
  let finalError = null
  let currentPid = productionPID()

  try {
    assert.ok(currentPid, 'production App must be running before real gate')
    assert.equal(beforeListeners.length, 1, 'production Sidecar must have one listener before real gate')
    run('swiftc', [appProbeSource, '-o', appProbe], { timeout: 30_000 })
    run('swiftc', [systemProbeSource, '-o', systemProbe], { timeout: 30_000 })
    const preflight = probe(appProbe, 'preflight')
    assert.equal(preflight.accessibility, true)
    assert.equal(preflight.screenCapture, true)
    writeJSON(join(evidenceRoot, 'preflight.json'), preflight)
    writeJSON(join(evidenceRoot, 'before.json'), {
      preferences: beforePrefs,
      binaries: beforeBinary,
      config: beforeConfig,
      processes: beforeProcesses,
      listeners: beforeListeners,
      statusItem: trayStatusRow(systemProbe, currentPid),
    })
    cases.preflight = { status: 'PASS', evidence: 'preflight.json' }
    cases.identity_before = { status: 'PASS', evidence: 'before.json' }

    const originalLabels = beforePrefs.appleLanguages?.includes('zh') ? expectedChinese : expectedEnglish
    const originalLocale = beforePrefs.appleLanguages?.includes('zh') ? 'zh-Hans-CN' : 'en-US'
    const originalQuitLabel = originalLabels === expectedChinese ? '退出 HexClaw' : 'Quit HexClaw'

    const lightMenu = await openTrayMenu(
      appProbe,
      systemProbe,
      currentPid,
      'left',
      join(evidenceRoot, 'tray-original-light-left.png'),
    )
    await closeTrayMenu(appProbe, lightMenu.row)
    const lightRight = await openTrayMenu(
      appProbe,
      systemProbe,
      currentPid,
      'right',
      join(evidenceRoot, 'tray-original-light-right.png'),
    )
    await closeTrayMenu(appProbe, lightRight.row)
    assert.deepEqual(lightMenu.entries, expectedMenuEntries(originalLabels))
    assert.deepEqual(lightRight.entries, expectedMenuEntries(originalLabels))
    cases.tray_original_light = { status: 'PASS', evidence: { left: lightMenu, right: lightRight } }

    writeDarkMode(true)
    await sleep(1200)
    const darkPrefs = globalPreferences()
    const darkMenu = await openTrayMenu(
      appProbe,
      systemProbe,
      currentPid,
      'left',
      join(evidenceRoot, 'tray-original-dark-left.png'),
    )
    await closeTrayMenu(appProbe, darkMenu.row)
    assert.equal(darkPrefs.darkMode, true)
    assert.deepEqual(darkMenu.entries, expectedMenuEntries(originalLabels))
    cases.tray_dark = { status: 'PASS', evidence: { preferences: darkPrefs, menu: darkMenu } }
    writeDarkMode(false)
    await sleep(800)

    await quitProduction(appProbe, systemProbe, currentPid, originalQuitLabel)
    writeLocale('en-US', 'en_US')
    currentPid = await launchProduction()
    const englishLeft = await openTrayMenu(appProbe, systemProbe, currentPid, 'left', join(evidenceRoot, 'tray-en-left.png'))
    await closeTrayMenu(appProbe, englishLeft.row)
    const englishRight = await openTrayMenu(appProbe, systemProbe, currentPid, 'right', join(evidenceRoot, 'tray-en-right.png'))
    await closeTrayMenu(appProbe, englishRight.row)
    assert.deepEqual(englishLeft.entries, expectedMenuEntries(expectedEnglish))
    assert.deepEqual(englishRight.entries, expectedMenuEntries(expectedEnglish))
    cases.tray_english = { status: 'PASS', evidence: { left: englishLeft, right: englishRight } }

    await quitProduction(appProbe, systemProbe, currentPid, 'Quit HexClaw')
    writeLocale('fr-FR', 'fr_FR')
    currentPid = await launchProduction()
    const fallbackLeft = await openTrayMenu(appProbe, systemProbe, currentPid, 'left', join(evidenceRoot, 'tray-fallback-left.png'))
    await closeTrayMenu(appProbe, fallbackLeft.row)
    const fallbackRight = await openTrayMenu(appProbe, systemProbe, currentPid, 'right', join(evidenceRoot, 'tray-fallback-right.png'))
    await closeTrayMenu(appProbe, fallbackRight.row)
    assert.deepEqual(fallbackLeft.entries, expectedMenuEntries(expectedEnglish))
    assert.deepEqual(fallbackRight.entries, expectedMenuEntries(expectedEnglish))
    cases.tray_fallback = { status: 'PASS', evidence: { left: fallbackLeft, right: fallbackRight } }

    await quitProduction(appProbe, systemProbe, currentPid, 'Quit HexClaw')
    restoreGlobalPreferences(beforePrefs)
    currentPid = await launchProduction()
    const restoredLabels = originalLabels

    const initialWindows = windows(appProbe, currentPid)
    const initialMain = mainWindow(initialWindows)
    assert.ok(initialMain, 'restored production main window is missing')
    probe(appProbe, 'press-window-subrole', currentPid, initialMain.name || 'HexClaw', 'AXCloseButton')
    await sleep(500)
    const hiddenWindows = windows(appProbe, currentPid)
    const hiddenHealth = await health()
    assert.equal(alive(currentPid), true)
    assert.equal(hiddenHealth.ok, true)
    assert.equal(Boolean(mainWindow(hiddenWindows)), false)
    const hiddenTray = await openTrayMenu(appProbe, systemProbe, currentPid, 'left', join(evidenceRoot, 'tray-restore-open.png'))
    assert.deepEqual(hiddenTray.entries, expectedMenuEntries(restoredLabels))
    await activateTrayItem(appProbe, currentPid, restoredLabels[0])
    await waitFor(() => Boolean(mainWindow(windows(appProbe, currentPid))), 5000, 'tray Open restore', 100)
    const restoredMain = mainWindow(windows(appProbe, currentPid))
    assert.equal(restoredMain.id, initialMain.id)
    cases.red_x_restore = { status: 'PASS', evidence: { initialMainId: initialMain.id, restoredMainId: restoredMain.id, sidecar: hiddenHealth } }

    const quickMenu = await openTrayMenu(appProbe, systemProbe, currentPid, 'left', join(evidenceRoot, 'tray-quick-chat.png'))
    assert.deepEqual(quickMenu.entries, expectedMenuEntries(restoredLabels))
    await activateTrayItem(appProbe, currentPid, restoredLabels[1])
    await waitFor(() => Boolean(quickWindow(windows(appProbe, currentPid))), 5000, 'Quick Chat window', 100)
    const quick = quickWindow(windows(appProbe, currentPid))
    probe(appProbe, 'activate', currentPid)
    await openApplicationMenu(appProbe, currentPid, 'File')
    const menuAfterFile = visibleMenuEntries(ax(appProbe, currentPid)).map((entry) => entry.title)
    const newConversation = menuAfterFile.includes('New Chat') ? 'New Chat' : menuAfterFile.includes('新建会话') ? '新建会话' : null
    assert.ok(newConversation, 'New Conversation menu action is not exposed')
    probe(appProbe, 'press-visible', currentPid, newConversation)
    await sleep(600)
    const afterNew = windows(appProbe, currentPid)
    const quickAfter = quickWindow(afterNew)
    const mainAfter = mainWindow(afterNew)
    assert.equal(quickAfter?.id, quick.id)
    assert.ok(mainAfter)
    assert.notEqual(mainAfter.id, quickAfter.id)
    cases.quick_chat_new_conversation = { status: 'PASS', evidence: { quickWindowId: quick.id, quickAfterId: quickAfter.id, mainAfterId: mainAfter.id, action: newConversation } }
    try {
      probe(appProbe, 'press-window-subrole', currentPid, 'HexClaw Quick Chat', 'AXCloseButton')
    } catch {}

    const aboutEvidence = {}
    probe(appProbe, 'activate', currentPid)
    await openApplicationMenu(appProbe, currentPid, 'HexClaw')
    const aboutLabel = visibleMenuEntries(ax(appProbe, currentPid)).map((entry) => entry.title).includes('About HexClaw') ? 'About HexClaw' : '关于河蟹'
    probe(appProbe, 'press-visible', currentPid, aboutLabel)
    await waitFor(() => Boolean(aboutWindow(windows(appProbe, currentPid))), 5000, 'native About window', 100)
    aboutEvidence.appMenu = aboutWindow(windows(appProbe, currentPid))?.id
    const trayAbout = await openTrayMenu(appProbe, systemProbe, currentPid, 'right', join(evidenceRoot, 'tray-about.png'))
    const trayAboutLabel = restoredLabels[4]
    assert.ok(trayAbout.entries.some((entry) => entry.title === trayAboutLabel))
    await activateTrayItem(appProbe, currentPid, trayAboutLabel)
    aboutEvidence.tray = aboutWindow(windows(appProbe, currentPid))?.id
    assert.equal(aboutEvidence.appMenu, aboutEvidence.tray)
    cases.about_identity = { status: 'PASS', evidence: aboutEvidence }

    // 真实 CGEvent 以微秒级 sleep 发送两次 Cmd+Q；Rust 合同同时冻结 1999ms/2000ms 语义。
    const aboutForCmdQ = aboutWindow(windows(appProbe, currentPid))
    if (aboutForCmdQ?.name) {
      try { probe(appProbe, 'press-window-subrole', currentPid, aboutForCmdQ.name, 'AXCloseButton') } catch {}
      await sleep(300)
    }
    probe(appProbe, 'activate', currentPid)
    const before1999 = { pid: currentPid, listeners: listenerPIDs(), at: Date.now() }
    const cmdq1999 = probe(systemProbe, 'cmdq', currentPid, 1999)
    await waitFor(() => productionPID() === null, 12_000, '1999ms Cmd+Q exit', 50)
    await waitFor(() => listenerPIDs().length === 0, 12_000, '1999ms Sidecar exit', 50)
    cases.cmdq_1999 = { status: 'PASS', evidence: { requestedDelayMs: cmdq1999.delayMs, before: before1999, exited: true } }

    currentPid = await launchProduction()
    probe(appProbe, 'activate', currentPid)
    const before2000 = { pid: currentPid, listeners: listenerPIDs(), at: Date.now() }
    const cmdq2000 = probe(systemProbe, 'cmdq', currentPid, 2000)
    // The 2000ms path keeps the app alive but may briefly restart its Sidecar;
    // wait for the existing health contract instead of sampling the transient
    // restart window as a false failure.
    await waitFor(async () => alive(currentPid), 5000, '2000ms Cmd+Q app remains alive', 100)
    await waitFor(async () => (await health()).ok, 60_000, '2000ms Cmd+Q Sidecar remains healthy', 100)
    const after2000 = { processAlive: alive(currentPid), listeners: listenerPIDs(), health: await health() }
    assert.equal(after2000.processAlive, true)
    assert.equal(after2000.health.ok, true)
    assert.equal(after2000.listeners.length, 1)
    cases.cmdq_2000 = { status: 'PASS', evidence: { requestedDelayMs: cmdq2000.delayMs, before: before2000, after: after2000 } }

    const after = { binaries: binarySnapshot(), config: configSnapshot(), preferences: globalPreferences(), processes: productionProcesses(), listeners: listenerPIDs() }
    writeJSON(join(evidenceRoot, 'after-before-restore.json'), after)
    assert.equal(after.binaries.desktopSha256, beforeBinary.desktopSha256)
    assert.equal(after.binaries.sidecarSha256, beforeBinary.sidecarSha256)
    assert.equal(after.config.find((row) => row.path === '<home>/.hexclaw/hexclaw.yaml')?.sha256, beforeConfig.find((row) => row.path === '<home>/.hexclaw/hexclaw.yaml')?.sha256)
    cases.identity_after_gate = { status: 'PASS', evidence: 'after-before-restore.json' }
  } catch (error) {
    finalError = error
    cases.unexpected_failure = { status: 'NOT_PASS', note: error.stack || error.message }
  } finally {
    try {
      await ensureRestored(appProbe, systemProbe, beforePrefs)
      const final = { binaries: binarySnapshot(), config: configSnapshot(), preferences: globalPreferences(), processes: productionProcesses(), listeners: listenerPIDs() }
      writeJSON(join(evidenceRoot, 'final.json'), final)
      cases.cleanup = {
        status: final.processes.some((row) => row.command === productionExecutable) && final.listeners.length === 1 ? 'PASS' : 'NOT_PASS',
        evidence: 'final.json',
      }
    } catch (error) {
      cases.cleanup = { status: 'NOT_PASS', note: error.stack || error.message }
      finalError ||= error
    }
    writeJSON(join(evidenceRoot, 'summary.json'), {
      bug: 'BUG-20260726-033',
      acceptance: ['MAC-TRAY-001', 'MAC-TRAY-002', 'MAC-TRAY-003', 'MAC-TRAY-004', 'MAC-WINDOW-CLOSE-005', 'MAC-CMDQ-006', 'MAC-CMDQ-007', 'MAC-CMDQ-008', 'MAC-TRAY-009', 'MAC-TRAY-010', 'MAC-TRAY-011', 'DESKTOP-LIVE-LIFECYCLE-20260822-009', 'DESKTOP-LIVE-SYSTEM-PRESENTATION-20260822-010'],
      before: { preferences: beforePrefs, binaries: beforeBinary, config: beforeConfig, processes: beforeProcesses, listeners: beforeListeners },
      cases: JSON.parse(sanitize(JSON.stringify(cases), sandbox)),
      finalError: finalError ? sanitize(finalError.stack || finalError.message, sandbox) : null,
      operationBoundary: '只操作 /Applications/HexClaw.app；未选择真实打印机、未提交打印、未读取或写入 Provider secret。',
    })
    rmSync(sandbox, { force: true, recursive: true })
  }
  const statuses = Object.values(cases).map((entry) => entry.status)
  const overall = statuses.includes('NOT_PASS') ? 'NOT_PASS' : statuses.includes('BLOCKED') ? 'BLOCKED' : 'PASS'
  process.stdout.write(`BUG-20260726-033 production gate: ${overall}\n`)
  process.stdout.write(`Evidence: ${evidenceRoot}\n`)
  if (finalError) throw finalError
}

await main()
