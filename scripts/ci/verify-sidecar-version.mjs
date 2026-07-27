import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

export function normalizeReleaseVersion(version) {
  return version.replace(/^v/, '')
}

export function extractEmbeddedVersion(metadata) {
  const matches = [...metadata.matchAll(/(?:^|[\s"])main\.version=([^\s"']+)/g)].map(
    (match) => match[1],
  )
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one embedded main.version in Go metadata, found ${matches.length}`,
    )
  }
  return matches[0]
}

export function assertSidecarVersion(metadata, expectedVersion) {
  const canonicalVersion = normalizeReleaseVersion(expectedVersion)
  const embeddedVersion = extractEmbeddedVersion(metadata)
  if (embeddedVersion !== canonicalVersion) {
    throw new Error(
      `sidecar main.version (${embeddedVersion}) must match Desktop release version (${canonicalVersion})`,
    )
  }
  return embeddedVersion
}

async function main() {
  const [binaryPath, explicitExpectedVersion] = process.argv.slice(2)
  if (!binaryPath) {
    console.error(
      'Usage: node ./scripts/ci/verify-sidecar-version.mjs <sidecar-binary> [expected-version]',
    )
    process.exit(2)
  }

  const expectedVersion =
    explicitExpectedVersion ??
    JSON.parse(
      await readFile(new URL('../../src-tauri/tauri.conf.json', import.meta.url), 'utf8'),
    ).version
  const metadata = execFileSync('go', ['version', '-m', binaryPath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const embeddedVersion = assertSidecarVersion(metadata, expectedVersion)
  console.log(`Sidecar release version verified: ${embeddedVersion}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
