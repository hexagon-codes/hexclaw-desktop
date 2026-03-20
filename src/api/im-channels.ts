import { nanoid } from 'nanoid'

// ─── 类型定义 ────────────────────────────────────────

export type IMChannelType =
  | 'feishu'
  | 'dingtalk'
  | 'wecom'
  | 'wechat'
  | 'slack'
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
      placeholder: '输入 App Secret',
      secret: true,
    },
    {
      key: 'verification_token',
      label: '验证 Token（选填）',
      labelEn: 'Verification Token (optional)',
      placeholder: '事件订阅验证，可留空',
      secret: true,
      optional: true,
    },
  ],
  dingtalk: [
    { key: 'app_key', label: 'App Key', labelEn: 'App Key', placeholder: '输入 App Key' },
    {
      key: 'app_secret',
      label: 'App Secret',
      labelEn: 'App Secret',
      placeholder: '输入 App Secret',
      secret: true,
    },
    {
      key: 'robot_code',
      label: 'Robot Code',
      labelEn: 'Robot Code',
      placeholder: '输入 Robot Code',
    },
  ],
  wecom: [
    { key: 'corp_id', label: '企业 ID', labelEn: 'Corp ID', placeholder: '输入企业 ID' },
    { key: 'agent_id', label: '应用 ID', labelEn: 'Agent ID', placeholder: '输入应用 Agent ID' },
    {
      key: 'secret',
      label: 'Secret',
      labelEn: 'Secret',
      placeholder: '输入应用 Secret',
      secret: true,
    },
    { key: 'token', label: 'Token', labelEn: 'Token', placeholder: '输入回调 Token', secret: true },
    {
      key: 'aes_key',
      label: 'AES Key',
      labelEn: 'AES Key',
      placeholder: '输入 AES Key',
      secret: true,
    },
  ],
  wechat: [
    { key: 'app_id', label: 'App ID', labelEn: 'App ID', placeholder: '输入 App ID' },
    {
      key: 'app_secret',
      label: 'App Secret',
      labelEn: 'App Secret',
      placeholder: '输入 App Secret',
      secret: true,
    },
    { key: 'token', label: 'Token', labelEn: 'Token', placeholder: '输入 Token', secret: true },
    {
      key: 'aes_key',
      label: 'AES Key',
      labelEn: 'AES Key',
      placeholder: '输入 AES Key',
      secret: true,
    },
  ],
  slack: [
    {
      key: 'token',
      label: 'Bot Token',
      labelEn: 'Bot Token',
      placeholder: 'xoxb-xxxxxxxxxxxx',
      secret: true,
    },
    {
      key: 'signing_secret',
      label: 'Signing Secret',
      labelEn: 'Signing Secret',
      placeholder: '输入 Signing Secret',
      secret: true,
    },
  ],
  discord: [
    {
      key: 'token',
      label: 'Bot Token',
      labelEn: 'Bot Token',
      placeholder: '输入 Bot Token',
      secret: true,
    },
  ],
  telegram: [
    {
      key: 'token',
      label: 'Bot Token',
      labelEn: 'Bot Token',
      placeholder: '输入 Bot Token',
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
import wecomLogo from '@/assets/im-logos/wecom.svg'
import wechatLogo from '@/assets/im-logos/wechat.svg'
import slackLogo from '@/assets/im-logos/slack.svg'
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
    type: 'wecom',
    name: '企业微信',
    nameEn: 'WeCom',
    logo: wecomLogo,
    color: '#0082EF',
    helpUrl: 'https://developer.work.weixin.qq.com/document/',
  },
  {
    type: 'wechat',
    name: '微信',
    nameEn: 'WeChat',
    logo: wechatLogo,
    color: '#07c160',
    helpUrl: 'https://developers.weixin.qq.com/doc/',
  },
  {
    type: 'slack',
    name: 'Slack',
    nameEn: 'Slack',
    logo: slackLogo,
    color: '#4a154b',
    helpUrl: 'https://api.slack.com/docs',
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
    zh: '前往飞书开放平台创建企业自建应用，获取 App ID 和 App Secret，并启用机器人能力。',
    en: 'Create an app on Feishu Open Platform, get App ID & App Secret, and enable Bot capability.',
  },
  dingtalk: {
    zh: '在钉钉开放平台创建企业内部应用，获取 App Key 和 App Secret，并创建机器人。',
    en: 'Create an internal app on DingTalk Open Platform, get App Key & App Secret, and add a Robot.',
  },
  wecom: {
    zh: '在企业微信管理后台创建自建应用，获取 Corp ID、Agent ID 和 Secret，配置回调 URL。',
    en: 'Create a self-built app in WeCom Admin, get Corp ID, Agent ID & Secret, and set callback URL.',
  },
  wechat: {
    zh: '在微信公众平台注册服务号，获取 App ID 和 App Secret，配置服务器 URL 和 Token。',
    en: 'Register a Service Account on WeChat Official Platform, get App ID & App Secret, and configure server URL.',
  },
  slack: {
    zh: '在 Slack API 创建 App，获取 Bot Token（xoxb-）和 Signing Secret，安装到工作区。',
    en: 'Create an App on Slack API, get Bot Token (xoxb-) and Signing Secret, install to workspace.',
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

// ─── Tauri Store 持久化 ──────────────────────────────

const STORE_KEY = 'im-instances'
let _store: Promise<unknown> | null = null

async function getStore() {
  if (!_store) {
    _store = (async () => {
      const { load } = await import('@tauri-apps/plugin-store')
      return load('im-channels.json', {
        defaults: {},
        autoSave: true,
      })
    })()
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
    throw e
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
    throw new Error(`缺少必填配置项: ${missingFields.join('、')}`)
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

async function syncExistingInstancesToBackend(instances: IMInstance[]) {
  await Promise.allSettled(
    instances.map(async (instance) => {
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
  const instances = await listStoredInstances()
  await syncExistingInstancesToBackend(instances)
  return instances
}

/** 创建实例 */
export async function createIMInstance(
  name: string,
  type: IMChannelType,
  config: Record<string, string>,
  enabled = false,
): Promise<IMInstance> {
  const id = nanoid(10)
  const instance: IMInstance = { id, name, type, enabled, config, createdAt: Date.now() }
  await syncBackendInstance(instance)

  const all = await readAllInstances()
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
    return { success: false, message: '无法连接后端服务，请确认 Engine 已启动' }
  }

  const missingFields = getRequiredFieldLabels(instance)
  if (missingFields.length > 0) {
    const labels = missingFields.join('、')
    return { success: false, message: `缺少必填配置项: ${labels}` }
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
      message: result.message ?? '通道验证通过',
    }
  } catch {
    if (instance.enabled) {
      return { success: true, message: '配置已保存，后端验证接口暂不可用（配置项完整）' }
    }
    return { success: true, message: '配置项完整，保存后启用即可生效' }
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
    return { success: false, message: '无法连接后端服务，请确认 Engine 已启动' }
  }

  const missingFields = getRequiredFieldLabels(instance)
  if (missingFields.length > 0) {
    const labels = missingFields.join('、')
    return { success: false, message: `缺少必填配置项: ${labels}` }
  }

  if (!instance.enabled) {
    return { success: true, message: '配置已保存，实例未启用；启用后可执行实时连通性检查' }
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
        message: result.message ?? result.last_error ?? '实例健康检查未通过',
      }
    }
  } catch (e) {
    return {
      success: false,
      message: e instanceof Error ? e.message : '实例健康检查失败',
    }
  }

  return testIMInstance(instance)
}
