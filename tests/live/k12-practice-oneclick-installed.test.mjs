import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const LIVE_ROOT = dirname(fileURLToPath(import.meta.url))
const CONTRACT_PATH = resolve(LIVE_ROOT, 'k12-practice-oneclick-installed.contract.json')
const modulePromise = import('./k12-practice-oneclick-installed.mjs')

test('公开 API-only 装机验证只有 validate/run 两个短阶段', async () => {
  const {
    PHASES,
    phaseBudgetMilliseconds,
    realGenerationTerminalBudgetMilliseconds,
    resolvePhase,
  } = await modulePromise
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
  const now = 1_000_000
  assert.equal(realGenerationTerminalBudgetMilliseconds(now + 15 * 60_000, now), 15 * 60_000)
  assert.equal(realGenerationTerminalBudgetMilliseconds(now + 60_000, now), 60_000)
})

test('真实生成在一次 POST 后只等待 pending，所有公开非 pending 状态立即收敛', async () => {
  const { classifyRealGenerationObservation } = await modulePromise
  assert.deepEqual(classifyRealGenerationObservation({ state: 'pending' }), {
    state: 'pending',
    settled: false,
    succeeded: false,
  })
  for (const state of ['joined', 'failed', 're_add', 'hidden', 'available']) {
    assert.deepEqual(classifyRealGenerationObservation({ state }), {
      state,
      settled: true,
      succeeded: state === 'joined',
    })
  }
  assert.throws(
    () => classifyRealGenerationObservation({ state: 'generating' }),
    /REAL_GENERATION_STATE_INVALID/u,
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
  assert.equal(
    projection.public_api.practice_receipts,
    '/api/k12/mistakes/{record_id}/practice-generation/receipts',
  )
  assert.deepEqual(projection.real_default_profile, {
    mode_env: 'HEXCLAW_PRACTICE_ONECLICK_REAL_DEFAULT_PROFILE',
    authorization_env: 'HEXCLAW_PRACTICE_ONECLICK_DEFAULT_PROFILE_AUTHORIZED',
    app_bundle: '/Applications/HexClaw.app',
    config: '${user_home}/.hexclaw/hexclaw.yaml',
    port: 16060,
    provider: 'hexclaw-gpt',
    model: 'gpt-5.6-sol',
    fallback_allowed: false,
    im_enabled: false,
    source_fixture: 'unique_public_api_mistake',
    generation_post_count: 1,
    terminal_budget: 'remaining_phase_budget',
    poll_continuation_states: ['pending'],
    poll_settled_states: ['joined', 'failed', 're_add', 'hidden', 'available'],
    receipt_stages: ['practice_generate', 'practice_validate'],
    failure_evidence_before_cleanup: ['last_projection', 'receipts'],
    restart_methods: ['GET'],
    cleanup_methods: ['DELETE'],
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

test('真实默认 profile 模式保持 HOME、关闭全部 IM，并绑定实际 App 与配置', async () => {
  const {
    EXECUTION_MODES,
    realDefaultProfileEnvironment,
    resolveExecutionMode,
    resolveRealDefaultProfileInputs,
  } = await modulePromise
  assert.deepEqual(EXECUTION_MODES, ['controlled', 'real_default_profile'])
  assert.equal(resolveExecutionMode({}), 'controlled')
  assert.equal(
    resolveExecutionMode({ HEXCLAW_PRACTICE_ONECLICK_REAL_DEFAULT_PROFILE: '1' }),
    'real_default_profile',
  )

  const profile = resolveRealDefaultProfileInputs(
    {
      HEXCLAW_PRACTICE_ONECLICK_REAL_DEFAULT_PROFILE: '1',
      HEXCLAW_PRACTICE_ONECLICK_DEFAULT_PROFILE_AUTHORIZED: '1',
      HEXCLAW_PRACTICE_ONECLICK_ACTUAL_CONFIG: '/Users/tester/.hexclaw/hexclaw.yaml',
      HEXCLAW_PRACTICE_ONECLICK_EXPECTED_SIDECAR_SHA256: 'a'.repeat(64),
    },
    '/Users/tester',
  )
  assert.deepEqual(profile, {
    app_bundle: '/Applications/HexClaw.app',
    sidecar: '/Applications/HexClaw.app/Contents/MacOS/hexclaw',
    config: '/Users/tester/.hexclaw/hexclaw.yaml',
    expected_sidecar_sha256: 'a'.repeat(64),
    origin: 'http://127.0.0.1:16060',
  })
  assert.throws(
    () =>
      resolveRealDefaultProfileInputs(
        {
          HEXCLAW_PRACTICE_ONECLICK_REAL_DEFAULT_PROFILE: '1',
          HEXCLAW_PRACTICE_ONECLICK_DEFAULT_PROFILE_AUTHORIZED: '1',
          HEXCLAW_PRACTICE_ONECLICK_ACTUAL_CONFIG: '/tmp/copied/hexclaw.yaml',
          HEXCLAW_PRACTICE_ONECLICK_EXPECTED_SIDECAR_SHA256: 'a'.repeat(64),
        },
        '/Users/tester',
      ),
    /ACTUAL_DEFAULT_CONFIG_REQUIRED/u,
  )

  const inherited = {
    HOME: '/Users/tester',
    PATH: '/usr/bin:/bin',
    CUSTOM_UNRELATED_VALUE: 'preserved',
  }
  const runtimeEnvironment = realDefaultProfileEnvironment(inherited, 'capability-token')
  assert.equal(runtimeEnvironment.HOME, inherited.HOME)
  assert.equal(runtimeEnvironment.CUSTOM_UNRELATED_VALUE, 'preserved')
  assert.equal(runtimeEnvironment.HEXCLAW_DISABLE_IM, 'all')
  assert.equal(runtimeEnvironment.DINGTALK_LIVE_SEND, '0')
  assert.equal(runtimeEnvironment.HEXCLAW_SIDECAR_CAPABILITY_TOKEN, 'capability-token')
})

test('真实路由预检允许 Provider 默认模型不同，但要求可信的精确 Sol 文本与 low reasoning 声明', async () => {
  const { assertRealLLMProjection } = await modulePromise
  const projection = {
    default: 'ollama',
    providers: {
      'hexclaw-gpt': {
        enabled: true,
        credential_present: true,
        model: 'gpt-5.6-terra',
        models: ['gpt-5.6-terra', 'gpt-5.6-sol'],
        model_specs_mode: 'explicit',
        model_specs: [
          {
            id: 'gpt-5.6-sol',
            capabilities: ['text'],
            reasoning_support: 'supported',
            reasoning_control: {
              dialect: 'reasoning_effort',
              on: 'low',
              off: 'none',
              allowed_efforts: ['low'],
            },
          },
        ],
      },
    },
  }
  assert.deepEqual(assertRealLLMProjection(projection), {
    provider: 'hexclaw-gpt',
    model: 'gpt-5.6-sol',
    provider_default_affects_fixed_route: false,
    text_capability: true,
    reasoning: {
      support: 'supported',
      dialect: 'reasoning_effort',
      low_available: true,
    },
    credential_present: true,
    fallback_allowed: false,
  })

  const mutations = [
    (value) => delete value.providers['hexclaw-gpt'],
    (value) => (value.providers['hexclaw-gpt'].enabled = false),
    (value) => delete value.providers['hexclaw-gpt'].credential_present,
    (value) => (value.providers['hexclaw-gpt'].credential_present = false),
    (value) => (value.providers['hexclaw-gpt'].models = ['gpt-5.6-terra']),
    (value) => (value.providers['hexclaw-gpt'].model_specs_mode = 'legacy'),
    (value) => delete value.providers['hexclaw-gpt'].model_specs,
    (value) => (value.providers['hexclaw-gpt'].model_specs = []),
    (value) => delete value.providers['hexclaw-gpt'].model_specs[0].capabilities,
    (value) => (value.providers['hexclaw-gpt'].model_specs[0].capabilities = ['vision']),
    (value) => (value.providers['hexclaw-gpt'].model_specs[0].reasoning_support = 'unknown'),
    (value) => (value.providers['hexclaw-gpt'].model_specs[0].reasoning_control.on = 'high'),
    (value) =>
      (value.providers['hexclaw-gpt'].model_specs[0].reasoning_control.allowed_efforts = [
        'low',
        'medium',
      ]),
    (value) =>
      value.providers['hexclaw-gpt'].model_specs.push(
        structuredClone(value.providers['hexclaw-gpt'].model_specs[0]),
      ),
  ]
  for (const mutate of mutations) {
    const changed = structuredClone(projection)
    mutate(changed)
    assert.throws(() => assertRealLLMProjection(changed), /REAL_LLM_ROUTE_INVALID/u)
  }
})

test('自动化门禁只隔离本次 owned fixture，不阻断或修改用户既有 cron', async () => {
  const { projectOwnedAutomationIsolation } = await modulePromise
  const ownership = {
    agent_name: 'hc-k12-practice-owned',
    source_session: 'practice-real-owned-session',
    mistake_id: 'mistake-owned-record',
    marker: 'PRACTICE-owned-marker',
  }
  assert.deepEqual(
    projectOwnedAutomationIsolation(
      {
        jobs: [
          {
            id: 'user-cron-1',
            status: 'active',
            agent_name: 'user-existing-agent',
            prompt: '用户自己的每日学习总结',
          },
          {
            id: 'user-cron-2',
            status: 'paused',
            payload: { session_id: 'user-existing-session' },
          },
        ],
      },
      ownership,
    ),
    {
      listed_count: 2,
      active_unrelated_count: 1,
      owned_match_count: 0,
      scope: 'owned_fixture_only',
    },
  )

  for (const ownedJob of [
    { id: 'owned-agent', status: 'active', agent_name: ownership.agent_name },
    { id: 'owned-session', status: 'paused', payload: { session: ownership.source_session } },
    { id: 'owned-record', status: 'active', record_id: ownership.mistake_id },
    { id: 'owned-marker', status: 'active', command_json: `{"marker":"${ownership.marker}"}` },
  ]) {
    assert.throws(
      () => projectOwnedAutomationIsolation({ jobs: [ownedJob] }, ownership),
      /REAL_OWNED_AUTOMATION_PRESENT/u,
    )
  }
})

test('真实 Sol 脱敏回执只接受 practice_generate/practice_validate 各一次且零 fallback', async () => {
  const { assertRealPracticeReceipts } = await modulePromise
  const receipt = {
    schema_version: 1,
    source_kind: 'mistake',
    generation_job_id_digest: `sha256:${'1'.repeat(64)}`,
    generation_status: 'committed',
    receipt_exact_set_digest: `sha256:${'2'.repeat(64)}`,
    receipts: [
      {
        stage: 'practice_generate',
        attempt: 1,
        status: 'succeeded',
        provider: 'hexclaw-gpt',
        model: 'gpt-5.6-sol',
        route: 'hexclaw-gpt/gpt-5.6-sol',
        provider_instance_id_digest: `sha256:${'3'.repeat(64)}`,
        config_fingerprint: 'config-fingerprint',
        capability_receipt_digest: 'capability-receipt',
        probe_policy_version: 'probe-v1',
        request_digest: 'request-generate',
        result_digest: 'result-generate',
        created_at: 10,
        updated_at: 11,
        receipt_digest: `sha256:${'4'.repeat(64)}`,
      },
      {
        stage: 'practice_validate',
        attempt: 1,
        status: 'succeeded',
        provider: 'hexclaw-gpt',
        model: 'gpt-5.6-sol',
        route: 'hexclaw-gpt/gpt-5.6-sol',
        provider_instance_id_digest: `sha256:${'5'.repeat(64)}`,
        config_fingerprint: 'config-fingerprint',
        capability_receipt_digest: 'capability-receipt',
        probe_policy_version: 'probe-v1',
        request_digest: 'request-validate',
        result_digest: 'result-validate',
        created_at: 12,
        updated_at: 13,
        receipt_digest: `sha256:${'6'.repeat(64)}`,
      },
    ],
  }
  const projection = assertRealPracticeReceipts(receipt)
  assert.equal(projection.generation_job_id_digest, `sha256:${'1'.repeat(64)}`)
  assert.equal(projection.generation_status, 'committed')
  assert.equal(projection.receipt_exact_set_digest, `sha256:${'2'.repeat(64)}`)
  assert.deepEqual(projection.stages, ['practice_generate', 'practice_validate'])
  assert.equal(projection.physical_provider_call_count, 2)
  assert.equal(projection.fallback_provider_call_count, 0)
  assert.match(projection.canonical_sha256, /^[a-f0-9]{64}$/u)

  const fallback = structuredClone(receipt)
  fallback.receipts[1].provider = 'other-provider'
  fallback.receipts[1].route = 'other-provider/other-model'
  assert.throws(() => assertRealPracticeReceipts(fallback), /REAL_RECEIPT_ROUTE_INVALID/u)
  const duplicated = structuredClone(receipt)
  duplicated.receipts[1].stage = 'practice_generate'
  assert.throws(() => assertRealPracticeReceipts(duplicated), /REAL_RECEIPT_STAGE_SET_INVALID/u)
})

test('真实失败归档只保留最后公开投影与回执的脱敏摘要', async () => {
  const { projectRealFailurePublicEvidence } = await modulePromise
  const ownership = {
    agent_name: 'hc-k12-practice-owned',
    source_session: 'practice-real-owned-session',
    mistake_id: 'mistake-owned-record',
    marker: 'PRACTICE-owned-marker',
  }
  const evidence = projectRealFailurePublicEvidence(
    {
      http_status: 200,
      value: {
        state: 'pending',
        source_mistake_id: ownership.mistake_id,
        generation_job_id: 'generation-secret-id',
        failure_reason: 'provider secret failure detail',
      },
    },
    {
      http_status: 200,
      value: {
        schema_version: 1,
        source_kind: 'mistake',
        generation_job_id_digest: `sha256:${'1'.repeat(64)}`,
        generation_status: 'generating',
        receipt_exact_set_digest: `sha256:${'2'.repeat(64)}`,
        receipts: [
          {
            stage: 'practice_generate',
            attempt: 1,
            status: 'succeeded',
            provider: 'hexclaw-gpt',
            model: 'gpt-5.6-sol',
            route: 'hexclaw-gpt/gpt-5.6-sol',
            failure_kind: '',
            receipt_digest: `sha256:${'3'.repeat(64)}`,
            external_request_id_digest: `sha256:${'4'.repeat(64)}`,
          },
        ],
      },
    },
    ownership,
  )
  assert.equal(evidence.last_projection.state, 'pending')
  assert.equal(evidence.receipts.generation_status, 'generating')
  assert.equal(evidence.receipts.receipt_count, 1)
  assert.deepEqual(evidence.receipts.exact_set, [
    {
      stage: 'practice_generate',
      attempt: 1,
      status: 'succeeded',
      provider: 'hexclaw-gpt',
      model: 'gpt-5.6-sol',
      route: 'hexclaw-gpt/gpt-5.6-sol',
      failure_kind: '',
      receipt_digest: `sha256:${'3'.repeat(64)}`,
    },
  ])
  const serialized = JSON.stringify(evidence)
  for (const secret of [
    ownership.agent_name,
    ownership.source_session,
    ownership.mistake_id,
    ownership.marker,
    'generation-secret-id',
    'provider secret failure detail',
    `sha256:${'4'.repeat(64)}`,
  ]) {
    assert.equal(serialized.includes(secret), false)
  }
  assert.match(evidence.owned_fixture.agent_name_sha256, /^[a-f0-9]{64}$/u)
  assert.match(evidence.last_projection.canonical_sha256, /^[a-f0-9]{64}$/u)
  assert.match(evidence.receipts.canonical_sha256, /^[a-f0-9]{64}$/u)
})

test('真实一键练习证据要求一次 POST、重启 GET-only、三类深等和公开清理', async () => {
  const { assertRealRunEvidence } = await modulePromise
  const receipt = {
    generation_job_id_digest: `sha256:${'1'.repeat(64)}`,
    generation_status: 'committed',
    receipt_exact_set_digest: `sha256:${'2'.repeat(64)}`,
    stages: ['practice_generate', 'practice_validate'],
    physical_provider_call_count: 2,
    fallback_provider_call_count: 0,
    canonical_sha256: '3'.repeat(64),
  }
  const projection = {
    state: 'joined',
    source_id_sha256: '4'.repeat(64),
    generation_id_sha256: '5'.repeat(64),
    practice_set_id_sha256: '6'.repeat(64),
    item_id_sha256: '7'.repeat(64),
    canonical_sha256: '8'.repeat(64),
    item_canonical_sha256: '9'.repeat(64),
  }
  const exactSet = {
    count: 1,
    item_ids_sha256: 'a'.repeat(64),
    canonical_sha256: 'b'.repeat(64),
  }
  const evidence = {
    schema_version: 1,
    status: 'passed',
    mode: 'real_default_profile',
    candidate: {
      sidecar_sha256: 'd'.repeat(64),
      config_sha256: 'e'.repeat(64),
    },
    boundary: {
      candidate: 'installed_app_sidecar',
      default_profile: true,
      home_modified: false,
      config_copied: false,
      public_api_only: true,
      direct_store_read: false,
      sqlite_seed_or_write: false,
      im_enabled: false,
      im_calls: 0,
    },
    route: {
      provider: 'hexclaw-gpt',
      model: 'gpt-5.6-sol',
      fallback_allowed: false,
    },
    owned_fixture: {
      agent_name_sha256: 'f'.repeat(64),
      mistake_id_sha256: '0'.repeat(64),
      marker_sha256: '1'.repeat(64),
    },
    first_process: {
      generation_post_count: 1,
      projection,
      exact_set: exactSet,
      receipts: receipt,
    },
    restart: {
      product_post_count: 0,
      product_mutation_count: 0,
      physical_provider_call_count_delta: 0,
      projection,
      exact_set: exactSet,
      receipts: receipt,
    },
    cleanup: {
      mistake_deleted: true,
      agent_deleted: true,
      verified: true,
    },
  }
  assert.equal(assertRealRunEvidence(evidence).status, 'passed')
  assert.throws(
    () =>
      assertRealRunEvidence({
        ...evidence,
        restart: { ...evidence.restart, product_post_count: 1 },
      }),
    /REAL_RESTART_NOT_GET_ONLY/u,
  )
  assert.throws(
    () =>
      assertRealRunEvidence({
        ...evidence,
        restart: {
          ...evidence.restart,
          projection: { ...projection, item_canonical_sha256: 'c'.repeat(64) },
        },
      }),
    /REAL_RESTART_DEEP_EQUAL_FAILED/u,
  )
  assert.throws(
    () => assertRealRunEvidence({ ...evidence, candidate: {} }),
    /REAL_CANDIDATE_ATTESTATION_INVALID/u,
  )
})

test('真实 joined 投影与练习集按 generation 精确归属并输出稳定摘要', async () => {
  const { projectRealJoinedPractice, projectRealPracticeExactSet } = await modulePromise
  const item = {
    item_id: 'item-1',
    generation_job_id: 'generation-1',
    prompt: '计算 5/6 - 1/3。',
    answer: '1/2',
  }
  const joined = {
    state: 'joined',
    source_mistake_id: 'mistake-1',
    generation_job_id: 'generation-1',
    practice_set_id: 'set-1',
    practice_item_id: 'item-1',
    source_mistake_summary: '异分母分数减法',
    item,
  }
  const projected = projectRealJoinedPractice(joined)
  assert.equal(projected.evidence.state, 'joined')
  assert.match(projected.evidence.source_id_sha256, /^[a-f0-9]{64}$/u)
  assert.match(projected.evidence.generation_id_sha256, /^[a-f0-9]{64}$/u)
  assert.match(projected.evidence.practice_set_id_sha256, /^[a-f0-9]{64}$/u)
  assert.match(projected.evidence.item_id_sha256, /^[a-f0-9]{64}$/u)
  assert.match(projected.evidence.canonical_sha256, /^[a-f0-9]{64}$/u)
  assert.match(projected.evidence.item_canonical_sha256, /^[a-f0-9]{64}$/u)

  const exactSet = projectRealPracticeExactSet(
    {
      items: [
        {
          record_id: 'set-1',
          items: [item, { item_id: 'other', generation_job_id: 'generation-other' }],
        },
      ],
    },
    'generation-1',
  )
  assert.deepEqual(exactSet.identities, [{ set_id: 'set-1', item_id: 'item-1' }])
  assert.equal(exactSet.evidence.count, 1)
  assert.match(exactSet.evidence.item_ids_sha256, /^[a-f0-9]{64}$/u)
  assert.match(exactSet.evidence.canonical_sha256, /^[a-f0-9]{64}$/u)
  assert.throws(
    () =>
      projectRealPracticeExactSet(
        {
          items: [
            { record_id: 'set-1', items: [item] },
            { record_id: 'set-2', items: [item] },
          ],
        },
        'generation-1',
      ),
    /REAL_ITEM_EXACT_SET_INVALID/u,
  )
})

test('真实 joined 领域 item 与 practiceItemDTO 整体不同但身份和共同语义一致应通过', async () => {
  const {
    assertRealPracticeItemProjectionAgreement,
    projectRealJoinedPractice,
    projectRealPracticeExactSet,
  } = await modulePromise
  const domainItem = {
    item_id: 'item-1',
    source_problem_id: 'mistake-1',
    source_mistake_summary: '异分母分数加法',
    subject: '数学',
    added_via: 'single_variant',
    generation_status: 'ready',
    question_markdown: '计算 5/6 - 1/3。',
    expected_answer_markdown: '1/2',
    verification_status: 'verified',
    verification_evidence: 'independent_solver_match',
    generation_job_id: 'generation-1',
    variant_index: 1,
    requested_difficulty: 'same',
    actual_difficulty: 'same',
    normalized_content_hash: 'domain-only-hash',
  }
  const dtoItem = {
    item_id: 'item-1',
    source_problem_id: 'mistake-1',
    subject: '数学',
    added_via: 'single_variant',
    question_markdown: '计算 5/6 - 1/3。',
    expected_answer_markdown: '1/2',
    verification_status: 'verified',
    verification_evidence: 'independent_solver_match',
    generation_job_id: 'generation-1',
    variant_index: 1,
    requested_difficulty: 'same',
    actual_difficulty: 'same',
    return_ids: [],
  }
  const terminal = projectRealJoinedPractice({
    state: 'joined',
    source_mistake_id: 'mistake-1',
    generation_job_id: 'generation-1',
    practice_set_id: 'set-1',
    practice_item_id: 'item-1',
    item: domainItem,
  })
  const exactSet = projectRealPracticeExactSet(
    { items: [{ record_id: 'set-1', items: [dtoItem] }] },
    'generation-1',
  )
  assert.notDeepEqual(terminal.raw.item, exactSet.raw_items[0])
  assert.equal(assertRealPracticeItemProjectionAgreement(terminal, exactSet), true)

  const semanticDrift = projectRealPracticeExactSet(
    {
      items: [
        {
          record_id: 'set-1',
          items: [{ ...dtoItem, question_markdown: '不同题目' }],
        },
      ],
    },
    'generation-1',
  )
  assert.throws(
    () => assertRealPracticeItemProjectionAgreement(terminal, semanticDrift),
    /REAL_ITEM_PROJECTION_DRIFT/u,
  )
  const identityDrift = projectRealPracticeExactSet(
    { items: [{ record_id: 'set-other', items: [dtoItem] }] },
    'generation-1',
  )
  assert.throws(
    () => assertRealPracticeItemProjectionAgreement(terminal, identityDrift),
    /REAL_ITEM_PROJECTION_DRIFT/u,
  )
})

test('真实 runner 已接入实际执行分支且不包含直读存储或钉钉旁路', async () => {
  const source = await readFile(resolve(LIVE_ROOT, 'k12-practice-oneclick-installed.mjs'), 'utf8')
  assert.match(source, /async function runRealDefaultProfile/u)
  assert.match(source, /runRealDefaultProfile\(process\.env\)/u)
  assert.match(source, /HEXCLAW_DISABLE_IM:\s*'all'/u)
  assert.match(source, /practice-generation\/receipts/u)
  assert.match(source, /canonicalJSON\(terminal\.raw\) !== canonicalJSON\(first\.terminal\.raw\)/u)
  assert.match(
    source,
    /canonicalJSON\(exactSet\.raw_items\) !== canonicalJSON\(first\.exactSet\.raw_items\)/u,
  )
  assert.match(source, /canonicalJSON\(receiptsRaw\) !== canonicalJSON\(first\.receiptsRaw\)/u)
  const realRun = source.slice(
    source.indexOf('async function runRealDefaultProfile'),
    source.indexOf('async function main'),
  )
  assert.ok(realRun.indexOf('captureRealFailurePublicEvidence') >= 0)
  assert.ok(
    realRun.indexOf('captureRealFailurePublicEvidence') <
      realRun.lastIndexOf('cleanupRealOwnedObjects'),
  )
  assert.match(source, /JSON\.stringify\(failureOutput\(error\)\)/u)
  for (const forbidden of [
    /\bsqlite3\b/iu,
    /(?:spawn|execFile|exec)\s*\([^\n]*["']dws["']/u,
    /https?:\/\/[^\s"']*dingtalk/iu,
    /openapi\.dingtalk/iu,
  ]) {
    assert.equal(forbidden.test(source), false)
  }
})
