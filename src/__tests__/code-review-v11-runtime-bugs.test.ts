/**
 * Code Review v11 — Runtime Bug Verification Tests
 *
 * Verifies bugs found in the runtime audit. Uses static analysis (readFileSync)
 * for source-level checks, and real runtime tests for useChatActions composable.
 *
 * Bug matrix:
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
// BUG 3 (MEDIUM): cloneMessage shallow metadata — FIXED
// ════════════════════════════════════════════════════════════

describe('BUG 3: cloneMessage deep clone', () => {
  const src = readSrc('stores/chat-stream-helpers.ts')

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
// BUG 10 (HIGH): confirmEdit must validate before submitting and never delete history — FIXED
// ════════════════════════════════════════════════════════════

describe('BUG 10: confirmEdit / handleRetry model guard ordering', () => {
  const src = readSrc('composables/useChatActions.ts')

  it('confirmEdit checks chatStore.chatParams.model before submitting and never deletes history', () => {
    const fnStart = src.indexOf('async function confirmEdit')
    const fnEnd = src.indexOf('\n  function cancelEdit', fnStart)
    const fnBody = src.slice(fnStart, fnEnd)
    const submitPos = fnBody.indexOf('submitEditedMessage')
    const modelCheckPos = src.indexOf('chatStore.chatParams.model', fnStart)
    // Model check must appear before the immutable edited submission.
    expect(modelCheckPos).toBeGreaterThan(fnStart)
    expect(submitPos).toBeGreaterThan(-1)
    expect(modelCheckPos - fnStart).toBeLessThan(submitPos)
    expect(fnBody).not.toContain('removeRangeAtomic(')
    expect(fnBody).not.toContain('removeMessage(')
  })

  it('confirmEdit returns early and preserves the edit when model is empty', () => {
    const fnStart = src.indexOf('async function confirmEdit')
    const fnBody = src.slice(fnStart, src.indexOf('\n  async function', fnStart + 10) > 0
      ? src.indexOf('\n  async function', fnStart + 10)
      : src.indexOf('\n  function', fnStart + 10))
    expect(fnBody).toContain('chat.selectModelFirst')
    expect(fnBody).toContain('return')
  })

  it('handleRetry checks chatStore.chatParams.model before deleting', () => {
    const fnStart = src.indexOf('async function handleRetry')
    const fnEnd = src.indexOf('async function handleLike')
    const fnBody = src.slice(fnStart, fnEnd)
    const delPos = fnBody.indexOf('removeRangeAtomic(')
    const modelCheckPos = fnBody.indexOf('chatStore.chatParams.model')
    // Model check must appear before the atomic delete
    expect(modelCheckPos).toBeGreaterThan(-1)
    expect(delPos).toBeGreaterThan(-1)
    expect(modelCheckPos).toBeLessThan(delPos)
  })

  it('handleRetry returns early when model is empty string', () => {
    const fnStart = src.indexOf('async function handleRetry')
    const fnEnd = src.indexOf('async function handleLike')
    const fnBody = src.slice(fnStart, fnEnd)
    // Should check model and return
    expect(fnBody).toMatch(/model\s*!==\s*undefined/)
    expect(fnBody).toContain('return')
  })
})

// ════════════════════════════════════════════════════════════
// BUG 5 (MEDIUM): WS inactivity timeout during tool calls — DOCUMENTED
// ════════════════════════════════════════════════════════════

describe('BUG 5: WS inactivity timeout is 300s', () => {
  const src = readSrc('services/chatService.ts')

  // 2026-07：慢真模型/长工具链把首响应+静默上限从 120s 放宽到 300s（设计决策，
  // chatService.test.ts「keeps the request socket alive past 120s」已锁定该契约）。
  it('WS_INACTIVITY_TIMEOUT_MS is 300_000 (300 seconds)', () => {
    expect(src).toMatch(/WS_INACTIVITY_TIMEOUT_MS\s*=\s*300[_]?000/)
  })

  it('DOCUMENTED: no mechanism to extend timeout during tool calls', () => {
    // The inactivity timer resets on any chunk, but long-running tool calls
    // (e.g., code execution) may take >300s without sending chunks.
    // There is no tool-call-specific timeout extension logic.
    expect(src).not.toMatch(/tool.*timeout|extend.*timeout|pause.*inactivity/i)
  })
})

// ════════════════════════════════════════════════════════════
// BUG 6 (LOW): ensureSession doesn't add session to sidebar — DOCUMENTED
// ════════════════════════════════════════════════════════════

describe('BUG 6: ensureSession does not push to sessions array', () => {
  const facadeSrc = readSrc('stores/chat.ts')
  const sessionLifecycleSrc = readSrc('stores/chat-session-lifecycle.ts')
  const streamCompletionSrc = readSrc('stores/chat-stream-completion.ts')

  it('ensureSession creates session via msgSvc but does NOT push to sessions.value', () => {
    // ensureSession 逻辑已经下沉到 session controller
    const fnStart = sessionLifecycleSrc.indexOf('async function ensureSession')
    const fnEnd = sessionLifecycleSrc.indexOf('async function deleteSession')
    const fnBody = sessionLifecycleSrc.slice(fnStart, fnEnd)
    // Should NOT contain sessions.value.push
    expect(fnBody).not.toContain('sessions.value.push')
    expect(fnBody).toContain('upsertLocalSession')
  })

  it('session list is refreshed via loadSessions() after message send', () => {
    // finalizeAssistantMessage 逻辑已经下沉到 stream completion controller
    const fnStart = streamCompletionSrc.indexOf('function finalizeAssistantMessage')
    const fnEnd = streamCompletionSrc.indexOf('return {')
    const fnBody = streamCompletionSrc.slice(fnStart, fnEnd)
    // 发送后经 loadSessions 刷新会话列表；容许带选项（suppressAutoSelect 等）—— 匹配调用而非固定无参形态。
    expect(fnBody).toContain('loadSessions(')
    expect(facadeSrc).toContain('finalizeAssistantMessage: boundStreamController.finalizeAssistantMessage')
  })
})

// ════════════════════════════════════════════════════════════
// BUG 9 (MEDIUM): handleRetry splices before backend delete — DOCUMENTED
// ════════════════════════════════════════════════════════════

describe('BUG 9: retry atomic delete and edit immutable submission (AP-094)', () => {
  const src = readSrc('composables/useChatActions.ts')

  it('removeRangeAtomic splices UI before awaiting backend deletes (optimistic)', () => {
    const fnStart = src.indexOf('async function removeRangeAtomic')
    const fnEnd = src.indexOf('async function handleRetry')
    const body = src.slice(fnStart, fnEnd)

    const splicePos = body.indexOf('.splice(')
    const removePos = body.indexOf('removeMessage(')
    expect(splicePos).toBeGreaterThan(-1)
    expect(removePos).toBeGreaterThan(-1)
    // Optimistic UI: splice first, then await the backend delete.
    expect(splicePos).toBeLessThan(removePos)
  })

  it('delete failures roll back + surface (toast + logger) and abort resend, not swallowed', () => {
    // AP-094: old fire-and-forget `.catch(() => {})` + unconditional resend hid backend
    // delete failures → orphaned rows reappeared as duplicates on reload. Now the helper
    // awaits deletes, rolls back the un-deleted messages, toasts, and returns false.
    // 2026-06-28：删除从「逐条串行 await」改「并行 await Promise.allSettled」（编辑早期消息不再卡几秒），
    // 仍是 awaited（非 fire-and-forget）+ 按结果精确回滚——意图不变，行为由 useChatActions 单测覆盖。
    const fnStart = src.indexOf('async function removeRangeAtomic')
    const fnEnd = src.indexOf('async function handleRetry')
    const body = src.slice(fnStart, fnEnd)
    expect(body).not.toMatch(/removeMessage\([^)]+\)\.catch\(\(\)\s*=>\s*\{\s*\}\)/)
    // 删除被 await（并行批量等待或逐条等待皆可），不是 fire-and-forget。
    expect(body).toMatch(/await Promise\.allSettled\([\s\S]*removeMessage\(|await removeMessage\(/)
    expect(body).toContain('removeMessage(')
    expect(body).toContain('toast.error(')
    expect(body).toContain('logger.error(')
    expect(body).toContain('return false') // 中止重发，杜绝重复
  })

  it('handleRetry gates resend on delete result while confirmEdit never deletes history', () => {
    expect(src).toContain('if (!(await removeRangeAtomic(userMsgIdx))) return')
    const fnStart = src.indexOf('async function confirmEdit')
    const fnEnd = src.indexOf('\n  function cancelEdit', fnStart)
    const fnBody = src.slice(fnStart, fnEnd)
    expect(fnBody).not.toContain('removeRangeAtomic(')
    expect(fnBody).toContain('submitEditedMessage')
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

  it('onclose delegates to attemptReconnect instead of firing error callbacks directly', () => {
    // CHANGED: onclose 不再直接触发 errorCallbacks，而是先重连
    // errorCallbacks 在 attemptReconnect 达到最大重试次数时才触发
    expect(src).toMatch(/this\.ws\.onclose\s*=\s*\(\)\s*=>/)
    expect(src).toContain('this.attemptReconnect()')
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

  it('onReconnect callback mechanism exists and is invoked after successful reconnect', () => {
    // websocket.ts must have reconnectCallbacks array + onReconnect method
    expect(src).toContain('private reconnectCallbacks')
    expect(src).toContain('onReconnect(callback')
    // attemptReconnect triggers reconnectCallbacks after connect() resolves
    const attemptFn = src.slice(src.indexOf('private attemptReconnect'))
    expect(attemptFn).toContain('this.reconnectCallbacks.forEach')
  })

  it('clearCallbacks preserves reconnectCallbacks (structural listeners)', () => {
    const clearFn = src.slice(src.indexOf('clearCallbacks():'), src.indexOf('}', src.indexOf('clearCallbacks():') + 50) + 1)
    // reconnectCallbacks should NOT be cleared by clearCallbacks
    expect(clearFn).not.toContain('reconnectCallbacks')
  })

  it('chat store registers onReconnect to auto-recover streams', () => {
    const chatSrc = readSrc('stores/chat.ts')
    expect(chatSrc).toContain('hexclawWS.onReconnect')
    expect(chatSrc).toContain('recoverActiveStreams')
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

  it('returns after awaiting in-flight promise to avoid double-save', () => {
    const fnStart = src.indexOf('async function flushAutoSave')
    const fnEnd = src.indexOf('\n}\n', fnStart)
    const fnBody = src.slice(fnStart, fnEnd)
    // After awaiting in-flight promise, the function returns to prevent double-save.
    // The next autoSave timer tick will pick up any pending changes.
    expect(fnBody).toMatch(/await\s+autoSavePromise[\s\S]*return/)
  })

  it('recomputes pending state from the persisted/current generation on error', () => {
    const fnStart = src.indexOf('async function flushAutoSave')
    const fnEnd = src.indexOf('\n}\n', fnStart)
    const fnBody = src.slice(fnStart, fnEnd)
    // A failed generation remains newer than persistedAutoSaveGeneration, so the shared
    // generation helper must restore the pending flag without duplicating state writes.
    expect(src).toMatch(
      /function\s+refreshAutoSaveDirtyState\s*\(\)\s*\{[\s\S]*?hasPendingAutoSave\s*=\s*persistedAutoSaveGeneration\s*<\s*autoSaveGeneration/,
    )
    expect(fnBody).toMatch(/catch\s*\([^)]*\)\s*\{[\s\S]*?refreshAutoSaveDirtyState\(\)[\s\S]*?throw\s+\w+/)
  })
})

// ════════════════════════════════════════════════════════════
// BUG 17 (LOW): useChatSend searches knowledge on every message — DOCUMENTED
// ════════════════════════════════════════════════════════════

// BUG 17 后续（BUG-20260712-M 根治）：当年「每条消息都打 searchKnowledge」的问题以
// **删除客户端 Auto-RAG 通道**终结——知识注入唯一来源=引擎侧 QueryHits（fail-closed）。
// 本锁反转为「禁止加回」：useChatSend 不得再 import/调用 searchKnowledge。
describe('BUG 17 → BUG-20260712-M: useChatSend 不得再有客户端 Auto-RAG 通道', () => {
  const src = readSrc('composables/useChatSend.ts')

  it('不再 import searchKnowledge（注入单通道=引擎侧）', () => {
    expect(src).not.toMatch(/import\s*\{[^}]*searchKnowledge[^}]*\}\s*from\s*['"]@\/api\/knowledge['"]/)
  })

  it('handleSend 内不再调用 searchKnowledge / 拼 [知识库参考信息]', () => {
    const fnStart = src.indexOf('async function handleSend')
    const fnBody = src.slice(fnStart)
    expect(fnBody).not.toContain('searchKnowledge(')
    expect(fnBody).not.toContain('[知识库参考信息')
  })
})

// ════════════════════════════════════════════════════════════
// Runtime tests: useChatActions model guard
// ════════════════════════════════════════════════════════════

vi.mock('@/services/messageService', () => ({
  removeMessage: vi.fn().mockResolvedValue(undefined),
}))

const editBranchMocks = vi.hoisted(() => ({
  forkSession: vi.fn(),
  deleteSession: vi.fn(),
}))
vi.mock('@/api/chat', () => ({
  forkSession: editBranchMocks.forkSession,
  deleteSession: editBranchMocks.deleteSession,
}))

function makeMockChatStore(overrides: {
  messages?: Array<{ id: string; role: string; content: string; timestamp: string; metadata?: Record<string, unknown> }>
  model?: string
}) {
  const messages = overrides.messages ?? []
  const store = {
    messages,
    currentSessionId: 'source-session',
    agentRole: '',
    chatMode: 'agent',
    thinkingEnabled: false,
    streaming: false,
    chatParams: { model: overrides.model ?? '' },
    setMessageFeedback: vi.fn().mockResolvedValue(null),
    loadSessions: vi.fn().mockResolvedValue(undefined),
    selectSession: vi.fn<(sessionId: string) => Promise<void>>(),
  }
  store.selectSession.mockImplementation(async (sessionId: string) => {
    store.currentSessionId = sessionId
  })
  return store
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
  let mockHandleSend: (text: string, files?: File[]) => Promise<boolean>

  beforeEach(() => {
    vi.clearAllMocks()
    mockHandleSend = vi.fn().mockResolvedValue(true)
    editBranchMocks.forkSession.mockResolvedValue({ session: { id: 'edit-branch' } })
    editBranchMocks.deleteSession.mockResolvedValue(undefined)
  })

  // AP-096/F4 修正：无模型时不再静默 cancelEdit（丢编辑+无提示），改 toast 并**保留编辑内容**。
  it('confirmEdit with no model -> messages NOT spliced, edit kept, toast shown', async () => {
    const messages = [
      { id: 'u1', role: 'user', content: 'hello', timestamp: '2025-01-01T00:00:00Z' },
      { id: 'a1', role: 'assistant', content: 'hi', timestamp: '2025-01-01T00:00:01Z' },
    ]
    const store = makeMockChatStore({ messages, model: '' })
    const toast = makeMockToast()
    const { confirmEdit, editingMsgId, editingText } = useChatActions(store as any, toast as any, mockHandleSend)

    editingMsgId.value = 'u1'
    editingText.value = 'updated text'

    await confirmEdit('u1')

    // Messages should NOT be spliced
    expect(messages).toHaveLength(2)
    // handleSend should NOT be called
    expect(mockHandleSend).not.toHaveBeenCalled()
    // 提示而非静默
    expect(toast.error).toHaveBeenCalled()
    // 编辑内容保留（不丢用户已输入）
    expect(editingMsgId.value).toBe('u1')
    expect(editingText.value).toBe('updated text')
  })

  it('confirmEdit with valid model -> source history preserved, exclusive-prefix branch receives edit', async () => {
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

    expect(messages.map((message) => message.id)).toEqual(['u1', 'a1'])
    expect(editBranchMocks.forkSession).toHaveBeenCalledWith(
      'source-session',
      'u1',
      { includeMessage: false },
    )
    expect(mockHandleSend).toHaveBeenCalledWith(
      'updated text',
      undefined,
      { targetSessionId: 'edit-branch' },
    )
    expect(store.currentSessionId).toBe('edit-branch')
  })

  it('confirmEdit with model="auto" -> source history preserved, branch receives edit', async () => {
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

    expect(messages.map((message) => message.id)).toEqual(['u1', 'a1'])
    expect(mockHandleSend).toHaveBeenCalledWith(
      'auto model edit',
      undefined,
      { targetSessionId: 'edit-branch' },
    )
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
  let mockHandleSend: (text: string, files?: File[]) => Promise<boolean>

  beforeEach(() => {
    vi.clearAllMocks()
    mockHandleSend = vi.fn().mockResolvedValue(true)
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
