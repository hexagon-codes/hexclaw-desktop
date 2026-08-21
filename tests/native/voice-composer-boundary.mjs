#!/usr/bin/env node

/**
 * Voice Composer 的隔离原生边界：当前生产前端 + Tauri Test.app + 真实 Sidecar，
 * STT/Chat 上游只绑定 loopback。音频只计字节数，不保存请求体。
 */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const nativeDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(nativeDir, '../..')
const srcTauriDir = join(repoRoot, 'src-tauri')
const captureMode = process.env.HEX_VOICE_CAPTURE_MODE || 'synthetic-full-chain'
assert.ok(
  captureMode === 'synthetic-full-chain' || captureMode === 'physical-cancel',
  `Unsupported voice capture mode: ${captureMode}`,
)
const physicalCapture = captureMode === 'physical-cancel'
const fixtureSourcePath = join(
  nativeDir,
  physicalCapture ? 'voice-microphone-cancel-fixture.js' : 'voice-composer-fixture.js',
)
const artifactRoot = resolve(
  process.env.HEX_VOICE_ARTIFACT_DIR ||
    join(
      repoRoot,
      physicalCapture
        ? 'test-results/native-voice-microphone-cancel'
        : 'test-results/native-voice-composer',
    ),
)
const runDir = join(artifactRoot, `run-${Date.now()}`)
const appProductName = physicalCapture ? 'HexClaw Voice Capture Test' : 'HexClaw Voice Test'
const appIdentifier = physicalCapture
  ? 'com.hexclaw.desktop.voice-capture-boundary'
  : 'com.hexclaw.desktop.voice-boundary'
const exactMicrophonePurpose =
  'HexClaw 仅在你主动使用语音输入时访问麦克风，并将录音发送到你配置的语音转写服务以生成消息。'
const syntheticCredential = 'local-synthetic-credential'
const commandTimeoutMs = 15 * 60 * 1000

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

function persistedAudioFiles(root) {
  const found = []
  const visit = (directory) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name)
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) continue
      if (stat.isDirectory()) visit(path)
      else if (/\.(aac|flac|m4a|mp3|mp4|ogg|opus|wav|webm)$/i.test(name)) {
        found.push(relative(root, path))
      }
    }
  }
  visit(root)
  return found.sort()
}

function runCommand(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    process.stdout.write(`\n[voice-boundary] ${command} ${args.join(' ')}\n`)
    const child = spawn(command, args, {
      cwd: options.cwd || repoRoot,
      env: options.env || process.env,
      stdio: 'inherit',
    })
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`Command timed out: ${command} ${args.join(' ')}`))
    }, options.timeoutMs || commandTimeoutMs)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      if (code === 0) resolvePromise()
      else reject(new Error(`Command failed (${code ?? signal}): ${command} ${args.join(' ')}`))
    })
  })
}

function jsonResponse(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Origin': '*',
    'Content-Length': Buffer.byteLength(body),
    'Content-Type': 'application/json; charset=utf-8',
  })
  response.end(body)
}

async function readBody(request, maxBytes = 2 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > maxBytes) throw new Error(`Loopback fixture body exceeds ${maxBytes} bytes`)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function countBodyBytes(request, maxBytes = 10 * 1024 * 1024) {
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > maxBytes) throw new Error(`Loopback audio exceeds ${maxBytes} bytes`)
  }
  return size
}

function textContent(value) {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value
    .map((part) =>
      part && typeof part === 'object' && typeof part.text === 'string' ? part.text : '',
    )
    .join('')
}

function lastUserText(payload) {
  const messages = Array.isArray(payload?.messages) ? payload.messages : []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') return textContent(messages[index].content)
  }
  return ''
}

function streamChatSuccess(response) {
  const chunk = JSON.stringify({
    id: 'chatcmpl_voice_boundary',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'mock-model',
    choices: [
      {
        index: 0,
        delta: { role: 'assistant', content: 'HEXCLAW_VOICE_CHAT_OK' },
        finish_reason: null,
      },
    ],
  })
  const done = JSON.stringify({
    id: 'chatcmpl_voice_boundary',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'mock-model',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 4, completion_tokens: 4, total_tokens: 8 },
  })
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'close',
  })
  response.end(`data: ${chunk}\n\ndata: ${done}\n\ndata: [DONE]\n\n`)
}

function nonStreamingChatSuccess(response, content) {
  jsonResponse(response, 200, {
    id: 'chatcmpl_voice_boundary_aux',
    object: 'chat.completion',
    created: 0,
    model: 'mock-model',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 4, completion_tokens: 4, total_tokens: 8 },
  })
}

async function startLoopbackFixture() {
  const receipts = {
    sttRequests: 0,
    chatRequests: 0,
    chatFailureRequests: 0,
    auxiliaryChatRequests: 0,
    updaterRequests: 0,
    audioBytes: [],
    audioMultipart: [],
    chatUserTexts: [],
    progress: [],
    progressDetails: [],
    unexpectedPaths: [],
  }
  let resolveReport
  const reportPromise = new Promise((resolvePromise) => {
    resolveReport = resolvePromise
  })

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', 'http://127.0.0.1')
      if (request.method === 'OPTIONS') {
        response.writeHead(204, {
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
          'Access-Control-Allow-Origin': '*',
        })
        response.end()
        return
      }

      if (request.method === 'GET' && url.pathname === '/__voice_boundary__/stats') {
        jsonResponse(response, 200, receipts)
        return
      }
      if (request.method === 'POST' && url.pathname === '/__voice_boundary__/complete') {
        const report = JSON.parse((await readBody(request)).toString('utf8'))
        jsonResponse(response, 200, { accepted: true })
        resolveReport(report)
        return
      }
      if (request.method === 'POST' && url.pathname === '/__voice_boundary__/progress') {
        const progress = JSON.parse((await readBody(request)).toString('utf8'))
        if (typeof progress?.stage === 'string') {
          receipts.progress.push(progress.stage)
          if (progress.detail && typeof progress.detail === 'object') {
            receipts.progressDetails.push(progress.detail)
          }
          process.stdout.write(`[voice-boundary] WebView stage: ${progress.stage}\n`)
        }
        jsonResponse(response, 200, { accepted: true })
        return
      }
      if (url.pathname === '/__voice_boundary__/updater') {
        receipts.updaterRequests += 1
        response.writeHead(204, { 'Access-Control-Allow-Origin': '*' })
        response.end()
        return
      }
      if (request.method === 'GET' && url.pathname === '/v1/models') {
        jsonResponse(response, 200, {
          object: 'list',
          data: [{ id: 'mock-model', object: 'model', owned_by: 'loopback' }],
        })
        return
      }
      if (request.method === 'POST' && url.pathname === '/v1/audio/transcriptions') {
        const byteCount = await countBodyBytes(request)
        receipts.sttRequests += 1
        receipts.audioBytes.push(byteCount)
        receipts.audioMultipart.push(
          String(request.headers['content-type'] || '').startsWith('multipart/form-data;'),
        )
        if (receipts.sttRequests === 2) {
          jsonResponse(response, 500, { error: { message: 'Loopback STT failure' } })
          return
        }
        const text = receipts.sttRequests === 1 ? '边界语音成功' : '边界发送失败草稿'
        jsonResponse(response, 200, { text, language: 'zh', duration: 1.25 })
        return
      }
      if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
        const raw = await readBody(request)
        const payload = JSON.parse(raw.toString('utf8'))
        const userText = lastUserText(payload)
        receipts.chatUserTexts.push(userText)
        const successVoiceRequest = userText.endsWith('边界语音成功')
        const failedVoiceRequest = userText.endsWith('边界发送失败草稿')
        const mainVoiceRequest = successVoiceRequest || failedVoiceRequest
        if (!mainVoiceRequest) {
          receipts.auxiliaryChatRequests += 1
          nonStreamingChatSuccess(response, '语音边界')
          return
        }

        receipts.chatRequests += 1
        if (failedVoiceRequest) {
          receipts.chatFailureRequests += 1
          jsonResponse(response, 500, { error: { message: 'Loopback chat failure' } })
          return
        }
        if (payload.stream === true) streamChatSuccess(response)
        else nonStreamingChatSuccess(response, 'HEXCLAW_VOICE_CHAT_OK')
        return
      }

      receipts.unexpectedPaths.push(`${request.method || 'GET'} ${url.pathname}`)
      jsonResponse(response, 404, { error: { message: 'Unexpected loopback fixture request' } })
    } catch (error) {
      jsonResponse(response, 500, {
        error: { message: error instanceof Error ? error.message : String(error) },
      })
    }
  })

  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return {
    origin: `http://127.0.0.1:${address.port}`,
    receipts,
    reportPromise,
    close: () =>
      new Promise((resolvePromise, reject) => {
        server.close((error) => {
          if (error) reject(error)
          else resolvePromise()
        })
        server.closeAllConnections()
      }),
  }
}

async function reserveLoopbackPort() {
  const server = createServer()
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const port = address.port
  await new Promise((resolvePromise) => server.close(resolvePromise))
  assert.notEqual(port, 16060)
  return port
}

function renderConfig(sandbox, sidecarPort, fixtureOrigin) {
  const databasePath = join(sandbox, '.hexclaw/data.db')
  return `server:
  host: 127.0.0.1
  port: ${sidecarPort}
  mode: development
platforms:
  web:
    enabled: true
llm:
  default: openai
  providers:
    openai:
      api_key: ${syntheticCredential}
      base_url: ${fixtureOrigin}/v1
      model: mock-model
      models:
        - mock-model
      model_specs_mode: explicit
      model_specs:
        - id: mock-model
          display_name: Voice Boundary Model
          capabilities:
            - text
      compatible: openai
      locality: local
      tools_enabled: false
      enabled: true
    ollama:
      api_key: ollama
      base_url: ${fixtureOrigin}/v1
      model: mock-model
      models:
        - mock-model
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
  enabled: true
  stt:
    provider: openai-whisper
    model: whisper-1
  tts:
    provider: ""
skill:
  sandbox:
    enabled: false
  builtin:
    search: false
    weather: false
    browser: false
    code_exec: false
    file_ops: false
observe:
  log_level: info
  metrics:
    enabled: false
`
}

function prepareFrontend(sandbox, fixtureOrigin) {
  const dist = join(repoRoot, 'dist')
  assert.ok(existsSync(join(dist, 'index.html')), 'pnpm build-only did not produce dist/index.html')
  const frontend = join(sandbox, 'frontend')
  cpSync(dist, frontend, { recursive: true })

  const fixtureTarget = join(frontend, 'voice-composer-fixture.js')
  const fixture = readFileSync(fixtureSourcePath, 'utf8').replace(
    '__HEX_VOICE_FIXTURE_ORIGIN__',
    fixtureOrigin,
  )
  writeFileSync(fixtureTarget, fixture)

  const indexPath = join(frontend, 'index.html')
  const index = readFileSync(indexPath, 'utf8')
  assert.match(index, /<head>/)
  writeFileSync(
    indexPath,
    index.replace('<head>', '<head>\n<script src="./voice-composer-fixture.js"></script>'),
  )
  return frontend
}

function writeOverlay(sandbox, frontend, sidecarPort, fixtureOrigin) {
  const overlayPath = join(sandbox, 'tauri.voice-boundary.conf.json')
  const frontendRelative = relative(srcTauriDir, frontend)
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "style-src-attr 'unsafe-inline'",
    `img-src 'self' data: blob: http://localhost:16060 http://localhost:${sidecarPort}`,
    `media-src 'self' data: blob: http://localhost:16060 http://localhost:${sidecarPort}`,
    `connect-src 'self' http://localhost:16060 ws://localhost:16060 http://localhost:${sidecarPort} ws://localhost:${sidecarPort} ${fixtureOrigin}`,
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ')
  const overlay = {
    productName: appProductName,
    identifier: appIdentifier,
    build: {
      frontendDist: frontendRelative,
      beforeBuildCommand: '',
    },
    app: {
      windows: [
        {
          label: 'main',
          title: appProductName,
          width: 1280,
          height: 820,
          minWidth: 900,
          minHeight: 600,
          visible: true,
        },
      ],
      security: { csp },
    },
    bundle: {
      targets: ['app'],
      createUpdaterArtifacts: false,
    },
    plugins: {
      updater: {
        endpoints: [`${fixtureOrigin}/__voice_boundary__/updater`],
        dangerousInsecureTransportProtocol: true,
      },
    },
  }
  writeFileSync(overlayPath, `${JSON.stringify(overlay, null, 2)}\n`)
  return overlayPath
}

async function waitForHealth(port, processHandle) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) throw new Error('Test.app exited before Sidecar health')
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1_500),
      })
      if (response.ok) return
    } catch {
      // Sidecar 尚在启动。
    }
    await sleep(250)
  }
  throw new Error(`Sidecar health timed out on loopback port ${port}`)
}

function listenerPids(port) {
  try {
    const value = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
      encoding: 'utf8',
    })
    return value.split(/\s+/).filter(Boolean).map(Number)
  } catch {
    return []
  }
}

async function stopProcess(processHandle) {
  if (!processHandle || processHandle.exitCode !== null) return
  processHandle.kill('SIGTERM')
  const exited = await Promise.race([
    new Promise((resolvePromise) => processHandle.once('exit', () => resolvePromise(true))),
    sleep(5_000).then(() => false),
  ])
  if (!exited && processHandle.exitCode === null) {
    processHandle.kill('SIGKILL')
    await new Promise((resolvePromise) => processHandle.once('exit', resolvePromise))
  }
}

async function stopOwnedSidecar(port, appBundle) {
  for (const pid of listenerPids(port)) {
    const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
    }).trim()
    if (!command.includes(`${appBundle}/Contents/MacOS/hexclaw serve --desktop`)) {
      throw new Error(`Dedicated port ${port} is owned by an unexpected process: ${pid}`)
    }
    process.kill(pid, 'SIGTERM')
  }
  const deadline = Date.now() + 5_000
  while (listenerPids(port).length && Date.now() < deadline) await sleep(100)
  assert.deepEqual(listenerPids(port), [], `Sidecar listener remains on port ${port}`)
}

function sanitizeLog(raw, sandbox) {
  return raw
    .replaceAll(syntheticCredential, '[REDACTED]')
    .replaceAll(repoRoot, '<repo>')
    .replaceAll(sandbox, '<sandbox>')
}

async function main() {
  assert.equal(process.platform, 'darwin', 'Native voice boundary is macOS-only')
  assert.ok(existsSync(fixtureSourcePath), 'WebView fixture is missing')
  mkdirSync(runDir, { recursive: true })

  const sandbox = mkdtempSync(join(tmpdir(), 'hexclaw-voice-boundary.'))
  chmodSync(sandbox, 0o700)
  const configDir = join(sandbox, '.hexclaw')
  mkdirSync(configDir, { mode: 0o700 })
  chmodSync(configDir, 0o700)
  const appRawLog = join(sandbox, 'app.log')
  const loopback = await startLoopbackFixture()
  const sidecarPort = await reserveLoopbackPort()
  let appProcess = null
  let appLog = null
  let appBundle = ''
  let finalStatus = 'FAIL'
  let webViewReport = null
  let boundaryError = null
  let bundledMicrophonePurpose = null
  let baselineAudioFiles = []

  try {
    const configPath = join(configDir, 'hexclaw.yaml')
    writeFileSync(configPath, renderConfig(sandbox, sidecarPort, loopback.origin), { mode: 0o600 })
    chmodSync(configPath, 0o600)

    const offlineEnv = {
      ...process.env,
      CARGO_NET_OFFLINE: 'true',
      GOCACHE: join(sandbox, 'go-build-cache'),
      GOENV: 'off',
      GOPROXY: 'off',
      GOSUMDB: 'off',
      PNPM_CONFIG_OFFLINE: 'true',
      npm_config_offline: 'true',
    }
    delete offlineEnv.GOROOT
    await runCommand('make', ['sidecar-local'], { env: offlineEnv })
    await runCommand('pnpm', ['build-only'], { env: offlineEnv })
    const frontend = prepareFrontend(sandbox, loopback.origin)
    const overlayPath = writeOverlay(sandbox, frontend, sidecarPort, loopback.origin)
    await runCommand(
      'pnpm',
      ['exec', 'tauri', 'build', '--config', overlayPath, '--bundles', 'app'],
      { env: offlineEnv },
    )

    appBundle = join(srcTauriDir, `target/release/bundle/macos/${appProductName}.app`)
    const infoPlist = join(appBundle, 'Contents/Info.plist')
    const executable = join(appBundle, 'Contents/MacOS/hexclaw-desktop')
    assert.ok(existsSync(infoPlist), `Test.app Info.plist is missing: ${infoPlist}`)
    assert.ok(existsSync(executable), `Test.app executable is missing: ${executable}`)
    const identifier = execFileSync(
      'plutil',
      ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', infoPlist],
      {
        encoding: 'utf8',
      },
    ).trim()
    assert.equal(identifier, appIdentifier)
    bundledMicrophonePurpose = execFileSync(
      'plutil',
      ['-extract', 'NSMicrophoneUsageDescription', 'raw', '-o', '-', infoPlist],
      { encoding: 'utf8' },
    ).trim()
    assert.equal(bundledMicrophonePurpose, exactMicrophonePurpose)
    assert.deepEqual(listenerPids(sidecarPort), [], `Dedicated port ${sidecarPort} is occupied`)
    baselineAudioFiles = persistedAudioFiles(sandbox)

    appLog = createWriteStream(appRawLog, { flags: 'wx', mode: 0o600 })
    const runtimeEnv = {
      PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
      LANG: 'zh_CN.UTF-8',
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
      NO_PROXY: '*',
      no_proxy: '*',
    }
    mkdirSync(runtimeEnv.TMPDIR, { mode: 0o700 })
    appProcess = spawn(executable, [], {
      cwd: sandbox,
      env: runtimeEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    appProcess.stdout.pipe(appLog, { end: false })
    appProcess.stderr.pipe(appLog, { end: false })
    await waitForHealth(sidecarPort, appProcess)

    const reportTimeoutMs = physicalCapture ? 180_000 : 120_000
    let reportTimer
    try {
      webViewReport = await Promise.race([
        loopback.reportPromise,
        new Promise((_, reject) => {
          reportTimer = setTimeout(
            () => reject(new Error('WebView voice boundary report timed out')),
            reportTimeoutMs,
          )
        }),
      ])
    } finally {
      clearTimeout(reportTimer)
    }
    await sleep(100)
    assert.doesNotMatch(
      readFileSync(appRawLog, 'utf8'),
      /localhost:11434/,
      'Isolated Test.app must not probe or register the user Ollama instance',
    )
    assert.equal(webViewReport.status, 'PASS', webViewReport.error || 'WebView boundary failed')
    assert.deepEqual(loopback.receipts.unexpectedPaths, [])
    if (physicalCapture) {
      assert.equal(webViewReport.source?.realGetUserMedia, true)
      assert.equal(loopback.receipts.sttRequests, 0)
      assert.equal(loopback.receipts.chatRequests, 0)
      assert.deepEqual(loopback.receipts.audioBytes, [])
    } else {
      assert.equal(loopback.receipts.sttRequests, 3)
      assert.equal(loopback.receipts.chatFailureRequests >= 1, true)
      assert.equal(loopback.receipts.audioMultipart.every(Boolean), true)
    }
    const finalAudioFiles = persistedAudioFiles(sandbox)
    assert.deepEqual(
      finalAudioFiles,
      baselineAudioFiles,
      'Voice capture must not persist audio files',
    )

    const evidence = {
      status: 'PASS',
      app: {
        bundle: relative(repoRoot, appBundle),
        identifier,
        microphonePurpose: bundledMicrophonePurpose,
        nativeWindow: true,
        testHomeIsolated: true,
      },
      network: {
        providerOrigins: [loopback.origin],
        binding: '127.0.0.1',
        externalProviderCalls: 0,
      },
      audio: {
        source: physicalCapture
          ? 'physical microphone via native getUserMedia'
          : 'WebAudio synthetic in-memory MediaStream',
        persisted: false,
        persistedAudioFilesAdded: [],
        realMicrophonePermissionCovered: Boolean(
          webViewReport?.source?.realMicrophonePermissionCovered,
        ),
      },
      report: webViewReport,
      receipts: loopback.receipts,
    }
    writeFileSync(join(runDir, 'report.json'), `${JSON.stringify(evidence, null, 2)}\n`)
    finalStatus = 'PASS'
    process.stdout.write(
      `\nNative voice ${captureMode} boundary PASS: ${relative(repoRoot, join(runDir, 'report.json'))}\n`,
    )
  } catch (error) {
    boundaryError = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    throw error
  } finally {
    await stopProcess(appProcess)
    if (appLog) {
      await new Promise((resolvePromise) => appLog.end(resolvePromise))
    }
    if (appBundle) await stopOwnedSidecar(sidecarPort, appBundle)
    await loopback.close()

    if (existsSync(appRawLog)) {
      const sanitized = sanitizeLog(readFileSync(appRawLog, 'utf8'), sandbox)
      writeFileSync(join(runDir, 'app.log'), sanitized)
    }
    const cleanup = {
      status: finalStatus,
      appProcessStopped:
        !appProcess || appProcess.exitCode !== null || appProcess.signalCode !== null,
      sidecarPortReleased: listenerPids(sidecarPort).length === 0,
      sandboxRemoved: true,
    }
    if (!existsSync(join(runDir, 'report.json'))) {
      const evidence = {
        status: finalStatus,
        error: boundaryError,
        app: {
          bundle: appBundle ? relative(repoRoot, appBundle) : null,
          identifier: appIdentifier,
          microphonePurpose: bundledMicrophonePurpose,
          nativeWindow: Boolean(appBundle),
          testHomeIsolated: true,
        },
        network: {
          providerOrigins: [loopback.origin],
          binding: '127.0.0.1',
          externalProviderCalls: 0,
        },
        audio: {
          source: physicalCapture
            ? 'physical microphone via native getUserMedia'
            : 'WebAudio synthetic in-memory MediaStream',
          persisted: false,
          persistedAudioFilesAdded: persistedAudioFiles(sandbox).filter(
            (path) => !baselineAudioFiles.includes(path),
          ),
          realMicrophonePermissionCovered: Boolean(
            webViewReport?.source?.realMicrophonePermissionCovered,
          ),
        },
        report: webViewReport,
        receipts: loopback.receipts,
      }
      writeFileSync(join(runDir, 'report.json'), `${JSON.stringify(evidence, null, 2)}\n`)
    }
    writeFileSync(join(runDir, 'cleanup.json'), `${JSON.stringify(cleanup, null, 2)}\n`)
    rmSync(sandbox, { recursive: true, force: true })
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
