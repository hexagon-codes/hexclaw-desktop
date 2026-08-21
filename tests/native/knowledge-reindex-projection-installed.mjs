import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
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
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ACCEPTANCE = ['KNOWLEDGE-REINDEX-PROJECTION-001', 'QUEUE-CANCELLED-001']
const TEST_CAPABILITY_TOKEN = 'hexclaw-native-knowledge-projection-0123456789abcdef'
const FIXTURE_CREDENTIAL = 'local-synthetic-credential'
const PORT_PAIRS = [
  [16063, 16065],
  [16065, 16066],
  [16066, 16067],
  [16067, 16068],
]
const TERMINAL_JOB_STATES = new Set(['succeeded', 'failed', 'cancelled'])
const TEST_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLh/gAAAABJRU5ErkJggg==',
  'base64',
)

const currentFile = fileURLToPath(import.meta.url)
const repoRoot = resolve(dirname(currentFile), '../..')
const appBundle = join(repoRoot, 'src-tauri/target/release/bundle/macos/HexClaw Test.app')
const artifactDir = join(repoRoot, 'test-results/native-knowledge-reindex-projection')

function fail(message) {
  throw new Error(message)
}

function fatal(message) {
  const error = new Error(message)
  error.fatal = true
  throw error
}

function sleep(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

function plutilValue(infoPlist, key) {
  const result = spawnSync('plutil', ['-extract', key, 'raw', '-o', '-', infoPlist], {
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    fail(`read ${key} from Info.plist failed: ${result.stderr || result.stdout}`)
  }
  return String(result.stdout).trim()
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

function selectPorts() {
  for (const [sidecarPort, fixturePort] of PORT_PAIRS) {
    if (listenerPIDs(sidecarPort).length === 0 && listenerPIDs(fixturePort).length === 0) {
      return { sidecarPort, fixturePort }
    }
  }
  fail(`no isolated loopback port pair is free: ${JSON.stringify(PORT_PAIRS)}`)
}

function validateCandidate() {
  assert.equal(process.platform, 'darwin', 'installed Test.app boundary is macOS-only')
  const infoPlist = join(appBundle, 'Contents/Info.plist')
  assert.ok(existsSync(infoPlist), `Test.app bundle is missing: ${appBundle}`)
  assert.equal(plutilValue(infoPlist, 'CFBundleIdentifier'), 'com.hexclaw.desktop.mock')
  const sidecarExecutable = join(appBundle, 'Contents/MacOS/hexclaw')
  assert.ok(existsSync(sidecarExecutable), `Test.app Sidecar is missing: ${sidecarExecutable}`)
  assert.ok(statSync(sidecarExecutable).isFile(), 'Test.app Sidecar must be a regular file')
  return { infoPlist, sidecarExecutable }
}

function yamlString(value) {
  return JSON.stringify(String(value))
}

function renderConfig(sandbox, sidecarPort, fixturePort) {
  const configPath = join(sandbox, '.hexclaw/hexclaw.yaml')
  const databasePath = join(sandbox, '.hexclaw/data.db')
  return {
    configPath,
    content: `server:
  host: 127.0.0.1
  port: ${sidecarPort}
  mode: development
platforms:
  web:
    enabled: true
llm:
  default: fixture-openai
  providers:
    fixture-openai:
      provider_instance_id: pvd_v1_0123456789abcdef0123456789abcdef
      api_key: ${FIXTURE_CREDENTIAL}
      base_url: http://127.0.0.1:${fixturePort}/v1
      model: fixture-vision
      models:
        - fixture-vision
        - fixture-embedding
      model_specs_mode: explicit
      model_specs:
        - id: fixture-vision
          display_name: Local Fixture Vision
          capabilities: [text, vision]
        - id: fixture-embedding
          display_name: Local Fixture Embedding
          capabilities: [embedding]
          embedding:
            protocol: openai_embeddings
            dimension: 3
            normalization: l2
      compatible: openai
      locality: local
      enabled: true
  routing:
    enabled: false
  cache:
    enabled: false
storage:
  driver: sqlite
  sqlite:
    path: ${yamlString(databasePath)}
knowledge:
  enabled: true
  rerank: false
  query_expand: false
  contextual: false
  embedding:
    provider: fixture-openai
    model: fixture-embedding
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
  enabled: false
compaction:
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
`,
  }
}

function createDeferred() {
  let resolvePromise
  const promise = new Promise((resolve) => {
    resolvePromise = resolve
  })
  return { promise, resolve: resolvePromise }
}

function readRequestBody(request) {
  return new Promise((resolveBody, reject) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => resolveBody(Buffer.concat(chunks)))
    request.on('error', reject)
  })
}

function writeFixtureJSON(response, payload) {
  if (response.destroyed) return
  response.writeHead(200, { 'content-type': 'application/json', connection: 'close' })
  response.end(JSON.stringify(payload))
}

function writeFixtureSSE(response, payload) {
  if (response.destroyed) return
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'close',
  })
  response.write(`data: ${JSON.stringify(payload)}\n\n`)
  response.write('data: [DONE]\n\n')
  response.end()
}

function createLoopbackFixtureServer(state, fixturePort) {
  return createServer(async (request, response) => {
    const requestURL = new URL(request.url || '/', `http://127.0.0.1:${fixturePort}`)
    if (request.method !== 'POST') {
      state.unexpectedRequests.push(`${request.method} ${requestURL.pathname}`)
      response.writeHead(404, { connection: 'close' })
      response.end()
      return
    }

    let payload
    try {
      payload = JSON.parse((await readRequestBody(request)).toString('utf8'))
    } catch (error) {
      state.protocolErrors.push(`invalid provider JSON: ${error.message}`)
      response.writeHead(400, { connection: 'close' })
      response.end()
      return
    }

    try {
      assert.equal(request.headers.authorization, `Bearer ${FIXTURE_CREDENTIAL}`)
      if (requestURL.pathname === '/v1/embeddings') {
        assert.equal(payload.model, 'fixture-embedding')
        const inputs = Array.isArray(payload.input) ? payload.input : [payload.input]
        assert.ok(inputs.length > 0, 'embedding probe/request must contain input')
        state.embeddingRequests.push({ model: payload.model, inputs: inputs.length })
        writeFixtureJSON(response, {
          object: 'list',
          model: 'fixture-embedding',
          data: inputs.map((_, index) => ({ object: 'embedding', index, embedding: [1, 0, 0] })),
          usage: { prompt_tokens: inputs.length, total_tokens: inputs.length },
        })
        return
      }

      if (requestURL.pathname === '/v1/chat/completions') {
        assert.equal(payload.model, 'fixture-vision')
        const serializedMessages = JSON.stringify(payload.messages || [])
        if (!/data:image\/png;base64,/.test(serializedMessages)) {
          assert.equal(
            state.warmupRequests.length,
            0,
            'candidate must make at most one local default-model warmup request before the controlled upload',
          )
          state.warmupRequests.push({ model: payload.model, stream: Boolean(payload.stream) })
          const content = 'fixture warmup ok'
          if (payload.stream) {
            writeFixtureSSE(response, {
              id: 'chatcmpl-native-knowledge-warmup',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'fixture-vision',
              choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: 'stop' }],
            })
          } else {
            writeFixtureJSON(response, {
              id: 'chatcmpl-native-knowledge-warmup',
              object: 'chat.completion',
              created: 1,
              model: 'fixture-vision',
              choices: [
                { index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' },
              ],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            })
          }
          return
        }
        state.visionRequests.push({ model: payload.model, stream: Boolean(payload.stream) })
        state.visionStartedAt = new Date().toISOString()
        await state.visionRelease.promise
        const content = 'fixture image caption for cancellation boundary'
        if (payload.stream) {
          writeFixtureSSE(response, {
            id: 'chatcmpl-native-knowledge-fixture',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'fixture-vision',
            choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: 'stop' }],
          })
        } else {
          writeFixtureJSON(response, {
            id: 'chatcmpl-native-knowledge-fixture',
            object: 'chat.completion',
            created: 1,
            model: 'fixture-vision',
            choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })
        }
        state.visionReleased = true
        return
      }

      state.unexpectedRequests.push(`${request.method} ${requestURL.pathname}`)
      response.writeHead(404, { connection: 'close' })
      response.end()
    } catch (error) {
      state.protocolErrors.push(error.stack || error.message)
      if (!response.headersSent && !response.destroyed) {
        response.writeHead(400, { connection: 'close' })
      }
      if (!response.destroyed) response.end()
    }
  })
}

async function listenLoopback(server, port) {
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(port, '127.0.0.1', resolveListen)
  })
}

async function closeServer(server) {
  if (!server.listening) return
  server.closeAllConnections?.()
  await new Promise((resolveClose) => server.close(() => resolveClose()))
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  const stopped = await Promise.race([
    new Promise((resolveExit) => child.once('exit', () => resolveExit(true))),
    sleep(5000).then(() => false),
  ])
  if (!stopped && child.exitCode === null) child.kill('SIGKILL')
}

async function waitForValue(action, timeoutMs, description, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const value = await action()
      if (value !== undefined && value !== null && value !== false) return value
    } catch (error) {
      if (error?.fatal) throw error
      lastError = error
    }
    await sleep(intervalMs)
  }
  fail(`${description} timed out${lastError ? `: ${lastError.message}` : ''}`)
}

async function waitForHealth(sidecarPort, process, appTail) {
  await waitForValue(
    async () => {
      if (process.exitCode !== null) {
        fatal(`candidate Sidecar exited before health readiness\n${appTail()}`)
      }
      const response = await fetch(`http://127.0.0.1:${sidecarPort}/health`, {
        signal: AbortSignal.timeout(1000),
      })
      return response.ok
    },
    60_000,
    'candidate Sidecar health readiness',
    200,
  )
}

async function apiRequest(baseURL, method, pathname, options = {}) {
  const requestOptions = {
    method,
    headers: {
      Authorization: `Bearer ${TEST_CAPABILITY_TOKEN}`,
      ...options.headers,
    },
    signal: options.signal ?? AbortSignal.timeout(5000),
  }
  if (options.body !== undefined) {
    requestOptions.body = options.body
  }
  const response = await fetch(`${baseURL}${pathname}`, requestOptions)
  const raw = await response.text()
  let json = null
  if (raw) {
    try {
      json = JSON.parse(raw)
    } catch {
      fail(`${method} ${pathname} returned non-JSON: ${raw}`)
    }
  }
  return { status: response.status, json, raw }
}

function assertStatus(response, expected, label) {
  assert.equal(
    response.status,
    expected,
    `${label}: status=${response.status}, body=${response.raw}`,
  )
  return response.json
}

function multipartDocument(filename, mediaType, bytes) {
  const boundary = '----HexClawNativeKnowledgeBoundary7MA4YWxkTrZu0gW'
  const head = Buffer.from(
    `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="corpus_id"\r\n\r\n' +
      'default\r\n' +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${mediaType}\r\n\r\n`,
    'utf8',
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
  return {
    body: Buffer.concat([head, Buffer.from(bytes), tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  }
}

async function uploadDocument(baseURL, filename, mediaType, bytes, idempotencyKey) {
  const multipart = multipartDocument(filename, mediaType, bytes)
  const response = await apiRequest(baseURL, 'POST', '/api/v1/knowledge/documents', {
    body: multipart.body,
    headers: {
      'Content-Type': multipart.contentType,
      'Idempotency-Key': idempotencyKey,
    },
  })
  const payload = assertStatus(response, 202, `upload ${filename}`)
  assert.match(String(payload?.operation_id || ''), /\S+/, `${filename} must have operation_id`)
  assert.match(String(payload?.document_id || ''), /\S+/, `${filename} must have document_id`)
  assert.match(String(payload?.job_id || ''), /\S+/, `${filename} must have root job_id`)
  return payload
}

async function acknowledgeOperation(baseURL, operationID) {
  const response = await apiRequest(
    baseURL,
    'POST',
    `/api/v1/knowledge/operations/${encodeURIComponent(operationID)}/ack?corpus_id=default`,
  )
  assert.equal(
    response.status,
    204,
    `ack ${operationID}: status=${response.status}, body=${response.raw}`,
  )
}

async function getJob(baseURL, jobID) {
  const response = await apiRequest(
    baseURL,
    'GET',
    `/api/v1/knowledge/jobs/${encodeURIComponent(jobID)}`,
  )
  return assertStatus(response, 200, `get job ${jobID}`)
}

async function listOperations(baseURL) {
  const response = await apiRequest(
    baseURL,
    'GET',
    '/api/v1/knowledge/operations?corpus_id=default',
  )
  const payload = assertStatus(response, 200, 'list knowledge operations')
  assert.ok(Array.isArray(payload?.operations), 'operations response must contain an array')
  return payload.operations
}

async function waitForJob(baseURL, jobID, expectedStates, description) {
  return waitForValue(
    async () => {
      const job = await getJob(baseURL, jobID)
      if (expectedStates.has(job.state)) return job
      if (TERMINAL_JOB_STATES.has(job.state)) {
        fatal(`${description}: job ${jobID} reached unexpected terminal state ${job.state}`)
      }
      return null
    },
    20_000,
    description,
  )
}

async function waitForOperation(baseURL, operationID, predicate, description) {
  return waitForValue(
    async () => {
      const operation = (await listOperations(baseURL)).find(
        (candidate) => candidate.operation_id === operationID,
      )
      if (!operation) return null
      return predicate(operation) ? operation : null
    },
    20_000,
    description,
  )
}

async function runInstalledBoundary() {
  const candidate = validateCandidate()
  const { sidecarPort, fixturePort } = selectPorts()
  mkdirSync(artifactDir, { recursive: true })
  rmSync(join(artifactDir, 'sandbox'), { recursive: true, force: true })

  const sandbox = mkdtempSync(join(tmpdir(), 'hexclaw-native-knowledge-'))
  chmodSync(sandbox, 0o700)
  mkdirSync(join(sandbox, '.hexclaw'), { mode: 0o700 })
  mkdirSync(join(sandbox, 'tmp'), { mode: 0o700 })
  const rendered = renderConfig(sandbox, sidecarPort, fixturePort)
  writeFileSync(rendered.configPath, rendered.content, { encoding: 'utf8', mode: 0o600 })
  chmodSync(rendered.configPath, 0o600)

  const state = {
    embeddingRequests: [],
    warmupRequests: [],
    visionRequests: [],
    unexpectedRequests: [],
    protocolErrors: [],
    visionStartedAt: '',
    visionReleased: false,
    visionRelease: createDeferred(),
  }
  const fixtureServer = createLoopbackFixtureServer(state, fixturePort)
  let sidecarProcess
  let appLog
  let appTail = ''
  let succeeded = false
  try {
    await listenLoopback(fixtureServer, fixturePort)
    appLog = createWriteStream(join(artifactDir, 'app.log'), { flags: 'w' })
    sidecarProcess = spawn(
      candidate.sidecarExecutable,
      ['serve', '--desktop', '--config', rendered.configPath],
      {
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
          HEXCLAW_SIDECAR_PORT: String(sidecarPort),
          HEXCLAW_TEST_LLM_CONFIG_MODE: 'preseeded-owner-yaml',
          HEXCLAW_SIDECAR_CAPABILITY_TOKEN: TEST_CAPABILITY_TOKEN,
          HEXCLAW_DISABLE_BACKGROUND_EGRESS: '1',
          NO_PROXY: '*',
          no_proxy: '*',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    const capture = (chunk) => {
      appLog.write(chunk)
      appTail = `${appTail}${chunk.toString()}`.slice(-24_000)
    }
    sidecarProcess.stdout.on('data', capture)
    sidecarProcess.stderr.on('data', capture)
    await waitForHealth(sidecarPort, sidecarProcess, () => appTail)

    const baseURL = `http://127.0.0.1:${sidecarPort}`
    const reindexUpload = await uploadDocument(
      baseURL,
      'native-reindex.txt',
      'text/plain',
      Buffer.from('NATIVE_REINDEX_PROJECTION_FIXTURE', 'utf8'),
      'native-reindex-upload-1',
    )
    await acknowledgeOperation(baseURL, reindexUpload.operation_id)
    await waitForJob(
      baseURL,
      reindexUpload.job_id,
      new Set(['succeeded']),
      'initial text ingest completion',
    )
    await waitForOperation(
      baseURL,
      reindexUpload.operation_id,
      (operation) => operation.state === 'succeeded' && operation.terminal === true,
      'initial text ingest operation completion',
    )

    const reindexResponse = await apiRequest(
      baseURL,
      'POST',
      `/api/v1/knowledge/documents/${encodeURIComponent(reindexUpload.document_id)}/reindex`,
    )
    const reindex = assertStatus(
      reindexResponse,
      202,
      'reindex must expose its real vector child job instead of returning an unpollable 200',
    )
    assert.equal(
      reindex.id,
      reindexUpload.document_id,
      'reindex response document identity must match',
    )
    assert.match(String(reindex.job_id || ''), /\S+/, 'reindex 202 response must include job_id')
    assert.notEqual(
      reindex.job_id,
      reindexUpload.job_id,
      'reindex must expose a new child job, not the ingest root',
    )
    assert.ok(
      ['queued', 'running', 'retry_wait', 'succeeded'].includes(reindex.job_state),
      `reindex job_state is not renderer-safe: ${reindex.job_state}`,
    )
    const reindexJob = await getJob(baseURL, reindex.job_id)
    assert.equal(reindexJob.job_id, reindex.job_id, 'reindex job_id must be directly pollable')
    const reindexTerminalJob = await waitForJob(
      baseURL,
      reindex.job_id,
      new Set(['succeeded']),
      'reindex child job completion',
    )

    const cancelledUpload = await uploadDocument(
      baseURL,
      'native-cancel-processing.png',
      'image/png',
      TEST_PNG,
      'native-cancel-upload-1',
    )
    await acknowledgeOperation(baseURL, cancelledUpload.operation_id)
    await waitForValue(
      () => state.visionStartedAt || null,
      15_000,
      'local fixture vision request for processing upload',
    )
    const processingOperation = await waitForOperation(
      baseURL,
      cancelledUpload.operation_id,
      (operation) => operation.state === 'running' && operation.terminal === false,
      'upload operation running projection before cancellation',
    )
    const processingJob = await getJob(baseURL, cancelledUpload.job_id)
    assert.equal(
      processingJob.state,
      'running',
      'cancel target must be an actively processing root job',
    )
    assert.equal(
      processingOperation.job_id,
      cancelledUpload.job_id,
      'operation must project its root job',
    )

    const cancelResponse = await apiRequest(
      baseURL,
      'POST',
      `/api/v1/knowledge/jobs/${encodeURIComponent(cancelledUpload.job_id)}/cancel`,
    )
    const cancelledJob = assertStatus(cancelResponse, 200, 'cancel processing upload root job')
    assert.equal(
      cancelledJob.job_id,
      cancelledUpload.job_id,
      'cancel response must identify the root job',
    )
    assert.equal(cancelledJob.state, 'cancelled', 'cancel response must be terminal cancelled')
    await waitForJob(
      baseURL,
      cancelledUpload.job_id,
      new Set(['cancelled']),
      'cancelled root job projection',
    )
    const cancelledOperation = await waitForOperation(
      baseURL,
      cancelledUpload.operation_id,
      (operation) => operation.state === 'cancelled' && operation.terminal === true,
      'cancelled upload terminal operation projection',
    )
    const reloadedOperation = (await listOperations(baseURL)).find(
      (operation) => operation.operation_id === cancelledUpload.operation_id,
    )
    assert.deepEqual(
      {
        operation_id: reloadedOperation?.operation_id,
        job_id: reloadedOperation?.job_id,
        document_id: reloadedOperation?.document_id,
        state: reloadedOperation?.state,
        terminal: reloadedOperation?.terminal,
      },
      {
        operation_id: cancelledUpload.operation_id,
        job_id: cancelledUpload.job_id,
        document_id: cancelledUpload.document_id,
        state: 'cancelled',
        terminal: true,
      },
      'reload projection must preserve cancelled terminal truth for safe UI queue removal',
    )
    state.visionRelease.resolve()
    await sleep(100)

    assert.deepEqual(
      state.unexpectedRequests,
      [],
      'fixture must receive no unexpected provider route',
    )
    assert.deepEqual(state.protocolErrors, [], 'fixture provider protocol assertions must pass')
    assert.ok(
      state.embeddingRequests.length >= 3,
      'test must traverse startup and worker embedding boundaries',
    )
    assert.equal(
      state.warmupRequests.length,
      1,
      'candidate default-model warmup must remain confined to the local fixture',
    )
    assert.equal(
      state.visionRequests.length,
      1,
      'only the controlled processing upload may call vision',
    )
    assert.equal(statSync(sandbox).mode & 0o777, 0o700)
    assert.equal(statSync(join(sandbox, '.hexclaw')).mode & 0o777, 0o700)
    assert.equal(statSync(rendered.configPath).mode & 0o777, 0o600)

    const summary = {
      acceptance: ACCEPTANCE,
      result: 'pass',
      bundleIdentifier: plutilValue(candidate.infoPlist, 'CFBundleIdentifier'),
      bundleVersion: plutilValue(candidate.infoPlist, 'CFBundleShortVersionString'),
      sidecarExecutableSha256: fileSha256(candidate.sidecarExecutable),
      sidecar: `http://127.0.0.1:${sidecarPort}`,
      fixture: `http://127.0.0.1:${fixturePort}/v1`,
      reindex: {
        status: reindexResponse.status,
        documentID: reindex.id,
        jobID: reindex.job_id,
        jobState: reindex.job_state,
        initialPollState: reindexJob.state,
        terminalPollState: reindexTerminalJob.state,
      },
      cancelledUpload: {
        operationID: cancelledOperation.operation_id,
        jobID: cancelledOperation.job_id,
        documentID: cancelledOperation.document_id,
        state: cancelledOperation.state,
        terminal: cancelledOperation.terminal,
      },
      fixtureEmbeddingRequests: state.embeddingRequests.length,
      fixtureWarmupRequests: state.warmupRequests.length,
      fixtureVisionRequests: state.visionRequests.length,
      externalModelInvocations: 0,
      ollamaInvocations: 0,
      productionDataTouched: false,
      nativeDOM: {
        status: 'not_evidenced',
        reason:
          'candidate Sidecar API is exercised directly; this harness has no native WebView DOM automation channel',
      },
    }
    writeFileSync(join(artifactDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
    succeeded = true
  } catch (error) {
    if (existsSync(sandbox)) {
      cpSync(sandbox, join(artifactDir, 'sandbox'), { recursive: true })
    }
    fail(
      `${error.stack || error.message}\nFixture state:\n${JSON.stringify(
        {
          embeddingRequests: state.embeddingRequests,
          warmupRequests: state.warmupRequests,
          visionRequests: state.visionRequests,
          unexpectedRequests: state.unexpectedRequests,
          protocolErrors: state.protocolErrors,
          visionStartedAt: state.visionStartedAt,
        },
        null,
        2,
      )}\nCandidate Sidecar log tail:\n${appTail}`,
    )
  } finally {
    state.visionRelease.resolve()
    await stopChild(sidecarProcess)
    if (appLog) await new Promise((resolveClose) => appLog.end(resolveClose))
    await closeServer(fixtureServer)
    if (existsSync(sandbox)) rmSync(sandbox, { recursive: true, force: true })
    if (!succeeded) process.stderr.write(`Failure artifacts: ${artifactDir}\n`)
  }
}

const command = process.argv[2] || 'run'
if (command === 'validate') {
  validateCandidate()
  process.stdout.write('native knowledge installed boundary preflight passed\n')
} else if (command === 'run') {
  await runInstalledBoundary()
} else {
  fail(`unknown command: ${command}`)
}
