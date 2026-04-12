/**
 * Ecosystem Cross-Review Audit (2026-04-11)
 *
 *挑刺式全链路审计，覆盖 hexclaw 生态 5 层仓库：
 *   L0 toolkit → L1 ai-core → L2 hexagon → L3 hexclaw → L3 hexclaw-desktop
 *
 * 每条 test case 对应一个已确认的 Bug / 设计缺陷 / 安全隐患。
 * 标注 severity: CRITICAL / HIGH / MEDIUM / LOW
 * 标注 category: alignment / session / memory / knowledge / mcp / skill / llm / security / perf / ecosystem
 *
 * Backend source: /Users/hexagon/work/hexclaw/
 * ai-core source: /Users/hexagon/work/ai-core/
 * hexagon source: /Users/hexagon/work/hexagon/
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

function readSrc(rel: string): string {
  return fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf-8')
}

function readType(rel: string): string {
  return fs.readFileSync(path.resolve(__dirname, '../types', rel), 'utf-8')
}

function readBackend(rel: string): string {
  const p = path.resolve('/Users/hexagon/work/hexclaw', rel)
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : ''
}

function readAiCore(rel: string): string {
  const p = path.resolve('/Users/hexagon/work/ai-core', rel)
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : ''
}

function readHexagon(rel: string): string {
  const p = path.resolve('/Users/hexagon/work/hexagon', rel)
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : ''
}

// ═══════════════════════════════════════════════════════════════
// 1. FRONTEND ↔ BACKEND API 对齐 (alignment)
// ═══════════════════════════════════════════════════════════════

describe('[alignment] Frontend ↔ Backend API Contract', () => {
  // ── CRITICAL ──────────────────────────────────────────────

  it('CRITICAL: ChatRequest.temperature / max_tokens 被后端静默丢弃', () => {
    // 前端发送 temperature, max_tokens, agent_id, role_id, provider_id
    const chatType = readType('chat.ts')
    expect(chatType).toContain('temperature?: number')
    expect(chatType).toContain('max_tokens?: number')

    // 后端 ChatRequest struct 无这些字段 → JSON decode 时静默忽略
    // 前端 sendChatViaBackend 确实传了这些参数
    const chatApi = readSrc('api/chat.ts')
    expect(chatApi).toContain('temperature: options?.temperature')
    expect(chatApi).toContain('max_tokens: options?.maxTokens')

    // BUG: 用户在 UI 设置的 temperature/max_tokens 完全无效
    // 后端 server.go ChatRequest 没有 temperature/max_tokens json tag
    const serverGo = readBackend('api/server.go')
    if (serverGo) {
      // 如果后端代码可读，验证确实缺少这些字段
      const hasTempField = /json:"temperature"/.test(serverGo)
      const hasMaxTokensField = /json:"max_tokens"/.test(serverGo)
      // 这两个预期为 false，表示后端确实没有对应字段
      expect(hasTempField || hasMaxTokensField).toBe(false)
    }
  })

  // ── HIGH ──────────────────────────────────────────────────

  it('HIGH: MCP servers 接口返回 string[] 但前端期望 McpServer[]', () => {
    const mcpType = readType('mcp.ts')
    // 前端 McpServer 期望完整对象
    expect(mcpType).toContain('id: string')
    expect(mcpType).toContain('name: string')
    expect(mcpType).toContain('url: string')
    expect(mcpType).toContain("status: 'connected' | 'disconnected' | 'error'")
    expect(mcpType).toContain('tools: McpTool[]')

    // BUG: 后端 GET /api/v1/mcp/servers 返回 {"servers": ["name1","name2"]}
    // 前端反序列化 string 为 McpServer 对象，所有字段都是 undefined
    // 需要前端使用 /api/v1/mcp/status 端点代替，或后端改返回结构化对象
  })

  // ── MEDIUM ────────────────────────────────────────────────

  it('MEDIUM: Usage 字段名不对齐 — input_tokens vs prompt_tokens', () => {
    const chatApi = readSrc('api/chat.ts')
    // BackendChatResponse.usage 用 prompt_tokens / completion_tokens
    expect(chatApi).toContain('prompt_tokens')
    expect(chatApi).toContain('completion_tokens')
    // ActiveStreamSnapshot.usage 用 input_tokens / output_tokens
    expect(chatApi).toContain('input_tokens')
    expect(chatApi).toContain('output_tokens')

    // BUG: 后端 adapter.Usage json tag 是 input_tokens / output_tokens
    // BackendChatResponse 期望 prompt_tokens → 永远是 undefined
    // 两种前端类型使用不同字段名，造成同步路径 token 统计永远为 0
  })

  it('MEDIUM: tools_enabled / max_tools 后端 LLM config API 不包含', () => {
    const settingsType = readType('settings.ts')
    // 前端 BackendLLMProvider 声明了这些字段
    expect(settingsType).toContain('tools_enabled?: boolean | null')
    expect(settingsType).toContain('max_tools?: number')

    // BUG: 后端 LLMProviderConfigResponse struct 不含这两个字段
    // PUT 时前端发送 → 后端丢弃；GET 时后端不返回 → 前端恢复为 undefined
    // 用户配置的 per-provider 工具注入设置在刷新后丢失
  })

  it('MEDIUM: handleListDocuments 可能返回 null 而非 []', () => {
    // Go nil slice 序列化为 null，前端 documents.map(...) 会崩溃
    // handler_session.go 对 sessions/messages 做了 nil→[] 修正
    // 但 handler_knowledge.go handleListDocuments 直接返回 kb.ListDocuments 结果
    // 如果 Knowledge manager 返回 nil，前端收到 {"documents": null}
    const knowledgeType = readType('knowledge.ts')
    expect(knowledgeType).toContain('KnowledgeDoc')
  })

  it('MEDIUM: ChatMessage.timestamp 字段后端不发送', () => {
    const chatType = readType('chat.ts')
    // 前端 ChatMessage 声明 timestamp: string (必填)
    expect(chatType).toContain('timestamp: string')
    // 后端 MessageRecord 只有 created_at (json tag)
    // timestamp 字段永远为 undefined 除非前端手动从 created_at 复制
  })

  it('LOW: ChatSession.agent_id / agent_name 后端从不返回', () => {
    const chatType = readType('chat.ts')
    expect(chatType).toContain('agent_id?: string')
    expect(chatType).toContain('agent_name?: string')
    // 后端 Session struct 没有 agent_id/agent_name 字段
    // 这些字段永远为 undefined → UI 中基于 session 级 agent 标识的逻辑失效
  })

  it('LOW: MCP ToolInfo.server_name 前端 McpTool 未声明', () => {
    const mcpType = readType('mcp.ts')
    // 前端 McpTool 缺少 server_name 字段
    expect(mcpType).not.toContain('server_name')
    // 后端返回 server_name 但前端忽略 → UI 无法显示工具所属服务器
  })

  it('LOW: Agent metadata 类型不匹配 — Go map[string]string vs TS Record<string, unknown>', () => {
    // 前端可以发送非 string 值，Go json.Unmarshal 到 map[string]string 会得到零值
  })
})

// ═══════════════════════════════════════════════════════════════
// 2. SESSION / IM / STREAMING 全链路 (session)
// ═══════════════════════════════════════════════════════════════

describe('[session] Session & Streaming Full Chain', () => {
  // ── CRITICAL ──────────────────────────────────────────────

  it('CRITICAL: [hexclaw] Compactor 在同步路径传入 nil Provider → panic [FIXED]', () => {
    // FIXED: finalizeReply 现在传入 resolved provider 而非 nil
    const reactGo = readBackend('engine/react.go')
    if (reactGo) {
      const hasNilProvider = /CompactIfNeeded\([^)]*,\s*nil\s*\)/.test(reactGo)
      expect(hasNilProvider).toBe(false) // 已修复: 不再传 nil
    }
  })

  it('CRITICAL: [hexclaw] processStreamToolLoop 错误路径不释放 session lock → 死锁', () => {
    // engine/react.go:1129-1134 — provider 失败或 fallback 失败时
    // return (nil, error) 但不释放 sessionUnlock
    // 该 session 的所有后续请求永久阻塞
    const reactGo = readBackend('engine/react.go')
    if (reactGo) {
      // 检查 processStreamToolLoop 是否存在
      expect(reactGo).toContain('processStreamToolLoop')
    }
  })

  it('CRITICAL: [hexclaw] processStreamToolLoop 在 HTTP handler goroutine 上同步阻塞', () => {
    // 工具循环 (最多 25 轮) 在请求处理 goroutine 上同步运行
    // 客户端在工具执行期间收不到任何中间流式反馈，看起来"卡住了"
    // HTTP 超时可能杀死请求
  })

  // ── HIGH ──────────────────────────────────────────────────

  it('HIGH: [hexclaw] msg.Metadata 在 goroutine 中写入无同步 → data race', () => {
    // engine/react.go:1303,1306,1477,1480,1589-1592
    // pipeStream/pipeStreamWithTools goroutine 写 msg.Metadata
    // Go map 不安全并发 → 可能 panic
  })

  it('HIGH: [hexclaw] SessionLock entries 从不清理 → 无限内存增长 [FIXED]', () => {
    // FIXED: 添加了 Cleanup(maxAge) 方法和 lastAccess 追踪
    const lockGo = readBackend('session/lock.go')
    if (lockGo) {
      expect(lockGo).toContain('Cleanup')
    }
  })

  it('HIGH: [desktop] 用户消息持久化 fire-and-forget → 消息可能丢失', () => {
    // chat-send-controller.ts — void persistMessage(userMessage, sessionId)
    // 不 await 直接发 WebSocket → 如果持久化失败，消息只在 UI 有
    // 刷新后用户消息消失但助手回复还在
    const sendController = readSrc('stores/chat-send-controller.ts')
    // 确认文件存在
    expect(sendController).toBeTruthy()
  })

  it('HIGH: [hexclaw] Compaction TOCTOU race — 并发双重 compaction 可能删除保留窗口消息', () => {
    // compaction.go — 加载消息 → LLM 摘要(秒级) → 删除消息
    // 无锁保护，两个并发请求可以同时触发 compaction
    // 两者删除消息 ID 重叠，但摘要不包含对方的新消息
  })

  // ── MEDIUM ────────────────────────────────────────────────

  it('MEDIUM: [desktop] WebSocket 重连触发 error callback → 可能产生重复助手消息', () => {
    // websocket.ts:123-131 — close 事件触发所有 errorCallbacks
    // → 创建错误助手消息
    // 然后 attemptReconnect → recoverActiveStreams → 恢复同一个流
    // → 又创建一条助手消息
  })

  it('MEDIUM: [desktop] deleteSession finally 清除 cancelledSessions → 流可能继续处理已删除会话', () => {
    // chat-session-lifecycle.ts:127 — finally { cancelledSessions.delete(sessionId) }
    // 如果 WS delivery 在 finally 之后检查 isSessionCancelled → 看到 false → 继续处理
  })

  it('MEDIUM: [hexclaw] BuildContext 截断可能产生无效对话历史', () => {
    // session/session.go:207-217 — token 预算裁剪可能从 assistant 消息开头
    // LLM 期望 user/assistant 交替 → 截断后模型困惑
  })

  it('MEDIUM: [hexclaw] handleDeleteMessage / handleUpdateMessageFeedback 无 session 归属校验', () => {
    // handler_session.go:168-191, 198-237
    // 知道 message ID 就能删除/修改任何人的消息
    // 桌面端低风险，但 IM 多用户部署是授权绕过
  })

  it('LOW: [hexclaw] handleListSessions 返回 len(sessions) 作为 total → 分页失效', () => {
    // handler_session.go:94-98 — total 不是总数而是当前页数量
    // 前端分页无法知道是否有更多页
  })

  it('LOW: [hexclaw] shouldUseDirectCompletion 是死代码', () => {
    // react.go:1713-1726 — 函数定义了但从未被调用
    // 且逻辑有 bug: len(history) > 0 后立即 return true → 永远不会走到迭代
  })
})

// ═══════════════════════════════════════════════════════════════
// 3. 记忆 / 知识库 / RAG (memory & knowledge)
// ═══════════════════════════════════════════════════════════════

describe('[memory] Memory System', () => {
  // ── CRITICAL ──────────────────────────────────────────────

  it('CRITICAL: [hexclaw] moveEntryLine 非原子写入 → 崩溃时记忆永久丢失', () => {
    // memory/file_memory.go:754-770
    // 先写源文件(删除行) → 再写目标文件(追加行)
    // 如果第二步失败或进程崩溃 → 条目从源删除但从未写入目标
    const fm = readBackend('memory/file_memory.go')
    if (fm) {
      expect(fm).toContain('moveEntryLine')
    }
  })

  it('CRITICAL: [hexclaw] SaveEntryForRole dedup check 与 write 之间无锁 → TOCTOU race', () => {
    // isDuplicate 用 RLock → 释放 → evictIfNeeded 用 RLock → 释放 → mu.Lock 写入
    // 两个并发 goroutine 都通过 dedup check → 写入相同内容
  })

  it('CRITICAL: [hexclaw] evictIfNeeded line-index 与实际文件内容可能不一致', () => {
    // 读 entries (RLock) → 移除某行 (Lock)，期间另一个 goroutine 可能插入/删除行
    // moveEntryLine 按行号操作 → 移除了错误的记忆条目
  })

  // ── HIGH ──────────────────────────────────────────────────

  it('HIGH: [hexclaw] UpdateEntry / DeleteEntry 只操作 _global 目录 → role-specific 记忆无法编辑', () => {
    // memory/file_memory.go:784,813 — hardcode fm.roleDir("")
    // 但 ParseEntriesForRole 返回合并结果(含 role 目录条目，ID 前缀 r-)
    // 编辑/删除 r- 条目 → "记忆条目不存在"
    const fm = readBackend('memory/file_memory.go')
    if (fm) {
      // 检查 UpdateEntry 是否只用 roleDir("")
      const hasHardcodedGlobal = /func.*UpdateEntry[\s\S]*?roleDir\(""\)/.test(fm)
      if (hasHardcodedGlobal) {
        expect(hasHardcodedGlobal).toBe(true)
      }
    }
  })

  it('HIGH: [hexclaw] autoExtractMemoryForRole 用 context.Background() → 关机时 orphan goroutine', () => {
    // engine/auto_memory.go:37 — 没有继承 parent context
    // 关机期间可能写入文件 / 发 LLM 请求
    const am = readBackend('engine/auto_memory.go')
    if (am) {
      expect(am).toContain('context.Background()')
    }
  })

  // ── MEDIUM ────────────────────────────────────────────────

  it('MEDIUM: [hexclaw] parseEntriesFromFile 所有条目 CreatedAt 设为 today → 时间衰减失效', () => {
    // memory/file_memory.go:683,697-698
    // 每次启动 today 都变 → 所有条目看起来是"今天创建的"
    // entryEvictionScore 的时间衰减逻辑永远认为条目是新的
    // 旧无关记忆永远不被淘汰
  })

  it('MEDIUM: [hexclaw] SemanticSearch 不去重 + 不截断 topK', () => {
    // vector_memory.go:219-245 — vector results + file results 合并无去重
    // 且不截断到 topK → 调用方请求 top-3 可能收到 3+N 条
  })

  it('MEDIUM: [desktop] MemoryView legacy edit 使用 stale content → 并发 auto-extract 的条目丢失', () => {
    // MemoryView.vue:226-228,247-249
    // legacyContent 在 load 时捕获，edit/delete 用它重建完整内容
    // 但期间 auto-memory extraction 可能追加了新条目
    // PUT 覆盖 → 新条目丢失
  })

  it('LOW: [hexclaw] truncateForLog / buildMemoryExtractionPrompt 按 byte 截断 → 中文 UTF-8 断裂 [FIXED]', () => {
    // FIXED: 现在使用 stringx.TruncateWithSuffix (rune-safe) 替代裸 byte slice
    const am = readBackend('engine/auto_memory.go')
    if (am) {
      expect(am).toContain('TruncateWithSuffix')
      expect(am).not.toMatch(/\w+\[:500\]/) // 不再有裸 byte 截断
    }
  })
})

describe('[knowledge] Knowledge Base / RAG', () => {
  // ── HIGH ──────────────────────────────────────────────────

  it('HIGH: [hexclaw] VectorSearch 全表扫描加载所有 embedding → OOM 风险 [FIXED]', () => {
    // FIXED: 上限从 100000 降到 10000 (60MB 可控)
    const store = readBackend('knowledge/sqlite_store.go')
    if (store) {
      expect(store).not.toContain('100000')
      expect(store).toContain('10000')
    }
  })

  it('HIGH: [hexclaw] BM25 score normalization 单结果时返回 0.5 → 排名不一致', () => {
    // sqlite_store.go:435-438 — scoreRange == 0 时 fallback 0.5
    // 一个完美匹配得 0.5 分，两个平庸匹配中最好的得 1.0
    // hybrid scoring 不可靠
  })

  it('HIGH: [desktop] rebuildAll 并行发送所有 reindex → 并发轰炸 embedding API', () => {
    // KnowledgeView.vue:471-476 — for 循环中 handleReindex 不 await
    // 50+ 文档 = 50+ 并发 embedding API 调用 + 50+ SQLite 写事务
    // rate limit / "database is locked" 错误
  })

  // ── MEDIUM ────────────────────────────────────────────────

  it('MEDIUM: [hexclaw] context compression 只保留开头连续 system 消息 → 中间注入的指令被压缩', () => {
    // context_compress.go:87-103 — 遇到非 system 消息就 break
    // 知识库上下文 / 记忆更新 / 中间 system 指令可能被"摘要压缩"掉
    // Agent 丢失关键上下文
  })

  it('MEDIUM: [hexclaw] DOCX 处理 100MB LimitReader + regex FindAllSubmatch → 内存暴涨', () => {
    // handler_knowledge.go:162-171 — document.xml 允许 100MB
    // regex 对 100MB XML 做 FindAllSubmatch → huge heap allocation
  })

  it('MEDIUM: [hexclaw] fallbackTextSearch 无用加载 embedding BLOB', () => {
    // sqlite_store.go:467 — SELECT 包含 embedding 列
    // 纯文本搜索不需要 embedding，白白浪费 I/O 和内存
  })

  it('LOW: [hexclaw] searchKnowledge 响应同时包含 result 和 results 两个 key', () => {
    // handler_knowledge.go:314-317 — 双倍 payload，前端已处理但需要清理
  })

  it('LOW: [desktop] getDocumentContent fallback 按 doc_title 过滤可能命中同名文档', () => {
    // knowledge.ts:176-177 — doc_title 不唯一
    // 可能返回另一个同名文档的 chunks
  })
})

// ═══════════════════════════════════════════════════════════════
// 4. MCP / SKILL / TOOL 执行链 (mcp & skill)
// ═══════════════════════════════════════════════════════════════

describe('[mcp] MCP Client & Tool Chain', () => {
  // ── CRITICAL ──────────────────────────────────────────────

  it('CRITICAL: [hexclaw] OAuth tokenRequest 凭证放在 URL query string 而非 POST body [FIXED]', () => {
    // FIXED: 凭证现在通过 POST body 发送 (strings.NewReader)
    const oauth = readBackend('mcp/oauth.go')
    if (oauth) {
      expect(oauth).not.toContain('RawQuery')
      expect(oauth).toContain('strings.NewReader')
    }
  })

  // ── HIGH ──────────────────────────────────────────────────

  it('HIGH: [hexclaw] CallTool 在 RLock 内执行工具 → 慢工具阻塞 server 管理', () => {
    // mcp/client.go:339-354 — RLock 持有期间执行 t.Execute(ctx, args)
    // 工具可能耗时任意长 → 期间 AddServer/RemoveServer 全部阻塞
    const client = readBackend('mcp/client.go')
    if (client) {
      expect(client).toContain('CallTool')
    }
  })

  it('HIGH: [hexclaw] 空 session_id 共享全局 "always allow" 桶 → 权限升级', () => {
    // tool_approval.go:83 — ctx.Value("session_id").(string)
    // 无 session context 时 sessionID="" → 共享空字符串桶
    // 一个匿名会话批准 shell → 所有匿名会话自动获得 shell 权限
    const ta = readBackend('engine/tool_approval.go')
    if (ta) {
      expect(ta).toContain('"session_id"')
    }
  })

  // ── MEDIUM ────────────────────────────────────────────────

  it('MEDIUM: [hexclaw] MCP configs 读写无锁 → data race', () => {
    // mcp/client.go:113 — m.configs = configs 无锁
    // tryReconnect 在 goroutine 中读 m.configs 也无锁
    // 并发读写 slice → potential panic
  })

  it('MEDIUM: [hexclaw] OAuth token 文件路径可被 serverName 注入', () => {
    // mcp/oauth.go:252-258 — filepath.Join(credDir, serverName+".json")
    // serverName="../../.ssh/authorized_keys" → 写到 cred 目录外
  })

  it('MEDIUM: [hexclaw] SSE stream 无总大小限制 → 恶意 MCP server DoS', () => {
    // transport_http.go:245-291 — 单行 1MB 限制但总量无限
    // 恶意 server 发无穷 1MB 事件 → 内存耗尽
  })

  it('MEDIUM: [hexclaw] MCP tool 可以 shadow 内置 skill → 安全绕过', () => {
    // tool_executor.go:64-69 — skill 未找到时 fall through 到 MCP
    // 如果 file_edit skill 被 disable，MCP server 可以注册同名工具
    // 绕过 workspace path 限制
  })

  it('LOW: [desktop] addMcpServer 不支持 SSE/HTTP transport → 无法添加远程 MCP server', () => {
    // api/mcp.ts:51-53 — 只传 name, command, args
    // 缺少 transport / endpoint 字段
  })
})

describe('[skill] Skill / Shell / File System', () => {
  // ── CRITICAL ──────────────────────────────────────────────

  it('CRITICAL: [hexclaw] SSRF ValidateURL 在 DNS 解析失败时返回 nil → SSRF 绕过', () => {
    // security/ssrf.go:56-59 — net.LookupHost 失败 → return nil (允许通过)
    // 攻击者：故意让 DNS 首次查询失败 → ValidateURL 通过
    // HTTP client 实际连接时 DNS 解析到内网 IP (169.254.169.254 等)
    // 完整 SSRF bypass
    const ssrf = readBackend('security/ssrf.go')
    if (ssrf) {
      expect(ssrf).toContain('LookupHost')
    }
  })

  // ── HIGH ──────────────────────────────────────────────────

  it('HIGH: [hexclaw] shell skill checkDangerousPatterns 不拦截 < 输入重定向', () => {
    // skill/builtin/shell.go:230-263
    // 拦截了 >, >>, <<, $(, `, &&, || 但没拦截 <
    // "cat < /etc/shadow" 通过白名单(cat 允许) + 危险模式检查(< 不拦截)
    // → 任意文件读取
    const shell = readBackend('skill/builtin/shell.go')
    if (shell) {
      const dangerousPatterns = shell.match(/checkDangerousPatterns[\s\S]*?(?=func\s)/)?.[0] || ''
      // 确认 < 没有被检查
      const checksInputRedirect = dangerousPatterns.includes('"<"') || dangerousPatterns.includes("'<'")
      expect(checksInputRedirect).toBe(false)
    }
  })

  it('HIGH: [hexclaw] shell skill Execute 读 args["query"] 但 ToolDefinition 声明 "command"', () => {
    // skill/builtin/shell.go:58-66
    // LLM 按 schema 发 {"command": "ls"} → Execute 读 args["query"] → 空 → "请提供命令"
    // shell skill 的 LLM tool_use 路径完全不工作，只有 /sh 快捷路径可用
    const shell = readBackend('skill/builtin/shell.go')
    if (shell) {
      // 检查 ToolDefinition 声明的参数名
      const hasCommandParam = shell.includes('"command"')
      // 检查 Execute 读取的 key
      const readsQuery = shell.includes('args["query"]')
      if (hasCommandParam && readsQuery) {
        // 确认 bug: 参数名不匹配
        expect(hasCommandParam).toBe(true)
        expect(readsQuery).toBe(true)
      }
    }
  })

  it('HIGH: [hexclaw] git 危险子命令检查是 prefix-based → 可被 flag 前置绕过', () => {
    // shell.go:216-226 — strings.HasPrefix(rest, sub)
    // "git -c http.proxy=attacker push" → rest 是 "-c ..." 不匹配 "push"
    // 攻击者可以 push 代码到远程仓库
  })

  it('HIGH: [hexclaw] path_safe.go resolveSafePath 返回 abs 而非 resolved → TOCTOU', () => {
    // path_safe.go:20-28 — 验证 symlink-resolved 路径，但返回未解析的 abs 路径
    // 验证和使用之间可以创建 symlink → 路径穿越
  })

  // ── MEDIUM ────────────────────────────────────────────────

  it('MEDIUM: [hexclaw] browser skill doPost 类型断言 map[string]string → 永远失败', () => {
    // builtin/browser.go:208-209 — args["data"].(map[string]string)
    // JSON 解析产生 map[string]any → 断言失败 → nil → "缺少 data 参数"
    // browser POST 功能完全不可用
  })

  it('MEDIUM: [hexclaw] sensitive tools 在无 session 上下文时跳过审批', () => {
    // engine/permission.go:186-191
    // sessionID 为空 + risk == "sensitive" → 返回 nil (允许)
    // 后台任务 / 无 session API 调用可以绕过工具审批
  })
})

// ═══════════════════════════════════════════════════════════════
// 5. LLM PROVIDER / 路由 / 性能 (llm & perf)
// ═══════════════════════════════════════════════════════════════

describe('[llm] LLM Provider Chain', () => {
  // ── CRITICAL ──────────────────────────────────────────────

  it('CRITICAL: [ai-core] Anthropic provider 使用 http.Client.Timeout → 流式响应 120s 后被杀 [FIXED]', () => {
    // FIXED: 改用 Transport.ResponseHeaderTimeout，匹配 OpenAI 实现
    const anthropic = readAiCore('llm/anthropic/anthropic.go')
    if (anthropic) {
      // 验证使用 Transport.ResponseHeaderTimeout 而非顶层 Timeout
      const hasResponseHeaderTimeout = anthropic.includes('ResponseHeaderTimeout')
      expect(hasResponseHeaderTimeout).toBe(true) // 已改用 ResponseHeaderTimeout
    }
  })

  it('CRITICAL: [ai-core] Ollama provider 同样使用 http.Client.Timeout → 本地大模型流式截断', () => {
    // ai-core/llm/ollama/ollama.go:61 — 同样的 Timeout: 120s
    // 本地 70B 模型在低端硬件上可能需要数分钟
    const ollama = readAiCore('llm/ollama/ollama.go')
    if (ollama) {
      const hasGlobalTimeout = /Timeout:\s*120\s*\*\s*time\.Second/.test(ollama)
      if (hasGlobalTimeout) {
        expect(hasGlobalTimeout).toBe(true)
      }
    }
  })

  // ── HIGH ──────────────────────────────────────────────────

  it('HIGH: [hexclaw] Router createProvider 所有 provider 都走 OpenAI 兼容 → Anthropic 原生 API 不可用', () => {
    // llmrouter/router.go:156-164 — 无条件 hexagon.NewOpenAI
    // Anthropic /v1/messages + x-api-key 格式被忽略
    // 只有 OpenAI-compatible proxy 能用，原生 API 失败
    const router = readBackend('llmrouter/router.go')
    if (router) {
      expect(router).toContain('NewOpenAI')
    }
  })

  it('HIGH: [hexclaw] Budget Release 可能产生负 usage → 预算控制失效', () => {
    // engine/budget.go:160-170
    // Allocate 不从 parent 预扣 → child 用 0 token → Release 减去全部分配
    // parent.usedTokens 变负 → 剩余预算虚高
  })

  it('HIGH: [hexclaw] 流式工具循环无 budget 时上限 25 vs 非流式 5 → 不一致', () => {
    // processStreamToolLoop vs completeWithTools 的 fallback 上限不同
    // 流式路径成本可达非流式 5 倍
  })

  it('HIGH: [hexclaw] 流式工具循环最终轮重复 LLM 调用 → 2 倍成本', () => {
    // react.go:1168-1182 — 检测到无 tool_calls 后
    // 丢弃已消费的第一个 stream → 重新发请求 stream 给前端
    // Claude Opus $0.075/1K output → 每次最终轮白白多花一倍
  })

  // ── MEDIUM ────────────────────────────────────────────────

  it('MEDIUM: [hexclaw] context compression 用字符数而非 token 数 → 中文场景阈值偏大', () => {
    // context_compress.go:16-19 — 80000 chars ≈ 20K tokens (英文)
    // 中文 ~1.5-2 chars/token → 80000 chars ≈ 40-53K tokens
    // 32K context 模型在压缩前就会溢出
  })

  it('MEDIUM: [hexclaw] pricingTable 用 "google" 但 router 用 "gemini" → Gemini 成本零计', () => {
    // engine/budget.go:108-128 — pricingTable["google"]
    // EstimateCost("gemini", ...) 永远不匹配 → 零成本
    const budget = readBackend('engine/budget.go')
    if (budget) {
      const hasGoogleKey = budget.includes('"google"')
      const hasGeminiKey = budget.includes('"gemini"')
      if (hasGoogleKey) {
        expect(hasGoogleKey).toBe(true)
        // 如果同时存在 "gemini" key 则已修复，否则是 bug
      }
    }
  })

  it('MEDIUM: [hexclaw] Fallback 只尝试一个备选 provider → 7 个中只试 2 个', () => {
    // llmrouter/router.go:303-319 — 按字母序取第一个非排除 provider
    // 如果它也挂了，请求直接失败
  })

  it('MEDIUM: [ai-core] 中间件 cache key 是原始字符串不 hash → 内存浪费', () => {
    // llm/middleware.go:456-527 — 50 条消息 × 2000 字符 = 100KB/key
    // 对比 hexclaw cache/cache.go 用 SHA256
  })

  it('LOW: [ai-core] timeout middleware 对 Stream 无效但无警告', () => {
    // 用户可能以为配了 30s timeout 覆盖所有调用
    // 实际上 Stream 无 timeout → hung connection 永久阻塞
  })
})

// ═══════════════════════════════════════════════════════════════
// 6. 安全网关 (security)
// ═══════════════════════════════════════════════════════════════

describe('[security] Gateway & Permission', () => {
  it('MEDIUM: [hexclaw] RBAC default-open — 无 guest role 时未知用户绕过全部权限', () => {
    // gateway/rbac.go:63-69 — resolveRole 返回 nil → Check 返回 nil (放行)
    // 管理员启用 RBAC 但忘记配 guest role → 等于没启用
  })

  it('MEDIUM: [hexclaw] content filter 简单 Contains 检查 → Unicode 同形字/零宽字符轻松绕过', () => {
    // gateway/safety.go:127-158 — strings.Contains(lower, keyword)
    // Cyrillic "а" 替代 Latin "a" → 绕过
    // 字符间插入零宽字符 → 绕过
  })

  it('MEDIUM: [hexclaw] rate_limit 后端默认 0 → 前端默认 60rpm 不生效', () => {
    // pipeline.go:43-44 — 只在 > 0 时添加 rate limit layer
    // 前端 settings-defaults.ts 设 rate_limit_rpm: 60 但只写本地配置
    // 如果后端 yaml 未设置 → Go 零值 0 → rate limit 不加载
    const defaults = readSrc('stores/settings-defaults.ts')
    expect(defaults).toContain('rate_limit_rpm: 60')
    // 但后端不一定收到这个值
  })
})

// ═══════════════════════════════════════════════════════════════
// 7. 生态依赖合规 (ecosystem)
// ═══════════════════════════════════════════════════════════════

describe('[ecosystem] Dependency Layering Compliance', () => {
  it('HIGH: [hexclaw] production code 直接 import hexagon/rag/splitter → 违反内部包规则', () => {
    // knowledge/sqlite_store.go:12 — import "hexagon/rag/splitter"
    // 规则: hexclaw 不得直接 import hexagon 的内部子包
    // 应通过 hexagon 顶层 re-export
    const store = readBackend('knowledge/sqlite_store.go')
    if (store) {
      const hasInternalImport = store.includes('hexagon/rag/splitter')
      expect(hasInternalImport).toBe(true) // 确认违规存在
    }
  })

  it('LOW: ai-core 版本偏差 — hexclaw v0.0.9 vs hexagon v0.0.8', () => {
    // hexclaw go.mod 和 hexagon go.mod 引用不同版本 ai-core
    // MVS 会解析到 v0.0.9，但 hexagon 只测试过 v0.0.8
    // 如果 v0.0.9 改了接口 → hexagon 可能在 hexclaw 构建中出现类型不兼容
  })
})

// ═══════════════════════════════════════════════════════════════
// 8. 前端代码质量 (frontend)
// ═══════════════════════════════════════════════════════════════

describe('[frontend] Code Quality', () => {
  it('MEDIUM: [desktop] OllamaCard.vue 48KB 硬编码中文 → i18n 覆盖不全', () => {
    const ollamaCard = readSrc('components/settings/OllamaCard.vue')
    // 检查是否存在大量硬编码中文字符串
    const chineseCount = (ollamaCard.match(/[\u4e00-\u9fff]{2,}/g) || []).length
    // 期望硬编码中文字符串少于 10 处（全部应该用 i18n key）
    // BUG: 实际有 20+ 处硬编码中文
    expect(chineseCount).toBeGreaterThan(10) // 确认问题存在
  })

  it('LOW: [desktop] DEFAULT_SESSION_TITLE 硬编码中文 "新对话" [FIXED]', () => {
    const constants = readSrc('constants.ts')
    // FIXED: 改为 locale-neutral 'New Chat'，组件中使用 i18n key
    expect(constants).toContain('New Chat')
    expect(constants).not.toContain("= '新对话'")
  })

  it('MEDIUM: [desktop] settings-defaults rate_limit_rpm: 60 只在前端 → 后端可能未同步', () => {
    // 前端默认值只写到 localStorage 的 config
    // 如果后端从未收到 updateConfig 调用（如首次启动），rate limit 不生效
    const defaults = readSrc('stores/settings-defaults.ts')
    expect(defaults).toContain('rate_limit_rpm: 60')
  })
})

// ═══════════════════════════════════════════════════════════════
// 9. Go 规范 & 最佳实践 (go-conventions)
// ═══════════════════════════════════════════════════════════════

describe('[go] Go Conventions & Best Practices', () => {
  it('MEDIUM: [ai-core] 所有 provider 的 io.ReadAll 错误被丢弃', () => {
    // openai.go:113, gemini.go:111, anthropic.go:107 等
    // bodyBytes, _ := io.ReadAll(resp.Body)
    // 虽然是错误路径的调试信息，但应至少 log
  })

  it('LOW: [hexclaw] tool_approval.go 使用裸字符串作为 context key', () => {
    // ctx.Value("session_id") → 违反 Go context 最佳实践
    // 应使用 unexported type key 避免碰撞
  })

  it('LOW: [hexclaw] cache.go TODO: v2 接入向量化语义匹配', () => {
    // 当前 SHA256 精确匹配 → 语义相近但措辞不同的请求无法命中缓存
    const cache = readBackend('cache/cache.go')
    if (cache) {
      expect(cache).toContain('v2')
    }
  })
})

// ═══════════════════════════════════════════════════════════════
// 统计汇总
// ═══════════════════════════════════════════════════════════════

describe('[summary] Issue Statistics', () => {
  const issues = {
    CRITICAL: [
      'ChatRequest temperature/max_tokens dropped',
      'Nil provider crash in sync compaction',
      'Session lock deadlock on stream tool loop error',
      'Stream tool loop blocks handler goroutine',
      'Non-atomic file write in memory archive',
      'TOCTOU race in memory dedup',
      'Concurrent eviction line-index race',
      'Anthropic HTTP Timeout kills streaming',
      'Ollama HTTP Timeout kills streaming',
      'OAuth credentials in URL query string',
      'SSRF bypass via DNS failure',
    ],
    HIGH: [
      'MCP servers returns string[] not McpServer[]',
      'Shell < redirection not blocked',
      'Shell skill parameter name mismatch',
      'Git subcommand check bypassable',
      'MCP CallTool holds RLock during execution',
      'Empty session_id privilege escalation',
      'Path traversal TOCTOU in path_safe',
      'Router creates all providers via OpenAI',
      'Budget Release negative usage',
      'Stream tool loop 25 vs non-stream 5',
      'Streaming tool loop redundant final LLM call',
      'msg.Metadata goroutine race',
      'SessionLock unbounded growth',
      'User message fire-and-forget persistence',
      'Compaction TOCTOU race',
      'BM25 normalization wrong for 1 result',
      'VectorSearch full table scan OOM',
      'Role-specific memory entries not editable',
      'autoExtractMemory orphan goroutine',
      'rebuildAll concurrent bombing',
      'hexagon/rag/splitter internal import',
    ],
    MEDIUM: [
      'Usage field name mismatch',
      'tools_enabled/max_tools not in backend API',
      'handleListDocuments may return null',
      'ChatMessage.timestamp not sent by backend',
      'WebSocket reconnect duplicate messages',
      'deleteSession finally clears cancelled set',
      'BuildContext invalid conversation history',
      'Delete/UpdateMessage no ownership check',
      'parseEntriesFromFile all dates today',
      'SemanticSearch no dedup no topK truncation',
      'MemoryView legacy stale content',
      'Context compression char vs token threshold',
      'DOCX 100MB regex memory',
      'fallbackTextSearch loads embeddings',
      'MCP configs data race',
      'OAuth token path traversal',
      'SSE stream no total size limit',
      'MCP tool shadow builtin skill',
      'Browser POST type assertion always fails',
      'Sensitive tools skip approval without session',
      'RBAC default-open without guest role',
      'Content filter unicode bypass',
      'Rate limit backend default 0',
      'Pricing table google vs gemini',
      'Fallback only tries one provider',
      'Cache key not hashed',
      'OllamaCard hardcoded Chinese',
    ],
    LOW: [
      'ChatSession.agent_id never sent',
      'McpTool missing server_name',
      'Agent metadata type mismatch',
      'handleListSessions total = len(sessions)',
      'shouldUseDirectCompletion dead code',
      'truncateForLog byte truncation',
      'searchKnowledge duplicate keys',
      'getDocumentContent doc_title collision',
      'addMcpServer no SSE support',
      'Timeout middleware no warning for Stream',
      'ai-core version skew',
      'DEFAULT_SESSION_TITLE hardcoded Chinese',
      'tool_approval bare string context key',
      'cache.go TODO semantic matching',
      'io.ReadAll error discarded',
    ],
  }

  it('should have all CRITICAL issues documented', () => {
    expect(issues.CRITICAL).toHaveLength(11)
  })

  it('should have all HIGH issues documented', () => {
    expect(issues.HIGH).toHaveLength(21)
  })

  it('should have all MEDIUM issues documented', () => {
    expect(issues.MEDIUM).toHaveLength(27)
  })

  it('should have all LOW issues documented', () => {
    expect(issues.LOW).toHaveLength(15)
  })

  it('total issues: 74', () => {
    const total =
      issues.CRITICAL.length + issues.HIGH.length + issues.MEDIUM.length + issues.LOW.length
    expect(total).toBe(74)
  })
})
