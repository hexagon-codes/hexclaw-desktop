import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { createI18n, useI18n } from 'vue-i18n'
import { describe, expect, it } from 'vitest'

import en from '../i18n/en'
import ugCN from '../i18n/ug-CN'
import zhCN from '../i18n/zh-CN'

function renderCopy(locale: 'en' | 'ug-CN', messages: typeof en | typeof ugCN) {
  const CopyProbe = defineComponent({
    setup() {
      const { t } = useI18n()
      return () =>
        h('section', [
          h('p', { 'data-testid': 'weekly-hook' }, t('k12.records.weeklyHook')),
          h('p', { 'data-testid': 'basket-meta' }, t('k12.practice.basketMeta')),
        ])
    },
  })
  return mount(CopyProbe, {
    global: {
      plugins: [
        createI18n({
          legacy: false,
          locale,
          messages: { [locale]: { k12: messages } },
        }),
      ],
    },
  })
}

describe('K12 练习集文案遵循显式加入合同', () => {
  it('zh-CN 与权威原型逐字一致，不再宣称周五自动加入', () => {
    expect(zhCN.records.weeklyHook).toBe(
      '每周五 19:00 自动整理本周错题 · 同步巩固和口算热身按需准备 · 不自动加入练习集',
    )
    expect(zhCN.practice.basketMeta).toBe('从错题、本周该练或积累明确加入 · 重复加入自动去重')
  })

  it('en 只表达显式加入，并明确周五整理不会自动入集', () => {
    const wrapper = renderCopy('en', en)
    expect(wrapper.get('[data-testid="weekly-hook"]').text()).toBe(
      "Every Friday 19:00, this week's mistakes are organized automatically · consolidation and arithmetic warm-ups are prepared as needed · nothing is added to Practice Sets automatically",
    )
    expect(wrapper.get('[data-testid="basket-meta"]').text()).toBe(
      'Add explicitly from mistakes, This Week, or notes · duplicate additions are deduplicated',
    )
  })

  it('ug-CN 只表达显式加入，并明确周五整理不会自动入集', () => {
    const wrapper = renderCopy('ug-CN', ugCN)
    expect(wrapper.get('[data-testid="weekly-hook"]').text()).toBe(
      'ھەر جۈمە 19:00 دە بۇ ھەپتىلىك خاتا سوئاللار ئاپتوماتىك رەتلىنىدۇ · ماس قەدەملىك مۇستەھكەملەش ۋە ئېغىزچە ھېساب مەشىقى ئېھتىياجغا قاراپ تەييارلىنىدۇ · مەشىق توپلىمىغا ئاپتوماتىك قوشۇلمايدۇ',
    )
    expect(wrapper.get('[data-testid="basket-meta"]').text()).toBe(
      'خاتا سوئال، بۇ ھەپتە تەكرارلاش ياكى توپلامدىن ئېنىق قوشۇلىدۇ · تەكرار قوشۇش ئاپتوماتىك بىرلەشتۈرۈلىدۇ',
    )
  })
})
