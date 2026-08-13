import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const moduleURL = new URL('../../scripts/ci/run-bounded-process.mjs', import.meta.url)
const execFileAsync = promisify(execFile)

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

async function signalRecordedProcess(identity, identities, signal) {
  const current = await processIdentity(identity.pid)
  if (!sameStableProcessIdentity(identity, current)) return
  if (current.ppid !== identity.ppid) {
    const recordedParent = identities.find(({ pid }) => pid === identity.ppid)
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

async function waitForRecordedProcesses(identities, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const current = await Promise.all(identities.map(({ pid }) => processIdentity(pid)))
    if (current.every((value, index) => !sameStableProcessIdentity(identities[index], value)))
      return
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20))
  }
  assert.fail('Recorded fixture processes did not exit')
}

async function cleanupRecordedProcesses(identities) {
  await Promise.all(
    identities.map((identity) => signalRecordedProcess(identity, identities, 'SIGTERM')),
  )
  try {
    await waitForRecordedProcesses(identities, 500)
    return
  } catch {
    await Promise.all(
      identities.map((identity) => signalRecordedProcess(identity, identities, 'SIGKILL')),
    )
  }
  await waitForRecordedProcesses(identities)
}

function waitForChild(child, timeoutMs = 5_000) {
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

test('bounded process runner returns finite output for a successful command', async () => {
  const { runBoundedProcess } = await import(moduleURL)
  const result = await runBoundedProcess(process.execPath, ['-e', 'process.stdout.write("ok")'], {
    cwd: tmpdir(),
    env: {},
    maxOutputBytes: 32,
    timeoutMs: 2_000,
  })

  assert.equal(result.code, 0)
  assert.equal(result.stdout, 'ok')
  assert.equal(result.stderr, '')
})

test('bounded process runner waits until a TERM-resistant descendant is killed', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hexclaw-process-tree-'))
  const pidFile = join(root, 'grandchild.pid')
  t.after(() => rm(root, { recursive: true, force: true }))
  const { runBoundedProcess } = await import(moduleURL)
  const program = [
    "const {spawn}=require('node:child_process')",
    "const {writeFileSync}=require('node:fs')",
    "const child=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});process.send('ready');process.disconnect();setTimeout(()=>process.exit(74),15000)\"],{stdio:['ignore','ignore','ignore','ipc']})",
    `child.once('message',()=>writeFileSync(${JSON.stringify(pidFile)},String(child.pid)))`,
    "process.on('SIGTERM',()=>process.exit(0))",
    'setTimeout(()=>process.exit(74),15000)',
  ].join(';')

  const startedAt = Date.now()
  await assert.rejects(
    runBoundedProcess(process.execPath, ['-e', program], {
      cwd: root,
      env: {},
      maxOutputBytes: 1024,
      timeoutMs: 2_000,
      terminateGraceMs: 150,
      terminateConfirmMs: 1_000,
    }),
    /category=timeout/,
  )
  assert.ok(Date.now() - startedAt >= 2_100, 'runner must wait through the TERM grace period')
  const grandchildPID = Number(await readFile(pidFile, 'utf8'))
  assert.throws(() => process.kill(grandchildPID, 0), { code: 'ESRCH' })
})

test('bounded process runner rejects a successful parent whose process group still has a child', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hexclaw-process-leak-'))
  const pidFile = join(root, 'grandchild.pid')
  t.after(() => rm(root, { recursive: true, force: true }))
  const { runBoundedProcess } = await import(moduleURL)
  const program = [
    "const {spawn}=require('node:child_process')",
    "const {writeFileSync}=require('node:fs')",
    "const child=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});process.send('ready');process.disconnect();setTimeout(()=>process.exit(74),15000)\"],{stdio:['ignore','ignore','ignore','ipc']})",
    `child.once('message',()=>{writeFileSync(${JSON.stringify(pidFile)},String(child.pid));child.disconnect();child.unref();process.exit(0)})`,
  ].join(';')

  await assert.rejects(
    runBoundedProcess(process.execPath, ['-e', program], {
      cwd: root,
      env: {},
      maxOutputBytes: 1024,
      timeoutMs: 2_000,
      terminateGraceMs: 100,
      terminateConfirmMs: 1_000,
    }),
    /category=process-tree-leak/,
  )
  const grandchildPID = Number(await readFile(pidFile, 'utf8'))
  assert.throws(() => process.kill(grandchildPID, 0), { code: 'ESRCH' })
})

test('bounded process runner fails closed when combined output exceeds its limit', async () => {
  const { runBoundedProcess } = await import(moduleURL)
  await assert.rejects(
    runBoundedProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(1024))'], {
      cwd: tmpdir(),
      env: {},
      maxOutputBytes: 32,
      timeoutMs: 2_000,
    }),
    /category=output-limit/,
  )
})

test('bounded process runner returns only explicitly accepted nonzero exit codes', async () => {
  const { runBoundedProcess } = await import(moduleURL)
  const marker = 'bounded-nonzero-output'
  const options = {
    cwd: tmpdir(),
    env: {},
    maxOutputBytes: 1024,
    timeoutMs: 2_000,
  }
  await assert.rejects(
    runBoundedProcess(
      process.execPath,
      ['-e', `process.stdout.write(${JSON.stringify(marker)});process.exit(1)`],
      options,
    ),
    /category=exit exit=1/,
  )
  const result = await runBoundedProcess(
    process.execPath,
    ['-e', `process.stdout.write(${JSON.stringify(marker)});process.exit(1)`],
    { ...options, acceptedExitCodes: [0, 1] },
  )
  assert.equal(result.code, 1)
  assert.equal(result.stdout, marker)

  for (const acceptedExitCodes of [
    [],
    [0, 0],
    [-1],
    [256],
    Array.from({ length: 17 }, (_, i) => i),
  ]) {
    await assert.rejects(
      runBoundedProcess(process.execPath, [], { ...options, acceptedExitCodes }),
      /category=invalid-exit-policy/,
    )
  }
})

test('bounded process runner requires an absolute cwd and an explicit clean environment', async () => {
  const { runBoundedProcess } = await import(moduleURL)

  await assert.rejects(
    runBoundedProcess(process.execPath, [], { cwd: '.', env: {} }),
    /category=invalid-cwd/,
  )
  await assert.rejects(
    runBoundedProcess(process.execPath, [], { cwd: tmpdir() }),
    /category=invalid-environment/,
  )
  await assert.rejects(runBoundedProcess(process.execPath, [], null), /category=invalid-options/)
  await assert.rejects(
    runBoundedProcess(`${process.execPath}\0suffix`, [], { cwd: tmpdir(), env: {} }),
    /category=invalid-command/,
  )
  await assert.rejects(
    runBoundedProcess(process.execPath, ['bad\0argument'], { cwd: tmpdir(), env: {} }),
    /category=invalid-arguments/,
  )
  await assert.rejects(
    runBoundedProcess(process.execPath, [], { cwd: `${tmpdir()}\0suffix`, env: {} }),
    /category=invalid-cwd/,
  )
  await assert.rejects(
    runBoundedProcess(process.execPath, [], {
      cwd: tmpdir(),
      env: { MARKER: 'bad\0value' },
    }),
    /category=invalid-environment/,
  )
  for (const unknown of [{ shell: false }, { rejectNonZero: false }, { timeoutMS: 1 }]) {
    await assert.rejects(
      runBoundedProcess(process.execPath, [], { cwd: tmpdir(), env: {}, ...unknown }),
      /category=unknown-option/,
    )
  }
})

test('bounded process internal FD bridge accepts only a finite numeric mapping', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hexclaw-process-fd-'))
  const inputPath = join(root, 'input')
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(inputPath, 'fd-three')
  const input = await open(inputPath, 'r')
  t.after(() => input.close().catch(() => undefined))
  const { runBoundedProcessWithFileDescriptors } = await import(moduleURL)

  const result = await runBoundedProcessWithFileDescriptors(
    process.execPath,
    ['-e', 'process.stdout.write(require("node:fs").readFileSync(3,"utf8"))'],
    { cwd: root, env: {}, maxOutputBytes: 32, timeoutMs: 2_000 },
    [{ childFd: 3, sourceFd: input.fd }],
  )
  assert.equal(result.stdout, 'fd-three')

  for (const mappings of [
    null,
    [],
    [{ childFd: 2, sourceFd: input.fd }],
    [{ childFd: 3, sourceFd: -1 }],
    [{ childFd: 3, sourceFd: input.fd, mode: 'pipe' }],
    [
      { childFd: 3, sourceFd: input.fd },
      { childFd: 3, sourceFd: input.fd },
    ],
  ]) {
    await assert.rejects(
      runBoundedProcessWithFileDescriptors(
        process.execPath,
        ['-e', ''],
        { cwd: root, env: {} },
        mappings,
      ),
      /category=invalid-file-descriptors/,
    )
  }
})

test('bounded process runner rejects limits that exceed the package hard ceilings', async () => {
  const { runBoundedProcess } = await import(moduleURL)
  const base = { cwd: tmpdir(), env: {} }
  await assert.rejects(
    runBoundedProcess(process.execPath, [], { ...base, timeoutMs: 60 * 60 * 1_000 + 1 }),
    /category=invalid-timeout/,
  )
  await assert.rejects(
    runBoundedProcess(process.execPath, [], { ...base, maxOutputBytes: 16 * 1024 * 1024 + 1 }),
    /category=invalid-output-limit/,
  )
  await assert.rejects(
    runBoundedProcess(process.execPath, [], { ...base, terminateGraceMs: 2_001 }),
    /category=invalid-terminate-grace/,
  )
  await assert.rejects(
    runBoundedProcess(process.execPath, [], { ...base, terminateConfirmMs: 2_001 }),
    /category=invalid-terminate-confirm/,
  )
})

test('bounded process runner reports spawn failure asynchronously without retaining state', async () => {
  const { runBoundedProcess } = await import(moduleURL)
  const promise = runBoundedProcess('/definitely-not-a-real-hexclaw-command', [], {
    cwd: tmpdir(),
    env: {},
    timeoutMs: 2_000,
  })
  assert.equal(typeof promise?.then, 'function')
  await assert.rejects(promise, /category=start-failed/)

  const result = await runBoundedProcess(process.execPath, ['-e', ''], {
    cwd: tmpdir(),
    env: {},
    timeoutMs: 2_000,
  })
  assert.equal(result.code, 0)
})

test('bounded process CLI never forwards successful child output', async () => {
  const marker = 'SENSITIVE_CARGO_PATH_MARKER'
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [
      fileURLToPath(moduleURL),
      '--timeout-ms',
      '2000',
      '--cwd',
      tmpdir(),
      '--env',
      'LC_ALL=C',
      '--',
      process.execPath,
      '-e',
      `process.stdout.write(${JSON.stringify(marker)});process.stderr.write(${JSON.stringify(marker)})`,
    ],
    { encoding: 'utf8' },
  )

  assert.equal(stdout, 'PASS: bounded-process category=success\n')
  assert.equal(stderr, '')
  assert.equal(`${stdout}${stderr}`.includes(marker), false)
})

for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM']) {
  test(`bounded process runner drains its descendant group before handling ${signal}`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'hexclaw-parent-signal-'))
    const pidFile = join(root, 'descendants.json')
    const recorded = []
    const childProgram = [
      "const {spawn}=require('node:child_process')",
      "const {writeFileSync}=require('node:fs')",
      "const grandchild=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setTimeout(()=>process.exit(74),15000)\"],{stdio:'ignore'})",
      `writeFileSync(${JSON.stringify(pidFile)},JSON.stringify({child:process.pid,grandchild:grandchild.pid}))`,
      'setTimeout(()=>process.exit(74),15000)',
    ].join(';')
    const harnessProgram = [
      `import(${JSON.stringify(new URL(moduleURL).href)}).then(async({runBoundedProcess})=>{`,
      `try{await runBoundedProcess(process.execPath,['-e',${JSON.stringify(childProgram)}],{cwd:${JSON.stringify(root)},env:{},timeoutMs:10000,terminateGraceMs:100,terminateConfirmMs:1000})}`,
      "catch(error){process.stderr.write(error.category+'\\n');process.exitCode=1}})",
    ].join('')
    const harness = execFile(process.execPath, ['-e', harnessProgram])
    const harnessIdentity = await processIdentity(harness.pid)
    assert.ok(harnessIdentity, 'Harness identity must be recorded before signaling')
    recorded.push(harnessIdentity)
    t.after(async () => {
      await cleanupRecordedProcesses(recorded)
      await rm(root, { recursive: true, force: true })
    })

    const deadline = Date.now() + 3_000
    while (Date.now() < deadline) {
      try {
        await readFile(pidFile)
        break
      } catch {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
      }
    }
    const pids = JSON.parse(await readFile(pidFile, 'utf8'))
    for (const pid of [pids.child, pids.grandchild]) {
      const identity = await processIdentity(pid)
      assert.ok(identity, 'Fixture process identity must be recorded before signaling')
      recorded.push(identity)
    }
    await signalRecordedProcess(harnessIdentity, recorded, signal)
    assert.deepEqual(await waitForChild(harness), { code: 1, signal: null })
    await waitForRecordedProcesses(recorded)
  })
}

test('bounded process runner drains descendants before restoring SIGQUIT termination', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hexclaw-parent-sigquit-'))
  const pidFile = join(root, 'descendants.json')
  const recorded = []
  const childProgram = [
    "const {spawn}=require('node:child_process')",
    "const {writeFileSync}=require('node:fs')",
    "const grandchild=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setTimeout(()=>process.exit(74),15000)\"],{stdio:'ignore'})",
    `writeFileSync(${JSON.stringify(pidFile)},JSON.stringify({child:process.pid,grandchild:grandchild.pid}))`,
    'setTimeout(()=>process.exit(74),15000)',
  ].join(';')
  const harnessProgram = [
    `import(${JSON.stringify(new URL(moduleURL).href)}).then(({runBoundedProcess})=>`,
    `runBoundedProcess(process.execPath,['-e',${JSON.stringify(childProgram)}],{cwd:${JSON.stringify(root)},env:{},timeoutMs:10000,terminateGraceMs:100,terminateConfirmMs:1000}))`,
  ].join('')
  const harness = execFile(process.execPath, ['-e', harnessProgram])
  let harnessStderr = ''
  harness.stderr.on('data', (chunk) => {
    harnessStderr += chunk.toString('utf8')
  })
  const harnessIdentity = await processIdentity(harness.pid)
  assert.ok(harnessIdentity, 'Harness identity must be recorded before signaling')
  recorded.push(harnessIdentity)
  t.after(async () => {
    await cleanupRecordedProcesses(recorded)
    await rm(root, { recursive: true, force: true })
  })

  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    try {
      await readFile(pidFile)
      break
    } catch {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20))
    }
  }
  const pids = JSON.parse(await readFile(pidFile, 'utf8'))
  for (const pid of [pids.child, pids.grandchild]) {
    const identity = await processIdentity(pid)
    assert.ok(identity, 'Fixture process identity must be recorded before signaling')
    recorded.push(identity)
  }

  await signalRecordedProcess(harnessIdentity, recorded, 'SIGQUIT')
  const result = await waitForChild(harness)
  assert.deepEqual(result, { code: null, signal: 'SIGQUIT' }, harnessStderr)
  await waitForRecordedProcesses(recorded)
})

test('bounded process CLI preserves a child nonzero exit status', async () => {
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        fileURLToPath(moduleURL),
        '--timeout-ms',
        '2000',
        '--cwd',
        tmpdir(),
        '--env',
        'LC_ALL=C',
        '--',
        process.execPath,
        '-e',
        'process.exit(23)',
      ],
      { encoding: 'utf8' },
    ),
    (error) => {
      assert.equal(error.code, 23)
      assert.equal(error.signal, null)
      assert.equal(error.stderr, 'ERROR: bounded-process category=exit exit=23\n')
      return true
    },
  )
})

test('bounded process CLI restores a child termination signal', async () => {
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        fileURLToPath(moduleURL),
        '--timeout-ms',
        '2000',
        '--cwd',
        tmpdir(),
        '--env',
        'LC_ALL=C',
        '--',
        process.execPath,
        '-e',
        'process.kill(process.pid, "SIGTERM")',
      ],
      { encoding: 'utf8' },
    ),
    (error) => {
      assert.equal(error.code, null)
      assert.equal(error.signal, 'SIGTERM')
      assert.equal(error.stderr, 'ERROR: bounded-process category=exit signal=SIGTERM\n')
      return true
    },
  )
})
