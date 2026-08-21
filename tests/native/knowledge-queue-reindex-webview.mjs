#!/usr/bin/env node

/**
 * 知识库队列取消与重建投影的原生 WebView 边界。
 *
 * 当前生产前端会被复制到临时目录，只有该副本注入同目录 fixture。运行时使用
 * 临时 HOME、SQLite、随机回环 Sidecar 端口和本地模型 fixture；不会读取用户知识库、
 * 访问 Ollama 或连接外网。
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
const fixtureSourcePath = join(nativeDir, 'knowledge-queue-reindex-webview-fixture.js')
const artifactRoot = resolve(
  process.env.HEX_KNOWLEDGE_WEBVIEW_ARTIFACT_DIR ||
    join(repoRoot, 'test-results/native-knowledge-queue-reindex-webview'),
)
const runDir = join(artifactRoot, `run-${Date.now()}`)
const queueCancelOnly = process.argv.includes('--queue-cancel-only')
const appProductName = 'HexClaw Knowledge WebView Test'
const appIdentifier = 'com.hexclaw.desktop.knowledge-webview-boundary'
const syntheticCredential = 'local-synthetic-credential'
const nativeFileGrantPurpose = 'knowledge_upload'
const commandTimeoutMs = 14 * 60 * 1000
const transportReceiptHookName = '__HEXCLAW_TEST_SIDECAR_RECEIPT__'
const cancellationProjectionHookName = '__HEXCLAW_TEST_QUEUE_CANCEL_PROJECTION__'
const cancellationProbePath = '/__knowledge_webview_boundary__/cancel-probe'
const sidecarFetchCallNeedle =
  'const _=await l("sidecar_fetch",{method:r.method,path:n,headers:o,body:i,cancellationId:c,onRegistered:f})'
const cancellationResultNeedle =
  'const s=await Jt(e.jobId);s.state==="cancelled"?te.markCancelled(e):s.state==="succeeded"?(te.markSucceeded(e),await st(!0)):e.cancelling=!1'
const cancellationErrorNeedle =
  '}catch(s){e.cancelling=!1,i.value=s instanceof Error?s.message:o("knowledge.uploadFailed"),M.value="error"}'
const transportReceiptResponseFields = [
  'id',
  'document_id',
  'job_id',
  'job_state',
  'state',
  'stage',
  'vector_index_state',
  'vector_job_id',
  'vector_job_state',
  'operation_id',
]

function javascriptAssets(frontend) {
  const assetsDir = join(frontend, 'assets')
  assert.ok(existsSync(assetsDir), 'Temporary production asset directory is missing')
  return readdirSync(assetsDir)
    .filter((entry) => entry.endsWith('.js'))
    .sort()
    .map((entry) => join(assetsDir, entry))
}

function countOccurrences(source, needle) {
  let count = 0
  let offset = 0
  while (true) {
    const index = source.indexOf(needle, offset)
    if (index < 0) return count
    count += 1
    offset = index + needle.length
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function temporarySidecarFetchReplacement() {
  const allowlistedFields = JSON.stringify(transportReceiptResponseFields)
  return [
    `const __hexclawTestReceiptHook=globalThis.${transportReceiptHookName};`,
    'const __hexclawTestPost=r.method==="POST"&&(/^\\/api\\/v1\\/knowledge\\/documents\\/[^/]+\\/reindex(?:\\?.*)?$/.test(n)||/^\\/api\\/v1\\/knowledge\\/jobs\\/[^/]+\\/cancel(?:\\?.*)?$/.test(n));',
    'const __hexclawTestGet=r.method==="GET"&&(/^\\/api\\/v1\\/knowledge\\/documents\\/[^/]+(?:\\?.*)?$/.test(n)||/^\\/api\\/v1\\/knowledge\\/jobs\\/[^/]+(?:\\?.*)?$/.test(n));',
    'const __hexclawTestObserve=Boolean(__hexclawTestReceiptHook)&&(__hexclawTestPost||__hexclawTestGet);',
    'if(__hexclawTestObserve)queueMicrotask(()=>{try{__hexclawTestReceiptHook({phase:"issued",method:r.method,path:n})}catch{}});',
    sidecarFetchCallNeedle,
    `;if(__hexclawTestObserve){let __hexclawTestReceiptFields={};try{const __hexclawTestReceiptPayload=JSON.parse(new TextDecoder().decode(new Uint8Array(_.body)));for(const __hexclawTestReceiptKey of ${allowlistedFields}){const __hexclawTestReceiptValue=__hexclawTestReceiptPayload?.[__hexclawTestReceiptKey];if(__hexclawTestReceiptValue===null||["string","number","boolean"].includes(typeof __hexclawTestReceiptValue))__hexclawTestReceiptFields[__hexclawTestReceiptKey]=__hexclawTestReceiptValue}}catch{}queueMicrotask(()=>{try{__hexclawTestReceiptHook({phase:"responded",method:r.method,path:n,status:_.status,fields:__hexclawTestReceiptFields})}catch{}})}`,
  ].join('')
}

function instrumentTemporarySidecarFetch(frontend) {
  const candidates = javascriptAssets(frontend).flatMap((asset) => {
    const source = readFileSync(asset, 'utf8')
    return countOccurrences(source, sidecarFetchCallNeedle) === 1 ? [asset] : []
  })
  assert.equal(
    candidates.length,
    1,
    'Temporary production copy must expose exactly one sidecar_fetch transform target',
  )
  const asset = candidates[0]
  const originalBytes = readFileSync(asset)
  const original = originalBytes.toString('utf8')
  assert.equal(
    countOccurrences(original, sidecarFetchCallNeedle),
    1,
    'Temporary production copy must expose one sidecar_fetch call occurrence',
  )
  const offset = original.indexOf(sidecarFetchCallNeedle)
  const replacement = temporarySidecarFetchReplacement()
  const modified =
    original.slice(0, offset) + replacement + original.slice(offset + sidecarFetchCallNeedle.length)
  assert.notEqual(
    modified,
    original,
    'Temporary transport instrumentation must change the copied asset',
  )
  assert.equal(
    countOccurrences(modified, sidecarFetchCallNeedle),
    1,
    'Instrumented copy must retain exactly one sidecar_fetch call',
  )
  assert.equal(
    modified.indexOf(replacement),
    offset,
    'Temporary transport instrumentation must replace only the matched call site',
  )
  const modifiedBytes = Buffer.from(modified, 'utf8')
  writeFileSync(asset, modifiedBytes, { mode: 0o600 })
  const persisted = readFileSync(asset)
  assert.equal(
    sha256(persisted),
    sha256(modifiedBytes),
    'Temporary instrumentation write did not persist',
  )
  return {
    asset: relative(frontend, asset),
    targetOccurrences: 1,
    original: {
      sha256: sha256(originalBytes),
      bytes: originalBytes.byteLength,
    },
    modified: {
      sha256: sha256(modifiedBytes),
      bytes: modifiedBytes.byteLength,
    },
    exactDiff: {
      offset,
      removed: sidecarFetchCallNeedle,
      inserted: replacement,
    },
  }
}

function temporaryCancellationResultReplacement(fixtureOrigin) {
  const probeURL = JSON.stringify(`${fixtureOrigin}${cancellationProbePath}`)
  return [
    'const s=await Jt(e.jobId);',
    `queueMicrotask(()=>{try{globalThis.${cancellationProjectionHookName}?.({phase:"resolved",state:typeof s?.state==="string"?s.state:null,stateType:typeof s?.state})}catch{}});`,
    `void fetch(${probeURL},{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({phase:"resolved",state:typeof s?.state==="string"?s.state:null,stateType:typeof s?.state})}).catch(()=>{});`,
    `s.state==="cancelled"?(()=>{try{const __hexclawItems=Array.isArray(te.items)?te.items:Array.isArray(te.items?.value)?te.items.value:[];void fetch(${probeURL},{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({phase:"before-mark",rows:document.querySelectorAll('[data-testid="knowledge-upload-job"]').length,storeItems:__hexclawItems.length,contains:__hexclawItems.includes(e),entryStatus:e.status})}).catch(()=>{});te.markCancelled(e);const __hexclawItemsAfter=Array.isArray(te.items)?te.items:Array.isArray(te.items?.value)?te.items.value:[];void fetch(${probeURL},{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({phase:"after-mark-sync",rows:document.querySelectorAll('[data-testid="knowledge-upload-job"]').length,storeItems:__hexclawItemsAfter.length,contains:__hexclawItemsAfter.includes(e),entryStatus:e.status})}).catch(()=>{})}catch(__hexclawMarkError){void fetch(${probeURL},{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({phase:"mark-error",errorKind:__hexclawMarkError instanceof Error?__hexclawMarkError.name:"non-error"})}).catch(()=>{});throw __hexclawMarkError}})():s.state==="succeeded"?(te.markSucceeded(e),await st(!0)):e.cancelling=!1`,
  ].join('')
}

function temporaryCancellationErrorReplacement(fixtureOrigin) {
  return [
    '}catch(s){',
    `queueMicrotask(()=>{try{globalThis.${cancellationProjectionHookName}?.({phase:"rejected",errorKind:s instanceof Error?s.name:"non-error"})}catch{}});`,
    `void fetch(${JSON.stringify(`${fixtureOrigin}${cancellationProbePath}`)},{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({phase:"rejected",errorKind:s instanceof Error?s.name:"non-error"})}).catch(()=>{});`,
    'e.cancelling=!1,i.value=s instanceof Error?s.message:o("knowledge.uploadFailed"),M.value="error"}',
  ].join('')
}

function instrumentTemporaryCancellationProjection(frontend, fixtureOrigin) {
  const candidates = javascriptAssets(frontend).flatMap((asset) => {
    const source = readFileSync(asset, 'utf8')
    return countOccurrences(source, cancellationResultNeedle) === 1 ? [asset] : []
  })
  assert.equal(
    candidates.length,
    1,
    'Temporary production copy must expose exactly one cancellable upload-result target',
  )
  const asset = candidates[0]
  const originalBytes = readFileSync(asset)
  const original = originalBytes.toString('utf8')
  assert.equal(countOccurrences(original, cancellationResultNeedle), 1)
  assert.equal(countOccurrences(original, cancellationErrorNeedle), 1)
  const resultReplacement = temporaryCancellationResultReplacement(fixtureOrigin)
  const errorReplacement = temporaryCancellationErrorReplacement(fixtureOrigin)
  const resultOffset = original.indexOf(cancellationResultNeedle)
  const errorOffset = original.indexOf(cancellationErrorNeedle)
  const modified = original
    .replace(cancellationResultNeedle, resultReplacement)
    .replace(cancellationErrorNeedle, errorReplacement)
  assert.equal(countOccurrences(modified, cancellationResultNeedle), 0)
  assert.equal(countOccurrences(modified, cancellationErrorNeedle), 0)
  const modifiedBytes = Buffer.from(modified, 'utf8')
  writeFileSync(asset, modifiedBytes, { mode: 0o600 })
  assert.equal(
    sha256(readFileSync(asset)),
    sha256(modifiedBytes),
    'Temporary cancellation projection instrumentation did not persist',
  )
  return {
    asset: relative(frontend, asset),
    original: { sha256: sha256(originalBytes), bytes: originalBytes.byteLength },
    modified: { sha256: sha256(modifiedBytes), bytes: modifiedBytes.byteLength },
    exactDiff: [
      { offset: resultOffset, removed: cancellationResultNeedle, inserted: resultReplacement },
      { offset: errorOffset, removed: cancellationErrorNeedle, inserted: errorReplacement },
    ],
  }
}

function assertTransportReceiptContract() {
  const fixture = readFileSync(fixtureSourcePath, 'utf8')
  assert.match(
    fixture,
    new RegExp(transportReceiptHookName),
    'Temporary WebView fixture must install the transport receipt hook',
  )
  assert.match(
    fixture,
    /transportReceiptResponseFields/,
    'Temporary WebView fixture must retain only an allowlisted response summary',
  )
  assert.match(
    fixture,
    /watchdog-timeout/,
    'Temporary WebView fixture must retain a bounded watchdog diagnostic stage',
  )
  assert.match(
    fixture,
    /reindex-detail-projected/,
    'Temporary WebView fixture must observe the canonical document projection read',
  )
  assert.match(
    fixture,
    /reindex-job-polled/,
    'Temporary WebView fixture must observe the reindex child job poll',
  )
  assert.match(
    fixture,
    /Fixture stats request timed out/,
    'Temporary WebView fixture must bound every stats request',
  )
  assert.match(
    temporarySidecarFetchReplacement(),
    /phase:"issued"/,
    'Temporary transport instrumentation must observe the issued IPC request',
  )
  assert.match(
    temporarySidecarFetchReplacement(),
    /phase:"responded"/,
    'Temporary transport instrumentation must observe the sidecar response',
  )
  assert.match(
    temporarySidecarFetchReplacement(),
    /__hexclawTestGet/,
    'Temporary transport instrumentation must observe only allowlisted knowledge GET routes',
  )
  assert.match(
    fixture,
    /document-detail/,
    'Temporary WebView fixture must retain the document detail receipt kind',
  )
  assert.match(
    fixture,
    /job-poll/,
    'Temporary WebView fixture must retain the child job poll receipt kind',
  )
  assert.match(
    fixture,
    /__HEXCLAW_TEST_QUEUE_CANCEL_ONLY__/,
    'Temporary WebView fixture must support the queue-cancel-only isolation mode',
  )
  assert.match(
    fixture,
    new RegExp(cancellationProjectionHookName),
    'Temporary WebView fixture must retain the cancellation projection observer',
  )
  const assets = javascriptAssets(join(repoRoot, 'dist'))
  const matches = assets.filter(
    (asset) => countOccurrences(readFileSync(asset, 'utf8'), sidecarFetchCallNeedle) > 0,
  )
  assert.equal(
    matches.length,
    1,
    'Current dist must expose exactly one transformable sidecar_fetch call',
  )
  assert.equal(
    countOccurrences(readFileSync(matches[0], 'utf8'), sidecarFetchCallNeedle),
    1,
    'Current dist must expose exactly one transformable sidecar_fetch call occurrence',
  )
  const cancellationAssets = assets.filter(
    (asset) => countOccurrences(readFileSync(asset, 'utf8'), cancellationResultNeedle) > 0,
  )
  assert.equal(
    cancellationAssets.length,
    1,
    'Current dist must expose exactly one cancellable upload-result target',
  )
  assert.equal(countOccurrences(readFileSync(cancellationAssets[0], 'utf8'), cancellationErrorNeedle), 1)
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
}

function createDeferred() {
  let resolvePromise
  const promise = new Promise((resolve) => {
    resolvePromise = resolve
  })
  return { promise, resolve: resolvePromise }
}

function runCommand(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    process.stdout.write(`\n[knowledge-webview-boundary] ${command} ${args.join(' ')}\n`)
    const child = spawn(command, args, {
      cwd: options.cwd || repoRoot,
      env: options.env || process.env,
      stdio: 'inherit',
    })
    let settled = false
    const settle = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      result()
    }
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      settle(() => reject(new Error(`Command timed out: ${command} ${args.join(' ')}`)))
    }, options.timeoutMs || commandTimeoutMs)
    child.once('error', (error) => settle(() => reject(error)))
    child.once('exit', (code, signal) => {
      if (code === 0) settle(resolvePromise)
      else
        settle(() =>
          reject(new Error(`Command failed (${code ?? signal}): ${command} ${args.join(' ')}`)),
        )
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
    Connection: 'close',
  })
  response.end(body)
}

function streamResponse(response, value) {
  response.writeHead(200, {
    'Cache-Control': 'no-cache',
    Connection: 'close',
    'Content-Type': 'text/event-stream; charset=utf-8',
  })
  response.end(`data: ${JSON.stringify(value)}\n\ndata: [DONE]\n\n`)
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

function fixtureChatSuccess(response, payload, id) {
  const completion = {
    id,
    object: payload.stream ? 'chat.completion.chunk' : 'chat.completion',
    created: 0,
    model: 'fixture-vision',
    choices: payload.stream
      ? [
          {
            index: 0,
            delta: { role: 'assistant', content: 'fixture image caption' },
            finish_reason: 'stop',
          },
        ]
      : [
          {
            index: 0,
            message: { role: 'assistant', content: 'fixture image caption' },
            finish_reason: 'stop',
          },
        ],
  }
  if (payload.stream) streamResponse(response, completion)
  else jsonResponse(response, 200, completion)
}

function canonicalKnowledgePath(path) {
  if (typeof path !== 'string') return null
  return path.split('?', 1)[0]
}

function observedKnowledgeTransportKind(method, path) {
  const canonicalPath = canonicalKnowledgePath(path)
  if (!canonicalPath) return null
  if (
    method === 'POST' &&
    /^\/api\/v1\/knowledge\/documents\/[^/]+\/reindex$/.test(canonicalPath)
  ) {
    return 'reindex'
  }
  if (method === 'POST' && /^\/api\/v1\/knowledge\/jobs\/[^/]+\/cancel$/.test(canonicalPath)) {
    return 'cancel'
  }
  if (method === 'GET' && /^\/api\/v1\/knowledge\/documents\/[^/]+$/.test(canonicalPath)) {
    return 'document-detail'
  }
  if (method === 'GET' && /^\/api\/v1\/knowledge\/jobs\/[^/]+$/.test(canonicalPath)) {
    return 'job-poll'
  }
  if (method === 'GET' && canonicalPath === '/api/v1/knowledge/operations') {
    return 'operations-list'
  }
  return null
}

function sanitizeTransportReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object') return null
  const phase = receipt.phase === 'issued' || receipt.phase === 'responded' ? receipt.phase : null
  const method = receipt.method === 'POST' || receipt.method === 'GET' ? receipt.method : null
  const path = typeof receipt.path === 'string' ? receipt.path : null
  const canonicalPath = canonicalKnowledgePath(path)
  const kind = observedKnowledgeTransportKind(method, canonicalPath)
  if (!phase || !method || !canonicalPath || !kind) return null
  const sanitized = { phase, method, path: canonicalPath, kind }
  if (phase === 'responded') {
    if (!Number.isInteger(receipt.status) || receipt.status < 100 || receipt.status > 599)
      return null
    sanitized.status = receipt.status
    const fields = {}
    const rawFields = receipt.fields && typeof receipt.fields === 'object' ? receipt.fields : {}
    for (const key of transportReceiptResponseFields) {
      const value = rawFields[key]
      if (value === null || ['string', 'number', 'boolean'].includes(typeof value))
        fields[key] = value
    }
    sanitized.fields = fields
  }
  return sanitized
}

function captureTransportReceipts(state, receipts) {
  if (!Array.isArray(receipts)) return
  state.transportReceipts = receipts
    .map((receipt) => sanitizeTransportReceipt(receipt))
    .filter(Boolean)
    .slice(-96)
}

function captureCancellationProjections(state, projections) {
  if (!Array.isArray(projections)) return
  state.cancellationProjections = projections
    .flatMap((projection) => {
      if (!projection || typeof projection !== 'object') return []
      if (projection.phase === 'before-mark' || projection.phase === 'after-mark-sync') {
        return [
          {
            phase: projection.phase,
            rows: Number.isInteger(projection.rows) && projection.rows >= 0 ? projection.rows : -1,
            storeItems:
              Number.isInteger(projection.storeItems) && projection.storeItems >= 0
                ? projection.storeItems
                : -1,
            contains: typeof projection.contains === 'boolean' ? projection.contains : null,
            entryStatus: typeof projection.entryStatus === 'string' ? projection.entryStatus : null,
          },
        ]
      }
      if (projection.phase === 'mark-error') {
        return [
          {
            phase: 'mark-error',
            errorKind:
              typeof projection.errorKind === 'string' && projection.errorKind.length <= 64
                ? projection.errorKind
                : 'other',
          },
        ]
      }
      if (projection.phase === 'resolved') {
        const stateValue =
          typeof projection.state === 'string' &&
          ['queued', 'running', 'retry_wait', 'succeeded', 'failed', 'cancelled'].includes(
            projection.state,
          )
            ? projection.state
            : projection.state === null
              ? null
              : undefined
        const stateType =
          typeof projection.stateType === 'string' &&
          ['string', 'undefined', 'object', 'number', 'boolean'].includes(projection.stateType)
            ? projection.stateType
            : 'other'
        return [{ phase: 'resolved', state: stateValue, stateType }]
      }
      if (projection.phase === 'rejected') {
        const errorKind =
          typeof projection.errorKind === 'string' && projection.errorKind.length <= 64
            ? projection.errorKind
            : 'other'
        return [{ phase: 'rejected', errorKind }]
      }
      return []
    })
    .slice(-8)
}

function statsProjection(state) {
  return {
    embeddingRequests: state.embeddingRequests,
    heldEmbeddingRequests: state.heldEmbeddingRequests,
    imageVisionRequests: state.imageVisionRequests,
    heldVisionRequests: state.heldVisionRequests,
    warmupVisionRequests: state.warmupVisionRequests,
    visionClientAborted: state.visionClientAborted,
    updaterRequests: state.updaterRequests,
    externalModelInvocations: state.externalModelInvocations,
    ollamaInvocations: state.ollamaInvocations,
    unexpectedPaths: state.unexpectedPaths,
    protocolErrors: state.protocolErrors,
    progress: state.progress,
    jobSnapshots: state.jobSnapshots,
    transportReceipts: state.transportReceipts,
    cancellationProjections: state.cancellationProjections,
    cancellationProbes: state.cancellationProbes,
    watchdog: state.watchdog,
  }
}

function snapshotKnowledgeJobs(databasePath) {
  if (!existsSync(databasePath)) return { jobs: [], error: 'Test SQLite database is absent' }
  const query = `
SELECT job_id, COALESCE(parent_job_id, '') AS parent_job_id, kind, COALESCE(document_id, '') AS document_id,
       COALESCE(target_revision_id, '') AS target_revision_id, state, stage,
       COALESCE(chunks_done, -1) AS chunks_done, COALESCE(chunks_total, -1) AS chunks_total,
       attempt, cancel_requested, COALESCE(last_error, '') AS last_error,
       created_at, updated_at
FROM kb_knowledge_jobs
ORDER BY created_at ASC, job_id ASC;`
  try {
    const raw = execFileSync('sqlite3', ['-json', '-cmd', '.timeout 2000', databasePath, query], {
      encoding: 'utf8',
    })
    return { jobs: JSON.parse(raw || '[]') }
  } catch (error) {
    return { jobs: [], error: error instanceof Error ? error.message : String(error) }
  }
}

function deriveJobEvidence(jobSnapshots) {
  const snapshot = (stage) => {
    const value = jobSnapshots[stage]
    assert.ok(value, `Missing SQLite job snapshot for ${stage}`)
    assert.equal(value.error, undefined, `SQLite job snapshot failed for ${stage}: ${value.error}`)
    return value.jobs
  }
  const initial = snapshot('manual-document-ready-for-reindex')
  const projected = snapshot('reindex-child-projected')
  const terminal = snapshot('reindex-polled-terminal')
  const initialJobIDs = new Set(initial.map((job) => job.job_id))
  const reindexJobs = projected.filter(
    (job) => job.kind === 'embed_document' && !initialJobIDs.has(job.job_id),
  )
  assert.equal(
    reindexJobs.length,
    1,
    `Expected one newly projected reindex child job, got ${JSON.stringify(reindexJobs)}`,
  )
  const reindexJob = reindexJobs[0]
  assert.ok(
    ['queued', 'running', 'retry_wait'].includes(reindexJob.state),
    `Reindex child is not pollable: ${reindexJob.state}`,
  )
  const terminalReindex = terminal.find((job) => job.job_id === reindexJob.job_id)
  assert.ok(terminalReindex, 'Reindex child job disappeared before terminal projection')
  assert.equal(terminalReindex.state, 'succeeded', 'Reindex child did not reach succeeded')

  const uploadProcessing = snapshot('upload-processing-visible')
  const uploadJobIDsBefore = new Set(terminal.map((job) => job.job_id))
  const uploadRoots = uploadProcessing.filter(
    (job) => job.kind === 'ingest' && !uploadJobIDsBefore.has(job.job_id),
  )
  assert.equal(
    uploadRoots.length,
    1,
    `Expected one controlled upload root job, got ${JSON.stringify(uploadRoots)}`,
  )
  const uploadCancelled = snapshot('upload-row-removed').find(
    (job) => job.job_id === uploadRoots[0].job_id,
  )
  assert.ok(uploadCancelled, 'Cancelled upload root job disappeared from durable ledger')
  assert.equal(
    uploadCancelled.state,
    'cancelled',
    'Upload root job must be durably cancelled before row removal',
  )
  return {
    initialJobIDs: [...initialJobIDs],
    reindexJob: {
      jobID: reindexJob.job_id,
      projectedState: reindexJob.state,
      terminalState: terminalReindex.state,
      targetRevisionID: reindexJob.target_revision_id,
    },
    uploadCancelledJob: {
      jobID: uploadRoots[0].job_id,
      state: uploadCancelled.state,
      parentJobID: uploadRoots[0].parent_job_id,
    },
  }
}

function deriveQueueCancellationEvidence(jobSnapshots) {
  const snapshot = (stage) => {
    const value = jobSnapshots[stage]
    assert.ok(value, `Missing SQLite job snapshot for ${stage}`)
    assert.equal(value.error, undefined, `SQLite job snapshot failed for ${stage}: ${value.error}`)
    return value.jobs
  }
  const processing = snapshot('upload-processing-visible')
  const roots = processing.filter((job) => job.kind === 'ingest')
  assert.equal(roots.length, 1, `Expected one controlled upload root job, got ${JSON.stringify(roots)}`)
  const cancelled = snapshot('upload-row-removed').find((job) => job.job_id === roots[0].job_id)
  assert.ok(cancelled, 'Cancelled upload root job disappeared from durable ledger')
  assert.equal(cancelled.state, 'cancelled', 'Upload root job must be durably cancelled before row removal')
  return {
    jobID: roots[0].job_id,
    state: cancelled.state,
    parentJobID: roots[0].parent_job_id,
  }
}

async function waitForRequestClose(request, response) {
  return new Promise((resolvePromise) => {
    const resolveClosed = () => resolvePromise(true)
    request.once('aborted', resolveClosed)
    request.once('close', resolveClosed)
    response.once('close', resolveClosed)
  })
}

async function startLoopbackFixture(databasePath) {
  const state = {
    embeddingRequests: 0,
    heldEmbeddingRequests: 0,
    holdNextEmbedding: false,
    reindexRelease: createDeferred(),
    reindexReleased: false,
    imageArmed: false,
    imageVisionRequests: 0,
    heldVisionRequests: 0,
    warmupVisionRequests: 0,
    visionRelease: createDeferred(),
    visionClientAborted: false,
    updaterRequests: 0,
    externalModelInvocations: 0,
    ollamaInvocations: 0,
    unexpectedPaths: [],
    protocolErrors: [],
    progress: [],
    jobSnapshots: {},
    transportReceipts: [],
    cancellationProjections: [],
    cancellationProbes: [],
    watchdog: null,
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
      if (request.method === 'GET' && url.pathname === '/__knowledge_webview_boundary__/stats') {
        jsonResponse(response, 200, statsProjection(state))
        return
      }
      if (
        request.method === 'POST' &&
        url.pathname === '/__knowledge_webview_boundary__/progress'
      ) {
        const payload = JSON.parse((await readBody(request)).toString('utf8'))
        if (typeof payload?.stage !== 'string') throw new Error('Progress stage must be a string')
        state.progress.push(payload.stage)
        captureTransportReceipts(state, payload?.detail?.transportReceipts)
        captureCancellationProjections(state, payload?.detail?.cancellationProjections)
        if (payload.stage === 'watchdog-timeout' && payload?.detail?.diagnostic) {
          state.watchdog = payload.detail.diagnostic
        }
        if (
          [
            'manual-document-ready-for-reindex',
            'reindex-sidecar-accepted',
            'reindex-detail-projected',
            'reindex-job-polled',
            'reindex-child-projected',
            'reindex-polled-terminal',
            'upload-processing-visible',
            'upload-row-removed',
            'watchdog-timeout',
          ].includes(payload.stage)
        ) {
          state.jobSnapshots[payload.stage] = snapshotKnowledgeJobs(databasePath)
        }
        jsonResponse(response, 200, { accepted: true })
        return
      }
      if (
        request.method === 'POST' &&
        url.pathname === '/__knowledge_webview_boundary__/complete'
      ) {
        const report = JSON.parse((await readBody(request)).toString('utf8'))
        captureTransportReceipts(state, report?.transportReceipts)
        captureCancellationProjections(state, report?.cancellationProjections)
        jsonResponse(response, 200, { accepted: true })
        resolveReport(report)
        return
      }
      if (
        request.method === 'POST' &&
        url.pathname === cancellationProbePath
      ) {
        const payload = JSON.parse((await readBody(request)).toString('utf8'))
        if (
          payload?.phase === 'resolved' ||
          payload?.phase === 'rejected' ||
          payload?.phase === 'before-mark' ||
          payload?.phase === 'after-mark-sync' ||
          payload?.phase === 'mark-error'
        ) {
          state.cancellationProbes.push({
            phase: payload.phase,
            ...(payload.phase === 'resolved'
              ? {
                  state:
                    typeof payload.state === 'string' || payload.state === null
                      ? payload.state
                      : null,
                  stateType:
                    typeof payload.stateType === 'string' ? payload.stateType : 'unknown',
                }
              : payload.phase === 'rejected' || payload.phase === 'mark-error'
                ? {
                    errorKind: typeof payload.errorKind === 'string' ? payload.errorKind : 'other',
                  }
                : {
                    rows: Number.isInteger(payload.rows) && payload.rows >= 0 ? payload.rows : -1,
                    storeItems:
                      Number.isInteger(payload.storeItems) && payload.storeItems >= 0
                        ? payload.storeItems
                        : -1,
                    contains: typeof payload.contains === 'boolean' ? payload.contains : null,
                    entryStatus:
                      typeof payload.entryStatus === 'string' ? payload.entryStatus : null,
                  }),
          })
        }
        jsonResponse(response, 200, { accepted: true })
        return
      }
      if (
        request.method === 'POST' &&
        url.pathname === '/__knowledge_webview_boundary__/arm-reindex'
      ) {
        if (state.holdNextEmbedding || state.heldEmbeddingRequests > 0) {
          throw new Error('Reindex embedding hold was armed more than once')
        }
        state.holdNextEmbedding = true
        jsonResponse(response, 200, { armed: true })
        return
      }
      if (
        request.method === 'POST' &&
        url.pathname === '/__knowledge_webview_boundary__/release-reindex'
      ) {
        state.reindexReleased = true
        state.reindexRelease.resolve()
        jsonResponse(response, 200, { released: true })
        return
      }
      if (
        request.method === 'POST' &&
        url.pathname === '/__knowledge_webview_boundary__/arm-image'
      ) {
        if (state.imageArmed || state.imageVisionRequests > 0) {
          throw new Error('Image vision hold was armed more than once')
        }
        state.imageArmed = true
        jsonResponse(response, 200, { armed: true })
        return
      }
      if (url.pathname === '/__knowledge_webview_boundary__/updater') {
        state.updaterRequests += 1
        response.writeHead(204, { 'Access-Control-Allow-Origin': '*' })
        response.end()
        return
      }
      if (request.method === 'GET' && url.pathname === '/v1/models') {
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
        assert.ok(inputs.length > 0, 'Embedding request needs input')
        state.embeddingRequests += 1
        if (state.holdNextEmbedding) {
          state.holdNextEmbedding = false
          state.heldEmbeddingRequests += 1
          await state.reindexRelease.promise
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
        const isImage = /data:image\/png;base64,/.test(JSON.stringify(payload.messages || []))
        if (!isImage) {
          state.warmupVisionRequests += 1
          fixtureChatSuccess(response, payload, 'chatcmpl-knowledge-webview-warmup')
          return
        }
        if (!state.imageArmed) throw new Error('Unexpected image request before image fixture arm')
        state.imageArmed = false
        state.imageVisionRequests += 1
        state.heldVisionRequests += 1
        const closed = await Promise.race([
          state.visionRelease.promise.then(() => false),
          waitForRequestClose(request, response),
        ])
        if (closed || request.destroyed || response.destroyed) {
          state.visionClientAborted = true
          return
        }
        fixtureChatSuccess(response, payload, 'chatcmpl-knowledge-webview-image')
        return
      }

      state.unexpectedPaths.push(`${request.method || 'GET'} ${url.pathname}`)
      jsonResponse(response, 404, { error: { message: 'Unexpected loopback fixture request' } })
    } catch (error) {
      state.protocolErrors.push(error instanceof Error ? error.message : String(error))
      if (!response.headersSent && !response.destroyed) {
        jsonResponse(response, 500, {
          error: { message: error instanceof Error ? error.message : String(error) },
        })
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
    reportPromise,
    state,
    releaseAll: () => {
      state.reindexRelease.resolve()
      state.visionRelease.resolve()
    },
    close: async () => {
      if (!server.listening) return
      server.closeAllConnections?.()
      await new Promise((resolvePromise, reject) => {
        server.close((error) => (error ? reject(error) : resolvePromise()))
      })
    },
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

function listenerPids(port) {
  try {
    const result = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
      encoding: 'utf8',
    })
    return result.split(/\s+/).filter(Boolean).map(Number)
  } catch {
    return []
  }
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

function prepareFrontend(sandbox, fixtureOrigin, { queueCancelOnly = false } = {}) {
  const dist = join(repoRoot, 'dist')
  assert.ok(existsSync(join(dist, 'index.html')), 'Current dist/index.html is missing')
  const frontend = join(sandbox, 'frontend')
  cpSync(dist, frontend, { recursive: true })
  const transportInstrumentation = instrumentTemporarySidecarFetch(frontend)
  const cancellationProjectionInstrumentation = queueCancelOnly
    ? instrumentTemporaryCancellationProjection(frontend, fixtureOrigin)
    : null
  const fixtureTarget = join(frontend, 'knowledge-queue-reindex-webview-fixture.js')
  const fixture = readFileSync(fixtureSourcePath, 'utf8').replace(
    '__HEX_KNOWLEDGE_WEBVIEW_FIXTURE_ORIGIN__',
    fixtureOrigin,
  )
  writeFileSync(fixtureTarget, fixture, { mode: 0o600 })
  const indexPath = join(frontend, 'index.html')
  const index = readFileSync(indexPath, 'utf8')
  assert.match(index, /<head>/)
  const modeScript = queueCancelOnly
    ? '\n<script>globalThis.__HEXCLAW_TEST_QUEUE_CANCEL_ONLY__=true</script>'
    : ''
  writeFileSync(
    indexPath,
    index.replace(
      '<head>',
      `<head>${modeScript}\n<script src="./knowledge-queue-reindex-webview-fixture.js"></script>`,
    ),
  )
  return { frontend, transportInstrumentation, cancellationProjectionInstrumentation }
}

function writeOverlay(sandbox, frontend, sidecarPort, fixtureOrigin) {
  const overlayPath = join(sandbox, 'tauri.knowledge-webview-boundary.conf.json')
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
        endpoints: [`${fixtureOrigin}/__knowledge_webview_boundary__/updater`],
        dangerousInsecureTransportProtocol: true,
      },
    },
  }
  writeFileSync(overlayPath, `${JSON.stringify(overlay, null, 2)}\n`, { mode: 0o600 })
  return overlayPath
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
    await sleep(250)
  }
  throw new Error(`Sidecar health timed out on loopback port ${port}`)
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
  const unexpected = []
  const stopped = []
  const ownedCommandFragment = `${appBundle}/Contents/MacOS/hexclaw serve --desktop`
  for (const pid of listenerPids(port)) {
    let command = ''
    try {
      command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
        encoding: 'utf8',
      }).trim()
    } catch {
      unexpected.push({ pid, command: '<unreadable>' })
      continue
    }
    if (!command.includes(ownedCommandFragment)) {
      unexpected.push({ pid, command })
      continue
    }
    process.kill(pid, 'SIGTERM')
    stopped.push(pid)
  }
  const deadline = Date.now() + 5_000
  while (listenerPids(port).length > 0 && Date.now() < deadline) await sleep(100)
  return {
    stopped,
    unexpected,
    released: listenerPids(port).length === 0,
  }
}

function sanitizeLog(raw, sandbox) {
  return raw
    .replaceAll(syntheticCredential, '[REDACTED]')
    .replaceAll(repoRoot, '<repo>')
    .replaceAll(sandbox, '<sandbox>')
}

async function main() {
  assert.equal(process.platform, 'darwin', 'Native knowledge WebView boundary is macOS-only')
  assert.ok(existsSync(fixtureSourcePath), 'WebView fixture is missing')
  assert.ok(existsSync(join(repoRoot, 'dist/index.html')), 'Current dist/index.html is missing')
  assertTransportReceiptContract()
  const acceptance = queueCancelOnly
    ? ['KNOWLEDGE-QUEUE-CANCELLED-001']
    : ['KNOWLEDGE-QUEUE-CANCELLED-001', 'KNOWLEDGE-REINDEX-PROJECTION-001']
  mkdirSync(runDir, { recursive: true })

  const sandbox = mkdtempSync(join(tmpdir(), 'hexclaw-knowledge-webview.'))
  chmodSync(sandbox, 0o700)
  const configDir = join(sandbox, '.hexclaw')
  const tmp = join(sandbox, 'tmp')
  mkdirSync(configDir, { mode: 0o700 })
  mkdirSync(tmp, { mode: 0o700 })
  chmodSync(configDir, 0o700)
  chmodSync(tmp, 0o700)

  const loopback = await startLoopbackFixture(join(configDir, 'data.db'))
  const sidecarPort = await reserveLoopbackPort()
  const portAudit = {
    sidecarPort,
    beforeBuild: listenerPids(sidecarPort),
    fixtureOrigin: loopback.origin,
  }
  let appProcess = null
  let appBundle = ''
  let appLog = null
  let webViewReport = null
  let boundaryError = null
  let finalStatus = 'FAIL'
  let cleanup = null
  let transportInstrumentation = null
  let cancellationProjectionInstrumentation = null
  const appRawLog = join(sandbox, 'app.log')

  try {
    assert.deepEqual(
      portAudit.beforeBuild,
      [],
      `Dedicated port ${sidecarPort} is occupied before build`,
    )
    const configPath = join(configDir, 'hexclaw.yaml')
    writeFileSync(configPath, renderConfig(sandbox, sidecarPort, loopback.origin), { mode: 0o600 })
    chmodSync(configPath, 0o600)

    const offlineEnv = {
      ...process.env,
      CARGO_NET_OFFLINE: 'true',
      GOENV: 'off',
      GOPROXY: 'off',
      GOSUMDB: 'off',
      PNPM_CONFIG_OFFLINE: 'true',
      npm_config_offline: 'true',
    }
    delete offlineEnv.GOROOT
    const preparedFrontend = prepareFrontend(sandbox, loopback.origin, { queueCancelOnly })
    transportInstrumentation = preparedFrontend.transportInstrumentation
    cancellationProjectionInstrumentation = preparedFrontend.cancellationProjectionInstrumentation
    writeFileSync(
      join(runDir, 'transport-instrumentation.json'),
      `${JSON.stringify(transportInstrumentation, null, 2)}\n`,
    )
    const overlayPath = writeOverlay(
      sandbox,
      preparedFrontend.frontend,
      sidecarPort,
      loopback.origin,
    )
    await runCommand(
      'pnpm',
      ['exec', 'tauri', 'build', '--config', overlayPath, '--bundles', 'app'],
      { env: offlineEnv, timeoutMs: commandTimeoutMs },
    )

    appBundle = join(srcTauriDir, `target/release/bundle/macos/${appProductName}.app`)
    const infoPlist = join(appBundle, 'Contents/Info.plist')
    const executable = join(appBundle, 'Contents/MacOS/hexclaw-desktop')
    assert.ok(existsSync(infoPlist), `Test.app Info.plist is missing: ${infoPlist}`)
    assert.ok(existsSync(executable), `Test.app executable is missing: ${executable}`)
    const identifier = execFileSync(
      'plutil',
      ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', infoPlist],
      { encoding: 'utf8' },
    ).trim()
    assert.equal(identifier, appIdentifier)
    assert.deepEqual(
      listenerPids(sidecarPort),
      [],
      `Dedicated port ${sidecarPort} is occupied after build`,
    )

    appLog = createWriteStream(appRawLog, { flags: 'wx', mode: 0o600 })
    appProcess = spawn(executable, [], {
      cwd: sandbox,
      env: {
        PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
        LANG: 'zh_CN.UTF-8',
        HOME: sandbox,
        USERPROFILE: sandbox,
        CFFIXED_USER_HOME: sandbox,
        TMPDIR: tmp,
        TEMP: tmp,
        TMP: tmp,
        HEXCLAW_TEST_MODE: '1',
        HEXCLAW_TEST_HOME: sandbox,
        HEXCLAW_SIDECAR_PORT: String(sidecarPort),
        HEXCLAW_TEST_LLM_CONFIG_MODE: 'preseeded-owner-yaml',
        HEXCLAW_DISABLE_BACKGROUND_EGRESS: '1',
        NO_PROXY: '*',
        no_proxy: '*',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    appProcess.stdout.pipe(appLog, { end: false })
    appProcess.stderr.pipe(appLog, { end: false })
    await waitForHealth(sidecarPort, appProcess)

    let reportTimer
    try {
      webViewReport = await Promise.race([
        loopback.reportPromise,
        new Promise((_, reject) => {
          reportTimer = setTimeout(
            () => reject(new Error('WebView knowledge boundary report timed out')),
            110_000,
          )
        }),
      ])
    } finally {
      clearTimeout(reportTimer)
    }

    assert.equal(webViewReport?.status, 'PASS', webViewReport?.error || 'WebView boundary failed')
    assert.deepEqual(loopback.state.protocolErrors, [])
    assert.deepEqual(loopback.state.unexpectedPaths, [])
    assert.equal(loopback.state.heldVisionRequests, 1)
    assert.equal(loopback.state.imageVisionRequests, 1)
    assert.equal(loopback.state.externalModelInvocations, 0)
    assert.equal(loopback.state.ollamaInvocations, 0)
    const jobs = queueCancelOnly
      ? { uploadCancelledJob: deriveQueueCancellationEvidence(loopback.state.jobSnapshots) }
      : deriveJobEvidence(loopback.state.jobSnapshots)
    if (!queueCancelOnly) {
      assert.equal(loopback.state.heldEmbeddingRequests, 1)
      const reindexTransport = loopback.state.transportReceipts.find(
        (receipt) => receipt.kind === 'reindex' && receipt.phase === 'responded',
      )
      assert.ok(reindexTransport, 'Native reindex click did not produce a sidecar response receipt')
      assert.equal(reindexTransport.status, 202, 'Native reindex response must remain HTTP 202')
      assert.equal(
        reindexTransport.fields?.job_id,
        jobs.reindexJob.jobID,
        'Native reindex response job_id must match the projected child job',
      )
      const detailTransport = loopback.state.transportReceipts.find(
        (receipt) =>
          receipt.kind === 'document-detail' &&
          receipt.phase === 'responded' &&
          receipt.path === `/api/v1/knowledge/documents/${reindexTransport.fields?.id}`,
      )
      assert.ok(detailTransport, 'Native reindex must read its canonical document projection')
      assert.equal(
        detailTransport.status,
        200,
        'Native document projection read must remain HTTP 200',
      )
      assert.equal(
        detailTransport.fields?.vector_job_id,
        jobs.reindexJob.jobID,
        'Native document projection must expose the accepted reindex child job_id',
      )
      const jobPollTransport = loopback.state.transportReceipts.find(
        (receipt) =>
          receipt.kind === 'job-poll' &&
          receipt.phase === 'responded' &&
          receipt.path === `/api/v1/knowledge/jobs/${jobs.reindexJob.jobID}`,
      )
      assert.ok(jobPollTransport, 'Native reindex must poll the accepted child job')
      assert.equal(jobPollTransport.status, 200, 'Native child job poll must remain HTTP 200')
      assert.equal(
        jobPollTransport.fields?.job_id,
        jobs.reindexJob.jobID,
        'Native child job poll must retain the accepted reindex job_id',
      )
    }
    const cancellationTransport = loopback.state.transportReceipts.find(
      (receipt) => receipt.kind === 'cancel' && receipt.phase === 'responded',
    )
    assert.ok(
      cancellationTransport,
      'Native upload cancel click did not produce a sidecar response receipt',
    )
    assert.equal(
      cancellationTransport.status,
      200,
      'Native upload cancellation must remain HTTP 200',
    )
    assert.equal(
      cancellationTransport.fields?.job_id,
      jobs.uploadCancelledJob.jobID,
      'Native cancellation response job_id must match the durable cancelled upload job',
    )
    assert.equal(
      cancellationTransport.fields?.state,
      'cancelled',
      'Native cancellation receipt must confirm the cancelled job state',
    )
    const rawLog = readFileSync(appRawLog, 'utf8')
    assert.doesNotMatch(rawLog, /localhost:11434/, 'Isolated Test.app must not probe Ollama')

    const evidence = {
      status: 'PASS',
      acceptance,
      app: {
        bundle: relative(repoRoot, appBundle),
        identifier,
        nativeWindow: true,
        testHomeIsolated: true,
      },
      nativeFileTransfer: {
        purpose: nativeFileGrantPurpose,
        source: 'synthetic in-memory PNG through the real file-input change handler',
        userFileRead: false,
      },
      network: {
        providerOrigins: [loopback.origin],
        binding: '127.0.0.1',
        externalModelInvocations: 0,
        ollamaInvocations: 0,
      },
      ports: portAudit,
      report: webViewReport,
      jobs,
      receipts: statsProjection(loopback.state),
      transport: {
        scope: 'temporary-Test.app-WKWebView-dist-copy',
        originalDistByteIdentity: false,
        instrumentation: transportInstrumentation,
        cancellationProjectionInstrumentation,
        cancellationProbes: loopback.state.cancellationProbes,
        receipts: loopback.state.transportReceipts,
      },
    }
    writeFileSync(join(runDir, 'report.json'), `${JSON.stringify(evidence, null, 2)}\n`)
    finalStatus = 'PASS'
    process.stdout.write(
      `\nNative knowledge WebView boundary PASS: ${relative(repoRoot, join(runDir, 'report.json'))}\n`,
    )
  } catch (error) {
    boundaryError = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    throw error
  } finally {
    loopback.releaseAll()
    await stopProcess(appProcess)
    if (appLog) await new Promise((resolvePromise) => appLog.end(resolvePromise))
    const sidecarCleanup = appBundle
      ? await stopOwnedSidecar(sidecarPort, appBundle)
      : { stopped: [], unexpected: [], released: listenerPids(sidecarPort).length === 0 }
    await loopback.close()
    cleanup = {
      status: finalStatus,
      appProcessStopped:
        !appProcess || appProcess.exitCode !== null || appProcess.signalCode !== null,
      sidecarPortReleased: sidecarCleanup.released,
      sidecarPidsStopped: sidecarCleanup.stopped,
      unexpectedPortOwners: sidecarCleanup.unexpected,
      loopbackClosed: true,
      sandboxRemoved: true,
    }
    if (existsSync(appRawLog)) {
      writeFileSync(join(runDir, 'app.log'), sanitizeLog(readFileSync(appRawLog, 'utf8'), sandbox))
    }
    const watchdogDiagnostic = webViewReport?.diagnostic || loopback.state.watchdog
    if (watchdogDiagnostic) {
      writeFileSync(
        join(runDir, 'watchdog.json'),
        `${JSON.stringify(
          {
            status: webViewReport?.status || finalStatus,
            error: webViewReport?.error || boundaryError,
            diagnostic: watchdogDiagnostic,
            durableJobs: loopback.state.jobSnapshots['watchdog-timeout'] || null,
            fixtureReceipts: loopback.state.transportReceipts,
            progress: loopback.state.progress,
          },
          null,
          2,
        )}\n`,
      )
    }
    if (!existsSync(join(runDir, 'report.json'))) {
      const evidence = {
        status: finalStatus,
        error: boundaryError,
        acceptance,
        app: {
          bundle: appBundle ? relative(repoRoot, appBundle) : null,
          identifier: appIdentifier,
          nativeWindow: Boolean(appBundle),
          testHomeIsolated: true,
        },
        nativeFileTransfer: {
          purpose: nativeFileGrantPurpose,
          source: 'synthetic in-memory PNG through the real file-input change handler',
          userFileRead: false,
        },
        network: {
          providerOrigins: [loopback.origin],
          binding: '127.0.0.1',
          externalModelInvocations: 0,
          ollamaInvocations: 0,
        },
        ports: portAudit,
        report: webViewReport,
        receipts: statsProjection(loopback.state),
        transport: {
          scope: 'temporary-Test.app-WKWebView-dist-copy',
          originalDistByteIdentity: false,
          instrumentation: transportInstrumentation,
          cancellationProjectionInstrumentation,
          receipts: loopback.state.transportReceipts,
        },
      }
      writeFileSync(join(runDir, 'report.json'), `${JSON.stringify(evidence, null, 2)}\n`)
    }
    writeFileSync(join(runDir, 'cleanup.json'), `${JSON.stringify(cleanup, null, 2)}\n`)
    rmSync(sandbox, { recursive: true, force: true })
  }
}

if (process.argv.includes('--transport-receipt-contract')) {
  assertTransportReceiptContract()
  process.stdout.write('Temporary WebView transport receipt contract PASS\n')
} else {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.stack || error.message : String(error)}\n`,
    )
    process.exitCode = 1
  })
}
