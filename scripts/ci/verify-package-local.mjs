#!/usr/bin/env node

import { lstat, mkdtemp, opendir, readlink, readdir, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { verifyReleaseAttestation } from './k12-release-ui-attestation.mjs'
import {
  verifyMacTreeMetadata,
  verifyPackageSensitiveBoundary,
} from './package-sensitive-boundary.mjs'
import {
  assertPackageGenerationReady,
  PACKAGE_GENERATION_CONTROL_BASENAME,
  PACKAGE_GENERATION_LOCK_BASENAME,
  PACKAGE_GENERATION_TOMBSTONE_BASENAME,
  PackageGenerationLockError,
} from './package-generation-lock.mjs'
import { BoundedProcessError, runBoundedProcess } from './run-bounded-process.mjs'

const HDIUTIL = '/usr/bin/hdiutil'
const DIFF = '/usr/bin/diff'
const CODESIGN = '/usr/bin/codesign'
const VERIFIER_CWD = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const DEFAULT_TIMEOUT_MS = 120_000
const CLEANUP_TIMEOUT_MS = 30_000
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const EXPECTED_UNSIGNED_MESSAGE = 'code object is not signed at all'
const APP_TREE_LIMITS = Object.freeze({
  maxEntries: 100_000,
  maxFileBytes: 4 * 1024 * 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024 * 1024,
})

class VerifierError extends Error {
  constructor(category, message, { exitCode, signal } = {}) {
    super(`Package-local verification: ${message}`)
    this.name = 'VerifierError'
    this.category = category
    this.exitCode = Number.isInteger(exitCode) ? exitCode : undefined
    this.signal = typeof signal === 'string' ? signal : undefined
  }
}

function fail(message, category = 'validation', details) {
  throw new VerifierError(category, message, details)
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(`${label} must be a positive integer`)
  return value
}

function requireAbsolutePath(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value)) fail(`${label} must be absolute`)
  return resolve(value)
}

function asSafeError(value, category = 'internal') {
  if (value instanceof VerifierError) return value
  return new VerifierError(category, 'operation failed')
}

function commandFailure(label, result) {
  return new VerifierError('command-failed', `${label} (exit ${result.code})`, {
    exitCode: result.code,
    signal: result.signal,
  })
}

function requireCommandResult(result, label) {
  if (!result || !Number.isInteger(result.code)) fail(`${label} returned an invalid result`)
  return result
}

function isExpectedUnsignedFailure(result, appBundle) {
  if (result.code !== 1 || result.signal !== null) return false
  const lines = `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines[0] !== `${appBundle}: ${EXPECTED_UNSIGNED_MESSAGE}`) return false
  if (lines.length === 1) return true
  return lines.length === 2 && /^In architecture: (?:arm64|x86_64)$/u.test(lines[1])
}

function compareNames(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right))
}

// 不跟随符号链接扫描 App，补足 diff 对链接目标和权限位不可证明的边界。
function consumeAppTreeEntry(budget) {
  budget.entries += 1
  if (budget.entries > APP_TREE_LIMITS.maxEntries) {
    fail('app tree exceeds the entry limit', 'app-tree-limit')
  }
}

async function scanAppTree(root, budget) {
  const entries = []
  const visit = async (pathname, components, alreadyCounted = false) => {
    if (!alreadyCounted) consumeAppTreeEntry(budget)
    const metadata = await lstat(pathname)
    const path = components.length > 0 ? components.join('/') : '.'
    const mode = metadata.mode & 0o7777
    if (metadata.isSymbolicLink()) {
      entries.push({ path, type: 'symlink', mode, target: await readlink(pathname) })
      return
    }
    if (metadata.isFile()) {
      if (
        !Number.isSafeInteger(metadata.size) ||
        metadata.size < 0 ||
        metadata.size > APP_TREE_LIMITS.maxFileBytes
      ) {
        fail('app tree exceeds the file size limit', 'app-tree-limit')
      }
      budget.bytes += metadata.size
      if (!Number.isSafeInteger(budget.bytes) || budget.bytes > APP_TREE_LIMITS.maxTotalBytes) {
        fail('app tree exceeds the total byte limit', 'app-tree-limit')
      }
      entries.push({ path, type: 'file', mode, bytes: metadata.size })
      return
    }
    if (!metadata.isDirectory()) fail('app tree contains an unsupported entry', 'app-tree')
    entries.push({ path, type: 'directory', mode })
    const children = []
    const directory = await opendir(pathname)
    for await (const child of directory) {
      consumeAppTreeEntry(budget)
      children.push(child)
    }
    children.sort((left, right) => compareNames(left.name, right.name))
    for (const child of children) {
      await visit(join(pathname, child.name), [...components, child.name], true)
    }
  }
  await visit(root, [])
  return entries
}

async function verifyAppTreeMetadata(localAppBundle, mountedAppBundle) {
  // 两棵树共享同一预算，避免 local/mounted 各自吃满上限后总量翻倍。
  const budget = { bytes: 0, entries: 0 }
  const localEntries = await scanAppTree(localAppBundle, budget)
  const mountedEntries = await scanAppTree(mountedAppBundle, budget)
  if (localEntries.length !== mountedEntries.length) fail('app tree entry set differs', 'app-tree')
  for (let index = 0; index < localEntries.length; index += 1) {
    const local = localEntries[index]
    const mounted = mountedEntries[index]
    if (local.path !== mounted.path) fail('app tree entry set differs', 'app-tree')
    if (local.type !== mounted.type) fail('app tree entry type differs', 'app-tree')
    if (local.mode !== mounted.mode) fail('app tree entry mode differs', 'app-tree')
    if (local.type === 'file' && local.bytes !== mounted.bytes) {
      fail('app tree file size differs', 'app-tree')
    }
    if (local.type === 'symlink' && local.target !== mounted.target) {
      fail('app tree symbolic link target differs', 'app-tree')
    }
  }
}

async function verifyDMGRoot(mountDirectory) {
  const entries = await readdir(mountDirectory)
  entries.sort(compareNames)
  if (entries.length !== 2 || entries[0] !== 'Applications' || entries[1] !== 'HexClaw.app') {
    fail('DMG root entry set differs', 'dmg-root')
  }
}

export function runBoundedCommand(
  command,
  args,
  {
    acceptedExitCodes,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  } = {},
) {
  if (typeof command !== 'string' || !isAbsolute(command)) {
    return Promise.reject(new VerifierError('command-input', 'command must be an absolute path'))
  }
  if (!Array.isArray(args) || args.some((value) => typeof value !== 'string')) {
    return Promise.reject(new VerifierError('command-input', 'command arguments must be strings'))
  }
  try {
    requirePositiveInteger(timeoutMs, 'command timeout')
    requirePositiveInteger(maxOutputBytes, 'command output limit')
  } catch (error) {
    return Promise.reject(error)
  }

  const environment = {
    HOME: tmpdir(),
    LANG: 'C',
    LC_ALL: 'C',
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    TMPDIR: tmpdir(),
  }
  return runBoundedProcess(command, args, {
    acceptedExitCodes,
    cwd: VERIFIER_CWD,
    env: environment,
    maxOutputBytes,
    timeoutMs,
  }).catch((error) => {
    if (!(error instanceof BoundedProcessError)) {
      throw new VerifierError('command-failed', 'command failed')
    }
    const categories = {
      'output-limit': 'command-output-limit',
      'start-failed': 'command-start',
      timeout: 'command-timeout',
    }
    const messages = {
      'output-limit': 'command output exceeded its limit',
      'start-failed': 'command could not be started',
      timeout: 'command timed out',
    }
    throw new VerifierError(
      categories[error.category] ?? 'command-failed',
      messages[error.category] ?? 'command failed',
      {
        exitCode: error.exitCode,
        signal: error.signal,
      },
    )
  })
}

async function verifyPackageReadiness(packagePath, expectedGenerationId) {
  const evidenceDirectory = dirname(packagePath)
  const controlDirectory = join(evidenceDirectory, PACKAGE_GENERATION_CONTROL_BASENAME)
  try {
    await assertPackageGenerationReady({
      expectedGenerationId,
      lockPath: join(controlDirectory, PACKAGE_GENERATION_LOCK_BASENAME),
      tombstonePath: join(controlDirectory, PACKAGE_GENERATION_TOMBSTONE_BASENAME),
    })
  } catch (error) {
    if (
      error instanceof PackageGenerationLockError &&
      (error.category === 'active' || error.category === 'in-progress')
    ) {
      throw new VerifierError('package-in-progress', 'package build is in progress')
    }
    throw new VerifierError('readiness-failed', 'package readiness check failed')
  }
}

async function runRequiredCommand(runCommand, command, args, options, label) {
  let result
  try {
    result = requireCommandResult(await runCommand(command, args, options), label)
  } catch (error) {
    throw asSafeError(error, 'command-failed')
  }
  if (result.code !== 0 || result.signal !== null) throw commandFailure(label, result)
  return result
}

async function directoryHasEntries(pathname) {
  return readdir(pathname)
    .then((entries) => entries.length > 0)
    .catch(() => false)
}

async function cleanupMount(runCommand, mountDirectory, mounted) {
  const errors = []
  if (mounted) {
    let detached = false
    try {
      const result = requireCommandResult(
        await runCommand(HDIUTIL, ['detach', mountDirectory], {
          timeoutMs: CLEANUP_TIMEOUT_MS,
          maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
        }),
        'DMG detach',
      )
      if (result.code === 0 && result.signal === null) detached = true
      else errors.push(commandFailure('DMG detach failed', result))
    } catch (error) {
      errors.push(asSafeError(error, 'cleanup-failed'))
    }

    if (!detached) {
      try {
        const result = requireCommandResult(
          await runCommand(HDIUTIL, ['detach', '-force', mountDirectory], {
            timeoutMs: CLEANUP_TIMEOUT_MS,
            maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
          }),
          'forced DMG detach',
        )
        if (result.code !== 0 || result.signal !== null) {
          errors.push(commandFailure('forced DMG detach failed', result))
        }
      } catch (error) {
        errors.push(asSafeError(error, 'cleanup-failed'))
      }
    }
  }

  try {
    await rmdir(mountDirectory)
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      errors.push(new VerifierError('cleanup-failed', 'mount directory cleanup failed'))
    }
  }
  return errors
}

function combineErrors(primaryError, cleanupErrors) {
  if (primaryError && cleanupErrors.length > 0) {
    return new AggregateError(
      [primaryError, ...cleanupErrors],
      'Package-local verification and cleanup failed',
    )
  }
  if (primaryError) return primaryError
  if (cleanupErrors.length > 0) {
    return new AggregateError(cleanupErrors, 'Package-local cleanup failed')
  }
  return null
}

export async function verifyPackageLocal(options, adapters = {}) {
  const runCommand = adapters.runCommand ?? runBoundedCommand
  const verifyReadiness = adapters.verifyReadiness ?? verifyPackageReadiness
  const createMountDirectory =
    adapters.createMountDirectory ?? (() => mkdtemp(join(tmpdir(), 'hexclaw-package-local.')))

  const packagePath = requireAbsolutePath(options?.packagePath, 'package')
  await verifyReadiness(packagePath, options?.expectedGenerationId)

  let attestation
  try {
    attestation = await verifyReleaseAttestation(options)
  } catch {
    throw new VerifierError('attestation-failed', 'release attestation failed')
  }

  try {
    const localAppBundle = requireAbsolutePath(options?.localAppBundle, 'local app bundle')
    const appMetadata = await lstat(localAppBundle).catch(() => undefined)
    if (!appMetadata?.isDirectory() || appMetadata.isSymbolicLink()) {
      fail('local app bundle must be a non-symlink directory', 'app-tree')
    }
    if (basename(localAppBundle) !== 'HexClaw.app') {
      fail('local app bundle must be HexClaw.app', 'app-tree')
    }

    let sensitiveBoundary
    try {
      sensitiveBoundary = await verifyPackageSensitiveBoundary(
        { distRoot: options?.distRoot, appBundle: localAppBundle },
        { runCommand },
      )
    } catch {
      throw new VerifierError('sensitive-boundary-failed', 'sensitive boundary failed')
    }

    await runRequiredCommand(
      runCommand,
      HDIUTIL,
      ['verify', packagePath],
      {
        timeoutMs: DEFAULT_TIMEOUT_MS,
        maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
      },
      'DMG checksum verification failed',
    )

    const mountDirectory = requireAbsolutePath(await createMountDirectory(), 'mount directory')
    let mounted = false
    let primaryError = null
    let cleanupErrors = []
    try {
      const attach = requireCommandResult(
        await runCommand(
          HDIUTIL,
          ['attach', '-readonly', '-nobrowse', '-mountpoint', mountDirectory, packagePath],
          {
            timeoutMs: DEFAULT_TIMEOUT_MS,
            maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
          },
        ),
        'DMG mount',
      )
      if (attach.code !== 0 || attach.signal !== null)
        throw commandFailure('DMG mount failed', attach)
      mounted = true

      await verifyDMGRoot(mountDirectory)
      const mountedAppBundle = join(mountDirectory, 'HexClaw.app')
      await verifyAppTreeMetadata(localAppBundle, mountedAppBundle)
      await runRequiredCommand(
        runCommand,
        DIFF,
        ['-qr', localAppBundle, mountedAppBundle],
        {
          timeoutMs: DEFAULT_TIMEOUT_MS,
          maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
        },
        'packaged app tree differs from local app',
      )
      await verifyMacTreeMetadata(mountedAppBundle, { runCommand })

      const applicationsLink = join(mountDirectory, 'Applications')
      const linkMetadata = await lstat(applicationsLink).catch(() => undefined)
      if (!linkMetadata?.isSymbolicLink()) {
        fail('Applications entry must be a symbolic link', 'dmg-root')
      }
      if ((await readlink(applicationsLink)) !== '/Applications') {
        fail('Applications symbolic link must target /Applications', 'dmg-root')
      }

      const codesign = requireCommandResult(
        await runCommand(
          CODESIGN,
          ['--verify', '--deep', '--strict', '--verbose=4', mountedAppBundle],
          {
            acceptedExitCodes: [0, 1],
            timeoutMs: CLEANUP_TIMEOUT_MS,
            maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
          },
        ),
        'codesign verification',
      )
      if (codesign.code === 0 && codesign.signal === null) {
        fail('packaged app is signed; expected intentionally unsigned', 'signature-policy')
      }
      if (!isExpectedUnsignedFailure(codesign, mountedAppBundle)) {
        throw commandFailure('codesign failed for an unexpected reason', codesign)
      }
    } catch (error) {
      primaryError = asSafeError(error)
      if (!mounted) mounted = await directoryHasEntries(mountDirectory)
    } finally {
      cleanupErrors = await cleanupMount(runCommand, mountDirectory, mounted)
    }

    const combinedError = combineErrors(primaryError, cleanupErrors)
    if (combinedError) throw combinedError
    await verifyReadiness(packagePath, options?.expectedGenerationId)
    return Object.freeze({
      ...attestation,
      sensitiveBoundaryVerified: true,
      sensitiveScannedFiles: sensitiveBoundary.scannedFiles,
      dmgChecksumVerified: true,
      appBundleVerified: true,
      metadataVerified: true,
      unsignedVerified: true,
    })
  } catch (error) {
    if (error instanceof VerifierError || error instanceof AggregateError) throw error
    throw new VerifierError('io-failed', 'filesystem operation failed')
  }
}

function parseCLI(argv) {
  const names = [
    '--app-bundle',
    '--dist',
    '--expected-receipt-sha256',
    '--generation-id',
    '--installed-app',
    '--manifest',
    '--not-before-epoch-seconds',
    '--package',
    '--receipt',
    '--release-version',
    '--sidecar',
    '--source-manifest',
    '--source-manifest-sha256',
    '--target-triple',
  ]
  if (argv.length !== names.length * 2) fail('invalid CLI arguments', 'cli-input')
  const values = {}
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name?.startsWith('--') || !value || values[name] !== undefined) {
      fail('invalid CLI arguments', 'cli-input')
    }
    values[name] = value
  }
  const actual = Object.keys(values).sort()
  if (actual.some((name, index) => name !== names[index]))
    fail('invalid CLI arguments', 'cli-input')
  return {
    localAppBundle: values['--app-bundle'],
    distRoot: values['--dist'],
    expectedReceiptSHA256: values['--expected-receipt-sha256'],
    expectedGenerationId: values['--generation-id'],
    expectedSourceManifestSHA256: values['--source-manifest-sha256'],
    expectedTargetTriple: values['--target-triple'],
    installedAppBinary: values['--installed-app'],
    manifestPath: values['--manifest'],
    notBeforeEpochSeconds: values['--not-before-epoch-seconds'],
    packagePath: values['--package'],
    receiptPath: values['--receipt'],
    releaseVersion: values['--release-version'],
    sidecarBinary: values['--sidecar'],
    sourceManifestPath: values['--source-manifest'],
  }
}

function flattenVerifierErrors(error) {
  if (error instanceof AggregateError) return error.errors.flatMap(flattenVerifierErrors)
  return [error]
}

function safeCLIError(error) {
  const errors = flattenVerifierErrors(error).filter((entry) => entry instanceof VerifierError)
  const primary = errors[0]
  const fields = [
    `ERROR: package-local-verifier category=${errors.length > 1 ? 'multiple-failures' : (primary?.category ?? 'internal')}`,
  ]
  if (primary?.exitCode !== undefined) fields.push(`exit=${primary.exitCode}`)
  if (/^[A-Z0-9]+$/u.test(primary?.signal ?? '')) fields.push(`signal=${primary.signal}`)
  return fields.join(' ')
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  Promise.resolve()
    .then(() => parseCLI(process.argv.slice(2)))
    .then(verifyPackageLocal)
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`)
      process.stdout.write('PASS: package-local artifact identity verified.\n')
    })
    .catch((error) => {
      process.stderr.write(`${safeCLIError(error)}\n`)
      process.exitCode = 1
    })
}
