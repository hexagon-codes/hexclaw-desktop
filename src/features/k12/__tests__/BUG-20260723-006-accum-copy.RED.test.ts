import { describe, expect, it } from 'vitest'
import zhCN from '../i18n/zh-CN'

describe('BUG-20260723-006 · accumulation action follows the approved prototype copy', () => {
  it('uses 添加积累 for the toolbar, empty state, and dialog title', () => {
    expect(zhCN.accum.addOpen).toBe('添加积累')
    expect(zhCN.emptyAccum.cta).toBe('添加积累')
    expect(zhCN.accum.addTitle).toBe('添加积累')
  })
})
