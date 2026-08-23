import assert from 'node:assert/strict'
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { build, resolveConfig } from 'vite'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

async function readRepoFile(pathname) {
  return readFile(resolve(repoRoot, pathname), 'utf8')
}

test('package-local uses one explicit environment-free frontend build mode', async () => {
  const packageJSON = JSON.parse(await readRepoFile('package.json'))
  const localConfig = JSON.parse(await readRepoFile('src-tauri/tauri.package-local.conf.json'))

  assert.equal(packageJSON.scripts['build-only:package-local'], 'vite build --mode package-local')
  assert.equal(
    packageJSON.scripts['build:package-local'],
    'run-s type-check build-only:package-local',
  )
  assert.equal(localConfig.build.beforeBuildCommand, '')

  const hostCanaries = {
    TAURI_DEV_HOST: 'synthetic-package-host.invalid',
    HEX_E2E_SIDECAR_URL: 'http://127.0.0.1:65534',
  }
  const previous = Object.fromEntries(
    Object.keys(hostCanaries).map((name) => [name, process.env[name]]),
  )
  Object.assign(process.env, hostCanaries)
  let release
  try {
    release = await resolveConfig(
      {
        configFile: resolve(repoRoot, 'vite.config.ts'),
        logLevel: 'silent',
        mode: 'package-local',
      },
      'build',
    )
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
  assert.equal(release.envDir, false)
  assert.deepEqual(release.envPrefix, ['HEXCLAW_PACKAGE_LOCAL_PUBLIC_'])
  assert.equal(
    release.plugins.some((plugin) => plugin.name === 'hexclaw-pdf-worker-package-asset'),
    true,
  )
  assert.equal(
    Object.keys(release.env).some((name) => /^(?:VITE_|TAURI_)/.test(name)),
    false,
  )
  assert.notEqual(release.server?.host, hostCanaries.TAURI_DEV_HOST)
  assert.notEqual(release.server?.proxy?.['/_hexclaw']?.target, hostCanaries.HEX_E2E_SIDECAR_URL)
})

test('ordinary development keeps the local env mechanism', async () => {
  const development = await resolveConfig(
    {
      configFile: resolve(repoRoot, 'vite.config.ts'),
      logLevel: 'silent',
      mode: 'development',
    },
    'serve',
  )

  assert.notEqual(development.envDir, false)
  assert.deepEqual(development.envPrefix, ['VITE_'])
  assert.equal(
    development.plugins.some((plugin) => plugin.name === 'hexclaw-pdf-worker-package-asset'),
    false,
  )
  const sidecarProxy = development.server.proxy?.['/_hexclaw']
  assert.equal(sidecarProxy?.ws, true)
  assert.equal(sidecarProxy?.rewriteWsOrigin, true)
})

test('an actual package-local build excludes host VITE and TAURI canaries', async (t) => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'hexclaw-package-env-'))
  const outputRoot = join(fixtureRoot, 'output')
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }))
  await writeFile(
    join(fixtureRoot, 'main.js'),
    [
      'globalThis.__packageCanary = [',
      '  import.meta.env.VITE_SYNTHETIC_SECRET_CANARY,',
      '  import.meta.env.TAURI_SYNTHETIC_SECRET_CANARY,',
      '  import.meta.env.HEXCLAW_PACKAGE_LOCAL_PUBLIC_CANARY,',
      "].join('')",
    ].join('\n'),
  )

  const canaries = {
    VITE_SYNTHETIC_SECRET_CANARY: 'synthetic-vite-secret-canary',
    TAURI_SYNTHETIC_SECRET_CANARY: 'synthetic-tauri-secret-canary',
    HEXCLAW_PACKAGE_LOCAL_PUBLIC_CANARY: 'synthetic-public-package-canary',
  }
  const previous = Object.fromEntries(
    Object.keys(canaries).map((name) => [name, process.env[name]]),
  )
  Object.assign(process.env, canaries)
  try {
    const packageLocal = await resolveConfig(
      {
        configFile: resolve(repoRoot, 'vite.config.ts'),
        logLevel: 'silent',
        mode: 'package-local',
      },
      'build',
    )
    await build({
      configFile: false,
      root: fixtureRoot,
      mode: 'package-local',
      logLevel: 'silent',
      envDir: packageLocal.envDir,
      envPrefix: packageLocal.envPrefix,
      build: {
        emptyOutDir: true,
        outDir: outputRoot,
        rollupOptions: {
          input: join(fixtureRoot, 'main.js'),
          output: { entryFileNames: 'canary.js' },
        },
      },
    })
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }

  const output = await readFile(join(outputRoot, 'canary.js'), 'utf8')
  assert.equal(output.includes(canaries.VITE_SYNTHETIC_SECRET_CANARY), false)
  assert.equal(output.includes(canaries.TAURI_SYNTHETIC_SECRET_CANARY), false)
  assert.equal(output.includes(canaries.HEXCLAW_PACKAGE_LOCAL_PUBLIC_CANARY), true)
})

test('repository env policy keeps only an explicit public example', async () => {
  const ignoreRules = await readRepoFile('.gitignore')
  const envRules = ignoreRules.split(/\r?\n/u).filter((line) => line === '.env*')
  const exampleRules = ignoreRules.split(/\r?\n/u).filter((line) => line === '!.env.example')
  assert.equal(envRules.length, 1)
  assert.equal(exampleRules.length, 1)
  await assert.rejects(lstat(resolve(repoRoot, '.env')), { code: 'ENOENT' })

  const publicEntries = (await readRepoFile('.env.example'))
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => {
      const separator = line.indexOf('=')
      assert.notEqual(separator, -1)
      return [line.slice(0, separator), line.slice(separator + 1)]
    })
  assert.deepEqual(publicEntries.map(([name]) => name).sort(), [
    'VITE_API_BASE',
    'VITE_API_TIMEOUT',
    'VITE_LOG_LEVEL',
  ])

  const values = Object.fromEntries(publicEntries)
  const apiBase = new URL(values.VITE_API_BASE)
  assert.equal(['127.0.0.1', '[::1]', 'localhost'].includes(apiBase.hostname), true)
  assert.match(values.VITE_API_TIMEOUT, /^\d{1,8}$/u)
  assert.match(values.VITE_LOG_LEVEL, /^[a-z]{2,12}$/u)
  const serializedValues = publicEntries.map(([, value]) => value).join('\n')
  assert.equal(
    /-----BEGIN .*PRIVATE KEY-----|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|(?:AKIA|ASIA)[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|gh[pousr]_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9-]{20,}|oapi\.dingtalk\.com\/robot\/send\?access_token=|(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)[^\r\n]+[/\\]\.(?:hexclaw|codex)/iu.test(
      serializedValues,
    ),
    false,
  )
})
