/**
 * TemplatePopup 扣子式技能子菜单（P0.2）：
 *  - scope=skills 时底部出现三入口，点击 emit skillAction
 *  - 每个 skill 用 SkillIcon 渲染（非统一扳手）
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import TemplatePopup from '../TemplatePopup.vue'

function mountPopup(scope: 'all' | 'skills' | 'prompts') {
  return mount(TemplatePopup, {
    props: {
      visible: true,
      query: '',
      position: { bottom: 0, left: 0 },
      scope,
      skills: [
        { name: 'stocks', display_name: '股票', description: 'A股数据', author: 'x', version: '1', triggers: [], tags: ['finance'], icon: '📊' },
        { name: 'writer', description: '写作', author: 'x', version: '1', triggers: [], tags: ['writing'] },
      ],
    },
    global: {
      plugins: [createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages: { 'zh-CN': zhCN, zh: zhCN } })],
      stubs: { teleport: true },
    },
  })
}

describe('TemplatePopup 扣子式技能子菜单', () => {
  it('scope=skills 底部三入口存在并 emit 对应 action', async () => {
    const w = mountPopup('skills')
    const actions = w.findAll('.tpl-popup__action')
    expect(actions.length).toBe(3)

    await actions[0]!.trigger('click')
    await actions[1]!.trigger('click')
    await actions[2]!.trigger('click')
    const ev = w.emitted('skillAction') as unknown[][]
    expect(ev.map((e) => e[0])).toEqual(['ai-create', 'upload-local', 'add-market'])
  })

  it('emoji icon 的 skill 渲染为 emoji（视觉锚点，非统一图标）', () => {
    const w = mountPopup('skills')
    expect(w.find('.skill-icon--emoji').exists()).toBe(true)
    expect(w.text()).toContain('📊')
  })

  it('scope=prompts 不显示技能底部入口', () => {
    const w = mountPopup('prompts')
    expect(w.findAll('.tpl-popup__action').length).toBe(0)
  })
})
