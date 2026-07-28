import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const repoFile = (path) => new URL(`../../${path}`, import.meta.url)

async function loadDriver() {
  return import(repoFile('scripts/ci/k12-c10-isolated-restart-driver.mjs'))
}

function config() {
  return {
    schema_version: 1,
    profile_dir: '/tmp/hexclaw-c10/profile',
    sidecar_config_path: '/tmp/hexclaw-c10/profile/.hexclaw/hexclaw.yaml',
    sidecar_config_sha256: 'a'.repeat(64),
    binary_path: '/Applications/HexClaw.app/Contents/MacOS/hexclaw',
    binary_sha256: 'b'.repeat(64),
    expected_version: '0.5.0-beta',
    port: 16181,
    pre_envelope_path: '/tmp/hexclaw-c10/pre-envelope.json',
    pre_public_key_path: '/tmp/hexclaw-c10/pre-public.pem',
    pre_public_key_sha256: 'c'.repeat(64),
    query_request_path: '/tmp/hexclaw-c10/query.json',
    post_envelope_path: '/tmp/hexclaw-c10/post-envelope.json',
    post_public_key_path: '/tmp/hexclaw-c10/post-public.pem',
    evidence_dir: '/tmp/hexclaw-c10/evidence',
  }
}

function pre(overrides = {}) {
  return {
    schema_version: 1,
    phase: 'before',
    run_id: 'release-run-C10',
    cycle_id: 'C10',
    restart_method: 'caller_owned_process_restart',
    sidecar_pid: 4101,
    document_id: 'doc-1',
    source_digest: '657e1547074668dbb50f2bf37f13c20f292127be64c26c5334190aa34d06de83',
    active_revision_id: 'rev-1',
    profile_id: 'ollama:qwen3-embedding:8b',
    profile_config_hash: 'profile-hash-1',
    upload_count: 1,
    index_count: 1,
    query_model: 'qwen3-embedding:8b',
    query_digest: 'sha256:query-1',
    hit_document_id: 'doc-1',
    citation_digest: 'citation-digest-1',
    page_start: 10,
    page_end: 10,
    ...overrides,
  }
}

function validationAdapters(value = config()) {
  const directories = new Set([value.profile_dir, value.evidence_dir])
  const executable = new Set([value.binary_path])
  const digests = new Map([
    [value.binary_path, value.binary_sha256],
    [value.sidecar_config_path, value.sidecar_config_sha256],
    [value.pre_public_key_path, value.pre_public_key_sha256],
  ])
  return {
    homeDir: '/Users/real-user',
    inspectPath: (path) => ({
      kind: directories.has(path)
        ? 'directory'
        : [value.post_envelope_path, value.post_public_key_path].includes(path)
          ? 'missing'
          : 'file',
      canonicalPath: path.replace(/^\/tmp\//, '/private/tmp/'),
      executable: executable.has(path),
    }),
    fileSHA256: (path) => digests.get(path) || 'd'.repeat(64),
  }
}

test('driver contract freezes isolated inputs, fixed endpoints and output policy', async () => {
  const contract = JSON.parse(
    await readFile(
      repoFile('tests/live/k12-c10-isolated-restart-driver.contract.json'),
      'utf8',
    ),
  )

  assert.equal(contract.schemaVersion, 1)
  assert.deepEqual(contract.cli, [
    '--restart-k12-sidecar',
    '--config',
    '<absolute-/tmp-config.json>',
  ])
  assert.deepEqual(contract.sidecarArgs, [
    'serve',
    '--desktop',
    '--config',
    '<sidecar_config_path>',
  ])
  assert.deepEqual(contract.allowedHTTP, [
    'GET /health',
    'GET /api/v1/version',
    'POST /api/v1/knowledge/search',
    'GET /api/v1/knowledge/corpora/default/embedding-policy',
  ])
  assert.deepEqual(contract.forbiddenPorts, [18080, 16060])
  assert.deepEqual(contract.forbiddenNetworkWrites, [
    'POST /api/v1/knowledge/documents',
    'POST /api/v1/knowledge/documents/{id}/reindex',
  ])
  assert.equal(contract.postSignature.algorithm, 'Ed25519')
  assert.equal(contract.postSignature.privateKeyPersistence, 'forbidden')
  assert.deepEqual(contract.stdout, ['absolute_evidence_path'])
})

test('config validation rejects default-profile, path escape, drift, extra fields and forbidden ports before spawn', async () => {
  const { validateDriverConfig } = await loadDriver()
  const value = config()
  assert.deepEqual(
    validateDriverConfig(value, {
      configPath: '/tmp/hexclaw-c10/driver.json',
      ...validationAdapters(value),
    }),
    value,
  )

  for (const mutation of [
    { profile_dir: '/Users/real-user/.hexclaw' },
    { sidecar_config_path: '/Users/real-user/.hexclaw/hexclaw.yaml' },
    { binary_path: 'relative/hexclaw' },
    { port: 18080 },
    { port: 16060 },
    { port: 80 },
    { unexpected: true },
  ]) {
    const changed = { ...value, ...mutation }
    assert.throws(() =>
      validateDriverConfig(changed, {
        configPath: '/tmp/hexclaw-c10/driver.json',
        ...validationAdapters(changed),
      }),
    )
  }
  assert.throws(() =>
    validateDriverConfig(value, {
      configPath: '/tmp/hexclaw-c10/driver.json',
      ...validationAdapters(value),
      fileSHA256: () => '0'.repeat(64),
    }),
  )
  assert.throws(() =>
    validateDriverConfig(value, {
      configPath: '/tmp/hexclaw-c10/driver.json',
      ...validationAdapters(value),
      inspectPath: (path) => ({
        kind: path === value.profile_dir || path === value.evidence_dir ? 'directory' : 'file',
        canonicalPath: path === value.query_request_path
          ? '/Users/real-user/query.json'
          : path.replace(/^\/tmp\//, '/private/tmp/'),
        executable: path === value.binary_path,
      }),
    }),
  )
})

test('simulated lifecycle proves ownership, ordered restart, exact requery and zero network writes', async () => {
  const {
    runIsolatedRestart,
    verifyDriverPostEnvelope,
  } = await loadDriver()
  const value = config()
  const before = pre()
  const events = []
  let artifact
  const child = {
    pid: 4202,
    unrefCalled: false,
    unref() {
      this.unrefCalled = true
    },
  }
  const runtime = {
    inspectProcess: async (pid) => {
      events.push(`inspect:${pid}`)
      return {
        alive: true,
        command: `${value.binary_path} serve --desktop --config ${value.sidecar_config_path}`,
        listenerPorts: [value.port],
      }
    },
    requestJSON: async ({ method, path }) => {
      events.push(`${method} ${path}`)
      if (path === '/health') return { status: 'healthy' }
      if (path === '/api/v1/version') return { version: value.expected_version }
      if (path.startsWith('/api/v1/knowledge/search')) {
        return {
          results: [{
            doc_id: before.document_id,
            source_digest: before.source_digest,
            chunk_id: 'chunk-1',
            page_start: before.page_start,
            page_end: before.page_end,
            citation_digest: before.citation_digest,
          }],
          total: 1,
          query_receipts: [{
            operation: 'query_embedding',
            status: 'succeeded',
            provider_id: 'ollama',
            model: before.query_model,
            profile_id: before.profile_id,
            profile_config_hash: before.profile_config_hash,
            dimension: 4096,
            revision_id: before.active_revision_id,
            query_digest: before.query_digest,
          }],
        }
      }
      if (path.startsWith('/api/v1/knowledge/corpora/default/embedding-policy')) {
        return {
          active_revision: {
            revision_id: before.active_revision_id,
            profile_config_hash: before.profile_config_hash,
            profile: {
              profile_id: before.profile_id,
              provider_id: 'ollama',
              model_name: before.query_model,
              dimension: 4096,
            },
          },
        }
      }
      throw new Error('unexpected request')
    },
    stopProcess: async (pid) => events.push(`stop:${pid}`),
    waitForPortFree: async (port) => events.push(`port-free:${port}`),
    spawnProcess: (command, args, options) => {
      events.push('spawn')
      assert.equal(command, value.binary_path)
      assert.deepEqual(args, [
        'serve',
        '--desktop',
        '--config',
        value.sidecar_config_path,
      ])
      assert.equal(options.shell, false)
      assert.equal(options.env.HOME, value.profile_dir)
      assert.equal(options.env.HEXCLAW_TEST_HOME, value.profile_dir)
      assert.equal(options.env.DINGTALK_LIVE_SEND, '0')
      assert.equal(options.env.DINGTALK_CLIENT_SECRET, undefined)
      return child
    },
    cleanupProcess: async (target) => events.push(`cleanup:${target.pid}`),
    isAlive: async () => true,
    sleep: async () => undefined,
    writeArtifacts: async (valueToWrite) => {
      events.push('write')
      artifact = valueToWrite
      return '/tmp/hexclaw-c10/evidence/evidence.json'
    },
  }

  const result = await runIsolatedRestart(value, {
    pre: before,
    queryRequest: {
      query: 'private fixed oracle query',
      top_k: 10,
      user_id: 'desktop-user',
    },
    runtime,
  })

  assert.deepEqual(events, [
    'inspect:4101',
    'GET /health',
    'GET /api/v1/version',
    'stop:4101',
    'port-free:16181',
    'spawn',
    'GET /health',
    'GET /api/v1/version',
    'POST /api/v1/knowledge/search?user_id=desktop-user',
    'GET /api/v1/knowledge/corpora/default/embedding-policy?user_id=desktop-user',
    'write',
  ])
  assert.equal(result.evidencePath, '/tmp/hexclaw-c10/evidence/evidence.json')
  assert.equal(result.newPid, 4202)
  assert.equal(child.unrefCalled, true)
  assert.equal(artifact.evidence.network.upload, 0)
  assert.equal(artifact.evidence.network.index, 0)
  assert.equal(artifact.post.upload_count, before.upload_count)
  assert.equal(artifact.post.index_count, before.index_count)
  assert.deepEqual(
    verifyDriverPostEnvelope(artifact.envelope, artifact.publicKeyPem),
    artifact.post,
  )
  const serializedEvidence = JSON.stringify(artifact.evidence)
  assert.doesNotMatch(serializedEvidence, /private fixed oracle query/)
  assert.doesNotMatch(serializedEvidence, /doc-1|citation-digest-1|profile-hash-1/)
})

test('ownership mismatch never signals old PID and post-query drift cleans only the spawned child', async () => {
  const { runIsolatedRestart } = await loadDriver()
  const value = config()
  const before = pre()
  let stopped = false
  await assert.rejects(
    runIsolatedRestart(value, {
      pre: before,
      queryRequest: { query: 'fixed query', top_k: 10, user_id: 'desktop-user' },
      runtime: {
        inspectProcess: async () => ({
          alive: true,
          command: '/usr/bin/unrelated',
          listenerPorts: [value.port],
        }),
        requestJSON: async () => ({ status: 'healthy' }),
        stopProcess: async () => {
          stopped = true
        },
      },
    }),
  )
  assert.equal(stopped, false)

  const cleaned = []
  let phase = 'old'
  await assert.rejects(
    runIsolatedRestart(value, {
      pre: before,
      queryRequest: { query: 'fixed query', top_k: 10, user_id: 'desktop-user' },
      runtime: {
        inspectProcess: async () => ({
          alive: true,
          command: `${value.binary_path} serve --desktop --config ${value.sidecar_config_path}`,
          listenerPorts: [value.port],
        }),
        requestJSON: async ({ path }) => {
          if (path === '/health') return { status: 'healthy' }
          if (path === '/api/v1/version') {
            phase = 'new'
            return { version: value.expected_version }
          }
          if (path.startsWith('/api/v1/knowledge/search')) {
            return {
              results: [{
                doc_id: before.document_id,
                source_digest: before.source_digest,
                chunk_id: 'chunk-1',
                page_start: 10,
                page_end: 10,
                citation_digest: 'drifted-citation',
              }],
              total: 1,
              query_receipts: [{
                operation: 'query_embedding',
                status: 'succeeded',
                provider_id: 'ollama',
                model: before.query_model,
                profile_id: before.profile_id,
                profile_config_hash: before.profile_config_hash,
                dimension: 4096,
                revision_id: before.active_revision_id,
                query_digest: before.query_digest,
              }],
            }
          }
          if (path.startsWith('/api/v1/knowledge/corpora/default/embedding-policy')) {
            return { active_revision: {} }
          }
          throw new Error(`unexpected ${phase}`)
        },
        stopProcess: async () => undefined,
        waitForPortFree: async () => undefined,
        spawnProcess: () => ({ pid: 4202, unref() {} }),
        cleanupProcess: async (target) => cleaned.push(target.pid),
        isAlive: async () => true,
        sleep: async () => undefined,
        writeArtifacts: async () => {
          throw new Error('must not write')
        },
      },
    }),
  )
  assert.deepEqual(cleaned, [4202])
})

test('network recorder detects upload/reindex and signal cleanup targets only current child', async () => {
  const {
    assertZeroNetworkWrites,
    createNetworkRecorder,
    installSignalCleanup,
  } = await loadDriver()
  const recorder = createNetworkRecorder(async () => ({ ok: true }))
  await recorder.requestJSON({ method: 'POST', path: '/api/v1/knowledge/documents' })
  await recorder.requestJSON({
    method: 'POST',
    path: '/api/v1/knowledge/documents/doc-1/reindex',
  })
  assert.deepEqual(recorder.snapshot(), { upload: 1, index: 1 })
  assert.throws(() => assertZeroNetworkWrites(recorder.snapshot()))

  const processLike = new EventEmitter()
  processLike.exitCode = 0
  const child = { pid: 4202 }
  const cleaned = []
  const uninstall = installSignalCleanup(
    processLike,
    () => child,
    async (target) => cleaned.push(target.pid),
  )
  processLike.emit('SIGTERM')
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(cleaned, [4202])
  assert.equal(processLike.exitCode, 143)
  uninstall()
})

test('success output contains only the absolute evidence path', async () => {
  const { formatSuccessOutput } = await loadDriver()
  assert.equal(
    formatSuccessOutput('/tmp/hexclaw-c10/evidence/evidence.json'),
    '/tmp/hexclaw-c10/evidence/evidence.json\n',
  )
  assert.throws(() => formatSuccessOutput('relative/evidence.json'))
})
