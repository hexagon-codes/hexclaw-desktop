import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const desktopRoot = process.cwd()
const hexclawRoot = join(desktopRoot, '..', 'hexclaw')

function read(root, relativePath) {
  const path = join(root, relativePath)
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

function productionSources(root, relativeDir) {
  const base = join(root, relativeDir)
  const entries = []
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!['__tests__', 'test', 'tests'].includes(entry.name)) visit(absolute)
        continue
      }
      if (!/\.(?:ts|vue|rs)$/.test(entry.name) || /\.test\./.test(entry.name)) continue
      entries.push({ path: absolute.slice(base.length + 1), source: readFileSync(absolute, 'utf8') })
    }
  }
  visit(base)
  return entries
}

test('BUG-20260802-013 uses opaque native file grants and removes base64 binary IPC', () => {
  const lib = read(desktopRoot, 'src-tauri/src/lib.rs')
  const commands = read(desktopRoot, 'src-tauri/src/commands.rs')
  const desktopApi = read(desktopRoot, 'src/api/desktop.ts')
  const download = read(desktopRoot, 'src/utils/download.ts')
  const exportSource = read(desktopRoot, 'src/features/k12/export.ts')
  const gradedPhoto = read(desktopRoot, 'src/features/k12/graded-photo.ts')
  const staleSaveConsumers = productionSources(desktopRoot, 'src').filter(({ source }) =>
    /save_file_from_url|save_bytes_to_path/.test(source),
  )

  assert.match(lib, /mod native_file/)
  assert.match(lib, /native_file::(?:open|save|upload)_.*grant/)
  assert.doesNotMatch(lib, /read_file_as_base64|save_bytes_to_path/)
  assert.doesNotMatch(commands, /pub fn read_file_as_base64|pub fn save_bytes_to_path/)
  assert.doesNotMatch(desktopApi, /read_file_as_base64|atob\(/)
  assert.doesNotMatch(download, /save_bytes_to_path|data:.*base64/)
  assert.doesNotMatch(exportSource, /bytesToBase64|blobToBase64|pdfBase64/)
  assert.deepEqual(
    staleSaveConsumers.map(({ path }) => path),
    [],
    'reachable production consumers must not invoke removed native save commands',
  )
  assert.doesNotMatch(
    gradedPhoto,
    /downloadInApp\(dataUrl/,
    'graded-photo must not pass a data URL to the managed HTTP download API',
  )
})

test('BUG-20260802-014 gives the Rust print coordinator sole ownership of the native saga', () => {
  const lib = read(desktopRoot, 'src-tauri/src/lib.rs')
  const coordinator = read(desktopRoot, 'src-tauri/src/print_coordinator.rs')
  const exportSource = read(desktopRoot, 'src/features/k12/export.ts')
  const receiptSource = read(desktopRoot, 'src/features/k12/print-receipt.ts')

  assert.match(lib, /mod print_coordinator/)
  assert.match(lib, /print_coordinator::execute_print_job/)
  assert.match(coordinator, /dialog_open/)
  assert.match(coordinator, /outcome_unknown/)
  assert.doesNotMatch(lib, /native_print::native_print_pdf/)
  assert.doesNotMatch(exportSource, /native_print_pdf|pdfBase64/)
  assert.equal(receiptSource, '', 'the renderer-owned print convergence module must be removed')
})

test('BUG-20260802-015 keeps native OS-vault commands scoped to explicit non-provider credentials', () => {
  const cargo = read(desktopRoot, 'src-tauri/Cargo.toml')
  const lib = read(desktopRoot, 'src-tauri/src/lib.rs')
  const vault = read(desktopRoot, 'src-tauri/src/credential_vault.rs')
  const secureStore = read(desktopRoot, 'src/utils/secure-store.ts')
  const providerCoordinator = read(desktopRoot, 'src-tauri/src/provider_credentials.rs')

  assert.match(cargo, /keyring\s*=/)
  assert.match(lib, /mod credential_vault/)
  assert.match(lib, /credential_vault::(?:put|delete|credential_present)/)
  assert.match(vault, /Entry::new|keyring::Entry/)
  assert.doesNotMatch(secureStore, /LazyStore|loadSecureValue|secure\.dat/)
  assert.match(secureStore, /credentialPresent/)
  assert.doesNotMatch(providerCoordinator, /credential_vault/)
})

test('BUG-20260802-016 hydrates durable ImageTask and Knowledge operations from Sidecar projections', () => {
  const imageBinding = read(desktopRoot, 'src/features/k12/image-task-binding.ts')
  const knowledgeApi = read(desktopRoot, 'src/api/knowledge.ts')
  const knowledgeStore = read(desktopRoot, 'src/stores/knowledge-uploads.ts')
  const k12Handler = read(hexclawRoot, 'scenarios/k12/apihttp/handler.go')
  const knowledgeHandler = read(hexclawRoot, 'api/handler_knowledge.go')

  assert.doesNotMatch(imageBinding, /localStorage|K12_IMAGE_TASK_BINDINGS_KEY/)
  assert.match(imageBinding, /recoverable|listRecoverableImageTasks/)
  assert.doesNotMatch(knowledgeApi, /KNOWLEDGE_(?:UPLOAD|RETRY)_INTENTS_STORAGE_KEY|localStorage/)
  assert.doesNotMatch(knowledgeStore, /DURABLE_UPLOADS_STORAGE_KEY|localStorage/)
  assert.match(k12Handler, /GET \/image-tasks\/recoverable/)
  assert.match(knowledgeHandler, /GET \/api\/v1\/knowledge\/operations/)
})

test('BUG-20260802-017 has one Sidecar WebSocket chat protocol and no Rust Provider or SSE path', () => {
  const lib = read(desktopRoot, 'src-tauri/src/lib.rs')
  const commands = read(desktopRoot, 'src-tauri/src/commands.rs')
  const chatApi = read(desktopRoot, 'src/api/chat.ts')
  const chatService = read(desktopRoot, 'src/services/chatService.ts')

  assert.doesNotMatch(lib, /commands::stream_chat|commands::backend_chat/)
  assert.doesNotMatch(commands, /StreamChatParams|BackendChatParams|pub async fn stream_chat|pub async fn backend_chat/)
  assert.doesNotMatch(chatApi, /sendChatViaBackend|backend_chat|backend-chat-stream/)
  assert.doesNotMatch(chatService, /sendViaBackend|BACKEND_REPLY_TIMEOUT_MS/)
  assert.match(chatService, /openWebSocketStream/)
  assert.match(chatService, /resumeWebSocketStream/)
})

test('BUG-20260802-018 generates versioned ImageTask types and runtime validators from Go schema', () => {
  const generator = read(hexclawRoot, 'cmd/contractgen/main.go')
  const schema = read(hexclawRoot, 'api/view_contracts/k12-image-task.v1.schema.json')
  const generated = read(desktopRoot, 'src/contracts/generated/k12-image-task.v1.ts')
  const k12Api = read(desktopRoot, 'src/api/k12.ts')
  const packageJson = read(desktopRoot, 'package.json')

  assert.match(generator, /k12-image-task\.v1\.schema\.json/)
  assert.match(schema, /"\$schema"\s*:\s*"https:\/\/json-schema\.org\/draft\/2020-12\/schema"/)
  assert.match(schema, /"additionalProperties"\s*:\s*false/)
  assert.match(generated, /K12_IMAGE_TASK_SCHEMA_VERSION/)
  assert.match(generated, /validateImageTask(?:Create|Dispatch|Result|SourceAction)/)
  assert.match(k12Api, /@\/contracts\/generated\/k12-image-task\.v1/)
  assert.doesNotMatch(k12Api, /function assertImageTask|function normalizeImageTaskWire/)
  assert.match(packageJson, /contracts:check/)
})
