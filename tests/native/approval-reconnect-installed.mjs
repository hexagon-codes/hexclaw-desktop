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
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'

const TEST_SIDECAR_PORT = 16061
const TEST_FIXTURE_PORT = 16062
const TEST_UPDATER_PATH = '/__hexclaw_test_updater__'
const TEST_UPDATER_ENDPOINT = `http://127.0.0.1:${TEST_FIXTURE_PORT}${TEST_UPDATER_PATH}`
const TEST_API_TOKEN = 'hexclaw-installed-approval-reconnect-0123456789abcdef'
const OWNER_MARKER = 'installed-approval-reconnect-owner'
const DECISION_MARKER = 'INSTALLED_APPROVAL_RECONNECT_DECISION_FIXTURE'
const TERMINAL_MARKER = 'INSTALLED_APPROVAL_RECONNECT_TERMINAL_FIXTURE'
const REMEMBER_SEED_MARKER = 'INSTALLED_APPROVAL_RECONNECT_REMEMBER_SEED_FIXTURE'
const REMEMBER_REUSE_MARKER = 'INSTALLED_APPROVAL_RECONNECT_REMEMBER_REUSE_FIXTURE'
const REMEMBER_RESTART_MARKER = 'INSTALLED_APPROVAL_RECONNECT_REMEMBER_RESTART_FIXTURE'
const DELETE_PENDING_MARKER = 'INSTALLED_APPROVAL_RECONNECT_DELETE_PENDING_FIXTURE'
const POLICY_HOT_UPDATE_MARKER = 'INSTALLED_APPROVAL_POLICY_HOT_UPDATE_FIXTURE'
const DECISION_TOOL_CALL_ID = 'call-installed-approval-reconnect-decision'
const TERMINAL_TOOL_CALL_ID = 'call-installed-approval-reconnect-terminal'
const REMEMBER_SEED_TOOL_CALL_ID = 'call-installed-approval-reconnect-remember-seed'
const REMEMBER_REUSE_TOOL_CALL_ID = 'call-installed-approval-reconnect-remember-reuse'
const REMEMBER_RESTART_TOOL_CALL_ID = 'call-installed-approval-reconnect-remember-restart'
const DELETE_PENDING_TOOL_CALL_ID = 'call-installed-approval-reconnect-delete-pending'
const POLICY_HOT_UPDATE_TOOL_CALL_ID = 'call-installed-approval-policy-hot-update'
const FINAL_MARKER = 'INSTALLED_APPROVAL_RECONNECT_NOOP_OK'
const REMEMBERED_SESSION_ID = 'installed-approval-reconnect-remembered'
const WEBSOCKET_OPEN = 1
const APPROVAL_WIRE_TYPES = new Set([
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
  process.env.HEX_NATIVE_APPROVAL_RECONNECT_ARTIFACT_DIR ||
    join(repoRoot, 'test-results/native-approval-reconnect'),
)

function fail(message) {
  throw new Error(message)
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

function yamlString(value) {
  return JSON.stringify(String(value))
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

function validateLoopbackURL(raw, expectedPort, expectedPath) {
  const url = new URL(raw)
  assert.equal(url.protocol, 'http:', `${raw} must use loopback HTTP`)
  assert.equal(url.hostname, '127.0.0.1', `${raw} must use exact 127.0.0.1 host`)
  assert.equal(url.port, String(expectedPort), `${raw} uses an unexpected port`)
  assert.equal(url.pathname, expectedPath, `${raw} uses an unexpected path`)
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

function requireNonEmptyString(value, label) {
  assert.equal(typeof value, 'string', `${label} must be a string`)
  assert.ok(value.trim(), `${label} must be non-empty`)
  return value
}

function identityFromApprovalRequest(wire) {
  assert.equal(wire.type, 'tool_approval_request', 'initial wire must be an approval request')
  return {
    request_id: requireNonEmptyString(wire.request_id, 'request_id'),
    session_id: requireNonEmptyString(wire.session_id, 'session_id'),
    owner_id: requireNonEmptyString(wire.owner_id, 'owner_id'),
    invocation_id: requireNonEmptyString(wire.invocation_id, 'invocation_id'),
    arguments_digest: requireNonEmptyString(wire.arguments_digest, 'arguments_digest'),
    security_scope_digest: requireNonEmptyString(
      wire.security_scope_digest,
      'security_scope_digest',
    ),
    scope_schema_version: Number(wire.scope_schema_version),
    deadline_at: requireNonEmptyString(wire.deadline_at, 'deadline_at'),
  }
}

function assertCompleteIdentity(identity, label) {
  requireNonEmptyString(identity.request_id, `${label}.request_id`)
  requireNonEmptyString(identity.session_id, `${label}.session_id`)
  requireNonEmptyString(identity.owner_id, `${label}.owner_id`)
  requireNonEmptyString(identity.invocation_id, `${label}.invocation_id`)
  requireNonEmptyString(identity.arguments_digest, `${label}.arguments_digest`)
  requireNonEmptyString(identity.security_scope_digest, `${label}.security_scope_digest`)
  assert.ok(
    Number.isSafeInteger(identity.scope_schema_version) && identity.scope_schema_version > 0,
    `${label}.scope_schema_version must be a positive integer`,
  )
  const deadline = Date.parse(identity.deadline_at)
  assert.ok(Number.isFinite(deadline), `${label}.deadline_at must be RFC3339`)
  return identity
}

function assertWireIdentity(wire, identity, label) {
  assertCompleteIdentity(identity, label)
  for (const key of [
    'request_id',
    'session_id',
    'owner_id',
    'invocation_id',
    'arguments_digest',
    'security_scope_digest',
    'deadline_at',
  ]) {
    assert.equal(wire[key], identity[key], `${label}.${key} drifted`)
  }
  assert.equal(
    Number(wire.scope_schema_version),
    identity.scope_schema_version,
    `${label}.scope_schema_version drifted`,
  )
}

function approvalMetadata(identity, extras = {}) {
  return {
    approval_request_id: identity.request_id,
    request_id: identity.request_id,
    session_id: identity.session_id,
    owner_id: identity.owner_id,
    invocation_id: identity.invocation_id,
    arguments_digest: identity.arguments_digest,
    security_scope_digest: identity.security_scope_digest,
    scope_schema_version: String(identity.scope_schema_version),
    deadline_at: identity.deadline_at,
    ...extras,
  }
}

function reconciliationWire(identity) {
  assertCompleteIdentity(identity, 'reconciliation identity')
  return {
    type: 'tool_approval_reconcile',
    ...identity,
    metadata: approvalMetadata(identity),
  }
}

function decisionWire(identity, decision) {
  assertCompleteIdentity(identity, 'decision identity')
  assert.ok(
    ['approved_once', 'approved_remember'].includes(decision.decision),
    'decision must be an approved tool-approval decision',
  )
  requireNonEmptyString(decision.decision_id, 'decision_id')
  requireNonEmptyString(decision.idempotency_key, 'idempotency_key')
  return {
    type: 'tool_approval_response',
    content: decision.decision,
    decision: decision.decision,
    decision_id: decision.decision_id,
    idempotency_key: decision.idempotency_key,
    ...identity,
    metadata: approvalMetadata(identity, {
      decision: decision.decision,
      decision_id: decision.decision_id,
      idempotency_key: decision.idempotency_key,
    }),
  }
}

function assertOutboundFullIdentity(wire, identity, label) {
  assertWireIdentity(wire, identity, label)
  const metadata = wire.metadata || {}
  for (const key of [
    'request_id',
    'session_id',
    'owner_id',
    'invocation_id',
    'arguments_digest',
    'security_scope_digest',
    'deadline_at',
  ]) {
    assert.equal(metadata[key], identity[key], `${label}.metadata.${key} drifted`)
  }
  assert.equal(
    metadata.scope_schema_version,
    String(identity.scope_schema_version),
    `${label}.metadata.scope_schema_version drifted`,
  )
}

function assertDecisionACK(wire, identity, decision, expectedStatus, label) {
  assert.equal(wire.type, 'tool_approval_ack', `${label} must be an approval ACK`)
  assert.equal(wire.status, expectedStatus, `${label}.status drifted`)
  assertWireIdentity(wire, identity, label)
  assert.equal(wire.decision_id, decision.decision_id, `${label}.decision_id drifted`)
  assert.equal(wire.decision, decision.decision, `${label}.decision drifted`)
  assert.equal(wire.idempotency_key, decision.idempotency_key, `${label}.idempotency_key drifted`)
  const metadata = wire.metadata || {}
  assert.equal(metadata.decision_id, decision.decision_id, `${label}.metadata.decision_id drifted`)
  assert.equal(metadata.decision, decision.decision, `${label}.metadata.decision drifted`)
  assert.equal(
    metadata.idempotency_key,
    decision.idempotency_key,
    `${label}.metadata.idempotency_key drifted`,
  )
}

function assertExpiredTerminal(wire, identity) {
  assert.equal(wire.type, 'tool_approval_terminal', 'reconciliation must return a terminal wire')
  assert.equal(wire.terminal_result, 'expired', 'terminal must be backend-expired')
  assertWireIdentity(wire, identity, 'expired terminal')
  assert.equal(wire.decision_id || '', '', 'expired terminal must not expose decision_id')
  assert.equal(wire.decision || '', '', 'expired terminal must not expose decision')
  assert.equal(wire.idempotency_key || '', '', 'expired terminal must not expose idempotency_key')
  const metadata = wire.metadata || {}
  for (const key of ['decision_id', 'decision', 'idempotency_key']) {
    assert.equal(metadata[key], undefined, `expired terminal metadata must not expose ${key}`)
  }
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
            serverInfo: { name: 'approval-reconnect-noop', version: '1.0.0' },
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
      case 'tools/call':
        appendFileSync(
          receiptPath,
          `${JSON.stringify({
            name: request.params?.name,
            arguments: request.params?.arguments || {},
            called_at: new Date().toISOString(),
          })}\n`,
          { encoding: 'utf8' },
        )
        respond({
          jsonrpc: '2.0',
          id: request.id,
          result: {
            content: [{ type: 'text', text: FINAL_MARKER }],
            isError: false,
          },
        })
        break
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

function openAIChunk(id, delta, finishReason = null) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: 1,
    model: 'mock-model',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  }
}

function providerScenario(payload) {
  const latestUserMessage = [...(payload.messages || [])]
    .reverse()
    .find((message) => message?.role === 'user')
  const renderedMessage = JSON.stringify(latestUserMessage || {})
  for (const [scenario, marker] of [
    ['decision', DECISION_MARKER],
    ['terminal', TERMINAL_MARKER],
    ['remember_seed', REMEMBER_SEED_MARKER],
    ['remember_reuse', REMEMBER_REUSE_MARKER],
    ['remember_restart', REMEMBER_RESTART_MARKER],
    ['delete_pending', DELETE_PENDING_MARKER],
    ['policy_hot_update', POLICY_HOT_UPDATE_MARKER],
  ]) {
    if (renderedMessage.includes(marker)) return scenario
  }
  fail('provider request has no isolated approval scenario marker')
}

function scenarioMarker(scenario) {
  return {
    decision: DECISION_MARKER,
    terminal: TERMINAL_MARKER,
    remember_seed: REMEMBER_SEED_MARKER,
    remember_reuse: REMEMBER_REUSE_MARKER,
    remember_restart: REMEMBER_RESTART_MARKER,
    delete_pending: DELETE_PENDING_MARKER,
    policy_hot_update: POLICY_HOT_UPDATE_MARKER,
  }[scenario]
}

function scenarioToolCallID(scenario) {
  return {
    decision: DECISION_TOOL_CALL_ID,
    terminal: TERMINAL_TOOL_CALL_ID,
    remember_seed: REMEMBER_SEED_TOOL_CALL_ID,
    remember_reuse: REMEMBER_REUSE_TOOL_CALL_ID,
    remember_restart: REMEMBER_RESTART_TOOL_CALL_ID,
    delete_pending: DELETE_PENDING_TOOL_CALL_ID,
    policy_hot_update: POLICY_HOT_UPDATE_TOOL_CALL_ID,
  }[scenario]
}

function scenarioToolArguments(scenario) {
  if (scenario.startsWith('remember_')) return { fixture: 'approval-reconnect-remembered' }
  if (scenario === 'delete_pending') return { fixture: 'approval-reconnect-delete-pending' }
  return { fixture: `approval-reconnect-${scenario}` }
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
    if (request.method === 'GET' && requestURL.pathname === '/v1/models') {
      state.modelListRequests += 1
      response.writeHead(200, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        connection: 'close',
      })
      response.end(
        JSON.stringify({
          object: 'list',
          data: [{ id: 'mock-model', object: 'model', created: 0, owned_by: 'loopback-fixture' }],
        }),
      )
      return
    }
    if (request.method !== 'POST' || requestURL.pathname !== '/v1/chat/completions') {
      state.unexpectedRequests.push(`${request.method} ${requestURL.pathname}`)
      response.writeHead(404, { 'content-type': 'application/json', connection: 'close' })
      response.end(JSON.stringify({ error: { message: 'Fixture route not found' } }))
      return
    }

    try {
      const payload = JSON.parse(await readRequestBody(request))
      const scenario = providerScenario(payload)
      const rounds = state.provider[scenario]
      const turn = rounds.length + 1
      const marker = scenarioMarker(scenario)
      const toolCallID = scenarioToolCallID(scenario)
      rounds.push(payload)

      assert.equal(request.headers.authorization, 'Bearer local-synthetic-credential')
      assert.equal(payload.model, 'mock-model')
      assert.equal(payload.stream, true)
      assert.match(JSON.stringify(payload.messages || []), new RegExp(marker))
      const toolMessages = (payload.messages || []).filter((message) => message.role === 'tool')
      const assistantToolCalls = (payload.messages || []).flatMap((message) =>
        message.role === 'assistant' && Array.isArray(message.tool_calls) ? message.tool_calls : [],
      )
      if (turn === 1) {
        assert.equal(toolMessages.length, 0)
        assert.ok(
          (payload.tools || []).some((tool) => tool?.function?.name === 'browser'),
          'first provider turn must expose the no-op browser MCP tool',
        )
        writeSSE(response, [
          openAIChunk(`chatcmpl-${scenario}-1`, {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: toolCallID,
                type: 'function',
                function: {
                  name: 'browser',
                  arguments: JSON.stringify(scenarioToolArguments(scenario)),
                },
              },
            ],
          }),
          openAIChunk(`chatcmpl-${scenario}-1`, {}, 'tool_calls'),
          '[DONE]',
        ])
        return
      }
      if (turn === 2) {
        assert.equal(toolMessages.length, 1)
        assert.equal(toolMessages[0].tool_call_id, toolCallID)
        assert.equal(assistantToolCalls.length, 1)
        assert.equal(assistantToolCalls[0].id, toolCallID)
        if (!['terminal', 'delete_pending'].includes(scenario)) {
          assert.match(String(toolMessages[0].content || ''), new RegExp(FINAL_MARKER))
        } else {
          assert.notEqual(String(toolMessages[0].content || ''), '')
        }
        writeSSE(response, [
          openAIChunk(
            `chatcmpl-${scenario}-2`,
            {
              role: 'assistant',
              content: ['terminal', 'delete_pending'].includes(scenario)
                ? 'fixture terminal cleanup'
                : FINAL_MARKER,
            },
            'stop',
          ),
          '[DONE]',
        ])
        return
      }
      fail(`unexpected ${scenario} provider chat turn ${turn}`)
    } catch (error) {
      state.protocolErrors.push(error.stack || error.message)
      if (!response.headersSent) response.writeHead(400, { connection: 'close' })
      response.end()
    }
  })
}

function renderConfig(sandbox, receiptPath) {
  const configPath = join(sandbox, '.hexclaw/hexclaw.yaml')
  const databasePath = join(sandbox, '.hexclaw/data.db')
  return {
    configPath,
    databasePath,
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
  routing:
    enabled: false
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
    - name: approval-reconnect-noop
      transport: stdio
      command: ${yamlString(process.execPath)}
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
    profile: strict
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

async function waitFor(predicate, timeoutMs, description, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return
    } catch (error) {
      lastError = error
    }
    await delay(intervalMs)
  }
  fail(`${description} timed out${lastError ? `: ${lastError.message}` : ''}`)
}

class WireSocket {
  constructor(ws, label) {
    this.ws = ws
    this.label = label
    this.messages = []
    this.outbound = []
    this.waiters = new Set()
    this.closed = false
    this.closeError = null
    ws.on('message', (data) => {
      try {
        this.messages.push(JSON.parse(data.toString()))
      } catch (error) {
        this.closeError = error
      }
      this.notify()
    })
    ws.on('error', (error) => {
      this.closeError = error
      this.notify()
    })
    ws.on('close', () => {
      this.closed = true
      this.notify()
    })
  }

  checkpoint() {
    return this.messages.length
  }

  send(payload) {
    assert.equal(this.ws.readyState, WEBSOCKET_OPEN, `${this.label} must be open before send`)
    this.outbound.push(payload)
    this.ws.send(JSON.stringify(payload))
  }

  waitFrom(start, predicate, timeoutMs, description, allowSidecarError = false) {
    let next = start
    return new Promise((resolveWire, rejectWire) => {
      const inspect = () => {
        if (this.closeError) {
          cleanup()
          rejectWire(this.closeError)
          return
        }
        while (next < this.messages.length) {
          const message = this.messages[next]
          next += 1
          if (message.type === 'error' && !allowSidecarError) {
            cleanup()
            rejectWire(
              new Error(`${this.label} sidecar error: ${message.content || 'unknown error'}`),
            )
            return
          }
          if (predicate(message)) {
            cleanup()
            resolveWire(message)
            return
          }
        }
        if (this.closed) {
          cleanup()
          rejectWire(new Error(`${this.label} closed before ${description}`))
        }
      }
      const timer = setTimeout(() => {
        cleanup()
        rejectWire(new Error(`${this.label} timed out waiting for ${description}`))
      }, timeoutMs)
      const waiter = { inspect }
      const cleanup = () => {
        clearTimeout(timer)
        this.waiters.delete(waiter)
      }
      this.waiters.add(waiter)
      inspect()
    })
  }

  notify() {
    for (const waiter of this.waiters) waiter.inspect()
  }

  async close() {
    if (this.closed) return
    const closed = new Promise((resolveClose) => this.ws.once('close', resolveClose))
    this.ws.close(1000, 'isolated fixture disconnect')
    const finished = await Promise.race([closed.then(() => true), delay(3000).then(() => false)])
    if (!finished && !this.closed) {
      this.ws.terminate()
      await Promise.race([closed, delay(1000)])
    }
  }
}

async function connectWebSocket(label) {
  const { default: WebSocket } = await import('ws')
  const ws = new WebSocket(`ws://127.0.0.1:${TEST_SIDECAR_PORT}/ws`, {
    headers: {
      Authorization: `Bearer ${TEST_API_TOKEN}`,
      Origin: 'tauri://localhost',
    },
  })
  await new Promise((resolveOpen, rejectOpen) => {
    ws.once('open', resolveOpen)
    ws.once('error', rejectOpen)
  })
  return new WireSocket(ws, label)
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

function messageWire(marker, sessionID, requestID) {
  return {
    type: 'message',
    content: marker,
    user_id: OWNER_MARKER,
    session_id: sessionID,
    request_id: requestID,
    provider: 'mock-openai',
    model: 'mock-model',
  }
}

function resumeWire(sessionID, requestID) {
  return {
    type: 'resume',
    session_id: sessionID,
    request_id: requestID,
    user_id: OWNER_MARKER,
  }
}

function sqliteLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

function readDurableReceipt(databasePath, requestID) {
  const output = execFileSync(
    '/usr/bin/sqlite3',
    [
      '-json',
      databasePath,
      `SELECT approval_request_id, invocation_id, owner_id, resolved_session_id, arguments_digest, security_scope_digest, scope_schema_version, state, decision_id, decision, idempotency_key, terminal_result, ack_status, release_state, consumed_at FROM tool_approval_requests WHERE approval_request_id = ${sqliteLiteral(requestID)}`,
    ],
    { encoding: 'utf8' },
  ).trim()
  const rows = JSON.parse(output || '[]')
  assert.equal(rows.length, 1, `durable receipt must exist exactly once for ${requestID}`)
  return rows[0]
}

function assertDurableIdentity(receipt, identity, label) {
  assert.equal(receipt.approval_request_id, identity.request_id, `${label}.request_id drifted`)
  assert.equal(receipt.invocation_id, identity.invocation_id, `${label}.invocation_id drifted`)
  assert.equal(receipt.owner_id, identity.owner_id, `${label}.owner_id drifted`)
  assert.equal(receipt.resolved_session_id, identity.session_id, `${label}.session_id drifted`)
  assert.equal(
    receipt.arguments_digest,
    identity.arguments_digest,
    `${label}.arguments_digest drifted`,
  )
  assert.equal(
    receipt.security_scope_digest,
    identity.security_scope_digest,
    `${label}.security_scope_digest drifted`,
  )
  assert.equal(
    Number(receipt.scope_schema_version),
    identity.scope_schema_version,
    `${label}.scope_schema_version drifted`,
  )
}

async function waitForDurableReceipt(databasePath, requestID, predicate, description) {
  let receipt
  await waitFor(
    () => {
      try {
        receipt = readDurableReceipt(databasePath, requestID)
        return predicate(receipt)
      } catch {
        return false
      }
    },
    20_000,
    description,
    150,
  )
  return receipt
}

function readReceipts(receiptPath) {
  if (!existsSync(receiptPath)) return []
  return readFileSync(receiptPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

async function waitForReceiptCount(receiptPath, count, description) {
  await waitFor(() => readReceipts(receiptPath).length === count, 20_000, description, 100)
}

function sqliteRows(databasePath, query) {
  const output = execFileSync('/usr/bin/sqlite3', ['-json', databasePath, query], {
    encoding: 'utf8',
  }).trim()
  return JSON.parse(output || '[]')
}

function readRememberedGrant(databasePath, identity, toolName) {
  const rows = sqliteRows(
    databasePath,
    `SELECT owner_id, resolved_session_id, canonical_tool_name, security_scope_digest, active, COALESCE(revoked_at, 0) AS revoked_at, revoked_reason, schema_version
FROM remembered_permission_grants
WHERE owner_id = ${sqliteLiteral(identity.owner_id)}
  AND resolved_session_id = ${sqliteLiteral(identity.session_id)}
  AND canonical_tool_name = ${sqliteLiteral(toolName)}
  AND security_scope_digest = ${sqliteLiteral(identity.security_scope_digest)}`,
  )
  assert.equal(rows.length, 1, 'remembered grant must have one exact durable row')
  return rows[0]
}

function readSessionRecord(databasePath, sessionID) {
  const rows = sqliteRows(
    databasePath,
    `SELECT id, user_id, status FROM sessions WHERE id = ${sqliteLiteral(sessionID)}`,
  )
  assert.equal(rows.length, 1, `session ${sessionID} must have one durable row`)
  return rows[0]
}

function countExactApprovalRequests(databasePath, identity, toolName) {
  const rows = sqliteRows(
    databasePath,
    `SELECT COUNT(*) AS count
FROM tool_approval_requests
WHERE owner_id = ${sqliteLiteral(identity.owner_id)}
  AND resolved_session_id = ${sqliteLiteral(identity.session_id)}
  AND canonical_tool_name = ${sqliteLiteral(toolName)}
  AND security_scope_digest = ${sqliteLiteral(identity.security_scope_digest)}`,
  )
  assert.equal(rows.length, 1, 'approval request count query must return one row')
  return Number(rows[0].count)
}

async function deleteSessionFromLoopback(sessionID) {
  const response = await fetch(
    `http://127.0.0.1:${TEST_SIDECAR_PORT}/api/v1/sessions/${encodeURIComponent(sessionID)}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${TEST_API_TOKEN}` },
      signal: AbortSignal.timeout(10_000),
    },
  )
  const payload = await response.json()
  assert.equal(response.status, 200, `loopback session delete failed: ${JSON.stringify(payload)}`)
  assert.equal(payload.message, '会话已删除')
  return payload
}

async function getAutonomyProfileFromLoopback() {
  const response = await fetch(`http://127.0.0.1:${TEST_SIDECAR_PORT}/api/v1/autonomy/profile`, {
    headers: { Authorization: `Bearer ${TEST_API_TOKEN}` },
    signal: AbortSignal.timeout(10_000),
  })
  const payload = await response.json()
  assert.equal(
    response.status,
    200,
    `loopback autonomy profile read failed: ${JSON.stringify(payload)}`,
  )
  return payload
}

async function updateAutonomyProfileFromLoopback(profile) {
  const response = await fetch(`http://127.0.0.1:${TEST_SIDECAR_PORT}/api/v1/autonomy/profile`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${TEST_API_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ profile }),
    signal: AbortSignal.timeout(10_000),
  })
  const payload = await response.json()
  assert.equal(
    response.status,
    200,
    `loopback autonomy profile update failed: ${JSON.stringify(payload)}`,
  )
  assert.equal(payload.profile, profile, 'loopback autonomy profile update response drifted')
  return payload
}

function countApprovalRequestsForSession(databasePath, sessionID) {
  const rows = sqliteRows(
    databasePath,
    `SELECT COUNT(*) AS count FROM tool_approval_requests WHERE resolved_session_id = ${sqliteLiteral(sessionID)}`,
  )
  assert.equal(rows.length, 1, 'approval request session count query must return one row')
  return Number(rows[0].count)
}

function assertNoApprovalWires(socket, start, label) {
  const approvals = socket.messages
    .slice(start)
    .filter((wire) => APPROVAL_WIRE_TYPES.has(wire.type))
  assert.deepEqual(approvals, [], `${label} must emit no approval transport wire`)
}

async function runAutoApprovedRememberedInvocation(
  socket,
  state,
  receiptPath,
  scenario,
  requestID,
  expectedReceiptCount,
) {
  const start = socket.checkpoint()
  const startingRounds = state.provider[scenario].length
  socket.send(messageWire(scenarioMarker(scenario), REMEMBERED_SESSION_ID, requestID))
  await waitFor(
    () => state.provider[scenario].length >= startingRounds + 2,
    15_000,
    `${scenario} provider completion`,
    100,
  )
  await waitForReceiptCount(
    receiptPath,
    expectedReceiptCount,
    `${scenario} one no-op MCP execution`,
  )
  await delay(150)
  assertNoApprovalWires(socket, start, scenario)
}

async function runRememberedLifecycleScenario(state, databasePath, receiptPath, restartApp) {
  const seedSocket = await connectWebSocket('remembered seed request socket')
  const seedStart = seedSocket.checkpoint()
  seedSocket.send(messageWire(REMEMBER_SEED_MARKER, REMEMBERED_SESSION_ID, 'request-remember-seed'))
  const seedWire = await seedSocket.waitFrom(
    seedStart,
    (wire) => wire.type === 'tool_approval_request',
    30_000,
    'initial remembered approval request',
  )
  const identity = identityFromApprovalRequest(seedWire)
  assert.equal(identity.session_id, REMEMBERED_SESSION_ID)
  assert.equal(seedWire.tool_name, 'browser')
  const decision = {
    decision: 'approved_remember',
    decision_id: 'decision-installed-approval-remembered',
    idempotency_key: 'idempotency-installed-approval-remembered',
  }
  const response = decisionWire(identity, decision)
  assertOutboundFullIdentity(response, identity, 'remembered seed response')
  const ackStart = seedSocket.checkpoint()
  seedSocket.send(response)
  const accepted = await seedSocket.waitFrom(
    ackStart,
    (wire) => wire.type === 'tool_approval_ack',
    10_000,
    'remembered approval acknowledgement',
  )
  assertDecisionACK(accepted, identity, decision, 'accepted', 'remembered approval ACK')
  await waitForReceiptCount(receiptPath, 2, 'remembered seed one no-op MCP execution')
  const seedReceipt = await waitForDurableReceipt(
    databasePath,
    identity.request_id,
    (receipt) =>
      receipt.terminal_result === 'approved_remember' && receipt.release_state === 'consumed',
    'durable remembered approval receipt',
  )
  assertDurableIdentity(seedReceipt, identity, 'durable remembered receipt')
  const activeGrant = readRememberedGrant(databasePath, identity, 'browser')
  assert.equal(Number(activeGrant.active), 1, 'remembered grant must be active before reuse')
  assert.equal(activeGrant.revoked_reason, '')
  assert.equal(countExactApprovalRequests(databasePath, identity, 'browser'), 1)

  await runAutoApprovedRememberedInvocation(
    seedSocket,
    state,
    receiptPath,
    'remember_reuse',
    'request-remember-reuse',
    3,
  )
  assert.equal(
    countExactApprovalRequests(databasePath, identity, 'browser'),
    1,
    'same-process remembered reuse must create no second approval row',
  )
  await seedSocket.close()

  const restart = await restartApp()
  const restartedSocket = await connectWebSocket('remembered restarted Sidecar socket')
  await runAutoApprovedRememberedInvocation(
    restartedSocket,
    state,
    receiptPath,
    'remember_restart',
    'request-remember-restart',
    4,
  )
  assert.equal(
    countExactApprovalRequests(databasePath, identity, 'browser'),
    1,
    'restarted Sidecar remembered reuse must create no second approval row',
  )
  const restartedGrant = readRememberedGrant(databasePath, identity, 'browser')
  assert.equal(Number(restartedGrant.active), 1, 'restart must preserve the active durable grant')

  const pendingStart = restartedSocket.checkpoint()
  restartedSocket.send(
    messageWire(DELETE_PENDING_MARKER, REMEMBERED_SESSION_ID, 'request-delete-pending'),
  )
  const pendingWire = await restartedSocket.waitFrom(
    pendingStart,
    (wire) => wire.type === 'tool_approval_request',
    30_000,
    'session-delete pending approval request',
  )
  const pendingIdentity = identityFromApprovalRequest(pendingWire)
  assert.notEqual(
    pendingIdentity.security_scope_digest,
    identity.security_scope_digest,
    'session-delete pending request must use a distinct security scope',
  )
  await deleteSessionFromLoopback(REMEMBERED_SESSION_ID)
  const deletedSession = readSessionRecord(databasePath, REMEMBERED_SESSION_ID)
  assert.equal(deletedSession.user_id, identity.owner_id)
  assert.equal(Number(deletedSession.status), -1, 'DELETE must soft-delete the exact owner session')
  const revokedGrant = readRememberedGrant(databasePath, identity, 'browser')
  assert.equal(Number(revokedGrant.active), 0, 'DELETE must revoke the remembered grant')
  assert.ok(Number(revokedGrant.revoked_at) > 0, 'DELETE must write grant revocation time')
  assert.equal(revokedGrant.revoked_reason, 'session_deleted')
  const fencedPending = await waitForDurableReceipt(
    databasePath,
    pendingIdentity.request_id,
    (receipt) => receipt.terminal_result === 'fenced' && receipt.release_state === 'fenced',
    'session-delete durable pending fence',
  )
  assertDurableIdentity(fencedPending, pendingIdentity, 'session-delete fenced pending receipt')
  await waitFor(
    () => state.provider.delete_pending.length === 2,
    5_000,
    'session delete must release the live pending approval waiter',
    100,
  )
  await waitForReceiptCount(receiptPath, 4, 'session delete must not execute its pending no-op MCP')
  await restartedSocket.close()

  state.remembered = {
    identity,
    seedWireType: seedWire.type,
    seedAckStatus: accepted.status,
    sameProcessApprovalWires: 0,
    restart,
    restartedApprovalWires: 0,
    sessionDelete: {
      status: Number(deletedSession.status),
      grantActive: Number(revokedGrant.active),
      grantRevocationReason: revokedGrant.revoked_reason,
      pendingTerminalResult: fencedPending.terminal_result,
      pendingReleaseState: fencedPending.release_state,
    },
  }
}

async function runPolicyHotUpdateScenario(state, databasePath, receiptPath, configPath) {
  const before = await getAutonomyProfileFromLoopback()
  assert.equal(before.profile, 'strict', 'fixture must start in strict profile')
  const updated = await updateAutonomyProfileFromLoopback('full_access')
  assert.match(readFileSync(configPath, 'utf8'), /profile: full_access/)

  const socket = await connectWebSocket('policy hot-update socket')
  const start = socket.checkpoint()
  const startingRounds = state.provider.policy_hot_update.length
  const sessionID = 'installed-approval-policy-hot-update'
  socket.send(messageWire(POLICY_HOT_UPDATE_MARKER, sessionID, 'request-policy-hot-update'))
  await waitFor(
    () => state.provider.policy_hot_update.length >= startingRounds + 2,
    15_000,
    'policy hot-update provider completion',
    100,
  )
  await waitForReceiptCount(receiptPath, 5, 'policy hot-update one no-op MCP execution')
  await delay(150)
  assertNoApprovalWires(socket, start, 'policy hot-update')
  assert.equal(
    countApprovalRequestsForSession(databasePath, sessionID),
    0,
    'profile hot-update must create no approval receipt',
  )
  await socket.close()

  state.policyHotUpdate = {
    beforeProfile: before.profile,
    updatedProfile: updated.profile,
    persistedProfile: 'full_access',
    approvalWires: 0,
    approvalRows: 0,
  }
}

async function runDecisionScenario(state, databasePath, receiptPath) {
  const initial = await connectWebSocket('decision initial request socket')
  const firstStart = initial.checkpoint()
  initial.send(
    messageWire(DECISION_MARKER, 'installed-approval-reconnect-decision', 'request-decision'),
  )
  const initialWire = await initial.waitFrom(
    firstStart,
    (wire) => wire.type === 'tool_approval_request',
    30_000,
    'initial strict approval request',
  )
  const identity = identityFromApprovalRequest(initialWire)
  assert.equal(identity.session_id, 'installed-approval-reconnect-decision')
  assert.equal(initialWire.tool_name, 'browser')
  await initial.close()
  await delay(150)

  const recovered = await connectWebSocket('decision recovered socket')
  const replayStart = recovered.checkpoint()
  const reconcile = reconciliationWire(identity)
  assertOutboundFullIdentity(reconcile, identity, 'decision reconcile')
  recovered.send(reconcile)
  const replayWire = await recovered.waitFrom(
    replayStart,
    (wire) => wire.type === 'tool_approval_request',
    10_000,
    'pending approval reconciliation replay',
  )
  assertWireIdentity(replayWire, identity, 'recovered pending approval')

  const decision = {
    decision: 'approved_once',
    decision_id: 'decision-installed-approval-reconnect',
    idempotency_key: 'idempotency-installed-approval-reconnect',
  }
  const response = decisionWire(identity, decision)
  assertOutboundFullIdentity(response, identity, 'saved decision response')
  const ackStart = recovered.checkpoint()
  recovered.send(response)
  const accepted = await recovered.waitFrom(
    ackStart,
    (wire) => wire.type === 'tool_approval_ack',
    10_000,
    'accepted saved decision acknowledgement',
  )
  assertDecisionACK(accepted, identity, decision, 'accepted', 'accepted saved decision ACK')
  await waitForReceiptCount(receiptPath, 1, 'one no-op MCP execution after accepted saved decision')
  const durableReceipt = await waitForDurableReceipt(
    databasePath,
    identity.request_id,
    (receipt) =>
      receipt.terminal_result === 'approved_once' && receipt.release_state === 'consumed',
    'durable consumed approval receipt',
  )
  assertDurableIdentity(durableReceipt, identity, 'durable accepted receipt')
  assert.equal(durableReceipt.ack_status, 'accepted')
  assert.equal(durableReceipt.decision_id, decision.decision_id)
  assert.equal(durableReceipt.decision, decision.decision)
  assert.equal(durableReceipt.idempotency_key, decision.idempotency_key)
  assert.ok(
    durableReceipt.consumed_at,
    'accepted approval must record its one execution consumption',
  )
  await recovered.close()

  const receiptSocket = await connectWebSocket('decision durable receipt socket')
  const receiptStart = receiptSocket.checkpoint()
  receiptSocket.send(reconciliationWire(identity))
  const durableAck = await receiptSocket.waitFrom(
    receiptStart,
    (wire) => wire.type === 'tool_approval_ack',
    10_000,
    'durable reconciliation acknowledgement',
  )
  assertDecisionACK(
    durableAck,
    identity,
    decision,
    'already_accepted',
    'durable reconciliation ACK',
  )

  const retryStart = receiptSocket.checkpoint()
  const retriedDecision = decisionWire(identity, decision)
  receiptSocket.send(retriedDecision)
  const retriedAck = await receiptSocket.waitFrom(
    retryStart,
    (wire) => wire.type === 'tool_approval_ack',
    10_000,
    'same decision/idempotency retransmission acknowledgement',
  )
  assertDecisionACK(retriedAck, identity, decision, 'accepted', 'retransmitted saved decision ACK')
  await waitForReceiptCount(
    receiptPath,
    1,
    'retransmitted decision must not execute the no-op MCP twice',
  )
  await receiptSocket.close()

  state.decision = {
    identity,
    initialWireType: initialWire.type,
    recoveredWireType: replayWire.type,
    acceptedStatus: accepted.status,
    durableReconcileStatus: durableAck.status,
    retransmitStatus: retriedAck.status,
    durableReceipt: {
      state: durableReceipt.state,
      terminal_result: durableReceipt.terminal_result,
      ack_status: durableReceipt.ack_status,
      release_state: durableReceipt.release_state,
      consumed: Boolean(durableReceipt.consumed_at),
    },
  }
}

async function waitPastBackendDeadline(deadlineAt) {
  const deadlineMs = Date.parse(deadlineAt)
  assert.ok(Number.isFinite(deadlineMs), 'backend deadline must parse')
  const waitMs = Math.max(0, deadlineMs - Date.now() + 1500)
  assert.ok(waitMs < 80_000, `unexpected approval deadline horizon: ${waitMs}ms`)
  if (waitMs > 0) await delay(waitMs)
}

async function runTerminalScenario(state, databasePath, receiptPath) {
  const sessionID = 'installed-approval-reconnect-terminal'
  const streamRequestID = 'request-terminal'
  const initial = await connectWebSocket('terminal initial request socket')
  const firstStart = initial.checkpoint()
  initial.send(messageWire(TERMINAL_MARKER, sessionID, streamRequestID))
  const initialWire = await initial.waitFrom(
    firstStart,
    (wire) => wire.type === 'tool_approval_request',
    30_000,
    'initial terminal strict approval request',
  )
  const identity = identityFromApprovalRequest(initialWire)
  assert.equal(identity.session_id, sessionID)
  assert.equal(initialWire.tool_name, 'browser')
  await initial.close()

  const recovered = await connectWebSocket('terminal recovered socket')
  const resumeStart = recovered.checkpoint()
  recovered.send(resumeWire(sessionID, streamRequestID))
  const snapshot = await recovered.waitFrom(
    resumeStart,
    (wire) => wire.type === 'stream_snapshot',
    10_000,
    'recovered stream snapshot',
  )
  assert.equal(snapshot.session_id, sessionID, 'recovered snapshot session drifted')
  assert.equal(snapshot.request_id, streamRequestID, 'recovered snapshot request drifted')

  const terminalStart = recovered.checkpoint()
  const reconcile = reconciliationWire(identity)
  assertOutboundFullIdentity(reconcile, identity, 'terminal reconcile')
  recovered.send(reconcile)
  const replayWire = await recovered.waitFrom(
    terminalStart,
    (wire) => wire.type === 'tool_approval_request',
    10_000,
    'recovered pending approval reconciliation replay',
  )
  assertWireIdentity(replayWire, identity, 'recovered terminal pending approval')

  await waitPastBackendDeadline(identity.deadline_at)
  const terminal = await recovered.waitFrom(
    terminalStart,
    (wire) => wire.type === 'tool_approval_terminal',
    15_000,
    'authoritative expired terminal reconciliation',
    true,
  )
  assertExpiredTerminal(terminal, identity)
  const durableReceipt = await waitForDurableReceipt(
    databasePath,
    identity.request_id,
    (receipt) => receipt.terminal_result === 'expired' && receipt.release_state === 'fenced',
    'durable expired terminal receipt',
  )
  assertDurableIdentity(durableReceipt, identity, 'durable expired receipt')
  assert.equal(durableReceipt.state, 'expired')
  assert.equal(durableReceipt.ack_status, 'expired')
  assert.equal(durableReceipt.decision_id || '', '')
  assert.equal(durableReceipt.decision || '', '')
  assert.equal(durableReceipt.idempotency_key || '', '')
  assert.equal(durableReceipt.consumed_at, null)
  assert.equal(
    readReceipts(receiptPath).length,
    1,
    'expired approval must not execute the no-op MCP',
  )
  await recovered.close()

  const terminalReceiptSocket = await connectWebSocket('terminal durable receipt socket')
  const receiptStart = terminalReceiptSocket.checkpoint()
  terminalReceiptSocket.send(reconciliationWire(identity))
  const reconciledTerminal = await terminalReceiptSocket.waitFrom(
    receiptStart,
    (wire) => wire.type === 'tool_approval_terminal',
    10_000,
    'expired durable terminal reconciliation after reconnect',
  )
  assertExpiredTerminal(reconciledTerminal, identity)
  await terminalReceiptSocket.close()

  state.terminal = {
    identity,
    initialWireType: initialWire.type,
    recoveredSnapshotType: snapshot.type,
    recoveredWireType: replayWire.type,
    terminalType: terminal.type,
    terminalResult: terminal.terminal_result,
    reconciledTerminalType: reconciledTerminal.type,
    durableReceipt: {
      state: durableReceipt.state,
      terminal_result: durableReceipt.terminal_result,
      ack_status: durableReceipt.ack_status,
      release_state: durableReceipt.release_state,
      decisionFieldsAbsent:
        !durableReceipt.decision_id && !durableReceipt.decision && !durableReceipt.idempotency_key,
    },
  }
}

async function stopProcess(child, signal = 'SIGTERM') {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  child.kill(signal)
  const exited = await Promise.race([
    new Promise((resolveExit) => child.once('exit', () => resolveExit(true))),
    delay(5000).then(() => false),
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

function stopOwnedMCPFixture(receiptPath) {
  const result = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
  if (result.status !== 0) return
  for (const line of String(result.stdout || '').split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/)
    if (!match) continue
    const [, rawPID, command] = match
    if (
      command.includes(currentFile) &&
      command.includes(' mcp ') &&
      command.includes(receiptPath)
    ) {
      try {
        process.kill(Number(rawPID), 'SIGTERM')
      } catch (error) {
        if (error.code !== 'ESRCH') throw error
      }
    }
  }
}

async function closeServer(server) {
  if (!server.listening) return
  server.closeAllConnections?.()
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()))
  })
}

async function runInstalledBoundary() {
  validateOverlay()
  assert.equal(process.platform, 'darwin', 'installed Test.app boundary is macOS-only')
  assert.deepEqual(
    listenerPIDs(TEST_SIDECAR_PORT),
    [],
    `port ${TEST_SIDECAR_PORT} is occupied; do not reuse another workflow listener`,
  )
  assert.deepEqual(
    listenerPIDs(TEST_FIXTURE_PORT),
    [],
    `port ${TEST_FIXTURE_PORT} is occupied; do not reuse another workflow listener`,
  )

  const appBundle = resolve(process.env.HEX_NATIVE_APP_BUNDLE || defaultAppBundle)
  const infoPlist = join(appBundle, 'Contents/Info.plist')
  assert.ok(existsSync(infoPlist), `Test.app bundle is missing: ${appBundle}`)
  assert.equal(plutilValue(infoPlist, 'CFBundleIdentifier'), 'com.hexclaw.desktop.mock')
  const appExecutable = join(
    appBundle,
    'Contents/MacOS',
    plutilValue(infoPlist, 'CFBundleExecutable'),
  )
  const sidecarExecutable = join(appBundle, 'Contents/MacOS/hexclaw')
  assert.ok(existsSync(appExecutable), `Test.app executable is missing: ${appExecutable}`)
  assert.ok(existsSync(sidecarExecutable), `Test.app Sidecar is missing: ${sidecarExecutable}`)

  mkdirSync(artifactDir, { recursive: true })
  const sandbox = mkdtempSync(join(tmpdir(), 'hexclaw-approval-reconnect-'))
  chmodSync(sandbox, 0o700)
  mkdirSync(join(sandbox, '.hexclaw'), { mode: 0o700 })
  mkdirSync(join(sandbox, 'tmp'), { mode: 0o700 })
  const receiptPath = join(sandbox, 'mcp-receipts.jsonl')
  const rendered = renderConfig(sandbox, receiptPath)
  writeFileSync(rendered.configPath, rendered.content, { encoding: 'utf8', mode: 0o600 })
  chmodSync(rendered.configPath, 0o600)

  const state = {
    updaterRequests: 0,
    modelListRequests: 0,
    provider: {
      decision: [],
      terminal: [],
      remember_seed: [],
      remember_reuse: [],
      remember_restart: [],
      delete_pending: [],
      policy_hot_update: [],
    },
    unexpectedRequests: [],
    protocolErrors: [],
    decision: null,
    terminal: null,
    remembered: null,
    sidecarRestarts: [],
  }
  const providerServer = createLoopbackFixtureServer(state)
  let appProcess
  let appLogStream
  let appTail = ''
  let succeeded = false
  try {
    await new Promise((resolveListen, rejectListen) => {
      providerServer.once('error', rejectListen)
      providerServer.listen(TEST_FIXTURE_PORT, '127.0.0.1', resolveListen)
    })
    appLogStream = createWriteStream(join(artifactDir, 'app.log'), { flags: 'w' })
    const capture = (chunk) => {
      appLogStream.write(chunk)
      appTail = `${appTail}${chunk.toString()}`.slice(-24_000)
    }
    const launchApp = async () => {
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
      appProcess.stdout.on('data', capture)
      appProcess.stderr.on('data', capture)
      await waitForHealth(appProcess, () => appTail)
      const sidecarPIDs = listenerPIDs(TEST_SIDECAR_PORT)
      assert.equal(sidecarPIDs.length, 1, 'Test.app must own exactly one Sidecar listener')
      return sidecarPIDs[0]
    }
    const restartApp = async () => {
      const before = listenerPIDs(TEST_SIDECAR_PORT)
      assert.equal(before.length, 1, 'Sidecar restart requires one owned listener before stop')
      await stopProcess(appProcess)
      await stopOwnedSidecar(appBundle)
      await waitFor(
        () => listenerPIDs(TEST_SIDECAR_PORT).length === 0,
        10_000,
        'owned Sidecar port release before restart',
        100,
      )
      const after = await launchApp()
      const restart = { beforeListenerPID: before[0], afterListenerPID: after }
      state.sidecarRestarts.push(restart)
      return restart
    }

    await launchApp()
    await runDecisionScenario(state, rendered.databasePath, receiptPath)
    await runTerminalScenario(state, rendered.databasePath, receiptPath)
    await runRememberedLifecycleScenario(state, rendered.databasePath, receiptPath, restartApp)
    await runPolicyHotUpdateScenario(state, rendered.databasePath, receiptPath, rendered.configPath)
    await waitFor(() => state.updaterRequests > 0, 5000, 'loopback updater request', 100)

    assert.deepEqual(state.unexpectedRequests, [])
    assert.deepEqual(state.protocolErrors, [])
    assert.ok(
      state.modelListRequests >= 2,
      'each Sidecar generation must resolve the static loopback model list at least once',
    )
    assert.equal(
      state.provider.decision.length,
      2,
      'approved scenario must have two provider rounds',
    )
    assert.equal(
      state.provider.terminal.length,
      2,
      'expired scenario must receive its timeout cleanup provider round',
    )
    for (const scenario of [
      'remember_seed',
      'remember_reuse',
      'remember_restart',
      'delete_pending',
      'policy_hot_update',
    ]) {
      assert.equal(state.provider[scenario].length, 2, `${scenario} must have two provider rounds`)
    }
    const receipts = readReceipts(receiptPath)
    assert.equal(
      receipts.length,
      5,
      'only approved invocations may execute the no-op MCP once each',
    )
    assert.deepEqual(
      receipts.map((receipt) => ({ name: receipt.name, arguments: receipt.arguments })),
      [
        { name: 'browser', arguments: { fixture: 'approval-reconnect-decision' } },
        { name: 'browser', arguments: { fixture: 'approval-reconnect-remembered' } },
        { name: 'browser', arguments: { fixture: 'approval-reconnect-remembered' } },
        { name: 'browser', arguments: { fixture: 'approval-reconnect-remembered' } },
        { name: 'browser', arguments: { fixture: 'approval-reconnect-policy_hot_update' } },
      ],
    )
    assert.equal(statSync(sandbox).mode & 0o777, 0o700)
    assert.equal(statSync(dirname(rendered.configPath)).mode & 0o777, 0o700)
    assert.equal(statSync(rendered.configPath).mode & 0o777, 0o600)
    assert.match(readFileSync(rendered.configPath, 'utf8'), /profile: full_access/)

    const summary = {
      acceptance: ['TOOL-APPROVAL-REUSE-001', 'REG-TOOL-APPROVAL-PROFILE-001'],
      appBundle,
      bundleIdentifier: 'com.hexclaw.desktop.mock',
      bundleVersion: plutilValue(infoPlist, 'CFBundleShortVersionString'),
      appExecutableSha256: fileSha256(appExecutable),
      sidecarExecutableSha256: fileSha256(sidecarExecutable),
      sidecar: `http://127.0.0.1:${TEST_SIDECAR_PORT}`,
      provider: `http://127.0.0.1:${TEST_FIXTURE_PORT}/v1`,
      updater: TEST_UPDATER_ENDPOINT,
      strictProfile: true,
      decision: state.decision,
      terminal: state.terminal,
      remembered: state.remembered,
      policyHotUpdate: state.policyHotUpdate,
      sidecarRestarts: state.sidecarRestarts,
      providerChatRounds: {
        decision: state.provider.decision.length,
        terminal: state.provider.terminal.length,
        rememberSeed: state.provider.remember_seed.length,
        rememberReuse: state.provider.remember_reuse.length,
        rememberRestart: state.provider.remember_restart.length,
        sessionDeletePending: state.provider.delete_pending.length,
        policyHotUpdate: state.provider.policy_hot_update.length,
      },
      mcpExecutions: receipts.length,
      updaterRequests: state.updaterRequests,
      loopbackModelListRequests: state.modelListRequests,
      realToolsInvoked: 0,
      externalModelInvocations: 0,
      imInvocations: 0,
      productionPortUsed: false,
      userHomeRead: false,
      nativeUIClicks: 0,
    }
    writeFileSync(join(artifactDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
    succeeded = true
  } catch (error) {
    if (existsSync(sandbox)) {
      cpSync(sandbox, join(artifactDir, `failure-sandbox-${Date.now()}`), { recursive: true })
    }
    fail(
      `${error.stack || error.message}\nFixture state:\n${JSON.stringify(state, null, 2)}\nApp log tail:\n${appTail}`,
    )
  } finally {
    await stopProcess(appProcess)
    await stopOwnedSidecar(appBundle)
    stopOwnedMCPFixture(receiptPath)
    if (appLogStream) {
      await new Promise((resolveClose) => appLogStream.end(resolveClose))
    }
    await closeServer(providerServer)
    if (existsSync(sandbox)) rmSync(sandbox, { recursive: true, force: true })
    if (!succeeded) process.stderr.write(`Failure artifacts: ${artifactDir}\n`)
  }
}

const command = process.argv[2] || 'run'
if (command === 'mcp') {
  runMCPFixture(process.argv[3])
} else if (command === 'validate') {
  validateOverlay()
  process.stdout.write('approval reconnect installed boundary preflight passed\n')
} else if (command === 'run') {
  await runInstalledBoundary()
} else {
  fail(`unknown command: ${command}`)
}
