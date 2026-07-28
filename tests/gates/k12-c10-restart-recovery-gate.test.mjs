import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import test from 'node:test'

const repoFile = (path) => new URL(`../../${path}`, import.meta.url)

async function loadGate() {
  return import(repoFile('scripts/ci/k12-c10-restart-recovery-gate.mjs'))
}

function envelope(payload, privateKey) {
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8')
  return JSON.stringify({
    algorithm: 'Ed25519',
    payload_b64: bytes.toString('base64'),
    signature_b64: sign(null, bytes, privateKey).toString('base64'),
  })
}

function handoff(phase, overrides = {}) {
  return {
    schema_version: 1,
    phase,
    run_id: 'release-run-C10',
    cycle_id: 'C10',
    restart_method: 'caller_owned_process_restart',
    sidecar_pid: phase === 'before' ? 4101 : 4102,
    document_id: 'doc-1',
    source_digest: '657e1547074668dbb50f2bf37f13c20f292127be64c26c5334190aa34d06de83',
    active_revision_id: 'rev-1',
    profile_id: 'profile-1',
    profile_config_hash: 'profile-hash-1',
    upload_count: 1,
    index_count: 1,
    query_model: 'qwen3-embedding:8b',
    query_digest: 'query-digest-1',
    hit_document_id: 'doc-1',
    citation_digest: 'citation-digest-1',
    page_start: 10,
    page_end: 10,
    ...overrides,
  }
}

test('Ed25519 handoff verifier authenticates the exact encoded payload', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const { verifySignedHandoff } = await loadGate()
  const source = handoff('before')
  const signed = envelope(source, privateKey)

  assert.deepEqual(verifySignedHandoff(signed, publicKey), source)

  const tampered = JSON.parse(signed)
  tampered.payload_b64 = Buffer.from(
    JSON.stringify({ ...source, sidecar_pid: 9999 }),
    'utf8',
  ).toString('base64')
  assert.throws(() => verifySignedHandoff(JSON.stringify(tampered), publicKey), /signature/)
})

test('restart audit requires real PID turnover and stable revision/query/citation with zero writes', async () => {
  const { auditRestartHandoff } = await loadGate()
  const before = handoff('before')
  const after = handoff('after')

  assert.deepEqual(auditRestartHandoff(before, after), {
    beforePid: 4101,
    afterPid: 4102,
    documentId: 'doc-1',
    activeRevisionId: 'rev-1',
    profileConfigHash: 'profile-hash-1',
    uploadCountDelta: 0,
    indexCountDelta: 0,
    citationDigest: 'citation-digest-1',
  })

  for (const mutation of [
    { sidecar_pid: 4101 },
    { active_revision_id: 'rev-2' },
    { profile_config_hash: 'profile-hash-2' },
    { upload_count: 2 },
    { index_count: 2 },
    { citation_digest: 'citation-digest-2' },
    { restart_method: 'browser_reload' },
  ]) {
    assert.throws(() => auditRestartHandoff(before, handoff('after', mutation)))
  }
})

test('caller restart is invoked exactly once without a shell and DingTalk stays disabled', async () => {
  const { executeCallerRestart } = await loadGate()
  const calls = []
  const result = executeCallerRestart('/caller/restart-hook', {
    env: {
      DINGTALK_LIVE_SEND: '1',
      HEX_K12_C10_DRIVER_CONFIG: '/tmp/hexclaw-c10/driver.json',
    },
    spawn: (command, args, options) => {
      calls.push({ command, args, options })
      return { status: 0 }
    },
  })

  assert.equal(result, 0)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, '/caller/restart-hook')
  assert.deepEqual(calls[0].args, [
    '--restart-k12-sidecar',
    '--config',
    '/tmp/hexclaw-c10/driver.json',
  ])
  assert.equal(calls[0].options.shell, false)
  assert.equal(calls[0].options.env.DINGTALK_LIVE_SEND, '0')
})
