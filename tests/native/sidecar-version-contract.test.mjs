import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  assertGoBinaryArtifact,
  assertGoBuildTarget,
  assertGoMainModule,
  assertOllamaArtifact,
  assertEmbeddedSidecarVersion,
  assertSidecarArtifact,
  extractGoBuildSetting,
  inferSidecarTarget,
  inspectSidecarArtifact,
  normalizeReleaseVersion,
  OLLAMA_PACKAGE_CONTRACT,
  parseGoBuildInfo,
  readGoBuildMetadata,
} from '../../scripts/ci/verify-sidecar-version.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

async function readRepoFile(path) {
  return readFile(resolve(repoRoot, path), 'utf8')
}

async function privateTestRoot(prefix) {
  return mkdtemp(join(await realpath(tmpdir()), prefix))
}

function hostTriple() {
  return execFileSync('rustc', ['-vV'], { encoding: 'utf8' }).match(/^host:\s+(.+)$/m)?.[1]
}

function hostGoToolchain() {
  const executable = execFileSync('/usr/bin/which', ['go'], { encoding: 'utf8' }).trim()
  return {
    executable,
    executableSha256: createHash('sha256').update(readFileSync(executable)).digest('hex'),
    goroot: execFileSync(executable, ['env', 'GOROOT'], { encoding: 'utf8' }).trim(),
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function x86MachO64() {
  const header = Buffer.alloc(32)
  header.writeUInt32LE(0xfeedfacf, 0)
  header.writeUInt32LE(0x01000007, 4)
  return Buffer.concat([header, Buffer.from('hexclaw-sidecar-version=0.5.0-beta;')])
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function fakeGoMetadataScript(attack = '') {
  return `#!/bin/sh
set -eu
${attack}
printf '%s\\n' \\
  'snapshot: go1.25.0' \\
  '\tpath\tgithub.com/hexagon-codes/hexclaw/cmd/hexclaw' \\
  '\tmod\tgithub.com/hexagon-codes/hexclaw\t(devel)' \\
  '\tbuild\t-trimpath=true' \\
  '\tbuild\tGOARCH=amd64' \\
  '\tbuild\tGOOS=darwin'
`
}

async function writeFakeGoTool(root, attack = '') {
  const executable = join(root, 'fake-go')
  const source = fakeGoMetadataScript(attack)
  await writeFile(executable, source, { mode: 0o700 })
  await chmod(executable, 0o700)
  return { executable, executableSha256: sha256(source), goroot: root }
}

async function writeEnvironmentProbeGoTool(root) {
  const executable = join(root, 'environment-probe-go')
  const source = `#!/bin/sh
set -eu
inherited=''
if [ "\${HOME-}" = 'forbidden-HOME' ]; then inherited="\${inherited}HOME,"; fi
if [ "\${PATH-}" = 'forbidden-PATH' ]; then inherited="\${inherited}PATH,"; fi
if [ "\${HEXCLAW_SECRET_PROBE-}" = 'forbidden-HEXCLAW_SECRET_PROBE' ]; then inherited="\${inherited}SECRET,"; fi
if [ "\${DYLD_LIBRARY_PATH-}" = 'forbidden-DYLD_LIBRARY_PATH' ]; then inherited="\${inherited}DYLD,"; fi
if [ "\${LD_PRELOAD-}" = 'forbidden-LD_PRELOAD' ]; then inherited="\${inherited}LD_PRELOAD,"; fi
if [ -z "$inherited" ]; then inherited='none'; fi
printf '%s\\n' \\
  'snapshot: go1.25.0' \\
  '\tpath\tgithub.com/hexagon-codes/hexclaw/cmd/hexclaw' \\
  '\tmod\tgithub.com/hexagon-codes/hexclaw\t(devel)' \\
  '\tbuild\t-trimpath=true' \\
  '\tbuild\tGOARCH=amd64' \\
  '\tbuild\tGOOS=darwin'
printf '\tbuild\tprobe.inherited=%s\\n' "$inherited"
printf '\tbuild\tprobe.allowed=%s|%s|%s\\n' "\${GOENV-}" "\${GOROOT-}" "\${GOTOOLCHAIN-}"
`
  await writeFile(executable, source, { mode: 0o700 })
  await chmod(executable, 0o700)
  return { executable, executableSha256: sha256(source), goroot: root }
}

test('sidecar release identity is fail-closed and independent of trimmed Go metadata', () => {
  assert.equal(normalizeReleaseVersion('0.5.0-beta'), '0.5.0-beta')
  assert.equal(normalizeReleaseVersion('v0.5.0-beta'), '0.5.0-beta')
  assert.equal(normalizeReleaseVersion('vv0.5.0-beta'), 'v0.5.0-beta')

  const marker = Buffer.from('hexclaw-sidecar-version=0.5.0-beta;')
  assert.equal(assertEmbeddedSidecarVersion(marker, 'v0.5.0-beta'), '0.5.0-beta')
  assert.throws(() => assertEmbeddedSidecarVersion(Buffer.alloc(0), '0.5.0-beta'), /found 0/)
  assert.throws(
    () => assertEmbeddedSidecarVersion(Buffer.concat([marker, marker]), '0.5.0-beta'),
    /found 2/,
  )
  assert.throws(() => assertEmbeddedSidecarVersion(marker, '0.5.1'), /found 0/)

  const sensitiveExpectedVersion = '/Users/private-account/secret/release'
  assert.throws(
    () => assertEmbeddedSidecarVersion(marker, sensitiveExpectedVersion),
    (error) =>
      error instanceof Error &&
      /found 0/.test(error.message) &&
      !error.message.includes(sensitiveExpectedVersion),
  )
})

test('sidecar target assertion binds Go metadata and the binary header to one target', () => {
  const metadata = [
    '\tpath\tgithub.com/hexagon-codes/hexclaw/cmd/hexclaw',
    '\tmod\tgithub.com/hexagon-codes/hexclaw\tv0.5.0-beta\th1:fixture',
    'build\t-ldflags="-X main.version=0.5.0-beta"',
    'build\tGOARCH=amd64',
    'build\tGOOS=darwin',
  ].join('\n')
  const architecture = { format: 'mach-o', architectures: ['x86_64'] }

  assert.equal(extractGoBuildSetting(metadata, 'GOOS'), 'darwin')
  assert.equal(extractGoBuildSetting(metadata, 'GOARCH'), 'amd64')
  assert.deepEqual(
    assertSidecarArtifact({
      metadata,
      architecture,
      targetTriple: 'x86_64-apple-darwin',
    }),
    {
      targetTriple: 'x86_64-apple-darwin',
      goos: 'darwin',
      goarch: 'amd64',
      format: 'mach-o',
      architecture: 'x86_64',
    },
  )

  assert.throws(
    () =>
      assertSidecarArtifact({
        metadata: metadata.replace('GOOS=darwin', 'GOOS=linux'),
        architecture,
        targetTriple: 'x86_64-apple-darwin',
      }),
    /Go build metadata GOOS must match the target/,
  )
  assert.throws(
    () =>
      assertSidecarArtifact({
        metadata: metadata.replace('GOARCH=amd64', 'GOARCH=arm64'),
        architecture,
        targetTriple: 'x86_64-apple-darwin',
      }),
    /Go build metadata GOARCH must match the target/,
  )
  assert.throws(
    () =>
      assertSidecarArtifact({
        metadata,
        architecture: { format: 'mach-o', architectures: ['arm64'] },
        targetTriple: 'x86_64-apple-darwin',
      }),
    /binary architecture must match the target/,
  )
  assert.throws(
    () =>
      assertSidecarArtifact({
        metadata: metadata.replace(
          'github.com/hexagon-codes/hexclaw/cmd/hexclaw',
          'example.com/lookalike/cmd/hexclaw',
        ),
        architecture,
        targetTriple: 'x86_64-apple-darwin',
      }),
    /sidecar Go package path must match exactly/,
  )
  assert.throws(
    () =>
      assertSidecarArtifact({
        metadata: metadata.replace(
          '\tmod\tgithub.com/hexagon-codes/hexclaw\t',
          '\tmod\texample.com/lookalike\t',
        ),
        architecture,
        targetTriple: 'x86_64-apple-darwin',
      }),
    /sidecar Go main module path must match exactly/,
  )

  const develMetadata = metadata.replace(
    '\tmod\tgithub.com/hexagon-codes/hexclaw\tv0.5.0-beta\th1:fixture',
    '\tmod\tgithub.com/hexagon-codes/hexclaw\t(devel)',
  )
  assert.doesNotThrow(() =>
    assertSidecarArtifact({
      metadata: develMetadata,
      architecture,
      targetTriple: 'x86_64-apple-darwin',
    }),
  )
})

test('Go buildinfo reader requires the package-selected executable and SHA-256 identity', async (t) => {
  const snapshotRoot = await privateTestRoot('hexclaw-go-buildinfo-')
  t.after(() => rm(snapshotRoot, { force: true, recursive: true }))
  const sensitiveBinaryPath = '/Users/private-account/secret/hexclaw-x86_64-apple-darwin'
  await assert.rejects(
    () =>
      readGoBuildMetadata(sensitiveBinaryPath, {
        goToolchain: {
          executable: 'go',
          executableSha256: 'a'.repeat(64),
          goroot: snapshotRoot,
        },
        snapshotRoot,
      }),
    (error) =>
      error instanceof Error &&
      error.message === 'package Go toolchain identity is required' &&
      !error.message.includes(sensitiveBinaryPath),
  )
  const goToolchain = hostGoToolchain()
  await assert.rejects(
    () =>
      readGoBuildMetadata(sensitiveBinaryPath, {
        goToolchain: {
          ...goToolchain,
          executableSha256: 'b'.repeat(64),
        },
        snapshotRoot,
      }),
    (error) =>
      error instanceof Error &&
      error.message === 'package Go toolchain identity does not match' &&
      !error.message.includes(sensitiveBinaryPath),
  )
})

test('sidecar CLI reports a stable category without disclosing a rejected binary path', async (t) => {
  const snapshotRoot = await privateTestRoot('hexclaw-sidecar-cli-')
  t.after(() => rm(snapshotRoot, { force: true, recursive: true }))
  const sensitiveBinaryPath = '/Users/private-account/secret/hexclaw-x86_64-apple-darwin'
  const environment = { ...process.env }
  delete environment.HEXCLAW_PACKAGE_GO_EXECUTABLE
  delete environment.HEXCLAW_PACKAGE_GO_GOROOT
  delete environment.HEXCLAW_PACKAGE_GO_SHA256
  environment.HEXCLAW_PACKAGE_PRIVATE_GENERATION = snapshotRoot
  const result = spawnSync(
    process.execPath,
    [resolve(repoRoot, 'scripts/ci/verify-sidecar-version.mjs'), sensitiveBinaryPath, '0.5.0-beta'],
    { encoding: 'utf8', env: environment },
  )
  assert.equal(result.status, 1)
  assert.equal(result.stderr.trim(), 'package Go toolchain identity is required')
  assert.doesNotMatch(result.stderr, /private-account|secret/u)
})

test('Go helper private copy detects an A-to-B-to-A pathname exchange', async (t) => {
  const fixtureRoot = await privateTestRoot('hexclaw-go-swap-')
  t.after(() => rm(fixtureRoot, { force: true, recursive: true }))
  const binaryPath = join(fixtureRoot, 'hexclaw-x86_64-apple-darwin')
  await writeFile(binaryPath, x86MachO64(), { mode: 0o500 })
  const goToolchain = await writeFakeGoTool(
    fixtureRoot,
    [
      'helper_parent="${0%/*}"',
      '/bin/chmod 700 "$helper_parent"',
      '/bin/mv "$0" "$0.original"',
      '/bin/ln -s /bin/false "$0"',
      '/bin/rm "$0"',
      '/bin/mv "$0.original" "$0"',
      '/bin/chmod 700 "$helper_parent"',
    ].join('\n'),
  )

  await assert.rejects(
    inspectSidecarArtifact(binaryPath, '0.5.0-beta', {
      goToolchain,
      snapshotRoot: fixtureRoot,
    }),
    (error) =>
      error instanceof Error &&
      error.message === 'package Go toolchain snapshot changed' &&
      !error.message.includes(fixtureRoot),
  )
})

test('Go helper uses a clean allowlisted environment and returns trusted-copy evidence', async (t) => {
  const verifierSource = await readRepoFile('scripts/ci/verify-sidecar-version.mjs')
  assert.doesNotMatch(verifierSource, /\{\s*\.\.\.process\.env\s*\}/u)
  assert.match(
    verifierSource,
    /const environment = \{\s*GOENV: 'off',\s*GOROOT: goToolchain\.goroot,\s*GOTOOLCHAIN: 'local',\s*\}/u,
  )

  const fixtureRoot = await privateTestRoot('hexclaw-go-environment-')
  t.after(() => rm(fixtureRoot, { force: true, recursive: true }))
  const binaryPath = join(fixtureRoot, 'hexclaw-x86_64-apple-darwin')
  await writeFile(binaryPath, x86MachO64(), { mode: 0o500 })
  const goToolchain = await writeEnvironmentProbeGoTool(fixtureRoot)
  const inheritedNames = ['HOME', 'PATH', 'HEXCLAW_SECRET_PROBE', 'DYLD_LIBRARY_PATH', 'LD_PRELOAD']
  const previous = new Map(inheritedNames.map((name) => [name, process.env[name]]))
  for (const name of inheritedNames) process.env[name] = `forbidden-${name}`
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })

  const result = await readGoBuildMetadata(binaryPath, {
    goToolchain,
    snapshotRoot: fixtureRoot,
  })
  assert.equal(extractGoBuildSetting(result.metadata, 'probe.inherited'), 'none')
  assert.equal(
    extractGoBuildSetting(result.metadata, 'probe.allowed'),
    `off|${goToolchain.goroot}|local`,
  )
  assert.equal(result.goToolchainSnapshot.copyIdentity.linkCount, '1')
  assert.equal(result.goToolchainSnapshot.copyIdentity.ownerUserId, String(process.getuid()))
  assert.equal(result.goToolchainSnapshot.copyIdentity.mode, '500')
})

test('binary snapshot rejects a staged path rename-to-symlink exchange during buildinfo', async (t) => {
  const fixtureRoot = await privateTestRoot('hexclaw-binary-swap-')
  t.after(() => rm(fixtureRoot, { force: true, recursive: true }))
  const binaryPath = join(fixtureRoot, 'hexclaw-x86_64-apple-darwin')
  const replacementPath = join(fixtureRoot, 'replacement-binary')
  await writeFile(binaryPath, x86MachO64(), { mode: 0o500 })
  await writeFile(replacementPath, x86MachO64(), { mode: 0o500 })
  const attack = [
    `mv ${shellQuote(binaryPath)} ${shellQuote(`${binaryPath}.original`)}`,
    `ln -s ${shellQuote(replacementPath)} ${shellQuote(binaryPath)}`,
  ].join('\n')
  const goToolchain = await writeFakeGoTool(fixtureRoot, attack)

  await assert.rejects(
    inspectSidecarArtifact(binaryPath, '0.5.0-beta', {
      goToolchain,
      snapshotRoot: fixtureRoot,
    }),
    (error) =>
      error instanceof Error &&
      error.message === 'binary snapshot source identity changed' &&
      !error.message.includes(fixtureRoot),
  )
})

test('Go buildinfo parser exposes one reusable main module and target identity', () => {
  const metadata = [
    'fixture-binary: go1.25.0',
    '\tpath\tgithub.com/ollama/ollama/cmd/ollama',
    '\tmod\tgithub.com/ollama/ollama\tv0.30.10\th1:fixture',
    '\tbuild\tGOARCH=arm64',
    '\tbuild\tGOOS=darwin',
  ].join('\n')
  const buildInfo = parseGoBuildInfo(metadata)

  assert.equal(buildInfo.packagePath, 'github.com/ollama/ollama/cmd/ollama')
  assert.deepEqual(buildInfo.mainModule, {
    path: 'github.com/ollama/ollama',
    version: 'v0.30.10',
    checksum: 'h1:fixture',
  })
  assert.equal(buildInfo.settings.GOOS, 'darwin')
  assert.equal(buildInfo.settings.GOARCH, 'arm64')
  assert.deepEqual(assertGoBuildTarget(buildInfo, 'aarch64-apple-darwin'), {
    goos: 'darwin',
    goarch: 'arm64',
  })
  assert.deepEqual(
    assertGoMainModule(buildInfo, {
      path: 'github.com/ollama/ollama',
      version: '0.30.10',
    }),
    buildInfo.mainModule,
  )

  const artifact = assertGoBinaryArtifact({
    metadata,
    architecture: { format: 'mach-o', architectures: ['arm64'] },
    targetTriple: 'aarch64-apple-darwin',
    expectedMainModule: {
      path: 'github.com/ollama/ollama',
      version: '0.30.10',
    },
  })
  assert.equal(artifact.buildInfo.mainModule.path, 'github.com/ollama/ollama')
  assert.equal(artifact.buildInfo.mainModule.version, 'v0.30.10')
  assert.equal(artifact.goos, 'darwin')
  assert.equal(artifact.goarch, 'arm64')
  assert.equal(artifact.architecture, 'arm64')
})

test('exact Go main module assertion rejects another module, devel, dirty, and other versions', () => {
  const metadata = (modulePath, version) =>
    [
      '\tpath\tgithub.com/ollama/ollama/cmd/ollama',
      `\tmod\t${modulePath}\t${version}\th1:fixture`,
      '\tbuild\tGOARCH=amd64',
      '\tbuild\tGOOS=darwin',
    ].join('\n')
  const expected = { path: 'github.com/ollama/ollama', version: '0.30.10' }

  assert.throws(
    () =>
      assertGoMainModule(parseGoBuildInfo(metadata('example.com/lookalike', 'v0.30.10')), expected),
    /Go main module path must match exactly/,
  )
  assert.throws(
    () =>
      assertGoMainModule(
        parseGoBuildInfo(metadata('github.com/ollama/ollama', '(devel)')),
        expected,
      ),
    /Go main module version must match exactly/,
  )
  assert.throws(
    () =>
      assertGoMainModule(
        parseGoBuildInfo(metadata('github.com/ollama/ollama', 'v0.30.10+dirty')),
        expected,
      ),
    /Go main module version must match exactly/,
  )
  assert.throws(
    () =>
      assertGoMainModule(
        parseGoBuildInfo(metadata('github.com/ollama/ollama', 'v0.30.11')),
        expected,
      ),
    /Go main module version must match exactly/,
  )
})

test('Ollama package identity is exported as one deeply immutable official contract', async () => {
  const verifier = await import('../../scripts/ci/verify-sidecar-version.mjs')
  const contract = verifier.OLLAMA_PACKAGE_CONTRACT
  assert.deepEqual(contract, {
    architectures: ['x86_64', 'arm64'],
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
  assert.equal(Object.isFrozen(contract), true)
  assert.equal(Object.isFrozen(contract.architectures), true)
  assert.throws(() => {
    contract.archiveSha256 = '0'.repeat(64)
  }, TypeError)
  assert.throws(() => {
    contract.architectures.push('riscv64')
  }, TypeError)
})

test('Ollama gate accepts the pinned official dirty universal2 artifact as one joint identity', () => {
  const metadata = [
    `\tpath\t${OLLAMA_PACKAGE_CONTRACT.packagePath}`,
    `\tmod\t${OLLAMA_PACKAGE_CONTRACT.modulePath}\t${OLLAMA_PACKAGE_CONTRACT.moduleVersion}`,
    '\tbuild\tGOARCH=amd64',
    `\tbuild\tGOOS=${OLLAMA_PACKAGE_CONTRACT.goos}`,
    `\tbuild\tvcs.revision=${OLLAMA_PACKAGE_CONTRACT.vcsRevision}`,
    `\tbuild\tvcs.modified=${OLLAMA_PACKAGE_CONTRACT.vcsModified}`,
  ].join('\n')
  const universal2 = {
    format: 'mach-o',
    architectures: [...OLLAMA_PACKAGE_CONTRACT.architectures],
  }

  const result = assertOllamaArtifact({
    metadata,
    architecture: universal2,
    targetTriple: 'aarch64-apple-darwin',
    archiveBytes: OLLAMA_PACKAGE_CONTRACT.archiveBytes,
    archiveSha256: OLLAMA_PACKAGE_CONTRACT.archiveSha256,
    archiveUrl: OLLAMA_PACKAGE_CONTRACT.url,
    binaryBytes: OLLAMA_PACKAGE_CONTRACT.binaryBytes,
    binarySha256: OLLAMA_PACKAGE_CONTRACT.binarySha256,
  })
  assert.equal(result.mainModule.path, OLLAMA_PACKAGE_CONTRACT.modulePath)
  assert.equal(result.mainModule.version, OLLAMA_PACKAGE_CONTRACT.moduleVersion)
  assert.equal(result.goos, OLLAMA_PACKAGE_CONTRACT.goos)
  assert.equal(result.buildInfoGoarch, 'amd64')
  assert.equal(result.targetArchitecture, 'arm64')
  assert.equal(result.binarySha256, OLLAMA_PACKAGE_CONTRACT.binarySha256)
})

test('Ollama gate rejects any mismatch in archive, binary, exact metadata, or universal2 slices', () => {
  const metadata = (
    version = OLLAMA_PACKAGE_CONTRACT.moduleVersion,
    revision = OLLAMA_PACKAGE_CONTRACT.vcsRevision,
    modified = String(OLLAMA_PACKAGE_CONTRACT.vcsModified),
    packagePath = OLLAMA_PACKAGE_CONTRACT.packagePath,
    modulePath = OLLAMA_PACKAGE_CONTRACT.modulePath,
  ) =>
    [
      `\tpath\t${packagePath}`,
      `\tmod\t${modulePath}\t${version}`,
      '\tbuild\tGOARCH=amd64',
      `\tbuild\tGOOS=${OLLAMA_PACKAGE_CONTRACT.goos}`,
      `\tbuild\tvcs.revision=${revision}`,
      `\tbuild\tvcs.modified=${modified}`,
    ].join('\n')
  const universal2 = {
    format: 'mach-o',
    architectures: [...OLLAMA_PACKAGE_CONTRACT.architectures],
  }
  const verify = (overrides = {}) =>
    assertOllamaArtifact({
      metadata: metadata(),
      architecture: universal2,
      targetTriple: 'aarch64-apple-darwin',
      archiveBytes: OLLAMA_PACKAGE_CONTRACT.archiveBytes,
      archiveSha256: OLLAMA_PACKAGE_CONTRACT.archiveSha256,
      archiveUrl: OLLAMA_PACKAGE_CONTRACT.url,
      binaryBytes: OLLAMA_PACKAGE_CONTRACT.binaryBytes,
      binarySha256: OLLAMA_PACKAGE_CONTRACT.binarySha256,
      ...overrides,
    })

  assert.throws(
    () => verify({ archiveSha256: '0'.repeat(64) }),
    /Ollama archive SHA-256 must match exactly/,
  )
  assert.throws(
    () => verify({ archiveBytes: OLLAMA_PACKAGE_CONTRACT.archiveBytes - 1 }),
    /Ollama archive size must match exactly/,
  )
  assert.throws(
    () => verify({ archiveUrl: `${OLLAMA_PACKAGE_CONTRACT.url}.mirror` }),
    /Ollama archive URL must match exactly/,
  )
  assert.throws(
    () => verify({ binarySha256: '0'.repeat(64) }),
    /Ollama binary SHA-256 must match exactly/,
  )
  assert.throws(
    () => verify({ binaryBytes: OLLAMA_PACKAGE_CONTRACT.binaryBytes - 1 }),
    /Ollama binary size must match exactly/,
  )
  assert.throws(
    () => verify({ metadata: metadata('v0.30.10') }),
    /Ollama main module version must match exactly/,
  )
  assert.throws(
    () =>
      verify({
        metadata: metadata(
          OLLAMA_PACKAGE_CONTRACT.moduleVersion,
          OLLAMA_PACKAGE_CONTRACT.vcsRevision,
          'true',
          'github.com/ollama/ollama/cmd/ollama',
        ),
      }),
    /Ollama Go package path must match exactly/,
  )
  assert.throws(
    () => verify({ metadata: metadata(OLLAMA_PACKAGE_CONTRACT.moduleVersion, '0'.repeat(40)) }),
    /Ollama VCS revision must match exactly/,
  )
  assert.throws(
    () =>
      verify({
        metadata: metadata(
          OLLAMA_PACKAGE_CONTRACT.moduleVersion,
          OLLAMA_PACKAGE_CONTRACT.vcsRevision,
          'false',
        ),
      }),
    /Ollama VCS modified state must match exactly/,
  )
  assert.throws(
    () => verify({ architecture: { format: 'mach-o', architectures: ['x86_64'] } }),
    /Ollama architectures must match universal2 exactly/,
  )
})

test('Go buildinfo parser fails closed for missing or duplicate identity fields', () => {
  assert.throws(() => parseGoBuildInfo('\tbuild\tGOOS=darwin'), /exactly one Go package path/)
  assert.throws(
    () =>
      parseGoBuildInfo(
        [
          '\tpath\texample.com/tool',
          '\tmod\texample.com/tool\tv1.0.0\th1:fixture',
          '\tbuild\tGOOS=darwin',
          '\tbuild\tGOOS=linux',
        ].join('\n'),
      ),
    /duplicate Go build setting/,
  )
})

test('sidecar target inference supports release targets without exposing rejected paths', () => {
  assert.equal(
    inferSidecarTarget('/private/build/hexclaw-aarch64-apple-darwin'),
    'aarch64-apple-darwin',
  )
  assert.equal(
    inferSidecarTarget('C:\\private\\build\\hexclaw-x86_64-pc-windows-msvc.exe'),
    'x86_64-pc-windows-msvc',
  )

  const sensitivePath = '/Users/private-account/secret/hexclaw-renamed'
  assert.throws(
    () => inferSidecarTarget(sensitivePath),
    (error) =>
      error instanceof Error &&
      /sidecar filename must declare a supported target/.test(error.message) &&
      !error.message.includes(sensitivePath),
  )
})

test('explicit target cannot override a different sidecar filename target', async () => {
  const sensitiveBinaryPath = '/Users/private-account/secret/hexclaw-aarch64-apple-darwin'
  await assert.rejects(
    inspectSidecarArtifact(sensitiveBinaryPath, '0.5.0-beta', {
      goToolchain: hostGoToolchain(),
      targetTriple: 'x86_64-apple-darwin',
    }),
    (error) =>
      error instanceof Error &&
      error.message === 'explicit target must match the sidecar filename' &&
      !error.message.includes(sensitiveBinaryPath),
  )
})

test('currently staged sidecar embeds the canonical Tauri release version', async (t) => {
  const snapshotRoot = await privateTestRoot('hexclaw-staged-sidecar-')
  t.after(() => rm(snapshotRoot, { force: true, recursive: true }))
  const tauriConfig = JSON.parse(await readRepoFile('src-tauri/tauri.conf.json'))
  const triple = hostTriple()
  assert.ok(triple, 'rustc host triple must be available')
  const binaryPath = resolve(repoRoot, 'src-tauri/binaries', `hexclaw-${triple}`)
  assert.ok(existsSync(binaryPath), `staged sidecar must exist at ${binaryPath}`)
  const result = await inspectSidecarArtifact(binaryPath, tauriConfig.version, {
    goToolchain: hostGoToolchain(),
    snapshotRoot,
  })
  assert.equal(result.version, tauriConfig.version)
  assert.equal(result.targetTriple, triple)
  assert.equal(result.goos, 'darwin')
  assert.ok(['amd64', 'arm64'].includes(result.goarch))
  assert.equal(result.format, 'mach-o')
  assert.match(result.snapshot.sha256, /^[0-9a-f]{64}$/u)
  assert.match(result.snapshot.sizeBytes, /^[1-9][0-9]*$/u)
  assert.equal(result.snapshot.sourceIdentity.sizeBytes, result.snapshot.sizeBytes)
  assert.equal(result.snapshot.copyIdentity.sizeBytes, result.snapshot.sizeBytes)
  assert.equal(result.snapshot.sourceIdentity.linkCount, '1')
  assert.equal(result.snapshot.sourceIdentity.ownerUserId, String(process.getuid()))
  assert.equal(Number.parseInt(result.snapshot.sourceIdentity.mode, 8) & 0o022, 0)
  assert.equal(result.snapshot.copyIdentity.linkCount, '1')
  assert.equal(result.snapshot.copyIdentity.ownerUserId, String(process.getuid()))
  assert.equal(result.goToolchainSnapshot.copyIdentity.linkCount, '1')
  assert.equal(result.goToolchainSnapshot.copyIdentity.ownerUserId, String(process.getuid()))
  assert.equal(result.goToolchainSnapshot.copyIdentity.mode, '500')
  assert.doesNotMatch(JSON.stringify(result.snapshot), /Users|private|snapshot/u)
})

test('all local and CI sidecar build paths inject Desktop version identity and verify before bundling', async () => {
  const [makefile, packageLocal, packageWorkflow, releaseWorkflow] = await Promise.all([
    readRepoFile('Makefile'),
    readRepoFile('scripts/ci/package-local.mjs'),
    readRepoFile('.github/workflows/package.yml'),
    readRepoFile('.github/workflows/release.yml'),
  ])

  assert.match(makefile, /SIDECAR_RELEASE_VERSION\s*:=\s*\$\(patsubst v%,%,\$\(DESKTOP_VERSION\)\)/)
  assert.equal(
    [...makefile.matchAll(/-X main\.sidecarVersionIdentity=hexclaw-sidecar-version=\$\$VERSION;/gu)]
      .length,
    5,
  )
  assert.match(
    packageLocal,
    /-X main\.sidecarVersionIdentity=hexclaw-sidecar-version=\$\{plan\.version\};/u,
  )
  assert.doesNotMatch(makefile, /VERSION="\$\$\(git describe --tags --always --dirty/)
  assert.match(
    makefile,
    /verify-sidecar-version\.mjs\s+"\$\(SIDECAR_BIN_DIR\)\/hexclaw-\$\(HOST_TRIPLE\)"/,
  )
  assert.doesNotMatch(makefile, /verify-sidecar-version\.mjs[^\n]*SIDECAR_RELEASE_VERSION/)
  const localVerifierIndex = makefile.indexOf('verify-sidecar-version.mjs')
  const localTauriBuildIndex = makefile.indexOf('$(PNPM_BIN) tauri build')
  assert.notEqual(localVerifierIndex, -1, 'local sidecar version gate must exist')
  assert.notEqual(localTauriBuildIndex, -1, 'local Tauri build must exist')
  assert.ok(
    localVerifierIndex < localTauriBuildIndex,
    'local sidecar version gate must execute before Tauri bundling',
  )

  for (const workflow of [packageWorkflow, releaseWorkflow]) {
    assert.doesNotMatch(workflow, /VERSION="\$\(git describe --tags --always --dirty/)
    assert.match(
      workflow,
      /DESKTOP_VERSION="\$\(node -p "require\('\.\/package\.json'\)\.version\.replace\(\/\^v\/, ''\)"\)"/,
    )
    assert.match(workflow, /verify-sidecar-version\.mjs/)
    assert.match(
      workflow,
      /-X main\.sidecarVersionIdentity=hexclaw-sidecar-version=\$\{VERSION\};/u,
    )
    assert.doesNotMatch(workflow, /verify-sidecar-version\.mjs[^\n]*DESKTOP_VERSION/)
    assert.ok(
      workflow.indexOf('verify-sidecar-version.mjs') < workflow.indexOf('tauri-apps/tauri-action'),
      'CI sidecar version gate must execute before Tauri bundling',
    )
  }
})

test('package-local sidecar and Ollama inspections bind the dependency Go copy to its source digest', async () => {
  const packageLocal = await readRepoFile('scripts/ci/package-local.mjs')
  const dependencyGoInspections = [
    ...packageLocal.matchAll(
      /goToolchain:\s*\{\s*executable:\s*dependencies\.go\.executable,\s*executableSha256:\s*toolchains\.go\.(?<digestField>[A-Za-z0-9_]+),/gu,
    ),
  ]
  assert.equal(dependencyGoInspections.length, 2)
  assert.deepEqual(
    dependencyGoInspections.map((match) => match.groups.digestField),
    ['sourceSha256', 'sourceSha256'],
  )
})
