import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)
const LIVE_ROOT = dirname(fileURLToPath(import.meta.url))
const RUNNER = resolve(LIVE_ROOT, 'chat-assistant-persistence-installed-sidecar.mjs')

async function runnerSource() {
  return readFile(RUNNER, 'utf8')
}

test('installed assistant persistence runner excludes private database and fixture lifecycle probes', async () => {
  const source = await runnerSource()
  const forbidden = [
    /sqlite3/iu,
    /readSQLiteEvidence/u,
    /readDatabaseSnapshot/u,
    /projectSQLiteRows/u,
    /PRAGMA/iu,
    /SELECT\s+.+\s+FROM/iu,
    /\b(start|cleanup|scavenge)\b[^\n]*k12-live-fixture-testtools/iu,
    /k12-live-fixture-testtools[^\n]*\b(start|cleanup|scavenge)\b/iu,
  ]
  for (const expression of forbidden) {
    assert.doesNotMatch(source, expression)
  }
  assert.match(source, /'prepare-profile'/u)
})

test('runner never repurposes HOME for helper or Sidecar isolation', async () => {
  const source = await runnerSource()
  assert.doesNotMatch(source, /\bHOME\s*:/u)
  assert.doesNotMatch(source, /env\.HOME/u)
  assert.match(source, /SIDECAR_PROFILE_ROOT_UNSUPPORTED/u)
})

test('default-profile mode uses the real config in place and preserves the inherited environment', async () => {
  const source = await runnerSource()
  assert.match(source, /'run-default-profile'/u)
  assert.match(source, /HEX_CHAT_ATOMIC_DEFAULT_PROFILE_AUTHORIZED/u)
  assert.match(source, /HEX_CHAT_ATOMIC_ACTUAL_CONFIG/u)
  assert.match(source, /homedir\(\)/u)
  assert.match(source, /function defaultProfileEnvironment/u)
  assert.match(source, /\.\.\.env/u)
  assert.match(source, /HEXCLAW_DISABLE_IM:\s*'all'/u)
  assert.doesNotMatch(source, /copyFile/u)
})

test('default-profile mode owns and cleans only its unique public-API session', async () => {
  const source = await runnerSource()
  assert.match(source, /function assertOwnedTestSession/u)
  assert.match(source, /async function cleanupOwnedTestSession/u)
  assert.match(source, /method:\s*'DELETE'/u)
  assert.match(source, /SESSION_CLEANUP_OWNERSHIP_INVALID/u)
  assert.match(source, /cleanup_status:\s*'deleted'/u)
  assert.match(source, /cleanup_status:\s*'retained'/u)
  assert.match(source, /expectedStatus:\s*404/u)
})

test('default-profile mode starts the installed candidate with the explicit actual config only', async () => {
  const source = await runnerSource()
  assert.match(source, /function startDefaultProfileSidecar/u)
  assert.match(source, /\['serve', '--desktop', '--config', paths\.actualConfig\]/u)
  assert.match(source, /DEFAULT_APP_BUNDLE = '\/Applications\/HexClaw\.app'/u)
  assert.match(source, /appBundle !== DEFAULT_APP_BUNDLE/u)
  assert.match(source, /DEFAULT_PROFILE_PORT = 16060/u)
  assert.match(source, /default_profile:\s*true/u)
})

test('default-profile preflight accepts an exact usable Sol route when ordinary defaults differ', async () => {
  const runner = await import(`${pathToFileURL(RUNNER).href}?route-contract=${Date.now()}`)
  assert.equal(typeof runner.assertDefaultProfileRoute, 'function')

  const projection = runner.assertDefaultProfileRoute({
    default: 'ordinary-default',
    reasoning_provider: 'ordinary-reasoning',
    reasoning_model: 'ordinary-reasoning-model',
    providers: {
      'ordinary-default': {
        credential_present: true,
        model: 'ordinary-model',
        models: ['ordinary-model'],
      },
      'hexclaw-gpt': {
        credential_present: true,
        enabled: true,
        model: 'ordinary-provider-model',
        models: ['ordinary-provider-model', 'gpt-5.6-sol'],
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
  })

  assert.deepEqual(projection, {
    provider: 'hexclaw-gpt',
    model: 'gpt-5.6-sol',
    explicitly_pinned: true,
    default_route_matches: false,
    provider_default_model_matches: false,
    text_capability: true,
    reasoning: {
      support: 'supported',
      dialect: 'reasoning_effort',
      low_available: true,
    },
  })
})

test('remote chat warmup observation accepts a delayed skip receipt but rejects a local start', async () => {
  const runner = await import(`${pathToFileURL(RUNNER).href}?warmup-contract=${Date.now()}`)
  assert.equal(typeof runner.projectRemoteChatWarmupState, 'function')

  assert.deepEqual(runner.projectRemoteChatWarmupState(0, 0), {
    status: 'not_started_or_deferred',
    skip_receipt_count: 0,
    local_warmup_start_count: 0,
    provider_call_observed: false,
    skip_receipt_pending: true,
  })
  assert.deepEqual(runner.projectRemoteChatWarmupState(2, 0), {
    status: 'skipped_non_local',
    skip_receipt_count: 2,
    local_warmup_start_count: 0,
    provider_call_observed: false,
    skip_receipt_pending: false,
  })
  assert.throws(
    () => runner.projectRemoteChatWarmupState(0, 1),
    (error) => error?.code === 'LOCAL_CHAT_WARMUP_STARTED',
  )

  const source = await runnerSource()
  assert.doesNotMatch(source, /REMOTE_WARMUP_SKIP_NOT_OBSERVABLE/u)
  assert.match(source, /warmup_after_request/u)
  assert.match(source, /warmup_after_history/u)
})

test('IM disable proof accepts a missing log receipt only when every DingTalk instance is non-running', async () => {
  const runner = await import(`${pathToFileURL(RUNNER).href}?im-disable-contract=${Date.now()}`)
  assert.equal(typeof runner.projectDingTalkIMDisabled, 'function')

  const projectionOnly = runner.projectDingTalkIMDisabled(0, {
    instances: [
      { provider: 'dingtalk', enabled: true, status: 'stopped' },
      { provider: 'DingTalk', enabled: true, status: 'error' },
      { provider: 'feishu', enabled: true, status: 'running' },
    ],
    total: 3,
  })
  assert.deepEqual(projectionOnly, {
    disabled_all: true,
    proof_source: 'public_instance_projection',
    public_log_receipt_count: 0,
    projected_instance_count: 3,
    dingtalk_instance_count: 2,
    dingtalk_running_count: 0,
  })

  const logAndProjection = runner.projectDingTalkIMDisabled(1, {
    instances: [{ provider: 'dingtalk', enabled: false, status: 'stopped' }],
    total: 1,
  })
  assert.deepEqual(logAndProjection, {
    disabled_all: true,
    proof_source: 'public_log_and_instance_projection',
    public_log_receipt_count: 1,
    projected_instance_count: 1,
    dingtalk_instance_count: 1,
    dingtalk_running_count: 0,
  })

  assert.throws(
    () =>
      runner.projectDingTalkIMDisabled(1, {
        instances: [{ provider: 'dingtalk', enabled: true, status: 'running' }],
        total: 1,
      }),
    (error) => error?.code === 'DINGTALK_INSTANCE_RUNNING',
  )
  assert.throws(
    () => runner.projectDingTalkIMDisabled(0, { instances: [], total: 1 }),
    (error) => error?.code === 'IM_INSTANCE_PROJECTION_INVALID',
  )

  const source = await runnerSource()
  assert.ok(source.includes('/api/v1/platforms/instances'))
  assert.equal(source.match(/await observeIMStartupDisabled\(/gu)?.length, 2)
  assert.doesNotMatch(source, /IM_DISABLE_RECEIPT_UNOBSERVED/u)
})

test('default-profile automation gate isolates only the owned session, request, and marker', async () => {
  const runner = await import(`${pathToFileURL(RUNNER).href}?automation-contract=${Date.now()}`)
  assert.equal(typeof runner.projectOwnedAutomationIsolation, 'function')
  const ownership = {
    session_id: 'session-owned-9e15f4ee',
    request_id: 'request-owned-3ec7ed91',
    marker: 'HEXCLAW-ATOMIC-owned-7bb52e76',
  }

  assert.deepEqual(
    runner.projectOwnedAutomationIsolation(
      {
        jobs: [
          {
            id: 'user-active-job',
            status: 'active',
            payload: { session_id: 'unrelated-user-session' },
          },
          {
            id: 'user-paused-job',
            status: 'paused',
            prompt: '用户既有的学习提醒',
          },
        ],
      },
      ownership,
    ),
    {
      listed_job_count: 2,
      active_unrelated_count: 1,
      paused_unrelated_count: 1,
      owned_match_count: 0,
      scope: 'owned_session_request_marker_only',
    },
  )

  for (const ownedJob of [
    { id: 'owned-session', status: 'paused', payload: { session_id: ownership.session_id } },
    { id: 'owned-request', status: 'active', request_id: ownership.request_id },
    { id: 'owned-marker', status: 'active', command: `reply ${ownership.marker}` },
  ]) {
    assert.throws(
      () => runner.projectOwnedAutomationIsolation({ jobs: [ownedJob] }, ownership),
      (error) => error?.code === 'OWNED_AUTOMATION_PRESENT',
    )
  }

  const source = await runnerSource()
  assert.doesNotMatch(source, /DEFAULT_PROFILE_ACTIVE_AUTOMATION_PRESENT/u)
  assert.doesNotMatch(source, /DEFAULT_PROFILE_BACKGROUND_MODEL_ACTIVITY_PRESENT/u)
  assert.equal(source.match(/await assertNoOwnedAutomation\(/gu)?.length, 2)
  assert.ok(
    source.indexOf('evidence.first_startup.automation = await assertNoOwnedAutomation') >
      source.indexOf('const chat = await submitChat'),
  )
})

test('runner pins the installed candidate, exact real route, and one public chat submission', async () => {
  const source = await runnerSource()
  assert.match(source, /HEX_CHAT_ATOMIC_INSTALLED_AUTHORIZED/u)
  assert.match(source, /HEX_CHAT_ATOMIC_APP_BUNDLE/u)
  assert.match(source, /HEX_CHAT_ATOMIC_SOURCE_CONFIG/u)
  assert.match(source, /HEX_CHAT_ATOMIC_EXPECTED_SIDECAR_SHA256/u)
  assert.match(source, /const EXPECTED_PROVIDER = 'hexclaw-gpt'/u)
  assert.match(source, /const EXPECTED_MODEL = 'gpt-5\.6-sol'/u)
  assert.match(source, /MAX_CHAT_SUBMISSIONS = 1/u)
  assert.match(source, /assertChatSubmissionCount\(1\)/u)
})

test('runner proves response/history/log continuity using only product and sanitized observer APIs', async () => {
  const source = await runnerSource()
  for (const endpoint of [
    '/api/v1/version',
    '/api/v1/config/llm',
    '/api/v1/chat',
    '/api/v1/sessions/',
    '/api/v1/logs',
  ]) {
    assert.ok(source.includes(endpoint), `missing public endpoint ${endpoint}`)
  }
  assert.match(source, /HEXCLAW_TEST_OBSERVE_CHAT_PHYSICAL_CALLS/u)
  assert.match(source, /physical_provider_calls/u)
  assert.match(source, /fallback_provider_calls:\s*0/u)
  assert.match(source, /explicit_route_response_and_physical_call_receipt/u)
  assert.match(source, /history_before_restart/u)
  assert.match(source, /history_after_restart/u)
})

test('runner rotates capability, rejects the old token, and does not submit after restart', async () => {
  const source = await runnerSource()
  assert.match(source, /capabilityBefore/u)
  assert.match(source, /capabilityAfter/u)
  assert.match(source, /expectedStatus:\s*401/u)
  assert.match(source, /chat_submissions_after_restart:\s*0/u)
})

test('runner requests low reasoning with tools disabled and forbids IM delivery', async () => {
  const source = await runnerSource()
  assert.match(source, /thinking_effort:\s*'low'/u)
  assert.match(source, /tools_enabled:\s*'off'/u)
  assert.match(source, /DINGTALK_LIVE_SEND:\s*'0'/u)
  assert.doesNotMatch(source, /\/api\/v1\/(?:im|dingtalk|deliver)/iu)
})

test('runner evidence is digest-only and validate mode has no live side effects', async () => {
  const source = await runnerSource()
  assert.match(source, /assertEvidenceSafe/u)
  assert.match(source, /response_sha256/u)
  assert.match(source, /assistant_id_sha256/u)
  assert.match(source, /mode:\s*'validate'/u)
  assert.match(source, /CHAT_OUTCOME_UNKNOWN_NO_SAFE_PUBLIC_SESSION_LOOKUP/u)
  assert.doesNotMatch(source, /evidence[^\n]*(?:reply|prompt|api_key|capability_token)/iu)

  const { stdout, stderr } = await execFile(process.execPath, [RUNNER, 'validate'], {
    cwd: resolve(LIVE_ROOT, '../..'),
    env: {
      PATH: process.env.PATH,
    },
    timeout: 10_000,
  })
  assert.equal(stderr, '')
  const receipt = JSON.parse(stdout)
  assert.deepEqual(receipt, {
    status: 'validated',
    mode: 'validate',
    sidecar_started: false,
    model_called: false,
    im_called: false,
    live_supported: false,
    blocker: 'SIDECAR_PROFILE_ROOT_UNSUPPORTED',
    default_profile_live_supported: true,
    default_profile_live_gate_required: true,
  })
})

test('runner caps the complete live stage below 29 minutes', async () => {
  const source = await runnerSource()
  assert.match(source, /LIVE_BUDGET_MS = 28 \* 60_000/u)
})
