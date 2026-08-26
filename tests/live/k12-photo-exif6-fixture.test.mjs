import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)
const LIVE_ROOT = dirname(fileURLToPath(import.meta.url))
const DESKTOP_ROOT = resolve(LIVE_ROOT, '../..')
const SOURCE_PATH = resolve(DESKTOP_ROOT, '../hexclaw-docs/test/k12-test-批改作业.png')
const HELPER_PATH = resolve(LIVE_ROOT, 'k12-photo-exif6-fixture.go')
const CONTRACT_PATH = resolve(LIVE_ROOT, 'k12-dingtalk-photo-grading-headless.contract.json')
const modulePromise = import('./k12-dingtalk-photo-grading-headless.mjs')

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

test('EXIF6 fixture is derived from the frozen clear worksheet instead of a synthetic image', async () => {
  const { parseJPEGExifOrientation } = await modulePromise
  const temporary = await mkdtemp(join(tmpdir(), 'hexclaw-exif6-fixture-test-'))
  const rawPath = join(temporary, 'worksheet-exif6.jpg')
  const canonicalPath = `${rawPath}.canonical.png`
  try {
    const source = await readFile(SOURCE_PATH)
    const commandEnvironment = { ...process.env }
    try {
      if ((await lstat('/opt/homebrew/opt/go/libexec')).isDirectory()) {
        commandEnvironment.GOROOT = '/opt/homebrew/opt/go/libexec'
      }
    } catch {
      // 非 Homebrew Go 环境继承调用者的 GOROOT。
    }
    commandEnvironment.GOCACHE = join(temporary, 'go-cache')
    const executed = await execFile(
      'go',
      [
        'run',
        HELPER_PATH,
        '--source',
        SOURCE_PATH,
        '--raw',
        rawPath,
        '--canonical',
        canonicalPath,
      ],
      { cwd: DESKTOP_ROOT, env: commandEnvironment, timeout: 60_000, maxBuffer: 1 << 20 },
    )
    const manifest = JSON.parse(executed.stdout)
    const raw = await readFile(rawPath)
    const canonical = await readFile(canonicalPath)

    assert.equal(manifest.source_sha256, sha256(source))
    assert.equal(manifest.source_size_bytes, source.length)
    assert.equal(manifest.source_width, 1086)
    assert.equal(manifest.source_height, 1448)
    assert.equal(manifest.encoded_width, 1448)
    assert.equal(manifest.encoded_height, 1086)
    assert.equal(manifest.canonical_width, 1086)
    assert.equal(manifest.canonical_height, 1448)
    assert.equal(manifest.raw_sha256, sha256(raw))
    assert.equal(manifest.canonical_sha256, sha256(canonical))
    assert.equal(parseJPEGExifOrientation(raw), 6)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})

test('EXIF6 annotation geometry uses the independent canonical PNG as its pixel baseline', async () => {
  const { annotationGeometryBaseline } = await modulePromise
  assert.equal(typeof annotationGeometryBaseline, 'function')
  const rawPath = '/private/tmp/photo-exif6.jpg'
  const fixture = {
    mime: 'image/jpeg',
    encoded_width: 1448,
    encoded_height: 1086,
    display_width: 1086,
    display_height: 1448,
    canonical: {
      mime: 'image/png',
      sha256: 'a'.repeat(64),
      size_bytes: 123,
      width: 1086,
      height: 1448,
    },
  }

  assert.deepEqual(annotationGeometryBaseline(rawPath, fixture, 'exif6'), {
    path: `${rawPath}.canonical.png`,
    mime: 'image/png',
    sha256: 'a'.repeat(64),
    size_bytes: 123,
    width: 1086,
    height: 1448,
  })
})

test('EXIF6 contract rejects a derived source identity that is not the frozen clear worksheet', async () => {
  const { validateContract } = await modulePromise
  const contract = JSON.parse(await readFile(CONTRACT_PATH, 'utf8'))
  contract.fixtures.exif6.derivation.source_sha256 = 'b'.repeat(64)
  assert.throws(() => validateContract(contract), /EXIF_DERIVATION_CONTRACT_INVALID/u)
})
