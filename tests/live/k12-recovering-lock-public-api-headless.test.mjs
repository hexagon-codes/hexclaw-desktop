import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  assertRecoveringProjection,
  assertRestartQueryOnly,
  layerSupport,
  staticValidation,
} from './k12-recovering-lock-public-api-headless.mjs'

const contractPath = fileURLToPath(
  new URL('./k12-recovering-lock-public-api.contract.json', import.meta.url),
)
const harnessPath = fileURLToPath(
  new URL('./k12-recovering-lock-public-api-headless.mjs', import.meta.url),
)
const helperPath = fileURLToPath(
  new URL('./k12-recovering-lock-profile-fixture.go', import.meta.url),
)
const probePath = fileURLToPath(
  new URL('./k12-recovering-lock-readonly-probe.swift', import.meta.url),
)

const recovering = {
  dispatch: {
    dispatch_id: 'dispatch-public-a',
    status: 'failed',
    retryable: false,
    progress: { operation: 'classification', state: 'recovering' },
    version: 2,
  },
}

test('validate mode is side-effect free and keeps the live/UI/query gates distinct', () => {
  assert.deepEqual(staticValidation(), {
    status: 'validated',
    mode: 'static',
    public_api_only: true,
    sidecar_started: false,
    provider_posts: 0,
    dingtalk_sends: 0,
    database_mutations: 0,
    live_layer_a_required: true,
    installed_ui_layer_b_required: true,
    provider_query_layer_c_conditional: true,
  })
  assert.deepEqual(layerSupport(), {
    layer_a: { supported: true, command: 'run-a' },
    layer_b: {
      supported: true,
      command: 'run-b',
      boundary: 'installed_ui',
    },
    layer_c: {
      supported: false,
      code: 'PROVIDER_QUERY_IDENTITY_UNAVAILABLE',
      conditional: true,
    },
  })
})

test('public recovering DTO is exact, non-retryable, and hides internal outcome_unknown', () => {
  assert.deepEqual(assertRecoveringProjection(recovering), {
    dispatch_id: 'dispatch-public-a',
    dispatch_status: 'failed',
    version: 2,
    retryable: false,
    progress_operation: 'classification',
    progress_state: 'recovering',
  })
  for (const invalid of [
    { ...recovering, dispatch: { ...recovering.dispatch, retryable: true } },
    {
      ...recovering,
      dispatch: {
        ...recovering.dispatch,
        progress: { operation: 'classification', state: 'outcome_unknown' },
      },
    },
    { ...recovering, dispatch: { ...recovering.dispatch, status: 'routing' } },
  ]) {
    assert.throws(() => assertRecoveringProjection(invalid), /PUBLIC_RECOVERING_DTO_INVALID/u)
  }
})

test('restart proof accepts only the same immutable DTO with GET-only business traffic and zero provider delta', () => {
  assert.deepEqual(
    assertRestartQueryOnly(recovering, structuredClone(recovering), {
      provider_posts_before: 1,
      provider_posts_after: 1,
      restart_business_requests: [
        'GET /api/k12/image-tasks/dispatch-public-a',
        'GET /api/k12/image-tasks/dispatch-public-a/result',
      ],
    }),
    {
      dispatch_id: 'dispatch-public-a',
      version: 2,
      provider_post_delta: 0,
      restart_business_methods: ['GET'],
      query_only: true,
    },
  )
  assert.throws(
    () =>
      assertRestartQueryOnly(recovering, structuredClone(recovering), {
        provider_posts_before: 1,
        provider_posts_after: 2,
        restart_business_requests: ['POST /api/k12/image-tasks'],
      }),
    /RESTART_QUERY_ONLY_INVALID/u,
  )
})

test('contract freezes A/B/C boundaries and never claims API-only UI or invented reconciliation', async () => {
  const contract = JSON.parse(await readFile(contractPath, 'utf8'))
  assert.equal(contract.schema_version, 1)
  assert.equal(contract.layer_a.direct_database_mutation, false)
  assert.equal(contract.layer_a.real_im_send, false)
  assert.equal(contract.layer_b.api_only_harness_can_complete, false)
  assert.equal(contract.layer_c.image_task_public_reconcile_api, false)
  assert.equal(contract.layer_c.must_not_invent_reconciliation_api, true)
  assert.deepEqual(contract.validate_side_effects, {
    sidecar_starts: 0,
    provider_posts: 0,
    dingtalk_sends: 0,
    database_mutations: 0,
  })
})

test('live harness uses public APIs and read-only installed UI inspection without database or input injection', async () => {
  const [harness, helper, probe, contractRaw] = await Promise.all([
    readFile(harnessPath, 'utf8'),
    readFile(helperPath, 'utf8'),
    readFile(probePath, 'utf8'),
    readFile(contractPath, 'utf8'),
  ])
  for (const forbidden of [
    /\bsqlite3\b/u,
    /database\/sql/u,
    /k12-live-fixture-testtools/u,
    /AXUIElementPerformAction/u,
    /CGEvent/u,
    /NSPasteboard/u,
    /navigator\.clipboard/u,
    /\bdws\b/u,
  ]) {
    assert.doesNotMatch(`${harness}\n${helper}\n${probe}`, forbidden)
  }
  const contract = JSON.parse(contractRaw)
  assert.deepEqual(contract.layer_a.public_api_exact_set, [
    'POST /api/v1/agents',
    'POST /api/v1/sessions',
    'POST /api/v1/sessions/{session_id}/messages',
    'GET /api/v1/config/llm',
    'POST /api/v1/config/llm/probe',
    'POST /api/k12/assets',
    'POST /api/k12/image-tasks',
    'GET /api/k12/image-tasks/{dispatch_id}',
    'GET /api/k12/image-tasks/{dispatch_id}/result',
  ])
})
