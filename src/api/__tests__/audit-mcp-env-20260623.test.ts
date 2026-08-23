import { describe, it, expect, vi, beforeEach } from 'vitest'

const apiGet = vi.hoisted(() => vi.fn())
const apiPost = vi.hoisted(() => vi.fn())
const apiDelete = vi.hoisted(() => vi.fn())
vi.mock('../client', () => ({ apiGet, apiPost, apiDelete }))

import { addMcpServer } from '../mcp'

beforeEach(() => vi.clearAllMocks())

// AUDIT 2026-06-23 数据连接器走 MCP 的 env keystone（前端契约）：
// MySQL/Redis 等 stdio MCP server 靠 env 配凭证，addMcpServer 必须能把 env 透传给
// POST /api/v1/mcp/servers（后端 handler→ServerConfig.Env→hexagon.ConnectMCPStdioWithEnv→子进程）。
describe('AUDIT addMcpServer env keystone', () => {
  it('★传 env → 请求体携 env（数据库连接器凭证注入）', async () => {
    apiPost.mockResolvedValue({ message: 'ok' })
    await addMcpServer('mysql', 'npx', ['-y', '@benborla29/mcp-server-mysql'], {
      env: { MYSQL_HOST: 'localhost', MYSQL_PASSWORD: 's3cret' },
    })
    const [path, body] = apiPost.mock.calls[0]!
    expect(path).toBe('/api/v1/mcp/servers')
    expect((body as Record<string, unknown>).env).toEqual({ MYSQL_HOST: 'localhost', MYSQL_PASSWORD: 's3cret' })
  })

  it('不传 env 时请求体不含 env（向后兼容市场一键安装等调用方）', async () => {
    apiPost.mockResolvedValue({ message: 'ok' })
    await addMcpServer('filesystem', 'npx', ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'])
    const body = apiPost.mock.calls[0]![1] as Record<string, unknown>
    expect('env' in body).toBe(false)
  })

  it('传 secret mutation 时请求体携带 opaque credential refs 与用户意图', async () => {
    apiPost.mockResolvedValue({ message: 'ok' })
    await addMcpServer('postgres', 'npx', ['-y', 'server-postgres', 'postgresql://user@localhost/db'], {
      secretArgs: [{
        index: 2,
        mode: 'preserve',
        credentialRef: 'sidecar-connection:v1:connection-1:password',
      }],
    })
    const body = apiPost.mock.calls[0]![1] as Record<string, unknown>
    expect(body.secret_args).toEqual([{
      index: 2,
      mode: 'preserve',
      credentialRef: 'sidecar-connection:v1:connection-1:password',
    }])
  })
})
