import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const moduleURL = new URL('../../scripts/ci/k12-release-ui-attestation.mjs', import.meta.url)
const execFileAsync = promisify(execFile)
const generationId = 'generation-20260809-a1b2c3d4'
const targetTriple = 'x86_64-apple-darwin'

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function fixture(name) {
  const root = await mkdtemp(join(tmpdir(), `hexclaw-attestation-security-${name}-`))
  const distRoot = join(root, 'dist')
  await mkdir(distRoot, { recursive: true, mode: 0o700 })
  await writeFile(join(distRoot, 'index.html'), '<main>release</main>\n')
  const paths = {
    root,
    distRoot,
    installedAppBinary: join(root, 'hexclaw-desktop'),
    sidecarBinary: join(root, 'hexclaw'),
    packagePath: join(root, 'HexClaw.dmg'),
    manifestPath: join(root, 'release-ui-dist-manifest.json'),
    receiptPath: join(root, 'release-ui-attestation.json'),
  }
  await writeFile(paths.installedAppBinary, 'desktop-bytes\n')
  await writeFile(paths.sidecarBinary, 'sidecar-bytes\n')
  await writeFile(paths.packagePath, 'package-bytes\n')
  const sourceManifestBytes = Buffer.from('{"schema":"hexclaw.package-source-identity.v1"}\n')
  paths.sourceManifestPath = join(root, 'package-source-manifest.json')
  paths.sourceManifestSHA256 = sha256(sourceManifestBytes)
  paths.generationId = generationId
  paths.targetTriple = targetTriple
  await writeFile(paths.sourceManifestPath, sourceManifestBytes)
  await chmod(paths.installedAppBinary, 0o700)
  await chmod(paths.sidecarBinary, 0o700)
  await chmod(paths.sourceManifestPath, 0o600)
  return paths
}

function createOptions(paths) {
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
  }
}

function verifyOptions(paths, attestation) {
  return {
    distRoot: paths.distRoot,
    expectedGenerationId: paths.generationId,
    expectedReceiptSHA256: attestation.receiptSHA256,
    expectedSourceManifestSHA256: paths.sourceManifestSHA256,
    expectedTargetTriple: paths.targetTriple,
    installedAppBinary: paths.installedAppBinary,
    manifestPath: paths.manifestPath,
    packagePath: paths.packagePath,
    receiptPath: paths.receiptPath,
    releaseVersion: '0.5.0-beta',
    sidecarBinary: paths.sidecarBinary,
    sourceManifestPath: paths.sourceManifestPath,
  }
}

async function expectHardLinkFailure(operation, forbiddenValues) {
  await assert.rejects(operation, (error) => {
    assert.equal(error.category, 'file-hard-link')
    for (const value of forbiddenValues) {
      assert.equal(error.message.includes(value), false)
    }
    return true
  })
}

test('attestation creation rejects hard-linked source dist package app and sidecar inputs', async (t) => {
  const { createReleaseAttestation } = await import(moduleURL)
  const cases = [
    ['source', (paths) => paths.sourceManifestPath],
    ['dist', (paths) => join(paths.distRoot, 'index.html')],
    ['package', (paths) => paths.packagePath],
    ['app', (paths) => paths.installedAppBinary],
    ['sidecar', (paths) => paths.sidecarBinary],
  ]

  for (const [name, target] of cases) {
    const paths = await fixture(`create-${name}`)
    t.after(() => rm(paths.root, { recursive: true, force: true }))
    const marker = `synthetic-${name}-hardlink-marker`
    await link(target(paths), join(paths.root, marker))
    await expectHardLinkFailure(createReleaseAttestation(createOptions(paths)), [
      paths.root,
      marker,
    ])
  }
})

test('attestation verification rejects every hard-linked regular input', async (t) => {
  const { createReleaseAttestation, verifyReleaseAttestation } = await import(moduleURL)
  const cases = [
    ['source', (paths) => paths.sourceManifestPath],
    ['dist', (paths) => join(paths.distRoot, 'index.html')],
    ['package', (paths) => paths.packagePath],
    ['manifest', (paths) => paths.manifestPath],
    ['receipt', (paths) => paths.receiptPath],
    ['app', (paths) => paths.installedAppBinary],
    ['sidecar', (paths) => paths.sidecarBinary],
  ]

  for (const [name, target] of cases) {
    const paths = await fixture(`verify-${name}`)
    t.after(() => rm(paths.root, { recursive: true, force: true }))
    const attestation = await createReleaseAttestation(createOptions(paths))
    const marker = `synthetic-${name}-verify-hardlink-marker`
    await link(target(paths), join(paths.root, marker))
    await expectHardLinkFailure(verifyReleaseAttestation(verifyOptions(paths, attestation)), [
      paths.root,
      marker,
    ])
  }
})

test('file identity binds link count before and after bounded reads', async () => {
  const source = await readFile(moduleURL, 'utf8')
  assert.match(source, /before\.nlink === after\.nlink/u)
  assert.match(source, /before\.nlink !== 1n/u)
})

test('receipt schema binds source manifest generation and canonical target', async (t) => {
  const paths = await fixture('receipt-source-identity')
  t.after(() => rm(paths.root, { recursive: true, force: true }))
  const { createReleaseAttestation } = await import(moduleURL)
  const created = await createReleaseAttestation(createOptions(paths))
  const receipt = JSON.parse(await readFile(paths.receiptPath, 'utf8'))

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
  assert.equal(receipt.schema_version, 2)
  assert.equal(receipt.source_manifest_file, 'package-source-manifest.json')
  assert.equal(receipt.source_manifest_sha256, paths.sourceManifestSHA256)
  assert.equal(receipt.generation_id, paths.generationId)
  assert.equal(receipt.target_triple, paths.targetTriple)
  assert.equal(created.sourceManifestSHA256, paths.sourceManifestSHA256)
  assert.equal(created.generationId, paths.generationId)
  assert.equal(created.targetTriple, paths.targetTriple)
})

test('source manifest is a private bounded no-follow regular input', async (t) => {
  const { createReleaseAttestation, ATTESTATION_LIMITS } = await import(moduleURL)

  const nonPrivate = await fixture('source-non-private')
  t.after(() => rm(nonPrivate.root, { recursive: true, force: true }))
  await chmod(nonPrivate.sourceManifestPath, 0o644)
  await assert.rejects(
    createReleaseAttestation(createOptions(nonPrivate)),
    (error) => error?.category === 'file-permissions',
  )

  const oversized = await fixture('source-oversized')
  t.after(() => rm(oversized.root, { recursive: true, force: true }))
  assert.equal(Number.isSafeInteger(ATTESTATION_LIMITS.maxSourceManifestBytes), true)
  await truncate(oversized.sourceManifestPath, ATTESTATION_LIMITS.maxSourceManifestBytes + 1)
  oversized.sourceManifestSHA256 = sha256(await readFile(oversized.sourceManifestPath))
  await assert.rejects(
    createReleaseAttestation(createOptions(oversized)),
    (error) => error?.category === 'file-size-limit',
  )

  const linked = await fixture('source-symlink')
  t.after(() => rm(linked.root, { recursive: true, force: true }))
  const target = join(linked.root, 'source-target.json')
  await writeFile(target, await readFile(linked.sourceManifestPath))
  await chmod(target, 0o600)
  await rm(linked.sourceManifestPath)
  await symlink(target, linked.sourceManifestPath)
  await assert.rejects(
    createReleaseAttestation(createOptions(linked)),
    (error) => error?.category === 'file-type',
  )
})

test('verification rejects source mutation and caller identity drift', async (t) => {
  const { createReleaseAttestation, verifyReleaseAttestation } = await import(moduleURL)
  const cases = [
    [
      'source-content',
      async (paths) => writeFile(paths.sourceManifestPath, '{"tampered":true}\n', { mode: 0o600 }),
      () => ({}),
    ],
    ['source-sha', async () => undefined, () => ({ expectedSourceManifestSHA256: '1'.repeat(64) })],
    [
      'old-generation',
      async () => undefined,
      () => ({ expectedGenerationId: 'generation-20260808-deadbeef' }),
    ],
    [
      'target-drift',
      async () => undefined,
      () => ({ expectedTargetTriple: 'aarch64-apple-darwin' }),
    ],
  ]

  for (const [name, mutate, override] of cases) {
    const paths = await fixture(`verify-identity-${name}`)
    t.after(() => rm(paths.root, { recursive: true, force: true }))
    const created = await createReleaseAttestation(createOptions(paths))
    await mutate(paths)
    await assert.rejects(
      verifyReleaseAttestation({ ...verifyOptions(paths, created), ...override() }),
    )
  }
})

test('verification independently rechecks source manifest mode and no-follow identity', async (t) => {
  const { createReleaseAttestation, verifyReleaseAttestation } = await import(moduleURL)

  const nonPrivate = await fixture('verify-source-non-private')
  t.after(() => rm(nonPrivate.root, { recursive: true, force: true }))
  const nonPrivateAttestation = await createReleaseAttestation(createOptions(nonPrivate))
  await chmod(nonPrivate.sourceManifestPath, 0o644)
  await assert.rejects(
    verifyReleaseAttestation(verifyOptions(nonPrivate, nonPrivateAttestation)),
    (error) => error?.category === 'file-permissions',
  )

  const linked = await fixture('verify-source-symlink')
  t.after(() => rm(linked.root, { recursive: true, force: true }))
  const linkedAttestation = await createReleaseAttestation(createOptions(linked))
  const sourceBytes = await readFile(linked.sourceManifestPath)
  const target = join(linked.root, 'verified-source-target.json')
  await writeFile(target, sourceBytes, { mode: 0o600 })
  await rm(linked.sourceManifestPath)
  await symlink(target, linked.sourceManifestPath)
  await assert.rejects(
    verifyReleaseAttestation(verifyOptions(linked, linkedAttestation)),
    (error) => error?.category === 'file-type',
  )
})

test('a recomputed receipt hash cannot authorize source generation or target tampering', async (t) => {
  const { createReleaseAttestation, verifyReleaseAttestation } = await import(moduleURL)
  for (const [name, field, value] of [
    ['source', 'source_manifest_sha256', '2'.repeat(64)],
    ['generation', 'generation_id', 'generation-20260808-deadbeef'],
    ['target', 'target_triple', 'aarch64-apple-darwin'],
  ]) {
    const paths = await fixture(`receipt-tamper-${name}`)
    t.after(() => rm(paths.root, { recursive: true, force: true }))
    const created = await createReleaseAttestation(createOptions(paths))
    const receipt = JSON.parse(await readFile(paths.receiptPath, 'utf8'))
    receipt[field] = value
    const bytes = `${JSON.stringify(receipt, null, 2)}\n`
    await writeFile(paths.receiptPath, bytes, { mode: 0o600 })

    await assert.rejects(
      verifyReleaseAttestation({
        ...verifyOptions(paths, created),
        expectedReceiptSHA256: sha256(bytes),
      }),
    )
  }
})

test('unsafe generation IDs and non-canonical targets are rejected', async (t) => {
  const { createReleaseAttestation } = await import(moduleURL)
  for (const [name, override] of [
    ['generation-parent', { generationId: '../old-generation' }],
    ['generation-slash', { generationId: 'generation/child' }],
    ['generation-backslash', { generationId: String.raw`generation\child` }],
    ['generation-control', { generationId: 'generation\nchild' }],
    ['generation-length', { generationId: 'a'.repeat(129) }],
    ['target', { targetTriple: 'X86_64-APPLE-DARWIN' }],
  ]) {
    const paths = await fixture(`unsafe-${name}`)
    t.after(() => rm(paths.root, { recursive: true, force: true }))
    await assert.rejects(createReleaseAttestation({ ...createOptions(paths), ...override }))
  }
})

test('attestation CLI hard-link failures never expose paths or markers', async (t) => {
  const paths = await fixture('cli-hardlink-marker')
  t.after(() => rm(paths.root, { recursive: true, force: true }))
  const marker = 'synthetic-attestation-cli-marker'
  await link(paths.packagePath, join(paths.root, marker))

  let result
  try {
    const completed = await execFileAsync(process.execPath, [
      fileURLToPath(moduleURL),
      'create',
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
      '--source-manifest-sha256',
      paths.sourceManifestSHA256,
      '--generation-id',
      paths.generationId,
      '--target-triple',
      paths.targetTriple,
    ])
    result = { code: 0, stdout: completed.stdout, stderr: completed.stderr }
  } catch (error) {
    result = {
      code: typeof error?.code === 'number' ? error.code : 1,
      stdout: error?.stdout ?? '',
      stderr: error?.stderr ?? '',
    }
  }

  assert.notEqual(result.code, 0)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, 'ERROR: release-attestation category=file-hard-link\n')
  assert.equal(`${result.stdout}${result.stderr}`.includes(paths.root), false)
  assert.equal(`${result.stdout}${result.stderr}`.includes(marker), false)
})
