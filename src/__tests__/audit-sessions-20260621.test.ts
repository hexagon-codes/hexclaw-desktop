/**
 * 域A 会话/聊天/流式 — 挑刺式审查取证（只读审查 + 只写测试，不改生产源码）
 *
 * 审查范围：src/api/client.ts (apiSSE) / src/api/chat.ts / src/stores/chat-session-*.ts /
 *           src/components/chat/SessionList.vue
 * 后端对照：/Users/hexagon/work/hexclaw/api/handler_session.go / api/server.go
 *
 * 约定：
 *   - 逻辑/边界 bug → 断言"正确行为"，让它 RED（失败输出即证据）。
 *   - 未闭环 → 证明"前端调用后端没有的路由" 或 "后端有路由但前端/UI 从不调用"。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { execSync } from 'node:child_process'

const FE = (rel: string) => resolve(__dirname, '..', rel)
const BE = (rel: string) => resolve(__dirname, '../../../hexclaw', rel)
const read = (p: string) => readFileSync(p, 'utf8')
// hexclaw 后端仓库（本地兄弟目录）；前端-only CI 无此目录 → 跨仓审计套件整体跳过，避免 ENOENT。
const describeBE = existsSync(resolve(__dirname, '../../../hexclaw')) ? describe : describe.skip

// ════════════════════════════════════════════════════════════════════
// Finding A1 [P1][边界] apiSSE 不处理 CRLF (\r\n) 行结尾
//   client.ts:156 `lineBuffer.split('\n')` 只按 \n 切；SSE 规范允许 \r\n。
//   若上游/代理用 CRLF：
//     - data === '[DONE]' 实际是 '[DONE]\r' → 永不匹配 → 流不会因 [DONE] 关闭
//     - 普通 data 行带尾随 \r → enqueue 出的字符串末尾含 \r，JSON.parse 仍可过
//       但下游若做 === 比较 / 拼接会被污染。
// ════════════════════════════════════════════════════════════════════

function mockFetchSSE(chunks: string[]) {
  const encoder = new TextEncoder()
  let idx = 0
  const reader = {
    read: vi.fn().mockImplementation(() => {
      if (idx < chunks.length) {
        return Promise.resolve({ done: false, value: encoder.encode(chunks[idx++]!) })
      }
      return Promise.resolve({ done: true, value: undefined })
    }),
  }
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, body: { getReader: () => reader } }),
  )
}

async function drainSSE(url = '/test'): Promise<string[]> {
  const { apiSSE } = await import('@/api/client')
  const stream = await apiSSE(url)
  const reader = stream.getReader()
  const out: string[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    out.push(value)
  }
  return out
}

describeBE('Finding A1 [P1][边界] apiSSE — CRLF (\\r\\n) 行结尾未处理', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
    vi.doMock('@/config/env', () => ({
      env: { apiBase: 'http://test:9999', wsBase: 'ws://test:9999', isDev: false, timeout: 30000, logLevel: 'warn' },
    }))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('@/config/env')
  })

  it('正确行为：CRLF 分隔的 data 行 enqueue 的内容不应含尾随 \\r', async () => {
    mockFetchSSE(['data: {"content":"hi"}\r\n', 'data: [DONE]\r\n'])
    const results = await drainSSE()
    // 期望：只 enqueue 一条干净 JSON。若带 \r，下面断言会 RED。
    expect(results).toHaveLength(1)
    expect(results[0]).toBe('{"content":"hi"}') // 实际会是 '{"content":"hi"}\r'
    expect(results[0]!.includes('\r')).toBe(false)
  })

  it('正确行为：CRLF 的 [DONE] 应被识别（data 段不含尾随 \\r 才会等于 "[DONE]"）', async () => {
    // [DONE] 之后再塞一条数据。若 [DONE]\r 不被识别为终止，下游会多收到一条本不该出现的数据。
    mockFetchSSE(['data: [DONE]\r\n', 'data: {"leaked":true}\r\n'])
    const results = await drainSSE()
    // 期望：[DONE] 终止流，[leaked] 不应被 enqueue。
    expect(results).toHaveLength(0) // 实际会拿到 1 条泄漏数据（[DONE]\r 未匹配）
  })
})

// ════════════════════════════════════════════════════════════════════
// Finding A2 [P1][边界] apiSSE 末行无换行符时丢数据
//   client.ts:151-153 done 时直接 controller.close()，不 flush lineBuffer。
//   若最后一条 `data: ...` 没有以 \n 结尾就到了 done，整条数据被丢弃。
//   真实场景：服务端正常结束但最后一行未换行 / 网络分片刚好截在末行。
// ════════════════════════════════════════════════════════════════════

describeBE('Finding A2 [P1][边界] apiSSE — 末行无 \\n 时数据被丢弃', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
    vi.doMock('@/config/env', () => ({
      env: { apiBase: 'http://test:9999', wsBase: 'ws://test:9999', isDev: false, timeout: 30000, logLevel: 'warn' },
    }))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('@/config/env')
  })

  it('正确行为：最后一条 data 行未带 \\n 也应被解析（而非丢失/挂起）', async () => {
    // 没有 [DONE]，靠 reader done 收尾；最后一条无换行。
    mockFetchSSE(['data: {"content":"first"}\n', 'data: {"content":"last-no-nl"}'])
    const { apiSSE } = await import('@/api/client')
    const stream = await apiSSE('/test')
    const reader = stream.getReader()
    const results: string[] = []

    // 用超时哨兵把"挂起"变成可断言信号：每次 read 若 300ms 内不解析，记为 STALL。
    const TIMEOUT = Symbol('stall')
    const readOrStall = () =>
      Promise.race([
        reader.read(),
        new Promise<typeof TIMEOUT>((r) => setTimeout(() => r(TIMEOUT), 300)),
      ])

    let stalled = false
    for (let i = 0; i < 5; i++) {
      const res = await readOrStall()
      if (res === TIMEOUT) { stalled = true; break } // read() 永不解析 = 末行被吞 + 流未收尾
      if (res.done) break
      results.push(res.value)
    }

    // 正确行为：应拿到两条且不挂起。当前实现：第二条被吞，且 read() 挂起 → stalled=true、results 只有 1 条。
    expect(stalled).toBe(false) // RED：实际 true
    expect(results.map((r) => JSON.parse(r).content)).toEqual(['first', 'last-no-nl'])
  })
})

// ════════════════════════════════════════════════════════════════════
// Finding A3 [P2][未闭环] forkSession / getSessionBranches 后端有路由、
//   前端有 API 封装，但 store/component/composable/view 从无任何调用。
//   后端：api/server.go 注册 POST .../fork、GET .../branches、GET .../checkpoints
//   前端：api/chat.ts 导出 forkSession / getSessionBranches，但无生产消费方；
//         checkpoints 连前端 API 封装都没有。
//   => 会话分支/fork/检查点功能在桌面端从 UI 不可达（dead path）。
// ════════════════════════════════════════════════════════════════════

describeBE('Finding A3 [P2][未闭环] 会话分支/fork/checkpoints UI 不可达', () => {
  // 用源码静态扫描证明：除 api/chat.ts 与 __tests__ 外，无任何 .ts/.vue 引用这些 API。
  const SRC = resolve(__dirname, '..')

  function grepProductionRefs(symbol: string): string[] {
    // 递归扫描 src 下非测试文件
    let out = ''
    try {
      out = execSync(
        `grep -rln --include='*.ts' --include='*.vue' "${symbol}" "${SRC}"`,
        { encoding: 'utf8' },
      )
    } catch {
      out = '' // grep exit 1 = no matches
    }
    return out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((p) => !p.includes('__tests__'))
      .filter((p) => !p.endsWith(`api/chat.ts`)) // 定义处不算消费方
  }

  it('后端确实注册了 fork / branches / checkpoints 三条路由', () => {
    const server = read(BE('api/server.go'))
    expect(server).toContain('/api/v1/sessions/{id}/fork')
    expect(server).toContain('/api/v1/sessions/{id}/branches')
    expect(server).toContain('/api/v1/sessions/{id}/checkpoints')
  })

  // ⚠️ A3 重分类（2026-06-22）：会话分支/fork/检查点是「未建功能」而非 bug。
  // 原型 app.html:828 明确「分支 / 合并（非线性 DAG）后续版本评估」——当前版本主动推迟，
  // 故不实现（实现违反原型决策，塞假消费方喂 grep 测试更是反模式）。以 it.todo 标记为待办：
  // 后续版本真正落地 UI 消费方 / checkpoints API 封装时，把 .todo 去掉即恢复为闭环 tripwire。
  it.todo('forkSession 应有 UI 生产消费方 — 待会话分支功能落地（原型 app.html:828 推迟至后续版本）', () => {
    const refs = grepProductionRefs('forkSession')
    expect(refs).not.toEqual([])
  })

  it.todo('getSessionBranches 应有 UI 生产消费方 — 待会话分支功能落地（原型推迟）', () => {
    const refs = grepProductionRefs('getSessionBranches')
    expect(refs).not.toEqual([])
  })

  it.todo('checkpoints 应有前端 API 封装 — 待会话检查点功能落地（原型推迟）', () => {
    const chatApi = read(FE('api/chat.ts'))
    expect(/checkpoint/i.test(chatApi)).toBe(true)
  })
})

// ════════════════════════════════════════════════════════════════════
// Finding A4 [P2][逻辑] SessionList 重命名只查 chatStore.sessions，
//   "加载更多"得到的 extraSessions（不在 chatStore.sessions 里）无法重命名。
//   SessionList.vue:
//     - loadMoreSessions:328 只把"不在 chatStore.sessions"的会话放进 extraSessions
//     - startRename:236-237  const session = chatStore.sessions.find(...); if (!session) return
//     - commitRename:257     const session = chatStore.sessions.find(...); 本地标题不更新
//   => 双击/右键重命名一个仅来自分页加载的旧会话：startRename 直接 return（无输入框弹出），
//      即便 backend 改名成功本地 extraSessions 也不刷新。
// ════════════════════════════════════════════════════════════════════

describeBE('Finding A4 [P2][逻辑] SessionList 重命名对 extraSessions（分页加载）会话失效', () => {
  const SRC = read(FE('components/chat/SessionList.vue'))

  it('loadMoreSessions 只把"不在 chatStore.sessions"的会话放进 extraSessions', () => {
    // 证明 extraSessions 与 chatStore.sessions 互斥
    expect(SRC).toContain('extraSessions')
    expect(SRC).toMatch(/!chatStore\.sessions\.some\(\(existing\) => existing\.id === session\.id\)/)
  })

  it('startRename 仅在 chatStore.sessions 中查找 → extraSessions-only 会话无法进入重命名', () => {
    const start = SRC.slice(SRC.indexOf('function startRename'), SRC.indexOf('function commitRename'))
    expect(start).toContain('chatStore.sessions.find')
    expect(start).toMatch(/if \(!session\) return/)
    // 正确行为：应同时考虑 extraSessions / mergedSessions。当前实现不含 mergedSessions 即证明缺陷。
    expect(start.includes('mergedSessions') || start.includes('extraSessions')).toBe(true) // RED
  })

  it('commitRename 写回本地标题也只查 chatStore.sessions（extraSessions 标题不刷新）', () => {
    const commit = SRC.slice(SRC.indexOf('async function commitRename'), SRC.indexOf('function cancelRename'))
    expect(commit).toContain('chatStore.sessions.find')
    // 正确行为：应更新 extraSessions / mergedSessions 中的对应项。当前未涉及即证明缺陷。
    expect(commit.includes('mergedSessions') || commit.includes('extraSessions')).toBe(true) // RED
  })
})

// ════════════════════════════════════════════════════════════════════
// Finding A5 [P2][对齐] getSessionBranches 返回类型声明为 ChatSession[]，
//   后端返回的是 storage.Session（含 user_id / parent_session_id / status 等，
//   且字段集与 ChatSession 不同），且响应还带顶层 total 字段。
//   api/chat.ts:222-224 声明 `{ branches: ChatSession[] }`，
//   后端 handleListBranches 返回 `{ branches: []*storage.Session, total }`。
//   ChatSession 缺 user_id/parent_session_id；类型契约与后端 JSON 不符。
// ════════════════════════════════════════════════════════════════════

describeBE('Finding A5 [P2][对齐] getSessionBranches 类型契约 vs 后端 JSON 不符', () => {
  it('后端 branches 元素是 storage.Session（带 user_id/parent_session_id），响应含 total', () => {
    const handler = read(BE('api/handler_session.go'))
    const block = handler.slice(handler.indexOf('func (s *Server) handleListBranches'))
    expect(block).toContain('"branches": branches')
    expect(block).toContain('"total":    len(branches)')
    // storage.Session 带 user_id / parent_session_id（见 storage struct json tag）
    const chatApi = read(FE('api/chat.ts'))
    const fn = chatApi.slice(chatApi.indexOf('function getSessionBranches'), chatApi.indexOf('function getSessionBranches') + 220)
    // 前端把元素类型声明成 ChatSession（缺 user_id/parent_session_id），且未声明 total
    expect(fn).toContain('branches: ChatSession[]')
    const chatTypes = read(FE('types/chat.ts'))
    const sessIface = chatTypes.slice(chatTypes.indexOf('interface ChatSession'), chatTypes.indexOf('interface ChatSession') + 260)
    // ChatSession 不含 user_id（单用户桌面无需暴露）→ 与后端 storage.Session 字段集仍有差
    expect(sessIface.includes('user_id')).toBe(false)
    // BUG-20260703 P2-1：fork UI 落地后 ChatSession 已含 parent_session_id（分支徽标数据源，
    // messageService.loadAllSessions 透传）——本 Finding 的字段缺口已收窄一半。
    expect(sessIface.includes('parent_session_id')).toBe(true)
    // 正确行为：返回类型应使用含 user_id/parent_session_id 的 SessionSummary 且带 total。
    // 下面断言期望前端契约对齐后端，当前不对齐 → RED。
    expect(fn).toContain('total') // RED：getSessionBranches 未声明 total
  })
})
