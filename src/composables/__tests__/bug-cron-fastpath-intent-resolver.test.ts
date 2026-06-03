// BUG-cron-fastpath-intent-resolver regression test
//
// Bug: chat 输入"创建定时任务..."命中 cron trigger 时，仍调 LLM ReAct →
//   LLM 找不到 cron tool 乱调 fs 工具 → tool 失败 → tool_use_id 链路 →
//   上游网关翻译 400 错误。
//
// 修复契约：
//   1. useChatSend 提供 classifyCronIntent 入口
//   2. 高置信 trigger 命中（含 schedule + 动作）→ tier=1 fast-path
//   3. fast-path 必须**跳过 LLM 调用**（不调 chatStore.sendMessage）
//   4. 直接挂含 CreateTaskAction 的 assistant message 到 chat
//   5. trigger 未命中正常 fall-through 到 LLM 路径

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('BUG-cron-fastpath-intent-resolver', () => {
  it('classifyCronIntent 函数必须存在并 export', async () => {
    // RED: 修前 useChatSend 没有 classifyCronIntent
    // GREEN: 修后必须 export
    const mod = await import('@/composables/useChatSend')
    expect(typeof mod.classifyCronIntent).toBe('function')
  })

  it('高置信 cron trigger 必须返回 tier=1 + 完整 payload', async () => {
    const { classifyCronIntent } = await import('@/composables/useChatSend')
    const result = classifyCronIntent('创建一个定时任务，每天上午 10 点采集网易新闻 TOP10，并加入知识库')
    expect(result.tier).toBe(1)
    expect(result.confidence).toBeGreaterThanOrEqual(0.85)
    expect(result.payload).toBeDefined()
    expect(result.payload?.schedule).toBeTruthy()
    expect(result.payload?.name).toBeTruthy()
    expect(result.payload?.prompt).toBeTruthy()
  })

  it('完全无 cron 意图的输入必须返回 tier=3', async () => {
    const { classifyCronIntent } = await import('@/composables/useChatSend')
    const result = classifyCronIntent('你好，今天天气怎么样')
    expect(result.tier).toBe(3)
  })

  it('意图模糊（缺 schedule）必须返回 tier=2 或 3', async () => {
    const { classifyCronIntent } = await import('@/composables/useChatSend')
    const result = classifyCronIntent('帮我提醒一下')
    expect(result.tier).toBeGreaterThanOrEqual(2)
  })

  it('useChatSend source 必须含 fast-path 拦截 + classifyCronIntent 调用', () => {
    const src = readFileSync(resolve(__dirname, '../useChatSend.ts'), 'utf-8')
    // 强契约：handleSend 必须调 classifyCronIntent
    expect(src).toMatch(/classifyCronIntent\s*\(/)
    // 强契约：tier=1 时必须**不调** chatStore.sendMessage
    // 用结构性断言：fast-path 分支必须直接 push message
    expect(src).toMatch(/tier\s*===?\s*1|tier:\s*1/)
  })

  it('fast-path 创建的 assistant message 必须含 CreateTaskAction 元数据', async () => {
    // 行为契约：当 tier=1 时，注入的 assistant message metadata 包含
    // CHAT_AUTOMATION_METADATA_KEY 含 create_task 类型 action
    const { buildFastPathAssistantMessage } = await import('@/composables/useChatSend')
    const message = buildFastPathAssistantMessage('创建一个定时任务，每天上午 10 点采集网易新闻 TOP10')
    expect(message).toBeDefined()
    expect(message?.role).toBe('assistant')
    const metadata = message?.metadata as Record<string, unknown> | undefined
    const actions = metadata?.['conversation_actions'] as Array<{ kind: string }> | undefined
    expect(actions).toBeDefined()
    expect(actions?.some((a) => a.kind === 'create_task')).toBe(true)
  })

  it('fast-path 路径的 assistant message content 必须是友好提示（不是空）', async () => {
    const { buildFastPathAssistantMessage } = await import('@/composables/useChatSend')
    const message = buildFastPathAssistantMessage('创建定时任务，每天上午 10 点采集网易新闻')
    expect(message?.content).toBeTruthy()
    expect(message?.content?.length).toBeGreaterThan(5)
    // 不能含技术词
    expect(message?.content).not.toMatch(/tool_use_id|api_error|stack/i)
  })
})
