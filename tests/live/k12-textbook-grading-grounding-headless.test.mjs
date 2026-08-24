import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const LIVE_ROOT = dirname(fileURLToPath(import.meta.url))
const SCRIPT_PATH = resolve(LIVE_ROOT, 'k12-textbook-grading-grounding-headless.mjs')
const CONTRACT_PATH = resolve(LIVE_ROOT, 'k12-textbook-grading-grounding.contract.json')
const SCAN_OCR_ORACLE_PATH = resolve(
  LIVE_ROOT,
  '../fixtures/local/k12-textbook-scan-ocr-oracle.v1.json',
)

const modulePromise = import('./k12-textbook-grading-grounding-headless.mjs')

const EXPECTED_STATEFUL_PHASES = Object.freeze([
  'prepare',
  'upload-text',
  'advance-text',
  'retrieve-text',
  'upload-scan',
  'advance-scan',
  'retrieve-scan',
  'bind',
  'grade',
  'restart',
  'status',
])

const OCR_SOURCE_DIGEST = 'a'.repeat(64)

function ocrReceipts() {
  return Array.from({ length: 122 }, (_, index) => ({
    page_number: index + 1,
    pages_total: 122,
    operation: 'knowledge_pdf_page_ocr',
    status: 'succeeded',
    provider: 'hexclaw-gpt',
    model: 'gpt-5.6-sol',
    source_digest: OCR_SOURCE_DIGEST,
    content_digest: createHash('sha256')
      .update(`page-${index + 1}`)
      .digest('hex'),
    fake: false,
  }))
}

function problemGroundingReceipt(problemID, operation, identityDigest, suffix) {
  return {
    problem_id: problemID,
    operation,
    identity_digest: identityDigest,
    textbook_binding_id: 'binding-1',
    textbook_manifest_id: 'manifest-1',
    document_id: 'document-1',
    document_generation: 3,
    vector_revision_id: 'revision-1',
    query_digest: `sha256:${String(suffix).repeat(64)}`,
    chunk_id: `chunk-${suffix}`,
    logical_page: 49,
    pdf_page: 54,
    source_digest: 'b'.repeat(64),
    citation_digest: String(suffix).repeat(64),
  }
}

test('validate and manually selected phases are capped below 30 minutes without automatic continuation', async () => {
  const {
    PHASES,
    STATEFUL_PHASES,
    boundedRequestTimeout,
    phaseBudgetMilliseconds,
    resolvePhase,
    usageText,
    withPhaseWallClock,
  } = await modulePromise

  assert.deepEqual(PHASES, [
    'validate',
    'prepare',
    'upload-text',
    'advance-text',
    'retrieve-text',
    'upload-scan',
    'advance-scan',
    'retrieve-scan',
    'bind',
    'grade',
    'restart',
    'status',
  ])
  for (const phase of PHASES) assert.equal(resolvePhase([phase]), phase)
  assert.equal(resolvePhase([]), 'validate')
  assert.throws(() => resolvePhase(['run']), /INVALID_PHASE/u)
  assert.throws(() => resolvePhase(['validate', 'prepare']), /INVALID_PHASE/u)
  assert.ok(phaseBudgetMilliseconds({}) > 0)
  assert.ok(phaseBudgetMilliseconds({}) < 30 * 60_000)
  assert.equal(
    phaseBudgetMilliseconds({ HEXCLAW_TEXTBOOK_PHASE_TIMEOUT_MS: '1800000' }),
    29 * 60_000,
  )
  assert.equal(boundedRequestTimeout(90_000, 120_000, 90_000), 10_000)
  assert.throws(() => boundedRequestTimeout(90_000, 110_000, 90_000), /PHASE_BUDGET/u)

  assert.deepEqual(STATEFUL_PHASES, EXPECTED_STATEFUL_PHASES)
  assert.equal(resolvePhase(['help']), 'help')
  const numbered = usageText()
    .split('\n')
    .filter((line) => /^\d+\. /u.test(line))
    .map((line) => line.replace(/^\d+\. /u, ''))
  assert.deepEqual(numbered, EXPECTED_STATEFUL_PHASES)
  assert.match(usageText(), /exit code 3.*re-run the same phase manually/iu)
  assert.match(usageText(), /prepare.*marked interruption.*before state\.json/iu)
  assert.match(usageText(), /does not claim.*external work/iu)

  let validationStarted = false
  let cleanupObservedAbort = false
  const startedAt = Date.now()
  await assert.rejects(
    withPhaseWallClock(20, async ({ signal }) => {
      validationStarted = true
      await new Promise((resolveAbort) => {
        signal.addEventListener(
          'abort',
          () => {
            cleanupObservedAbort = true
            resolveAbort()
          },
          { once: true },
        )
      })
      await new Promise((resolveCleanup) => setTimeout(resolveCleanup, 10))
    }),
    /PHASE_WALL_CLOCK_PENDING/u,
  )
  assert.equal(validationStarted, true)
  assert.equal(cleanupObservedAbort, true)
  assert.ok(Date.now() - startedAt < 500)

  const source = await readFile(SCRIPT_PATH, 'utf8')
  assert.match(source, /withPhaseWallClock\(hardTimeout/u)
  assert.match(source, /dispatchPhase\(phase, process\.env, deadline, signal\)/u)
  assert.match(source, /validateStatic\(env, deadline, signal\)/u)
})

test('prepare recovers only its private marked pre-state interruption and preserves redacted evidence', async () => {
  const { prepareRunDirectory } = await modulePromise
  const parent = await mkdtemp(join(tmpdir(), 'hexclaw-textbook-prepare-'))
  const runRoot = join(parent, 'run')
  try {
    const first = await prepareRunDirectory(runRoot)
    assert.equal(first.status, 'created')
    assert.match(first.marker, /^\.hexclaw-textbook-harness-v1-[a-f0-9]{16}$/u)

    await writeFile(join(runRoot, 'bin', 'partial-sidecar'), 'partial', { mode: 0o600 })
    await writeFile(join(runRoot, '.hexclaw', 'hexclaw.yaml'), 'secret', { mode: 0o600 })
    await writeFile(join(runRoot, 'data.db'), 'partial', { mode: 0o600 })
    await mkdir(join(runRoot, 'evidence'), { mode: 0o700 })
    const evidence = '{"status":"failed","phase":"prepare","error_code":"BUILD_FAILED"}\n'
    await writeFile(join(runRoot, 'evidence', 'prepare.json'), evidence, { mode: 0o600 })

    const recovered = await prepareRunDirectory(runRoot)
    assert.equal(recovered.status, 'recovered')
    assert.equal(recovered.marker, first.marker)
    assert.deepEqual((await readdir(join(runRoot, 'bin'))).sort(), [])
    assert.deepEqual((await readdir(join(runRoot, '.hexclaw'))).sort(), [])
    assert.deepEqual((await readdir(join(runRoot, 'tmp'))).sort(), [])
    assert.equal(await readFile(join(runRoot, 'evidence', 'prepare.json'), 'utf8'), evidence)
    await assert.rejects(lstat(join(runRoot, 'data.db')), { code: 'ENOENT' })
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})

test('prepare never cleans an unmarked, symlinked, non-private, or unexpectedly populated run directory', async () => {
  const { prepareRunDirectory } = await modulePromise
  const parent = await mkdtemp(join(tmpdir(), 'hexclaw-textbook-unsafe-'))
  try {
    const unmarked = join(parent, 'unmarked')
    await mkdir(unmarked, { mode: 0o700 })
    await writeFile(join(unmarked, 'keep.txt'), 'keep', { mode: 0o600 })
    await assert.rejects(prepareRunDirectory(unmarked), /RUN_DIRECTORY_RECOVERY_UNSAFE/u)
    assert.equal(await readFile(join(unmarked, 'keep.txt'), 'utf8'), 'keep')

    const marked = join(parent, 'marked')
    const initialized = await prepareRunDirectory(marked)
    await writeFile(join(marked, 'unexpected.txt'), 'keep', { mode: 0o600 })
    await assert.rejects(prepareRunDirectory(marked), /RUN_DIRECTORY_RECOVERY_UNSAFE/u)
    assert.equal(await readFile(join(marked, 'unexpected.txt'), 'utf8'), 'keep')
    assert.ok((await lstat(join(marked, initialized.marker))).isDirectory())

    const nonPrivate = join(parent, 'non-private')
    await mkdir(nonPrivate, { mode: 0o700 })
    await chmod(nonPrivate, 0o755)
    await assert.rejects(prepareRunDirectory(nonPrivate), /RUN_DIRECTORY_NOT_EMPTY_OR_PRIVATE/u)

    const target = join(parent, 'target')
    const linked = join(parent, 'linked')
    await mkdir(target, { mode: 0o700 })
    await symlink(target, linked)
    await assert.rejects(prepareRunDirectory(linked), /RUN_DIRECTORY_NOT_EMPTY_OR_PRIVATE/u)
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})

test('stateful external commands and Playwright request waits consume the phase AbortSignal', async () => {
  const { apiJSON, runCommand } = await modulePromise

  const commandController = new AbortController()
  const commandStartedAt = Date.now()
  const command = runCommand(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1_000)'],
    {
      cwd: LIVE_ROOT,
      env: process.env,
      timeout: 5_000,
      signal: commandController.signal,
    },
    'TEST_COMMAND_FAILED',
  )
  setTimeout(() => commandController.abort(), 20)
  await assert.rejects(command, /PHASE_WALL_CLOCK_PENDING/u)
  assert.ok(Date.now() - commandStartedAt < 1_000)

  let fetchStarted = false
  const api = {
    fetch: async () => {
      fetchStarted = true
      return await new Promise(() => {})
    },
  }
  const requestController = new AbortController()
  const requestStartedAt = Date.now()
  const request = apiJSON(api, 'GET', '/never', {
    signal: requestController.signal,
    timeout: 5_000,
  })
  setTimeout(() => requestController.abort(), 20)
  await assert.rejects(request, /PHASE_WALL_CLOCK_PENDING/u)
  assert.equal(fetchStarted, true)
  assert.ok(Date.now() - requestStartedAt < 1_000)

  const source = await readFile(SCRIPT_PATH, 'utf8')
  assert.match(source, /execFile\(command, args,[\s\S]*signal/u)
  assert.match(source, /startSidecar\(runtime, capability, signal\)/u)
  assert.match(source, /signal\.addEventListener\(['"]abort['"][\s\S]*api\.dispose/u)
})

test('contract freezes exact real providers, fixtures, public APIs, pages, and no-live validate mode', async () => {
  const { validateContract } = await modulePromise
  const [contract, scanOracle] = await Promise.all(
    [CONTRACT_PATH, SCAN_OCR_ORACLE_PATH].map(async (pathname) =>
      JSON.parse(await readFile(pathname, 'utf8')),
    ),
  )
  const projected = validateContract(contract)

  assert.deepEqual(projected.route, {
    provider: 'hexclaw-gpt',
    model: 'gpt-5.6-sol',
    fallback_allowed: false,
  })
  assert.deepEqual(projected.embedding, {
    model: 'qwen3-embedding:8b',
    purpose: 'ollama_embeddings',
    dimension: 4096,
    preserve_owner_profile: true,
  })
  assert.deepEqual(projected.knowledge_identity, {
    success_multipart_fields: ['corpus_id', 'file'],
    forged_fields: ['agent_id', 'learner_id', 'subject', 'grade'],
    forged_fields_must_not_prebind: true,
    binding_authority: 'profile_bundle_cas_only',
  })
  assert.deepEqual(projected.artifact_receipt_binding, {
    projection: 'image_task_target_plus_result',
    final_artifact_embeds_grounding: false,
    required_fields: ['artifact_id', 'artifact_digest', 'summary_invocation_id'],
    summary_operation: 'projecting',
    same_dispatch: true,
  })
  assert.equal(projected.textbook.text.pages, 131)
  assert.deepEqual(projected.textbook.text.oracle_pages, [54, 57])
  assert.equal(projected.textbook.scan.pages, 122)
  assert.deepEqual(projected.textbook.scan.oracle_pages, [5, 61, 120])
  assert.deepEqual(
    projected.textbook.scan.oracles,
    scanOracle.oracles.map((oracle) => ({
      physical_page: oracle.physicalPage,
      query: oracle.query,
      query_sha256: oracle.querySha256,
      top_k: oracle.retrievalOracle.topK,
      expected_physical_pages: oracle.retrievalOracle.expectedPhysicalPages,
      expected_page_match: oracle.retrievalOracle.expectedPageMatch,
    })),
  )
  assert.equal(projected.textbook.scan.require_real_ocr_receipt, true)
  assert.equal(projected.validate_side_effects.model_calls, 0)
  assert.equal(projected.validate_side_effects.uploads, 0)
  assert.equal(projected.validate_side_effects.sidecar_starts, 0)
  assert.equal(projected.transport.sqlite_seed_or_write, false)
  assert.equal(projected.transport.product_operations, 'public_http_api_only')
})

test('scan retrieval contract rejects the legacy single-page oracle and topK 20 chain', async () => {
  const { validateContract } = await modulePromise
  const contract = JSON.parse(await readFile(CONTRACT_PATH, 'utf8'))

  const legacySinglePage = structuredClone(contract)
  legacySinglePage.fixtures.scan.oracles = legacySinglePage.fixtures.scan.oracles.slice(0, 1)
  assert.throws(() => validateContract(legacySinglePage), /TEXTBOOK_ORACLE_CONTRACT_INVALID/u)

  const legacyTopK = structuredClone(contract)
  for (const oracle of legacyTopK.fixtures.scan.oracles) oracle.top_k = 20
  assert.throws(() => validateContract(legacyTopK), /TEXTBOOK_ORACLE_CONTRACT_INVALID/u)
})

test('live harness binds the scan retrieval contract to the audited OCR oracle file identity', async () => {
  const { assertScanOCROracleSource } = await modulePromise
  const [contract, rawOracle] = await Promise.all([
    readFile(CONTRACT_PATH, 'utf8').then(JSON.parse),
    readFile(SCAN_OCR_ORACLE_PATH, 'utf8'),
  ])
  const sourceDigest = createHash('sha256').update(rawOracle).digest('hex')
  const projected = assertScanOCROracleSource(contract, JSON.parse(rawOracle), sourceDigest)

  assert.deepEqual(projected, {
    sha256: contract.fixtures.scan.oracle_source.sha256,
    pages: 122,
    oracle_pages: [5, 61, 120],
    top_k: [3],
  })
  assert.throws(
    () => assertScanOCROracleSource(contract, JSON.parse(rawOracle), '0'.repeat(64)),
    /TEXTBOOK_ORACLE_SOURCE_INVALID/u,
  )
  const drifted = JSON.parse(rawOracle)
  drifted.oracles[1].query = 'drift'
  assert.throws(
    () => assertScanOCROracleSource(contract, drifted, sourceDigest),
    /TEXTBOOK_ORACLE_(CONTRACT|SOURCE)_INVALID/u,
  )
})

test('scan retrieval uses topK 3 and accepts only the frozen physical-page exact-set', async () => {
  const { assertOracleSearchExactSet, retrievalRequestForOracle } = await modulePromise
  const contract = JSON.parse(await readFile(CONTRACT_PATH, 'utf8'))
  const oracle = contract.fixtures.scan.oracles[0]
  const saved = {
    document_id: 'scan-document',
    document_generation: 3,
    source_digest: 'a'.repeat(64),
    pages: 122,
  }
  const receipt = { revision_id: 'scan-revision' }
  const hit = {
    doc_id: saved.document_id,
    document_generation: saved.document_generation,
    revision_id: receipt.revision_id,
    chunk_id: 'scan-chunk-5',
    page_start: 5,
    page_end: 5,
    source_digest: saved.source_digest,
    citation_digest: 'b'.repeat(64),
    source_offset_start: 10,
    source_offset_end: 20,
    source: 'scan-source',
  }

  assert.deepEqual(retrievalRequestForOracle(oracle), {
    query: oracle.query,
    top_k: 3,
  })
  assert.equal(assertOracleSearchExactSet([hit], oracle, saved, receipt).length, 1)
  assert.throws(
    () =>
      assertOracleSearchExactSet(
        [...Array(2).fill(hit), { ...hit, chunk_id: 'scan-chunk-6', page_start: 6, page_end: 6 }],
        oracle,
        saved,
        receipt,
      ),
    /ORACLE_PHYSICAL_PAGE_EXACT_SET_INVALID/u,
  )
  assert.throws(
    () => retrievalRequestForOracle({ ...oracle, top_k: 20 }),
    /TEXTBOOK_ORACLE_CONTRACT_INVALID/u,
  )
})

test('real OCR proof requires the unique physical page 1..122 exact-set bound to the fixture', async () => {
  const { assertRealOCRReceipts } = await modulePromise
  const fixture = { pages: 122, sha256: OCR_SOURCE_DIGEST }
  const valid = ocrReceipts()
  assert.equal(assertRealOCRReceipts(valid, fixture).length, 122)

  const mutations = [
    valid.slice(1),
    [...valid, valid[0]],
    valid.map((receipt, index) => (index === 0 ? { ...receipt, pages_total: 121 } : receipt)),
    valid.map((receipt, index) => (index === 1 ? { ...receipt, fake: true } : receipt)),
    valid.map((receipt, index) =>
      index === 2 ? { ...receipt, source_digest: 'c'.repeat(64) } : receipt,
    ),
    valid.map((receipt, index) => (index === 3 ? { ...receipt, content_digest: '' } : receipt)),
    valid.map((receipt, index) => (index === 4 ? { ...receipt, operation: 'caption' } : receipt)),
    valid.map((receipt, index) =>
      index === 5 ? { ...receipt, external_request_id: 'must-not-leak' } : receipt,
    ),
  ]
  for (const receipts of mutations) {
    assert.throws(() => assertRealOCRReceipts(receipts, fixture), /OCR_(RECEIPT|PAGE)/u)
  }
})

test('text vector proof binds a successful public job to one frozen active qwen revision', async () => {
  const { assertActiveEmbeddingRevision } = await modulePromise
  const policy = {
    active_revision: {
      revision_id: 'revision-1',
      state: 'ready',
      profile_config_hash: 'd'.repeat(64),
      profile: {
        profile_id: 'profile-1',
        provider_id: 'ollama-local',
        provider_name: 'ollama',
        model_name: 'qwen3-embedding:8b',
        location: 'local',
        capability: 'embedding',
        dimension: 4096,
        availability: 'installed',
        display_order: 1,
      },
      chunks_done: 131,
      chunks_total: 131,
    },
  }
  const document = {
    document_id: 'document-1',
    vector_index_state: 'ready',
    vector_job_id: 'vector-job-1',
    vector_job_state: 'succeeded',
    vector_job_stage: 'embedding',
    vector_chunks_done: 17,
    vector_chunks_total: 17,
  }
  const vectorJob = {
    job_id: 'vector-job-1',
    document_id: 'document-1',
    target_revision_id: 'revision-1',
    kind: 'embed_document',
    state: 'succeeded',
    stage: 'embedding',
    chunks_done: 17,
    chunks_total: 17,
  }
  const expected = {
    provider_id: 'ollama-local',
    provider_name: 'ollama',
    profile_id: 'profile-1',
    model: 'qwen3-embedding:8b',
    dimension: 4096,
  }
  assert.equal(
    assertActiveEmbeddingRevision(policy, document, vectorJob, expected).revision_id,
    'revision-1',
  )
  for (const mutate of [
    (copy) => {
      copy.policy.active_revision.chunks_done = 130
    },
    (copy) => {
      copy.policy.active_revision.profile.model_name = 'other'
    },
    (copy) => {
      copy.policy.active_revision.profile.provider_name = 'other'
    },
    (copy) => {
      copy.document.vector_chunks_done = 16
    },
    (copy) => {
      copy.vectorJob.state = 'running'
    },
    (copy) => {
      copy.vectorJob.target_revision_id = 'revision-2'
    },
  ]) {
    const copy = structuredClone({ policy, document, vectorJob })
    mutate(copy)
    assert.throws(
      () => assertActiveEmbeddingRevision(copy.policy, copy.document, copy.vectorJob, expected),
      /ACTIVE_EMBEDDING_REVISION/u,
    )
  }
})

test('public problem status exact-set drives mixed solve/grade, solve-only, and zero-receipt grounding', async () => {
  const { assertProblemGroundingExactSet } = await modulePromise
  const expectedProblemIDs = ['problem-gradable', 'problem-blank', 'problem-oos', 'problem-empty', 'problem-unclear']
  const progress = [
    { problem_id: 'problem-gradable', status: 'correct' },
    { problem_id: 'problem-blank', status: 'blank_solved' },
    { problem_id: 'problem-oos', status: 'out_of_scope' },
    { problem_id: 'problem-empty', status: 'unanswered' },
    { problem_id: 'problem-unclear', status: 'answer_unclear' },
  ]
  const target = [
    problemGroundingReceipt(
      'problem-gradable',
      'solve',
      `sha256:${'1'.repeat(64)}`,
      '1',
    ),
    problemGroundingReceipt(
      'problem-gradable',
      'grade',
      `sha256:${'1'.repeat(64)}`,
      '1',
    ),
    problemGroundingReceipt('problem-blank', 'solve', `sha256:${'2'.repeat(64)}`, '2'),
    problemGroundingReceipt('problem-oos', 'solve', `sha256:${'3'.repeat(64)}`, '3'),
  ]
  assert.equal(
    assertProblemGroundingExactSet(
      expectedProblemIDs,
      progress,
      target,
      structuredClone(target),
    ).length,
    4,
  )
  assert.deepEqual(
    assertProblemGroundingExactSet(
      ['problem-only-unclear'],
      [{ problem_id: 'problem-only-unclear', status: 'unclear' }],
      [],
      [],
    ),
    [],
  )

  for (const mutate of [
    (copy) => copy.progress.pop(),
    (copy) => copy.progress.push({ problem_id: 'problem-extra', status: 'correct' }),
    (copy) => copy.progress.push(structuredClone(copy.progress[0])),
    (copy) => {
      copy.progress[0].status = 'invented-status'
    },
    (copy) => {
      copy.target.splice(1, 1)
      copy.result = structuredClone(copy.target)
    },
    (copy) => {
      copy.target.push(structuredClone(copy.target[0]))
      copy.result = structuredClone(copy.target)
    },
    (copy) => {
      copy.target.push(
        problemGroundingReceipt('problem-blank', 'grade', `sha256:${'2'.repeat(64)}`, '2'),
      )
      copy.result = structuredClone(copy.target)
    },
    (copy) => {
      copy.target.push(
        problemGroundingReceipt('problem-empty', 'solve', `sha256:${'4'.repeat(64)}`, '4'),
      )
      copy.result = structuredClone(copy.target)
    },
    (copy) => {
      copy.target[1].identity_digest = `sha256:${'9'.repeat(64)}`
      copy.result = structuredClone(copy.target)
    },
    (copy) => {
      copy.target[1].chunk_id = 'other-chunk'
      copy.result = structuredClone(copy.target)
    },
    (copy) => {
      copy.target[0].problem_id = 'unknown-problem'
      copy.result = structuredClone(copy.target)
    },
    (copy) => copy.result.pop(),
  ]) {
    const changed = structuredClone({ progress, target, result: structuredClone(target) })
    mutate(changed)
    assert.throws(
      () =>
        assertProblemGroundingExactSet(
          expectedProblemIDs,
          changed.progress,
          changed.target,
          changed.result,
        ),
      /PROBLEM_GROUNDING/u,
    )
  }

  const source = await readFile(SCRIPT_PATH, 'utf8')
  const assertion = source.slice(
    source.indexOf('export function assertProblemGroundingExactSet'),
    source.indexOf('export async function resolveGroundingForClosure'),
  )
  assert.doesNotMatch(assertion, /question|content|student_answer|\[index\]/iu)
  const observer = source.slice(
    source.indexOf('async function observeCompletedGrading'),
    source.indexOf('async function uploadHomeworkAsset'),
  )
  assert.match(observer, /target\.progressive\.problem_progress/u)
})

test('restart grounding observation is persisted-only and never invokes public search', async () => {
  const { resolveGroundingForClosure } = await modulePromise
  const persisted = [{ binding_id: 'binding-1', chunk_id: 'chunk-1' }]
  let searches = 0
  const result = await resolveGroundingForClosure('restart', persisted, async () => {
    searches += 1
    return []
  })
  assert.deepEqual(result, persisted)
  assert.equal(searches, 0)

  const source = await readFile(SCRIPT_PATH, 'utf8')
  const restart = source.slice(
    source.indexOf('async function restartPhase'),
    source.indexOf('async function statusPhase'),
  )
  assert.match(restart, /groundingMode:\s*'restart'/u)
  assert.doesNotMatch(restart, /['"]POST['"]|independentlyObserveGrounding/u)
})

test('contract validator freezes phase policy, public APIs, receipt fields and restart exact-set', async () => {
  const { validateContract } = await modulePromise
  const contract = JSON.parse(await readFile(CONTRACT_PATH, 'utf8'))
  validateContract(contract)
  assert.equal(new Set(contract.restart_exact_set).size, contract.restart_exact_set.length)

  for (const mutate of [
    (copy) => {
      copy.phase_timeout.hard_max_ms = 30 * 60_000
    },
    (copy) => {
      copy.public_api.search = '/wrong'
    },
    (copy) => {
      copy.required_receipts.ocr = copy.required_receipts.ocr.filter((field) => field !== 'fake')
    },
    (copy) => {
      copy.required_receipts.problem_grounding = copy.required_receipts.problem_grounding.filter(
        (field) => field !== 'problem_id',
      )
    },
    (copy) => {
      copy.required_receipts.active_revision = copy.required_receipts.active_revision.filter(
        (field) => field !== 'profile_config_hash',
      )
    },
    (copy) => {
      copy.restart_exact_set = copy.restart_exact_set.slice(1)
    },
  ]) {
    const changed = structuredClone(contract)
    mutate(changed)
    assert.throws(() => validateContract(changed), /CONTRACT_INVALID/u)
  }
})

test('grounding receipt exact-set matches public search and rejects every lineage drift', async () => {
  const { assertGroundingExactSet } = await modulePromise
  const base = {
    textbook_binding_id: 'binding-1',
    textbook_manifest_id: 'manifest-1',
    document_id: 'doc-1',
    document_generation: 3,
    vector_revision_id: 'revision-1',
    query_digest: `sha256:${'1'.repeat(64)}`,
    chunk_id: 'chunk-1',
    logical_page: 49,
    pdf_page: 54,
    source_digest: '2'.repeat(64),
    citation_digest: '3'.repeat(64),
  }
  const search = {
    binding_id: base.textbook_binding_id,
    manifest_id: base.textbook_manifest_id,
    logical_page: base.logical_page,
    pdf_page: base.pdf_page,
    query_receipt: {
      operation: 'query_embedding',
      status: 'succeeded',
      revision_id: base.vector_revision_id,
      query_digest: base.query_digest,
      provider_id: 'embedding-real',
      model: 'embedding-real-model',
      profile_id: 'profile-1',
      profile_config_hash: '4'.repeat(64),
      dimension: 1024,
    },
    hit: {
      doc_id: base.document_id,
      document_generation: base.document_generation,
      revision_id: base.vector_revision_id,
      chunk_id: base.chunk_id,
      page_start: base.pdf_page,
      page_end: base.pdf_page,
      source_digest: base.source_digest,
      citation_digest: base.citation_digest,
    },
  }

  const canonical = assertGroundingExactSet([base], [search])
  assert.equal(canonical.length, 1)
  for (const [field, value] of [
    ['manifest_id', 'manifest-2'],
    ['binding_id', 'binding-2'],
    ['document_generation', 4],
    ['revision_id', 'revision-2'],
    ['chunk_id', 'chunk-2'],
    ['page_start', 55],
    ['source_digest', '5'.repeat(64)],
    ['citation_digest', '6'.repeat(64)],
  ]) {
    const drifted = structuredClone(search)
    if (field === 'manifest_id' || field === 'binding_id') drifted[field] = value
    else drifted.hit[field] = value
    assert.throws(() => assertGroundingExactSet([base], [drifted]), /GROUNDING_EXACT_SET/u)
  }
})

test('restart receipt requires the entire grounding and OCR exact-set to remain unchanged', async () => {
  const { assertRestartInvariant } = await modulePromise
  const before = {
    documents: [{ document_id: 'doc-1', generation: 1, source_digest: 'a'.repeat(64) }],
    ingest_jobs: [{ job_id: 'ingest-1', state: 'succeeded' }],
    vector_jobs: [{ job_id: 'vector-1', state: 'succeeded' }],
    active_revision: [{ revision_id: 'revision-1', chunks_done: 2, chunks_total: 2 }],
    ocr_receipts: [{ page: 5, content_digest: 'b'.repeat(64) }],
    textbook_bindings: [{ id: 'binding-1', manifest_id: 'manifest-1' }],
    curriculum_progress: [{ revision: 1, textbook_binding_id: 'binding-1' }],
    final_artifact: { id: 'artifact-1', digest: 'c'.repeat(64) },
    operation_receipts: [{ invocation_id_sha256: 'd'.repeat(64) }],
    grounding_evidence_receipts: [{ key: 'manifest/doc/1/revision/54/chunk/source/citation' }],
    problem_grounding_receipts: [
      { problem_id: 'problem-1', operation: 'solve', identity_digest: 'e'.repeat(64) },
    ],
  }
  const contract = JSON.parse(await readFile(CONTRACT_PATH, 'utf8'))
  assert.deepEqual(Object.keys(before), contract.restart_exact_set)
  assert.deepEqual(assertRestartInvariant(before, structuredClone(before)), before)
  const drifted = structuredClone(before)
  drifted.problem_grounding_receipts[0].identity_digest = 'drift'
  assert.throws(() => assertRestartInvariant(before, drifted), /RESTART_EXACT_SET/u)
})

test('target artifact binds result grounding projection to the exact page-summary invocation', async () => {
  const { assertArtifactReceiptBinding } = await modulePromise
  const artifact = {
    artifact_id: 'artifact-1',
    agent_name: 'agent-1',
    job_id: 'job-1',
    structure_version: 1,
    coverage_status: 'complete',
    total_count: 1,
    published_count: 1,
    skipped_count: 0,
    artifact_digest: 'a'.repeat(64),
    summary_invocation_id: 'summary-1',
  }
  const receipt = {
    invocation_id: 'summary-1',
    operation: 'projecting',
    provider: 'hexclaw-gpt',
    model: 'gpt-5.6-sol',
    status: 'succeeded',
    result_digest: `sha256:${'b'.repeat(64)}`,
  }
  const bound = assertArtifactReceiptBinding(artifact, 'agent-1', [receipt])
  assert.equal(bound.artifact.summary_invocation_id, 'summary-1')
  assert.equal(bound.summary_receipt.invocation_id, 'summary-1')
  assert.throws(
    () =>
      assertArtifactReceiptBinding(artifact, 'agent-1', [
        { ...receipt, invocation_id: 'summary-2' },
      ]),
    /FINAL_ARTIFACT_SUMMARY_RECEIPT/u,
  )
  assert.throws(
    () => assertArtifactReceiptBinding(artifact, 'agent-1', [receipt, receipt]),
    /FINAL_ARTIFACT_SUMMARY_RECEIPT/u,
  )
})

test('homework dispatch digest uses the canonical framed image bytes, not the bare file digest', async () => {
  const { imageTaskSourceDigest } = await modulePromise
  const image = Buffer.from('homework-image', 'utf8')
  const length = Buffer.alloc(8)
  length.writeBigUInt64BE(BigInt(image.length))
  const expected = `sha256:${createHash('sha256').update(length).update(image).digest('hex')}`
  const bare = `sha256:${createHash('sha256').update(image).digest('hex')}`
  assert.equal(imageTaskSourceDigest([image]), expected)
  assert.notEqual(expected, bare)
})

test('final operation receipt projection permits terminal retry history but rejects in-flight rows', async () => {
  const { projectImageTaskReceipts } = await modulePromise
  const base = {
    invocation_id: 'invocation-1',
    operation: 'recognizing',
    provider: 'hexclaw-gpt',
    model: 'gpt-5.6-sol',
  }
  const projected = projectImageTaskReceipts({
    operation_receipts: [
      { ...base, status: 'failed', result_digest: '' },
      {
        ...base,
        invocation_id: 'invocation-2',
        status: 'succeeded',
        result_digest: `sha256:${'a'.repeat(64)}`,
      },
    ],
  })
  assert.deepEqual(projected.map((receipt) => receipt.status).sort(), ['failed', 'succeeded'])
  assert.throws(
    () => projectImageTaskReceipts({ operation_receipts: [{ ...base, status: 'prepared' }] }),
    /IMAGE_TASK_OPERATION_RECEIPT_INVALID/u,
  )
  assert.throws(
    () => projectImageTaskReceipts({ operation_receipts: [{ ...base, status: 'succeeded' }] }),
    /IMAGE_TASK_OPERATION_RECEIPT_INVALID/u,
  )
})

test('harness source cannot seed/query SQLite or reuse the legacy source-sol harness', async () => {
  const source = await readFile(SCRIPT_PATH, 'utf8')
  assert.doesNotMatch(source, /sqlite3|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM/iu)
  assert.doesNotMatch(source, /k12-source-sol-headless/u)
  assert.match(source, /\/api\/v1\/knowledge\/documents/u)
  assert.match(source, /\/api\/v1\/knowledge\/search/u)
  assert.match(source, /\/api\/k12\/profile-bundle/u)
  assert.match(source, /\/api\/k12\/image-tasks/u)
})

test('evidence persistence archives only the supplied redacted receipt, never run config or state', async () => {
  const { persistPhaseEvidence, prepareRunDirectory } = await modulePromise
  const parent = await mkdtemp(join(tmpdir(), 'hexclaw-textbook-evidence-'))
  const runRoot = join(parent, 'run')
  try {
    await prepareRunDirectory(runRoot)
    await writeFile(join(runRoot, 'state.json'), '{"secret":"state-secret"}\n', { mode: 0o600 })
    await writeFile(join(runRoot, '.hexclaw', 'hexclaw.yaml'), 'config-secret\n', {
      mode: 0o600,
    })
    const receipt = {
      status: 'pending',
      phase: 'prepare',
      error_code: 'PHASE_WALL_CLOCK_PENDING',
      hard_timeout_ms: 1_740_000,
      automatic_continuation: false,
    }
    assert.equal(await persistPhaseEvidence({ runRoot }, receipt), 'prepare.json')
    const archived = await readFile(join(runRoot, 'evidence', 'prepare.json'), 'utf8')
    assert.deepEqual(JSON.parse(archived), receipt)
    assert.doesNotMatch(archived, /state-secret|config-secret/u)

    const source = await readFile(SCRIPT_PATH, 'utf8')
    const persistence = source.slice(
      source.indexOf('export async function persistPhaseEvidence'),
      source.indexOf('async function dispatchPhase'),
    )
    assert.match(persistence, /assertEvidenceSafe\(receipt\)/u)
    assert.match(persistence, /writePrivateJSON\([^\n]+receipt\)/u)
    assert.doesNotMatch(
      persistence,
      /readFile|copyFile|state\.json|hexclaw\.yaml|runtime\.config|runtime\.store/u,
    )
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})
