/**
 * 域B 审查取证：记忆 / 知识库（memory / knowledge）
 *
 * SDET 挑刺式 code review，只读审查 + 只写新测试。本文件不改任何生产源码。
 * 每条 finding 附测试证据：
 *   - 逻辑/契约 bug → 写断言「正确行为」的测试，使其 RED（标注 [RED 预期失败]）。
 *   - 前后端对齐问题 → 把前端契约 vs 后端 handler 字段对照成断言（标注证据）。
 *
 * 涉及文件（file:line 见每条注释）：
 *   前端 src/api/memory.ts, src/api/knowledge.ts, src/api/prompts.ts,
 *        src/types/memory.ts, src/types/knowledge.ts,
 *        src/views/MemoryView.vue, src/views/KnowledgeView.vue
 *   后端 hexclaw/api/handler_misc.go, handler_extended.go, handler_knowledge.go,
 *        handler_library.go, server.go,
 *        hexclaw/memory/file_memory.go, hexclaw/knowledge/knowledge.go
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// ── Hoisted mocks for api/client ────────────────────────────────────
const { mockApiGet, mockApiPost, mockApiPut, mockApiDelete } = vi.hoisted(() => ({
  mockApiGet: vi.fn(),
  mockApiPost: vi.fn(),
  mockApiPut: vi.fn(),
  mockApiDelete: vi.fn(),
}))

vi.mock('@/api/client', () => ({
  apiGet: mockApiGet,
  apiPost: mockApiPost,
  apiPut: mockApiPut,
  apiDelete: mockApiDelete,
}))
// knowledge.ts imports from relative './client' as well
vi.mock('../api/client', () => ({
  apiGet: mockApiGet,
  apiPost: mockApiPost,
  apiPut: mockApiPut,
  apiDelete: mockApiDelete,
}))

vi.mock('@/config/env', () => ({
  OLLAMA_BASE: 'http://localhost:11434',
  env: { apiBase: 'http://localhost:16060' },
}))

import {
  getMemoryEntries,
  searchMemory,
  archiveMemoryEntry,
  restoreMemoryEntry,
} from '@/api/memory'
import { searchKnowledge, getDocument, reindexDocument } from '@/api/knowledge'
import * as promptsApi from '@/api/prompts'
import type { MemoryEntry } from '@/types'

beforeEach(() => {
  vi.clearAllMocks()
})

// ════════════════════════════════════════════════════════════════════
// B-1 [高][对齐] /api/v1/memory/search 的 results 元素形状 ≠ MemoryEntry
//
// 后端 hexclaw/api/handler_misc.go:189-193 返回 results = s.fileMem.Search(query)。
// FileMemory.Search (memory/file_memory.go:205-267) 返回 []SearchResult，
//   其字段为 {file, line, content, score}（file_memory.go:270-275），
//   完全不含 id / type / source / created_at。
// 前端 src/api/memory.ts:177-183 把 results 声明为 MemoryEntry[]，
//   MemoryView.vue:544-563 渲染时访问 result.id（:key）、result.type、result.created_at。
// 结果：搜索结果项 id/type/created_at 全为 undefined：
//   - :key="undefined" → Vue 重复 key 警告；
//   - TYPE_COLORS[undefined] 落 accent 兜底；
//   - i18n t('memory.type.undefined') 渲染字面量 "undefined"。
// ════════════════════════════════════════════════════════════════════
describe('B-1 memory/search 结果形状与 MemoryEntry 契约不一致', () => {
  it('[RED 预期失败] 后端 line-level SearchResult 无法满足前端 MemoryEntry 渲染契约', async () => {
    // 模拟后端真实返回（file_memory.go SearchResult 形状）
    mockApiGet.mockResolvedValueOnce({
      results: [
        { file: 'MEMORY.md', line: 7, content: '用户喜欢喝美式', score: 1 },
        { file: 'MEMORY.md', line: 9, content: '用户在杭州', score: 0.5 },
      ],
      vector_results: null,
      total: 2,
    })

    const res = await searchMemory('用户')
    const first = res.results[0] as MemoryEntry

    // MemoryView.vue:545/556/563 渲染所依赖的字段——正确契约下应当存在。
    // 后端只给 {file,line,content,score}，故以下断言全 RED，坐实对齐缺口。
    expect(first.id, 'searchResults :key 需要 id，否则 Vue 重复 key 警告').toBeTruthy()
    expect(first.type, 'TYPE_COLORS / i18n memory.type.* 需要 type').toBeTruthy()
    expect(first.created_at, 'formatTime(result.created_at) 需要时间字段').toBeTruthy()
  })

  it('[证据] 后端 search 元素含 file/line/score（非记忆条目语义），前端类型未覆盖', async () => {
    mockApiGet.mockResolvedValueOnce({
      results: [{ file: 'MEMORY.md', line: 7, content: 'x', score: 1 }],
      vector_results: null,
      total: 1,
    })
    const res = await searchMemory('x')
    const raw = res.results[0] as unknown as Record<string, unknown>
    // 后端实际下发 file/line —— 这些字段在 MemoryEntry 类型里根本不存在
    expect(raw.file).toBe('MEMORY.md')
    expect(raw.line).toBe(7)
    // content 是唯一对齐的字段
    expect(raw.content).toBe('x')
  })
})

// ════════════════════════════════════════════════════════════════════
// B-2 [中][对齐] knowledge/search 包裹键：后端只发 "results"，前端测试断言旧 "result"
//
// 后端 hexclaw/api/handler_knowledge.go:319-323（注释 "Fix 16"）已显式移除
//   冗余的 "result" 字段，只返回 {results, total}。
// 前端 src/api/knowledge.ts:265-267 读 response.result ?? response.results，
//   两键都兼容——运行时 OK。
// 但既有测试 src/api/__tests__/knowledge.test.ts:79-84/87-93/103 仍 mock 旧 "result"
//   键，并未覆盖后端真实的 "results" 键。下测以「后端真实包裹键」取证：
//   前端必须能从 results（复数）正确解析。
// ════════════════════════════════════════════════════════════════════
describe('B-2 knowledge/search 包裹键与后端 Fix 16 对齐', () => {
  it('[证据/GREEN] 前端能解析后端真实的 "results"（复数）包裹键', async () => {
    // handler_knowledge.go:320-323 的真实形状
    mockApiPost.mockResolvedValueOnce({
      results: [
        { content: 'hit-a', score: 0.9, doc_id: 'd1', chunk_index: 0 },
        { content: 'hit-b', score: 0.8, doc_id: 'd1', chunk_index: 1 },
      ],
      total: 2,
    })
    const { result } = await searchKnowledge('q', 5)
    expect(result).toHaveLength(2)
    expect(result[0]!.content).toBe('hit-a')
    expect(result[0]!.doc_id).toBe('d1')
  })

  it('[证据] 既有 knowledge.test.ts 用旧 "result" 键，与后端 Fix 16 不符（回归风险）', async () => {
    // 若后端某天严格化为只发 results，仅 mock "result" 的旧测试将给出假阳性的"通过"。
    // 这里同时验证：前端在「只有 results」时也能工作（防回归锚点）。
    mockApiPost.mockResolvedValueOnce({ results: 'plain string result', total: 1 })
    const { result } = await searchKnowledge('q')
    expect(result).toHaveLength(1)
    expect(result[0]!.content).toBe('plain string result')
  })
})

// ════════════════════════════════════════════════════════════════════
// B-3 [已解决·砍薄版 §5] 旧「两套记忆系统」（单数 /memory FileMemory + 复数 /memories 薄版）
// 的命名混淆已消除：记忆薄版（library.MemoryStore + /api/v1/memories + prompts.ts 的 UserMemory）
// 整体移除并迁入统一文件记忆。本测试守住「不回归」：prompts.ts 不得再导出任何记忆 API，
// 唯一记忆系统 = memory.ts（单数 /api/v1/memory，FileMemory 形状）。
// ════════════════════════════════════════════════════════════════════
describe('B-3 砍薄版后唯一记忆系统 = FileMemory（薄版命名混淆已消除）', () => {
  it('[不回归] prompts.ts 不再导出记忆薄版 API（getMemories/upsertMemory/deleteMemory/UserMemory）', () => {
    expect('getMemories' in promptsApi).toBe(false)
    expect('upsertMemory' in promptsApi).toBe(false)
    expect('deleteMemory' in promptsApi).toBe(false)
  })

  it('[证据] 唯一记忆路径 /api/v1/memory 走 FileMemory 形状（type/source/hit_count/status）', async () => {
    mockApiGet.mockResolvedValueOnce({
      entries: [
        { id: 'm-7', content: 'a', type: 'fact', source: 'manual', created_at: '', updated_at: '', hit_count: 0, status: 'active' },
      ],
      summary: '',
      capacity: { used: 1, max: 200 },
      total: 1,
      has_more: false,
    })
    const fileMem = await getMemoryEntries()
    expect(fileMem.entries[0]).toHaveProperty('type')
    expect(fileMem.entries[0]).toHaveProperty('source')
    expect(mockApiGet).toHaveBeenNthCalledWith(1, '/api/v1/memory')
  })
})

// ════════════════════════════════════════════════════════════════════
// B-4 [低][边界] searchMemory 不传 limit/topK；vector 搜索后端硬编码 topK=5
//
// 前端 src/api/memory.ts:177-183 仅传 { q }，无 limit/top_k。
// 后端 handler_misc.go:158-194：FileMemory 关键词上限硬编码 maxResults=100
//   (file_memory.go:262)，VectorMemory 硬编码 topK=5 (handler_misc.go:178)。
// 即前端无法控制返回条数；超长记忆库时关键词最多 100、语义最多 5，静默截断无提示。
// ════════════════════════════════════════════════════════════════════
describe('B-4 searchMemory 无法控制返回条数（静默截断边界）', () => {
  it('[证据] searchMemory 只发送 q 参数，不传 limit/top_k', async () => {
    mockApiGet.mockResolvedValueOnce({ results: [], vector_results: [], total: 0 })
    await searchMemory('hello world')
    expect(mockApiGet).toHaveBeenCalledWith('/api/v1/memory/search', { q: 'hello world' })
    // 证明：调用参数里既无 limit 也无 top_k —— 条数完全由后端硬编码决定
    const callArgs = mockApiGet.mock.calls[0]![1] as Record<string, unknown>
    expect(callArgs).not.toHaveProperty('limit')
    expect(callArgs).not.toHaveProperty('top_k')
  })
})

// ════════════════════════════════════════════════════════════════════
// B-5 [低][边界] 空 query：前端不拦截，依赖后端 400
//
// searchMemory('') 仍会发起请求；后端 handler_misc.go:160-164 对空 q 返回 400。
// searchKnowledge('') 同理会 POST，后端 handler_knowledge.go:299-303 返回 400。
// 即前端没有空 query 短路，会产生无意义的网络往返（轻微）。
// ════════════════════════════════════════════════════════════════════
describe('B-5 空 query 前端不短路（依赖后端 400）', () => {
  it('[证据] searchMemory("") 仍发起请求', async () => {
    mockApiGet.mockResolvedValueOnce({ results: [], vector_results: [], total: 0 })
    await searchMemory('')
    expect(mockApiGet).toHaveBeenCalledWith('/api/v1/memory/search', { q: '' })
  })

  it('[证据] searchKnowledge("") 仍 POST（无客户端空值拦截）', async () => {
    mockApiPost.mockResolvedValueOnce({ results: [], total: 0 })
    await searchKnowledge('')
    expect(mockApiPost).toHaveBeenCalledWith('/api/v1/knowledge/search', { query: '', top_k: 3 })
  })
})

// ════════════════════════════════════════════════════════════════════
// B-6 [中][安全/边界] 文档 ID 特殊字符编码 —— 前端编码 OK，但 Go ServeMux 会再次解码
//
// 前端 knowledge.ts:155/220/273 与 memory.ts:117/135/156/161 均用
//   encodeURIComponent(id)。对含 '/' 的 id，编码为 %2F。
// 关注点：Go net/http ServeMux 的 {id} PathValue 在路由匹配阶段对路径做
//   清洗/解码——含已编码 %2F 的路径段在不同 Go 版本下行为不一致，
//   可能匹配不到 /documents/{id} 或把 %2F 当作真实分隔符。
// 取证：固定前端编码行为（id 含 '/' 与空格时正确百分号编码），
//   把"后端能否正确还原"标记为存疑候选（需后端集成测试，非前端单测可证）。
// ════════════════════════════════════════════════════════════════════
describe('B-6 文档/记忆 ID 特殊字符前端编码', () => {
  it('[证据] getDocument 对含 / 和空格的 id 做 encodeURIComponent', async () => {
    mockApiGet.mockResolvedValueOnce({ id: 'a/b c', title: 't', chunk_count: 0, created_at: '' })
    await getDocument('a/b c')
    expect(mockApiGet).toHaveBeenCalledWith('/api/v1/knowledge/documents/a%2Fb%20c')
  })

  it('[证据] reindexDocument 对含特殊字符 id 做编码', async () => {
    mockApiPost.mockResolvedValueOnce({ status: 'indexed', chunk_count: 1 })
    await reindexDocument('id with#hash')
    expect(mockApiPost).toHaveBeenCalledWith('/api/v1/knowledge/documents/id%20with%23hash/reindex')
  })

  it('[证据] archive/restore 对含特殊字符 id 做编码', async () => {
    mockApiPost.mockResolvedValue({ message: 'ok' })
    await archiveMemoryEntry('m/1')
    await restoreMemoryEntry('m 2')
    expect(mockApiPost).toHaveBeenNthCalledWith(1, '/api/v1/memory/m%2F1/archive')
    expect(mockApiPost).toHaveBeenNthCalledWith(2, '/api/v1/memory/m%202/restore')
  })
})

// ════════════════════════════════════════════════════════════════════
// B-7 [低][边界] 空知识库 / nil slice
//
// 后端 handler_knowledge.go:199-207（Fix 14）已把 nil docs 兜底为 []，
//   返回 {documents: [], total: 0}。前端 getDocuments() 直接消费。
// 取证：前端在空库下不崩溃，total=0、documents=[]。
// ════════════════════════════════════════════════════════════════════
describe('B-7 空知识库边界', () => {
  it('[证据/GREEN] searchKnowledge 对空 results 返回空数组（不抛错）', async () => {
    mockApiPost.mockResolvedValueOnce({ results: [], total: 0 })
    const { result } = await searchKnowledge('nothing')
    expect(result).toEqual([])
  })

  it('[证据/GREEN] searchKnowledge 对 results=undefined（极端兜底）返回空数组', async () => {
    mockApiPost.mockResolvedValueOnce({})
    const { result } = await searchKnowledge('nothing')
    expect(result).toEqual([])
  })
})

// ════════════════════════════════════════════════════════════════════
// B-8 [低][对齐] reindex 响应 status 类型放任
//
// 后端 handler_knowledge.go:274-280 返回 status = doc.Status（始终 "indexed"，
//   knowledge.go:324）。前端 KnowledgeView.vue:301 直接
//   (result.status as KnowledgeDoc['status']) —— 强制断言为联合类型，
//   若后端将来返回 "ok"/"failed" 之外的值，TS 类型谎报，无运行时校验。
// 取证：reindexDocument 透传后端任意 status 字符串，前端不做白名单校验。
// ════════════════════════════════════════════════════════════════════
describe('B-8 reindex status 透传无白名单校验', () => {
  it('[证据] reindexDocument 原样返回后端 status，即便是非法枚举值', async () => {
    mockApiPost.mockResolvedValueOnce({ status: 'totally-unknown', chunk_count: 3, updated_at: '2026-06-21' })
    const res = await reindexDocument('d1')
    // 前端无运行时校验，'totally-unknown' 会被 KnowledgeView 强转进 KnowledgeDoc.status
    expect(res.status).toBe('totally-unknown')
  })
})
