import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const nativeDir = dirname(fileURLToPath(import.meta.url))
const harnessPath = resolve(nativeDir, 'voice-composer-boundary.mjs')
const fixturePath = resolve(nativeDir, 'voice-composer-fixture.js')

test('voice Composer 原生边界只能使用隔离 Test.app、loopback 上游与合成内存音轨', () => {
  assert.ok(existsSync(harnessPath), 'native voice boundary harness is missing')
  assert.ok(existsSync(fixturePath), 'native voice WebView fixture is missing')

  const harness = readFileSync(harnessPath, 'utf8')
  const fixture = readFileSync(fixturePath, 'utf8')

  assert.match(harness, /com\.hexclaw\.desktop\.voice-boundary/)
  assert.match(harness, /HEXCLAW_TEST_MODE/)
  assert.match(harness, /HEXCLAW_TEST_HOME/)
  assert.match(harness, /preseeded-owner-yaml/)
  assert.match(harness, /locality:\s*local/)
  assert.match(harness, /ollama:\n[\s\S]*?base_url:\s*\$\{fixtureOrigin\}\/v1/)
  assert.match(harness, /userText\.endsWith\('边界语音成功'\)/)
  assert.match(harness, /doesNotMatch\([\s\S]*localhost:11434/)
  assert.match(harness, /GOCACHE/)
  assert.match(harness, /GOENV:\s*'off'/)
  assert.match(harness, /delete offlineEnv\.GOROOT/)
  assert.match(harness, /127\.0\.0\.1/)
  assert.doesNotMatch(harness, /0\.0\.0\.0/)
  assert.match(harness, /audioBytes/)
  assert.match(harness, /server\.closeAllConnections\(\)/)
  assert.match(harness, /clearTimeout\(reportTimer\)/)
  assert.match(harness, /webViewReport/)
  assert.match(harness, /signalCode !== null/)
  assert.doesNotMatch(harness, /writeFile[^\n]*(audio|recording)/i)

  assert.match(fixture, /createMediaStreamDestination/)
  assert.match(fixture, /navigator\.mediaDevices/)
  assert.doesNotMatch(fixture, /class\s+.*MediaRecorder|window\.MediaRecorder\s*=(?!=)/)
  for (const state of ['success', 'cancel', 'stt-failure', 'send-failure']) {
    assert.match(fixture, new RegExp(state))
  }
})
