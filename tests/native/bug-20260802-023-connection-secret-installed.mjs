#!/usr/bin/env node

/**
 * BUG-20260802-023：隔离 Test.app 的真实 Sidecar HTTP 凭据闭环。
 *
 * 只使用 Connection secret；Provider 列表为空，不发送任何 Provider 凭据。
 * 每次运行使用独立 HOME、YAML、SQLite 和 loopback 端口，验证保存、重启读取、
 * preserve 读改写、删除以及磁盘密文边界。
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const nativeDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(nativeDir, '../..')
const appBundle = resolve(
  process.env.HEXCLAW_TEST_APP ||
    join(repoRoot, 'src-tauri/target/release/bundle/macos/HexClaw Test.app'),
)
const appExecutable = join(appBundle, 'Contents/MacOS/hexclaw-desktop')
const sidecarExecutable = join(appBundle, 'Contents/MacOS/hexclaw')
const evidenceBase = join(repoRoot, 'test/evidence/bug-20260802-023-connection-secret-installed')
const apiToken = 'connection-live-api-token-023'
const connectionOwner = 'connection-live-owner-023'
const connectionSecret = 'connection-only-secret-023'
const connectionName = 'connection-live-023'
const sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds))

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
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

async function freePort() {
  const server = net.createServer()
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const port = server.address().port
  await new Promise((resolveClose) => server.close(resolveClose))
  return port
}

function renderConfig(sandbox, port) {
  const dbPath = JSON.stringify(join(sandbox, '.hexclaw/data.db'))
  return `server:
  host: 127.0.0.1
  port: ${port}
  api_token: ${apiToken}
llm:
  default: ""
  providers: {}
  routing:
    enabled: false
  cache:
    enabled: false
  tools:
    enabled: "off"
storage:
  driver: sqlite
  sqlite:
    path: ${dbPath}
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
  enabled: true
  servers: []
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

function appEnvironment(sandbox, port) {
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
    HEXCLAW_SIDECAR_PORT: String(port),
    HEXCLAW_TEST_LLM_CONFIG_MODE: 'preseeded-owner-yaml',
    HEXCLAW_TEST_PROFILE_CATCHUP: '0',
    NO_PROXY: '*',
    no_proxy: '*',
  }
}

async function waitForHealth(child, baseURL, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Test.app exited before Sidecar health: ${child.exitCode ?? child.signalCode}`)
    }
    try {
      const response = await fetch(`${baseURL}/health`, { signal: AbortSignal.timeout(1_000) })
      if (response.ok) return
    } catch {
      // 启动窗口内连接拒绝属于预期轮询状态。
    }
    await sleep(150)
  }
  throw new Error('Timed out waiting for isolated Test.app Sidecar health')
}

async function waitForPortRelease(port, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (listenerPIDs(port).length === 0) return true
    await sleep(100)
  }
  return listenerPIDs(port).length === 0
}

async function waitForExit(child, timeoutMs = 10_000) {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise((resolveExit) => {
    const timer = setTimeout(resolveExit, timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolveExit()
    })
  })
}

async function request(baseURL, path, options = {}) {
  const response = await fetch(`${baseURL}${path}`, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(options.timeoutMs || 20_000),
  })
  const text = await response.text()
  let data = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
  }
  const expected = options.expected || [200]
  assert.ok(
    expected.includes(response.status),
    `${options.method || 'GET'} ${path} status=${response.status}, expected=${expected.join(',')}, body=${text}`,
  )
  return { status: response.status, data }
}

async function stopGeneration(generation, port) {
  if (generation?.child && processExists(generation.child.pid)) {
    generation.child.kill('SIGTERM')
    await waitForExit(generation.child)
    if (processExists(generation.child.pid)) generation.child.kill('SIGKILL')
  }
  for (const pid of listenerPIDs(port)) {
    const command = processCommand(pid)
    if (command.includes(sidecarExecutable)) {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        // The supervisor may already have reaped the child.
      }
    }
  }
  const released = await waitForPortRelease(port)
  assert.equal(released, true, `isolated Sidecar port ${port} was not released`)
}

async function main() {
  assert.equal(process.platform, 'darwin', 'installed Test.app boundary is macOS-only')
  assert.ok(existsSync(appExecutable), `Test.app executable is missing: ${appExecutable}`)
  assert.ok(existsSync(sidecarExecutable), `Test.app Sidecar is missing: ${sidecarExecutable}`)

  const port = await freePort()
  assert.deepEqual(listenerPIDs(port), [], `dedicated Sidecar port ${port} is occupied`)
  const sandbox = mkdtempSync(join(tmpdir(), 'hexclaw-connection-secret-023.'))
  const configDir = join(sandbox, '.hexclaw')
  const tempDir = join(sandbox, 'tmp')
  mkdirSync(configDir, { recursive: true, mode: 0o700 })
  mkdirSync(tempDir, { recursive: true, mode: 0o700 })
  chmodSync(sandbox, 0o700)
  chmodSync(configDir, 0o700)
  chmodSync(tempDir, 0o700)
  const configPath = join(configDir, 'hexclaw.yaml')
  writeFileSync(configPath, renderConfig(sandbox, port), { mode: 0o600 })
  chmodSync(configPath, 0o600)
  const baseURL = `http://127.0.0.1:${port}`
  const ref = `sidecar-connection:v1:${connectionOwner}:password`
  const generations = []
  let generation = null
  let failure = null

  try {
    const start = async (name) => {
      assert.deepEqual(listenerPIDs(port), [], `Sidecar port is occupied before ${name}`)
      const child = spawn(appExecutable, [], {
        cwd: dirname(appExecutable),
        env: appEnvironment(sandbox, port),
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let logs = ''
      child.stdout.on('data', (chunk) => { logs += chunk.toString() })
      child.stderr.on('data', (chunk) => { logs += chunk.toString() })
      generation = { name, child, logs }
      await waitForHealth(child, baseURL)
      const pids = listenerPIDs(port)
      assert.equal(pids.length, 1, `${name} must own exactly one Sidecar listener`)
      assert.ok(processCommand(pids[0]).includes(sidecarExecutable), `${name} Sidecar is not the packaged Test.app binary`)
      generations.push({ name, appPID: child.pid, sidecarPID: pids[0] })
    }

    await start('initial')

    const save = await request(baseURL, '/api/v1/mcp/servers', {
      method: 'POST',
      body: {
        name: connectionName,
        transport: 'stdio',
        command: 'hexclaw-connection-test-command-not-installed',
        args: ['--dsn', `postgresql://desktop-user:${connectionSecret}@127.0.0.1:15432/isolated`],
        env: {},
        secret_args: [{ index: 1, mode: 'replace', credential_ref: ref }],
      },
    })
    assert.equal(save.status, 200)
    assert.equal(save.data.connected, false)

    let raw = readFileSync(configPath, 'utf8')
    assert.match(raw, /args_secret_refs/)
    assert.match(raw, /enc:v1:/)
    assert.doesNotMatch(raw, new RegExp(connectionSecret))
    assert.match(raw, /providers: \{\}/)
    const visibleAfterSave = await request(baseURL, '/api/v1/mcp/servers')
    assert.ok(visibleAfterSave.data.servers.includes(connectionName))

    await stopGeneration(generation, port)
    generation = null
    await start('after-restart')

    const visibleAfterRestart = await request(baseURL, '/api/v1/mcp/servers')
    assert.ok(visibleAfterRestart.data.servers.includes(connectionName), 'restart lost configured Connection')

    const preserve = await request(baseURL, '/api/v1/mcp/servers', {
      method: 'POST',
      body: {
        name: connectionName,
        transport: 'stdio',
        command: 'hexclaw-connection-test-command-not-installed',
        args: ['--dsn', 'postgresql://desktop-user@127.0.0.2:15432/isolated'],
        env: {},
        secret_args: [{ index: 1, mode: 'preserve', credential_ref: ref }],
      },
    })
    assert.equal(preserve.status, 200)
    raw = readFileSync(configPath, 'utf8')
    assert.match(raw, /args_secret_refs/)
    assert.match(raw, /enc:v1:/)
    assert.doesNotMatch(raw, new RegExp(connectionSecret))
    assert.doesNotMatch(raw, /127\.0\.0\.2.*connection-only-secret-023/)

    const remove = await request(baseURL, `/api/v1/mcp/servers/${encodeURIComponent(connectionName)}`, {
      method: 'DELETE',
    })
    assert.equal(remove.status, 200)
    raw = readFileSync(configPath, 'utf8')
    assert.doesNotMatch(raw, new RegExp(connectionName))
    assert.doesNotMatch(raw, /args_secret_refs/)
    assert.doesNotMatch(raw, /enc:v1:/)

    await stopGeneration(generation, port)
    generation = null
    await start('after-delete-restart')
    const visibleAfterDeleteRestart = await request(baseURL, '/api/v1/mcp/servers')
    assert.equal(visibleAfterDeleteRestart.data.servers.includes(connectionName), false)
  } catch (error) {
    failure = error
  } finally {
    try {
      await stopGeneration(generation, port)
    } catch (cleanupError) {
      failure ||= cleanupError
    }
    const rawLogs = generations
      .map((entry) => `${entry.name} appPID=${entry.appPID} sidecarPID=${entry.sidecarPID}`)
      .join('\n')
    mkdirSync(evidenceBase, { recursive: true, mode: 0o700 })
    const runName = new Date().toISOString().replaceAll(':', '').replaceAll('.', '-')
    const evidenceRoot = join(evidenceBase, runName)
    mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 })
    const finalRaw = existsSync(configPath) ? readFileSync(configPath, 'utf8') : ''
    writeFileSync(join(evidenceRoot, 'summary.json'), JSON.stringify({
      status: failure ? 'FAIL' : 'PASS',
      bug: 'BUG-20260802-023',
      boundary: 'isolated macOS Test.app + packaged Sidecar HTTP',
      appBundle: relative(repoRoot, appBundle),
      appSHA256: sha256File(appExecutable),
      sidecarSHA256: sha256File(sidecarExecutable),
      isolation: {
        temporaryHome: true,
        temporaryYAML: true,
        temporarySQLite: true,
        sidecarPort: port,
        providerSecretSent: false,
        providerConfigEmpty: true,
        userHomeTouched: false,
        applicationsTouched: false,
      },
      lifecycle: {
        save: !failure,
        restartRead: !failure,
        preserveReadModifyWrite: !failure,
        delete: !failure,
        deleteRestartRead: !failure,
        diskPlaintextSecret: finalRaw.includes(connectionSecret),
        diskEncryptedValue: finalRaw.includes('enc:v1:'),
      },
      generations,
      logs: rawLogs,
      error: failure ? String(failure?.stack || failure) : null,
    }, null, 2) + '\n', { mode: 0o600 })
    try {
      rmSync(sandbox, { recursive: true, force: true })
    } catch (cleanupError) {
      failure ||= cleanupError
    }
    if (failure) throw failure
    console.log(`BUG-20260802-023 isolated Test.app Sidecar PASS: ${relative(repoRoot, evidenceRoot)}`)
  }
}

main().catch((error) => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
