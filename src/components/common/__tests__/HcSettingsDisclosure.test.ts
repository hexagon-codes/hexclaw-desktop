import { defineComponent, nextTick, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import HcSettingsDisclosure from '../HcSettingsDisclosure.vue'

const Host = defineComponent({
  components: { HcSettingsDisclosure },
  setup() {
    const open = ref(false)
    return { open }
  },
  template: `
    <HcSettingsDisclosure
      v-model="open"
      body-id="shared-settings-body"
      trigger-test-id="shared-settings-toggle"
      panel-test-id="shared-settings-panel"
    >
      <template #icon><span data-testid="shared-settings-icon">I</span></template>
      <template #title>统一设置标题</template>
      <template #summary>真实状态摘要</template>
      <template #actions>
        <button type="button" data-testid="shared-settings-action">恢复默认</button>
      </template>
      <div data-testid="shared-settings-content">设置内容</div>
    </HcSettingsDisclosure>
  `,
})

describe('HcSettingsDisclosure', () => {
  it('keeps the panel mounted and synchronizes click, chevron and ARIA state', async () => {
    const wrapper = mount(Host)
    const trigger = wrapper.get('[data-testid="shared-settings-toggle"]')
    const panel = wrapper.get('[data-testid="shared-settings-panel"]')

    expect(wrapper.find('.hc-settings-disclosure').exists()).toBe(true)
    expect(trigger.attributes('aria-controls')).toBe('shared-settings-body')
    expect(trigger.attributes('aria-expanded')).toBe('false')
    expect(panel.attributes('style')).toContain('display: none')
    expect(wrapper.find('[data-testid="shared-settings-content"]').exists()).toBe(true)
    expect(wrapper.get('.hc-settings-disclosure__chevron').classes()).not.toContain(
      'hc-settings-disclosure__chevron--open',
    )

    await trigger.trigger('click')
    await nextTick()
    expect(trigger.attributes('aria-expanded')).toBe('true')
    expect(panel.attributes('style') ?? '').not.toContain('display: none')
    expect(wrapper.get('.hc-settings-disclosure__chevron').classes()).toContain(
      'hc-settings-disclosure__chevron--open',
    )

    await trigger.trigger('click')
    expect(trigger.attributes('aria-expanded')).toBe('false')
    expect(panel.attributes('style')).toContain('display: none')
  })

  it('does not toggle when an auxiliary action is used', async () => {
    const wrapper = mount(Host)
    await wrapper.get('[data-testid="shared-settings-action"]').trigger('click')
    expect(wrapper.get('[data-testid="shared-settings-toggle"]').attributes('aria-expanded')).toBe(
      'false',
    )
  })
})
