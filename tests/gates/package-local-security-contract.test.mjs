import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { promisify } from 'node:util'

const makefileURL = new URL('../../Makefile', import.meta.url)
const makefilePath = fileURLToPath(makefileURL)
const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const packageManifestURL = new URL('../../package.json', import.meta.url)
const packageWorkflowURL = new URL('../../.github/workflows/package.yml', import.meta.url)
const releaseWorkflowURL = new URL('../../.github/workflows/release.yml', import.meta.url)
const orchestratorURL = new URL('../../scripts/ci/package-local.mjs', import.meta.url)
const dependencyProvenanceURL = new URL(
  '../../scripts/ci/package-dependency-provenance.mjs',
  import.meta.url,
)
const publicationURL = new URL(
  '../../scripts/ci/package-generation-publication.mjs',
  import.meta.url,
)
const execFileAsync = promisify(execFile)

function targetRecipe(source, name, nextName) {
  const start = source.indexOf(`${name}:`)
  const end = source.indexOf(`\n${nextName}:`, start)
  assert.notEqual(start, -1, `${name} target must exist`)
  assert.notEqual(end, -1, `${nextName} target must follow ${name}`)
  return source.slice(start, end)
}

test('package and release workflows execute the focused package security gates', async () => {
  const [packageManifest, ...workflows] = await Promise.all([
    readFile(packageManifestURL, 'utf8').then(JSON.parse),
    readFile(packageWorkflowURL, 'utf8'),
    readFile(releaseWorkflowURL, 'utf8'),
  ])
  const command = packageManifest.scripts?.['test:package-gates']
  assert.equal(typeof command, 'string')
  for (const pathname of [
    'tests/gates/package-local-orchestrator.test.mjs',
    'tests/gates/package-local-security-contract.test.mjs',
    'tests/gates/package-sensitive-boundary.test.mjs',
    'tests/gates/pdf-worker-package-asset.test.mjs',
    'tests/native/package-local-environment-contract.test.mjs',
    'tests/native/render-bundle-reproducibility-contract.test.mjs',
  ]) {
    assert.equal(command.includes(pathname), true, `${pathname} must be collected`)
  }
  for (const workflow of workflows) {
    assert.match(workflow, /run:\s*pnpm test:package-gates/u)
  }
})

test('Make owns no package state and delegates only to the fixed Node orchestrator', async () => {
  const source = await readFile(makefileURL, 'utf8')
  const recipe = targetRecipe(source, 'package-local', 'verify-package-local')
  const verifyRecipe = targetRecipe(source, 'verify-package-local', 'build-web')

  assert.match(source, /^override PACKAGE_LOCAL_NODE\s*:=/mu)
  assert.match(source, /^override PACKAGE_LOCAL_ORCHESTRATOR\s*:=/mu)
  assert.match(
    recipe,
    /^package-local:\s*\n\t@\$\(PACKAGE_LOCAL_NODE\) \$\(PACKAGE_LOCAL_ORCHESTRATOR\) build\s*$/mu,
  )
  assert.match(verifyRecipe, /\$\(PACKAGE_LOCAL_NODE\) \$\(PACKAGE_LOCAL_ORCHESTRATOR\) verify/)
  for (const forbidden of [
    'build-local',
    'generation=',
    'PACKAGE_LOCAL_CARGO_TARGET_DIR',
    'SIDECAR_BIN_DIR',
    'shasum',
    'hdiutil',
    'ditto',
    'trap ',
  ]) {
    assert.equal(recipe.includes(forbidden), false)
    assert.equal(verifyRecipe.includes(forbidden), false)
  }

  const { stdout } = await execFileAsync(
    '/usr/bin/make',
    [
      '--no-print-directory',
      '-n',
      'package-local',
      'PACKAGE_LOCAL_NODE=/tmp/host-node',
      'PACKAGE_LOCAL_ORCHESTRATOR=/tmp/host-orchestrator',
      'HEXCLAW_LOCAL_SRC=/tmp/host-source',
      'GOWORK=/tmp/host-go.work',
      'GOOS=windows',
      'GOARCH=arm64',
      'SHELL=/tmp/host-shell',
      '.SHELLFLAGS=-c',
    ],
    { cwd: repoRoot, maxBuffer: 64 * 1024 },
  )
  const expectedNode = process.arch === 'arm64' ? '/opt/homebrew/bin/node' : '/usr/local/bin/node'
  assert.equal(stdout.trim(), `${expectedNode} ${fileURLToPath(orchestratorURL)} build`)

  const { stdout: database } = await execFileAsync(
    '/usr/bin/make',
    ['--no-print-directory', '-pn', 'package-local', 'SHELL=/tmp/host-shell', '.SHELLFLAGS=-c'],
    { cwd: repoRoot, maxBuffer: 4 * 1024 * 1024 },
  )
  assert.match(database, /^SHELL\s*:?=\s*\/bin\/sh$/mu)
  assert.match(database, /^\.SHELLFLAGS\s*:?=\s*-c$/mu)
})

test('Node orchestrator owns build hardening and current pointer is the only publication commit', async () => {
  const source = await readFile(orchestratorURL, 'utf8')
  const publication = await readFile(publicationURL, 'utf8')
  const writeResult = source.indexOf('await operations.writeBuildResult(context)')
  const stagedVerification = source.indexOf('await operations.verifyStagedPackage(context)')
  const publishGeneration = source.indexOf("'publishGeneration',")
  const verifyPublished = source.indexOf("'verifyPublishedPackage',")
  const commitCurrent = source.indexOf("'commitCurrent',")

  assert.match(source, /'build',\s*'-trimpath',/u)
  assert.match(source, /--remap-path-prefix=\$\{plan\.hostHome\}=\/build\/home/u)
  assert.match(
    source,
    /--remap-path-prefix=\$\{join\(plan\.hostHome, '\.cargo'\)\}=\/build\/cargo/u,
  )
  assert.match(source, /'--norsrc',\s*'--noextattr',\s*'--noqtn',\s*'--noacl'/u)
  assert.match(source, /runSensitiveBoundary\(\s*context,\s*'sanitize'/u)
  assert.match(source, /capturedBuildToolchains\(sourceManifest\?\.toolchains\)/u)
  assert.doesNotMatch(source, /capturedBuildToolchains\(verified\.toolchains\)/u)
  assert.match(
    source,
    /cleanupCapturedToolchains\(toolchains, plan\.paths\.generationReleaseRoot\)/u,
  )
  assert.doesNotMatch(source, /bindManifestToolchains/u)
  assert.ok(writeResult >= 0 && writeResult < stagedVerification)
  assert.ok(publishGeneration >= 0 && publishGeneration < verifyPublished)
  assert.ok(verifyPublished < commitCurrent)
  assert.match(publication, /await inspectImmutableTree\(layout\.candidateRoot, true\)/u)
  assert.match(
    publication,
    /await rename\(layout\.candidateRoot, layout\.publishedGenerationRoot\)/u,
  )
  assert.match(publication, /await rename\(temporaryPath, layout\.currentPointerPath\)/u)
  assert.match(publication, /await inspectImmutableTree\(layout\.publishedGenerationRoot, false\)/u)
  assert.doesNotMatch(source, /publish(?:Dist|App|Dmg|Manifest|SourceManifest|Receipt)/u)
})

test('every published consumer resolves current v2 and verifies the full attested generation', async () => {
  const [source, publication, makefile] = await Promise.all([
    readFile(orchestratorURL, 'utf8'),
    readFile(publicationURL, 'utf8'),
    readFile(makefileURL, 'utf8'),
  ])
  const resolverStart = source.indexOf('async function resolvePublishedPlan()')
  const verifierStart = source.indexOf('async function verifyPublishedPackage()')
  const verifierEnd = source.indexOf('\nfunction safeCLIError(', verifierStart)
  assert.ok(resolverStart >= 0 && verifierStart > resolverStart && verifierEnd > verifierStart)
  const resolver = source.slice(resolverStart, verifierStart)
  const verifier = source.slice(verifierStart, verifierEnd)

  assert.match(resolver, /resolveCurrentPackageGeneration\(/u)
  assert.match(verifier, /verifyPackageSourceManifest\(/u)
  assert.match(verifier, /verifyPackageLocal\(/u)
  assert.match(publication, /generation_sha256: generationSHA256/u)
  assert.match(publication, /generationIdentity\.sha256 !== pointer\.generation_sha256/u)
  assert.doesNotMatch(
    source,
    /canonical(?:App|Dist|Dmg|Manifest|Receipt|SourceManifest)|publish(?:Dist|App|Dmg|Manifest|Receipt|SourceManifest)/u,
  )
  assert.match(
    makefile,
    /^verify-package-local:\s*\n\t@\$\(PACKAGE_LOCAL_NODE\) \$\(PACKAGE_LOCAL_ORCHESTRATOR\) verify\s*$/mu,
  )
})

test('package commands use the bounded runner termination-window contract', async () => {
  const source = await readFile(orchestratorURL, 'utf8')
  const start = source.indexOf('async function runPackageCommand(')
  const end = source.indexOf('\nfunction capturedBuildToolchains(', start)
  assert.ok(start >= 0 && end > start)
  const commandRunner = source.slice(start, end)

  assert.doesNotMatch(commandRunner, /terminate(?:Grace|Confirm)Ms:/u)
})

test('dependency provenance failures expose only bounded normalized categories', async () => {
  const [{ classifyPackageDependencyError }, { PackageDependencyProvenanceError }] =
    await Promise.all([import(orchestratorURL), import(dependencyProvenanceURL)])

  assert.equal(
    classifyPackageDependencyError(new PackageDependencyProvenanceError('node:install:exit')),
    'node-install-exit',
  )
  assert.equal(classifyPackageDependencyError(new Error('synthetic failure')), undefined)
  assert.equal(
    classifyPackageDependencyError(
      new PackageDependencyProvenanceError(`node:install:${'x'.repeat(96)}`),
    ),
    undefined,
  )
  assert.equal(
    classifyPackageDependencyError(
      new PackageDependencyProvenanceError('node:install:exit\nsynthetic-secret'),
    ),
    undefined,
  )
})

test('Tauri PATH exposes the frozen Node and Cargo snapshots plus fixed system tools only', async () => {
  const source = await readFile(orchestratorURL, 'utf8')
  const start = source.indexOf('function cargoEnvironment(')
  const end = source.indexOf('\nasync function runSensitiveBoundary(', start)
  assert.ok(start >= 0 && end > start)
  const environment = source.slice(start, end)

  assert.match(environment, /CI:\s*'true'/u)
  assert.match(
    environment,
    /PATH:\s*\[\s*dirname\(toolchains\.node\.canonical\),\s*dirname\(toolchains\.cargo\.canonical\),\s*'\/usr\/bin',\s*'\/bin',\s*'\/usr\/sbin',\s*'\/sbin',?\s*\]\.join\(\s*delimiter,?\s*\)/u,
  )
  const pathStart = environment.indexOf('    PATH:')
  const pathEnd = environment.indexOf('    RUSTC:', pathStart)
  assert.ok(pathStart >= 0 && pathEnd > pathStart)
  assert.doesNotMatch(environment.slice(pathStart, pathEnd), /plan\.hostHome|\.cargo\/bin/u)
})

test('late package commands expose stable stage-specific failure categories', async () => {
  const source = await readFile(orchestratorURL, 'utf8')

  for (const category of ['frontend-build', 'cargo-fetch', 'cargo-metadata', 'tauri-build']) {
    assert.match(source, new RegExp(`\\.catch\\(\\(\\) => fail\\('${category}'\\)\\)`, 'u'))
  }
})

test('sidecar metadata is bound to the frozen source manifest without live Git queries', async () => {
  const { sidecarBuildMetadataFromManifest } = await import(orchestratorURL)
  const source = await readFile(orchestratorURL, 'utf8')
  const metadata = sidecarBuildMetadataFromManifest({
    repositories: [
      {
        id: 'hexclaw',
        vcs: {
          commitDate: '2026-08-11T01:02:03+08:00',
          describe: 'abcdef012345-dirty',
          head: 'abcdef0123456789abcdef0123456789abcdef01',
          tags: [],
        },
      },
      {
        id: 'hexagon',
        vcs: {
          commitDate: '2026-08-10T01:02:03+08:00',
          describe: 'v1.2.3',
          head: '1234567890abcdef1234567890abcdef12345678',
          tags: ['v1.2.3'],
        },
      },
    ],
  })

  assert.deepEqual(metadata, {
    buildDate: '2026-08-11T01:02:03+08:00',
    commit: 'abcdef012345',
    hexagonVersion: 'v1.2.3',
  })
  assert.match(source, /sidecarBuildMetadataFromManifest\(sourceManifest\)/u)
  assert.doesNotMatch(source, /async function gitValue|\['rev-parse'|\['describe'/u)
})

test('sidecar creates an overridden output directory before writing the Go binary', async () => {
  const generationDirectory = '/tmp/hexclaw-contract-generation/binaries'
  const { stdout } = await execFileAsync(
    '/usr/bin/make',
    [
      '--no-print-directory',
      '-n',
      '-f',
      makefilePath,
      'sidecar',
      `SIDECAR_BIN_DIR=${generationDirectory}`,
    ],
    { cwd: repoRoot, maxBuffer: 1024 * 1024 },
  )
  const mkdirOutput = `mkdir -p "${generationDirectory}"`
  const binaryOutput = `-o "${generationDirectory}/hexclaw-`

  assert.ok(stdout.indexOf(mkdirOutput) >= 0)
  assert.ok(stdout.indexOf(binaryOutput) > stdout.indexOf(mkdirOutput))
  assert.equal(stdout.includes('mkdir -p src-tauri/binaries'), false)
})

test('every maintained Go sidecar build enables trimpath', async () => {
  const source = await readFile(makefileURL, 'utf8')
  const goBuildLines = source.split(/\r?\n/u).filter((line) => /\bgo build\b/u.test(line))

  assert.ok(goBuildLines.length >= 5)
  assert.equal(
    goBuildLines.every((line) => line.includes('-trimpath')),
    true,
  )
  assert.doesNotMatch(source, /@mkdir -p src-tauri\/binaries/)
  assert.equal(source.match(/@mkdir -p "\$\(SIDECAR_BIN_DIR\)"/g)?.length, 5)
})

test('pinned Ollama resources pass the sensitive boundary before Tauri packaging', async () => {
  const source = await readFile(orchestratorURL, 'utf8')
  const verifyOllama = source.indexOf('async verifyOllama(context)')
  const buildFrontend = source.indexOf('async buildFrontend(context)')
  assert.ok(verifyOllama >= 0 && buildFrontend > verifyOllama)
  const stage = source.slice(verifyOllama, buildFrontend)

  assert.match(
    stage,
    /runRootSensitiveBoundary\(context, plan\.paths\.generationOllamaRoot, 'ollama'\)/u,
  )
})
