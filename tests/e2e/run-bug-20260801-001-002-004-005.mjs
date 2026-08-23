import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const docsRoot = path.resolve(desktopRoot, '../hexclaw-docs')
const evidenceRoot = path.join(
  docsRoot,
  'test/evidence/bug-20260801-001-002-004-005-current-source',
)

function allocatePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('could not allocate an isolated loopback port'))
        return
      }
      const port = address.port
      server.close((error) => (error ? reject(error) : resolve(port)))
    })
  })
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd ?? desktopRoot,
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
    timeout: options.timeout ?? 240_000,
  })
}

function sanitizeLog(value) {
  return value.replaceAll(desktopRoot, '<hexclaw-desktop>').replaceAll(docsRoot, '<hexclaw-docs>')
}

mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 })

const prototypeTests = [
  'prototype/system-settings-theme-cards.test.mjs',
  'prototype/implemented-theme-alignment.test.mjs',
]
const green = run('node', ['--test', ...prototypeTests], { cwd: docsRoot })
writeFileSync(
  path.join(evidenceRoot, 'prototype-exact-set-green.log'),
  sanitizeLog(`${green.stdout}${green.stderr}`),
)
assert.equal(green.status, 0, 'approved appearance exact-set must be GREEN')

const mutation = run('node', ['--test', ...prototypeTests], {
  cwd: docsRoot,
  env: { HEXCLAW_THEME_ORACLE_MUTATION: 'theme-height-45' },
})
writeFileSync(
  path.join(evidenceRoot, 'prototype-exact-set-negative-mutation-red.log'),
  sanitizeLog(`${mutation.stdout}${mutation.stderr}`),
)
assert.notEqual(mutation.status, 0, '44px → 45px mutation must be RED')

const sourcePort = await allocatePort()
let referencePort = await allocatePort()
while (referencePort === sourcePort) referencePort = await allocatePort()

const playwright = run(
  'pnpm',
  [
    'exec',
    'playwright',
    'test',
    '-c',
    'tests/e2e/bug-20260801-001-002-004-005.playwright.config.ts',
  ],
  {
    env: {
      HEX_K12_CURRENT_SOURCE_PORT: String(sourcePort),
      HEX_K12_REFERENCE_PORT: String(referencePort),
      HEX_K12_CURRENT_SOURCE_URL: `http://127.0.0.1:${sourcePort}`,
      HEX_K12_REFERENCE_URL: `http://127.0.0.1:${referencePort}/app.html`,
    },
  },
)
writeFileSync(
  path.join(evidenceRoot, 'playwright-current-source.log'),
  sanitizeLog(`${playwright.stdout}${playwright.stderr}`),
)

const comparisons = readdirSync(evidenceRoot)
  .filter((name) => /^comparison-(?:light|dark)-(?:settings|records|insights)\.json$/.test(name))
  .sort()
  .map((name) => JSON.parse(readFileSync(path.join(evidenceRoot, name), 'utf8')))

const nativePreflight = run(
  'node',
  ['tests/native/bug-20260801-001-002-004-005-test-app-preflight.mjs'],
  { env: { HEX_K12_VISUAL_EVIDENCE_DIR: evidenceRoot } },
)
writeFileSync(
  path.join(evidenceRoot, 'test-app-wkwebview-preflight.log'),
  sanitizeLog(`${nativePreflight.stdout}${nativePreflight.stderr}`),
)
assert.equal(nativePreflight.status, 0, 'isolated Test.app preflight must complete')
const nativeReport = JSON.parse(
  readFileSync(path.join(evidenceRoot, 'test-app-wkwebview-preflight.json'), 'utf8'),
)

const semanticBusinessFixtureComparable =
  comparisons.length === 6 && comparisons.every((item) => item.semantic.comparable)
const targetSurfacePass =
  comparisons
    .filter((item) => item.surface !== 'settings')
    .every((item) => item.target?.pixel?.pass) &&
  comparisons.filter((item) => item.surface === 'settings').every((item) => item.computedStyle.pass)

const summary = {
  bugIds: ['BUG-20260801-001', 'BUG-20260801-002', 'BUG-20260801-004', 'BUG-20260801-005'],
  isolation: {
    sourcePort,
    referencePort,
    loopbackOnly: true,
    externalNetworkRequests: comparisons.flatMap((item) => item.network.externalRequests),
    realModelCalls: 0,
    installedApplicationTouched: false,
  },
  oracle: {
    prototypeTestsGreen: green.status === 0,
    negativeMutation: 'theme segmented height 44px → 45px',
    negativeMutationRed: mutation.status !== 0,
  },
  nativeThirdLeg: {
    status: nativeReport.status,
    decision: nativeReport.decision,
    appLaunched: nativeReport.app.launched,
    testHomeMode: nativeReport.isolationPreflight.testHomeMode,
    testHomeRemoved: nativeReport.isolationPreflight.testHomeRemoved,
    dedicatedPort: nativeReport.isolationPreflight.dedicatedPort,
    fixtureParity: nativeReport.fixtureParity,
  },
  fullPageVisual: semanticBusinessFixtureComparable
    ? 'COMPARABLE_SEMANTIC_BUSINESS_FIXTURE'
    : 'NOT_COMPARABLE_BUSINESS_FIXTURE',
  visualAcceptance:
    semanticBusinessFixtureComparable && targetSurfacePass
      ? 'PASS_TARGET_SURFACE_EXACT'
      : 'NOT_PASS',
  playwright: {
    exitCode: playwright.status,
    expectedPairs: 6,
    capturedPairs: comparisons.length,
    semanticComparablePairs: comparisons.filter((item) => item.semantic.comparable).length,
    criticalGeometryPassPairs: comparisons.filter((item) => item.criticalGeometry.pass).length,
    computedStylePassPairs: comparisons.filter((item) => item.computedStyle.pass).length,
    pixelPassPairs: comparisons.filter((item) => item.pixel.pass).length,
    targetGeometryPassPairs: comparisons.filter(
      (item) =>
        item.target?.geometry?.widthEqual &&
        item.target?.geometry?.heightEqual &&
        item.target?.geometry?.originEqual,
    ).length,
    targetPixelPassPairs: comparisons.filter((item) => item.target?.pixel?.pass).length,
  },
  comparisons: comparisons.map((item) => ({
    surface: item.surface,
    theme: item.theme,
    semanticComparable: item.semantic.comparable,
    criticalGeometryPass: item.criticalGeometry.pass,
    computedStylePass: item.computedStyle.pass,
    changedPixelRatio: item.pixel.changed_pixel_ratio,
    pixelPass: item.pixel.pass,
    targetGeometry: item.target?.geometry ?? null,
    targetPixel: item.target?.pixel ?? null,
  })),
}
writeFileSync(path.join(evidenceRoot, 'execution-summary.json'), JSON.stringify(summary, null, 2))

assert.equal(playwright.status, 0, 'isolated current-source Playwright gate must pass')
assert.equal(comparisons.length, 6, 'all light/dark Settings/records/insights pairs must exist')
assert.equal(
  summary.fullPageVisual,
  'COMPARABLE_SEMANTIC_BUSINESS_FIXTURE',
  'paired business fixture must be semantically comparable before acceptance',
)
assert.deepEqual(summary.isolation.externalNetworkRequests, [], 'fixture gate must stay offline')
assert.equal(
  summary.visualAcceptance,
  'PASS_TARGET_SURFACE_EXACT',
  'K12 target surfaces and Settings material gate must pass',
)

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
