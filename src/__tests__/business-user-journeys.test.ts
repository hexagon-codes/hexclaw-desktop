/**
 * 全业务链路 — 真实用户操作 + 真实数据模拟
 *
 * 旅程 A: 知识库（添加 → 搜索 → Auto-RAG）
 * 旅程 B: 定时任务（创建 → 暂停/恢复 → 触发 → 历史）
 * 旅程 C: 对话（新建 → 发消息 → 回复含代码块 → 提取 artifact → 删除会话）
 * 旅程 D: IM 渠道（元数据 → 字段验证 → Webhook URL）
 * 旅程 E: 多模型切换（Ollama + OpenAI + Auto）
 * 旅程 F: 记忆系统（保存 → 搜索 → 删除）
 * 旅程 G: MCP 工具（列表 → 调用 → 校验）
 * 旅程 H: Webhook（创建 → 列表 → 删除 URI 编码）
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

// ═══════════════════════════════════════════════════
// API 层旅程 — mock ofetch 层
// ═══════════════════════════════════════════════════

const mockApiFetch = vi.fn()
vi.mock('@/api/client', () => ({
  apiGet: (...args: unknown[]) => mockApiFetch('GET', ...args),
  apiPost: (...args: unknown[]) => mockApiFetch('POST', ...args),
  apiPut: (...args: unknown[]) => mockApiFetch('PUT', ...args),
  apiDelete: (...args: unknown[]) => mockApiFetch('DELETE', ...args),
  apiPatch: (...args: unknown[]) => mockApiFetch('PATCH', ...args),
  api: mockApiFetch,
  checkHealth: vi.fn().mockResolvedValue(true),
}))

describe('旅程 A: 知识库全流程', () => {
  beforeEach(() => { mockApiFetch.mockReset() })

  it('添加文档 → 搜索 → Auto-RAG 注入', async () => {
    // 添加文档
    mockApiFetch.mockResolvedValueOnce({ id: 'doc-3', title: '请假制度', chunk_count: 5, created_at: '2026-04-03T10:00:00Z' })
    const { addDocument } = await import('@/api/knowledge')
    const doc = await addDocument('请假制度', '年假 15 天，病假需当天申请...', 'HR 部门')
    expect(doc.title).toBe('请假制度')
    expect(mockApiFetch).toHaveBeenCalledWith('POST', '/api/v1/knowledge/documents', { title: '请假制度', content: '年假 15 天，病假需当天申请...', source: 'HR 部门' })

    // 搜索
    mockApiFetch.mockResolvedValueOnce({
      result: [
        { content: '年假天数为 15 天，需提前 3 个工作日申请。', score: 0.89, doc_id: 'doc-1', doc_title: '员工手册 2026' },
        { content: '病假需在当天上午 10 点前提交。', score: 0.72, doc_id: 'doc-1', doc_title: '员工手册 2026' },
        { content: '调休可累积至本季度末。', score: 0.45, doc_id: 'doc-1', doc_title: '员工手册 2026' },
      ],
    })
    const { searchKnowledge } = await import('@/api/knowledge')
    const res = await searchKnowledge('年假怎么请', 3)
    expect(res.result).toHaveLength(3)
    expect(res.result[0]!.score).toBe(0.89)

    // Auto-RAG 阈值过滤（>= 0.35）
    const relevant = res.result.filter(h => h.score >= 0.35)
    expect(relevant).toHaveLength(3)

    // 构建注入上下文
    const ctx = relevant.map(h => `[来源: ${h.doc_title}]\n${h.content}`).join('\n\n')
    expect(ctx).toContain('[来源: 员工手册 2026]')
    expect(ctx).toContain('年假天数为 15 天')
  })

  it('搜索无结果时 Auto-RAG 不注入', async () => {
    mockApiFetch.mockResolvedValueOnce({ result: [] })
    const { searchKnowledge } = await import('@/api/knowledge')
    const res = await searchKnowledge('完全无关', 3)
    expect(res.result.filter(h => h.score >= 0.35)).toHaveLength(0)
  })

  it('删除文档 + URI 编码', async () => {
    mockApiFetch.mockResolvedValueOnce({ message: 'deleted' })
    const { deleteDocument } = await import('@/api/knowledge')
    await deleteDocument('doc-中文ID')
    expect(mockApiFetch).toHaveBeenCalledWith('DELETE', `/api/v1/knowledge/documents/${encodeURIComponent('doc-中文ID')}`)
  })
})

describe('旅程 B: 定时任务全流程', () => {
  beforeEach(() => { mockApiFetch.mockReset() })

  it('创建 → 暂停 → 恢复 → 触发 → 查看历史', async () => {
    // 创建
    mockApiFetch.mockResolvedValueOnce({ id: 'job-1', name: '日报生成', next_run_at: '2026-04-04T09:00:00Z' })
    const { createCronJob } = await import('@/api/tasks')
    const job = await createCronJob({ name: '日报生成', schedule: '0 9 * * *', prompt: '生成今天的日报', type: 'cron' })
    expect(job.name).toBe('日报生成')

    // 暂停
    mockApiFetch.mockResolvedValueOnce({ message: 'paused' })
    const { pauseCronJob } = await import('@/api/tasks')
    await pauseCronJob(job.id)
    expect(mockApiFetch).toHaveBeenLastCalledWith('POST', `/api/v1/cron/jobs/${job.id}/pause`)

    // 恢复
    mockApiFetch.mockResolvedValueOnce({ message: 'resumed' })
    const { resumeCronJob } = await import('@/api/tasks')
    await resumeCronJob(job.id)

    // 触发
    mockApiFetch.mockResolvedValueOnce({ message: 'triggered', run_id: 'run-001' })
    const { triggerCronJob } = await import('@/api/tasks')
    const trig = await triggerCronJob(job.id)
    expect(trig.run_id).toBe('run-001')

    // 查看历史
    mockApiFetch.mockResolvedValueOnce({
      history: [
        { id: 'run-001', job_id: job.id, status: 'success', result: '日报已生成', started_at: '2026-04-03T09:00:01Z', finished_at: '2026-04-03T09:00:15Z', duration_ms: 14000 },
        { id: 'run-000', job_id: job.id, status: 'failed', error: 'LLM 超时', started_at: '2026-04-02T09:00:01Z', duration_ms: 120000 },
      ],
    })
    const { getCronJobHistory } = await import('@/api/tasks')
    const history = await getCronJobHistory(job.id)
    expect(history).toHaveLength(2)
    expect(history[0]!.status).toBe('success')
    expect(history[1]!.error).toBe('LLM 超时')
  })
})

// ═══════════════════════════════════════════════════
// Store/Component 层旅程 — 使用 service mock
// ═══════════════════════════════════════════════════

vi.mock('@/services/messageService', () => ({
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
}))

vi.mock('@/services/chatService', () => ({
  sendViaWebSocket: vi.fn(),
  sendViaBackend: vi.fn(),
  ensureWebSocketConnected: vi.fn().mockResolvedValue(false),
  clearWebSocketCallbacks: vi.fn(),
  ChatRequestError: class extends Error { noFallback = false },
}))

vi.mock('@/api/websocket', () => ({
  hexclawWS: {
    connect: vi.fn(), disconnect: vi.fn(), isConnected: vi.fn().mockReturnValue(false),
    clearCallbacks: vi.fn(), clearStreamCallbacks: vi.fn(),
    onChunk: vi.fn().mockReturnValue(() => {}), onReply: vi.fn().mockReturnValue(() => {}),
    onError: vi.fn().mockReturnValue(() => {}), onApprovalRequest: vi.fn().mockReturnValue(() => {}),
    onMemorySaved: vi.fn().mockReturnValue(() => {}),
    sendMessage: vi.fn(), sendRaw: vi.fn(), triggerError: vi.fn(),
  },
}))

vi.mock('@/api/chat', () => ({
  sendChatViaBackend: vi.fn(),
  updateMessageFeedback: vi.fn().mockResolvedValue({ message: 'ok' }),
  deleteMessage: vi.fn().mockResolvedValue({ message: 'ok' }),
}))

describe('旅程 C: 对话全流程', () => {
  beforeEach(() => { setActivePinia(createPinia()); vi.clearAllMocks() })

  it('新建会话 → 发消息 → 回复含代码块 → 提取 artifact', async () => {
    const { useChatStore } = await import('@/stores/chat')
    const { sendViaBackend } = await import('@/services/chatService')
    const store = useChatStore()

    ;(sendViaBackend as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      reply: '示例代码：\n\n```python\ndef fib(n):\n    if n <= 1: return n\n    return fib(n-1) + fib(n-2)\n```\n\n这是递归实现。',
      metadata: { backend_message_id: 'msg-001' },
    })

    store.chatParams.model = 'qwen3:8b'
    store.chatParams.provider = 'ollama'
    await store.sendMessage('写一个斐波那契函数')

    expect(store.messages).toHaveLength(2)
    expect(store.messages[0]!.content).toBe('写一个斐波那契函数')
    expect(store.messages[1]!.content).toContain('def fib(n)')

    // artifact 提取
    expect(store.artifacts.length).toBeGreaterThanOrEqual(1)
    expect(store.artifacts[0]!.language).toBe('python')
    expect(store.artifacts[0]!.content).toContain('fib(n-1)')
  })

  it('加载历史会话 → artifacts 从消息重建', async () => {
    const msgSvc = await import('@/services/messageService')
    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()

    ;(msgSvc.loadMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: 'h1', role: 'user', content: '写排序', timestamp: '2026-04-01T10:00:00Z' },
      { id: 'h2', role: 'assistant', content: '```js\narray.sort((a, b) => a - b)\n```', timestamp: '2026-04-01T10:00:05Z' },
    ])

    await store.selectSession('session-old')
    expect(store.messages).toHaveLength(2)
    expect(store.artifacts.length).toBeGreaterThanOrEqual(1)
    expect(store.artifacts[0]!.language).toBe('js')
  })

  it('删除会话 → 清空所有状态', async () => {
    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()
    store.newSession('temp')
    const sid = await store.ensureSession()
    store.messages = [{ id: 'm1', role: 'user', content: 'x', timestamp: '' }]

    await store.deleteSession(sid)
    expect(store.currentSessionId).toBeNull()
    expect(store.messages).toHaveLength(0)
    expect(store.artifacts).toHaveLength(0)
  })
})

describe('旅程 D: IM 渠道配置', () => {
  it('飞书/钉钉/Discord/Telegram/微信/企微 — 6 渠道全覆盖', async () => {
    const { CHANNEL_TYPES, CHANNEL_CONFIG_FIELDS, CHANNEL_HELP_TEXT, getRequiredFieldLabels, getPlatformHookUrl } = await import('@/api/im-channels')

    expect(CHANNEL_TYPES).toHaveLength(6)
    for (const ch of CHANNEL_TYPES) {
      const fields = CHANNEL_CONFIG_FIELDS[ch.type]
      expect(fields.length, `${ch.type} 无配置字段`).toBeGreaterThan(0)
      expect(CHANNEL_HELP_TEXT[ch.type].zh).toBeTruthy()
      expect(CHANNEL_HELP_TEXT[ch.type].en).toBeTruthy()

      // 空配置应有必填字段缺失
      const missing = getRequiredFieldLabels({ type: ch.type, config: {} })
      const requiredCount = fields.filter(f => !f.optional).length
      expect(missing.length).toBe(requiredCount)

      // Webhook URL 编码正确
      const url = getPlatformHookUrl({ name: '测试 & 特殊', type: ch.type })
      expect(url).toContain(encodeURIComponent('测试 & 特殊'))
    }
  })
})

describe('旅程 E: 多模型切换', () => {
  beforeEach(() => { setActivePinia(createPinia()); vi.clearAllMocks() })

  it('Ollama + OpenAI 并存 → 各自可选 → Auto 模式', async () => {
    vi.resetModules()
    setActivePinia(createPinia())
    vi.doMock('@/api/ollama', () => ({
      getOllamaStatus: vi.fn().mockResolvedValue({
        running: true, model_count: 1, models: [{ name: 'qwen3:8b', size: 5e9 }],
      }),
    }))
    const { useSettingsStore } = await import('@/stores/settings')
    const store = useSettingsStore()
    store.config = {
      llm: {
        providers: [
          { id: 'oll', name: 'Ollama', type: 'ollama', enabled: true, apiKey: '', baseUrl: '', models: [] },
          { id: 'oai', name: 'OpenAI', type: 'openai', enabled: true, apiKey: 'sk-x', baseUrl: '', models: [{ id: 'gpt-4o', name: 'GPT-4o', capabilities: ['text', 'vision'] }] },
        ],
        defaultModel: 'gpt-4o', defaultProviderId: 'oai', routing: { enabled: false, strategy: 'cost-aware' },
      },
      security: {} as any, general: {} as any, notification: {} as any, mcp: {} as any, memory: { enabled: true },
    }
    store.runtimeProviders = store.config.llm.providers
    await store.syncOllamaModels()

    expect(store.availableModels.length).toBeGreaterThanOrEqual(2)
    expect(store.availableModels.some(m => m.modelId === 'qwen3:8b')).toBe(true)
    expect(store.availableModels.some(m => m.modelId === 'gpt-4o')).toBe(true)
  })
})

describe('旅程 F: 记忆系统', () => {
  beforeEach(() => { mockApiFetch.mockReset() })

  it('保存 → 搜索 → 删除', async () => {
    // 保存
    mockApiFetch.mockResolvedValueOnce({ id: 'm-0', content: '用户偏好：中文回复', type: 'fact', source: 'manual', created_at: '', updated_at: '', hit_count: 0 })
    const { createMemoryEntry } = await import('@/api/memory')
    await createMemoryEntry('用户偏好：中文回复')
    expect(mockApiFetch).toHaveBeenCalledWith('POST', '/api/v1/memory', { content: '用户偏好：中文回复', type: 'fact', source: 'manual' })

    // 搜索
    mockApiFetch.mockResolvedValueOnce({
      results: [{ id: 'm-0', content: '用户偏好：中文回复', type: 'fact', source: 'manual', created_at: '', updated_at: '', hit_count: 1 }], vector_results: [{ content: '用户偏好：中文回复', score: 0.95, source: 'manual' }], total: 1,
    })
    const { searchMemory } = await import('@/api/memory')
    const res = await searchMemory('偏好')
    expect(res.results).toHaveLength(1)

    // 删除（验证 URI 编码）
    mockApiFetch.mockResolvedValueOnce({ message: 'deleted' })
    const { deleteMemoryEntry } = await import('@/api/memory')
    await deleteMemoryEntry('mem-中文')
    expect(mockApiFetch).toHaveBeenLastCalledWith('DELETE', `/api/v1/memory/${encodeURIComponent('mem-中文')}`)
  })
})

describe('旅程 G: MCP 工具', () => {
  beforeEach(() => { mockApiFetch.mockReset() })

  it('列表 → 调用 → 校验', async () => {
    // 列表
    mockApiFetch.mockResolvedValueOnce({
      tools: [{ name: 'web.search', description: '搜索' }], total: 1,
    })
    const { getMcpTools, callMcpTool } = await import('@/api/mcp')
    const tools = await getMcpTools()
    expect(tools.tools[0]!.name).toBe('web.search')

    // 调用
    mockApiFetch.mockResolvedValueOnce({ result: { items: ['result1'] } })
    const callRes = await callMcpTool('web.search', { query: 'test' })
    expect(callRes.result).toBeDefined()

    // 空名报错
    await expect(callMcpTool('', {})).rejects.toThrow('non-empty string')

    // 后端返回 error
    mockApiFetch.mockResolvedValueOnce({ result: null, error: 'tool not found' })
    await expect(callMcpTool('bad.tool', {})).rejects.toThrow('tool not found')
  })
})

describe('旅程 H: Webhook', () => {
  beforeEach(() => { mockApiFetch.mockReset() })

  it('创建 → 列表 → 删除（URI 编码中文名）', async () => {
    mockApiFetch.mockResolvedValueOnce({ id: 'wh-1', name: '企微通知', url: 'https://hooks.example.com' })
    const { createWebhook, getWebhooks, deleteWebhook } = await import('@/api/webhook')
    await createWebhook({ name: '企微通知', type: 'wecom', url: 'https://hooks.example.com', events: ['task_complete'] })

    mockApiFetch.mockResolvedValueOnce({ webhooks: [{ id: 'wh-1', name: '企微通知' }], total: 1 })
    const list = await getWebhooks()
    expect(list.webhooks).toHaveLength(1)

    mockApiFetch.mockResolvedValueOnce({ message: 'ok' })
    await deleteWebhook('企微通知')
    expect(mockApiFetch).toHaveBeenLastCalledWith('DELETE', `/api/v1/webhooks/${encodeURIComponent('企微通知')}`)
  })
})
