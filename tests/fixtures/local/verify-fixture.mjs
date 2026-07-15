#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createReadStream, existsSync } from 'node:fs'
import { open, readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const localDir = dirname(fileURLToPath(import.meta.url))
const actualManifestPath = join(localDir, 'manifest.json')
const exampleManifestPath = join(localDir, 'manifest.example.json')
const fixtureID = 'textbook_pdf'

function fail(message) {
  throw new Error(message)
}

function parseArguments(argv) {
  let manifestPath
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--manifest') {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) fail('--manifest requires a path')
      manifestPath = resolve(value)
      index += 1
      continue
    }
    if (argument === '--help' || argument === '-h') {
      return { help: true }
    }
    fail(`unknown argument: ${argument}`)
  }
  return {
    help: false,
    manifestPath: manifestPath ?? (existsSync(actualManifestPath) ? actualManifestPath : exampleManifestPath),
  }
}

async function readManifest(manifestPath) {
  let raw
  try {
    raw = await readFile(manifestPath, 'utf8')
  } catch (error) {
    fail(`manifest not readable: ${manifestPath}: ${error.message}`)
  }

  let manifest
  try {
    manifest = JSON.parse(raw)
  } catch (error) {
    fail(`manifest is not valid JSON: ${manifestPath}: ${error.message}`)
  }
  if (manifest?.schema_version !== 1) fail('manifest schema_version must equal 1')
  if (!Array.isArray(manifest.fixtures)) fail('manifest fixtures must be an array')

  const ids = manifest.fixtures.map((fixture) => fixture?.id)
  if (new Set(ids).size !== ids.length) fail('manifest fixture ids must be unique')
  const fixture = manifest.fixtures.find((candidate) => candidate?.id === fixtureID)
  if (!fixture) fail(`manifest fixture ${fixtureID} is required`)
  validateFixtureContract(fixture)
  return fixture
}

function validateFixtureContract(fixture) {
  if (typeof fixture.path !== 'string' || fixture.path.trim() === '') {
    fail(`${fixtureID}.path must be a non-empty string`)
  }
  if (typeof fixture.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(fixture.sha256)) {
    fail(`${fixtureID}.sha256 must be exactly 64 lowercase hexadecimal characters`)
  }
  if (!Number.isSafeInteger(fixture.bytes) || fixture.bytes <= 0) {
    fail(`${fixtureID}.bytes must be a positive safe integer`)
  }
  if (!Number.isSafeInteger(fixture.pages) || fixture.pages <= 0) {
    fail(`${fixtureID}.pages must be a positive safe integer`)
  }
  if (fixture.source !== 'private-local') {
    fail(`${fixtureID}.source must equal private-local`)
  }
  if (fixture.redistributable !== false) {
    fail(`${fixtureID}.redistributable must equal false`)
  }
}

async function assertPDFSignature(path) {
  const handle = await open(path, 'r')
  try {
    const signature = Buffer.alloc(5)
    const { bytesRead } = await handle.read(signature, 0, signature.length, 0)
    if (bytesRead !== signature.length || signature.toString('ascii') !== '%PDF-') {
      fail(`PDF signature missing: ${path}`)
    }
  } finally {
    await handle.close()
  }
}

async function hashAndCountBytes(path) {
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length
    hash.update(chunk)
  }
  return { sha256: hash.digest('hex'), bytes }
}

function runMetadataCommand(command, args, parse) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
    maxBuffer: 1024 * 1024,
    timeout: 30_000,
  })
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`
    return { error: `${command}: ${detail}` }
  }
  const pages = parse(result.stdout)
  if (!Number.isSafeInteger(pages) || pages <= 0) {
    return { error: `${command}: page count missing from output` }
  }
  return { pages }
}

function countPDFPages(path) {
  const pdfinfo = runMetadataCommand('pdfinfo', [path], (output) => {
    const match = output.match(/^Pages:\s*(\d+)\s*$/m)
    return match ? Number(match[1]) : Number.NaN
  })
  if (pdfinfo.pages) return pdfinfo.pages

  const errors = [pdfinfo.error]
  if (process.platform === 'darwin') {
    const mdls = runMetadataCommand(
      '/usr/bin/mdls',
      ['-raw', '-name', 'kMDItemNumberOfPages', path],
      (output) => (/^\d+$/.test(output.trim()) ? Number(output.trim()) : Number.NaN),
    )
    if (mdls.pages) return mdls.pages
    errors.push(mdls.error)
  }
  fail(`unable to determine PDF page count: ${errors.filter(Boolean).join('; ')}`)
}

function sameFileSnapshot(before, after) {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs
}

async function verifyFixture(manifestPath) {
  const fixture = await readManifest(manifestPath)
  const override = process.env.HEX_FIXTURE_TEXTBOOK_PDF?.trim()
  const configuredPath = override || fixture.path
  const path = isAbsolute(configuredPath)
    ? configuredPath
    : resolve(dirname(manifestPath), configuredPath)

  let before
  try {
    before = await stat(path)
  } catch (error) {
    if (error.code === 'ENOENT') fail(`fixture file not found: ${path}`)
    fail(`fixture file not readable: ${path}: ${error.message}`)
  }
  if (!before.isFile()) fail(`fixture path is not a regular file: ${path}`)

  await assertPDFSignature(path)
  const evidence = await hashAndCountBytes(path)
  if (evidence.bytes !== fixture.bytes) {
    fail(`byte count mismatch: expected ${fixture.bytes}, got ${evidence.bytes}`)
  }
  if (evidence.sha256 !== fixture.sha256) {
    fail(`SHA256 mismatch: expected ${fixture.sha256}, got ${evidence.sha256}`)
  }

  const pages = countPDFPages(path)
  if (pages !== fixture.pages) {
    fail(`page count mismatch: expected ${fixture.pages}, got ${pages}`)
  }

  const after = await stat(path)
  if (!sameFileSnapshot(before, after)) {
    fail(`fixture changed while it was being verified: ${path}`)
  }
  return {
    fixture: fixtureID,
    path,
    sha256: evidence.sha256,
    bytes: evidence.bytes,
    pages,
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(
      'Usage: node verify-fixture.mjs [--manifest PATH]\n'
      + 'Set HEX_FIXTURE_TEXTBOOK_PDF to explicitly override only the PDF path.\n',
    )
    return
  }
  const evidence = await verifyFixture(options.manifestPath)
  process.stdout.write(`${JSON.stringify(evidence)}\n`)
}

main().catch((error) => {
  process.stderr.write(`[fixture-contract] ${error.message}\n`)
  process.exitCode = 1
})
