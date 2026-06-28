import { describe, it, expect } from 'vitest'
import {
  toolCallStatus,
  toolBaseName,
  resolveToolDisplayName,
  summarizeToolResult,
  prettyToolJson,
} from '@/utils/tool-call'
import type { ToolCall } from '@/types/chat'

const tc = (p: Partial<ToolCall>): ToolCall => ({ id: 't', name: 'weather', arguments: '{}', ...p })

describe('toolCallStatus —— 诚实推导，不靠字符串嗅探', () => {
  it('无结果 → running（流式中/未完成）', () => {
    expect(toolCallStatus(tc({ result: undefined }))).toBe('running')
  })

  it('有结果且无错误标记 → success', () => {
    expect(toolCallStatus(tc({ result: '{"temp":27}' }))).toBe('success')
  })

  it('空字符串结果也算返回 → success（不当 running）', () => {
    expect(toolCallStatus(tc({ result: '' }))).toBe('success')
  })

  it('后端显式 is_error → error（向后兼容钩子）', () => {
    expect(toolCallStatus(tc({ result: 'boom', is_error: true }))).toBe('error')
  })

  it('后端显式 status 直接透传', () => {
    expect(toolCallStatus(tc({ result: 'x', status: 'error' }))).toBe('error')
    expect(toolCallStatus(tc({ result: undefined, status: 'success' }))).toBe('success')
  })

  it('结构化错误信封 {error:...} / {is_error:true} → error（结构判定非正则嗅探）', () => {
    expect(toolCallStatus(tc({ result: '{"error":"rate limited"}' }))).toBe('error')
    expect(toolCallStatus(tc({ result: '{"is_error":true,"data":1}' }))).toBe('error')
  })

  it('结果里普通含 error 字样但非错误信封 → 仍 success（不嗅探正文）', () => {
    expect(toolCallStatus(tc({ result: '今天没有 error 风险' }))).toBe('success')
    expect(toolCallStatus(tc({ result: '{"error":""}' }))).toBe('success')
  })

  it('后端工具错误信封（纯串 `Error executing tool "x": ...`）→ error（精确契约前缀，非嗅探）', () => {
    // engine/react.go / runtime_adapters.go: fmt.Sprintf("Error executing tool %q: %s", name, err)
    expect(
      toolCallStatus(
        tc({
          result:
            'Error executing tool "glob": path rejected: path "/Users/hexagon/work" is outside workspace',
        }),
      ),
    ).toBe('error')
    expect(
      toolCallStatus(tc({ result: 'Error executing tool "file_edit": old_string not found' })),
    ).toBe('error')
  })

  it('正文里恰好出现 "Error executing tool" 但非开头 → 不误判（仍按内容走）', () => {
    expect(
      toolCallStatus(tc({ result: '帮助文档：如何处理 Error executing tool 这类报错' })),
    ).toBe('success')
  })
})

describe('toolBaseName —— 剥离 MCP/命名空间前缀，单下划线工具名保留', () => {
  it('MCP 双下划线 mcp__server__tool → tool', () => {
    expect(toolBaseName('mcp__weather__forecast')).toBe('forecast')
    expect(toolBaseName('mcp__weather')).toBe('weather')
  })
  it('冒号/点命名空间 → 末段', () => {
    expect(toolBaseName('server:weather')).toBe('weather')
    expect(toolBaseName('server.weather')).toBe('weather')
  })
  it('单下划线工具名整体保留（manage_mcp_server / spawn_agent）', () => {
    expect(toolBaseName('manage_mcp_server')).toBe('manage_mcp_server')
    expect(toolBaseName('spawn_agent')).toBe('spawn_agent')
  })
  it('裸名原样', () => {
    expect(toolBaseName('weather')).toBe('weather')
  })
})

describe('resolveToolDisplayName —— 卡片永不泄露裸 id', () => {
  const t = (key: string, fallback?: string) => {
    const map: Record<string, string> = {
      'chat.toolName.weather': '天气查询',
      'chat.toolName.search': '网络搜索',
    }
    return map[key] ?? (fallback ?? key)
  }
  it('已知工具 → 本地化名', () => {
    expect(resolveToolDisplayName('weather', t)).toBe('天气查询')
  })
  it('MCP 前缀工具 → 仍解析到本地化名', () => {
    expect(resolveToolDisplayName('mcp__svc__weather', t)).toBe('天气查询')
  })
  it('未知工具 → 退回 base 名（不是完整 i18n key）', () => {
    expect(resolveToolDisplayName('mcp__svc__unknown_tool', t)).toBe('unknown_tool')
  })
})

describe('summarizeToolResult —— schema 无关一行摘要', () => {
  it('空/缺失 → 空串', () => {
    expect(summarizeToolResult(tc({ result: undefined }))).toBe('')
    expect(summarizeToolResult(tc({ result: '   ' }))).toBe('')
  })
  it('JSON 对象 → 标量字段 k: v · k: v', () => {
    const s = summarizeToolResult(tc({ result: '{"city":"杭州","temp":27,"humidity":74}' }))
    expect(s).toContain('city: 杭州')
    expect(s).toContain('temp: 27')
    expect(s).not.toContain('\n')
  })
  it('对象有摘要字段（summary/text/...）→ 直接用它', () => {
    expect(summarizeToolResult(tc({ result: '{"summary":"杭州 27°C 烟雾霾","raw":{}}' }))).toBe(
      '杭州 27°C 烟雾霾',
    )
  })
  it('标量数组 → 逗号拼接', () => {
    expect(summarizeToolResult(tc({ result: '["北京","上海","广州"]' }))).toBe('北京, 上海, 广州')
  })
  it('纯文本 → 首行折叠 + 截断带省略号', () => {
    const long = 'A'.repeat(200)
    const s = summarizeToolResult(tc({ result: `第一行内容\n第二行` }))
    expect(s).toBe('第一行内容 第二行')
    const clamped = summarizeToolResult(tc({ result: long }))
    expect(clamped.length).toBeLessThan(long.length)
    expect(clamped.endsWith('…')).toBe(true)
  })
})

describe('prettyToolJson —— P2 可读化', () => {
  it('合法 JSON → 2 空格缩进美化', () => {
    expect(prettyToolJson('{"a":1,"b":{"c":2}}')).toBe('{\n  "a": 1,\n  "b": {\n    "c": 2\n  }\n}')
  })
  it('非 JSON → 原样返回', () => {
    expect(prettyToolJson('就是一段纯文本')).toBe('就是一段纯文本')
  })
  it('空/缺失 → 空串', () => {
    expect(prettyToolJson(undefined)).toBe('')
    expect(prettyToolJson('')).toBe('')
  })
})
