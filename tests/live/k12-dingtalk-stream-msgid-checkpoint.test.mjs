import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const LIVE_ROOT = dirname(fileURLToPath(import.meta.url))
const SCRIPT_PATH = resolve(LIVE_ROOT, 'k12-dingtalk-stream-msgid-checkpoint.mjs')
const CONTRACT_PATH = resolve(LIVE_ROOT, 'k12-dingtalk-stream-msgid-checkpoint.contract.json')
const modulePromise = import('./k12-dingtalk-stream-msgid-checkpoint.mjs')

const DIGEST = `sha256:${'a'.repeat(64)}`
const COMMAND_DIGEST = `sha256:${'b'.repeat(64)}`

function identity(providerMessageID) {
  return {
    platform: 'dingtalk',
    instance_id: 'bound-parent-instance',
    chat_id: 'direct-parent-chat',
    provider_message_id: providerMessageID,
  }
}

function admission(receiptID, assetID, dispatchID) {
  return {
    receipt_id: receiptID,
    asset_id: assetID,
    dispatch_id: dispatchID,
    command_digest: COMMAND_DIGEST,
    asset_digest: DIGEST,
  }
}

function observation(role, providerMessageID, suffix, ordering) {
  return {
    role,
    stream_observation_id: `native-stream-observation-${suffix}`,
    provider_message_id_origin: 'BotCallbackDataModel.MsgId',
    identity: identity(providerMessageID),
    image_digest: DIGEST,
    admission: admission(`receipt-${suffix}`, `asset-${suffix}`, `dispatch-${suffix}`),
    ordering,
  }
}

function checkpoint() {
  const sharedAdmission = admission('receipt-a', 'asset-a', 'dispatch-a')
  return {
    schema_version: 1,
    source: {
      transport: 'dingtalk_stream_sdk_go',
      callback_model: 'BotCallbackDataModel',
      callback_entrypoint: 'DingtalkAdapter.onChatBotMessage',
      bound_application_instance: true,
      signed_http_webhook_used: false,
      direct_dingtalk_api_used: false,
      dws_cli_used: false,
    },
    agent_name: 'xiaoming',
    observations: [
      {
        ...observation('original', 'provider-native-a', 'a-original', {
          callback_entered_seq: 10,
          v88_admission_committed_seq: 20,
          sdk_ack_returned_seq: 30,
          ack_success: true,
        }),
        admission: structuredClone(sharedAdmission),
      },
      {
        ...observation('redelivery', 'provider-native-a', 'a-redelivery', {
          callback_entered_seq: 40,
          v88_admission_committed_seq: 50,
          sdk_ack_returned_seq: 60,
          ack_success: true,
        }),
        admission: structuredClone(sharedAdmission),
      },
      observation('independent_same_bytes', 'provider-native-b', 'b', {
        callback_entered_seq: 70,
        v88_admission_committed_seq: 80,
        sdk_ack_returned_seq: 90,
        ack_success: true,
      }),
    ],
  }
}

function projection(providerMessageID, suffix) {
  return {
    receipt: {
      identity: identity(providerMessageID),
      agent_name: 'xiaoming',
      receipt_id: `receipt-${suffix}`,
      binding_id: 'binding-1',
      command_digest: COMMAND_DIGEST,
    },
    asset: {
      asset_id: `asset-${suffix}`,
      receipt_id: `receipt-${suffix}`,
      mime: 'image/png',
      size: 2178059,
      digest: DIGEST,
    },
    dispatch: {
      receipt_id: `receipt-${suffix}`,
      dispatch_id: `dispatch-${suffix}`,
      processing_status: 'final_artifact_ready',
      routing_decision: 'new_submission',
      confirmation_status: 'not_required',
      reply_status: 'delivered',
      version: 5,
      image_task_id: `image-task-${suffix}`,
      final_artifact_id: `artifact-${suffix}`,
      delivery_batch_id: `batch-${suffix}`,
    },
  }
}

test('contract permits only a genuine bound-app DingTalk Stream checkpoint and read-only public GET', async () => {
  const { validateContract } = await modulePromise
  const contract = JSON.parse(await readFile(CONTRACT_PATH, 'utf8'))
  const result = validateContract(contract)

  assert.deepEqual(result.phases, ['validate', 'verify-current', 'verify-restart', 'status'])
  assert.equal(result.requiredTransport, 'dingtalk_stream_sdk_go')
  assert.equal(result.callbackModel, 'BotCallbackDataModel')
  assert.equal(result.callbackEntrypoint, 'DingtalkAdapter.onChatBotMessage')
  assert.deepEqual(result.requiredRoles, ['original', 'redelivery', 'independent_same_bytes'])
  assert.equal(result.publicQuery.method, 'GET')
  assert.equal(result.publicQuery.path, '/api/k12/dingtalk-inbound')
  assert.deepEqual(result.checkpointInput, {
    fileMode: '0600',
    topLevel: ['schema_version', 'source', 'agent_name', 'observations'],
    source: [
      'transport',
      'callback_model',
      'callback_entrypoint',
      'bound_application_instance',
      'signed_http_webhook_used',
      'direct_dingtalk_api_used',
      'dws_cli_used',
    ],
    observation: [
      'role',
      'stream_observation_id',
      'provider_message_id_origin',
      'identity',
      'image_digest',
      'admission',
      'ordering',
    ],
    identity: ['platform', 'instance_id', 'chat_id', 'provider_message_id'],
    admission: ['receipt_id', 'asset_id', 'dispatch_id', 'command_digest', 'asset_digest'],
    ordering: [
      'callback_entered_seq',
      'v88_admission_committed_seq',
      'sdk_ack_returned_seq',
      'ack_success',
    ],
  })
  assert.deepEqual(result.forbiddenActions, [
    'signed_http_webhook',
    'callback_injection',
    'direct_dingtalk_api',
    'dws_cli',
    'outbound_send',
    'direct_store_read_or_write',
  ])
  assert.deepEqual(result.restartExactSet, [
    'receipt.identity',
    'receipt.agent_name',
    'receipt.receipt_id',
    'receipt.binding_id',
    'receipt.command_digest',
    'asset.asset_id',
    'asset.receipt_id',
    'asset.mime',
    'asset.size',
    'asset.digest',
    'dispatch.receipt_id',
    'dispatch.dispatch_id',
    'dispatch.processing_status',
    'dispatch.routing_decision',
    'dispatch.confirmation_status',
    'dispatch.reply_status',
    'dispatch.version',
    'dispatch.image_task_id',
    'dispatch.final_artifact_id',
    'dispatch.delivery_batch_id',
  ])
})

test('valid checkpoint proves native MsgId replay convergence, independent same-bytes identity and ACK ordering', async () => {
  const { validateCheckpoint } = await modulePromise
  const result = validateCheckpoint(checkpoint())

  assert.deepEqual(result.uniqueProviderMessageIDs, ['provider-native-a', 'provider-native-b'])
  assert.equal(result.original.admission.receipt_id, result.redelivery.admission.receipt_id)
  assert.equal(result.original.admission.dispatch_id, result.redelivery.admission.dispatch_id)
  assert.notEqual(result.original.admission.receipt_id, result.independent.admission.receipt_id)
  assert.notEqual(result.original.admission.dispatch_id, result.independent.admission.dispatch_id)
  assert.equal(result.original.image_digest, result.independent.image_digest)
})

test('checkpoint fails closed for webhook evidence, blank native identity and incomplete callback ordering', async () => {
  const { validateCheckpoint } = await modulePromise

  const webhook = checkpoint()
  webhook.source.transport = 'signed_http_webhook'
  webhook.source.signed_http_webhook_used = true
  assert.throws(() => validateCheckpoint(webhook), /STREAM_SOURCE_REQUIRED/u)

  const blank = checkpoint()
  blank.observations[0].identity.provider_message_id = '  '
  assert.throws(() => validateCheckpoint(blank), /PROVIDER_MESSAGE_ID_REQUIRED/u)

  const generated = checkpoint()
  generated.observations[0].provider_message_id_origin = 'generated_random_fallback'
  assert.throws(() => validateCheckpoint(generated), /RANDOM_FALLBACK_ID_FORBIDDEN/u)

  const earlyACK = checkpoint()
  earlyACK.observations[1].ordering.sdk_ack_returned_seq = 45
  assert.throws(() => validateCheckpoint(earlyACK), /ACK_PRECEDED_V88_COMMIT/u)

  const missingACK = checkpoint()
  missingACK.observations[2].ordering.ack_success = false
  assert.throws(() => validateCheckpoint(missingACK), /STREAM_ACK_NOT_SUCCESSFUL/u)
})

test('checkpoint fails closed unless replay and independent-message invariants are exact', async () => {
  const { validateCheckpoint } = await modulePromise

  const replayChangedReceipt = checkpoint()
  replayChangedReceipt.observations[1].admission.receipt_id = 'receipt-replayed-new'
  assert.throws(() => validateCheckpoint(replayChangedReceipt), /REDELIVERY_ADMISSION_DRIFT/u)

  const replayChangedDigest = checkpoint()
  replayChangedDigest.observations[1].image_digest = `sha256:${'c'.repeat(64)}`
  replayChangedDigest.observations[1].admission.asset_digest =
    replayChangedDigest.observations[1].image_digest
  assert.throws(() => validateCheckpoint(replayChangedDigest), /REDELIVERY_PAYLOAD_DRIFT/u)

  const independentReusedMsgID = checkpoint()
  independentReusedMsgID.observations[2].identity.provider_message_id = 'provider-native-a'
  assert.throws(() => validateCheckpoint(independentReusedMsgID), /INDEPENDENT_MSGID_REQUIRED/u)

  const independentReusedReceipt = checkpoint()
  independentReusedReceipt.observations[2].admission.receipt_id = 'receipt-a'
  assert.throws(
    () => validateCheckpoint(independentReusedReceipt),
    /INDEPENDENT_ADMISSION_REQUIRED/u,
  )

  const differentBytes = checkpoint()
  differentBytes.observations[2].image_digest = `sha256:${'d'.repeat(64)}`
  differentBytes.observations[2].admission.asset_digest =
    differentBytes.observations[2].image_digest
  assert.throws(() => validateCheckpoint(differentBytes), /SAME_IMAGE_BYTES_REQUIRED/u)
})

test('public query uses exact full identity, one GET and a process capability without serializing it', async () => {
  const { queryInboundProjection } = await modulePromise
  const calls = []
  const response = projection('provider-native-a', 'a')
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init })
    return {
      ok: true,
      status: 200,
      async json() {
        return response
      },
    }
  }

  const result = await queryInboundProjection({
    fetchImpl,
    baseURL: 'http://127.0.0.1:16060',
    capability: 'private-process-capability',
    agentName: 'xiaoming',
    identity: identity('provider-native-a'),
  })

  assert.deepEqual(result, response)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].init.method, 'GET')
  assert.equal(calls[0].init.headers.Authorization, 'Bearer private-process-capability')
  const requestURL = new URL(calls[0].url)
  assert.equal(requestURL.pathname, '/api/k12/dingtalk-inbound')
  assert.equal(requestURL.searchParams.get('agent'), 'xiaoming')
  assert.equal(requestURL.searchParams.get('platform'), 'dingtalk')
  assert.equal(requestURL.searchParams.get('instance_id'), 'bound-parent-instance')
  assert.equal(requestURL.searchParams.get('chat_id'), 'direct-parent-chat')
  assert.equal(requestURL.searchParams.get('provider_message_id'), 'provider-native-a')
})

test('current public projections match both native identities and preserve replay/independent semantics', async () => {
  const { assertCurrentProjections } = await modulePromise
  const input = checkpoint()
  const projections = new Map([
    ['provider-native-a', projection('provider-native-a', 'a')],
    ['provider-native-b', projection('provider-native-b', 'b')],
  ])

  const snapshot = assertCurrentProjections(input, projections)
  assert.equal(snapshot.projections.length, 2)
  assert.equal(snapshot.projections[0].receipt.receipt_id, 'receipt-a')
  assert.equal(snapshot.projections[1].receipt.receipt_id, 'receipt-b')

  const wrongIdentity = structuredClone(projections.get('provider-native-a'))
  wrongIdentity.receipt.identity.provider_message_id = 'provider-native-b'
  const drifted = new Map(projections)
  drifted.set('provider-native-a', wrongIdentity)
  assert.throws(() => assertCurrentProjections(input, drifted), /PUBLIC_IDENTITY_DRIFT/u)

  const nonTerminal = structuredClone(projections.get('provider-native-b'))
  nonTerminal.dispatch.reply_status = 'pending'
  const unstable = new Map(projections)
  unstable.set('provider-native-b', nonTerminal)
  assert.throws(() => assertCurrentProjections(input, unstable), /PUBLIC_PROJECTION_NOT_STABLE/u)
})

test('restart verification is public-GET exact and rejects any mutable-field drift', async () => {
  const { assertRestartExact } = await modulePromise
  const before = [projection('provider-native-a', 'a'), projection('provider-native-b', 'b')]
  assert.deepEqual(assertRestartExact(before, structuredClone(before)), before)

  const after = structuredClone(before)
  after[0].dispatch.version += 1
  assert.throws(() => assertRestartExact(before, after), /RESTART_EXACT_SET_DRIFT/u)
})

test('sanitized evidence hashes all private identities and never includes capability or raw MsgId', async () => {
  const { sanitizeEvidence } = await modulePromise
  const secret = 'private-process-capability'
  const raw = checkpoint()
  const evidence = sanitizeEvidence(raw, [
    projection('provider-native-a', 'a'),
    projection('provider-native-b', 'b'),
  ])
  const serialized = JSON.stringify(evidence)

  assert.equal(serialized.includes(secret), false)
  assert.equal(serialized.includes('provider-native-a'), false)
  assert.equal(serialized.includes('provider-native-b'), false)
  assert.equal(serialized.includes('bound-parent-instance'), false)
  assert.equal(serialized.includes('direct-parent-chat'), false)
  assert.match(serialized, /sha256:/u)
})

test('missing real callbacks yield an explicit checkpoint and never trigger send or callback injection', async () => {
  const { checkpointRequirements, phaseBudgetMilliseconds, resolvePhase } = await modulePromise
  assert.equal(resolvePhase([]), 'status')
  assert.equal(resolvePhase(['validate']), 'validate')
  assert.equal(resolvePhase(['verify-current']), 'verify-current')
  assert.equal(resolvePhase(['verify-restart']), 'verify-restart')
  assert.throws(() => resolvePhase(['send']), /INVALID_PHASE/u)
  assert.ok(phaseBudgetMilliseconds({}) > 0)
  assert.ok(phaseBudgetMilliseconds({}) < 30 * 60_000)

  assert.deepEqual(checkpointRequirements(), {
    status: 'checkpoint_required',
    checkpoint_contract: 'tests/live/k12-dingtalk-stream-msgid-checkpoint.contract.json',
    required_env: [
      'HEXCLAW_DINGTALK_STREAM_CHECKPOINT',
      'HEXCLAW_DINGTALK_STREAM_BASE_URL',
      'HEXCLAW_SIDECAR_CAPABILITY_TOKEN',
    ],
    required_real_observations: ['original', 'redelivery', 'independent_same_bytes'],
    prohibited_substitutes: [
      'signed HTTP webhook',
      'private callback injection',
      'dws or DingTalk CLI',
      'direct DingTalk API',
      'synthetic provider MsgId',
    ],
    next_actions: [
      'capture one normal bound-app DingTalk Stream image callback',
      'capture a provider redelivery with the same native MsgId and bytes',
      'capture a second normal Stream message with a different native MsgId and the same bytes',
      'record V88 commit before successful SDK ACK for every callback',
      'run verify-current, restart the caller-owned app, then run verify-restart',
    ],
  })

  const source = await readFile(SCRIPT_PATH, 'utf8')
  assert.doesNotMatch(source, /method:\s*['"]POST['"]/u)
  assert.doesNotMatch(source, /platforms\/hooks\/dingtalk/u)
  assert.doesNotMatch(source, /open\.dingtalk\.com|api\.dingtalk\.com/u)
  assert.doesNotMatch(source, /child_process|spawn\(|execFile\(/u)
})
