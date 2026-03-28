import { apiGet, apiPost, apiDelete } from './client'
import type { McpTool } from '@/types'

export type { McpServer, McpTool } from '@/types'

/** 获取 MCP 工具列表 */
export function getMcpTools() {
  return apiGet<{ tools: McpTool[]; total: number }>('/api/v1/mcp/tools')
}

/** 获取 MCP 服务器列表 */
export function getMcpServers() {
  return apiGet<{ servers: string[]; total: number }>('/api/v1/mcp/servers')
}

/** 调用 MCP 工具（测试） */
export function callMcpTool(toolName: string, args: Record<string, unknown>) {
  return apiPost<{ result: unknown; error?: string }>('/api/v1/mcp/tools/call', {
    tool: toolName,
    arguments: args,
  })
}

/** 获取 MCP 服务器状态 */
export function getMcpServerStatus() {
  return apiGet<{ statuses: Record<string, 'connected' | 'disconnected' | 'error'> }>('/api/v1/mcp/status')
}

/** 添加 MCP 服务器（运行时动态添加，无需重启） */
export function addMcpServer(name: string, command: string, args?: string[]) {
  return apiPost<{ message: string }>('/api/v1/mcp/servers', { name, command, args })
}

/** 移除 MCP 服务器 */
export function removeMcpServer(name: string) {
  return apiDelete<{ message: string }>(`/api/v1/mcp/servers/${encodeURIComponent(name)}`)
}

/** MCP 市场条目 */
export interface McpMarketplaceEntry {
  name: string
  display_name: string
  description: string
  category: string
  command: string
  args: string[]
  config_hint?: string
  downloads: number
  rating: number
}

/** 搜索 MCP 市场 */
export function searchMcpMarketplace(query: string) {
  return apiGet<{ servers: McpMarketplaceEntry[] }>(`/api/v1/clawhub/search?q=${encodeURIComponent(query)}&type=mcp`)
}

/** 获取 MCP 市场全部条目 */
export function getMcpMarketplace() {
  return apiGet<{ servers: McpMarketplaceEntry[] }>('/api/v1/clawhub/search?type=mcp')
}
