#!/usr/bin/env node

import { createHash, verify } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const contract = JSON.parse(
  readFileSync(
    new URL('../../tests/live/k12-c10-restart-hook.contract.json', import.meta.url),
    'utf8',
  ),
)
const oracle = JSON.parse(
  readFileSync(new URL('../../tests/fixtures/local/k12-textbook-rag-oracle.v1.json', import.meta.url)),
)
const reportPath = resolve(repoRoot, 'test-results/k12-c10-restart-recovery/evidence.json')
const valueEnvironment = [
  'HEX_K12_C10_RESTART_HOOK',
  'HEX_K12_C10_RESTART_HOOK_SHA256',
  'HEX_K12_C10_HANDOFF_PUBLIC_KEY',
  'HEX_K12_C10_HANDOFF_PUBLIC_KEY_SHA256',
  'HEX_K12_C10_BEFORE_HANDOFF',
  'HEX_K12_C10_AFTER_HANDOFF',
  'HEX_K12_C10_AFTER_HANDOFF_PUBLIC_KEY',
  'HEX_K12_C10_DRIVER_CONFIG',
  'HEX_K12_REAL_10X_CYCLE_RUN_ID',
]

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function fail(message) {
  throw new Error(`K12 C10 restart recovery gate: ${message}`)
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`)
  return value
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort()
  const frozen = [...expected].sort()
  if (JSON.stringify(actual) !== JSON.stringify(frozen)) {
    fail(`${label} exact field set mismatch`)
  }
}

function decodedBase64(value, label) {
  if (typeof value !== 'string' || !value) fail(`${label} must be non-empty base64`)
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value) fail(`${label} must use canonical base64`)
  return bytes
}

export function verifySignedHandoff(envelopeText, publicKey) {
  let parsed
  try {
    parsed = JSON.parse(envelopeText)
  } catch {
    fail('signed envelope must be JSON')
  }
  const envelope = object(parsed, 'signed envelope')
  exactKeys(envelope, contract.signedEnvelope.exactFields, 'signed envelope')
  if (envelope.algorithm !== contract.signedEnvelope.algorithm) {
    fail(`signed envelope algorithm must be ${contract.signedEnvelope.algorithm}`)
  }
  const payloadBytes = decodedBase64(envelope.payload_b64, 'payload_b64')
  const signature = decodedBase64(envelope.signature_b64, 'signature_b64')
  if (!verify(null, payloadBytes, publicKey, signature)) fail('signature verification failed')
  try {
    return object(JSON.parse(payloadBytes.toString('utf8')), 'signed payload')
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('K12 C10')) throw error
    fail('signed payload must be UTF-8 JSON')
  }
}

export function validateHandoffPayload(payload, phase) {
  const required = phase === 'before' ? contract.requiredBefore : contract.requiredAfter
  exactKeys(payload, required, `${phase} payload`)
  if (payload.schema_version !== 1) fail(`${phase} schema_version must equal 1`)
  if (payload.phase !== phase) fail(`${phase} phase mismatch`)
  if (payload.cycle_id !== 'C10') fail(`${phase} cycle_id must equal C10`)
  if (payload.restart_method !== 'caller_owned_process_restart') {
    fail(`${phase} restart_method must prove caller-owned process restart`)
  }
  if (!Number.isInteger(payload.sidecar_pid) || payload.sidecar_pid <= 0) {
    fail(`${phase} sidecar_pid must be a positive integer`)
  }
  for (const counter of ['upload_count', 'index_count']) {
    if (!Number.isInteger(payload[counter]) || payload[counter] < 0) {
      fail(`${phase} ${counter} must be a non-negative integer`)
    }
  }
  for (const field of [
    'run_id',
    'document_id',
    'source_digest',
    'active_revision_id',
    'profile_id',
    'profile_config_hash',
    'query_digest',
    'hit_document_id',
    'citation_digest',
  ]) {
    if (typeof payload[field] !== 'string' || !payload[field].trim()) {
      fail(`${phase} ${field} must be non-empty`)
    }
  }
  if (payload.source_digest.replace(/^sha256:/, '') !== oracle.pdfSha256) {
    fail(`${phase} source_digest must match the frozen textbook PDF`)
  }
  if (payload.query_model !== contract.invariants.queryModel) {
    fail(`${phase} query_model must equal ${contract.invariants.queryModel}`)
  }
  if (
    !Number.isInteger(payload.page_start) ||
    !Number.isInteger(payload.page_end) ||
    payload.page_start > contract.invariants.oraclePhysicalPage ||
    payload.page_end < contract.invariants.oraclePhysicalPage
  ) {
    fail(`${phase} page range must contain oracle physical page`)
  }
  if (payload.hit_document_id !== payload.document_id) {
    fail(`${phase} hit_document_id must match document_id`)
  }
}

export function auditRestartHandoff(beforeValue, afterValue) {
  const before = object(beforeValue, 'before payload')
  const after = object(afterValue, 'after payload')
  validateHandoffPayload(before, 'before')
  validateHandoffPayload(after, 'after')

  if (before.run_id !== after.run_id) fail('run_id changed across restart')
  if (before.sidecar_pid === after.sidecar_pid) fail('sidecar_pid did not change')
  for (const field of [
    'document_id',
    'source_digest',
    'active_revision_id',
    'profile_id',
    'profile_config_hash',
    'query_model',
    'query_digest',
    'hit_document_id',
    'citation_digest',
    'page_start',
    'page_end',
  ]) {
    if (before[field] !== after[field]) fail(`${field} changed across restart`)
  }
  const uploadCountDelta = after.upload_count - before.upload_count
  const indexCountDelta = after.index_count - before.index_count
  if (uploadCountDelta !== contract.invariants.uploadCountDelta) {
    fail(`upload_count delta must equal ${contract.invariants.uploadCountDelta}`)
  }
  if (indexCountDelta !== contract.invariants.indexCountDelta) {
    fail(`index_count delta must equal ${contract.invariants.indexCountDelta}`)
  }

  return {
    beforePid: before.sidecar_pid,
    afterPid: after.sidecar_pid,
    documentId: before.document_id,
    activeRevisionId: before.active_revision_id,
    profileConfigHash: before.profile_config_hash,
    uploadCountDelta,
    indexCountDelta,
    citationDigest: before.citation_digest,
  }
}

export function executeCallerRestart(restartPath, { env = process.env, spawn = spawnSync } = {}) {
  const args = contract.callerRestart.args.map((value) =>
    value === '$HEX_K12_C10_DRIVER_CONFIG' ? env.HEX_K12_C10_DRIVER_CONFIG : value
  )
  const child = spawn(restartPath, args, {
    env: { ...env, DINGTALK_LIVE_SEND: '0' },
    shell: false,
    stdio: 'inherit',
  })
  if (child.error) fail(`caller restart hook failed to start: ${child.error.message}`)
  return Number.isInteger(child.status) ? child.status : 1
}

export function c10EnvironmentBlockers(env = process.env) {
  const blockers = []
  if ((env.HEX_K12_C10_RESTART_AUTHORIZED ?? '').trim() !== '1') {
    blockers.push('HEX_K12_C10_RESTART_AUTHORIZED=1')
  }
  for (const name of valueEnvironment) {
    if (!(env[name] ?? '').trim()) blockers.push(name)
  }
  for (const name of [
    'HEX_K12_C10_RESTART_HOOK',
    'HEX_K12_C10_HANDOFF_PUBLIC_KEY',
    'HEX_K12_C10_BEFORE_HANDOFF',
    'HEX_K12_C10_AFTER_HANDOFF',
    'HEX_K12_C10_AFTER_HANDOFF_PUBLIC_KEY',
    'HEX_K12_C10_DRIVER_CONFIG',
  ]) {
    const path = (env[name] ?? '').trim()
    if (path && !isAbsolute(path)) blockers.push(`${name}(absolute path)`)
  }
  const restartPath = (env.HEX_K12_C10_RESTART_HOOK ?? '').trim()
  if (
    restartPath &&
    resolve(restartPath) !== resolve(repoRoot, contract.isolatedDriver.module)
  ) {
    blockers.push('HEX_K12_C10_RESTART_HOOK(contract-owned isolated driver)')
  }
  for (const name of [
    'HEX_K12_C10_RESTART_HOOK_SHA256',
    'HEX_K12_C10_HANDOFF_PUBLIC_KEY_SHA256',
  ]) {
    const digest = (env[name] ?? '').trim()
    if (digest && !/^[a-f0-9]{64}$/.test(digest)) blockers.push(`${name}(sha256 hex)`)
  }
  return blockers
}

function verifiedInputFile(path, expectedDigest, label, { executable = false } = {}) {
  if (!existsSync(path) || !statSync(path).isFile()) fail(`${label} must be an existing file`)
  if (executable && (statSync(path).mode & 0o111) === 0) fail(`${label} must be executable`)
  const bytes = readFileSync(path)
  if (sha256(bytes) !== expectedDigest) fail(`${label} SHA-256 mismatch`)
  return bytes
}

async function writeEvidence(value) {
  await mkdir(dirname(reportPath), { recursive: true })
  await writeFile(reportPath, `${JSON.stringify(value, null, 2)}\n`)
}

async function runGate(argv) {
  if (JSON.stringify(argv) !== JSON.stringify(['--strict'])) {
    process.stderr.write('K12 C10 restart recovery gate accepts only --strict\n')
    process.exitCode = 2
    return
  }
  const blockers = c10EnvironmentBlockers(process.env)
  if (blockers.length > 0) {
    process.stderr.write(`K12 C10 restart recovery gate blocked: ${blockers.join(', ')}\n`)
    process.exitCode = 2
    return
  }

  try {
    const restartPath = process.env.HEX_K12_C10_RESTART_HOOK
    const publicKeyPath = process.env.HEX_K12_C10_HANDOFF_PUBLIC_KEY
    const beforePath = process.env.HEX_K12_C10_BEFORE_HANDOFF
    const afterPath = process.env.HEX_K12_C10_AFTER_HANDOFF
    const afterPublicKeyPath = process.env.HEX_K12_C10_AFTER_HANDOFF_PUBLIC_KEY
    verifiedInputFile(
      restartPath,
      process.env.HEX_K12_C10_RESTART_HOOK_SHA256,
      'caller restart hook',
      { executable: true },
    )
    const publicKey = verifiedInputFile(
      publicKeyPath,
      process.env.HEX_K12_C10_HANDOFF_PUBLIC_KEY_SHA256,
      'handoff public key',
    )
    const beforeEnvelope = readFileSync(beforePath, 'utf8')
    const before = verifySignedHandoff(beforeEnvelope, publicKey)
    if (before.run_id !== process.env.HEX_K12_REAL_10X_CYCLE_RUN_ID) {
      fail('before run_id must match the runner-owned C10 run id')
    }

    rmSync(afterPath, { force: true })
    rmSync(afterPublicKeyPath, { force: true })
    const restartStatus = executeCallerRestart(restartPath)
    if (restartStatus !== 0) fail(`caller restart hook exited ${restartStatus}`)
    if (!existsSync(afterPath)) fail('caller restart hook did not produce after handoff')
    if (!existsSync(afterPublicKeyPath) || !statSync(afterPublicKeyPath).isFile()) {
      fail('caller restart hook did not produce an ephemeral post public key')
    }
    const afterEnvelope = readFileSync(afterPath, 'utf8')
    const afterPublicKey = readFileSync(afterPublicKeyPath)
    const after = verifySignedHandoff(afterEnvelope, afterPublicKey)
    const audit = auditRestartHandoff(before, after)
    await writeEvidence({
      schemaVersion: contract.schemaVersion,
      status: 'passed',
      runIdSha256: sha256(before.run_id),
      restartHookSha256: process.env.HEX_K12_C10_RESTART_HOOK_SHA256,
      publicKeySha256: process.env.HEX_K12_C10_HANDOFF_PUBLIC_KEY_SHA256,
      afterPublicKeySha256: sha256(afterPublicKey),
      beforeEnvelopeSha256: sha256(beforeEnvelope),
      afterEnvelopeSha256: sha256(afterEnvelope),
      audit,
    })
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}

if (resolve(process.argv[1] ?? '') === resolve(scriptPath)) {
  await runGate(process.argv.slice(2))
}
