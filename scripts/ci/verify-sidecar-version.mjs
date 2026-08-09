import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  assertBinaryArchitectureInfo,
  assertBinaryContainsTargetArchitecture,
  describeBinaryTarget,
  withSecureBinarySnapshot,
  withSecureFileSnapshot,
} from './binary-architecture.mjs'

const GO_METADATA_TIMEOUT_MS = 30_000
const GO_METADATA_MAX_BUFFER_BYTES = 4 * 1024 * 1024
export const OLLAMA_PACKAGE_CONTRACT = Object.freeze({
  architectures: Object.freeze(['x86_64', 'arm64']),
  archiveBytes: 143_171_908,
  archiveSha256: 'ad8a4d2918ed09480b8160419570602b4f49e48c9e3792efb601c0f54619e48e',
  binaryBytes: 66_855_424,
  binaryName: 'ollama',
  binarySha256: '88abf6776aa83f8d975a486ddac82a285be61cdadd5705153338a49e0f2c5139',
  goos: 'darwin',
  modulePath: 'github.com/ollama/ollama',
  moduleVersion: 'v0.30.10+dirty',
  packagePath: 'github.com/ollama/ollama',
  url: 'https://github.com/ollama/ollama/releases/download/v0.30.10/ollama-darwin.tgz',
  vcsModified: true,
  vcsRevision: 'e1f7f9cbdbdad30b9811d5b673cf3d3f9c624dc2',
  version: '0.30.10',
})
const SUPPORTED_SIDECAR_TARGETS = new Set([
  'aarch64-apple-darwin',
  'x86_64-apple-darwin',
  'aarch64-unknown-linux-gnu',
  'x86_64-unknown-linux-gnu',
  'aarch64-pc-windows-msvc',
  'x86_64-pc-windows-msvc',
])

export function normalizeReleaseVersion(version) {
  return version.replace(/^v/, '')
}

export function extractEmbeddedVersion(metadata) {
  const matches = [...metadata.matchAll(/(?:^|[\s"])main\.version=([^\s"']+)/g)].map(
    (match) => match[1],
  )
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one embedded main.version in Go metadata, found ${matches.length}`,
    )
  }
  return matches[0]
}

export function assertSidecarVersion(metadata, expectedVersion) {
  const canonicalVersion = normalizeReleaseVersion(expectedVersion)
  const embeddedVersion = extractEmbeddedVersion(metadata)
  if (embeddedVersion !== canonicalVersion) {
    throw new Error('sidecar main.version must match Desktop release version')
  }
  return embeddedVersion
}

function parseBuildSettings(metadata) {
  const settings = {}
  for (const rawLine of metadata.split(/\r?\n/u)) {
    const line = rawLine.trimStart()
    if (!line.startsWith('build\t')) continue
    const setting = line.slice('build\t'.length)
    const separator = setting.indexOf('=')
    if (separator < 1) continue
    const name = setting.slice(0, separator)
    const value = setting.slice(separator + 1)
    if (Object.hasOwn(settings, name)) {
      throw new Error('duplicate Go build setting')
    }
    settings[name] = value
  }
  return Object.freeze(settings)
}

export function extractGoBuildSetting(metadata, name) {
  const settings = parseBuildSettings(metadata)
  if (!Object.hasOwn(settings, name)) {
    throw new Error(`expected exactly one Go build setting for ${name}`)
  }
  return settings[name]
}

export function parseGoBuildInfo(metadata) {
  const packagePaths = []
  const mainModules = []

  for (const rawLine of metadata.split(/\r?\n/u)) {
    const fields = rawLine.trimStart().split('\t')
    if (fields[0] === 'path' && fields.length >= 2) {
      packagePaths.push(fields[1])
    } else if (fields[0] === 'mod' && fields.length >= 3) {
      mainModules.push({
        path: fields[1],
        version: fields[2],
        checksum: fields[3] || null,
      })
    }
  }

  if (packagePaths.length !== 1) {
    throw new Error(`expected exactly one Go package path, found ${packagePaths.length}`)
  }
  if (mainModules.length !== 1) {
    throw new Error(`expected exactly one Go main module, found ${mainModules.length}`)
  }

  return Object.freeze({
    packagePath: packagePaths[0],
    mainModule: Object.freeze(mainModules[0]),
    settings: parseBuildSettings(metadata),
  })
}

export function assertGoBuildTarget(buildInfo, targetTriple) {
  const target = describeBinaryTarget(targetTriple)
  if (buildInfo.settings.GOOS !== target.goos) {
    throw new Error('Go build metadata GOOS must match the target')
  }
  if (buildInfo.settings.GOARCH !== target.goarch) {
    throw new Error('Go build metadata GOARCH must match the target')
  }
  return { goos: target.goos, goarch: target.goarch }
}

function normalizeGoModuleVersion(version) {
  return version.startsWith('v') ? version : `v${version}`
}

export function assertGoMainModule(buildInfo, expectedModule) {
  if (buildInfo.mainModule.path !== expectedModule.path) {
    throw new Error('Go main module path must match exactly')
  }
  if (buildInfo.mainModule.version !== normalizeGoModuleVersion(expectedModule.version)) {
    throw new Error('Go main module version must match exactly')
  }
  return buildInfo.mainModule
}

function goarchToBinaryArchitecture(goarch) {
  if (goarch === 'amd64') return 'x86_64'
  if (goarch === 'arm64') return 'arm64'
  throw new Error('Go build metadata GOARCH is unsupported')
}

function assertLowerHex(value, length, message) {
  if (typeof value !== 'string' || !new RegExp(`^[0-9a-f]{${length}}$`, 'u').test(value)) {
    throw new Error(message)
  }
}

export function assertOllamaArtifact({
  metadata,
  architecture,
  targetTriple,
  archiveBytes,
  archiveSha256,
  archiveUrl,
  binaryBytes,
  binarySha256,
}) {
  const archiveError = 'Ollama archive SHA-256 must match exactly'
  assertLowerHex(archiveSha256, 64, archiveError)
  if (archiveSha256 !== OLLAMA_PACKAGE_CONTRACT.archiveSha256) throw new Error(archiveError)
  if (archiveBytes !== OLLAMA_PACKAGE_CONTRACT.archiveBytes) {
    throw new Error('Ollama archive size must match exactly')
  }
  if (archiveUrl !== OLLAMA_PACKAGE_CONTRACT.url) {
    throw new Error('Ollama archive URL must match exactly')
  }

  const binaryError = 'Ollama binary SHA-256 must match exactly'
  assertLowerHex(binarySha256, 64, binaryError)
  if (binarySha256 !== OLLAMA_PACKAGE_CONTRACT.binarySha256) throw new Error(binaryError)
  if (binaryBytes !== OLLAMA_PACKAGE_CONTRACT.binaryBytes) {
    throw new Error('Ollama binary size must match exactly')
  }

  const buildInfo = parseGoBuildInfo(metadata)
  if (buildInfo.packagePath !== OLLAMA_PACKAGE_CONTRACT.packagePath) {
    throw new Error('Ollama Go package path must match exactly')
  }
  if (buildInfo.mainModule.path !== OLLAMA_PACKAGE_CONTRACT.modulePath) {
    throw new Error('Ollama main module path must match exactly')
  }
  if (buildInfo.mainModule.version !== OLLAMA_PACKAGE_CONTRACT.moduleVersion) {
    throw new Error('Ollama main module version must match exactly')
  }

  const revisionError = 'Ollama VCS revision must match exactly'
  if (buildInfo.settings['vcs.revision'] !== OLLAMA_PACKAGE_CONTRACT.vcsRevision) {
    throw new Error(revisionError)
  }
  if (buildInfo.settings['vcs.modified'] !== String(OLLAMA_PACKAGE_CONTRACT.vcsModified)) {
    throw new Error('Ollama VCS modified state must match exactly')
  }

  const target = describeBinaryTarget(targetTriple)
  if (
    target.goos !== OLLAMA_PACKAGE_CONTRACT.goos ||
    buildInfo.settings.GOOS !== OLLAMA_PACKAGE_CONTRACT.goos
  ) {
    throw new Error('Ollama Go build metadata GOOS must match the target')
  }
  if (
    architecture.format !== 'mach-o' ||
    architecture.architectures.length !== OLLAMA_PACKAGE_CONTRACT.architectures.length ||
    !OLLAMA_PACKAGE_CONTRACT.architectures.every((item) =>
      architecture.architectures.includes(item),
    )
  ) {
    throw new Error('Ollama architectures must match universal2 exactly')
  }
  assertBinaryContainsTargetArchitecture(architecture, targetTriple)

  const buildInfoArchitecture = goarchToBinaryArchitecture(buildInfo.settings.GOARCH)
  if (!architecture.architectures.includes(buildInfoArchitecture)) {
    throw new Error('Ollama Go build metadata GOARCH must match a binary slice')
  }

  return {
    mainModule: buildInfo.mainModule,
    goos: target.goos,
    buildInfoGoarch: buildInfo.settings.GOARCH,
    targetArchitecture: target.architecture,
    vcsRevision: OLLAMA_PACKAGE_CONTRACT.vcsRevision,
    archiveBytes,
    archiveSha256,
    archiveUrl,
    binaryBytes,
    binarySha256,
  }
}

export function inferSidecarTarget(binaryPath) {
  const filename = binaryPath.replaceAll('\\', '/').split('/').at(-1) ?? ''
  if (!filename.startsWith('hexclaw-')) {
    throw new Error('sidecar filename must declare a supported target')
  }
  const withoutPrefix = filename.slice('hexclaw-'.length)
  const targetTriple = withoutPrefix.endsWith('.exe')
    ? withoutPrefix.slice(0, -'.exe'.length)
    : withoutPrefix
  if (!SUPPORTED_SIDECAR_TARGETS.has(targetTriple)) {
    throw new Error('sidecar filename must declare a supported target')
  }
  const windowsTarget = targetTriple.endsWith('-pc-windows-msvc')
  if (windowsTarget !== withoutPrefix.endsWith('.exe')) {
    throw new Error('sidecar filename must declare a supported target')
  }
  return targetTriple
}

function validateGoToolchain(goToolchain) {
  if (
    goToolchain === null ||
    typeof goToolchain !== 'object' ||
    typeof goToolchain.executable !== 'string' ||
    !isAbsolute(goToolchain.executable) ||
    typeof goToolchain.executableSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(goToolchain.executableSha256) ||
    typeof goToolchain.goroot !== 'string' ||
    !isAbsolute(goToolchain.goroot)
  ) {
    throw new Error('package Go toolchain identity is required')
  }
  return goToolchain
}

async function runGoBuildMetadata(goSnapshot, binarySnapshot, goToolchain) {
  // helper 环境只允许构建信息读取所需的固定变量，禁止继承宿主路径、凭据或动态加载器变量。
  const environment = {
    GOENV: 'off',
    GOROOT: goToolchain.goroot,
    GOTOOLCHAIN: 'local',
  }

  await goSnapshot.assertUnchanged()
  await binarySnapshot.assertUnchanged()

  let metadata
  let commandError
  try {
    // macOS 不支持从 /dev/fd 执行 Mach-O；这里只执行已锁定私有目录中的当前用户单链接可信副本。
    // 该路径在复制后不再写入，并在执行前后及返回前复核同一 inode、mode 与摘要。
    // 目标二进制只通过继承的只读 FD 暴露给 Go helper，绝不执行目标文件。
    metadata = execFileSync(goSnapshot.path, ['version', '-m', '/dev/fd/3'], {
      encoding: 'utf8',
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe', binarySnapshot.fileDescriptor],
      timeout: GO_METADATA_TIMEOUT_MS,
      maxBuffer: GO_METADATA_MAX_BUFFER_BYTES,
    })
  } catch {
    commandError = new Error('unable to inspect Go build metadata')
  }

  await binarySnapshot.assertUnchanged()
  await goSnapshot.assertUnchanged()
  if (commandError) throw commandError
  return metadata
}

async function withSecureGoInspection(binaryPath, options, operation) {
  const goToolchain = validateGoToolchain(options?.goToolchain)
  return withSecureFileSnapshot(
    goToolchain.executable,
    {
      digestMismatchMessage: 'package Go toolchain identity does not match',
      executable: true,
      expectedSha256: goToolchain.executableSha256,
      kind: 'package Go toolchain snapshot',
      nestedSnapshotRoot: true,
      snapshotRoot: options?.snapshotRoot,
    },
    async (goSnapshot) => {
      if (typeof goSnapshot.nestedSnapshotRoot !== 'string') {
        throw new Error('package Go toolchain snapshot is unavailable')
      }
      return withSecureBinarySnapshot(
        binaryPath,
        { snapshotRoot: goSnapshot.nestedSnapshotRoot },
        async (binarySnapshot) => {
          const metadata = await runGoBuildMetadata(goSnapshot, binarySnapshot, goToolchain)
          return operation({
            architecture: binarySnapshot.architecture,
            goToolchainSnapshot: goSnapshot.evidence,
            metadata,
            snapshot: binarySnapshot.evidence,
          })
        },
      )
    },
  )
}

export async function readGoBuildMetadata(binaryPath, options) {
  return withSecureGoInspection(binaryPath, options, async (inspection) => inspection)
}

export function assertGoBinaryArtifact({
  metadata,
  architecture,
  targetTriple,
  expectedMainModule,
}) {
  const buildInfo = parseGoBuildInfo(metadata)
  const target = assertGoBuildTarget(buildInfo, targetTriple)
  assertBinaryArchitectureInfo(architecture, targetTriple)
  if (expectedMainModule) assertGoMainModule(buildInfo, expectedMainModule)
  return {
    buildInfo,
    targetTriple,
    goos: target.goos,
    goarch: target.goarch,
    format: architecture.format,
    architecture: architecture.architectures[0],
  }
}

export async function inspectGoBinaryArtifact(binaryPath, options) {
  return withSecureGoInspection(
    binaryPath,
    options,
    async ({ architecture, goToolchainSnapshot, metadata, snapshot }) => ({
      ...assertGoBinaryArtifact({
        architecture,
        expectedMainModule: options.expectedMainModule,
        metadata,
        targetTriple: options.targetTriple,
      }),
      goToolchainSnapshot,
      snapshot,
    }),
  )
}

export async function inspectOllamaArtifact(binaryPath, options) {
  return withSecureGoInspection(
    binaryPath,
    options,
    async ({ architecture, goToolchainSnapshot, metadata, snapshot }) => ({
      ...assertOllamaArtifact({
        architecture,
        archiveBytes: options.archiveBytes,
        archiveSha256: options.archiveSha256,
        archiveUrl: options.archiveUrl,
        binaryBytes: Number(snapshot.sizeBytes),
        binarySha256: snapshot.sha256,
        metadata,
        targetTriple: options.targetTriple,
      }),
      goToolchainSnapshot,
      snapshot,
    }),
  )
}

export function assertSidecarArtifact({ metadata, architecture, expectedVersion, targetTriple }) {
  const artifact = assertGoBinaryArtifact({ metadata, architecture, targetTriple })
  if (artifact.buildInfo.packagePath !== 'github.com/hexagon-codes/hexclaw/cmd/hexclaw') {
    throw new Error('sidecar Go package path must match exactly')
  }
  if (artifact.buildInfo.mainModule.path !== 'github.com/hexagon-codes/hexclaw') {
    throw new Error('sidecar Go main module path must match exactly')
  }
  return {
    version: assertSidecarVersion(metadata, expectedVersion),
    targetTriple: artifact.targetTriple,
    goos: artifact.goos,
    goarch: artifact.goarch,
    format: artifact.format,
    architecture: artifact.architecture,
  }
}

export async function inspectSidecarArtifact(binaryPath, expectedVersion, options = {}) {
  const declaredTargetTriple = inferSidecarTarget(binaryPath)
  if (options.targetTriple && options.targetTriple !== declaredTargetTriple) {
    throw new Error('explicit target must match the sidecar filename')
  }
  const targetTriple = options.targetTriple ?? declaredTargetTriple
  return withSecureGoInspection(
    binaryPath,
    options,
    async ({ architecture, goToolchainSnapshot, metadata, snapshot }) => ({
      ...assertSidecarArtifact({ architecture, expectedVersion, metadata, targetTriple }),
      goToolchainSnapshot,
      snapshot,
    }),
  )
}

async function main() {
  const [binaryPath, explicitExpectedVersion, explicitTargetTriple] = process.argv.slice(2)
  if (!binaryPath) {
    console.error(
      'Usage: set the package Go toolchain identity and private generation, then verify-sidecar-version.mjs <sidecar-binary> [expected-version] [target-triple]',
    )
    process.exit(2)
  }

  let expectedVersion = explicitExpectedVersion
  if (!expectedVersion) {
    try {
      expectedVersion = JSON.parse(
        await readFile(new URL('../../src-tauri/tauri.conf.json', import.meta.url), 'utf8'),
      ).version
    } catch {
      throw new Error('unable to read Desktop release version')
    }
  }
  if (typeof expectedVersion !== 'string' || expectedVersion.length === 0) {
    throw new Error('Desktop release version is invalid')
  }
  const artifact = await inspectSidecarArtifact(binaryPath, expectedVersion, {
    goToolchain: {
      executable: process.env.HEXCLAW_PACKAGE_GO_EXECUTABLE,
      executableSha256: process.env.HEXCLAW_PACKAGE_GO_SHA256,
      goroot: process.env.HEXCLAW_PACKAGE_GO_GOROOT,
    },
    snapshotRoot: process.env.HEXCLAW_PACKAGE_PRIVATE_GENERATION,
    targetTriple: explicitTargetTriple,
  })
  console.log(`Sidecar artifact verified: ${artifact.version} (${artifact.targetTriple})`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
