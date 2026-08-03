import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const gateDir = dirname(fileURLToPath(import.meta.url))
const desktopRoot = resolve(gateDir, '../..')
const workRoot = resolve(desktopRoot, '..')

async function read(relativePath) {
  return readFile(resolve(desktopRoot, relativePath), 'utf8')
}

async function readOptional(relativePath) {
  try {
    return await read(relativePath)
  } catch (error) {
    if (error?.code === 'ENOENT') return ''
    throw error
  }
}

function binaryMiBConstant(source, name) {
  const match = source.match(
    new RegExp(`\\b${name}(?:\\s*:\\s*[A-Za-z0-9_:<>]+)?\\s*=\\s*(\\d+)\\s*\\*\\s*1024\\s*\\*\\s*1024`),
  )
  assert.ok(match, `${name} must be an explicit binary-MiB constant`)
  return Number(match[1])
}

function shiftedMiBConstant(source, name) {
  const match = source.match(
    new RegExp(`\\b${name}(?:\\s+[A-Za-z0-9_]+)?\\s*=\\s*(\\d+)\\s*<<\\s*20`),
  )
  assert.ok(match, `${name} must be an explicit binary-MiB constant`)
  return Number(match[1])
}

test('DD-042 keeps every chat attachment byte authority at exactly 200 MiB', async () => {
  const [nativeFile, boundary, attachments, fileParser, documents, staging, documentHandler] = await Promise.all([
    read('src-tauri/src/native_file.rs'),
    readOptional('src/contracts/chat-file-boundary.ts'),
    read('src/api/attachments.ts'),
    read('src/utils/file-parser.ts'),
    read('src/api/documents.ts'),
    readFile(resolve(workRoot, 'hexclaw/api/attachment_staging.go'), 'utf8'),
    readFile(resolve(workRoot, 'hexclaw/api/handler_documents.go'), 'utf8'),
  ])

  assert.deepEqual(
    {
      rustGrant: binaryMiBConstant(nativeFile, 'MAX_ATTACHMENT_BYTES'),
      typescriptShared: binaryMiBConstant(boundary, 'CHAT_FILE_MAX_BYTES'),
      goShared: shiftedMiBConstant(staging, 'maxChatFileBytes'),
    },
    {
      rustGrant: 200,
      typescriptShared: 200,
      goShared: 200,
    },
  )

  assert.match(attachments, /CHAT_FILE_MAX_BYTES/)
  assert.doesNotMatch(attachments, /const\s+MAX_ATTACHMENT_BYTES/)
  assert.match(fileParser, /CHAT_FILE_MAX_BYTES/)
  assert.doesNotMatch(fileParser, /const\s+MAX_FILE_SIZE/)
  assert.match(staging, /maxStagedAttachmentBytes\s*=\s*maxChatFileBytes/)
  assert.match(documentHandler, /maxUpload\s*=\s*maxChatFileBytes/)
  assert.match(documentHandler, /http\.MaxBytesReader/)
  assert.match(nativeFile, /path\s*==\s*"\/api\/v1\/documents\/extract"/)
  assert.match(documents, /uploadGrantedFile/)
  assert.match(documents, /nativeGrantFromFile/)
})

test('DD-042 preserves the independent 512 MiB aggregate staging guard', async () => {
  const staging = await readFile(resolve(workRoot, 'hexclaw/api/attachment_staging.go'), 'utf8')
  assert.equal(shiftedMiBConstant(staging, 'maxStagedAttachmentTotalBytes'), 512)
})
