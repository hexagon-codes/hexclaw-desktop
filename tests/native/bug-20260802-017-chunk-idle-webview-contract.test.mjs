import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const nativeDir = dirname(fileURLToPath(import.meta.url))
const harnessPath = resolve(nativeDir, 'bug-20260802-017-chunk-idle-webview.mjs')
const fixturePath = resolve(nativeDir, 'bug-20260802-017-chunk-idle-webview-fixture.js')

test('BUG-20260802-017 native chunk-idle harness keeps the real boundary isolated and evidenced', () => {
  assert.ok(existsSync(harnessPath), 'BUG-20260802-017 native harness is missing')
  assert.ok(existsSync(fixturePath), 'BUG-20260802-017 WebView fixture is missing')

  const harness = readFileSync(harnessPath, 'utf8')
  const fixture = readFileSync(fixturePath, 'utf8')

  assert.match(harness, /com\.hexclaw\.desktop\.bug017/)
  assert.match(harness, /HexClaw Bug017 Test/)
  assert.match(harness, /PROVIDER_RELEASE_DELAY_MS\s*=\s*65_000/)
  assert.match(harness, /HEXCLAW_TEST_HOME/)
  assert.match(harness, /GOPROXY:\s*'off'/)
  assert.match(harness, /CARGO_NET_OFFLINE:\s*'true'/)
  assert.match(harness, /HTTP_PROXY/)
  assert.match(harness, /sqlite-before-restart\.json/)
  assert.match(harness, /sqlite-after-restart\.json/)
  assert.match(harness, /provider-receipt\.json/)
  assert.match(harness, /webview-trace\.json/)
  assert.match(harness, /cleanup\.json/)
  assert.match(harness, /stopOwnedSidecar/)
  assert.match(harness, /sidecarFileLog/)
  assert.match(harness, /logs['"`], ['"`]hexclaw\.log/)
  assert.match(harness, /request\.method === 'OPTIONS'/)
  assert.match(harness, /access-control-allow-origin/)
  assert.doesNotMatch(harness, /\/Applications\/HexClaw\.app/)

  assert.match(fixture, /data-testid=["']chat-input["']/)
  assert.match(fixture, /data-testid=["']chat-send["']/)
  assert.match(fixture, /WebSocket transport unavailable; retry will resume with the same request id/)
  assert.match(fixture, /partial-visible/)
  assert.match(fixture, /error-visible/)
  assert.match(fixture, /restart-visible/)
})
