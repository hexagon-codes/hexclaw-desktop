import { describe, it, expect } from 'vitest'
import { parseSubAgentReports, getSubAgentReports, isSubAgentToolCall } from '@/utils/subagents'
import type { ChatMessage } from '@/types/chat'

/** 模拟后端 engine.encodeSubAgentReports 的输出：markdown 正文 + 尾部哨兵块。 */
function withSentinel(body: string, reports: unknown): string {
  return body + '\n\n```hexclaw-subagents\n' + JSON.stringify(reports) + '\n```'
}

describe('parseSubAgentReports', () => {
  it('解析合法哨兵块', () => {
    const result = withSentinel('## researcher Agent\n…', [
      { agent: 'researcher', status: 'ok', duration: '12.5s', output: '调研结论' },
      { agent: 'coder', status: 'ok', duration: '8.2s', output: '代码方案' },
    ])
    const reports = parseSubAgentReports(result)
    expect(reports).not.toBeNull()
    expect(reports!).toHaveLength(2)
    expect(reports![0]).toMatchObject({ agent: 'researcher', status: 'ok', duration: '12.5s' })
    expect(reports![1]?.output).toBe('代码方案')
  })

  it('无哨兵块返回 null', () => {
    expect(parseSubAgentReports('普通工具结果，无子 Agent')).toBeNull()
    expect(parseSubAgentReports('')).toBeNull()
    expect(parseSubAgentReports(null)).toBeNull()
    expect(parseSubAgentReports(undefined)).toBeNull()
  })

  it('JSON 非法 / 非数组 / 空数组 优雅降级为 null', () => {
    expect(parseSubAgentReports('```hexclaw-subagents\n{bad json\n```')).toBeNull()
    expect(parseSubAgentReports('```hexclaw-subagents\n{"agent":"x"}\n```')).toBeNull()
    expect(parseSubAgentReports('```hexclaw-subagents\n[]\n```')).toBeNull()
  })

  it('过滤缺 agent 字段的脏项', () => {
    const reports = parseSubAgentReports(
      withSentinel('x', [{ status: 'ok' }, { agent: 'coder', status: 'ok' }]),
    )
    expect(reports).toHaveLength(1)
    expect(reports![0]?.agent).toBe('coder')
  })

  it('能容忍超时状态', () => {
    const reports = parseSubAgentReports(
      withSentinel('x', [{ agent: 'slow', status: 'timeout' }]),
    )
    expect(reports![0]?.status).toBe('timeout')
  })

})

describe('getSubAgentReports', () => {
  function msg(tool_calls: ChatMessage['tool_calls']): ChatMessage {
    return { id: 'm1', role: 'assistant', content: '', timestamp: '', tool_calls }
  }

  it('从 orchestrate 工具调用提取', () => {
    const m = msg([
      {
        id: 't1',
        name: 'orchestrate',
        arguments: '{}',
        result: withSentinel('summary', [{ agent: 'researcher', status: 'ok' }]),
      },
    ])
    expect(getSubAgentReports(m)).toHaveLength(1)
  })

  it('从 spawn_agent 工具调用提取', () => {
    const m = msg([
      {
        id: 't1',
        name: 'spawn_agent',
        arguments: '{}',
        result: withSentinel('out', [{ agent: 'coder', status: 'ok' }]),
      },
    ])
    expect(getSubAgentReports(m)).toHaveLength(1)
    expect(getSubAgentReports(m)[0]?.agent).toBe('coder')
  })

  it('多个子 Agent 工具调用按序拼接', () => {
    const m = msg([
      { id: 't1', name: 'orchestrate', arguments: '{}', result: withSentinel('a', [{ agent: 'a', status: 'ok' }]) },
      { id: 't2', name: 'spawn_agent', arguments: '{}', result: withSentinel('b', [{ agent: 'b', status: 'ok' }]) },
    ])
    expect(getSubAgentReports(m).map((r) => r.agent)).toEqual(['a', 'b'])
  })

  it('非子 Agent 工具 / 无 tool_calls 返回空', () => {
    expect(getSubAgentReports(msg([{ id: 't1', name: 'search', arguments: '{}', result: 'x' }]))).toEqual([])
    expect(getSubAgentReports(msg(undefined))).toEqual([])
  })
})

describe('isSubAgentToolCall', () => {
  it('识别 orchestrate / spawn_agent', () => {
    expect(isSubAgentToolCall('orchestrate')).toBe(true)
    expect(isSubAgentToolCall('spawn_agent')).toBe(true)
    expect(isSubAgentToolCall('search')).toBe(false)
    expect(isSubAgentToolCall('transfer_to_agent')).toBe(false)
  })
})
