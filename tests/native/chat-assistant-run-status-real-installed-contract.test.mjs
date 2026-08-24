import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const nativeDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(nativeDir, '../..')
const harnessPath = join(nativeDir, 'chat-assistant-run-status-real-installed.mjs')
const fixturePath = join(nativeDir, 'chat-assistant-run-status-real-installed-fixture.js')
const harness = readFileSync(harnessPath, 'utf8')
const fixture = readFileSync(fixturePath, 'utf8')

function sourceFiles(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name)
    return entry.isDirectory() ? sourceFiles(path) : [path]
  })
}

test('real installed status gate is fail-closed and exact-model only', () => {
  for (const invariant of [
    "assert.deepEqual(args, ['--execute-real']",
    "HEX_CHAT_STATUS_REAL_INSTALLED_AUTHORIZED",
    "HEX_CHAT_STATUS_PROVIDER",
    "HEX_CHAT_STATUS_MODEL",
    "HEX_CHAT_STATUS_EXPECTED_DESKTOP_SHA256",
    "HEX_CHAT_STATUS_EXPECTED_SIDECAR_SHA256",
    "const expectedProvider = 'hexclaw-gpt'",
    "const expectedModel = 'gpt-5.6-sol'",
    "const expectedNeutralLabel = '正在回复…'",
    "assert.equal(sha256File(candidateExecutable), expectedDesktopSHA256",
    "assert.equal(sha256File(candidateSidecar), expectedSidecarSHA256",
  ]) {
    assert.ok(harness.includes(invariant), `Missing fail-closed invariant: ${invariant}`)
  }

  assert.doesNotMatch(harness, /正在生成回答/u)
  assert.doesNotMatch(harness, /\/Applications\/HexClaw\.app/u)
  assert.doesNotMatch(harness, /\/Users\/[A-Za-z0-9._-]+/u)
})

test('real installed status gate isolates state and disables every IM path', () => {
  for (const invariant of [
    "HOME: sandbox",
    "mkdtempSync('/tmp/hexclaw-chat-status-real-installed.')",
    "CFFIXED_USER_HOME: sandbox",
    "HEXCLAW_TEST_HOME: sandbox",
    "DINGTALK_LIVE_SEND: '0'",
    "'prepare-profile'",
    "platforms: ['web']",
    "dingtalk_live_send: false",
    "im_delivery_calls: 0",
    "dingtalk_or_im_invocations: 0",
    "applications_directory_touched: false",
    "real_home_modified: false",
  ]) {
    assert.ok(harness.includes(invariant), `Missing isolation invariant: ${invariant}`)
  }
})

test('fixture drives one real low-reasoning request and freezes the status lifecycle', () => {
  for (const invariant of [
    "const expectedNeutralLabel = '正在回复…'",
    "const forbiddenLegacyLabels = ['正在生成回答', '正在准备回答', '思考中']",
    "neutral_host_count === 1",
    "before.live_region_count === 1",
    "before.typing_dots_count === 0",
    "before.answer_visible === false",
    "afterFirstContent.neutral_host_count === 0",
    "terminal.thinking_host_count === 1",
    "terminal.reasoning_execution === 'applied'",
    "outbound.thinking_effort === 'low'",
    "command === 'sidecar_socket_send'",
    "command === 'sidecar_socket_open'",
    "socketTrace.fallbackRequests.length === 0",
    "socketTrace.targetRequests.length === 1",
    "socketTrace.targetRequests.length === 0",
    "restored.assistant_message_id === baseline.assistant_message_id",
    "restored.thought === baseline.thought",
  ]) {
    assert.ok(fixture.includes(invariant), `Missing lifecycle invariant: ${invariant}`)
  }
})

test('harness persists screenshots, transport receipt, restart snapshot, and cleanup proof', () => {
  for (const artifact of [
    'installed-before-first-content.png',
    'installed-after-first-content.png',
    'installed-terminal.png',
    'installed-restart-restored.png',
    'sqlite-before-restart.json',
    'sqlite-after-restart.json',
    'transport-receipt.json',
    'wkwebview-reports.json',
    'provenance.json',
    'cleanup.json',
  ]) {
    assert.ok(harness.includes(artifact), `Missing evidence artifact: ${artifact}`)
  }
  assert.match(harness, /provider_bound_request_increment_on_restart:\s*targetRequests\.length - 1/u)
  assert.match(harness, /assert\.deepEqual\(afterRestart, beforeRestart/u)
  assert.match(harness, /rmSync\(sandbox, \{ recursive: true, force: true \}\)/u)
})

test('test-only fixture is absent from production frontend sources', () => {
  for (const path of sourceFiles(join(repoRoot, 'src'))) {
    assert.doesNotMatch(
      readFileSync(path, 'utf8'),
      /chat-assistant-run-status-real-installed-fixture\.js/u,
      `Production source references the native-only fixture: ${path}`,
    )
  }
})

test('--help exits without authority, build, App launch, or model request', () => {
  const result = spawnSync(process.execPath, [harnessPath, '--help'], {
    cwd: repoRoot,
    env: {
      PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
      LANG: 'C',
    },
    encoding: 'utf8',
    timeout: 5_000,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /--execute-real/u)
  assert.match(result.stdout, /DingTalk\/IM delivery/u)
  assert.equal(result.stderr, '')
})
