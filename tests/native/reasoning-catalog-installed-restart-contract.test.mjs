import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const nativeDir = dirname(fileURLToPath(import.meta.url))
const runnerPath = join(nativeDir, 'reasoning-catalog-installed-restart.mjs')

async function loadRunner() {
  assert.ok(existsSync(runnerPath), 'reasoning catalog installed restart runner is missing')
  return import(pathToFileURL(runnerPath).href)
}

function catalogFixture(overrides = {}) {
  const base = {
    default: 'hexclaw-gpt',
    reasoning_provider: 'hexclaw-gpt',
    reasoning_model: 'gpt-5.6-sol',
    providers: {
      'hexclaw-gpt': {
        model: 'gpt-5.6-sol',
        models: ['gpt-5.6-sol'],
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
  return { ...base, ...overrides }
}

function validRestartInput(projection) {
  return {
    installedIdentity: {
      identifier: 'com.hexclaw.desktop',
      version: '0.5.0-beta',
      desktopSHA256: '1'.repeat(64),
      sidecarSHA256: '2'.repeat(64),
      infoPlistSHA256: '3'.repeat(64),
    },
    generations: [
      {
        name: 'generation-1',
        appPID: 101,
        sidecarPID: 201,
        apiAudit: [{ method: 'GET', path: '/api/v1/config/llm', status: 200 }],
        projection,
      },
      {
        name: 'generation-2',
        appPID: 102,
        sidecarPID: 202,
        apiAudit: [{ method: 'GET', path: '/api/v1/config/llm', status: 200 }],
        projection: structuredClone(projection),
      },
    ],
    providerBoundaryRequests: [],
    permissions: { testHome: 0o700, configDirectory: 0o700, yaml: 0o600 },
  }
}

test('installed restart runner exists for the contract suite', () => {
  assert.ok(existsSync(runnerPath), 'reasoning catalog installed restart runner is missing')
})

test('fixture YAML freezes the exact reasoning catalog without an IM binding', async () => {
  const { buildFixtureConfig } = await loadRunner()
  const yaml = buildFixtureConfig({
    fixtureHome: '/private/tmp/reasoning-fixture',
    sidecarPort: 31415,
    providerOrigin: 'http://127.0.0.1:27182',
  })

  for (const fragment of [
    'default: hexclaw-gpt',
    'reasoning_provider: hexclaw-gpt',
    'reasoning_model: gpt-5.6-sol',
    'model: gpt-5.6-sol',
    'model_specs_mode: explicit',
    'id: gpt-5.6-sol',
    'reasoning_support: supported',
    'dialect: reasoning_effort',
    'on: low',
    'off: none',
    'allowed_efforts: [low]',
    'path: "/private/tmp/reasoning-fixture/.hexclaw/data.db"',
  ]) {
    assert.match(yaml, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))
  }
  assert.doesNotMatch(yaml, /dingtalk|feishu|telegram|discord|slack/iu)
})

test('catalog projection accepts only the exact installed response contract', async () => {
  const { assertExactReasoningCatalog, EXPECTED_CATALOG_PROJECTION } = await loadRunner()
  assert.deepEqual(assertExactReasoningCatalog(catalogFixture()), EXPECTED_CATALOG_PROJECTION)

  const mutations = [
    (value) => {
      value.providers['hexclaw-gpt'].model_specs_mode = 'legacy'
    },
    (value) => {
      value.providers['hexclaw-gpt'].model_specs[0].reasoning_support = 'unknown'
    },
    (value) => {
      value.providers['hexclaw-gpt'].model_specs[0].reasoning_control.on = 'medium'
    },
    (value) => {
      value.providers['hexclaw-gpt'].model_specs[0].reasoning_control.allowed_efforts = [
        'low',
        'medium',
      ]
    },
    (value) => {
      value.providers['hexclaw-gpt'].model_specs.push({
        id: 'gpt-5.6-sol',
        reasoning_support: 'supported',
      })
    },
  ]
  for (const mutate of mutations) {
    const value = catalogFixture()
    mutate(value)
    assert.throws(() => assertExactReasoningCatalog(value))
  }
})

test('restart evidence fails closed on any extra API, reused Sidecar, or outbound call', async () => {
  const { assertExactReasoningCatalog, buildRestartEvidence } = await loadRunner()
  const projection = assertExactReasoningCatalog(catalogFixture())
  const evidence = buildRestartEvidence(validRestartInput(projection))

  assert.equal(evidence.status, 'PASS')
  assert.equal(evidence.fixture_only, true)
  assert.equal(evidence.real_provider, false)
  assert.equal(evidence.calls.model, 0)
  assert.equal(evidence.calls.im, 0)
  assert.equal(evidence.calls.provider_boundary, 0)
  assert.equal(evidence.restart.sidecar_pid_changed, true)
  assert.equal(evidence.restart.catalog_exact_after_restart, true)
  assert.deepEqual(evidence.catalog, projection)

  const cases = [
    (input) => {
      input.generations[1].sidecarPID = input.generations[0].sidecarPID
    },
    (input) => {
      input.generations[0].apiAudit.push({ method: 'GET', path: '/health', status: 200 })
    },
    (input) => {
      input.generations[0].apiAudit[0].method = 'POST'
    },
    (input) => {
      input.providerBoundaryRequests.push({ method: 'POST', path: '/v1/chat/completions' })
    },
    (input) => {
      input.permissions.yaml = 0o644
    },
    (input) => {
      input.modelInvocations = 1
    },
    (input) => {
      input.imInvocations = 1
    },
  ]
  for (const mutate of cases) {
    const input = validRestartInput(projection)
    mutate(input)
    assert.throws(() => buildRestartEvidence(input))
  }
})

test('source contract is isolated, GET-only, and never reads user config or SQLite directly', async () => {
  await loadRunner()
  const source = readFileSync(runnerPath, 'utf8')

  assert.match(source, /HEXCLAW_TEST_HOME/u)
  assert.match(source, /HEXCLAW_TEST_LLM_CONFIG_MODE/u)
  assert.match(source, /preseeded-owner-yaml/u)
  assert.match(source, /spawn\(installed\.desktopExecutable/u)
  assert.match(source, /installed\.sidecarExecutable/u)
  assert.match(source, /fixture_only:\s*true/u)
  assert.match(source, /real_provider:\s*false/u)
  assert.match(source, /model:\s*0/u)
  assert.match(source, /im:\s*0/u)
  assert.equal((source.match(/['"]\/api\/v1\/config\/llm['"]/gu) || []).length, 1)

  for (const forbidden of [
    /homedir\s*\(/u,
    /process\.env\.HOME/u,
    /\bHOME\s*:/u,
    /USERPROFILE\s*:/u,
    /execFileSync\(['"]sqlite3['"]/u,
    /from ['"]node:sqlite/u,
    /\/api\/v1\/chat/u,
    /\/api\/v1\/config\/llm\/(?:test|models|probe)/u,
    /\/api\/v1\/platform/u,
    /\/api\/v1\/im/u,
    /\bdws\b/u,
  ]) {
    assert.doesNotMatch(source, forbidden)
  }
})

test('validate is static-only and preserves installed identity without live calls', async () => {
  await loadRunner()
  const stdout = execFileSync(process.execPath, [runnerPath, 'validate'], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
      HEXCLAW_REASONING_CATALOG_INSTALLED_CANDIDATE:
        process.env.HEXCLAW_REASONING_CATALOG_INSTALLED_CANDIDATE || '/Applications/HexClaw.app',
    },
  })
  const result = JSON.parse(stdout)
  assert.equal(result.status, 'PASS')
  assert.equal(result.mode, 'static-only')
  assert.equal(result.appLaunched, false)
  assert.equal(result.sidecarStarted, false)
  assert.equal(result.fixture_only, true)
  assert.equal(result.real_provider, false)
  assert.equal(result.modelInvocations, 0)
  assert.equal(result.imInvocations, 0)
  assert.equal(result.installedIdentity.frozen, true)
  assert.equal(result.installedIdentity.unchanged, true)
})
