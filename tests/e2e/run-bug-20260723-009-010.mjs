#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const evidenceRoot = path.join(desktopRoot, 'test/evidence/bug-20260723-009-010-current-source')

async function reservePort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('failed to reserve loopback port')
  const port = address.port
  await new Promise((resolve) => server.close(resolve))
  return port
}

const sourcePort = await reservePort()
let referencePort = await reservePort()
while (referencePort === sourcePort) referencePort = await reservePort()
const buildRoot = mkdtempSync(path.join(tmpdir(), 'hexclaw-capability-current-source.'))
chmodSync(buildRoot, 0o700)
const sourceRoot = path.join(buildRoot, 'dist')

try {
  const build = spawnSync(
    'pnpm',
    ['exec', 'vite', 'build', '--outDir', sourceRoot, '--emptyOutDir'],
    {
      cwd: desktopRoot,
      encoding: 'utf8',
      timeout: 120_000,
      env: {
        ...process.env,
        VITE_API_BASE: `http://127.0.0.1:${sourcePort}/_hexclaw`,
        VITE_WS_BASE: `ws://127.0.0.1:${sourcePort}/_hexclaw`,
      },
    },
  )
  assert.equal(build.status, 0, `${build.stdout}${build.stderr}`)

  const native = spawnSync('node', ['tests/native/bug-20260723-009-010-test-app-preflight.mjs'], {
    cwd: desktopRoot,
    encoding: 'utf8',
    timeout: 30_000,
  })
  assert.equal(native.status, 0, `${native.stdout}${native.stderr}`)

  const playwright = spawnSync(
    'pnpm',
    [
      'exec',
      'playwright',
      'test',
      '-c',
      'tests/e2e/bug-20260723-009-010.playwright.config.ts',
      '--workers=1',
    ],
    {
      cwd: desktopRoot,
      encoding: 'utf8',
      timeout: 240_000,
      env: {
        ...process.env,
        HEX_CAPABILITY_SOURCE_ROOT: sourceRoot,
        HEX_CAPABILITY_SOURCE_PORT: String(sourcePort),
        HEX_CAPABILITY_REFERENCE_PORT: String(referencePort),
      },
    },
  )
  process.stdout.write(playwright.stdout)
  process.stderr.write(playwright.stderr)
  assert.equal(playwright.status, 0, 'paired capability evidence collection failed')

  const summary = JSON.parse(readFileSync(path.join(evidenceRoot, 'summary.json'), 'utf8'))
  assert.equal(summary.environment.workers, 1)
  assert.deepEqual(summary.isolation.externalRequests, [])
  assert.equal(summary.fixtureParity.fixture, 'bug-20260723-009-010-homomorphic-v2')
  assert.equal(summary.installedBoundary.fixture, 'bug-20260723-009-010-homomorphic-v2')
  assert.equal(summary.installedBoundary.status, 'NOT_RUN')
  assert.equal(summary.installedBoundary.decision, 'NOT COMPARABLE')
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
} finally {
  rmSync(buildRoot, { recursive: true })
}
