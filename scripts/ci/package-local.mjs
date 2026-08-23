#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import {
  cp,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  symlink,
  unlink,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { createGunzip } from 'node:zlib'

import { createReleaseAttestation } from './k12-release-ui-attestation.mjs'
import {
  PackageDependencyProvenanceError,
  preparePackageDependencyProvenance,
  verifyPackageDependencyProvenance,
} from './package-dependency-provenance.mjs'
import {
  consumePackageGenerationCapability,
  PACKAGE_GENERATION_CONTROL_BASENAME,
  PACKAGE_GENERATION_LOCK_BASENAME,
  PACKAGE_GENERATION_PLAN_PARENT_BASENAME,
  PACKAGE_GENERATION_TOMBSTONE_BASENAME,
  PackageGenerationLockError,
  runWithPackageGenerationLock,
} from './package-generation-lock.mjs'
import {
  cleanupPackageStaging,
  commitPackageGeneration,
  createPackagePublicationLayout,
  PackagePublicationError,
  publishPackageGeneration,
  recoverPackagePublication,
  resolveCurrentPackageGeneration,
} from './package-generation-publication.mjs'
import {
  createPackageSourceManifest,
  verifyPackageSourceManifest,
} from './package-source-identity.mjs'
import { BoundedProcessError, runBoundedProcess } from './run-bounded-process.mjs'
import * as sidecarVerifier from './verify-sidecar-version.mjs'
import { verifyPackageLocal } from './verify-package-local.mjs'

const GENERATION_ID_PATTERN = /^[a-f0-9]{32}$/u
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.-]{0,63}$/u
const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
const SOURCE_MANIFEST_MAX_BYTES = 64 * 1024 * 1024
const RESULT_MAX_BYTES = 64 * 1024
const FILE_HASH_CHUNK_BYTES = 1024 * 1024
const DEFAULT_COMMAND_TIMEOUT_MS = 20 * 60 * 1_000
const BUILD_COMMAND_TIMEOUT_MS = 55 * 60 * 1_000
const DEFAULT_COMMAND_OUTPUT_BYTES = 16 * 1024 * 1024
const OLLAMA_ARCHIVE_MAX_ENTRIES = 4096
const OLLAMA_EXPANDED_MAX_BYTES = 2 * 1024 * 1024 * 1024
const OLLAMA_MEMBER_MAX_BYTES = 1024 * 1024 * 1024
const OLLAMA_APPLEDOUBLE_MAX_BYTES = 64 * 1024
const OLLAMA_PAX_MAX_BYTES = 64 * 1024
const OLLAMA_PAX_XATTR_NAMES = Object.freeze(['CodeSignature', 'CodeRequirements', 'CodeDirectory'])
const OLLAMA_APPLEDOUBLE_CONTRACTS = Object.freeze({
  'mlx_metal_v3/._mlx.metallib': Object.freeze({
    // v0.32.13 固定归档的 v3 AppleDouble payload 为 9661 字节，必须与归档摘要逐字节一致。
    bytes: 9661,
    sha256: '2bed0f3fa16d3c54a1b187e3314ebf45ba190827e6a4871c725c4f6eda730b6f',
  }),
  'mlx_metal_v4/._mlx.metallib': Object.freeze({
    bytes: 9662,
    // 同一固定归档的 v4 AppleDouble payload 摘要也独立绑定，避免不同版本元数据混入。
    sha256: '3f5ef8ab2637186bc7565967f04a19dffe090ee7ecc5b184997bf7ffb8cd58b1',
  }),
})
const PROJECTED_SOURCE_MAX_ENTRIES = 100_000
const PROJECTED_SOURCE_MAX_BYTES = 8 * 1024 * 1024 * 1024
const FRONTEND_TYPECHECK_CACHE_FILES = Object.freeze([
  'tsconfig.app.tsbuildinfo',
  'tsconfig.node.tsbuildinfo',
  'tsconfig.vitest.tsbuildinfo',
])
const FRONTEND_VITE_CACHE_DIRECTORY = '.vite-temp'
const PACKAGE_RESULT_SCHEMA = 'hexclaw.package-local-result.v1'
const MODULE_PATH = fileURLToPath(import.meta.url)
const DESKTOP_ROOT = resolve(dirname(MODULE_PATH), '..', '..')
const SENSITIVE_BOUNDARY_PATH = join(
  DESKTOP_ROOT,
  'scripts',
  'ci',
  'package-sensitive-boundary.mjs',
)
const RENDER_BUNDLE_PATH = join(DESKTOP_ROOT, 'release', 'scripts', 'render-bundle.sh')

const FIXED_TOOLS = Object.freeze({
  bash: '/bin/bash',
  curl: '/usr/bin/curl',
  ditto: '/usr/bin/ditto',
  hdiutil: '/usr/bin/hdiutil',
  cp: '/bin/cp',
})

const TARGETS = Object.freeze({
  'aarch64-apple-darwin': Object.freeze({
    dmgArchitecture: 'aarch64',
    goarch: 'arm64',
    goos: 'darwin',
    nodeArchitecture: 'arm64',
    renderTarget: 'darwin-arm64',
    triple: 'aarch64-apple-darwin',
  }),
  'x86_64-apple-darwin': Object.freeze({
    dmgArchitecture: 'x64',
    goarch: 'amd64',
    goos: 'darwin',
    nodeArchitecture: 'x64',
    renderTarget: 'darwin-x86_64',
    triple: 'x86_64-apple-darwin',
  }),
})

const PACKAGE_REPOSITORY_IDS = Object.freeze([
  'toolkit',
  'ai-core',
  'hexagon',
  'hexclaw',
  'hexclaw-desktop',
])
const PACKAGE_GO_MODULES = Object.freeze([
  Object.freeze({ module: 'github.com/hexagon-codes/toolkit', repository: 'toolkit' }),
  Object.freeze({ module: 'github.com/hexagon-codes/ai-core', repository: 'ai-core' }),
  Object.freeze({ module: 'github.com/hexagon-codes/hexagon', repository: 'hexagon' }),
  Object.freeze({ module: 'github.com/hexagon-codes/hexclaw', repository: 'hexclaw' }),
])

const PIPELINE_OPERATION_NAMES = Object.freeze([
  'createSourceManifest',
  'cleanupToolchains',
  'projectDesktopSource',
  'prepareFrontendDependencies',
  'verifyGoDependencies',
  'buildSidecar',
  'verifySidecar',
  'stageRenderBundle',
  'stageOllama',
  'verifyOllama',
  'buildFrontend',
  'prepareCargoDependencies',
  'buildTauriApp',
  'verifyAppResources',
  'stageReleaseApp',
  'verifySourceManifest',
  'sanitizeAndVerify',
  'createDmg',
  'createAttestation',
  'writeBuildResult',
  'verifyStagedPackage',
  'cleanupStaging',
])

export class PackageLocalError extends Error {
  constructor(category, details = {}) {
    const fields = [`Package-local failed: category=${category}`]
    if (Number.isInteger(details.exitCode)) fields.push(`exit=${details.exitCode}`)
    if (typeof details.signal === 'string') fields.push(`signal=${details.signal}`)
    super(fields.join(' '))
    this.name = 'PackageLocalError'
    this.category = category
    this.exitCode = Number.isInteger(details.exitCode) ? details.exitCode : undefined
    this.signal = typeof details.signal === 'string' ? details.signal : undefined
  }
}

function fail(category, details) {
  throw new PackageLocalError(category, details)
}

/** Ollama 身份只能来自二进制验证模块的唯一生产合同。 */
export function getOllamaPackageContract() {
  return validateOllamaContract(sidecarVerifier.OLLAMA_PACKAGE_CONTRACT)
}

/** 将依赖安装绑定到本轮投影源码与 source manifest 记录的工具链。 */
export function createDependencyProvenanceOptions(plan, toolchains, sourceManifestSHA256) {
  if (
    !isPlainObject(plan) ||
    !isPlainObject(plan.paths) ||
    !isPlainObject(toolchains) ||
    !isPlainObject(toolchains.go) ||
    !isPlainObject(toolchains.node) ||
    !isPlainObject(toolchains.pnpm) ||
    !isAbsolute(toolchains.go.canonical ?? '') ||
    !isAbsolute(toolchains.go.goroot ?? '') ||
    !isAbsolute(toolchains.node.canonical ?? '') ||
    !isAbsolute(toolchains.pnpm.canonical ?? '') ||
    !SHA256_PATTERN.test(toolchains.go.executableSha256 ?? '') ||
    !SHA256_PATTERN.test(toolchains.node.executableSha256 ?? '') ||
    !SHA256_PATTERN.test(toolchains.pnpm.executableSha256 ?? '') ||
    !SHA256_PATTERN.test(sourceManifestSHA256 ?? '') ||
    [toolchains.go, toolchains.node, toolchains.pnpm].some(
      (tool) =>
        typeof tool.version !== 'string' ||
        tool.version.length === 0 ||
        /[\u0000-\u001f\u007f]/u.test(tool.version),
    )
  ) {
    fail('dependency-provenance-options')
  }
  const hasGoSourceBinding =
    toolchains.go.sourceCanonical !== undefined || toolchains.go.sourceSha256 !== undefined
  if (
    hasGoSourceBinding &&
    (!isAbsolute(toolchains.go.sourceCanonical ?? '') ||
      !SHA256_PATTERN.test(toolchains.go.sourceSha256 ?? '') ||
      toolchains.go.sourceCanonical !== join(toolchains.go.goroot, 'bin', 'go'))
  ) {
    fail('dependency-provenance-options')
  }
  const pnpmStandalone = Array.isArray(toolchains.pnpm.supportFiles)
    ? toolchains.pnpm.supportFiles.find((file) => file?.path === 'dist/pnpm.cjs')
    : undefined
  const pnpmWorker = Array.isArray(toolchains.pnpm.supportFiles)
    ? toolchains.pnpm.supportFiles.find((file) => file?.path === 'dist/worker.js')
    : undefined
  const pnpmPackage = Array.isArray(toolchains.pnpm.supportFiles)
    ? toolchains.pnpm.supportFiles.find((file) => file?.path === 'package.json')
    : undefined
  const pnpmWorkerNative = Array.isArray(toolchains.pnpm.supportFiles)
    ? toolchains.pnpm.supportFiles.filter((file) =>
        new RegExp(`^dist/reflink\\.darwin-${process.arch}-[A-Za-z0-9]+\\.node$`, 'u').test(
          file?.path ?? '',
        ),
      )
    : []
  if (
    pnpmStandalone !== undefined &&
    (!isAbsolute(pnpmStandalone.canonical ?? '') ||
      !SHA256_PATTERN.test(pnpmStandalone.executableSha256 ?? ''))
  ) {
    fail('dependency-provenance-options')
  }
  if (
    pnpmWorker !== undefined &&
    (!isAbsolute(pnpmWorker.canonical ?? '') ||
      !SHA256_PATTERN.test(pnpmWorker.executableSha256 ?? ''))
  ) {
    fail('dependency-provenance-options')
  }
  if (
    pnpmWorker !== undefined &&
    (pnpmPackage === undefined ||
      !isAbsolute(pnpmPackage.canonical ?? '') ||
      !SHA256_PATTERN.test(pnpmPackage.executableSha256 ?? '') ||
      pnpmWorkerNative.length !== 1 ||
      !isAbsolute(pnpmWorkerNative[0].canonical ?? '') ||
      !SHA256_PATTERN.test(pnpmWorkerNative[0].executableSha256 ?? ''))
  ) {
    fail('dependency-provenance-options')
  }
  return Object.freeze({
    cacheRoot: plan.paths.cacheRoot,
    generationRoot: plan.paths.generationRoot,
    go: Object.freeze({
      executable: hasGoSourceBinding ? toolchains.go.sourceCanonical : toolchains.go.canonical,
      goWork: plan.paths.projectedGoWork,
      goroot: toolchains.go.goroot,
      moduleRoots: plan.paths.projectedGoModuleRoots,
      sha256: hasGoSourceBinding ? toolchains.go.sourceSha256 : toolchains.go.executableSha256,
      version: toolchains.go.version,
    }),
    node: Object.freeze({
      executable: toolchains.node.canonical,
      sha256: toolchains.node.executableSha256,
      version: toolchains.node.version,
    }),
    pnpm: Object.freeze({
      executable: pnpmStandalone?.canonical ?? toolchains.pnpm.canonical,
      sha256: pnpmStandalone?.executableSha256 ?? toolchains.pnpm.executableSha256,
      version: toolchains.pnpm.version,
      ...(pnpmWorker
        ? {
            packageExecutable: pnpmPackage.canonical,
            packageSha256: pnpmPackage.executableSha256,
            workerExecutable: pnpmWorker.canonical,
            workerNativeExecutable: pnpmWorkerNative[0].canonical,
            workerNativeName: basename(pnpmWorkerNative[0].canonical),
            workerNativeSha256: pnpmWorkerNative[0].executableSha256,
            workerSha256: pnpmWorker.executableSha256,
          }
        : {}),
    }),
    sourceManifest: Object.freeze({ sha256: sourceManifestSHA256 }),
    sourceRoot: plan.paths.projectedDesktopRoot,
  })
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
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\0') ||
    !isAbsolute(value)
  ) {
    fail(category)
  }
  return resolve(value)
}

function metadataIdentity(metadata) {
  return Object.freeze({
    ctimeNs: metadata.ctimeNs,
    dev: metadata.dev,
    ino: metadata.ino,
    mode: metadata.mode,
    mtimeNs: metadata.mtimeNs,
    nlink: metadata.nlink,
    size: metadata.size,
    uid: metadata.uid,
  })
}

function sameMetadataIdentity(left, right) {
  return (
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

function normalizedRelativePath(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\0') ||
    value.includes('\\') ||
    value.startsWith('/')
  ) {
    fail('source-projection-path')
  }
  const components = value.split('/')
  if (components.some((component) => component === '' || component === '.' || component === '..')) {
    fail('source-projection-path')
  }
  return value
}

function manifestFileMode(value) {
  if (typeof value !== 'string' || !/^100[0-7]{3}$/u.test(value)) {
    fail('source-projection-mode')
  }
  const mode = Number.parseInt(value.slice(3), 8)
  if ((mode & 0o022) !== 0) fail('source-projection-mode')
  return mode
}

async function assertPrivateDirectory(pathname) {
  const metadata = await lstat(pathname, { bigint: true }).catch(() => fail('directory-metadata'))
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    Number(metadata.mode & 0o777n) !== PRIVATE_DIRECTORY_MODE
  ) {
    fail('directory-security')
  }
  if (typeof process.getuid === 'function' && metadata.uid !== BigInt(process.getuid())) {
    fail('directory-owner')
  }
}

async function assertTrustedOwnedDirectory(pathname) {
  const metadata = await lstat(pathname, { bigint: true }).catch(() => fail('directory-metadata'))
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (Number(metadata.mode & 0o777n) & 0o022) !== 0
  ) {
    fail('directory-security')
  }
  if (typeof process.getuid === 'function' && metadata.uid !== BigInt(process.getuid())) {
    fail('directory-owner')
  }
  const canonical = await realpath(pathname).catch(() => fail('directory-metadata'))
  if (canonical !== pathname) fail('directory-security')
}

async function makePrivateDirectory(pathname, options = {}) {
  const existing = await lstat(pathname, { bigint: true }).catch((error) => {
    if (error?.code === 'ENOENT') return undefined
    fail('directory-metadata')
  })
  if (existing !== undefined) {
    await assertPrivateDirectory(pathname)
    return
  }
  await mkdir(pathname, {
    mode: PRIVATE_DIRECTORY_MODE,
    recursive: options.recursive === true,
  }).catch(() => fail('directory-create'))
  await assertPrivateDirectory(pathname)
}

async function copyManifestBoundFile(sourcePath, destinationPath, file) {
  if (
    !Number.isSafeInteger(file.size) ||
    file.size < 0 ||
    !SHA256_PATTERN.test(file.sha256 ?? '')
  ) {
    fail('source-projection-record')
  }
  const expectedMode = manifestFileMode(file.mode)
  const sourcePathMetadata = await lstat(sourcePath, { bigint: true }).catch(() =>
    fail('source-projection-source'),
  )
  if (
    !sourcePathMetadata.isFile() ||
    sourcePathMetadata.isSymbolicLink() ||
    sourcePathMetadata.nlink !== 1n ||
    sourcePathMetadata.size !== BigInt(file.size) ||
    Number(sourcePathMetadata.mode & 0o777n) !== expectedMode
  ) {
    fail('source-projection-source')
  }

  let source
  let destination
  try {
    source = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW)
    const sourceBefore = await source.stat({ bigint: true })
    if (
      !sourceBefore.isFile() ||
      sourceBefore.nlink !== 1n ||
      !sameMetadataIdentity(metadataIdentity(sourcePathMetadata), metadataIdentity(sourceBefore))
    ) {
      fail('source-projection-identity')
    }
    await makePrivateDirectory(dirname(destinationPath), { recursive: true })
    destination = await open(
      destinationPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      expectedMode,
    ).catch(() => fail('source-projection-destination'))

    const digest = createHash('sha256')
    const buffer = Buffer.allocUnsafe(FILE_HASH_CHUNK_BYTES)
    let offset = 0
    while (offset < file.size) {
      const bytesToRead = Math.min(buffer.length, file.size - offset)
      const { bytesRead } = await source.read(buffer, 0, bytesToRead, offset)
      if (bytesRead <= 0) fail('source-projection-identity')
      digest.update(buffer.subarray(0, bytesRead))
      let written = 0
      while (written < bytesRead) {
        const result = await destination.write(
          buffer,
          written,
          bytesRead - written,
          offset + written,
        )
        if (result.bytesWritten <= 0) fail('source-projection-write')
        written += result.bytesWritten
      }
      offset += bytesRead
    }
    const sourceAfter = await source.stat({ bigint: true })
    const sourcePathAfter = await lstat(sourcePath, { bigint: true }).catch(() =>
      fail('source-projection-identity'),
    )
    if (
      !sameMetadataIdentity(metadataIdentity(sourceBefore), metadataIdentity(sourceAfter)) ||
      !sameMetadataIdentity(metadataIdentity(sourceBefore), metadataIdentity(sourcePathAfter)) ||
      digest.digest('hex') !== file.sha256
    ) {
      fail('source-projection-identity')
    }
    await destination.chmod(expectedMode)
    await destination.sync()
    const destinationMetadata = await destination.stat({ bigint: true })
    if (
      !destinationMetadata.isFile() ||
      destinationMetadata.nlink !== 1n ||
      destinationMetadata.size !== BigInt(file.size) ||
      Number(destinationMetadata.mode & 0o777n) !== expectedMode
    ) {
      fail('source-projection-write')
    }
  } finally {
    await destination?.close().catch(() => undefined)
    await source?.close().catch(() => undefined)
  }
}

async function copyManifestRecords(sourceRoot, projectedRoot, files) {
  if (!Array.isArray(files)) fail('source-projection-manifest')
  const seen = new Set()
  let copiedBytes = 0
  let copiedFiles = 0
  for (const file of files) {
    if (!isPlainObject(file)) fail('source-projection-record')
    const path = normalizedRelativePath(file.path)
    if (seen.has(path)) fail('source-projection-record')
    seen.add(path)
    const sourcePath = join(sourceRoot, ...path.split('/'))
    const destinationPath = join(projectedRoot, ...path.split('/'))
    const sourceRelative = relative(sourceRoot, sourcePath)
    const destinationRelative = relative(projectedRoot, destinationPath)
    if (
      sourceRelative.startsWith(`..${sep}`) ||
      destinationRelative.startsWith(`..${sep}`) ||
      isAbsolute(sourceRelative) ||
      isAbsolute(destinationRelative)
    ) {
      fail('source-projection-path')
    }
    await copyManifestBoundFile(sourcePath, destinationPath, file)
    copiedBytes += file.size
    copiedFiles += 1
  }
  return { copiedBytes, copiedFiles }
}

/** 仅复制 source manifest 明确绑定的 Desktop 文件，不读取仓库 node_modules。 */
export async function projectDesktopSourceFromManifest(options) {
  exactOptions(options, ['desktopRoot', 'manifest', 'projectedRoot'])
  const desktopRoot = absolutePath(options.desktopRoot, 'source-projection-root')
  const projectedRoot = absolutePath(options.projectedRoot, 'source-projection-root')
  if (!isPlainObject(options.manifest) || !Array.isArray(options.manifest.repositories)) {
    fail('source-projection-manifest')
  }
  const repositories = options.manifest.repositories.filter(
    (repository) => repository?.id === 'hexclaw-desktop',
  )
  if (repositories.length !== 1) fail('source-projection-manifest')
  await makePrivateDirectory(dirname(projectedRoot), { recursive: true })
  await makePrivateDirectory(projectedRoot)
  return Object.freeze(await copyManifestRecords(desktopRoot, projectedRoot, repositories[0].files))
}

/** 将五仓与清单派生的专用 Go workspace 投影到唯一 generation。 */
export async function projectPackageSourceFromManifest(options) {
  exactOptions(options, ['manifest', 'projectedWorkRoot', 'sourceWorkRoot'])
  const sourceWorkRoot = absolutePath(options.sourceWorkRoot, 'source-projection-root')
  const projectedWorkRoot = absolutePath(options.projectedWorkRoot, 'source-projection-root')
  const { repositories } = packageProjectionManifest(options.manifest)

  await makePrivateDirectory(dirname(projectedWorkRoot), { recursive: true })
  await makePrivateDirectory(projectedWorkRoot)
  let copiedBytes = 0
  let copiedFiles = 0
  for (const repository of repositories) {
    const result = await copyManifestRecords(
      join(sourceWorkRoot, repository.id),
      join(projectedWorkRoot, repository.id),
      repository.files,
    )
    copiedBytes += result.copiedBytes
    copiedFiles += result.copiedFiles
  }
  const workspace = await packageWorkspace(options.manifest, projectedWorkRoot, repositories)
  await writePrivateFileExclusive(join(projectedWorkRoot, workspace.record.path), workspace.bytes)
  copiedBytes += workspace.record.size
  copiedFiles += 1
  return Object.freeze({ copiedBytes, copiedFiles })
}

function packageWorkspaceContract(manifest) {
  const modules = manifest.workspace?.modules
  const recordedModules = Array.isArray(modules)
    ? [...modules].sort((left, right) =>
        Buffer.compare(Buffer.from(left?.repository ?? ''), Buffer.from(right?.repository ?? '')),
      )
    : []
  const expectedModules = [...PACKAGE_GO_MODULES].sort((left, right) =>
    Buffer.compare(Buffer.from(left.repository), Buffer.from(right.repository)),
  )
  if (
    recordedModules.length !== expectedModules.length ||
    recordedModules.some(
      (entry, index) =>
        entry?.module !== expectedModules[index].module ||
        entry?.repository !== expectedModules[index].repository,
    )
  ) {
    fail('source-projection-workspace')
  }
  const localReplacements = manifest.workspace?.localReplacements
  const file = manifest.workspace?.file
  if (!Array.isArray(localReplacements) || !isPlainObject(file)) {
    fail('source-projection-workspace')
  }
  if (
    file.mode !== '100600' ||
    file.path !== 'go.work' ||
    !SHA256_PATTERN.test(file.sha256 ?? '') ||
    !Number.isSafeInteger(file.size) ||
    file.size <= 0 ||
    typeof manifest.workspace.goVersion !== 'string'
  ) {
    fail('source-projection-workspace')
  }
  const toolchainMatch = /^go(1\.[0-9]+(?:\.[0-9]+)?)$/u.exec(
    manifest.toolchains?.go?.env?.GOVERSION ?? '',
  )
  if (!toolchainMatch) fail('source-projection-workspace')
  return Object.freeze({
    file: Object.freeze({ ...file }),
    goVersion: manifest.workspace.goVersion,
    toolchainVersion: toolchainMatch[1],
  })
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

async function readProjectedGoModule(projectedWorkRoot, repository, expectedModule) {
  const records = repository.files.filter((file) => file?.path === 'go.mod')
  if (records.length !== 1) fail('source-projection-workspace')
  const record = records[0]
  if (
    !Number.isSafeInteger(record.size) ||
    record.size <= 0 ||
    record.size > 1024 * 1024 ||
    !SHA256_PATTERN.test(record.sha256 ?? '')
  ) {
    fail('source-projection-workspace')
  }
  const expectedMode = manifestFileMode(record.mode)
  const pathname = join(projectedWorkRoot, repository.id, 'go.mod')
  return withSecureRegularFile(pathname, record.size, async (handle, metadata) => {
    if (
      metadata.size !== BigInt(record.size) ||
      Number(metadata.mode & 0o777n) !== expectedMode ||
      (typeof process.getuid === 'function' && metadata.uid !== BigInt(process.getuid()))
    ) {
      fail('source-projection-workspace')
    }
    const bytes = Buffer.alloc(record.size)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (bytesRead <= 0) fail('source-projection-workspace')
      offset += bytesRead
    }
    if (createHash('sha256').update(bytes).digest('hex') !== record.sha256) {
      fail('source-projection-workspace')
    }
    const text = bytes.toString('utf8')
    if (!Buffer.from(text, 'utf8').equals(bytes)) fail('source-projection-workspace')
    const module = /^module[ \t]+([^\s]+)[ \t]*$/mu.exec(text)?.[1]
    const versions = [...text.matchAll(/^go[ \t]+(1\.[0-9]+(?:\.[0-9]+)?)[ \t]*$/gmu)]
    if (module !== expectedModule || versions.length !== 1) fail('source-projection-workspace')
    return versions[0][1]
  })
}

async function packageWorkspace(manifest, projectedWorkRoot, repositories) {
  const contract = packageWorkspaceContract(manifest)
  const versions = []
  for (const expected of PACKAGE_GO_MODULES) {
    const repository = repositories.find((candidate) => candidate.id === expected.repository)
    if (!repository) fail('source-projection-workspace')
    versions.push(await readProjectedGoModule(projectedWorkRoot, repository, expected.module))
  }
  const goVersion = versions.reduce((highest, candidate) =>
    compareGoVersions(candidate, highest) > 0 ? candidate : highest,
  )
  if (compareGoVersions(contract.toolchainVersion, goVersion) < 0) {
    fail('source-projection-workspace')
  }
  const bytes = Buffer.from(
    `go ${goVersion}\n\nuse (\n${PACKAGE_GO_MODULES.map(({ repository }) => `\t./${repository}\n`).join('')})\n`,
    'utf8',
  )
  if (
    contract.goVersion !== goVersion ||
    contract.file.size !== bytes.length ||
    contract.file.sha256 !== createHash('sha256').update(bytes).digest('hex')
  ) {
    fail('source-projection-workspace')
  }
  return Object.freeze({ bytes, record: contract.file })
}

function packageProjectionManifest(manifest) {
  if (
    !isPlainObject(manifest) ||
    !Array.isArray(manifest.repositories) ||
    !isPlainObject(manifest.workspace)
  ) {
    fail('source-projection-manifest')
  }
  packageWorkspaceContract(manifest)
  const expectedRepositories = [...PACKAGE_REPOSITORY_IDS].sort((left, right) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right)),
  )
  const repositories = [...manifest.repositories].sort((left, right) =>
    Buffer.compare(Buffer.from(left?.id ?? ''), Buffer.from(right?.id ?? '')),
  )
  if (
    repositories.length !== expectedRepositories.length ||
    repositories.some(
      (repository, index) =>
        repository?.id !== expectedRepositories[index] || !Array.isArray(repository.files),
    )
  ) {
    fail('source-projection-manifest')
  }
  return Object.freeze({
    repositories: Object.freeze(repositories),
  })
}

async function projectedSourceRecords(manifest, projectedWorkRoot) {
  const { repositories } = packageProjectionManifest(manifest)
  const workspace = await packageWorkspace(manifest, projectedWorkRoot, repositories)
  const records = new Map()
  const add = (prefix, files) => {
    for (const file of files) {
      if (!isPlainObject(file)) fail('source-projection-record')
      const relativePath = normalizedRelativePath(file.path)
      const path = prefix === '' ? relativePath : `${prefix}/${relativePath}`
      if (records.has(path)) fail('source-projection-record')
      manifestFileMode(file.mode)
      if (
        !Number.isSafeInteger(file.size) ||
        file.size < 0 ||
        !SHA256_PATTERN.test(file.sha256 ?? '')
      ) {
        fail('source-projection-record')
      }
      records.set(path, file)
    }
  }
  for (const repository of repositories) add(repository.id, repository.files)
  add('', [workspace.record])
  return records
}

/** 构建前后按同一 manifest 复核实际参与构建的 generation 投影源码。 */
export async function verifyProjectedPackageSourceFromManifest(options) {
  exactOptions(options, ['allowDependencyTree', 'manifest', 'projectedWorkRoot'])
  if (typeof options.allowDependencyTree !== 'boolean') fail('source-projection-options')
  const projectedWorkRoot = absolutePath(options.projectedWorkRoot, 'source-projection-root')
  const records = await projectedSourceRecords(options.manifest, projectedWorkRoot)
  const expectedDirectories = new Set(['.'])
  let expectedBytes = 0
  for (const [path, file] of records) {
    expectedBytes += file.size
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes > PROJECTED_SOURCE_MAX_BYTES) {
      fail('source-projection-limit')
    }
    const components = path.split('/')
    for (let index = 1; index < components.length; index += 1) {
      expectedDirectories.add(components.slice(0, index).join('/'))
    }
  }
  if (records.size > PROJECTED_SOURCE_MAX_ENTRIES) fail('source-projection-limit')

  const dependencyRoot = 'hexclaw-desktop/node_modules'
  const seen = new Set()
  let visitedEntries = 0
  let verifiedBytes = 0
  const visit = async (pathname, relativePath) => {
    visitedEntries += 1
    if (visitedEntries > PROJECTED_SOURCE_MAX_ENTRIES) fail('source-projection-limit')
    const metadata = await lstat(pathname, { bigint: true }).catch(() =>
      fail('source-projection-drift'),
    )
    if (metadata.isSymbolicLink()) fail('source-projection-drift')
    if (metadata.isDirectory()) {
      if (relativePath === dependencyRoot && options.allowDependencyTree) {
        if (
          Number(metadata.mode & 0o022n) !== 0 ||
          (typeof process.getuid === 'function' && metadata.uid !== BigInt(process.getuid()))
        ) {
          fail('source-projection-drift')
        }
        return
      }
      if (
        Number(metadata.mode & 0o777n) !== PRIVATE_DIRECTORY_MODE ||
        (typeof process.getuid === 'function' && metadata.uid !== BigInt(process.getuid()))
      ) {
        fail('source-projection-drift')
      }
      if (!expectedDirectories.has(relativePath)) fail('source-projection-drift')
      const children = await readdir(pathname)
      children.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
      for (const child of children) {
        await visit(
          join(pathname, child),
          relativePath === '.' ? child : `${relativePath}/${child}`,
        )
      }
      return
    }
    const record = records.get(relativePath)
    if (!record || !metadata.isFile() || metadata.nlink !== 1n) {
      fail('source-projection-drift')
    }
    const expectedMode = manifestFileMode(record.mode)
    if (
      metadata.size !== BigInt(record.size) ||
      Number(metadata.mode & 0o777n) !== expectedMode ||
      (typeof process.getuid === 'function' && metadata.uid !== BigInt(process.getuid()))
    ) {
      fail('source-projection-drift')
    }
    const digest = await secureFileSHA256(pathname, record.size)
    if (digest.size !== record.size || digest.sha256 !== record.sha256) {
      fail('source-projection-drift')
    }
    seen.add(relativePath)
    verifiedBytes += record.size
  }

  await visit(projectedWorkRoot, '.')
  if (seen.size !== records.size || verifiedBytes !== expectedBytes) {
    fail('source-projection-drift')
  }
  return Object.freeze({ verifiedBytes, verifiedFiles: seen.size })
}

async function withSecureRegularFile(pathname, maximumBytes, operation) {
  const pathMetadata = await lstat(pathname, { bigint: true }).catch(() => fail('file-open'))
  if (
    !pathMetadata.isFile() ||
    pathMetadata.isSymbolicLink() ||
    pathMetadata.nlink !== 1n ||
    pathMetadata.size < 0n ||
    pathMetadata.size > BigInt(maximumBytes)
  ) {
    fail('file-security')
  }
  let handle
  try {
    handle = await open(pathname, constants.O_RDONLY | constants.O_NOFOLLOW)
    const before = await handle.stat({ bigint: true })
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      !sameMetadataIdentity(metadataIdentity(pathMetadata), metadataIdentity(before))
    ) {
      fail('file-identity')
    }
    const result = await operation(handle, before)
    const after = await handle.stat({ bigint: true })
    const pathAfter = await lstat(pathname, { bigint: true }).catch(() => fail('file-identity'))
    if (
      !sameMetadataIdentity(metadataIdentity(before), metadataIdentity(after)) ||
      !sameMetadataIdentity(metadataIdentity(before), metadataIdentity(pathAfter))
    ) {
      fail('file-identity')
    }
    return result
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function secureFileSHA256(pathname, maximumBytes) {
  return withSecureRegularFile(pathname, maximumBytes, async (handle, metadata) => {
    const digest = createHash('sha256')
    const buffer = Buffer.allocUnsafe(FILE_HASH_CHUNK_BYTES)
    let offset = 0n
    while (offset < metadata.size) {
      const remaining = metadata.size - offset
      const length = Number(remaining > BigInt(buffer.length) ? BigInt(buffer.length) : remaining)
      const { bytesRead } = await handle.read(buffer, 0, length, Number(offset))
      if (bytesRead <= 0) fail('file-identity')
      digest.update(buffer.subarray(0, bytesRead))
      offset += BigInt(bytesRead)
    }
    return Object.freeze({
      sha256: digest.digest('hex'),
      size: Number(metadata.size),
    })
  })
}

async function readSecureFileBytes(pathname, maximumBytes) {
  return withSecureRegularFile(pathname, maximumBytes, async (handle, metadata) => {
    const bytes = Buffer.alloc(Number(metadata.size))
    let offset = 0
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (result.bytesRead <= 0) fail('file-identity')
      offset += result.bytesRead
    }
    return bytes
  })
}

function canonicalJSON(value) {
  const normalize = (item) => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item
    if (typeof item === 'number') {
      if (!Number.isSafeInteger(item)) fail('json-value')
      return item
    }
    if (Array.isArray(item)) return item.map(normalize)
    if (!isPlainObject(item)) fail('json-value')
    return Object.fromEntries(
      Object.keys(item)
        .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
        .map((name) => [name, normalize(item[name])]),
    )
  }
  return Buffer.from(`${JSON.stringify(normalize(value))}\n`, 'utf8')
}

async function writePrivateFileExclusive(pathname, bytes, mode = PRIVATE_FILE_MODE) {
  await makePrivateDirectory(dirname(pathname), { recursive: true })
  let handle
  try {
    handle = await open(
      pathname,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      mode,
    ).catch(() => fail('file-create'))
    await handle.writeFile(bytes)
    await handle.chmod(mode)
    await handle.sync()
    const metadata = await handle.stat({ bigint: true })
    if (!metadata.isFile() || metadata.nlink !== 1n || metadata.size !== BigInt(bytes.length)) {
      fail('file-create')
    }
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function trustedToolPath(plan) {
  const directories = [
    dirname(process.execPath),
    '/usr/local/go/bin',
    '/usr/local/bin',
    '/opt/homebrew/bin',
    join(plan.hostHome, '.cargo', 'bin'),
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ]
  return [...new Set(directories)].join(':')
}

function cleanEnvironment(plan, overrides = {}) {
  const environment = Object.assign(Object.create(null), {
    HOME: plan.paths.privateHome,
    LANG: 'C',
    LC_ALL: 'C',
    PATH: trustedToolPath(plan),
    TMPDIR: plan.paths.privateTemp,
  })
  for (const [name, value] of Object.entries(overrides)) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) ||
      typeof value !== 'string' ||
      name.includes('\0') ||
      value.includes('\0')
    ) {
      fail('environment')
    }
    environment[name] = value
  }
  return environment
}

function sourceIdentityEnvironment(plan) {
  return Object.assign(Object.create(null), {
    HOME: plan.hostHome,
    LANG: 'C',
    LC_ALL: 'C',
    PATH: trustedToolPath(plan),
    RUSTUP_HOME: join(plan.hostHome, '.rustup'),
    TMPDIR: plan.paths.privateTemp,
  })
}

export function classifySafePackageCommandError(stderr) {
  const boundary =
    /^ERROR: package-sensitive-boundary category=([a-z0-9]+(?::[a-z0-9-]+)*)(?: exit=-?[0-9]{1,3})?(?: signal=[A-Z0-9]{1,32})?\n$/u.exec(
      stderr,
    )
  if (boundary !== null && Buffer.byteLength(boundary[1], 'utf8') <= 80) {
    return `sensitive-boundary-${boundary[1].replaceAll(':', '-')}`
  }
  switch (stderr) {
    case 'ERROR: Typst dependency fetch failed.\n':
      return 'render-typst-dependency-fetch'
    case 'ERROR: Typst source build failed.\n':
      return 'render-typst-source-build'
    case 'ERROR: Typst executable architecture verification failed.\n':
      return 'render-typst-architecture'
    case 'ERROR: Typst executable sensitive-data scan failed.\n':
      return 'render-typst-sensitive-scan'
    case 'ERROR: Typst executable version verification failed.\n':
      return 'render-typst-version'
    default:
      return undefined
  }
}

export function classifyPackageDependencyError(error) {
  if (!(error instanceof PackageDependencyProvenanceError)) return undefined
  const category = error.category
  if (
    typeof category !== 'string' ||
    Buffer.byteLength(category, 'utf8') > 80 ||
    !/^[a-z0-9]+(?::[a-z0-9-]+)*$/u.test(category)
  ) {
    return undefined
  }
  return category.replaceAll(':', '-')
}

function failPackageDependency(stage, error) {
  const category = classifyPackageDependencyError(error)
  fail(category === undefined ? stage : `${stage}-${category}`)
}

async function runPackageCommand(command, args, options) {
  try {
    const acceptedExitCodes = options.acceptedExitCodes ?? [0]
    const observedExitCodes = acceptedExitCodes.includes(1)
      ? acceptedExitCodes
      : [...acceptedExitCodes, 1]
    const result = await runBoundedProcess(command, args, {
      acceptedExitCodes: observedExitCodes,
      cwd: options.cwd,
      env: options.env,
      maxOutputBytes: options.maxOutputBytes ?? DEFAULT_COMMAND_OUTPUT_BYTES,
      timeoutMs: options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
    })
    if (!acceptedExitCodes.includes(result.code)) {
      fail(`command-${classifySafePackageCommandError(result.stderr) ?? 'exit'}`, {
        exitCode: result.code,
      })
    }
    return result
  } catch (error) {
    if (error instanceof BoundedProcessError) {
      fail(`command-${error.category}`, {
        exitCode: error.exitCode,
        signal: error.signal,
      })
    }
    if (error instanceof PackageLocalError) throw error
    fail('command-internal')
  }
}

function capturedBuildToolchains(value) {
  if (!isPlainObject(value) || typeof value.snapshotRoot !== 'string') {
    fail('toolchain-capture')
  }
  for (const name of ['cargo', 'git', 'go', 'node', 'pnpm', 'rustc']) {
    const tool = value[name]
    if (
      !isPlainObject(tool) ||
      typeof tool.canonical !== 'string' ||
      !isAbsolute(tool.canonical) ||
      typeof tool.invocation !== 'string' ||
      !isAbsolute(tool.invocation) ||
      !SHA256_PATTERN.test(tool.executableSha256 ?? '') ||
      typeof tool.version !== 'string' ||
      tool.version.length === 0
    ) {
      fail('toolchain-capture')
    }
  }
  if (typeof value.go.goroot !== 'string' || !isAbsolute(value.go.goroot)) {
    fail('toolchain-capture')
  }
  return value
}

/** 只删除 source identity 在指定私有父目录中创建的工具链快照。 */
async function cleanupCapturedToolchains(value, expectedParent) {
  const toolchains = capturedBuildToolchains(value)
  const snapshotRoot = absolutePath(toolchains.snapshotRoot, 'toolchain-cleanup')
  const parent = absolutePath(expectedParent, 'toolchain-cleanup')
  if (
    dirname(snapshotRoot) !== parent ||
    !basename(snapshotRoot).startsWith('.package-source-toolchains-')
  ) {
    fail('toolchain-cleanup')
  }
  await assertPrivateDirectory(snapshotRoot)
  await rm(snapshotRoot, { force: false, recursive: true }).catch(() => fail('toolchain-cleanup'))
  const remains = await lstat(snapshotRoot).then(
    () => true,
    (error) => {
      if (error?.code === 'ENOENT') return false
      fail('toolchain-cleanup')
    },
  )
  if (remains) fail('toolchain-cleanup')
}

async function loadBoundSourceManifest(
  plan,
  expectedSha256,
  manifestPath = plan.paths.generationSourceManifest,
) {
  const bytes = await readSecureFileBytes(manifestPath, SOURCE_MANIFEST_MAX_BYTES)
  if (createHash('sha256').update(bytes).digest('hex') !== expectedSha256) {
    fail('source-manifest-digest')
  }
  let manifest
  try {
    manifest = JSON.parse(bytes.toString('utf8'))
  } catch {
    fail('source-manifest-json')
  }
  if (
    !isPlainObject(manifest) ||
    manifest.schema !== 'hexclaw.package-source-identity.v2' ||
    manifest.target !== plan.target.triple
  ) {
    fail('source-manifest-contract')
  }
  return manifest
}

async function moveBuiltAppIntoReleaseGeneration(plan) {
  const sourceMetadata = await lstat(plan.paths.builtApp, { bigint: true }).catch(() =>
    fail('release-app-source'),
  )
  if (!sourceMetadata.isDirectory() || sourceMetadata.isSymbolicLink()) {
    fail('release-app-source')
  }
  const destinationExists = await lstat(plan.paths.generationApp).then(
    () => true,
    (error) => {
      if (error?.code === 'ENOENT') return false
      fail('release-app-destination')
    },
  )
  if (destinationExists) fail('release-app-destination')
  await assertPrivateDirectory(plan.paths.generationReleaseRoot)
  // 共享 .app 可能正被残留构建重建（删旧写新）：等待源目录稳定后再复制，
  // 避免读到半成品；有限重试后仍不稳定则 fail-closed。
  const stabilityProbe = join(plan.paths.builtApp, 'Contents', 'Info.plist')
  let stable = false
  for (let attempt = 0; attempt < 4 && !stable; attempt += 1) {
    const before = await lstat(stabilityProbe, { bigint: true }).catch(() => null)
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 300))
    const after = await lstat(stabilityProbe, { bigint: true }).catch(() => null)
    stable =
      before !== null &&
      after !== null &&
      before.ino === after.ino &&
      before.mtimeNs === after.mtimeNs &&
      before.size === after.size
  }
  if (!stable) fail('release-app-unstable')
  // 复制而非 rename：builtApp 位于宿主持久共享 cargo target，rename 会破坏后续构建的增量缓存。
  // APFS clonefile（cp -c）CoW 复制：O(1) 元数据，不占实际写；源只读，克隆后内容逐字节一致。
  await runPackageCommand(
    FIXED_TOOLS.cp,
    ['-c', '-R', plan.paths.builtApp, plan.paths.generationApp],
    {
      cwd: plan.paths.generationRoot,
      env: cleanEnvironment(plan),
      timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
    },
  ).catch(() => fail('release-app-copy'))
  const copied = await lstat(plan.paths.generationApp, { bigint: true }).catch(() =>
    fail('release-app-copy'),
  )
  if (!copied.isDirectory() || copied.isSymbolicLink()) fail('release-app-copy')
}

async function scanRegularTree(root, limits = {}) {
  const maxEntries = limits.maxEntries ?? 20_000
  const maxTotalBytes = limits.maxTotalBytes ?? 4 * 1024 * 1024 * 1024
  const entries = []
  let count = 0
  let totalBytes = 0
  const visit = async (pathname, components) => {
    count += 1
    if (count > maxEntries) fail('tree-limit')
    const metadata = await lstat(pathname, { bigint: true }).catch(() => fail('tree-metadata'))
    if (metadata.isSymbolicLink()) fail('tree-link')
    const relativePath = components.join('/') || '.'
    if (metadata.isDirectory()) {
      entries.push(Object.freeze({ path: relativePath, type: 'directory' }))
      const children = await readdir(pathname)
      children.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
      for (const child of children) await visit(join(pathname, child), [...components, child])
      return
    }
    if (!metadata.isFile() || metadata.nlink !== 1n) fail('tree-type')
    if (metadata.size > BigInt(Number.MAX_SAFE_INTEGER)) fail('tree-limit')
    const size = Number(metadata.size)
    totalBytes += size
    if (!Number.isSafeInteger(totalBytes) || totalBytes > maxTotalBytes) fail('tree-limit')
    const identity = await secureFileSHA256(pathname, size)
    entries.push(
      Object.freeze({
        mode: Number(metadata.mode & 0o777n),
        path: relativePath,
        sha256: identity.sha256,
        size,
        type: 'file',
      }),
    )
  }
  await visit(root, [])
  return Object.freeze({ entries: Object.freeze(entries), totalBytes })
}

async function assertExactRegularTrees(left, right) {
  const [leftTree, rightTree] = await Promise.all([scanRegularTree(left), scanRegularTree(right)])
  if (JSON.stringify(leftTree) !== JSON.stringify(rightTree)) fail('resource-identity')
}

async function inspectFrontendCacheDirectory(cacheRoot, expectedFiles, maxTotalBytes) {
  const cacheMetadata = await lstat(cacheRoot, { bigint: true }).catch((error) => {
    if (error?.code === 'ENOENT') return undefined
    fail('frontend-typecheck-cache')
  })
  if (cacheMetadata === undefined) return false
  if (
    !cacheMetadata.isDirectory() ||
    cacheMetadata.isSymbolicLink() ||
    (Number(cacheMetadata.mode & 0o777n) & 0o022) !== 0 ||
    (typeof process.getuid === 'function' && cacheMetadata.uid !== BigInt(process.getuid())) ||
    (await realpath(cacheRoot).catch(() => fail('frontend-typecheck-cache'))) !== cacheRoot
  ) {
    fail('frontend-typecheck-cache')
  }
  const tree = await scanRegularTree(cacheRoot, {
    maxEntries: expectedFiles.length + 1,
    maxTotalBytes,
  }).catch(() => fail('frontend-typecheck-cache'))
  const files = tree.entries.slice(1)
  if (
    tree.entries[0]?.path !== '.' ||
    tree.entries[0]?.type !== 'directory' ||
    files.length !== expectedFiles.length ||
    files.some(
      (entry, index) =>
        entry.type !== 'file' || entry.path !== expectedFiles[index] || (entry.mode & 0o022) !== 0,
    )
  ) {
    fail('frontend-typecheck-cache')
  }
  return true
}

/** 删除前端构建在私有依赖树中生成的已知缓存，恢复依赖来源基线。 */
export async function cleanupFrontendTypecheckCache(plan) {
  if (!isPlainObject(plan) || !isPlainObject(plan.paths)) fail('frontend-typecheck-cache')
  const generationRoot = absolutePath(plan.paths.generationRoot, 'frontend-typecheck-cache')
  const nodeModules = absolutePath(plan.paths.frontendNodeModules, 'frontend-typecheck-cache')
  const relativeNodeModules = relative(generationRoot, nodeModules)
  if (
    basename(nodeModules) !== 'node_modules' ||
    relativeNodeModules === '' ||
    relativeNodeModules === '..' ||
    relativeNodeModules.startsWith(`..${sep}`) ||
    isAbsolute(relativeNodeModules)
  ) {
    fail('frontend-typecheck-cache')
  }
  await assertPrivateDirectory(generationRoot)
  const typecheckCacheRoot = join(nodeModules, '.tmp')
  const viteCacheRoot = join(nodeModules, FRONTEND_VITE_CACHE_DIRECTORY)
  const typecheckCacheExists = await inspectFrontendCacheDirectory(
    typecheckCacheRoot,
    FRONTEND_TYPECHECK_CACHE_FILES,
    64 * 1024 * 1024,
  )
  const viteCacheExists = await inspectFrontendCacheDirectory(viteCacheRoot, [], 0)

  if (typecheckCacheExists) {
    for (const name of FRONTEND_TYPECHECK_CACHE_FILES) {
      await unlink(join(typecheckCacheRoot, name)).catch(() => fail('frontend-typecheck-cache'))
    }
    await rmdir(typecheckCacheRoot).catch(() => fail('frontend-typecheck-cache'))
  }
  if (viteCacheExists) {
    await rmdir(viteCacheRoot).catch(() => fail('frontend-typecheck-cache'))
  }
}

function packageVerificationOptions(plan, result, location) {
  if (!['generation', 'published'].includes(location)) fail('verification-location')
  const prefix = location
  const appBundle = plan.paths[`${prefix}App`]
  return Object.freeze({
    distRoot: plan.paths[`${prefix}Dist`],
    expectedGenerationId: plan.generationId,
    expectedReceiptSHA256: result.receiptSHA256,
    expectedSourceManifestSHA256: result.sourceManifestSHA256,
    expectedTargetTriple: plan.target.triple,
    installedAppBinary: join(appBundle, 'Contents', 'MacOS', 'hexclaw-desktop'),
    localAppBundle: appBundle,
    manifestPath: plan.paths[`${prefix}Manifest`],
    notBeforeEpochSeconds: plan.notBeforeEpochSeconds,
    packagePath: plan.paths[`${prefix}Dmg`],
    receiptPath: plan.paths[`${prefix}Receipt`],
    releaseVersion: plan.version,
    sidecarBinary: join(appBundle, 'Contents', 'MacOS', 'hexclaw'),
    sourceManifestPath: plan.paths[`${prefix}SourceManifest`],
  })
}

async function writeBuildResult(plan, result) {
  const record = Object.freeze({
    generation_id: plan.generationId,
    not_before_epoch_seconds: plan.notBeforeEpochSeconds,
    receipt_sha256: result.receiptSHA256,
    schema: PACKAGE_RESULT_SCHEMA,
    source_manifest_sha256: result.sourceManifestSHA256,
    target_triple: plan.target.triple,
  })
  await writePrivateFileExclusive(plan.paths.buildResult, canonicalJSON(record))
}

async function readBuildResult(plan, location = 'generation') {
  if (!['generation', 'published'].includes(location)) fail('build-result')
  const pathname = location === 'generation' ? plan.paths.buildResult : plan.paths.publishedResult
  const bytes = await readSecureFileBytes(pathname, RESULT_MAX_BYTES)
  let record
  try {
    record = JSON.parse(bytes.toString('utf8'))
  } catch {
    fail('build-result')
  }
  if (
    !isPlainObject(record) ||
    Object.keys(record).sort().join(',') !==
      'generation_id,not_before_epoch_seconds,receipt_sha256,schema,source_manifest_sha256,target_triple' ||
    record.schema !== PACKAGE_RESULT_SCHEMA ||
    record.generation_id !== plan.generationId ||
    record.target_triple !== plan.target.triple ||
    !SHA256_PATTERN.test(record.receipt_sha256 ?? '') ||
    !SHA256_PATTERN.test(record.source_manifest_sha256 ?? '') ||
    !Number.isSafeInteger(record.not_before_epoch_seconds) ||
    record.not_before_epoch_seconds <= 0
  ) {
    fail('build-result')
  }
  return Object.freeze({
    notBeforeEpochSeconds: record.not_before_epoch_seconds,
    receiptSHA256: record.receipt_sha256,
    sourceManifestSHA256: record.source_manifest_sha256,
  })
}

function tarString(field) {
  const nul = field.indexOf(0)
  const end = nul < 0 ? field.length : nul
  if (nul >= 0 && field.subarray(nul + 1).some((value) => value !== 0)) {
    fail('ollama-archive')
  }
  const bytes = field.subarray(0, end)
  const text = bytes.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(bytes)) fail('ollama-archive')
  return text
}

function tarOctal(field) {
  if (field.length === 0 || (field[0] & 0x80) !== 0) fail('ollama-archive')
  const text = field
    .toString('ascii')
    .replace(/[\0 ]+$/u, '')
    .replace(/^ +/u, '')
  if (!/^[0-7]+$/u.test(text)) fail('ollama-archive')
  const value = Number.parseInt(text, 8)
  if (!Number.isSafeInteger(value) || value < 0) fail('ollama-archive')
  return value
}

function normalizedTarMember(name) {
  if (
    typeof name !== 'string' ||
    name.length === 0 ||
    name.includes('\0') ||
    name.includes('\\') ||
    name.startsWith('/') ||
    /^[A-Za-z]:/u.test(name) ||
    /[\u0000-\u001f\u007f]/u.test(name)
  ) {
    fail('ollama-archive')
  }
  const normalized = name.endsWith('/') ? name.slice(0, -1) : name
  const components = normalized.split('/')
  if (
    normalized.length === 0 ||
    components.some((component) => component === '' || component === '.' || component === '..')
  ) {
    fail('ollama-archive')
  }
  return normalized
}

class BoundedByteReader {
  constructor(stream, maximumBytes) {
    this.iterator = stream[Symbol.asyncIterator]()
    this.maximumBytes = maximumBytes
    this.buffer = Buffer.alloc(0)
    this.offset = 0
    this.received = 0
  }

  async pull() {
    const result = await this.iterator.next()
    if (result.done) return false
    const chunk = Buffer.from(result.value)
    this.received += chunk.length
    if (this.received > this.maximumBytes) fail('ollama-archive')
    if (this.offset === this.buffer.length) {
      this.buffer = chunk
      this.offset = 0
    } else {
      this.buffer = Buffer.concat([this.buffer.subarray(this.offset), chunk])
      this.offset = 0
    }
    return true
  }

  async readExactly(length) {
    if (!Number.isSafeInteger(length) || length < 0) fail('ollama-archive')
    const output = Buffer.allocUnsafe(length)
    let written = 0
    while (written < length) {
      if (this.offset === this.buffer.length && !(await this.pull())) fail('ollama-archive')
      const available = Math.min(length - written, this.buffer.length - this.offset)
      this.buffer.copy(output, written, this.offset, this.offset + available)
      this.offset += available
      written += available
    }
    return output
  }

  async drainZeros() {
    while (true) {
      if (this.offset < this.buffer.length) {
        if (this.buffer.subarray(this.offset).some((value) => value !== 0)) {
          fail('ollama-archive')
        }
        this.offset = this.buffer.length
      }
      if (!(await this.pull())) return
    }
  }
}

function normalizedTarLinkTarget(name, linkName) {
  if (
    typeof linkName !== 'string' ||
    linkName.length === 0 ||
    linkName.includes('\0') ||
    linkName.includes('\\') ||
    linkName.startsWith('/') ||
    /^[A-Za-z]:/u.test(linkName) ||
    /[\u0000-\u001f\u007f]/u.test(linkName)
  ) {
    fail('ollama-archive')
  }
  const components = linkName.split('/')
  if (components.some((component) => component === '' || component === '.' || component === '..')) {
    fail('ollama-archive')
  }
  const separatorIndex = name.lastIndexOf('/')
  const parent = separatorIndex < 0 ? '' : name.slice(0, separatorIndex)
  return normalizedTarMember(parent === '' ? linkName : parent + '/' + linkName)
}

function ollamaMetallibAppleDoubleTarget(name) {
  const match = /^(mlx_metal_v[34])\/\._(mlx\.metallib)$/u.exec(name)
  return match ? `${match[1]}/${match[2]}` : undefined
}

function ollamaMetallibPaxTarget(name) {
  const match = /^(mlx_metal_v[34])\/PaxHeader\/(mlx\.metallib)$/u.exec(name)
  return match ? `${match[1]}/${match[2]}` : undefined
}

function normalizedOllamaAppleDoubleContracts(value) {
  if (value === undefined) return new Map()
  if (!isPlainObject(value)) fail('ollama-archive')
  const entries = Object.entries(value)
  if (entries.length === 0 || entries.length > 2) fail('ollama-archive')
  const contracts = new Map()
  for (const [name, contract] of entries) {
    if (
      !ollamaMetallibAppleDoubleTarget(name) ||
      !isPlainObject(contract) ||
      Object.keys(contract).sort().join(',') !== 'bytes,sha256' ||
      !Number.isSafeInteger(contract.bytes) ||
      contract.bytes <= 0 ||
      contract.bytes > OLLAMA_APPLEDOUBLE_MAX_BYTES ||
      !SHA256_PATTERN.test(contract.sha256 ?? '')
    ) {
      fail('ollama-archive')
    }
    contracts.set(
      name,
      Object.freeze({
        bytes: contract.bytes,
        sha256: contract.sha256,
        target: ollamaMetallibAppleDoubleTarget(name),
      }),
    )
  }
  return contracts
}

function validateOllamaAppleDouble(payload, contract) {
  if (
    !contract ||
    payload.length !== contract.bytes ||
    createHash('sha256').update(payload).digest('hex') !== contract.sha256
  ) {
    fail('ollama-archive')
  }
}

function decodeCanonicalPaxBase64(value) {
  const text = value.toString('ascii')
  if (
    text.length === 0 ||
    !Buffer.from(text, 'ascii').equals(value) ||
    !/^[A-Za-z0-9+/]+$/u.test(text) ||
    text.length % 4 === 1
  ) {
    fail('ollama-archive')
  }
  const padding = '='.repeat((4 - (text.length % 4)) % 4)
  const decoded = Buffer.from(text + padding, 'base64')
  if (decoded.length === 0 || decoded.toString('base64').replace(/=+$/u, '') !== text) {
    fail('ollama-archive')
  }
  return decoded
}

/** 严格验证固定归档的本地 PAX 元数据；签名属性仅作来源一致性校验，不进入最终无扩展属性的包。 */
function validateOllamaMetallibPax(payload) {
  if (payload.length === 0 || payload.length > OLLAMA_PAX_MAX_BYTES) fail('ollama-archive')
  const records = new Map()
  let offset = 0
  while (offset < payload.length) {
    const separator = payload.indexOf(0x20, offset)
    if (separator <= offset || separator - offset > 5) fail('ollama-archive')
    const lengthBytes = payload.subarray(offset, separator)
    const lengthText = lengthBytes.toString('ascii')
    if (
      !Buffer.from(lengthText, 'ascii').equals(lengthBytes) ||
      !/^[1-9][0-9]*$/u.test(lengthText)
    ) {
      fail('ollama-archive')
    }
    const length = Number.parseInt(lengthText, 10)
    const end = offset + length
    if (!Number.isSafeInteger(length) || end > payload.length || payload[end - 1] !== 0x0a) {
      fail('ollama-archive')
    }
    const record = payload.subarray(separator + 1, end - 1)
    const equals = record.indexOf(0x3d)
    if (equals <= 0) fail('ollama-archive')
    const keyBytes = record.subarray(0, equals)
    const key = keyBytes.toString('ascii')
    if (!Buffer.from(key, 'ascii').equals(keyBytes) || records.has(key)) fail('ollama-archive')
    records.set(key, Buffer.from(record.subarray(equals + 1)))
    offset = end
  }

  const expectedKeys = new Set(['mtime'])
  for (const name of OLLAMA_PAX_XATTR_NAMES) {
    expectedKeys.add(`LIBARCHIVE.xattr.com.apple.cs.${name}`)
    expectedKeys.add(`SCHILY.xattr.com.apple.cs.${name}`)
  }
  if (
    records.size !== expectedKeys.size ||
    [...records.keys()].some((key) => !expectedKeys.has(key))
  ) {
    fail('ollama-archive')
  }
  const mtimeBytes = records.get('mtime') ?? Buffer.alloc(0)
  const mtime = mtimeBytes.toString('ascii')
  if (
    !Buffer.from(mtime, 'ascii').equals(mtimeBytes) ||
    !/^[0-9]{1,20}(?:\.[0-9]{1,20})?$/u.test(mtime)
  ) {
    fail('ollama-archive')
  }
  for (const name of OLLAMA_PAX_XATTR_NAMES) {
    const decoded = decodeCanonicalPaxBase64(
      records.get(`LIBARCHIVE.xattr.com.apple.cs.${name}`) ?? Buffer.alloc(0),
    )
    const raw = records.get(`SCHILY.xattr.com.apple.cs.${name}`) ?? Buffer.alloc(0)
    if (raw.length === 0 || raw.length > OLLAMA_PAX_MAX_BYTES || !decoded.equals(raw)) {
      fail('ollama-archive')
    }
  }
}

async function materializeTarRegularFile(sourcePath, outputPath, expectedSize, mode) {
  await makePrivateDirectory(dirname(outputPath), { recursive: true })
  let output
  try {
    await withSecureRegularFile(sourcePath, expectedSize, async (source, sourceMetadata) => {
      if (sourceMetadata.size !== BigInt(expectedSize)) fail('ollama-archive')
      output = await open(
        outputPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        mode,
      ).catch(() => fail('ollama-archive'))
      const buffer = Buffer.allocUnsafe(Math.min(FILE_HASH_CHUNK_BYTES, expectedSize))
      let offset = 0
      while (offset < expectedSize) {
        const length = Math.min(buffer.length, expectedSize - offset)
        const { bytesRead } = await source.read(buffer, 0, length, offset)
        if (bytesRead <= 0) fail('ollama-archive')
        let written = 0
        while (written < bytesRead) {
          const result = await output.write(buffer, written, bytesRead - written, offset + written)
          if (result.bytesWritten <= 0) fail('ollama-archive')
          written += result.bytesWritten
        }
        offset += bytesRead
      }
      await output.chmod(mode)
      await output.sync()
      const metadata = await output.stat({ bigint: true })
      if (
        !metadata.isFile() ||
        metadata.nlink !== 1n ||
        metadata.size !== BigInt(expectedSize) ||
        Number(metadata.mode & 0o777n) !== mode
      ) {
        fail('ollama-archive')
      }
    })
  } finally {
    await output?.close().catch(() => undefined)
  }
}

async function extractTarRegularFile(reader, outputPath, size, mode) {
  await makePrivateDirectory(dirname(outputPath), { recursive: true })
  let output
  try {
    output = await open(
      outputPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      mode,
    ).catch(() => fail('ollama-archive'))
    let offset = 0
    while (offset < size) {
      const chunk = await reader.readExactly(Math.min(FILE_HASH_CHUNK_BYTES, size - offset))
      let written = 0
      while (written < chunk.length) {
        const result = await output.write(chunk, written, chunk.length - written, offset + written)
        if (result.bytesWritten <= 0) fail('ollama-archive')
        written += result.bytesWritten
      }
      offset += chunk.length
    }
    await output.chmod(mode)
    await output.sync()
    const metadata = await output.stat({ bigint: true })
    if (!metadata.isFile() || metadata.nlink !== 1n || metadata.size !== BigInt(size)) {
      fail('ollama-archive')
    }
  } finally {
    await output?.close().catch(() => undefined)
  }
}

/** 解压已固定摘要的 Ollama tar.gz；受限相对软链接链物化为普通文件，路径逃逸、前向/循环链接和特殊文件一律拒绝。 */
export async function extractPinnedTarGzipArchive(options) {
  exactOptions(options, [
    'appleDoubleContracts',
    'archivePath',
    'destination',
    'expectedArchiveBytes',
    'expectedArchiveSha256',
    'expectedBinaryBytes',
    'expectedBinaryRelativePath',
    'maxEntries',
    'maxExpandedBytes',
    'maxFileBytes',
  ])
  const archivePath = absolutePath(options.archivePath, 'ollama-archive')
  const destination = absolutePath(options.destination, 'ollama-archive')
  const appleDoubleContracts = normalizedOllamaAppleDoubleContracts(options.appleDoubleContracts)
  const integers = [
    options.expectedArchiveBytes,
    options.expectedBinaryBytes,
    options.maxEntries,
    options.maxExpandedBytes,
    options.maxFileBytes,
  ]
  if (
    integers.some((value) => !Number.isSafeInteger(value) || value <= 0) ||
    !SHA256_PATTERN.test(options.expectedArchiveSha256 ?? '') ||
    options.maxEntries > OLLAMA_ARCHIVE_MAX_ENTRIES ||
    options.maxExpandedBytes > OLLAMA_EXPANDED_MAX_BYTES ||
    options.maxFileBytes > OLLAMA_MEMBER_MAX_BYTES
  ) {
    fail('ollama-archive')
  }
  const expectedBinaryRelativePath = normalizedTarMember(options.expectedBinaryRelativePath)
  const archiveIdentity = await secureFileSHA256(archivePath, options.expectedArchiveBytes)
  if (
    archiveIdentity.size !== options.expectedArchiveBytes ||
    archiveIdentity.sha256 !== options.expectedArchiveSha256
  ) {
    fail('ollama-archive')
  }

  let destinationOwnedByInvocation = false
  try {
    await makePrivateDirectory(dirname(destination), { recursive: true })
    await mkdir(destination, { mode: PRIVATE_DIRECTORY_MODE }).catch(() => fail('ollama-archive'))
    destinationOwnedByInvocation = true
    await assertPrivateDirectory(destination).catch(() => fail('ollama-archive'))
    const result = await withSecureRegularFile(
      archivePath,
      options.expectedArchiveBytes,
      async (handle) => {
        const compressed = createReadStream(archivePath, {
          autoClose: false,
          fd: handle.fd,
          start: 0,
        })
        const decompressed = compressed.pipe(createGunzip())
        const reader = new BoundedByteReader(
          decompressed,
          options.maxExpandedBytes + options.maxEntries * 1024 + 1024,
        )
        const seen = new Set()
        const regularFiles = new Map()
        const completedMetadataTargets = new Set()
        let entries = 0
        let files = 0
        let pendingAppleDoubleTarget
        let pendingPaxTarget
        let totalBytes = 0
        while (true) {
          const header = await reader.readExactly(512)
          if (header.every((value) => value === 0)) {
            if (
              pendingAppleDoubleTarget ||
              pendingPaxTarget ||
              completedMetadataTargets.size !== appleDoubleContracts.size ||
              [...appleDoubleContracts.values()].some(
                (contract) => !completedMetadataTargets.has(contract.target),
              )
            ) {
              fail('ollama-archive')
            }
            const second = await reader.readExactly(512)
            if (second.some((value) => value !== 0)) fail('ollama-archive')
            await reader.drainZeros()
            break
          }
          const storedChecksum = tarOctal(header.subarray(148, 156))
          const checksumHeader = Buffer.from(header)
          checksumHeader.fill(0x20, 148, 156)
          const checksum = checksumHeader.reduce((total, value) => total + value, 0)
          if (storedChecksum !== checksum) fail('ollama-archive')
          const rawName = tarString(header.subarray(0, 100))
          const prefix = tarString(header.subarray(345, 500))
          const name = normalizedTarMember(prefix ? `${prefix}/${rawName}` : rawName)
          if (seen.has(name)) fail('ollama-archive')
          seen.add(name)
          entries += 1
          if (entries > options.maxEntries) fail('ollama-archive')
          const type = String.fromCharCode(header[156] || 48)
          const size = tarOctal(header.subarray(124, 136))
          const archivedMode = tarOctal(header.subarray(100, 108))
          if (type !== '0' && type !== '2' && type !== '5' && type !== 'x') {
            fail('ollama-archive')
          }
          if ((type === '2' || type === '5') && size !== 0) fail('ollama-archive')
          if (size > options.maxFileBytes) fail('ollama-archive')
          const components = name.split('/')
          const reservesAppleDouble = components.some((component) => component.startsWith('._'))
          const reservesPaxHeader = components.some(
            (component) => component.toLowerCase() === 'paxheader',
          )
          const appleDoubleTarget = ollamaMetallibAppleDoubleTarget(name)
          const paxTarget = ollamaMetallibPaxTarget(name)
          const linkName = tarString(header.subarray(157, 257))
          if (reservesAppleDouble && (type !== '0' || !appleDoubleTarget || linkName !== '')) {
            fail('ollama-archive')
          }
          if (reservesPaxHeader && (type !== 'x' || !paxTarget || linkName !== '')) {
            fail('ollama-archive')
          }
          const appleDoubleContract = appleDoubleContracts.get(name)
          if (
            appleDoubleTarget &&
            (!appleDoubleContract ||
              size !== appleDoubleContract.bytes ||
              size <= 0 ||
              size > OLLAMA_APPLEDOUBLE_MAX_BYTES)
          ) {
            fail('ollama-archive')
          }
          if (type === 'x' && (size <= 0 || size > OLLAMA_PAX_MAX_BYTES)) {
            fail('ollama-archive')
          }
          if (pendingPaxTarget && (type !== '0' || name !== pendingPaxTarget)) {
            fail('ollama-archive')
          }
          if (
            pendingAppleDoubleTarget &&
            (type !== 'x' || paxTarget !== pendingAppleDoubleTarget)
          ) {
            fail('ollama-archive')
          }
          if (type === 'x' && (!reservesPaxHeader || !pendingAppleDoubleTarget || !paxTarget)) {
            fail('ollama-archive')
          }
          let linkTarget
          if (type === '2') {
            const targetName = normalizedTarLinkTarget(name, linkName)
            linkTarget = regularFiles.get(targetName)
            if (!linkTarget) fail('ollama-archive')
          }
          const expandedSize = linkTarget?.size ?? size
          if (expandedSize > options.maxFileBytes) fail('ollama-archive')
          totalBytes += expandedSize
          if (!Number.isSafeInteger(totalBytes) || totalBytes > options.maxExpandedBytes) {
            fail('ollama-archive')
          }
          const outputPath = join(destination, ...name.split('/'))
          const outputRelative = relative(destination, outputPath)
          if (outputRelative.startsWith(`..${sep}`) || isAbsolute(outputRelative)) {
            fail('ollama-archive')
          }
          if (type === '5') {
            await makePrivateDirectory(outputPath, { recursive: true })
          } else if (type === '2') {
            await materializeTarRegularFile(
              linkTarget.outputPath,
              outputPath,
              linkTarget.size,
              linkTarget.mode,
            )
            regularFiles.set(
              name,
              Object.freeze({ mode: linkTarget.mode, outputPath, size: linkTarget.size }),
            )
            files += 1
          } else if (appleDoubleTarget) {
            const payload = await reader.readExactly(size)
            validateOllamaAppleDouble(payload, appleDoubleContract)
            pendingAppleDoubleTarget = appleDoubleTarget
          } else if (type === 'x') {
            const payload = await reader.readExactly(size)
            validateOllamaMetallibPax(payload)
            pendingAppleDoubleTarget = undefined
            pendingPaxTarget = paxTarget
          } else {
            const outputMode = (archivedMode & 0o111) === 0 ? PRIVATE_FILE_MODE : 0o700
            await extractTarRegularFile(reader, outputPath, size, outputMode)
            regularFiles.set(name, Object.freeze({ mode: outputMode, outputPath, size }))
            files += 1
            if (pendingPaxTarget === name) {
              completedMetadataTargets.add(name)
              pendingPaxTarget = undefined
            }
          }
          const padding = (512 - (size % 512)) % 512
          if (padding > 0) {
            const paddingBytes = await reader.readExactly(padding)
            if (paddingBytes.some((value) => value !== 0)) fail('ollama-archive')
          }
        }
        return Object.freeze({ entries, files, totalBytes })
      },
    )
    const binaryPath = join(destination, ...expectedBinaryRelativePath.split('/'))
    const binary = await lstat(binaryPath, { bigint: true }).catch(() => fail('ollama-archive'))
    if (
      !binary.isFile() ||
      binary.isSymbolicLink() ||
      binary.nlink !== 1n ||
      binary.size !== BigInt(options.expectedBinaryBytes) ||
      Number(binary.mode & 0o111n) === 0
    ) {
      fail('ollama-archive')
    }
    return result
  } catch (error) {
    if (destinationOwnedByInvocation) {
      await rm(destination, { force: true, recursive: true }).catch(() => undefined)
    }
    if (error instanceof PackageLocalError && error.category === 'ollama-archive') throw error
    fail('ollama-archive')
  }
}

function requireOperations(operations) {
  if (!isPlainObject(operations)) fail('invalid-operations')
  const names = Object.keys(operations).sort()
  const expected = [...PIPELINE_OPERATION_NAMES].sort()
  if (
    names.length !== expected.length ||
    names.some((name, index) => name !== expected[index]) ||
    expected.some((name) => typeof operations[name] !== 'function')
  ) {
    fail('invalid-operations')
  }
  return operations
}

/** 为唯一 package-local generation 计算所有输入、暂存和 canonical 路径。 */
export function createPackageLocalPlan(options) {
  exactOptions(options, [
    'desktopRoot',
    'generationId',
    'hostHome',
    'notBeforeEpochSeconds',
    'targetTriple',
    'version',
  ])
  const desktopRoot = absolutePath(options.desktopRoot, 'invalid-desktop-root')
  const hostHome = absolutePath(options.hostHome, 'invalid-host-home')
  if (!GENERATION_ID_PATTERN.test(options.generationId ?? '')) fail('invalid-generation')
  if (!VERSION_PATTERN.test(options.version ?? '')) fail('invalid-version')
  const notBeforeEpochSeconds =
    options.notBeforeEpochSeconds === undefined
      ? Math.floor(Date.now() / 1_000)
      : options.notBeforeEpochSeconds
  if (!Number.isSafeInteger(notBeforeEpochSeconds) || notBeforeEpochSeconds <= 0) {
    fail('invalid-not-before')
  }
  const target = TARGETS[options.targetTriple]
  if (!target) fail('invalid-target')

  const tauriTargetRoot = join(desktopRoot, 'src-tauri', 'target')
  const releaseRoot = join(tauriTargetRoot, 'release', 'bundle', 'dmg')
  const publication = createPackagePublicationLayout({
    generationId: options.generationId,
    releaseRoot,
  })
  const generationRoot = publication.stagingGenerationRoot
  if (basename(publication.stagingRoot) !== PACKAGE_GENERATION_PLAN_PARENT_BASENAME) {
    fail('publication-layout')
  }
  const packageControlDirectory = join(releaseRoot, PACKAGE_GENERATION_CONTROL_BASENAME)
  const generationBinaries = join(generationRoot, 'binaries')
  const generationOllamaRoot = join(generationRoot, 'ollama')
  const projectedWorkRoot = join(generationRoot, 'source')
  const projectedDesktopRoot = join(projectedWorkRoot, 'hexclaw-desktop')
  // 宿主持久共享缓存根：依赖缓存跨 generation 复用，装机不每次全量重建（BUG-20260816-001）。
  const cacheRoot = join(hostHome, '.cache', 'hexclaw-package')
  const sharedCargoHome = join(cacheRoot, 'cargo-home')
  const sharedCargoTarget = join(cacheRoot, 'cargo-target')
  const sharedOllamaArchive = join(cacheRoot, 'downloads', 'ollama-darwin.tgz')
  // Tauri 产物在共享 cargo target 下生成；从 generation 复制进发布目录（不移动共享缓存）。
  const builtApp = join(
    sharedCargoTarget,
    target.triple,
    'release',
    'bundle',
    'macos',
    'HexClaw.app',
  )
  const paths = Object.freeze({
    buildResult: publication.resultPath,
    builtApp,
    cacheRoot,
    currentPointer: publication.currentPointerPath,
    frontendNodeModules: join(projectedDesktopRoot, 'node_modules'),
    generationApp: publication.appBundle,
    generationBinaries,
    generationDist: publication.distRoot,
    generationDmg: publication.packagePath,
    generationDmgRoot: join(generationRoot, 'dmg-root'),
    generationManifest: publication.manifestPath,
    generationOllamaRoot,
    generationReceipt: publication.receiptPath,
    generationReleaseRoot: publication.candidateRoot,
    generationRoot,
    generationSourceManifest: publication.sourceManifestPath,
    lock: join(packageControlDirectory, PACKAGE_GENERATION_LOCK_BASENAME),
    publishedApp: publication.published.appBundle,
    publishedDist: publication.published.distRoot,
    publishedDmg: publication.published.packagePath,
    publishedGenerationRoot: publication.publishedGenerationRoot,
    publishedManifest: publication.published.manifestPath,
    publishedReceipt: publication.published.receiptPath,
    publishedResult: publication.published.resultPath,
    publishedRoot: publication.publishedRoot,
    publishedSourceManifest: publication.published.sourceManifestPath,
    privateHome: join(generationRoot, 'home'),
    privateTemp: join(generationRoot, 'tmp'),
    projectedDesktopRoot,
    projectedGoModuleRoots: Object.freeze(
      ['toolkit', 'ai-core', 'hexagon', 'hexclaw'].map((name) => join(projectedWorkRoot, name)),
    ),
    projectedGoWork: join(projectedWorkRoot, 'go.work'),
    projectedWorkRoot,
    releaseRoot,
    sharedCargoHome,
    sharedCargoTarget,
    sharedOllamaArchive,
    tauriOverlay: join(generationRoot, 'tauri.package-local.generated.json'),
    tombstone: join(packageControlDirectory, PACKAGE_GENERATION_TOMBSTONE_BASENAME),
  })
  return Object.freeze({
    desktopRoot,
    generationId: options.generationId,
    hostHome,
    notBeforeEpochSeconds,
    paths,
    publication,
    target,
    version: options.version,
    workRoot: resolve(desktopRoot, '..'),
  })
}

function heldCommandArguments(plan) {
  return Object.freeze([
    '--generation-id',
    plan.generationId,
    '--not-before-epoch-seconds',
    String(plan.notBeforeEpochSeconds),
    '--target-triple',
    plan.target.triple,
    '--version',
    plan.version,
  ])
}

/** 构造 generation lock 唯一持有的 build 与 final verifier 子命令。 */
export function createPackageLocalLockInvocation(plan, options) {
  exactOptions(options, ['modulePath', 'nodeExecutable'])
  if (!isPlainObject(plan) || !isPlainObject(plan.paths)) fail('invalid-plan')
  const modulePath = absolutePath(options.modulePath, 'invalid-module-path')
  const nodeExecutable = absolutePath(options.nodeExecutable, 'invalid-node')
  const argumentsForPlan = heldCommandArguments(plan)
  return Object.freeze({
    command: Object.freeze([nodeExecutable, modulePath, 'build-held', ...argumentsForPlan]),
    cwd: plan.desktopRoot,
    environment: sourceIdentityEnvironment(plan),
    finalVerificationCommand: Object.freeze([
      nodeExecutable,
      modulePath,
      'verify-held',
      ...argumentsForPlan,
    ]),
    generationId: plan.generationId,
    lockPath: plan.paths.lock,
    maxOutputBytes: DEFAULT_COMMAND_OUTPUT_BYTES,
    planRoot: plan.paths.generationRoot,
    timeoutMs: BUILD_COMMAND_TIMEOUT_MS,
    tombstonePath: plan.paths.tombstone,
  })
}

async function ensurePackageControlDirectory(plan) {
  await mkdir(plan.paths.releaseRoot, {
    mode: PRIVATE_DIRECTORY_MODE,
    recursive: true,
  }).catch(() => fail('control-directory'))
  await assertTrustedOwnedDirectory(plan.paths.releaseRoot).catch(() => fail('control-directory'))
}

/** 外层只负责准备控制目录并委托 generation lock，绝不直接构建或发布。 */
export async function runPackageLocalBuild(plan, adapters = {}) {
  exactOptions(adapters, ['lockRunner', 'modulePath', 'nodeExecutable'])
  const lockRunner = adapters.lockRunner ?? runWithPackageGenerationLock
  if (typeof lockRunner !== 'function') fail('lock-runner')
  await ensurePackageControlDirectory(plan)
  return lockRunner(
    createPackageLocalLockInvocation(plan, {
      modulePath: adapters.modulePath ?? MODULE_PATH,
      nodeExecutable: adapters.nodeExecutable ?? process.execPath,
    }),
  )
}

/** 生成仅供本轮 Tauri 构建使用的 merge-patch overlay。 */
export function createTauriPackageOverlay(plan) {
  if (!isPlainObject(plan) || !isPlainObject(plan.paths)) fail('invalid-plan')
  const tauriRoot = join(plan.paths.projectedDesktopRoot, 'src-tauri')
  const tauriPath = (pathname) => {
    const value = relative(tauriRoot, pathname)
    if (value === '' || isAbsolute(value) || value.includes('\0')) fail('invalid-plan')
    return value.split(sep).join('/')
  }
  return Object.freeze({
    build: Object.freeze({
      beforeBuildCommand: '',
      frontendDist: tauriPath(plan.paths.generationDist),
    }),
    bundle: Object.freeze({
      createUpdaterArtifacts: false,
      externalBin: Object.freeze([
        tauriPath(join(plan.paths.generationBinaries, 'hexclaw')),
        tauriPath(join(plan.paths.generationBinaries, 'pandoc')),
        tauriPath(join(plan.paths.generationBinaries, 'typst')),
      ]),
      resources: Object.freeze({
        'binaries/ollama-bundle': null,
        'render-assets/*': 'assets/render/',
        [tauriPath(plan.paths.generationOllamaRoot)]: 'ollama',
      }),
    }),
  })
}

/** 唯一构建状态机只生成私有候选 generation，不触碰 current pointer。 */
export async function runPackageBuildPipeline(plan, suppliedOperations) {
  if (!isPlainObject(plan) || !isPlainObject(plan.publication)) fail('invalid-plan')
  const operations = requireOperations(suppliedOperations)
  let toolchainsCleaned = false
  let context = Object.freeze({
    generationId: plan.generationId,
    plan,
    targetTriple: plan.target.triple,
  })
  try {
    const sourceManifest = await operations.createSourceManifest(context)
    const toolchains = capturedBuildToolchains(sourceManifest?.toolchains)
    context = Object.freeze({ ...context, toolchains })
    if (!/^[a-f0-9]{64}$/u.test(sourceManifest?.sha256 ?? '')) {
      fail('source-manifest-result')
    }
    context = Object.freeze({
      ...context,
      sourceManifest: sourceManifest.manifest,
      sourceManifestSHA256: sourceManifest.sha256,
      toolchains,
    })
    await operations.projectDesktopSource(context)
    const dependencies = await operations.prepareFrontendDependencies(context)
    if (!isPlainObject(dependencies)) fail('dependency-provenance-result')
    context = Object.freeze({ ...context, dependencies })
    await operations.verifyGoDependencies(context)
    await operations.stageRenderBundle(context)
    await operations.buildSidecar(context)
    await operations.verifySidecar(context)
    const ollama = await operations.stageOllama(context)
    context = Object.freeze({ ...context, ollama })
    await operations.verifyOllama(context)
    await operations.buildFrontend(context)
    await operations.prepareCargoDependencies(context)
    await operations.buildTauriApp(context)
    // 先复制到 generation 私有目录再校验：共享 .app 可能被残留构建写入，
    // verify 只扫描本代私有副本，消除并发写共享路径的 tree-metadata 竞态。
    await operations.stageReleaseApp(context)
    await operations.verifyAppResources(context)
    await operations.verifySourceManifest(context)
    await operations.sanitizeAndVerify(context)
    await operations.createDmg(context)
    const attestation = await operations.createAttestation(context)
    if (!/^[a-f0-9]{64}$/u.test(attestation?.receiptSHA256 ?? '')) {
      fail('attestation-result')
    }
    context = Object.freeze({ ...context, receiptSHA256: attestation.receiptSHA256 })
    await operations.cleanupToolchains(context).catch(() => fail('toolchain-cleanup'))
    toolchainsCleaned = true
    await operations.writeBuildResult(context)
    await operations.verifyStagedPackage(context)
    return Object.freeze({
      generationId: plan.generationId,
      receiptSHA256: context.receiptSHA256,
      sourceManifestSHA256: context.sourceManifestSHA256,
      targetTriple: plan.target.triple,
    })
  } catch (error) {
    let toolchainCleanupError
    if (!toolchainsCleaned && context.toolchains !== undefined) {
      try {
        await operations.cleanupToolchains(context)
        toolchainsCleaned = true
      } catch {
        toolchainCleanupError = new PackageLocalError('toolchain-cleanup')
      }
    }
    await operations.cleanupStaging(context).catch(() => fail('staging-cleanup'))
    if (toolchainCleanupError) throw toolchainCleanupError
    throw error
  }
}

async function prepareGenerationRoot(plan) {
  const generationsRoot = dirname(plan.paths.generationRoot)
  await makePrivateDirectory(generationsRoot, { recursive: true })
  const existing = await lstat(plan.paths.generationRoot).then(
    (metadata) => metadata,
    (error) => {
      if (error?.code === 'ENOENT') return undefined
      fail('generation-state')
    },
  )
  if (existing === undefined) {
    await makePrivateDirectory(plan.paths.generationRoot)
  } else {
    await assertPrivateDirectory(plan.paths.generationRoot)
    const entries = await readdir(plan.paths.generationRoot).catch(() => fail('generation-state'))
    const allowedCapability = '.package-local-build-capability-consumed.json'
    if (entries.some((name) => name !== allowedCapability)) fail('generation-exists')
    if (entries.includes(allowedCapability)) {
      const metadata = await lstat(join(plan.paths.generationRoot, allowedCapability), {
        bigint: true,
      }).catch(() => fail('generation-state'))
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.nlink !== 1n ||
        Number(metadata.mode & 0o777n) !== PRIVATE_FILE_MODE ||
        (typeof process.getuid === 'function' && metadata.uid !== BigInt(process.getuid()))
      ) {
        fail('generation-state')
      }
    }
  }
  await Promise.all([
    makePrivateDirectory(plan.paths.privateHome),
    makePrivateDirectory(plan.paths.privateTemp),
    // 宿主持久共享缓存：允许跨 generation 复用，装机不每次全量重建（BUG-20260816-001）。
    makePrivateDirectory(plan.paths.cacheRoot, { recursive: true }),
    makePrivateDirectory(plan.paths.sharedCargoHome, { recursive: true }),
    makePrivateDirectory(plan.paths.sharedCargoTarget, { recursive: true }),
    makePrivateDirectory(dirname(plan.paths.sharedOllamaArchive), { recursive: true }),
  ])
}

/** lockf 持锁后创建唯一 generation，并进入唯一构建状态机。 */
export async function runHeldPackageBuild(plan, operations = productionOperations()) {
  if (!isPlainObject(plan) || !isPlainObject(plan.paths)) fail('invalid-plan')
  await recoverPackagePublication({
    activeGenerationId: plan.generationId,
    releaseRoot: plan.paths.releaseRoot,
  }).catch(() => fail('publication-recovery'))
  await prepareGenerationRoot(plan)
  return runPackageBuildPipeline(plan, operations)
}

function requireFinalVerificationAdapters(adapters) {
  const names = [
    'readBuildResult',
    'verifyCandidateSource',
    'verifyCandidatePackage',
    'publishGeneration',
    'verifyPublishedSource',
    'verifyPublishedPackage',
    'commitCurrent',
    'cleanupStaging',
  ]
  exactOptions(adapters, names)
  if (names.some((name) => typeof adapters[name] !== 'function')) {
    fail('final-verifier-adapters')
  }
  return adapters
}

/** final capability 内完成候选验证、目录原子发布及 current pointer 提交。 */
export async function runHeldFinalVerification(
  plan,
  suppliedAdapters = productionFinalVerificationAdapters(),
) {
  if (!isPlainObject(plan) || !isPlainObject(plan.paths)) fail('invalid-plan')
  const adapters = requireFinalVerificationAdapters(suppliedAdapters)
  const result = await adapters.readBuildResult(plan)
  if (
    !isPlainObject(result) ||
    result.notBeforeEpochSeconds !== plan.notBeforeEpochSeconds ||
    !SHA256_PATTERN.test(result.receiptSHA256 ?? '') ||
    !SHA256_PATTERN.test(result.sourceManifestSHA256 ?? '')
  ) {
    fail('build-result')
  }
  let context = Object.freeze({ plan, result })
  for (const name of [
    'verifyCandidateSource',
    'verifyCandidatePackage',
    'publishGeneration',
    'verifyPublishedSource',
    'verifyPublishedPackage',
    'commitCurrent',
  ]) {
    const extension = await adapters[name](context)
    if (extension !== undefined) {
      if (!isPlainObject(extension)) fail('final-verifier-result')
      context = Object.freeze({ ...context, ...extension })
    }
  }
  await adapters.cleanupStaging(context).catch(() => undefined)
  return result
}

/** current 提交前失败只回收未提交 generation，既有 current 永不受影响。 */
export async function runHeldBuildFinalVerification(plan, options = {}) {
  exactOptions(options, ['recoverPublication', 'verificationAdapters'])
  const recoverPublicationAdapter =
    options.recoverPublication ??
    (async (selectedPlan) =>
      recoverPackagePublication({ releaseRoot: selectedPlan.paths.releaseRoot }))
  if (typeof recoverPublicationAdapter !== 'function') fail('publication-recovery')
  try {
    return await runHeldFinalVerification(
      plan,
      options.verificationAdapters ?? productionFinalVerificationAdapters(),
    )
  } catch (error) {
    await recoverPublicationAdapter(plan).catch(() => fail('publication-recovery'))
    throw error
  }
}

/** 生成只读离线 Go 构建环境，并固定本机 macOS 目标。 */
export function createGoBuildEnvironment(plan, dependencies) {
  const environment = dependencies?.go?.environment
  if (!isPlainObject(plan) || !isPlainObject(plan.paths) || !isPlainObject(environment)) {
    fail('go-build-environment')
  }
  const workspace = dependencies?.go?.workspace
  const workspaceRelative =
    typeof workspace === 'string' && isAbsolute(workspace)
      ? relative(plan.paths.generationRoot, workspace)
      : undefined
  if (
    workspaceRelative === undefined ||
    workspaceRelative === '' ||
    workspaceRelative.startsWith(`..${sep}`) ||
    isAbsolute(workspaceRelative) ||
    environment.GOWORK !== workspace ||
    environment.GOTOOLCHAIN !== 'local' ||
    environment.GOPROXY !== 'off'
  ) {
    fail('go-build-environment')
  }
  return Object.freeze({
    ...environment,
    CGO_ENABLED: '0',
    GOARCH: plan.target.goarch,
    GOOS: plan.target.goos,
  })
}

function goEnvironment(context) {
  return createGoBuildEnvironment(context.plan, context.dependencies)
}

function nodePackageEnvironment(context, overrides = {}) {
  const base = context.dependencies?.node?.environment
  if (!isPlainObject(base) || !isPlainObject(overrides)) fail('node-build-environment')
  const environment = Object.assign(Object.create(null), base)
  for (const [name, value] of Object.entries(overrides)) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) ||
      typeof value !== 'string' ||
      value.includes('\0')
    ) {
      fail('node-build-environment')
    }
    environment[name] = value
  }
  return Object.freeze(environment)
}

function rustRemapFlags(plan) {
  // rustc 对同一路径采用后出现的映射；顺序固定为 HOME→repo→HOME/.cargo→共享缓存。
  // 注意：generationRoot/WORK_ROOT 均为 desktopRoot 子路径，由 desktopRoot remap 覆盖，
  // 不得单独 remap——否则 RUSTFLAGS 每次构建变化，cargo fingerprint 全变导致全量重编。
  return Object.freeze([
    `--remap-path-prefix=${plan.hostHome}=/build/home`,
    `--remap-path-prefix=${plan.desktopRoot}=/build/hexclaw-desktop`,
    `--remap-path-prefix=${join(plan.hostHome, '.cargo')}=/build/cargo`,
    `--remap-path-prefix=${plan.paths.sharedCargoHome}=/build/cargo`,
  ])
}

function cargoEnvironment(context, offline) {
  const { plan, toolchains } = context
  return nodePackageEnvironment(context, {
    CI: 'true',
    CARGO: toolchains.cargo.canonical,
    CARGO_ENCODED_RUSTFLAGS: rustRemapFlags(plan).join('\x1f'),
    CARGO_HOME: plan.paths.sharedCargoHome,
    CARGO_INCREMENTAL: '0',
    CARGO_NET_GIT_FETCH_WITH_CLI: 'false',
    CARGO_NET_OFFLINE: offline ? 'true' : 'false',
    CARGO_REGISTRIES_CRATES_IO_PROTOCOL: 'sparse',
    CARGO_TARGET_DIR: plan.paths.sharedCargoTarget,
    CARGO_TERM_COLOR: 'never',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    PATH: [
      dirname(toolchains.node.canonical),
      dirname(toolchains.cargo.canonical),
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
    ].join(delimiter),
    RUSTC: toolchains.rustc.canonical,
    RUSTC_WORKSPACE_WRAPPER: '',
    RUSTDOCFLAGS: '',
    RUSTFLAGS: '',
    RUSTUP_HOME: join(plan.hostHome, '.rustup'),
  })
}

async function runSensitiveBoundary(context, action, distRoot, appBundle) {
  const result = await runPackageCommand(
    context.toolchains.node.canonical,
    [SENSITIVE_BOUNDARY_PATH, action, '--app-bundle', appBundle, '--dist', distRoot],
    {
      cwd: context.plan.desktopRoot,
      env: cleanEnvironment(context.plan),
      timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
    },
  )
  if (result.code !== 0 || result.signal !== null) fail('sensitive-boundary')
}

async function runRootSensitiveBoundary(context, root, label) {
  const result = await runPackageCommand(
    context.toolchains.node.canonical,
    [SENSITIVE_BOUNDARY_PATH, 'verify-root', '--label', label, '--root', root],
    {
      cwd: context.plan.desktopRoot,
      env: cleanEnvironment(context.plan),
      timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
    },
  )
  if (result.code !== 0 || result.signal !== null) fail('sensitive-boundary')
}

function manifestRepositoryVCS(manifest, repositoryID) {
  if (!isPlainObject(manifest) || !Array.isArray(manifest.repositories)) {
    fail('source-vcs-metadata')
  }
  const matches = manifest.repositories.filter((repository) => repository?.id === repositoryID)
  if (matches.length !== 1) fail('source-vcs-metadata')
  const vcs = matches[0].vcs
  const keys = isPlainObject(vcs) ? Object.keys(vcs).sort() : []
  const expectedKeys = ['commitDate', 'describe', 'head', 'tags']
  if (
    !isPlainObject(vcs) ||
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index]) ||
    !/^[a-f0-9]{40,64}$/u.test(vcs.head ?? '') ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(
      vcs.commitDate ?? '',
    ) ||
    typeof vcs.describe !== 'string' ||
    vcs.describe.length === 0 ||
    Buffer.byteLength(vcs.describe, 'utf8') > 512 ||
    /[\s\u0000-\u001f\u007f]/u.test(vcs.describe) ||
    !Array.isArray(vcs.tags) ||
    vcs.tags.some(
      (tag) =>
        typeof tag !== 'string' ||
        tag.length === 0 ||
        Buffer.byteLength(tag, 'utf8') > 512 ||
        /[\s\u0000-\u001f\u007f]/u.test(tag),
    ) ||
    new Set(vcs.tags).size !== vcs.tags.length ||
    vcs.tags.some(
      (tag, index) =>
        index > 0 && Buffer.compare(Buffer.from(vcs.tags[index - 1]), Buffer.from(tag)) >= 0,
    )
  ) {
    fail('source-vcs-metadata')
  }
  return vcs
}

/** Sidecar 构建元数据只消费同一 source manifest 冻结的 VCS 记录。 */
export function sidecarBuildMetadataFromManifest(manifest) {
  const hexclaw = manifestRepositoryVCS(manifest, 'hexclaw')
  const hexagon = manifestRepositoryVCS(manifest, 'hexagon')
  return Object.freeze({
    buildDate: hexclaw.commitDate,
    commit: hexclaw.head.slice(0, 12),
    hexagonVersion: hexagon.describe,
  })
}

function validateOllamaContract(contract) {
  if (
    !isPlainObject(contract) ||
    !Object.isFrozen(contract) ||
    !Number.isSafeInteger(contract.archiveBytes) ||
    contract.archiveBytes <= 0 ||
    !Number.isSafeInteger(contract.binaryBytes) ||
    contract.binaryBytes <= 0 ||
    !SHA256_PATTERN.test(contract.archiveSha256 ?? '') ||
    !SHA256_PATTERN.test(contract.binarySha256 ?? '') ||
    !/^[a-f0-9]{40}$/u.test(contract.vcsRevision ?? '') ||
    !/^[A-Za-z0-9._-]{1,128}$/u.test(contract.binaryName ?? '') ||
    typeof contract.modulePath !== 'string' ||
    typeof contract.moduleVersion !== 'string' ||
    typeof contract.packagePath !== 'string' ||
    typeof contract.url !== 'string' ||
    typeof contract.version !== 'string' ||
    typeof contract.goos !== 'string' ||
    typeof contract.vcsModified !== 'boolean' ||
    !Array.isArray(contract.architectures) ||
    contract.architectures.length === 0
  ) {
    fail('ollama-contract')
  }

  let archiveURL
  try {
    archiveURL = new URL(contract.url)
  } catch {
    fail('ollama-contract')
  }
  if (
    archiveURL.protocol !== 'https:' ||
    archiveURL.username !== '' ||
    archiveURL.password !== ''
  ) {
    fail('ollama-contract')
  }
  return contract
}

function productionOperations() {
  return {
    async createSourceManifest({ plan }) {
      const result = await createPackageSourceManifest({
        manifestPath: plan.paths.generationSourceManifest,
        target: plan.target.triple,
      }).catch(() => fail('source-manifest-create'))
      let toolchains
      try {
        toolchains = capturedBuildToolchains(result.toolchains)
        const manifest = await loadBoundSourceManifest(plan, result.sha256)
        return Object.freeze({ manifest, sha256: result.sha256, toolchains })
      } catch (error) {
        if (toolchains !== undefined) {
          await cleanupCapturedToolchains(toolchains, plan.paths.generationReleaseRoot)
        }
        throw error
      }
    },

    async cleanupToolchains({ plan, toolchains }) {
      await cleanupCapturedToolchains(toolchains, plan.paths.generationReleaseRoot)
    },

    async projectDesktopSource({ plan, sourceManifest }) {
      await projectPackageSourceFromManifest({
        manifest: sourceManifest,
        projectedWorkRoot: plan.paths.projectedWorkRoot,
        sourceWorkRoot: plan.workRoot,
      })
      await verifyProjectedPackageSourceFromManifest({
        allowDependencyTree: false,
        manifest: sourceManifest,
        projectedWorkRoot: plan.paths.projectedWorkRoot,
      })
    },

    async prepareFrontendDependencies(context) {
      return preparePackageDependencyProvenance(
        createDependencyProvenanceOptions(
          context.plan,
          context.toolchains,
          context.sourceManifestSHA256,
        ),
      ).catch((error) => failPackageDependency('dependency-provenance-prepare', error))
    },

    async verifyGoDependencies(context) {
      const { dependencies, plan, sourceManifestSHA256, toolchains } = context
      const verified = await verifyPackageDependencyProvenance(
        createDependencyProvenanceOptions(plan, toolchains, sourceManifestSHA256),
      ).catch((error) => failPackageDependency('dependency-provenance-verify', error))
      if (
        verified.go.executable !== dependencies.go.executable ||
        verified.node.executable !== dependencies.node.executable ||
        verified.node.pnpmExecutable !== dependencies.node.pnpmExecutable ||
        verified.receiptPath !== dependencies.receiptPath
      ) {
        fail('dependency-provenance-drift')
      }
      const expectedModules = [
        ['github.com/hexagon-codes/toolkit', join(plan.paths.projectedWorkRoot, 'toolkit')],
        ['github.com/hexagon-codes/ai-core', join(plan.paths.projectedWorkRoot, 'ai-core')],
        ['github.com/hexagon-codes/hexagon', join(plan.paths.projectedWorkRoot, 'hexagon')],
        ['github.com/hexagon-codes/hexclaw', join(plan.paths.projectedWorkRoot, 'hexclaw')],
      ]
      const listed = await runPackageCommand(
        dependencies.go.executable,
        [
          'list',
          '-m',
          '-f',
          '{{.Path}}\t{{.Dir}}\t{{.Main}}',
          ...expectedModules.map(([module]) => module),
        ],
        {
          cwd: join(plan.paths.projectedWorkRoot, 'hexclaw'),
          env: goEnvironment(context),
          timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
        },
      )
      const lines = listed.stdout.trim().split('\n')
      if (lines.length !== expectedModules.length) fail('go-workspace')
      for (let index = 0; index < expectedModules.length; index += 1) {
        const [module, directory, main] = lines[index].split('\t')
        if (
          module !== expectedModules[index][0] ||
          directory !== expectedModules[index][1] ||
          main !== 'true'
        ) {
          fail('go-workspace')
        }
      }
    },

    async stageRenderBundle(context) {
      const { plan, toolchains } = context
      const result = await runPackageCommand(
        FIXED_TOOLS.bash,
        [RENDER_BUNDLE_PATH, plan.paths.generationBinaries],
        {
          cwd: plan.desktopRoot,
          env: cleanEnvironment(plan, {
            PACKAGE_LOCAL_RUSTUP_HOME: join(plan.hostHome, '.rustup'),
            PACKAGE_LOCAL_SOURCE_HOME: plan.hostHome,
            RENDER_BUNDLE_CACHE_ROOT: plan.paths.cacheRoot,
            RENDER_BUNDLE_CARGO: toolchains.cargo.canonical,
            RENDER_BUNDLE_CARGO_SHA256: toolchains.cargo.executableSha256,
            RENDER_BUNDLE_MODE: 'source',
            RENDER_BUNDLE_NETWORK_TIMEOUT_SECONDS: '900',
            RENDER_BUNDLE_NODE: toolchains.node.canonical,
            RENDER_BUNDLE_NODE_SHA256: toolchains.node.executableSha256,
            RENDER_BUNDLE_OUTER_RUNNER: 'bounded-process-v1',
            RENDER_BUNDLE_RUSTC: toolchains.rustc.canonical,
            RENDER_BUNDLE_RUSTC_SHA256: toolchains.rustc.executableSha256,
            RENDER_BUNDLE_TARGET: plan.target.renderTarget,
            RENDER_BUNDLE_TOTAL_TIMEOUT_SECONDS: '3000',
          }),
          timeoutMs: BUILD_COMMAND_TIMEOUT_MS,
        },
      )
      if (result.code !== 0 || result.signal !== null) fail('render-bundle')
    },

    async buildSidecar(context) {
      const { dependencies, plan, sourceManifest } = context
      const hexclawRoot = join(plan.paths.projectedWorkRoot, 'hexclaw')
      const { buildDate, commit, hexagonVersion } = sidecarBuildMetadataFromManifest(sourceManifest)
      const output = join(plan.paths.generationBinaries, `hexclaw-${plan.target.triple}`)
      await runPackageCommand(
        dependencies.go.executable,
        [
          'build',
          '-trimpath',
          '-buildvcs=false',
          '-ldflags',
          `-s -w -X main.version=${plan.version} -X main.sidecarVersionIdentity=hexclaw-sidecar-version=${plan.version}; -X main.commit=${commit} -X main.date=${buildDate} -X github.com/hexagon-codes/hexagon.injectedVersion=${hexagonVersion}`,
          '-o',
          output,
          './cmd/hexclaw',
        ],
        {
          cwd: hexclawRoot,
          env: goEnvironment(context),
          timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
        },
      )
    },

    async verifySidecar(context) {
      const { dependencies, plan, toolchains } = context
      await sidecarVerifier
        .inspectSidecarArtifact(
          join(plan.paths.generationBinaries, `hexclaw-${plan.target.triple}`),
          plan.version,
          {
            goToolchain: {
              executable: dependencies.go.executable,
              executableSha256: toolchains.go.sourceSha256,
              goroot: toolchains.go.goroot,
            },
            snapshotRoot: plan.paths.generationRoot,
            targetTriple: plan.target.triple,
          },
        )
        .catch(() => fail('sidecar-identity'))
      await runRootSensitiveBoundary(context, plan.paths.generationBinaries, 'generation-binaries')
    },

    async stageOllama(context) {
      const { plan, toolchains } = context
      const contract = validateOllamaContract(getOllamaPackageContract())
      await makePrivateDirectory(dirname(plan.paths.sharedOllamaArchive), { recursive: true })
      // 宿主持久缓存：已存在且摘要匹配的官方归档直接复用，不重复下载（BUG-20260816-001）。
      const cached = await secureFileSHA256(
        plan.paths.sharedOllamaArchive,
        contract.archiveBytes,
      ).catch(() => undefined)
      if (
        cached === undefined ||
        cached.size !== contract.archiveBytes ||
        cached.sha256 !== contract.archiveSha256
      ) {
        await runPackageCommand(
          FIXED_TOOLS.curl,
          [
            '--disable',
            '--fail',
            '--location',
            '--max-filesize',
            String(contract.archiveBytes),
            '--max-redirs',
            '5',
            '--proto',
            '=https',
            '--proto-redir',
            '=https',
            '--silent',
            '--show-error',
            '--connect-timeout',
            '20',
            '--speed-limit',
            '1024',
            '--speed-time',
            '30',
            '--max-time',
            '1200',
            '--retry',
            '3',
            '--retry-delay',
            '2',
            '--retry-max-time',
            '1200',
            '--output',
            plan.paths.sharedOllamaArchive,
            contract.url,
          ],
          {
            cwd: plan.paths.generationRoot,
            env: cleanEnvironment(plan),
            timeoutMs: 21 * 60 * 1_000,
          },
        )
      }
      const archive = await secureFileSHA256(
        plan.paths.sharedOllamaArchive,
        contract.archiveBytes,
      )
      if (archive.size !== contract.archiveBytes || archive.sha256 !== contract.archiveSha256) {
        fail('ollama-archive-digest')
      }
      // 解包树由归档 sha256 完全决定：落到宿主持久缓存跨代复用，generation 内 clonefile 引用。
      const cachedTreeRoot = join(plan.paths.cacheRoot, `ollama-tree-${contract.archiveSha256.slice(0, 16)}`)
      const cachedTree = await lstat(cachedTreeRoot, { bigint: true }).catch((error) => {
        if (error?.code === 'ENOENT') return undefined
        fail('ollama-cache-state')
      })
      if (cachedTree === undefined) {
        await extractPinnedTarGzipArchive({
          appleDoubleContracts: OLLAMA_APPLEDOUBLE_CONTRACTS,
          archivePath: plan.paths.sharedOllamaArchive,
          destination: cachedTreeRoot,
          expectedArchiveBytes: contract.archiveBytes,
          expectedArchiveSha256: contract.archiveSha256,
          expectedBinaryBytes: contract.binaryBytes,
          expectedBinaryRelativePath: contract.binaryName,
          maxEntries: OLLAMA_ARCHIVE_MAX_ENTRIES,
          maxExpandedBytes: OLLAMA_EXPANDED_MAX_BYTES,
          maxFileBytes: OLLAMA_MEMBER_MAX_BYTES,
        })
      } else if (!cachedTree.isDirectory() || cachedTree.isSymbolicLink()) {
        fail('ollama-cache-state')
      }
      await runPackageCommand(
        FIXED_TOOLS.cp,
        ['-c', '-R', cachedTreeRoot, plan.paths.generationOllamaRoot],
        {
          cwd: plan.paths.generationRoot,
          env: cleanEnvironment(plan),
          timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
        },
      ).catch(() => fail('ollama-tree-copy'))
      return Object.freeze({ archiveSha256: archive.sha256, contract, toolchains })
    },

    async verifyOllama(context) {
      const { dependencies, plan, toolchains } = context
      const contract = context.ollama.contract
      await sidecarVerifier
        .inspectOllamaArtifact(join(plan.paths.generationOllamaRoot, contract.binaryName), {
          archiveBytes: contract.archiveBytes,
          archiveSha256: context.ollama.archiveSha256,
          archiveUrl: contract.url,
          goToolchain: {
            executable: dependencies.go.executable,
            executableSha256: toolchains.go.sourceSha256,
            goroot: toolchains.go.goroot,
          },
          snapshotRoot: plan.paths.generationRoot,
          targetTriple: plan.target.triple,
        })
        .catch(() => fail('ollama-identity'))
      await scanRegularTree(plan.paths.generationOllamaRoot)
      await runRootSensitiveBoundary(context, plan.paths.generationOllamaRoot, 'ollama')
    },

    async buildFrontend(context) {
      const { dependencies, plan } = context
      await runPackageCommand(
        dependencies.node.executable,
        [dependencies.node.pnpmExecutable, 'run', 'build:package-local'],
        {
          cwd: plan.paths.projectedDesktopRoot,
          env: nodePackageEnvironment(context, {
            CI: 'true',
            HEXCLAW_PACKAGE_LOCAL_DIST_DIR: plan.paths.generationDist,
          }),
          timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
        },
      ).catch(() => fail('frontend-build'))
      await cleanupFrontendTypecheckCache(plan)
    },

    async prepareCargoDependencies(context) {
      const { plan, toolchains } = context
      const cargoLock = await readSecureFileBytes(
        join(plan.paths.projectedDesktopRoot, 'src-tauri', 'Cargo.lock'),
        32 * 1024 * 1024,
      )
      if (/source\s*=\s*"git\+/u.test(cargoLock.toString('utf8'))) fail('cargo-git-source')
      await runPackageCommand(
        toolchains.cargo.canonical,
        ['fetch', '--locked', '--target', plan.target.triple],
        {
          cwd: join(plan.paths.projectedDesktopRoot, 'src-tauri'),
          env: cargoEnvironment(context, false),
          timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
        },
      ).catch(() => fail('cargo-fetch'))
      await runPackageCommand(
        toolchains.cargo.canonical,
        ['metadata', '--locked', '--offline', '--format-version', '1', '--no-deps'],
        {
          cwd: join(plan.paths.projectedDesktopRoot, 'src-tauri'),
          env: cargoEnvironment(context, true),
          timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
        },
      ).catch(() => fail('cargo-metadata'))
    },

    async buildTauriApp(context) {
      const { dependencies, plan } = context
      await writePrivateFileExclusive(
        plan.paths.tauriOverlay,
        Buffer.from(`${JSON.stringify(createTauriPackageOverlay(plan), null, 2)}\n`, 'utf8'),
      )
      await runPackageCommand(
        dependencies.node.executable,
        [
          dependencies.node.pnpmExecutable,
          'exec',
          'tauri',
          'build',
          '--target',
          plan.target.triple,
          '--config',
          join(plan.paths.projectedDesktopRoot, 'src-tauri', 'tauri.package-local.conf.json'),
          '--config',
          plan.paths.tauriOverlay,
          '--bundles',
          'app',
        ],
        {
          cwd: plan.paths.projectedDesktopRoot,
          env: cargoEnvironment(context, true),
          timeoutMs: BUILD_COMMAND_TIMEOUT_MS,
        },
      ).catch(() => fail('tauri-build'))
    },

    async verifyAppResources({ plan }) {
      // 校验 generation 私有副本（stageReleaseApp 已复制），不直接扫描共享 builtApp：
      // 共享产物可能被残留构建重建，扫描私有副本可避免 tree-metadata 竞态。
      const appMacOS = join(plan.paths.generationApp, 'Contents', 'MacOS')
      await assertExactRegularTrees(
        plan.paths.generationOllamaRoot,
        join(plan.paths.generationApp, 'Contents', 'Resources', 'ollama'),
      )
      for (const name of ['hexclaw', 'pandoc', 'typst']) {
        const source = join(plan.paths.generationBinaries, `${name}-${plan.target.triple}`)
        const packaged = join(appMacOS, name)
        const [sourceIdentity, packagedIdentity] = await Promise.all([
          secureFileSHA256(source, 1024 * 1024 * 1024),
          secureFileSHA256(packaged, 1024 * 1024 * 1024),
        ])
        if (
          sourceIdentity.size !== packagedIdentity.size ||
          sourceIdentity.sha256 !== packagedIdentity.sha256
        ) {
          fail('sidecar-resource-identity')
        }
      }
    },

    async stageReleaseApp({ plan }) {
      await moveBuiltAppIntoReleaseGeneration(plan)
    },

    async verifySourceManifest(context) {
      const { dependencies, plan, sourceManifest, sourceManifestSHA256, toolchains } = context
      const verifiedDependencies = await verifyPackageDependencyProvenance(
        createDependencyProvenanceOptions(plan, toolchains, sourceManifestSHA256),
      ).catch((error) => failPackageDependency('dependency-provenance-drift', error))
      if (
        verifiedDependencies.go.executable !== dependencies.go.executable ||
        verifiedDependencies.node.executable !== dependencies.node.executable ||
        verifiedDependencies.node.pnpmExecutable !== dependencies.node.pnpmExecutable ||
        verifiedDependencies.receiptPath !== dependencies.receiptPath
      ) {
        fail('dependency-provenance-drift')
      }
      await verifyProjectedPackageSourceFromManifest({
        allowDependencyTree: true,
        manifest: sourceManifest,
        projectedWorkRoot: plan.paths.projectedWorkRoot,
      })
      const result = await verifyPackageSourceManifest({
        expectedSha256: sourceManifestSHA256,
        manifestPath: plan.paths.generationSourceManifest,
        target: plan.target.triple,
      }).catch(() => fail('source-manifest-drift'))
      if (result.sha256 !== sourceManifestSHA256 || result.toolchains !== undefined) {
        fail('source-manifest-drift')
      }
    },

    async sanitizeAndVerify(context) {
      const { plan } = context
      await runSensitiveBoundary(
        context,
        'sanitize',
        plan.paths.generationDist,
        plan.paths.generationApp,
      )
      await runSensitiveBoundary(
        context,
        'verify',
        plan.paths.generationDist,
        plan.paths.generationApp,
      )
    },

    async createDmg(context) {
      const { plan } = context
      await makePrivateDirectory(plan.paths.generationDmgRoot)
      const dmgApp = join(plan.paths.generationDmgRoot, 'HexClaw.app')
      await runPackageCommand(
        FIXED_TOOLS.ditto,
        ['--norsrc', '--noextattr', '--noqtn', '--noacl', plan.paths.generationApp, dmgApp],
        {
          cwd: plan.paths.generationRoot,
          env: cleanEnvironment(plan),
          timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
        },
      )
      await symlink('/Applications', join(plan.paths.generationDmgRoot, 'Applications')).catch(() =>
        fail('dmg-symlink'),
      )
      await runSensitiveBoundary(context, 'verify', plan.paths.generationDist, dmgApp)
      await runPackageCommand(
        FIXED_TOOLS.hdiutil,
        [
          'create',
          '-volname',
          'HexClaw',
          '-srcfolder',
          plan.paths.generationDmgRoot,
          '-format',
          'UDZO',
          '-imagekey',
          'zlib-level=6',
          plan.paths.generationDmg,
        ],
        {
          cwd: plan.paths.generationRoot,
          env: cleanEnvironment(plan),
          timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
        },
      )
    },

    async createAttestation({ plan, sourceManifestSHA256 }) {
      return createReleaseAttestation({
        distRoot: plan.paths.generationDist,
        generationId: plan.generationId,
        installedAppBinary: join(plan.paths.generationApp, 'Contents', 'MacOS', 'hexclaw-desktop'),
        manifestPath: plan.paths.generationManifest,
        packagePath: plan.paths.generationDmg,
        receiptPath: plan.paths.generationReceipt,
        releaseVersion: plan.version,
        sidecarBinary: join(plan.paths.generationApp, 'Contents', 'MacOS', 'hexclaw'),
        sourceManifestPath: plan.paths.generationSourceManifest,
        sourceManifestSHA256,
        targetTriple: plan.target.triple,
      }).catch(() => fail('attestation-create'))
    },

    async verifyStagedPackage(context) {
      await verifyPackageLocal(packageVerificationOptions(context.plan, context, 'generation'), {
        verifyReadiness: async () => undefined,
      }).catch(() => fail('staged-verification'))
    },

    async writeBuildResult(context) {
      await writeBuildResult(context.plan, context)
    },

    async cleanupStaging({ plan }) {
      await cleanupPackageStaging({ layout: plan.publication })
    },
  }
}

function productionFinalVerificationAdapters() {
  return Object.freeze({
    async readBuildResult(plan) {
      return readBuildResult(plan, 'generation')
    },

    async verifyCandidateSource({ plan, result }) {
      const verified = await verifyPackageSourceManifest({
        expectedSha256: result.sourceManifestSHA256,
        manifestPath: plan.paths.generationSourceManifest,
        target: plan.target.triple,
      }).catch(() => fail('source-manifest-drift'))
      if (verified.sha256 !== result.sourceManifestSHA256 || verified.toolchains !== undefined) {
        fail('source-manifest-drift')
      }
      const sourceManifest = await loadBoundSourceManifest(
        plan,
        result.sourceManifestSHA256,
        plan.paths.generationSourceManifest,
      )
      return Object.freeze({
        sourceManifest,
        sourceManifestSHA256: result.sourceManifestSHA256,
      })
    },

    async verifyCandidatePackage({ plan, result }) {
      await verifyPackageLocal(packageVerificationOptions(plan, result, 'generation'), {
        verifyReadiness: async () => undefined,
      }).catch(() => fail('candidate-verification'))
    },

    async publishGeneration({ plan }) {
      const published = await publishPackageGeneration({ layout: plan.publication }).catch(
        (error) => {
          if (error instanceof PackagePublicationError) fail(`publication-${error.category}`)
          fail('publication-internal')
        },
      )
      if (!SHA256_PATTERN.test(published.generationSHA256 ?? '')) fail('publication-identity')
      return Object.freeze({ generationSHA256: published.generationSHA256 })
    },

    async verifyPublishedSource({ plan, result }) {
      const verified = await verifyPackageSourceManifest({
        expectedSha256: result.sourceManifestSHA256,
        manifestPath: plan.paths.publishedSourceManifest,
        target: plan.target.triple,
      }).catch(() => fail('published-source-manifest'))
      if (verified.sha256 !== result.sourceManifestSHA256 || verified.toolchains !== undefined) {
        fail('published-source-manifest')
      }
    },

    async verifyPublishedPackage({ plan, result }) {
      await verifyPackageLocal(packageVerificationOptions(plan, result, 'published'), {
        verifyReadiness: async () => undefined,
      }).catch(() => fail('published-verification'))
    },

    async commitCurrent({ generationSHA256, plan, result }) {
      await commitPackageGeneration({
        generationSHA256,
        layout: plan.publication,
        receiptSHA256: result.receiptSHA256,
        releaseVersion: plan.version,
        sourceManifestSHA256: result.sourceManifestSHA256,
        targetTriple: plan.target.triple,
      }).catch((error) => {
        if (error instanceof PackagePublicationError) fail(`publication-${error.category}`)
        fail('publication-internal')
      })
    },

    async cleanupStaging({ plan }) {
      await cleanupPackageStaging({ layout: plan.publication })
    },
  })
}

async function readProductionVersion() {
  const bytes = await readSecureFileBytes(join(DESKTOP_ROOT, 'package.json'), 1024 * 1024)
  let manifest
  try {
    manifest = JSON.parse(bytes.toString('utf8'))
  } catch {
    fail('package-manifest')
  }
  if (!isPlainObject(manifest) || !VERSION_PATTERN.test(manifest.version ?? '')) {
    fail('package-manifest')
  }
  return manifest.version
}

function nativeTargetTriple() {
  if (process.platform !== 'darwin') fail('unsupported-platform')
  if (process.arch === 'x64') return 'x86_64-apple-darwin'
  if (process.arch === 'arm64') return 'aarch64-apple-darwin'
  fail('unsupported-architecture')
}

async function createProductionPlan({ generationId, notBeforeEpochSeconds }) {
  const desktopRoot = await realpath(DESKTOP_ROOT).catch(() => fail('desktop-root'))
  if (desktopRoot !== DESKTOP_ROOT) fail('desktop-root')
  const hostHome = await realpath(homedir()).catch(() => fail('host-home'))
  return createPackageLocalPlan({
    desktopRoot,
    generationId,
    hostHome,
    notBeforeEpochSeconds,
    targetTriple: nativeTargetTriple(),
    version: await readProductionVersion(),
  })
}

function parseHeldArguments(argv) {
  const expected = ['--generation-id', '--not-before-epoch-seconds', '--target-triple', '--version']
  if (argv.length !== expected.length * 2) fail('cli-input')
  const values = Object.create(null)
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!expected.includes(name) || typeof value !== 'string' || Object.hasOwn(values, name)) {
      fail('cli-input')
    }
    values[name] = value
  }
  if (expected.some((name) => values[name] === undefined)) fail('cli-input')
  const notBeforeEpochSeconds = Number(values['--not-before-epoch-seconds'])
  if (!Number.isSafeInteger(notBeforeEpochSeconds) || notBeforeEpochSeconds <= 0) {
    fail('cli-input')
  }
  return Object.freeze({
    generationId: values['--generation-id'],
    notBeforeEpochSeconds,
    targetTriple: values['--target-triple'],
    version: values['--version'],
  })
}

async function planFromHeldArguments(argv, phase) {
  const requested = parseHeldArguments(argv)
  const plan = await createProductionPlan(requested)
  if (plan.target.triple !== requested.targetTriple || plan.version !== requested.version) {
    fail('generation-context')
  }
  await consumePackageGenerationCapability({
    expectedGenerationId: plan.generationId,
    expectedLockPath: plan.paths.lock,
    expectedPlanRoot: plan.paths.generationRoot,
    phase,
  }).catch(() => fail('generation-capability'))
  return plan
}

async function resolvePublishedPlan() {
  const base = await createProductionPlan({
    generationId: '0'.repeat(32),
    notBeforeEpochSeconds: 1,
  })
  const resolved = await resolveCurrentPackageGeneration({
    releaseRoot: base.paths.releaseRoot,
    releaseVersion: base.version,
    targetTriple: base.target.triple,
  }).catch((error) => {
    if (error instanceof PackagePublicationError) fail(`publication-${error.category}`)
    fail('publication-internal')
  })
  const interim = await createProductionPlan({
    generationId: resolved.generationId,
    notBeforeEpochSeconds: 1,
  })
  const result = await readBuildResult(interim, 'published')
  const plan = await createProductionPlan({
    generationId: resolved.generationId,
    notBeforeEpochSeconds: result.notBeforeEpochSeconds,
  })
  if (
    resolved.generationRoot !== plan.paths.publishedGenerationRoot ||
    resolved.receiptSHA256 !== result.receiptSHA256 ||
    resolved.sourceManifestSHA256 !== result.sourceManifestSHA256
  ) {
    fail('publication-identity')
  }
  return Object.freeze({ plan, result })
}

async function verifyPublishedPackage() {
  const { plan, result } = await resolvePublishedPlan()
  const verified = await verifyPackageSourceManifest({
    expectedSha256: result.sourceManifestSHA256,
    manifestPath: plan.paths.publishedSourceManifest,
    target: plan.target.triple,
  }).catch(() => fail('published-source-manifest'))
  if (verified.sha256 !== result.sourceManifestSHA256 || verified.toolchains !== undefined) {
    fail('published-source-manifest')
  }
  await verifyPackageLocal(packageVerificationOptions(plan, result, 'published'), {
    verifyReadiness: async () => undefined,
  }).catch(() => fail('published-verification'))
  return result
}

function safeCLIError(error) {
  const category =
    error instanceof PackageLocalError
      ? error.category
      : error instanceof PackageGenerationLockError
        ? `lock-${error.category}`
        : 'internal'
  const fields = [`ERROR: package-local category=${category}`]
  if (Number.isInteger(error?.exitCode)) fields.push(`exit=${error.exitCode}`)
  if (/^[A-Z0-9]+$/u.test(error?.signal ?? '')) fields.push(`signal=${error.signal}`)
  return fields.join(' ')
}

async function main(argv) {
  const action = argv[0]
  if (action === 'build') {
    if (argv.length !== 1) fail('cli-input')
    const plan = await createProductionPlan({
      generationId: randomBytes(16).toString('hex'),
      notBeforeEpochSeconds: Math.floor(Date.now() / 1_000),
    })
    await runPackageLocalBuild(plan)
    process.stdout.write('PASS: package-local category=complete\n')
    return
  }
  if (action === 'verify') {
    if (argv.length !== 1) fail('cli-input')
    await verifyPublishedPackage()
    process.stdout.write('PASS: package-local category=verified\n')
    return
  }
  if (action === 'build-held') {
    await runHeldPackageBuild(await planFromHeldArguments(argv.slice(1), 'build'))
    return
  }
  if (action === 'verify-held') {
    await runHeldBuildFinalVerification(await planFromHeldArguments(argv.slice(1), 'final'))
    return
  }
  fail('cli-input')
}

if (resolve(process.argv[1] ?? '') === MODULE_PATH) {
  Promise.resolve()
    .then(() => main(process.argv.slice(2)))
    .catch((error) => {
      process.stderr.write(`${safeCLIError(error)}\n`)
      process.exitCode = 1
    })
}
