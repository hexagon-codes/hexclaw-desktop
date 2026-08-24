import { createI18n } from 'vue-i18n'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import en from '@/i18n/locales/en'
import zhCN from '@/i18n/locales/zh-CN'
import ugCN from '@/i18n/locales/ug-CN'
import AssistantRunStatus from '../AssistantRunStatus.vue'

type StatusProps = InstanceType<typeof AssistantRunStatus>['$props']

function mountStatus(locale: string, overrides: Partial<StatusProps> = {}) {
  return mount(AssistantRunStatus, {
    props: {
      reasoningRequest: 'off',
      reasoningSupport: 'supported',
      reasoningExecution: 'unknown',
      hasVisibleAnswer: false,
      elapsedSeconds: 0,
      ...overrides,
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
    {
      locale: 'zh-CN',
      kind: 'generating',
      props: { reasoningRequest: 'off' as const },
      expected: '正在回复…',
    },
    {
      locale: 'zh-CN',
      kind: 'preparing',
      props: { reasoningRequest: 'on' as const },
      expected: '正在回复…',
    },
    {
      locale: 'en',
      kind: 'generating',
      props: { reasoningRequest: 'off' as const },
      expected: 'Responding…',
    },
    {
      locale: 'en',
      kind: 'preparing',
      props: { reasoningRequest: 'on' as const },
      expected: 'Responding…',
    },
  ])(
    'projects $kind as the same neutral status in $locale',
    ({ locale, kind, props, expected }) => {
      const wrapper = mountStatus(locale, props)
      const status = wrapper.get('.hc-assistant-run-status')

      expect.soft(status.text()).toBe(expected)
      expect.soft(status.attributes('data-run-kind')).toBe(kind)
      expect.soft(status.attributes('role')).toBe('status')
      expect.soft(status.attributes('aria-live')).toBe('polite')
      expect.soft(status.attributes('aria-atomic')).toBe('true')
      expect
        .soft(status.get('.hc-assistant-run-status__spinner').attributes('aria-hidden'))
        .toBe('true')
    },
  )

  it('keeps the existing Uyghur generating projection unchanged', () => {
    expect(mountStatus('ug-CN').get('.hc-assistant-run-status').text()).toBe(
      'جاۋاب ھاسىللىنىۋاتىدۇ…',
    )
  })

  it.each([
    { reasoningRequest: 'off' as const, kind: 'generating' },
    { reasoningRequest: 'on' as const, kind: 'preparing' },
  ])('removes $kind when the first visible answer arrives', ({ reasoningRequest }) => {
    const wrapper = mountStatus('zh-CN', { reasoningRequest, hasVisibleAnswer: true })

    expect(wrapper.findAll('[data-component="AssistantRunStatus"]')).toHaveLength(0)
    expect(wrapper.findAll('[role="status"]')).toHaveLength(0)
  })

  it('keeps applied reasoning on the existing ThinkingProgress projection', () => {
    const wrapper = mountStatus('zh-CN', {
      reasoningRequest: 'on',
      reasoningExecution: 'applied',
      elapsedSeconds: 3,
    })

    expect(wrapper.findAll('[data-component="AssistantRunStatus"]')).toHaveLength(0)
    const thinking = wrapper.get('[data-component="ThinkingProgress"]')
    expect.soft(thinking.attributes('data-thinking-state')).toBe('running')
    expect.soft(thinking.attributes('data-reasoning-execution')).toBe('applied')
    const status = thinking.get('[role="status"]')
    expect.soft(status.attributes('aria-live')).toBe('polite')
    expect.soft(status.attributes('aria-atomic')).toBe('true')
    expect.soft(status.text()).toContain('正在深度思考')
  })
})
