import assert from 'node:assert/strict'
import { chmod, mkdir, readFile, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { tmpdir } from 'node:os'
import { mkdtemp } from 'node:fs/promises'

const moduleURL = new URL('../../scripts/ci/k12-release-ui-attestation.mjs', import.meta.url)

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
  }
}

async function create(name) {
  const paths = await fixture(name)
  const { createReleaseAttestation } = await loadAttestation()
  const result = await createReleaseAttestation({
    ...paths,
    releaseVersion: '0.5.0-beta',
  })
  return { ...paths, ...result }
}

test('build receipt is deterministic, private and links exact dist/app/sidecar/package bytes', async () => {
  const first = await fixture('deterministic-a')
  const second = await fixture('deterministic-b')
  const old = new Date('2001-01-01T00:00:00Z')
  const future = new Date('2031-01-01T00:00:00Z')
  await utimes(join(first.distRoot, 'index.html'), old, old)
  await utimes(join(second.distRoot, 'index.html'), future, future)

  const { createReleaseAttestation } = await loadAttestation()
  const a = await createReleaseAttestation({ ...first, releaseVersion: '0.5.0-beta' })
  const b = await createReleaseAttestation({ ...second, releaseVersion: '0.5.0-beta' })
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
    'installed_app_file',
    'installed_app_sha256',
    'package_file',
    'package_sha256',
    'release_version',
    'schema_version',
    'sidecar_file',
    'sidecar_sha256',
  ])
  assert.equal(receipt.dist_manifest_file, 'release-ui-dist-manifest.json')
  assert.equal(receipt.installed_app_file, 'hexclaw-desktop')
  assert.equal(receipt.sidecar_file, 'hexclaw')
  assert.equal(receipt.package_file, 'HexClaw.dmg')
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
  const verified = await verifyReleaseAttestation({
    ...built,
    releaseVersion: '0.5.0-beta',
    expectedReceiptSHA256: built.receiptSHA256,
  })
  assert.equal(verified.distFileCount, 2)
  assert.equal(verified.receiptSHA256, built.receiptSHA256)
  assert.equal(verified.manifestSHA256, built.manifestSHA256)
})

test('verification fails closed on every asset and identity drift without repairing inputs', async () => {
  const { verifyReleaseAttestation } = await loadAttestation()
  const cases = [
    ['receipt sha', async (value) => {
      value.expectedReceiptSHA256 = '0'.repeat(64)
    }],
    ['dist byte', async (value) => {
      await writeFile(join(value.distRoot, 'index.html'), 'drift\n')
    }],
    ['extra dist file', async (value) => {
      await writeFile(join(value.distRoot, 'extra.js'), 'extra\n')
    }],
    ['missing dist file', async (value) => {
      const { rm } = await import('node:fs/promises')
      await rm(join(value.distRoot, 'index.html'))
    }],
    ['dist symlink', async (value) => {
      await symlink(join(value.distRoot, 'index.html'), join(value.distRoot, 'linked.html'))
    }],
    ['installed app', async (value) => {
      await writeFile(value.installedAppBinary, 'app-drift\n')
    }],
    ['sidecar', async (value) => {
      await writeFile(value.sidecarBinary, 'sidecar-drift\n')
    }],
    ['package', async (value) => {
      await writeFile(value.packagePath, 'package-drift\n')
    }],
  ]

  for (const [name, mutate] of cases) {
    const built = await create(name.replaceAll(' ', '-'))
    await mutate(built)
    await assert.rejects(
      verifyReleaseAttestation({
        ...built,
        releaseVersion: '0.5.0-beta',
        expectedReceiptSHA256: built.expectedReceiptSHA256 ?? built.receiptSHA256,
      }),
      undefined,
      name,
    )
  }
})
