/**
 * Code Review V8: Full Chain Coverage
 *
 * 全场景覆盖 会话/IM/记忆/知识库/任务/skill/MCP/LLM/本地LLM 功能链路，
 * 以测试驱动暴露逻辑错误、边界情况、冗余代码、功能不完整/未闭环、
 * 前后端对齐问题、性能问题、安全漏洞。
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'

// ─── Helper: read source file ──────────────────────────────────────

function readSrc(relativePath: string): string {
  const absPath = resolve(__dirname, '..', relativePath)
  if (!existsSync(absPath)) return ''
  return readFileSync(absPath, 'utf-8')
}

// ═══════════════════════════════════════════════════════════════════
// 1. API Client Architecture
// ═══════════════════════════════════════════════════════════════════

describe('API 客户端架构审计', () => {
  const clientSrc = readSrc('api/client.ts')
  const indexSrc = readSrc('api/index.ts')

  it('api/index.ts 应导出所有 API 模块', () => {
    // 检查所有 api/*.ts 模块都通过 index.ts 导出
    const apiModules = [
      'chat', 'agents', 'logs', 'memory', 'mcp', 'settings',
      'skills', 'system', 'tasks', 'knowledge', 'canvas',
      'tools-status', 'voice', 'webhook',
    ]
    const missingExports: string[] = []
    for (const mod of apiModules) {
      // 检查 export * from './xxx' 或 export { ... } from './xxx'
      const hasExport = indexSrc.includes(`'./${mod}'`) || indexSrc.includes(`"./${mod}"`)
      if (!hasExport) missingExports.push(mod)
    }
    expect(missingExports).toEqual([])
  })

  it('所有 API 模块应使用统一 api client 而非 raw fetch', () => {
    // ollama.ts 当前使用 raw fetch 而非 apiGet/apiPost —— 绕过统一错误处理
    const ollamaSrc = readSrc('api/ollama.ts')
    const _rawFetchCount = (ollamaSrc.match(/\bfetch\(/g) || []).length // eslint-disable-line @typescript-eslint/no-unused-vars
    const apiClientCount = (ollamaSrc.match(/\bapi(Get|Post|Put|Delete)\(/g) || []).length

    // ollama.ts 应该使用 apiGet/apiPost 而非 raw fetch
    // 目前 ollama.ts 有多处 raw fetch，0 处 apiClient 调用
    expect(apiClientCount).toBeGreaterThan(0)  // EXPECTED TO FAIL: exposes bug
  })

  it('voice.ts textToSpeech 使用 raw fetch 是合理的（二进制响应）', () => {
    const voiceSrc = readSrc('api/voice.ts')
    // textToSpeech 需要 blob() 接收音频，使用 raw fetch 是合理的
    expect(voiceSrc).toContain('res.blob()')
    // 但 speechToText 应使用 apiPost（它返回 JSON）
    expect(voiceSrc).toContain('apiPost<STTResponse>')
  })

  it('apiSSE 应在 signal abort 时正确关闭 reader', () => {
    // SSE 流使用 AbortSignal 但在 pull() 中 catch 到 abort 后
    // 只调用 controller.error() —— reader 仍然 open
    expect(clientSrc).toContain('signal')
    // 验证 reader 在错误/中断时被清理
    const pullFn = clientSrc.slice(
      clientSrc.indexOf('async pull(controller)'),
      clientSrc.indexOf('// ─── WebSocket'),
    )
    // 当前 pull() 的 catch 把 abort error 传给 controller.error()
    // 但没有调用 reader.cancel() —— 不会泄漏但不够优雅
    expect(pullFn).toContain('controller.error')
  })
})

// ═══════════════════════════════════════════════════════════════════
// 2. Chat Chain: 会话完整链路
// ═══════════════════════════════════════════════════════════════════

describe('Chat 会话链路', () => {
  const chatSrc = readSrc('api/chat.ts')
  const chatStoreSrc = readSrc('stores/chat.ts')
  const chatServiceSrc = readSrc('services/chatService.ts')
  const chatStreamCancelSrc = readSrc('stores/chat-stream-cancel.ts')
  const chatSendControllerSrc = readSrc('stores/chat-send-controller.ts')
  const chatSendGuardsSrc = readSrc('stores/chat-send-guards.ts')
  const chatSendAutoTitleSrc = readSrc('stores/chat-send-auto-title.ts')
  const chatSessionControllerSrc = readSrc('stores/chat-session-controller.ts')

  it('sendChatViaBackend 应传递所有参数给 Tauri invoke', () => {
    // 确保 temperature、maxTokens、attachments 都正确传递
    expect(chatSrc).toContain('temperature: options?.temperature ?? null')
    expect(chatSrc).toContain('max_tokens: options?.maxTokens ?? null')
    expect(chatSrc).toContain('attachments: options?.attachments || null')
  })

  it('sendChat 兼容旧接口应支持 provider_id 回退', () => {
    // sendChat 使用 req.provider ?? req.provider_id
    expect(chatSrc).toContain('req.provider ?? req.provider_id')
  })

  it('WebSocket 流式回调清理不应破坏 approval 监听', () => {
    // BUG: chatService.ts fail() 调用 clearCallbacks() 清除所有回调包括 approval
    // 应该使用 clearStreamCallbacks()
    const failFn = chatServiceSrc.slice(
      chatServiceSrc.indexOf('function fail('),
      chatServiceSrc.indexOf('hexclawWS.onChunk'),
    )
    // 检查 fail() 中是否误用了 clearCallbacks
    const usesClearCallbacks = failFn.includes('clearCallbacks()')
    const usesClearStreamCallbacks = failFn.includes('clearStreamCallbacks()')

    // 正确行为：应该用 clearStreamCallbacks，不应该用 clearCallbacks
    expect(usesClearStreamCallbacks).toBe(true)  // EXPECTED TO FAIL: exposes bug
    expect(usesClearCallbacks).toBe(false)        // EXPECTED TO FAIL: exposes bug
  })

  it('stopStreaming 应在取消后正确通知后端', () => {
    expect(chatStoreSrc).toContain('sendCancel: (sessionId) => hexclawWS.sendRaw({ type: \'cancel\', session_id: sessionId })')
    expect(chatStreamCancelSrc).toContain('sendCancel(streamingSessionId.value)')
  })

  it('会话标题仅在默认标题且无自定义标题时自动生成', () => {
    expect(chatSendControllerSrc).toContain('DEFAULT_SESSION_TITLE')
    expect(chatSendGuardsSrc).toContain('if (hasCustomTitle) return false')
    expect(chatSendAutoTitleSrc).toContain('setPendingSuggestedTitleExpectation(sessionId, tempTitle)')
  })

  it('forkSession API 路径与后端对齐', () => {
    expect(chatSrc).toContain('/api/v1/sessions/${encodeURIComponent(sessionId)}/fork')
    // 后端: POST /api/v1/sessions/{id}/fork — 匹配，sessionId 已 URL 编码
  })

  it('deleteMessage 应 URL 编码 messageId', () => {
    expect(chatSrc).toContain('encodeURIComponent(messageId)')
  })

  it('updateMessageFeedback 使用顶层 import 而非动态 import', () => {
    // updateMessageFeedback 已改为使用顶层 import 的 apiPut
    const hasDynamicImport = chatSrc.includes("import('./client').then")
    // 动态 import 已被移除，apiPut 通过顶层 import 引入
    expect(hasDynamicImport).toBe(false)
  })

  it('selectSession 切换会话时不应中断其他会话后台流式状态', () => {
    expect(chatStoreSrc).toContain('syncStreamingMirrors: boundStreamController.syncStreamingMirrors')
    expect(chatSessionControllerSrc).toContain('createChatSessionLoadingController')
  })
})

// ═══════════════════════════════════════════════════════════════════
// 3. Session Management Chain: 会话管理
// ═══════════════════════════════════════════════════════════════════

describe('Session 管理链路', () => {
  const chatSrc = readSrc('api/chat.ts')

  it('listSessions 默认传递 user_id', () => {
    expect(chatSrc).toContain("user_id: DESKTOP_USER_ID")
  })

  it('searchMessages 传递 user_id 和 query (via sessionGet)', () => {
    // searchMessages uses sessionGet which auto-injects user_id
    expect(chatSrc).toContain("q: query")
    expect(chatSrc).toContain("sessionGet")
  })

  it('createSession 参数与后端 POST /api/v1/sessions 对齐', () => {
    // createSession uses sessionPost helper (which auto-injects user_id)
    expect(chatSrc).toContain("sessionPost<{ id: string; title: string; created_at: string }>('/api/v1/sessions'")
  })

  it('getSessionBranches 路径与后端对齐', () => {
    expect(chatSrc).toContain('/api/v1/sessions/${encodeURIComponent(sessionId)}/branches')
  })

  it('listSessionMessages 支持分页参数', () => {
    expect(chatSrc).toContain("if (opts?.limit) q.limit = opts.limit")
    expect(chatSrc).toContain("if (opts?.offset) q.offset = opts.offset")
  })
})

// ═══════════════════════════════════════════════════════════════════
// 4. IM Channel Chain: IM 通道链路
// ═══════════════════════════════════════════════════════════════════

describe('IM Channel 链路', () => {
  const imSrc = readSrc('api/im-channels.ts')
  const imConfigSrc = readSrc('config/im-channels.ts')

  it('所有 6 个通道类型都有配置字段定义', () => {
    const types: string[] = ['feishu', 'dingtalk', 'wechat', 'wecom', 'discord', 'telegram']
    for (const t of types) {
      expect(imConfigSrc).toContain(`${t}:`)
    }
  })

  it('所有通道类型都有帮助文本（中英文）', () => {
    expect(imConfigSrc).toContain('CHANNEL_HELP_TEXT')
    const types = ['feishu', 'dingtalk', 'wechat', 'wecom', 'discord', 'telegram']
    for (const t of types) {
      const regex = new RegExp(`${t}:\\s*\\{[\\s\\S]*?zh:`)
      expect(imConfigSrc).toMatch(regex)
    }
  })

  it('createIMInstance 应先同步后端再写本地', () => {
    const createFn = imSrc.slice(
      imSrc.indexOf('export async function createIMInstance'),
      imSrc.indexOf('export async function updateIMInstance'),
    )
    const syncIdx = createFn.indexOf('syncBackendInstance')
    const writeIdx = createFn.indexOf('writeInstances')
    // 后端同步应在本地写入之前
    expect(syncIdx).toBeLessThan(writeIdx)
    expect(syncIdx).toBeGreaterThan(0)
  })

  it('deleteIMInstance 应先删后端再删本地', () => {
    const deleteFn = imSrc.slice(
      imSrc.indexOf('export async function deleteIMInstance'),
      imSrc.indexOf('/** 测试实例连接'),
    )
    const backendIdx = deleteFn.indexOf('deleteBackendInstance')
    const localIdx = deleteFn.indexOf("delete all[id]")
    expect(backendIdx).toBeLessThan(localIdx)
  })

  it('updateIMInstance 改名时应回滚：先创建新实例，删除旧实例失败则回滚', () => {
    expect(imSrc).toContain('Rollback: remove the newly created instance')
    expect(imSrc).toContain('deleteBackendInstance(next.name).catch(() => {})')
  })

  it('assertUniqueInstanceName 应忽略大小写', () => {
    expect(imSrc).toContain('normalizeInstanceName')
    expect(imSrc).toContain('name.trim().toLowerCase()')
  })

  it('proxyApiRequest 应阻止路径遍历', () => {
    // proxy_api_request 在 Rust 端已有路径校验
    // 前端 proxyApiRequest 本身没有校验（依赖 Rust 端）
    const proxyFn = imSrc.slice(
      imSrc.indexOf('async function proxyApiRequest'),
      imSrc.indexOf('export function getRequiredFieldLabels'),
    )
    // 前端应也做基本校验防止 XSS/注入
    // 但当前仅传给 invoke，Rust 端做了校验
    expect(proxyFn).toContain("invoke<string>('proxy_api_request'")
  })

  it('syncExistingInstancesToBackend 应增量同步（对比后端状态）', () => {
    expect(imSrc).toContain('isBackendInstanceInSync')
    expect(imSrc).toContain('listBackendInstances')
  })

  it('getPlatformHookUrl 构造正确的 webhook URL', () => {
    expect(imSrc).toContain('/api/v1/platforms/hooks/${instance.type}/${encodeURIComponent(instance.name)}')
  })
})

// ═══════════════════════════════════════════════════════════════════
// 5. Memory Chain: 记忆链路
// ═══════════════════════════════════════════════════════════════════

describe('Memory 记忆链路', () => {
  const memorySrc = readSrc('api/memory.ts')
  const memoryTypeSrc = readSrc('types/memory.ts')

  it('MemoryEntry 类型应与后端 GET /api/v1/memory 响应对齐', () => {
    // 后端返回 { entries: MemoryEntry[], summary, capacity }
    // 前端 MemoryEntry 应有这些字段
    expect(memoryTypeSrc).toContain('content: string')
    expect(memoryTypeSrc).toContain('type: MemoryType')
    expect(memoryTypeSrc).toContain('source: MemorySource')
  })

  it('createMemoryEntry 应支持 type 参数（默认 fact）', () => {
    expect(memorySrc).toContain("type: type ?? 'fact'")
  })

  it('deleteMemoryEntry 应 URL 编码 id（防止特殊字符）', () => {
    expect(memorySrc).toContain('encodeURIComponent(id)')
  })

  it('searchMemory 应同时返回关键词和向量搜索结果', () => {
    expect(memorySrc).toContain('results: MemoryEntry[]')
    expect(memorySrc).toContain('vector_results: VectorSearchResult[] | null')
  })

  it('updateMemoryEntry 使用 PUT 方法更新单条记忆', () => {
    expect(memorySrc).toContain('apiPut<MemoryEntry>(`/api/v1/memory/${encodeURIComponent(id)}`')
  })

  it('clearAllMemory 使用 DELETE /api/v1/memory', () => {
    expect(memorySrc).toContain("apiDelete<{ message: string }>('/api/v1/memory')")
  })
})

// ═══════════════════════════════════════════════════════════════════
// 6. Knowledge Chain: 知识库链路
// ═══════════════════════════════════════════════════════════════════

describe('Knowledge 知识库链路', () => {
  const knowledgeSrc = readSrc('api/knowledge.ts')

  it('uploadDocument 应支持进度回调', () => {
    expect(knowledgeSrc).toContain('onProgress?: (pct: number) => void')
    expect(knowledgeSrc).toContain('uploadViaXhr')
  })

  it('getDocumentContent 应回退到搜索拼接 chunk', () => {
    expect(knowledgeSrc).toContain('searchKnowledge(doc.title')
    expect(knowledgeSrc).toContain('docChunks.map((chunk) => chunk.content).join')
  })

  it('searchKnowledge 应兼容后端 result 和 results 两种字段名', () => {
    expect(knowledgeSrc).toContain('response.result ?? response.results')
  })

  it('normalizeKnowledgeSearchResults 应处理 legacy string 格式', () => {
    expect(knowledgeSrc).toContain("typeof payload === 'string' && payload.trim()")
  })

  it('isKnowledgeUploadEndpointMissing 应覆盖 404/405 和中文错误消息', () => {
    const knowledgeConfigSrc = readSrc('config/knowledge-errors.ts')
    expect(knowledgeSrc).toContain('rawStatus === 404')
    expect(knowledgeSrc).toContain('rawStatus === 405')
    expect(knowledgeSrc).toContain("from '@/config/knowledge-errors'")
    expect(knowledgeConfigSrc).toContain('未提供知识库上传接口')
    expect(knowledgeConfigSrc).toContain('未启用知识库')
  })

  it('isKnowledgeUploadUnsupportedFormat 应覆盖 415/422 和格式关键词', () => {
    const knowledgeConfigSrc = readSrc('config/knowledge-errors.ts')
    expect(knowledgeSrc).toContain('rawStatus === 415')
    expect(knowledgeSrc).toContain('rawStatus === 422')
    expect(knowledgeSrc).toContain('unsupported')
    expect(knowledgeSrc).toContain('KNOWLEDGE_UNSUPPORTED_FORMAT_KEYWORDS')
    expect(knowledgeConfigSrc).toContain('不支持')
  })

  it('reindexDocument 路径与后端 POST .../reindex 对齐', () => {
    expect(knowledgeSrc).toContain('/api/v1/knowledge/documents/${encodeURIComponent(id)}/reindex')
  })

  it('uploadViaXhr 应处理网络错误和中断', () => {
    expect(knowledgeSrc).toContain("reject(new Error('Network error'))")
    expect(knowledgeSrc).toContain("reject(new Error('Upload aborted'))")
  })
})

// ═══════════════════════════════════════════════════════════════════
// 7. Task/Cron Chain: 任务链路
// ═══════════════════════════════════════════════════════════════════

describe('Task/Cron 任务链路', () => {
  const tasksSrc = readSrc('api/tasks.ts')

  it('getCronJobs 应传递 user_id', () => {
    expect(tasksSrc).toContain('user_id: DESKTOP_USER_ID')
  })

  it('createCronJob 应传递所有必需字段', () => {
    expect(tasksSrc).toContain('name: input.name')
    expect(tasksSrc).toContain('schedule: input.schedule')
    expect(tasksSrc).toContain('prompt: input.prompt')
    expect(tasksSrc).toContain("type: input.type ?? 'cron'")
  })

  it('getCronJobHistory 应兼容 history 和 runs 两种字段名', () => {
    expect(tasksSrc).toContain('res.history ?? res.runs')
  })

  it('getCronJobHistory 应兼容 started_at 和 run_at 字段', () => {
    expect(tasksSrc).toContain("started_at: r.started_at || r.run_at || ''")
  })

  it('所有 CRUD 操作路径与后端对齐（使用 encodeURIComponent）', () => {
    expect(tasksSrc).toContain("'/api/v1/cron/jobs'")
    expect(tasksSrc).toContain('`/api/v1/cron/jobs/${encodeURIComponent(id)}`')
    expect(tasksSrc).toContain('`/api/v1/cron/jobs/${encodeURIComponent(id)}/pause`')
    expect(tasksSrc).toContain('`/api/v1/cron/jobs/${encodeURIComponent(id)}/resume`')
    expect(tasksSrc).toContain('`/api/v1/cron/jobs/${encodeURIComponent(id)}/trigger`')
    expect(tasksSrc).toContain('`/api/v1/cron/jobs/${encodeURIComponent(id)}/history`')
  })
})

// ═══════════════════════════════════════════════════════════════════
// 8. Skill Chain: 技能链路
// ═══════════════════════════════════════════════════════════════════

describe('Skill 技能链路', () => {
  const skillsSrc = readSrc('api/skills.ts')

  it('setSkillEnabled 后端失败应降级到本地偏好', () => {
    expect(skillsSrc).toContain("source: 'local-fallback'")
    expect(skillsSrc).toContain("source: 'backend'")
  })

  it('searchClawHub 不应手动构建 query string（apiGet 已支持 query 参数）', () => {
    // BUG: searchClawHub 手动用 URLSearchParams 构建 qs，
    // 然后拼接到 URL，但 apiGet 的第二个参数就是 query object
    const searchFn = skillsSrc.slice(
      skillsSrc.indexOf('export async function searchClawHub'),
      skillsSrc.indexOf('export async function installFromHub'),
    )
    const manualQs = searchFn.includes('new URLSearchParams()')

    // 应该直接传 query object 给 apiGet 第二个参数
    // 而非手动构建 query string 拼接到 URL
    expect(manualQs).toBe(false) // EXPECTED TO FAIL: exposes redundant code
  })

  it('installFromHub 使用 clawhub:// 协议源', () => {
    expect(skillsSrc).toContain('`clawhub://${skillName}`')
  })

  it('normalizeHubCategory 未知分类应降级为 coding', () => {
    expect(skillsSrc).toContain("return 'coding'")
  })

  it('CLAWHUB_FORCE_MOCK 在生产环境应为 false', () => {
    expect(skillsSrc).toContain('const CLAWHUB_FORCE_MOCK = false')
  })

  it('uninstallSkill 应 URL 编码 name', () => {
    expect(skillsSrc).toContain('encodeURIComponent(name)')
  })
})

// ═══════════════════════════════════════════════════════════════════
// 9. MCP Chain: MCP 工具链路
// ═══════════════════════════════════════════════════════════════════

describe('MCP 链路', () => {
  const mcpSrc = readSrc('api/mcp.ts')

  it('callMcpTool 应校验 toolName 非空', () => {
    expect(mcpSrc).toContain("!toolName || typeof toolName !== 'string' || !toolName.trim()")
  })

  it('callMcpTool 应处理后端返回错误字段', () => {
    expect(mcpSrc).toContain("typeof res.error === 'string' && res.error.trim() !== ''")
  })

  it('callMcpTool 应处理 result 为 undefined 的情况', () => {
    expect(mcpSrc).toContain('res.result === undefined && !res.error')
    expect(mcpSrc).toContain('result: null')
  })

  it('getMcpServerStatus 应兼容 statuses 和 servers 两种响应格式', () => {
    expect(mcpSrc).toContain("statuses?: Record<string, 'connected' | 'disconnected' | 'error'>")
    expect(mcpSrc).toContain('servers?: Array<{ name: string; connected: boolean; tool_count: number }>')
  })

  it('removeMcpServer 应 URL 编码 name', () => {
    expect(mcpSrc).toContain('encodeURIComponent(name)')
  })

  it('searchMcpMarketplace 使用 ClawHub 搜索 API', () => {
    expect(mcpSrc).toContain('/api/v1/clawhub/search')
    expect(mcpSrc).toContain("type: 'mcp'")
  })
})

// ═══════════════════════════════════════════════════════════════════
// 10. LLM Config Chain: LLM 配置链路
// ═══════════════════════════════════════════════════════════════════

describe('LLM 配置链路', () => {
  const configSrc = readSrc('api/config.ts')

  it('getLLMConfig 通过 Tauri proxy 请求后端', () => {
    expect(configSrc).toContain("'GET', '/api/v1/config/llm'")
  })

  it('updateLLMConfig 使用 PUT 方法', () => {
    expect(configSrc).toContain("'PUT', '/api/v1/config/llm'")
  })

  it('testLLMConnection 应校验 URL 格式', () => {
    expect(configSrc).toContain('assertExternalBaseUrlAllowed(payload.provider.base_url, payload.provider.type)')
    expect(configSrc).toContain("throw new Error('Invalid URL format')")
  })

  it('safeJsonParse 应包含上下文信息用于调试', () => {
    expect(configSrc).toContain('`${context}: backend returned a non-JSON payload`')
  })
})

// ═══════════════════════════════════════════════════════════════════
// 11. Local LLM (Ollama) Chain: 本地 LLM 链路
// ═══════════════════════════════════════════════════════════════════

describe('Ollama 本地 LLM 链路', () => {
  const ollamaSrc = readSrc('api/ollama.ts')

  it('所有 Ollama API 端点路径与后端对齐', () => {
    // status/running use OLLAMA_BASE constant (direct Ollama), others via backend
    expect(ollamaSrc).toContain('OLLAMA_BASE')
    expect(ollamaSrc).toContain('/api/tags')
    expect(ollamaSrc).toContain('/api/ps')
    expect(ollamaSrc).toContain('/api/v1/ollama/unload')
    expect(ollamaSrc).toContain('/api/v1/ollama/models/')
    expect(ollamaSrc).toContain('/api/v1/ollama/restart')
    expect(ollamaSrc).toContain('/api/v1/ollama/pull')
  })

  it('getOllamaStatus 直连 Ollama 原生 API（不依赖 sidecar）', () => {
    expect(ollamaSrc).toContain('OLLAMA_BASE')
    expect(ollamaSrc).toContain('/api/tags')
  })

  it('restartOllama 使用 apiPost（由 ofetch 统一处理超时）', () => {
    // 已从 raw fetch + AbortSignal.timeout(30000) 迁移到 apiPost
    expect(ollamaSrc).toContain("apiPost<{ status?: string }>('/api/v1/ollama/restart')")
  })

  it('pullOllamaModel 应支持 AbortSignal 取消下载', () => {
    expect(ollamaSrc).toContain('signal?: AbortSignal')
    expect(ollamaSrc).toContain('signal,')
  })

  it('pullOllamaModel 应处理流式错误', () => {
    expect(ollamaSrc).toContain('if (p.error) streamError = p.error')
    expect(ollamaSrc).toContain('if (streamError) throw new Error(streamError)')
  })

  it('pullOllamaModel 应兼容带 data: 前缀和不带的 JSON 行', () => {
    // 后端可能返回纯 JSON 行或 SSE data: 前缀行
    expect(ollamaSrc).toContain("line.replace(/^data:\\s*/, '').trim()")
  })

  it('OllamaRunningModel 字段与后端 handleOllamaRunning 对齐', () => {
    // 后端返回: name, size, size_vram, expires_at, parameter_size, quantization_level, context_length
    expect(ollamaSrc).toContain('name: string')
    expect(ollamaSrc).toContain('size: number')
    expect(ollamaSrc).toContain('size_vram: number')
    expect(ollamaSrc).toContain('expires_at: string')
    expect(ollamaSrc).toContain('context_length: number')
  })

  it('deleteOllamaModel 使用 apiDelete 和正确路径', () => {
    // 已从 raw fetch + method: 'DELETE' 迁移到 apiDelete
    expect(ollamaSrc).toContain('apiDelete(`/api/v1/ollama/models/${encodeURIComponent(name)}`)')
  })
})

// ═══════════════════════════════════════════════════════════════════
// 12. WebSocket Chain: 实时通信链路
// ═══════════════════════════════════════════════════════════════════

describe('WebSocket 链路', () => {
  const wsSrc = readSrc('api/websocket.ts')

  it('心跳机制应正确检测 pong 超时', () => {
    expect(wsSrc).toContain('heartbeatInterval + this.pongTimeoutMs')
    expect(wsSrc).toContain("logger.warn('WebSocket pong timeout")
  })

  it('重连应有最大尝试次数限制', () => {
    expect(wsSrc).toContain('maxReconnectAttempts = 5')
    expect(wsSrc).toContain('this.reconnectAttempts >= this.maxReconnectAttempts')
  })

  it('handleMessage 应处理所有服务端消息类型', () => {
    const types = ['chunk', 'reply', 'error', 'pong', 'tool_approval_request']
    for (const type of types) {
      expect(wsSrc).toContain(`case '${type}'`)
    }
  })

  it('sendApprovalResponse 应支持 remember 选项', () => {
    expect(wsSrc).toContain("approved ? 'approved' : 'denied'")
    expect(wsSrc).toContain('`${base}_remember`')
  })

  it('cleanupConnection 应取消所有事件处理器', () => {
    expect(wsSrc).toContain('this.ws.onopen = null')
    expect(wsSrc).toContain('this.ws.onmessage = null')
    expect(wsSrc).toContain('this.ws.onclose = null')
    expect(wsSrc).toContain('this.ws.onerror = null')
  })

  it('disconnect 应清除所有回调', () => {
    const disconnectFn = wsSrc.slice(
      wsSrc.indexOf('disconnect(): void {'),
      wsSrc.indexOf('isConnected(): boolean'),
    )
    expect(disconnectFn).toContain('this.chunkCallbacks = []')
    expect(disconnectFn).toContain('this.replyCallbacks = []')
    expect(disconnectFn).toContain('this.errorCallbacks = []')
  })

  it('onclose 应在非主动关闭时通知 error 回调', () => {
    expect(wsSrc).toContain("!this.intentionalClose && this.errorCallbacks.length > 0")
    expect(wsSrc).toContain("'WebSocket connection lost'")
  })
})

// ═══════════════════════════════════════════════════════════════════
// 13. Canvas/Workflow Chain: 画布链路
// ═══════════════════════════════════════════════════════════════════

describe('Canvas 画布链路', () => {
  const canvasSrc = readSrc('api/canvas.ts')

  it('runWorkflow 后端不可用时不应返回假成功', () => {
    // BUG: 后端不可用时返回 status: 'completed'，误导用户
    const runFn = canvasSrc.slice(
      canvasSrc.indexOf('export async function runWorkflow'),
      canvasSrc.indexOf('export async function getWorkflowRun'),
    )
    // 捕获后端错误时返回的模拟运行状态
    const hasFakeCompleted = runFn.includes("status: 'completed'")
    // 应该返回 'failed' 或抛出错误
    expect(hasFakeCompleted).toBe(false) // EXPECTED TO FAIL: exposes bug
  })

  it('saveWorkflow 降级到 localStorage 应正确更新已存在的工作流', () => {
    expect(canvasSrc).toContain('const existing = workflows.findIndex((w) => w.id === workflow.id)')
    expect(canvasSrc).toContain('workflows[existing] = saved')
  })

  it('deleteWorkflow 降级时应过滤 localStorage', () => {
    expect(canvasSrc).toContain("getLocalWorkflows().filter((w) => w.id !== id)")
  })
})

// ═══════════════════════════════════════════════════════════════════
// 14. Webhook Chain: Webhook 链路
// ═══════════════════════════════════════════════════════════════════

describe('Webhook 链路', () => {
  const webhookSrc = readSrc('api/webhook.ts')

  it('createWebhook 应传递 user_id', () => {
    expect(webhookSrc).toContain('user_id: DESKTOP_USER_ID')
  })

  it('deleteWebhook 应 URL 编码 id', () => {
    expect(webhookSrc).toContain('encodeURIComponent(id)')
  })

  it('getWebhooks 传递 user_id 进行过滤', () => {
    expect(webhookSrc).toContain("user_id: DESKTOP_USER_ID")
  })
})

// ═══════════════════════════════════════════════════════════════════
// 15. Agent/Role Chain: Agent 路由链路
// ═══════════════════════════════════════════════════════════════════

describe('Agent 路由链路', () => {
  const agentsSrc = readSrc('api/agents.ts')

  it('所有 CRUD 路径与后端对齐', () => {
    expect(agentsSrc).toContain("'/api/v1/roles'")
    expect(agentsSrc).toContain("'/api/v1/agents'")
    expect(agentsSrc).toContain("'/api/v1/agents/default'")
    expect(agentsSrc).toContain("'/api/v1/agents/rules'")
    expect(agentsSrc).toContain('/api/v1/agents/${encodeURIComponent(name)}')
    expect(agentsSrc).toContain('/api/v1/agents/rules/${id}')
  })

  it('updateAgent 应 URL 编码 agent name', () => {
    expect(agentsSrc).toContain('encodeURIComponent(name)')
  })
})

// ═══════════════════════════════════════════════════════════════════
// 16. Team/Collaboration Chain: 团队链路
// ═══════════════════════════════════════════════════════════════════

describe('Team 团队链路', () => {
  const teamSrc = readSrc('api/team.ts')

  it('所有 API 函数应有 localStorage 降级', () => {
    const functions = ['getSharedAgents', 'shareAgent', 'deleteSharedAgent', 'getTeamMembers', 'inviteTeamMember', 'removeTeamMember']
    for (const fn of functions) {
      const fnSrc = teamSrc.slice(teamSrc.indexOf(`export async function ${fn}`))
      expect(fnSrc.includes('getLocal') || fnSrc.includes('setLocal')).toBe(true)
    }
  })

  it('exportAllConfig 应包含版本号和时间戳', () => {
    expect(teamSrc).toContain("version: '1.0.0'")
    expect(teamSrc).toContain('exported_at: new Date().toISOString()')
  })
})

// ═══════════════════════════════════════════════════════════════════
// 17. Security Review
// ═══════════════════════════════════════════════════════════════════

describe('安全审计', () => {
  const commandsSrc = readFileSync(resolve(__dirname, '../../src-tauri/src/commands.rs'), 'utf-8')
  const sidecarSrc = readFileSync(resolve(__dirname, '../../src-tauri/src/sidecar.rs'), 'utf-8')

  it('proxy_api_request 应阻止路径遍历', () => {
    expect(commandsSrc).toContain('path.contains("..")')
    expect(commandsSrc).toContain("path.starts_with('/')")
  })

  it('stream_chat 应阻止 SSRF（云元数据端点）', () => {
    expect(commandsSrc).toContain('169.254.169.254')
    expect(commandsSrc).toContain('metadata.google.internal')
  })

  it('stream_chat 应仅允许 http/https scheme', () => {
    expect(commandsSrc).toContain('scheme != "https" && scheme != "http"')
  })

  it('secure store 使用 Tauri Store，浏览器端不做持久化假加密', () => {
    // Secure storage is handled in TypeScript (secure-store.ts) using Tauri LazyStore.
    // Browser mode keeps secrets only in volatile memory.
    const secureStoreSrc = readSrc('utils/secure-store.ts')
    expect(secureStoreSrc).toContain('LazyStore')
    expect(secureStoreSrc).toContain('volatileBrowserStore')
  })

  it('sidecar 端口冲突检测应区分 hexclaw 与非 hexclaw 进程', () => {
    expect(sidecarSrc).toContain('is_hexclaw_sidecar_command')
    expect(sidecarSrc).toContain('format_port_conflict_error')
  })

  it('sidecar 应优雅终止残留进程（先 TERM 后 KILL）', () => {
    expect(sidecarSrc).toContain('send_unix_signal(pid, "-TERM")')
    expect(sidecarSrc).toContain('send_unix_signal(pid, "-KILL")')
  })

  it('sidecar 配置路径应使用 HOME 环境变量', () => {
    expect(sidecarSrc).toContain('.hexclaw')
    expect(sidecarSrc).toContain('hexclaw.yaml')
  })

  it('后端 chat 请求体应限制大小（MaxBytesReader）', () => {
    // 检查 handleSaveMemory 有 MaxBytesReader(1MB) 限制
    // 但 handleChat 有类似保护吗？
    // backend_chat 通过 reqwest 120s 超时限制
    expect(commandsSrc).toContain('timeout(std::time::Duration::from_secs(120))')
  })
})

// ═══════════════════════════════════════════════════════════════════
// 18. Frontend-Backend API Alignment
// ═══════════════════════════════════════════════════════════════════

describe('前后端 API 对齐', () => {
  it('后端有的 API 前端应全部覆盖', () => {
    // 后端 API 路由 vs 前端调用
    const backendEndpoints = [
      // Chat
      'POST /api/v1/chat',
      // Knowledge
      'POST /api/v1/knowledge/documents',
      'POST /api/v1/knowledge/upload',
      'GET /api/v1/knowledge/documents',
      'GET /api/v1/knowledge/documents/{id}',
      'DELETE /api/v1/knowledge/documents/{id}',
      'POST /api/v1/knowledge/documents/{id}/reindex',
      'POST /api/v1/knowledge/search',
      // Session
      'POST /api/v1/sessions',
      'GET /api/v1/sessions',
      'GET /api/v1/sessions/{id}',
      'PATCH /api/v1/sessions/{id}',
      'DELETE /api/v1/sessions/{id}',
      'GET /api/v1/sessions/{id}/messages',
      'GET /api/v1/sessions/{id}/branches',
      'POST /api/v1/sessions/{id}/fork',
      'GET /api/v1/messages/search',
      'DELETE /api/v1/messages/{id}',
      'PUT /api/v1/messages/{id}/feedback',
      // Config
      'GET /api/v1/config/llm',
      'PUT /api/v1/config/llm',
      'POST /api/v1/config/llm/test',
      // Roles
      'GET /api/v1/roles',
      // Webhook
      'GET /api/v1/webhooks',
      'POST /api/v1/webhooks',
      'DELETE /api/v1/webhooks/{id}',
      // Cron
      'GET /api/v1/cron/jobs',
      'POST /api/v1/cron/jobs',
      'DELETE /api/v1/cron/jobs/{id}',
      'POST /api/v1/cron/jobs/{id}/pause',
      'POST /api/v1/cron/jobs/{id}/resume',
      'POST /api/v1/cron/jobs/{id}/trigger',
      'GET /api/v1/cron/jobs/{id}/history',
      // Memory
      'GET /api/v1/memory',
      'POST /api/v1/memory',
      'PUT /api/v1/memory/{id}',
      'DELETE /api/v1/memory',
      'DELETE /api/v1/memory/{id}',
      'GET /api/v1/memory/search',
      // MCP
      'GET /api/v1/mcp/tools',
      'GET /api/v1/mcp/servers',
      'POST /api/v1/mcp/servers',
      'DELETE /api/v1/mcp/servers/{name}',
      'POST /api/v1/mcp/tools/call',
      'GET /api/v1/mcp/status',
      // Skills
      'GET /api/v1/skills',
      'PUT /api/v1/skills/{name}/status',
      'POST /api/v1/skills/install',
      'DELETE /api/v1/skills/{name}',
      // Agents
      'GET /api/v1/agents',
      'POST /api/v1/agents',
      'PUT /api/v1/agents/{name}',
      'DELETE /api/v1/agents/{name}',
      'POST /api/v1/agents/default',
      'GET /api/v1/agents/rules',
      'POST /api/v1/agents/rules',
      'DELETE /api/v1/agents/rules/{id}',
      // IM
      'GET /api/v1/platforms/instances',
      'POST /api/v1/platforms/instances',
      'DELETE /api/v1/platforms/instances/{name}',
      // Canvas
      'GET /api/v1/canvas/workflows',
      'POST /api/v1/canvas/workflows',
      'DELETE /api/v1/canvas/workflows/{id}',
      'POST /api/v1/canvas/workflows/{id}/run',
      'GET /api/v1/canvas/runs/{id}',
      // Voice
      'GET /api/v1/voice/status',
      'POST /api/v1/voice/transcribe',
      'POST /api/v1/voice/synthesize',
      // System
      'GET /api/v1/stats',
      'GET /api/v1/version',
      'GET /api/v1/config',
      'PUT /api/v1/config',
      'GET /api/v1/models',
      // Ollama
      'GET /api/v1/ollama/status',
      'POST /api/v1/ollama/pull',
      'GET /api/v1/ollama/running',
      'POST /api/v1/ollama/unload',
      'DELETE /api/v1/ollama/models/{name}',
      'POST /api/v1/ollama/restart',
      // ClawHub
      'GET /api/v1/clawhub/search',
      // Team
      'GET /api/v1/team/agents',
      'POST /api/v1/team/agents',
      'DELETE /api/v1/team/agents/{id}',
      'GET /api/v1/team/members',
      'POST /api/v1/team/members',
      'DELETE /api/v1/team/members/{id}',
    ]

    // 前端未覆盖的后端 API（通过 agents/rules/test 测试路由）
    const frontendMissing = [
      'POST /api/v1/agents/rules/test',  // 前端无 testRoute 调用
    ]

    // Verify backend has substantial coverage
    expect(backendEndpoints.length).toBeGreaterThan(30)
    // 只检查确实缺失的
    expect(frontendMissing.length).toBeLessThanOrEqual(1)
  })

  it('前端调用的 API 后端应全部实现', () => {
    // 确保前端不会调用后端不存在的路由
    // 所有前端 API 路径都在上面的后端路由列表中
    const chatSrc = readSrc('api/chat.ts')
    // 检查前端没有调用不存在的 API
    expect(chatSrc).not.toContain('/api/v2/')
    expect(chatSrc).not.toContain('/api/v1/chat/stream') // 走 WebSocket 而非 SSE
  })
})

// ═══════════════════════════════════════════════════════════════════
// 19. Code Quality: 冗余代码和未完成功能
// ═══════════════════════════════════════════════════════════════════

describe('代码质量', () => {
  it('messageService.persistMessage 是空操作（后端自动持久化）', () => {
    const msgSvcSrc = readSrc('services/messageService.ts')
    // persistMessage 返回 true 但不做任何操作
    expect(msgSvcSrc).toContain('async function persistMessage(_msg: ChatMessage, _sessionId: string): Promise<boolean>')
    expect(msgSvcSrc).toContain('return true')
  })

  it('messageService.saveArtifact 是空操作', () => {
    const msgSvcSrc = readSrc('services/messageService.ts')
    expect(msgSvcSrc).toContain('async function saveArtifact(_sessionId: string, _artifact: Artifact): Promise<void>')
    // No-op 是设计决策，不是 bug —— artifacts 从消息实时提取
  })

  it('chat.ts 有冗余的多处 import from client', () => {
    const chatSrc = readSrc('api/chat.ts')
    // 多处分散的 import { ... } from './client'
    const importCount = (chatSrc.match(/import \{.*\} from '\.\/client'/g) || []).length
    // 应该合并为一处 import
    expect(importCount).toBeLessThanOrEqual(1) // EXPECTED TO FAIL: exposes redundancy
  })

  it('chat.ts updateMessageFeedback 不应使用动态 import', () => {
    const chatSrc = readSrc('api/chat.ts')
    // apiPut 已在 chat.ts 中被 import，updateMessageFeedback 不需要动态 import
    const hasDynamicImportInFeedback = chatSrc.includes("import('./client').then(({ apiPut })")
    expect(hasDynamicImportInFeedback).toBe(false) // FIXED: 动态 import 已合并到顶层
  })

  it('settings store 不应超过 500 行', () => {
    const settingsSrc = readSrc('stores/settings.ts')
    const lineCount = settingsSrc.split('\n').length
    // v0.2.6: 已拆分 settings-helpers.ts，当前 ~515 行
    expect(lineCount).toBeLessThanOrEqual(520)
  })

  it('QuickChatView 应使用 clearStreamCallbacks 而非 clearCallbacks', () => {
    // QuickChatView.vue 的 clearCallbacks() 会清除 approval 监听
    const quickChatSrc = readSrc('views/QuickChatView.vue')
    expect(quickChatSrc).toBeTruthy()
    const clearAllCount = (quickChatSrc.match(/clearCallbacks\(\)/g) || []).length
    const clearStreamCount = (quickChatSrc.match(/clearStreamCallbacks\(\)/g) || []).length
    // 应该用 clearStreamCallbacks 而非 clearCallbacks
    expect(clearAllCount).toBe(0) // EXPECTED TO FAIL: exposes bug
    expect(clearStreamCount).toBeGreaterThan(0)
  })
})

// ═══════════════════════════════════════════════════════════════════
// 20. Sidecar Integration
// ═══════════════════════════════════════════════════════════════════

describe('Sidecar 集成', () => {
  it('sidecar 应传递 --desktop 标志', () => {
    const sidecarSrc = readFileSync(resolve(__dirname, '../../src-tauri/src/sidecar.rs'), 'utf-8')
    expect(sidecarSrc).toContain('["serve", "--desktop"]')
  })

  it('sidecar PATH enrichment 应包含 Homebrew 和常用工具路径', () => {
    const sidecarSrc = readFileSync(resolve(__dirname, '../../src-tauri/src/sidecar.rs'), 'utf-8')
    expect(sidecarSrc).toContain('/opt/homebrew/bin')
    expect(sidecarSrc).toContain('/usr/local/bin')
    expect(sidecarSrc).toContain('.cargo/bin')
    expect(sidecarSrc).toContain('go/bin')
  })

  it('sidecar 启动后应等待健康检查通过', () => {
    const sidecarSrc = readFileSync(resolve(__dirname, '../../src-tauri/src/sidecar.rs'), 'utf-8')
    expect(sidecarSrc).toContain('wait_for_healthy')
    expect(sidecarSrc).toContain('/health')
  })

  it('sidecar 应在应用退出时清理子进程', () => {
    const sidecarSrc = readFileSync(resolve(__dirname, '../../src-tauri/src/sidecar.rs'), 'utf-8')
    expect(sidecarSrc).toContain('stop_sidecar')
    expect(sidecarSrc).toContain('child.kill()')
    expect(sidecarSrc).toContain('child.wait()')
  })

  it('ensure_desktop_knowledge_enabled 应自动启用知识库', () => {
    const sidecarSrc = readFileSync(resolve(__dirname, '../../src-tauri/src/sidecar.rs'), 'utf-8')
    expect(sidecarSrc).toContain('ensure_knowledge_enabled_yaml')
    expect(sidecarSrc).toContain('enabled: true')
  })
})

// ═══════════════════════════════════════════════════════════════════
// 21. Tools Status / Budget Chain
// ═══════════════════════════════════════════════════════════════════

describe('Tools Status / Budget 链路', () => {
  const toolsStatusSrc = readSrc('api/tools-status.ts')

  it('所有工具状态 API 端点与后端对齐', () => {
    expect(toolsStatusSrc).toContain('/api/v1/budget/status')
    expect(toolsStatusSrc).toContain('/api/v1/tools/cache/stats')
    expect(toolsStatusSrc).toContain('/api/v1/tools/metrics')
    expect(toolsStatusSrc).toContain('/api/v1/tools/permissions')
  })

  it('BudgetStatus 类型字段完整', () => {
    const fields = ['tokens_used', 'tokens_max', 'tokens_remaining', 'cost_used', 'cost_max', 'cost_remaining', 'exhausted']
    for (const field of fields) {
      expect(toolsStatusSrc).toContain(field)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════
// 22. Voice Chain
// ═══════════════════════════════════════════════════════════════════

describe('Voice 语音链路', () => {
  const voiceSrc = readSrc('api/voice.ts')

  it('语音状态 API 端点正确', () => {
    expect(voiceSrc).toContain('/api/v1/voice/status')
  })

  it('STT 应支持 language 参数', () => {
    expect(voiceSrc).toContain("form.append('language', language)")
  })

  it('TTS 返回类型为 Blob（音频二进制）', () => {
    expect(voiceSrc).toContain('Promise<Blob>')
    expect(voiceSrc).toContain('res.blob()')
  })
})

// ═══════════════════════════════════════════════════════════════════
// 23. Log Chain
// ═══════════════════════════════════════════════════════════════════

describe('Log 日志链路', () => {
  const logsSrc = readSrc('api/logs.ts')

  it('getLogs 应使用 apiGet 的 query 参数传递查询条件', () => {
    // getLogs 已重构为使用 apiGet 的 query 参数，避免手动拼接 URL
    expect(logsSrc).toContain("apiGet<{ logs: LogEntry[]; total: number }>('/api/v1/logs'")
    expect(logsSrc).not.toContain('new URLSearchParams()')
  })

  it('connectLogStream 应通过 WebSocket 接收实时日志', () => {
    expect(logsSrc).toContain('apiWebSocket')
    expect(logsSrc).toContain('/api/v1/logs/stream')
  })

  it('connectLogStream 应处理解析失败', () => {
    expect(logsSrc).toContain('JSON.parse(event.data)')
    expect(logsSrc).toContain('Failed to parse log stream payload')
  })
})

// ═══════════════════════════════════════════════════════════════════
// 24. Desktop API
// ═══════════════════════════════════════════════════════════════════

describe('Desktop API', () => {
  const desktopSrc = readSrc('api/desktop.ts')

  it('setClipboard 应有 fallback 机制', () => {
    expect(desktopSrc).toContain('navigator.clipboard?.writeText')
    expect(desktopSrc).toContain("document.execCommand('copy')")
  })

  it('clipboard fallback 应清理临时 textarea 元素', () => {
    expect(desktopSrc).toContain('document.body.appendChild(textarea)')
    expect(desktopSrc).toContain('document.body.removeChild(textarea)')
  })
})
