/**
 * 域：前后端契约修复取证（2026-06-22 复审）
 *
 * 锁定两处此前 it.todo 停车的跨仓契约缺陷，修复后转为 GREEN 回归锁：
 *   F  webhook.ts deleteWebhook 必须按 name 删（后端 DELETE /webhooks/{name}）
 *   G  im-channels.ts buildEmailTestConfig 必须产出 nested smtp/imap（后端读 config.smtp.*）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ════════════════════════════════════════════════════════════
// F. deleteWebhook 按 name 寻址（此前 WebhookPanel 传 id → 后端 no-op）
// ════════════════════════════════════════════════════════════
const apiDelete = vi.fn().mockResolvedValue({ message: 'ok' })
vi.mock('@/api/client', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiDelete: (...args: unknown[]) => apiDelete(...args),
}))

describe('F [P0] webhook deleteWebhook 按 name 删', () => {
  beforeEach(() => apiDelete.mockClear())

  it('deleteWebhook(name) 命中 /api/v1/webhooks/{name}（与后端路由一致）', async () => {
    const { deleteWebhook } = await import('@/api/webhook')
    await deleteWebhook('deploy-hook')
    expect(apiDelete).toHaveBeenCalledWith('/api/v1/webhooks/deploy-hook')
  })

  it('name 含特殊字符时 encodeURIComponent', async () => {
    const { deleteWebhook } = await import('@/api/webhook')
    await deleteWebhook('a b/c')
    expect(apiDelete).toHaveBeenCalledWith('/api/v1/webhooks/a%20b%2Fc')
  })
})

// ════════════════════════════════════════════════════════════
// G. buildEmailTestConfig 扁平 → nested（后端 emailTestConfig.smtp.*）
// ════════════════════════════════════════════════════════════
describe('G [P1] 邮箱 test 配置转 nested smtp/imap', () => {
  it('扁平表单字段映射到 config.smtp.{host,port,username,password,from} + config.imap', async () => {
    const { buildEmailTestConfig } = await import('@/api/im-channels')
    const cfg = buildEmailTestConfig({
      email: 'u@example.com',
      password: 'secret',
      from: '助理 <u@example.com>',
      smtp_host: 'smtp.example.com',
      smtp_port: '465',
      imap_host: 'imap.example.com',
      imap_port: '993',
    })
    expect(cfg.smtp.host).toBe('smtp.example.com')
    expect(cfg.smtp.port).toBe(465) // 数字，不是字符串
    expect(cfg.smtp.username).toBe('u@example.com')
    expect(cfg.smtp.password).toBe('secret')
    expect(cfg.smtp.from).toBe('助理 <u@example.com>')
    expect(cfg.imap).toEqual({
      host: 'imap.example.com',
      port: 993,
      username: 'u@example.com',
      password: 'secret',
    })
  })

  it('未填 IMAP 时省略 imap（后端缺省跳过 IMAP 探测）；from 缺省回退账号', async () => {
    const { buildEmailTestConfig } = await import('@/api/im-channels')
    const cfg = buildEmailTestConfig({
      email: 'u@example.com',
      password: 'p',
      smtp_host: 'smtp.example.com',
      smtp_port: '587',
    })
    expect(cfg.imap).toBeUndefined()
    expect(cfg.smtp.from).toBe('u@example.com')
    expect(cfg.smtp.port).toBe(587)
  })
})
