import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ReasoningPolicySelect from '../ReasoningPolicySelect.vue'
import zhCN from '@/i18n/locales/zh-CN'

function makeI18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': zhCN },
  })
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('ReasoningPolicySelect', () => {
  it('只展示精确模型声明的 reasoning_effort 档位并发出 typed policy', async () => {
    const wrapper = mount(ReasoningPolicySelect, {
      attachTo: document.body,
      props: {
        modelValue: { mode: 'auto' },
        scope: 'global',
        support: 'supported',
        control: {
          dialect: 'reasoning_effort',
          on: 'high',
          off: 'off',
          allowed_efforts: ['low', 'high'],
        },
      },
      global: { plugins: [makeI18n()] },
    })

    await wrapper.get('.hc-select__trigger').trigger('click')
    await flushPromises()

    const labels = Array.from(document.body.querySelectorAll('.hc-select__option')).map((option) =>
      option.textContent?.trim(),
    )
    expect(labels).toEqual(['自动（推荐）', '低', '高', '关闭'])
    expect(labels).not.toContain('跟随全局（默认）')
    expect(labels).not.toContain('中')

    const high = Array.from(document.body.querySelectorAll<HTMLElement>('.hc-select__option')).find(
      (option) => option.textContent?.trim() === '高',
    )
    high!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))

    const updates = wrapper.emitted('update:modelValue') ?? []
    expect(updates[updates.length - 1]).toEqual([
      { mode: 'effort', effort: 'high' },
    ])
  })

  it('Agent 的布尔模型只展示继承、自动、开关，不伪造强度', async () => {
    const wrapper = mount(ReasoningPolicySelect, {
      attachTo: document.body,
      props: {
        modelValue: { mode: 'inherit' },
        scope: 'agent',
        support: 'supported',
        control: { dialect: 'think', on: true, off: false },
      },
      global: { plugins: [makeI18n()] },
    })

    expect(wrapper.get('.hc-select__label').text()).toBe('跟随全局（默认）')
    await wrapper.get('.hc-select__trigger').trigger('click')
    await flushPromises()

    const labels = Array.from(document.body.querySelectorAll('.hc-select__option')).map((option) =>
      option.textContent?.trim(),
    )
    expect(labels).toEqual(['跟随全局（默认）', '自动（推荐）', '开启', '关闭'])
    expect(labels).not.toContain('高')
  })

  it.each([
    ['unknown', '思考待检测'],
    ['unsupported', '不支持思考'],
  ] as const)('%s 能力保持控件位置但置灰并解释原因', (support, label) => {
    const wrapper = mount(ReasoningPolicySelect, {
      props: {
        modelValue: { mode: 'auto' },
        scope: 'global',
        support,
      },
      global: { plugins: [makeI18n()] },
    })

    expect(wrapper.get('.hc-select__trigger').attributes('aria-disabled')).toBe('true')
    expect(wrapper.get('.hc-select__label').text()).toBe(label)
  })

  it('Provider 卡片和模型管理器只维护能力，不创建第二个偏好入口', () => {
    const settingsView = readFileSync(resolve(__dirname, '../../../views/SettingsView.vue'), 'utf8')
    const modelManager = readFileSync(resolve(__dirname, '../ModelManagerModal.vue'), 'utf8')
    const ollamaCard = readFileSync(resolve(__dirname, '../OllamaCard.vue'), 'utf8')

    expect(settingsView.match(/<ReasoningPolicySelect\b/g)).toHaveLength(1)
    expect(modelManager).not.toContain('ReasoningPolicySelect')
    expect(modelManager).not.toContain('defaultReasoningPolicy')
    expect(modelManager).not.toContain('reasoning_policy')
    expect(ollamaCard).not.toContain('ReasoningPolicySelect')
    expect(ollamaCard).not.toContain('defaultReasoningPolicy')
    expect(ollamaCard).not.toContain('reasoning_policy')
  })

  it('设置默认策略沿用原型 240×37 的紧凑选择器盒模型', () => {
    const settingsView = readFileSync(resolve(__dirname, '../../../views/SettingsView.vue'), 'utf8')

    expect(settingsView).toMatch(
      /\.hc-settings__select\s*:deep\(\.hc-select__trigger\)\s*\{[^}]*height:\s*37px;[^}]*padding:\s*7px\s+11px;[^}]*font-size:\s*14px;[^}]*gap:\s*10px;/s,
    )
  })
})
