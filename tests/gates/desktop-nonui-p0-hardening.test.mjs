import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const root = process.cwd()
const read = (path) => readFileSync(join(root, path), 'utf8')

test('DESKTOP-BOUNDARY-PRINT-002/003 uses the dynamic authenticated Sidecar client and conflict proof', () => {
  const coordinator = read('src-tauri/src/print_coordinator.rs')

  assert.doesNotMatch(coordinator, /127\.0\.0\.1:8787|localhost:8787/)
  assert.match(coordinator, /SidecarClient/)
  assert.match(coordinator, /operation_lock/)
  assert.match(coordinator, /verify_(?:existing_)?receipt/)
  assert.match(coordinator, /SidecarClient::is_conflict/)
})

test('DESKTOP-BOUNDARY-CRED-001/002 preserves secrets by credential reference, never masked-to-empty', () => {
  const providerSecrets = read('src/stores/settings-provider-secrets.ts')
  const secureStore = read('src/utils/secure-store.ts')
  const coordinator = read('src-tauri/src/provider_credentials.rs')
  const commands = read('src-tauri/src/commands.rs')

  assert.doesNotMatch(providerSecrets, /provider\.apiKey\s*=\s*['"]['"]/) 
  assert.match(providerSecrets, /credentialRef/)
  assert.match(providerSecrets, /preserve/)
  assert.doesNotMatch(secureStore, /loadSecureValue|resolve_credential/)
  assert.match(secureStore, /await invoke(?:<[^>]+>)?\('(?:put|delete)_credential'/)
  assert.match(coordinator, /provider-credentials\/reserve/)
  assert.match(coordinator, /credentials\/hydrate/)
  assert.match(coordinator, /credentials\/dehydrate/)
  assert.match(coordinator, /apply_llm_config_with_credentials/)
  assert.match(coordinator, /PendingConfigMutation/)
  assert.match(coordinator, /Idempotency-Key/)
  assert.match(coordinator, /credential_ref_not_hydrated/)
  assert.match(coordinator, /replacement_digests/)
  assert.match(coordinator, /rollback_uncommitted_transaction/)
  assert.doesNotMatch(coordinator, /Rejected\s*\{\s*status:\s*422\s*,\s*\.\./)
  assert.doesNotMatch(commands, /api\/internal\/desktop\/credentials/)
})

test('DESKTOP-BOUNDARY-FILE-001/004 has only native-issued, one-shot purpose-bound grants', () => {
  const nativeFile = read('src-tauri/src/native_file.rs')
  const sidecarClient = read('src-tauri/src/sidecar_client.rs')
  const lib = read('src-tauri/src/lib.rs')
  const nativeApi = read('src/api/native-files.ts')

  assert.doesNotMatch(nativeFile, /pub async fn (?:open|save)_file_grant\s*\([\s\S]{0,200}path:\s*String/)
  assert.doesNotMatch(nativeFile, /pub async fn (?:upload|download)_file_grant\s*\([\s\S]{0,240}url:\s*String/)
  assert.match(nativeFile, /pick_(?:open|save)_file_grant/)
  assert.match(nativeFile, /fn consume\(/)
  assert.match(nativeFile, /window_label/)
  assert.match(nativeFile, /operation_id/)
  assert.match(nativeFile, /MAX_ATTACHMENT_BYTES:\s*u64\s*=\s*200\s*\*\s*1024\s*\*\s*1024/)
  assert.match(nativeFile, /open_verified_read_grant/)
  assert.match(nativeFile, /O_NOFOLLOW/)
  assert.match(nativeFile, /purge_expired/)
  assert.match(nativeFile, /ReaderStream::new\(file\)/)
  assert.match(sidecarClient, /redirect\(.*Policy::none/s)
  assert.doesNotMatch(lib, /commands::render_artifact_to_path|native_file::open_file_grant|native_file::save_file_grant/)
  assert.doesNotMatch(nativeApi, /grantLocalPath\(path|grantSavePath\(path/)
})

test('DESKTOP-BOUNDARY-SCHEMA-001..005 keeps ImageTask wire validation generated and fresh', () => {
  const pkg = read('package.json')
  const api = read('src/api/k12.ts')
  const generated = read('src/contracts/generated/k12-image-task.v1.ts')

  assert.match(pkg, /"contracts:check"/)
  assert.match(generated, /Code generated.*DO NOT EDIT/)
  assert.match(api, /assertK12ImageTaskCreateResponse/)
  assert.doesNotMatch(api, /function assertImageTask|function normalizeImageTaskWire/)
})

test('Desktop Sidecar requests use one in-memory capability and never expose it to renderer', () => {
  const sidecar = read('src-tauri/src/sidecar.rs')
  const client = read('src-tauri/src/sidecar_client.rs')
  const apiClient = read('src/api/client.ts')
  const chat = read('src/services/chatService.ts')
  const stream = read('src-tauri/src/sidecar_stream.rs')
  const socket = read('src-tauri/src/sidecar_socket.rs')
  const tasks = read('src/api/tasks.ts')
  const ollama = read('src/api/ollama.ts')

  assert.match(sidecar, /HEXCLAW_SIDECAR_CAPABILITY_TOKEN/)
  assert.match(client, /AUTHORIZATION/)
  assert.match(client, /Bearer/)
  assert.match(apiClient, /sidecarFetch/)
  assert.match(chat, /NativeSidecarWebSocket/)
  assert.match(stream, /CancellationToken/)
  assert.match(socket, /mpsc::channel\(SOCKET_COMMAND_BUFFER\)/)
  assert.match(socket, /MAX_ACTIVE_SOCKETS/)
  assert.match(tasks, /sidecarStreamFetch/)
  assert.match(ollama, /sidecarStreamFetch/)
  assert.doesNotMatch(apiClient, /capabilityToken|SIDECAR_CAPABILITY/)
  assert.doesNotMatch(chat, /capabilityToken|SIDECAR_CAPABILITY/)
})

test('chat wire attachments contain only server-issued attachment IDs', () => {
  const chat = read('src/services/chatService.ts')
  const websocket = read('src/api/websocket.ts')
  const attachments = read('src/api/attachments.ts')

  assert.match(chat, /return \{ attachment_id: attachment\.attachmentId \}/)
  assert.doesNotMatch(chat, /return \{[^}]*data:\s*attachment\.data/)
  assert.match(websocket, /interface WsAttachment\s*\{\s*attachment_id:\s*string/)
  assert.match(attachments, /receipt\.digest !== `sha256:\$\{expectedDigest\}`/)
  assert.match(attachments, /missing its attested source digest/)
})
