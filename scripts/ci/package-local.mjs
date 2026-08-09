#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { createGunzip } from 'node:zlib'

import { createReleaseAttestation } from './k12-release-ui-attestation.mjs'
import {
  preparePackageDependencyProvenance,
  verifyPackageDependencyProvenance,
} from './package-dependency-provenance.mjs'
import {
  assertPackageGenerationReady,
  PACKAGE_GENERATION_CONTROL_BASENAME,
  PACKAGE_GENERATION_CONTEXT_ENV,
  PACKAGE_GENERATION_LOCK_BASENAME,
  PACKAGE_GENERATION_PLAN_PARENT_BASENAME,
  PACKAGE_GENERATION_TOMBSTONE_BASENAME,
  PackageGenerationLockError,
  runWithPackageGenerationLock,
} from './package-generation-lock.mjs'
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
const PACKAGE_RESULT_SCHEMA = 'hexclaw.package-local-result.v1'
const MODULE_PATH = fileURLToPath(import.meta.url)
const DESKTOP_ROOT = resolve(dirname(MODULE_PATH), '..', '..')
const SENSITIVE_BOUNDARY_PATH = join(DESKTOP_ROOT, 'scripts', 'ci', 'package-sensitive-boundary.mjs')
const RENDER_BUNDLE_PATH = join(DESKTOP_ROOT, 'release', 'scripts', 'render-bundle.sh')

const FIXED_TOOLS = Object.freeze({
  bash: '/bin/bash',
  curl: '/usr/bin/curl',
  ditto: '/usr/bin/ditto',
  git: '/usr/bin/git',
  hdiutil: '/usr/bin/hdiutil',
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

const PIPELINE_OPERATION_NAMES = Object.freeze([
  'invalidateCanonical',
  'createSourceManifest',
  'resolveToolchains',
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
  'verifySourceManifest',
  'sanitizeAndVerify',
  'createDmg',
  'createAttestation',
  'verifyStagedPackage',
  'publishDist',
  'publishApp',
  'publishDmg',
  'publishManifest',
  'publishSourceManifest',
  'writeBuildResult',
  'publishReceipt',
  'cleanupCanonical',
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
export function createDependencyProvenanceOptions(plan, toolchains) {
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
    !SHA256_PATTERN.test(toolchains.pnpm.executableSha256 ?? '')
  ) {
    fail('dependency-provenance-options')
  }
  return Object.freeze({
    generationRoot: plan.paths.generationRoot,
    go: Object.freeze({
      executable: toolchains.go.canonical,
      goWork: plan.paths.projectedGoWork,
      goroot: toolchains.go.goroot,
      moduleRoots: plan.paths.projectedGoModuleRoots,
      sha256: toolchains.go.executableSha256,
    }),
    node: Object.freeze({
      executable: toolchains.node.canonical,
      sha256: toolchains.node.executableSha256,
    }),
    pnpm: Object.freeze({
      executable: toolchains.pnpm.canonical,
      sha256: toolchains.pnpm.executableSha256,
    }),
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

async function makePrivateDirectory(pathname, options = {}) {
  await mkdir(pathname, {
    mode: PRIVATE_DIRECTORY_MODE,
    recursive: options.recursive === true,
  }).catch(() => fail('directory-create'))
  await chmod(pathname, PRIVATE_DIRECTORY_MODE).catch(() => fail('directory-permissions'))
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
      !sameMetadataIdentity(
        metadataIdentity(sourcePathMetadata),
        metadataIdentity(sourceBefore),
      )
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
  return Object.freeze(
    await copyManifestRecords(desktopRoot, projectedRoot, repositories[0].files),
  )
}

/** 将五仓与 go.work 按同一 source manifest 投影到唯一 generation。 */
export async function projectPackageSourceFromManifest(options) {
  exactOptions(options, ['manifest', 'projectedWorkRoot', 'sourceWorkRoot'])
  const sourceWorkRoot = absolutePath(options.sourceWorkRoot, 'source-projection-root')
  const projectedWorkRoot = absolutePath(options.projectedWorkRoot, 'source-projection-root')
  if (
    !isPlainObject(options.manifest) ||
    !Array.isArray(options.manifest.repositories) ||
    !isPlainObject(options.manifest.workspace) ||
    !Array.isArray(options.manifest.workspace.files)
  ) {
    fail('source-projection-manifest')
  }
  const expectedRepositories = ['ai-core', 'hexagon', 'hexclaw', 'hexclaw-desktop', 'toolkit']
  const repositories = [...options.manifest.repositories].sort((left, right) =>
    Buffer.compare(Buffer.from(left?.id ?? ''), Buffer.from(right?.id ?? '')),
  )
  if (
    repositories.length !== expectedRepositories.length ||
    repositories.some((repository, index) => repository?.id !== expectedRepositories[index])
  ) {
    fail('source-projection-manifest')
  }
  const workspacePaths = options.manifest.workspace.files.map((file) => file?.path).sort()
  if (
    workspacePaths.length < 1 ||
    workspacePaths.length > 2 ||
    workspacePaths[0] !== 'go.work' ||
    (workspacePaths.length === 2 && workspacePaths[1] !== 'go.work.sum')
  ) {
    fail('source-projection-manifest')
  }

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
  const workspace = await copyManifestRecords(
    sourceWorkRoot,
    projectedWorkRoot,
    options.manifest.workspace.files,
  )
  copiedBytes += workspace.copiedBytes
  copiedFiles += workspace.copiedFiles
  return Object.freeze({ copiedBytes, copiedFiles })
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
      const length = Number(
        remaining > BigInt(buffer.length) ? BigInt(buffer.length) : remaining,
      )
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
    TMPDIR: tmpdir(),
  })
}

async function runPackageCommand(command, args, options) {
  try {
    return await runBoundedProcess(command, args, {
      acceptedExitCodes: options.acceptedExitCodes,
      cwd: options.cwd,
      env: options.env,
      maxOutputBytes: options.maxOutputBytes ?? DEFAULT_COMMAND_OUTPUT_BYTES,
      terminateConfirmMs: 5_000,
      terminateGraceMs: 5_000,
      timeoutMs: options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
    })
  } catch (error) {
    if (error instanceof BoundedProcessError) {
      fail(`command-${error.category}`, {
        exitCode: error.exitCode,
        signal: error.signal,
      })
    }
    fail('command-internal')
  }
}

async function resolveExecutableFromPath(name, pathValue) {
  if (!/^[A-Za-z0-9._-]+$/u.test(name)) fail('toolchain')
  for (const directory of pathValue.split(':')) {
    if (!isAbsolute(directory)) continue
    const candidate = join(directory, name)
    try {
      const canonical = await realpath(candidate)
      const metadata = await lstat(canonical, { bigint: true })
      if (!metadata.isFile() || Number(metadata.mode & 0o111n) === 0) continue
      return Object.freeze({ canonical, invocation: candidate })
    } catch {
      // 当前固定目录中不存在该工具时继续检查下一项。
    }
  }
  fail('toolchain')
}

async function resolveRustExecutable(name, environment, plan) {
  const selected = await resolveExecutableFromPath(name, environment.PATH)
  const rustup = await resolveExecutableFromPath('rustup', environment.PATH).catch(() => undefined)
  if (!rustup || selected.canonical !== rustup.canonical) return selected
  const result = await runPackageCommand(rustup.canonical, ['which', name], {
    cwd: plan.desktopRoot,
    env: environment,
    maxOutputBytes: 64 * 1024,
    timeoutMs: 15_000,
  })
  const reported = result.stdout.trim()
  if (!isAbsolute(reported) || reported.includes('\0') || result.stderr !== '') fail('toolchain')
  const canonical = await realpath(reported).catch(() => fail('toolchain'))
  const metadata = await lstat(canonical, { bigint: true }).catch(() => fail('toolchain'))
  if (!metadata.isFile() || Number(metadata.mode & 0o111n) === 0) fail('toolchain')
  return Object.freeze({ canonical, invocation: canonical })
}

async function requireToolDigest(tool, expectedSha256) {
  if (!SHA256_PATTERN.test(expectedSha256 ?? '')) fail('toolchain-manifest')
  const identity = await secureFileSHA256(tool.canonical, 1024 * 1024 * 1024)
  if (identity.sha256 !== expectedSha256) fail('toolchain-digest')
  return Object.freeze({ ...tool, executableSha256: identity.sha256 })
}

async function bindManifestToolchains(plan, manifest) {
  const recorded = manifest?.toolchains
  if (!isPlainObject(recorded)) fail('toolchain-manifest')
  const environment = sourceIdentityEnvironment(plan)
  const [go, pnpm, cargo, rustc] = await Promise.all([
    resolveExecutableFromPath('go', environment.PATH),
    resolveExecutableFromPath('pnpm', environment.PATH),
    resolveRustExecutable('cargo', environment, plan),
    resolveRustExecutable('rustc', environment, plan),
  ])
  const nodeCanonical = await realpath(process.execPath).catch(() => fail('toolchain'))
  const node = Object.freeze({ canonical: nodeCanonical, invocation: nodeCanonical })
  const gitCanonical = await realpath(FIXED_TOOLS.git).catch(() => fail('toolchain'))
  const git = Object.freeze({ canonical: gitCanonical, invocation: gitCanonical })
  const [boundGo, boundPnpm, boundCargo, boundRustc, boundNode, boundGit] = await Promise.all([
    requireToolDigest(go, recorded.go?.executableSha256),
    requireToolDigest(pnpm, recorded.pnpm?.executableSha256),
    requireToolDigest(cargo, recorded.cargo?.executableSha256),
    requireToolDigest(rustc, recorded.rustc?.executableSha256),
    requireToolDigest(node, recorded.node?.executableSha256),
    requireToolDigest(git, recorded.git?.executableSha256),
  ])
  const goroot = recorded.go?.env?.GOROOT
  if (typeof goroot !== 'string' || !isAbsolute(goroot)) fail('toolchain-manifest')
  return Object.freeze({
    cargo: boundCargo,
    git: boundGit,
    go: Object.freeze({ ...boundGo, goroot: resolve(goroot) }),
    node: boundNode,
    pnpm: boundPnpm,
    rustc: boundRustc,
  })
}

async function loadBoundSourceManifest(
  plan,
  expectedSha256,
  manifestPath = plan.paths.generationSourceManifest,
) {
  const bytes = await readSecureFileBytes(
    manifestPath,
    SOURCE_MANIFEST_MAX_BYTES,
  )
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
    manifest.schema !== 'hexclaw.package-source-identity.v1' ||
    manifest.target !== plan.target.triple
  ) {
    fail('source-manifest-contract')
  }
  return manifest
}

async function removeCanonicalArtifacts(plan) {
  for (const pathname of plan.canonicalArtifacts) {
    await rm(pathname, { force: true, recursive: true }).catch(() => fail('canonical-cleanup'))
  }
  for (const pathname of plan.canonicalArtifacts) {
    const exists = await lstat(pathname).then(
      () => true,
      (error) => {
        if (error?.code === 'ENOENT') return false
        fail('canonical-cleanup')
      },
    )
    if (exists) fail('canonical-cleanup')
  }
}

async function publishPath(source, destination) {
  const sourceMetadata = await lstat(source, { bigint: true }).catch(() => fail('publish-source'))
  if (sourceMetadata.isSymbolicLink()) fail('publish-source')
  const destinationExists = await lstat(destination).then(
    () => true,
    (error) => {
      if (error?.code === 'ENOENT') return false
      fail('publish-destination')
    },
  )
  if (destinationExists) fail('publish-destination')
  await makePrivateDirectory(dirname(destination), { recursive: true })
  await rename(source, destination).catch(() => fail('publish-rename'))
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

function packageVerificationOptions(plan, result, canonical) {
  const prefix = canonical ? 'canonical' : 'generation'
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

async function readBuildResult(plan) {
  const bytes = await readSecureFileBytes(plan.paths.buildResult, RESULT_MAX_BYTES)
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
  const text = field.toString('ascii').replace(/[\0 ]+$/u, '').replace(/^ +/u, '')
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

/** 解压已固定摘要的 Ollama tar.gz；任何链接、特殊文件或路径逃逸都会在发布前拒绝。 */
export async function extractPinnedTarGzipArchive(options) {
  exactOptions(options, [
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

  try {
    await makePrivateDirectory(dirname(destination), { recursive: true })
    await makePrivateDirectory(destination)
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
        let entries = 0
        let files = 0
        let totalBytes = 0
        while (true) {
          const header = await reader.readExactly(512)
          if (header.every((value) => value === 0)) {
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
          if (type !== '0' && type !== '5') fail('ollama-archive')
          if (type === '5' && size !== 0) fail('ollama-archive')
          if (size > options.maxFileBytes) fail('ollama-archive')
          totalBytes += size
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
          } else {
            const outputMode = (archivedMode & 0o111) === 0 ? PRIVATE_FILE_MODE : 0o700
            await extractTarRegularFile(reader, outputPath, size, outputMode)
            files += 1
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
    await rm(destination, { force: true, recursive: true }).catch(() => undefined)
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

  const canonicalTarget = join(desktopRoot, 'src-tauri', 'target')
  const canonicalDmgDirectory = join(canonicalTarget, 'release', 'bundle', 'dmg')
  const generationRoot = join(
    canonicalDmgDirectory,
    PACKAGE_GENERATION_PLAN_PARENT_BASENAME,
    options.generationId,
  )
  const packageControlDirectory = join(
    canonicalDmgDirectory,
    PACKAGE_GENERATION_CONTROL_BASENAME,
  )
  const generationBinaries = join(generationRoot, 'binaries')
  const generationOllamaRoot = join(generationRoot, 'ollama')
  const generationCargoTarget = join(generationRoot, 'cargo-target')
  const projectedWorkRoot = join(generationRoot, 'source')
  const projectedDesktopRoot = join(projectedWorkRoot, 'hexclaw-desktop')
  const packageStem = `HexClaw_${options.version}_${target.dmgArchitecture}`
  const paths = Object.freeze({
    buildResult: join(generationRoot, 'package-local-result.json'),
    canonicalApp: join(canonicalTarget, 'release', 'bundle', 'macos', 'HexClaw.app'),
    canonicalDist: join(desktopRoot, 'dist'),
    canonicalDmg: join(canonicalDmgDirectory, `${packageStem}.dmg`),
    canonicalDmgDirectory,
    canonicalManifest: join(canonicalDmgDirectory, `${packageStem}.release-ui-dist-manifest.json`),
    canonicalReceipt: join(canonicalDmgDirectory, `${packageStem}.release-ui-attestation.json`),
    canonicalSourceManifest: join(canonicalDmgDirectory, 'package-source-manifest.json'),
    frontendNodeModules: join(projectedDesktopRoot, 'node_modules'),
    generationApp: join(
      generationCargoTarget,
      target.triple,
      'release',
      'bundle',
      'macos',
      'HexClaw.app',
    ),
    generationBinaries,
    generationCargoTarget,
    generationDist: join(generationRoot, 'dist'),
    generationDmg: join(generationRoot, `${packageStem}.dmg`),
    generationDmgRoot: join(generationRoot, 'dmg-root'),
    generationManifest: join(generationRoot, `${packageStem}.release-ui-dist-manifest.json`),
    generationOllamaArchive: join(generationRoot, 'downloads', 'ollama-darwin.tgz'),
    generationOllamaRoot,
    generationReceipt: join(generationRoot, `${packageStem}.release-ui-attestation.json`),
    generationRoot,
    generationSourceManifest: join(generationRoot, 'package-source-manifest.json'),
    lock: join(packageControlDirectory, PACKAGE_GENERATION_LOCK_BASENAME),
    privateCargoHome: join(generationRoot, 'cargo-home'),
    privateCargoTarget: generationCargoTarget,
    privateHome: join(generationRoot, 'home'),
    privateTemp: join(generationRoot, 'tmp'),
    projectedDesktopRoot,
    projectedGoModuleRoots: Object.freeze(
      ['toolkit', 'ai-core', 'hexagon', 'hexclaw'].map((name) => join(projectedWorkRoot, name)),
    ),
    projectedGoWork: join(projectedWorkRoot, 'go.work'),
    projectedWorkRoot,
    tauriOverlay: join(generationRoot, 'tauri.package-local.generated.json'),
    tombstone: join(packageControlDirectory, PACKAGE_GENERATION_TOMBSTONE_BASENAME),
  })
  const canonicalArtifacts = Object.freeze([
    paths.canonicalDist,
    paths.canonicalApp,
    paths.canonicalDmg,
    paths.canonicalManifest,
    paths.canonicalSourceManifest,
    paths.canonicalReceipt,
  ])
  return Object.freeze({
    canonicalArtifacts,
    desktopRoot,
    generationId: options.generationId,
    hostHome,
    notBeforeEpochSeconds,
    paths,
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
    command: Object.freeze([
      nodeExecutable,
      modulePath,
      'build-held',
      ...argumentsForPlan,
    ]),
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
  await mkdir(plan.paths.canonicalDmgDirectory, {
    mode: PRIVATE_DIRECTORY_MODE,
    recursive: true,
  }).catch(() => fail('control-directory'))
  const canonical = await realpath(plan.paths.canonicalDmgDirectory).catch(() =>
    fail('control-directory'),
  )
  if (canonical !== plan.paths.canonicalDmgDirectory) fail('control-directory')
  await chmod(plan.paths.canonicalDmgDirectory, PRIVATE_DIRECTORY_MODE).catch(() =>
    fail('control-directory'),
  )
  await assertPrivateDirectory(plan.paths.canonicalDmgDirectory)
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
  return Object.freeze({
    build: Object.freeze({
      beforeBuildCommand: '',
      frontendDist: plan.paths.generationDist,
    }),
    bundle: Object.freeze({
      createUpdaterArtifacts: false,
      externalBin: Object.freeze([
        join(plan.paths.generationBinaries, 'hexclaw'),
        join(plan.paths.generationBinaries, 'pandoc'),
        join(plan.paths.generationBinaries, 'typst'),
      ]),
      resources: Object.freeze({
        'binaries/ollama-bundle': null,
        'render-assets/*': 'assets/render/',
        [plan.paths.generationOllamaRoot]: 'ollama',
      }),
    }),
  })
}

/** 唯一构建状态机；失败时统一撤下全部 canonical 制品。 */
export async function runPackageBuildPipeline(plan, suppliedOperations) {
  if (!isPlainObject(plan) || !Array.isArray(plan.canonicalArtifacts)) fail('invalid-plan')
  const operations = requireOperations(suppliedOperations)
  let context = Object.freeze({
    canonicalArtifacts: plan.canonicalArtifacts,
    generationId: plan.generationId,
    plan,
    targetTriple: plan.target.triple,
  })
  try {
    await operations.invalidateCanonical(context)
    const sourceManifest = await operations.createSourceManifest(context)
    if (!/^[a-f0-9]{64}$/u.test(sourceManifest?.sha256 ?? '')) {
      fail('source-manifest-result')
    }
    context = Object.freeze({
      ...context,
      sourceManifest: sourceManifest.manifest,
      sourceManifestSHA256: sourceManifest.sha256,
    })
    const toolchains = await operations.resolveToolchains(context)
    context = Object.freeze({ ...context, toolchains })
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
    await operations.verifyAppResources(context)
    await operations.verifySourceManifest(context)
    await operations.sanitizeAndVerify(context)
    await operations.createDmg(context)
    const attestation = await operations.createAttestation(context)
    if (!/^[a-f0-9]{64}$/u.test(attestation?.receiptSHA256 ?? '')) {
      fail('attestation-result')
    }
    context = Object.freeze({ ...context, receiptSHA256: attestation.receiptSHA256 })
    await operations.verifyStagedPackage(context)
    await operations.publishDist(context)
    await operations.publishApp(context)
    await operations.publishDmg(context)
    await operations.publishManifest(context)
    await operations.publishSourceManifest(context)
    await operations.writeBuildResult(context)
    await operations.publishReceipt(context)
    return Object.freeze({
      generationId: plan.generationId,
      receiptSHA256: context.receiptSHA256,
      sourceManifestSHA256: context.sourceManifestSHA256,
      targetTriple: plan.target.triple,
    })
  } catch (error) {
    try {
      await operations.cleanupCanonical(
        Object.freeze({
          ...context,
          canonicalArtifacts: plan.canonicalArtifacts,
        }),
      )
    } catch {
      fail('canonical-cleanup')
    }
    throw error
  }
}

async function prepareGenerationRoot(plan) {
  const generationsRoot = dirname(plan.paths.generationRoot)
  await makePrivateDirectory(generationsRoot, { recursive: true })
  const existing = await lstat(plan.paths.generationRoot).then(
    () => true,
    (error) => {
      if (error?.code === 'ENOENT') return false
      fail('generation-state')
    },
  )
  if (existing) fail('generation-exists')
  await makePrivateDirectory(plan.paths.generationRoot)
  await Promise.all([
    makePrivateDirectory(plan.paths.privateHome),
    makePrivateDirectory(plan.paths.privateTemp),
    makePrivateDirectory(plan.paths.privateCargoHome),
  ])
}

/** lockf 持锁后创建唯一 generation，并进入唯一构建状态机。 */
export async function runHeldPackageBuild(plan, operations = productionOperations()) {
  if (!isPlainObject(plan) || !isPlainObject(plan.paths)) fail('invalid-plan')
  await prepareGenerationRoot(plan)
  return runPackageBuildPipeline(plan, operations)
}

function requireFinalVerificationAdapters(adapters) {
  const names = [
    'readBuildResult',
    'verifyCanonicalSource',
    'verifyDependencies',
    'verifyCanonicalResources',
    'verifyCanonicalPackage',
  ]
  exactOptions(adapters, names)
  if (names.some((name) => typeof adapters[name] !== 'function')) {
    fail('final-verifier-adapters')
  }
  return adapters
}

/** receipt 发布后仍在同一生命周期锁内完成 canonical 路径最终验证。 */
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
    'verifyCanonicalSource',
    'verifyDependencies',
    'verifyCanonicalResources',
    'verifyCanonicalPackage',
  ]) {
    const extension = await adapters[name](context)
    if (extension !== undefined) {
      if (!isPlainObject(extension)) fail('final-verifier-result')
      context = Object.freeze({ ...context, ...extension })
    }
  }
  return result
}

/** 生成只读离线 Go 构建环境，并固定本机 macOS 目标。 */
export function createGoBuildEnvironment(plan, dependencies) {
  const environment = dependencies?.go?.environment
  if (
    !isPlainObject(plan) ||
    !isPlainObject(plan.paths) ||
    !isPlainObject(environment) ||
    environment.GOWORK !== plan.paths.projectedGoWork ||
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
  // rustc 对同一路径采用后出现的映射；顺序固定为 HOME→repo→HOME/.cargo，再覆盖本轮私有目录。
  return Object.freeze([
    `--remap-path-prefix=${plan.hostHome}=/build/home`,
    `--remap-path-prefix=${plan.desktopRoot}=/build/hexclaw-desktop`,
    `--remap-path-prefix=${join(plan.hostHome, '.cargo')}=/build/cargo`,
    `--remap-path-prefix=${plan.paths.generationRoot}=/build/generation`,
    `--remap-path-prefix=${plan.paths.privateCargoHome}=/build/cargo`,
  ])
}

function cargoEnvironment(context, offline) {
  const { plan, toolchains } = context
  return nodePackageEnvironment(context, {
    CARGO: toolchains.cargo.canonical,
    CARGO_ENCODED_RUSTFLAGS: rustRemapFlags(plan).join('\x1f'),
    CARGO_HOME: plan.paths.privateCargoHome,
    CARGO_INCREMENTAL: '0',
    CARGO_NET_GIT_FETCH_WITH_CLI: 'false',
    CARGO_NET_OFFLINE: offline ? 'true' : 'false',
    CARGO_REGISTRIES_CRATES_IO_PROTOCOL: 'sparse',
    CARGO_TARGET_DIR: plan.paths.privateCargoTarget,
    CARGO_TERM_COLOR: 'never',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
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
    [
      SENSITIVE_BOUNDARY_PATH,
      action,
      '--app-bundle',
      appBundle,
      '--dist',
      distRoot,
    ],
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

async function gitValue(context, repository, args) {
  const result = await runPackageCommand(context.toolchains.git.canonical, args, {
    cwd: repository,
    env: cleanEnvironment(context.plan, {
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_OPTIONAL_LOCKS: '0',
    }),
    maxOutputBytes: 64 * 1024,
    timeoutMs: 15_000,
  })
  const value = result.stdout.trim()
  if (
    result.stderr !== '' ||
    value.length === 0 ||
    value.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail('git-metadata')
  }
  return value
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
  if (archiveURL.protocol !== 'https:' || archiveURL.username !== '' || archiveURL.password !== '') {
    fail('ollama-contract')
  }
  return contract
}

function productionOperations() {
  return {
    async invalidateCanonical({ plan }) {
      await removeCanonicalArtifacts(plan)
    },

    async createSourceManifest({ plan }) {
      const result = await createPackageSourceManifest({
        manifestPath: plan.paths.generationSourceManifest,
        target: plan.target.triple,
      }).catch(() => fail('source-manifest-create'))
      const manifest = await loadBoundSourceManifest(plan, result.sha256)
      return Object.freeze({ manifest, sha256: result.sha256 })
    },

    async resolveToolchains({ plan, sourceManifest }) {
      return bindManifestToolchains(plan, sourceManifest)
    },

    async projectDesktopSource({ plan, sourceManifest }) {
      await projectPackageSourceFromManifest({
        manifest: sourceManifest,
        projectedWorkRoot: plan.paths.projectedWorkRoot,
        sourceWorkRoot: plan.workRoot,
      })
    },

    async prepareFrontendDependencies(context) {
      return preparePackageDependencyProvenance(
        createDependencyProvenanceOptions(context.plan, context.toolchains),
      ).catch(() => fail('dependency-provenance-prepare'))
    },

    async verifyGoDependencies(context) {
      const { dependencies, plan, toolchains } = context
      const verified = await verifyPackageDependencyProvenance(
        createDependencyProvenanceOptions(plan, toolchains),
      ).catch(() => fail('dependency-provenance-verify'))
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
      const { dependencies, plan } = context
      const hexclawRoot = join(plan.paths.projectedWorkRoot, 'hexclaw')
      const [commit, buildDate, hexagonVersion] = await Promise.all([
        gitValue(context, hexclawRoot, ['rev-parse', '--short=12', 'HEAD']),
        gitValue(context, hexclawRoot, ['show', '-s', '--format=%cI', 'HEAD']),
        gitValue(context, join(plan.workRoot, 'hexagon'), [
          'describe',
          '--tags',
          '--always',
          '--dirty',
        ]),
      ])
      const output = join(plan.paths.generationBinaries, `hexclaw-${plan.target.triple}`)
      await runPackageCommand(
        dependencies.go.executable,
        [
          'build',
          '-trimpath',
          '-buildvcs=false',
          '-ldflags',
          `-s -w -X main.version=${plan.version} -X main.commit=${commit} -X main.date=${buildDate} -X github.com/hexagon-codes/hexagon.injectedVersion=${hexagonVersion}`,
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
              executableSha256: toolchains.go.executableSha256,
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
      await makePrivateDirectory(dirname(plan.paths.generationOllamaArchive), { recursive: true })
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
          plan.paths.generationOllamaArchive,
          contract.url,
        ],
        {
          cwd: plan.paths.generationRoot,
          env: cleanEnvironment(plan),
          timeoutMs: 21 * 60 * 1_000,
        },
      )
      const archive = await secureFileSHA256(
        plan.paths.generationOllamaArchive,
        contract.archiveBytes,
      )
      if (archive.size !== contract.archiveBytes || archive.sha256 !== contract.archiveSha256) {
        fail('ollama-archive-digest')
      }
      await extractPinnedTarGzipArchive({
        archivePath: plan.paths.generationOllamaArchive,
        destination: plan.paths.generationOllamaRoot,
        expectedArchiveBytes: contract.archiveBytes,
        expectedArchiveSha256: contract.archiveSha256,
        expectedBinaryBytes: contract.binaryBytes,
        expectedBinaryRelativePath: contract.binaryName,
        maxEntries: OLLAMA_ARCHIVE_MAX_ENTRIES,
        maxExpandedBytes: OLLAMA_EXPANDED_MAX_BYTES,
        maxFileBytes: OLLAMA_MEMBER_MAX_BYTES,
      })
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
            executableSha256: toolchains.go.executableSha256,
            goroot: toolchains.go.goroot,
          },
          snapshotRoot: plan.paths.generationRoot,
          targetTriple: plan.target.triple,
        })
        .catch(() => fail('ollama-identity'))
      await scanRegularTree(plan.paths.generationOllamaRoot)
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
      )
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
      )
      await runPackageCommand(
        toolchains.cargo.canonical,
        ['metadata', '--locked', '--offline', '--format-version', '1', '--no-deps'],
        {
          cwd: join(plan.paths.projectedDesktopRoot, 'src-tauri'),
          env: cargoEnvironment(context, true),
          timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
        },
      )
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
      )
    },

    async verifyAppResources({ plan }) {
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

    async verifySourceManifest(context) {
      const { dependencies, plan, sourceManifestSHA256, toolchains } = context
      const verifiedDependencies = await verifyPackageDependencyProvenance(
        createDependencyProvenanceOptions(plan, toolchains),
      ).catch(() => fail('dependency-provenance-drift'))
      if (
        verifiedDependencies.go.executable !== dependencies.go.executable ||
        verifiedDependencies.node.executable !== dependencies.node.executable ||
        verifiedDependencies.node.pnpmExecutable !== dependencies.node.pnpmExecutable ||
        verifiedDependencies.receiptPath !== dependencies.receiptPath
      ) {
        fail('dependency-provenance-drift')
      }
      const result = await verifyPackageSourceManifest({
        expectedSha256: sourceManifestSHA256,
        manifestPath: plan.paths.generationSourceManifest,
        target: plan.target.triple,
      }).catch(() => fail('source-manifest-drift'))
      if (result.sha256 !== sourceManifestSHA256) fail('source-manifest-drift')
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
        [
          '--norsrc',
          '--noextattr',
          '--noqtn',
          '--noacl',
          plan.paths.generationApp,
          dmgApp,
        ],
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
        installedAppBinary: join(
          plan.paths.generationApp,
          'Contents',
          'MacOS',
          'hexclaw-desktop',
        ),
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
      await verifyPackageLocal(packageVerificationOptions(context.plan, context, false), {
        verifyReadiness: async () => undefined,
      }).catch(() => fail('staged-verification'))
    },

    async publishDist({ plan }) {
      await publishPath(plan.paths.generationDist, plan.paths.canonicalDist)
    },

    async publishApp({ plan }) {
      await publishPath(plan.paths.generationApp, plan.paths.canonicalApp)
    },

    async publishDmg({ plan }) {
      await publishPath(plan.paths.generationDmg, plan.paths.canonicalDmg)
    },

    async publishManifest({ plan }) {
      await publishPath(plan.paths.generationManifest, plan.paths.canonicalManifest)
    },

    async publishSourceManifest({ plan }) {
      await publishPath(plan.paths.generationSourceManifest, plan.paths.canonicalSourceManifest)
    },

    async writeBuildResult(context) {
      await writeBuildResult(context.plan, context)
    },

    async publishReceipt({ plan }) {
      await publishPath(plan.paths.generationReceipt, plan.paths.canonicalReceipt)
    },

    async cleanupCanonical({ plan }) {
      await removeCanonicalArtifacts(plan)
    },
  }
}

function productionFinalVerificationAdapters() {
  return Object.freeze({
    readBuildResult,

    async verifyCanonicalSource({ plan, result }) {
      const verified = await verifyPackageSourceManifest({
        expectedSha256: result.sourceManifestSHA256,
        manifestPath: plan.paths.canonicalSourceManifest,
        target: plan.target.triple,
      }).catch(() => fail('source-manifest-drift'))
      if (verified.sha256 !== result.sourceManifestSHA256) fail('source-manifest-drift')
      const sourceManifest = await loadBoundSourceManifest(
        plan,
        result.sourceManifestSHA256,
        plan.paths.canonicalSourceManifest,
      )
      const toolchains = await bindManifestToolchains(plan, sourceManifest)
      return Object.freeze({ sourceManifest, toolchains })
    },

    async verifyDependencies({ plan, toolchains }) {
      const dependencies = await verifyPackageDependencyProvenance(
        createDependencyProvenanceOptions(plan, toolchains),
      ).catch(() => fail('dependency-provenance-drift'))
      return Object.freeze({ dependencies })
    },

    async verifyCanonicalResources({ dependencies, plan, toolchains }) {
      const appMacOS = join(plan.paths.canonicalApp, 'Contents', 'MacOS')
      const ollamaResources = join(plan.paths.canonicalApp, 'Contents', 'Resources', 'ollama')
      await assertExactRegularTrees(plan.paths.generationOllamaRoot, ollamaResources)
      await sidecarVerifier
        .inspectSidecarArtifact(join(appMacOS, 'hexclaw'), plan.version, {
          goToolchain: {
            executable: dependencies.go.executable,
            executableSha256: toolchains.go.executableSha256,
            goroot: toolchains.go.goroot,
          },
          snapshotRoot: join(plan.desktopRoot, 'src-tauri', 'target'),
          targetTriple: plan.target.triple,
        })
        .catch(() => fail('sidecar-identity'))
      const contract = validateOllamaContract(getOllamaPackageContract())
      await sidecarVerifier
        .inspectOllamaArtifact(join(ollamaResources, contract.binaryName), {
          archiveBytes: contract.archiveBytes,
          archiveSha256: contract.archiveSha256,
          archiveUrl: contract.url,
          goToolchain: {
            executable: dependencies.go.executable,
            executableSha256: toolchains.go.executableSha256,
            goroot: toolchains.go.goroot,
          },
          snapshotRoot: join(plan.desktopRoot, 'src-tauri', 'target'),
          targetTriple: plan.target.triple,
        })
        .catch(() => fail('ollama-identity'))
    },

    async verifyCanonicalPackage({ plan, result }) {
      await verifyPackageLocal(packageVerificationOptions(plan, result, true), {
        verifyReadiness: async () => undefined,
      }).catch(() => fail('canonical-verification'))
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
  const expected = [
    '--generation-id',
    '--not-before-epoch-seconds',
    '--target-triple',
    '--version',
  ]
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

function assertHeldGenerationContext(plan) {
  const encoded = process.env[PACKAGE_GENERATION_CONTEXT_ENV]
  let value
  try {
    value = JSON.parse(Buffer.from(encoded ?? '', 'base64url').toString('utf8'))
  } catch {
    fail('generation-context')
  }
  if (
    !isPlainObject(value) ||
    value.generationId !== plan.generationId ||
    value.lockPath !== plan.paths.lock ||
    value.tombstonePath !== plan.paths.tombstone
  ) {
    fail('generation-context')
  }
}

async function planFromHeldArguments(argv) {
  const requested = parseHeldArguments(argv)
  const plan = await createProductionPlan(requested)
  if (plan.target.triple !== requested.targetTriple || plan.version !== requested.version) {
    fail('generation-context')
  }
  assertHeldGenerationContext(plan)
  return plan
}

async function assertPublishedReady(plan) {
  try {
    await assertPackageGenerationReady({
      lockPath: plan.paths.lock,
      tombstonePath: plan.paths.tombstone,
    })
  } catch (error) {
    if (
      error instanceof PackageGenerationLockError &&
      (error.category === 'active' || error.category === 'in-progress')
    ) {
      fail('package-in-progress', { exitCode: error.exitCode, signal: error.signal })
    }
    fail('readiness')
  }
}

async function resolvePublishedPlan() {
  const base = await createProductionPlan({
    generationId: '0'.repeat(32),
    notBeforeEpochSeconds: 1,
  })
  await assertPublishedReady(base)
  const receiptBytes = await readSecureFileBytes(base.paths.canonicalReceipt, RESULT_MAX_BYTES)
  let receipt
  try {
    receipt = JSON.parse(receiptBytes.toString('utf8'))
  } catch {
    fail('canonical-receipt')
  }
  if (
    !isPlainObject(receipt) ||
    receipt.schema_version !== 2 ||
    receipt.release_version !== base.version ||
    receipt.target_triple !== base.target.triple ||
    !GENERATION_ID_PATTERN.test(receipt.generation_id ?? '') ||
    !SHA256_PATTERN.test(receipt.source_manifest_sha256 ?? '')
  ) {
    fail('canonical-receipt')
  }
  const interim = await createProductionPlan({
    generationId: receipt.generation_id,
    notBeforeEpochSeconds: 1,
  })
  const result = await readBuildResult(interim)
  const plan = await createProductionPlan({
    generationId: receipt.generation_id,
    notBeforeEpochSeconds: result.notBeforeEpochSeconds,
  })
  const receiptSHA256 = createHash('sha256').update(receiptBytes).digest('hex')
  if (
    receiptSHA256 !== result.receiptSHA256 ||
    receipt.source_manifest_sha256 !== result.sourceManifestSHA256
  ) {
    fail('canonical-receipt')
  }
  return Object.freeze({ plan, result })
}

async function verifyPublishedPackage() {
  const { plan, result } = await resolvePublishedPlan()
  await runHeldFinalVerification(plan)
  await assertPublishedReady(plan)
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
    await runHeldPackageBuild(await planFromHeldArguments(argv.slice(1)))
    return
  }
  if (action === 'verify-held') {
    await runHeldFinalVerification(await planFromHeldArguments(argv.slice(1)))
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
