/**
 * BUG-20260702：MCP 探针纯判定逻辑单测（从 ConnectionsView.vue 下沉到 @/api/mcp-probe）。
 *
 * 覆盖收紧点：
 *  (b) resolveMcpProbeArgs 按工具 input_schema 决定入参键（非硬猜 {sql}）；无 schema / 无 SQL 字段
 *      抛 McpProbeError（明确 code），不静默。
 *  (c) pickMcpProbeTool 只按 server_name 精确匹配；工具无 server_name（旧后端）时不盲选，返回 null。
 *  runMcpConnectorProbe 端到端：探不到工具 / 入参不可解析 → 抛 McpProbeError，不误报成功。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getMcpTools, callMcpTool, addMcpServer } = vi.hoisted(() => ({
  getMcpTools: vi.fn(),
  callMcpTool: vi.fn(),
  addMcpServer: vi.fn(),
}))
vi.mock('@/api/mcp', () => ({ getMcpTools, callMcpTool, addMcpServer }))

import {
  mcpSQLProbeFor,
  isSQLLikeTool,
  pickMcpProbeTool,
  resolveMcpProbeArgs,
  runMcpConnectorProbe,
  ensureMcpConnectorOnline,
  McpProbeError,
} from '@/api/mcp-probe'
import type { McpTool } from '@/types'

function tool(overrides: Partial<McpTool> & { name: string }): McpTool {
  return { description: '', ...overrides }
}

/** 捕获同步抛出的错误，便于断言其类型/字段（避免 try/catch 内 expect 触发 no-conditional-expect）。 */
function captureError(fn: () => unknown): unknown {
  try {
    fn()
    return undefined
  } catch (e) {
    return e
  }
}

describe('BUG-20260702 mcp-probe 纯判定', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    callMcpTool.mockResolvedValue({ result: 'ok' })
  })

  describe('mcpSQLProbeFor', () => {
    it('SQL 类返回 SELECT 1；非 SQL 类返回 null', () => {
      expect(mcpSQLProbeFor('mysql')).toBe('SELECT 1 AS ok')
      expect(mcpSQLProbeFor('postgres')).toBe('SELECT 1 AS ok')
      expect(mcpSQLProbeFor('sqlite')).toBe('SELECT 1 AS ok')
      expect(mcpSQLProbeFor('redis')).toBeNull()
      expect(mcpSQLProbeFor('localFolder')).toBeNull()
    })
  })

  describe('isSQLLikeTool', () => {
    it('名称或描述含 query/sql 判为 SQL-like', () => {
      expect(isSQLLikeTool(tool({ name: 'run_query' }))).toBe(true)
      expect(isSQLLikeTool(tool({ name: 'exec', description: 'run a SQL statement' }))).toBe(true)
      expect(isSQLLikeTool(tool({ name: 'list_tables', description: 'list' }))).toBe(false)
    })
  })

  describe('(c) pickMcpProbeTool 精确归属，不盲选', () => {
    it('只挑 server_name 精确等于被测 server 的 SQL 工具', () => {
      const tools = [
        tool({ name: 'other_query', description: 'query', server_name: '别的库' }),
        tool({ name: 'mine_query', description: 'query', server_name: '生产库' }),
      ]
      expect(pickMcpProbeTool(tools, '生产库')?.name).toBe('mine_query')
    })

    it('工具全部缺 server_name（旧后端）→ 不盲选，返回 null', () => {
      const tools = [tool({ name: 'some_query', description: 'run query' })]
      expect(pickMcpProbeTool(tools, '生产库')).toBeNull()
    })

    it('同 server 无 SQL-like 工具 → 返回 null（不跨 server 借用）', () => {
      const tools = [
        tool({ name: 'list_tables', description: 'list', server_name: '生产库' }),
        tool({ name: 'foreign_query', description: 'query', server_name: '别的库' }),
      ]
      expect(pickMcpProbeTool(tools, '生产库')).toBeNull()
    })
  })

  describe('(b) resolveMcpProbeArgs 按 input_schema 定入参键', () => {
    it('schema 入参键为 query → 用 query，而非硬塞 sql', () => {
      const t = tool({ name: 'run_sql', input_schema: { properties: { query: { type: 'string' } } } })
      expect(resolveMcpProbeArgs(t, 'SELECT 1')).toEqual({ query: 'SELECT 1' })
    })

    it('schema 入参键为 sql → 用 sql', () => {
      const t = tool({ name: 'mysql_query', input_schema: { properties: { sql: {} } } })
      expect(resolveMcpProbeArgs(t, 'SELECT 1')).toEqual({ sql: 'SELECT 1' })
    })

    it('无 input_schema → 抛 McpProbeError(no_input_schema)，不静默', () => {
      const t = tool({ name: 'mystery' })
      const err = captureError(() => resolveMcpProbeArgs(t, 'SELECT 1'))
      expect(err).toBeInstanceOf(McpProbeError)
      expect((err as McpProbeError).code).toBe('no_input_schema')
      expect((err as McpProbeError).toolName).toBe('mystery')
    })

    it('schema 存在但无 SQL 字段 → 抛 McpProbeError(no_sql_arg)', () => {
      const t = tool({ name: 'weird', input_schema: { properties: { limit: { type: 'number' } } } })
      const err = captureError(() => resolveMcpProbeArgs(t, 'SELECT 1'))
      expect(err).toBeInstanceOf(McpProbeError)
      expect((err as McpProbeError).code).toBe('no_sql_arg')
    })
  })

  describe('runMcpConnectorProbe 端到端', () => {
    const inst = { id: 'm1', type: 'mysql', name: '生产库', config: { mcp_server: '生产库' }, enabled: true }

    it('探到同 server SQL 工具 + schema → callMcpTool 用正确入参键', async () => {
      getMcpTools.mockResolvedValue({
        tools: [tool({ name: 'run_sql', description: 'query', server_name: '生产库', input_schema: { properties: { query: {} } } })],
        total: 1,
      })
      await runMcpConnectorProbe(inst, '生产库')
      expect(callMcpTool).toHaveBeenCalledWith('run_sql', { query: 'SELECT 1 AS ok' })
    })

    it('无归属工具 → 抛 tool_missing，绝不 callMcpTool', async () => {
      getMcpTools.mockResolvedValue({ tools: [tool({ name: 'orphan_query', description: 'query' })], total: 1 })
      await expect(runMcpConnectorProbe(inst, '生产库')).rejects.toMatchObject({ code: 'tool_missing' })
      expect(callMcpTool).not.toHaveBeenCalled()
    })

    it('工具无 schema → 抛 no_input_schema，绝不 callMcpTool', async () => {
      getMcpTools.mockResolvedValue({
        tools: [tool({ name: 'mysql_query', description: 'query', server_name: '生产库' })],
        total: 1,
      })
      await expect(runMcpConnectorProbe(inst, '生产库')).rejects.toMatchObject({ code: 'no_input_schema' })
      expect(callMcpTool).not.toHaveBeenCalled()
    })

    it('非 SQL 类型（redis）→ 跳过探针，不 callMcpTool', async () => {
      await runMcpConnectorProbe({ ...inst, type: 'redis' }, '生产库')
      expect(getMcpTools).not.toHaveBeenCalled()
      expect(callMcpTool).not.toHaveBeenCalled()
    })
  })

  describe('ensureMcpConnectorOnline', () => {
    const inst = { id: 'm1', type: 'mysql', name: '生产库', config: { host: '127.0.0.1', mcp_server: '生产库' }, enabled: true }

    it('已在线 → 直接 true，不注册（测试路径不产生副作用）', async () => {
      const refreshStatus = vi.fn().mockResolvedValue(undefined)
      const isServerOnline = vi.fn().mockReturnValue(true)
      const online = await ensureMcpConnectorOnline(inst, '生产库', { refreshStatus, isServerOnline })
      expect(online).toBe(true)
      expect(addMcpServer).not.toHaveBeenCalled()
    })

    it('离线 → 按配置注册后复查在线态', async () => {
      const refreshStatus = vi.fn().mockResolvedValue(undefined)
      const isServerOnline = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true)
      addMcpServer.mockResolvedValue({ message: 'queued', connected: true })
      const online = await ensureMcpConnectorOnline(inst, '生产库', { refreshStatus, isServerOnline })
      expect(addMcpServer).toHaveBeenCalledTimes(1)
      expect(online).toBe(true)
    })
  })
})
