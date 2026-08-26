import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  PHASES,
  assertFinalArtifactProjection,
  assertFinalDeliveryExactSet,
  assertBoundInstancesProjection,
  assertLLMProjection,
  assertPublicSourceIdentity,
  assertRestartReplayInvariant,
  imageTaskSourceDigest,
  nextImageTaskCommand,
  planIsolatedAgent,
  projectTerminalImageTaskFailure,
  resolveLiveRuntime,
  validatePublicOutboundContract,
} from './k12-photo-grading-outbound-public-api.mjs'

const LIVE_ROOT = dirname(fileURLToPath(import.meta.url))
const CONTRACT_PATH = resolve(LIVE_ROOT, 'k12-photo-grading-outbound-public-api.contract.json')
const ORACLE_PATH = resolve(LIVE_ROOT, 'k12-dingtalk-photo-grading-headless.contract.json')
const HARNESS_PATH = resolve(LIVE_ROOT, 'k12-photo-grading-outbound-public-api.mjs')
const MARKDOWN = '## 作业批改\n\n请孩子先说清楚计算顺序。'
const ANNOTATED = Buffer.from('immutable-annotated-image')

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function target(instanceID = 'family-im', chatID = 'parent') {
  return { platform: 'dingtalk', instance_id: instanceID, chat_id: chatID }
}

function payloadJSON(kind) {
  const digest = kind === 'markdown' ? sha256(MARKDOWN) : sha256(ANNOTATED)
  return JSON.stringify({
    kind,
    ...(kind === 'artifact' ? { mime: 'image/png' } : {}),
    ordinal: kind === 'markdown' ? 1 : 2,
    digest: `sha256:${digest}`,
    ...(kind === 'markdown' ? { text: MARKDOWN } : {}),
    ...(kind === 'artifact'
      ? {
          attachment: {
            Name: '批注原图.png',
            MIME: 'image/png',
            Data: ANNOTATED.toString('base64'),
          },
        }
      : {}),
    message_content: { locale: 'zh-CN', markdown: MARKDOWN },
  })
}

function batch() {
  const finalDigest = '8'.repeat(64)
  const receipts = ['markdown', 'artifact'].map((kind, index) => ({
    delivery_id: `delivery-${index + 1}`,
    batch_id: 'batch-1',
    batch_ordinal: index + 1,
    part_kind: kind,
    part_mime: kind === 'artifact' ? 'image/png' : '',
    part_ordinal: index + 1,
    part_digest: `sha256:${kind === 'artifact' ? sha256(ANNOTATED) : sha256(MARKDOWN)}`,
    binding_id: 'binding-1',
    target: target(),
    status: 'delivered',
    dedupe_key: `dedupe-${kind}`,
    payload_digest: `sha256:${sha256(payloadJSON(kind))}`,
    payload_json: payloadJSON(kind),
    external_message_id: `provider-${kind}`,
    attempt: 1,
  }))
  return {
    batch_id: 'batch-1',
    agent_name: 'isolated-agent',
    object_kind: 'grading_final_artifact',
    object_id: `artifact-1:${finalDigest}`,
    dedupe_key: 'batch-dedupe',
    content_digest: `sha256:${'7'.repeat(64)}`,
    status: 'delivered',
    receipts,
  }
}

function operationReceipts() {
  return [
    {
      invocation_id: 'invocation-1',
      operation: 'recognition',
      canonical_input_digest: `sha256:${'1'.repeat(64)}`,
      provider: 'hexclaw-gpt',
      model: 'gpt-5.6-sol',
      status: 'succeeded',
      attempt: 1,
      result_digest: `sha256:${'2'.repeat(64)}`,
    },
  ]
}

function llmProjection(globalDefault = 'ollama') {
  return {
    default: globalDefault,
    providers: {
      ollama: { enabled: true, credential_present: true, models: ['qwen3.5:9b'] },
      'hexclaw-gpt': {
        enabled: true,
        credential_present: true,
        model: 'gpt-5.6-luna',
        models: ['gpt-5.6-terra', 'gpt-5.6-sol'],
        model_specs_mode: 'explicit',
        model_specs: [
          {
            id: 'gpt-5.6-sol',
            capabilities: ['text', 'vision', 'code'],
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
}

function gradingBudget(overrides = {}) {
  return {
    policy_version: 7,
    queued_seconds: 11,
    normalizing_seconds: 12,
    recognizing_seconds: 13,
    locating_seconds: 14,
    rendering_seconds: 15,
    projecting_seconds: 16,
    assessing_buckets: [
      { max_problems: 1, seconds: 17 },
      { max_problems: 8, seconds: 18 },
      { max_problems: 16, seconds: 19 },
      { max_problems: 32, seconds: 20 },
    ],
    item_concurrency: 4,
    ...overrides,
  }
}

function releasePreflightSnapshot(overrides = {}) {
  const budget = gradingBudget()
  const configBytes = Buffer.from(JSON.stringify({ k12: { grading_budget: budget } }))
  const configSHA256 = sha256(configBytes)
  const artifact = {
    schema_version: 1,
    approval_status: 'approved',
    approval_ref: 'release:photo-grading-v1',
    provider: 'hexclaw-gpt',
    model: 'gpt-5.6-sol',
    sidecar_config_sha256: configSHA256,
    grading_budget: budget,
    measurements: [1, 8, 16, 32].map((maxProblems, index) => ({
      max_problems: maxProblems,
      sample_count: 5,
      success_count: 5,
      p50_ms: 1_000 + index,
      p95_ms: 2_000 + index,
      logical_operations: 5,
      physical_provider_calls: 5,
      complete: true,
      result_digest: String(index + 1).repeat(64),
    })),
    evidence_sha256: 'e'.repeat(64),
  }
  const artifactBytes = Buffer.from(JSON.stringify(artifact))
  const artifactSHA256 = sha256(artifactBytes)
  return {
    config_bytes: configBytes,
    artifact_bytes: artifactBytes,
    expected_artifact_sha256: artifactSHA256,
    approval: {
      status: 'approved',
      approval_ref: artifact.approval_ref,
      provider: 'hexclaw-gpt',
      model: 'gpt-5.6-sol',
      artifact_sha256: artifactSHA256,
      release_config_sha256: configSHA256,
    },
    ...overrides,
  }
}

test('contract freezes a public outbound-only route and the trusted clear/messy oracle', async () => {
  const [contract, oracleBytes] = await Promise.all([
    readFile(CONTRACT_PATH, 'utf8').then(JSON.parse),
    readFile(ORACLE_PATH),
  ])
  const projected = validatePublicOutboundContract(contract, oracleBytes)
  assert.deepEqual(projected.route, {
    provider: 'hexclaw-gpt',
    model: 'gpt-5.6-sol',
    fallback_allowed: false,
  })
  assert.equal(projected.llm_preflight.global_default_may_differ, true)
  assert.equal(projected.llm_preflight.provider_default_model_may_differ, true)
  assert.equal(projected.llm_preflight.model_specs_mode, 'explicit')
  assert.deepEqual(projected.llm_preflight.required_capabilities, ['text', 'vision'])
  assert.deepEqual(projected.llm_preflight.reasoning_control.allowed_efforts, ['low'])
  assert.deepEqual(projected.instance_preflight.identifier_match, ['id', 'name'])
  assert.equal(projected.instance_preflight.unique_match_required, true)
  assert.equal(projected.terminal_failure.automatic_retry_allowed, false)
  assert.equal(
    projected.terminal_failure.missing_public_failure_code,
    'record_unavailable_without_guessing',
  )
  assert.equal(projected.fixtures.clear.item_count, 16)
  assert.equal(projected.fixtures.messy.item_count, 16)
  assert.equal(projected.forbidden_fragments.length, 2)
  assert.equal(projected.transport.synthetic_inbound_stream, false)
  assert.equal(projected.transport.sqlite_read_or_write, false)
})

test('contract rejects any callback, inbound query, store, CLI, or direct DingTalk escape hatch', async () => {
  const [contract, oracleBytes] = await Promise.all([
    readFile(CONTRACT_PATH, 'utf8').then(JSON.parse),
    readFile(ORACLE_PATH),
  ])
  for (const mutate of [
    (value) => (value.transport.synthetic_inbound_stream = true),
    (value) => (value.transport.sqlite_read_or_write = true),
    (value) => (value.transport.dws_cli = true),
    (value) => (value.transport.direct_dingtalk_http = true),
    (value) => (value.public_api.callback = '/api/v1/platforms/hooks/dingtalk/x'),
  ]) {
    const changed = structuredClone(contract)
    mutate(changed)
    assert.throws(() => validatePublicOutboundContract(changed, oracleBytes))
  }
})

test('live harness cannot repurpose HOME, invoke sqlite3/dws, or call DingTalk directly', async () => {
  const source = await readFile(HARNESS_PATH, 'utf8')
  for (const forbidden of [
    /process\.env\.HOME\s*=/u,
    /\bHOME\s*:/u,
    /\bsqlite3\b/iu,
    /(?:spawn|execFile|exec)\s*\([^\n]*["']dws["']/u,
    /https?:\/\/[^\s"']*dingtalk/iu,
    /openapi\.dingtalk/iu,
  ]) {
    assert.equal(forbidden.test(source), false, `forbidden live path: ${forbidden}`)
  }
  assert.equal(source.includes('LIVE_PHASE_NOT_IMPLEMENTED'), false)
  assert.deepEqual(PHASES, ['validate', 'prepare', 'clear', 'messy', 'restart-replay', 'status'])
})

test('runtime requires the explicit real default-profile config without rewriting HOME', () => {
  const runtime = resolveLiveRuntime(
    {
      HEXCLAW_PHOTO_OUTBOUND_RUN_DIR: '/tmp/photo-outbound-run',
      HEXCLAW_PHOTO_OUTBOUND_CONFIG: '/tmp/default-profile/.hexclaw/hexclaw.yaml',
      HEXCLAW_PHOTO_OUTBOUND_SOURCE_AGENT: 'source-agent',
      HEXCLAW_PHOTO_OUTBOUND_SIDECAR_BIN: '/Applications/HexClaw.app/Contents/MacOS/hexclaw',
      HEXCLAW_PHOTO_OUTBOUND_BASE_URL: 'http://127.0.0.1:16060',
    },
    '/tmp/default-profile',
  )
  assert.equal(runtime.config, '/tmp/default-profile/.hexclaw/hexclaw.yaml')
  assert.equal(runtime.asset_root, '/tmp/photo-outbound-run/assets')
  assert.equal(runtime.source_agent, 'source-agent')
  assert.throws(() =>
    resolveLiveRuntime(
      {
        HEXCLAW_PHOTO_OUTBOUND_RUN_DIR: '/tmp/photo-outbound-run',
        HEXCLAW_PHOTO_OUTBOUND_CONFIG: '/tmp/other/hexclaw.yaml',
        HEXCLAW_PHOTO_OUTBOUND_SOURCE_AGENT: 'source-agent',
      },
      '/tmp/default-profile',
    ),
  )
})

test('LLM preflight accepts a non-Sol provider default model when the explicitly pinned Sol route is trustworthy', () => {
  assert.deepEqual(assertLLMProjection(llmProjection()), {
    provider: 'hexclaw-gpt',
    model: 'gpt-5.6-sol',
    global_default: 'ollama',
    global_default_affects_fixed_route: false,
    provider_default_model: 'gpt-5.6-luna',
    provider_default_model_affects_fixed_route: false,
    capability: { text: true, vision: true },
    reasoning: {
      support: 'supported',
      dialect: 'reasoning_effort',
      low_available: true,
    },
  })
})

test('LLM preflight still rejects an unavailable or untrustworthy Sol catalog entry', () => {
  const mutations = [
    (value) => delete value.providers['hexclaw-gpt'],
    (value) => (value.providers['hexclaw-gpt'].enabled = false),
    (value) => delete value.providers['hexclaw-gpt'].credential_present,
    (value) => (value.providers['hexclaw-gpt'].credential_present = false),
    (value) => (value.providers['hexclaw-gpt'].models = ['gpt-5.6-terra']),
    (value) => (value.providers['hexclaw-gpt'].model_specs_mode = 'legacy'),
    (value) => delete value.providers['hexclaw-gpt'].model_specs,
    (value) => (value.providers['hexclaw-gpt'].model_specs = []),
    (value) => (value.providers['hexclaw-gpt'].model_specs[0].capabilities = ['text']),
    (value) => (value.providers['hexclaw-gpt'].model_specs[0].capabilities = ['vision']),
    (value) => (value.providers['hexclaw-gpt'].model_specs[0].reasoning_support = 'unknown'),
    (value) => (value.providers['hexclaw-gpt'].model_specs[0].reasoning_control.dialect = 'think'),
    (value) => (value.providers['hexclaw-gpt'].model_specs[0].reasoning_control.on = 'high'),
    (value) => (value.providers['hexclaw-gpt'].model_specs[0].reasoning_control.off = false),
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
    const changed = llmProjection()
    mutate(changed)
    assert.throws(() => assertLLMProjection(changed))
  }
})

test('release grading preflight fail-closes before every business side effect', async () => {
  const runner = await import('./k12-photo-grading-outbound-public-api.mjs')
  assert.equal(typeof runner.assertGradingReleasePreflightSnapshot, 'function')

  const valid = releasePreflightSnapshot()
  const projected = runner.assertGradingReleasePreflightSnapshot(valid)
  assert.deepEqual(projected.route, { provider: 'hexclaw-gpt', model: 'gpt-5.6-sol' })
  assert.equal(projected.policy_version, 7)
  assert.match(projected.config_sha256, /^[a-f0-9]{64}$/u)
  assert.match(projected.artifact_sha256, /^[a-f0-9]{64}$/u)

  const mutations = [
    () => ({ ...valid, config_bytes: Buffer.from(JSON.stringify({ k12: {} })) }),
    () => {
      const changed = structuredClone(JSON.parse(valid.config_bytes.toString('utf8')))
      changed.k12.grading_budget.policy_version = 0
      return { ...valid, config_bytes: Buffer.from(JSON.stringify(changed)) }
    },
    () => {
      const changed = structuredClone(JSON.parse(valid.config_bytes.toString('utf8')))
      delete changed.k12.grading_budget.rendering_seconds
      return { ...valid, config_bytes: Buffer.from(JSON.stringify(changed)) }
    },
    () => {
      const changed = structuredClone(JSON.parse(valid.config_bytes.toString('utf8')))
      changed.k12.grading_budget.assessing_buckets =
        changed.k12.grading_budget.assessing_buckets.slice(0, 3)
      return { ...valid, config_bytes: Buffer.from(JSON.stringify(changed)) }
    },
    () => ({
      ...valid,
      approval: {
        status: 'blocked',
        approval_ref: null,
        provider: 'hexclaw-gpt',
        model: 'gpt-5.6-sol',
        artifact_sha256: null,
        release_config_sha256: null,
      },
    }),
    () => ({
      ...valid,
      approval: { ...valid.approval, release_config_sha256: '0'.repeat(64) },
    }),
    () => ({ ...valid, expected_artifact_sha256: '0'.repeat(64) }),
  ]
  for (const mutate of mutations) {
    assert.throws(
      () => runner.assertGradingReleasePreflightSnapshot(mutate()),
      (error) => {
        assert.deepEqual(error.projection, {
          agent_creates: 0,
          image_task_submissions: 0,
          model_calls: 0,
          im_sends: 0,
        })
        return true
      },
    )
  }
})

test('prepare and photo case phases run release preflight before Sidecar or public write paths', async () => {
  const source = await readFile(HARNESS_PATH, 'utf8')
  assert.match(
    source,
    /async function preparePhase[\s\S]*?await assertRuntimeGradingReleasePreflight\(\s*runtime,\s*env[\s\S]*?await initializeRuntime\(runtime\)[\s\S]*?await withSidecar\(/u,
  )
  assert.match(
    source,
    /async function casePhase[\s\S]*?assertPreparedGradingReleasePreflight[\s\S]*?await withSidecar\(/u,
  )
})

test('prepare plan clones exactly one Sol K12 agent and every distinct bound DingTalk target', () => {
  const projection = {
    agents: [
      {
        name: 'source-agent',
        display_name: '作业辅导助手',
        provider: 'hexclaw-gpt',
        model: 'gpt-5.6-sol',
        metadata: { scenario: 'k12-tutor', grade_term: '五年级下' },
      },
    ],
    rules: [
      {
        id: 1,
        platform: 'dingtalk',
        instance_id: 'family-im',
        chat_id: 'parent-a',
        agent_name: 'source-agent',
        priority: 10,
      },
      {
        id: 2,
        platform: 'dingtalk',
        instance_id: 'family-im',
        user_id: 'parent-b',
        agent_name: 'source-agent',
        priority: 20,
      },
    ],
  }
  const plan = planIsolatedAgent(projection, 'source-agent', 'isolated-agent')
  assert.equal(plan.agent.name, 'isolated-agent')
  assert.equal(plan.agent.provider, 'hexclaw-gpt')
  assert.equal(plan.agent.model, 'gpt-5.6-sol')
  assert.deepEqual(plan.targets.map((value) => value.chat_id).sort(), ['parent-a', 'parent-b'])
  assert.equal(plan.rules.length, 2)
})

test('bound instance projection resolves the stable public id when the display name differs', () => {
  const projection = {
    instances: [
      {
        id: 'dingtalk-stable-id',
        name: '家长钉钉',
        provider: 'dingtalk',
        enabled: true,
        status: 'running',
        config: { app_secret: '****abcd' },
      },
    ],
  }
  const resolved = assertBoundInstancesProjection(projection, [
    { platform: 'dingtalk', instance_id: 'dingtalk-stable-id', chat_id: 'parent' },
  ])
  assert.equal(resolved.length, 1)
  assert.equal(resolved[0].name, '家长钉钉')

  for (const mutate of [
    (value) => (value.instances[0].provider = 'web'),
    (value) => (value.instances[0].enabled = false),
    (value) => (value.instances[0].status = 'stopped'),
    (value) => (value.instances[0].config.app_secret = 'raw-secret'),
    (value) =>
      value.instances.push({ ...value.instances[0], id: 'other', name: 'dingtalk-stable-id' }),
  ]) {
    const changed = structuredClone(projection)
    mutate(changed)
    assert.throws(() =>
      assertBoundInstancesProjection(changed, [
        { platform: 'dingtalk', instance_id: 'dingtalk-stable-id', chat_id: 'parent' },
      ]),
    )
  }
})

test('ImageTask loop automatically emits only the existing intent and recognition confirmations', () => {
  assert.deepEqual(
    nextImageTaskCommand(
      { dispatch_id: 'dispatch-1', status: 'awaiting_confirmation', version: 2 },
      'isolated-agent',
      '五年级下',
    ),
    {
      kind: 'confirm_intent',
      path: '/api/k12/image-tasks/dispatch-1/confirm',
      data: {
        agent: 'isolated-agent',
        version: 2,
        intent: 'completed_homework',
      },
    },
  )
  const homework = {
    dispatch_id: 'dispatch-1',
    status: 'routed',
    version: 4,
    target_projection: {
      kind: 'homework',
      stage: 'awaiting_confirmation',
      confirmation_state: 'pending',
      recognition: { questions: [{ problem_id: 'problem-1' }, { problem_id: 'problem-2' }] },
    },
  }
  assert.deepEqual(nextImageTaskCommand(homework, 'isolated-agent', '五年级下'), {
    kind: 'confirm_recognition',
    path: '/api/k12/image-tasks/dispatch-1/confirm',
    data: {
      agent: 'isolated-agent',
      version: 4,
      homework: {
        subject: '数学',
        grade: '五年级下',
        question_corrections: [
          { index: 0, problem_id: 'problem-1', confirmed: true },
          { index: 1, problem_id: 'problem-2', confirmed: true },
        ],
      },
    },
  })
  assert.deepEqual(
    nextImageTaskCommand(
      {
        dispatch_id: 'dispatch-1',
        status: 'routed',
        version: 5,
        target_projection: { kind: 'homework', stage: 'completed' },
      },
      'isolated-agent',
      '五年级下',
    ),
    { kind: 'completed' },
  )
})

test('terminal ImageTask failure projects safe receipts, retry semantics and exact model call counts', () => {
  const dispatch = {
    dispatch_id: 'dispatch-failed',
    status: 'failed',
    task_intent: 'completed_homework',
    model_id: 'gpt-5.6-sol',
    retryable: true,
    progress: { operation: 'homework', state: 'failed' },
    version: 2,
  }
  const result = {
    dispatch_id: 'dispatch-failed',
    status: 'failed',
    task_intent: 'completed_homework',
    operation_receipts: [
      {
        invocation_id: 'classification-call',
        operation: 'classification',
        canonical_input_digest: `sha256:${'1'.repeat(64)}`,
        provider: 'hexclaw-gpt',
        model: 'gpt-5.6-sol',
        status: 'succeeded',
        attempt: 1,
        result_digest: `sha256:${'2'.repeat(64)}`,
      },
      {
        invocation_id: 'solve-call',
        operation: 'solve',
        canonical_input_digest: `sha256:${'1'.repeat(64)}`,
        provider: 'hexclaw-gpt',
        model: 'gpt-5.6-sol',
        status: 'failed',
        attempt: 1,
        result_digest: '',
      },
    ],
  }
  const projected = projectTerminalImageTaskFailure(dispatch, result)
  assert.equal(projected.failure_stage, 'solve')
  assert.equal(projected.failure_code_publicly_available, false)
  assert.equal(projected.failure_code, null)
  assert.equal(projected.retry_safety.public_retryable, true)
  assert.equal(projected.retry_safety.automatic_retry_performed, false)
  assert.equal(projected.model_physical_call_count, 2)
  assert.equal(projected.physical_child_receipt_count, 0)
  assert.equal(projected.fallback_call_count, 0)
  assert.equal(projected.operation_receipts.length, 2)
  assert.equal(Object.hasOwn(projected.operation_receipts[0], 'invocation_id'), false)

  const fallback = structuredClone(result)
  fallback.operation_receipts[1].model = 'gpt-5.6-terra'
  assert.throws(() => projectTerminalImageTaskFailure(dispatch, fallback))
})

test('ImageTask canonical source digest includes the exact byte length and fixture bytes', () => {
  const bytes = Buffer.from('homework-photo')
  const length = Buffer.alloc(8)
  length.writeBigUInt64BE(BigInt(bytes.length))
  assert.equal(imageTaskSourceDigest([bytes]), `sha256:${sha256(Buffer.concat([length, bytes]))}`)
})

test('public source proof separates exact raw admission bytes from the normalized PNG receipt', () => {
  const raw = Buffer.from('phone-photo-jpeg-bytes')
  const projected = assertPublicSourceIdentity({
    raw_bytes: raw,
    fixture_sha256: sha256(raw),
    fixture_size_bytes: raw.length,
    canonical_aggregate_digest: 'a'.repeat(64),
    canonical_attachment_digest: 'b'.repeat(64),
    canonical_attachment_size_bytes: 321,
  })
  assert.equal(projected.raw_digest, sha256(raw))
  assert.equal(projected.canonical_aggregate_digest, 'a'.repeat(64))
  assert.equal(projected.canonical_attachment_digest, 'b'.repeat(64))
  assert.equal(projected.canonical_attachment_size_bytes, 321)
  assert.throws(() =>
    assertPublicSourceIdentity({
      raw_bytes: raw,
      fixture_sha256: 'c'.repeat(64),
      fixture_size_bytes: raw.length,
      canonical_aggregate_digest: 'a'.repeat(64),
      canonical_attachment_digest: 'b'.repeat(64),
      canonical_attachment_size_bytes: 321,
    }),
  )
})

test('final artifact projection binds real Sol receipts, Chinese Markdown and exact annotated bytes', () => {
  const result = {
    status: 'routed',
    task_intent: 'completed_homework',
    source_digest: 'a'.repeat(64),
    source_attachments: [{ digest: `sha256:${'b'.repeat(64)}`, size_bytes: 123 }],
    operation_receipts: operationReceipts(),
    result: {
      kind: 'completed_homework',
      payload: {
        task_intent: 'completed_homework',
        result_surface: 'annotated_homework',
        markdown: MARKDOWN,
        annotated_image: {
          mime: 'image/png',
          digest: `sha256:${sha256(ANNOTATED)}`,
          data_base64: ANNOTATED.toString('base64'),
        },
        items: [],
      },
    },
  }
  const artifact = {
    artifact_id: 'artifact-1',
    artifact_digest: '8'.repeat(64),
    coverage_status: 'complete',
    canonical_markdown: MARKDOWN,
  }
  const projected = assertFinalArtifactProjection({ result, artifact })
  assert.equal(projected.annotated_digest, sha256(ANNOTATED))
  assert.equal(projected.annotated_bytes.equals(ANNOTATED), true)
  assert.equal(projected.operation_receipts.length, 1)

  const fallback = structuredClone(result)
  fallback.operation_receipts.push({
    ...operationReceipts()[0],
    invocation_id: 'fallback-physical-call',
    parent_invocation_id: 'invocation-1',
    physical_unit: 'fallback',
    model: 'gpt-5.6-terra',
  })
  assert.throws(() => assertFinalArtifactProjection({ result: fallback, artifact }))
})

test('final delivery is exactly Markdown plus the immutable annotated image per bound target', () => {
  const projected = assertFinalDeliveryExactSet(batch(), {
    agent_name: 'isolated-agent',
    final_artifact_id: 'artifact-1',
    final_artifact_digest: '8'.repeat(64),
    canonical_markdown: MARKDOWN,
    annotated_mime: 'image/png',
    annotated_digest: sha256(ANNOTATED),
    annotated_bytes: ANNOTATED,
    expected_targets: [target()],
  })
  assert.equal(projected.target_count, 1)
  assert.equal(projected.receipt_count, 2)
  assert.equal(projected.external_message_id_hashes.length, 2)
})

test('restart/replay exact-set rejects any new model call or provider attempt', () => {
  const before = {
    dispatch_id: 'dispatch-1',
    final_artifact_id: 'artifact-1',
    final_artifact_digest: '8'.repeat(64),
    annotated_digest: sha256(ANNOTATED),
    operation_receipts: operationReceipts(),
    batch: batch(),
  }
  assert.doesNotThrow(() => assertRestartReplayInvariant(before, structuredClone(before)))

  const extraModel = structuredClone(before)
  extraModel.operation_receipts.push({ ...operationReceipts()[0], invocation_id: 'invocation-2' })
  assert.throws(() => assertRestartReplayInvariant(before, extraModel))

  const resent = structuredClone(before)
  resent.batch.receipts[0].attempt = 2
  assert.throws(() => assertRestartReplayInvariant(before, resent))
})
