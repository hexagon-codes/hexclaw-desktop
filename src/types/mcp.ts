/** MCP 工具 */
export interface McpTool {
  name: string
  description: string
  server_name?: string
  input_schema?: Record<string, unknown>
}

/** MCP 服务器列表项；兼容旧接口的名称列表与结构化内容层。 */
export interface McpServerListItem {
  name: string
  description?: string
  id?: string
  url?: string
  status?: McpServer['status']
  connected?: boolean
  tool_count?: number
}

/** MCP 服务器 */
export interface McpServer {
  id: string
  name: string
  url: string
  status: 'connected' | 'disconnected' | 'error' | 'pending_authorization'
  tools: McpTool[]
  connected_at?: string
  error?: string
}
