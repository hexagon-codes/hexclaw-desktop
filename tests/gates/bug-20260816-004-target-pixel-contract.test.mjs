import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const spec = readFileSync(
  path.join(desktopRoot, 'tests/e2e/bug-20260816-004-missing-progress-visual.spec.ts'),
  'utf8',
)
const runner = readFileSync(
  path.join(desktopRoot, 'tests/e2e/run-bug-20260816-004-missing-progress-visual.mjs'),
  'utf8',
)

test('BUG-20260816-004 visual gate makes content-owned pixels release blocking', () => {
  assert.match(spec, /const PIXEL_THRESHOLD = 8/)
  assert.match(spec, /const MAX_TARGET_CHANGED_PIXEL_RATIO = 0\.001/)
  assert.match(spec, /target-title-reference\.png/)
  assert.match(spec, /target-title-current\.png/)
  assert.match(spec, /target-button-reference\.png/)
  assert.match(spec, /target-button-current\.png/)
  assert.match(spec, /strictPixelDiffHelper/)
  assert.match(spec, /screenshot size mismatch/)
  assert.match(spec, /'NOT_COMPARABLE'/)
  assert.match(spec, /gating:\s*false/)
  assert.match(spec, /contentInvariantPass/)
  assert.match(spec, /targetPixelPass/)
  assert.match(spec, /shellAttribution/)
  assert.match(spec, /pass:\s*contentInvariantPass\s*&&\s*targetPixelPass/)
  assert.match(runner, /wide\.acceptance\.targetPixelPass, true/)
  assert.match(runner, /narrow\.acceptance\.targetPixelPass, true/)
  assert.match(runner, /maxChangedPixelRatio/)
  assert.match(runner, /rawCardPixel/)
  assert.match(runner, /shellAttribution/)
})
