/**
 * 域F 审查取证 —— IM 渠道 / 连接 / 智能机实例（2026-06-21）
 *
 * 资深 SDET 挑刺式 code review 的测试证据。**不改任何生产源码**，只暴露问题：
 *   - 逻辑 / 边界 bug：写断言「正确行为」让它 RED。
 *   - 前后端对齐：把前端契约（im-channels.ts 发出的请求体）对照后端 handler（Go 源码）的 struct。
 *
 * 前端：src/api/im-channels.ts、src/config/im-channels.ts、channels 组件、ConnectionsView。
 * 后端：hexclaw/api/handler_connections.go、handler_instances.go、handler_team.go、
 *       handler_wechat.go、api/server.go、instances/manager.go、config/config.go。
 *
 * 注：测试用 invoke mock 捕获前端真实发出的 proxy_api_request 请求体，
 * 再对照后端 Go 源码里的 JSON struct tag（契约权威）做断言。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

// ── invoke mock：捕获前端经 Tauri 命令发往后端的每一次请求 ─────────────
const invokeCalls: Array<{ cmd: string; args: Record<string, unknown> }> = []
const invoke = vi.hoisted(() =>
  vi.fn<(cmd: string, args: Record<string, unknown>) => Promise<string>>(async () => '{}'),
)
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
// 持久化层不接真实 Tauri store：返回内存 stub。
vi.mock('@tauri-apps/plugin-store', () => ({
  load: async () => {
    const mem: Record<string, unknown> = {}
    return {
      get: async (k: string) => mem[k],
      set: async (k: string, v: unknown) => {
        mem[k] = v
      },
    }
  },
}))

import {
  testConnection,
  testIMInstance,
  getConnections,
  type IMInstance,
} from '@/api/im-channels'
import { CHANNEL_TYPES, CHANNEL_CONFIG_FIELDS } from '@/config/im-channels'

// ── 后端 Go 源码作为契约权威 ─────────────────────────────────────────
const HEXCLAW = '/Users/hexagon/work/hexclaw'
// 前端-only CI 无此后端目录 → 跨仓审计套件整体跳过，避免 ENOENT。
const describeBE = fs.existsSync(HEXCLAW) ? describe : describe.skip
function goSrc(rel: string): string {
  const p = path.join(HEXCLAW, rel)
  if (!fs.existsSync(p)) return '' // 后端缺席（前端-only CI）→ 返回空，配合 describeBE 跳过
  return fs.readFileSync(p, 'utf-8')
}
const handlerConnections = (() => {
  try {
    return goSrc('api/handler_connections.go')
  } catch {
    return ''
  }
})()

beforeEach(() => {
  invoke.mockClear()
  invokeCalls.length = 0
  invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
    invokeCalls.push({ cmd, args })
    // /health 探测：默认成功（返回非空字符串）
    if (args?.path === '/health') return 'ok'
    return '{}'
  })
})

function lastProxyBody(): unknown {
  const calls = invokeCalls.filter((c) => c.cmd === 'proxy_api_request')
  const last = calls[calls.length - 1]
  if (!last) return undefined
  const raw = last.args.body
  return typeof raw === 'string' ? JSON.parse(raw) : raw
}

// ════════════════════════════════════════════════════════════════════
// F-1【严重】[前后端对齐] 邮箱「测试连接」配置 flat vs nested 完全错位，邮箱测试 100% 失败
// ════════════════════════════════════════════════════════════════════
describeBE('F-1 邮箱 connections/test 字段形状错位（flat 前端 vs nested 后端）', () => {
  // 前端 ChannelConfigModal 邮箱表单产出的 flat config（键来自 CHANNEL_CONFIG_FIELDS.email
  // + EMAIL_PRESETS 自动填充的 smtp_host/smtp_port/imap_host/imap_port）。
  const frontendEmailConfig: Record<string, string> = {
    email: 'alice@gmail.com',
    password: 'app-specific-pw',
    from: 'Alice <alice@gmail.com>',
    smtp_host: 'smtp.gmail.com',
    smtp_port: '587',
    imap_host: 'imap.gmail.com',
    imap_port: '993',
  }

  it('前端 email 配置键集合就是 CHANNEL_CONFIG_FIELDS.email（flat，无 smtp/imap 嵌套对象）', () => {
    const declaredKeys = CHANNEL_CONFIG_FIELDS.email.map((f) => f.key)
    // 证明前端契约是扁平 key（email/password/from/smtp_host/...），不存在 "smtp"/"imap" 嵌套键
    expect(declaredKeys).toContain('email')
    expect(declaredKeys).toContain('smtp_host')
    expect(declaredKeys).toContain('smtp_port')
    expect(declaredKeys).not.toContain('smtp')
    expect(declaredKeys).not.toContain('imap')
    expect(declaredKeys).not.toContain('username')
  })

  it('testConnection 把 flat 邮箱配置原样塞进 POST /connections/test 的 config', async () => {
    await testConnection({ type: 'email' as never, config: frontendEmailConfig })
    const body = lastProxyBody() as { type: string; config: Record<string, string> }
    expect(body.type).toBe('email')
    // 前端发的是 flat：config.smtp_host / config.email，而非 config.smtp.host / config.smtp.username
    expect(body.config).toHaveProperty('smtp_host')
    expect(body.config).toHaveProperty('email')
    expect(body.config).not.toHaveProperty('smtp')
    expect(body.config).not.toHaveProperty('imap')
  })

  it('后端 emailTestConfig 只识别 nested smtp.{host,username,password}，flat 键一个都收不到', () => {
    // 后端契约（handler_connections.go）权威：emailTestConfig 用 json tag "smtp" + 内嵌 host/username/password。
    expect(handlerConnections).toMatch(/SMTP\s+struct\s*\{[\s\S]*?`json:"smtp"`/)
    expect(handlerConnections).toMatch(/Host\s+string\s+`json:"host"`/)
    expect(handlerConnections).toMatch(/Username\s+string\s+`json:"username"`/)
    // 后端没有任何 flat 键的接收点
    expect(handlerConnections).not.toContain('smtp_host')
    expect(handlerConnections).not.toContain('json:"email"')
  })

  // ✅ 已修复（2026-06-22）：testConnection 对 email 先经 buildEmailTestConfig 把 flat 字段
  //    （smtp_host/email/password/...）转成后端期望的 nested smtp/imap 再 POST。
  it('邮箱 test 经 buildEmailTestConfig 产出 nested smtp.{host,username,password}（对齐后端）', async () => {
    const { buildEmailTestConfig } = await import('@/api/im-channels')
    const cfg = buildEmailTestConfig(frontendEmailConfig)
    // 后端 emailTestConfig 只读 config.smtp.host / username / password —— 三者必须非空
    expect(cfg.smtp.host, 'config.smtp.host 应来自 smtp_host').toBe('smtp.gmail.com')
    expect(cfg.smtp.username, 'config.smtp.username 应来自账号 email').toBe('alice@gmail.com')
    expect(cfg.smtp.password, 'config.smtp.password 应来自 password').toBe('app-specific-pw')
    expect(cfg.smtp.port, 'port 应为数字').toBe(587)
  })

  it('字段名也对不上：账号键 frontend=email / backend=username；端口类型 frontend=string / backend=int', () => {
    // 账号：前端 key "email"，后端 key "username"
    expect(CHANNEL_CONFIG_FIELDS.email.some((f) => f.key === 'email')).toBe(true)
    expect(handlerConnections).toContain('Username string `json:"username"`')
    // 端口：前端 String(p.smtp[1]) → 字符串；后端 Port int
    expect(typeof frontendEmailConfig.smtp_port).toBe('string')
    expect(handlerConnections).toMatch(/Port\s+int\s+`json:"port"`/)
  })
})

// ════════════════════════════════════════════════════════════════════
// F-2【中】[对齐] testConnection 仅声明 IMChannelType，但邮箱才走它；email 不在 instanceMgr
//   → GET /connections 永远不含邮箱（邮箱仅前端本地，后端 List 只返回 platform instances）
// ════════════════════════════════════════════════════════════════════
describeBE('F-2 getConnections 返回的连接列表不含邮箱（邮箱只在前端本地，后端列表来自 instanceMgr）', () => {
  it('后端 handleListConnections 数据源是 instanceMgr.List（platform 实例），不含独立邮箱连接库', () => {
    expect(handlerConnections).toContain('s.instanceMgr.List')
    // connectionCapabilities 虽然把 email 列进 case，但 List 只迭代 instanceMgr 实例。
    // 邮箱实例若从未 Upsert 到后端（前端纯本地保存），则永不出现在 GET /connections。
    expect(handlerConnections).toMatch(/case "email",/)
  })

  it('getConnections 在端点降级时返回空数组（不抛异常）', async () => {
    invoke.mockImplementation(async () => {
      throw new Error('404 not found')
    })
    const list = await getConnections()
    expect(list).toEqual([])
  })
})

// ════════════════════════════════════════════════════════════════════
// F-3【低】[对齐] provider 枚举不一致：后端 BuildAdapter 支持 slack/line/whatsapp/matrix，
//   前端 CHANNEL_TYPES 只有 7 个（无这 4 个）；slack.svg 是孤儿资源
// ════════════════════════════════════════════════════════════════════
describeBE('F-3 provider 枚举前后端不一致 + slack.svg 孤儿资源', () => {
  const buildAdapter = goSrc('instances/manager.go')

  it('后端 BuildAdapter 支持 slack/line/whatsapp/matrix，前端 CHANNEL_TYPES 不含它们', () => {
    expect(buildAdapter).toMatch(/case "slack":/)
    expect(buildAdapter).toMatch(/case "line":/)
    expect(buildAdapter).toMatch(/case "whatsapp":/)
    expect(buildAdapter).toMatch(/case "matrix":/)

    const feTypes = new Set(CHANNEL_TYPES.map((c) => c.type as string))
    expect(feTypes.has('slack')).toBe(false)
    expect(feTypes.has('line')).toBe(false)
    expect(feTypes.has('whatsapp')).toBe(false)
    expect(feTypes.has('matrix')).toBe(false)
  })

  it('slack.svg 存在于 im-logos 目录，但前端 config/im-channels.ts 从不 import 它（孤儿资源）', () => {
    const logoPath = path.resolve(__dirname, '../assets/im-logos/slack.svg')
    expect(fs.existsSync(logoPath)).toBe(true)
    const config = fs.readFileSync(path.resolve(__dirname, '../config/im-channels.ts'), 'utf-8')
    expect(config).not.toContain('slack')
  })

  it('connectionCapabilities 后端未覆盖 slack（虽 BuildAdapter 支持）→ 若 slack 实例存在，能力为空 []', () => {
    // 后端 connectionCapabilities 的 case 列表：email/feishu/dingtalk/discord/telegram/wecom/wechat
    // 缺 slack/line/whatsapp/matrix → 这些实例在连接列表里 capabilities 退化为 []。
    expect(handlerConnections).not.toMatch(/case[\s\S]{0,80}"slack"[\s\S]{0,40}return \[\]string\{"receive"/)
  })
})

// ════════════════════════════════════════════════════════════════════
// F-4【低】[对齐] handleWecomGuide 字段名与真实 WecomConfig 不一致；前端不消费该 guide
// ════════════════════════════════════════════════════════════════════
describeBE('F-4 channels/wecom/guide 字段名与真实 config 不符 + 前端不消费', () => {
  const wechatHandler = goSrc('api/handler_wechat.go')

  it('wecom guide 用 callback_token / callback_aes_key，但真实 WecomConfig json tag 是 token / aes_key', () => {
    expect(wechatHandler).toContain('callback_token')
    expect(wechatHandler).toContain('callback_aes_key')
    const cfg = goSrc('config/config.go')
    expect(cfg).toContain('Token       string `yaml:"token" json:"token"`')
    expect(cfg).toContain('AESKey      string `yaml:"aes_key" json:"aes_key"`')
    // 前端 wecom 字段（im-channels.ts）用的是 token / aes_key（与 config 对齐），而非 guide 的 callback_*
    const feWecom = CHANNEL_CONFIG_FIELDS.wecom.map((f) => f.key)
    expect(feWecom).toContain('token')
    expect(feWecom).toContain('aes_key')
    expect(feWecom).not.toContain('callback_token')
    expect(feWecom).not.toContain('callback_aes_key')
  })

  it('前端全仓无任何 channels/wecom/guide 调用（端点上线即死代码）', () => {
    const srcRoot = path.resolve(__dirname, '..')
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (ent.name === '__tests__' || ent.name === 'node_modules') continue
        const p = path.join(dir, ent.name)
        if (ent.isDirectory()) walk(p)
        else if (/\.(ts|vue)$/.test(ent.name)) {
          const txt = fs.readFileSync(p, 'utf-8')
          if (txt.includes('wecom/guide')) offenders.push(p)
        }
      }
    }
    walk(srcRoot)
    expect(offenders).toEqual([])
  })
})

// ════════════════════════════════════════════════════════════════════
// F-5【提示】[对齐 OK] wechat / wecom config 字段名前后端一致（反面验证，确认非 bug）
// ════════════════════════════════════════════════════════════════════
describeBE('F-5 wechat/wecom 实例配置字段对齐（确认无错位）', () => {
  const cfg = goSrc('config/config.go')

  it('wechat: app_id/app_secret/token/aes_key 前后端一致', () => {
    const fe = CHANNEL_CONFIG_FIELDS.wechat.map((f) => f.key).sort()
    expect(fe).toEqual(['aes_key', 'app_id', 'app_secret', 'token'].sort())
    for (const k of ['app_id', 'app_secret', 'token', 'aes_key']) {
      expect(cfg).toContain(`json:"${k}"`)
    }
  })

  it('wecom: corp_id/agent_id/secret/token/aes_key 前后端一致', () => {
    const fe = CHANNEL_CONFIG_FIELDS.wecom.map((f) => f.key).sort()
    expect(fe).toEqual(['aes_key', 'agent_id', 'corp_id', 'secret', 'token'].sort())
    for (const k of ['corp_id', 'agent_id', 'secret', 'token', 'aes_key']) {
      expect(cfg).toContain(`json:"${k}"`)
    }
  })
})

// ════════════════════════════════════════════════════════════════════
// F-6【对齐 OK】IM「测试连接」(非邮箱) 走 /im/channels/{type}/test，body=raw config（对齐）
// ════════════════════════════════════════════════════════════════════
describeBE('F-6 IM 测试入口对齐：testIMInstance → POST /im/channels/{type}/test，body 为裸 config', () => {
  it('testIMInstance POST 到 /im/channels/{type}/test，body 是裸 config（与 handleTestChannelConfig 收 raw 一致）', async () => {
    invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      invokeCalls.push({ cmd, args })
      if (args?.path === '/health') return 'ok'
      return JSON.stringify({ success: true, message: 'ok' })
    })
    const inst: IMInstance = {
      id: '__test__',
      name: 'mybot',
      type: 'telegram',
      enabled: false,
      config: { token: 'abc' },
      createdAt: Date.now(),
    }
    await testIMInstance(inst)
    const testCall = invokeCalls
      .filter((c) => c.cmd === 'proxy_api_request')
      .find((c) => String(c.args.path).includes('/im/channels/'))
    expect(testCall).toBeTruthy()
    expect(testCall!.args.path).toBe('/api/v1/im/channels/telegram/test')
    // body 是裸 config（{token:"abc"}），不是 {type,config} 包裹
    const body = JSON.parse(testCall!.args.body as string)
    expect(body).toEqual({ token: 'abc' })
    expect(body).not.toHaveProperty('type')
  })

  it('后端 handleTestChannelConfig 把整个 body 当 raw config 解码（对齐裸 config）', () => {
    const handler = goSrc('api/handler_instances.go')
    expect(handler).toContain('func (s *Server) handleTestChannelConfig')
    expect(handler).toMatch(/var raw json\.RawMessage[\s\S]*?Decode\(&raw\)/)
  })
})

// ════════════════════════════════════════════════════════════════════
// F-7【中】[边界] 实例名含中文 / 特殊字符的 URL 编码一致性（"公众号" 测试）
// ════════════════════════════════════════════════════════════════════
describeBE('F-7 实例名中文/特殊字符 URL 编码（start/stop/health/delete 路径）', () => {
  it('startIMInstance 对中文实例名 encodeURIComponent（路径含 %E5%85%AC%E4%BC%97%E5%8F%B7）', async () => {
    const { startIMInstance } = await import('@/api/im-channels')
    invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      invokeCalls.push({ cmd, args })
      return JSON.stringify({ message: 'started' })
    })
    await startIMInstance('公众号')
    const call = invokeCalls.find((c) => String(c.args.path).includes('/start'))
    expect(call).toBeTruthy()
    expect(call!.args.path).toContain(encodeURIComponent('公众号'))
    expect(call!.args.path).toContain('%E5%85%AC%E4%BC%97%E5%8F%B7')
  })

  it('后端路由用 {name} path value + r.PathValue("name")，Go ServeMux 会自动解码 %xx', () => {
    const server = goSrc('api/server.go')
    expect(server).toContain('/api/v1/platforms/instances/{name}/start')
    const handler = goSrc('api/handler_instances.go')
    expect(handler).toContain('r.PathValue("name")')
  })
})

// ════════════════════════════════════════════════════════════════════
// F-8【中】[边界] testConnection 降级判定漏 4xx/5xx：后端把业务失败返回 HTTP 200 + {ok:false}
//   但「端点不可用」靠 message 正则匹配，覆盖面有限
// ════════════════════════════════════════════════════════════════════
describeBE('F-8 testConnection 端点降级判定（正则匹配 message，覆盖面边界）', () => {
  it('错误信息含 404 / unreachable 时降级为 "Test endpoint unavailable"', async () => {
    invoke.mockImplementation(async () => {
      throw new Error('request failed: 404 not found')
    })
    const res = await testConnection({ type: 'email' as never, config: {} })
    expect(res.ok).toBe(false)
    expect(res.detail).toBe('Test endpoint unavailable')
  })

  it('【边界暴露】HTTP 500 / "internal server error" 不匹配降级正则 → 原样透传给用户（非 unavailable）', async () => {
    invoke.mockImplementation(async () => {
      throw new Error('500 internal server error')
    })
    const res = await testConnection({ type: 'email' as never, config: {} })
    expect(res.ok).toBe(false)
    // 500 不在降级正则（/404|not found|unreachable|connection refused|failed to fetch/i）里，
    // 故 detail 不是 "Test endpoint unavailable"，而是原始错误串。证明降级判定按 message 文本，脆弱。
    expect(res.detail).not.toBe('Test endpoint unavailable')
    expect(res.detail).toContain('500')
  })
})
