import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const docsRoot = path.resolve(desktopRoot, '../hexclaw-docs')
const evidenceRoot = path.join(docsRoot, 'test/evidence/bug-20260801-012-ambient-current-source')

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

function sanitize(value) {
  return value.replaceAll(desktopRoot, '<hexclaw-desktop>').replaceAll(docsRoot, '<hexclaw-docs>')
}

mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 })

const staticGate = run('pnpm', [
  'exec',
  'vitest',
  'run',
  'src/features/k12/__tests__/BUG-20260801-012-k12-appearance-v9.RED.test.ts',
  'src/features/k12/__tests__/K12Appearance.test.ts',
  '--maxWorkers=1',
])
writeFileSync(
  path.join(evidenceRoot, 'targeted-static-dom-contract.log'),
  sanitize(`${staticGate.stdout}${staticGate.stderr}`),
)
assert.equal(staticGate.status, 0, 'targeted BUG-20260801-012 static/DOM contracts must pass')

const sourcePort = await allocatePort()
let referencePort = await allocatePort()
while (referencePort === sourcePort) referencePort = await allocatePort()

const playwright = run(
  'pnpm',
  ['exec', 'playwright', 'test', '-c', 'tests/e2e/bug-20260801-012-ambient.playwright.config.ts'],
  {
    env: {
      HEX_K12_AMBIENT_SOURCE_PORT: String(sourcePort),
      HEX_K12_AMBIENT_REFERENCE_PORT: String(referencePort),
      HEX_K12_AMBIENT_SOURCE_URL: `http://127.0.0.1:${sourcePort}`,
      HEX_K12_AMBIENT_REFERENCE_URL: `http://127.0.0.1:${referencePort}/app.html`,
    },
  },
)
writeFileSync(
  path.join(evidenceRoot, 'playwright-current-source.log'),
  sanitize(`${playwright.stdout}${playwright.stderr}`),
)
assert.equal(playwright.status, 0, 'isolated current-source ambient evidence run must complete')

const comparisons = readdirSync(evidenceRoot)
  .filter((name) => /^comparison-(?:light|dark)\.json$/.test(name))
  .sort()
  .map((name) => JSON.parse(readFileSync(path.join(evidenceRoot, name), 'utf8')))
const motions = readdirSync(evidenceRoot)
  .filter((name) => /^motion-(?:light|dark)\.json$/.test(name))
  .sort()
  .map((name) => JSON.parse(readFileSync(path.join(evidenceRoot, name), 'utf8')))

assert.equal(comparisons.length, 2, 'both Light and Dark reduced-motion pairs must exist')
assert.equal(motions.length, 2, 'both Light and Dark no-preference motion records must exist')

const externalRequests = [
  ...comparisons.flatMap((item) => item.network.externalRequests),
  ...motions.flatMap((item) => item.network.externalRequests),
]
assert.deepEqual(externalRequests, [], 'fixture gate must remain loopback-only')

const summary = {
  bugId: 'BUG-20260801-012',
  scope: 'K12 global ambient layer: Light butterflies, Dark fireflies, Sidebar material',
  isolation: {
    sourcePort,
    referencePort,
    workers: 1,
    loopbackOnly: true,
    externalRequests,
    realModelCalls: 0,
    installedApplicationTouched: false,
  },
  staticDomContract: { pass: staticGate.status === 0 },
  reducedMotionPairs: comparisons.map((item) => ({
    theme: item.theme,
    stateComparable: item.semantic.comparable,
    exactSetPass: item.exactSet.pass,
    geometryPass: item.geometry.pass,
    computedStylePass: item.computedStyle.pass,
    reducedMotionPass: item.reducedMotion.pass,
    responsiveAndGenericPass: item.responsiveAndGeneric.pass,
    fullPageChangedPixelRatio: item.pixel.fullPage.changed_pixel_ratio,
    ambientCropChangedPixelRatio: item.pixel.ambientCrop.changed_pixel_ratio,
    materialSceneChangedPixelRatio: item.pixel.materialScene.changed_pixel_ratio,
    ambientTargetDecision: item.ambientTargetDecision,
    decision: item.decision,
    visibleDrift: item.visibleDrift,
  })),
  motion: motions.map((item) => ({
    theme: item.theme,
    stateComparable: item.semantic.comparable,
    referencePass: item.reference.pass,
    currentPass: item.current.pass,
  })),
  currentSourceDecision:
    comparisons.every((item) => item.decision === 'PASS') &&
    motions.every((item) => item.semantic.comparable && item.reference.pass && item.current.pass)
      ? 'PASS'
      : comparisons.every((item) => item.semantic.comparable) &&
          motions.every((item) => item.semantic.comparable)
        ? 'NOT_PASS'
        : 'NOT_COMPARABLE',
  ambientTargetDecision: comparisons.every((item) => item.ambientTargetDecision === 'PASS')
    ? 'PASS'
    : comparisons.every((item) => item.semantic.comparable)
      ? 'NOT_PASS'
      : 'NOT_COMPARABLE',
  nativeThirdLeg: {
    status: 'NOT_RUN',
    reason:
      'A uniquely built Test.app with proven fixture parity was not already available; /Applications and user data were left untouched.',
  },
}
writeFileSync(path.join(evidenceRoot, 'execution-summary.json'), JSON.stringify(summary, null, 2))
if (summary.ambientTargetDecision !== 'PASS') {
  writeFileSync(
    path.join(evidenceRoot, 'pre-fix-ambient-red-summary.json'),
    JSON.stringify(summary, null, 2),
  )
}
assert.equal(
  summary.ambientTargetDecision,
  'PASS',
  'approved BUG-20260801-012 ambient target must match the authoritative prototype',
)
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
