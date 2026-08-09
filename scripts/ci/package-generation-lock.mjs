#!/usr/bin/env node

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { constants, fstatSync } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import {
  BoundedProcessError,
  runBoundedProcess,
  runBoundedProcessWithFileDescriptors,
} from './run-bounded-process.mjs'

const LOCKF_PATH = '/usr/bin/lockf'
const LOCK_DESCRIPTOR = 3
const EX_USAGE = 64
const EX_SOFTWARE = 70
const EX_TEMPFAIL = 75
const PRIVATE_FILE_MODE = 0o600
const PRIVATE_DIRECTORY_MODE = 0o700
const MAX_STATE_BYTES = 16 * 1024
const MAX_STATE_RECORDS = 4_096
const MAX_CONTROL_OUTPUT_BYTES = 64 * 1024
const DEFAULT_COMMAND_TIMEOUT_MS = 45 * 60 * 1_000
const MAX_COMMAND_TIMEOUT_MS = 55 * 60 * 1_000
const DEFAULT_COMMAND_OUTPUT_BYTES = 16 * 1024 * 1024
const OUTER_TIMEOUT_GRACE_MS = 5 * 60 * 1_000
const MAX_RUNNER_TIMEOUT_MS = 60 * 60 * 1_000
const ACTIVE_RETRY_TIMEOUT_MS = 500
const ACTIVE_RETRY_INTERVAL_MS = 25
const READINESS_TIMEOUT_MS = 5_000
const OWNER_PIPE_HEARTBEAT_INTERVAL_MS = 100
const OWNER_PIPE_HEARTBEAT = '\0'
const FINAL_VERIFIER_SEPARATOR = '--final-verifier'
const GENERATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u
const TOKEN_PATTERN = /^[a-f0-9]{64}$/u
const STATE_ID_PATTERN = /^[a-f0-9]{64}$/u
const LOCK_SCHEMA = 'hexclaw.package-generation-lock.v2'
const START_SCHEMA = 'hexclaw.package-generation-start.v2'
const RESOLUTION_SCHEMA = 'hexclaw.package-generation-resolution.v2'
const CONTEXT_SCHEMA = 'hexclaw.package-generation-context.v2'
const STATE_ENTRY_PATTERN = /^([a-f0-9]{64})\.(started|resolved)\.json$/u
const INTERNAL_STATUS_PATTERN =
  /^STATUS package-generation-lock category=([a-z0-9-]+) exit=([0-9]{1,3})(?: signal=([A-Z0-9]+))?\n$/u
const INTERNAL_ERROR_PATTERN =
  /^ERROR: package-generation-lock category=([a-z0-9-]+) exit=([0-9]{1,3})(?: signal=([A-Z0-9]+))?\n$/u

export const PACKAGE_GENERATION_CONTEXT_ENV = 'HEXCLAW_PACKAGE_GENERATION_CONTEXT'
export const PACKAGE_GENERATION_CONTROL_BASENAME = '.package-local.control'
export const PACKAGE_GENERATION_PLAN_PARENT_BASENAME = '.package-local.generations'
export const PACKAGE_GENERATION_LOCK_BASENAME = '.package-local.lock'
export const PACKAGE_GENERATION_TOMBSTONE_BASENAME = '.package-local.in-progress'

export class PackageGenerationLockError extends Error {
  constructor(category, details = {}) {
    const exitCode = Number.isInteger(details.exitCode) ? details.exitCode : EX_SOFTWARE
    const signal = typeof details.signal === 'string' ? details.signal : undefined
    const fields = [`Package generation lock failed: category=${category}`, `exit=${exitCode}`]
    if (signal) fields.push(`signal=${signal}`)
    super(fields.join(' '))
    this.name = 'PackageGenerationLockError'
    this.category = category
    this.exitCode = exitCode
    this.signal = signal
  }
}

function fail(category, details) {
  throw new PackageGenerationLockError(category, details)
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function requireExactOptions(options, allowed) {
  if (!isPlainObject(options)) fail('invalid-options', { exitCode: EX_USAGE })
  const names = Object.keys(options)
  if (names.some((name) => !allowed.includes(name))) {
    fail('invalid-options', { exitCode: EX_USAGE })
  }
}

function requireGenerationID(value) {
  if (typeof value !== 'string' || !GENERATION_PATTERN.test(value)) {
    fail('invalid-generation', { exitCode: EX_USAGE })
  }
  return value
}

function requireToken(value) {
  if (typeof value !== 'string' || !TOKEN_PATTERN.test(value)) {
    fail('invalid-token', { exitCode: EX_USAGE })
  }
  return value
}

function requireStateID(value) {
  if (typeof value !== 'string' || !STATE_ID_PATTERN.test(value)) {
    fail('context-invalid', { exitCode: EX_USAGE })
  }
  return value
}

function requirePositiveInteger(value, fallback, maximum, category) {
  const selected = value ?? fallback
  if (!Number.isSafeInteger(selected) || selected <= 0 || selected > maximum) {
    fail(category, { exitCode: EX_USAGE })
  }
  return selected
}

function validateEnvironment(environment) {
  if (!isPlainObject(environment)) fail('invalid-environment', { exitCode: EX_USAGE })
  const clean = Object.create(null)
  for (const [name, value] of Object.entries(environment)) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) ||
      typeof value !== 'string' ||
      name.includes('\0') ||
      value.includes('\0') ||
      name === PACKAGE_GENERATION_CONTEXT_ENV
    ) {
      fail('invalid-environment', { exitCode: EX_USAGE })
    }
    clean[name] = value
  }
  return clean
}

function defaultEnvironment() {
  return Object.assign(Object.create(null), {
    LANG: 'C',
    LC_ALL: 'C',
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
  })
}

function requireAbsolutePath(value, category = 'invalid-path') {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > 4096 ||
    value.includes('\0') ||
    !isAbsolute(value)
  ) {
    fail(category, { exitCode: EX_USAGE })
  }
  return resolve(value)
}

function currentUID() {
  return typeof process.getuid === 'function' ? BigInt(process.getuid()) : undefined
}

function canonicalJSON(value) {
  const ordered = Object.fromEntries(
    Object.entries(value).sort(([left], [right]) =>
      Buffer.compare(Buffer.from(left), Buffer.from(right)),
    ),
  )
  return Buffer.from(`${JSON.stringify(ordered)}\n`, 'utf8')
}

function tokenSHA256(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

function equalDigest(left, right) {
  if (!TOKEN_PATTERN.test(left) || !TOKEN_PATTERN.test(right)) return false
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
}

function generationStateID(generationId, tokenDigest, planRoot) {
  return createHash('sha256')
    .update(generationId, 'utf8')
    .update('\0', 'utf8')
    .update(tokenDigest, 'utf8')
    .update('\0', 'utf8')
    .update(planRoot, 'utf8')
    .digest('hex')
}

function fileIdentityFromMetadata(metadata) {
  return Object.freeze({
    ctime_ns: metadata.ctimeNs.toString(),
    dev: metadata.dev.toString(),
    ino: metadata.ino.toString(),
    mode: Number(metadata.mode & 0o777n),
    mtime_ns: metadata.mtimeNs.toString(),
    nlink: metadata.nlink.toString(),
    size: metadata.size.toString(),
    uid: metadata.uid.toString(),
  })
}

function validFileIdentity(value) {
  return (
    isPlainObject(value) &&
    typeof value.ctime_ns === 'string' &&
    /^[0-9]+$/u.test(value.ctime_ns) &&
    typeof value.dev === 'string' &&
    /^[0-9]+$/u.test(value.dev) &&
    typeof value.ino === 'string' &&
    /^[0-9]+$/u.test(value.ino) &&
    value.mode === PRIVATE_FILE_MODE &&
    typeof value.mtime_ns === 'string' &&
    /^[0-9]+$/u.test(value.mtime_ns) &&
    value.nlink === '1' &&
    typeof value.size === 'string' &&
    /^[0-9]+$/u.test(value.size) &&
    typeof value.uid === 'string' &&
    /^[0-9]+$/u.test(value.uid)
  )
}

function sameFileIdentity(left, right) {
  return (
    validFileIdentity(left) &&
    validFileIdentity(right) &&
    Object.keys(left).every((name) => left[name] === right[name])
  )
}

function directoryIdentityFromMetadata(metadata) {
  return Object.freeze({
    dev: metadata.dev.toString(),
    ino: metadata.ino.toString(),
    mode: Number(metadata.mode & 0o777n),
    uid: metadata.uid.toString(),
  })
}

function validDirectoryIdentity(value) {
  return (
    isPlainObject(value) &&
    typeof value.dev === 'string' &&
    /^[0-9]+$/u.test(value.dev) &&
    typeof value.ino === 'string' &&
    /^[0-9]+$/u.test(value.ino) &&
    value.mode === PRIVATE_DIRECTORY_MODE &&
    typeof value.uid === 'string' &&
    /^[0-9]+$/u.test(value.uid)
  )
}

function sameDirectoryIdentity(left, right) {
  return (
    validDirectoryIdentity(left) &&
    validDirectoryIdentity(right) &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid
  )
}

function validateRegularFileMetadata(metadata, label) {
  if (!metadata.isFile()) fail(`${label}-type`)
  if (metadata.nlink !== 1n) fail(`${label}-hard-link`)
  if (Number(metadata.mode & 0o777n) !== PRIVATE_FILE_MODE) fail(`${label}-permissions`)
  const uid = currentUID()
  if (uid !== undefined && metadata.uid !== uid) fail(`${label}-owner`)
  if (metadata.size > BigInt(MAX_STATE_BYTES)) fail(`${label}-size`)
}

function validateDirectoryMetadata(metadata, label, exactPrivate) {
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail(`${label}-type`)
  const uid = currentUID()
  if (uid !== undefined && metadata.uid !== uid) fail(`${label}-owner`)
  const mode = Number(metadata.mode & 0o777n)
  if (exactPrivate ? mode !== PRIVATE_DIRECTORY_MODE : (mode & 0o022) !== 0) {
    fail(`${label}-permissions`)
  }
}

async function syncDirectory(pathname) {
  let handle
  try {
    handle = await open(pathname, constants.O_RDONLY)
    await handle.sync()
  } catch {
    fail('state-sync')
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function canonicalExistingDirectory(value, label, exactPrivate = false) {
  const pathname = requireAbsolutePath(value, label)
  let canonical
  try {
    canonical = await realpath(pathname)
  } catch {
    fail(`${label}-open`)
  }
  const metadata = await lstat(canonical, { bigint: true }).catch(() => fail(`${label}-open`))
  validateDirectoryMetadata(metadata, label, exactPrivate)
  return Object.freeze({
    identity: directoryIdentityFromMetadata(metadata),
    path: canonical,
  })
}

async function ensurePrivateDirectory(pathname, label) {
  const requested = requireAbsolutePath(pathname)
  const parent = await canonicalExistingDirectory(dirname(requested), `${label}-parent`)
  const canonicalPath = join(parent.path, basename(requested))
  if (canonicalPath !== requested) fail(`${label}-path`)
  let created = false
  try {
    await mkdir(canonicalPath, { mode: PRIVATE_DIRECTORY_MODE })
    created = true
  } catch (error) {
    if (error?.code !== 'EEXIST') fail(`${label}-create`)
  }
  const inspected = await canonicalExistingDirectory(canonicalPath, label, true)
  if (inspected.path !== canonicalPath) fail(`${label}-path`)
  if (created) await syncDirectory(parent.path)
  return inspected
}

function isContainedBy(parent, candidate) {
  const child = relative(parent, candidate)
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

function fixedStatePaths(lockValue, tombstoneValue) {
  const lockPath = requireAbsolutePath(lockValue)
  const tombstonePath = requireAbsolutePath(tombstoneValue)
  const controlDirectory = dirname(lockPath)
  if (
    basename(lockPath) !== PACKAGE_GENERATION_LOCK_BASENAME ||
    basename(tombstonePath) !== PACKAGE_GENERATION_TOMBSTONE_BASENAME ||
    dirname(tombstonePath) !== controlDirectory ||
    basename(controlDirectory) !== PACKAGE_GENERATION_CONTROL_BASENAME
  ) {
    fail('invalid-control-path', { exitCode: EX_USAGE })
  }
  return Object.freeze({ controlDirectory, lockPath, tombstonePath })
}

async function prepareGenerationLayout(options) {
  const cwd = await canonicalExistingDirectory(options.cwd, 'invalid-cwd')
  const generationId = requireGenerationID(options.generationId)
  const paths = fixedStatePaths(options.lockPath, options.tombstonePath)
  const evidenceRoot = await canonicalExistingDirectory(
    dirname(paths.controlDirectory),
    'control-parent',
  )
  if (
    paths.controlDirectory !== join(evidenceRoot.path, PACKAGE_GENERATION_CONTROL_BASENAME) ||
    !isContainedBy(cwd.path, evidenceRoot.path)
  ) {
    fail('invalid-control-path', { exitCode: EX_USAGE })
  }
  const expectedPlanRoot = join(
    evidenceRoot.path,
    PACKAGE_GENERATION_PLAN_PARENT_BASENAME,
    generationId,
  )
  if (requireAbsolutePath(options.planRoot, 'invalid-plan-path') !== expectedPlanRoot) {
    fail('invalid-plan-path', { exitCode: EX_USAGE })
  }
  const planParent = await ensurePrivateDirectory(dirname(expectedPlanRoot), 'plan-parent')
  const plan = await ensurePrivateDirectory(join(planParent.path, generationId), 'plan')
  const control = await ensurePrivateDirectory(paths.controlDirectory, 'control')
  const tombstone = await ensurePrivateDirectory(paths.tombstonePath, 'marker')
  return Object.freeze({
    ...paths,
    controlIdentity: control.identity,
    cwd: cwd.path,
    evidenceRoot: evidenceRoot.path,
    generationId,
    planRoot: plan.path,
    tombstoneIdentity: tombstone.identity,
  })
}

async function prepareReadinessLayout(lockValue, tombstoneValue) {
  const paths = fixedStatePaths(lockValue, tombstoneValue)
  const evidenceRoot = await canonicalExistingDirectory(
    dirname(paths.controlDirectory),
    'control-parent',
  )
  if (paths.controlDirectory !== join(evidenceRoot.path, PACKAGE_GENERATION_CONTROL_BASENAME)) {
    fail('invalid-control-path', { exitCode: EX_USAGE })
  }
  const control = await ensurePrivateDirectory(paths.controlDirectory, 'control')
  const tombstone = await ensurePrivateDirectory(paths.tombstonePath, 'marker')
  return Object.freeze({
    ...paths,
    controlIdentity: control.identity,
    evidenceRoot: evidenceRoot.path,
    tombstoneIdentity: tombstone.identity,
  })
}

function mapOpenError(error, label, allowMissing) {
  if (error?.code === 'ENOENT' && allowMissing) return undefined
  if (error?.code === 'ELOOP' || error?.code === 'EISDIR') fail(`${label}-type`)
  if (error?.code === 'EACCES' || error?.code === 'EPERM') fail(`${label}-permissions`)
  fail(`${label}-open`)
}

async function inspectOpenFile(handle, pathname, label, read) {
  const before = await handle.stat({ bigint: true })
  validateRegularFileMetadata(before, label)
  const identity = fileIdentityFromMetadata(before)
  const pathBefore = await lstat(pathname, { bigint: true }).catch(() => fail(`${label}-identity`))
  if (!sameFileIdentity(identity, fileIdentityFromMetadata(pathBefore))) fail(`${label}-identity`)
  let bytes
  if (read) {
    bytes = Buffer.alloc(Number(before.size))
    let offset = 0
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (result.bytesRead <= 0) fail(`${label}-identity`)
      offset += result.bytesRead
    }
  }
  const after = await handle.stat({ bigint: true })
  const pathAfter = await lstat(pathname, { bigint: true }).catch(() => fail(`${label}-identity`))
  if (
    !sameFileIdentity(identity, fileIdentityFromMetadata(after)) ||
    !sameFileIdentity(identity, fileIdentityFromMetadata(pathAfter))
  ) {
    fail(`${label}-identity`)
  }
  return Object.freeze({ bytes, identity })
}

async function inspectSecureFile(pathname, label, { allowMissing = false, read = false } = {}) {
  let handle
  try {
    handle = await open(pathname, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    return mapOpenError(error, label, allowMissing)
  }
  try {
    return await inspectOpenFile(handle, pathname, label, read)
  } finally {
    await handle.close().catch(() => undefined)
  }
}

function parseExactRecord(bytes, fields, schema, category) {
  let value
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch {
    fail(category)
  }
  if (!isPlainObject(value)) fail(category)
  const actual = Object.keys(value).sort()
  const expected = [...fields].sort()
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    fail(category)
  }
  if (value.schema_version !== schema) fail(category)
  return value
}

function lockRecord(controlIdentity) {
  return Object.freeze({
    control_identity: controlIdentity,
    schema_version: LOCK_SCHEMA,
  })
}

function validateLockRecord(bytes, controlIdentity) {
  const record = parseExactRecord(
    bytes,
    ['control_identity', 'schema_version'],
    LOCK_SCHEMA,
    'lock-content',
  )
  if (!sameDirectoryIdentity(record.control_identity, controlIdentity)) fail('lock-content')
}

async function openLockFile(pathname, controlIdentity) {
  let handle
  let created = false
  try {
    handle = await open(
      pathname,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      PRIVATE_FILE_MODE,
    )
    created = true
  } catch (error) {
    if (error?.code !== 'EEXIST') return mapOpenError(error, 'lock', false)
    try {
      handle = await open(pathname, constants.O_RDWR | constants.O_NOFOLLOW)
    } catch (openError) {
      return mapOpenError(openError, 'lock', false)
    }
  }
  try {
    if (created) {
      await handle.chmod(PRIVATE_FILE_MODE)
      await handle.writeFile(canonicalJSON(lockRecord(controlIdentity)))
      await handle.sync()
      await syncDirectory(dirname(pathname))
    }
    const inspected = await inspectOpenFile(handle, pathname, 'lock', true)
    validateLockRecord(inspected.bytes, controlIdentity)
    return Object.freeze({ handle, identity: inspected.identity })
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
}

function startRecord(generationId, ownerToken, planRoot) {
  const tokenDigest = tokenSHA256(ownerToken)
  return Object.freeze({
    generation_id: generationId,
    plan_root: planRoot,
    schema_version: START_SCHEMA,
    state_id: generationStateID(generationId, tokenDigest, planRoot),
    token_sha256: tokenDigest,
  })
}

function startPath(tombstonePath, stateId) {
  return join(tombstonePath, `${stateId}.started.json`)
}

function resolutionPath(tombstonePath, stateId) {
  return join(tombstonePath, `${stateId}.resolved.json`)
}

async function createImmutableRecord(pathname, record, label) {
  let handle
  try {
    handle = await open(
      pathname,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      PRIVATE_FILE_MODE,
    )
    await handle.chmod(PRIVATE_FILE_MODE)
    await handle.writeFile(canonicalJSON(record))
    await handle.sync()
  } catch (error) {
    if (error?.code === 'EEXIST') fail(`${label}-exists`)
    if (error instanceof PackageGenerationLockError) throw error
    fail(`${label}-create`)
  } finally {
    await handle?.close().catch(() => undefined)
  }
  await syncDirectory(dirname(pathname))
  const inspected = await inspectSecureFile(pathname, label, { read: true })
  if (!inspected.bytes.equals(canonicalJSON(record))) fail(`${label}-identity`)
  return inspected
}

function validateStartRecord(record, stateId, evidenceRoot) {
  if (
    !GENERATION_PATTERN.test(record.generation_id) ||
    !TOKEN_PATTERN.test(record.token_sha256) ||
    record.state_id !== stateId ||
    typeof record.plan_root !== 'string' ||
    !isAbsolute(record.plan_root) ||
    record.plan_root !==
      join(
        evidenceRoot,
        PACKAGE_GENERATION_PLAN_PARENT_BASENAME,
        record.generation_id,
      ) ||
    generationStateID(record.generation_id, record.token_sha256, record.plan_root) !== stateId
  ) {
    fail('marker-content')
  }
}

function validateResolutionRecord(record, state, starts) {
  if (
    !['cancelled', 'completed', 'superseded'].includes(record.resolution) ||
    record.state_id !== state.record.state_id ||
    record.generation_id !== state.record.generation_id ||
    record.token_sha256 !== state.record.token_sha256 ||
    !sameFileIdentity(record.start_identity, state.identity) ||
    !STATE_ID_PATTERN.test(record.resolver_state_id)
  ) {
    fail('marker-content')
  }
  if (record.resolution === 'cancelled') {
    if (
      record.resolver_state_id !== record.state_id ||
      record.lock_identity !== null ||
      record.final_verification_succeeded !== false
    ) {
      fail('marker-content')
    }
    return
  }
  if (!validFileIdentity(record.lock_identity)) fail('marker-content')
  if (record.resolution === 'completed') {
    if (
      record.resolver_state_id !== record.state_id ||
      record.final_verification_succeeded !== true
    ) {
      fail('marker-content')
    }
    return
  }
  if (
    record.resolver_state_id === record.state_id ||
    record.final_verification_succeeded !== false ||
    !starts.has(record.resolver_state_id)
  ) {
    fail('marker-content')
  }
}

async function scanGenerationStates(layout) {
  const entries = await readdir(layout.tombstonePath, { withFileTypes: true }).catch(() =>
    fail('marker-open'),
  )
  if (entries.length > MAX_STATE_RECORDS) fail('marker-capacity')
  const starts = new Map()
  const pendingResolutions = []
  for (const entry of entries) {
    const match = STATE_ENTRY_PATTERN.exec(entry.name)
    if (!entry.isFile() || entry.isSymbolicLink() || !match) fail('marker-content')
    const pathname = join(layout.tombstonePath, entry.name)
    const inspected = await inspectSecureFile(pathname, 'marker-record', { read: true })
    if (match[2] === 'started') {
      const record = parseExactRecord(
        inspected.bytes,
        ['generation_id', 'plan_root', 'schema_version', 'state_id', 'token_sha256'],
        START_SCHEMA,
        'marker-content',
      )
      validateStartRecord(record, match[1], layout.evidenceRoot)
      if (starts.has(record.state_id)) fail('marker-content')
      starts.set(
        record.state_id,
        Object.freeze({ identity: inspected.identity, pathname, record }),
      )
      continue
    }
    const record = parseExactRecord(
      inspected.bytes,
      [
        'final_verification_succeeded',
        'generation_id',
        'lock_identity',
        'resolution',
        'resolver_state_id',
        'schema_version',
        'start_identity',
        'state_id',
        'token_sha256',
      ],
      RESOLUTION_SCHEMA,
      'marker-content',
    )
    pendingResolutions.push(Object.freeze({ identity: inspected.identity, pathname, record }))
  }
  const resolutions = new Map()
  for (const resolution of pendingResolutions) {
    const state = starts.get(resolution.record.state_id)
    if (!state || resolutions.has(resolution.record.state_id)) fail('marker-content')
    validateResolutionRecord(resolution.record, state, starts)
    resolutions.set(resolution.record.state_id, resolution)
  }
  return Object.freeze({
    resolutions,
    starts,
    unresolved: [...starts.values()].filter(({ record }) => !resolutions.has(record.state_id)),
  })
}

function ownedStart(states, context) {
  const state = states.starts.get(context.stateId)
  if (
    !state ||
    state.record.generation_id !== context.generationId ||
    state.record.plan_root !== context.planRoot ||
    !equalDigest(state.record.token_sha256, tokenSHA256(context.ownerToken)) ||
    !sameFileIdentity(state.identity, context.startIdentity)
  ) {
    fail('marker-owner')
  }
  return state
}

function resolutionRecord(state, context, resolution) {
  return Object.freeze({
    final_verification_succeeded: resolution === 'completed',
    generation_id: state.record.generation_id,
    lock_identity: resolution === 'cancelled' ? null : context.lockIdentity,
    resolution,
    resolver_state_id: context.stateId,
    schema_version: RESOLUTION_SCHEMA,
    start_identity: state.identity,
    state_id: state.record.state_id,
    token_sha256: state.record.token_sha256,
  })
}

async function publishResolution(context, state, resolution) {
  const pathname = resolutionPath(context.tombstonePath, state.record.state_id)
  try {
    await createImmutableRecord(pathname, resolutionRecord(state, context, resolution), 'resolution')
  } catch (error) {
    if (!(error instanceof PackageGenerationLockError) || error.category !== 'resolution-exists') {
      throw error
    }
    const states = await scanGenerationStates(context)
    const existing = states.resolutions.get(state.record.state_id)
    if (!existing) throw error
  }
}

async function resolveStaleStates(context) {
  const states = await scanGenerationStates(context)
  ownedStart(states, context)
  for (const state of states.unresolved) {
    if (state.record.state_id === context.stateId) continue
    await publishResolution(context, state, 'superseded')
  }
}

/** 在尝试生命周期锁前持久化本代唯一、不可变的失效状态。 */
export async function ensureGenerationTombstone(options) {
  requireExactOptions(options, [
    'cwd',
    'generationId',
    'lockPath',
    'ownerToken',
    'planRoot',
    'tombstonePath',
  ])
  const layout = await prepareGenerationLayout(options)
  const ownerToken =
    options.ownerToken === undefined
      ? randomBytes(32).toString('hex')
      : requireToken(options.ownerToken)
  const record = startRecord(layout.generationId, ownerToken, layout.planRoot)
  const states = await scanGenerationStates(layout)
  const existing = states.starts.get(record.state_id)
  if (existing) {
    if (
      existing.record.generation_id !== record.generation_id ||
      existing.record.plan_root !== record.plan_root ||
      existing.record.token_sha256 !== record.token_sha256
    ) {
      fail('marker-owner')
    }
    return Object.freeze({
      ...layout,
      created: false,
      ownerToken,
      startIdentity: existing.identity,
      stateId: record.state_id,
    })
  }
  const created = await createImmutableRecord(
    startPath(layout.tombstonePath, record.state_id),
    record,
    'marker-record',
  )
  return Object.freeze({
    ...layout,
    created: true,
    ownerToken,
    startIdentity: created.identity,
    stateId: record.state_id,
  })
}

async function assertLockPathIdentity(context) {
  const lock = await inspectSecureFile(context.lockPath, 'lock', { read: true })
  if (!sameFileIdentity(lock.identity, context.lockIdentity)) fail('lock-identity')
  validateLockRecord(lock.bytes, context.controlIdentity)
}

function assertHeldLockDescriptor(context) {
  let metadata
  try {
    metadata = fstatSync(LOCK_DESCRIPTOR, { bigint: true })
    validateRegularFileMetadata(metadata, 'lock')
  } catch {
    fail('lock-descriptor')
  }
  if (!sameFileIdentity(fileIdentityFromMetadata(metadata), context.lockIdentity)) {
    fail('lock-descriptor')
  }
}

/** readiness 同时验证不可变状态全集和真实 macOS advisory lock。 */
export async function assertPackageGenerationReady(options) {
  requireExactOptions(options, ['lockPath', 'tombstonePath'])
  if (process.platform !== 'darwin') fail('unsupported-platform', { exitCode: EX_USAGE })
  const layout = await prepareReadinessLayout(options.lockPath, options.tombstonePath)
  const statesBefore = await scanGenerationStates(layout)
  if (statesBefore.unresolved.length > 0) fail('in-progress', { exitCode: EX_TEMPFAIL })
  const lock = await openLockFile(layout.lockPath, layout.controlIdentity)
  try {
    let result
    try {
      result = await runBoundedProcessWithFileDescriptors(
        LOCKF_PATH,
        ['-s', '-t', '0', '-k', '-w', `/dev/fd/${LOCK_DESCRIPTOR}`, '/usr/bin/true'],
        {
          acceptedExitCodes: [0, EX_TEMPFAIL],
          cwd: layout.evidenceRoot,
          env: defaultEnvironment(),
          maxOutputBytes: MAX_CONTROL_OUTPUT_BYTES,
          timeoutMs: READINESS_TIMEOUT_MS,
        },
        [Object.freeze({ childFd: LOCK_DESCRIPTOR, sourceFd: lock.handle.fd })],
      )
    } catch (error) {
      if (error instanceof BoundedProcessError) {
        fail('readiness-probe', {
          exitCode: Number.isInteger(error.exitCode) ? error.exitCode : EX_SOFTWARE,
          signal: error.signal,
        })
      }
      throw error
    }
    if (result.signal !== null || result.stdout !== '' || result.stderr !== '') {
      fail('readiness-probe')
    }
    if (result.code === EX_TEMPFAIL) fail('active', { exitCode: EX_TEMPFAIL })
    if (result.code !== 0) fail('readiness-probe', { exitCode: result.code })
    await assertLockPathIdentity({ ...layout, lockIdentity: lock.identity })
    const statesAfter = await scanGenerationStates(layout)
    if (statesAfter.unresolved.length > 0) fail('in-progress', { exitCode: EX_TEMPFAIL })
    return Object.freeze({ ready: true })
  } finally {
    await lock.handle.close().catch(() => undefined)
  }
}

function encodeContext(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function exactContext(value) {
  const expected = [
    'commandOutputBytes',
    'commandTimeoutMs',
    'controlIdentity',
    'cwd',
    'evidenceRoot',
    'generationId',
    'lockIdentity',
    'lockPath',
    'ownerToken',
    'planRoot',
    'schemaVersion',
    'startIdentity',
    'stateId',
    'tombstonePath',
  ].sort()
  return (
    isPlainObject(value) &&
    Object.keys(value).sort().length === expected.length &&
    Object.keys(value)
      .sort()
      .every((name, index) => name === expected[index])
  )
}

function parseContext(environment = process.env) {
  const encoded = environment[PACKAGE_GENERATION_CONTEXT_ENV]
  if (typeof encoded !== 'string' || encoded.length === 0 || encoded.length > MAX_STATE_BYTES * 2) {
    fail('context-missing', { exitCode: EX_USAGE })
  }
  let value
  try {
    value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  } catch {
    fail('context-invalid', { exitCode: EX_USAGE })
  }
  if (
    !exactContext(value) ||
    value.schemaVersion !== CONTEXT_SCHEMA ||
    !validDirectoryIdentity(value.controlIdentity) ||
    !validFileIdentity(value.lockIdentity) ||
    !validFileIdentity(value.startIdentity)
  ) {
    fail('context-invalid', { exitCode: EX_USAGE })
  }
  const generationId = requireGenerationID(value.generationId)
  const ownerToken = requireToken(value.ownerToken)
  const stateId = requireStateID(value.stateId)
  const lockPath = requireAbsolutePath(value.lockPath)
  const tombstonePath = requireAbsolutePath(value.tombstonePath)
  fixedStatePaths(lockPath, tombstonePath)
  const planRoot = requireAbsolutePath(value.planRoot, 'context-invalid')
  if (generationStateID(generationId, tokenSHA256(ownerToken), planRoot) !== stateId) {
    fail('context-invalid', { exitCode: EX_USAGE })
  }
  return Object.freeze({
    commandOutputBytes: requirePositiveInteger(
      value.commandOutputBytes,
      undefined,
      DEFAULT_COMMAND_OUTPUT_BYTES,
      'context-invalid',
    ),
    commandTimeoutMs: requirePositiveInteger(
      value.commandTimeoutMs,
      undefined,
      MAX_COMMAND_TIMEOUT_MS,
      'context-invalid',
    ),
    controlIdentity: value.controlIdentity,
    cwd: requireAbsolutePath(value.cwd, 'context-invalid'),
    evidenceRoot: requireAbsolutePath(value.evidenceRoot, 'context-invalid'),
    generationId,
    lockIdentity: value.lockIdentity,
    lockPath,
    ownerToken,
    planRoot,
    schemaVersion: value.schemaVersion,
    startIdentity: value.startIdentity,
    stateId,
    tombstonePath,
  })
}

function validateCommand(command) {
  if (
    !Array.isArray(command) ||
    command.length < 2 ||
    command.some((value) => typeof value !== 'string' || value.includes('\0')) ||
    !isAbsolute(command[0]) ||
    !isAbsolute(command[1]) ||
    !/^node(?:js)?(?:-[0-9.]+)?$/u.test(basename(command[0]))
  ) {
    fail('invalid-command', { exitCode: EX_USAGE })
  }
  return [...command]
}

function childEnvironment() {
  const environment = { ...process.env }
  delete environment[PACKAGE_GENERATION_CONTEXT_ENV]
  return environment
}

function emitHeldStatus(category, exitCode, signal) {
  const signalField = typeof signal === 'string' ? ` signal=${signal}` : ''
  process.stdout.write(
    `STATUS package-generation-lock category=${category} exit=${exitCode}${signalField}\n`,
  )
}

// 外层 wrapper 被 SIGKILL 后，控制管道写端会收到 EPIPE，并触发完整子树收敛。
function startOwnerPipeWatchdog() {
  let stopped = false
  let ownerLost = false
  const handleOwnerLoss = () => {
    if (stopped || ownerLost) return
    ownerLost = true
    clearInterval(heartbeat)
    process.kill(process.pid, 'SIGTERM')
  }
  const heartbeat = setInterval(() => {
    try {
      process.stdout.write(OWNER_PIPE_HEARTBEAT, (error) => {
        if (error) handleOwnerLoss()
      })
    } catch {
      handleOwnerLoss()
    }
  }, OWNER_PIPE_HEARTBEAT_INTERVAL_MS)
  heartbeat.unref?.()
  process.stdout.on('error', handleOwnerLoss)
  return () => {
    if (stopped) return
    stopped = true
    clearInterval(heartbeat)
    process.stdout.off('error', handleOwnerLoss)
  }
}

async function runHeldPhase(command, environment, context, deadline, label) {
  const remaining = deadline - Date.now()
  if (remaining <= 0) {
    return Object.freeze({ category: `${label}-timeout`, exitCode: EX_SOFTWARE })
  }
  try {
    await runBoundedProcess(command[0], command.slice(1), {
      cwd: context.cwd,
      env: environment,
      maxOutputBytes: context.commandOutputBytes,
      timeoutMs: remaining,
    })
    return undefined
  } catch (error) {
    if (!(error instanceof BoundedProcessError)) {
      return Object.freeze({ category: `${label}-internal`, exitCode: EX_SOFTWARE })
    }
    if (error.category === 'exit') {
      return Object.freeze({
        category: error.signal ? `${label}-signal` : `${label}-exit`,
        exitCode: Number.isInteger(error.exitCode) ? error.exitCode : EX_SOFTWARE,
        signal: error.signal,
      })
    }
    return Object.freeze({
      category: `${label}-${error.category}`,
      exitCode: EX_SOFTWARE,
      signal: error.signal,
    })
  }
}

async function heldGeneration(command, finalVerificationCommand) {
  const context = parseContext()
  assertHeldLockDescriptor(context)
  await assertLockPathIdentity(context)
  await resolveStaleStates(context)
  const environment = childEnvironment()
  const deadline = Date.now() + context.commandTimeoutMs
  const orchestratorFailure = await runHeldPhase(
    command,
    environment,
    context,
    deadline,
    'subcommand',
  )
  if (orchestratorFailure) {
    emitHeldStatus(
      orchestratorFailure.category,
      orchestratorFailure.exitCode,
      orchestratorFailure.signal,
    )
    return 0
  }
  const verifierFailure = await runHeldPhase(
    finalVerificationCommand,
    environment,
    context,
    deadline,
    'final-verifier',
  )
  if (verifierFailure) {
    emitHeldStatus(verifierFailure.category, verifierFailure.exitCode, verifierFailure.signal)
    return 0
  }
  try {
    await resolveStaleStates(context)
    const states = await scanGenerationStates(context)
    const state = ownedStart(states, context)
    if (states.resolutions.has(context.stateId)) fail('marker-owner')
    await publishResolution(context, state, 'completed')
  } catch (error) {
    if (error instanceof PackageGenerationLockError) {
      emitHeldStatus(error.category, error.exitCode, error.signal)
      return 0
    }
    throw error
  }
  emitHeldStatus('complete', 0)
  return 0
}

function parseInternalStatus(stdout, stderr, fallbackCode) {
  const statusOutput = stdout.replaceAll(OWNER_PIPE_HEARTBEAT, '')
  const match = INTERNAL_STATUS_PATTERN.exec(statusOutput) ?? INTERNAL_ERROR_PATTERN.exec(stderr)
  if (!match) return Object.freeze({ category: 'lock-command', exitCode: fallbackCode })
  const exitCode = Number(match[2])
  if (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255) {
    return Object.freeze({ category: 'lock-command', exitCode: fallbackCode })
  }
  return Object.freeze({ category: match[1], exitCode, signal: match[3] })
}

/** 使用固定 control/plan 合同运行唯一 macOS lockf 生命周期。 */
export async function runWithPackageGenerationLock(options) {
  requireExactOptions(options, [
    'command',
    'cwd',
    'environment',
    'finalVerificationCommand',
    'generationId',
    'lockPath',
    'maxOutputBytes',
    'planRoot',
    'timeoutMs',
    'tombstonePath',
  ])
  if (process.platform !== 'darwin') fail('unsupported-platform', { exitCode: EX_USAGE })
  const command = validateCommand(options.command)
  const finalVerificationCommand = validateCommand(options.finalVerificationCommand)
  const commandTimeoutMs = requirePositiveInteger(
    options.timeoutMs,
    DEFAULT_COMMAND_TIMEOUT_MS,
    MAX_COMMAND_TIMEOUT_MS,
    'invalid-timeout',
  )
  const commandOutputBytes = requirePositiveInteger(
    options.maxOutputBytes,
    DEFAULT_COMMAND_OUTPUT_BYTES,
    DEFAULT_COMMAND_OUTPUT_BYTES,
    'invalid-output-limit',
  )
  const prepared = await ensureGenerationTombstone({
    cwd: options.cwd,
    generationId: options.generationId,
    lockPath: options.lockPath,
    planRoot: options.planRoot,
    tombstonePath: options.tombstonePath,
  })
  const environment =
    options.environment === undefined ? defaultEnvironment() : validateEnvironment(options.environment)
  const lock = await openLockFile(prepared.lockPath, prepared.controlIdentity)
  const context = Object.freeze({
    commandOutputBytes,
    commandTimeoutMs,
    controlIdentity: prepared.controlIdentity,
    cwd: prepared.cwd,
    evidenceRoot: prepared.evidenceRoot,
    generationId: prepared.generationId,
    lockIdentity: lock.identity,
    lockPath: prepared.lockPath,
    ownerToken: prepared.ownerToken,
    planRoot: prepared.planRoot,
    schemaVersion: CONTEXT_SCHEMA,
    startIdentity: prepared.startIdentity,
    stateId: prepared.stateId,
    tombstonePath: prepared.tombstonePath,
  })
  environment[PACKAGE_GENERATION_CONTEXT_ENV] = encodeContext(context)
  const modulePath = fileURLToPath(import.meta.url)
  let result
  try {
    const retryDeadline = Date.now() + ACTIVE_RETRY_TIMEOUT_MS
    let shouldRetry
    do {
      result = await runBoundedProcessWithFileDescriptors(
        LOCKF_PATH,
        [
          '-s',
          '-t',
          '0',
          '-k',
          '-w',
          `/dev/fd/${LOCK_DESCRIPTOR}`,
          process.execPath,
          modulePath,
          'held',
          '--',
          ...command,
          FINAL_VERIFIER_SEPARATOR,
          ...finalVerificationCommand,
        ],
        {
          acceptedExitCodes: [0, EX_TEMPFAIL],
          cwd: prepared.cwd,
          env: environment,
          maxOutputBytes: MAX_CONTROL_OUTPUT_BYTES,
          timeoutMs: Math.min(commandTimeoutMs + OUTER_TIMEOUT_GRACE_MS, MAX_RUNNER_TIMEOUT_MS),
        },
        [Object.freeze({ childFd: LOCK_DESCRIPTOR, sourceFd: lock.handle.fd })],
      )
      shouldRetry =
        result.code === EX_TEMPFAIL &&
        result.signal === null &&
        result.stdout === '' &&
        result.stderr === '' &&
        Date.now() < retryDeadline
      if (shouldRetry) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, ACTIVE_RETRY_INTERVAL_MS))
      }
    } while (shouldRetry)
  } catch (error) {
    if (error instanceof BoundedProcessError) {
      fail(`lock-${error.category}`, {
        exitCode: Number.isInteger(error.exitCode) ? error.exitCode : EX_SOFTWARE,
        signal: error.signal,
      })
    }
    throw error
  } finally {
    await lock.handle.close().catch(() => undefined)
  }

  if (result.code === EX_TEMPFAIL && result.stdout === '' && result.stderr === '') {
    const states = await scanGenerationStates(prepared)
    const state = ownedStart(states, prepared)
    await publishResolution({ ...prepared, lockIdentity: null }, state, 'cancelled')
    fail('active', { exitCode: EX_TEMPFAIL })
  }
  if (result.code === 0 && result.signal === null) {
    const status = parseInternalStatus(result.stdout, result.stderr, EX_SOFTWARE)
    if (status.category !== 'complete' || status.exitCode !== 0) {
      fail(status.category, { exitCode: status.exitCode, signal: status.signal })
    }
    await assertPackageGenerationReady({
      lockPath: prepared.lockPath,
      tombstonePath: prepared.tombstonePath,
    })
    return Object.freeze({ exitCode: 0, generationId: prepared.generationId })
  }
  const status = parseInternalStatus(result.stdout, result.stderr, result.code)
  fail(status.category, { exitCode: status.exitCode, signal: status.signal })
}

function parseRunCLI(argv) {
  const separator = argv.indexOf('--')
  if (separator < 0 || separator === argv.length - 1) {
    fail('invalid-arguments', { exitCode: EX_USAGE })
  }
  const values = {}
  const environment = Object.create(null)
  for (let index = 0; index < separator; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (typeof value !== 'string') fail('invalid-arguments', { exitCode: EX_USAGE })
    if (name === '--env') {
      const equals = value.indexOf('=')
      if (equals < 1) fail('invalid-arguments', { exitCode: EX_USAGE })
      const environmentName = value.slice(0, equals)
      if (Object.hasOwn(environment, environmentName)) {
        fail('invalid-arguments', { exitCode: EX_USAGE })
      }
      environment[environmentName] = value.slice(equals + 1)
      continue
    }
    if (
      ![
        '--cwd',
        '--generation-id',
        '--lock-file',
        '--max-output-bytes',
        '--plan-root',
        '--timeout-ms',
        '--tombstone',
      ].includes(name) ||
      Object.hasOwn(values, name)
    ) {
      fail('invalid-arguments', { exitCode: EX_USAGE })
    }
    values[name] = value
  }
  if (
    ['--cwd', '--generation-id', '--lock-file', '--plan-root', '--tombstone'].some(
      (name) => !values[name],
    )
  ) {
    fail('invalid-arguments', { exitCode: EX_USAGE })
  }
  const commands = splitCommands(argv.slice(separator + 1))
  return Object.freeze({
    command: commands.command,
    cwd: values['--cwd'],
    environment: Object.keys(environment).length === 0 ? undefined : environment,
    finalVerificationCommand: commands.finalVerificationCommand,
    generationId: values['--generation-id'],
    lockPath: values['--lock-file'],
    maxOutputBytes:
      values['--max-output-bytes'] === undefined ? undefined : Number(values['--max-output-bytes']),
    planRoot: values['--plan-root'],
    timeoutMs: values['--timeout-ms'] === undefined ? undefined : Number(values['--timeout-ms']),
    tombstonePath: values['--tombstone'],
  })
}

function splitCommands(argv) {
  const separators = argv
    .map((value, index) => (value === FINAL_VERIFIER_SEPARATOR ? index : -1))
    .filter((index) => index >= 0)
  if (separators.length !== 1) fail('invalid-arguments', { exitCode: EX_USAGE })
  const separator = separators[0]
  if (separator < 2 || separator >= argv.length - 2) {
    fail('invalid-arguments', { exitCode: EX_USAGE })
  }
  return Object.freeze({
    command: validateCommand(argv.slice(0, separator)),
    finalVerificationCommand: validateCommand(argv.slice(separator + 1)),
  })
}

async function main(argv) {
  const action = argv[0]
  if (action === 'run') {
    await runWithPackageGenerationLock(parseRunCLI(argv.slice(1)))
    process.stdout.write('PASS: package-generation-lock category=complete\n')
    return 0
  }
  if (action === 'assert-ready') {
    if (argv.length !== 5 || argv[1] !== '--lock-file' || argv[3] !== '--tombstone') {
      fail('invalid-arguments', { exitCode: EX_USAGE })
    }
    await assertPackageGenerationReady({ lockPath: argv[2], tombstonePath: argv[4] })
    process.stdout.write('PASS: package-generation-lock category=ready\n')
    return 0
  }
  if (action === 'held') {
    if (argv[1] !== '--' || argv.length < 4) fail('invalid-arguments', { exitCode: EX_USAGE })
    const commands = splitCommands(argv.slice(2))
    const stopOwnerPipeWatchdog = startOwnerPipeWatchdog()
    try {
      return await heldGeneration(commands.command, commands.finalVerificationCommand)
    } finally {
      stopOwnerPipeWatchdog()
    }
  }
  fail('invalid-arguments', { exitCode: EX_USAGE })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2))
  } catch (error) {
    const normalized =
      error instanceof PackageGenerationLockError
        ? error
        : new PackageGenerationLockError('internal')
    const signalField = normalized.signal ? ` signal=${normalized.signal}` : ''
    process.stderr.write(
      `ERROR: package-generation-lock category=${normalized.category} exit=${normalized.exitCode}${signalField}\n`,
    )
    process.exitCode = normalized.exitCode
  }
}
