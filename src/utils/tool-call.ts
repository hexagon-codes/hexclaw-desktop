import type { ToolCall } from '@/types/chat'

/**
 * 工具调用展示层纯函数 —— 与 ToolCallCard.vue 配套。
 *
 * 数据现实：后端在最终 reply 里**整批**返回已完成的 tool_calls（无逐工具流式、
 * 当前不带 status/isError/耗时）。所以状态只能在前端**诚实**推导：以"是否拿到结果 +
 * 是否被显式标错"为准，**绝不**对结果正文做"error 字样"正则嗅探（脆弱、误判）。
 * 唯一例外是 engine 的**工具错误信封契约**——失败工具被整批回灌成纯串
 * `Error executing tool %q: <err>`（engine/react.go、runtime_adapters.go），这是结构化
 * 错误信号（与 is_error 同类），只是以固定前缀的纯串而非 JSON 下发，按精确前缀判定。
 * status/isError/durationMs 作为向后兼容钩子——后端将来下发时自动点亮，无需改前端。
 */

export type ToolCallStatus = 'running' | 'success' | 'error'

type ToolLike = Pick<ToolCall, 'result'> & {
  status?: ToolCallStatus
  is_error?: boolean
}

/** 尝试解析 JSON；失败返回 undefined（区别于合法的 null）。 */
function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * 结构化错误信封判定（非正则嗅探）：对象带**真值** error / 真 is_error / 真 isError。
 * 仅看结构化字段，空串 error、正文里出现 "error" 字样都不算。
 */
function looksLikeErrorEnvelope(parsed: unknown): boolean {
  if (!isPlainObject(parsed)) return false
  if (parsed.is_error === true || parsed.isError === true) return true
  const err = parsed.error
  if (typeof err === 'string') return err.trim() !== ''
  return err != null && err !== false
}

/**
 * engine 工具错误信封：失败工具被整批回灌成纯串 `Error executing tool "<name>": <err>`
 * （engine/react.go、runtime_adapters.go 用 fmt.Sprintf("Error executing tool %q: %s")，
 * `%q` 恒带双引号）。匹配这条**精确契约前缀**（必须开头）→ 判错；正文中段恰好出现该
 * 短语不算（避免把帮助/回显文本误判成错误）。
 */
const BACKEND_TOOL_ERROR_PREFIX = 'Error executing tool "'

function looksLikeBackendToolError(raw: string): boolean {
  return raw.trimStart().startsWith(BACKEND_TOOL_ERROR_PREFIX)
}

/** 工具调用状态：诚实推导，向后兼容后端字段。 */
export function toolCallStatus(tc: ToolLike): ToolCallStatus {
  if (tc.status === 'running' || tc.status === 'success' || tc.status === 'error') return tc.status
  if (tc.is_error) return 'error'
  if (tc.result == null) return 'running'
  if (tc.result === '') return 'success'
  if (looksLikeBackendToolError(tc.result)) return 'error'
  if (looksLikeErrorEnvelope(tryParseJson(tc.result))) return 'error'
  return 'success'
}

/**
 * 剥离 MCP/命名空间前缀取末段工具名。
 * - MCP 约定 mcp__server__tool（双下划线）→ tool
 * - server:tool / server.tool → tool
 * - 单下划线工具名（manage_mcp_server / spawn_agent）整体保留
 */
export function toolBaseName(name: string): string {
  if (!name) return name
  const stripped = name.replace(/^mcp__/, '')
  const parts = stripped.split(/__|[:.]/)
  return parts[parts.length - 1] || name
}

type Translate = (key: string, fallback?: string) => string

/**
 * 工具显示名 —— 卡片永不泄露裸 id。
 * 先用 base 名查 chat.toolName.<base> 映射，命中即本地化；否则退回 base 文本。
 */
export function resolveToolDisplayName(name: string, t: Translate): string {
  const base = toolBaseName(name)
  return t('chat.toolName.' + base, base)
}

/**
 * 折叠成一行摘要：去 markdown 强调标记（** ` 等，真实工具结果常是 emoji+markdown 文本）、
 * 换行/连续空白压成单空格，再**按 Unicode 码点**截断——避免在 UTF-16 代理对中间切裂
 * emoji（🌍🌡💧… 会变成 �）。真机硅基流动 weather 结果取证后硬化。
 */
function clampOneLine(s: string, maxLen: number): string {
  const flat = s.replace(/[*`]+/g, '').replace(/\s+/g, ' ').trim()
  const cps = Array.from(flat)
  if (cps.length <= maxLen) return flat
  return cps.slice(0, maxLen - 1).join('').replace(/\s+$/, '') + '…'
}

function scalarStr(v: unknown): string {
  return v === null ? 'null' : String(v)
}

function isScalar(v: unknown): boolean {
  return v === null || ['string', 'number', 'boolean'].includes(typeof v)
}

/** 对象优先摘要字段：命中其一且为非空串则直接用它当摘要。 */
const SUMMARY_KEYS = ['summary', 'text', 'message', 'description', 'content', 'title', 'result']

function summarizeJson(v: unknown, maxLen: number): string {
  if (typeof v === 'string') return clampOneLine(v, maxLen)
  if (isScalar(v)) return scalarStr(v)
  if (Array.isArray(v)) {
    if (v.every(isScalar)) return clampOneLine(v.map(scalarStr).join(', '), maxLen)
    return `[${v.length}]`
  }
  if (isPlainObject(v)) {
    for (const key of SUMMARY_KEYS) {
      if (typeof v[key] === 'string' && (v[key] as string).trim()) {
        return clampOneLine(v[key] as string, maxLen)
      }
    }
    const parts: string[] = []
    for (const [k, val] of Object.entries(v)) {
      if (isScalar(val)) parts.push(`${k}: ${scalarStr(val)}`)
      if (parts.join(' · ').length >= maxLen) break
    }
    return clampOneLine(parts.join(' · '), maxLen)
  }
  return ''
}

/**
 * 卡面一行人类可读摘要（schema 无关，对任何工具都稳健）：
 * JSON → 标量字段/摘要字段；纯文本 → 首行折叠 + 截断。不展开即可知发生了什么。
 */
export function summarizeToolResult(tc: Pick<ToolCall, 'result'>, maxLen = 88): string {
  const raw = tc.result
  if (raw == null || raw.trim() === '') return ''
  const parsed = tryParseJson(raw)
  if (parsed !== undefined) return summarizeJson(parsed, maxLen)
  return clampOneLine(raw, maxLen)
}

/** 参数/结果可读化：合法 JSON → 2 空格缩进；否则原样（P2，告别裸串）。 */
export function prettyToolJson(raw?: string): string {
  if (raw == null || raw === '') return ''
  const parsed = tryParseJson(raw)
  if (parsed === undefined) return raw
  try {
    return JSON.stringify(parsed, null, 2)
  } catch {
    return raw
  }
}

/** 耗时标签：<1s 显示 ms，否则 x.x s（向后兼容 durationMs）。 */
export function toolDurationLabel(durationMs?: number): string {
  if (durationMs == null || !Number.isFinite(durationMs) || durationMs < 0) return ''
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`
  return `${(durationMs / 1000).toFixed(1)}s`
}
