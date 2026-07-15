import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8')

test('browser lane owns a real, isolated sidecar lifecycle', async () => {
  const script = await read('tests/mock/browser-lane.sh')
  const pkg = JSON.parse(await read('package.json'))

  assert.match(script, /HEX_MOCKSERVER_URL/)
  assert.match(script, /HEX_E2E_SIDECAR_URL/)
  assert.match(script, /HEXCLAW_LOCAL_SRC/)
  assert.match(script, /go build/)
  assert.match(script, /serve --desktop --config/)
  assert.match(script, /env -i/)
  assert.match(script, /HEXCLAW_DISABLE_IM=all/)
  assert.match(script, /trap cleanup/)
  assert.match(script, /\/health/)
  assert.doesNotMatch(script, /OPENAI_API_KEY=\$\{/)
  assert.match(pkg.scripts['test:e2e:mock'], /browser-lane\.sh/)
})

test('browser mock spec proves the UI reaches the synthetic provider through the sidecar', async () => {
  const spec = await read('tests/e2e/browser-mock-chat.spec.ts')

  assert.match(spec, /HEXCLAW_MOCK_CHAT_OK/)
  assert.match(spec, /chat-input/)
  assert.match(spec, /chat-send/)
  assert.match(spec, /hc-msg--assistant/)
  assert.doesNotMatch(spec, /route\(|page\.on\(['"]request/)
})

test('browser mock K12 spec covers the mixed worksheet business chain without request interception', async () => {
  const spec = await read('tests/e2e/browser-mock-k12.spec.ts')

  for (const marker of [
    'recognize-confirm-all',
    'rq-solve-0',
    'rq-grade-1',
    'photo-grade-overlay',
    'overlay-toggle',
    '错题本',
  ]) {
    assert.ok(spec.includes(marker), `K12 browser spec is missing ${marker}`)
  }
  assert.doesNotMatch(spec, /page\.route\(|context\.route\(|request interception/i)
})
