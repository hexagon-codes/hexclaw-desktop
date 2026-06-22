import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import ChannelConfigModal from '../ChannelConfigModal.vue'
import zhCN from '@/i18n/locales/zh-CN'

// ════════════════════════════════════════════════════════════════════
// BUG 2026-06-22【P0 前后端对齐】连接中心 ChannelConfigModal 邮箱「测试连接」
// 把 flat 表单 config 原样发给 /connections/test，而后端 emailTestConfig 只读 nested
// config.smtp.{host,username,password} → 邮箱测试在连接中心 100% 失败。
//
// 同款 bug 此前在 IMChannelsView 已修（经 buildEmailTestConfig 转 nested），
// 但漏掉了 ConnectionsView → ConnectionChannelCards → ChannelConfigModal 这条路径。
// 现场证据：ChannelConfigModal.vue handleTest() 的 email 分支。
// ════════════════════════════════════════════════════════════════════

const { testConnection } = vi.hoisted(() => ({
  testConnection: vi.fn(),
}))

vi.mock('@/api/im-channels', async () => {
  const actual = await vi.importActual<typeof import('@/api/im-channels')>('@/api/im-channels')
  return {
    ...actual,
    // 只 mock 网络出口，保留真实 buildEmailTestConfig / CHANNEL_CONFIG_FIELDS。
    testConnection,
  }
})

vi.mock('lucide-vue-next', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const stub = { template: '<span />' }
  const mocked: Record<string, unknown> = {}
  for (const key of Object.keys(original)) mocked[key] = stub
  return mocked
})

function createTestI18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': zhCN, zh: zhCN },
  })
}

// 编辑态直接进第 2 步并预填 email flat config（模拟用户在连接中心配置好的邮箱实例）。
const emailInstance = {
  id: 'email-1',
  name: '邮箱 · 客服',
  type: 'email' as const,
  enabled: false,
  config: {
    email: 'alice@gmail.com',
    password: 'app-specific-pw',
    from: 'Alice <alice@gmail.com>',
    smtp_host: 'smtp.gmail.com',
    smtp_port: '587',
    imap_host: 'imap.gmail.com',
    imap_port: '993',
  },
  createdAt: 1,
}

function mountModal() {
  return mount(ChannelConfigModal, {
    props: { instance: emailInstance },
    global: {
      plugins: [createTestI18n()],
      stubs: { teleport: true },
    },
  })
}

describe('BUG 2026-06-22 ChannelConfigModal 邮箱测试连接 flat→nested', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    testConnection.mockResolvedValue({ ok: true, detail: 'SMTP 认证通过' })
  })

  it('点击「测试连接」时，发给 testConnection 的 config 是 nested smtp.{host,username,password}（对齐后端），不是 flat smtp_host', async () => {
    const wrapper = mountModal()
    await flushPromises()

    const testBtn = wrapper
      .findAll('button')
      .find((b) => b.text().includes(zhCN.imChannels.testConnection))
    expect(testBtn).toBeDefined()
    await testBtn!.trigger('click')
    await flushPromises()

    expect(testConnection).toHaveBeenCalledTimes(1)
    const arg = testConnection.mock.calls[0]![0] as {
      type: string
      config: Record<string, unknown>
    }
    expect(arg.type).toBe('email')

    // 后端 emailTestConfig 权威形状：config.smtp.{host,port,username,password,from}
    const cfg = arg.config as {
      smtp?: { host?: string; port?: number; username?: string; password?: string; from?: string }
      imap?: { host?: string }
    }
    expect(cfg.smtp, 'config 必须含 nested smtp 对象（后端只读 config.smtp.*）').toBeDefined()
    expect(cfg.smtp!.host).toBe('smtp.gmail.com')
    expect(cfg.smtp!.port).toBe(587)
    // username 由账号 email 派生（后端 emailTestConfig 没有 email 字段）
    expect(cfg.smtp!.username).toBe('alice@gmail.com')
    expect(cfg.smtp!.password).toBe('app-specific-pw')
    expect(cfg.imap?.host).toBe('imap.gmail.com')

    // 绝不能把 flat 键塞进去（后端一个都收不到）
    expect(arg.config).not.toHaveProperty('smtp_host')
    expect(arg.config).not.toHaveProperty('email')
  })
})
