import assert from 'node:assert/strict'
import { execFile, spawn, spawnSync } from 'node:child_process'
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const moduleURL = new URL('../../scripts/ci/package-generation-lock.mjs', import.meta.url)
const modulePath = fileURLToPath(moduleURL)
const execFileAsync = promisify(execFile)
const macOSTest = (name, fn) => test(name, { skip: process.platform !== 'darwin' }, fn)
const FIXTURE_EXIT_TIMEOUT_MS = 5_000
const FIXTURE_TERM_GRACE_MS = 1_000
const FIXTURE_KILL_CONFIRM_MS = 2_000
const fixtureOwnership = new Map()

async function processIdentity(pid) {
  try {
    const { stdout } = await execFileAsync(
      '/bin/ps',
      ['-o', 'pid=', '-o', 'ppid=', '-o', 'pgid=', '-o', 'lstart=', '-p', String(pid)],
      { encoding: 'utf8' },
    )
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/u.exec(stdout)
    if (!match) return undefined
    return Object.freeze({
      pgid: Number(match[3]),
      pid: Number(match[1]),
      ppid: Number(match[2]),
      startedAt: match[4],
    })
  } catch (error) {
    if (error?.code === 1) return undefined
    throw error
  }
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

async function signalRecordedProcess(identity, signal) {
  const current = await processIdentity(identity.pid)
  if (!sameStableProcessIdentity(identity, current)) return
  try {
    process.kill(identity.pid, signal)
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error
  }
}

async function waitForRecordedProcessExit(identity, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!sameStableProcessIdentity(identity, await processIdentity(identity.pid))) return
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20))
  }
  assert.fail(`Recorded fixture process did not exit: ${identity.pid}`)
}

async function processTableIdentities() {
  const { stdout } = await execFileAsync(
    '/bin/ps',
    ['-axo', 'pid=,ppid=,pgid=,lstart='],
    { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
  )
  return stdout
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/u.exec(line))
    .filter((match) => match !== null)
    .map((match) =>
      Object.freeze({
        pgid: Number(match[3]),
        pid: Number(match[1]),
        ppid: Number(match[2]),
        startedAt: match[4],
      }),
    )
}

async function registerFixtureRoot(root, pid) {
  const ownership = fixtureOwnership.get(root)
  assert.ok(ownership, 'Fixture ownership registry must exist')
  const identity = await processIdentity(pid)
  assert.ok(identity, 'Fixture root identity must be recorded')
  ownership.identities.set(identity.pid, identity)
  ownership.roots.add(identity.pid)
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

async function fixtureProcesses(root) {
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

async function waitForFixtureProcessesToExit(root, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let remaining = await fixtureProcesses(root)
  while (remaining.length > 0 && Date.now() < deadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50))
    remaining = await fixtureProcesses(root)
  }
  return remaining
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
  try {
    process.kill(identity.pid, signal)
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error
  }
}

async function waitForOwnedProcessesToExit(ownership, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let remaining = []
  do {
    const current = await Promise.all(
      [...ownership.identities.values()].map(async (identity) => ({
        current: await processIdentity(identity.pid),
        identity,
      })),
    )
    remaining = current
      .filter(({ current: value, identity }) => sameStableProcessIdentity(identity, value))
      .map(({ identity }) => identity)
    if (remaining.length === 0) return []
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20))
  } while (Date.now() < deadline)
  return remaining
}

async function cleanupFixtureProcesses(root) {
  const ownership = fixtureOwnership.get(root)
  if (!ownership) return
  await refreshFixtureOwnership(root)
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

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'hexclaw-package-generation-lock-'))
  fixtureOwnership.set(root, { identities: new Map(), roots: new Set() })
  t.after(async () => {
    try {
      await cleanupFixtureProcesses(root)
      assert.deepEqual(await waitForFixtureProcessesToExit(root, 250), [])
      await rm(root, { recursive: true, force: true })
    } finally {
      fixtureOwnership.delete(root)
    }
  })
  const finalVerifierPath = join(root, 'final-verifier.mjs')
  await writeFile(finalVerifierPath, '', { mode: 0o600 })
  return Object.freeze({
    finalVerifierPath,
    lockPath: join(root, 'package-local.lock'),
    root,
    tombstonePath: join(root, 'package-local.in-progress.json'),
  })
}

async function writeOrchestrator(root, name, source) {
  const pathname = join(root, name)
  await writeFile(pathname, source, { mode: 0o600 })
  return pathname
}

function runArguments(
  paths,
  generationID,
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
    generationID,
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

async function waitForFile(pathname, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await lstat(pathname)
      return
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.fail('Timed out waiting for fixture state')
}

function waitForChild(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
}

async function completedOrchestrator(paths, name = 'complete.mjs') {
  return writeOrchestrator(paths.root, name, '')
}

macOSTest(
  'real macOS lockf reports EX_TEMPFAIL without a signal for non-blocking contention',
  async (t) => {
    const paths = await workspace(t)
    const readyPath = join(paths.root, 'lockf-ready')
    const releasePath = join(paths.root, 'lockf-release')
    const holder = await writeOrchestrator(
      paths.root,
      'lockf-holder.mjs',
      `import { access, writeFile } from 'node:fs/promises'\n` +
        `await writeFile(${JSON.stringify(readyPath)}, 'ready', { mode: 0o600 })\n` +
        `while (true) { try { await access(${JSON.stringify(releasePath)}); break } catch { await new Promise((resolve) => setTimeout(resolve, 20)) } }\n`,
    )
    const firstDescriptor = await open(paths.lockPath, 'wx+', 0o600)
    const first = spawn(
      '/usr/bin/lockf',
      ['-s', '-t', '0', '-k', '-w', '/dev/fd/3', process.execPath, holder],
      { stdio: ['ignore', 'pipe', 'pipe', firstDescriptor.fd] },
    )
    await registerFixtureRoot(paths.root, first.pid)
    await firstDescriptor.close()
    await waitForFile(readyPath)
    await refreshFixtureOwnership(paths.root)

    const secondDescriptor = await open(paths.lockPath, 'r+')
    const contention = spawnSync(
      '/usr/bin/lockf',
      ['-s', '-t', '0', '-k', '-w', '/dev/fd/3', process.execPath, holder],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe', secondDescriptor.fd],
      },
    )
    await secondDescriptor.close()
    assert.equal(contention.status, 75)
    assert.equal(contention.signal, null)
    assert.equal(contention.stdout, '')
    assert.equal(contention.stderr, '')

    await writeFile(releasePath, 'release', { mode: 0o600 })
    assert.deepEqual(await waitForChild(first), { code: 0, signal: null })
  },
)

macOSTest(
  'active generation lock preserves its tombstone and rejects a concurrent build quickly',
  async (t) => {
    const paths = await workspace(t)
    const readyPath = join(paths.root, 'ready')
    const releasePath = join(paths.root, 'release')
    const orchestrator = await writeOrchestrator(
      paths.root,
      'wait-and-complete.mjs',
      `import { access, writeFile } from 'node:fs/promises'\n` +
        `await writeFile(${JSON.stringify(readyPath)}, 'ready', { mode: 0o600 })\n` +
        `while (true) { try { await access(${JSON.stringify(releasePath)}); break } catch { await new Promise((resolve) => setTimeout(resolve, 20)) } }\n`,
    )
    const first = spawn(process.execPath, runArguments(paths, 'generation-active', orchestrator), {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await registerFixtureRoot(paths.root, first.pid)
    await waitForFile(readyPath)
    await refreshFixtureOwnership(paths.root)

    const before = await readFile(paths.tombstonePath)
    const startedAt = Date.now()
    await assert.rejects(
      execFileAsync(process.execPath, runArguments(paths, 'generation-concurrent', orchestrator), {
        encoding: 'utf8',
      }),
      (error) => {
        assert.equal(error.code, 75)
        assert.match(error.stderr, /^ERROR: package-generation-lock category=active exit=75\n$/u)
        return true
      },
    )
    assert.ok(Date.now() - startedAt < 2_000)
    assert.deepEqual(await readFile(paths.tombstonePath), before)

    const [lockMetadata, markerMetadata] = await Promise.all([
      lstat(paths.lockPath),
      lstat(paths.tombstonePath),
    ])
    assert.equal(lockMetadata.mode & 0o777, 0o600)
    assert.equal(lockMetadata.nlink, 1)
    assert.equal(markerMetadata.mode & 0o777, 0o600)
    assert.equal(markerMetadata.nlink, 1)

    const { stdout: processList } = await execFileAsync('/bin/ps', ['-axo', 'command='], {
      encoding: 'utf8',
    })
    assert.match(processList, /\/usr\/bin\/lockf -s -t 0 -k -w \/dev\/fd\/3/u)

    await writeFile(releasePath, 'release', { mode: 0o600 })
    assert.deepEqual(await waitForChild(first), { code: 0, signal: null })
    await assert.rejects(lstat(paths.tombstonePath), { code: 'ENOENT' })
  },
)

macOSTest(
  'SIGKILL after acquisition keeps the tombstone and a later generation recovers',
  async (t) => {
    const paths = await workspace(t)
    const readyPath = join(paths.root, 'locked')
    const hanging = await writeOrchestrator(
      paths.root,
      'hang.mjs',
      `import { writeFile } from 'node:fs/promises'\n` +
        `await writeFile(${JSON.stringify(readyPath)}, 'locked', { mode: 0o600 })\n` +
        'setInterval(() => {}, 1000)\n',
    )
    const child = spawn(process.execPath, runArguments(paths, 'generation-killed', hanging), {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    await registerFixtureRoot(paths.root, child.pid)
    await waitForFile(readyPath)
    await refreshFixtureOwnership(paths.root)
    child.kill('SIGKILL')
    const killed = await waitForChild(child)
    assert.equal(killed.signal, 'SIGKILL')
    assert.deepEqual(await waitForFixtureProcessesToExit(paths.root, FIXTURE_EXIT_TIMEOUT_MS), [])

    const { assertPackageGenerationReady } = await import(moduleURL)
    await assert.rejects(
      assertPackageGenerationReady({
        lockPath: paths.lockPath,
        tombstonePath: paths.tombstonePath,
      }),
      /category=in-progress/u,
    )

    const recovery = await completedOrchestrator(paths, 'recover.mjs')
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      runArguments(paths, 'generation-recovered', recovery),
      { encoding: 'utf8' },
    )
    assert.equal(stdout, 'PASS: package-generation-lock category=complete\n')
    assert.equal(stderr, '')
    await assertPackageGenerationReady({
      lockPath: paths.lockPath,
      tombstonePath: paths.tombstonePath,
    })
  },
)

macOSTest('a real pre-lock SIGKILL keeps the durable tombstone and allows recovery', async (t) => {
  const paths = await workspace(t)
  const receiptPath = join(paths.root, 'release-ui-attestation.json')
  const readyPath = join(paths.root, 'pre-lock-ready')
  await writeFile(receiptPath, '{"old":true}\n', { mode: 0o600 })
  const { assertPackageGenerationReady } = await import(moduleURL)
  const orchestrator = await completedOrchestrator(paths)
  const child = spawn(
    process.execPath,
    runArguments(paths, 'generation-before-lock-kill', orchestrator),
    {
      env: {
        ...process.env,
        HEXCLAW_PACKAGE_LOCK_TEST_MODE: '1',
        HEXCLAW_PACKAGE_LOCK_TEST_PRELOCK_READY_FILE: readyPath,
      },
      stdio: ['ignore', 'ignore', 'ignore'],
    },
  )
  await registerFixtureRoot(paths.root, child.pid)
  await waitForFile(readyPath)
  child.kill('SIGKILL')
  assert.deepEqual(await waitForChild(child), { code: null, signal: 'SIGKILL' })
  assert.deepEqual(await waitForFixtureProcessesToExit(paths.root, FIXTURE_EXIT_TIMEOUT_MS), [])

  await assert.rejects(lstat(paths.lockPath), { code: 'ENOENT' })
  await assert.rejects(
    assertPackageGenerationReady({
      lockPath: paths.lockPath,
      tombstonePath: paths.tombstonePath,
    }),
    /category=in-progress/u,
  )
  assert.equal(await readFile(receiptPath, 'utf8'), '{"old":true}\n')

  await execFileAsync(
    process.execPath,
    runArguments(paths, 'generation-after-prelock-kill', orchestrator),
    { encoding: 'utf8' },
  )
  await assertPackageGenerationReady({
    lockPath: paths.lockPath,
    tombstonePath: paths.tombstonePath,
  })
  assert.equal(await readFile(receiptPath, 'utf8'), '{"old":true}\n')
})

macOSTest('orchestrator success without final-verifier success remains invalid', async (t) => {
  const paths = await workspace(t)
  const orchestrator = await completedOrchestrator(paths, 'published.mjs')
  const verifier = await writeOrchestrator(
    paths.root,
    'failed-final-verifier.mjs',
    'process.exit(42)\n',
  )

  await assert.rejects(
    execFileAsync(
      process.execPath,
      runArguments(paths, 'generation-without-verification', orchestrator, {
        finalVerifierPath: verifier,
      }),
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
  await lstat(paths.tombstonePath)
})

macOSTest('readiness CLI returns only EX_TEMPFAIL for an in-progress generation', async (t) => {
  const paths = await workspace(t)
  const { ensureGenerationTombstone } = await import(moduleURL)
  await ensureGenerationTombstone({
    generationId: 'generation-readiness',
    tombstonePath: paths.tombstonePath,
  })

  const readiness = spawnSync(
    process.execPath,
    [modulePath, 'assert-ready', '--lock-file', paths.lockPath, '--tombstone', paths.tombstonePath],
    { encoding: 'utf8' },
  )
  assert.equal(readiness.status, 75)
  assert.equal(readiness.signal, null)
  assert.equal(readiness.stdout, '')
  assert.equal(readiness.stderr, 'ERROR: package-generation-lock category=in-progress exit=75\n')
})

macOSTest('readiness rejects a symbolic-link or hard-linked lock file', async (t) => {
  const paths = await workspace(t)
  const { assertPackageGenerationReady } = await import(moduleURL)
  const targetPath = join(paths.root, 'lock-target')
  await writeFile(targetPath, 'lock', { mode: 0o600 })
  await symlink(targetPath, paths.lockPath)
  await assert.rejects(
    assertPackageGenerationReady({
      lockPath: paths.lockPath,
      tombstonePath: paths.tombstonePath,
    }),
    /category=lock-type/u,
  )

  await rm(paths.lockPath)
  await writeFile(paths.lockPath, 'lock', { mode: 0o600 })
  const aliasPath = join(paths.root, 'lock-alias')
  await link(paths.lockPath, aliasPath)
  await assert.rejects(
    assertPackageGenerationReady({
      lockPath: paths.lockPath,
      tombstonePath: paths.tombstonePath,
    }),
    /category=lock-hard-link/u,
  )
})

macOSTest('subcommand exit 75 is not misclassified as lock contention', async (t) => {
  const paths = await workspace(t)
  const orchestrator = await writeOrchestrator(paths.root, 'exit-75.mjs', 'process.exit(75)\n')

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

macOSTest('foreign token or marker descriptor cannot authorize tombstone removal', async (t) => {
  const paths = await workspace(t)
  const orchestrator = await completedOrchestrator(paths, 'foreign-owner-build.mjs')
  const tokenMismatch = await writeOrchestrator(
    paths.root,
    'foreign-token-verifier.mjs',
    `import { readFile, writeFile } from 'node:fs/promises'\n` +
      `if (process.env.HEXCLAW_PACKAGE_GENERATION_CONTEXT) process.exit(35)\n` +
      `const marker = JSON.parse(await readFile(${JSON.stringify(paths.tombstonePath)}, 'utf8'))\n` +
      `marker.token_sha256 = '0'.repeat(64)\n` +
      `await writeFile(${JSON.stringify(paths.tombstonePath)}, JSON.stringify(marker) + '\\n', { mode: 0o600 })\n`,
  )
  await assert.rejects(
    execFileAsync(
      process.execPath,
      runArguments(paths, 'generation-token-owner', orchestrator, {
        finalVerifierPath: tokenMismatch,
      }),
      { encoding: 'utf8' },
    ),
    /category=marker-(?:identity|owner)/u,
  )
  const markerAfterTokenMismatch = await readFile(paths.tombstonePath)

  const descriptorMismatch = await writeOrchestrator(
    paths.root,
    'foreign-descriptor-verifier.mjs',
    `import { chmod, rename, writeFile } from 'node:fs/promises'\n` +
      `if (process.env.HEXCLAW_PACKAGE_GENERATION_CONTEXT) process.exit(35)\n` +
      `const replacement = ${JSON.stringify(`${paths.tombstonePath}.foreign`)}\n` +
      'await writeFile(replacement, Buffer.from("foreign"), { flag: "wx", mode: 0o600 })\n' +
      'await chmod(replacement, 0o600)\n' +
      `await rename(replacement, ${JSON.stringify(paths.tombstonePath)})\n`,
  )
  await assert.rejects(
    execFileAsync(
      process.execPath,
      runArguments(paths, 'generation-descriptor-owner', orchestrator, {
        finalVerifierPath: descriptorMismatch,
      }),
      { encoding: 'utf8' },
    ),
    /category=marker-identity/u,
  )
  assert.notDeepEqual(await readFile(paths.tombstonePath), markerAfterTokenMismatch)
  assert.equal(await readFile(paths.tombstonePath, 'utf8'), 'foreign')
})

macOSTest(
  'state files reject relative paths, symlinks, hard links, and non-private permissions',
  async (t) => {
    const paths = await workspace(t)
    const { ensureGenerationTombstone, runWithPackageGenerationLock } = await import(moduleURL)

    await assert.rejects(
      ensureGenerationTombstone({ generationId: 'relative', tombstonePath: 'relative.marker' }),
      /category=invalid-path/u,
    )
    const writableParent = join(paths.root, 'world-writable-state')
    await mkdir(writableParent, { mode: 0o700 })
    await chmod(writableParent, 0o777)
    await assert.rejects(
      ensureGenerationTombstone({
        generationId: 'unsafe-parent',
        tombstonePath: join(writableParent, 'in-progress.json'),
      }),
      /category=path-parent-permissions/u,
    )
    await assert.rejects(
      runWithPackageGenerationLock({
        command: [process.execPath, await completedOrchestrator(paths)],
        cwd: paths.root,
        finalVerificationCommand: [process.execPath, paths.finalVerifierPath],
        generationId: 'same-state-path',
        lockPath: paths.tombstonePath,
        tombstonePath: paths.tombstonePath,
      }),
      /category=invalid-paths/u,
    )

    const symlinkTarget = join(paths.root, 'symlink-target')
    await writeFile(symlinkTarget, 'target', { mode: 0o600 })
    await symlink(symlinkTarget, paths.tombstonePath)
    await assert.rejects(
      ensureGenerationTombstone({
        generationId: 'symlink',
        tombstonePath: paths.tombstonePath,
      }),
      /category=marker-type/u,
    )
    assert.equal(await readFile(symlinkTarget, 'utf8'), 'target')
    await rm(paths.tombstonePath)

    await writeFile(paths.tombstonePath, 'hard-link', { mode: 0o600 })
    const markerAlias = join(paths.root, 'marker-alias')
    await link(paths.tombstonePath, markerAlias)
    await assert.rejects(
      ensureGenerationTombstone({
        generationId: 'hard-link',
        tombstonePath: paths.tombstonePath,
      }),
      /category=marker-hard-link/u,
    )
    await rm(markerAlias)
    await rm(paths.tombstonePath)

    await writeFile(paths.tombstonePath, 'public', { mode: 0o600 })
    await chmod(paths.tombstonePath, 0o644)
    await assert.rejects(
      ensureGenerationTombstone({
        generationId: 'permissions',
        tombstonePath: paths.tombstonePath,
      }),
      /category=marker-permissions/u,
    )
    await rm(paths.tombstonePath)

    const orchestrator = await completedOrchestrator(paths)
    const lockTarget = join(paths.root, 'lock-target')
    await writeFile(lockTarget, 'lock', { mode: 0o600 })
    await symlink(lockTarget, paths.lockPath)
    await assert.rejects(
      runWithPackageGenerationLock({
        command: [process.execPath, orchestrator],
        cwd: paths.root,
        finalVerificationCommand: [process.execPath, paths.finalVerifierPath],
        generationId: 'lock-symlink',
        lockPath: paths.lockPath,
        tombstonePath: paths.tombstonePath,
      }),
      /category=lock-type/u,
    )
    await rm(paths.lockPath)

    await writeFile(paths.lockPath, 'lock', { mode: 0o600 })
    const lockAlias = join(paths.root, 'lock-alias')
    await link(paths.lockPath, lockAlias)
    await assert.rejects(
      runWithPackageGenerationLock({
        command: [process.execPath, orchestrator],
        cwd: paths.root,
        finalVerificationCommand: [process.execPath, paths.finalVerifierPath],
        generationId: 'lock-hard-link',
        lockPath: paths.lockPath,
        tombstonePath: paths.tombstonePath,
      }),
      /category=lock-hard-link/u,
    )
    await rm(lockAlias)
    await rm(paths.lockPath)

    await writeFile(paths.lockPath, 'lock', { mode: 0o600 })
    await chmod(paths.lockPath, 0o666)
    await assert.rejects(
      runWithPackageGenerationLock({
        command: [process.execPath, orchestrator],
        cwd: paths.root,
        finalVerificationCommand: [process.execPath, paths.finalVerifierPath],
        generationId: 'lock-permissions',
        lockPath: paths.lockPath,
        tombstonePath: paths.tombstonePath,
      }),
      /category=lock-permissions/u,
    )
  },
)

macOSTest('CLI redacts child output and propagates its exit code', async (t) => {
  const paths = await workspace(t)
  const secret = 'sk-proj-SYNTHETIC_SECRET_MUST_NOT_ESCAPE_1234567890'
  const orchestrator = await writeOrchestrator(
    paths.root,
    'fail-with-secret.mjs',
    `process.stdout.write(${JSON.stringify(`${secret}:${paths.root}`)})\n` +
      `process.stderr.write(${JSON.stringify(`${secret}:${paths.tombstonePath}`)})\n` +
      'process.exit(23)\n',
  )

  await assert.rejects(
    execFileAsync(process.execPath, runArguments(paths, 'generation-secret-output', orchestrator), {
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
  await lstat(paths.tombstonePath)
})

macOSTest(
  'default orchestrator and verifier environments exclude host credentials and owner context',
  async (t) => {
    const paths = await workspace(t)
    const evidencePath = join(paths.root, 'environment-evidence')
    const secret = 'synthetic-provider-secret-that-must-not-propagate'
    const environmentProbe = (phase, append) =>
      `import { ${append ? 'appendFile' : 'writeFile'} } from 'node:fs/promises'\n` +
      `await ${append ? 'appendFile' : 'writeFile'}(${JSON.stringify(evidencePath)}, JSON.stringify({ phase: ${JSON.stringify(phase)}, context: process.env.HEXCLAW_PACKAGE_GENERATION_CONTEXT ?? null, provider: process.env.PROVIDER_API_KEY ?? null }) + '\\n'${append ? '' : ', { mode: 0o600 }'})\n`
    const orchestrator = await writeOrchestrator(
      paths.root,
      'environment-build.mjs',
      environmentProbe('orchestrator', false),
    )
    const verifier = await writeOrchestrator(
      paths.root,
      'environment-verifier.mjs',
      environmentProbe('verifier', true),
    )

    await execFileAsync(
      process.execPath,
      runArguments(paths, 'generation-clean-environment', orchestrator, {
        finalVerifierPath: verifier,
      }),
      {
        encoding: 'utf8',
        env: { ...process.env, PROVIDER_API_KEY: secret },
      },
    )
    const evidence = (await readFile(evidencePath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.deepEqual(evidence, [
      { context: null, phase: 'orchestrator', provider: null },
      { context: null, phase: 'verifier', provider: null },
    ])
  },
)

macOSTest('orchestrator signal is preserved without forwarding child output', async (t) => {
  const paths = await workspace(t)
  const orchestrator = await writeOrchestrator(
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
  await lstat(paths.tombstonePath)
})

macOSTest('hard timeout drains the complete orchestrator process group', async (t) => {
  const paths = await workspace(t)
  const identitiesPath = join(paths.root, 'timeout-identities.json')
  const orchestrator = await writeOrchestrator(
    paths.root,
    'timeout-tree.mjs',
    `import { spawn } from 'node:child_process'\n` +
      `import { writeFile } from 'node:fs/promises'\n` +
      `const descendant = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { stdio: 'ignore' })\n` +
      `process.on('SIGTERM', () => {})\n` +
      `await writeFile(${JSON.stringify(identitiesPath)}, JSON.stringify({ orchestrator: process.pid, descendant: descendant.pid }), { mode: 0o600 })\n` +
      `setInterval(() => {}, 1000)\n`,
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
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  }
  await lstat(paths.tombstonePath)
})

macOSTest(
  'fresh final verifier rejects work performed after an attempted early self-claim',
  async (t) => {
    const paths = await workspace(t)
    const artifactPath = join(paths.root, 'canonical-artifact')
    const orchestrator = await writeOrchestrator(
      paths.root,
      'early-self-claim.mjs',
      `import { writeFile } from 'node:fs/promises'\n` +
        `if (process.env.HEXCLAW_PACKAGE_GENERATION_CONTEXT) process.exit(35)\n` +
        `await writeFile(${JSON.stringify(artifactPath)}, 'verified-state', { mode: 0o600 })\n` +
        `await writeFile(${JSON.stringify(join(paths.root, '.package-generation-completion.forged.json'))}, 'forged', { mode: 0o600 })\n` +
        `await writeFile(${JSON.stringify(artifactPath)}, 'mutated-after-claim', { mode: 0o600 })\n`,
    )
    const verifier = await writeOrchestrator(
      paths.root,
      'fresh-verifier.mjs',
      `import { readFile } from 'node:fs/promises'\n` +
        `if (await readFile(${JSON.stringify(artifactPath)}, 'utf8') !== 'verified-state') process.exit(43)\n`,
    )

    await assert.rejects(
      execFileAsync(
        process.execPath,
        runArguments(paths, 'generation-early-self-claim', orchestrator, {
          finalVerifierPath: verifier,
        }),
        { encoding: 'utf8' },
      ),
      /category=final-verifier-exit exit=43/u,
    )
    await lstat(paths.tombstonePath)
  },
)

macOSTest('completion claim is owner-managed and leaves no stale claim', async (t) => {
  const paths = await workspace(t)
  const evidencePath = join(paths.root, 'execution-order')
  const orchestrator = await writeOrchestrator(
    paths.root,
    'ordered-build.mjs',
    `import { writeFile } from 'node:fs/promises'\n` +
      `if (process.env.HEXCLAW_PACKAGE_GENERATION_CONTEXT) process.exit(35)\n` +
      `await writeFile(${JSON.stringify(evidencePath)}, 'orchestrator\\n', { mode: 0o600 })\n`,
  )
  const verifier = await writeOrchestrator(
    paths.root,
    'ordered-final-verifier.mjs',
    `import { appendFile } from 'node:fs/promises'\n` +
      `if (process.env.HEXCLAW_PACKAGE_GENERATION_CONTEXT) process.exit(35)\n` +
      `await appendFile(${JSON.stringify(evidencePath)}, 'final-verifier\\n')\n`,
  )

  await execFileAsync(
    process.execPath,
    runArguments(paths, 'generation-private-claim', orchestrator, {
      finalVerifierPath: verifier,
    }),
    { encoding: 'utf8' },
  )
  assert.equal(await readFile(evidencePath, 'utf8'), 'orchestrator\nfinal-verifier\n')
  const entries = await readdir(paths.root)
  assert.equal(
    entries.some((name) => name.startsWith('.package-generation-completion.')),
    false,
  )
  await assert.rejects(lstat(paths.tombstonePath), { code: 'ENOENT' })
})

macOSTest(
  'CLI requires absolute Node and orchestrator paths and emits only English categories',
  async (t) => {
    const paths = await workspace(t)
    const orchestrator = await completedOrchestrator(paths)
    const invalidArgs = runArguments(paths, 'generation-invalid-command', orchestrator)
    invalidArgs[invalidArgs.indexOf(process.execPath)] = 'node'

    await assert.rejects(
      execFileAsync(process.execPath, invalidArgs, { encoding: 'utf8' }),
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
  },
)

macOSTest('fixture cleanup never signals an unregistered command-line match', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hexclaw-package-cleanup-ownership-'))
  const outsider = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', root], {
    stdio: 'ignore',
  })
  const identity = await processIdentity(outsider.pid)
  assert.ok(identity, 'Unregistered fixture identity must be observable')
  t.after(async () => {
    await signalRecordedProcess(identity, 'SIGKILL')
    await waitForRecordedProcessExit(identity)
    await rm(root, { recursive: true, force: true })
  })

  await cleanupFixtureProcesses(root)
  assert.equal(sameStableProcessIdentity(identity, await processIdentity(identity.pid)), true)
})

macOSTest('production generation lock contains no environment-activated test hook', async () => {
  const source = await readFile(modulePath, 'utf8')
  assert.doesNotMatch(
    source,
    /HEXCLAW_PACKAGE_LOCK_TEST_MODE|HEXCLAW_PACKAGE_LOCK_TEST_PRELOCK_READY_FILE/u,
  )
})

macOSTest('production generation state never renames or unlinks caller paths', async () => {
  const source = await readFile(modulePath, 'utf8')
  assert.doesNotMatch(source, /\b(?:rename|unlink)\s*\(/u)
})

macOSTest('arbitrary private state files outside the fixed control layout are rejected', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hexclaw-package-arbitrary-state-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const orchestrator = await writeOrchestrator(root, 'orchestrator.mjs', '')
  const verifier = await writeOrchestrator(root, 'verifier.mjs', '')
  const { runWithPackageGenerationLock } = await import(moduleURL)

  await assert.rejects(
    runWithPackageGenerationLock({
      command: [process.execPath, orchestrator],
      cwd: root,
      finalVerificationCommand: [process.execPath, verifier],
      generationId: 'generation-arbitrary-path',
      lockPath: join(root, 'attacker-owned-lock'),
      tombstonePath: join(root, 'attacker-owned-marker'),
    }),
    /category=invalid-control-path/u,
  )
})

macOSTest('fixed private control and generation plan layout is the only successful path', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hexclaw-package-fixed-layout-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const evidenceRoot = join(root, 'evidence')
  const controlDirectory = join(evidenceRoot, '.package-local.control')
  const generationId = 'generation-fixed-layout'
  const planRoot = join(evidenceRoot, '.package-local.generations', generationId)
  await mkdir(evidenceRoot, { mode: 0o700 })
  await mkdir(controlDirectory, { mode: 0o700 })
  await mkdir(dirname(planRoot), { mode: 0o700 })
  await mkdir(planRoot, { mode: 0o700 })
  const orchestrator = await writeOrchestrator(root, 'orchestrator.mjs', '')
  const verifier = await writeOrchestrator(root, 'verifier.mjs', '')
  const { runWithPackageGenerationLock } = await import(moduleURL)

  const result = await runWithPackageGenerationLock({
    command: [process.execPath, orchestrator],
    cwd: root,
    finalVerificationCommand: [process.execPath, verifier],
    generationId,
    lockPath: join(controlDirectory, '.package-local.lock'),
    planRoot,
    tombstonePath: join(controlDirectory, '.package-local.in-progress'),
  })
  assert.deepEqual(result, { exitCode: 0, generationId })
})

macOSTest('malformed existing marker is rejected before generation recovery', async (t) => {
  const paths = await workspace(t)
  await writeFile(paths.tombstonePath, '{"schema_version":"foreign"}\n', { mode: 0o600 })
  const orchestrator = await completedOrchestrator(paths, 'malformed-recovery.mjs')
  const { runWithPackageGenerationLock } = await import(moduleURL)

  await assert.rejects(
    runWithPackageGenerationLock({
      command: [process.execPath, orchestrator],
      cwd: paths.root,
      finalVerificationCommand: [process.execPath, paths.finalVerifierPath],
      generationId: 'generation-malformed-recovery',
      lockPath: paths.lockPath,
      tombstonePath: paths.tombstonePath,
    }),
    /category=marker-content/u,
  )
  assert.equal(await readFile(paths.tombstonePath, 'utf8'), '{"schema_version":"foreign"}\n')
})

macOSTest('held phase rejects fd3 when it is not the validated lock object', async (t) => {
  const paths = await workspace(t)
  const ownerToken = 'a'.repeat(64)
  const generationId = 'generation-foreign-fd3'
  const { ensureGenerationTombstone } = await import(moduleURL)
  await ensureGenerationTombstone({ generationId, ownerToken, tombstonePath: paths.tombstonePath })
  await writeFile(paths.lockPath, '', { mode: 0o600 })
  const lockIdentity = fileIdentity(await lstat(paths.lockPath, { bigint: true }))
  const foreignPath = join(paths.root, 'foreign-lock-object')
  await writeFile(foreignPath, '', { mode: 0o600 })
  const foreign = await open(foreignPath, 'r+')
  t.after(() => foreign.close().catch(() => undefined))
  const context = Buffer.from(
    JSON.stringify({
      commandOutputBytes: 1024,
      commandTimeoutMs: 2_000,
      completionClaimPath: join(paths.root, '.not-created'),
      generationId,
      lockIdentity,
      lockPath: paths.lockPath,
      ownerToken,
      schemaVersion: 'hexclaw.package-generation-context.v1',
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
  assert.equal(
    result.stderr,
    'ERROR: package-generation-lock category=lock-descriptor exit=70\n',
  )
})

macOSTest('SIGKILL after completion publication leaves one recoverable atomic state', async (t) => {
  const paths = await workspace(t)
  const monitorPIDPath = join(paths.root, 'completion-monitor.pid')
  const killedPath = join(paths.root, 'completion-held-killed')
  const monitorProgram = [
    "const {watch,writeFileSync}=require('node:fs')",
    'const [root,heldPID,evidence]=process.argv.slice(1)',
    "const watcher=watch(root,(event,name)=>{if(String(name).startsWith('.package-generation-completion.')){try{process.kill(Number(heldPID),'SIGKILL')}catch{};writeFileSync(evidence,heldPID);watcher.close()}})",
    'setTimeout(()=>process.exit(74),10000)',
  ].join(';')
  const verifier = await writeOrchestrator(
    paths.root,
    'completion-crash-verifier.mjs',
    `import { spawn } from 'node:child_process'\n` +
      `import { writeFile } from 'node:fs/promises'\n` +
      `const monitor = spawn(process.execPath, ['-e', ${JSON.stringify(monitorProgram)}, ${JSON.stringify(paths.root)}, String(process.ppid), ${JSON.stringify(killedPath)}], { detached: true, stdio: 'ignore' })\n` +
      `await writeFile(${JSON.stringify(monitorPIDPath)}, String(monitor.pid), { mode: 0o600 })\n` +
      `monitor.unref()\n`,
  )
  const orchestrator = await completedOrchestrator(paths, 'completion-crash-build.mjs')
  const wrapper = spawn(
    process.execPath,
    runArguments(paths, 'generation-completion-crash', orchestrator, {
      finalVerifierPath: verifier,
    }),
    { detached: true, stdio: ['ignore', 'ignore', 'ignore'] },
  )
  await registerFixtureRoot(paths.root, wrapper.pid)
  await waitForFile(monitorPIDPath)
  const monitorPID = Number(await readFile(monitorPIDPath, 'utf8'))
  const monitorIdentity = await processIdentity(monitorPID)
  if (monitorIdentity) {
    const ownership = fixtureOwnership.get(paths.root)
    ownership.identities.set(monitorIdentity.pid, monitorIdentity)
    ownership.roots.add(monitorIdentity.pid)
  }
  await waitForFile(killedPath, 10_000)
  await waitForChild(wrapper)

  const recovery = await completedOrchestrator(paths, 'completion-crash-recovery.mjs')
  await execFileAsync(
    process.execPath,
    runArguments(paths, 'generation-after-completion-crash', recovery),
    { encoding: 'utf8' },
  )
  const entries = await readdir(paths.root)
  assert.equal(
    entries.some((name) => name.startsWith('.package-generation-completion.')),
    false,
  )
})
