/**
 * MCP 数据连接器「测试连接」探针编排（从 ConnectionsView.vue 下沉）。
 *
 * 职责：
 *  - 纯判定（无副作用、可独立单测）：mcpSQLProbeFor / isSQLLikeTool / pickMcpProbeTool /
 *    resolveMcpProbeArgs —— 决定「用哪条 SQL」「探哪个工具」「入参键叫什么」。
 *  - 异步编排：ensureMcpConnectorOnline（确保 server 在线）、runMcpConnectorProbe（真实探针）。
 *
 * 收紧点（BUG-20260702）：
 *  b) 探针入参不再硬编码 `{ sql }`——读工具 input_schema.properties 决定真实入参键；拿不到 schema
 *     或无 SQL 字段时抛 McpProbeError（明确态），不静默把 SQL 塞进错误的键。
 *  c) pickMcpProbeTool 只按 server_name 精确匹配当前被测 connector 的工具；不再盲选「无 server_name
 *     的任意 SQL-like 工具」（旧后端不回 server_name 时会探错别的 server）。归属不明 → 明确态。
 *
 * i18n 隔离：本模块只抛稳定 code（不含界面文案），由 view 侧按 code 映射本地化提示。
 */
import { addMcpServer, callMcpTool, getMcpTools } from './mcp'
import { buildMcpServerConfig } from '@/config/mcp-connectors'
import type { ConnectorInstance } from '@/composables/useConnectorInstances'
import type { McpTool } from '@/types'

export type McpProbeFailureCode = 'tool_missing' | 'no_input_schema' | 'no_sql_arg'

/** 探针失败：携带稳定 code + 出错工具名，view 侧据 code 本地化提示（不静默）。 */
export class McpProbeError extends Error {
  code: McpProbeFailureCode
  toolName?: string
  constructor(code: McpProbeFailureCode, message: string, toolName?: string) {
    super(message)
    this.name = 'McpProbeError'
    this.code = code
    this.toolName = toolName
  }
}

/** 数据源类型 → 无害只读探针 SQL（非 SQL 类返回 null，跳过探针）。 */
export function mcpSQLProbeFor(type: string): string | null {
  switch (type) {
    case 'mysql':
    case 'postgres':
    case 'sqlite':
      return 'SELECT 1 AS ok'
    default:
      return null
  }
}

/** 工具是否「SQL 查询类」（名称/描述含 query|sql 的启发式）。 */
export function isSQLLikeTool(tool: McpTool): boolean {
  const name = tool.name.toLowerCase()
  const desc = (tool.description || '').toLowerCase()
  return name.includes('query') || name.includes('sql') || desc.includes('query') || desc.includes('sql')
}

/**
 * 挑探针工具：只在 server_name 精确等于被测 connector 的工具里挑 SQL-like 的第一个。
 * 归属不明（工具无 server_name / 无同 server SQL 工具）→ 返回 null（由调用方抛明确态），绝不盲选。
 */
export function pickMcpProbeTool(tools: McpTool[], serverName: string): McpTool | null {
  return tools.filter((tool) => tool.server_name === serverName).find(isSQLLikeTool) ?? null
}

/** input_schema.properties 里被视为 SQL 语句入参的候选键（精确优先）。 */
const SQL_ARG_KEYS = ['sql', 'query', 'statement', 'command']

function schemaProperties(tool: McpTool): Record<string, unknown> | null {
  const schema = tool.input_schema
  if (!schema || typeof schema !== 'object') return null
  const props = (schema as { properties?: unknown }).properties
  if (!props || typeof props !== 'object') return null
  const record = props as Record<string, unknown>
  return Object.keys(record).length > 0 ? record : null
}

/**
 * 按工具真实 input_schema 构造探针入参键，而非猜测 `{ sql }`。
 * - 无 input_schema（或 properties 空）→ McpProbeError('no_input_schema')。
 * - 有 schema 但无可识别 SQL 字段 → McpProbeError('no_sql_arg')。
 */
export function resolveMcpProbeArgs(tool: McpTool, sql: string): Record<string, string> {
  const props = schemaProperties(tool)
  if (!props) {
    throw new McpProbeError('no_input_schema', `MCP tool "${tool.name}" exposes no input schema`, tool.name)
  }
  const keys = Object.keys(props)
  const argKey =
    keys.find((k) => SQL_ARG_KEYS.includes(k.toLowerCase())) ?? keys.find((k) => /sql|query/i.test(k))
  if (!argKey) {
    throw new McpProbeError('no_sql_arg', `MCP tool "${tool.name}" has no SQL-like input field`, tool.name)
  }
  return { [argKey]: sql }
}

/** 确保被测 connector 的 MCP server 在线：已在线直接放行；否则按当前配置注册后复查。 */
export async function ensureMcpConnectorOnline(
  inst: ConnectorInstance,
  serverName: string,
  deps: { refreshStatus: () => Promise<unknown>; isServerOnline: (name: string) => boolean },
): Promise<boolean> {
  await deps.refreshStatus()
  if (deps.isServerOnline(serverName)) return true

  const built = buildMcpServerConfig(inst.type, inst.config || {})
  if (!built) return false

  await addMcpServer(serverName, built.command, built.args, { env: built.env })
  await deps.refreshStatus()
  return deps.isServerOnline(serverName)
}

/**
 * 对已在线的 MCP 数据连接器执行一次真实只读探针（SELECT 1 之类）。
 * SQL 类才探；探不到工具 / 入参不可解析 → 抛 McpProbeError（明确态），不静默成功。
 */
export async function runMcpConnectorProbe(inst: ConnectorInstance, serverName: string): Promise<void> {
  const sql = mcpSQLProbeFor(inst.type)
  if (!sql) return

  const res = await getMcpTools()
  const tool = pickMcpProbeTool(res.tools ?? [], serverName)
  if (!tool) {
    throw new McpProbeError('tool_missing', `No SQL probe tool found for MCP server "${serverName}"`)
  }
  const args = resolveMcpProbeArgs(tool, sql)
  await callMcpTool(tool.name, args)
}
