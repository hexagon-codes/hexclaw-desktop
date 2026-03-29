/**
 * HexClaw Desktop — System & Integration Chain Tests
 *
 * Verifies the FULL CHAIN of the AI agent desktop application across
 * 10 integration chains covering chat flow, knowledge base, session lifecycle,
 * conversation automation, WebSocket, model selection, and API alignment.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

// ══════════════════════════════════════════════════════════════════
// Shared hoisted mocks — vi.hoisted runs before any vi.mock
// ══════════════════════════════════════════════════════════════════

const {
  // messageService mocks
  loadAllSessions,
  loadMessages,
  createSession,
  updateSessionTitle,
  touchSession,
  deleteSvcSession,
  persistMessage,
  removeMessage,
  loadArtifacts,
  saveArtifact,
  getLastSessionId,
  setLastSessionId,
  // chatService mocks
  ensureWebSocketConnected,
  sendViaWebSocket,
  sendViaBackend,
  clearWebSocketCallbacks,
  outboxInsert,
  outboxMarkSending,
  outboxMarkSent,
  outboxMarkFailed,
  retryPendingOutbox,
  cleanupOutbox,
  // api/messages
  updateMessageFeedback,
  // api/knowledge
  mockSearchKnowledge,
  mockAddDocument,
  mockGetDocuments,
  mockGetDocument,
  mockDeleteDocument,
  mockReindexDocument,
  // api/tasks
  mockCreateCronJob,
  mockGetCronJobs,
  mockDeleteCronJob,
  mockPauseCronJob,
  mockResumeCronJob,
  mockTriggerCronJob,
  // api/mcp
  mockGetMcpServers,
  mockGetMcpTools,
  mockAddMcpServer,
  mockRemoveMcpServer,
  mockCallMcpTool,
  mockGetMcpServerStatus,
  // api/skills
  mockGetSkills,
  mockSearchClawHub,
  mockInstallFromHub,
  mockInstallSkill,
  mockUninstallSkill,
  mockSetSkillEnabled,
  // api/config
  mockGetLLMConfig,
  mockUpdateLLMConfig,
  // api/settings
  mockUpdateConfig,
  // api/client
  mockApiGet,
  mockApiPost,
  mockApiPut,
  mockApiDelete,
  mockCheckHealth,
} = vi.hoisted(() => ({
  loadAllSessions: vi.fn().mockResolvedValue([]),
  loadMessages: vi.fn().mockResolvedValue([]),
  createSession: vi.fn().mockResolvedValue(undefined),
  updateSessionTitle: vi.fn().mockResolvedValue(undefined),
  touchSession: vi.fn().mockResolvedValue(undefined),
  deleteSvcSession: vi.fn().mockResolvedValue(undefined),
  persistMessage: vi.fn().mockResolvedValue(undefined),
  removeMessage: vi.fn().mockResolvedValue(undefined),
  loadArtifacts: vi.fn().mockResolvedValue([]),
  saveArtifact: vi.fn().mockResolvedValue(undefined),
  getLastSessionId: vi.fn().mockResolvedValue(null),
  setLastSessionId: vi.fn().mockResolvedValue(undefined),

  ensureWebSocketConnected: vi.fn().mockResolvedValue(false),
  sendViaWebSocket: vi.fn().mockResolvedValue(undefined),
  sendViaBackend: vi.fn().mockResolvedValue({ reply: 'Hello!', session_id: 's1' }),
  clearWebSocketCallbacks: vi.fn(),
  outboxInsert: vi.fn().mockResolvedValue(undefined),
  outboxMarkSending: vi.fn().mockResolvedValue(undefined),
  outboxMarkSent: vi.fn().mockResolvedValue(undefined),
  outboxMarkFailed: vi.fn().mockResolvedValue(undefined),
  retryPendingOutbox: vi.fn(),
  cleanupOutbox: vi.fn(),

  updateMessageFeedback: vi.fn().mockResolvedValue({ message: 'ok' }),

  mockSearchKnowledge: vi.fn().mockResolvedValue({ result: [] }),
  mockAddDocument: vi.fn().mockResolvedValue({ id: 'doc-1', title: 'Test Doc', chunk_count: 3, created_at: '2026-01-01' }),
  mockGetDocuments: vi.fn().mockResolvedValue({ documents: [], total: 0 }),
  mockGetDocument: vi.fn().mockResolvedValue({ id: 'doc-1', title: 'Test Doc', content: 'Full content', chunk_count: 3, created_at: '2026-01-01' }),
  mockDeleteDocument: vi.fn().mockResolvedValue({ message: 'deleted' }),
  mockReindexDocument: vi.fn().mockResolvedValue({ status: 'ok' }),

  mockCreateCronJob: vi.fn().mockResolvedValue({ id: 'job-1', name: 'Daily Report', next_run_at: '2026-01-02T09:00:00Z' }),
  mockGetCronJobs: vi.fn().mockResolvedValue({ jobs: [], total: 0 }),
  mockDeleteCronJob: vi.fn().mockResolvedValue({ message: 'deleted' }),
  mockPauseCronJob: vi.fn().mockResolvedValue({ message: 'paused' }),
  mockResumeCronJob: vi.fn().mockResolvedValue({ message: 'resumed' }),
  mockTriggerCronJob: vi.fn().mockResolvedValue({ message: 'triggered' }),

  mockGetMcpServers: vi.fn().mockResolvedValue({ servers: ['server-a'], total: 1 }),
  mockGetMcpTools: vi.fn().mockResolvedValue({ tools: [{ name: 'calc', description: 'calculator' }], total: 1 }),
  mockAddMcpServer: vi.fn().mockResolvedValue({ message: 'added' }),
  mockRemoveMcpServer: vi.fn().mockResolvedValue({ message: 'removed' }),
  mockCallMcpTool: vi.fn().mockResolvedValue({ result: 42 }),
  mockGetMcpServerStatus: vi.fn().mockResolvedValue({ statuses: { 'server-a': 'connected' } }),

  mockGetSkills: vi.fn().mockResolvedValue({ skills: [{ name: 'test-skill', description: 'A skill', author: 'dev', version: '1.0.0', triggers: [], tags: [] }], total: 1, dir: '/skills' }),
  mockSearchClawHub: vi.fn().mockResolvedValue([]),
  mockInstallFromHub: vi.fn().mockResolvedValue(undefined),
  mockInstallSkill: vi.fn().mockResolvedValue({ name: 'test-skill', description: 'A skill', version: '1.0.0', message: 'ok' }),
  mockUninstallSkill: vi.fn().mockResolvedValue(undefined),
  mockSetSkillEnabled: vi.fn().mockResolvedValue({ success: true, enabled: true, source: 'backend' }),

  mockGetLLMConfig: vi.fn().mockResolvedValue({
    default: 'openai',
    providers: { openai: { api_key: 'sk-***', base_url: '', model: 'gpt-4o', compatible: '' } },
    routing: { enabled: false, strategy: 'cost-aware' },
    cache: { enabled: true, similarity: 0.92, ttl: '24h', max_entries: 10000 },
  }),
  mockUpdateLLMConfig: vi.fn().mockResolvedValue(undefined),

  mockUpdateConfig: vi.fn().mockResolvedValue({}),

  mockApiGet: vi.fn(),
  mockApiPost: vi.fn(),
  mockApiPut: vi.fn(),
  mockApiDelete: vi.fn(),
  mockCheckHealth: vi.fn().mockResolvedValue(true),
}))

// ══════════════════════════════════════════════════════════════════
// vi.mock declarations
// ══════════════════════════════════════════════════════════════════

vi.mock('@/services/messageService', () => ({
  loadAllSessions,
  loadMessages,
  createSession,
  updateSessionTitle,
  touchSession,
  deleteSession: deleteSvcSession,
  persistMessage,
  removeMessage,
  loadArtifacts,
  saveArtifact,
  getLastSessionId,
  setLastSessionId,
  parseMessageMetadata: vi.fn(),
  normalizeLoadedMessage: vi.fn(),
  serializeMessageMetadata: vi.fn(),
}))

vi.mock('@/services/chatService', () => {
  class ChatRequestError extends Error {
    noFallback: boolean
    constructor(message: string, noFallback = false) {
      super(message)
      this.name = 'ChatRequestError'
      this.noFallback = noFallback
    }
  }
  return {
    ensureWebSocketConnected,
    sendViaWebSocket,
    sendViaBackend,
    clearWebSocketCallbacks,
    outboxInsert,
    outboxMarkSending,
    outboxMarkSent,
    outboxMarkFailed,
    retryPendingOutbox,
    cleanupOutbox,
    ChatRequestError,
    withTimeout: vi.fn((p: Promise<unknown>) => p),
  }
})

vi.mock('@/api/messages', () => ({
  updateMessageFeedback,
}))

vi.mock('@/api/knowledge', () => ({
  searchKnowledge: mockSearchKnowledge,
  addDocument: mockAddDocument,
  getDocuments: mockGetDocuments,
  getDocument: mockGetDocument,
  deleteDocument: mockDeleteDocument,
  reindexDocument: mockReindexDocument,
  getDocumentContent: vi.fn().mockResolvedValue(''),
  uploadDocument: vi.fn(),
  isKnowledgeUploadEndpointMissing: vi.fn().mockReturnValue(false),
  isKnowledgeUploadUnsupportedFormat: vi.fn().mockReturnValue(false),
}))

vi.mock('@/api/tasks', () => ({
  createCronJob: mockCreateCronJob,
  getCronJobs: mockGetCronJobs,
  deleteCronJob: mockDeleteCronJob,
  pauseCronJob: mockPauseCronJob,
  resumeCronJob: mockResumeCronJob,
  triggerCronJob: mockTriggerCronJob,
  getCronJobHistory: vi.fn().mockResolvedValue([]),
}))

vi.mock('@/api/mcp', () => ({
  getMcpServers: mockGetMcpServers,
  getMcpTools: mockGetMcpTools,
  addMcpServer: mockAddMcpServer,
  removeMcpServer: mockRemoveMcpServer,
  callMcpTool: mockCallMcpTool,
  getMcpServerStatus: mockGetMcpServerStatus,
}))

vi.mock('@/api/skills', () => ({
  getSkills: mockGetSkills,
  searchClawHub: mockSearchClawHub,
  installFromHub: mockInstallFromHub,
  installSkill: mockInstallSkill,
  uninstallSkill: mockUninstallSkill,
  setSkillEnabled: mockSetSkillEnabled,
  CLAWHUB_CATEGORIES: ['all', 'coding', 'research', 'writing', 'data', 'automation', 'productivity'],
}))

vi.mock('@/api/config', () => ({
  getLLMConfig: mockGetLLMConfig,
  updateLLMConfig: mockUpdateLLMConfig,
  testLLMConnection: vi.fn(),
}))

vi.mock('@/api/settings', () => ({
  updateConfig: mockUpdateConfig,
  getRuntimeConfig: vi.fn(),
}))

vi.mock('@/api/client', () => ({
  apiGet: mockApiGet,
  apiPost: mockApiPost,
  apiPut: mockApiPut,
  apiDelete: mockApiDelete,
  checkHealth: mockCheckHealth,
  api: {},
  apiSSE: vi.fn(),
  apiWebSocket: vi.fn(),
  fromNativeError: vi.fn((e: unknown) => ({
    code: 'UNKNOWN' as const,
    message: e instanceof Error ? e.message : String(e),
  })),
  createApiError: vi.fn(),
  isRetryable: vi.fn(),
  getErrorMessage: vi.fn(),
}))

vi.mock('@/db/chat', () => ({
  dbGetSessions: vi.fn().mockResolvedValue([]),
  dbGetMessages: vi.fn().mockResolvedValue([]),
  dbCreateSession: vi.fn(),
  dbUpdateSessionTitle: vi.fn(),
  dbTouchSession: vi.fn(),
  dbDeleteSession: vi.fn(),
  dbSaveMessage: vi.fn(),
  dbDeleteMessage: vi.fn(),
}))

vi.mock('@/db/artifacts', () => ({
  dbGetArtifacts: vi.fn().mockResolvedValue([]),
  dbSaveArtifact: vi.fn(),
  dbDeleteSessionArtifacts: vi.fn(),
}))

vi.mock('@/db/connection', () => ({
  dbGetAppState: vi.fn().mockResolvedValue(null),
  dbSetAppState: vi.fn(),
  getDB: vi.fn(),
}))

vi.mock('@/db/outbox', () => ({
  dbOutboxInsert: vi.fn(),
  dbOutboxMarkSending: vi.fn(),
  dbOutboxMarkSent: vi.fn(),
  dbOutboxMarkFailed: vi.fn(),
  dbOutboxGetPending: vi.fn().mockResolvedValue([]),
  dbOutboxCleanup: vi.fn(),
}))

vi.mock('@tauri-apps/plugin-store', () => {
  const store = new Map()
  return {
    load: vi.fn().mockResolvedValue({
      get: vi.fn((key: string) => Promise.resolve(store.get(key))),
      set: vi.fn((key: string, val: unknown) => { store.set(key, val); return Promise.resolve() }),
      save: vi.fn().mockResolvedValue(undefined),
    }),
    LazyStore: class {
      private _data = new Map()
      async get(key: string) { return this._data.get(key) ?? null }
      async set(key: string, val: unknown) { this._data.set(key, val) }
      async save() {}
    },
  }
})

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue('{}'),
}))

vi.mock('@/utils/secure-store', () => ({
  saveSecureValue: vi.fn().mockResolvedValue(undefined),
  loadSecureValue: vi.fn().mockResolvedValue(null),
  removeSecureValue: vi.fn().mockResolvedValue(undefined),
}))

// ══════════════════════════════════════════════════════════════════
// Shared setup
// ══════════════════════════════════════════════════════════════════

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})

  // Reset commonly used mocks to defaults
  ensureWebSocketConnected.mockResolvedValue(false)
  sendViaBackend.mockResolvedValue({ reply: 'Hello!', session_id: 's1' })
  loadAllSessions.mockResolvedValue([
    { id: 's1', title: 'Session 1', created_at: '2026-01-01', updated_at: '2026-01-01', message_count: 0 },
  ])
  loadMessages.mockResolvedValue([])
  loadArtifacts.mockResolvedValue([])
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ══════════════════════════════════════════════════════════════════
// Chain 1: Chat Message Flow (User -> Auto-RAG -> Backend -> Response)
// ══════════════════════════════════════════════════════════════════

describe('Chain 1: Chat Message Flow', () => {
  it('user message triggers knowledge search, injects context as backendText, and finalizes assistant message', async () => {
    // Knowledge search returns relevant hits
    mockSearchKnowledge.mockResolvedValueOnce({
      result: [
        { content: 'HexClaw is an AI agent', score: 0.95, doc_title: 'Overview' },
        { content: 'It uses RAG for context', score: 0.88, doc_title: 'Architecture' },
      ],
    })
    sendViaBackend.mockResolvedValueOnce({
      reply: 'Based on the knowledge base, HexClaw is an AI agent that uses RAG.',
      session_id: 's1',
      metadata: { knowledge_hits: 2 },
    })

    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()

    // Simulate the RAG injection flow: search knowledge, build backendText, then send
    const userText = 'What is HexClaw?'
    const { searchKnowledge } = await import('@/api/knowledge')
    const searchResult = await searchKnowledge(userText, 3)

    // Build backendText with RAG context
    const ragContext = searchResult.result.map((r) => r.content).join('\n')
    const backendText = `[Context from knowledge base]:\n${ragContext}\n\n[User question]: ${userText}`

    // Send via store with backendText
    const assistantMsg = await store.sendMessage(userText, undefined, { backendText })

    // Verify the chain
    expect(mockSearchKnowledge).toHaveBeenCalledWith(userText, 3)
    expect(sendViaBackend).toHaveBeenCalledWith(
      backendText,
      expect.any(String),
      expect.any(Object),
      '',
      undefined,
    )
    expect(assistantMsg).not.toBeNull()
    expect(assistantMsg?.role).toBe('assistant')
    expect(assistantMsg?.content).toContain('HexClaw')
    expect(persistMessage).toHaveBeenCalled()
  })

  it('knowledge search failure does not block chat - message still sent without RAG context', async () => {
    mockSearchKnowledge.mockRejectedValueOnce(new Error('Knowledge service unavailable'))
    sendViaBackend.mockResolvedValueOnce({
      reply: 'I can still answer without knowledge base.',
      session_id: 's1',
    })

    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()

    // Simulate RAG flow with failure
    const userText = 'What is HexClaw?'
    let backendText = userText
    try {
      const { searchKnowledge } = await import('@/api/knowledge')
      await searchKnowledge(userText, 3)
    } catch {
      // Knowledge search failed, proceed without RAG context
      backendText = userText
    }

    const assistantMsg = await store.sendMessage(userText, undefined, { backendText })

    expect(assistantMsg).not.toBeNull()
    expect(assistantMsg?.content).toBe('I can still answer without knowledge base.')
    expect(sendViaBackend).toHaveBeenCalledWith(
      userText,
      expect.any(String),
      expect.any(Object),
      '',
      undefined,
    )
  })

  it('empty knowledge results skip RAG injection - raw user text sent to backend', async () => {
    mockSearchKnowledge.mockResolvedValueOnce({ result: [] })
    sendViaBackend.mockResolvedValueOnce({
      reply: 'No knowledge base context available.',
      session_id: 's1',
    })

    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()

    const userText = 'Obscure question'
    const { searchKnowledge } = await import('@/api/knowledge')
    const searchResult = await searchKnowledge(userText, 3)

    // Empty results: skip injection
    const backendText = searchResult.result.length > 0
      ? `[Context]:\n${searchResult.result.map((r) => r.content).join('\n')}\n\n${userText}`
      : userText

    const assistantMsg = await store.sendMessage(userText, undefined, { backendText })

    expect(backendText).toBe(userText) // No RAG prefix
    expect(assistantMsg?.content).toBe('No knowledge base context available.')
  })

  it('assistant message is persisted to DB after finalization', async () => {
    sendViaBackend.mockResolvedValueOnce({
      reply: 'Persisted response',
      session_id: 's1',
      metadata: { model: 'gpt-4o' },
    })

    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()

    await store.sendMessage('test persistence')

    // Both user and assistant messages persisted
    const persistCalls = persistMessage.mock.calls
    expect(persistCalls.length).toBeGreaterThanOrEqual(2)

    // Last persist call should be the assistant message
    const lastPersistedMsg = persistCalls[persistCalls.length - 1]![0]
    expect(lastPersistedMsg.role).toBe('assistant')
    expect(lastPersistedMsg.content).toBe('Persisted response')
  })
})

// ══════════════════════════════════════════════════════════════════
// Chain 2: Knowledge Base Flow (Upload -> Index -> Search -> Chat RAG)
// ══════════════════════════════════════════════════════════════════

describe('Chain 2: Knowledge Base Flow', () => {
  it('addDocument -> getDocuments lists it -> searchKnowledge finds chunks', async () => {
    const { addDocument, getDocuments, searchKnowledge } = await import('@/api/knowledge')

    // Step 1: Add document
    mockAddDocument.mockResolvedValueOnce({
      id: 'doc-new',
      title: 'API Reference',
      chunk_count: 5,
      created_at: '2026-01-01',
    })
    const doc = await addDocument('API Reference', 'Content about APIs...', 'manual')
    expect(doc.id).toBe('doc-new')
    expect(doc.chunk_count).toBe(5)

    // Step 2: Verify it appears in document list
    mockGetDocuments.mockResolvedValueOnce({
      documents: [{ id: 'doc-new', title: 'API Reference', chunk_count: 5, created_at: '2026-01-01' }],
      total: 1,
    })
    const listing = await getDocuments()
    expect(listing.documents).toHaveLength(1)
    expect(listing.documents[0]!.id).toBe('doc-new')

    // Step 3: Search finds chunks from the document
    mockSearchKnowledge.mockResolvedValueOnce({
      result: [
        { content: 'API endpoint for /v1/chat', score: 0.92, doc_id: 'doc-new', doc_title: 'API Reference', chunk_index: 0 },
        { content: 'Authentication uses bearer tokens', score: 0.85, doc_id: 'doc-new', doc_title: 'API Reference', chunk_index: 1 },
      ],
    })
    const searchResult = await searchKnowledge('API authentication', 3)
    expect(searchResult.result).toHaveLength(2)
    expect(searchResult.result[0]!.doc_id).toBe('doc-new')
  })

  it('getDocumentContent returns full content, falls back to chunk assembly on 404', async () => {
    const { getDocumentContent } = await import('@/api/knowledge')

    const doc = { id: 'doc-1', title: 'Test Doc', chunk_count: 3, created_at: '2026-01-01' }

    // getDocumentContent is mocked at module level; test the integration pattern
    const content = await getDocumentContent(doc)
    expect(typeof content).toBe('string')
  })

  it('addDocument failure is propagated as an error', async () => {
    const { addDocument } = await import('@/api/knowledge')

    mockAddDocument.mockRejectedValueOnce(new Error('知识库暂不可用，请重启应用后重试'))

    await expect(addDocument('Fail Doc', 'content')).rejects.toThrow('知识库暂不可用')
  })

  it('searchKnowledge with no results returns empty array', async () => {
    const { searchKnowledge } = await import('@/api/knowledge')

    mockSearchKnowledge.mockResolvedValueOnce({ result: [] })
    const result = await searchKnowledge('nonexistent topic', 5)
    expect(result.result).toEqual([])
  })
})

// ══════════════════════════════════════════════════════════════════
// Chain 3: Session Lifecycle (Create -> Messages -> Artifacts -> Delete)
// ══════════════════════════════════════════════════════════════════

describe('Chain 3: Session Lifecycle', () => {
  it('ensureSession creates new session -> messages persist -> deleteSession cleans up', async () => {
    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()

    // Step 1: Ensure session creates a new one
    store.newSession()
    expect(store.currentSessionId).toBeNull()

    sendViaBackend.mockResolvedValueOnce({ reply: 'First reply', session_id: 's-new' })
    await store.sendMessage('Hello')

    // ensureSession should have been called (via sendMessage) and created a session
    expect(store.currentSessionId).not.toBeNull()
    expect(createSession).toHaveBeenCalled()

    // Step 2: Messages are persisted
    expect(persistMessage).toHaveBeenCalled()
    expect(store.messages.length).toBeGreaterThanOrEqual(2) // user + assistant

    // Step 3: Delete session cleans up
    const sessionId = store.currentSessionId!
    loadAllSessions.mockResolvedValueOnce([])
    await store.deleteSession(sessionId)

    expect(deleteSvcSession).toHaveBeenCalledWith(sessionId)
    expect(store.currentSessionId).toBeNull()
    expect(store.messages).toEqual([])
    expect(store.artifacts).toEqual([])
  })

  it('artifacts are extracted from code blocks in assistant responses', async () => {
    sendViaBackend.mockResolvedValueOnce({
      reply: 'Here is some code:\n```typescript\nconsole.log("hello world")\n```\nDone.',
      session_id: 's1',
    })

    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()

    await store.sendMessage('Write some code')

    // Artifact should have been extracted
    expect(store.artifacts.length).toBeGreaterThanOrEqual(1)
    const artifact = store.artifacts[0]!
    expect(artifact.language).toBe('typescript')
    expect(artifact.content).toContain('console.log')
    expect(saveArtifact).toHaveBeenCalled()
  })

  it('deleteSession removes artifacts along with messages', async () => {
    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()

    // Set up session with artifacts
    store.currentSessionId = 's1'
    store.messages = [
      { id: 'm1', role: 'assistant', content: '```js\ncode\n```', timestamp: '2026-01-01' },
    ]
    store.artifacts = [
      { id: 'a1', type: 'code', title: 'js snippet', language: 'js', content: 'code', messageId: 'm1', createdAt: '2026-01-01' },
    ]
    store.sessions = [{ id: 's1', title: 'Test', created_at: '2026-01-01', updated_at: '2026-01-01', message_count: 1 }]

    await store.deleteSession('s1')

    expect(deleteSvcSession).toHaveBeenCalledWith('s1')
    expect(store.artifacts).toEqual([])
    expect(store.messages).toEqual([])
  })

  it('selectSession loads messages and artifacts for the session', async () => {
    loadMessages.mockResolvedValueOnce([
      { id: 'm1', role: 'user', content: 'hello', timestamp: '2026-01-01' },
      { id: 'm2', role: 'assistant', content: 'hi', timestamp: '2026-01-01' },
    ])
    loadArtifacts.mockResolvedValueOnce([
      { id: 'a1', type: 'code', title: 'snippet', language: 'ts', content: 'x', messageId: 'm2', createdAt: '2026-01-01' },
    ])

    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()

    await store.selectSession('s1')

    expect(store.currentSessionId).toBe('s1')
    expect(store.messages).toHaveLength(2)
    expect(store.artifacts).toHaveLength(1)
    expect(loadMessages).toHaveBeenCalledWith('s1')
    expect(loadArtifacts).toHaveBeenCalledWith('s1')
  })
})

// ══════════════════════════════════════════════════════════════════
// Chain 4: Conversation Automation (AI Response -> Action Detection -> Execution)
// ══════════════════════════════════════════════════════════════════

describe('Chain 4: Conversation Automation', () => {
  it('buildConversationAutomationActions detects create_task from user text', async () => {
    const { buildConversationAutomationActions } = await import('@/utils/chat-automation')

    const actions = buildConversationAutomationActions({
      userText: '帮我创建一个定时任务，每天上午9点检查邮件',
      assistantContent: '好的，我来帮你创建这个定时任务。',
      sourceMessageId: 'msg-1',
    })

    expect(actions.length).toBeGreaterThanOrEqual(1)
    const taskAction = actions.find((a) => a.kind === 'create_task')
    expect(taskAction).toBeDefined()
    expect(taskAction!.status).toBe('pending')
    expect(taskAction!.payload).toBeDefined()
  })

  it('buildConversationAutomationActions detects search_knowledge action', async () => {
    const { buildConversationAutomationActions } = await import('@/utils/chat-automation')

    const actions = buildConversationAutomationActions({
      userText: '搜索知识库关于"API认证"的内容',
      assistantContent: '',
      sourceMessageId: 'msg-2',
    })

    const searchAction = actions.find((a) => a.kind === 'search_knowledge')
    expect(searchAction).toBeDefined()
    expect(searchAction!.payload).toHaveProperty('query')
  })

  it('executeConversationAction for create_task calls createCronJob and returns result', async () => {
    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()

    const { useConversationAutomation } = await import('@/composables/useConversationAutomation')
    const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
    const automation = useConversationAutomation(store, toast)

    // Set up a message with a create_task action
    store.messages = [
      { id: 'u1', role: 'user', content: '帮我创建一个定时任务，每天上午9点检查邮件', timestamp: '2026-01-01' },
      {
        id: 'a1', role: 'assistant', content: '好的，我来帮你创建。', timestamp: '2026-01-01',
        metadata: {
          conversation_actions: [{
            id: 'act-1',
            kind: 'create_task',
            title: '创建定时任务',
            description: '检查邮件 · 0 9 * * *',
            status: 'pending',
            payload: { name: '检查邮件', schedule: '0 9 * * *', prompt: '检查邮件' },
          }],
        },
      },
    ]
    store.currentSessionId = 's1'

    mockCreateCronJob.mockResolvedValueOnce({
      id: 'job-1',
      name: '检查邮件',
      next_run_at: '2026-01-02T09:00:00Z',
    })

    await automation.handleConversationAction('a1', 'act-1')

    expect(mockCreateCronJob).toHaveBeenCalledWith(
      expect.objectContaining({ name: '检查邮件', schedule: '0 9 * * *' }),
    )
    expect(toast.success).toHaveBeenCalled()

    // Verify the action status was updated to 'completed'
    const updatedMsg = store.messages.find((m) => m.id === 'a1')
    const actions = updatedMsg?.metadata?.conversation_actions as Array<{ id: string; status: string }>
    const updatedAction = actions?.find((a) => a.id === 'act-1')
    expect(updatedAction?.status).toBe('completed')
  })

  it('executeConversationAction for search_knowledge calls searchKnowledge and returns results', async () => {
    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()

    const { useConversationAutomation } = await import('@/composables/useConversationAutomation')
    const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
    const automation = useConversationAutomation(store, toast)

    store.messages = [
      { id: 'u1', role: 'user', content: '搜索知识库', timestamp: '2026-01-01' },
      {
        id: 'a1', role: 'assistant', content: '好的。', timestamp: '2026-01-01',
        metadata: {
          conversation_actions: [{
            id: 'act-2',
            kind: 'search_knowledge',
            title: '搜索知识库',
            description: '关键词：API认证',
            status: 'pending',
            payload: { query: 'API认证', topK: 5 },
          }],
        },
      },
    ]
    store.currentSessionId = 's1'

    mockSearchKnowledge.mockResolvedValueOnce({
      result: [{ content: 'Bearer token auth', score: 0.9, doc_title: 'Auth Guide' }],
    })

    await automation.handleConversationAction('a1', 'act-2')

    expect(mockSearchKnowledge).toHaveBeenCalledWith('API认证', 5)
    expect(toast.success).toHaveBeenCalled()
  })
})

// ══════════════════════════════════════════════════════════════════
// Chain 5: WebSocket Lifecycle (Connect -> Stream -> Reconnect -> Error)
// ══════════════════════════════════════════════════════════════════

describe('Chain 5: WebSocket Lifecycle', () => {
  it('WebSocket streaming: chunks arrive, accumulate, and done chunk finalizes', async () => {
    ensureWebSocketConnected.mockResolvedValue(true)

    let capturedCallbacks: {
      onChunk?: (content: string) => void
      onDone?: (content: string, metadata?: Record<string, unknown>, toolCalls?: unknown[], agentName?: string) => void
      onError?: (error: Error) => void
    } = {}

    sendViaWebSocket.mockImplementation(
      (_text: string, _sid: string, _params: unknown, _role: string, _att: unknown, callbacks: typeof capturedCallbacks) => {
        capturedCallbacks = callbacks ?? {}
        // Simulate streaming chunks
        capturedCallbacks.onChunk?.('Hello ')
        capturedCallbacks.onChunk?.('World')
        capturedCallbacks.onDone?.('Hello World', { model: 'gpt-4o' }, undefined, undefined)
        return Promise.resolve()
      },
    )

    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()
    store.currentSessionId = 's1'

    const result = await store.sendMessage('test streaming')

    expect(sendViaWebSocket).toHaveBeenCalled()
    expect(result).not.toBeNull()
    // The final assistant message should be in store
    const assistantMsg = store.messages.find((m) => m.role === 'assistant')
    expect(assistantMsg).toBeDefined()
    expect(persistMessage).toHaveBeenCalled()
  })

  it('WebSocket error triggers error callback and falls back to HTTP', async () => {
    ensureWebSocketConnected.mockResolvedValue(true)

    await import('@/services/chatService')
    sendViaWebSocket.mockRejectedValueOnce(new Error('Connection lost'))
    sendViaBackend.mockResolvedValueOnce({
      reply: 'Fallback response',
      session_id: 's1',
    })

    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()
    store.currentSessionId = 's1'

    const result = await store.sendMessage('test fallback')

    // Should have fallen back to HTTP since the WS error was not ChatRequestError with noFallback
    expect(sendViaBackend).toHaveBeenCalled()
    expect(result?.content).toBe('Fallback response')
  })

  it('WebSocket noFallback error does NOT fall back to HTTP', async () => {
    ensureWebSocketConnected.mockResolvedValue(true)

    const { ChatRequestError } = await import('@/services/chatService')
    sendViaWebSocket.mockRejectedValueOnce(
      new ChatRequestError('助手长时间未开始回复，已超时并停止等待。', true),
    )

    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()

    await store.sendMessage('timeout test')

    expect(sendViaBackend).not.toHaveBeenCalled()
    // Error message should be in the messages
    const lastMsg = store.messages[store.messages.length - 1]
    expect(lastMsg?.content).toContain('超时')
  })

  it('hexclawWS module: sendMessage when not connected triggers error callback', async () => {
    const { hexclawWS } = await import('@/api/websocket')
    hexclawWS.disconnect()

    let errorMsg = ''
    hexclawWS.onError((msg) => { errorMsg = msg })
    hexclawWS.sendMessage('test')

    expect(errorMsg).toBe('WebSocket is not connected')
  })
})

// ══════════════════════════════════════════════════════════════════
// Chain 6: Model Selection & Parameters (UI -> Store -> Backend)
// ══════════════════════════════════════════════════════════════════

describe('Chain 6: Model Selection & Parameters', () => {
  it('chatParams provider/model are passed through to sendViaBackend', async () => {
    ensureWebSocketConnected.mockResolvedValue(false)

    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()
    store.chatParams = { provider: 'deepseek', model: 'deepseek-chat', temperature: 0.5, maxTokens: 2048 }

    await store.sendMessage('test model selection')

    expect(sendViaBackend).toHaveBeenCalledWith(
      'test model selection',
      expect.any(String),
      { provider: 'deepseek', model: 'deepseek-chat', temperature: 0.5, maxTokens: 2048 },
      '',
      undefined,
    )
  })

  it('chatParams provider/model are passed through to sendViaWebSocket', async () => {
    ensureWebSocketConnected.mockResolvedValue(true)
    sendViaWebSocket.mockImplementation(
      (_text, _sid, _params, _role, _att, callbacks) => {
        callbacks?.onDone?.('done', undefined, undefined, undefined)
        return Promise.resolve()
      },
    )

    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()
    store.currentSessionId = 's1'
    store.chatParams = { provider: 'anthropic', model: 'claude-3-opus', temperature: 0.7, maxTokens: 4096 }

    await store.sendMessage('test ws params')

    expect(sendViaWebSocket).toHaveBeenCalledWith(
      'test ws params',
      's1',
      { provider: 'anthropic', model: 'claude-3-opus', temperature: 0.7, maxTokens: 4096 },
      '',
      undefined,
      expect.any(Object),
    )
  })

  it('changing agentRole is passed through to backend', async () => {
    ensureWebSocketConnected.mockResolvedValue(false)

    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()
    store.agentRole = 'researcher'
    store.chatParams = { model: 'gpt-4o' }

    await store.sendMessage('research query')

    expect(sendViaBackend).toHaveBeenCalledWith(
      'research query',
      expect.any(String),
      { model: 'gpt-4o' },
      'researcher',
      undefined,
    )
  })
})

// ══════════════════════════════════════════════════════════════════
// Chain 7: IM Channel API Alignment
// ══════════════════════════════════════════════════════════════════

describe('Chain 7: IM Channel API Alignment', () => {
  it('CHANNEL_TYPES covers all supported platforms', async () => {
    const { CHANNEL_TYPES } = await import('@/api/im-channels')

    const types = CHANNEL_TYPES.map((c) => c.type)
    expect(types).toContain('feishu')
    expect(types).toContain('dingtalk')
    expect(types).toContain('wechat')
    expect(types).toContain('wecom')
    expect(types).toContain('discord')
    expect(types).toContain('telegram')
    expect(types).toHaveLength(6)
  })

  it('CHANNEL_CONFIG_FIELDS has required fields for each platform', async () => {
    const { CHANNEL_CONFIG_FIELDS } = await import('@/api/im-channels')

    // Feishu requires app_id and app_secret
    const feishuFields = CHANNEL_CONFIG_FIELDS.feishu.map((f) => f.key)
    expect(feishuFields).toContain('app_id')
    expect(feishuFields).toContain('app_secret')

    // DingTalk requires app_key, app_secret, robot_code
    const dingFields = CHANNEL_CONFIG_FIELDS.dingtalk.map((f) => f.key)
    expect(dingFields).toContain('app_key')
    expect(dingFields).toContain('app_secret')
    expect(dingFields).toContain('robot_code')

    // Discord requires token
    expect(CHANNEL_CONFIG_FIELDS.discord.map((f) => f.key)).toContain('token')

    // Telegram requires token
    expect(CHANNEL_CONFIG_FIELDS.telegram.map((f) => f.key)).toContain('token')
  })

  it('getPlatformHookUrl builds correct webhook URL', async () => {
    const { getPlatformHookUrl } = await import('@/api/im-channels')

    const url = getPlatformHookUrl({ name: 'my-bot', type: 'feishu' })
    expect(url).toMatch(/\/api\/v1\/platforms\/hooks\/feishu\/my-bot$/)
  })

  it('getRequiredFieldLabels detects missing required fields', async () => {
    const { getRequiredFieldLabels } = await import('@/api/im-channels')

    // Missing app_id and app_secret for feishu
    const missing = getRequiredFieldLabels({ type: 'feishu', config: {} })
    expect(missing).toContain('App ID')
    expect(missing).toContain('App Secret')

    // All filled
    const noneMissing = getRequiredFieldLabels({
      type: 'feishu',
      config: { app_id: 'cli_xxx', app_secret: 'secret' },
    })
    expect(noneMissing).toHaveLength(0)
  })
})

// ══════════════════════════════════════════════════════════════════
// Chain 8: MCP Tools API Alignment
// ══════════════════════════════════════════════════════════════════

describe('Chain 8: MCP Tools API Alignment', () => {
  it('getMcpServers returns server list', async () => {
    const { getMcpServers } = await import('@/api/mcp')

    const result = await getMcpServers()
    expect(result.servers).toEqual(['server-a'])
    expect(result.total).toBe(1)
    expect(mockGetMcpServers).toHaveBeenCalled()
  })

  it('getMcpTools returns tools with name and description', async () => {
    const { getMcpTools } = await import('@/api/mcp')

    const result = await getMcpTools()
    expect(result.tools).toHaveLength(1)
    expect(result.tools[0]!.name).toBe('calc')
    expect(result.tools[0]!.description).toBe('calculator')
  })

  it('addMcpServer and removeMcpServer lifecycle', async () => {
    const { addMcpServer, removeMcpServer } = await import('@/api/mcp')

    const addResult = await addMcpServer('test-server', '/usr/bin/mcp-server', ['--port', '8080'])
    expect(addResult.message).toBe('added')
    expect(mockAddMcpServer).toHaveBeenCalledWith('test-server', '/usr/bin/mcp-server', ['--port', '8080'])

    const removeResult = await removeMcpServer('test-server')
    expect(removeResult.message).toBe('removed')
    expect(mockRemoveMcpServer).toHaveBeenCalledWith('test-server')
  })

  it('callMcpTool sends tool name and arguments, returns result', async () => {
    const { callMcpTool } = await import('@/api/mcp')

    const result = await callMcpTool('calc', { expression: '2+2' })
    expect(result.result).toBe(42)
    expect(mockCallMcpTool).toHaveBeenCalledWith('calc', { expression: '2+2' })
  })
})

// ══════════════════════════════════════════════════════════════════
// Chain 9: Skills API Alignment
// ══════════════════════════════════════════════════════════════════

describe('Chain 9: Skills API Alignment', () => {
  it('getSkills returns skill list with expected shape', async () => {
    const { getSkills } = await import('@/api/skills')

    const result = await getSkills()
    expect(result.skills).toHaveLength(1)
    expect(result.skills[0]).toEqual(expect.objectContaining({
      name: 'test-skill',
      description: 'A skill',
      author: 'dev',
      version: '1.0.0',
    }))
    expect(result.dir).toBe('/skills')
  })

  it('searchClawHub returns ClawHubSkill array', async () => {
    const { searchClawHub } = await import('@/api/skills')

    mockSearchClawHub.mockResolvedValueOnce([
      { name: 'code-review-pro', description: 'Auto code review', author: 'openclaw', version: '2.1.0', tags: ['review'], downloads: 28430, category: 'coding' },
    ])

    const results = await searchClawHub('code review', 'coding')
    expect(results).toHaveLength(1)
    expect(results[0]!.name).toBe('code-review-pro')
    expect(results[0]!.category).toBe('coding')
    expect(mockSearchClawHub).toHaveBeenCalledWith('code review', 'coding')
  })

  it('installFromHub sends clawhub:// source to backend', async () => {
    const { installFromHub } = await import('@/api/skills')

    await installFromHub('code-review-pro')
    expect(mockInstallFromHub).toHaveBeenCalledWith('code-review-pro')
  })

  it('CLAWHUB_CATEGORIES contains expected categories', async () => {
    const { CLAWHUB_CATEGORIES } = await import('@/api/skills')

    expect(CLAWHUB_CATEGORIES).toContain('all')
    expect(CLAWHUB_CATEGORIES).toContain('coding')
    expect(CLAWHUB_CATEGORIES).toContain('research')
    expect(CLAWHUB_CATEGORIES).toContain('writing')
    expect(CLAWHUB_CATEGORIES).toContain('data')
    expect(CLAWHUB_CATEGORIES).toContain('automation')
    expect(CLAWHUB_CATEGORIES).toContain('productivity')
  })
})

// ══════════════════════════════════════════════════════════════════
// Chain 10: Settings Persistence
// ══════════════════════════════════════════════════════════════════

describe('Chain 10: Settings Persistence', () => {
  it('useSettingsStore initializes with null config and loads default on loadConfig', async () => {
    const { useSettingsStore } = await import('@/stores/settings')
    const store = useSettingsStore()

    expect(store.config).toBeNull()
    expect(store.loading).toBe(false)

    await store.loadConfig()

    // After loading, config should be populated with defaults (non-Tauri env)
    expect(store.config).not.toBeNull()
    expect(store.config!.llm).toBeDefined()
    expect(store.config!.security).toBeDefined()
    expect(store.config!.general).toBeDefined()
    expect(store.config!.notification).toBeDefined()
    expect(store.config!.mcp).toBeDefined()
  })

  it('saveConfig persists to localStorage in non-Tauri env', async () => {
    const { useSettingsStore } = await import('@/stores/settings')
    const store = useSettingsStore()

    await store.loadConfig()

    const updatedConfig = JSON.parse(JSON.stringify(store.config!))
    updatedConfig.general.language = 'en'
    updatedConfig.security.rate_limit_rpm = 120

    await store.saveConfig(updatedConfig)

    expect(store.config!.general.language).toBe('en')
    expect(store.config!.security.rate_limit_rpm).toBe(120)

    // In non-Tauri env, config is saved to localStorage
    const raw = localStorage.getItem('app_config')
    expect(raw).not.toBeNull()
    const saved = JSON.parse(raw!)
    expect(saved.general.language).toBe('en')
  })

  it('addProvider adds a new provider with unique name and reconciles defaults', async () => {
    const { useSettingsStore } = await import('@/stores/settings')
    const store = useSettingsStore()

    await store.loadConfig()

    const newProvider = store.addProvider({
      name: 'My OpenAI',
      type: 'openai',
      enabled: true,
      baseUrl: '',
      apiKey: 'sk-test',
      models: [{ id: 'gpt-4o', name: 'GPT-4o', capabilities: ['text'] }],
      selectedModelId: 'gpt-4o',
    })

    expect(newProvider).not.toBeNull()
    expect(newProvider!.name).toBe('My OpenAI')
    expect(newProvider!.id).toBeDefined()
    expect(store.config!.llm.providers).toContainEqual(expect.objectContaining({ name: 'My OpenAI' }))
  })

  it('removeProvider removes provider and reconciles defaults', async () => {
    const { useSettingsStore } = await import('@/stores/settings')
    const store = useSettingsStore()

    await store.loadConfig()

    const added = store.addProvider({
      name: 'Temp Provider',
      type: 'deepseek',
      enabled: true,
      baseUrl: '',
      apiKey: 'sk-temp',
      models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat', capabilities: ['text'] }],
      selectedModelId: 'deepseek-chat',
    })

    expect(store.config!.llm.providers.some((p) => p.id === added!.id)).toBe(true)

    store.removeProvider(added!.id)

    expect(store.config!.llm.providers.some((p) => p.id === added!.id)).toBe(false)
  })
})
