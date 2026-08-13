import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmod,
  mkdir,
  readFile,
  stat,
  symlink,
  truncate,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { tmpdir } from 'node:os'
import { mkdtemp } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const moduleURL = new URL('../../scripts/ci/k12-release-ui-attestation.mjs', import.meta.url)
const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const makefilePath = join(repoRoot, 'Makefile')
const execFileAsync = promisify(execFile)
const receiptSHA256 = '1'.repeat(64)
const generationId = 'generation-k12-release-fixture'
const targetTriple = 'x86_64-apple-darwin'

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function loadAttestation() {
  return import(moduleURL)
}

async function fixture(name) {
  const root = await mkdtemp(join(tmpdir(), `hexclaw-release-attestation-${name}-`))
  const distRoot = join(root, 'dist')
  const assets = join(distRoot, 'assets')
  await mkdir(assets, { recursive: true, mode: 0o700 })
  await writeFile(join(assets, 'app.js'), 'console.log("release")\n')
  await writeFile(join(distRoot, 'index.html'), '<script src="./assets/app.js"></script>\n')
  const installedAppBinary = join(root, 'hexclaw-desktop')
  const sidecarBinary = join(root, 'hexclaw')
  const packagePath = join(root, 'HexClaw.dmg')
  await writeFile(installedAppBinary, 'installed-app-bytes\n')
  await writeFile(sidecarBinary, 'sidecar-bytes\n')
  await writeFile(packagePath, 'package-bytes\n')
  const sourceManifestPath = join(root, 'package-source-manifest.json')
  const sourceManifestBytes = Buffer.from(
    '{"schema":"hexclaw.package-source-identity.v2"}\n',
    'utf8',
  )
  await writeFile(sourceManifestPath, sourceManifestBytes, { mode: 0o600 })
  await chmod(installedAppBinary, 0o700)
  await chmod(sidecarBinary, 0o700)
  return {
    root,
    distRoot,
    installedAppBinary,
    sidecarBinary,
    packagePath,
    manifestPath: join(root, 'release-ui-dist-manifest.json'),
    receiptPath: join(root, 'release-ui-attestation.json'),
    generationId,
    sourceManifestPath,
    sourceManifestSHA256: sha256(sourceManifestBytes),
    targetTriple,
  }
}

function creationOptions(paths, overrides = {}) {
  return {
    distRoot: paths.distRoot,
    generationId: paths.generationId,
    installedAppBinary: paths.installedAppBinary,
    manifestPath: paths.manifestPath,
    packagePath: paths.packagePath,
    receiptPath: paths.receiptPath,
    releaseVersion: '0.5.0-beta',
    sidecarBinary: paths.sidecarBinary,
    sourceManifestPath: paths.sourceManifestPath,
    sourceManifestSHA256: paths.sourceManifestSHA256,
    targetTriple: paths.targetTriple,
    ...overrides,
  }
}

function verificationOptions(paths, expectedReceiptSHA256, overrides = {}) {
  return {
    distRoot: paths.distRoot,
    expectedGenerationId: paths.generationId,
    expectedReceiptSHA256,
    expectedSourceManifestSHA256: paths.sourceManifestSHA256,
    expectedTargetTriple: paths.targetTriple,
    installedAppBinary: paths.installedAppBinary,
    manifestPath: paths.manifestPath,
    packagePath: paths.packagePath,
    receiptPath: paths.receiptPath,
    releaseVersion: '0.5.0-beta',
    sidecarBinary: paths.sidecarBinary,
    sourceManifestPath: paths.sourceManifestPath,
    ...overrides,
  }
}

async function create(name) {
  const paths = await fixture(name)
  const { createReleaseAttestation } = await loadAttestation()
  const result = await createReleaseAttestation(creationOptions(paths))
  return { ...paths, ...result }
}

async function writeCommandStub(directory, name, body) {
  const pathname = join(directory, name)
  await writeFile(pathname, `#!/bin/sh\nset -u\n${body}\n`)
  await chmod(pathname, 0o700)
}

async function runLocalMake(target = 'package-local', failStep = '') {
  const root = await mkdtemp(join(tmpdir(), 'hexclaw-package-local-contract-'))
  const bin = join(root, 'bin')
  const commandLog = join(root, 'commands.log')
  const overlay = join(root, 'Makefile.contract')
  const packageScripts = join(root, 'scripts', 'ci')
  await mkdir(bin, { recursive: true, mode: 0o700 })
  await mkdir(packageScripts, { recursive: true, mode: 0o700 })
  await writeFile(
    join(packageScripts, 'package-local.mjs'),
    `import { appendFileSync } from 'node:fs'\nappendFileSync(process.env.PACKAGE_LOCAL_COMMAND_LOG, 'orchestrator\\n')\nif (process.env.PACKAGE_LOCAL_FAIL_STEP === 'orchestrator') process.exit(73)\nprocess.stdout.write('PASS: package-local category=complete\\n')\n`,
    { mode: 0o600 },
  )
  await writeFile(
    overlay,
    `include ${makefilePath}\n\nverify-local-deps:\n\t@:\n\nsidecar-local:\n\t@:\n\nrender-bundle:\n\t@:\n`,
  )

  await writeCommandStub(
    bin,
    'uname',
    `printf '%s\\n' 'uname' >> "$PACKAGE_LOCAL_COMMAND_LOG"\nprintf '%s\\n' 'Darwin'`,
  )
  await writeCommandStub(
    bin,
    'date',
    `
printf '%s\\n' 'date' >> "$PACKAGE_LOCAL_COMMAND_LOG"
if [ "\${PACKAGE_LOCAL_FAIL_STEP:-}" = 'date' ]; then exit 70; fi
printf '%s\\n' '1700000000'`,
  )
  await writeCommandStub(
    bin,
    'shasum',
    `
printf '%s\\n' 'shasum' >> "$PACKAGE_LOCAL_COMMAND_LOG"
if [ "\${PACKAGE_LOCAL_FAIL_STEP:-}" = 'shasum' ]; then exit 70; fi
printf '%s  %s\\n' '${receiptSHA256}' "$3"`,
  )
  await writeCommandStub(
    bin,
    'node',
    `
case "$*" in
  *'package-sensitive-boundary.mjs'*)
    printf '%s\n' 'sensitive' >> "$PACKAGE_LOCAL_COMMAND_LOG"
    if [ "\${PACKAGE_LOCAL_FAIL_STEP:-}" = 'sensitive' ]; then exit 74; fi
    printf '%s\n' 'SENSITIVE_COMPLETE'
    ;;
  *'k12-release-ui-attestation.mjs create'*)
    printf '%s\\n' 'attestation' >> "$PACKAGE_LOCAL_COMMAND_LOG"
    if [ "\${PACKAGE_LOCAL_FAIL_STEP:-}" = 'attestation' ]; then exit 71; fi
    printf '%s\\n' '{"receiptSHA256":"${receiptSHA256}"}'
    ;;
  *'k12-release-ui-attestation.mjs verify'*)
    printf '%s\\n' 'verify' >> "$PACKAGE_LOCAL_COMMAND_LOG"
    if [ "\${PACKAGE_LOCAL_FAIL_STEP:-}" = 'verify' ]; then exit 72; fi
    printf '%s\\n' 'VERIFY_COMPLETE'
    ;;
  *'verify-package-local.mjs'*)
    printf '%s\\n' 'verify' >> "$PACKAGE_LOCAL_COMMAND_LOG"
    if [ "\${PACKAGE_LOCAL_FAIL_STEP:-}" = 'verify' ]; then exit 72; fi
    printf '%s\\n' 'VERIFY_COMPLETE'
    printf '%s\\n' 'PASS: package-local artifact identity verified.'
    ;;
  *)
    printf '%s\\n' 'node' >> "$PACKAGE_LOCAL_COMMAND_LOG"
    if [ "\${PACKAGE_LOCAL_FAIL_STEP:-}" = 'node' ]; then exit 69; fi
    ;;
esac`,
  )

  for (const name of ['pnpm', 'mkdir', 'ditto', 'ln', 'hdiutil']) {
    await writeCommandStub(
      bin,
      name,
      `
printf '%s\\n' '${name}' >> "$PACKAGE_LOCAL_COMMAND_LOG"
if [ "\${PACKAGE_LOCAL_FAIL_STEP:-}" = '${name}' ]; then exit 73; fi`,
    )
  }

  await writeCommandStub(
    bin,
    'rm',
    `
case "$*" in
  *'HexClaw.dmgroot'*)
    if grep -q '^hdiutil$' "$PACKAGE_LOCAL_COMMAND_LOG"; then
      step='rm-root-after'
    else
      step='rm-root-before'
    fi
    ;;
  *) step='rm-artifacts' ;;
esac
printf '%s\\n' "$step" >> "$PACKAGE_LOCAL_COMMAND_LOG"
if [ "\${PACKAGE_LOCAL_FAIL_STEP:-}" = "$step" ]; then exit 73; fi`,
  )

  const environment = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    PACKAGE_LOCAL_COMMAND_LOG: commandLog,
    PACKAGE_LOCAL_FAIL_STEP: failStep,
  }
  try {
    const result = await execFileAsync(
      '/usr/bin/make',
      [
        '--no-print-directory',
        '-f',
        overlay,
        target,
        `DESKTOP_ROOT=${root}`,
        'DESKTOP_VERSION=0.5.0-beta',
        'HOST_TRIPLE=x86_64-apple-darwin',
      ],
      {
        cwd: root,
        env: environment,
        maxBuffer: 1024 * 1024,
      },
    )
    return {
      code: 0,
      stdout: result.stdout,
      stderr: result.stderr,
      commands: (await readFile(commandLog, 'utf8')).trim().split('\n').filter(Boolean),
    }
  } catch (error) {
    return {
      code: typeof error?.code === 'number' ? error.code : 1,
      stdout: error?.stdout ?? '',
      stderr: error?.stderr ?? '',
      commands: await readFile(commandLog, 'utf8')
        .then((value) => value.trim().split('\n').filter(Boolean))
        .catch(() => []),
    }
  }
}

function verifyCLIArguments(paths, expectedReceiptSHA256, notBeforeEpochSeconds) {
  return [
    fileURLToPath(moduleURL),
    'verify',
    '--dist',
    paths.distRoot,
    '--release-version',
    '0.5.0-beta',
    '--installed-app',
    paths.installedAppBinary,
    '--sidecar',
    paths.sidecarBinary,
    '--package',
    paths.packagePath,
    '--manifest',
    paths.manifestPath,
    '--receipt',
    paths.receiptPath,
    '--source-manifest',
    paths.sourceManifestPath,
    '--expected-receipt-sha256',
    expectedReceiptSHA256,
    '--expected-generation-id',
    paths.generationId,
    '--expected-source-manifest-sha256',
    paths.sourceManifestSHA256,
    '--expected-target-triple',
    paths.targetTriple,
    '--not-before-epoch-seconds',
    String(notBeforeEpochSeconds),
  ]
}

test('build receipt is deterministic, private and links exact dist/app/sidecar/package bytes', async () => {
  const first = await fixture('deterministic-a')
  const second = await fixture('deterministic-b')
  const old = new Date('2001-01-01T00:00:00Z')
  const future = new Date('2031-01-01T00:00:00Z')
  await utimes(join(first.distRoot, 'index.html'), old, old)
  await utimes(join(second.distRoot, 'index.html'), future, future)

  const { createReleaseAttestation } = await loadAttestation()
  const a = await createReleaseAttestation(creationOptions(first))
  const b = await createReleaseAttestation(creationOptions(second))
  const manifestA = await readFile(first.manifestPath, 'utf8')
  const manifestB = await readFile(second.manifestPath, 'utf8')
  const receiptA = await readFile(first.receiptPath, 'utf8')
  const receiptB = await readFile(second.receiptPath, 'utf8')

  assert.equal(manifestA, manifestB)
  assert.equal(receiptA, receiptB)
  assert.equal(a.manifestSHA256, b.manifestSHA256)
  assert.equal(a.receiptSHA256, b.receiptSHA256)
  assert.equal((await stat(first.manifestPath)).mode & 0o777, 0o600)
  assert.equal((await stat(first.receiptPath)).mode & 0o777, 0o600)

  const manifest = JSON.parse(manifestA)
  assert.deepEqual(Object.keys(manifest).sort(), ['files', 'release_version', 'schema_version'])
  assert.deepEqual(
    manifest.files.map((entry) => entry.path),
    ['assets/app.js', 'index.html'],
  )
  for (const entry of manifest.files) {
    assert.deepEqual(Object.keys(entry).sort(), ['bytes', 'path', 'sha256'])
    assert.match(entry.sha256, /^[a-f0-9]{64}$/)
  }

  const receipt = JSON.parse(receiptA)
  assert.deepEqual(Object.keys(receipt).sort(), [
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
  ])
  assert.equal(receipt.dist_manifest_file, 'release-ui-dist-manifest.json')
  assert.equal(receipt.installed_app_file, 'hexclaw-desktop')
  assert.equal(receipt.sidecar_file, 'hexclaw')
  assert.equal(receipt.package_file, 'HexClaw.dmg')
  assert.equal(receipt.generation_id, generationId)
  assert.equal(receipt.source_manifest_file, 'package-source-manifest.json')
  assert.equal(receipt.source_manifest_sha256, first.sourceManifestSHA256)
  assert.equal(receipt.target_triple, targetTriple)
  assert.equal(receipt.dist_manifest_sha256, a.manifestSHA256)
  assert.equal(receipt.dist_file_count, 2)
  assert.equal(
    receipt.dist_total_bytes,
    manifest.files.reduce((total, entry) => total + entry.bytes, 0),
  )
  assert.equal(receiptA.includes(first.root), false)
})

test('verification accepts only the exact attested tree and release identities', async () => {
  const built = await create('verify')
  const { verifyReleaseAttestation } = await loadAttestation()
  const verified = await verifyReleaseAttestation(verificationOptions(built, built.receiptSHA256))
  assert.equal(verified.distFileCount, 2)
  assert.equal(verified.receiptSHA256, built.receiptSHA256)
  assert.equal(verified.manifestSHA256, built.manifestSHA256)
})

test('verification fails closed on every asset and identity drift without repairing inputs', async () => {
  const { verifyReleaseAttestation } = await loadAttestation()
  const cases = [
    [
      'receipt sha',
      async (value) => {
        value.expectedReceiptSHA256 = '0'.repeat(64)
      },
    ],
    [
      'dist byte',
      async (value) => {
        await writeFile(join(value.distRoot, 'index.html'), 'drift\n')
      },
    ],
    [
      'extra dist file',
      async (value) => {
        await writeFile(join(value.distRoot, 'extra.js'), 'extra\n')
      },
    ],
    [
      'missing dist file',
      async (value) => {
        const { rm } = await import('node:fs/promises')
        await rm(join(value.distRoot, 'index.html'))
      },
    ],
    [
      'dist symlink',
      async (value) => {
        await symlink(join(value.distRoot, 'index.html'), join(value.distRoot, 'linked.html'))
      },
    ],
    [
      'installed app',
      async (value) => {
        await writeFile(value.installedAppBinary, 'app-drift\n')
      },
    ],
    [
      'sidecar',
      async (value) => {
        await writeFile(value.sidecarBinary, 'sidecar-drift\n')
      },
    ],
    [
      'package',
      async (value) => {
        await writeFile(value.packagePath, 'package-drift\n')
      },
    ],
  ]

  for (const [name, mutate] of cases) {
    const built = await create(name.replaceAll(' ', '-'))
    await mutate(built)
    await assert.rejects(
      verifyReleaseAttestation(
        verificationOptions(built, built.expectedReceiptSHA256 ?? built.receiptSHA256),
      ),
      undefined,
      name,
    )
  }
})

test('verification rejects non-private manifest and receipt permissions', async () => {
  const { verifyReleaseAttestation } = await loadAttestation()
  for (const [name, pathname, message] of [
    ['manifest', 'manifestPath', /dist manifest permissions must be 0600/],
    ['receipt', 'receiptPath', /release receipt permissions must be 0600/],
  ]) {
    const built = await create(`verify-private-${name}`)
    await chmod(built[pathname], 0o644)
    await assert.rejects(
      verifyReleaseAttestation(verificationOptions(built, built.receiptSHA256)),
      message,
    )
  }
})

test('attestation hashes artifacts with bounded streaming and no whole-file read API', async () => {
  const source = await readFile(moduleURL, 'utf8')
  assert.doesNotMatch(source, /\breadFile(?:Sync)?\b/)
  assert.match(source, /O_NOFOLLOW/)
  assert.match(source, /\.stat\(\{\s*bigint:\s*true\s*\}\)/)

  const paths = await fixture('stream-limit')
  const { createReleaseAttestation, ATTESTATION_LIMITS } = await loadAttestation()
  assert.equal(Number.isSafeInteger(ATTESTATION_LIMITS.maxArtifactBytes), true)
  await truncate(paths.packagePath, ATTESTATION_LIMITS.maxArtifactBytes + 1)
  await assert.rejects(
    createReleaseAttestation(creationOptions(paths)),
    /package exceeds the file size limit/,
  )
})

test('attestation enforces dist file count per-file and aggregate byte limits', async () => {
  const { createReleaseAttestation, ATTESTATION_LIMITS } = await loadAttestation()
  for (const [name, mutate, limits, message] of [
    [
      'file-count',
      async (paths) => writeFile(join(paths.distRoot, 'extra.js'), 'x'),
      { ...ATTESTATION_LIMITS, maxDistFiles: 2 },
      /dist tree exceeds the file count limit/,
    ],
    [
      'single-file',
      async (paths) => writeFile(join(paths.distRoot, 'large.bin'), '12345'),
      { ...ATTESTATION_LIMITS, maxDistFileBytes: 4 },
      /dist file exceeds the file size limit/,
    ],
    [
      'total-bytes',
      async () => undefined,
      { ...ATTESTATION_LIMITS, maxDistTotalBytes: 10 },
      /dist tree exceeds the total byte limit/,
    ],
  ]) {
    const paths = await fixture(`limit-${name}`)
    await mutate(paths)
    await assert.rejects(createReleaseAttestation(creationOptions(paths, { limits })), message)
  }
})

test('attestation refuses symlinked artifact identities even when the target is regular', async () => {
  const paths = await fixture('nofollow')
  const target = join(paths.root, 'actual-package.dmg')
  await writeFile(target, 'package-bytes\n')
  const { rm: remove } = await import('node:fs/promises')
  await remove(paths.packagePath)
  await symlink(target, paths.packagePath)
  const { createReleaseAttestation } = await loadAttestation()
  await assert.rejects(
    createReleaseAttestation(creationOptions(paths)),
    /package must be a regular non-symlink file/,
  )
})

test('build-local builds only the local app while package-local performs packaging afterward', async () => {
  const build = await runLocalMake('build-local')
  assert.equal(build.code, 0, build.stderr)
  assert.equal(build.commands.includes('pnpm'), true)
  for (const packagingStep of [
    'date',
    'sensitive',
    'rm-root-before',
    'rm-root-after',
    'rm-artifacts',
    'mkdir',
    'ditto',
    'ln',
    'hdiutil',
    'attestation',
    'shasum',
    'verify',
  ]) {
    assert.equal(build.commands.includes(packagingStep), false, packagingStep)
  }

  const packaged = await runLocalMake('package-local')
  assert.equal(packaged.code, 0, packaged.stderr)
  assert.deepEqual(
    packaged.commands.filter((command) => command !== 'node'),
    ['orchestrator'],
  )
  assert.equal(packaged.stdout, 'PASS: package-local category=complete\n')
})

test('package-local propagates the unique orchestrator failure', async () => {
  const result = await runLocalMake('package-local', 'orchestrator')

  assert.notEqual(result.code, 0)
  assert.deepEqual(
    result.commands.filter((command) => command !== 'node'),
    ['orchestrator'],
  )
  assert.equal(result.stdout, '')
})

test('package-local prints one fixed PASS only after the orchestrator succeeds', async () => {
  const result = await runLocalMake('package-local')
  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(
    result.commands.filter((command) => command !== 'node'),
    ['orchestrator'],
  )
  assert.equal(result.stdout.match(/PASS: package-local category=complete/g)?.length, 1)
})

test('verify CLI rejects each stale package-local artifact before accepting exact-second identities', async () => {
  const notBeforeEpochSeconds = Math.floor(new Date('2020-01-01T00:00:00Z').getTime() / 1000)
  const stale = new Date('2001-01-01T00:00:00Z')
  for (const [name, pathname] of [
    ['package', 'packagePath'],
    ['manifest', 'manifestPath'],
    ['receipt', 'receiptPath'],
  ]) {
    const built = await create(`verify-cli-stale-${name}`)
    await utimes(built[pathname], stale, stale)
    await assert.rejects(
      execFileAsync(
        process.execPath,
        verifyCLIArguments(built, built.receiptSHA256, notBeforeEpochSeconds),
        { cwd: repoRoot },
      ),
      (error) => {
        assert.equal(error.stdout, '')
        assert.equal(error.stderr, 'ERROR: release-attestation category=stale-artifact\n')
        return true
      },
    )
  }

  const built = await create('verify-cli-equal-second')
  const boundary = new Date(notBeforeEpochSeconds * 1000)
  await Promise.all([
    utimes(built.packagePath, boundary, boundary),
    utimes(built.manifestPath, boundary, boundary),
    utimes(built.receiptPath, boundary, boundary),
  ])
  const result = await execFileAsync(
    process.execPath,
    verifyCLIArguments(built, built.receiptSHA256, notBeforeEpochSeconds),
    { cwd: repoRoot },
  )
  const verified = JSON.parse(result.stdout)
  assert.equal(verified.receiptSHA256, built.receiptSHA256)
  assert.equal(verified.packageSHA256.length, 64)
})
