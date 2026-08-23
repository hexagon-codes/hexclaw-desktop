import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const nativeDir = dirname(fileURLToPath(import.meta.url))
const harnessPath = resolve(nativeDir, 'bug-20260802-013-save-boundary.mjs')
const fixturePath = resolve(
  nativeDir,
  'bug-20260802-013-save-boundary/fixture.ts',
)
const fixtureConfigPath = resolve(
  nativeDir,
  'bug-20260802-013-save-boundary/vite.config.ts',
)
const tracedCorePath = resolve(
  nativeDir,
  'bug-20260802-013-save-boundary/traced-tauri-core.ts',
)

test('BUG-20260802-013 Save 边界 harness 使用当前源码且完整隔离', () => {
  assert.ok(existsSync(harnessPath), 'BUG-20260802-013 native harness is missing')
  assert.ok(existsSync(fixturePath), 'BUG-20260802-013 WebView fixture is missing')
  assert.ok(existsSync(fixtureConfigPath), 'BUG-20260802-013 fixture Vite config is missing')
  assert.ok(existsSync(tracedCorePath), 'BUG-20260802-013 traced Tauri core is missing')

  const harness = readFileSync(harnessPath, 'utf8')
  const fixture = readFileSync(fixturePath, 'utf8')
  const fixtureConfig = readFileSync(fixtureConfigPath, 'utf8')
  const tracedCore = readFileSync(tracedCorePath, 'utf8')

  assert.match(harness, /HexClaw Bug013 Save Test/)
  assert.match(harness, /com\.hexclaw\.desktop\.bug013\.save/)
  assert.match(harness, /HEXCLAW_TEST_HOME/)
  assert.match(harness, /CARGO_NET_OFFLINE:\s*'true'/)
  assert.match(harness, /GOPROXY:\s*'off'/)
  assert.match(harness, /PNPM_CONFIG_OFFLINE:\s*'true'/)
  assert.match(harness, /test\/evidence\/bug-20260802-013-save-current-source/)
  assert.match(harness, /rss-samples\.tsv/)
  assert.match(harness, /ipc-trace\.json/)
  assert.match(harness, /cleanup\.json/)
  assert.match(harness, /stopOwnedSidecar/)
  assert.doesNotMatch(harness, /\/Applications\/HexClaw\.app/)

  assert.match(fixture, /import\s*\{\s*saveBlobInApp\s*\}\s*from\s*['"]@\/utils\/download['"]/)
  assert.match(fixture, /import\s+ChatExportMenu\s+from\s+['"]@\/components\/chat\/ChatExportMenu\.vue['"]/)
  assert.match(fixture, /100\s*\*\s*1024\s*\*\s*1024/)
  assert.match(fixture, /256\s*\*\s*1024\s*\+\s*1/)
  assert.match(fixture, /saveLimitBytes\s*=\s*512\s*\*\s*1024\s*\*\s*1024/)
  assert.match(fixture, /size:\s*saveLimitBytes\s*\+\s*1/)
  assert.match(fixture, /append_file_grant_chunk/)
  assert.match(fixture, /discard_file_grant/)
  assert.match(fixture, /abort-at-half/)
  assert.doesNotMatch(fixture, /FileReader|readAsDataURL|btoa\(|base64Data/)

  assert.match(fixtureConfig, /resolve\(fixtureDir, '\.\.\/\.\.\/\.\.\/src'\)/)
  assert.match(fixtureConfig, /traced-tauri-core\.ts/)
  assert.match(tracedCore, /append_file_grant_chunk/)
  assert.match(tracedCore, /copy-failure-arming/)
  assert.match(tracedCore, /abort-at-half/)
  assert.doesNotMatch(tracedCore, /FileReader|readAsDataURL|btoa\(|base64Data/)
})
