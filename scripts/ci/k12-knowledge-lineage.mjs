import { createHash, randomBytes } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { parseStrictJSON } from './k12-strict-json.mjs'

const stateFileName = 'knowledge-lineage.json'
const phases = Object.freeze({
  C07: Object.freeze([
    'schema_version',
    'phase',
    'parent_run_sha256',
    'document_id',
    'job_id',
    'source_digest',
    'bytes',
    'pages',
  ]),
  C08: Object.freeze([
    'schema_version',
    'phase',
    'parent_run_sha256',
    'document_id',
    'job_id',
    'source_digest',
    'bytes',
    'pages',
    'document_generation',
    'active_revision_id',
    'profile_id',
    'profile_config_hash',
  ]),
  C09: Object.freeze([
    'schema_version',
    'phase',
    'parent_run_sha256',
    'document_id',
    'job_id',
    'source_digest',
    'bytes',
    'pages',
    'document_generation',
    'active_revision_id',
    'profile_id',
    'profile_config_hash',
    'hit_revision_id',
    'chunk_id',
    'citation_digest',
    'query_digest',
    'query_model',
    'source_offset_start',
    'source_offset_end',
    'raw_source_span_normalized_length',
    'raw_source_span_normalized_sha256',
  ]),
})

function fail(message) {
  throw new Error(`K12 knowledge lineage: ${message}`)
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

function sameExactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail(`${label} must be an object`)
  const actual = Object.keys(value).sort()
  const frozen = [...expected].sort()
  if (JSON.stringify(actual) !== JSON.stringify(frozen)) fail(`${label} exact field set mismatch`)
}

function nonEmpty(value, label) {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} must be non-empty`)
  return value
}

function sha256(value, label) {
  const text = nonEmpty(value, label)
  if (!/^[a-f0-9]{64}$/.test(text)) fail(`${label} must be a SHA-256 hex digest`)
  return text
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(`${label} must be a positive integer`)
  return value
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} must be a non-negative integer`)
  return value
}

function prefixedSha256(value, label) {
  const text = nonEmpty(value, label)
  if (!/^sha256:[a-f0-9]{64}$/.test(text)) {
    fail(`${label} must be a sha256-prefixed SHA-256 hex digest`)
  }
  return text
}

function assertLineage(lineage) {
  if (!lineage || typeof lineage !== 'object' || Array.isArray(lineage))
    fail('lineage handle must be an object')
  const root = nonEmpty(lineage.root, 'lineage root')
  const path = nonEmpty(lineage.path, 'lineage path')
  if (!isAbsolute(root) || !isAbsolute(path)) fail('lineage root/path must be absolute')
  if (resolve(path) !== resolve(root, stateFileName))
    fail('lineage path must be the canonical state filename')
  return {
    root: resolve(root),
    path: resolve(path),
    parentRunSha256: sha256(lineage.parentRunSha256, 'parent run digest'),
  }
}

async function statPrivateRegular(path, { allowMissing = false } = {}) {
  let value
  try {
    value = await lstat(path)
  } catch (error) {
    if (allowMissing && error && typeof error === 'object' && error.code === 'ENOENT')
      return undefined
    throw error
  }
  if (value.isSymbolicLink()) fail('lineage state must not be a symlink')
  if (!value.isFile()) fail('lineage state must be a regular file')
  if ((value.mode & 0o777) !== 0o600) fail('lineage state must be mode 0600')
  return value
}

async function assertPrivateRoot(root) {
  const value = await lstat(root)
  if (value.isSymbolicLink()) fail('lineage root must not be a symlink')
  if (!value.isDirectory()) fail('lineage root must be a directory')
  if ((value.mode & 0o777) !== 0o700) fail('lineage root must be mode 0700')
}

function validateState(value, expectedPhase, parentRunSha256) {
  const fields = phases[expectedPhase]
  if (!fields) fail(`unsupported expected phase ${expectedPhase}`)
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('lineage state must be an object')
  if (value.phase !== expectedPhase) fail(`lineage phase must equal ${expectedPhase}`)
  sameExactKeys(value, fields, 'lineage state')
  if (value.schema_version !== 1) fail('lineage schema_version must equal 1')
  if (value.parent_run_sha256 !== parentRunSha256) fail('lineage parent run digest mismatch')
  nonEmpty(value.document_id, 'document_id')
  nonEmpty(value.job_id, 'job_id')
  sha256(value.source_digest, 'source_digest')
  positiveInteger(value.bytes, 'bytes')
  positiveInteger(value.pages, 'pages')
  if (expectedPhase === 'C08' || expectedPhase === 'C09') {
    positiveInteger(value.document_generation, 'document_generation')
    nonEmpty(value.active_revision_id, 'active_revision_id')
    nonEmpty(value.profile_id, 'profile_id')
    sha256(value.profile_config_hash, 'profile_config_hash')
  }
  if (expectedPhase === 'C09') {
    if (nonEmpty(value.hit_revision_id, 'hit_revision_id') !== value.active_revision_id) {
      fail('hit_revision_id must equal active_revision_id')
    }
    nonEmpty(value.chunk_id, 'chunk_id')
    sha256(value.citation_digest, 'citation_digest')
    prefixedSha256(value.query_digest, 'query_digest')
    if (value.query_model !== 'qwen3-embedding:8b') {
      fail('query_model must equal qwen3-embedding:8b')
    }
    const offsetStart = nonNegativeInteger(value.source_offset_start, 'source_offset_start')
    const offsetEnd = positiveInteger(value.source_offset_end, 'source_offset_end')
    if (offsetEnd <= offsetStart) fail('source_offset_end must be greater than source_offset_start')
    positiveInteger(value.raw_source_span_normalized_length, 'raw_source_span_normalized_length')
    sha256(value.raw_source_span_normalized_sha256, 'raw_source_span_normalized_sha256')
  }
  return value
}

async function writeFresh(path, value) {
  const existing = await statPrivateRegular(path, { allowMissing: true })
  if (existing) fail('lineage state must be fresh and not pre-existing')
  try {
    await writeFile(path, `${JSON.stringify(value)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    })
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'EEXIST') {
      fail('lineage state must be fresh and not pre-existing')
    }
    throw error
  }
  await statPrivateRegular(path)
}

async function replacePrivate(path, value) {
  const root = dirname(path)
  const temporary = resolve(root, `.${stateFileName}.${randomBytes(16).toString('hex')}.tmp`)
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    })
    await statPrivateRegular(temporary)
    await rename(temporary, path)
    await statPrivateRegular(path)
  } finally {
    await unlink(temporary).catch((error) => {
      if (error && typeof error === 'object' && error.code === 'ENOENT') return
      throw error
    })
  }
}

export async function createKnowledgeLineage({ root, parentRunId }) {
  if (!isAbsolute(nonEmpty(root, 'requested lineage base root'))) {
    fail('requested lineage base root must be absolute')
  }
  const parent = resolve(root)
  await assertPrivateRoot(parent)
  const lineageRoot = resolve(parent, 'knowledge-lineage')
  try {
    await mkdir(lineageRoot, { mode: 0o700 })
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'EEXIST') {
      fail('lineage root must be fresh and not pre-existing')
    }
    throw error
  }
  await assertPrivateRoot(lineageRoot)
  return Object.freeze({
    root: lineageRoot,
    path: resolve(lineageRoot, stateFileName),
    parentRunSha256: digest(nonEmpty(parentRunId, 'parent run id')),
  })
}

export async function createRunnerKnowledgeLineage({
  parentRunId,
  createTemporaryRoot = mkdtemp,
} = {}) {
  const baseRoot = await createTemporaryRoot(join(tmpdir(), 'hexclaw-k12-real-10x-'))
  if (!isAbsolute(baseRoot)) fail('runner-created lineage root must be absolute')
  await chmod(baseRoot, 0o700)
  const lineage = await createKnowledgeLineage({ root: baseRoot, parentRunId })
  return Object.freeze({ ...lineage, baseRoot: resolve(baseRoot) })
}

export async function cleanupRunnerKnowledgeLineage(lineage) {
  const handle = assertLineage(lineage)
  const baseRoot = nonEmpty(lineage?.baseRoot, 'runner lineage base root')
  if (!isAbsolute(baseRoot)) fail('runner lineage base root must be absolute')
  const relativeRoot = relative(resolve(baseRoot), handle.root)
  if (relativeRoot !== 'knowledge-lineage')
    fail('runner lineage root must be exactly one private child')
  await assertPrivateRoot(resolve(baseRoot))
  await rm(resolve(baseRoot), { recursive: true, force: true })
}

export async function readKnowledgeLineage(lineage, { expectedPhase }) {
  const handle = assertLineage(lineage)
  await assertPrivateRoot(handle.root)
  await statPrivateRegular(handle.path)
  const raw = await readFile(handle.path, 'utf8')
  const parsed = parseStrictJSON(raw, { label: 'K12 knowledge lineage state' })
  return validateState(parsed, expectedPhase, handle.parentRunSha256)
}

export async function writeC07KnowledgeLineage(lineage, { documentId, jobId, source }) {
  const handle = assertLineage(lineage)
  await assertPrivateRoot(handle.root)
  sameExactKeys(source, ['digest', 'bytes', 'pages'], 'C07 source')
  const value = {
    schema_version: 1,
    phase: 'C07',
    parent_run_sha256: handle.parentRunSha256,
    document_id: nonEmpty(documentId, 'document_id'),
    job_id: nonEmpty(jobId, 'job_id'),
    source_digest: sha256(source.digest, 'source digest'),
    bytes: positiveInteger(source.bytes, 'source bytes'),
    pages: positiveInteger(source.pages, 'source pages'),
  }
  await writeFresh(handle.path, value)
  return readKnowledgeLineage(handle, { expectedPhase: 'C07' })
}

export async function advanceKnowledgeLineage(lineage, { expectedPhase, nextPhase, next }) {
  const handle = assertLineage(lineage)
  const prior = await readKnowledgeLineage(handle, { expectedPhase })
  if (
    (expectedPhase === 'C07' && nextPhase !== 'C08') ||
    (expectedPhase === 'C08' && nextPhase !== 'C09')
  ) {
    fail(`cannot advance ${expectedPhase} to ${nextPhase}`)
  }
  const nextFields =
    nextPhase === 'C08'
      ? ['document_generation', 'active_revision_id', 'profile_id', 'profile_config_hash']
      : [
          'hit_revision_id',
          'chunk_id',
          'citation_digest',
          'query_digest',
          'query_model',
          'source_offset_start',
          'source_offset_end',
          'raw_source_span_normalized_length',
          'raw_source_span_normalized_sha256',
        ]
  sameExactKeys(next, nextFields, `${nextPhase} state extension`)
  const value = { ...prior, ...next, phase: nextPhase }
  validateState(value, nextPhase, handle.parentRunSha256)
  await replacePrivate(handle.path, value)
  return readKnowledgeLineage(handle, { expectedPhase: nextPhase })
}
