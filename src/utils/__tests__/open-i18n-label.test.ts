import { describe, expect, it, vi } from 'vitest'
import { translateOpenIdentifier } from '../open-i18n-label'

describe('translateOpenIdentifier', () => {
  it('returns an open-set identifier without asking vue-i18n to translate a missing key', () => {
    const translate = vi.fn<(path: string) => string>()
    const exists = vi.fn(() => false)

    expect(
      translateOpenIdentifier(
        translate,
        exists,
        'autonomy.category',
        'github.issues.write_label',
      ),
    ).toBe('github.issues.write_label')
    expect(exists).toHaveBeenCalledWith('autonomy.category.github.issues.write_label')
    expect(translate).not.toHaveBeenCalled()
  })

  it('uses the localized label when the closed-set key exists', () => {
    const translate = vi.fn(() => '发送消息')
    const exists = vi.fn(() => true)

    expect(
      translateOpenIdentifier(translate, exists, 'autonomy.category', 'delivery'),
    ).toBe('发送消息')
    expect(translate).toHaveBeenCalledWith('autonomy.category.delivery')
  })
})
