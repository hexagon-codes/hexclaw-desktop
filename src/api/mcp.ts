import { apiGet } from './client'
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
