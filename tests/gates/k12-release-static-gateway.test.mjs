import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const gatewayModuleURL = new URL('../../scripts/ci/k12-release-static-gateway.mjs', import.meta.url)
const attestationModuleURL = new URL('../../scripts/ci/k12-release-ui-attestation.mjs', import.meta.url)
const contractURL = new URL('../live/k12-release-static-gateway.contract.json', import.meta.url)

async function loadGateway() {
  return import(gatewayModuleURL)
}

async function releaseFixture(name) {
  const root = await mkdtemp(join(tmpdir(), `hexclaw-release-gateway-${name}-`))
  const distRoot = join(root, 'dist')
  await mkdir(join(distRoot, 'assets'), { recursive: true, mode: 0o700 })
  const indexBytes = Buffer.from('<!doctype html><script src="/assets/app.js"></script>\n')
  const scriptBytes = Buffer.from('console.log("exact release bytes")\n')
  await writeFile(join(distRoot, 'index.html'), indexBytes)
  await writeFile(join(distRoot, 'assets', 'app.js'), scriptBytes)

  const installedAppBinary = join(root, 'hexclaw-desktop')
  const sidecarBinary = join(root, 'hexclaw')
  const packagePath = join(root, 'HexClaw.dmg')
  await writeFile(installedAppBinary, 'installed-app-bytes\n')
  await writeFile(sidecarBinary, 'sidecar-bytes\n')
  await writeFile(packagePath, 'package-bytes\n')
  await chmod(installedAppBinary, 0o700)
  await chmod(sidecarBinary, 0o700)

  const distManifestPath = join(root, 'release-ui-dist-manifest.json')
  const releaseAttestationPath = join(root, 'release-ui-attestation.json')
  const { createReleaseAttestation } = await import(attestationModuleURL)
  const attested = await createReleaseAttestation({
    distRoot,
    releaseVersion: '0.5.0-beta',
    installedAppBinary,
    sidecarBinary,
    packagePath,
    manifestPath: distManifestPath,
    receiptPath: releaseAttestationPath,
  })

  return {
    indexBytes,
    scriptBytes,
    config: {
      schema_version: 1,
      host: '127.0.0.1',
      port: 16060,
      dist_root: distRoot,
      release_version: '0.5.0-beta',
      installed_app_binary: installedAppBinary,
      sidecar_binary: sidecarBinary,
      package_path: packagePath,
      dist_manifest_path: distManifestPath,
      release_attestation_path: releaseAttestationPath,
      release_attestation_sha256: attested.receiptSHA256,
      sidecar_url: 'http://127.0.0.1:16129',
    },
  }
}

test('gateway contract freezes exact release origin, direct Sidecar namespaces and prohibitions', async () => {
  const contract = JSON.parse(await readFile(contractURL, 'utf8'))
  assert.deepEqual(contract, {
    schemaVersion: 1,
    configFields: [
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
    ],
    listen: {
      host: '127.0.0.1',
      port: 16060,
      releaseUIURL: 'http://localhost:16060',
      occupiedPortPolicy: 'fail-closed-no-signal',
    },
    releaseUI: {
      source: 'attested-dist-only',
      bytePolicy: 'exact-no-transform',
      spaFallback: 'attested-index-for-extensionless-routes',
      attestationEndpoint: '/__hexclaw_release_attestation',
    },
    sidecar: {
      originPolicy: 'explicit-isolated-loopback-origin',
      httpProxyPaths: ['/api', '/health', '/version', '/_hexclaw/api -> /api'],
      webSocketProxyPaths: ['/ws', '/_hexclaw/ws -> /ws'],
      pathPolicy: 'direct-preserve-prefixed-strip-one-exact-prefix',
    },
    forbidden: [
      'asset-injection',
      'asset-rewrite',
      'foreign-port-kill',
      'foreign-port-reuse',
      'sidecar-static-root',
      'vite-preview',
    ],
  })
})

test('gateway validates the exact schema and loads only attested release bytes', async () => {
  const built = await releaseFixture('attested')
  const {
    normalizeReleaseStaticGatewayConfig,
    prepareReleaseStaticGateway,
    resolveReleaseStaticResponse,
  } = await loadGateway()

  const normalized = normalizeReleaseStaticGatewayConfig(built.config)
  assert.deepEqual(
    Object.keys(normalized).sort(),
    [...Object.keys(built.config), 'releaseUIURL'].sort(),
  )
  assert.equal(normalized.releaseUIURL, 'http://localhost:16060')

  const prepared = await prepareReleaseStaticGateway(built.config)
  assert.equal(prepared.attestation.receiptSHA256, built.config.release_attestation_sha256)
  assert.deepEqual(
    resolveReleaseStaticResponse(prepared, { method: 'GET', url: '/assets/app.js?cache=1' }),
    {
      status: 200,
      headers: {
        'cache-control': 'no-store',
        'content-length': built.scriptBytes.length,
        'content-type': 'text/javascript; charset=utf-8',
      },
      body: built.scriptBytes,
    },
  )
  assert.deepEqual(
    resolveReleaseStaticResponse(prepared, { method: 'GET', url: '/k12/tutor/card' }).body,
    built.indexBytes,
  )
})

test('gateway normalizes only approved release HTTP and WebSocket namespaces', async () => {
  const built = await releaseFixture('routing')
  const {
    classifyReleaseGatewayPath,
    mapReleaseGatewayProxyURL,
    prepareReleaseStaticGateway,
    resolveReleaseStaticResponse,
  } = await loadGateway()
  const prepared = await prepareReleaseStaticGateway(built.config)

  assert.equal(classifyReleaseGatewayPath('/api/v1/k12/cards'), 'http-proxy')
  assert.equal(classifyReleaseGatewayPath('/health'), 'http-proxy')
  assert.equal(classifyReleaseGatewayPath('/version'), 'http-proxy')
  assert.equal(classifyReleaseGatewayPath('/ws'), 'websocket-proxy')
  assert.equal(classifyReleaseGatewayPath('/ws/chat'), 'websocket-proxy')
  assert.equal(classifyReleaseGatewayPath('/_hexclaw/api/v1/k12/cards'), 'http-proxy')
  assert.equal(classifyReleaseGatewayPath('/_hexclaw/ws'), 'websocket-proxy')
  assert.equal(classifyReleaseGatewayPath('/settings'), 'static')
  assert.equal(classifyReleaseGatewayPath('/apiary'), 'static')
  assert.equal(classifyReleaseGatewayPath('/_hexclaw/apiary'), 'static')
  assert.equal(classifyReleaseGatewayPath('/_hexclaw/_hexclaw/api/v1/k12/cards'), 'static')
  assert.equal(
    mapReleaseGatewayProxyURL(built.config, '/api/v1/k12/cards?child=c1', false),
    'http://127.0.0.1:16129/api/v1/k12/cards?child=c1',
  )
  assert.equal(
    mapReleaseGatewayProxyURL(built.config, '/ws?session=s1', true),
    'ws://127.0.0.1:16129/ws?session=s1',
  )
  assert.equal(
    mapReleaseGatewayProxyURL(
      built.config,
      '/_hexclaw/api/v1/k12/cards?child=c1%2Fc2',
      false,
    ),
    'http://127.0.0.1:16129/api/v1/k12/cards?child=c1%2Fc2',
  )
  assert.equal(
    mapReleaseGatewayProxyURL(built.config, '/_hexclaw/ws?session=s1%2Fs2', true),
    'ws://127.0.0.1:16129/ws?session=s1%2Fs2',
  )

  assert.equal(
    resolveReleaseStaticResponse(prepared, { method: 'GET', url: '/assets/missing.js' }).status,
    404,
  )
  assert.equal(
    resolveReleaseStaticResponse(prepared, { method: 'POST', url: '/settings' }).status,
    405,
  )
  assert.equal(
    resolveReleaseStaticResponse(prepared, { method: 'GET', url: '/%2e%2e/release-ui-attestation.json' }).status,
    400,
  )
})

test('prefixed release API proxy preserves request and upstream response semantics', async () => {
  const requestBody = Buffer.from('{"cleanup":"agent-proof"}\n')
  const responseBody = Buffer.from('{"removed":true}\n')
  let resolveObserved
  const observed = new Promise((resolve) => {
    resolveObserved = resolve
  })
  const sidecar = createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      resolveObserved({
        method: request.method,
        url: request.url,
        contentType: request.headers['content-type'],
        proof: request.headers['x-hexclaw-proof'],
        body: Buffer.concat(chunks),
      })
      response.writeHead(207, {
        'content-type': 'application/vnd.hexclaw.receipt+json',
        'x-sidecar-receipt': 'cleanup-exact',
      })
      response.end(responseBody)
    })
  })
  await new Promise((resolve, reject) => {
    sidecar.once('error', reject)
    sidecar.listen(0, '127.0.0.1', resolve)
  })

  const built = await releaseFixture('prefixed-http')
  const sidecarAddress = sidecar.address()
  assert.ok(sidecarAddress && typeof sidecarAddress === 'object')
  built.config.sidecar_url = `http://127.0.0.1:${sidecarAddress.port}`

  const { startReleaseStaticGateway } = await loadGateway()
  let gateway
  try {
    gateway = await startReleaseStaticGateway(built.config)
    const received = await new Promise((resolve, reject) => {
      const outgoing = httpRequest({
        host: '127.0.0.1',
        port: 16060,
        method: 'DELETE',
        path: '/_hexclaw/api/v1/agents?id=agent%2Fproof&mode=cleanup',
        headers: {
          'content-length': requestBody.length,
          'content-type': 'application/json',
          'x-hexclaw-proof': 'request-exact',
        },
      }, (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => resolve({
          status: response.statusCode,
          contentType: response.headers['content-type'],
          receipt: response.headers['x-sidecar-receipt'],
          body: Buffer.concat(chunks),
        }))
      })
      outgoing.once('error', reject)
      outgoing.end(requestBody)
    })

    assert.deepEqual(await observed, {
      method: 'DELETE',
      url: '/api/v1/agents?id=agent%2Fproof&mode=cleanup',
      contentType: 'application/json',
      proof: 'request-exact',
      body: requestBody,
    })
    assert.deepEqual(received, {
      status: 207,
      contentType: 'application/vnd.hexclaw.receipt+json',
      receipt: 'cleanup-exact',
      body: responseBody,
    })
  } finally {
    if (gateway) await gateway.close()
    await new Promise((resolve, reject) => {
      sidecar.close((error) => error ? reject(error) : resolve())
    })
  }
})

test('gateway fails closed on occupied canonical port without signaling or reusing its owner', async () => {
  const built = await releaseFixture('occupied')
  const { startReleaseStaticGateway } = await loadGateway()
  const events = []
  const occupied = Object.assign(new Error('listen EADDRINUSE: address already in use'), {
    code: 'EADDRINUSE',
  })

  await assert.rejects(
    startReleaseStaticGateway(built.config, {
      listenGateway: async (prepared) => {
        events.push(['listen', prepared.config.host, prepared.config.port])
        throw occupied
      },
      signalProcess: () => {
        events.push(['signal'])
      },
    }),
    /canonical release UI port 16060 is occupied/,
  )
  assert.deepEqual(events, [['listen', '127.0.0.1', 16060]])
})

test('gateway fails before listen on release identity or exact-byte drift', async () => {
  const built = await releaseFixture('drift')
  const { startReleaseStaticGateway } = await loadGateway()
  await writeFile(join(built.config.dist_root, 'assets', 'app.js'), 'drift\n')
  let listened = false

  await assert.rejects(
    startReleaseStaticGateway(built.config, {
      listenGateway: async () => {
        listened = true
      },
    }),
  )
  assert.equal(listened, false)
})
