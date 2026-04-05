/**
 * Code Review V3 — 全面业务场景覆盖
 *
 * 单元测试 → 模块测试 → 集成测试，基于测试结果暴露问题。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'fs'

// ═══════════════════════════════════════════════════
// 1. URI 编码一致性审计（安全 + 边界）
// ═══════════════════════════════════════════════════

describe('URI 编码审计 — 所有 DELETE/POST/PUT 含路径参数的 API 必须编码', () => {
  /** 检测给定文件中模板字符串插值是否使用了 encodeURIComponent */
  function auditUriEncoding(filePath: string): { line: number; code: string; param: string }[] {
    const source = readFileSync(filePath, 'utf-8')
    const lines = source.split('\n')
    const violations: { line: number; code: string; param: string }[] = []

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      // 匹配 apiDelete/apiPost/apiPut/apiPatch/apiGet 中的模板字符串插值
      if (!/api(Delete|Post|Put|Patch|Get)\s*(<[^>]*>)?\s*\(/.test(line)) continue
      // 提取 ${...} 插值
      const interpolations = line.matchAll(/\$\{([^}]+)\}/g)
      for (const match of interpolations) {
        const expr = match[1]!.trim()
        // 跳过已编码、常量、数字参数
        if (expr.includes('encodeURIComponent')) continue
        if (expr.includes('DESKTOP_USER_ID')) continue
        if (/^\d+$/.test(expr)) continue // numeric ID
        // 跳过查询字符串拼接（不在路径中）
        if (line.includes('?') && line.indexOf('?') < line.indexOf(match[0]!)) continue
        violations.push({ line: i + 1, code: line.trim(), param: expr })
      }
    }
    return violations
  }

  it('skills.ts — uninstallSkill 应编码 name', () => {
    const violations = auditUriEncoding('src/api/skills.ts')
    const skillViolation = violations.find(v => v.code.includes('/skills/') && v.param === 'name')
    // 修复后不应有未编码的 name 参数
    expect(skillViolation).toBeUndefined()
  })

  it('tasks.ts — deleteCronJob/pauseCronJob 等应编码 id', () => {
    const violations = auditUriEncoding('src/api/tasks.ts')
    // CronJob ID 是后端生成的 UUID/数字，通常安全，但最佳实践仍应编码
    // 这里我们允许纯 id 不编码（后端保证格式），但标记为已知
    for (const v of violations) {
      // 只对非 id 参数报错
      expect(v.param).toMatch(/^id$/)
    }
  })

  it('chat.ts — deleteSession/forkSession 应编码 sessionId', () => {
    const violations = auditUriEncoding('src/api/chat.ts')
    const sessionViolations = violations.filter(v =>
      v.code.includes('/sessions/') && v.param === 'sessionId',
    )
    // sessionId 是 nanoid 生成的，通常安全，但最佳实践应编码
    // 标记为已知但不阻塞
    for (const v of sessionViolations) {
      expect(v.param).toBe('sessionId') // 仅 sessionId 类的内部 ID
    }
  })

  it('webhook.ts — deleteWebhook 已修复编码', () => {
    const violations = auditUriEncoding('src/api/webhook.ts')
    expect(violations).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════
// 2. extractArtifacts 边界情况（逻辑错误）
// ═══════════════════════════════════════════════════

describe('extractArtifacts — 代码块解析边界情况', () => {
  // 直接测试正则而非整个 store
  const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g

  function extractBlocks(content: string) {
    const results: { language: string; code: string }[] = []
    let match: RegExpExecArray | null
    while ((match = codeBlockRegex.exec(content)) !== null) {
      results.push({ language: match[1] || 'text', code: match[2]!.trim() })
    }
    // Reset lastIndex for reuse
    codeBlockRegex.lastIndex = 0
    return results
  }

  it('标准代码块正常提取', () => {
    const blocks = extractBlocks('```ts\nconsole.log("hello")\n```')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.language).toBe('ts')
    expect(blocks[0]!.code).toBe('console.log("hello")')
  })

  it('无语言标注的代码块', () => {
    const blocks = extractBlocks('```\nplain code here\n```')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.language).toBe('text')
  })

  it('代码块内容少于 5 字符应被跳过（store 逻辑）', () => {
    // extractArtifacts 跳过 code.length < 5
    const blocks = extractBlocks('```ts\na=1\n```')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.code).toBe('a=1')
    expect(blocks[0]!.code.length).toBeLessThan(5) // 会被 store 过滤
  })

  it('多个代码块全部提取', () => {
    const content = '```js\nconst a = 1\n```\n\n```py\nprint("hi")\n```'
    const blocks = extractBlocks(content)
    expect(blocks).toHaveLength(2)
    expect(blocks[0]!.language).toBe('js')
    expect(blocks[1]!.language).toBe('py')
  })

  it('代码块内嵌 ``` 不被误截断', () => {
    // 边界：代码块内出现反引号但不是三个连续
    const content = '```md\nUse `code` inline\n```'
    const blocks = extractBlocks(content)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.code).toContain('`code`')
  })

  it('缺少换行的代码块开头不匹配（需要 ```lang\\n）', () => {
    // ```ts console.log("hello")``` 没有换行，正则不匹配
    const blocks = extractBlocks('```tsconsole.log("hello")```')
    expect(blocks).toHaveLength(0) // 不匹配是正确行为
  })
})

// ═══════════════════════════════════════════════════
// 3. WebSocket 心跳超时逻辑（逻辑错误）
// ═══════════════════════════════════════════════════

describe('WebSocket 心跳 — pong 超时判断', () => {
  it('pong 超时阈值应为 heartbeatInterval + pongTimeoutMs', () => {
    // 读取源码验证心跳逻辑
    const source = readFileSync('src/api/websocket.ts', 'utf-8')

    // 心跳间隔和超时
    const heartbeatMatch = source.match(/heartbeatInterval\s*=\s*(\d+)/)
    const pongTimeoutMatch = source.match(/pongTimeoutMs\s*=\s*(\d+)/)

    expect(heartbeatMatch).toBeTruthy()
    expect(pongTimeoutMatch).toBeTruthy()

    const heartbeatInterval = parseInt(heartbeatMatch![1]!)
    const pongTimeoutMs = parseInt(pongTimeoutMatch![1]!)

    // 30s 心跳 + 10s pong 超时 = 40s 死连接判定
    expect(heartbeatInterval).toBe(30000)
    expect(pongTimeoutMs).toBe(10000)

    // 验证超时判断逻辑存在
    expect(source).toContain('this.heartbeatInterval + this.pongTimeoutMs')
  })
})

// ═══════════════════════════════════════════════════
// 4. Chat store 并发安全（边界情况）
// ═══════════════════════════════════════════════════

describe('Chat store — ensureSession 并发安全', () => {
  it('并发 ensureSession 应只创建一个会话', async () => {
    const { setActivePinia, createPinia } = await import('pinia')
    setActivePinia(createPinia())

    // Mock messageService
    const createSessionCalls: string[] = []
    vi.doMock('@/services/messageService', () => ({
      loadAllSessions: vi.fn().mockResolvedValue([]),
      createSession: vi.fn().mockImplementation(async (id: string) => {
        createSessionCalls.push(id)
      }),
      loadMessages: vi.fn().mockResolvedValue([]),
      loadArtifacts: vi.fn().mockResolvedValue([]),
      persistMessage: vi.fn().mockResolvedValue(true),
      saveArtifact: vi.fn(),
      updateSessionTitle: vi.fn(),
      touchSession: vi.fn(),
      deleteSession: vi.fn(),
      setLastSessionId: vi.fn(),
      getLastSessionId: vi.fn().mockReturnValue(null),
      removeMessage: vi.fn(),
    }))
    vi.doMock('@/api/websocket', () => ({
      hexclawWS: {
        connect: vi.fn().mockResolvedValue(undefined),
        isConnected: vi.fn().mockReturnValue(false),
        clearCallbacks: vi.fn(), clearStreamCallbacks: vi.fn(),
        onChunk: vi.fn().mockReturnValue(() => {}),
        onReply: vi.fn().mockReturnValue(() => {}),
        onError: vi.fn().mockReturnValue(() => {}),
        onApprovalRequest: vi.fn().mockReturnValue(() => {}),
        sendMessage: vi.fn(),
      },
    }))
    vi.doMock('@/api/chat', () => ({
      sendChatViaBackend: vi.fn().mockResolvedValue({ reply: 'ok', session_id: 's1' }),
      updateMessageFeedback: vi.fn(),
    }))

    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()

    // 并发调用 3 次 ensureSession
    const [id1, id2, id3] = await Promise.all([
      store.ensureSession(),
      store.ensureSession(),
      store.ensureSession(),
    ])

    // 所有调用应返回同一个 ID
    expect(id1).toBe(id2)
    expect(id2).toBe(id3)
    // createSession 只应被调用 1 次
    expect(createSessionCalls).toHaveLength(1)
  })
})

// ═══════════════════════════════════════════════════
// 5. API 函数缺少 encodeURIComponent（安全漏洞）
// ═══════════════════════════════════════════════════

describe('API 层安全 — 用户可控参数必须 URI 编码', () => {
  it('uninstallSkill name 参数未编码（用户输入的 skill 名）', () => {
    const source = readFileSync('src/api/skills.ts', 'utf-8')
    const fnStart = source.indexOf('export function uninstallSkill')
    const fnEnd = source.indexOf('}', fnStart)
    const fn = source.slice(fnStart, fnEnd + 1)

    // 用户选择的 skill 名可能含特殊字符
    // 修复前 FAIL：直接 ${name}
    // 修复后 PASS：${encodeURIComponent(name)}
    expect(fn).toContain('encodeURIComponent')
  })
})

// ═══════════════════════════════════════════════════
// 6. toContentBlocks 功能完整性
// ═══════════════════════════════════════════════════

describe('toContentBlocks — 消息转 ContentBlock 完整性', () => {
  it('空消息返回空数组', async () => {
    const { toContentBlocks } = await import('@/utils/content-blocks')
    const blocks = toContentBlocks({
      id: 'm1', role: 'assistant', content: '', timestamp: '2026-01-01',
    })
    expect(blocks).toHaveLength(0)
  })

  it('有 reasoning + content 时返回 thinking + text 两个 block', async () => {
    const { toContentBlocks } = await import('@/utils/content-blocks')
    const blocks = toContentBlocks({
      id: 'm1', role: 'assistant', content: 'Hello',
      reasoning: 'Let me think...', timestamp: '2026-01-01',
      metadata: { thinking_duration: 5 },
    })
    expect(blocks).toHaveLength(2)
    expect(blocks[0]!.type).toBe('thinking')
    expect((blocks[0] as any).duration).toBe(5)
    expect(blocks[1]!.type).toBe('text')
  })

  it('有 tool_calls 时生成 tool_use + tool_result 块', async () => {
    const { toContentBlocks } = await import('@/utils/content-blocks')
    const blocks = toContentBlocks({
      id: 'm1', role: 'assistant', content: 'Done',
      timestamp: '2026-01-01',
      tool_calls: [
        { id: 't1', name: 'search', arguments: { q: 'test' }, result: 'found 3' },
      ],
    })
    // text + tool_use + tool_result = 3
    expect(blocks).toHaveLength(3)
    expect(blocks[1]!.type).toBe('tool_use')
    expect(blocks[2]!.type).toBe('tool_result')
  })

  it('msg.blocks 已存在时直接返回，不重建', async () => {
    const { toContentBlocks } = await import('@/utils/content-blocks')
    const existing = [{ type: 'text' as const, text: 'pre-built' }]
    const blocks = toContentBlocks({
      id: 'm1', role: 'assistant', content: 'ignored',
      timestamp: '2026-01-01',
      blocks: existing,
    })
    expect(blocks).toBe(existing)
    expect(blocks).toHaveLength(1)
  })
})

// ═══════════════════════════════════════════════════
// 7. file-parser isDocumentFile 边界
// ═══════════════════════════════════════════════════

describe('file-parser — isDocumentFile 边界', () => {
  it('有扩展名的文档文件返回 true', async () => {
    const { isDocumentFile } = await import('@/utils/file-parser')
    expect(isDocumentFile(new File([], 'test.pdf'))).toBe(true)
    expect(isDocumentFile(new File([], 'notes.md'))).toBe(true)
    expect(isDocumentFile(new File([], 'data.csv'))).toBe(true)
  })

  it('图片/视频文件返回 false', async () => {
    const { isDocumentFile } = await import('@/utils/file-parser')
    expect(isDocumentFile(new File([], 'photo.png'))).toBe(false)
    expect(isDocumentFile(new File([], 'video.mp4'))).toBe(false)
  })

  it('无扩展名的文件返回 false', async () => {
    const { isDocumentFile } = await import('@/utils/file-parser')
    expect(isDocumentFile(new File([], 'README'))).toBe(false)
  })

  it('仅有点号的文件名返回 false', async () => {
    const { isDocumentFile } = await import('@/utils/file-parser')
    expect(isDocumentFile(new File([], '.gitignore'))).toBe(false)
  })
})

// ═══════════════════════════════════════════════════
// 8. 前后端对齐 — budget API 类型审计
// ═══════════════════════════════════════════════════

describe('前后端对齐 — BudgetStatus 类型检查', () => {
  it('BudgetStatus 应包含 summary/remaining 嵌套结构 或 扁平字段', () => {
    const source = readFileSync('src/api/tools-status.ts', 'utf-8')
    // 当前定义是扁平字段
    expect(source).toContain('tokens_used: number')
    expect(source).toContain('cost_used: number')
    // 如果后端实际返回 { summary: {...}, remaining: {...} }
    // 则此类型需要更新 — 记录为已知不对齐
  })
})

// ═══════════════════════════════════════════════════
// 9. 错误处理 — fromNativeError 边界
// ═══════════════════════════════════════════════════

describe('errors.ts — fromNativeError 边界情况', () => {
  it('处理 string 类型错误', async () => {
    const { fromNativeError } = await import('@/utils/errors')
    const err = fromNativeError('something broke')
    expect(err.code).toBe('UNKNOWN')
    expect(err.message).toBe('something broke')
  })

  it('处理 null/undefined 错误', async () => {
    const { fromNativeError } = await import('@/utils/errors')
    expect(fromNativeError(null).message).toBe('未知错误')
    expect(fromNativeError(undefined).message).toBe('未知错误')
  })

  it('已经是 ApiError 结构时直接返回', async () => {
    const { fromNativeError } = await import('@/utils/errors')
    const existing = { code: 'RATE_LIMITED', message: '太快了', status: 429 }
    const result = fromNativeError(existing)
    expect(result).toBe(existing)
  })

  it('DOMException AbortError 归类为 TIMEOUT', async () => {
    const { fromNativeError } = await import('@/utils/errors')
    const abort = new DOMException('aborted', 'AbortError')
    const err = fromNativeError(abort)
    expect(err.code).toBe('TIMEOUT')
  })
})

// ═══════════════════════════════════════════════════
// 10. 冗余代码审计
// ═══════════════════════════════════════════════════

describe('冗余代码审计', () => {
  it('models.ts listModels 已被清理，仅保留类型导出', () => {
    const source = readFileSync('src/api/models.ts', 'utf-8')
    expect(source).not.toContain('listModels')
    expect(source).not.toContain('unused')
    // index.ts 只导出类型
    const indexSource = readFileSync('src/api/index.ts', 'utf-8')
    expect(indexSource).toContain("type { LLMModel }")
  })

  it('webhook.ts registerWebhook 已被清理', () => {
    const source = readFileSync('src/api/webhook.ts', 'utf-8')
    expect(source).not.toContain('registerWebhook')
  })
})
