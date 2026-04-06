/**
 * 最终挑刺审查 — 全链路全场景单元测试
 *
 * 逐一验证每个功能模块的每个环节是否正常闭环。
 * 如果测试 FAIL 就说明存在真实问题。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

// ─── 统一 Mock ──────────────────────────────────

const mockApi = vi.fn()
vi.mock('@/api/client', () => ({
  apiGet: (...a: unknown[]) => mockApi('GET', ...a),
  apiPost: (...a: unknown[]) => mockApi('POST', ...a),
  apiPut: (...a: unknown[]) => mockApi('PUT', ...a),
  apiDelete: (...a: unknown[]) => mockApi('DELETE', ...a),
  apiPatch: (...a: unknown[]) => mockApi('PATCH', ...a),
  api: mockApi, apiWebSocket: vi.fn(), checkHealth: vi.fn().mockResolvedValue(true),
}))

// ═══════════════════════════════════════════════════
// 1. 会话链路：创建→列表→消息→搜索→fork→删除
// ═══════════════════════════════════════════════════

describe('链路: 会话 CRUD + 消息', () => {
  beforeEach(() => mockApi.mockReset())

  it('createSession 传递 id + title', async () => {
    mockApi.mockResolvedValueOnce({ id: 's1', title: '新对话', created_at: '2026-01-01' })
    const { createSession } = await import('@/api/chat')
    await createSession('s1', '新对话')
    expect(mockApi).toHaveBeenCalledWith('POST', '/api/v1/sessions', { id: 's1', title: '新对话', user_id: 'desktop-user' })
  })

  it('listSessions 传递 user_id + limit', async () => {
    mockApi.mockResolvedValueOnce({ sessions: [], total: 0 })
    const { listSessions } = await import('@/api/chat')
    await listSessions({ limit: 50 })
    expect(mockApi).toHaveBeenCalledWith('GET', '/api/v1/sessions', expect.objectContaining({ limit: 50 }))
  })

  it('listSessionMessages 传递 session_id', async () => {
    mockApi.mockResolvedValueOnce({ messages: [], total: 0 })
    const { listSessionMessages } = await import('@/api/chat')
    await listSessionMessages('s1', { limit: 100 })
    expect(mockApi).toHaveBeenCalledWith('GET', '/api/v1/sessions/s1/messages', { limit: 100, user_id: 'desktop-user' })
  })

  it('updateSessionTitle 用 PATCH', async () => {
    mockApi.mockResolvedValueOnce({ id: 's1', title: '新标题' })
    const { updateSessionTitle } = await import('@/api/chat')
    await updateSessionTitle('s1', '新标题')
    expect(mockApi).toHaveBeenCalledWith('PATCH', '/api/v1/sessions/s1?user_id=desktop-user', { title: '新标题', user_id: 'desktop-user' })
  })

  it('deleteSession 用 DELETE', async () => {
    mockApi.mockResolvedValueOnce({ message: 'ok' })
    const { deleteSession } = await import('@/api/chat')
    await deleteSession('s1')
    expect(mockApi).toHaveBeenCalledWith('DELETE', '/api/v1/sessions/s1?user_id=desktop-user')
  })

  it('deleteMessage 编码 messageId', async () => {
    mockApi.mockResolvedValueOnce({ message: 'ok' })
    const { deleteMessage } = await import('@/api/chat')
    await deleteMessage('msg/special')
    expect(mockApi).toHaveBeenCalledWith('DELETE', `/api/v1/messages/${encodeURIComponent('msg/special')}`)
  })

  it('searchMessages 传递 q + user_id', async () => {
    mockApi.mockResolvedValueOnce({ results: [], total: 0, query: 'test' })
    const { searchMessages } = await import('@/api/chat')
    await searchMessages('test', { limit: 5 })
    expect(mockApi).toHaveBeenCalledWith('GET', '/api/v1/messages/search', expect.objectContaining({ q: 'test' }))
  })

  it('forkSession 传递 message_id', async () => {
    mockApi.mockResolvedValueOnce({ session: { id: 's-fork' }, message: 'ok' })
    const { forkSession } = await import('@/api/chat')
    await forkSession('s1', 'msg-5')
    expect(mockApi).toHaveBeenCalledWith('POST', '/api/v1/sessions/s1/fork', { message_id: 'msg-5', user_id: 'desktop-user' })
  })

  it('updateMessageFeedback 用 PUT（通过动态 import client）', async () => {
    // updateMessageFeedback 内部做 import('./client').then(({apiPut}) => ...)
    // 由于 module-level vi.mock 已拦截 @/api/client，apiPut 指向 mockApi
    mockApi.mockResolvedValueOnce({ message: 'ok' })
    const { updateMessageFeedback } = await import('@/api/chat')
    await updateMessageFeedback('msg-1', 'like')
    expect(mockApi).toHaveBeenCalledWith('PUT', '/api/v1/messages/msg-1/feedback', { feedback: 'like', user_id: 'desktop-user' })
  })
})

// ═══════════════════════════════════════════════════
// 2. 知识库链路：文档CRUD→搜索→上传
// ═══════════════════════════════════════════════════

describe('链路: 知识库 CRUD + 搜索', () => {
  beforeEach(() => mockApi.mockReset())

  it('getDocuments', async () => {
    mockApi.mockResolvedValueOnce({ documents: [], total: 0 })
    const { getDocuments } = await import('@/api/knowledge')
    const res = await getDocuments()
    expect(mockApi).toHaveBeenCalledWith('GET', '/api/v1/knowledge/documents')
    expect(res.documents).toEqual([])
  })

  it('addDocument 传递 title + content + source', async () => {
    mockApi.mockResolvedValueOnce({ id: 'd1', title: '手册', chunk_count: 5, created_at: '' })
    const { addDocument } = await import('@/api/knowledge')
    await addDocument('手册', '内容...', '来源')
    expect(mockApi).toHaveBeenCalledWith('POST', '/api/v1/knowledge/documents', { title: '手册', content: '内容...', source: '来源' })
  })

  it('deleteDocument 编码 id', async () => {
    mockApi.mockResolvedValueOnce({ message: 'ok' })
    const { deleteDocument } = await import('@/api/knowledge')
    await deleteDocument('doc/中文')
    expect(mockApi).toHaveBeenCalledWith('DELETE', `/api/v1/knowledge/documents/${encodeURIComponent('doc/中文')}`)
  })

  it('searchKnowledge 兼容 result 和 results 字段', async () => {
    // 后端返回 results（复数）
    mockApi.mockResolvedValueOnce({ results: [{ content: '内容', score: 0.8 }] })
    const { searchKnowledge } = await import('@/api/knowledge')
    const res = await searchKnowledge('查询', 3)
    expect(res.result).toHaveLength(1) // 归一化到 result

    // 后端返回 result（单数）
    mockApi.mockResolvedValueOnce({ result: [{ content: '内容2', score: 0.9 }] })
    const res2 = await searchKnowledge('查询2', 3)
    expect(res2.result).toHaveLength(1)
  })

  it('reindexDocument 编码 id', async () => {
    mockApi.mockResolvedValueOnce({ status: 'ok' })
    const { reindexDocument } = await import('@/api/knowledge')
    await reindexDocument('doc-1')
    expect(mockApi).toHaveBeenCalledWith('POST', '/api/v1/knowledge/documents/doc-1/reindex')
  })
})

// ═══════════════════════════════════════════════════
// 3. 记忆链路：保存→更新→搜索→删除→清空
// ═══════════════════════════════════════════════════

describe('链路: 记忆 CRUD + 搜索', () => {
  beforeEach(() => mockApi.mockReset())

  it('saveMemory 传递 content + type', async () => {
    mockApi.mockResolvedValueOnce({ message: 'ok' })
    const { saveMemory } = await import('@/api/memory')
    await saveMemory('内容', 'daily')
    expect(mockApi).toHaveBeenCalledWith('POST', '/api/v1/memory', { content: '内容', type: 'daily' })
  })

  it('updateMemory 用 PUT', async () => {
    mockApi.mockResolvedValueOnce({ message: 'ok' })
    const { updateMemory } = await import('@/api/memory')
    await updateMemory('新内容')
    expect(mockApi).toHaveBeenCalledWith('PUT', '/api/v1/memory', { content: '新内容', type: 'memory' })
  })

  it('searchMemory 传递 q', async () => {
    mockApi.mockResolvedValueOnce({ results: [], vector_results: null, total: 0 })
    const { searchMemory } = await import('@/api/memory')
    await searchMemory('偏好')
    expect(mockApi).toHaveBeenCalledWith('GET', '/api/v1/memory/search', { q: '偏好' })
  })

  it('deleteMemory 编码 id', async () => {
    mockApi.mockResolvedValueOnce({ message: 'ok' })
    const { deleteMemory } = await import('@/api/memory')
    await deleteMemory('mem/特殊')
    expect(mockApi).toHaveBeenCalledWith('DELETE', `/api/v1/memory/${encodeURIComponent('mem/特殊')}`)
  })

  it('clearAllMemory 调 DELETE /api/v1/memory', async () => {
    mockApi.mockResolvedValueOnce({ message: 'ok' })
    const { clearAllMemory } = await import('@/api/memory')
    await clearAllMemory()
    expect(mockApi).toHaveBeenCalledWith('DELETE', '/api/v1/memory')
  })
})

// ═══════════════════════════════════════════════════
// 4. 任务链路：创建→暂停→恢复→触发→历史→删除
// ═══════════════════════════════════════════════════

describe('链路: 任务全生命周期', () => {
  beforeEach(() => mockApi.mockReset())

  it('createCronJob 传递完整参数', async () => {
    mockApi.mockResolvedValueOnce({ id: 'j1', name: '日报', next_run_at: '' })
    const { createCronJob } = await import('@/api/tasks')
    await createCronJob({ name: '日报', schedule: '0 9 * * *', prompt: '生成日报', type: 'cron' })
    expect(mockApi).toHaveBeenCalledWith('POST', '/api/v1/cron/jobs', expect.objectContaining({ name: '日报', schedule: '0 9 * * *' }))
  })

  it('pause/resume/trigger 路径正确', async () => {
    mockApi.mockResolvedValue({ message: 'ok' })
    const { pauseCronJob, resumeCronJob, triggerCronJob } = await import('@/api/tasks')
    await pauseCronJob('j1')
    expect(mockApi).toHaveBeenCalledWith('POST', `/api/v1/cron/jobs/${encodeURIComponent('j1')}/pause`)
    await resumeCronJob('j1')
    expect(mockApi).toHaveBeenCalledWith('POST', `/api/v1/cron/jobs/${encodeURIComponent('j1')}/resume`)
    await triggerCronJob('j1')
    expect(mockApi).toHaveBeenCalledWith('POST', `/api/v1/cron/jobs/${encodeURIComponent('j1')}/trigger`)
  })

  it('getCronJobHistory 兼容 history 和 runs 字段', async () => {
    mockApi.mockResolvedValueOnce({ runs: [{ id: 'r1', status: 'success', run_at: '2026-01-01' }] })
    const { getCronJobHistory } = await import('@/api/tasks')
    const history = await getCronJobHistory('j1')
    expect(history[0]!.started_at).toBe('2026-01-01') // run_at → started_at 归一化
  })

  it('deleteCronJob 路径正确', async () => {
    mockApi.mockResolvedValueOnce({ message: 'ok' })
    const { deleteCronJob } = await import('@/api/tasks')
    await deleteCronJob('j1')
    expect(mockApi).toHaveBeenCalledWith('DELETE', `/api/v1/cron/jobs/${encodeURIComponent('j1')}`)
  })
})

// ═══════════════════════════════════════════════════
// 5. Skill 链路：列表→安装→启用→卸载
// ═══════════════════════════════════════════════════

describe('链路: Skill 管理', () => {
  beforeEach(() => mockApi.mockReset())

  it('getSkills', async () => {
    mockApi.mockResolvedValueOnce({ skills: [], total: 0, dir: '/skills' })
    const { getSkills } = await import('@/api/skills')
    await getSkills()
    expect(mockApi).toHaveBeenCalledWith('GET', '/api/v1/skills')
  })

  it('installSkill 传递 source', async () => {
    mockApi.mockResolvedValueOnce({ name: 's1', description: '', version: '1.0', message: 'ok' })
    const { installSkill } = await import('@/api/skills')
    await installSkill('/path/to/skill')
    expect(mockApi).toHaveBeenCalledWith('POST', '/api/v1/skills/install', { source: '/path/to/skill' })
  })

  it('uninstallSkill 编码 name', async () => {
    mockApi.mockResolvedValueOnce({})
    const { uninstallSkill } = await import('@/api/skills')
    await uninstallSkill('my/skill')
    expect(mockApi).toHaveBeenCalledWith('DELETE', `/api/v1/skills/${encodeURIComponent('my/skill')}`)
  })

  it('setSkillEnabled 用 PUT + 后端失败时 graceful fallback', async () => {
    mockApi.mockRejectedValueOnce(new Error('backend down'))
    const { setSkillEnabled } = await import('@/api/skills')
    const res = await setSkillEnabled('s1', true)
    // 后端失败不 throw，返回 local-fallback
    expect(res.success).toBe(true)
    expect(res.source).toBe('local-fallback')
  })

  it('installFromHub 用 clawhub:// 协议', async () => {
    mockApi.mockResolvedValueOnce({})
    const { installFromHub } = await import('@/api/skills')
    await installFromHub('code-review-pro')
    expect(mockApi).toHaveBeenCalledWith('POST', '/api/v1/skills/install', { source: 'clawhub://code-review-pro' })
  })
})

// ═══════════════════════════════════════════════════
// 6. MCP 链路：服务器→工具→调用→市场
// ═══════════════════════════════════════════════════

describe('链路: MCP 全功能', () => {
  beforeEach(() => mockApi.mockReset())

  it('getMcpServers', async () => {
    mockApi.mockResolvedValueOnce({ servers: ['mcp-github'], total: 1 })
    const { getMcpServers } = await import('@/api/mcp')
    const res = await getMcpServers()
    expect(res.servers).toHaveLength(1)
  })

  it('addMcpServer 传递 name + command + args', async () => {
    mockApi.mockResolvedValueOnce({ message: 'ok' })
    const { addMcpServer } = await import('@/api/mcp')
    await addMcpServer('github', 'npx', ['-y', 'mcp-github'])
    expect(mockApi).toHaveBeenCalledWith('POST', '/api/v1/mcp/servers', { name: 'github', command: 'npx', args: ['-y', 'mcp-github'] })
  })

  it('removeMcpServer 编码 name', async () => {
    mockApi.mockResolvedValueOnce({ message: 'ok' })
    const { removeMcpServer } = await import('@/api/mcp')
    await removeMcpServer('server/名称')
    expect(mockApi).toHaveBeenCalledWith('DELETE', `/api/v1/mcp/servers/${encodeURIComponent('server/名称')}`)
  })

  it('callMcpTool 校验 + 错误处理', async () => {
    const { callMcpTool } = await import('@/api/mcp')
    // 空名
    await expect(callMcpTool('', {})).rejects.toThrow('non-empty string')
    // 空白名
    await expect(callMcpTool('  ', {})).rejects.toThrow('non-empty string')
    // 后端返回 error
    mockApi.mockResolvedValueOnce({ result: null, error: 'tool crashed' })
    await expect(callMcpTool('bad', {})).rejects.toThrow('tool crashed')
    // 正常调用
    mockApi.mockResolvedValueOnce({ result: { data: 1 } })
    const res = await callMcpTool('good', { q: 'test' })
    expect(res.result).toEqual({ data: 1 })
  })

  it('getMcpServerStatus', async () => {
    mockApi.mockResolvedValueOnce({ servers: [{ name: 'gh', connected: true, tool_count: 3 }] })
    const { getMcpServerStatus } = await import('@/api/mcp')
    const res = await getMcpServerStatus()
    expect(res.servers![0]!.connected).toBe(true)
  })
})

// ═══════════════════════════════════════════════════
// 7. Agent 链路：角色→注册→更新→规则→注销
// ═══════════════════════════════════════════════════

describe('链路: Agent 管理', () => {
  beforeEach(() => mockApi.mockReset())

  it('getRoles', async () => {
    mockApi.mockResolvedValueOnce({ roles: [{ name: 'researcher', title: '研究员' }] })
    const { getRoles } = await import('@/api/agents')
    const res = await getRoles()
    expect(res.roles).toHaveLength(1)
  })

  it('registerAgent + updateAgent + unregisterAgent 编码 name', async () => {
    mockApi.mockResolvedValue({ message: 'ok', name: 'my-agent' })
    const { registerAgent, updateAgent, unregisterAgent } = await import('@/api/agents')
    await registerAgent({ name: 'my-agent' } as any)
    await updateAgent('my/agent', { name: 'renamed' } as any)
    expect(mockApi).toHaveBeenCalledWith('PUT', `/api/v1/agents/${encodeURIComponent('my/agent')}`, expect.anything())
    await unregisterAgent('my/agent')
    expect(mockApi).toHaveBeenCalledWith('DELETE', `/api/v1/agents/${encodeURIComponent('my/agent')}`)
  })

  it('addRule + deleteRule', async () => {
    mockApi.mockResolvedValueOnce({ message: 'ok', id: 1 })
    const { addRule, deleteRule } = await import('@/api/agents')
    await addRule({ pattern: '*.py', agent: 'coder', priority: 10 } as any)
    expect(mockApi).toHaveBeenCalledWith('POST', '/api/v1/agents/rules', expect.objectContaining({ pattern: '*.py' }))
    mockApi.mockResolvedValueOnce({ message: 'ok' })
    await deleteRule(1)
    expect(mockApi).toHaveBeenCalledWith('DELETE', '/api/v1/agents/rules/1')
  })
})

// ═══════════════════════════════════════════════════
// 8. Webhook 链路：创建→列表→删除
// ═══════════════════════════════════════════════════

describe('链路: Webhook', () => {
  beforeEach(() => mockApi.mockReset())

  it('createWebhook + deleteWebhook 编码 id', async () => {
    mockApi.mockResolvedValueOnce({ id: 'wh-1', name: '通知', url: '' })
    const { createWebhook, deleteWebhook } = await import('@/api/webhook')
    await createWebhook({ name: '通知', type: 'wecom', url: 'https://x.com', events: ['task_complete'] })
    expect(mockApi).toHaveBeenCalledWith('POST', '/api/v1/webhooks', expect.objectContaining({ name: '通知' }))

    mockApi.mockResolvedValueOnce({ message: 'ok' })
    await deleteWebhook('wh-1')
    expect(mockApi).toHaveBeenCalledWith('DELETE', `/api/v1/webhooks/${encodeURIComponent('wh-1')}`)
  })
})

// 9. 本地 LLM — 已在 ollama-pull-stream.test.ts / ollama-full-chain.test.ts 完整覆盖

// ═══════════════════════════════════════════════════
// 10. 前后端对齐 — 路由完整性
// ═══════════════════════════════════════════════════

describe('前后端对齐: API 路由完整性', () => {
  it('所有 apiDelete 调用中的用户可控参数都使用 encodeURIComponent', () => {
    const files = [
      'src/api/webhook.ts', 'src/api/knowledge.ts', 'src/api/mcp.ts',
      'src/api/skills.ts', 'src/api/memory.ts', 'src/api/agents.ts', 'src/api/chat.ts',
    ]
    const violations: string[] = []
    for (const file of files) {
      const source = readFileSync(file, 'utf-8')
      // 找所有 apiDelete 中使用模板字符串的调用
      const calls = [...source.matchAll(/apiDelete[^(]*\(`[^`]*\$\{([^}]+)\}[^`]*`/g)]
      for (const call of calls) {
        const param = call[1]!.trim()
        if (/^\d+$/.test(param)) continue // 纯数字 id
        // 用户可控参数（name, id 等变量）应编码
        if (!param.includes('encodeURIComponent') && !param.includes('DESKTOP_USER_ID')) {
          // 允许内部 ID（sessionId, job.id 等后端生成的）
          const isInternalId = /^(sessionId|id|job\.id)$/.test(param)
          if (!isInternalId) {
            violations.push(`${file}: apiDelete 中 \${${param}} 未使用 encodeURIComponent`)
          }
        }
      }
    }
    expect(violations).toHaveLength(0)
  })

  it('isTauri() 只在 utils/platform.ts 定义一处（secure-store.ts 允许本地定义）', () => {
    // settings.ts 应从 platform.ts 导入
    const settingsSource = readFileSync('src/stores/settings.ts', 'utf-8')
    expect(settingsSource, 'src/stores/settings.ts 不应定义 isTauri 函数').not.toMatch(/function isTauri\s*\(/)
    expect(settingsSource).toContain("import { isTauri }")

    // secure-store.ts 有自己的本地 isTauri 定义（轻量级，不依赖 platform.ts）
    const secureStoreSource = readFileSync('src/utils/secure-store.ts', 'utf-8')
    expect(secureStoreSource).toMatch(/function isTauri\s*\(/)

    const platform = readFileSync('src/utils/platform.ts', 'utf-8')
    expect(platform).toContain('export function isTauri')
  })

  it('生产代码中不再有 console.error/warn（仅 logger.ts 内部实现除外）', () => {
    const dirs = ['src/stores', 'src/composables', 'src/services']
    for (const dir of dirs) {
      for (const f of readdirSync(dir)) {
        if (f.includes('__tests__') || statSync(join(dir, f)).isDirectory()) continue
        const source = readFileSync(join(dir, f), 'utf-8')
        const matches = source.match(/console\.(error|warn)\s*\(/g)
        expect(matches, `${dir}/${f} 还有 console.error/warn`).toBeNull()
      }
    }
  })
})
