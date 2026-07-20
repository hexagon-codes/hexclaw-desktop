import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const verifyRelease = resolve(repoRoot, 'scripts/ci/verify-release.mjs')

function runVerifyRelease(...args) {
  return spawnSync(process.execPath, [verifyRelease, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
}

test('release check accepts the pnpm argument separator before a valid tag', () => {
  const result = runVerifyRelease('--', 'v0.5.0-beta')

  assert.equal(
    result.status,
    0,
    `release check failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  )
  assert.match(result.stdout, /Release metadata verified for v0\.5\.0-beta\./)
})

test('release check still rejects an invalid tag after the pnpm argument separator', () => {
  const result = runVerifyRelease('--', 'not-a-semver')

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Release tag "not-a-semver" is not a valid SemVer tag/)
})
