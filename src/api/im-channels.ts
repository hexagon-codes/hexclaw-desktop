import { nanoid } from 'nanoid'
import { env } from '@/config/env'
import { buildDuplicateInstanceNameError } from '@/config/im-channel-errors'
import {
  CHANNEL_CONFIG_FIELDS,
  CHANNEL_HELP_TEXT,
  CHANNEL_TYPES,
  getChannelHelpText,
  getChannelMeta,
  type IMChannelConfigField,
  type IMChannelMeta,
  type IMChannelType,
} from '@/config/im-channels'

export {
  CHANNEL_CONFIG_FIELDS,
  CHANNEL_HELP_TEXT,
  CHANNEL_TYPES,
  getChannelHelpText,
  getChannelMeta,
}
export type { IMChannelConfigField, IMChannelMeta, IMChannelType }

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

// ─── Tauri Store 持久化 ──────────────────────────────

const STORE_KEY = 'im-instances'
let _store: Promise<unknown> | null = null

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

async function getStore() {
  if (!_store) {
    const p = (async () => {
      const { load } = await import('@tauri-apps/plugin-store')
      return load('im-channels.json', {
        defaults: {},
        autoSave: true,
      })
    })()
    _store = p
    p.catch(() => { _store = null })
  }
  return _store as Promise<{
    get: <T>(key: string) => Promise<T | undefined>
    set: (key: string, value: unknown) => Promise<void>
  }>
}

async function readAllInstances(): Promise<Record<string, IMInstance>> {
  try {
    const store = await getStore()
    const data = await store.get<Record<string, IMInstance>>(STORE_KEY)
    if (data) return data

    // 兼容旧格式：迁移 type-keyed 配置到多实例格式
    const legacy =
      await store.get<Record<string, { enabled: boolean; config: Record<string, string> }>>(
        'im-channels',
      )
    if (legacy && Object.keys(legacy).length > 0) {
      const migrated: Record<string, IMInstance> = {}
      for (const [type, cfg] of Object.entries(legacy)) {
        if (!CHANNEL_TYPES.find((c) => c.type === type)) continue
        const id = nanoid(10)
        const meta = getChannelMeta(type as IMChannelType)
        migrated[id] = {
          id,
          name: meta.name,
          type: type as IMChannelType,
          enabled: cfg.enabled,
          config: cfg.config,
          createdAt: Date.now(),
        }
      }
      await store.set(STORE_KEY, migrated)
      return migrated
    }

    return {}
  } catch (e) {
    console.warn('Failed to read IM instances:', e)
    return {}
  }
}

async function writeInstances(instances: Record<string, IMInstance>): Promise<boolean> {
  try {
    const store = await getStore()
    await store.set(STORE_KEY, instances)
    return true
  } catch (e) {
    console.warn('Failed to write IM instances:', e)
    return false
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
    if (e instanceof TypeError || (e instanceof Error && e.message.includes('plugin'))) {
      console.warn(`[IM] proxyApiRequest ${method} ${path} failed (non-fatal):`, e)
      return null
    }
    throw new Error(messageFromUnknownError(e))
  }
}

export function getRequiredFieldLabels(instance: Pick<IMInstance, 'type' | 'config'>): string[] {
  const fields = CHANNEL_CONFIG_FIELDS[instance.type]
  return fields.filter((f) => !f.optional && !instance.config[f.key]?.trim()).map((f) => f.label)
}

async function syncBackendInstance(
  instance: Pick<IMInstance, 'name' | 'type' | 'enabled' | 'config'>,
) {
  const missingFields = getRequiredFieldLabels(instance)
  if (missingFields.length > 0) {
    throw new Error(`Missing required fields: ${missingFields.join(', ')}`)
  }

  return proxyApiRequest('POST', '/api/v1/platforms/instances', {
    provider: instance.type,
    name: instance.name,
    enabled: instance.enabled,
    config: instance.config,
  })
}

async function deleteBackendInstance(name: string) {
  return proxyApiRequest('DELETE', `/api/v1/platforms/instances/${encodeURIComponent(name)}`)
}

interface BackendInstanceRecord {
  provider: string
  name: string
  enabled: boolean
  config?: Record<string, unknown>
}

function stableConfigString(config: Record<string, unknown> | undefined): string {
  if (!config) return '{}'
  const sortedEntries = Object.entries(config).sort(([a], [b]) => a.localeCompare(b))
  return JSON.stringify(Object.fromEntries(sortedEntries))
}

function isBackendInstanceInSync(
  local: Pick<IMInstance, 'name' | 'type' | 'enabled' | 'config'>,
  backend: BackendInstanceRecord | undefined,
): boolean {
  if (!backend) return false
  return (
    backend.name === local.name &&
    backend.provider === local.type &&
    backend.enabled === local.enabled &&
    stableConfigString(backend.config) === stableConfigString(local.config)
  )
}

async function listBackendInstances(): Promise<Map<string, BackendInstanceRecord>> {
  const result = await proxyApiRequest<{ instances?: BackendInstanceRecord[] }>('GET', '/api/v1/platforms/instances')
  const items = result?.instances || []
  return new Map(items.map((item) => [item.name, item]))
}

async function syncExistingInstancesToBackend(instances: IMInstance[]) {
  let backendByName = new Map<string, BackendInstanceRecord>()

  try {
    backendByName = await listBackendInstances()
  } catch (e) {
    console.warn('[IM] failed to list backend instances before sync, fallback to full sync:', e)
  }

  const results = await Promise.allSettled(
    instances.map(async (instance) => {
      if (isBackendInstanceInSync(instance, backendByName.get(instance.name))) {
        return
      }
      try {
        await syncBackendInstance(instance)
      } catch (e) {
        console.warn(`[IM] failed to sync instance "${instance.name}" to backend:`, e)
      }
    }),
  )
  const failures = results.filter((r) => r.status === 'rejected')
  if (failures.length > 0) {
    console.warn('[IM] sync failures:', failures.length)
  }
}

async function listStoredInstances(): Promise<IMInstance[]> {
  const all = await readAllInstances()
  return Object.values(all).sort((a, b) => a.createdAt - b.createdAt)
}

let backendSyncPromise: Promise<void> | null = null

export async function ensureIMInstancesSyncedToBackend(): Promise<void> {
  if (!backendSyncPromise) {
    backendSyncPromise = (async () => {
      const instances = await listStoredInstances()
      await syncExistingInstancesToBackend(instances)
    })().finally(() => {
      backendSyncPromise = null
    })
  }

  await backendSyncPromise
}

// ─── 公开 API ────────────────────────────────────────

/** 获取所有实例列表 */
export async function getIMInstances(): Promise<IMInstance[]> {
  return listStoredInstances()
}

/** 创建实例 */
export async function createIMInstance(
  name: string,
  type: IMChannelType,
  config: Record<string, string>,
  enabled = false,
): Promise<IMInstance> {
  const all = await readAllInstances()
  const finalName = name.trim()
  assertUniqueInstanceName(all, finalName)

  const id = nanoid(10)
  const instance: IMInstance = { id, name: finalName, type, enabled, config, createdAt: Date.now() }
  await syncBackendInstance(instance)

  all[id] = instance
  await writeInstances(all)
  return instance
}

/** 更新实例 */
export async function updateIMInstance(
  id: string,
  updates: Partial<Pick<IMInstance, 'name' | 'enabled' | 'config'>>,
): Promise<boolean> {
  const all = await readAllInstances()
  const current = all[id]
  if (!current) return false

  const next: IMInstance = {
    ...current,
    ...updates,
  }
  next.name = next.name.trim()
  assertUniqueInstanceName(all, next.name, id)

  if (current.name !== next.name) {
    await syncBackendInstance({ ...next, enabled: false })
    try {
      await deleteBackendInstance(current.name)
    } catch (e) {
      // Rollback: remove the newly created instance to avoid duplicates
      await deleteBackendInstance(next.name).catch(() => {})
      throw e
    }
    if (next.enabled) {
      await syncBackendInstance(next)
    }
  } else {
    await syncBackendInstance(next)
  }

  all[id] = next
  await writeInstances(all)
  return true
}

/** 删除实例 */
export async function deleteIMInstance(id: string): Promise<boolean> {
  const all = await readAllInstances()
  const current = all[id]
  if (!current) return false
  try {
    await deleteBackendInstance(current.name)
  } catch {
    // 后端实例可能已被外部删除（404），仍需清理本地记录
  }
  delete all[id]
  await writeInstances(all)
  return true
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
    await syncBackendInstance(instance)
    const result = await proxyApiRequest<{
      success?: boolean
      message?: string
      last_error?: string
    }>('POST', `/api/v1/platforms/instances/${encodeURIComponent(instance.name)}/test`)

    if (result) {
      return {
        success: result.success ?? false,
        message: result.message ?? result.last_error ?? 'Instance health check failed',
      }
    }
  } catch (e) {
    const { messageFromUnknownError } = await import('@/utils/errors')
    return {
      success: false,
      message: messageFromUnknownError(e),
    }
  }

  return testIMInstance(instance)
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
  const result = await proxyApiRequest<{ message?: string; error?: string }>(
    'POST', `/api/v1/platforms/instances/${encodeURIComponent(name)}/start`,
  )
  return {
    success: result != null && !result.error,
    message: result?.message || result?.error || (result == null ? 'Backend unreachable' : 'OK'),
  }
}

/** 停止实例 */
export async function stopIMInstance(name: string): Promise<{ success: boolean; message: string }> {
  const result = await proxyApiRequest<{ message?: string; error?: string }>(
    'POST', `/api/v1/platforms/instances/${encodeURIComponent(name)}/stop`,
  )
  return {
    success: result != null && !result.error,
    message: result?.message || result?.error || (result == null ? 'Backend unreachable' : 'OK'),
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
