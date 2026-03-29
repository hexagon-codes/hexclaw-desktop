/**
 * IM Channels Edge Case Tests
 *
 * Tests boundary conditions, type completeness, and data integrity
 * of the IM channels module.
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  CHANNEL_TYPES,
  CHANNEL_CONFIG_FIELDS,
  CHANNEL_HELP_TEXT,
  getChannelMeta,
  getPlatformHookUrl,
  getChannelHelpText,
  type IMChannelType,
} from '../im-channels'

describe('CHANNEL_TYPES completeness', () => {
  it('has exactly 6 entries (feishu, dingtalk, wechat, wecom, discord, telegram)', () => {
    expect(CHANNEL_TYPES).toHaveLength(6)
  })

  it('contains no empty objects or missing type fields', () => {
    for (const channel of CHANNEL_TYPES) {
      expect(channel.type).toBeTruthy()
      expect(channel.name).toBeTruthy()
      expect(channel.nameEn).toBeTruthy()
      expect(channel.color).toBeTruthy()
      expect(channel.helpUrl).toBeTruthy()
      // logo is imported as module default — should be truthy in test env
      expect(channel.logo).toBeDefined()
    }
  })

  it('all type values are unique', () => {
    const types = CHANNEL_TYPES.map((c) => c.type)
    expect(new Set(types).size).toBe(types.length)
  })

  const expectedTypes: IMChannelType[] = ['feishu', 'dingtalk', 'wechat', 'wecom', 'discord', 'telegram']

  it('contains exactly the expected channel types', () => {
    const actualTypes = CHANNEL_TYPES.map((c) => c.type).sort()
    expect(actualTypes).toEqual([...expectedTypes].sort())
  })
})

describe('CHANNEL_CONFIG_FIELDS alignment with CHANNEL_TYPES', () => {
  it('every channel type in CHANNEL_TYPES has a matching entry in CHANNEL_CONFIG_FIELDS', () => {
    for (const channel of CHANNEL_TYPES) {
      const fields = CHANNEL_CONFIG_FIELDS[channel.type]
      expect(fields).toBeDefined()
      expect(Array.isArray(fields)).toBe(true)
      expect(fields.length).toBeGreaterThan(0)
    }
  })

  it('every key in CHANNEL_CONFIG_FIELDS corresponds to a valid channel type', () => {
    const validTypes = new Set(CHANNEL_TYPES.map((c) => c.type))
    for (const key of Object.keys(CHANNEL_CONFIG_FIELDS)) {
      expect(validTypes.has(key as IMChannelType)).toBe(true)
    }
  })

  it('every field has required properties (key, label, labelEn, placeholder)', () => {
    for (const [type, fields] of Object.entries(CHANNEL_CONFIG_FIELDS)) {
      for (const field of fields) {
        expect(field.key, `${type} field missing key`).toBeTruthy()
        expect(field.label, `${type}.${field.key} missing label`).toBeTruthy()
        expect(field.labelEn, `${type}.${field.key} missing labelEn`).toBeTruthy()
        expect(field.placeholder, `${type}.${field.key} missing placeholder`).toBeTruthy()
      }
    }
  })
})

describe('CHANNEL_HELP_TEXT alignment with CHANNEL_TYPES', () => {
  it('every channel type in CHANNEL_TYPES has a matching entry in CHANNEL_HELP_TEXT', () => {
    for (const channel of CHANNEL_TYPES) {
      const help = CHANNEL_HELP_TEXT[channel.type]
      expect(help).toBeDefined()
      expect(help.zh).toBeTruthy()
      expect(help.en).toBeTruthy()
    }
  })

  it('getChannelHelpText returns zh for zh-CN locale', () => {
    const zhText = getChannelHelpText('feishu', 'zh-CN')
    const enText = getChannelHelpText('feishu', 'en')
    expect(zhText).not.toBe(enText)
    expect(zhText).toContain('飞书')
  })

  it('getChannelHelpText returns en for non zh-CN locale', () => {
    const enText = getChannelHelpText('feishu', 'en')
    expect(enText).toContain('Feishu')
  })
})

describe('getChannelMeta', () => {
  it('returns correct meta for known types', () => {
    const feishu = getChannelMeta('feishu')
    expect(feishu.type).toBe('feishu')
    expect(feishu.name).toBe('飞书')
  })

  it('falls back to first channel for invalid type', () => {
    // Cast to bypass TypeScript — tests runtime behavior with bad data
    const meta = getChannelMeta('nonexistent' as IMChannelType)
    expect(meta).toBeDefined()
    expect(meta.type).toBe(CHANNEL_TYPES[0].type)
  })
})

describe('WechatQREvent and wechatQRStream removal', () => {
  it('WechatQREvent type is no longer exported from im-channels.ts', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../im-channels.ts'),
      'utf-8',
    )
    // The type and function were removed (marked @deprecated then deleted)
    expect(source).not.toContain('WechatQREvent')
    expect(source).not.toContain('wechatQRStream')
  })

  it('no EventSource usage remains in im-channels.ts', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../im-channels.ts'),
      'utf-8',
    )
    expect(source).not.toContain('EventSource')
    expect(source).not.toContain('qr-stream')
  })
})

describe('getPlatformHookUrl', () => {
  it('produces valid URL for normal names', () => {
    const url = getPlatformHookUrl({ name: 'my-bot', type: 'feishu' })
    expect(url).toContain('/api/v1/platforms/hooks/feishu/my-bot')
  })

  it('encodes special characters in name', () => {
    const url = getPlatformHookUrl({ name: 'bot with spaces', type: 'dingtalk' })
    expect(url).toContain('/api/v1/platforms/hooks/dingtalk/bot%20with%20spaces')
    expect(url).not.toContain('bot with spaces')
  })

  it('encodes unicode characters in name', () => {
    const url = getPlatformHookUrl({ name: '我的机器人', type: 'wechat' })
    expect(url).toContain('/api/v1/platforms/hooks/wechat/')
    expect(url).not.toContain('我的机器人') // should be URI-encoded
  })

  it('encodes slashes in name', () => {
    const url = getPlatformHookUrl({ name: 'team/bot', type: 'discord' })
    expect(url).toContain('/api/v1/platforms/hooks/discord/')
    expect(url).toContain('team%2Fbot')
  })

  it('handles empty name gracefully', () => {
    const url = getPlatformHookUrl({ name: '', type: 'telegram' })
    expect(url).toContain('/api/v1/platforms/hooks/telegram/')
  })
})

describe('wechat channel specifics', () => {
  it('wechat qr-stream endpoint is no longer referenced (removed with wechatQRStream)', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../im-channels.ts'),
      'utf-8',
    )
    // qr-stream was removed along with wechatQRStream function
    expect(source).not.toContain('/api/v1/channels/wechat/qr-stream')
  })

  it('wechat config fields include app_id, app_secret, token', () => {
    const fields = CHANNEL_CONFIG_FIELDS.wechat
    const keys = fields.map((f) => f.key)
    expect(keys).toContain('app_id')
    expect(keys).toContain('app_secret')
    expect(keys).toContain('token')
  })

  it('wechat has optional aes_key field', () => {
    const fields = CHANNEL_CONFIG_FIELDS.wechat
    const aesField = fields.find((f) => f.key === 'aes_key')
    expect(aesField).toBeDefined()
    expect(aesField?.optional).toBe(true)
  })
})
