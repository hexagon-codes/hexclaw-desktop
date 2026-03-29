/**
 * Area 1: IM channel config field keys vs backend Go struct JSON tags
 *
 * Verifies EVERY field key in CHANNEL_CONFIG_FIELDS matches the actual JSON
 * tags from the Go config structs in hexclaw/config/config.go.
 *
 * This catches silent mismatches where the frontend sends a config key
 * the backend ignores (e.g., "app_key" vs "appkey").
 */
import { describe, expect, it } from 'vitest'
import { CHANNEL_CONFIG_FIELDS, type IMChannelType } from '@/api/im-channels'

// ─── Backend JSON tags extracted from hexclaw/config/config.go ──────────
//
// These are the ACTUAL json tags from each platform config struct.
// If the backend changes, update these and the tests will catch drift.

const BACKEND_JSON_TAGS: Record<IMChannelType, {
  /** JSON tags from Go struct (excluding common name/enabled/webhook_port) */
  configFields: string[]
  /** Common fields present on all multi-instance configs */
  commonFields: string[]
}> = {
  feishu: {
    configFields: ['app_id', 'app_secret', 'verification_token'],
    commonFields: ['name', 'enabled', 'webhook_port'],
  },
  dingtalk: {
    configFields: ['app_key', 'app_secret', 'robot_code'],
    commonFields: ['name', 'enabled', 'webhook_port'],
  },
  discord: {
    configFields: ['token'],
    commonFields: ['name', 'enabled'],
  },
  telegram: {
    configFields: ['token'],
    commonFields: ['name', 'enabled'],
  },
  wechat: {
    configFields: ['app_id', 'app_secret', 'token', 'aes_key'],
    commonFields: ['name', 'enabled'],
  },
  wecom: {
    configFields: ['corp_id', 'agent_id', 'secret', 'token', 'aes_key'],
    commonFields: ['name', 'enabled', 'webhook_port'],
  },
}

describe('IM channel field alignment: frontend keys vs backend JSON tags', () => {
  const platforms = Object.keys(CHANNEL_CONFIG_FIELDS) as IMChannelType[]

  it('frontend covers all 6 platforms', () => {
    expect(platforms.sort()).toEqual(
      ['dingtalk', 'discord', 'feishu', 'telegram', 'wechat', 'wecom'].sort(),
    )
  })

  for (const platform of platforms) {
    describe(`${platform}`, () => {
      const frontendKeys = CHANNEL_CONFIG_FIELDS[platform].map((f) => f.key)
      const backendKeys = BACKEND_JSON_TAGS[platform].configFields

      it('every frontend field key exists in backend JSON tags', () => {
        const missing = frontendKeys.filter((k) => !backendKeys.includes(k))
        expect(missing).toEqual([])
      })

      it('every backend config field is exposed in the frontend', () => {
        const missing = backendKeys.filter((k) => !frontendKeys.includes(k))
        expect(missing).toEqual([])
      })

      it('field count matches between frontend and backend', () => {
        expect(frontendKeys.length).toBe(backendKeys.length)
      })

      it('field order matches (frontend fields in same order as backend struct)', () => {
        // The frontend should present fields in the same order they appear in
        // the backend struct for consistency.
        expect(frontendKeys).toEqual(backendKeys)
      })
    })
  }

  // ─── Cross-platform uniqueness ──────────────────────────────────────

  it('no platform has duplicate field keys', () => {
    for (const platform of platforms) {
      const keys = CHANNEL_CONFIG_FIELDS[platform].map((f) => f.key)
      const unique = new Set(keys)
      expect(unique.size, `${platform} has duplicate field keys`).toBe(keys.length)
    }
  })

  it('every field has both label and labelEn', () => {
    for (const platform of platforms) {
      for (const field of CHANNEL_CONFIG_FIELDS[platform]) {
        expect(field.label, `${platform}.${field.key} missing label`).toBeTruthy()
        expect(field.labelEn, `${platform}.${field.key} missing labelEn`).toBeTruthy()
      }
    }
  })

  it('every field has a non-empty placeholder', () => {
    for (const platform of platforms) {
      for (const field of CHANNEL_CONFIG_FIELDS[platform]) {
        expect(
          field.placeholder,
          `${platform}.${field.key} missing placeholder`,
        ).toBeTruthy()
      }
    }
  })

  it('secret fields use secret: true', () => {
    const nonSecretExceptions = ['app_id', 'app_key', 'robot_code', 'corp_id', 'agent_id']
    const missingSecret: string[] = []
    for (const platform of platforms) {
      for (const field of CHANNEL_CONFIG_FIELDS[platform]) {
        const lowerKey = field.key.toLowerCase()
        const shouldBeSecret =
          (lowerKey.includes('secret') || lowerKey.includes('token') || lowerKey.includes('aes_key')) &&
          !nonSecretExceptions.includes(field.key)
        if (shouldBeSecret && !field.secret) {
          missingSecret.push(`${platform}.${field.key}`)
        }
      }
    }
    expect(missingSecret).toEqual([])
  })
})
