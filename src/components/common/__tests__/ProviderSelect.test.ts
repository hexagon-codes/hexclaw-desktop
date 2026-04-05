import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { getProviderTypes } from '@/config/providers'
import type { ProviderType } from '@/types'

// ─── Mock lucide icons ──────────────────────────────
vi.mock('lucide-vue-next', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const stub = { template: '<span />' }
  const mocked: Record<string, unknown> = {}
  for (const key of Object.keys(original)) {
    mocked[key] = stub
  }
  return mocked
})

async function mountSelect(modelValue: ProviderType = 'openai') {
  const ProviderSelect = (await import('../ProviderSelect.vue')).default
  return mount(ProviderSelect, {
    props: { modelValue },
    global: {
      stubs: { Teleport: true },
    },
  })
}

const ALL_PRESETS = getProviderTypes()

describe('ProviderSelect — 供应商下拉选择器', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ─── 1. 渲染 ──────────────────────────────────────

  it('显示当前选中的供应商名称', async () => {
    const wrapper = await mountSelect('anthropic')
    expect(wrapper.text()).toContain('Anthropic')
  })

  it('显示当前选中供应商的 logo', async () => {
    const wrapper = await mountSelect('deepseek')
    const logo = wrapper.find('.hc-provider-select__logo')
    expect(logo.exists()).toBe(true)
    expect(logo.attributes('alt')).toBe('DeepSeek')
  })

  it('初始状态下拉列表关闭', async () => {
    const wrapper = await mountSelect()
    expect(wrapper.find('.hc-provider-select__dropdown').exists()).toBe(false)
  })

  // ─── 2. 打开/关闭 ─────────────────────────────────

  it('点击 trigger 打开下拉列表', async () => {
    const wrapper = await mountSelect()
    await wrapper.find('.hc-provider-select__trigger').trigger('click')
    expect(wrapper.find('.hc-provider-select__dropdown').exists()).toBe(true)
  })

  it('再次点击 trigger 关闭下拉列表', async () => {
    const wrapper = await mountSelect()
    const trigger = wrapper.find('.hc-provider-select__trigger')
    await trigger.trigger('click')
    expect(wrapper.find('.hc-provider-select__dropdown').exists()).toBe(true)
    await trigger.trigger('click')
    expect(wrapper.find('.hc-provider-select__dropdown').exists()).toBe(false)
  })

  // ─── 3. 选项完整性 ────────────────────────────────

  it('下拉列表包含所有供应商', async () => {
    const wrapper = await mountSelect()
    await wrapper.find('.hc-provider-select__trigger').trigger('click')

    const options = wrapper.findAll('.hc-provider-select__option')
    expect(options.length).toBe(ALL_PRESETS.length)
  })

  it('不包含 Ollama（由 OllamaCard 统一管理）', async () => {
    const wrapper = await mountSelect()
    await wrapper.find('.hc-provider-select__trigger').trigger('click')

    const texts = wrapper.findAll('.hc-provider-select__option').map((o) => o.text())
    expect(texts).not.toContain('Ollama (本地)')
  })

  it('包含所有新增的国内供应商', async () => {
    const wrapper = await mountSelect()
    await wrapper.find('.hc-provider-select__trigger').trigger('click')

    const texts = wrapper.findAll('.hc-provider-select__option').map((o) => o.text())
    expect(texts).toContain('智谱 AI')
    expect(texts).toContain('Kimi (月之暗面)')
    expect(texts).toContain('文心一言 (百度)')
    expect(texts).toContain('腾讯混元')
    expect(texts).toContain('讯飞星火')
    expect(texts).toContain('MiniMax')
  })

  // ─── 4. 选择交互 ──────────────────────────────────

  it('点击选项发出 update:modelValue 事件', async () => {
    const wrapper = await mountSelect('openai')
    await wrapper.find('.hc-provider-select__trigger').trigger('click')

    const deepseekOption = wrapper
      .findAll('.hc-provider-select__option')
      .find((o) => o.text() === 'DeepSeek')!
    await deepseekOption.trigger('mousedown')

    expect(wrapper.emitted('update:modelValue')).toEqual([['deepseek']])
  })

  it('选择后关闭下拉列表', async () => {
    const wrapper = await mountSelect()
    await wrapper.find('.hc-provider-select__trigger').trigger('click')
    expect(wrapper.find('.hc-provider-select__dropdown').exists()).toBe(true)

    const firstOption = wrapper.findAll('.hc-provider-select__option')[1]!
    await firstOption.trigger('mousedown')
    expect(wrapper.find('.hc-provider-select__dropdown').exists()).toBe(false)
  })

  // ─── 5. 当前选中高亮 ──────────────────────────────

  it('当前选中项标记 --active class', async () => {
    const wrapper = await mountSelect('gemini')
    await wrapper.find('.hc-provider-select__trigger').trigger('click')

    const activeOptions = wrapper.findAll('.hc-provider-select__option--active')
    expect(activeOptions.length).toBe(1)
    expect(activeOptions[0]!.text()).toContain('Google Gemini')
  })

  // ─── 6. 键盘导航 ──────────────────────────────────

  it('ArrowDown 打开下拉并高亮第一项', async () => {
    const wrapper = await mountSelect('openai')
    const trigger = wrapper.find('.hc-provider-select__trigger')

    await trigger.trigger('keydown', { key: 'ArrowDown' })
    expect(wrapper.find('.hc-provider-select__dropdown').exists()).toBe(true)
    expect(wrapper.find('.hc-provider-select__option--highlighted').exists()).toBe(true)
  })

  it('ArrowDown 在列表中向下移动高亮', async () => {
    const wrapper = await mountSelect('openai')
    const trigger = wrapper.find('.hc-provider-select__trigger')

    // 打开
    await trigger.trigger('keydown', { key: 'ArrowDown' })
    // 再次按 down
    await trigger.trigger('keydown', { key: 'ArrowDown' })

    const highlighted = wrapper.findAll('.hc-provider-select__option--highlighted')
    expect(highlighted.length).toBe(1)
    // 应该是第二个选项（index 1）
    const allOptions = wrapper.findAll('.hc-provider-select__option')
    expect(allOptions[1]!.classes()).toContain('hc-provider-select__option--highlighted')
  })

  it('ArrowUp 在列表中向上移动高亮', async () => {
    const wrapper = await mountSelect('openai')
    const trigger = wrapper.find('.hc-provider-select__trigger')

    await trigger.trigger('keydown', { key: 'ArrowDown' })
    await trigger.trigger('keydown', { key: 'ArrowDown' })
    await trigger.trigger('keydown', { key: 'ArrowUp' })

    const allOptions = wrapper.findAll('.hc-provider-select__option')
    // 回到第一项
    expect(allOptions[0]!.classes()).toContain('hc-provider-select__option--highlighted')
  })

  it('Enter 选择高亮项并关闭', async () => {
    const wrapper = await mountSelect('openai')
    const trigger = wrapper.find('.hc-provider-select__trigger')

    await trigger.trigger('keydown', { key: 'ArrowDown' })
    await trigger.trigger('keydown', { key: 'ArrowDown' }) // 移到第二项
    await trigger.trigger('keydown', { key: 'Enter' })

    expect(wrapper.emitted('update:modelValue')).toBeTruthy()
    expect(wrapper.find('.hc-provider-select__dropdown').exists()).toBe(false)
  })

  it('Escape 关闭下拉不选择', async () => {
    const wrapper = await mountSelect('openai')
    const trigger = wrapper.find('.hc-provider-select__trigger')

    await trigger.trigger('keydown', { key: 'ArrowDown' })
    expect(wrapper.find('.hc-provider-select__dropdown').exists()).toBe(true)

    await trigger.trigger('keydown', { key: 'Escape' })
    expect(wrapper.find('.hc-provider-select__dropdown').exists()).toBe(false)
    expect(wrapper.emitted('update:modelValue')).toBeFalsy()
  })

  it('Space 在关闭时打开下拉', async () => {
    const wrapper = await mountSelect()
    const trigger = wrapper.find('.hc-provider-select__trigger')

    await trigger.trigger('keydown', { key: ' ' })
    expect(wrapper.find('.hc-provider-select__dropdown').exists()).toBe(true)
  })

  // ─── 7. ARIA 属性 ─────────────────────────────────

  it('trigger 有正确的 ARIA 属性', async () => {
    const wrapper = await mountSelect()
    const trigger = wrapper.find('.hc-provider-select__trigger')

    expect(trigger.attributes('role')).toBe('combobox')
    expect(trigger.attributes('aria-expanded')).toBe('false')
    expect(trigger.attributes('aria-haspopup')).toBe('listbox')
  })

  it('打开时 aria-expanded 为 true', async () => {
    const wrapper = await mountSelect()
    const trigger = wrapper.find('.hc-provider-select__trigger')
    await trigger.trigger('click')

    expect(trigger.attributes('aria-expanded')).toBe('true')
  })

  it('下拉列表有 role=listbox', async () => {
    const wrapper = await mountSelect()
    await wrapper.find('.hc-provider-select__trigger').trigger('click')

    expect(wrapper.find('.hc-provider-select__dropdown').attributes('role')).toBe('listbox')
  })

  it('选项有 role=option 和 aria-selected', async () => {
    const wrapper = await mountSelect('openai')
    await wrapper.find('.hc-provider-select__trigger').trigger('click')

    const options = wrapper.findAll('.hc-provider-select__option')
    expect(options[0]!.attributes('role')).toBe('option')
    expect(options[0]!.attributes('aria-selected')).toBe('true')
    expect(options[1]!.attributes('aria-selected')).toBe('false')
  })

  // ─── 8. 每个 option 都有 logo ─────────────────────

  it('每个下拉选项都显示对应 logo', async () => {
    const wrapper = await mountSelect()
    await wrapper.find('.hc-provider-select__trigger').trigger('click')

    const logos = wrapper.findAll('.hc-provider-select__option-logo')
    expect(logos.length).toBe(ALL_PRESETS.length)
    logos.forEach((logo) => {
      expect(logo.attributes('src')).toBeTruthy()
    })
  })

  // ─── 9. mouseenter 同步高亮 ────────────────────────

  it('鼠标移入选项同步高亮', async () => {
    const wrapper = await mountSelect()
    await wrapper.find('.hc-provider-select__trigger').trigger('click')

    const thirdOption = wrapper.findAll('.hc-provider-select__option')[2]!
    await thirdOption.trigger('mouseenter')

    expect(thirdOption.classes()).toContain('hc-provider-select__option--highlighted')
  })
})
