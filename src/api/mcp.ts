import { apiGet, apiPost, apiPut, apiDelete } from './client'
import type { McpServer } from '@/types'

export type { McpServer, McpTool } from '@/types'

/** 获取 MCP 服务器列表 */
export function getMcpServers() {
  return apiGet<{ servers: McpServer[] }>('/api/v1/mcp/servers')
}

/** 添加 MCP 服务器 */
export function addMcpServer(name: string, url: string) {
  return apiPost<McpServer>('/api/v1/mcp/servers', { name, url })
}

/** 删除 MCP 服务器 */
export function removeMcpServer(id: string) {
  return apiDelete(`/api/v1/mcp/servers/${id}`)
}

/** 重连 MCP 服务器 */
export function reconnectMcpServer(id: string) {
  return apiPost(`/api/v1/mcp/servers/${id}/reconnect`)
}

/** 更新 MCP 服务器 */
export function updateMcpServer(id: string, data: { name?: string; url?: string }) {
  return apiPut(`/api/v1/mcp/servers/${id}`, data)
}
