#!/usr/bin/env node

import {
  createHash,
  generateKeyPairSync,
  sign,
} from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import net from 'node:net'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  resolve,
} from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  auditRestartHandoff,
  validateHandoffPayload,
  verifySignedHandoff,
} from './k12-c10-restart-recovery-gate.mjs'

const scriptPath = fileURLToPath(import.meta.url)
const contract = JSON.parse(
  readFileSync(
    new URL('../../tests/live/k12-c10-isolated-restart-driver.contract.json', import.meta.url),
    'utf8',
  ),
)
const sidecarArgs = (config) => [
  'serve',
  '--desktop',
  '--config',
  config.sidecar_config_path,
]
const inputFileFields = [
  'sidecar_config_path',
  'pre_envelope_path',
  'pre_public_key_path',
  'query_request_path',
]
const outputFileFields = [
  'post_envelope_path',
  'post_public_key_path',
]

function fail(reason) {
  throw new Error(`K12 C10 isolated restart driver: ${reason}`)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`)
  }
  if (
    JSON.stringify(Object.keys(value).sort()) !==
    JSON.stringify([...expected].sort())
  ) {
    fail(`${label} exact field set mismatch`)
  }
}

function tmpPath(path) {
  return (
    typeof path === 'string' &&
    (path.startsWith('/tmp/') || path.startsWith('/private/tmp/'))
  )
}

function defaultInspectPath(path) {
  if (existsSync(path)) {
    const link = lstatSync(path)
    const target = statSync(path)
    return {
      kind: target.isDirectory() ? 'directory' : target.isFile() ? 'file' : 'other',
      canonicalPath: realpathSync(path),
      executable: target.isFile() && (target.mode & 0o111) !== 0,
      symlink: link.isSymbolicLink(),
    }
  }
  const parent = realpathSync(dirname(path))
  return {
    kind: 'missing',
    canonicalPath: join(parent, basename(path)),
    executable: false,
    symlink: false,
  }
}

function validateTmpField(config, field, inspectPath) {
  const path = config[field]
  if (!tmpPath(path)) fail(`${field} must be an absolute /tmp path`)
  const info = inspectPath(path)
  if (!tmpPath(info.canonicalPath)) fail(`${field} canonical path escapes /tmp`)
  return info
}

export function validateDriverConfig(
  config,
  {
    configPath,
    homeDir = process.env.HOME ?? '',
    inspectPath = defaultInspectPath,
    fileSHA256 = (path) => sha256(readFileSync(path)),
  } = {},
) {
  exactKeys(config, contract.configFields, 'driver config')
  if (!tmpPath(configPath)) fail('driver config path must be under /tmp')
  const configInfo = inspectPath(configPath)
  if (configInfo.kind !== 'file' || !tmpPath(configInfo.canonicalPath)) {
    fail('driver config file must resolve to a /tmp regular file')
  }
  if (config.schema_version !== contract.schemaVersion) {
    fail('schema_version mismatch')
  }
  for (const field of contract.tmpPathFields) validateTmpField(config, field, inspectPath)
  for (const field of ['profile_dir', 'evidence_dir']) {
    if (inspectPath(config[field]).kind !== 'directory') fail(`${field} must be a directory`)
  }
  for (const field of inputFileFields) {
    if (inspectPath(config[field]).kind !== 'file') fail(`${field} must be a regular file`)
  }
  for (const field of outputFileFields) {
    if (inspectPath(config[field]).kind !== 'missing') {
      fail(`${field} must not pre-exist`)
    }
  }
  if (
    !isAbsolute(config.binary_path) ||
    tmpPath(config.binary_path) ||
    (homeDir && resolve(config.binary_path).startsWith(`${resolve(homeDir)}/`))
  ) {
    fail('binary_path must be an installed absolute path outside HOME and /tmp')
  }
  const binaryInfo = inspectPath(config.binary_path)
  if (binaryInfo.kind !== 'file' || !binaryInfo.executable) {
    fail('binary_path must be an executable regular file')
  }
  for (const field of [
    'sidecar_config_sha256',
    'binary_sha256',
    'pre_public_key_sha256',
  ]) {
    if (!/^[a-f0-9]{64}$/.test(config[field])) fail(`${field} must be SHA-256 hex`)
  }
  for (const [pathField, digestField] of [
    ['sidecar_config_path', 'sidecar_config_sha256'],
    ['binary_path', 'binary_sha256'],
    ['pre_public_key_path', 'pre_public_key_sha256'],
  ]) {
    if (fileSHA256(config[pathField]) !== config[digestField]) {
      fail(`${digestField} mismatch`)
    }
  }
  if (
    !Number.isInteger(config.port) ||
    config.port < 1024 ||
    config.port > 65535 ||
    contract.forbiddenPorts.includes(config.port)
  ) {
    fail('port must be an explicit non-production unprivileged port')
  }
  if (
    typeof config.expected_version !== 'string' ||
    !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(config.expected_version)
  ) {
    fail('expected_version must be explicit')
  }
  const uniquePaths = contract.tmpPathFields.map((field) => resolve(config[field]))
  if (new Set(uniquePaths).size !== uniquePaths.length) fail('isolated paths must be distinct')
  return config
}

export function createNetworkRecorder(rawRequest) {
  const counts = { upload: 0, index: 0 }
  return {
    async requestJSON(request) {
      const path = String(request.path ?? '').split('?')[0]
      if (request.method === 'POST' && path === '/api/v1/knowledge/documents') {
        counts.upload += 1
      }
      if (
        request.method === 'POST' &&
        /^\/api\/v1\/knowledge\/documents\/[^/]+\/reindex$/.test(path)
      ) {
        counts.index += 1
      }
      return rawRequest(request)
    },
    snapshot() {
      return { ...counts }
    },
  }
}

export function assertZeroNetworkWrites(counts) {
  if (counts.upload !== 0 || counts.index !== 0) {
    fail('upload/index network counters must remain zero')
  }
}

function expectedCommand(config) {
  return [config.binary_path, ...sidecarArgs(config)].join(' ')
}

function assertOldOwnership(config, pre, observation) {
  if (
    !observation?.alive ||
    observation.command?.trim() !== expectedCommand(config) ||
    !Array.isArray(observation.listenerPorts) ||
    !observation.listenerPorts.includes(config.port)
  ) {
    fail('signed old PID does not own the exact binary/config/listener')
  }
  validateHandoffPayload(pre, 'before')
}

async function assertReady(requestJSON, expectedVersion) {
  const health = await requestJSON({ method: 'GET', path: '/health' })
  if (health?.status !== 'healthy') fail('health check failed')
  const version = await requestJSON({ method: 'GET', path: '/api/v1/version' })
  if (version?.version !== expectedVersion) fail('version check failed')
}

async function waitForNewReady(config, child, requestJSON, runtime) {
  let lastFailure
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (!(await runtime.isAlive(child.pid))) fail('new Sidecar exited before readiness')
    try {
      await assertReady(requestJSON, config.expected_version)
      return
    } catch (error) {
      lastFailure = error
      await runtime.sleep(100)
    }
  }
  void lastFailure
  fail('new Sidecar readiness timed out')
}

function derivePost(pre, childPid, search, policy, counts) {
  if (!Array.isArray(search?.results) || !Array.isArray(search?.query_receipts)) {
    fail('search evidence shape mismatch')
  }
  const hit = search.results.find(
    (candidate) =>
      candidate?.doc_id === pre.document_id &&
      candidate?.page_start === pre.page_start &&
      candidate?.page_end === pre.page_end,
  )
  if (!hit) fail('search did not return the signed document/page')
  const receipts = search.query_receipts.filter(
    (candidate) => candidate?.operation === 'query_embedding',
  )
  if (receipts.length !== 1) fail('search must return one query_embedding receipt')
  const receipt = receipts[0]
  if (receipt.status !== 'succeeded') fail('query_embedding receipt did not succeed')
  const active = policy?.active_revision
  const profile = active?.profile
  if (
    active?.revision_id !== receipt.revision_id ||
    active?.profile_config_hash !== receipt.profile_config_hash ||
    profile?.profile_id !== receipt.profile_id ||
    profile?.provider_id !== receipt.provider_id ||
    profile?.model_name !== receipt.model ||
    profile?.dimension !== receipt.dimension
  ) {
    fail('embedding policy does not match query receipt')
  }
  return {
    ...pre,
    phase: 'after',
    sidecar_pid: childPid,
    document_id: hit.doc_id,
    source_digest: hit.source_digest,
    active_revision_id: receipt.revision_id,
    profile_id: receipt.profile_id,
    profile_config_hash: receipt.profile_config_hash,
    upload_count: pre.upload_count + counts.upload,
    index_count: pre.index_count + counts.index,
    query_model: receipt.model,
    query_digest: receipt.query_digest,
    hit_document_id: hit.doc_id,
    citation_digest: hit.citation_digest,
    page_start: hit.page_start,
    page_end: hit.page_end,
  }
}

function signPost(post) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const payload = Buffer.from(JSON.stringify(post), 'utf8')
  const envelope = JSON.stringify({
    algorithm: contract.postSignature.algorithm,
    payload_b64: payload.toString('base64'),
    signature_b64: sign(null, payload, privateKey).toString('base64'),
  })
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  return { envelope, publicKeyPem }
}

export function verifyDriverPostEnvelope(envelope, publicKeyPem) {
  return verifySignedHandoff(envelope, publicKeyPem)
}

function buildChildEnvironment(config) {
  return {
    HOME: config.profile_dir,
    TMPDIR: dirname(config.profile_dir),
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: 'C.UTF-8',
    HEXCLAW_TEST_MODE: '1',
    HEXCLAW_TEST_HOME: config.profile_dir,
    DINGTALK_LIVE_SEND: '0',
  }
}

function sanitizedEvidence(config, pre, post, counts, envelope, publicKeyPem) {
  return {
    schemaVersion: contract.schemaVersion,
    status: 'passed',
    oldPid: pre.sidecar_pid,
    newPid: post.sidecar_pid,
    port: config.port,
    version: config.expected_version,
    binarySha256: config.binary_sha256,
    sidecarConfigSha256: config.sidecar_config_sha256,
    runIdSha256: sha256(pre.run_id),
    documentIdSha256: sha256(pre.document_id),
    revisionIdSha256: sha256(pre.active_revision_id),
    profileConfigHashSha256: sha256(pre.profile_config_hash),
    citationDigestSha256: sha256(pre.citation_digest),
    network: counts,
    postEnvelopeSha256: sha256(envelope),
    postPublicKeySha256: sha256(publicKeyPem),
  }
}

function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

async function stopOwnedProcess(target) {
  const pid = typeof target === 'number' ? target : target.pid
  if (!Number.isInteger(pid) || pid <= 0 || !defaultIsAlive(pid)) return
  process.kill(pid, 'SIGTERM')
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!defaultIsAlive(pid)) return
    await delay(100)
  }
  if (defaultIsAlive(pid)) process.kill(pid, 'SIGKILL')
}

function portIsFree(port) {
  return new Promise((resolveFree) => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    socket.once('connect', () => {
      socket.destroy()
      resolveFree(false)
    })
    socket.once('error', () => resolveFree(true))
    socket.setTimeout(500, () => {
      socket.destroy()
      resolveFree(false)
    })
  })
}

async function waitForPortFree(port) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await portIsFree(port)) return
    await delay(100)
  }
  fail('dedicated port did not release')
}

function inspectProcess(pid, config) {
  if (!defaultIsAlive(pid)) return { alive: false, command: '', listenerPorts: [] }
  const command = spawnSync('ps', ['-p', String(pid), '-o', 'command='], {
    encoding: 'utf8',
    shell: false,
  })
  const listener = spawnSync(
    'lsof',
    [
      '-nP',
      '-a',
      '-p',
      String(pid),
      `-iTCP:${config.port}`,
      '-sTCP:LISTEN',
      '-t',
    ],
    { encoding: 'utf8', shell: false },
  )
  return {
    alive: true,
    command: command.status === 0 ? command.stdout.trim() : '',
    listenerPorts:
      listener.status === 0 && listener.stdout.trim().split(/\s+/).includes(String(pid))
        ? [config.port]
        : [],
  }
}

function allowedRequest(method, path) {
  const barePath = path.split('?')[0]
  return contract.allowedHTTP.some((entry) => {
    const separator = entry.indexOf(' ')
    return entry.slice(0, separator) === method && entry.slice(separator + 1) === barePath
  })
}

async function requestJSON(config, { method, path, body }) {
  if (!allowedRequest(method, path)) fail('HTTP request is outside the fixed allowlist')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 2_000)
  try {
    const response = await fetch(`http://127.0.0.1:${config.port}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
    if (!response.ok) fail(`HTTP ${method} endpoint returned non-success`)
    try {
      return await response.json()
    } catch {
      fail(`HTTP ${method} endpoint returned invalid JSON`)
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('K12 C10')) throw error
    fail(`HTTP ${method} endpoint was unavailable`)
  } finally {
    clearTimeout(timeout)
  }
}

async function writeArtifacts(config, { post, envelope, publicKeyPem, evidence }) {
  await mkdir(config.evidence_dir, { recursive: true })
  await writeFile(config.post_envelope_path, `${envelope}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  })
  await writeFile(config.post_public_key_path, publicKeyPem, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  })
  const evidencePath = resolve(
    config.evidence_dir,
    `c10-restart-${sha256(post.run_id).slice(0, 16)}.json`,
  )
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  })
  return evidencePath
}

function realRuntime(config, onSpawn = () => undefined) {
  return {
    inspectProcess: (pid) => inspectProcess(pid, config),
    requestJSON: (request) => requestJSON(config, request),
    stopProcess: stopOwnedProcess,
    waitForPortFree,
    spawnProcess: (command, args, options) => {
      const child = spawn(command, args, options)
      onSpawn(child)
      return child
    },
    cleanupProcess: stopOwnedProcess,
    writeArtifacts: (artifacts) => writeArtifacts(config, artifacts),
    isAlive: async (pid) => defaultIsAlive(pid),
    sleep: delay,
    onSpawn,
  }
}

export async function runIsolatedRestart(
  config,
  { pre, queryRequest, runtime = {} },
) {
  exactKeys(queryRequest, contract.queryRequestFields, 'query request')
  if (
    typeof queryRequest.query !== 'string' ||
    !queryRequest.query.trim() ||
    !Number.isInteger(queryRequest.top_k) ||
    queryRequest.top_k < 1 ||
    queryRequest.top_k > 50 ||
    typeof queryRequest.user_id !== 'string' ||
    !queryRequest.user_id.trim()
  ) {
    fail('query request fields are invalid')
  }
  const io = { ...realRuntime(config), ...runtime }
  const network = createNetworkRecorder(io.requestJSON)
  const observation = await io.inspectProcess(pre.sidecar_pid)
  assertOldOwnership(config, pre, observation)
  await assertReady(network.requestJSON, config.expected_version)
  await io.stopProcess(pre.sidecar_pid)
  await io.waitForPortFree(config.port)

  let child
  try {
    child = io.spawnProcess(config.binary_path, sidecarArgs(config), {
      cwd: config.profile_dir,
      env: buildChildEnvironment(config),
      shell: false,
      stdio: 'ignore',
    })
    io.onSpawn?.(child)
    if (
      !Number.isInteger(child?.pid) ||
      child.pid <= 0 ||
      child.pid === pre.sidecar_pid
    ) {
      fail('spawn did not return a distinct positive PID')
    }
    await waitForNewReady(config, child, network.requestJSON, io)
    const encodedUser = encodeURIComponent(queryRequest.user_id)
    const search = await network.requestJSON({
      method: 'POST',
      path: `/api/v1/knowledge/search?user_id=${encodedUser}`,
      body: { query: queryRequest.query, top_k: queryRequest.top_k },
    })
    const policy = await network.requestJSON({
      method: 'GET',
      path:
        `/api/v1/knowledge/corpora/default/embedding-policy?user_id=${encodedUser}`,
    })
    const counts = network.snapshot()
    assertZeroNetworkWrites(counts)
    const post = derivePost(pre, child.pid, search, policy, counts)
    auditRestartHandoff(pre, post)
    const { envelope, publicKeyPem } = signPost(post)
    const evidence = sanitizedEvidence(
      config,
      pre,
      post,
      counts,
      envelope,
      publicKeyPem,
    )
    const evidencePath = await io.writeArtifacts({
      post,
      envelope,
      publicKeyPem,
      evidence,
    })
    child.unref?.()
    return { evidencePath, newPid: child.pid, post }
  } catch (error) {
    if (child) {
      await io.cleanupProcess(child)
      io.onSpawn?.(undefined)
    }
    throw error
  }
}

export function installSignalCleanup(processLike, getChild, cleanupProcess) {
  const handlers = new Map()
  for (const [signal, exitCode] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    const handler = () => {
      const child = getChild()
      Promise.resolve(child ? cleanupProcess(child) : undefined)
        .finally(() => {
          processLike.exitCode = exitCode
        })
    }
    handlers.set(signal, handler)
    processLike.once(signal, handler)
  }
  return () => {
    for (const [signal, handler] of handlers) processLike.removeListener(signal, handler)
  }
}

export function formatSuccessOutput(evidencePath) {
  if (!tmpPath(evidencePath) || !isAbsolute(evidencePath)) {
    fail('evidence path must be absolute under /tmp')
  }
  return `${evidencePath}\n`
}

function assertRuntimeConfigSafety(config, configText) {
  if (/\bding[\s_-]*talk\b/i.test(configText)) fail('Sidecar config must not enable DingTalk')
  if (
    !new RegExp(`^\\s*port:\\s*${config.port}\\s*(?:#.*)?$`, 'm').test(configText)
  ) {
    fail('Sidecar config must contain the explicit driver port')
  }
  for (const forbidden of contract.forbiddenPorts) {
    if (new RegExp(`^\\s*port:\\s*${forbidden}\\s*(?:#.*)?$`, 'm').test(configText)) {
      fail('Sidecar config contains a forbidden port')
    }
  }
}

function assertOuterPaths(config, configPath, env) {
  const mappings = [
    ['HEX_K12_C10_DRIVER_CONFIG', configPath],
    ['HEX_K12_C10_BEFORE_HANDOFF', config.pre_envelope_path],
    ['HEX_K12_C10_HANDOFF_PUBLIC_KEY', config.pre_public_key_path],
    ['HEX_K12_C10_AFTER_HANDOFF', config.post_envelope_path],
    ['HEX_K12_C10_AFTER_HANDOFF_PUBLIC_KEY', config.post_public_key_path],
  ]
  for (const [name, expected] of mappings) {
    if (env[name] && resolve(env[name]) !== resolve(expected)) fail(`${name} path mismatch`)
  }
}

async function runCLI(argv) {
  if (
    argv.length !== 3 ||
    argv[0] !== '--restart-k12-sidecar' ||
    argv[1] !== '--config' ||
    !tmpPath(argv[2])
  ) {
    process.stderr.write('K12 C10 isolated restart driver: invalid arguments\n')
    process.exitCode = 2
    return
  }
  let child
  let uninstall = () => undefined
  try {
    const configPath = argv[2]
    const configText = readFileSync(configPath, 'utf8')
    const config = JSON.parse(configText)
    validateDriverConfig(config, { configPath })
    assertOuterPaths(config, configPath, process.env)
    assertRuntimeConfigSafety(
      config,
      readFileSync(config.sidecar_config_path, 'utf8'),
    )
    const preKey = readFileSync(config.pre_public_key_path)
    const preEnvelope = readFileSync(config.pre_envelope_path, 'utf8')
    const pre = verifySignedHandoff(preEnvelope, preKey)
    validateHandoffPayload(pre, 'before')
    const queryRequest = JSON.parse(readFileSync(config.query_request_path, 'utf8'))
    const runtime = realRuntime(config, (value) => {
      child = value
    })
    uninstall = installSignalCleanup(process, () => child, runtime.cleanupProcess)
    const result = await runIsolatedRestart(config, { pre, queryRequest, runtime })
    process.stdout.write(formatSuccessOutput(result.evidencePath))
  } catch {
    process.stderr.write('K12 C10 isolated restart driver failed\n')
    process.exitCode = 1
  } finally {
    uninstall()
  }
}

if (resolve(process.argv[1] ?? '') === resolve(scriptPath)) {
  await runCLI(process.argv.slice(2))
}
