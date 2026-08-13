import { createHash, randomBytes } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import {
  chmod,
  link as linkFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
  unlink,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { BoundedProcessError, runBoundedProcess } from './run-bounded-process.mjs'

const SOURCE_MANIFEST_SCHEMA = 'hexclaw.package-source-identity.v2'
const HASH_CHUNK_BYTES = 1024 * 1024
const COMMAND_TIMEOUT_MS = 60_000
const COMMAND_OUTPUT_LIMIT_BYTES = 512 * 1024
const GIT_OUTPUT_LIMIT_BYTES = 16 * 1024 * 1024
const MANIFEST_LIMIT_BYTES = 64 * 1024 * 1024
const TOOLCHAIN_FILE_LIMIT_BYTES = 256 * 1024 * 1024
const PNPM_BUNDLE_FILE_LIMIT = 2_048
const PNPM_BUNDLE_TOTAL_LIMIT_BYTES = 64 * 1024 * 1024
const RUST_BUNDLE_FILE_LIMIT = 1_024
const RUST_BUNDLE_TOTAL_LIMIT_BYTES = 768 * 1024 * 1024
const PRODUCTION_GIT_EXECUTABLE = '/usr/bin/git'
const PRODUCTION_CODESIGN_EXECUTABLE = '/usr/bin/codesign'
const MACH_O_MAGICS = new Set([
  'bebafeca',
  'bfbafeca',
  'cafebabe',
  'cafebabf',
  'cefaedfe',
  'cffaedfe',
  'feedface',
  'feedfacf',
])

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
  for (const name of ['cargo', 'git', 'go', 'node', 'pnpm', 'rustc']) {
    const tool = toolchains[name]
    if (
      !isPlainObject(tool) ||
      typeof tool.executablePath !== 'string' ||
      !isAbsolute(tool.executablePath) ||
      tool.executablePath.includes('\0') ||
      typeof tool.version !== 'string' ||
      tool.version.trim() === '' ||
      Buffer.byteLength(tool.version, 'utf8') > COMMAND_OUTPUT_LIMIT_BYTES
    ) {
      fail('toolchain:manifest')
    }
    validateSha256(tool.executableSha256, 'toolchain:manifest')
    validateSha256(tool.sourceSha256, 'toolchain:manifest')
  }
  if (
    typeof toolchains.go.compileVersion !== 'string' ||
    toolchains.go.compileVersion.trim() === '' ||
    !isPlainObject(toolchains.go.env) ||
    typeof toolchains.go.env.GOROOT !== 'string' ||
    !isAbsolute(toolchains.go.env.GOROOT)
  ) {
    fail('toolchain:manifest')
  }
  if (!Array.isArray(toolchains.pnpm.supportFiles)) fail('toolchain:manifest')
  for (const support of toolchains.pnpm.supportFiles) {
    if (
      !isPlainObject(support) ||
      typeof support.path !== 'string' ||
      normalizedRepositoryPath(support.path) !== support.path ||
      typeof support.sourcePath !== 'string' ||
      !isAbsolute(support.sourcePath) ||
      !Number.isSafeInteger(support.size) ||
      support.size < 0
    ) {
      fail('toolchain:manifest')
    }
    validateSha256(support.executableSha256, 'toolchain:manifest')
    validateSha256(support.sourceSha256, 'toolchain:manifest')
  }
  if (toolchains.rustup !== undefined) {
    const rustup = toolchains.rustup
    if (
      !isPlainObject(rustup) ||
      typeof rustup.executablePath !== 'string' ||
      !isAbsolute(rustup.executablePath) ||
      typeof rustup.version !== 'string' ||
      rustup.version.trim() === ''
    ) {
      fail('toolchain:manifest')
    }
    validateSha256(rustup.executableSha256, 'toolchain:manifest')
    validateSha256(rustup.sourceSha256, 'toolchain:manifest')
  }
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

function isCodexWorkspacePath(path) {
  return path.split('/').some((component) => component.toLowerCase().startsWith('.codex'))
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
    if (error instanceof BoundedProcessError) fail(`${category}:${error.category}`)
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
      assertRegularSourceStat(stat, { allowHardLinks: true, allowRootOwner: true })
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
    assertRegularSourceStat(stat, { allowHardLinks: true, allowRootOwner: true })
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

async function selectionsShareFile(left, right) {
  try {
    const [leftStat, rightStat] = await Promise.all([
      lstat(left.sourcePath, { bigint: true }),
      lstat(right.sourcePath, { bigint: true }),
    ])
    return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino
  } catch {
    fail('toolchain:source')
  }
}

function productionToolchainOptions() {
  const hostHome = homedir()
  return Object.freeze({
    corepackHome: join(hostHome, 'Library', 'Caches', 'node', 'corepack'),
    gitPath: PRODUCTION_GIT_EXECUTABLE,
    goRoot: '/usr/local/go',
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
    snapshotRustToolchain: true,
  })
}

async function resolvePnpmPackage(desktopRoot, options) {
  if (options.corepackHome === undefined) {
    return Object.freeze({
      selection: await resolveExecutable('pnpm', options.path),
      tree: null,
    })
  }
  const packageBytes = await readSmallSecureFile(
    join(desktopRoot, 'package.json'),
    1024 * 1024,
    'toolchain:package-json',
    desktopRoot,
  )
  let packageDocument
  try {
    packageDocument = JSON.parse(packageBytes.toString('utf8'))
  } catch {
    fail('toolchain:package-json')
  }
  const version = /^pnpm@(\d+\.\d+\.\d+)$/u.exec(packageDocument.packageManager)?.[1]
  if (!version || typeof options.corepackHome !== 'string' || !isAbsolute(options.corepackHome)) {
    fail('toolchain:pnpm-package')
  }
  const packageRoot = resolve(options.corepackHome, 'v1', 'pnpm', version)
  const tree = await enumerateSecureToolTree(packageRoot)
  const entryPath = join(tree.root, 'bin', 'pnpm.cjs')
  if (!tree.files.includes('bin/pnpm.cjs')) fail('toolchain:pnpm-package')
  return Object.freeze({
    selection: Object.freeze({ selectionPath: entryPath, sourcePath: entryPath }),
    tree,
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
    // 开发工具目录可由本机 admin 组维护；目录身份会在每次执行前后复核。
    if ((stat.uid !== currentUserID() && stat.uid !== 0n) || (stat.mode & 0o002n) !== 0n) {
      fail('toolchain:source')
    }
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

async function verifySelectedSource(selection, witness, sourceHandle, sourceIdentity, category) {
  let sourceHandleStat
  let sourcePathStat
  let sourceParentStat
  let selectionStat
  let selectionParentStat
  let resolvedSelection
  try {
    ;[
      sourceHandleStat,
      sourcePathStat,
      sourceParentStat,
      selectionStat,
      selectionParentStat,
      resolvedSelection,
    ] = await Promise.all([
      sourceHandle.stat({ bigint: true }),
      lstat(selection.sourcePath, { bigint: true }),
      lstat(dirname(selection.sourcePath), { bigint: true }),
      lstat(selection.selectionPath, { bigint: true }),
      lstat(dirname(selection.selectionPath), { bigint: true }),
      realpath(selection.selectionPath),
    ])
  } catch {
    fail(category)
  }
  if (
    resolvedSelection !== selection.sourcePath ||
    !sameFileIdentity(sourceIdentity, statIdentity(sourceHandleStat)) ||
    !sameFileIdentity(sourceIdentity, statIdentity(sourcePathStat)) ||
    !sameFileIdentity(witness.sourceParentIdentity, statIdentity(sourceParentStat)) ||
    !sameFileIdentity(witness.selectionIdentity, statIdentity(selectionStat)) ||
    !sameFileIdentity(witness.selectionParentIdentity, statIdentity(selectionParentStat))
  ) {
    fail(category)
  }
}

async function signMachOSnapshot(snapshotPath, snapshotRoot, magic) {
  if (!MACH_O_MAGICS.has(magic)) return
  // 平台 Mach-O 离开只读系统卷后需重新签名；固定系统 signer 是该引导链的信任锚。
  const selection = await resolveFixedExecutable('codesign', PRODUCTION_CODESIGN_EXECUTABLE)
  const witness = await capturePathWitness(selection)
  const sourceStat = await safeLstat(selection.sourcePath)
  let sourceHandle
  try {
    sourceHandle = await open(selection.sourcePath, fsConstants.O_RDONLY | noFollowFlag())
    const sourceIdentity = statIdentity(await sourceHandle.stat({ bigint: true }))
    if (!sameFileIdentity(statIdentity(sourceStat), sourceIdentity)) {
      fail('toolchain:signer-drift')
    }
    const signerSha256 = await hashOpenFile(sourceHandle, Number(sourceIdentity.size))
    await verifySelectedSource(
      selection,
      witness,
      sourceHandle,
      sourceIdentity,
      'toolchain:signer-drift',
    )
    await requireCommand(
      selection.sourcePath,
      ['--force', '--sign', '-', snapshotPath],
      'toolchain:codesign',
      {
        cwd: snapshotRoot,
        env: commandEnvironment(snapshotRoot),
        maxOutputBytes: COMMAND_OUTPUT_LIMIT_BYTES,
      },
    )
    await verifySelectedSource(
      selection,
      witness,
      sourceHandle,
      sourceIdentity,
      'toolchain:signer-drift',
    )
    if ((await hashOpenFile(sourceHandle, Number(sourceIdentity.size))) !== signerSha256) {
      fail('toolchain:signer-drift')
    }
  } finally {
    await sourceHandle?.close().catch(() => undefined)
  }
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
  if (!stat.isDirectory() || stat.uid !== currentUserID() || (stat.mode & 0o777n) !== 0o700n) {
    fail('toolchain:snapshot-root')
  }
  return snapshotRoot
}

async function copyExecutableToSnapshot(selection, snapshotRoot, name) {
  normalizedRepositoryPath(name)
  const witness = await capturePathWitness(selection)
  const sourcePathStat = await safeLstat(selection.sourcePath)
  assertRegularSourceStat(sourcePathStat, { allowHardLinks: true, allowRootOwner: true })
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
  const magicBytes = Buffer.alloc(4)
  let magicLength = 0
  try {
    sourceHandle = await open(selection.sourcePath, fsConstants.O_RDONLY | noFollowFlag())
    const sourceBefore = await sourceHandle.stat({ bigint: true })
    if (!sameFileIdentity(statIdentity(sourcePathStat), statIdentity(sourceBefore))) {
      fail('toolchain:source-drift')
    }
    await mkdir(dirname(snapshotPath), { mode: 0o700, recursive: true })
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
      if (magicLength < magicBytes.length) {
        const copied = Math.min(bytesRead, magicBytes.length - magicLength)
        buffer.copy(magicBytes, magicLength, 0, copied)
        magicLength += copied
      }
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
    await snapshotHandle.chmod(0o700)
    await snapshotHandle.sync()
    const sourceAfter = await sourceHandle.stat({ bigint: true })
    if (!sameFileIdentity(statIdentity(sourceBefore), statIdentity(sourceAfter))) {
      fail('toolchain:source-drift')
    }
    await snapshotHandle.close()
    snapshotHandle = null
    const sourceSha256 = digest.digest('hex')
    await signMachOSnapshot(snapshotPath, snapshotRoot, magicBytes.toString('hex'))
    await chmod(snapshotPath, 0o500)
    snapshotHandle = await open(snapshotPath, fsConstants.O_RDONLY | noFollowFlag())
    const snapshotStat = await snapshotHandle.stat({ bigint: true })
    if (
      !snapshotStat.isFile() ||
      snapshotStat.nlink !== 1n ||
      snapshotStat.uid !== currentUserID() ||
      (snapshotStat.mode & 0o777n) !== 0o500n ||
      snapshotStat.size < 1n ||
      snapshotStat.size > BigInt(TOOLCHAIN_FILE_LIMIT_BYTES)
    ) {
      fail('toolchain:snapshot-write')
    }
    const executableSha256 = await hashOpenFile(snapshotHandle, Number(snapshotStat.size))
    await snapshotHandle.close()
    snapshotHandle = null
    return Object.freeze({
      executableSha256,
      name,
      selection,
      snapshotIdentity: statIdentity(snapshotStat),
      snapshotPath,
      sourceHandle,
      sourceIdentity: statIdentity(sourceBefore),
      sourceSha256,
      witness,
    })
  } catch (error) {
    await sourceHandle?.close().catch(() => undefined)
    await snapshotHandle?.close().catch(() => undefined)
    if (error instanceof SourceIdentityError) throw error
    fail('toolchain:snapshot-write')
  }
}

async function enumerateSecureToolTree(root, limits = {}) {
  const category = limits.category ?? 'toolchain:pnpm-bundle'
  const maxFiles = limits.maxFiles ?? PNPM_BUNDLE_FILE_LIMIT
  const maxTotalBytes = limits.maxTotalBytes ?? PNPM_BUNDLE_TOTAL_LIMIT_BYTES
  let canonicalRoot
  try {
    canonicalRoot = await realpath(root)
  } catch {
    fail(category)
  }
  if (canonicalRoot !== resolve(root)) fail(category)
  const pending = ['']
  const files = []
  const directories = []
  let totalBytes = 0
  while (pending.length > 0) {
    const relativeDirectory = pending.shift()
    const directoryPath = relativeDirectory ? join(canonicalRoot, relativeDirectory) : canonicalRoot
    const directoryStat = await safeLstat(directoryPath)
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      fail(category)
    }
    assertSecureOwnershipAndMode(directoryStat)
    if ((await realpath(directoryPath).catch(() => '')) !== directoryPath) {
      fail(category)
    }
    directories.push(
      Object.freeze({ path: relativeDirectory, identity: statIdentity(directoryStat) }),
    )
    let entries
    try {
      entries = await readdir(directoryPath, { withFileTypes: true })
    } catch {
      fail(category)
    }
    entries.sort((left, right) => compareUTF8(left.name, right.name))
    for (const entry of entries) {
      if (entry.name === '' || entry.name.includes('/') || entry.name.includes('\0')) {
        fail(category)
      }
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
      normalizedRepositoryPath(relativePath)
      const absolutePath = join(canonicalRoot, relativePath)
      const stat = await safeLstat(absolutePath)
      if (stat.isDirectory()) {
        pending.push(relativePath)
        continue
      }
      assertRegularSourceStat(stat)
      totalBytes += Number(stat.size)
      if (files.length + 1 > maxFiles) fail(`${category}-file-count`)
      if (totalBytes > maxTotalBytes) fail(`${category}-total-bytes`)
      files.push(relativePath)
    }
  }
  return Object.freeze({
    directories: Object.freeze(directories),
    files: Object.freeze(files.sort(compareUTF8)),
    limits: Object.freeze({ category, maxFiles, maxTotalBytes }),
    root: canonicalRoot,
  })
}

async function copyToolSupportFile(treeRoot, relativePath, snapshotRoot, snapshotPrefix) {
  const sourcePath = join(treeRoot, relativePath)
  const selection = Object.freeze({ selectionPath: sourcePath, sourcePath })
  const witness = await capturePathWitness(selection)
  const sourceStat = await safeLstat(sourcePath)
  assertRegularSourceStat(sourceStat)
  const snapshotPath = join(snapshotRoot, snapshotPrefix, relativePath)
  let sourceHandle
  let snapshotHandle
  try {
    sourceHandle = await open(sourcePath, fsConstants.O_RDONLY | noFollowFlag())
    const sourceBefore = await sourceHandle.stat({ bigint: true })
    if (!sameFileIdentity(statIdentity(sourceStat), statIdentity(sourceBefore))) {
      fail('toolchain:source-drift')
    }
    const snapshotMode = (sourceBefore.mode & 0o111n) === 0n ? 0o400 : 0o500
    await mkdir(dirname(snapshotPath), { mode: 0o700, recursive: true })
    snapshotHandle = await open(
      snapshotPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollowFlag(),
      0o600,
    )
    const size = Number(sourceBefore.size)
    const buffer = Buffer.allocUnsafe(Math.min(HASH_CHUNK_BYTES, Math.max(size, 1)))
    const digest = createHash('sha256')
    let position = 0
    while (position < size) {
      const requested = Math.min(buffer.length, size - position)
      const { bytesRead } = await sourceHandle.read(buffer, 0, requested, position)
      if (bytesRead <= 0) fail('toolchain:source-drift')
      digest.update(buffer.subarray(0, bytesRead))
      let written = 0
      while (written < bytesRead) {
        const { bytesWritten } = await snapshotHandle.write(
          buffer,
          written,
          bytesRead - written,
          position + written,
        )
        if (bytesWritten <= 0) fail('toolchain:snapshot-write')
        written += bytesWritten
      }
      position += bytesRead
    }
    await snapshotHandle.chmod(snapshotMode)
    await snapshotHandle.sync()
    const snapshotStat = await snapshotHandle.stat({ bigint: true })
    if (
      !snapshotStat.isFile() ||
      snapshotStat.nlink !== 1n ||
      snapshotStat.uid !== currentUserID() ||
      (snapshotStat.mode & 0o777n) !== BigInt(snapshotMode) ||
      snapshotStat.size !== sourceBefore.size
    ) {
      fail('toolchain:snapshot-write')
    }
    await verifySelectedSource(
      selection,
      witness,
      sourceHandle,
      statIdentity(sourceBefore),
      'toolchain:source-drift',
    )
    const sourceSha256 = digest.digest('hex')
    await sourceHandle.close()
    sourceHandle = null
    await snapshotHandle.close()
    snapshotHandle = null
    return Object.freeze({
      executableSha256: sourceSha256,
      name: relativePath,
      selection,
      snapshotIdentity: statIdentity(snapshotStat),
      snapshotPath,
      sourceHandle: null,
      sourceIdentity: statIdentity(sourceBefore),
      sourceSha256,
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
  let snapshotStat
  await verifySelectedSource(
    binding.selection,
    binding.witness,
    binding.sourceHandle,
    binding.sourceIdentity,
    'toolchain:source-drift',
  )
  try {
    snapshotStat = await lstat(binding.snapshotPath, { bigint: true })
  } catch {
    fail('toolchain:snapshot-drift')
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
  if (binding.sourceHandle === null) {
    let sourceHandle
    let snapshotHandle
    try {
      sourceHandle = await open(binding.selection.sourcePath, fsConstants.O_RDONLY | noFollowFlag())
      await verifySelectedSource(
        binding.selection,
        binding.witness,
        sourceHandle,
        binding.sourceIdentity,
        'toolchain:source-drift',
      )
      if (
        (await hashOpenFile(sourceHandle, Number(binding.sourceIdentity.size))) !==
        binding.sourceSha256
      ) {
        fail('toolchain:source-drift')
      }
      snapshotHandle = await open(binding.snapshotPath, fsConstants.O_RDONLY | noFollowFlag())
      const snapshotStat = await snapshotHandle.stat({ bigint: true })
      if (!sameFileIdentity(binding.snapshotIdentity, statIdentity(snapshotStat))) {
        fail('toolchain:snapshot-drift')
      }
      if (
        (await hashOpenFile(snapshotHandle, Number(binding.snapshotIdentity.size))) !==
        binding.executableSha256
      ) {
        fail('toolchain:snapshot-drift')
      }
      return
    } finally {
      await sourceHandle?.close().catch(() => undefined)
      await snapshotHandle?.close().catch(() => undefined)
    }
  }
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
  if (sourceDigest !== binding.sourceSha256) fail('toolchain:source-drift')
  if (snapshotDigest !== binding.executableSha256) fail('toolchain:snapshot-drift')
}

function orchestratorBinding(binding, extra = {}) {
  return Object.freeze({
    canonical: binding.snapshotPath,
    executableSha256: binding.executableSha256,
    invocation: binding.snapshotPath,
    sourceCanonical: binding.selection.sourcePath,
    sourceSha256: binding.sourceSha256,
    ...extra,
  })
}

async function collectProductionToolchains(target, snapshotParent, suppliedOptions, desktopRoot) {
  assertProductionPlatform()
  const options = suppliedOptions ?? productionToolchainOptions()
  const snapshotRoot = await createToolchainSnapshotRoot(snapshotParent)
  const bindings = []
  const treeContracts = []
  const bind = async (selection, name) => {
    const binding = await copyExecutableToSnapshot(selection, snapshotRoot, name)
    bindings.push(binding)
    return binding
  }
  try {
    const [gitSelection, goSelection, pnpmPackage, nodeSelection, rustcSelection, cargoSelection] =
      await Promise.all([
        resolveFixedGitExecutable(options.gitPath),
        resolveExecutable('go', options.path),
        resolvePnpmPackage(desktopRoot, options),
        resolveFixedExecutable('node', options.nodePath),
        resolveExecutable('rustc', options.path),
        resolveExecutable('cargo', options.path),
      ])
    const [git, go, node] = await Promise.all([
      bind(gitSelection, 'git'),
      bind(goSelection, 'go'),
      bind(nodeSelection, 'node'),
    ])
    let pnpm
    const pnpmSupport = []
    if (pnpmPackage.tree === null) {
      pnpm = await bind(pnpmPackage.selection, 'pnpm')
    } else {
      treeContracts.push(pnpmPackage.tree)
      pnpm = await bind(pnpmPackage.selection, 'pnpm-package/bin/pnpm.cjs')
      const supportPaths = pnpmPackage.tree.files.filter((path) => path !== 'bin/pnpm.cjs')
      for (let index = 0; index < supportPaths.length; index += 16) {
        const copied = await Promise.all(
          supportPaths
            .slice(index, index + 16)
            .map((path) =>
              copyToolSupportFile(pnpmPackage.tree.root, path, snapshotRoot, 'pnpm-package'),
            ),
        )
        bindings.push(...copied)
        pnpmSupport.push(...copied)
      }
    }
    let rustup
    let rustupVersion = null
    let rustcResolved = rustcSelection
    let cargoResolved = cargoSelection
    const rustupSelection = await resolveExecutable('rustup', options.path).catch(() => null)
    const rustcUsesRustup =
      rustupSelection !== null && (await selectionsShareFile(rustcSelection, rustupSelection))
    const cargoUsesRustup =
      rustupSelection !== null && (await selectionsShareFile(cargoSelection, rustupSelection))
    if (rustupSelection && (rustcUsesRustup || cargoUsesRustup)) {
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
      if (rustcUsesRustup) {
        const reported = (
          await runTrustedTool(rustup, ['which', 'rustc'], rustupEnv, {
            category: 'toolchain:rustup',
            cwd: desktopRoot,
          })
        )
          .toString('utf8')
          .trim()
        if (!isAbsolute(reported)) fail('toolchain:rustc')
        const sourcePath = await realpath(reported).catch(() => fail('toolchain:rustc'))
        rustcResolved = Object.freeze({ selectionPath: resolve(reported), sourcePath })
      }
      if (cargoUsesRustup) {
        const reported = (
          await runTrustedTool(rustup, ['which', 'cargo'], rustupEnv, {
            category: 'toolchain:rustup',
            cwd: desktopRoot,
          })
        )
          .toString('utf8')
          .trim()
        if (!isAbsolute(reported)) fail('toolchain:cargo')
        const sourcePath = await realpath(reported).catch(() => fail('toolchain:cargo'))
        cargoResolved = Object.freeze({ selectionPath: resolve(reported), sourcePath })
      }
      rustupVersion = await runTrustedTool(rustup, ['--version'], rustupEnv, {
        category: 'toolchain:rustup',
        cwd: desktopRoot,
      })
    }
    let rustc
    let cargo
    const rustSupport = []
    let rustSnapshotRoot = null
    if (options.snapshotRustToolchain === true) {
      const rustTreeRoot = resolve(dirname(rustcResolved.sourcePath), '..')
      if (
        !isPathInside(rustTreeRoot, rustcResolved.sourcePath) ||
        !isPathInside(rustTreeRoot, cargoResolved.sourcePath)
      ) {
        fail('toolchain:rust-bundle')
      }
      const rustTree = await enumerateSecureToolTree(rustTreeRoot, {
        category: 'toolchain:rust-bundle',
        maxFiles: RUST_BUNDLE_FILE_LIMIT,
        maxTotalBytes: RUST_BUNDLE_TOTAL_LIMIT_BYTES,
      })
      const rustcRelative = relative(rustTree.root, rustcResolved.sourcePath)
      const cargoRelative = relative(rustTree.root, cargoResolved.sourcePath)
      if (!rustTree.files.includes(rustcRelative) || !rustTree.files.includes(cargoRelative)) {
        fail('toolchain:rust-bundle')
      }
      treeContracts.push(rustTree)
      rustSnapshotRoot = join(snapshotRoot, 'rust-toolchain')
      ;[rustc, cargo] = await Promise.all([
        bind(rustcResolved, `rust-toolchain/${rustcRelative}`),
        bind(cargoResolved, `rust-toolchain/${cargoRelative}`),
      ])
      const supportPaths = rustTree.files.filter(
        (path) => path !== rustcRelative && path !== cargoRelative,
      )
      for (let index = 0; index < supportPaths.length; index += 8) {
        const copied = await Promise.all(
          supportPaths
            .slice(index, index + 8)
            .map((path) =>
              copyToolSupportFile(rustTree.root, path, snapshotRoot, 'rust-toolchain'),
            ),
        )
        bindings.push(...copied)
        rustSupport.push(...copied)
      }
    } else {
      ;[rustc, cargo] = await Promise.all([
        bind(rustcResolved, 'rustc'),
        bind(cargoResolved, 'cargo'),
      ])
    }
    const baseEnv = commandEnvironment(snapshotRoot)
    let expectedGoRoot
    try {
      expectedGoRoot = await realpath(
        options.goRoot ?? resolve(dirname(go.selection.sourcePath), '..'),
      )
      const goRootStat = await lstat(expectedGoRoot, { bigint: true })
      if (!goRootStat.isDirectory()) fail('toolchain:go-env')
      assertSecureOwnershipAndMode(goRootStat, { allowRootOwner: true })
    } catch (error) {
      if (error instanceof SourceIdentityError) throw error
      fail('toolchain:go-env')
    }
    const goEnv = commandEnvironment(snapshotRoot, {
      GOENV: 'off',
      GOROOT: expectedGoRoot,
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
      { category: 'toolchain:git', cwd: snapshotRoot },
    )
    const goVersion = await runTrustedTool(go, ['version'], goEnv, {
      category: 'toolchain:go',
      cwd: snapshotRoot,
    })
    const goCompileVersion = await runTrustedTool(go, ['tool', 'compile', '-V=full'], goEnv, {
      category: 'toolchain:go',
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
      { category: 'toolchain:go', cwd: snapshotRoot },
    )
    const rustcVersion = await runTrustedTool(rustc, ['-vV'], baseEnv, {
      category: 'toolchain:rustc',
      cwd: snapshotRoot,
    })
    const cargoVersion = await runTrustedTool(cargo, ['-Vv'], baseEnv, {
      category: 'toolchain:cargo',
      cwd: snapshotRoot,
    })
    const pnpmVersion = await runTrustedTool(pnpm, ['--version'], baseEnv, {
      category: 'toolchain:pnpm',
      cwd: snapshotRoot,
    })
    const nodeVersion = await runTrustedTool(node, ['--version'], baseEnv, {
      category: 'toolchain:node',
      cwd: snapshotRoot,
    })
    for (let index = 0; index < bindings.length; index += 32) {
      await Promise.all(bindings.slice(index, index + 32).map(finalizeToolBinding))
    }
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
    if (canonicalGoRoot !== expectedGoRoot) fail('toolchain:go-env')
    const rustcText = rustcVersion.toString('utf8').trim()
    const rustHost = /^host:\s*(\S+)$/mu.exec(rustcText)?.[1]
    if (!rustHost) fail('toolchain:rustc-version')
    const manifest = Object.freeze({
      target,
      cargo: Object.freeze({
        executablePath: cargo.selection.sourcePath,
        executableSha256: cargo.executableSha256,
        sourceSha256: cargo.sourceSha256,
        version: cargoVersion.toString('utf8').trim(),
      }),
      git: Object.freeze({
        executablePath: git.selection.sourcePath,
        executableSha256: git.executableSha256,
        sourceSha256: git.sourceSha256,
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
        sourceSha256: go.sourceSha256,
        version: goVersion.toString('utf8').trim(),
      }),
      node: Object.freeze({
        architecture: process.arch,
        executablePath: node.selection.sourcePath,
        executableSha256: node.executableSha256,
        sourceSha256: node.sourceSha256,
        platform: process.platform,
        version: nodeVersion.toString('utf8').trim(),
      }),
      pnpm: Object.freeze({
        executablePath: pnpm.selection.sourcePath,
        executableSha256: pnpm.executableSha256,
        sourceSha256: pnpm.sourceSha256,
        supportFiles: Object.freeze(
          pnpmSupport.map((binding) =>
            Object.freeze({
              executableSha256: binding.executableSha256,
              path: binding.name,
              size: Number(binding.sourceIdentity.size),
              sourcePath: binding.selection.sourcePath,
              sourceSha256: binding.sourceSha256,
            }),
          ),
        ),
        version: pnpmVersion.toString('utf8').trim(),
      }),
      rustc: Object.freeze({
        executablePath: rustc.selection.sourcePath,
        executableSha256: rustc.executableSha256,
        sourceSha256: rustc.sourceSha256,
        host: rustHost,
        version: rustcText,
      }),
      ...(rustSnapshotRoot
        ? {
            rustToolchain: Object.freeze({
              sourceRoot: resolve(dirname(rustc.selection.sourcePath), '..'),
              supportFiles: Object.freeze(
                rustSupport.map((binding) =>
                  Object.freeze({
                    executableSha256: binding.executableSha256,
                    path: binding.name,
                    size: Number(binding.sourceIdentity.size),
                    sourcePath: binding.selection.sourcePath,
                    sourceSha256: binding.sourceSha256,
                  }),
                ),
              ),
            }),
          }
        : {}),
      ...(rustup
        ? {
            rustup: Object.freeze({
              executablePath: rustup.selection.sourcePath,
              executableSha256: rustup.executableSha256,
              sourceSha256: rustup.sourceSha256,
              version: rustupVersion.toString('utf8').trim(),
            }),
          }
        : {}),
    })
    const orchestrator = Object.freeze({
      cargo: orchestratorBinding(cargo, {
        toolchainRoot: rustSnapshotRoot,
        version: manifest.cargo.version,
      }),
      git: orchestratorBinding(git, { version: manifest.git.version }),
      go: orchestratorBinding(go, { goroot: canonicalGoRoot, version: manifest.go.version }),
      node: orchestratorBinding(node, { version: manifest.node.version }),
      pnpm: orchestratorBinding(pnpm, {
        supportFiles: Object.freeze(
          pnpmSupport.map((binding) =>
            Object.freeze({
              canonical: binding.snapshotPath,
              executableSha256: binding.executableSha256,
              path: binding.name,
              sourceCanonical: binding.selection.sourcePath,
              sourceSha256: binding.sourceSha256,
            }),
          ),
        ),
        version: manifest.pnpm.version,
      }),
      rustc: orchestratorBinding(rustc, {
        toolchainRoot: rustSnapshotRoot,
        version: manifest.rustc.version,
      }),
      ...(rustSnapshotRoot
        ? {
            rustToolchain: Object.freeze({
              canonical: rustSnapshotRoot,
              supportFiles: Object.freeze(
                rustSupport.map((binding) =>
                  Object.freeze({
                    canonical: binding.snapshotPath,
                    executableSha256: binding.executableSha256,
                    path: binding.name,
                    sourceCanonical: binding.selection.sourcePath,
                    sourceSha256: binding.sourceSha256,
                  }),
                ),
              ),
            }),
          }
        : {}),
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
      treeContracts: Object.freeze(treeContracts),
    })
  } catch (error) {
    await Promise.all(
      bindings.map((binding) => binding.sourceHandle?.close().catch(() => undefined)),
    )
    await rm(snapshotRoot, { force: true, recursive: true }).catch(() => undefined)
    throw error
  }
}

async function closeToolchainCapture(capture, removeSnapshot) {
  await Promise.all(
    (capture.privateBindings ?? []).map((binding) =>
      binding.sourceHandle?.close().catch(() => undefined),
    ),
  )
  if (removeSnapshot && typeof capture.snapshotRoot === 'string') {
    await rm(capture.snapshotRoot, { force: true, recursive: true }).catch(() => undefined)
  }
}

async function finalizeToolchainCapture(capture) {
  const bindings = capture.privateBindings ?? []
  for (let index = 0; index < bindings.length; index += 32) {
    await Promise.all(bindings.slice(index, index + 32).map(finalizeToolBinding))
  }
  for (const contract of capture.treeContracts ?? []) {
    const current = await enumerateSecureToolTree(contract.root, contract.limits)
    if (!sameStringArray(current.files, contract.files)) fail('toolchain:source-drift')
    if (current.directories.length !== contract.directories.length) {
      fail('toolchain:source-drift')
    }
    for (let index = 0; index < current.directories.length; index += 1) {
      const left = current.directories[index]
      const right = contract.directories[index]
      if (left.path !== right.path || !sameFileIdentity(left.identity, right.identity)) {
        fail('toolchain:source-drift')
      }
    }
  }
}

async function collectFixtureToolchains(target, snapshotParent, collector) {
  assertProductionPlatform()
  const snapshotRoot = await createToolchainSnapshotRoot(snapshotParent)
  const privateBindings = []
  try {
    const gitSelection = await resolveFixedGitExecutable()
    const gitBinding = await copyExecutableToSnapshot(gitSelection, snapshotRoot, 'git')
    privateBindings.push(gitBinding)
    await finalizeToolBinding(gitBinding)
    return Object.freeze({
      bindings: null,
      gitBinding,
      gitExecutable: gitBinding.snapshotPath,
      manifest: null,
      manifestPromise: Promise.resolve().then(() => collector(target)),
      privateBindings: Object.freeze(privateBindings),
      snapshotRoot,
    })
  } catch (error) {
    await Promise.all(
      privateBindings.map((binding) => binding.sourceHandle?.close().catch(() => undefined)),
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

async function runGitCommand(gitBinding, args, category, options, onGitCommand) {
  if (onGitCommand) await onGitCommand(category)
  return runTrustedTool(gitBinding, args, gitCommandEnvironment(dirname(gitBinding.snapshotPath)), {
    ...options,
    category,
  })
}

function parseSingleGitLine(bytes, category, pattern) {
  const text = bytes.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(bytes)) fail(category)
  const value = text.endsWith('\n') ? text.slice(0, -1) : text
  if (
    value === '' ||
    Buffer.byteLength(value, 'utf8') > 512 ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    !pattern.test(value)
  ) {
    fail(category)
  }
  return value
}

function parseGitTags(bytes) {
  const text = bytes.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(bytes) || /[\u0000\r\u007f]/u.test(text)) {
    fail('git:vcs-tags')
  }
  const content = text.endsWith('\n') ? text.slice(0, -1) : text
  if (content === '') return Object.freeze([])
  const tags = content.split('\n')
  if (
    tags.length > 1024 ||
    tags.some(
      (tag) =>
        tag === '' || Buffer.byteLength(tag, 'utf8') > 512 || /[\s\u0000-\u001f\u007f]/u.test(tag),
    )
  ) {
    fail('git:vcs-tags')
  }
  const sorted = tags.sort(compareUTF8)
  if (new Set(sorted).size !== sorted.length) fail('git:vcs-tags')
  return Object.freeze(sorted)
}

async function captureRepositoryVCS(repository, gitBinding, onGitCommand) {
  // 同仓查询保持串行，限制并发子进程与信号监听器数量。
  const head = parseSingleGitLine(
    await runGitCommand(
      gitBinding,
      ['rev-parse', '--verify', 'HEAD'],
      'git:vcs-head',
      { cwd: repository.root, maxOutputBytes: 1024 },
      onGitCommand,
    ),
    'git:vcs-head',
    /^[a-f0-9]{40,64}$/u,
  )
  const commitDate = parseSingleGitLine(
    await runGitCommand(
      gitBinding,
      ['show', '-s', '--format=%cI', 'HEAD'],
      'git:vcs-date',
      { cwd: repository.root, maxOutputBytes: 1024 },
      onGitCommand,
    ),
    'git:vcs-date',
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u,
  )
  const describe = parseSingleGitLine(
    await runGitCommand(
      gitBinding,
      ['describe', '--tags', '--always', '--dirty'],
      'git:vcs-describe',
      { cwd: repository.root, maxOutputBytes: 1024 },
      onGitCommand,
    ),
    'git:vcs-describe',
    /^\S+$/u,
  )
  const tags = parseGitTags(
    await runGitCommand(
      gitBinding,
      ['tag', '--points-at', 'HEAD'],
      'git:vcs-tags',
      { cwd: repository.root, maxOutputBytes: 512 * 1024 },
      onGitCommand,
    ),
  )
  return Object.freeze({ commitDate, describe, head, tags })
}

async function listRepositoryPaths(repository, gitBinding, onGitCommand) {
  const topLevelBytes = await runGitCommand(
    gitBinding,
    ['rev-parse', '--show-toplevel'],
    'git:repository-root',
    { cwd: repository.root },
    onGitCommand,
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
    onGitCommand,
  )
  const untrackedBytes = await runGitCommand(
    gitBinding,
    ['ls-files', '--others', '--exclude-standard', '--full-name', '-z'],
    'git:untracked-files',
    { cwd: repository.root, maxOutputBytes: GIT_OUTPUT_LIMIT_BYTES },
    onGitCommand,
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
    onGitCommand,
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
      ...GIT_EXCLUDED_PATHS,
    ],
    'git:ignored-sensitive-files',
    { cwd: repository.root, maxOutputBytes: GIT_OUTPUT_LIMIT_BYTES },
    onGitCommand,
  )
  const allTracked = parseNullTerminatedPaths(trackedBytes)
  const listedUntracked = parseNullTerminatedPaths(untrackedBytes)
  const listedIgnored = [
    ...new Set([
      ...parseNullTerminatedPaths(ignoredBytes),
      ...parseNullTerminatedPaths(ignoredSensitiveBytes),
    ]),
  ].sort(compareUTF8)
  if (allTracked.some(isCodexWorkspacePath)) fail('source:codex-path')
  // 宿主未跟踪/忽略的 .codex* 只按 Git 路径名排除，绝不触碰其元数据或内容。
  const allUntracked = listedUntracked.filter((path) => !isCodexWorkspacePath(path))
  const allIgnored = listedIgnored.filter((path) => !isCodexWorkspacePath(path))
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

async function scanRepository(repository, gitBinding, budget, hooks) {
  const initialVCS = await captureRepositoryVCS(repository, gitBinding, hooks?.onGitCommand)
  const initialPaths = await listRepositoryPaths(repository, gitBinding, hooks?.onGitCommand)
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
  if (hooks?.afterInitialRepositoryScan) await hooks.afterInitialRepositoryScan(repository.id)
  const finalPaths = await listRepositoryPaths(repository, gitBinding, hooks?.onGitCommand)
  const finalVCS = await captureRepositoryVCS(repository, gitBinding, hooks?.onGitCommand)
  if (
    !sameStringArray(initialPaths.tracked, finalPaths.tracked) ||
    !sameStringArray(initialPaths.untracked, finalPaths.untracked) ||
    !sameStringArray(initialPaths.ignored, finalPaths.ignored)
  ) {
    fail('drift:file-list')
  }
  if (!canonicalManifestBytes(initialVCS).equals(canonicalManifestBytes(finalVCS))) {
    fail('drift:vcs')
  }
  return Object.freeze({
    initialPaths,
    manifest: Object.freeze({
      deletedTracked: deletedTracked.sort(compareUTF8),
      files: files.sort((left, right) => compareUTF8(left.path, right.path)),
      id: repository.id,
      module: repository.module,
      vcs: initialVCS,
    }),
    identities,
    vcs: initialVCS,
  })
}

async function verifyRepositoryScan(repository, scan, gitBinding, hooks) {
  await verifyIdentities(scan.identities)
  const currentPaths = await listRepositoryPaths(repository, gitBinding, hooks?.onGitCommand)
  const currentVCS = await captureRepositoryVCS(repository, gitBinding, hooks?.onGitCommand)
  if (
    !sameStringArray(scan.initialPaths.tracked, currentPaths.tracked) ||
    !sameStringArray(scan.initialPaths.untracked, currentPaths.untracked) ||
    !sameStringArray(scan.initialPaths.ignored, currentPaths.ignored)
  ) {
    fail('drift:file-list')
  }
  if (!canonicalManifestBytes(scan.vcs).equals(canonicalManifestBytes(currentVCS))) {
    fail('drift:vcs')
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

function parseModulePath(text) {
  const tokens = tokenizeGoConfiguration(text)
  const index = tokens.indexOf('module')
  if (index < 0 || typeof tokens[index + 1] !== 'string') fail('workspace:module')
  return tokens[index + 1]
}

function parseGoVersion(text) {
  const matches = [...text.matchAll(/^go[ \t]+(1\.[0-9]+(?:\.[0-9]+)?)[ \t]*$/gmu)]
  if (matches.length !== 1) fail('workspace:go-version')
  return matches[0][1]
}

function compareGoVersions(left, right) {
  const leftParts = left.split('.').map(Number)
  const rightParts = right.split('.').map(Number)
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

function dedicatedWorkspaceBytes(goVersion) {
  const moduleRepositories = REPOSITORY_CONTRACT.filter((entry) => entry.module !== null)
  return Buffer.from(
    `go ${goVersion}\n\nuse (\n${moduleRepositories.map(({ id }) => `\t./${id}\n`).join('')})\n`,
    'utf8',
  )
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
    const repository = layout.repositories.find(
      (item) => item.module !== null && isPathInside(item.root, canonicalTarget),
    )
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
  const expectedRepositories = layout.repositories.filter(
    (repository) => repository.module !== null,
  )
  const modules = []
  const localReplacements = []
  const goVersions = []
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
    goVersions.push(parseGoVersion(goModText))
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
  const goVersion = goVersions.reduce((highest, candidate) =>
    compareGoVersions(candidate, highest) > 0 ? candidate : highest,
  )
  const workspaceBytes = dedicatedWorkspaceBytes(goVersion)
  return Object.freeze({
    file: Object.freeze({
      mode: '100600',
      path: 'go.work',
      sha256: sha256(workspaceBytes),
      size: workspaceBytes.length,
    }),
    goVersion,
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
  return Object.freeze({
    desktopRoot: canonicalDesktopRoot,
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
      await runTrustedTool(rustup, ['which', options.name], commandEnvironment(snapshotRoot), {
        cwd: snapshotRoot,
      })
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
  assertProductionPlatform(options.platform, options.hasUid === true ? () => 0 : null)
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
  if (current.workRoot !== layout.workRoot) {
    fail('drift:layout')
  }
  for (let index = 0; index < layout.repositories.length; index += 1) {
    if (current.repositories[index].root !== layout.repositories[index].root) fail('drift:layout')
  }
}

function assertManifestDestination(layout, manifestPath) {
  for (const repository of layout.repositories) {
    if (!isPathInside(repository.root, manifestPath)) continue
    const rel = relative(repository.root, manifestPath).split('\\').join('/')
    if (!isExcludedOutputPath(rel)) fail('input:manifest-path')
  }
}

async function captureWorkspaceInputs(layout, budget) {
  const workspaceContract = await validateWorkspace(layout)
  budget.reserve(workspaceContract.file.size)
  return workspaceContract
}

async function captureManifest(
  layout,
  target,
  limits,
  toolchainConfiguration,
  manifestPath,
  hooks,
) {
  if (hooks?.onCapture) await hooks.onCapture()
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
        layout.desktopRoot,
      )
  const budget = createBudget(limits)
  try {
    const workspacePromise = captureWorkspaceInputs(layout, budget)
    const manifestPromise =
      toolchainCapture.manifestPromise ?? Promise.resolve(toolchainCapture.manifest)
    const scansPromise = Promise.all(
      layout.repositories.map((repository) =>
        scanRepository(repository, toolchainCapture.gitBinding, budget, hooks),
      ),
    )
    // 三个并发边界都收敛后再处理失败，避免清理仍被扫描进程使用的快照。
    const [workspaceResult, manifestResult, scansResult] = await Promise.allSettled([
      workspacePromise,
      manifestPromise,
      scansPromise,
    ])
    if (workspaceResult.status === 'rejected') throw workspaceResult.reason
    if (manifestResult.status === 'rejected') throw manifestResult.reason
    if (scansResult.status === 'rejected') throw scansResult.reason
    const workspaceContract = workspaceResult.value
    const toolchainManifest = manifestResult.value
    const repositoryScans = scansResult.value
    validateToolchainTarget(toolchainManifest, target)
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
        verifyRepositoryScan(layout.repositories[index], scan, toolchainCapture.gitBinding, hooks),
      ),
    )
    await finalizeToolchainCapture(toolchainCapture)
    const totals = budget.snapshot()
    const manifest = {
      limits,
      repositories: repositoryScans.map((scan) => scan.manifest),
      schema: SOURCE_MANIFEST_SCHEMA,
      target,
      toolchains: toolchainManifest,
      totals,
      workspace: workspaceContract,
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

/** 冻结后的校验只验证清单自身及其摘要，不再访问宿主源码或 Git。 */
function validateFrozenManifest(manifest, target, allowLimitOverrides) {
  const topLevelKeys = isPlainObject(manifest) ? Object.keys(manifest).sort() : []
  if (
    topLevelKeys.join(',') !== 'limits,repositories,schema,target,toolchains,totals,workspace' ||
    manifest.schema !== SOURCE_MANIFEST_SCHEMA ||
    manifest.target !== target
  ) {
    fail('manifest:schema')
  }
  const limits = validateRecordedLimits(manifest.limits, allowLimitOverrides)
  validateToolchainTarget(manifest.toolchains, target)
  if (
    !Array.isArray(manifest.repositories) ||
    manifest.repositories.length !== REPOSITORY_CONTRACT.length
  ) {
    fail('manifest:repositories')
  }

  let files = 0
  let deletedTracked = 0
  let bytes = 0
  for (let index = 0; index < REPOSITORY_CONTRACT.length; index += 1) {
    const repository = manifest.repositories[index]
    const contract = REPOSITORY_CONTRACT[index]
    if (
      !isPlainObject(repository) ||
      repository.id !== contract.id ||
      repository.module !== contract.module ||
      !Array.isArray(repository.files) ||
      !Array.isArray(repository.deletedTracked) ||
      !isPlainObject(repository.vcs)
    ) {
      fail('manifest:repositories')
    }
    let previousPath = null
    for (const file of repository.files) {
      if (
        !isPlainObject(file) ||
        normalizedRepositoryPath(file.path) !== file.path ||
        (previousPath !== null && compareUTF8(previousPath, file.path) >= 0) ||
        !/^100[0-7]{3}$/u.test(file.mode ?? '') ||
        !['ignored-untracked', 'tracked', 'untracked'].includes(file.sourceKind) ||
        !Number.isSafeInteger(file.size) ||
        file.size < 0 ||
        file.size > limits.maxFileBytes
      ) {
        fail('manifest:repositories')
      }
      validateSha256(file.sha256, 'manifest:repositories')
      previousPath = file.path
      files += 1
      bytes += file.size
    }
    let previousDeleted = null
    for (const path of repository.deletedTracked) {
      if (
        normalizedRepositoryPath(path) !== path ||
        (previousDeleted !== null && compareUTF8(previousDeleted, path) >= 0)
      ) {
        fail('manifest:repositories')
      }
      previousDeleted = path
      deletedTracked += 1
    }
    const vcsKeys = Object.keys(repository.vcs).sort().join(',')
    if (
      vcsKeys !== 'commitDate,describe,head,tags' ||
      !/^[a-f0-9]{40,64}$/u.test(repository.vcs.head ?? '') ||
      typeof repository.vcs.commitDate !== 'string' ||
      typeof repository.vcs.describe !== 'string' ||
      !Array.isArray(repository.vcs.tags)
    ) {
      fail('manifest:vcs')
    }
  }

  const workspace = manifest.workspace
  if (
    !isPlainObject(workspace) ||
    !isPlainObject(workspace.file) ||
    !Array.isArray(workspace.modules) ||
    typeof workspace.goVersion !== 'string' ||
    workspace.file.path !== 'go.work' ||
    workspace.file.mode !== '100600' ||
    !Number.isSafeInteger(workspace.file.size) ||
    workspace.file.size < 0 ||
    workspace.file.size > limits.maxFileBytes
  ) {
    fail('manifest:workspace')
  }
  validateSha256(workspace.file.sha256, 'manifest:workspace')
  files += 1
  bytes += workspace.file.size
  const totals = manifest.totals
  if (
    !isPlainObject(totals) ||
    Object.keys(totals).sort().join(',') !== 'bytes,deletedTracked,entries,files' ||
    totals.files !== files ||
    totals.deletedTracked !== deletedTracked ||
    totals.entries !== files + deletedTracked ||
    totals.bytes !== bytes ||
    totals.entries > limits.maxFiles ||
    totals.bytes > limits.maxTotalBytes
  ) {
    fail('manifest:totals')
  }
  return manifest
}

function createIdentityOperations(
  layoutResolver,
  toolchainConfiguration,
  allowLimitOverrides,
  hooks = null,
) {
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
          hooks,
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
      const manifest = await readCanonicalManifest(manifestPath, expectedSha256)
      validateFrozenManifest(manifest, target, allowLimitOverrides)
      return resultFromManifest(manifest, expectedSha256)
    },
  })
}

const productionOperations = createIdentityOperations(resolveProductionSourceLayout, null, false)

export async function createPackageSourceManifest(options) {
  assertNoSourceOverrides(process.env)
  return productionOperations.create(options)
}

export async function verifyPackageSourceManifest(options) {
  return productionOperations.verify(options)
}

export function createPackageSourceIdentityTestAdapter(options) {
  assertExactOptions(options, [
    'afterInitialRepositoryScan',
    'collectToolchains',
    'desktopRoot',
    'onCapture',
    'onGitCommand',
    'toolchainOptions',
  ])
  if (typeof options.desktopRoot !== 'string' || !isAbsolute(options.desktopRoot)) {
    fail('input:test-adapter')
  }
  if (options.collectToolchains !== undefined && typeof options.collectToolchains !== 'function') {
    fail('input:test-adapter')
  }
  if (options.collectToolchains !== undefined && options.toolchainOptions !== undefined) {
    fail('input:test-adapter')
  }
  if (
    options.afterInitialRepositoryScan !== undefined &&
    typeof options.afterInitialRepositoryScan !== 'function'
  ) {
    fail('input:test-adapter')
  }
  for (const name of ['onCapture', 'onGitCommand']) {
    if (options[name] !== undefined && typeof options[name] !== 'function') {
      fail('input:test-adapter')
    }
  }
  let toolchainConfiguration = null
  if (options.collectToolchains !== undefined) {
    toolchainConfiguration = Object.freeze({ collector: options.collectToolchains })
  } else if (options.toolchainOptions !== undefined) {
    assertExactOptions(options.toolchainOptions, [
      'corepackHome',
      'gitPath',
      'goRoot',
      'nodePath',
      'path',
      'rustupHome',
      'snapshotRustToolchain',
    ])
    for (const name of ['gitPath', 'nodePath', 'rustupHome']) {
      if (
        typeof options.toolchainOptions[name] !== 'string' ||
        !isAbsolute(options.toolchainOptions[name])
      ) {
        fail('input:test-adapter')
      }
    }
    if (
      options.toolchainOptions.goRoot !== undefined &&
      (typeof options.toolchainOptions.goRoot !== 'string' ||
        !isAbsolute(options.toolchainOptions.goRoot))
    ) {
      fail('input:test-adapter')
    }
    if (
      options.toolchainOptions.corepackHome !== undefined &&
      (typeof options.toolchainOptions.corepackHome !== 'string' ||
        !isAbsolute(options.toolchainOptions.corepackHome))
    ) {
      fail('input:test-adapter')
    }
    if (
      typeof options.toolchainOptions.path !== 'string' ||
      options.toolchainOptions.path
        .split(delimiter)
        .some((directory) => directory === '' || !isAbsolute(directory))
    ) {
      fail('input:test-adapter')
    }
    if (
      options.toolchainOptions.snapshotRustToolchain !== undefined &&
      typeof options.toolchainOptions.snapshotRustToolchain !== 'boolean'
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
    options.afterInitialRepositoryScan || options.onCapture || options.onGitCommand
      ? Object.freeze({
          afterInitialRepositoryScan: options.afterInitialRepositoryScan,
          onCapture: options.onCapture,
          onGitCommand: options.onGitCommand,
        })
      : null,
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
