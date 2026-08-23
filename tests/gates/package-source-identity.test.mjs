import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const identityModuleURL = new URL('../../scripts/ci/package-source-identity.mjs', import.meta.url)
const boundedProcessModuleURL = new URL('../../scripts/ci/run-bounded-process.mjs', import.meta.url)
const repositoryIDs = ['toolkit', 'ai-core', 'hexagon', 'hexclaw', 'hexclaw-desktop']
const moduleByRepository = new Map([
  ['toolkit', 'github.com/hexagon-codes/toolkit'],
  ['ai-core', 'github.com/hexagon-codes/ai-core'],
  ['hexagon', 'github.com/hexagon-codes/hexagon'],
  ['hexclaw', 'github.com/hexagon-codes/hexclaw'],
])
const target = process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'

async function loadIdentity() {
  const module = await import(identityModuleURL).catch(() => ({}))
  for (const name of [
    'createPackageSourceManifest',
    'verifyPackageSourceManifest',
    'resolveProductionSourceLayout',
    'createPackageSourceIdentityTestAdapter',
    'resolveExecutableForTest',
    'resolveRustToolExecutableForTest',
    'validateProductionPlatformForTest',
  ]) {
    assert.equal(typeof module[name], 'function', `package source identity must export ${name}`)
  }
  return module
}

async function git(root, ...args) {
  await execFileAsync('/usr/bin/git', ['-C', root, ...args], {
    env: {
      PATH: '/usr/bin:/bin',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      LC_ALL: 'C',
    },
  })
}

async function write(root, relativePath, content, mode) {
  const path = join(root, relativePath)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
  if (mode !== undefined) await chmod(path, mode)
  return path
}

function fixtureToolchains(requestedTarget) {
  const digest = (value) => createHash('sha256').update(value).digest('hex')
  const executablePath = (name) => `/fixture/toolchains/${name}`
  const goArchitecture =
    requestedTarget === 'x86_64-apple-darwin'
      ? 'amd64'
      : requestedTarget === 'aarch64-apple-darwin'
        ? 'arm64'
        : 'fixture'
  const nodeArchitecture =
    requestedTarget === 'x86_64-apple-darwin'
      ? 'x64'
      : requestedTarget === 'aarch64-apple-darwin'
        ? 'arm64'
        : 'fixture'
  return {
    target: requestedTarget,
    git: {
      executablePath: executablePath('git'),
      version: 'git version fixture',
      executableSha256: digest('git'),
      sourceSha256: digest('git'),
    },
    go: {
      version: 'go version go1.fixture fixture/fixture',
      compileVersion: 'compile version fixture',
      executablePath: executablePath('go'),
      executableSha256: digest('go'),
      sourceSha256: digest('go'),
      env: {
        GOOS: 'darwin',
        GOARCH: goArchitecture,
        GOROOT: '/fixture/toolchains/goroot',
        GOVERSION: 'go1.fixture',
      },
    },
    node: {
      version: 'vfixture',
      executablePath: executablePath('node'),
      executableSha256: digest('node'),
      sourceSha256: digest('node'),
      platform: 'darwin',
      architecture: nodeArchitecture,
    },
    pnpm: {
      version: 'fixture',
      executablePath: executablePath('pnpm'),
      executableSha256: digest('pnpm'),
      sourceSha256: digest('pnpm'),
      supportFiles: [],
    },
    rustc: {
      version: 'rustc fixture',
      executablePath: executablePath('rustc'),
      host: requestedTarget,
      executableSha256: digest('rustc'),
      sourceSha256: digest('rustc'),
    },
    cargo: {
      version: 'cargo fixture',
      executablePath: executablePath('cargo'),
      executableSha256: digest('cargo'),
      sourceSha256: digest('cargo'),
    },
  }
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

async function createFakeToolchain(root, options = {}) {
  const requestedTarget = options.target ?? target
  const goArchitecture = requestedTarget === 'aarch64-apple-darwin' ? 'arm64' : 'amd64'
  const bin = join(root, 'bin')
  const goRoot = join(root, 'go-root')
  const rustupHome = join(root, 'rustup-home')
  await mkdir(bin, { mode: 0o700, recursive: true })
  await mkdir(goRoot, { mode: 0o700 })
  await mkdir(rustupHome, { mode: 0o700 })
  const rustToolchainRoot = join(root, 'rust-toolchain')
  const rustToolchainBin = join(rustToolchainRoot, 'bin')
  await mkdir(rustToolchainBin, { mode: 0o700, recursive: true })
  const environmentProbe = options.environmentLog
    ? `/usr/bin/env > ${shellQuote(options.environmentLog)}\n`
    : ''
  const gitPrelude = options.gitPrelude ?? ''
  const gitPath = await write(
    bin,
    'git',
    `#!/bin/sh\nif [ "$1" = --version ]; then\n${environmentProbe}${gitPrelude}  printf '%s\\n' 'git version fixture'\n  exit 0\nfi\nexec /usr/bin/git "$@"\n`,
    0o500,
  )
  await write(
    bin,
    'go',
    `#!/bin/sh\ncase "$1" in\n  version) printf '%s\\n' 'go version go1.25.7 darwin/${goArchitecture}' ;;\n  tool) printf '%s\\n' 'compile version go1.25.7' ;;\n  env) printf '%s\\n' ${shellQuote(JSON.stringify({ CGO_ENABLED: '1', GOARCH: goArchitecture, GOEXPERIMENT: '', GOOS: 'darwin', GOROOT: goRoot, GOTOOLCHAIN: 'local', GOVERSION: 'go1.25.7' }))} ;;\n  *) exit 64 ;;\nesac\n`,
    0o500,
  )
  const rustcPath = await write(
    rustToolchainBin,
    'rustc-real',
    `#!/bin/sh\nprintf '%s\\n' 'rustc 1.94.0 (fixture)' 'binary: rustc' 'commit-hash: fixture' 'commit-date: 2026-08-10' 'host: ${requestedTarget}' 'release: 1.94.0' 'LLVM version: fixture'\n`,
    0o500,
  )
  const cargoPath = await write(
    rustToolchainBin,
    'cargo-real',
    `#!/bin/sh\nprintf '%s\\n' 'cargo 1.94.0 (fixture)' 'release: 1.94.0' 'commit-hash: fixture' 'commit-date: 2026-08-10' 'host: ${requestedTarget}' 'libgit2: fixture' 'libcurl: fixture' 'ssl: fixture' 'os: macos fixture'\n`,
    0o500,
  )
  const rustupPath = await write(
    bin,
    'rustup',
    `#!/bin/sh\nif [ "$1" = which ] && [ "$2" = rustc ]; then printf '%s\\n' ${shellQuote(rustcPath)}; exit 0; fi\nif [ "$1" = which ] && [ "$2" = cargo ]; then printf '%s\\n' ${shellQuote(cargoPath)}; exit 0; fi\nif [ "$1" = --version ]; then printf '%s\\n' 'rustup 1.28.2 (fixture)'; exit 0; fi\nexit 64\n`,
    0o500,
  )
  await link(rustupPath, join(bin, 'rustc'))
  await link(rustupPath, join(bin, 'cargo'))
  const rustObjcopyRelative = `lib/rustlib/${requestedTarget}/bin/rust-objcopy`
  const rustLibraryRelative = `lib/rustlib/${requestedTarget}/lib/libstd.rlib`
  await write(rustToolchainRoot, rustObjcopyRelative, '#!/bin/sh\nexit 0\n', 0o500)
  await write(rustToolchainRoot, rustLibraryRelative, 'fixture rust library\n', 0o400)
  await write(bin, 'pnpm', "#!/bin/sh\nprintf '%s\\n' '10.0.0'\n", 0o500)
  const nodePath = await write(bin, 'node', "#!/bin/sh\nprintf '%s\\n' 'v24.0.0'\n", 0o500)
  return Object.freeze({
    gitPath,
    goRoot,
    nodePath,
    path: bin,
    rustupHome,
    snapshotRustToolchain: true,
  })
}

async function createFixture(name) {
  const workRoot = await mkdtemp(join(tmpdir(), `hexclaw-source-identity-${name}-`))
  const roots = Object.fromEntries(repositoryIDs.map((id) => [id, join(workRoot, id)]))

  for (const id of repositoryIDs) {
    await mkdir(roots[id], { recursive: true })
    await git(roots[id], 'init', '--quiet')
    if (moduleByRepository.has(id)) {
      await write(roots[id], 'go.mod', `module ${moduleByRepository.get(id)}\n\ngo 1.25.7\n`)
      await git(roots[id], 'add', 'go.mod')
    } else {
      await write(roots[id], 'package.json', '{"name":"hexclaw-desktop","private":true}\n')
      await git(roots[id], 'add', 'package.json')
    }
    await git(
      roots[id],
      '-c',
      'user.name=Package Fixture',
      '-c',
      'user.email=package-fixture@example.invalid',
      'commit',
      '--quiet',
      '--no-gpg-sign',
      '-m',
      'initial fixture',
    )
  }

  await writeFile(
    join(workRoot, 'go.work'),
    [
      'go 1.25.7',
      '',
      'use (',
      '\t./ai-core',
      '\t./hexagon',
      '\t./hexclaw',
      '\t./toolkit',
      ')',
      '',
    ].join('\n'),
  )
  const outputRoot = join(workRoot, 'identity-output')
  await mkdir(outputRoot)
  return { workRoot, roots, outputRoot }
}

async function adapterFor(fixture) {
  const module = await loadIdentity()
  return module.createPackageSourceIdentityTestAdapter({
    desktopRoot: fixture.roots['hexclaw-desktop'],
    collectToolchains: async (requestedTarget) => fixtureToolchains(requestedTarget),
  })
}

function repository(manifest, id) {
  const value = manifest.repositories.find((item) => item.id === id)
  assert.ok(value, `missing repository ${id}`)
  return value
}

test('exports the fixed-layout production API and the explicit fixture adapter', async () => {
  await loadIdentity()
})

test('production layout is derived from the script realpath and resolves the canonical sibling topology', async () => {
  const module = await loadIdentity()
  const layout = await module.resolveProductionSourceLayout()
  const scriptPath = await realpath(fileURLToPath(identityModuleURL))
  const desktopRoot = await realpath(resolve(dirname(scriptPath), '..', '..'))
  const workRoot = await realpath(dirname(desktopRoot))

  assert.equal(layout.desktopRoot, desktopRoot)
  assert.equal(layout.workRoot, workRoot)
  assert.equal(Object.hasOwn(layout, 'goWork'), false)
  assert.equal(Object.hasOwn(layout, 'goWorkSum'), false)
  assert.deepEqual(
    layout.repositories.map(({ id, root }) => [id, root]),
    await Promise.all(repositoryIDs.map(async (id) => [id, await realpath(join(workRoot, id))])),
  )

  const source = await readFile(identityModuleURL, 'utf8')
  assert.equal(source.includes(['/Users', 'guoyanjun'].join('/')), false)
})

test('manifest destination rejects non-generation staging children before creating them', async (t) => {
  const fixture = await createFixture('publication-staging-destination')
  t.after(() => rm(fixture.workRoot, { recursive: true, force: true }))
  const adapter = await adapterFor(fixture)
  const desktopRoot = await realpath(fixture.roots['hexclaw-desktop'])
  const stagingRoot = join(
    desktopRoot,
    'src-tauri',
    'target',
    'release',
    'bundle',
    'dmg',
    '.package-local.generations',
  )

  for (const name of ['source-diagnostic-20260822', '.tmp-source-manifest-1234']) {
    await t.test(name, async () => {
      const childRoot = join(stagingRoot, name)
      await assert.rejects(
        adapter.create({
          manifestPath: join(childRoot, 'source-manifest.json'),
          target,
        }),
        /\[input:manifest-path\]/u,
      )
      await assert.rejects(stat(childRoot), { code: 'ENOENT' })
    })
  }

  const generationRoot = join(stagingRoot, 'a'.repeat(32))
  const manifestPath = join(generationRoot, 'release', 'source-manifest.json')
  const created = await adapter.create({ manifestPath, target })
  assert.match(created.sha256, /^[a-f0-9]{64}$/u)
  assert.equal((await stat(manifestPath)).isFile(), true)
})

test('canonical manifest covers dirty tracked and relevant untracked source inputs but excludes outputs', async (t) => {
  const fixture = await createFixture('coverage')
  t.after(() => rm(fixture.workRoot, { recursive: true, force: true }))
  const root = fixture.roots.toolkit
  const trackedSources = {
    'tracked.go': 'package toolkit\n\nconst Dirty = "before"\n',
    'go.sum': 'example.invalid/module v1.0.0 h1:fixture\n',
    'frontend/app.ts': 'export const app = true\n',
    'frontend/App.vue': '<template><main>fixture</main></template>\n',
    'rust/src/lib.rs': 'pub fn fixture() {}\n',
    'Cargo.toml': '[package]\nname = "fixture"\nversion = "0.0.0"\n',
    'Cargo.lock': 'version = 4\n',
    Makefile: 'build:\n\t@true\n',
    'scripts/build.sh': '#!/bin/sh\nset -eu\n',
    'package.json': '{"name":"fixture","private":true}\n',
    'pnpm-lock.yaml': 'lockfileVersion: 9\n',
    'config/tauri.json': '{"build":{}}\n',
    'internal/target/rules.go': 'package target\n',
    'src/dist/config.ts': 'export const distribution = true\n',
    '.github/workflows/ci.yml': 'name: ci\n',
    '.env.example': 'VITE_PUBLIC_ENDPOINT=http://127.0.0.1\n',
    'deleted.go': 'package toolkit\n',
    '.gitignore': '.cache/\nignored-source/\n',
  }
  for (const [path, content] of Object.entries(trackedSources)) await write(root, path, content)
  await git(root, 'add', ...Object.keys(trackedSources))
  await write(root, 'tracked.go', 'package toolkit\n\nconst Dirty = "after"\n')
  await unlink(join(root, 'deleted.go'))
  await write(root, 'internal/new_untracked.go', 'package internal\n')
  await write(root, 'ignored-source/ignored.go', 'package ignored\n')
  const toolkitGoMod = await readFile(join(root, 'go.mod'), 'utf8')
  await writeFile(
    join(root, 'go.mod'),
    `${toolkitGoMod}\nreplace example.com/old => example.com/new v1.2.3\n`,
  )

  const excluded = {
    'dist/bundle.js': 'compiled\n',
    'node_modules/dependency/index.js': 'dependency\n',
    'target/release/tool': 'compiled\n',
    'src-tauri/target/release/app': 'compiled\n',
    'coverage/data.json': '{}\n',
    'test-results/report.json': '{}\n',
  }
  for (const [path, content] of Object.entries(excluded)) await write(root, path, content)
  await git(root, 'add', '--force', ...Object.keys(excluded))
  await write(root, 'multi', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01]), 0o755)

  const adapter = await adapterFor(fixture)
  const manifestPath = join(fixture.outputRoot, 'source-manifest.json')
  const result = await adapter.create({ manifestPath, target })
  const bytes = await readFile(manifestPath)
  const manifest = JSON.parse(bytes)
  const toolkit = repository(manifest, 'toolkit')
  const files = new Map(toolkit.files.map((file) => [file.path, file]))

  for (const path of [
    'tracked.go',
    'go.mod',
    'go.sum',
    'frontend/app.ts',
    'frontend/App.vue',
    'rust/src/lib.rs',
    'Cargo.toml',
    'Cargo.lock',
    'Makefile',
    'scripts/build.sh',
    'package.json',
    'pnpm-lock.yaml',
    'config/tauri.json',
    'internal/target/rules.go',
    'src/dist/config.ts',
    '.github/workflows/ci.yml',
    '.env.example',
    'internal/new_untracked.go',
    'ignored-source/ignored.go',
  ]) {
    assert.ok(files.has(path), `missing source input ${path}`)
  }
  for (const path of Object.keys(excluded)) assert.equal(files.has(path), false)
  assert.equal(files.has('multi'), true)
  assert.deepEqual(toolkit.deletedTracked, ['deleted.go'])
  assert.equal(files.get('tracked.go').sourceKind, 'tracked')
  assert.equal(files.get('internal/new_untracked.go').sourceKind, 'untracked')
  assert.equal(files.get('ignored-source/ignored.go').sourceKind, 'ignored-untracked')
  assert.equal(files.get('multi').sourceKind, 'untracked')
  for (const file of files.values()) {
    assert.match(file.sha256, /^[a-f0-9]{64}$/u)
    assert.match(file.mode, /^100[0-7]{3}$/u)
    assert.equal(Number.isSafeInteger(file.size), true)
  }
  assert.equal(bytes.at(-1), 0x0a)
  assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'))
  assert.equal(JSON.stringify(manifest).includes(fixture.workRoot), false)
  assert.deepEqual(
    manifest.workspace.modules.map(({ module, repository: id }) => [module, id]),
    [...moduleByRepository.entries()].map(([id, module]) => [module, id]).sort(),
  )
  const expectedWorkspace = Buffer.from(
    'go 1.25.7\n\nuse (\n\t./toolkit\n\t./ai-core\n\t./hexagon\n\t./hexclaw\n)\n',
  )
  assert.equal(manifest.workspace.goVersion, '1.25.7')
  assert.deepEqual(manifest.workspace.file, {
    mode: '100600',
    path: 'go.work',
    sha256: createHash('sha256').update(expectedWorkspace).digest('hex'),
    size: expectedWorkspace.length,
  })
  assert.equal(manifest.target, target)
  assert.equal(manifest.toolchains.target, target)
  const listedFiles = manifest.repositories.flatMap((item) => item.files)
  assert.equal(manifest.totals.files, listedFiles.length + 1)
  assert.equal(
    manifest.totals.bytes,
    listedFiles.reduce((total, file) => total + file.size, manifest.workspace.file.size),
  )
  assert.equal(manifest.totals.entries, manifest.totals.files + manifest.totals.deletedTracked)
})

test('existing sensitive build inputs fail closed before content hashing', async (t) => {
  const cases = [
    { classification: 'tracked', path: '.env' },
    { classification: 'untracked', path: '.env.local' },
    { classification: 'ignored', path: 'config/.env.production' },
    { classification: 'tracked', path: 'deploy/.env.dev.example' },
    { classification: 'untracked', path: '.envrc' },
    { classification: 'tracked', path: 'nested/.netrc' },
    { classification: 'ignored', path: 'frontend/.npmrc' },
    { classification: 'untracked', path: 'python/.pypirc' },
  ]

  for (const fixtureCase of cases) {
    await t.test(`${fixtureCase.classification}:${fixtureCase.path}`, async (caseTest) => {
      const fixture = await createFixture(
        `sensitive-${fixtureCase.classification}-${fixtureCase.path.replaceAll('/', '-')}`,
      )
      caseTest.after(() => rm(fixture.workRoot, { recursive: true, force: true }))
      const marker = `synthetic-sensitive-${fixtureCase.classification}`
      if (fixtureCase.classification === 'ignored') {
        await write(fixture.roots.toolkit, '.gitignore', `${fixtureCase.path}\n`)
        await git(fixture.roots.toolkit, 'add', '.gitignore')
      }
      await write(fixture.roots.toolkit, fixtureCase.path, `${marker}\n`)
      if (fixtureCase.classification === 'tracked') {
        await git(fixture.roots.toolkit, 'add', '--force', fixtureCase.path)
      }
      const adapter = await adapterFor(fixture)

      await assert.rejects(
        adapter.create({
          manifestPath: join(fixture.outputRoot, 'manifest.json'),
          target,
        }),
        (error) => {
          assert.match(error.message, /\[source:sensitive-file\]/u)
          assert.equal(error.message.includes(marker), false)
          assert.equal(error.message.includes(fixture.workRoot), false)
          return true
        },
      )
    })
  }
})

test('untracked and ignored .codex-prefixed paths are excluded before content reads', async (t) => {
  for (const classification of ['untracked', 'ignored']) {
    await t.test(classification, async (caseTest) => {
      const fixture = await createFixture(`codex-excluded-${classification}`)
      caseTest.after(() => rm(fixture.workRoot, { recursive: true, force: true }))
      const relativePath = 'nested/.CoDeX-private/opaque.bin'
      if (classification === 'ignored') {
        await write(fixture.roots.toolkit, '.gitignore', 'nested/.CoDeX-private/\n')
        await git(fixture.roots.toolkit, 'add', '.gitignore')
      }
      const privatePath = await write(
        fixture.roots.toolkit,
        relativePath,
        'synthetic opaque bytes\n',
        0o000,
      )
      const adapter = await adapterFor(fixture)
      const manifestPath = join(fixture.outputRoot, 'manifest.json')

      const created = await adapter.create({ manifestPath, target })
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      assert.equal(JSON.stringify(manifest).toLowerCase().includes('.codex'), false)
      await chmod(privatePath, 0o600)
      await writeFile(privatePath, 'changed host-only bytes\n', { mode: 0o000 })
      await adapter.verify({ expectedSha256: created.sha256, manifestPath, target })
    })
  }
})

test('tracked .codex-prefixed paths fail before source content reads', async (t) => {
  const fixture = await createFixture('codex-tracked')
  t.after(() => rm(fixture.workRoot, { recursive: true, force: true }))
  const privatePath = await write(
    fixture.roots.toolkit,
    'nested/.CoDeX-private/opaque.bin',
    'synthetic opaque bytes\n',
  )
  await git(fixture.roots.toolkit, 'add', 'nested/.CoDeX-private/opaque.bin')
  await chmod(privatePath, 0o000)
  const adapter = await adapterFor(fixture)

  await assert.rejects(
    adapter.create({ manifestPath: join(fixture.outputRoot, 'manifest.json'), target }),
    (error) => {
      assert.match(error.message, /\[source:codex-path\]/u)
      assert.equal(error.message.includes(privatePath), false)
      return true
    },
  )
})

test('ignored sensitive names inside excluded build outputs do not poison the next source snapshot', async (t) => {
  const fixture = await createFixture('excluded-sensitive-output')
  t.after(() => rm(fixture.workRoot, { recursive: true, force: true }))
  const desktopRoot = fixture.roots['hexclaw-desktop']
  await write(desktopRoot, '.gitignore', 'src-tauri/target/\n')
  await git(desktopRoot, 'add', '.gitignore')
  await write(
    desktopRoot,
    'src-tauri/target/release/private-cache/deploy/.env.dev.example',
    'SYNTHETIC=fixture\n',
  )
  const adapter = await adapterFor(fixture)
  const manifestPath = join(fixture.outputRoot, 'manifest.json')

  await adapter.create({ manifestPath, target })
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const desktop = repository(manifest, 'hexclaw-desktop')

  assert.equal(
    desktop.files.some((file) => file.path.startsWith('src-tauri/target/')),
    false,
  )
})

test('a deleted tracked sensitive path remains frozen without re-reading the host after capture', async (t) => {
  const fixture = await createFixture('deleted-sensitive')
  t.after(() => rm(fixture.workRoot, { recursive: true, force: true }))
  await write(fixture.roots['hexclaw-desktop'], '.env', 'SECRET=synthetic\n')
  await git(fixture.roots['hexclaw-desktop'], 'add', '--force', '.env')
  await unlink(join(fixture.roots['hexclaw-desktop'], '.env'))
  const adapter = await adapterFor(fixture)
  const manifestPath = join(fixture.outputRoot, 'manifest.json')
  const created = await adapter.create({ manifestPath, target })
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const desktop = repository(manifest, 'hexclaw-desktop')

  assert.ok(desktop.deletedTracked.includes('.env'))
  assert.equal(
    desktop.files.some((file) => file.path === '.env'),
    false,
  )
  await write(fixture.roots['hexclaw-desktop'], '.env', 'SECRET=appeared\n')
  const verified = await adapter.verify({ manifestPath, expectedSha256: created.sha256, target })
  assert.equal(verified.sha256, created.sha256)
})

test('frozen verification ignores later host-source drift', async (t) => {
  const fixture = await createFixture('drift')
  t.after(() => rm(fixture.workRoot, { recursive: true, force: true }))
  await write(fixture.roots.hexclaw, 'current.go', 'package hexclaw\n')
  await git(fixture.roots.hexclaw, 'add', 'current.go')
  const adapter = await adapterFor(fixture)
  const manifestPath = join(fixture.outputRoot, 'source-manifest.json')
  const created = await adapter.create({ manifestPath, target })

  const verified = await adapter.verify({
    manifestPath,
    expectedSha256: created.sha256,
    target,
  })
  assert.equal(verified.sha256, created.sha256)

  await write(fixture.roots.hexclaw, 'current.go', 'package hexclaw\n\nconst Drift = true\n')
  const verifiedAfterDrift = await adapter.verify({
    manifestPath,
    expectedSha256: created.sha256,
    target,
  })
  assert.equal(verifiedAfterDrift.sha256, created.sha256)
})

test('frozen manifest verification never recaptures source, Git or toolchains', async (t) => {
  const fixture = await createFixture('frozen-verification-call-graph')
  t.after(() => rm(fixture.workRoot, { recursive: true, force: true }))
  const sourcePath = await write(
    fixture.roots.hexclaw,
    'frozen.go',
    'package hexclaw\n\nconst Frozen = "before"\n',
  )
  await git(fixture.roots.hexclaw, 'add', 'frozen.go')
  let captureCalls = 0
  let gitCalls = 0
  let toolchainCalls = 0
  const module = await loadIdentity()
  const adapter = module.createPackageSourceIdentityTestAdapter({
    desktopRoot: fixture.roots['hexclaw-desktop'],
    onCapture: () => {
      captureCalls += 1
    },
    onGitCommand: () => {
      gitCalls += 1
    },
    collectToolchains: async (requestedTarget) => {
      toolchainCalls += 1
      return fixtureToolchains(requestedTarget)
    },
  })
  const manifestPath = join(fixture.outputRoot, 'source-manifest.json')
  const created = await adapter.create({ manifestPath, target })
  const callsAfterFreeze = { captureCalls, gitCalls, toolchainCalls }

  await writeFile(sourcePath, 'package hexclaw\n\nconst Frozen = "after"\n')
  await git(fixture.roots.hexclaw, 'tag', 'post-freeze-tag')
  const verified = await adapter.verify({
    expectedSha256: created.sha256,
    manifestPath,
    target,
  })

  assert.equal(verified.sha256, created.sha256)
  assert.deepEqual({ captureCalls, gitCalls, toolchainCalls }, callsAfterFreeze)
  assert.equal(captureCalls, 1)
  assert.ok(gitCalls > 0)
  assert.equal(toolchainCalls, 1)
})

test('ignored untracked source is frozen and later host drift is not recaptured', async (t) => {
  const fixture = await createFixture('ignored-drift')
  t.after(() => rm(fixture.workRoot, { recursive: true, force: true }))
  await write(fixture.roots.hexclaw, '.gitignore', 'ignored.go\n')
  await git(fixture.roots.hexclaw, 'add', '.gitignore')
  const ignoredPath = await write(
    fixture.roots.hexclaw,
    'ignored.go',
    'package hexclaw\n\nconst Ignored = "before"\n',
  )
  const adapter = await adapterFor(fixture)
  const manifestPath = join(fixture.outputRoot, 'source-manifest.json')
  const created = await adapter.create({ manifestPath, target })
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const ignored = repository(manifest, 'hexclaw').files.find((file) => file.path === 'ignored.go')
  assert.equal(ignored?.sourceKind, 'ignored-untracked')

  await writeFile(ignoredPath, 'package hexclaw\n\nconst Ignored = "after"\n')
  const verified = await adapter.verify({ manifestPath, expectedSha256: created.sha256, target })
  assert.equal(verified.sha256, created.sha256)
})

test('one snapshot rechecks early repositories after concurrent toolchain collection completes', async (t) => {
  const fixture = await createFixture('capture-tail-drift')
  t.after(() => rm(fixture.workRoot, { recursive: true, force: true }))
  const sourcePath = await write(
    fixture.roots.toolkit,
    'capture-tail.go',
    'package toolkit\n\nconst CaptureTail = "before"\n',
  )
  await git(fixture.roots.toolkit, 'add', 'capture-tail.go')
  let markToolkitScanned
  const toolkitScanned = new Promise((resolveScanned) => {
    markToolkitScanned = resolveScanned
  })
  const module = await loadIdentity()
  const adapter = module.createPackageSourceIdentityTestAdapter({
    afterInitialRepositoryScan: async (repositoryID) => {
      if (repositoryID === 'toolkit') markToolkitScanned()
    },
    desktopRoot: fixture.roots['hexclaw-desktop'],
    collectToolchains: async (requestedTarget) => {
      await toolkitScanned
      await writeFile(sourcePath, 'package toolkit\n\nconst CaptureTail = "after"\n')
      return fixtureToolchains(requestedTarget)
    },
  })

  await assert.rejects(
    adapter.create({
      manifestPath: join(fixture.outputRoot, 'manifest.json'),
      target,
    }),
    /\[drift:(?:file-identity|file-list)\]/u,
  )
})

test('manifest freezes VCS metadata without querying later tag drift', async (t) => {
  const fixture = await createFixture('vcs-drift')
  t.after(() => rm(fixture.workRoot, { recursive: true, force: true }))
  const hexagonRoot = fixture.roots.hexagon
  await git(hexagonRoot, 'tag', 'v1.2.3')
  const manifestPath = join(fixture.outputRoot, 'manifest.json')
  const adapter = await adapterFor(fixture)
  const created = await adapter.create({ manifestPath, target })
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const hexagon = repository(manifest, 'hexagon')

  assert.match(hexagon.vcs.head, /^[a-f0-9]{40,64}$/u)
  assert.match(hexagon.vcs.commitDate, /^\d{4}-\d{2}-\d{2}T/u)
  assert.equal(hexagon.vcs.describe, 'v1.2.3')
  assert.deepEqual(hexagon.vcs.tags, ['v1.2.3'])

  await git(hexagonRoot, 'tag', 'v1.2.4')
  const verified = await adapter.verify({ manifestPath, expectedSha256: created.sha256, target })
  assert.equal(verified.sha256, created.sha256)
})

test('global go.work and go.work.sum never influence the dedicated manifest workspace', async (t) => {
  const fixture = await createFixture('workspace-isolation')
  t.after(() => rm(fixture.workRoot, { recursive: true, force: true }))
  await writeFile(
    join(fixture.workRoot, 'go.work'),
    'go 1.26.0\n\nuse (\n\t./yc-server\n)\n\nreplace example.com/external => ./outside\n',
  )
  await writeFile(join(fixture.workRoot, 'go.work.sum'), 'synthetic global sum\n', { mode: 0o000 })
  const adapter = await adapterFor(fixture)
  const manifestPath = join(fixture.outputRoot, 'manifest.json')
  const created = await adapter.create({ manifestPath, target })
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))

  assert.equal(manifest.workspace.goVersion, '1.25.7')
  assert.equal(JSON.stringify(manifest).includes('yc-server'), false)
  assert.equal(JSON.stringify(manifest).includes('go.work.sum'), false)

  await writeFile(join(fixture.workRoot, 'go.work'), 'not a workspace\n', { mode: 0o000 })
  await unlink(join(fixture.workRoot, 'go.work.sum'))
  await adapter.verify({ expectedSha256: created.sha256, manifestPath, target })
})

test('go.mod rejects local filesystem replacements outside canonical repositories', async (t) => {
  const fixture = await createFixture('external-replace-go-mod')
  t.after(() => rm(fixture.workRoot, { recursive: true, force: true }))
  const outside = join(fixture.workRoot, 'external-module')
  await write(outside, 'go.mod', 'module example.com/external\n\ngo 1.25.7\n')
  const goMod = await readFile(join(fixture.roots.toolkit, 'go.mod'), 'utf8')
  await writeFile(
    join(fixture.roots.toolkit, 'go.mod'),
    `${goMod}\nreplace example.com/external => ../external-module\n`,
  )
  const adapter = await adapterFor(fixture)

  await assert.rejects(
    adapter.create({ manifestPath: join(fixture.outputRoot, 'manifest.json'), target }),
    (error) => {
      assert.match(error.message, /\[workspace:replace\]/u)
      assert.equal(error.message.includes(fixture.workRoot), false)
      return true
    },
  )
})

test('symbolic links and hard links fail without disclosing source paths', async (t) => {
  const symlinkFixture = await createFixture('symlink')
  const hardlinkFixture = await createFixture('hardlink')
  t.after(() =>
    Promise.all(
      [symlinkFixture, hardlinkFixture].map((fixture) =>
        rm(fixture.workRoot, { recursive: true, force: true }),
      ),
    ),
  )
  const marker = 'synthetic-private-source-marker'
  await symlink(`../../${marker}`, join(symlinkFixture.roots.toolkit, 'linked.go'))
  await git(symlinkFixture.roots.toolkit, 'add', 'linked.go')
  const symlinkAdapter = await adapterFor(symlinkFixture)
  await assert.rejects(
    symlinkAdapter.create({
      manifestPath: join(symlinkFixture.outputRoot, 'manifest.json'),
      target,
    }),
    (error) => {
      assert.match(error.message, /\[file:symbolic-link\]/u)
      assert.equal(error.message.includes(marker), false)
      assert.equal(error.message.includes(symlinkFixture.workRoot), false)
      return true
    },
  )

  const original = await write(hardlinkFixture.roots.toolkit, 'original.go', 'package toolkit\n')
  await link(original, join(hardlinkFixture.roots.toolkit, 'linked.go'))
  await git(hardlinkFixture.roots.toolkit, 'add', 'original.go', 'linked.go')
  const hardlinkAdapter = await adapterFor(hardlinkFixture)
  await assert.rejects(
    hardlinkAdapter.create({
      manifestPath: join(hardlinkFixture.outputRoot, 'manifest.json'),
      target,
    }),
    /\[file:hard-link\]/u,
  )
})

test('a tracked directory replaced by an escaping symbolic link fails closed', async (t) => {
  const fixture = await createFixture('ancestor-symlink')
  t.after(() => rm(fixture.workRoot, { recursive: true, force: true }))
  const trackedDirectory = join(fixture.roots.toolkit, 'nested')
  await write(trackedDirectory, 'source.go', 'package nested\n')
  await git(fixture.roots.toolkit, 'add', 'nested/source.go')

  const marker = 'synthetic-ancestor-target'
  const outsideDirectory = join(fixture.workRoot, marker)
  await write(outsideDirectory, 'source.go', `package escaped\n${'x'.repeat(2048)}\n`)
  await rm(trackedDirectory, { recursive: true, force: true })
  await symlink(outsideDirectory, trackedDirectory, 'dir')
  const adapter = await adapterFor(fixture)

  await assert.rejects(
    adapter.create({
      limits: {
        maxFiles: 100,
        maxFileBytes: 1024,
        maxTotalBytes: 1024 * 1024,
      },
      manifestPath: join(fixture.outputRoot, 'manifest.json'),
      target,
    }),
    (error) => {
      assert.match(error.message, /\[file:symbolic-link\]/u)
      assert.equal(error.message.includes(marker), false)
      assert.equal(error.message.includes(fixture.workRoot), false)
      return true
    },
  )
})

test('source files and source ancestors reject group or other writes', async (t) => {
  const cases = [
    {
      name: 'source-file',
      prepare: async (fixture) => {
        const path = await write(fixture.roots.toolkit, 'unsafe.go', 'package toolkit\n')
        await git(fixture.roots.toolkit, 'add', 'unsafe.go')
        await chmod(path, 0o666)
      },
    },
    {
      name: 'source-ancestor',
      prepare: async (fixture) => {
        await write(fixture.roots.toolkit, 'unsafe/source.go', 'package unsafe\n')
        await git(fixture.roots.toolkit, 'add', 'unsafe/source.go')
        await chmod(join(fixture.roots.toolkit, 'unsafe'), 0o777)
      },
    },
  ]

  for (const fixtureCase of cases) {
    await t.test(fixtureCase.name, async (caseTest) => {
      const fixture = await createFixture(`permissions-${fixtureCase.name}`)
      caseTest.after(() => rm(fixture.workRoot, { recursive: true, force: true }))
      await fixtureCase.prepare(fixture)
      const adapter = await adapterFor(fixture)

      await assert.rejects(
        adapter.create({
          manifestPath: join(fixture.outputRoot, 'manifest.json'),
          target,
        }),
        (error) => {
          assert.match(error.message, /\[file:permissions\]/u)
          assert.equal(error.message.includes(fixture.workRoot), false)
          return true
        },
      )
    })
  }
})

test('source ownership is bound to the current uid', async (t) => {
  const fixture = await createFixture('source-owner')
  t.after(() => rm(fixture.workRoot, { recursive: true, force: true }))
  const sourcePath = await write(fixture.roots.toolkit, 'owned.go', 'package toolkit\n')
  const canonicalRoot = await realpath(fixture.roots.toolkit)
  const canonicalSource = await realpath(sourcePath)
  const module = await import(identityModuleURL)
  assert.equal(typeof module.validateSourcePathForTest, 'function')

  await module.validateSourcePathForTest({
    expectedUid: process.getuid(),
    path: canonicalSource,
    root: canonicalRoot,
  })
  await assert.rejects(
    module.validateSourcePathForTest({
      expectedUid: process.getuid() + 1,
      path: canonicalSource,
      root: canonicalRoot,
    }),
    /\[file:owner\]/u,
  )
})

test('fixture adapter enforces shared file and byte limits', async (t) => {
  const fixture = await createFixture('limits')
  t.after(() => rm(fixture.workRoot, { recursive: true, force: true }))
  const adapter = await adapterFor(fixture)

  await assert.rejects(
    adapter.create({
      manifestPath: join(fixture.outputRoot, 'manifest.json'),
      target,
      limits: { maxFiles: 2, maxFileBytes: 1024, maxTotalBytes: 2048 },
    }),
    /\[limit:file-count\]/u,
  )
})

test('deleted tracked paths consume the entry limit and are explicit in totals', async (t) => {
  const fixture = await createFixture('deleted-budget')
  t.after(() => rm(fixture.workRoot, { recursive: true, force: true }))
  await write(fixture.roots.toolkit, 'deleted.go', 'package toolkit\n')
  await git(fixture.roots.toolkit, 'add', 'deleted.go')
  await unlink(join(fixture.roots.toolkit, 'deleted.go'))
  const adapter = await adapterFor(fixture)
  const commonLimits = { maxFileBytes: 1024 * 1024, maxTotalBytes: 8 * 1024 * 1024 }

  await assert.rejects(
    adapter.create({
      limits: { ...commonLimits, maxFiles: 6 },
      manifestPath: join(fixture.outputRoot, 'too-small.json'),
      target,
    }),
    /\[limit:file-count\]/u,
  )

  const manifestPath = join(fixture.outputRoot, 'exact.json')
  await adapter.create({
    limits: { ...commonLimits, maxFiles: 7 },
    manifestPath,
    target,
  })
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  assert.deepEqual(manifest.totals, {
    bytes:
      manifest.workspace.file.size +
      manifest.repositories
        .flatMap((item) => item.files)
        .reduce((total, file) => total + file.size, 0),
    deletedTracked: 1,
    entries: 7,
    files: 6,
  })
})

test('target must be a canonical native macOS target', async (t) => {
  const invalidFixture = await createFixture('invalid-target')
  const mismatchFixture = await createFixture('mismatched-target')
  t.after(() =>
    Promise.all(
      [invalidFixture, mismatchFixture].map((fixture) =>
        rm(fixture.workRoot, { recursive: true, force: true }),
      ),
    ),
  )

  const invalidAdapter = await adapterFor(invalidFixture)
  await assert.rejects(
    invalidAdapter.create({
      manifestPath: join(invalidFixture.outputRoot, 'invalid.json'),
      target: 'banana',
    }),
    /\[input:target\]/u,
  )

  const module = await loadIdentity()
  const mismatchAdapter = module.createPackageSourceIdentityTestAdapter({
    desktopRoot: mismatchFixture.roots['hexclaw-desktop'],
    collectToolchains: async (requestedTarget) => ({
      ...fixtureToolchains('x86_64-apple-darwin'),
      target: requestedTarget,
    }),
  })
  await assert.rejects(
    mismatchAdapter.create({
      manifestPath: join(mismatchFixture.outputRoot, 'mismatch.json'),
      target: 'aarch64-apple-darwin',
    }),
    /\[toolchain:target\]/u,
  )
})

test('persistent toolchain identity requires exact executable paths, digests, versions, and GOROOT', async (t) => {
  const fixture = await createFixture('toolchain-manifest-contract')
  t.after(() => rm(fixture.workRoot, { recursive: true, force: true }))
  const module = await loadIdentity()
  const adapter = module.createPackageSourceIdentityTestAdapter({
    desktopRoot: fixture.roots['hexclaw-desktop'],
    collectToolchains: async (requestedTarget) => {
      const toolchains = fixtureToolchains(requestedTarget)
      return {
        ...toolchains,
        cargo: {
          executableSha256: toolchains.cargo.executableSha256,
          sourceSha256: toolchains.cargo.sourceSha256,
          version: toolchains.cargo.version,
        },
      }
    },
  })

  await assert.rejects(
    adapter.create({
      manifestPath: join(fixture.outputRoot, 'manifest.json'),
      target,
    }),
    /\[toolchain:manifest\]/u,
  )
})

test('production source identity has an explicit macOS and uid contract', async () => {
  const module = await loadIdentity()
  assert.equal(module.validateProductionPlatformForTest({ hasUid: true, platform: 'darwin' }), true)
  assert.throws(
    () => module.validateProductionPlatformForTest({ hasUid: true, platform: 'linux' }),
    /\[platform:unsupported\]/u,
  )
  assert.throws(
    () => module.validateProductionPlatformForTest({ hasUid: false, platform: 'darwin' }),
    /\[platform:unsupported\]/u,
  )
})

test('source identity reuses the bounded runner for timeout, output, and process-tree enforcement', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hexclaw-source-runner-'))
  const childPIDPath = join(root, 'child.pid')
  t.after(() => rm(root, { recursive: true, force: true }))
  const { runBoundedProcess } = await import(boundedProcessModuleURL)
  const base = {
    cwd: root,
    env: {},
    maxOutputBytes: 1024,
    terminateConfirmMs: 1_000,
    terminateGraceMs: 100,
    timeoutMs: 2_000,
  }

  await assert.rejects(
    runBoundedProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      ...base,
      timeoutMs: 100,
    }),
    /category=timeout/u,
  )
  await assert.rejects(
    runBoundedProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(4096))'], {
      ...base,
      maxOutputBytes: 32,
    }),
    /category=output-limit/u,
  )

  const processTreeProgram = [
    "const {spawn}=require('node:child_process')",
    "const {writeFileSync}=require('node:fs')",
    "const child=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});process.send('ready');process.disconnect();setInterval(()=>{},1000)\"],{stdio:['ignore','ignore','ignore','ipc']})",
    `child.once('message',()=>{writeFileSync(${JSON.stringify(childPIDPath)},String(child.pid));child.disconnect();child.unref();process.exit(0)})`,
  ].join(';')
  await assert.rejects(
    runBoundedProcess(process.execPath, ['-e', processTreeProgram], base),
    /category=process-tree-leak/u,
  )
  const childPID = Number(await readFile(childPIDPath, 'utf8'))
  assert.throws(() => process.kill(childPID, 0), { code: 'ESRCH' })

  const source = await readFile(identityModuleURL, 'utf8')
  assert.equal(source.includes("from './run-bounded-process.mjs'"), true)
  assert.equal(source.includes("from 'node:child_process'"), false)
})

test('toolchain capture executes private snapshots with a clean environment and returns frozen bindings', async (t) => {
  const fixture = await createFixture('toolchain-snapshot')
  t.after(() => rm(fixture.workRoot, { recursive: true, force: true }))
  const environmentLog = join(fixture.workRoot, 'tool-environment.log')
  const toolchainOptions = await createFakeToolchain(join(fixture.workRoot, 'tools'), {
    environmentLog,
    target,
  })
  const module = await loadIdentity()
  const adapter = module.createPackageSourceIdentityTestAdapter({
    desktopRoot: fixture.roots['hexclaw-desktop'],
    toolchainOptions,
  })
  const injected = {
    DYLD_INSERT_LIBRARIES: '/synthetic/dyld-injection.dylib',
    HOME: '/synthetic/host-home',
    LD_PRELOAD: '/synthetic/ld-preload.so',
    PATH: '/synthetic/host-path',
    SOURCE_IDENTITY_SECRET_MARKER: 'synthetic-secret-marker',
    TMPDIR: '/synthetic/host-tmp',
  }
  const previous = Object.fromEntries(
    Object.keys(injected).map((name) => [name, process.env[name]]),
  )
  Object.assign(process.env, injected)
  const manifestPath = join(fixture.outputRoot, 'manifest.json')
  let result
  try {
    result = await adapter.create({ manifestPath, target })
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }

  const manifestBytes = await readFile(manifestPath)
  const manifest = JSON.parse(manifestBytes)
  const bindings = result.toolchains
  assert.equal(Object.isFrozen(result), true)
  assert.equal(Object.isFrozen(bindings), true)
  assert.equal(Object.isFrozen(bindings.git), true)
  assert.equal((await stat(bindings.snapshotRoot)).mode & 0o777, 0o700)
  assert.equal(bindings.git.canonical, bindings.git.invocation)
  assert.ok(bindings.git.canonical.startsWith(`${bindings.snapshotRoot}/`))
  assert.equal((await stat(bindings.git.canonical)).mode & 0o777, 0o500)
  assert.equal(
    createHash('sha256')
      .update(await readFile(bindings.git.canonical))
      .digest('hex'),
    bindings.git.executableSha256,
  )
  assert.equal(bindings.git.executableSha256, manifest.toolchains.git.executableSha256)
  assert.equal(manifest.toolchains.git.executablePath, await realpath(toolchainOptions.gitPath))
  for (const name of ['cargo', 'git', 'go', 'node', 'pnpm', 'rustc', 'rustup']) {
    assert.equal(Object.isFrozen(bindings[name]), true)
    assert.equal(bindings[name].sourceCanonical, manifest.toolchains[name].executablePath)
    assert.equal(bindings[name].sourceSha256, manifest.toolchains[name].sourceSha256)
    assert.equal(bindings[name].executableSha256, manifest.toolchains[name].executableSha256)
    assert.match(manifest.toolchains[name].version, /\S/u)
  }
  assert.equal(bindings.go.goroot, await realpath(join(fixture.workRoot, 'tools', 'go-root')))
  assert.equal(manifest.toolchains.go.env.GOROOT, bindings.go.goroot)
  assert.equal(manifestBytes.includes(Buffer.from(bindings.snapshotRoot)), false)
  assert.equal(
    (
      await stat(
        join(bindings.rustToolchain.canonical, `lib/rustlib/${target}/bin/rust-objcopy`),
      )
    ).mode & 0o777,
    0o500,
  )
  assert.equal(
    (
      await stat(
        join(bindings.rustToolchain.canonical, `lib/rustlib/${target}/lib/libstd.rlib`),
      )
    ).mode & 0o777,
    0o400,
  )

  const environment = Object.fromEntries(
    (await readFile(environmentLog, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => {
        const equals = line.indexOf('=')
        return [line.slice(0, equals), line.slice(equals + 1)]
      }),
  )
  for (const name of [
    'DYLD_INSERT_LIBRARIES',
    'HOME',
    'LD_PRELOAD',
    'SOURCE_IDENTITY_SECRET_MARKER',
  ]) {
    assert.equal(Object.hasOwn(environment, name), false)
  }
  assert.equal(environment.PATH, `${bindings.snapshotRoot}:/usr/bin:/bin`)
  assert.ok(environment.TMPDIR.startsWith(`${bindings.snapshotRoot}/`))
})

test('toolchain capture rejects canonical source A to B to A swaps', async (t) => {
  const fixture = await createFixture('toolchain-aba')
  t.after(() => rm(fixture.workRoot, { recursive: true, force: true }))
  const toolRoot = join(fixture.workRoot, 'tools')
  const gitPath = join(toolRoot, 'bin', 'git')
  const replacementPath = join(toolRoot, 'replacement-git')
  const backupPath = join(toolRoot, 'original-git')
  const gitPrelude = [
    `/bin/mv ${shellQuote(gitPath)} ${shellQuote(backupPath)}`,
    `/bin/cp ${shellQuote(replacementPath)} ${shellQuote(gitPath)}`,
    `/bin/chmod 500 ${shellQuote(gitPath)}`,
    `/bin/mv -f ${shellQuote(backupPath)} ${shellQuote(gitPath)}`,
    '',
  ].join('\n')
  const toolchainOptions = await createFakeToolchain(toolRoot, { gitPrelude })
  await write(toolRoot, 'replacement-git', "#!/bin/sh\nprintf '%s\\n' replacement\n", 0o500)
  const module = await loadIdentity()
  const adapter = module.createPackageSourceIdentityTestAdapter({
    desktopRoot: fixture.roots['hexclaw-desktop'],
    toolchainOptions,
  })

  await assert.rejects(
    adapter.create({
      manifestPath: join(fixture.outputRoot, 'manifest.json'),
      target,
    }),
    (error) => {
      assert.match(error.message, /\[toolchain:source-drift\]/u)
      assert.equal(error.message.includes(fixture.workRoot), false)
      return true
    },
  )
})

test('executable resolution returns a canonical object immune to later symlink swaps', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hexclaw-executable-identity-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const first = await write(root, 'tool-first', '#!/bin/sh\nprintf first\n', 0o755)
  const second = await write(root, 'tool-second', '#!/bin/sh\nprintf second\n', 0o755)
  const exposed = join(root, 'fixture-tool')
  await symlink(first, exposed)
  const module = await loadIdentity()
  const canonical = await module.resolveExecutableForTest({
    name: 'fixture-tool',
    path: root,
  })
  assert.equal(canonical, await realpath(first))

  await unlink(exposed)
  await symlink(second, exposed)
  const { stdout } = await execFileAsync(canonical, [], { encoding: 'utf8' })
  assert.equal(stdout, 'first')
})

test('rustup proxy resolution executes canonical rustup and returns its canonical tool', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hexclaw-rustup-identity-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const rustc = await write(root, 'rustc-real', '#!/bin/sh\nprintf rustc\n', 0o755)
  const rustup = await write(
    root,
    'rustup',
    `#!/bin/sh\nif [ "$1" = which ] && [ "$2" = rustc ]; then\n  printf '%s\\n' '${rustc}'\n  exit 0\nfi\nexit 64\n`,
    0o755,
  )
  await symlink(rustup, join(root, 'rustc'))
  const module = await loadIdentity()

  assert.equal(
    await module.resolveRustToolExecutableForTest({ name: 'rustc', path: root }),
    await realpath(rustc),
  )
})

test('production API and CLI reject source-root overrides before scanning', async (t) => {
  const module = await loadIdentity()
  const outputRoot = await mkdtemp(join(tmpdir(), 'hexclaw-source-override-'))
  t.after(() => rm(outputRoot, { recursive: true, force: true }))
  const marker = join(outputRoot, 'private-source-root')

  await assert.rejects(
    module.createPackageSourceManifest({
      manifestPath: join(outputRoot, 'manifest.json'),
      target,
      desktopRoot: marker,
    }),
    /\[input:unknown-option\]/u,
  )

  const previous = process.env.MAKEFLAGS
  process.env.MAKEFLAGS = `-- HEXCLAW_LOCAL_SRC=${marker}`
  try {
    await assert.rejects(
      module.createPackageSourceManifest({
        manifestPath: join(outputRoot, 'makeflags.json'),
        target,
      }),
      (error) => {
        assert.match(error.message, /\[input:source-override\]/u)
        assert.equal(error.message.includes(marker), false)
        return true
      },
    )
  } finally {
    if (previous === undefined) delete process.env.MAKEFLAGS
    else process.env.MAKEFLAGS = previous
  }

  await assert.rejects(
    execFileAsync(process.execPath, [
      fileURLToPath(identityModuleURL),
      'create',
      '--manifest',
      join(outputRoot, 'cli.json'),
      '--target',
      target,
      '--desktop-root',
      marker,
    ]),
    (error) => {
      assert.match(error.stderr, /\[input:unknown-option\]/u)
      assert.equal(error.stderr.includes(marker), false)
      return true
    },
  )
})

test('source hashing uses no-follow streaming reads with pre and post descriptor identity checks', async () => {
  const source = await readFile(identityModuleURL, 'utf8')
  assert.match(source, /const PRODUCTION_GIT_EXECUTABLE = '\/usr\/bin\/git'/u)
  assert.match(source, /GIT_CONFIG_NOSYSTEM:\s*'1'/u)
  assert.match(source, /GIT_CONFIG_GLOBAL:/u)
  assert.match(source, /GIT_CONFIG_COUNT:\s*'0'/u)
  assert.match(source, /GIT_EXCLUDED_PATHS/u)
  assert.match(source, /:\(exclude,glob\)\*\*\/node_modules\/\*\*/u)
  assert.match(source, /O_NOFOLLOW/u)
  assert.match(source, /Buffer\.allocUnsafe/u)
  assert.match(source, /handle\.read\(/u)
  assert.ok((source.match(/handle\.stat\(\{\s*bigint:\s*true\s*\}\)/gu) ?? []).length >= 2)
  assert.match(source, /sameFileIdentity/u)
  assert.match(source, /directoryHandle\.sync\(\)/u)
})
