/** MCP 工具 */
export interface McpTool {
  name: string
  description: string
  input_schema?: Record<string, unknown>
}

/** MCP 服务器 */
export interface McpServer {
  id: string
  name: string
  url: string
  status: 'connected' | 'disconnected' | 'error'
  tools: McpTool[]
  connected_at?: string
  error?: string
}
