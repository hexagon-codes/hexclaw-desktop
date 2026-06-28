import type { ChatMessage } from '@/types/chat'

/**
 * 子 Agent 协作回执（对齐后端 engine.SubAgentReport / OpenClaw announce 语义）。
 * orchestrate / spawn_agent 工具结果尾部嵌一段 ```hexclaw-subagents JSON 哨兵块，
 * 前端解析后渲染折叠协作面板（完成后结构化展示，非逐字流式）。
 */
export interface SubAgentReport {
  agent: string
  status: 'ok' | 'error' | 'timeout'
  duration?: string
  output?: string
  error?: string
}

/** 后端约定的哨兵围栏语言标签，须与 engine.subAgentSentinelLang 一致。 */
const SENTINEL = 'hexclaw-subagents'

/** 产出子 Agent 回执的工具名，须与后端 SpawnSkill/OrchestrateSkill 的 Name() 一致。 */
const SUBAGENT_TOOLS = new Set(['orchestrate', 'spawn_agent'])

/**
 * 从一段工具结果文本里抠出 ```hexclaw-subagents 哨兵块并解析为回执数组。
 * 无哨兵块 / JSON 非法 / 非数组 一律返回 null（优雅降级，调用方回退原始渲染）。
 */
export function parseSubAgentReports(toolResult: string | undefined | null): SubAgentReport[] | null {
  if (!toolResult) return null
  const fence = '```' + SENTINEL
  const start = toolResult.indexOf(fence)
  if (start < 0) return null
  // 哨兵块形如 ```hexclaw-subagents\n<json>\n``` —— 找开标签后的首个换行，再找闭合 ```
  const jsonStart = toolResult.indexOf('\n', start + fence.length)
  if (jsonStart < 0) return null
  const close = toolResult.indexOf('```', jsonStart)
  if (close < 0) return null
  const raw = toolResult.slice(jsonStart + 1, close).trim()
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    const reports = parsed.filter(
      (r): r is SubAgentReport => !!r && typeof (r as SubAgentReport).agent === 'string',
    )
    return reports.length > 0 ? reports : null
  } catch {
    return null
  }
}

/**
 * 扫描一条 assistant 消息的 orchestrate / spawn_agent 工具调用，汇总其中所有子 Agent 回执。
 * 一条消息可能既有 orchestrate 又有 spawn，按出现顺序拼接。
 */
export function getSubAgentReports(msg: ChatMessage): SubAgentReport[] {
  if (!msg.tool_calls?.length) return []
  const out: SubAgentReport[] = []
  for (const tc of msg.tool_calls) {
    if (!SUBAGENT_TOOLS.has(tc.name)) continue
    const reports = parseSubAgentReports(tc.result)
    if (reports) out.push(...reports)
  }
  return out
}

/** 该工具调用是否已被协作面板接管（用于在原始 tool_calls 列表里隐藏它，避免重复展示）。 */
export function isSubAgentToolCall(name: string): boolean {
  return SUBAGENT_TOOLS.has(name)
}
