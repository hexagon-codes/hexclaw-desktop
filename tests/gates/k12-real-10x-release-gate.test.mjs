import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const repoFile = (path) => new URL(`../../${path}`, import.meta.url)
const cycleIds = Array.from({ length: 10 }, (_, index) => `C${String(index + 1).padStart(2, '0')}`)

async function loadContract() {
  return JSON.parse(
    await readFile(repoFile('tests/live/k12-real-10x-release.contract.json'), 'utf8'),
  )
}

async function loadRunner() {
  return import(repoFile('scripts/ci/k12-real-10x-release-gate.mjs'))
}

test('versioned release contract freezes C01-C10 and serial no-retry execution', async () => {
  const contract = await loadContract()

  assert.equal(contract.schemaVersion, 1)
  assert.equal(contract.reportPath, 'test-results/k12-real-10x-release/report.json')
  assert.deepEqual(
    contract.cycles.map(({ id }) => id),
    cycleIds,
  )
  assert.equal(new Set(contract.cycles.map(({ id }) => id)).size, 10)
  assert.deepEqual(contract.execution, {
    workers: 1,
    fullyParallel: false,
    retries: 0,
    forbidOnly: true,
    failOnSkipped: true,
    dingTalkLiveSend: '0',
  })
  assert.deepEqual(contract.provider, {
    identity: 'hexclaw-gpt',
    displayName: 'HexClaw-GPT',
    model: 'gpt-5.6-sol',
    ragEmbeddingModel: 'qwen3-embedding:8b',
  })
  for (const name of [
    'HEXCLAW_LOCAL_SRC',
    'HEX_K12_LIVE_FIXTURE_PROFILE',
    'HEX_K12_LIVE_FIXTURE_STORE',
    'HEX_K12_LIVE_FIXTURE_MANIFEST',
    'HEX_K12_LIVE_SIDECAR_CONTROL',
    'HEX_K12_LIVE_SIDECAR_CONTROL_SHA256',
    'HEX_K12_LIVE_SIDECAR_CONTROL_CONFIG',
  ]) {
    assert.ok(contract.requiredEnvironment.values.includes(name))
  }
})

test('preflight trusts all repository hooks but blocks on missing caller-owned C10 inputs', async () => {
  const contract = await loadContract()
  const { preflightReleaseGate } = await loadRunner()
  const existing = new Set(
    contract.cycles
      .map(({ hook }) => hook?.module)
      .filter(Boolean),
  )
  const result = preflightReleaseGate(contract, {
    env: {
      HEX_K12_REAL_10X_RUN_ID: 'release-run',
      HEX_K12_LIVE_PROVIDER: 'hexclaw-gpt',
      HEX_K12_LIVE_EXPECTED_PROVIDER_DISPLAY: 'HexClaw-GPT',
      HEX_K12_LIVE_MODEL: 'gpt-5.6-sol',
      HEX_K12_RAG_EMBEDDING_MODEL: 'qwen3-embedding:8b',
    },
    hookExists: (module) => existing.has(module),
  })

  assert.deepEqual(result.blockers.filter(({ kind }) => kind === 'missing-hook'), [])
  assert.deepEqual(
    result.blockers
      .filter(({ kind, cycle }) => kind === 'environment' && cycle === 'C10')
      .map(({ name }) => name),
    [
      'HEX_K12_C10_RESTART_AUTHORIZED',
      'HEX_K12_C10_RESTART_HOOK',
      'HEX_K12_C10_RESTART_HOOK_SHA256',
      'HEX_K12_C10_HANDOFF_PUBLIC_KEY',
      'HEX_K12_C10_HANDOFF_PUBLIC_KEY_SHA256',
      'HEX_K12_C10_BEFORE_HANDOFF',
      'HEX_K12_C10_AFTER_HANDOFF',
      'HEX_K12_C10_AFTER_HANDOFF_PUBLIC_KEY',
      'HEX_K12_C10_DRIVER_CONFIG',
    ],
  )
  assert.equal(result.ready, false)
})

test('runner assigns one unique run id per cycle and forces DingTalk off', async () => {
  const contract = await loadContract()
  const { executeReleasePlan } = await loadRunner()
  const calls = []
  const runnable = structuredClone(contract)
  for (const cycle of runnable.cycles) {
    cycle.hook = {
      lane: `trusted-${cycle.id}`,
      module: `scripts/ci/trusted-${cycle.id}.mjs`,
      args: ['--strict'],
    }
  }

  const result = executeReleasePlan(runnable, {
    baseRunId: 'release-run',
    env: { DINGTALK_LIVE_SEND: '1' },
    spawn: (command, args, options) => {
      calls.push({ command, args, env: options.env })
      return { status: 0 }
    },
  })

  assert.equal(result.status, 'passed')
  assert.deepEqual(
    calls.map(({ env }) => env.HEX_K12_REAL_10X_CYCLE_ID),
    cycleIds,
  )
  assert.equal(new Set(calls.map(({ env }) => env.HEX_K12_REAL_10X_CYCLE_RUN_ID)).size, 10)
  assert.deepEqual(
    calls.map(({ env }) => env.DINGTALK_LIVE_SEND),
    Array(10).fill('0'),
  )
  assert.deepEqual(
    calls.map(({ command }) => command),
    Array(10).fill(process.execPath),
  )
})

test('runner stops on the first non-passing trusted lane and never retries', async () => {
  const contract = await loadContract()
  const { executeReleasePlan } = await loadRunner()
  const runnable = structuredClone(contract)
  for (const cycle of runnable.cycles) {
    cycle.hook = {
      lane: `trusted-${cycle.id}`,
      module: `scripts/ci/trusted-${cycle.id}.mjs`,
      args: ['--strict'],
    }
  }
  let calls = 0

  const result = executeReleasePlan(runnable, {
    baseRunId: 'release-run',
    env: {},
    spawn: () => {
      calls += 1
      return { status: calls === 3 ? 2 : 0 }
    },
  })

  assert.equal(calls, 3)
  assert.equal(result.status, 'failed')
  assert.equal(result.cycles[2].id, 'C03')
  assert.equal(result.cycles[2].exitCode, 2)
})
