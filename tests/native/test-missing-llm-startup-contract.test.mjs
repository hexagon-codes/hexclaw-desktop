import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const repositoryRoot = path.resolve(import.meta.dirname, '../..')
const runner = path.join(repositoryRoot, 'tests/native/test-missing-llm-startup.sh')
const cleanupRunner = path.join(repositoryRoot, 'tests/native/test-missing-llm-startup-cleanup.sh')

async function createProcessStartIdentityHelper(root) {
  assert.equal(process.platform, 'darwin')
  const sourcePath = path.join(root, 'process-start-identity.c')
  const executablePath = path.join(root, 'process-start-identity')
  await writeFile(
    sourcePath,
    `#include <errno.h>
#include <inttypes.h>
#include <libproc.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/proc_info.h>

int main(int argc, char **argv) {
  char *end = NULL;
  long value;
  struct proc_bsdinfo info;
  int size;
  if (argc != 2) return 64;
  errno = 0;
  value = strtol(argv[1], &end, 10);
  if (errno != 0 || end == argv[1] || *end != '\\0' || value <= 0) return 64;
  size = proc_pidinfo((int)value, PROC_PIDTBSDINFO, 0, &info, sizeof(info));
  if (size != (int)sizeof(info)) return 1;
  printf("darwin:%" PRIu64 ":%06" PRIu64 "\\n", info.pbi_start_tvsec, info.pbi_start_tvusec);
  return 0;
}
`,
    { mode: 0o600 },
  )
  const result = await run('/usr/bin/cc', [
    '-std=c11',
    '-O2',
    '-Wall',
    '-Wextra',
    '-Werror',
    sourcePath,
    '-o',
    executablePath,
  ])
  assert.equal(result.code, 0, result.output)
  return executablePath
}

async function readHighResolutionProcessStartId(helper, pid) {
  const result = await run(helper, [String(pid)])
  assert.equal(result.code, 0, result.output)
  const identity = result.output.trim()
  assert.match(identity, /^darwin:[0-9]+:[0-9]{6}$/)
  return identity
}

function commandIdentity(command) {
  return createHash('sha256').update(`${command}\n`).digest('hex')
}

async function readJSONIfPresent(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

async function readPublishedOwnership(isolatedHome) {
  const ready = await readJSONIfPresent(path.join(isolatedHome, 'watchdog.ready'))
  const supervisor = await readJSONIfPresent(path.join(isolatedHome, 'supervisor.identity.json'))
  const watchdog = await readJSONIfPresent(path.join(isolatedHome, 'watchdog.identity.json'))
  if (!ready) return { ready, supervisor, watchdog }
  assert.equal(ready.version, 1)
  assert.ok(supervisor)
  assert.ok(watchdog)
  assert.deepEqual(ready.supervisor, {
    pid: supervisor.pid,
    pgid: supervisor.pgid,
    startId: supervisor.startId,
    commandId: supervisor.commandId,
  })
  assert.deepEqual(ready.watchdog, {
    pid: watchdog.pid,
    pgid: watchdog.pgid,
    startId: watchdog.startId,
    commandId: watchdog.commandId,
  })
  return { ready, supervisor, watchdog }
}

async function verifyPublishedProcessIdentity(helper, published, allowedParentPids) {
  assert.ok(published)
  assert.equal(processExists(published.pid), true)
  const current = await readStrictProcessIdentity(helper, published.pid)
  assert.ok(allowedParentPids.includes(current.parentPid))
  assert.equal(current.processGroupId, published.pgid)
  assert.equal(await readHighResolutionProcessStartId(helper, published.pid), published.startId)
  assert.equal(commandIdentity(current.command), published.commandId)
  return { pid: published.pid, ...current, startId: published.startId, commandId: published.commandId }
}

async function terminateVerifiedPublishedProcess(helper, expected) {
  if (!expected || !processExists(expected.pid)) return
  const verifyCurrent = async () => {
    const current = await readStrictProcessIdentity(helper, expected.pid)
    assert.ok([expected.parentPid, 1].includes(current.parentPid))
    assert.equal(current.processGroupId, expected.processGroupId)
    assert.equal(await readHighResolutionProcessStartId(helper, expected.pid), expected.startId)
    assert.equal(commandIdentity(current.command), expected.commandId)
    return current
  }
  const current = await verifyCurrent()
  if (current.processGroupId === expected.pid) process.kill(-expected.pid, 'SIGTERM')
  else process.kill(expected.pid, 'SIGTERM')
  if (current.state.startsWith('T') && processExists(expected.pid)) process.kill(expected.pid, 'SIGCONT')
  try {
    await waitForProcessExit(expected.pid, 3000)
  } catch {
    const killCurrent = await verifyCurrent()
    if (killCurrent.processGroupId === expected.pid) process.kill(-expected.pid, 'SIGKILL')
    else process.kill(expected.pid, 'SIGKILL')
    await waitForProcessExit(expected.pid, 5000)
  }
}

async function waitForHarnessBootstrap(child, callerTmpdir, capturePath, output, timeoutMilliseconds = 20_000) {
  const deadline = Date.now() + timeoutMilliseconds
  let isolatedHome
  while (Date.now() < deadline) {
    if (!isolatedHome) {
      const entries = await readdir(callerTmpdir)
      const candidates = entries.filter((entry) => entry.startsWith('hexclaw-missing-llm.'))
      assert.ok(candidates.length <= 1, `expected at most one isolated runner home, got ${candidates.join(', ')}`)
      if (candidates.length === 1) isolatedHome = path.join(callerTmpdir, candidates[0])
    }
    if (isolatedHome) {
      const ownership = await readPublishedOwnership(isolatedHome)
      if (ownership.ready) return { kind: 'ready', isolatedHome, ownership }
    }
    const capture = await readJSONIfPresent(capturePath)
    if (capture) return { kind: 'capture', isolatedHome: capture.HEXCLAW_TEST_HOME, capture }
    if (child.exitCode !== null || child.signalCode !== null) {
      return { kind: 'exit', code: child.exitCode, signal: child.signalCode, output: output() }
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`timed out waiting for watchdog readiness, App capture, or harness exit: ${output()}`)
}

async function waitForCaptureOrHarnessExit(child, capturePath, output, timeoutMilliseconds = 20_000) {
  const deadline = Date.now() + timeoutMilliseconds
  while (Date.now() < deadline) {
    const capture = await readJSONIfPresent(capturePath)
    if (capture) return { kind: 'capture', capture }
    if (child.exitCode !== null || child.signalCode !== null) {
      return { kind: 'exit', code: child.exitCode, signal: child.signalCode, output: output() }
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`timed out waiting for App capture or harness exit: ${output()}`)
}

function listenOnRandomPort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer()
    listener.once('error', reject)
    listener.listen(0, '127.0.0.1', () => resolve(listener))
  })
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options)
    let output = ''
    child.stdout.on('data', (chunk) => {
      output += chunk
    })
    child.stderr.on('data', (chunk) => {
      output += chunk
    })
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal, output }))
  })
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

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const closed = new Promise((resolve) => child.once('close', resolve))
  child.kill('SIGTERM')
  await closed
}

async function assertPortIsFree(port) {
  const listener = net.createServer()
  await new Promise((resolve, reject) => {
    listener.once('error', reject)
    listener.listen(port, '127.0.0.1', resolve)
  })
  await closeServer(listener)
}

async function createCallerPaths(root) {
  const paths = {
    HOME: path.join(root, 'caller-home'),
    USERPROFILE: path.join(root, 'caller-userprofile'),
    CFFIXED_USER_HOME: path.join(root, 'caller-cffixed-home'),
    TMPDIR: path.join(root, 'caller-tmpdir'),
    TEMP: path.join(root, 'caller-temp'),
    TMP: path.join(root, 'caller-tmp'),
  }
  await Promise.all(Object.values(paths).map((directory) => mkdir(directory, { mode: 0o700 })))
  return paths
}

async function createFakeDesktop(root) {
  const fakeDesktop = path.join(root, 'fake-desktop.cjs')
  const fakeSidecar = path.join(root, 'fake-sidecar.cjs')

  await writeFile(
    fakeSidecar,
    `#!/usr/bin/env node
const fs = require('node:fs')
const http = require('node:http')
if (process.env.HEXCLAW_FAKE_IGNORE_TERM === '1') process.on('SIGTERM', () => {})
const port = Number(process.env.HEXCLAW_SIDECAR_PORT)
const server = http.createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"status":"ok"}')
    return
  }
  if (request.url === '/api/v1/config/llm') {
    const respond = () => {
      if (process.env.HEXCLAW_SYNTHETIC_ZOMBIE_MARKER) {
        fs.writeFileSync(process.env.HEXCLAW_SYNTHETIC_ZOMBIE_MARKER, 'zombie')
      }
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end('{"error":"sidecar capability required"}')
    }
    const delay = Number(process.env.HEXCLAW_FAKE_CONFIG_DELAY_MS || 0)
    if (delay > 0) setTimeout(respond, delay)
    else respond()
    return
  }
  response.writeHead(404)
  response.end()
})
server.listen(port, '127.0.0.1')
`,
    { mode: 0o755 },
  )

  await writeFile(
    fakeDesktop,
    `#!/usr/bin/env node
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
if (process.env.HEXCLAW_FAKE_IGNORE_TERM === '1') process.on('SIGTERM', () => {})
const start = () => {
  const home = process.env.HEXCLAW_TEST_HOME
  const tmp = path.join(home, 'tmp')
  const configDir = path.join(home, '.hexclaw')
  fs.mkdirSync(configDir, { recursive: true })
  if (process.env.HEXCLAW_CLAIM_APP_PID_PATH) {
    fs.writeFileSync(process.env.HEXCLAW_CLAIM_APP_PID_PATH, String(process.pid))
  }
  fs.writeFileSync(path.join(configDir, 'hexclaw.yaml'), 'server:\\n  port: ' + process.env.HEXCLAW_SIDECAR_PORT + '\\n')
  const sidecar = spawn(process.execPath, [${JSON.stringify(fakeSidecar)}], { stdio: 'ignore' })
  if (process.env.HEXCLAW_CLAIM_SIDECAR_PID_PATH) {
    fs.writeFileSync(process.env.HEXCLAW_CLAIM_SIDECAR_PID_PATH, String(sidecar.pid))
  }
  fs.writeFileSync(process.env.HEXCLAW_CONTRACT_CAPTURE_PATH, JSON.stringify({
    appPid: process.pid,
    supervisorPid: process.ppid,
    sidecarPid: sidecar.pid,
    watchdogPid: Number(fs.readFileSync(path.join(home, 'watchdog.pid'), 'utf8')),
    HEXCLAW_TEST_HOME: home,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    CFFIXED_USER_HOME: process.env.CFFIXED_USER_HOME,
    TMPDIR: process.env.TMPDIR,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    homeMode: fs.statSync(home).mode & 0o777,
    tmpExists: fs.existsSync(tmp),
    tmpMode: fs.existsSync(tmp) ? fs.statSync(tmp).mode & 0o777 : null,
  }))
}
const captureDelay = Number(process.env.HEXCLAW_FAKE_CAPTURE_DELAY_MS || 0)
if (captureDelay > 0) setTimeout(start, captureDelay)
else start()
setInterval(() => {}, 1000)
`,
    { mode: 0o755 },
  )

  await chmod(fakeDesktop, 0o755)
  await chmod(fakeSidecar, 0o755)
  return fakeDesktop
}

async function createPostHealthExitDesktop(root, exitCode) {
  const fakeDesktop = path.join(root, 'post-health-exit-desktop.cjs')
  const fakeSidecar = path.join(root, 'post-health-exit-sidecar.cjs')
  const appPidPath = path.join(root, 'post-health-exit-app.pid')
  const sidecarPidPath = path.join(root, 'post-health-exit-sidecar.pid')
  const observationPath = path.join(root, 'post-health-exit-observation.json')

  await writeFile(
    fakeSidecar,
    `#!/usr/bin/env node
const fs = require('node:fs')
const http = require('node:http')
const parentPid = Number(process.env.FAKE_DESKTOP_PID)
const port = Number(process.env.HEXCLAW_SIDECAR_PORT)
function recordObservation(patch) {
  let observation = {}
  try {
    observation = JSON.parse(fs.readFileSync(${JSON.stringify(observationPath)}, 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  fs.writeFileSync(${JSON.stringify(observationPath)}, JSON.stringify({ ...observation, ...patch }))
}
const server = http.createServer((request, response) => {
  if (request.url === '/health') {
    recordObservation({ healthServed: true })
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"status":"ok"}')
    return
  }
  if (request.url === '/api/v1/config/llm') {
    if (process.send) process.send('config-requested')
    setTimeout(() => {
      let desktopAlive = true
      try {
        process.kill(parentPid, 0)
      } catch (error) {
        if (error.code === 'ESRCH') desktopAlive = false
        else throw error
      }
      recordObservation({ desktopAliveAtConfigResponse: desktopAlive })
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end('{"error":"sidecar capability required"}')
    }, 1000)
    return
  }
  response.writeHead(404)
  response.end()
})
server.listen(port, '127.0.0.1', () => {
  if (process.send) process.send('ready')
})
`,
    { mode: 0o755 },
  )

  await writeFile(
    fakeDesktop,
    `#!/usr/bin/env node
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const home = process.env.HEXCLAW_TEST_HOME
const configDir = path.join(home, '.hexclaw')
fs.mkdirSync(configDir, { recursive: true })
fs.writeFileSync(path.join(configDir, 'hexclaw.yaml'), 'server:\\n  port: ' + process.env.HEXCLAW_SIDECAR_PORT + '\\n')
fs.writeFileSync(${JSON.stringify(appPidPath)}, String(process.pid))
const sidecar = spawn(process.execPath, [${JSON.stringify(fakeSidecar)}], {
  stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  env: { ...process.env, FAKE_DESKTOP_PID: String(process.pid) },
})
fs.writeFileSync(${JSON.stringify(sidecarPidPath)}, String(sidecar.pid))
sidecar.on('message', (message) => {
  if (message === 'config-requested') setTimeout(() => process.exit(${JSON.stringify(exitCode)}), 150)
})
setInterval(() => {}, 1000)
`,
    { mode: 0o755 },
  )

  await chmod(fakeDesktop, 0o755)
  await chmod(fakeSidecar, 0o755)
  return { appPidPath, fakeDesktop, observationPath, sidecarPidPath }
}

async function createFastExitDesktop(root) {
  const appPidPath = path.join(root, 'bad-pgid-app.pid')
  const fakeDesktop = path.join(root, 'bad-pgid-desktop.cjs')
  await writeFile(
    fakeDesktop,
    `#!/usr/bin/env node
require('node:fs').writeFileSync(${JSON.stringify(appPidPath)}, String(process.pid))
setTimeout(() => process.exit(0), 500)
`,
    { mode: 0o755 },
  )
  await chmod(fakeDesktop, 0o755)
  return { appPidPath, fakeDesktop }
}

async function createPostClaimTreeExitDesktop(root) {
  const fakeDesktop = path.join(root, 'post-claim-tree-exit-desktop.cjs')
  const fakeSidecar = path.join(root, 'post-claim-tree-exit-sidecar.cjs')
  const appPidPath = path.join(root, 'post-claim-tree-exit-app.pid')
  const sidecarPidPath = path.join(root, 'post-claim-tree-exit-sidecar.pid')
  const supervisorPidPath = path.join(root, 'post-claim-tree-exit-supervisor.pid')
  const treeExitMarker = path.join(root, 'post-claim-tree-exited')

  await writeFile(
    fakeSidecar,
    `#!/usr/bin/env node
const fs = require('node:fs')
const http = require('node:http')
const port = Number(process.env.HEXCLAW_SIDECAR_PORT)
const server = http.createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"status":"ok"}')
    return
  }
  if (request.url === '/api/v1/config/llm') {
    if (process.send) process.send('config-requested')
    response.writeHead(401, { 'content-type': 'application/json' })
    response.end('{"error":"sidecar capability required"}', () => {
      server.close(() => {
        fs.writeFileSync(${JSON.stringify(treeExitMarker)}, 'exited')
        process.exit(0)
      })
    })
    return
  }
  response.writeHead(404)
  response.end()
})
server.listen(port, '127.0.0.1')
`,
    { mode: 0o755 },
  )

  await writeFile(
    fakeDesktop,
    `#!/usr/bin/env node
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const home = process.env.HEXCLAW_TEST_HOME
const configDir = path.join(home, '.hexclaw')
const memoryDir = path.join(configDir, 'memory')
fs.mkdirSync(memoryDir, { recursive: true })
fs.mkdirSync(path.join(memoryDir, '_global'), { recursive: true })
fs.writeFileSync(path.join(configDir, 'hexclaw.yaml'), 'server:\\n  port: ' + process.env.HEXCLAW_SIDECAR_PORT + '\\n')
fs.writeFileSync(path.join(memoryDir, '_global', 'MEMORY.md'), '- [00:00] [fact:manual] one\\n- [00:01] [fact:manual] two\\n- [00:02] [fact:manual] three\\n')
fs.writeFileSync(path.join(memoryDir, '.phase_state.json'), JSON.stringify({ profile: '2000-01-01T00:00:00Z' }))
fs.writeFileSync(${JSON.stringify(supervisorPidPath)}, String(process.ppid))
fs.writeFileSync(${JSON.stringify(appPidPath)}, String(process.pid))
const sidecar = spawn(process.execPath, [${JSON.stringify(fakeSidecar)}], {
  stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
})
fs.writeFileSync(${JSON.stringify(sidecarPidPath)}, String(sidecar.pid))
sidecar.on('message', (message) => {
  if (message === 'config-requested') setTimeout(() => process.exit(0), 20)
})
setInterval(() => {}, 1000)
`,
    { mode: 0o755 },
  )

  await chmod(fakeDesktop, 0o755)
  await chmod(fakeSidecar, 0o755)
  return { appPidPath, fakeDesktop, sidecarPidPath, supervisorPidPath, treeExitMarker }
}

async function createStaleProcessGroupProbe(root, fixture) {
  const fakeBin = path.join(root, 'stale-group-fake-bin')
  const fakePs = path.join(fakeBin, 'ps')
  const bashEnvironment = path.join(root, 'stale-group-bash-env.sh')
  const releaseMarker = path.join(root, 'stale-group-released')
  const signalMarker = path.join(root, 'stale-group-signalled')
  const termMarker = path.join(root, 'stale-group-term-sent')
  await mkdir(fakeBin, { mode: 0o700 })
  await writeFile(
    fakePs,
    `#!/bin/sh
if [ -e "$HEXCLAW_STALE_GROUP_TERM_MARKER" ] &&
   [ ! -e "$HEXCLAW_STALE_GROUP_RELEASE_MARKER" ] &&
   [ -f "$HEXCLAW_STALE_GROUP_SUPERVISOR_PID_PATH" ]; then
  stale_pgid="$(cat "$HEXCLAW_STALE_GROUP_SUPERVISOR_PID_PATH")"
  if [ "$1" = '-o' ] && [ "$2" = 'ppid=,pgid=,stat=' ] &&
     [ "$3" = '-p' ] && [ "$4" = "$stale_pgid" ]; then
    printf ' 1 %s S\\n' "$stale_pgid"
    exit 0
  fi
  case "$*" in
    '-axo pgid=,stat=')
      /bin/ps "$@"
      printf ' %s S\\n' "$stale_pgid"
      exit 0
      ;;
    '-axo pid=,pgid=,stat=')
      /bin/ps "$@"
      printf ' %s %s S\\n' "$stale_pgid" "$stale_pgid"
      exit 0
      ;;
    '-axo pgid=')
      /bin/ps "$@"
      printf ' %s\\n' "$stale_pgid"
      exit 0
      ;;
  esac
fi
exec /bin/ps "$@"
`,
    { mode: 0o755 },
  )
  await writeFile(
    bashEnvironment,
    `kill() {
  if [ "\${2:-}" = '--' ] && [ -f "$HEXCLAW_STALE_GROUP_SUPERVISOR_PID_PATH" ] &&
     [ "\${3:-}" = "-$(cat "$HEXCLAW_STALE_GROUP_SUPERVISOR_PID_PATH")" ]; then
    if [ "\${1:-}" = '-TERM' ]; then
      builtin kill "$@"
      kill_status=$?
      : >"$HEXCLAW_STALE_GROUP_TERM_MARKER"
      return "$kill_status"
    fi
    if [ "\${1:-}" = '-KILL' ]; then
      : >"$HEXCLAW_STALE_GROUP_SIGNAL_MARKER"
      : >"$HEXCLAW_STALE_GROUP_RELEASE_MARKER"
      return 0
    fi
  fi
  builtin kill "$@"
}
`,
    { mode: 0o600 },
  )
  await chmod(fakePs, 0o755)
  return { bashEnvironment, fakeBin, releaseMarker, signalMarker, termMarker, ...fixture }
}

async function createSyntheticZombieProbe(root, capturePath, zombieMarker) {
  const fakeBin = path.join(root, 'synthetic-zombie-fake-bin')
  const fakePs = path.join(fakeBin, 'ps')
  await mkdir(fakeBin, { mode: 0o700 })
  await writeFile(
    fakePs,
    `#!/bin/sh
if [ -e "$HEXCLAW_SYNTHETIC_ZOMBIE_MARKER" ] &&
   [ "$1" = '-o' ] && [ "$2" = 'ppid=,pgid=,stat=' ] && [ "$3" = '-p' ] &&
   [ -f "$HEXCLAW_SYNTHETIC_ZOMBIE_CAPTURE_PATH" ]; then
  app_pid="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).appPid))' "$HEXCLAW_SYNTHETIC_ZOMBIE_CAPTURE_PATH")"
  if [ "$4" = "$app_pid" ]; then
    identity="$(/bin/ps -o ppid=,pgid= -p "$4")"
    set -- $identity
    printf ' %s %s Z\\n' "$1" "$2"
    exit 0
  fi
fi
exec /bin/ps "$@"
`,
    { mode: 0o755 },
  )
  await chmod(fakePs, 0o755)
  return { capturePath, fakeBin, zombieMarker }
}

async function createBadProcessGroupProbe(root) {
  const fakeBin = path.join(root, 'fake-bin')
  const injectedMarker = path.join(root, 'bad-pgid-injected')
  const targetPidPath = path.join(root, 'bad-pgid-target.pid')
  const fakePs = path.join(fakeBin, 'ps')
  await mkdir(fakeBin, { mode: 0o700 })
  await writeFile(
    fakePs,
    `#!/bin/sh
if [ "$HEXCLAW_BAD_PGID_MODE" = 'supervisor-caller' ] &&
   [ "$1" = '-o' ] && [ "$2" = 'ppid=,pgid=,stat=' ] && [ "$3" = '-p' ]; then
  direct_parent="$(/bin/ps -o ppid= -p "$4" | tr -d '[:space:]')"
  actual_pgid="$(/bin/ps -o pgid= -p "$4" | tr -d '[:space:]')"
  if [ "$actual_pgid" = "$4" ]; then
    caller_pgid="$(/bin/ps -o pgid= -p "$direct_parent" | tr -d '[:space:]')"
    printf '%s\\n' "$4" >"$HEXCLAW_BAD_PGID_TARGET_PID_PATH"
    : >"$HEXCLAW_BAD_PGID_INJECTED_MARKER"
    printf ' %s %s S\\n' "$direct_parent" "$caller_pgid"
    exit 0
  fi
fi
is_app_target=0
if [ "$1" = "-o" ] && [ "$3" = "-p" ]; then
  case "$2" in
    pgid=|ppid=,pgid=,stat=)
      attempts=0
      while [ ! -f "$HEXCLAW_BAD_PGID_APP_PID_PATH" ] && [ "$attempts" -lt 100 ]; do
        sleep 0.01
        attempts=$((attempts + 1))
      done
      if [ -f "$HEXCLAW_BAD_PGID_APP_PID_PATH" ] &&
         [ "$(cat "$HEXCLAW_BAD_PGID_APP_PID_PATH")" = "$4" ]; then
        is_app_target=1
      fi
      ;;
  esac
fi
if [ "$is_app_target" -eq 1 ] && [ ! -e "$HEXCLAW_BAD_PGID_INJECTED_MARKER" ]; then
  case "$2" in
    pgid=|ppid=,pgid=,stat=)
      : >"$HEXCLAW_BAD_PGID_INJECTED_MARKER"
      case "$HEXCLAW_BAD_PGID_MODE" in
        caller)
          bad_pgid="$(/bin/ps -o pgid= -p "$PPID" | tr -d '[:space:]')"
          ;;
        explicit)
          bad_pgid="$HEXCLAW_BAD_PGID"
          ;;
        *)
          exit 64
          ;;
      esac
      if [ "$2" = "pgid=" ]; then
        printf ' %s\\n' "$bad_pgid"
      else
        direct_parent="$(/bin/ps -o ppid= -p "$4" | tr -d '[:space:]')"
        printf ' %s %s S\\n' "$direct_parent" "$bad_pgid"
      fi
      exit 0
      ;;
  esac
fi
exec /bin/ps "$@"
`,
    { mode: 0o755 },
  )
  await chmod(fakePs, 0o755)
  return { fakeBin, injectedMarker, targetPidPath }
}

async function createClaimFailureProbe(root, suffix) {
  const fakeBin = path.join(root, `claim-${suffix}-fake-bin`)
  const injectedMarker = path.join(root, `claim-${suffix}-injected`)
  const fakePs = path.join(fakeBin, 'ps')
  await mkdir(fakeBin, { mode: 0o700 })
  await writeFile(
    fakePs,
    `#!/bin/sh
is_claim_target=0
if [ "$1" = '-o' ] && [ "$2" = 'ppid=,pgid=,stat=' ] && [ "$3" = '-p' ]; then
  actual_command="$(/bin/ps -o command= -p "$4")"
  case "$HEXCLAW_CLAIM_TARGET_KIND:$actual_command" in
    app:*fake-desktop.cjs*|sidecar:*fake-sidecar.cjs*) is_claim_target=1 ;;
  esac
fi
if [ "$is_claim_target" -eq 1 ]; then
  attempts=0
  while [ ! -f "$HEXCLAW_CLAIM_TARGET_PID_PATH" ] && [ "$attempts" -lt 500 ]; do
    sleep 0.01
    attempts=$((attempts + 1))
  done
fi
if [ "$is_claim_target" -eq 1 ] &&
   [ -f "$HEXCLAW_CLAIM_TARGET_PID_PATH" ] &&
   [ "$(cat "$HEXCLAW_CLAIM_TARGET_PID_PATH")" = "$4" ] &&
   [ ! -e "$HEXCLAW_CLAIM_INJECTED_MARKER" ]; then
  actual_pgid="$(/bin/ps -o pgid= -p "$4" | tr -d '[:space:]')"
  : >"$HEXCLAW_CLAIM_INJECTED_MARKER"
  printf ' 1 %s S\\n' "$actual_pgid"
  exit 0
fi
exec /bin/ps "$@"
`,
    { mode: 0o755 },
  )
  await chmod(fakePs, 0o755)
  return { fakeBin, injectedMarker }
}

async function createBootstrapPauseProbe(root) {
  const fakeBin = path.join(root, 'bootstrap-pause-fake-bin')
  const fakePs = path.join(fakeBin, 'ps')
  const releaseMarker = path.join(root, 'bootstrap-pause-released')
  const supervisorPidPath = path.join(root, 'bootstrap-supervisor.pid')
  await mkdir(fakeBin, { mode: 0o700 })
  await writeFile(
    fakePs,
    `#!/bin/sh
if [ "$1" = '-o' ] && [ "$2" = 'ppid=,pgid=,stat=' ] && [ "$3" = '-p' ]; then
  candidate_parent="$(/bin/ps -o ppid= -p "$4" | tr -d '[:space:]')"
  parent_command="$(/bin/ps -o command= -p "$candidate_parent")"
  candidate_pgid="$(/bin/ps -o pgid= -p "$4" | tr -d '[:space:]')"
  case "$parent_command" in
    *test-missing-llm-startup.sh*)
      if [ "$candidate_pgid" = "$4" ]; then
        printf '%s\n' "$4" >"$HEXCLAW_BOOTSTRAP_SUPERVISOR_PID_PATH"
        attempts=0
        while [ ! -e "$HEXCLAW_BOOTSTRAP_RELEASE_MARKER" ]; do
          if ! /bin/ps -p "$candidate_parent" >/dev/null 2>&1; then
            exit 0
          fi
          attempts=$((attempts + 1))
          if [ "$attempts" -ge 1500 ]; then
            exit 0
          fi
          sleep 0.01
        done
      fi
      ;;
  esac
fi
exec /bin/ps "$@"
`,
    { mode: 0o755 },
  )
  await chmod(fakePs, 0o755)
  return { fakeBin, releaseMarker, supervisorPidPath }
}

async function waitForFile(filePath, timeoutMilliseconds = 2000) {
  const deadline = Date.now() + timeoutMilliseconds
  while (Date.now() < deadline) {
    try {
      return await readFile(filePath, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`timed out waiting for ${filePath}`)
}

async function waitForProcessExit(pid, timeoutMilliseconds = 2000) {
  const deadline = Date.now() + timeoutMilliseconds
  while (Date.now() < deadline) {
    if (!processExists(pid)) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`process did not exit: ${pid}`)
}

async function waitForPathRemoval(targetPath, timeoutMilliseconds = 5000) {
  const deadline = Date.now() + timeoutMilliseconds
  while (Date.now() < deadline) {
    try {
      await stat(targetPath)
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`path was not removed: ${targetPath}`)
}

async function waitForPIDFromFile(pidPath) {
  let pid
  try {
    pid = Number(await readFile(pidPath, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  if (!Number.isInteger(pid) || pid <= 0 || !processExists(pid)) return
  await waitForProcessExit(pid, 20_000)
}

async function readProcessIdentity(pid) {
  const result = await run('/bin/ps', ['-o', 'ppid=,pgid=,stat=', '-p', String(pid)])
  assert.equal(result.code, 0, result.output)
  const [rawParentPid, rawProcessGroupId, state] = result.output.trim().split(/\s+/)
  const parentPid = Number(rawParentPid)
  const processGroupId = Number(rawProcessGroupId)
  assert.ok(Number.isInteger(parentPid) && parentPid > 0, result.output)
  assert.ok(Number.isInteger(processGroupId) && processGroupId > 0, result.output)
  assert.ok(state && !state.startsWith('Z'), result.output)
  return { parentPid, processGroupId, state }
}

async function forceStopPID(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || !processExists(pid)) return
  process.kill(pid, 'SIGKILL')
  await waitForProcessExit(pid, 5000).catch(() => {})
}

async function findIsolatedRunnerHome(callerTmpdir, timeoutMilliseconds = 5000) {
  const deadline = Date.now() + timeoutMilliseconds
  while (Date.now() < deadline) {
    const entries = await readdir(callerTmpdir)
    const candidates = entries.filter((entry) => entry.startsWith('hexclaw-missing-llm.'))
    if (candidates.length === 1) return path.join(callerTmpdir, candidates[0])
    assert.ok(candidates.length <= 1, `expected at most one isolated runner home, got ${candidates.join(', ')}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`timed out waiting for the isolated runner home in ${callerTmpdir}`)
}

async function readStrictProcessIdentity(helper, pid) {
  const [identity, startId, commandResult] = await Promise.all([
    readProcessIdentity(pid),
    readHighResolutionProcessStartId(helper, pid),
    run('/bin/ps', ['-o', 'command=', '-p', String(pid)]),
  ])
  assert.equal(commandResult.code, 0, commandResult.output)
  const command = commandResult.output.trim()
  return {
    ...identity,
    startId,
    command,
    commandId: commandIdentity(command),
  }
}

async function terminateVerifiedGroupLeader(helper, expected) {
  if (!processExists(expected.pid)) return
  const current = await readStrictProcessIdentity(helper, expected.pid)
  assert.ok([expected.parentPid, 1].includes(current.parentPid))
  assert.equal(current.processGroupId, expected.pid)
  assert.equal(current.startId, expected.startId)
  assert.equal(current.commandId, expected.commandId)
  process.kill(-expected.pid, 'SIGTERM')
  await waitForProcessExit(expected.pid, 5000)
}

async function readDirectChildIdentities(helper, parentPid) {
  const result = await run('/usr/bin/pgrep', ['-P', String(parentPid)])
  if (result.code === 1) return []
  assert.equal(result.code, 0, result.output)
  const identities = []
  for (const rawPid of result.output.trim().split(/\s+/)) {
    const pid = Number(rawPid)
    if (!Number.isInteger(pid) || pid <= 0 || !processExists(pid)) continue
    try {
      identities.push({ pid, ...(await readStrictProcessIdentity(helper, pid)) })
    } catch (error) {
      if (!processExists(pid)) continue
      throw error
    }
  }
  return identities
}

async function waitForDirectChildIdentities(helper, child, timeoutMilliseconds = 15_000) {
  const deadline = Date.now() + timeoutMilliseconds
  while (Date.now() < deadline) {
    const identities = await readDirectChildIdentities(helper, child.pid)
    if (identities.length > 0) return identities
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`harness exited before publishing child identities: code=${child.exitCode} signal=${child.signalCode}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`timed out waiting for direct children of harness ${child.pid}`)
}

async function terminateVerifiedOwnedProcess(helper, expected) {
  if (!processExists(expected.pid)) return
  const current = await readStrictProcessIdentity(helper, expected.pid)
  assert.ok([expected.parentPid, 1].includes(current.parentPid))
  assert.equal(current.processGroupId, expected.processGroupId)
  assert.equal(current.startId, expected.startId)
  assert.equal(current.commandId, expected.commandId)
  if (current.processGroupId === expected.pid) process.kill(-expected.pid, 'SIGTERM')
  else process.kill(expected.pid, 'SIGTERM')
  await waitForProcessExit(expected.pid, 5000)
}

test('REG-FIX-20260727-MISSING-LLM-STARTUP-001 isolates paths and reaps its owned process tree', async (t) => {
  for (const ignoreTerm of [false, true]) {
    const suffix = ignoreTerm ? 'kill' : 'term'
    const root = await mkdtemp(path.join(os.tmpdir(), `hexclaw-missing-llm-contract-${suffix}.`))
    const capturePath = path.join(root, 'observed-environment.json')
    const callerPaths = await createCallerPaths(root)
    const fakeDesktop = await createFakeDesktop(root)
    const listener = await listenOnRandomPort()
    const { port } = listener.address()
    await closeServer(listener)

    const unknownProcess = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    })
    t.after(async () => {
      await stopProcess(unknownProcess)
      await rm(root, { recursive: true, force: true })
    })

    const result = await run('bash', [cleanupRunner, fakeDesktop], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        ...callerPaths,
        HEXCLAW_CONTRACT_CAPTURE_PATH: capturePath,
        HEXCLAW_FAKE_IGNORE_TERM: ignoreTerm ? '1' : '0',
        HEXCLAW_NATIVE_SIDECAR_PORT: String(port),
        HEXCLAW_TEST_LLM_CONFIG_MODE: 'missing',
        HEXCLAW_TEST_PROFILE_CATCHUP: '0',
      },
    })

    assert.equal(result.signal, null, result.output)
    assert.equal(result.code, 0, result.output)
    assert.match(result.output, /native missing LLM startup .*PASS/)
    assert.match(result.output, /isolated sidecar cleanup: PASS/)
    assert.doesNotMatch(result.output, /native app exited before test cleanup/)

    const observed = JSON.parse(await readFile(capturePath, 'utf8'))
    const isolatedHome = observed.HEXCLAW_TEST_HOME
    assert.ok(path.isAbsolute(isolatedHome))
    assert.equal(observed.HOME, isolatedHome)
    assert.equal(observed.USERPROFILE, isolatedHome)
    assert.equal(observed.CFFIXED_USER_HOME, isolatedHome)
    assert.equal(observed.TMPDIR, path.join(isolatedHome, 'tmp'))
    assert.equal(observed.TEMP, path.join(isolatedHome, 'tmp'))
    assert.equal(observed.TMP, path.join(isolatedHome, 'tmp'))
    for (const key of Object.keys(callerPaths)) {
      assert.notEqual(observed[key], callerPaths[key], `${key} must not retain the caller path`)
    }
    assert.equal(observed.homeMode, 0o700)
    assert.equal(observed.tmpExists, true)
    assert.equal(observed.tmpMode, 0o700)
    await assert.rejects(stat(isolatedHome), { code: 'ENOENT' })
    assert.equal(processExists(observed.appPid), false)
    assert.equal(processExists(observed.sidecarPid), false)
    assert.equal(processExists(unknownProcess.pid), true)
    await assertPortIsFree(port)
  }
})

test('REG-FIX-20260727-MISSING-LLM-STARTUP-002 refuses an occupied port without launching or killing its owner', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hexclaw-missing-llm-occupied.'))
  const launchMarker = path.join(root, 'launched')
  const fakeDesktop = path.join(root, 'must-not-launch.cjs')
  const listener = await listenOnRandomPort()
  const { port } = listener.address()
  await writeFile(
    fakeDesktop,
    `#!/usr/bin/env node
require('node:fs').writeFileSync(${JSON.stringify(launchMarker)}, 'launched')
`,
    { mode: 0o755 },
  )
  t.after(async () => {
    if (listener.listening) await closeServer(listener)
    await rm(root, { recursive: true, force: true })
  })

  const result = await run('bash', [runner, fakeDesktop], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      HEXCLAW_NATIVE_SIDECAR_PORT: String(port),
    },
  })

  assert.notEqual(result.code, 0)
  assert.match(result.output, /test port already has a listener/)
  await assert.rejects(stat(launchMarker), { code: 'ENOENT' })
  assert.equal(listener.listening, true)
})

test('REG-FIX-20260727-MISSING-LLM-STARTUP-003 removes pseudo bundle isolation and fails closed on same-instance handoff', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hexclaw-missing-llm-single-instance.'))
  const fakeDesktop = path.join(root, 'same-instance-handoff.cjs')
  const listener = await listenOnRandomPort()
  const { port } = listener.address()
  await closeServer(listener)
  await writeFile(
    fakeDesktop,
    `#!/usr/bin/env node
setTimeout(() => process.exit(0), 100)
`,
    { mode: 0o755 },
  )
  t.after(() => rm(root, { recursive: true, force: true }))

  const source = await readFile(runner, 'utf8')
  assert.doesNotMatch(source, /HEXCLAW_NATIVE_BUNDLE_ID|\bBUNDLE_ID\b/)

  const result = await run('bash', [runner, fakeDesktop], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      HEXCLAW_NATIVE_SIDECAR_PORT: String(port),
    },
  })
  assert.notEqual(result.code, 0)
  assert.match(result.output, /native app exited before health became reachable/)
  await assertPortIsFree(port)
})

test('REG-FIX-20260727-MISSING-LLM-STARTUP-004 fails when Desktop exits after health while Sidecar remains', async (t) => {
  for (const exitCode of [0, 23]) {
    const root = await mkdtemp(path.join(os.tmpdir(), `hexclaw-missing-llm-post-health-exit-${exitCode}.`))
    const fixture = await createPostHealthExitDesktop(root, exitCode)
    const listener = await listenOnRandomPort()
    const { port } = listener.address()
    await closeServer(listener)
    t.after(async () => {
      await waitForPIDFromFile(fixture.appPidPath)
      await waitForPIDFromFile(fixture.sidecarPidPath)
      await rm(root, { recursive: true, force: true })
    })

    const result = await run('/bin/bash', [runner, fixture.fakeDesktop], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        HEXCLAW_NATIVE_SIDECAR_PORT: String(port),
        HEXCLAW_TEST_LLM_CONFIG_MODE: 'missing',
        HEXCLAW_TEST_PROFILE_CATCHUP: '0',
      },
    })

    const observation = JSON.parse(await readFile(fixture.observationPath, 'utf8'))
    const appPid = Number(await readFile(fixture.appPidPath, 'utf8'))
    const sidecarPid = Number(await readFile(fixture.sidecarPidPath, 'utf8'))
    assert.equal(observation.healthServed, true)
    assert.equal(observation.desktopAliveAtConfigResponse, false)
    assert.equal(processExists(appPid), false)
    assert.equal(processExists(sidecarPid), false)
    await assertPortIsFree(port)
    assert.equal(result.signal, null, result.output)
    assert.notEqual(result.code, 0, result.output)
    assert.match(result.output, new RegExp(`native app exited before test cleanup \\(status ${exitCode}\\)`))
    assert.doesNotMatch(result.output, /native missing LLM startup .*PASS/)
  }

  const zombieRoot = await mkdtemp(path.join(os.tmpdir(), 'hexclaw-missing-llm-post-health-zombie.'))
  const capturePath = path.join(zombieRoot, 'synthetic-zombie-capture.json')
  const zombieMarker = path.join(zombieRoot, 'synthetic-zombie-observed')
  const fakeDesktop = await createFakeDesktop(zombieRoot)
  const zombieProbe = await createSyntheticZombieProbe(zombieRoot, capturePath, zombieMarker)
  const zombieListener = await listenOnRandomPort()
  const { port: zombiePort } = zombieListener.address()
  await closeServer(zombieListener)
  t.after(() => rm(zombieRoot, { recursive: true, force: true }))

  const zombieResult = await run('/bin/bash', [runner, fakeDesktop], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      PATH: `${zombieProbe.fakeBin}:${process.env.PATH}`,
      HEXCLAW_CONTRACT_CAPTURE_PATH: capturePath,
      HEXCLAW_NATIVE_SIDECAR_PORT: String(zombiePort),
      HEXCLAW_SYNTHETIC_ZOMBIE_CAPTURE_PATH: capturePath,
      HEXCLAW_SYNTHETIC_ZOMBIE_MARKER: zombieMarker,
      HEXCLAW_TEST_LLM_CONFIG_MODE: 'missing',
      HEXCLAW_TEST_PROFILE_CATCHUP: '0',
    },
  })

  const zombieObservation = JSON.parse(await readFile(capturePath, 'utf8'))
  await stat(zombieMarker)
  assert.equal(zombieResult.signal, null, zombieResult.output)
  assert.notEqual(zombieResult.code, 0, zombieResult.output)
  assert.match(zombieResult.output, /native app exited before test cleanup \(status unknown\)/)
  assert.doesNotMatch(zombieResult.output, /native missing LLM startup .*PASS/)
  assert.equal(processExists(zombieObservation.appPid), false)
  assert.equal(processExists(zombieObservation.sidecarPid), false)
  await assert.rejects(stat(zombieObservation.HEXCLAW_TEST_HOME), { code: 'ENOENT' })
  await assertPortIsFree(zombiePort)
})

test('REG-FIX-20260727-MISSING-LLM-STARTUP-005 does not signal the caller process group for an invalid candidate', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hexclaw-missing-llm-bad-caller-pgid.'))
  const fixture = await createFastExitDesktop(root)
  const probe = await createBadProcessGroupProbe(root)
  const listener = await listenOnRandomPort()
  const { port } = listener.address()
  await closeServer(listener)
  const unknownProcess = spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore' })
  t.after(async () => {
    await waitForPIDFromFile(fixture.appPidPath)
    await stopProcess(unknownProcess)
    await rm(root, { recursive: true, force: true })
  })

  const source = await readFile(runner, 'utf8')
  assert.match(source, /kill -TERM "\$\{SUPERVISOR_PID\}"/)
  assert.match(source, /kill -KILL "\$\{SUPERVISOR_PID\}"/)
  assert.doesNotMatch(source, /kill -(?:TERM|KILL) %\+/)

  const result = await run('/bin/bash', [runner, fixture.fakeDesktop], {
    cwd: repositoryRoot,
    detached: true,
    env: {
      ...process.env,
      PATH: `${probe.fakeBin}:${process.env.PATH}`,
      HEXCLAW_BAD_PGID_APP_PID_PATH: fixture.appPidPath,
      HEXCLAW_BAD_PGID_INJECTED_MARKER: probe.injectedMarker,
      HEXCLAW_BAD_PGID_MODE: 'supervisor-caller',
      HEXCLAW_BAD_PGID_TARGET_PID_PATH: probe.targetPidPath,
      HEXCLAW_NATIVE_SIDECAR_PORT: String(port),
    },
  })

  const supervisorPid = Number(await waitForFile(probe.targetPidPath))
  await waitForProcessExit(supervisorPid)
  assert.equal(result.signal, null, result.output)
  assert.notEqual(result.code, 0, result.output)
  assert.match(result.output, /could not isolate the app process group/)
  assert.doesNotMatch(result.output, /native missing LLM startup .*PASS/)
  assert.equal(processExists(unknownProcess.pid), true)
  await assertPortIsFree(port)
})

test('REG-FIX-20260727-MISSING-LLM-STARTUP-006 does not signal a reused process group after ownership disappears', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hexclaw-missing-llm-stale-pgid.'))
  const fixture = await createPostClaimTreeExitDesktop(root)
  const probe = await createStaleProcessGroupProbe(root, fixture)
  const listener = await listenOnRandomPort()
  const { port } = listener.address()
  await closeServer(listener)
  t.after(async () => {
    await waitForPIDFromFile(fixture.appPidPath)
    await waitForPIDFromFile(fixture.sidecarPidPath)
    await rm(root, { recursive: true, force: true })
  })

  const result = await run('/bin/bash', [runner, fixture.fakeDesktop], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      PATH: `${probe.fakeBin}:${process.env.PATH}`,
      BASH_ENV: probe.bashEnvironment,
      HEXCLAW_NATIVE_SIDECAR_PORT: String(port),
      HEXCLAW_STALE_GROUP_RELEASE_MARKER: probe.releaseMarker,
      HEXCLAW_STALE_GROUP_SIGNAL_MARKER: probe.signalMarker,
      HEXCLAW_STALE_GROUP_SUPERVISOR_PID_PATH: fixture.supervisorPidPath,
      HEXCLAW_STALE_GROUP_TERM_MARKER: probe.termMarker,
      HEXCLAW_STALE_GROUP_TREE_EXIT_MARKER: fixture.treeExitMarker,
      HEXCLAW_TEST_LLM_CONFIG_MODE: 'missing',
      HEXCLAW_TEST_PROFILE_CATCHUP: '1',
    },
  })

  const appPid = Number(
    await waitForFile(fixture.appPidPath).catch((error) => {
      throw new Error(`${error.message}\n${result.output}`)
    }),
  )
  const sidecarPid = Number(
    await waitForFile(fixture.sidecarPidPath).catch((error) => {
      throw new Error(`${error.message}\n${result.output}`)
    }),
  )
  await waitForProcessExit(appPid)
  await waitForProcessExit(sidecarPid)
  const supervisorPid = Number(await waitForFile(fixture.supervisorPidPath))
  assert.ok(Number.isInteger(supervisorPid) && supervisorPid > 0)
  assert.equal(result.signal, null, result.output)
  assert.notEqual(result.code, 0, result.output)
  assert.match(result.output, /native app exited before test cleanup/)
  assert.doesNotMatch(result.output, /native missing LLM startup .*PASS/)
  await stat(probe.termMarker)
  await assert.rejects(stat(probe.signalMarker), { code: 'ENOENT' })
  const source = await readFile(runner, 'utf8')
  const captureSnapshot = source.match(/capture_live_process_group_members\(\) \{([\s\S]*?)\n\}/)?.[1]
  const verifySnapshot = source.match(/snapshot_has_live_group_member\(\) \{([\s\S]*?)\n\}/)?.[1]
  assert.match(captureSnapshot ?? '', /read_process_start_id/)
  assert.match(captureSnapshot ?? '', /read_process_command_id/)
  assert.match(verifySnapshot ?? '', /read_process_start_id/)
  assert.match(verifySnapshot ?? '', /read_process_command_id/)
  await assertPortIsFree(port)
})

async function assertExternalSignalCleanup(t, signal, options = {}) {
  const suffix = [
    signal.toLowerCase(),
    options.delivery === 'group' ? 'group' : 'pid',
    options.cleanupViaAfterWithoutCapture ? 'no-capture' : 'capture',
  ].join('-')
  const root = await mkdtemp(path.join(os.tmpdir(), `hexclaw-missing-llm-${suffix}-harness.`))
  const capturePath = path.join(root, `${suffix}-harness-environment.json`)
  const callerPaths = await createCallerPaths(root)
  const fakeDesktop = await createFakeDesktop(root)
  const startIdentityHelper = await createProcessStartIdentityHelper(root)
  const listener = await listenOnRandomPort()
  const { port } = listener.address()
  await closeServer(listener)
  const unknownProcess = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  })
  const harness = spawn('/bin/bash', [runner, fakeDesktop], {
    cwd: repositoryRoot,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...callerPaths,
      HEXCLAW_CONTRACT_CAPTURE_PATH: capturePath,
      HEXCLAW_FAKE_CAPTURE_DELAY_MS: String(options.captureDelayMilliseconds ?? 0),
      HEXCLAW_NATIVE_SIDECAR_PORT: String(port),
      HEXCLAW_TEST_LLM_CONFIG_MODE: 'missing',
      HEXCLAW_TEST_PROFILE_CATCHUP: '0',
    },
  })
  let harnessOutput = ''
  harness.stdout.on('data', (chunk) => {
    harnessOutput += chunk
  })
  harness.stderr.on('data', (chunk) => {
    harnessOutput += chunk
  })
  const harnessExited = new Promise((resolve) => harness.once('exit', resolve))
  const harnessClosed = new Promise((resolve) => harness.once('close', resolve))
  let observed
  let isolatedHome
  let ownership
  let verifiedSupervisor
  let verifiedWatchdog
  let verifiedApp
  let verifiedSidecar
  t.after(async () => {
    if (!isolatedHome) {
      try {
        isolatedHome = await findIsolatedRunnerHome(callerPaths.TMPDIR, 1000)
      } catch {}
    }
    if (isolatedHome && !ownership) ownership = await readPublishedOwnership(isolatedHome)
    const allowedOwnerParents =
      harness.exitCode === null && harness.signalCode === null ? [harness.pid] : [harness.pid, 1]
    if (ownership?.supervisor && !verifiedSupervisor && processExists(ownership.supervisor.pid)) {
      verifiedSupervisor = await verifyPublishedProcessIdentity(
        startIdentityHelper,
        ownership.supervisor,
        allowedOwnerParents,
      )
    }
    if (ownership?.watchdog && !verifiedWatchdog && processExists(ownership.watchdog.pid)) {
      verifiedWatchdog = await verifyPublishedProcessIdentity(
        startIdentityHelper,
        ownership.watchdog,
        allowedOwnerParents,
      )
    }
    if (options.cleanupViaAfterWithoutCapture) {
      assert.equal(await readJSONIfPresent(capturePath), undefined)
    }
    if (harness.exitCode === null && harness.signalCode === null) harness.kill('SIGKILL')
    await harnessExited.catch(() => {})
    await terminateVerifiedPublishedProcess(startIdentityHelper, verifiedSupervisor)
    await terminateVerifiedPublishedProcess(startIdentityHelper, verifiedSidecar)
    await terminateVerifiedPublishedProcess(startIdentityHelper, verifiedApp)
    await terminateVerifiedPublishedProcess(startIdentityHelper, verifiedWatchdog)
    await harnessClosed.catch(() => {})
    const ownedPids = [
      verifiedSidecar?.pid,
      verifiedApp?.pid,
      verifiedSupervisor?.pid,
      verifiedWatchdog?.pid,
    ].filter(Number.isInteger)
    for (const pid of ownedPids) {
      await waitForProcessExit(pid, 5000)
      assert.equal(processExists(pid), false)
    }
    await assertPortIsFree(port)
    assert.equal(processExists(unknownProcess.pid), true)
    if (isolatedHome) await rm(isolatedHome, { recursive: true, force: true })
    await stopProcess(unknownProcess)
    await rm(root, { recursive: true, force: true })
  })

  const bootstrap = await waitForHarnessBootstrap(harness, callerPaths.TMPDIR, capturePath, () => harnessOutput)
  assert.equal(bootstrap.kind, 'ready', JSON.stringify(bootstrap))
  isolatedHome = bootstrap.isolatedHome
  ownership = bootstrap.ownership
  const harnessIdentity = await readStrictProcessIdentity(startIdentityHelper, harness.pid)
  const runnerIdentity = await readProcessIdentity(process.pid)
  assert.equal(harnessIdentity.processGroupId, harness.pid)
  assert.notEqual(harnessIdentity.processGroupId, runnerIdentity.processGroupId)
  assert.equal(await readHighResolutionProcessStartId(startIdentityHelper, harness.pid), ownership.ready.owner.startId)
  assert.equal(commandIdentity(harnessIdentity.command), ownership.ready.owner.commandId)
  verifiedSupervisor = await verifyPublishedProcessIdentity(startIdentityHelper, ownership.supervisor, [harness.pid])
  verifiedWatchdog = await verifyPublishedProcessIdentity(startIdentityHelper, ownership.watchdog, [harness.pid])
  if (options.cleanupViaAfterWithoutCapture) {
    assert.equal(await readJSONIfPresent(capturePath), undefined)
    process.kill(verifiedWatchdog.pid, 'SIGSTOP')
    assert.equal(await readHighResolutionProcessStartId(startIdentityHelper, verifiedWatchdog.pid), verifiedWatchdog.startId)
    process.kill(-harness.pid, 'SIGKILL')
    await harnessExited
    return
  }
  const captured = await waitForCaptureOrHarnessExit(harness, capturePath, () => harnessOutput)
  assert.equal(captured.kind, 'capture', JSON.stringify(captured))
  observed = captured.capture
  const supervisorIdentity = await readProcessIdentity(observed.supervisorPid)
  const appIdentity = await readStrictProcessIdentity(startIdentityHelper, observed.appPid)
  const sidecarIdentity = await readStrictProcessIdentity(startIdentityHelper, observed.sidecarPid)
  assert.equal(supervisorIdentity.parentPid, harness.pid)
  assert.equal(supervisorIdentity.processGroupId, observed.supervisorPid)
  assert.equal(appIdentity.parentPid, observed.supervisorPid)
  assert.equal(appIdentity.processGroupId, observed.supervisorPid)
  assert.equal(sidecarIdentity.parentPid, observed.appPid)
  assert.equal(sidecarIdentity.processGroupId, observed.supervisorPid)
  verifiedApp = { pid: observed.appPid, ...appIdentity }
  verifiedSidecar = { pid: observed.sidecarPid, ...sidecarIdentity }

  if (options.delivery === 'group') process.kill(-harness.pid, signal)
  else assert.equal(harness.kill(signal), true)
  await harnessClosed

  await waitForProcessExit(observed.sidecarPid, 10_000)
  await waitForProcessExit(observed.appPid, 10_000)
  await waitForProcessExit(observed.supervisorPid, 10_000)
  await waitForProcessExit(observed.watchdogPid, 10_000)
  await waitForPathRemoval(observed.HEXCLAW_TEST_HOME)
  await assertPortIsFree(port)
  assert.equal(processExists(unknownProcess.pid), true)
}

test('REG-FIX-20260727-MISSING-LLM-STARTUP-007 reaps its proven tree when the harness is killed', async (t) => {
  await assertExternalSignalCleanup(t, 'SIGKILL')
})

test('REG-FIX-20260727-MISSING-LLM-STARTUP-008 reaps its proven tree when the harness is terminated', async (t) => {
  await assertExternalSignalCleanup(t, 'SIGTERM')
})

async function assertLongLivedClaimFailure(t, target) {
  const root = await mkdtemp(path.join(os.tmpdir(), `hexclaw-missing-llm-${target}-claim.`))
  const capturePath = path.join(root, `${target}-claim-environment.json`)
  const appPidPath = path.join(root, 'app.pid')
  const sidecarPidPath = path.join(root, 'sidecar.pid')
  const callerPaths = await createCallerPaths(root)
  const fakeDesktop = await createFakeDesktop(root)
  const probe = await createClaimFailureProbe(root, target)
  const listener = await listenOnRandomPort()
  const { port } = listener.address()
  await closeServer(listener)
  const unknownProcess = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  })
  let observed
  t.after(async () => {
    if (observed) {
      await forceStopPID(observed.sidecarPid)
      await forceStopPID(observed.appPid)
      await forceStopPID(observed.supervisorPid)
      await forceStopPID(observed.watchdogPid)
    }
    await stopProcess(unknownProcess)
    await rm(root, { recursive: true, force: true })
  })

  const result = await run('/bin/bash', [runner, fakeDesktop], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      ...callerPaths,
      PATH: `${probe.fakeBin}:${process.env.PATH}`,
      HEXCLAW_CLAIM_APP_PID_PATH: appPidPath,
      HEXCLAW_CLAIM_INJECTED_MARKER: probe.injectedMarker,
      HEXCLAW_CLAIM_SIDECAR_PID_PATH: sidecarPidPath,
      HEXCLAW_CLAIM_TARGET_KIND: target,
      HEXCLAW_CLAIM_TARGET_PID_PATH: target === 'app' ? appPidPath : sidecarPidPath,
      HEXCLAW_CONTRACT_CAPTURE_PATH: capturePath,
      HEXCLAW_NATIVE_SIDECAR_PORT: String(port),
      HEXCLAW_TEST_LLM_CONFIG_MODE: 'missing',
      HEXCLAW_TEST_PROFILE_CATCHUP: '0',
    },
  })

  observed = JSON.parse(await waitForFile(capturePath, 5000))
  await stat(probe.injectedMarker)
  assert.equal(result.signal, null, result.output)
  assert.notEqual(result.code, 0, result.output)
  assert.match(
    result.output,
    target === 'app'
      ? /could not verify the supervised app process/
      : /listener is not owned by the isolated app process group/,
  )
  assert.doesNotMatch(result.output, /native missing LLM startup .*PASS/)
  await waitForProcessExit(observed.sidecarPid, 5000)
  await waitForProcessExit(observed.appPid, 5000)
  await waitForProcessExit(observed.supervisorPid, 5000)
  await waitForProcessExit(observed.watchdogPid, 5000)
  await waitForPathRemoval(observed.HEXCLAW_TEST_HOME)
  await assertPortIsFree(port)
  assert.equal(processExists(unknownProcess.pid), true)
}

test('REG-FIX-20260727-MISSING-LLM-STARTUP-009 reaps long-lived trees after App and Sidecar claim failures', async (t) => {
  await t.test('App claim failure', async (subtest) => {
    await assertLongLivedClaimFailure(subtest, 'app')
  })
  await t.test('Sidecar claim failure', async (subtest) => {
    await assertLongLivedClaimFailure(subtest, 'sidecar')
  })
})

test('REG-FIX-20260727-MISSING-LLM-STARTUP-010 supervisor abandons an unarmed bootstrap after owner death', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hexclaw-missing-llm-bootstrap-owner.'))
  const callerPaths = await createCallerPaths(root)
  const startIdentityHelper = await createProcessStartIdentityHelper(root)
  const launchMarker = path.join(root, 'desktop-launched')
  const fakeDesktop = path.join(root, 'bootstrap-must-not-launch.cjs')
  const probe = await createBootstrapPauseProbe(root)
  const listener = await listenOnRandomPort()
  const { port } = listener.address()
  await closeServer(listener)
  await writeFile(
    fakeDesktop,
    `#!/usr/bin/env node
require('node:fs').writeFileSync(${JSON.stringify(launchMarker)}, 'launched')
setInterval(() => {}, 1000)
`,
    { mode: 0o755 },
  )
  await chmod(fakeDesktop, 0o755)

  const unknownProcess = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  })
  const harness = spawn('/bin/bash', [runner, fakeDesktop], {
    cwd: repositoryRoot,
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      ...callerPaths,
      PATH: `${probe.fakeBin}:${process.env.PATH}`,
      HEXCLAW_BOOTSTRAP_RELEASE_MARKER: probe.releaseMarker,
      HEXCLAW_BOOTSTRAP_SUPERVISOR_PID_PATH: probe.supervisorPidPath,
      HEXCLAW_NATIVE_SIDECAR_PORT: String(port),
    },
  })
  const harnessClosed = new Promise((resolve) => harness.once('close', resolve))
  let expectedSupervisor
  let isolatedHome
  t.after(async () => {
    await writeFile(probe.releaseMarker, 'released').catch(() => {})
    if (harness.exitCode === null && harness.signalCode === null) process.kill(-harness.pid, 'SIGKILL')
    await harnessClosed.catch(() => {})
    if (expectedSupervisor) await terminateVerifiedGroupLeader(startIdentityHelper, expectedSupervisor)
    await stopProcess(unknownProcess)
    await rm(root, { recursive: true, force: true })
  })

  const supervisorPid = Number(await waitForFile(probe.supervisorPidPath, 15_000))
  const supervisorIdentity = await readStrictProcessIdentity(startIdentityHelper, supervisorPid)
  expectedSupervisor = { pid: supervisorPid, ...supervisorIdentity }
  assert.equal(supervisorIdentity.parentPid, harness.pid)
  assert.equal(supervisorIdentity.processGroupId, supervisorPid)
  assert.match(supervisorIdentity.command, /test-missing-llm-startup\.sh/)
  assert.match(supervisorIdentity.command, /bootstrap-must-not-launch\.cjs/)
  isolatedHome = await findIsolatedRunnerHome(callerPaths.TMPDIR)

  const runnerIdentity = await readProcessIdentity(process.pid)
  assert.notEqual(runnerIdentity.processGroupId, harness.pid)
  process.kill(-harness.pid, 'SIGKILL')
  await harnessClosed
  await waitForProcessExit(supervisorPid, 3000)
  await waitForPathRemoval(isolatedHome, 3000)
  await assert.rejects(stat(launchMarker), { code: 'ENOENT' })
  assert.equal(processExists(unknownProcess.pid), true)
  await assertPortIsFree(port)
})

test('REG-FIX-20260727-MISSING-LLM-STARTUP-011 publishes verified watchdog readiness before App completion', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hexclaw-missing-llm-watchdog-ready.'))
  const capturePath = path.join(root, 'watchdog-ready-environment.json')
  const callerPaths = await createCallerPaths(root)
  const fakeDesktop = await createFakeDesktop(root)
  const startIdentityHelper = await createProcessStartIdentityHelper(root)
  const listener = await listenOnRandomPort()
  const { port } = listener.address()
  await closeServer(listener)
  const unknownProcess = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  })
  const harness = spawn('/bin/bash', [runner, fakeDesktop], {
    cwd: repositoryRoot,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...callerPaths,
      HEXCLAW_CONTRACT_CAPTURE_PATH: capturePath,
      HEXCLAW_FAKE_CONFIG_DELAY_MS: '5000',
      HEXCLAW_NATIVE_SIDECAR_PORT: String(port),
      HEXCLAW_TEST_LLM_CONFIG_MODE: 'missing',
      HEXCLAW_TEST_PROFILE_CATCHUP: '0',
    },
  })
  let harnessOutput = ''
  harness.stdout.on('data', (chunk) => {
    harnessOutput += chunk
  })
  harness.stderr.on('data', (chunk) => {
    harnessOutput += chunk
  })
  const harnessClosed = new Promise((resolve) => harness.once('close', resolve))
  let ownedChildren = []
  t.after(async () => {
    if (ownedChildren.length === 0 && harness.exitCode === null && harness.signalCode === null) {
      ownedChildren = await readDirectChildIdentities(startIdentityHelper, harness.pid)
    }
    if (harness.exitCode === null && harness.signalCode === null) harness.kill('SIGKILL')
    await harnessClosed.catch(() => {})
    for (const identity of ownedChildren) {
      await terminateVerifiedOwnedProcess(startIdentityHelper, identity)
    }
    await assertPortIsFree(port)
    assert.equal(processExists(unknownProcess.pid), true)
    await stopProcess(unknownProcess)
    await rm(root, { recursive: true, force: true })
  })

  const bootstrap = await waitForHarnessBootstrap(harness, callerPaths.TMPDIR, capturePath, () => harnessOutput)
  assert.equal(bootstrap.kind, 'ready', JSON.stringify(bootstrap))
  const { isolatedHome, ownership } = bootstrap
  const { ready } = ownership
  await verifyPublishedProcessIdentity(startIdentityHelper, ownership.supervisor, [harness.pid])
  await verifyPublishedProcessIdentity(startIdentityHelper, ownership.watchdog, [harness.pid])
  ownedChildren = await readDirectChildIdentities(startIdentityHelper, harness.pid)
  assert.equal(ready.version, 1)
  assert.equal(ready.owner.pid, harness.pid)
  assert.equal(ready.supervisor.pgid, ready.supervisor.pid)
  assert.equal(ready.watchdog.pgid, ready.watchdog.pid)
  assert.deepEqual(
    new Set(ownedChildren.map(({ pid }) => pid)),
    new Set([ready.supervisor.pid, ready.watchdog.pid]),
  )
  assert.notEqual(ready.watchdog.pgid, ready.owner.pgid)
  assert.notEqual(ready.watchdog.pgid, ready.supervisor.pgid)
  for (const identity of [ready.owner, ready.supervisor, ready.watchdog]) {
    assert.equal(identity.startId, await readHighResolutionProcessStartId(startIdentityHelper, identity.pid))
    assert.match(identity.commandId, /^[a-f0-9]{64}$/)
  }
  assert.equal(processExists(unknownProcess.pid), true)
})

test('REG-FIX-20260727-MISSING-LLM-STARTUP-012 waits on watchdog readiness, App capture, or harness exit', async (t) => {
  await assertExternalSignalCleanup(t, 'SIGKILL', { captureDelayMilliseconds: 6000 })
})

test('REG-FIX-20260727-MISSING-LLM-STARTUP-013 reaps after an external whole-caller-group signal', async (t) => {
  await t.test('SIGTERM', async (subtest) => {
    await assertExternalSignalCleanup(subtest, 'SIGTERM', { delivery: 'group' })
  })
  await t.test('SIGKILL', async (subtest) => {
    await assertExternalSignalCleanup(subtest, 'SIGKILL', { delivery: 'group' })
  })
})

test('REG-FIX-20260727-MISSING-LLM-STARTUP-014 t.after reclaims published identities without App capture', async (t) => {
  await assertExternalSignalCleanup(t, 'SIGKILL', {
    captureDelayMilliseconds: 30_000,
    cleanupViaAfterWithoutCapture: true,
    delivery: 'group',
  })
})
