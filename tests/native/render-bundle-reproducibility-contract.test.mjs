import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { promisify } from 'node:util'

const makefileURL = new URL('../../Makefile', import.meta.url)
const scriptURL = new URL('../../release/scripts/render-bundle.sh', import.meta.url)
const versionsURL = new URL('../../release/scripts/versions.json', import.meta.url)
const execFileAsync = promisify(execFile)

test('typst is built from an exact locked source graph with all build roots remapped', async () => {
  const [script, versionsText] = await Promise.all([
    readFile(scriptURL, 'utf8'),
    readFile(versionsURL, 'utf8'),
  ])
  const versions = JSON.parse(versionsText)

  assert.deepEqual(versions.typst.source_build, {
    archive_max_entries: 32,
    cargo_version: '1.94.0',
    cargo_commit: '85eff7c80277b57f78b11e28d14154ab12fcf643',
    cargo_locked: true,
    cargo_lock_sha256: '1205a2c4536bd0ac6e42f2ad07f1e9a28ba35ea44f42dd8a4366c012559884ab',
    crate: 'typst-cli',
    crate_bytes: 61815,
    crate_root: 'typst-cli-0.13.1',
    crate_sha256: 'a634de7356f417bb09250a926714f87be71777c26e1f62ce640ca2f38debb683',
    crate_url: 'https://static.crates.io/crates/typst-cli/typst-cli-0.13.1.crate',
    expanded_bytes_max: 1048576,
    rustc_version: '1.94.0',
    rustc_commit: '4a4ef493e3a1488c6e321570238084b38948f6db',
    source_date_epoch: 1743811200,
    version_requirement: '=0.13.1',
  })
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(versions.typst.platforms).map(([target, value]) => [target, value.sha256]),
    ),
    {
      'darwin-arm64': '541e4f9eaca3f34ee865f81fc663e4839cb84d6253f71a372cd855b0a7283213',
      'darwin-x86_64': '4dabfe647f7f01ed9cc13ad8196a6c7f5e16f0732821b522d50740d3a9f5207b',
      'linux-x86_64': '7d214bfeffc2e585dc422d1a09d2b144969421281e8c7f5d784b65fc69b5673f',
      'windows-x86_64': '44170d0632298ba68cbabc43dbfb6908b17ca9236859e0767b0e5d54b2d19f48',
    },
  )
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(versions.pandoc.platforms).map(([target, value]) => [
        target,
        [value.archive_bytes, value.archive_member, value.binary_bytes],
      ]),
    ),
    {
      'darwin-arm64': [36687858, 'pandoc-3.9.0.2-arm64/bin/pandoc', 187727808],
      'darwin-x86_64': [25764704, 'pandoc-3.9.0.2-x86_64/bin/pandoc', 119823904],
      'linux-x86_64': [34520947, 'pandoc-3.9.0.2/bin/pandoc', 161618224],
      'windows-x86_64': [41250425, 'pandoc-3.9.0.2/pandoc.exe', 231056136],
    },
  )
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(versions.typst.platforms).map(([target, value]) => [
        target,
        [value.archive_bytes, value.archive_member, value.binary_bytes],
      ]),
    ),
    {
      'darwin-arm64': [11034064, 'typst-aarch64-apple-darwin/typst', 33631720],
      'darwin-x86_64': [11789644, 'typst-x86_64-apple-darwin/typst', 35338680],
      'linux-x86_64': [13608296, 'typst-x86_64-unknown-linux-musl/typst', 42134240],
      'windows-x86_64': [17259573, 'typst-x86_64-pc-windows-msvc/typst.exe', 38361088],
    },
  )
  assert.match(script, /build_typst_from_source\(\)/)
  assert.match(script, /stage_prebuilt_engine typst/)
  assert.match(script, /"\$cargo_bin" fetch/)
  assert.match(script, /"\$cargo_bin" install/)
  assert.match(script, /--path "\$source_root"/)
  assert.match(script, /--locked/)
  assert.match(script, /--offline/)
  assert.match(script, /"\$ENV_BIN" -i/)
  assert.match(script, /CARGO_HOME="\$private_cargo_home"/)
  assert.match(script, /SOURCE_DATE_EPOCH="\$source_date_epoch"/)
  assert.match(script, /GIT_CEILING_DIRECTORIES="\$WORK_ROOT"/)
  assert.match(script, /verify-rust-source-root/)
  assert.match(script, /binary-architecture\.mjs/)
  assert.match(script, /typst \$expected_version \(unknown hash\)/)
  assert.match(script, /Typst executable architecture verification failed/)
  assert.doesNotMatch(script, /encoded="\$\{CARGO_ENCODED_RUSTFLAGS/)
  assert.match(script, /--remap-path-prefix=.*\/build\/cargo/)
  assert.match(script, /--remap-path-prefix=.*\/build\/home/)
  // WORK_ROOT 位于 REPO_ROOT 内，由 REPO_ROOT remap 覆盖；不得单独 remap，
  // 否则 RUSTFLAGS 每次构建变化导致 typst 全量重编（BUG-20260816-001）。
  assert.doesNotMatch(script, /\$WORK_ROOT=\/build\/render/)
  const homeRemap = script.indexOf('encoded="--remap-path-prefix=$source_home=/build/home"')
  const repositoryRemap = script.indexOf(
    'encoded+="$separator--remap-path-prefix=$REPO_ROOT=/build/hexclaw-desktop"',
  )
  const hostCargoRemap = script.indexOf(
    'encoded+="$separator--remap-path-prefix=$source_home/.cargo=/build/cargo"',
  )
  assert.ok(homeRemap >= 0)
  assert.ok(repositoryRemap > homeRemap)
  assert.ok(hostCargoRemap > repositoryRemap)
  assert.match(script, /tempfile\.mkdtemp/)
  assert.doesNotMatch(script, /(^|[;&|]\s*)mktemp\b/mu)
  assert.match(script, /trap cleanup EXIT/)
  assert.match(script, /--connect-timeout/)
  assert.match(script, /--speed-limit/)
  assert.match(script, /--max-time/)
  assert.match(script, /--proto '=https'/)
  assert.match(script, /--proto-redir '=https'/)
  assert.match(script, /RENDER_BUNDLE_OUTER_RUNNER/)
  assert.match(script, /RENDER_BUNDLE_TOTAL_TIMEOUT_SECONDS/)
  assert.match(script, /RENDER_BUNDLE_NETWORK_TIMEOUT_SECONDS/)
  assert.match(script, /RUSTFLAGS=/)
  assert.match(script, /publish_outputs/)
  assert.match(script, /stage_prebuilt_engine pandoc/)
  assert.doesNotMatch(script, /交叉打包/u)
  assert.doesNotMatch(script, /\bfind\b[\s\S]*\bhead\b/u)
  assert.doesNotMatch(script, /BACKUP_DIR|\/backup/u)
  assert.ok(
    script.indexOf('scan_typst_binary "$built_typst"') <
      script.indexOf('verify_typst_version "$built_typst"'),
    'Typst must be scanned before it is executed',
  )
})

test('source mode rejects a pre-existing generation destination', async (t) => {
  if (process.platform !== 'darwin') {
    t.skip('source mode is native macOS only')
    return
  }
  const root = await mkdtemp(join(tmpdir(), 'hexclaw-render-generation-'))
  const destination = join(root, 'generation')
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(destination)
  const nativeTarget = process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x86_64'

  await assert.rejects(
    execFileAsync('/bin/bash', [fileURLToPath(scriptURL), destination], {
      env: {
        ...process.env,
        RENDER_BUNDLE_MODE: 'source',
        RENDER_BUNDLE_NETWORK_TIMEOUT_SECONDS: '300',
        RENDER_BUNDLE_OUTER_RUNNER: 'bounded-process-v1',
        RENDER_BUNDLE_TARGET: nativeTarget,
        RENDER_BUNDLE_TOTAL_TIMEOUT_SECONDS: '3600',
      },
    }),
    (error) => {
      assert.equal(error.stderr, 'ERROR: source render destination must be absent.\n')
      return true
    },
  )
  assert.deepEqual(await readdir(destination), [])
})

test('source mode fails closed for a non-native target before changing the destination', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hexclaw-render-native-matrix-'))
  const destination = join(root, 'binaries')
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(destination)
  const nonNativeTarget = process.platform === 'win32' ? 'darwin-arm64' : 'windows-x86_64'

  await assert.rejects(
    execFileAsync('/bin/bash', [fileURLToPath(scriptURL), destination], {
      env: {
        ...process.env,
        RENDER_BUNDLE_MODE: 'source',
        RENDER_BUNDLE_TARGET: nonNativeTarget,
      },
    }),
    (error) => {
      assert.match(
        error.stderr,
        /ERROR: source render-bundle mode requires the native macOS target\.|ERROR: source render-bundle mode requires macOS\./,
      )
      return true
    },
  )
  assert.deepEqual(await readdir(destination), [])
})

test('package build scans generation binaries before the expensive Tauri build', async () => {
  const makefile = await readFile(makefileURL, 'utf8')
  const start = makefile.indexOf('build-local:')
  const end = makefile.indexOf('\npackage-local:', start)
  const recipe = makefile.slice(start, end)
  const preflight = recipe.indexOf('package-sensitive-boundary.mjs verify-root')
  const tauriBuild = recipe.indexOf('$(PNPM_BIN) tauri build')

  assert.ok(preflight >= 0)
  assert.ok(tauriBuild > preflight)
  assert.match(recipe, /--root "\$\(SIDECAR_BIN_DIR\)"/)
  assert.match(recipe, /--label generation-binaries/)
})

test('scanner binds any CI provenance exception to pinned artifact digests', async () => {
  const scanner = await readFile(
    new URL('../../scripts/ci/package-sensitive-boundary.mjs', import.meta.url),
    'utf8',
  )

  assert.match(scanner, /OLLAMA_PUBLIC_PROVENANCE_SHA256/u)
  assert.match(scanner, /allowedOllamaProvenance\.has\(sha256/u)
  assert.doesNotMatch(scanner, /replaceAll\(OLLAMA_PUBLIC_BUILD_PROVENANCE, '\/build\/ollama\/'\)/u)
  assert.doesNotMatch(scanner, /c8d4f613159ac9d2d180f64a857df2d37ce008c0f1751fee82352a829af5524d/)
})
