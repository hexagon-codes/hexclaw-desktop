import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  syntheticArtifactSHA256,
  syntheticGradingBudget,
  syntheticGradingCalibrationApproval,
  syntheticGradingCalibrationBytes,
  syntheticGradingCalibrationEnvironment,
  syntheticSidecarConfigSHA256,
} from './helpers/k12-grading-calibration-synthetic.mjs'

const repoFile = (path) => new URL(`../../${path}`, import.meta.url)

const requestedManifest = '/tmp/k12-cleanup/profile/fixture-manifest.json'
const canonicalManifest = '/private/tmp/k12-cleanup/profile/fixture-manifest.json'
const canonicalProfile = '/private/tmp/k12-cleanup/profile'
const digest = 'c'.repeat(64)
const execFileAsync = promisify(execFile)
const hexclawSource = fileURLToPath(new URL('../../../hexclaw/', import.meta.url))

async function loadOrchestrator() {
  return import(repoFile('scripts/ci/k12-current-bug-fixture-orchestrator.mjs'))
}

function environment() {
  return {
    HEXCLAW_LOCAL_SRC: '/work/hexclaw',
    HEX_K12_LIVE_FIXTURE_PROFILE: '/tmp/k12-cleanup/profile',
    HEX_K12_LIVE_FIXTURE_STORE: '/tmp/k12-cleanup/profile/.hexclaw/data.db',
    HEX_K12_LIVE_FIXTURE_MANIFEST: requestedManifest,
    HEX_K12_LIVE_SIDECAR_CONTROL:
      '/work/hexclaw-desktop/scripts/ci/k12-current-bug-isolated-sidecar-control.mjs',
    HEX_K12_LIVE_SIDECAR_CONTROL_SHA256: 'a'.repeat(64),
    HEX_K12_LIVE_SIDECAR_CONTROL_CONFIG: '/tmp/k12-cleanup/controller.json',
    ...syntheticGradingCalibrationEnvironment('/tmp/k12-cleanup/grading-calibration.json'),
    HEX_K12_LIVE_APP_URL: 'http://localhost:16060',
    HEX_K12_LIVE_SIDECAR_URL: 'http://127.0.0.1:16129',
    HEX_K12_LIVE_APP_SHA256: 'e'.repeat(64),
    HEX_K12_REAL_10X_RUN_ID: 'opaque-run',
  }
}

function environmentAdapters(env = environment()) {
  const directories = new Set([env.HEXCLAW_LOCAL_SRC, env.HEX_K12_LIVE_FIXTURE_PROFILE])
  const modes = {
    [env.HEXCLAW_LOCAL_SRC]: 0o755,
    [env.HEX_K12_LIVE_FIXTURE_PROFILE]: 0o700,
    [env.HEX_K12_LIVE_FIXTURE_STORE]: 0o600,
    [env.HEX_K12_LIVE_SIDECAR_CONTROL]: 0o755,
    [env.HEX_K12_LIVE_SIDECAR_CONTROL_CONFIG]: 0o600,
    [env.HEX_K12_LIVE_GRADING_CALIBRATION_ARTIFACT]: 0o600,
  }
  return {
    inspectPath: (path) => ({
      kind:
        path === env.HEX_K12_LIVE_FIXTURE_MANIFEST
          ? 'missing'
          : directories.has(path)
            ? 'directory'
            : 'file',
      canonicalPath: path.replace(/^\/tmp\//, '/private/tmp/'),
      mode: modes[path],
      executable: path === env.HEX_K12_LIVE_SIDECAR_CONTROL,
      symlink: false,
    }),
    fileSHA256: (path) =>
      path.endsWith('/grading-calibration.json')
        ? syntheticArtifactSHA256
        : env.HEX_K12_LIVE_SIDECAR_CONTROL_SHA256,
    readControllerRuntimeContract: () => ({
      releaseUIURL: env.HEX_K12_LIVE_APP_URL,
      sidecarURL: env.HEX_K12_LIVE_SIDECAR_URL,
      installedAppSHA256: env.HEX_K12_LIVE_APP_SHA256,
      gradingBudget: syntheticGradingBudget(),
      sidecarConfigSHA256: syntheticSidecarConfigSHA256,
    }),
    readGradingCalibrationBytes: () => syntheticGradingCalibrationBytes(),
    gradingCalibrationApproval: syntheticGradingCalibrationApproval(),
  }
}

test('cleanup contract freezes canonical receipt and child-nonzero deletion invariants', async () => {
  const contract = JSON.parse(
    await readFile(
      repoFile('tests/live/k12-current-bug-fixture-orchestrator.contract.json'),
      'utf8',
    ),
  )
  assert.deepEqual(contract.manifestCleanup, {
    order: [
      'fixture_cleanup_attempt',
      'manifest_receipt',
      'canonical_unlink',
      'alias_absence_verify',
    ],
    receiptExactFields: [
      'schema_version',
      'existed',
      'mode',
      'sha256',
      'canonical_alias_equal',
      'removed',
    ],
    deleteAfterFixtureCleanupNonzero: true,
    preserveRootError: true,
    printManifestValues: false,
  })
})

test('missing target keeps requested alias but derives one canonical manifest path', async () => {
  const { validateFixtureEnvironment } = await loadOrchestrator()
  const env = environment()
  const config = validateFixtureEnvironment(env, environmentAdapters(env))
  assert.equal(config.manifestRequestedPath, requestedManifest)
  assert.equal(config.manifestPath, canonicalManifest)
  assert.equal(config.profilePath, canonicalProfile)
})

test('safe cleanup hashes 0600 canonical target, unlinks once and verifies both aliases absent', async () => {
  const { removeCanonicalManifest } = await loadOrchestrator()
  let removed = false
  const events = []
  const receipt = await removeCanonicalManifest(
    {
      profilePath: canonicalProfile,
      manifestRequestedPath: requestedManifest,
      manifestPath: canonicalManifest,
    },
    {
      inspectPath: (path) => {
        events.push(['inspect', path])
        if (removed) return { exists: false }
        return {
          exists: true,
          symlink: false,
          regularFile: true,
          mode: 0o600,
          canonicalPath: canonicalManifest,
        }
      },
      fileSHA256: (path) => {
        events.push(['hash', path])
        return digest
      },
      unlinkFile: (path) => {
        events.push(['unlink', path])
        removed = true
      },
    },
  )

  assert.deepEqual(receipt, {
    schema_version: 1,
    existed: true,
    mode: '0600',
    sha256: digest,
    canonical_alias_equal: true,
    removed: true,
  })
  assert.deepEqual(
    events.filter(([event]) => event === 'unlink'),
    [['unlink', canonicalManifest]],
  )
  assert.equal(JSON.stringify(receipt).includes('opaque'), false)
  assert.equal(JSON.stringify(receipt).includes(requestedManifest), false)
})

test('browser and fixture-cleanup nonzero retain browser root while cleanup remains single-flight', async () => {
  const { createFixtureCleanup, runFixtureLifecycle } = await loadOrchestrator()
  const events = []
  const browserRoot = new Error('browser launch failed')
  const fixtureCleanupError = new Error('fixture subprocess failed')
  const receipt = {
    schema_version: 1,
    existed: true,
    mode: '0600',
    sha256: digest,
    canonical_alias_equal: true,
    removed: true,
  }
  const cleanup = createFixtureCleanup(
    {},
    {
      cleanupFixtureRecords: async () => {
        events.push('fixture_cleanup_attempt')
        throw fixtureCleanupError
      },
      removeManifest: async () => {
        events.push('canonical_unlink')
        return receipt
      },
      emitReceipt: (value) => {
        events.push(['receipt', value])
      },
    },
  )

  await assert.rejects(
    () =>
      runFixtureLifecycle(
        {},
        {
          stopSidecar: async () => events.push('sidecar_stop'),
          startFixture: async () => events.push('fixture_start'),
          readManifest: async () => ({
            retryableDispatchID: 'opaque-retryable',
            outcomeUnknownDispatchID: 'opaque-unknown',
          }),
          startSidecar: async () => events.push('sidecar_start'),
          runStrictGate: async () => {
            events.push('strict_child_nonzero')
            throw browserRoot
          },
          cleanupFixture: cleanup,
        },
      ),
    (error) => error === browserRoot,
  )
  await assert.rejects(
    () => Promise.all([cleanup(), cleanup()]),
    (error) => error === fixtureCleanupError,
  )

  assert.equal(events.filter((event) => event === 'fixture_cleanup_attempt').length, 1)
  assert.equal(events.filter((event) => event === 'canonical_unlink').length, 1)
  assert.equal(events.filter((event) => Array.isArray(event) && event[0] === 'receipt').length, 1)
})

test('unsafe manifest identity or permissions fail closed without unlink', async () => {
  const { removeCanonicalManifest } = await loadOrchestrator()
  for (const unsafe of [
    { symlink: true },
    { mode: 0o644 },
    { regularFile: false },
    { canonicalPath: '/private/tmp/outside/fixture-manifest.json' },
  ]) {
    let unlinked = false
    await assert.rejects(() =>
      removeCanonicalManifest(
        {
          profilePath: canonicalProfile,
          manifestRequestedPath: requestedManifest,
          manifestPath: canonicalManifest,
        },
        {
          inspectPath: () => ({
            exists: true,
            symlink: false,
            regularFile: true,
            mode: 0o600,
            canonicalPath: canonicalManifest,
            ...unsafe,
          }),
          fileSHA256: () => digest,
          unlinkFile: () => {
            unlinked = true
          },
        },
      ),
    )
    assert.equal(unlinked, false)
  }
})

test(
  'real Go fixture process removes canonical manifest after a pre-model child failure and permits the next run',
  { timeout: 120_000 },
  async (t) => {
    const {
      createFixtureCleanup,
      readOpaqueManifest,
      removeCanonicalManifest,
      runFixtureLifecycle,
    } = await loadOrchestrator()
    const requestedProfile = await mkdtemp('/tmp/hexclaw-k12-manifest-cleanup-')
    await chmod(requestedProfile, 0o700)
    t.after(async () => rm(requestedProfile, { recursive: true, force: true }))

    const profilePath = await realpath(requestedProfile)
    const privateDirectory = join(profilePath, '.hexclaw')
    const storePath = join(privateDirectory, 'data.db')
    const manifestRequestedPath = join(requestedProfile, 'fixture-manifest.json')
    const manifestPath = join(profilePath, 'fixture-manifest.json')
    await mkdir(privateDirectory, { mode: 0o700 })
    await writeFile(storePath, '', { mode: 0o600 })
    await chmod(storePath, 0o600)

    const outputs = []
    const subprocessEnvironment = Object.fromEntries(
      [
        'HOME',
        'PATH',
        'TMPDIR',
        'GOCACHE',
        'GOMODCACHE',
        'GOPATH',
        'GOPROXY',
        'GOSUMDB',
        'CGO_ENABLED',
        'SSL_CERT_FILE',
        'SSL_CERT_DIR',
      ]
        .filter((name) => process.env[name] !== undefined)
        .map((name) => [name, process.env[name]]),
    )
    subprocessEnvironment.DINGTALK_LIVE_SEND = '0'

    const runBuilder = async (action, cycle) => {
      const args = [
        'run',
        '-tags',
        'testtools',
        './cmd/k12-live-fixture-testtools',
        action,
        '--profile',
        profilePath,
        '--store',
        storePath,
        '--manifest',
        manifestPath,
      ]
      if (action === 'start') {
        args.push(
          '--run-id',
          `manifest-cleanup-real-${cycle}`,
          '--learner',
          `learner-${cycle}`,
          '--provider',
          'hexclaw-gpt',
          '--model',
          'gpt-5.6-sol',
          '--lease',
          '30m',
        )
      }
      const result = await execFileAsync('go', args, {
        cwd: hexclawSource,
        env: subprocessEnvironment,
        maxBuffer: 1024 * 1024,
      })
      outputs.push({ action, stdout: result.stdout.trim(), stderr: result.stderr.trim() })
      return result
    }

    const assertManifestAbsent = async () => {
      for (const pathname of new Set([manifestRequestedPath, manifestPath])) {
        await assert.rejects(
          () => access(pathname, fsConstants.F_OK),
          (error) => error?.code === 'ENOENT',
        )
      }
    }

    const runFailedCycle = async (cycle) => {
      const receipts = []
      let childFailure
      const config = {
        localSource: hexclawSource,
        profilePath,
        storePath,
        manifestRequestedPath,
        manifestPath,
        runID: `manifest-cleanup-real-${cycle}`,
        learnerID: `learner-${cycle}`,
        provider: 'hexclaw-gpt',
        model: 'gpt-5.6-sol',
      }
      const cleanup = createFixtureCleanup(config, {
        cleanupFixtureRecords: () => runBuilder('cleanup', cycle),
        removeManifest: () => removeCanonicalManifest(config),
        emitReceipt: (receipt) => receipts.push(receipt),
      })
      let manifestIDs

      await assert.rejects(
        () =>
          runFixtureLifecycle(config, {
            stopSidecar: async () => undefined,
            startFixture: () => runBuilder('start', cycle),
            readManifest: async () => {
              const manifestStat = await stat(manifestPath)
              manifestIDs = readOpaqueManifest(await readFile(manifestPath), {
                regularFile: manifestStat.isFile(),
                mode: manifestStat.mode & 0o777,
                manifestPath,
                profilePath,
              })
              return manifestIDs
            },
            startSidecar: async () => undefined,
            runStrictGate: async () => {
              try {
                await execFileAsync(process.execPath, ['-e', 'process.exit(17)'], {
                  env: subprocessEnvironment,
                })
              } catch (error) {
                childFailure = error
                throw error
              }
            },
            cleanupFixture: cleanup,
          }),
        (error) => error === childFailure && error?.code === 17,
      )

      assert.deepEqual(receipts, [
        {
          schema_version: 1,
          existed: true,
          mode: '0600',
          sha256: receipts[0]?.sha256,
          canonical_alias_equal: true,
          removed: true,
        },
      ])
      assert.match(receipts[0].sha256, /^[a-f0-9]{64}$/)
      await assertManifestAbsent()
      return manifestIDs
    }

    const firstIDs = await runFailedCycle(1)
    const secondIDs = await runFailedCycle(2)
    assert.notDeepEqual(firstIDs, secondIDs)

    const startResults = outputs
      .filter(({ action }) => action === 'start')
      .map(({ stdout }) => JSON.parse(stdout.split(/\r?\n/).at(-1)))
    assert.equal(startResults.length, 2)
    assert.deepEqual(
      startResults.map(({ status, boundary_calls: boundaryCalls }) => ({ status, boundaryCalls })),
      [
        {
          status: 'started',
          boundaryCalls: { dingtalk_sends: 0, im_sends: 0, model_calls: 0 },
        },
        {
          status: 'started',
          boundaryCalls: { dingtalk_sends: 0, im_sends: 0, model_calls: 0 },
        },
      ],
    )
    const safeEvidence = JSON.stringify({ outputs, receiptFields: Object.keys({
      schema_version: 1,
      existed: true,
      mode: '0600',
      sha256: digest,
      canonical_alias_equal: true,
      removed: true,
    }).sort() })
    for (const opaqueID of [
      firstIDs.retryableDispatchID,
      firstIDs.outcomeUnknownDispatchID,
      secondIDs.retryableDispatchID,
      secondIDs.outcomeUnknownDispatchID,
    ]) {
      assert.equal(safeEvidence.includes(opaqueID), false)
    }
  },
)

test(
  'installed attested controller removes the real manifest after child nonzero and leaves the second cycle unblocked',
  {
    skip: process.env.HEX_K12_MANIFEST_CLEANUP_INSTALLED !== '1',
    timeout: 120_000,
  },
  async () => {
    const { createFixtureRuntime, runFixtureLifecycle } = await loadOrchestrator()
    const requiredEnvironment = [
      'HEXCLAW_LOCAL_SRC',
      'HEX_K12_LIVE_FIXTURE_PROFILE',
      'HEX_K12_LIVE_FIXTURE_STORE',
      'HEX_K12_LIVE_FIXTURE_MANIFEST',
      'HEX_K12_LIVE_SIDECAR_CONTROL',
      'HEX_K12_LIVE_SIDECAR_CONTROL_CONFIG',
      'HEX_K12_LIVE_APP_URL',
      'HEX_K12_LIVE_SIDECAR_URL',
    ]
    for (const name of requiredEnvironment) {
      assert.ok(process.env[name]?.trim(), `${name} is required for installed cleanup evidence`)
    }

    const profilePath = await realpath(process.env.HEX_K12_LIVE_FIXTURE_PROFILE)
    const manifestRequestedPath = process.env.HEX_K12_LIVE_FIXTURE_MANIFEST
    const manifestPath = join(profilePath, manifestRequestedPath.split('/').at(-1))
    const common = {
      localSource: await realpath(process.env.HEXCLAW_LOCAL_SRC),
      profilePath,
      storePath: await realpath(process.env.HEX_K12_LIVE_FIXTURE_STORE),
      manifestRequestedPath,
      manifestPath,
      controllerPath: await realpath(process.env.HEX_K12_LIVE_SIDECAR_CONTROL),
      controllerConfigPath: await realpath(process.env.HEX_K12_LIVE_SIDECAR_CONTROL_CONFIG),
      provider: 'hexclaw-gpt',
      model: 'gpt-5.6-sol',
    }

    for (const cycle of [1, 2]) {
      const config = {
        ...common,
        runID: `installed-manifest-cleanup-${cycle}`,
        learnerID: `installed-learner-${cycle}`,
      }
      const runtime = createFixtureRuntime(config)
      let childFailure
      await assert.rejects(
        () =>
          runFixtureLifecycle(config, {
            ...runtime,
            runStrictGate: async () => {
              try {
                await execFileAsync(process.execPath, ['-e', 'process.exit(17)'])
              } catch (error) {
                childFailure = error
                throw error
              }
            },
          }),
        (error) => error === childFailure && error?.code === 17,
      )
      for (const pathname of new Set([manifestRequestedPath, manifestPath])) {
        await assert.rejects(
          () => access(pathname, fsConstants.F_OK),
          (error) => error?.code === 'ENOENT',
        )
      }
      for (const pathname of [
        join(profilePath, '.hexclaw', '.k12-sidecar.pid'),
        join(profilePath, '.hexclaw', '.sidecar.lock'),
      ]) {
        await assert.rejects(
          () => access(pathname, fsConstants.F_OK),
          (error) => error?.code === 'ENOENT',
        )
      }
      const stoppedHealth = await fetch(`${process.env.HEX_K12_LIVE_SIDECAR_URL}/health`).catch(
        () => undefined,
      )
      assert.equal(stoppedHealth, undefined)
    }

    const releaseUI = await fetch(process.env.HEX_K12_LIVE_APP_URL)
    assert.equal(releaseUI.status, 200)
  },
)
