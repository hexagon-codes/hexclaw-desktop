import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

const rustEntry = readFileSync(new URL('../../src-tauri/src/lib.rs', import.meta.url), 'utf8')
const rustAutostart = readFileSync(
  new URL('../../src-tauri/src/autostart.rs', import.meta.url),
  'utf8',
)
const tauriConfig = JSON.parse(
  readFileSync(new URL('../../src-tauri/tauri.conf.json', import.meta.url), 'utf8'),
)

test('macOS autostart registers the branded HexClaw app bundle', () => {
  assert.match(
    rustEntry,
    /tauri_plugin_autostart::init\(\s*tauri_plugin_autostart::MacosLauncher::AppleScript,/,
    'AppleScript login items point at HexClaw.app, allowing macOS to show its name and icon',
  )
  assert.equal(tauriConfig.productName, 'HexClaw')
  assert.ok(
    tauriConfig.bundle.icon.includes('icons/icon.icns'),
    'the macOS bundle must declare its branded icon',
  )
  assert.ok(
    existsSync(new URL('../../src-tauri/icons/icon.icns', import.meta.url)),
    'the declared macOS icon must exist',
  )
})

test('macOS upgrades migrate the legacy executable LaunchAgent', () => {
  assert.match(
    rustEntry,
    /autostart::migrate_legacy_macos_autostart\(app\.handle\(\)\)/,
    'startup must migrate an existing HexClaw LaunchAgent',
  )
  assert.match(
    rustAutostart,
    /pub fn migrate_legacy_macos_autostart/,
    'the native layer must own the legacy macOS migration',
  )
})
