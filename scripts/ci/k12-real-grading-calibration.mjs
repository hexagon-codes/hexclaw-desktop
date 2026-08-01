#!/usr/bin/env node

import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseStrictJSON } from './k12-strict-json.mjs'

const PROVIDER = 'hexclaw-gpt'
const MODEL = 'gpt-5.6-sol'
const BUCKETS = [1, 8, 16, 32]
const RECEIPT_FIELDS = [
  'attempt_digest',
  'bucket',
  'latency_ms',
  'logical_operations',
  'model',
  'origin',
  'physical_provider_calls',
  'provider',
  'result_digest',
  'status',
]
const ATTEMPT_FIELDS = [
  'attempt_digest',
  'latency_ms',
  'logical_operations',
  'physical_provider_calls',
  'result_digest',
]

function fail(message) {
  throw new Error(`K12 real grading calibration: ${message}`)
}

function exactKeys(value, fields, label) {
  if (!value || Array.isArray(value) || typeof value !== 'object') fail(`${label} must be an object`)
  const actual = Object.keys(value).sort()
  const expected = [...fields].sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${label} exact field set mismatch`)
}

function isSHA256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  )
}

function canonicalBytes(value) {
  return Buffer.from(`${JSON.stringify(canonicalize(value))}\n`)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)]
}

function validateReceipt(receipt) {
  exactKeys(receipt, RECEIPT_FIELDS, 'calibration receipt')
  if (!BUCKETS.includes(receipt.bucket)) fail('calibration receipt bucket must be one of 1/8/16/32')
  if (receipt.provider !== PROVIDER) fail('calibration receipt provider drift')
  if (receipt.model !== MODEL) fail('calibration receipt model drift')
  if (receipt.origin !== 'real') fail('calibration receipt origin must be real')
  if (receipt.status !== 'succeeded') fail('calibration receipt terminal status must be succeeded')
  for (const name of ['attempt_digest', 'result_digest']) {
    if (!isSHA256(receipt[name])) fail(`calibration receipt ${name} must be SHA-256`)
  }
  for (const name of ['latency_ms', 'logical_operations', 'physical_provider_calls']) {
    if (!positiveInteger(receipt[name])) fail(`calibration receipt ${name} must be a positive integer`)
  }
}

export function buildCalibrationCandidate(receipts) {
  if (!Array.isArray(receipts) || receipts.length === 0) {
    fail('calibration receipts must be a non-empty array')
  }
  const attemptsByBucket = new Map(BUCKETS.map((bucket) => [bucket, []]))
  const attemptDigests = new Set()
  for (const receipt of receipts) {
    validateReceipt(receipt)
    if (attemptDigests.has(receipt.attempt_digest)) fail('duplicate calibration attempt digest')
    attemptDigests.add(receipt.attempt_digest)
    attemptsByBucket.get(receipt.bucket).push({
      attempt_digest: receipt.attempt_digest,
      latency_ms: receipt.latency_ms,
      logical_operations: receipt.logical_operations,
      physical_provider_calls: receipt.physical_provider_calls,
      result_digest: receipt.result_digest,
    })
  }
  if (BUCKETS.some((bucket) => attemptsByBucket.get(bucket).length === 0)) {
    fail('calibration receipts require exact 1/8/16/32 buckets')
  }

  const buckets = BUCKETS.map((maxProblems) => {
    const attempts = attemptsByBucket
      .get(maxProblems)
      .sort((left, right) => left.attempt_digest.localeCompare(right.attempt_digest))
    return { max_problems: maxProblems, attempts }
  })
  const evidence = {
    schema_version: 1,
    kind: 'k12-grading-calibration-candidate-evidence',
    provider: PROVIDER,
    model: MODEL,
    buckets,
  }
  const evidenceBytes = canonicalBytes(evidence)
  const evidenceSHA256 = sha256(evidenceBytes)
  const measurements = buckets.map(({ max_problems: maxProblems, attempts }) => {
    const latencies = attempts.map(({ latency_ms: latency }) => latency)
    return {
      max_problems: maxProblems,
      sample_count: attempts.length,
      success_count: attempts.length,
      p50_ms: percentile(latencies, 0.5),
      p95_ms: percentile(latencies, 0.95),
      logical_operations: attempts.reduce((total, attempt) => total + attempt.logical_operations, 0),
      physical_provider_calls: attempts.reduce(
        (total, attempt) => total + attempt.physical_provider_calls,
        0,
      ),
    }
  })
  const summary = {
    schema_version: 1,
    kind: 'k12-grading-calibration-candidate-summary',
    provider: PROVIDER,
    model: MODEL,
    evidence_sha256: evidenceSHA256,
    measurements,
  }
  const summaryBytes = canonicalBytes(summary)
  return Object.freeze({
    evidence: Object.freeze(evidence),
    evidenceBytes,
    evidenceSHA256,
    summary: Object.freeze(summary),
    summaryBytes,
    summarySHA256: sha256(summaryBytes),
  })
}

function outputPath(pathname, label) {
  if (typeof pathname !== 'string' || !isAbsolute(pathname)) fail(`${label} must be absolute`)
  const resolved = resolve(pathname)
  if (existsSync(resolved)) fail(`${label} must not already exist`)
  const directory = dirname(resolved)
  const link = lstatSync(directory)
  if (link.isSymbolicLink()) fail(`${label} parent directory must not be a symbolic link`)
  const directoryPath = realpathSync(directory)
  const metadata = statSync(directoryPath)
  if (!metadata.isDirectory() || (metadata.mode & 0o777) !== 0o700) {
    fail(`${label} parent directory permissions must be 0700`)
  }
  return resolved
}

function writeNewPrivateFile(pathname, bytes) {
  let descriptor
  try {
    descriptor = openSync(pathname, 'wx', 0o600)
    writeSync(descriptor, bytes)
    fsyncSync(descriptor)
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
  const link = lstatSync(pathname)
  const metadata = statSync(pathname)
  if (link.isSymbolicLink() || !metadata.isFile() || (metadata.mode & 0o777) !== 0o600) {
    fail('candidate output must remain a private regular file')
  }
}

export async function writeCalibrationCandidate({ evidencePath, summaryPath, candidate }) {
  if (!candidate?.evidenceBytes || !candidate?.summaryBytes) fail('candidate bytes are required')
  const evidence = outputPath(evidencePath, 'candidate evidence path')
  const summary = outputPath(summaryPath, 'candidate summary path')
  if (evidence === summary) fail('candidate evidence and summary paths must differ')
  let evidenceWritten = false
  let summaryWritten = false
  try {
    writeNewPrivateFile(evidence, candidate.evidenceBytes)
    evidenceWritten = true
    writeNewPrivateFile(summary, candidate.summaryBytes)
    summaryWritten = true
  } catch (error) {
    if (summaryWritten) unlinkSync(summary)
    if (evidenceWritten) unlinkSync(evidence)
    throw error
  }
  return Object.freeze({
    evidencePath: evidence,
    evidenceSHA256: sha256(readFileSync(evidence)),
    summaryPath: summary,
    summarySHA256: sha256(readFileSync(summary)),
  })
}

export function assertRealExecutionAuthority({ executeReal = false, env = process.env } = {}) {
  if (executeReal !== true) return Object.freeze({ mode: 'receipt-compile' })
  if ((env.HEX_K12_CALIBRATION_REAL_AUTHORIZED ?? '').trim() !== '1') {
    fail('HEX_K12_CALIBRATION_REAL_AUTHORIZED=1 is required before real execution')
  }
  if ((env.HEX_K12_LIVE_PROVIDER ?? '').trim() !== PROVIDER) {
    fail('HEX_K12_LIVE_PROVIDER must equal hexclaw-gpt before real execution')
  }
  if ((env.HEX_K12_LIVE_MODEL ?? '').trim() !== MODEL) {
    fail('HEX_K12_LIVE_MODEL must equal gpt-5.6-sol before real execution')
  }
  for (const name of [
    'HEX_K12_CALIBRATION_PROFILE',
    'HEX_K12_CALIBRATION_FIXTURE_MANIFEST',
    'HEX_K12_CALIBRATION_RECEIPT_DIR',
  ]) {
    if (!isAbsolute((env[name] ?? '').trim())) fail(`${name} must be an explicit absolute path`)
  }
  const maximumAttempts = Number(env.HEX_K12_CALIBRATION_MAX_ATTEMPTS)
  if (!Number.isSafeInteger(maximumAttempts) || maximumAttempts < 1) {
    fail('HEX_K12_CALIBRATION_MAX_ATTEMPTS must be a positive integer')
  }
  return Object.freeze({
    mode: 'caller-owned-real-execution',
    maximumAttempts,
    provider: PROVIDER,
    model: MODEL,
  })
}

function parseArguments(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]
    if (!['--receipts', '--evidence', '--summary'].includes(name) || values[name] !== undefined) {
      fail('usage is --receipts ABSOLUTE_JSON --evidence ABSOLUTE_JSON --summary ABSOLUTE_JSON')
    }
    const value = argv[index + 1]
    if (typeof value !== 'string' || value.startsWith('--')) fail(`${name} requires one value`)
    values[name] = value
    index += 1
  }
  if (Object.keys(values).length !== 3) {
    fail('usage is --receipts ABSOLUTE_JSON --evidence ABSOLUTE_JSON --summary ABSOLUTE_JSON')
  }
  return values
}

export async function runCalibrationCLI(argv = process.argv.slice(2), { env = process.env } = {}) {
  assertRealExecutionAuthority({ executeReal: false, env })
  const values = parseArguments(argv)
  if (!isAbsolute(values['--receipts'])) fail('--receipts must be absolute')
  const receipts = parseStrictJSON(readFileSync(values['--receipts']), {
    label: 'K12 grading calibration receipts',
  })
  const candidate = buildCalibrationCandidate(receipts)
  return writeCalibrationCandidate({
    evidencePath: values['--evidence'],
    summaryPath: values['--summary'],
    candidate,
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCalibrationCLI().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 2
  })
}
