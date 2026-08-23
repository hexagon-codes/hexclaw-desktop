import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

const moduleURL = new URL('../../scripts/ci/package-generation-publication.mjs', import.meta.url)
const targetTriple = 'x86_64-apple-darwin'
const releaseVersion = '0.5.0-beta'
const execFileAsync = promisify(execFile)

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function stageFixture(layout, label) {
  await mkdir(join(layout.candidateRoot, 'dist'), { mode: 0o700, recursive: true })
  await mkdir(join(layout.candidateRoot, 'HexClaw.app', 'Contents', 'MacOS'), {
    mode: 0o700,
    recursive: true,
  })
  await writeFile(join(layout.candidateRoot, 'dist', 'index.html'), `${label}\n`, { mode: 0o600 })
  await writeFile(
    join(layout.candidateRoot, 'HexClaw.app', 'Contents', 'MacOS', 'hexclaw-desktop'),
    `${label}-app\n`,
    { mode: 0o700 },
  )
  await writeFile(layout.packagePath, `${label}-dmg\n`, { mode: 0o600 })
  await writeFile(layout.manifestPath, `${label}-manifest\n`, { mode: 0o600 })
  const sourceManifest = Buffer.from(`${label}-source\n`)
  const receipt = Buffer.from(`${label}-receipt\n`)
  await writeFile(layout.sourceManifestPath, sourceManifest, { mode: 0o600 })
  await writeFile(layout.receiptPath, receipt, { mode: 0o600 })
  await writeFile(layout.resultPath, `${label}-result\n`, { mode: 0o600 })
  return Object.freeze({
    receiptSHA256: sha256(receipt),
    sourceManifestSHA256: sha256(sourceManifest),
  })
}

async function createReleaseRoot(t, label) {
  const root = await realpath(await mkdtemp(join(tmpdir(), `hexclaw-publication-${label}-`)))
  t.after(() => rm(root, { force: true, recursive: true }))
  await chmod(root, 0o755)
  return root
}

async function publishFixture(module, root, generationId, label) {
  const layout = module.createPackagePublicationLayout({ generationId, releaseRoot: root })
  const identity = await stageFixture(layout, label)
  const publication = await module.publishPackageGeneration({ layout })
  return { identity, layout, publication }
}

async function commitFixture(module, root, generationId, label) {
  const fixture = await publishFixture(module, root, generationId, label)
  await module.commitPackageGeneration({
    ...fixture.identity,
    generationSHA256: fixture.publication.generationSHA256,
    layout: fixture.layout,
    releaseVersion,
    targetTriple,
  })
  await module.cleanupPackageStaging({ layout: fixture.layout })
  return fixture
}

async function runKilledPublicationChild(source) {
  await assert.rejects(
    execFileAsync(process.execPath, ['--input-type=module', '--eval', source], {
      maxBuffer: 64 * 1024,
    }),
    (error) => error.signal === 'SIGKILL',
  )
}

async function recoverInFreshProcess(root) {
  const source = [
    `const module = await import(${JSON.stringify(moduleURL.href)});`,
    `await module.recoverPackagePublication(${JSON.stringify({ releaseRoot: root })});`,
  ].join('\n')
  const result = await execFileAsync(process.execPath, ['--input-type=module', '--eval', source], {
    maxBuffer: 64 * 1024,
  })
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '')
}

async function resolveInFreshProcess(root) {
  const source = [
    "import { readFile } from 'node:fs/promises';",
    `const module = await import(${JSON.stringify(moduleURL.href)});`,
    `const result = await module.resolveCurrentPackageGeneration(${JSON.stringify({ releaseRoot: root, releaseVersion, targetTriple })});`,
    "process.stdout.write(JSON.stringify({ generationId: result.generationId, packageBytes: await readFile(result.packagePath, 'utf8') }));",
  ].join('\n')
  const result = await execFileAsync(process.execPath, ['--input-type=module', '--eval', source], {
    maxBuffer: 64 * 1024,
  })
  assert.equal(result.stderr, '')
  return JSON.parse(result.stdout)
}

test('immutable generation publication accepts an owned 0755 public parent without chmod', async (t) => {
  const {
    commitPackageGeneration,
    createPackagePublicationLayout,
    publishPackageGeneration,
    resolveCurrentPackageGeneration,
  } = await import(moduleURL)
  const root = await createReleaseRoot(t, '0755')
  const layout = createPackagePublicationLayout({
    generationId: '1'.repeat(32),
    releaseRoot: root,
  })
  const identity = await stageFixture(layout, 'first')

  const publication = await publishPackageGeneration({ layout })
  await commitPackageGeneration({
    ...identity,
    generationSHA256: publication.generationSHA256,
    layout,
    releaseVersion,
    targetTriple,
  })
  const resolved = await resolveCurrentPackageGeneration({
    releaseRoot: root,
    releaseVersion,
    targetTriple,
  })

  assert.equal((await lstat(root)).mode & 0o777, 0o755)
  assert.equal(resolved.generationId, layout.generationId)
  assert.equal(await readFile(resolved.packagePath, 'utf8'), 'first-dmg\n')
})

test('publication failures never expose a partial new generation through current', async (t) => {
  const module = await import(moduleURL)
  for (const checkpoint of ['lstat', 'mkdir', 'file-fsync', 'rename', 'parent-fsync']) {
    await t.test(checkpoint, async (caseTest) => {
      const root = await createReleaseRoot(caseTest, `publish-${checkpoint}`)
      const old = await commitFixture(module, root, '2'.repeat(32), 'old')
      const nextLayout = module.createPackagePublicationLayout({
        generationId: '3'.repeat(32),
        releaseRoot: root,
      })
      await stageFixture(nextLayout, 'new')
      const adapter = module.createPackagePublicationTestAdapter({ failAt: checkpoint })

      await assert.rejects(
        module.publishPackageGeneration({ layout: nextLayout }, adapter),
        new RegExp(`category=injected-${checkpoint}`),
      )
      const current = await module.resolveCurrentPackageGeneration({
        releaseRoot: root,
        releaseVersion,
        targetTriple,
      })
      assert.equal(current.generationId, old.layout.generationId)
      assert.equal(await readFile(current.packagePath, 'utf8'), 'old-dmg\n')
      await module.recoverPackagePublication({ releaseRoot: root })
    })
  }
})

test('current commit failures resolve only an old or a complete new generation', async (t) => {
  const module = await import(moduleURL)
  for (const checkpoint of [
    'write',
    'file-fsync',
    'before-current-commit',
    'parent-fsync',
    'after-current-commit',
  ]) {
    await t.test(checkpoint, async (caseTest) => {
      const root = await createReleaseRoot(caseTest, `commit-${checkpoint}`)
      const old = await commitFixture(module, root, '4'.repeat(32), 'old')
      const next = await publishFixture(module, root, '5'.repeat(32), 'new')
      const adapter = module.createPackagePublicationTestAdapter({ failAt: checkpoint })

      await assert.rejects(
        module.commitPackageGeneration(
          {
            ...next.identity,
            generationSHA256: next.publication.generationSHA256,
            layout: next.layout,
            releaseVersion,
            targetTriple,
          },
          adapter,
        ),
        new RegExp(`category=injected-${checkpoint}`),
      )
      const current = await module.resolveCurrentPackageGeneration({
        releaseRoot: root,
        releaseVersion,
        targetTriple,
      })
      const committed = ['parent-fsync', 'after-current-commit'].includes(checkpoint)
      assert.equal(
        current.generationId,
        committed ? next.layout.generationId : old.layout.generationId,
      )
      assert.equal(
        await readFile(current.packagePath, 'utf8'),
        `${committed ? 'new' : 'old'}-dmg\n`,
      )
      await module.recoverPackagePublication({ releaseRoot: root })
    })
  }
})

test('restart recovery preserves current and removes uncommitted staging and published orphans', async (t) => {
  const module = await import(moduleURL)
  const root = await createReleaseRoot(t, 'recovery')
  const current = await commitFixture(module, root, '6'.repeat(32), 'current')
  const orphan = await publishFixture(module, root, '7'.repeat(32), 'orphan')
  const failedCleanup = module.createPackagePublicationTestAdapter({ failAt: 'cleanup' })

  await assert.rejects(
    module.recoverPackagePublication({ releaseRoot: root }, failedCleanup),
    /category=injected-cleanup/u,
  )
  assert.equal(
    (
      await module.resolveCurrentPackageGeneration({
        releaseRoot: root,
        releaseVersion,
        targetTriple,
      })
    ).generationId,
    current.layout.generationId,
  )

  await module.recoverPackagePublication({ releaseRoot: root })
  await assert.rejects(lstat(orphan.layout.publishedGenerationRoot), { code: 'ENOENT' })
  assert.equal((await lstat(current.layout.publishedGenerationRoot)).isDirectory(), true)
})

test('restart recovery remains fail-closed for an unsafe generation-shaped staging directory', async (t) => {
  const module = await import(moduleURL)
  const root = await createReleaseRoot(t, 'unsafe-staging-generation')
  await module.recoverPackagePublication({ releaseRoot: root })
  const layout = module.createPackagePublicationLayout({
    generationId: 'd'.repeat(32),
    releaseRoot: root,
  })
  await mkdir(layout.stagingGenerationRoot, { mode: 0o755 })

  await assert.rejects(
    module.recoverPackagePublication({ releaseRoot: root }),
    /category=cleanup-path/u,
  )
  assert.equal((await lstat(layout.stagingGenerationRoot)).isDirectory(), true)
})

test('resolver binds the complete generation tree before returning any consumable path', async (t) => {
  const module = await import(moduleURL)
  for (const [surface, relativePath] of [
    ['app', join('HexClaw.app', 'Contents', 'MacOS', 'hexclaw-desktop')],
    ['dmg', 'package.dmg'],
    ['dist', join('dist', 'index.html')],
  ]) {
    await t.test(surface, async (caseTest) => {
      const root = await createReleaseRoot(caseTest, `tree-digest-${surface}`)
      const current = await commitFixture(module, root, 'a'.repeat(32), 'bound')
      await writeFile(join(current.layout.publishedGenerationRoot, relativePath), 'mutated\n')

      await assert.rejects(
        module.resolveCurrentPackageGeneration({
          releaseRoot: root,
          releaseVersion,
          targetTriple,
        }),
        /category=current-pointer/u,
      )
    })
  }
})

test('real syscall crash matrix converges in a fresh recovery process', async (t) => {
  const module = await import(moduleURL)
  const cases = [
    { operation: 'lstat', phase: 'publish' },
    { operation: 'mkdir', phase: 'publish' },
    { operation: 'write', phase: 'commit' },
    { operation: 'file-fsync', phase: 'commit' },
    { operation: 'rename', phase: 'publish' },
    { operation: 'parent-fsync', phase: 'publish' },
    { operation: 'current-commit', phase: 'commit' },
    { operation: 'cleanup', phase: 'cleanup' },
  ]
  for (const fixtureCase of cases) {
    for (const boundary of ['before', 'after']) {
      const checkpoint = `${fixtureCase.operation}:${boundary}`
      await t.test(checkpoint, async (caseTest) => {
        const root = await createReleaseRoot(caseTest, `crash-${fixtureCase.operation}-${boundary}`)
        const old = await commitFixture(module, root, 'b'.repeat(32), 'old')
        let next
        if (fixtureCase.phase === 'publish') {
          const layout = module.createPackagePublicationLayout({
            generationId: 'c'.repeat(32),
            releaseRoot: root,
          })
          const identity = await stageFixture(layout, 'new')
          next = { identity, layout }
        } else {
          next = await publishFixture(module, root, 'c'.repeat(32), 'new')
        }
        const adapterSource = `module.createPackagePublicationTestAdapter(${JSON.stringify({ terminateAt: checkpoint })})`
        let action
        if (fixtureCase.phase === 'publish') {
          action = `await module.publishPackageGeneration({ layout }, ${adapterSource});`
        } else if (fixtureCase.phase === 'commit') {
          const commitOptions = JSON.stringify({
            ...next.identity,
            generationSHA256: next.publication.generationSHA256,
            releaseVersion,
            targetTriple,
          })
          action = `await module.commitPackageGeneration({ ...${commitOptions}, layout }, ${adapterSource});`
        } else {
          action = `await module.recoverPackagePublication(${JSON.stringify({ releaseRoot: root })}, ${adapterSource});`
        }
        const childSource = [
          `const module = await import(${JSON.stringify(moduleURL.href)});`,
          `const layout = module.createPackagePublicationLayout(${JSON.stringify({ generationId: next.layout.generationId, releaseRoot: root })});`,
          action,
        ].join('\n')

        await runKilledPublicationChild(childSource)
        await recoverInFreshProcess(root)
        const resolved = await resolveInFreshProcess(root)
        const expectsNew = checkpoint === 'current-commit:after'
        assert.equal(
          resolved.generationId,
          expectsNew ? next.layout.generationId : old.layout.generationId,
        )
        assert.equal(resolved.packageBytes, `${expectsNew ? 'new' : 'old'}-dmg\n`)
      })
    }
  }
})

test('forced abort before current commit leaves old current and restart recovery converges', async (t) => {
  const module = await import(moduleURL)
  const root = await createReleaseRoot(t, 'forced-abort')
  const current = await commitFixture(module, root, '8'.repeat(32), 'current')
  const nextLayout = module.createPackagePublicationLayout({
    generationId: '9'.repeat(32),
    releaseRoot: root,
  })
  await stageFixture(nextLayout, 'aborted')
  const childSource = [
    `const module = await import(${JSON.stringify(moduleURL.href)});`,
    `const layout = module.createPackagePublicationLayout(${JSON.stringify({ generationId: nextLayout.generationId, releaseRoot: root })});`,
    'await module.publishPackageGeneration({ layout });',
    "process.kill(process.pid, 'SIGKILL');",
  ].join('\n')

  await assert.rejects(
    execFileAsync(process.execPath, ['--input-type=module', '--eval', childSource], {
      maxBuffer: 64 * 1024,
    }),
    (error) => error.signal === 'SIGKILL',
  )
  const beforeRecovery = await module.resolveCurrentPackageGeneration({
    releaseRoot: root,
    releaseVersion,
    targetTriple,
  })
  assert.equal(beforeRecovery.generationId, current.layout.generationId)

  await module.recoverPackagePublication({ releaseRoot: root })
  await assert.rejects(lstat(nextLayout.publishedGenerationRoot), { code: 'ENOENT' })
  await assert.rejects(lstat(nextLayout.stagingGenerationRoot), { code: 'ENOENT' })
  assert.equal(
    (
      await module.resolveCurrentPackageGeneration({
        releaseRoot: root,
        releaseVersion,
        targetTriple,
      })
    ).generationId,
    current.layout.generationId,
  )
})
