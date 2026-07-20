#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const posixRelative = (from, to) => path.relative(from, to).split(path.sep).join('/')

const fail = (message) => {
  throw new Error(message)
}

const parseArgs = (argv) => {
  const options = { allowUnknownGit: false }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--allow-unknown-git') {
      options.allowUnknownGit = true
      continue
    }
    if (!argument.startsWith('--')) {
      fail(`unexpected positional argument: ${argument}`)
    }

    const value = argv[index + 1]
    if (!value || value.startsWith('--')) {
      fail(`missing value for ${argument}`)
    }
    index += 1

    switch (argument) {
      case '--artifact-dir':
        options.artifactDir = value
        break
      case '--desktop-root':
        options.desktopRoot = value
        break
      case '--fixture-manifest':
        options.fixtureManifest = value
        break
      case '--ownership':
        options.ownership = value
        break
      case '--lane':
        options.lane = value
        break
      case '--mockserver-image':
        options.mockserverImage = value
        break
      case '--gateway-image':
        options.gatewayImage = value
        break
      default:
        fail(`unknown option: ${argument}`)
    }
  }

  for (const [name, value] of [
    ['--artifact-dir', options.artifactDir],
    ['--desktop-root', options.desktopRoot],
    ['--fixture-manifest', options.fixtureManifest],
    ['--ownership', options.ownership],
    ['--lane', options.lane],
    ['--mockserver-image', options.mockserverImage],
    ['--gateway-image', options.gatewayImage],
  ]) {
    if (!value) fail(`missing required option: ${name}`)
  }

  return options
}

const readJSONEvidence = async (file, label) => {
  let body
  try {
    body = await readFile(file)
  } catch (error) {
    fail(`${label} is unreadable: ${error.code ?? error.message}`)
  }

  let value
  try {
    value = JSON.parse(body.toString('utf8'))
  } catch {
    fail(`${label} is not valid JSON`)
  }
  if (!Number.isInteger(value.schema_version) || value.schema_version < 1) {
    fail(`${label} must declare a positive integer schema_version`)
  }
  return { body, value }
}

const git = (cwd, ...args) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()

const inspectDesktopGit = (desktopRoot, allowUnknown) => {
  try {
    const topLevel = realpathSync(git(desktopRoot, 'rev-parse', '--show-toplevel'))
    if (topLevel !== realpathSync(desktopRoot)) {
      fail('desktop root is not the root of its git worktree')
    }
    return {
      sha: git(desktopRoot, 'rev-parse', 'HEAD'),
      dirty: git(desktopRoot, 'status', '--porcelain', '--untracked-files=normal').length > 0,
      policy: 'verified',
    }
  } catch {
    if (allowUnknown) {
      return {
        sha: 'unknown',
        dirty: 'unknown',
        policy: 'explicit-allow-unknown',
      }
    }
    fail('desktop root is not a verifiable git worktree; pass --allow-unknown-git only for an explicitly unversioned run')
  }
}

const parsePinnedImage = (image, label) => {
  const match = /^(.+?)@(sha256:[a-f0-9]{64})$/.exec(image)
  if (!match) {
    fail(`${label} image must be pinned by sha256 digest`)
  }
  return { reference: match[1], digest: match[2] }
}

const sidecarSource = () => {
  const hexclawRef = process.env.HEXCLAW_REF || null
  const localSource = process.env.HEXCLAW_LOCAL_SRC
    ? path.resolve(process.env.HEXCLAW_LOCAL_SRC)
    : null

  let selection = 'unspecified'
  if (localSource && hexclawRef) selection = 'local-src-overrides-ref'
  else if (localSource) selection = 'local-src'
  else if (hexclawRef) selection = 'ref'

  return {
    hexclaw_ref: hexclawRef,
    hexclaw_local_src: localSource,
    selection,
  }
}

const createRunID = (now = new Date()) => {
  const timestamp = now.toISOString().replace(/[-:.]/g, '')
  return `${timestamp}-${process.pid}-${randomBytes(4).toString('hex')}`
}

const writeManifest = async (artifactDir, manifest) => {
  await mkdir(artifactDir, { recursive: true, mode: 0o700 })
  const outputPath = path.join(artifactDir, 'run-manifest.json')
  const temporaryPath = path.join(
    artifactDir,
    `.run-manifest.${process.pid}.${randomBytes(4).toString('hex')}.tmp`,
  )

  try {
    await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
    await chmod(temporaryPath, 0o600)
    await rename(temporaryPath, outputPath)
    await chmod(outputPath, 0o600)
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {})
    throw error
  }
  return outputPath
}

const main = async () => {
  const options = parseArgs(process.argv.slice(2))
  const desktopRoot = path.resolve(options.desktopRoot)
  const artifactDir = path.resolve(options.artifactDir)
  const fixturePath = path.resolve(options.fixtureManifest)
  const ownershipPath = path.resolve(options.ownership)

  const ownership = await readJSONEvidence(ownershipPath, 'ownership policy')
  if (!ownership.value.test_lanes?.[options.lane]) {
    fail(`unknown test lane: ${options.lane}`)
  }
  const fixture = await readJSONEvidence(fixturePath, 'fixture manifest')
  const mockserverImage = parsePinnedImage(options.mockserverImage, 'MockServer')
  const gatewayImage = parsePinnedImage(options.gatewayImage, 'loopback gateway')
  const desktopGit = inspectDesktopGit(desktopRoot, options.allowUnknownGit)
  const generatedAt = new Date()

  const manifest = {
    schema_version: 1,
    run_id: createRunID(generatedAt),
    generated_at_utc: generatedAt.toISOString(),
    test_lane: options.lane,
    desktop_git: desktopGit,
    sidecar_source: sidecarSource(),
    fixture_manifest: {
      schema_version: fixture.value.schema_version,
      sha256: sha256(fixture.body),
      path: posixRelative(desktopRoot, fixturePath),
    },
    ownership_policy: {
      schema_version: ownership.value.schema_version,
      sha256: sha256(ownership.body),
      path: posixRelative(desktopRoot, ownershipPath),
    },
    mockserver_image: mockserverImage,
    loopback_gateway_image: gatewayImage,
  }

  const outputPath = await writeManifest(artifactDir, manifest)
  process.stdout.write(`${outputPath}\n`)
}

main().catch((error) => {
  process.stderr.write(`run manifest error: ${error.message}\n`)
  process.exitCode = 1
})
