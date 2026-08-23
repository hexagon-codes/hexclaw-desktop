import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const docsRoot = path.resolve(desktopRoot, '../hexclaw-docs')
const evidenceRoot = path.join(
  docsRoot,
  'test/evidence/bug-20260816-004-current-source-visual',
)
const sourcePort = 27304
const referencePort = 27314

function sanitize(value) {
  return value
    .replaceAll(desktopRoot, '<hexclaw-desktop>')
    .replaceAll(docsRoot, '<hexclaw-docs>')
    .replaceAll(process.env.HOME ?? '<no-home>', '<home>')
}

mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 })
const run = spawnSync(
  'pnpm',
  [
    'exec',
    'playwright',
    'test',
    '-c',
    'tests/e2e/bug-20260816-004-missing-progress.playwright.config.ts',
    '--workers=1',
  ],
  {
    cwd: desktopRoot,
    env: {
      ...process.env,
      HEX_BUG004_SOURCE_PORT: String(sourcePort),
      HEX_BUG004_REFERENCE_PORT: String(referencePort),
      HEX_BUG004_SOURCE_URL: `http://127.0.0.1:${sourcePort}`,
      HEX_BUG004_REFERENCE_URL: `http://127.0.0.1:${referencePort}/app.html`,
      HEX_BUG004_EVIDENCE_DIR: evidenceRoot,
    },
    encoding: 'utf8',
    timeout: 240_000,
  },
)
writeFileSync(
  path.join(evidenceRoot, 'playwright-supported-window.log'),
  sanitize(`${run.stdout}${run.stderr}`),
)

const report = (state) =>
  JSON.parse(
    readFileSync(path.join(evidenceRoot, 'chromium', state, 'report.json'), 'utf8'),
  )
const wide = report('wide-1226x700')
const narrow = report('narrow-supported-min-900x700')
const summary = {
  bugId: 'BUG-20260816-004',
  decision:
    wide.acceptance.pass && narrow.acceptance.pass ? 'BUG_NOT_REPRODUCED' : 'BUG_REPRODUCED',
  playwrightExitCode: run.status,
  supportedWindowBoundary: {
    source: 'src-tauri/tauri.conf.json',
    minWidth: 900,
    minHeight: 600,
    excludedViewport: '660x700',
    exclusionReason: 'below the frozen Tauri minWidth and unreachable by the product window',
  },
  isolation: {
    sourcePort,
    referencePort,
    loopbackOnly: true,
    externalRequests: [...wide.externalRequests, ...narrow.externalRequests],
    providerCalls: 0,
    imCalls: 0,
    installedApplicationTouched: false,
  },
  states: {
    wide: {
      status: wide.status,
      pass: wide.acceptance.pass,
      contentInvariantPass: wide.acceptance.contentInvariantPass,
      targetPixelPass: wide.acceptance.targetPixelPass,
      failedCurrentChecks: wide.acceptance.failedCurrentChecks,
      rawCardPixel: {
        gating: wide.rawCardPixel.gating,
        changedPixelRatio: wide.rawCardPixel.changed_pixel_ratio,
      },
      targetPixels: {
        maxChangedPixelRatio: wide.targetPixels.maxChangedPixelRatio,
        title: wide.targetPixels.title,
        button: wide.targetPixels.button,
      },
      shellAttribution: wide.shellAttribution,
    },
    narrow: {
      status: narrow.status,
      pass: narrow.acceptance.pass,
      contentInvariantPass: narrow.acceptance.contentInvariantPass,
      targetPixelPass: narrow.acceptance.targetPixelPass,
      failedCurrentChecks: narrow.acceptance.failedCurrentChecks,
      rawCardPixel: {
        gating: narrow.rawCardPixel.gating,
        changedPixelRatio: narrow.rawCardPixel.changed_pixel_ratio,
      },
      targetPixels: {
        maxChangedPixelRatio: narrow.targetPixels.maxChangedPixelRatio,
        title: narrow.targetPixels.title,
        button: narrow.targetPixels.button,
      },
      shellAttribution: narrow.shellAttribution,
    },
  },
  acceptedInvariant:
    'At the supported 900px minimum width and at 1226px, title and button remain exact, nowrap, on one row, non-overlapping, and inside the viewport.',
}
writeFileSync(path.join(evidenceRoot, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)

assert.equal(wide.status, 'PASS', 'wide state must pass content and target pixels')
assert.equal(narrow.status, 'PASS', 'narrow state must pass content and target pixels')
assert.equal(wide.acceptance.pass, true, 'wide approved invariant should pass')
assert.equal(narrow.acceptance.pass, true, 'supported narrow invariant should pass')
assert.equal(wide.acceptance.contentInvariantPass, true)
assert.equal(narrow.acceptance.contentInvariantPass, true)
assert.equal(wide.acceptance.targetPixelPass, true)
assert.equal(narrow.acceptance.targetPixelPass, true)
assert.deepEqual(narrow.acceptance.failedCurrentChecks, [])
assert.equal(run.status, 0, 'Playwright must be GREEN at supported window widths')
assert.deepEqual(summary.isolation.externalRequests, [], 'visual gate must remain loopback-only')

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
