/**
 * 域：桌面端运行时逻辑缺陷取证（2026-06-22 复审）
 *
 * 本文件是「挑刺 code review」的 RED 取证集——每条断言「期望的正确行为」，
 * 在当前实现下失败（RED），用以钉死真实运行时 bug，待修复后转 GREEN。
 * 所有发现均经真实读码定位（标注 file:line）+ 后端契约/纯函数验证，非静态猜测。
 *
 * 覆盖：
 *   A  utils/assistant-reply.ts:22-30   正文字面 </think> 误截断
 *   B  utils/chat-automation.ts:233     「晚上/夜里 0 点」错算为中午（午夜偏 12h）
 *   C  utils/chat-automation.ts:154     cron 五字段正则误匹配散文数字 → 生成非法 cron
 *   D  stores/logs.ts:74-95             disconnect() 后僵尸重连（无主动关闭标志）
 *   E  composables/useHexclaw.ts:27     退避 `=== 6` 一次性触发，30s 上限是死代码
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { normalizeAssistantContent } from '@/utils/assistant-reply'
import { buildConversationAutomationActions } from '@/utils/chat-automation'

// ════════════════════════════════════════════════════════════
// A. assistant-reply.ts — 正文内字面 </think> 之前的内容被静默丢弃
//    当 reasoning 非空且正文合法地包含字面 </think>（如讲解思考标签写法、
//    粘贴含该标签的 XML/代码），normalizeAssistantContent 把第一个 </think>
//    及其之前的所有内容当成「泄漏的思考」整段砍掉 → 回答被腰斩。
// ════════════════════════════════════════════════════════════
describe('A [P2] assistant-reply: 正文字面 </think> 误截断', () => {
  it('reasoning 非空时，正文里讲解 </think> 用法的前半句不应被丢弃', () => {
    const content = '思考标签写法：在 <think> 与 </think> 之间填写推理。这就是语法。'
    const out = normalizeAssistantContent(content, '一些真实的思考过程')
    // 当前实现返回「之间填写推理。这就是语法。」，前半句连同 <think> 全丢
    expect(out).toContain('思考标签写法')
  })
})

// ════════════════════════════════════════════════════════════
// B. chat-automation.ts:233 — 「晚上0点 / 夜里0点」被 +12 误算为中午
//    period ∈ {下午,晚上,夜里,傍晚} 且 hour<12 时无条件 +12；hour=0（午夜）
//    被推成 12（中午），生成的 cron 偏 12 小时。
// ════════════════════════════════════════════════════════════
describe('B [P1] chat-automation: 晚上/夜里 0 点应为午夜而非中午', () => {
  it('「每天晚上0点」应生成 `0 0 * * *`（午夜）', () => {
    const actions = buildConversationAutomationActions({
      userText: '创建每天晚上0点执行的清理定时任务',
      sourceMessageId: 'm1',
    })
    const task = actions.find((a) => a.kind === 'create_task')
    expect(task).toBeTruthy()
    // 当前实现生成 `0 12 * * *`（中午），把用户的午夜排到了 12 小时后
    expect((task as { payload: { schedule: string } }).payload.schedule).toBe('0 0 * * *')
  })
})

// ════════════════════════════════════════════════════════════
// C. chat-automation.ts:154 — cron 五字段正则误匹配散文里的数字
//    /\b(?:[\d*\/,?-]+\s+){4}[\d*\/,?-]+\b/ 命中任意 5 组空格分隔数字，
//    把「2026 6 22 15 30」当 cron，生成 minute=2026（>59）的非法表达式。
// ════════════════════════════════════════════════════════════
describe('C [P2] chat-automation: 散文数字不应被当成 cron', () => {
  it('「创建定时任务 2026 6 22 15 30 开会」不应产出非法 cron（minute>59）', () => {
    const actions = buildConversationAutomationActions({
      userText: '创建定时任务 2026 6 22 15 30 开会提醒',
      sourceMessageId: 'm1',
    })
    const task = actions.find((a) => a.kind === 'create_task') as
      | { payload: { schedule: string } }
      | undefined
    // 修复后：散文数字不再被当 cron → 不产出 create_task（无其它 schedule 匹配），minute 取 0。
    // 修复前：schedule = '2026 6 22 15 30'，minute=2026 是非法 cron（>59）。
    const minute =
      task && /^\d/.test(task.payload.schedule) ? Number(task.payload.schedule.split(/\s+/)[0]) : 0
    expect(minute).toBeLessThanOrEqual(59)
  })
})

// ════════════════════════════════════════════════════════════
// D. stores/logs.ts — 主动 disconnect() 后 onclose 仍调度重连（僵尸连接）
//    disconnect() 未置 ws.onclose=null、无「主动关闭」标志、setTimeout 句柄
//    不保存。用户离开日志页后，后台仍重新打开 WebSocket。
//    对照 composables/useWebSocket.ts（disconnect 时置 onclose=null）做对了。
// ════════════════════════════════════════════════════════════
describe('D [P1] logs store: disconnect() 后不应僵尸重连', () => {
  const fakeWs: { onopen: (() => void) | null; onclose: (() => void) | null; close: ReturnType<typeof vi.fn> } = {
    onopen: null,
    onclose: null,
    close: vi.fn(),
  }
  const connectLogStream = vi.fn(() => {
    fakeWs.onopen = null
    fakeWs.onclose = null
    fakeWs.close = vi.fn()
    return fakeWs as unknown as WebSocket
  })

  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    setActivePinia(createPinia())
    connectLogStream.mockClear()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('disconnect() 之后浏览器触发 onclose，不应再调度 connect 重连', async () => {
    vi.doMock('@/api/logs', () => ({
      connectLogStream,
      getLogs: vi.fn().mockResolvedValue({ logs: [] }),
      getLogStats: vi.fn().mockResolvedValue({ total: 0, by_level: {}, by_source: {} }),
    }))
    const { useLogsStore } = await import('@/stores/logs')
    const store = useLogsStore()

    store.connect()
    expect(connectLogStream).toHaveBeenCalledTimes(1)

    store.disconnect()
    connectLogStream.mockClear()

    // 模拟浏览器在 close() 后异步触发 onclose（handler 未被 disconnect 解绑）
    fakeWs.onclose?.()
    vi.advanceTimersByTime(5000)

    // 用户已主动断开，不应有后台重连
    expect(connectLogStream).not.toHaveBeenCalled()
  })
})

// ════════════════════════════════════════════════════════════
// E. composables/useHexclaw.ts:27 — 退避 `if (retryCount === 6)` 一次性
//    严格等号只在恰好第 6 次失败触发一次（5s→10s），之后永不再升；
//    Math.min(currentInterval*2, 30000) 到 30s 的逻辑是死代码。
//    注释承诺「连续失败后降低轮询频率」，实际只降一次。
// ════════════════════════════════════════════════════════════
describe('E [P2] useHexclaw: 持续失败应退避到 >10s（当前一次性封顶 10s）', () => {
  beforeEach(() => {
    vi.resetModules()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('连续 15 次健康检查失败后，轮询间隔应能退避超过 10000ms', async () => {
    vi.doMock('@/api/client', () => ({
      checkHealth: vi.fn().mockResolvedValue(false),
    }))
    const setIntervalSpy = vi
      .spyOn(globalThis, 'setInterval')
      .mockReturnValue(0 as unknown as ReturnType<typeof setInterval>)
    const { useHexclaw } = await import('@/composables/useHexclaw')
    const { check } = useHexclaw()

    for (let i = 0; i < 15; i++) await check()

    const delays = setIntervalSpy.mock.calls.map((c) => Number(c[1] ?? 0))
    const maxDelay = delays.length ? Math.max(...delays) : 0
    // 当前实现只在 retryCount===6 设过一次 10000，永远到不了 30000
    expect(maxDelay).toBeGreaterThan(10000)
  })
})
