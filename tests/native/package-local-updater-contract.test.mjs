import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

async function readRepoFile(path) {
  return readFile(resolve(repoRoot, path), 'utf8')
}

test('package-local and verifier are thin immutable Node orchestrator entries', async () => {
  const makefile = await readRepoFile('Makefile')
  const localConfig = JSON.parse(await readRepoFile('src-tauri/tauri.package-local.conf.json'))

  assert.match(makefile, /^package-local:\s*$/m)
  const packageStart = makefile.indexOf('package-local:')
  const packageEnd = makefile.indexOf('\nverify-package-local:', packageStart)
  const packageRecipe = makefile.slice(packageStart, packageEnd)
  assert.match(packageRecipe, /\$\(PACKAGE_LOCAL_NODE\) \$\(PACKAGE_LOCAL_ORCHESTRATOR\) build/)
  assert.doesNotMatch(
    packageRecipe,
    /build-local|\$\(MAKE\)|SIDECAR_BIN_DIR|CARGO_TARGET_DIR|generation=/,
  )
  const verifyStart = makefile.indexOf('verify-package-local:')
  const verifyEnd = makefile.indexOf('\n# 仅构建前端', verifyStart)
  const verifyRecipe = makefile.slice(verifyStart, verifyEnd)
  assert.match(verifyRecipe, /\$\(PACKAGE_LOCAL_NODE\) \$\(PACKAGE_LOCAL_ORCHESTRATOR\) verify/)
  assert.doesNotMatch(verifyRecipe, /shasum|expected-receipt|PACKAGE_LOCAL_NOT_BEFORE/)
  assert.equal(localConfig.build.beforeBuildCommand, '')
  assert.equal(localConfig.bundle.createUpdaterArtifacts, false)
})

test('render bundle publishes one fully verified staged pair without an implicit fallback', async () => {
  const script = await readRepoFile('release/scripts/render-bundle.sh')

  assert.match(script, /case "\$\{RENDER_BUNDLE_MODE:-\}" in/)
  assert.match(script, /prebuilt\) render_mode=prebuilt/)
  assert.match(script, /source\) render_mode=source/)
  assert.match(script, /python_helper prepare-source/)
  assert.match(script, /python_helper prepare-prebuilt/)
  assert.match(script, /python_helper "publish-\$render_mode" "\$STAGE_DIR" "\$DEST_DIR"/)
  assert.match(script, /os\.rename\(stage, destination\)/)
  assert.doesNotMatch(script, /find\s+[^\n]+\|\s*head\s+-1/u)
})
