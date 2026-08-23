#!/usr/bin/env node

/**
 * BUG-20260802-014 / BUG-20260723-026：真实 AppKit 打印边界。
 *
 * 该 harness 只构建并启动 0700 临时 HOME 下的 Test.app。原生 UI driver 没有“打印”动作，
 * 只允许取消，或精确选择“存储为 PDF”并写入隔离 HOME。任何 AX 歧义都会 fail closed。
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const nativeDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(nativeDir, '../..')
const tauriRoot = join(repoRoot, 'src-tauri')
const sidecarRoot = resolve(repoRoot, '../hexclaw')
const driverSource = join(nativeDir, 'bug-20260802-014-print-panel-driver.swift')
const evidenceBase = join(repoRoot, 'test/evidence/bug-20260802-014-macos-print')
const runID = new Date().toISOString().replaceAll(':', '').replaceAll('.', '')
const evidenceRoot = join(evidenceBase, runID)
const appName = 'HexClaw BUG014 Print Boundary Test'
const bundleIdentifier = 'com.hexclaw.desktop.bug014.print-boundary'
const agent = 'bug014-isolated-agent'
const commandTimeoutMs = 15 * 60 * 1000
const phaseTimeoutMs = 90_000

const sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const sha256File = (path) => sha256(readFileSync(path))

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    process.stdout.write(`[bug014-print] ${command} ${args.join(' ')}\n`)
    const child = spawn(command, args, {
      cwd: options.cwd || repoRoot,
      env: options.env || process.env,
      stdio: options.stdio || 'inherit',
    })
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`command timed out: ${command} ${args.join(' ')}`))
    }, options.timeoutMs || commandTimeoutMs)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      if (code === 0) resolvePromise()
      else reject(new Error(`command failed (${code ?? signal}): ${command} ${args.join(' ')}`))
    })
  })
}

async function reservePort() {
  const server = createServer()
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const port = address.port
  await new Promise((resolvePromise) => server.close(resolvePromise))
  assert.notEqual(port, 16060)
  assert.notEqual(port, 11434)
  return port
}

function listenerPIDs(port) {
  try {
    return execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' })
      .split(/\s+/).filter(Boolean).map(Number)
  } catch {
    return []
  }
}

function processCommand(pid) {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  const exited = await Promise.race([
    new Promise((resolvePromise) => child.once('exit', () => resolvePromise(true))),
    sleep(5_000).then(() => false),
  ])
  if (!exited && child.exitCode === null) {
    child.kill('SIGKILL')
    await new Promise((resolvePromise) => child.once('exit', resolvePromise))
  }
}

async function stopOwnedListeners(ports, appBundle) {
  const stopped = []
  const unexpected = []
  for (const port of ports) {
    for (const pid of listenerPIDs(port)) {
      const command = processCommand(pid)
      if (!command.includes(`${appBundle}/Contents/MacOS/`)) {
        unexpected.push({ port, pid, command: command || '<unreadable>' })
        continue
      }
      process.kill(pid, 'SIGTERM')
      stopped.push({ port, pid, command })
    }
  }
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline && ports.some((port) => listenerPIDs(port).length)) await sleep(100)
  for (const port of ports) {
    for (const pid of listenerPIDs(port)) {
      const command = processCommand(pid)
      if (command.includes(`${appBundle}/Contents/MacOS/`)) {
        process.kill(pid, 'SIGKILL')
        stopped.push({ port, pid, command, forced: true })
      }
    }
  }
  await sleep(200)
  return {
    stopped,
    unexpected,
    released: ports.every((port) => listenerPIDs(port).length === 0),
  }
}

async function stopOwnedPIDFile(pidFile, appBundle) {
  if (!existsSync(pidFile)) return { stopped: [], unexpected: [] }
  const pid = Number(readFileSync(pidFile, 'utf8').trim())
  rmSync(pidFile, { force: true })
  if (!Number.isInteger(pid) || pid <= 0) return { stopped: [], unexpected: [{ pid, command: '<invalid pid file>' }] }
  let command = processCommand(pid)
  if (!command) return { stopped: [], unexpected: [] }
  if (!command.includes(`${appBundle}/Contents/MacOS/hexclaw-real serve --desktop`)) {
    return { stopped: [], unexpected: [{ pid, command }] }
  }
  process.kill(pid, 'SIGTERM')
  const deadline = Date.now() + 10_000
  while ((command = processCommand(pid)) && Date.now() < deadline) await sleep(100)
  if (command) {
    process.kill(pid, 'SIGKILL')
    const killDeadline = Date.now() + 3_000
    while (processCommand(pid) && Date.now() < killDeadline) await sleep(100)
  }
  return { stopped: [{ pid, command: `${appBundle}/Contents/MacOS/hexclaw-real serve --desktop` }], unexpected: [] }
}

function readBody(request, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolvePromise, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(new Error('control request too large'))
        request.destroy()
      } else chunks.push(chunk)
    })
    request.on('end', () => resolvePromise(Buffer.concat(chunks)))
    request.on('error', reject)
  })
}

function jsonResponse(response, status, value) {
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  })
  response.end(JSON.stringify(value))
}

async function startControlServer() {
  const state = { phase: null, events: [], protocolErrors: [], unexpected: [], localWarmupRequests: 0 }
  const server = createServer(async (request, response) => {
    try {
      if (request.method === 'OPTIONS') {
        jsonResponse(response, 204, {})
        return
      }
      const url = new URL(request.url || '/', 'http://127.0.0.1')
      if (request.method === 'GET' && url.pathname === '/control') {
        jsonResponse(response, 200, state.phase || { id: 'idle', action: 'idle' })
        return
      }
      if (request.method === 'POST' && url.pathname === '/event') {
        const event = JSON.parse((await readBody(request)).toString('utf8'))
        assert.equal(typeof event.phaseID, 'string')
        assert.equal(typeof event.type, 'string')
        state.events.push({ ...event, receivedAt: Date.now() })
        jsonResponse(response, 200, { accepted: true })
        return
      }
      if (url.pathname === '/updater') {
        response.writeHead(204, { 'Access-Control-Allow-Origin': '*' })
        response.end()
        return
      }
      if (url.pathname === '/v1/models') {
        jsonResponse(response, 200, { object: 'list', data: [{ id: 'fixture-model', object: 'model' }] })
        return
      }
      if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
        await readBody(request)
        state.localWarmupRequests += 1
        jsonResponse(response, 503, { error: { message: 'isolated print fixture intentionally disables model execution' } })
        return
      }
      state.unexpected.push(`${request.method || 'GET'} ${url.pathname}`)
      jsonResponse(response, 404, { error: 'unexpected control route' })
    } catch (error) {
      state.protocolErrors.push(error instanceof Error ? error.message : String(error))
      if (!response.headersSent) jsonResponse(response, 500, { error: 'control protocol failed' })
      else response.end()
    }
  })
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return {
    origin: `http://127.0.0.1:${address.port}`,
    state,
    setPhase(phase) { state.phase = phase },
    async waitEvent(phaseID, type, after = 0, timeout = phaseTimeoutMs) {
      const deadline = Date.now() + timeout
      while (Date.now() < deadline) {
        const index = state.events.findIndex((event, candidate) =>
          candidate >= after && event.phaseID === phaseID && event.type === type)
        if (index >= 0) return { index, event: state.events[index] }
        const fatalIndex = state.events.findIndex((event, candidate) =>
          candidate >= after && event.phaseID === phaseID && event.type === 'fatal')
        if (fatalIndex >= 0) throw new Error(`fixture fatal in ${phaseID}: ${state.events[fatalIndex].error}`)
        await sleep(100)
      }
      throw new Error(`timed out waiting for ${phaseID}:${type}`)
    },
    async close() {
      if (!server.listening) return
      server.closeAllConnections?.()
      await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()))
    },
  }
}

function fixtureSource(controlOrigin) {
  return `
import { Channel, invoke } from '@tauri-apps/api/core'
const controlOrigin = ${JSON.stringify(controlOrigin)}
const encoder = new TextEncoder()
const decoder = new TextDecoder()
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function control(path, init) {
  const response = await fetch(controlOrigin + path, { cache: 'no-store', ...init })
  if (!response.ok) throw new Error('control HTTP ' + response.status)
  return response.json()
}
async function report(phaseID, type, detail = {}) {
  return control('/event', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phaseID, type, ...detail }),
  })
}
async function sidecar(path, method = 'GET', payload) {
  let lastError
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const cancellationId = 'bug014:' + crypto.randomUUID()
      const onRegistered = new Channel(() => {})
      const headers = payload === undefined ? {} : { 'Content-Type': 'application/json' }
      const body = payload === undefined ? [] : Array.from(encoder.encode(JSON.stringify(payload)))
      const result = await invoke('sidecar_fetch', { method, path, headers, body, cancellationId, onRegistered })
      const text = decoder.decode(new Uint8Array(result.body))
      const decoded = text ? JSON.parse(text) : null
      if (result.status < 200 || result.status >= 300) throw new Error('sidecar HTTP ' + result.status + ': ' + text)
      return decoded
    } catch (error) {
      lastError = error
      await sleep(200)
    }
  }
  throw lastError || new Error('sidecar unavailable')
}
async function query(jobID) {
  return (await sidecar('/api/k12/print-jobs/' + encodeURIComponent(jobID) + '?agent=' + encodeURIComponent(${JSON.stringify(agent)}))).print_job
}
async function execute() {
  const phase = await control('/control')
  if (phase.action === 'idle') return
  const registered = await sidecar('/api/v1/agents')
  if (!(registered.agents || []).some((candidate) => candidate.name === ${JSON.stringify(agent)})) {
    await sidecar('/api/v1/agents', 'POST', {
      name: ${JSON.stringify(agent)}, display_name: 'BUG014 Isolated Agent',
      provider: 'fixture', model: 'fixture-model', metadata: {},
    })
  }
  let job
  if (phase.action === 'new') {
    job = (await sidecar('/api/k12/print-jobs', 'POST', {
      agent: ${JSON.stringify(agent)}, idempotency_key: phase.idempotencyKey,
      source_kind: 'tutoring_tips', source_ref: phase.sourceRef,
      title: phase.title, canonical_markdown: '# ' + phase.title + '\\n\\n' + phase.body + '\\n',
    })).print_job
  } else if (phase.action === 'retry') {
    job = (await sidecar('/api/k12/print-jobs/' + encodeURIComponent(phase.jobID) + '/retry', 'POST', {
      agent: ${JSON.stringify(agent)},
    })).print_job
  } else {
    job = await query(phase.jobID)
  }
  await report(phase.id, 'beforeExecute', { job })
  try {
    const result = await invoke('execute_print_job', {
      request: { agent: ${JSON.stringify(agent)}, printJobId: job.print_job_id },
    })
    const projected = await query(job.print_job_id)
    await report(phase.id, 'executeResult', { job: projected, result })
  } catch (error) {
    let projected = null
    try { projected = await query(job.print_job_id) } catch {}
    await report(phase.id, 'executeError', {
      job: projected, error: error instanceof Error ? error.message : String(error),
    })
  }
}
execute().catch(async (error) => {
  try { await report((await control('/control')).id, 'fatal', { error: error instanceof Error ? error.message : String(error) }) } catch {}
})
`
}

async function prepareFrontend(sandbox, controlOrigin) {
  const source = join(sandbox, 'frontend-source')
  const output = join(sandbox, 'frontend-dist')
  mkdirSync(source, { mode: 0o700 })
  const repoModules = join(repoRoot, 'node_modules')
  assert.ok(existsSync(repoModules), 'repository node_modules is required')
  symlinkSync(repoModules, join(source, 'node_modules'), 'dir')
  writeFileSync(join(source, 'index.html'), '<!doctype html><html><head><meta charset="UTF-8"></head><body><main>Native print boundary fixture</main><script type="module" src="/main.js"></script></body></html>\n', { mode: 0o600 })
  writeFileSync(join(source, 'main.js'), fixtureSource(controlOrigin), { mode: 0o600 })
  await run(join(repoRoot, 'node_modules/.bin/vite'), ['build', '--outDir', output, '--emptyOutDir'], {
    cwd: source,
    env: { ...process.env, PNPM_CONFIG_OFFLINE: 'true', npm_config_offline: 'true' },
  })
  return { source, output, index: join(output, 'index.html') }
}

function writeOverlay(sandbox, frontend, ports, controlOrigin) {
  const path = join(sandbox, 'tauri.bug014-print.conf.json')
  const csp = [
    "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
    `connect-src 'self' ${controlOrigin} http://127.0.0.1:${ports.front} http://localhost:${ports.front}`,
    "img-src 'self' data: blob:", "object-src 'none'", "base-uri 'self'",
  ].join('; ')
  const overlay = {
    productName: appName,
    identifier: bundleIdentifier,
    build: { frontendDist: relative(tauriRoot, frontend), beforeBuildCommand: '' },
    app: {
      windows: [{ label: 'main', title: appName, width: 900, height: 650, visible: true }],
      security: { csp },
    },
    bundle: { targets: ['app'], createUpdaterArtifacts: false },
    plugins: { updater: { endpoints: [`${controlOrigin}/updater`], dangerousInsecureTransportProtocol: true } },
  }
  writeFileSync(path, `${JSON.stringify(overlay, null, 2)}\n`, { mode: 0o600 })
  return path
}

function renderConfig(sandbox, backendPort, controlOrigin) {
  return `server:
  host: 127.0.0.1
  port: ${backendPort}
  mode: development
platforms:
  web:
    enabled: true
llm:
  default: fixture
  providers:
    fixture:
      provider_instance_id: pvd_v1_01401401401401401401401401401401
      api_key: isolated-test-only
      base_url: ${controlOrigin}/v1
      model: fixture-model
      models: [fixture-model]
      model_specs_mode: explicit
      model_specs:
        - id: fixture-model
          display_name: Isolated Fixture
          capabilities: [text]
      compatible: openai
      locality: local
      locality_source: user
      confirmed_endpoint_host: 127.0.0.1
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
compaction:
  enabled: false
skill:
  sandbox:
    enabled: false
  builtin:
    search: false
    weather: false
    translate: false
    summary: false
    browser: false
    code: false
    shell: false
    code_exec: false
    file_ops: false
observe:
  log_level: info
  metrics:
    enabled: false
`
}

function proxySource(backendPort, dropFile, childPIDFile) {
  return `package main
import (
  "context"
  "fmt"
  "io"
  "net/http"
  "net/http/httputil"
  "net/url"
  "os"
  "os/exec"
  "os/signal"
  "path/filepath"
  "strings"
  "sync"
  "syscall"
  "time"
)
func main() {
  front := os.Getenv("HEXCLAW_SIDECAR_PORT")
  back := ${JSON.stringify(String(backendPort))}
  drop := ${JSON.stringify(dropFile)}
  pidFile := ${JSON.stringify(childPIDFile)}
  exe, _ := os.Executable()
  real := filepath.Join(filepath.Dir(exe), "hexclaw-real")
  args := os.Args[1:]
  child := exec.Command(real, args...)
  child.Env = replaceEnv(os.Environ(), "HEXCLAW_SIDECAR_PORT", back)
  child.Stdout, child.Stderr = os.Stdout, os.Stderr
  if err := child.Start(); err != nil { panic(err) }
  _ = os.WriteFile(pidFile, []byte(fmt.Sprint(child.Process.Pid)), 0600)
  target, _ := url.Parse("http://127.0.0.1:" + back)
  proxy := httputil.NewSingleHostReverseProxy(target)
  transport := http.DefaultTransport
  proxy.Transport = transport
  proxy.ModifyResponse = func(resp *http.Response) error {
    fmt.Printf("PRINT_PROXY response %s %s %d\\n", resp.Request.Method, resp.Request.URL.Path, resp.StatusCode)
    return nil
  }
  var dropMu sync.Mutex
  handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
    fmt.Printf("PRINT_PROXY request %s %s\\n", r.Method, r.URL.Path)
    dropMu.Lock()
    wantedBytes, err := os.ReadFile(drop)
    wanted := strings.TrimSpace(string(wantedBytes))
    shouldDrop := err == nil && ((wanted == "events" && strings.HasSuffix(r.URL.Path, "/events")) || (wanted == "commit" && strings.HasSuffix(r.URL.Path, "/commit")))
    if shouldDrop { _ = os.Remove(drop) }
    dropMu.Unlock()
    if !shouldDrop { proxy.ServeHTTP(w, r); return }
    upstream := r.Clone(r.Context())
    upstream.URL.Scheme, upstream.URL.Host = target.Scheme, target.Host
    upstream.RequestURI = ""
    resp, roundErr := transport.RoundTrip(upstream)
    if roundErr != nil { http.Error(w, roundErr.Error(), http.StatusBadGateway); return }
    _, _ = io.Copy(io.Discard, resp.Body); _ = resp.Body.Close()
    fmt.Printf("PRINT_PROXY dropped-response %s %s durable-status=%d\\n", r.Method, r.URL.Path, resp.StatusCode)
    if hijacker, ok := w.(http.Hijacker); ok {
      conn, _, hijackErr := hijacker.Hijack()
      if hijackErr == nil { _ = conn.Close(); return }
    }
    panic(http.ErrAbortHandler)
  })
  server := &http.Server{Addr: "127.0.0.1:" + front, Handler: handler, ReadHeaderTimeout: 5 * time.Second}
  signals := make(chan os.Signal, 2); signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT)
  go func() { <-signals; _ = server.Shutdown(context.Background()); _ = child.Process.Signal(syscall.SIGTERM) }()
  serveErr := server.ListenAndServe()
  _ = child.Process.Signal(syscall.SIGTERM); _, _ = child.Process.Wait()
  if serveErr != nil && serveErr != http.ErrServerClosed { panic(serveErr) }
}
func replaceEnv(env []string, key, value string) []string {
  prefix := key + "="; output := make([]string, 0, len(env)+1)
  for _, item := range env { if !strings.HasPrefix(item, prefix) { output = append(output, item) } }
  return append(output, prefix+value)
}
`
}

function appEnvironment(sandbox, ports, paths) {
  return {
    PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: 'en_US.UTF-8',
    HOME: sandbox,
    USERPROFILE: sandbox,
    CFFIXED_USER_HOME: sandbox,
    TMPDIR: paths.temp,
    TEMP: paths.temp,
    TMP: paths.temp,
    HEXCLAW_TEST_MODE: '1',
    HEXCLAW_TEST_HOME: sandbox,
    HEXCLAW_SIDECAR_PORT: String(ports.front),
    HEXCLAW_TEST_LLM_CONFIG_MODE: 'preseeded-owner-yaml',
    HEXCLAW_PRINT_PROXY_BACKEND_PORT: String(ports.backend),
    HEXCLAW_PRINT_PROXY_DROP_FILE: paths.drop,
    HEXCLAW_PRINT_PROXY_CHILD_PID_FILE: paths.childPID,
    HEXCLAW_DISABLE_BACKGROUND_EGRESS: '1',
    NO_PROXY: '*',
    no_proxy: '*',
  }
}

function launchApp(executable, sandbox, env, logStream) {
  const child = spawn(executable, [], { cwd: sandbox, env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.pipe(logStream, { end: false })
  child.stderr.pipe(logStream, { end: false })
  return child
}

async function waitHealth(port, app) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (app.exitCode !== null || app.signalCode !== null) throw new Error('Test.app exited before health')
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1_000) })
      if (response.ok) return
    } catch {}
    await sleep(200)
  }
  throw new Error('Sidecar health timeout')
}

function driver(driverPath, command, pid) {
  const args = pid === undefined ? [command] : [command, String(pid)]
  return JSON.parse(execFileSync(driverPath, args, { encoding: 'utf8' }))
}

function driverWithArg(driverPath, command, pid, value) {
  return JSON.parse(execFileSync(driverPath, [command, String(pid), value], { encoding: 'utf8' }))
}

function isCancelRow(row) {
  return row.role === 'AXButton' && ['Cancel', '取消'].includes(row.title || row.description || row.value)
}

async function waitPrintPanel(driverPath, pid) {
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    const rows = driver(driverPath, 'ax', pid)
    if (rows.some(isCancelRow) && rows.some((row) => [row.title, row.description, row.value].includes('PDF'))) return rows
    await sleep(200)
  }
  throw new Error('real AppKit print panel did not become AX-visible')
}

function hasPrintPanel(driverPath, pid) {
  try { return driver(driverPath, 'ax', pid).some(isCancelRow) } catch { return false }
}

function evidenceJSON(value) {
  let text = JSON.stringify(value, null, 2)
  const localUser = process.env.USER || ''
  if (localUser) text = text.replaceAll(localUser, '[LOCAL_USER]')
  const localHome = process.env.HOME || ''
  if (localHome) text = text.replaceAll(localHome, '<user-home>')
  return `${text}\n`
}

function savePanelEvidence(driverPath, pid, name) {
  const ax = driver(driverPath, 'ax', pid)
  const windows = driver(driverPath, 'windows', pid)
  writeFileSync(join(evidenceRoot, `${name}-ax.json`), evidenceJSON(ax), { mode: 0o600 })
  writeFileSync(join(evidenceRoot, `${name}-windows.json`), evidenceJSON(windows), { mode: 0o600 })
  const candidate = windows
    .filter((row) => row.layer === 0 && row.id > 0)
    .sort((left, right) => (right.bounds.width * right.bounds.height) - (left.bounds.width * left.bounds.height))[0]
  if (candidate) {
    const screenshot = join(evidenceRoot, `${name}.png`)
    execFileSync('screencapture', ['-x', '-l', String(candidate.id), screenshot])
    return { axPath: `${name}-ax.json`, windowsPath: `${name}-windows.json`, screenshot: `${name}.png`, window: candidate }
  }
  return { axPath: `${name}-ax.json`, windowsPath: `${name}-windows.json`, screenshot: null, window: null }
}

function sqliteJobs(database) {
  if (!existsSync(database)) return []
  const sql = `SELECT j.print_job_id,j.idempotency_key,j.status,a.source_digest,j.attempt_count,j.native_job_id,
    j.native_receipt_id,j.printer_snapshot_json AS printer_snapshot,j.failure_kind,j.failure_detail,j.version
    FROM k12_generic_print_jobs j JOIN k12_print_artifacts a ON a.artifact_id=j.artifact_id
    ORDER BY j.prepared_at,j.print_job_id;`
  const output = execFileSync('sqlite3', ['-json', '-cmd', '.timeout 5000', database, sql], { encoding: 'utf8' })
  return JSON.parse(output || '[]')
}

function safeSQLiteJobs(database) {
  try { return sqliteJobs(database) } catch (error) {
    return [{ snapshot_error: error instanceof Error ? error.message : String(error) }]
  }
}

function coordinatorRecords(root) {
  const records = []
  function visit(path) {
    if (!existsSync(path)) return
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue
      const child = join(path, entry.name)
      if (entry.isDirectory()) visit(child)
      else if (entry.isFile() && entry.name.endsWith('.json') && child.includes('print-coordinator')) {
        const raw = readFileSync(child, 'utf8')
        records.push({ relativePath: relative(root, child), sha256: sha256(raw), value: JSON.parse(raw) })
      }
    }
  }
  visit(root)
  return records
}

function sourceIdentity() {
  const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  return {
    desktopHead: git(repoRoot, ['rev-parse', 'HEAD']),
    sidecarHead: git(sidecarRoot, ['rev-parse', 'HEAD']),
    node: process.version,
    rustc: execFileSync('rustc', ['--version'], { encoding: 'utf8' }).trim(),
    go: execFileSync('/usr/local/go/bin/go', ['version'], { encoding: 'utf8' }).trim(),
  }
}

async function main() {
  assert.equal(process.platform, 'darwin', 'macOS is required')
  assert.ok(existsSync(driverSource), 'print panel driver is missing')
  assert.ok(existsSync(join(sidecarRoot, 'cmd/hexclaw')), 'Sidecar source is missing')
  mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 })

  const sandbox = mkdtempSync(join(tmpdir(), 'hexclaw-bug014-print.'))
  chmodSync(sandbox, 0o700)
  const paths = {
    temp: join(sandbox, 'tmp'), drop: join(sandbox, 'drop-response'),
    childPID: join(sandbox, 'sidecar-real.pid'), log: join(sandbox, 'app.log'),
    database: join(sandbox, '.hexclaw/data.db'),
  }
  for (const path of [paths.temp, join(sandbox, '.hexclaw'), join(sandbox, 'Desktop'), join(sandbox, 'Documents')]) {
    mkdirSync(path, { recursive: true, mode: 0o700 }); chmodSync(path, 0o700)
  }
  const ports = { front: await reservePort(), backend: await reservePort() }
  assert.notEqual(ports.front, ports.backend)
  assert.deepEqual(listenerPIDs(ports.front), [])
  assert.deepEqual(listenerPIDs(ports.backend), [])

  const control = await startControlServer()
  const driverPath = join(sandbox, 'print-panel-driver')
  const cargoTarget = join(tmpdir(), 'hexclaw-bug014-cargo-target-cache')
  mkdirSync(cargoTarget, { recursive: true, mode: 0o700 })
  let app = null
  let appBundle = ''
  let appLogStream = null
  let failure = null
  let status = 'FAIL'
  const cleanup = { appPIDs: [], stoppedListeners: [], unexpectedListeners: [], portsReleased: false, controlClosed: false, sandboxRemoved: false, cargoTargetRemoved: false }
  const scenarios = {}

  const stopAppBoundary = async () => {
    await stopProcess(app)
    app = null
    if (appBundle) {
      const result = await stopOwnedListeners([ports.front, ports.backend], appBundle)
      cleanup.stoppedListeners.push(...result.stopped)
      cleanup.unexpectedListeners.push(...result.unexpected)
      assert.deepEqual(result.unexpected, [])
      assert.equal(result.released, true)
      const childResult = await stopOwnedPIDFile(paths.childPID, appBundle)
      cleanup.stoppedListeners.push(...childResult.stopped)
      cleanup.unexpectedListeners.push(...childResult.unexpected)
      assert.deepEqual(childResult.unexpected, [])
    }
  }

  const launchPhase = async (phase) => {
    control.setPhase(phase)
    const cursor = control.state.events.length
    app = launchApp(join(appBundle, 'Contents/MacOS/hexclaw-desktop'), sandbox, appEnvironment(sandbox, ports, paths), appLogStream)
    cleanup.appPIDs.push(app.pid)
    await waitHealth(ports.front, app)
    return { cursor, pid: app.pid }
  }

  try {
    await run('swiftc', [driverSource, '-o', driverPath])
    const preflight = driver(driverPath, 'preflight')
    assert.equal(preflight.accessibility, true, 'Accessibility permission is required')
    assert.equal(preflight.screenCapture, true, 'Screen capture permission is required')
    writeFileSync(join(evidenceRoot, 'preflight.json'), `${JSON.stringify(preflight, null, 2)}\n`, { mode: 0o600 })

    const frontend = await prepareFrontend(sandbox, control.origin)
    const overlay = writeOverlay(sandbox, frontend.output, ports, control.origin)
    writeFileSync(join(sandbox, '.hexclaw/hexclaw.yaml'), renderConfig(sandbox, ports.backend, control.origin), { mode: 0o600 })
    const buildEnv = {
      ...process.env,
      CARGO_NET_OFFLINE: 'true', CARGO_TARGET_DIR: cargoTarget,
      PNPM_CONFIG_OFFLINE: 'true', npm_config_offline: 'true',
      GOENV: 'off', GOPROXY: 'off', GOSUMDB: 'off', GOCACHE: join(sandbox, 'go-cache'),
    }
    delete buildEnv.GOROOT
    await run('pnpm', ['exec', 'tauri', 'build', '--config', overlay, '--bundles', 'app'], { env: buildEnv })
    appBundle = join(cargoTarget, `release/bundle/macos/${appName}.app`)
    const executable = join(appBundle, 'Contents/MacOS/hexclaw-desktop')
    const packagedSidecar = join(appBundle, 'Contents/MacOS/hexclaw')
    const realSidecar = join(appBundle, 'Contents/MacOS/hexclaw-real')
    assert.ok(existsSync(executable) && existsSync(packagedSidecar), 'Test.app bundle is incomplete')
    const identifier = execFileSync('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', join(appBundle, 'Contents/Info.plist')], { encoding: 'utf8' }).trim()
    assert.equal(identifier, bundleIdentifier)
    await run('/usr/local/go/bin/go', ['build', '-trimpath', '-o', realSidecar, './cmd/hexclaw'], { cwd: sidecarRoot, env: buildEnv })
    const proxyGo = join(sandbox, 'print-proxy.go')
    writeFileSync(proxyGo, proxySource(ports.backend, paths.drop, paths.childPID), { mode: 0o600 })
    await run('/usr/local/go/bin/go', ['build', '-trimpath', '-o', packagedSidecar, proxyGo], { env: buildEnv })
    chmodSync(packagedSidecar, 0o755); chmodSync(realSidecar, 0o755)
    appLogStream = createWriteStream(paths.log, { flags: 'wx', mode: 0o600 })

    // 真实取消 + events 响应丢失：Sidecar 已持久化，但 IPC 必须报错，重启后按同一 receipt 对账且不开第二个面板。
    const cancelPhase = { id: 'cancel-response-lost', action: 'new', idempotencyKey: `bug014-cancel-${randomUUID()}`, sourceRef: `bug014:cancel:${runID}`, title: 'BUG014 isolated cancel', body: 'Real AppKit cancellation boundary.' }
    let launched = await launchPhase(cancelPhase)
    const cancelBefore = await control.waitEvent(cancelPhase.id, 'beforeExecute', launched.cursor)
    const cancelJobID = cancelBefore.event.job.print_job_id
    await waitPrintPanel(driverPath, launched.pid)
    const cancelPanel = savePanelEvidence(driverPath, launched.pid, 'cancel-response-lost-panel')
    writeFileSync(paths.drop, 'events\n', { mode: 0o600 })
    const cancelAction = driver(driverPath, 'cancel-print-panel', launched.pid)
    const cancelError = await control.waitEvent(cancelPhase.id, 'executeError', cancelBefore.index + 1)
    assert.equal(cancelError.event.job.status, 'cancelled')
    assert.equal(existsSync(paths.drop), false, 'proxy did not consume the response-loss trigger')
    const recordAfterLoss = coordinatorRecords(sandbox).find((row) => row.value.operation_id === cancelJobID)
    assert.equal(recordAfterLoss?.value.receipt?.status, 'cancelled')
    await stopAppBoundary()

    const reconcileCancel = { id: 'cancel-reconcile-after-restart', action: 'reconcile', jobID: cancelJobID }
    launched = await launchPhase(reconcileCancel)
    const reconcileBefore = await control.waitEvent(reconcileCancel.id, 'beforeExecute', launched.cursor)
    const reconcileResult = await control.waitEvent(reconcileCancel.id, 'executeResult', reconcileBefore.index + 1)
    assert.equal(reconcileResult.event.result.receipt.status, 'cancelled')
    assert.equal(reconcileResult.event.job.status, 'cancelled')
    assert.equal(hasPrintPanel(driverPath, launched.pid), false, 'receipt reconciliation opened a second panel')
    assert.equal(reconcileResult.event.result.receipt.native_job_id, recordAfterLoss.value.receipt.native_job_id)
    scenarios.cancelResponseLost = {
      status: 'PASS', jobID: cancelJobID, appPIDs: [cleanup.appPIDs[0], launched.pid],
      action: cancelAction, panel: cancelPanel, firstIPC: 'response lost after durable Sidecar event',
      durableAfterLoss: cancelError.event.job, reconciled: reconcileResult.event,
      sameNativeJobID: true, secondPanelOpened: false,
    }
    await stopAppBoundary()

    // 已取消任务重启后显式 retry：attempt+1，只出现一个新面板，可再次安全取消。
    const retryCancel = { id: 'cancel-retry-after-restart', action: 'retry', jobID: cancelJobID }
    launched = await launchPhase(retryCancel)
    const retryBefore = await control.waitEvent(retryCancel.id, 'beforeExecute', launched.cursor)
    assert.equal(retryBefore.event.job.attempt_count, 2)
    await waitPrintPanel(driverPath, launched.pid)
    const retryPanel = savePanelEvidence(driverPath, launched.pid, 'cancel-retry-panel')
    const retryAction = driver(driverPath, 'cancel-print-panel', launched.pid)
    const retryResult = await control.waitEvent(retryCancel.id, 'executeResult', retryBefore.index + 1)
    assert.equal(retryResult.event.result.receipt.status, 'cancelled')
    assert.equal(retryResult.event.job.status, 'cancelled')
    assert.equal(retryResult.event.job.attempt_count, 2)
    scenarios.cancelRetry = { status: 'PASS', jobID: cancelJobID, attemptCount: 2, action: retryAction, panel: retryPanel, receipt: retryResult.event.result.receipt }
    await stopAppBoundary()

    // 面板已打开但进程终止：不点击任何确认控件；重启必须收敛 outcome_unknown 且禁止自动重开。
    const unknownPhase = { id: 'dialog-interrupted', action: 'new', idempotencyKey: `bug014-unknown-${randomUUID()}`, sourceRef: `bug014:unknown:${runID}`, title: 'BUG014 isolated interrupted dialog', body: 'Crash after real dialog boundary; no physical output.' }
    launched = await launchPhase(unknownPhase)
    const unknownBefore = await control.waitEvent(unknownPhase.id, 'beforeExecute', launched.cursor)
    const unknownJobID = unknownBefore.event.job.print_job_id
    await waitPrintPanel(driverPath, launched.pid)
    const unknownPanel = savePanelEvidence(driverPath, launched.pid, 'outcome-unknown-before-interruption')
    const interruptedPID = launched.pid
    await stopAppBoundary()
    const reconcileUnknown = { id: 'outcome-unknown-after-restart', action: 'reconcile', jobID: unknownJobID }
    launched = await launchPhase(reconcileUnknown)
    const unknownReconcileBefore = await control.waitEvent(reconcileUnknown.id, 'beforeExecute', launched.cursor)
    const unknownResult = await control.waitEvent(reconcileUnknown.id, 'executeResult', unknownReconcileBefore.index + 1)
    assert.equal(unknownResult.event.result.receipt.status, 'outcome_unknown')
    assert.equal(unknownResult.event.job.status, 'outcome_unknown')
    assert.equal(hasPrintPanel(driverPath, launched.pid), false, 'ambiguous outcome was automatically reprinted')
    assert.match(unknownResult.event.result.receipt.failure_detail, /automatic reprint is forbidden/)
    scenarios.outcomeUnknown = {
      status: 'PASS', jobID: unknownJobID, interruptedAppPID: interruptedPID,
      restartedAppPID: launched.pid, panel: unknownPanel, physicalConfirmationAction: 'none',
      receipt: unknownResult.event.result.receipt, projectedJob: unknownResult.event.job,
      automaticSecondPanel: false, ordinaryRetryAllowed: false,
    }
    await stopAppBoundary()

    // 无副作用成功腿：仅尝试 PDF 菜单；任何 AX 差异都安全取消并标记物理成功边界待人工授权。
    const virtualPhase = { id: 'virtual-pdf-attempt', action: 'new', idempotencyKey: `bug014-pdf-${randomUUID()}`, sourceRef: `bug014:pdf:${runID}`, title: 'BUG014 isolated virtual PDF', body: 'Save-as-PDF only; physical Print is forbidden.' }
    launched = await launchPhase(virtualPhase)
    const virtualBefore = await control.waitEvent(virtualPhase.id, 'beforeExecute', launched.cursor)
    await waitPrintPanel(driverPath, launched.pid)
    const virtualPanel = savePanelEvidence(driverPath, launched.pid, 'virtual-pdf-print-panel')
    let virtualOutcome
    try {
      const openMenu = driver(driverPath, 'open-pdf-menu', launched.pid)
      await sleep(300)
      writeFileSync(join(evidenceRoot, 'virtual-pdf-menu-ax.json'), evidenceJSON(driver(driverPath, 'ax', launched.pid)), { mode: 0o600 })
      const choose = driver(driverPath, 'choose-save-as-pdf', launched.pid)
      await sleep(500)
      const saveAX = driver(driverPath, 'ax', launched.pid)
      writeFileSync(join(evidenceRoot, 'virtual-pdf-save-panel-ax.json'), evidenceJSON(saveAX), { mode: 0o600 })
      // NSSavePanel 不可靠地继承 HOME；先通过真实“位置”菜单显式选中本轮 0700 sandbox，
      // 再允许设置叶文件名，防止测试产物落入真实用户 Documents/Desktop。
      const sandboxLeaf = sandbox.split('/').filter(Boolean).at(-1)
      let selectedLocationAX = driver(driverPath, 'ax', launched.pid)
      let safeDirectory = null
      const locationRowsBeforeSelection = selectedLocationAX.filter((row) => row.role === 'AXPopUpButton')
      const alreadySandboxed = locationRowsBeforeSelection.some((row) => [row.title, row.description, row.value].some((value) => typeof value === 'string' && value.includes(sandboxLeaf)))
      if (!alreadySandboxed) {
        safeDirectory = driverWithArg(driverPath, 'select-safe-directory', launched.pid, sandbox)
        await sleep(500)
        selectedLocationAX = driver(driverPath, 'ax', launched.pid)
      }
      writeFileSync(join(evidenceRoot, 'virtual-pdf-selected-location-ax.json'), evidenceJSON(selectedLocationAX), { mode: 0o600 })
      const locationRows = selectedLocationAX.filter((row) => row.role === 'AXPopUpButton')
      assert.ok(locationRows.some((row) => [row.title, row.description, row.value].some((value) => typeof value === 'string' && value.includes(sandboxLeaf))), 'Save location did not switch to the isolated sandbox')
      const setName = driverWithArg(driverPath, 'set-safe-pdf-name', launched.pid, 'bug014-virtual-output.pdf')
      writeFileSync(paths.drop, 'commit\n', { mode: 0o600 })
      const confirmSave = driver(driverPath, 'confirm-save-pdf', launched.pid)
      const terminal = await Promise.race([
        control.waitEvent(virtualPhase.id, 'executeResult', virtualBefore.index + 1).then((value) => ({ type: 'result', value })),
        control.waitEvent(virtualPhase.id, 'executeError', virtualBefore.index + 1).then((value) => ({ type: 'error', value })),
      ])
      const pdfCandidates = []
      const pdfFolders = [sandbox, join(sandbox, 'Desktop'), join(sandbox, 'Documents'), join(sandbox, 'Downloads')]
      const pdfDeadline = Date.now() + 5_000
      while (Date.now() < pdfDeadline && pdfCandidates.length === 0) {
        for (const folder of pdfFolders) {
          if (!existsSync(folder)) continue
          for (const name of readdirSync(folder)) if (name === 'bug014-virtual-output.pdf') pdfCandidates.push(join(folder, name))
        }
        if (pdfCandidates.length === 0) await sleep(100)
      }
      const receipt = terminal.value.event.result?.receipt || coordinatorRecords(sandbox).find((row) => row.value.operation_id === virtualBefore.event.job.print_job_id)?.value.receipt
      if (receipt?.status === 'printed' && pdfCandidates.length === 1) {
        const outputEvidence = join(evidenceRoot, 'bug014-virtual-output.pdf')
        copyFileSync(pdfCandidates[0], outputEvidence)
        assert.match(readFileSync(outputEvidence, 'utf8').slice(0, 8), /^%PDF-/)
        virtualOutcome = {
          status: 'PASS', mode: 'Save as PDF', physicalPrinterSelected: false,
          panel: virtualPanel, openMenu, choose, safeDirectory, setName, confirmSave,
          savedPDF: 'bug014-virtual-output.pdf', savedPDFSha256: sha256File(outputEvidence),
          receipt, responseLost: terminal.type === 'error', terminal: terminal.value.event,
        }
      } else {
        rmSync(paths.drop, { force: true })
        virtualOutcome = {
          status: 'NOT_APPLICABLE_AS_PRINT_SUCCESS', mode: 'Save as PDF',
          reason: `AppKit returned ${receipt?.status || 'no receipt'}; Save as PDF is not evidence of a physical printed receipt`,
          physicalPrinterSelected: false, panel: virtualPanel, openMenu, choose, safeDirectory, setName, confirmSave,
          terminal: terminal.value.event, pdfCandidates: pdfCandidates.map((path) => relative(sandbox, path)),
        }
      }
    } catch (error) {
      rmSync(paths.drop, { force: true })
      let cancelled = null
      if (hasPrintPanel(driverPath, launched.pid)) {
        cancelled = driver(driverPath, 'cancel-print-panel', launched.pid)
        await Promise.race([
          control.waitEvent(virtualPhase.id, 'executeResult', virtualBefore.index + 1),
          control.waitEvent(virtualPhase.id, 'executeError', virtualBefore.index + 1),
        ]).catch(() => null)
      }
      virtualOutcome = {
        status: 'UNAVAILABLE_SAFE_ONLY', mode: 'Save as PDF', physicalPrinterSelected: false,
        reason: error instanceof Error ? error.message : String(error), safeFallback: cancelled ? 'cancelled' : 'no action',
        panel: virtualPanel,
      }
    }
    scenarios.virtualSuccess = virtualOutcome
    await stopAppBoundary()

    assert.deepEqual(control.state.protocolErrors, [])
    assert.deepEqual(control.state.unexpected, [])
    const jobs = sqliteJobs(paths.database)
    assert.equal(jobs.filter((job) => job.print_job_id === cancelJobID).length, 1)
    assert.equal(jobs.find((job) => job.print_job_id === unknownJobID)?.status, 'outcome_unknown')
    const evidence = {
      status: 'PASS',
      bugs: ['BUG-20260802-014', 'BUG-20260723-026'],
      acceptance: ['DESKTOP-BOUNDARY-PRINT-003', 'DESKTOP-BOUNDARY-PRINT-005'],
      source: sourceIdentity(),
      isolation: {
        bundleIdentifier, productName: appName, homeMode: '0700', configMode: '0600',
        installedToApplications: false, applicationsTouched: false, realUserHomeReadOrWritten: false,
        binding: '127.0.0.1', ports, externalNetwork: false,
      },
      safety: {
        physicalPrintButtonActionExistsInDriver: false,
        allowedActions: ['Cancel', 'Save as PDF'], physicalPrinterOutputAttempted: false,
        physicalPrinterOutput: 'OUT_OF_SCOPE/FORBIDDEN',
        virtualSuccessResult: virtualOutcome.status,
      },
      build: {
        appExecutableSha256: sha256File(executable), sidecarRealSha256: sha256File(realSidecar),
        proxySha256: sha256File(packagedSidecar), frontendSha256: sha256File(frontend.index),
      },
      scenarios,
      coordinatorRecords: coordinatorRecords(sandbox),
      durableJobs: jobs,
      controlEvents: control.state.events,
      localWarmupRequests: control.state.localWarmupRequests,
      remainingBoundary: 'NONE_WITHIN_APPROVED_SCOPE',
    }
    writeFileSync(join(evidenceRoot, 'report.json'), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 })
    writeFileSync(join(evidenceBase, 'latest.json'), `${JSON.stringify({ runID, report: relative(evidenceBase, join(evidenceRoot, 'report.json')), status: evidence.status }, null, 2)}\n`, { mode: 0o600 })
    status = evidence.status
    process.stdout.write(`BUG-20260802-014 / BUG-20260723-026 native print boundary: ${status}\n${join(evidenceRoot, 'report.json')}\n`)
  } catch (error) {
    failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    writeFileSync(join(evidenceRoot, 'failure.json'), `${JSON.stringify({ status: 'FAIL', error: failure, scenarios, events: control.state.events, jobs: safeSQLiteJobs(paths.database), coordinatorRecords: coordinatorRecords(sandbox) }, null, 2)}\n`, { mode: 0o600 })
    throw error
  } finally {
    await stopProcess(app)
    if (appBundle) {
      const listenerCleanup = await stopOwnedListeners([ports.front, ports.backend], appBundle)
      cleanup.stoppedListeners.push(...listenerCleanup.stopped)
      cleanup.unexpectedListeners.push(...listenerCleanup.unexpected)
      cleanup.portsReleased = listenerCleanup.released
      const childCleanup = await stopOwnedPIDFile(paths.childPID, appBundle)
      cleanup.stoppedListeners.push(...childCleanup.stopped)
      cleanup.unexpectedListeners.push(...childCleanup.unexpected)
    } else cleanup.portsReleased = [ports.front, ports.backend].every((port) => listenerPIDs(port).length === 0)
    if (appLogStream) await new Promise((resolvePromise) => appLogStream.end(resolvePromise))
    await control.close(); cleanup.controlClosed = true
    if (existsSync(paths.log)) {
      const sanitized = readFileSync(paths.log, 'utf8')
        .replaceAll(repoRoot, '<desktop-repo>')
        .replaceAll(sidecarRoot, '<sidecar-repo>')
        .replaceAll(sandbox, '<sandbox>')
        .replaceAll(process.env.HOME || '<home>', '<user-home>')
        .replaceAll('isolated-test-only', '[REDACTED]')
      writeFileSync(join(evidenceRoot, 'app.log'), sanitized, { mode: 0o600 })
    }
    rmSync(sandbox, { recursive: true, force: true })
    cleanup.sandboxRemoved = !existsSync(sandbox)
    if (status.startsWith('PASS')) rmSync(cargoTarget, { recursive: true, force: true })
    cleanup.cargoTargetRemoved = !existsSync(cargoTarget)
    writeFileSync(join(evidenceRoot, 'cleanup.json'), `${JSON.stringify({ status, error: failure, ...cleanup }, null, 2)}\n`, { mode: 0o600 })
    assert.equal(cleanup.portsReleased, true, 'dedicated ports were not released')
    assert.deepEqual(cleanup.unexpectedListeners, [], 'unexpected listener owner detected')
    assert.equal(cleanup.sandboxRemoved, true, 'sandbox was not removed')
    if (status.startsWith('PASS')) assert.equal(cleanup.cargoTargetRemoved, true, 'cargo target cache was not removed')
  }
}

function validate() {
  const driverText = readFileSync(driverSource, 'utf8')
  assert.match(driverText, /case "cancel-print-panel"/)
  assert.match(driverText, /case "choose-save-as-pdf"/)
  assert.doesNotMatch(driverText, /case "(?:confirm-)?print"/i)
  assert.doesNotMatch(driverText, /exact: \["Print", "打印"\]/)
  assert.match(proxySource(12346, '/tmp/drop', '/tmp/pid'), /dropped-response/)
  assert.match(fixtureSource('http:\/\/127.0.0.1:12345'), /execute_print_job/)
  process.stdout.write('BUG-20260802-014 macOS print harness validation PASS\n')
}

if (process.argv.includes('--validate')) validate()
else main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`)
  process.exitCode = 1
})
