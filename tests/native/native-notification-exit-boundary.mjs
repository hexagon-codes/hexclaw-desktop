import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const TEST_SIDECAR_PORT = Number.parseInt(
  process.env.HEX_NATIVE_NOTIFICATION_SIDECAR_PORT || '16061',
  10,
)
const TEST_API_TOKEN = 'hexclaw-native-notification-boundary-0123456789abcdef'
const BUSINESS_TITLE = 'NATIVE_BOUNDARY_BUSINESS_EVENT'
const BUSINESS_BODY = 'This business event must remain inside HexClaw.'
const LIFECYCLE_TITLE = 'HexClaw 仍在后台运行'
const LIFECYCLE_BODY = '2 秒内再次按 Cmd+Q 退出 HexClaw。'
const PRODUCTION_BUNDLE_ID = 'com.hexclaw.desktop'
const STABLE_MOCK_BUNDLE_ID = 'com.hexclaw.desktop.mock'

const currentFile = fileURLToPath(import.meta.url)
const repoRoot = resolve(dirname(currentFile), '../..')
const defaultAppBundle = join(repoRoot, 'src-tauri/target/release/bundle/macos/HexClaw Test.app')
const notificationDatabase = join(
  homedir(),
  'Library/Group Containers/group.com.apple.usernoted/db2/db',
)
const notificationPreferences = join(homedir(), 'Library/Preferences/com.apple.ncprefs.plist')

function fail(message) {
  throw new Error(message)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: options.encoding ?? 'utf8',
    input: options.input,
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result.status !== 0) {
    fail(
      `${command} ${args.join(' ')} failed (${result.status}): ${String(result.stderr || result.stdout || '').trim()}`,
    )
  }
  return result.stdout
}

function fileSha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function textSha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function plutilValue(infoPlist, key) {
  return String(run('plutil', ['-extract', key, 'raw', '-o', '-', infoPlist])).trim()
}

function listenerPIDs(port) {
  const result = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
    encoding: 'utf8',
  })
  if (result.status !== 0 && result.status !== 1) {
    fail(`lsof failed for port ${port}: ${result.stderr || result.stdout}`)
  }
  return String(result.stdout || '')
    .split(/\s+/)
    .filter(Boolean)
    .map(Number)
}

function processCommand(pid) {
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' })
  return result.status === 0 ? String(result.stdout || '').trim() : ''
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}

async function waitFor(predicate, timeoutMs, description, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return
    } catch (error) {
      lastError = error
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, intervalMs))
  }
  fail(`${description} timed out${lastError ? `: ${lastError.message}` : ''}`)
}

async function waitForHealth(appProcess, appTail) {
  await waitFor(
    async () => {
      if (appProcess.exitCode !== null) {
        fail(`HexClaw Test exited before health readiness\n${appTail()}`)
      }
      const response = await fetch(`http://127.0.0.1:${TEST_SIDECAR_PORT}/health`, {
        signal: AbortSignal.timeout(1000),
      })
      return response.ok
    },
    90_000,
    'Test.app Sidecar health readiness',
    250,
  )
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  const exited = await Promise.race([
    new Promise((resolveExit) => child.once('exit', () => resolveExit(true))),
    new Promise((resolveExit) => setTimeout(() => resolveExit(false), 5000)),
  ])
  if (!exited && child.exitCode === null) child.kill('SIGKILL')
}

async function stopOwnedSidecar(appBundle) {
  for (const pid of listenerPIDs(TEST_SIDECAR_PORT)) {
    const command = processCommand(pid)
    if (
      command.includes(`${appBundle}/Contents/MacOS/hexclaw`) &&
      command.includes('serve --desktop')
    ) {
      try {
        process.kill(pid, 'SIGTERM')
      } catch (error) {
        if (error.code !== 'ESRCH') throw error
      }
    }
  }
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

function notificationRecords(bundleIdentifier, includeData = false) {
  assert.match(bundleIdentifier, /^[a-zA-Z0-9.-]+$/)
  const dataColumn = includeData ? ', lower(hex(r.data)) AS data_hex' : ''
  const query = `
    SELECT r.rec_id,
           lower(hex(r.uuid)) AS uuid,
           r.request_date,
           r.request_last_date,
           r.delivered_date,
           r.presented,
           r.style
           ${dataColumn}
      FROM record r
      JOIN app a ON a.app_id = r.app_id
     WHERE a.identifier = ${sqlString(bundleIdentifier)}
     ORDER BY r.rec_id;
  `
  const result = spawnSync('sqlite3', ['-readonly', '-json', notificationDatabase, query], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result.status !== 0) {
    fail(`read-only usernoted query failed: ${result.stderr || result.stdout}`)
  }
  const output = String(result.stdout || '').trim()
  return output ? JSON.parse(output) : []
}

function notificationAppRow(bundleIdentifier) {
  assert.match(bundleIdentifier, /^[a-zA-Z0-9.-]+$/)
  const query = `
    SELECT app_id, identifier, badge
      FROM app
     WHERE identifier = ${sqlString(bundleIdentifier)};
  `
  const result = spawnSync('sqlite3', ['-readonly', '-json', notificationDatabase, query], {
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    fail(`read-only usernoted app query failed: ${result.stderr || result.stdout}`)
  }
  const output = String(result.stdout || '').trim()
  return output ? JSON.parse(output)[0] || null : null
}

function ncprefsEntry(bundleIdentifier) {
  if (!existsSync(notificationPreferences)) return null
  const pretty = String(run('plutil', ['-p', notificationPreferences]))
  let currentIndex = null
  let matchedIndex = null
  for (const line of pretty.split('\n')) {
    const indexMatch = line.match(/^\s*(\d+) => \{$/)
    if (indexMatch) currentIndex = Number.parseInt(indexMatch[1], 10)
    if (line.includes(`"bundle-id" => "${bundleIdentifier}"`)) {
      matchedIndex = currentIndex
      break
    }
  }
  if (matchedIndex === null) return null
  const xml = String(
    run('plutil', ['-extract', `apps.${matchedIndex}`, 'xml1', '-o', '-', notificationPreferences]),
  )
  const authMatch = xml.match(/<key>auth<\/key>\s*<integer>(\d+)<\/integer>/)
  return {
    index: matchedIndex,
    auth: authMatch ? Number.parseInt(authMatch[1], 10) : null,
    sha256: textSha256(xml),
  }
}

function captureOsState(uniqueBundleIdentifier, includeUniqueData = false) {
  return {
    capturedAt: new Date().toISOString(),
    production: {
      app: notificationAppRow(PRODUCTION_BUNDLE_ID),
      records: notificationRecords(PRODUCTION_BUNDLE_ID).length,
      preferences: ncprefsEntry(PRODUCTION_BUNDLE_ID),
    },
    stableMock: {
      app: notificationAppRow(STABLE_MOCK_BUNDLE_ID),
      records: notificationRecords(STABLE_MOCK_BUNDLE_ID).length,
      preferences: ncprefsEntry(STABLE_MOCK_BUNDLE_ID),
    },
    uniqueMock: {
      app: notificationAppRow(uniqueBundleIdentifier),
      records: notificationRecords(uniqueBundleIdentifier, includeUniqueData),
      preferences: ncprefsEntry(uniqueBundleIdentifier),
    },
  }
}

function assertProtectedOsStateUnchanged(before, after) {
  const stableProjection = (state) => ({
    app: state.app,
    records: state.records,
    preferences: state.preferences
      ? { auth: state.preferences.auth, sha256: state.preferences.sha256 }
      : null,
  })
  assert.deepEqual(
    stableProjection(after.production),
    stableProjection(before.production),
    'production bundle notification records/preferences must remain unchanged',
  )
  assert.deepEqual(
    stableProjection(after.stableMock),
    stableProjection(before.stableMock),
    'stable mock bundle notification records/preferences must remain unchanged',
  )
}

function preferenceIdentity(state) {
  return state ? { auth: state.auth, sha256: state.sha256 } : null
}

function decodeNotificationData(dataHex) {
  const buffer = Buffer.from(dataHex, 'hex')
  const result = spawnSync('plutil', ['-p', '-'], {
    input: buffer,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  })
  if (result.status !== 0) {
    return {
      decoded: false,
      sha256: createHash('sha256').update(buffer).digest('hex'),
      error: String(result.stderr || result.stdout || '').trim(),
    }
  }
  const output = String(result.stdout || '')
  return {
    decoded: true,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    containsLifecycleTitle: output.includes(LIFECYCLE_TITLE),
    containsLifecycleBody: output.includes(LIFECYCLE_BODY),
    output,
  }
}

function renderConfig(sandbox) {
  const configPath = join(sandbox, '.hexclaw/hexclaw.yaml')
  const databasePath = join(sandbox, '.hexclaw/data.db')
  return {
    configPath,
    content: `server:
  host: 127.0.0.1
  port: ${TEST_SIDECAR_PORT}
  mode: development
  api_token: ${JSON.stringify(TEST_API_TOKEN)}
platforms:
  web:
    enabled: true
llm:
  default: notification-boundary-mock
  providers:
    notification-boundary-mock:
      api_key: local-synthetic-credential
      base_url: http://127.0.0.1:9/v1
      model: unused-model
      models:
        - unused-model
      compatible: openai
      locality: local
      tools_enabled: false
      enabled: true
  routing:
    enabled: false
  cache:
    enabled: false
  tools:
    enabled: off
storage:
  driver: sqlite
  sqlite:
    path: ${JSON.stringify(databasePath)}
knowledge:
  enabled: false
  embedding:
    disable_auto_install: true
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
observe:
  log_level: info
  metrics:
    enabled: false
`,
  }
}

function copyUniqueApp(sourceBundle, sandbox, uniqueBundleIdentifier) {
  const copiedBundle = join(sandbox, 'HexClaw Native Notification Test.app')
  const copy = spawnSync('cp', ['-cR', sourceBundle, copiedBundle], { encoding: 'utf8' })
  if (copy.status !== 0) {
    run('ditto', [sourceBundle, copiedBundle])
  }
  const copiedInfoPlist = join(copiedBundle, 'Contents/Info.plist')
  run('plutil', [
    '-replace',
    'CFBundleIdentifier',
    '-string',
    uniqueBundleIdentifier,
    copiedInfoPlist,
  ])
  assert.equal(plutilValue(copiedInfoPlist, 'CFBundleIdentifier'), uniqueBundleIdentifier)
  return copiedBundle
}

async function postBusinessNotification() {
  const response = await fetch(
    `http://127.0.0.1:${TEST_SIDECAR_PORT}/api/v1/desktop/notifications`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_API_TOKEN}`,
        'Content-Type': 'application/json',
        Origin: 'tauri://localhost',
      },
      body: JSON.stringify({ title: BUSINESS_TITLE, body: BUSINESS_BODY, type: 'error' }),
      signal: AbortSignal.timeout(5000),
    },
  )
  const body = await response.text()
  assert.equal(response.status, 200, `business notification POST failed: ${body}`)

  const listResponse = await fetch(
    `http://127.0.0.1:${TEST_SIDECAR_PORT}/api/v1/desktop/notifications`,
    {
      headers: { Authorization: `Bearer ${TEST_API_TOKEN}`, Origin: 'tauri://localhost' },
      signal: AbortSignal.timeout(5000),
    },
  )
  const listBody = await listResponse.json()
  assert.equal(listResponse.status, 200)
  const notifications = Array.isArray(listBody.notifications) ? listBody.notifications : []
  assert.ok(
    notifications.some(
      (item) =>
        item.title === BUSINESS_TITLE && item.body === BUSINESS_BODY && item.type === 'error',
    ),
    'business event must be present in the Desktop notification queue',
  )
  return { postStatus: response.status, listStatus: listResponse.status, notifications }
}

async function runInstalledBoundary() {
  assert.equal(process.platform, 'darwin', 'native notification exit boundary is macOS-only')
  assert.ok(
    existsSync(notificationDatabase),
    `usernoted database is missing: ${notificationDatabase}`,
  )
  assert.ok(
    Number.isInteger(TEST_SIDECAR_PORT) && TEST_SIDECAR_PORT >= 1024 && TEST_SIDECAR_PORT <= 65535,
    'test Sidecar port must be an unprivileged TCP port',
  )
  assert.notEqual(TEST_SIDECAR_PORT, 16060, 'production Sidecar port is forbidden')
  assert.deepEqual(listenerPIDs(TEST_SIDECAR_PORT), [], `port ${TEST_SIDECAR_PORT} is occupied`)

  const sourceBundle = resolve(process.env.HEX_NATIVE_APP_BUNDLE || defaultAppBundle)
  const sourceInfoPlist = join(sourceBundle, 'Contents/Info.plist')
  assert.ok(existsSync(sourceInfoPlist), `Test.app bundle is missing: ${sourceBundle}`)
  assert.equal(plutilValue(sourceInfoPlist, 'CFBundleIdentifier'), STABLE_MOCK_BUNDLE_ID)
  const sourceExecutable = join(
    sourceBundle,
    'Contents/MacOS',
    plutilValue(sourceInfoPlist, 'CFBundleExecutable'),
  )
  const sourceSidecar = join(sourceBundle, 'Contents/MacOS/hexclaw')
  assert.ok(existsSync(sourceExecutable), `Test.app executable is missing: ${sourceExecutable}`)
  assert.ok(existsSync(sourceSidecar), `Test.app Sidecar is missing: ${sourceSidecar}`)
  const sourceExecutableBytes = readFileSync(sourceExecutable)
  assert.ok(
    sourceExecutableBytes.includes(Buffer.from(LIFECYCLE_BODY)),
    'candidate Test.app does not contain the approved lifecycle notification body',
  )

  const runId = `run-${Date.now()}-${process.pid}`
  const uniqueBundleIdentifier =
    process.env.HEX_NATIVE_NOTIFICATION_BUNDLE_ID ||
    `com.hexclaw.desktop.mock.nativeexit.run${Date.now()}.p${process.pid}`
  assert.match(uniqueBundleIdentifier, /^[a-zA-Z0-9.-]+$/)
  const reuseAuthorizedBundleIdentity = Boolean(process.env.HEX_NATIVE_NOTIFICATION_BUNDLE_ID)
  const artifactDir = resolve(
    process.env.HEX_NATIVE_NOTIFICATION_ARTIFACT_DIR ||
      join(repoRoot, 'test-results/native-notification-exit-boundary', runId),
  )
  mkdirSync(artifactDir, { recursive: true })

  const sandbox = mkdtempSync(join(tmpdir(), 'hexclaw-native-notification-exit-'))
  chmodSync(sandbox, 0o700)
  mkdirSync(join(sandbox, '.hexclaw'), { mode: 0o700 })
  mkdirSync(join(sandbox, 'tmp'), { mode: 0o700 })
  const rendered = renderConfig(sandbox)
  writeFileSync(rendered.configPath, rendered.content, { encoding: 'utf8', mode: 0o600 })
  chmodSync(rendered.configPath, 0o600)
  const copiedBundle = copyUniqueApp(sourceBundle, sandbox, uniqueBundleIdentifier)
  const copiedInfoPlist = join(copiedBundle, 'Contents/Info.plist')
  const copiedExecutable = join(
    copiedBundle,
    'Contents/MacOS',
    plutilValue(copiedInfoPlist, 'CFBundleExecutable'),
  )
  const copiedSidecar = join(copiedBundle, 'Contents/MacOS/hexclaw')
  assert.equal(fileSha256(copiedExecutable), fileSha256(sourceExecutable))
  assert.equal(fileSha256(copiedSidecar), fileSha256(sourceSidecar))
  const quitHarnessDir = join(sandbox, '.hexclaw/native-quit-harness')

  const summary = {
    acceptance: ['REG-NOTIFICATION-NATIVE-EXIT-BOUNDARY-001'],
    runId,
    status: 'running',
    uniqueBundleIdentifier,
    sourceBundle,
    bundleVersion: plutilValue(sourceInfoPlist, 'CFBundleShortVersionString'),
    sourceAppExecutableSha256: fileSha256(sourceExecutable),
    copiedAppExecutableSha256: fileSha256(copiedExecutable),
    sourceSidecarSha256: fileSha256(sourceSidecar),
    copiedSidecarSha256: fileSha256(copiedSidecar),
    lifecycleTitle: LIFECYCLE_TITLE,
    lifecycleBody: LIFECYCLE_BODY,
    productionBundlePreferenceModified: null,
    stableMockBundlePreferenceModified: null,
    businessNativeNotificationDelta: null,
    lifecycleNativeNotificationDelta: null,
    firstTerminateProcessAlive: null,
    secondTerminateExited: null,
    permissionBlocker: null,
    nativeMenuClickProven: false,
    testHarnessDispatcherProven: false,
    sameDispatcherSourceContract: 'src-tauri/tests/bug_20260726_033_lifecycle_contract.rs',
  }

  let appProcess
  let appLogStream
  let appTail = ''
  let completed = false
  try {
    assert.equal(statSync(sandbox).mode & 0o777, 0o700)
    assert.equal(statSync(dirname(rendered.configPath)).mode & 0o777, 0o700)
    assert.equal(statSync(rendered.configPath).mode & 0o777, 0o600)

    const before = captureOsState(uniqueBundleIdentifier)
    writeFileSync(join(artifactDir, 'os-before.json'), `${JSON.stringify(before, null, 2)}\n`)
    summary.uniqueBundleBaselineRecords = before.uniqueMock.records.length
    summary.productionBundlePreferenceBefore = preferenceIdentity(before.production.preferences)
    summary.stableMockBundlePreferenceBefore = preferenceIdentity(before.stableMock.preferences)
    if (!reuseAuthorizedBundleIdentity) {
      assert.equal(
        before.uniqueMock.records.length,
        0,
        'unique mock bundle must start with zero records',
      )
      assert.equal(
        before.uniqueMock.preferences,
        null,
        'unique mock bundle must start without preferences',
      )
    }

    appLogStream = createWriteStream(join(artifactDir, 'app.log'), { flags: 'w' })
    appProcess = spawn(copiedExecutable, [], {
      cwd: copiedBundle,
      env: {
        PATH: process.env.PATH || '',
        LANG: process.env.LANG || 'C.UTF-8',
        HOME: sandbox,
        USERPROFILE: sandbox,
        CFFIXED_USER_HOME: sandbox,
        TMPDIR: join(sandbox, 'tmp'),
        TEMP: join(sandbox, 'tmp'),
        TMP: join(sandbox, 'tmp'),
        HEXCLAW_TEST_MODE: '1',
        HEXCLAW_TEST_HOME: sandbox,
        HEXCLAW_SIDECAR_PORT: String(TEST_SIDECAR_PORT),
        HEXCLAW_TEST_LLM_CONFIG_MODE: 'preseeded-owner-yaml',
        HEXCLAW_NATIVE_QUIT_TEST_HARNESS: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const capture = (chunk) => {
      appLogStream.write(chunk)
      appTail = `${appTail}${chunk.toString()}`.slice(-24_000)
    }
    appProcess.stdout.on('data', capture)
    appProcess.stderr.on('data', capture)

    await waitForHealth(appProcess, () => appTail)
    const business = await postBusinessNotification()
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 750))
    const afterBusiness = captureOsState(uniqueBundleIdentifier)
    writeFileSync(
      join(artifactDir, 'os-after-business.json'),
      `${JSON.stringify(afterBusiness, null, 2)}\n`,
    )
    assertProtectedOsStateUnchanged(before, afterBusiness)
    summary.businessNativeNotificationDelta =
      afterBusiness.uniqueMock.records.length - before.uniqueMock.records.length
    assert.equal(
      summary.businessNativeNotificationDelta,
      0,
      'business event must create zero native notification records',
    )
    writeFileSync(join(artifactDir, 'business-api.json'), `${JSON.stringify(business, null, 2)}\n`)

    const firstTerminateAt = Date.now()
    writeFileSync(join(quitHarnessDir, 'request-1'), 'request\n', { encoding: 'utf8', mode: 0o600 })
    await waitFor(
      () => existsSync(join(quitHarnessDir, 'ack-1')),
      5000,
      'first in-process menu dispatcher acknowledgement',
      25,
    )
    summary.firstTerminateRequest = 'test-only in-process system_quit menu dispatcher'
    summary.testHarnessDispatcherProven = true
    summary.firstTerminateProcessAlive = processIsAlive(appProcess.pid)
    assert.equal(
      summary.firstTerminateProcessAlive,
      true,
      'first native terminate request must keep Test.app alive',
    )
    const healthAfterFirst = await fetch(`http://127.0.0.1:${TEST_SIDECAR_PORT}/health`, {
      signal: AbortSignal.timeout(1000),
    })
    assert.equal(
      healthAfterFirst.ok,
      true,
      'Sidecar must remain healthy after first terminate request',
    )
    summary.sidecarHealthyAfterFirstTerminate = true

    const secondTerminateAt = Date.now()
    assert.ok(
      secondTerminateAt - firstTerminateAt < 2000,
      'second terminate request must occur inside the two-second window',
    )
    writeFileSync(join(quitHarnessDir, 'request-2'), 'request\n', { encoding: 'utf8', mode: 0o600 })
    summary.secondTerminateRequest = 'test-only in-process system_quit menu dispatcher'
    summary.terminateRequestIntervalMs = secondTerminateAt - firstTerminateAt
    await waitFor(
      () => appProcess.exitCode !== null || !processIsAlive(appProcess.pid),
      10_000,
      'second native terminate request to exit Test.app',
      100,
    )
    summary.secondTerminateExited = true
    summary.appExitCode = appProcess.exitCode
    summary.appSignalCode = appProcess.signalCode
    await waitFor(
      () => listenerPIDs(TEST_SIDECAR_PORT).length === 0,
      10_000,
      'owned Sidecar listener shutdown',
      100,
    )
    summary.ownedSidecarListenerCountAfterExit = listenerPIDs(TEST_SIDECAR_PORT).length

    await waitFor(
      () =>
        notificationRecords(uniqueBundleIdentifier).length ===
        afterBusiness.uniqueMock.records.length + 1,
      90_000,
      'first-time macOS notification permission and lifecycle record persistence',
      500,
    )
    const afterLifecycle = captureOsState(uniqueBundleIdentifier, true)
    const baselineRecordIds = new Set(
      afterBusiness.uniqueMock.records.map((record) => record.rec_id),
    )
    const decodedRecords = afterLifecycle.uniqueMock.records
      .filter((record) => !baselineRecordIds.has(record.rec_id))
      .map((record) => ({
        recId: record.rec_id,
        uuid: record.uuid,
        requestDate: record.request_date,
        deliveredDate: record.delivered_date,
        presented: record.presented,
        style: record.style,
        data: decodeNotificationData(record.data_hex),
      }))
    const safeAfterLifecycle = {
      ...afterLifecycle,
      uniqueMock: {
        ...afterLifecycle.uniqueMock,
        records: decodedRecords,
      },
    }
    writeFileSync(
      join(artifactDir, 'os-after-lifecycle.json'),
      `${JSON.stringify(safeAfterLifecycle, null, 2)}\n`,
    )
    assertProtectedOsStateUnchanged(before, afterLifecycle)
    summary.lifecycleNativeNotificationDelta =
      afterLifecycle.uniqueMock.records.length - afterBusiness.uniqueMock.records.length
    summary.productionBundlePreferenceModified =
      JSON.stringify(preferenceIdentity(before.production.preferences)) !==
      JSON.stringify(preferenceIdentity(afterLifecycle.production.preferences))
    summary.stableMockBundlePreferenceModified =
      JSON.stringify(preferenceIdentity(before.stableMock.preferences)) !==
      JSON.stringify(preferenceIdentity(afterLifecycle.stableMock.preferences))
    summary.productionBundlePreferenceAfter = preferenceIdentity(
      afterLifecycle.production.preferences,
    )
    summary.stableMockBundlePreferenceAfter = preferenceIdentity(
      afterLifecycle.stableMock.preferences,
    )

    if (summary.lifecycleNativeNotificationDelta !== 1) {
      summary.permissionBlocker = {
        uniquePreferences: afterLifecycle.uniqueMock.preferences,
        uniqueApp: afterLifecycle.uniqueMock.app,
        observedNativeRecords: afterLifecycle.uniqueMock.records.length,
        reason:
          'The isolated bundle did not create exactly one usernoted record; macOS notification permission may require manual action.',
      }
      fail(
        `lifecycle native notification delta must equal one, got ${summary.lifecycleNativeNotificationDelta}`,
      )
    }
    assert.equal(decodedRecords.length, 1)
    assert.equal(decodedRecords[0].data.decoded, true, 'native notification data must decode')
    assert.equal(
      decodedRecords[0].data.containsLifecycleTitle,
      true,
      'native notification title must match the lifecycle copy',
    )
    assert.equal(
      decodedRecords[0].data.containsLifecycleBody,
      true,
      'native notification body must match the lifecycle copy',
    )
    assert.equal(summary.productionBundlePreferenceModified, false)
    assert.equal(summary.stableMockBundlePreferenceModified, false)
    assert.equal(summary.businessNativeNotificationDelta, 0)
    assert.equal(summary.lifecycleNativeNotificationDelta, 1)
    assert.equal(summary.secondTerminateExited, true)
    assert.equal(listenerPIDs(TEST_SIDECAR_PORT).length, 0)

    summary.status = 'passed'
    summary.completedAt = new Date().toISOString()
    completed = true
    writeFileSync(join(artifactDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  } catch (error) {
    summary.status = 'failed'
    summary.completedAt = new Date().toISOString()
    summary.error = error.stack || error.message
    summary.appLogTail = appTail
    writeFileSync(join(artifactDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
    fail(`${error.stack || error.message}\nEvidence: ${artifactDir}\nApp log tail:\n${appTail}`)
  } finally {
    await stopProcess(appProcess)
    await stopOwnedSidecar(copiedBundle)
    if (appLogStream) {
      await new Promise((resolveClose) => appLogStream.end(resolveClose))
    }
    if (existsSync(sandbox)) rmSync(sandbox, { recursive: true, force: true })
    if (!completed) process.stderr.write(`Failure artifacts: ${artifactDir}\n`)
  }
}

function verifyDelayedPermissionResolution(artifactDirectory) {
  assert.equal(process.platform, 'darwin', 'native notification exit boundary is macOS-only')
  assert.ok(artifactDirectory, 'the original artifact directory is required')

  const resolvedArtifactDirectory = resolve(artifactDirectory)
  const originalSummaryPath = join(resolvedArtifactDirectory, 'summary.json')
  const beforePath = join(resolvedArtifactDirectory, 'os-before.json')
  const afterBusinessPath = join(resolvedArtifactDirectory, 'os-after-business.json')
  assert.ok(existsSync(originalSummaryPath), `summary is missing: ${originalSummaryPath}`)
  assert.ok(existsSync(beforePath), `OS baseline is missing: ${beforePath}`)
  assert.ok(existsSync(afterBusinessPath), `business OS evidence is missing: ${afterBusinessPath}`)

  const originalSummary = JSON.parse(readFileSync(originalSummaryPath, 'utf8'))
  const before = JSON.parse(readFileSync(beforePath, 'utf8'))
  const afterBusiness = JSON.parse(readFileSync(afterBusinessPath, 'utf8'))
  const uniqueBundleIdentifier = originalSummary.uniqueBundleIdentifier
  assert.match(uniqueBundleIdentifier, /^[a-zA-Z0-9.-]+$/)

  const afterPermissionResolution = captureOsState(uniqueBundleIdentifier, true)
  assertProtectedOsStateUnchanged(before, afterPermissionResolution)
  const decodedRecords = afterPermissionResolution.uniqueMock.records.map((record) => ({
    recId: record.rec_id,
    uuid: record.uuid,
    requestDate: record.request_date,
    deliveredDate: record.delivered_date,
    presented: record.presented,
    style: record.style,
    data: decodeNotificationData(record.data_hex),
  }))
  const lifecycleNativeNotificationDelta =
    decodedRecords.length - afterBusiness.uniqueMock.records.length

  assert.equal(originalSummary.businessNativeNotificationDelta, 0)
  assert.equal(originalSummary.firstTerminateProcessAlive, true)
  assert.equal(originalSummary.secondTerminateExited, true)
  assert.equal(originalSummary.appExitCode, 0)
  assert.equal(lifecycleNativeNotificationDelta, 1)
  assert.equal(decodedRecords.length, 1)
  assert.equal(decodedRecords[0].data.decoded, true)
  assert.equal(decodedRecords[0].data.containsLifecycleTitle, true)
  assert.equal(decodedRecords[0].data.containsLifecycleBody, true)
  assert.equal(listenerPIDs(TEST_SIDECAR_PORT).length, 0)

  const safeAfterPermissionResolution = {
    ...afterPermissionResolution,
    uniqueMock: {
      ...afterPermissionResolution.uniqueMock,
      records: decodedRecords,
    },
  }
  const delayedSummary = {
    acceptance: originalSummary.acceptance,
    originalRunId: originalSummary.runId,
    status: 'passed-after-first-time-permission-resolution',
    uniqueBundleIdentifier,
    businessNativeNotificationDelta: originalSummary.businessNativeNotificationDelta,
    lifecycleNativeNotificationDelta,
    firstTerminateProcessAlive: originalSummary.firstTerminateProcessAlive,
    secondTerminateExited: originalSummary.secondTerminateExited,
    terminateRequestIntervalMs: originalSummary.terminateRequestIntervalMs,
    appExitCode: originalSummary.appExitCode,
    ownedSidecarListenerCountAfterExit: 0,
    productionBundlePreferenceModified: false,
    stableMockBundlePreferenceModified: false,
    nativeMenuClickProven: false,
    testHarnessDispatcherProven: originalSummary.testHarnessDispatcherProven,
    lifecycleTitle: originalSummary.lifecycleTitle,
    lifecycleBody: originalSummary.lifecycleBody,
    verifiedAt: new Date().toISOString(),
  }

  writeFileSync(
    join(resolvedArtifactDirectory, 'os-after-permission-resolution.json'),
    `${JSON.stringify(safeAfterPermissionResolution, null, 2)}\n`,
  )
  writeFileSync(
    join(resolvedArtifactDirectory, 'delayed-verification-summary.json'),
    `${JSON.stringify(delayedSummary, null, 2)}\n`,
  )
  process.stdout.write(`${JSON.stringify(delayedSummary, null, 2)}\n`)
}

function captureDelayedNotificationRecord(
  uniqueBundleIdentifier,
  expectedProductionPreferenceSha256,
) {
  assert.equal(process.platform, 'darwin', 'native notification exit boundary is macOS-only')
  assert.match(uniqueBundleIdentifier, /^[a-zA-Z0-9.-]+$/)
  assert.match(expectedProductionPreferenceSha256, /^[a-f0-9]{64}$/)

  const captured = captureOsState(uniqueBundleIdentifier, true)
  const decodedRecords = captured.uniqueMock.records.map((record) => ({
    recId: record.rec_id,
    uuid: record.uuid,
    requestDate: record.request_date,
    deliveredDate: record.delivered_date,
    presented: record.presented,
    style: record.style,
    data: decodeNotificationData(record.data_hex),
  }))
  assert.equal(captured.production.preferences?.sha256, expectedProductionPreferenceSha256)
  assert.equal(decodedRecords.length, 1)
  assert.equal(decodedRecords[0].data.decoded, true)
  assert.equal(decodedRecords[0].data.containsLifecycleTitle, true)
  assert.equal(decodedRecords[0].data.containsLifecycleBody, true)
  assert.equal(listenerPIDs(TEST_SIDECAR_PORT).length, 0)

  const artifactDirectory = join(
    repoRoot,
    'test-results/native-notification-exit-boundary',
    `delayed-${uniqueBundleIdentifier}`,
  )
  mkdirSync(artifactDirectory, { recursive: true })
  const safeCaptured = {
    ...captured,
    uniqueMock: {
      ...captured.uniqueMock,
      records: decodedRecords,
    },
  }
  const delayedSummary = {
    status: 'delayed-native-record-verified',
    uniqueBundleIdentifier,
    lifecycleNativeNotificationRecords: decodedRecords.length,
    lifecycleTitle: LIFECYCLE_TITLE,
    lifecycleBody: LIFECYCLE_BODY,
    productionBundlePreferenceSha256: captured.production.preferences.sha256,
    ownedSidecarListenerCountAfterExit: 0,
    nativeMenuClickProven: false,
    runtimeLifecycleMustBeCombinedWithOriginalRunSummary: true,
    capturedAt: captured.capturedAt,
  }
  writeFileSync(
    join(artifactDirectory, 'os-delayed-native-record.json'),
    `${JSON.stringify(safeCaptured, null, 2)}\n`,
  )
  writeFileSync(
    join(artifactDirectory, 'summary.json'),
    `${JSON.stringify(delayedSummary, null, 2)}\n`,
  )
  process.stdout.write(`${JSON.stringify({ artifactDirectory, ...delayedSummary }, null, 2)}\n`)
}

const command = process.argv[2] || 'run'
if (command === 'validate') {
  assert.equal(process.platform, 'darwin', 'native notification exit boundary is macOS-only')
  assert.ok(existsSync(defaultAppBundle), `Test.app bundle is missing: ${defaultAppBundle}`)
  assert.ok(
    existsSync(notificationDatabase),
    `usernoted database is missing: ${notificationDatabase}`,
  )
  process.stdout.write('native notification exit boundary preflight passed\n')
} else if (command === 'run') {
  await runInstalledBoundary()
} else if (command === 'verify-delayed') {
  verifyDelayedPermissionResolution(process.argv[3])
} else if (command === 'capture-delayed') {
  captureDelayedNotificationRecord(process.argv[3], process.argv[4])
} else {
  fail(`unknown command: ${command}`)
}
