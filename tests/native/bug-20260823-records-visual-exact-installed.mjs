#!/usr/bin/env node

/**
 * WORKS-DESC-SINGLE-LINE-001 / MISTAKES-ROW-ACTIONS-VISIBLE-001
 * 最终安装包精确字节的原生第三腿。
 *
 * 默认 `validate` 只做静态合同与 Swift typecheck，不构建、不启动 App、不激活窗口。
 * `run` 直接执行 /Applications/HexClaw.app 内的 Desktop 精确字节，在隔离 HOME/端口
 * 通过公开 API 写入确定性夹具，再用 Accessibility 导航并按原生窗口 ID 截图。
 * 运行会打开原生窗口，因此必须在用户明确给出的空闲窗口内同时打开两个执行开关。
 *
 * 本脚本不注入或替换前端字节，不构建 Test.app，不读取用户配置，不绑定 IM，
 * 不调用模型；仅停止自己创建的 PID 与独占端口监听进程。
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
const docsRoot = resolve(repoRoot, '../hexclaw-docs')
const installedBundle = '/Applications/HexClaw.app'
const installedExecutable = join(installedBundle, 'Contents/MacOS/hexclaw-desktop')
const installedSidecar = join(installedBundle, 'Contents/MacOS/hexclaw')
const installedInfoPlist = join(installedBundle, 'Contents/Info.plist')
const expectedDesktopSHA256 =
  '6e00622437fe09bd13aaeccbcd50ec96145dbbc226f823a3fd4d6cdd70a7a147'
const expectedSidecarSHA256 =
  '9d66400f9ddc83f1ab9847947b98fc3cd47f79cc1156d5a78f6b24282b1a7ea2'
const evidenceBase = join(
  docsRoot,
  'docs/evidence/bug-k12-closure-20260824/native-records-final/exact-installed',
)
const runOptIn = 'HEXCLAW_RUN_RECORDS_EXACT_INSTALLED'
const foregroundOptIn = 'HEXCLAW_ALLOW_FOREGROUND_NATIVE_UI'
const apiToken = 'records-exact-installed-loopback-token'
const providerKey = 'records-fixture'
const providerID = 'pvd_v1_44444444444444444444444444444444'
const providerModel = 'records-fixture-model'
const agentName = 'records-exact-installed-agent'
const sleep = (milliseconds) =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds))

const states = [
  { id: 'works-1226', width: 1226, height: 820, tab: '作品', ready: '添加作品' },
  { id: 'mistakes-1226', width: 1226, height: 820, tab: '全部错题', ready: '记一条错题' },
  { id: 'mistakes-1024', width: 1024, height: 820, tab: '全部错题', ready: '记一条错题' },
]

const axDriverSource = String.raw`
import ApplicationServices
import CoreGraphics
import Foundation

struct Frame: Codable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct Entry: Codable {
    let role: String
    let label: String
    let frame: Frame?
    let enabled: Bool
    let actions: [String]
}

struct Snapshot: Codable {
    let pid: Int32
    let targetWidth: Double
    let targetHeight: Double
    let windowID: Int
    let window: Frame
    let viewport: Frame
    let entries: [Entry]
}

enum DriverError: Error, CustomStringConvertible {
    case message(String)
    var description: String {
        switch self { case .message(let value): return value }
    }
}

func attribute(_ element: AXUIElement, _ name: CFString) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name, &value) == .success else { return nil }
    return value
}

func stringAttribute(_ element: AXUIElement, _ name: CFString) -> String {
    if let value = attribute(element, name) as? String { return value }
    if let value = attribute(element, name) as? NSNumber { return value.stringValue }
    return ""
}

func pointAttribute(_ element: AXUIElement, _ name: CFString) -> CGPoint? {
    guard let raw = attribute(element, name), CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
    let value = raw as! AXValue
    var point = CGPoint.zero
    return AXValueGetValue(value, .cgPoint, &point) ? point : nil
}

func sizeAttribute(_ element: AXUIElement, _ name: CFString) -> CGSize? {
    guard let raw = attribute(element, name), CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
    let value = raw as! AXValue
    var size = CGSize.zero
    return AXValueGetValue(value, .cgSize, &size) ? size : nil
}

func frame(_ element: AXUIElement) -> Frame? {
    guard let point = pointAttribute(element, kAXPositionAttribute as CFString),
          let size = sizeAttribute(element, kAXSizeAttribute as CFString) else { return nil }
    return Frame(x: point.x, y: point.y, width: size.width, height: size.height)
}

func children(_ element: AXUIElement) -> [AXUIElement] {
    return (attribute(element, kAXChildrenAttribute as CFString) as? [AXUIElement]) ?? []
}

func walk(_ root: AXUIElement, limit: Int = 12000) -> [AXUIElement] {
    var queue = [root]
    var output: [AXUIElement] = []
    while !queue.isEmpty && output.count < limit {
        let next = queue.removeFirst()
        output.append(next)
        queue.append(contentsOf: children(next))
    }
    return output
}

func role(_ element: AXUIElement) -> String {
    return stringAttribute(element, kAXRoleAttribute as CFString)
}

func label(_ element: AXUIElement) -> String {
    for name in [kAXTitleAttribute, kAXValueAttribute, kAXDescriptionAttribute, kAXHelpAttribute] {
        let value = stringAttribute(element, name as CFString)
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if !value.isEmpty { return value }
    }
    return ""
}

func actionNames(_ element: AXUIElement) -> [String] {
    var raw: CFArray?
    guard AXUIElementCopyActionNames(element, &raw) == .success else { return [] }
    return (raw as? [String]) ?? []
}

func enabled(_ element: AXUIElement) -> Bool {
    return (attribute(element, kAXEnabledAttribute as CFString) as? Bool) ?? true
}

func mainWindow(_ app: AXUIElement) throws -> AXUIElement {
    let deadline = Date().addingTimeInterval(40)
    while Date() < deadline {
        if let windows = attribute(app, kAXWindowsAttribute as CFString) as? [AXUIElement],
           let window = windows.first(where: { frame($0)?.width ?? 0 > 500 }) {
            return window
        }
        Thread.sleep(forTimeInterval: 0.15)
    }
    throw DriverError.message("Installed window did not become accessible")
}

func webArea(_ window: AXUIElement) -> AXUIElement? {
    return walk(window).first(where: { role($0) == "AXWebArea" && (frame($0)?.width ?? 0) > 500 })
}

func setSize(_ window: AXUIElement, _ size: CGSize) throws {
    var mutable = size
    guard let value = AXValueCreate(.cgSize, &mutable) else {
        throw DriverError.message("Failed to encode AX window size")
    }
    let result = AXUIElementSetAttributeValue(window, kAXSizeAttribute as CFString, value)
    guard result == .success else {
        throw DriverError.message("Failed to set AX window size: \(result.rawValue)")
    }
}

func resizeForViewport(_ window: AXUIElement, width: CGFloat, height: CGFloat) throws -> AXUIElement {
    var currentWeb: AXUIElement?
    for _ in 0..<8 {
        guard let windowSize = sizeAttribute(window, kAXSizeAttribute as CFString) else {
            throw DriverError.message("Installed window size is unavailable")
        }
        guard let candidate = webArea(window),
              let webSize = sizeAttribute(candidate, kAXSizeAttribute as CFString) else {
            Thread.sleep(forTimeInterval: 0.25)
            continue
        }
        currentWeb = candidate
        let widthDelta = width - webSize.width
        let heightDelta = height - webSize.height
        if abs(widthDelta) <= 1 && abs(heightDelta) <= 1 { return candidate }
        try setSize(window, CGSize(
            width: max(900, windowSize.width + widthDelta),
            height: max(600, windowSize.height + heightDelta)
        ))
        Thread.sleep(forTimeInterval: 0.35)
    }
    guard let finalWeb = currentWeb ?? webArea(window),
          let finalSize = sizeAttribute(finalWeb, kAXSizeAttribute as CFString),
          abs(finalSize.width - width) <= 1,
          abs(finalSize.height - height) <= 1 else {
        let actual = currentWeb.flatMap { sizeAttribute($0, kAXSizeAttribute as CFString) }
        throw DriverError.message("Exact viewport unavailable: \(String(describing: actual))")
    }
    return finalWeb
}

func matchingElements(_ window: AXUIElement, text: String) -> [AXUIElement] {
    let exact = walk(window).filter { label($0) == text }
    if !exact.isEmpty { return exact }
    return walk(window).filter { label($0).contains(text) }
}

func waitForText(_ window: AXUIElement, text: String, timeout: TimeInterval = 30) throws {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if !matchingElements(window, text: text).isEmpty { return }
        Thread.sleep(forTimeInterval: 0.15)
    }
    throw DriverError.message("Timed out waiting for AX text: \(text)")
}

func press(_ window: AXUIElement, text: String) throws {
    try waitForText(window, text: text)
    let candidates = matchingElements(window, text: text)
    for candidate in candidates.reversed() {
        if actionNames(candidate).contains(kAXPressAction as String),
           AXUIElementPerformAction(candidate, kAXPressAction as CFString) == .success {
            Thread.sleep(forTimeInterval: 0.5)
            return
        }
    }
    throw DriverError.message("AX element has no press action: \(text)")
}

func windowNumber(pid: Int32) throws -> Int {
    let rows = CGWindowListCopyWindowInfo(
        [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID
    ) as? [[String: Any]] ?? []
    for row in rows {
        let owner = (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value ?? -1
        let layer = (row[kCGWindowLayer as String] as? NSNumber)?.intValue ?? -1
        let alpha = (row[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 0
        if owner == pid, layer == 0, alpha > 0,
           let number = (row[kCGWindowNumber as String] as? NSNumber)?.intValue {
            return number
        }
    }
    throw DriverError.message("Installed native window ID is unavailable")
}

do {
    guard CommandLine.arguments.count == 7,
          let pid = Int32(CommandLine.arguments[1]),
          let width = Double(CommandLine.arguments[2]),
          let height = Double(CommandLine.arguments[3]) else {
        throw DriverError.message("Usage: driver PID WIDTH HEIGHT TAB READY OUTPUT")
    }
    guard AXIsProcessTrusted() else {
        throw DriverError.message("Accessibility permission is not granted")
    }
    let tab = CommandLine.arguments[4]
    let ready = CommandLine.arguments[5]
    let output = CommandLine.arguments[6]
    let app = AXUIElementCreateApplication(pid)
    let window = try mainWindow(app)
    _ = try resizeForViewport(window, width: width, height: height)
    try press(window, text: "学习档案")
    try press(window, text: tab)
    try waitForText(window, text: ready)
    Thread.sleep(forTimeInterval: 0.7)
    let viewportElement = try resizeForViewport(window, width: width, height: height)
    guard let windowFrame = frame(window), let viewportFrame = frame(viewportElement) else {
        throw DriverError.message("Installed window geometry is unavailable")
    }
    let viewportRight = viewportFrame.x + viewportFrame.width
    let viewportBottom = viewportFrame.y + viewportFrame.height
    let entries = walk(window).compactMap { element -> Entry? in
        let text = label(element)
        let elementRole = role(element)
        guard !text.isEmpty || elementRole == "AXButton" || elementRole == "AXLink" else { return nil }
        let elementFrame = frame(element)
        if let item = elementFrame {
            let right = item.x + item.width
            let bottom = item.y + item.height
            if right <= viewportFrame.x || item.x >= viewportRight ||
               bottom <= viewportFrame.y || item.y >= viewportBottom { return nil }
        }
        return Entry(
            role: elementRole,
            label: text,
            frame: elementFrame,
            enabled: enabled(element),
            actions: actionNames(element)
        )
    }
    let snapshot = Snapshot(
        pid: pid,
        targetWidth: width,
        targetHeight: height,
        windowID: try windowNumber(pid: pid),
        window: windowFrame,
        viewport: viewportFrame,
        entries: entries
    )
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    try encoder.encode(snapshot).write(to: URL(fileURLWithPath: output), options: .atomic)
} catch {
    FileHandle.standardError.write(Data("\(error)\n".utf8))
    exit(1)
}
`

function usage() {
  return `Usage:
  node tests/native/bug-20260823-records-visual-exact-installed.mjs validate
  ${runOptIn}=1 ${foregroundOptIn}=1 node tests/native/bug-20260823-records-visual-exact-installed.mjs run

validate:
  Static only. Reads candidate hashes and typechecks the AX driver; never launches an App.

run:
  Foreground native UI boundary. Run only in an explicitly approved idle window.
  Refuses to start when any installed HexClaw Desktop process already exists.
`
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function sha256File(path) {
  return sha256(readFileSync(path))
}

function installedIdentity() {
  for (const path of [installedExecutable, installedSidecar, installedInfoPlist]) {
    assert.ok(existsSync(path) && statSync(path).isFile(), `Installed artifact missing: ${path}`)
  }
  const desktopSHA256 = sha256File(installedExecutable)
  const sidecarSHA256 = sha256File(installedSidecar)
  assert.equal(desktopSHA256, expectedDesktopSHA256, 'Installed Desktop SHA-256 drifted')
  assert.equal(sidecarSHA256, expectedSidecarSHA256, 'Installed Sidecar SHA-256 drifted')
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
  assert.equal(identifier, 'com.hexclaw.desktop', 'Installed bundle identifier drifted')
  assert.equal(version, '0.5.0-beta', 'Installed version drifted')
  return { bundle: installedBundle, identifier, version, desktopSHA256, sidecarSHA256 }
}

function record({ id, collection, status, fields, dedupeKey, createdAt }) {
  return {
    record_id: id,
    agent_name: agentName,
    collection,
    schema_version: 1,
    status,
    fields: JSON.stringify(fields),
    dedupe_key: dedupeKey,
    tags: '[]',
    due_at: null,
    source_session: `records-native-${id}`,
    version: 1,
    created_at: createdAt,
    updated_at: createdAt,
  }
}

function workRecords() {
  const feedbacks = [
    '这篇习作有清楚的事情顺序；下一步可以补充人物动作。',
    '开头交代了地点和人物；下一步可以补充一个具体声音。',
    '结尾表达了真实感受；下一步可以检查两个重复词语。',
  ]
  return feedbacks.map((feedback, index) =>
    record({
      id: `records-native-work-${index + 1}`,
      collection: '作品',
      status: 'feedback_ready',
      dedupeKey: `records-native-work-key-${index + 1}`,
      createdAt: 1_787_500_000 + index,
      fields: {
        grade_term: '五年级下',
        work_type: 'writing',
        display_name: '语文写作',
        versions: [
          {
            version_id: 'v1',
            content_markdown: `春天的校园\n\n第 ${index + 1} 篇确定性测试习作。`,
            feedback,
            feedback_source: 'ai',
            feedback_skill: 'records-native-fixture@1/embedded',
          },
        ],
      },
    }),
  )
}

function sealedV2Archive() {
  const payload = {
    version: 2,
    agent_name: agentName,
    exported_at: 1_787_500_100,
    records: workRecords(),
    profile: {
      child_name: '小明',
      grade_term: '五年级下',
      subject_textbooks: {
        math: '人教版',
        chinese: '人教版',
        english: '人教版',
        science: '教科版',
        information_technology: '浙教版',
        art: '人美版',
      },
      textbook_edition: '人教版',
    },
  }
  return { ...payload, checksum: sha256(JSON.stringify(payload)) }
}

function renderConfig(sidecarPort, providerPort) {
  return `server:
  host: 127.0.0.1
  port: ${sidecarPort}
  mode: development
  api_token: ${apiToken}
platforms:
  web:
    enabled: true
llm:
  default: ${providerKey}
  providers:
    ${providerKey}:
      provider_instance_id: ${providerID}
      display_name: Records Fixture
      api_key: records-fixture-key
      base_url: http://127.0.0.1:${providerPort}/v1
      model: ${providerModel}
      models:
        - ${providerModel}
      model_specs_mode: explicit
      model_specs:
        - id: ${providerModel}
          display_name: Records Fixture Model
          capabilities:
            - text
      compatible: openai
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
observe:
  log_level: info
  metrics:
    enabled: false
`
}

async function reserveLoopbackPort() {
  const server = createServer()
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object', 'Loopback port reservation failed')
  const port = address.port
  await new Promise((resolveClose, rejectClose) =>
    server.close((error) => (error ? rejectClose(error) : resolveClose())),
  )
  assert.ok(![16060, 11434].includes(port), `Forbidden shared port selected: ${port}`)
  return port
}

function createProviderGuard(port) {
  const state = { catalog: [], modelInvocations: [], imInvocations: [], unexpected: [] }
  const server = createServer(async (request, response) => {
    const url = new URL(request.url || '/', `http://127.0.0.1:${port}`)
    const method = (request.method || 'GET').toUpperCase()
    if (method === 'GET' && url.pathname === '/v1/models') {
      state.catalog.push(`${method} ${url.pathname}`)
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ data: [{ id: providerModel, name: providerModel }] }))
      return
    }
    if (url.pathname.includes('chat/completions') || url.pathname.includes('responses')) {
      state.modelInvocations.push(`${method} ${url.pathname}`)
    } else if (/dingtalk|webhook|robot|message/i.test(url.pathname)) {
      state.imInvocations.push(`${method} ${url.pathname}`)
    } else {
      state.unexpected.push(`${method} ${url.pathname}`)
    }
    response.writeHead(503, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ error: 'guarded boundary' }))
  })
  return {
    state,
    listen: () =>
      new Promise((resolveListen, rejectListen) => {
        server.once('error', rejectListen)
        server.listen(port, '127.0.0.1', resolveListen)
      }),
    close: () =>
      new Promise((resolveClose) => {
        if (!server.listening) return resolveClose()
        server.close(() => resolveClose())
      }),
  }
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

function installedDesktopPIDs() {
  const lines = execFileSync('/bin/ps', ['-axo', 'pid=,command='], {
    encoding: 'utf8',
    timeout: 5_000,
  }).split('\n')
  return lines
    .map((line) => line.trim().match(/^(\d+)\s+(.+)$/))
    .filter(Boolean)
    .map((match) => ({ pid: Number(match[1]), command: match[2] }))
    .filter((entry) => entry.command.includes(installedExecutable))
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  const stopped = await Promise.race([
    new Promise((resolveExit) => child.once('exit', () => resolveExit(true))),
    sleep(5_000).then(() => false),
  ])
  if (!stopped && child.exitCode === null) {
    child.kill('SIGKILL')
    await new Promise((resolveExit) => child.once('exit', resolveExit))
  }
}

async function stopOwnedSidecar(port) {
  const stopped = []
  for (const pid of listenerPIDs(port)) {
    const command = processCommand(pid)
    assert.ok(command.includes(installedSidecar), `Refusing to stop unowned listener: ${command}`)
    process.kill(pid, 'SIGTERM')
    stopped.push(pid)
  }
  const deadline = Date.now() + 5_000
  while (listenerPIDs(port).length && Date.now() < deadline) await sleep(100)
  assert.deepEqual(listenerPIDs(port), [], `Owned Sidecar remains on port ${port}`)
  return stopped
}

function runtimeEnvironment(sandbox, sidecarPort) {
  const temp = join(sandbox, 'tmp')
  return {
    PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: 'zh_CN.UTF-8',
    LC_ALL: 'zh_CN.UTF-8',
    HOME: sandbox,
    USERPROFILE: sandbox,
    CFFIXED_USER_HOME: sandbox,
    TMPDIR: temp,
    TEMP: temp,
    TMP: temp,
    HEXCLAW_TEST_MODE: '1',
    HEXCLAW_TEST_HOME: sandbox,
    HEXCLAW_SIDECAR_PORT: String(sidecarPort),
    HEXCLAW_TEST_LLM_CONFIG_MODE: 'preseeded-owner-yaml',
    HEXCLAW_TEST_ALLOW_AUTO_LOCAL_OLLAMA: '0',
    HEXCLAW_TEST_PROFILE_CATCHUP: '0',
    HEXCLAW_DISABLE_BACKGROUND_EGRESS: '1',
    DINGTALK_LIVE_SEND: '0',
    HTTP_PROXY: 'http://127.0.0.1:9',
    HTTPS_PROXY: 'http://127.0.0.1:9',
    ALL_PROXY: 'http://127.0.0.1:9',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  }
}

async function waitForHealth(origin, child, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error('Installed Desktop exited before Sidecar health')
    }
    try {
      const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1_000) })
      if (response.ok) return
    } catch {
      // Sidecar 仍在启动。
    }
    await sleep(150)
  }
  throw new Error('Installed Sidecar health timed out')
}

async function api(origin, path, options = {}) {
  const response = await fetch(`${origin}${path}`, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(options.headers || {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(options.timeoutMs || 15_000),
  })
  const text = await response.text()
  let data = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
  }
  const expected = options.expected || [200]
  assert.ok(
    expected.includes(response.status),
    `${options.method || 'GET'} ${path} returned ${response.status}: ${text}`,
  )
  return { status: response.status, data }
}

async function seedFixtures(origin) {
  const receipts = []
  receipts.push(
    await api(origin, '/api/v1/agents', {
      method: 'POST',
      expected: [200, 201],
      body: {
        name: agentName,
        display_name: '小明的辅导助手',
        description: '五年级学习档案确定性夹具',
        model: '',
        provider: '',
        system_prompt: 'Use only deterministic local records.',
        skills: [],
        metadata: {
          scenario: 'k12-tutor',
          'k12.learner_id': 'records-native-learner',
          'k12.child_name': '小明',
          'k12.grade_term': '五年级下',
          'k12.textbook_edition': '人教版',
        },
      },
    }),
  )
  receipts.push(
    await api(origin, '/api/v1/agents/default', {
      method: 'POST',
      body: { name: agentName },
    }),
  )
  const questions = [
    ['数学', '57+38=', '两位数加法', '进位时漏加了十位'],
    ['英语', '写出“苹果”的英文单词', '单词拼写', '字母顺序记错'],
    ['语文', '默写《静夜思》第一句', '古诗默写', '漏写一个字'],
    ['数学', '3支铅笔每支2元，再买1个5元笔记本，一共多少元？', '混合运算', '先后顺序错误'],
    ['数学', '26×3=', '两位数乘一位数', '个位进位遗漏'],
    ['科学', '水沸腾时温度是否继续升高？', '水的变化', '混淆温度与加热时间'],
    ['信息技术', '保存文件的常用快捷键是什么？', '文件保存', '混淆复制快捷键'],
  ]
  for (const [subject, problem, knowledgePoint, errorCause] of questions) {
    receipts.push(
      await api(origin, '/api/k12/record-mistake', {
        method: 'POST',
        body: {
          agent: agentName,
          subject,
          grade: '五年级下',
          source_session: `records-native-${sha256(problem).slice(0, 12)}`,
          problem,
          student_answer: '确定性错误答案',
          error_cause: errorCause,
          knowledge_points: [knowledgePoint],
        },
      }),
    )
  }
  receipts.push(
    await api(origin, '/api/k12/restore', {
      method: 'POST',
      body: sealedV2Archive(),
    }),
  )
  const mistakes = await api(
    origin,
    `/api/k12/mistakes?agent=${encodeURIComponent(agentName)}`,
  )
  const works = await api(
    origin,
    `/api/k12/creative-works?agent=${encodeURIComponent(agentName)}`,
  )
  assert.equal(mistakes.data?.items?.length, 7, 'Normal API did not persist seven mistakes')
  assert.equal(works.data?.items?.length, 3, 'Normal API did not persist three works')
  return {
    receipts: receipts.map((receipt) => ({ status: receipt.status })),
    mistakes: mistakes.data.items.map((item) => ({
      record_id: item.record_id,
      status: item.status,
      question: item.question,
    })),
    works: works.data.items.map((item) => ({
      work_id: item.work_id,
      work_type: item.work_type,
      display_name: item.display_name,
    })),
  }
}

function compileAXDriver(destination) {
  const source = `${destination}.swift`
  writeFileSync(source, axDriverSource, { mode: 0o600 })
  execFileSync('xcrun', ['swiftc', source, '-o', destination], {
    encoding: 'utf8',
    timeout: 60_000,
  })
  chmodSync(destination, 0o700)
}

function assertApprox(actual, expected, label, tolerance = 1) {
  assert.ok(
    Math.abs(Number(actual) - Number(expected)) <= tolerance,
    `${label}=${actual}, expected ${expected}±${tolerance}`,
  )
}

function matches(snapshot, text) {
  return snapshot.entries.filter((entry) => entry.label === text || entry.label.includes(text))
}

function assertInside(frame, container, label) {
  const tolerance = 1
  assert.ok(frame.x + tolerance >= container.x, `${label} crosses the viewport left edge`)
  assert.ok(frame.y + tolerance >= container.y, `${label} crosses the viewport top edge`)
  assert.ok(
    frame.x + frame.width <= container.x + container.width + tolerance,
    `${label} crosses the viewport right edge`,
  )
  assert.ok(
    frame.y + frame.height <= container.y + container.height + tolerance,
    `${label} crosses the viewport bottom edge`,
  )
}

function verifySnapshot(state, snapshot) {
  assertApprox(snapshot.viewport.width, state.width, `${state.id} viewport width`)
  assertApprox(snapshot.viewport.height, state.height, `${state.id} viewport height`)
  assert.ok(matches(snapshot, '学习档案').length >= 1, `${state.id} learning archive is absent`)
  if (state.id.startsWith('works')) {
    assert.ok(matches(snapshot, '添加作品').length >= 1, 'Works add action is absent')
    assert.ok(matches(snapshot, '语文写作').length >= 1, 'Works cards are absent')
    const description = matches(snapshot, '作文和画作都存在这里')[0]
    assert.ok(description?.frame, 'Works description geometry is absent')
    assert.ok(description.frame.height <= 34, 'Works description is not a single visual line')
    assertInside(description.frame, snapshot.viewport, 'Works description')
  } else {
    for (const action of ['加入练习集', '不再复习', '详情']) {
      const visible = matches(snapshot, action).filter((entry) => entry.frame)
      assert.ok(visible.length >= 1, `${state.id} action is absent: ${action}`)
      for (const entry of visible) assertInside(entry.frame, snapshot.viewport, `${action} action`)
    }
  }
  return {
    status: 'PASS',
    viewport: snapshot.viewport,
    workDescriptionSingleLine: state.id.startsWith('works') ? true : undefined,
    rowActionsInsideViewport: state.id.startsWith('mistakes') ? true : undefined,
  }
}

function sqliteRows(database, sql) {
  const raw = execFileSync('sqlite3', ['-json', '-cmd', '.timeout 5000', database, sql], {
    encoding: 'utf8',
    timeout: 10_000,
  })
  return JSON.parse(raw || '[]')
}

function findFiles(root, predicate, depth = 5) {
  const output = []
  function walk(path, remaining) {
    if (remaining < 0 || !existsSync(path)) return
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) walk(child, remaining - 1)
      else if (predicate(child)) output.push(child)
    }
  }
  walk(root, depth)
  return output
}

function databaseBoundary(sandbox) {
  const databases = findFiles(sandbox, (path) => /\.(?:db|sqlite|sqlite3)$/.test(path))
  const result = []
  for (const database of databases) {
    let tables
    try {
      tables = sqliteRows(
        database,
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;",
      ).map((row) => row.name)
    } catch {
      continue
    }
    const audited = tables.filter((name) =>
      /invocation|delivery|receipt|dingtalk|work_feedback_generations/i.test(name),
    )
    result.push({
      database: relative(sandbox, database),
      tables: audited.map((table) => ({
        table,
        rows: Number(sqliteRows(database, `SELECT COUNT(*) AS total FROM "${table}";`)[0]?.total || 0),
      })),
    })
  }
  return result
}

function sanitizeLog(raw, sandbox) {
  return raw
    .replaceAll(sandbox, '<isolated-home>')
    .replaceAll(apiToken, '<test-api-token>')
    .replaceAll(repoRoot, '<repo>')
}

async function runInstalled() {
  assert.equal(process.platform, 'darwin', 'Exact installed UI gate is macOS-only')
  assert.equal(process.env[runOptIn], '1', `${runOptIn}=1 is required`)
  assert.equal(process.env[foregroundOptIn], '1', `${foregroundOptIn}=1 is required`)
  const existing = installedDesktopPIDs()
  assert.deepEqual(
    existing,
    [],
    'Installed HexClaw is already running; refusing to activate or reuse a user process',
  )
  const identity = installedIdentity()
  const runID = `run-${Date.now()}-${process.pid}`
  const evidenceRoot = join(evidenceBase, runID)
  mkdirSync(evidenceRoot, { recursive: true })
  const sandbox = mkdtempSync(join(tmpdir(), 'hexclaw-records-exact-installed.'))
  chmodSync(sandbox, 0o700)
  mkdirSync(join(sandbox, '.hexclaw'), { mode: 0o700 })
  mkdirSync(join(sandbox, 'tmp'), { mode: 0o700 })
  const sidecarPort = await reserveLoopbackPort()
  const providerPort = await reserveLoopbackPort()
  assert.notEqual(sidecarPort, providerPort)
  const providerGuard = createProviderGuard(providerPort)
  const apiOrigin = `http://127.0.0.1:${sidecarPort}`
  const configPath = join(sandbox, '.hexclaw/hexclaw.yaml')
  writeFileSync(configPath, renderConfig(sidecarPort, providerPort), { mode: 0o600 })
  chmodSync(configPath, 0o600)
  const driver = join(sandbox, 'records-ax-driver')
  compileAXDriver(driver)
  const appLogPath = join(sandbox, 'installed-app.log')
  const appLog = createWriteStream(appLogPath, { flags: 'wx', mode: 0o600 })
  const runtimeEnv = runtimeEnvironment(sandbox, sidecarPort)
  let app = null
  let status = 'NOT_PASS'
  let failure = null
  let apiFixture = null
  let stoppedSidecars = []
  try {
    await providerGuard.listen()
    const launch = () => {
      assert.deepEqual(installedDesktopPIDs(), [], 'Another installed Desktop appeared')
      const child = spawn(installedExecutable, [], {
        cwd: sandbox,
        env: runtimeEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      child.stdout.pipe(appLog, { end: false })
      child.stderr.pipe(appLog, { end: false })
      return child
    }
    app = launch()
    await waitForHealth(apiOrigin, app)
    apiFixture = await seedFixtures(apiOrigin)
    writeFileSync(
      join(evidenceRoot, 'api-fixture.json'),
      `${JSON.stringify(apiFixture, null, 2)}\n`,
      { mode: 0o600 },
    )
    await stopProcess(app)
    app = null
    stoppedSidecars.push(...(await stopOwnedSidecar(sidecarPort)))
    app = launch()
    await waitForHealth(apiOrigin, app)
    for (const state of states) {
      const stateDir = join(evidenceRoot, state.id)
      mkdirSync(stateDir, { recursive: true })
      const snapshotPath = join(stateDir, 'ax-snapshot.json')
      execFileSync(
        driver,
        [String(app.pid), String(state.width), String(state.height), state.tab, state.ready, snapshotPath],
        { encoding: 'utf8', timeout: 90_000 },
      )
      const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'))
      const gate = verifySnapshot(state, snapshot)
      const screenshot = join(stateDir, 'installed-current.png')
      execFileSync('/usr/sbin/screencapture', [
        '-x',
        '-o',
        '-l',
        String(snapshot.windowID),
        screenshot,
      ])
      assert.ok(existsSync(screenshot) && statSync(screenshot).size > 1024)
      writeFileSync(join(stateDir, 'gate.json'), `${JSON.stringify(gate, null, 2)}\n`, {
        mode: 0o600,
      })
    }
    const database = databaseBoundary(sandbox)
    const invocationRows = database
      .flatMap((item) => item.tables)
      .filter((item) => /invocation|work_feedback_generations/i.test(item.table))
      .reduce((total, item) => total + item.rows, 0)
    const deliveryRows = database
      .flatMap((item) => item.tables)
      .filter((item) => /delivery|receipt|dingtalk/i.test(item.table))
      .reduce((total, item) => total + item.rows, 0)
    assert.deepEqual(providerGuard.state.modelInvocations, [], 'Model invocation guard was reached')
    assert.deepEqual(providerGuard.state.imInvocations, [], 'IM invocation guard was reached')
    assert.equal(invocationRows, 0, 'Invocation ledger is not empty')
    assert.equal(deliveryRows, 0, 'Delivery/IM ledger is not empty')
    const zeroBoundary = {
      status: 'PASS',
      modelInvocations: 0,
      imInvocations: 0,
      providerCatalogRequests: providerGuard.state.catalog.length,
      unexpectedGuardRequests: providerGuard.state.unexpected,
      database,
    }
    writeFileSync(
      join(evidenceRoot, 'zero-model-im.json'),
      `${JSON.stringify(zeroBoundary, null, 2)}\n`,
      { mode: 0o600 },
    )
    writeFileSync(
      join(evidenceRoot, 'summary.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          status: 'PASS',
          acceptance: ['WORKS-DESC-SINGLE-LINE-001', 'MISTAKES-ROW-ACTIONS-VISIBLE-001'],
          boundary: 'direct-exact-installed-desktop/native-window/normal-api-fixture',
          installedArtifact: { ...identity, launchedExactDesktopBytes: true, mutated: false },
          states: states.map((state) => state.id),
          isolation: {
            testHomeMode: '0700',
            configMode: '0600',
            sidecarPort,
            providerPort,
            userHomeRead: false,
            applicationsDirectoryMutated: false,
          },
          zeroModelIM: zeroBoundary,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    )
    status = 'PASS'
    process.stdout.write(`Exact installed records gate PASS: ${relative(repoRoot, evidenceRoot)}\n`)
  } catch (error) {
    failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    throw error
  } finally {
    await stopProcess(app)
    try {
      stoppedSidecars.push(...(await stopOwnedSidecar(sidecarPort)))
    } catch (error) {
      if (!failure) failure = error instanceof Error ? error.message : String(error)
    }
    await providerGuard.close()
    await new Promise((resolveEnd) => appLog.end(resolveEnd))
    if (existsSync(appLogPath)) {
      writeFileSync(
        join(evidenceRoot, 'installed-app.log'),
        sanitizeLog(readFileSync(appLogPath, 'utf8'), sandbox),
        { mode: 0o600 },
      )
    }
    rmSync(sandbox, { recursive: true, force: true })
    writeFileSync(
      join(evidenceRoot, 'cleanup.json'),
      `${JSON.stringify(
        {
          status,
          failure,
          appStopped: !app || app.exitCode !== null || app.signalCode !== null,
          sidecarPortReleased: listenerPIDs(sidecarPort).length === 0,
          providerClosed: true,
          sandboxRemoved: !existsSync(sandbox),
          stoppedSidecars,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    )
  }
}

function validateStatic() {
  const identity = installedIdentity()
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(sealedV2Archive())))
  assert.equal(sealedV2Archive().checksum.length, 64)
  execFileSync('xcrun', ['swiftc', '-typecheck', '-'], {
    input: axDriverSource,
    encoding: 'utf8',
    timeout: 60_000,
  })
  const source = readFileSync(fileURLToPath(import.meta.url), 'utf8')
  assert.match(source, /spawn\(installedExecutable/)
  assert.match(source, /HEXCLAW_TEST_HOME: sandbox/)
  assert.match(source, /DINGTALK_LIVE_SEND: '0'/)
  assert.match(source, /installedDesktopPIDs\(\)/)
  assert.match(source, /api\(origin, '\/api\/k12\/restore'/)
  return {
    status: 'PASS',
    mode: 'static-only',
    appLaunched: false,
    foregroundChanged: false,
    installedArtifact: identity,
    directExactDesktopSpawnContract: true,
    normalAPIFixtureContract: true,
    axDriverTypecheck: true,
    runOptIns: [runOptIn, foregroundOptIn],
  }
}

const command = process.argv[2] || 'validate'
if (command === 'help' || command === '--help' || command === '-h') {
  process.stdout.write(usage())
} else if (command === 'validate') {
  process.stdout.write(`${JSON.stringify(validateStatic(), null, 2)}\n`)
} else if (command === 'run') {
  await runInstalled()
} else {
  process.stderr.write(`Unknown command: ${command}\n\n${usage()}`)
  process.exitCode = 2
}
