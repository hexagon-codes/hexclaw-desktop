#!/usr/bin/env node

import { createHash } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const MANIFEST_FIELDS = ['files', 'release_version', 'schema_version']
const FILE_FIELDS = ['bytes', 'path', 'sha256']
const RECEIPT_FIELDS = [
  'dist_file_count',
  'dist_manifest_file',
  'dist_manifest_sha256',
  'dist_total_bytes',
  'installed_app_file',
  'installed_app_sha256',
  'package_file',
  'package_sha256',
  'release_version',
  'schema_version',
  'sidecar_file',
  'sidecar_sha256',
]
const SHA256 = /^[a-f0-9]{64}$/
const PRIVATE_FILE_MODE = 0o600
const PRIVATE_DIRECTORY_MODE = 0o700

function fail(message) {
  throw new Error(`K12 release UI attestation: ${message}`)
}

function exactKeys(value, expected, label) {
  if (!value || Array.isArray(value) || typeof value !== 'object') fail(`${label} must be an object`)
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

async function regularFileBytes(pathname, label, { privateMode = false } = {}) {
  const metadata = await lstat(pathname).catch(() => fail(`${label} is missing`))
  if (metadata.isSymbolicLink() || !metadata.isFile()) fail(`${label} must be a regular non-symlink file`)
  if (privateMode && (metadata.mode & 0o777) !== PRIVATE_FILE_MODE) {
    fail(`${label} permissions must be 0600`)
  }
  return readFile(pathname)
}

async function fileIdentity(pathname, label) {
  const bytes = await regularFileBytes(pathname, label)
  return Object.freeze({
    file: basename(pathname),
    sha256: sha256(bytes),
  })
}

async function scanDist(distRoot) {
  const root = requireAbsolute(distRoot, 'dist root')
  const rootMetadata = await lstat(root).catch(() => fail('dist root is missing'))
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    fail('dist root must be a non-symlink directory')
  }

  const files = []
  const visit = async (directory, components) => {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => compareNames(left.name, right.name))
    for (const entry of entries) {
      const pathname = resolve(directory, entry.name)
      const metadata = await lstat(pathname)
      if (metadata.isSymbolicLink()) fail('dist tree contains a symbolic link')
      if (metadata.isDirectory()) {
        await visit(pathname, [...components, entry.name])
        continue
      }
      if (!metadata.isFile()) fail('dist tree contains a non-regular entry')
      const bytes = await readFile(pathname)
      files.push(Object.freeze({
        path: [...components, entry.name].join('/'),
        bytes: bytes.byteLength,
        sha256: sha256(bytes),
      }))
    }
  }
  await visit(root, [])
  if (!files.some((entry) => entry.path === 'index.html')) fail('dist tree must contain index.html')
  return Object.freeze(files)
}

async function atomicPrivateWrite(pathname, contents) {
  const target = requireAbsolute(pathname, 'attestation output')
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

export async function createReleaseAttestation(options) {
  const distRoot = requireAbsolute(options?.distRoot, 'dist root')
  const installedAppBinary = requireAbsolute(options?.installedAppBinary, 'installed app binary')
  const sidecarBinary = requireAbsolute(options?.sidecarBinary, 'Sidecar binary')
  const packagePath = requireAbsolute(options?.packagePath, 'package')
  const manifestPath = requireAbsolute(options?.manifestPath, 'manifest output')
  const receiptPath = requireAbsolute(options?.receiptPath, 'receipt output')
  const releaseVersion = requireVersion(options?.releaseVersion)
  if (manifestPath === receiptPath) fail('manifest and receipt outputs must be distinct')
  if (inside(distRoot, manifestPath) || inside(distRoot, receiptPath)) {
    fail('attestation outputs must be outside dist root')
  }

  const files = await scanDist(distRoot)
  const manifest = Object.freeze({
    schema_version: 1,
    release_version: releaseVersion,
    files,
  })
  const manifestBytes = canonicalJSON(manifest)
  const manifestSHA256 = sha256(manifestBytes)
  const installedApp = await fileIdentity(installedAppBinary, 'installed app binary')
  const sidecar = await fileIdentity(sidecarBinary, 'Sidecar binary')
  const packageIdentity = await fileIdentity(packagePath, 'package')
  const receipt = Object.freeze({
    schema_version: 1,
    release_version: releaseVersion,
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
  const receiptSHA256 = sha256(receiptBytes)

  await atomicPrivateWrite(manifestPath, manifestBytes)
  await atomicPrivateWrite(receiptPath, receiptBytes)
  return Object.freeze({
    manifestSHA256,
    receiptSHA256,
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
  if (value.schema_version !== 1 || value.release_version !== releaseVersion) {
    fail('dist manifest version identity mismatch')
  }
  if (!Array.isArray(value.files) || value.files.length === 0) fail('dist manifest files are required')
  let previous = ''
  for (const entry of value.files) {
    exactKeys(entry, FILE_FIELDS, 'dist manifest file')
    if (
      typeof entry.path !== 'string'
      || entry.path === ''
      || entry.path.startsWith('/')
      || entry.path.includes('\\')
      || entry.path.split('/').some((part) => part === '' || part === '.' || part === '..')
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
  if (value.schema_version !== 1 || value.release_version !== releaseVersion) {
    fail('release receipt version identity mismatch')
  }
  for (const field of [
    'dist_manifest_file',
    'installed_app_file',
    'sidecar_file',
    'package_file',
  ]) {
    if (
      typeof value[field] !== 'string'
      || value[field] === ''
      || basename(value[field]) !== value[field]
    ) {
      fail(`${field} must be a basename`)
    }
  }
  for (const field of [
    'dist_manifest_sha256',
    'installed_app_sha256',
    'sidecar_sha256',
    'package_sha256',
  ]) {
    requireSHA256(value[field], field)
  }
  for (const field of ['dist_file_count', 'dist_total_bytes']) {
    if (!Number.isSafeInteger(value[field]) || value[field] < 0) fail(`${field} must be a safe integer`)
  }
  return value
}

export async function verifyReleaseAttestation(options) {
  const distRoot = requireAbsolute(options?.distRoot, 'dist root')
  const installedAppBinary = requireAbsolute(options?.installedAppBinary, 'installed app binary')
  const sidecarBinary = requireAbsolute(options?.sidecarBinary, 'Sidecar binary')
  const packagePath = requireAbsolute(options?.packagePath, 'package')
  const manifestPath = requireAbsolute(options?.manifestPath, 'manifest')
  const receiptPath = requireAbsolute(options?.receiptPath, 'receipt')
  const releaseVersion = requireVersion(options?.releaseVersion)
  const expectedReceiptSHA256 = requireSHA256(
    options?.expectedReceiptSHA256,
    'expected receipt SHA-256',
  )

  const receiptBytes = await regularFileBytes(receiptPath, 'release receipt', { privateMode: true })
  const receiptSHA256 = sha256(receiptBytes)
  if (receiptSHA256 !== expectedReceiptSHA256) fail('release receipt SHA-256 mismatch')
  const receipt = parseReceipt(receiptBytes, releaseVersion)
  if (receipt.dist_manifest_file !== basename(manifestPath)) fail('dist manifest filename mismatch')

  const manifestBytes = await regularFileBytes(manifestPath, 'dist manifest', { privateMode: true })
  const manifestSHA256 = sha256(manifestBytes)
  if (manifestSHA256 !== receipt.dist_manifest_sha256) fail('dist manifest SHA-256 mismatch')
  const manifest = parseManifest(manifestBytes, releaseVersion)
  const currentFiles = await scanDist(distRoot)
  if (canonicalJSON(currentFiles) !== canonicalJSON(manifest.files)) fail('dist tree identity mismatch')
  const totalBytes = currentFiles.reduce((total, entry) => total + entry.bytes, 0)
  if (
    receipt.dist_file_count !== currentFiles.length
    || receipt.dist_total_bytes !== totalBytes
  ) {
    fail('dist summary mismatch')
  }

  const installedApp = await fileIdentity(installedAppBinary, 'installed app binary')
  const sidecar = await fileIdentity(sidecarBinary, 'Sidecar binary')
  const packageIdentity = await fileIdentity(packagePath, 'package')
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
    receiptSHA256,
    manifestSHA256,
    distFileCount: currentFiles.length,
    distTotalBytes: totalBytes,
    installedAppSHA256: installedApp.sha256,
    sidecarSHA256: sidecar.sha256,
    packageSHA256: packageIdentity.sha256,
  })
}

function parseCLI(argv) {
  if (argv[0] !== 'create' || argv.length !== 15) {
    fail(
      'usage: create --dist <path> --release-version <version> --installed-app <path> '
      + '--sidecar <path> --package <path> --manifest <path> --receipt <path>',
    )
  }
  const values = {}
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name?.startsWith('--') || !value || values[name] !== undefined) fail('invalid CLI arguments')
    values[name] = value
  }
  const expected = [
    '--dist',
    '--installed-app',
    '--manifest',
    '--package',
    '--receipt',
    '--release-version',
    '--sidecar',
  ]
  const actual = Object.keys(values).sort()
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    fail('invalid CLI arguments')
  }
  return {
    distRoot: values['--dist'],
    releaseVersion: values['--release-version'],
    installedAppBinary: values['--installed-app'],
    sidecarBinary: values['--sidecar'],
    packagePath: values['--package'],
    manifestPath: values['--manifest'],
    receiptPath: values['--receipt'],
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  createReleaseAttestation(parseCLI(process.argv.slice(2)))
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`)
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    })
}
