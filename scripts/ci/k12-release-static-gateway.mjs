#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { createServer, request as httpRequest } from 'node:http'
import { lstatSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { connect as connectTCP } from 'node:net'
import {
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path'
import { fileURLToPath } from 'node:url'

import { verifyReleaseAttestation } from './k12-release-ui-attestation.mjs'

const CONFIG_FIELDS = [
  'dist_manifest_path',
  'dist_root',
  'host',
  'installed_app_binary',
  'package_path',
  'port',
  'release_attestation_path',
  'release_attestation_sha256',
  'release_version',
  'schema_version',
  'sidecar_binary',
  'sidecar_url',
]

const MANIFEST_FIELDS = ['files', 'release_version', 'schema_version']
const MANIFEST_ENTRY_FIELDS = ['bytes', 'path', 'sha256']
const RELEASE_UI_URL = 'http://localhost:16060'
const ATTESTATION_PATH = '/__hexclaw_release_attestation'
const RELEASE_PROXY_PREFIX = '/_hexclaw'
const PRIVATE_FILE_MODE = 0o600

function fail(message) {
  throw new Error(`K12 release static gateway: ${message}`)
}

function exactFields(value, fields, name) {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    fail(`${name} must be an object`)
  }
  const actual = Object.keys(value).sort()
  if (
    actual.length !== fields.length
    || actual.some((field, index) => field !== fields[index])
  ) {
    fail(`${name} fields do not match the exact schema`)
  }
}

function lowercaseSHA256(value, name) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    fail(`${name} must be 64 lowercase hex characters`)
  }
  return value
}

function exactSidecarOrigin(value) {
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    fail('sidecar_url must be an absolute HTTP origin')
  }
  if (
    parsed.protocol !== 'http:'
    || parsed.hostname !== '127.0.0.1'
    || parsed.port === ''
    || parsed.port === '16060'
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.pathname !== '/'
    || parsed.search !== ''
    || parsed.hash !== ''
  ) {
    fail('sidecar_url must be an explicit isolated loopback origin')
  }
  return parsed.origin
}

export function normalizeReleaseStaticGatewayConfig(raw) {
  exactFields(raw, CONFIG_FIELDS, 'config')
  if (raw.schema_version !== 1) fail('unsupported config schema')
  if (raw.host !== '127.0.0.1' || raw.port !== 16060) {
    fail('gateway must bind only 127.0.0.1:16060')
  }
  for (const field of [
    'dist_root',
    'installed_app_binary',
    'sidecar_binary',
    'package_path',
    'dist_manifest_path',
    'release_attestation_path',
  ]) {
    if (typeof raw[field] !== 'string' || !isAbsolute(raw[field])) {
      fail(`${field} must be absolute`)
    }
  }
  if (typeof raw.release_version !== 'string' || raw.release_version.trim() === '') {
    fail('release_version is required')
  }
  lowercaseSHA256(raw.release_attestation_sha256, 'release_attestation_sha256')
  const sidecarURL = exactSidecarOrigin(raw.sidecar_url)
  return Object.freeze({
    ...raw,
    sidecar_url: sidecarURL,
    releaseUIURL: RELEASE_UI_URL,
  })
}

function safeManifestPath(distRoot, entryPath) {
  if (
    typeof entryPath !== 'string'
    || entryPath === ''
    || isAbsolute(entryPath)
    || entryPath.includes('\\')
    || entryPath.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    fail('dist manifest contains an unsafe asset path')
  }
  const root = resolve(distRoot)
  const pathname = resolve(root, entryPath)
  const suffix = relative(root, pathname)
  if (suffix === '' || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
    fail('dist manifest asset escapes dist_root')
  }
  return pathname
}

async function loadAttestedAssets(config, attestation) {
  const manifestBytes = await readFile(config.dist_manifest_path)
  const manifestSHA256 = createHash('sha256').update(manifestBytes).digest('hex')
  if (manifestSHA256 !== attestation.manifestSHA256) {
    fail('dist manifest identity changed after attestation')
  }
  let manifest
  try {
    manifest = JSON.parse(String(manifestBytes))
  } catch {
    fail('dist manifest is not valid JSON')
  }
  exactFields(manifest, MANIFEST_FIELDS, 'dist manifest')
  if (
    manifest.schema_version !== 1
    || manifest.release_version !== config.release_version
    || !Array.isArray(manifest.files)
    || manifest.files.length !== attestation.distFileCount
  ) {
    fail('dist manifest release identity mismatch')
  }

  const assets = new Map()
  let totalBytes = 0
  for (const entry of manifest.files) {
    exactFields(entry, MANIFEST_ENTRY_FIELDS, 'dist manifest entry')
    lowercaseSHA256(entry.sha256, 'dist manifest entry SHA-256')
    if (!Number.isInteger(entry.bytes) || entry.bytes < 0 || assets.has(entry.path)) {
      fail('dist manifest entry is invalid or duplicated')
    }
    const pathname = safeManifestPath(config.dist_root, entry.path)
    const metadata = lstatSync(pathname)
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      fail('attested release asset must remain a regular non-symlink file')
    }
    const bytes = await readFile(pathname)
    if (
      bytes.length !== entry.bytes
      || createHash('sha256').update(bytes).digest('hex') !== entry.sha256
    ) {
      fail('attested release asset bytes changed before gateway bind')
    }
    totalBytes += bytes.length
    assets.set(entry.path, bytes)
  }
  if (!assets.has('index.html') || totalBytes !== attestation.distTotalBytes) {
    fail('attested release asset set is incomplete')
  }
  return assets
}

export async function prepareReleaseStaticGateway(raw, deps = {}) {
  const config = normalizeReleaseStaticGatewayConfig(raw)
  const verify = deps.verifyReleaseAttestation ?? verifyReleaseAttestation
  const options = {
    distRoot: config.dist_root,
    releaseVersion: config.release_version,
    installedAppBinary: config.installed_app_binary,
    sidecarBinary: config.sidecar_binary,
    packagePath: config.package_path,
    manifestPath: config.dist_manifest_path,
    receiptPath: config.release_attestation_path,
    expectedReceiptSHA256: config.release_attestation_sha256,
  }
  const attestation = await verify(options)
  for (const [name, digest] of [
    ['receipt', attestation?.receiptSHA256],
    ['manifest', attestation?.manifestSHA256],
    ['installed app', attestation?.installedAppSHA256],
    ['Sidecar', attestation?.sidecarSHA256],
    ['package', attestation?.packageSHA256],
  ]) {
    lowercaseSHA256(digest, `${name} SHA-256`)
  }
  if (attestation.receiptSHA256 !== config.release_attestation_sha256) {
    fail('release attestation identity drift')
  }
  if (
    !Number.isInteger(attestation.distFileCount)
    || attestation.distFileCount < 1
    || !Number.isInteger(attestation.distTotalBytes)
    || attestation.distTotalBytes < 1
  ) {
    fail('release attestation asset totals are invalid')
  }
  const assets = await loadAttestedAssets(config, attestation)
  return Object.freeze({ config, attestation: Object.freeze({ ...attestation }), assets })
}

function decodedRequestPath(requestURL) {
  const rawPath = String(requestURL ?? '').split(/[?#]/, 1)[0]
  if (!rawPath.startsWith('/')) return { error: 400 }
  let pathname
  try {
    pathname = decodeURIComponent(rawPath)
  } catch {
    return { error: 400 }
  }
  if (
    pathname.includes('\0')
    || pathname.includes('\\')
    || pathname.split('/').some((part) => part === '..')
  ) {
    return { error: 400 }
  }
  return { pathname }
}

function mimeType(pathname) {
  const types = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.ico': 'image/x-icon',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.wasm': 'application/wasm',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
  }
  return types[extname(pathname).toLowerCase()] ?? 'application/octet-stream'
}

function simpleResponse(status, body, headers = {}) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body)
  return {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-length': bytes.length,
      'content-type': 'text/plain; charset=utf-8',
      ...headers,
    },
    body: bytes,
  }
}

export function resolveReleaseStaticResponse(prepared, request) {
  const method = String(request?.method ?? 'GET').toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') {
    return simpleResponse(405, 'Method Not Allowed\n', { allow: 'GET, HEAD' })
  }
  const decoded = decodedRequestPath(request?.url)
  if (decoded.error) return simpleResponse(decoded.error, 'Bad Request\n')
  let assetPath = decoded.pathname.replace(/^\/+/, '')
  if (assetPath === '') assetPath = 'index.html'
  let bytes = prepared.assets.get(assetPath)
  if (!bytes && extname(assetPath) === '') {
    assetPath = 'index.html'
    bytes = prepared.assets.get(assetPath)
  }
  if (!bytes) return simpleResponse(404, 'Not Found\n')
  const headers = {
    'cache-control': 'no-store',
    'content-length': bytes.length,
    'content-type': mimeType(assetPath),
  }
  return {
    status: 200,
    headers,
    body: method === 'HEAD' ? Buffer.alloc(0) : bytes,
  }
}

function matchesNamespace(pathname, namespace) {
  return pathname === namespace || pathname.startsWith(`${namespace}/`)
}

export function normalizeReleaseGatewayRoute(pathname) {
  if (pathname === ATTESTATION_PATH) {
    return Object.freeze({ classification: 'attestation', upstreamPathname: pathname })
  }
  let upstreamPathname = pathname
  if (
    matchesNamespace(pathname, `${RELEASE_PROXY_PREFIX}/api`)
    || matchesNamespace(pathname, `${RELEASE_PROXY_PREFIX}/ws`)
  ) {
    upstreamPathname = pathname.slice(RELEASE_PROXY_PREFIX.length)
  }
  if (matchesNamespace(upstreamPathname, '/ws')) {
    return Object.freeze({ classification: 'websocket-proxy', upstreamPathname })
  }
  if (
    matchesNamespace(upstreamPathname, '/api')
    || upstreamPathname === '/health'
    || upstreamPathname === '/version'
  ) {
    return Object.freeze({ classification: 'http-proxy', upstreamPathname })
  }
  return Object.freeze({ classification: 'static', upstreamPathname })
}

export function classifyReleaseGatewayPath(pathname) {
  return normalizeReleaseGatewayRoute(pathname).classification
}

export function mapReleaseGatewayProxyURL(raw, requestURL, websocket = false) {
  const config = raw.releaseUIURL ? raw : normalizeReleaseStaticGatewayConfig(raw)
  const incoming = new URL(requestURL, RELEASE_UI_URL)
  const route = normalizeReleaseGatewayRoute(incoming.pathname)
  const target = new URL(`${route.upstreamPathname}${incoming.search}`, config.sidecar_url)
  if (websocket) target.protocol = 'ws:'
  return target.toString()
}

function safeAttestationBody(prepared) {
  return Buffer.from(`${JSON.stringify({
    schema_version: 1,
    release_version: prepared.config.release_version,
    receipt_sha256: prepared.attestation.receiptSHA256,
    manifest_sha256: prepared.attestation.manifestSHA256,
    installed_app_sha256: prepared.attestation.installedAppSHA256,
    sidecar_sha256: prepared.attestation.sidecarSHA256,
    package_sha256: prepared.attestation.packageSHA256,
    dist_file_count: prepared.attestation.distFileCount,
    dist_total_bytes: prepared.attestation.distTotalBytes,
  })}\n`)
}

function writeResponse(response, result) {
  response.writeHead(result.status, result.headers)
  response.end(result.body)
}

function proxyHTTP(prepared, incoming, response) {
  const target = new URL(mapReleaseGatewayProxyURL(prepared.config, incoming.url, false))
  const headers = { ...incoming.headers }
  const outgoing = httpRequest({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port,
    method: incoming.method,
    path: `${target.pathname}${target.search}`,
    headers,
  }, (upstream) => {
    response.writeHead(upstream.statusCode ?? 502, upstream.headers)
    upstream.pipe(response)
  })
  outgoing.once('error', () => {
    if (!response.headersSent) writeResponse(response, simpleResponse(502, 'Bad Gateway\n'))
    else response.destroy()
  })
  incoming.pipe(outgoing)
}

function proxyWebSocket(prepared, request, socket, head) {
  const target = new URL(mapReleaseGatewayProxyURL(prepared.config, request.url, true))
  const upstream = connectTCP({
    host: target.hostname,
    port: Number(target.port),
  })
  upstream.once('connect', () => {
    upstream.write(`${request.method} ${target.pathname}${target.search} HTTP/${request.httpVersion}\r\n`)
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      const name = request.rawHeaders[index]
      upstream.write(`${name}: ${request.rawHeaders[index + 1]}\r\n`)
    }
    upstream.write('\r\n')
    if (head.length > 0) upstream.write(head)
    socket.pipe(upstream).pipe(socket)
  })
  upstream.once('error', () => socket.destroy())
  socket.once('error', () => upstream.destroy())
}

export function createReleaseStaticGatewayServer(prepared) {
  const server = createServer((request, response) => {
    const incomingURL = new URL(request.url ?? '/', RELEASE_UI_URL)
    const classification = classifyReleaseGatewayPath(incomingURL.pathname)
    if (classification === 'attestation') {
      if (!['GET', 'HEAD'].includes(request.method ?? 'GET')) {
        writeResponse(response, simpleResponse(405, 'Method Not Allowed\n', { allow: 'GET, HEAD' }))
        return
      }
      const body = safeAttestationBody(prepared)
      writeResponse(response, {
        status: 200,
        headers: {
          'cache-control': 'no-store',
          'content-length': body.length,
          'content-type': 'application/json; charset=utf-8',
        },
        body: request.method === 'HEAD' ? Buffer.alloc(0) : body,
      })
      return
    }
    if (classification === 'http-proxy') {
      proxyHTTP(prepared, request, response)
      return
    }
    if (classification === 'websocket-proxy') {
      writeResponse(response, simpleResponse(426, 'Upgrade Required\n', { upgrade: 'websocket' }))
      return
    }
    writeResponse(response, resolveReleaseStaticResponse(prepared, request))
  })
  server.on('upgrade', (request, socket, head) => {
    const incomingURL = new URL(request.url ?? '/', RELEASE_UI_URL)
    if (classifyReleaseGatewayPath(incomingURL.pathname) !== 'websocket-proxy') {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      return
    }
    proxyWebSocket(prepared, request, socket, head)
  })
  return server
}

async function defaultListenGateway(prepared) {
  const server = createReleaseStaticGatewayServer(prepared)
  await new Promise((resolvePromise, rejectPromise) => {
    const onError = (error) => {
      server.off('listening', onListening)
      rejectPromise(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolvePromise()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(prepared.config.port, prepared.config.host)
  })
  return Object.freeze({
    origin: RELEASE_UI_URL,
    close: () => new Promise((resolvePromise, rejectPromise) => {
      server.close((error) => error ? rejectPromise(error) : resolvePromise())
    }),
  })
}

export async function startReleaseStaticGateway(raw, deps = {}) {
  const prepared = await prepareReleaseStaticGateway(raw, deps)
  try {
    return await (deps.listenGateway ?? defaultListenGateway)(prepared)
  } catch (error) {
    if (error?.code === 'EADDRINUSE') {
      fail('canonical release UI port 16060 is occupied; refusing owner reuse or signal')
    }
    throw error
  }
}

function readPrivateConfig(pathname) {
  if (!isAbsolute(pathname)) fail('config path must be absolute')
  const metadata = lstatSync(pathname)
  if (
    metadata.isSymbolicLink()
    || !metadata.isFile()
    || (metadata.mode & 0o777) !== PRIVATE_FILE_MODE
  ) {
    fail('config must be a private 0600 regular non-symlink file')
  }
  let config
  try {
    config = JSON.parse(readFileSync(pathname, 'utf8'))
  } catch {
    fail('config is not valid JSON')
  }
  return config
}

async function runCLI(argv) {
  if (
    argv.length !== 3
    || argv[0] !== 'start'
    || argv[1] !== '--config'
    || !isAbsolute(argv[2])
  ) {
    fail('usage: start --config <absolute-json>')
  }
  const gateway = await startReleaseStaticGateway(readPrivateConfig(argv[2]))
  let closing
  const close = () => {
    closing ??= gateway.close()
      .catch(() => undefined)
      .finally(() => {
        process.exitCode = 0
      })
  }
  process.once('SIGINT', close)
  process.once('SIGTERM', close)
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  runCLI(process.argv.slice(2)).catch((error) => {
    process.exitCode = 1
    process.stderr.write(`${error.message}\n`)
  })
}
