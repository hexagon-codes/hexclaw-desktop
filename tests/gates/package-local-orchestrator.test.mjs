import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { gzipSync } from 'node:zlib'

const moduleURL = new URL('../../scripts/ci/package-local.mjs', import.meta.url)
const execFileAsync = promisify(execFile)

function octalField(value, length) {
  return `${value.toString(8).padStart(length - 1, '0')}\0`
}

function tarEntry(name, body, type = '0', linkName = '') {
  const payload = Buffer.from(body)
  const storedPayload = type === '0' || type === 'x' ? payload : Buffer.alloc(0)
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, 'utf8')
  header.write(octalField(type === '5' ? 0o755 : 0o700, 8), 100, 8, 'ascii')
  header.write(octalField(0, 8), 108, 8, 'ascii')
  header.write(octalField(0, 8), 116, 8, 'ascii')
  header.write(octalField(storedPayload.length, 12), 124, 12, 'ascii')
  header.write(octalField(0, 12), 136, 12, 'ascii')
  header.fill(0x20, 148, 156)
  header.write(type, 156, 1, 'ascii')
  header.write(linkName, 157, 100, 'utf8')
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')
  const checksum = [...header].reduce((total, value) => total + value, 0)
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
  const padding = Buffer.alloc((512 - (storedPayload.length % 512)) % 512)
  return Buffer.concat([header, storedPayload, padding])
}

function paxRecord(key, value) {
  const suffix = Buffer.concat([Buffer.from(` ${key}=`), Buffer.from(value), Buffer.from('\n')])
  let length = suffix.length + 2
  while (`${length}`.length + suffix.length !== length) {
    length = `${length}`.length + suffix.length
  }
  return Buffer.concat([Buffer.from(`${length}`), suffix])
}

function ollamaMetallibPaxPayload(overrides = {}, schilyOverrides = {}) {
  const attributes = {
    CodeDirectory: Buffer.from('directory'),
    CodeRequirements: Buffer.from('requirements'),
    CodeSignature: Buffer.from('signature'),
    ...overrides,
  }
  const records = [paxRecord('mtime', '1750244049.000000000')]
  for (const name of ['CodeSignature', 'CodeRequirements', 'CodeDirectory']) {
    const value = attributes[name]
    records.push(
      paxRecord(
        `LIBARCHIVE.xattr.com.apple.cs.${name}`,
        value.toString('base64').replace(/=+$/u, ''),
      ),
      paxRecord(`SCHILY.xattr.com.apple.cs.${name}`, schilyOverrides[name] ?? value),
    )
  }
  return Buffer.concat(records)
}

function appleDoublePayload(fill = 0) {
  const payload = Buffer.alloc(9662, fill)
  Buffer.from('00051607000200004d6163204f53205820202020202020200002', 'hex').copy(payload)
  return payload
}

function appleDoubleContracts(entries) {
  return Object.fromEntries(
    entries.map(([name, payload]) => [
      name,
      {
        bytes: payload.length,
        sha256: createHash('sha256').update(payload).digest('hex'),
      },
    ]),
  )
}

function tarGzip(entries) {
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]), { level: 9 })
}

function fixtureCapturedToolchains(
  snapshotRoot = '/generation/.package-source-toolchains-fixture',
) {
  const tool = (name) =>
    Object.freeze({
      canonical: join(snapshotRoot, name),
      executableSha256: 'd'.repeat(64),
      invocation: join(snapshotRoot, name),
      version: `${name} fixture version`,
    })
  return Object.freeze({
    cargo: tool('cargo'),
    git: tool('git'),
    go: Object.freeze({ ...tool('go'), goroot: '/toolchain/go' }),
    node: tool('node'),
    pnpm: tool('pnpm'),
    rustc: tool('rustc'),
    snapshotRoot,
  })
}

function pipelineOperations(events, failureStage = '', toolchains = fixtureCapturedToolchains()) {
  const stage = (name, result) => async (context) => {
    events.push([name, context])
    if (failureStage === name) throw new Error('synthetic pipeline failure')
    return result
  }
  return {
    createSourceManifest: stage('create-source-manifest', {
      sha256: 'a'.repeat(64),
      toolchains,
    }),
    cleanupToolchains: stage('cleanup-toolchains'),
    projectDesktopSource: stage('project-desktop-source'),
    prepareFrontendDependencies: stage('prepare-frontend-dependencies', {
      go: { executable: '/generation/tools/go' },
      node: { executable: '/generation/tools/node', pnpmExecutable: '/generation/tools/pnpm.cjs' },
      receiptPath: '/generation/dependencies/receipt.json',
    }),
    verifyGoDependencies: stage('verify-go-dependencies'),
    buildSidecar: stage('build-sidecar'),
    verifySidecar: stage('verify-sidecar'),
    stageRenderBundle: stage('stage-render-bundle'),
    stageOllama: stage('stage-ollama', { archiveSha256: 'b'.repeat(64) }),
    verifyOllama: stage('verify-ollama'),
    buildFrontend: stage('build-frontend'),
    prepareCargoDependencies: stage('prepare-cargo-dependencies'),
    buildTauriApp: stage('build-tauri-app'),
    verifyAppResources: stage('verify-app-resources'),
    stageReleaseApp: stage('stage-release-app'),
    verifySourceManifest: stage('verify-source-manifest'),
    sanitizeAndVerify: stage('sanitize-and-verify'),
    createDmg: stage('create-dmg'),
    createAttestation: stage('create-attestation', { receiptSHA256: 'c'.repeat(64) }),
    writeBuildResult: stage('write-build-result'),
    verifyStagedPackage: stage('verify-staged-package'),
    cleanupStaging: stage('cleanup-staging'),
  }
}

test('build performance batch 1: clonefile copies, ollama tree cache, fast hdiutil', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(moduleURL, 'utf8')
  // P0-1：moveBuiltApp 必须用 APFS clonefile（cp -c）替代全量复制
  const move = source.slice(source.indexOf('async function moveBuiltAppIntoReleaseGeneration'), source.indexOf('async function verifyAppResources'))
  assert.equal(move.includes('FIXED_TOOLS.cp'), true)
  assert.equal(move.includes("'-c'"), true)
  // P1-1：ollama 解包树进入宿主持久缓存（归档 sha256 决定，跨代复用）
  assert.match(source, /ollama-tree-/u)
  assert.equal(source.includes("'-c'"), true)
  // P4：hdiutil UDZO 用 zlib-level=6
  assert.equal(source.includes("'zlib-level=6'"), true)
})

test('build performance batch 2: fingerprint skip wiring in Makefile and script', async () => {
  const { readFile } = await import('node:fs/promises')
  const makefile = await readFile(join(process.cwd(), 'Makefile'), 'utf8')
  assert.equal(makefile.includes('verify-build-local-fingerprint.mjs'), true)
  const script = await readFile(join(process.cwd(), 'scripts/ci/verify-build-local-fingerprint.mjs'), 'utf8')
  assert.equal(script.includes('git', 0) || script.includes("'git'"), true)
  assert.equal(script.includes('build-local-fingerprint.json'), true)
  assert.equal(script.includes('reusing existing app bundle'), true)
})

test('package-local plan binds one native generation and never consumes shared package outputs', async () => {
  const { createPackageLocalPlan } = await import(moduleURL)
  const desktopRoot = '/workspace/hexclaw-desktop'
  const plan = createPackageLocalPlan({
    desktopRoot,
    generationId: '1'.repeat(32),
    hostHome: '/Users/developer',
    targetTriple: 'x86_64-apple-darwin',
    version: '0.5.0-beta',
  })

  assert.equal(plan.target.goos, 'darwin')
  assert.equal(plan.target.goarch, 'amd64')
  assert.equal(plan.target.renderTarget, 'darwin-x86_64')
  assert.equal(plan.target.dmgArchitecture, 'x64')
  assert.equal(plan.paths.generationRoot.startsWith(plan.paths.releaseRoot), true)
  assert.equal(plan.paths.projectedDesktopRoot.startsWith(plan.paths.generationRoot), true)
  assert.equal(plan.paths.projectedWorkRoot, join(plan.paths.generationRoot, 'source'))
  assert.equal(plan.paths.projectedGoWork, join(plan.paths.projectedWorkRoot, 'go.work'))
  assert.deepEqual(plan.paths.projectedGoModuleRoots, [
    join(plan.paths.projectedWorkRoot, 'toolkit'),
    join(plan.paths.projectedWorkRoot, 'ai-core'),
    join(plan.paths.projectedWorkRoot, 'hexagon'),
    join(plan.paths.projectedWorkRoot, 'hexclaw'),
  ])
  assert.equal(plan.paths.frontendNodeModules.startsWith(plan.paths.generationRoot), true)
  // 依赖缓存位于宿主持久共享根，跨 generation 复用（BUG-20260816-001）。
  assert.equal(plan.paths.cacheRoot, join('/Users/developer', '.cache', 'hexclaw-package'))
  assert.equal(plan.paths.sharedCargoHome.startsWith(plan.paths.cacheRoot), true)
  assert.equal(plan.paths.sharedCargoTarget.startsWith(plan.paths.cacheRoot), true)
  assert.equal(plan.paths.sharedCargoHome.startsWith(plan.paths.generationRoot), false)
  assert.equal(plan.paths.sharedCargoTarget.startsWith(plan.paths.generationRoot), false)
  assert.equal(plan.paths.sharedOllamaArchive.startsWith(plan.paths.cacheRoot), true)
  assert.equal(plan.paths.generationBinaries.startsWith(plan.paths.generationRoot), true)
  assert.equal(plan.paths.generationOllamaRoot.startsWith(plan.paths.generationRoot), true)
  assert.equal(plan.paths.generationDist.startsWith(plan.paths.generationRoot), true)
  assert.equal(plan.paths.generationApp.startsWith(plan.paths.generationRoot), true)
  assert.equal(plan.paths.generationReleaseRoot, join(plan.paths.generationRoot, 'release'))
  assert.equal(
    plan.paths.generationSourceManifest.startsWith(plan.paths.generationReleaseRoot),
    true,
  )
  assert.equal(
    plan.paths.publishedSourceManifest.startsWith(plan.paths.publishedGenerationRoot),
    true,
  )
  assert.equal(plan.paths.currentPointer, join(plan.paths.releaseRoot, 'package-current.json'))
  for (const pathname of [
    plan.paths.frontendNodeModules,
    plan.paths.generationBinaries,
    plan.paths.generationOllamaRoot,
  ]) {
    assert.equal(pathname.includes(join(desktopRoot, 'node_modules')), false)
    assert.equal(pathname.includes(join(desktopRoot, 'src-tauri', 'binaries')), false)
  }
})

test('dependency provenance consumes only projected sources and manifest-bound toolchains', async () => {
  const { createDependencyProvenanceOptions, createGoBuildEnvironment, createPackageLocalPlan } =
    await import(moduleURL)
  const plan = createPackageLocalPlan({
    desktopRoot: '/workspace/hexclaw-desktop',
    generationId: '9'.repeat(32),
    hostHome: '/Users/developer',
    targetTriple: 'x86_64-apple-darwin',
    version: '0.5.0-beta',
  })
  const sourceManifestSHA256 = '9'.repeat(64)
  const options = createDependencyProvenanceOptions(
    plan,
    {
      go: {
        canonical: '/usr/local/go/bin/go',
        executableSha256: 'a'.repeat(64),
        goroot: '/usr/local/go',
        version: 'go version go1.26.5 darwin/amd64',
      },
      node: {
        canonical: '/usr/local/bin/node',
        executableSha256: 'b'.repeat(64),
        version: 'v24.0.0',
      },
      pnpm: {
        canonical: '/usr/local/bin/pnpm',
        executableSha256: 'c'.repeat(64),
        version: '10.30.3',
      },
    },
    sourceManifestSHA256,
  )

  assert.equal(options.generationRoot, plan.paths.generationRoot)
  assert.equal(options.sourceRoot, plan.paths.projectedDesktopRoot)
  assert.deepEqual(options.go.moduleRoots, plan.paths.projectedGoModuleRoots)
  assert.equal(options.go.goWork, plan.paths.projectedGoWork)
  assert.equal(options.go.executable, '/usr/local/go/bin/go')
  assert.equal(options.go.sha256, 'a'.repeat(64))
  assert.equal(options.node.executable, '/usr/local/bin/node')
  assert.equal(options.pnpm.executable, '/usr/local/bin/pnpm')
  assert.deepEqual(options.sourceManifest, { sha256: sourceManifestSHA256 })
  for (const path of [options.sourceRoot, options.go.goWork, ...options.go.moduleRoots]) {
    assert.equal(path.startsWith(plan.paths.generationRoot), true)
  }

  const privateGoWork = join(
    plan.paths.generationRoot,
    '.package-dependencies',
    'go-workspace',
    'go.work',
  )
  const goEnvironment = createGoBuildEnvironment(plan, {
    go: {
      environment: {
        GOENV: 'off',
        GOPROXY: 'off',
        GOROOT: '/usr/local/go',
        GOTOOLCHAIN: 'local',
        GOWORK: privateGoWork,
        HOME: join(plan.paths.generationRoot, 'go-home'),
        PATH: '/usr/bin:/bin',
        TMPDIR: join(plan.paths.generationRoot, 'go-tmp'),
      },
      workspace: privateGoWork,
    },
  })
  assert.equal(goEnvironment.GOOS, 'darwin')
  assert.equal(goEnvironment.GOARCH, 'amd64')
  assert.equal(goEnvironment.CGO_ENABLED, '0')
  assert.equal(goEnvironment.GOWORK, privateGoWork)
  assert.equal(goEnvironment.GOTOOLCHAIN, 'local')
  assert.equal(goEnvironment.GOPROXY, 'off')
})

test('package command failures expose only allowlisted redacted categories', async () => {
  const { classifySafePackageCommandError } = await import(moduleURL)

  assert.equal(
    classifySafePackageCommandError('ERROR: Typst executable sensitive-data scan failed.\n'),
    'render-typst-sensitive-scan',
  )
  assert.equal(
    classifySafePackageCommandError('ERROR: package-sensitive-boundary category=path:user-home\n'),
    'sensitive-boundary-path-user-home',
  )
  assert.equal(
    classifySafePackageCommandError(
      'ERROR: package-sensitive-boundary category=metadata:command exit=1 signal=SIGTERM\n',
    ),
    'sensitive-boundary-metadata-command',
  )
  assert.equal(
    classifySafePackageCommandError(
      `ERROR: package-sensitive-boundary category=${'a'.repeat(81)}\n`,
    ),
    undefined,
  )
  assert.equal(
    classifySafePackageCommandError(
      'ERROR: package-sensitive-boundary category=path:user-home\nsecret-value\n',
    ),
    undefined,
  )
  assert.equal(
    classifySafePackageCommandError('ERROR: sk-proj-SYNTHETIC_SECRET_MUST_NOT_ESCAPE\n'),
    undefined,
  )
  assert.equal(classifySafePackageCommandError('arbitrary child output\n'), undefined)
})

test('dependency provenance binds Go to GOROOT and pnpm to the frozen standalone CLI', async () => {
  const { createDependencyProvenanceOptions, createPackageLocalPlan } = await import(moduleURL)
  const pnpmWorkerNativeName = `reflink.darwin-${process.arch}-fixture.node`
  const pnpmWorkerNativePath = `/generation/toolchains/pnpm-package/dist/${pnpmWorkerNativeName}`
  const plan = createPackageLocalPlan({
    desktopRoot: '/workspace/hexclaw-desktop',
    generationId: '8'.repeat(32),
    hostHome: '/Users/developer',
    targetTriple: 'x86_64-apple-darwin',
    version: '0.5.0-beta',
  })
  const options = createDependencyProvenanceOptions(
    plan,
    {
      go: {
        canonical: '/generation/toolchains/go',
        executableSha256: 'a'.repeat(64),
        goroot: '/usr/local/go',
        sourceCanonical: '/usr/local/go/bin/go',
        sourceSha256: 'd'.repeat(64),
        version: 'go version go1.26.5 darwin/amd64',
      },
      node: {
        canonical: '/generation/toolchains/node',
        executableSha256: 'b'.repeat(64),
        version: 'v24.0.0',
      },
      pnpm: {
        canonical: '/generation/toolchains/pnpm-package/bin/pnpm.cjs',
        executableSha256: 'c'.repeat(64),
        version: '10.30.3',
        supportFiles: [
          {
            canonical: '/generation/toolchains/pnpm-package/dist/pnpm.cjs',
            executableSha256: 'e'.repeat(64),
            path: 'dist/pnpm.cjs',
          },
          {
            canonical: '/generation/toolchains/pnpm-package/dist/worker.js',
            executableSha256: 'f'.repeat(64),
            path: 'dist/worker.js',
          },
          {
            canonical: pnpmWorkerNativePath,
            executableSha256: '1'.repeat(64),
            path: `dist/${pnpmWorkerNativeName}`,
          },
          {
            canonical: '/generation/toolchains/pnpm-package/package.json',
            executableSha256: '2'.repeat(64),
            path: 'package.json',
          },
        ],
      },
    },
    '9'.repeat(64),
  )

  assert.equal(options.go.executable, '/usr/local/go/bin/go')
  assert.equal(options.go.sha256, 'd'.repeat(64))
  assert.equal(options.pnpm.executable, '/generation/toolchains/pnpm-package/dist/pnpm.cjs')
  assert.equal(options.pnpm.sha256, 'e'.repeat(64))
  assert.equal(options.pnpm.workerExecutable, '/generation/toolchains/pnpm-package/dist/worker.js')
  assert.equal(options.pnpm.workerSha256, 'f'.repeat(64))
  assert.equal(
    options.pnpm.workerNativeExecutable,
    pnpmWorkerNativePath,
  )
  assert.equal(options.pnpm.workerNativeSha256, '1'.repeat(64))
  assert.equal(options.pnpm.workerNativeName, pnpmWorkerNativeName)
  assert.equal(options.pnpm.packageExecutable, '/generation/toolchains/pnpm-package/package.json')
  assert.equal(options.pnpm.packageSha256, '2'.repeat(64))
})

test('package-local lock invocation owns one build and one canonical final verifier', async () => {
  const { createPackageLocalLockInvocation, createPackageLocalPlan } = await import(moduleURL)
  const plan = createPackageLocalPlan({
    desktopRoot: '/workspace/hexclaw-desktop',
    generationId: '8'.repeat(32),
    hostHome: '/Users/developer',
    targetTriple: 'aarch64-apple-darwin',
    version: '0.5.0-beta',
  })
  const modulePath = '/workspace/hexclaw-desktop/scripts/ci/package-local.mjs'
  const invocation = createPackageLocalLockInvocation(plan, {
    modulePath,
    nodeExecutable: '/usr/local/bin/node',
  })

  assert.deepEqual(invocation.command.slice(0, 3), [
    '/usr/local/bin/node',
    modulePath,
    'build-held',
  ])
  assert.deepEqual(invocation.finalVerificationCommand.slice(0, 3), [
    '/usr/local/bin/node',
    modulePath,
    'verify-held',
  ])
  for (const command of [invocation.command, invocation.finalVerificationCommand]) {
    assert.equal(command.includes('--generation-id'), true)
    assert.equal(command.includes(plan.generationId), true)
    assert.equal(command.includes('--target-triple'), true)
    assert.equal(command.includes(plan.target.triple), true)
    assert.equal(command.includes('--not-before-epoch-seconds'), true)
    assert.equal(command.includes(String(plan.notBeforeEpochSeconds)), true)
  }
  assert.equal(invocation.cwd, plan.desktopRoot)
  assert.equal(invocation.lockPath, plan.paths.lock)
  assert.equal(invocation.planRoot, plan.paths.generationRoot)
  assert.equal(invocation.tombstonePath, plan.paths.tombstone)
  assert.equal(dirname(invocation.lockPath), dirname(invocation.tombstonePath))
  assert.equal(dirname(invocation.lockPath).endsWith('/.package-local.control'), true)
  assert.equal(invocation.environment.HOME, plan.hostHome)
  assert.equal(invocation.environment.GOOS, undefined)
  assert.equal(invocation.environment.GOARCH, undefined)
  assert.equal(invocation.environment.MAKEFLAGS, undefined)
  assert.equal(invocation.environment.HEXCLAW_LOCAL_SRC, undefined)
  assert.equal(invocation.environment.TMPDIR, plan.paths.privateTemp)
})

test('outer package-local delegates exactly once to the lifecycle lock without invalidating artifacts', async (t) => {
  const { createPackageLocalPlan, runPackageLocalBuild } = await import(moduleURL)
  const root = await realpath(await mkdtemp(join(tmpdir(), 'hexclaw-package-outer-build-')))
  t.after(() => rm(root, { force: true, recursive: true }))
  const desktopRoot = join(root, 'hexclaw-desktop')
  await mkdir(desktopRoot, { mode: 0o700, recursive: true })
  const plan = createPackageLocalPlan({
    desktopRoot,
    generationId: '5'.repeat(32),
    hostHome: '/Users/developer',
    targetTriple: 'x86_64-apple-darwin',
    version: '0.5.0-beta',
  })
  const calls = []

  const result = await runPackageLocalBuild(plan, {
    lockRunner: async (options) => {
      calls.push(options)
      return { exitCode: 0, generationId: options.generationId }
    },
    modulePath: '/workspace/hexclaw-desktop/scripts/ci/package-local.mjs',
    nodeExecutable: '/usr/local/bin/node',
  })

  assert.deepEqual(result, { exitCode: 0, generationId: plan.generationId })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command[2], 'build-held')
  assert.equal(calls[0].finalVerificationCommand[2], 'verify-held')
  assert.equal(calls[0].planRoot, plan.paths.generationRoot)
})

test('outer package-local accepts an owned 0755 release parent without changing permissions', async (t) => {
  const { createPackageLocalPlan, runPackageLocalBuild } = await import(moduleURL)
  const root = await realpath(await mkdtemp(join(tmpdir(), 'hexclaw-package-parent-mode-')))
  t.after(() => rm(root, { force: true, recursive: true }))
  const desktopRoot = join(root, 'hexclaw-desktop')
  await mkdir(desktopRoot, { mode: 0o700, recursive: true })
  const plan = createPackageLocalPlan({
    desktopRoot,
    generationId: 'b'.repeat(32),
    hostHome: '/Users/developer',
    targetTriple: 'x86_64-apple-darwin',
    version: '0.5.0-beta',
  })
  await mkdir(plan.paths.releaseRoot, { mode: 0o700, recursive: true })
  await chmod(plan.paths.releaseRoot, 0o755)
  let lockCalls = 0

  await runPackageLocalBuild(plan, {
    lockRunner: async () => {
      lockCalls += 1
      return { exitCode: 0, generationId: plan.generationId }
    },
    modulePath: '/workspace/hexclaw-desktop/scripts/ci/package-local.mjs',
    nodeExecutable: '/usr/local/bin/node',
  })
  assert.equal((await lstat(plan.paths.releaseRoot)).mode & 0o777, 0o755)
  assert.equal(lockCalls, 1)
})

test('package-local CLI rejects every source and target override with one stable category', async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [moduleURL.pathname, 'build', '--target-triple', 'fake'], {
      maxBuffer: 64 * 1024,
    }),
    (error) => {
      assert.equal(error.code, 1)
      assert.equal(error.stdout, '')
      assert.equal(error.stderr, 'ERROR: package-local category=cli-input\n')
      assert.equal(error.stderr.includes('/Users/'), false)
      assert.equal(error.stderr.includes('/workspace/'), false)
      return true
    },
  )
})

test(
  'package-local held CLI rejects direct invocation without the inherited lifecycle lock',
  { skip: process.platform !== 'darwin' },
  async () => {
    const target = process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          moduleURL.pathname,
          'build-held',
          '--generation-id',
          '6'.repeat(32),
          '--not-before-epoch-seconds',
          '1',
          '--target-triple',
          target,
          '--version',
          '0.5.0-beta',
        ],
        { maxBuffer: 64 * 1024 },
      ),
      (error) => {
        assert.equal(error.code, 1)
        assert.equal(error.stdout, '')
        assert.equal(error.stderr, 'ERROR: package-local category=generation-capability\n')
        return true
      },
    )
  },
)

test('package-local pipeline builds one complete private candidate without publishing current', async () => {
  const { createPackageLocalPlan, runPackageBuildPipeline } = await import(moduleURL)
  const plan = createPackageLocalPlan({
    desktopRoot: '/workspace/hexclaw-desktop',
    generationId: '2'.repeat(32),
    hostHome: '/Users/developer',
    targetTriple: 'aarch64-apple-darwin',
    version: '0.5.0-beta',
  })
  const events = []
  const toolchains = fixtureCapturedToolchains()
  const result = await runPackageBuildPipeline(plan, pipelineOperations(events, '', toolchains))
  const names = events.map(([name]) => name)

  assert.deepEqual(names, [
    'create-source-manifest',
    'project-desktop-source',
    'prepare-frontend-dependencies',
    'verify-go-dependencies',
    'stage-render-bundle',
    'build-sidecar',
    'verify-sidecar',
    'stage-ollama',
    'verify-ollama',
    'build-frontend',
    'prepare-cargo-dependencies',
    'build-tauri-app',
    'stage-release-app',
    'verify-app-resources',
    'verify-source-manifest',
    'sanitize-and-verify',
    'create-dmg',
    'create-attestation',
    'cleanup-toolchains',
    'write-build-result',
    'verify-staged-package',
  ])
  assert.equal(result.sourceManifestSHA256, 'a'.repeat(64))
  assert.equal(result.receiptSHA256, 'c'.repeat(64))
  assert.strictEqual(
    events.find(([name]) => name === 'project-desktop-source')[1].toolchains,
    toolchains,
  )
  assert.strictEqual(
    events.find(([name]) => name === 'cleanup-toolchains')[1].toolchains,
    toolchains,
  )
  const sourceVerification = events.find(([name]) => name === 'verify-source-manifest')[1]
  assert.equal(sourceVerification.sourceManifestSHA256, 'a'.repeat(64))
  assert.equal(sourceVerification.generationId, plan.generationId)
  assert.equal(sourceVerification.targetTriple, plan.target.triple)
  const dependencyVerification = events.find(([name]) => name === 'verify-go-dependencies')[1]
  assert.equal(dependencyVerification.dependencies.go.executable, '/generation/tools/go')
  assert.equal(
    dependencyVerification.dependencies.node.pnpmExecutable,
    '/generation/tools/pnpm.cjs',
  )
  const attestation = events.find(([name]) => name === 'create-attestation')[1]
  assert.equal(attestation.sourceManifestSHA256, 'a'.repeat(64))
  assert.equal(attestation.generationId, plan.generationId)
  assert.equal(attestation.targetTriple, plan.target.triple)
  assert.equal(names.at(-1), 'verify-staged-package')
})

test('package-local pipeline removes only its private staging generation after failure', async () => {
  const { createPackageLocalPlan, runPackageBuildPipeline } = await import(moduleURL)
  const plan = createPackageLocalPlan({
    desktopRoot: '/workspace/hexclaw-desktop',
    generationId: '3'.repeat(32),
    hostHome: '/Users/developer',
    targetTriple: 'x86_64-apple-darwin',
    version: '0.5.0-beta',
  })
  const events = []

  await assert.rejects(
    runPackageBuildPipeline(plan, pipelineOperations(events, 'verify-staged-package')),
    /synthetic pipeline failure/u,
  )
  const names = events.map(([name]) => name)
  assert.equal(names.filter((name) => name === 'cleanup-toolchains').length, 1)
  assert.equal(names.at(-1), 'cleanup-staging')
  assert.equal(events.at(-1)[1].generationId, plan.generationId)
})

test('Ollama verification failure stops later builds and cleans only private staging', async () => {
  const { createPackageLocalPlan, runPackageBuildPipeline } = await import(moduleURL)
  const plan = createPackageLocalPlan({
    desktopRoot: '/workspace/hexclaw-desktop',
    generationId: 'e'.repeat(32),
    hostHome: '/Users/developer',
    targetTriple: 'x86_64-apple-darwin',
    version: '0.5.0-beta',
  })
  const events = []

  await assert.rejects(
    runPackageBuildPipeline(plan, pipelineOperations(events, 'verify-ollama')),
    /synthetic pipeline failure/u,
  )
  assert.deepEqual(
    events.map(([name]) => name),
    [
      'create-source-manifest',
      'project-desktop-source',
      'prepare-frontend-dependencies',
      'verify-go-dependencies',
      'stage-render-bundle',
      'build-sidecar',
      'verify-sidecar',
      'stage-ollama',
      'verify-ollama',
      'cleanup-toolchains',
      'cleanup-staging',
    ],
  )
  assert.equal(events.at(-1)[1].generationId, plan.generationId)
})

test('every terminal candidate failure cleans staging without a public commit operation', async () => {
  const { createPackageLocalPlan, runPackageBuildPipeline } = await import(moduleURL)
  const plan = createPackageLocalPlan({
    desktopRoot: '/workspace/hexclaw-desktop',
    generationId: 'c'.repeat(32),
    hostHome: '/Users/developer',
    targetTriple: 'x86_64-apple-darwin',
    version: '0.5.0-beta',
  })
  for (const stage of ['write-build-result', 'verify-staged-package']) {
    const events = []
    await assert.rejects(
      runPackageBuildPipeline(plan, pipelineOperations(events, stage)),
      /synthetic pipeline failure/u,
      stage,
    )
    assert.equal(events.at(-1)[0], 'cleanup-staging', stage)
    assert.equal(
      events.some(([name]) => name.includes('publish')),
      false,
    )
  }
})

test('package-local pipeline cleans captured toolchains when the source result is invalid', async () => {
  const { createPackageLocalPlan, runPackageBuildPipeline } = await import(moduleURL)
  const plan = createPackageLocalPlan({
    desktopRoot: '/workspace/hexclaw-desktop',
    generationId: 'f'.repeat(32),
    hostHome: '/Users/developer',
    targetTriple: 'x86_64-apple-darwin',
    version: '0.5.0-beta',
  })
  const events = []
  const toolchains = fixtureCapturedToolchains()
  const operations = pipelineOperations(events, '', toolchains)
  operations.createSourceManifest = async (context) => {
    events.push(['create-source-manifest', context])
    return { sha256: 'invalid', toolchains }
  }

  await assert.rejects(
    runPackageBuildPipeline(plan, operations),
    /category=source-manifest-result/u,
  )
  assert.deepEqual(
    events.map(([name]) => name),
    ['create-source-manifest', 'cleanup-toolchains', 'cleanup-staging'],
  )
})

test('held package build creates one private generation before entering the pipeline', async (t) => {
  const { createPackageLocalPlan, runHeldPackageBuild } = await import(moduleURL)
  const root = await realpath(await mkdtemp(join(tmpdir(), 'hexclaw-package-held-build-')))
  t.after(() => rm(root, { force: true, recursive: true }))
  const plan = createPackageLocalPlan({
    desktopRoot: join(root, 'hexclaw-desktop'),
    generationId: '7'.repeat(32),
    hostHome: join(root, 'host-home'),
    targetTriple: 'x86_64-apple-darwin',
    version: '0.5.0-beta',
  })
  const events = []
  await mkdir(plan.paths.releaseRoot, { mode: 0o700, recursive: true })
  await chmod(plan.paths.releaseRoot, 0o755)

  const result = await runHeldPackageBuild(plan, pipelineOperations(events))

  const metadata = await lstat(plan.paths.generationRoot)
  assert.equal(metadata.isDirectory(), true)
  assert.equal(metadata.mode & 0o777, 0o700)
  assert.equal(result.generationId, plan.generationId)
  assert.equal(events[0][0], 'create-source-manifest')
  await assert.rejects(
    runHeldPackageBuild(plan, pipelineOperations([])),
    /category=generation-exists/u,
  )

  const lockOwnedPlan = createPackageLocalPlan({
    desktopRoot: join(root, 'lock-owned-desktop'),
    generationId: 'd'.repeat(32),
    hostHome: join(root, 'host-home-lock'),
    targetTriple: 'x86_64-apple-darwin',
    version: '0.5.0-beta',
  })
  await mkdir(lockOwnedPlan.paths.releaseRoot, { mode: 0o755, recursive: true })
  await mkdir(lockOwnedPlan.paths.generationRoot, { mode: 0o700, recursive: true })
  await runHeldPackageBuild(lockOwnedPlan, pipelineOperations([]))
  assert.equal((await lstat(lockOwnedPlan.paths.generationRoot)).mode & 0o777, 0o700)
})

test('held final verifier publishes one directory and commits current only after both verifications', async () => {
  const { createPackageLocalPlan, runHeldFinalVerification } = await import(moduleURL)
  const plan = createPackageLocalPlan({
    desktopRoot: '/workspace/hexclaw-desktop',
    generationId: '6'.repeat(32),
    hostHome: '/Users/developer',
    targetTriple: 'aarch64-apple-darwin',
    version: '0.5.0-beta',
  })
  const events = []
  const result = {
    notBeforeEpochSeconds: plan.notBeforeEpochSeconds,
    receiptSHA256: 'a'.repeat(64),
    sourceManifestSHA256: 'b'.repeat(64),
  }
  const adapters = Object.fromEntries(
    [
      ['readBuildResult', async () => result],
      [
        'verifyCandidateSource',
        async () => {
          events.push('candidate-source')
        },
      ],
      [
        'verifyCandidatePackage',
        async () => {
          events.push('candidate-package')
        },
      ],
      [
        'publishGeneration',
        async () => {
          events.push('publish-generation')
        },
      ],
      [
        'verifyPublishedSource',
        async () => {
          events.push('published-source')
        },
      ],
      [
        'verifyPublishedPackage',
        async () => {
          events.push('published-package')
        },
      ],
      [
        'commitCurrent',
        async () => {
          events.push('commit-current')
        },
      ],
      [
        'cleanupStaging',
        async () => {
          events.push('cleanup-staging')
        },
      ],
    ].map(([name, operation]) => [name, operation]),
  )

  const verified = await runHeldFinalVerification(plan, adapters)

  assert.deepEqual(events, [
    'candidate-source',
    'candidate-package',
    'publish-generation',
    'published-source',
    'published-package',
    'commit-current',
    'cleanup-staging',
  ])
  assert.equal(verified, result)
})

test('held final verifier failure recovers only uncommitted generations and never commits current', async () => {
  const { createPackageLocalPlan, runHeldBuildFinalVerification } = await import(moduleURL)
  const plan = createPackageLocalPlan({
    desktopRoot: '/workspace/hexclaw-desktop',
    generationId: 'e'.repeat(32),
    hostHome: '/Users/developer',
    targetTriple: 'aarch64-apple-darwin',
    version: '0.5.0-beta',
  })
  const recoveryCalls = []
  const events = []
  const result = {
    notBeforeEpochSeconds: plan.notBeforeEpochSeconds,
    receiptSHA256: 'a'.repeat(64),
    sourceManifestSHA256: 'b'.repeat(64),
  }
  await assert.rejects(
    runHeldBuildFinalVerification(plan, {
      recoverPublication: async (selectedPlan) => recoveryCalls.push(selectedPlan.generationId),
      verificationAdapters: {
        readBuildResult: async () => result,
        verifyCandidateSource: async () => undefined,
        verifyCandidatePackage: async () => undefined,
        publishGeneration: async () => {
          events.push('publish-generation')
        },
        verifyPublishedSource: async () => undefined,
        verifyPublishedPackage: async () => {
          throw new Error('synthetic published verifier failure')
        },
        commitCurrent: async () => {
          events.push('commit-current')
        },
        cleanupStaging: async () => {
          events.push('cleanup-staging')
        },
      },
    }),
    /synthetic published verifier failure/u,
  )
  assert.deepEqual(recoveryCalls, [plan.generationId])
  assert.deepEqual(events, ['publish-generation'])
})

test('package-local pins the official Ollama identity and safe Tauri resource overlay', async () => {
  const [
    { getOllamaPackageContract, createPackageLocalPlan, createTauriPackageOverlay },
    { OLLAMA_PACKAGE_CONTRACT },
  ] = await Promise.all([import(moduleURL), import('../../scripts/ci/verify-sidecar-version.mjs')])
  const ollamaContract = getOllamaPackageContract()
  const plan = createPackageLocalPlan({
    desktopRoot: '/workspace/hexclaw-desktop',
    generationId: '4'.repeat(32),
    hostHome: '/Users/developer',
    targetTriple: 'x86_64-apple-darwin',
    version: '0.5.0-beta',
  })
  const overlay = createTauriPackageOverlay(plan)
  const tauriRoot = join(plan.paths.projectedDesktopRoot, 'src-tauri')
  const frontendDist = relative(tauriRoot, plan.paths.generationDist)
  const ollamaRoot = relative(tauriRoot, plan.paths.generationOllamaRoot)
  const sidecars = ['hexclaw', 'pandoc', 'typst'].map((name) =>
    relative(tauriRoot, join(plan.paths.generationBinaries, name)),
  )

  assert.strictEqual(ollamaContract, OLLAMA_PACKAGE_CONTRACT)
  assert.equal(overlay.build.beforeBuildCommand, '')
  assert.equal(overlay.build.frontendDist, frontendDist)
  assert.equal(overlay.bundle.resources['binaries/ollama-bundle'], null)
  assert.equal(overlay.bundle.resources['render-assets/*'], 'assets/render/')
  assert.equal(overlay.bundle.resources[ollamaRoot], 'ollama')
  assert.deepEqual(overlay.bundle.externalBin, sidecars)
  assert.equal([frontendDist, ollamaRoot, ...sidecars].some(isAbsolute), false)
  assert.equal(JSON.stringify(overlay).includes(plan.hostHome), false)
})

test('frontend typecheck cache cleanup removes only the known generated build information', async (t) => {
  const { cleanupFrontendTypecheckCache } = await import(moduleURL)
  const root = await realpath(await mkdtemp(join(tmpdir(), 'hexclaw-frontend-cache-')))
  t.after(() => rm(root, { force: true, recursive: true }))
  const generationRoot = join(root, 'generation')
  const nodeModules = join(generationRoot, 'source', 'hexclaw-desktop', 'node_modules')
  const cacheRoot = join(nodeModules, '.tmp')
  const viteCacheRoot = join(nodeModules, '.vite-temp')
  const cacheFiles = [
    'tsconfig.app.tsbuildinfo',
    'tsconfig.node.tsbuildinfo',
    'tsconfig.vitest.tsbuildinfo',
  ]
  await mkdir(cacheRoot, { mode: 0o700, recursive: true })
  await mkdir(viteCacheRoot, { mode: 0o700 })
  for (const name of cacheFiles) await writeFile(join(cacheRoot, name), `${name}\n`)

  const plan = { paths: { frontendNodeModules: nodeModules, generationRoot } }
  await cleanupFrontendTypecheckCache(plan)
  await assert.rejects(lstat(cacheRoot), { code: 'ENOENT' })
  await assert.rejects(lstat(viteCacheRoot), { code: 'ENOENT' })

  await mkdir(cacheRoot, { mode: 0o700, recursive: true })
  await mkdir(viteCacheRoot, { mode: 0o700 })
  for (const name of cacheFiles) await writeFile(join(cacheRoot, name), `${name}\n`)
  await writeFile(join(cacheRoot, 'unexpected.cache'), 'must remain\n')
  await assert.rejects(cleanupFrontendTypecheckCache(plan), /frontend-typecheck-cache/u)
  assert.deepEqual((await readdir(cacheRoot)).sort(), [...cacheFiles, 'unexpected.cache'].sort())
  assert.deepEqual(await readdir(viteCacheRoot), [])

  await rm(cacheRoot, { force: true, recursive: true })
  await rm(viteCacheRoot, { force: true, recursive: true })
  await mkdir(cacheRoot, { mode: 0o700, recursive: true })
  await mkdir(viteCacheRoot, { mode: 0o700 })
  for (const name of cacheFiles) await writeFile(join(cacheRoot, name), `${name}\n`)
  await writeFile(join(viteCacheRoot, 'unexpected.cache'), 'must remain\n')
  await assert.rejects(cleanupFrontendTypecheckCache(plan), /frontend-typecheck-cache/u)
  assert.deepEqual((await readdir(cacheRoot)).sort(), cacheFiles)
  assert.deepEqual(await readdir(viteCacheRoot), ['unexpected.cache'])
})

test('desktop source projection copies only manifest-bound files and ignores repository node_modules', async (t) => {
  const { projectDesktopSourceFromManifest } = await import(moduleURL)
  const root = await mkdtemp(join(tmpdir(), 'hexclaw-package-projection-'))
  t.after(() => rm(root, { force: true, recursive: true }))
  const desktopRoot = join(root, 'hexclaw-desktop')
  const projectedRoot = join(root, 'generation', 'source', 'hexclaw-desktop')
  await mkdir(join(desktopRoot, 'src'), { mode: 0o700, recursive: true })
  await mkdir(join(desktopRoot, 'node_modules', 'poison'), { mode: 0o700, recursive: true })
  const sources = {
    'package.json': '{"name":"fixture"}\n',
    'src/main.ts': 'export const source = true\n',
  }
  for (const [path, bytes] of Object.entries(sources)) {
    await writeFile(join(desktopRoot, path), bytes, { mode: 0o644 })
  }
  await writeFile(
    join(desktopRoot, 'node_modules', 'poison', 'index.js'),
    'throw new Error("must not be read")\n',
  )
  const manifest = {
    repositories: [
      {
        id: 'hexclaw-desktop',
        files: Object.entries(sources).map(([path, bytes]) => ({
          mode: '100644',
          path,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          size: Buffer.byteLength(bytes),
          sourceKind: 'tracked',
        })),
      },
    ],
  }

  const result = await projectDesktopSourceFromManifest({
    desktopRoot,
    manifest,
    projectedRoot,
  })

  assert.deepEqual(result, { copiedBytes: 46, copiedFiles: 2 })
  assert.equal(await readFile(join(projectedRoot, 'package.json'), 'utf8'), sources['package.json'])
  assert.equal(
    await readFile(join(projectedRoot, 'src', 'main.ts'), 'utf8'),
    sources['src/main.ts'],
  )
  await assert.rejects(lstat(join(projectedRoot, 'node_modules')), { code: 'ENOENT' })
})

test('package source projection derives a five-repository workspace without consuming global go.work', async (t) => {
  const { projectPackageSourceFromManifest, verifyProjectedPackageSourceFromManifest } =
    await import(moduleURL)
  const root = await mkdtemp(join(tmpdir(), 'hexclaw-package-source-projection-'))
  t.after(() => rm(root, { force: true, recursive: true }))
  const sourceWorkRoot = join(root, 'work')
  const projectedWorkRoot = join(root, 'generation', 'source')
  const repositoryNames = ['toolkit', 'ai-core', 'hexagon', 'hexclaw', 'hexclaw-desktop']
  const repositories = []
  let repositoryBytes = 0

  for (const name of repositoryNames) {
    const relativePath = name === 'hexclaw-desktop' ? 'src/main.ts' : 'go.mod'
    const goVersion = name === 'toolkit' ? '1.25.12' : '1.25.7'
    const modulePath = `github.com/hexagon-codes/${name}`
    const bytes =
      name === 'hexclaw-desktop' ? `${name}\n` : `module ${modulePath}\n\ngo ${goVersion}\n`
    const pathname = join(sourceWorkRoot, name, relativePath)
    await mkdir(dirname(pathname), { mode: 0o700, recursive: true })
    await writeFile(pathname, bytes, { mode: 0o600 })
    repositoryBytes += Buffer.byteLength(bytes)
    repositories.push({
      id: name,
      files: [
        {
          mode: '100600',
          path: relativePath,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          size: Buffer.byteLength(bytes),
          sourceKind: 'tracked',
        },
      ],
    })
  }

  await mkdir(join(sourceWorkRoot, 'hexclaw-desktop', 'node_modules', 'poison'), {
    mode: 0o700,
    recursive: true,
  })
  await writeFile(
    join(sourceWorkRoot, 'hexclaw-desktop', 'node_modules', 'poison', 'index.js'),
    'throw new Error("must not be read")\n',
    { mode: 0o600 },
  )
  await writeFile(
    join(sourceWorkRoot, 'hexclaw-desktop', '.CoDeX-app-native-k12-run.mjs'),
    'throw new Error("host-only file must not be read")\n',
    { mode: 0o000 },
  )

  const globalWorkspaceFiles = [
    [
      'go.work',
      'go 1.26.0\n\nuse (\n\t./toolkit\n\t./ai-core\n\t./hexagon\n\t./hexclaw\n\t./yc-server\n)\n',
    ],
    ['go.work.sum', 'unrelated global checksum\n'],
  ]
  for (const [path, bytes] of globalWorkspaceFiles) {
    await writeFile(join(sourceWorkRoot, path), bytes, { mode: 0o600 })
  }

  const dedicatedWorkspace =
    'go 1.25.12\n\nuse (\n\t./toolkit\n\t./ai-core\n\t./hexagon\n\t./hexclaw\n)\n'

  const manifest = {
    repositories,
    toolchains: {
      go: {
        compileVersion: 'compile version go1.26.5',
        env: { GOVERSION: 'go1.26.5' },
      },
    },
    workspace: {
      file: {
        mode: '100600',
        path: 'go.work',
        sha256: createHash('sha256').update(dedicatedWorkspace).digest('hex'),
        size: Buffer.byteLength(dedicatedWorkspace),
      },
      goVersion: '1.25.12',
      localReplacements: [],
      modules: [
        { module: 'github.com/hexagon-codes/toolkit', repository: 'toolkit' },
        { module: 'github.com/hexagon-codes/ai-core', repository: 'ai-core' },
        { module: 'github.com/hexagon-codes/hexagon', repository: 'hexagon' },
        { module: 'github.com/hexagon-codes/hexclaw', repository: 'hexclaw' },
      ],
    },
  }
  const expectedBytes = repositoryBytes + Buffer.byteLength(dedicatedWorkspace)
  await writeFile(
    join(sourceWorkRoot, 'go.work'),
    'go 1.27.0\n\nuse (\n\t./toolkit\n\t./yc-server\n\t./another-repository\n)\n',
    { mode: 0o600 },
  )
  const result = await projectPackageSourceFromManifest({
    manifest,
    projectedWorkRoot,
    sourceWorkRoot,
  })

  assert.deepEqual(result, { copiedBytes: expectedBytes, copiedFiles: 6 })
  for (const repository of repositories) {
    const file = repository.files[0]
    assert.equal(
      await readFile(join(projectedWorkRoot, repository.id, file.path), 'utf8'),
      repository.id === 'hexclaw-desktop'
        ? `${repository.id}\n`
        : `module github.com/hexagon-codes/${repository.id}\n\ngo ${
            repository.id === 'toolkit' ? '1.25.12' : '1.25.7'
          }\n`,
    )
  }
  assert.equal(await readFile(join(projectedWorkRoot, 'go.work'), 'utf8'), dedicatedWorkspace)
  await assert.rejects(
    lstat(join(projectedWorkRoot, 'hexclaw-desktop', '.CoDeX-app-native-k12-run.mjs')),
    { code: 'ENOENT' },
  )
  assert.equal(
    (await readFile(join(projectedWorkRoot, 'go.work'), 'utf8')).includes('yc-server'),
    false,
  )
  await assert.rejects(lstat(join(projectedWorkRoot, 'go.work.sum')), { code: 'ENOENT' })
  await assert.rejects(lstat(join(projectedWorkRoot, 'hexclaw-desktop', 'node_modules')), {
    code: 'ENOENT',
  })

  const verified = await verifyProjectedPackageSourceFromManifest({
    allowDependencyTree: false,
    manifest,
    projectedWorkRoot,
  })
  assert.deepEqual(verified, { verifiedBytes: expectedBytes, verifiedFiles: 6 })
  await writeFile(
    join(sourceWorkRoot, 'go.work'),
    'go 1.99.0\n\nuse (\n\t./yc-server\n\t./external-drift\n)\n',
    { mode: 0o600 },
  )
  assert.deepEqual(
    await verifyProjectedPackageSourceFromManifest({
      allowDependencyTree: false,
      manifest,
      projectedWorkRoot,
    }),
    verified,
  )

  const projectedNodeModules = join(projectedWorkRoot, 'hexclaw-desktop', 'node_modules')
  await mkdir(join(projectedNodeModules, 'fixture'), { mode: 0o755, recursive: true })
  await writeFile(join(projectedNodeModules, 'fixture', 'index.js'), 'dependency\n')
  await assert.rejects(
    verifyProjectedPackageSourceFromManifest({
      allowDependencyTree: false,
      manifest,
      projectedWorkRoot,
    }),
    /category=source-projection-drift/u,
  )
  assert.deepEqual(
    await verifyProjectedPackageSourceFromManifest({
      allowDependencyTree: true,
      manifest,
      projectedWorkRoot,
    }),
    verified,
  )

  await writeFile(join(projectedWorkRoot, 'hexclaw', 'module.go'), 'mutated\n')
  await assert.rejects(
    verifyProjectedPackageSourceFromManifest({
      allowDependencyTree: false,
      manifest,
      projectedWorkRoot,
    }),
    /category=source-projection-drift/u,
  )
})

test('Ollama archive extraction accepts only bounded regular files and directories', async (t) => {
  const { extractPinnedTarGzipArchive } = await import(moduleURL)
  const root = await mkdtemp(join(tmpdir(), 'hexclaw-package-ollama-'))
  t.after(() => rm(root, { force: true, recursive: true }))
  const archivePath = join(root, 'ollama.tgz')
  const destination = join(root, 'ollama')
  const archive = tarGzip([
    tarEntry('bin', '', '5'),
    tarEntry('bin/ollama', 'official-binary'),
    tarEntry('lib', '', '5'),
    tarEntry('lib/runtime.dylib', 'runtime'),
  ])
  await writeFile(archivePath, archive, { mode: 0o600 })

  const result = await extractPinnedTarGzipArchive({
    archivePath,
    destination,
    expectedArchiveBytes: archive.length,
    expectedArchiveSha256: createHash('sha256').update(archive).digest('hex'),
    expectedBinaryBytes: 15,
    expectedBinaryRelativePath: 'bin/ollama',
    maxEntries: 8,
    maxExpandedBytes: 1024,
    maxFileBytes: 512,
  })

  assert.deepEqual(result, { entries: 4, files: 2, totalBytes: 22 })
  assert.equal(await readFile(join(destination, 'bin', 'ollama'), 'utf8'), 'official-binary')
  assert.deepEqual((await readdir(destination)).sort(), ['bin', 'lib'])
})

test('Ollama archive extraction materializes confined relative symlink chains as regular files', async (t) => {
  const { extractPinnedTarGzipArchive } = await import(moduleURL)
  const root = await mkdtemp(join(tmpdir(), 'hexclaw-package-ollama-relative-link-'))
  t.after(() => rm(root, { force: true, recursive: true }))
  const archivePath = join(root, 'ollama.tgz')
  const destination = join(root, 'ollama')
  const archive = tarGzip([
    tarEntry('ollama', 'official-binary'),
    tarEntry('lib/runtime.1.dylib', 'runtime'),
    tarEntry('lib/runtime.dylib', '', '2', 'runtime.1.dylib'),
    tarEntry('lib/runtime-latest.dylib', '', '2', 'runtime.dylib'),
  ])
  await writeFile(archivePath, archive, { mode: 0o600 })

  const result = await extractPinnedTarGzipArchive({
    archivePath,
    destination,
    expectedArchiveBytes: archive.length,
    expectedArchiveSha256: createHash('sha256').update(archive).digest('hex'),
    expectedBinaryBytes: 15,
    expectedBinaryRelativePath: 'ollama',
    maxEntries: 8,
    maxExpandedBytes: 1024,
    maxFileBytes: 512,
  })

  const alias = await lstat(join(destination, 'lib', 'runtime.dylib'))
  assert.equal(alias.isFile(), true)
  assert.equal(alias.isSymbolicLink(), false)
  assert.equal(alias.nlink, 1)
  assert.equal(await readFile(join(destination, 'lib', 'runtime.dylib'), 'utf8'), 'runtime')
  const chainedAlias = await lstat(join(destination, 'lib', 'runtime-latest.dylib'))
  assert.equal(chainedAlias.isFile(), true)
  assert.equal(chainedAlias.isSymbolicLink(), false)
  assert.equal(chainedAlias.nlink, 1)
  assert.equal(await readFile(join(destination, 'lib', 'runtime-latest.dylib'), 'utf8'), 'runtime')
  assert.deepEqual(result, { entries: 4, files: 4, totalBytes: 36 })
})

test('Ollama archive extraction validates local PAX metadata without publishing AppleDouble files', async (t) => {
  const { extractPinnedTarGzipArchive } = await import(moduleURL)
  const root = await mkdtemp(join(tmpdir(), 'hexclaw-package-ollama-pax-'))
  t.after(() => rm(root, { force: true, recursive: true }))
  const archivePath = join(root, 'ollama.tgz')
  const destination = join(root, 'ollama')
  const metadata = appleDoublePayload()
  const archive = tarGzip([
    tarEntry('ollama', 'official-binary'),
    tarEntry('mlx_metal_v3', '', '5'),
    tarEntry('mlx_metal_v3/._mlx.metallib', metadata),
    tarEntry('mlx_metal_v3/PaxHeader/mlx.metallib', ollamaMetallibPaxPayload(), 'x'),
    tarEntry('mlx_metal_v3/mlx.metallib', 'metallib'),
  ])
  await writeFile(archivePath, archive, { mode: 0o600 })

  const result = await extractPinnedTarGzipArchive({
    appleDoubleContracts: appleDoubleContracts([['mlx_metal_v3/._mlx.metallib', metadata]]),
    archivePath,
    destination,
    expectedArchiveBytes: archive.length,
    expectedArchiveSha256: createHash('sha256').update(archive).digest('hex'),
    expectedBinaryBytes: 15,
    expectedBinaryRelativePath: 'ollama',
    maxEntries: 8,
    maxExpandedBytes: 32 * 1024,
    maxFileBytes: 16 * 1024,
  })

  assert.equal(result.entries, 5)
  assert.equal(result.files, 2)
  assert.equal(
    await readFile(join(destination, 'mlx_metal_v3', 'mlx.metallib'), 'utf8'),
    'metallib',
  )
  assert.deepEqual(await readdir(join(destination, 'mlx_metal_v3')), ['mlx.metallib'])
})

test('Ollama archive extraction rejects unsafe or detached local PAX metadata', async (t) => {
  const { extractPinnedTarGzipArchive } = await import(moduleURL)
  const metadata = appleDoublePayload()
  const cases = [
    [
      'unknown-field',
      [
        tarEntry('ollama', 'official-binary'),
        tarEntry('mlx_metal_v3/._mlx.metallib', metadata),
        tarEntry('mlx_metal_v3/PaxHeader/mlx.metallib', paxRecord('path', '../escape'), 'x'),
        tarEntry('mlx_metal_v3/mlx.metallib', 'metallib'),
      ],
    ],
    [
      'mismatched-xattr',
      [
        tarEntry('ollama', 'official-binary'),
        tarEntry('mlx_metal_v3/._mlx.metallib', metadata),
        tarEntry(
          'mlx_metal_v3/PaxHeader/mlx.metallib',
          ollamaMetallibPaxPayload({}, { CodeSignature: Buffer.from('signature-b') }),
          'x',
        ),
        tarEntry('mlx_metal_v3/mlx.metallib', 'metallib'),
      ],
    ],
    [
      'detached-pax',
      [
        tarEntry('ollama', 'official-binary'),
        tarEntry('mlx_metal_v3/._mlx.metallib', metadata),
        tarEntry('mlx_metal_v3/PaxHeader/mlx.metallib', ollamaMetallibPaxPayload(), 'x'),
        tarEntry('mlx_metal_v3/other.metallib', 'metallib'),
      ],
    ],
    [
      'malformed-pax-length',
      [
        tarEntry('ollama', 'official-binary'),
        tarEntry('mlx_metal_v3/._mlx.metallib', metadata),
        tarEntry('mlx_metal_v3/PaxHeader/mlx.metallib', '99 mtime=1\n', 'x'),
        tarEntry('mlx_metal_v3/mlx.metallib', 'metallib'),
      ],
    ],
    [
      'duplicate-pax-key',
      [
        tarEntry('ollama', 'official-binary'),
        tarEntry('mlx_metal_v3/._mlx.metallib', metadata),
        tarEntry(
          'mlx_metal_v3/PaxHeader/mlx.metallib',
          Buffer.concat([ollamaMetallibPaxPayload(), paxRecord('mtime', '1')]),
          'x',
        ),
        tarEntry('mlx_metal_v3/mlx.metallib', 'metallib'),
      ],
    ],
    [
      'orphan-pax',
      [
        tarEntry('ollama', 'official-binary'),
        tarEntry('mlx_metal_v3/PaxHeader/mlx.metallib', ollamaMetallibPaxPayload(), 'x'),
        tarEntry('mlx_metal_v3/mlx.metallib', 'metallib'),
      ],
    ],
    [
      'dangling-apple-double',
      [tarEntry('ollama', 'official-binary'), tarEntry('mlx_metal_v3/._mlx.metallib', metadata)],
    ],
    [
      'unexpected-apple-double',
      [tarEntry('ollama', 'official-binary'), tarEntry('lib/._runtime.dylib', metadata)],
    ],
    [
      'apple-double-digest',
      [
        tarEntry('ollama', 'official-binary'),
        tarEntry('mlx_metal_v3/._mlx.metallib', appleDoublePayload(1)),
        tarEntry('mlx_metal_v3/PaxHeader/mlx.metallib', ollamaMetallibPaxPayload(), 'x'),
        tarEntry('mlx_metal_v3/mlx.metallib', 'metallib'),
      ],
    ],
    ['global-pax', [tarEntry('ollama', 'official-binary'), tarEntry('GlobalHead', '', 'g')]],
  ]

  for (const [name, entries] of cases) {
    const root = await mkdtemp(join(tmpdir(), `hexclaw-package-ollama-pax-${name}-`))
    t.after(() => rm(root, { force: true, recursive: true }))
    const archivePath = join(root, 'ollama.tgz')
    const destination = join(root, 'ollama')
    const archive = tarGzip(entries)
    await writeFile(archivePath, archive, { mode: 0o600 })
    await assert.rejects(
      extractPinnedTarGzipArchive({
        appleDoubleContracts: appleDoubleContracts([['mlx_metal_v3/._mlx.metallib', metadata]]),
        archivePath,
        destination,
        expectedArchiveBytes: archive.length,
        expectedArchiveSha256: createHash('sha256').update(archive).digest('hex'),
        expectedBinaryBytes: 15,
        expectedBinaryRelativePath: 'ollama',
        maxEntries: 8,
        maxExpandedBytes: 32 * 1024,
        maxFileBytes: 16 * 1024,
      }),
      /category=ollama-archive/u,
    )
    await assert.rejects(lstat(destination), { code: 'ENOENT' })
  }
})

test('Ollama archive extraction reserves AppleDouble and PaxHeader namespaces for metadata', async (t) => {
  const { extractPinnedTarGzipArchive } = await import(moduleURL)
  const cases = [
    [
      'apple-double-directory',
      [tarEntry('ollama', 'official-binary'), tarEntry('mlx_metal_v3/._mlx.metallib', '', '5')],
    ],
    [
      'apple-double-link',
      [
        tarEntry('ollama', 'official-binary'),
        tarEntry('mlx_metal_v3/source', 'metadata'),
        tarEntry('mlx_metal_v3/._mlx.metallib', '', '2', 'source'),
      ],
    ],
    [
      'pax-header-regular-file',
      [
        tarEntry('ollama', 'official-binary'),
        tarEntry('mlx_metal_v3/PaxHeader/mlx.metallib', 'metadata'),
      ],
    ],
  ]

  for (const [name, entries] of cases) {
    const root = await mkdtemp(join(tmpdir(), `hexclaw-package-ollama-namespace-${name}-`))
    t.after(() => rm(root, { force: true, recursive: true }))
    const archivePath = join(root, 'ollama.tgz')
    const destination = join(root, 'ollama')
    const archive = tarGzip(entries)
    await writeFile(archivePath, archive, { mode: 0o600 })
    await assert.rejects(
      extractPinnedTarGzipArchive({
        archivePath,
        destination,
        expectedArchiveBytes: archive.length,
        expectedArchiveSha256: createHash('sha256').update(archive).digest('hex'),
        expectedBinaryBytes: 15,
        expectedBinaryRelativePath: 'ollama',
        maxEntries: 8,
        maxExpandedBytes: 32 * 1024,
        maxFileBytes: 16 * 1024,
      }),
      /category=ollama-archive/u,
    )
    await assert.rejects(lstat(destination), { code: 'ENOENT' })
  }
})

test('Ollama archive extraction never removes a destination it did not create', async (t) => {
  const { extractPinnedTarGzipArchive } = await import(moduleURL)
  const root = await mkdtemp(join(tmpdir(), 'hexclaw-package-ollama-existing-destination-'))
  t.after(() => rm(root, { force: true, recursive: true }))
  const archivePath = join(root, 'ollama.tgz')
  const destination = join(root, 'ollama')
  const marker = join(destination, 'owner-marker')
  await mkdir(destination, { mode: 0o700 })
  await writeFile(marker, 'preserve', { mode: 0o600 })
  const archive = tarGzip([tarEntry('ollama', 'official-binary'), tarEntry('unsafe', '', '6')])
  await writeFile(archivePath, archive, { mode: 0o600 })

  await assert.rejects(
    extractPinnedTarGzipArchive({
      archivePath,
      destination,
      expectedArchiveBytes: archive.length,
      expectedArchiveSha256: createHash('sha256').update(archive).digest('hex'),
      expectedBinaryBytes: 15,
      expectedBinaryRelativePath: 'ollama',
      maxEntries: 8,
      maxExpandedBytes: 1024,
      maxFileBytes: 512,
    }),
    /category=ollama-archive/u,
  )
  assert.equal(await readFile(marker, 'utf8'), 'preserve')
})

test('Ollama archive extraction rejects traversal links and special entries before publishing', async (t) => {
  const { extractPinnedTarGzipArchive } = await import(moduleURL)
  const cases = [
    ['traversal', tarEntry('../escape', 'secret')],
    ['symbolic-link', tarEntry('ollama', '', '2', '/tmp/escape')],
    ['relative-symbolic-link-traversal', tarEntry('lib/alias', '', '2', '../outside')],
    ['hard-link', tarEntry('ollama', '', '1', 'outside')],
    ['fifo', tarEntry('ollama', '', '6')],
  ]
  for (const [name, entry] of cases) {
    const root = await mkdtemp(join(tmpdir(), `hexclaw-package-ollama-${name}-`))
    t.after(() => rm(root, { force: true, recursive: true }))
    const archivePath = join(root, 'ollama.tgz')
    const destination = join(root, 'ollama')
    const archive = tarGzip([entry])
    await writeFile(archivePath, archive, { mode: 0o600 })
    await assert.rejects(
      extractPinnedTarGzipArchive({
        archivePath,
        destination,
        expectedArchiveBytes: archive.length,
        expectedArchiveSha256: createHash('sha256').update(archive).digest('hex'),
        expectedBinaryBytes: 1,
        expectedBinaryRelativePath: 'ollama',
        maxEntries: 8,
        maxExpandedBytes: 1024,
        maxFileBytes: 512,
      }),
      /category=ollama-archive/u,
    )
    await assert.rejects(lstat(destination), { code: 'ENOENT' })
  }
})
