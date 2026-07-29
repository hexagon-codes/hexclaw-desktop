import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import {
  syntheticGradingBudget,
  syntheticGradingCalibrationApproval,
  syntheticGradingCalibrationBytes,
} from './helpers/k12-grading-calibration-synthetic.mjs'

const repoFile = (path) => new URL(`../../${path}`, import.meta.url)

async function loadOrchestrator() {
  return import(repoFile('scripts/ci/k12-current-bug-fixture-orchestrator.mjs'))
}

function sha256(raw) {
  return createHash('sha256').update(raw).digest('hex')
}

function sidecarConfigRaw() {
  const budget = syntheticGradingBudget()
  return `server:
  host: 127.0.0.1
  port: 16129
k12:
  grading_budget:
    policy_version: ${budget.policy_version}
    queued_seconds: ${budget.queued_seconds}
    normalizing_seconds: ${budget.normalizing_seconds}
    recognizing_seconds: ${budget.recognizing_seconds}
    locating_seconds: ${budget.locating_seconds}
    rendering_seconds: ${budget.rendering_seconds}
    projecting_seconds: ${budget.projecting_seconds}
    assessing_buckets:
${budget.assessing_buckets
  .map(
    ({ max_problems: maxProblems, seconds }) =>
      `      - max_problems: ${maxProblems}\n        seconds: ${seconds}`,
  )
  .join('\n')}
    item_concurrency: ${budget.item_concurrency}
`
}

function releaseAttestation(overrides = {}) {
  return {
    schema_version: 1,
    release_version: '0.5.0-beta',
    package_file: '/tmp/HexClaw.dmg',
    package_sha256: '1'.repeat(64),
    sidecar_file: '/Applications/HexClaw.app/Contents/MacOS/hexclaw',
    sidecar_sha256: 'a'.repeat(64),
    installed_app_file: '/Applications/HexClaw.app',
    installed_app_sha256: 'e'.repeat(64),
    dist_manifest_file: '/tmp/dist-manifest.json',
    dist_manifest_sha256: '2'.repeat(64),
    dist_file_count: 10,
    dist_total_bytes: 100,
    ...overrides,
  }
}

function runtimeFiles(t, { replacedDiskBytes = false } = {}) {
  const directory = mkdtempSync('/tmp/hexclaw-controller-runtime-')
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const paths = {
    controller: join(directory, 'controller.json'),
    attestation: join(directory, 'release-attestation.json'),
    sidecar: join(directory, 'sidecar.yaml'),
  }
  const sidecarRaw = sidecarConfigRaw()
  const attestationRaw = JSON.stringify(releaseAttestation())
  const controller = {
    schema_version: 2,
    sidecar_url: 'http://127.0.0.1:16129',
    release_ui_url: 'http://localhost:16060',
    release_attestation_path: paths.attestation,
    release_attestation_sha256: sha256(attestationRaw),
    expected_version: '0.5.0-beta',
    binary_sha256: 'a'.repeat(64),
    sidecar_config_path: paths.sidecar,
    sidecar_config_sha256: sha256(sidecarRaw),
  }
  const controllerRaw = JSON.stringify(controller)
  const diskAttestationRaw = replacedDiskBytes
    ? JSON.stringify(releaseAttestation({ package_sha256: '9'.repeat(64) }))
    : attestationRaw
  const diskSidecarRaw = replacedDiskBytes ? `${sidecarRaw}# replaced after SHA\n` : sidecarRaw
  const diskControllerRaw = replacedDiskBytes ? `${controllerRaw}\n ` : controllerRaw
  writeFileSync(paths.controller, diskControllerRaw, { mode: 0o600 })
  writeFileSync(paths.attestation, diskAttestationRaw, { mode: 0o600 })
  writeFileSync(paths.sidecar, diskSidecarRaw, { mode: 0o600 })
  return {
    directory,
    paths,
    controller,
    controllerRaw,
    attestationRaw,
    sidecarRaw,
  }
}

function runtimeCase(files) {
  const calibrationBytes = syntheticGradingCalibrationBytes({
    sidecar_config_sha256: files.controller.sidecar_config_sha256,
  })
  const calibrationSHA256 = sha256(calibrationBytes)
  const env = {
    HEXCLAW_LOCAL_SRC: '/work/hexclaw',
    HEX_K12_LIVE_FIXTURE_PROFILE: '/tmp/hexclaw-attested-runtime/profile',
    HEX_K12_LIVE_FIXTURE_STORE: '/tmp/hexclaw-attested-runtime/profile/.hexclaw/data.db',
    HEX_K12_LIVE_FIXTURE_MANIFEST: '/tmp/hexclaw-attested-runtime/profile/fixture.json',
    HEX_K12_LIVE_SIDECAR_CONTROL: '/opt/hexclaw-test/sidecar-control',
    HEX_K12_LIVE_SIDECAR_CONTROL_SHA256: 'f'.repeat(64),
    HEX_K12_LIVE_SIDECAR_CONTROL_CONFIG: files.paths.controller,
    HEX_K12_LIVE_GRADING_CALIBRATION_ARTIFACT: '/tmp/hexclaw-attested-runtime/calibration.json',
    HEX_K12_LIVE_GRADING_CALIBRATION_SHA256: calibrationSHA256,
    HEX_K12_LIVE_APP_URL: 'http://localhost:16060',
    HEX_K12_LIVE_SIDECAR_URL: 'http://127.0.0.1:16129',
    HEX_K12_LIVE_APP_SHA256: 'e'.repeat(64),
  }
  const directories = new Set([env.HEXCLAW_LOCAL_SRC, env.HEX_K12_LIVE_FIXTURE_PROFILE])
  const attestedPaths = new Set(Object.values(files.paths))
  const reads = {
    controller: 0,
    attestation: 0,
    sidecar: 0,
    legacyTargetHash: 0,
  }
  const adapters = {
    inspectPath: (path) => ({
      kind: directories.has(path)
        ? 'directory'
        : path === env.HEX_K12_LIVE_FIXTURE_MANIFEST
          ? 'missing'
          : 'file',
      canonicalPath: attestedPaths.has(path) ? path : path.replace(/^\/tmp\//, '/private/tmp/'),
      executable: path === env.HEX_K12_LIVE_SIDECAR_CONTROL,
      mode: path === env.HEX_K12_LIVE_FIXTURE_PROFILE ? 0o700 : 0o600,
    }),
    fileSHA256: (path) => {
      if (path === files.paths.attestation) {
        reads.legacyTargetHash += 1
        return files.controller.release_attestation_sha256
      }
      if (path === files.paths.sidecar) {
        reads.legacyTargetHash += 1
        return files.controller.sidecar_config_sha256
      }
      return env.HEX_K12_LIVE_SIDECAR_CONTROL_SHA256
    },
    readControllerConfigBytes: () => {
      reads.controller += 1
      return Buffer.from(files.controllerRaw)
    },
    readReleaseAttestationBytes: () => {
      reads.attestation += 1
      return Buffer.from(files.attestationRaw)
    },
    readSidecarConfigBytes: () => {
      reads.sidecar += 1
      return Buffer.from(files.sidecarRaw)
    },
    readGradingCalibrationBytes: () => calibrationBytes,
    gradingCalibrationApproval: syntheticGradingCalibrationApproval({
      artifact_sha256: calibrationSHA256,
      release_config_sha256: files.controller.sidecar_config_sha256,
    }),
  }
  return { adapters, env, reads }
}

test('controller runtime hashes and parses one byte snapshot for every direct trusted input', async (t) => {
  const { validateFixtureEnvironment } = await loadOrchestrator()
  const files = runtimeFiles(t, { replacedDiskBytes: true })
  const { adapters, env, reads } = runtimeCase(files)

  validateFixtureEnvironment(env, adapters)

  assert.deepEqual(reads, {
    controller: 1,
    attestation: 1,
    sidecar: 1,
    legacyTargetHash: 0,
  })
})

test('controller runtime rejects duplicate keys in controller, attestation and Sidecar snapshots', async (t) => {
  const { validateFixtureEnvironment } = await loadOrchestrator()
  const files = runtimeFiles(t)
  const duplicateSnapshots = [
    {
      reader: 'readControllerConfigBytes',
      raw: files.controllerRaw.replace(
        '"sidecar_url":"http://127.0.0.1:16129"',
        '"sidecar_url":"http://127.0.0.1:19999","sidecar_url":"http://127.0.0.1:16129"',
      ),
    },
    {
      reader: 'readReleaseAttestationBytes',
      raw: files.attestationRaw.replace(
        `"package_sha256":"${'1'.repeat(64)}"`,
        `"package_sha256":"${'9'.repeat(64)}","package_sha256":"${'1'.repeat(64)}"`,
      ),
    },
    {
      reader: 'readSidecarConfigBytes',
      raw: files.sidecarRaw.replace(
        '    recognizing_seconds: 13',
        '    recognizing_seconds: 99\n    recognizing_seconds: 13',
      ),
    },
  ]

  for (const { reader, raw } of duplicateSnapshots) {
    const { adapters, env } = runtimeCase(files)
    adapters[reader] = () => Buffer.from(raw)
    assert.throws(() => validateFixtureEnvironment(env, adapters), /duplicate/i)
  }
})

test('controller runtime rechecks symlink and 0600 identity on every opened trusted input', async (t) => {
  const { validateFixtureEnvironment } = await loadOrchestrator()
  const targets = [
    ['controller', 'readControllerConfigBytes', (files) => files.controllerRaw],
    ['attestation', 'readReleaseAttestationBytes', (files) => files.attestationRaw],
    ['sidecar', 'readSidecarConfigBytes', (files) => files.sidecarRaw],
  ]

  for (const [target, reader, rawOf] of targets) {
    for (const mutation of ['mode', 'symlink']) {
      await t.test(`${target} ${mutation}`, () => {
        const files = runtimeFiles(t)
        const { adapters, env } = runtimeCase(files)
        const targetPath = files.paths[target]
        delete adapters[reader]
        const inspectPath = adapters.inspectPath
        let mutated = false
        adapters.inspectPath = (path) => {
          const inspected = inspectPath(path)
          if (path === targetPath && !mutated) {
            mutated = true
            if (mutation === 'mode') {
              chmodSync(targetPath, 0o644)
            } else {
              const replacement = join(files.directory, `${target}-replacement`)
              writeFileSync(replacement, rawOf(files), { mode: 0o600 })
              unlinkSync(targetPath)
              symlinkSync(replacement, targetPath)
            }
          }
          return inspected
        }

        assert.throws(() => validateFixtureEnvironment(env, adapters), /0600|secure/i)
      })
    }
  }
})
