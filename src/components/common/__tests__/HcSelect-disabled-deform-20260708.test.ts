import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import HcSelect from '../HcSelect.vue'

/**
 * BUG-20260708：默认模型下拉在「无可用模型」禁用态下，在 macOS WKWebView（Tauri 生产壳）里
 * 渲染成变形的高圆胶囊——与同页启用态下拉（智能路由/Agent 模式）盒型不一致。
 *
 * 根因：禁用态用了原生 `<button disabled>`，WKWebView 对 disabled 按钮施加 UA 外观，
 * 覆盖了 `-webkit-appearance:none`（Chromium/jsdom 正常，WKWebView 变形——引擎特异回归，
 * 见 hex-test webkit-feel 门）。
 *
 * 修复：禁用视觉 100% 收归自有 CSS——用 `aria-disabled` + `.hc-select__trigger--disabled` class，
 * 不再挂原生 `disabled` 属性（交互仍被 openDropdown 的 props.disabled 守卫拦住）。
 *
 * 本测试锁根因机制（jsdom 无 WKWebView 布局，测不了像素，故锁"不挂原生 disabled 属性"这个致因）。
 */
describe('BUG-20260708 HcSelect 禁用态不得挂原生 disabled 属性（防 WKWebView 变形）', () => {
  const baseOptions = [{ value: '', label: '无可用模型' }]

  it('disabled 时 trigger 不挂原生 disabled 属性，改用 aria-disabled + 自有 class', () => {
    const w = mount(HcSelect, { props: { modelValue: '', options: baseOptions, disabled: true } })
    const trigger = w.get('button.hc-select__trigger')
    // 根因：原生 disabled 属性触发 WKWebView UA 变形 —— 修复后不得存在
    expect(trigger.attributes('disabled')).toBeUndefined()
    // 语义与视觉走自有通道
    expect(trigger.attributes('aria-disabled')).toBe('true')
    expect(trigger.classes()).toContain('hc-select__trigger--disabled')
  })

  it('enabled 时不带 disabled 语义/class（回归对照，与启用态下拉同盒）', () => {
    const w = mount(HcSelect, {
      props: { modelValue: 'a', options: [{ value: 'a', label: 'A' }], disabled: false },
    })
    const trigger = w.get('button.hc-select__trigger')
    expect(trigger.attributes('disabled')).toBeUndefined()
    expect(trigger.attributes('aria-disabled')).toBeUndefined()
    expect(trigger.classes()).not.toContain('hc-select__trigger--disabled')
  })

  it('disabled 时点击不展开下拉（交互守卫仍在）', async () => {
    const w = mount(HcSelect, { props: { modelValue: '', options: baseOptions, disabled: true } })
    await w.get('button.hc-select__trigger').trigger('click')
    expect(w.find('.hc-select__dropdown').exists()).toBe(false)
  })
})
