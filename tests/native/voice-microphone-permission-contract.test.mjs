import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const nativeDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(nativeDir, '../..')
const infoPlist = resolve(repoRoot, 'src-tauri/Info.plist')
const exactPurpose =
  'HexClaw 仅在你主动使用语音输入时访问麦克风，并将录音发送到你配置的语音转写服务以生成消息。'
const boundaryHarness = resolve(nativeDir, 'voice-composer-boundary.mjs')
const physicalFixture = resolve(nativeDir, 'voice-microphone-cancel-fixture.js')

test('macOS bundle 声明已批准的麦克风用途说明', () => {
  const actual = execFileSync(
    'plutil',
    ['-extract', 'NSMicrophoneUsageDescription', 'raw', '-o', '-', infoPlist],
    { encoding: 'utf8' },
  ).trim()

  assert.equal(actual, exactPurpose)
})

test('物理麦克风门只包装原生 getUserMedia，并在 X 丢弃后保持 STT/send 为零', () => {
  assert.ok(existsSync(boundaryHarness), 'native voice boundary harness is missing')
  assert.ok(existsSync(physicalFixture), 'physical microphone fixture is missing')

  const harness = readFileSync(boundaryHarness, 'utf8')
  const fixture = readFileSync(physicalFixture, 'utf8')

  assert.match(harness, /physical-cancel/)
  assert.match(harness, /com\.hexclaw\.desktop\.voice-capture-boundary/)
  assert.match(harness, /NSMicrophoneUsageDescription/)
  assert.match(harness, /persistedAudioFiles/)
  assert.match(
    harness,
    /realMicrophonePermissionCovered:\s*Boolean\(\s*webViewReport\?\.source\?\.realMicrophonePermissionCovered/,
  )
  assert.doesNotMatch(harness, /tccutil/)

  assert.match(fixture, /getUserMedia\.bind\(mediaDevices\)/)
  assert.match(fixture, /navigator\.mediaDevices !== mediaDevices/)
  assert.match(fixture, /Object\.defineProperty\(navigator, 'mediaDevices'/)
  assert.match(fixture, /function assertCapturePathPreflight\(\)/)
  assert.match(fixture, /navigator\.mediaDevices === installedMediaDevices/)
  assert.match(fixture, /navigator\.mediaDevices\.getUserMedia === installedGetUserMedia/)
  assert.match(fixture, /physical-capture-path-preflight/)
  assert.match(fixture, /window\.SpeechRecognition = undefined/)
  assert.match(fixture, /window\.webkitSpeechRecognition = undefined/)
  assert.match(fixture, /currentStart\.isConnected/)
  assert.match(
    fixture,
    /currentStart === document\.querySelector\('\[data-testid="chat-voice-start"\]'\)/,
  )
  assert.doesNotMatch(fixture, /\bstart\.click\(\)/)
  assert.match(fixture, /currentStart\.click\(\)/)
  assert.match(fixture, /chat-voice-cancel/)
  assert.match(fixture, /sttDelta/)
  assert.match(fixture, /chatDelta/)
  assert.doesNotMatch(fixture, /createMediaStreamDestination|AudioContext/)
  assert.doesNotMatch(fixture, /chat-voice-send|audio\/transcriptions|FormData|FileReader/)
})
