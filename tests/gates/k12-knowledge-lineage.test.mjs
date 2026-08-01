import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const repoFile = (path) => new URL(`../../${path}`, import.meta.url)
const source = {
  digest: '657e1547074668dbb50f2bf37f13c20f292127be64c26c5334190aa34d06de83',
  bytes: 14_621_452,
  pages: 131,
}

async function loadLineage() {
  return import(repoFile('scripts/ci/k12-knowledge-lineage.mjs'))
}

test('BUG-TEST-INFRA-K12-REAL-10X C07→C09 lineage only advances one same-run textbook identity', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hexclaw-k12-lineage-test-'))
  t.after(async () => rm(root, { recursive: true, force: true }))
  const {
    createKnowledgeLineage,
    readKnowledgeLineage,
    writeC07KnowledgeLineage,
    advanceKnowledgeLineage,
  } = await loadLineage()

  const lineage = await createKnowledgeLineage({ root, parentRunId: 'run-a' })
  assert.match(lineage.path, /knowledge-lineage\.json$/)
  assert.equal(lineage.parentRunSha256.length, 64)

  await writeC07KnowledgeLineage(lineage, {
    documentId: 'document-a',
    jobId: 'job-a',
    source,
  })
  assert.deepEqual(await readKnowledgeLineage(lineage, { expectedPhase: 'C07' }), {
    schema_version: 1,
    phase: 'C07',
    parent_run_sha256: lineage.parentRunSha256,
    document_id: 'document-a',
    job_id: 'job-a',
    source_digest: source.digest,
    bytes: source.bytes,
    pages: source.pages,
  })

  await advanceKnowledgeLineage(lineage, {
    expectedPhase: 'C07',
    nextPhase: 'C08',
    next: {
      document_generation: 3,
      active_revision_id: 'revision-a',
      profile_id: 'profile-a',
      profile_config_hash: 'a'.repeat(64),
    },
  })
  await advanceKnowledgeLineage(lineage, {
    expectedPhase: 'C08',
    nextPhase: 'C09',
    next: {
      hit_revision_id: 'revision-a',
      chunk_id: 'chunk-a',
      citation_digest: 'b'.repeat(64),
      query_digest: `sha256:${'c'.repeat(64)}`,
      query_model: 'qwen3-embedding:8b',
      source_offset_start: 12,
      source_offset_end: 98,
      raw_source_span_normalized_length: 58,
      raw_source_span_normalized_sha256: 'd'.repeat(64),
    },
  })
  assert.deepEqual(await readKnowledgeLineage(lineage, { expectedPhase: 'C09' }), {
    schema_version: 1,
    phase: 'C09',
    parent_run_sha256: lineage.parentRunSha256,
    document_id: 'document-a',
    job_id: 'job-a',
    source_digest: source.digest,
    bytes: source.bytes,
    pages: source.pages,
    document_generation: 3,
    active_revision_id: 'revision-a',
    profile_id: 'profile-a',
    profile_config_hash: 'a'.repeat(64),
    hit_revision_id: 'revision-a',
    chunk_id: 'chunk-a',
    citation_digest: 'b'.repeat(64),
    query_digest: `sha256:${'c'.repeat(64)}`,
    query_model: 'qwen3-embedding:8b',
    source_offset_start: 12,
    source_offset_end: 98,
    raw_source_span_normalized_length: 58,
    raw_source_span_normalized_sha256: 'd'.repeat(64),
  })
})

test('BUG-TEST-INFRA-K12-REAL-10X lineage rejects pre-existing, unsafe and cross-run state before successor work', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hexclaw-k12-lineage-test-'))
  t.after(async () => rm(root, { recursive: true, force: true }))
  const {
    createKnowledgeLineage,
    readKnowledgeLineage,
    writeC07KnowledgeLineage,
    advanceKnowledgeLineage,
  } = await loadLineage()

  const first = await createKnowledgeLineage({ root, parentRunId: 'run-a' })
  await assert.rejects(
    () => createKnowledgeLineage({ root, parentRunId: 'run-b' }),
    /pre-existing|fresh/i,
  )
  await writeC07KnowledgeLineage(first, { documentId: 'document-a', jobId: 'job-a', source })
  await assert.rejects(
    () =>
      readKnowledgeLineage({ ...first, parentRunSha256: 'f'.repeat(64) }, { expectedPhase: 'C07' }),
    /parent run/i,
  )
  await chmod(first.path, 0o644)
  await assert.rejects(() => readKnowledgeLineage(first, { expectedPhase: 'C07' }), /0600/i)
  await chmod(first.path, 0o600)
  await assert.rejects(
    () =>
      advanceKnowledgeLineage(first, {
        expectedPhase: 'C08',
        nextPhase: 'C09',
        next: {
          chunk_id: 'chunk-a',
          citation_digest: 'b'.repeat(64),
          query_digest: 'c'.repeat(64),
          query_model: 'qwen3-embedding:8b',
        },
      }),
    /phase/i,
  )

  const unsafeRoot = await mkdtemp(join(tmpdir(), 'hexclaw-k12-lineage-test-'))
  t.after(async () => rm(unsafeRoot, { recursive: true, force: true }))
  const unsafe = await createKnowledgeLineage({ root: unsafeRoot, parentRunId: 'run-c' })
  await writeFile(unsafe.path, '{}', { mode: 0o600 })
  await assert.rejects(
    () => writeC07KnowledgeLineage(unsafe, { documentId: 'document-b', jobId: 'job-b', source }),
    /pre-existing|fresh/i,
  )
  const linkedRoot = await mkdtemp(join(tmpdir(), 'hexclaw-k12-lineage-test-'))
  t.after(async () => rm(linkedRoot, { recursive: true, force: true }))
  const linked = await createKnowledgeLineage({ root: linkedRoot, parentRunId: 'run-d' })
  await symlink(unsafe.path, linked.path)
  await assert.rejects(
    () => readKnowledgeLineage(linked, { expectedPhase: 'C07' }),
    /symlink|regular/i,
  )
})
