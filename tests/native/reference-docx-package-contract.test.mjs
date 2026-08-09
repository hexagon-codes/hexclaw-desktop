import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const approvedReferenceSHA256 = 'bac3f1f4de7f145d966baeef39ce3a6f6d377c6137a475e602f629fcc7d6c2b2'
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

test('tracked Desktop reference DOCX remains the approved standalone asset', async () => {
  const asset = await readFile(resolve(repoRoot, 'src-tauri/render-assets/reference.docx'))
  const digest = createHash('sha256').update(asset).digest('hex')

  assert.equal(digest, approvedReferenceSHA256)
})

test('sidecar-assets keeps the approved HexClaw-to-Desktop synchronization path', async () => {
  const makefile = await readFile(resolve(repoRoot, 'Makefile'), 'utf8')

  assert.match(
    makefile,
    /cp "\$\(HEXCLAW_BUILD_SRC\)\/render\/assets\/reference\.docx" \$\(DESKTOP_ROOT\)\/src-tauri\/render-assets\/reference\.docx/,
  )
})
