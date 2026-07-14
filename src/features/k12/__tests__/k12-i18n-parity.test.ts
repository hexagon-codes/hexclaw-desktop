import { describe, it, expect } from 'vitest'
import zhCN from '../i18n/zh-CN'
import en from '../i18n/en'
import ugCN from '../i18n/ug-CN'

type Nested = { [k: string]: unknown }
function keys(obj: Nested, prefix = ''): string[] {
  const out: string[] = []
  for (const [k, v] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...keys(v as Nested, full))
    else out.push(full)
  }
  return out
}

describe('K12 i18n 三语键结构对齐（features/k12 自守，中央完整性测试不覆盖 runtime merge）', () => {
  const zhKeys = keys(zhCN as Nested).sort()
  const enKeys = keys(en as Nested).sort()
  const ugKeys = keys(ugCN as Nested).sort()

  it('zh-CN ↔ en 键完全一致', () => {
    expect(enKeys).toEqual(zhKeys)
  })
  it('zh-CN ↔ ug-CN 键完全一致', () => {
    expect(ugKeys).toEqual(zhKeys)
  })
  it('mistakeStatus 覆盖后端全部 5 态', () => {
    for (const s of ['new', 'explained', 'retried', 'mastered', 'archived']) {
      expect(zhKeys).toContain(`mistakeStatus.${s}`)
    }
  })
  it('档案模型高级区不依赖组件内中文 fallback', () => {
    for (const key of ['modelAdvanced', 'providerLabel', 'modelLabel']) {
      expect(zhKeys).toContain(`profile.${key}`)
    }
  })
})
