import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const repoFile = (path) => new URL(`../../${path}`, import.meta.url)

async function readJSON(path) {
  return JSON.parse(await readFile(repoFile(path), 'utf8'))
}

const currentBugHook = {
  lane: 'current-bug-live-strict',
  module: 'scripts/ci/k12-current-bug-live-gate.mjs',
  args: ['--strict'],
}

const fixturesHook = {
  lane: 'fixtures-strict',
  module: 'scripts/ci/k12-fixtures-gate.mjs',
  args: ['--strict'],
}

const restartHook = {
  lane: 'c10-restart-recovery-strict',
  module: 'scripts/ci/k12-c10-restart-recovery-gate.mjs',
  args: ['--strict'],
}

test('C01 freezes the real solve image and uses the exact-model current-bug hook', async () => {
  const fixtureContract = await readJSON(
    'tests/live/k12-current-bug-real-matrix.contract.json',
  )
  const releaseContract = await readJSON('tests/live/k12-real-10x-release.contract.json')
  const cycle = releaseContract.cycles.find(({ id }) => id === 'C01')

  assert.deepEqual(fixtureContract.fixtures.problem, {
    env: 'HEX_K12_PROBLEM_IMAGE',
    path: '/Users/guoyanjun/work/hexclaw-docs/test/k12-test-解题.JPG',
    sha256: '76c3bbab79486619d680114b8c182c0e23d15ce305239dc762819a5f0407eed7',
    bytes: 204498,
    width: 936,
    height: 1280,
  })
  assert.deepEqual(cycle.hook, currentBugHook)
  assert.deepEqual(cycle.requiredProof, [
    'attachment_digest',
    'dispatch_id',
    'solve_terminal_result',
    'provider_model_receipt',
  ])
})

test('C06 freezes the real art image and uses one exact-model canonical-work hook', async () => {
  const fixtureContract = await readJSON(
    'tests/live/k12-current-bug-real-matrix.contract.json',
  )
  const releaseContract = await readJSON('tests/live/k12-real-10x-release.contract.json')
  const cycle = releaseContract.cycles.find(({ id }) => id === 'C06')

  assert.deepEqual(fixtureContract.fixtures.art, {
    env: 'HEX_K12_ART_IMAGE',
    path: '/Users/guoyanjun/work/hexclaw-docs/test/k12-test-美术.png',
    sha256: '7eb16fdbe398236cdf2ce31ea6d2fac5e4787ea3004b96ab74a3eebd540f1d93',
    bytes: 2713090,
    width: 1254,
    height: 1254,
  })
  assert.deepEqual(cycle.hook, currentBugHook)
  assert.deepEqual(cycle.supportingEvidence, [
    {
      lane: 'fixtures-strict',
      spec: 'creative-real-fixtures.spec.ts',
      cases: [
        'art upload stores the frozen image under the exact Tutor owner and round-trips its bytes',
        'art save automatically produces feedback that cites visible elements',
      ],
    },
  ])
  assert.deepEqual(cycle.requiredProof, [
    'source_digest',
    'work_id',
    'generation_id',
    'feedback_id',
    'archive_projection_digest',
    'provider_model_receipt',
  ])
})

test('C09 freezes a locally extracted page oracle and uses the strict grounding hook', async () => {
  const oracle = await readJSON('tests/fixtures/local/k12-textbook-rag-oracle.v1.json')
  const contract = await readJSON('tests/live/k12-real-10x-release.contract.json')
  const cycle = contract.cycles.find(({ id }) => id === 'C09')

  assert.deepEqual(oracle, {
    schemaVersion: 1,
    fixtureId: 'textbook_pdf',
    pdfSha256: '657e1547074668dbb50f2bf37f13c20f292127be64c26c5334190aa34d06de83',
    query: '在整数除法中，什么情况下说除数是被除数的因数，被除数是除数的倍数？',
    citation: {
      physicalPage: 10,
      normalizedTextSha256:
        '7740d0dbfd9cb464d2d22f695d4bf2bcba3bbfe6dc83e0df2a673465f890e0ed',
      normalizedLength: 58,
      wholePdfExactOccurrences: 1,
    },
    extraction: {
      tool: 'pdftotext',
      normalization: 'NFKC then remove all whitespace',
    },
  })
  assert.deepEqual(cycle.hook, fixturesHook)
  assert.equal(cycle.oracle, 'tests/fixtures/local/k12-textbook-rag-oracle.v1.json')
  assert.deepEqual(cycle.requiredProof, [
    'document_id',
    'physical_page',
    'chunk_id',
    'citation_digest',
    'qwen3_embedding_query_receipt',
  ])
})

test('C10 contract requires a real PID change and signed state handoff, never browser reload', async () => {
  const restart = await readJSON('tests/live/k12-c10-restart-hook.contract.json')
  const release = await readJSON('tests/live/k12-real-10x-release.contract.json')
  const cycle = release.cycles.find(({ id }) => id === 'C10')

  assert.deepEqual(cycle.hook, restartHook)
  assert.equal(cycle.restartContract, 'tests/live/k12-c10-restart-hook.contract.json')
  assert.deepEqual(cycle.requiredEnvironment, {
    exact: {
      HEX_K12_C10_RESTART_AUTHORIZED: '1',
    },
    values: [
      'HEX_K12_C10_RESTART_HOOK',
      'HEX_K12_C10_RESTART_HOOK_SHA256',
      'HEX_K12_C10_HANDOFF_PUBLIC_KEY',
      'HEX_K12_C10_HANDOFF_PUBLIC_KEY_SHA256',
      'HEX_K12_C10_BEFORE_HANDOFF',
      'HEX_K12_C10_AFTER_HANDOFF',
      'HEX_K12_C10_AFTER_HANDOFF_PUBLIC_KEY',
      'HEX_K12_C10_DRIVER_CONFIG',
    ],
  })
  assert.deepEqual(restart.isolatedDriver, {
    module: 'scripts/ci/k12-c10-isolated-restart-driver.mjs',
    cli: [
      '--restart-k12-sidecar',
      '--config',
      '$HEX_K12_C10_DRIVER_CONFIG',
    ],
  })
  assert.deepEqual(restart.signedEnvelope, {
    algorithm: 'Ed25519',
    payloadEncoding: 'base64-utf8-json',
    exactFields: ['algorithm', 'payload_b64', 'signature_b64'],
  })
  assert.deepEqual(restart.requiredBefore, [
    'schema_version',
    'phase',
    'run_id',
    'cycle_id',
    'restart_method',
    'sidecar_pid',
    'document_id',
    'source_digest',
    'active_revision_id',
    'profile_id',
    'profile_config_hash',
    'upload_count',
    'index_count',
    'query_model',
    'query_digest',
    'hit_document_id',
    'citation_digest',
    'page_start',
    'page_end',
  ])
  assert.deepEqual(restart.requiredAfter, [
    'schema_version',
    'phase',
    'run_id',
    'cycle_id',
    'restart_method',
    'sidecar_pid',
    'document_id',
    'source_digest',
    'active_revision_id',
    'profile_id',
    'profile_config_hash',
    'upload_count',
    'index_count',
    'query_model',
    'query_digest',
    'hit_document_id',
    'citation_digest',
    'page_start',
    'page_end',
  ])
  assert.deepEqual(restart.invariants, {
    sidecarPidMustChange: true,
    documentIdMustMatch: true,
    sourceDigestMustMatch: true,
    activeRevisionIdMustMatch: true,
    profileIdMustMatch: true,
    profileConfigHashMustMatch: true,
    queryModel: 'qwen3-embedding:8b',
    queryDigestMustMatch: true,
    uploadCountDelta: 0,
    indexCountDelta: 0,
    hitDocumentIdMustMatch: true,
    citationDigestMustMatch: true,
    pageRangeMustMatch: true,
    oraclePhysicalPage: 10,
  })
  assert.deepEqual(restart.forbiddenEvidence, [
    'browser_reload',
    'new_profile',
    'new_database',
    'reupload',
    'full_reindex',
  ])
})
