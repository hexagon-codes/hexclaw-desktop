import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { promisify } from 'node:util'

const makefileURL = new URL('../../Makefile', import.meta.url)
const makefilePath = fileURLToPath(makefileURL)
const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const orchestratorURL = new URL('../../scripts/ci/package-local.mjs', import.meta.url)
const execFileAsync = promisify(execFile)

function targetRecipe(source, name, nextName) {
  const start = source.indexOf(`${name}:`)
  const end = source.indexOf(`\n${nextName}:`, start)
  assert.notEqual(start, -1, `${name} target must exist`)
  assert.notEqual(end, -1, `${nextName} target must follow ${name}`)
  return source.slice(start, end)
}

test('Make owns no package state and delegates only to the fixed Node orchestrator', async () => {
  const source = await readFile(makefileURL, 'utf8')
  const recipe = targetRecipe(source, 'package-local', 'verify-package-local')
  const verifyRecipe = targetRecipe(source, 'verify-package-local', 'build-web')

  assert.match(source, /^override PACKAGE_LOCAL_NODE\s*:=/mu)
  assert.match(source, /^override PACKAGE_LOCAL_ORCHESTRATOR\s*:=/mu)
  assert.match(recipe, /^package-local:\s*\n\t@\$\(PACKAGE_LOCAL_NODE\) \$\(PACKAGE_LOCAL_ORCHESTRATOR\) build\s*$/mu)
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
    ],
    { cwd: repoRoot, maxBuffer: 64 * 1024 },
  )
  const expectedNode = process.arch === 'arm64' ? '/opt/homebrew/bin/node' : '/usr/local/bin/node'
  assert.equal(
    stdout.trim(),
    `${expectedNode} ${fileURLToPath(orchestratorURL)} build`,
  )
})

test('Node orchestrator owns trimpath remapping metadata stripping and receipt-last publication', async () => {
  const source = await readFile(orchestratorURL, 'utf8')
  const publishSource = source.indexOf('await operations.publishSourceManifest(context)')
  const writeResult = source.indexOf('await operations.writeBuildResult(context)')
  const publishReceipt = source.indexOf('await operations.publishReceipt(context)')

  assert.match(source, /'build',\s*'-trimpath',/u)
  assert.match(source, /--remap-path-prefix=\$\{plan\.hostHome\}=\/build\/home/u)
  assert.match(source, /--remap-path-prefix=\$\{join\(plan\.hostHome, '\.cargo'\)\}=\/build\/cargo/u)
  assert.match(source, /'--norsrc',\s*'--noextattr',\s*'--noqtn',\s*'--noacl'/u)
  assert.match(source, /runSensitiveBoundary\(\s*context,\s*'sanitize'/u)
  assert.ok(publishSource >= 0 && publishSource < writeResult)
  assert.ok(writeResult < publishReceipt)
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
  assert.equal(goBuildLines.every((line) => line.includes('-trimpath')), true)
  assert.doesNotMatch(source, /@mkdir -p src-tauri\/binaries/)
  assert.equal(source.match(/@mkdir -p "\$\(SIDECAR_BIN_DIR\)"/g)?.length, 5)
})
