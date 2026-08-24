import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const LIVE_ROOT = dirname(fileURLToPath(import.meta.url))
const CONTRACT_PATH = resolve(LIVE_ROOT, 'k12-practice-oneclick-installed.contract.json')
const modulePromise = import('./k12-practice-oneclick-installed.mjs')

test('公开 API-only 装机验证只有 validate/run 两个短阶段', async () => {
  const { PHASES, phaseBudgetMilliseconds, resolvePhase } = await modulePromise
  assert.deepEqual(PHASES, ['validate', 'run'])
  assert.equal(resolvePhase([]), 'validate')
  assert.equal(resolvePhase(['validate']), 'validate')
  assert.equal(resolvePhase(['run']), 'run')
  assert.throws(() => resolvePhase(['prepare']), /INVALID_PHASE/u)
  assert.throws(() => resolvePhase(['run', 'status']), /INVALID_PHASE/u)
  assert.ok(phaseBudgetMilliseconds({}) > 0)
  assert.ok(phaseBudgetMilliseconds({}) < 29 * 60_000)
  assert.equal(
    phaseBudgetMilliseconds({ HEXCLAW_PRACTICE_ONECLICK_PHASE_TIMEOUT_MS: '1800000' }),
    29 * 60_000 - 1,
  )
})

test('合同冻结公开 API、失败终态、唯一 generation/item 与重启只读恢复', async () => {
  const { validateContract } = await modulePromise
  const contract = JSON.parse(await readFile(CONTRACT_PATH, 'utf8'))
  const projection = validateContract(contract)

  assert.equal(projection.schema_version, 1)
  assert.deepEqual(projection.transport, {
    candidate: 'installed_app_sidecar',
    product_operations: 'hexclaw_public_http_api_only',
    direct_store_read: false,
    sqlite_seed_or_write: false,
    ui_automation: false,
    real_model: false,
    controlled_loopback_provider: true,
  })
  assert.deepEqual(projection.phases, ['validate', 'run'])
  assert.deepEqual(projection.state_machine, {
    initial: 'available',
    admitted: 'pending',
    terminals: ['joined', 'failed'],
    exercised_terminal: 'failed',
  })
  assert.deepEqual(projection.accumulation_state_machine, {
    admitted: 'queued',
    terminals: ['committed', 'failed'],
    exercised_terminal: 'committed',
  })
  assert.deepEqual(projection.identity, {
    generation_field: 'generation_job_id',
    item_field: 'practice_item_id',
    one_generation_per_source_version: true,
    one_item_identity_per_generation: true,
    repeat_action_reuses_identity: true,
    restart_get_only: true,
  })
  assert.deepEqual(projection.candidate_selection, {
    endpoint_calls: 0,
    response_fields: 0,
    second_commit_action: false,
  })
  assert.deepEqual(projection.controlled_provider, {
    protocol: 'openai_compatible_loopback',
    model: 'fixture-practice-failure',
    classification_response_status: 200,
    generation_response_status: 503,
    maximum_operation_requests: 2,
    external_network: false,
  })
  assert.deepEqual(projection.validate_side_effects, {
    sidecar_starts: 0,
    provider_requests: 0,
    product_mutations: 0,
  })
})

test('合同拒绝 SQLite PASS、候选选择、重启 POST 与真实模型漂移', async () => {
  const { validateContract } = await modulePromise
  const baseline = JSON.parse(await readFile(CONTRACT_PATH, 'utf8'))

  for (const mutate of [
    (value) => {
      value.transport.direct_store_read = true
    },
    (value) => {
      value.candidate_selection.endpoint_calls = 1
    },
    (value) => {
      value.identity.restart_get_only = false
    },
    (value) => {
      value.transport.real_model = true
    },
  ]) {
    const changed = structuredClone(baseline)
    mutate(changed)
    assert.throws(() => validateContract(changed), /CONTRACT_INVALID/u)
  }
})

test('公开投影断言拒绝候选字段、身份漂移、重复 item 与重启 POST', async () => {
  const { assertAccumulationProjection, assertPracticeProjection, assertRunEvidence } =
    await modulePromise
  const pending = {
    state: 'pending',
    source_mistake_id: 'mistake-1',
    generation_job_id: 'generation-1',
    practice_item_id: 'item-1',
    source_mistake_summary: '36÷0.6=?',
  }
  const failed = {
    ...pending,
    state: 'failed',
    failure_reason: 'controlled provider failure',
  }
  assert.deepEqual(assertPracticeProjection(pending, 'pending'), {
    state: 'pending',
    source_id: 'mistake-1',
    generation_id: 'generation-1',
    item_ids: ['item-1'],
  })
  assert.deepEqual(assertPracticeProjection(failed, 'failed'), {
    state: 'failed',
    source_id: 'mistake-1',
    generation_id: 'generation-1',
    item_ids: ['item-1'],
  })
  assert.throws(
    () => assertPracticeProjection({ ...pending, selection_id: 'selection-1' }, 'pending'),
    /CANDIDATE_SELECTION_SURFACED/u,
  )

  const queuedDictation = {
    generation_id: 'dictation-generation-1',
    status: 'queued',
    attempt: 1,
    updated_at: 10,
  }
  const committedDictation = {
    ...queuedDictation,
    status: 'committed',
    practice_item_id: 'dictation-item-1',
    updated_at: 11,
  }
  assert.deepEqual(assertAccumulationProjection(queuedDictation, 'queued'), {
    state: 'queued',
    generation_id: 'dictation-generation-1',
    item_ids: [],
  })
  assert.deepEqual(assertAccumulationProjection(committedDictation, 'committed'), {
    state: 'committed',
    generation_id: 'dictation-generation-1',
    item_ids: ['dictation-item-1'],
  })
  assert.throws(
    () =>
      assertAccumulationProjection(
        { ...queuedDictation, practice_item_id: 'dictation-item-1' },
        'queued',
      ),
    /ACCUMULATION_PRECOMMIT_ITEM_LEAKED/u,
  )

  const evidence = {
    schema_version: 1,
    status: 'passed',
    boundary: {
      candidate: 'installed_app_sidecar',
      direct_store_read: false,
      sqlite_seed_or_write: false,
      real_model: false,
    },
    first_process: {
      mistake: {
        initial: { state: 'available', source_id: 'mistake-1', generation_id: '', item_ids: [] },
        admitted: assertPracticeProjection(pending, 'pending'),
        terminal: assertPracticeProjection(failed, 'failed'),
        repeated: assertPracticeProjection(failed, 'failed'),
        provider_request_count: 1,
        practice_item_exact_set_sha256: '1'.repeat(64),
      },
      accumulation: {
        admitted: assertAccumulationProjection(queuedDictation, 'queued'),
        terminal: assertAccumulationProjection(committedDictation, 'committed'),
        repeated: assertAccumulationProjection(committedDictation, 'committed'),
        classification_provider_request_count: 0,
        practice_item_exact_set_sha256: '2'.repeat(64),
        basket_item_count: 1,
      },
      candidate_endpoint_calls: 0,
    },
    restart: {
      product_post_count: 0,
      mistake: {
        recovered: assertPracticeProjection(failed, 'failed'),
        practice_item_exact_set_sha256: '1'.repeat(64),
      },
      accumulation: {
        recovered: assertAccumulationProjection(committedDictation, 'committed'),
        practice_item_exact_set_sha256: '2'.repeat(64),
        basket_item_count: 1,
      },
    },
  }
  assert.equal(assertRunEvidence(evidence).status, 'passed')
  assert.throws(
    () =>
      assertRunEvidence({
        ...evidence,
        restart: { ...evidence.restart, product_post_count: 1 },
      }),
    /RESTART_NOT_GET_ONLY/u,
  )
  assert.throws(
    () =>
      assertRunEvidence({
        ...evidence,
        restart: {
          ...evidence.restart,
          mistake: {
            ...evidence.restart.mistake,
            recovered: { ...evidence.restart.mistake.recovered, item_ids: ['item-2'] },
          },
        },
      }),
    /RESTART_IDENTITY_DRIFT/u,
  )
})
