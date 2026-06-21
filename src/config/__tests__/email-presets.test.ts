/**
 * Email provider auto-detect (SMTP / IMAP presets) + email channel field schema.
 * Mirrors the prototype EMAIL_PRESETS / emailDetect behavior.
 */
import { describe, it, expect } from 'vitest'
import {
  detectEmailProvider,
  EMAIL_PRESETS,
  CHANNEL_CONFIG_FIELDS,
  CHANNEL_TYPES,
} from '../im-channels'

describe('detectEmailProvider', () => {
  it('returns the Gmail preset for a known gmail.com address', () => {
    const p = detectEmailProvider('alice@gmail.com')
    expect(p).not.toBeNull()
    expect(p!.name).toBe('Gmail')
    expect(p!.smtp).toEqual(['smtp.gmail.com', 587])
    expect(p!.imap).toEqual(['imap.gmail.com', 993])
  })

  it('maps aliases to the same provider (googlemail.com -> Gmail)', () => {
    expect(detectEmailProvider('bob@googlemail.com')!.name).toBe('Gmail')
    expect(detectEmailProvider('c@hotmail.com')!.name).toBe('Outlook')
    expect(detectEmailProvider('d@live.com')!.name).toBe('Outlook')
    expect(detectEmailProvider('e@foxmail.com')!.name).toBe('Foxmail')
    expect(detectEmailProvider('f@me.com')!.name).toBe('iCloud')
  })

  it('is case-insensitive and trims surrounding whitespace', () => {
    expect(detectEmailProvider('  USER@QQ.COM  ')!.name).toBe('QQ 邮箱')
  })

  it('returns null for an unknown domain', () => {
    expect(detectEmailProvider('user@example.com')).toBeNull()
    expect(detectEmailProvider('user@my-company.io')).toBeNull()
  })

  it('returns null for malformed input', () => {
    expect(detectEmailProvider('')).toBeNull()
    expect(detectEmailProvider('not-an-email')).toBeNull()
    expect(detectEmailProvider('@gmail.com')).toBeNull() // missing local part
    expect(detectEmailProvider('user@')).toBeNull() // missing domain
    expect(detectEmailProvider('user@localhost')).toBeNull() // no dot in domain
    expect(detectEmailProvider('user@gmail.')).toBeNull() // trailing dot
    // @ts-expect-error — guard against non-string input
    expect(detectEmailProvider(null)).toBeNull()
    // @ts-expect-error — guard against non-string input
    expect(detectEmailProvider(undefined)).toBeNull()
  })

  it('covers all required preset domains from the spec', () => {
    const required = [
      'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com',
      'qq.com', 'foxmail.com', '163.com', '126.com', 'icloud.com', 'me.com',
      'yahoo.com', 'sina.com', 'aliyun.com',
    ]
    for (const domain of required) {
      expect(EMAIL_PRESETS[domain], `missing preset for ${domain}`).toBeDefined()
    }
  })
})

describe('email channel field schema', () => {
  it('CHANNEL_CONFIG_FIELDS.email exposes the expected keys', () => {
    const keys = CHANNEL_CONFIG_FIELDS.email.map((f) => f.key)
    expect(keys).toEqual([
      'email',
      'password',
      'from',
      'smtp_host',
      'smtp_port',
      'imap_host',
      'imap_port',
    ])
  })

  it('marks the password field as secret and optional fields as optional', () => {
    const byKey = Object.fromEntries(CHANNEL_CONFIG_FIELDS.email.map((f) => [f.key, f]))
    expect(byKey.password!.secret).toBe(true)
    expect(byKey.from!.optional).toBe(true)
    expect(byKey.imap_host!.optional).toBe(true)
    expect(byKey.imap_port!.optional).toBe(true)
    // Required (not optional): email, smtp_host, smtp_port
    expect(byKey.email!.optional).toBeUndefined()
    expect(byKey.smtp_host!.optional).toBeUndefined()
    expect(byKey.smtp_port!.optional).toBeUndefined()
  })

  it('registers email in CHANNEL_TYPES with a logo and color', () => {
    const meta = CHANNEL_TYPES.find((c) => c.type === 'email')
    expect(meta).toBeDefined()
    expect(meta!.name).toBe('邮箱')
    expect(meta!.nameEn).toBe('Email')
    expect(meta!.logo).toBeTruthy()
    expect(meta!.color).toBeTruthy()
  })
})
