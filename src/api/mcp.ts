import { apiGet, apiPost, apiDelete } from './client'
import type { McpServer, McpServerListItem, McpTool } from '@/types/mcp'

export type { McpServer, McpServerListItem, McpTool } from '@/types/mcp'

/** 获取 MCP 工具列表 */
export function getMcpTools() {
  return apiGet<{ tools: McpTool[]; total: number }>('/api/v1/mcp/tools')
}

/** 获取 MCP 服务器列表 */
export function getMcpServers() {
  return apiGet<{ servers: Array<string | McpServerListItem>; total: number }>('/api/v1/mcp/servers')
}

/** 调用 MCP 工具（测试） */
export async function callMcpTool(toolName: string, args: Record<string, unknown>) {
  if (!toolName || typeof toolName !== 'string' || !toolName.trim()) {
    throw new Error('callMcpTool: toolName must be a non-empty string')
  }

  const res = await apiPost<{ result: unknown; error?: string }>('/api/v1/mcp/tools/call', {
    name: toolName.trim(),
    arguments: args,
  })

  if (res == null || typeof res !== 'object') {
    throw new Error('callMcpTool: received malformed response from backend')
  }
  if (typeof res.error === 'string' && res.error.trim() !== '') {
    throw new Error(res.error.trim())
  }

  if (res.result === undefined && !res.error) {
    return { ...res, result: null }
  }

  return res
}

/** 获取 MCP 服务器状态 */
export function getMcpServerStatus() {
  return apiGet<{
    statuses?: Record<string, McpServer['status']>
    servers?: Array<{ name: string; connected: boolean; tool_count: number }>
    total?: number
  }>('/api/v1/mcp/status')
}

/**
 * 添加 MCP 服务器（运行时动态添加，无需重启）。
 *
 * transport: 'stdio'（默认，需 command）| 'sse' | 'streamable'（后两者需 endpoint）。
 * 对齐后端 handler（handler_misc.go）：stdio 走 command+args，sse/streamable 走 endpoint。
 * 不传 opts 时 body 与旧版完全一致（向后兼容市场一键安装等调用方）。
 */
export function addMcpServer(
  name: string,
  command: string,
  args?: string[],
  opts?: {
    transport?: string
    endpoint?: string
    env?: Record<string, string>
    secretArgs?: Array<{ index: number; mode: 'preserve' | 'replace' | 'clear'; credentialRef: string }>
    secretEnv?: Array<{ key: string; mode: 'preserve' | 'replace' | 'clear'; credentialRef: string }>
  },
) {
  const body: Record<string, unknown> = { name, command, args }
  if (opts?.transport) body.transport = opts.transport
  if (opts?.endpoint) body.endpoint = opts.endpoint
  // 数据连接器走 MCP 的凭证注入：MySQL/Redis 等 stdio server 靠 env 配连接信息。
  // 仅在有 env 时附带，保持市场一键安装等调用方的请求体不变（向后兼容）。
  if (opts?.env && Object.keys(opts.env).length > 0) body.env = opts.env
  if (opts?.secretArgs && opts.secretArgs.length > 0) body.secret_args = opts.secretArgs
  if (opts?.secretEnv && opts.secretEnv.length > 0) body.secret_env = opts.secretEnv
  // connected：后端 best-effort 注册——暖装秒连=true；冷装首次下载组件时转后台重连=false。
  return apiPost<{ message: string; connected?: boolean }>('/api/v1/mcp/servers', body)
}

/** 移除 MCP 服务器 */
/** 重启单个 MCP Server（M3-20260710，原型 1927「重启」；新连接成功才替换，失败保留原状） */
export function restartMcpServer(name: string) {
  return apiPost<{ message: string }>(`/api/v1/mcp/servers/${encodeURIComponent(name)}/restart`, {})
}

export function removeMcpServer(name: string) {
  return apiDelete<{ message: string }>(`/api/v1/mcp/servers/${encodeURIComponent(name)}`)
}

/** MCP 市场条目（对齐后端 hub.SkillMeta） */
export interface McpMarketplaceEntry {
  name: string
  display_name: string
  description: string
  version: string
  author: string
  category: string
  tags: string[]
  url: string
  downloads: number
  rating: number
  // 前端扩展：从 Hub YAML 提取的安装命令
  command?: string
  args?: string[]
  /** 安装后需用户自行配置的提示（如所需环境变量 / 本地依赖），来自 hub config_hint */
  config_hint?: string
}

/** 共享 ClawHub 搜索端点（同 skills.ts searchClawHub，通过 type='mcp' 过滤） */
const CLAWHUB_SEARCH_ENDPOINT = '/api/v1/clawhub/search'

/** 后端 clawhub/search 在目录拉取失败时返回 200 + {skills:[], error:'...'}，
 *  必须如实抛错（对齐 skills.ts searchClawHub），否则 UI 把"加载失败"静默当成"无结果"。 */
function throwIfHubError(res: { error?: string }): void {
  if (res.error) throw new Error(res.error)
}

/** 搜索 MCP 市场 */
export async function searchMcpMarketplace(query: string) {
  const res = await apiGet<{ skills: McpMarketplaceEntry[]; total: number; error?: string }>(CLAWHUB_SEARCH_ENDPOINT, { q: query, type: 'mcp' })
  throwIfHubError(res)
  return res
}

/** 获取 MCP 市场全部条目 */
export async function getMcpMarketplace() {
  const res = await apiGet<{ skills: McpMarketplaceEntry[]; total: number; error?: string }>(CLAWHUB_SEARCH_ENDPOINT, { type: 'mcp' })
  throwIfHubError(res)
  return res
}
