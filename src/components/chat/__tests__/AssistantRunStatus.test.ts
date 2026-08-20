import { createI18n } from 'vue-i18n'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import en from '@/i18n/locales/en'
import zhCN from '@/i18n/locales/zh-CN'
import ugCN from '@/i18n/locales/ug-CN'
import AssistantRunStatus from '../AssistantRunStatus.vue'

function mountStatus(locale: string) {
  return mount(AssistantRunStatus, {
    props: {
      reasoningRequest: 'off',
      reasoningSupport: 'supported',
      reasoningExecution: 'unknown',
      hasVisibleAnswer: false,
      elapsedSeconds: 0,
    },
    global: {
      plugins: [
        createI18n({
          legacy: false,
          locale,
          fallbackLocale: 'zh-CN',
          messages: { 'zh-CN': zhCN, zh: zhCN, en, 'ug-CN': ugCN },
        }),
      ],
    },
  })
}

describe('AssistantRunStatus locale projection', () => {
  it.each([
    ['zh-CN', '正在生成回答…'],
    ['en', 'Generating answer…'],
    ['ug-CN', 'جاۋاب ھاسىللىنىۋاتىدۇ…'],
  ])('uses chat.assistantRun.generating in %s', (locale, expected) => {
    expect(mountStatus(locale).get('.hc-assistant-run-status').text()).toBe(expected)
  })
})
