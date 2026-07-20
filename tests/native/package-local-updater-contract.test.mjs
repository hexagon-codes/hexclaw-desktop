import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

async function readRepoFile(path) {
  return readFile(resolve(repoRoot, path), 'utf8')
}

test('package-local disables updater artifacts without changing release configuration', async () => {
  const makefile = await readRepoFile('Makefile')
  const localConfig = JSON.parse(await readRepoFile('src-tauri/tauri.package-local.conf.json'))

  assert.match(
    makefile,
    /LOCAL_PACKAGE_TAURI_CONFIG\s*:=\s*\$\(DESKTOP_ROOT\)\/src-tauri\/tauri\.package-local\.conf\.json/,
  )
  assert.match(
    makefile,
    /pnpm tauri build --config "\$\(LOCAL_PACKAGE_TAURI_CONFIG\)" --bundles app/,
  )
  assert.equal(localConfig.bundle.createUpdaterArtifacts, false)
})
