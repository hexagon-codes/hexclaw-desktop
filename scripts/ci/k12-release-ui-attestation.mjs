#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const MANIFEST_FIELDS = ['files', 'release_version', 'schema_version']
const FILE_FIELDS = ['bytes', 'path', 'sha256']
const RECEIPT_FIELDS = [
  'dist_file_count',
  'dist_manifest_file',
  'dist_manifest_sha256',
  'dist_total_bytes',
  'generation_id',
  'installed_app_file',
  'installed_app_sha256',
  'package_file',
  'package_sha256',
  'release_version',
  'schema_version',
  'sidecar_file',
  'sidecar_sha256',
  'source_manifest_file',
  'source_manifest_sha256',
  'target_triple',
]
const SHA256 = /^[a-f0-9]{64}$/
// generation 身份与 package-generation-lock 共用同一安全字符和长度合同。
const GENERATION_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u
const CANONICAL_TARGET_TRIPLES = Object.freeze(
  new Set([
    'aarch64-apple-darwin',
    'x86_64-apple-darwin',
    'x86_64-pc-windows-msvc',
    'x86_64-unknown-linux-gnu',
  ]),
)
const DIST_MANIFEST_SCHEMA_VERSION = 1
const RECEIPT_SCHEMA_VERSION = 2
const PRIVATE_FILE_MODE = 0o600
const PRIVATE_DIRECTORY_MODE = 0o700
const HASH_CHUNK_BYTES = 1024 * 1024

export const ATTESTATION_LIMITS = Object.freeze({
  maxArtifactBytes: 4 * 1024 * 1024 * 1024,
  maxDistFileBytes: 512 * 1024 * 1024,
  maxDistFiles: 20_000,
  maxDistTotalBytes: 2 * 1024 * 1024 * 1024,
  maxManifestBytes: 16 * 1024 * 1024,
  maxReceiptBytes: 256 * 1024,
  maxSourceManifestBytes: 64 * 1024 * 1024,
})

class AttestationError extends Error {
  constructor(category, message) {
    super(`K12 release UI attestation: ${message}`)
    this.name = 'AttestationError'
    this.category = category
  }
}

function fail(message, category = 'validation') {
  throw new AttestationError(category, message)
}

function exactKeys(value, expected, label) {
  if (!value || Array.isArray(value) || typeof value !== 'object')
    fail(`${label} must be an object`)
  const keys = Object.keys(value).sort()
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    fail(`${label} fields do not match the exact schema`)
  }
}

function requireAbsolute(pathname, label) {
  if (typeof pathname !== 'string' || !isAbsolute(pathname)) fail(`${label} must be absolute`)
  return resolve(pathname)
}

function requireVersion(value) {
  if (typeof value !== 'string' || value.trim() === '') fail('release version is required')
  return value.trim()
}

function requireSHA256(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) fail(`${label} must be lowercase SHA-256`)
  return value
}

function requireGenerationID(value, label) {
  if (typeof value !== 'string' || !GENERATION_ID.test(value)) {
    fail(`${label} must use the safe package generation format`, 'generation-id')
  }
  return value
}

function requireTargetTriple(value, label) {
  if (typeof value !== 'string' || !CANONICAL_TARGET_TRIPLES.has(value)) {
    fail(`${label} must be a canonical package target`, 'target-triple')
  }
  return value
}

function requireEpochSeconds(value, label) {
  const parsed = typeof value === 'string' && value !== '' ? Number(value) : value
  if (!Number.isSafeInteger(parsed) || parsed < 0) fail(`${label} must be a non-negative integer`)
  return parsed
}

function canonicalJSON(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function compareNames(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right))
}

function inside(parent, child) {
  const suffix = relative(parent, child)
  return suffix === '' || (suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix))
}

function normalizeLimits(value) {
  const limits = { ...ATTESTATION_LIMITS, ...value }
  for (const [name, limit] of Object.entries(limits)) {
    if (!Object.hasOwn(ATTESTATION_LIMITS, name) || !Number.isSafeInteger(limit) || limit <= 0) {
      fail('attestation limits are invalid', 'limit')
    }
  }
  if (Object.keys(limits).length !== Object.keys(ATTESTATION_LIMITS).length) {
    fail('attestation limits are invalid', 'limit')
  }
  return Object.freeze(limits)
}

function sameFileIdentity(before, after) {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.nlink === after.nlink &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  )
}

async function lstatRegularInput(pathname, label) {
  let metadata
  try {
    metadata = await lstat(pathname, { bigint: true })
  } catch (error) {
    if (error?.code === 'ENOENT') fail(`${label} is missing`, 'file-missing')
    fail(`${label} could not be inspected`, 'file-open')
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    fail(`${label} must be a regular non-symlink file`, 'file-type')
  }
  if (metadata.nlink !== 1n) fail('regular input must have exactly one link', 'file-hard-link')
  return metadata
}

async function inspectRegularFile(
  pathname,
  label,
  { maxBytes, privateMode = false, notBeforeEpochSeconds } = {},
  consume,
) {
  const pathBefore = await lstatRegularInput(pathname, label)
  let handle
  try {
    const noFollow = Number.isInteger(constants.O_NOFOLLOW) ? constants.O_NOFOLLOW : 0
    handle = await open(pathname, constants.O_RDONLY | noFollow)
  } catch (error) {
    if (error?.code === 'ENOENT') fail(`${label} is missing`, 'file-missing')
    if (error?.code === 'ELOOP') {
      fail(`${label} must be a regular non-symlink file`, 'file-type')
    }
    fail(`${label} could not be opened`, 'file-open')
  }

  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile()) fail(`${label} must be a regular non-symlink file`, 'file-type')
    if (before.nlink !== 1n) fail('regular input must have exactly one link', 'file-hard-link')
    if (!sameFileIdentity(pathBefore, before)) {
      fail(`${label} identity changed before reading`, 'file-identity-changed')
    }
    if (privateMode && Number(before.mode & 0o777n) !== PRIVATE_FILE_MODE) {
      fail(`${label} permissions must be 0600`, 'file-permissions')
    }
    if (maxBytes !== undefined && before.size > BigInt(maxBytes)) {
      fail(`${label} exceeds the file size limit`, 'file-size-limit')
    }
    if (
      notBeforeEpochSeconds !== undefined &&
      before.mtimeMs / 1000n < BigInt(notBeforeEpochSeconds)
    ) {
      fail(`${label} predates current package-local build`, 'stale-artifact')
    }

    const result = await consume(handle, before)
    const after = await handle.stat({ bigint: true })
    if (!sameFileIdentity(before, after)) {
      fail(`${label} identity changed while reading`, 'file-identity-changed')
    }
    const pathAfter = await lstatRegularInput(pathname, label)
    if (!sameFileIdentity(after, pathAfter)) {
      fail(`${label} identity changed after reading`, 'file-identity-changed')
    }
    return result
  } finally {
    await handle.close().catch(() => undefined)
  }
}

async function streamIdentity(pathname, label, options) {
  return inspectRegularFile(pathname, label, options, async (handle, metadata) => {
    const hash = createHash('sha256')
    const chunk = Buffer.allocUnsafe(HASH_CHUNK_BYTES)
    let position = 0
    const expectedBytes = Number(metadata.size)
    while (position < expectedBytes) {
      const length = Math.min(chunk.length, expectedBytes - position)
      const { bytesRead } = await handle.read(chunk, 0, length, position)
      if (bytesRead <= 0) fail(`${label} identity changed while reading`, 'file-identity-changed')
      hash.update(chunk.subarray(0, bytesRead))
      position += bytesRead
    }
    return Object.freeze({
      bytes: expectedBytes,
      file: basename(pathname),
      sha256: hash.digest('hex'),
    })
  })
}

async function boundedFileBytes(pathname, label, options) {
  return inspectRegularFile(pathname, label, options, async (handle, metadata) => {
    const size = Number(metadata.size)
    const bytes = Buffer.alloc(size)
    let position = 0
    while (position < size) {
      const result = await handle.read(bytes, position, size - position, position)
      if (result.bytesRead <= 0)
        fail(`${label} identity changed while reading`, 'file-identity-changed')
      position += result.bytesRead
    }
    return bytes
  })
}

async function scanDist(distRoot, limits) {
  const root = requireAbsolute(distRoot, 'dist root')
  const rootMetadata = await lstat(root).catch(() => fail('dist root is missing', 'file-missing'))
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    fail('dist root must be a non-symlink directory', 'file-type')
  }

  const files = []
  let totalBytes = 0
  const visit = async (directory, components) => {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => compareNames(left.name, right.name))
    for (const entry of entries) {
      const pathname = resolve(directory, entry.name)
      const metadata = await lstat(pathname)
      if (metadata.isSymbolicLink()) fail('dist tree contains a symbolic link', 'file-type')
      if (metadata.isDirectory()) {
        await visit(pathname, [...components, entry.name])
        continue
      }
      if (!metadata.isFile()) fail('dist tree contains a non-regular entry', 'file-type')
      if (metadata.nlink !== 1) fail('regular input must have exactly one link', 'file-hard-link')
      if (files.length >= limits.maxDistFiles) {
        fail('dist tree exceeds the file count limit', 'file-count-limit')
      }
      const identity = await streamIdentity(pathname, 'dist file', {
        maxBytes: limits.maxDistFileBytes,
      })
      totalBytes += identity.bytes
      if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.maxDistTotalBytes) {
        fail('dist tree exceeds the total byte limit', 'total-byte-limit')
      }
      files.push(
        Object.freeze({
          path: [...components, entry.name].join('/'),
          bytes: identity.bytes,
          sha256: identity.sha256,
        }),
      )
    }
  }
  await visit(root, [])
  if (!files.some((entry) => entry.path === 'index.html')) fail('dist tree must contain index.html')
  return Object.freeze(files)
}

async function atomicPrivateWrite(pathname, contents, maxBytes) {
  const target = requireAbsolute(pathname, 'attestation output')
  const bytes = Buffer.byteLength(contents)
  if (bytes > maxBytes) fail('attestation output exceeds the file size limit', 'file-size-limit')
  await mkdir(dirname(target), { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
  const temporary = `${target}.tmp.${process.pid}.${Date.now()}`
  let handle
  try {
    handle = await open(temporary, 'wx', PRIVATE_FILE_MODE)
    await handle.writeFile(contents)
    await handle.sync()
    await handle.close()
    handle = undefined
    await chmod(temporary, PRIVATE_FILE_MODE)
    await rename(temporary, target)
  } finally {
    await handle?.close().catch(() => undefined)
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

async function createReleaseAttestationUnsafe(options) {
  const distRoot = requireAbsolute(options?.distRoot, 'dist root')
  const installedAppBinary = requireAbsolute(options?.installedAppBinary, 'installed app binary')
  const sidecarBinary = requireAbsolute(options?.sidecarBinary, 'Sidecar binary')
  const packagePath = requireAbsolute(options?.packagePath, 'package')
  const manifestPath = requireAbsolute(options?.manifestPath, 'manifest output')
  const receiptPath = requireAbsolute(options?.receiptPath, 'receipt output')
  const sourceManifestPath = requireAbsolute(options?.sourceManifestPath, 'source manifest')
  const sourceManifestSHA256 = requireSHA256(
    options?.sourceManifestSHA256,
    'source manifest SHA-256',
  )
  const generationId = requireGenerationID(options?.generationId, 'generation ID')
  const targetTriple = requireTargetTriple(options?.targetTriple, 'target triple')
  const releaseVersion = requireVersion(options?.releaseVersion)
  const limits = normalizeLimits(options?.limits)
  if (manifestPath === receiptPath) fail('manifest and receipt outputs must be distinct')
  if (inside(distRoot, manifestPath) || inside(distRoot, receiptPath)) {
    fail('attestation outputs must be outside dist root')
  }
  if (inside(distRoot, sourceManifestPath)) fail('source manifest must be outside dist root')
  if (sourceManifestPath === manifestPath || sourceManifestPath === receiptPath) {
    fail('source manifest and attestation outputs must be distinct')
  }

  const sourceManifest = await streamIdentity(sourceManifestPath, 'source manifest', {
    maxBytes: limits.maxSourceManifestBytes,
    privateMode: true,
  })
  if (sourceManifest.sha256 !== sourceManifestSHA256) {
    fail('source manifest SHA-256 mismatch', 'source-identity')
  }
  const files = await scanDist(distRoot, limits)
  const manifest = Object.freeze({
    schema_version: DIST_MANIFEST_SCHEMA_VERSION,
    release_version: releaseVersion,
    files,
  })
  const manifestBytes = canonicalJSON(manifest)
  if (Buffer.byteLength(manifestBytes) > limits.maxManifestBytes) {
    fail('dist manifest exceeds the file size limit', 'file-size-limit')
  }
  const manifestSHA256 = sha256(manifestBytes)
  const installedApp = await streamIdentity(installedAppBinary, 'installed app binary', {
    maxBytes: limits.maxArtifactBytes,
  })
  const sidecar = await streamIdentity(sidecarBinary, 'Sidecar binary', {
    maxBytes: limits.maxArtifactBytes,
  })
  const packageIdentity = await streamIdentity(packagePath, 'package', {
    maxBytes: limits.maxArtifactBytes,
  })
  const receipt = Object.freeze({
    schema_version: RECEIPT_SCHEMA_VERSION,
    release_version: releaseVersion,
    generation_id: generationId,
    target_triple: targetTriple,
    source_manifest_file: sourceManifest.file,
    source_manifest_sha256: sourceManifest.sha256,
    dist_manifest_file: basename(manifestPath),
    dist_manifest_sha256: manifestSHA256,
    dist_file_count: files.length,
    dist_total_bytes: files.reduce((total, entry) => total + entry.bytes, 0),
    installed_app_file: installedApp.file,
    installed_app_sha256: installedApp.sha256,
    sidecar_file: sidecar.file,
    sidecar_sha256: sidecar.sha256,
    package_file: packageIdentity.file,
    package_sha256: packageIdentity.sha256,
  })
  const receiptBytes = canonicalJSON(receipt)
  if (Buffer.byteLength(receiptBytes) > limits.maxReceiptBytes) {
    fail('release receipt exceeds the file size limit', 'file-size-limit')
  }
  const receiptSHA256 = sha256(receiptBytes)

  await atomicPrivateWrite(manifestPath, manifestBytes, limits.maxManifestBytes)
  await atomicPrivateWrite(receiptPath, receiptBytes, limits.maxReceiptBytes)
  return Object.freeze({
    generationId,
    manifestSHA256,
    receiptSHA256,
    sourceManifestSHA256: sourceManifest.sha256,
    targetTriple,
    distFileCount: files.length,
    distTotalBytes: receipt.dist_total_bytes,
  })
}

function parseManifest(raw, releaseVersion) {
  let value
  try {
    value = JSON.parse(raw)
  } catch {
    fail('dist manifest is not valid JSON')
  }
  exactKeys(value, MANIFEST_FIELDS, 'dist manifest')
  if (
    value.schema_version !== DIST_MANIFEST_SCHEMA_VERSION ||
    value.release_version !== releaseVersion
  ) {
    fail('dist manifest version identity mismatch')
  }
  if (!Array.isArray(value.files) || value.files.length === 0)
    fail('dist manifest files are required')
  let previous = ''
  for (const entry of value.files) {
    exactKeys(entry, FILE_FIELDS, 'dist manifest file')
    if (
      typeof entry.path !== 'string' ||
      entry.path === '' ||
      entry.path.startsWith('/') ||
      entry.path.includes('\\') ||
      entry.path.split('/').some((part) => part === '' || part === '.' || part === '..')
    ) {
      fail('dist manifest contains an invalid relative path')
    }
    if (previous && compareNames(previous, entry.path) >= 0) {
      fail('dist manifest paths must be unique and sorted')
    }
    previous = entry.path
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0) {
      fail('dist manifest contains an invalid byte count')
    }
    requireSHA256(entry.sha256, 'dist file SHA-256')
  }
  if (!value.files.some((entry) => entry.path === 'index.html')) {
    fail('dist manifest must contain index.html')
  }
  return value
}

function parseReceipt(raw, releaseVersion) {
  let value
  try {
    value = JSON.parse(raw)
  } catch {
    fail('release receipt is not valid JSON')
  }
  exactKeys(value, RECEIPT_FIELDS, 'release receipt')
  if (value.schema_version !== RECEIPT_SCHEMA_VERSION || value.release_version !== releaseVersion) {
    fail('release receipt version identity mismatch')
  }
  for (const field of [
    'dist_manifest_file',
    'installed_app_file',
    'sidecar_file',
    'package_file',
    'source_manifest_file',
  ]) {
    if (
      typeof value[field] !== 'string' ||
      value[field] === '' ||
      basename(value[field]) !== value[field]
    ) {
      fail(`${field} must be a basename`)
    }
  }
  for (const field of [
    'dist_manifest_sha256',
    'installed_app_sha256',
    'sidecar_sha256',
    'package_sha256',
    'source_manifest_sha256',
  ]) {
    requireSHA256(value[field], field)
  }
  for (const field of ['dist_file_count', 'dist_total_bytes']) {
    if (!Number.isSafeInteger(value[field]) || value[field] < 0)
      fail(`${field} must be a safe integer`)
  }
  requireGenerationID(value.generation_id, 'receipt generation ID')
  requireTargetTriple(value.target_triple, 'receipt target triple')
  return value
}

async function verifyReleaseAttestationUnsafe(options) {
  const distRoot = requireAbsolute(options?.distRoot, 'dist root')
  const installedAppBinary = requireAbsolute(options?.installedAppBinary, 'installed app binary')
  const sidecarBinary = requireAbsolute(options?.sidecarBinary, 'Sidecar binary')
  const packagePath = requireAbsolute(options?.packagePath, 'package')
  const manifestPath = requireAbsolute(options?.manifestPath, 'manifest')
  const receiptPath = requireAbsolute(options?.receiptPath, 'receipt')
  const sourceManifestPath = requireAbsolute(options?.sourceManifestPath, 'source manifest')
  const releaseVersion = requireVersion(options?.releaseVersion)
  const expectedReceiptSHA256 = requireSHA256(
    options?.expectedReceiptSHA256,
    'expected receipt SHA-256',
  )
  const expectedSourceManifestSHA256 = requireSHA256(
    options?.expectedSourceManifestSHA256,
    'expected source manifest SHA-256',
  )
  const expectedGenerationId = requireGenerationID(
    options?.expectedGenerationId,
    'expected generation ID',
  )
  const expectedTargetTriple = requireTargetTriple(
    options?.expectedTargetTriple,
    'expected target triple',
  )
  const notBeforeEpochSeconds =
    options?.notBeforeEpochSeconds === undefined
      ? undefined
      : requireEpochSeconds(options.notBeforeEpochSeconds, 'package-local not-before epoch seconds')
  const limits = normalizeLimits(options?.limits)
  if (inside(distRoot, sourceManifestPath)) fail('source manifest must be outside dist root')
  if (sourceManifestPath === manifestPath || sourceManifestPath === receiptPath) {
    fail('source manifest and attestation inputs must be distinct')
  }

  const receiptBytes = await boundedFileBytes(receiptPath, 'release receipt', {
    maxBytes: limits.maxReceiptBytes,
    privateMode: true,
    notBeforeEpochSeconds,
  })
  const receiptSHA256 = sha256(receiptBytes)
  if (receiptSHA256 !== expectedReceiptSHA256) fail('release receipt SHA-256 mismatch')
  const receipt = parseReceipt(receiptBytes.toString('utf8'), releaseVersion)
  if (receipt.dist_manifest_file !== basename(manifestPath)) fail('dist manifest filename mismatch')
  if (receipt.source_manifest_file !== basename(sourceManifestPath)) {
    fail('source manifest filename mismatch', 'source-identity')
  }
  if (receipt.source_manifest_sha256 !== expectedSourceManifestSHA256) {
    fail('source manifest expected identity mismatch', 'source-identity')
  }
  if (receipt.generation_id !== expectedGenerationId) {
    fail('release generation identity mismatch', 'generation-identity')
  }
  if (receipt.target_triple !== expectedTargetTriple) {
    fail('release target identity mismatch', 'target-identity')
  }

  const sourceManifest = await streamIdentity(sourceManifestPath, 'source manifest', {
    maxBytes: limits.maxSourceManifestBytes,
    privateMode: true,
    notBeforeEpochSeconds,
  })
  if (
    sourceManifest.file !== receipt.source_manifest_file ||
    sourceManifest.sha256 !== receipt.source_manifest_sha256
  ) {
    fail('source manifest identity mismatch', 'source-identity')
  }

  const manifestBytes = await boundedFileBytes(manifestPath, 'dist manifest', {
    maxBytes: limits.maxManifestBytes,
    privateMode: true,
    notBeforeEpochSeconds,
  })
  const manifestSHA256 = sha256(manifestBytes)
  if (manifestSHA256 !== receipt.dist_manifest_sha256) fail('dist manifest SHA-256 mismatch')
  const manifest = parseManifest(manifestBytes.toString('utf8'), releaseVersion)
  const currentFiles = await scanDist(distRoot, limits)
  if (canonicalJSON(currentFiles) !== canonicalJSON(manifest.files))
    fail('dist tree identity mismatch')
  const totalBytes = currentFiles.reduce((total, entry) => total + entry.bytes, 0)
  if (receipt.dist_file_count !== currentFiles.length || receipt.dist_total_bytes !== totalBytes) {
    fail('dist summary mismatch')
  }

  const installedApp = await streamIdentity(installedAppBinary, 'installed app binary', {
    maxBytes: limits.maxArtifactBytes,
  })
  const sidecar = await streamIdentity(sidecarBinary, 'Sidecar binary', {
    maxBytes: limits.maxArtifactBytes,
  })
  const packageIdentity = await streamIdentity(packagePath, 'package', {
    maxBytes: limits.maxArtifactBytes,
    notBeforeEpochSeconds,
  })
  for (const [identity, expectedFile, expectedSHA, label] of [
    [installedApp, receipt.installed_app_file, receipt.installed_app_sha256, 'installed app'],
    [sidecar, receipt.sidecar_file, receipt.sidecar_sha256, 'Sidecar'],
    [packageIdentity, receipt.package_file, receipt.package_sha256, 'package'],
  ]) {
    if (identity.file !== expectedFile || identity.sha256 !== expectedSHA) {
      fail(`${label} identity mismatch`)
    }
  }

  return Object.freeze({
    generationId: receipt.generation_id,
    receiptSHA256,
    manifestSHA256,
    sourceManifestSHA256: sourceManifest.sha256,
    targetTriple: receipt.target_triple,
    distFileCount: currentFiles.length,
    distTotalBytes: totalBytes,
    installedAppSHA256: installedApp.sha256,
    sidecarSHA256: sidecar.sha256,
    packageSHA256: packageIdentity.sha256,
  })
}

function normalizeAttestationError(error) {
  if (error instanceof AttestationError) return error
  return new AttestationError('internal', 'attestation operation failed')
}

export async function createReleaseAttestation(options) {
  try {
    return await createReleaseAttestationUnsafe(options)
  } catch (error) {
    throw normalizeAttestationError(error)
  }
}

export async function verifyReleaseAttestation(options) {
  try {
    return await verifyReleaseAttestationUnsafe(options)
  } catch (error) {
    throw normalizeAttestationError(error)
  }
}

function parseNamedArguments(argv, action, expected) {
  if (argv[0] !== action || argv.length !== 1 + expected.length * 2) fail('invalid CLI arguments')
  const values = {}
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name?.startsWith('--') || !value || values[name] !== undefined)
      fail('invalid CLI arguments')
    values[name] = value
  }
  const actual = Object.keys(values).sort()
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    fail('invalid CLI arguments')
  }
  return values
}

function commonCLIOptions(values) {
  return {
    distRoot: values['--dist'],
    releaseVersion: values['--release-version'],
    installedAppBinary: values['--installed-app'],
    sidecarBinary: values['--sidecar'],
    packagePath: values['--package'],
    manifestPath: values['--manifest'],
    receiptPath: values['--receipt'],
    sourceManifestPath: values['--source-manifest'],
  }
}

function parseCLI(argv) {
  const common = [
    '--dist',
    '--installed-app',
    '--manifest',
    '--package',
    '--receipt',
    '--release-version',
    '--sidecar',
    '--source-manifest',
  ]
  if (argv[0] === 'create') {
    const expected = [
      ...common,
      '--generation-id',
      '--source-manifest-sha256',
      '--target-triple',
    ].sort()
    const values = parseNamedArguments(argv, 'create', expected)
    return {
      action: 'create',
      options: {
        ...commonCLIOptions(values),
        generationId: values['--generation-id'],
        sourceManifestSHA256: values['--source-manifest-sha256'],
        targetTriple: values['--target-triple'],
      },
    }
  }
  if (argv[0] === 'verify') {
    const expected = [
      ...common,
      '--expected-generation-id',
      '--expected-receipt-sha256',
      '--expected-source-manifest-sha256',
      '--expected-target-triple',
      '--not-before-epoch-seconds',
    ].sort()
    const values = parseNamedArguments(argv, 'verify', expected)
    return {
      action: 'verify',
      options: {
        ...commonCLIOptions(values),
        expectedGenerationId: values['--expected-generation-id'],
        expectedReceiptSHA256: values['--expected-receipt-sha256'],
        expectedSourceManifestSHA256: values['--expected-source-manifest-sha256'],
        expectedTargetTriple: values['--expected-target-triple'],
        notBeforeEpochSeconds: values['--not-before-epoch-seconds'],
      },
    }
  }
  fail('invalid CLI arguments')
}

function safeCLIError(error) {
  const category = error instanceof AttestationError ? error.category : 'internal'
  const fields = [`ERROR: release-attestation category=${category}`]
  if (error instanceof AttestationError && Number.isInteger(error.exitCode)) {
    fields.push(`exit=${error.exitCode}`)
  }
  if (error instanceof AttestationError && /^[A-Z0-9]+$/u.test(error.signal ?? '')) {
    fields.push(`signal=${error.signal}`)
  }
  return fields.join(' ')
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  Promise.resolve()
    .then(() => parseCLI(process.argv.slice(2)))
    .then((command) => {
      const operation =
        command.action === 'create' ? createReleaseAttestation : verifyReleaseAttestation
      return operation(command.options)
    })
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`)
    })
    .catch((error) => {
      process.stderr.write(`${safeCLIError(error)}\n`)
      process.exitCode = 1
    })
}
