import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const repoFile = (path) => new URL(`../../${path}`, import.meta.url)

async function loadGate() {
  return import(`${repoFile('scripts/ci/k12-c09-content-oracle.mjs').href}?t=${Date.now()}`)
}

async function readJSON(path) {
  return JSON.parse(await readFile(repoFile(path), 'utf8'))
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function validRetrieval(query = 'fixture query', overrides = {}) {
  return {
    expectedDocumentGeneration: 3,
    expectedRevisionId: 'revision-a',
    expectedProfileId: 'profile-a',
    expectedProfileConfigHash: 'c'.repeat(64),
    expectedQueryModel: 'qwen3-embedding:8b',
    expectedQueryDimension: 4096,
    queryReceipts: [
      {
        operation: 'query_embedding',
        status: 'succeeded',
        provider_id: 'ollama-local',
        model: 'qwen3-embedding:8b',
        profile_id: 'profile-a',
        profile_config_hash: 'c'.repeat(64),
        dimension: 4096,
        revision_id: 'revision-a',
        query_digest: `sha256:${sha256(query)}`,
      },
    ],
    ...overrides,
  }
}

function validHit(overrides = {}) {
  const content = overrides.content ?? 'fixture content'
  return {
    doc_id: 'doc-1',
    document_generation: 3,
    revision_id: 'revision-a',
    page_start: 10,
    page_end: 10,
    source_digest: 'a'.repeat(64),
    chunk_id: 'chunk-1',
    citation_digest: sha256(content),
    source_offset_start: 0,
    source_offset_end: Buffer.byteLength(content),
    content,
    ...overrides,
  }
}

test('K12-TEST-INFRA-C09-CONTENT-ORACLE-001 / K12-REAL-10X-C09-ORACLE-20260801-001 mutation rejects a same-page hit with nonempty digests but wrong raw content', async () => {
  const oracle = await readJSON('tests/fixtures/local/k12-textbook-rag-oracle.v1.json')
  const wrongContent = '页码正确、摘要非空，但这不是冻结教材原文。'
  const sourcePrefix = '文档前文'
  const sourceContent = `${sourcePrefix}${wrongContent}文档后文`
  const wrongHit = {
    doc_id: 'doc-1',
    document_generation: 3,
    revision_id: 'revision-a',
    page_start: oracle.citation.physicalPage,
    page_end: oracle.citation.physicalPage,
    source_digest: oracle.pdfSha256,
    chunk_id: 'chunk-wrong-content',
    citation_digest: sha256(wrongContent),
    source_offset_start: Buffer.byteLength(sourcePrefix),
    source_offset_end: Buffer.byteLength(sourcePrefix) + Buffer.byteLength(wrongContent),
    content: wrongContent,
  }

  const oldPageAndDigestGate =
    wrongHit.page_start <= oracle.citation.physicalPage &&
    wrongHit.page_end >= oracle.citation.physicalPage &&
    wrongHit.source_digest === oracle.pdfSha256 &&
    wrongHit.chunk_id !== '' &&
    wrongHit.citation_digest !== ''
  assert.equal(oldPageAndDigestGate, true, 'the mutation must prove the legacy gate false-positive')

  const { auditC09ContentOracleHit } = await loadGate()
  assert.throws(
    () =>
      auditC09ContentOracleHit([wrongHit], {
        oracle,
        expectedDocumentId: 'doc-1',
        expectedSourceDigest: oracle.pdfSha256,
        sourceContent,
        ...validRetrieval(oracle.query),
      }),
    /actual raw source span.*frozen oracle/i,
  )
})

test('C09 content oracle uses NFKC plus whitespace removal on the actual source span', async () => {
  const { auditC09ContentOracleHit, normalizeC09SourceSpan } = await loadGate()
  const normalizedOracleSpan = 'ABC因数倍数'
  const rawSourceSpan = '无关前缀\nＡ \tＢ\r\nＣ 因 数 倍 数\n无关后缀'
  const sourcePrefix = '文档前文'
  const sourceContent = `${sourcePrefix}${rawSourceSpan}文档后文`
  const hit = {
    doc_id: 'doc-1',
    document_generation: 3,
    revision_id: 'revision-a',
    page_start: 10,
    page_end: 10,
    source_digest: 'a'.repeat(64),
    chunk_id: 'chunk-1',
    source_offset_start: Buffer.byteLength(sourcePrefix),
    source_offset_end: Buffer.byteLength(sourcePrefix) + Buffer.byteLength(rawSourceSpan),
    content: `【定位】教材\n\n${rawSourceSpan}`,
  }
  hit.citation_digest = sha256(hit.content)
  const oracle = {
    query: 'fixture query',
    pdfSha256: hit.source_digest,
    citation: {
      physicalPage: 10,
      normalizedLength: normalizedOracleSpan.length,
      normalizedTextSha256: sha256(normalizedOracleSpan),
      wholePdfExactOccurrences: 1,
    },
    extraction: { normalization: 'NFKC then remove all whitespace' },
  }

  assert.equal(normalizeC09SourceSpan(' Ａ\tＢ\nＣ '), 'ABC')
  const result = auditC09ContentOracleHit([hit], {
    oracle,
    expectedDocumentId: hit.doc_id,
    expectedSourceDigest: hit.source_digest,
    sourceContent,
    ...validRetrieval(),
  })
  assert.equal(result.hit, hit)
  assert.equal(result.normalizedLength, normalizedOracleSpan.length)
  assert.equal(result.normalizedTextSha256, sha256(normalizedOracleSpan))
})

test('C09 content oracle rejects a hit body disconnected from its actual source-offset span', async () => {
  const { auditC09ContentOracleHit } = await loadGate()
  const rawSourceSpan = '冻结 原 文'
  const sourcePrefix = '前文'
  const sourceContent = `${sourcePrefix}${rawSourceSpan}后文`
  const hit = {
    doc_id: 'doc-1',
    document_generation: 3,
    revision_id: 'revision-a',
    page_start: 10,
    page_end: 10,
    source_digest: 'a'.repeat(64),
    chunk_id: 'chunk-1',
    source_offset_start: Buffer.byteLength(sourcePrefix),
    source_offset_end: Buffer.byteLength(sourcePrefix) + Buffer.byteLength(rawSourceSpan),
    content: '返回了与来源跨度无关的正文',
  }
  hit.citation_digest = sha256(hit.content)
  const normalized = '冻结原文'
  const oracle = {
    query: 'fixture query',
    pdfSha256: hit.source_digest,
    citation: {
      physicalPage: 10,
      normalizedLength: normalized.length,
      normalizedTextSha256: sha256(normalized),
      wholePdfExactOccurrences: 1,
    },
    extraction: { normalization: 'NFKC then remove all whitespace' },
  }

  assert.throws(
    () =>
      auditC09ContentOracleHit([hit], {
        oracle,
        expectedDocumentId: hit.doc_id,
        expectedSourceDigest: hit.source_digest,
        sourceContent,
        ...validRetrieval(),
      }),
    /search hit content.*actual source-offset span/i,
  )
})

test('C09 content oracle accepts overlapping hits for the one frozen source occurrence', async () => {
  const { auditC09ContentOracleHit } = await loadGate()
  const rawOracleSpan = '冻结 原 文'
  const sourcePrefix = '前文'
  const sourceContent = `${sourcePrefix}${rawOracleSpan}后文`
  const baseHit = {
    doc_id: 'doc-1',
    document_generation: 3,
    revision_id: 'revision-a',
    page_start: 10,
    page_end: 10,
    source_digest: 'a'.repeat(64),
  }
  const hits = [
    {
      ...baseHit,
      chunk_id: 'chunk-wide',
      source_offset_start: 0,
      source_offset_end: Buffer.byteLength(sourceContent),
      content: sourceContent,
    },
    {
      ...baseHit,
      chunk_id: 'chunk-overlap',
      source_offset_start: Buffer.byteLength(sourcePrefix),
      source_offset_end: Buffer.byteLength(sourcePrefix) + Buffer.byteLength(rawOracleSpan),
      content: rawOracleSpan,
    },
  ]
  for (const hit of hits) hit.citation_digest = sha256(hit.content)
  const normalized = '冻结原文'
  const oracle = {
    query: 'fixture query',
    pdfSha256: baseHit.source_digest,
    citation: {
      physicalPage: 10,
      normalizedLength: normalized.length,
      normalizedTextSha256: sha256(normalized),
      wholePdfExactOccurrences: 1,
    },
    extraction: { normalization: 'NFKC then remove all whitespace' },
  }

  const result = auditC09ContentOracleHit(hits, {
    oracle,
    expectedDocumentId: baseHit.doc_id,
    expectedSourceDigest: baseHit.source_digest,
    sourceContent,
    ...validRetrieval(),
  })
  assert.equal(result.hit, hits[0])
  assert.equal(result.matchingHitCount, 2)
})

test('C09 content oracle rejects wrong generation, BM25-only evidence, and detached receipts', async () => {
  const { auditC09ContentOracleHit } = await loadGate()
  const rawSourceSpan = '冻结 原 文'
  const normalized = '冻结原文'
  const sourceContent = rawSourceSpan
  const oracle = {
    query: 'fixture query',
    pdfSha256: 'a'.repeat(64),
    citation: {
      physicalPage: 10,
      normalizedLength: normalized.length,
      normalizedTextSha256: sha256(normalized),
      wholePdfExactOccurrences: 1,
    },
    extraction: { normalization: 'NFKC then remove all whitespace' },
  }
  const hit = validHit({
    content: rawSourceSpan,
    source_offset_end: Buffer.byteLength(rawSourceSpan),
  })
  const base = {
    oracle,
    expectedDocumentId: 'doc-1',
    expectedSourceDigest: oracle.pdfSha256,
    sourceContent,
    ...validRetrieval(),
  }

  assert.throws(
    () => auditC09ContentOracleHit([{ ...hit, document_generation: 2 }], base),
    /document generation/i,
  )
  assert.throws(
    () => auditC09ContentOracleHit([{ ...hit, revision_id: '' }], base),
    /revision|vector/i,
  )
  assert.throws(
    () => auditC09ContentOracleHit([hit], { ...base, queryReceipts: [] }),
    /query_embedding receipt/i,
  )
  assert.throws(
    () =>
      auditC09ContentOracleHit([hit], {
        ...base,
        queryReceipts: validRetrieval().queryReceipts.map((receipt) => ({
          ...receipt,
          revision_id: 'revision-b',
        })),
      }),
    /revision/i,
  )
  assert.throws(
    () =>
      auditC09ContentOracleHit([hit], {
        ...base,
        queryReceipts: validRetrieval().queryReceipts.map((receipt) => ({
          ...receipt,
          dimension: 2048,
        })),
      }),
    /dimension/i,
  )
  assert.throws(
    () => auditC09ContentOracleHit([{ ...hit, citation_digest: 'b'.repeat(64) }], base),
    /citation/i,
  )
})

test('C09 content oracle accepts same-plan expansion receipts but requires the frozen original query receipt', async () => {
  const { auditC09ContentOracleHit } = await loadGate()
  const rawSourceSpan = '冻结 原 文'
  const normalized = '冻结原文'
  const query = 'fixture query'
  const oracle = {
    query,
    pdfSha256: 'a'.repeat(64),
    citation: {
      physicalPage: 10,
      normalizedLength: normalized.length,
      normalizedTextSha256: sha256(normalized),
      wholePdfExactOccurrences: 1,
    },
    extraction: { normalization: 'NFKC then remove all whitespace' },
  }
  const hit = validHit({
    content: rawSourceSpan,
    source_offset_end: Buffer.byteLength(rawSourceSpan),
  })
  const originalReceipt = validRetrieval(query).queryReceipts[0]
  const expandedReceipt = {
    ...originalReceipt,
    query_digest: `sha256:${sha256('fixture query expansion')}`,
  }
  const base = {
    oracle,
    expectedDocumentId: hit.doc_id,
    expectedSourceDigest: oracle.pdfSha256,
    sourceContent: rawSourceSpan,
    ...validRetrieval(query, { queryReceipts: [originalReceipt, expandedReceipt] }),
  }

  assert.equal(auditC09ContentOracleHit([hit], base).hit, hit)
  assert.throws(
    () =>
      auditC09ContentOracleHit([hit], {
        ...base,
        queryReceipts: [expandedReceipt],
      }),
    /frozen original query/i,
  )
})

test('C09 release proof and Playwright hook require the actual normalized source-span oracle', async () => {
  const contract = await readJSON('tests/live/k12-real-10x-release.contract.json')
  const cycle = contract.cycles.find(({ id }) => id === 'C09')
  assert.deepEqual(cycle.supportingEvidence, [
    {
      lane: 'fixtures-strict',
      spec: 'grounding-pdf.spec.ts',
      cases: ['C09 retrieves the C08 textbook lineage through the frozen oracle'],
    },
  ])
  assert.deepEqual(cycle.requiredProof, [
    'document_id',
    'physical_page',
    'source_offset_range',
    'raw_source_span_normalized_sha256',
    'chunk_id',
    'citation_digest',
    'qwen3_embedding_query_receipt',
  ])

  const source = await readFile(repoFile('tests/e2e/grounding-pdf.spec.ts'), 'utf8')
  assert.match(source, /k12-c09-content-oracle\.mjs/)
  assert.match(source, /auditC09ContentOracleHit\(/)
  assert.match(source, /sourceContent: sourceDocument\.content/)
  assert.match(source, /expectedDocumentGeneration: c08\.document_generation/)
  assert.match(source, /expectedRevisionId: c08\.active_revision_id/)
  assert.match(source, /queryReceipts: results\.query_receipts \|\| \[\]/)
  assert.match(source, /hit_revision_id: String\(oracleHit\.revision_id\)/)
  assert.match(source, /source_offset_start: oracleEvidence\.sourceOffsetStart/)
  assert.match(source, /normalizedTextSha256/)
  assert.match(source, /normalizedLength/)
})
