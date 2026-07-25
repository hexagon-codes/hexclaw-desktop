import { describe, expect, it } from 'vitest'
import en from '../i18n/en'
import ugCN from '../i18n/ug-CN'
import zhCN from '../i18n/zh-CN'

describe('current accumulation copy contract', () => {
  it('freezes the approved Chinese list/detail/delete copy', () => {
    expect(zhCN.accum.viewDetails).toBe('查看详情')
    expect(zhCN.accum.detailTitle).toBe('积累内容详情')
    expect(zhCN.accum.delete).toBe('删除')
    expect(zhCN.accum.deleteConfirmTitle).toBe('删除这条积累？')
    expect(zhCN.accum.deleteConfirmMessage).toBe(
      '将从积累列表移除；已生成的练习题和发送记录仍保留。此操作不可撤销。',
    )
  })

  it('keeps all three locales on the same accumulation key exact-set', () => {
    expect(Object.keys(en.accum).sort()).toEqual(Object.keys(zhCN.accum).sort())
    expect(Object.keys(ugCN.accum).sort()).toEqual(Object.keys(zhCN.accum).sort())
  })

  it('does not invent a metadata correction entry point', () => {
    for (const messages of [zhCN, en, ugCN]) {
      expect(
        Object.keys(messages.accum).some((key) => /correct|correction|reclass/i.test(key)),
      ).toBe(false)
    }
  })
})
