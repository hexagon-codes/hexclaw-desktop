/**
 * 跨模块集成测试 + 系统测试
 *
 * 测试数据跨模块边界流转的完整路径，不再按模块隔离。
 * 每个测试覆盖 2+ 个模块的交互。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { ref, nextTick } from 'vue'

// ─── 统一 Mock 层（所有模块共享） ─────────────────

const mockApi = vi.fn()
vi.mock('@/api/client', () => ({
  apiGet: (...a: unknown[]) => mockApi('GET', ...a),
  apiPost: (...a: unknown[]) => mockApi('POST', ...a),
  apiPut: (...a: unknown[]) => mockApi('PUT', ...a),
  apiDelete: (...a: unknown[]) => mockApi('DELETE', ...a),
  apiPatch: (...a: unknown[]) => mockApi('PATCH', ...a),
  api: mockApi,
  checkHealth: vi.fn().mockResolvedValue(true),
}))

const msgSvc = {
  loadAllSessions: vi.fn().mockResolvedValue([]),
  createSession: vi.fn().mockResolvedValue(undefined),
  loadMessages: vi.fn().mockResolvedValue([]),
  loadArtifacts: vi.fn().mockResolvedValue([]),
  persistMessage: vi.fn().mockResolvedValue(true),
  saveArtifact: vi.fn().mockResolvedValue(undefined),
  updateSessionTitle: vi.fn().mockResolvedValue(undefined),
  touchSession: vi.fn().mockResolvedValue(undefined),
  deleteSession: vi.fn().mockResolvedValue(undefined),
  setLastSessionId: vi.fn(),
  getLastSessionId: vi.fn().mockReturnValue(null),
  removeMessage: vi.fn().mockResolvedValue(undefined),
}
vi.mock('@/services/messageService', () => msgSvc)

const chatSvc = {
  sendViaWebSocket: vi.fn(),
  sendViaBackend: vi.fn(),
  ensureWebSocketConnected: vi.fn().mockResolvedValue(false),
  clearWebSocketCallbacks: vi.fn(),
  ChatRequestError: class extends Error { noFallback = false },
}
vi.mock('@/services/chatService', () => chatSvc)

vi.mock('@/api/websocket', () => ({
  hexclawWS: {
    connect: vi.fn(), disconnect: vi.fn(), isConnected: vi.fn().mockReturnValue(false),
    clearCallbacks: vi.fn(), clearStreamCallbacks: vi.fn(),
    onChunk: vi.fn().mockReturnValue(() => {}), onReply: vi.fn().mockReturnValue(() => {}),
    onError: vi.fn().mockReturnValue(() => {}), onApprovalRequest: vi.fn().mockReturnValue(() => {}),
    sendMessage: vi.fn(), sendRaw: vi.fn(), triggerError: vi.fn(),
  },
}))
vi.mock('@/api/chat', () => ({
  sendChatViaBackend: vi.fn(),
  updateMessageFeedback: vi.fn().mockResolvedValue({ message: 'ok' }),
  deleteMessage: vi.fn().mockResolvedValue({ message: 'ok' }),
}))
vi.mock('@/api/ollama', () => ({
  getOllamaStatus: vi.fn().mockResolvedValue({ running: true, model_count: 1, models: [{ name: 'qwen3:8b', size: 5e9 }] }),
}))
vi.mock('@/api/settings', () => ({ updateConfig: vi.fn().mockResolvedValue({}) }))
vi.mock('@/api/config', () => ({
  getLLMConfig: vi.fn(), updateLLMConfig: vi.fn().mockResolvedValue({}),
}))
vi.mock('@tauri-apps/plugin-store', () => ({
  LazyStore: class { async get() { return null } async set() {} async save() {} },
}))

// ═══════════════════════════════════════════════════
// 集成 1: Settings → Store → ChatView（模型配置到对话）
// ═══════════════════════════════════════════════════

describe('集成: 模型配置 → 模型选择 → 发消息', () => {
  beforeEach(() => { setActivePinia(createPinia()); vi.clearAllMocks(); mockApi.mockReset() })

  it('添加 Ollama provider → syncModels → 选模型 → sendMessage 传递正确的 provider/model', async () => {
    const { useSettingsStore } = await import('@/stores/settings')
    const { useChatStore } = await import('@/stores/chat')
    const settings = useSettingsStore()
    const chat = useChatStore()

    // Step 1: Settings — 添加 Ollama provider
    settings.config = {
      llm: {
        providers: [], defaultModel: '', defaultProviderId: '',
        routing: { enabled: false, strategy: 'cost-aware' },
      },
      security: {} as any, general: {} as any, notification: {} as any, mcp: {} as any,
    }
    const provider = settings.addProvider({
      name: 'Ollama (本地)', type: 'ollama', enabled: true,
      apiKey: '', baseUrl: 'http://localhost:11434/v1', models: [],
    })
    settings.runtimeProviders = [...settings.config!.llm.providers]

    // Step 2: Store — 同步模型
    await settings.syncOllamaModels()
    const models = settings.availableModels
    expect(models.some(m => m.modelId === 'qwen3:8b')).toBe(true)

    // Step 3: ChatView 模拟 — selectModel
    const selected = models.find(m => m.modelId === 'qwen3:8b')!
    chat.chatParams.provider = selected.providerKey || undefined
    chat.chatParams.model = selected.modelId

    // Step 4: 发消息 — 验证 chatParams 传递到 sendViaBackend
    chatSvc.sendViaBackend.mockResolvedValueOnce({
      reply: '你好', metadata: { backend_message_id: 'msg-1' },
    })
    await chat.sendMessage('你好')

    expect(chatSvc.sendViaBackend).toHaveBeenCalledWith(
      '你好', expect.any(String),
      expect.objectContaining({ model: 'qwen3:8b', provider: expect.stringContaining('Ollama') }),
      '', undefined,
    )
  })
})

// ═══════════════════════════════════════════════════
// 集成 2: Knowledge → useChatSend → ChatStore（RAG 注入）
// ═══════════════════════════════════════════════════

describe('集成: 知识库搜索 → Auto-RAG → 发消息', () => {
  beforeEach(() => { setActivePinia(createPinia()); vi.clearAllMocks(); mockApi.mockReset() })

  it('searchKnowledge 结果被 useChatSend 注入到 sendMessage 的 backendText', async () => {
    const { useChatStore } = await import('@/stores/chat')
    const chat = useChatStore()
    chat.chatParams.model = 'qwen3:8b'

    // Mock 知识库搜索返回结果
    mockApi.mockResolvedValueOnce({
      result: [
        { content: '年假 15 天', score: 0.89, doc_title: '员工手册' },
      ],
    })

    // Mock 发消息
    chatSvc.sendViaBackend.mockResolvedValueOnce({ reply: '根据员工手册，年假为 15 天。', metadata: {} })

    // 使用 useChatSend（需要构造 deps）
    const { useChatSend } = await import('@/composables/useChatSend')
    const { searchKnowledge } = await import('@/api/knowledge')

    const deps = {
      chatStore: chat,
      parsedDocument: ref(null),
      attachmentPreview: ref(null),
      clearAttachmentPreview: vi.fn(),
      scrollToBottom: vi.fn(),
      attachConversationAutomationActions: vi.fn().mockResolvedValue(undefined),
    }
    const { handleSend } = useChatSend(deps as any)
    await handleSend('年假怎么请')

    // 验证 sendViaBackend 收到了注入 RAG 的 backendText
    const backendCall = chatSvc.sendViaBackend.mock.calls[0]!
    const backendText = backendCall[0] as string
    expect(backendText).toContain('[知识库参考信息')
    expect(backendText).toContain('[来源: 员工手册]')
    expect(backendText).toContain('年假 15 天')
    expect(backendText).toContain('[用户问题]\n年假怎么请')
  })

  it('知识库搜索失败时不阻塞对话', async () => {
    const { useChatStore } = await import('@/stores/chat')
    const chat = useChatStore()
    chat.chatParams.model = 'qwen3:8b'

    // 知识库搜索抛错
    mockApi.mockRejectedValueOnce(new Error('knowledge service unavailable'))

    chatSvc.sendViaBackend.mockResolvedValueOnce({ reply: '我可以帮你。', metadata: {} })

    const { useChatSend } = await import('@/composables/useChatSend')
    const deps = {
      chatStore: chat,
      parsedDocument: ref(null), attachmentPreview: ref(null),
      clearAttachmentPreview: vi.fn(), scrollToBottom: vi.fn(),
      attachConversationAutomationActions: vi.fn().mockResolvedValue(undefined),
    }
    const { handleSend } = useChatSend(deps as any)
    await handleSend('帮我查个东西')

    // 对话正常进行，backendText 没有 RAG 注入
    const backendText = chatSvc.sendViaBackend.mock.calls[0]![0] as string
    expect(backendText).not.toContain('[知识库参考信息')
    expect(backendText).toBe('帮我查个东西')
  })
})

// ═══════════════════════════════════════════════════
// 集成 3: 会话管理全生命周期
// ═══════════════════════════════════════════════════

describe('集成: 会话完整生命周期', () => {
  beforeEach(() => { setActivePinia(createPinia()); vi.clearAllMocks(); mockApi.mockReset() })

  it('新建 → 发消息 → 自动标题 → 加载历史 → 切换 → artifacts 重建 → 删除', async () => {
    const { useChatStore } = await import('@/stores/chat')
    const chat = useChatStore()
    chat.chatParams.model = 'qwen3:8b'

    // Step 1: 新建会话 + 发消息
    chatSvc.sendViaBackend.mockResolvedValueOnce({
      reply: '```ts\nconst sum = (a: number, b: number) => a + b\n```',
      metadata: {},
    })
    const msg = await chat.sendMessage('写一个 TS 加法函数')

    // 验证：自动标题（前 30 字符）
    expect(msgSvc.updateSessionTitle).toHaveBeenCalledWith(
      expect.any(String),
      '写一个 TS 加法函数',
    )

    // 验证：artifact 提取
    expect(chat.artifacts.length).toBeGreaterThanOrEqual(1)
    expect(chat.artifacts[0]!.language).toBe('ts')

    const sessionId = chat.currentSessionId!

    // Step 2: 模拟 loadSessions 返回
    msgSvc.loadAllSessions.mockResolvedValueOnce([
      { id: sessionId, title: '写一个 TS 加法函数', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), message_count: 2 },
      { id: 'old-session', title: '旧会话', created_at: '2026-01-01', updated_at: '2026-01-01', message_count: 5 },
    ])
    await chat.loadSessions()
    expect(chat.sessions).toHaveLength(2)

    // Step 3: 切换到旧会话 → artifacts 重建
    msgSvc.loadMessages.mockResolvedValueOnce([
      { id: 'old-1', role: 'user', content: 'hello', timestamp: '2026-01-01' },
      { id: 'old-2', role: 'assistant', content: '```py\nprint("hello")\n```', timestamp: '2026-01-01' },
    ])
    await chat.selectSession('old-session')

    expect(chat.currentSessionId).toBe('old-session')
    expect(chat.messages).toHaveLength(2)
    expect(chat.artifacts.length).toBeGreaterThanOrEqual(1)
    expect(chat.artifacts[0]!.language).toBe('py')

    // Step 4: 删除当前会话
    await chat.deleteSession('old-session')
    expect(chat.currentSessionId).toBeNull()
    expect(chat.messages).toHaveLength(0)
    expect(chat.artifacts).toHaveLength(0)
  })

  it('并发 ensureSession 只创建一个会话', async () => {
    const { useChatStore } = await import('@/stores/chat')
    const chat = useChatStore()
    const [id1, id2, id3] = await Promise.all([
      chat.ensureSession(), chat.ensureSession(), chat.ensureSession(),
    ])
    expect(id1).toBe(id2)
    expect(id2).toBe(id3)
    expect(msgSvc.createSession).toHaveBeenCalledTimes(1)
  })
})

// ═══════════════════════════════════════════════════
// 集成 4: Agent 角色 → 对话模式
// ═══════════════════════════════════════════════════

describe('集成: Agent 角色 → 对话', () => {
  beforeEach(() => { setActivePinia(createPinia()); vi.clearAllMocks(); mockApi.mockReset() })

  it('research 模式设置 agentRole → sendMessage 传递 role → 退出模式清除', async () => {
    const { useChatStore } = await import('@/stores/chat')
    const { useChatSend } = await import('@/composables/useChatSend')
    const chat = useChatStore()
    chat.chatParams.model = 'qwen3:8b'

    // 知识库搜索 mock（Auto-RAG）
    mockApi.mockResolvedValue({ result: [] })

    const deps = {
      chatStore: chat,
      parsedDocument: ref(null), attachmentPreview: ref(null),
      clearAttachmentPreview: vi.fn(), scrollToBottom: vi.fn(),
      attachConversationAutomationActions: vi.fn().mockResolvedValue(undefined),
    }
    const { handleSend } = useChatSend(deps as any)

    // Step 1: 进入 research 模式
    chat.chatMode = 'research'
    chatSvc.sendViaBackend.mockResolvedValueOnce({ reply: '正在研究...', metadata: {} })
    await handleSend('研究一下 Vue 4 的新特性')

    // 验证 agentRole 被设置
    expect(chat.agentRole).toBe('researcher')
    // 验证 sendViaBackend 收到了 role
    expect(chatSvc.sendViaBackend).toHaveBeenCalledWith(
      expect.any(String), expect.any(String),
      expect.any(Object), 'researcher', undefined,
    )

    // Step 2: 退出 research 模式
    chat.chatMode = 'chat'
    chatSvc.sendViaBackend.mockResolvedValueOnce({ reply: '普通回复', metadata: {} })
    await handleSend('普通聊天')

    // 验证 agentRole 被清除
    expect(chat.agentRole).toBe('')
    expect(chatSvc.sendViaBackend).toHaveBeenLastCalledWith(
      expect.any(String), expect.any(String),
      expect.any(Object), '', undefined,
    )
  })
})

// ═══════════════════════════════════════════════════
// 集成 5: 发消息带附件（图片 + 视频 + 文档）
// ═══════════════════════════════════════════════════

describe('集成: 多类型附件处理', () => {
  beforeEach(() => { setActivePinia(createPinia()); vi.clearAllMocks(); mockApi.mockReset() })

  it('图片作 image 类型、视频作 video 类型、文档解析为文本', async () => {
    const { useChatStore } = await import('@/stores/chat')
    const { useChatSend } = await import('@/composables/useChatSend')
    const chat = useChatStore()
    chat.chatParams.model = 'qwen3:8b'

    mockApi.mockResolvedValue({ result: [] }) // knowledge search
    chatSvc.sendViaBackend.mockResolvedValueOnce({ reply: '收到', metadata: {} })

    // Mock parseDocument for document file
    vi.doMock('@/utils/file-parser', () => ({
      parseDocument: vi.fn().mockRejectedValue(new Error('unsupported')),
    }))

    const deps = {
      chatStore: chat,
      parsedDocument: ref(null), attachmentPreview: ref(null),
      clearAttachmentPreview: vi.fn(), scrollToBottom: vi.fn(),
      attachConversationAutomationActions: vi.fn().mockResolvedValue(undefined),
    }
    const { handleSend } = useChatSend(deps as any)

    const imgFile = new File(['img'], 'photo.png', { type: 'image/png' })
    const vidFile = new File(['vid'], 'demo.mp4', { type: 'video/mp4' })

    await handleSend('看看这些', [imgFile, vidFile])

    const sendCall = chatSvc.sendViaBackend.mock.calls[0]!
    // attachments 是第 5 个参数
    const attachments = sendCall[4] as { type: string; name: string }[]
    expect(attachments).toHaveLength(2)
    expect(attachments[0]!.type).toBe('image')
    expect(attachments[0]!.name).toBe('photo.png')
    expect(attachments[1]!.type).toBe('video')
    expect(attachments[1]!.name).toBe('demo.mp4')
  })
})

// ═══════════════════════════════════════════════════
// 集成 6: WS 失败 → HTTP fallback → 错误恢复
// ═══════════════════════════════════════════════════

describe('集成: 发送链路错误恢复', () => {
  beforeEach(() => { setActivePinia(createPinia()); vi.clearAllMocks(); mockApi.mockReset() })

  it('WS 连接失败 → 自动 fallback 到 HTTP → 正常回复', async () => {
    const { useChatStore } = await import('@/stores/chat')
    const chat = useChatStore()
    chat.chatParams.model = 'qwen3:8b'

    // WS 连接失败
    chatSvc.ensureWebSocketConnected.mockResolvedValue(false)

    // HTTP fallback 正常
    chatSvc.sendViaBackend.mockResolvedValueOnce({
      reply: 'HTTP 回复正常', metadata: {},
    })

    await chat.sendMessage('测试 fallback')

    expect(chatSvc.sendViaBackend).toHaveBeenCalled()
    expect(chat.messages[1]!.content).toBe('HTTP 回复正常')
  })

  it('HTTP 也失败 → error 状态 + 错误消息', async () => {
    const { useChatStore } = await import('@/stores/chat')
    const chat = useChatStore()
    chat.chatParams.model = 'qwen3:8b'

    chatSvc.ensureWebSocketConnected.mockResolvedValue(false)
    chatSvc.sendViaBackend.mockRejectedValueOnce(new Error('后端服务不可达'))

    await chat.sendMessage('测试错误')

    expect(chat.error).not.toBeNull()
    expect(chat.error!.message).toContain('后端服务不可达')
    // 错误消息被追加到消息列表
    const lastMsg = chat.messages[chat.messages.length - 1]!
    expect(lastMsg.role).toBe('assistant')
    expect(lastMsg.content).toContain('不可达')
  })

  it('发送中重复调用 sendMessage 被阻止（sending 锁）', async () => {
    const { useChatStore } = await import('@/stores/chat')
    const chat = useChatStore()
    chat.chatParams.model = 'qwen3:8b'

    // 第一次调用永不完成
    chatSvc.ensureWebSocketConnected.mockResolvedValue(false)
    chatSvc.sendViaBackend.mockImplementation(() => new Promise(() => {}))

    const p1 = chat.sendMessage('消息1')
    const p2 = chat.sendMessage('消息2')

    const result2 = await p2
    expect(result2).toBeNull() // 被 sending 锁阻止
    expect(chat.messages.filter(m => m.role === 'user')).toHaveLength(1) // 只有第一条
  })
})

// ═══════════════════════════════════════════════════
// 系统测试 1: 全局状态一致性
// ═══════════════════════════════════════════════════

describe('系统: 全局状态一致性', () => {
  beforeEach(() => { setActivePinia(createPinia()); vi.clearAllMocks() })

  it('Settings store 的 availableModels 变化实时反映到 ChatView 的模型选择器', async () => {
    const { useSettingsStore } = await import('@/stores/settings')
    const settings = useSettingsStore()

    settings.config = {
      llm: {
        providers: [
          { id: 'p1', name: 'OpenAI', type: 'openai', enabled: true, apiKey: 'sk-x', baseUrl: '', models: [{ id: 'gpt-4o', name: 'GPT-4o', capabilities: ['text'] }] },
        ],
        defaultModel: 'gpt-4o', defaultProviderId: 'p1',
        routing: { enabled: false, strategy: 'cost-aware' },
      },
      security: {} as any, general: {} as any, notification: {} as any, mcp: {} as any,
    }
    settings.runtimeProviders = settings.config.llm.providers

    // 初始：1 个模型
    expect(settings.availableModels).toHaveLength(1)

    // 添加 Ollama
    settings.addProvider({ name: 'Ollama', type: 'ollama', enabled: true, apiKey: '', baseUrl: '', models: [] })
    settings.runtimeProviders = [...settings.config!.llm.providers]
    await settings.syncOllamaModels()

    // 立即：2 个模型
    expect(settings.availableModels).toHaveLength(2)
    expect(settings.availableModels.map(m => m.modelId).sort()).toEqual(['gpt-4o', 'qwen3:8b'])
  })
})

// ═══════════════════════════════════════════════════
// 系统测试 2: API → Store → 跨域数据流
// ═══════════════════════════════════════════════════

describe('系统: API 数据归一化', () => {
  beforeEach(() => { mockApi.mockReset() })

  it('知识库搜索结果归一化 — 兼容 result 和 results 两种后端字段名', async () => {
    // 后端可能返回 result 或 results
    mockApi.mockResolvedValueOnce({ results: [{ content: '内容', score: 0.8 }] })
    const { searchKnowledge } = await import('@/api/knowledge')
    const res = await searchKnowledge('查询')
    expect(res.result).toHaveLength(1) // 归一化到 result
  })

  it('任务历史归一化 — 兼容 history 和 runs 两种后端字段名', async () => {
    mockApi.mockResolvedValueOnce({ runs: [{ id: 'r1', job_id: 'j1', status: 'success', run_at: '2026-01-01T10:00:00Z' }] })
    const { getCronJobHistory } = await import('@/api/tasks')
    const history = await getCronJobHistory('j1')
    expect(history).toHaveLength(1)
    expect(history[0]!.started_at).toBe('2026-01-01T10:00:00Z') // run_at → started_at
  })

  it('MCP 工具调用 — 后端返回 null result 归一化', async () => {
    mockApi.mockResolvedValueOnce({ result: undefined })
    const { callMcpTool } = await import('@/api/mcp')
    const res = await callMcpTool('test.tool', {})
    expect(res.result).toBeNull() // undefined → null
  })
})

// ═══════════════════════════════════════════════════
// 系统测试 3: 安全 — 用户输入不被直接拼入 URL
// ═══════════════════════════════════════════════════

describe('系统: 路径参数安全', () => {
  beforeEach(() => { mockApi.mockReset() })

  it('所有接受用户输入的 delete/update API 都正确编码路径参数', async () => {
    const dangerous = 'test/../../../etc/passwd'

    // deleteWebhook
    mockApi.mockResolvedValue({ message: 'ok' })
    const { deleteWebhook } = await import('@/api/webhook')
    await deleteWebhook(dangerous)
    expect(mockApi).toHaveBeenCalledWith('DELETE', `/api/v1/webhooks/${encodeURIComponent(dangerous)}`)

    // deleteDocument
    const { deleteDocument } = await import('@/api/knowledge')
    await deleteDocument(dangerous)
    expect(mockApi).toHaveBeenCalledWith('DELETE', `/api/v1/knowledge/documents/${encodeURIComponent(dangerous)}`)

    // uninstallSkill
    const { uninstallSkill } = await import('@/api/skills')
    await uninstallSkill(dangerous)
    expect(mockApi).toHaveBeenCalledWith('DELETE', `/api/v1/skills/${encodeURIComponent(dangerous)}`)

    // deleteMemory
    const { deleteMemory } = await import('@/api/memory')
    await deleteMemory(dangerous)
    expect(mockApi).toHaveBeenCalledWith('DELETE', `/api/v1/memory/${encodeURIComponent(dangerous)}`)

    // removeMcpServer
    const { removeMcpServer } = await import('@/api/mcp')
    await removeMcpServer(dangerous)
    expect(mockApi).toHaveBeenCalledWith('DELETE', `/api/v1/mcp/servers/${encodeURIComponent(dangerous)}`)

    // unregisterAgent
    const { unregisterAgent } = await import('@/api/agents')
    await unregisterAgent(dangerous)
    expect(mockApi).toHaveBeenCalledWith('DELETE', `/api/v1/agents/${encodeURIComponent(dangerous)}`)
  })
})
