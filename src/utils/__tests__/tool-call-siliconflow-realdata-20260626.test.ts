import { describe, it, expect } from 'vitest'
import {
  toolCallStatus,
  resolveToolDisplayName,
  summarizeToolResult,
  prettyToolJson,
} from '@/utils/tool-call'
import type { ToolCall } from '@/types/chat'

/**
 * 真机 E2E 取证回归：硅基流动 Qwen/Qwen3.6-35B-A3B「杭州今天天气」实际返回的 tool_call。
 * 关键真相：result 不是 JSON，而是带 emoji 的 **markdown 文本**。合成 JSON fixture 照不出，
 * 这条钉死卡片在真实数据形状下：① 状态成功 ② 摘要干净（无裸 ** / 无切裂 emoji）③ 参数美化。
 */
const SF_WEATHER: ToolCall = {
  id: 'call_d2e99c4f13fd4152b40dc4ea',
  name: 'weather',
  arguments: '{"location": "杭州"}',
  result:
    '🌍 **杭州 天气**\n\n🌡 温度: 27°C（体感 31°C）\n💧 湿度: 74%\n💨 风速: 4 km/h\n☁ 天况: Smoky haze\n\n📅 今日: 最高 30°C / 最低 21°C\n',
}

describe('硅基流动真实 weather tool_call → 卡片渲染', () => {
  it('状态 = success（有结果、无错误信封）', () => {
    expect(toolCallStatus(SF_WEATHER)).toBe('success')
  })

  it('工具名本地化为 天气查询', () => {
    const t = (k: string, fb?: string) => (k === 'chat.toolName.weather' ? '天气查询' : (fb ?? k))
    expect(resolveToolDisplayName(SF_WEATHER.name, t)).toBe('天气查询')
  })

  it('摘要含关键天气信息且单行', () => {
    const s = summarizeToolResult(SF_WEATHER)
    expect(s).toContain('温度: 27°C')
    expect(s).toContain('湿度: 74%')
    expect(s).not.toContain('\n')
  })

  it('摘要剥离 markdown 星号（不出现裸 **）', () => {
    const s = summarizeToolResult(SF_WEATHER)
    expect(s).not.toContain('*')
    expect(s).toContain('杭州 天气')
  })

  it('摘要不切裂 emoji（无 U+FFFD 替换字符）', () => {
    // 故意造一条恰在 emoji 处溢出 maxLen 的结果
    const tc: ToolCall = { ...SF_WEATHER, result: '天'.repeat(86) + '🌍🌡💧 尾部' }
    const s = summarizeToolResult(tc)
    expect(s).not.toContain('�')
    expect(s.endsWith('…')).toBe(true)
  })

  it('参数美化为缩进 JSON', () => {
    expect(prettyToolJson(SF_WEATHER.arguments)).toBe('{\n  "location": "杭州"\n}')
  })

  it('结果（markdown 文本）原样保留进折叠区，不被误当 JSON', () => {
    // 非 JSON 文本 → prettyToolJson 原样返回，换行保留供 <pre> 展示
    expect(prettyToolJson(SF_WEATHER.result)).toBe(SF_WEATHER.result)
  })
})
