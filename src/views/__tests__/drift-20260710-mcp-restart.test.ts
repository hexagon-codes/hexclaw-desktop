/**
 * 漂移-缺 M3（review-fullstack 20260710）：MCP 服务器行缺原型「重启」（app.html:1927）。
 * 后端已补 Manager.RestartServer + POST /api/v1/mcp/servers/{name}/restart（契约测试在 hexclaw 仓）;
 * 此处锁前端接线:api client + 服务器行按钮（loading 态防重入）。
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const SRC = path.resolve(__dirname, '../..')

describe('M3 · MCP 服务器行「重启」接线', () => {
  it('api client 暴露 restartMcpServer 并指向 restart 端点', () => {
    const body = fs.readFileSync(path.join(SRC, 'api/mcp.ts'), 'utf8')
    expect(body).toContain('export function restartMcpServer')
    expect(body).toContain('/restart')
  })
  it('McpView 服务器行有重启按钮（testid+loading 防重入+调用链）', () => {
    const body = fs.readFileSync(path.join(SRC, 'views/McpView.vue'), 'utf8')
    expect(body).toContain('data-testid="mcp-server-restart"')
    expect(body).toContain('restartingServers.has(name)')
    expect(body).toContain('handleRestartServer(name)')
    expect(body).toContain('await restartMcpServer(name)')
  })
})
