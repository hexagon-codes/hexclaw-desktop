import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const localDir = dirname(fileURLToPath(import.meta.url))
const oraclePath = join(localDir, 'k12-textbook-scan-ocr-oracle.v1.json')
const manifestPath = join(localDir, 'manifest.example.json')

const expectedQueryDigests = [
  '6d98bce4803d96192497ce7449914c83dea1301ca7f78fef66cd8d56118c5258',
  '182291d26ffacbec35c3d81abb4b3dbe50e382a7cb9d6b36be2795d206db5382',
  'ca18148a2ab80fbe12a2c0a15a2257ae9a1cd42c79367a17f3849b6806bdb719',
]

const expectedRenderedPageDigests = [
  'a5b479c202b01ba991d9df6bc90b6179282bffb45f33a5e67360966ed7983b44',
  '3f0cbe9277f96a67e3e6d793becd8ed7e7d9a3a456042e45a54775142ac6fbec',
  '945454b13ba73d5ae6cbee4590fba92dffa0585d4f9ec4b45b07228b8a17b111',
]

function normalizeQuery(value) {
  return value
    .normalize('NFKC')
    .replace(/\s+/gu, '')
    .replace(/[。！？；，、：,.!?;:]/gu, '')
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

async function loadJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

test('scanned textbook OCR oracle pins the private fixture identity and page count', async () => {
  const [oracle, manifest] = await Promise.all([loadJson(oraclePath), loadJson(manifestPath)])
  const fixture = manifest.fixtures.find((item) => item.id === 'scanned_textbook_pdf')

  assert.ok(fixture, 'scanned_textbook_pdf must remain in the portable manifest')
  assert.equal(oracle.schemaVersion, 1)
  assert.equal(oracle.fixtureId, 'scanned_textbook_pdf')
  assert.deepEqual(oracle.fixture, {
    sha256: fixture.sha256,
    bytes: fixture.bytes,
    physicalPages: fixture.pages,
    sourceKind: 'image-only-scanned-pdf',
    redistributable: false,
  })
  assert.match(oracle.fixture.sha256, /^[a-f0-9]{64}$/)
  assert.equal(oracle.fixture.physicalPages, 122)
})

test('front, middle, and tail OCR queries keep their audited page exact-set', async () => {
  const oracle = await loadJson(oraclePath)

  assert.deepEqual(
    oracle.oracles.map((item) => item.region),
    ['front', 'middle', 'tail'],
  )
  assert.deepEqual(
    oracle.oracles.map((item) => item.physicalPage),
    [5, 61, 120],
  )
  assert.deepEqual(
    oracle.oracles.map((item) => item.printedPage),
    [2, 58, 117],
  )
  assert.deepEqual(
    oracle.oracles.map((item) => item.retrievalOracle.expectedPhysicalPages),
    [[5], [61], [120]],
  )

  for (const item of oracle.oracles) {
    assert.ok(item.physicalPage >= 1 && item.physicalPage <= oracle.fixture.physicalPages)
    assert.equal(item.retrievalOracle.topK, 3)
    assert.equal(item.retrievalOracle.expectedPageMatch, 'exact-set')
    assert.deepEqual(item.retrievalOracle.expectedPhysicalPages, [item.physicalPage])
  }
})

test('normalized OCR query digests and rendered-page evidence are a closed ordered set', async () => {
  const oracle = await loadJson(oraclePath)

  for (const item of oracle.oracles) {
    const normalized = normalizeQuery(item.query)
    assert.equal(item.normalizedQuery, normalized)
    assert.equal(item.querySha256, sha256(normalized))
    assert.match(item.renderedPageSha256, /^[a-f0-9]{64}$/)
    assert.ok(
      Array.from(item.ocrEvidenceFragment).length <= 24,
      `${item.id} must retain only a necessary short OCR fragment`,
    )
  }

  assert.deepEqual(
    oracle.oracles.map((item) => item.querySha256),
    expectedQueryDigests,
  )
  assert.deepEqual(
    oracle.oracles.map((item) => item.renderedPageSha256),
    expectedRenderedPageDigests,
  )
})

test('oracle metadata documents real OCR settings without embedding a private path', async () => {
  const raw = await readFile(oraclePath, 'utf8')
  const oracle = JSON.parse(raw)

  assert.deepEqual(oracle.evidenceMethod.recognitionLanguages, ['zh-Hans', 'en-US'])
  assert.equal(oracle.evidenceMethod.rendererVersion, 'Poppler 26.08.0')
  assert.equal(oracle.evidenceMethod.ocrEngine, 'Apple Vision VNRecognizeTextRequest')
  assert.equal(oracle.evidenceMethod.ocrPlatform, 'macOS 26.6.2')
  assert.equal(oracle.evidenceMethod.recognitionLevel, 'accurate')
  assert.equal(oracle.evidenceMethod.visuallyVerifiedAgainstRenderedPage, true)
  assert.doesNotMatch(raw, /(?:\/Users\/|\/home\/|[A-Za-z]:[\\/])/)
})
