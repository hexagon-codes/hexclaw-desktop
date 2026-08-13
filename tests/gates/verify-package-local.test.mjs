import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

import { createReleaseAttestation } from '../../scripts/ci/k12-release-ui-attestation.mjs'

const verifierModuleURL = new URL('../../scripts/ci/verify-package-local.mjs', import.meta.url)
const execFileAsync = promisify(execFile)

async function loadVerifier() {
  return import(verifierModuleURL)
}

async function fixture(name) {
  const root = await realpath(await mkdtemp(join(tmpdir(), `hexclaw-package-verifier-${name}-`)))
  const distRoot = join(root, 'dist')
  const localAppBundle = join(root, 'HexClaw.app')
  const macOSDirectory = join(localAppBundle, 'Contents', 'MacOS')
  const resourcesDirectory = join(localAppBundle, 'Contents', 'Resources')
  const installedAppBinary = join(macOSDirectory, 'hexclaw-desktop')
  const sidecarBinary = join(macOSDirectory, 'hexclaw')
  const packagePath = join(root, 'HexClaw.dmg')
  const manifestPath = join(root, 'release-ui-dist-manifest.json')
  const receiptPath = join(root, 'release-ui-attestation.json')
  const sourceManifestPath = join(root, 'source-manifest.json')
  const sourceManifestBytes = Buffer.from('{"schema":"source-fixture-v1"}\n')
  const sourceManifestSHA256 = createHash('sha256').update(sourceManifestBytes).digest('hex')
  const generationId = 'a'.repeat(32)
  const targetTriple = 'x86_64-apple-darwin'

  await mkdir(distRoot, { recursive: true, mode: 0o700 })
  await mkdir(macOSDirectory, { recursive: true, mode: 0o700 })
  await mkdir(resourcesDirectory, { recursive: true, mode: 0o700 })
  await writeFile(join(distRoot, 'index.html'), '<main>HexClaw</main>\n')
  await writeFile(installedAppBinary, 'desktop-binary\n')
  await writeFile(sidecarBinary, 'sidecar-binary\n')
  await writeFile(packagePath, 'dmg-bytes\n')
  await writeFile(sourceManifestPath, sourceManifestBytes, { mode: 0o600 })
  await writeFile(join(resourcesDirectory, 'asset-v1.txt'), 'asset-v1\n')
  await writeFile(join(resourcesDirectory, 'asset-v2.txt'), 'asset-v2\n')
  await chmod(installedAppBinary, 0o700)
  await chmod(sidecarBinary, 0o700)

  const attestation = await createReleaseAttestation({
    distRoot,
    releaseVersion: '0.5.0-beta',
    installedAppBinary,
    sidecarBinary,
    packagePath,
    manifestPath,
    receiptPath,
    sourceManifestPath,
    sourceManifestSHA256,
    generationId,
    targetTriple,
  })
  return {
    root,
    distRoot,
    releaseVersion: '0.5.0-beta',
    localAppBundle,
    installedAppBinary,
    sidecarBinary,
    packagePath,
    manifestPath,
    receiptPath,
    sourceManifestPath,
    expectedReceiptSHA256: attestation.receiptSHA256,
    expectedSourceManifestSHA256: sourceManifestSHA256,
    expectedGenerationId: generationId,
    expectedTargetTriple: targetTriple,
    notBeforeEpochSeconds: 0,
  }
}

async function refreshAttestation(paths) {
  const attestation = await createReleaseAttestation({
    distRoot: paths.distRoot,
    releaseVersion: paths.releaseVersion,
    installedAppBinary: paths.installedAppBinary,
    sidecarBinary: paths.sidecarBinary,
    packagePath: paths.packagePath,
    manifestPath: paths.manifestPath,
    receiptPath: paths.receiptPath,
    sourceManifestPath: paths.sourceManifestPath,
    sourceManifestSHA256: paths.expectedSourceManifestSHA256,
    generationId: paths.expectedGenerationId,
    targetTriple: paths.expectedTargetTriple,
  })
  paths.expectedReceiptSHA256 = attestation.receiptSHA256
}

function commandResult(code, stderr = '', stdout = '') {
  return { code, signal: null, stdout, stderr }
}

async function commandAdapter(paths, scenario = '') {
  const calls = []
  const readinessCalls = []
  let mountDirectory = ''

  const clearMountedTree = async () => {
    if (!mountDirectory) return
    const entries = await readdir(mountDirectory).catch(() => [])
    await Promise.all(
      entries.map((entry) => rm(join(mountDirectory, entry), { recursive: true, force: true })),
    )
  }

  return {
    calls,
    readinessCalls,
    get mountDirectory() {
      return mountDirectory
    },
    createMountDirectory: async () => {
      mountDirectory = await mkdtemp(join(tmpdir(), 'hexclaw-package-mount-'))
      return mountDirectory
    },
    verifyReadiness: async (packagePath, generationId) => {
      assert.equal(packagePath, paths.packagePath)
      assert.equal(generationId, paths.expectedGenerationId)
      readinessCalls.push({ generationId, packagePath })
    },
    runCommand: async (command, args, options) => {
      calls.push({ command, args: [...args], options: { ...options } })
      const action = `${basename(command)}:${args[0] ?? ''}`

      if (action === 'xattr:-r' || action === 'ls:-leR') return commandResult(0)

      if (action === 'hdiutil:verify') {
        return scenario === 'checksum' ? commandResult(1, 'checksum invalid') : commandResult(0)
      }
      if (action === 'hdiutil:attach') {
        if (scenario === 'mount') return commandResult(1, 'mount failed')
        await cp(paths.localAppBundle, join(mountDirectory, 'HexClaw.app'), {
          recursive: true,
          verbatimSymlinks: true,
        })
        if (scenario === 'app-mode') {
          await chmod(
            join(mountDirectory, 'HexClaw.app', 'Contents', 'MacOS', 'hexclaw-desktop'),
            0o600,
          )
        }
        const mountedAsset = join(
          mountDirectory,
          'HexClaw.app',
          'Contents',
          'Resources',
          'asset-v2.txt',
        )
        if (scenario === 'app-path') await rm(mountedAsset)
        if (scenario === 'app-type') {
          await rm(mountedAsset)
          await mkdir(mountedAsset)
        }
        if (scenario === 'app-size') await writeFile(mountedAsset, 'asset-v2-expanded\n')
        if (scenario === 'app-bytes') await writeFile(mountedAsset, 'asset-v3\n')
        if (scenario !== 'missing-symlink') {
          await symlink(
            scenario === 'wrong-symlink' ? '/WrongApplications' : '/Applications',
            join(mountDirectory, 'Applications'),
          )
        }
        if (scenario === 'extra-root-evidence') {
          await writeFile(join(mountDirectory, 'legacy-release-receipt.json'), '{}\n')
        }
        if (scenario === 'partial-attach') return commandResult(1, 'attach reported failure')
        return commandResult(0)
      }
      if (action === 'diff:-qr') {
        return scenario === 'diff' || scenario === 'diff-and-detach' || scenario === 'app-bytes'
          ? commandResult(1, 'app tree differs')
          : commandResult(0)
      }
      if (action === 'codesign:--verify') {
        if (scenario === 'signed') return commandResult(0)
        if (scenario === 'unsigned-architecture') {
          return commandResult(
            1,
            `${args.at(-1)}: code object is not signed at all\nIn architecture: x86_64`,
          )
        }
        if (scenario === 'unsupported-architecture') {
          return commandResult(
            1,
            `${args.at(-1)}: code object is not signed at all\nIn architecture: ppc`,
          )
        }
        if (scenario === 'unexpected-codesign')
          return commandResult(1, 'resource envelope is obsolete')
        if (scenario === 'mixed-codesign') {
          return commandResult(
            1,
            `${args.at(-1)}: code object is not signed at all\nresource envelope is obsolete`,
          )
        }
        return commandResult(1, `${args.at(-1)}: code object is not signed at all`)
      }
      if (action === 'hdiutil:detach') {
        const forced = args.includes('-force')
        if ((scenario === 'detach' || scenario === 'diff-and-detach') && !forced) {
          return commandResult(1, 'detach busy')
        }
        if (scenario === 'detach-removes-mountpoint') {
          await rm(mountDirectory, { recursive: true, force: true })
          return commandResult(0)
        }
        await clearMountedTree()
        return commandResult(0)
      }
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`)
    },
  }
}

async function assertMountRemoved(adapter) {
  await assert.rejects(lstat(adapter.mountDirectory), { code: 'ENOENT' })
}

async function waitForChildClose(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true
  return new Promise((resolvePromise) => {
    const onClose = () => {
      clearTimeout(timer)
      resolvePromise(true)
    }
    const timer = setTimeout(() => {
      child.off('close', onClose)
      resolvePromise(false)
    }, timeoutMs)
    child.once('close', onClose)
  })
}

async function stopDetachedProcessGroup(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error
  }
  if (await waitForChildClose(child, 500)) return
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error
  }
  assert.equal(await waitForChildClose(child, 1_000), true)
}

test('canonical package verifier checks attestation, DMG, mounted app, symlink and unsigned policy in order', async () => {
  const paths = await fixture('success')
  const adapter = await commandAdapter(paths)
  const { verifyPackageLocal } = await loadVerifier()

  const result = await verifyPackageLocal(paths, adapter)

  assert.equal(result.receiptSHA256, paths.expectedReceiptSHA256)
  assert.equal(result.sensitiveBoundaryVerified, true)
  assert.equal(adapter.readinessCalls.length, 2)
  assert.deepEqual(
    adapter.calls.map(({ command, args }) => `${command}:${args[0]}`),
    [
      '/usr/bin/xattr:-r',
      '/bin/ls:-leR',
      '/usr/bin/xattr:-r',
      '/bin/ls:-leR',
      '/usr/bin/hdiutil:verify',
      '/usr/bin/hdiutil:attach',
      '/usr/bin/diff:-qr',
      '/usr/bin/xattr:-r',
      '/bin/ls:-leR',
      '/usr/bin/codesign:--verify',
      '/usr/bin/hdiutil:detach',
    ],
  )
  for (const call of adapter.calls) {
    assert.equal(call.command.startsWith('/'), true)
    assert.equal(Object.hasOwn(call.options, 'shell'), false)
    assert.equal(Number.isSafeInteger(call.options.timeoutMs), true)
    assert.equal(Number.isSafeInteger(call.options.maxOutputBytes), true)
  }
  const attachCall = adapter.calls.find(
    ({ command, args }) => command === '/usr/bin/hdiutil' && args[0] === 'attach',
  )
  assert.equal(attachCall.args.includes('-readonly') && attachCall.args.includes('-nobrowse'), true)
  const codesignCall = adapter.calls.find(({ command }) => command === '/usr/bin/codesign')
  assert.deepEqual(codesignCall.options.acceptedExitCodes, [0, 1])
  await assertMountRemoved(adapter)
})

test('canonical package verifier rejects a tombstone or held lock before attestation', async (t) => {
  const paths = await fixture('readiness-first')
  paths.expectedReceiptSHA256 = '0'.repeat(64)
  const adapter = await commandAdapter(paths)
  delete adapter.verifyReadiness
  const { verifyPackageLocal } = await loadVerifier()
  const controlPath = join(paths.root, '.package-local.control')
  const markerPath = join(controlPath, '.package-local.in-progress')
  const lockPath = join(controlPath, '.package-local.lock')

  await mkdir(markerPath, { recursive: true, mode: 0o700 })
  await writeFile(join(markerPath, 'invalid.started.json'), '{"state":"building"}\n', {
    mode: 0o600,
  })
  await assert.rejects(verifyPackageLocal(paths, adapter), /package readiness check failed/)
  await rm(markerPath, { recursive: true })

  const buildPath = join(paths.root, 'readiness-build.mjs')
  const finalPath = join(paths.root, 'readiness-final.mjs')
  await writeFile(buildPath, '', { mode: 0o600 })
  await writeFile(finalPath, '', { mode: 0o600 })
  const { runWithPackageGenerationLock } =
    await import('../../scripts/ci/package-generation-lock.mjs')
  await runWithPackageGenerationLock({
    command: [process.execPath, buildPath],
    cwd: paths.root,
    finalVerificationCommand: [process.execPath, finalPath],
    generationId: paths.expectedGenerationId,
    lockPath,
    planRoot: join(paths.root, '.package-local.generations', paths.expectedGenerationId),
    tombstonePath: markerPath,
  })

  // 唯一 completed generation 已建立，readiness 通过后才会进入 attestation。
  await assert.rejects(verifyPackageLocal(paths, adapter), /release attestation failed/)
  const lockMetadata = await lstat(lockPath)
  assert.equal(lockMetadata.mode & 0o777, 0o600)
  assert.equal(lockMetadata.nlink, 1)
  if (typeof process.getuid === 'function') assert.equal(lockMetadata.uid, process.getuid())

  const readyPath = join(paths.root, 'lock-ready')
  const holder = spawn(
    '/usr/bin/lockf',
    [
      lockPath,
      process.execPath,
      '-e',
      `require('node:fs').writeFileSync(${JSON.stringify(readyPath)},'ready');setTimeout(()=>process.exit(0),10000)`,
    ],
    { detached: true, stdio: 'ignore' },
  )
  t.after(() => stopDetachedProcessGroup(holder))
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline && !(await lstat(readyPath).catch(() => null))) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
  }
  assert.ok(await lstat(readyPath))
  await assert.rejects(verifyPackageLocal(paths, adapter), /package build is in progress/)
  await stopDetachedProcessGroup(holder)

  await assert.rejects(verifyPackageLocal(paths, adapter), /release attestation failed/)
  assert.deepEqual(adapter.calls, [])
  assert.equal(adapter.mountDirectory, '')
})

test('canonical package verifier reuses the sensitive boundary before every system command', async () => {
  const paths = await fixture('sensitive-first')
  const marker = ['synthetic', 'dist', 'secret', 'marker'].join('-')
  await writeFile(join(paths.distRoot, '.env'), marker)
  await refreshAttestation(paths)
  const adapter = await commandAdapter(paths)
  const { verifyPackageLocal } = await loadVerifier()

  await assert.rejects(verifyPackageLocal(paths, adapter), (error) => {
    assert.match(error.message, /sensitive boundary failed/)
    assert.equal(error.message.includes('.env'), false)
    assert.equal(error.message.includes(marker), false)
    return true
  })
  assert.equal(
    adapter.calls.some(({ command }) =>
      ['/usr/bin/hdiutil', '/usr/bin/diff', '/usr/bin/codesign'].includes(command),
    ),
    false,
  )
  assert.equal(adapter.mountDirectory, '')
})

test('canonical package verifier fails closed for checksum, mount, app tree and symlink drift', async () => {
  const { verifyPackageLocal } = await loadVerifier()
  for (const [scenario, message] of [
    ['checksum', /DMG checksum verification failed/],
    ['mount', /DMG mount failed/],
    ['diff', /packaged app tree differs/],
    ['app-path', /app tree entry set differs/],
    ['app-type', /app tree entry type differs/],
    ['app-mode', /app tree entry mode differs/],
    ['app-size', /app tree file size differs/],
    ['app-bytes', /packaged app tree differs/],
    ['missing-symlink', /DMG root entry set differs/],
    ['wrong-symlink', /Applications symbolic link must target \/Applications/],
    ['extra-root-evidence', /DMG root entry set differs/],
  ]) {
    const paths = await fixture(scenario)
    const adapter = await commandAdapter(paths, scenario)
    await assert.rejects(verifyPackageLocal(paths, adapter), message)
    if (adapter.mountDirectory) await assertMountRemoved(adapter)
  }
})

test('canonical package verifier accepts only the expected unsigned codesign failure', async () => {
  const { verifyPackageLocal } = await loadVerifier()
  for (const [scenario, message] of [
    ['signed', /packaged app is signed; expected intentionally unsigned/],
    ['unexpected-codesign', /codesign failed for an unexpected reason/],
    ['mixed-codesign', /codesign failed for an unexpected reason/],
    ['unsupported-architecture', /codesign failed for an unexpected reason/],
  ]) {
    const paths = await fixture(scenario)
    const adapter = await commandAdapter(paths, scenario)
    await assert.rejects(verifyPackageLocal(paths, adapter), message)
    await assertMountRemoved(adapter)
  }
})

test('canonical package verifier accepts the standard unsigned architecture detail only', async () => {
  const paths = await fixture('unsigned-architecture')
  const adapter = await commandAdapter(paths, 'unsigned-architecture')
  const { runBoundedCommand, verifyPackageLocal } = await loadVerifier()

  const unsignedBinary = join(paths.root, 'unsigned-mach-o')
  await cp('/usr/bin/true', unsignedBinary)
  await runBoundedCommand('/usr/bin/codesign', ['--remove-signature', unsignedBinary])
  const realCodesign = await runBoundedCommand(
    '/usr/bin/codesign',
    ['--verify', '--deep', '--strict', '--verbose=4', unsignedBinary],
    { acceptedExitCodes: [0, 1] },
  )
  assert.equal(realCodesign.code, 1)
  assert.match(realCodesign.stderr, /code object is not signed at all/u)

  const result = await verifyPackageLocal(paths, adapter)

  assert.equal(result.unsignedVerified, true)
  await assertMountRemoved(adapter)
})

test('canonical package verifier merges primary and detach failures and force-cleans the mount', async () => {
  const paths = await fixture('diff-and-detach')
  const adapter = await commandAdapter(paths, 'diff-and-detach')
  const { verifyPackageLocal } = await loadVerifier()

  await assert.rejects(verifyPackageLocal(paths, adapter), (error) => {
    assert.equal(error instanceof AggregateError, true)
    const messages = error.errors.map((entry) => entry.message).join('\n')
    assert.match(messages, /packaged app tree differs/)
    assert.match(messages, /DMG detach failed/)
    return true
  })
  assert.equal(
    adapter.calls.some(
      ({ command, args }) => command === '/usr/bin/hdiutil' && args.includes('-force'),
    ),
    true,
  )
  await assertMountRemoved(adapter)
})

test('canonical package verifier cleans a partial attach and preserves the attach error', async () => {
  const paths = await fixture('partial-attach')
  const adapter = await commandAdapter(paths, 'partial-attach')
  const { verifyPackageLocal } = await loadVerifier()

  await assert.rejects(verifyPackageLocal(paths, adapter), /DMG mount failed \(exit 1\)/)
  assert.equal(
    adapter.calls.some(
      ({ command, args }) => command === '/usr/bin/hdiutil' && args[0] === 'detach',
    ),
    true,
  )
  await assertMountRemoved(adapter)
})

test('canonical package verifier accepts cleanup when detach already removed the mountpoint', async () => {
  const paths = await fixture('detach-removes-mountpoint')
  const adapter = await commandAdapter(paths, 'detach-removes-mountpoint')
  const { verifyPackageLocal } = await loadVerifier()

  const result = await verifyPackageLocal(paths, adapter)

  assert.equal(result.receiptSHA256, paths.expectedReceiptSHA256)
  await assertMountRemoved(adapter)
})

test('bounded command runner enforces absolute commands, output limits and timeouts', async () => {
  const { runBoundedCommand } = await loadVerifier()
  await assert.rejects(runBoundedCommand('printf', ['hello']), /command must be an absolute path/)
  await assert.rejects(
    runBoundedCommand('/usr/bin/printf', ['%s', 'x'.repeat(1024)], {
      timeoutMs: 1_000,
      maxOutputBytes: 32,
    }),
    /command output exceeded its limit/,
  )
  await assert.rejects(
    runBoundedCommand(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
      timeoutMs: 50,
      maxOutputBytes: 32,
    }),
    /command timed out/,
  )
  const accepted = await runBoundedCommand(
    process.execPath,
    ['-e', 'process.stdout.write("bounded");process.exit(1)'],
    { acceptedExitCodes: [0, 1] },
  )
  assert.equal(accepted.code, 1)
  assert.equal(accepted.stdout, 'bounded')
})

test(
  'verifier CLI never exposes command output absolute paths control bytes or marker values',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const marker = `synthetic-command-output-marker-${process.pid}`
    const paths = await fixture(marker)
    t.after(() => rm(paths.root, { recursive: true, force: true }))
    const args = [
      '--app-bundle',
      paths.localAppBundle,
      '--dist',
      paths.distRoot,
      '--expected-receipt-sha256',
      paths.expectedReceiptSHA256,
      '--generation-id',
      paths.expectedGenerationId,
      '--installed-app',
      paths.installedAppBinary,
      '--manifest',
      paths.manifestPath,
      '--not-before-epoch-seconds',
      '0',
      '--package',
      paths.packagePath,
      '--receipt',
      paths.receiptPath,
      '--release-version',
      paths.releaseVersion,
      '--sidecar',
      paths.sidecarBinary,
      '--source-manifest',
      paths.sourceManifestPath,
      '--source-manifest-sha256',
      paths.expectedSourceManifestSHA256,
      '--target-triple',
      paths.expectedTargetTriple,
    ]

    await assert.rejects(
      execFileAsync(process.execPath, [verifierModuleURL.pathname, ...args], {
        cwd: paths.root,
        env: { ...process.env },
      }),
      (error) => {
        const output = `${error.stdout ?? ''}\n${error.stderr ?? ''}`
        assert.match(
          output,
          /^\s*ERROR: package-local-verifier category=[a-z0-9-]+(?: exit=\d+| signal=[A-Z0-9]+)*\s*$/u,
        )
        assert.equal(output.includes(marker), false)
        assert.equal(output.includes(paths.root), false)
        assert.doesNotMatch(output, /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u)
        return true
      },
    )
  },
)
