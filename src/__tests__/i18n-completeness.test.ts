/**
 * i18n Completeness Tests
 *
 * Verifies that zh-CN and en locale files have identical key structures
 * and no empty translation values.
 */
import { describe, it, expect } from 'vitest'
import zhCN from '../i18n/locales/zh-CN'
import en from '../i18n/locales/en'

type NestedRecord = { [key: string]: string | NestedRecord }

/**
 * Recursively collect all leaf keys from a nested object as dot-separated paths.
 */
function collectKeys(obj: NestedRecord, prefix = ''): string[] {
  const keys: string[] = []
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      keys.push(...collectKeys(value as NestedRecord, fullKey))
    } else {
      keys.push(fullKey)
    }
  }
  return keys
}

/**
 * Recursively collect all leaf values from a nested object.
 */
function collectValues(obj: NestedRecord, prefix = ''): Array<{ key: string; value: string }> {
  const values: Array<{ key: string; value: string }> = []
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      values.push(...collectValues(value as NestedRecord, fullKey))
    } else if (typeof value === 'string') {
      values.push({ key: fullKey, value })
    }
  }
  return values
}

describe('i18n Completeness', () => {
  const zhKeys = new Set(collectKeys(zhCN as unknown as NestedRecord))
  const enKeys = new Set(collectKeys(en as unknown as NestedRecord))

  it('every key in zh-CN exists in en (no missing English translations)', () => {
    const missingInEn: string[] = []
    for (const key of zhKeys) {
      if (!enKeys.has(key)) {
        missingInEn.push(key)
      }
    }

    if (missingInEn.length > 0) {
      console.warn('Keys in zh-CN missing from en:', missingInEn)
    }
    expect(missingInEn).toEqual([])
  })

  it('every key in en exists in zh-CN (no missing Chinese translations)', () => {
    const missingInZh: string[] = []
    for (const key of enKeys) {
      if (!zhKeys.has(key)) {
        missingInZh.push(key)
      }
    }

    if (missingInZh.length > 0) {
      console.warn('Keys in en missing from zh-CN:', missingInZh)
    }
    expect(missingInZh).toEqual([])
  })

  it('wxSetup/wxQr keys were removed (wechat QR stream feature deprecated)', () => {
    // These keys were removed along with the wechatQRStream feature
    const wxKeys = [...zhKeys, ...enKeys].filter(
      (k) => k.includes('wxSetup') || k.includes('wxQr'),
    )

    // Should have 0 wxSetup/wxQr keys since the feature was removed
    expect(wxKeys).toEqual([])
  })

  it('no empty string values in zh-CN locale', () => {
    const zhValues = collectValues(zhCN as unknown as NestedRecord)
    const emptyKeys = zhValues.filter((v) => v.value === '').map((v) => v.key)

    if (emptyKeys.length > 0) {
      console.warn('Empty values in zh-CN:', emptyKeys)
    }
    expect(emptyKeys).toEqual([])
  })

  it('no empty string values in en locale', () => {
    const enValues = collectValues(en as unknown as NestedRecord)
    const emptyKeys = enValues.filter((v) => v.value === '').map((v) => v.key)

    if (emptyKeys.length > 0) {
      console.warn('Empty values in en:', emptyKeys)
    }
    expect(emptyKeys).toEqual([])
  })

  it('both locales have a reasonable number of keys (sanity check)', () => {
    expect(zhKeys.size).toBeGreaterThan(200)
    expect(enKeys.size).toBeGreaterThan(200)
    // Should be roughly the same size
    const diff = Math.abs(zhKeys.size - enKeys.size)
    expect(diff).toBeLessThan(zhKeys.size * 0.05) // allow < 5% difference
  })
})
