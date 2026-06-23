/**
 * 数据连接器 → MCP 服务器声明式映射（纯模块，可单测，零 i18n/Vue 依赖）。
 *
 * 架构决策：数据与工具统一走 MCP（MCP = 唯一数据底座，不再自研 per-provider connector）。
 * 每种数据库对应一个 stdio MCP server，但凭证注入方式各异：
 *   - mysql   → 离散 env 变量（MYSQL_HOST/PORT/USER/PASS/DB）
 *   - mongodb → 单一连接串走 env（MDB_MCP_CONNECTION_STRING）
 *   - postgres/redis → 连接串作为「最后一个 arg」（官方/社区 server 无 env 入口）
 *   - sqlite  → 文件路径走 `--db-path` flag（官方为 PyPI 包，npm 已 404）
 * 故用「字段定义 + build()」声明式表达每种类型：ConnectorConfigModal 据 fields 渲染表单，
 * 保存时调 buildMcpServerConfig() 产出 addMcpServer 所需的 {command,args,env}。
 *
 * 各包契约已从权威来源核对（2026-06-23）：
 *   mysql    @benborla29/mcp-server-mysql        env MYSQL_HOST/PORT/USER/PASS/DB（真机 E2E 证）
 *   postgres @modelcontextprotocol/server-postgres 连接串作最后 arg（README usage）
 *   redis    @gongrzhe/server-redis-mcp           "Redis URL can be specified as an argument"
 *   mongodb  mongodb-mcp-server                   env MDB_MCP_CONNECTION_STRING（mongodb-js 官方 README）
 *   sqlite   uvx mcp-server-sqlite --db-path      （@modelcontextprotocol/server-sqlite npm 404；官方为 PyPI mcp-server-sqlite）
 *
 * 🔐 URL 连接器（postgres/redis/mongodb）的 user/password 必须百分号编码：既满足 URI 规范，
 * 又使含 shell 元字符的密码不触发后端 validateMCPCommand 的危险字符拒绝（args 不过 shell，env 不校验）。
 */

/** 表单字段（纯数据，标签走 i18n key + 中文兜底，由 modal 用 t() 解析）。 */
export interface McpConnectorField {
  /** 表单/配置键（与 ConnectorInstance.config 对齐；password 命中 secure-store 机密约定） */
  key: string
  /** i18n 键（connections.connectors.form.*） */
  labelKey: string
  /** 中文兜底标签（i18n 缺失时直接用） */
  labelFallback: string
  placeholder: string
  /** 机密字段：绝不明文落 localStorage，由 useConnectorInstances 改走 secure-store */
  secret?: boolean
  /** 选填字段（空值合法，构建连接信息时省略） */
  optional?: boolean
  /** 默认值（用户留空时采用） */
  default?: string
}

/** 单类型规约：基础命令 + 字段集 + 「字段值 → {command,args,env}」构建函数。 */
export interface McpConnectorSpec {
  type: string
  /** 一键安装命令（npx / uvx） */
  command: string
  /** 表单字段（modal 渲染用） */
  fields: McpConnectorField[]
  /** 由填好的 config 产出 addMcpServer 所需的 args/env（command 取自 spec.command） */
  build: (config: Record<string, string>) => { args: string[]; env: Record<string, string> }
}

/**
 * 取字段解析值：config[key] 非空则用之，否则回退字段默认值。
 * 非机密字段 trim（host/port 误带空白会连接失败）；**机密字段（password）原样保留**——
 * 密码可含合法首尾空白，trim 会静默改密码致鉴权失败。
 */
function val(spec: McpConnectorSpec, config: Record<string, string>, key: string): string {
  const field = spec.fields.find((f) => f.key === key)
  const raw = config[key]
  const v = raw != null && raw !== '' ? raw : (field?.default ?? '')
  if (typeof v !== 'string') return ''
  return field?.secret ? v : v.trim()
}

/** IPv6 字面量 host 需用 [] 包裹才是合法 URI authority（含 ':' 且未包裹时）。IPv4/域名原样。 */
function hostForURL(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
}

/**
 * 严格 RFC 3986 百分号编码 userinfo / 路径段。
 * 比 encodeURIComponent 多编 `!'()*~`——这些 encodeURIComponent 会留原样，但后端
 * validateMCPCommand 把 `! ' ( ) ~` 视作危险字符会拒绝（密码含它们时连接串作 arg 会被拦）。
 * 编码后 arg 只剩 字母/数字/`-_.`/`%`/结构符 `:/@`，既合 URI 规范又过后端校验，且可无损 decode 回原值。
 */
function enc(s: string): string {
  return encodeURIComponent(s).replace(
    /[!'()*~]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  )
}

/** 组装连接串的 userinfo 段（`user:pass@` / `:pass@` / ``）。redis 经典无用户名，仅密码。 */
function userInfo(user: string, password: string): string {
  if (user && password) return `${enc(user)}:${enc(password)}@`
  if (user) return `${enc(user)}@`
  if (password) return `:${enc(password)}@`
  return ''
}

const HOST_FIELD = (def: string): McpConnectorField => ({
  key: 'host',
  labelKey: 'connections.connectors.form.host',
  labelFallback: '主机 Host',
  placeholder: 'localhost',
  default: def,
})
const PORT_FIELD = (def: string): McpConnectorField => ({
  key: 'port',
  labelKey: 'connections.connectors.form.port',
  labelFallback: '端口 Port',
  placeholder: def,
  default: def,
})
const USER_FIELD = (opts?: { optional?: boolean; def?: string }): McpConnectorField => ({
  key: 'user',
  labelKey: 'connections.connectors.form.user',
  labelFallback: '用户名',
  placeholder: opts?.def ?? 'root',
  default: opts?.def,
  optional: opts?.optional,
})
const PASSWORD_FIELD = (optional = true): McpConnectorField => ({
  key: 'password',
  labelKey: 'connections.connectors.form.password',
  labelFallback: '密码',
  placeholder: '••••••',
  secret: true,
  optional,
})
const DATABASE_FIELD = (optional = true): McpConnectorField => ({
  key: 'database',
  labelKey: 'connections.connectors.form.database',
  labelFallback: '数据库',
  placeholder: 'mydb',
  optional,
})

export const MCP_CONNECTOR_SPECS: Record<string, McpConnectorSpec> = {
  // MySQL：离散 env（精确变量名经真机 E2E 验证）。
  mysql: {
    type: 'mysql',
    command: 'npx',
    fields: [
      HOST_FIELD('localhost'),
      PORT_FIELD('3306'),
      USER_FIELD({ def: 'root' }),
      PASSWORD_FIELD(),
      DATABASE_FIELD(),
    ],
    build(config) {
      const env: Record<string, string> = {
        MYSQL_HOST: val(this, config, 'host'),
        MYSQL_PORT: val(this, config, 'port'),
        MYSQL_USER: val(this, config, 'user'),
      }
      const pass = val(this, config, 'password')
      const db = val(this, config, 'database')
      if (pass) env.MYSQL_PASS = pass
      if (db) env.MYSQL_DB = db
      return { args: ['-y', '@benborla29/mcp-server-mysql'], env }
    },
  },

  // PostgreSQL：连接串作为最后一个 arg（官方 server 无 env 入口）。
  postgres: {
    type: 'postgres',
    command: 'npx',
    fields: [
      HOST_FIELD('localhost'),
      PORT_FIELD('5432'),
      USER_FIELD({ optional: true }),
      PASSWORD_FIELD(),
      DATABASE_FIELD(),
    ],
    build(config) {
      const host = val(this, config, 'host')
      const port = val(this, config, 'port')
      const info = userInfo(val(this, config, 'user'), val(this, config, 'password'))
      const db = val(this, config, 'database')
      const url = `postgresql://${info}${hostForURL(host)}:${port}${db ? `/${enc(db)}` : ''}`
      return { args: ['-y', '@modelcontextprotocol/server-postgres', url], env: {} }
    },
  },

  // Redis：连接串作为最后一个 arg（README：URL as argument）；经典 Redis 仅密码无用户名。
  redis: {
    type: 'redis',
    command: 'npx',
    fields: [HOST_FIELD('localhost'), PORT_FIELD('6379'), PASSWORD_FIELD()],
    build(config) {
      const host = val(this, config, 'host')
      const port = val(this, config, 'port')
      const info = userInfo('', val(this, config, 'password'))
      const url = `redis://${info}${hostForURL(host)}:${port}`
      return { args: ['-y', '@gongrzhe/server-redis-mcp', url], env: {} }
    },
  },

  // MongoDB：单一连接串走 env MDB_MCP_CONNECTION_STRING（mongodb-js 官方）。
  mongodb: {
    type: 'mongodb',
    command: 'npx',
    fields: [
      HOST_FIELD('localhost'),
      PORT_FIELD('27017'),
      USER_FIELD({ optional: true }),
      PASSWORD_FIELD(),
      DATABASE_FIELD(),
    ],
    build(config) {
      const host = val(this, config, 'host')
      const port = val(this, config, 'port')
      const info = userInfo(val(this, config, 'user'), val(this, config, 'password'))
      const db = val(this, config, 'database')
      const url = `mongodb://${info}${hostForURL(host)}:${port}${db ? `/${enc(db)}` : ''}`
      return { args: ['-y', 'mongodb-mcp-server'], env: { MDB_MCP_CONNECTION_STRING: url } }
    },
  },

  // SQLite：官方为 PyPI 包，uvx mcp-server-sqlite --db-path <路径>（~ 由后端展开）。
  sqlite: {
    type: 'sqlite',
    command: 'uvx',
    fields: [
      {
        key: 'path',
        labelKey: 'connections.connectors.form.path',
        labelFallback: '路径',
        placeholder: '/path/to/db.sqlite',
      },
    ],
    build(config) {
      const path = val(this, config, 'path')
      return { args: ['mcp-server-sqlite', '--db-path', path], env: {} }
    },
  },

  // 语雀：社区 yuque-mcp-server，env YUQUE_TOKEN（语雀 设置 → Token）。替代旧 OAuth 占位。
  yuque: {
    type: 'yuque',
    command: 'npx',
    fields: [
      {
        key: 'token',
        labelKey: 'connections.connectors.form.token',
        labelFallback: '访问令牌 (Token)',
        placeholder: '语雀 设置 → Token 生成',
        secret: true,
      },
    ],
    build(config) {
      return { args: ['-y', 'yuque-mcp-server'], env: { YUQUE_TOKEN: val(this, config, 'token') } }
    },
  },

  // 飞书文档：官方 @larksuiteoapi/lark-mcp，`mcp -a <app_id> -s <app_secret>`（args；app 级凭证）。
  // app_secret 为机密走 secure-store（不 trim）；注：凭证作 args 不入 vault env 加密（同 pg/redis URL）。
  feishuDoc: {
    type: 'feishuDoc',
    command: 'npx',
    fields: [
      {
        key: 'app_id',
        labelKey: 'connections.connectors.form.appId',
        labelFallback: 'App ID',
        placeholder: 'cli_xxxxxxxx',
      },
      {
        key: 'app_secret',
        labelKey: 'connections.connectors.form.appSecret',
        labelFallback: 'App Secret',
        placeholder: '应用凭证 Secret',
        secret: true,
      },
    ],
    build(config) {
      return {
        args: [
          '-y',
          '@larksuiteoapi/lark-mcp',
          'mcp',
          '-a',
          val(this, config, 'app_id'),
          '-s',
          val(this, config, 'app_secret'),
        ],
        env: {},
      }
    },
  },
}

/** 该类型是否走 MCP（用于 modal/视图分流）。 */
export function isMcpConnectorType(type: string): boolean {
  return Object.prototype.hasOwnProperty.call(MCP_CONNECTOR_SPECS, type)
}

/**
 * 由连接器类型 + 表单 config 产出 addMcpServer 所需的 {command, args, env}。
 * 非 MCP 类型返回 null（调用方走原 localStorage 路径）。
 */
export function buildMcpServerConfig(
  type: string,
  config: Record<string, string>,
): { command: string; args: string[]; env: Record<string, string> } | null {
  const spec = MCP_CONNECTOR_SPECS[type]
  if (!spec) return null
  const { args, env } = spec.build(config ?? {})
  return { command: spec.command, args, env }
}
