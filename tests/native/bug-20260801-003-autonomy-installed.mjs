#!/usr/bin/env node

/**
 * BUG-20260801-003 当前 Test.app bundle 内 Sidecar 自治授权边界探针。
 *
 * validate 只校验候选包并报告能力边界；run 必须显式 opt-in，且仅使用隔离
 * HOME/SQLite 与回环 fake model。run 使用 macOS sandbox-exec 将 Sidecar 网络能力
 * 限制为本探针两个回环端口；隔离策略不可用时必须失败，不能以固定计数自证。
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, createHmac } from 'node:crypto'
import {
  appendFileSync,
  chmodSync,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const BUG_ID = 'BUG-20260801-003'
const OPT_IN_ENV = 'HEXCLAW_AUTONOMY_INSTALLED_PROBE'
const OPT_IN_VALUE = 'RUN_ISOLATED_AUTONOMY_INSTALLED_PROBE'
const FORGED_OWNER = 'forged-client-owner'
const CAPABILITY_OWNER = 'desktop-user'
const API_TOKEN = 'isolated-autonomy-installed-token'
const SIDECAR_CAPABILITY_TOKEN = 'isolated-autonomy-sidecar-capability-20260801'
const SANDBOX_EXECUTABLE = '/usr/bin/sandbox-exec'
const FIXTURE_API_KEY = 'isolated-autonomy-fixture-key'
const FIXTURE_MODEL = 'isolated-autonomy-model'
const FIXTURE_EMBEDDING_MODEL = 'isolated-autonomy-embedding'
const KNOWLEDGE_MARKER = 'AUTONOMY_RAG_MARKER_20260801'
const WEBHOOK_PROMPT = `${KNOWLEDGE_MARKER} browser`
const CRON_JOB_NAME = 'Installed autonomy Cron boundary'
const CRON_PROMPT = `${KNOWLEDGE_MARKER} 总结证据并使用 cron_task 列出当前任务`
const TOOL_NAME = 'browser'
const TOOL_CALL_ID = 'call-bug-20260801-003-browser'
const WRONG_DIGEST_TOOL_CALL_ID = 'call-bug-20260801-003-browser-wrong-digest'
const TOOL_ARGS = { fixture: 'bug-20260801-003' }
const WRONG_DIGEST_TOOL_ARGS = { fixture: 'bug-20260801-003-wrong-digest' }
const TOOL_RESULT = 'NOOP_MCP_BROWSER_OK'
const FINAL_RESULT = 'AUTONOMY_UNTRUSTED_EVIDENCE_GRANT_OK'
const WRONG_DIGEST_FINAL_RESULT = 'AUTONOMY_WRONG_DIGEST_DENIED'
const EVIDENCE_GRANT_ALLOW_REASON = '命中 RAG 证据专用 owner/task/scope 授权'
const EVIDENCE_GRANT_DENY_REASON = '不可信 RAG 证据禁止全局矩阵或宽泛 grant 提权'
const CRON_TOOL_NAME = 'cron_task'
const CRON_TOOL_CALL_ID = 'call-bug-20260801-003-cron-task'
const CRON_TOOL_ARGS = { action: 'list' }
const CRON_SCOPE_DIGEST = '584e7600815c4c752e42f8f3c00aa4bf1597f13bb08ed5de443b33097e1a1751'
const CRON_FINAL_RESULT = 'AUTONOMY_CRON_UNTRUSTED_EVIDENCE_GRANT_OK\nTASK_STATUS: done'
const PORT_PAIRS = [
  [16071, 16072],
  [16073, 16074],
  [16075, 16076],
  [16077, 16078],
]

const currentFile = fileURLToPath(import.meta.url)
const nativeDir = dirname(currentFile)
const repoRoot = resolve(nativeDir, '../..')
const appBundle = resolve(
  process.env.HEXCLAW_TEST_APP ||
    join(repoRoot, 'src-tauri/target/release/bundle/macos/HexClaw Test.app'),
)
const appExecutable = join(appBundle, 'Contents/MacOS/hexclaw-desktop')
const sidecarExecutable = join(appBundle, 'Contents/MacOS/hexclaw')
const mode = process.argv[2] || 'validate'
const sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds))

function candidateLabel() {
  return process.env.HEXCLAW_TEST_APP ? '<HEXCLAW_TEST_APP>' : 'current Test.app'
}

function resultBase() {
  return {
    bug_id: BUG_ID,
    mode,
    status: 'pending',
    candidate: candidateLabel(),
    isolation: {
      home: 'temporary',
      database: 'temporary SQLite',
      model: 'loopback fake OpenAI-compatible model',
    network_boundary: 'macOS sandbox-exec loopback-only enforcement',
    },
    opt_in: {
      environment: OPT_IN_ENV,
      required_value: OPT_IN_VALUE,
      enabled: process.env[OPT_IN_ENV] === OPT_IN_VALUE,
    },
    verified: [],
  }
}

function commandResult(command, args) {
  return spawnSync(command, args, { encoding: 'utf8', timeout: 5_000 })
}

function plutilValue(infoPlist, key) {
  const result = commandResult('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', infoPlist])
  assert.equal(result.status, 0, `Unable to read ${key} from Test.app Info.plist`)
  return String(result.stdout).trim()
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function listenerPIDs(port) {
  const result = commandResult('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'])
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`Unable to inspect loopback port ${port}`)
  }
  return String(result.stdout || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(Number)
    .filter(Number.isInteger)
}

function processCommand(pid) {
  const result = commandResult('/bin/ps', ['-p', String(pid), '-o', 'command='])
  return result.status === 0 ? String(result.stdout).trim() : ''
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

function selectPorts() {
  for (const [sidecarPort, fixturePort] of PORT_PAIRS) {
    if (listenerPIDs(sidecarPort).length === 0 && listenerPIDs(fixturePort).length === 0) {
      return { sidecarPort, fixturePort }
    }
  }
  throw new Error('No isolated loopback port pair is available')
}

function validateCandidate() {
  assert.equal(process.platform, 'darwin', 'The installed Test.app probe is macOS-only')
  const infoPlist = join(appBundle, 'Contents/Info.plist')
  assert.ok(existsSync(infoPlist), 'Current Test.app bundle is missing')
  assert.ok(existsSync(appExecutable), 'Current Test.app executable is missing')
  assert.ok(existsSync(sidecarExecutable), 'Current Test.app Sidecar is missing')
  assert.ok(existsSync(SANDBOX_EXECUTABLE), 'macOS sandbox-exec is required for loopback-only execution')
  const bundleMacOSRoot = realpathSync(join(appBundle, 'Contents/MacOS'))
  for (const [path, label] of [
    [appExecutable, 'Test.app executable'],
    [sidecarExecutable, 'Test.app Sidecar'],
  ]) {
    const metadata = lstatSync(path)
    assert.ok(!metadata.isSymbolicLink(), `${label} must not be a symbolic link`)
    assert.ok(metadata.isFile(), `${label} must be a regular file`)
    const realPath = realpathSync(path)
    assert.ok(
      realPath.startsWith(`${bundleMacOSRoot}${sep}`),
      `${label} must resolve inside Test.app Contents/MacOS`,
    )
  }
  const sandboxMetadata = lstatSync(SANDBOX_EXECUTABLE)
  assert.ok(!sandboxMetadata.isSymbolicLink(), 'sandbox-exec must not be a symbolic link')
  assert.ok(sandboxMetadata.isFile(), 'sandbox-exec must be a regular file')
  assert.equal(plutilValue(infoPlist, 'CFBundleIdentifier'), 'com.hexclaw.desktop.mock')
  return {
    bundle_identifier: 'com.hexclaw.desktop.mock',
    app_sha256: sha256File(appExecutable),
    sidecar_sha256: sha256File(sidecarExecutable),
    execution_boundary: 'Test.app bundle Sidecar launched through macOS sandbox-exec',
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function renderNetworkSandboxProfile(sidecarPort, fixturePort) {
  return `(version 1)
(allow default)
(deny network*)
(allow network-bind (local ip "localhost:${sidecarPort}"))
(allow network-inbound (local ip "localhost:${sidecarPort}"))
(allow network-outbound (remote ip "localhost:${fixturePort}"))
`
}

function networkBoundaryFacts(sidecarPort, fixturePort) {
  return {
    enforced: true,
    mechanism: 'macOS sandbox-exec SBPL',
    default_policy: 'allow default',
    network_policy: 'deny network*',
    allowed_bind: [`localhost:${sidecarPort}`],
    allowed_inbound: [`localhost:${sidecarPort}`],
    allowed_outbound: [`localhost:${fixturePort}`],
    external_network_allowed: false,
  }
}

function sanitizeProcessOutput(value, extraPaths = []) {
  let sanitized = String(value || '')
  const replacements = [
    [appBundle, '<test-app>'],
    [repoRoot, '<repo>'],
    [process.env.HOME || '', '<real-home>'],
    ...extraPaths.filter(Boolean).map((path) => [path, '<sandbox-path>']),
    [SIDECAR_CAPABILITY_TOKEN, '<redacted-capability-token>'],
    [FIXTURE_API_KEY, '<redacted-fixture-key>'],
    [API_TOKEN, '<redacted-api-token>'],
  ]
  for (const [secret, replacement] of replacements) {
    if (secret) sanitized = sanitized.replaceAll(secret, replacement)
  }
  return sanitized.slice(-8_192)
}

function captureChildOutput(child, logStream, redactionPaths) {
  const diagnostics = { stdout: '', stderr: '', redactionPaths, closed: null }
  const capture = (name, stream) => {
    if (!stream) return Promise.resolve()
    stream.on('data', (chunk) => {
      logStream.write(chunk)
      diagnostics[name] = `${diagnostics[name]}${chunk.toString('utf8')}`.slice(-16_384)
    })
    return new Promise((resolveClose) => stream.once('close', resolveClose))
  }
  diagnostics.closed = Promise.all([
    capture('stdout', child.stdout),
    capture('stderr', child.stderr),
  ])
  child.probeDiagnostics = diagnostics
}

async function childExitDiagnostic(child) {
  const diagnostics = child?.probeDiagnostics
  if (diagnostics?.closed) {
    await Promise.race([diagnostics.closed, sleep(250)])
  }
  return [
    `exit_code=${child?.exitCode ?? 'null'}`,
    `signal=${child?.signalCode ?? 'none'}`,
    `stdout=${JSON.stringify(sanitizeProcessOutput(diagnostics?.stdout, diagnostics?.redactionPaths))}`,
    `stderr=${JSON.stringify(sanitizeProcessOutput(diagnostics?.stderr, diagnostics?.redactionPaths))}`,
  ].join(' ')
}

function knowledgeEvidenceDiagnostic(content) {
  const raw = String(content ?? '')
  return `content_bytes=${Buffer.byteLength(raw, 'utf8')} content_sha256=${createHash('sha256').update(raw).digest('hex')}`
}

function assertKnowledgeEvidence(messages, expectedKnowledge) {
  assert.ok(expectedKnowledge?.documentID, 'expected Knowledge document identity is required')
  const candidates = messages.filter(
    (message) => typeof message?.content === 'string' && message.content.includes('<knowledge-evidence>'),
  )
  assert.ok(candidates.length > 0, 'target tool request must include a Knowledge evidence envelope')
  let lastFailure = 'no structurally valid envelope matched the created document'
  for (const evidenceMessage of candidates) {
    const envelopeMatch = evidenceMessage.content.match(
      /<knowledge-evidence>\s*([\s\S]*?)\s*<\/knowledge-evidence>/,
    )
    if (!envelopeMatch) {
      lastFailure = `Knowledge evidence envelope is incomplete; ${knowledgeEvidenceDiagnostic(evidenceMessage.content)}`
      continue
    }
    let envelope
    try {
      envelope = JSON.parse(envelopeMatch[1])
    } catch (error) {
      lastFailure = `Knowledge evidence payload is not valid JSON: ${error instanceof Error ? error.message : String(error)}; ${knowledgeEvidenceDiagnostic(envelopeMatch[1])}`
      continue
    }
    try {
      assert.equal(envelope?.schema, 'hexclaw.knowledge_evidence.v1')
      assert.equal(envelope?.trust, 'untrusted_document')
      assert.ok(Array.isArray(envelope?.items) && envelope.items.length > 0)
      for (const item of envelope.items) {
        assert.ok(item && typeof item === 'object', 'Knowledge evidence item must be an object')
        assert.equal(typeof item.document_id, 'string', 'Knowledge evidence item must expose document_id')
        assert.ok(item.document_id.length > 0, 'Knowledge evidence document_id must not be empty')
      }
      const matchingItems = envelope.items.filter(
        (item) => item.document_id === expectedKnowledge.documentID && String(item.content || '').includes(KNOWLEDGE_MARKER),
      )
      assert.ok(
        matchingItems.length > 0,
        `Knowledge evidence has no marker-bearing item structurally bound to document_id ${expectedKnowledge.documentID}`,
      )
      for (const item of matchingItems) {
        if (Object.hasOwn(item, 'source')) {
          assert.notEqual(expectedKnowledge.source, undefined, 'Evidence source cannot be correlated')
          assert.equal(String(item.source), String(expectedKnowledge.source))
        }
        const revisionKey = Object.hasOwn(item, 'revision_id')
          ? 'revision_id'
          : Object.hasOwn(item, 'revision')
            ? 'revision'
            : null
        if (revisionKey) {
          assert.notEqual(expectedKnowledge.revision, undefined, 'Evidence revision cannot be correlated')
          assert.equal(String(item[revisionKey]), String(expectedKnowledge.revision))
        }
      }
      return evidenceMessage
    } catch (error) {
      lastFailure = `${error instanceof Error ? error.message : String(error)}; ${knowledgeEvidenceDiagnostic(envelopeMatch[1])}`
    }
  }
  assert.fail(lastFailure)
}

function cronReceiptDiagnostic(content) {
  const raw = String(content ?? '')
  const sanitized = sanitizeProcessOutput(raw)
  const limit = 2_048
  const visible = sanitized.length > limit ? `${sanitized.slice(0, limit)}<truncated>` : sanitized
  return `content_bytes=${Buffer.byteLength(raw, 'utf8')} content=${JSON.stringify(visible)}`
}

function parseProductionCronList(content, expectedJob) {
  const lines = String(content ?? '')
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const header = lines[0]?.match(/^共\s*(\d+)\s*个定时任务[:：]$/)
  if (!header) return null
  const jobs = lines.slice(1).map((line) => {
    const match = line.match(
      /^-\s+([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*计划\s+([^|]+?)\s*\|\s*状态\s+([^|]+?)\s*\|\s*下次\s+(.+)$/,
    )
    assert.ok(match, `cron_task list contains malformed job line: ${line}`)
    return {
      id: match[1].trim(),
      name: match[2].trim(),
      schedule: match[3].trim(),
      status: match[4].trim(),
      nextRun: match[5].trim(),
    }
  })
  assert.equal(jobs.length, Number(header[1]), 'cron_task list count does not match parsed job rows')
  const matchingJob = jobs.find((job) => job.id === expectedJob.id && job.name === expectedJob.name)
  assert.ok(matchingJob, 'cron_task list must contain this run\'s dynamic job id and name')
  return { format: 'production-text-list', success: true, count: jobs.length, jobs, matchingJob }
}

function assertCronToolReceipt(content, expectedJob) {
  try {
    assert.ok(expectedJob?.id && expectedJob?.name, 'expected dynamic Cron job is required')
    const trimmed = String(content ?? '').trim()
    assert.ok(trimmed.length > 0, 'cron_task receipt must not be empty')
    assert.doesNotMatch(
      trimmed,
      /^(?:(?:error|failed|failure|denied|refused|exception|unauthorized|forbidden)\b|(?:错误|失败|拒绝|异常|无权限|未授权)(?:[:：\s]|$))/i,
      'cron_task receipt begins with an error, rejection, or exception',
    )

    const productionList = parseProductionCronList(trimmed, expectedJob)
    assert.ok(productionList, 'cron_task receipt must use the production plain-text list contract')
    assert.equal(productionList.format, 'production-text-list')
    return productionList
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    assert.fail(`cron_task receipt validation failed: ${reason}; ${cronReceiptDiagnostic(content)}`)
  }
}

function jsonResponse(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'Content-Length': Buffer.byteLength(body),
    'Content-Type': 'application/json; charset=utf-8',
    Connection: 'close',
  })
  response.end(body)
}

async function readJSONBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 1024 * 1024) throw new Error('Fixture request exceeds 1 MiB')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

function createFixtureServer(fixturePort) {
  const state = {
    modelListCalls: 0,
    chatCalls: 0,
    embeddingCalls: 0,
    knowledgeEvidencePrompts: 0,
    toolResultPrompts: 0,
    cronKnowledgeEvidencePrompts: 0,
    cronToolResultPrompts: 0,
    webhookKnowledgeEvidencePrompts: 0,
    webhookToolResultPrompts: 0,
    webhookWrongDigestKnowledgeEvidencePrompts: 0,
    webhookWrongDigestToolResultPrompts: 0,
    webhookToolArgModes: [],
    expectedKnowledge: null,
    expectedCronJob: null,
    cronToolReceiptDigests: [],
    cronToolReceiptFormats: [],
    unexpected: [],
  }
  const origin = `http://127.0.0.1:${fixturePort}`
  const server = createServer(async (request, response) => {
    const url = new URL(request.url || '/', origin)
    try {
      if (request.method === 'GET' && url.pathname === '/v1/models') {
        state.modelListCalls += 1
        jsonResponse(response, 200, {
          object: 'list',
          data: [
            { id: FIXTURE_MODEL, object: 'model', created: 0, owned_by: 'loopback' },
            { id: FIXTURE_EMBEDDING_MODEL, object: 'model', created: 0, owned_by: 'loopback' },
          ],
        })
        return
      }
      if (request.method === 'POST' && url.pathname === '/v1/embeddings') {
        const body = await readJSONBody(request)
        assert.equal(body.model, FIXTURE_EMBEDDING_MODEL)
        const inputs = Array.isArray(body.input) ? body.input : [body.input]
        state.embeddingCalls += 1
        jsonResponse(response, 200, {
          object: 'list',
          model: FIXTURE_EMBEDDING_MODEL,
          data: inputs.map((_, index) => ({
            object: 'embedding',
            index,
            embedding: [1, 0, 0],
          })),
          usage: { prompt_tokens: inputs.length, total_tokens: inputs.length },
        })
        return
      }
      if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
        const body = await readJSONBody(request)
        assert.equal(body.model, FIXTURE_MODEL)
        state.chatCalls += 1
        const messages = Array.isArray(body.messages) ? body.messages : []
        const serializedMessages = JSON.stringify(messages)
        const toolMessages = messages.filter((message) => message?.role === 'tool')
        if (serializedMessages.includes(KNOWLEDGE_MARKER) && toolMessages.length === 0) {
          assertKnowledgeEvidence(messages, state.expectedKnowledge)
          const cronFlow = serializedMessages.includes(CRON_PROMPT)
          const requestedTool = cronFlow ? CRON_TOOL_NAME : TOOL_NAME
          const webhookMode = cronFlow ? null : state.webhookToolArgModes.shift()
          if (!cronFlow) assert.ok(webhookMode, 'Webhook tool-argument mode was not armed before dispatch')
          const wrongDigestFlow = webhookMode === 'wrong_digest'
          const requestedCallID = cronFlow
            ? CRON_TOOL_CALL_ID
            : wrongDigestFlow
              ? WRONG_DIGEST_TOOL_CALL_ID
              : TOOL_CALL_ID
          const requestedArgs = cronFlow
            ? CRON_TOOL_ARGS
            : wrongDigestFlow
              ? WRONG_DIGEST_TOOL_ARGS
              : TOOL_ARGS
          assert.ok(
            (body.tools || []).some((tool) => tool?.function?.name === requestedTool),
            `tainted ${cronFlow ? 'cron' : 'webhook'} provider turn must expose ${requestedTool}`,
          )
          state.knowledgeEvidencePrompts += 1
          if (cronFlow) state.cronKnowledgeEvidencePrompts += 1
          else {
            state.webhookKnowledgeEvidencePrompts += 1
            if (wrongDigestFlow) state.webhookWrongDigestKnowledgeEvidencePrompts += 1
          }
          jsonResponse(response, 200, {
            id: `chatcmpl-isolated-autonomy-${cronFlow ? 'cron' : 'webhook'}-tool-call`,
            object: 'chat.completion',
            created: 0,
            model: FIXTURE_MODEL,
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: requestedCallID,
                      type: 'function',
                      function: { name: requestedTool, arguments: JSON.stringify(requestedArgs) },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })
          return
        }
        if (serializedMessages.includes(KNOWLEDGE_MARKER) && toolMessages.length > 0) {
          const cronFlow = serializedMessages.includes(CRON_PROMPT)
          const wrongDigestFlow = !cronFlow && toolMessages[0]?.tool_call_id === WRONG_DIGEST_TOOL_CALL_ID
          const expectedCallID = cronFlow
            ? CRON_TOOL_CALL_ID
            : wrongDigestFlow
              ? WRONG_DIGEST_TOOL_CALL_ID
              : TOOL_CALL_ID
          assert.equal(toolMessages.length, 1)
          assert.equal(toolMessages[0].tool_call_id, expectedCallID)
          const toolReceipt = String(toolMessages[0].content || '')
          assert.ok(toolReceipt.length > 0, 'tool receipt must not be empty')
          if (cronFlow) {
            const parsedReceipt = assertCronToolReceipt(toolReceipt, state.expectedCronJob)
            assert.equal(parsedReceipt.format, 'production-text-list')
            state.cronToolReceiptDigests.push(createHash('sha256').update(toolReceipt).digest('hex'))
            state.cronToolReceiptFormats.push(parsedReceipt.format)
            state.cronToolResultPrompts += 1
          } else if (wrongDigestFlow) {
            assert.doesNotMatch(toolReceipt, new RegExp(TOOL_RESULT))
            state.webhookWrongDigestToolResultPrompts += 1
            jsonResponse(response, 200, {
              id: 'chatcmpl-isolated-autonomy-webhook-wrong-digest-denied',
              object: 'chat.completion',
              created: 0,
              model: FIXTURE_MODEL,
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: WRONG_DIGEST_FINAL_RESULT },
                  finish_reason: 'stop',
                },
              ],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            })
            return
          } else {
            assert.match(toolReceipt, new RegExp(TOOL_RESULT))
            state.webhookToolResultPrompts += 1
          }
          state.toolResultPrompts += 1
          jsonResponse(response, 200, {
            id: `chatcmpl-isolated-autonomy-${cronFlow ? 'cron' : 'webhook'}-final`,
            object: 'chat.completion',
            created: 0,
            model: FIXTURE_MODEL,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: cronFlow ? CRON_FINAL_RESULT : FINAL_RESULT },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })
          return
        }
        jsonResponse(response, 200, {
          id: 'chatcmpl-isolated-autonomy',
          object: 'chat.completion',
          created: 0,
          model: FIXTURE_MODEL,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'isolated fixture response' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
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
    origin,
    state,
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

function runMCPFixture(receiptPath) {
  assert.ok(receiptPath, 'MCP receipt path is required')
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
            serverInfo: { name: 'autonomy-installed-noop', version: '1.0.0' },
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
                name: TOOL_NAME,
                description: 'Deterministic no-op browser-shaped installed test tool.',
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
          })}\n`,
          { encoding: 'utf8' },
        )
        respond({
          jsonrpc: '2.0',
          id: request.id,
          result: { content: [{ type: 'text', text: TOOL_RESULT }], isError: false },
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

function renderConfig(sandbox, sidecarPort, fixtureOrigin, receiptPath) {
  return `server:
  host: 127.0.0.1
  port: ${sidecarPort}
  mode: development
  api_token: ${API_TOKEN}
platforms:
  web:
    enabled: true
llm:
  default: isolated-fixture
  providers:
    isolated-fixture:
      provider_instance_id: pvd_v1_33333333333333333333333333333333
      display_name: Isolated Autonomy Fixture
      api_key: ${FIXTURE_API_KEY}
      base_url: ${fixtureOrigin}/v1
      model: ${FIXTURE_MODEL}
      models: [${FIXTURE_MODEL}, ${FIXTURE_EMBEDDING_MODEL}]
      model_specs_mode: explicit
      model_specs:
        - id: ${FIXTURE_MODEL}
          display_name: Isolated Autonomy Model
          capabilities: [text]
        - id: ${FIXTURE_EMBEDDING_MODEL}
          display_name: Isolated Autonomy Embedding
          capabilities: [embedding]
          embedding:
            protocol: openai_embeddings
            dimension: 3
            normalization: l2
      compatible: openai
      locality: local
      tools_enabled: true
      enabled: true
  routing:
    enabled: false
  cache:
    enabled: false
  tools:
    enabled: "on"
storage:
  driver: sqlite
  sqlite:
    path: ${JSON.stringify(join(sandbox, '.hexclaw/data.db'))}
security:
  autonomy:
    profile: strict
cron:
  enabled: true
webhook:
  enabled: true
knowledge:
  enabled: true
  query_expand: false
  contextual: false
  rerank: false
  min_score: 0
  embedding:
    provider: isolated-fixture
    model: ${FIXTURE_EMBEDDING_MODEL}
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
    - name: autonomy-installed-noop
      transport: stdio
      command: ${JSON.stringify(process.execPath)}
      args:
        - ${JSON.stringify(currentFile)}
        - mcp
        - ${JSON.stringify(receiptPath)}
      enabled: true
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
    translate: false
    summary: false
    browser: false
    code: false
    shell: false
    code_exec: false
    file_ops: false
observe:
  log_level: info
  metrics:
    enabled: false
`
}

function appEnvironment(sandbox, sidecarPort) {
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
    HEXCLAW_SIDECAR_CAPABILITY_TOKEN: SIDECAR_CAPABILITY_TOKEN,
    HEXCLAW_DISABLE_BACKGROUND_EGRESS: '1',
    DINGTALK_LIVE_SEND: '0',
    NO_PROXY: '*',
    no_proxy: '*',
  }
}

async function waitForHealth(origin, child, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Test.app bundle Sidecar exited before health became ready: ${await childExitDiagnostic(child)}`,
      )
    }
    try {
      const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1_000) })
      if (response.ok) return
    } catch {
      // 启动窗口内连接拒绝属于预期轮询状态。
    }
    await sleep(150)
  }
  throw new Error('Timed out waiting for Test.app Sidecar health')
}

async function waitForExit(child, timeoutMs = 8_000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  await new Promise((resolveExit) => {
    const timer = setTimeout(resolveExit, timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolveExit()
    })
  })
}

async function waitForStreamOpen(stream) {
  if (Number.isInteger(stream.fd)) return
  await new Promise((resolveOpen, rejectOpen) => {
    stream.once('open', resolveOpen)
    stream.once('error', rejectOpen)
  })
}

async function stopOwnedProcesses(currentApp, sidecarPort) {
  if (currentApp && processExists(currentApp.pid)) {
    currentApp.kill('SIGTERM')
    await waitForExit(currentApp)
    if (processExists(currentApp.pid)) currentApp.kill('SIGKILL')
  }
  for (const pid of listenerPIDs(sidecarPort)) {
    const command = processCommand(pid)
    if (!command.includes(sidecarExecutable)) {
      throw new Error('Sidecar port is owned by an unexpected process')
    }
    process.kill(pid, 'SIGTERM')
    const deadline = Date.now() + 5_000
    while (processExists(pid) && Date.now() < deadline) await sleep(100)
    if (processExists(pid)) process.kill(pid, 'SIGKILL')
  }
  const deadline = Date.now() + 5_000
  while (listenerPIDs(sidecarPort).length > 0 && Date.now() < deadline) await sleep(100)
  assert.deepEqual(listenerPIDs(sidecarPort), [], 'Sidecar port was not released')
}

function apiClient(apiOrigin) {
  return async function api(path, options = {}) {
    const response = await fetch(`${apiOrigin}${path}`, {
      method: options.method || 'GET',
      headers: {
        Authorization: `Bearer ${SIDECAR_CAPABILITY_TOKEN}`,
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
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
      `${options.method || 'GET'} ${path} returned unexpected status ${response.status}`,
    )
    return { status: response.status, data }
  }
}

async function triggerSignedWebhook(apiOrigin, name, secret, payload) {
  const body = JSON.stringify(payload)
  const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
  const response = await fetch(
    `${apiOrigin}/api/v1/webhooks/${encodeURIComponent(name)}?user_id=${encodeURIComponent(FORGED_OWNER)}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SIDECAR_CAPABILITY_TOKEN}`,
        'Content-Type': 'application/json',
        'X-User-ID': FORGED_OWNER,
        'X-Webhook-Signature': signature,
      },
      body,
      signal: AbortSignal.timeout(15_000),
    },
  )
  const responseBody = await response.text()
  assert.equal(response.status, 200, `signed webhook status=${response.status} body=${responseBody}`)
}

async function waitForChatCall(fixture, previousCalls) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (fixture.state.chatCalls > previousCalls) return
    await sleep(100)
  }
  throw new Error('Timed out waiting for signed webhook model dispatch')
}

async function waitForSemanticKnowledge(api, fixture) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const callsBeforeSearch = fixture.state.embeddingCalls
    const result = await api('/api/v1/knowledge/search', {
      method: 'POST',
      body: { query: WEBHOOK_PROMPT, top_k: 3 },
    })
    const markerFound = Array.isArray(result.data.results) &&
      result.data.results.some((item) => JSON.stringify(item).includes(KNOWLEDGE_MARKER))
    if (markerFound && fixture.state.embeddingCalls > callsBeforeSearch && fixture.state.embeddingCalls >= 2) {
      return result.data.results
    }
    await sleep(500)
  }
  throw new Error(`Timed out waiting for semantic Knowledge route: ${JSON.stringify(fixture.state)}`)
}

async function waitForKnowledgeToolFlow(fixture, previousFinals) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (fixture.state.toolResultPrompts > previousFinals) return
    await sleep(100)
  }
  throw new Error(
    `Timed out waiting for tainted Knowledge browser tool flow: ${JSON.stringify(fixture.state)}`,
  )
}

function securityScopeDigest(args) {
  const digest = createHash('sha256').update(JSON.stringify(args)).digest('hex')
  assert.match(digest, /^[0-9a-f]{64}$/)
  return digest
}

function readMCPReceipts(receiptPath) {
  if (!existsSync(receiptPath)) return []
  return readFileSync(receiptPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function decisionIdentity(decision) {
  assert.equal(typeof decision?.id, 'string', 'Autonomy decision must expose a stable id')
  assert.ok(decision.id.length > 0, 'Autonomy decision id must not be empty')
  return decision.id
}

async function decisionBaseline(api, source, taskRef) {
  const result = await api(
    `/api/v1/autonomy/decisions?source=${encodeURIComponent(source)}&task_ref=${encodeURIComponent(taskRef)}&limit=100`,
  )
  return new Set((result.data.decisions || []).map(decisionIdentity))
}

async function waitForNewDecision(api, source, taskRef, baseline, expected) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const result = await api(
      `/api/v1/autonomy/decisions?source=${encodeURIComponent(source)}&task_ref=${encodeURIComponent(taskRef)}&limit=100`,
    )
    const decision = (result.data.decisions || []).find(
      (item) =>
        !baseline.has(decisionIdentity(item)) &&
        item.source === source &&
        item.task_ref === taskRef &&
        item.tool === expected.tool &&
        item.decision === expected.decision &&
        (expected.via === undefined || item.via === expected.via) &&
        (expected.reason === undefined || item.reason === expected.reason),
    )
    if (decision) {
      assert.equal(decision.source, source)
      assert.equal(decision.task_ref, taskRef)
      assert.equal(decision.tool, expected.tool)
      return decision
    }
    await sleep(100)
  }
  throw new Error(`Timed out waiting for new ${expected.decision} decision for ${source}/${taskRef}`)
}

async function waitForCronSuccess(api, jobID) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const result = await api(`/api/v1/cron/jobs/${encodeURIComponent(jobID)}/history?limit=10`)
    const history = result.data.history || result.data.runs || []
    const succeeded = history.find((run) => run.job_id === jobID && run.status === 'success')
    if (succeeded) {
      assert.match(String(succeeded.stdout || ''), /AUTONOMY_CRON_UNTRUSTED_EVIDENCE_GRANT_OK/)
      return succeeded
    }
    await sleep(100)
  }
  throw new Error('Timed out waiting for successful Cron history')
}

function persistedSessionScopes(databasePath) {
  const result = commandResult('/usr/bin/sqlite3', [
    '-batch',
    '-noheader',
    databasePath,
    "SELECT user_id || '|' || platform FROM sessions ORDER BY created_at, id;",
  ])
  assert.equal(result.status, 0, 'Unable to inspect isolated session ownership')
  return String(result.stdout || '')
    .trim()
    .split('\n')
    .map((row) => row.trim())
    .filter(Boolean)
}

function sqliteJSONRows(databasePath, query, label) {
  const result = commandResult('/usr/bin/sqlite3', ['-batch', '-json', databasePath, query])
  assert.equal(result.status, 0, `Unable to inspect isolated ${label}`)
  const output = String(result.stdout || '').trim()
  if (!output) return []
  const rows = JSON.parse(output)
  assert.ok(Array.isArray(rows), `Isolated ${label} query must return a JSON array`)
  return rows
}

function runtimePersistenceSnapshot(databasePath) {
  const sessions = sqliteJSONRows(
    databasePath,
    'SELECT id,user_id,platform,created_at FROM sessions ORDER BY created_at,id;',
    'runtime sessions',
  )
  const assistantMessages = sqliteJSONRows(
    databasePath,
    `SELECT m.id,m.session_id,s.user_id,s.platform,m.content,m.created_at
       FROM messages m JOIN sessions s ON s.id=m.session_id
      WHERE m.role='assistant' ORDER BY m.created_at,m.id;`,
    'assistant terminal messages',
  )
  return {
    sessions,
    assistantMessages,
    sessionIDs: new Set(sessions.map((item) => item.id)),
    assistantMessageIDs: new Set(assistantMessages.map((item) => item.id)),
  }
}

function assertTrustedRuntimeOwner(item, label) {
  assert.equal(item.user_id, CAPABILITY_OWNER, `${label} owner must come from the Sidecar capability`)
  for (const forbiddenOwner of ['api-user', FORGED_OWNER, 'webhook-system']) {
    assert.notEqual(item.user_id, forbiddenOwner, `${label} accepted forbidden owner ${forbiddenOwner}`)
  }
}

async function waitForNewWebhookAssistantTerminal(databasePath, baseline, finalMarker, label) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const current = runtimePersistenceSnapshot(databasePath)
    const newSessions = current.sessions.filter((item) => !baseline.sessionIDs.has(item.id))
    const newAssistantMessages = current.assistantMessages.filter(
      (item) => !baseline.assistantMessageIDs.has(item.id),
    )
    const terminals = newAssistantMessages.filter(
      (item) => String(item.content || '').trim() === finalMarker,
    )
    if (terminals.length > 0) {
      assert.equal(terminals.length, 1, `${label} must persist exactly one new assistant terminal marker`)
      for (const session of newSessions) assertTrustedRuntimeOwner(session, `${label} new session`)
      for (const message of newAssistantMessages) {
        assertTrustedRuntimeOwner(message, `${label} new assistant message`)
      }
      return {
        newSessionIDs: newSessions.map((item) => item.id),
        newAssistantMessageIDs: newAssistantMessages.map((item) => item.id),
        terminalMessageID: terminals[0].id,
        terminalSessionID: terminals[0].session_id,
        owner: terminals[0].user_id,
      }
    }
    await sleep(100)
  }
  throw new Error(`Timed out waiting for new ${label} assistant terminal ${finalMarker}`)
}

async function observeStableZeroMCPExecution(receiptPath, beforeReceipts, observationMs = 1_000) {
  const deadline = Date.now() + observationMs
  let afterReceipts = readMCPReceipts(receiptPath)
  while (Date.now() <= deadline) {
    assert.deepEqual(afterReceipts, beforeReceipts, 'wrong-digest flow executed the MCP tool')
    await sleep(100)
    afterReceipts = readMCPReceipts(receiptPath)
  }
  assert.deepEqual(afterReceipts, beforeReceipts, 'wrong-digest flow executed the MCP tool')
  return {
    before: beforeReceipts.length,
    after: afterReceipts.length,
    delta: afterReceipts.length - beforeReceipts.length,
    stable_observation_ms: observationMs,
  }
}

function assertGrant(grant, expected, trustedOwner) {
  assert.equal(grant.task_ref, expected.taskRef)
  assert.equal(grant.source, expected.source)
  assert.deepEqual(grant.entries, [expected.tool])
  assert.equal(typeof grant.owner_id, 'string')
  assert.ok(grant.owner_id.length > 0)
  assert.notEqual(grant.owner_id, FORGED_OWNER)
  if (trustedOwner !== undefined) assert.equal(grant.owner_id, trustedOwner)
  assert.equal(grant.security_scope_digest, expected.scopeDigest)
  assert.equal(typeof grant.id, 'string')
  assert.ok(grant.id.length > 0)
  return grant.owner_id
}

async function preflight(api, source, taskRef, tool) {
  return (
    await api('/api/v1/autonomy/preflight', {
      method: 'POST',
      body: { source, task_ref: taskRef, tools: [tool] },
    })
  ).data
}

async function assertExactPreflightMatrix(api, tuple) {
  const toolState = (result, tool) => {
    const extra = result.extra_tools?.find((item) => item.tool === tool)?.state
    if (extra) return extra
    return result.capabilities?.find((item) => item.tools?.includes(tool))?.state
  }
  const exact = await preflight(api, tuple.source, tuple.taskRef, tuple.tool)
  assert.equal(
    toolState(exact, tuple.tool),
    'granted',
    `${tuple.kind} exact source-task-tool preflight failed: ${JSON.stringify(exact)}`,
  )
  const wrongSource = await preflight(api, tuple.otherSource, tuple.taskRef, tuple.tool)
  assert.equal(
    toolState(wrongSource, tuple.tool),
    'approval',
    `${tuple.kind} wrong-source preflight was allowed: ${JSON.stringify(wrongSource)}`,
  )
  const wrongTask = await preflight(api, tuple.source, `${tuple.taskRef}-other`, tuple.tool)
  assert.equal(
    toolState(wrongTask, tuple.tool),
    'approval',
    `${tuple.kind} wrong-task preflight was allowed: ${JSON.stringify(wrongTask)}`,
  )
  const wrongToolName = 'github.issues.write_comment'
  const wrongTool = await preflight(api, tuple.source, tuple.taskRef, wrongToolName)
  assert.equal(
    toolState(wrongTool, wrongToolName),
    'approval',
    `${tuple.kind} wrong-tool preflight was allowed: ${JSON.stringify(wrongTool)}`,
  )
}

async function runProbe(candidate) {
  const report = resultBase()
  report.candidate_facts = candidate
  const { sidecarPort, fixturePort } = selectPorts()
  const apiOrigin = `http://127.0.0.1:${sidecarPort}`
  const sandbox = mkdtempSync(join(tmpdir(), 'hexclaw-autonomy-installed.'))
  const configDir = join(sandbox, '.hexclaw')
  const tempDir = join(sandbox, 'tmp')
  const receiptPath = join(sandbox, 'mcp-receipts.ndjson')
  const sandboxProfilePath = join(sandbox, 'sidecar-network.sb')
  mkdirSync(configDir, { recursive: true, mode: 0o700 })
  mkdirSync(tempDir, { recursive: true, mode: 0o700 })
  chmodSync(sandbox, 0o700)
  chmodSync(configDir, 0o700)
  chmodSync(tempDir, 0o700)

  const fixture = createFixtureServer(fixturePort)
  const configPath = join(configDir, 'hexclaw.yaml')
  writeFileSync(configPath, renderConfig(sandbox, sidecarPort, fixture.origin, receiptPath), { mode: 0o600 })
  chmodSync(configPath, 0o600)
  writeFileSync(sandboxProfilePath, renderNetworkSandboxProfile(sidecarPort, fixturePort), { mode: 0o600 })
  chmodSync(sandboxProfilePath, 0o600)
  const logPath = join(sandbox, 'app.log')
  const logStream = createWriteStream(logPath, { flags: 'a', mode: 0o600 })
  const api = apiClient(apiOrigin)
  let currentApp = null

  const launch = async () => {
    assert.deepEqual(listenerPIDs(sidecarPort), [], 'Sidecar port must be free before launch')
    currentApp = spawn(
      SANDBOX_EXECUTABLE,
      ['-f', sandboxProfilePath, sidecarExecutable, 'serve', '--desktop', '--config', configPath],
      {
        cwd: sandbox,
        env: appEnvironment(sandbox, sidecarPort),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    captureChildOutput(currentApp, logStream, [sandbox, configPath, sandboxProfilePath])
    await waitForHealth(apiOrigin, currentApp)
    const sidecarPIDs = listenerPIDs(sidecarPort)
    assert.equal(sidecarPIDs.length, 1, 'Test.app bundle Sidecar must own exactly one listener')
    assert.ok(
      processCommand(sidecarPIDs[0]).includes(sidecarExecutable),
      'Sidecar listener must come from the current Test.app candidate',
    )
  }

  const stop = async () => {
    await stopOwnedProcesses(currentApp, sidecarPort)
    currentApp = null
  }

  try {
    await waitForStreamOpen(logStream)
    await fixture.listen()
    await launch()

    const knowledgeDocument = await api('/api/v1/knowledge/documents', {
      method: 'POST',
      body: {
        title: 'Installed autonomy evidence fixture',
        content: `${WEBHOOK_PROMPT} is an isolated Knowledge lookup marker and no-op tool label.`,
        source: 'installed-fixture',
      },
    })
    assert.equal(typeof knowledgeDocument.data.id, 'string')
    assert.ok(knowledgeDocument.data.id.length > 0)
    const knowledgeSearchResults = await waitForSemanticKnowledge(api, fixture)
    const matchingKnowledgeResult = knowledgeSearchResults.find((item) =>
      JSON.stringify(item).includes(KNOWLEDGE_MARKER),
    )
    fixture.state.expectedKnowledge = {
      documentID: knowledgeDocument.data.id,
      source: knowledgeDocument.data.source ?? matchingKnowledgeResult?.source ?? 'installed-fixture',
      revision:
        knowledgeDocument.data.revision ??
        knowledgeDocument.data.revision_id ??
        matchingKnowledgeResult?.revision ??
        matchingKnowledgeResult?.revision_id,
    }

    const webhookCreate = await api('/api/v1/webhooks', {
      method: 'POST',
      body: {
        name: 'autonomy-installed-exact',
        type: 'generic',
        prompt: WEBHOOK_PROMPT,
        user_id: FORGED_OWNER,
        enabled: true,
      },
    })
    assert.equal(typeof webhookCreate.data.id, 'string')
    assert.ok(webhookCreate.data.id.length > 0)
    assert.equal(typeof webhookCreate.data.secret, 'string')
    assert.ok(webhookCreate.data.secret.length > 0)

    const cronCreate = await api('/api/v1/cronjob', {
      method: 'POST',
      body: {
        action: 'create',
        user_id: FORGED_OWNER,
        idempotency_key: 'bug-20260801-003-create-cron',
        draft: {
          name: CRON_JOB_NAME,
          schedule: '@daily',
          prompt: CRON_PROMPT,
        },
      },
    })
    const cronJob = cronCreate.data.job
    assert.equal(typeof cronJob?.id, 'string')
    assert.ok(cronJob.id.length > 0)
    assert.equal(cronJob.user_id, CAPABILITY_OWNER)
    assert.equal(cronJob.spec?.runtime, 'agent')
    assert.equal(securityScopeDigest(CRON_TOOL_ARGS), CRON_SCOPE_DIGEST)
    fixture.state.expectedCronJob = { id: cronJob.id, name: CRON_JOB_NAME }

    const tuples = [
      {
        kind: 'cron',
        source: 'cron',
        otherSource: 'webhook',
        taskRef: `cron:${cronJob.id}`,
        tool: CRON_TOOL_NAME,
        scopeDigest: CRON_SCOPE_DIGEST,
      },
      {
        kind: 'webhook',
        source: 'webhook',
        otherSource: 'cron',
        taskRef: `webhook:${webhookCreate.data.id}`,
        tool: TOOL_NAME,
        scopeDigest: securityScopeDigest(TOOL_ARGS),
      },
    ]
    const trustedOwner = CAPABILITY_OWNER

    for (const tuple of tuples) {
      assert.equal((await preflight(api, tuple.source, tuple.taskRef, tuple.tool)).all_clear, false)
      const created = await api('/api/v1/autonomy/grants', {
        method: 'POST',
        body: {
          task_ref: tuple.taskRef,
          source: tuple.source,
          entries: [tuple.tool],
          security_scope_digest: tuple.scopeDigest,
          owner_id: FORGED_OWNER,
          note: 'isolated installed boundary probe',
        },
      })
      assertGrant(created.data.grant, tuple, trustedOwner)
      tuple.grantID = created.data.grant.id
      await assertExactPreflightMatrix(api, tuple)
    }

    const beforeRestart = await api('/api/v1/autonomy/grants')
    assert.equal(beforeRestart.data.total, 2)
    for (const tuple of tuples) {
      const grant = beforeRestart.data.grants.find((item) => item.id === tuple.grantID)
      assertGrant(grant, tuple, trustedOwner)
    }

    await stop()
    await launch()

    const afterRestart = await api('/api/v1/autonomy/grants')
    assert.equal(afterRestart.data.total, 2)
    for (const tuple of tuples) {
      const grant = afterRestart.data.grants.find((item) => item.id === tuple.grantID)
      assertGrant(grant, tuple, trustedOwner)
      await assertExactPreflightMatrix(api, tuple)
    }

    const cronList = await api('/api/v1/cronjob', {
      method: 'POST',
      body: { action: 'list', user_id: FORGED_OWNER, include_paused: true },
    })
    const persistedCronJob = (cronList.data.jobs || []).find((job) => job.id === cronJob.id)
    assert.ok(persistedCronJob, 'dynamically created Cron job must survive Test.app restart')
    assert.equal(persistedCronJob.user_id, CAPABILITY_OWNER)

    const cronDecisionBaseline = await decisionBaseline(api, tuples[0].source, tuples[0].taskRef)
    const callsBeforeCron = fixture.state.chatCalls
    const finalFlowsBeforeCron = fixture.state.toolResultPrompts
    await api('/api/v1/cronjob', {
      method: 'POST',
      body: {
        action: 'run',
        user_id: FORGED_OWNER,
        job_id: cronJob.id,
        idempotency_key: 'bug-20260801-003-run-cron',
      },
    })
    await waitForChatCall(fixture, callsBeforeCron)
    await waitForKnowledgeToolFlow(fixture, finalFlowsBeforeCron)
    const cronDecision = await waitForNewDecision(
      api,
      tuples[0].source,
      tuples[0].taskRef,
      cronDecisionBaseline,
      {
        tool: tuples[0].tool,
        decision: 'allow',
        via: 'task_grant',
        reason: EVIDENCE_GRANT_ALLOW_REASON,
      },
    )
    const cronHistory = await waitForCronSuccess(api, cronJob.id)
    assert.equal(fixture.state.cronKnowledgeEvidencePrompts, 1)
    assert.equal(fixture.state.cronToolResultPrompts, 1)
    assert.equal(fixture.state.cronToolReceiptDigests.length, 1)
    assert.deepEqual(fixture.state.cronToolReceiptFormats, ['production-text-list'])

    const wrongDigestDecisionBaseline = await decisionBaseline(api, tuples[1].source, tuples[1].taskRef)
    const wrongGrantList = await api('/api/v1/autonomy/grants')
    const wrongGrant = wrongGrantList.data.grants.find((item) => item.id === tuples[1].grantID)
    assertGrant(wrongGrant, tuples[1], trustedOwner)
    const wrongDigest = securityScopeDigest(WRONG_DIGEST_TOOL_ARGS)
    assert.notEqual(wrongDigest, wrongGrant.security_scope_digest)
    const databasePath = join(sandbox, '.hexclaw/data.db')
    const wrongWebhookPersistenceBaseline = runtimePersistenceSnapshot(databasePath)
    const receiptsBeforeWrongDigest = readMCPReceipts(receiptPath)
    const callsBeforeWrongDigest = fixture.state.chatCalls
    fixture.state.webhookToolArgModes.push('wrong_digest')
    await triggerSignedWebhook(
      apiOrigin,
      'autonomy-installed-exact',
      webhookCreate.data.secret,
      { message: 'run isolated wrong digest boundary', user_id: FORGED_OWNER, owner_id: FORGED_OWNER },
    )
    await waitForChatCall(fixture, callsBeforeWrongDigest)
    const wrongWebhookBoundary = await waitForNewWebhookAssistantTerminal(
      databasePath,
      wrongWebhookPersistenceBaseline,
      WRONG_DIGEST_FINAL_RESULT,
      'wrong-digest Webhook',
    )
    const wrongDigestDecision = await waitForNewDecision(
      api,
      tuples[1].source,
      tuples[1].taskRef,
      wrongDigestDecisionBaseline,
      {
        tool: tuples[1].tool,
        decision: 'deny',
        via: 'policy',
        reason: EVIDENCE_GRANT_DENY_REASON,
      },
    )
    assert.equal(fixture.state.webhookWrongDigestKnowledgeEvidencePrompts, 1)
    assert.equal(fixture.state.webhookWrongDigestToolResultPrompts, 1)
    const wrongDigestExecution = await observeStableZeroMCPExecution(
      receiptPath,
      receiptsBeforeWrongDigest,
    )
    assert.equal(wrongDigestExecution.delta, 0)

    const correctDigestDecisionBaseline = await decisionBaseline(api, tuples[1].source, tuples[1].taskRef)
    const correctWebhookPersistenceBaseline = runtimePersistenceSnapshot(databasePath)
    const callsBeforeWebhook = fixture.state.chatCalls
    const finalFlowsBeforeWebhook = fixture.state.toolResultPrompts
    fixture.state.webhookToolArgModes.push('correct_digest')
    await triggerSignedWebhook(
      apiOrigin,
      'autonomy-installed-exact',
      webhookCreate.data.secret,
      { message: 'run isolated boundary', user_id: FORGED_OWNER, owner_id: FORGED_OWNER },
    )
    await waitForChatCall(fixture, callsBeforeWebhook)
    await waitForKnowledgeToolFlow(fixture, finalFlowsBeforeWebhook)
    const correctWebhookBoundary = await waitForNewWebhookAssistantTerminal(
      databasePath,
      correctWebhookPersistenceBaseline,
      FINAL_RESULT,
      'correct-digest Webhook',
    )
    const exactDecision = await waitForNewDecision(
      api,
      tuples[1].source,
      tuples[1].taskRef,
      correctDigestDecisionBaseline,
      {
        tool: tuples[1].tool,
        decision: 'allow',
        via: 'task_grant',
        reason: EVIDENCE_GRANT_ALLOW_REASON,
      },
    )
    const receipts = readMCPReceipts(receiptPath)
    assert.deepEqual(receipts, [{ name: TOOL_NAME, arguments: TOOL_ARGS }])
    const sessionScopes = persistedSessionScopes(databasePath)
    assert.ok(sessionScopes.includes(`${trustedOwner}|api`), 'Webhook runtime lost trusted owner')
    assert.ok(!sessionScopes.includes(`webhook-system|api`), 'Legacy fixed webhook owner was persisted')
    assert.ok(!sessionScopes.includes(`api-user|api`), 'Fallback API owner was persisted')
    assert.ok(!sessionScopes.includes(`${FORGED_OWNER}|api`), 'Request-forged webhook owner was persisted')

    assert.ok(
      fixture.state.chatCalls <= 8,
      'Bundle Sidecar must make at most one warmup call per generation plus three bounded business tool flows',
    )
    assert.ok(
      fixture.state.embeddingCalls >= 3 && fixture.state.embeddingCalls <= 8,
      `unexpected embedding call count: ${fixture.state.embeddingCalls}`,
    )
    assert.equal(fixture.state.knowledgeEvidencePrompts, 3)
    assert.equal(fixture.state.toolResultPrompts, 2)
    assert.equal(fixture.state.webhookKnowledgeEvidencePrompts, 2)
    assert.equal(fixture.state.webhookToolResultPrompts, 1)
    assert.equal(fixture.state.webhookWrongDigestToolResultPrompts, 1)
    assert.deepEqual(fixture.state.webhookToolArgModes, [])
    assert.deepEqual(fixture.state.unexpected, [])
    report.status = 'passed'
    report.verified = [
      {
        capability: 'test_app_bundle_sidecar_candidate',
        status: 'passed',
        facts: candidate,
      },
      {
        capability: 'isolated_grant_store_persistence',
        status: 'passed',
        facts: { grants: 2, restart_generations: 2, database: 'temporary SQLite' },
      },
      {
        capability: 'sidecar_capability_api_owner_freeze',
        status: 'passed',
        facts: {
          owner: CAPABILITY_OWNER,
          forged_client_owner_rejected: true,
          cron_projection_after_restart: CAPABILITY_OWNER,
          boundary: 'bundle Sidecar capability-authenticated API; not the full Tauri token chain',
        },
      },
      {
        capability: 'source_task_tool_preflight_matrix',
        status: 'passed',
        facts: {
          sources: ['cron', 'webhook'],
          exact_matches: 2,
          rejected_dimensions: ['source', 'task', 'tool'],
        },
      },
      {
        capability: 'security_scope_digest_persistence',
        status: 'passed',
        facts: { exact_digests_preserved_after_restart: 2 },
      },
      {
        capability: 'security_scope_digest_runtime_enforcement',
        status: 'passed',
        facts: {
          wrong_digest: securityScopeDigest(WRONG_DIGEST_TOOL_ARGS),
          grant_owner: wrongGrant.owner_id,
          grant_source: wrongGrant.source,
          grant_task_ref: wrongGrant.task_ref,
          grant_tool: wrongGrant.entries[0],
          grant_scope_digest: wrongGrant.security_scope_digest,
          wrong_digest_decision_id: wrongDigestDecision.id,
          wrong_digest_decision: wrongDigestDecision.decision,
          wrong_digest_decision_via: wrongDigestDecision.via,
          wrong_digest_decision_reason: wrongDigestDecision.reason,
          tool_executions_before_wrong_digest: wrongDigestExecution.before,
          tool_executions_after_wrong_digest: wrongDigestExecution.after,
          tool_execution_delta: wrongDigestExecution.delta,
          stable_observation_ms: wrongDigestExecution.stable_observation_ms,
          assistant_terminal_message_id: wrongWebhookBoundary.terminalMessageID,
          assistant_terminal_owner: wrongWebhookBoundary.owner,
          correct_digest: tuples[1].scopeDigest,
          correct_digest_decision_id: exactDecision.id,
          correct_digest_decision: exactDecision.decision,
        },
      },
      {
        capability: 'cron_business_trigger_to_permission_hook',
        status: 'passed',
        facts: {
          dynamic_job_id: cronJob.id,
          owner: CAPABILITY_OWNER,
          task_ref: tuples[0].taskRef,
          source: tuples[0].source,
          tool: tuples[0].tool,
          scope_digest: tuples[0].scopeDigest,
          evidence_envelopes: fixture.state.cronKnowledgeEvidencePrompts,
          decision: cronDecision.decision,
          decision_via: cronDecision.via,
          structured_tool_receipts: fixture.state.cronToolReceiptDigests.length,
          tool_receipt_format: fixture.state.cronToolReceiptFormats[0],
          tool_receipt_sha256: fixture.state.cronToolReceiptDigests[0],
          history_status: cronHistory.status,
        },
      },
      {
        capability: 'generic_webhook_persisted_owner_runtime',
        status: 'passed',
        facts: {
          owner: trustedOwner,
          restarted_definition: true,
          signed_dispatches: 2,
          forged_body_query_header_owner_rejected: true,
          legacy_fixed_owner_absent: true,
          fallback_api_owner_absent: true,
          wrong_digest_terminal_message_id: wrongWebhookBoundary.terminalMessageID,
          correct_digest_terminal_message_id: correctWebhookBoundary.terminalMessageID,
          correct_digest_terminal_owner: correctWebhookBoundary.owner,
        },
      },
      {
        capability: 'runtime_untrusted_evidence_scope_match',
        status: 'passed',
        facts: {
          knowledge_document_id: knowledgeDocument.data.id,
          knowledge_search_hits: knowledgeSearchResults.length,
          evidence_envelopes: fixture.state.knowledgeEvidencePrompts,
          tool: TOOL_NAME,
          scope_digest: tuples[1].scopeDigest,
          decision: exactDecision.decision,
          decision_via: exactDecision.via,
          mcp_receipts: receipts.length,
        },
      },
      {
        capability: 'bundle_sidecar_loopback_only_execution',
        status: 'passed',
        facts: {
          network_boundary: networkBoundaryFacts(sidecarPort, fixturePort),
          fake_model_chat_calls: fixture.state.chatCalls,
          embedding_calls: fixture.state.embeddingCalls,
          provider_endpoint: fixture.origin,
          im_delivery_configured: false,
        },
      },
    ]
    return report
  } finally {
    try {
      await stop()
    } finally {
      await fixture.close()
      await new Promise((resolveClose) => logStream.end(resolveClose))
      rmSync(sandbox, { recursive: true, force: true })
    }
  }
}

function sanitizeError(error) {
  return String(error instanceof Error ? error.message : error)
    .replaceAll(repoRoot, '<repo>')
    .replaceAll(appBundle, '<test-app>')
    .replaceAll(process.env.HOME || '<real-home>', '<real-home>')
}

async function main() {
  const report = resultBase()
  if (!['validate', 'run'].includes(mode)) {
    report.status = 'blocked'
    report.error = 'Usage: node tests/native/bug-20260801-003-autonomy-installed.mjs validate|run'
    console.log(JSON.stringify(report, null, 2))
    process.exitCode = 1
    return
  }

  try {
    const candidate = validateCandidate()
    report.candidate_facts = candidate
    report.verified.push({ capability: 'test_app_bundle_sidecar_candidate', status: 'passed', facts: candidate })

    if (mode === 'validate') {
      report.status = 'ready'
      console.log(JSON.stringify(report, null, 2))
      return
    }
    if (process.env[OPT_IN_ENV] !== OPT_IN_VALUE) {
      report.status = 'blocked'
      report.error = `Set ${OPT_IN_ENV}=${OPT_IN_VALUE} to run the isolated installed-app probe.`
      console.log(JSON.stringify(report, null, 2))
      process.exitCode = 2
      return
    }

    console.log(JSON.stringify(await runProbe(candidate), null, 2))
  } catch (error) {
    report.status = 'failed'
    report.error = sanitizeError(error)
    console.log(JSON.stringify(report, null, 2))
    process.exitCode = 1
  }
}

if (mode === 'mcp') {
  runMCPFixture(process.argv[3])
} else {
  await main()
}
