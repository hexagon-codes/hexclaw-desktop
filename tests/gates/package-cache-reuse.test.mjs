// RED 门禁：package-local 构建缓存必须可跨 generation 复用（BUG-20260816-001）。
// 现状（未修复生产代码）：五类依赖缓存全部位于每次随机 generation 私有目录，
// 本文件断言修复后的目标语义，当前实现必须全部失败（RED）。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import test from 'node:test'

const packageLocalURL = new URL('../../scripts/ci/package-local.mjs', import.meta.url)
const provenanceURL = new URL('../../scripts/ci/package-dependency-provenance.mjs', import.meta.url)

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

// 精简 pnpm 假实现：install 时在 sourceRoot 创建 fixture 包与环境快照。
function fakePnpmSource() {
  return [
    "'use strict'",
    "const fs = require('node:fs')",
    "const path = require('node:path')",
    "if (process.argv[2] === '--version') { process.stdout.write('10.30.3\\n'); process.exit(0) }",
    "if (process.argv[2] !== 'install') process.exit(41)",
    "fs.mkdirSync(path.join(process.cwd(), 'node_modules', 'fixture-package'), { recursive: true, mode: 0o700 })",
    "fs.writeFileSync(path.join(process.cwd(), 'node_modules', 'fixture-package', 'index.js'), 'module.exports = 1\\n', { mode: 0o600 })",
    "fs.writeFileSync(path.join(process.cwd(), 'node_modules', 'environment.json'), JSON.stringify(process.env), { mode: 0o600 })",
  ].join('\n')
}

// 精简 go 假实现：mod download 时在 GOMODCACHE 下写入 fixture 模块。
function fakeGoSource() {
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
  exit 0
fi
if [ "\${2:-}" != verify ]; then
  exit 46
fi
exit 0
`
}

// 构造 dependency-provenance fixture；cacheRoot 可选（宿主持久缓存根）。
async function createFixture(name, { cacheRoot } = {}) {
  const created = await mkdtemp(join(tmpdir(), `hexclaw-cache-reuse-${name}-`))
  const root = await realpath(created)
  await chmod(root, 0o700)
  const generationRoot = join(root, 'generation')
  const sourceRoot = join(generationRoot, 'source')
  const moduleRoot = join(sourceRoot, 'go-module')
  const toolRoot = join(root, 'tools')
  const goroot = join(toolRoot, 'goroot')
  // 默认缓存根嵌套一层子目录：便于构造"缓存根父目录缺失"的宿主场景（Low-1）。
  const resolvedCacheRoot = cacheRoot ?? join(root, 'nested', 'host-cache')
  await mkdir(moduleRoot, { recursive: true, mode: 0o700 })
  await mkdir(join(goroot, 'bin'), { recursive: true, mode: 0o700 })
  await mkdir(resolvedCacheRoot, { recursive: true, mode: 0o700 })
  await chmod(resolvedCacheRoot, 0o700)
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
  const pnpmSha256 = await writeExecutable(pnpmExecutable, fakePnpmSource())
  const goSha256 = await writeExecutable(goExecutable, fakeGoSource())
  const options = {
    cacheRoot: resolvedCacheRoot,
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
    limits: {
      commandTimeoutMs: 30_000,
      maxCommandOutputBytes: 64 * 1024,
      maxEntries: 2_000,
      maxFileBytes: 8 * 1024 * 1024,
      maxTotalBytes: 32 * 1024 * 1024,
      nodeInstallTimeoutMs: 30_000,
    },
  }
  return { cacheRoot: resolvedCacheRoot, generationRoot, goExecutable, options, root, sourceRoot }
}

test('plan keeps build caches in a persistent host cache root outside the generation', async () => {
  const { createPackageLocalPlan } = await import(packageLocalURL)
  const desktopRoot = '/workspace/hexclaw-desktop'
  const hostHome = '/Users/developer'
  const plan = createPackageLocalPlan({
    desktopRoot,
    generationId: '2'.repeat(32),
    hostHome,
    targetTriple: 'x86_64-apple-darwin',
    version: '0.5.0-beta',
  })

  const cacheRoot = join(hostHome, '.cache', 'hexclaw-package')
  assert.equal(plan.paths.cacheRoot, cacheRoot)
  for (const [name, pathname] of Object.entries({
    sharedCargoHome: plan.paths.sharedCargoHome,
    sharedCargoTarget: plan.paths.sharedCargoTarget,
    sharedOllamaArchive: plan.paths.sharedOllamaArchive,
  })) {
    assert.equal(typeof pathname, 'string', `${name} must exist on plan.paths`)
    assert.equal(pathname.startsWith(cacheRoot), true, `${name} must live under cacheRoot`)
    assert.equal(pathname.startsWith(plan.paths.generationRoot), false, `${name} must stay outside generation`)
  }
})

test('dependency provenance carries a persistent cache root into its options', async () => {
  const { createDependencyProvenanceOptions, createPackageLocalPlan } = await import(packageLocalURL)
  const plan = createPackageLocalPlan({
    desktopRoot: '/workspace/hexclaw-desktop',
    generationId: '3'.repeat(32),
    hostHome: '/Users/developer',
    targetTriple: 'x86_64-apple-darwin',
    version: '0.5.0-beta',
  })
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
    '9'.repeat(64),
  )
  assert.equal(options.cacheRoot, join(plan.hostHome, '.cache', 'hexclaw-package'))
})

test('prepare reuses an existing legal host cache directory instead of recreating it', async (t) => {
  const fixture = await createFixture('reuse')
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const module = await import(provenanceURL)

  // 预置合法宿主缓存：已存在的 GOMODCACHE 模块（上一轮构建遗留）。
  const preexistingModule = join(fixture.cacheRoot, 'go-module-cache', 'example.invalid', 'pre-existing@v1.0.0')
  await mkdir(preexistingModule, { recursive: true, mode: 0o700 })
  const preexistingFile = join(preexistingModule, 'pre.go')
  await writeFile(preexistingFile, 'package pre\n', { mode: 0o600 })

  const prepared = await module.preparePackageDependencyProvenance(fixture.options)

  // 预置缓存内容必须保留且被复用，而不是被删除重建。
  assert.equal((await stat(preexistingFile)).isFile(), true)
  assert.equal(
    await readFile(preexistingFile, 'utf8'),
    'package pre\n',
    'pre-existing host cache content must be preserved',
  )
  // GOCACHE/GOMODCACHE/PNPM_STORE_DIR/NPM_CONFIG_CACHE 必须指向宿主持久缓存根。
  const env = prepared.go.environment
  assert.equal(env.GOMODCACHE.startsWith(fixture.cacheRoot), true)
  assert.equal(env.GOCACHE.startsWith(fixture.cacheRoot), true)
  const nodeEnv = JSON.parse(
    await readFile(join(fixture.sourceRoot, 'node_modules', 'environment.json'), 'utf8'),
  )
  assert.equal(nodeEnv.PNPM_STORE_DIR.startsWith(fixture.cacheRoot), true)
  assert.equal(nodeEnv.NPM_CONFIG_CACHE.startsWith(fixture.cacheRoot), true)
  // 缓存目录不得位于 generation 私有目录。
  assert.equal(env.GOMODCACHE.startsWith(fixture.generationRoot), false)
  assert.equal(env.GOCACHE.startsWith(fixture.generationRoot), false)
})

test('receipt trees do not bind reusable host cache content', async (t) => {
  const fixture = await createFixture('tree')
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const module = await import(provenanceURL)

  const prepared = await module.preparePackageDependencyProvenance(fixture.options)
  const receipt = JSON.parse(await readFile(prepared.receiptPath, 'utf8'))

  // 可复用缓存树不得进入 receipt.trees：共享缓存内容可变，不能成为身份摘要。
  for (const label of ['go-module-cache', 'pnpm-store', 'npm-cache']) {
    assert.equal(Object.hasOwn(receipt.trees ?? {}, label), false, `${label} must not be in receipt.trees`)
  }
  // 缓存路径也不得进入 receipt 的 configurationDigest 语义（相对 generation 的路径记录不含缓存）。
  assert.equal(relative(fixture.generationRoot, prepared.receiptPath).startsWith('..'), false)
})

test('prepare creates the cache root when its parent directory does not exist', async (t) => {
  const fixture = await createFixture('cache-parent-missing')
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const module = await import(provenanceURL)

  // 模拟宿主缓存根父目录缺失（如 macOS 默认无 ~/.cache）：删除缓存根及其父目录。
  assert.equal(fixture.cacheRoot.endsWith(join('nested', 'host-cache')), true)
  await rm(dirname(fixture.cacheRoot), { recursive: true, force: true })

  // 承诺"缺失时创建"就必须在父目录缺失时也能创建，而不是失败。
  const prepared = await module.preparePackageDependencyProvenance(fixture.options)
  assert.equal(prepared.go.environment.GOMODCACHE.startsWith(fixture.cacheRoot), true)
})
