#!/usr/bin/env node

/**
 * BUG-20260802-016：ImageTask 与 Knowledge 的原生组合生命周期边界。
 *
 * 本脚本从当前工作树构建临时 Test.app 和当前 Sidecar 源码，只使用 0700 临时 HOME、
 * 独占回环端口和确定性 Provider。fixture 仅注入临时前端副本，不进入生产产物。
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
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const nativeDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(nativeDir, '../..')
const srcTauriDir = join(repoRoot, 'src-tauri')
const sidecarSourceRoot = resolve(repoRoot, '../hexclaw')
const evidenceRoot = resolve(
  repoRoot,
  '../hexclaw-docs/test/evidence/bug-20260802-016-current-source',
)
const appProductName = 'HexClaw BUG016 Lifecycle Test'
const appIdentifier = 'com.hexclaw.desktop.bug016.lifecycle'
const syntheticCredential = 'bug016-loopback-only-credential'
const commandTimeoutMs = 14 * 60 * 1000
const lifecycleTimeoutMs = 4 * 60 * 1000
const pngBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const knowledgeBody = 'BUG-20260802-016 deterministic Knowledge lifecycle fixture.\n'
const childName = `BUG016-${Date.now().toString(36)}`
const knowledgeTitle = `BUG016-${Date.now().toString(36)}.txt`

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
}

function deferred() {
  let resolvePromise
  const promise = new Promise((resolve) => {
    resolvePromise = resolve
  })
  return { promise, resolve: resolvePromise }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function sha256File(path) {
  return sha256(readFileSync(path))
}

function runCommand(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    process.stdout.write(`\n[bug016-lifecycle] ${command} ${args.join(' ')}\n`)
    const child = spawn(command, args, {
      cwd: options.cwd || repoRoot,
      env: options.env || process.env,
      stdio: 'inherit',
    })
    let settled = false
    const finish = (callback) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      callback()
    }
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      finish(() => reject(new Error(`Command timed out: ${command} ${args.join(' ')}`)))
    }, options.timeoutMs || commandTimeoutMs)
    child.once('error', (error) => finish(() => reject(error)))
    child.once('exit', (code, signal) => {
      finish(() => {
        if (code === 0) resolvePromise()
        else reject(new Error(`Command failed (${code ?? signal}): ${command} ${args.join(' ')}`))
      })
    })
  })
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
  assert.notEqual(port, 11434)
  return port
}

function listenerPids(port) {
  try {
    const raw = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
      encoding: 'utf8',
    })
    return raw.split(/\s+/).filter(Boolean).map(Number)
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

async function stopProcess(processHandle) {
  if (!processHandle || processHandle.exitCode !== null || processHandle.signalCode !== null) return
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
  const owned = []
  const unexpected = []
  const expected = `${appBundle}/Contents/MacOS/hexclaw serve --desktop`
  for (const pid of listenerPids(port)) {
    const command = processCommand(pid)
    if (!command.includes(expected)) {
      unexpected.push({ pid, command: command || '<unreadable>' })
      continue
    }
    process.kill(pid, 'SIGTERM')
    owned.push(pid)
  }
  const deadline = Date.now() + 5_000
  while (listenerPids(port).length && Date.now() < deadline) await sleep(100)
  return { owned, unexpected, released: listenerPids(port).length === 0 }
}

async function waitForHealth(port, appProcess) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (appProcess.exitCode !== null || appProcess.signalCode !== null) {
      throw new Error('Test.app exited before Sidecar health')
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1_500),
      })
      if (response.ok) return
    } catch {
      // Sidecar 尚未完成启动。
    }
    await sleep(200)
  }
  throw new Error(`Sidecar health timed out on dedicated port ${port}`)
}

function sqliteRows(databasePath, sql) {
  const raw = execFileSync(
    'sqlite3',
    ['-json', '-cmd', '.timeout 5000', databasePath, sql],
    { encoding: 'utf8' },
  )
  return JSON.parse(raw || '[]')
}

function snapshotDatabase(databasePath) {
  if (!existsSync(databasePath)) return { ready: false, error: 'SQLite database is absent' }
  try {
    const dispatches = sqliteRows(
      databasePath,
      `SELECT dispatch_id,agent_name,source_ref,source_session_id,source_digest,task_intent,status,version,
              idempotency_key,request_digest,attempt_generation,created_at,updated_at
         FROM k12_image_task_dispatches ORDER BY created_at,dispatch_id;`,
    )
    const invocations = sqliteRows(
      databasePath,
      `SELECT invocation_id,dispatch_id,operation,status,attempt,provider_request_key,result_digest,
              request_digest,created_at,updated_at
         FROM k12_image_task_invocations ORDER BY created_at,invocation_id;`,
    )
    const assets = sqliteRows(
      databasePath,
      `SELECT page_asset_id,agent_name,content_digest,media_type,size_bytes,storage_state,created_at,updated_at
         FROM k12_page_assets ORDER BY created_at,page_asset_id;`,
    )
    const knowledge = sqliteRows(
      databasePath,
      `SELECT o.operation_id,o.owner_id,o.corpus_uid,o.idempotency_key,o.request_fingerprint,o.display_name,
              o.media_type,o.size_bytes,o.content_digest,o.document_id,o.job_id,
              o.state AS ledger_state,j.state AS job_state,j.stage AS job_stage,j.attempt AS job_attempt,
              CASE WHEN o.state <> 'pending_response' AND j.state IS NOT NULL THEN j.state ELSE o.state END
                AS projected_state,
              o.last_error,o.created_at,o.updated_at,j.updated_at AS job_updated_at
         FROM kb_upload_operations o
         LEFT JOIN kb_knowledge_jobs j
           ON j.job_id=o.job_id AND j.owner_id=o.owner_id AND j.corpus_uid=o.corpus_uid
        ORDER BY o.created_at,o.operation_id;`,
    )
    const counts = sqliteRows(
      databasePath,
      `SELECT
         (SELECT COUNT(*) FROM k12_page_assets) AS k12_asset_uploads,
         (SELECT COUNT(*) FROM k12_image_task_dispatches) AS image_task_creates,
         (SELECT COUNT(*) FROM k12_image_task_invocations WHERE operation='classification') AS image_task_provider_invocations,
         (SELECT COUNT(DISTINCT content_digest) FROM k12_page_assets) AS k12_distinct_hashes,
         (SELECT COUNT(*) FROM kb_upload_operations) AS knowledge_uploads,
         (SELECT COUNT(DISTINCT content_digest) FROM kb_upload_operations WHERE content_digest IS NOT NULL) AS knowledge_distinct_hashes;`,
    )[0]
    return { ready: true, dispatches, invocations, assets, knowledge, counts }
  } catch (error) {
    return { ready: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function snapshotIdentity(snapshot) {
  assert.equal(snapshot.ready, true, snapshot.error || 'SQLite snapshot is unavailable')
  assert.equal(snapshot.dispatches.length, 1, 'Expected exactly one ImageTask dispatch')
  assert.equal(snapshot.invocations.length, 1, 'Expected exactly one ImageTask invocation')
  assert.equal(snapshot.assets.length, 1, 'Expected exactly one K12 immutable asset')
  assert.equal(snapshot.knowledge.length, 1, 'Expected exactly one Knowledge upload operation')
  const dispatch = snapshot.dispatches[0]
  const invocation = snapshot.invocations[0]
  const asset = snapshot.assets[0]
  const knowledge = snapshot.knowledge[0]
  assert.equal(dispatch.status, 'awaiting_confirmation')
  assert.equal(dispatch.task_intent, 'unknown')
  assert.equal(invocation.operation, 'classification')
  assert.equal(invocation.status, 'succeeded')
  assert.equal(invocation.attempt, 1)
  assert.equal(asset.storage_state, 'ready')
  assert.equal(knowledge.ledger_state, 'queued')
  assert.equal(knowledge.job_state, 'succeeded')
  assert.equal(knowledge.projected_state, 'succeeded')
  assert.equal(knowledge.job_attempt, 1)
  assert.match(asset.content_digest, /^[0-9a-f]{64}$/)
  assert.match(knowledge.content_digest, /^[0-9a-f]{64}$/)
  assert.deepEqual(snapshot.counts, {
    k12_asset_uploads: 1,
    image_task_creates: 1,
    image_task_provider_invocations: 1,
    k12_distinct_hashes: 1,
    knowledge_uploads: 1,
    knowledge_distinct_hashes: 1,
  })
  return {
    dispatchID: dispatch.dispatch_id,
    dispatchStatus: dispatch.status,
    dispatchVersion: dispatch.version,
    dispatchDigest: dispatch.source_digest,
    invocationID: invocation.invocation_id,
    invocationStatus: invocation.status,
    invocationAttempt: invocation.attempt,
    assetID: asset.page_asset_id,
    assetDigest: asset.content_digest,
    knowledgeOperationID: knowledge.operation_id,
    knowledgeDocumentID: knowledge.document_id,
    knowledgeJobID: knowledge.job_id,
    knowledgeStatus: knowledge.projected_state,
    knowledgeLedgerState: knowledge.ledger_state,
    knowledgeJobState: knowledge.job_state,
    knowledgeDigest: knowledge.content_digest,
  }
}

function assertStableSnapshots(snapshots) {
  const expectedStages = ['initial', 'route-remount', 'webview-reload', 'sidecar-restart', 'app-restart']
  assert.deepEqual(Object.keys(snapshots), expectedStages)
  const initial = snapshotIdentity(snapshots.initial)
  for (const stage of expectedStages.slice(1)) {
    assert.deepEqual(snapshotIdentity(snapshots[stage]), initial, `${stage} changed durable identity or terminal state`)
  }
  return initial
}

async function readBody(request, maxBytes = 2 * 1024 * 1024) {
  const chunks = []
  let total = 0
  for await (const chunk of request) {
    total += chunk.length
    if (total > maxBytes) throw new Error(`Loopback body exceeds ${maxBytes} bytes`)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function corsHeaders(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    ...extra,
  }
}

function jsonResponse(response, status, body) {
  response.writeHead(status, corsHeaders({ 'Content-Type': 'application/json' }))
  response.end(JSON.stringify(body))
}

function streamResponse(response, completion) {
  response.writeHead(200, corsHeaders({ 'Content-Type': 'text/event-stream' }))
  response.write(`data: ${JSON.stringify(completion)}\n\n`)
  response.write('data: [DONE]\n\n')
  response.end()
}

function providerCompletion(response, payload, id, content) {
  const completion = {
    id,
    object: payload.stream ? 'chat.completion.chunk' : 'chat.completion',
    created: 0,
    model: 'fixture-vision',
    choices: payload.stream
      ? [{ index: 0, delta: { role: 'assistant', content }, finish_reason: 'stop' }]
      : [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  }
  if (payload.stream) streamResponse(response, completion)
  else jsonResponse(response, 200, completion)
}

async function startLoopbackFixture(databasePath, sidecarPort) {
  const reportDeferred = deferred()
  const restartDeferred = deferred()
  const state = {
    phase: 'initial',
    identity: null,
    progress: [],
    snapshots: {},
    protocolErrors: [],
    unexpectedPaths: [],
    provider: {
      modelLists: 0,
      classification: 0,
      embeddings: 0,
      knowledgeEmbeddings: 0,
      probeEmbeddings: 0,
      warmupChat: 0,
      external: 0,
      chatShapes: [],
    },
    sidecarPids: {},
    appRestartRequested: false,
  }
  let reportResolved = false
  let restartResolved = false
  const server = createServer(async (request, response) => {
    try {
      if (request.method === 'OPTIONS') {
        response.writeHead(204, corsHeaders())
        response.end()
        return
      }
      const url = new URL(request.url || '/', 'http://127.0.0.1')
      if (request.method === 'GET' && url.pathname === '/__bug016/state') {
        jsonResponse(response, 200, { phase: state.phase, identity: state.identity })
        return
      }
      if (request.method === 'POST' && url.pathname === '/__bug016/state') {
        const payload = JSON.parse((await readBody(request)).toString('utf8'))
        assert.ok(['after-reload', 'after-app-restart'].includes(payload.phase))
        assert.ok(payload.identity && typeof payload.identity === 'object')
        state.phase = payload.phase
        state.identity = payload.identity
        jsonResponse(response, 200, { accepted: true })
        return
      }
      if (request.method === 'GET' && url.pathname === '/__bug016/snapshot') {
        jsonResponse(response, 200, snapshotDatabase(databasePath))
        return
      }
      if (request.method === 'POST' && url.pathname === '/__bug016/progress') {
        const payload = JSON.parse((await readBody(request)).toString('utf8'))
        assert.equal(typeof payload.stage, 'string')
        state.progress.push({ stage: payload.stage, at: Date.now() })
        const pids = listenerPids(sidecarPort)
        state.sidecarPids[payload.stage] = pids
        const shouldSnapshot = [
          'initial',
          'route-remount',
          'webview-reload',
          'sidecar-restart',
          'app-restart',
        ].includes(payload.stage)
        const snapshot = shouldSnapshot ? snapshotDatabase(databasePath) : null
        if (snapshot) state.snapshots[payload.stage] = snapshot
        jsonResponse(response, 200, { accepted: true, snapshot, listenerPids: pids })
        return
      }
      if (request.method === 'POST' && url.pathname === '/__bug016/request-app-restart') {
        state.appRestartRequested = true
        jsonResponse(response, 200, { accepted: true })
        if (!restartResolved) {
          restartResolved = true
          restartDeferred.resolve({ requestedAt: Date.now() })
        }
        return
      }
      if (request.method === 'POST' && url.pathname === '/__bug016/complete') {
        const report = JSON.parse((await readBody(request)).toString('utf8'))
        jsonResponse(response, 200, { accepted: true })
        if (!reportResolved) {
          reportResolved = true
          reportDeferred.resolve(report)
        }
        return
      }
      if (url.pathname === '/__bug016/updater') {
        response.writeHead(204, corsHeaders())
        response.end()
        return
      }
      if (request.method === 'GET' && url.pathname === '/v1/models') {
        state.provider.modelLists += 1
        jsonResponse(response, 200, {
          object: 'list',
          data: [
            { id: 'fixture-vision', object: 'model', owned_by: 'loopback' },
            { id: 'fixture-embedding', object: 'model', owned_by: 'loopback' },
          ],
        })
        return
      }
      if (request.method === 'POST' && url.pathname === '/v1/embeddings') {
        assert.equal(request.headers.authorization, `Bearer ${syntheticCredential}`)
        const payload = JSON.parse((await readBody(request)).toString('utf8'))
        assert.equal(payload.model, 'fixture-embedding')
        const inputs = Array.isArray(payload.input) ? payload.input : [payload.input]
        assert.ok(inputs.length > 0)
        state.provider.embeddings += 1
        if (JSON.stringify(inputs).includes('BUG-20260802-016 deterministic Knowledge')) {
          state.provider.knowledgeEmbeddings += 1
        } else {
          state.provider.probeEmbeddings += 1
        }
        jsonResponse(response, 200, {
          object: 'list',
          model: 'fixture-embedding',
          data: inputs.map((_, index) => ({ object: 'embedding', index, embedding: [1, 0, 0] })),
          usage: { prompt_tokens: inputs.length, total_tokens: inputs.length },
        })
        return
      }
      if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
        assert.equal(request.headers.authorization, `Bearer ${syntheticCredential}`)
        const payload = JSON.parse((await readBody(request)).toString('utf8'))
        assert.equal(payload.model, 'fixture-vision')
        const serialized = JSON.stringify(payload.messages || [])
        const hasImage = /data:image\/(?:png|jpeg|webp);base64,/.test(serialized)
        const hasClassifierPrompt = serialized.includes('图片任务分流器')
        state.provider.chatShapes.push({
          hasImage,
          hasClassifierPrompt,
          stream: payload.stream === true,
        })
        if (hasImage || hasClassifierPrompt) {
          state.provider.classification += 1
          providerCompletion(
            response,
            payload,
            'chatcmpl-bug016-classification',
            JSON.stringify({
              task_intent: 'unknown',
              intent_evidence: ['fixture intentionally leaves intent ambiguous'],
              confidence: 0.45,
              confirmation_candidates: ['completed_homework', 'blank_worksheet'],
              work_title_candidate: null,
              task_requirement_candidate: null,
            }),
          )
          return
        }
        state.provider.warmupChat += 1
        providerCompletion(response, payload, 'chatcmpl-bug016-warmup', 'loopback fixture ready')
        return
      }
      state.unexpectedPaths.push(`${request.method || 'GET'} ${url.pathname}`)
      jsonResponse(response, 404, { error: { message: 'Unexpected loopback fixture request' } })
    } catch (error) {
      state.protocolErrors.push(error instanceof Error ? error.message : String(error))
      if (!response.headersSent && !response.destroyed) {
        jsonResponse(response, 500, { error: { message: 'Loopback fixture contract failure' } })
      } else if (!response.destroyed) {
        response.end()
      }
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
    state,
    reportPromise: reportDeferred.promise,
    restartPromise: restartDeferred.promise,
    close: async () => {
      if (!server.listening) return
      server.closeAllConnections?.()
      await new Promise((resolvePromise, reject) => {
        server.close((error) => (error ? reject(error) : resolvePromise()))
      })
    },
  }
}

function injectedLifecycleFixture() {
  'use strict'
  const config = globalThis.__BUG016_LIFECYCLE_CONFIG__
  const fixtureOrigin = config.fixtureOrigin
  const startedAt = Date.now()
  let terminalSent = false
  sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')

  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
  const invariant = (condition, message) => {
    if (!condition) throw new Error(message)
  }
  const cleanText = (value) => String(value || '').replace(/\s+/g, ' ').trim()

  async function json(path, init) {
    const response = await fetch(fixtureOrigin + path, { cache: 'no-store', ...init })
    if (!response.ok) throw new Error('Fixture request failed: ' + response.status + ' ' + path)
    return response.json()
  }

  async function waitFor(read, label, timeout = 45_000, interval = 100) {
    const deadline = Date.now() + timeout
    let lastError = null
    while (Date.now() < deadline) {
      try {
        const value = await read()
        if (value) return value
      } catch (error) {
        lastError = error
      }
      await sleep(interval)
    }
    throw new Error(
      'Timed out waiting for ' + label + (lastError instanceof Error ? ': ' + lastError.message : ''),
    )
  }

  function enabledButton(root, matcher) {
    return [...root.querySelectorAll('button')].find(
      (button) => !button.disabled && matcher.test(cleanText(button.textContent)),
    )
  }

  function setControlValue(control, value) {
    invariant(control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement, 'Expected text control')
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(control), 'value')
    invariant(typeof descriptor?.set === 'function', 'Native value setter is unavailable')
    descriptor.set.call(control, value)
    control.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }))
    control.dispatchEvent(new Event('change', { bubbles: true }))
  }

  function dispatchFile(input, file) {
    invariant(input instanceof HTMLInputElement, 'Expected native file input')
    invariant(typeof DataTransfer === 'function', 'Native DataTransfer is unavailable')
    const transfer = new DataTransfer()
    transfer.items.add(file)
    Object.defineProperty(input, 'files', { configurable: true, value: transfer.files })
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }

  async function nav(id, ready) {
    const link = await waitFor(() => document.querySelector('[data-nav-id="' + id + '"]'), id + ' navigation')
    link.click()
    await waitFor(() => document.querySelector(ready), id + ' view')
  }

  async function createTutor() {
    await nav('agents', '.hc-agents__content')
    const templates = await waitFor(() => enabledButton(document, /模板库|Templates/i), 'template tab')
    templates.click()
    const template = await waitFor(
      () => [...document.querySelectorAll('button,article,div')].find((node) => cleanText(node.textContent) === '作业辅导助手'),
      'K12 tutor template',
    )
    template.click()
    const form = await waitFor(() => document.querySelector('.k12pf'), 'K12 profile form')
    const childInput = form.querySelector('.k12pf__input')
    setControlValue(childInput, config.childName)
    const triggers = form.querySelectorAll('.hc-select__trigger')
    invariant(triggers.length >= 2, 'K12 grade/semester controls are missing')
    triggers[0].click()
    const grade = await waitFor(
      () => [...document.querySelectorAll('.hc-select__dropdown .hc-select__option')].find((node) => cleanText(node.textContent).includes('六年级')),
      'sixth grade option',
    )
    grade.click()
    triggers[1].click()
    const semester = await waitFor(
      () => [...document.querySelectorAll('.hc-select__dropdown .hc-select__option')].find((node) => cleanText(node.textContent).includes('上学期')),
      'first semester option',
    )
    semester.click()
    const create = await waitFor(() => enabledButton(form, /^创建$|^Create$/i), 'K12 create button')
    create.click()
    await waitFor(() => !document.querySelector('.k12pf'), 'K12 profile form close')
    const mine = await waitFor(() => enabledButton(document, /我的智能体|My Agents/i), 'my agents tab')
    mine.click()
    const card = await waitFor(
      () => [...document.querySelectorAll('.hc-cxcard')].find((node) => cleanText(node.textContent).includes(config.childName)),
      'created K12 card',
    )
    const enter = await waitFor(() => enabledButton(card, /进入辅导|Enter Tutoring/i), 'enter tutoring')
    enter.click()
    await waitFor(() => document.querySelector('.hc-composer input[type="file"]'), 'K12 composer file input')
  }

  async function createImageTask() {
    const input = document.querySelector('.hc-composer input[type="file"]')
    const bytes = Uint8Array.from(atob(config.pngBase64), (value) => value.charCodeAt(0))
    dispatchFile(input, new File([bytes], 'bug016-image.png', { type: 'image/png' }))
    const guard = await waitFor(
      () => {
        const candidate = document.querySelector('[data-testid="recognize-guard"][data-dispatch-id]')
        return candidate?.getAttribute('data-dispatch-id') ? candidate : null
      },
      'ImageTask shell with dispatch id',
      90_000,
    )
    return guard.getAttribute('data-dispatch-id')
  }

  function knowledgeCard() {
    return [...document.querySelectorAll('[data-testid="knowledge-doc-card"]')].find((node) =>
      cleanText(node.textContent).includes(config.knowledgeTitle),
    )
  }

  async function uploadKnowledge() {
    await nav('knowledge', '.knowledge-page')
    const input = document.querySelector('.knowledge-page input[type="file"]')
    dispatchFile(input, new File([config.knowledgeBody], config.knowledgeTitle, { type: 'text/plain' }))
    await waitFor(knowledgeCard, 'Knowledge uploaded document card', 90_000)
  }

  async function durableIdentity() {
    let lastKnowledgeReconcileAt = 0
    const snapshot = await waitFor(async () => {
      const value = await json('/__bug016/snapshot')
      if (!value.ready || value.dispatches?.length !== 1 || value.knowledge?.length !== 1) return null
      if (value.dispatches[0]?.status !== 'awaiting_confirmation') return null
      if (value.knowledge[0]?.projected_state !== 'succeeded') {
        if (Date.now() - lastKnowledgeReconcileAt >= 1_500) {
          lastKnowledgeReconcileAt = Date.now()
          // operation 投影在 Knowledge onMounted 的公开恢复入口同步底层 Job 终态。
          await nav('chat', '[data-testid="chat-input"]')
          await nav('knowledge', '.knowledge-page')
        }
        return null
      }
      return value
    }, 'durable terminal ImageTask and Knowledge projection', 90_000, 250)
    return {
      dispatchID: snapshot.dispatches[0].dispatch_id,
      knowledgeOperationID: snapshot.knowledge[0].operation_id,
      knowledgeDocumentID: snapshot.knowledge[0].document_id,
      knowledgeJobID: snapshot.knowledge[0].job_id,
      dispatchStatus: snapshot.dispatches[0].status,
      knowledgeStatus: snapshot.knowledge[0].projected_state,
    }
  }

  async function assertK12(identity) {
    await nav('chat', '[data-testid="chat-input"]')
    await waitFor(
      () => document.querySelector('[data-testid="recognize-guard"][data-dispatch-id="' + CSS.escape(identity.dispatchID) + '"]'),
      'same recovered ImageTask dispatch',
      60_000,
    )
  }

  async function assertKnowledge() {
    await nav('knowledge', '.knowledge-page')
    await waitFor(knowledgeCard, 'same recovered Knowledge document', 60_000)
  }

  async function checkpoint(stage, identity) {
    const receipt = await json('/__bug016/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage }),
    })
    invariant(receipt.snapshot?.ready, stage + ' database snapshot is unavailable')
    const dispatch = receipt.snapshot.dispatches?.[0]
    const knowledge = receipt.snapshot.knowledge?.[0]
    invariant(dispatch?.dispatch_id === identity.dispatchID, stage + ' changed ImageTask id')
    invariant(knowledge?.operation_id === identity.knowledgeOperationID, stage + ' changed Knowledge operation id')
    invariant(knowledge?.document_id === identity.knowledgeDocumentID, stage + ' changed Knowledge document id')
    invariant(knowledge?.job_id === identity.knowledgeJobID, stage + ' changed Knowledge job id')
    invariant(dispatch?.status === identity.dispatchStatus, stage + ' regressed ImageTask terminal state')
    invariant(knowledge?.projected_state === identity.knowledgeStatus, stage + ' regressed Knowledge terminal state')
    return receipt
  }

  async function initialRun() {
    sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
    await createTutor()
    const domDispatchID = await createImageTask()
    await uploadKnowledge()
    const identity = await durableIdentity()
    invariant(identity.dispatchID === domDispatchID, 'DOM and durable ImageTask ids differ')
    await checkpoint('initial', identity)
    await assertK12(identity)
    await assertKnowledge()
    await checkpoint('route-remount', identity)
    await json('/__bug016/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phase: 'after-reload', identity }),
    })
    location.reload()
  }

  async function afterReload(identity) {
    sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
    await assertK12(identity)
    await assertKnowledge()
    await checkpoint('webview-reload', identity)
    const before = await json('/__bug016/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage: 'before-sidecar-restart' }),
    })
    invariant(before.listenerPids?.length === 1, 'Expected one Sidecar listener before restart')
    const restart = await waitFor(() => document.querySelector('.hc-sidebar__restart-btn'), 'public Sidecar restart button')
    restart.click()
    await waitFor(() => restart.disabled, 'Sidecar restart entering busy state', 10_000)
    await waitFor(() => !restart.disabled, 'Sidecar restart completion', 60_000)
    await assertK12(identity)
    await assertKnowledge()
    const after = await checkpoint('sidecar-restart', identity)
    invariant(after.listenerPids?.length === 1, 'Expected one Sidecar listener after restart')
    invariant(after.listenerPids[0] !== before.listenerPids[0], 'Sidecar PID did not change')
    await json('/__bug016/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phase: 'after-app-restart', identity }),
    })
    await json('/__bug016/request-app-restart', { method: 'POST' })
  }

  async function afterAppRestart(identity) {
    sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
    await assertK12(identity)
    await assertKnowledge()
    await checkpoint('app-restart', identity)
    await complete({
      status: 'PASS',
      identity,
      nativeDOM: { realWKWebView: true, driver: 'temporary current-source Test.app fixture' },
      elapsedMs: Date.now() - startedAt,
    })
  }

  async function complete(report) {
    if (terminalSent) return
    terminalSent = true
    await json('/__bug016/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report),
    })
  }

  async function execute() {
    const state = await json('/__bug016/state')
    if (state.phase === 'initial') return initialRun()
    if (state.phase === 'after-reload') return afterReload(state.identity)
    if (state.phase === 'after-app-restart') return afterAppRestart(state.identity)
    throw new Error('Unknown lifecycle phase: ' + state.phase)
  }

  execute().catch(async (error) => {
    try {
      const guard = document.querySelector('[data-testid="recognize-guard"]')
      await complete({
        status: 'FAIL',
        error: error instanceof Error ? error.message : String(error),
        diagnostic: {
          path: location.pathname,
          guardCount: document.querySelectorAll('[data-testid="recognize-guard"]').length,
          guardDispatchID: guard?.getAttribute('data-dispatch-id') || null,
          guardText: cleanText(guard?.textContent).slice(0, 1200),
        },
      })
    } catch {
      // 主进程超时和 Test.app 日志会保留回传链自身失败。
    }
  })
}

function prepareFrontend(sandbox, fixtureOrigin) {
  const frontend = join(sandbox, 'frontend')
  return runCommand(
    'pnpm',
    ['exec', 'vite', 'build', '--outDir', frontend, '--emptyOutDir'],
    {
      env: {
        ...process.env,
        PNPM_CONFIG_OFFLINE: 'true',
        npm_config_offline: 'true',
      },
    },
  ).then(() => {
    const indexPath = join(frontend, 'index.html')
    assert.ok(existsSync(indexPath), 'Current-source frontend build is missing index.html')
    const fixturePath = join(frontend, 'bug-20260802-016-lifecycle-fixture.js')
    const fixtureConfig = {
      fixtureOrigin,
      childName,
      knowledgeTitle,
      knowledgeBody,
      pngBase64: pngBytes.toString('base64'),
    }
    const fixtureSource = [
      `globalThis.__BUG016_LIFECYCLE_CONFIG__=${JSON.stringify(fixtureConfig)};`,
      `(${injectedLifecycleFixture.toString()})();`,
      '',
    ].join('\n')
    writeFileSync(fixturePath, fixtureSource, { mode: 0o600 })
    const index = readFileSync(indexPath, 'utf8')
    assert.match(index, /<head>/)
    writeFileSync(
      indexPath,
      index.replace(
        '<head>',
        '<head>\n<script src="./bug-20260802-016-lifecycle-fixture.js"></script>',
      ),
      { mode: 0o600 },
    )
    return { frontend, fixturePath, indexPath }
  })
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
  default: fixture-openai
  providers:
    fixture-openai:
      provider_instance_id: pvd_v1_0123456789abcdef0123456789abcdef
      api_key: ${syntheticCredential}
      base_url: ${fixtureOrigin}/v1
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
      locality_source: user
      confirmed_endpoint_host: 127.0.0.1
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
`
}

function writeOverlay(sandbox, frontend, sidecarPort, fixtureOrigin) {
  const overlayPath = join(sandbox, 'tauri.bug016-lifecycle.conf.json')
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "style-src-attr 'unsafe-inline'",
    `img-src 'self' data: blob: http://localhost:${sidecarPort} http://127.0.0.1:${sidecarPort}`,
    `media-src 'self' data: blob: http://localhost:${sidecarPort} http://127.0.0.1:${sidecarPort}`,
    `connect-src 'self' http://localhost:${sidecarPort} ws://localhost:${sidecarPort} http://127.0.0.1:${sidecarPort} ws://127.0.0.1:${sidecarPort} ${fixtureOrigin}`,
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ')
  const overlay = {
    productName: appProductName,
    identifier: appIdentifier,
    build: {
      frontendDist: relative(srcTauriDir, frontend),
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
    bundle: { targets: ['app'], createUpdaterArtifacts: false },
    plugins: {
      updater: {
        endpoints: [`${fixtureOrigin}/__bug016/updater`],
        dangerousInsecureTransportProtocol: true,
      },
    },
  }
  writeFileSync(overlayPath, `${JSON.stringify(overlay, null, 2)}\n`, { mode: 0o600 })
  return overlayPath
}

function appEnvironment(sandbox, tempDir, sidecarPort) {
  return {
    PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: 'zh_CN.UTF-8',
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
    HEXCLAW_DISABLE_BACKGROUND_EGRESS: '1',
    NO_PROXY: '*',
    no_proxy: '*',
  }
}

function launchApp(executable, sandbox, env, logStream) {
  const processHandle = spawn(executable, [], {
    cwd: sandbox,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  processHandle.stdout.pipe(logStream, { end: false })
  processHandle.stderr.pipe(logStream, { end: false })
  return processHandle
}

function sanitizeLog(raw, sandbox) {
  return raw
    .replaceAll(syntheticCredential, '[REDACTED]')
    .replaceAll(repoRoot, '<desktop-repo>')
    .replaceAll(sidecarSourceRoot, '<sidecar-repo>')
    .replaceAll(sandbox, '<sandbox>')
    .replaceAll(process.env.HOME || '<no-home>', '<user-home>')
}

function sourceReceipt() {
  const command = (cwd, args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  return {
    desktop: {
      head: command(repoRoot, ['rev-parse', 'HEAD']),
      status: command(repoRoot, ['status', '--short']),
    },
    sidecar: {
      head: command(sidecarSourceRoot, ['rev-parse', 'HEAD']),
      status: command(sidecarSourceRoot, ['status', '--short']),
    },
    toolchain: {
      node: process.version,
      go: execFileSync('/usr/local/go/bin/go', ['version'], { encoding: 'utf8' }).trim(),
      rustc: execFileSync('rustc', ['--version'], { encoding: 'utf8' }).trim(),
    },
  }
}

async function main() {
  assert.equal(process.platform, 'darwin', 'BUG-016 native lifecycle harness is macOS-only')
  assert.ok(existsSync(join(repoRoot, 'package.json')), 'Desktop source root is missing')
  assert.ok(existsSync(join(sidecarSourceRoot, 'cmd/hexclaw')), 'Sidecar source root is missing')
  mkdirSync(evidenceRoot, { recursive: true })
  for (const name of ['report.json', 'failure.json', 'cleanup.json', 'app.log']) {
    rmSync(join(evidenceRoot, name), { force: true })
  }

  const sandbox = mkdtempSync(join(tmpdir(), 'hexclaw-bug016-lifecycle.'))
  chmodSync(sandbox, 0o700)
  const configDir = join(sandbox, '.hexclaw')
  const tempDir = join(sandbox, 'tmp')
  const cargoTarget = join(sandbox, 'cargo-target')
  mkdirSync(configDir, { mode: 0o700 })
  mkdirSync(tempDir, { mode: 0o700 })
  chmodSync(configDir, 0o700)
  chmodSync(tempDir, 0o700)
  const databasePath = join(configDir, 'data.db')
  const sidecarPort = await reserveLoopbackPort()
  assert.deepEqual(listenerPids(sidecarPort), [])

  let appProcess = null
  let appBundle = ''
  let appLogStream = null
  let loopback = null
  let report = null
  let failure = null
  let finalStatus = 'FAIL'
  const cleanup = {
    appPids: [],
    sidecarPids: [],
    unexpectedPortOwners: [],
    portReleased: false,
    fixtureClosed: false,
    sandboxRemoved: false,
  }
  const appRawLog = join(sandbox, 'app.log')

  try {
    loopback = await startLoopbackFixture(databasePath, sidecarPort)
    const configPath = join(configDir, 'hexclaw.yaml')
    writeFileSync(configPath, renderConfig(sandbox, sidecarPort, loopback.origin), { mode: 0o600 })
    chmodSync(configPath, 0o600)
    const frontend = await prepareFrontend(sandbox, loopback.origin)
    const overlayPath = writeOverlay(sandbox, frontend.frontend, sidecarPort, loopback.origin)
    const offlineEnv = {
      ...process.env,
      CARGO_NET_OFFLINE: 'true',
      CARGO_TARGET_DIR: cargoTarget,
      GOENV: 'off',
      GOPROXY: 'off',
      GOSUMDB: 'off',
      PNPM_CONFIG_OFFLINE: 'true',
      npm_config_offline: 'true',
    }
    delete offlineEnv.GOROOT
    await runCommand(
      'pnpm',
      ['exec', 'tauri', 'build', '--config', overlayPath, '--bundles', 'app'],
      { env: offlineEnv },
    )
    appBundle = join(cargoTarget, `release/bundle/macos/${appProductName}.app`)
    const executable = join(appBundle, 'Contents/MacOS/hexclaw-desktop')
    const packagedSidecar = join(appBundle, 'Contents/MacOS/hexclaw')
    const infoPlist = join(appBundle, 'Contents/Info.plist')
    assert.ok(existsSync(executable), 'Temporary Test.app executable is missing')
    assert.ok(existsSync(packagedSidecar), 'Temporary packaged Sidecar is missing')
    assert.ok(existsSync(infoPlist), 'Temporary Test.app Info.plist is missing')
    const identifier = execFileSync(
      'plutil',
      ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', infoPlist],
      { encoding: 'utf8' },
    ).trim()
    assert.equal(identifier, appIdentifier)
    const currentSidecar = join(sandbox, 'hexclaw-current-source')
    await runCommand(
      '/usr/local/go/bin/go',
      ['build', '-trimpath', '-o', currentSidecar, './cmd/hexclaw'],
      { cwd: sidecarSourceRoot, env: offlineEnv },
    )
    writeFileSync(packagedSidecar, readFileSync(currentSidecar), { mode: 0o755 })
    chmodSync(packagedSidecar, 0o755)
    assert.deepEqual(listenerPids(sidecarPort), [])

    appLogStream = createWriteStream(appRawLog, { flags: 'wx', mode: 0o600 })
    const env = appEnvironment(sandbox, tempDir, sidecarPort)
    appProcess = launchApp(executable, sandbox, env, appLogStream)
    cleanup.appPids.push(appProcess.pid)
    await waitForHealth(sidecarPort, appProcess)

    let boundaryTimer
    const firstBoundary = await Promise.race([
      loopback.restartPromise.then((value) => ({ kind: 'restart', value })),
      loopback.reportPromise.then((value) => ({ kind: 'report', value })),
      new Promise((_, reject) => {
        boundaryTimer = setTimeout(() => reject(new Error('Lifecycle boundary timed out before App restart')), lifecycleTimeoutMs)
      }),
    ])
    clearTimeout(boundaryTimer)
    if (firstBoundary.kind === 'report') {
      report = firstBoundary.value
      assert.equal(report.status, 'PASS', report.error || 'WebView failed before App restart')
      throw new Error('WebView completed without exercising App restart')
    }

    const firstAppPID = appProcess.pid
    await stopProcess(appProcess)
    const afterFirstStop = await stopOwnedSidecar(sidecarPort, appBundle)
    cleanup.sidecarPids.push(...afterFirstStop.owned)
    cleanup.unexpectedPortOwners.push(...afterFirstStop.unexpected)
    assert.deepEqual(afterFirstStop.unexpected, [])
    assert.equal(afterFirstStop.released, true)
    appProcess = launchApp(executable, sandbox, env, appLogStream)
    cleanup.appPids.push(appProcess.pid)
    assert.notEqual(appProcess.pid, firstAppPID, 'App PID did not change')
    await waitForHealth(sidecarPort, appProcess)

    let reportTimer
    try {
      report = await Promise.race([
        loopback.reportPromise,
        new Promise((_, reject) => {
          reportTimer = setTimeout(() => reject(new Error('Lifecycle boundary timed out after App restart')), lifecycleTimeoutMs)
        }),
      ])
    } finally {
      clearTimeout(reportTimer)
    }
    assert.equal(report?.status, 'PASS', report?.error || 'WebView lifecycle failed')
    assert.deepEqual(loopback.state.protocolErrors, [])
    assert.deepEqual(loopback.state.unexpectedPaths, [])
    assert.equal(loopback.state.appRestartRequested, true)
    assert.equal(loopback.state.provider.classification, 1)
    assert.equal(loopback.state.provider.knowledgeEmbeddings, 1)

    const durableIdentity = assertStableSnapshots(loopback.state.snapshots)
    assert.deepEqual(report.identity, {
      dispatchID: durableIdentity.dispatchID,
      knowledgeOperationID: durableIdentity.knowledgeOperationID,
      knowledgeDocumentID: durableIdentity.knowledgeDocumentID,
      knowledgeJobID: durableIdentity.knowledgeJobID,
      dispatchStatus: durableIdentity.dispatchStatus,
      knowledgeStatus: durableIdentity.knowledgeStatus,
    })
    const sidecarBefore = loopback.state.sidecarPids['before-sidecar-restart'] || []
    const sidecarAfter = loopback.state.sidecarPids['sidecar-restart'] || []
    assert.equal(sidecarBefore.length, 1)
    assert.equal(sidecarAfter.length, 1)
    assert.notEqual(sidecarBefore[0], sidecarAfter[0])
    const appRestartPids = loopback.state.sidecarPids['app-restart'] || []
    assert.equal(appRestartPids.length, 1)
    assert.notEqual(appRestartPids[0], sidecarAfter[0])
    const rawLog = readFileSync(appRawLog, 'utf8')
    assert.doesNotMatch(rawLog, /localhost:11434|127\.0\.0\.1:11434/)

    const evidence = {
      status: 'PASS',
      bug: 'BUG-20260802-016',
      acceptance: ['RECOVERY-001', 'RECOVERY-002', 'RECOVERY-003'],
      source: sourceReceipt(),
      isolation: {
        bundleIdentifier: appIdentifier,
        productName: appProductName,
        testHomeMode: '0700',
        configMode: '0600',
        appInstalledToApplications: false,
        userHomeReadOrWritten: false,
        fixtureBinding: '127.0.0.1',
        sidecarPort,
        providerOrigin: loopback.origin,
        externalProviderInvocations: 0,
        realModelInvocations: 0,
      },
      currentSourceBuild: {
        frontendIndexSha256: sha256File(frontend.indexPath),
        injectedFixtureSha256: sha256File(frontend.fixturePath),
        appExecutableSha256: sha256File(executable),
        sidecarExecutableSha256: sha256File(packagedSidecar),
      },
      appLifecycle: { pids: cleanup.appPids },
      sidecarLifecycle: {
        beforePublicRestart: sidecarBefore,
        afterPublicRestart: sidecarAfter,
        afterAppRestart: appRestartPids,
      },
      lifecycleCheckpoints: loopback.state.progress,
      durableIdentity,
      physicalCounts: loopback.state.snapshots.initial.counts,
      providerCounts: loopback.state.provider,
      snapshots: loopback.state.snapshots,
      webViewReport: report,
    }
    writeFileSync(join(evidenceRoot, 'report.json'), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 })
    finalStatus = 'PASS'
    process.stdout.write(`\nBUG-20260802-016 native lifecycle PASS: ${relative(repoRoot, join(evidenceRoot, 'report.json'))}\n`)
  } catch (error) {
    failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    writeFileSync(
      join(evidenceRoot, 'failure.json'),
      `${JSON.stringify(
        {
          status: 'FAIL',
          error: failure,
          boundaryEvidence:
            report?.error === 'Timed out waiting for same recovered ImageTask dispatch'
              ? {
                  levels: ['E2', 'E3'],
                  boundary: 'public route remount: Knowledge -> Chat',
                  observed: 'durable ImageTask remained present but the recovered recognize guard was absent',
                  desktopContract: {
                    file: 'src/api/k12.ts',
                    fields: ['source_session', 'source_message_id', 'dispatch.dispatch_id'],
                    consumer: 'src/features/k12/image-task-binding.ts',
                  },
                  sidecarContract: {
                    file: 'scenarios/k12/apihttp/image_task_handler.go',
                    fields: ['source_session_id', 'source_message_id', 'dispatch_id'],
                    shape: 'flat',
                  },
                  mismatch: 'Desktop ignores every flat Sidecar recoverable item, so the runtime binding remains empty',
                }
              : null,
          webViewReport: report,
          fixture: loopback?.state || null,
          database: snapshotDatabase(databasePath),
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    )
    throw error
  } finally {
    await stopProcess(appProcess)
    if (appLogStream) await new Promise((resolvePromise) => appLogStream.end(resolvePromise))
    const sidecarCleanup = appBundle
      ? await stopOwnedSidecar(sidecarPort, appBundle)
      : { owned: [], unexpected: [], released: listenerPids(sidecarPort).length === 0 }
    cleanup.sidecarPids.push(...sidecarCleanup.owned)
    cleanup.unexpectedPortOwners.push(...sidecarCleanup.unexpected)
    cleanup.portReleased = sidecarCleanup.released
    if (loopback) {
      await loopback.close()
      cleanup.fixtureClosed = true
    }
    if (existsSync(appRawLog)) {
      writeFileSync(join(evidenceRoot, 'app.log'), sanitizeLog(readFileSync(appRawLog, 'utf8'), sandbox), { mode: 0o600 })
    }
    rmSync(sandbox, { recursive: true, force: true })
    cleanup.sandboxRemoved = !existsSync(sandbox)
    writeFileSync(
      join(evidenceRoot, 'cleanup.json'),
      `${JSON.stringify({ status: finalStatus, error: failure, ...cleanup }, null, 2)}\n`,
      { mode: 0o600 },
    )
    assert.equal(cleanup.portReleased, true, 'Dedicated Sidecar port was not released')
    assert.deepEqual(cleanup.unexpectedPortOwners, [], 'Dedicated port had an unexpected owner')
  }
}

if (process.argv.includes('--validate')) {
  assert.match(injectedLifecycleFixture.toString(), /sidecar-restart/)
  assert.match(injectedLifecycleFixture.toString(), /after-app-restart/)
  assert.match(renderConfig('/tmp/bug016', 12345, 'http://127.0.0.1:23456'), /fixture-openai/)
  process.stdout.write('BUG-20260802-016 lifecycle harness validation PASS\n')
} else {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
