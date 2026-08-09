import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const repoRoot = new URL('../../', import.meta.url)
const workflowPaths = ['.github/workflows/package.yml', '.github/workflows/release.yml']

const expectedMatrix = [
  {
    platform: 'macos-26',
    target: 'aarch64-apple-darwin',
    go_os: 'darwin',
    go_arch: 'arm64',
    sidecar_name: 'hexclaw-aarch64-apple-darwin',
    render_target: 'darwin-arm64',
  },
  {
    platform: 'macos-26',
    target: 'x86_64-apple-darwin',
    go_os: 'darwin',
    go_arch: 'amd64',
    sidecar_name: 'hexclaw-x86_64-apple-darwin',
    render_target: 'darwin-x86_64',
  },
  {
    platform: 'ubuntu-22.04',
    target: 'x86_64-unknown-linux-gnu',
    go_os: 'linux',
    go_arch: 'amd64',
    sidecar_name: 'hexclaw-x86_64-unknown-linux-gnu',
    render_target: 'linux-x86_64',
  },
  {
    platform: 'windows-2025',
    target: 'x86_64-pc-windows-msvc',
    go_os: 'windows',
    go_arch: 'amd64',
    sidecar_name: 'hexclaw-x86_64-pc-windows-msvc.exe',
    render_target: 'windows-x86_64',
  },
]

async function readRepoFile(path) {
  return readFile(new URL(path, repoRoot), 'utf8')
}

function unquote(value) {
  if (
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith('"') && value.endsWith('"'))
  ) {
    return value.slice(1, -1)
  }
  return value
}

function parseBuildMatrix(source) {
  const matrixStart = source.indexOf('      matrix:\n        include:\n')
  assert.notEqual(matrixStart, -1, 'build matrix include block must exist')
  const matrixEnd = source.indexOf('\n\n    runs-on:', matrixStart)
  assert.notEqual(matrixEnd, -1, 'build matrix must end before runs-on')
  const matrixBlock = source.slice(matrixStart, matrixEnd)
  const entryPattern = /          - platform: ([^\n]+)\n([\s\S]*?)(?=\n          - platform:|$)/gu
  const entries = []

  for (const match of matrixBlock.matchAll(entryPattern)) {
    const entry = { platform: unquote(match[1].trim()) }
    for (const field of ['target', 'go_os', 'go_arch', 'sidecar_name', 'render_target']) {
      const fieldMatch = match[2].match(new RegExp(`^            ${field}: (.+)$`, 'mu'))
      assert.ok(fieldMatch, `matrix entry ${entry.platform} must define ${field}`)
      entry[field] = unquote(fieldMatch[1].trim())
    }
    entries.push(entry)
  }

  return entries
}

function namedStep(source, name) {
  const marker = `      - name: ${name}\n`
  const start = source.indexOf(marker)
  assert.notEqual(start, -1, `workflow step must exist: ${name}`)
  const end = source.indexOf('\n      - ', start + marker.length)
  return source.slice(start, end === -1 ? source.length : end)
}

test('the repository pins the Rust 1.94.0 toolchain', async () => {
  const toolchain = await readRepoFile('rust-toolchain.toml')

  assert.match(toolchain, /^\[toolchain\]$/mu)
  assert.match(toolchain, /^channel = "1\.94\.0"$/mu)
  assert.match(toolchain, /^profile = "minimal"$/mu)
  assert.doesNotMatch(toolchain, /channel = "(?:stable|beta|nightly)"/u)
})

test('render-bundle requires one explicit prebuilt or source mode', async () => {
  const script = await readRepoFile('release/scripts/render-bundle.sh')

  assert.equal(
    /\bRENDER_BUNDLE_MODE\b/u.test(script),
    true,
    'render-bundle must read RENDER_BUNDLE_MODE',
  )
  assert.equal(/^\s*prebuilt\)/mu.test(script), true, 'prebuilt mode must be explicit')
  assert.equal(/^\s*source\)/mu.test(script), true, 'source mode must be explicit')
  assert.equal(
    /RENDER_BUNDLE_MODE(?::?[-=])[^}\n]*\b(?:prebuilt|source)\b/u.test(script),
    false,
    'render-bundle must not assign an implicit mode',
  )
  assert.equal(
    /ERROR: [^\n]*RENDER_BUNDLE_MODE[^\n]*/u.test(script),
    true,
    'missing or unknown render mode must fail with an English error',
  )
})

for (const workflowPath of workflowPaths) {
  test(`${workflowPath} freezes the four public package targets`, async () => {
    const workflow = await readRepoFile(workflowPath)
    assert.deepEqual(parseBuildMatrix(workflow), expectedMatrix)
  })

  test(`${workflowPath} installs pinned Rust before staging prebuilt render engines`, async () => {
    const workflow = await readRepoFile(workflowPath)
    const rustStep = namedStep(workflow, 'Install Rust 1.94.0')
    const renderStep = namedStep(workflow, 'Stage prebuilt render engines (pandoc + typst)')

    assert.ok(
      workflow.indexOf(rustStep) < workflow.indexOf(renderStep),
      'pinned Rust must be installed before render staging',
    )
    assert.match(rustStep, /uses: dtolnay\/rust-toolchain@[0-9a-f]{40}(?:\s+#.*)?$/mu)
    assert.match(rustStep, /^          toolchain: '1\.94\.0'$/mu)
    assert.match(rustStep, /^          targets: \$\{\{ matrix\.target \}\}$/mu)

    assert.match(renderStep, /^          RENDER_BUNDLE_MODE: prebuilt$/mu)
    assert.match(
      renderStep,
      /^          RENDER_BUNDLE_TARGET: \$\{\{ matrix\.render_target \}\}$/mu,
    )
    assert.match(
      renderStep,
      /^          \.\/release\/scripts\/render-bundle\.sh src-tauri\/binaries$/mu,
    )
    assert.doesNotMatch(renderStep, /\|\||\bsource\b|fallback|uname/u)
    assert.doesNotMatch(workflow, /RENDER_BUNDLE_MODE:\s*source/u)
    assert.equal(
      workflow.match(/\.\/release\/scripts\/render-bundle\.sh src-tauri\/binaries/gu)?.length,
      1,
      'each public workflow must invoke one explicit render-bundle stage',
    )
  })
}
