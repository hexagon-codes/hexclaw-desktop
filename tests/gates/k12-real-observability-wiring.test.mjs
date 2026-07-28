import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const repoFile = (path) => new URL(`../../${path}`, import.meta.url)

test('solve and art matrix consumes immutable source and exact operation receipts', async () => {
  const source = await readFile(
    repoFile('tests/live/k12-current-bug-real-matrix.spec.ts'),
    'utf8',
  )

  for (const token of [
    'source_attachments',
    'operation_receipts',
    'invocation_id',
    'result_digest',
    "'solve'",
    "'work_feedback'",
    "'problem'",
    "'art'",
  ]) {
    assert.match(source, new RegExp(token))
  }
  assert.match(source, /expect\(receipt\.provider\)\.toBe\(contract\.provider\.identity\)/)
  assert.match(source, /expect\(receipt\.model\)\.toBe\(contract\.provider\.model\)/)
  assert.match(source, /expect\(receipt\.attempt\)\.toBe\(1\)/)
  assert.match(source, /expect\(receipt\.status\)\.toBe\('succeeded'\)/)
})

test('grounding matrix consumes the fixed oracle, query receipt and active embedding policy', async () => {
  const source = await readFile(repoFile('tests/e2e/grounding-pdf.spec.ts'), 'utf8')

  for (const token of [
    'k12-textbook-rag-oracle.v1.json',
    'query_receipts',
    'page_start',
    'page_end',
    'chunk_id',
    'citation_digest',
    'profile_config_hash',
    'active_revision',
    'embedding-policy',
    'qwen3-embedding:8b',
  ]) {
    assert.match(source, new RegExp(token))
  }
  assert.match(source, /expect\(receipt\.operation\)\.toBe\('query_embedding'\)/)
  assert.match(source, /expect\(receipt\.status\)\.toBe\('succeeded'\)/)
  assert.match(source, /expect\(receipt\.model\)\.toBe\(RAG_ORACLE\.embeddingModel\)/)
})
