import feishuLogo from '@/assets/im-logos/feishu.svg'
import dingtalkLogo from '@/assets/im-logos/dingtalk.svg'
import wechatLogo from '@/assets/im-logos/wechat.svg'
import wecomLogo from '@/assets/im-logos/wecom.svg'
import slackLogo from '@/assets/im-logos/slack.svg'
import discordLogo from '@/assets/im-logos/discord.svg'
import telegramLogo from '@/assets/im-logos/telegram.svg'
import lineLogo from '@/assets/im-logos/line.svg'
import whatsappLogo from '@/assets/im-logos/whatsapp.svg'
import matrixLogo from '@/assets/im-logos/matrix.svg'
import emailLogo from '@/assets/im-logos/email.svg'

export type IMChannelType =
  | 'feishu'
  | 'dingtalk'
  | 'wechat'
  | 'wecom'
  | 'slack'
  | 'discord'
  | 'telegram'
  | 'line'
  | 'whatsapp'
  | 'matrix'
  | 'email'

export interface IMChannelConfigField {
  key: string
  label: string
  labelEn: string
  placeholder: string
  secret?: boolean
  optional?: boolean
}

export interface IMChannelMeta {
  type: IMChannelType
  name: string
  nameEn: string
  logo: string
  color: string
  helpUrl: string
}

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
  wechat: [
    { key: 'app_id', label: '公众号 AppID', labelEn: 'Official Account AppID', placeholder: 'wx...' },
    { key: 'app_secret', label: 'AppSecret', labelEn: 'AppSecret', placeholder: 'Enter AppSecret', secret: true },
    { key: 'token', label: '令牌 Token', labelEn: 'Verification Token', placeholder: 'Enter Token', secret: true },
    { key: 'aes_key', label: '消息加密密钥（选填）', labelEn: 'EncodingAESKey (optional)', placeholder: '43 characters', secret: true, optional: true },
  ],
  wecom: [
    { key: 'corp_id', label: '企业 ID', labelEn: 'Corp ID', placeholder: 'ww...' },
    { key: 'agent_id', label: '应用 AgentId', labelEn: 'Agent ID', placeholder: '1000002' },
    { key: 'secret', label: '应用 Secret', labelEn: 'App Secret', placeholder: 'Enter Secret', secret: true },
    { key: 'token', label: '回调 Token', labelEn: 'Callback Token', placeholder: 'Enter Token', secret: true },
    { key: 'aes_key', label: '回调 EncodingAESKey', labelEn: 'Callback EncodingAESKey', placeholder: '43 characters', secret: true },
  ],
  slack: [
    { key: 'token', label: 'Bot Token', labelEn: 'Bot Token', placeholder: 'xoxb-...', secret: true },
    {
      key: 'signing_secret',
      label: 'Signing Secret',
      labelEn: 'Signing Secret',
      placeholder: 'Slack Events API Signing Secret',
      secret: true,
    },
  ],
  line: [
    {
      key: 'channel_secret',
      label: 'Channel Secret',
      labelEn: 'Channel Secret',
      placeholder: 'Enter LINE Channel Secret',
      secret: true,
    },
    {
      key: 'channel_token',
      label: 'Channel Access Token',
      labelEn: 'Channel Access Token',
      placeholder: 'Enter LINE Channel Access Token',
      secret: true,
    },
  ],
  whatsapp: [
    {
      key: 'token',
      label: 'Access Token',
      labelEn: 'Access Token',
      placeholder: 'Enter WhatsApp Business access token',
      secret: true,
    },
    { key: 'phone_id', label: 'Phone Number ID', labelEn: 'Phone Number ID', placeholder: 'Enter phone number ID' },
    {
      key: 'verify_token',
      label: 'Webhook Verify Token（选填）',
      labelEn: 'Webhook Verify Token (optional)',
      placeholder: 'Token used by Meta webhook verification',
      secret: true,
      optional: true,
    },
    {
      key: 'app_secret',
      label: 'App Secret（选填）',
      labelEn: 'App Secret (optional)',
      placeholder: 'Meta App Secret for webhook signature verification',
      secret: true,
      optional: true,
    },
  ],
  matrix: [
    {
      key: 'homeserver_url',
      label: 'Homeserver URL',
      labelEn: 'Homeserver URL',
      placeholder: 'https://matrix.org',
    },
    {
      key: 'access_token',
      label: 'Access Token',
      labelEn: 'Access Token',
      placeholder: 'Enter Matrix access token',
      secret: true,
    },
    { key: 'user_id', label: 'User ID', labelEn: 'User ID', placeholder: '@bot:matrix.org' },
  ],
  email: [
    { key: 'email', label: '邮箱账号', labelEn: 'Email Account', placeholder: 'you@example.com' },
    {
      key: 'password',
      label: '密码 / 应用专用密码',
      labelEn: 'Password / App-specific Password',
      placeholder: '部分邮箱需在邮箱设置里生成应用专用密码',
      secret: true,
    },
    {
      key: 'from',
      label: '发件人 From（选填）',
      labelEn: 'From (optional)',
      placeholder: '河蟹 助理 <you@example.com>',
      optional: true,
    },
    { key: 'smtp_host', label: 'SMTP 服务器', labelEn: 'SMTP Host', placeholder: 'smtp.example.com' },
    { key: 'smtp_port', label: 'SMTP 端口', labelEn: 'SMTP Port', placeholder: '465 / 587' },
    {
      key: 'imap_host',
      label: 'IMAP 服务器（收件·选填）',
      labelEn: 'IMAP Host (receive, optional)',
      placeholder: 'imap.example.com',
      optional: true,
    },
    {
      key: 'imap_port',
      label: 'IMAP 端口（选填）',
      labelEn: 'IMAP Port (optional)',
      placeholder: '993',
      optional: true,
    },
  ],
}

/**
 * 邮箱服务商预设：按域名自动配置 SMTP / IMAP（对齐原型 EMAIL_PRESETS）。
 * smtp / imap 元组为 [host, port]。
 */
export interface EmailProviderPreset {
  name: string
  smtp: [string, number]
  imap: [string, number]
}

export const EMAIL_PRESETS: Record<string, EmailProviderPreset> = {
  'gmail.com': { name: 'Gmail', smtp: ['smtp.gmail.com', 587], imap: ['imap.gmail.com', 993] },
  'googlemail.com': { name: 'Gmail', smtp: ['smtp.gmail.com', 587], imap: ['imap.gmail.com', 993] },
  'outlook.com': { name: 'Outlook', smtp: ['smtp.office365.com', 587], imap: ['outlook.office365.com', 993] },
  'hotmail.com': { name: 'Outlook', smtp: ['smtp.office365.com', 587], imap: ['outlook.office365.com', 993] },
  'live.com': { name: 'Outlook', smtp: ['smtp.office365.com', 587], imap: ['outlook.office365.com', 993] },
  'qq.com': { name: 'QQ 邮箱', smtp: ['smtp.qq.com', 465], imap: ['imap.qq.com', 993] },
  'foxmail.com': { name: 'Foxmail', smtp: ['smtp.qq.com', 465], imap: ['imap.qq.com', 993] },
  '163.com': { name: '网易 163', smtp: ['smtp.163.com', 465], imap: ['imap.163.com', 993] },
  '126.com': { name: '网易 126', smtp: ['smtp.126.com', 465], imap: ['imap.126.com', 993] },
  'icloud.com': { name: 'iCloud', smtp: ['smtp.mail.me.com', 587], imap: ['imap.mail.me.com', 993] },
  'me.com': { name: 'iCloud', smtp: ['smtp.mail.me.com', 587], imap: ['imap.mail.me.com', 993] },
  'yahoo.com': { name: 'Yahoo', smtp: ['smtp.mail.yahoo.com', 465], imap: ['imap.mail.yahoo.com', 993] },
  'sina.com': { name: '新浪邮箱', smtp: ['smtp.sina.com', 465], imap: ['imap.sina.com', 993] },
  'aliyun.com': { name: '阿里云邮箱', smtp: ['smtp.aliyun.com', 465], imap: ['imap.aliyun.com', 993] },
}

/**
 * 根据邮箱地址自动识别服务商并返回 SMTP / IMAP 预设。
 * 无法识别（未知域名 / 非法输入）时返回 null。
 */
export function detectEmailProvider(email: string): EmailProviderPreset | null {
  if (typeof email !== 'string') return null
  const value = email.trim().toLowerCase()
  const at = value.indexOf('@')
  // 必须有本地部分（@ 不在首位）且域名含「.」
  if (at < 1) return null
  const domain = value.slice(at + 1)
  if (!domain.includes('.') || domain.startsWith('.') || domain.endsWith('.')) return null
  return EMAIL_PRESETS[domain] ?? null
}

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
    type: 'wechat',
    name: '微信公众号',
    nameEn: 'WeChat Official',
    logo: wechatLogo,
    color: '#07c160',
    helpUrl: 'https://developers.weixin.qq.com/doc/offiaccount/Getting_Started/Overview.html',
  },
  {
    type: 'wecom',
    name: '企业微信',
    nameEn: 'WeCom',
    logo: wecomLogo,
    color: '#2dae67',
    helpUrl: 'https://developer.work.weixin.qq.com/document/',
  },
  {
    type: 'slack',
    name: 'Slack',
    nameEn: 'Slack',
    logo: slackLogo,
    color: '#4a154b',
    helpUrl: 'https://api.slack.com/apis',
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
  {
    type: 'line',
    name: 'LINE',
    nameEn: 'LINE',
    logo: lineLogo,
    color: '#06c755',
    helpUrl: 'https://developers.line.biz/en/docs/messaging-api/',
  },
  {
    type: 'whatsapp',
    name: 'WhatsApp',
    nameEn: 'WhatsApp',
    logo: whatsappLogo,
    color: '#25d366',
    helpUrl: 'https://developers.facebook.com/docs/whatsapp/cloud-api/',
  },
  {
    type: 'matrix',
    name: 'Matrix',
    nameEn: 'Matrix',
    logo: matrixLogo,
    color: '#111827',
    helpUrl: 'https://spec.matrix.org/latest/client-server-api/',
  },
  {
    type: 'email',
    name: '邮箱',
    nameEn: 'Email',
    logo: emailLogo,
    color: '#3f8fd4',
    helpUrl: 'https://support.google.com/mail/answer/7126229',
  },
]

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
  wechat: {
    zh: '在微信公众平台创建公众号（服务号），获取 AppID 和 AppSecret，在"基本配置"中设置服务器 Token 和 EncodingAESKey。',
    en: 'Create an Official Account (Service) on WeChat MP. Get AppID & AppSecret, configure Token and EncodingAESKey in Basic Settings.',
  },
  wecom: {
    zh: '在企业微信管理后台创建自建应用，获取 Corp ID、Agent ID 和 Secret。在"接收消息"中配置回调 URL、Token 和 EncodingAESKey。',
    en: 'Create an internal app in WeCom admin console. Get Corp ID, Agent ID & Secret. Configure callback URL, Token and EncodingAESKey.',
  },
  slack: {
    zh: '在 Slack API 创建 App，配置 Bot Token 和 Signing Secret。事件订阅与消息发送都由 Go sidecar 的 Slack adapter 统一处理。',
    en: 'Create an app in Slack API and configure Bot Token plus Signing Secret. Events and message sending are handled by the Go sidecar Slack adapter.',
  },
  line: {
    zh: '在 LINE Developers 创建 Messaging API Channel，配置 Channel Secret 和 Channel Access Token。Webhook 验签与消息发送优先使用 LINE 官方 SDK。',
    en: 'Create a Messaging API Channel in LINE Developers and configure Channel Secret plus Channel Access Token. Webhook verification and messaging use the official LINE SDK first.',
  },
  whatsapp: {
    zh: '在 Meta for Developers 配置 WhatsApp Business Cloud API，填写 Access Token 和 Phone Number ID；Webhook Verify Token / App Secret 用于接收消息安全校验。',
    en: 'Configure WhatsApp Business Cloud API in Meta for Developers with Access Token and Phone Number ID. Webhook Verify Token / App Secret secure inbound messages.',
  },
  matrix: {
    zh: '配置 Matrix Homeserver、Bot Access Token 和 User ID。sidecar 使用 Matrix Client-Server API 完成同步收件和发件。',
    en: 'Configure Matrix Homeserver, Bot Access Token, and User ID. The sidecar uses the Matrix Client-Server API for syncing inbound events and sending messages.',
  },
  email: {
    zh: '填入邮箱账号后自动识别服务商并配置 SMTP / IMAP。部分邮箱（QQ / Gmail 等）需在邮箱设置里生成「应用专用密码」，而非登录密码。',
    en: 'Enter your email and the provider is auto-detected with SMTP / IMAP filled in. Some providers (QQ / Gmail, etc.) require an app-specific password generated in mailbox settings instead of the login password.',
  },
}

export function getChannelHelpText(type: IMChannelType, locale: string): string {
  const help = CHANNEL_HELP_TEXT[type]
  return locale === 'zh-CN' ? help.zh : help.en
}

export function getChannelMeta(type: IMChannelType): IMChannelMeta {
  return CHANNEL_TYPES.find((channel) => channel.type === type) ?? CHANNEL_TYPES[0]!
}
