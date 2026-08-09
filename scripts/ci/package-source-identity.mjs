import { createHash, randomBytes } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import {
  chmod,
  link as linkFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  unlink,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { BoundedProcessError, runBoundedProcess } from './run-bounded-process.mjs'

const SOURCE_MANIFEST_SCHEMA = 'hexclaw.package-source-identity.v1'
const HASH_CHUNK_BYTES = 1024 * 1024
const COMMAND_TIMEOUT_MS = 60_000
const COMMAND_OUTPUT_LIMIT_BYTES = 512 * 1024
const GIT_OUTPUT_LIMIT_BYTES = 16 * 1024 * 1024
const MANIFEST_LIMIT_BYTES = 64 * 1024 * 1024
const TOOLCHAIN_FILE_LIMIT_BYTES = 256 * 1024 * 1024
const PRODUCTION_GIT_EXECUTABLE = '/usr/bin/git'

const DEFAULT_LIMITS = Object.freeze({
  maxFiles: 10_000,
  maxFileBytes: 128 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
})

const NATIVE_MAC_TARGETS = Object.freeze({
  'aarch64-apple-darwin': Object.freeze({
    goArchitecture: 'arm64',
    nodeArchitecture: 'arm64',
  }),
  'x86_64-apple-darwin': Object.freeze({
    goArchitecture: 'amd64',
    nodeArchitecture: 'x64',
  }),
})

const REPOSITORY_CONTRACT = Object.freeze([
  Object.freeze({ id: 'toolkit', module: 'github.com/hexagon-codes/toolkit' }),
  Object.freeze({ id: 'ai-core', module: 'github.com/hexagon-codes/ai-core' }),
  Object.freeze({ id: 'hexagon', module: 'github.com/hexagon-codes/hexagon' }),
  Object.freeze({ id: 'hexclaw', module: 'github.com/hexagon-codes/hexclaw' }),
  Object.freeze({ id: 'hexclaw-desktop', module: null }),
])

const SOURCE_OVERRIDE_NAMES = Object.freeze([
  'AI_CORE_ROOT',
  'AI_CORE_SRC_DIR',
  'DESKTOP_ROOT',
  'GOWORK',
  'HEXAGON_ROOT',
  'HEXAGON_SRC_DIR',
  'HEXCLAW_BUILD_SRC',
  'HEXCLAW_DEFAULT_GOWORK',
  'HEXCLAW_DEFAULT_LOCAL_SRC',
  'HEXCLAW_DESKTOP_ROOT',
  'HEXCLAW_GOWORK',
  'HEXCLAW_LOCAL_SRC',
  'HEXCLAW_REPO_URL',
  'HEXCLAW_ROOT',
  'HEXCLAW_SRC_DIR',
  'HEXCLAW_WORK_ROOT',
  'TOOLKIT_ROOT',
  'TOOLKIT_SRC_DIR',
])

const EXCLUDED_ROOT_OUTPUT_NAMES = new Set([
  '.cache',
  '.pnpm-store',
  '.turbo',
  '.vite',
  'blob-report',
  'coverage',
  'dist',
  'dist-ssr',
  'node_modules',
  'playwright-report',
  'target',
  'test-results',
])

const GIT_EXCLUDED_PATHS = Object.freeze([
  ':(exclude,glob)**/node_modules/**',
  ...[...EXCLUDED_ROOT_OUTPUT_NAMES]
    .filter((name) => name !== 'node_modules')
    .map((name) => `:(exclude,glob)${name}/**`),
  ':(exclude,glob)playwright-report-*/**',
  ':(exclude,glob).package-local.*/**',
  ':(exclude,glob)src-tauri/binaries/**',
  ':(exclude,glob)src-tauri/target/**',
])

const GIT_SENSITIVE_PATHS = Object.freeze([
  ':(glob)**/.env*',
  ':(glob)**/.netrc',
  ':(glob)**/.npmrc',
  ':(glob)**/.pypirc',
])

class SourceIdentityError extends Error {
  constructor(code) {
    super(`FAIL: package source identity [${code}].`)
    this.name = 'SourceIdentityError'
    this.code = code
  }
}

function fail(code) {
  throw new SourceIdentityError(code)
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function assertExactOptions(options, allowed) {
  if (!isPlainObject(options)) fail('input:options')
  const allowedNames = new Set(allowed)
  if (Object.keys(options).some((name) => !allowedNames.has(name))) fail('input:unknown-option')
}

function validateTarget(target) {
  if (typeof target !== 'string' || !Object.hasOwn(NATIVE_MAC_TARGETS, target)) fail('input:target')
  return target
}

function validateToolchainTarget(toolchains, target) {
  if (!isPlainObject(toolchains)) fail('toolchain:manifest')
  const contract = NATIVE_MAC_TARGETS[target]
  if (
    toolchains.target !== target ||
    !isPlainObject(toolchains.go) ||
    !isPlainObject(toolchains.go.env) ||
    toolchains.go.env.GOOS !== 'darwin' ||
    toolchains.go.env.GOARCH !== contract.goArchitecture ||
    !isPlainObject(toolchains.rustc) ||
    toolchains.rustc.host !== target ||
    !isPlainObject(toolchains.node) ||
    toolchains.node.platform !== 'darwin' ||
    toolchains.node.architecture !== contract.nodeArchitecture
  ) {
    fail('toolchain:target')
  }
}

function validateSha256(value, category = 'input:sha256') {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) fail(category)
  return value
}

function validateManifestPath(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) {
    fail('input:manifest-path')
  }
  return resolve(path)
}

function validateLimits(overrides, allowOverrides) {
  if (overrides === undefined) return DEFAULT_LIMITS
  if (!allowOverrides || !isPlainObject(overrides)) fail('input:limits')
  const names = Object.keys(overrides)
  if (names.some((name) => !['maxFiles', 'maxFileBytes', 'maxTotalBytes'].includes(name))) {
    fail('input:limits')
  }
  const limits = {
    maxFiles: overrides.maxFiles ?? DEFAULT_LIMITS.maxFiles,
    maxFileBytes: overrides.maxFileBytes ?? DEFAULT_LIMITS.maxFileBytes,
    maxTotalBytes: overrides.maxTotalBytes ?? DEFAULT_LIMITS.maxTotalBytes,
  }
  if (
    !Number.isSafeInteger(limits.maxFiles) ||
    limits.maxFiles <= 0 ||
    !Number.isSafeInteger(limits.maxFileBytes) ||
    limits.maxFileBytes <= 0 ||
    !Number.isSafeInteger(limits.maxTotalBytes) ||
    limits.maxTotalBytes <= 0 ||
    limits.maxFileBytes > limits.maxTotalBytes
  ) {
    fail('input:limits')
  }
  return Object.freeze(limits)
}

function validateRecordedLimits(value, allowOverrides) {
  const limits = validateLimits(value, true)
  if (
    !allowOverrides &&
    (limits.maxFiles !== DEFAULT_LIMITS.maxFiles ||
      limits.maxFileBytes !== DEFAULT_LIMITS.maxFileBytes ||
      limits.maxTotalBytes !== DEFAULT_LIMITS.maxTotalBytes)
  ) {
    fail('manifest:limits')
  }
  return limits
}

function compareUTF8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

function canonicalValue(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) fail('manifest:canonical-value')
    return value
  }
  if (Array.isArray(value)) return value.map((item) => canonicalValue(item))
  if (!isPlainObject(value)) fail('manifest:canonical-value')
  return Object.fromEntries(
    Object.keys(value)
      .sort(compareUTF8)
      .map((key) => [key, canonicalValue(value[key])]),
  )
}

function canonicalManifestBytes(manifest) {
  return Buffer.from(`${JSON.stringify(canonicalValue(manifest))}\n`, 'utf8')
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function isPathInside(root, candidate) {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function normalizedRepositoryPath(path) {
  if (typeof path !== 'string' || path === '' || Buffer.byteLength(path, 'utf8') > 4096) {
    fail('path:invalid')
  }
  if (path.includes('\0') || path.startsWith('/') || path.includes('\\')) fail('path:invalid')
  const components = path.split('/')
  if (components.some((component) => component === '' || component === '.' || component === '..')) {
    fail('path:invalid')
  }
  return path
}

function isSensitiveEnvironmentPath(path) {
  const name = path.slice(path.lastIndexOf('/') + 1)
  if (name === '.env.example') return false
  return name.startsWith('.env') || ['.netrc', '.npmrc', '.pypirc'].includes(name)
}

function isExcludedOutputPath(path) {
  const components = path.split('/')
  const directories = components.slice(0, -1)
  if (directories.some((component) => component === '.git' || component === 'node_modules')) {
    return true
  }
  const rootDirectory = directories[0]
  if (EXCLUDED_ROOT_OUTPUT_NAMES.has(rootDirectory)) return true
  if (
    rootDirectory?.startsWith('playwright-report-') ||
    rootDirectory?.startsWith('.package-local.')
  ) {
    return true
  }
  return rootDirectory === 'src-tauri' && ['binaries', 'target'].includes(directories[1])
}

function statIdentity(stat) {
  return Object.freeze({
    dev: stat.dev,
    gid: stat.gid,
    ino: stat.ino,
    mode: stat.mode,
    nlink: stat.nlink,
    size: stat.size,
    uid: stat.uid,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  })
}

function sameFileIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.gid === right.gid &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.uid === right.uid
  )
}

function noFollowFlag() {
  if (!Number.isInteger(fsConstants.O_NOFOLLOW) || fsConstants.O_NOFOLLOW === 0) {
    fail('platform:no-follow')
  }
  return fsConstants.O_NOFOLLOW
}

async function safeLstat(path, allowMissing = false) {
  try {
    return await lstat(path, { bigint: true })
  } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') return null
    fail('file:metadata')
  }
}

function currentUserID() {
  if (process.platform !== 'darwin' || typeof process.getuid !== 'function') {
    fail('platform:unsupported')
  }
  return BigInt(process.getuid())
}

function assertProductionPlatform(platform = process.platform, getuid = process.getuid) {
  if (platform !== 'darwin' || typeof getuid !== 'function') fail('platform:unsupported')
}

function assertSecureOwnershipAndMode(stat, options = {}) {
  const expectedUID = options.expectedUID ?? currentUserID()
  if (stat.uid !== expectedUID && !(options.allowRootOwner === true && stat.uid === 0n)) {
    fail('file:owner')
  }
  if ((stat.mode & 0o022n) !== 0n) fail('file:permissions')
}

function assertRegularSourceStat(stat, options = {}) {
  if (stat.isSymbolicLink()) fail('file:symbolic-link')
  if (!stat.isFile()) fail('file:non-regular')
  if (options.allowHardLinks !== true && stat.nlink !== 1n) fail('file:hard-link')
  if (stat.size < 0n || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) fail('limit:file-size')
  assertSecureOwnershipAndMode(stat, options)
}

async function assertSecureAncestorChain(containmentRoot, path, options = {}) {
  const root = resolve(containmentRoot)
  const candidate = resolve(path)
  if (!isPathInside(root, candidate)) fail('path:escape')
  const relativePath = relative(root, candidate)
  const parentComponents = relativePath === '' ? [] : relativePath.split('/').slice(0, -1)
  const directories = [root]
  for (let index = 0; index < parentComponents.length; index += 1) {
    directories.push(join(root, ...parentComponents.slice(0, index + 1)))
  }
  for (const directory of directories) {
    const stat = await safeLstat(directory)
    if (stat.isSymbolicLink()) fail('file:symbolic-link')
    if (!stat.isDirectory()) fail('file:non-regular')
    assertSecureOwnershipAndMode(stat, options)
    let canonicalDirectory
    try {
      canonicalDirectory = await realpath(directory)
    } catch {
      fail('file:metadata')
    }
    if (canonicalDirectory !== directory || !isPathInside(root, canonicalDirectory)) {
      fail('file:symbolic-link')
    }
  }
}

function createBudget(limits) {
  let entries = 0
  let files = 0
  let bytes = 0
  let deletedTracked = 0
  return Object.freeze({
    reserve(size) {
      if (!Number.isSafeInteger(size) || size < 0) fail('limit:file-size')
      if (size > limits.maxFileBytes) fail('limit:file-size')
      if (entries + 1 > limits.maxFiles) fail('limit:file-count')
      if (bytes + size > limits.maxTotalBytes) fail('limit:total-bytes')
      entries += 1
      files += 1
      bytes += size
    },
    reserveDeleted() {
      if (entries + 1 > limits.maxFiles) fail('limit:file-count')
      entries += 1
      deletedTracked += 1
    },
    snapshot() {
      return Object.freeze({ bytes, deletedTracked, entries, files })
    },
  })
}

async function assertCanonicalFilePath(path) {
  let canonicalPath
  try {
    canonicalPath = await realpath(path)
  } catch {
    fail('file:metadata')
  }
  if (canonicalPath !== resolve(path)) fail('file:symbolic-link')
}

async function hashRegularFile(path, options) {
  if (options.containmentRoot) {
    await assertSecureAncestorChain(options.containmentRoot, path, options)
  }
  const preLstat = await safeLstat(path, options.allowMissing === true)
  if (preLstat === null) return null
  if (preLstat.isSymbolicLink()) fail('file:symbolic-link')
  await assertCanonicalFilePath(path)
  assertRegularSourceStat(preLstat, options)
  const size = Number(preLstat.size)
  options.budget.reserve(size)

  let handle
  try {
    handle = await open(path, fsConstants.O_RDONLY | noFollowFlag())
  } catch {
    fail('drift:file-open')
  }

  const digest = createHash('sha256')
  let position = 0
  try {
    const before = await handle.stat({ bigint: true })
    assertRegularSourceStat(before, options)
    if (!sameFileIdentity(statIdentity(preLstat), statIdentity(before))) {
      fail('drift:file-identity')
    }

    const buffer = Buffer.allocUnsafe(Math.min(HASH_CHUNK_BYTES, Math.max(size, 1)))
    while (position < size) {
      const requested = Math.min(buffer.length, size - position)
      const { bytesRead } = await handle.read(buffer, 0, requested, position)
      if (bytesRead <= 0) fail('drift:file-size')
      const chunk = buffer.subarray(0, bytesRead)
      digest.update(chunk)
      position += bytesRead
    }

    const after = await handle.stat({ bigint: true })
    if (!sameFileIdentity(statIdentity(before), statIdentity(after))) {
      fail('drift:file-identity')
    }
  } catch (error) {
    if (error instanceof SourceIdentityError) throw error
    fail('file:read')
  } finally {
    try {
      await handle.close()
    } catch {
      fail('file:close')
    }
  }

  const postLstat = await safeLstat(path)
  await assertCanonicalFilePath(path)
  if (!sameFileIdentity(statIdentity(preLstat), statIdentity(postLstat))) {
    fail('drift:file-identity')
  }
  if (position !== size) fail('drift:file-size')
  return Object.freeze({
    identity: statIdentity(postLstat),
    mode: `100${Number(postLstat.mode & 0o777n)
      .toString(8)
      .padStart(3, '0')}`,
    sha256: digest.digest('hex'),
    size,
  })
}

async function readSmallSecureFile(path, maxBytes, category, containmentRoot = null) {
  const budget = createBudget({ maxFiles: 1, maxFileBytes: maxBytes, maxTotalBytes: maxBytes })
  if (containmentRoot) await assertSecureAncestorChain(containmentRoot, path)
  const preLstat = await safeLstat(path)
  if (preLstat.isSymbolicLink()) fail('file:symbolic-link')
  if (containmentRoot) await assertCanonicalFilePath(path)
  assertRegularSourceStat(preLstat)
  const size = Number(preLstat.size)
  budget.reserve(size)
  let handle
  try {
    handle = await open(path, fsConstants.O_RDONLY | noFollowFlag())
  } catch {
    fail(category)
  }
  try {
    const before = await handle.stat({ bigint: true })
    if (!sameFileIdentity(statIdentity(preLstat), statIdentity(before))) fail('drift:file-identity')
    const bytes = Buffer.alloc(size)
    let position = 0
    while (position < size) {
      const { bytesRead } = await handle.read(bytes, position, size - position, position)
      if (bytesRead <= 0) fail('drift:file-size')
      position += bytesRead
    }
    const after = await handle.stat({ bigint: true })
    if (!sameFileIdentity(statIdentity(before), statIdentity(after))) fail('drift:file-identity')
    if (containmentRoot) await assertCanonicalFilePath(path)
    return bytes
  } catch (error) {
    if (error instanceof SourceIdentityError) throw error
    fail(category)
  } finally {
    try {
      await handle.close()
    } catch {
      fail('file:close')
    }
  }
}

function commandEnvironment(snapshotRoot, overrides = {}) {
  const environment = Object.assign(Object.create(null), {
    LANG: 'C',
    LC_ALL: 'C',
    PATH: `${snapshotRoot}:/usr/bin:/bin`,
    TMPDIR: join(snapshotRoot, 'tmp'),
  })
  for (const [name, value] of Object.entries(overrides)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) || typeof value !== 'string') {
      fail('toolchain:environment')
    }
    environment[name] = value
  }
  return environment
}

function gitCommandEnvironment(snapshotRoot) {
  return commandEnvironment(snapshotRoot, {
    GIT_CONFIG_COUNT: '0',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_OPTIONAL_LOCKS: '0',
  })
}

async function requireCommand(executable, args, category, options = {}) {
  let result
  try {
    result = await runBoundedProcess(executable, args, {
      cwd: options.cwd ?? dirname(executable),
      env: options.env ?? Object.create(null),
      maxOutputBytes: options.maxOutputBytes ?? COMMAND_OUTPUT_LIMIT_BYTES,
      terminateConfirmMs: 2_000,
      terminateGraceMs: 2_000,
      timeoutMs: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
    })
  } catch (error) {
    if (error instanceof BoundedProcessError) fail(`command:${error.category}`)
    fail(category)
  }
  return Buffer.from(result.stdout, 'utf8')
}

async function resolveExecutable(name, pathValue) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9._-]+$/u.test(name)) {
    fail('toolchain:executable')
  }
  if (typeof pathValue !== 'string' || pathValue === '') fail(`toolchain:${name}`)
  for (const directory of pathValue.split(delimiter)) {
    if (!isAbsolute(directory)) continue
    const selectionPath = resolve(directory, name)
    let selectionStat
    try {
      selectionStat = await lstat(selectionPath, { bigint: true })
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      fail(`toolchain:${name}`)
    }
    try {
      const sourcePath = await realpath(selectionPath)
      const stat = await lstat(sourcePath, { bigint: true })
      assertRegularSourceStat(stat, { allowRootOwner: true })
      if (selectionStat.uid !== currentUserID() && selectionStat.uid !== 0n) {
        fail(`toolchain:${name}`)
      }
      if ((stat.mode & 0o111n) !== 0n && stat.size <= BigInt(TOOLCHAIN_FILE_LIMIT_BYTES)) {
        return Object.freeze({ selectionPath, sourcePath })
      }
    } catch (error) {
      if (error instanceof SourceIdentityError) throw error
      fail(`toolchain:${name}`)
    }
    fail(`toolchain:${name}`)
  }
  fail(`toolchain:${name}`)
}

async function resolveFixedExecutable(name, path) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9._-]+$/u.test(name)) {
    fail('toolchain:executable')
  }
  if (typeof path !== 'string' || !isAbsolute(path)) fail(`toolchain:${name}`)
  try {
    const sourcePath = await realpath(path)
    const stat = await lstat(sourcePath, { bigint: true })
    assertRegularSourceStat(stat, { allowRootOwner: true })
    if ((stat.mode & 0o111n) !== 0n && stat.size <= BigInt(TOOLCHAIN_FILE_LIMIT_BYTES)) {
      return Object.freeze({ selectionPath: resolve(path), sourcePath })
    }
  } catch (error) {
    if (error instanceof SourceIdentityError) throw error
    // 固定工具不可用时必须失败，不回退到调用方 PATH。
  }
  fail(`toolchain:${name}`)
}

async function resolveFixedGitExecutable(path = PRODUCTION_GIT_EXECUTABLE) {
  return resolveFixedExecutable('git', path)
}

function productionToolchainOptions() {
  const hostHome = homedir()
  return Object.freeze({
    gitPath: PRODUCTION_GIT_EXECUTABLE,
    nodePath: process.execPath,
    path: [
      dirname(process.execPath),
      '/usr/local/go/bin',
      '/usr/local/bin',
      '/opt/homebrew/bin',
      join(hostHome, '.cargo', 'bin'),
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
    ].join(delimiter),
    rustupHome: join(hostHome, '.rustup'),
  })
}

async function capturePathWitness(selection) {
  let selectionStat
  let selectionParentStat
  let sourceParentStat
  try {
    selectionStat = await lstat(selection.selectionPath, { bigint: true })
    selectionParentStat = await lstat(dirname(selection.selectionPath), { bigint: true })
    sourceParentStat = await lstat(dirname(selection.sourcePath), { bigint: true })
  } catch {
    fail('toolchain:source')
  }
  for (const stat of [selectionParentStat, sourceParentStat]) {
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail('toolchain:source')
    assertSecureOwnershipAndMode(stat, { allowRootOwner: true })
  }
  if (selectionStat.uid !== currentUserID() && selectionStat.uid !== 0n) {
    fail('toolchain:source')
  }
  return Object.freeze({
    selectionIdentity: statIdentity(selectionStat),
    selectionParentIdentity: statIdentity(selectionParentStat),
    sourceParentIdentity: statIdentity(sourceParentStat),
  })
}

async function createToolchainSnapshotRoot(parent) {
  let canonicalParent
  try {
    await mkdir(parent, { mode: 0o700, recursive: true })
    canonicalParent = await realpath(parent)
  } catch {
    fail('toolchain:snapshot-root')
  }
  let snapshotRoot
  try {
    snapshotRoot = await mkdtemp(join(canonicalParent, '.package-source-toolchains-'))
    await chmod(snapshotRoot, 0o700)
    await mkdir(join(snapshotRoot, 'tmp'), { mode: 0o700 })
  } catch {
    fail('toolchain:snapshot-root')
  }
  const stat = await safeLstat(snapshotRoot)
  if (
    !stat.isDirectory() ||
    stat.uid !== currentUserID() ||
    (stat.mode & 0o777n) !== 0o700n
  ) {
    fail('toolchain:snapshot-root')
  }
  return snapshotRoot
}

async function copyExecutableToSnapshot(selection, snapshotRoot, name) {
  const witness = await capturePathWitness(selection)
  const sourcePathStat = await safeLstat(selection.sourcePath)
  assertRegularSourceStat(sourcePathStat, { allowRootOwner: true })
  if (
    (sourcePathStat.mode & 0o111n) === 0n ||
    sourcePathStat.size > BigInt(TOOLCHAIN_FILE_LIMIT_BYTES)
  ) {
    fail('toolchain:source')
  }
  let sourceHandle
  let snapshotHandle
  const snapshotPath = join(snapshotRoot, name)
  const digest = createHash('sha256')
  try {
    sourceHandle = await open(selection.sourcePath, fsConstants.O_RDONLY | noFollowFlag())
    const sourceBefore = await sourceHandle.stat({ bigint: true })
    if (!sameFileIdentity(statIdentity(sourcePathStat), statIdentity(sourceBefore))) {
      fail('toolchain:source-drift')
    }
    snapshotHandle = await open(
      snapshotPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollowFlag(),
      0o500,
    )
    const size = Number(sourceBefore.size)
    const buffer = Buffer.allocUnsafe(Math.min(HASH_CHUNK_BYTES, Math.max(size, 1)))
    let position = 0
    while (position < size) {
      const requested = Math.min(buffer.length, size - position)
      const { bytesRead } = await sourceHandle.read(buffer, 0, requested, position)
      if (bytesRead <= 0) fail('toolchain:source-drift')
      digest.update(buffer.subarray(0, bytesRead))
      let written = 0
      while (written < bytesRead) {
        const result = await snapshotHandle.write(
          buffer,
          written,
          bytesRead - written,
          position + written,
        )
        if (result.bytesWritten <= 0) fail('toolchain:snapshot-write')
        written += result.bytesWritten
      }
      position += bytesRead
    }
    await snapshotHandle.chmod(0o500)
    await snapshotHandle.sync()
    const snapshotStat = await snapshotHandle.stat({ bigint: true })
    if (
      !snapshotStat.isFile() ||
      snapshotStat.nlink !== 1n ||
      snapshotStat.uid !== currentUserID() ||
      (snapshotStat.mode & 0o777n) !== 0o500n ||
      snapshotStat.size !== sourceBefore.size
    ) {
      fail('toolchain:snapshot-write')
    }
    const sourceAfter = await sourceHandle.stat({ bigint: true })
    if (!sameFileIdentity(statIdentity(sourceBefore), statIdentity(sourceAfter))) {
      fail('toolchain:source-drift')
    }
    await snapshotHandle.close()
    snapshotHandle = null
    return Object.freeze({
      executableSha256: digest.digest('hex'),
      name,
      selection,
      snapshotIdentity: statIdentity(snapshotStat),
      snapshotPath,
      sourceHandle,
      sourceIdentity: statIdentity(sourceBefore),
      witness,
    })
  } catch (error) {
    await sourceHandle?.close().catch(() => undefined)
    await snapshotHandle?.close().catch(() => undefined)
    if (error instanceof SourceIdentityError) throw error
    fail('toolchain:snapshot-write')
  }
}

async function verifyToolBinding(binding) {
  let sourceHandleStat
  let sourcePathStat
  let sourceParentStat
  let selectionStat
  let selectionParentStat
  let snapshotStat
  let resolvedSelection
  try {
    ;[
      sourceHandleStat,
      sourcePathStat,
      sourceParentStat,
      selectionStat,
      selectionParentStat,
      snapshotStat,
      resolvedSelection,
    ] = await Promise.all([
      binding.sourceHandle.stat({ bigint: true }),
      lstat(binding.selection.sourcePath, { bigint: true }),
      lstat(dirname(binding.selection.sourcePath), { bigint: true }),
      lstat(binding.selection.selectionPath, { bigint: true }),
      lstat(dirname(binding.selection.selectionPath), { bigint: true }),
      lstat(binding.snapshotPath, { bigint: true }),
      realpath(binding.selection.selectionPath),
    ])
  } catch {
    fail('toolchain:source-drift')
  }
  if (
    resolvedSelection !== binding.selection.sourcePath ||
    !sameFileIdentity(binding.sourceIdentity, statIdentity(sourceHandleStat)) ||
    !sameFileIdentity(binding.sourceIdentity, statIdentity(sourcePathStat)) ||
    !sameFileIdentity(binding.witness.sourceParentIdentity, statIdentity(sourceParentStat)) ||
    !sameFileIdentity(binding.witness.selectionIdentity, statIdentity(selectionStat)) ||
    !sameFileIdentity(
      binding.witness.selectionParentIdentity,
      statIdentity(selectionParentStat),
    )
  ) {
    fail('toolchain:source-drift')
  }
  if (!sameFileIdentity(binding.snapshotIdentity, statIdentity(snapshotStat))) {
    fail('toolchain:snapshot-drift')
  }
}

async function runTrustedTool(binding, args, environment, options = {}) {
  await verifyToolBinding(binding)
  const output = await requireCommand(
    binding.snapshotPath,
    args,
    options.category ?? 'toolchain:command',
    {
      cwd: options.cwd ?? dirname(binding.snapshotPath),
      env: environment,
      maxOutputBytes: options.maxOutputBytes,
      timeoutMs: options.timeoutMs,
    },
  )
  await verifyToolBinding(binding)
  return output
}

async function hashOpenFile(handle, size) {
  const digest = createHash('sha256')
  const buffer = Buffer.allocUnsafe(Math.min(HASH_CHUNK_BYTES, Math.max(size, 1)))
  let position = 0
  while (position < size) {
    const requested = Math.min(buffer.length, size - position)
    const { bytesRead } = await handle.read(buffer, 0, requested, position)
    if (bytesRead <= 0) fail('toolchain:source-drift')
    digest.update(buffer.subarray(0, bytesRead))
    position += bytesRead
  }
  return digest.digest('hex')
}

async function finalizeToolBinding(binding) {
  await verifyToolBinding(binding)
  const sourceDigest = await hashOpenFile(binding.sourceHandle, Number(binding.sourceIdentity.size))
  let snapshotHandle
  let snapshotDigest
  try {
    snapshotHandle = await open(binding.snapshotPath, fsConstants.O_RDONLY | noFollowFlag())
    snapshotDigest = await hashOpenFile(snapshotHandle, Number(binding.snapshotIdentity.size))
  } catch (error) {
    if (error instanceof SourceIdentityError) throw error
    fail('toolchain:snapshot-drift')
  } finally {
    await snapshotHandle?.close().catch(() => undefined)
  }
  if (sourceDigest !== binding.executableSha256) fail('toolchain:source-drift')
  if (snapshotDigest !== binding.executableSha256) fail('toolchain:snapshot-drift')
}

function orchestratorBinding(binding, extra = {}) {
  return Object.freeze({
    canonical: binding.snapshotPath,
    executableSha256: binding.executableSha256,
    invocation: binding.snapshotPath,
    sourceCanonical: binding.selection.sourcePath,
    ...extra,
  })
}

async function collectProductionToolchains(target, snapshotParent, suppliedOptions) {
  assertProductionPlatform()
  const options = suppliedOptions ?? productionToolchainOptions()
  const snapshotRoot = await createToolchainSnapshotRoot(snapshotParent)
  const bindings = []
  const bind = async (selection, name) => {
    const binding = await copyExecutableToSnapshot(selection, snapshotRoot, name)
    bindings.push(binding)
    return binding
  }
  try {
    const [gitSelection, goSelection, pnpmSelection, nodeSelection, rustcSelection, cargoSelection] =
      await Promise.all([
        resolveFixedGitExecutable(options.gitPath),
        resolveExecutable('go', options.path),
        resolveExecutable('pnpm', options.path),
        resolveFixedExecutable('node', options.nodePath),
        resolveExecutable('rustc', options.path),
        resolveExecutable('cargo', options.path),
      ])
    const [git, go, pnpm, node] = await Promise.all([
      bind(gitSelection, 'git'),
      bind(goSelection, 'go'),
      bind(pnpmSelection, 'pnpm'),
      bind(nodeSelection, 'node'),
    ])
    let rustup
    let rustcResolved = rustcSelection
    let cargoResolved = cargoSelection
    const rustupSelection = await resolveExecutable('rustup', options.path).catch(() => null)
    if (
      rustupSelection &&
      (rustcSelection.sourcePath === rustupSelection.sourcePath ||
        cargoSelection.sourcePath === rustupSelection.sourcePath)
    ) {
      rustup = await bind(rustupSelection, 'rustup')
      let rustupHome
      try {
        rustupHome = await realpath(options.rustupHome)
        const rustupHomeStat = await lstat(rustupHome, { bigint: true })
        if (!rustupHomeStat.isDirectory()) fail('toolchain:rustup-home')
        assertSecureOwnershipAndMode(rustupHomeStat)
      } catch (error) {
        if (error instanceof SourceIdentityError) throw error
        fail('toolchain:rustup-home')
      }
      const rustupEnv = commandEnvironment(snapshotRoot, { RUSTUP_HOME: rustupHome })
      if (rustcSelection.sourcePath === rustupSelection.sourcePath) {
        const reported = (
          await runTrustedTool(rustup, ['which', 'rustc'], rustupEnv, { cwd: snapshotRoot })
        )
          .toString('utf8')
          .trim()
        if (!isAbsolute(reported)) fail('toolchain:rustc')
        const sourcePath = await realpath(reported).catch(() => fail('toolchain:rustc'))
        rustcResolved = Object.freeze({ selectionPath: resolve(reported), sourcePath })
      }
      if (cargoSelection.sourcePath === rustupSelection.sourcePath) {
        const reported = (
          await runTrustedTool(rustup, ['which', 'cargo'], rustupEnv, { cwd: snapshotRoot })
        )
          .toString('utf8')
          .trim()
        if (!isAbsolute(reported)) fail('toolchain:cargo')
        const sourcePath = await realpath(reported).catch(() => fail('toolchain:cargo'))
        cargoResolved = Object.freeze({ selectionPath: resolve(reported), sourcePath })
      }
    }
    const [rustc, cargo] = await Promise.all([
      bind(rustcResolved, 'rustc'),
      bind(cargoResolved, 'cargo'),
    ])
    const baseEnv = commandEnvironment(snapshotRoot)
    const goEnv = commandEnvironment(snapshotRoot, {
      GOENV: 'off',
      GONOSUMDB: '*',
      GOPROXY: 'off',
      GOTOOLCHAIN: 'local',
      GOWORK: 'off',
    })
    // 工具探测串行执行，使每个进程组的边界和来源复核都保持确定性。
    const gitVersion = await runTrustedTool(
      git,
      ['--version'],
      gitCommandEnvironment(snapshotRoot),
      { cwd: snapshotRoot },
    )
    const goVersion = await runTrustedTool(go, ['version'], goEnv, { cwd: snapshotRoot })
    const goCompileVersion = await runTrustedTool(go, ['tool', 'compile', '-V=full'], goEnv, {
      cwd: snapshotRoot,
    })
    const goEnvironment = await runTrustedTool(
      go,
      [
        'env',
        '-json',
        'CGO_ENABLED',
        'GOARCH',
        'GOEXPERIMENT',
        'GOOS',
        'GOROOT',
        'GOTOOLCHAIN',
        'GOVERSION',
      ],
      goEnv,
      { cwd: snapshotRoot },
    )
    const rustcVersion = await runTrustedTool(rustc, ['-vV'], baseEnv, {
      cwd: snapshotRoot,
    })
    const cargoVersion = await runTrustedTool(cargo, ['-Vv'], baseEnv, {
      cwd: snapshotRoot,
    })
    const pnpmVersion = await runTrustedTool(pnpm, ['--version'], baseEnv, {
      cwd: snapshotRoot,
    })
    const nodeVersion = await runTrustedTool(node, ['--version'], baseEnv, {
      cwd: snapshotRoot,
    })
    await Promise.all(bindings.map(finalizeToolBinding))
    let parsedGoEnvironment
    try {
      parsedGoEnvironment = JSON.parse(goEnvironment.toString('utf8'))
    } catch {
      fail('toolchain:go-env')
    }
    let canonicalGoRoot
    try {
      canonicalGoRoot = await realpath(parsedGoEnvironment.GOROOT)
      const goRootStat = await lstat(canonicalGoRoot, { bigint: true })
      if (!goRootStat.isDirectory()) fail('toolchain:go-env')
      assertSecureOwnershipAndMode(goRootStat, { allowRootOwner: true })
    } catch (error) {
      if (error instanceof SourceIdentityError) throw error
      fail('toolchain:go-env')
    }
    parsedGoEnvironment.GOROOT = canonicalGoRoot
    const rustcText = rustcVersion.toString('utf8').trim()
    const rustHost = /^host:\s*(\S+)$/mu.exec(rustcText)?.[1]
    if (!rustHost) fail('toolchain:rustc-version')
    const manifest = Object.freeze({
      target,
      cargo: Object.freeze({
        executablePath: cargo.selection.sourcePath,
        executableSha256: cargo.executableSha256,
        version: cargoVersion.toString('utf8').trim(),
      }),
      git: Object.freeze({
        executablePath: git.selection.sourcePath,
        executableSha256: git.executableSha256,
        version: gitVersion.toString('utf8').trim(),
      }),
      go: Object.freeze({
        compileVersion: goCompileVersion.toString('utf8').trim(),
        env: Object.freeze(
          Object.fromEntries(
            Object.entries(parsedGoEnvironment).sort(([left], [right]) => compareUTF8(left, right)),
          ),
        ),
        executablePath: go.selection.sourcePath,
        executableSha256: go.executableSha256,
        version: goVersion.toString('utf8').trim(),
      }),
      node: Object.freeze({
        architecture: process.arch,
        executablePath: node.selection.sourcePath,
        executableSha256: node.executableSha256,
        platform: process.platform,
        version: nodeVersion.toString('utf8').trim(),
      }),
      pnpm: Object.freeze({
        executablePath: pnpm.selection.sourcePath,
        executableSha256: pnpm.executableSha256,
        version: pnpmVersion.toString('utf8').trim(),
      }),
      rustc: Object.freeze({
        executablePath: rustc.selection.sourcePath,
        executableSha256: rustc.executableSha256,
        host: rustHost,
        version: rustcText,
      }),
      ...(rustup
        ? {
            rustup: Object.freeze({
              executablePath: rustup.selection.sourcePath,
              executableSha256: rustup.executableSha256,
            }),
          }
        : {}),
    })
    const orchestrator = Object.freeze({
      cargo: orchestratorBinding(cargo),
      git: orchestratorBinding(git),
      go: orchestratorBinding(go, { goroot: canonicalGoRoot }),
      node: orchestratorBinding(node),
      pnpm: orchestratorBinding(pnpm),
      rustc: orchestratorBinding(rustc),
      ...(rustup ? { rustup: orchestratorBinding(rustup) } : {}),
      snapshotRoot,
    })
    return Object.freeze({
      bindings: orchestrator,
      gitExecutable: git.snapshotPath,
      gitBinding: git,
      privateBindings: Object.freeze([...bindings]),
      manifest,
      snapshotRoot,
    })
  } catch (error) {
    await Promise.all(bindings.map((binding) => binding.sourceHandle.close().catch(() => undefined)))
    await rm(snapshotRoot, { force: true, recursive: true }).catch(() => undefined)
    throw error
  }
}

async function closeToolchainCapture(capture, removeSnapshot) {
  await Promise.all(
    (capture.privateBindings ?? []).map((binding) =>
      binding.sourceHandle.close().catch(() => undefined),
    ),
  )
  if (removeSnapshot && typeof capture.snapshotRoot === 'string') {
    await rm(capture.snapshotRoot, { force: true, recursive: true }).catch(() => undefined)
  }
}

async function finalizeToolchainCapture(capture) {
  await Promise.all((capture.privateBindings ?? []).map(finalizeToolBinding))
}

async function collectFixtureToolchains(target, snapshotParent, collector) {
  assertProductionPlatform()
  const snapshotRoot = await createToolchainSnapshotRoot(snapshotParent)
  const privateBindings = []
  try {
    const gitSelection = await resolveFixedGitExecutable()
    const gitBinding = await copyExecutableToSnapshot(gitSelection, snapshotRoot, 'git')
    privateBindings.push(gitBinding)
    const manifest = await collector(target)
    validateToolchainTarget(manifest, target)
    await finalizeToolBinding(gitBinding)
    return Object.freeze({
      bindings: null,
      gitBinding,
      gitExecutable: gitBinding.snapshotPath,
      manifest,
      privateBindings: Object.freeze(privateBindings),
      snapshotRoot,
    })
  } catch (error) {
    await Promise.all(
      privateBindings.map((binding) => binding.sourceHandle.close().catch(() => undefined)),
    )
    await rm(snapshotRoot, { force: true, recursive: true }).catch(() => undefined)
    throw error
  }
}

function parseNullTerminatedPaths(bytes) {
  if (bytes.length === 0) return []
  if (bytes.at(-1) !== 0) fail('git:path-list')
  const paths = []
  let start = 0
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0) continue
    const raw = bytes.subarray(start, index)
    const path = raw.toString('utf8')
    if (!Buffer.from(path, 'utf8').equals(raw)) fail('path:encoding')
    paths.push(normalizedRepositoryPath(path))
    start = index + 1
  }
  if (new Set(paths).size !== paths.length) fail('git:duplicate-path')
  return paths.sort(compareUTF8)
}

async function runGitCommand(gitBinding, args, category, options) {
  return runTrustedTool(
    gitBinding,
    args,
    gitCommandEnvironment(dirname(gitBinding.snapshotPath)),
    {
      ...options,
      category,
    },
  )
}

async function listRepositoryPaths(repository, gitBinding) {
  const topLevelBytes = await runGitCommand(
    gitBinding,
    ['rev-parse', '--show-toplevel'],
    'git:repository-root',
    { cwd: repository.root },
  )
  let topLevel
  try {
    topLevel = await realpath(topLevelBytes.toString('utf8').trim())
  } catch {
    fail('git:repository-root')
  }
  if (topLevel !== repository.root) fail('git:repository-root')
  // 单仓枚举串行执行，避免同时注册过多父进程信号处理器。
  const trackedBytes = await runGitCommand(
    gitBinding,
    ['ls-files', '--cached', '--full-name', '-z'],
    'git:tracked-files',
    { cwd: repository.root, maxOutputBytes: GIT_OUTPUT_LIMIT_BYTES },
  )
  const untrackedBytes = await runGitCommand(
    gitBinding,
    ['ls-files', '--others', '--exclude-standard', '--full-name', '-z'],
    'git:untracked-files',
    { cwd: repository.root, maxOutputBytes: GIT_OUTPUT_LIMIT_BYTES },
  )
  const ignoredBytes = await runGitCommand(
    gitBinding,
    [
      'ls-files',
      '--others',
      '--ignored',
      '--exclude-standard',
      '--full-name',
      '-z',
      '--',
      '.',
      ...GIT_EXCLUDED_PATHS,
    ],
    'git:ignored-files',
    { cwd: repository.root, maxOutputBytes: GIT_OUTPUT_LIMIT_BYTES },
  )
  const ignoredSensitiveBytes = await runGitCommand(
    gitBinding,
    [
      'ls-files',
      '--others',
      '--ignored',
      '--exclude-standard',
      '--full-name',
      '-z',
      '--',
      ...GIT_SENSITIVE_PATHS,
    ],
    'git:ignored-sensitive-files',
    { cwd: repository.root, maxOutputBytes: GIT_OUTPUT_LIMIT_BYTES },
  )
  const allTracked = parseNullTerminatedPaths(trackedBytes)
  const allUntracked = parseNullTerminatedPaths(untrackedBytes)
  const allIgnored = [
    ...new Set([
      ...parseNullTerminatedPaths(ignoredBytes),
      ...parseNullTerminatedPaths(ignoredSensitiveBytes),
    ]),
  ].sort(compareUTF8)
  if ([...allUntracked, ...allIgnored].some(isSensitiveEnvironmentPath)) {
    fail('source:sensitive-file')
  }
  for (const path of allTracked.filter(isSensitiveEnvironmentPath)) {
    let stat
    try {
      stat = await lstat(join(repository.root, path), { bigint: true })
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      fail('source:sensitive-file')
    }
    if (stat !== null) fail('source:sensitive-file')
  }
  const tracked = allTracked.filter(
    (path) => isSensitiveEnvironmentPath(path) || !isExcludedOutputPath(path),
  )
  const untracked = allUntracked.filter((path) => !isExcludedOutputPath(path))
  const ignored = allIgnored.filter((path) => !isExcludedOutputPath(path))
  const classified = [...tracked, ...untracked, ...ignored]
  if (new Set(classified).size !== classified.length) fail('git:path-classification')
  return Object.freeze({ ignored, tracked, untracked })
}

function sameStringArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

async function verifyRecordedIdentity(record) {
  const current = await safeLstat(record.absolutePath, record.deleted === true)
  if (record.deleted === true) {
    if (current !== null) {
      fail(record.sensitive === true ? 'source:sensitive-file' : 'drift:deleted-file')
    }
    return
  }
  if (current === null || !sameFileIdentity(record.identity, statIdentity(current))) {
    fail('drift:file-identity')
  }
}

async function verifyIdentities(records) {
  const concurrency = 64
  for (let index = 0; index < records.length; index += concurrency) {
    await Promise.all(records.slice(index, index + concurrency).map(verifyRecordedIdentity))
  }
}

async function scanRepository(repository, gitBinding, budget) {
  const initialPaths = await listRepositoryPaths(repository, gitBinding)
  const files = []
  const deletedTracked = []
  const identities = []
  for (const [sourceKind, paths] of [
    ['tracked', initialPaths.tracked],
    ['untracked', initialPaths.untracked],
    ['ignored-untracked', initialPaths.ignored],
  ]) {
    for (const path of paths) {
      const absolutePath = join(repository.root, path)
      if (!isPathInside(repository.root, absolutePath)) fail('path:escape')
      if (isSensitiveEnvironmentPath(path)) {
        const current = await safeLstat(absolutePath, true)
        if (sourceKind !== 'tracked' || current !== null) fail('source:sensitive-file')
        budget.reserveDeleted()
        deletedTracked.push(path)
        identities.push(Object.freeze({ absolutePath, deleted: true, sensitive: true }))
        continue
      }
      const result = await hashRegularFile(absolutePath, {
        allowMissing: sourceKind === 'tracked',
        budget,
        containmentRoot: repository.root,
      })
      if (result === null) {
        budget.reserveDeleted()
        deletedTracked.push(path)
        identities.push(Object.freeze({ absolutePath, deleted: true }))
        continue
      }
      identities.push(Object.freeze({ absolutePath, identity: result.identity }))
      files.push(
        Object.freeze({
          mode: result.mode,
          path,
          sha256: result.sha256,
          size: result.size,
          sourceKind,
        }),
      )
    }
  }
  await verifyIdentities(identities)
  const finalPaths = await listRepositoryPaths(repository, gitBinding)
  if (
    !sameStringArray(initialPaths.tracked, finalPaths.tracked) ||
    !sameStringArray(initialPaths.untracked, finalPaths.untracked) ||
    !sameStringArray(initialPaths.ignored, finalPaths.ignored)
  ) {
    fail('drift:file-list')
  }
  return Object.freeze({
    initialPaths,
    manifest: Object.freeze({
      deletedTracked: deletedTracked.sort(compareUTF8),
      files: files.sort((left, right) => compareUTF8(left.path, right.path)),
      id: repository.id,
      module: repository.module,
    }),
    identities,
  })
}

async function verifyRepositoryScan(repository, scan, gitBinding) {
  await verifyIdentities(scan.identities)
  const currentPaths = await listRepositoryPaths(repository, gitBinding)
  if (
    !sameStringArray(scan.initialPaths.tracked, currentPaths.tracked) ||
    !sameStringArray(scan.initialPaths.untracked, currentPaths.untracked) ||
    !sameStringArray(scan.initialPaths.ignored, currentPaths.ignored)
  ) {
    fail('drift:file-list')
  }
}

function tokenizeGoConfiguration(text) {
  const tokens = []
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (/\s/u.test(char)) {
      index += 1
      continue
    }
    if (char === '/' && text[index + 1] === '/') {
      index += 2
      while (index < text.length && text[index] !== '\n') index += 1
      continue
    }
    if (char === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2)
      if (end < 0) fail('workspace:syntax')
      index = end + 2
      continue
    }
    if (char === '(' || char === ')') {
      tokens.push(char)
      index += 1
      continue
    }
    if (char === '`') {
      const end = text.indexOf('`', index + 1)
      if (end < 0) fail('workspace:syntax')
      tokens.push(text.slice(index + 1, end))
      index = end + 1
      continue
    }
    if (char === '"') {
      let end = index + 1
      let escaped = false
      while (end < text.length) {
        if (!escaped && text[end] === '"') break
        escaped = !escaped && text[end] === '\\'
        if (text[end] !== '\\') escaped = false
        end += 1
      }
      if (end >= text.length) fail('workspace:syntax')
      try {
        tokens.push(JSON.parse(text.slice(index, end + 1)))
      } catch {
        fail('workspace:syntax')
      }
      index = end + 1
      continue
    }
    let end = index
    while (
      end < text.length &&
      !/\s/u.test(text[end]) &&
      text[end] !== '(' &&
      text[end] !== ')' &&
      !(text[end] === '/' && ['/', '*'].includes(text[end + 1]))
    ) {
      end += 1
    }
    if (end === index) fail('workspace:syntax')
    tokens.push(text.slice(index, end))
    index = end
  }
  return tokens
}

function parseWorkspaceUses(text) {
  const tokens = tokenizeGoConfiguration(text)
  const uses = []
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] !== 'use') continue
    const next = tokens[index + 1]
    if (next === '(') {
      index += 2
      while (index < tokens.length && tokens[index] !== ')') {
        uses.push(tokens[index])
        index += 1
      }
      if (tokens[index] !== ')') fail('workspace:syntax')
    } else if (typeof next === 'string' && next !== ')') {
      uses.push(next)
      index += 1
    } else {
      fail('workspace:syntax')
    }
  }
  return uses
}

function parseModulePath(text) {
  const tokens = tokenizeGoConfiguration(text)
  const index = tokens.indexOf('module')
  if (index < 0 || typeof tokens[index + 1] !== 'string') fail('workspace:module')
  return tokens[index + 1]
}

function isLocalReplacementPath(path) {
  return (
    path === '.' ||
    path === '..' ||
    path.startsWith('./') ||
    path.startsWith('../') ||
    isAbsolute(path) ||
    /^[A-Za-z]:[\\/]/u.test(path) ||
    path.startsWith('\\\\')
  )
}

function parseLocalReplacementPaths(text) {
  const tokens = tokenizeGoConfiguration(text)
  const paths = []
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] !== '=>') continue
    const replacement = tokens[index + 1]
    if (typeof replacement !== 'string' || replacement === '(' || replacement === ')') {
      fail('workspace:syntax')
    }
    if (isLocalReplacementPath(replacement)) paths.push(replacement)
  }
  return paths
}

async function validateLocalReplacements(text, configurationPath, source, layout) {
  const replacements = []
  for (const replacementPath of parseLocalReplacementPaths(text)) {
    if (/^(?:[A-Za-z]:[\\/]|\\\\)/u.test(replacementPath) && !isAbsolute(replacementPath)) {
      fail('workspace:replace')
    }
    const candidate = isAbsolute(replacementPath)
      ? resolve(replacementPath)
      : resolve(dirname(configurationPath), replacementPath)
    let canonicalTarget
    let targetStat
    try {
      canonicalTarget = await realpath(candidate)
      targetStat = await lstat(candidate, { bigint: true })
    } catch {
      fail('workspace:replace')
    }
    if (canonicalTarget !== candidate || targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
      fail('workspace:replace')
    }
    const repository = layout.repositories.find((item) => isPathInside(item.root, canonicalTarget))
    if (!repository) fail('workspace:replace')
    const targetPath = relative(repository.root, canonicalTarget).split('\\').join('/') || '.'
    replacements.push(
      Object.freeze({
        source,
        targetPath,
        targetRepository: repository.id,
      }),
    )
  }
  return replacements
}

async function validateWorkspace(layout) {
  const workspaceBytes = await readSmallSecureFile(
    layout.goWork,
    1024 * 1024,
    'workspace:read',
    layout.workRoot,
  )
  const workspaceText = workspaceBytes.toString('utf8')
  const uses = parseWorkspaceUses(workspaceText)
  const expectedRepositories = layout.repositories.filter(
    (repository) => repository.module !== null,
  )
  if (uses.length !== expectedRepositories.length || new Set(uses).size !== uses.length) {
    fail('workspace:mapping')
  }
  const actualRoots = []
  for (const usePath of uses) {
    const candidate = isAbsolute(usePath)
      ? resolve(usePath)
      : resolve(dirname(layout.goWork), usePath)
    let resolved
    try {
      resolved = await realpath(candidate)
    } catch {
      fail('workspace:mapping')
    }
    if (resolved !== candidate) fail('workspace:mapping')
    actualRoots.push(resolved)
  }
  const expectedRoots = expectedRepositories.map((repository) => repository.root).sort(compareUTF8)
  if (!sameStringArray([...actualRoots].sort(compareUTF8), expectedRoots)) fail('workspace:mapping')

  const modules = []
  const localReplacements = await validateLocalReplacements(
    workspaceText,
    layout.goWork,
    'go.work',
    layout,
  )
  for (const repository of expectedRepositories) {
    const goModPath = join(repository.root, 'go.mod')
    const goMod = await readSmallSecureFile(
      goModPath,
      1024 * 1024,
      'workspace:module',
      repository.root,
    )
    const goModText = goMod.toString('utf8')
    if (parseModulePath(goModText) !== repository.module) fail('workspace:mapping')
    localReplacements.push(
      ...(await validateLocalReplacements(goModText, goModPath, `${repository.id}/go.mod`, layout)),
    )
    modules.push(Object.freeze({ module: repository.module, repository: repository.id }))
  }
  localReplacements.sort((left, right) =>
    compareUTF8(
      `${left.source}\0${left.targetRepository}\0${left.targetPath}`,
      `${right.source}\0${right.targetRepository}\0${right.targetPath}`,
    ),
  )
  return Object.freeze({
    localReplacements: Object.freeze(localReplacements),
    modules: Object.freeze(modules.sort((left, right) => compareUTF8(left.module, right.module))),
  })
}

async function resolveLayoutFromDesktop(desktopRoot) {
  if (typeof desktopRoot !== 'string' || !isAbsolute(desktopRoot)) fail('layout:desktop-root')
  let canonicalDesktopRoot
  try {
    canonicalDesktopRoot = await realpath(desktopRoot)
  } catch {
    fail('layout:desktop-root')
  }
  if (canonicalDesktopRoot !== resolve(desktopRoot)) fail('layout:desktop-root')
  const workRoot = dirname(canonicalDesktopRoot)
  const repositories = []
  for (const contract of REPOSITORY_CONTRACT) {
    const candidate = join(workRoot, contract.id)
    let root
    try {
      root = await realpath(candidate)
    } catch {
      fail('layout:repository')
    }
    if (root !== candidate) fail('layout:repository')
    repositories.push(Object.freeze({ ...contract, root }))
  }
  const desktop = repositories.find((repository) => repository.id === 'hexclaw-desktop')
  if (desktop?.root !== canonicalDesktopRoot) fail('layout:desktop-root')
  const goWorkCandidate = join(workRoot, 'go.work')
  let goWork
  try {
    goWork = await realpath(goWorkCandidate)
  } catch {
    fail('layout:go-work')
  }
  if (goWork !== goWorkCandidate) fail('layout:go-work')
  const goWorkSumCandidate = join(workRoot, 'go.work.sum')
  let goWorkSum = null
  try {
    const goWorkSumStat = await lstat(goWorkSumCandidate, { bigint: true })
    if (goWorkSumStat.isSymbolicLink() || !goWorkSumStat.isFile()) fail('layout:go-work-sum')
    goWorkSum = await realpath(goWorkSumCandidate)
    if (goWorkSum !== goWorkSumCandidate) fail('layout:go-work-sum')
  } catch (error) {
    if (error instanceof SourceIdentityError) throw error
    if (error?.code !== 'ENOENT') fail('layout:go-work-sum')
  }
  return Object.freeze({
    desktopRoot: canonicalDesktopRoot,
    goWork,
    goWorkSum,
    repositories: Object.freeze(repositories),
    workRoot,
  })
}

export async function resolveProductionSourceLayout() {
  let scriptPath
  try {
    scriptPath = await realpath(fileURLToPath(import.meta.url))
  } catch {
    fail('layout:script')
  }
  const desktopRoot = resolve(dirname(scriptPath), '..', '..')
  if (scriptPath !== join(desktopRoot, 'scripts', 'ci', 'package-source-identity.mjs')) {
    fail('layout:script')
  }
  return resolveLayoutFromDesktop(desktopRoot)
}

export async function resolveExecutableForTest(options) {
  assertExactOptions(options, ['name', 'path'])
  return (await resolveExecutable(options.name, options.path)).sourcePath
}

export async function resolveRustToolExecutableForTest(options) {
  assertExactOptions(options, ['name', 'path'])
  const selected = await resolveExecutable(options.name, options.path)
  const rustupSelection = await resolveExecutable('rustup', options.path)
  if (selected.sourcePath !== rustupSelection.sourcePath) return selected.sourcePath
  const snapshotRoot = await createToolchainSnapshotRoot(dirname(selected.selectionPath))
  let rustup
  try {
    rustup = await copyExecutableToSnapshot(rustupSelection, snapshotRoot, 'rustup')
    const reported = (
      await runTrustedTool(
        rustup,
        ['which', options.name],
        commandEnvironment(snapshotRoot),
        { cwd: snapshotRoot },
      )
    )
      .toString('utf8')
      .trim()
    if (!isAbsolute(reported)) fail(`toolchain:${options.name}`)
    const resolvedTool = await realpath(reported).catch(() => fail(`toolchain:${options.name}`))
    await finalizeToolBinding(rustup)
    return resolvedTool
  } finally {
    await rustup?.sourceHandle.close().catch(() => undefined)
    await rm(snapshotRoot, { force: true, recursive: true }).catch(() => undefined)
  }
}

export function validateProductionPlatformForTest(options) {
  assertExactOptions(options, ['hasUid', 'platform'])
  assertProductionPlatform(options.platform, options.hasUid === true ? () => 0 : undefined)
  return true
}

export async function validateSourcePathForTest(options) {
  assertExactOptions(options, ['expectedUid', 'path', 'root'])
  if (
    !Number.isSafeInteger(options.expectedUid) ||
    options.expectedUid < 0 ||
    typeof options.path !== 'string' ||
    !isAbsolute(options.path) ||
    typeof options.root !== 'string' ||
    !isAbsolute(options.root)
  ) {
    fail('input:test-adapter')
  }
  const security = { expectedUID: BigInt(options.expectedUid) }
  await assertSecureAncestorChain(options.root, options.path, security)
  await assertCanonicalFilePath(options.path)
  const stat = await safeLstat(options.path)
  assertRegularSourceStat(stat, security)
  return Object.freeze({
    mode: Number(stat.mode & 0o777n),
    size: Number(stat.size),
    uid: Number(stat.uid),
  })
}

function assertNoSourceOverrides(env) {
  for (const name of SOURCE_OVERRIDE_NAMES) {
    if (typeof env[name] === 'string' && env[name].trim() !== '') fail('input:source-override')
  }
  const assignmentPattern = new RegExp(
    `(?:^|\\s)(?:${SOURCE_OVERRIDE_NAMES.join('|')})(?::|\\+|\\?|!)?=`,
    'u',
  )
  for (const name of ['MAKEFLAGS', 'MAKEOVERRIDES', 'MFLAGS']) {
    if (typeof env[name] === 'string' && assignmentPattern.test(env[name])) {
      fail('input:source-override')
    }
  }
}

async function resolveLayoutAgain(layout) {
  const current = await resolveLayoutFromDesktop(layout.desktopRoot)
  if (
    current.workRoot !== layout.workRoot ||
    current.goWork !== layout.goWork ||
    current.goWorkSum !== layout.goWorkSum
  ) {
    fail('drift:layout')
  }
  for (let index = 0; index < layout.repositories.length; index += 1) {
    if (current.repositories[index].root !== layout.repositories[index].root) fail('drift:layout')
  }
}

function assertManifestDestination(layout, manifestPath) {
  if (manifestPath === layout.goWork || manifestPath === join(layout.workRoot, 'go.work.sum')) {
    fail('input:manifest-path')
  }
  for (const repository of layout.repositories) {
    if (!isPathInside(repository.root, manifestPath)) continue
    const rel = relative(repository.root, manifestPath).split('\\').join('/')
    if (!isExcludedOutputPath(rel)) fail('input:manifest-path')
  }
}

async function captureManifest(layout, target, limits, toolchainConfiguration, manifestPath) {
  const toolchainCapture = toolchainConfiguration?.collector
    ? await collectFixtureToolchains(
        target,
        dirname(manifestPath),
        toolchainConfiguration.collector,
      )
    : await collectProductionToolchains(
        target,
        dirname(manifestPath),
        toolchainConfiguration?.options,
      )
  const budget = createBudget(limits)
  try {
    const workspaceContract = await validateWorkspace(layout)
    const workspaceFiles = []
    const workspaceIdentities = []
    for (const input of [
      Object.freeze({ absolutePath: layout.goWork, path: 'go.work' }),
      ...(layout.goWorkSum === null
        ? []
        : [Object.freeze({ absolutePath: layout.goWorkSum, path: 'go.work.sum' })]),
    ]) {
      const result = await hashRegularFile(input.absolutePath, {
        budget,
        containmentRoot: layout.workRoot,
      })
      workspaceIdentities.push(
        Object.freeze({ absolutePath: input.absolutePath, identity: result.identity }),
      )
      workspaceFiles.push(
        Object.freeze({
          mode: result.mode,
          path: input.path,
          sha256: result.sha256,
          size: result.size,
        }),
      )
    }
    validateToolchainTarget(toolchainCapture.manifest, target)
    const repositoryScans = await Promise.all(
      layout.repositories.map((repository) =>
        scanRepository(repository, toolchainCapture.gitBinding, budget),
      ),
    )
    const finalWorkspaceContract = await validateWorkspace(layout)
    if (
      !canonicalManifestBytes(finalWorkspaceContract).equals(
        canonicalManifestBytes(workspaceContract),
      )
    ) {
      fail('drift:workspace')
    }
    await resolveLayoutAgain(layout)
    await Promise.all(
      repositoryScans.map((scan, index) =>
        verifyRepositoryScan(layout.repositories[index], scan, toolchainCapture.gitBinding),
      ),
    )
    await verifyIdentities(workspaceIdentities)
    await finalizeToolchainCapture(toolchainCapture)
    const totals = budget.snapshot()
    const manifest = {
      limits,
      repositories: repositoryScans.map((scan) => scan.manifest),
      schema: SOURCE_MANIFEST_SCHEMA,
      target,
      toolchains: toolchainCapture.manifest,
      totals,
      workspace: {
        files: workspaceFiles,
        ...workspaceContract,
      },
    }
    canonicalManifestBytes(manifest)
    const preserveSnapshot = toolchainCapture.bindings !== null
    await closeToolchainCapture(toolchainCapture, !preserveSnapshot)
    return Object.freeze({
      manifest,
      snapshotRoot: preserveSnapshot ? toolchainCapture.snapshotRoot : null,
      toolchains: toolchainCapture.bindings,
    })
  } catch (error) {
    await closeToolchainCapture(toolchainCapture, true)
    throw error
  }
}

async function writeManifestAtomically(manifestPath, bytes) {
  try {
    await mkdir(dirname(manifestPath), { mode: 0o700, recursive: true })
  } catch {
    fail('manifest:output-directory')
  }
  if ((await safeLstat(manifestPath, true)) !== null) fail('manifest:already-exists')
  const temporaryPath = `${manifestPath}.tmp-${process.pid}-${randomBytes(12).toString('hex')}`
  let handle
  let directoryHandle
  let published = false
  try {
    handle = await open(
      temporaryPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollowFlag(),
      0o600,
    )
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    handle = null
    await linkFile(temporaryPath, manifestPath)
    published = true
    await unlink(temporaryPath)
    const directoryFlags =
      fsConstants.O_RDONLY |
      noFollowFlag() |
      (Number.isInteger(fsConstants.O_DIRECTORY) ? fsConstants.O_DIRECTORY : 0)
    directoryHandle = await open(dirname(manifestPath), directoryFlags)
    const directoryStat = await directoryHandle.stat({ bigint: true })
    if (!directoryStat.isDirectory()) fail('manifest:output-directory')
    // 文件内容和目录项都落盘后，生成回执才算发布成功。
    await directoryHandle.sync()
    await directoryHandle.close()
    directoryHandle = null
  } catch (error) {
    try {
      if (handle) await handle.close()
    } catch {
      // 主失败优先，临时句柄关闭失败不覆盖原始错误。
    }
    try {
      if (directoryHandle) await directoryHandle.close()
    } catch {
      // 主失败优先，目录句柄关闭失败不覆盖原始错误。
    }
    try {
      await unlink(temporaryPath)
    } catch {
      // 临时文件不存在时无需处理。
    }
    if (published) {
      try {
        await unlink(manifestPath)
      } catch {
        // 发布失败后尽力移除不具备持久性保证的回执。
      }
    }
    if (error instanceof SourceIdentityError) throw error
    fail('manifest:write')
  }
}

async function readCanonicalManifest(manifestPath, expectedSha256) {
  const bytes = await readSmallSecureFile(manifestPath, MANIFEST_LIMIT_BYTES, 'manifest:read')
  if (sha256(bytes) !== expectedSha256) fail('manifest:digest')
  let manifest
  try {
    manifest = JSON.parse(bytes.toString('utf8'))
  } catch {
    fail('manifest:json')
  }
  const canonical = canonicalManifestBytes(manifest)
  if (!canonical.equals(bytes)) fail('manifest:canonical')
  if (!isPlainObject(manifest) || manifest.schema !== SOURCE_MANIFEST_SCHEMA)
    fail('manifest:schema')
  return manifest
}

function resultFromManifest(manifest, digest, toolchains = null) {
  return Object.freeze({
    fileCount: manifest.totals.files,
    sha256: digest,
    target: manifest.target,
    ...(toolchains === null ? {} : { toolchains }),
    totalBytes: manifest.totals.bytes,
  })
}

function createIdentityOperations(layoutResolver, toolchainConfiguration, allowLimitOverrides) {
  return Object.freeze({
    async create(options) {
      assertExactOptions(
        options,
        allowLimitOverrides ? ['limits', 'manifestPath', 'target'] : ['manifestPath', 'target'],
      )
      const manifestPath = validateManifestPath(options.manifestPath)
      const target = validateTarget(options.target)
      const limits = validateLimits(options.limits, allowLimitOverrides)
      const layout = await layoutResolver()
      assertManifestDestination(layout, manifestPath)
      let capture
      try {
        capture = await captureManifest(
          layout,
          target,
          limits,
          toolchainConfiguration,
          manifestPath,
        )
        const bytes = canonicalManifestBytes(capture.manifest)
        const digest = sha256(bytes)
        await writeManifestAtomically(manifestPath, bytes)
        return resultFromManifest(capture.manifest, digest, capture.toolchains)
      } catch (error) {
        if (capture?.snapshotRoot) {
          await rm(capture.snapshotRoot, { force: true, recursive: true }).catch(() => undefined)
        }
        throw error
      }
    },
    async verify(options) {
      assertExactOptions(options, ['expectedSha256', 'manifestPath', 'target'])
      const manifestPath = validateManifestPath(options.manifestPath)
      const expectedSha256 = validateSha256(options.expectedSha256)
      const target = validateTarget(options.target)
      const layout = await layoutResolver()
      assertManifestDestination(layout, manifestPath)
      const manifest = await readCanonicalManifest(manifestPath, expectedSha256)
      if (manifest.target !== target) fail('manifest:target')
      const limits = validateRecordedLimits(manifest.limits, allowLimitOverrides)
      let capture
      try {
        capture = await captureManifest(
          layout,
          target,
          limits,
          toolchainConfiguration,
          manifestPath,
        )
        const currentBytes = canonicalManifestBytes(capture.manifest)
        if (!currentBytes.equals(canonicalManifestBytes(manifest))) fail('drift:source-manifest')
        return resultFromManifest(capture.manifest, sha256(currentBytes), capture.toolchains)
      } catch (error) {
        if (capture?.snapshotRoot) {
          await rm(capture.snapshotRoot, { force: true, recursive: true }).catch(() => undefined)
        }
        throw error
      }
    },
  })
}

const productionOperations = createIdentityOperations(resolveProductionSourceLayout, null, false)

export async function createPackageSourceManifest(options) {
  assertNoSourceOverrides(process.env)
  return productionOperations.create(options)
}

export async function verifyPackageSourceManifest(options) {
  assertNoSourceOverrides(process.env)
  return productionOperations.verify(options)
}

export function createPackageSourceIdentityTestAdapter(options) {
  assertExactOptions(options, ['collectToolchains', 'desktopRoot', 'toolchainOptions'])
  if (typeof options.desktopRoot !== 'string' || !isAbsolute(options.desktopRoot)) {
    fail('input:test-adapter')
  }
  if (options.collectToolchains !== undefined && typeof options.collectToolchains !== 'function') {
    fail('input:test-adapter')
  }
  if (options.collectToolchains !== undefined && options.toolchainOptions !== undefined) {
    fail('input:test-adapter')
  }
  let toolchainConfiguration = null
  if (options.collectToolchains !== undefined) {
    toolchainConfiguration = Object.freeze({ collector: options.collectToolchains })
  } else if (options.toolchainOptions !== undefined) {
    assertExactOptions(options.toolchainOptions, ['gitPath', 'nodePath', 'path', 'rustupHome'])
    for (const name of ['gitPath', 'nodePath', 'rustupHome']) {
      if (typeof options.toolchainOptions[name] !== 'string' || !isAbsolute(options.toolchainOptions[name])) {
        fail('input:test-adapter')
      }
    }
    if (
      typeof options.toolchainOptions.path !== 'string' ||
      options.toolchainOptions.path
        .split(delimiter)
        .some((directory) => directory === '' || !isAbsolute(directory))
    ) {
      fail('input:test-adapter')
    }
    toolchainConfiguration = Object.freeze({
      options: Object.freeze({ ...options.toolchainOptions }),
    })
  }
  return createIdentityOperations(
    async () => {
      let canonicalDesktopRoot
      try {
        canonicalDesktopRoot = await realpath(options.desktopRoot)
      } catch {
        fail('input:test-adapter')
      }
      return resolveLayoutFromDesktop(canonicalDesktopRoot)
    },
    toolchainConfiguration,
    true,
  )
}

function parseCLIArguments(args, allowedNames) {
  const values = {}
  const allowed = new Set(allowedNames)
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]
    const value = args[index + 1]
    if (
      typeof flag !== 'string' ||
      !flag.startsWith('--') ||
      !allowed.has(flag.slice(2)) ||
      typeof value !== 'string' ||
      value.startsWith('--') ||
      Object.hasOwn(values, flag.slice(2))
    ) {
      fail('input:unknown-option')
    }
    values[flag.slice(2)] = value
  }
  if (args.length % 2 !== 0) fail('input:unknown-option')
  return values
}

async function runCLI(argv) {
  const [command, ...args] = argv
  if (command === 'create') {
    const values = parseCLIArguments(args, ['manifest', 'target'])
    const result = await createPackageSourceManifest({
      manifestPath: values.manifest,
      target: values.target,
    })
    process.stdout.write(
      `PASS: package source manifest created. sha256=${result.sha256} files=${result.fileCount} bytes=${result.totalBytes}\n`,
    )
    return
  }
  if (command === 'verify') {
    const values = parseCLIArguments(args, ['expected-sha256', 'manifest', 'target'])
    const result = await verifyPackageSourceManifest({
      expectedSha256: values['expected-sha256'],
      manifestPath: values.manifest,
      target: values.target,
    })
    process.stdout.write(
      `PASS: package source manifest verified. sha256=${result.sha256} files=${result.fileCount} bytes=${result.totalBytes}\n`,
    )
    return
  }
  fail('input:command')
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  runCLI(process.argv.slice(2)).catch((error) => {
    const safeError =
      error instanceof SourceIdentityError ? error : new SourceIdentityError('internal:unexpected')
    process.stderr.write(`${safeError.message}\n`)
    process.exitCode = 1
  })
}
