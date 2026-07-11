/**
 * R6 [AP-027] SearchInput.vue 无 IME 守卫
 *
 * src/components/common/SearchInput.vue:38 曾为 `@keydown.enter="emit('submit')"`——
 * 中文/维语等输入法拼字回车「选词」时（event.isComposing=true，部分环境 keyCode=229）
 * 会误触发 submit，把半成品拼音当搜索词提交。
 *
 * RED（修复前）：isComposing=true 的回车仍 emit('submit') → 断言「不 emit」失败。
 * GREEN（修复后）：isComposing=true 不 emit；isComposing=false 正常 emit。
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import SearchInput from '../SearchInput.vue'

function i18n() {
  return createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages: { 'zh-CN': zhCN, zh: zhCN } })
}

function mountInput() {
  return mount(SearchInput, {
    props: { modelValue: '拼音中' },
    global: { plugins: [i18n()], stubs: { Search: true, X: true } },
  })
}

describe('R6 · SearchInput 回车 IME 守卫', () => {
  it('输入法组字中回车（isComposing=true）不触发 submit', async () => {
    const w = mountInput()
    await w.find('input').trigger('keydown.enter', { isComposing: true })
    expect(w.emitted('submit'), 'IME 组字回车不应 submit').toBeUndefined()
  })

  it('keyCode=229（部分环境的 IME 组字标志）回车也不触发 submit', async () => {
    const w = mountInput()
    // keyCode 是只读属性，trigger 的 options 无法注入，改为构造原生事件后 dispatch
    const evt = new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true } as KeyboardEventInit)
    w.find('input').element.dispatchEvent(evt)
    await w.vm.$nextTick()
    expect(w.emitted('submit'), 'keyCode=229 回车不应 submit').toBeUndefined()
  })

  it('正常回车（非组字）触发 submit', async () => {
    const w = mountInput()
    await w.find('input').trigger('keydown.enter', { isComposing: false })
    expect(w.emitted('submit'), '正常回车应 submit').toHaveLength(1)
  })
})
