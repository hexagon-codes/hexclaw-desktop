import { nanoid } from 'nanoid'
import { env } from '@/config/env'

// ─── 类型定义 ────────────────────────────────────────

export type IMChannelType =
  | 'feishu'
  | 'dingtalk'
  | 'discord'
  | 'telegram'

/** 多实例：每个实例有唯一 id，可以同一平台添加多个 */
export interface IMInstance {
  id: string
  name: string
  type: IMChannelType
  enabled: boolean
  config: Record<string, string>
  createdAt: number
}

/** 各通道类型的配置字段定义 */
export interface IMChannelConfigField {
  key: string
  label: string
  labelEn: string
  placeholder: string
  secret?: boolean
  optional?: boolean
}

/** 各通道类型的配置字段 */
export const CHANNEL_CONFIG_FIELDS: Record<IMChannelType, IMChannelConfigField[]> = {
  feishu: [
    { key: 'app_id', label: 'App ID', labelEn: 'App ID', placeholder: 'cli_xxxxxxxxxx' },
    {
      key: 'app_secret',
      label: 'App Secret',
      labelEn: 'App Secret',
      placeholder: 'Enter App Secret',
      secret: true,
    },
    {
      key: 'verification_token',
      label: '验证 Token（选填）',
      labelEn: 'Verification Token (optional)',
      placeholder: 'Must match Feishu event subscription; leave empty if not configured',
      secret: true,
      optional: true,
    },
  ],
  dingtalk: [
    { key: 'app_key', label: 'App Key', labelEn: 'App Key', placeholder: 'Enter App Key' },
    {
      key: 'app_secret',
      label: 'App Secret',
      labelEn: 'App Secret',
      placeholder: 'Enter App Secret',
      secret: true,
    },
    {
      key: 'robot_code',
      label: 'Robot Code',
      labelEn: 'Robot Code',
      placeholder: 'Enter Robot Code',
    },
  ],
  discord: [
    {
      key: 'token',
      label: 'Bot Token',
      labelEn: 'Bot Token',
      placeholder: 'Enter Bot Token',
      secret: true,
    },
  ],
  telegram: [
    {
      key: 'token',
      label: 'Bot Token',
      labelEn: 'Bot Token',
      placeholder: 'Enter Bot Token',
      secret: true,
    },
  ],
}

/** 通道类型元数据 */
export interface IMChannelMeta {
  type: IMChannelType
  name: string
  nameEn: string
  logo: string
  color: string
  helpUrl: string
}

import feishuLogo from '@/assets/im-logos/feishu.svg'
import dingtalkLogo from '@/assets/im-logos/dingtalk.svg'
import discordLogo from '@/assets/im-logos/discord.svg'
import telegramLogo from '@/assets/im-logos/telegram.svg'

export const CHANNEL_TYPES: IMChannelMeta[] = [
  {
    type: 'feishu',
    name: '飞书',
    nameEn: 'Feishu',
    logo: feishuLogo,
    color: '#3370ff',
    helpUrl: 'https://open.feishu.cn/document/home/index',
  },
  {
    type: 'dingtalk',
    name: '钉钉',
    nameEn: 'DingTalk',
    logo: dingtalkLogo,
    color: '#0089ff',
    helpUrl: 'https://open.dingtalk.com/document/',
  },
  {
    type: 'discord',
    name: 'Discord',
    nameEn: 'Discord',
    logo: discordLogo,
    color: '#5865f2',
    helpUrl: 'https://discord.com/developers/docs',
  },
  {
    type: 'telegram',
    name: 'Telegram',
    nameEn: 'Telegram',
    logo: telegramLogo,
    color: '#0088cc',
    helpUrl: 'https://core.telegram.org/bots/api',
  },
]

/** 各平台简要配置说明 */
export const CHANNEL_HELP_TEXT: Record<IMChannelType, { zh: string; en: string }> = {
  feishu: {
    zh: '前往飞书开放平台创建企业自建应用，获取 App ID 和 App Secret，启用机器人能力。使用 WebSocket 长连接模式，无需公网地址。',
    en: 'Create an app on Feishu Open Platform, get App ID & App Secret, enable Bot capability. Uses WebSocket long connection, no public URL needed.',
  },
  dingtalk: {
    zh: '在钉钉开放平台创建企业内部应用，获取 App Key 和 App Secret，并创建机器人。使用 Stream 长连接模式，无需公网地址。',
    en: 'Create an internal app on DingTalk Open Platform, get App Key & App Secret, and add a Robot. Uses Stream long connection, no public URL needed.',
  },
  discord: {
    zh: '在 Discord Developer Portal 创建 Bot，获取 Bot Token，添加到服务器并启用消息权限。',
    en: 'Create a Bot on Discord Developer Portal, get Bot Token, add to server with message permissions.',
  },
  telegram: {
    zh: '通过 @BotFather 创建 Bot，获取 Bot Token，无需额外配置。',
    en: 'Create a Bot via @BotFather, get Bot Token. No additional configuration needed.',
  },
}

export function getChannelHelpText(type: IMChannelType, locale: string): string {
  const help = CHANNEL_HELP_TEXT[type]
  return locale === 'zh-CN' ? help.zh : help.en
}

export function getChannelMeta(type: IMChannelType): IMChannelMeta {
  return CHANNEL_TYPES.find((c) => c.type === type) ?? CHANNEL_TYPES[0]!
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
      throw new Error(`实例名称重复：${name.trim()}。请使用唯一名称`)
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

  await Promise.allSettled(
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
    await deleteBackendInstance(current.name)
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
  await deleteBackendInstance(current.name)
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
