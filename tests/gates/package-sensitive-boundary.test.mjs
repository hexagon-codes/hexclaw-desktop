import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const boundaryModuleURL = new URL(
  '../../scripts/ci/package-sensitive-boundary.mjs',
  import.meta.url,
)
const execFileAsync = promisify(execFile)

async function loadBoundary() {
  const module = await import(boundaryModuleURL).catch(() => ({}))
  assert.equal(
    typeof module.verifyPackageSensitiveBoundary,
    'function',
    'package-sensitive boundary must expose one reusable verifier',
  )
  return module.verifyPackageSensitiveBoundary
}

async function fixture(name) {
  const root = await mkdtemp(join(tmpdir(), `hexclaw-sensitive-${name}-`))
  const distRoot = join(root, 'dist')
  const appBundle = join(root, 'HexClaw.app')
  await mkdir(distRoot, { recursive: true })
  await mkdir(join(appBundle, 'Contents', 'MacOS'), { recursive: true })
  await mkdir(join(appBundle, 'Contents', 'Resources'), { recursive: true })
  await writeFile(
    join(distRoot, 'index.html'),
    '<script>const apiKey=form.apiKey,tokenName="token",testHomeLabel="hexclaw-test-home",className="task-card__action-button-task-run-history",grammar="erilog-sk-prompt-initialization",base="http://127.0.0.1:16060"</script>',
  )
  await writeFile(join(appBundle, 'Contents', 'MacOS', 'hexclaw-desktop'), 'binary\n')
  return { root, distRoot, appBundle }
}

async function expectCategory(paths, category, forbiddenValue = '') {
  const verify = await loadBoundary()
  await assert.rejects(verify(paths), (error) => {
    assert.match(error.message, new RegExp(`\\[${category.replaceAll(':', '\\:')}\\]`))
    if (forbiddenValue) assert.equal(error.message.includes(forbiddenValue), false)
    return true
  })
}

async function runBoundaryCLI(paths) {
  try {
    const result = await execFileAsync(process.execPath, [
      fileURLToPath(boundaryModuleURL),
      'verify',
      '--dist',
      paths.distRoot,
      '--app-bundle',
      paths.appBundle,
    ])
    return { code: 0, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    return {
      code: typeof error?.code === 'number' ? error.code : 1,
      stdout: error?.stdout ?? '',
      stderr: error?.stderr ?? '',
    }
  }
}

test('ordinary minified identifiers and public loopback endpoints pass', async (t) => {
  const paths = await fixture('ordinary')
  t.after(() => rm(paths.root, { recursive: true, force: true }))
  const verify = await loadBoundary()
  const ordinaryBinary = Buffer.alloc(3 * 1024 * 1024)
  for (let index = 0; index < ordinaryBinary.length; index += 1) {
    ordinaryBinary[index] = index % 251
  }
  const resource = join(paths.appBundle, 'Contents', 'Resources', 'ordinary.bin')
  await writeFile(resource, ordinaryBinary)

  const result = await verify(paths)
  assert.equal(result.findingCount, 0)
  assert.equal(result.scannedRoots, 2)
})

test('dist and App consume one shared global scan budget', async (t) => {
  const paths = await fixture('shared-global-budget')
  t.after(() => rm(paths.root, { recursive: true, force: true }))
  const module = await import(boundaryModuleURL)

  await assert.rejects(
    module.verifyPackageSensitiveBoundary(paths, {
      limits: { maxFiles: 1, maxFileBytes: 1024 * 1024, maxTotalBytes: 2 * 1024 * 1024 },
    }),
    /\[limit:file-count\]/,
  )
})

test('single-root preflight applies the same fail-closed scanner before App build', async (t) => {
  const paths = await fixture('single-root-preflight')
  t.after(() => rm(paths.root, { recursive: true, force: true }))
  const module = await import(boundaryModuleURL)
  await writeFile(join(paths.distRoot, 'typst-x86_64-apple-darwin'), '/Users/runner/work/typst')

  await assert.rejects(
    module.verifyPackageRootBoundary({ root: paths.distRoot, label: 'generation-binaries' }),
    /\[path:user-home\]/,
  )
})

test('Rust source output requires the specific cargo remap and rejects HOME-overridden cargo paths', async (t) => {
  const accepted = await fixture('accepted-rust-remap')
  const missing = await fixture('missing-rust-remap')
  const overridden = await fixture('overridden-rust-remap')
  t.after(() =>
    Promise.all(
      [accepted, missing, overridden].map((paths) =>
        rm(paths.root, { recursive: true, force: true }),
      ),
    ),
  )
  const module = await import(boundaryModuleURL)
  await writeFile(join(accepted.distRoot, 'typst'), '/build/cargo/registry/src/typst-cli')
  await writeFile(join(overridden.distRoot, 'typst'), '/build/home/.cargo/registry/src/typst-cli')

  const result = await module.verifyRustSourceRootBoundary({ root: accepted.distRoot })
  assert.equal(result.rustCargoRemap, true)
  await assert.rejects(
    module.verifyRustSourceRootBoundary({ root: missing.distRoot }),
    /\[path:missing-cargo-remap\]/,
  )
  await assert.rejects(
    module.verifyRustSourceRootBoundary({ root: overridden.distRoot }),
    /\[path:misremapped-cargo\]/,
  )
})

test('direct API errors expose only the stable category', async (t) => {
  const paths = await fixture('filename')
  t.after(() => rm(paths.root, { recursive: true, force: true }))
  const marker = ['synthetic', 'filename', 'must', 'stay', 'redacted'].join('-')
  const sensitiveName = `customer-token-${marker}.txt`
  await writeFile(join(paths.distRoot, sensitiveName), marker)

  const verify = await loadBoundary()
  await assert.rejects(verify(paths), (error) => {
    assert.equal(error.message, 'Package sensitive boundary: [file:credential]')
    assert.equal(error.displayPath, undefined)
    assert.equal(error.message.includes(sensitiveName), false)
    assert.equal(error.message.includes(marker), false)
    return true
  })
})

test('CLI failures expose only English category exit and signal fields', async (t) => {
  const paths = await fixture('cli-diagnostic')
  t.after(() => rm(paths.root, { recursive: true, force: true }))
  const filenameMarker = ['synthetic', 'diagnostic', 'filename', 'marker'].join('-')
  const secretMarker = ['sk', 'proj', `D${'a'.repeat(20)}8${'b'.repeat(20)}`].join('-')
  await writeFile(join(paths.distRoot, `${filenameMarker}.bin`), secretMarker)

  const result = await runBoundaryCLI(paths)
  assert.notEqual(result.code, 0)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, 'ERROR: package-sensitive-boundary category=secret:openai\n')
  assert.equal(`${result.stdout}${result.stderr}`.includes(filenameMarker), false)
  assert.equal(`${result.stdout}${result.stderr}`.includes(secretMarker), false)
  assert.equal(`${result.stdout}${result.stderr}`.includes(paths.root), false)
})

test('private application and Codex paths fail with category-only diagnostics', async (t) => {
  const paths = await fixture('private-path')
  t.after(() => rm(paths.root, { recursive: true, force: true }))
  const privatePath = ['/Users', 'synthetic-user', '.hexclaw', 'hexclaw.yaml'].join('/')
  await writeFile(join(paths.distRoot, 'asset.js'), privatePath)

  await expectCategory(paths, 'path:user-home', privatePath)
})

test('long punctuation components that are not usernames do not look like Linux homes', async (t) => {
  const paths = await fixture('non-user-home-component')
  t.after(() => rm(paths.root, { recursive: true, force: true }))
  const punctuation = '-_.,:;!@#$%^&*()[]{}=+~'.repeat(4).slice(0, 95)
  const minifiedShape = `prefix:/home/${punctuation}/bundle.js:suffix`
  await writeFile(join(paths.distRoot, 'punctuation.min.js'), minifiedShape)

  const verify = await loadBoundary()
  const result = await verify(paths)
  assert.equal(result.findingCount, 0)
})

test('absolute test-home paths fail while bare implementation identifiers remain allowed', async (t) => {
  const paths = await fixture('test-home-path')
  t.after(() => rm(paths.root, { recursive: true, force: true }))
  const testHomePath = '/private/tmp/hexclaw-test-home-synthetic/profile'
  await writeFile(join(paths.distRoot, 'test-home-path.bin'), testHomePath)

  await expectCategory(paths, 'path:test-home', testHomePath)
})

test('high-confidence secret shapes fail while the matched bytes stay redacted', async (t) => {
  const paths = await fixture('secret-shape')
  t.after(() => rm(paths.root, { recursive: true, force: true }))
  const synthetic = ['sk', 'proj', `S${'a'.repeat(20)}7${'b'.repeat(20)}`].join('-')
  await writeFile(join(paths.appBundle, 'Contents', 'Resources', 'opaque.bin'), synthetic)

  await expectCategory(paths, 'secret:openai', synthetic)
})

test('secret shapes crossing the bounded stream chunk boundary are rejected', async (t) => {
  const paths = await fixture('cross-chunk')
  t.after(() => rm(paths.root, { recursive: true, force: true }))
  const marker = ['sk', 'proj', `C${'a'.repeat(20)}7${'b'.repeat(20)}`].join('-')
  const prefix = Buffer.alloc(1024 * 1024 - 4, 0x78)
  prefix[prefix.length - 1] = 0x20
  await writeFile(
    join(paths.appBundle, 'Contents', 'Resources', 'cross-chunk.bin'),
    Buffer.concat([prefix, Buffer.from(marker), Buffer.alloc(1024, 0x79)]),
  )

  await expectCategory(paths, 'secret:openai', marker)
})

test('maximum-length test-home paths crossing a stream chunk boundary are rejected', async (t) => {
  const paths = await fixture('cross-chunk-test-home')
  t.after(() => rm(paths.root, { recursive: true, force: true }))
  const components = Array.from({ length: 16 }, (_, index) => `${index}`.padEnd(120, 'a'))
  const privatePath = `/${components.join('/')}/hexclaw-test-home-${'b'.repeat(120)}/profile`
  const prefix = Buffer.alloc(1024 * 1024 - Math.floor(privatePath.length / 2), 0x78)
  prefix[prefix.length - 1] = 0x20
  await writeFile(
    join(paths.appBundle, 'Contents', 'Resources', 'cross-chunk-test-home.bin'),
    Buffer.concat([prefix, Buffer.from(privatePath), Buffer.alloc(1024, 0x79)]),
  )

  await expectCategory(paths, 'path:test-home', privatePath)
})

test('user-home paths crossing a stream chunk boundary are rejected', async (t) => {
  const paths = await fixture('cross-chunk-user-home')
  t.after(() => rm(paths.root, { recursive: true, force: true }))
  const privatePath = '/Users/synthetic-user/work/hexclaw'
  const prefix = Buffer.alloc(1024 * 1024 - Math.floor(privatePath.length / 2), 0x78)
  prefix[prefix.length - 1] = 0x20
  await writeFile(
    join(paths.appBundle, 'Contents', 'Resources', 'cross-chunk-user-home.bin'),
    Buffer.concat([prefix, Buffer.from(privatePath), Buffer.alloc(1024, 0x79)]),
  )

  await expectCategory(paths, 'path:user-home', privatePath)
})

test('hard links are rejected even when their current bytes are ordinary', async (t) => {
  const paths = await fixture('hard-link')
  t.after(() => rm(paths.root, { recursive: true, force: true }))
  const source = join(paths.root, 'outside-ordinary.bin')
  await writeFile(source, 'ordinary bytes\n')
  await link(source, join(paths.appBundle, 'Contents', 'Resources', 'linked.bin'))

  await expectCategory(paths, 'file:hard-link')
})

test('all symbolic links fail closed so target content cannot escape scanning', async (t) => {
  const paths = await fixture('internal-symlink')
  t.after(() => rm(paths.root, { recursive: true, force: true }))
  await writeFile(join(paths.appBundle, 'Contents', 'Resources', 'ordinary.bin'), 'ordinary\n')
  await symlink('ordinary.bin', join(paths.appBundle, 'Contents', 'Resources', 'current.bin'))

  await expectCategory(paths, 'file:symbolic-link')
})

test('unsafe symlink targets fail closed without exposing the target', async (t) => {
  const paths = await fixture('unsafe-symlink')
  t.after(() => rm(paths.root, { recursive: true, force: true }))
  const marker = ['synthetic', 'symlink', 'target', 'marker'].join('-')
  const target = `../../../../${marker}`
  await symlink(target, join(paths.appBundle, 'Contents', 'Resources', 'escaped-link'))

  await expectCategory(paths, 'file:symbolic-link', marker)
})

test(
  'non-regular filesystem entries fail closed',
  { skip: process.platform === 'win32' },
  async (t) => {
    const paths = await fixture('non-regular')
    t.after(() => rm(paths.root, { recursive: true, force: true }))
    const fifo = join(paths.appBundle, 'Contents', 'Resources', 'named-pipe')
    await execFileAsync('/usr/bin/mkfifo', [fifo])

    const startedAt = performance.now()
    await expectCategory(paths, 'file:non-regular')
    assert.ok(
      performance.now() - startedAt < 2_000,
      'FIFO preflight must fail before metadata tools',
    )
  },
)

test('binary content scanning stays stream bounded', async () => {
  const source = await readFile(
    new URL('../../scripts/ci/package-sensitive-boundary.mjs', import.meta.url),
    'utf8',
  )

  assert.match(source, /O_NOFOLLOW/)
  assert.match(source, /\.stat\(\{\s*bigint:\s*true\s*\}\)/)
  assert.match(source, /Buffer\.allocUnsafe\(SCAN_CHUNK_BYTES\)/)
  assert.match(source, /const SCAN_OVERLAP_BYTES = 4096/)
  assert.doesNotMatch(source, /\breadFile(?:Sync)?\b/)
})

test('all macOS Linux and Windows user-home absolute paths are rejected', async (t) => {
  const samples = [
    '/Users/synthetic-user/work/hexclaw',
    '/home/synthetic-user/work/hexclaw',
    '/root/work/hexclaw',
    String.raw`C:\Users\synthetic-user\work\hexclaw`,
    'D:/Users/synthetic-user/work/hexclaw',
  ]

  for (const [index, privatePath] of samples.entries()) {
    const paths = await fixture(`all-private-homes-${index}`)
    t.after(() => rm(paths.root, { recursive: true, force: true }))
    await writeFile(join(paths.distRoot, `private-home-${index}.bin`), privatePath)
    await expectCategory(paths, 'path:user-home', privatePath)
  }
})

test('exact home roots and terminated home paths are rejected without a runner exception', async (t) => {
  const samples = [
    '/Users/runner',
    'file:///Users/synthetic-user',
    '/Users/synthetic-user/',
    '/home/synthetic-user',
    '/home/synthetic-user/',
    '/root',
    '/root/',
    '/var/root',
    '/var/root/',
    String.raw`C:\Users\Synthetic User`,
    'C:\\Users\\Synthetic User\\',
    'D:/Users/synthetic-user',
    'D:/Users/synthetic-user/',
  ]

  for (const [index, privatePath] of samples.entries()) {
    const paths = await fixture(`terminated-private-homes-${index}`)
    t.after(() => rm(paths.root, { recursive: true, force: true }))
    await writeFile(join(paths.distRoot, `private-home-root-${index}.bin`), privatePath)
    await expectCategory(paths, 'path:user-home', privatePath)
  }
})

test('environment and credential configuration basenames are rejected', async (t) => {
  const samples = [
    ['.envrc', 'file:environment'],
    ['.environment', 'file:environment'],
    ['.netrc', 'file:credential-config'],
    ['_netrc', 'file:credential-config'],
    ['.npmrc', 'file:credential-config'],
    ['.pnpmrc', 'file:credential-config'],
    ['.yarnrc.yml', 'file:credential-config'],
    ['.pypirc', 'file:credential-config'],
    ['.git-credentials', 'file:credential-config'],
    ['.curlrc', 'file:credential-config'],
  ]

  for (const [index, [basename, category]] of samples.entries()) {
    const paths = await fixture(`credential-config-${index}`)
    t.after(() => rm(paths.root, { recursive: true, force: true }))
    await writeFile(join(paths.distRoot, basename), 'ordinary synthetic bytes\n')
    await expectCategory(paths, category, basename)
  }
})

test('shared entry preflight rejects directory-heavy trees before metadata commands', async (t) => {
  const paths = await fixture('shared-entry-preflight')
  t.after(() => rm(paths.root, { recursive: true, force: true }))
  for (let index = 0; index < 64; index += 1) {
    await mkdir(join(paths.distRoot, `empty-${String(index).padStart(2, '0')}`))
  }
  const module = await import(boundaryModuleURL)
  let metadataCommandCalls = 0
  const adapters = {
    limits: {
      maxEntries: 6,
      maxFiles: 100,
      maxFileBytes: 1024 * 1024,
      maxTotalBytes: 2 * 1024 * 1024,
    },
    runCommand: async () => {
      metadataCommandCalls += 1
      return { code: 0, signal: null, stdout: '', stderr: '' }
    },
  }

  const startedAt = performance.now()
  await assert.rejects(
    module.verifyPackageSensitiveBoundary(paths, adapters),
    /\[limit:entry-count\]/,
  )
  assert.ok(performance.now() - startedAt < 2_000)
  assert.equal(metadataCommandCalls, 0)
})

test(
  'metadata sanitizer rejects the shared entry budget before xattr or ACL commands',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const paths = await fixture('sanitize-entry-preflight')
    t.after(() => rm(paths.root, { recursive: true, force: true }))
    for (let index = 0; index < 64; index += 1) {
      await mkdir(
        join(paths.appBundle, 'Contents', 'Resources', `empty-${String(index).padStart(2, '0')}`),
      )
    }
    const module = await import(boundaryModuleURL)
    let metadataCommandCalls = 0

    await assert.rejects(
      module.sanitizeMacPackageMetadata(paths, {
        limits: {
          maxEntries: 6,
          maxFiles: 100,
          maxFileBytes: 1024 * 1024,
          maxTotalBytes: 2 * 1024 * 1024,
        },
        runCommand: async () => {
          metadataCommandCalls += 1
          return { code: 0, signal: null, stdout: '', stderr: '' }
        },
      }),
      /\[limit:entry-count\]/,
    )
    assert.equal(metadataCommandCalls, 0)
  },
)

test(
  'macOS metadata sanitizer removes custom xattrs resource forks and ACLs before verification',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const paths = await fixture('mac-metadata')
    t.after(() => rm(paths.root, { recursive: true, force: true }))
    const binary = join(paths.appBundle, 'Contents', 'MacOS', 'hexclaw-desktop')
    const distAsset = join(paths.distRoot, 'index.html')
    await execFileAsync('/usr/bin/xattr', ['-w', 'com.hexclaw.synthetic', 'marker', binary])
    await execFileAsync('/usr/bin/xattr', ['-w', 'com.apple.ResourceFork', 'marker', binary])
    await execFileAsync('/bin/chmod', ['+a', 'everyone deny delete', binary])
    await execFileAsync('/usr/bin/xattr', ['-w', 'com.hexclaw.synthetic', 'marker', distAsset])
    await execFileAsync('/bin/chmod', ['+a', 'everyone deny delete', distAsset])

    const module = await import(boundaryModuleURL)
    assert.equal(typeof module.verifyMacTreeMetadata, 'function')
    assert.equal(typeof module.sanitizeMacPackageMetadata, 'function')
    await assert.rejects(module.verifyMacTreeMetadata(paths.appBundle), /metadata:/)

    const result = await module.sanitizeMacPackageMetadata(paths)
    assert.equal(result.metadataVerified, true)
    await module.verifyMacTreeMetadata(paths.appBundle)
    await module.verifyMacTreeMetadata(paths.distRoot)

    const { stdout: attributes } = await execFileAsync('/usr/bin/xattr', [
      '-r',
      '-s',
      paths.appBundle,
    ])
    const names = attributes
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => line.slice(line.lastIndexOf(': ') + 2))
    assert.equal(
      names.every((name) => name === 'com.apple.provenance'),
      true,
    )
    assert.equal(attributes.includes('com.apple.ResourceFork'), false)

    const { stdout: aclListing } = await execFileAsync('/bin/ls', ['-leR', paths.appBundle])
    assert.doesNotMatch(aclListing, /^\s+\d+:/mu)
    const { stdout: distAttributes } = await execFileAsync('/usr/bin/xattr', [
      '-r',
      '-s',
      paths.distRoot,
    ])
    assert.equal(distAttributes.includes('com.hexclaw.synthetic'), false)
    const { stdout: distACLListing } = await execFileAsync('/bin/ls', ['-leR', paths.distRoot])
    assert.doesNotMatch(distACLListing, /^\s+\d+:/mu)
  },
)
