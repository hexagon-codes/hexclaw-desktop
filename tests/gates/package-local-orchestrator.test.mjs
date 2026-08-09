import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, 'utf8')
  header.write(octalField(type === '5' ? 0o755 : 0o700, 8), 100, 8, 'ascii')
  header.write(octalField(0, 8), 108, 8, 'ascii')
  header.write(octalField(0, 8), 116, 8, 'ascii')
  header.write(octalField(type === '0' ? payload.length : 0, 12), 124, 12, 'ascii')
  header.write(octalField(0, 12), 136, 12, 'ascii')
  header.fill(0x20, 148, 156)
  header.write(type, 156, 1, 'ascii')
  header.write(linkName, 157, 100, 'utf8')
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')
  const checksum = [...header].reduce((total, value) => total + value, 0)
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
  const padding = Buffer.alloc((512 - (payload.length % 512)) % 512)
  return Buffer.concat([header, type === '0' ? payload : Buffer.alloc(0), padding])
}

function tarGzip(entries) {
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]), { level: 9 })
}

function pipelineOperations(events, failureStage = '') {
  const stage = (name, result) => async (context) => {
    events.push([name, context])
    if (failureStage === name) throw new Error('synthetic pipeline failure')
    return result
  }
  return {
    invalidateCanonical: stage('invalidate-canonical'),
    createSourceManifest: stage('create-source-manifest', { sha256: 'a'.repeat(64) }),
    resolveToolchains: stage('resolve-toolchains', { go: 'bound' }),
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
    verifySourceManifest: stage('verify-source-manifest'),
    sanitizeAndVerify: stage('sanitize-and-verify'),
    createDmg: stage('create-dmg'),
    createAttestation: stage('create-attestation', { receiptSHA256: 'c'.repeat(64) }),
    verifyStagedPackage: stage('verify-staged-package'),
    publishDist: stage('publish-dist'),
    publishApp: stage('publish-app'),
    publishDmg: stage('publish-dmg'),
    publishManifest: stage('publish-manifest'),
    publishSourceManifest: stage('publish-source-manifest'),
    writeBuildResult: stage('write-build-result'),
    publishReceipt: stage('publish-receipt'),
    cleanupCanonical: stage('cleanup-canonical'),
  }
}

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
  assert.equal(plan.paths.generationRoot.startsWith(plan.paths.canonicalDmgDirectory), true)
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
  assert.equal(plan.paths.privateCargoHome.startsWith(plan.paths.generationRoot), true)
  assert.equal(plan.paths.privateCargoTarget.startsWith(plan.paths.generationRoot), true)
  assert.equal(plan.paths.generationBinaries.startsWith(plan.paths.generationRoot), true)
  assert.equal(plan.paths.generationOllamaRoot.startsWith(plan.paths.generationRoot), true)
  assert.equal(plan.paths.generationDist.startsWith(plan.paths.generationRoot), true)
  assert.equal(plan.paths.generationApp.startsWith(plan.paths.generationRoot), true)
  assert.equal(plan.paths.canonicalSourceManifest, join(plan.paths.canonicalDmgDirectory, 'package-source-manifest.json'))
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
  const {
    createDependencyProvenanceOptions,
    createGoBuildEnvironment,
    createPackageLocalPlan,
  } = await import(moduleURL)
  const plan = createPackageLocalPlan({
    desktopRoot: '/workspace/hexclaw-desktop',
    generationId: '9'.repeat(32),
    hostHome: '/Users/developer',
    targetTriple: 'x86_64-apple-darwin',
    version: '0.5.0-beta',
  })
  const options = createDependencyProvenanceOptions(plan, {
    go: {
      canonical: '/usr/local/go/bin/go',
      executableSha256: 'a'.repeat(64),
      goroot: '/usr/local/go',
    },
    node: { canonical: '/usr/local/bin/node', executableSha256: 'b'.repeat(64) },
    pnpm: { canonical: '/usr/local/bin/pnpm', executableSha256: 'c'.repeat(64) },
  })

  assert.equal(options.generationRoot, plan.paths.generationRoot)
  assert.equal(options.sourceRoot, plan.paths.projectedDesktopRoot)
  assert.deepEqual(options.go.moduleRoots, plan.paths.projectedGoModuleRoots)
  assert.equal(options.go.goWork, plan.paths.projectedGoWork)
  assert.equal(options.go.executable, '/usr/local/go/bin/go')
  assert.equal(options.go.sha256, 'a'.repeat(64))
  assert.equal(options.node.executable, '/usr/local/bin/node')
  assert.equal(options.pnpm.executable, '/usr/local/bin/pnpm')
  for (const path of [options.sourceRoot, options.go.goWork, ...options.go.moduleRoots]) {
    assert.equal(path.startsWith(plan.paths.generationRoot), true)
  }

  const goEnvironment = createGoBuildEnvironment(plan, {
    go: {
      environment: {
        GOENV: 'off',
        GOPROXY: 'off',
        GOROOT: '/usr/local/go',
        GOTOOLCHAIN: 'local',
        GOWORK: plan.paths.projectedGoWork,
        HOME: join(plan.paths.generationRoot, 'go-home'),
        PATH: '/usr/bin:/bin',
        TMPDIR: join(plan.paths.generationRoot, 'go-tmp'),
      },
    },
  })
  assert.equal(goEnvironment.GOOS, 'darwin')
  assert.equal(goEnvironment.GOARCH, 'amd64')
  assert.equal(goEnvironment.CGO_ENABLED, '0')
  assert.equal(goEnvironment.GOWORK, plan.paths.projectedGoWork)
  assert.equal(goEnvironment.GOTOOLCHAIN, 'local')
  assert.equal(goEnvironment.GOPROXY, 'off')
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

test('package-local pipeline verifies source after every build and publishes receipt last', async () => {
  const { createPackageLocalPlan, runPackageBuildPipeline } = await import(moduleURL)
  const plan = createPackageLocalPlan({
    desktopRoot: '/workspace/hexclaw-desktop',
    generationId: '2'.repeat(32),
    hostHome: '/Users/developer',
    targetTriple: 'aarch64-apple-darwin',
    version: '0.5.0-beta',
  })
  const events = []
  const result = await runPackageBuildPipeline(plan, pipelineOperations(events))
  const names = events.map(([name]) => name)

  assert.deepEqual(names, [
    'invalidate-canonical',
    'create-source-manifest',
    'resolve-toolchains',
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
    'verify-app-resources',
    'verify-source-manifest',
    'sanitize-and-verify',
    'create-dmg',
    'create-attestation',
    'verify-staged-package',
    'publish-dist',
    'publish-app',
    'publish-dmg',
    'publish-manifest',
    'publish-source-manifest',
    'write-build-result',
    'publish-receipt',
  ])
  assert.equal(result.sourceManifestSHA256, 'a'.repeat(64))
  assert.equal(result.receiptSHA256, 'c'.repeat(64))
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
  assert.equal(names.at(-1), 'publish-receipt')
})

test('package-local pipeline removes every canonical artifact after any failed stage', async () => {
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
  assert.equal(names.includes('publish-dist'), false)
  assert.equal(names.includes('publish-receipt'), false)
  assert.equal(names.at(-1), 'cleanup-canonical')
  const cleanup = events.at(-1)[1]
  assert.deepEqual(cleanup.canonicalArtifacts, [
    plan.paths.canonicalDist,
    plan.paths.canonicalApp,
    plan.paths.canonicalDmg,
    plan.paths.canonicalManifest,
    plan.paths.canonicalSourceManifest,
    plan.paths.canonicalReceipt,
  ])
})

test('held package build creates one private generation before entering the pipeline', async (t) => {
  const { createPackageLocalPlan, runHeldPackageBuild } = await import(moduleURL)
  const root = await mkdtemp(join(tmpdir(), 'hexclaw-package-held-build-'))
  t.after(() => rm(root, { force: true, recursive: true }))
  const plan = createPackageLocalPlan({
    desktopRoot: join(root, 'hexclaw-desktop'),
    generationId: '7'.repeat(32),
    hostHome: '/Users/developer',
    targetTriple: 'x86_64-apple-darwin',
    version: '0.5.0-beta',
  })
  const events = []

  const result = await runHeldPackageBuild(plan, pipelineOperations(events))

  const metadata = await lstat(plan.paths.generationRoot)
  assert.equal(metadata.isDirectory(), true)
  assert.equal(metadata.mode & 0o777, 0o700)
  assert.equal(result.generationId, plan.generationId)
  assert.equal(events[0][0], 'invalidate-canonical')
  await assert.rejects(
    runHeldPackageBuild(plan, pipelineOperations([])),
    /category=generation-exists/u,
  )
})

test('held final verifier binds build result before canonical source dependencies and package', async () => {
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
      ['verifyCanonicalSource', async () => { events.push('source') }],
      ['verifyDependencies', async () => { events.push('dependencies') }],
      ['verifyCanonicalResources', async () => { events.push('resources') }],
      ['verifyCanonicalPackage', async () => { events.push('package') }],
    ].map(([name, operation]) => [name, operation]),
  )

  const verified = await runHeldFinalVerification(plan, adapters)

  assert.deepEqual(events, ['source', 'dependencies', 'resources', 'package'])
  assert.equal(verified, result)
})

test('package-local pins the official Ollama identity and safe Tauri resource overlay', async () => {
  const [
    { getOllamaPackageContract, createPackageLocalPlan, createTauriPackageOverlay },
    { OLLAMA_PACKAGE_CONTRACT },
  ] = await Promise.all([
    import(moduleURL),
    import('../../scripts/ci/verify-sidecar-version.mjs'),
  ])
  const ollamaContract = getOllamaPackageContract()
  const plan = createPackageLocalPlan({
    desktopRoot: '/workspace/hexclaw-desktop',
    generationId: '4'.repeat(32),
    hostHome: '/Users/developer',
    targetTriple: 'x86_64-apple-darwin',
    version: '0.5.0-beta',
  })
  const overlay = createTauriPackageOverlay(plan)

  assert.strictEqual(ollamaContract, OLLAMA_PACKAGE_CONTRACT)
  assert.equal(overlay.build.beforeBuildCommand, '')
  assert.equal(overlay.build.frontendDist, plan.paths.generationDist)
  assert.equal(overlay.bundle.resources['binaries/ollama-bundle'], null)
  assert.equal(overlay.bundle.resources['render-assets/*'], 'assets/render/')
  assert.equal(overlay.bundle.resources[plan.paths.generationOllamaRoot], 'ollama')
  assert.deepEqual(overlay.bundle.externalBin, [
    join(plan.paths.generationBinaries, 'hexclaw'),
    join(plan.paths.generationBinaries, 'pandoc'),
    join(plan.paths.generationBinaries, 'typst'),
  ])
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
  assert.equal(await readFile(join(projectedRoot, 'src', 'main.ts'), 'utf8'), sources['src/main.ts'])
  await assert.rejects(lstat(join(projectedRoot, 'node_modules')), { code: 'ENOENT' })
})

test('package source projection isolates all five repositories and workspace files in one generation', async (t) => {
  const { projectPackageSourceFromManifest } = await import(moduleURL)
  const root = await mkdtemp(join(tmpdir(), 'hexclaw-package-source-projection-'))
  t.after(() => rm(root, { force: true, recursive: true }))
  const sourceWorkRoot = join(root, 'work')
  const projectedWorkRoot = join(root, 'generation', 'source')
  const repositoryNames = ['toolkit', 'ai-core', 'hexagon', 'hexclaw', 'hexclaw-desktop']
  const repositories = []
  let expectedBytes = 0

  for (const name of repositoryNames) {
    const relativePath = name === 'hexclaw-desktop' ? 'src/main.ts' : 'module.go'
    const bytes = `${name}\n`
    const pathname = join(sourceWorkRoot, name, relativePath)
    await mkdir(dirname(pathname), { mode: 0o700, recursive: true })
    await writeFile(pathname, bytes, { mode: 0o600 })
    expectedBytes += Buffer.byteLength(bytes)
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

  const workspaceFiles = []
  for (const [path, bytes] of [
    ['go.work', 'go 1.26.0\n'],
    ['go.work.sum', 'fixture checksum\n'],
  ]) {
    await writeFile(join(sourceWorkRoot, path), bytes, { mode: 0o600 })
    expectedBytes += Buffer.byteLength(bytes)
    workspaceFiles.push({
      mode: '100600',
      path,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: Buffer.byteLength(bytes),
    })
  }

  const result = await projectPackageSourceFromManifest({
    manifest: { repositories, workspace: { files: workspaceFiles } },
    projectedWorkRoot,
    sourceWorkRoot,
  })

  assert.deepEqual(result, { copiedBytes: expectedBytes, copiedFiles: 7 })
  for (const repository of repositories) {
    const file = repository.files[0]
    assert.equal(
      await readFile(join(projectedWorkRoot, repository.id, file.path), 'utf8'),
      `${repository.id}\n`,
    )
  }
  assert.equal(await readFile(join(projectedWorkRoot, 'go.work'), 'utf8'), 'go 1.26.0\n')
  await assert.rejects(
    lstat(join(projectedWorkRoot, 'hexclaw-desktop', 'node_modules')),
    { code: 'ENOENT' },
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

test('Ollama archive extraction rejects traversal links and special entries before publishing', async (t) => {
  const { extractPinnedTarGzipArchive } = await import(moduleURL)
  const cases = [
    ['traversal', tarEntry('../escape', 'secret')],
    ['symbolic-link', tarEntry('ollama', '', '2', '/tmp/escape')],
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
