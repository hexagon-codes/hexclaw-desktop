import { env } from '@/config/env'
import { buildDuplicateInstanceNameError } from '@/config/im-channel-errors'
import {
  CHANNEL_CONFIG_FIELDS,
  CHANNEL_HELP_TEXT,
  CHANNEL_TYPES,
  EMAIL_PRESETS,
  detectEmailProvider,
  getChannelHelpText,
  getChannelMeta,
  type EmailProviderPreset,
  type IMChannelConfigField,
  type IMChannelMeta,
  type IMChannelType,
} from '@/config/im-channels'

export {
  CHANNEL_CONFIG_FIELDS,
  CHANNEL_HELP_TEXT,
  CHANNEL_TYPES,
  EMAIL_PRESETS,
  detectEmailProvider,
  getChannelHelpText,
  getChannelMeta,
}
export type { EmailProviderPreset, IMChannelConfigField, IMChannelMeta, IMChannelType }

// ─── 类型定义 ────────────────────────────────────────

/** 多实例：每个实例有唯一 id，可以同一平台添加多个 */
export interface IMInstance {
  id: string
  name: string
  type: IMChannelType
  enabled: boolean
  config: Record<string, string>
  createdAt: number
}

export function getPlatformHookUrl(instance: Pick<IMInstance, 'name' | 'type'>): string {
  return `${env.apiBase}/api/v1/platforms/hooks/${instance.type}/${encodeURIComponent(instance.name)}`
}

// ─── Sidecar 持久化：Go instances.Manager 是唯一事实源 ─────────────

function normalizeInstanceName(name: string): string {
  return name.trim().toLowerCase()
}

function assertUniqueInstanceName(
  instances: Record<string, IMInstance>,
  name: string,
  excludeId?: string,
) {
  const normalizedTargetName = normalizeInstanceName(name)
  if (!normalizedTargetName) return

  for (const instance of Object.values(instances)) {
    if (instance.id === excludeId) continue
    if (normalizeInstanceName(instance.name) === normalizedTargetName) {
      throw new Error(buildDuplicateInstanceNameError(name))
    }
  }
}

async function proxyApiRequest<T = Record<string, unknown>>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: Record<string, unknown> | null,
): Promise<T | null> {
  const { messageFromUnknownError } = await import('@/utils/errors')
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const text = await invoke<string>('proxy_api_request', {
      method,
      path,
      body: body ? JSON.stringify(body) : null,
    })
    return text ? (JSON.parse(text) as T) : null
  } catch (e) {
    throw new Error(messageFromUnknownError(e))
  }
}

const RUNTIME_CONNECTING_RE =
  /(stream\s*未连接|连接中|请稍候重试|connecting|not connected|please.*retry|please.*wait)/i
const RUNTIME_TEST_RETRY_DELAYS_MS = [300, 900]

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function normalizeRuntimeTestResult(result: {
  success?: boolean
  message?: string
  last_error?: string
}): { success: boolean; message: string } {
  return {
    success: result.success ?? false,
    message: result.message ?? result.last_error ?? 'Instance health check failed',
  }
}

function isTransientRuntimeConnecting(result: { success: boolean; message: string }): boolean {
  return !result.success && RUNTIME_CONNECTING_RE.test(result.message)
}

export function getRequiredFieldLabels(instance: Pick<IMInstance, 'type' | 'config'>): string[] {
  const fields = CHANNEL_CONFIG_FIELDS[instance.type]
  return fields.filter((f) => !f.optional && !instance.config[f.key]?.trim()).map((f) => f.label)
}

function validateInstanceConfig(instance: Pick<IMInstance, 'type' | 'config'>) {
  const missingFields = getRequiredFieldLabels(instance)
  if (missingFields.length > 0) {
    throw new Error(`Missing required fields: ${missingFields.join(', ')}`)
  }
}

interface BackendInstanceRecord {
  id: string
  provider: string
  name: string
  enabled: boolean
  status?: string
  last_error?: string
  config?: Record<string, unknown>
  created_at?: string
  updated_at?: string
}

function backendToIMInstance(item: BackendInstanceRecord): IMInstance {
  const type = item.provider as IMChannelType
  return {
    id: item.id,
    name: item.name,
    type,
    enabled: item.enabled,
    config: Object.fromEntries(
      Object.entries(item.config || {}).map(([key, value]) => [key, value == null ? '' : String(value)]),
    ),
    createdAt: Date.parse(item.created_at || item.updated_at || '') || 0,
  }
}

async function listBackendInstances(): Promise<BackendInstanceRecord[]> {
  const result = await proxyApiRequest<{ instances?: BackendInstanceRecord[] }>('GET', '/api/v1/platforms/instances')
  return result?.instances || []
}

/** 启动期探活：GET 一次 sidecar 实例列表确认后端可达（sidecar 即唯一事实源，无本地→后端同步）。 */
export async function probeIMChannelsBackend(): Promise<void> {
  await listBackendInstances()
}

// ─── 公开 API ────────────────────────────────────────

/** 获取所有实例列表 */
export async function getIMInstances(): Promise<IMInstance[]> {
  const items = await listBackendInstances()
  return items.map(backendToIMInstance).sort((a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name))
}

/** 创建实例 */
export async function createIMInstance(
  name: string,
  type: IMChannelType,
  config: Record<string, string>,
  enabled = false,
): Promise<IMInstance> {
  const existing = await getIMInstances()
  const all = Object.fromEntries(existing.map((instance) => [instance.id, instance]))
  const finalName = name.trim()
  assertUniqueInstanceName(all, finalName)
  validateInstanceConfig({ type, config })

  const result = await proxyApiRequest<BackendInstanceRecord>('POST', '/api/v1/platforms/instances', {
    provider: type,
    name: finalName,
    enabled,
    config,
  })
  if (!result) throw new Error('Backend did not return saved instance')
  return backendToIMInstance(result)
}

/** 更新实例 */
export async function updateIMInstance(
  id: string,
  updates: Partial<Pick<IMInstance, 'name' | 'enabled' | 'config'>>,
): Promise<boolean> {
  const existing = await getIMInstances()
  const all = Object.fromEntries(existing.map((instance) => [instance.id, instance]))
  const current = all[id]
  if (!current) return false

  const next: IMInstance = {
    ...current,
    ...updates,
  }
  next.name = next.name.trim()
  assertUniqueInstanceName(all, next.name, id)
  // BUG-20260702：仅当本次更新触碰 config 时才做必填校验。纯 enabled 启停/改名不应被
  // 历史实例的配置完整性拦死（配置校验权威在后端，前端只在用户编辑配置时提前拦）。
  if (updates.config !== undefined) {
    validateInstanceConfig(next)
  }

  const result = await proxyApiRequest<BackendInstanceRecord>(
    'PUT',
    `/api/v1/platforms/instances/by-id/${encodeURIComponent(id)}`,
    {
      provider: next.type,
      name: next.name,
      enabled: next.enabled,
      config: next.config,
    },
  )
  return !!result
}

/** 删除实例 */
export async function deleteIMInstance(id: string): Promise<boolean> {
  const result = await proxyApiRequest<{ message?: string }>(
    'DELETE',
    `/api/v1/platforms/instances/by-id/${encodeURIComponent(id)}`,
  )
  return !!result
}

/** 测试实例连接 */
export async function testIMInstance(
  instance: IMInstance,
): Promise<{ success: boolean; message: string }> {
  const { invoke } = await import('@tauri-apps/api/core')

  try {
    await invoke<string>('proxy_api_request', {
      method: 'GET',
      path: '/health',
      body: null,
    })
  } catch {
    return { success: false, message: 'Cannot connect to backend. Please ensure Engine is running.' }
  }

  const missingFields = getRequiredFieldLabels(instance)
  if (missingFields.length > 0) {
    const labels = missingFields.join(', ')
    return { success: false, message: `Missing required fields: ${labels}` }
  }

  try {
    const res = await invoke<string>('proxy_api_request', {
      method: 'POST',
      path: `/api/v1/im/channels/${instance.type}/test`,
      body: JSON.stringify(instance.config),
    })
    const result = JSON.parse(res) as { success?: boolean; message?: string }
    return {
      success: result.success ?? true,
      message: result.message ?? 'Channel verified successfully',
    }
  } catch (e) {
    const { messageFromUnknownError } = await import('@/utils/errors')
    return { success: false, message: `Connection test failed: ${messageFromUnknownError(e)}` }
  }
}

/**
 * 通用「测试连接」：POST /api/v1/connections/test。
 *
 * 连接中心统一测试入口（邮箱 / IM 通道），后端实现独立于平台实例 lifecycle。
 * 后端端点不可用（404 / 网络不通）时优雅降级，返回 ok=false + 友好提示，绝不抛异常。
 */
/** 邮箱 nested 测试配置 — 对齐后端 emailTestConfig（config.smtp / config.imap）。 */
export interface EmailTestConfig {
  smtp: { host: string; port: number; username: string; password: string; from: string }
  imap?: { host: string; port: number; username: string; password: string }
}

/** 把邮箱连接的扁平表单字段转成后端 /connections/test 期望的 nested smtp/imap 结构。
 *  后端 emailTestConfig 从 config.smtp.{host,port,username,password,from} 读取；
 *  bug 2026-06-22：前端此前直接发扁平字段（smtp_host 等），后端读 config.smtp.* 全空 → 邮箱测试 100% 失败。 */
export function buildEmailTestConfig(flat: Record<string, string>): EmailTestConfig {
  const account = (flat.email || '').trim()
  const password = flat.password || ''
  const cfg: EmailTestConfig = {
    smtp: {
      host: (flat.smtp_host || '').trim(),
      port: Number.parseInt(flat.smtp_port || '0', 10) || 0,
      username: account,
      password,
      from: (flat.from || '').trim() || account,
    },
  }
  const imapHost = (flat.imap_host || '').trim()
  if (imapHost) {
    cfg.imap = {
      host: imapHost,
      port: Number.parseInt(flat.imap_port || '0', 10) || 0,
      username: account,
      password,
    }
  }
  return cfg
}

export async function testConnection(
  payload: { type: IMChannelType; config: EmailTestConfig | Record<string, unknown> },
): Promise<{ ok: boolean; detail: string }> {
  const { invoke } = await import('@tauri-apps/api/core')
  try {
    const res = await invoke<string>('proxy_api_request', {
      method: 'POST',
      path: '/api/v1/connections/test',
      body: JSON.stringify({ type: payload.type, config: payload.config }),
    })
    const parsed = res ? (JSON.parse(res) as { ok?: boolean; success?: boolean; detail?: string; message?: string }) : null
    if (!parsed) {
      return { ok: false, detail: 'Test endpoint unavailable' }
    }
    return {
      ok: parsed.ok ?? parsed.success ?? false,
      detail: parsed.detail ?? parsed.message ?? (parsed.ok ?? parsed.success ? 'Connection OK' : 'Connection test failed'),
    }
  } catch (e) {
    const { messageFromUnknownError } = await import('@/utils/errors')
    return { ok: false, detail: messageFromUnknownError(e) }
  }
}

/**
 * 连接摘要（脱敏只读，GET /api/v1/connections 返回项）。
 * 绝不含凭据；capabilities 由 provider 派生（收件 / 发送 / 读取 / 发布）。
 */
export interface ConnectionSummary {
  id: string
  provider: string
  name: string
  capabilities: string[]
  status: string
  enabled: boolean
}

/**
 * 连接中心脱敏只读列表：GET /api/v1/connections（一处存）。
 *
 * 供 cron 投递目标「从连接库下拉选」按稳定 id 引用（§5 一处存处处引）。
 * 端点未上线 / 引擎降级时优雅返回空列表，绝不抛异常（调用方退回通用渠道类型）。
 */
export async function getConnections(): Promise<ConnectionSummary[]> {
  try {
    const res = await proxyApiRequest<{ connections?: ConnectionSummary[]; total?: number }>('GET', '/api/v1/connections')
    return res?.connections ?? []
  } catch {
    return []
  }
}

/** 对已保存实例执行真实运行时健康检查 */
export async function testSavedIMInstanceRuntime(
  instance: IMInstance,
): Promise<{ success: boolean; message: string }> {
  const { invoke } = await import('@tauri-apps/api/core')

  try {
    await invoke<string>('proxy_api_request', {
      method: 'GET',
      path: '/health',
      body: null,
    })
  } catch {
    return { success: false, message: 'Cannot connect to backend. Please ensure Engine is running.' }
  }

  const missingFields = getRequiredFieldLabels(instance)
  if (missingFields.length > 0) {
    const labels = missingFields.join(', ')
    return { success: false, message: `Missing required fields: ${labels}` }
  }

  if (!instance.enabled) {
    return { success: true, message: 'Config saved. Instance is disabled; enable it to run connectivity check.' }
  }

  try {
    const path = `/api/v1/platforms/instances/by-id/${encodeURIComponent(instance.id)}/test`
    for (let attempt = 0; attempt <= RUNTIME_TEST_RETRY_DELAYS_MS.length; attempt++) {
      const result = await proxyApiRequest<{
        success?: boolean
        message?: string
        last_error?: string
      }>('POST', path)

      if (!result) break
      const normalized = normalizeRuntimeTestResult(result)
      if (!isTransientRuntimeConnecting(normalized) || attempt === RUNTIME_TEST_RETRY_DELAYS_MS.length) {
        return normalized
      }
      await sleep(RUNTIME_TEST_RETRY_DELAYS_MS[attempt]!)
    }
  } catch (e) {
    const { messageFromUnknownError } = await import('@/utils/errors')
    return {
      success: false,
      message: messageFromUnknownError(e),
    }
  }

  return { success: false, message: 'Instance runtime test did not return a result' }
}

// ─── 实例运行时控制 ─────────────────────────────────

/** 实例健康状态 */
export interface IMInstanceHealth {
  name: string
  provider: string
  status: string  // running | stopped | error
  enabled: boolean
  last_error?: string
  uptime?: number
}

/** 启动实例 */
export async function startIMInstance(name: string): Promise<{ success: boolean; message: string }> {
  try {
    const result = await proxyApiRequest<{ message?: string; error?: string }>(
      'POST', `/api/v1/platforms/instances/${encodeURIComponent(name)}/start`,
    )
    return {
      success: result != null && !result.error,
      message: result?.message || result?.error || (result == null ? 'Backend unreachable' : 'OK'),
    }
  } catch (e) {
    const { messageFromUnknownError } = await import('@/utils/errors')
    return { success: false, message: messageFromUnknownError(e) }
  }
}

/** 停止实例 */
export async function stopIMInstance(name: string): Promise<{ success: boolean; message: string }> {
  try {
    const result = await proxyApiRequest<{ message?: string; error?: string }>(
      'POST', `/api/v1/platforms/instances/${encodeURIComponent(name)}/stop`,
    )
    return {
      success: result != null && !result.error,
      message: result?.message || result?.error || (result == null ? 'Backend unreachable' : 'OK'),
    }
  } catch (e) {
    const { messageFromUnknownError } = await import('@/utils/errors')
    return { success: false, message: messageFromUnknownError(e) }
  }
}

/** 获取单个实例健康状态 */
export async function getIMInstanceHealth(name: string): Promise<IMInstanceHealth | null> {
  return proxyApiRequest<IMInstanceHealth>(
    'GET', `/api/v1/platforms/instances/${encodeURIComponent(name)}/health`,
  )
}

/** 获取所有实例健康状态 */
export async function listIMInstancesHealth(): Promise<IMInstanceHealth[]> {
  const result = await proxyApiRequest<{ instances?: IMInstanceHealth[] }>(
    'GET', '/api/v1/platforms/instances/health',
  )
  return result?.instances || []
}
