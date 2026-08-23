#!/usr/bin/env node

/**
 * 未解决 bug-2 中无需原生 UI 点击的 Test.app 真实 API 边界。
 *
 * 只使用现有 HexClaw Test.app、固定回环端口、临时 HOME/YAML/SQLite 与本地 fake upstream。
 * 不访问用户 HOME、/Applications、真实 Provider、外部模型或 IM。
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
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const nativeDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(nativeDir, '../..')
const appBundle = resolve(
  process.env.HEXCLAW_TEST_APP ||
    join(repoRoot, 'src-tauri/target/release/bundle/macos/HexClaw Test.app'),
)
const appExecutable = join(appBundle, 'Contents/MacOS/hexclaw-desktop')
const sidecarExecutable = join(appBundle, 'Contents/MacOS/hexclaw')
const sidecarPort = 16061
const fixturePort = 16062
const fixtureOrigin = `http://127.0.0.1:${fixturePort}`
const apiOrigin = `http://127.0.0.1:${sidecarPort}`
const apiToken = 'installed-api-boundary-token'
const providerKey = 'fixture'
const providerID = 'pvd_v1_11111111111111111111111111111111'
const providerAPIKey = 'installed-api-fixture-key'
const fixtureModel = 'fixture-model'
const customModel = 'fixture-custom-model'
const ollamaModel = 'isolated-delete-model:latest'
const evidenceBase = join(repoRoot, 'test/evidence/bug-ledger-installed-api-boundaries')
const runName = new Date().toISOString().replaceAll(':', '').replaceAll('.', '-')
const evidenceRoot = join(evidenceBase, runName)
const commandTimeoutMs = 10 * 60 * 1000
const sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds))

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
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

async function waitForExit(child, timeoutMs = 10_000) {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise((resolveExit) => {
    const timer = setTimeout(resolveExit, timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolveExit()
    })
  })
}

async function waitForPortRelease(port, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (listenerPIDs(port).length === 0) return true
    await sleep(100)
  }
  return listenerPIDs(port).length === 0
}

async function stopOwnedSidecar() {
  const stopped = []
  const unexpected = []
  for (const pid of listenerPIDs(sidecarPort)) {
    const command = processCommand(pid)
    if (!command.includes(sidecarExecutable)) {
      unexpected.push({ pid, command })
      continue
    }
    process.kill(pid, 'SIGTERM')
    const deadline = Date.now() + 5_000
    while (processExists(pid) && Date.now() < deadline) await sleep(100)
    if (processExists(pid)) process.kill(pid, 'SIGKILL')
    stopped.push(pid)
  }
  return { stopped, unexpected, released: await waitForPortRelease(sidecarPort) }
}

function jsonResponse(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'Content-Length': Buffer.byteLength(body),
    'Content-Type': 'application/json; charset=utf-8',
  })
  response.end(body)
}

async function readJSONBody(request) {
  const chunks = []
  let length = 0
  for await (const chunk of request) {
    length += chunk.length
    if (length > 10 * 1024 * 1024) throw new Error('Fixture request exceeds 10 MiB')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

function canonicalModel(name) {
  return String(name).includes(':') ? String(name).toLowerCase() : `${String(name).toLowerCase()}:latest`
}

function createLoopbackFixture() {
  const state = {
    catalogCount: 10,
    providerRequests: [],
    ollamaRequests: [],
    ollamaModels: new Set([
      ollamaModel,
      'isolated-unload-model:latest',
      'isolated-failed-delete:latest',
      'isolated-ambiguous-delete:latest',
    ]),
    unloadStatus: 200,
    deleteBehavior: 'success',
    persistedBeforeDelete: [],
    unexpected: [],
  }
  let configPath = ''

  const server = createServer(async (request, response) => {
    const url = new URL(request.url || '/', fixtureOrigin)
    try {
      if (request.method === 'GET' && url.pathname === '/v1/models') {
        const models = Array.from({ length: state.catalogCount }, (_, index) => ({
          id: `catalog-${String(index + 1).padStart(2, '0')}`,
          name: `Catalog ${index + 1}`,
          object: 'model',
        }))
        state.providerRequests.push({ kind: 'models', count: models.length })
        jsonResponse(response, 200, { object: 'list', data: models })
        return
      }

      if (request.method === 'GET' && url.pathname === '/models') {
        state.providerRequests.push({ kind: 'models-root', count: 1 })
        jsonResponse(response, 200, { data: [{ id: ollamaModel, name: ollamaModel }] })
        return
      }

      if (request.method === 'GET' && url.pathname === '/__hexclaw_test_updater__') {
        response.writeHead(204)
        response.end()
        return
      }

      if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
        const payload = await readJSONBody(request)
        const stream = payload.stream === true
        state.providerRequests.push({
          kind: stream ? 'chat-stream' : 'probe',
          model: payload.model,
          stream,
        })
        if (stream) {
          response.writeHead(200, {
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'Content-Type': 'text/event-stream; charset=utf-8',
          })
          response.write(
            `data: ${JSON.stringify({
              id: 'chatcmpl-installed-api',
              object: 'chat.completion.chunk',
              created: 0,
              model: fixtureModel,
              choices: [
                { index: 0, delta: { role: 'assistant', content: 'loopback websocket reply' }, finish_reason: null },
              ],
            })}\n\n`,
          )
          response.write(
            `data: ${JSON.stringify({
              id: 'chatcmpl-installed-api',
              object: 'chat.completion.chunk',
              created: 0,
              model: fixtureModel,
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            })}\n\n`,
          )
          response.end('data: [DONE]\n\n')
          return
        }
        jsonResponse(response, 200, {
          id: 'chatcmpl-installed-probe',
          object: 'chat.completion',
          created: 0,
          model: fixtureModel,
          choices: [
            { index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
        return
      }

      if (request.method === 'POST' && url.pathname === '/v1/embeddings') {
        const payload = await readJSONBody(request)
        state.ollamaRequests.push({ method: 'POST', path: url.pathname, model: payload.model })
        jsonResponse(response, 200, {
          object: 'list',
          model: payload.model,
          data: [{ object: 'embedding', index: 0, embedding: [1, 0, 0, 0] }],
          usage: { prompt_tokens: 1, total_tokens: 1 },
        })
        return
      }

      if (request.method === 'POST' && url.pathname === '/api/embed') {
        const payload = await readJSONBody(request)
        state.ollamaRequests.push({ method: 'POST', path: url.pathname, model: payload.model })
        jsonResponse(response, 200, { model: payload.model, embeddings: [[1, 0, 0, 0]] })
        return
      }

      if (request.method === 'GET' && url.pathname === '/api/version') {
        state.ollamaRequests.push({ method: 'GET', path: url.pathname })
        jsonResponse(response, 200, { version: '0.0.0-isolated' })
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/tags') {
        state.ollamaRequests.push({ method: 'GET', path: url.pathname })
        jsonResponse(response, 200, {
          models: [...state.ollamaModels].map((name) => ({
            name,
            model: name,
            size: 1,
            modified_at: '2026-08-22T00:00:00Z',
            details: { parameter_size: 'isolated', quantization_level: 'none' },
          })),
        })
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/ps') {
        state.ollamaRequests.push({ method: 'GET', path: url.pathname })
        jsonResponse(response, 200, { models: [] })
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/generate') {
        const payload = await readJSONBody(request)
        state.ollamaRequests.push({ method: 'POST', path: url.pathname, model: payload.model })
        if (state.unloadStatus >= 200 && state.unloadStatus < 300) {
          jsonResponse(response, state.unloadStatus, { done: true })
        } else {
          jsonResponse(response, state.unloadStatus, { error: 'isolated unload failure' })
        }
        return
      }
      if (request.method === 'DELETE' && url.pathname === '/api/delete') {
        const payload = await readJSONBody(request)
        const model = canonicalModel(payload.model)
        const config = configPath && existsSync(configPath) ? readFileSync(configPath, 'utf8') : ''
        state.persistedBeforeDelete.push({
          model,
          disableAutoInstall: /disable_auto_install:\s*true/.test(config),
        })
        state.ollamaRequests.push({
          method: 'DELETE',
          path: url.pathname,
          model,
          behavior: state.deleteBehavior,
        })
        if (state.deleteBehavior === 'failure') {
          jsonResponse(response, 409, { error: 'isolated delete failure' })
          return
        }
        state.ollamaModels.delete(model)
        if (state.deleteBehavior === 'disconnect') {
          request.socket.destroy()
          return
        }
        jsonResponse(response, 200, { status: 'success' })
        return
      }

      state.unexpected.push(`${request.method} ${url.pathname}`)
      jsonResponse(response, 404, { error: 'unexpected fixture request' })
    } catch (error) {
      state.unexpected.push(`fixture-error:${error instanceof Error ? error.message : String(error)}`)
      if (!response.headersSent) jsonResponse(response, 500, { error: 'fixture failure' })
      else response.destroy()
    }
  })

  return {
    state,
    setConfigPath(path) {
      configPath = path
    },
    async listen() {
      await new Promise((resolveListen, rejectListen) => {
        server.once('error', rejectListen)
        server.listen(fixturePort, '127.0.0.1', resolveListen)
      })
    },
    async close() {
      if (!server.listening) return
      await new Promise((resolveClose) => server.close(resolveClose))
    },
  }
}

function renderConfig(sandbox) {
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
      display_name: Isolated Fixture
      api_key: ${providerAPIKey}
      base_url: ${fixtureOrigin}/v1
      model: ${fixtureModel}
      models:
        - ${fixtureModel}
        - ${customModel}
      model_specs_mode: explicit
      model_specs:
        - id: ${fixtureModel}
          display_name: Fixture Model
          capabilities:
            - text
        - id: ${customModel}
          display_name: Fixture Custom Model
          is_custom: true
          capabilities:
            - text
      compatible: openai
      locality: local
      tools_enabled: false
      enabled: true
    isolated-ollama:
      provider_instance_id: pvd_v1_22222222222222222222222222222222
      display_name: Isolated Ollama
      api_key: ""
      base_url: ${fixtureOrigin}
      model: ${ollamaModel}
      models:
        - ${ollamaModel}
      model_specs_mode: explicit
      model_specs:
        - id: ${ollamaModel}
          display_name: Isolated Ollama Model
          capabilities:
            - text
            - embedding
          embedding:
            protocol: ollama_embeddings
            dimension: 4
            normalization: l2
      compatible: ollama
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
  enabled: true
  embedding:
    provider: isolated-ollama
    model: ${ollamaModel}
    disable_auto_install: false
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

function appEnvironment(sandbox) {
  const tempDir = join(sandbox, 'tmp')
  return {
    PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: sandbox,
    USERPROFILE: sandbox,
    CFFIXED_USER_HOME: sandbox,
    TMPDIR: tempDir,
    TEMP: tempDir,
    TMP: tempDir,
    HEXCLAW_TEST_MODE: '1',
    HEXCLAW_TEST_HOME: sandbox,
    HEXCLAW_SIDECAR_PORT: String(sidecarPort),
    HEXCLAW_TEST_LLM_CONFIG_MODE: 'preseeded-owner-yaml',
    HEXCLAW_TEST_PROFILE_CATCHUP: '0',
    NO_PROXY: '*',
    no_proxy: '*',
  }
}

async function waitForHealth(appProcess, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (appProcess.exitCode !== null || appProcess.signalCode !== null) {
      throw new Error(`Test.app exited before health: ${appProcess.exitCode ?? appProcess.signalCode}`)
    }
    try {
      const response = await fetch(`${apiOrigin}/health`, { signal: AbortSignal.timeout(1_000) })
      if (response.ok) return
    } catch {
      // 启动窗口内连接拒绝属于预期轮询状态。
    }
    await sleep(150)
  }
  throw new Error('Timed out waiting for Test.app Sidecar health')
}

async function api(path, options = {}) {
  const response = await fetch(`${apiOrigin}${path}`, {
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
    `${options.method || 'GET'} ${path} status=${response.status}, expected=${expected.join(',')}`,
  )
  return { status: response.status, data }
}

function providerFromConfig(config) {
  const provider = config?.providers?.[providerKey]
  assert.ok(provider, 'Fixture provider is missing from LLM config')
  return provider
}

function customSpec(provider) {
  return (provider.model_specs || []).find((model) => model.id === customModel)
}

function metadataObject(message) {
  const value = message?.metadata
  if (typeof value === 'string') return JSON.parse(value || '{}')
  return value || {}
}

async function websocketChat(sessionID) {
  const frames = []
  const requestID = `req-installed-api-websocket-${sessionID}`
  const ws = new WebSocket(`ws://127.0.0.1:${sidecarPort}/ws`, {
    headers: {
      Authorization: `Bearer ${apiToken}`,
      Origin: 'http://localhost',
    },
  })
  try {
    await new Promise((resolveOpen, rejectOpen) => {
      const timer = setTimeout(() => rejectOpen(new Error('WebSocket open timed out')), 10_000)
      ws.once('open', () => {
        clearTimeout(timer)
        resolveOpen()
      })
      ws.once('error', (error) => {
        clearTimeout(timer)
        rejectOpen(error)
      })
    })
    ws.send(
      JSON.stringify({
        type: 'message',
        content: 'route exactly one isolated websocket chat',
        request_id: requestID,
        session_id: sessionID,
        user_id: 'api-user',
        provider: providerKey,
        model: fixtureModel,
      }),
    )
    const terminal = await new Promise((resolveTerminal, rejectTerminal) => {
      const timer = setTimeout(() => rejectTerminal(new Error('WebSocket reply timed out')), 30_000)
      ws.on('message', (raw) => {
        const frame = JSON.parse(raw.toString())
        frames.push(frame)
        if (frame.request_id && frame.request_id !== requestID) return
        if (frame.type === 'error') {
          clearTimeout(timer)
          rejectTerminal(new Error(`WebSocket returned an error: ${frame.content || 'unknown'}`))
        } else if (frame.type === 'reply' || (frame.type === 'chunk' && frame.done === true)) {
          clearTimeout(timer)
          resolveTerminal(frame)
        }
      })
      ws.once('error', (error) => {
        clearTimeout(timer)
        rejectTerminal(error)
      })
    })
    return { frames, terminal }
  } finally {
    ws.close()
  }
}

function sanitize(value, sandbox) {
  return String(value)
    .replaceAll(providerAPIKey, '<fixture-api-key>')
    .replaceAll(apiToken, '<test-api-token>')
    .replaceAll(sandbox, '<test-home>')
    .replaceAll(appBundle, '<test-app>')
    .replaceAll(process.env.HOME || '<no-real-home>', '<real-home>')
}

async function main() {
  assert.ok(existsSync(appExecutable), `Test.app executable is missing: ${appExecutable}`)
  assert.ok(existsSync(sidecarExecutable), `Test.app Sidecar is missing: ${sidecarExecutable}`)
  assert.deepEqual(listenerPIDs(sidecarPort), [], `Sidecar port ${sidecarPort} is occupied`)
  assert.deepEqual(listenerPIDs(fixturePort), [], `Fixture port ${fixturePort} is occupied`)

  mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 })
  const sandbox = mkdtempSync(join(tmpdir(), 'hexclaw-installed-api.'))
  const configDir = join(sandbox, '.hexclaw')
  const tempDir = join(sandbox, 'tmp')
  mkdirSync(configDir, { recursive: true, mode: 0o700 })
  mkdirSync(tempDir, { recursive: true, mode: 0o700 })
  chmodSync(sandbox, 0o700)
  chmodSync(configDir, 0o700)
  chmodSync(tempDir, 0o700)
  const configPath = join(configDir, 'hexclaw.yaml')
  const databasePath = join(configDir, 'data.db')
  writeFileSync(configPath, renderConfig(sandbox), { mode: 0o600 })
  chmodSync(configPath, 0o600)

  const rawLogPath = join(sandbox, 'app.raw.log')
  const rawLog = createWriteStream(rawLogPath, { flags: 'a', mode: 0o600 })
  const fixture = createLoopbackFixture()
  fixture.setConfigPath(configPath)
  const generations = []
  const scenarios = {}
  const cleanup = {
    appPIDs: [],
    sidecarPIDs: [],
    unexpectedPortOwners: [],
    sidecarPortReleased: false,
    fixturePortReleased: false,
  }
  let currentApp = null
  let failure = null

  const startGeneration = async (name) => {
    assert.deepEqual(listenerPIDs(sidecarPort), [], `Sidecar port is occupied before ${name}`)
    const child = spawn(appExecutable, [], {
      cwd: dirname(appExecutable),
      env: appEnvironment(sandbox),
      stdio: ['ignore', rawLog, rawLog],
    })
    currentApp = child
    await waitForHealth(child)
    const sidecarPIDs = listenerPIDs(sidecarPort)
    assert.equal(sidecarPIDs.length, 1, `${name} must own exactly one Sidecar listener`)
    const command = processCommand(sidecarPIDs[0])
    assert.ok(command.includes(sidecarExecutable), `${name} Sidecar listener is not packaged Test.app binary`)
    const generation = { name, appPID: child.pid, sidecarPID: sidecarPIDs[0] }
    generations.push(generation)
    return generation
  }

  const stopGeneration = async () => {
    if (currentApp && processExists(currentApp.pid)) {
      cleanup.appPIDs.push(currentApp.pid)
      currentApp.kill('SIGTERM')
      await waitForExit(currentApp, 8_000)
      if (processExists(currentApp.pid)) currentApp.kill('SIGKILL')
    }
    currentApp = null
    const stopped = await stopOwnedSidecar()
    cleanup.sidecarPIDs.push(...stopped.stopped)
    cleanup.unexpectedPortOwners.push(...stopped.unexpected)
    assert.deepEqual(stopped.unexpected, [], 'Sidecar port has an unexpected owner')
    assert.equal(stopped.released, true, 'Sidecar port was not released')
  }

  try {
    await new Promise((resolveOpen, rejectOpen) => {
      if (rawLog.fd !== null) {
        resolveOpen()
        return
      }
      rawLog.once('open', resolveOpen)
      rawLog.once('error', rejectOpen)
    })
    await fixture.listen()
    await startGeneration('initial')

    // BUG-20260723-018：空分支、错误分支与单子分支使用同一公开 API。
    await api('/api/v1/sessions', {
      method: 'POST',
      expected: [201],
      body: { id: 'branch-parent', title: 'Branch parent', user_id: 'api-user' },
    })
    await api('/api/v1/sessions/branch-parent/messages', {
      method: 'POST',
      expected: [201],
      body: { id: 'branch-message', role: 'user', content: 'branch source', user_id: 'api-user' },
    })
    const emptyBranches = await api('/api/v1/sessions/branch-parent/branches?user_id=api-user')
    assert.deepEqual(emptyBranches.data.branches, [])
    assert.equal(emptyBranches.data.total, 0)
    const missingBranches = await api('/api/v1/sessions/missing-session/branches?user_id=api-user', {
      expected: [404],
    })
    assert.equal(typeof missingBranches.data.error, 'string')
    const fork = await api('/api/v1/sessions/branch-parent/fork', {
      method: 'POST',
      body: { message_id: 'branch-message', include_message: true, user_id: 'api-user' },
    })
    const oneBranch = await api('/api/v1/sessions/branch-parent/branches?user_id=api-user')
    assert.equal(oneBranch.data.total, 1)
    assert.equal(oneBranch.data.branches.length, 1)
    assert.equal(oneBranch.data.branches[0].id, fork.data.session.id)
    const branchChildSessionID = fork.data.session.id
    const parentHistoryBeforeWebSocket = await api(
      '/api/v1/sessions/branch-parent/messages?user_id=api-user&limit=20&offset=0',
    )
    const parentMessageIDsBeforeWebSocket = new Set(
      parentHistoryBeforeWebSocket.data.messages.map((message) => message.id),
    )
    await websocketChat('branch-parent')
    const parentHistoryAfterWebSocket = await api(
      '/api/v1/sessions/branch-parent/messages?user_id=api-user&limit=20&offset=0',
    )
    const parentWebSocketUserMessages = parentHistoryAfterWebSocket.data.messages.filter(
      (message) => message.role === 'user' && !parentMessageIDsBeforeWebSocket.has(message.id),
    )
    assert.equal(parentWebSocketUserMessages.length, 1)
    assert.equal(parentWebSocketUserMessages[0].session_id, 'branch-parent')
    const branchParentWebSocketMessageID = parentWebSocketUserMessages[0].id
    const branchChildHTTPMessageID = 'branch-child-http-message'
    await api(`/api/v1/sessions/${encodeURIComponent(branchChildSessionID)}/messages`, {
      method: 'POST',
      expected: [201],
      body: {
        id: branchChildHTTPMessageID,
        role: 'user',
        content: 'branch child HTTP message',
        user_id: 'api-user',
      },
    })

    // BUG-20260723-022：真实 Sidecar 不得在 UI 的 10/11 阈值处篡改上游目录事实。
    const catalogFacts = []
    for (const count of [10, 11]) {
      fixture.state.catalogCount = count
      const result = await api('/api/v1/config/llm/models', {
        method: 'POST',
        body: { base_url: `${fixtureOrigin}/v1`, api_key: providerAPIKey, locality: 'local' },
      })
      assert.equal(result.data.models.length, count)
      assert.equal(result.data.models.at(-1).id, `catalog-${String(count).padStart(2, '0')}`)
      catalogFacts.push({ upstream: count, sidecar: result.data.models.length })
    }
    scenarios['BUG-20260723-022'] = { status: 'PASS', facts: catalogFacts }

    // BUG-20260723-023：GET→PUT→GET 保持 is_custom；删除后由重启边界复核。
    const initialConfig = (await api('/api/v1/config/llm')).data
    assert.equal(customSpec(providerFromConfig(initialConfig))?.is_custom, true)
    await api('/api/v1/config/llm', { method: 'PUT', body: initialConfig })
    const roundTripConfig = (await api('/api/v1/config/llm')).data
    assert.equal(customSpec(providerFromConfig(roundTripConfig))?.is_custom, true)

    // BUG-20260723-030：同一已保存 Provider 先 probe，再只路由一次真实 WebSocket chat。
    await api('/api/v1/sessions', {
      method: 'POST',
      expected: [201],
      body: { id: 'websocket-route', title: 'WebSocket route', user_id: 'api-user' },
    })
    const providerBeforeProbe = fixture.state.providerRequests.length
    const probe = await api('/api/v1/config/llm/test', {
      method: 'POST',
      body: {
        provider: {
          type: 'custom',
          provider_instance_id: providerID,
          base_url: `${fixtureOrigin}/v1`,
          api_key: providerAPIKey,
          model: fixtureModel,
          locality: 'local',
        },
      },
    })
    assert.equal(probe.data.persisted, true)
    const probeCalls = fixture.state.providerRequests.slice(providerBeforeProbe)
    assert.deepEqual(probeCalls.map((event) => event.kind), ['probe'])
    const beforeWebSocket = fixture.state.providerRequests.length
    const websocket = await websocketChat('websocket-route')
    const websocketCalls = fixture.state.providerRequests.slice(beforeWebSocket)
    const websocketChatCalls = websocketCalls.filter((event) => event.kind === 'chat-stream')
    const websocketCatalogCalls = websocketCalls
      .filter((event) => event.kind === 'models' || event.kind === 'models-root')
      .map((event) => event.kind)
    assert.equal(websocketChatCalls.length, 1)
    assert.equal(websocketChatCalls[0].model, fixtureModel)
    assert.ok(websocket.frames.some((frame) => frame.type === 'chunk' && frame.done === true))
    let websocketHistory
    for (let attempt = 0; attempt < 20; attempt += 1) {
      websocketHistory = await api(
        '/api/v1/sessions/websocket-route/messages?user_id=api-user&limit=20&offset=0',
      )
      if (websocketHistory.data.total === 2) break
      await sleep(100)
    }
    assert.equal(websocketHistory.data.total, 2)
    assert.equal(websocketHistory.data.messages.filter((message) => message.role === 'user').length, 1)
    assert.equal(
      websocketHistory.data.messages.filter((message) => message.role === 'assistant').length,
      1,
    )
    scenarios['BUG-20260723-030'] = {
      status: 'PASS',
      facts: {
        probeCalls: 1,
        websocketChatCalls: websocketChatCalls.length,
        backgroundCatalogCalls: websocketCatalogCalls,
        persistedSessionMessages: websocketHistory.data.total,
        persistedRoles: ['user', 'assistant'],
        providerOrigin: fixtureOrigin,
      },
    }

    // BUG-20260726-001：70 KiB 附件、分页、总数与重启恢复。
    await api('/api/v1/sessions', {
      method: 'POST',
      expected: [201],
      body: { id: 'large-history', title: 'Large history', user_id: 'api-user' },
    })
    const imageData = `data:image/png;base64,${'A'.repeat(70 * 1024)}`
    const historyMessages = [
      {
        id: 'history-large',
        role: 'user',
        content: '',
        metadata: {
          attachments: [
            { type: 'image', name: 'isolated-70k.png', mime: 'image/png', data: imageData },
          ],
        },
      },
      { id: 'history-2', role: 'assistant', content: 'second' },
      { id: 'history-3', role: 'user', content: 'third' },
      { id: 'history-4', role: 'assistant', content: 'fourth' },
    ]
    await api('/api/v1/sessions/large-history/messages/batch?user_id=api-user', {
      method: 'POST',
      expected: [201],
      body: { messages: historyMessages },
    })
    const historyPage1 = await api(
      '/api/v1/sessions/large-history/messages?user_id=api-user&limit=2&offset=0',
    )
    const historyPage2 = await api(
      '/api/v1/sessions/large-history/messages?user_id=api-user&limit=2&offset=2',
    )
    assert.equal(historyPage1.data.total, 4)
    assert.equal(historyPage2.data.total, 4)
    assert.equal(historyPage1.data.messages.length, 2)
    assert.equal(historyPage2.data.messages.length, 2)
    const beforeRestartMessages = [...historyPage1.data.messages, ...historyPage2.data.messages]
    const largeBeforeRestart = beforeRestartMessages.find((message) => message.id === 'history-large')
    assert.equal(metadataObject(largeBeforeRestart).attachments[0].data, imageData)
    const historySession = await api('/api/v1/sessions/large-history?user_id=api-user')
    assert.equal(historySession.data.message_count, 4)

    // K12 recoverable session：只走公开资产/图片任务/恢复投影 API，parent-selected artwork 不调用模型。
    const k12Agent = 'installed-api-k12'
    const k12Session = 'installed-api-k12-session'
    const k12ProviderCallsBefore = fixture.state.providerRequests.length
    await api('/api/v1/agents', {
      method: 'POST',
      body: {
        name: k12Agent,
        display_name: 'Installed API K12',
        description: 'Isolated installed-app boundary fixture.',
        model: '',
        provider: '',
        system_prompt: 'Use only the isolated boundary fixture.',
        skills: [],
        metadata: {
          scenario: 'k12-tutor',
          'k12.learner_id': 'learner-installed-api-k12',
          'k12.child_name': 'Boundary',
          'k12.grade_term': '六年级上',
          'k12.textbook_edition': '人教版',
        },
      },
    })
    const k12Asset = await api('/api/k12/assets', {
      method: 'POST',
      body: {
        agent: k12Agent,
        data_base64:
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      },
    })
    const k12Create = await api('/api/k12/image-tasks', {
      method: 'POST',
      body: {
        agent: k12Agent,
        source_session: k12Session,
        source_kind: 'desktop',
        source_ref: 'installed-api-k12-message',
        source_asset_refs: [k12Asset.data.asset_id],
        message_intent: 'Archive this artwork.',
        attempt_generation: 1,
        route_request: {
          provider: providerID,
          model: fixtureModel,
          selection_source: 'explicit',
        },
        creative_entry: { kind: 'new_work', task_intent: 'artwork' },
      },
    })
    const k12DispatchID = k12Create.data.dispatch.dispatch_id
    const k12RecoverableBeforeRestart = await api(
      `/api/k12/image-tasks/recoverable?agent=${encodeURIComponent(k12Agent)}&session=${encodeURIComponent(k12Session)}`,
    )
    assert.equal(k12RecoverableBeforeRestart.data.items.length, 1)
    assert.equal(k12RecoverableBeforeRestart.data.items[0].dispatch_id, k12DispatchID)
    assert.equal(k12RecoverableBeforeRestart.data.items[0].source_session_id, k12Session)
    assert.equal(fixture.state.providerRequests.length, k12ProviderCallsBefore)

    // BUG-20260728-011：重复 GET 表示设置重进；Test.app 重启后复核同一持久化回执。
    const receiptBeforeRestart = providerFromConfig((await api('/api/v1/config/llm')).data).probe_receipt
    const receiptOnReentry = providerFromConfig((await api('/api/v1/config/llm')).data).probe_receipt
    assert.equal(receiptBeforeRestart.outcome, 'passed')
    assert.deepEqual(receiptOnReentry, receiptBeforeRestart)

    await stopGeneration()
    await startGeneration('restart-persistence')

    let configAfterRestart
    let providerAfterRestart
    for (let attempt = 0; attempt < 20; attempt += 1) {
      configAfterRestart = (await api('/api/v1/config/llm')).data
      providerAfterRestart = providerFromConfig(configAfterRestart)
      if (providerAfterRestart.probe_receipt?.outcome === 'passed') break
      await sleep(100)
    }
    assert.equal(customSpec(providerAfterRestart)?.is_custom, true)
    assert.equal(providerAfterRestart.probe_receipt?.outcome, 'passed')
    assert.equal(providerAfterRestart.probe_receipt?.provider_instance_id, providerID)
    const parentBranchHistoryAfterRestart = await api(
      '/api/v1/sessions/branch-parent/messages?user_id=api-user&limit=20&offset=0',
    )
    const childBranchHistoryAfterRestart = await api(
      `/api/v1/sessions/${encodeURIComponent(branchChildSessionID)}/messages?user_id=api-user&limit=20&offset=0`,
    )
    const restartedParentWebSocketMessages = parentBranchHistoryAfterRestart.data.messages.filter(
      (message) => message.id === branchParentWebSocketMessageID,
    )
    const restartedChildHTTPMessages = childBranchHistoryAfterRestart.data.messages.filter(
      (message) => message.id === branchChildHTTPMessageID,
    )
    assert.equal(restartedParentWebSocketMessages.length, 1)
    assert.equal(restartedParentWebSocketMessages[0].session_id, 'branch-parent')
    assert.equal(restartedChildHTTPMessages.length, 1)
    assert.equal(restartedChildHTTPMessages[0].session_id, branchChildSessionID)
    assert.equal(
      childBranchHistoryAfterRestart.data.messages.filter(
        (message) => message.id === branchParentWebSocketMessageID,
      ).length,
      0,
    )
    assert.equal(
      parentBranchHistoryAfterRestart.data.messages.filter(
        (message) => message.id === branchChildHTTPMessageID,
      ).length,
      0,
    )
    scenarios['BUG-20260723-018'] = {
      status: 'PASS',
      facts: {
        emptyTotal: 0,
        missingStatus: 404,
        oneChildTotal: 1,
        parentTransport: 'WebSocket',
        childTransport: 'HTTP',
        parentMessageOccurrencesAfterRestart: restartedParentWebSocketMessages.length,
        childMessageOccurrencesAfterRestart: restartedChildHTTPMessages.length,
        parentSessionID: restartedParentWebSocketMessages[0].session_id,
        childSessionID: restartedChildHTTPMessages[0].session_id,
        crossSessionOccurrences: 0,
      },
    }
    const historyAfterRestart = await api(
      '/api/v1/sessions/large-history/messages?user_id=api-user&limit=200&offset=0',
    )
    assert.equal(historyAfterRestart.data.total, 4)
    const largeAfterRestart = historyAfterRestart.data.messages.find(
      (message) => message.id === 'history-large',
    )
    assert.equal(metadataObject(largeAfterRestart).attachments[0].data, imageData)
    const k12RecoverableAfterRestart = await api(
      `/api/k12/image-tasks/recoverable?agent=${encodeURIComponent(k12Agent)}&session=${encodeURIComponent(k12Session)}`,
    )
    assert.deepEqual(k12RecoverableAfterRestart.data.items, k12RecoverableBeforeRestart.data.items)
    assert.equal(k12RecoverableAfterRestart.data.items[0].dispatch_id, k12DispatchID)
    const k12RestartFixtureCalls = fixture.state.providerRequests.slice(k12ProviderCallsBefore)
    const k12RestartChatCalls = k12RestartFixtureCalls.filter(
      (event) => event.kind === 'chat-stream',
    )
    const k12RestartCatalogCalls = k12RestartFixtureCalls
      .filter((event) => event.kind === 'models' || event.kind === 'models-root')
      .map((event) => event.kind)
    assert.equal(k12RestartChatCalls.length, 1)
    scenarios['K12-recoverable-session'] = {
      status: 'PASS',
      facts: {
        publicCreateAPIs: [
          'POST /api/v1/agents',
          'POST /api/k12/assets',
          'POST /api/k12/image-tasks',
        ],
        publicRecoveryAPI: 'GET /api/k12/image-tasks/recoverable',
        sourceSessionID: k12Session,
        dispatchID: k12DispatchID,
        restartProjectionIdentical: true,
        imageTaskProviderCallsBeforeRestart: 0,
        testAppRestartWarmupCalls: k12RestartChatCalls.length,
        backgroundCatalogCalls: k12RestartCatalogCalls,
      },
    }

    await api('/api/v1/messages/history-2?user_id=api-user', { method: 'DELETE' })
    const historyAfterDelete = await api(
      '/api/v1/sessions/large-history/messages?user_id=api-user&limit=200&offset=0',
    )
    const sessionAfterDelete = await api('/api/v1/sessions/large-history?user_id=api-user')
    assert.equal(historyAfterDelete.data.total, 3)
    assert.equal(sessionAfterDelete.data.message_count, 3)
    scenarios['BUG-20260726-001'] = {
      status: 'PASS',
      facts: {
        attachmentDataLength: imageData.length,
        pageSizes: [2, 2],
        restartTotal: 4,
        afterDeleteTotal: 3,
        afterDeleteSessionCount: 3,
      },
    }

    const invalidatedConfig = (await api('/api/v1/config/llm')).data
    providerFromConfig(invalidatedConfig).base_url = `${fixtureOrigin}/changed/v1`
    await api('/api/v1/config/llm', { method: 'PUT', body: invalidatedConfig })
    const invalidatedProvider = providerFromConfig((await api('/api/v1/config/llm')).data)
    assert.equal(invalidatedProvider.probe_receipt, undefined)
    scenarios['BUG-20260728-011'] = {
      status: 'PASS',
      facts: {
        apiReentryReceipt: 'passed',
        testAppRestartReceipt: 'passed',
        connectionFieldInvalidation: 'receipt omitted',
        sidecarOnlyRestart: {
          status: 'SKIP',
          reason: 'Test.app exposes restart_sidecar only as a Tauri command; no HTTP or WebSocket restart API exists.',
        },
      },
    }

    const deleteCustomConfig = (await api('/api/v1/config/llm')).data
    const providerForDelete = providerFromConfig(deleteCustomConfig)
    providerForDelete.base_url = `${fixtureOrigin}/v1`
    providerForDelete.models = (providerForDelete.models || []).filter((model) => model !== customModel)
    providerForDelete.model_specs = (providerForDelete.model_specs || []).filter(
      (model) => model.id !== customModel,
    )
    await api('/api/v1/config/llm', { method: 'PUT', body: deleteCustomConfig })
    await stopGeneration()
    await startGeneration('restart-custom-deletion')
    const customAfterDeleteRestart = customSpec(providerFromConfig((await api('/api/v1/config/llm')).data))
    assert.equal(customAfterDeleteRestart, undefined)
    scenarios['BUG-20260723-023'] = {
      status: 'PASS',
      facts: { roundTripIsCustom: true, deletedAfterRestart: true },
    }

    // BUG-20260728-015：2xx 与 non-2xx 卸载事实均来自隔离 fake Ollama。
    const unloadModel = 'isolated-unload-model:latest'
    let unloadModelReady = false
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const status = await api('/api/v1/ollama/status')
      unloadModelReady = (status.data.models || []).some(
        (model) => canonicalModel(model.name) === canonicalModel(unloadModel),
      )
      if (unloadModelReady) break
      await sleep(100)
    }
    assert.equal(unloadModelReady, true)
    const unloadDeleteCallsBefore = fixture.state.ollamaRequests.filter(
      (event) => event.method === 'DELETE',
    ).length
    fixture.state.unloadStatus = 200
    const unloadSuccess = await api('/api/v1/ollama/unload', {
      method: 'POST',
      body: { model: unloadModel },
    })
    fixture.state.unloadStatus = 503
    const unloadFailure = await api('/api/v1/ollama/unload', {
      method: 'POST',
      expected: [503],
      body: { model: unloadModel },
    })
    const unloadDeleteCallsAfter = fixture.state.ollamaRequests.filter(
      (event) => event.method === 'DELETE',
    ).length
    assert.equal(unloadSuccess.data.status, 'unloaded')
    assert.equal(typeof unloadFailure.data.error, 'string')
    assert.equal(unloadDeleteCallsAfter, unloadDeleteCallsBefore)
    scenarios['BUG-20260728-015'] = {
      status: 'PASS',
      facts: { upstream2xx: 200, upstreamNon2xx: 503, deleteCalls: 0 },
    }

    // BUG-20260728-016：删除意图先持久化；成功/失败/断连对账都只作用于隔离模型。
    fixture.state.deleteBehavior = 'success'
    const deleteSuccess = await api(`/api/v1/ollama/models/${encodeURIComponent(ollamaModel)}`, {
      method: 'DELETE',
    })
    assert.equal(deleteSuccess.data.status, 'deleted')
    const persistedDelete = fixture.state.persistedBeforeDelete.find(
      (event) => event.model === canonicalModel(ollamaModel),
    )
    assert.equal(persistedDelete?.disableAutoInstall, true)
    assert.equal(fixture.state.ollamaModels.has(canonicalModel(ollamaModel)), false)

    fixture.state.deleteBehavior = 'failure'
    const failedModel = 'isolated-failed-delete:latest'
    const deleteFailure = await api(`/api/v1/ollama/models/${encodeURIComponent(failedModel)}`, {
      method: 'DELETE',
      expected: [409],
    })
    assert.equal(typeof deleteFailure.data.error, 'string')
    assert.equal(fixture.state.ollamaModels.has(canonicalModel(failedModel)), true)

    fixture.state.deleteBehavior = 'disconnect'
    const ambiguousModel = 'isolated-ambiguous-delete:latest'
    const deleteAmbiguous = await api(
      `/api/v1/ollama/models/${encodeURIComponent(ambiguousModel)}`,
      { method: 'DELETE' },
    )
    assert.equal(deleteAmbiguous.data.status, 'deleted')
    assert.equal(fixture.state.ollamaModels.has(canonicalModel(ambiguousModel)), false)
    const ollamaStatus = await api('/api/v1/ollama/status')
    const visibleModels = (ollamaStatus.data.models || []).map((model) => canonicalModel(model.name))
    assert.equal(visibleModels.includes(canonicalModel(ollamaModel)), false)
    assert.equal(visibleModels.includes(canonicalModel(failedModel)), true)
    assert.equal(visibleModels.includes(canonicalModel(ambiguousModel)), false)
    scenarios['BUG-20260728-016'] = {
      status: 'PASS',
      facts: {
        persistedBeforeDelete: true,
        successfulDeleteAbsent: true,
        failedDeleteStillPresent: true,
        ambiguousDeleteReconciledAbsent: true,
      },
    }

    assert.deepEqual(fixture.state.unexpected, [])
    assert.equal(statSync(configDir).mode & 0o777, 0o700)
    assert.equal(statSync(configPath).mode & 0o777, 0o600)
    assert.ok(existsSync(databasePath), 'Isolated SQLite database was not created')
  } catch (error) {
    failure = error
  } finally {
    try {
      await stopGeneration()
    } catch (cleanupError) {
      failure ||= cleanupError
    }
    try {
      await fixture.close()
    } catch (cleanupError) {
      failure ||= cleanupError
    }
    cleanup.sidecarPortReleased = await waitForPortRelease(sidecarPort)
    cleanup.fixturePortReleased = await waitForPortRelease(fixturePort)
    if (!cleanup.sidecarPortReleased || !cleanup.fixturePortReleased) {
      failure ||= new Error('One or more dedicated ports were not released')
    }
    await new Promise((resolveEnd) => rawLog.end(resolveEnd))

    const sanitizedLog = existsSync(rawLogPath) ? sanitize(readFileSync(rawLogPath, 'utf8'), sandbox) : ''
    writeFileSync(join(evidenceRoot, 'app.log'), sanitizedLog, { mode: 0o600 })
    const summary = {
      status: failure ? 'FAIL' : 'PASS',
      startedAt: runName,
      app: {
        bundle: 'src-tauri/target/release/bundle/macos/HexClaw Test.app',
        executableSHA256: sha256File(appExecutable),
        sidecarSHA256: sha256File(sidecarExecutable),
      },
      isolation: {
        temporaryHome: true,
        temporaryYAML: true,
        temporarySQLite: true,
        sidecarPort,
        fixturePort,
        allowedUpstreamOrigins: [fixtureOrigin],
        realProviderCalls: 0,
        externalModelCalls: 0,
        realIMCalls: 0,
        userHomeTouched: false,
        applicationsTouched: false,
      },
      generations,
      scenarios,
      fixture: {
        providerRequests: fixture.state.providerRequests,
        ollamaRequests: fixture.state.ollamaRequests,
        unexpected: fixture.state.unexpected,
      },
      cleanup,
      failure: failure ? sanitize(failure.stack || failure.message || String(failure), sandbox) : null,
    }
    writeFileSync(join(evidenceRoot, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, {
      mode: 0o600,
    })
    rmSync(sandbox, { recursive: true, force: true })
  }

  if (failure) throw failure
  process.stdout.write(`PASS ${evidenceRoot}\n`)
}

const timeout = setTimeout(() => {
  process.stderr.write('FAIL Installed API boundary script exceeded 10 minutes\n')
  process.exit(124)
}, commandTimeoutMs)
timeout.unref()

main().catch((error) => {
  process.stderr.write(`FAIL ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
