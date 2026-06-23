import { describe, it, expect } from 'vitest'
import { MCP_CONNECTOR_SPECS, isMcpConnectorType, buildMcpServerConfig } from '../mcp-connectors'

// 走 MCP 的类型 = spec map 的键（单一事实源；曾有 MCP_CONNECTOR_TYPES 死导出，已删）。
const MCP_CONNECTOR_TYPES = Object.keys(MCP_CONNECTOR_SPECS)

// 数据与工具统一走 MCP（架构决策：MCP = 唯一数据底座）。每种数据库对应一个 stdio MCP server，
// 但凭证注入方式各异（env 离散 / env 连接串 / arg 连接串 / arg flag）。本模块用「字段 + build()」
// 声明式表达，由 ConnectorConfigModal 渲染表单、保存时产出 addMcpServer 所需 {command,args,env}。
//
// 各包契约已从权威来源核对（2026-06-23）：
//   mysql    @benborla29/mcp-server-mysql        env: MYSQL_HOST/PORT/USER/PASS/DB（真机 E2E 证）
//   postgres @modelcontextprotocol/server-postgres 连接串作为「最后一个 arg」（无 env）
//   redis    @gongrzhe/server-redis-mcp           连接串作为「最后一个 arg」（README: URL as argument）
//   mongodb  mongodb-mcp-server                   env: MDB_MCP_CONNECTION_STRING（官方 README）
//   sqlite   uvx mcp-server-sqlite --db-path <p>  （npm @modelcontextprotocol/server-sqlite 已 404，官方为 PyPI）
const DANGEROUS = '`$|;&><(){}!\\\'"~\n\r'

describe('mcp-connectors 声明式 schema', () => {
  it('MCP 连接器类型齐全（5 DB + 语雀/飞书，均走 MCP）', () => {
    expect([...MCP_CONNECTOR_TYPES].sort()).toEqual(
      ['feishuDoc', 'mongodb', 'mysql', 'postgres', 'redis', 'sqlite', 'yuque'].sort(),
    )
    for (const t of MCP_CONNECTOR_TYPES) {
      expect(isMcpConnectorType(t)).toBe(true)
      expect(MCP_CONNECTOR_SPECS[t]).toBeTruthy()
      expect(MCP_CONNECTOR_SPECS[t]!.fields.length).toBeGreaterThan(0)
    }
    // 语雀/飞书已从 OAuth 占位改走 MCP（真闭环）。token(github/notion) 与 native 仍非 MCP。
    expect(isMcpConnectorType('yuque')).toBe(true)
    expect(isMcpConnectorType('feishuDoc')).toBe(true)
    expect(isMcpConnectorType('github')).toBe(false)
    expect(isMcpConnectorType('localFolder')).toBe(false)
  })

  it('未知类型 → null', () => {
    expect(buildMcpServerConfig('github', {})).toBeNull()
    expect(buildMcpServerConfig('', {})).toBeNull()
  })

  // ── MySQL：离散 env（真机 E2E 证过的精确 env 变量名）─────────────────
  it('mysql → @benborla29/mcp-server-mysql + 离散 env', () => {
    const out = buildMcpServerConfig('mysql', {
      host: '127.0.0.1',
      port: '3306',
      user: 'root',
      password: '123456',
      database: 'dev',
    })!
    expect(out.command).toBe('npx')
    expect(out.args).toEqual(['-y', '@benborla29/mcp-server-mysql'])
    expect(out.env).toEqual({
      MYSQL_HOST: '127.0.0.1',
      MYSQL_PORT: '3306',
      MYSQL_USER: 'root',
      MYSQL_PASS: '123456',
      MYSQL_DB: 'dev',
    })
  })

  it('mysql 缺省值（host/port/user 有默认；空 password/database 省略）', () => {
    const out = buildMcpServerConfig('mysql', { database: '' })!
    expect(out.env.MYSQL_HOST).toBe('localhost')
    expect(out.env.MYSQL_PORT).toBe('3306')
    expect(out.env.MYSQL_USER).toBe('root')
    expect('MYSQL_PASS' in out.env).toBe(false)
    expect('MYSQL_DB' in out.env).toBe(false)
  })

  // ── PostgreSQL：连接串作为最后一个 arg，userinfo 必须百分号编码 ──────────
  it('postgres → 连接串作 arg，user/password 百分号编码', () => {
    const out = buildMcpServerConfig('postgres', {
      host: 'db.example.com',
      port: '5432',
      user: 'admin',
      password: 'p@ss/word',
      database: 'app',
    })!
    expect(out.command).toBe('npx')
    expect(out.args).toEqual([
      '-y',
      '@modelcontextprotocol/server-postgres',
      'postgresql://admin:p%40ss%2Fword@db.example.com:5432/app',
    ])
    expect(out.env).toEqual({})
  })

  it('postgres 无 user/database → 裸 host:port', () => {
    const out = buildMcpServerConfig('postgres', { host: 'h', port: '5432' })!
    expect(out.args[2]).toBe('postgresql://h:5432')
  })

  // ── Redis：连接串作为最后一个 arg（README 明确 URL as argument）──────────
  it('redis → @gongrzhe/server-redis-mcp + URL arg（仅密码 userinfo）', () => {
    const out = buildMcpServerConfig('redis', {
      host: '10.0.0.5',
      port: '6379',
      password: 'p@ss',
    })!
    expect(out.command).toBe('npx')
    expect(out.args).toEqual(['-y', '@gongrzhe/server-redis-mcp', 'redis://:p%40ss@10.0.0.5:6379'])
    expect(out.env).toEqual({})
  })

  it('redis 无密码 → 裸 URL', () => {
    const out = buildMcpServerConfig('redis', { host: '10.0.0.5', port: '6379' })!
    expect(out.args[2]).toBe('redis://10.0.0.5:6379')
  })

  // ── MongoDB：env MDB_MCP_CONNECTION_STRING（官方 README 的精确变量名）─────
  it('mongodb → mongodb-mcp-server + MDB_MCP_CONNECTION_STRING env', () => {
    const out = buildMcpServerConfig('mongodb', {
      host: '10.0.0.9',
      port: '27017',
      user: 'appuser',
      password: 'p@ss',
      database: 'appdb',
    })!
    expect(out.command).toBe('npx')
    expect(out.args).toEqual(['-y', 'mongodb-mcp-server'])
    expect(out.env).toEqual({
      MDB_MCP_CONNECTION_STRING: 'mongodb://appuser:p%40ss@10.0.0.9:27017/appdb',
    })
  })

  it('mongodb 无认证 → 裸 mongodb://host:port', () => {
    const out = buildMcpServerConfig('mongodb', { host: '10.0.0.9', port: '27017' })!
    expect(out.env.MDB_MCP_CONNECTION_STRING).toBe('mongodb://10.0.0.9:27017')
  })

  // ── SQLite：官方为 PyPI 包，uvx mcp-server-sqlite --db-path <路径> ──────────
  it('sqlite → uvx mcp-server-sqlite --db-path <path>', () => {
    const out = buildMcpServerConfig('sqlite', { path: '/Users/me/data.db' })!
    expect(out.command).toBe('uvx')
    expect(out.args).toEqual(['mcp-server-sqlite', '--db-path', '/Users/me/data.db'])
    expect(out.env).toEqual({})
  })

  // ── 安全：URL 连接器的 args 不得含 shell 元字符（后端 validateMCPCommand 会拒）──
  it('含特殊字符的密码经编码后，args 不含任何 shell 元字符', () => {
    const nasty = 'a$b|c;d&e>f<g(h)i{j}k!l\\m\'n"o~p'
    for (const type of ['postgres', 'redis'] as const) {
      const out = buildMcpServerConfig(type, {
        host: 'h',
        port: '1',
        user: 'u',
        password: nasty,
      })!
      const urlArg = out.args[out.args.length - 1]!
      for (const ch of DANGEROUS) {
        expect(urlArg.includes(ch)).toBe(false)
      }
      // 仍可被 decode 回原密码（编码正确而非丢弃）
      const decoded = decodeURIComponent(urlArg.split('@')[0]!.split(':').pop()!)
      expect(decoded).toBe(nasty)
    }
  })

  it('mongodb 连接串（env，非 arg）同样百分号编码 userinfo', () => {
    const out = buildMcpServerConfig('mongodb', {
      host: 'h',
      port: '27017',
      user: 'u',
      password: 'a@b/c',
    })!
    expect(out.env.MDB_MCP_CONNECTION_STRING).toBe('mongodb://u:a%40b%2Fc@h:27017')
  })

  // ── 密码含首尾空白必须原样保留（trim 会静默改密码致连接失败）──
  it('password 的首尾空白不被 trim（host/port 仍 trim）', () => {
    const out = buildMcpServerConfig('mysql', {
      host: '  127.0.0.1  ',
      port: ' 3306 ',
      user: ' root ',
      password: '  pw with space  ',
    })!
    expect(out.env.MYSQL_HOST).toBe('127.0.0.1') // 非机密：trim
    expect(out.env.MYSQL_PORT).toBe('3306')
    expect(out.env.MYSQL_USER).toBe('root')
    expect(out.env.MYSQL_PASS).toBe('  pw with space  ') // 机密：原样
  })

  it('URL 连接器密码含首尾空白原样编码（不 trim）', () => {
    const out = buildMcpServerConfig('redis', { host: 'h', port: '1', password: ' p w ' })!
    // encodeURIComponent(' p w ') = '%20p%20w%20'
    expect(out.args[2]).toBe('redis://:%20p%20w%20@h:1')
  })

  // ── IPv6 host 必须 [] 包裹才是合法 URI authority ──
  it('IPv6 host 在连接串里用 [] 包裹（postgres/redis/mongodb）', () => {
    const pg = buildMcpServerConfig('postgres', { host: '::1', port: '5432', user: 'u', password: 'p', database: 'db' })!
    expect(pg.args[2]).toBe('postgresql://u:p@[::1]:5432/db')
    expect(() => new URL(pg.args[2]!)).not.toThrow()

    const rd = buildMcpServerConfig('redis', { host: 'fe80::1', port: '6379' })!
    expect(rd.args[2]).toBe('redis://[fe80::1]:6379')

    const mg = buildMcpServerConfig('mongodb', { host: '::1', port: '27017' })!
    expect(mg.env.MDB_MCP_CONNECTION_STRING).toBe('mongodb://[::1]:27017')

    // 已是 IPv4 / 域名不受影响
    const v4 = buildMcpServerConfig('postgres', { host: '10.0.0.1', port: '5432' })!
    expect(v4.args[2]).toBe('postgresql://10.0.0.1:5432')
  })

  // ── 语雀/飞书：走 MCP（替代旧 OAuth 占位），点保存真注册 server，不再"即将上线" ──
  it('yuque → yuque-mcp-server + env YUQUE_TOKEN（token 字段 secret）', () => {
    const out = buildMcpServerConfig('yuque', { token: 'yq_tok_123' })!
    expect(out.command).toBe('npx')
    expect(out.args).toEqual(['-y', 'yuque-mcp-server'])
    expect(out.env).toEqual({ YUQUE_TOKEN: 'yq_tok_123' })
    expect(isMcpConnectorType('yuque')).toBe(true)
    const tok = MCP_CONNECTOR_SPECS['yuque']!.fields.find((f) => f.key === 'token')
    expect(tok?.secret).toBe(true)
  })

  it('feishuDoc → @larksuiteoapi/lark-mcp mcp -a <id> -s <secret>（app_secret 字段 secret）', () => {
    const out = buildMcpServerConfig('feishuDoc', { app_id: 'cli_abc', app_secret: 'sec_xyz' })!
    expect(out.command).toBe('npx')
    expect(out.args).toEqual(['-y', '@larksuiteoapi/lark-mcp', 'mcp', '-a', 'cli_abc', '-s', 'sec_xyz'])
    expect(out.env).toEqual({})
    expect(isMcpConnectorType('feishuDoc')).toBe(true)
    const sec = MCP_CONNECTOR_SPECS['feishuDoc']!.fields.find((f) => f.key === 'app_secret')
    expect(sec?.secret).toBe(true)
  })

  it('feishuDoc app_secret 含首尾空白原样（secret 不 trim）', () => {
    const out = buildMcpServerConfig('feishuDoc', { app_id: ' cli ', app_secret: ' s e c ' })!
    expect(out.args).toEqual(['-y', '@larksuiteoapi/lark-mcp', 'mcp', '-a', 'cli', '-s', ' s e c ']) // app_id trim、secret 原样
  })

  // ── 字段密钥应与 useConnectorInstances 的机密键约定对齐（password 走 secure-store）──
  it('各类型的 password 字段标记 secret', () => {
    for (const type of ['mysql', 'postgres', 'redis', 'mongodb'] as const) {
      const pw = MCP_CONNECTOR_SPECS[type]!.fields.find((f) => f.key === 'password')
      expect(pw?.secret).toBe(true)
    }
  })
})
