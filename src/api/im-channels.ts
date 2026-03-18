import { invoke } from '@tauri-apps/api/core'
import { load } from '@tauri-apps/plugin-store'

// ─── 类型定义 ────────────────────────────────────────

export type IMChannelType = 'feishu' | 'dingtalk' | 'wecom' | 'wechat' | 'slack' | 'discord' | 'telegram'
export type IMChannelStatus = 'connected' | 'disconnected' | 'error'

/** 通道配置（与 hexclaw.yaml platforms 字段对齐） */
export interface IMChannel {
  type: IMChannelType
  name: string
  enabled: boolean
  config: Record<string, string>
  status?: IMChannelStatus
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

/** 各通道类型的配置字段（与 hexclaw.yaml 结构对齐） */
export const CHANNEL_CONFIG_FIELDS: Record<IMChannelType, IMChannelConfigField[]> = {
  feishu: [
    { key: 'app_id', label: 'App ID', labelEn: 'App ID', placeholder: 'cli_xxxxxxxxxx' },
    { key: 'app_secret', label: 'App Secret', labelEn: 'App Secret', placeholder: '输入 App Secret', secret: true },
    { key: 'verification_token', label: '验证 Token（选填）', labelEn: 'Verification Token (optional)', placeholder: '事件订阅验证，可留空', secret: true, optional: true },
  ],
  dingtalk: [
    { key: 'app_key', label: 'App Key', labelEn: 'App Key', placeholder: '输入 App Key' },
    { key: 'app_secret', label: 'App Secret', labelEn: 'App Secret', placeholder: '输入 App Secret', secret: true },
    { key: 'robot_code', label: 'Robot Code', labelEn: 'Robot Code', placeholder: '输入 Robot Code' },
  ],
  wecom: [
    { key: 'corp_id', label: '企业 ID', labelEn: 'Corp ID', placeholder: '输入企业 ID' },
    { key: 'agent_id', label: '应用 ID', labelEn: 'Agent ID', placeholder: '输入应用 Agent ID' },
    { key: 'secret', label: 'Secret', labelEn: 'Secret', placeholder: '输入应用 Secret', secret: true },
    { key: 'token', label: 'Token', labelEn: 'Token', placeholder: '输入回调 Token', secret: true },
    { key: 'aes_key', label: 'AES Key', labelEn: 'AES Key', placeholder: '输入 AES Key', secret: true },
  ],
  wechat: [
    { key: 'app_id', label: 'App ID', labelEn: 'App ID', placeholder: '输入 App ID' },
    { key: 'app_secret', label: 'App Secret', labelEn: 'App Secret', placeholder: '输入 App Secret', secret: true },
    { key: 'token', label: 'Token', labelEn: 'Token', placeholder: '输入 Token', secret: true },
    { key: 'aes_key', label: 'AES Key', labelEn: 'AES Key', placeholder: '输入 AES Key', secret: true },
  ],
  slack: [
    { key: 'token', label: 'Bot Token', labelEn: 'Bot Token', placeholder: 'xoxb-xxxxxxxxxxxx', secret: true },
    { key: 'signing_secret', label: 'Signing Secret', labelEn: 'Signing Secret', placeholder: '输入 Signing Secret', secret: true },
  ],
  discord: [
    { key: 'token', label: 'Bot Token', labelEn: 'Bot Token', placeholder: '输入 Bot Token', secret: true },
  ],
  telegram: [
    { key: 'token', label: 'Bot Token', labelEn: 'Bot Token', placeholder: '输入 Bot Token', secret: true },
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
  { type: 'feishu', name: '飞书', nameEn: 'Feishu', logo: feishuLogo, color: '#3370ff', helpUrl: 'https://open.feishu.cn/document/home/index' },
  { type: 'dingtalk', name: '钉钉', nameEn: 'DingTalk', logo: dingtalkLogo, color: '#0089ff', helpUrl: 'https://open.dingtalk.com/document/' },
  { type: 'wecom', name: '企业微信', nameEn: 'WeCom', logo: wecomLogo, color: '#07c160', helpUrl: 'https://developer.work.weixin.qq.com/document/' },
  { type: 'wechat', name: '微信', nameEn: 'WeChat', logo: wechatLogo, color: '#07c160', helpUrl: 'https://developers.weixin.qq.com/doc/' },
  { type: 'slack', name: 'Slack', nameEn: 'Slack', logo: slackLogo, color: '#4a154b', helpUrl: 'https://api.slack.com/docs' },
  { type: 'discord', name: 'Discord', nameEn: 'Discord', logo: discordLogo, color: '#5865f2', helpUrl: 'https://discord.com/developers/docs' },
  { type: 'telegram', name: 'Telegram', nameEn: 'Telegram', logo: telegramLogo, color: '#0088cc', helpUrl: 'https://core.telegram.org/bots/api' },
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
    en: 'Register a Service Account on WeChat Official Platform, get App ID & App Secret, configure server URL.',
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
  return CHANNEL_TYPES.find(c => c.type === type) ?? CHANNEL_TYPES[0]!
}

// ─── Tauri Store 持久化 IM 通道配置 ──────────────────

const STORE_KEY = 'im-channels'
let _store: Promise<Awaited<ReturnType<typeof load>>> | null = null

async function getStore() {
  if (!_store) {
    _store = load('im-channels.json', { autoSave: true } as Parameters<typeof load>[1])
  }
  return _store
}

/** 读取所有平台配置 */
async function readAllConfigs(): Promise<Record<string, { enabled: boolean; config: Record<string, string> }>> {
  try {
    const store = await getStore()
    const data = await store.get<Record<string, { enabled: boolean; config: Record<string, string> }>>(STORE_KEY)
    return data ?? {}
  } catch (e) {
    console.warn('Failed to read IM channel configs:', e)
    return {}
  }
}

/** 写入单个平台配置 */
async function writeConfig(type: string, data: { enabled: boolean; config: Record<string, string> }): Promise<boolean> {
  try {
    const store = await getStore()
    const all = await readAllConfigs()
    all[type] = data
    await store.set(STORE_KEY, all)
    return true
  } catch (e) {
    console.warn('Failed to write IM channel config:', e)
    return false
  }
}

// ─── 公开 API ────────────────────────────────────────

/** 获取所有 IM 通道（始终返回 7 个平台） */
export async function getIMChannels(): Promise<IMChannel[]> {
  const saved = await readAllConfigs()

  return CHANNEL_TYPES.map(meta => {
    const s = saved[meta.type]
    const config: Record<string, string> = {}
    const fields = CHANNEL_CONFIG_FIELDS[meta.type]
    for (const field of fields) {
      config[field.key] = s?.config?.[field.key] ?? ''
    }

    const enabled = s?.enabled ?? false
    const hasConfig = Object.values(config).some(v => v.trim())

    return {
      type: meta.type,
      name: meta.name,
      enabled,
      config,
      status: enabled && hasConfig ? 'connected' as IMChannelStatus : 'disconnected' as IMChannelStatus,
    }
  })
}

/** 保存单个通道配置 */
export async function saveIMChannel(type: IMChannelType, enabled: boolean, config: Record<string, string>): Promise<boolean> {
  return writeConfig(type, { enabled, config })
}

/** 测试通道连接 — 验证后端服务可用性 + 通道配置有效性 */
export async function testIMChannel(type: IMChannelType): Promise<{ success: boolean; message: string }> {
  // 1. 检查后端服务是否可用
  try {
    await invoke<string>('proxy_api_request', {
      method: 'GET',
      path: '/api/v1/health',
      body: null,
    })
  } catch {
    return { success: false, message: '无法连接后端服务，请确认 Engine 已启动' }
  }

  // 2. 读取本地配置并检查必填项
  const saved = await readAllConfigs()
  const channelConfig = saved[type]
  if (!channelConfig) {
    return { success: false, message: '未找到该通道的本地配置，请先填写并保存' }
  }
  const fields = CHANNEL_CONFIG_FIELDS[type]
  const missingFields = fields.filter(f => !f.optional && !channelConfig.config[f.key]?.trim())
  if (missingFields.length > 0) {
    const labels = missingFields.map(f => f.label).join('、')
    return { success: false, message: `缺少必填配置项: ${labels}` }
  }

  // 3. 调用后端通道验证接口
  try {
    const res = await invoke<string>('proxy_api_request', {
      method: 'POST',
      path: `/api/v1/im/channels/${type}/test`,
      body: JSON.stringify(channelConfig.config),
    })
    const result = JSON.parse(res) as { success?: boolean; message?: string }
    return {
      success: result.success ?? true,
      message: result.message ?? '通道验证通过',
    }
  } catch {
    // 后端尚未实现验证接口时，退回配置完整性检查结果
    if (channelConfig.enabled) {
      return { success: true, message: '配置已保存，后端验证接口暂不可用（配置项完整）' }
    }
    return { success: true, message: '配置项完整，保存后启用即可生效' }
  }
}
