import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  assertSidecarVersion,
  extractEmbeddedVersion,
  normalizeReleaseVersion,
} from '../../scripts/ci/verify-sidecar-version.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

async function readRepoFile(path) {
  return readFile(resolve(repoRoot, path), 'utf8')
}

function hostTriple() {
  return execFileSync('rustc', ['-vV'], { encoding: 'utf8' }).match(/^host:\s+(.+)$/m)?.[1]
}

test('sidecar release version parser is fail-closed and normalizes one optional leading v', () => {
  assert.equal(normalizeReleaseVersion('0.5.0-beta'), '0.5.0-beta')
  assert.equal(normalizeReleaseVersion('v0.5.0-beta'), '0.5.0-beta')
  assert.equal(normalizeReleaseVersion('vv0.5.0-beta'), 'v0.5.0-beta')

  const metadata = 'build\t-ldflags="-s -w -X main.version=0.5.0-beta -X main.commit=abc123"'
  assert.equal(extractEmbeddedVersion(metadata), '0.5.0-beta')
  assert.equal(assertSidecarVersion(metadata, 'v0.5.0-beta'), '0.5.0-beta')
  assert.throws(() => extractEmbeddedVersion('build\t-compiler=gc'), /found 0/)
  assert.throws(
    () =>
      extractEmbeddedVersion(
        'build\t-ldflags="-X main.version=0.5.0-beta -X main.version=other"',
      ),
    /found 2/,
  )
  assert.throws(() => assertSidecarVersion(metadata, '0.5.1'), /must match/)
})

test('currently staged sidecar embeds the canonical Tauri release version', async () => {
  const tauriConfig = JSON.parse(await readRepoFile('src-tauri/tauri.conf.json'))
  const triple = hostTriple()
  assert.ok(triple, 'rustc host triple must be available')
  const binaryPath = resolve(repoRoot, 'src-tauri/binaries', `hexclaw-${triple}`)
  assert.ok(existsSync(binaryPath), `staged sidecar must exist at ${binaryPath}`)
  const metadata = execFileSync('go', ['version', '-m', binaryPath], { encoding: 'utf8' })
  assert.equal(assertSidecarVersion(metadata, tauriConfig.version), tauriConfig.version)
})

test('all local and CI sidecar build paths inject Desktop version and verify before bundling', async () => {
  const [makefile, packageWorkflow, releaseWorkflow] = await Promise.all([
    readRepoFile('Makefile'),
    readRepoFile('.github/workflows/package.yml'),
    readRepoFile('.github/workflows/release.yml'),
  ])

  assert.match(
    makefile,
    /SIDECAR_RELEASE_VERSION\s*:=\s*\$\(patsubst v%,%,\$\(DESKTOP_VERSION\)\)/,
  )
  assert.doesNotMatch(makefile, /VERSION="\$\$\(git describe --tags --always --dirty/)
  assert.match(
    makefile,
    /verify-sidecar-version\.mjs\s+"\$\(SIDECAR_BIN_DIR\)\/hexclaw-\$\(HOST_TRIPLE\)"/,
  )
  assert.doesNotMatch(
    makefile,
    /verify-sidecar-version\.mjs[^\n]*SIDECAR_RELEASE_VERSION/,
  )
  assert.ok(
    makefile.indexOf('verify-sidecar-version.mjs') <
      makefile.indexOf('pnpm tauri build --config'),
    'local sidecar version gate must execute before Tauri bundling',
  )

  for (const workflow of [packageWorkflow, releaseWorkflow]) {
    assert.doesNotMatch(workflow, /VERSION="\$\(git describe --tags --always --dirty/)
    assert.match(
      workflow,
      /DESKTOP_VERSION="\$\(node -p "require\('\.\/package\.json'\)\.version\.replace\(\/\^v\/, ''\)"\)"/,
    )
    assert.match(workflow, /verify-sidecar-version\.mjs/)
    assert.doesNotMatch(workflow, /verify-sidecar-version\.mjs[^\n]*DESKTOP_VERSION/)
    assert.ok(
      workflow.indexOf('verify-sidecar-version.mjs') < workflow.indexOf('tauri-apps/tauri-action'),
      'CI sidecar version gate must execute before Tauri bundling',
    )
  }
})
