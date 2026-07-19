import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const localDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(localDir, '../../..')
const verifierPath = join(localDir, 'verify-fixture.mjs')
const exampleManifestPath = join(localDir, 'manifest.example.json')

const canonicalTextbook = {
  sha256: '657e1547074668dbb50f2bf37f13c20f292127be64c26c5334190aa34d06de83',
  bytes: 14621452,
  pages: 131,
}

const canonicalScannedTextbook = {
  sha256: '65bd80bd35be524bf68f66f9b67820a97176e1487db81810cb268e04e44dd8b2',
  bytes: 57313616,
  pages: 122,
}

async function makeFixtureSandbox(t, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'hexclaw-local-fixture-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const pdf = join(dir, 'textbook.pdf')
  const pdfBody = overrides.pdfBody ?? '%PDF-1.7\nsynthetic contract fixture\n%%EOF\n'
  await writeFile(pdf, pdfBody)
  const pdfBytes = Buffer.byteLength(pdfBody)
  const pdfSHA = createHash('sha256').update(pdfBody).digest('hex')

  const binDir = join(dir, 'bin')
  await mkdir(binDir)
  const pdfinfo = join(binDir, 'pdfinfo')
  await writeFile(pdfinfo, '#!/bin/sh\nprintf "Pages: %s\\n" "${HEX_TEST_PDF_PAGES:-2}"\n')
  await chmod(pdfinfo, 0o755)

  const manifest = join(dir, 'manifest.json')
  const entry = {
    id: 'textbook_pdf',
    path: overrides.path ?? 'textbook.pdf',
    sha256: overrides.sha256 ?? pdfSHA,
    bytes: overrides.bytes ?? pdfBytes,
    pages: overrides.pages ?? 2,
    source: 'private-local',
    redistributable: false,
  }
  const fixtures = [entry]
  let scannedPdf
  let scannedPDFSHA
  let scannedPDFBytes
  if (overrides.includeScanned) {
    scannedPdf = join(dir, 'scanned-textbook.pdf')
    const scannedBody = overrides.scannedPdfBody ?? '%PDF-1.6\nsynthetic scanned contract fixture\n%%EOF\n'
    await writeFile(scannedPdf, scannedBody)
    scannedPDFBytes = Buffer.byteLength(scannedBody)
    scannedPDFSHA = createHash('sha256').update(scannedBody).digest('hex')
    fixtures.push({
      id: 'scanned_textbook_pdf',
      path: 'scanned-textbook.pdf',
      sha256: overrides.scannedSha256 ?? scannedPDFSHA,
      bytes: overrides.scannedBytes ?? scannedPDFBytes,
      pages: overrides.scannedPages ?? 2,
      source: 'private-local',
      redistributable: false,
    })
  }
  await writeFile(manifest, `${JSON.stringify({ schema_version: 1, fixtures }, null, 2)}\n`)

  return { dir, pdf, manifest, pdfBytes, pdfSHA, binDir, scannedPdf, scannedPDFBytes, scannedPDFSHA }
}

function runVerifier({ manifest, pdf, scannedPdf, binDir, pages = 2 }) {
  const env = { ...process.env }
  delete env.HEX_FIXTURE_TEXTBOOK_PDF
  delete env.HEX_FIXTURE_SCANNED_TEXTBOOK_PDF
  if (pdf !== undefined) env.HEX_FIXTURE_TEXTBOOK_PDF = pdf
  if (scannedPdf !== undefined) env.HEX_FIXTURE_SCANNED_TEXTBOOK_PDF = scannedPdf
  env.HEX_TEST_PDF_PAGES = String(pages)
  if (binDir) env.PATH = `${binDir}:${env.PATH ?? ''}`
  const args = [verifierPath]
  if (manifest) args.push('--manifest', manifest)
  return spawnSync(process.execPath, args, {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  })
}

test('local fixture governance files exist', async () => {
  for (const path of [
    verifierPath,
    exampleManifestPath,
    join(localDir, '.gitignore'),
    join(localDir, 'README.md'),
  ]) {
    assert.equal(existsSync(path), true, `missing local fixture governance file: ${path}`)
    assert.equal((await stat(path)).isFile(), true)
  }
})

test('example manifest is portable and pins the canonical textbook contract', async () => {
  assert.equal(existsSync(exampleManifestPath), true, 'manifest.example.json must exist')
  const raw = await readFile(exampleManifestPath, 'utf8')
  const manifest = JSON.parse(raw)
  const fixture = manifest.fixtures?.find((item) => item.id === 'textbook_pdf')
  const scannedFixture = manifest.fixtures?.find((item) => item.id === 'scanned_textbook_pdf')

  assert.equal(manifest.schema_version, 1)
  assert.deepEqual(
    manifest.fixtures.map((item) => item.id),
    ['textbook_pdf', 'scanned_textbook_pdf'],
    'the two release textbook fixtures form a closed ordered set',
  )
  assert.ok(fixture, 'textbook_pdf fixture is required')
  assert.equal(fixture.sha256, canonicalTextbook.sha256)
  assert.equal(fixture.bytes, canonicalTextbook.bytes)
  assert.equal(fixture.pages, canonicalTextbook.pages)
  assert.equal(fixture.source, 'private-local')
  assert.equal(fixture.redistributable, false)
  assert.doesNotMatch(raw, /(?:\/Users\/|\/home\/|[A-Za-z]:[\\/])/)
  assert.equal(fixture.path, 'files/textbook.pdf')
  assert.ok(scannedFixture, 'scanned_textbook_pdf fixture is required')
  assert.equal(scannedFixture.sha256, canonicalScannedTextbook.sha256)
  assert.equal(scannedFixture.bytes, canonicalScannedTextbook.bytes)
  assert.equal(scannedFixture.pages, canonicalScannedTextbook.pages)
  assert.equal(scannedFixture.source, 'private-local')
  assert.equal(scannedFixture.redistributable, false)
  assert.equal(scannedFixture.path, 'files/scanned-textbook.pdf')
})

test('gitignore keeps actual manifests and payloads local while governance files stay visible', async () => {
  const ignored = [
    'tests/fixtures/local/manifest.json',
    'tests/fixtures/local/files/textbook.pdf',
    'tests/fixtures/local/private.pdf',
  ]
  for (const path of ignored) {
    const result = spawnSync('git', ['check-ignore', '--no-index', '--quiet', path], { cwd: repoRoot })
    assert.equal(result.status, 0, `${path} must be ignored by default`)
  }
  for (const path of [
    'tests/fixtures/local/contract.test.mjs',
    'tests/fixtures/local/verify-fixture.mjs',
    'tests/fixtures/local/manifest.example.json',
  ]) {
    const result = spawnSync('git', ['check-ignore', '--no-index', '--quiet', path], { cwd: repoRoot })
    assert.equal(result.status, 1, `${path} must remain trackable`)
  }
})

test('verifier accepts a controlled manifest with a relative PDF path', async (t) => {
  const fixture = await makeFixtureSandbox(t)
  const result = runVerifier({ manifest: fixture.manifest, binDir: fixture.binDir })

  assert.equal(result.status, 0, result.stderr)
  const output = JSON.parse(result.stdout)
  assert.equal(output.fixture, 'textbook_pdf')
  assert.equal(output.sha256, fixture.pdfSHA)
  assert.equal(output.bytes, fixture.pdfBytes)
  assert.equal(output.pages, 2)
})

test('verifier checks every fixture in the two-textbook exact set', async (t) => {
  const fixture = await makeFixtureSandbox(t, { includeScanned: true })
  const result = runVerifier({ manifest: fixture.manifest, binDir: fixture.binDir })

  assert.equal(result.status, 0, result.stderr)
  const output = JSON.parse(result.stdout)
  assert.deepEqual(output.fixtures.map((item) => item.fixture), [
    'textbook_pdf',
    'scanned_textbook_pdf',
  ])
  assert.equal(output.fixtures[0].sha256, fixture.pdfSHA)
  assert.equal(output.fixtures[1].sha256, fixture.scannedPDFSHA)
})

test('verifier fails closed when only the second textbook is corrupted', async (t) => {
  const fixture = await makeFixtureSandbox(t, {
    includeScanned: true,
    scannedSha256: '0'.repeat(64),
  })
  const result = runVerifier({ manifest: fixture.manifest, binDir: fixture.binDir })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /scanned_textbook_pdf.*sha256 mismatch/i)
  assert.equal(result.stdout, '')
})

test('HEX_FIXTURE_TEXTBOOK_PDF explicitly overrides only the manifest path', async (t) => {
  const fixture = await makeFixtureSandbox(t, { path: 'does-not-exist.pdf' })
  const result = runVerifier({
    manifest: fixture.manifest,
    pdf: fixture.pdf,
    binDir: fixture.binDir,
  })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).sha256, fixture.pdfSHA)
})

test('verifier fails closed on missing, malformed, or mismatched fixture evidence', async (t) => {
  const cases = [
    {
      name: 'missing file',
      overrides: { path: 'missing.pdf' },
      want: /fixture file.*not found/i,
    },
    {
      name: 'malformed SHA256',
      overrides: { sha256: '657e' },
      want: /sha256.*64/i,
    },
    {
      name: 'SHA256 mismatch',
      overrides: { sha256: '0'.repeat(64) },
      want: /sha256 mismatch/i,
    },
    {
      name: 'byte mismatch',
      overrides: { bytes: 1 },
      want: /byte.*mismatch/i,
    },
    {
      name: 'page mismatch',
      overrides: { pages: 3 },
      want: /page.*mismatch/i,
    },
    {
      name: 'not a PDF',
      overrides: { pdfBody: 'plain text\n' },
      want: /pdf signature/i,
    },
  ]

  for (const tc of cases) {
    await t.test(tc.name, async (t) => {
      const fixture = await makeFixtureSandbox(t, tc.overrides)
      const result = runVerifier({ manifest: fixture.manifest, binDir: fixture.binDir })
      assert.notEqual(result.status, 0, `verifier unexpectedly accepted ${tc.name}`)
      assert.match(result.stderr, tc.want)
      assert.equal(result.stdout, '')
    })
  }
})
