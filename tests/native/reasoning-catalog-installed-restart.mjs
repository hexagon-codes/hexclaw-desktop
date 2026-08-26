#!/usr/bin/env node

/**
 * 安装态 reasoning 目录重启门禁。
 *
 * `validate` 只核验脚本与 `/Applications` 安装包身份，不启动应用。`run` 必须显式授权，
 * 使用 Desktop 自带的 Test Home 隔离机制和仅所有者可读的夹具 YAML，连续启动两代同一
 * 安装包，并且每代只读取一次 LLM 配置。上游夹具只负责证明启动与读取目录期间没有模型
 * 请求；平台配置不包含 IM 实例，因此本门禁不会发送任何消息。
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer as createHTTPServer } from 'node:http'
import { createConnection, createServer as createTCPServer } from 'node:net'
import { dirname, extname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const installedCandidateEnv = 'HEXCLAW_REASONING_CATALOG_INSTALLED_CANDIDATE'
const runOptIn = 'HEXCLAW_RUN_REASONING_CATALOG_INSTALLED'
const foregroundOptIn = 'HEXCLAW_ALLOW_FOREGROUND_NATIVE_UI'
const evidenceFileEnv = 'HEXCLAW_REASONING_CATALOG_EVIDENCE_FILE'
const configAPIPath = '/api/v1/config/llm'
const providerName = 'hexclaw-gpt'
const providerInstanceID = 'pvd_v1_ffffffffffffffffffffffffffffffff'
const modelID = 'gpt-5.6-sol'
const apiToken = 'fixture-only-reasoning-catalog-token'
const providerAPIKey = 'fixture-only-provider-key'
const fixturePrefix = 'hexclaw-reasoning-catalog-installed.'
const sleep = (milliseconds) =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds))

export const EXPECTED_CATALOG_PROJECTION = Object.freeze({
  default: providerName,
  reasoning_provider: providerName,
  reasoning_model: modelID,
  provider: providerName,
  model: modelID,
  models: [modelID],
  model_specs_mode: 'explicit',
  model_spec: {
    id: modelID,
    capabilities: ['text'],
    reasoning_support: 'supported',
    reasoning_control: {
      dialect: 'reasoning_effort',
      on: 'low',
      off: 'none',
      allowed_efforts: ['low'],
    },
  },
})

function usage() {
  return `Usage:
  node tests/native/reasoning-catalog-installed-restart.mjs validate
  ${runOptIn}=1 ${foregroundOptIn}=1 ${evidenceFileEnv}=<new-json-path> node tests/native/reasoning-catalog-installed-restart.mjs run

validate is static-only. run opens the exact installed Desktop twice inside one isolated Test Home.
The run gate permits only GET ${configAPIPath}; it never calls a model or IM endpoint.
`
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function installedFileIdentity(path) {
  const link = lstatSync(path)
  assert.ok(link.isFile() && !link.isSymbolicLink(), `Installed artifact is not physical: ${path}`)
  assert.equal(realpathSync(path), path, `Installed artifact resolves through a symlink: ${path}`)
  const info = statSync(path, { bigint: true })
  return {
    sha256: sha256File(path),
    device: String(info.dev),
    inode: String(info.ino),
    size: String(info.size),
    mode: String(info.mode),
    mtime_ns: String(info.mtimeNs),
    ctime_ns: String(info.ctimeNs),
  }
}

function resolveInstalledArtifact() {
  assert.equal(process.platform, 'darwin', 'Installed reasoning catalog gate is macOS-only')
  const requestedBundle = resolve(
    process.env[installedCandidateEnv]?.trim() || '/Applications/HexClaw.app',
  )
  assert.equal(dirname(requestedBundle), '/Applications', 'Installed candidate must be in /Applications')
  const link = lstatSync(requestedBundle)
  assert.ok(
    link.isDirectory() && !link.isSymbolicLink(),
    'Installed candidate must be a physical application bundle',
  )
  const bundlePath = realpathSync(requestedBundle)
  assert.equal(bundlePath, requestedBundle, 'Installed candidate must not resolve through a symlink')

  const desktopExecutable = join(bundlePath, 'Contents/MacOS/hexclaw-desktop')
  const sidecarExecutable = join(bundlePath, 'Contents/MacOS/hexclaw')
  const infoPlist = join(bundlePath, 'Contents/Info.plist')
  for (const path of [desktopExecutable, sidecarExecutable, infoPlist]) {
    assert.ok(existsSync(path), `Installed artifact is missing: ${path}`)
  }

  const identifier = execFileSync(
    '/usr/bin/plutil',
    ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', infoPlist],
    { encoding: 'utf8' },
  ).trim()
  const version = execFileSync(
    '/usr/bin/plutil',
    ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', infoPlist],
    { encoding: 'utf8' },
  ).trim()
  assert.equal(identifier, 'com.hexclaw.desktop', 'Installed bundle identifier drifted')
  assert.equal(version, '0.5.0-beta', 'Installed bundle version drifted')

  const bundleInfo = statSync(bundlePath, { bigint: true })
  return {
    bundlePath,
    desktopExecutable,
    sidecarExecutable,
    infoPlist,
    identifier,
    version,
    desktopSHA256: installedFileIdentity(desktopExecutable).sha256,
    sidecarSHA256: installedFileIdentity(sidecarExecutable).sha256,
    infoPlistSHA256: installedFileIdentity(infoPlist).sha256,
    bundle: {
      device: String(bundleInfo.dev),
      inode: String(bundleInfo.ino),
      mode: String(bundleInfo.mode),
      mtime_ns: String(bundleInfo.mtimeNs),
      ctime_ns: String(bundleInfo.ctimeNs),
    },
    files: {
      desktop: installedFileIdentity(desktopExecutable),
      sidecar: installedFileIdentity(sidecarExecutable),
      infoPlist: installedFileIdentity(infoPlist),
    },
  }
}

function assertInstalledArtifactUnchanged(frozen) {
  assert.deepEqual(resolveInstalledArtifact(), frozen, 'Installed artifact changed during the gate')
}

function publicInstalledIdentity(installed) {
  return {
    candidateBundle: installed.bundlePath,
    identifier: installed.identifier,
    version: installed.version,
    desktopSHA256: installed.desktopSHA256,
    sidecarSHA256: installed.sidecarSHA256,
    infoPlistSHA256: installed.infoPlistSHA256,
  }
}

function assertLoopbackOrigin(value) {
  const parsed = new URL(value)
  assert.equal(parsed.protocol, 'http:', 'Fixture Provider must use HTTP loopback')
  assert.equal(parsed.hostname, '127.0.0.1', 'Fixture Provider must bind to IPv4 loopback')
  assert.ok(Number.isInteger(Number(parsed.port)) && Number(parsed.port) > 0)
  assert.equal(parsed.pathname, '/', 'Fixture Provider origin must not include a path')
}

export function buildFixtureConfig({ fixtureHome, sidecarPort, providerOrigin }) {
  assert.ok(fixtureHome.startsWith('/'), 'Fixture home must be absolute')
  assert.ok(Number.isInteger(sidecarPort) && sidecarPort > 0 && sidecarPort <= 65535)
  assertLoopbackOrigin(providerOrigin)
  const databasePath = join(fixtureHome, '.hexclaw', 'data.db')
  return `server:
  host: 127.0.0.1
  port: ${sidecarPort}
  mode: development
  api_token: ${apiToken}
platforms:
  web:
    enabled: true
llm:
  default: ${providerName}
  reasoning_provider: ${providerName}
  reasoning_model: ${modelID}
  providers:
    ${providerName}:
      provider_instance_id: ${providerInstanceID}
      display_name: Fixture Reasoning Catalog
      api_key: ${providerAPIKey}
      base_url: ${providerOrigin}/v1
      model: ${modelID}
      models:
        - ${modelID}
      model_specs_mode: explicit
      model_specs:
        - id: ${modelID}
          capabilities: [text]
          reasoning_support: supported
          reasoning_control:
            dialect: reasoning_effort
            on: low
            off: none
            allowed_efforts: [low]
      compatible: openai
      locality: cloud
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
    path: ${JSON.stringify(databasePath)}
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
observe:
  log_level: info
  metrics:
    enabled: false
`
}

export function assertExactReasoningCatalog(body) {
  assert.ok(body && typeof body === 'object', 'LLM config response is missing')
  const provider = body.providers?.[providerName]
  assert.ok(provider && typeof provider === 'object', 'Fixture Provider is missing')
  assert.equal(body.default, providerName)
  assert.equal(body.reasoning_provider, providerName)
  assert.equal(body.reasoning_model, modelID)
  assert.equal(provider.model, modelID)
  assert.deepEqual(provider.models, [modelID])
  assert.equal(provider.model_specs_mode, 'explicit')
  assert.ok(Array.isArray(provider.model_specs), 'Provider model_specs is missing')
  const matching = provider.model_specs.filter((spec) => spec?.id === modelID)
  assert.equal(matching.length, 1, 'Expected exactly one gpt-5.6-sol model spec')
  assert.equal(provider.model_specs.length, 1, 'Fixture Provider contains an unexpected model spec')
  const modelSpec = matching[0]
  const projection = {
    default: body.default,
    reasoning_provider: body.reasoning_provider,
    reasoning_model: body.reasoning_model,
    provider: providerName,
    model: provider.model,
    models: provider.models,
    model_specs_mode: provider.model_specs_mode,
    model_spec: {
      id: modelSpec.id,
      capabilities: modelSpec.capabilities,
      reasoning_support: modelSpec.reasoning_support,
      reasoning_control: modelSpec.reasoning_control,
    },
  }
  assert.deepEqual(projection, EXPECTED_CATALOG_PROJECTION)
  return projection
}

function assertSHA256(value, label) {
  assert.match(value || '', /^[a-f0-9]{64}$/u, `${label} must be SHA-256`)
}

export function buildRestartEvidence({
  installedIdentity,
  generations,
  providerBoundaryRequests,
  permissions,
  modelInvocations = 0,
  imInvocations = 0,
}) {
  assert.equal(installedIdentity?.identifier, 'com.hexclaw.desktop')
  assert.equal(installedIdentity?.version, '0.5.0-beta')
  assertSHA256(installedIdentity?.desktopSHA256, 'Desktop identity')
  assertSHA256(installedIdentity?.sidecarSHA256, 'Sidecar identity')
  assertSHA256(installedIdentity?.infoPlistSHA256, 'Info.plist identity')
  assert.equal(generations?.length, 2, 'Exactly two installed generations are required')
  assert.notEqual(generations[0].appPID, generations[1].appPID, 'Desktop process did not restart')
  assert.notEqual(generations[0].sidecarPID, generations[1].sidecarPID, 'Sidecar process did not restart')
  for (const [index, generation] of generations.entries()) {
    assert.deepEqual(generation.apiAudit, [{ method: 'GET', path: configAPIPath, status: 200 }])
    assert.deepEqual(generation.projection, EXPECTED_CATALOG_PROJECTION)
    assert.equal(generation.name, `generation-${index + 1}`)
  }
  assert.deepEqual(generations[1].projection, generations[0].projection)
  assert.deepEqual(providerBoundaryRequests, [], 'Model Provider boundary received a request')
  assert.equal(modelInvocations, 0, 'Model invocation count must remain zero')
  assert.equal(imInvocations, 0, 'IM invocation count must remain zero')
  assert.deepEqual(permissions, {
    testHome: 0o700,
    configDirectory: 0o700,
    yaml: 0o600,
  })

  return {
    schema_version: 1,
    status: 'PASS',
    acceptance_id: 'LLM-REASONING-CATALOG-PRESERVE-007',
    boundary: 'exact-installed-fixture-catalog-restart',
    fixture_only: true,
    real_provider: false,
    installedIdentity,
    isolation: {
      test_home: true,
      private_yaml: true,
      real_user_config_read: false,
      real_user_config_modified: false,
      real_user_sqlite_read: false,
      real_user_sqlite_modified: false,
      direct_sqlite_access: false,
    },
    catalog: generations[0].projection,
    restart: {
      desktop_pid_changed: true,
      sidecar_pid_changed: true,
      catalog_exact_after_restart: true,
    },
    permissions,
    harness_api: {
      observability_scope: 'harness-owned-public-api',
      method: 'GET',
      path: configAPIPath,
      generations: 2,
      total_requests: 2,
    },
    calls: {
      model: 0,
      im: 0,
      provider_boundary: 0,
    },
  }
}

async function reserveLoopbackPort() {
  const server = createTCPServer()
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const port = address.port
  await new Promise((resolveClose, rejectClose) =>
    server.close((error) => (error ? rejectClose(error) : resolveClose())),
  )
  assert.ok(![16060, 11434].includes(port), `Forbidden shared port selected: ${port}`)
  return port
}

function listenerPIDs(port) {
  try {
    return execFileSync('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
      encoding: 'utf8',
    })
      .split(/\s+/u)
      .filter(Boolean)
      .map(Number)
  } catch {
    return []
  }
}

function processCommand(pid) {
  return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], {
    encoding: 'utf8',
  }).trim()
}

function processExists(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    throw error
  }
}

function installedDesktopPIDs(installed) {
  const rows = execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
  return rows
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const match = line.match(/^(\d+)\s+(.+)$/u)
      if (!match) return []
      const command = match[2]
      return command === installed.desktopExecutable ||
        command.startsWith(`${installed.desktopExecutable} `)
        ? [Number(match[1])]
        : []
    })
}

function runtimeEnvironment(fixtureHome, sidecarPort) {
  return {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: 'zh_CN.UTF-8',
    LC_ALL: 'zh_CN.UTF-8',
    HEXCLAW_TEST_MODE: '1',
    HEXCLAW_TEST_HOME: fixtureHome,
    HEXCLAW_SIDECAR_PORT: String(sidecarPort),
    HEXCLAW_TEST_LLM_CONFIG_MODE: 'preseeded-owner-yaml',
    HEXCLAW_TEST_ALLOW_AUTO_LOCAL_OLLAMA: '0',
    HEXCLAW_TEST_PROFILE_CATCHUP: '0',
    HEXCLAW_DISABLE_BACKGROUND_EGRESS: '1',
    HEXCLAW_DISABLE_IM: 'all',
    DINGTALK_LIVE_SEND: '0',
    HTTP_PROXY: 'http://127.0.0.1:9',
    HTTPS_PROXY: 'http://127.0.0.1:9',
    ALL_PROXY: 'http://127.0.0.1:9',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  }
}

function createProviderBoundary(port) {
  const requests = []
  const server = createHTTPServer((request, response) => {
    requests.push({ method: request.method || '', path: request.url || '' })
    response.writeHead(503, { 'Content-Type': 'application/json' })
    response.end('{"error":"fixture Provider must not be called"}')
  })
  return {
    requests,
    origin: `http://127.0.0.1:${port}`,
    async listen() {
      await new Promise((resolveListen, rejectListen) => {
        server.once('error', rejectListen)
        server.listen(port, '127.0.0.1', resolveListen)
      })
    },
    async close() {
      if (!server.listening) return
      await new Promise((resolveClose, rejectClose) =>
        server.close((error) => (error ? rejectClose(error) : resolveClose())),
      )
    },
  }
}

async function waitForTCP(port, child) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error('Installed Desktop exited before its Sidecar listened')
    }
    const connected = await new Promise((resolveConnect) => {
      const socket = createConnection({ host: '127.0.0.1', port })
      socket.setTimeout(750)
      socket.once('connect', () => {
        socket.destroy()
        resolveConnect(true)
      })
      socket.once('timeout', () => {
        socket.destroy()
        resolveConnect(false)
      })
      socket.once('error', () => resolveConnect(false))
    })
    if (connected) return
    await sleep(150)
  }
  throw new Error('Installed Sidecar did not listen before timeout')
}

async function readCatalog(port, apiAudit) {
  const response = await fetch(`http://127.0.0.1:${port}${configAPIPath}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiToken}` },
    signal: AbortSignal.timeout(5_000),
  })
  apiAudit.push({ method: 'GET', path: configAPIPath, status: response.status })
  const body = await response.json()
  assert.equal(response.status, 200, 'Installed LLM catalog GET failed')
  return body
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  const exited = await Promise.race([
    new Promise((resolveExit) => child.once('exit', () => resolveExit(true))),
    sleep(5_000).then(() => false),
  ])
  if (!exited && processExists(child.pid)) {
    child.kill('SIGKILL')
    await new Promise((resolveExit) => child.once('exit', resolveExit))
  }
}

async function stopOwnedSidecar(port, installed) {
  for (const pid of listenerPIDs(port)) {
    const command = processCommand(pid)
    assert.ok(
      command === installed.sidecarExecutable ||
        command.startsWith(`${installed.sidecarExecutable} `),
      `Refusing to stop an unowned listener: ${command}`,
    )
    process.kill(pid, 'SIGTERM')
  }
  const deadline = Date.now() + 10_000
  while (listenerPIDs(port).length > 0 && Date.now() < deadline) await sleep(100)
  assert.deepEqual(listenerPIDs(port), [], 'Installed Sidecar did not release its fixture port')
}

async function runGeneration({ name, installed, fixtureHome, sidecarPort }) {
  assertInstalledArtifactUnchanged(installed)
  assert.deepEqual(installedDesktopPIDs(installed), [], 'An installed Desktop process is already running')
  assert.deepEqual(listenerPIDs(sidecarPort), [], 'Fixture Sidecar port is occupied')
  const configDirectory = join(fixtureHome, '.hexclaw')
  const configPath = join(configDirectory, 'hexclaw.yaml')
  const expectedPermissions = { testHome: 0o700, configDirectory: 0o700, yaml: 0o600 }
  assert.deepEqual(permissionSnapshot(fixtureHome, configDirectory, configPath), expectedPermissions)
  const child = spawn(installed.desktopExecutable, [], {
    cwd: fixtureHome,
    env: runtimeEnvironment(fixtureHome, sidecarPort),
    stdio: 'ignore',
  })
  try {
    await waitForTCP(sidecarPort, child)
    assert.ok(processExists(child.pid), 'Installed Desktop process is missing')
    assert.equal(processCommand(child.pid), installed.desktopExecutable)
    const sidecarPIDs = listenerPIDs(sidecarPort)
    assert.equal(sidecarPIDs.length, 1, 'Installed Desktop must own exactly one Sidecar listener')
    const sidecarPID = sidecarPIDs[0]
    const sidecarCommand = processCommand(sidecarPID)
    assert.ok(
      sidecarCommand === installed.sidecarExecutable ||
        sidecarCommand.startsWith(`${installed.sidecarExecutable} `),
      'Listener does not execute the exact installed Sidecar',
    )
    assert.equal(sha256File(installed.sidecarExecutable), installed.sidecarSHA256)
    const apiAudit = []
    const projection = assertExactReasoningCatalog(await readCatalog(sidecarPort, apiAudit))
    return { name, appPID: child.pid, sidecarPID, apiAudit, projection }
  } finally {
    await stopProcess(child)
    await stopOwnedSidecar(sidecarPort, installed)
    assert.deepEqual(permissionSnapshot(fixtureHome, configDirectory, configPath), expectedPermissions)
    assertInstalledArtifactUnchanged(installed)
  }
}

function permissionSnapshot(fixtureHome, configDirectory, configPath) {
  return {
    testHome: statSync(fixtureHome).mode & 0o777,
    configDirectory: statSync(configDirectory).mode & 0o777,
    yaml: statSync(configPath).mode & 0o777,
  }
}

function evidenceFilePath() {
  const requested = process.env[evidenceFileEnv]?.trim()
  assert.ok(requested, `${evidenceFileEnv} is required for run`)
  assert.ok(requested.startsWith('/'), `${evidenceFileEnv} must be absolute`)
  const path = resolve(requested)
  assert.equal(extname(path), '.json', 'Evidence artifact must be a JSON file')
  assert.equal(path.includes('/.hexclaw/'), false, 'Evidence artifact must not target user config data')
  assert.equal(existsSync(path), false, 'Evidence artifact already exists')
  mkdirSync(dirname(path), { recursive: true })
  return path
}

function writeEvidence(path, evidence) {
  assert.equal(evidence.fixture_only, true)
  assert.equal(evidence.real_provider, false)
  assert.deepEqual(evidence.calls, { model: 0, im: 0, provider_boundary: 0 })
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  assert.equal(statSync(path).mode & 0o777, 0o600)
}

function validateStatic() {
  const installed = resolveInstalledArtifact()
  const frozen = structuredClone(installed)
  const source = readFileSync(scriptPath, 'utf8')
  assert.match(source, /HEXCLAW_TEST_HOME/u)
  assert.match(source, /preseeded-owner-yaml/u)
  assert.match(source, /fixture_only:\s*true/u)
  assert.match(source, /real_provider:\s*false/u)
  assert.equal((source.match(/['"]\/api\/v1\/config\/llm['"]/gu) || []).length, 1)
  for (const forbidden of [
    'globalThis.' + 'fetch =',
    'navigator.' + 'clipboard',
    'execFileSync(' + "'sqlite3'",
    'from ' + "'node:sqlite'",
  ]) {
    assert.equal(source.includes(forbidden), false, `Forbidden harness behavior: ${forbidden}`)
  }
  assertInstalledArtifactUnchanged(frozen)
  return {
    status: 'PASS',
    mode: 'static-only',
    appLaunched: false,
    sidecarStarted: false,
    fixture_only: true,
    real_provider: false,
    modelInvocations: 0,
    imInvocations: 0,
    realUserConfigRead: false,
    realUserConfigModified: false,
    realUserSQLiteRead: false,
    realUserSQLiteModified: false,
    installedIdentity: {
      ...publicInstalledIdentity(installed),
      frozen: true,
      unchanged: true,
    },
    exactInstalledRunDeferred: true,
    evidenceArtifactRequiredForRun: true,
  }
}

async function runInstalled() {
  assert.equal(process.env[runOptIn], '1', `${runOptIn}=1 is required for run`)
  assert.equal(
    process.env[foregroundOptIn],
    '1',
    `${foregroundOptIn}=1 is required because run opens the installed Desktop`,
  )
  const evidencePath = evidenceFilePath()
  const installed = resolveInstalledArtifact()
  const frozen = structuredClone(installed)
  assert.deepEqual(installedDesktopPIDs(installed), [], 'An installed Desktop process is already running')

  const fixtureHome = mkdtempSync(join(tmpdir(), fixturePrefix))
  assert.equal(resolve(fixtureHome), realpathSync(fixtureHome))
  assert.ok(fixtureHome.startsWith(realpathSync(tmpdir()) + '/'))
  chmodSync(fixtureHome, 0o700)
  const configDirectory = join(fixtureHome, '.hexclaw')
  mkdirSync(configDirectory, { mode: 0o700 })
  chmodSync(configDirectory, 0o700)
  mkdirSync(join(fixtureHome, 'tmp'), { mode: 0o700 })
  const configPath = join(configDirectory, 'hexclaw.yaml')
  const sidecarPort = await reserveLoopbackPort()
  let providerPort = await reserveLoopbackPort()
  while (providerPort === sidecarPort) providerPort = await reserveLoopbackPort()
  const providerBoundary = createProviderBoundary(providerPort)
  writeFileSync(
    configPath,
    buildFixtureConfig({
      fixtureHome,
      sidecarPort,
      providerOrigin: providerBoundary.origin,
    }),
    { flag: 'wx', mode: 0o600 },
  )
  chmodSync(configPath, 0o600)

  const generations = []
  let providerClosed = false
  let sandboxRemoved = false
  try {
    await providerBoundary.listen()
    generations.push(
      await runGeneration({
        name: 'generation-1',
        installed: frozen,
        fixtureHome,
        sidecarPort,
      }),
    )
    generations.push(
      await runGeneration({
        name: 'generation-2',
        installed: frozen,
        fixtureHome,
        sidecarPort,
      }),
    )
    assert.deepEqual(providerBoundary.requests, [], 'Catalog read unexpectedly called the Provider')
    assert.deepEqual(permissionSnapshot(fixtureHome, configDirectory, configPath), {
      testHome: 0o700,
      configDirectory: 0o700,
      yaml: 0o600,
    })
  } finally {
    await stopOwnedSidecar(sidecarPort, frozen)
    await providerBoundary.close()
    providerClosed = true
    assert.deepEqual(listenerPIDs(sidecarPort), [])
    assertInstalledArtifactUnchanged(frozen)
    assert.ok(fixtureHome.startsWith(realpathSync(tmpdir()) + `/${fixturePrefix}`))
    rmSync(fixtureHome, { recursive: true, force: true })
    sandboxRemoved = !existsSync(fixtureHome)
  }
  assert.equal(providerClosed, true)
  assert.equal(sandboxRemoved, true)

  const evidence = buildRestartEvidence({
    installedIdentity: publicInstalledIdentity(frozen),
    generations,
    providerBoundaryRequests: providerBoundary.requests,
    permissions: { testHome: 0o700, configDirectory: 0o700, yaml: 0o600 },
    modelInvocations: providerBoundary.requests.length,
    imInvocations: 0,
  })
  evidence.cleanup = {
    provider_boundary_closed: providerClosed,
    sidecar_port_released: listenerPIDs(sidecarPort).length === 0,
    fixture_home_removed: sandboxRemoved,
  }
  writeEvidence(evidencePath, evidence)
  return evidence
}

async function main() {
  const command = process.argv[2] || '--help'
  if (command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(usage())
    return
  }
  if (command === 'validate') {
    process.stdout.write(`${JSON.stringify(validateStatic(), null, 2)}\n`)
    return
  }
  if (command === 'run') {
    process.stdout.write(`${JSON.stringify(await runInstalled(), null, 2)}\n`)
    return
  }
  throw new Error(`Unknown command: ${command}`)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath)) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`)
    process.exitCode = 1
  })
}
