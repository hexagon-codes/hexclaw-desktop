import { mount } from '@vue/test-utils'
import { describe, it, expect, afterEach } from 'vitest'
import HcSelect from '../HcSelect.vue'

/**
 * HcSelect 选项图标（feature-20260704：编辑智能体弹窗「模型服务商」下拉加服务商 logo，对齐设置页）。
 * 需求：option 可带 icon（图片 src）；触发器显示选中项图标，展开项逐条显示图标；无 icon 向后兼容纯文字。
 */
describe('HcSelect 选项图标（feature-20260704 服务商 logo 对齐设置页）', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('选项带 icon：触发器显示选中项图标，展开项逐条渲染图标（占位项无 icon 不渲染）', async () => {
    const wrapper = mount(HcSelect, {
      props: {
        modelValue: 'ollama',
        options: [
          { value: '', label: '使用全局默认' },
          { value: 'ollama', label: 'Ollama (本地)', icon: '/logo-ollama.svg' },
          { value: 'or', label: 'Openrouter', icon: '/logo-or.svg' },
        ],
      },
      attachTo: document.body,
    })

    // 触发器渲染选中项(ollama)的图标
    const trigIcon = wrapper.find('.hc-select__trigger img.hc-select__icon')
    expect(trigIcon.exists()).toBe(true)
    expect(trigIcon.attributes('src')).toBe('/logo-ollama.svg')

    // 打开下拉（Teleport 到 body）
    await wrapper.find('.hc-select__trigger').trigger('click')
    // 带 icon 的两个选项渲染 img；'' 占位项不渲染
    const optionImgs = document.querySelectorAll('.hc-select__option img.hc-select__icon')
    expect(optionImgs.length).toBe(2)

    wrapper.unmount()
  })

  it('选项无 icon：向后兼容纯文字，不渲染任何 img', async () => {
    const wrapper = mount(HcSelect, {
      props: {
        modelValue: 'a',
        options: [
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
        ],
      },
      attachTo: document.body,
    })
    expect(wrapper.find('.hc-select__trigger img').exists()).toBe(false)
    await wrapper.find('.hc-select__trigger').trigger('click')
    expect(document.querySelectorAll('.hc-select__option img').length).toBe(0)
    wrapper.unmount()
  })
})
