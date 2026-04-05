/**
 * Code Review v11 — Runtime Bug Verification Tests
 *
 * Verifies bugs found in the runtime audit. Uses static analysis (readFileSync)
 * for source-level checks, and real runtime tests for useChatActions composable.
 *
 * Bug matrix:
 *   BUG  1 (HIGH)   — IMChannelsView delete guard inverted      — FIXED
 *   BUG  3 (MEDIUM) — cloneMessage shallow metadata             — FIXED
 *   BUG 10 (HIGH)   — confirmEdit deletes before model check    — FIXED
 *   BUG  5 (MEDIUM) — WS inactivity timeout during tool calls   — DOCUMENTED
 *   BUG  6 (LOW)    — ensureSession doesn't push to sidebar     — DOCUMENTED
 *   BUG  9 (MEDIUM) — handleRetry splices before backend delete — DOCUMENTED
 *   BUG 13 (LOW)    — ChatView drop handler only takes 1st file — DOCUMENTED
 *   BUG 15 (MEDIUM) — WS reconnect drops stream callbacks       — DOCUMENTED
 *   BUG 16 (MEDIUM) — SettingsView flushAutoSave                — FIXED
 *   BUG 17 (LOW)    — useChatSend searches knowledge on every msg — DOCUMENTED
 *
 *   Runtime tests for useChatActions confirmEdit / handleRetry model guard
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const SRC = resolve(__dirname, '..')
function readSrc(path: string): string {
  return readFileSync(resolve(SRC, path), 'utf-8')
}

// ════════════════════════════════════════════════════════════
// BUG 1 (HIGH): IMChannelsView delete guard inverted — FIXED
// ════════════════════════════════════════════════════════════

describe('BUG 1: IMChannelsView handleDelete guard', () => {
  const src = readSrc('views/IMChannelsView.vue')

  it('handleDelete checks deletingId.value !== id (correct guard)', () => {
    // The guard must be `deletingId.value !== id` so we only proceed when
    // the user has confirmed deletion for *this* specific instance.
    expect(src).toMatch(/if\s*\(\s*deletingId\.value\s*!==\s*id\s*\)\s*return/)
  })

  it('does NOT use the inverted guard (=== id) which would block confirmed deletes', () => {
    // Ensure we never have `if (deletingId.value === id) return`
    expect(src).not.toMatch(/if\s*\(\s*deletingId\.value\s*===\s*id\s*\)\s*return/)
  })

  it('resets deletingId to null after successful delete', () => {
    const deleteBlock = src.slice(src.indexOf('async function handleDelete'))
    expect(deleteBlock).toContain('deletingId.value = null')
  })
})

// ════════════════════════════════════════════════════════════
// BUG 3 (MEDIUM): cloneMessage shallow metadata — FIXED
// ════════════════════════════════════════════════════════════

describe('BUG 3: cloneMessage deep clone', () => {
  const src = readSrc('stores/chat.ts')

  it('uses JSON.parse(JSON.stringify(...)) for deep clone', () => {
    expect(src).toMatch(/function\s+cloneMessage/)
    expect(src).toContain('JSON.parse(JSON.stringify(message))')
  })

  it('does NOT use object spread for cloneMessage (which would be shallow)', () => {
    // Extract the cloneMessage function body
    const fnStart = src.indexOf('function cloneMessage')
    const fnEnd = src.indexOf('\n}', fnStart)
    const fnBody = src.slice(fnStart, fnEnd)
    expect(fnBody).not.toMatch(/return\s*\{\s*\.\.\.message\s*\}/)
  })
})

// ════════════════════════════════════════════════════════════
// BUG 10 (HIGH): confirmEdit deletes messages before model check — FIXED
// ════════════════════════════════════════════════════════════

describe('BUG 10: confirmEdit / handleRetry model guard ordering', () => {
  const src = readSrc('composables/useChatActions.ts')

  it('confirmEdit checks chatStore.chatParams.model before splice', () => {
    const fnStart = src.indexOf('async function confirmEdit')
    const splicePos = src.indexOf('.splice(', fnStart)
    const modelCheckPos = src.indexOf('chatStore.chatParams.model', fnStart)
    // Model check must appear before splice
    expect(modelCheckPos).toBeGreaterThan(fnStart)
    expect(modelCheckPos).toBeLessThan(splicePos)
  })

  it('confirmEdit returns early (cancelEdit) when model is empty', () => {
    const fnStart = src.indexOf('async function confirmEdit')
    const fnBody = src.slice(fnStart, src.indexOf('\n  async function', fnStart + 10) > 0
      ? src.indexOf('\n  async function', fnStart + 10)
      : src.indexOf('\n  function', fnStart + 10))
    // Should call cancelEdit() when model is missing
    expect(fnBody).toContain('cancelEdit()')
  })

  it('handleRetry checks chatStore.chatParams.model before splice', () => {
    const fnStart = src.indexOf('async function handleRetry')
    const fnEnd = src.indexOf('async function handleLike')
    const fnBody = src.slice(fnStart, fnEnd)
    const splicePos = fnBody.indexOf('.splice(')
    const modelCheckPos = fnBody.indexOf('chatStore.chatParams.model')
    // Model check must appear before splice
    expect(modelCheckPos).toBeGreaterThan(-1)
    expect(splicePos).toBeGreaterThan(-1)
    expect(modelCheckPos).toBeLessThan(splicePos)
  })

  it('handleRetry returns early when model is empty string', () => {
    const fnStart = src.indexOf('async function handleRetry')
    const fnEnd = src.indexOf('async function handleLike')
    const fnBody = src.slice(fnStart, fnEnd)
    // Should check model and return
    expect(fnBody).toMatch(/if\s*\(!model/)
    expect(fnBody).toContain('return')
  })
})

// ════════════════════════════════════════════════════════════
// BUG 5 (MEDIUM): WS inactivity timeout during tool calls — DOCUMENTED
// ════════════════════════════════════════════════════════════

describe('BUG 5: WS inactivity timeout is 120s', () => {
  const src = readSrc('services/chatService.ts')

  it('WS_INACTIVITY_TIMEOUT_MS is 120_000 (120 seconds)', () => {
    expect(src).toMatch(/WS_INACTIVITY_TIMEOUT_MS\s*=\s*120[_]?000/)
  })

  it('DOCUMENTED: no mechanism to extend timeout during tool calls', () => {
    // The inactivity timer resets on any chunk, but long-running tool calls
    // (e.g., code execution) may take >120s without sending chunks.
    // There is no tool-call-specific timeout extension logic.
    expect(src).not.toMatch(/tool.*timeout|extend.*timeout|pause.*inactivity/i)
  })
})

// ════════════════════════════════════════════════════════════
// BUG 6 (LOW): ensureSession doesn't add session to sidebar — DOCUMENTED
// ════════════════════════════════════════════════════════════

describe('BUG 6: ensureSession does not push to sessions array', () => {
  const src = readSrc('stores/chat.ts')

  it('ensureSession creates session via msgSvc but does NOT push to sessions.value', () => {
    // Extract ensureSession body
    const fnStart = src.indexOf('async function ensureSession')
    const fnEnd = src.indexOf('try { return await _ensureSessionPromise }')
    const fnBody = src.slice(fnStart, fnEnd)
    // Should NOT contain sessions.value.push
    expect(fnBody).not.toContain('sessions.value.push')
  })

  it('session list is refreshed via loadSessions() after message send', () => {
    // finalizeAssistantMessage calls loadSessions() to refresh the sidebar
    const fnStart = src.indexOf('function finalizeAssistantMessage')
    const fnEnd = src.indexOf('function handleSendError')
    const fnBody = src.slice(fnStart, fnEnd)
    expect(fnBody).toContain('loadSessions()')
  })
})

// ════════════════════════════════════════════════════════════
// BUG 9 (MEDIUM): handleRetry splices before backend delete — DOCUMENTED
// ════════════════════════════════════════════════════════════

describe('BUG 9: handleRetry UI splice before backend delete', () => {
  const src = readSrc('composables/useChatActions.ts')

  it('splice is called before removeMessage (optimistic UI update)', () => {
    const fnStart = src.indexOf('async function handleRetry')
    const fnEnd = src.indexOf('async function handleLike')
    const fnBody = src.slice(fnStart, fnEnd)

    const splicePos = fnBody.indexOf('.splice(')
    const removePos = fnBody.indexOf('removeMessage(')
    expect(splicePos).toBeGreaterThan(-1)
    expect(removePos).toBeGreaterThan(-1)
    // Splice happens before removeMessage
    expect(splicePos).toBeLessThan(removePos)
  })

  it('removeMessage errors are silently swallowed with .catch(() => {})', () => {
    const fnStart = src.indexOf('async function handleRetry')
    const fnEnd = src.indexOf('async function handleLike')
    const fnBody = src.slice(fnStart, fnEnd)
    expect(fnBody).toMatch(/removeMessage\([^)]+\)\.catch\(\(\)\s*=>\s*\{\s*\}\)/)
  })
})

// ════════════════════════════════════════════════════════════
// BUG 13 (LOW): ChatView drop handler only takes first file — DOCUMENTED
// ════════════════════════════════════════════════════════════

describe('BUG 13: ChatView handleDrop only processes first file', () => {
  const src = readSrc('views/ChatView.vue')

  it('handleDrop uses files?.[0] (only first file)', () => {
    const fnStart = src.indexOf('function handleDrop')
    const fnEnd = src.indexOf('\n}', fnStart)
    const fnBody = src.slice(fnStart, fnEnd)
    expect(fnBody).toContain('files?.[0]')
  })

  it('DOCUMENTED: handleDrop does NOT iterate over all files', () => {
    const fnStart = src.indexOf('function handleDrop')
    const fnEnd = src.indexOf('\n}', fnStart)
    const fnBody = src.slice(fnStart, fnEnd)
    // No for loop or forEach in the drop handler
    expect(fnBody).not.toMatch(/for\s*\(/)
    expect(fnBody).not.toMatch(/\.forEach\(/)
  })
})

// ════════════════════════════════════════════════════════════
// BUG 15 (MEDIUM): WebSocket reconnect drops stream callbacks — DOCUMENTED
// ════════════════════════════════════════════════════════════

describe('BUG 15: WebSocket reconnect does not re-register callbacks', () => {
  const src = readSrc('api/websocket.ts')

  it('onclose fires error callbacks when not intentional close', () => {
    // The onclose handler should fire error callbacks
    expect(src).toMatch(/this\.ws\.onclose\s*=\s*\(\)\s*=>/)
    expect(src).toMatch(/errorCallbacks\.forEach\(\(cb\)\s*=>\s*cb\(['"]WebSocket connection lost['"]\)/)
  })

  it('clearStreamCallbacks empties chunk, reply, and error callbacks', () => {
    const fnStart = src.indexOf('clearStreamCallbacks')
    const fnEnd = src.indexOf('}', src.indexOf('{', fnStart) + 1)
    const fnBody = src.slice(fnStart, fnEnd)
    expect(fnBody).toContain('this.chunkCallbacks = []')
    expect(fnBody).toContain('this.replyCallbacks = []')
    expect(fnBody).toContain('this.errorCallbacks = []')
  })

  it('DOCUMENTED: attemptReconnect does NOT re-register stream callbacks', () => {
    const fnStart = src.indexOf('private attemptReconnect')
    const fnEnd = src.indexOf('\n  private', fnStart + 10)
    const fnBody = src.slice(fnStart, fnEnd > 0 ? fnEnd : undefined)
    expect(fnBody).not.toContain('onChunk')
    expect(fnBody).not.toContain('onReply')
    expect(fnBody).not.toContain('onError')
  })
})

// ════════════════════════════════════════════════════════════
// BUG 16 (MEDIUM): SettingsView flushAutoSave — FIXED
// ════════════════════════════════════════════════════════════

describe('BUG 16: SettingsView flushAutoSave re-saves after in-flight promise', () => {
  const src = readSrc('views/SettingsView.vue')

  it('flushAutoSave awaits autoSavePromise when one is in-flight', () => {
    const fnStart = src.indexOf('async function flushAutoSave')
    const fnEnd = src.indexOf('\n}\n', fnStart)
    const fnBody = src.slice(fnStart, fnEnd)
    // Should await the in-flight promise
    expect(fnBody).toContain('await autoSavePromise')
  })

  it('re-saves after in-flight promise completes if hasPendingAutoSave or force', () => {
    const fnStart = src.indexOf('async function flushAutoSave')
    const fnEnd = src.indexOf('\n}\n', fnStart)
    const fnBody = src.slice(fnStart, fnEnd)
    // After awaiting in-flight, should check hasPendingAutoSave and persist again
    expect(fnBody).toMatch(/await\s+autoSavePromise[\s\S]*hasPendingAutoSave\s*\|\|\s*force/)
  })

  it('sets hasPendingAutoSave = true on error to ensure retry', () => {
    const fnStart = src.indexOf('async function flushAutoSave')
    const fnEnd = src.indexOf('\n}\n', fnStart)
    const fnBody = src.slice(fnStart, fnEnd)
    // Error handler should set hasPendingAutoSave = true
    expect(fnBody).toMatch(/catch\s*\([^)]*\)\s*\{[^}]*hasPendingAutoSave\s*=\s*true/)
  })
})

// ════════════════════════════════════════════════════════════
// BUG 17 (LOW): useChatSend searches knowledge on every message — DOCUMENTED
// ════════════════════════════════════════════════════════════

describe('BUG 17: useChatSend always calls searchKnowledge', () => {
  const src = readSrc('composables/useChatSend.ts')

  it('imports searchKnowledge from @/api/knowledge', () => {
    expect(src).toMatch(/import\s*\{[^}]*searchKnowledge[^}]*\}\s*from\s*['"]@\/api\/knowledge['"]/)
  })

  it('calls searchKnowledge inside handleSend unconditionally', () => {
    const fnStart = src.indexOf('async function handleSend')
    const fnBody = src.slice(fnStart)
    expect(fnBody).toContain('searchKnowledge(text,')
  })

  it('DOCUMENTED: no guard to skip when knowledge base is empty or disabled', () => {
    const fnStart = src.indexOf('async function handleSend')
    const fnBody = src.slice(fnStart)
    // searchKnowledge is called in a try-catch but without any pre-check
    // for knowledge base being enabled or non-empty
    const ragSection = fnBody.slice(
      fnBody.indexOf('Auto-RAG'),
      fnBody.indexOf('searchKnowledge') + 40,
    )
    expect(ragSection).not.toMatch(/knowledgeEnabled|hasKnowledge|knowledge.*length/)
  })
})

// ════════════════════════════════════════════════════════════
// Runtime tests: useChatActions model guard
// ════════════════════════════════════════════════════════════

vi.mock('@/services/messageService', () => ({
  removeMessage: vi.fn().mockResolvedValue(undefined),
}))

function makeMockChatStore(overrides: {
  messages?: Array<{ id: string; role: string; content: string; timestamp: string; metadata?: Record<string, unknown> }>
  model?: string
}) {
  const messages = overrides.messages ?? []
  return {
    messages,
    chatParams: { model: overrides.model ?? '' },
    setMessageFeedback: vi.fn().mockResolvedValue(null),
  }
}

function makeMockToast() {
  return {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    toast: vi.fn(),
  }
}

describe('useChatActions runtime: confirmEdit model guard', () => {
  let mockHandleSend: (text: string, files?: File[]) => Promise<void>

  beforeEach(() => {
    vi.clearAllMocks()
    mockHandleSend = vi.fn().mockResolvedValue(undefined)
  })

  it('confirmEdit with no model -> messages NOT spliced, edit cancelled', async () => {
    const messages = [
      { id: 'u1', role: 'user', content: 'hello', timestamp: '2025-01-01T00:00:00Z' },
      { id: 'a1', role: 'assistant', content: 'hi', timestamp: '2025-01-01T00:00:01Z' },
    ]
    const store = makeMockChatStore({ messages, model: '' })
    const toast = makeMockToast()
    const { confirmEdit, editingMsgId, editingText } = useChatActions(store as any, toast as any, mockHandleSend)

    // Simulate editing
    editingMsgId.value = 'u1'
    editingText.value = 'updated text'

    await confirmEdit('u1')

    // Messages should NOT be spliced
    expect(messages).toHaveLength(2)
    // handleSend should NOT be called
    expect(mockHandleSend).not.toHaveBeenCalled()
    // Edit should be cancelled
    expect(editingMsgId.value).toBeNull()
  })

  it('confirmEdit with valid model -> messages spliced, handleSend called', async () => {
    const messages = [
      { id: 'u1', role: 'user', content: 'hello', timestamp: '2025-01-01T00:00:00Z' },
      { id: 'a1', role: 'assistant', content: 'hi', timestamp: '2025-01-01T00:00:01Z' },
    ]
    const store = makeMockChatStore({ messages, model: 'gpt-4' })
    const toast = makeMockToast()
    const { confirmEdit, editingMsgId, editingText } = useChatActions(store as any, toast as any, mockHandleSend)

    editingMsgId.value = 'u1'
    editingText.value = 'updated text'

    await confirmEdit('u1')

    // Messages SHOULD be spliced (user msg + assistant reply removed)
    expect(messages).toHaveLength(0)
    // handleSend SHOULD be called with the edited text
    expect(mockHandleSend).toHaveBeenCalledWith('updated text')
  })

  it('confirmEdit with model="auto" -> messages spliced, handleSend called', async () => {
    const messages = [
      { id: 'u1', role: 'user', content: 'hello', timestamp: '2025-01-01T00:00:00Z' },
      { id: 'a1', role: 'assistant', content: 'hi', timestamp: '2025-01-01T00:00:01Z' },
    ]
    const store = makeMockChatStore({ messages, model: 'auto' })
    const toast = makeMockToast()
    const { confirmEdit, editingMsgId, editingText } = useChatActions(store as any, toast as any, mockHandleSend)

    editingMsgId.value = 'u1'
    editingText.value = 'auto model edit'

    await confirmEdit('u1')

    expect(messages).toHaveLength(0)
    expect(mockHandleSend).toHaveBeenCalledWith('auto model edit')
  })

  it('confirmEdit with empty trimmed text -> edit cancelled, messages intact', async () => {
    const messages = [
      { id: 'u1', role: 'user', content: 'hello', timestamp: '2025-01-01T00:00:00Z' },
    ]
    const store = makeMockChatStore({ messages, model: 'gpt-4' })
    const toast = makeMockToast()
    const { confirmEdit, editingMsgId, editingText } = useChatActions(store as any, toast as any, mockHandleSend)

    editingMsgId.value = 'u1'
    editingText.value = '   '

    await confirmEdit('u1')

    expect(messages).toHaveLength(1)
    expect(mockHandleSend).not.toHaveBeenCalled()
    expect(editingMsgId.value).toBeNull()
  })

  it('confirmEdit with whitespace-only model -> treated as empty, edit cancelled', async () => {
    const messages = [
      { id: 'u1', role: 'user', content: 'hello', timestamp: '2025-01-01T00:00:00Z' },
      { id: 'a1', role: 'assistant', content: 'hi', timestamp: '2025-01-01T00:00:01Z' },
    ]
    const store = makeMockChatStore({ messages, model: '   ' })
    const toast = makeMockToast()
    const { confirmEdit, editingMsgId, editingText } = useChatActions(store as any, toast as any, mockHandleSend)

    editingMsgId.value = 'u1'
    editingText.value = 'new text'

    await confirmEdit('u1')

    expect(messages).toHaveLength(2)
    expect(mockHandleSend).not.toHaveBeenCalled()
  })

  it('confirmEdit with non-existent msgId -> no splice, no send', async () => {
    const messages = [
      { id: 'u1', role: 'user', content: 'hello', timestamp: '2025-01-01T00:00:00Z' },
    ]
    const store = makeMockChatStore({ messages, model: 'gpt-4' })
    const toast = makeMockToast()
    const { confirmEdit, editingMsgId, editingText } = useChatActions(store as any, toast as any, mockHandleSend)

    editingMsgId.value = 'nonexistent'
    editingText.value = 'new text'

    await confirmEdit('nonexistent')

    // Message not found after model check, idx < 0 => early return
    expect(messages).toHaveLength(1)
    expect(mockHandleSend).not.toHaveBeenCalled()
  })
})

describe('useChatActions runtime: handleRetry model guard', () => {
  let mockHandleSend: (text: string, files?: File[]) => Promise<void>

  beforeEach(() => {
    vi.clearAllMocks()
    mockHandleSend = vi.fn().mockResolvedValue(undefined)
  })

  it('handleRetry with no model -> messages NOT spliced, returns early', async () => {
    const messages = [
      { id: 'u1', role: 'user', content: 'hello', timestamp: '2025-01-01T00:00:00Z' },
      { id: 'a1', role: 'assistant', content: 'bad reply', timestamp: '2025-01-01T00:00:01Z' },
    ]
    const store = makeMockChatStore({ messages, model: '' })
    const toast = makeMockToast()
    const { handleRetry } = useChatActions(store as any, toast as any, mockHandleSend)

    await handleRetry(1) // index of assistant message

    // Messages should NOT be spliced
    expect(messages).toHaveLength(2)
    expect(mockHandleSend).not.toHaveBeenCalled()
  })

  it('handleRetry with valid model -> messages spliced, handleSend called', async () => {
    const messages = [
      { id: 'u1', role: 'user', content: 'hello', timestamp: '2025-01-01T00:00:00Z' },
      { id: 'a1', role: 'assistant', content: 'bad reply', timestamp: '2025-01-01T00:00:01Z' },
    ]
    const store = makeMockChatStore({ messages, model: 'gpt-4' })
    const toast = makeMockToast()
    const { handleRetry } = useChatActions(store as any, toast as any, mockHandleSend)

    await handleRetry(1)

    // Messages SHOULD be spliced (user + assistant removed)
    expect(messages).toHaveLength(0)
    expect(mockHandleSend).toHaveBeenCalledWith('hello')
  })

  it('handleRetry on non-assistant message -> returns early, no splice', async () => {
    const messages = [
      { id: 'u1', role: 'user', content: 'hello', timestamp: '2025-01-01T00:00:00Z' },
      { id: 'a1', role: 'assistant', content: 'hi', timestamp: '2025-01-01T00:00:01Z' },
    ]
    const store = makeMockChatStore({ messages, model: 'gpt-4' })
    const toast = makeMockToast()
    const { handleRetry } = useChatActions(store as any, toast as any, mockHandleSend)

    await handleRetry(0) // index 0 is user message

    expect(messages).toHaveLength(2)
    expect(mockHandleSend).not.toHaveBeenCalled()
  })

  it('handleRetry with no preceding user message -> returns early', async () => {
    const messages = [
      { id: 'a1', role: 'assistant', content: 'orphan reply', timestamp: '2025-01-01T00:00:01Z' },
    ]
    const store = makeMockChatStore({ messages, model: 'gpt-4' })
    const toast = makeMockToast()
    const { handleRetry } = useChatActions(store as any, toast as any, mockHandleSend)

    await handleRetry(0)

    expect(messages).toHaveLength(1)
    expect(mockHandleSend).not.toHaveBeenCalled()
  })

  it('handleRetry with model="auto" -> proceeds normally', async () => {
    const messages = [
      { id: 'u1', role: 'user', content: 'test', timestamp: '2025-01-01T00:00:00Z' },
      { id: 'a1', role: 'assistant', content: 'bad', timestamp: '2025-01-01T00:00:01Z' },
    ]
    const store = makeMockChatStore({ messages, model: 'auto' })
    const toast = makeMockToast()
    const { handleRetry } = useChatActions(store as any, toast as any, mockHandleSend)

    await handleRetry(1)

    expect(messages).toHaveLength(0)
    expect(mockHandleSend).toHaveBeenCalledWith('test')
  })

  it('handleRetry with whitespace-only model -> returns early', async () => {
    const messages = [
      { id: 'u1', role: 'user', content: 'hello', timestamp: '2025-01-01T00:00:00Z' },
      { id: 'a1', role: 'assistant', content: 'hi', timestamp: '2025-01-01T00:00:01Z' },
    ]
    const store = makeMockChatStore({ messages, model: '  ' })
    const toast = makeMockToast()
    const { handleRetry } = useChatActions(store as any, toast as any, mockHandleSend)

    await handleRetry(1)

    expect(messages).toHaveLength(2)
    expect(mockHandleSend).not.toHaveBeenCalled()
  })

  it('handleRetry out-of-bounds index -> returns early', async () => {
    const messages = [
      { id: 'u1', role: 'user', content: 'hello', timestamp: '2025-01-01T00:00:00Z' },
    ]
    const store = makeMockChatStore({ messages, model: 'gpt-4' })
    const toast = makeMockToast()
    const { handleRetry } = useChatActions(store as any, toast as any, mockHandleSend)

    await handleRetry(99)

    expect(messages).toHaveLength(1)
    expect(mockHandleSend).not.toHaveBeenCalled()
  })
})

// Import the actual composable for runtime tests
import { useChatActions } from '@/composables/useChatActions'
