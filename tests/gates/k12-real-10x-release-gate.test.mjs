import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

function preparedC10Environment() {
  return {
    HEX_K12_C10_RESTART_AUTHORIZED: '1',
    HEX_K12_C10_RESTART_HOOK: '/tmp/k12-c10/restart-driver',
    HEX_K12_C10_RESTART_HOOK_SHA256: 'a'.repeat(64),
    HEX_K12_C10_HANDOFF_PUBLIC_KEY: '/tmp/k12-c10/pre-public.pem',
    HEX_K12_C10_HANDOFF_PUBLIC_KEY_SHA256: 'b'.repeat(64),
    HEX_K12_C10_BEFORE_HANDOFF: '/tmp/k12-c10/before.json',
    HEX_K12_C10_AFTER_HANDOFF: '/tmp/k12-c10/after.json',
    HEX_K12_C10_AFTER_HANDOFF_PUBLIC_KEY: '/tmp/k12-c10/after-public.pem',
    HEX_K12_C10_DRIVER_CONFIG: '/tmp/k12-c10/driver.json',
  }
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
    'HEX_K12_LIVE_GRADING_CALIBRATION_ARTIFACT',
    'HEX_K12_LIVE_GRADING_CALIBRATION_SHA256',
  ]) {
    assert.ok(contract.requiredEnvironment.values.includes(name))
  }
})

test('versioned release calibration approval rejects duplicate JSON keys', async () => {
  const runner = await loadRunner()
  assert.equal(typeof runner.parseReal10xReleaseContract, 'function')
  const canonical = await readFile(
    repoFile('tests/live/k12-real-10x-release.contract.json'),
    'utf8',
  )
  const duplicate = canonical.replace(
    '"status": "blocked"',
    '"status": "approved",\n    "status": "blocked"',
  )

  assert.throws(
    () => runner.parseReal10xReleaseContract(duplicate),
    /real 10x release contract.*duplicate/i,
  )
})

test('preflight trusts all repository hooks but blocks on missing caller-owned C10 prepare authority', async () => {
  const contract = await loadContract()
  const { preflightReleaseGate } = await loadRunner()
  const existing = new Set(contract.cycles.map(({ hook }) => hook?.module).filter(Boolean))
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

  assert.deepEqual(
    result.blockers.filter(({ kind }) => kind === 'missing-hook'),
    [],
  )
  assert.deepEqual(
    result.blockers.filter(({ kind }) => kind === 'grading-calibration-approval'),
    [
      {
        kind: 'grading-calibration-approval',
        reason: 'approved calibration artifact and release config digests are required',
      },
    ],
  )
  assert.deepEqual(
    result.blockers
      .filter(({ kind, cycle }) => kind === 'environment' && cycle === 'C10')
      .map(({ name }) => name),
    [
      'HEX_K12_C10_PREPARE_AUTHORIZED',
      'HEX_K12_C10_PREPARE_HOOK',
      'HEX_K12_C10_PREPARE_HOOK_SHA256',
    ],
  )
  assert.equal(result.ready, false)
})

test('K12-REAL10X-PREFLIGHT-OBS-001 names every cycle-scoped C10 prepare environment blocker', async () => {
  const contract = await loadContract()
  const { runGate } = await loadRunner()
  const stderr = []
  const env = {
    HEX_K12_REAL_10X_RUN_ID: 'release-run',
    ...Object.fromEntries(
      Object.entries(contract.requiredEnvironment.exact).map(([name, value]) => [name, value]),
    ),
    ...Object.fromEntries(
      contract.requiredEnvironment.values.map((name) => [name, 'explicit-test-input']),
    ),
  }
  const processLike = {
    exitCode: 0,
    stderr: { write: (value) => stderr.push(value) },
  }

  await runGate(['--strict'], {
    env,
    processLike,
    writeGateReport: async () => {},
  })

  const output = stderr.join('')
  assert.equal(processLike.exitCode, 2)
  for (const name of [
    'HEX_K12_C10_PREPARE_AUTHORIZED',
    'HEX_K12_C10_PREPARE_HOOK',
    'HEX_K12_C10_PREPARE_HOOK_SHA256',
  ]) {
    assert.match(output, new RegExp(`C10 installed-app-sidecar-restart-recovery \\u00b7 ${name}:`))
  }
  assert.doesNotMatch(output, /explicit-test-input/)
})

test('BUG-TEST-INFRA-K12-REAL-10X rejects every unselected broad lane before any child starts', async () => {
  const contract = await loadContract()
  const { preflightReleaseGate } = await loadRunner()
  const existing = new Set(contract.cycles.map(({ hook }) => hook?.module).filter(Boolean))
  const malformed = structuredClone(contract)
  for (const cycle of malformed.cycles) delete cycle.hook.cycle_selector
  const result = preflightReleaseGate(malformed, {
    env: {
      HEX_K12_REAL_10X_RUN_ID: 'release-run',
      HEX_K12_LIVE_PROVIDER: 'hexclaw-gpt',
      HEX_K12_LIVE_EXPECTED_PROVIDER_DISPLAY: 'HexClaw-GPT',
      HEX_K12_LIVE_MODEL: 'gpt-5.6-sol',
      HEX_K12_RAG_EMBEDDING_MODEL: 'qwen3-embedding:8b',
    },
    hookExists: (module) => existing.has(module),
  })

  assert.deepEqual(
    result.blockers.filter(({ kind }) => kind === 'cycle-selector').map(({ cycle }) => cycle),
    cycleIds,
  )
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
      cycle_selector: cycle.id,
    }
  }

  const result = executeReleasePlan(runnable, {
    baseRunId: 'release-run',
    env: {
      DINGTALK_LIVE_SEND: '1',
      HEX_K12_LIVE_APP_URL: 'http://localhost:16060',
      HEX_K12_LIVE_SIDECAR_URL: 'http://127.0.0.1:16129',
    },
    knowledgeLineage: {
      path: '/tmp/hexclaw-k12-lineage/knowledge-lineage.json',
    },
    prepareC10Handoff: () => preparedC10Environment(),
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
    calls.map(({ env }) => env.HEX_K12_REAL_10X_PARENT_OWNS_LIFECYCLE),
    Array(10).fill('1'),
  )
  assert.deepEqual(
    calls.map(({ env }) => env.HEX_E2E_BASE_URL),
    Array(10).fill('http://localhost:16060'),
  )
  assert.deepEqual(
    calls.map(({ env }) => env.HEX_E2E_SIDECAR_URL),
    Array(10).fill('http://127.0.0.1:16129'),
  )
  assert.deepEqual(
    calls.map(({ command }) => command),
    Array(10).fill(process.execPath),
  )
})

test('runner archives C05 and C06 current-bug reports and attachments before the fixed child paths are reused', async () => {
  const contract = await loadContract()
  const { executeReleasePlan } = await loadRunner()
  const runnable = structuredClone(contract)
  runnable.cycles = runnable.cycles.filter(({ id }) => id === 'C05' || id === 'C06')
  const root = mkdtempSync(join(tmpdir(), 'k12-real-10x-cycle-evidence-'))
  const sourceRoot = join(root, 'test-results/k12-current-bug-live')
  const runID = 'release-cycle-evidence'
  const runDigest = createHash('sha256').update(runID).digest('hex')

  try {
    const result = executeReleasePlan(runnable, {
      baseRunId: runID,
      cwd: root,
      env: {},
      spawn: (_command, _args, options) => {
        const cycle = options.env.HEX_K12_REAL_10X_CYCLE_ID
        rmSync(sourceRoot, { recursive: true, force: true })
        mkdirSync(join(sourceRoot, 'artifacts'), { recursive: true })
        writeFileSync(join(sourceRoot, 'report.json'), `${JSON.stringify({ cycle })}\n`)
        writeFileSync(join(sourceRoot, 'artifacts', 'provider-receipt.json'), `${cycle}\n`)
        return { status: 0 }
      },
    })

    assert.equal(result.status, 'passed')
    for (const [index, cycle] of ['C05', 'C06'].entries()) {
      const archiveRoot = join(
        root,
        'test-results/k12-real-10x-release/runs',
        runDigest,
        cycle,
        'current-bug-live',
      )
      assert.deepEqual(JSON.parse(readFileSync(join(archiveRoot, 'report.json'), 'utf8')), {
        cycle,
      })
      assert.equal(
        readFileSync(join(archiveRoot, 'artifacts', 'provider-receipt.json'), 'utf8'),
        `${cycle}\n`,
      )
      const manifest = JSON.parse(readFileSync(join(archiveRoot, 'manifest.json'), 'utf8'))
      assert.equal(manifest.cycle_id, cycle)
      assert.deepEqual(
        manifest.attachments.map(({ path }) => path),
        ['artifacts/provider-receipt.json'],
      )
      assert.equal(
        result.cycles[index].evidence.manifest_path,
        `test-results/k12-real-10x-release/runs/${runDigest}/${cycle}/current-bug-live/manifest.json`,
      )
      assert.match(result.cycles[index].evidence.manifest_sha256, /^[a-f0-9]{64}$/)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
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
      cycle_selector: cycle.id,
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

test('BUG-TEST-INFRA-K12-REAL-10X parent owns one fixture and Sidecar lifecycle across every child', async () => {
  const contract = await loadContract()
  const { executeComposedReleasePlan } = await loadRunner()
  assert.equal(typeof executeComposedReleasePlan, 'function')
  const runnable = structuredClone(contract)
  for (const cycle of runnable.cycles) {
    cycle.hook = {
      lane: `trusted-${cycle.id}`,
      module: `scripts/ci/trusted-${cycle.id}.mjs`,
      args: ['--strict'],
      cycle_selector: cycle.id,
    }
  }
  const lifecycle = []
  const childCalls = []
  const result = await executeComposedReleasePlan(runnable, {
    baseRunId: 'release-run',
    env: {},
    runtime: {
      stopSidecar: async () => lifecycle.push('stop'),
      startFixture: async () => lifecycle.push('fixture-start'),
      readManifest: async () => {
        lifecycle.push('manifest-read')
        return { retryableDispatchID: 'retryable', outcomeUnknownDispatchID: 'outcome-unknown' }
      },
      startSidecar: async () => lifecycle.push('sidecar-start'),
      cleanupFixture: async () => lifecycle.push('fixture-cleanup'),
    },
    prepareC10Handoff: () => preparedC10Environment(),
    spawn: (_command, _args, options) => {
      childCalls.push(options.env)
      return { status: 0 }
    },
  })

  assert.equal(result.status, 'passed')
  assert.deepEqual(lifecycle, [
    'stop',
    'fixture-start',
    'manifest-read',
    'sidecar-start',
    'stop',
    'fixture-cleanup',
  ])
  assert.equal(childCalls.length, 10)
  for (const env of childCalls) {
    assert.equal(env.HEX_K12_LIVE_RETRYABLE_DISPATCH_ID, 'retryable')
    assert.equal(env.HEX_K12_LIVE_OUTCOME_UNKNOWN_DISPATCH_ID, 'outcome-unknown')
  }
})

test('BUG-TEST-INFRA-K12-REAL-10X parent gives the private knowledge lineage only to C07-C10 and cleans it after the terminal child', async () => {
  const contract = await loadContract()
  const { executeComposedReleasePlan } = await loadRunner()
  const runnable = structuredClone(contract)
  for (const cycle of runnable.cycles) {
    cycle.hook = {
      lane: `trusted-${cycle.id}`,
      module: `scripts/ci/trusted-${cycle.id}.mjs`,
      args: ['--strict'],
      cycle_selector: cycle.id,
    }
  }
  const lifecycle = []
  const childCalls = []
  const lineage = {
    root: '/tmp/hexclaw-k12-lineage/knowledge-lineage',
    path: '/tmp/hexclaw-k12-lineage/knowledge-lineage/knowledge-lineage.json',
    parentRunSha256: 'a'.repeat(64),
  }

  const result = await executeComposedReleasePlan(runnable, {
    baseRunId: 'release-run',
    env: {},
    runtime: {
      stopSidecar: async () => lifecycle.push('stop'),
      startFixture: async () => lifecycle.push('fixture-start'),
      readManifest: async () => {
        lifecycle.push('manifest-read')
        return { retryableDispatchID: 'retryable', outcomeUnknownDispatchID: 'outcome-unknown' }
      },
      startSidecar: async () => lifecycle.push('sidecar-start'),
      cleanupFixture: async () => lifecycle.push('fixture-cleanup'),
    },
    createKnowledgeLineage: async ({ parentRunId }) => {
      assert.equal(parentRunId, 'release-run')
      lifecycle.push('lineage-create')
      return lineage
    },
    cleanupKnowledgeLineage: async (actual) => {
      assert.equal(actual, lineage)
      lifecycle.push('lineage-cleanup')
    },
    prepareC10Handoff: () => preparedC10Environment(),
    spawn: (_command, _args, options) => {
      childCalls.push(options.env)
      return { status: 0 }
    },
  })

  assert.equal(result.status, 'passed')
  assert.deepEqual(lifecycle, [
    'stop',
    'fixture-start',
    'manifest-read',
    'sidecar-start',
    'lineage-create',
    'stop',
    'fixture-cleanup',
    'lineage-cleanup',
  ])
  for (const [index, env] of childCalls.entries()) {
    const cycle = cycleIds[index]
    if (['C07', 'C08', 'C09', 'C10'].includes(cycle)) {
      assert.equal(env.HEX_K12_REAL_10X_KNOWLEDGE_LINEAGE_PATH, lineage.path)
      assert.equal(env.HEX_K12_REAL_10X_PARENT_RUN_ID, 'release-run')
    } else {
      assert.equal(env.HEX_K12_REAL_10X_KNOWLEDGE_LINEAGE_PATH, undefined)
      assert.equal(env.HEX_K12_REAL_10X_PARENT_RUN_ID, undefined)
    }
  }
})

test('BUG-TEST-INFRA-K12-REAL-10X parent cleans up and preserves the lifecycle failure', async () => {
  const contract = await loadContract()
  const { executeComposedReleasePlan } = await loadRunner()
  const failure = new Error('sidecar-start-failed')
  const lifecycle = []

  await assert.rejects(
    () =>
      executeComposedReleasePlan(contract, {
        baseRunId: 'release-run',
        env: {},
        runtime: {
          stopSidecar: async () => lifecycle.push('stop'),
          startFixture: async () => lifecycle.push('fixture-start'),
          readManifest: async () => {
            lifecycle.push('manifest-read')
            return { retryableDispatchID: 'retryable', outcomeUnknownDispatchID: 'outcome-unknown' }
          },
          startSidecar: async () => {
            lifecycle.push('sidecar-start')
            throw failure
          },
          cleanupFixture: async () => lifecycle.push('fixture-cleanup'),
        },
      }),
    failure,
  )

  assert.deepEqual(lifecycle, [
    'stop',
    'fixture-start',
    'manifest-read',
    'sidecar-start',
    'stop',
    'fixture-cleanup',
  ])
})

test('release CLI wires a preflight-passing contract through the parent-owned composed lifecycle', async () => {
  const contract = await loadContract()
  const { runGate } = await loadRunner()
  const runnable = structuredClone(contract)
  for (const cycle of runnable.cycles) {
    cycle.hook = {
      lane: `trusted-${cycle.id}`,
      module: `scripts/ci/trusted-${cycle.id}.mjs`,
      args: ['--strict'],
      cycle_selector: cycle.id,
    }
  }
  const reports = []
  const processLike = { stderr: { write() {} }, exitCode: undefined }
  const runtime = { marker: 'parent-runtime' }
  let composed

  await runGate(['--strict'], {
    env: { HEX_K12_REAL_10X_RUN_ID: 'release-run' },
    contractValue: runnable,
    preflight: () => ({ ready: true, blockers: [] }),
    validateEnvironment: (env, options) => {
      assert.equal(env.HEX_K12_REAL_10X_RUN_ID, 'release-run')
      assert.equal(options.gradingCalibrationApproval, runnable.gradingCalibrationApproval)
      return { fixture: 'validated' }
    },
    createRuntime: (fixture) => {
      assert.deepEqual(fixture, { fixture: 'validated' })
      return runtime
    },
    executeComposedPlan: async (contractValue, options) => {
      composed = { contractValue, options }
      return { status: 'passed', cycles: [] }
    },
    writeGateReport: async (report) => reports.push(report),
    processLike,
  })

  assert.equal(composed.contractValue, runnable)
  assert.equal(composed.options.baseRunId, 'release-run')
  assert.equal(composed.options.runtime, runtime)
  assert.equal(processLike.exitCode, 0)
  assert.deepEqual(reports, [{ schemaVersion: 1, status: 'passed', cycles: [] }])
})

test('K12-REAL10X-C10-HANDOFF-001 runs one parent-owned handoff prepare after C09 and before C10', async () => {
  const contract = await loadContract()
  const { executeReleasePlan } = await loadRunner()
  const runnable = structuredClone(contract)
  for (const cycle of runnable.cycles) {
    cycle.hook = {
      lane: `trusted-${cycle.id}`,
      module: `scripts/ci/trusted-${cycle.id}.mjs`,
      args: ['--strict'],
      cycle_selector: cycle.id,
    }
  }
  const events = []
  const preparedEnvironment = {
    HEX_K12_C10_RESTART_AUTHORIZED: '1',
    HEX_K12_C10_RESTART_HOOK: '/tmp/k12-c10/restart-driver',
    HEX_K12_C10_RESTART_HOOK_SHA256: 'a'.repeat(64),
    HEX_K12_C10_HANDOFF_PUBLIC_KEY: '/tmp/k12-c10/pre-public.pem',
    HEX_K12_C10_HANDOFF_PUBLIC_KEY_SHA256: 'b'.repeat(64),
    HEX_K12_C10_BEFORE_HANDOFF: '/tmp/k12-c10/before.json',
    HEX_K12_C10_AFTER_HANDOFF: '/tmp/k12-c10/after.json',
    HEX_K12_C10_AFTER_HANDOFF_PUBLIC_KEY: '/tmp/k12-c10/after-public.pem',
    HEX_K12_C10_DRIVER_CONFIG: '/tmp/k12-c10/driver.json',
  }

  const result = executeReleasePlan(runnable, {
    baseRunId: 'release-run',
    env: {},
    knowledgeLineage: {
      path: '/tmp/hexclaw-k12-lineage/knowledge-lineage.json',
    },
    prepareC10Handoff: (options) => {
      events.push(`prepare:${options.cycleRunId}`)
      assert.equal(options.cycle.id, 'C10')
      assert.equal(options.parentRunId, 'release-run')
      assert.equal(options.knowledgeLineage.path, '/tmp/hexclaw-k12-lineage/knowledge-lineage.json')
      return preparedEnvironment
    },
    spawn: (_command, _args, options) => {
      events.push(`child:${options.env.HEX_K12_REAL_10X_CYCLE_ID}`)
      if (options.env.HEX_K12_REAL_10X_CYCLE_ID === 'C10') {
        assert.deepEqual(
          Object.fromEntries(
            Object.keys(preparedEnvironment).map((name) => [name, options.env[name]]),
          ),
          preparedEnvironment,
        )
      }
      return { status: 0 }
    },
  })

  assert.equal(result.status, 'passed')
  assert.deepEqual(events, [
    ...cycleIds.slice(0, 9).map((id) => `child:${id}`),
    'prepare:release-run-C10',
    'child:C10',
  ])
})

test('K12-REAL10X-C10-HANDOFF-002 accepts only the current C10 run and exact dynamic handoff environment', async () => {
  const { validatePreparedC10Handoff } = await loadRunner()
  const environment = {
    HEX_K12_C10_RESTART_HOOK: '/tmp/k12-c10/restart-driver',
    HEX_K12_C10_RESTART_HOOK_SHA256: 'a'.repeat(64),
    HEX_K12_C10_HANDOFF_PUBLIC_KEY: '/tmp/k12-c10/pre-public.pem',
    HEX_K12_C10_HANDOFF_PUBLIC_KEY_SHA256: 'b'.repeat(64),
    HEX_K12_C10_BEFORE_HANDOFF: '/tmp/k12-c10/before.json',
    HEX_K12_C10_AFTER_HANDOFF: '/tmp/k12-c10/after.json',
    HEX_K12_C10_AFTER_HANDOFF_PUBLIC_KEY: '/tmp/k12-c10/after-public.pem',
    HEX_K12_C10_DRIVER_CONFIG: '/tmp/k12-c10/driver.json',
  }
  const manifest = {
    schema_version: 1,
    cycle_id: 'C10',
    run_id: 'release-run-C10',
    parent_run_sha256: createHash('sha256').update('release-run').digest('hex'),
    environment,
  }

  assert.deepEqual(
    validatePreparedC10Handoff(manifest, {
      cycleRunId: 'release-run-C10',
      parentRunId: 'release-run',
    }),
    { HEX_K12_C10_RESTART_AUTHORIZED: '1', ...environment },
  )
  assert.throws(
    () =>
      validatePreparedC10Handoff(
        { ...manifest, run_id: 'old-run-C10' },
        { cycleRunId: 'release-run-C10', parentRunId: 'release-run' },
      ),
    /run ID/i,
  )
  assert.throws(
    () =>
      validatePreparedC10Handoff(
        { ...manifest, environment: { ...environment, EXTRA: 'forbidden' } },
        { cycleRunId: 'release-run-C10', parentRunId: 'release-run' },
      ),
    /exact field set/i,
  )
})

test('K12-REAL10X-C10-HANDOFF-001 executes only the SHA-pinned caller hook with a private current-run manifest', async () => {
  const { executeCallerC10HandoffPrepare } = await loadRunner()
  const root = mkdtempSync(join(tmpdir(), 'hexclaw-c10-prepare-'))
  try {
    const hookPath = join(root, 'prepare-hook')
    const manifestPath = join(root, 'manifest.json')
    writeFileSync(hookPath, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    chmodSync(hookPath, 0o700)
    writeFileSync(
      manifestPath,
      `${JSON.stringify({
        schema_version: 1,
        cycle_id: 'C10',
        run_id: 'release-run-C10',
        parent_run_sha256: createHash('sha256').update('release-run').digest('hex'),
        environment: Object.fromEntries(
          Object.entries(preparedC10Environment()).filter(
            ([name]) => name !== 'HEX_K12_C10_RESTART_AUTHORIZED',
          ),
        ),
      })}\n`,
      { mode: 0o600 },
    )
    chmodSync(manifestPath, 0o600)
    const calls = []

    const prepared = executeCallerC10HandoffPrepare({
      cycle: { id: 'C10' },
      cycleRunId: 'release-run-C10',
      parentRunId: 'release-run',
      knowledgeLineage: { path: join(root, 'knowledge-lineage.json') },
      env: {
        DINGTALK_LIVE_SEND: '1',
        HEX_K12_C10_PREPARE_AUTHORIZED: '1',
        HEX_K12_C10_PREPARE_HOOK: hookPath,
        HEX_K12_C10_PREPARE_HOOK_SHA256: createHash('sha256')
          .update('#!/bin/sh\nexit 0\n')
          .digest('hex'),
      },
      spawn: (command, args, options) => {
        calls.push({ command, args, options })
        return { status: 0, stdout: `${manifestPath}\n` }
      },
    })

    assert.deepEqual(prepared, preparedC10Environment())
    assert.equal(calls.length, 1)
    assert.equal(calls[0].command, hookPath)
    assert.deepEqual(calls[0].args, ['--prepare-c10-handoff'])
    assert.equal(calls[0].options.shell, false)
    assert.equal(calls[0].options.env.DINGTALK_LIVE_SEND, '0')
    assert.equal(calls[0].options.env.HEX_K12_REAL_10X_CYCLE_RUN_ID, 'release-run-C10')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
