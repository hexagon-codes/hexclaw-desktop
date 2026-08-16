import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rename, rm, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import process from 'node:process'

const GENERATION_ID_PATTERN = /^[a-f0-9]{32}$/u
// macOS 会在被 Finder/终端访问的目录内自动生成 .DS_Store；它是本机系统元数据而非
// 构建产物，recovery 时自动清理而不是 fail-closed（用户批准 2026-08-16）。
const SYSTEM_METADATA_BASENAME = '.DS_Store'
const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const TARGET_PATTERN = /^(?:aarch64|x86_64)-apple-darwin$/u
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.-]{0,63}$/u
const POINTER_SCHEMA = 'hexclaw.package-current.v2'
const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
const POINTER_MAX_BYTES = 64 * 1024
const HASH_CHUNK_BYTES = 1024 * 1024
const MAX_TREE_ENTRIES = 100_000
const MAX_TREE_BYTES = 8 * 1024 * 1024 * 1024
const STAGING_ROOT_BASENAME = '.package-local.generations'
const PUBLISHED_ROOT_BASENAME = '.package-local.published'
const CANDIDATE_BASENAME = 'release'
const CURRENT_POINTER_BASENAME = 'package-current.json'
const EXPECTED_GENERATION_ENTRIES = Object.freeze([
  'HexClaw.app',
  'dist',
  'package-result.json',
  'package.dmg',
  'release-manifest.json',
  'release-receipt.json',
  'source-manifest.json',
])
const layouts = new WeakSet()
const testAdapterState = new WeakMap()
const FAILURE_CHECKPOINTS = new Set([
  'after-current-commit',
  'before-current-commit',
  'cleanup',
  'file-fsync',
  'lstat',
  'mkdir',
  'parent-fsync',
  'rename',
  'write',
])
const TERMINATION_CHECKPOINTS = new Set(
  [
    'cleanup',
    'current-commit',
    'file-fsync',
    'lstat',
    'mkdir',
    'parent-fsync',
    'rename',
    'write',
  ].flatMap((name) => [`${name}:before`, `${name}:after`]),
)

export class PackagePublicationError extends Error {
  constructor(category) {
    super(`Package publication failed: category=${category}`)
    this.name = 'PackagePublicationError'
    this.category = category
  }
}

function fail(category) {
  throw new PackagePublicationError(category)
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function exactOptions(options, names) {
  if (!isPlainObject(options)) fail('invalid-options')
  const allowed = new Set(names)
  if (Object.keys(options).some((name) => !allowed.has(name))) fail('unknown-option')
}

function absolutePath(value, category) {
  if (typeof value !== 'string' || value.includes('\0') || !isAbsolute(value)) fail(category)
  return resolve(value)
}

function requireGenerationID(value) {
  if (typeof value !== 'string' || !GENERATION_ID_PATTERN.test(value)) {
    fail('invalid-generation')
  }
  return value
}

function requireSHA256(value, category) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) fail(category)
  return value
}

function requireLayout(value) {
  if (!isPlainObject(value) || !layouts.has(value)) fail('invalid-layout')
  return value
}

function requireTestAdapter(value) {
  if (value === undefined) return null
  if (!isPlainObject(value) || !testAdapterState.has(value)) fail('invalid-test-adapter')
  return value
}

function checkpoint(adapter, name) {
  if (adapter === null) return
  const state = testAdapterState.get(adapter)
  if (state.failAt === name && !state.triggered) {
    state.triggered = true
    fail(`injected-${name}`)
  }
  if (state.terminateAt === name && !state.triggered) {
    state.triggered = true
    process.kill(process.pid, 'SIGKILL')
    fail('test-termination')
  }
}

function canonicalJSON(value) {
  return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8')
}

function sameIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.uid === right.uid &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  )
}

function currentUID() {
  if (typeof process.getuid !== 'function') fail('unsupported-platform')
  return BigInt(process.getuid())
}

async function inspectDirectory(pathname, modePolicy, category) {
  const metadata = await lstat(pathname, { bigint: true }).catch(() => fail(category))
  const mode = Number(metadata.mode & 0o777n)
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== currentUID() ||
    (modePolicy === 'private' ? mode !== PRIVATE_DIRECTORY_MODE : (mode & 0o022) !== 0)
  ) {
    fail(category)
  }
  const canonical = await realpath(pathname).catch(() => fail(category))
  if (canonical !== pathname) fail(category)
  return metadata
}

async function inspectPublicRoot(pathname) {
  return inspectDirectory(pathname, 'trusted-public', 'public-root')
}

async function ensurePrivateDirectory(pathname, parent) {
  if (dirname(pathname) !== parent) fail('private-directory-path')
  await mkdir(pathname, { mode: PRIVATE_DIRECTORY_MODE }).catch((error) => {
    if (error?.code !== 'EEXIST') fail('private-directory')
  })
  await inspectDirectory(pathname, 'private', 'private-directory')
}

async function syncDirectory(pathname, category = 'directory-fsync') {
  let handle
  try {
    handle = await open(
      pathname,
      constants.O_RDONLY |
        constants.O_NOFOLLOW |
        (Number.isInteger(constants.O_DIRECTORY) ? constants.O_DIRECTORY : 0),
    )
    const metadata = await handle.stat({ bigint: true })
    if (!metadata.isDirectory()) fail(category)
    await handle.sync()
  } catch (error) {
    if (error instanceof PackagePublicationError) throw error
    fail(category)
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function hashAndSyncFile(pathname, expectedSize, category, shouldSync = true) {
  let handle
  try {
    handle = await open(pathname, constants.O_RDONLY | constants.O_NOFOLLOW)
    const before = await handle.stat({ bigint: true })
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.uid !== currentUID() ||
      (Number(before.mode & 0o777n) & 0o022) !== 0 ||
      before.size !== BigInt(expectedSize)
    ) {
      fail(category)
    }
    const digest = createHash('sha256')
    const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES)
    let offset = 0
    while (offset < expectedSize) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, expectedSize - offset),
        offset,
      )
      if (bytesRead <= 0) fail(category)
      digest.update(buffer.subarray(0, bytesRead))
      offset += bytesRead
    }
    const eof = await handle.read(buffer, 0, 1, expectedSize)
    if (eof.bytesRead !== 0) fail(category)
    if (shouldSync) await handle.sync()
    const after = await handle.stat({ bigint: true })
    if (!sameIdentity(before, after)) fail(category)
    return digest.digest('hex')
  } catch (error) {
    if (error instanceof PackagePublicationError) throw error
    fail(category)
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function inspectImmutableTree(root, shouldSync) {
  let entries = 0
  let bytes = 0
  const treeDigest = createHash('sha256')
  const visit = async (pathname, relativePath) => {
    entries += 1
    if (entries > MAX_TREE_ENTRIES) fail('generation-limit')
    const metadata = await lstat(pathname, { bigint: true }).catch(() => fail('generation-tree'))
    if (metadata.isSymbolicLink() || metadata.uid !== currentUID()) fail('generation-tree')
    if (metadata.isDirectory()) {
      if ((Number(metadata.mode & 0o777n) & 0o022) !== 0) fail('generation-tree')
      treeDigest.update(
        `${JSON.stringify({ mode: Number(metadata.mode & 0o777n), path: relativePath, type: 'directory' })}\n`,
        'utf8',
      )
      const children = await readdir(pathname)
      children.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
      for (const child of children) {
        const childPath = relativePath === '.' ? child : `${relativePath}/${child}`
        await visit(join(pathname, child), childPath)
      }
      if (shouldSync) await syncDirectory(pathname, 'generation-fsync')
      return
    }
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1n ||
      metadata.size > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      fail('generation-tree')
    }
    const size = Number(metadata.size)
    bytes += size
    if (!Number.isSafeInteger(bytes) || bytes > MAX_TREE_BYTES) fail('generation-limit')
    const sha256 = await hashAndSyncFile(pathname, size, 'generation-file', shouldSync)
    treeDigest.update(
      `${JSON.stringify({
        mode: Number(metadata.mode & 0o777n),
        path: relativePath,
        sha256,
        size,
        type: 'file',
      })}\n`,
      'utf8',
    )
  }
  await visit(root, '.')
  return Object.freeze({ bytes, entries, sha256: treeDigest.digest('hex') })
}

async function assertExactGenerationRoot(pathname) {
  await inspectDirectory(pathname, 'private', 'generation-root')
  const names = await readdir(pathname).catch(() => fail('generation-root'))
  names.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
  if (
    names.length !== EXPECTED_GENERATION_ENTRIES.length ||
    names.some((name, index) => name !== EXPECTED_GENERATION_ENTRIES[index])
  ) {
    fail('generation-entries')
  }
}

async function secureFileSHA256(pathname, maxBytes, category) {
  const metadata = await lstat(pathname, { bigint: true }).catch(() => fail(category))
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1n ||
    metadata.size > BigInt(maxBytes) ||
    metadata.size > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    fail(category)
  }
  return hashAndSyncFile(pathname, Number(metadata.size), category)
}

async function readSecurePointer(pathname) {
  const metadata = await lstat(pathname, { bigint: true }).catch(() => fail('current-pointer'))
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1n ||
    metadata.uid !== currentUID() ||
    Number(metadata.mode & 0o777n) !== PRIVATE_FILE_MODE ||
    metadata.size <= 0n ||
    metadata.size > BigInt(POINTER_MAX_BYTES)
  ) {
    fail('current-pointer')
  }
  let handle
  try {
    handle = await open(pathname, constants.O_RDONLY | constants.O_NOFOLLOW)
    const before = await handle.stat({ bigint: true })
    if (!sameIdentity(metadata, before)) fail('current-pointer')
    const bytes = Buffer.alloc(Number(before.size))
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (bytesRead <= 0) fail('current-pointer')
      offset += bytesRead
    }
    const after = await handle.stat({ bigint: true })
    if (!sameIdentity(before, after)) fail('current-pointer')
    return bytes
  } catch (error) {
    if (error instanceof PackagePublicationError) throw error
    fail('current-pointer')
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

/** 计算唯一 staging、immutable generation 与 current pointer 路径。 */
export function createPackagePublicationLayout(options) {
  exactOptions(options, ['generationId', 'releaseRoot'])
  const releaseRoot = absolutePath(options.releaseRoot, 'invalid-release-root')
  const generationId = requireGenerationID(options.generationId)
  const stagingRoot = join(releaseRoot, STAGING_ROOT_BASENAME)
  const stagingGenerationRoot = join(stagingRoot, generationId)
  const candidateRoot = join(stagingGenerationRoot, CANDIDATE_BASENAME)
  const publishedRoot = join(releaseRoot, PUBLISHED_ROOT_BASENAME)
  const publishedGenerationRoot = join(publishedRoot, generationId)
  const fixed = (root) =>
    Object.freeze({
      appBundle: join(root, 'HexClaw.app'),
      distRoot: join(root, 'dist'),
      manifestPath: join(root, 'release-manifest.json'),
      packagePath: join(root, 'package.dmg'),
      receiptPath: join(root, 'release-receipt.json'),
      resultPath: join(root, 'package-result.json'),
      sourceManifestPath: join(root, 'source-manifest.json'),
    })
  const candidate = fixed(candidateRoot)
  const published = fixed(publishedGenerationRoot)
  const layout = Object.freeze({
    ...candidate,
    candidateRoot,
    currentPointerPath: join(releaseRoot, CURRENT_POINTER_BASENAME),
    generationId,
    published,
    publishedGenerationRoot,
    publishedRoot,
    releaseRoot,
    stagingGenerationRoot,
    stagingRoot,
  })
  layouts.add(layout)
  return layout
}

/** 将完整且已 fsync 的候选目录一次性发布为不可变 generation。 */
export async function publishPackageGeneration(options, suppliedTestAdapter) {
  exactOptions(options, ['layout'])
  const layout = requireLayout(options.layout)
  const testAdapter = requireTestAdapter(suppliedTestAdapter)
  checkpoint(testAdapter, 'lstat')
  checkpoint(testAdapter, 'lstat:before')
  await inspectPublicRoot(layout.releaseRoot)
  checkpoint(testAdapter, 'lstat:after')
  await inspectDirectory(layout.stagingRoot, 'private', 'staging-root')
  await inspectDirectory(layout.stagingGenerationRoot, 'private', 'staging-generation')
  await assertExactGenerationRoot(layout.candidateRoot)
  checkpoint(testAdapter, 'mkdir')
  checkpoint(testAdapter, 'mkdir:before')
  await ensurePrivateDirectory(layout.publishedRoot, layout.releaseRoot)
  checkpoint(testAdapter, 'mkdir:after')
  const exists = await lstat(layout.publishedGenerationRoot).then(
    () => true,
    (error) => {
      if (error?.code === 'ENOENT') return false
      fail('published-generation')
    },
  )
  if (exists) fail('published-generation-exists')
  checkpoint(testAdapter, 'file-fsync')
  checkpoint(testAdapter, 'file-fsync:before')
  const generationIdentity = await inspectImmutableTree(layout.candidateRoot, true)
  checkpoint(testAdapter, 'file-fsync:after')
  checkpoint(testAdapter, 'rename')
  checkpoint(testAdapter, 'rename:before')
  await rename(layout.candidateRoot, layout.publishedGenerationRoot).catch(() =>
    fail('generation-rename'),
  )
  checkpoint(testAdapter, 'rename:after')
  checkpoint(testAdapter, 'parent-fsync')
  checkpoint(testAdapter, 'parent-fsync:before')
  await syncDirectory(layout.publishedRoot, 'generation-parent-fsync')
  checkpoint(testAdapter, 'parent-fsync:after')
  await assertExactGenerationRoot(layout.publishedGenerationRoot)
  return Object.freeze({
    generationId: layout.generationId,
    generationSHA256: generationIdentity.sha256,
  })
}

/** current pointer 的原子替换是唯一发布提交点。 */
export async function commitPackageGeneration(options, suppliedTestAdapter) {
  exactOptions(options, [
    'layout',
    'generationSHA256',
    'receiptSHA256',
    'releaseVersion',
    'sourceManifestSHA256',
    'targetTriple',
  ])
  const layout = requireLayout(options.layout)
  const testAdapter = requireTestAdapter(suppliedTestAdapter)
  const receiptSHA256 = requireSHA256(options.receiptSHA256, 'receipt-digest')
  const generationSHA256 = requireSHA256(options.generationSHA256, 'generation-digest')
  const sourceManifestSHA256 = requireSHA256(options.sourceManifestSHA256, 'source-manifest-digest')
  if (!TARGET_PATTERN.test(options.targetTriple ?? '')) fail('target-triple')
  if (!VERSION_PATTERN.test(options.releaseVersion ?? '')) fail('release-version')
  await inspectPublicRoot(layout.releaseRoot)
  await assertExactGenerationRoot(layout.publishedGenerationRoot)
  const generationIdentity = await inspectImmutableTree(layout.publishedGenerationRoot, false)
  if (
    generationIdentity.sha256 !== generationSHA256 ||
    (await secureFileSHA256(layout.published.receiptPath, POINTER_MAX_BYTES, 'receipt-digest')) !==
      receiptSHA256 ||
    (await secureFileSHA256(
      layout.published.sourceManifestPath,
      64 * 1024 * 1024,
      'source-manifest-digest',
    )) !== sourceManifestSHA256
  ) {
    fail('generation-identity')
  }
  const pointer = Object.freeze({
    generation_id: layout.generationId,
    generation_sha256: generationSHA256,
    receipt_sha256: receiptSHA256,
    release_version: options.releaseVersion,
    schema_version: POINTER_SCHEMA,
    source_manifest_sha256: sourceManifestSHA256,
    target_triple: options.targetTriple,
  })
  const bytes = canonicalJSON(pointer)
  const temporaryPath = join(
    layout.releaseRoot,
    `.${CURRENT_POINTER_BASENAME}.tmp-${process.pid}-${randomBytes(12).toString('hex')}`,
  )
  let handle
  try {
    checkpoint(testAdapter, 'write')
    checkpoint(testAdapter, 'write:before')
    handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      PRIVATE_FILE_MODE,
    )
    await handle.writeFile(bytes)
    checkpoint(testAdapter, 'write:after')
    checkpoint(testAdapter, 'file-fsync')
    checkpoint(testAdapter, 'file-fsync:before')
    await handle.sync()
    checkpoint(testAdapter, 'file-fsync:after')
    await handle.close()
    handle = null
    checkpoint(testAdapter, 'before-current-commit')
    checkpoint(testAdapter, 'current-commit:before')
    await rename(temporaryPath, layout.currentPointerPath)
    checkpoint(testAdapter, 'parent-fsync')
    await syncDirectory(layout.releaseRoot, 'current-parent-fsync')
    checkpoint(testAdapter, 'current-commit:after')
    checkpoint(testAdapter, 'after-current-commit')
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await unlink(temporaryPath).catch(() => undefined)
    if (error instanceof PackagePublicationError) throw error
    fail('current-commit')
  }
  return Object.freeze({ generationId: layout.generationId, pointer })
}

/** 测试适配器只允许在真实临时文件系统操作前后注入一次稳定失败。 */
export function createPackagePublicationTestAdapter(options) {
  exactOptions(options, ['failAt', 'terminateAt'])
  const hasFailure = options.failAt !== undefined
  const hasTermination = options.terminateAt !== undefined
  if (
    hasFailure === hasTermination ||
    (hasFailure && !FAILURE_CHECKPOINTS.has(options.failAt)) ||
    (hasTermination && !TERMINATION_CHECKPOINTS.has(options.terminateAt))
  ) {
    fail('invalid-test-adapter')
  }
  const adapter = Object.freeze({})
  testAdapterState.set(adapter, {
    failAt: options.failAt,
    terminateAt: options.terminateAt,
    triggered: false,
  })
  return adapter
}

function parsePointer(bytes, expected = null) {
  let pointer
  try {
    pointer = JSON.parse(bytes.toString('utf8'))
  } catch {
    fail('current-pointer')
  }
  if (
    !isPlainObject(pointer) ||
    Object.keys(pointer).sort().join(',') !==
      'generation_id,generation_sha256,receipt_sha256,release_version,schema_version,source_manifest_sha256,target_triple' ||
    pointer.schema_version !== POINTER_SCHEMA ||
    !VERSION_PATTERN.test(pointer.release_version ?? '') ||
    !TARGET_PATTERN.test(pointer.target_triple ?? '') ||
    (expected !== null &&
      (pointer.release_version !== expected.releaseVersion ||
        pointer.target_triple !== expected.targetTriple))
  ) {
    fail('current-pointer')
  }
  requireGenerationID(pointer.generation_id)
  requireSHA256(pointer.generation_sha256, 'current-pointer')
  requireSHA256(pointer.receipt_sha256, 'current-pointer')
  requireSHA256(pointer.source_manifest_sha256, 'current-pointer')
  if (!canonicalJSON(pointer).equals(bytes)) fail('current-pointer')
  return Object.freeze(pointer)
}

async function currentPointerIfPresent(releaseRoot) {
  const pathname = join(releaseRoot, CURRENT_POINTER_BASENAME)
  const exists = await lstat(pathname).then(
    () => true,
    (error) => {
      if (error?.code === 'ENOENT') return false
      fail('current-pointer')
    },
  )
  if (!exists) return null
  return parsePointer(await readSecurePointer(pathname))
}

async function removePrivateGeneration(pathname, parent, testAdapter) {
  if (dirname(pathname) !== parent || !GENERATION_ID_PATTERN.test(basename(pathname))) {
    fail('cleanup-path')
  }
  const metadata = await lstat(pathname, { bigint: true }).catch(() => fail('cleanup-path'))
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== currentUID() ||
    Number(metadata.mode & 0o777n) !== PRIVATE_DIRECTORY_MODE
  ) {
    fail('cleanup-path')
  }
  checkpoint(testAdapter, 'cleanup')
  checkpoint(testAdapter, 'cleanup:before')
  await rm(pathname, { force: false, recursive: true }).catch(() => fail('cleanup'))
  const remains = await lstat(pathname).then(
    () => true,
    (error) => {
      if (error?.code === 'ENOENT') return false
      fail('cleanup')
    },
  )
  if (remains) fail('cleanup')
  await syncDirectory(parent, 'cleanup-parent-fsync')
  checkpoint(testAdapter, 'cleanup:after')
}

async function removeSystemMetadata(pathname, parent, testAdapter) {
  if (dirname(pathname) !== parent) fail('cleanup-path')
  const metadata = await lstat(pathname, { bigint: true }).catch(() => fail('cleanup-path'))
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== currentUID() ||
    Number(metadata.mode & 0o777n) !== 0o644
  ) {
    fail('cleanup-path')
  }
  checkpoint(testAdapter, 'cleanup')
  await unlink(pathname).catch(() => fail('cleanup'))
}

/** 持锁启动时回收未提交 staging 与 orphan generation，绝不删除 current generation。 */
export async function recoverPackagePublication(options, suppliedTestAdapter) {
  exactOptions(options, ['activeGenerationId', 'releaseRoot'])
  const releaseRoot = absolutePath(options.releaseRoot, 'invalid-release-root')
  const activeGenerationId =
    options.activeGenerationId === undefined
      ? null
      : requireGenerationID(options.activeGenerationId)
  const testAdapter = requireTestAdapter(suppliedTestAdapter)
  checkpoint(testAdapter, 'lstat')
  await inspectPublicRoot(releaseRoot)
  const stagingRoot = join(releaseRoot, STAGING_ROOT_BASENAME)
  const publishedRoot = join(releaseRoot, PUBLISHED_ROOT_BASENAME)
  checkpoint(testAdapter, 'mkdir')
  await ensurePrivateDirectory(stagingRoot, releaseRoot)
  await ensurePrivateDirectory(publishedRoot, releaseRoot)
  const current = await currentPointerIfPresent(releaseRoot)

  let removedTemporaryPointer = false
  const releaseEntries = await readdir(releaseRoot).catch(() => fail('cleanup'))
  for (const name of releaseEntries) {
    if (!/^\.package-current\.json\.tmp-[0-9]+-[a-f0-9]{24}$/u.test(name)) continue
    const pathname = join(releaseRoot, name)
    const metadata = await lstat(pathname, { bigint: true }).catch(() => fail('cleanup-path'))
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.nlink !== 1n ||
      metadata.uid !== currentUID() ||
      Number(metadata.mode & 0o777n) !== PRIVATE_FILE_MODE
    ) {
      fail('cleanup-path')
    }
    await unlink(pathname).catch(() => fail('cleanup'))
    removedTemporaryPointer = true
  }
  if (removedTemporaryPointer) await syncDirectory(releaseRoot, 'cleanup-parent-fsync')

  const stagingNames = await readdir(stagingRoot).catch(() => fail('cleanup'))
  for (const name of stagingNames) {
    if (name === SYSTEM_METADATA_BASENAME) {
      await removeSystemMetadata(join(stagingRoot, name), stagingRoot, testAdapter)
      continue
    }
    if (!GENERATION_ID_PATTERN.test(name)) fail('cleanup-path')
    if (name !== activeGenerationId) {
      await removePrivateGeneration(join(stagingRoot, name), stagingRoot, testAdapter)
    }
  }
  const publishedNames = await readdir(publishedRoot).catch(() => fail('cleanup'))
  for (const name of publishedNames) {
    if (name === SYSTEM_METADATA_BASENAME) {
      await removeSystemMetadata(join(publishedRoot, name), publishedRoot, testAdapter)
      continue
    }
    if (!GENERATION_ID_PATTERN.test(name)) fail('cleanup-path')
    if (name !== current?.generation_id) {
      await removePrivateGeneration(join(publishedRoot, name), publishedRoot, testAdapter)
    }
  }
  return Object.freeze({
    activeGenerationId,
    currentGenerationId: current?.generation_id ?? null,
  })
}

/** current 提交后可回收本轮非发布构建目录；失败由下次持锁恢复继续处理。 */
export async function cleanupPackageStaging(options, suppliedTestAdapter) {
  exactOptions(options, ['layout'])
  const layout = requireLayout(options.layout)
  const testAdapter = requireTestAdapter(suppliedTestAdapter)
  const exists = await lstat(layout.stagingGenerationRoot).then(
    () => true,
    (error) => {
      if (error?.code === 'ENOENT') return false
      fail('cleanup')
    },
  )
  if (!exists) return Object.freeze({ removed: false })
  await removePrivateGeneration(layout.stagingGenerationRoot, layout.stagingRoot, testAdapter)
  return Object.freeze({ removed: true })
}

/** 消费者仅通过 current pointer 解析同一不可变 generation。 */
export async function resolveCurrentPackageGeneration(options) {
  exactOptions(options, ['releaseRoot', 'releaseVersion', 'targetTriple'])
  const releaseRoot = absolutePath(options.releaseRoot, 'invalid-release-root')
  if (!TARGET_PATTERN.test(options.targetTriple ?? '')) fail('target-triple')
  if (!VERSION_PATTERN.test(options.releaseVersion ?? '')) fail('release-version')
  await inspectPublicRoot(releaseRoot)
  const pointerPath = join(releaseRoot, CURRENT_POINTER_BASENAME)
  const bytes = await readSecurePointer(pointerPath)
  const pointer = parsePointer(bytes, options)
  const layout = createPackagePublicationLayout({
    generationId: pointer.generation_id,
    releaseRoot,
  })
  await assertExactGenerationRoot(layout.publishedGenerationRoot)
  const generationIdentity = await inspectImmutableTree(layout.publishedGenerationRoot, false)
  const [receiptSHA256, sourceManifestSHA256] = await Promise.all([
    secureFileSHA256(layout.published.receiptPath, POINTER_MAX_BYTES, 'current-pointer'),
    secureFileSHA256(layout.published.sourceManifestPath, 64 * 1024 * 1024, 'current-pointer'),
  ])
  if (
    generationIdentity.sha256 !== pointer.generation_sha256 ||
    receiptSHA256 !== pointer.receipt_sha256 ||
    sourceManifestSHA256 !== pointer.source_manifest_sha256
  ) {
    fail('current-pointer')
  }
  return Object.freeze({
    ...layout.published,
    generationId: layout.generationId,
    generationRoot: layout.publishedGenerationRoot,
    generationSHA256: generationIdentity.sha256,
    pointer: Object.freeze(pointer),
    pointerPath,
    receiptSHA256,
    sourceManifestSHA256,
  })
}

export const PACKAGE_PUBLICATION_PATHS = Object.freeze({
  currentPointerBasename: CURRENT_POINTER_BASENAME,
  publishedRootBasename: PUBLISHED_ROOT_BASENAME,
  stagingRootBasename: STAGING_ROOT_BASENAME,
})
