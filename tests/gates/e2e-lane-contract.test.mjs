import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

const currentSourceSpecs = [
  'api-chain.spec.ts',
  'browser-chat-background.spec.ts',
  'browser-chat-interaction-current-source-20260723.spec.ts',
  'browser-clearable-inputs.spec.ts',
  'browser-current-ui-regression-20260723.spec.ts',
  'browser-k12-profile-linkage-current-source-20260723.spec.ts',
  'bug-20260726-030-composer-divider.spec.ts',
  'streaming-chain.spec.ts',
]

const fixtureSpecs = [
  'creative-real-fixtures.spec.ts',
  'ftue-dynamic.spec.ts',
  'grading-real-fixtures.spec.ts',
  'grounding-pdf.spec.ts',
  'practice-integrity.spec.ts',
  'responsive-a11y.spec.ts',
  'role-privacy.spec.ts',
]

async function readRepoFile(path) {
  return readFile(resolve(repoRoot, path), 'utf8')
}

function listPlaywright(config) {
  const result = spawnSync('pnpm', ['exec', 'playwright', 'test', '-c', config, '--list'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  assert.equal(
    result.status,
    0,
    `${config} --list failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  )

  const output = `${result.stdout}\n${result.stderr}`
  const files = [
    ...new Set([...output.matchAll(/(?:^|\s|›)([\w-]+\.spec\.ts):\d+/gm)].map((match) => match[1])),
  ].sort()
  const total = output.match(/Total:\s*(\d+) tests? in (\d+) files?/)
  assert.ok(total, `${config} --list did not print a test/file total`)

  return {
    files,
    tests: Number(total[1]),
    fileCount: Number(total[2]),
    output,
  }
}

test('default current-source lane collects only the canonical eight specs', () => {
  const listed = listPlaywright('playwright.config.ts')

  assert.deepEqual(listed.files, currentSourceSpecs)
  assert.equal(listed.fileCount, 8)
  for (const forbidden of ['browser-mock-', 'browser-live-', 'real-fixtures', 'webkit-']) {
    assert.doesNotMatch(listed.output, new RegExp(forbidden))
  }
})

test('current-source execution fails closed without explicit UI and Sidecar endpoints', () => {
  const env = { ...process.env }
  delete env.HEX_E2E_BASE_URL
  delete env.HEX_E2E_SIDECAR_URL
  delete env.HEX_E2E_SIDECAR_WS_URL
  const result = spawnSync(
    'pnpm',
    ['exec', 'playwright', 'test', '-c', 'playwright.config.ts', '--grep', '__no_case__'],
    { cwd: repoRoot, encoding: 'utf8', env },
  )

  assert.notEqual(result.status, 0)
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /current-source requires explicit HEX_E2E_BASE_URL, HEX_E2E_SIDECAR_URL and HEX_E2E_SIDECAR_WS_URL/,
  )
})

test('Chromium and WebKit Fixture lanes independently collect the same 7 files and 27 tests', () => {
  const chromium = listPlaywright('playwright.k12.fixtures.config.ts')
  const webkit = listPlaywright('playwright.k12.fixtures.webkit.config.ts')

  assert.deepEqual(chromium.files, fixtureSpecs)
  assert.deepEqual(webkit.files, fixtureSpecs)
  assert.equal(chromium.fileCount, 7)
  assert.equal(webkit.fileCount, 7)
  assert.equal(chromium.tests, 27)
  assert.equal(webkit.tests, 27)
  assert.match(chromium.output, /\[chromium\]/)
  assert.doesNotMatch(chromium.output, /\[webkit\]/)
  assert.match(webkit.output, /\[webkit\]/)
  assert.doesNotMatch(webkit.output, /\[chromium\]/)
})

test('Fixture reports and strict runners are lane-specific and fixed', async () => {
  const chromiumConfig = await readRepoFile('playwright.k12.fixtures.config.ts')
  const webkitConfig = await readRepoFile('playwright.k12.fixtures.webkit.config.ts')
  const webkitGate = await readRepoFile('scripts/ci/k12-fixtures-webkit-gate.mjs')

  assert.match(chromiumConfig, /test-results\/k12-fixtures\/report\.json/)
  assert.doesNotMatch(chromiumConfig, /k12-fixtures-webkit/)
  assert.match(webkitConfig, /test-results\/k12-fixtures-webkit\/report\.json/)
  assert.doesNotMatch(webkitConfig, /test-results\/k12-fixtures\/report\.json/)
  assert.match(webkitGate, /playwright\.k12\.fixtures\.webkit\.config\.ts/)
  assert.doesNotMatch(webkitGate, /--project|--grep|playwright\.k12\.fixtures\.config\.ts/)
})

test('real-child-data lanes disable automatic raw Playwright artifacts', async () => {
  for (const configPath of ['playwright.k12.fixtures.config.ts', 'playwright.k12.live.config.ts']) {
    const config = await readRepoFile(configPath)
    assert.match(config, /trace:\s*['"]off['"]/)
    assert.match(config, /screenshot:\s*['"]off['"]/)
    assert.match(config, /video:\s*['"]off['"]/)
  }
  const webkitConfig = await readRepoFile('playwright.k12.fixtures.webkit.config.ts')
  assert.match(webkitConfig, /\.\.\.chromiumFixtureConfig/)
  assert.doesNotMatch(webkitConfig, /trace:\s*['"](?:on|retain-on-failure)['"]/)
  assert.doesNotMatch(webkitConfig, /screenshot:\s*['"](?:on|only-on-failure)['"]/)
  assert.doesNotMatch(webkitConfig, /video:\s*['"]retain-on-failure['"]/)
})

test('package scripts keep current-source, Fixture, WebKit and native lanes explicit', async () => {
  const pkg = JSON.parse(await readRepoFile('package.json'))

  assert.equal(pkg.scripts['test:e2e'], 'playwright test -c playwright.config.ts')
  assert.equal(pkg.scripts['test:e2e:current-source'], 'playwright test -c playwright.config.ts')
  assert.equal(pkg.scripts['test:e2e:k12-fixtures'], 'node ./scripts/ci/k12-fixtures-gate.mjs')
  assert.equal(
    pkg.scripts['test:e2e:k12-fixtures:strict'],
    'node ./scripts/ci/k12-fixtures-gate.mjs --strict',
  )
  assert.equal(
    pkg.scripts['test:e2e:k12-fixtures:webkit'],
    'node ./scripts/ci/k12-fixtures-webkit-gate.mjs',
  )
  assert.equal(
    pkg.scripts['test:e2e:k12-fixtures:webkit:strict'],
    'node ./scripts/ci/k12-fixtures-webkit-gate.mjs --strict',
  )
  assert.equal(pkg.scripts['test:e2e:native-smoke'], 'bash tests/native/native-smoke.sh run')
  assert.equal(
    pkg.scripts['test:e2e:native-smoke:build'],
    'make sidecar-local && bash tests/native/native-smoke.sh build',
  )
  assert.equal(pkg.scripts['test:acceptance:package-local'], 'make package-local')
})

test('Vitest excludes every Playwright-owned E2E and LIVE suite', async () => {
  const vitestConfig = await readRepoFile('vitest.config.ts')

  assert.match(vitestConfig, /'tests\/e2e\/\*\*'/)
  assert.match(vitestConfig, /'tests\/live\/\*\*'/)
})
