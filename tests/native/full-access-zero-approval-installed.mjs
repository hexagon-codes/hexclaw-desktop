import assert from 'node:assert/strict'
import {
  appendFileSync,
  chmodSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'

const TEST_SIDECAR_PORT = Number.parseInt(
  process.env.HEX_NATIVE_FULL_ACCESS_SIDECAR_PORT || '16061',
  10,
)
const TEST_FIXTURE_PORT = 16062
const TEST_UPDATER_PATH = '/__hexclaw_test_updater__'
const TEST_UPDATER_ENDPOINT = `http://127.0.0.1:${TEST_FIXTURE_PORT}${TEST_UPDATER_PATH}`
const TEST_API_TOKEN = 'hexclaw-installed-full-access-approval-zero-0123456789abcdef'
const USER_MARKER = 'FULL_ACCESS_APPROVAL_ZERO_CARD_FIXTURE'
const FINAL_MARKER = 'FULL_ACCESS_APPROVAL_ZERO_CARD_OK'
const TOOL_CALL_ID = 'call-full-access-approval-zero'
const APPROVAL_EVENT_TYPES = new Set([
  'tool_approval_request',
  'tool_permission_request',
  'tool_approval_ack',
  'tool_permission_ack',
  'tool_approval_terminal',
])

const currentFile = fileURLToPath(import.meta.url)
const repoRoot = resolve(dirname(currentFile), '../..')
const overlayPath = join(repoRoot, 'src-tauri/tauri.mock.conf.json')
const defaultAppBundle = join(repoRoot, 'src-tauri/target/release/bundle/macos/HexClaw Test.app')
const artifactDir = resolve(
  process.env.HEX_NATIVE_FULL_ACCESS_ARTIFACT_DIR ||
    join(repoRoot, 'test-results/native-full-access-zero-approval'),
)

function fail(message) {
  throw new Error(message)
}

function validateLoopbackURL(raw, expectedPort, expectedPath = '') {
  const url = new URL(raw)
  assert.equal(url.protocol, 'http:', `${raw} must use loopback HTTP`)
  assert.equal(url.hostname, '127.0.0.1', `${raw} must use exact 127.0.0.1 host`)
  assert.equal(url.port, String(expectedPort), `${raw} uses an unexpected port`)
  if (expectedPath) {
    assert.equal(url.pathname, expectedPath, `${raw} uses an unexpected path`)
  }
  assert.equal(url.username, '', `${raw} must not contain credentials`)
  assert.equal(url.password, '', `${raw} must not contain credentials`)
}

function validateOverlay() {
  const overlay = JSON.parse(readFileSync(overlayPath, 'utf8'))
  assert.equal(overlay.identifier, 'com.hexclaw.desktop.mock')
  const csp = String(overlay.app?.security?.csp || '')
  assert.match(csp, /localhost:16061/)
  assert.doesNotMatch(csp, /localhost:11434|127\.0\.0\.1:11434/)

  const updater = overlay.plugins?.updater
  assert.ok(updater, 'test-only Tauri overlay must override the production updater')
  assert.deepEqual(
    updater.endpoints,
    [TEST_UPDATER_ENDPOINT],
    'test-only updater must have one fixed loopback endpoint',
  )
  assert.equal(
    updater.dangerousInsecureTransportProtocol,
    true,
    'test-only loopback HTTP updater must be explicitly enabled',
  )
  validateLoopbackURL(updater.endpoints[0], TEST_FIXTURE_PORT, TEST_UPDATER_PATH)
}

function runMCPFixture(receiptPath) {
  if (!receiptPath) fail('MCP receipt path is required')
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
  const respond = (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`)

  input.on('line', (line) => {
    if (!line.trim()) return
    let request
    try {
      request = JSON.parse(line)
    } catch {
      return
    }
    if (request.id === undefined || request.id === null) return

    switch (request.method) {
      case 'initialize':
        respond({
          jsonrpc: '2.0',
          id: request.id,
          result: {
            protocolVersion: request.params?.protocolVersion || '2025-11-25',
            capabilities: { tools: {} },
            serverInfo: { name: 'approval-zero-noop', version: '1.0.0' },
          },
        })
        break
      case 'tools/list':
        respond({
          jsonrpc: '2.0',
          id: request.id,
          result: {
            tools: [
              {
                name: 'browser',
                description: 'Deterministic no-op browser-shaped test tool.',
                inputSchema: {
                  type: 'object',
                  properties: { fixture: { type: 'string' } },
                  required: ['fixture'],
                  additionalProperties: false,
                },
              },
            ],
          },
        })
        break
      case 'tools/call': {
        const record = {
          name: request.params?.name,
          arguments: request.params?.arguments || {},
          called_at: new Date().toISOString(),
        }
        appendFileSync(receiptPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8' })
        respond({
          jsonrpc: '2.0',
          id: request.id,
          result: {
            content: [{ type: 'text', text: 'NOOP_MCP_BROWSER_OK' }],
            isError: false,
          },
        })
        break
      }
      case 'ping':
        respond({ jsonrpc: '2.0', id: request.id, result: {} })
        break
      default:
        respond({
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32601, message: 'Method not found' },
        })
    }
  })
  input.on('close', () => process.exit(0))
}

function readRequestBody(request) {
  return new Promise((resolveBody, reject) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

function writeSSE(response, events) {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'close',
  })
  for (const event of events) {
    response.write(`data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`)
  }
  response.end()
}

function openAIChunk(delta, finishReason = null) {
  return {
    id: 'chatcmpl-full-access-approval-zero',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'mock-model',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  }
}

function createLoopbackFixtureServer(state) {
  return createServer(async (request, response) => {
    const requestURL = new URL(request.url || '/', `http://127.0.0.1:${TEST_FIXTURE_PORT}`)
    if (request.method === 'GET' && requestURL.pathname === TEST_UPDATER_PATH) {
      state.updaterRequests += 1
      response.writeHead(204, { connection: 'close' })
      response.end()
      return
    }
    if (request.method !== 'POST' || requestURL.pathname !== '/v1/chat/completions') {
      state.unexpectedRequests.push(`${request.method} ${requestURL.pathname}`)
      response.writeHead(404, { 'content-type': 'application/json', connection: 'close' })
      response.end(JSON.stringify({ error: { message: 'Fixture route not found' } }))
      return
    }

    let payload
    try {
      payload = JSON.parse(await readRequestBody(request))
    } catch (error) {
      state.protocolErrors.push(`invalid provider JSON: ${error.message}`)
      response.writeHead(400, { connection: 'close' })
      response.end()
      return
    }

    const turn = state.chatRequests.length + 1
    state.chatRequests.push(payload)
    try {
      assert.equal(request.headers.authorization, 'Bearer local-synthetic-credential')
      assert.equal(payload.model, 'mock-model')
      assert.equal(payload.stream, true)
      const toolMessages = (payload.messages || []).filter((message) => message.role === 'tool')
      const assistantToolCalls = (payload.messages || []).flatMap((message) =>
        message.role === 'assistant' && Array.isArray(message.tool_calls) ? message.tool_calls : [],
      )
      if (turn === 1) {
        assert.match(JSON.stringify(payload.messages || []), new RegExp(USER_MARKER))
        assert.equal(toolMessages.length, 0)
        assert.ok(
          (payload.tools || []).some((tool) => tool?.function?.name === 'browser'),
          'first provider turn must expose the browser-shaped MCP tool',
        )
        writeSSE(response, [
          openAIChunk({
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: TOOL_CALL_ID,
                type: 'function',
                function: {
                  name: 'browser',
                  arguments: '{"fixture":"approval-zero"}',
                },
              },
            ],
          }),
          openAIChunk({}, 'tool_calls'),
          '[DONE]',
        ])
        return
      }
      if (turn === 2) {
        assert.equal(toolMessages.length, 1)
        assert.equal(toolMessages[0].tool_call_id, TOOL_CALL_ID)
        assert.match(String(toolMessages[0].content || ''), /NOOP_MCP_BROWSER_OK/)
        assert.equal(assistantToolCalls.length, 1)
        assert.equal(assistantToolCalls[0].id, TOOL_CALL_ID)
        writeSSE(response, [
          openAIChunk({ role: 'assistant', content: FINAL_MARKER }, 'stop'),
          '[DONE]',
        ])
        return
      }
      fail(`unexpected provider chat turn ${turn}`)
    } catch (error) {
      state.protocolErrors.push(error.stack || error.message)
      if (!response.headersSent) response.writeHead(400, { connection: 'close' })
      response.end()
    }
  })
}

function yamlString(value) {
  return JSON.stringify(String(value))
}

function renderConfig(sandbox, receiptPath) {
  const configPath = join(sandbox, '.hexclaw/hexclaw.yaml')
  const databasePath = join(sandbox, '.hexclaw/data.db')
  const nodePath = process.execPath
  return {
    configPath,
    content: `server:
  host: 127.0.0.1
  port: ${TEST_SIDECAR_PORT}
  mode: development
  api_token: ${yamlString(TEST_API_TOKEN)}
platforms:
  web:
    enabled: true
llm:
  default: mock-openai
  providers:
    mock-openai:
      api_key: local-synthetic-credential
      base_url: http://127.0.0.1:${TEST_FIXTURE_PORT}/v1
      model: mock-model
      models:
        - mock-model
      model_specs_mode: explicit
      model_specs:
        - id: mock-model
          display_name: Mock Model
          capabilities:
            - text
      compatible: openai
      locality: cloud
      tools_enabled: true
      enabled: true
    fixture-local-sentinel:
      api_key: local-synthetic-credential
      base_url: http://127.0.0.1:${TEST_FIXTURE_PORT}/v1
      model: mock-model
      models:
        - mock-model
      model_specs_mode: explicit
      model_specs:
        - id: mock-model
          display_name: Mock Model
          capabilities:
            - text
      compatible: openai
      locality: local
      tools_enabled: false
      enabled: true
  routing:
    enabled: false
    strategy: quality-first
  cache:
    enabled: false
  tools:
    enabled: on
storage:
  driver: sqlite
  sqlite:
    path: ${yamlString(databasePath)}
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
  enabled: true
  servers:
    - name: approval-zero-noop
      transport: stdio
      command: ${yamlString(nodePath)}
      args:
        - ${yamlString(currentFile)}
        - mcp
        - ${yamlString(receiptPath)}
      enabled: true
skills:
  enabled: false
  auto_load: false
router:
  enabled: false
voice:
  enabled: false
security:
  autonomy:
    profile: full_access
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
`,
  }
}

function plutilValue(infoPlist, key) {
  return execFileSync('plutil', ['-extract', key, 'raw', '-o', '-', infoPlist], {
    encoding: 'utf8',
  }).trim()
}

function fileSha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function listenerPIDs(port) {
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

async function waitFor(predicate, timeoutMs, description, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return
    } catch (error) {
      lastError = error
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, intervalMs))
  }
  fail(`${description} timed out${lastError ? `: ${lastError.message}` : ''}`)
}

async function waitForHealth(appProcess, appTail) {
  await waitFor(
    async () => {
      if (appProcess.exitCode !== null) {
        fail(`HexClaw Test exited before health readiness\n${appTail()}`)
      }
      const response = await fetch(`http://127.0.0.1:${TEST_SIDECAR_PORT}/health`, {
        signal: AbortSignal.timeout(1000),
      })
      return response.ok
    },
    90_000,
    'Test.app Sidecar health readiness',
    300,
  )
}

async function stopProcess(child, signal = 'SIGTERM') {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  child.kill(signal)
  const exited = await Promise.race([
    new Promise((resolveExit) => child.once('exit', () => resolveExit(true))),
    new Promise((resolveExit) => setTimeout(() => resolveExit(false), 5000)),
  ])
  if (!exited && child.exitCode === null) child.kill('SIGKILL')
}

async function stopOwnedSidecar(appBundle) {
  for (const pid of listenerPIDs(TEST_SIDECAR_PORT)) {
    const command = processCommand(pid)
    if (
      command.includes(`${appBundle}/Contents/MacOS/hexclaw`) &&
      command.includes('serve --desktop')
    ) {
      try {
        process.kill(pid, 'SIGTERM')
      } catch (error) {
        if (error.code !== 'ESRCH') throw error
      }
    }
  }
}

async function runWebSocketBoundary(state) {
  const { default: WebSocket } = await import('ws')
  const outbound = []
  const inbound = []
  let ws
  let streamedContent = ''
  const result = await new Promise((resolveResult, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('ordinary chat did not complete within 30 seconds')),
      30_000,
    )
    ws = new WebSocket(`ws://127.0.0.1:${TEST_SIDECAR_PORT}/ws`, {
      headers: {
        Authorization: `Bearer ${TEST_API_TOKEN}`,
        Origin: 'tauri://localhost',
      },
    })
    ws.on('open', () => {
      const message = {
        type: 'message',
        content: USER_MARKER,
        user_id: 'installed-boundary',
        session_id: 'installed-full-access-approval-zero',
        request_id: 'installed-full-access-approval-zero-request',
        provider: 'mock-openai',
        model: 'mock-model',
      }
      outbound.push(message)
      ws.send(JSON.stringify(message))
    })
    ws.on('message', (data) => {
      let message
      try {
        message = JSON.parse(data.toString())
      } catch (error) {
        clearTimeout(timeout)
        reject(error)
        return
      }
      inbound.push(message)
      if (message.type === 'chunk' && typeof message.content === 'string') {
        streamedContent += message.content
      }
      if (APPROVAL_EVENT_TYPES.has(message.type)) {
        clearTimeout(timeout)
        reject(new Error(`unexpected approval wire: ${JSON.stringify(message)}`))
        return
      }
      if (message.type === 'error') {
        clearTimeout(timeout)
        reject(new Error(`Sidecar returned error: ${message.content}`))
        return
      }
      if (
        (message.type === 'chunk' && message.done && streamedContent.includes(FINAL_MARKER)) ||
        (message.type === 'reply' && message.content?.includes(FINAL_MARKER))
      ) {
        clearTimeout(timeout)
        resolveResult(message)
      }
    })
    ws.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
  })

  const approvalWires = inbound.filter((message) => APPROVAL_EVENT_TYPES.has(message.type))
  const deadlineEvents = inbound.filter(
    (message) => String(message.deadline_at || message.metadata?.deadline_at || '').trim() !== '',
  )
  const approvalResponses = outbound.filter((message) =>
    ['tool_approval_response', 'tool_permission_response'].includes(message.type),
  )
  state.ws = {
    inboundEvents: inbound.length,
    approvalWires: approvalWires.length,
    deadlineEvents: deadlineEvents.length,
    approvalResponses: approvalResponses.length,
    terminalType: result.type,
    streamedContent,
  }
  ws.close()
  return ws
}

async function runInstalledBoundary() {
  validateOverlay()
  assert.equal(process.platform, 'darwin', 'installed Test.app boundary is macOS-only')
  assert.ok(
    Number.isInteger(TEST_SIDECAR_PORT) && TEST_SIDECAR_PORT >= 1024 && TEST_SIDECAR_PORT <= 65535,
    'test Sidecar port must be an unprivileged TCP port',
  )
  assert.notEqual(TEST_SIDECAR_PORT, 16060)
  assert.notEqual(TEST_FIXTURE_PORT, 16060)

  const appBundle = resolve(process.env.HEX_NATIVE_APP_BUNDLE || defaultAppBundle)
  const infoPlist = join(appBundle, 'Contents/Info.plist')
  assert.ok(existsSync(infoPlist), `Test.app bundle is missing: ${appBundle}`)
  assert.equal(plutilValue(infoPlist, 'CFBundleIdentifier'), 'com.hexclaw.desktop.mock')
  const appExecutable = join(
    appBundle,
    'Contents/MacOS',
    plutilValue(infoPlist, 'CFBundleExecutable'),
  )
  assert.ok(existsSync(appExecutable), `Test.app executable is missing: ${appExecutable}`)
  const sidecarExecutable = join(appBundle, 'Contents/MacOS/hexclaw')
  assert.ok(existsSync(sidecarExecutable), `Test.app Sidecar is missing: ${sidecarExecutable}`)
  assert.deepEqual(listenerPIDs(TEST_SIDECAR_PORT), [], `port ${TEST_SIDECAR_PORT} is occupied`)
  assert.deepEqual(listenerPIDs(TEST_FIXTURE_PORT), [], `port ${TEST_FIXTURE_PORT} is occupied`)

  mkdirSync(artifactDir, { recursive: true })
  rmSync(join(artifactDir, 'sandbox'), { recursive: true, force: true })
  const sandbox = mkdtempSync(join(tmpdir(), 'hexclaw-full-access-approval-zero-'))
  chmodSync(sandbox, 0o700)
  mkdirSync(join(sandbox, '.hexclaw'), { mode: 0o700 })
  mkdirSync(join(sandbox, 'tmp'), { mode: 0o700 })
  const receiptPath = join(sandbox, 'mcp-receipts.jsonl')
  const rendered = renderConfig(sandbox, receiptPath)
  writeFileSync(rendered.configPath, rendered.content, { encoding: 'utf8', mode: 0o600 })
  chmodSync(rendered.configPath, 0o600)

  const state = {
    updaterRequests: 0,
    chatRequests: [],
    unexpectedRequests: [],
    protocolErrors: [],
    ws: null,
  }
  const providerServer = createLoopbackFixtureServer(state)
  let appProcess
  let appLogStream
  let appTail = ''
  let succeeded = false
  try {
    await new Promise((resolveListen, reject) => {
      providerServer.once('error', reject)
      providerServer.listen(TEST_FIXTURE_PORT, '127.0.0.1', resolveListen)
    })

    appLogStream = createWriteStream(join(artifactDir, 'app.log'), { flags: 'w' })
    appProcess = spawn(appExecutable, [], {
      cwd: appBundle,
      env: {
        PATH: process.env.PATH || '',
        LANG: process.env.LANG || 'C.UTF-8',
        HOME: sandbox,
        USERPROFILE: sandbox,
        CFFIXED_USER_HOME: sandbox,
        TMPDIR: join(sandbox, 'tmp'),
        TEMP: join(sandbox, 'tmp'),
        TMP: join(sandbox, 'tmp'),
        HEXCLAW_TEST_MODE: '1',
        HEXCLAW_TEST_HOME: sandbox,
        HEXCLAW_SIDECAR_PORT: String(TEST_SIDECAR_PORT),
        HEXCLAW_TEST_LLM_CONFIG_MODE: 'preseeded-owner-yaml',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const capture = (chunk) => {
      appLogStream.write(chunk)
      appTail = `${appTail}${chunk.toString()}`.slice(-24_000)
    }
    appProcess.stdout.on('data', capture)
    appProcess.stderr.on('data', capture)

    await waitForHealth(appProcess, () => appTail)
    await runWebSocketBoundary(state)
    await waitFor(() => state.updaterRequests > 0, 5000, 'loopback updater request', 100)

    assert.deepEqual(state.unexpectedRequests, [])
    assert.deepEqual(state.protocolErrors, [])
    assert.equal(state.chatRequests.length, 2, 'provider chat rounds must equal two')
    assert.deepEqual(state.ws, {
      inboundEvents: state.ws.inboundEvents,
      approvalWires: 0,
      deadlineEvents: 0,
      approvalResponses: 0,
      terminalType: state.ws.terminalType,
      streamedContent: FINAL_MARKER,
    })

    const receipts = readFileSync(receiptPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    assert.equal(receipts.length, 1, 'no-op MCP execution count must equal one')
    assert.deepEqual(
      { name: receipts[0].name, arguments: receipts[0].arguments },
      { name: 'browser', arguments: { fixture: 'approval-zero' } },
    )
    assert.equal(statSync(sandbox).mode & 0o777, 0o700)
    assert.equal(statSync(dirname(rendered.configPath)).mode & 0o777, 0o700)
    assert.equal(statSync(rendered.configPath).mode & 0o777, 0o600)
    assert.match(readFileSync(rendered.configPath, 'utf8'), /profile: full_access/)

    const summary = {
      acceptance: ['REG-TOOL-APPROVAL-PROFILE-001', 'REG-TOOL-APPROVAL-PROFILE-002'],
      appBundle: relative(repoRoot, appBundle),
      bundleIdentifier: 'com.hexclaw.desktop.mock',
      bundleVersion: plutilValue(infoPlist, 'CFBundleShortVersionString'),
      appExecutableSha256: fileSha256(appExecutable),
      sidecarExecutableSha256: fileSha256(sidecarExecutable),
      sidecar: `http://127.0.0.1:${TEST_SIDECAR_PORT}`,
      provider: `http://127.0.0.1:${TEST_FIXTURE_PORT}/v1`,
      updater: TEST_UPDATER_ENDPOINT,
      providerChatRounds: state.chatRequests.length,
      mcpExecutions: receipts.length,
      updaterRequests: state.updaterRequests,
      approvalWireEvents: state.ws.approvalWires,
      approvalDeadlineEvents: state.ws.deadlineEvents,
      approvalResponsesSent: state.ws.approvalResponses,
      realToolsInvoked: 0,
      externalModelInvocations: 0,
      imInvocations: 0,
      productionPortUsed: false,
      ownerConfigLoaded: false,
    }
    writeFileSync(join(artifactDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
    succeeded = true
  } catch (error) {
    if (existsSync(sandbox)) {
      cpSync(sandbox, join(artifactDir, 'sandbox'), { recursive: true })
    }
    fail(
      `${error.stack || error.message}\nFixture state:\n${JSON.stringify(state, null, 2)}\nApp log tail:\n${appTail}`,
    )
  } finally {
    await stopProcess(appProcess)
    await stopOwnedSidecar(appBundle)
    if (appLogStream) {
      await new Promise((resolveClose) => appLogStream.end(resolveClose))
    }
    providerServer.closeAllConnections?.()
    await new Promise((resolveClose) => providerServer.close(() => resolveClose()))
    if (existsSync(sandbox)) rmSync(sandbox, { recursive: true, force: true })
    if (!succeeded) process.stderr.write(`Failure artifacts: ${artifactDir}\n`)
  }
}

const command = process.argv[2] || 'run'
if (command === 'mcp') {
  runMCPFixture(process.argv[3])
} else if (command === 'validate') {
  validateOverlay()
  process.stdout.write('full-access installed boundary preflight passed\n')
} else if (command === 'run') {
  await runInstalledBoundary()
} else {
  fail(`unknown command: ${command}`)
}
