import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

const moduleURL = new URL('../../scripts/ci/package-dependency-provenance.mjs', import.meta.url)
const execFileAsync = promisify(execFile)

test('exports one prepare and verify API for package dependency provenance', async () => {
  const module = await import(moduleURL)

  assert.equal(typeof module.preparePackageDependencyProvenance, 'function')
  assert.equal(typeof module.verifyPackageDependencyProvenance, 'function')
})

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

async function writeExecutable(path, content) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, content, { mode: 0o700 })
  await chmod(path, 0o700)
  return sha256(await readFile(path))
}

function fakePnpmSource(extra = '') {
  return [
    "'use strict'",
    "const fs = require('node:fs')",
    "const path = require('node:path')",
    "if (process.argv[2] === '--version') { process.stdout.write('10.30.3\\n'); process.exit(0) }",
    "if (process.argv[2] !== 'install') process.exit(41)",
    "const required = ['--frozen-lockfile', '--ignore-scripts', '--config.node-linker=hoisted', '--config.package-import-method=copy']",
    'if (required.some((flag) => !process.argv.includes(flag))) process.exit(42)',
    "fs.mkdirSync(path.join(process.cwd(), 'node_modules', 'fixture-package'), { recursive: true, mode: 0o700 })",
    "fs.writeFileSync(path.join(process.cwd(), 'node_modules', 'fixture-package', 'index.js'), 'module.exports = 1\\n', { mode: 0o600 })",
    "fs.writeFileSync(path.join(process.cwd(), 'node_modules', 'environment.json'), JSON.stringify(process.env), { mode: 0o600 })",
    extra,
  ].join('\n')
}

function fakeGoSource(extra = '') {
  return `#!/bin/sh
set -eu
if [ "\${1:-}" = version ]; then
  printf '%s\\n' 'go version go1.26.5 darwin/amd64'
  exit 0
fi
if [ "\${1:-}" = env ] && [ "\${2:-}" = GOROOT ]; then
  printf '%s\\n' "$GOROOT"
  exit 0
fi
if [ "\${1:-}" = env ] && [ "\${2:-}" = GOWORK ]; then
  printf '%s\\n' "$GOWORK"
  exit 0
fi
if [ "\${1:-}" != -C ]; then
  exit 43
fi
command_dir="$2"
shift 2
if [ "\${1:-}" = work ] && [ "\${2:-}" = init ]; then
  shift 2
  {
    echo 'go 1.26.5'
    echo
    echo 'use ('
    for module_root in "$@"; do echo "  $module_root"; done
    echo ')'
  } > "$command_dir/go.work"
  echo "$GOPROXY|$GOSUMDB|$GOTOOLCHAIN|$GOWORK|\${GOPRIVATE:-}|\${GONOSUMDB:-}|workspace-init" >> "$GOTMPDIR/../go-command.log"
  exit 0
fi
if [ "\${1:-}" != mod ]; then
  exit 44
fi
if [ "\${2:-}" = download ]; then
  if [ "$GOPROXY" = off ] || [ "\${3:-}" != all ]; then
    exit 45
  fi
  mkdir -p "$GOMODCACHE/example.invalid/fixture@v1.0.0"
  printf '%s\\n' 'package fixture' > "$GOMODCACHE/example.invalid/fixture@v1.0.0/fixture.go"
  echo 'fixture workspace sum' > "\${GOWORK}.sum"
elif [ "\${2:-}" != verify ]; then
  exit 46
fi
printf '%s|%s|%s|%s|%s|%s|%s\\n' "$GOPROXY" "$GOSUMDB" "$GOTOOLCHAIN" "$GOWORK" "\${GOPRIVATE:-}" "\${GONOSUMDB:-}" "\${2:-}" >> "$GOTMPDIR/../go-command.log"
${extra}
`
}

async function createFixture(name, { pnpmExtra = '', goExtra = '' } = {}) {
  const created = await mkdtemp(join(tmpdir(), `hexclaw-dependency-${name}-`))
  const root = await realpath(created)
  await chmod(root, 0o700)
  const generationRoot = join(root, 'generation')
  const sourceRoot = join(generationRoot, 'source')
  const moduleRoot = join(sourceRoot, 'go-module')
  const toolRoot = join(root, 'tools')
  const goroot = join(toolRoot, 'goroot')
  await mkdir(moduleRoot, { recursive: true, mode: 0o700 })
  await mkdir(join(goroot, 'bin'), { recursive: true, mode: 0o700 })
  await writeFile(
    join(sourceRoot, 'package.json'),
    `${JSON.stringify({ name: 'fixture', private: true, packageManager: 'pnpm@10.30.3' })}\n`,
    { mode: 0o600 },
  )
  await writeFile(join(sourceRoot, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n", {
    mode: 0o600,
  })
  await writeFile(join(moduleRoot, 'go.mod'), 'module example.invalid/fixture\n\ngo 1.26.0\n', {
    mode: 0o600,
  })
  await writeFile(join(moduleRoot, 'go.sum'), 'example.invalid/dependency v1.0.0 h1:fixture\n', {
    mode: 0o600,
  })
  const goWork = join(generationRoot, 'go.work')
  await writeFile(goWork, 'go 1.26.0\n\nuse ./source/go-module\n', { mode: 0o600 })
  await writeFile(join(generationRoot, 'go.work.sum'), 'fixture\n', { mode: 0o600 })

  const nodeExecutable = join(toolRoot, 'node')
  const pnpmExecutable = join(toolRoot, 'pnpm.cjs')
  const goExecutable = join(goroot, 'bin', 'go')
  const nodeSha256 = await writeExecutable(
    nodeExecutable,
    `#!/bin/sh\nexec ${shellQuote(process.execPath)} "$@"\n`,
  )
  const pnpmSha256 = await writeExecutable(pnpmExecutable, fakePnpmSource(pnpmExtra))
  const goSha256 = await writeExecutable(goExecutable, fakeGoSource(goExtra))
  const limits = {
    commandTimeoutMs: 30_000,
    maxCommandOutputBytes: 64 * 1024,
    maxEntries: 2_000,
    maxFileBytes: 8 * 1024 * 1024,
    maxTotalBytes: 32 * 1024 * 1024,
    nodeInstallTimeoutMs: 30_000,
  }
  const options = {
    generationRoot,
    sourceRoot,
    sourceManifest: { sha256: sha256('fixture source manifest') },
    node: { executable: nodeExecutable, sha256: nodeSha256, version: process.version },
    pnpm: { executable: pnpmExecutable, sha256: pnpmSha256, version: '10.30.3' },
    go: {
      executable: goExecutable,
      sha256: goSha256,
      goroot,
      goWork,
      moduleRoots: [moduleRoot],
      version: 'go version go1.26.5 darwin/amd64',
    },
    limits,
  }
  return {
    generationRoot,
    goExecutable,
    goWork,
    limits,
    moduleRoot,
    nodeExecutable,
    options,
    pnpmExecutable,
    root,
    sourceRoot,
  }
}

test('configuration digest ignores generation and snapshot paths but binds manifest identity', async (t) => {
  const left = await createFixture('stable-digest-left')
  const right = await createFixture('stable-digest-right')
  t.after(() => rm(left.root, { recursive: true, force: true }))
  t.after(() => rm(right.root, { recursive: true, force: true }))
  const module = await import(moduleURL)

  const leftResult = await module.preparePackageDependencyProvenance(left.options)
  const rightResult = await module.preparePackageDependencyProvenance(right.options)
  const leftReceipt = JSON.parse(await readFile(leftResult.receiptPath, 'utf8'))
  const rightReceipt = JSON.parse(await readFile(rightResult.receiptPath, 'utf8'))
  assert.equal(leftReceipt.configurationDigest, rightReceipt.configurationDigest)

  right.options.sourceManifest.sha256 = sha256('different source manifest')
  await rejectsCategory(
    module.verifyPackageDependencyProvenance(right.options),
    'receipt:configuration',
  )
})

async function replaceTool(fixture, name, content) {
  const path = fixture[`${name}Executable`]
  const digest = await writeExecutable(path, content)
  fixture.options[name].sha256 = digest
}

async function rejectsCategory(promise, category) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.category, category)
    assert.equal(error?.message.includes('/private/'), false)
    assert.equal(error?.message.includes('/Users/'), false)
    return true
  })
}

test('prepare installs and verifies Node and Go dependencies inside one private generation', async (t) => {
  const fixture = await createFixture('happy')
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const module = await import(moduleURL)

  const prepared = await module.preparePackageDependencyProvenance(fixture.options)
  const verified = await module.verifyPackageDependencyProvenance(fixture.options)

  assert.equal(relative(fixture.generationRoot, prepared.receiptPath).startsWith('..'), false)
  assert.equal(prepared.node.cwd, fixture.sourceRoot)
  assert.equal(prepared.go.environment.GOPROXY, 'off')
  assert.equal(prepared.go.environment.GOTOOLCHAIN, 'local')
  assert.equal(prepared.go.environment.GOFLAGS, '-mod=readonly -modcacherw')
  assert.equal(prepared.go.environment.GOWORK, prepared.go.workspace)
  assert.notEqual(prepared.go.workspace, fixture.goWork)
  assert.equal(relative(fixture.generationRoot, prepared.go.workspace).startsWith('..'), false)
  assert.deepEqual(verified, prepared)

  const receiptMetadata = await stat(prepared.receiptPath)
  assert.equal(receiptMetadata.mode & 0o777, 0o600)
  const nodeEnvironment = JSON.parse(
    await readFile(join(fixture.sourceRoot, 'node_modules', 'environment.json'), 'utf8'),
  )
  assert.equal(nodeEnvironment.NODE_PATH, undefined)
  assert.equal(nodeEnvironment.npm_config_userconfig, undefined)
  assert.equal(nodeEnvironment.GOPRIVATE, undefined)
  for (const name of ['PNPM_HOME', 'NPM_CONFIG_CACHE', 'HOME', 'TMPDIR']) {
    assert.equal(relative(fixture.generationRoot, nodeEnvironment[name]).startsWith('..'), false)
  }
  const goCommands = await readFile(
    join(fixture.generationRoot, '.package-dependencies', 'go-command.log'),
    'utf8',
  )
  assert.match(goCommands, /^https:\/\/proxy\.golang\.org\|sum\.golang\.org\|local\|/mu)
  assert.match(goCommands, /^off\|sum\.golang\.org\|local\|/mu)
  assert.doesNotMatch(goCommands, /^off\|[^\n]*\|download$/mu)
  assert.match(goCommands, /^https:\/\/proxy\.golang\.org\|[^\n]*\|download$/mu)
  assert.equal(goCommands.includes('GOPRIVATE'), false)
})

test('records bounded pnpm symlinks and verifies the frozen receipt', async (t) => {
  const fixture = await createFixture('bounded-symlink', {
    pnpmExtra: [
      "fs.mkdirSync(path.join(process.cwd(), 'node_modules', '.bin'), { recursive: true, mode: 0o700 })",
      "fs.symlinkSync('../fixture-package/index.js', path.join(process.cwd(), 'node_modules', '.bin', 'fixture'))",
    ].join('\n'),
  })
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const module = await import(moduleURL)

  const prepared = await module.preparePackageDependencyProvenance(fixture.options)
  const verified = await module.verifyPackageDependencyProvenance(fixture.options)

  assert.deepEqual(verified, prepared)
})

test('prepares Go modules without mutating the frozen workspace sums', async (t) => {
  const fixture = await createFixture('workspace-sum', {
    goExtra: [
      'if [ "${2:-}" = download ] && [ "${3:-}" = all ]; then printf "%s\\n" drift >> "${GOWORK}.sum"; fi',
    ].join('\n'),
  })
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const module = await import(moduleURL)

  const prepared = await module.preparePackageDependencyProvenance(fixture.options)
  const verified = await module.verifyPackageDependencyProvenance(fixture.options)

  assert.deepEqual(verified, prepared)
  assert.equal(await readFile(join(fixture.generationRoot, 'go.work.sum'), 'utf8'), 'fixture\n')
  assert.equal(
    await readFile(join(fixture.moduleRoot, 'go.sum'), 'utf8'),
    'example.invalid/dependency v1.0.0 h1:fixture\n',
  )
  assert.equal(
    await readFile(
      join(fixture.generationRoot, '.package-dependencies', 'go-workspace', 'go.work.sum'),
      'utf8',
    ),
    'fixture workspace sum\ndrift\n',
  )
})

test('rejects a generation below an ancestor host node_modules before installing', async (t) => {
  const fixture = await createFixture('host-modules')
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  await mkdir(join(fixture.root, 'node_modules', 'host-canary'), {
    recursive: true,
    mode: 0o700,
  })
  await writeFile(join(fixture.root, 'node_modules', 'host-canary', 'index.js'), 'host\n')
  const module = await import(moduleURL)

  await rejectsCategory(
    module.preparePackageDependencyProvenance(fixture.options),
    'node:host-node-modules',
  )
})

test('rejects source and Go module directories outside the private generation', async (t) => {
  const fixture = await createFixture('escape')
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const outside = join(fixture.root, 'outside')
  await mkdir(outside, { mode: 0o700 })
  const module = await import(moduleURL)

  await rejectsCategory(
    module.preparePackageDependencyProvenance({ ...fixture.options, sourceRoot: outside }),
    'source:escape',
  )
  await rejectsCategory(
    module.preparePackageDependencyProvenance({
      ...fixture.options,
      go: { ...fixture.options.go, moduleRoots: [outside] },
    }),
    'module-root:escape',
  )
})

test('rejects symlink ancestors and hard-linked dependency inputs', async (t) => {
  const symlinkFixture = await createFixture('source-symlink')
  const hardlinkFixture = await createFixture('lock-hardlink')
  t.after(() => rm(symlinkFixture.root, { recursive: true, force: true }))
  t.after(() => rm(hardlinkFixture.root, { recursive: true, force: true }))
  const realSource = join(symlinkFixture.generationRoot, 'source-real')
  await rename(symlinkFixture.sourceRoot, realSource)
  await symlink(realSource, symlinkFixture.sourceRoot)
  const lockPath = join(hardlinkFixture.sourceRoot, 'pnpm-lock.yaml')
  await link(lockPath, join(hardlinkFixture.generationRoot, 'lock-alias'))
  const module = await import(moduleURL)

  await rejectsCategory(
    module.preparePackageDependencyProvenance(symlinkFixture.options),
    'source:symlink',
  )
  await rejectsCategory(
    module.preparePackageDependencyProvenance(hardlinkFixture.options),
    'input:lock:hardlink',
  )
})

test('rejects symlinked and hard-linked pinned tool files before execution', async (t) => {
  const symlinkFixture = await createFixture('tool-symlink')
  const hardlinkFixture = await createFixture('tool-hardlink')
  t.after(() => rm(symlinkFixture.root, { recursive: true, force: true }))
  t.after(() => rm(hardlinkFixture.root, { recursive: true, force: true }))
  const realNode = `${symlinkFixture.nodeExecutable}.real`
  await rename(symlinkFixture.nodeExecutable, realNode)
  await symlink(realNode, symlinkFixture.nodeExecutable)
  await link(hardlinkFixture.goExecutable, `${hardlinkFixture.goExecutable}.alias`)
  const module = await import(moduleURL)

  await rejectsCategory(
    module.preparePackageDependencyProvenance(symlinkFixture.options),
    'tool:node:symlink',
  )
  await rejectsCategory(
    module.preparePackageDependencyProvenance(hardlinkFixture.options),
    'tool:go:hardlink',
  )
})

test('rejects project package-manager config that could override the pinned install policy', async (t) => {
  const fixture = await createFixture('project-config')
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  await writeFile(join(fixture.sourceRoot, '.npmrc'), 'registry=https://private.invalid/\n', {
    mode: 0o600,
  })
  const module = await import(moduleURL)

  await rejectsCategory(
    module.preparePackageDependencyProvenance(fixture.options),
    'node:project-config',
  )
})

test('detects frozen lockfile drift caused during pnpm installation', async (t) => {
  const fixture = await createFixture('lock-drift', {
    pnpmExtra: "fs.appendFileSync(path.join(process.cwd(), 'pnpm-lock.yaml'), '# changed\\n')",
  })
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const module = await import(moduleURL)

  await rejectsCategory(module.preparePackageDependencyProvenance(fixture.options), 'input:drift')
})

for (const attack of [
  {
    category: 'tree:node-modules:symlink',
    extra:
      "fs.symlinkSync(path.join(process.cwd(), 'package.json'), path.join(process.cwd(), 'node_modules', 'escape-link'))",
    name: 'symbolic link',
  },
  {
    category: 'tree:node-modules:hardlink',
    extra: [
      "fs.writeFileSync(path.join(process.cwd(), 'hardlink-source'), 'linked\\n')",
      "fs.linkSync(path.join(process.cwd(), 'hardlink-source'), path.join(process.cwd(), 'node_modules', 'hardlink-target'))",
    ].join('\n'),
    name: 'hard link',
  },
  {
    category: 'tree:node-modules:permissions',
    extra: [
      "fs.writeFileSync(path.join(process.cwd(), 'node_modules', 'writable'), 'bad\\n')",
      "fs.chmodSync(path.join(process.cwd(), 'node_modules', 'writable'), 0o666)",
    ].join('\n'),
    name: 'group-writable file',
  },
]) {
  test(`rejects a ${attack.name} in the installed dependency tree`, async (t) => {
    const fixture = await createFixture(`tree-${attack.name.replaceAll(' ', '-')}`, {
      pnpmExtra: attack.extra,
    })
    t.after(() => rm(fixture.root, { recursive: true, force: true }))
    const module = await import(moduleURL)

    await rejectsCategory(
      module.preparePackageDependencyProvenance(fixture.options),
      attack.category,
    )
  })
}

test('rejects a symlink created in the private Go module cache', async (t) => {
  const fixture = await createFixture('go-cache-symlink', {
    goExtra: '[ -L "$GOMODCACHE/escape-link" ] || ln -s "$GOWORK" "$GOMODCACHE/escape-link"',
  })
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const module = await import(moduleURL)

  await rejectsCategory(
    module.preparePackageDependencyProvenance(fixture.options),
    'tree:go-module-cache:symlink',
  )
})

test('rejects pnpm A/B replacement even when the private snapshot completed its command', async (t) => {
  const fixture = await createFixture('pnpm-swap')
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  await replaceTool(
    fixture,
    'pnpm',
    fakePnpmSource(
      [
        `fs.renameSync(${JSON.stringify(fixture.pnpmExecutable)}, ${JSON.stringify(`${fixture.pnpmExecutable}.old`)})`,
        `fs.writeFileSync(${JSON.stringify(fixture.pnpmExecutable)}, "'use strict'\\n")`,
        `fs.chmodSync(${JSON.stringify(fixture.pnpmExecutable)}, 0o700)`,
      ].join('\n'),
    ),
  )
  const module = await import(moduleURL)

  await rejectsCategory(
    module.preparePackageDependencyProvenance(fixture.options),
    'tool:pnpm:identity',
  )
})

test('rejects Go A/B replacement after a private snapshot invocation', async (t) => {
  const fixture = await createFixture('go-swap')
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  await replaceTool(
    fixture,
    'go',
    fakeGoSource(
      [
        `mv ${shellQuote(fixture.goExecutable)} ${shellQuote(`${fixture.goExecutable}.old`)}`,
        `printf '%s\\n' '#!/bin/sh' 'exit 0' > ${shellQuote(fixture.goExecutable)}`,
        `chmod 700 ${shellQuote(fixture.goExecutable)}`,
      ].join('\n'),
    ),
  )
  const module = await import(moduleURL)

  await rejectsCategory(
    module.preparePackageDependencyProvenance(fixture.options),
    'tool:go:identity',
  )
})

test('does not inherit host Node or Go dependency environment variables', async (t) => {
  const fixture = await createFixture('environment')
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const injected = {
    GONOSUMDB: '*',
    GOPRIVATE: 'private.invalid',
    NODE_OPTIONS: '--require=/private/host-canary.js',
    NODE_PATH: '/private/host-node_modules',
    npm_config_userconfig: '/private/host-npmrc',
  }
  const previous = Object.fromEntries(
    Object.keys(injected).map((name) => [name, process.env[name]]),
  )
  Object.assign(process.env, injected)
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
  const module = await import(moduleURL)

  await module.preparePackageDependencyProvenance(fixture.options)
  const environment = JSON.parse(
    await readFile(join(fixture.sourceRoot, 'node_modules', 'environment.json'), 'utf8'),
  )
  for (const name of Object.keys(injected)) assert.equal(environment[name], undefined)
  const goCommands = await readFile(
    join(fixture.generationRoot, '.package-dependencies', 'go-command.log'),
    'utf8',
  )
  assert.equal(goCommands.includes('private.invalid'), false)
  assert.equal(goCommands.includes('*'), false)
})

test('maps pnpm timeout and output flooding to stable non-leaking categories', async (t) => {
  const timeoutFixture = await createFixture('timeout', {
    pnpmExtra: 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000)',
  })
  const outputFixture = await createFixture('output', {
    pnpmExtra: "process.stdout.write('x'.repeat(1024 * 1024))",
  })
  t.after(() => rm(timeoutFixture.root, { recursive: true, force: true }))
  t.after(() => rm(outputFixture.root, { recursive: true, force: true }))
  timeoutFixture.options.limits.nodeInstallTimeoutMs = 100
  outputFixture.options.limits.maxCommandOutputBytes = 128
  const module = await import(moduleURL)

  await rejectsCategory(
    module.preparePackageDependencyProvenance(timeoutFixture.options),
    'node:install:timeout',
  )
  await rejectsCategory(
    module.preparePackageDependencyProvenance(outputFixture.options),
    'node:install:output-limit',
  )
})

test('fails closed on unknown top-level and nested options', async (t) => {
  const fixture = await createFixture('unknown')
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const module = await import(moduleURL)

  await rejectsCategory(
    module.preparePackageDependencyProvenance({ ...fixture.options, shell: false }),
    'input:unknown-option',
  )
  await rejectsCategory(
    module.preparePackageDependencyProvenance({
      ...fixture.options,
      go: { ...fixture.options.go, GOPROXY: 'direct' },
    }),
    'input:unknown-option',
  )
})

test('enforces aggregate dependency entry and byte ceilings', async (t) => {
  const entryFixture = await createFixture('entry-limit')
  const byteFixture = await createFixture('byte-limit', {
    pnpmExtra:
      "fs.writeFileSync(path.join(process.cwd(), 'node_modules', 'large-file'), 'x'.repeat(4096))",
  })
  const depthFixture = await createFixture('depth-limit', {
    pnpmExtra: [
      "fs.mkdirSync(path.join(process.cwd(), 'node_modules', 'deep', 'a', 'b', 'c'), { recursive: true })",
      "fs.writeFileSync(path.join(process.cwd(), 'node_modules', 'deep', 'a', 'b', 'c', 'file'), 'deep\\n')",
    ].join('\n'),
  })
  t.after(() => rm(entryFixture.root, { recursive: true, force: true }))
  t.after(() => rm(byteFixture.root, { recursive: true, force: true }))
  t.after(() => rm(depthFixture.root, { recursive: true, force: true }))
  entryFixture.options.limits.maxEntries = 1
  byteFixture.options.limits.maxFileBytes = 1024
  depthFixture.options.limits.maxDepth = 2
  const module = await import(moduleURL)

  await rejectsCategory(
    module.preparePackageDependencyProvenance(entryFixture.options),
    'tree:node-modules:entries',
  )
  await rejectsCategory(
    module.preparePackageDependencyProvenance(byteFixture.options),
    'tree:node-modules:file-size',
  )
  await rejectsCategory(
    module.preparePackageDependencyProvenance(depthFixture.options),
    'tree:node-modules:depth',
  )
})

test('verify rejects dependency mutation and a non-private receipt mode', async (t) => {
  const mutationFixture = await createFixture('verify-mutation')
  const receiptFixture = await createFixture('verify-receipt-mode')
  t.after(() => rm(mutationFixture.root, { recursive: true, force: true }))
  t.after(() => rm(receiptFixture.root, { recursive: true, force: true }))
  const module = await import(moduleURL)
  const mutationPrepared = await module.preparePackageDependencyProvenance(mutationFixture.options)
  const receiptPrepared = await module.preparePackageDependencyProvenance(receiptFixture.options)
  await writeFile(
    join(mutationFixture.sourceRoot, 'node_modules', 'fixture-package', 'index.js'),
    'module.exports = 2\n',
  )
  await chmod(receiptPrepared.receiptPath, 0o644)

  await rejectsCategory(
    module.verifyPackageDependencyProvenance(mutationFixture.options),
    'tree:drift',
  )
  assert.equal(mutationPrepared.receiptPath.endsWith('receipt.json'), true)
  await rejectsCategory(
    module.verifyPackageDependencyProvenance(receiptFixture.options),
    'receipt:permissions',
  )
})

test('CLI prepare and verify emit only stable English status categories', async (t) => {
  const fixture = await createFixture('cli')
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const configPath = join(fixture.generationRoot, 'dependency-config.json')
  await writeFile(configPath, `${JSON.stringify(fixture.options)}\n`, { mode: 0o600 })
  const modulePath = new URL(moduleURL).pathname
  const environment = {
    ...process.env,
    GOPRIVATE: 'private.invalid',
    NODE_PATH: '/private/host-node_modules',
  }

  const prepared = await execFileAsync(
    process.execPath,
    [modulePath, 'prepare', '--config', configPath],
    {
      env: environment,
    },
  )
  assert.equal(prepared.stdout, 'PASS: package-dependency-provenance category=prepared\n')
  assert.equal(prepared.stderr, '')
  const verified = await execFileAsync(
    process.execPath,
    [modulePath, 'verify', '--config', configPath],
    {
      env: environment,
    },
  )
  assert.equal(verified.stdout, 'PASS: package-dependency-provenance category=verified\n')
  assert.equal(verified.stderr, '')

  await assert.rejects(
    execFileAsync(process.execPath, [modulePath, 'verify', '--config', `${configPath}.missing`]),
    (error) => {
      assert.match(error.stderr, /^ERROR: package-dependency-provenance category=[a-z0-9:-]+\n$/u)
      assert.equal(error.stderr.includes(fixture.root), false)
      return true
    },
  )
})
