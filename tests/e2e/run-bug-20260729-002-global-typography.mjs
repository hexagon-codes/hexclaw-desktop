import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const docsRoot = path.resolve(desktopRoot, '../hexclaw-docs')
const evidenceRoot = path.join(docsRoot, 'test/evidence/bug-20260729-002-global-typography-current')

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
      server.close((error) => (error ? reject(error) : resolve(address.port)))
    })
  })
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd ?? desktopRoot,
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
    timeout: options.timeout ?? 300_000,
  })
}

function sanitize(value) {
  return value
    .replaceAll(desktopRoot, '<hexclaw-desktop>')
    .replaceAll(docsRoot, '<hexclaw-docs>')
    .replaceAll(process.env.HOME ?? '<no-home>', '<home>')
}

function digest(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function git(cwd, args) {
  const result = run('git', args, { cwd })
  assert.equal(result.status, 0, `git ${args.join(' ')} failed in ${cwd}`)
  return result.stdout.trim()
}

function plistValue(file, key) {
  const result = run('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, file])
  return result.status === 0 ? result.stdout.trim() : null
}

function isolatedTestAppPreflight() {
  const bundleRoot = path.join(desktopRoot, 'src-tauri/target/release/bundle/macos')
  const processList = run('ps', ['-axo', 'pid=,command=']).stdout
  const candidates = existsSync(bundleRoot)
    ? readdirSync(bundleRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.endsWith('Test.app'))
        .map((entry) => {
          const appPath = path.join(bundleRoot, entry.name)
          const plist = path.join(appPath, 'Contents/Info.plist')
          const executableName = existsSync(plist) ? plistValue(plist, 'CFBundleExecutable') : null
          const executable = executableName
            ? path.join(appPath, 'Contents/MacOS', executableName)
            : null
          return {
            path: sanitize(appPath),
            bundleIdentifier: existsSync(plist) ? plistValue(plist, 'CFBundleIdentifier') : null,
            version: existsSync(plist) ? plistValue(plist, 'CFBundleShortVersionString') : null,
            executableSha256: executable && existsSync(executable) ? digest(executable) : null,
            running: processList.includes(appPath),
          }
        })
    : []
  return {
    status: 'NOT_COMPARABLE',
    mode: 'read-only-preflight',
    installedApplicationTouched: false,
    applicationsPathReadOrWritten: false,
    candidateLaunched: false,
    candidateModified: false,
    candidates,
    fixtureParity: false,
    screenshotChannel: false,
    computedStyleChannel: false,
    decision:
      'An isolated Test.app without an exact current-source build manifest, same-state fixture injection channel, screenshot pair, and WKWebView computed-style channel cannot close the installed third leg. Existing unrelated Test.app bundles were inspected read-only and were not launched or reused.',
  }
}

mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 })
const sourcePort = await allocatePort()
let referencePort = await allocatePort()
while (referencePort === sourcePort) referencePort = await allocatePort()

const identity = {
  desktop: {
    head: git(desktopRoot, ['rev-parse', 'HEAD']),
    globalCssSha256: digest(path.join(desktopRoot, 'src/assets/styles/global.css')),
    testSha256: digest(
      path.join(desktopRoot, 'tests/e2e/bug-20260729-002-global-typography-visual.spec.ts'),
    ),
  },
  docs: {
    head: git(docsRoot, ['rev-parse', 'HEAD']),
    prototypeSha256: digest(path.join(docsRoot, 'prototype/app.html')),
  },
}
writeFileSync(
  path.join(evidenceRoot, 'build-identity.json'),
  `${JSON.stringify(identity, null, 2)}\n`,
)

const playwright = run(
  'pnpm',
  [
    'exec',
    'playwright',
    'test',
    '-c',
    'tests/e2e/bug-20260729-002-global-typography.playwright.config.ts',
    '--workers=1',
  ],
  {
    env: {
      HEX_BUG002_SOURCE_PORT: String(sourcePort),
      HEX_BUG002_REFERENCE_PORT: String(referencePort),
      HEX_BUG002_SOURCE_URL: `http://127.0.0.1:${sourcePort}`,
      HEX_BUG002_REFERENCE_URL: `http://127.0.0.1:${referencePort}/app.html`,
      HEX_BUG002_EVIDENCE_DIR: evidenceRoot,
    },
  },
)
writeFileSync(
  path.join(evidenceRoot, 'playwright.log'),
  sanitize(`${playwright.stdout}${playwright.stderr}`),
)

const results = ['chromium', 'webkit'].flatMap((engine) => {
  const directory = path.join(evidenceRoot, engine)
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(directory, entry.name, 'result.json'))
    .filter(existsSync)
    .map((file) => JSON.parse(readFileSync(file, 'utf8')))
})
const nativePreflight = isolatedTestAppPreflight()
writeFileSync(
  path.join(evidenceRoot, 'test-app-read-only-preflight.json'),
  `${JSON.stringify(nativePreflight, null, 2)}\n`,
)

const evidenceFiles = []
function inventory(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) inventory(absolute)
    else if (absolute !== path.join(evidenceRoot, 'summary.json')) {
      evidenceFiles.push({
        path: path.relative(evidenceRoot, absolute),
        size: statSync(absolute).size,
        sha256: digest(absolute),
      })
    }
  }
}
inventory(evidenceRoot)

const summary = {
  bugId: 'BUG-20260729-002',
  isolation: {
    sourcePort,
    referencePort,
    loopbackOnly: true,
    installedApplicationTouched: false,
    userDataTouched: false,
    externalNetworkRequests: results.flatMap((result) => [
      ...result.network.sourceExternalRequests,
      ...result.network.referenceExternalRequests,
    ]),
  },
  coverageBasis: {
    uniqueGlobalCssEntryPoints: ['main AppLayout', 'blank QuickChat layout'],
    orthogonalStates: ['light', 'dark', 'K12 global skin'],
    surfacesPerEngine: 4,
    engines: ['chromium', 'webkit'],
  },
  playwright: {
    exitCode: playwright.status,
    expectedPairs: 8,
    capturedPairs: results.length,
    rootTypographyPassPairs: results.filter((result) => result.rootTypography.pass).length,
    probePixelPassPairs: results.filter((result) => result.probePixels.pass).length,
    fullSurfaceComparablePairs: results.filter(
      (result) => result.fullSurface.status !== 'NOT_COMPARABLE',
    ).length,
  },
  decision: {
    rootTypography:
      results.length === 8 && results.every((result) => result.rootTypography.pass)
        ? 'PASS'
        : 'FAIL',
    independentFullSurfaceStructure: 'NOT_COMPARABLE',
    installedThirdLeg: nativePreflight.status,
    releaseClosure: nativePreflight.status === 'PASS' ? 'PASS' : 'NOT_PASS',
    rationale:
      'The isolated homomorphic probe evaluates only inherited root typography. Full-page prototype/source differences remain disclosed but are not attributed to this bug. The exact installed-app third leg remains NOT COMPARABLE.',
  },
  nativePreflight,
  results: results.map((result) => ({
    engine: result.engine,
    surface: result.surface.id,
    rootTypographyPass: result.rootTypography.pass,
    probeChangedPixelRatio: result.probePixels.changed_pixel_ratio,
    probePixelPass: result.probePixels.pass,
    fullSurfaceStatus: result.fullSurface.status,
    fullChangedPixelRatio: result.fullSurface.pixels.changed_pixel_ratio,
    independentSurfaceDifferenceCount: result.fullSurface.independentSurfaceDifferences.length,
  })),
  evidenceFiles,
}
writeFileSync(path.join(evidenceRoot, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)

assert.equal(playwright.status, 0, 'BUG-20260729-002 Playwright gate must complete')
assert.equal(results.length, 8, 'all Chromium/WebKit typography pairs must be captured')
assert.deepEqual(summary.isolation.externalNetworkRequests, [], 'visual gate must remain offline')
assert.equal(summary.decision.rootTypography, 'PASS', 'root typography must match the oracle')
assert.equal(
  summary.playwright.probePixelPassPairs,
  8,
  'every homomorphic probe pixel pair must pass',
)
assert.equal(
  nativePreflight.candidateLaunched,
  false,
  'read-only Test.app preflight must not launch a bundle',
)

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
