import { readFile } from 'node:fs/promises'

const tag = process.argv[2]

if (!tag) {
  console.error('Usage: node ./scripts/ci/verify-release.mjs <tag>')
  process.exit(1)
}

const version = tag.startsWith('v') ? tag.slice(1) : tag
const semverPattern =
  /^\d+\.\d+\.\d+(?:-(?:0|[1-9A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

if (!semverPattern.test(version)) {
  console.error(`Release tag "${tag}" is not a valid SemVer tag like v1.2.3 or v1.2.3-rc.1.`)
  process.exit(1)
}

const packageJson = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'))
const tauriConfig = JSON.parse(await readFile(new URL('../../src-tauri/tauri.conf.json', import.meta.url), 'utf8'))
const cargoToml = await readFile(new URL('../../src-tauri/Cargo.toml', import.meta.url), 'utf8')

const errors = []

if (packageJson.version !== version) {
  errors.push(`package.json version (${packageJson.version}) must match tag ${tag}.`)
}

if (tauriConfig.version !== version) {
  errors.push(`src-tauri/tauri.conf.json version (${tauriConfig.version}) must match tag ${tag}.`)
}

const packageSection = cargoToml.match(/\[package\]([\s\S]*?)(?:\n\[|$)/)?.[1] ?? ''
const cargoVersionMatch = packageSection.match(/^\s*version\s*=\s*"([^"]+)"/m)
if (!cargoVersionMatch) {
  errors.push('Could not find version field in src-tauri/Cargo.toml [package] section.')
} else if (cargoVersionMatch[1] !== version) {
  errors.push(`src-tauri/Cargo.toml version (${cargoVersionMatch[1]}) must match tag ${tag}.`)
}

const updaterPubkey = tauriConfig.plugins?.updater?.pubkey
if (typeof updaterPubkey !== 'string' || updaterPubkey.trim() === '') {
  errors.push('src-tauri/tauri.conf.json plugins.updater.pubkey is empty. Commit the Tauri updater public key before creating a release tag.')
}

const updaterEndpoints = tauriConfig.plugins?.updater?.endpoints
if (!Array.isArray(updaterEndpoints) || updaterEndpoints.length === 0) {
  errors.push('src-tauri/tauri.conf.json plugins.updater.endpoints is empty. Configure at least one updater endpoint before creating a release tag.')
}

if (tauriConfig.bundle?.createUpdaterArtifacts !== true) {
  errors.push('src-tauri/tauri.conf.json bundle.createUpdaterArtifacts must be true for Tauri updater releases.')
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(error)
  }
  process.exit(1)
}

console.log(`Release metadata verified for ${tag}.`)
