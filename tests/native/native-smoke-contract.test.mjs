import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const harnessPath = resolve(repoRoot, 'tests/native/native-smoke.sh')

async function freePort() {
  const server = createServer()
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  assert(address && typeof address !== 'string')
  const port = address.port
  await new Promise((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()))
  })
  return port
}

async function createFakeApp(root, bundleId = 'com.hexclaw.desktop') {
  const bundle = join(root, 'HexClaw.app')
  const executable = join(bundle, 'Contents', 'MacOS', 'HexClaw')
  await mkdir(dirname(executable), { recursive: true })
  await writeFile(
    join(bundle, 'Contents', 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>HexClaw</string>
  <key>CFBundleIdentifier</key><string>${bundleId}</string>
</dict></plist>
`,
  )
  await writeFile(
    executable,
    `#!/usr/bin/env node
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const home = process.env.HEXCLAW_TEST_HOME
const port = Number(process.env.HEXCLAW_SIDECAR_PORT)
const stateDir = path.join(home, '.hexclaw')
const dataPath = home + '/.hexclaw/data.db'
fs.mkdirSync(stateDir, { recursive: true })
fs.writeFileSync(path.join(stateDir, 'hexclaw.yaml'), 'server:\\n  port: ' + port + '\\nstorage:\\n  sqlite:\\n    path: ' + dataPath + '\\n')
fs.writeFileSync(dataPath, '')
const artifactDir = process.env.HEX_NATIVE_ARTIFACT_DIR
fs.mkdirSync(artifactDir, { recursive: true })
fs.writeFileSync(path.join(artifactDir, 'observed-env.json'), JSON.stringify({
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  CFFIXED_USER_HOME: process.env.CFFIXED_USER_HOME,
  TMPDIR: process.env.TMPDIR,
  TEMP: process.env.TEMP,
  TMP: process.env.TMP,
  HEXCLAW_TEST_HOME: home,
  HEXCLAW_SIDECAR_PORT: process.env.HEXCLAW_SIDECAR_PORT,
}))
const server = http.createServer((request, response) => {
  response.writeHead(request.url === '/health' ? 200 : 404, { 'content-type': 'application/json' })
  response.end(request.url === '/health' ? '{"healthy":true}' : '{}')
})
server.listen(port, '127.0.0.1')
const stop = () => server.close(() => process.exit(0))
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
setInterval(() => {}, 1000)
`,
  )
  await chmod(executable, 0o755)
  return bundle
}

async function runHarness({ bundle, port, expectedBundleId }) {
  const root = await mkdtemp(join(tmpdir(), 'hexclaw-native-contract-run-'))
  const artifactDir = join(root, 'artifacts')
  const env = {
    ...process.env,
    HEX_NATIVE_APP_BUNDLE: bundle,
    HEX_NATIVE_ARTIFACT_DIR: artifactDir,
    HEX_NATIVE_PORT: String(port),
    HEX_E2E_RUN_ID: `native-contract-${port}`,
  }
  if (expectedBundleId !== undefined) {
    env.HEX_NATIVE_EXPECTED_BUNDLE_ID = expectedBundleId
  } else {
    delete env.HEX_NATIVE_EXPECTED_BUNDLE_ID
  }

  const result = await new Promise((resolveResult, reject) => {
    const child = spawn('bash', [harnessPath, 'run'], {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.once('error', reject)
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('native-smoke contract fixture timed out'))
    }, 30_000)
    child.once('close', (code, signal) => {
      clearTimeout(timeout)
      resolveResult({ code, signal, stdout, stderr })
    })
  })
  return { ...result, artifactDir }
}

test('native-smoke source freezes explicit bundle and dynamic-port contracts', async () => {
  const source = await readFile(harnessPath, 'utf8')
  assert.match(
    source,
    /EXPECTED_BUNDLE_ID="\$\{HEX_NATIVE_EXPECTED_BUNDLE_ID:-com\.hexclaw\.desktop\.mock\}"/,
  )
  assert.match(source, /PORT="\$\{HEX_NATIVE_PORT:-16061\}"/)
  assert.match(source, /HEX_NATIVE_PORT must not use the production port 16060/)
  assert.match(source, /CFFIXED_USER_HOME="\$\{SANDBOX\}"/)
})

test('production bundle requires explicit exact opt-in and receives one isolated run context', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hexclaw-native-contract-app-'))
  const bundle = await createFakeApp(root)
  const defaultResult = await runHarness({ bundle, port: await freePort() })
  assert.notEqual(defaultResult.code, 0)
  assert.match(defaultResult.stderr, /unexpected native-smoke bundle identifier/)

  const unsupported = await runHarness({
    bundle,
    port: await freePort(),
    expectedBundleId: 'com.hexclaw.desktop.unapproved',
  })
  assert.notEqual(unsupported.code, 0)
  assert.match(unsupported.stderr, /unsupported HEX_NATIVE_EXPECTED_BUNDLE_ID/)

  const port = await freePort()
  const explicitResult = await runHarness({
    bundle,
    port,
    expectedBundleId: 'com.hexclaw.desktop',
  })
  assert.equal(explicitResult.code, 0, explicitResult.stderr || explicitResult.stdout)

  const observed = JSON.parse(
    await readFile(join(explicitResult.artifactDir, 'observed-env.json'), 'utf8'),
  )
  const home = observed.HEXCLAW_TEST_HOME
  assert.ok(home.startsWith('/'))
  assert.ok(home.includes('hexclaw-native-smoke.'))
  assert.notEqual(home, process.env.HOME)
  assert.equal(observed.HOME, home)
  assert.equal(observed.USERPROFILE, home)
  assert.equal(observed.CFFIXED_USER_HOME, home)
  assert.equal(observed.TMPDIR, `${home}/tmp`)
  assert.equal(observed.TEMP, `${home}/tmp`)
  assert.equal(observed.TMP, `${home}/tmp`)
  assert.equal(observed.HEXCLAW_SIDECAR_PORT, String(port))
})

test('production port and occupied dynamic ports fail closed before app launch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hexclaw-native-contract-port-'))
  const bundle = await createFakeApp(root)

  const productionPort = await runHarness({
    bundle,
    port: 16060,
    expectedBundleId: 'com.hexclaw.desktop',
  })
  assert.notEqual(productionPort.code, 0)
  assert.match(productionPort.stderr, /HEX_NATIVE_PORT must not use the production port 16060/)

  for (const invalidPort of ['not-a-port', '0', '443', '65536']) {
    const invalid = await runHarness({
      bundle,
      port: invalidPort,
      expectedBundleId: 'com.hexclaw.desktop',
    })
    assert.notEqual(invalid.code, 0)
    assert.match(
      invalid.stderr,
      /HEX_NATIVE_PORT must be (?:a numeric TCP port|an unprivileged TCP port between 1024 and 65535)/,
    )
  }

  const listener = createServer()
  await new Promise((resolveListen, reject) => {
    listener.once('error', reject)
    listener.listen(0, '127.0.0.1', resolveListen)
  })
  const address = listener.address()
  assert(address && typeof address !== 'string')
  try {
    const occupied = await runHarness({
      bundle,
      port: address.port,
      expectedBundleId: 'com.hexclaw.desktop',
    })
    assert.notEqual(occupied.code, 0)
    assert.match(occupied.stderr, /dedicated native-smoke port .* is already occupied/)
  } finally {
    await new Promise((resolveClose, reject) => {
      listener.close((error) => (error ? reject(error) : resolveClose()))
    })
  }
})
