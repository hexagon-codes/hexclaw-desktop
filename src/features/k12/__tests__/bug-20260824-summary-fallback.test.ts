import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import K12PracticeSetsPanel from '../views/K12PracticeSetsPanel.vue'

const h = vi.hoisted(() => ({
  listPracticeSets: vi.fn(),
}))

vi.mock('@/api/k12', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/k12')>()),
  k12ListPracticeSets: (...args: unknown[]) => h.listPracticeSets(...args),
}))

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}))

vi.mock('../export', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../export')>()),
  printPracticePaper: vi.fn(),
  savePracticePaperPdf: vi.fn(),
}))

function i18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh } },
  })
}

describe('K12PracticeSetsPanel · 摘要缺失保护', () => {
  it('pending 投影缺少摘要时不向界面暴露内部错题 ID', async () => {
    h.listPracticeSets.mockResolvedValue({ items: [] })
    const internalID = 'mistake-internal-7f5d8f88'
    const wrapper = mount(K12PracticeSetsPanel, {
      props: {
        agentId: 'k12-xiaoming',
        practiceGenerationByMistake: {
          [internalID]: {
            state: 'pending',
            source_mistake_id: internalID,
            source_mistake_summary: ' \n ',
          },
        },
      },
      global: { plugins: [i18n()] },
    })
    await flushPromises()

    const placeholder = wrapper.get('[data-testid="practice-generation-placeholder"]')
    expect(placeholder.text()).not.toContain(internalID)
    expect(placeholder.find('.k12ps__qmeta').exists()).toBe(false)
    wrapper.unmount()
  })

  it('pending 投影只显示去除首尾空白后的来源摘要', async () => {
    h.listPracticeSets.mockResolvedValue({ items: [] })
    const wrapper = mount(K12PracticeSetsPanel, {
      props: {
        agentId: 'k12-xiaoming',
        practiceGenerationByMistake: {
          'mistake-1': {
            state: 'pending',
            source_mistake_id: 'mistake-1',
            source_mistake_summary: '  苹果和梨的价钱  ',
          },
        },
      },
      global: { plugins: [i18n()] },
    })
    await flushPromises()

    expect(wrapper.get('.k12ps__qmeta').text()).toBe('来源错题：苹果和梨的价钱')
    wrapper.unmount()
  })
})
