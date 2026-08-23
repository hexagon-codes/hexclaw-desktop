import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'
import test from 'node:test'

import { startReleaseStaticGateway } from '../../scripts/ci/k12-release-static-gateway.mjs'
import { parseStrictJSON } from '../../scripts/ci/k12-strict-json.mjs'

const repoRoot = new URL('../../', import.meta.url).pathname.replace(/\/$/, '')
const hexclawSource = join(repoRoot, '..', 'hexclaw')
const sourceConfig = join(homedir(), '.hexclaw', 'hexclaw.yaml')
const installedAppBinary = '/Applications/HexClaw.app/Contents/MacOS/hexclaw-desktop'
const installedSidecarBinary = '/Applications/HexClaw.app/Contents/MacOS/hexclaw'
const packageDir = join(repoRoot, 'src-tauri/target/release/bundle/dmg')
const packagePath = join(packageDir, 'HexClaw_0.5.0-beta_x64.dmg')
const receiptName = 'HexClaw_0.5.0-beta_x64.release-ui-attestation.json'
const manifestName = 'HexClaw_0.5.0-beta_x64.release-ui-dist-manifest.json'
const controllerPath = join(repoRoot, 'scripts/ci/k12-current-bug-isolated-sidecar-control.mjs')
const releaseUIURL = 'http://localhost:16060'
const sidecarURL = 'http://127.0.0.1:16129'
const creativeRealCases = {
  'agent-delete': {
    config: 'playwright.k12.creative-delete.system-chrome.config.ts',
    title:
      'art upload stores the frozen image under the exact Tutor owner and round-trips its bytes',
    activeDelete: true,
  },
  'art-feedback': {
    config: 'playwright.k12.creative-delete.system-chrome.config.ts',
    title: 'art save automatically produces feedback that cites visible elements',
  },
  'assistant-identity': {
    config: 'playwright.k12.identity.system-chrome.config.ts',
    title:
      'BUG-20260726-029 installed real model keeps the exact assistant identity across prompts and restart',
  },
  'assistant-identity-isolation': {
    config: 'playwright.k12.identity.system-chrome.config.ts',
    title: 'BUG-20260726-029 installed real model isolates identity across two children',
  },
}

test('agent-delete lane requires an observed durable sent receipt before the production DELETE', async () => {
  const source = await readFile(join(repoRoot, 'tests/e2e/creative-real-fixtures.spec.ts'), 'utf8')

  assert.equal(creativeRealCases['agent-delete'].activeDelete, true)
  assert.match(source, /waitForSentWorkFeedbackInvocation/)
  assert.match(source, /invocation_status:\s*'sent'/)
  assert.match(source, /delete_http_status:\s*200/)
  assert.match(source, /active-delete-receipt\.json/)
})

const candidatePolicy = {
  policy_version: 1,
  queued_seconds: 600,
  normalizing_seconds: 600,
  recognizing_seconds: 600,
  locating_seconds: 600,
  rendering_seconds: 600,
  projecting_seconds: 600,
  recognition_plan_version: 1,
  assessing_buckets: [
    { max_problems: 1, seconds: 600 },
    { max_problems: 8, seconds: 600 },
    { max_problems: 16, seconds: 600 },
    { max_problems: 32, seconds: 600 },
  ],
  item_concurrency: 1,
}

function runProcess(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const append = (current, chunk) => `${current}${chunk}`.slice(-2 * 1024 * 1024)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout = append(stdout, chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr = append(stderr, chunk)
    })
    child.once('error', rejectPromise)
    child.once('close', (code, signal) => {
      const status = Number.isInteger(code) ? code : 1
      if (status !== 0 && !options.accept?.includes(status)) {
        rejectPromise(
          new Error(`${options.label ?? command} failed (${signal ?? status}); output redacted`),
        )
        return
      }
      resolvePromise({ status, stdout, stderr })
    })
  })
}

async function exists(pathname) {
  return access(pathname).then(
    () => true,
    () => false,
  )
}

async function privateWrite(pathname, bytes) {
  await writeFile(pathname, bytes, { mode: 0o600, flag: 'wx' })
  await chmod(pathname, 0o600)
}

async function privateCopy(source, target) {
  await copyFile(source, target)
  await chmod(target, 0o600)
}

async function fileSHA256(pathname) {
  return createHash('sha256')
    .update(await readFile(pathname))
    .digest('hex')
}

const activeDeleteCountKeys = [
  'agent_rows',
  'creative_work_rows',
  'feedback_generation_rows',
  'image_task_invocation_rows',
  'image_task_dispatch_rows',
  'creative_intake_rows',
  'current_create_receipt_rows',
  'agent_rule_rows',
]

function exactKeys(value, expected, label) {
  assert.ok(
    value && typeof value === 'object' && !Array.isArray(value),
    `${label} must be an object`,
  )
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${label} exact field set`)
}

function assertZeroCounts(value, label) {
  exactKeys(value, activeDeleteCountKeys, label)
  for (const key of activeDeleteCountKeys) assert.equal(value[key], 0, `${label}.${key}`)
}

export function validateActiveDeleteReceipt(value) {
  exactKeys(
    value,
    [
      'schema_version',
      'transition',
      'before_delete',
      'delete_http_status',
      'after_delete',
      'dingtalk_sends',
    ],
    'active-delete receipt',
  )
  assert.equal(value.schema_version, 1)
  assert.deepEqual(value.transition, ['sent', 'delete_200', 'cascade_zero'])
  exactKeys(
    value.before_delete,
    [
      'invocation_status',
      'invocation_id_sha256',
      'provider_request_key_sha256',
      'attempt',
      'provider_call_rows',
      'target_rows',
    ],
    'active-delete before_delete',
  )
  assert.equal(value.before_delete.invocation_status, 'sent')
  assert.match(value.before_delete.invocation_id_sha256, /^[a-f0-9]{64}$/)
  assert.match(value.before_delete.provider_request_key_sha256, /^[a-f0-9]{64}$/)
  assert.equal(value.before_delete.attempt, 1)
  assert.equal(value.before_delete.provider_call_rows, 1)
  exactKeys(value.before_delete.target_rows, activeDeleteCountKeys, 'active-delete target_rows')
  for (const key of [
    'agent_rows',
    'creative_work_rows',
    'feedback_generation_rows',
    'image_task_invocation_rows',
  ]) {
    assert.equal(value.before_delete.target_rows[key], 1, `active-delete target_rows.${key}`)
  }
  assert.equal(value.delete_http_status, 200)
  exactKeys(
    value.after_delete,
    [
      'first_snapshot',
      'observation_ms',
      'second_snapshot',
      'agent_api_rows',
      'creative_work_api_rows',
      'asset_http_status',
    ],
    'active-delete after_delete',
  )
  assertZeroCounts(value.after_delete.first_snapshot, 'active-delete first_snapshot')
  assert.equal(value.after_delete.observation_ms, 500)
  assertZeroCounts(value.after_delete.second_snapshot, 'active-delete second_snapshot')
  assert.equal(value.after_delete.agent_api_rows, 0)
  assert.equal(value.after_delete.creative_work_api_rows, 0)
  assert.equal(value.after_delete.asset_http_status, 404)
  assert.equal(value.dingtalk_sends, 0)
  return value
}

async function findNamedFiles(root, name, matches = []) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const pathname = join(root, entry.name)
    assert.equal(entry.isSymbolicLink(), false, 'Playwright evidence must not contain symlinks')
    if (entry.isDirectory()) {
      await findNamedFiles(pathname, name, matches)
    } else if (entry.isFile() && entry.name === name) {
      matches.push(pathname)
    }
  }
  return matches
}

async function persistActiveDeleteReceipt(playwrightOutput) {
  const matches = await findNamedFiles(playwrightOutput, 'active-delete-receipt.json')
  assert.equal(matches.length, 1, 'agent-delete must produce one active-delete receipt')
  const source = matches[0]
  const sourceStat = await stat(source)
  assert.equal(sourceStat.isFile(), true)
  assert.equal(sourceStat.mode & 0o777, 0o600)
  const bytes = await readFile(source)
  const receipt = validateActiveDeleteReceipt(
    parseStrictJSON(bytes.toString('utf8'), { label: 'K12 creative active-delete receipt' }),
  )
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const evidenceRoot = join(repoRoot, 'test-results/k12-creative-delete-real')
  const evidencePath = join(evidenceRoot, `${sha256}.json`)
  await mkdir(evidenceRoot, { recursive: true, mode: 0o700 })
  if (await exists(evidencePath)) {
    assert.equal(await fileSHA256(evidencePath), sha256)
  } else {
    await privateWrite(evidencePath, bytes)
  }
  return {
    receipt,
    receipt_sha256: sha256,
    evidence_path: relative(repoRoot, evidencePath),
  }
}

function lastJSON(stdout, label) {
  try {
    return JSON.parse(stdout.trim().split(/\r?\n/).at(-1))
  } catch {
    throw new Error(`${label} did not return a JSON receipt (body redacted)`)
  }
}

async function assertStopped(config) {
  assert.equal(await exists(config.pid_file), false)
  assert.equal(await exists(config.lock_file), false)
  const listener = await runProcess('lsof', ['-nP', `-iTCP:${config.port}`, '-sTCP:LISTEN', '-t'], {
    accept: [1],
    label: 'listener inspection',
  })
  assert.equal(listener.status, 1)
  const health = await fetch(`${config.sidecar_url}/health`, {
    signal: AbortSignal.timeout(2_000),
  }).catch(() => undefined)
  assert.equal(health, undefined)
}

function failureClass(result) {
  const output = `${result.stdout}\n${result.stderr}`
  const identityLines = [...output.matchAll(/k12-identity-real\.spec\.ts:(\d+):\d+/g)]
    .map((match) => Number(match[1]))
    .filter(Number.isSafeInteger)
  if (/identity contract version must persist/.test(output)) return 'identity-contract-version'
  if (identityLines.some((line) => line >= 41 && line <= 45)) return 'identity-ui-entry'
  if (identityLines.some((line) => line >= 49 && line <= 60)) return 'identity-message-transport'
  if (identityLines.some((line) => line >= 79 && line <= 92)) return 'identity-response-contract'
  if (/DELETE .* failed: 500 \(body redacted\)/.test(output)) return 'agent-delete-500'
  if (/Target page, context or browser has been closed/.test(output)) return 'browser-closed'
  if (/timed out|Timeout/i.test(output)) return 'timeout'
  return 'other-redacted'
}

test(
  'installed real model runs one selected creative boundary case',
  {
    skip:
      process.env.HEX_K12_CREATIVE_DELETE_REAL !== '1' && process.env.HEX_K12_CREATIVE_REAL !== '1',
    timeout: 30 * 60_000,
  },
  async (t) => {
    const caseID = process.env.HEX_K12_CREATIVE_REAL_CASE?.trim() || 'agent-delete'
    const selectedCase = creativeRealCases[caseID]
    assert.ok(selectedCase, `unsupported HEX_K12_CREATIVE_REAL_CASE=${caseID}`)
    const root = await mkdtemp('/tmp/hexclaw-k12-creative-delete-')
    await chmod(root, 0o700)
    const canonicalRoot = await realpath(root)
    assert.match(canonicalRoot, /^\/private\/tmp\/hexclaw-k12-creative-delete-/)

    const profileData = join(root, '.hexclaw')
    const storePath = join(profileData, 'data.db')
    const policyPath = join(root, 'candidate-policy.json')
    const receiptPath = join(root, receiptName)
    const distManifestPath = join(root, manifestName)
    const controllerConfigPath = join(root, 'controller.json')
    const playwrightOutput = join(root, 'playwright-artifacts')
    let gateway
    let controllerConfig
    const runController = (action, accept = []) =>
      runProcess(controllerPath, [action, '--config', controllerConfigPath], {
        accept,
        label: `Sidecar controller ${action}`,
      })

    t.after(async () => {
      if (controllerConfig) await runController('stop', [1]).catch(() => undefined)
      if (gateway) await gateway.close().catch(() => undefined)
      if (
        canonicalRoot.startsWith('/private/tmp/hexclaw-k12-creative-delete-') ||
        canonicalRoot.startsWith('/tmp/hexclaw-k12-creative-delete-')
      ) {
        await rm(canonicalRoot, { recursive: true, force: true })
      }
    })

    await mkdir(profileData, { mode: 0o700 })
    await privateWrite(storePath, '')
    await privateWrite(policyPath, `${JSON.stringify(candidatePolicy)}\n`)
    await privateCopy(join(packageDir, receiptName), receiptPath)
    await privateCopy(join(packageDir, manifestName), distManifestPath)
    assert.equal((await stat(sourceConfig)).mode & 0o777, 0o600)

    const prepared = await runProcess(
      'go',
      [
        'run',
        '-tags',
        'testtools',
        './cmd/k12-live-fixture-testtools',
        'prepare-profile',
        '--source-config',
        sourceConfig,
        '--profile',
        root,
        '--store',
        storePath,
        '--port',
        '16129',
        '--candidate-policy',
        policyPath,
      ],
      {
        cwd: hexclawSource,
        env: { ...process.env, GOWORK: 'off', DINGTALK_LIVE_SEND: '0' },
        label: 'isolated profile preparation',
      },
    )
    const preparedReceipt = lastJSON(prepared.stdout, 'isolated profile preparation')
    assert.equal(preparedReceipt.status, 'prepared')

    const releaseReceipt = JSON.parse(await readFile(receiptPath, 'utf8'))
    const appSHA256 = await fileSHA256(installedAppBinary)
    const sidecarSHA256 = await fileSHA256(installedSidecarBinary)
    const receiptSHA256 = await fileSHA256(receiptPath)
    assert.equal(releaseReceipt.release_version, '0.5.0-beta')
    assert.equal(releaseReceipt.installed_app_sha256, appSHA256)
    assert.equal(releaseReceipt.sidecar_sha256, sidecarSHA256)
    assert.equal(releaseReceipt.package_sha256, await fileSHA256(packagePath))
    assert.equal(releaseReceipt.dist_manifest_sha256, await fileSHA256(distManifestPath))

    gateway = await startReleaseStaticGateway({
      schema_version: 1,
      host: '127.0.0.1',
      port: 16060,
      release_version: '0.5.0-beta',
      dist_root: join(repoRoot, 'dist'),
      installed_app_binary: installedAppBinary,
      sidecar_binary: installedSidecarBinary,
      package_path: packagePath,
      dist_manifest_path: distManifestPath,
      release_attestation_path: receiptPath,
      release_attestation_sha256: receiptSHA256,
      sidecar_url: sidecarURL,
    })

    controllerConfig = {
      schema_version: 2,
      profile_dir: root,
      sidecar_config_path: join(profileData, 'hexclaw.yaml'),
      sidecar_config_sha256: preparedReceipt.config_sha256,
      binary_path: installedSidecarBinary,
      binary_sha256: sidecarSHA256,
      expected_version: '0.5.0-beta',
      host: '127.0.0.1',
      port: 16129,
      sidecar_url: sidecarURL,
      release_ui_url: releaseUIURL,
      release_attestation_path: receiptPath,
      release_attestation_sha256: receiptSHA256,
      pid_file: join(profileData, '.k12-sidecar.pid'),
      lock_file: join(profileData, '.sidecar.lock'),
      startup_timeout_ms: 120_000,
      shutdown_timeout_ms: 120_000,
    }
    await privateWrite(controllerConfigPath, `${JSON.stringify(controllerConfig)}\n`)
    await runController('start')

    const llm = await fetch(`${sidecarURL}/api/v1/config/llm`, {
      signal: AbortSignal.timeout(30_000),
    })
    assert.equal(llm.status, 200)
    const llmConfig = await llm.json()
    assert.equal(llmConfig.default, 'hexclaw-gpt')
    assert.equal(llmConfig.providers?.['hexclaw-gpt']?.model, 'gpt-5.6-sol')

    const playwright = await runProcess(
      'pnpm',
      ['exec', 'playwright', 'test', '-c', selectedCase.config, '--grep', selectedCase.title],
      {
        cwd: repoRoot,
        accept: [1],
        label: 'creative delete System Chrome narrow',
        env: {
          ...process.env,
          DINGTALK_LIVE_SEND: '0',
          HEX_E2E_BASE_URL: releaseUIURL,
          HEX_E2E_SIDECAR_URL: sidecarURL,
          HEX_E2E_PROVIDER: 'hexclaw-gpt',
          HEX_E2E_MODEL: 'gpt-5.6-sol',
          HEX_K12_ACCEPTANCE_LIVE: '1',
          HEX_K12_REAL_MODEL: '1',
          HEX_K12_CREATIVE_AI: '1',
          HEX_K12_CREATIVE_DELETE_OUTPUT_DIR: playwrightOutput,
          HEX_K12_IDENTITY_OUTPUT_DIR: playwrightOutput,
          HEX_E2E_SIDECAR_CONTROLLER: controllerPath,
          HEX_E2E_SIDECAR_CONTROLLER_CONFIG: controllerConfigPath,
        },
      },
    )
    const classification = playwright.status === 0 ? null : failureClass(playwright)
    const activeDeleteEvidence =
      playwright.status === 0 && selectedCase.activeDelete
        ? await persistActiveDeleteReceipt(playwrightOutput)
        : undefined
    const stop = await runController('stop')
    await assertStopped(controllerConfig)
    console.log(
      `# ${JSON.stringify({
        playwright_status: playwright.status,
        failure_class: classification,
        cases: 1,
        case_id: caseID,
        browser: 'system-chrome',
        provider: 'hexclaw-gpt',
        model: 'gpt-5.6-sol',
        llm_config_exact: true,
        controller_stop_status: stop.status,
        pid_receipt_absent: true,
        lock_absent: true,
        listener_absent: true,
        health_absent: true,
        dingtalk_sends: 0,
        ...(activeDeleteEvidence
          ? {
              active_delete_receipt: activeDeleteEvidence.receipt,
              active_delete_receipt_sha256: activeDeleteEvidence.receipt_sha256,
              active_delete_evidence_path: activeDeleteEvidence.evidence_path,
            }
          : {}),
      })}`,
    )
    assert.equal(
      playwright.status,
      0,
      `selected installed real case failed (${classification}); output redacted`,
    )
    assert.match(playwright.stdout, /1 passed/)
  },
)
