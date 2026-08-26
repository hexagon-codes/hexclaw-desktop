import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const nativeRoot = dirname(fileURLToPath(import.meta.url))
const gatePath = join(nativeRoot, 'bug-20260824-recovering-execution-lock-installed.mjs')
const installedBundle = '/Applications/HexClaw.app'
const installedDesktop = join(installedBundle, 'Contents/MacOS/hexclaw-desktop')
const installedSidecar = join(installedBundle, 'Contents/MacOS/hexclaw')

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

test('validate freezes the explicit installed candidate bytes without a stale hash allowlist', () => {
  const result = spawnSync(process.execPath, [gatePath, 'validate'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HEXCLAW_RECOVERING_LOCK_INSTALLED_CANDIDATE: installedBundle,
    },
  })

  assert.equal(result.status, 0, result.stderr || result.stdout)
  const receipt = JSON.parse(result.stdout)
  assert.equal(receipt.status, 'PASS')
  assert.equal(receipt.installedIdentity.candidateBundle, installedBundle)
  assert.equal(receipt.installedIdentity.desktopSHA256, sha256File(installedDesktop))
  assert.equal(receipt.installedIdentity.sidecarSHA256, sha256File(installedSidecar))
  assert.equal(receipt.installedIdentity.frozen, true)
  assert.equal(receipt.installedIdentity.unchanged, true)
})

test('gate rejects source-tree candidates and revalidates the frozen installed identity', () => {
  const source = readFileSync(gatePath, 'utf8')
  const sourceCandidate = join(
    nativeRoot,
    '../../src-tauri/target/release/bundle/macos/HexClaw.app',
  )
  const rejected = spawnSync(process.execPath, [gatePath, 'validate'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HEXCLAW_RECOVERING_LOCK_INSTALLED_CANDIDATE: sourceCandidate,
    },
  })

  assert.doesNotMatch(source, /expectedInstalled(?:Desktop|Sidecar)SHA256/u)
  assert.match(source, /HEXCLAW_RECOVERING_LOCK_INSTALLED_CANDIDATE/u)
  assert.match(source, /installed candidate must be rooted in \/Applications/u)
  assert.match(source, /assertInstalledArtifactUnchanged/u)
  assert.match(source, /installed artifact changed during the gate/u)
  assert.notEqual(rejected.status, 0)
  assert.match(rejected.stderr, /installed candidate must be rooted in \/Applications/u)
})

test('run activates the exact child PID through the native probe before read-only AX inspection', () => {
  const source = readFileSync(gatePath, 'utf8')

  assert.match(source, /import AppKit/u)
  assert.match(source, /case "activate":/u)
  assert.match(source, /NSRunningApplication\(processIdentifier:/u)
  assert.match(
    source,
    /\.activate\(options: \[\.activateAllWindows, \.activateIgnoringOtherApps\]\)/u,
  )
  assert.match(source, /kAXWindowsAttribute/u)
  assert.match(source, /"activationRequested": true/u)
  assert.match(source, /"active": app\.isActive/u)
  assert.match(source, /const activation = runProbe\(probe, background \? 'inspect' : 'activate', appPID\)/u)
  assert.match(source, /if \(background\)[\s\S]*assert\.equal\(activation\.active, false[\s\S]*else[\s\S]*assert\.equal\(activation\.active, true/u)
  assert.match(source, /assert\.equal\(activation\.axReadable, true/u)
  assert.match(source, /assert\.ok\(activation\.windowCount > 0/u)
  assert.match(
    source,
    /await waitForHealth\(sidecarPort, launcherProcess, appPID\)[\s\S]*runProbe\(probe, background \? 'inspect' : 'activate', appPID\)[\s\S]*await waitForAXSnapshot\(probe, appPID, expectRecovering\)/u,
  )
  assert.doesNotMatch(source, /\/usr\/bin\/osascript/u)
  for (const forbidden of [
    /^\s*keystroke\b/imu,
    /^\s*click\b/imu,
    /AXUIElementPerformAction/u,
    /CGEvent/u,
    /NSPasteboard/u,
    /navigator\.clipboard/u,
  ]) {
    assert.doesNotMatch(source, forbidden)
  }
})

test('run launches the installed bundle through LaunchServices with the isolated environment', () => {
  const source = readFileSync(gatePath, 'utf8')

  assert.match(source, /spawn\('\/usr\/bin\/open'/u)
  assert.match(source, /'-n', '-F', '-W'/u)
  assert.match(source, /'--env'/u)
  assert.match(source, /waitForNewInstalledDesktopPID/u)
  assert.match(source, /assertLaunchedExecutableIdentity/u)
  assert.doesNotMatch(source, /spawn\(installedExecutable/u)
})

test('run fails before launching when the active macOS session is locked', () => {
  const source = readFileSync(gatePath, 'utf8')

  assert.match(source, /CGSessionCopyCurrentDictionary/u)
  assert.match(source, /"screenLocked": screenLocked/u)
  assert.match(source, /let preflight = null/u)
  assert.match(source, /preflight = runProbe\(probe, 'preflight'\)/u)
  assert.match(source, /assert\.equal\(preflight\.screenLocked, false/u)
  assert.match(
    source,
    /preflight = runProbe\(probe, 'preflight'\)[\s\S]*assert\.equal\(preflight\.screenLocked, false[\s\S]*runExactPhase\(/u,
  )
  assert.match(
    source,
    /writeJSON\(join\(evidenceRoot, 'exact-installed-cleanup\.json'\), \{[\s\S]*installedArtifact: \{[\s\S]*\.\.\.installedIdentity[\s\S]*preflight,/u,
  )
})

test('run creates the durable fixture profile below the required private tmp boundary', () => {
  const source = readFileSync(gatePath, 'utf8')

  assert.match(
    source,
    /mkdtempSync\(join\('\/tmp', 'hexclaw-recovering-lock-exact\.'\)\)/u,
  )
  assert.doesNotMatch(
    source,
    /mkdtempSync\(join\(tmpdir\(\), 'hexclaw-recovering-lock-exact\.'\)\)/u,
  )
})

test('run supports a non-activating background native observation mode', () => {
  const source = readFileSync(gatePath, 'utf8')

  assert.match(source, /HEXCLAW_RUN_NATIVE_UI_IN_BACKGROUND/u)
  assert.match(source, /case "inspect":/u)
  assert.match(source, /"activationRequested": false/u)
  assert.match(source, /background \? 'inspect' : 'activate'/u)
  assert.match(source, /if \(background\) openArguments\.splice\(1, 0, '-g'\)/u)
  assert.match(source, /foregroundWindowActivation: !background/u)
  assert.match(source, /backgroundWindowObservation: background/u)
  assert.match(source, /GOCACHE: join\(sandbox, '\.gocache'\)/u)
  assert.match(source, /runPrivateCommand\(\s*fixtureGoExecutable,/u)
  assert.match(source, /GOROOT: fixtureGoRoot/u)
  assert.match(source, /runState\.installedDesktopLaunched = true/u)
  assert.match(source, /launched: runState\.installedDesktopLaunched/u)
})
