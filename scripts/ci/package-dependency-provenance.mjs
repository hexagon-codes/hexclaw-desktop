#!/usr/bin/env node

import { createHash, timingSafeEqual } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { chmod, lstat, mkdir, open, opendir, readlink, realpath, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { BoundedProcessError, runBoundedProcess } from './run-bounded-process.mjs'

const RECEIPT_SCHEMA = 'hexclaw.package-dependency-provenance.v2'
const RECEIPT_BASENAME = 'receipt.json'
const CONTROL_BASENAME = '.package-dependencies'
const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
const PRIVATE_EXECUTABLE_MODE = 0o700
const HASH_PATTERN = /^[a-f0-9]{64}$/u
const PACKAGE_MANAGER_PATTERN = /^pnpm@([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)$/u
const MAX_PATH_BYTES = 4_096
const MAX_MODULE_ROOTS = 32
const MAX_RECEIPT_BYTES = 4 * 1024 * 1024
const MAX_TOOL_BYTES = 512 * 1024 * 1024
const DEFAULT_LIMITS = Object.freeze({
  commandTimeoutMs: 30 * 60 * 1_000,
  maxCommandOutputBytes: 8 * 1024 * 1024,
  maxDepth: 128,
  maxEntries: 250_000,
  maxFileBytes: 512 * 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024 * 1024,
  nodeInstallTimeoutMs: 30 * 60 * 1_000,
})
const HARD_LIMITS = Object.freeze({
  commandTimeoutMs: 60 * 60 * 1_000,
  maxCommandOutputBytes: 16 * 1024 * 1024,
  maxDepth: 256,
  maxEntries: 500_000,
  maxFileBytes: 1024 * 1024 * 1024,
  maxTotalBytes: 16 * 1024 * 1024 * 1024,
  nodeInstallTimeoutMs: 60 * 60 * 1_000,
})

export class PackageDependencyProvenanceError extends Error {
  constructor(category) {
    super(`Package dependency provenance failed: category=${category}`)
    this.name = 'PackageDependencyProvenanceError'
    this.category = category
  }
}

function fail(category) {
  throw new PackageDependencyProvenanceError(category)
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function requireExactOptions(options, allowed, category = 'input:options') {
  if (!isPlainObject(options)) fail(category)
  const names = new Set(allowed)
  if (Object.keys(options).some((name) => !names.has(name))) fail('input:unknown-option')
}

function requireAbsolutePath(value, category = 'input:path') {
  if (
    typeof value !== 'string' ||
    !isAbsolute(value) ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES ||
    resolve(value) !== value
  ) {
    fail(category)
  }
  return value
}

function requireSHA256(value, category = 'input:sha256') {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) fail(category)
  return value
}

function requireVersion(value, category = 'input:version') {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > 1024 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail(category)
  }
  return value
}

function requireLimits(overrides) {
  if (overrides === undefined) return DEFAULT_LIMITS
  requireExactOptions(overrides, Object.keys(DEFAULT_LIMITS), 'input:limits')
  const result = {}
  for (const [name, fallback] of Object.entries(DEFAULT_LIMITS)) {
    const value = overrides[name] ?? fallback
    if (!Number.isSafeInteger(value) || value <= 0 || value > HARD_LIMITS[name]) {
      fail('input:limits')
    }
    result[name] = value
  }
  if (result.maxFileBytes > result.maxTotalBytes) fail('input:limits')
  return Object.freeze(result)
}

function currentUID() {
  return typeof process.getuid === 'function' ? BigInt(process.getuid()) : undefined
}

function pathInside(root, candidate) {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

function relativePath(root, candidate, category = 'path:escape') {
  if (!pathInside(root, candidate)) fail(category)
  const value = relative(root, candidate)
  return value === '' ? '.' : value.split(sep).join('/')
}

function identity(metadata) {
  return Object.freeze({
    ctimeNs: metadata.ctimeNs.toString(),
    dev: metadata.dev.toString(),
    ino: metadata.ino.toString(),
    mode: Number(metadata.mode & 0o777n),
    mtimeNs: metadata.mtimeNs.toString(),
    nlink: metadata.nlink.toString(),
    size: metadata.size.toString(),
    uid: metadata.uid.toString(),
  })
}

function sameIdentity(left, right) {
  return (
    isPlainObject(left) &&
    isPlainObject(right) &&
    left.ctimeNs === right.ctimeNs &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.mtimeNs === right.mtimeNs &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.uid === right.uid
  )
}

function requireOwned(metadata, category, { allowRoot = false } = {}) {
  const uid = currentUID()
  if (uid === undefined) return
  if (metadata.uid !== uid && !(allowRoot && metadata.uid === 0n)) fail(`${category}:owner`)
}

function requireSafeMode(metadata, category) {
  if (Number(metadata.mode & 0o022n) !== 0) fail(`${category}:permissions`)
}

async function assertNoSymlinkAncestors(pathname, category) {
  const absolute = requireAbsolutePath(pathname, `${category}:path`)
  const components = absolute.split(sep).filter(Boolean)
  let cursor = sep
  for (const component of components) {
    cursor = join(cursor, component)
    const metadata = await lstat(cursor, { bigint: true }).catch(() => fail(`${category}:missing`))
    if (metadata.isSymbolicLink()) fail(`${category}:symlink`)
  }
  const canonical = await realpath(absolute).catch(() => fail(`${category}:missing`))
  if (canonical !== absolute) fail(`${category}:identity`)
  return absolute
}

async function requireDirectory(
  pathname,
  category,
  { inside, privateMode = false, allowRootOwner = false } = {},
) {
  const path = await assertNoSymlinkAncestors(pathname, category)
  if (inside) relativePath(inside, path, `${category}:escape`)
  const metadata = await lstat(path, { bigint: true }).catch(() => fail(`${category}:missing`))
  if (!metadata.isDirectory()) fail(`${category}:type`)
  requireOwned(metadata, category, { allowRoot: allowRootOwner })
  requireSafeMode(metadata, category)
  if (privateMode && Number(metadata.mode & 0o777n) !== PRIVATE_DIRECTORY_MODE) {
    fail(`${category}:permissions`)
  }
  return path
}

async function rejectHostNodeModules(sourceRoot, generationRoot) {
  let cursor = dirname(sourceRoot)
  while (true) {
    const candidate = join(cursor, 'node_modules')
    const metadata = await lstat(candidate, { bigint: true }).catch((error) => {
      if (error?.code === 'ENOENT') return undefined
      fail('node:host-node-modules')
    })
    if (metadata !== undefined) fail('node:host-node-modules')
    if (cursor === generationRoot) return
    const parent = dirname(cursor)
    if (!pathInside(generationRoot, parent)) return
    cursor = parent
  }
}

async function rejectProjectPackageManagerConfig(sourceRoot, generationRoot) {
  let cursor = sourceRoot
  while (true) {
    for (const name of ['.npmrc', '.pnpmfile.cjs', 'pnpmfile.cjs']) {
      const metadata = await lstat(join(cursor, name), { bigint: true }).catch((error) => {
        if (error?.code === 'ENOENT') return undefined
        fail('node:project-config')
      })
      if (metadata !== undefined) fail('node:project-config')
    }
    if (cursor === generationRoot) return
    const parent = dirname(cursor)
    if (!pathInside(generationRoot, parent)) return
    cursor = parent
  }
}

async function readSecureFile(
  pathname,
  category,
  { maxBytes, inside, allowRootOwner = false, executable = false } = {},
) {
  const path = requireAbsolutePath(pathname, `${category}:path`)
  if (inside) relativePath(inside, path, `${category}:escape`)
  await assertNoSymlinkAncestors(dirname(path), `${category}:parent`)
  let handle
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  } catch (error) {
    if (error?.code === 'ELOOP') fail(`${category}:symlink`)
    fail(`${category}:open`)
  }
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile()) fail(`${category}:type`)
    if (before.nlink !== 1n) fail(`${category}:hardlink`)
    requireOwned(before, category, { allowRoot: allowRootOwner })
    requireSafeMode(before, category)
    if (executable && Number(before.mode & 0o111n) === 0) fail(`${category}:permissions`)
    if (before.size > BigInt(maxBytes)) fail(`${category}:size`)
    const pathBefore = await lstat(path, { bigint: true }).catch(() => fail(`${category}:identity`))
    const beforeIdentity = identity(before)
    if (pathBefore.isSymbolicLink() || !sameIdentity(beforeIdentity, identity(pathBefore))) {
      fail(`${category}:identity`)
    }
    const bytes = Buffer.alloc(Number(before.size))
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (bytesRead <= 0) fail(`${category}:identity`)
      offset += bytesRead
    }
    const after = await handle.stat({ bigint: true })
    const pathAfter = await lstat(path, { bigint: true }).catch(() => fail(`${category}:identity`))
    if (
      !sameIdentity(beforeIdentity, identity(after)) ||
      pathAfter.isSymbolicLink() ||
      !sameIdentity(beforeIdentity, identity(pathAfter))
    ) {
      fail(`${category}:identity`)
    }
    return Object.freeze({
      bytes,
      digest: createHash('sha256').update(bytes).digest('hex'),
      identity: beforeIdentity,
    })
  } finally {
    await handle.close().catch(() => undefined)
  }
}

async function makePrivateDirectory(pathname, root, category) {
  const path = requireAbsolutePath(pathname, `${category}:path`)
  relativePath(root, path, `${category}:escape`)
  await requireDirectory(dirname(path), `${category}:parent`, { inside: root })
  try {
    await mkdir(path, { mode: PRIVATE_DIRECTORY_MODE })
  } catch {
    fail(`${category}:create`)
  }
  await chmod(path, PRIVATE_DIRECTORY_MODE).catch(() => fail(`${category}:permissions`))
  return requireDirectory(path, category, { inside: root, privateMode: true })
}

// 宿主持久共享缓存目录：允许已存在并复用，缺失时创建；仅要求目录、owner 与常规权限。
// 缓存内容不参与 receipt 身份摘要，复用不破坏可复现性（BUG-20260816-001）。
async function ensureSharedCacheDirectory(pathname, category) {
  const absolute = requireAbsolutePath(pathname, `${category}:path`)
  // 父目录缺失时先递归创建（宿主缓存根可能是全新的 ~/.cache），再校验 symlink 祖先。
  const parent = dirname(absolute)
  await mkdir(parent, { mode: PRIVATE_DIRECTORY_MODE, recursive: true }).catch(() =>
    fail(`${category}:parent:create`),
  )
  await assertNoSymlinkAncestors(parent, `${category}:parent`)
  const existing = await lstat(absolute, { bigint: true }).catch((error) => {
    if (error?.code === 'ENOENT') return undefined
    fail(`${category}:metadata`)
  })
  if (existing === undefined) {
    await mkdir(absolute, { mode: PRIVATE_DIRECTORY_MODE }).catch(() => fail(`${category}:create`))
    await chmod(absolute, PRIVATE_DIRECTORY_MODE).catch(() => fail(`${category}:permissions`))
  } else {
    if (existing.isSymbolicLink()) fail(`${category}:symlink`)
    if (!existing.isDirectory()) fail(`${category}:type`)
    requireOwned(existing, category)
    requireSafeMode(existing, category)
  }
  return requireDirectory(absolute, category, { privateMode: true })
}

function canonicalValue(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) fail('receipt:value')
    return value
  }
  if (Array.isArray(value)) return value.map((item) => canonicalValue(item))
  if (!isPlainObject(value)) fail('receipt:value')
  return Object.fromEntries(
    Object.keys(value)
      .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
      .map((key) => [key, canonicalValue(value[key])]),
  )
}

function canonicalJSON(value) {
  return Buffer.from(`${JSON.stringify(canonicalValue(value))}\n`, 'utf8')
}

function digestValue(value) {
  return createHash('sha256').update(canonicalJSON(value)).digest('hex')
}

function equalDigest(left, right) {
  return (
    typeof left === 'string' &&
    typeof right === 'string' &&
    HASH_PATTERN.test(left) &&
    HASH_PATTERN.test(right) &&
    timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
  )
}

async function createPrivateFile(pathname, bytes, category, mode = PRIVATE_FILE_MODE) {
  let handle
  try {
    handle = await open(
      pathname,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      mode,
    )
    await handle.writeFile(bytes)
    await handle.sync()
  } catch {
    await handle?.close().catch(() => undefined)
    await unlink(pathname).catch(() => undefined)
    fail(`${category}:create`)
  }
  await handle.close().catch(() => fail(`${category}:close`))
  await chmod(pathname, mode).catch(() => fail(`${category}:permissions`))
}

async function copyPinnedTool(sourcePath, destinationPath, expectedDigest, label, executable) {
  const source = await readSecureFile(sourcePath, `tool:${label}`, {
    allowRootOwner: true,
    executable,
    maxBytes: MAX_TOOL_BYTES,
  })
  if (!equalDigest(source.digest, expectedDigest)) fail(`tool:${label}:sha256`)
  await createPrivateFile(
    destinationPath,
    source.bytes,
    `tool:${label}:private`,
    executable ? PRIVATE_EXECUTABLE_MODE : PRIVATE_FILE_MODE,
  )
  const copied = await readSecureFile(destinationPath, `tool:${label}:private`, {
    executable,
    maxBytes: MAX_TOOL_BYTES,
  })
  if (!equalDigest(copied.digest, expectedDigest)) fail(`tool:${label}:private-sha256`)
  return Object.freeze({
    executable,
    expectedDigest,
    label,
    privateIdentity: copied.identity,
    privatePath: destinationPath,
    sourceIdentity: source.identity,
    sourcePath,
  })
}

async function verifyTool(binding) {
  const source = await readSecureFile(binding.sourcePath, `tool:${binding.label}`, {
    allowRootOwner: true,
    executable: binding.executable,
    maxBytes: MAX_TOOL_BYTES,
  })
  const copied = await readSecureFile(binding.privatePath, `tool:${binding.label}:private`, {
    executable: binding.executable,
    maxBytes: MAX_TOOL_BYTES,
  })
  if (
    !equalDigest(source.digest, binding.expectedDigest) ||
    !equalDigest(copied.digest, binding.expectedDigest) ||
    !sameIdentity(source.identity, binding.sourceIdentity) ||
    !sameIdentity(copied.identity, binding.privateIdentity)
  ) {
    fail(`tool:${binding.label}:identity`)
  }
}

async function runPinned(commandBinding, companionBindings, args, options, category) {
  const bindings = [commandBinding, ...companionBindings]
  for (const binding of bindings) await verifyTool(binding)
  let result
  let processError
  try {
    result = await runBoundedProcess(commandBinding.privatePath, args, options)
  } catch (error) {
    processError = error
  }
  for (const binding of bindings) await verifyTool(binding)
  if (processError) {
    const suffix = processError instanceof BoundedProcessError ? processError.category : 'internal'
    fail(`${category}:${suffix}`)
  }
  return result
}

function cleanBaseEnvironment(home, temporaryDirectory, path) {
  return Object.freeze({
    HOME: home,
    LANG: 'C',
    LC_ALL: 'C',
    PATH: path,
    TMPDIR: temporaryDirectory,
  })
}

function nodeEnvironment(paths) {
  return Object.freeze({
    ...cleanBaseEnvironment(paths.nodeHome, paths.nodeTemp, `${paths.tools}:/usr/bin:/bin`),
    CI: '1',
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    COREPACK_HOME: paths.corepackHome,
    NPM_CONFIG_CACHE: paths.npmCache,
    NPM_CONFIG_GLOBALCONFIG: '/dev/null',
    NPM_CONFIG_IGNORE_SCRIPTS: 'true',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    NPM_CONFIG_USERCONFIG: '/dev/null',
    PNPM_HOME: paths.pnpmHome,
    PNPM_STORE_DIR: paths.pnpmStore,
    XDG_CACHE_HOME: paths.xdgCache,
    XDG_CONFIG_HOME: paths.xdgConfig,
    XDG_DATA_HOME: paths.xdgData,
  })
}

function goEnvironment(paths, online, goWork = paths.goDependencyWork) {
  return Object.freeze({
    ...cleanBaseEnvironment(paths.goHome, paths.goTemp, '/usr/bin:/bin:/usr/sbin:/sbin'),
    GOAUTH: 'off',
    GOCACHE: paths.goBuildCache,
    GOENV: 'off',
    GOFLAGS: '-mod=readonly -modcacherw',
    GOINSECURE: '',
    GOMODCACHE: paths.goModuleCache,
    GONOPROXY: '',
    GONOSUMDB: '',
    GOPATH: paths.goPath,
    GOPRIVATE: '',
    GOPROXY: online ? 'https://proxy.golang.org' : 'off',
    GOROOT: paths.goroot,
    GOSUMDB: 'sum.golang.org',
    GOTELEMETRY: 'off',
    GOTMPDIR: paths.goTemp,
    GOTOOLCHAIN: 'local',
    GOWORK: goWork,
  })
}

async function readDependencyInput(pathname, generationRoot, label, optional = false) {
  const path = requireAbsolutePath(pathname, 'input:dependency-path')
  relativePath(generationRoot, path, 'input:dependency-escape')
  const metadata = await lstat(path, { bigint: true }).catch((error) => {
    if (optional && error?.code === 'ENOENT') return undefined
    fail(`input:${label}:missing`)
  })
  if (metadata === undefined) {
    return Object.freeze({ missing: true, path: relativePath(generationRoot, path) })
  }
  const file = await readSecureFile(path, `input:${label}`, {
    inside: generationRoot,
    maxBytes: MAX_RECEIPT_BYTES,
  })
  return Object.freeze({
    digest: file.digest,
    mode: file.identity.mode,
    path: relativePath(generationRoot, path),
    size: Number(file.identity.size),
  })
}

async function dependencyInputs(paths) {
  const values = [
    await readDependencyInput(
      join(paths.sourceRoot, 'package.json'),
      paths.generationRoot,
      'package',
    ),
    await readDependencyInput(
      join(paths.sourceRoot, 'pnpm-lock.yaml'),
      paths.generationRoot,
      'lock',
    ),
    await readDependencyInput(
      join(paths.sourceRoot, 'pnpm-workspace.yaml'),
      paths.generationRoot,
      'workspace',
      true,
    ),
    await readDependencyInput(paths.goWork, paths.generationRoot, 'go-work'),
    await readDependencyInput(
      join(dirname(paths.goWork), 'go.work.sum'),
      paths.generationRoot,
      'go-work-sum',
      true,
    ),
  ]
  for (let index = 0; index < paths.moduleRoots.length; index += 1) {
    const moduleRoot = paths.moduleRoots[index]
    values.push(
      await readDependencyInput(
        join(moduleRoot, 'go.mod'),
        paths.generationRoot,
        `go-mod-${index}`,
      ),
      await readDependencyInput(
        join(moduleRoot, 'go.sum'),
        paths.generationRoot,
        `go-sum-${index}`,
        true,
      ),
    )
  }
  return Object.freeze(values.sort((left, right) => left.path.localeCompare(right.path, 'en')))
}

async function scanTree(root, generationRoot, label, limits, symlinkBoundary) {
  await requireDirectory(root, `tree:${label}`, { inside: generationRoot })
  const records = []
  let entries = 0
  let totalBytes = 0
  const visit = async (directory, depth) => {
    if (depth > limits.maxDepth) fail(`tree:${label}:depth`)
    const names = []
    let handle
    try {
      handle = await opendir(directory)
      for await (const entry of handle) {
        names.push(entry.name)
        if (entries + names.length > limits.maxEntries) fail(`tree:${label}:entries`)
      }
    } catch (error) {
      if (error instanceof PackageDependencyProvenanceError) throw error
      fail(`tree:${label}:read`)
    }
    names.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
    for (const name of names) {
      if (name === '' || name === '.' || name === '..' || name.includes('\0')) {
        fail(`tree:${label}:name`)
      }
      entries += 1
      if (entries > limits.maxEntries) fail(`tree:${label}:entries`)
      const path = join(directory, name)
      relativePath(root, path, `tree:${label}:escape`)
      const metadata = await lstat(path, { bigint: true }).catch(() =>
        fail(`tree:${label}:identity`),
      )
      if (metadata.isSymbolicLink()) {
        if (symlinkBoundary === undefined) fail(`tree:${label}:symlink`)
        requireOwned(metadata, `tree:${label}`)
        const target = await readlink(path).catch(() => fail(`tree:${label}:symlink`))
        if (
          target.length === 0 ||
          target.includes('\0') ||
          isAbsolute(target) ||
          Buffer.byteLength(target, 'utf8') > MAX_PATH_BYTES
        ) {
          fail(`tree:${label}:symlink`)
        }
        const lexicalTarget = resolve(dirname(path), target)
        relativePath(symlinkBoundary, lexicalTarget, `tree:${label}:symlink`)
        const canonicalTarget = await realpath(path).catch(() => fail(`tree:${label}:symlink`))
        relativePath(symlinkBoundary, canonicalTarget, `tree:${label}:symlink`)
        records.push({ path: relativePath(root, path), target, type: 'symlink' })
        continue
      }
      requireOwned(metadata, `tree:${label}`)
      requireSafeMode(metadata, `tree:${label}`)
      const nameFromRoot = relativePath(root, path)
      if (metadata.isDirectory()) {
        const canonical = await realpath(path).catch(() => fail(`tree:${label}:identity`))
        if (canonical !== path) fail(`tree:${label}:identity`)
        records.push({
          mode: Number(metadata.mode & 0o777n),
          path: nameFromRoot,
          type: 'directory',
        })
        await visit(path, depth + 1)
        const after = await lstat(path, { bigint: true }).catch(() =>
          fail(`tree:${label}:identity`),
        )
        if (!after.isDirectory() || after.isSymbolicLink()) fail(`tree:${label}:identity`)
        continue
      }
      if (!metadata.isFile()) fail(`tree:${label}:type`)
      if (metadata.nlink !== 1n) fail(`tree:${label}:hardlink`)
      if (metadata.size > BigInt(limits.maxFileBytes)) fail(`tree:${label}:file-size`)
      totalBytes += Number(metadata.size)
      if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.maxTotalBytes) {
        fail(`tree:${label}:total-size`)
      }
      const file = await readSecureFile(path, `tree:${label}`, {
        inside: generationRoot,
        maxBytes: limits.maxFileBytes,
      })
      records.push({
        digest: file.digest,
        mode: file.identity.mode,
        path: nameFromRoot,
        size: Number(file.identity.size),
        type: 'file',
      })
    }
  }
  await visit(root, 0)
  return Object.freeze({ bytes: totalBytes, digest: digestValue(records), entries })
}

async function scanDependencyTrees(paths, limits) {
  // 可复用缓存目录（go/pnpm/npm）不进 receipt 树摘要：共享缓存内容可变，
  // 身份可复现性由源码摘要、锁文件与工具链身份保证（BUG-20260816-001）。
  const definitions = [
    ['node-modules', paths.nodeModules, paths.nodeModules],
    ['pnpm-home', paths.pnpmHome, undefined],
    ['pnpm-virtual-store', paths.pnpmVirtualStore, undefined],
    ['corepack-home', paths.corepackHome, undefined],
    ['go-workspace', paths.goWorkspaceRoot, undefined],
  ]
  const result = {}
  let totalEntries = 0
  let totalBytes = 0
  for (const [label, path, symlinkBoundary] of definitions) {
    const tree = await scanTree(path, paths.generationRoot, label, limits, symlinkBoundary)
    totalEntries += tree.entries
    totalBytes += tree.bytes
    if (totalEntries > limits.maxEntries) fail('tree:aggregate:entries')
    if (totalBytes > limits.maxTotalBytes) fail('tree:aggregate:total-size')
    result[label] = tree
  }
  return Object.freeze(result)
}

function validateConfigShape(options) {
  requireExactOptions(options, [
    'cacheRoot',
    'generationRoot',
    'sourceRoot',
    'sourceManifest',
    'node',
    'pnpm',
    'go',
    'limits',
  ])
  requireExactOptions(options.sourceManifest, ['sha256'], 'input:source-manifest')
  requireExactOptions(options.node, ['executable', 'sha256', 'version'], 'input:node')
  requireExactOptions(
    options.pnpm,
    [
      'executable',
      'packageExecutable',
      'packageSha256',
      'sha256',
      'workerExecutable',
      'workerNativeExecutable',
      'workerNativeName',
      'workerNativeSha256',
      'workerSha256',
      'version',
    ],
    'input:pnpm',
  )
  requireExactOptions(
    options.go,
    ['executable', 'sha256', 'goroot', 'goWork', 'moduleRoots', 'version'],
    'input:go',
  )
  if (
    !Array.isArray(options.go.moduleRoots) ||
    options.go.moduleRoots.length < 1 ||
    options.go.moduleRoots.length > MAX_MODULE_ROOTS
  ) {
    fail('input:module-roots')
  }
  const hasPnpmWorker =
    options.pnpm.packageExecutable !== undefined ||
    options.pnpm.packageSha256 !== undefined ||
    options.pnpm.workerExecutable !== undefined ||
    options.pnpm.workerNativeExecutable !== undefined ||
    options.pnpm.workerNativeName !== undefined ||
    options.pnpm.workerNativeSha256 !== undefined ||
    options.pnpm.workerSha256 !== undefined
  if (
    hasPnpmWorker &&
    (options.pnpm.packageExecutable === undefined ||
      options.pnpm.packageSha256 === undefined ||
      options.pnpm.workerExecutable === undefined ||
      options.pnpm.workerNativeExecutable === undefined ||
      !/^reflink\.darwin-(?:x64|arm64)-[A-Za-z0-9]+\.node$/u.test(
        options.pnpm.workerNativeName ?? '',
      ) ||
      options.pnpm.workerNativeSha256 === undefined ||
      options.pnpm.workerSha256 === undefined)
  ) {
    fail('input:pnpm-worker')
  }
}

async function resolveConfig(options, preparing) {
  validateConfigShape(options)
  const cacheRoot = requireAbsolutePath(options.cacheRoot, 'input:cache-root')
  await ensureSharedCacheDirectory(cacheRoot, 'cache')
  const generationRoot = requireAbsolutePath(options.generationRoot, 'input:generation-root')
  await requireDirectory(generationRoot, 'generation', { privateMode: true })
  const sourceRoot = requireAbsolutePath(options.sourceRoot, 'input:source-root')
  await requireDirectory(sourceRoot, 'source', { inside: generationRoot })
  if (sourceRoot === generationRoot) fail('source:layout')
  await rejectHostNodeModules(sourceRoot, generationRoot)
  await rejectProjectPackageManagerConfig(sourceRoot, generationRoot)
  const goroot = requireAbsolutePath(options.go.goroot, 'input:goroot')
  await requireDirectory(goroot, 'goroot', { allowRootOwner: true })
  const goExecutable = requireAbsolutePath(options.go.executable, 'input:go-executable')
  if (goExecutable !== join(goroot, 'bin', 'go')) fail('input:go-goroot')
  const goWork = requireAbsolutePath(options.go.goWork, 'input:go-work')
  relativePath(generationRoot, goWork, 'input:go-work-escape')
  const moduleRoots = []
  for (const value of options.go.moduleRoots) {
    const moduleRoot = requireAbsolutePath(value, 'input:module-root')
    await requireDirectory(moduleRoot, 'module-root', { inside: generationRoot })
    moduleRoots.push(moduleRoot)
  }
  if (new Set(moduleRoots).size !== moduleRoots.length) fail('input:module-roots')
  const controlRoot = join(generationRoot, CONTROL_BASENAME)
  if (preparing) {
    const existingControl = await lstat(controlRoot).catch((error) => {
      if (error?.code === 'ENOENT') return undefined
      fail('control:state')
    })
    if (existingControl !== undefined) fail('control:exists')
    await makePrivateDirectory(controlRoot, generationRoot, 'control')
  } else {
    await requireDirectory(controlRoot, 'control', { inside: generationRoot, privateMode: true })
  }
  const paths = {
    cacheRoot,
    controlRoot,
    corepackHome: join(controlRoot, 'corepack-home'),
    generationRoot,
    goBuildCache: join(cacheRoot, 'go-build-cache'),
    goDependencyWork: join(controlRoot, 'go-workspace', 'go.work'),
    goHome: join(controlRoot, 'go-home'),
    goModuleCache: join(cacheRoot, 'go-module-cache'),
    goPath: join(controlRoot, 'go-path'),
    goTemp: join(controlRoot, 'go-tmp'),
    goWorkspaceRoot: join(controlRoot, 'go-workspace'),
    goWork,
    goroot,
    moduleRoots: Object.freeze(moduleRoots),
    nodeHome: join(controlRoot, 'node-home'),
    nodeModules: join(sourceRoot, 'node_modules'),
    nodeTemp: join(controlRoot, 'node-tmp'),
    npmCache: join(cacheRoot, 'npm-cache'),
    pnpmHome: join(controlRoot, 'pnpm-home'),
    pnpmStore: join(cacheRoot, 'pnpm-store'),
    pnpmVirtualStore: join(controlRoot, 'pnpm-virtual-store'),
    receiptPath: join(controlRoot, RECEIPT_BASENAME),
    sourceRoot,
    tools: join(controlRoot, 'tools'),
    xdgCache: join(controlRoot, 'xdg-cache'),
    xdgConfig: join(controlRoot, 'xdg-config'),
    xdgData: join(controlRoot, 'xdg-data'),
  }
  const privateDirectories = [
    paths.tools,
    paths.pnpmHome,
    paths.pnpmVirtualStore,
    paths.corepackHome,
    paths.nodeHome,
    paths.nodeTemp,
    paths.xdgCache,
    paths.xdgConfig,
    paths.xdgData,
    paths.goHome,
    paths.goPath,
    paths.goTemp,
    paths.goWorkspaceRoot,
  ]
  if (preparing) {
    const existingModules = await lstat(paths.nodeModules).catch((error) => {
      if (error?.code === 'ENOENT') return undefined
      fail('node:modules-state')
    })
    if (existingModules !== undefined) fail('node:modules-exist')
    for (const path of privateDirectories) {
      await makePrivateDirectory(path, generationRoot, `private:${basename(path)}`)
    }
    for (const path of [paths.goBuildCache, paths.goModuleCache, paths.npmCache, paths.pnpmStore]) {
      await ensureSharedCacheDirectory(path, `shared:${basename(path)}`)
    }
  } else {
    for (const path of privateDirectories) {
      await requireDirectory(path, `private:${basename(path)}`, {
        inside: generationRoot,
        privateMode: true,
      })
    }
    for (const path of [paths.goBuildCache, paths.goModuleCache, paths.npmCache, paths.pnpmStore]) {
      await ensureSharedCacheDirectory(path, `shared:${basename(path)}`)
    }
  }
  return Object.freeze({
    limits: requireLimits(options.limits),
    paths: Object.freeze(paths),
    requestedTools: Object.freeze({
      go: Object.freeze({
        executable: goExecutable,
        sha256: requireSHA256(options.go.sha256, 'input:go-sha256'),
        version: requireVersion(options.go.version, 'input:go-version'),
      }),
      node: Object.freeze({
        executable: requireAbsolutePath(options.node.executable, 'input:node-executable'),
        sha256: requireSHA256(options.node.sha256, 'input:node-sha256'),
        version: requireVersion(options.node.version, 'input:node-version'),
      }),
      pnpm: Object.freeze({
        executable: requireAbsolutePath(options.pnpm.executable, 'input:pnpm-executable'),
        sha256: requireSHA256(options.pnpm.sha256, 'input:pnpm-sha256'),
        version: requireVersion(options.pnpm.version, 'input:pnpm-version'),
        ...(options.pnpm.workerExecutable !== undefined
          ? {
              packageExecutable: requireAbsolutePath(
                options.pnpm.packageExecutable,
                'input:pnpm-package-executable',
              ),
              packageSha256: requireSHA256(options.pnpm.packageSha256, 'input:pnpm-package-sha256'),
              workerExecutable: requireAbsolutePath(
                options.pnpm.workerExecutable,
                'input:pnpm-worker-executable',
              ),
              workerNativeExecutable: requireAbsolutePath(
                options.pnpm.workerNativeExecutable,
                'input:pnpm-worker-native-executable',
              ),
              workerNativeName: options.pnpm.workerNativeName,
              workerNativeSha256: requireSHA256(
                options.pnpm.workerNativeSha256,
                'input:pnpm-worker-native-sha256',
              ),
              workerSha256: requireSHA256(options.pnpm.workerSha256, 'input:pnpm-worker-sha256'),
            }
          : {}),
      }),
    }),
    sourceManifestSha256: requireSHA256(
      options.sourceManifest.sha256,
      'input:source-manifest-sha256',
    ),
  })
}

function configBinding(config) {
  const { requestedTools } = config
  const tools = [
    Object.freeze({
      role: 'go',
      sha256: requestedTools.go.sha256,
      version: requestedTools.go.version,
    }),
    Object.freeze({
      role: 'node',
      sha256: requestedTools.node.sha256,
      version: requestedTools.node.version,
    }),
    Object.freeze({
      role: 'pnpm',
      sha256: requestedTools.pnpm.sha256,
      version: requestedTools.pnpm.version,
    }),
  ]
  if (requestedTools.pnpm.workerExecutable !== undefined) {
    tools.push(
      Object.freeze({
        role: 'pnpm-package',
        sha256: requestedTools.pnpm.packageSha256,
        version: requestedTools.pnpm.version,
      }),
      Object.freeze({
        role: 'pnpm-worker',
        sha256: requestedTools.pnpm.workerSha256,
        version: requestedTools.pnpm.version,
      }),
      Object.freeze({
        role: 'pnpm-worker-native',
        sha256: requestedTools.pnpm.workerNativeSha256,
        version: requestedTools.pnpm.version,
      }),
    )
  }
  return Object.freeze({
    sourceManifestSha256: config.sourceManifestSha256,
    tools: Object.freeze(tools),
  })
}

async function createToolBindings(config) {
  const { paths, requestedTools } = config
  const bindings = {
    go: await copyPinnedTool(
      requestedTools.go.executable,
      join(paths.tools, 'go'),
      requestedTools.go.sha256,
      'go',
      true,
    ),
    node: await copyPinnedTool(
      requestedTools.node.executable,
      join(paths.tools, 'node'),
      requestedTools.node.sha256,
      'node',
      true,
    ),
    pnpm: await copyPinnedTool(
      requestedTools.pnpm.executable,
      join(paths.tools, 'pnpm.cjs'),
      requestedTools.pnpm.sha256,
      'pnpm',
      false,
    ),
  }
  if (requestedTools.pnpm.workerExecutable !== undefined) {
    bindings.pnpmPackage = await copyPinnedTool(
      requestedTools.pnpm.packageExecutable,
      join(paths.tools, 'package.json'),
      requestedTools.pnpm.packageSha256,
      'pnpm-package',
      false,
    )
    bindings.pnpmWorker = await copyPinnedTool(
      requestedTools.pnpm.workerExecutable,
      join(paths.tools, 'worker.js'),
      requestedTools.pnpm.workerSha256,
      'pnpm-worker',
      false,
    )
    bindings.pnpmWorkerNative = await copyPinnedTool(
      requestedTools.pnpm.workerNativeExecutable,
      join(paths.tools, requestedTools.pnpm.workerNativeName),
      requestedTools.pnpm.workerNativeSha256,
      'pnpm-worker-native',
      false,
    )
  }
  return Object.freeze(bindings)
}

function toolBindingRecord(binding, generationRoot) {
  return Object.freeze({
    executable: binding.executable,
    expectedDigest: binding.expectedDigest,
    label: binding.label,
    privateIdentity: binding.privateIdentity,
    privatePath: relativePath(generationRoot, binding.privatePath),
    sourceIdentity: binding.sourceIdentity,
    sourcePath: binding.sourcePath,
  })
}

function restoreToolBinding(record, generationRoot) {
  return Object.freeze({
    ...record,
    privatePath: join(generationRoot, record.privatePath),
  })
}

function processOptions(config, cwd, env, timeoutMs = config.limits.commandTimeoutMs) {
  return Object.freeze({
    cwd,
    env,
    maxOutputBytes: config.limits.maxCommandOutputBytes,
    timeoutMs,
  })
}

async function collectVersions(config, tools) {
  const node = await runPinned(
    tools.node,
    [],
    ['--version'],
    processOptions(config, config.paths.sourceRoot, nodeEnvironment(config.paths)),
    'node:version',
  )
  if (!/^v[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?\n?$/u.test(node.stdout)) {
    fail('node:version:format')
  }
  if (node.stdout.trim() !== config.requestedTools.node.version) fail('node:version:mismatch')
  const pnpm = await runPinned(
    tools.node,
    [
      tools.pnpm,
      ...(tools.pnpmWorker ? [tools.pnpmPackage, tools.pnpmWorker, tools.pnpmWorkerNative] : []),
    ],
    [tools.pnpm.privatePath, '--version'],
    processOptions(config, config.paths.sourceRoot, nodeEnvironment(config.paths)),
    'pnpm:version',
  )
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?\n?$/u.test(pnpm.stdout)) {
    fail('pnpm:version:format')
  }
  const packageFile = await readSecureFile(
    join(config.paths.sourceRoot, 'package.json'),
    'input:package',
    { inside: config.paths.generationRoot, maxBytes: MAX_RECEIPT_BYTES },
  )
  let packageManifest
  try {
    packageManifest = JSON.parse(packageFile.bytes.toString('utf8'))
  } catch {
    fail('input:package-json')
  }
  const packageManager = isPlainObject(packageManifest)
    ? PACKAGE_MANAGER_PATTERN.exec(packageManifest.packageManager ?? '')
    : null
  if (!packageManager || packageManager[1] !== pnpm.stdout.trim()) fail('pnpm:version:mismatch')
  if (pnpm.stdout.trim() !== config.requestedTools.pnpm.version) fail('pnpm:version:mismatch')
  const go = await runPinned(
    tools.go,
    [],
    ['version'],
    processOptions(
      config,
      config.paths.sourceRoot,
      goEnvironment(config.paths, true, config.paths.goWork),
    ),
    'go:version',
  )
  if (!/^go version go[0-9]+\.[0-9]+(?:\.[0-9]+)? [a-z0-9]+\/[a-z0-9]+\n?$/u.test(go.stdout)) {
    fail('go:version:format')
  }
  if (go.stdout.trim() !== config.requestedTools.go.version) fail('go:version:mismatch')
  const goroot = await runPinned(
    tools.go,
    [],
    ['env', 'GOROOT'],
    processOptions(
      config,
      config.paths.sourceRoot,
      goEnvironment(config.paths, true, config.paths.goWork),
    ),
    'go:goroot',
  )
  if (goroot.stdout.trim() !== config.paths.goroot) fail('go:goroot:mismatch')
  const goWork = await runPinned(
    tools.go,
    [],
    ['env', 'GOWORK'],
    processOptions(
      config,
      config.paths.sourceRoot,
      goEnvironment(config.paths, true, config.paths.goWork),
    ),
    'go:work',
  )
  if (goWork.stdout.trim() !== config.paths.goWork) fail('go:work:mismatch')
  return Object.freeze({ go: go.stdout.trim(), node: node.stdout.trim(), pnpm: pnpm.stdout.trim() })
}

async function installNodeDependencies(config, tools) {
  const { paths } = config
  await runPinned(
    tools.node,
    [
      tools.pnpm,
      ...(tools.pnpmWorker ? [tools.pnpmPackage, tools.pnpmWorker, tools.pnpmWorkerNative] : []),
    ],
    [
      tools.pnpm.privatePath,
      'install',
      '--frozen-lockfile',
      '--ignore-scripts',
      '--config.node-linker=hoisted',
      '--config.package-import-method=copy',
      `--config.virtual-store-dir=${paths.pnpmVirtualStore}`,
      `--store-dir=${paths.pnpmStore}`,
      `--config.cache-dir=${paths.npmCache}`,
      '--config.verify-store-integrity=true',
    ],
    processOptions(
      config,
      paths.sourceRoot,
      nodeEnvironment(paths),
      config.limits.nodeInstallTimeoutMs,
    ),
    'node:install',
  )
  await requireDirectory(paths.nodeModules, 'node:modules', { inside: paths.generationRoot })
}

async function prepareGoDependencies(config, tools) {
  const bootstrap = Object.freeze({ ...goEnvironment(config.paths, true), GOWORK: 'off' })
  await runPinned(
    tools.go,
    [],
    ['-C', config.paths.goWorkspaceRoot, 'work', 'init', ...config.paths.moduleRoots],
    processOptions(config, config.paths.goWorkspaceRoot, bootstrap),
    'go:workspace-init',
  )
  const online = goEnvironment(config.paths, true)
  const offline = goEnvironment(config.paths, false)
  await runPinned(
    tools.go,
    [],
    ['-C', config.paths.moduleRoots[0], 'mod', 'download', 'all'],
    processOptions(config, config.paths.moduleRoots[0], online),
    'go:download',
  )
  for (const moduleRoot of config.paths.moduleRoots) {
    await runPinned(
      tools.go,
      [],
      ['-C', moduleRoot, 'mod', 'verify'],
      processOptions(config, moduleRoot, online),
      'go:verify-online',
    )
    await runPinned(
      tools.go,
      [],
      ['-C', moduleRoot, 'mod', 'verify'],
      processOptions(config, moduleRoot, offline),
      'go:verify-offline',
    )
  }
}

function publicResult(config, tools) {
  return Object.freeze({
    go: Object.freeze({
      environment: goEnvironment(config.paths, false),
      executable: tools.go.privatePath,
      moduleRoots: config.paths.moduleRoots,
      workspace: config.paths.goDependencyWork,
    }),
    node: Object.freeze({
      cwd: config.paths.sourceRoot,
      environment: nodeEnvironment(config.paths),
      executable: tools.node.privatePath,
      pnpmExecutable: tools.pnpm.privatePath,
    }),
    receiptPath: config.paths.receiptPath,
  })
}

async function writeReceipt(config, tools, inputs, trees, versions) {
  const receipt = Object.freeze({
    configurationDigest: digestValue(configBinding(config)),
    inputs,
    limits: config.limits,
    schema: RECEIPT_SCHEMA,
    tools: Object.freeze(
      Object.fromEntries(
        Object.entries(tools).map(([name, binding]) => [
          name,
          toolBindingRecord(binding, config.paths.generationRoot),
        ]),
      ),
    ),
    trees,
    versions,
  })
  await createPrivateFile(config.paths.receiptPath, canonicalJSON(receipt), 'receipt')
  return receipt
}

async function readReceipt(config) {
  const file = await readSecureFile(config.paths.receiptPath, 'receipt', {
    inside: config.paths.generationRoot,
    maxBytes: MAX_RECEIPT_BYTES,
  })
  if (file.identity.mode !== PRIVATE_FILE_MODE) fail('receipt:permissions')
  let receipt
  try {
    receipt = JSON.parse(file.bytes.toString('utf8'))
  } catch {
    fail('receipt:json')
  }
  if (!isPlainObject(receipt) || receipt.schema !== RECEIPT_SCHEMA) fail('receipt:schema')
  if (!file.bytes.equals(canonicalJSON(receipt))) fail('receipt:canonical')
  if (!equalDigest(receipt.configurationDigest, digestValue(configBinding(config)))) {
    fail('receipt:configuration')
  }
  return receipt
}

export async function preparePackageDependencyProvenance(options) {
  const config = await resolveConfig(options, true)
  const beforeInputs = await dependencyInputs(config.paths)
  const tools = await createToolBindings(config)
  const versions = await collectVersions(config, tools)
  await installNodeDependencies(config, tools)
  await prepareGoDependencies(config, tools)
  const afterInputs = await dependencyInputs(config.paths)
  if (digestValue(afterInputs) !== digestValue(beforeInputs)) fail('input:drift')
  const trees = await scanDependencyTrees(config.paths, config.limits)
  await writeReceipt(config, tools, afterInputs, trees, versions)
  return publicResult(config, tools)
}

export async function verifyPackageDependencyProvenance(options) {
  const config = await resolveConfig(options, false)
  const receipt = await readReceipt(config)
  const tools = Object.freeze(
    Object.fromEntries(
      Object.entries(receipt.tools ?? {}).map(([name, record]) => [
        name,
        restoreToolBinding(record, config.paths.generationRoot),
      ]),
    ),
  )
  const toolNames = Object.keys(tools).sort()
  const expectedToolNames = tools.pnpmWorker
    ? ['go', 'node', 'pnpm', 'pnpmPackage', 'pnpmWorker', 'pnpmWorkerNative']
    : ['go', 'node', 'pnpm']
  if (
    !tools.go ||
    !tools.node ||
    !tools.pnpm ||
    toolNames.length !== expectedToolNames.length ||
    toolNames.some((name, index) => name !== expectedToolNames[index])
  ) {
    fail('receipt:tools')
  }
  const inputsBefore = await dependencyInputs(config.paths)
  if (digestValue(inputsBefore) !== digestValue(receipt.inputs)) fail('input:drift')
  const versions = await collectVersions(config, tools)
  if (digestValue(versions) !== digestValue(receipt.versions)) fail('tool:version-drift')
  const offline = Object.freeze({ ...goEnvironment(config.paths, false), GOWORK: 'off' })
  for (const moduleRoot of config.paths.moduleRoots) {
    await runPinned(
      tools.go,
      [],
      ['-C', moduleRoot, 'mod', 'verify'],
      processOptions(config, moduleRoot, offline),
      'go:verify-offline',
    )
  }
  const inputsAfter = await dependencyInputs(config.paths)
  if (digestValue(inputsAfter) !== digestValue(receipt.inputs)) fail('input:drift')
  const trees = await scanDependencyTrees(config.paths, config.limits)
  if (digestValue(trees) !== digestValue(receipt.trees)) fail('tree:drift')
  return publicResult(config, tools)
}

async function readCLIConfig(argv) {
  if (argv.length !== 3 || !['prepare', 'verify'].includes(argv[0]) || argv[1] !== '--config') {
    fail('cli:arguments')
  }
  const config = await readSecureFile(argv[2], 'cli:config', {
    maxBytes: MAX_RECEIPT_BYTES,
  })
  if (config.identity.mode !== PRIVATE_FILE_MODE) fail('cli:config:permissions')
  let value
  try {
    value = JSON.parse(config.bytes.toString('utf8'))
  } catch {
    fail('cli:config:json')
  }
  if (!isPlainObject(value)) fail('cli:config:value')
  return Object.freeze({ action: argv[0], options: value })
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  Promise.resolve()
    .then(() => readCLIConfig(process.argv.slice(2)))
    .then(async ({ action, options }) => {
      if (action === 'prepare') await preparePackageDependencyProvenance(options)
      else await verifyPackageDependencyProvenance(options)
      process.stdout.write(
        `PASS: package-dependency-provenance category=${action === 'prepare' ? 'prepared' : 'verified'}\n`,
      )
    })
    .catch((error) => {
      const category =
        error instanceof PackageDependencyProvenanceError ? error.category : 'internal'
      process.stderr.write(`ERROR: package-dependency-provenance category=${category}\n`)
      process.exitCode = 1
    })
}
