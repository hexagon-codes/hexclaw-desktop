import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8')

test('compose isolates and hardens the mock services', async () => {
  const compose = await read('tests/mock/compose.yaml')
  const gateway = await read('tests/mock/fixtures/loopback-gateway.cfg')

  assert.match(compose, /mockserver\/mockserver:7\.4\.0@sha256:[a-f0-9]{64}/)
  assert.match(compose, /haproxy:3\.2\.21-alpine@sha256:[a-f0-9]{64}/)
  assert.match(compose, /ghcr\.io\/shopify\/toxiproxy:2\.12\.0@sha256:[a-f0-9]{64}/)
  assert.match(compose, /profiles:\s*\[chaos\]/)
  assert.match(compose, /loopback_gateway:/)
  assert.match(compose, /127\.0\.0\.1:\$\{HEX_MOCK_PORT:-0\}:18080/)
  assert.match(compose, /127\.0\.0\.1:\$\{HEX_TOXI_CONTROL_PORT:-0\}:18474/)
  assert.match(compose, /127\.0\.0\.1:\$\{HEX_TOXI_PROXY_PORT:-0\}:18666/)
  assert.match(compose, /internal:\s*true/)
  assert.match(compose, /read_only:\s*true/g)
  assert.match(compose, /no-new-privileges:true/g)
  assert.match(compose, /cap_drop:[\s\S]*?- ALL/g)
  assert.match(compose, /mem_limit:/g)
  assert.match(compose, /tmpfs:/g)
  assert.match(compose, /\.\/fixtures:\/config:ro/)
  assert.match(compose, /com\.hexclaw\.test-run:/)
  assert.doesNotMatch(compose, /docker\.sock/)

  const mockserverBlock = compose.match(
    /  mockserver:\n([\s\S]*?)(?=\n  [a-z][a-z0-9_]*:|\nnetworks:)/,
  )?.[1]
  const toxiproxyBlock = compose.match(
    /  toxiproxy:\n([\s\S]*?)(?=\n  [a-z][a-z0-9_]*:|\nnetworks:)/,
  )?.[1]
  const gatewayBlock = compose.match(
    /  loopback_gateway:\n([\s\S]*?)(?=\n  [a-z][a-z0-9_]*:|\nnetworks:)/,
  )?.[1]
  assert.ok(mockserverBlock, 'mockserver service block is missing')
  assert.ok(toxiproxyBlock, 'toxiproxy service block is missing')
  assert.ok(gatewayBlock, 'loopback_gateway service block is missing')
  assert.doesNotMatch(mockserverBlock, /\n    ports:/)
  assert.doesNotMatch(toxiproxyBlock, /\n    ports:/)
  assert.match(mockserverBlock, /networks:\n      - mock_isolated/)
  assert.match(toxiproxyBlock, /networks:\n      - mock_isolated/)
  assert.match(gatewayBlock, /networks:\n      - mock_isolated\n      - loopback_published/)
  assert.match(gatewayBlock, /user:\s*['"]99:99['"]/)

  for (const fixedRoute of [
    ['bind :18080', 'server mockserver mockserver:1080'],
    ['bind :18474', 'server toxiproxy_control toxiproxy:8474'],
    ['bind :18666', 'server toxiproxy_data toxiproxy:8666'],
  ]) {
    assert.ok(gateway.includes(fixedRoute[0]), `gateway is missing ${fixedRoute[0]}`)
    assert.ok(gateway.includes(fixedRoute[1]), `gateway is missing ${fixedRoute[1]}`)
  }
  assert.doesNotMatch(
    gateway,
    /stats\s+(?:enable|uri|socket)|http-request|use_backend|server-template/i,
  )
})

test('MockServer configuration fails closed for active and outbound features', async () => {
  const properties = await read('tests/mock/fixtures/mockserver.properties')
  const propertyLines = new Set(properties.split(/\r?\n/))

  for (const property of [
    'mockserver.mcpEnabled=false',
    'mockserver.llmSemanticMatchingEnabled=false',
    'mockserver.attemptToProxyIfNoMatchingExpectation=false',
    'mockserver.forwardProxyBlockPrivateNetworks=true',
    'mockserver.velocityDisallowClassLoading=true',
    'mockserver.wasmEnabled=false',
    'mockserver.javascriptDisallowedText=return,{',
    'mockserver.velocityDisallowedText={,$',
    'mockserver.mustacheDisallowedText={',
  ]) {
    assert.ok(propertyLines.has(property), `missing fail-closed property: ${property}`)
  }

  assert.doesNotMatch(properties, /(?:apiKey|llmBackend|openai|anthropic)/i)
})

test('fixtures are synthetic, local, and use passive responses only', async () => {
  const fixtureFiles = await readdir(new URL('./fixtures/', import.meta.url), { recursive: true })
  const manifest = JSON.parse(await read('tests/mock/fixtures/manifest.json'))
  const expectations = JSON.parse(await read('tests/mock/fixtures/mockserverInitialization.json'))

  for (const fixtureFile of fixtureFiles) {
    assert.doesNotMatch(fixtureFile, /\.(?:pdf|jpe?g|png|gif|webp|env|pem|key|p12)$/i)
  }

  assert.equal(manifest.schema_version, 1)
  assert.ok(Array.isArray(manifest.fixtures))
  assert.ok(Array.isArray(expectations))
  assert.ok(manifest.fixtures.length > 0)
  assert.equal(
    new Set(manifest.fixtures.map((fixture) => fixture.id)).size,
    manifest.fixtures.length,
  )
  assert.equal(new Set(expectations.map((expectation) => expectation.id)).size, expectations.length)
  for (const fixture of manifest.fixtures) {
    assert.equal(fixture.source, 'synthetic')
    assert.equal(fixture.contains_personal_data, false)
    assert.doesNotMatch(JSON.stringify(fixture), /\.(?:pdf|jpe?g|png)\b/i)
  }

  assert.ok(expectations.length > 0)
  const passiveExpectationKeys = new Set(['id', 'priority', 'httpRequest', 'httpResponse'])
  for (const expectation of expectations) {
    assert.ok(expectation.httpRequest)
    assert.ok(expectation.httpResponse)
    for (const key of Object.keys(expectation)) {
      assert.ok(passiveExpectationKeys.has(key), `active expectation key is forbidden: ${key}`)
    }
  }
  for (const fixture of manifest.fixtures) {
    assert.equal(expectations[fixture.expectation_index]?.id, fixture.id)
  }
})

test('orchestrator exposes bounded lifecycle and label-scoped cleanup', async () => {
  const script = await read('tests/mock/mock-stack.sh')

  for (const command of [
    'validate',
    'preflight',
    'up',
    'wait',
    'endpoint',
    'logs',
    'down',
    'cleanup',
    'run',
  ]) {
    assert.match(script, new RegExp(`^  ${command}\\)`, 'm'))
  }
  assert.match(script, /HEX_MOCK_WAIT_SECONDS/)
  assert.match(script, /require_command node/)
  assert.match(script, /export HEX_MOCKSERVER_URL=/)
  assert.match(script, /write_run_manifest/)
  assert.match(script, /run-manifest\.mjs/)
  assert.match(script, /--lane "\$\{HEX_MOCK_TEST_LANE:-l3-engine-smoke\}"/)
  assert.match(script, /--gateway-image "\$\{GATEWAY_IMAGE\}"/)
  assert.match(script, /capture_failure/)
  assert.match(script, /if ! wait_for_mockserver; then[\s\S]*?capture_failure[\s\S]*?down_stack/)
  assert.match(script, /com\.hexclaw\.test-stack=mock/)
  assert.match(script, /com\.hexclaw\.test-run=/)
  assert.match(script, /docker compose/)
  assert.match(script, /compose_profiled port loopback_gateway 18080/)
  assert.doesNotMatch(script, /docker\s+(?:system|container|network|volume)\s+prune/)
})

test('dedicated Playwright config keeps one worker and failure artifacts', async () => {
  const config = await read('playwright.mock.config.ts')
  const globalSetup = await read('tests/mock/playwright.global-setup.ts')

  assert.match(config, /workers:\s*1/)
  assert.match(config, /fullyParallel:\s*false/)
  assert.match(config, /trace:\s*'retain-on-failure'/)
  assert.match(config, /screenshot:\s*'only-on-failure'/)
  assert.match(config, /video:\s*'retain-on-failure'/)
  assert.match(config, /globalSetup:/)
  assert.match(config, /Browser UI \+ real Sidecar/)
  assert.match(config, /not a native Tauri window/)
  assert.match(globalSetup, /HEX_E2E_SIDECAR_URL/)
  assert.match(globalSetup, /HEX_MOCKSERVER_URL/)
  assert.match(globalSetup, /\/health/)
  assert.match(globalSetup, /__hexclaw_mock__\/ping/)
})

test('package scripts expose the mock stack lifecycle', async () => {
  const pkg = JSON.parse(await read('package.json'))

  for (const command of [
    'mock:validate',
    'mock:preflight',
    'mock:up',
    'mock:wait',
    'mock:logs',
    'mock:down',
    'mock:cleanup',
    'test:e2e:mock',
  ]) {
    assert.equal(typeof pkg.scripts[command], 'string', `missing package script ${command}`)
  }
  assert.match(pkg.scripts['test:e2e:mock'], /HEX_MOCK_TEST_LANE=l4a-browser-sidecar/)
  assert.match(pkg.scripts['test:e2e:mock'], /HEXCLAW_LOCAL_SRC=/)
})

test('native Tauri smoke lane is isolated from production state and CSP', async () => {
  const overlay = JSON.parse(await read('src-tauri/tauri.mock.conf.json'))
  const script = await read('tests/native/native-smoke.sh')

  assert.equal(overlay.identifier, 'com.hexclaw.desktop.mock')
  assert.equal(overlay.productName, 'HexClaw Test')
  assert.match(overlay.app.security.csp, /http:\/\/localhost:16061/)
  assert.doesNotMatch(overlay.app.security.csp, /localhost:11434/)
  assert.match(script, /HEXCLAW_TEST_MODE=1/)
  assert.match(script, /HEXCLAW_TEST_HOME=/)
  assert.match(script, /HEXCLAW_SIDECAR_PORT=16061/)
  assert.match(script, /\/health/)
  assert.match(script, /trap cleanup/)
  assert.match(script, /HexClaw Test\.app/)
  assert.match(script, /CFBundleExecutable/)
  assert.doesNotMatch(script, /Contents\/MacOS\/HexClaw Test/)
})

test('internal-only PoC validates MockServer without publishing a host port', async () => {
  const script = await read('tests/mock/internal-poc.sh')
  const pkg = JSON.parse(await read('package.json'))

  assert.match(script, /network create --internal/)
  assert.match(script, /mockserver\/mockserver:7\.4\.0@sha256:[a-f0-9]{64}/)
  assert.match(script, /curlimages\/curl:8\.13\.0@sha256:[a-f0-9]{64}/)
  assert.match(script, /internal network unexpectedly reached the public internet/)
  assert.match(script, /unmatched request returned/)
  assert.match(script, /trap cleanup/)
  assert.doesNotMatch(script, /^\s+(?:-p|--publish)(?:\s|=)/m)
  assert.equal(typeof pkg.scripts['mock:poc:internal'], 'string')
})

test('protocol fixture matrix covers OpenAI, Ollama, and DingTalk contracts', async () => {
  const manifest = JSON.parse(await read('tests/mock/fixtures/manifest.json'))
  const expectations = JSON.parse(await read('tests/mock/fixtures/mockserverInitialization.json'))
  const byID = new Map(expectations.map((expectation) => [expectation.id, expectation]))
  const manifestIDs = new Set(manifest.fixtures.map((fixture) => fixture.id))

  const matrix = [
    ['openai-chat-nonstream', 'POST', '/v1/chat/completions'],
    ['openai-chat-sse', 'POST', '/v1/chat/completions'],
    ['openai-k12-recognize-mixed-worksheet', 'POST', '/v1/chat/completions'],
    ['openai-k12-answer-locator', 'POST', '/v1/chat/completions'],
    ['openai-k12-answer-transcription', 'POST', '/v1/chat/completions'],
    ['ollama-tags', 'GET', '/api/tags'],
    ['ollama-embed', 'POST', '/api/embed'],
    ['ollama-chat-ndjson', 'POST', '/api/chat'],
    ['ollama-pull-ndjson', 'POST', '/api/pull'],
    ['ollama-delete', 'DELETE', '/api/delete'],
    ['dingtalk-access-token', 'POST', '/v1.0/oauth2/accessToken'],
    ['dingtalk-media-upload', 'POST', '/media/upload'],
    ['dingtalk-oto-send', 'POST', '/v1.0/robot/oToMessages/batchSend'],
    ['dingtalk-oto-recall', 'POST', '/v1.0/robot/otoMessages/batchRecall'],
  ]

  for (const [id, method, path] of matrix) {
    assert.ok(manifestIDs.has(id), `manifest is missing ${id}`)
    const expectation = byID.get(id)
    assert.ok(expectation, `expectations are missing ${id}`)
    assert.equal(expectation.httpRequest.method, method)
    assert.equal(expectation.httpRequest.path, path)
    assert.equal(expectation.httpResponse.statusCode, 200)
  }

  const openAINonstream = byID.get('openai-chat-nonstream')
  const openAISSE = byID.get('openai-chat-sse')
  assert.match(openAINonstream.httpRequest.body.json, /"stream":false/)
  assert.match(openAINonstream.httpResponse.body, /HEXCLAW_MOCK_CHAT_OK/)
  assert.match(openAISSE.httpRequest.body.json, /"stream":true/)
  assert.match(openAISSE.httpResponse.headers['content-type'][0], /text\/event-stream/)
  assert.match(openAISSE.httpResponse.body, /HEXCLAW_MOCK_CHAT_OK/)
  assert.match(openAISSE.httpResponse.body, /data: \[DONE\]/)

  const k12Classifier = byID.get('openai-k12-image-task-classifier')
  const k12Recognize = byID.get('openai-k12-recognize-mixed-worksheet')
  const k12Locator = byID.get('openai-k12-answer-locator')
  const k12Transcription = byID.get('openai-k12-answer-transcription')
  assert.ok(k12Classifier.priority > openAINonstream.priority)
  assert.match(k12Classifier.httpResponse.body, /completed_homework/)
  assert.ok(k12Recognize.priority > openAINonstream.priority)
  assert.ok(k12Locator.priority > k12Recognize.priority)
  assert.ok(k12Transcription.priority > k12Locator.priority)
  for (const field of [
    'question',
    'subject',
    'knowledge_points',
    'answer_state',
    'student_answer',
  ]) {
    assert.match(k12Recognize.httpResponse.body, new RegExp(field))
  }
  for (const field of ['index', 'bbox_1000']) {
    assert.match(k12Locator.httpResponse.body, new RegExp(field))
  }
  for (const field of ['index', 'student_answer']) {
    assert.match(k12Transcription.httpResponse.body, new RegExp(field))
  }

  for (const id of ['ollama-chat-ndjson', 'ollama-pull-ndjson']) {
    const expectation = byID.get(id)
    assert.match(expectation.httpResponse.headers['content-type'][0], /application\/x-ndjson/)
    assert.match(expectation.httpResponse.body, /\n/)
  }
  assert.match(byID.get('ollama-embed').httpResponse.body, /"embeddings"/)
  assert.match(byID.get('ollama-delete').httpRequest.body.json, /"model"/)
  assert.match(byID.get('dingtalk-access-token').httpResponse.body, /"accessToken"/)
  assert.match(byID.get('dingtalk-media-upload').httpResponse.body, /"media_id"/)
  assert.match(byID.get('dingtalk-oto-send').httpResponse.body, /"processQueryKey"/)
  assert.match(byID.get('dingtalk-oto-recall').httpResponse.body, /"successResult"/)
})

test('K12 photo fixtures implement the current independent recognition and anchor protocol', async () => {
  const expectations = JSON.parse(await read('tests/mock/fixtures/mockserverInitialization.json'))
  const byID = new Map(expectations.map((expectation) => [expectation.id, expectation]))

  const recognition = byID.get('openai-k12-recognize-mixed-worksheet')
  const locator = byID.get('openai-k12-answer-locator')
  const transcription = byID.get('openai-k12-answer-transcription')

  assert.ok(locator, 'fixtures must route the production batch answer locator prompt')
  assert.ok(transcription, 'fixtures must route both independent answer transcription views')
  assert.match(locator.httpRequest.body.regex, /批量答案定位/)
  assert.match(locator.httpRequest.body.regex, /bbox_1000/)
  assert.match(locator.httpResponse.body, /bbox_1000/)
  assert.match(transcription.httpRequest.body.regex, /批量答案誊录/)
  assert.match(transcription.httpResponse.body, /student_answer/)

  assert.match(recognition.httpResponse.body, /answer_state/)
  assert.doesNotMatch(
    recognition.httpResponse.body,
    /bbox(?:_1000)?/,
    'core recognition must not forge geometry owned by the independent anchor stage',
  )
})

test('internal-only PoC probes the complete protocol matrix and negative paths', async () => {
  const script = await read('tests/mock/internal-poc.sh')

  for (const marker of [
    'openai_nonstream',
    'openai_sse',
    'ollama_tags',
    'ollama_embed',
    'ollama_chat',
    'ollama_pull',
    'ollama_delete',
    'dingtalk_token',
    'dingtalk_media',
    'dingtalk_send',
    'dingtalk_recall',
    'HEXCLAW_MOCK_CHAT_OK',
    'data: [DONE]',
    'application/x-ndjson',
    '/v1.0/oauth2/accessToken',
    '/media/upload',
    '/v1.0/robot/oToMessages/batchSend',
    '/v1.0/robot/otoMessages/batchRecall',
  ]) {
    assert.ok(script.includes(marker), `internal PoC is missing probe marker ${marker}`)
  }
  assert.match(script, /unmatched request returned/)
  assert.match(script, /internal network unexpectedly reached the public internet/)
  const dockerRunCommands = script
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n')
    .replace(/\\\n/g, ' ')
    .split('\n')
    .filter((line) => /(?:^|\$\(|\s)docker run(?:\s|$)/.test(line))
  assert.ok(dockerRunCommands.length > 0, 'internal PoC must contain docker run commands')
  assert.doesNotMatch(dockerRunCommands.join('\n'), /(?:^|\s)(?:-p|--publish)(?:\s|=)/m)
})
