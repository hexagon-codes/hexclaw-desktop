import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { describe, expect, it } from 'vitest'
import ChatToolbar from '../ChatToolbar.vue'
import zhCN from '@/i18n/locales/zh-CN'

type WorkspaceMode = 'sessions' | 'artifacts' | 'context' | 'focus'

function mountToolbar() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const i18n = createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': zhCN },
  })

  const wrapper = mount(ChatToolbar, {
    props: {
      workspaceMode: 'sessions' as WorkspaceMode,
      'onUpdate:workspaceMode': (value: WorkspaceMode) =>
        wrapper.setProps({ workspaceMode: value }),
      messageCount: 0,
      tokenBadge: '≈ 0 tokens',
    },
    global: { plugins: [pinia, i18n] },
  })
  return wrapper
}

describe('ChatToolbar workspace rail state machine', () => {
  it('keeps exact sessions | artifacts | context | focus modes mutually exclusive', async () => {
    const wrapper = mountToolbar()
    const [sessionsButton, artifactsButton, contextButton] = wrapper.findAll('button')

    function expectMode(mode: WorkspaceMode) {
      expect((wrapper.props() as { workspaceMode: WorkspaceMode }).workspaceMode).toBe(mode)
      expect(sessionsButton!.classes('hc-chat__toolbar-btn--active')).toBe(mode === 'sessions')
      expect(artifactsButton!.classes('hc-chat__toolbar-btn--active')).toBe(mode === 'artifacts')
      expect(contextButton!.classes('hc-chat__toolbar-btn--active')).toBe(mode === 'context')
    }

    expectMode('sessions')

    // Every active workspace entry collapses to the exact focus state.
    await sessionsButton!.trigger('click')
    expectMode('focus')

    await sessionsButton!.trigger('click')
    expectMode('sessions')

    await wrapper.setProps({ workspaceMode: 'context' })
    expectMode('context')
    await artifactsButton!.trigger('click')
    expectMode('artifacts')

    await artifactsButton!.trigger('click')
    expectMode('focus')

    await artifactsButton!.trigger('click')
    expectMode('artifacts')

    await contextButton!.trigger('click')
    expectMode('context')

    await contextButton!.trigger('click')
    expectMode('focus')

    await sessionsButton!.trigger('click')
    expectMode('sessions')
  })
})
