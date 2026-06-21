/**
 * 数据连接器 API（§15.1）。
 *
 * token 只读接入 GitHub / Notion：后端验证 token、加密落盘、响应脱敏。
 * 全部经 Tauri proxy 走本地引擎；端点未上线 / 引擎降级时优雅降级，不抛崩溃。
 */

/**
 * 连接器 provider 标识。
 *
 * 后端 connector.IsValid 当前仅接受 github / notion，但前端表单的 provider 来自
 * 动态 props.types[*].id（可能含后端尚未支持的源），运行期最终由后端 400/{ok:false}
 * 裁决。故类型放宽为 string——消除 ConnectorConfigModal 里 `as ConnectorProvider`
 * 强转的"类型谎报"（伪装成只有 github/notion 而实则透传任意字符串）。
 * 已知值用模板字面量保留 IDE 提示，同时允许其它 string（H-8）。
 */
export type ConnectorProvider = 'github' | 'notion' | (string & {})

/** 脱敏连接器摘要（后端 GET /connectors 返回项，绝不含 token）。 */
export interface ConnectorSummary {
  id: string
  provider: ConnectorProvider
  name: string
  created_at: string
}

/** 数据源里的一条只读资源（仓库 / 页面）。 */
export interface ConnectorResource {
  id: string
  title: string
  url?: string
  kind?: string
  desc?: string
}

async function proxy<T = unknown>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: Record<string, unknown> | null,
): Promise<T | null> {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const text = await invoke<string>('proxy_api_request', {
      method,
      path,
      body: body ? JSON.stringify(body) : null,
    })
    return text ? (JSON.parse(text) as T) : null
  } catch (e) {
    if (e instanceof TypeError || (e instanceof Error && e.message.includes('plugin'))) {
      console.warn(`[connector] ${method} ${path} 不可用（非致命）:`, e)
      return null
    }
    throw e
  }
}

/** 列出已配置连接器（脱敏；引擎降级返空）。 */
export async function getConnectors(): Promise<ConnectorSummary[]> {
  const res = await proxy<{ connectors?: ConnectorSummary[] }>('GET', '/api/v1/connectors')
  return res?.connectors ?? []
}

/**
 * 无状态测试 token（不持久化）。返回 { ok, detail }；
 * 端点不可用时优雅返回 ok=false + 友好提示，绝不抛异常。
 */
export async function testConnector(provider: ConnectorProvider, token: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await proxy<{ ok?: boolean; detail?: string }>('POST', '/api/v1/connectors/test', { provider, token })
    if (!res) return { ok: false, detail: '测试端点不可用（引擎未连接）' }
    return { ok: !!res.ok, detail: res.detail ?? (res.ok ? '已连接' : '连接失败') }
  } catch (e) {
    const { messageFromUnknownError } = await import('@/utils/errors')
    return { ok: false, detail: messageFromUnknownError(e) }
  }
}

/** 创建连接器（后端验证 token 后加密保存）。失败抛错（含后端友好原因）。 */
export async function createConnector(provider: ConnectorProvider, name: string, token: string): Promise<ConnectorSummary> {
  const { invoke } = await import('@tauri-apps/api/core')
  const text = await invoke<string>('proxy_api_request', {
    method: 'POST',
    path: '/api/v1/connectors',
    body: JSON.stringify({ provider, name, token }),
  })
  const parsed = text ? JSON.parse(text) : null
  if (parsed && parsed.error) throw new Error(parsed.error)
  if (!parsed || !parsed.id) throw new Error('创建失败：后端未返回连接器')
  return parsed as ConnectorSummary
}

/** 删除连接器。 */
export async function deleteConnector(id: string): Promise<void> {
  await proxy('DELETE', `/api/v1/connectors/${encodeURIComponent(id)}`)
}

/** 拉取连接器的只读资源列表（真实调用 GitHub / Notion API）。 */
export async function getConnectorResources(id: string): Promise<ConnectorResource[]> {
  const res = await proxy<{ resources?: ConnectorResource[] }>('GET', `/api/v1/connectors/${encodeURIComponent(id)}/resources`)
  return res?.resources ?? []
}
