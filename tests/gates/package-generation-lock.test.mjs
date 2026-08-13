import assert from 'node:assert/strict'
import { execFile, spawn, spawnSync } from 'node:child_process'
import { watch } from 'node:fs'
import {
  access,
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const moduleURL = new URL('../../scripts/ci/package-generation-lock.mjs', import.meta.url)
const modulePath = fileURLToPath(moduleURL)
const execFileAsync = promisify(execFile)
const macOSTest = (name, fn) => test(name, { skip: process.platform !== 'darwin' }, fn)
const FIXTURE_TIMEOUT_MS = 8_000
const FIXTURE_TERM_GRACE_MS = 750
const FIXTURE_KILL_CONFIRM_MS = 2_000
const fixtureOwnership = new Map()

function parseProcessIdentity(stdout) {
  const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/u.exec(stdout)
  if (!match) return undefined
  return Object.freeze({
    pgid: Number(match[3]),
    pid: Number(match[1]),
    ppid: Number(match[2]),
    startedAt: match[4],
  })
}

async function processIdentity(pid) {
  try {
    const { stdout } = await execFileAsync(
      '/bin/ps',
      ['-o', 'pid=', '-o', 'ppid=', '-o', 'pgid=', '-o', 'lstart=', '-p', String(pid)],
      { encoding: 'utf8' },
    )
    return parseProcessIdentity(stdout)
  } catch (error) {
    if (error?.code === 1) return undefined
    throw error
  }
}

function processIdentitySync(pid) {
  const result = spawnSync(
    '/bin/ps',
    ['-o', 'pid=', '-o', 'ppid=', '-o', 'pgid=', '-o', 'lstart=', '-p', String(pid)],
    { encoding: 'utf8', timeout: 2_000 },
  )
  if (result.status === 1 && result.signal === null) return undefined
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.signal, null)
  return parseProcessIdentity(result.stdout)
}

function sameStableProcessIdentity(left, right) {
  return (
    left !== undefined &&
    right !== undefined &&
    left.pid === right.pid &&
    left.pgid === right.pgid &&
    left.startedAt === right.startedAt
  )
}

async function processTableIdentities() {
  const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,lstart='], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  })
  return stdout
    .split('\n')
    .map(parseProcessIdentity)
    .filter((identity) => identity !== undefined)
}

async function commandLineMatches(root) {
  const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'pid=,pgid=,command='], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  })
  return stdout
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line))
    .filter((match) => match !== null && match[3].includes(root))
    .map((match) => Object.freeze({ pgid: Number(match[2]), pid: Number(match[1]) }))
}

async function refreshFixtureOwnership(root) {
  const ownership = fixtureOwnership.get(root)
  if (!ownership) return
  const table = await processTableIdentities()
  const currentByPID = new Map(table.map((identity) => [identity.pid, identity]))
  const liveOwned = new Set()
  for (const identity of ownership.identities.values()) {
    if (sameStableProcessIdentity(identity, currentByPID.get(identity.pid))) {
      liveOwned.add(identity.pid)
    }
  }
  let changed = true
  while (changed) {
    changed = false
    for (const identity of table) {
      if (liveOwned.has(identity.pid) || !liveOwned.has(identity.ppid)) continue
      ownership.identities.set(identity.pid, identity)
      liveOwned.add(identity.pid)
      changed = true
    }
  }
}

function startOwnershipTracker(root) {
  const ownership = fixtureOwnership.get(root)
  if (!ownership || ownership.tracker) return
  ownership.tracker = setInterval(() => {
    if (ownership.refreshing) return
    ownership.refreshing = true
    refreshFixtureOwnership(root)
      .catch((error) => {
        ownership.trackerError ??= error
      })
      .finally(() => {
        ownership.refreshing = false
      })
  }, 50)
  ownership.tracker.unref?.()
}

async function registerFixtureRoot(root, pid) {
  const ownership = fixtureOwnership.get(root)
  assert.ok(ownership, 'Fixture ownership registry must exist')
  const identity = await processIdentity(pid)
  assert.ok(identity, 'Fixture root identity must be recorded')
  ownership.identities.set(identity.pid, identity)
  startOwnershipTracker(root)
  return identity
}

async function signalRecordedProcess(identity, signal) {
  const current = await processIdentity(identity.pid)
  if (!sameStableProcessIdentity(identity, current)) return false
  try {
    process.kill(identity.pid, signal)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    throw error
  }
}

function signalRecordedProcessSync(identity, signal) {
  const current = processIdentitySync(identity.pid)
  if (!sameStableProcessIdentity(identity, current)) return false
  try {
    process.kill(identity.pid, signal)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    throw error
  }
}

async function signalOwnedFixtureProcess(identity, ownership, signal) {
  const current = await processIdentity(identity.pid)
  if (!sameStableProcessIdentity(identity, current)) return
  if (current.ppid !== identity.ppid) {
    const recordedParent = ownership.identities.get(identity.ppid)
    const currentParent = recordedParent && (await processIdentity(recordedParent.pid))
    if (
      current.ppid !== 1 ||
      recordedParent === undefined ||
      sameStableProcessIdentity(recordedParent, currentParent)
    ) {
      return
    }
  }
  await signalRecordedProcess(identity, signal)
}

async function liveOwnedProcesses(ownership) {
  const current = await Promise.all(
    [...ownership.identities.values()].map(async (identity) => ({
      current: await processIdentity(identity.pid),
      identity,
    })),
  )
  return current
    .filter(({ current: value, identity }) => sameStableProcessIdentity(identity, value))
    .map(({ identity }) => identity)
}

async function waitForOwnedProcessesToExit(ownership, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let remaining = await liveOwnedProcesses(ownership)
  while (remaining.length > 0 && Date.now() < deadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20))
    remaining = await liveOwnedProcesses(ownership)
  }
  return remaining
}

async function cleanupFixtureProcesses(root) {
  const ownership = fixtureOwnership.get(root)
  if (!ownership) return
  if (ownership.tracker) clearInterval(ownership.tracker)
  while (ownership.refreshing) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10))
  }
  await refreshFixtureOwnership(root)
  if (ownership.trackerError) throw ownership.trackerError
  const identities = [...ownership.identities.values()].reverse()
  await Promise.all(
    identities.map((identity) => signalOwnedFixtureProcess(identity, ownership, 'SIGTERM')),
  )
  let remaining = await waitForOwnedProcessesToExit(ownership, FIXTURE_TERM_GRACE_MS)
  if (remaining.length > 0) {
    await Promise.all(
      remaining.map((identity) => signalOwnedFixtureProcess(identity, ownership, 'SIGKILL')),
    )
    remaining = await waitForOwnedProcessesToExit(ownership, FIXTURE_KILL_CONFIRM_MS)
  }
  assert.deepEqual(
    remaining,
    [],
    `Fixture processes did not exit: ${remaining.map(({ pid }) => pid).join(',')}`,
  )
}

async function waitForNoCommandLineMatches(root, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs
  let remaining = await commandLineMatches(root)
  while (remaining.length > 0 && Date.now() < deadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25))
    remaining = await commandLineMatches(root)
  }
  return remaining
}

async function workspace(t) {
  const createdRoot = await mkdtemp(join(tmpdir(), 'hexclaw-package-generation-lock-'))
  const root = await realpath(createdRoot)
  const evidenceRoot = join(root, 'evidence')
  const controlDirectory = join(evidenceRoot, '.package-local.control')
  await mkdir(evidenceRoot, { mode: 0o700 })
  fixtureOwnership.set(root, {
    identities: new Map(),
    refreshing: false,
    tracker: undefined,
    trackerError: undefined,
  })
  t.after(async () => {
    try {
      await cleanupFixtureProcesses(root)
      assert.deepEqual(await waitForNoCommandLineMatches(root), [])
      await rm(root, { recursive: true, force: true })
    } finally {
      fixtureOwnership.delete(root)
    }
  })
  const finalVerifierPath = join(root, 'final-verifier.mjs')
  await writeFile(finalVerifierPath, '', { mode: 0o600 })
  return Object.freeze({
    controlDirectory,
    evidenceRoot,
    finalVerifierPath,
    lockPath: join(controlDirectory, '.package-local.lock'),
    planRoot: (generationId) => join(evidenceRoot, '.package-local.generations', generationId),
    recordsPath: join(controlDirectory, '.package-local.records'),
    root,
    tombstonePath: join(controlDirectory, '.package-local.in-progress'),
  })
}

async function writeFixture(root, name, source) {
  const pathname = join(root, name)
  await writeFile(pathname, source, { mode: 0o600 })
  return pathname
}

function runArguments(
  paths,
  generationId,
  orchestratorPath,
  {
    cliOptions = [],
    extra = [],
    finalVerifierPath = paths.finalVerifierPath,
    verifierExtra = [],
  } = {},
) {
  return [
    modulePath,
    'run',
    ...cliOptions,
    '--lock-file',
    paths.lockPath,
    '--tombstone',
    paths.tombstonePath,
    '--generation-id',
    generationId,
    '--plan-root',
    paths.planRoot(generationId),
    '--cwd',
    paths.root,
    '--',
    process.execPath,
    orchestratorPath,
    ...extra,
    '--final-verifier',
    process.execPath,
    finalVerifierPath,
    ...verifierExtra,
  ]
}

function generationOptions(paths, generationId, orchestratorPath, overrides = {}) {
  return {
    command: [process.execPath, orchestratorPath],
    cwd: paths.root,
    finalVerificationCommand: [process.execPath, paths.finalVerifierPath],
    generationId,
    lockPath: paths.lockPath,
    planRoot: paths.planRoot(generationId),
    tombstonePath: paths.tombstonePath,
    ...overrides,
  }
}

function tombstoneOptions(paths, generationId, overrides = {}) {
  return {
    cwd: paths.root,
    generationId,
    lockPath: paths.lockPath,
    planRoot: paths.planRoot(generationId),
    tombstonePath: paths.tombstonePath,
    ...overrides,
  }
}

async function waitForFile(pathname, timeoutMs = FIXTURE_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await lstat(pathname)
      return
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20))
  }
  assert.fail('Timed out waiting for fixture state')
}

function waitForChild(child, timeoutMs = FIXTURE_TIMEOUT_MS) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode })
  }
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(
      () => rejectPromise(new Error('Timed out waiting for fixture process')),
      timeoutMs,
    )
    timer.unref?.()
    child.once('error', (error) => {
      clearTimeout(timer)
      rejectPromise(error)
    })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      resolvePromise({ code, signal })
    })
  })
}

async function completedOrchestrator(paths, name = 'complete.mjs') {
  return writeFixture(paths.root, name, '')
}

function releaseBarrierSource(readyPath, releasePath, readyPayload = 'ready') {
  return (
    `import { access, writeFile } from 'node:fs/promises'\n` +
    `await writeFile(${JSON.stringify(readyPath)}, ${JSON.stringify(readyPayload)}, { mode: 0o600 })\n` +
    'const deadline = Date.now() + 15000\n' +
    `while (Date.now() < deadline) { try { await access(${JSON.stringify(releasePath)}); process.exit(0) } catch { await new Promise((resolveDelay) => setTimeout(resolveDelay, 20)) } }\n` +
    'process.exit(74)\n'
  )
}

async function stateSnapshot(tombstonePath) {
  const entries = (await readdir(tombstonePath)).sort()
  return new Map(
    await Promise.all(
      entries.map(async (name) => [name, await readFile(join(tombstonePath, name))]),
    ),
  )
}

function fileIdentity(metadata) {
  return Object.freeze({
    ctime_ns: metadata.ctimeNs.toString(),
    dev: metadata.dev.toString(),
    ino: metadata.ino.toString(),
    mode: Number(metadata.mode & 0o777n),
    mtime_ns: metadata.mtimeNs.toString(),
    nlink: metadata.nlink.toString(),
    size: metadata.size.toString(),
    uid: metadata.uid.toString(),
  })
}

function watchForResolution(tombstonePath, existingNames, identityToKill) {
  let watcher
  let timer
  const promise = new Promise((resolvePromise, rejectPromise) => {
    const finish = (error, value) => {
      clearTimeout(timer)
      watcher?.close()
      if (error) rejectPromise(error)
      else resolvePromise(value)
    }
    watcher = watch(tombstonePath, (eventType, filename) => {
      const name = String(filename ?? '')
      if (!name.endsWith('.resolved.json') || existingNames.has(name)) return
      let signaled
      try {
        signaled = signalRecordedProcessSync(identityToKill, 'SIGKILL')
      } catch (error) {
        finish(error)
        return
      }
      if (!signaled) {
        finish(new Error('Completion publisher exited before the controlled SIGKILL'))
        return
      }
      finish(undefined, name)
    })
    timer = setTimeout(
      () => finish(new Error('Timed out waiting for completion publication')),
      FIXTURE_TIMEOUT_MS,
    )
    timer.unref?.()
  })
  return Object.freeze({ close: () => watcher?.close(), promise })
}

macOSTest(
  'real macOS lockf reports EX_TEMPFAIL without a signal for non-blocking contention',
  async (t) => {
    const paths = await workspace(t)
    const lockPath = join(paths.root, 'raw-lockf.lock')
    const readyPath = join(paths.root, 'raw-lockf-ready')
    const releasePath = join(paths.root, 'raw-lockf-release')
    const holder = await writeFixture(
      paths.root,
      'raw-lockf-holder.mjs',
      releaseBarrierSource(readyPath, releasePath),
    )
    const descriptor = await open(lockPath, 'wx+', 0o600)
    const first = spawn(
      '/usr/bin/lockf',
      ['-s', '-t', '0', '-k', '-w', '/dev/fd/3', process.execPath, holder],
      { stdio: ['ignore', 'pipe', 'pipe', descriptor.fd] },
    )
    await registerFixtureRoot(paths.root, first.pid)
    await descriptor.close()
    await waitForFile(readyPath)

    const competitorDescriptor = await open(lockPath, 'r+')
    const contention = spawnSync(
      '/usr/bin/lockf',
      ['-s', '-t', '0', '-k', '-w', '/dev/fd/3', '/usr/bin/true'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe', competitorDescriptor.fd] },
    )
    await competitorDescriptor.close()
    assert.equal(contention.status, 75)
    assert.equal(contention.signal, null)
    assert.equal(contention.stdout, '')
    assert.equal(contention.stderr, '')

    await writeFile(releasePath, 'release', { mode: 0o600 })
    assert.deepEqual(await waitForChild(first), { code: 0, signal: null })
  },
)

macOSTest(
  'fixed private control and generation plan layout publishes immutable state',
  async (t) => {
    const paths = await workspace(t)
    const generationId = 'generation-fixed-layout'
    const orchestrator = await completedOrchestrator(paths)
    const { assertPackageGenerationReady, runWithPackageGenerationLock } = await import(moduleURL)

    assert.deepEqual(
      await runWithPackageGenerationLock(generationOptions(paths, generationId, orchestrator)),
      { exitCode: 0, generationId },
    )
    assert.deepEqual(
      await assertPackageGenerationReady({
        expectedGenerationId: generationId,
        lockPath: paths.lockPath,
        tombstonePath: paths.tombstonePath,
      }),
      { generationId, ready: true },
    )
    for (const pathname of [paths.controlDirectory, paths.tombstonePath, paths.recordsPath]) {
      assert.equal((await lstat(pathname)).mode & 0o777, 0o700)
    }
    assert.equal((await lstat(paths.lockPath)).mode & 0o777, 0o600)
    const states = await readdir(paths.tombstonePath)
    assert.equal(states.filter((name) => name.endsWith('.started.json')).length, 1)
    assert.equal(states.filter((name) => name.endsWith('.resolved.json')).length, 1)
    for (const name of states) {
      const metadata = await lstat(join(paths.tombstonePath, name))
      assert.equal(metadata.mode & 0o777, 0o600)
      assert.equal(metadata.nlink, 2)
    }
  },
)

macOSTest(
  'readiness exposes exactly one completed generation across successive builds',
  async (t) => {
    const paths = await workspace(t)
    const firstGeneration = 'generation-lineage-first'
    const secondGeneration = 'generation-lineage-second'
    const first = await completedOrchestrator(paths, 'lineage-first.mjs')
    const second = await completedOrchestrator(paths, 'lineage-second.mjs')
    const { assertPackageGenerationReady, runWithPackageGenerationLock } = await import(moduleURL)

    await runWithPackageGenerationLock(generationOptions(paths, firstGeneration, first))
    await runWithPackageGenerationLock(generationOptions(paths, secondGeneration, second))
    await assert.rejects(
      assertPackageGenerationReady({
        expectedGenerationId: firstGeneration,
        lockPath: paths.lockPath,
        tombstonePath: paths.tombstonePath,
      }),
      /category=not-ready/u,
    )
    assert.deepEqual(
      await assertPackageGenerationReady({
        expectedGenerationId: secondGeneration,
        lockPath: paths.lockPath,
        tombstonePath: paths.tombstonePath,
      }),
      { generationId: secondGeneration, ready: true },
    )
  },
)

macOSTest('empty resolution state is never ready', async (t) => {
  const paths = await workspace(t)
  const { assertPackageGenerationReady } = await import(moduleURL)

  await assert.rejects(
    assertPackageGenerationReady({
      expectedGenerationId: 'generation-empty-resolution',
      lockPath: paths.lockPath,
      tombstonePath: paths.tombstonePath,
    }),
    /category=not-ready/u,
  )
})

macOSTest(
  'active lock rejects a concurrent generation quickly without altering owner state',
  async (t) => {
    const paths = await workspace(t)
    const readyPath = join(paths.root, 'active-ready')
    const releasePath = join(paths.root, 'active-release')
    const orchestrator = await writeFixture(
      paths.root,
      'active-holder.mjs',
      releaseBarrierSource(readyPath, releasePath),
    )
    const first = spawn(process.execPath, runArguments(paths, 'generation-active', orchestrator), {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await registerFixtureRoot(paths.root, first.pid)
    await waitForFile(readyPath)
    await refreshFixtureOwnership(paths.root)
    const before = await stateSnapshot(paths.tombstonePath)
    const ownerStart = [...before.entries()].find(([name]) => name.endsWith('.started.json'))
    assert.ok(ownerStart)

    const startedAt = Date.now()
    await assert.rejects(
      execFileAsync(process.execPath, runArguments(paths, 'generation-concurrent', orchestrator), {
        encoding: 'utf8',
      }),
      (error) => {
        assert.equal(error.code, 75)
        assert.equal(error.signal, null)
        assert.equal(error.stderr, 'ERROR: package-generation-lock category=active exit=75\n')
        return true
      },
    )
    assert.ok(Date.now() - startedAt < 2_000)
    assert.deepEqual(await readFile(join(paths.tombstonePath, ownerStart[0])), ownerStart[1])

    await writeFile(releasePath, 'release', { mode: 0o600 })
    assert.deepEqual(await waitForChild(first), { code: 0, signal: null })
    const { assertPackageGenerationReady } = await import(moduleURL)
    await assertPackageGenerationReady({
      expectedGenerationId: 'generation-active',
      lockPath: paths.lockPath,
      tombstonePath: paths.tombstonePath,
    })
  },
)

macOSTest(
  'killing only the outer wrapper drains the owner-pipe process tree and recovery succeeds',
  async (t) => {
    const paths = await workspace(t)
    const readyPath = join(paths.root, 'owner-pipe-tree.json')
    const orchestrator = await writeFixture(
      paths.root,
      'owner-pipe-tree.mjs',
      `import { spawn } from 'node:child_process'\n` +
        `import { writeFile } from 'node:fs/promises'\n` +
        `const descendant = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setTimeout(()=>process.exit(74),15000)'], { stdio: 'ignore' })\n` +
        `await writeFile(${JSON.stringify(readyPath)}, JSON.stringify({ orchestrator: process.pid, descendant: descendant.pid }), { mode: 0o600 })\n` +
        'setTimeout(() => process.exit(74), 15000)\n',
    )
    const wrapper = spawn(
      process.execPath,
      runArguments(paths, 'generation-owner-pipe-killed', orchestrator),
      { stdio: ['ignore', 'ignore', 'ignore'] },
    )
    const wrapperIdentity = await registerFixtureRoot(paths.root, wrapper.pid)
    await waitForFile(readyPath)
    await refreshFixtureOwnership(paths.root)
    const fixturePIDs = Object.values(JSON.parse(await readFile(readyPath, 'utf8')))
    for (const pid of fixturePIDs) assert.ok(await processIdentity(pid))

    assert.equal(await signalRecordedProcess(wrapperIdentity, 'SIGKILL'), true)
    assert.deepEqual(await waitForChild(wrapper), { code: null, signal: 'SIGKILL' })
    const ownership = fixtureOwnership.get(paths.root)
    assert.deepEqual(await waitForOwnedProcessesToExit(ownership, FIXTURE_TIMEOUT_MS), [])
    assert.deepEqual(await waitForNoCommandLineMatches(paths.root), [])

    const { assertPackageGenerationReady } = await import(moduleURL)
    await assert.rejects(
      assertPackageGenerationReady({
        expectedGenerationId: 'generation-owner-pipe-killed',
        lockPath: paths.lockPath,
        tombstonePath: paths.tombstonePath,
      }),
      /category=in-progress/u,
    )
    const recovery = await completedOrchestrator(paths, 'owner-pipe-recovery.mjs')
    await execFileAsync(
      process.execPath,
      runArguments(paths, 'generation-owner-pipe-recovery', recovery),
      { encoding: 'utf8' },
    )
    await assertPackageGenerationReady({
      expectedGenerationId: 'generation-owner-pipe-recovery',
      lockPath: paths.lockPath,
      tombstonePath: paths.tombstonePath,
    })
  },
)

macOSTest('pre-lock SIGKILL uses an independent bounded fixture and leaves no lock', async (t) => {
  const paths = await workspace(t)
  const generationId = 'generation-pre-lock-killed'
  const readyPath = join(paths.root, 'pre-lock-ready')
  const fixture = await writeFixture(
    paths.root,
    'pre-lock-barrier.mjs',
    `import { writeFile } from 'node:fs/promises'\n` +
      `import { ensureGenerationTombstone } from ${JSON.stringify(moduleURL.href)}\n` +
      `await ensureGenerationTombstone(${JSON.stringify(tombstoneOptions(paths, generationId))})\n` +
      `await writeFile(${JSON.stringify(readyPath)}, 'ready', { mode: 0o600 })\n` +
      'setTimeout(() => process.exit(74), 15000)\n',
  )
  const fixtureChild = spawn(process.execPath, [fixture], { stdio: 'ignore' })
  const fixtureIdentity = await registerFixtureRoot(paths.root, fixtureChild.pid)
  await waitForFile(readyPath)
  assert.equal(await signalRecordedProcess(fixtureIdentity, 'SIGKILL'), true)
  assert.deepEqual(await waitForChild(fixtureChild), { code: null, signal: 'SIGKILL' })
  await assert.rejects(lstat(paths.lockPath), { code: 'ENOENT' })

  const { assertPackageGenerationReady } = await import(moduleURL)
  await assert.rejects(
    assertPackageGenerationReady({
      expectedGenerationId: generationId,
      lockPath: paths.lockPath,
      tombstonePath: paths.tombstonePath,
    }),
    /category=in-progress/u,
  )
  const recovery = await completedOrchestrator(paths, 'pre-lock-recovery.mjs')
  await execFileAsync(
    process.execPath,
    runArguments(paths, 'generation-pre-lock-recovery', recovery),
    { encoding: 'utf8' },
  )
  await assertPackageGenerationReady({
    expectedGenerationId: 'generation-pre-lock-recovery',
    lockPath: paths.lockPath,
    tombstonePath: paths.tombstonePath,
  })
})

macOSTest('orchestrator success without final verifier success remains invalid', async (t) => {
  const paths = await workspace(t)
  const orchestrator = await completedOrchestrator(paths, 'unverified-build.mjs')
  const verifier = await writeFixture(paths.root, 'failed-verifier.mjs', 'process.exit(42)\n')

  await assert.rejects(
    execFileAsync(
      process.execPath,
      runArguments(paths, 'generation-unverified', orchestrator, { finalVerifierPath: verifier }),
      { encoding: 'utf8' },
    ),
    (error) => {
      assert.equal(error.code, 42)
      assert.equal(
        error.stderr,
        'ERROR: package-generation-lock category=final-verifier-exit exit=42\n',
      )
      return true
    },
  )
  const { assertPackageGenerationReady } = await import(moduleURL)
  await assert.rejects(
    assertPackageGenerationReady({
      expectedGenerationId: 'generation-unverified',
      lockPath: paths.lockPath,
      tombstonePath: paths.tombstonePath,
    }),
    /category=in-progress/u,
  )
})

macOSTest('readiness CLI maps only a valid unresolved state to EX_TEMPFAIL', async (t) => {
  const paths = await workspace(t)
  const generationId = 'generation-readiness'
  const { ensureGenerationTombstone } = await import(moduleURL)
  await ensureGenerationTombstone(tombstoneOptions(paths, generationId))
  const readiness = spawnSync(
    process.execPath,
    [
      modulePath,
      'assert-ready',
      '--generation-id',
      generationId,
      '--lock-file',
      paths.lockPath,
      '--tombstone',
      paths.tombstonePath,
    ],
    { encoding: 'utf8' },
  )
  assert.equal(readiness.status, 75)
  assert.equal(readiness.signal, null)
  assert.equal(readiness.stdout, '')
  assert.equal(readiness.stderr, 'ERROR: package-generation-lock category=in-progress exit=75\n')
})

macOSTest(
  'control basenames, cwd containment, and generation plan binding are mandatory',
  async (t) => {
    const paths = await workspace(t)
    const generationId = 'generation-path-contract'
    const orchestrator = await completedOrchestrator(paths)
    const { runWithPackageGenerationLock } = await import(moduleURL)
    const base = generationOptions(paths, generationId, orchestrator)

    for (const invalid of [
      { lockPath: join(paths.evidenceRoot, 'attacker-lock') },
      { tombstonePath: join(paths.controlDirectory, 'attacker-marker') },
      { planRoot: join(paths.evidenceRoot, 'outside-plan') },
    ]) {
      await assert.rejects(
        runWithPackageGenerationLock({ ...base, ...invalid }),
        /category=(?:invalid-control-path|invalid-plan-path)/u,
      )
    }

    const outsideCwd = join(paths.root, 'outside-cwd')
    await mkdir(outsideCwd, { mode: 0o700 })
    await assert.rejects(
      runWithPackageGenerationLock({ ...base, cwd: outsideCwd }),
      /category=invalid-control-path/u,
    )
    await chmod(paths.evidenceRoot, 0o770)
    await assert.rejects(runWithPackageGenerationLock(base), /category=control-parent-permissions/u)
  },
)

macOSTest(
  'existing markers require exact schema, token, generation, and plan validation',
  async (t) => {
    const attacks = [
      (record) => ({ ...record, schema_version: 'foreign' }),
      (record) => ({ ...record, token_sha256: 'z'.repeat(64) }),
      (record) => ({ ...record, generation_id: '../foreign' }),
      (record) => {
        const withoutPlanRoot = { ...record }
        delete withoutPlanRoot.plan_root
        return withoutPlanRoot
      },
    ]
    for (const [index, attack] of attacks.entries()) {
      await t.test(`malformed marker ${index + 1}`, async (subtest) => {
        const paths = await workspace(subtest)
        const generationId = `generation-malformed-${index}`
        const { ensureGenerationTombstone, runWithPackageGenerationLock } = await import(moduleURL)
        await ensureGenerationTombstone(tombstoneOptions(paths, generationId))
        const startName = (await readdir(paths.tombstonePath)).find((name) =>
          name.endsWith('.started.json'),
        )
        assert.ok(startName)
        const startPath = join(paths.tombstonePath, startName)
        const attacked = `${JSON.stringify(attack(JSON.parse(await readFile(startPath, 'utf8'))))}\n`
        await writeFile(startPath, attacked, { mode: 0o600 })
        const orchestrator = await completedOrchestrator(paths, `malformed-${index}.mjs`)
        await assert.rejects(
          runWithPackageGenerationLock(
            generationOptions(paths, `generation-recovery-${index}`, orchestrator),
          ),
          /category=marker-(?:content|record-hard-link)/u,
        )
        assert.equal(await readFile(startPath, 'utf8'), attacked)
      })
    }
  },
)

macOSTest(
  'symlink, hard-link, and permission attacks fail closed without deleting targets',
  async (t) => {
    await t.test('lock symlink', async (subtest) => {
      const paths = await workspace(subtest)
      await mkdir(paths.controlDirectory, { recursive: true, mode: 0o700 })
      const target = join(paths.root, 'foreign-lock')
      await writeFile(target, 'foreign', { mode: 0o600 })
      await symlink(target, paths.lockPath)
      const orchestrator = await completedOrchestrator(paths)
      const { runWithPackageGenerationLock } = await import(moduleURL)
      await assert.rejects(
        runWithPackageGenerationLock(
          generationOptions(paths, 'generation-lock-symlink', orchestrator),
        ),
        /category=lock-type/u,
      )
      assert.equal(await readFile(target, 'utf8'), 'foreign')
    })

    await t.test('lock hard-link', async (subtest) => {
      const paths = await workspace(subtest)
      const first = await completedOrchestrator(paths, 'first.mjs')
      const { runWithPackageGenerationLock } = await import(moduleURL)
      await runWithPackageGenerationLock(generationOptions(paths, 'generation-lock-created', first))
      const alias = join(paths.root, 'lock-alias')
      await link(paths.lockPath, alias)
      const second = await completedOrchestrator(paths, 'second.mjs')
      await assert.rejects(
        runWithPackageGenerationLock(generationOptions(paths, 'generation-lock-hard-link', second)),
        /category=lock-hard-link/u,
      )
      await access(alias)
    })

    await t.test('state hard-link', async (subtest) => {
      const paths = await workspace(subtest)
      const generationId = 'generation-state-hard-link'
      const { assertPackageGenerationReady, ensureGenerationTombstone } = await import(moduleURL)
      await ensureGenerationTombstone(tombstoneOptions(paths, generationId))
      const startName = (await readdir(paths.tombstonePath)).find((name) =>
        name.endsWith('.started.json'),
      )
      assert.ok(startName)
      const startPath = join(paths.tombstonePath, startName)
      const alias = join(paths.root, 'state-alias')
      await link(startPath, alias)
      await assert.rejects(
        assertPackageGenerationReady({
          expectedGenerationId: generationId,
          lockPath: paths.lockPath,
          tombstonePath: paths.tombstonePath,
        }),
        /category=(?:marker|staged)-record-hard-link/u,
      )
      await access(alias)
    })

    await t.test('state permissions', async (subtest) => {
      const paths = await workspace(subtest)
      const generationId = 'generation-state-permissions'
      const { assertPackageGenerationReady, ensureGenerationTombstone } = await import(moduleURL)
      await ensureGenerationTombstone(tombstoneOptions(paths, generationId))
      const startName = (await readdir(paths.tombstonePath)).find((name) =>
        name.endsWith('.started.json'),
      )
      assert.ok(startName)
      const startPath = join(paths.tombstonePath, startName)
      await chmod(startPath, 0o644)
      await assert.rejects(
        assertPackageGenerationReady({
          expectedGenerationId: generationId,
          lockPath: paths.lockPath,
          tombstonePath: paths.tombstonePath,
        }),
        /category=(?:marker|staged)-record-permissions/u,
      )
    })

    await t.test('foreign state entry', async (subtest) => {
      const paths = await workspace(subtest)
      const generationId = 'generation-foreign-entry'
      const { ensureGenerationTombstone, runWithPackageGenerationLock } = await import(moduleURL)
      await ensureGenerationTombstone(tombstoneOptions(paths, generationId))
      const foreign = join(paths.tombstonePath, 'foreign-caller-file')
      await writeFile(foreign, 'foreign', { mode: 0o600 })
      const orchestrator = await completedOrchestrator(paths)
      await assert.rejects(
        runWithPackageGenerationLock(
          generationOptions(paths, 'generation-foreign-entry-recovery', orchestrator),
        ),
        /category=marker-content/u,
      )
      assert.equal(await readFile(foreign, 'utf8'), 'foreign')
    })
  },
)

macOSTest('subcommand exit 75 is not misclassified as lock contention', async (t) => {
  const paths = await workspace(t)
  const orchestrator = await writeFixture(paths.root, 'exit-75.mjs', 'process.exit(75)\n')
  await assert.rejects(
    execFileAsync(process.execPath, runArguments(paths, 'generation-child-75', orchestrator), {
      encoding: 'utf8',
    }),
    (error) => {
      assert.equal(error.code, 75)
      assert.equal(
        error.stderr,
        'ERROR: package-generation-lock category=subcommand-exit exit=75\n',
      )
      return true
    },
  )
})

macOSTest(
  'structured package-local category crosses the lock boundary without raw output',
  async (t) => {
    const paths = await workspace(t)
    const orchestrator = await writeFixture(
      paths.root,
      'structured-package-failure.mjs',
      "process.stderr.write('ERROR: package-local category=dependency-provenance-verify\\n')\n" +
        'process.exit(1)\n',
    )
    await assert.rejects(
      execFileAsync(process.execPath, runArguments(paths, 'generation-structured', orchestrator), {
        encoding: 'utf8',
      }),
      (error) => {
        assert.equal(error.code, 1)
        assert.equal(
          error.stderr,
          'ERROR: package-generation-lock category=subcommand-dependency-provenance-verify exit=1\n',
        )
        return true
      },
    )
  },
)

macOSTest('CLI redacts child output while preserving its exit category and code', async (t) => {
  const paths = await workspace(t)
  const secret = 'sk-proj-SYNTHETIC_SECRET_MUST_NOT_ESCAPE_1234567890'
  const orchestrator = await writeFixture(
    paths.root,
    'secret-failure.mjs',
    `process.stdout.write(${JSON.stringify(`${secret}:${paths.root}`)})\n` +
      `process.stderr.write(${JSON.stringify(`${secret}:${paths.tombstonePath}`)})\n` +
      'process.exit(23)\n',
  )
  await assert.rejects(
    execFileAsync(process.execPath, runArguments(paths, 'generation-secret', orchestrator), {
      encoding: 'utf8',
    }),
    (error) => {
      assert.equal(error.code, 23)
      assert.equal(error.stdout, '')
      assert.equal(
        error.stderr,
        'ERROR: package-generation-lock category=subcommand-exit exit=23\n',
      )
      assert.equal(`${error.stdout}${error.stderr}`.includes(secret), false)
      assert.equal(`${error.stdout}${error.stderr}`.includes(paths.root), false)
      return true
    },
  )
})

macOSTest('orchestrator signal is retained as a stable redacted status', async (t) => {
  const paths = await workspace(t)
  const orchestrator = await writeFixture(
    paths.root,
    'signal.mjs',
    'process.kill(process.pid, "SIGTERM")\n',
  )
  await assert.rejects(
    execFileAsync(process.execPath, runArguments(paths, 'generation-signal', orchestrator), {
      encoding: 'utf8',
    }),
    (error) => {
      assert.equal(error.code, 70)
      assert.equal(
        error.stderr,
        'ERROR: package-generation-lock category=subcommand-signal exit=70 signal=SIGTERM\n',
      )
      return true
    },
  )
})

macOSTest('default child environments exclude host credentials and owner context', async (t) => {
  const paths = await workspace(t)
  const evidencePath = join(paths.root, 'environment-evidence')
  const secret = 'synthetic-provider-secret-that-must-not-propagate'
  const probe = (phase, append) =>
    `import { ${append ? 'appendFile' : 'writeFile'} } from 'node:fs/promises'\n` +
    `await ${append ? 'appendFile' : 'writeFile'}(${JSON.stringify(evidencePath)}, JSON.stringify({ phase: ${JSON.stringify(phase)}, context: process.env.HEXCLAW_PACKAGE_GENERATION_CONTEXT ?? null, provider: process.env.PROVIDER_API_KEY ?? null }) + '\\n'${append ? '' : ', { mode: 0o600 }'})\n`
  const orchestrator = await writeFixture(
    paths.root,
    'environment-build.mjs',
    probe('build', false),
  )
  const verifier = await writeFixture(paths.root, 'environment-verify.mjs', probe('verify', true))

  await execFileAsync(
    process.execPath,
    runArguments(paths, 'generation-clean-environment', orchestrator, {
      finalVerifierPath: verifier,
    }),
    { encoding: 'utf8', env: { ...process.env, PROVIDER_API_KEY: secret } },
  )
  const evidence = (await readFile(evidencePath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  assert.deepEqual(evidence, [
    { context: null, phase: 'build', provider: null },
    { context: null, phase: 'verify', provider: null },
  ])
})

macOSTest(
  'build and final consume distinct anonymous capabilities while the advisory lock is held',
  async (t) => {
    const paths = await workspace(t)
    const generationId = 'generation-lock-capability'
    const probeSource = (phase) =>
      `import { consumePackageGenerationCapability } from ${JSON.stringify(moduleURL.href)}\n` +
      `const options = ${JSON.stringify({
        expectedGenerationId: generationId,
        expectedLockPath: paths.lockPath,
        expectedPlanRoot: paths.planRoot(generationId),
        phase,
      })}\n` +
      `try { await consumePackageGenerationCapability(options) } catch (error) { process.stderr.write('ERROR: package-local category=probe-' + String(error?.category ?? 'internal').replaceAll(':', '-') + '\\n'); process.exit(1) }\n` +
      `let replay = false\n` +
      `try { await consumePackageGenerationCapability(options) } catch (error) { replay = error?.category === 'capability-replay' }\n` +
      `if (!replay) process.exit(61)\n` +
      `if (process.env.HEXCLAW_PACKAGE_GENERATION_CONTEXT !== undefined) process.exit(62)\n`
    const orchestrator = await writeFixture(
      paths.root,
      'lock-capability-build.mjs',
      probeSource('build'),
    )
    const verifier = await writeFixture(
      paths.root,
      'lock-capability-verify.mjs',
      probeSource('final'),
    )

    await execFileAsync(
      process.execPath,
      runArguments(paths, generationId, orchestrator, {
        finalVerifierPath: verifier,
      }),
      { encoding: 'utf8' },
    )
  },
)

macOSTest('hard timeout drains the complete orchestrator process group', async (t) => {
  const paths = await workspace(t)
  const identitiesPath = join(paths.root, 'timeout-identities.json')
  const orchestrator = await writeFixture(
    paths.root,
    'timeout-tree.mjs',
    `import { spawn } from 'node:child_process'\n` +
      `import { writeFile } from 'node:fs/promises'\n` +
      `const descendant = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setTimeout(()=>process.exit(74),15000)'], { stdio: 'ignore' })\n` +
      `process.on('SIGTERM', () => {})\n` +
      `await writeFile(${JSON.stringify(identitiesPath)}, JSON.stringify({ orchestrator: process.pid, descendant: descendant.pid }), { mode: 0o600 })\n` +
      'setTimeout(() => process.exit(74), 15000)\n',
  )
  await assert.rejects(
    execFileAsync(
      process.execPath,
      runArguments(paths, 'generation-timeout', orchestrator, {
        cliOptions: ['--timeout-ms', '300'],
      }),
      { encoding: 'utf8' },
    ),
    /category=subcommand-timeout exit=70/u,
  )
  const identities = JSON.parse(await readFile(identitiesPath, 'utf8'))
  for (const pid of Object.values(identities)) {
    assert.equal(await processIdentity(pid), undefined)
  }
})

macOSTest('fresh verifier rejects work performed after an attempted early claim', async (t) => {
  const paths = await workspace(t)
  const artifactPath = join(paths.root, 'canonical-artifact')
  const forgedClaimPath = join(paths.root, '.package-generation-completion.forged.json')
  const orchestrator = await writeFixture(
    paths.root,
    'early-claim.mjs',
    `import { writeFile } from 'node:fs/promises'\n` +
      `await writeFile(${JSON.stringify(artifactPath)}, 'verified-state', { mode: 0o600 })\n` +
      `await writeFile(${JSON.stringify(forgedClaimPath)}, 'forged', { mode: 0o600 })\n` +
      `await writeFile(${JSON.stringify(artifactPath)}, 'mutated-after-claim', { mode: 0o600 })\n`,
  )
  const verifier = await writeFixture(
    paths.root,
    'fresh-verifier.mjs',
    `import { readFile } from 'node:fs/promises'\n` +
      `if (await readFile(${JSON.stringify(artifactPath)}, 'utf8') !== 'verified-state') process.exit(43)\n`,
  )
  await assert.rejects(
    execFileAsync(
      process.execPath,
      runArguments(paths, 'generation-early-claim', orchestrator, {
        finalVerifierPath: verifier,
      }),
      { encoding: 'utf8' },
    ),
    /category=final-verifier-exit exit=43/u,
  )
  assert.equal(await readFile(forgedClaimPath, 'utf8'), 'forged')
})

macOSTest('held phase rejects fd3 unless it is the validated canonical lock object', async (t) => {
  const paths = await workspace(t)
  const base = await completedOrchestrator(paths, 'fd3-base.mjs')
  const { ensureGenerationTombstone, runWithPackageGenerationLock } = await import(moduleURL)
  await runWithPackageGenerationLock(generationOptions(paths, 'generation-fd3-base', base))
  const generationId = 'generation-foreign-fd3'
  const ownerToken = 'a'.repeat(64)
  const prepared = await ensureGenerationTombstone(
    tombstoneOptions(paths, generationId, { ownerToken }),
  )
  const lockIdentity = fileIdentity(await lstat(paths.lockPath, { bigint: true }))
  const foreignPath = join(paths.root, 'foreign-lock-object')
  await writeFile(foreignPath, 'foreign', { mode: 0o600 })
  const foreign = await open(foreignPath, 'r+')
  t.after(() => foreign.close().catch(() => undefined))
  const context = Buffer.from(
    JSON.stringify({
      commandOutputBytes: 1024,
      commandTimeoutMs: 2_000,
      controlIdentity: prepared.controlIdentity,
      cwd: prepared.cwd,
      evidenceRoot: prepared.evidenceRoot,
      generationId,
      lockIdentity,
      lockPath: paths.lockPath,
      ownerToken,
      planRoot: prepared.planRoot,
      schemaVersion: 'hexclaw.package-generation-context.v2',
      startIdentity: prepared.startIdentity,
      stateId: prepared.stateId,
      tombstonePath: paths.tombstonePath,
    }),
    'utf8',
  ).toString('base64url')
  const result = spawnSync(
    process.execPath,
    [
      modulePath,
      'held',
      '--',
      process.execPath,
      await completedOrchestrator(paths, 'foreign-fd3-build.mjs'),
      '--final-verifier',
      process.execPath,
      paths.finalVerifierPath,
    ],
    {
      cwd: paths.root,
      encoding: 'utf8',
      env: { HEXCLAW_PACKAGE_GENERATION_CONTEXT: context },
      stdio: ['ignore', 'pipe', 'pipe', foreign.fd],
    },
  )
  assert.equal(result.status, 70)
  assert.equal(result.signal, null)
  assert.equal(result.stderr, 'ERROR: package-generation-lock category=lock-descriptor exit=70\n')
})

macOSTest('SIGKILL at completion publication leaves only recoverable atomic state', async (t) => {
  const paths = await workspace(t)
  const generationId = 'generation-completion-crash'
  const readyPath = join(paths.root, 'completion-ready.json')
  const releasePath = join(paths.root, 'completion-release')
  const orchestrator = await writeFixture(
    paths.root,
    'completion-barrier.mjs',
    releaseBarrierSource(readyPath, releasePath, JSON.stringify({ pid: 0 })).replace(
      JSON.stringify(JSON.stringify({ pid: 0 })),
      'JSON.stringify({ pid: process.pid })',
    ),
  )
  const wrapper = spawn(process.execPath, runArguments(paths, generationId, orchestrator), {
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  const wrapperIdentity = await registerFixtureRoot(paths.root, wrapper.pid)
  await waitForFile(readyPath)
  await refreshFixtureOwnership(paths.root)
  const orchestratorPID = JSON.parse(await readFile(readyPath, 'utf8')).pid
  const orchestratorIdentity = await processIdentity(orchestratorPID)
  assert.ok(orchestratorIdentity)
  const heldIdentity = await processIdentity(orchestratorIdentity.ppid)
  assert.ok(heldIdentity)
  const ownership = fixtureOwnership.get(paths.root)
  ownership.identities.set(heldIdentity.pid, heldIdentity)
  const existingNames = new Set(await readdir(paths.tombstonePath))
  const publication = watchForResolution(paths.tombstonePath, existingNames, wrapperIdentity)
  t.after(() => publication.close())

  await writeFile(releasePath, 'release', { mode: 0o600 })
  const resolutionName = await publication.promise
  assert.match(resolutionName, /^[a-f0-9]{64}\.resolved\.json$/u)
  assert.deepEqual(await waitForChild(wrapper), { code: null, signal: 'SIGKILL' })

  const recovery = await completedOrchestrator(paths, 'completion-recovery.mjs')
  await execFileAsync(
    process.execPath,
    runArguments(paths, 'generation-after-completion-crash', recovery),
    { encoding: 'utf8' },
  )
  const { assertPackageGenerationReady } = await import(moduleURL)
  await assertPackageGenerationReady({
    expectedGenerationId: 'generation-after-completion-crash',
    lockPath: paths.lockPath,
    tombstonePath: paths.tombstonePath,
  })
})

macOSTest('fixture cleanup never signals an unregistered command-line match', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hexclaw-package-cleanup-ownership-'))
  const outsider = spawn(process.execPath, ['-e', 'setTimeout(()=>process.exit(74),15000)', root], {
    stdio: 'ignore',
  })
  const identity = await processIdentity(outsider.pid)
  assert.ok(identity)
  t.after(async () => {
    await signalRecordedProcess(identity, 'SIGKILL')
    await waitForChild(outsider).catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  })

  await cleanupFixtureProcesses(root)
  assert.equal(sameStableProcessIdentity(identity, await processIdentity(identity.pid)), true)
})

macOSTest(
  'production module has no test hook or destructive durable state transition',
  async () => {
    const source = await readFile(modulePath, 'utf8')
    assert.doesNotMatch(
      source,
      /HEXCLAW_PACKAGE_LOCK_TEST_MODE|HEXCLAW_PACKAGE_LOCK_TEST_PRELOCK_READY_FILE/u,
    )
    assert.doesNotMatch(source, /\brename\s*\(/u)
    assert.equal([...source.matchAll(/\bunlink\s*\(/gu)].length, 1)
    assert.match(
      source,
      /await unlink\(pathname\)[\s\S]*validateRegularFileMetadata\(metadata, 'capability', \[0n\]\)/u,
    )
  },
)

macOSTest('CLI requires absolute Node and orchestrator paths and emits English only', async (t) => {
  const paths = await workspace(t)
  const orchestrator = await completedOrchestrator(paths)
  const invalidArguments = runArguments(paths, 'generation-invalid-command', orchestrator)
  invalidArguments[invalidArguments.indexOf(process.execPath)] = 'node'
  await assert.rejects(
    execFileAsync(process.execPath, invalidArguments, { encoding: 'utf8' }),
    (error) => {
      assert.equal(error.code, 64)
      assert.equal(
        error.stderr,
        'ERROR: package-generation-lock category=invalid-command exit=64\n',
      )
      assert.doesNotMatch(error.stderr, /[\u3400-\u9fff]/u)
      return true
    },
  )
})
