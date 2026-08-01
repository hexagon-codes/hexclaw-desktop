import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'

const SHA256_HEX = /^[a-f0-9]{64}$/
const NORMALIZATION = 'NFKC then remove all whitespace'

function fail(message) {
  throw new Error(`C09 content oracle: ${message}`)
}

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail(`${label} must be an object`)
  return value
}

function nonEmpty(value, label) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${label} must be nonempty`)
  return value
}

function sha256Hex(value, label) {
  const digest = nonEmpty(value, label)
  if (!SHA256_HEX.test(digest)) fail(`${label} must be a lowercase SHA-256 hex digest`)
  return digest
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(`${label} must be a positive integer`)
  return value
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

/** The frozen oracle was generated with this exact, locale-independent normalization. */
export function normalizeC09SourceSpan(value) {
  if (typeof value !== 'string') fail('actual raw source span must be a string')
  return value.normalize('NFKC').replace(/\s/gu, '')
}

function matchingNormalizedSpans(rawSourceSpan, normalizedLength, expectedDigest) {
  const normalized = Array.from(normalizeC09SourceSpan(rawSourceSpan))
  if (normalized.length < normalizedLength) return []
  const matches = []
  for (let start = 0; start + normalizedLength <= normalized.length; start += 1) {
    const span = normalized.slice(start, start + normalizedLength).join('')
    if (digest(span) === expectedDigest) matches.push(start)
  }
  return matches
}

function rawSourceSpanAtOffsets(sourceContent, start, end) {
  const sourceBytes = Buffer.from(sourceContent, 'utf8')
  if (end > sourceBytes.length) return undefined
  const spanBytes = sourceBytes.subarray(start, end)
  const span = spanBytes.toString('utf8')
  if (!Buffer.from(span, 'utf8').equals(spanBytes)) return undefined
  return span
}

/**
 * Reconstructs each candidate's byte-exact span from the persisted source,
 * proves the search-result content contains that span, then selects the one
 * span matching the frozen normalized oracle. Page and nonempty digests alone
 * are never sufficient.
 */
export function auditC09ContentOracleHit(
  hitsValue,
  {
    oracle: oracleValue,
    expectedDocumentId,
    expectedDocumentGeneration,
    expectedSourceDigest,
    expectedRevisionId,
    expectedProfileId,
    expectedProfileConfigHash,
    expectedQueryModel,
    expectedQueryDimension,
    queryReceipts,
    sourceContent,
  },
) {
  if (!Array.isArray(hitsValue)) fail('search hits must be an array')
  if (typeof sourceContent !== 'string' || sourceContent === '') {
    fail('actual source document content must be nonempty')
  }
  const oracle = record(oracleValue, 'oracle')
  const citation = record(oracle.citation, 'oracle citation')
  const extraction = record(oracle.extraction, 'oracle extraction')
  const oracleQuery = nonEmpty(oracle.query, 'oracle query')
  const documentID = nonEmpty(expectedDocumentId, 'expected document id')
  const documentGeneration = positiveInteger(
    expectedDocumentGeneration,
    'expected document generation',
  )
  const sourceDigest = sha256Hex(expectedSourceDigest, 'expected source digest')
  const revisionID = nonEmpty(expectedRevisionId, 'expected revision id')
  const profileID = nonEmpty(expectedProfileId, 'expected profile id')
  const profileConfigHash = sha256Hex(expectedProfileConfigHash, 'expected profile config hash')
  const queryModel = nonEmpty(expectedQueryModel, 'expected query model')
  const queryDimension = positiveInteger(expectedQueryDimension, 'expected query dimension')
  if (sha256Hex(oracle.pdfSha256, 'oracle PDF digest') !== sourceDigest) {
    fail('expected source digest must match the frozen PDF')
  }
  if (extraction.normalization !== NORMALIZATION) {
    fail(`normalization must equal ${NORMALIZATION}`)
  }
  const physicalPage = positiveInteger(citation.physicalPage, 'oracle physical page')
  const normalizedLength = positiveInteger(citation.normalizedLength, 'oracle normalized length')
  const normalizedTextSha256 = sha256Hex(
    citation.normalizedTextSha256,
    'oracle normalized text digest',
  )
  if (citation.wholePdfExactOccurrences !== 1) {
    fail('frozen oracle must have exactly one whole-PDF occurrence')
  }

  if (!Array.isArray(queryReceipts)) fail('query receipts must be an array')
  const embeddingReceipts = queryReceipts.filter(
    (candidate) => candidate?.operation === 'query_embedding',
  )
  if (embeddingReceipts.length === 0) fail('a query_embedding receipt is required')
  const expectedQueryDigest = `sha256:${digest(oracleQuery)}`
  let originalQueryReceipt
  for (const [index, value] of embeddingReceipts.entries()) {
    const receipt = record(value, `query_embedding receipt ${index}`)
    if (receipt.status !== 'succeeded') {
      fail(`query_embedding receipt ${index} must have succeeded`)
    }
    nonEmpty(receipt.provider_id, `query_embedding receipt ${index} provider id`)
    if (
      positiveInteger(receipt.dimension, `query_embedding receipt ${index} dimension`) !==
      queryDimension
    ) {
      fail(`query_embedding receipt ${index} dimension does not match the frozen profile`)
    }
    if (nonEmpty(receipt.revision_id, `query_embedding receipt ${index} revision`) !== revisionID) {
      fail(`query_embedding receipt ${index} revision does not match the frozen revision`)
    }
    if (nonEmpty(receipt.profile_id, `query_embedding receipt ${index} profile id`) !== profileID) {
      fail(`query_embedding receipt ${index} profile does not match the frozen profile`)
    }
    if (
      sha256Hex(
        receipt.profile_config_hash,
        `query_embedding receipt ${index} profile config hash`,
      ) !== profileConfigHash
    ) {
      fail(`query_embedding receipt ${index} profile config does not match the frozen profile`)
    }
    if (nonEmpty(receipt.model, `query_embedding receipt ${index} model`) !== queryModel) {
      fail(`query_embedding receipt ${index} model does not match the frozen query model`)
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(receipt.query_digest)) {
      fail(`query_embedding receipt ${index} query digest must be a sha256-prefixed digest`)
    }
    if (receipt.query_digest === expectedQueryDigest) originalQueryReceipt = receipt
  }
  if (!originalQueryReceipt) fail('query receipts do not bind the frozen original query')

  const matches = []
  let disconnectedSourceSpans = 0
  let wrongDocumentGeneration = 0
  let wrongRevision = 0
  let invalidCitation = 0
  for (const value of hitsValue) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const hit = value
    if (
      hit.doc_id !== documentID ||
      hit.source_digest !== sourceDigest ||
      !Number.isSafeInteger(hit.page_start) ||
      !Number.isSafeInteger(hit.page_end) ||
      hit.page_start > physicalPage ||
      hit.page_end < physicalPage ||
      typeof hit.chunk_id !== 'string' ||
      hit.chunk_id.trim() === ''
    ) {
      continue
    }
    if (hit.document_generation !== documentGeneration) {
      wrongDocumentGeneration += 1
      continue
    }
    if (hit.revision_id !== revisionID) {
      wrongRevision += 1
      continue
    }
    if (
      !Number.isSafeInteger(hit.source_offset_start) ||
      hit.source_offset_start < 0 ||
      !Number.isSafeInteger(hit.source_offset_end) ||
      hit.source_offset_end <= hit.source_offset_start ||
      typeof hit.content !== 'string' ||
      hit.content === ''
    ) {
      continue
    }
    if (
      typeof hit.citation_digest !== 'string' ||
      !SHA256_HEX.test(hit.citation_digest) ||
      hit.citation_digest !== digest(hit.content)
    ) {
      invalidCitation += 1
      continue
    }
    const rawSourceSpan = rawSourceSpanAtOffsets(
      sourceContent,
      hit.source_offset_start,
      hit.source_offset_end,
    )
    if (rawSourceSpan === undefined || rawSourceSpan === '') continue
    if (!hit.content.includes(rawSourceSpan)) {
      disconnectedSourceSpans += 1
      continue
    }
    const offsets = matchingNormalizedSpans(rawSourceSpan, normalizedLength, normalizedTextSha256)
    for (const normalizedOffset of offsets) matches.push({ hit, normalizedOffset })
  }

  if (matches.length === 0 && wrongDocumentGeneration > 0) {
    fail('search hit document generation does not match the frozen document generation')
  }
  if (matches.length === 0 && wrongRevision > 0) {
    fail('search hit revision does not match the frozen vector revision')
  }
  if (matches.length === 0 && invalidCitation > 0) {
    fail('search hit citation digest is not the SHA-256 digest of its returned content')
  }
  if (matches.length === 0 && disconnectedSourceSpans > 0) {
    fail('search hit content does not contain its actual source-offset span')
  }
  if (matches.length === 0) fail('no actual raw source span matches the frozen oracle')

  return {
    hit: matches[0].hit,
    matchingHitCount: matches.length,
    normalizedOffset: matches[0].normalizedOffset,
    normalizedLength,
    normalizedTextSha256,
    sourceOffsetStart: matches[0].hit.source_offset_start,
    sourceOffsetEnd: matches[0].hit.source_offset_end,
    queryEmbeddingReceipt: originalQueryReceipt,
  }
}
