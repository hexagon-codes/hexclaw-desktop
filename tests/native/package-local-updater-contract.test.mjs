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
    /build-local package-local:\s+sidecar-local\s+render-bundle/,
    'local packages must stage every externalBin declared by tauri.conf.json',
  )
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

test('render bundle replaces read-only external binaries atomically', async () => {
  const script = await readRepoFile('release/scripts/render-bundle.sh')

  assert.match(script, /local output_name output staged/)
  assert.match(script, /staged="\$DEST_DIR\/\.\$output_name\.tmp\.\$\$"/)
  assert.match(script, /cp "\$found" "\$staged"/)
  assert.match(script, /chmod \+x "\$staged"/)
  assert.match(script, /mv -f "\$staged" "\$output"/)
  assert.doesNotMatch(script, /cp "\$found" "\$DEST_DIR\/\$name-\$triple"/)
})
