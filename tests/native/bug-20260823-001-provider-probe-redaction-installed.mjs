#!/usr/bin/env node

/**
 * BUG-20260823-001 的当前源码安装包回归。
 *
 * 使用隔离 Test.app、临时 HOME/YAML/SQLite 和回环假上游，验证 Provider 探测失败
 * 的 HTTP 响应与重启恢复的回执都不会携带原始上游正文。不会访问用户 HOME、
 * /Applications、真实 Provider 或 IM。
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const nativeDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(nativeDir, '../..')
const srcTauriRoot = join(repoRoot, 'src-tauri')
const runNonce = `${Date.now()}-${process.pid}`
const productName = `HexClaw Provider Probe Redaction Test ${runNonce}`
const testBundleID = `com.hexclaw.desktop.provider-probe-redaction-${process.pid}`
const temporaryBundlePath = join(srcTauriRoot, 'target/release/bundle/macos', `${productName}.app`)
const evidenceRoot = resolve(
  process.env.HEXCLAW_EVIDENCE_ROOT ||
    join(repoRoot, 'test/evidence/provider-probe-redaction-installed-20260823'),
)
const apiToken = 'provider-probe-redaction-installed-token'
const providerKey = 'probe-fixture'
const providerID = 'pvd_v1_8a6f09e3d72b4c15a49fb736e15ac204'
const providerAPIKey = 'provider-probe-redaction-fixture-key'
const modelID = 'provider-probe-redaction-model'
const rawBodySentinel = 'native-private-upstream-body'
const traceSentinel = 'native-request-trace-should-not-leak'
const sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds))

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function nativeTargetTriple() {
  if (process.arch === 'arm64') return 'aarch64-apple-darwin'
  if (process.arch === 'x64') return 'x86_64-apple-darwin'
  throw new Error(`unsupported macOS architecture: ${process.arch}`)
}

function buildTemporaryTestApp(sandbox) {
  const triple = nativeTargetTriple()
  const sourceSidecar = join(srcTauriRoot, 'binaries', `hexclaw-${triple}`)
  const frontend = join(repoRoot, 'dist')
  assert.ok(existsSync(sourceSidecar), 'current-source Sidecar binary is missing')
  assert.ok(existsSync(join(frontend, 'index.html')), 'current-source package-local frontend is missing')

  const binaries = join(sandbox, 'binaries')
  mkdirSync(binaries, { recursive: true, mode: 0o700 })
  const sidecarBase = join(binaries, 'hexclaw')
  const copiedSidecar = `${sidecarBase}-${triple}`
  copyFileSync(sourceSidecar, copiedSidecar)
  chmodSync(copiedSidecar, 0o700)

  assert.equal(existsSync(temporaryBundlePath), false, 'refusing to overwrite an existing temporary Test.app')
  const overlay = join(sandbox, 'tauri.provider-probe-redaction.json')
  writeFileSync(
    overlay,
    `${JSON.stringify(
      {
        productName,
        identifier: testBundleID,
        build: { frontendDist: frontend, beforeBuildCommand: '' },
        bundle: {
          targets: ['app'],
          createUpdaterArtifacts: false,
          externalBin: [relative(srcTauriRoot, sidecarBase)],
        },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  )
  execFileSync('pnpm', ['exec', 'tauri', 'build', '--config', overlay, '--bundles', 'app'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CARGO_NET_OFFLINE: 'true',
      CARGO_TARGET_DIR: join(srcTauriRoot, 'target'),
      PNPM_CONFIG_OFFLINE: 'true',
      npm_config_offline: 'true',
      GOENV: 'off',
      GOPROXY: 'off',
      GOSUMDB: 'off',
    },
    stdio: 'ignore',
    timeout: 8 * 60 * 1000,
  })
  const appExecutable = join(temporaryBundlePath, 'Contents/MacOS/hexclaw-desktop')
  const sidecarExecutable = join(temporaryBundlePath, 'Contents/MacOS/hexclaw')
  assert.ok(existsSync(appExecutable), 'temporary Test.app executable is missing')
  assert.ok(existsSync(sidecarExecutable), 'temporary Test.app Sidecar is missing')
  return {
    sourceSidecar,
    testAppBundle: temporaryBundlePath,
    appExecutable,
    sidecarExecutable,
    sourceSidecarSHA256: sha256File(sourceSidecar),
    temporaryExecutableSHA256: sha256File(appExecutable),
    temporarySidecarSHA256: sha256File(sidecarExecutable),
  }
}

function listenerPIDs(port) {
  try {
    return execFileSync('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
      encoding: 'utf8',
      timeout: 5_000,
    })
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number)
      .filter(Number.isInteger)
  } catch (error) {
    if (error?.status === 1) return []
    throw error
  }
}

function processCommand(pid) {
  try {
    return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      timeout: 5_000,
    }).trim()
  } catch {
    return ''
  }
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForExit(processHandle, timeoutMs = 8_000) {
  if (!processHandle || processHandle.exitCode !== null || processHandle.signalCode !== null) return
  await new Promise((resolveExit) => {
    const timer = setTimeout(resolveExit, timeoutMs)
    processHandle.once('exit', () => {
      clearTimeout(timer)
      resolveExit()
    })
  })
}

async function waitForPortRelease(port, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (listenerPIDs(port).length === 0) return true
    await sleep(100)
  }
  return listenerPIDs(port).length === 0
}

async function allocateLoopbackPort() {
  const reservation = createServer()
  await new Promise((resolveListen, rejectListen) => {
    reservation.once('error', rejectListen)
    reservation.listen(0, '127.0.0.1', resolveListen)
  })
  const address = reservation.address()
  assert.ok(address && typeof address !== 'string', 'loopback reservation did not return a TCP port')
  const port = address.port
  await new Promise((resolveClose, rejectClose) => reservation.close((error) => (error ? rejectClose(error) : resolveClose())))
  return port
}

function renderConfig({ sandbox, sidecarPort, fixtureOrigin }) {
  return `server:
  host: 127.0.0.1
  port: ${sidecarPort}
  mode: development
  api_token: ${apiToken}
platforms:
  web:
    enabled: true
llm:
  default: ${providerKey}
  providers:
    ${providerKey}:
      provider_instance_id: ${providerID}
      display_name: Provider Probe Fixture
      api_key: ${providerAPIKey}
      base_url: ${fixtureOrigin}/v1
      model: ${modelID}
      models:
        - ${modelID}
      model_specs_mode: explicit
      model_specs:
        - id: ${modelID}
          display_name: Provider Probe Fixture Model
          capabilities:
            - text
      compatible: openai
      locality: local
      tools_enabled: false
      enabled: true
  routing:
    enabled: false
  cache:
    enabled: false
  tools:
    enabled: "off"
storage:
  driver: sqlite
  sqlite:
    path: ${JSON.stringify(join(sandbox, '.hexclaw/data.db'))}
knowledge:
  enabled: false
memory:
  long_term:
    enabled: false
  vector:
    enabled: false
file_memory:
  enabled: false
heartbeat:
  enabled: false
mcp:
  enabled: false
skills:
  enabled: false
  auto_load: false
router:
  enabled: false
voice:
  enabled: false
skill:
  sandbox:
    enabled: false
  builtin:
    search: false
    weather: false
    browser: false
    code_exec: false
    file_ops: false
`
}

async function readRequestBody(request) {
  const chunks = []
  let length = 0
  for await (const chunk of request) {
    length += chunk.length
    if (length > 256 * 1024) throw new Error('fixture request exceeds 256 KiB')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function jsonResponse(response, status, body) {
  const encoded = JSON.stringify(body)
  response.writeHead(status, {
    'Content-Length': Buffer.byteLength(encoded),
    'Content-Type': 'application/json; charset=utf-8',
  })
  response.end(encoded)
}

async function createFixture() {
  const state = { modelsCalls: 0, probeCalls: 0, unexpected: [] }
  const server = createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1')
    try {
      if (request.method === 'GET' && url.pathname === '/v1/models') {
        state.modelsCalls += 1
        jsonResponse(response, 200, { object: 'list', data: [{ id: modelID, object: 'model' }] })
        return
      }
      if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
        await readRequestBody(request)
        state.probeCalls += 1
        jsonResponse(response, 429, {
          error: {
            type: 'rate_limit_error',
            message: 'fixture rate limit',
            metadata: { trace_id: traceSentinel, private_body: rawBodySentinel },
          },
        })
        return
      }
      state.unexpected.push(`${request.method || 'UNKNOWN'} ${url.pathname}`)
      jsonResponse(response, 404, { error: 'unexpected fixture request' })
    } catch {
      state.unexpected.push('fixture request processing failed')
      if (!response.headersSent) jsonResponse(response, 500, { error: 'fixture failure' })
      else response.destroy()
    }
  })
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string', 'fixture did not bind a TCP port')
  return {
    state,
    origin: `http://127.0.0.1:${address.port}`,
    async close() {
      if (!server.listening) return
      await new Promise((resolveClose, rejectClose) => server.close((error) => (error ? rejectClose(error) : resolveClose())))
    },
  }
}

function appEnvironment({ sandbox, sidecarPort }) {
  const tempDir = join(sandbox, 'tmp')
  return {
    PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: sandbox,
    USERPROFILE: sandbox,
    CFFIXED_USER_HOME: sandbox,
    TMPDIR: tempDir,
    TEMP: tempDir,
    TMP: tempDir,
    HEXCLAW_TEST_MODE: '1',
    HEXCLAW_TEST_HOME: sandbox,
    HEXCLAW_SIDECAR_PORT: String(sidecarPort),
    HEXCLAW_TEST_LLM_CONFIG_MODE: 'preseeded-owner-yaml',
    HEXCLAW_TEST_PROFILE_CATCHUP: '0',
    HEXCLAW_TEST_ALLOW_AUTO_LOCAL_OLLAMA: '0',
    HEXCLAW_DISABLE_BACKGROUND_EGRESS: '1',
    NO_PROXY: '*',
    no_proxy: '*',
  }
}

async function waitForHealth({ apiOrigin, appProcess }) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (appProcess.exitCode !== null || appProcess.signalCode !== null) {
      throw new Error('Test.app exited before the isolated Sidecar became healthy')
    }
    try {
      const response = await fetch(`${apiOrigin}/health`, { signal: AbortSignal.timeout(1_000) })
      if (response.ok) return
    } catch {
      // Sidecar 仍在启动。
    }
    await sleep(150)
  }
  throw new Error('isolated Sidecar health check timed out')
}

async function api({ apiOrigin, path, method = 'GET', body }) {
  const response = await fetch(`${apiOrigin}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })
  const raw = await response.text()
  let data = null
  try {
    data = raw ? JSON.parse(raw) : null
  } catch {
    throw new Error(`isolated API ${method} ${path} returned a non-JSON response`)
  }
  assert.equal(response.status, 200, `isolated API ${method} ${path} returned an unexpected status`)
  return data
}

function providerFromConfig(config) {
  const provider = config?.providers?.[providerKey]
  assert.ok(provider, 'isolated fixture Provider is missing from loaded config')
  return provider
}

function assertPublicMessage(value, label) {
  assert.equal(typeof value, 'string', `${label} must be a string`)
  assert.ok(value.trim().length > 0, `${label} must retain a public error reason`)
  for (const forbidden of [rawBodySentinel, traceSentinel, '"metadata"', 'body:', providerAPIKey]) {
    assert.equal(value.includes(forbidden), false, `${label} leaked an upstream private field`)
  }
}

function classifyFailure(error) {
  const message = error instanceof Error ? error.message : ''
  if (message.includes('exited before') || message.includes('health check timed out')) return 'test-app-startup'
  if (message.includes('probe HTTP response')) return 'http-response-redaction'
  if (message.includes('reentry persisted receipt')) return 'receipt-reentry-redaction'
  if (message.includes('restarted persisted receipt')) return 'receipt-restart-redaction'
  if (message.includes('fixture upstream failure')) return 'fixture-probe-outcome'
  if (message.includes('provider probe may be sent')) return 'unexpected-probe-count'
  if (message.includes('unexpected request')) return 'unexpected-loopback-request'
  if (message.includes('current-source') || message.includes('temporary Test.app')) return 'temporary-package-build'
  return 'isolated-boundary-contract'
}

async function stopGeneration({ appProcess, sidecarPort, sidecarExecutable }) {
  if (appProcess && processExists(appProcess.pid)) {
    appProcess.kill('SIGTERM')
    await waitForExit(appProcess)
    if (processExists(appProcess.pid)) appProcess.kill('SIGKILL')
  }
  const pids = listenerPIDs(sidecarPort)
  if (!sidecarExecutable) {
    assert.deepEqual(pids, [], 'dedicated Sidecar port is occupied without a test bundle owner')
    return
  }
  for (const pid of pids) {
    const command = processCommand(pid)
    assert.ok(command.includes(sidecarExecutable), 'isolated Sidecar port has an unexpected owner')
    process.kill(pid, 'SIGTERM')
  }
  assert.equal(await waitForPortRelease(sidecarPort), true, 'isolated Sidecar port was not released')
}

async function main() {
  assert.equal(process.platform, 'darwin', 'current-source installed boundary is macOS-only')

  const sidecarPort = await allocateLoopbackPort()
  assert.deepEqual(listenerPIDs(sidecarPort), [], 'dedicated Sidecar port is already occupied')
  const sandbox = mkdtempSync(join(tmpdir(), 'hexclaw-provider-probe-redaction.'))
  const configDir = join(sandbox, '.hexclaw')
  const tempDir = join(sandbox, 'tmp')
  mkdirSync(configDir, { recursive: true, mode: 0o700 })
  mkdirSync(tempDir, { recursive: true, mode: 0o700 })
  chmodSync(sandbox, 0o700)
  chmodSync(configDir, 0o700)
  chmodSync(tempDir, 0o700)

  const fixture = await createFixture()
  const configPath = join(configDir, 'hexclaw.yaml')
  const databasePath = join(configDir, 'data.db')
  writeFileSync(configPath, renderConfig({ sandbox, sidecarPort, fixtureOrigin: fixture.origin }), {
    mode: 0o600,
  })
  chmodSync(configPath, 0o600)

  const apiOrigin = `http://127.0.0.1:${sidecarPort}`
  const observations = {
    responseSafe: false,
    persistedReceiptSafe: false,
    restartedReceiptSafe: false,
    providerAttemptsForExplicitProbe: 0,
    providerAttemptsAfterRestart: 0,
  }
  const cleanup = {
    sidecarPortReleased: false,
    fixtureClosed: false,
    temporaryTestAppRemoved: false,
    sandboxRemoved: false,
  }
  let appProcess = null
  let failure = null
  let failureCode = null
  let packageBuild = null

  const startGeneration = async () => {
    assert.ok(packageBuild, 'temporary Test.app build is missing')
    assert.deepEqual(listenerPIDs(sidecarPort), [], 'dedicated Sidecar port is occupied before Test.app start')
    appProcess = spawn(packageBuild.appExecutable, [], {
      cwd: sandbox,
      env: appEnvironment({ sandbox, sidecarPort }),
      stdio: 'ignore',
    })
    await waitForHealth({ apiOrigin, appProcess })
    const pids = listenerPIDs(sidecarPort)
    assert.equal(pids.length, 1, 'Test.app must own exactly one isolated Sidecar listener')
    assert.ok(
      processCommand(pids[0]).includes(packageBuild.sidecarExecutable),
      'isolated listener is not the bundled Sidecar',
    )
  }

  try {
    packageBuild = buildTemporaryTestApp(sandbox)
    await startGeneration()
    const providerCallsBeforeProbe = fixture.state.probeCalls
    const response = await api({
      apiOrigin,
      path: '/api/v1/config/llm/test',
      method: 'POST',
      body: {
        provider: {
          type: 'custom',
          provider_instance_id: providerID,
          base_url: `${fixture.origin}/v1`,
          api_key: providerAPIKey,
          model: modelID,
          locality: 'local',
        },
      },
    })
    assert.equal(response.ok, false, 'fixture upstream failure must remain a failed probe')
    assert.equal(response.persisted, true, 'matching saved Provider must persist the probe receipt')
    assertPublicMessage(response.message, 'probe HTTP response message')
    observations.responseSafe = true

    const reentryProvider = providerFromConfig(await api({ apiOrigin, path: '/api/v1/config/llm' }))
    assert.equal(reentryProvider.probe_receipt?.outcome, 'failed', 'reentry receipt outcome must remain failed')
    assertPublicMessage(reentryProvider.probe_receipt?.message, 'reentry persisted receipt message')
    observations.persistedReceiptSafe = true
    observations.providerAttemptsForExplicitProbe = fixture.state.probeCalls - providerCallsBeforeProbe
    assert.ok(
      observations.providerAttemptsForExplicitProbe >= 1,
      'explicit probe must reach the isolated loopback Provider',
    )

    await stopGeneration({ appProcess, sidecarPort, sidecarExecutable: packageBuild.sidecarExecutable })
    appProcess = null
    const providerCallsBeforeRestart = fixture.state.probeCalls
    await startGeneration()
    const restartedProvider = providerFromConfig(await api({ apiOrigin, path: '/api/v1/config/llm' }))
    assert.equal(restartedProvider.probe_receipt?.outcome, 'failed', 'restarted receipt outcome must remain failed')
    assertPublicMessage(restartedProvider.probe_receipt?.message, 'restarted persisted receipt message')
    observations.restartedReceiptSafe = true
    observations.providerAttemptsAfterRestart = fixture.state.probeCalls - providerCallsBeforeRestart
    assert.deepEqual(fixture.state.unexpected, [], 'fixture received an unexpected request')
    assert.equal(statSync(configDir).mode & 0o777, 0o700, 'isolated config directory permissions drifted')
    assert.equal(statSync(configPath).mode & 0o777, 0o600, 'isolated YAML permissions drifted')
    assert.ok(existsSync(databasePath), 'isolated SQLite receipt database was not created')
  } catch (error) {
    failure = error
    failureCode = classifyFailure(error)
  } finally {
    try {
      await stopGeneration({
        appProcess,
        sidecarPort,
        sidecarExecutable: packageBuild?.sidecarExecutable || '',
      })
    } catch (error) {
      failure ||= error
    }
    cleanup.sidecarPortReleased = await waitForPortRelease(sidecarPort)
    if (!cleanup.sidecarPortReleased) failure ||= new Error('isolated Sidecar port remained occupied after cleanup')
    try {
      await fixture.close()
      cleanup.fixtureClosed = true
    } catch (error) {
      failure ||= error
    }

    rmSync(temporaryBundlePath, { recursive: true, force: true })
    cleanup.temporaryTestAppRemoved = !existsSync(temporaryBundlePath)
    rmSync(sandbox, { recursive: true, force: true })
    cleanup.sandboxRemoved = true
    mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 })
    const summary = {
      status: failure ? 'FAIL' : 'PASS',
      boundary: 'current-source temporary Test.app / isolated Sidecar / loopback fake upstream',
      app: {
        sourceSidecarSHA256: packageBuild?.sourceSidecarSHA256 || null,
        temporaryExecutableSHA256: packageBuild?.temporaryExecutableSHA256 || null,
        temporarySidecarSHA256: packageBuild?.temporarySidecarSHA256 || null,
        temporaryBundleID: testBundleID,
      },
      assertions: {
        responseSafe: observations.responseSafe,
        persistedReceiptSafe: observations.persistedReceiptSafe,
        restartedReceiptSafe: observations.restartedReceiptSafe,
        providerAttemptsForExplicitProbe: observations.providerAttemptsForExplicitProbe,
        providerAttemptsAfterRestart: observations.providerAttemptsAfterRestart,
      },
      isolation: {
        temporaryHome: true,
        temporaryYAML: true,
        temporarySQLite: true,
        loopbackOnlyFixture: true,
        realProviderCalls: 0,
        realModelCalls: 0,
        realIMCalls: 0,
        userHomeTouched: false,
        applicationsTouched: false,
      },
      cleanup,
      failure: failure ? failureCode || 'isolated-boundary-contract' : null,
    }
    writeFileSync(join(evidenceRoot, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, {
      mode: 0o600,
    })
  }

  if (failure) throw failure
  process.stdout.write(`PASS ${evidenceRoot}\n`)
}

const timeout = setTimeout(() => {
  process.stderr.write('FAIL installed provider-probe redaction boundary exceeded 3 minutes\n')
  process.exit(124)
}, 10 * 60 * 1000)
timeout.unref()

main().catch(() => {
  process.stderr.write('FAIL installed provider-probe redaction boundary\n')
  process.exitCode = 1
})
