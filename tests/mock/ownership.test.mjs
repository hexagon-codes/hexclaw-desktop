import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const ownershipPath = path.join(testDir, 'ownership.json')
const cliPath = path.join(testDir, 'run-manifest.mjs')
const sha256 = (value) => createHash('sha256').update(value).digest('hex')

const readJSON = async (file) => JSON.parse(await readFile(file, 'utf8'))

const git = (cwd, ...args) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()

const createGitFixture = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hexclaw-run-manifest-git-'))
  const fixturePath = path.join(root, 'fixtures.json')
  const fixtureBody = `${JSON.stringify(
    {
      schema_version: 7,
      fixtures: [{ id: 'synthetic-engine-smoke', source: 'synthetic' }],
    },
    null,
    2,
  )}\n`

  git(root, 'init', '--quiet')
  git(root, 'config', 'user.name', 'HexClaw Tests')
  git(root, 'config', 'user.email', 'tests@hexclaw.invalid')
  await writeFile(path.join(root, 'tracked.txt'), 'tracked\n')
  await writeFile(fixturePath, fixtureBody)
  git(root, 'add', '.')
  git(root, 'commit', '--quiet', '-m', 'test fixture')

  return { root, fixturePath, fixtureBody }
}

const runCLI = ({
  artifactDir,
  desktopRoot,
  fixturePath,
  lane = 'l3-engine-smoke',
  extraArgs = [],
  extraEnv = {},
}) =>
  spawnSync(
    process.execPath,
    [
      cliPath,
      '--artifact-dir',
      artifactDir,
      '--desktop-root',
      desktopRoot,
      '--fixture-manifest',
      fixturePath,
      '--ownership',
      ownershipPath,
      '--lane',
      lane,
      '--mockserver-image',
      `mockserver/mockserver:7.4.0@sha256:${'a'.repeat(64)}`,
      ...extraArgs,
    ],
    {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        HEXCLAW_REF: 'refs/tags/v0.5.0-beta',
        HEXCLAW_LOCAL_SRC: path.join(desktopRoot, '..', 'hexclaw-local'),
        OPENAI_API_KEY: 'sk-must-never-appear',
        DINGTALK_APP_SECRET: 'ding-secret-must-never-appear',
        HTTPS_PROXY: 'https://proxy-user:proxy-password@example.invalid:8443',
        ...extraEnv,
      },
    },
  )

test('ownership policy assigns contracts to the repository that implements them', async () => {
  const policy = await readJSON(ownershipPath)

  assert.equal(policy.schema_version, 1)
  assert.equal(policy.contract_source_of_truth, 'serializer-parser-owner')
  assert.deepEqual(policy.repositories['ai-core'].owns, [
    'openai-compatible-provider-wire-contracts',
    'ollama-provider-wire-contracts',
  ])
  assert.deepEqual(policy.repositories.hexclaw.owns, [
    'ai-core-consumer-contracts',
    'dingtalk-adapter-contracts',
    'knowledge-contracts',
    'k12-contracts',
  ])
  assert.deepEqual(policy.repositories['hexclaw-desktop'].owns, [
    'mock-runtime-orchestration',
    'browser-journeys',
    'native-tauri-smoke',
    'engine-smoke-fixtures',
  ])
  assert.equal(policy.repositories['hexclaw-desktop'].fixture_authority, 'non-normative-smoke-only')
  assert.deepEqual(policy.repositories['hexclaw-desktop'].must_not_own, [
    'provider-wire-contracts',
    'dingtalk-adapter-contracts',
    'knowledge-contracts',
    'k12-contracts',
  ])
  assert.ok(policy.test_lanes['l3-engine-smoke'])
  assert.ok(policy.test_lanes['l4a-browser-sidecar'])
  assert.ok(policy.test_lanes['l4b-native-tauri'])
  assert.ok(policy.test_lanes['l5-live-canary'])
})

test('CLI writes a traceable manifest while whitelisting environment data', async (t) => {
  const fixture = await createGitFixture()
  const artifactDir = await mkdtemp(path.join(tmpdir(), 'hexclaw-run-artifacts-'))
  const localSrc = path.join(fixture.root, '..', 'hexclaw-local')
  await mkdir(localSrc, { recursive: true })
  t.after(() => chmod(path.join(artifactDir, 'run-manifest.json'), 0o600).catch(() => {}))

  const result = runCLI({ artifactDir, desktopRoot: fixture.root, fixturePath: fixture.fixturePath })
  assert.equal(result.status, 0, result.stderr)

  const outputPath = path.join(artifactDir, 'run-manifest.json')
  const outputText = await readFile(outputPath, 'utf8')
  const manifest = JSON.parse(outputText)
  const expectedSHA = git(fixture.root, 'rev-parse', 'HEAD')
  const ownershipBody = await readFile(ownershipPath)

  assert.equal(manifest.schema_version, 1)
  assert.match(manifest.run_id, /^\d{8}T\d{9}Z-[0-9]+-[a-f0-9]{8}$/)
  assert.match(manifest.generated_at_utc, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  assert.equal(manifest.test_lane, 'l3-engine-smoke')
  assert.deepEqual(manifest.desktop_git, {
    sha: expectedSHA,
    dirty: false,
    policy: 'verified',
  })
  assert.deepEqual(manifest.sidecar_source, {
    hexclaw_ref: 'refs/tags/v0.5.0-beta',
    hexclaw_local_src: path.resolve(localSrc),
    selection: 'local-src-overrides-ref',
  })
  assert.deepEqual(manifest.fixture_manifest, {
    schema_version: 7,
    sha256: sha256(fixture.fixtureBody),
    path: 'fixtures.json',
  })
  assert.deepEqual(manifest.ownership_policy, {
    schema_version: 1,
    sha256: sha256(ownershipBody),
    path: path.relative(fixture.root, ownershipPath).split(path.sep).join('/'),
  })
  assert.deepEqual(manifest.mockserver_image, {
    reference: 'mockserver/mockserver:7.4.0',
    digest: `sha256:${'a'.repeat(64)}`,
  })
  assert.equal((await stat(outputPath)).mode & 0o777, 0o600)

  for (const forbidden of [
    'OPENAI_API_KEY',
    'DINGTALK_APP_SECRET',
    'HTTPS_PROXY',
    'sk-must-never-appear',
    'ding-secret-must-never-appear',
    'proxy-password',
  ]) {
    assert.doesNotMatch(outputText, new RegExp(forbidden))
  }
})

test('CLI records a dirty desktop worktree', async () => {
  const fixture = await createGitFixture()
  const artifactDir = await mkdtemp(path.join(tmpdir(), 'hexclaw-run-dirty-'))
  await writeFile(path.join(fixture.root, 'untracked.txt'), 'dirty\n')
  await mkdir(path.join(fixture.root, '..', 'hexclaw-local'), { recursive: true })

  const result = runCLI({ artifactDir, desktopRoot: fixture.root, fixturePath: fixture.fixturePath })
  assert.equal(result.status, 0, result.stderr)
  const manifest = await readJSON(path.join(artifactDir, 'run-manifest.json'))
  assert.equal(manifest.desktop_git.dirty, true)
})

test('CLI fails closed outside a git repository by default', async () => {
  const desktopRoot = await mkdtemp(path.join(tmpdir(), 'hexclaw-run-no-git-'))
  const artifactDir = await mkdtemp(path.join(tmpdir(), 'hexclaw-run-no-git-artifacts-'))
  const fixturePath = path.join(desktopRoot, 'fixtures.json')
  await writeFile(fixturePath, '{"schema_version":1,"fixtures":[]}\n')
  await mkdir(path.join(desktopRoot, '..', 'hexclaw-local'), { recursive: true })

  const result = runCLI({ artifactDir, desktopRoot, fixturePath })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /desktop root is not a verifiable git worktree/i)
  await assert.rejects(readFile(path.join(artifactDir, 'run-manifest.json')), /ENOENT/)
})

test('CLI records an explicit unknown policy only when opted in', async () => {
  const desktopRoot = await mkdtemp(path.join(tmpdir(), 'hexclaw-run-unknown-git-'))
  const artifactDir = await mkdtemp(path.join(tmpdir(), 'hexclaw-run-unknown-artifacts-'))
  const fixturePath = path.join(desktopRoot, 'fixtures.json')
  await writeFile(fixturePath, '{"schema_version":1,"fixtures":[]}\n')
  await mkdir(path.join(desktopRoot, '..', 'hexclaw-local'), { recursive: true })

  const result = runCLI({
    artifactDir,
    desktopRoot,
    fixturePath,
    extraArgs: ['--allow-unknown-git'],
  })
  assert.equal(result.status, 0, result.stderr)
  const manifest = await readJSON(path.join(artifactDir, 'run-manifest.json'))
  assert.deepEqual(manifest.desktop_git, {
    sha: 'unknown',
    dirty: 'unknown',
    policy: 'explicit-allow-unknown',
  })
})

test('CLI rejects unpinned MockServer images', async () => {
  const fixture = await createGitFixture()
  const artifactDir = await mkdtemp(path.join(tmpdir(), 'hexclaw-run-unpinned-'))
  await mkdir(path.join(fixture.root, '..', 'hexclaw-local'), { recursive: true })

  const result = runCLI({
    artifactDir,
    desktopRoot: fixture.root,
    fixturePath: fixture.fixturePath,
    extraArgs: ['--mockserver-image', 'mockserver/mockserver:latest'],
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /must be pinned by sha256 digest/i)
  await assert.rejects(readFile(path.join(artifactDir, 'run-manifest.json')), /ENOENT/)
})

test('CLI rejects lanes absent from the ownership policy', async () => {
  const fixture = await createGitFixture()
  const artifactDir = await mkdtemp(path.join(tmpdir(), 'hexclaw-run-lane-'))
  await mkdir(path.join(fixture.root, '..', 'hexclaw-local'), { recursive: true })

  const result = runCLI({
    artifactDir,
    desktopRoot: fixture.root,
    fixturePath: fixture.fixturePath,
    lane: 'made-up-lane',
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /unknown test lane/i)
})
